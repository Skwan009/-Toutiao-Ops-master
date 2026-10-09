import { launchBrowser, closeBrowser, sleep, waitForStable, dismissOverlays } from './browser.js';
import { ensureLoggedIn } from './auth-guard.js';
import { fetchWorks, countersOf } from './works-api.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BASE_DIR } from './paths.js';

/**
 * 发布后四步核验（独立于发布页的即时判定，走站内真实数据复核）。
 *   1. 草稿箱自检   —— 目标内容若仍在草稿，说明并未真正发布
 *   2. 条数 +1      —— 作品总数较基线 +1
 *   3. 读 vl        —— 按标题定位作品，读 articleBase.visibilityLevel 并按值分支
 *   4. 正文重复检测 —— 列表内出现重复正文 = 典型的"内容叠加"
 *
 * 数据来源：管理页作品流的接口拦截（GET /api/feed/mp_provider/v1/）。
 * 结构：data[].assembleCell.itemCell.{ articleBase, reviewInfo, itemCounter, ... }
 * 直连该接口会 errno:20100（缺签名参数），故一律走拦截，不自造请求。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = join(HERE, '..', 'config', 'verify.json');
// 运行时产物写 ~/.toutiao-ops/，不写包内（全局安装后 node_modules 通常只读）
const SNAP_DIR = join(BASE_DIR, 'verify');
const SCHEMA_VERSION = '1.0.0';

function loadCfg() {
  return JSON.parse(readFileSync(CFG_PATH, 'utf-8'));
}

/** 归一化（去空白与标点），不截断：用于被搜索的页面全文 / 单元格文本 */
const normAll = (s) => String(s || '').replace(/[\s\p{P}]/gu, '');
/** 目标侧：归一化并截断（长正文只取前 80 字参与定位） */
const normTarget = (s) => normAll(s).slice(0, 80);
/** 排重键 */
const normKey = (s) => normAll(s).slice(0, 80);

/** 从 mp_provider 响应体抽取 itemCell 列表 */
function extractCells(json) {
  const arr = (json && json.data) || [];
  const out = [];
  for (const d of arr) {
    const ic = d && d.assembleCell && d.assembleCell.itemCell;
    if (ic && ic.articleBase) out.push(ic);
  }
  return out;
}

const cellTitle = (ic) => [ic.articleBase && ic.articleBase.title, ic.articleBase && ic.articleBase.abstractText].filter(Boolean).join(' ');

/**
 * 单元格身份键。只用真实 ID，**绝不回退到标题**——
 * 标题是"内容重复检测"的判据，拿它当身份会把同一篇作品的两种来源误判成内容叠加。
 * 无 ID 时返回空串，由上层按"跨源合并"处理。
 */
function cellKey(ic) {
  const ab = (ic && ic.articleBase) || {};
  const id = ab.itemId ?? ab.item_id ?? ab.groupId ?? ab.group_id ?? ab.gid ?? ab.id;
  return id == null || id === '' ? '' : String(id);
}

/**
 * 等待在途的 response 监听回调全部结束。
 * `page.on('response')` 的回调是异步的，直接 closeBrowser 会丢掉最后一批数据。
 */
async function drainResponses(inflight, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (inflight.n === 0) {
      // 再观察一个时隙，确认没有新的响应进来
      await sleep(400, 700);
      if (inflight.n === 0) return true;
    }
    await sleep(150, 300);
  }
  return false;
}

/** itemCounter：刚发布时展现/阅读为 0 属正常 */
function pickCounter(ic) {
  const c = ic.itemCounter || {};
  return {
    show: c.showCount ?? 0,
    read: c.readCount ?? 0,
    comment: c.commentCount ?? 0,
    digg: c.diggCount ?? 0,
    repin: c.repinCount ?? 0,
  };
}

function pickSuppression(ic) {
  return ic.suppressionInfo
    ?? (ic.extra && ic.extra.suppressionInfo)
    ?? (ic.articleBase && ic.articleBase.suppressionInfo)
    ?? null;
}

/**
 * `creator_center/list/v2` 的条目 → 与拦截到的 `itemCell` 同构（camelCase），
 * 这样 vl 分支与重复检测可以共用同一套逻辑。
 *
 * 说明：接口提供的是 `visibility_level` / `status_desc` / `verify_reason`。
 * 这里只映射"能对上号"的字段——没有对应物的（如 reviewInfo 的数字 status）
 * 一律不臆造，让 classifyVL 走 `restricted_unknown`（ok=null，不给错误结论）。
 */
function normalizeApiWork(item) {
  const a = item.article_attr || {};
  const s = item.article_stat || {};
  const counters = countersOf(s);
  return {
    articleBase: {
      itemId: a.item_id ?? null,
      groupId: a.gid ?? null,
      title: a.title || '',
      abstractText: a.abstract || '',
      visibilityLevel: a.visibility_level ?? null,
      itemStatus: a.status ?? null,
      suppressionInfo: a.verify_reason ? { reason: a.verify_reason } : null,
    },
    reviewInfo: { title: a.status_desc || '' },
    itemCounter: {
      showCount: s.impression_count ?? counters['展现'] ?? 0,
      readCount: s.go_detail_count ?? counters['阅读'] ?? 0,
      commentCount: s.comment_count ?? counters['评论'] ?? 0,
      diggCount: s.digg_count ?? counters['点赞'] ?? 0,
      repinCount: s.repin_count ?? 0,
    },
  };
}

/** vl 分支判定（ok=null 表示无法判定） */
export function classifyVL(vl, review, suppression) {
  if (vl === 40) return { ok: true, verdict: 'normal', reason: '正常分发' };
  if (vl === 15) {
    const title = review ? (review.title ?? review.Title ?? '') : '';
    const status = review ? (review.status ?? review.Status ?? null) : null;
    if (title === '审核中') return { ok: true, verdict: 'in_review', selfHealing: true, reason: '审核队列中，会自愈，勿重发' };
    if (status === 3 && !title) return { ok: false, verdict: 'restricted', selfHealing: false, reason: '真受限，不会自愈' };
    return { ok: null, verdict: 'restricted_unknown', selfHealing: false, reason: '受限，但不匹配已知分支' };
  }
  if (vl === 45) {
    const reason = suppression ? (suppression.reason ?? suppression.Reason ?? '') : '';
    if (reason) return { ok: false, verdict: 'suppressed', selfHealing: false, reason: `真压制：${reason}` };
    return { ok: true, verdict: 'review_transition', selfHealing: true, reason: '审核过渡态（suppressionInfo 无 reason）' };
  }
  if (vl === 60) return { ok: true, verdict: 'weighted', reason: '加权' };
  return { ok: null, verdict: 'unknown', reason: `未知 visibilityLevel=${vl}` };
}

export async function verifyPublish(opts = {}) {
  const cfg = loadCfg();
  const target = normTarget(opts.content || opts.title || '');
  const hasTarget = Boolean(target);
  const { context, page } = await launchBrowser(opts);
  const cells = [];
  const inflight = { n: 0 };
  const warnings = [];
  let total = null;

  // 跨源合并策略：
  //  - 有真实 ID：按 ID 去重（含跨页重复渲染）；
  //  - 无 ID：按标题识别"同一条"，但**只在来源不同时**合并——拦截与接口拿到的是同一篇；
  //    同源同标题则保留两条，因为那正是要找的"内容叠加"。
  const seenId = new Set();
  const cellMeta = new WeakMap(); // cell → { origin, titleKey }
  const titleIndex = new Map();   // titleKey → cell

  function addCell(ic, origin) {
    const id = cellKey(ic);
    const titleKey = normKey(cellTitle(ic));
    const prev = titleKey ? titleIndex.get(titleKey) : null;

    if (prev && cellMeta.get(prev).origin !== origin) {
      // 跨源命中同一条：接口数据更全，用它替换拦截版
      if (origin === 'api') {
        const i = cells.indexOf(prev);
        if (i >= 0) cells[i] = ic;
        titleIndex.set(titleKey, ic);
        cellMeta.set(ic, { origin, titleKey });
      }
      if (id) seenId.add(id);
      return false;
    }
    if (id) {
      if (seenId.has(id)) return false;
      seenId.add(id);
    }
    if (titleKey) titleIndex.set(titleKey, ic);
    cellMeta.set(ic, { origin, titleKey });
    cells.push(ic);
    return true;
  }

  // 先挂监听，再导航（拦截管理页作品流）
  page.on('response', (r) => {
    if (!r.url().includes(cfg.feedApiMatch)) return;
    inflight.n++;
    (async () => {
      try {
        const j = await r.json();
        if (j && j.total_number != null) total = j.total_number;
        for (const ic of extractCells(j)) addCell(ic, 'intercept');
      } catch {
        // 单个响应解析失败不影响整体核验
      } finally {
        inflight.n--;
      }
    })();
  });

  const steps = [];
  try {
    await ensureLoggedIn(page);

    // ── 步骤 1：草稿箱自检 ──
    await page.goto(cfg.pages.draft, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForStable(page);
    await sleep(2500, 3500);
    await dismissOverlays(page);
    const draftText = await page.evaluate(() => document.body.innerText || '');
    const emptyDraft = /暂无草稿|共\s*0\s*条内容/.test(draftText);
    // 未提供 --content/--title 时无法比对，本步跳过（ok=null），不要伪报通过
    const inDraft = hasTarget && !emptyDraft && normAll(draftText).includes(target);
    steps.push({
      id: 'draft_check',
      ok: hasTarget ? !inDraft : null,
      skipped: !hasTarget,
      empty: emptyDraft,
      reason: !hasTarget
        ? '未提供 --content/--title，已跳过草稿箱比对'
        : inDraft ? '目标内容仍在草稿箱 —— 实际未发布' : emptyDraft ? '草稿箱为空' : '草稿箱中未发现目标内容',
    });

    // ── 加载作品流（步骤 2/3/4 共用）──
    await page.goto(cfg.pages.content, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await waitForStable(page);
    await sleep(3000, 4000);
    await dismissOverlays(page);
    for (let i = 0; i < (cfg.maxScrolls || 3); i++) {
      await page.mouse.wheel(0, 2500).catch(() => {});
      await sleep(1200, 1800);
    }
    // 滚动会触发新的作品流请求；必须等在途响应全部落定再读 cells，
    // 否则 finally 里的 closeBrowser 会截断最后一批数据，造成偶发误判。
    if (!(await drainResponses(inflight))) {
      warnings.push('作品流响应未在 8 秒内全部返回，核验结果可能不完整');
    }

    // ── 步骤 2：条数 +1 ──
    // 一次请求同时取回「总数」与「作品明细」：
    //  1) 页面拦截在部分环境下拿不到作品流（页面不渲染作品时根本不发列表请求）；
    //  2) 同一页面内自造请求只有第一条能成功，所以必须合并，不能分两次请求。
    const interceptedCount = cells.length;
    let apiWorkCount = 0;
    let currentCount = null;
    try {
      const d = await fetchWorks(page, {
        status: cfg.countStatus ?? 2,
        type: 0,
        pageSize: cfg.pageSize ?? 50,
        appId: cfg.appId ?? 1231,
      });
      if (d.total_count != null) currentCount = d.total_count;
      for (const item of d.contents || []) {
        if (addCell(normalizeApiWork(item), 'api')) apiWorkCount++;
      }
    } catch (e) {
      warnings.push(`作品列表接口调用失败，回退到页面拦截数据：${e.message}`);
    }
    if (currentCount == null) currentCount = total != null ? total : cells.length;
    const snapFile = join(SNAP_DIR, `${opts.account || 'default'}.json`);
    let baseline = opts.beforeCount != null ? Number(opts.beforeCount) : null;
    let baselineSource = baseline != null ? 'opts' : null;
    if (baseline == null && existsSync(snapFile)) {
      try {
        const snap = JSON.parse(readFileSync(snapFile, 'utf-8'));
        if (snap.count != null) { baseline = snap.count; baselineSource = 'snapshot'; }
      } catch {}
    }
    steps.push({
      id: 'count_plus_one',
      ok: baseline == null ? null : currentCount === baseline + 1,
      skipped: baseline == null,
      baseline,
      baselineSource,
      current: currentCount,
      reason: baseline == null
        ? '无基线（可传 --before-count，或先跑一次生成快照）'
        : currentCount === baseline + 1 ? '总数 +1，符合预期' : `总数 ${baseline} → ${currentCount}，未 +1`,
    });

    // ── 步骤 3：读 vl（按标题定位 → visibilityLevel 分支）──
    const matched = target
      ? cells.find((ic) => normAll(cellTitle(ic)).includes(target))
      : null;
    if (!matched) {
      steps.push({
        id: 'read_vl',
        ok: null,
        skipped: !hasTarget,
        found: false,
        scanned: cells.length,
        reason: hasTarget
          ? '未在作品流中匹配到目标内容（可能未发布，或不在首页）'
          : '未提供 --content/--title，已跳过 vl 读取',
      });
    } else {
      const vl = matched.articleBase.visibilityLevel ?? null;
      const review = matched.reviewInfo ?? null;
      const suppression = pickSuppression(matched);
      const cls = classifyVL(vl, review, suppression);
      steps.push({
        id: 'read_vl',
        ok: cls.ok,
        found: true,
        matchedTitle: (matched.articleBase.title || '').slice(0, 60),
        visibilityLevel: vl,
        itemStatus: matched.articleBase.itemStatus ?? null,
        verdict: cls.verdict,
        selfHealing: cls.selfHealing ?? null,
        reviewInfo: review,
        suppressionInfo: suppression,
        itemCounter: pickCounter(matched),
        reason: cls.reason,
      });
    }

    // ── 步骤 4：正文重复检测 ──
    // 带上各条的 id，便于区分"跨源重复取到同一条"与"真的内容叠加"
    const groups = new Map();
    for (const ic of cells) {
      const k = normKey(cellTitle(ic));
      if (!k) continue;
      const g = groups.get(k) || { count: 0, ids: [] };
      g.count++;
      if (g.ids.length < 5) g.ids.push(cellKey(ic) || '(no-id)');
      groups.set(k, g);
    }
    const dups = [...groups.entries()]
      .filter(([, g]) => g.count > 1)
      .map(([k, g]) => ({ key: k.slice(0, 40), count: g.count, ids: g.ids }));
    // 一条都没扫到时的"未发现重复"是空集合假通过，必须报无法判定（ok=null）
    steps.push({
      id: 'duplicate_check',
      ok: cells.length ? dups.length === 0 : null,
      skipped: cells.length === 0,
      scanned: cells.length,
      duplicates: dups,
      reason: !cells.length
        ? '未捕获到作品流数据，无法判定是否重复'
        : dups.length ? `发现 ${dups.length} 组重复内容（疑似内容叠加）` : '未发现重复内容',
    });

    // 落盘快照，供下次比对基线。失败不阻断核验，但要如实上报（不再静默吞错）。
    let snapshot = null;
    try {
      mkdirSync(SNAP_DIR, { recursive: true });
      writeFileSync(snapFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, account: opts.account || 'default', count: currentCount, at: new Date().toISOString() }, null, 2));
      snapshot = snapFile;
    } catch (e) {
      warnings.push(`基线快照写入失败（${snapFile}）：${e.message}`);
    }

    const failed = steps.filter((s) => s.ok === false);
    const passed = steps.filter((s) => s.ok === true);
    const skipped = steps.filter((s) => s.ok == null);
    return {
      schemaVersion: SCHEMA_VERSION,
      success: true,
      account: opts.account || 'default',
      verifiedAt: new Date().toISOString(),
      // 全步骤都无结论时不能报 pass，否则"什么都没核验"会被误读成通过
      verdict: failed.length ? 'fail' : passed.length ? 'pass' : 'inconclusive',
      failed: failed.map((s) => s.id),
      skipped: skipped.map((s) => s.id),
      workSources: { intercepted: interceptedCount, api: apiWorkCount, total: cells.length },
      snapshot,
      ...(warnings.length ? { warnings } : {}),
      steps,
    };
  } finally {
    await closeBrowser(context);
  }
}
