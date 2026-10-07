import { chromium } from 'playwright';
import { homedir } from 'os';
import { join } from 'path';
import fs from 'fs';

const url = process.argv[2];
const out = process.argv[3];

const userDataDir = join(homedir(), '.toutiao-ops', 'accounts', 'default', 'browser');
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
