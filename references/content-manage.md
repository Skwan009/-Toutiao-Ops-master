# 作品管理

## 概述

通过作品列表接口（`creator_center/list/v2`）单次拉取已发布作品，输出结构化条目。

**为什么不走「导航 + 拦截页面请求」**：作品管理页在部分环境下不渲染作品、也不发列表请求
（实测页面只显示"暂无作品"，全程只有监控埋点，纯拦截会得到空列表）。
该接口经浏览器内 `browserFetch` 调用实测可用，且一次就同时返回总数与明细。

## 命令

```bash
toutiao-ops content list [--limit 20]
```

## 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--limit` | 否 | `20` | 返回条数。实际固定按 `page_size=50` 请求后本地截断 |
| `--headless` | 否 | false | 无头模式运行 |

> `--limit` 为什么不是直接透传 `page_size`：小 `page_size`（实测 5）会被站点安全 SDK 拦截，
> 固定用大页再本地截断更稳。`--limit` 上限即一次接口能返回的条数（本账号实测 30）。

范围固定为「已发布 + 全部类型」（接口 `status=2&type=0`）。不提供 `--type` / `--status` / `--page`：
这些维度的接口编码未经验证，不做臆测透传。需要时间范围看数用 `analytics works`，
需要单篇详情用 `analytics content-detail`。

## 输出

```json
{
  "schemaVersion": "1.0.0",
  "success": true,
  "source": "api_fetch",
  "filter": { "status": 2, "type": 0, "limit": 20 },
  "total": 38,
  "fetched": 30,
  "count": 20,
  "items": [
    {
      "id": "1878386699779080",
      "title": "……",
      "type": 1,
      "typeDesc": "微头条",
      "status": 2,
      "statusDesc": "已发布",
      "visibilityLevel": 40,
      "createTime": "2026-10-07T02:32:32.000Z",
      "stats": { "impression": 1, "read": 0, "comment": 0, "digg": 0 }
    }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `total` | 该筛选下的作品总数（接口 `total_count`） |
| `fetched` | 本次接口实际返回条数 |
| `count` | 截断后返回条数 |
| `items[].visibilityLevel` | 分发状态，含义见 `references/verify.md` 的 vl 分支表 |
| `items[].status` / `statusDesc` | 接口原始状态与文案（本命令固定 `status=2`，故均为已发布） |
