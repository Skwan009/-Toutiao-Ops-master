#!/usr/bin/env node
/**
 * 最小冒烟测试：**不联网、不启动浏览器**，CI 与本地都能直接跑。
 *
 * 有意只覆盖"不需要真账号也会失败"的那部分：
 *   A. 所有 src 模块可导入（ESM 语法 / 无循环依赖）
 *   B. CLI 全部命令注册且帮助可输出
 *   C. 配置文件完整性（权重分层、类型表、信号源、漏斗、数据源、核验）
 *   D. 纯函数行为（作品接口 URL、counters 映射、vl 分支、运行时目录）
 *   E. 漏斗端到端（compliance → domainMatch → dedupe，用合成数据 + 注入夹具）
 *   F. 防回归断言（落盘路径、已废弃的空实现参数、封面条件必填、示例数据与配置对齐）
 *   G. 退出码契约（业务失败 success:false 也返回非零）
 *
 * 使用：node test/smoke.mjs   （或 npm test）
 * 离线保证：CLI 子进程一律注入 TOUTIAO_OPS_OFFLINE=1，关闭 src/update-check.js 的版本外呼。
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'fs';
import { join, dirname, relative } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(HERE, '..');
const ROOT_DIR = join(CLI_DIR, '..');
const SRC_DIR = join(CLI_DIR, 'src');
const CONFIG_DIR = join(CLI_DIR, 'config');
const DATA_DIR = join(CLI_DIR, 'data');
const INDEX = join(CLI_DIR, 'index.js');

let pass = 0;
let fail = 0;
const lines = [];

function ok(name) {
  pass++;
  lines.push(`  \u2713 ${name}`);
}
function bad(name, msg) {
  fail++;
  lines.push(`  \u2717 ${name}\n      ${msg}`);
}
async function check(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('断言为 false');
    ok(name);
  } catch (e) {
    bad(name, e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 递归列出目录下所有 .js */
function listModules(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listModules(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const readCfg = (name) => JSON.parse(readFileSync(join(CONFIG_DIR, name), 'utf8'));
const readData = (name) => JSON.parse(readFileSync(join(DATA_DIR, name), 'utf8'));
const mod = (rel) => import(pathToFileURL(join(SRC_DIR, rel)).href);

// 本文件声称"离线"就必须真的离线：显式关掉 CLI 的版本检查外呼（src/update-check.js 读该开关）。
// 否则每次 npm test 都会打一次 registry.npmjs.org、写 ~/.toutiao-ops/update-check.json，
// 并可能向 stderr 混入非 JSON 的升级提示。
const OFFLINE_ENV = { ...process.env, TOUTIAO_OPS_OFFLINE: '1' };
const EXEC_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: OFFLINE_ENV };

function runCli(args) {
  return execFileSync(process.execPath, [INDEX, ...args], EXEC_OPTS);
}
function runCliExpectFail(args) {
  try {
    const out = execFileSync(process.execPath, [INDEX, ...args], EXEC_OPTS);
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** 临时数据夹具目录（漏斗注入用），结束时统一清理 */
const tempDirs = [];
function makeTempDataDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'toutiao-ops-smoke-'));
  tempDirs.push(dir);
  for (const [name, obj] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(obj, null, 2));
  return dir;
}

const EXPECTED_COMMANDS = [
  'auth', 'publish', 'content', 'comment', 'analytics',
  'inspiration', 'message-center', 'topic-signals', 'verify', 'topic-recommend',
];

// 分组命令的子命令（叶子命令没有子命令）。commander 会自动追加 `help`，解析时统一剔除。
const EXPECTED_SUBCOMMANDS = {
  auth: ['check', 'login', 'logout', 'list'],
  publish: ['article', 'video', 'weitoutiao'],
  content: ['list'],
  comment: ['list', 'reply', 'like'],
  analytics: ['works', 'fans', 'income', 'content-detail'],
};

/** 从 commander 的 --help 输出里提取 Commands 段的命令名（只取每行首列 token，剔除内置 help） */
function parseCommandNames(help) {
  const names = [];
  let inCommands = false;
  for (const raw of help.split(/\r?\n/)) {
    if (/^Commands:\s*$/.test(raw)) { inCommands = true; continue; }
    if (!inCommands) continue;
    const m = raw.match(/^ {2,}(\S+)/);
    if (!m) break; // 命令段结束（空行或说明文字）
    if (m[1] !== 'help') names.push(m[1]);
  }
  return names;
}

/** 按 token 边界匹配选项名，避免 --page 命中 --pages / --page-size */
function hasOption(help, opt) {
  const esc = opt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${esc}(\\s|[,<]|$)`).test(help);
}

async function main() {
  // ── A. 模块导入 ──
  const moduleFiles = listModules(SRC_DIR);
  await check(`src 模块全部可导入（${moduleFiles.length} 个）`, async () => {
    const failed = [];
    for (const f of moduleFiles) {
      try {
        await import(pathToFileURL(f).href);
      } catch (e) {
        failed.push(`${relative(CLI_DIR, f)}: ${e.message}`);
      }
    }
    assert(failed.length === 0, failed.join('; '));
  });

  // ── B. 命令注册 ──
  await check('顶层帮助的命令集与注册表精确一致', () => {
    const names = parseCommandNames(runCli(['--help']));
    const missing = EXPECTED_COMMANDS.filter((c) => !names.includes(c));
    const extra = names.filter((c) => !EXPECTED_COMMANDS.includes(c));
    assert(missing.length === 0, `帮助中缺少命令：${missing.join(', ')}`);
    assert(extra.length === 0, `帮助中出现未预期命令：${extra.join(', ')}`);
    assert(names.length === EXPECTED_COMMANDS.length, `命令条数 ${names.length} ≠ 期望 ${EXPECTED_COMMANDS.length}`);
  });

  await check('分组命令的子命令集与注册表精确一致', () => {
    for (const [group, subs] of Object.entries(EXPECTED_SUBCOMMANDS)) {
      const names = parseCommandNames(runCli([group, '--help']));
      const missing = subs.filter((s) => !names.includes(s));
      const extra = names.filter((s) => !subs.includes(s));
      assert(missing.length === 0, `${group} 缺少子命令：${missing.join(', ')}`);
      assert(extra.length === 0, `${group} 出现未预期子命令：${extra.join(', ')}`);
    }
  });

  await check('全部命令（含子命令）的帮助可正常输出', () => {
    const broken = [];
    const cases = [
      ...EXPECTED_COMMANDS.filter((c) => !EXPECTED_SUBCOMMANDS[c]).map((c) => [c]),
      ...Object.entries(EXPECTED_SUBCOMMANDS).flatMap(([g, subs]) => subs.map((s) => [g, s])),
    ];
    for (const args of cases) {
      try {
        const h = runCli([...args, '--help']);
        if (!h.includes('Usage:')) broken.push(`${args.join(' ')}（无 Usage）`);
      } catch (e) {
        broken.push(`${args.join(' ')}（退出码 ${e.status}）`);
      }
    }
    assert(broken.length === 0, broken.join(', '));
  });

  // ── C. 配置完整性 ──
  await check('weights.json 分层完整且严格降序', () => {
    const w = readCfg('weights.json');
    const t = w.tiers || {};
    for (const k of ['1', '2', '3']) assert(t[k], `tiers 缺 ${k}`);
    assert(t['1'].weight > t['2'].weight, '一级权重必须高于二级（站内高于站外）');
    assert(t['2'].weight > t['3'].weight, '二级权重必须高于辅助');
    const c = w.ranking?.components || {};
    const sum = Object.values(c).reduce((a, b) => a + b, 0);
    assert(Math.abs(sum - 1) < 1e-9, `ranking.components 之和应为 1，实际 ${sum}`);
  });

  await check('message-types.json 类型表自洽', () => {
    const cfg = readCfg('message-types.json');
    const w = readCfg('weights.json');
    assert(Array.isArray(cfg.types) && cfg.types.length > 0, 'types 为空');
    const ids = new Set();
    for (const t of cfg.types) {
      assert(t.id && t.label, `类型缺 id/label：${JSON.stringify(t)}`);
      assert(!ids.has(t.id), `类型 id 重复：${t.id}`);
      ids.add(t.id);
      assert(t.boxType === null || Number.isInteger(t.boxType), `${t.id} 的 boxType 应为整数或 null`);
      assert(w.tiers[String(t.tier)], `${t.id} 的 tier=${t.tier} 不在 weights.tiers 中`);
    }
    const tier1 = cfg.types.filter((t) => t.tier === 1).map((t) => t.id);
    for (const must of ['topic_invite', 'activity_notice', 'growth_assistant']) {
      assert(tier1.includes(must), `${must} 必须是一级权重`);
    }
    // 别名与 message_type 映射必须落到真实 type.id，否则配置"写了但接不上线"
    for (const [alias, target] of Object.entries(cfg.aliases || {})) {
      assert(ids.has(target), `aliases."${alias}" 指向不存在的类型 ${target}`);
    }
    for (const [mt, target] of Object.entries(cfg.messageTypeMap || {})) {
      assert(ids.has(target), `messageTypeMap."${mt}" 指向不存在的类型 ${target}`);
    }
    assert(Number.isInteger(cfg.appId), `appId 应为整数（消息中心接口读取它），实际 ${JSON.stringify(cfg.appId)}`);
  });

  await check('signals.json 数据源声明完整且站外低于站内', () => {
    const s = readCfg('signals.json');
    const w = readCfg('weights.json');
    assert(Array.isArray(s.sources) && s.sources.length > 0, 'sources 为空');
    for (const x of s.sources) {
      assert(x.id, 'sources 条目缺 id');
      assert(Number.isInteger(x.tier), `${x.id} 缺整数 tier`);
      assert(w.tiers[String(x.tier)], `${x.id} 的 tier 不在 weights.tiers 中`);
      assert(['internal', 'external'].includes(x.kind), `${x.id} 的 kind 非法：${x.kind}`);
      // 防回归：module / providers 是无人读取的死键（实现登记在 topic-signals.js 的 REGISTRY）
      assert(!('module' in x), `${x.id} 的 module 键无人读取，不应出现`);
      assert(!('providers' in x), `${x.id} 的 providers 键无人读取，不应出现`);
    }
    for (const e of s.sources.filter((x) => x.kind === 'external')) {
      assert(w.tiers[String(e.tier)].weight < w.tiers['1'].weight, `站外源 ${e.id} 的权重必须低于一级`);
    }
  });

  await check('pipeline.json 每个阶段都有实现', async () => {
    const p = readCfg('pipeline.json');
    assert(Array.isArray(p.stages) && p.stages.length > 0, 'stages 为空');
    const { runPipeline } = await mod('pipeline.js');
    const res = await runPipeline([]);
    const errored = res.stages.filter((s) => s.error);
    assert(errored.length === 0, `阶段未登记实现：${errored.map((s) => s.id).join(', ')}`);
  });

  await check('providers.json 条目完整', () => {
    const p = readCfg('providers.json');
    assert(Array.isArray(p.providers) && p.providers.length > 0, 'providers 为空');
    for (const x of p.providers) {
      assert(x.id && x.url, `${x.id} 缺 id/url`);
      assert(/^https?:\/\//.test(x.url), `${x.id} 的 url 非法：${x.url}`);
      assert(x.listPath, `${x.id} 缺 listPath`);
      assert(x.fieldMap && x.fieldMap.title, `${x.id} 缺 fieldMap.title`);
    }
  });

  await check('verify.json 关键键完整且被真实读取', () => {
    const v = readCfg('verify.json');
    for (const k of ['pages', 'feedApiMatch', 'countApi', 'countStatus', 'appId', 'pageSize']) {
      assert(v[k] !== undefined, `缺键：${k}`);
    }
    assert(v.pages.content && v.pages.draft, 'pages.content / pages.draft 缺失');
    assert(/^https?:\/\//.test(v.countApi), `countApi 应为 URL（verify.js 会传给 works-api），实际 ${v.countApi}`);
  });

  await check('示例数据文件与 pipeline 启用项对齐', () => {
    const p = readCfg('pipeline.json');
    const b = readData('blocklist.example.json');
    const d = readData('domains.example.json');
    assert(b.categories && Object.keys(b.categories).length > 0, 'blocklist.example.json 缺 categories');
    assert(d.domains && Object.keys(d.domains).length > 0, 'domains.example.json 缺 domains');

    // 回退到示例文件时，被启用却不存在的分类/领域会被静默忽略——必须对齐
    const comp = (p.stages || []).find((s) => s.id === 'compliance');
    for (const cat of comp?.categories || []) {
      assert(b.categories[cat], `pipeline 启用分类 ${cat}，但示例词表缺失该分类`);
    }
    const dm = (p.stages || []).find((s) => s.id === 'domainMatch');
    for (const id of dm?.activeDomains || []) {
      assert(d.domains[id], `pipeline 启用领域 ${id}，但示例域库缺失该领域`);
    }
  });

  // ── D. 纯函数 ──
  await check('works-api 构造 URL 与 counters 映射正确', async () => {
    const { buildWorksUrl, countersOf, SAFE_PAGE_SIZE } = await mod('works-api.js');
    const u = new URL(buildWorksUrl({ status: 2, type: 0, pageSize: SAFE_PAGE_SIZE }));
    assert(u.pathname === '/mp/agw/creator_center/list/v2', `路径不符：${u.pathname}`);
    assert(u.searchParams.get('status') === '2', 'status 参数错误');
    assert(u.searchParams.get('page_size') === String(SAFE_PAGE_SIZE), 'page_size 参数错误');
    assert(u.searchParams.get('app_id') === '1231', 'app_id 参数错误');
    const c = countersOf({ counters: [{ Name: '展现', Count: 3 }, { Name: '阅读', Count: 1 }] });
    assert(c['展现'] === 3 && c['阅读'] === 1, 'counters 映射错误');
    assert(Object.keys(countersOf(null)).length === 0, 'countersOf(null) 应返回空对象');
  });

  await check('works-api 非 JSON 响应必须抛错（不得当空数据成功）', async () => {
    const { fetchWorks } = await mod('works-api.js');
    // 模拟被 WAF/登录失效返回 HTML 的响应：旧实现 return data || {}，
    // 调用方会静默得到 success:true + count:0
    const badPage = { evaluate: async () => ({ ok: true, status: 200, data: '<html>blocked</html>' }) };
    let err = null;
    try { await fetchWorks(badPage, { pageSize: 50 }); } catch (e) { err = e; }
    assert(err !== null, '非 JSON 响应应抛错，实际未抛');

    // pageSize 必须按对象参数生效（旧实现传数字会被静默忽略）
    const urls = [];
    const okPage = {
      evaluate: async (_fn, arg) => {
        urls.push(arg.url);
        return { ok: true, status: 200, data: JSON.stringify({ total_count: 7, contents: [] }) };
      },
    };
    await fetchWorks(okPage, { pageSize: 123 });
    const u = new URL(urls[0]);
    assert(u.searchParams.get('page_size') === '123', `pageSize 未生效，实际 ${u.searchParams.get('page_size')}`);
  });

  await check('dismissOverlays 不注册 context 监听器（防监听器泄漏）', async () => {
    const { dismissOverlays } = await mod('browser.js');
    let onCalls = 0;
    const fakePage = {
      context: () => ({ on: () => { onCalls++; }, grantPermissions: async () => {} }),
      evaluate: async () => 0,
      keyboard: { press: async () => {} },
    };
    await dismissOverlays(fakePage);
    assert(onCalls === 0, `dismissOverlays 注册了 ${onCalls} 个 context 监听器（应为 0）`);
  });

  await check('domainMatch 的 minHits: 0 被尊重（不被 || 吞成 1）', async () => {
    const { runPipeline } = await mod('pipeline.js');
    const dir = makeTempDataDir({
      'domains.json': { domains: { life: { label: '生活', keywords: ['生活'] } } },
      'blocklist.json': { categories: {} },
    });
    const cfg0 = join(dir, 'pipeline0.json');
    writeFileSync(cfg0, JSON.stringify({
      stages: [{ id: 'domainMatch', enabled: true, domains: 'domains.json', activeDomains: ['life'], minHits: 0 }],
    }));
    const r0 = await runPipeline([{ title: '完全无关的内容' }], { dataDir: dir, pipelinePath: cfg0 });
    assert(r0.stages.find((s) => s.id === 'domainMatch').dropped === 0, 'minHits=0 时不应丢弃任何条目');

    const cfg1 = join(dir, 'pipeline1.json');
    writeFileSync(cfg1, JSON.stringify({
      stages: [{ id: 'domainMatch', enabled: true, domains: 'domains.json', activeDomains: ['life'], minHits: 1 }],
    }));
    const r1 = await runPipeline([{ title: '完全无关的内容' }], { dataDir: dir, pipelinePath: cfg1 });
    assert(r1.stages.find((s) => s.id === 'domainMatch').dropped === 1, 'minHits=1 时无关项应被丢弃');
  });

  await check('topic-recommend --top 非法值必须报错而非静默回退', () => {
    for (const bad of ['0', 'abc', '-1']) {
      const r = runCliExpectFail(['topic-recommend', '--top', bad, '--no-filter', '--account', 'smoke-offline']);
      assert(r.code !== 0, `--top ${bad} 应返回非 0 退出码，实际 ${r.code}`);
      assert(/--top 需要正整数/.test(r.out), `--top ${bad} 错误信息不符，实际：${r.out.slice(0, 160)}`);
    }
  });

  await check('非法 --type 必须报错而非静默回落（且不进浏览器）', () => {
    const cases = [
      [['analytics', 'works', '--type', 'bogus'], /--type 不支持/],
      [['analytics', 'income', '--type', 'bogus'], /--type 不支持/],
      [['inspiration', '--type', 'hot'], /--type 不支持/],
    ];
    for (const [args, re] of cases) {
      const r = runCliExpectFail([...args, '--account', 'smoke-offline']);
      assert(r.code !== 0, `${args.join(' ')} 应返回非 0 退出码，实际 ${r.code}`);
      assert(re.test(r.out), `${args.join(' ')} 错误信息不符，实际：${r.out.slice(0, 160)}`);
      assert(!/playwright|browserType|Timeout/i.test(r.out), `${args.join(' ')} 不应进入浏览器流程`);
    }
  });

  await check('标题按码点计数与截断（不切断代理对）', async () => {
    // 与 publish-article.js 的截断逻辑等价；旧实现用 UTF-16 码元，
    // 会把 emoji/扩展汉字算成 2 个字并可能切断代理对
    const src = readFileSync(join(SRC_DIR, 'publish-article.js'), 'utf8');
    assert(/\[\.\.\.String\(opts\.title\)\]/.test(src), '标题应按码点展开（[...String(opts.title)]）');
    assert(/titleChars\.slice\(0, TITLE_MAX_LEN\)/.test(src), '截断应基于码点数组');
    assert(!/title\.length > TITLE_MAX_LEN/.test(src), '不应再用 UTF-16 码元长度判断');

    const cut = (t, max = 30) => { const c = [...String(t)]; return c.length > max ? c.slice(0, max).join('') : c.join(''); };
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const emoji = '😀';
    assert([...cut(emoji.repeat(35))].length === 30, 'emoji 标题应截断为 30 个码点');
    assert(LONE.test(cut('a' + emoji.repeat(35))) === false, '截断结果不应含孤立代理字符');
    assert([...cut('𠮷'.repeat(35))].length === 30, '扩展汉字应按码点计数');
  });

  await check('topic-recommend Markdown 表格单元格统一转义', async () => {
    const src = readFileSync(join(SRC_DIR, 'topic-recommend.js'), 'utf8');
    assert(/const cell = \(v\) =>/.test(src), '应存在统一转义函数 cell()');
    // 只转义 title 的旧写法必须消失
    assert(!/t\.title\.replace\(\/\\\|/.test(src), '不应只转义 title 的 |');
  });

  await check('runner 用 process.exitCode（避免截断管道 stdout）', () => {
    const src = readFileSync(INDEX, 'utf8');
    // 去掉注释行，避免注释里的 process.exit() 造成误报
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert(!/process\.exit\s*\(/.test(code), '代码中不应再调用 process.exit()（会截断管道/文件 stdout）');
    assert(/process\.exitCode\s*=/.test(src), '应通过 process.exitCode 设置退出码');
  });

  await check('browser.js 不再调用无效的 grantPermissions', () => {
    const src = readFileSync(join(SRC_DIR, 'browser.js'), 'utf8');
    assert(!/\.grantPermissions\s*\(/.test(src), 'grantPermissions 传 {origin} 对象会抛 TypeError（无效调用），应移除');
    // 反证：这正是原调用被 catch 静默吞掉的原因
    let threw = false;
    try { new URL({ origin: 'https://mp.toutiao.com' }); } catch { threw = true; }
    assert(threw, 'new URL({origin}) 应抛错（用于说明原调用无效）');
  });

  await check('评论去重使用 作者+正文+时间 复合键', () => {
    const src = readFileSync(join(SRC_DIR, 'comment-manage.js'), 'utf8');
    assert(!/seen\.has\(content\)/.test(src), '不应只按正文去重（内容相同的多条评论会被漏报）');
    assert(/seen\.has\(key\)/.test(src), '应使用复合去重键');
  });

  await check('发布核验：短正文残留可检出（B2）+ 视频页要求正向信号（B6）', async () => {
    const { verifyPublishOnPage, failureResult } = await mod('publish-verify.js');
    const stub = (state) => ({ evaluate: async () => state });
    const BASE = { url: 'https://mp.toutiao.com/profile_v4/graphic/publish', editorLen: 0, blocked: '', containsExpected: false, hasSuccessText: false };

    // B2：正文 12 字仍留在编辑器（旧口径 editorLen>20 判不出来）
    const short = await verifyPublishOnPage(
      stub({ ...BASE, editorLen: 12, containsExpected: true }),
      '[contenteditable="true"]', { expectText: '这是一段十二个字的短正文内容' }
    );
    assert(short.reallyPublished === false, 'B2: 短正文残留应判未发布');
    assert(short.stillInEditor === true, 'B2: stillInEditor 应为 true');
    assert(/与本次正文匹配/.test(failureResult('publish', short).reason), 'B2: reason 应说明与本次正文匹配');

    // B2 不误伤：编辑器已清空仍判成功
    const ok = await verifyPublishOnPage(stub({ ...BASE }), '[contenteditable="true"]', { expectText: '正文' });
    assert(ok.reallyPublished === true, 'B2: 编辑器已清空应判成功');

    // B6：视频页停留在原地址且无成功提示 → 必须失败（旧实现只看"无拦截词"会判成功）
    const stuck = await verifyPublishOnPage(
      stub({ ...BASE, url: 'https://mp.toutiao.com/profile_v4/xigua/upload-video' }),
      '[contenteditable="true"]', { requirePositive: true, originalUrl: 'https://mp.toutiao.com/profile_v4/xigua/upload-video' }
    );
    assert(stuck.reallyPublished === false, 'B6: 无正向信号应判未发布');
    assert(stuck.positive === false, 'B6: positive 应为 false');

    // B6：已离开原地址 → 成功
    const left = await verifyPublishOnPage(
      stub({ ...BASE, url: 'https://mp.toutiao.com/profile_v4/xigua/content' }),
      '[contenteditable="true"]', { requirePositive: true, originalUrl: 'https://mp.toutiao.com/profile_v4/xigua/upload-video' }
    );
    assert(left.reallyPublished === true, 'B6: 已离开原地址应判成功');

    // 未要求正向信号时 positive 为 null（区分"未检查"与"未通过"）
    assert(ok.positive === null, 'positive 未检查时应为 null');

    // 源码级：两个调用点都要传新参数，避免回退
    const art = readFileSync(join(SRC_DIR, 'publish-article.js'), 'utf8');
    assert(/expectText: content/.test(art), 'publish-article 应传 expectText');
    const vid = readFileSync(join(SRC_DIR, 'publish-video.js'), 'utf8');
    assert(/requirePositive: true/.test(vid), 'publish-video 应传 requirePositive');
    const wtt = readFileSync(join(SRC_DIR, 'publish-weitoutiao.js'), 'utf8');
    assert(/containsExpected/.test(wtt), 'publish-weitoutiao 应做签名比对');
  });

  await check('vl 分支判定覆盖全部分支', async () => {
    const { classifyVL } = await mod('verify.js');
    const cases = [
      [40, null, null, true, 'normal'],
      [60, null, null, true, 'weighted'],
      [15, { title: '审核中' }, null, true, 'in_review'],
      [15, { status: 3, title: '' }, null, false, 'restricted'],
      [15, { title: '其它' }, null, null, 'restricted_unknown'],
      [45, null, { reason: '限流' }, false, 'suppressed'],
      [45, null, null, true, 'review_transition'],
      [99, null, null, null, 'unknown'],
    ];
    for (const [vl, review, sup, expOk, expVerdict] of cases) {
      const r = classifyVL(vl, review, sup);
      assert(r.ok === expOk, `vl=${vl} 的 ok 期望 ${expOk}，实际 ${r.ok}`);
      assert(r.verdict === expVerdict, `vl=${vl} 的 verdict 期望 ${expVerdict}，实际 ${r.verdict}`);
    }
  });

  await check('runtimeDir 落在 ~/.toutiao-ops 下（不写包内）', async () => {
    const { BASE_DIR, runtimeDir } = await mod('paths.js');
    const d = runtimeDir('smoke');
    assert(d.startsWith(BASE_DIR), `runtimeDir 返回 ${d}，不在 ${BASE_DIR} 下`);
    assert(existsSync(d), 'runtimeDir 未创建目录');
    assert(!d.startsWith(CLI_DIR), '运行时目录不得落在包内');
  });

  // ── E. 漏斗端到端（合成数据 + 注入夹具，不依赖本机真实词表/域库） ──
  await check('漏斗端到端：阶段齐全且各阶段计数准确', async () => {
    const { runPipeline } = await mod('pipeline.js');
    // 示例文件复制成"真实文件名"：内容确定（占位词不命中），且不触发 degraded
    const dataDir = makeTempDataDir({
      'blocklist.json': readData('blocklist.example.json'),
      'domains.json': readData('domains.example.json'),
    });
    // 前两条完全相同，且含示例域库关键词（"生活""入秋"），确保能走到 dedupe
    const items = [
      { title: '生活记录：入秋的第一杯奶茶' },
      { title: '生活记录：入秋的第一杯奶茶' },
      { title: '100% 生活妙招' },
    ];
    const res = await runPipeline(items, { dataDir });

    assert(res.counts.in === 3, `counts.in 应为 3，实际 ${res.counts.in}`);
    assert(res.counts.out === res.items.length, 'counts.out 与实际输出条数不一致');
    for (const must of ['compliance', 'domainMatch', 'dedupe']) {
      assert(res.stages.some((s) => s.id === must), `漏斗缺少阶段 ${must}`);
    }

    const compliance = res.stages.find((s) => s.id === 'compliance');
    assert(compliance.kept === 3 && compliance.dropped === 0,
      `示例词表全是占位词，compliance 不应丢弃：kept=${compliance.kept} dropped=${compliance.dropped}`);

    const domain = res.stages.find((s) => s.id === 'domainMatch');
    assert(domain.kept === 3 && domain.dropped === 0,
      `domainMatch 不应丢弃：kept=${domain.kept} dropped=${domain.dropped}`);

    const dedupe = res.stages.find((s) => s.id === 'dedupe');
    assert(dedupe.in === 3 && dedupe.kept === 2 && dedupe.dropped === 1,
      `dedupe 应 3→2，实际 in=${dedupe.in} kept=${dedupe.kept} dropped=${dedupe.dropped}`);
    assert(dedupe.reasons && dedupe.reasons.duplicate === 1,
      `dedupe.reasons 应记录 1 条 duplicate，实际 ${JSON.stringify(dedupe.reasons)}`);

    // degraded 必须与阶段自报一致（替代原来恒真的 typeof 断言）
    assert(res.degraded === res.stages.some((s) => s.degraded), 'res.degraded 与阶段自报不一致');
    assert(res.degraded === false, '注入完整夹具后不应降级');
  });

  await check('漏斗端到端：命中丢弃分支（违禁词命中 / 领域不匹配）', async () => {
    const { runPipeline } = await mod('pipeline.js');
    const dataDir = makeTempDataDir({
      'blocklist.json': { categories: { illegal: { words: ['违禁词'] } } },
      'domains.json': { domains: { life: { keywords: ['生活'] } } },
    });
    const res = await runPipeline(
      [{ title: '含违禁词的标题' }, { title: '生活记录' }, { title: '与领域无关的内容' }],
      { dataDir },
    );
    const compliance = res.stages.find((s) => s.id === 'compliance');
    assert(compliance.dropped === 1 && String(Object.keys(compliance.reasons)[0]).startsWith('blocklist:illegal:'),
      `compliance 应命中违禁词丢弃 1 条，实际 dropped=${compliance.dropped} reasons=${JSON.stringify(compliance.reasons)}`);
    const domain = res.stages.find((s) => s.id === 'domainMatch');
    assert(domain.dropped === 1 && domain.reasons['domain:no_match'] === 1,
      `domainMatch 应因未命中丢弃 1 条，实际 dropped=${domain.dropped} reasons=${JSON.stringify(domain.reasons)}`);
    assert(res.counts.out === 1, `最终应剩 1 条，实际 ${res.counts.out}`);
  });

  await check('漏斗降级判定：数据文件缺失时 degraded=true，齐全时 false', async () => {
    const { runPipeline } = await mod('pipeline.js');
    const empty = makeTempDataDir({});
    const degradedRes = await runPipeline([{ title: '任意' }], { dataDir: empty });
    assert(degradedRes.degraded === true, '空数据目录应判定为降级');
    const flagged = degradedRes.stages.filter((s) => s.degraded).map((s) => s.id);
    assert(flagged.includes('compliance') && flagged.includes('domainMatch'),
      `应标记 compliance/domainMatch 降级，实际 ${flagged.join(', ')}`);

    const okDir = makeTempDataDir({
      'blocklist.json': readData('blocklist.example.json'),
      'domains.json': readData('domains.example.json'),
    });
    const okRes = await runPipeline([{ title: '生活' }], { dataDir: okDir });
    assert(okRes.degraded === false, '数据文件齐全时不应降级');
  });

  // ── F. 防回归 ──
  await check('产品代码不写包内 output/', () => {
    const offenders = [];
    for (const f of moduleFiles) {
      if (/'output'|"output"/.test(readFileSync(f, 'utf8'))) offenders.push(relative(CLI_DIR, f));
    }
    assert(offenders.length === 0, `仍在引用包内 output/：${offenders.join(', ')}`);
  });

  await check('仓库根目录必备文件齐全', () => {
    const required = [
      'README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
      'Makefile', '.editorconfig', '.gitattributes', '.gitignore', '.clawignore',
      'SKILL.md', 'AGENTS.md', 'CLAUDE.md',
    ];
    const missing = required.filter((f) => !existsSync(join(ROOT_DIR, f)));
    assert(missing.length === 0, `缺少：${missing.join(', ')}`);
  });

  await check('cli/ 根目录只放 index.js（临时脚本归入 tools/）', () => {
    const stray = readdirSync(CLI_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(mjs|js)$/.test(e.name) && e.name !== 'index.js')
      .map((e) => e.name);
    assert(stray.length === 0, `cli/ 根目录出现临时脚本：${stray.join(', ')}`);
  });

  await check('落盘模块统一经 src/paths.js', () => {
    const expect = ['verify.js', 'topic-recommend.js', join('signals', 'external-hot.js')];
    const bad = [];
    for (const f of expect) {
      const s = readFileSync(join(SRC_DIR, f), 'utf8');
      if (!/from\s+'[^']*paths\.js'/.test(s)) bad.push(f);
    }
    assert(bad.length === 0, `未使用 paths.js：${bad.join(', ')}`);
  });

  await check('已废弃的空实现参数不得复活', () => {
    const cases = [
      [['content', 'list', '--help'], ['--type', '--status', '--page'], ['--limit']],
      [['comment', 'list', '--help'], ['--article-id', '--page'], ['--with-replies']],
      [['analytics', 'works', '--help'], ['--period'], ['--type']],
      [['analytics', 'income', '--help'], ['--period'], ['--type']],
    ];
    for (const [args, forbidden, required] of cases) {
      const help = runCli(args);
      const where = args.join(' ');
      for (const f of forbidden) {
        assert(!hasOption(help, f), `${where} 不应再出现 ${f}（该参数是空实现，已移除）`);
      }
      for (const r of required) {
        assert(hasOption(help, r), `${where} 应保留 ${r}`);
      }
    }
  });

  await check('publish article 缺封面时快速失败且不进浏览器', () => {
    const r = runCliExpectFail(['publish', 'article', '--title', '冒烟测试']);
    assert(r.code !== 0, `应返回非 0 退出码，实际 ${r.code}`);
    assert(/封面/.test(r.out), `错误信息应提到封面，实际：${r.out.slice(0, 200)}`);
    assert(!/playwright|browserType|Timeout/i.test(r.out), '不应进入浏览器流程');
  });

  await check('publish article 正文为空 / triple 张数不足时快速失败且不进浏览器', () => {
    // 空正文：旧实现会跳过输入、发出只有标题的文章并报成功
    const empty = runCliExpectFail(['publish', 'article', '--title', '冒烟测试', '--content', '   ', '--cover-mode', 'none']);
    assert(empty.code !== 0, `空正文应返回非 0 退出码，实际 ${empty.code}`);
    assert(/正文/.test(empty.out), `错误信息应提到正文，实际：${empty.out.slice(0, 200)}`);
    assert(!/playwright|browserType|Timeout/i.test(empty.out), '空正文不应进入浏览器流程');

    // 空正文文件
    const emptyFile = join(tmpdir(), `toutiao-ops-smoke-empty-${Date.now()}.txt`);
    writeFileSync(emptyFile, '   \n  \n', 'utf8');
    tempDirs.push(emptyFile); // 复用清理逻辑（rmSync 对文件同样适用）
    const fromFile = runCliExpectFail(['publish', 'article', '--title', '冒烟测试', '--content-file', emptyFile, '--cover-mode', 'none']);
    assert(fromFile.code !== 0, `空正文文件应返回非 0 退出码，实际 ${fromFile.code}`);
    assert(/正文/.test(fromFile.out), `错误信息应提到正文，实际：${fromFile.out.slice(0, 200)}`);

    // 不存在的正文文件：应在启动浏览器前就报错
    const missing = runCliExpectFail(['publish', 'article', '--title', '冒烟测试', '--content-file', join(tmpdir(), 'no-such-file-xyz.md'), '--cover-mode', 'none']);
    assert(missing.code !== 0, `不存在的正文文件应返回非 0 退出码，实际 ${missing.code}`);
    assert(/读取正文文件失败/.test(missing.out), `错误信息应提到读取失败，实际：${missing.out.slice(0, 200)}`);
    assert(!/playwright|browserType|Timeout/i.test(missing.out), '不应进入浏览器流程');

    // triple 只给 1 张封面：旧实现会以单图静默继续
    const triple = runCliExpectFail(['publish', 'article', '--title', '冒烟测试', '--content', '正文', '--cover-mode', 'triple', '--cover', 'only-one.jpg']);
    assert(triple.code !== 0, `triple 张数不足应返回非 0 退出码，实际 ${triple.code}`);
    assert(/3 张封面/.test(triple.out), `错误信息应提到 3 张封面，实际：${triple.out.slice(0, 200)}`);
    assert(!/playwright|browserType|Timeout/i.test(triple.out), '不应进入浏览器流程');
  });

  // ── G. 退出码契约：run() 的 success:false / verdict:fail 同样必须 exit 1（不抛异常） ──
  await check('退出码契约：业务失败（success:false）走非零退出码且输出合法 JSON', async () => {
    const { runPipeline } = await mod('pipeline.js');
    // 用注入的空数据目录强制降级，而不是依赖宿主 cli/data 是否放了真实词表。
    // 原实现 `if (!(await runPipeline([])).degraded) return;` 在本机（有真实词表时）
    // 会直接跳过、什么都不断言，属于空跑用例。
    const emptyDir = makeTempDataDir({});
    const degraded = (await runPipeline([], { dataDir: emptyDir })).degraded;
    assert(degraded, '注入空数据目录时漏斗应降级（夹具失效）');

    // 该命令会真的去启动浏览器，故仅在漏斗确实降级时才跑（CI 必然降级）；
    // 本机若已放真实词表/域库，走同一降级夹具无法影响 CLI 进程，故仍跳过。
    if (!(await runPipeline([])).degraded) return;
    const r = runCliExpectFail(['topic-recommend', '--account', 'smoke-offline']);
    assert(r.code === 1, `期望 exit 1，实际 ${r.code}`);
    const j = JSON.parse(r.out);
    assert(j.success === false, `期望 success=false，实际 ${j.success}`);
    assert(Array.isArray(j.degradedStages) && j.degradedStages.length > 0, '应列出 degradedStages');
  });

  // ── 汇总 ──
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });

  console.log('冒烟测试（离线，无浏览器）\n');
  console.log(lines.join('\n'));
  console.log(`\n通过 ${pass} / 共 ${pass + fail}`);
  if (fail > 0) {
    console.log(`\n失败 ${fail} 项`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
