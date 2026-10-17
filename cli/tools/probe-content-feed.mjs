/**
 * 一次性探测：作品管理页到底发了哪些 JSON 接口（用于校准 verify.json 的 feedApiMatch）。
 * 只读，不写入任何数据。
 *
 * 用法：node tools/probe-content-feed.mjs --account <账号名> [--headless]
 */
import { launchBrowser, closeBrowser, sleep, waitForStable, dismissOverlays } from '../src/browser.js';
import { ensureLoggedIn } from '../src/auth-guard.js';
import { drainResponses } from '../src/verify.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'output', 'probe');
const CONTENT_PAGE = 'https://mp.toutiao.com/profile_v4/manage/content/all';

// 布尔开关：只有这些选项不消费下一个 token，避免 --account --headless 把账号吃成 '--headless'
const BOOL_FLAGS = new Set(['headless']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOL_FLAGS.has(key)) { out[key] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`选项 ${a} 缺少取值\n用法：node tools/probe-content-feed.mjs --account <账号名> [--headless]`);
    }
    out[key] = next;
    i++;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  const rep = { schemaVersion: '1.0.0', probe: 'content-feed', account: opts.account, startedAt: new Date().toISOString(), jsonApis: [], errors: [] };

  const { context, page } = await launchBrowser(opts);
  const seen = new Set();
  // response 回调是异步的：计数在途数量，close 前必须归零，否则报告会少记接口
  const inflight = { n: 0 };
  page.on('response', (r) => {
    const url = r.url();
    if (!url.startsWith('http')) return;
    const ct = r.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    const key = r.request().method() + ' ' + url.split('?')[0];
    if (seen.has(key)) return;
    seen.add(key);
    inflight.n++;
    (async () => {
      let probe = null;
      try {
        const j = await r.json();
        const arr = j && Array.isArray(j.data) ? j.data : null;
        probe = {
          topKeys: j && typeof j === 'object' ? Object.keys(j).slice(0, 12) : null,
          dataIsArray: Array.isArray(j && j.data),
          dataLen: arr ? arr.length : null,
          firstItemKeys: arr && arr[0] ? Object.keys(arr[0]).slice(0, 12) : null,
          assembleCell: Boolean(arr && arr[0] && arr[0].assembleCell),
          totalNumber: j && j.total_number != null ? j.total_number : null,
        };
      } catch { /* 非 JSON 体 */ } finally {
        rep.jsonApis.push({ method: r.request().method(), url, status: r.status(), probe });
        inflight.n--;
      }
    })();
  });

  try {
    await ensureLoggedIn(page);
    await page.goto(CONTENT_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => rep.errors.push('goto: ' + e.message));
    await waitForStable(page);
    await sleep(3000, 4500);
    await dismissOverlays(page);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 2500).catch(() => {});
      await sleep(1500, 2000);
    }
    await sleep(2000, 3000);
    // 阶段二：点击筛选 chip 触发列表加载（页面初始显示"暂无作品"时不发列表请求）
    rep.phase1ApiCount = rep.jsonApis.length;
    for (const label of ['已发布', '全部']) {
      const loc = page.locator(`text=${label}`).first();
      await loc.click({ timeout: 4000 }).catch(() => {});
      await sleep(2500, 3500);
      await page.mouse.wheel(0, 2500).catch(() => {});
      await sleep(2000, 3000);
    }

    rep.finalUrl = page.url();
    rep.textLen = await page.evaluate(() => (document.body.innerText || '').length).catch(() => null);
    rep.textHead = await page.evaluate(() => (document.body.innerText || '').slice(0, 600)).catch(() => null);
    rep.domStats = await page.evaluate(() => ({
      itemWraps: document.querySelectorAll('[class*="content-item"], [class*="article-item"], [class*="feed"]').length,
      hasLogin: /登录|扫码/.test(document.body.innerText || ''),
    })).catch(() => null);
  } finally {
    // 等在途响应落定再关：否则报告缺接口，而它正是用来校准 verify.json 的证据
    if (!(await drainResponses(inflight))) rep.errors.push('部分响应未在超时内返回，报告可能不完整');
    await closeBrowser(context);
  }

  rep.phase2Apis = rep.jsonApis.slice(rep.phase1ApiCount || 0);

  const file = join(OUT_DIR, `content-feed_${opts.account || 'default'}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(rep, null, 2));
  console.log(JSON.stringify({
    ok: rep.errors.length === 0,
    file,
    finalUrl: rep.finalUrl,
    textLen: rep.textLen,
    textHead: rep.textHead,
    domStats: rep.domStats,
    jsonApiCount: rep.jsonApis.length,
    apis: rep.jsonApis.map((a) => ({ m: a.method, url: a.url.split('?')[0], status: a.status, dataArr: a.probe && a.probe.dataIsArray, len: a.probe && a.probe.dataLen, assembleCell: a.probe && a.probe.assembleCell })),
    phase2: (rep.phase2Apis || []).map((a) => ({ m: a.method, url: a.url.split('?')[0], dataArr: a.probe && a.probe.dataIsArray, len: a.probe && a.probe.dataLen, assembleCell: a.probe && a.probe.assembleCell })),
    errors: rep.errors,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
