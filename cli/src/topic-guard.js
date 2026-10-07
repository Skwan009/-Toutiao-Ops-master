import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * 漏斗阶段：域匹配（账号领域/栏目匹配）。
 * 域库外置在 data/ 下（示例 domains.example.json）；命中数 ≥ minHits 才保留，
 * 命中会写上 item.domains / item.domainHits，供后续加权排序使用。
 */
export const domainMatch = {
  id: 'domainMatch',
  run(items, ctx) {
    const cfg = ctx.config || {};
    let domains;
    try {
      domains = JSON.parse(readFileSync(join(ctx.dataDir, cfg.domains || 'domains.example.json'), 'utf-8')).domains || {};
    } catch {
      return { kept: items, dropped: [] };
    }

    const activeIds = cfg.activeDomains || Object.keys(domains);
    const active = activeIds
      .map((id) => ({ id, ...domains[id] }))
      .filter((d) => Array.isArray(d.keywords) && d.keywords.length);
    if (!active.length) return { kept: items, dropped: [] };

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
    return { kept, dropped };
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
