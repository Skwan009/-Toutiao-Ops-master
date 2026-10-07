# 消息中心

## 概述

拉取头条号创作者后台「消息中心」的官方推送与互动消息，结构化输出话题邀请、活动通知、作者成长助手、系统通知、服务通知、评论和@、点赞、粉丝等内容。

采用**直接调用站内接口**（POST + JSON，仅依赖登录态），不依赖页面渲染，比 DOM 抓取稳定。

## 命令

```bash
toutiao-ops message-center [--type <type>] [--box-type <n>] [--all]
```

## 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `--type` | 否 | 官方五类 | 分类，支持语义名 / 中文 / 逗号分隔多个，如 `topic_invite,activity_notice`；`all` 表示全部 |
| `--box-type` | 否 | — | 直接按 `box_type` 数字指定，逗号分隔，如 `1025,1022` |
| `--all` | 否 | false | 包含互动类（评论和@ / 点赞 / 粉丝） |
| `--limit` | 否 | 10 | 每个分类每页数量 |
| `--max-pages` | 否 | 5 | 每个分类最多翻页数 |
| `--raw` | 否 | false | 额外输出原始 cell 数据（体积较大） |
| `--headless` | 否 | false | 无头模式运行 |

## 分类（box_type）对照

| box_type | 语义名 | 分类 | 通道 | 权重层级 |
|---|---|---|---|---|
| 1025 | `topic_invite` | 话题邀请 | official | 一级 |
| 1026 | `growth_assistant` | 作者成长助手 | official | 一级 |
| 1022 | `activity_notice` | 活动通知 | official | 一级 |
| 1023 | `system_notice` | 系统通知 | official | 辅助 |
| 1306 | `service_notice` | 服务通知 | official | 辅助 |
| 1008 | `comment_at` | 评论和@ | interact | 辅助 |
| 1005 | `digg` | 点赞 | interact | 辅助 |
| 1002 | `fans` | 粉丝 | interact | 辅助 |

## 数据来源（站内接口）

| 接口 | 方法 | 请求体 | 作用 |
|------|------|--------|------|
| `/bcs/notice/boxes/?app_id=1231` | POST | `{}` | 分类目录（box_type / 标题 / 未读数 / 最新内容） |
| `/bcs/notice/cell/list/?app_id=1231` | POST | `{"box_type":1025,"cursor":"","limit":10}` | 某分类的消息明细，`cursor` + `limit` 翻页 |

## 输出字段（messages[]）

| 字段 | 说明 |
|------|------|
| `type` / `label` | 语义名 / 中文名 |
| `channel` | `official`（官方推送）/ `interact`（互动） |
| `tier` / `weight` | 权重层级与数值（见 `config/message-types.json`） |
| `title` | 动作文案（如「赞了我的微头条」） |
| `text` | 正文（话题邀请为完整邀请文案） |
| `topic` | 话题名（仅话题邀请，从 `#话题#` 提取） |
| `forumId` | 话题 forum_id（仅话题邀请） |
| `actionUrl` | 跳转/发文链接（`sslocal://` 协议） |
| `sender` | 发送者 `{ name, userId, relation, relationLabel, tags }` |
| `createTime` / `createEpoch` | 消息时间（ISO / 秒级时间戳） |
| `deadline` / `deadlineSource` | 截止时间。站内接口未提供，固定为 `null` / `unavailable` |
| `messageType` | 站内消息类型（来自 `log_pb.message_type`） |

## 示例

```bash
# 默认：官方推送五类
toutiao-ops message-center

# 只看话题邀请
toutiao-ops message-center --type topic_invite

# 等价写法（中文 / 数字）
toutiao-ops message-center --type 话题邀请
toutiao-ops message-center --box-type 1025

# 含互动类，每类翻 3 页
toutiao-ops message-center --all --max-pages 3
```

## 输出示例

```json
{
  "schemaVersion": "1.0.0",
  "success": true,
  "source": "api_direct",
  "account": "default",
  "categories": [
    { "boxType": 1025, "title": "话题邀请", "unread": 6, "updateTime": "2026-10-07T10:05:35.000Z" }
  ],
  "counts": { "total": 10, "byType": { "topic_invite": 10 } },
  "messages": [
    {
      "type": "topic_invite",
      "label": "话题邀请",
      "tier": 1,
      "topic": "能送给我一句处在低谷期激励的话吗",
      "forumId": "1685142752047165",
      "createTime": "2026-10-07T10:05:35.000Z"
    }
  ]
}
```

## 用途

- 结构化获取平台官方推送，不再依赖 `innerText` 截断
- 抓取话题邀请的 `topic` / `forumId`，直接对接发文
- 作为推荐引擎的一级权重信号源（见 `src/signals/base.js`）
