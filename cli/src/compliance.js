/**
 * 漏斗阶段：合规过滤（违禁 / 敏感 / 绝对化用语 / 医疗夸大）。
 * 词表外置在 data/ 下；指定的真实词表缺失时回退到同名 *.example.json 并标记 degraded。
 *
 * 注意：示例词表是占位词，回退后实际等于"没有过滤"。本阶段只负责如实上报 degraded，
 * 由调用方决定如何处置——topic-recommend 默认在 degraded 时拒绝输出推荐。
 * 两者都缺失时才真正跳过。
 */
export const compliance = {
  id: 'compliance',
  run(items, ctx) {
    const cfg = ctx.config || {};
    const name = cfg.blocklist || 'blocklist.json';
    const loaded = ctx.loadData(name);
    if (!loaded) {
      return { kept: items, dropped: [], degraded: true, reason: `词表缺失（${name}），已跳过合规过滤` };
    }

    const blocklist = loaded.data;
    const active = cfg.categories || Object.keys(blocklist.categories || {});
    const rules = [];
    for (const [cat, def] of Object.entries(blocklist.categories || {})) {
      if (def.enabled === false || !active.includes(cat)) continue;
      for (const w of def.words || []) if (w) rules.push({ cat, w });
    }
    if (!rules.length) {
      return { kept: items, dropped: [], degraded: loaded.degraded, reason: '词表无生效分类' };
    }

    const kept = [];
    const dropped = [];
    for (const it of items) {
      const text = ctx.itemText(it);
      const hit = rules.find((r) => text.includes(r.w));
      if (hit) dropped.push({ item: it, reason: `blocklist:${hit.cat}:${hit.w}` });
      else kept.push(it);
    }
    return {
      kept,
      dropped,
      degraded: loaded.degraded,
      reason: loaded.degraded ? `真实词表缺失，已回退示例词表 ${loaded.file}` : undefined,
    };
  },
};
