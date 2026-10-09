#!/usr/bin/env node
/**
 * 只读探测：创作中心「数据 - 作品数据」单篇明细接口
 * 目的：找到能返回「单篇作品（标题/阅读/展现/点赞）」的站内接口，作为 works-analytics 信号源的实现依据。
 * 用法：node tools/probe-works-overall.mjs --account <账号名> [--headless]
 * 边界：只导航 + 扫描 + 滚动，绝不输入文本、不提交表单、不发布。
 */
import { launchBrowser, closeBrowser, sleep, waitForStable, dismissOverlays } from '../src/browser.js';
import { ensureLoggedIn } from '../src/auth-guard.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'output', 'probe');

const URLS = {
  all: 'https://mp.toutiao.com/profile_v4/analysis/works-overall/all',
  article: 'https://mp.toutiao.com/profile_v4/analysis/works-overall/article',
  video: 'https://mp.toutiao.com/profile_v4/analysis/works-overall/video',
};

function parseArgs(argv) {
  const o = { account: 'default', headless: false, types: 'all' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') o.account = argv[++i];
    else if (argv[i] === '--headless') o.headless = true;
    else if (argv[i] === '--types') o.types = argv[++i];
  }
  return o;
}

function summarize(v, d = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return d >= 4 ? `array(${v.length})` : { __array: v.length, __sample: v.length ? summarize(v[0], d + 1) : null };
  if (typeof v === 'object') {
    if (d >= 4) return 'object';
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = summarize(x, d + 1);
    return o;
  }
  return typeof v;
}

// 越可能含单篇明细的接口，兴趣越高
function interest(url, body) {
  const s = `${url} ${body || ''}`;
  if (/(works_overall|content_list|item_list|article_list|list)/i.test(s)) return 100;
  if (/(statistic|analysis|overview|detail)/i.test(s)) return 70;
  if (/(pgc\/ma|\/agw\/|content)/i.test(s)) return 50;
  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });

  const rep = {
    schemaVersion: '1.0.0', probe: 'works-overall', account: opts.account,
    startedAt: new Date().toISOString(),
    phases: [], apiHits: [], requests: [], payloads: [], dom: null, errors: [],
  };
  const apiSeen = new Set();
  const reqSeen = new Set();
  const { context, page } = await launchBrowser(opts);

  const attach = (p) => {
    const key = (req) => {
      let b = '';
      try { b = req.postData() || ''; } catch {}
      return `${req.method()} ${req.url()} ${b}`;
    };
    p.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith('http')) return;
      const k = key(req);
      if (reqSeen.has(k)) return;
      reqSeen.add(k);
      let postData = '';
      try { postData = (req.postData() || '').slice(0, 1500); } catch {}
      const it = interest(url, postData);
      if (it >= 50) rep.requests.push({ method: req.method(), url, postData, interest: it });
    });
    p.on('response', async (r) => {
      try {
        const url = r.url();
        if (!url.startsWith('http')) return;
        if (!(r.headers()['content-type'] || '').includes('json')) return;
        const k = key(r.request());
        if (apiSeen.has(k)) return;
        apiSeen.add(k);
        const j = await r.json().catch(() => null);
        if (j === null) return;
        let path = url;
        try { path = new URL(url).pathname; } catch {}
        const it = interest(url, r.request().postData());
        rep.apiHits.push({ url, path, status: r.status(), interest: it, summary: summarize(j) });
        if (it >= 70) rep.payloads.push({ url, path, status: r.status(), interest: it, data: j });
      } catch {}
    });
  };
  context.on('page', attach);
  attach(page);

  try {
    rep.phases.push({ name: 'home' });
    await page.goto('https://mp.toutiao.com/profile_v4/', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await ensureLoggedIn(page);
    await waitForStable(page);
    await sleep(2000, 3000);
    await dismissOverlays(page);

    const types = opts.types.split(',').map((s) => s.trim()).filter(Boolean);
    for (const t of types) {
      const url = URLS[t] || URLS.all;
      const before = rep.apiHits.length;
      rep.phases.push({ name: 'works-overall', type: t, url });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => rep.errors.push(`goto(${t}): ${e.message}`));
      await waitForStable(page);
      await sleep(4000, 5000);
      await dismissOverlays(page);
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 2500).catch(() => {}); await sleep(1200, 1800); }
      rep[`after_${t}`] = {
        url: page.url(),
        textLen: await page.evaluate(() => (document.body.innerText || '').length),
        newApi: rep.apiHits.slice(before).map((h) => `${h.interest} ${h.status} ${h.path}`),
      };
    }

    rep.dom = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr, [class*="table"] [class*="row"], [class*="list"] [class*="item"]');
      const head = document.querySelector('table thead')?.innerText || '';
      return {
        rowCount: rows.length,
        headText: head.slice(0, 300),
        rowSamples: Array.from(rows).slice(0, 3).map((r) => (r.innerText || '').slice(0, 300)),
      };
    });

    rep.phases.push({ name: 'done' });
  } catch (e) {
    rep.errors.push(e.message);
  } finally {
    await closeBrowser(context);
  }

  rep.finishedAt = new Date().toISOString();
  rep.apiHits.sort((a, b) => b.interest - a.interest);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(OUT_DIR, `works-overall_${opts.account}_${ts}.json`);
  writeFileSync(file, JSON.stringify(rep, null, 2), 'utf-8');

  console.log(JSON.stringify({
    ok: rep.errors.length === 0,
    file,
    apiHitTotal: rep.apiHits.length,
    interestedApi: rep.apiHits.filter((h) => h.interest >= 70).slice(0, 30).map((h) => `${h.interest} ${h.status} ${h.path}`),
    requests: rep.requests.slice(0, 20),
    dom: rep.dom,
    errors: rep.errors,
  }, null, 2));
}

main().catch((e) => { console.error(JSON.stringify({ error: e.message, stack: e.stack }, null, 2)); process.exit(1); });
