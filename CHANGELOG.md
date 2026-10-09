# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## [Unreleased]

自上游快照 `de89bba`（v1.1.4）以来的改动。

### 新增

- `message-center`：直连站内接口拉取消息中心推送（话题邀请 / 活动通知 / 作者成长助手 / 系统通知 / 服务通知 / 互动消息）
- 选题信号与推荐：`topic-signals`（按 `weights.json` 打层级权重）、`topic-recommend`（三级漏斗 + 加权排序 + 三件套输出）
- `verify`：发布后四步核验（草稿箱自检 / 条数 +1 / 读取 vl / 正文重复检测）
- `cli/src/paths.js`：运行时产物统一写 `~/.toutiao-ops/`
- `cli/src/works-api.js`：作品列表接口统一封装
- 离线冒烟测试 `cli/test/smoke.mjs`（20 项）与 `npm test`
- CI 工作流 `.github/workflows/ci.yml`；发布流程增加测试门禁
- 工程文件：`LICENSE`（MIT 全文 + 上游署名）、`CONTRIBUTING.md`、`SECURITY.md`、`.editorconfig`、`.gitattributes`、`Makefile`
- 文档：`references/message-center.md`、`references/verify.md`、`references/topic-recommend.md`

### 修复

- `topic-recommend`：`scoreParts` 对 `null` 调用 `toFixed`，导致 `--no-filter` 下推荐直接崩溃
- `topic-signals`：条目自带的 `tier` 被信号源层级覆盖，系统 / 服务通知的辅助权重失效
- `verify`：未提供目标内容时步骤 1 / 3 伪报通过；重复检测在扫描 0 条时假通过；未等待在途响应即关闭浏览器；跨源取到的同一篇作品被误判为「内容叠加」
- `content list`：原先恒返回空列表（作品管理页在部分环境下不渲染作品、也不发列表请求）
- `publish article`：`--cover` 必填与 `--cover-mode none` 互相矛盾
- `publish weitoutiao`：全选 / 行尾快捷键在 macOS 无效
- `check-share.mjs`：账号目录名写错（`browser` → `browser-data`），会新建一个未登录的空白 profile

### 变更

- 移除空实现参数：`content list --type/--status/--page`、`comment list --article-id/--page`、`analytics works/income --period`
- `publish video`：全页截图与步骤日志改由 `--debug` 控制
- 运行时产物落盘位置从包内 `cli/output/` 迁到 `~/.toutiao-ops/`
- 临时调试脚本从 `cli/` 根目录迁入 `cli/tools/`
- 漏斗降级（真实词表 / 域库缺失）时 `topic-recommend` 默认拒绝输出推荐，需 `--allow-degraded` 显式放行
- 文档中的账号 / 评论 / 作品 / 话题示例 ID 全部改为占位值

## [1.1.4] - 上游快照

对应 `github.com/mf-yang/toutiao-ops` 的 `de89bba`，本仓库在此基础上二次开发。
