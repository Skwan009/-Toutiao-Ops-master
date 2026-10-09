/**
 * 一次性探测：确认 creator_center/list/v2 的 status / type / page 参数编码与返回结构。
 * 只读，不写入任何数据。产物落 cli/output/probe/。
 *
 * 用法：node tools/probe-content-list.mjs --account n1
 */
import { launchBrowser, closeBrowser, browserFetch, sleep } from '../src/browser.js';
import { ensureLoggedIn } from '../src/auth-guard.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'output', 'probe');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

const BASE = 'https://mp.toutiao.com/mp/agw/creator_center/list/v2';

function buildUrl({ status, type, page, pageSize }) {
  const p = new URLSearchParams({
    status: String(status),
    type: String(type),
    page_size: String(pageSize),
    need_stat: 'true',
    wenda_type: '1',
    app_id: '1231',
  });
  if (page != null) p.set('page', String(page));
  return `${BASE}?${p.toString()}`;
}

async function fetchList(page, params) {
  // 站内接口对连续请求敏感，失败退避重试一次
  let res = null;
  for (let i = 0; i < 2; i++) {
    try { res = await browserFetch(page, buildUrl(params)); break; }
    catch (e) { if (i === 1) throw e; await sleep(3000, 4500); }
  }
  let d = res && res.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
  const contents = (d && d.contents) || [];
  return {
    params,
    ok: Boolean(res && res.ok),
    status: res && res.status,
    totalCount: d && d.total_count != null ? d.total_count : null,
    listLen: contents.length,
    firstId: contents[0] ? (contents[0].id_str || contents[0].id || contents[0].item_id || null) : null,
    itemKeys: contents[0] ? Object.keys(contents[0]) : [],
    attrKeys: contents[0] && contents[0].article_attr ? Object.keys(contents[0].article_attr) : [],
    typeDistribution: [...new Set(contents.map((c) => `${c.article_attr?.type}:${c.article_attr?.type_desc}`))],
    statusDistribution: [...new Set(contents.map((c) => JSON.stringify({
      itemStatus: c.article_attr?.item_status ?? c.item_status ?? null,
      status: c.article_attr?.status ?? c.status ?? null,
    })))],
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  const rep = { schemaVersion: '1.0.0', probe: 'content-list', account: opts.account, startedAt: new Date().toISOString(), probes: [], errors: [] };

  const { context, page } = await launchBrowser(opts);
  try {
    await ensureLoggedIn(page);

    // 诊断：先落在真实业务页，让 SPA 安全 SDK 就绪，再调接口
    await page.goto('https://mp.toutiao.com/profile_v4/manage/content/all', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(4000, 6000);
    rep.diag = {
      url: page.url(),
      origin: await page.evaluate(() => location.origin).catch(() => null),
      hasFetchWrap: await page.evaluate(() => /secsdk|bytetos|bytegoofy/.test(String(window.fetch))).catch(() => null),
    };
    // 同源探针：直接打一次真实列表请求，先看错误原文
    try {
      const r = await browserFetch(page, buildUrl({ status: 2, type: 0, pageSize: 1 }));
      rep.diag.selfTest = { ok: r && r.ok, status: r && r.status, dataType: typeof (r && r.data) };
    } catch (e) {
      rep.diag.selfTest = { error: e.message.split('\n')[0] };
    }

    // 1) 先复跑自测参数，判断是"参数相关"还是"第二次调用必失败"
    for (const params of [{ status: 2, type: 0, pageSize: 1 }, { status: 2, type: 0, pageSize: 5 }, { status: 0, type: 0, pageSize: 5 }]) {
      try { rep.probes.push(await fetchList(page, params)); }
      catch (e) { rep.errors.push(`${JSON.stringify(params)}: ${e.message.split('\n')[0]} @ ${page.url()}`); }
      await sleep(2500, 4000);
    }

    // 2) status 编码矩阵（type 固定 0）
    for (const status of [2, 4, 5, 6]) {
      try { rep.probes.push(await fetchList(page, { status, type: 0, pageSize: 5 })); }
      catch (e) { rep.errors.push(`status=${status}: ${e.message.split('\n')[0]} @ ${page.url()}`); }
      await sleep(2500, 4000);
    }

    // 3) type 编码矩阵（status 固定 2）
    for (const type of [1, 2, 3]) {
      try { rep.probes.push(await fetchList(page, { status: 2, type, pageSize: 5 })); }
      catch (e) { rep.errors.push(`type=${type}: ${e.message.split('\n')[0]} @ ${page.url()}`); }
      await sleep(2500, 4000);
    }

    // 4) page 参数是否生效：对比 page=1 与 page=2 的首条 ID
    try {
      const p1 = await fetchList(page, { status: 2, type: 0, pageSize: 2, page: 1 });
      await sleep(2500, 4000);
      const p2 = await fetchList(page, { status: 2, type: 0, pageSize: 2, page: 2 });
      rep.pageParam = { p1First: p1.firstId, p2First: p2.firstId, effective: Boolean(p1.firstId && p2.firstId && p1.firstId !== p2.firstId) };
    } catch (e) { rep.errors.push(`page: ${e.message.split('\n')[0]} @ ${page.url()}`); }
  } finally {
    await closeBrowser(context);
  }

  const file = join(OUT_DIR, `content-list_${opts.account || 'default'}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(rep, null, 2));
  console.log(JSON.stringify({
    ok: rep.errors.length === 0,
    file,
    diag: rep.diag || null,
    probes: rep.probes.map((p) => ({ params: p.params, ok: p.ok, httpStatus: p.status, totalCount: p.totalCount, listLen: p.listLen, typeDistribution: p.typeDistribution })),
    pageParam: rep.pageParam || null,
    errors: rep.errors.map((e) => String(e).split('\n')[0]),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
