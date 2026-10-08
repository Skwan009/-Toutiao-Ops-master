# 发布后核验

## 概述

发布完成后，**独立于发布页的即时判定**，用站内真实数据复核结果。用于解决"回执说成功、其实没发出去"以及"内容叠加（重复）"等问题。

## 命令

```bash
toutiao-ops verify --content "<正文片段>" [--before-count <n>]
```

## 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--content` | 否* | — | 目标正文片段，用于在作品中定位与比对 |
| `--title` | 否* | — | 目标标题（无 `--content` 时使用） |
| `--before-count` | 否 | — | 发布前的作品总数，用于核对"总数 +1" |
| `--headless` | 否 | false | 无头模式运行 |

\* `--content` / `--title` 至少给一个，否则无法定位目标作品（步骤 1/3 会跳过）。

## 四步核验

| 步骤 | 判定 |
|------|------|
| 1. 草稿箱自检 | 打开草稿箱页（`/profile_v4/manage/draft`）：空或未含目标 → 通过；**含目标 → 实际未发布** |
| 2. 条数 +1 | 作品总数取 `creator_center/list/v2?status=2` 的 `total_count`，与基线 +1 比对 |
| 3. 读 vl | 在作品流中按标题定位 → 读 `articleBase.visibilityLevel` → 按下表分支 |
| 4. 正文重复检测 | 作品流内出现重复正文 = 典型的"内容叠加" |

## vl（visibilityLevel）分支

| `visibilityLevel` | 含义 | 处置 |
|---|---|---|
| `40` | 正常分发 | ✓ 通过 |
| `15` | 受限，看 `reviewInfo` 细分 | `reviewInfo.title === "审核中"` → 审核队列中，**会自愈，勿重发**；`reviewInfo.status === 3` 且 `title` 为空 → **真受限，不会自愈** |
| `45` | 看 `suppressionInfo.reason` | 有值 → **真压制**；`reviewInfo = {}` → 审核过渡态 |
| `60` | 加权 | ✓ 通过 |

步骤 3 同时带出 `itemCounter` 的展现/阅读（**刚发布时为 0 属正常**）。

## 数据来源

| 用途 | 来源 |
|---|---|
| 作品流（vl / reviewInfo / itemCounter / 正文） | 拦截管理页的 `GET /api/feed/mp_provider/v1/`，结构为 `data[].assembleCell.itemCell.{ articleBase, reviewInfo, itemCounter, ... }` |
| 作品总数 | `creator_center/list/v2?status=2` 的 `total_count` |
| 草稿箱 | 页面 `/profile_v4/manage/draft` 的 DOM 文本 |

> ⚠️ 直连 `mp_provider` 会返回 `errno:20100`（缺签名参数），因此一律走**接口拦截**（项目既定范式），不自造请求。
> `articleBase.visibilityLevel` / `itemCell.reviewInfo` / `itemCell.itemCounter` 均为 camelCase。

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
- `pages.content` / `pages.draft` — 作品管理页 / 草稿箱页
- `feedApiMatch` — 作品流接口匹配串
- `maxScrolls` — 滚动加载次数（翻更多作品）
- `countApi` / `countStatus` / `appId` — 总数接口（`status: 2=已发布，0/5/6=全部，4=仅我可见`）

## 用途

- 发布后确认真实分发状态，避免"回执成功但没发出去"
- 区分"审核中（会自愈）"与"真受限（需人工处理）"，避免误重发造成内容叠加
