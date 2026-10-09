# AGENTS.md

项目上下文速览。工程约定与可复用接口以本文件为准；需求与决策的由来见 `docs/HANDOFF.md`。

## 1. 项目是什么

头条号创作者后台的自动化运营 CLI：发布、内容管理、评论互动、数据分析、创作灵感，另含消息中心、选题信号与发布核验。

- 本仓库（二次开发产物）：github.com/Skwan009/头条号运营大师
  - npm 包名 `@openclaw-cn/toutiao-ops`；GitHub Packages 的 scope 由仓库 owner 动态推导（见 `.github/workflows/publish.yml`），与 npm scope 不必一致
- 来源：基于 github.com/mf-yang/toutiao-ops（MIT）的二次开发
  - 上游快照 commit `de89bba`（chore: 更新版本至 1.1.4），2026-04-08
  - 本地 `.git` 的 remote 为 `upstream`，指向原作者，不要向它推送
  - 上游早已易主（旧地址 `github.com/jiulingyun/toutiao-ops` 会 301 跳到 `mf-yang`），勿把旧地址写进元数据
  - 上游仓库没有 LICENSE 文件，仅 `package.json` 声明 `"license": "MIT"`；本仓库已在根目录补 `LICENSE`（MIT 全文 + 上游署名）
- 技术栈：Node.js ESM + commander + Playwright（playwright-extra + stealth 插件）
- 运行形态：既是 Agent 技能包（`SKILL.md` + `references/`），也是独立 npm CLI（`cli/`）

## 2. 目录结构

```
.
├── SKILL.md              # Agent 技能入口（元数据 + 命令速查）；技能规范要求放根目录
├── references/           # 各命令参数文档；被 SKILL.md 相对引用，勿随意移动
├── cli/                  # npm 包 @openclaw-cn/toutiao-ops
│   ├── index.js          # 命令总入口（commander 注册，不含业务）
│   ├── package.json
│   ├── src/              # 功能模块
│   ├── src/signals/      # 统一信号源（base / works-analytics / external-hot）
│   ├── config/           # 外置参数（message-types / weights / signals / providers / pipeline / verify）
│   ├── data/             # 词表与域库（*.example.json 入库，真实数据不入库）
│   ├── test/             # 离线冒烟测试（npm test；CI 与发布前门禁）
│   ├── tools/            # 一次性探测脚本，非产品代码
│   └── node_modules/
├── docs/                 # 面向人的项目文档
│   └── HANDOFF.md        # 需求与决策的由来
├── examples/             # 发布输入 JSON 样例
├── .github/workflows/    # ci.yml（离线冒烟测试）+ publish.yml（npm / GitHub Packages）
├── AGENTS.md             # 工程约定与接口（本文件）
├── CLAUDE.md             # 指向 AGENTS.md
├── README.md             # 项目说明
├── Makefile              # 常用任务（Linux / macOS；Windows 用 cli/ 下的 npm 命令）
├── CHANGELOG.md / CONTRIBUTING.md / SECURITY.md / LICENSE
└── .editorconfig / .gitattributes / .gitignore / .clawignore
```

## 3. 可复用接口（改动前必读）

**`src/browser.js` 导出（所有功能共用）**

| 导出 | 签名 | 说明 |
|---|---|---|
| `launchBrowser` | `(opts) → {context, page}` | 持久化上下文，会话按账号隔离于 `~/.toutiao-ops/accounts/<name>/browser-data/` |
| `closeBrowser` | `(context)` | 关闭上下文 |
| `sleep` | `(min, max) → Promise` | 随机延迟 |
| `waitForStable` | `(page, timeout)` | 等待 networkidle |
| `dismissOverlays` | `(page)` | 关闭弹窗 / 横幅 / 权限提示 |
| `browserFetch` | `(page, url, opts) → {ok, status, data}` | 页内 fetch，自动携带真实 Cookie，调站内接口无需签名 |
| `humanType` / `getAccountDir` / `getBrowserDataDir` / `getScreenshotDir` | — | 工具函数 |

**`src/auth-guard.js`**：`ensureLoggedIn(page)`，每次操作前校验登录态。

**`src/paths.js`**：运行时目录统一入口。`BASE_DIR` = `~/.toutiao-ops`；`runtimeDir(...parts)` 取并创建子目录。
**所有运行时产物（核验快照、推荐结果、外部缓存）写这里，不写包内**——全局安装后 `node_modules` 通常只读，写入会静默失败。
`browser.js` 的 `BASE_DIR` 也从此处导入，避免两处定义漂移。

**站内数据的获取边界（重要）**：`browserFetch`（自造请求）在同一页面内**连续调用只有第一条能成功**，
之后会被站点安全 SDK 拦截（实测 `creator_center/list/v2`，返回 `TypeError: Failed to fetch`）。
因此：需要多次/分页请求的场景（作品列表、评论列表）**沿用"导航 + 拦截页面自身请求"范式**，
不要改成自造 API；确实要自造请求时，确保每次导航后只发一条。

**抓取范式**（`src/inspiration.js`，新抓取功能照此写）：

1. `page.on('response')` 拦截 JSON 接口，成功则返回 `source: 'api_intercept'`
2. 拦不到再退回 DOM 提取，返回 `source: 'dom_scrape'`

**信号源接口**（`src/signals/base.js`）：`{ id, collect(ctx) → items[] }`。站内消息与站外热榜都实现它，推荐引擎只认接口、不认来源。

## 4. 开发约定

### 4.1 增量优先，允许修缺陷

- 新功能优先只新增文件；对原版文件尽量只做追加（import、注册行、文档段落）
- 允许为修复缺陷修改原版模块（如发布后验证、账号名路径校验、退出码、正文粘贴），改动需最小化并在提交信息中说明
- `publish-weitoutiao.js` 是已修复版，勿回退其发布验证逻辑

### 4.2 预留扩展点

目标是将来加新功能时，理想情况只新增文件、不改已有逻辑；实在要改不超过 10 行。

| # | 预留点 | 做法 |
|---|---|---|
| 1 | 命令注册表 | 新模块统一签名 `async function name(opts)`；`index.js` 只注册不写业务 |
| 2 | 消息类型可扩展 | 走 `config/message-types.json` 配置表 + parser 映射，禁止写 `if (type==='x')` 长链 |
| 3 | 数据源可插拔 | `config/providers.json` 数组 + 统一 `normalize()`；加源即加一个条目 |
| 4 | 信号源统一接口 | 见第 3 节，推荐引擎只认接口 |
| 5 | 过滤/评分链数组化 | 漏斗写成 `pipeline: [compliance, domainMatch, dedupe]`，顺序由配置决定 |
| 6 | 参数全部外置 | 权重 / 阈值 / 域库 / 词表 / 时段全进 `config/*.json`，代码不硬编码 |
| 7 | 输出带版本号 | 所有 JSON 输出含 `schemaVersion`，落盘文件名带日期 |
| 8 | 不动原版 | 见 4.1 |

### 4.3 明确不做

插件框架、依赖注入、动态加载；事件总线、微内核、抽象工厂；为"可能用到"而抽象；新增第三方依赖（配置统一用 JSON 而非 YAML，省掉解析库）。

### 4.4 代码风格

- ESM + `async/await`；导出的主函数签名统一为 `async function name(opts)`
- 返回值直接是业务对象，不自己 `console.log`，由 `index.js` 的 `run()` 统一序列化
- 抛错交给 `run()` 兜底（输出 `{error, stack}` 并 exit 1）
- 注释用简短中文，不堆砌注释块

## 5. 运行方式

```bash
# Node.js 可执行文件，版本以本机安装为准（要求 >= 20）
NODE="<node 可执行文件路径>"

cd cli
$NODE index.js <命令> --account <账号名>
```

- 改完代码先跑冒烟测试：`cd cli && npm test`（**离线、不启动浏览器**，CI 与发布前会跑同一脚本）
- 账号名是**本机会话别名**，实际可用值见 `~/.toutiao-ops/accounts/`；不要把具体账号名写进仓库
- 必须显式传 `--account`
- 浏览器为 Chromium 持久化上下文；脚本生命周期短，用完调用 `closeBrowser`
- 同一个账号的 profile 不能并发打开

## 6. 当前进度

| 项 | 状态 |
|---|---|
| 仓库迁出到独立开发目录、remote 改为 `upstream` | 完成 |
| `message-center`（勘察 + 正式模块 + 自测） | 完成，直连 `boxes` + `cell/list` |
| 信号源层 `src/signals/`（base / works-analytics / external-hot） | 完成，一级 ×2 + 二级 ×1 |
| 统一入口 `topic-signals` | 完成，按 `weights.json` 打标 |
| 过滤漏斗 `compliance` + `topic-guard` + `pipeline` | 完成，顺序由 `config/pipeline.json` 决定 |
| 发布核验 `verify`（含 vl 分支） | 完成并实测（补充：无目标时跳过、异步响应 drain、cell 去重、三态 verdict） |
| 选题推荐 `topic-recommend` | 完成并实测（补充：漏斗降级默认拒绝输出） |
| 全量缺陷修复（安全 / 一致性 / 健壮性 / 工程基础） | 完成，多轮实测通过 |

## 7. 边界与免责

- 自动化操作可能违反平台服务条款，风险自担
- 仓库内不得出现：真实账号标识、Cookie / 会话数据、真实收益数字、二维码截图
- 运行时产物一律不进版本库：产品代码只写 `~/.toutiao-ops/`（见 `src/paths.js`）；
  `cli/output/` 仅剩 `tools/` 下一次性探测脚本的输出，同样被 `.gitignore` 排除
