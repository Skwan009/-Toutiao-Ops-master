/**
 * 一次性：抓取任意页面的图片地址与话题文本，落盘 JSON（只读）。
 * 用法：在 cli/ 目录执行 node tools/check-share.mjs <url> <输出文件>
 * 注意：账号目录用 browser-data，与 src/browser.js 保持一致。
 */
import { chromium } from 'playwright';
import { homedir } from 'os';
import { join } from 'path';
import fs from 'fs';

const url = process.argv[2];
const out = process.argv[3];

if (!url || !out) {
  console.error('用法: node tools/check-share.mjs <url> <输出文件>');
  process.exit(1);
}

const userDataDir = join(homedir(), '.toutiao-ops', 'accounts', 'default', 'browser-data');
const browser = await chromium.launchPersistentContext(userDataDir, { headless: true });
const page = await browser.newPage();
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
await browser.close();
