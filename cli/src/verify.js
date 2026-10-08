import { launchBrowser, closeBrowser, browserFetch, sleep, waitForStable, dismissOverlays } from './browser.js';
import { ensureLoggedIn } from './auth-guard.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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
const SNAP_DIR = join(HERE, '..', 'output', 'verify');
const SCHEMA_VERSION = '1.0.0';

function loadCfg() {
  return JSON.parse(readFileSync(CFG_PATH, 'utf-8'));
}

/** 归一化文本，用于比对与排重 */
const norm = (s) => String(s || '').replace(/[\s\p{P}]/gu, '').slice(0, 80);

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
  const target = norm(opts.content || opts.title || '');
  const { context, page } = await launchBrowser(opts);
  const cells = [];
  let total = null;

  // 先挂监听，再导航（拦截管理页作品流）
  page.on('response', async (r) => {
    try {
      if (!r.url().includes(cfg.feedApiMatch)) return;
      const j = await r.json();
      if (j && j.total_number != null) total = j.total_number;
      cells.push(...extractCells(j));
    } catch {}
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
    const inDraft = !emptyDraft && Boolean(target) && norm(draftText).includes(target);
    steps.push({
      id: 'draft_check',
      ok: !inDraft,
      empty: emptyDraft,
      reason: inDraft ? '目标内容仍在草稿箱 —— 实际未发布' : emptyDraft ? '草稿箱为空' : '草稿箱中未发现目标内容',
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

    // ── 步骤 2：条数 +1 ──
    // 作品总数取 creator_center 的 total_count（mp_provider 的 total_number 只是当页条数）
    let currentCount = null;
    try {
      const r = await browserFetch(page, `${cfg.countApi}?status=${cfg.countStatus ?? 2}&type=0&page_size=1&need_stat=true&wenda_type=1&app_id=${cfg.appId ?? 1231}`);
      let d = r && r.data;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
      if (d && d.total_count != null) currentCount = d.total_count;
    } catch {}
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
      ? cells.find((ic) => norm(cellTitle(ic)).includes(target))
      : null;
    if (!matched) {
      steps.push({ id: 'read_vl', ok: null, found: false, scanned: cells.length, reason: '未在作品流中匹配到目标内容（可能未发布，或不在首页）' });
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
    const groups = new Map();
    for (const ic of cells) {
      const k = norm(cellTitle(ic));
      if (!k) continue;
      groups.set(k, (groups.get(k) || 0) + 1);
    }
    const dups = [...groups.entries()].filter(([, n]) => n > 1).map(([k, n]) => ({ key: k.slice(0, 40), count: n }));
    steps.push({
      id: 'duplicate_check',
      ok: dups.length === 0,
      scanned: cells.length,
      duplicates: dups,
      reason: dups.length ? `发现 ${dups.length} 组重复内容（疑似内容叠加）` : '未发现重复内容',
    });

    // 落盘快照，供下次比对基线
    try {
      mkdirSync(SNAP_DIR, { recursive: true });
      writeFileSync(snapFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, account: opts.account || 'default', count: currentCount, at: new Date().toISOString() }, null, 2));
    } catch {}

    const failed = steps.filter((s) => s.ok === false);
    return {
      schemaVersion: SCHEMA_VERSION,
      success: true,
      account: opts.account || 'default',
      verifiedAt: new Date().toISOString(),
      verdict: failed.length === 0 ? 'pass' : 'fail',
      failed: failed.map((s) => s.id),
      steps,
    };
  } finally {
    await closeBrowser(context);
  }
}
