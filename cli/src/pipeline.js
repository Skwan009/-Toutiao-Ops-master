import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { compliance } from './compliance.js';
import { domainMatch, dedupe } from './topic-guard.js';

/**
 * 过滤漏斗执行器（AGENTS 预留点 #5）。
 * 阶段顺序与参数由 config/pipeline.json 决定；新增阶段需在下方 REGISTRY 登记。
 * 阶段契约：run(items, ctx) → { kept: items[], dropped: [{ item, reason }] }
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(HERE, '..', 'config');
const DATA_DIR = join(HERE, '..', 'data');
const SCHEMA_VERSION = '1.0.0';

// 阶段实现登记：新增阶段在此加一行（静态导入，不引入动态加载）
const REGISTRY = { compliance, domainMatch, dedupe };

/** 统一取文本：兼容 message(title/text) / work(title/abstract) / hot(title) */
const itemText = (it) => [it.title, it.text, it.abstract].filter(Boolean).join(' ');

export async function runPipeline(items, opts = {}) {
  const cfgPath = opts.pipelinePath || join(CONFIG_DIR, 'pipeline.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  const ctx = { itemText, dataDir: DATA_DIR, configDir: CONFIG_DIR, opts };

  let current = items;
  const stages = [];
  for (const s of cfg.stages || []) {
    if (s.enabled === false) { stages.push({ id: s.id, skipped: true }); continue; }
    const impl = REGISTRY[s.id];
    if (!impl) { stages.push({ id: s.id, error: '未登记实现（REGISTRY）' }); continue; }

    const { kept, dropped } = await impl.run(current, { ...ctx, config: s });
    const reasons = {};
    for (const d of dropped) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
    stages.push({ id: s.id, in: current.length, kept: kept.length, dropped: dropped.length, reasons });
    current = kept;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    stages,
    counts: { in: items.length, out: current.length },
    items: current,
  };
}
