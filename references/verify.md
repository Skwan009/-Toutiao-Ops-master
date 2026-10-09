# 发布后核验

## 概述

发布完成后，独立于发布页的即时判定，用站内真实数据复核结果。用于解决"回执说成功、其实没发出去"以及"内容叠加（重复）"等问题。

## 命令

```bash
toutiao-ops verify --content "<正文片段>" [--before-count <n>]
```

## 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--content` | 否 | — | 目标正文片段，用于在作品中定位与比对 |
| `--title` | 否 | — | 目标标题，无 `--content` 时使用 |
| `--before-count` | 否 | — | 发布前的作品总数，用于核对"总数 +1" |
| `--headless` | 否 | false | 无头模式运行 |

`--content` 与 `--title` 至少提供一个，否则无法定位目标作品，步骤 1 与 3 会跳过。

## 四步核验

| 步骤 | 判定 |
|------|------|
| 1. 草稿箱自检 | 打开草稿箱页 `/profile_v4/manage/draft`。为空或未含目标则通过；含目标说明实际未发布。未传目标内容时本步 `ok: null`（跳过），不会伪报通过 |
| 2. 条数 +1 | 作品总数取 `creator_center/list/v2?status=2` 的 `total_count`，与基线比对 |
| 3. 读 vl | 在作品流中按标题定位，读 `articleBase.visibilityLevel`，按下表分支 |
| 4. 正文重复检测 | 作品流内出现重复正文，即内容叠加 |

## vl（visibilityLevel）分支

| 值 | 含义 | 处置 |
|---|---|---|
| `40` | 正常分发 | 通过 |
| `15` | 受限，看 `reviewInfo` 细分 | `reviewInfo.title === "审核中"`：审核队列中，会自愈，勿重发；`reviewInfo.status === 3` 且 `title` 为空：真受限，不会自愈 |
| `45` | 看 `suppressionInfo.reason` | 有值：真压制；`reviewInfo = {}`：审核过渡态 |
| `60` | 加权 | 通过 |

步骤 3 同时带出 `itemCounter` 的展现 / 阅读；刚发布时为 0 属正常。

## 数据来源

| 用途 | 来源 |
|---|---|
| 作品流（vl / itemCounter / 正文） | **主**：`creator_center/list/v2?status=2&type=0&page_size=50` 的 `contents[]`（`article_attr.visibility_level` / `status_desc` / `verify_reason`）<br>**辅**：拦截管理页的 `GET /api/feed/mp_provider/v1/`（`data[].assembleCell.itemCell.{ articleBase, reviewInfo, itemCounter }`） |
| 作品总数 | 同一次 `creator_center/list/v2` 响应里的 `total_count` |
| 草稿箱 | 页面 `/profile_v4/manage/draft` 的文本 |

两路数据按 `articleBase.itemId`（无则回退 title）合并去重；返回值里的 `workSources`
给出 `{ intercepted, api, total }` 三个计数，便于判断本次核验是否真的拿到了数据。

> ⚠️ 同一页面内自造请求只有第一条能成功（站点安全 SDK 会拦截后续请求），
> 所以「总数」和「作品明细」必须合并成一次请求——不要再拆成两次。

若两路都没拿到作品（`workSources.total === 0`），`read_vl` 与 `duplicate_check` 会报
`ok: null`（跳过）而不是"通过"，`verdict` 也会因此变成 `inconclusive`。

直连 `mp_provider` 会返回 `errno:20100`（缺签名参数），因此走管理页的接口拦截，不自造请求。`articleBase.visibilityLevel`、`itemCell.reviewInfo`、`itemCell.itemCounter` 均为 camelCase。

## 结论（verdict）

| 值 | 含义 |
|---|---|
| `pass` | 至少一步给出了明确通过，且没有任何步骤失败 |
| `fail` | 有步骤明确失败（`ok: false`），退出码为 1 |
| `inconclusive` | 所有步骤都没有结论（如未传 `--content/--title`、无基线），**不代表通过** |

步骤级 `ok` 三态：`true` 通过 / `false` 失败 / `null` 跳过（含 `skipped: true`）。

顶层还含：`skipped`（跳过的步骤 id）、`snapshot`（本次写入的基线快照路径）、
`warnings`（如快照写入失败、作品流响应未在 8 秒内返回完）。

> 基线快照落在 `~/.toutiao-ops/verify/<account>.json`（不写包内目录）。

## 输出示例

```json
{
  "schemaVersion": "1.0.0",
  "success": true,
  "verdict": "fail",
  "failed": ["read_vl"],
  "steps": [
    { "id": "draft_check", "ok": true, "empty": true, "reason": "草稿箱为空" },
    { "id": "count_plus_one", "ok": true, "baseline": 37, "current": 38, "reason": "总数 +1，符合预期" },
    {
      "id": "read_vl",
      "ok": false,
      "visibilityLevel": 15,
      "itemStatus": 20,
      "verdict": "restricted",
      "selfHealing": false,
      "reviewInfo": { "status": 3, "title": "" },
      "itemCounter": { "show": 1, "read": 0, "comment": 0, "digg": 0, "repin": 0 },
      "reason": "真受限，不会自愈"
    },
    { "id": "duplicate_check", "ok": true, "scanned": 10, "duplicates": [] }
  ]
}
```

## 配置

`cli/config/verify.json`：

| 键 | 说明 |
|---|---|
| `pages.content` / `pages.draft` | 作品管理页 / 草稿箱页 |
| `feedApiMatch` | 作品流接口匹配串 |
| `maxScrolls` | 滚动加载次数 |
| `countApi` / `countStatus` / `appId` | 总数接口，`status`：2=已发布，0/5/6=全部，4=仅我可见 |

## 用途

- 发布后确认真实分发状态，避免"回执成功但没发出去"
- 区分"审核中（会自愈）"与"真受限（需人工处理）"，避免误重发造成内容叠加
