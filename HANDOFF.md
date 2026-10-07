# HANDOFF.md — 开发交接文档

> **接手者（IDE 内的 AI 助手 / 人类开发者）：请先完整读完本文件，再读 [`AGENTS.md`](./AGENTS.md)。**
>
> 两者分工：
> - **本文件** = 需求与决策的**由来**（这段对话谈了什么、为什么这么定、踩过哪些坑）
> - **`AGENTS.md`** = 工程**约定与接口**（目录结构、可复用导出、8 个预留点、代码风格、运行方式）
>
> 交接时间：2026-10-07 18:56 · 对话从"评估 skill 功能缺口"开始，到"启动代码开发"结束。

---

## 0. 一句话现状

基于 `mf-yang/toutiao-ops`（MIT）二次开发的头条号自动化运营 CLI，代码已迁到本目录，**第一个新功能的勘察脚本已写好但尚未运行**。

---

## 1. 需求方（用户）明确划定的边界

| 时间 | 用户原话（要点） | 含义 |
|---|---|---|
| 18:44 | "**从现在开始，请专注于辅助我编写代码，进行现有功能的拓展和新功能的开发。不需要考虑项目今后的运营、维护策略以及商业化变现等问题。**" | 🔴 **只谈代码**：功能实现、代码结构、具体改动。运营/维护/变现一律不进入开发讨论 |
| 18:48 | "接下来的任务交给 CodeBuddy 吧。你把这段对话导出，我导入到 CodeBuddy 直接在 IDE 里面开发。" | 开发主场转到 IDE |
| 18:29 / 18:40 | "**就做全开源**" | 输出物面向公开仓库 |
| 18:40 | "在开发这两个拓展功能的时候，要**留好后路**，以方便后续可能追加开发新的拓展功能" | 🔴 扩展性是**硬约束**，见 AGENTS.md 第 4.2 节 |

> ⚠️ 本文件**不含**变现、渠道、运营策略内容——那些与代码开发无关，用户已明确排除。

---

## 2. 项目来源（GitHub API 实测，非推测）

| 项 | 实测值 |
|---|---|
| 原仓库 | `github.com/mf-yang/toutiao-ops`（旧的 `jiulingyun/toutiao-ops` 会 301 跳到这里，项目已易主） |
| 星标 / fork | ★53 / 10 forks |
| 最后推送 | **2026-05-19（已停更约 4.5 个月）** |
| 许可证 | 仓库内**没有 LICENSE 文件**；但 npm 包 `@openclaw-cn/toutiao-ops` 元数据明确声明 `"license": "MIT"` |
| 开源程度 | **全开源**——32 个文件，连 `cli/src/` 全部 11 个模块源码都公开 |
| 使用量 | npm 上月下载 **100 次** |
| 挂载位置 | Claw 官方 Skill 市场（`clawd.org.cn`） |
| 本地快照 | commit `de89bba`（chore: 更新版本至 1.1.4，2026-04-08），**浅克隆，只有 1 个提交** |

**关于"有没有人做过二次开发"（用户曾专门让我核实）**：
10 个 fork 里 **9 个的 pushed 时间与上游同日 → 零改动僵尸 fork**；唯一看似活跃的 `zh79325/toutiao-ops`，翻其提交记录**全是原作者的历史提交**。
→ **公开 GitHub 上"基于 toutiao-ops 的二次开发"是空白。**

---

## 3. 代码现状盘点（实测）

### 3.1 本地与上游的差异（逐字节比对）

| 文件 | 上游 GitHub | 本地 | 说明 |
|---|---|---|---|
| **`cli/src/publish-weitoutiao.js`** | 5753 B | **12510 B** | 🔴 **本地是改过的，上游没有** |
| 其余 10 个 `src/*.js` | — | — | 字节数**完全一致** |
| `SKILL.md` | 4655 B | 4943 B | 本地写了本机绝对路径 |
| `README.md` | 6180 B | 6355 B | 同上 |
| `check-share.mjs` / `inspect-wtt-publish.mjs` / `scrape-forum.mjs` | **不存在** | 存在 | 上游仓库没有这 3 个脚本 |

**`publish-weitoutiao.js` 是已验证的重要增量**（修的是"回执说发布成功、实际没发出去"这个坑），内含：
`reallyPublished` 真实验证 · 失败返回 `success:false` · 页面拦截提示正则（存在风险/无法发布/请修改/内容违规/发布失败/重复内容）· `stillInEditor` 编辑器残留检测 · 打字前清空编辑器 · 首发放复选框勾选校验。

> 🔴 **改动前勿回退此文件**。git 工作区当前有 13 个 `M` 文件 + 3 个未跟踪脚本，首次提交时应把这段增量拆成独立 commit。

### 3.2 已知问题（待修）

- 🐛 `cli/index.js:19` 硬编码 `.version('1.0.0')`，与 `package.json` 的 **1.1.4** 不一致 → `--version` 输出错误版本
- 🔴 `cli/src/update-check.js` 会读**本地 `package.json` 的包名**去查 npm，再提示用户 `npm i -g <包名>`。**fork 后只改 `package.json` 不改这里 → 用户装的是你的版本、更新提示却指向原作者的包**（静默错乱、不报错）。改包名时必须同步改
- 无 `tests/`、无 eslint；CI（`.github/workflows/publish.yml`）只有 npm 发布 job

### 3.3 硬编码绝对路径清单（已脱敏）

`SKILL.md` · `cli/check-share.mjs` · `cli/inspect-wtt-publish.mjs` · `cli/scrape-forum.mjs` 中的本机绝对路径均已改为通用写法（`homedir()` / 相对 `./output/` / `<node>`）。

---

## 4. 两个拓展功能：设计要点

> 完整工程设计见项目目录外的设计文档（属参考资料，不会被本仓库提交）

### 4.1 功能一 `message-center`（站内消息中心数据拉取）

**目标**：把游离的外挂脚本升级为正式模块，结构化产出「话题邀请 / 作者成长助手 / 活动通知」等官方推送。

**现状**：该能力**目前不存在于任何命令中**——用户是靠一个项目目录外的外挂脚本（3612 B）绕过去的。

**该外挂脚本的 9 条局限（= 本功能的立项依据，逐条实测）**

1. 只取 `document.body.innerText` **前 6000 字符** → 消息一多即漏，与"滚到底加载全量"直接冲突
2. 纯文本行提取，**无类型结构化**（分不出话题邀请 / 成长助手 / 活动通知）
3. 靠关键词正则 `(话题|流量|扶持|小助手|活动…)` **碰运气筛**，非按消息类型解析
4. 无账号类型适配
5. **无 deadline 解析**（当日热点话题过期不自知）
6. 无适配度判定
7. 无错误处理、无缓存（页面结构一变就静默给空）
8. 硬编码绝对路径
9. 输出是 `console.log` 中文文本，**非 JSON**，与其他命令的约定不一致

**实现思路（关键转向）**

> **不要抓 `innerText`，改为拦截接口 JSON。** 第 1、2 条局限是**同一个根因**（抓的是给人看的 DOM），换成抓接口后一次消失。

照 `src/inspiration.js` 已验证的范式写：
1. `page.on('response')` 拦截 JSON → 成功则 `source: 'api_intercept'`
2. 拦不到再退回 DOM → `source: 'dom_scrape'`

**关键结构**

- `cli/src/message-center.js` — 主模块，导出 `async function listMessages(opts)`
- `cli/src/signals/base.js` — 统一信号源接口 `{ id, collect(ctx) → items[] }`（**8 个预留点里最关键的一条**，为功能二与将来的新信号源铺路）
- `cli/config/message-types.json` — 消息类型配置表 + parser 映射（**禁止写 `if (type==='x')` 长链**）
- 统一消息模型字段：`type` / `topicType` / `deadline` / `raw`
- `cli/references/message-center.md` — 参数文档（与现有 10 篇同格式）

**最大技术难点**
🔴 **消息中心没有稳定独立 URL**（SPA，必须点侧栏「消息」才渲染内容）→ 只能固化点击流程，且这是**最脆弱的一环**（头条改版即失效）。故先做结构勘察。

### 4.2 功能二 `external-source`（站外数据拉取 + 选题推荐）

**目标**：每日产出「当日可写选题范围」，站外信号与站内信号合流。

**实现思路**
HTTP 三源降级 → `normalize()` 统一字段模型 → **本地快照 diff 自算在榜时长** → 三级漏斗 → 加权排序。

**关键特征**
- **完全不用浏览器**：数据源无需认证，Node ≥18 内置 `fetch` 直连 → **零新增依赖**（与功能一必须走 Playwright + 登录态是两条不同技术路线）
- `cli/config/providers.json` — 数据源数组 + 统一 `normalize()`（加源 = 加一个条目，8 个预留点第 3 条）
- `cli/src/topic-recommend.js` — 推荐引擎，**只认 signals 接口、不认具体来源**
- 三级漏斗：`compliance（合规）→ domainMatch（域匹配）→ dedupe（排重）`，写成 `pipeline` 数组、顺序由配置决定（预留点第 5 条）
- 排序公式（权重外置到 `config/weights.json`）：
  ```
  score = 域命中强度×0.4 + 热度归一×0.3 + 在榜时长归一×0.2 + 账号适配度×0.1
  ```
- 输出的是**选题范围 / 角度，不是标题**
- 输出三件套：JSON（程序消费）+ Markdown 摘要（人读）+ 落盘

**两条硬约束**
1. 🔴 **抖音热搜 ≠ 头条选题**。抖音偏年轻/短视频，头条偏中老年/图文，画像差异大。**站外信号权重必须低于站内热点**，否则会重演"人设错配"（历史上有过一次 337 展现 / 0 阅读的实例）
2. **外部数据永远不能阻断发布主流程**——失败即降级回退站内，标记 `verdict: "degraded"`

**数据源选型（实测）**
- 首选 uapis.cn 热榜聚合：免费免注册，一次覆盖 40+ 平台（`/api/v1/misc/hotboard?type=douyin`）
  - ⚠️ **更正**：其"时光机模式（历史快照）"是 **Pro 参数**，免费模式**只返回当前实时榜** → 历史趋势不能靠它，**改为每日 3 次自建快照、自己算在榜时长**（数据在自己手里反而更可控）
- 备选：`imsyy/DailyHotApi`（★4084，支持**自部署**）→ 可彻底摆脱第三方可用性风险
- ❌ **不要走抖音官方接口**：需 `X-Bogus`/`a_bogus` 动态签名 + 登录态，签名算法高频变更，维护成本极高，且直接暴露自己的 IP

**拉取频率**：每日 3 次（08:30 / 13:00 / 19:00），同源 30 分钟缓存，**禁分钟级轮询**

**异常处理（9 类）**：超时重试 3 次退避 1s/3s/9s → 降级下一源 → 全失败回退站内；429 熔断当日停拉；返回空列表**不覆盖上次有效快照**；schema 校验失败时原始响应存 `output/raw-error/` 并报明确错误（**不静默**）

### 4.3 已确定的实施顺序

```
功能一 message-center  →  模块 A（topic-guard + compliance）  →  功能二 external-source
   独立、零依赖、收益即时         功能二的硬前置                    依赖前两者
```

🔴 **硬依赖**：功能二需要 `compliance.js` 与 `topic-guard.js` 做过滤与排重。**若模块 A 尚未实现，功能二必须先在自身内联一个最小版域匹配**，待 A 完成后切回调用——这是实施时必须处理的前置关系，不是可选优化。

**未排期但建议补**：`verify.js`（发布后四步核验：草稿箱自检 → 条数 +1 → 读 vl → 正文重复检测）。它是"回执 success 但实际没发出去"的直接解法。

---

## 5. 计划新增的文件

```
cli/config/          message-types.json  providers.json  pipeline.json  weights.json
cli/src/signals/     base.js  message-center.js  external-hot.js
cli/src/             message-center.js  external-source.js  topic-recommend.js
                     topic-guard.js  compliance.js  scheduler.js  verify.js
cli/data/            *.example.json          # 示例配置入库，真实数据不入库
cli/tools/           probe-message-center.mjs  ← 已存在
```

---

## 6. 运行环境与命令

```powershell
# node（Node.js 可执行文件；版本以本机安装为准）
<node 可执行文件路径>

cd cli
& "<上面的 node 路径>" index.js <命令> --account <n1|n2|default>
```

- **账号会话已存在**：`n1`、`n2`、`default`
- 🔴 **必须显式传 `--account`**；`no2` 是 n2 的复制品，**不要用**
- 会话数据：`~/.toutiao-ops/accounts/<name>/browser-data/`（持久化上下文，含登录态）
- 浏览器：Playwright Chromium + stealth 插件；已预设 zh-CN / Asia/Shanghai / 拒绝地理权限
- **同一个 account 的 profile 不能并发打开**（跑脚本前确认该账号的浏览器没开着）
- 依赖已随目录复制（`node_modules` 21M），**无需重新安装**

---

## 7. 下一步：具体动作清单

### ✅ 已完成
- [x] 代码从 skill 目录迁到本目录（含 `node_modules`、`.git`）
- [x] `.git` remote 改名 `origin → upstream`（指向原作者，**勿推送**）
- [x] 新增 `AGENTS.md` / `CLAUDE.md` / 补 `.gitignore`（`output/`、`*.probe.json`、`.vscode/`）
- [x] 写 `cli/tools/probe-message-center.mjs`（**只读**勘察脚本）

### ⬜ 待做（按顺序）

**Step 1 — 跑勘察脚本，拿到消息中心的真实结构**

```powershell
cd <仓库目录>\cli
& "<node>" tools\probe-message-center.mjs --account n1
```

- 会弹出 Chromium 窗口（用 n1 已登录会话），约 40–60 秒，跑完自动关闭
- 结果落盘 `cli\output\probe\message-center_n1_<时间戳>.json`
- stdout 会打印摘要：页面 URL 轨迹 / 导航候选 / 接口命中（按兴趣度排序）/ 点击前后文本长度
- 🔴 **边界**：该脚本只做「导航 + 扫描 + 点击消息入口」，**绝不输入文本、绝不提交表单、绝不发布**

**Step 2 — 依据勘察结果写正式模块**
1. `cli/config/message-types.json` — 六类消息类型定义（话题邀请 / 作者成长助手 / 活动通知 / 系统通知 / 评论互动 / 私信），每类含 `id` / `match`（URL 与标题关键词）/ `fields` / `priority`
2. `cli/src/signals/base.js` — 统一信号源接口 `{ id, collect(ctx) }`
3. `cli/src/message-center.js` — 主模块，签名 `async function listMessages(opts)`
4. `cli/index.js` — **仅追加**注册行（挂在 `inspiration` 旁边），不动任何现有逻辑
5. `cli/references/message-center.md` — 参数文档

**Step 3 — 自测**
```powershell
& "<node>" index.js message-center --account n1
```
对比输出 JSON 与外挂脚本的旧结果，确认：类型分得开、消息不截断、有 deadline 字段。

**Step 4 — 提交**
注意工作区现有 13 个 `M` 文件是**历史增量**，应与新功能分开提交。

---

## 8. 长期有用的工程结论（省去重新推导）

| 结论 | 依据 |
|---|---|
| **新增模块可以做到零改动现有代码** | `index.js` 的 `run(fn, subOpts)` 已统一注入 `opts.account` + 统一 JSON 输出 + 统一错误格式（`{error, stack}` + exit 1），新命令只需 `import` + 注册约 10 行 |
| **站内接口调用不需要自造签名** | `browserFetch(page, url, opts)` 在**页面上下文内**发 fetch，自动携带真实 Cookie/Referer |
| **抓取一律照 `inspiration.js` 的范式** | 「接口拦截优先 + DOM 回退」是本项目已验证的双路结构，新功能沿用即可 |
| **配置用 JSON 不用 YAML** | 省掉一个解析库 → 符合"不新增依赖"约束 |
| **不引入插件框架** | 用「注册表 + 配置表 + 处理链」留口子，成本只是几个 JSON + 1 个数组 + 1 个函数签名约定 |

---

## 9. 参考资料（位于项目目录之外，不在本仓库内）

- 项目目录外的「两项拓展功能设计方案」 — 两个功能的完整工程设计（五要素 + 扩展性硬约束章）
- 项目目录外的「功能扩展与开源方案」 — 功能缺口评估 / 扩展方案 / 开源流程
- 项目目录外的「toutiao-fetch-msg 外挂脚本」 — 功能一要替代的那个脚本
