#!/usr/bin/env node
/**
 * 最小冒烟测试：**不联网、不启动浏览器**，CI 与本地都能直接跑。
 *
 * 有意只覆盖"不需要真账号也会失败"的那部分：
 *   A. 所有 src 模块可导入（ESM 语法 / 无循环依赖）
 *   B. CLI 全部命令注册且帮助可输出
 *   C. 配置文件完整性（权重分层、类型表、信号源、漏斗、数据源、核验）
 *   D. 纯函数行为（作品接口 URL、counters 映射、vl 分支、运行时目录）
 *   E. 漏斗端到端（compliance → domainMatch → dedupe，用合成数据）
 *   F. 防回归断言（落盘路径、已废弃的空实现参数、封面条件必填、示例数据与配置对齐）
 *
 * 使用：node test/smoke.mjs   （或 npm test）
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname, relative } from 'path';
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

function runCli(args) {
  return execFileSync(process.execPath, [INDEX, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function runCliExpectFail(args) {
  try {
    const out = execFileSync(process.execPath, [INDEX, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const EXPECTED_COMMANDS = [
  'auth', 'publish', 'content', 'comment', 'analytics',
  'inspiration', 'message-center', 'topic-signals', 'verify', 'topic-recommend',
];

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
  await check('顶层帮助列出全部命令', () => {
    const help = runCli(['--help']);
    const missing = EXPECTED_COMMANDS.filter((c) => !help.includes(c));
    assert(missing.length === 0, `帮助中缺少命令：${missing.join(', ')}`);
  });

  await check('每个子命令的帮助可正常输出', () => {
    const broken = [];
    for (const c of EXPECTED_COMMANDS) {
      try {
        const h = runCli([c, '--help']);
        if (!h.includes('Usage:')) broken.push(`${c}（无 Usage）`);
      } catch (e) {
        broken.push(`${c}（退出码 ${e.status}）`);
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

  await check('verify.json 关键键完整', () => {
    const v = readCfg('verify.json');
    for (const k of ['pages', 'feedApiMatch', 'countApi', 'countStatus', 'appId', 'pageSize']) {
      assert(v[k] !== undefined, `缺键：${k}`);
    }
    assert(v.pages.content && v.pages.draft, 'pages.content / pages.draft 缺失');
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

  // ── E. 漏斗端到端（合成数据） ──
  await check('漏斗端到端：去重生效且阶段齐全', async () => {
    const { runPipeline } = await mod('pipeline.js');
    // 前两条完全相同且含域命中的关键词（真实/示例域库都含"生活""入秋"），确保能走到 dedupe
    const items = [
      { title: '生活记录：入秋的第一杯奶茶' },
      { title: '生活记录：入秋的第一杯奶茶' },
      { title: '100% 生活妙招' },
    ];
    const res = await runPipeline(items);
    assert(res.counts.in === 3, `counts.in 应为 3，实际 ${res.counts.in}`);
    assert(res.items.length <= 3, '输出条数不应超过输入');
    const ids = res.stages.map((s) => s.id);
    for (const must of ['compliance', 'domainMatch', 'dedupe']) {
      assert(ids.includes(must), `漏斗缺少阶段 ${must}`);
    }
    const dedupe = res.stages.find((s) => s.id === 'dedupe');
    assert(dedupe.dropped >= 1, `dedupe 应至少丢弃 1 条重复项，实际 ${dedupe.dropped}`);
    assert(typeof res.degraded === 'boolean', 'degraded 应为布尔值');
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
      for (const f of forbidden) {
        assert(!help.includes(f), `${args.join(' ')} 不应再出现 ${f}（该参数是空实现，已移除）`);
      }
      for (const r of required) {
        assert(help.includes(r), `${args.join(' ')} 应保留 ${r}`);
      }
    }
  });

  await check('publish article 缺封面时快速失败且不进浏览器', () => {
    const r = runCliExpectFail(['publish', 'article', '--title', '冒烟测试']);
    assert(r.code !== 0, `应返回非 0 退出码，实际 ${r.code}`);
    assert(/封面/.test(r.out), `错误信息应提到封面，实际：${r.out.slice(0, 200)}`);
    assert(!/playwright|browserType|Timeout/i.test(r.out), '不应进入浏览器流程');
  });

  // ── 汇总 ──
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
