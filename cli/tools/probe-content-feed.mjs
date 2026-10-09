/**
 * 一次性探测：作品管理页到底发了哪些 JSON 接口（用于校准 verify.json 的 feedApiMatch）。
 * 只读，不写入任何数据。
 *
 * 用法：node tools/probe-content-feed.mjs --account <账号名>
 */
import { launchBrowser, closeBrowser, sleep, waitForStable, dismissOverlays } from '../src/browser.js';
import { ensureLoggedIn } from '../src/auth-guard.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'output', 'probe');
const CONTENT_PAGE = 'https://mp.toutiao.com/profile_v4/manage/content/all';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  const rep = { schemaVersion: '1.0.0', probe: 'content-feed', account: opts.account, startedAt: new Date().toISOString(), jsonApis: [], errors: [] };

  const { context, page } = await launchBrowser(opts);
  const seen = new Set();
  page.on('response', async (r) => {
    try {
      const url = r.url();
      if (!url.startsWith('http')) return;
      const ct = r.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const key = r.request().method() + ' ' + url.split('?')[0];
      if (seen.has(key)) return;
      seen.add(key);
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
      } catch { /* 非 JSON 体 */ }
      rep.jsonApis.push({ method: r.request().method(), url, status: r.status(), probe });
    } catch { /* ignore */ }
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
    rep.phase2Apis = rep.jsonApis.slice(rep.phase1ApiCount);

    rep.finalUrl = page.url();
    rep.textLen = await page.evaluate(() => (document.body.innerText || '').length).catch(() => null);
    rep.textHead = await page.evaluate(() => (document.body.innerText || '').slice(0, 600)).catch(() => null);
    rep.domStats = await page.evaluate(() => ({
      itemWraps: document.querySelectorAll('[class*="content-item"], [class*="article-item"], [class*="feed"]').length,
      hasLogin: /登录|扫码/.test(document.body.innerText || ''),
    })).catch(() => null);
  } finally {
    await closeBrowser(context);
  }

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
