#!/usr/bin/env node

import { Command } from 'commander';
import { checkLogin, doLogin, doLogout, listAccounts } from './src/auth.js';
import { publishArticle } from './src/publish-article.js';
import { publishVideo } from './src/publish-video.js';
import { publishWeitoutiao } from './src/publish-weitoutiao.js';
import { listContent } from './src/content-manage.js';
import { listComments, replyComment, likeComment } from './src/comment-manage.js';
import { getWorksAnalytics, getFansAnalytics, getIncomeAnalytics, getContentDetail } from './src/analytics.js';
import { listInspiration } from './src/inspiration.js';
import { listMessages } from './src/message-center.js';
import { listTopicSignals } from './src/topic-signals.js';
import { verifyPublish } from './src/verify.js';
import { recommendTopics } from './src/topic-recommend.js';
import { checkForUpdates } from './src/update-check.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// 版本号以 package.json 为准，避免硬编码不同步
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('toutiao')
  .description('今日头条创作者平台运营自动化工具')
  .version(pkg.version)
  .option('--account <name>', '指定操作的账号（默认 default）', 'default');

// ── auth ──
const auth = program.command('auth');

auth
  .command('check')
  .description('检测头条号登录状态')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(checkLogin, opts);
  });

auth
  .command('login')
  .description('打开浏览器手动扫码登录')
  .action(async (opts) => {
    await run(doLogin, opts);
  });

auth
  .command('logout')
  .description('清除登录缓存（退出登录，用于切换账号）')
  .action(async (opts) => {
    await run(doLogout, opts);
  });

auth
  .command('list')
  .description('列出所有已保存的账号')
  .action(async () => {
    await run(listAccounts, {});
  });

// ── publish ──
const publish = program.command('publish');

publish
  .command('article')
  .description('发布图文文章')
  .requiredOption('--title <title>', '文章标题')
  .option('--content <content>', '文章正文')
  .option('--content-file <path>', '从文件读取正文（支持 .md 文件自动识别为 Markdown）')
  .option('--format <format>', '正文格式: text（纯文本）/ markdown（富文本排版）', 'markdown')
  .option('--cover <path>', '封面图片路径（--cover-mode single / triple 时必填）')
  .option('--cover-mode <mode>', '封面模式: single / triple / none（none 时无需 --cover）', 'single')
  .option('--first-publish', '勾选"头条首发"')
  .option('--collection <name>', '添加至合集名称')
  .option('--no-weitoutiao', '取消"同时发布微头条"（默认开启）')
  .option('--declaration <items>', '作品声明，逗号分隔: 取材网络,引用站内,个人观点,引用AI,虚构演绎,投资观点,健康医疗')
  .option('--draft', '存为草稿而非直接发布')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(publishArticle, opts);
  });

publish
  .command('video')
  .description('发布视频')
  .requiredOption('--file <path>', '视频文件路径')
  .requiredOption('--title <title>', '视频标题')
  .option('--topic <topic>', '话题名称（不含 #）')
  .option('--cover <path>', '封面图片路径')
  .option('--description <desc>', '视频简介')
  .option('--gen-article', '勾选"生成图文"获取额外图文创作收益')
  .option('--collection <name>', '添加至合集名称')
  .option('--declaration <items>', '作品声明，逗号分隔: 取自站外,引用站内,自行拍摄,AI生成,虚构演绎,投资观点,健康医疗')
  .option('--visibility <mode>', '谁可以看: public / fans / private', 'public')
  .option('--draft', '存为草稿而非直接发布')
  .option('--debug', '落全页调试截图并输出步骤日志')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(publishVideo, opts);
  });

publish
  .command('weitoutiao')
  .description('发布微头条')
  .requiredOption('--content <content>', '微头条内容')
  .option('--images <paths>', '图片路径，逗号分隔')
  .option('--topic <topic>', '话题名称（不含 #）')
  .option('--first-publish', '勾选"头条首发"')
  .option('--declaration <items>', '作品声明，逗号分隔: 取材网络,引用站内,个人观点,引用AI,虚构演绎,投资观点,健康医疗')
  .option('--draft', '存草稿而非发布')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(publishWeitoutiao, opts);
  });

// ── content ──
const content = program.command('content');

content
  .command('list')
  .description('查看作品列表（已发布 + 全部类型）')
  .option('--limit <n>', '返回条数（接口 page_size）', '20')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(listContent, opts);
  });

// ── comment ──
const comment = program.command('comment');

comment
  .command('list')
  .description('查看评论列表')
  .option('--with-replies', '同时获取每条评论的子评论/回复')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(listComments, opts);
  });

comment
  .command('reply')
  .description('回复评论')
  .requiredOption('--comment-id <id>', '评论 ID 或内容片段')
  .requiredOption('--content <content>', '回复内容')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(replyComment, opts);
  });

comment
  .command('like')
  .description('点赞评论')
  .requiredOption('--comment-id <id>', '评论 ID 或内容片段')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(likeComment, opts);
  });

// ── analytics ──
const analytics = program.command('analytics');

analytics
  .command('works')
  .description('查看作品数据')
  .option('--type <type>', '类型: all / article / video / weitoutiao', 'all')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(getWorksAnalytics, opts);
  });

analytics
  .command('fans')
  .description('查看粉丝数据')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(getFansAnalytics, opts);
  });

analytics
  .command('income')
  .description('查看收益数据')
  .option('--type <type>', '类型: all / article / video', 'all')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(getIncomeAnalytics, opts);
  });

analytics
  .command('content-detail')
  .description('查看单个作品的详细数据')
  .option('--content-id <id>', '作品 ID（item_id / gidStr）')
  .option('--content-type <type>', '内容类型编号: 2=图文/微头条, 3=视频', '2')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(getContentDetail, opts);
  });

// ── inspiration ──
program
  .command('inspiration')
  .description('查看创作灵感')
  .option('--type <type>', '类型: activity（创作活动）/ hotspot（热点推荐）', 'activity')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(listInspiration, opts);
  });

// ── message-center ──
program
  .command('message-center')
  .description('拉取消息中心推送（话题邀请/活动通知/作者成长助手等）')
  .option('--type <type>', '分类：语义名/中文，逗号分隔；all=全部')
  .option('--box-type <n>', '按 box_type 数字指定，逗号分隔，如 1025,1022')
  .option('--all', '包含互动类（评论和@/点赞/粉丝）')
  .option('--limit <n>', '每页数量', '10')
  .option('--max-pages <n>', '每个分类最多翻页数', '5')
  .option('--raw', '输出原始 cell 数据（体积较大）')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(listMessages, opts);
  });

// ── topic-signals ──
program
  .command('topic-signals')
  .description('拉取选题信号（一级：消息中心/作品数据；二级：外部热点）')
  .option('--source <ids>', '指定信号源，逗号分隔：message-center,works-analytics,external-hot')
  .option('--filter', '套用三级漏斗（合规→域匹配→排重）')
  .option('--limit <n>', '消息中心每页数量', '10')
  .option('--max-pages <n>', '消息中心每分类最多翻页数', '1')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(listTopicSignals, opts);
  });

// ── verify ──
program
  .command('verify')
  .description('发布后核验（草稿箱自检 / 条数+1 / 读取作品 / 重复检测）')
  .option('--content <text>', '目标正文片段（用于定位与比对）')
  .option('--title <text>', '目标标题（无正文时使用）')
  .option('--before-count <n>', '发布前的作品总数（用于核对 +1）')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(verifyPublish, opts);
  });

// ── topic-recommend ──
program
  .command('topic-recommend')
  .description('选题推荐：信号加权打分排序，输出 JSON + Markdown + 落盘')
  .option('--top <n>', '输出条数（默认取 weights.json 的 ranking.topN）')
  .option('--source <ids>', '指定信号源，逗号分隔：message-center,works-analytics,external-hot')
  .option('--no-filter', '跳过三级漏斗（不过滤，直接对全部信号打分）')
  .option('--allow-degraded', '漏斗降级（词表/域库缺失）时仍继续输出推荐')
  .option('--limit <n>', '消息中心每页数量', '10')
  .option('--max-pages <n>', '消息中心每分类最多翻页数', '1')
  .option('--headless', '无头模式运行')
  .action(async (opts) => {
    await run(recommendTopics, opts);
  });

// ── runner ──
async function run(fn, subOpts) {
  const updateCheck = checkForUpdates();
  try {
    const globalOpts = program.opts();
    const opts = { ...subOpts, account: globalOpts.account };
    const result = await fn(opts);
    await updateCheck;
    console.log(JSON.stringify(result, null, 2));
    // 业务失败（success:false 或核验 verdict:fail）也返回非零退出码，便于脚本/Agent 判定
    const failed = Boolean(result) && (result.success === false || result.verdict === 'fail');
    process.exit(failed ? 1 : 0);
  } catch (err) {
    await updateCheck.catch(() => {});
    console.error(JSON.stringify({ error: err.message, stack: err.stack }, null, 2));
    process.exit(1);
  }
}

program.parse();
