/**
 * 作品列表接口封装（`creator_center/list/v2`）。
 *
 * 为什么自建这一层：
 * - 作品管理页在部分环境下**不渲染作品、也不发列表请求**，纯拦截拿不到数据；
 * - 该接口经 `browserFetch` 单次调用**实测可用**，且一次就同时返回「总数 + 作品明细」。
 *
 * ⚠️ 调用约束：同一页面内自造请求**只有第一条能成功**（站点安全 SDK 会拦截后续请求，
 * 返回 `TypeError: Failed to fetch`）。因此本模块只做单次请求，调用方必须把需要的
 * 字段（total_count / contents）从这一次响应里一次取全，不要再补第二次请求。
 */
import { browserFetch, sleep } from './browser.js';

const DEFAULT_APP_ID = 1231;
const DEFAULT_STATUS = 2; // 2=已发布
/** 实测安全的每页条数。小 page_size（如 5）会被站点安全 SDK 拦截，统一用大值再本地截断 */
export const SAFE_PAGE_SIZE = 50;

/** 构造作品列表接口 URL */
export function buildWorksUrl({ status = DEFAULT_STATUS, type = 0, pageSize = 50, appId = DEFAULT_APP_ID } = {}) {
  const q = new URLSearchParams({
    status: String(status),
    type: String(type),
    page_size: String(pageSize),
    need_stat: 'true',
    wenda_type: '1',
    app_id: String(appId),
  });
  return `https://mp.toutiao.com/mp/agw/creator_center/list/v2?${q.toString()}`;
}

/**
 * 单次拉取作品列表。失败退避重试一次（站点偶发拦截）。
 *
 * @param {object} page Playwright page
 * @param {object} opts { status, type, pageSize, appId }
 * @returns {Promise<object>} 解析后的响应体（含 `total_count` / `contents`）
 */
export async function fetchWorks(page, opts = {}) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await browserFetch(page, buildWorksUrl(opts));
      let data = res && res.data;
      // 该接口返回 text/plain 包裹的 JSON
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { data = null; }
      }
      if (!res || !res.ok) {
        const err = new Error(`作品列表接口返回异常（status=${res && res.status}）`);
        err.res = res;
        throw err;
      }
      return data || {};
    } catch (e) {
      lastErr = e;
      if (i === 0) await sleep(1500, 2500);
    }
  }
  throw lastErr;
}

/** `article_stat.counters` → { 展现/阅读/评论/点赞 } 映射 */
export function countersOf(stat) {
  const out = {};
  for (const c of (stat && stat.counters) || []) out[c.Name] = c.Count;
  return out;
}
