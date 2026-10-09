import { launchBrowser, closeBrowser, browserFetch, sleep } from './browser.js';
import { ensureLoggedIn } from './auth-guard.js';
import { defineSignal } from './signals/base.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, '..', 'config', 'message-types.json');
const WEIGHTS_PATH = join(HERE, '..', 'config', 'weights.json');
const SCHEMA_VERSION = '1.0.0';

// 消息中心接口（POST + JSON，仅依赖登录态 Cookie）
const API = {
  boxes: 'https://mp.toutiao.com/bcs/notice/boxes/?app_id=1231',
  cells: 'https://mp.toutiao.com/bcs/notice/cell/list/?app_id=1231',
};

function loadConfig() {
  const types = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const weights = JSON.parse(readFileSync(WEIGHTS_PATH, 'utf-8'));
  // 合并全局权重分层，供 tier → weight 换算
  return { ...types, tiers: weights.tiers };
}

function toInt(v, dft) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dft;
}

function safeJson(s) {
  if (!s || typeof s !== 'string') return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 页内 POST JSON（自动带真实 Cookie）。
 * 站点安全 SDK 会间歇性拦截自造请求（TypeError: Failed to fetch），故失败退避重试一次。
 * 这些 POST 都是只读查询，重试安全。
 */
async function postJson(page, url, body, retries = 1) {
  let res = null;
  for (let i = 0; i <= retries; i++) {
    try {
      res = await browserFetch(page, url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (res && res.ok) return res;
    } catch {
      res = null;
    }
    if (i < retries) await sleep(1200, 2200);
  }
  return res;
}

/** 拉取分类目录（boxes + pin） */
async function fetchBoxes(page) {
  const res = await postJson(page, API.boxes, {});
  if (!res || !res.ok || !res.data) {
    throw new Error(`获取消息分类失败（status=${res && res.status}）`);
  }
  const d = res.data;
  return {
    boxes: Array.isArray(d.boxes) ? d.boxes : [],
    pin: Array.isArray(d.pin) ? d.pin : [],
    baseResp: d.base_resp || null,
  };
}

/** 拉取某分类的明细，自动翻页直到 has_more=false 或达 maxPages */
async function fetchCells(page, boxType, { limit = 10, maxPages = 5 } = {}) {
  const items = [];
  let cursor = '';
  for (let p = 0; p < maxPages; p++) {
    const res = await postJson(page, API.cells, { box_type: boxType, cursor, limit });
    if (!res || !res.ok || !res.data) break;
    const d = res.data;
    if (Array.isArray(d.cells)) items.push(...d.cells);
    if (!d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  return items;
}

/** 从正文提取话题名：#话题# → 话题 */
function extractTopic(text) {
  if (!text) return '';
  const m = text.match(/#(.+?)#/);
  return m ? m[1] : '';
}

/** 从话题邀请的 rich_span / open_url 提取 forum_id 与发文链接 */
function extractInviteLink(richSpan, openUrl) {
  const out = { url: '', forumId: '' };
  const pick = (u) => {
    if (!u) return;
    const q = u.includes('?') ? u.slice(u.indexOf('?') + 1) : '';
    const p = new URLSearchParams(q);
    if (p.get('forum_id')) out.forumId = p.get('forum_id');
    if (!out.url) out.url = u;
  };
  const rs = safeJson(richSpan);
  if (rs && Array.isArray(rs.links) && rs.links.length) pick(rs.links[0].link);
  if (openUrl) pick(openUrl);
  return out;
}

/** 单条 cell → 统一消息模型 */
function normalizeCell(cell, type, config, includeRaw = false) {
  const logPb = safeJson(cell.log_pb) || {};
  const content = cell.content || {};
  const ref = content.reference || {};
  const body = content.body || {};
  const sender = cell.sender || {};
  const epoch = Number(cell.create_time) || 0;

  const text = body.text || content.title || ref.title || '';
  const isInvite = type.id === 'topic_invite';
  const link = isInvite ? extractInviteLink(body.rich_span, content.open_url) : { url: '', forumId: '' };

  return {
    kind: 'message',
    type: type.id,
    label: type.label,
    channel: type.channel,
    tier: type.tier,
    weight: config.tiers?.[String(type.tier)]?.weight ?? null,
    boxType: type.boxType,
    title: content.title || '',
    text,
    topic: isInvite ? extractTopic(body.text || content.title || '') : '',
    forumId: link.forumId,
    actionUrl: link.url || content.open_url || ref.open_url || '',
    cover: ref.cover?.url || '',
    sender: {
      name: sender.name || '',
      userId: sender.user_id || '',
      relation: sender.relation ?? null,
      relationLabel: config.relationMap?.[String(sender.relation)] || '',
      tags: Array.isArray(sender.tags) ? sender.tags.map((t) => t.description).filter(Boolean) : [],
    },
    createTime: epoch ? new Date(epoch * 1000).toISOString() : '',
    createEpoch: epoch,
    messageType: logPb.message_type || '',
    messageId: logPb.message_id || cell.cell_id || '',
    cellId: cell.cell_id || '',
    mergeCount: cell.merge_count ?? null,
    // 站内接口未提供截止时间，如实标记，供后续接入话题详情后回填
    deadline: null,
    deadlineSource: 'unavailable',
    ...(includeRaw ? { raw: cell } : {}),
  };
}

/** 解析单个 --type 值（支持 id / 中文标签 / box_type 数字 / 别名） */
function resolveType(config, token) {
  const aliased = config.aliases?.[token] || token;
  return config.types.find(
    (t) => t.id === aliased || t.label === token || String(t.boxType) === token
  );
}

/** 解析本次要拉取的分类集合 */
function resolveTargets(config, opts) {
  const types = [...config.types].sort((a, b) => a.order - b.order);
  const byBox = new Map(types.map((t) => [String(t.boxType), t]));
  const out = [];
  const push = (t) => { if (t && !out.some((x) => x.id === t.id)) out.push(t); };

  const rawType = String(opts.type || '').split(',').map((s) => s.trim()).filter(Boolean);
  const rawBox = String(opts.boxType || '').split(',').map((s) => s.trim()).filter(Boolean);

  if (rawType.includes('all') || rawBox.includes('all')) {
    types.forEach(push);
    return out;
  }
  rawType.forEach((s) => push(resolveType(config, s)));
  rawBox.forEach((s) => push(byBox.get(String(Number(s))) || resolveType(config, s)));

  if (out.length) return out;
  // 默认：官方推送五类；--all 时含互动类
  return types.filter((t) => (opts.all ? true : t.channel === 'official'));
}

/** 分组归集（给定 page，供命令与信号源复用） */
async function collectWithPage(page, config, opts) {
  const limit = toInt(opts.limit, 10);
  const maxPages = toInt(opts.maxPages, 5);
  const targets = resolveTargets(config, opts);

  const boxResp = await fetchBoxes(page);
  const boxByType = new Map();
  [...boxResp.boxes, ...boxResp.pin].forEach((b) => boxByType.set(b.box_type, b));

  const messages = [];
  const byType = {};
  const includeRaw = Boolean(opts.raw);
  for (const t of targets) {
    const cells = await fetchCells(page, t.boxType, { limit, maxPages });
    const norm = cells.map((c) => normalizeCell(c, t, config, includeRaw));
    byType[t.id] = norm.length;
    messages.push(...norm);
  }
  messages.sort((a, b) => (b.createEpoch || 0) - (a.createEpoch || 0));

  const categories = [...boxResp.boxes, ...boxResp.pin].map((b) => ({
    boxType: b.box_type,
    title: b.title,
    unread: b.unread_info?.total ?? 0,
    updateTime: b.update_time ? new Date(b.update_time * 1000).toISOString() : '',
    latest: (b.subtitle || '').slice(0, 200),
  }));

  return { targets, categories, messages, byType };
}

/**
 * 拉取站内消息中心推送（话题邀请 / 活动通知 / 作者成长助手 / 系统通知 / 服务通知 等）。
 * 直接调用站内 POST 接口，不依赖页面渲染。
 */
export async function listMessages(opts = {}) {
  const config = loadConfig();
  const { context, page } = await launchBrowser(opts);
  try {
    await ensureLoggedIn(page);
    const { categories, messages, byType, targets } = await collectWithPage(page, config, opts);

    return {
      schemaVersion: SCHEMA_VERSION,
      success: true,
      source: 'api_direct',
      account: opts.account || 'default',
      fetchedAt: new Date().toISOString(),
      requested: targets.map((t) => ({ id: t.id, label: t.label, boxType: t.boxType, tier: t.tier })),
      categories,
      counts: { total: messages.length, byType },
      messages,
    };
  } finally {
    await closeBrowser(context);
  }
}

/** 作为统一信号源暴露（供推荐引擎按接口消费） */
export const signal = defineSignal({
  id: 'message-center',
  meta: { channel: 'official', source: '站内消息中心', tier: 1 },
  collect: async (ctx = {}) => {
    const config = ctx.config || loadConfig();
    // 有共享 page 时复用，否则自行启动浏览器
    if (ctx.page) {
      const { messages } = await collectWithPage(ctx.page, config, ctx.opts || {});
      return messages;
    }
    const { context, page } = await launchBrowser(ctx.opts || {});
    try {
      await ensureLoggedIn(page);
      const { messages } = await collectWithPage(page, config, ctx.opts || {});
      return messages;
    } finally {
      await closeBrowser(context);
    }
  },
});
