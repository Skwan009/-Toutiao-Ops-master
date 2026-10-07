import { launchBrowser, closeBrowser, sleep } from './src/browser.js';
import { writeFileSync, mkdirSync } from 'fs';

const OUT_DIR = './output/forum';
mkdirSync(OUT_DIR, { recursive: true });

const FORUMS = [
  {
    name: '父母老了依然还在忙碌是为了什么',
    url: 'https://mp.toutiao.com/profile_v3_public/public/forum-detail?forum_id=1786885933527187'
  },
  {
    name: '年迈父母健在是幸福还是负担',
    url: 'https://mp.toutiao.com/profile_v3_public/public/forum-detail?forum_id=1788528846560288'
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
