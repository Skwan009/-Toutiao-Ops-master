/**
 * 一次性：按 forum_id 抓取话题页正文，落盘 cli/output/forum/（只读）。
 * 用法：在 cli/ 目录执行 node tools/scrape-forum.mjs，
 *       并先把要抓的话题填进下面的 FORUMS。
 * forum_id 可从 message-center 输出的 forumId 字段取得。
 */
import { launchBrowser, closeBrowser, sleep } from '../src/browser.js';
import { writeFileSync, mkdirSync } from 'fs';

const OUT_DIR = './output/forum';
mkdirSync(OUT_DIR, { recursive: true });

// 示例占位：换成自己的话题再运行
const FORUMS = [
  {
    name: '示例话题名',
    url: 'https://mp.toutiao.com/profile_v3_public/public/forum-detail?forum_id=1234567890123456'
  }
];

const { context, page } = await launchBrowser({ headless: true });

for (const f of FORUMS) {
  try {
    await page.goto(f.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText);
    writeFileSync(`${OUT_DIR}/forum-${f.name}.txt`, text, 'utf8');
    console.log(`saved: ${f.name}, length=${text.length}`);
  } catch (e) {
    console.log(`failed: ${f.name}: ${e.message}`);
  }
}

await closeBrowser(context);
