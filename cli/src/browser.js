import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { join } from 'path';
import { mkdirSync, existsSync, readdirSync, openSync } from 'fs';
import { spawn } from 'child_process';
import http from 'http';
import { homedir } from 'os';
import { BASE_DIR } from './paths.js';

chromium.use(StealthPlugin());

const DEFAULT_ACCOUNT = 'default';

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-infobars',
  // CI / Linux root / 部分 Windows 受限沙箱下 Chromium 不关沙箱会直接起不来
  '--no-sandbox',
];

// 账号名白名单，避免 --account 携带路径分隔符穿越出 BASE_DIR
const ACCOUNT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 各平台 Chromium 在 playwright 缓存目录里的相对可执行文件位置
const CHROME_RELATIVE = {
  win32: [join('chrome-win64', 'chrome.exe'), join('chrome-win', 'chrome.exe')],
  darwin: [join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')],
  linux: [join('chrome-linux', 'chrome')],
};

/**
 * 列出候选的 playwright 浏览器缓存根目录。
 * 优先用环境变量，其次扫各平台默认位置（含用户把缓存迁出 C 盘的常见路径）。
 */
function chromiumRoots() {
  const roots = [];
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envPath) roots.push(envPath);
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'ms-playwright'));
    roots.push('D:/msPlaywright');
  } else if (process.platform === 'darwin') {
    roots.push(join(homedir(), 'Library', 'Caches', 'ms-playwright'));
  } else {
    roots.push(join(homedir(), '.cache', 'ms-playwright'));
  }
  return roots.filter((p) => p && existsSync(p));
}

/**
 * 解析 Chromium 可执行文件路径。
 *
 * 为什么需要：playwright 默认按自己注册表里的路径找浏览器，若用户把缓存目录
 * 迁到别的盘（C 盘空间紧张时的常见做法）或只装了 Chromium 没装 Chrome，
 * launchPersistentContext 会报 "Executable doesn't exist" 起不来。
 * 这里主动找一遍，找到就显式传给 playwright；找不到返回 undefined 交回默认行为。
 *
 * @returns {string|undefined}
 */
export function resolveChromiumExecutablePath() {
  if (process.env.CHROMIUM_EXECUTABLE_PATH && existsSync(process.env.CHROMIUM_EXECUTABLE_PATH)) {
    return process.env.CHROMIUM_EXECUTABLE_PATH;
  }

  const relatives = CHROME_RELATIVE[process.platform] || CHROME_RELATIVE.linux;

  for (const root of chromiumRoots()) {
    // 先按 chromium-<build> 目录倒序（新版优先）逐个试
    try {
      const dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('chromium-'))
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const dir of dirs) {
        for (const rel of relatives) {
          const candidate = join(root, dir, rel);
          if (existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }
  return undefined;
}

/**
 * 轮询 CDP 的 /json/version，直到调试端口就绪。
 */
function waitForCdpEndpoint(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const info = JSON.parse(body);
            if (info && info.webSocketDebuggerUrl) return resolve(info);
          } catch {}
          retry();
        });
      });
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`CDP 端口 ${port} 启动超时`));
      } else {
        setTimeout(poll, 250);
      }
    };
    poll();
  });
}

/**
 * 回退启动方式：自己 spawn Chromium 开调试端口，再用 connectOverCDP 接管。
 *
 * 为什么需要：playwright 正常启动走 stdio 命名管道与子进程通信，在受限沙箱
 * （Linux 容器、部分 Windows 安全策略）下建管道会抛 EPERM，浏览器起不来。
 * 改成 stdio:ignore + 调试端口，绕开管道，功能等价。
 *
 * @returns {Promise<BrowserContext>} context 上挂了 _cdpChild/_cdpBrowser 供关闭时清理
 */
async function launchViaCdpFallback(userDataDir, executablePath, headless) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const logFile = join(userDataDir, '..', 'chromium-cdp.log');
  const logFd = openSync(logFile, 'a');
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    '--lang=zh-CN',
    ...LAUNCH_ARGS,
    ...(headless ? ['--headless=new'] : []),
    'about:blank',
  ];
  const child = spawn(executablePath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: headless,
  });
  child.unref();

  await waitForCdpEndpoint(port, 15000);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0] || (await browser.newContext({ viewport: DEFAULT_VIEWPORT }));
  context._cdpChild = child;
  context._cdpBrowser = browser;
  return context;
}

/**
 * 获取指定账号的数据目录路径。
 * 账号名做了白名单校验，非法名称直接抛错（不再拼进路径）。
 */
export function getAccountDir(account) {
  const name = account || DEFAULT_ACCOUNT;
  if (!ACCOUNT_NAME_RE.test(name)) {
    throw new Error(`账号名不合法：${name}（仅允许字母、数字、下划线、连字符，长度 1-64）`);
  }
  return join(BASE_DIR, 'accounts', name);
}

/**
 * 获取指定账号的浏览器数据目录。
 */
export function getBrowserDataDir(account) {
  return join(getAccountDir(account), 'browser-data');
}

/**
 * 获取指定账号的截图目录。
 */
export function getScreenshotDir(account) {
  return join(getAccountDir(account), 'screenshots');
}

/**
 * 启动持久化浏览器上下文。
 * 会话数据按账号隔离，保存在 ~/.toutiao-ops/accounts/<name>/browser-data/。
 *
 * @param {object} opts
 * @param {string} [opts.account="default"]
 * @param {boolean} [opts.headless=false]
 * @returns {{ context: BrowserContext, page: Page }}
 */
export async function launchBrowser(opts = {}) {
  const userDataDir = getBrowserDataDir(opts.account);
  mkdirSync(userDataDir, { recursive: true });

  const headless = Boolean(opts.headless);
  const executablePath = resolveChromiumExecutablePath();

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      // 解析到自定义位置的浏览器就显式传入；undefined 时交回 playwright 默认逻辑
      executablePath,
      headless,
      viewport: DEFAULT_VIEWPORT,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args: LAUNCH_ARGS,
      ignoreDefaultArgs: ['--enable-automation'],
      permissions: [],
      geolocation: undefined,
    });
  } catch (err) {
    // 受限沙箱下建命名管道会抛 EPERM，改用调试端口接管
    if (executablePath && (err?.code === 'EPERM' || String(err?.message || '').includes('EPERM'))) {
      context = await launchViaCdpFallback(userDataDir, executablePath, headless);
    } else {
      throw err;
    }
  }

  // 位置/通知等权限已在 launchPersistentContext 用 permissions: [] 关闭，
  // 无需再调用 grantPermissions（实测其第 2 参数在本版 Playwright 是 origin 字符串，
  // 传 { origin } 对象会抛 TypeError: Invalid URL，被 catch 静默吞掉，属无效调用）。
  // 如需显式清空，应使用 context.clearPermissions()。

  const page = context.pages()[0] || await context.newPage();
  return { context, page };
}

/**
 * 安全关闭浏览器上下文。
 * CDP 回退启动的浏览器是我们自己 spawn 的进程，关 context 不会带走它，需一并清理。
 */
export async function closeBrowser(context) {
  if (!context) return;
  const child = context._cdpChild;
  const browser = context._cdpBrowser;
  try {
    await context.close();
  } catch {}
  if (browser) {
    try { await browser.close(); } catch {}
  }
  if (child && child.pid) {
    try { process.kill(child.pid); } catch {}
  }
}

/**
 * 随机延迟，模拟人类操作节奏
 */
export function sleep(min = 200, max = 800) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 模拟人类打字：逐字输入并带随机间隔
 */
export async function humanType(page, selector, text) {
  await page.click(selector);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: 50 + Math.random() * 120 });
  }
}

/**
 * 等待页面网络基本空闲后再操作
 */
export async function waitForStable(page, timeout = 10000) {
  await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
}

/**
 * 关闭页面上所有弹窗、模态框、横幅、权限提示等遮挡物。
 * 头条后台常见遮挡：活动弹窗、位置权限弹窗、新手引导、首发激励等。
 * 在任何需要点击页面元素之前调用。
 */
export async function dismissOverlays(page) {
  // 注意：不要在这里 page.context().on('page', ...) 注册监听器。
  // 该方法一次运行会被调用多次（发布 3 次、verify 2 次等），每次都会追加一个
  // 永不移除的空监听器，累积后触发 MaxListenersExceededWarning 并造成无谓开销。
  // 位置权限已在 launchBrowser 里通过 permissions: [] 关闭，无需在此重复处理。

  for (let round = 0; round < 3; round++) {
    await sleep(500, 800);

    // 在 DOM 里关闭各种弹窗
    const closed = await page.evaluate(() => {
      let count = 0;

      // 通用关闭按钮（模态框右上角 X）
      const closeSelectors = [
        '.byte-modal-wrapper .byte-modal-close',
        '.byte-modal-wrapper [class*="close"]',
        '[class*="modal"] [class*="close"]',
        '[class*="dialog"] [class*="close"]',
        '[class*="popup"] [class*="close"]',
        '[role="dialog"] [class*="close"]',
        '[class*="banner"] [class*="close"]',
        '[class*="toast"] [class*="close"]',
        '[class*="guide"] [class*="close"]',
        '[class*="tip"] [class*="close"]',
      ];
      for (const sel of closeSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          try { if (typeof el.click === 'function') el.click(); count++; } catch {}
        });
      }

      // "我知道了"、"已知悉"、"关闭"、"一律不允许" 等确认/关闭按钮
      const dismissTexts = ['我知道了', '已知悉', '知道了', '关闭', '一律不允许', '不再提示', '稍后再说', '取消', '跳过'];
      const allButtons = document.querySelectorAll('button, [role="button"], a, span, div');
      for (const btn of allButtons) {
        const text = btn.textContent?.trim();
        if (text && dismissTexts.some(t => text === t || text.startsWith(t))) {
          try {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.width < 400) {
              btn.click();
              count++;
            }
          } catch {}
        }
      }

      // 隐藏所有 modal wrapper 和 drawer
      document.querySelectorAll('.byte-modal-wrapper, [class*="zoomModal"], [class*="modal-mask"], .byte-drawer-wrapper, [class*="drawer-mask"]').forEach(el => {
        el.style.display = 'none';
        count++;
      });

      // 隐藏 banner 遮挡
      document.querySelectorAll('[class*="banner-image"], [class*="banner-wrap"], [class*="banner-container"]').forEach(el => {
        el.style.display = 'none';
        count++;
      });

      return count;
    });

    if (closed === 0) break;
  }

  // 再按一次 Escape 兜底
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(300, 500);
}

/**
 * 在浏览器上下文内发起 fetch 请求（自动携带 Cookie/Referer）
 */
export async function browserFetch(page, url, fetchOpts = {}) {
  return page.evaluate(async ({ url, opts }) => {
    const res = await fetch(url, {
      credentials: 'include',
      ...opts,
    });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('json')) {
      return { ok: res.ok, status: res.status, data: await res.json() };
    }
    return { ok: res.ok, status: res.status, data: await res.text() };
  }, { url, opts: fetchOpts });
}
