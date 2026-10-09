# 选题推荐

## 概述

把统一信号源（一级站内 + 二级站外）经三级漏斗过滤后加权打分、排序，产出当日的选题清单，输出 JSON（程序消费）、Markdown 摘要（人读）与落盘文件。

## 命令

```bash
toutiao-ops topic-recommend [--top <n>] [--source <ids>] [--no-filter]
```

## 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--top` | 否 | `weights.json` 的 `ranking.topN`（20） | 输出条数 |
| `--source` | 否 | 全部启用源 | 指定信号源：`message-center,works-analytics,external-hot` |
| `--no-filter` | 否 | false | 跳过三级漏斗，直接对全部信号打分 |
| `--allow-degraded` | 否 | false | 漏斗降级时仍继续输出（见下） |
| `--limit` / `--max-pages` | 否 | 10 / 1 | 消息中心的每页数量与每分类翻页数 |
| `--headless` | 否 | false | 无头模式运行 |

## 降级保护

合规词表（`cli/data/blocklist.json`）或领域库（`cli/data/domains.json`）缺失时，漏斗会回退到
同名 `*.example.json`（占位数据），**实际等于没有过滤**。

此时 `topic-recommend` 默认**拒绝输出推荐**：返回 `success: false`、`degradedStages` 与处置建议，
退出码为 1，且不落盘。要按示例数据继续，需显式加 `--allow-degraded`。

配置真实数据文件，或用 `--no-filter` 明确表示"不做过滤"，都可以绕过该保护。

## 打分公式

```
base  = 域命中强度×w.domain + 热度归一×w.heat + 新鲜度×w.fresh
score = base × 层级权重
```

层级作乘数，用于保证站外权重低于站内。

| 分量 | 含义 |
|---|---|
| 域命中强度 | 漏斗 `domainMatch` 的命中数，取 `min(hits/3, 1)` |
| 热度归一 | 站外取 `hot`，作品取"阅读 + 展现/10"，消息取未读；按全体最大值归一 |
| 新鲜度 | `exp(-小时数 / freshHalfLifeHours)`；无时间字段取 0.8 |
| 层级权重 | 一级 ×1.0 / 二级 ×0.5 / 辅助 ×0.2，见 `weights.json` 的 `tiers` |

权重全部外置在 `cli/config/weights.json` 的 `ranking`：

```json
"ranking": {
  "components": { "domain": 0.45, "heat": 0.30, "fresh": 0.25 },
  "tierMode": "multiplier",
  "freshHalfLifeHours": 72,
  "topN": 20
}
```

`tierMode` 支持 `multiplier`（默认，层级作乘数）、`component`（层级作为一个分量）、`strict`（先按层级、再按分数）。

并列时依次比较：域命中数、时间新旧。

## 输出

落盘到 `~/.toutiao-ops/recommend/`，文件名带日期：`topic-recommend_<account>_<YYYY-MM-DD>.json` 与 `.md`。
落盘失败不阻断推荐，但结果里会有 `warnings`，且 `files` 为 `null`。

```json
{
  "schemaVersion": "1.0.0",
  "account": "default",
  "generatedAt": "2026-10-08T00:13:48.077Z",
  "weights": { "components": { "domain": 0.45, "heat": 0.3, "fresh": 0.25 }, "tiers": {} },
  "counts": { "in": 43, "out": 8 },
  "topics": [
    {
      "rank": 1,
      "score": 0.6567,
      "scoreParts": { "domain": 0.45, "heat": 0, "fresh": 0.2067, "tierWeight": 1 },
      "tier": 1, "tierLabel": "一级权重",
      "kind": "work", "source": "微头条",
      "topic": "", "title": "……",
      "domains": ["life", "season"], "domainHits": 3,
      "url": "", "epoch": 1791369152
    }
  ],
  "markdown": "# 选题推荐 …"
}
```

## 示例

```bash
toutiao-ops topic-recommend --top 8
toutiao-ops topic-recommend --source external-hot --no-filter
```

## 用途

- 每天产出一份"当日可写选题范围"（不是标题），站内信号优先、站外热点兜底
- 作为"发布 → 核验 → 数据回流 → 推荐"闭环的一环
