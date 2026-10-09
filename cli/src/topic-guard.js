/**
 * 漏斗阶段：域匹配（账号领域 / 栏目匹配）。
 * 域库外置在 data/ 下；指定的真实域库缺失时回退到同名 *.example.json 并标记 degraded。
 * 命中数 ≥ minHits 才保留，命中会写上 item.domains / item.domainHits 供后续打分使用。
 */
export const domainMatch = {
  id: 'domainMatch',
  run(items, ctx) {
    const cfg = ctx.config || {};
    const name = cfg.domains || 'domains.json';
    const loaded = ctx.loadData(name);
    if (!loaded) {
      return { kept: items, dropped: [], degraded: true, reason: `域库缺失（${name}），已跳过域匹配` };
    }

    const domains = loaded.data.domains || {};
    const activeIds = cfg.activeDomains || Object.keys(domains);
    const active = activeIds
      .map((id) => ({ id, ...domains[id] }))
      .filter((d) => Array.isArray(d.keywords) && d.keywords.length);
    if (!active.length) {
      return { kept: items, dropped: [], degraded: loaded.degraded, reason: '域库无生效领域' };
    }

    const minHits = cfg.minHits || 1;
    const kept = [];
    const dropped = [];
    for (const it of items) {
      const text = ctx.itemText(it);
      const matched = [];
      let hits = 0;
      for (const d of active) {
        const h = d.keywords.filter((k) => k && text.includes(k));
        if (h.length) { hits += h.length; matched.push(d.id); }
      }
      if (hits >= minHits) kept.push({ ...it, domains: matched, domainHits: hits });
      else dropped.push({ item: it, reason: 'domain:no_match' });
    }
    return {
      kept,
      dropped,
      degraded: loaded.degraded,
      reason: loaded.degraded ? `真实域库缺失，已回退示例域库 ${loaded.file}` : undefined,
    };
  },
};

/**
 * 漏斗阶段：排重（按标题归一化后去重）。
 */
export const dedupe = {
  id: 'dedupe',
  run(items) {
    const seen = new Set();
    const kept = [];
    const dropped = [];
    for (const it of items) {
      const key = String(it.title || '').replace(/[\s\p{P}]/gu, '').slice(0, 40);
      if (!key) { kept.push(it); continue; }
      if (seen.has(key)) dropped.push({ item: it, reason: 'duplicate' });
      else { seen.add(key); kept.push(it); }
    }
    return { kept, dropped };
  },
};
