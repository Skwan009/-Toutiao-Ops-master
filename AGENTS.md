# AGENTS.md — 项目上下文

> 本文件供任何 AI 编程助手（CodeBuddy / Claude Code / Cursor 等）读取，用于快速建立项目上下文。
> 人类开发者也可把它当项目速览。

## 1. 项目是什么

头条号创作者后台的**全链路自动化运营 CLI**：发布、内容管理、评论互动、数据分析、创作灵感。

- **来源**：基于 `github.com/mf-yang/toutiao-ops`（原作者仓库，MIT）的二次开发
  - 上游快照 commit：`de89bba`（chore: 更新版本至 1.1.4），2026-04-08
  - 本地 `.git` 的 remote 已改名为 `upstream` 指向原作者，**不要直接向 upstream 推送**
  - 原仓库**没有 LICENSE 文件**，仅 `package.json` 声明 `"license": "MIT"`；开源时需自行补 MIT 全文
- **技术栈**：Node.js ESM + commander + Playwright（playwright-extra + stealth 插件）
- **运行形态**：既是 AI Agent 技能包（`SKILL.md` + `references/`），也是独立 npm CLI（`cli/`）

## 2. 目录结构

```
.
├── SKILL.md              # AI Agent 技能入口（元数据 + 命令速查）
├── README.md
├── AGENTS.md / CLAUDE.md / HANDOFF.md   # 项目上下文与开发交接文档
├── cli/
│   ├── index.js          # 命令总入口（commander 注册）
│   ├── package.json
│   ├── src/              # 功能模块（原 11 个 + message-center / topic-signals / pipeline / compliance / topic-guard / verify）
│   ├── src/signals/      # 统一信号源（base / works-analytics / external-hot）
│   ├── config/           # 参数外置（message-types / weights / signals / providers / pipeline / verify）
│   ├── data/             # 词表与域库（*.example.json 入库，真实数据不入库）
│   ├── tools/            # 一次性探测/勘察脚本，非产品代码
│   └── node_modules/
├── references/           # 12 篇命令参数文档
├── examples/             # 3 个发布输入 JSON 样例
└── .github/workflows/publish.yml
```

## 3. 现有模块与可复用接口（改动前必读）

`cli/src/` 现有 11 个模块：`auth.js` `auth-guard.js` `browser.js` `publish-article.js`
`publish-video.js` `publish-weitoutiao.js` `content-manage.js` `comment-manage.js`
`analytics.js` `inspiration.js` `update-check.js`

**`src/browser.js` 导出（所有功能共用）**

| 导出 | 签名 | 说明 |
|---|---|---|
| `launchBrowser` | `(opts) → {context, page}` | 持久化上下文，会话按账号隔离于 `~/.toutiao-ops/accounts/<name>/browser-data/` |
| `closeBrowser` | `(context)` | |
| `sleep` | `(min, max) → Promise` | 随机延迟 |
| `waitForStable` | `(page, timeout)` | 等 networkidle |
| `dismissOverlays` | `(page)` | 关弹窗/横幅/权限提示 |
| `browserFetch` | `(page, url, opts) → {ok, status, data}` | **页内 fetch，自动带真实 Cookie**，调站内接口无需签名 |
| `humanType` / `getAccountDir` / `getBrowserDataDir` / `getScreenshotDir` | | |

**`src/auth-guard.js`**：`ensureLoggedIn(page)` — 每次操作前校验登录态

**`src/inspiration.js` 是本项目的抓取范式**（新抓取功能照它写）：
1. `page.on('response')` 拦截 JSON 接口 → 成功则返回 `source: 'api_intercept'`
2. 拦不到再退回 DOM 提取 → `source: 'dom_scrape'`

## 4. 开发铁律（硬约束，不得违反）

### 4.1 只做增量，不动原有逻辑
- 新功能**只新增文件**；对原版文件仅允许「追加 import / 追加注册行 / 追加文档段落」
- 现有 11 个模块的**功能代码保持原样**（`publish-weitoutiao.js` 是已修复版，勿回退）

### 4.2 为后续扩展留后路（8 个预留点）
目标是：**将来加第 4 个功能时，理想情况只新增文件、不改已有逻辑；实在要改 ≤ 10 行。**

| # | 预留点 | 做法 |
|---|---|---|
| 1 | 命令注册表 | 新模块统一签名 `async function name(opts)`；`index.js` 只注册不写业务 |
| 2 | 消息类型可扩展 | 走 `config/message-types.json` 配置表 + parser 映射，**禁止 `if (type==='x')` 长链** |
| 3 | 数据源可插拔 | `config/providers.json` 数组 + 统一 `normalize()`；加源 = 加一个条目 |
| 4 | **信号源统一接口**（最关键） | 定义 `{ id, collect(ctx) → items[] }`；站内消息与站外热榜都实现它，推荐引擎**只认接口不认来源** |
| 5 | 过滤/评分链数组化 | 漏斗写成 `pipeline: [compliance, domainMatch, dedupe]`，顺序由配置决定 |
| 6 | 参数全部外置 | 权重/阈值/域库/词表/时段全进 `config/*.json`，**代码零硬编码** |
| 7 | 输出带版本号 | 所有 JSON 输出含 `schemaVersion`，落盘文件名带日期 |
| 8 | 不动原版 | 见 4.1 |

### 4.3 明确不做（防过度设计）
❌ 插件框架、依赖注入、动态加载 ❌ 事件总线、微内核、抽象工厂 ❌ 为"可能用到"而抽象
❌ 新增第三方依赖（配置统一用 **JSON 而非 YAML**，省掉解析库）

### 4.4 代码风格
- ESM + `async/await`；导出的主函数签名统一为 `async function name(opts)`
- 返回值直接是业务对象，**不自己 `console.log`**——由 `index.js` 的 `run()` 统一 JSON 序列化
- 抛错交给 `run()` 兜底（输出 `{error, stack}` 并 exit 1）
- 注释用简短中文 `//`，不要注释块堆砌

## 5. 运行方式

```bash
# node（Node.js 可执行文件；版本以本机安装为准）
NODE="<node 可执行文件路径>"

cd cli
$NODE index.js <命令> --account <n1|n2|default>
```

- 账号会话已存在：`n1`、`n2`、`default`
- **必须显式传 `--account`**；注意 `no2` 是 n2 的复制品，**不要用**
- Playwright 浏览器为 Chromium 持久化上下文；脚本生命周期短，用完 `closeBrowser`

## 6. 当前进度

| 项 | 状态 |
|---|---|
| 仓库从 skill 目录迁出到独立开发目录 | ✅ |
| remote 改为 `upstream`（指向原作者） | ✅ |
| 功能一 `message-center`（勘察 + 正式模块 + 自测） | ✅ 直连 `boxes` + `cell/list` 两个接口 |
| 信号源层 `src/signals/`（base / works-analytics / external-hot） | ✅ 一级 ×2 + 二级 ×1 |
| 统一入口 `topic-signals`（一级/二级权重） | ✅ 按 `weights.json` 打标 |
| 模块 A `compliance` + `topic-guard` + 三级漏斗 | ✅ 顺序由 `config/pipeline.json` 决定 |
| 发布核验 `verify.js`（含 vl 分支） | ✅ 已实现，端到端实测待网络恢复 |
| `topic-recommend` 加权排序 | ⬜ |

**已知待修**：`cli/index.js` 第 19 行硬编码 `.version('1.0.0')`，与 `package.json` 的 1.1.4 不一致。

## 7. 计划中的新增文件

```
cli/config/          message-types.json  weights.json  signals.json  providers.json  pipeline.json  verify.json   ✅
cli/src/signals/     base.js  works-analytics.js  external-hot.js                                                ✅  # 统一信号源接口
cli/src/             message-center.js  topic-signals.js  pipeline.js                                            ✅
                     compliance.js  topic-guard.js  verify.js                                                     ✅
                     topic-recommend.js                                                                           ⬜  # 加权排序，待做
cli/data/            blocklist.example.json  domains.example.json                                                ✅  # 示例入库，真实数据不入库
```

## 8. 边界与免责

- 自动化操作可能违反平台服务条款，风险自担
- 仓库内**不得出现**：真实账号标识、Cookie/会话数据、真实收益数字、二维码截图
- 运行时产物（`cli/output/`、`~/.toutiao-ops/`）一律不进版本库
