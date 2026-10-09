/**
 * 一次性：抓取微头条发布页全文与「首发」相关元素结构，落盘 cli/output/（只读）。
 * 用法：在 cli/ 目录执行 node tools/inspect-wtt-publish.mjs
 */
import { launchBrowser, closeBrowser, sleep } from '../src/browser.js';
import { writeFileSync, mkdirSync } from 'fs';

const OUT_DIR = './output';
mkdirSync(OUT_DIR, { recursive: true });

const { context, page } = await launchBrowser({ headless: true });

try {
  await page.goto('https://mp.toutiao.com/profile_v4/weitoutiao/publish', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(4000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // 抓页面全文，找首发相关文案
  const text = await page.evaluate(() => document.body.innerText);
  writeFileSync(`${OUT_DIR}/wtt-publish-page.txt`, text, 'utf8');
  console.log('page text saved, length=', text.length);
  console.log('含「首发」字样:', text.includes('首发'));
  const idx = text.indexOf('首发');
  if (idx >= 0) console.log('首发上下文:', JSON.stringify(text.slice(Math.max(0, idx - 100), idx + 200)));

  // 抓所有含首发/声明/checkbox 的元素结构
  const els = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('label, [class*="check"], [class*="declare"], [class*="claim"], input[type="checkbox"]').forEach(el => {
      const t = (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60);
      if (t) out.push({ tag: el.tagName, cls: String(el.className).slice(0, 80), text: t });
    });
    return out;
  });
  console.log('候选元素:', JSON.stringify(els, null, 1).slice(0, 3000));

  // 截图留证
  await page.screenshot({ path: `${OUT_DIR}/wtt-publish-page.png`, fullPage: true });
  console.log('screenshot saved');
} catch (e) {
  console.log('failed:', e.message);
} finally {
  await closeBrowser(context);
}
