import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 漏斗阶段：合规过滤（违禁 / 敏感 / 绝对化用语 / 医疗夸大）。
 * 词表外置在 data/ 下（示例 blocklist.example.json）。
 * 词表缺失时一律放行（不误杀）。
 */
export const compliance = {
  id: 'compliance',
  run(items, ctx) {
    const cfg = ctx.config || {};
    let blocklist;
    try {
      blocklist = JSON.parse(readFileSync(join(ctx.dataDir, cfg.blocklist || 'blocklist.example.json'), 'utf-8'));
    } catch {
      return { kept: items, dropped: [] };
    }

    const active = cfg.categories || Object.keys(blocklist.categories || {});
    const rules = [];
    for (const [cat, def] of Object.entries(blocklist.categories || {})) {
      if (def.enabled === false || !active.includes(cat)) continue;
      for (const w of def.words || []) if (w) rules.push({ cat, w });
    }
    if (!rules.length) return { kept: items, dropped: [] };

    const kept = [];
    const dropped = [];
    for (const it of items) {
      const text = ctx.itemText(it);
      const hit = rules.find((r) => text.includes(r.w));
      if (hit) dropped.push({ item: it, reason: `blocklist:${hit.cat}:${hit.w}` });
      else kept.push(it);
    }
    return { kept, dropped };
  },
};
