import { signal as messageSignal } from './message-center.js';
import { signal as worksSignal } from './signals/works-analytics.js';
import { signal as externalSignal } from './signals/external-hot.js';
import { runPipeline } from './pipeline.js';
import { launchBrowser, closeBrowser } from './browser.js';
import { ensureLoggedIn } from './auth-guard.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * 选题信号统一入口：按 signals.json 逐源拉取，按 weights.json 打上 tier/weight。
 * 一级权重（站内）：message-center / works-analytics；二级权重（站外）：external-hot。
 * 单个源失败不影响其它源；外部源失败即降级（不阻断）。
 *
 * 站内源共用一个浏览器上下文（同一个 page），避免一次调用启动多个浏览器。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNALS_PATH = join(HERE, '..', 'config', 'signals.json');
const WEIGHTS_PATH = join(HERE, '..', 'config', 'weights.json');
const SCHEMA_VERSION = '1.0.0';

// 信号源实现登记：新增源在此加一行（静态导入，不引入动态加载机制）
const REGISTRY = {
  'message-center': messageSignal,
  'works-analytics': worksSignal,
  'external-hot': externalSignal,
};

function loadJson(p) {
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export async function listTopicSignals(opts = {}) {
  const signalsCfg = loadJson(SIGNALS_PATH);
  const weights = loadJson(WEIGHTS_PATH);
  const want = String(opts.source || '').split(',').map((s) => s.trim()).filter(Boolean);

  const selected = (signalsCfg.sources || []).filter(
    (s) => s.enabled !== false && (want.length === 0 || want.includes(s.id))
  );

  const items = [];
  const sources = [];

  // 站内源共用一个浏览器会话；站外源是纯 Node fetch，不需要浏览器
  const needsBrowser = selected.some((s) => REGISTRY[s.id] && s.kind !== 'external');
  let browser = null;
  let browserError = null;
  if (needsBrowser) {
    try {
      browser = await launchBrowser(opts);
      await ensureLoggedIn(browser.page);
    } catch (e) {
      browserError = e;
      if (browser) {
        await closeBrowser(browser.context).catch(() => {});
        browser = null;
      }
    }
  }

  try {
    for (const s of selected) {
      const tier = s.tier ?? 1;
      const weight = weights.tiers?.[String(tier)]?.weight ?? null;
      const impl = REGISTRY[s.id];
      if (!impl) {
        sources.push({ id: s.id, kind: s.kind, tier, weight, error: '未登记实现（REGISTRY）' });
        continue;
      }
      if (s.kind !== 'external' && !browser) {
        sources.push({
          id: s.id, kind: s.kind, tier, weight,
          error: `浏览器会话不可用：${browserError ? browserError.message : '未知原因'}`,
        });
        continue;
      }
      try {
        const got = await impl.collect({ opts, page: browser ? browser.page : undefined });
        // 条目自带 tier（如消息按类型分档）时优先保留，不被信号源整体层级覆盖
        const tagged = got.map((it) => {
          const effTier = it.tier == null ? tier : it.tier;
          return { ...it, tier: effTier, weight: weights.tiers?.[String(effTier)]?.weight ?? null };
        });
        items.push(...tagged);
        sources.push({ id: s.id, kind: s.kind, tier, weight, count: tagged.length });
      } catch (e) {
        sources.push({ id: s.id, kind: s.kind, tier, weight, error: e.message });
      }
    }
  } finally {
    if (browser) await closeBrowser(browser.context).catch(() => {});
  }

  const base = {
    schemaVersion: SCHEMA_VERSION,
    success: true,
    account: opts.account || 'default',
    fetchedAt: new Date().toISOString(),
    sources,
    counts: { total: items.length },
    items,
  };

  // --filter：套用三级漏斗（compliance → domainMatch → dedupe）
  if (opts.filter) {
    const { stages, counts, items: filtered, degraded } = await runPipeline(items, {});
    base.pipeline = { stages, counts, degraded };
    base.counts = { total: filtered.length, beforeFilter: items.length };
    base.items = filtered;
  }

  return base;
}
