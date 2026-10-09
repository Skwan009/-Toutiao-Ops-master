import { launchBrowser, closeBrowser } from './browser.js';
import { ensureLoggedIn } from './auth-guard.js';
import { fetchWorks, countersOf, SAFE_PAGE_SIZE } from './works-api.js';

/** 接口条目 → 列表项 */
function toListItem(item) {
  const a = item.article_attr || {};
  const s = item.article_stat || {};
  const counters = countersOf(s);
  return {
    id: a.item_id != null ? String(a.item_id) : '',
    title: a.title || '',
    type: a.type ?? null,
    typeDesc: a.type_desc || '',
    status: a.status ?? null,
    statusDesc: a.status_desc || '',
    visibilityLevel: a.visibility_level ?? null,
    createTime: a.create_time ? new Date(a.create_time * 1000).toISOString() : '',
    stats: {
      impression: s.impression_count ?? counters['展现'] ?? 0,
      read: s.go_detail_count ?? counters['阅读'] ?? 0,
      comment: s.comment_count ?? counters['评论'] ?? 0,
      digg: s.digg_count ?? counters['点赞'] ?? 0,
    },
  };
}

/**
 * 获取作品列表。
 *
 * 走作品列表接口单次拉取（`src/works-api.js`），不再依赖"导航 + 拦截页面请求"：
 * 作品管理页在部分环境下不渲染作品、也不发列表请求，纯拦截会得到空列表。
 *
 * 范围固定为「已发布 + 全部类型」（接口 `status=2&type=0`）；`--limit` 即 `page_size`。
 * 需要按时间范围看数据用 `analytics works`，需要单篇详情用 `analytics content-detail`。
 */
export async function listContent(opts = {}) {
  const parsed = Number.parseInt(opts.limit, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;

  const { context, page } = await launchBrowser(opts);
  try {
    await ensureLoggedIn(page);

    // 固定请求大页再本地截断：小 page_size 会被安全 SDK 拦截
    const data = await fetchWorks(page, { status: 2, type: 0, pageSize: SAFE_PAGE_SIZE });
    const all = (data.contents || []).map(toListItem);
    const items = all.slice(0, limit);

    return {
      schemaVersion: '1.0.0',
      success: true,
      source: 'api_fetch',
      filter: { status: 2, type: 0, limit },
      total: data.total_count ?? null,
      fetched: all.length,
      count: items.length,
      items,
    };
  } finally {
    await closeBrowser(context);
  }
}
