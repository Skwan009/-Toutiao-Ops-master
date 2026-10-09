#!/usr/bin/env node
/**
 * 只读探测：头条创作者后台「消息中心」结构勘察
 * 目的：拿到消息中心的真实 URL / 接口端点 / DOM 结构，作为 src/message-center.js 的实现依据。
 * 用法：node tools/probe-message-center.mjs --account <账号名> [--headless] [--wait 8000]
 * 边界：只导航 + 扫描 + 点击消息入口；绝不输入文本、绝不提交表单、绝不发布。
 */
import { launchBrowser, closeBrowser, sleep, waitForStable, dismissOverlays } from '../src/browser.js';
import { ensureLoggedIn } from '../src/auth-guard.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'output', 'probe');

function parseArgs(argv) {
  const o = { account: 'default', headless: false, wait: 8000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--account') o.account = argv[++i];
    else if (argv[i] === '--headless') o.headless = true;
    else if (argv[i] === '--wait') o.wait = Number(argv[++i]);
  }
  return o;
}

/** JSON 压成结构摘要：只留键名与类型，数组给长度与首元素样例 */
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

function interest(url) {
  if (/(message|msg|notice|notification|letter|inbox)/i.test(url)) return 100;
  if (/(im|conversation|chat)/i.test(url)) return 50;
  if (/(topic|forum|activity|task|inspiration)/i.test(url)) return 30;
  return 0;
}

const NAV_KW = '消息|通知|私信|站内信|互动|成长助手|邀请|小助手';
const MESSAGE_URL = 'https://mp.toutiao.com/profile_v4/personal/message';

/** goto 重试（SPA 路由偶发 ERR_FAILED） */
async function gotoRetry(page, url, errors, tag) {
  for (let i = 0; i < 2; i++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return true; }
    catch (e) { if (i === 1) errors.push(`goto(${tag})x2: ${e.message}`); await sleep(1500, 2500); }
  }
  return false;
}

/** 轮询等待条件成立（最多 times 次，每次间隔约 2s） */
async function poll(page, cond, times = 10) {
  for (let i = 0; i < times; i++) {
    if (await page.evaluate(cond).catch(() => false)) return true;
    await sleep(1600, 2200);
  }
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });

  const rep = {
    schemaVersion: '1.2.0', probe: 'message-center', account: opts.account,
    startedAt: new Date().toISOString(),
    phases: [], apiHits: [], apiPayloads: [], requests: [], tabLinks: [], typeProbes: [],
    navCandidates: [], clicks: [], pages: [], domProbe: null, errors: [],
  };
  const apiSeen = new Set();
  const reqSeen = new Set();
  const { context, page } = await launchBrowser(opts);

  const attach = (p) => {
    const reqKey = (req) => {
      let body = '';
      try { body = req.postData() || ''; } catch {}
      return `${req.method()} ${req.url()} ${body}`;
    };
    // 记录请求方法/URL/body（重点是 /bcs/notice/ 的 POST body）
    p.on('request', (req) => {
      try {
        const url = req.url();
        if (!/\/bcs\/notice\//.test(url)) return;
        const k = reqKey(req);
        if (reqSeen.has(k)) return;
        reqSeen.add(k);
        let postData = '';
        try { postData = (req.postData() || '').slice(0, 2000); } catch {}
        rep.requests.push({ method: req.method(), url, postData });
      } catch {}
    });
    p.on('response', async (r) => {
      try {
        const url = r.url();
        if (!url.startsWith('http')) return;
        if (!(r.headers()['content-type'] || '').includes('json')) return;
        // 去重键用「method+URL+body」，避免同 URL 的分页 POST 被误吞
        const k = reqKey(r.request());
        if (apiSeen.has(k)) return;
        apiSeen.add(k);
        const j = await r.json().catch(() => null);
        if (j === null) return;
        let path = url;
        try { path = new URL(url).pathname; } catch {}
        const it = interest(url);
        rep.apiHits.push({ url, path, status: r.status(), interest: it, summary: summarize(j) });
        // 消息相关接口落全量载荷，供 parser 字段设计
        if (it >= 30) rep.apiPayloads.push({ url, path, status: r.status(), interest: it, data: j });
      } catch {}
    });
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) rep.pages.push({ url: f.url(), t: Date.now() }); });
  };
  context.on('page', attach);
  attach(page);

  try {
    const HOME = 'https://mp.toutiao.com/profile_v4/';
    rep.phases.push({ name: 'home', url: HOME });
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await ensureLoggedIn(page);
    await waitForStable(page);
    await sleep(2000, 3000);
    await dismissOverlays(page);
    // 轮询等待侧栏「消息」入口渲染完成（异步头图/账号块可能延迟）
    await poll(page, () => (document.body.innerText || '').includes('消息'), 10);

    rep.navCandidates = await page.evaluate((src) => {
      const kw = new RegExp(src);
      const out = [], seen = new Set();
      document.querySelectorAll('a, li, div, span, [role="menuitem"]').forEach((el) => {
        const t = (el.textContent || '').trim();
        if (!t || t.length > 12 || !kw.test(t)) return;
        const cls = (el.className || '').toString().slice(0, 90);
        const href = (el.getAttribute && el.getAttribute('href')) || '';
        const k = t + '|' + cls + '|' + href;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ text: t, tag: el.tagName, cls, href });
      });
      return out.slice(0, 40);
    }, NAV_KW);

    rep.domProbe = await page.evaluate(() => {
      const b = document.body.innerText || '';
      return { url: location.href, textHead: b.slice(0, 1500), textLen: b.length };
    });

    const target = await page.evaluate((src) => {
      const kw = new RegExp(src);
      const cands = Array.from(document.querySelectorAll('a, li, div, span')).filter((el) => {
        const t = (el.textContent || '').trim();
        return t && t.length <= 6 && kw.test(t);
      });
      if (!cands.length) return null;
      const el = cands[0];
      el.setAttribute('data-probe-target', '1');
      return { text: (el.textContent || '').trim(), tag: el.tagName, cls: (el.className || '').toString().slice(0, 90) };
    }, NAV_KW);

    if (target) {
      rep.clicks.push({ target, at: Date.now() });
      await page.click('[data-probe-target="1"]', { timeout: 8000 }).catch((e) => rep.errors.push('click: ' + e.message));
      await waitForStable(page);
      await sleep(opts.wait, opts.wait + 2000);
      await dismissOverlays(page);
      rep.domProbe.afterClick = await page.evaluate(() => {
        const b = document.body.innerText || '';
        return { url: location.href, textHead: b.slice(0, 3000), textLen: b.length };
      });
    } else {
      rep.errors.push('未找到消息入口候选，需人工确认侧栏结构');
    }

    // 追加：直达消息 URL（验证稳定可达）+ 轮询等待消息内容渲染
    rep.phases.push({ name: 'direct-goto', url: MESSAGE_URL });
    await gotoRetry(page, MESSAGE_URL, rep.errors, 'direct');
    await waitForStable(page);
    await sleep(3000, 4000);
    await dismissOverlays(page);
    // 轮询等待 IM 子应用渲染出分类/消息内容
    await poll(page, () => {
      const t = document.body.innerText || '';
      return t.includes('消息中心') && (t.includes('话题邀请') || t.includes('赞了') || t.includes('评论') || t.includes('活动通知'));
    }, 12);
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 2500).catch(() => {});
      await sleep(1200, 1800);
    }
    rep.domProbe.afterGoto = await page.evaluate(() => {
      const b = document.body.innerText || '';
      return { url: location.href, textLen: b.length, textTail: b.slice(-800) };
    });

    // 扫描左侧标签链接，拿到全部 ?type= slug
    rep.tabLinks = await page.evaluate(() => {
      const out = [], seen = new Set();
      document.querySelectorAll('a[href], [data-type], [data-tab]').forEach((el) => {
        const href = el.getAttribute('href') || '';
        const dt = el.getAttribute('data-type') || el.getAttribute('data-tab') || '';
        if (!/personal\/message/.test(href) && !dt) return;
        let type = dt;
        try { type = new URL(href, location.origin).searchParams.get('type') || dt; } catch {}
        if (!type) return;
        const text = (el.textContent || '').trim().slice(0, 16);
        const k = type + '|' + text;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ type, text, href });
      });
      return out.slice(0, 20);
    });

    // 逐个 type 直达，捕获每个分类的 cell/list 请求体
    const slugs = [...new Set(rep.tabLinks.map((t) => t.type))];
    for (const s of ['message_letter', 'digg']) if (!slugs.includes(s)) slugs.push(s);
    for (const s of slugs.slice(0, 6)) {
      const before = rep.requests.length;
      const beforePayload = rep.apiPayloads.length;
      await gotoRetry(page, `${MESSAGE_URL}?type=${s}`, rep.errors, s);
      await waitForStable(page);
      await sleep(2500, 3500);
      for (let i = 0; i < 2; i++) { await page.mouse.wheel(0, 2500).catch(() => {}); await sleep(1000, 1500); }
      rep.typeProbes.push({
        type: s,
        url: page.url(),
        textLen: await page.evaluate(() => (document.body.innerText || '').length),
        newRequests: rep.requests.slice(before),
        cellCalls: rep.apiPayloads.slice(beforePayload)
          .filter((p) => p.path.includes('/bcs/notice/cell/list/'))
          .map((p) => ({ count: p.data?.cells?.length ?? null, hasMore: p.data?.has_more, next: p.data?.next_cursor })),
      });
    }

    rep.phases.push({ name: 'done' });
  } catch (e) {
    rep.errors.push(e.message);
  } finally {
    await closeBrowser(context);
  }

  rep.finishedAt = new Date().toISOString();
  rep.apiHits.sort((a, b) => b.interest - a.interest);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(OUT_DIR, `message-center_${opts.account}_${ts}.json`);
  writeFileSync(file, JSON.stringify(rep, null, 2), 'utf-8');

  console.log(JSON.stringify({
    ok: rep.errors.length === 0,
    file,
    pages: rep.pages.map((p) => p.url),
    navCandidateCount: rep.navCandidates.length,
    clicked: rep.clicks[0]?.target || null,
    urlAfterClick: rep.domProbe?.afterClick?.url || null,
    urlAfterGoto: rep.domProbe?.afterGoto?.url || null,
    textLen: [rep.domProbe?.textLen, rep.domProbe?.afterClick?.textLen, rep.domProbe?.afterGoto?.textLen],
    apiHitTotal: rep.apiHits.length,
    tabLinks: rep.tabLinks,
    noticeRequests: rep.requests,
    typeProbes: rep.typeProbes.map((p) => ({ type: p.type, url: p.url, textLen: p.textLen, newReq: p.newRequests.length, cellCalls: p.cellCalls })),
    cellPayloadCount: rep.apiPayloads.filter((p) => p.path.includes('/bcs/notice/cell/list/')).length,
    errors: rep.errors,
  }, null, 2));
}

main().catch((e) => { console.error(JSON.stringify({ error: e.message, stack: e.stack }, null, 2)); process.exit(1); });
