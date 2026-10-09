# HANDOFF.md — 开发交接说明

记录需求边界、来源核实、既有增量与设计决策。工程约定与可复用接口见 [AGENTS.md](./AGENTS.md)。

## 1. 需求边界

| 用户要点 | 含义 |
|---|---|
| 专注辅助编写代码，进行现有功能拓展与新功能开发，不考虑运营、维护策略与商业化变现 | 开发讨论只谈功能实现、代码结构、具体改动 |
| 输出面向公开仓库（全开源） | 文档与代码按开源标准整理，注意脱敏 |
| 开发拓展功能时要留好后路，方便后续追加新功能 | 扩展性是硬约束，见 AGENTS.md 第 4.2 节 |

## 2. 项目来源（GitHub 实测）

| 项 | 实测值 |
|---|---|
| 原仓库 | github.com/mf-yang/toutiao-ops（旧的 jiulingyun/toutiao-ops 会 301 跳到这里，项目已易主） |
| 星标 / fork | 53 stars / 10 forks |
| 最后推送 | 2026-05-19（已停更约 4.5 个月） |
| 许可证 | 仓库内没有 LICENSE 文件；npm 包 `@openclaw-cn/toutiao-ops` 元数据声明 `"license": "MIT"` |
| 开源程度 | 全开源，32 个文件，`cli/src/` 全部 11 个模块源码公开 |
| 使用量 | npm 上月下载约 100 次 |
| 挂载位置 | Claw 官方 Skill 市场（clawd.org.cn） |
| 本地快照 | commit `de89bba`（2026-04-08），浅克隆，只有一个提交 |

二次开发调研：10 个 fork 里 9 个的 pushed 时间与上游同日（零改动僵尸 fork），唯一看似活跃的 zh79325/toutiao-ops 其提交记录全部来自原作者。公开 GitHub 上基于 toutiao-ops 的二次开发是空白。

## 3. 上游差异与既有增量

`cli/src/publish-weitoutiao.js` 是唯一被改动过的原版模块，上游没有这段改动。它修的是"回执说发布成功、实际没发出去"这个坑，改动点包括：

- `reallyPublished` 真实验证
- 失败返回 `success:false`
- 页面拦截提示正则（存在风险 / 无法发布 / 请修改 / 内容违规 / 发布失败 / 重复内容）
- `stillInEditor` 编辑器残留检测
- 打字前清空编辑器（否则重发时新正文会叠在旧草稿上）
- 首发复选框勾选校验

改动前勿回退此文件。

另有 3 个调试脚本（`check-share.mjs`、`inspect-wtt-publish.mjs`、`scrape-forum.mjs`）上游没有。`SKILL.md`、`README.md` 与上游的差异只是本机路径，已脱敏。

## 4. 已知问题

- `cli/src/update-check.js` 会读本地 `package.json` 的包名去查 npm，再提示用户安装该包名。fork 后只改包名不改这里，用户装的是你的版本、更新提示却指向原作者的包（静默错乱、不报错）。
- 无 `tests/`、无 eslint；CI（`.github/workflows/publish.yml`）只有 npm 发布 job。

## 5. 功能一：消息中心（已实现）

立项依据：此前该能力不存在于任何命令中，靠一个外挂脚本绕过。该脚本的问题可归纳为两条根因：抓的是给人看的 DOM（`innerText` 截断前 6000 字符），以及缺少类型结构化。

关键结论（勘察实测）：

- 消息中心有稳定 URL `https://mp.toutiao.com/profile_v4/personal/message`，"必须点侧栏"的假设不成立
- 真实接口是两个 POST：`/bcs/notice/boxes/`（分类目录）与 `/bcs/notice/cell/list/`（明细，参数 `box_type` + `cursor` + `limit`）
- 两个接口都是 POST + JSON、只依赖登录态 Cookie，可用 `browserFetch` 直接调用，不必导航点标签

产出：`cli/src/message-center.js`、`cli/config/message-types.json`（box_type 枚举 + 别名）、`cli/src/signals/base.js`、`references/message-center.md`。

## 6. 功能二：选题信号与推荐（已实现）

目标：每日产出"当日可写选题范围"，站内与站外信号合流。

权重分层：

- 一级权重：话题邀请、作者成长助手、活动通知、作品数据
- 二级权重：站外热点（第三方聚合 API）

技术路线：

- 站内信号走浏览器 + 接口（`message-center`、`works-analytics`）
- 站外热点纯 Node fetch，不用浏览器（`external-hot` + `providers.json`），同源 30 分钟缓存，超时重试退避、降级下一源、429 熔断、空列表不覆盖上次有效缓存
- 过滤漏斗 `compliance → domainMatch → dedupe`，顺序与参数由 `config/pipeline.json` 决定
- 打分：`base = 域命中×0.45 + 热度×0.30 + 新鲜度×0.25`，`score = base × 层级权重`（一级 ×1.0 / 二级 ×0.5），权重外置在 `config/weights.json`

两条硬约束：

1. 抖音热搜不等于头条选题（抖音偏年轻、短视频，头条偏中老年、图文）。站外信号权重必须低于站内，否则会重演人设错配。初版把层级只当一个普通分量时，二级的抖音热点确实压过了一级站内信号，改为层级作乘数后修正。
2. 外部数据不得阻断主流程，失败即降级回退站内。

数据源：首选 uapis.cn 热榜聚合（免费、免注册）；备选 imsyy/DailyHotApi（支持自部署）。不走抖音官方接口（需动态签名，维护成本高）。

## 7. 发布核验（已实现）

四步：草稿箱自检 → 条数 +1 → 读 vl → 正文重复检测。

`vl` 即作品流里的 `articleBase.visibilityLevel`，按值分支：

| 值 | 含义 | 处置 |
|---|---|---|
| 40 | 正常分发 | 通过 |
| 15 | 受限，看 `reviewInfo` | `reviewInfo.title === "审核中"` → 审核队列中，会自愈，勿重发；`reviewInfo.status === 3` 且 `title` 为空 → 真受限，不会自愈 |
| 45 | 看 `suppressionInfo.reason` | 有值 → 真压制；无值 → 审核过渡态 |
| 60 | 加权 | 通过 |

实现要点：

- 作品流接口是 `GET /api/feed/mp_provider/v1/`，结构为 `data[].assembleCell.itemCell.{ articleBase, reviewInfo, itemCounter }`
- 直连该接口返回 `errno:20100`（缺签名参数），因此走管理页的接口拦截，不自造请求
- `reviewInfo` 在 `itemCell.reviewInfo`，不在 `articleBase`；`itemCounter` 在 `itemCell.itemCounter`
- 作品总数取 `creator_center/list/v2?status=2` 的 `total_count`（`status`：2=已发布，0/5/6=全部，4=仅我可见）

产出：`cli/src/verify.js`、`cli/config/verify.json`、`references/verify.md`。

## 8. 实施顺序

```
message-center → 模块 A（compliance + topic-guard） → external-source / topic-recommend
```

功能二的过滤与排重依赖模块 A，故先实现模块 A。

## 9. 关键工程结论

| 结论 | 依据 |
|---|---|
| 新增模块可做到零改动现有代码 | `index.js` 的 `run(fn, subOpts)` 已统一注入 `opts.account`、统一 JSON 输出、统一错误格式，新命令只需 import 与注册约 10 行 |
| 站内接口调用不需要自造签名 | `browserFetch(page, url, opts)` 在页面上下文内发 fetch，自动携带真实 Cookie / Referer |
| 抓取一律照 `inspiration.js` 的范式 | 接口拦截优先 + DOM 回退，是本项目已验证的双路结构 |
| 配置用 JSON 不用 YAML | 省掉一个解析库，符合不新增依赖的约束 |
| 不引入插件框架 | 用注册表 + 配置表 + 处理链留口子，成本只是几个 JSON、一个数组、一个函数签名约定 |

## 10. 参考资料（位于项目目录之外，不随仓库提交）

- 两项拓展功能设计方案 — 功能与模块的完整工程设计
- 功能扩展与开源方案 — 功能缺口评估、扩展方案、开源流程
- toutiao-fetch-msg 外挂脚本 — 功能一要替代的那个脚本
