/**
 * 一次性：抓取任意页面的图片地址与话题文本，落盘 JSON（只读）。
 * 用法：在 cli/ 目录执行 node tools/check-share.mjs <url> <输出文件> [--account <账号名>]
 *
 * 说明：统一走 src/browser.js 的 launchBrowser —— 复用 stealth 指纹插件与账号名白名单校验，
 *       不再自行拼接 ~/.toutiao-ops/accounts/default/browser-data（那样会绕过账号体系，
 *       且账号名非 default 时会静默打开空 profile）。
 */
import { launchBrowser, closeBrowser } from '../src/browser.js';
import fs from 'fs';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--account') {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      console.error('选项 --account 缺少取值');
      process.exit(1);
    }
    flags.account = next;
    i++;
  } else if (a.startsWith('--')) {
    console.error(`未知选项：${a}`);
    process.exit(1);
  } else {
    positional.push(a);
  }
}

const [url, out] = positional;
if (!url || !out) {
  console.error('用法: node tools/check-share.mjs <url> <输出文件> [--account <账号名>]');
  process.exit(1);
}

const { context, page } = await launchBrowser({ account: flags.account, headless: true });
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img')).map(i => ({ src: (i.src || '').slice(0, 120), alt: i.alt || '' })).filter(i => i.src.includes('toutiaoimg') || i.src.includes('tos-cn'));
    const text = document.body.innerText;
    const topic = (text.match(/#[^#\n]{2,30}#/g) || []);
    return { imgs, topic, textLen: text.length, head: text.slice(0, 200) };
  });
  fs.writeFileSync(out, JSON.stringify(info, null, 2), 'utf8');
  console.log('images:', info.imgs.length);
  info.imgs.forEach((im, i) => console.log(` img${i + 1}:`, im.src.slice(0, 90)));
  console.log('topics:', JSON.stringify(info.topic));
} finally {
  // 无 try/finally 时，goto 超时或写盘失败都不会关闭上下文 —— Chromium 进程残留会锁住 profile
  await closeBrowser(context);
}
