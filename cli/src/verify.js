import { launchBrowser, closeBrowser, browserFetch, sleep } from './browser.js';
import { ensureLoggedIn } from './auth-guard.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * 发布后四步核验（独立于发布页的即时判定，走站内数据复核）。
 *   1. 草稿箱自检   —— 目标内容若仍在草稿，说明并未真正发布
 *   2. 条数 +1      —— 已发布总数较基线 +1
 *   3. 读 vl        —— 在已发布列表中定位目标作品并读取其状态/数据
 *   4. 正文重复检测 —— 列表内出现重复正文 = 典型的"内容叠加"
 * 状态码等参数外置在 config/verify.json；未配置的阶段跳过并标注。
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

async function fetchList(page, cfg, status) {
  const url = `${cfg.api}?status=${status}&type=0&page_size=${cfg.pageSize || 50}&need_stat=true&wenda_type=1&app_id=${cfg.appId || 1231}`;
  const r = await browserFetch(page, url);
  let d = r && r.data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch {}
  }
  return d || {};
}

function itemTitle(it) {
  const attr = it.article_attr || {};
  return attr.title || (it.content && it.content.title) || '';
}

function toItems(data) {
  return Array.isArray(data.contents) ? data.contents : [];
}

// ── vl（visibilityLevel）读取：兼容 snake_case / camelCase 两种命名 ──
const attrOf = (it) => it.article_attr || it.articleBase || {};
const pickVL = (it) => attrOf(it).visibility_level ?? attrOf(it).visibilityLevel ?? it.visibility_level ?? null;
const pickReview = (it) => attrOf(it).review_info ?? attrOf(it).reviewInfo ?? null;
const pickSuppression = (it) => attrOf(it).suppression_info ?? attrOf(it).suppressionInfo ?? null;

/** itemCounter：刚发布时展现/阅读为 0 属正常 */
function pickCounter(it) {
  const s = it.article_stat || it.itemCounter || {};
  const c = {};
  for (const x of s.counters || []) c[x.Name] = x.Count;
  return {
    impression: s.impression_count ?? c['展现'] ?? 0,
    read: s.go_detail_count ?? c['阅读'] ?? 0,
    comment: s.comment_count ?? c['评论'] ?? 0,
    digg: s.digg_count ?? c['点赞'] ?? 0,
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
  const sc = cfg.statusCodes || {};
  const target = norm(opts.content || opts.title || '');
  const steps = [];
  const { context, page } = await launchBrowser(opts);

  try {
    await ensureLoggedIn(page);
    await sleep(1000, 2000);

    // ── 步骤 1：草稿箱自检 ──
    if (sc.draft == null) {
      steps.push({ id: 'draft_check', skipped: true, reason: '未配置 draft 状态码（config/verify.json）' });
    } else {
      const d = await fetchList(page, cfg, sc.draft);
      const hit = toItems(d).some((it) => norm(itemTitle(it)).includes(target) || target.includes(norm(itemTitle(it))) && target);
      steps.push({
        id: 'draft_check',
        ok: !hit,
        draftCount: toItems(d).length,
        total: d.total_count ?? null,
        reason: hit ? '目标内容仍在草稿箱 —— 实际未发布' : '草稿箱中未发现目标内容',
      });
    }

    // ── 步骤 2：条数 +1 ──
    const published = await fetchList(page, cfg, sc.published ?? 2);
    const currentCount = published.total_count ?? toItems(published).length;
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
      baseline,
      baselineSource,
      current: currentCount,
      skipped: baseline == null,
      reason: baseline == null ? '无基线（可传 --before-count，或先跑一次生成快照）'
        : currentCount === baseline + 1 ? '总数 +1，符合预期' : `总数 ${baseline} → ${currentCount}，未 +1`,
    });

    // ── 步骤 3：读 vl（按标题定位作品 → 读 visibilityLevel → 按值分支）──
    const publishedItems = toItems(published);
    const matched = target
      ? publishedItems.find((it) => norm(itemTitle(it)).includes(target))
      : null;

    if (!matched) {
      steps.push({ id: 'read_vl', ok: null, found: false, reason: '未在已发布列表中匹配到目标内容' });
    } else {
      const vl = pickVL(matched);
      const review = pickReview(matched);
      const suppression = pickSuppression(matched);
      const cls = classifyVL(vl, review, suppression);
      steps.push({
        id: 'read_vl',
        ok: cls.ok,
        found: true,
        matchedTitle: itemTitle(matched).slice(0, 60),
        visibilityLevel: vl,
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
    for (const it of publishedItems) {
      const k = norm(itemTitle(it));
      if (!k) continue;
      groups.set(k, (groups.get(k) || 0) + 1);
    }
    const dups = [...groups.entries()].filter(([, n]) => n > 1).map(([k, n]) => ({ key: k.slice(0, 40), count: n }));
    steps.push({
      id: 'duplicate_check',
      ok: dups.length === 0,
      duplicates: dups,
      reason: dups.length ? `发现 ${dups.length} 组重复内容（疑似内容叠加）` : '未发现重复内容',
    });

    // 落盘本次快照，供下次比对基线
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
