# 发布后核验

## 概述

发布完成后，**独立于发布页的即时判定**，用站内作品/草稿数据复核结果。用于解决"回执说成功、其实没发出去"以及"内容叠加（重复）"等问题。

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

\* `--content` / `--title` 至少给一个，否则无法定位目标作品。

## 四步核验

| 步骤 | 判定 |
|------|------|
| 1. 草稿箱自检 | 目标内容若**仍在草稿箱** → 实际未发布（`draft` 状态码需在 `config/verify.json` 配置，未配则跳过并标注） |
| 2. 条数 +1 | 已发布总数较基线 **+1**。基线取自 `--before-count`，或上次运行落盘的快照 |
| 3. 读 vl | 按标题定位目标作品 → 读 `visibilityLevel` → 按下表分支 |
| 4. 正文重复检测 | 列表内出现重复正文 = 典型的"内容叠加" |

## vl（visibilityLevel）分支

| `visibilityLevel` | 含义 | 处置 |
|---|---|---|
| `40` | 正常分发 | ✓ 通过 |
| `15` | 受限，看 `reviewInfo` 细分 | `reviewInfo.title === "审核中"` → 审核队列中，**会自愈，勿重发**；`reviewInfo.status === 3` 且 `title` 为空 → **真受限，不会自愈** |
| `45` | 看 `suppressionInfo.reason` | 有值 → **真压制**；`reviewInfo = {}` → 审核过渡态 |
| `60` | 加权 | ✓ 通过 |

步骤 3 同时带出 `itemCounter` 的展现/阅读（**刚发布时为 0 属正常**）。

## 输出示例

```json
{
  "schemaVersion": "1.0.0",
  "success": true,
  "verdict": "pass",
  "failed": [],
  "steps": [
    { "id": "draft_check", "skipped": true, "reason": "未配置 draft 状态码" },
    { "id": "count_plus_one", "ok": true, "baseline": 37, "current": 38 },
    {
      "id": "read_vl",
      "ok": true,
      "visibilityLevel": 40,
      "verdict": "normal",
      "itemCounter": { "impression": 0, "read": 0, "comment": 0, "digg": 0 },
      "reason": "正常分发"
    },
    { "id": "duplicate_check", "ok": true, "duplicates": [] }
  ]
}
```

## 配置

`cli/config/verify.json`：接口地址、分页大小、各状态码（`published` / `draft` / `reviewing` / `rejected`）。
状态码需按站内接口实际语义填写；为 `null` 的步骤会跳过并在结果中标注 `skipped`。

## 用途

- 发布后确认真实分发状态，避免"回执成功但没发出去"
- 区分"审核中（会自愈）"与"真受限（需人工处理）"，避免误重发造成内容叠加
