import { defineSignal } from './base.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * 外部热点信号源（二级权重）——纯 Node fetch，不用浏览器。
 *
 * - 数据源来自 config/providers.json（数组，可插拔）
 * - 同源 30 分钟缓存；429 熔断；失败降级下一个源；全失败返回空且标记 degraded（不阻断主流程）
 */
const HERE = dirname(fileURLToPath(import.meta.url));            // cli/src/signals
const CONFIG_PATH = join(HERE, '..', '..', 'config', 'providers.json');
const CACHE_DIR = join(HERE, '..', '..', 'output', 'cache');
const SCHEMA_VERSION = '1.0.0';

function loadProviders() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function getPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function fetchJson(url, cfg) {
  const timeoutMs = cfg.timeoutMs || 8000;
  const retries = cfg.retries ?? 3;
  const backoffMs = cfg.backoffMs || [1000, 3000, 9000];
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; toutiao-ops)' },
      });
      clearTimeout(timer);
      if (res.status === 429) {
        const e = new Error('HTTP 429 限流');
        e.rateLimited = true;
        throw e;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e.rateLimited) throw e;
      if (i < retries) await new Promise((r) => setTimeout(r, backoffMs[Math.min(i, backoffMs.length - 1)]));
    }
  }
  throw lastErr;
}

function readCache(file, minutes) {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf-8'));
    const ageMin = (Date.now() - new Date(j.fetchedAt).getTime()) / 60000;
    if (ageMin <= minutes && Array.isArray(j.items) && j.items.length) return j.items;
  } catch {}
  return null;
}

function writeCache(file, items) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, fetchedAt: new Date().toISOString(), items }, null, 2));
  } catch {}
}

function normalizeItem(raw, p, i) {
  const fm = p.fieldMap || {};
  const pick = (k) => (fm[k] ? getPath(raw, fm[k]) : undefined);
  return {
    kind: 'hot',
    source: p.id,
    platform: p.platform || '',
    tier: p.tier ?? 2,
    rank: pick('rank') ?? (i + 1),
    title: String(pick('title') ?? '').trim(),
    hot: Number(pick('hot')) || 0,
    url: pick('url') || '',
  };
}

/**
 * 按 providers 顺序拉取，首个成功即返回；全失败返回 { items:[], degraded:true }（不抛错）。
 */
export async function collectHot(opts = {}) {
  const cfg = loadProviders();
  const cacheMinutes = opts.cacheMinutes ?? cfg.cacheMinutes ?? 30;
  const errors = [];
  const providers = (cfg.providers || []).filter((p) => p.enabled !== false);

  for (const p of providers) {
    const cacheFile = join(CACHE_DIR, `external-hot_${p.id}.json`);
    const cached = readCache(cacheFile, cacheMinutes);
    if (cached) return { items: cached, source: p.id, cached: true, errors };

    try {
      const json = await fetchJson(p.url, cfg);
      const list = getPath(json, p.listPath) || [];
      const items = list.map((raw, i) => normalizeItem(raw, p, i)).filter((it) => it.title);
      if (!items.length) throw new Error('返回空列表'); // 空列表不覆盖上次有效缓存
      writeCache(cacheFile, items);
      return { items, source: p.id, cached: false, errors };
    } catch (e) {
      errors.push(`${p.id}: ${e.message}`);
      if (e.rateLimited) break; // 429 熔断，今日不再尝试其它源
    }
  }
  return { items: [], source: null, degraded: true, errors };
}

export const signal = defineSignal({
  id: 'external-hot',
  meta: { channel: 'external', source: '外部热点（第三方聚合）', tier: 2 },
  collect: async (ctx = {}) => (await collectHot(ctx.opts || {})).items,
});
