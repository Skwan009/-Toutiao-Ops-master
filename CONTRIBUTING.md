# 贡献指南

感谢参与。工程约定以 [AGENTS.md](./AGENTS.md) 为准，本文只讲"怎么开始、提交前要做什么"。

## 环境

- Node.js **>= 20**（依赖 `marked@17` 的最低要求）
- 首次需要安装 Chromium：`npx playwright install chromium`

```bash
git clone <仓库地址>
cd cli
npm install --ignore-scripts     # 跳过 Chromium 下载，需要时再单独装
npm test                         # 离线冒烟测试，不需要登录、不开浏览器
```

## 提交前必须做

```bash
cd cli && npm test
```

`npm test` 是**离线**的：不联网、不启动浏览器，覆盖模块导入、命令注册、配置完整性、纯函数、漏斗端到端，以及若干防回归断言。CI 与发布流程都会跑同一个脚本，测试不过不会被发布。

需要真实账号才能验证的功能（发布、真实抓数）无法进 CI，请在有账号的环境手动验证，并在 PR 描述里写明验证方式与实际输出。

## 代码约定（摘要）

完整版见 [AGENTS.md](./AGENTS.md)：

- ESM + `async/await`；导出的主函数统一为 `async function name(opts)`
- 业务函数**直接返回对象**，不自己 `console.log`，由 `cli/index.js` 的 `run()` 统一序列化
- 参数、权重、阈值、词表、域库**全部外置到 `cli/config/` 或 `cli/data/`**，代码里不硬编码
- 所有 JSON 输出带 `schemaVersion`
- 抓取类功能：优先拦截页面自身的接口，拦不到再回退 DOM；**不要自造站内请求**（同页连续自造请求会被站点安全 SDK 拦截，详见 AGENTS.md）
- 运行时产物一律写 `~/.toutiao-ops/`（用 `cli/src/paths.js`），**不要写进包目录**

## 不要提交的内容

- 真实账号标识（账号 ID、昵称、个人主页链接）
- `cli/data/blocklist.json`、`cli/data/domains.json` 等真实词表 / 域库
- 浏览器 profile、Cookie、会话数据
- `cli/output/` 下的运行产物
- 真实的收益 / 粉丝 / 阅读数字

文档示例请用占位值，例如 `1234567890123456789`、`<账号昵称>`、`<话题名>`。

## 提交信息与 PR

- 提交信息用祈使句，建议加类型前缀：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`
- 一次提交聚焦一件事；改动原版模块时在提交信息里说明原因
- PR 描述请包含：改了什么、为什么、怎么验证的（附上命令与关键输出）

## 新增功能时

优先**只新增文件**：新命令在 `cli/index.js` 追加注册行，新信号源 / 新漏斗阶段在对应 `REGISTRY` 登记一行。改动既有逻辑请控制在最小范围。
