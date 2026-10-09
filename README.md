# toutiao-ops — 今日头条运营技能包

面向 AI Agent 的今日头条创作者平台全流程运营自动化技能包。让 Agent 完全代理人类完成头条号日常运营。

## 项目定位

这是一个 **AI Agent 技能包**（Skill），遵循 [Agent Skill 规范](https://clawd.org.cn/tools/creating-skills.md)。Agent 通过读取 `SKILL.md` 了解可用命令，读取 `references/` 下的模块文档了解具体参数和用法，然后调用 `cli/` 下的 CLI 工具执行操作。

**同时**，`cli/` 目录也是一个独立的 npm 包 [`@openclaw-cn/toutiao-ops`](https://www.npmjs.com/package/@openclaw-cn/toutiao-ops)，可以脱离 Agent 单独使用。

## 功能覆盖

```
┌─ 账号管理 ─── 多账号登录 / QR 扫码 / 会话持久化 / 账号切换
│
├─ 内容发布 ─── 文章（封面/首发/合集/声明）
│              视频（封面/话题/生成图文/可见性）
│              微头条（多图/话题/首发/声明）
│
├─ 内容管理 ─── 作品列表
│
├─ 评论互动 ─── 评论列表 / 子评论 / 回复评论 / 点赞评论
│
├─ 数据分析 ─── 作品数据（按类型筛选）
│              粉丝画像（性别/年龄/地域/机型价格/偏好）
│              收益数据（总览/图文/视频）
│              单个作品详细数据
│
├─ 创作灵感 ─── 创作活动 / 热点推荐
│
├─ 消息中心 ─── 话题邀请 / 活动通知 / 作者成长助手 / 系统通知 / 服务通知 / 互动消息
│
├─ 选题信号 ─── 一级（站内：消息中心 / 作品数据）
│              二级（站外：第三方聚合热点）
│
└─ 发布核验 ─── 草稿箱自检 / 条数 +1 / 分发状态（vl）/ 正文重复检测
```

## 技术方案

| 操作类型 | 实现方式 | 原因 |
|----------|----------|------|
| 内容发布 | Playwright 浏览器自动化 | 模拟真人操作，避免被判定机器发布 |
| 评论互动 | Playwright 浏览器自动化 | 避免直接 POST 触发风控 |
| 数据读取 | 浏览器内 `fetch()` / API 拦截 | 复用浏览器 Cookie，获取结构化 JSON |
| 图表数据 | React Fiber 树提取 | 从 echarts 图表中提取原始数据 |

### 反检测

- `playwright-extra` + stealth 插件隐藏自动化特征
- 持久化浏览器上下文保留真实指纹
- 随机延迟 + 逐字输入模拟人类节奏
- 主动关闭弹窗、拒绝地理位置权限

## 仓库结构

本仓库同时承载「Agent 技能包」与「npm CLI」两种形态，共用一个根目录：

```
toutiao-ops/
├── SKILL.md                # Agent 技能入口（元数据 + 命令索引）；技能规范要求放根目录
├── references/             # 随技能分发的命令文档；被 SKILL.md 相对引用，勿随意移动
├── cli/                    # npm 包 @openclaw-cn/toutiao-ops，同时也是技能调用的 CLI
├── docs/                   # 面向人的项目文档（需求与决策由来）
├── examples/               # 发布类命令的输入 JSON 样例
├── .github/workflows/      # CI（离线冒烟测试）与发布（npm / GitHub Packages）
├── Makefile                # 常用任务（Linux / macOS）
├── AGENTS.md               # 工程约定与可复用接口（改代码前必读）
├── CLAUDE.md               # 指向 AGENTS.md
├── CONTRIBUTING.md / SECURITY.md / CHANGELOG.md / LICENSE
└── .editorconfig / .gitattributes / .gitignore / .clawignore
```

`cli/` 内部结构：

```
cli/
├── index.js                # 命令入口（只有 commander 注册，不含业务逻辑）
├── package.json
├── src/                    # 业务模块
│   ├── browser.js          # 浏览器启动、反检测、browserFetch / dismissOverlays
│   ├── paths.js            # 运行时目录统一入口（~/.toutiao-ops）
│   ├── auth.js / auth-guard.js
│   ├── publish-article.js / publish-video.js / publish-weitoutiao.js
│   ├── publish-verify.js   # 发布结果判定，三个发布模块共用
│   ├── content-manage.js / comment-manage.js / analytics.js / inspiration.js
│   ├── works-api.js        # 作品列表接口封装
│   ├── message-center.js   # 消息中心
│   ├── compliance.js / topic-guard.js / pipeline.js    # 三级过滤漏斗
│   ├── topic-signals.js / topic-recommend.js           # 选题信号与推荐
│   ├── signals/            # 统一信号源（base / works-analytics / external-hot）
│   └── verify.js           # 发布后四步核验
├── config/                 # 外置参数（权重 / 类型表 / 信号源 / 数据源 / 漏斗 / 核验）
├── data/                   # 词表与域库；仅 *.example.json 入库，真实数据不入库
├── test/                   # 离线冒烟测试（npm test）
└── tools/                  # 一次性探测脚本，非产品代码
```

运行时产物（会话数据、二维码截图、核验快照、推荐结果、外部缓存）一律写在 `~/.toutiao-ops/` 下，不进仓库。详见 `AGENTS.md`。

## 安装

### 作为 npm 包使用

```bash
npm install @openclaw-cn/toutiao-ops
npx toutiao-ops auth login
```

### 作为 Agent 技能使用

```bash
cd cli && npm install && npx playwright install chromium
```

Agent 读取 `SKILL.md` 获取命令列表，读取 `references/*.md` 获取参数说明。

## 开发

```bash
make test      # 离线冒烟测试（不联网、不启动浏览器）
make check     # 对 cli/ 下全部脚本做语法检查
```

Windows 下没有 `make`，直接执行 `cd cli && npm test`。约定见 [CONTRIBUTING.md](./CONTRIBUTING.md) 与 [AGENTS.md](./AGENTS.md)。

## 快速开始

```bash
# 登录（首次需手机扫码）
npx toutiao-ops auth login

# 发布文章
npx toutiao-ops publish article --title "AI 前沿" --content "内容..."

# 发布视频
npx toutiao-ops publish video --title "探险记" --file video.mp4

# 发布微头条
npx toutiao-ops publish weitoutiao --content "今日分享" --images "img.jpg"

# 查看评论并回复
npx toutiao-ops comment list
npx toutiao-ops comment reply --comment-id "内容片段" --content "感谢！"

# 查看粉丝画像
npx toutiao-ops analytics fans

# 获取热点
npx toutiao-ops inspiration --type hotspot

# 发布后核验（确认作品是否真的分发出去）
npx toutiao-ops verify --content "正文片段"
```

## 多账号管理

```bash
# 登录多个账号
npx toutiao-ops --account personal auth login
npx toutiao-ops --account work auth login

# 指定账号操作
npx toutiao-ops --account work publish article --title "..."

# 查看所有账号
npx toutiao-ops auth list
```

每个账号独立存储在 `~/.toutiao-ops/accounts/<name>/`，包含浏览器会话、二维码截图和账号元信息。

## 命令速查

| 命令 | 说明 |
|------|------|
| `auth check` / `auth login` / `auth logout` / `auth list` | 登录状态检测 / 扫码登录 / 退出登录 / 列出账号 |
| `publish article` | 发布文章（支持 Markdown 富文本排版） |
| `publish video` | 发布视频 |
| `publish weitoutiao` | 发布微头条 |
| `content list` | 作品列表（已发布） |
| `comment list` / `comment reply` / `comment like` | 评论列表 / 回复 / 点赞 |
| `analytics works` | 作品数据 |
| `analytics fans` | 粉丝画像 |
| `analytics income` | 收益数据 |
| `analytics content-detail` | 单个作品详情 |
| `inspiration` | 创作灵感 |
| `message-center` | 消息中心推送（话题邀请 / 活动通知 / 成长助手 等） |
| `topic-signals` | 选题信号（一级站内 + 二级站外） |
| `topic-recommend` | 选题推荐（加权排序 + 三件套输出） |
| `verify` | 发布后核验（草稿箱 / 条数 / vl / 重复检测） |

详细参数请查阅 `references/` 目录下对应模块文档。

## 环境要求

- Node.js >= 20（依赖 `marked@17` 的最低要求）
- macOS / Linux / Windows
- 首次登录需要显示器环境（扫码），后续可 `--headless` 运行

## 参与贡献

- [CONTRIBUTING.md](./CONTRIBUTING.md) —— 环境搭建、提交前必做、代码约定
- [SECURITY.md](./SECURITY.md) —— 漏洞报告方式与「不要贴什么」
- [CHANGELOG.md](./CHANGELOG.md) —— 版本变更记录

## 免责声明

本项目通过浏览器自动化操作真实账号，**可能违反平台服务条款，使用风险自负**。请遵守平台规则与当地法律法规，不要用于批量灌水、刷量或其他违规用途。仓库内不含任何真实账号标识、Cookie 或会话数据。

## License

MIT，详见 [LICENSE](./LICENSE)。基于 [mf-yang/toutiao-ops](https://github.com/mf-yang/toutiao-ops) 二次开发。
