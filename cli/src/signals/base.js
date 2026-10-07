/**
 * 统一信号源接口（AGENTS 预留点 #4，最关键的一条）
 *
 * 约定：任何信号源实现 `{ id, collect(ctx) → items[] }`
 *   - id           信号源唯一标识（字符串）
 *   - collect(ctx) 异步返回归一化后的条目数组
 *   - ctx          由调度方注入，字段按需取用：
 *                  { page, account, config, opts, fetchJson }
 *
 * 站内消息（message-center）与站外热榜（external-hot）都应实现本接口，
 * 推荐引擎只认接口、不认具体来源。
 */
export function defineSignal({ id, collect, meta = {} }) {
  if (!id || typeof collect !== 'function') {
    throw new Error('信号源必须提供 id 与 collect 函数');
  }
  return Object.freeze({ id, collect, meta });
}
