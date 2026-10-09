import { launchBrowser, closeBrowser } from '../browser.js';
import { ensureLoggedIn } from '../auth-guard.js';
import { defineSignal } from './base.js';
import { fetchWorks, countersOf } from '../works-api.js';

/**
 * 作品数据信号源（一级权重）——「数据 - 作品数据 / 作品列表」。
 *
 * 数据来自站内接口（返回 text/plain 包裹的 JSON），走 `src/works-api.js` 统一封装：
 *   /mp/agw/creator_center/list/v2?status=2&type=0&page_size=N&need_stat=true&wenda_type=1&app_id=1231
 * 每条含 article_attr.title / type_desc 与 article_stat 的 展现/阅读/评论/点赞。
 */

function normalize(item) {
  const attr = item.article_attr || {};
  const stat = item.article_stat || {};
  const counters = countersOf(stat);
  return {
    kind: 'work',
    source: 'works-analytics',
    title: attr.title || '',
    abstract: attr.abstract || '',
    epoch: attr.create_time || null,
    type: attr.type ?? null,
    typeDesc: attr.type_desc || '',
    stats: {
      impression: stat.impression_count ?? counters['展现'] ?? 0,
      read: stat.go_detail_count ?? counters['阅读'] ?? 0,
      comment: stat.comment_count ?? counters['评论'] ?? 0,
      digg: stat.digg_count ?? counters['点赞'] ?? 0,
      play: stat.play_count ?? 0,
    },
  };
}

async function collectItems(page, opts) {
  const pageSize = Number.parseInt(opts.pageSize, 10) || 50;
  const data = await fetchWorks(page, pageSize);
  return (data.contents || []).map(normalize);
}

export const signal = defineSignal({
  id: 'works-analytics',
  meta: { channel: 'internal', source: '数据-作品数据', tier: 1 },
  collect: async (ctx = {}) => {
    const opts = ctx.opts || {};
    // 有共享 page 时直接复用，避免二次启动浏览器
    if (ctx.page) return collectItems(ctx.page, opts);

    const { context, page } = await launchBrowser(opts);
    try {
      await ensureLoggedIn(page);
      return await collectItems(page, opts);
    } finally {
      await closeBrowser(context);
    }
  },
});
