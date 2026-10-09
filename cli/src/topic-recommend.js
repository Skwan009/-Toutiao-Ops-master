import { listTopicSignals } from './topic-signals.js';
import { runPipeline } from './pipeline.js';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BASE_DIR } from './paths.js';

/**
 * 选题推荐：把统一信号源（一级/二级）经漏斗过滤后加权打分、排序，输出三件套。
 *
 * score = 域命中强度×w.domain + 热度归一×w.heat + 新鲜度×w.fresh + 层级权重×w.tier
 * 权重全部外置在 config/weights.json 的 ranking.components。
 *
 * 输出：JSON（程序消费）+ Markdown 摘要（人读）+ 落盘到 ~/.toutiao-ops/recommend/（文件名带日期）。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WEIGHTS_PATH = join(HERE, '..', 'config', 'weights.json');
// 运行时产物写 ~/.toutiao-ops/，不写包内（全局安装后 node_modules 通常只读）
const OUT_DIR = join(BASE_DIR, 'recommend');
const SCHEMA_VERSION = '1.0.0';

// 只对有限数值做四舍五入：domain 在"漏斗未跑"时会被置为 null，直接 toFixed 会抛错
const round = (o) => Object.fromEntries(
  Object.entries(o).map(([k, v]) => [k, typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(4)) : v])
);

/** 原始热度：站外取 hot，作品取阅读/展现，消息取未读（均无则 0） */
function heatRaw(it) {
  if (typeof it.hot === 'number' && it.hot > 0) return it.hot;
  if (it.stats) {
    const show = it.stats.impression ?? it.stats.show ?? 0;
    return (it.stats.read || 0) + show / 10;
  }
  if (typeof it.unread === 'number') return it.unread;
  return 0;
}

const epochOf = (it) => it.createEpoch || it.publishTime || it.epoch || 0;

function scoreItems(items, { components, halfLifeHours, tiers, tierMode }) {
  const maxHeat = Math.max(1, ...items.map(heatRaw));
  const now = Date.now() / 1000;

  return items
    .map((it) => {
      const domain = Math.min((it.domainHits || 0) / 3, 1);
      const heat = heatRaw(it) / maxHeat;
      const e = epochOf(it);
      const fresh = e ? Math.exp(-((now - e) / 3600) / halfLifeHours) : 0.8;
      const tierWeight = tiers?.[String(it.tier)]?.weight ?? 0.5;

      // 域命中分量仅在漏斗写入过 domainHits 时可用；不可用时按剩余分量重新归一，
      // 避免最高权重分量恒为 0 导致打分退化成"热度 + 新鲜度"。
      const hasDomain = typeof it.domainHits === 'number';
      const parts = {};
      let wsum = 0;
      if (hasDomain) { parts.domain = domain * components.domain; wsum += components.domain; }
      parts.heat = heat * components.heat; wsum += components.heat;
      parts.fresh = fresh * components.fresh; wsum += components.fresh;

      const norm = wsum > 0 ? wsum : 1;
      const base = Object.values(parts).reduce((s, v) => s + v, 0) / norm;
      // 层级作乘数：保证站外（二级 0.5）整体低于站内（一级 1.0）
      const score = tierMode === 'component' ? base + tierWeight * 0.2 : base * tierWeight;

      const normalized = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v / norm]));
      return {
        score: Number(score.toFixed(4)),
        scoreParts: round({ ...normalized, ...(hasDomain ? {} : { domain: null }), tierWeight }),
        tier: it.tier ?? null,
        tierLabel: tiers?.[String(it.tier)]?.label || '',
        kind: it.kind || '',
        source: it.label || it.typeDesc || it.platform || it.source || '',
        topic: it.topic || '',
        title: (it.topic || it.title || it.text || it.abstract || '').replace(/\s+/g, ' ').slice(0, 80),
        domains: it.domains || [],
        domainHits: it.domainHits || 0,
        url: it.actionUrl || it.url || '',
        epoch: e || null,
      };
    })
    // 并列时依次比较：域命中数 → 时间新旧
    .sort((a, b) =>
      tierMode === 'strict'
        // tier 可能为 null，直接相减会得到 NaN 使排序失效
        ? ((a.tier ?? 99) - (b.tier ?? 99)) || (b.score - a.score) || (b.domainHits - a.domainHits) || ((b.epoch || 0) - (a.epoch || 0))
        : (b.score - a.score) || (b.domainHits - a.domainHits) || ((b.epoch || 0) - (a.epoch || 0))
    )
    .map((x, i) => ({ rank: i + 1, ...x }));
}

function renderMarkdown(topics, meta) {
  const lines = [];
  lines.push(`# 选题推荐 · ${meta.account}`);
  lines.push('');
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- 信号总量：${meta.counts.in}（过滤后参与排序）→ 输出 ${meta.counts.out}`);
  const c = meta.weights.components;
  const tierText = Object.entries(meta.weights.tiers || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, t]) => `${t.label} ×${t.weight}`)
    .join(' / ');
  lines.push(`- 打分权重：域命中 ${c.domain} / 热度 ${c.heat} / 新鲜度 ${c.fresh}；层级作乘数（${tierText || '见 weights.json'}）`);
  lines.push('');
  lines.push('| # | 得分 | 层级 | 来源 | 选题 / 主题 | 命中领域 |');
  lines.push('|---|------|------|------|------|------|');
  for (const t of topics) {
    const domains = (t.domains || []).join('/') || '-';
    lines.push(`| ${t.rank} | ${t.score} | ${t.tierLabel || t.tier} | ${t.source} | ${t.title.replace(/\|/g, '/')} | ${domains} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function recommendTopics(opts = {}) {
  const weights = JSON.parse(readFileSync(WEIGHTS_PATH, 'utf-8'));
  const ranking = weights.ranking || {};
  // 缺省值与 config/weights.json 保持一致，避免配置丢失时打分口径漂移
  const components = ranking.components || { domain: 0.45, heat: 0.3, fresh: 0.25 };
  const topN = Number(opts.top) || ranking.topN || 20;
  const account = opts.account || 'default';
  const generatedAt = new Date().toISOString();
  const useFilter = opts.filter !== false;
  const warnings = [];

  // 0. 降级预检：真实词表/域库缺失时，合规与域匹配会回退到 *.example.json（占位数据），
  //    实际等于没过滤。先判定再决定是否值得启动浏览器，默认拒绝输出推荐。
  const degradedStages = [];
  if (useFilter) {
    const pre = await runPipeline([], {});
    for (const s of pre.stages || []) if (s.degraded) degradedStages.push(s.id);
    if (degradedStages.length && !opts.allowDegraded) {
      return {
        schemaVersion: SCHEMA_VERSION,
        success: false,
        account,
        generatedAt,
        files: null,
        degradedStages,
        error: `过滤漏斗降级（${degradedStages.join(', ')}）：真实数据文件缺失，已回退示例数据，等于未过滤。`
          + '请先在 cli/data/ 放置真实 blocklist.json / domains.json，或加 --allow-degraded 显式确认按示例数据继续（亦可用 --no-filter 跳过漏斗）。',
      };
    }
  }

  // 1. 收集信号（默认套用三级漏斗过滤；--no-filter 时跳过）
  const signals = await listTopicSignals({ ...opts, filter: useFilter });
  const items = signals.items || [];

  // 2. 打分排序
  const scored = scoreItems(items, {
    components,
    halfLifeHours: ranking.freshHalfLifeHours || 72,
    tiers: weights.tiers,
    tierMode: ranking.tierMode || 'multiplier',
  });
  const topics = scored.slice(0, topN);

  // 3. 落盘三件套（失败不阻断推荐，但要如实上报，不再静默吞错）
  const date = generatedAt.slice(0, 10);
  const baseName = `topic-recommend_${account}_${date}`;
  const meta = { account, generatedAt, weights: { components, tiers: weights.tiers }, counts: { in: items.length, out: topics.length } };
  const markdown = renderMarkdown(topics, meta);

  let files = null;
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    const jsonFile = join(OUT_DIR, `${baseName}.json`);
    const mdFile = join(OUT_DIR, `${baseName}.md`);
    writeFileSync(jsonFile, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...meta, sources: signals.sources, pipeline: signals.pipeline || null, topics }, null, 2));
    writeFileSync(mdFile, markdown);
    files = { json: jsonFile, md: mdFile };
  } catch (e) {
    warnings.push(`推荐结果落盘失败（${OUT_DIR}）：${e.message}`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    success: true,
    account,
    generatedAt,
    files,
    ...(warnings.length ? { warnings } : {}),
    degradedStages,
    sources: signals.sources,
    weights: { components, tiers: weights.tiers },
    counts: { in: items.length, out: topics.length },
    topics,
    markdown,
  };
}
