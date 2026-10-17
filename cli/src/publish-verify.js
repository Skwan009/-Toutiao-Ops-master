/**
 * 发布后的页内判定，供各发布模块共用。
 * 判定口径：reallyPublished = 页面状态可读 且 正文已交出去 且 页面无拦截提示
 * 注意：不要用"跳转到内容管理页"作判据，头条发布成功后停留的页面因体裁而异。
 */
const BLOCK_RE_SRC = '存在风险|无法发布|请修改|内容违规|发布失败|去重|重复内容';
/** 正向成功信号（视频页没有 contenteditable，必须靠它兜底）；含草稿保存成功 */
const SUCCESS_RE_SRC = '发布成功|已发布|发布完成|提交成功|发布中|已保存|保存成功|草稿已保存';

/** 归一化：去掉空白与常见 Markdown 标记，便于跨渲染差异比对 */
function normalizeText(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[#*`>~|[\]()!_\\-]/g, '');
}

/**
 * 取文本"签名"：归一化后截取前 N 个字符。
 *
 * 用途：判断编辑器里残留的是不是本次要发布的正文。
 * 为什么不用"长度 > 20"：正文 ≤20 字时该阈值完全失效——短正文被拦截后仍留在
 * 编辑器里，却会被判成"已清空"，从而把失败报成发布成功。
 * 长度自适应：正文本身就短于 n 时取全文，否则短正文永远匹配不上。
 */
function signature(s, n = 12) {
  const cleaned = normalizeText(s);
  return cleaned.slice(0, Math.min(n, cleaned.length));
}

/**
 * 读取页面发布状态。
 *
 * @param {object} page Playwright page
 * @param {string} editorSelector 正文编辑器选择器
 * @param {object} [opts]
 * @param {string} [opts.expectText] 本次要发布的正文；提供后启用"签名比对"，
 *        可检出短正文残留（B2）
 * @param {boolean} [opts.requirePositive] 是否要求正向成功信号（视频页必须为 true，
 *        因为该页没有 contenteditable，"无拦截词"不能作为成功依据）（B6）
 * @param {string} [opts.originalUrl] 提交前的地址；用于判断是否已离开该页
 */
export async function verifyPublishOnPage(page, editorSelector = '[contenteditable="true"]', opts = {}) {
  const { expectText = '', requirePositive = false, originalUrl = '' } = opts;
  const expectSig = signature(expectText);

  // fail-closed：evaluate 抛错（点发布后发生跳转导致 execution context 销毁、页面被关、
  // frame detached）时，"读不到状态"绝不能被当成"已发布"，否则未发布也会返回 success:true。
  let evalFailed = false;
  const info = await page
    .evaluate(({ sel, sig, blockSrc, successSrc }) => {
      const editor = document.querySelector(sel);
      const editorText = editor ? (editor.innerText || '').trim() : '';
      const body = document.body.innerText || '';
      const norm = editorText
        .replace(/[\s\u3000]+/g, '')
        .replace(/[#*`>~|[\]()!_\\-]/g, '');
      const m = body.match(new RegExp(blockSrc));
      // 双向比对：既覆盖"编辑器内容包含正文"（正常残留），
      // 也覆盖"正文包含编辑器内容"（注入被截断，只落进去前几个字）
      const containsExpected = Boolean(sig) && sig.length >= 2
        && (norm.includes(sig) || sig.includes(norm.slice(0, sig.length)));
      return {
        url: location.href,
        editorLen: editorText.length,
        blocked: m ? m[0] : '',
        containsExpected,
        hasSuccessText: new RegExp(successSrc).test(body),
      };
    }, { sel: editorSelector, sig: expectSig, blockSrc: BLOCK_RE_SRC, successSrc: SUCCESS_RE_SRC })
    .catch(() => {
      evalFailed = true;
      return { url: '', editorLen: 0, blocked: '', containsExpected: false, hasSuccessText: false };
    });

  const stillInEditor = info.editorLen > 20 || info.containsExpected;
  const leftOriginalUrl = Boolean(originalUrl) && info.url !== originalUrl;
  const positive = leftOriginalUrl || info.hasSuccessText;

  return {
    reallyPublished: !evalFailed && !stillInEditor && !info.blocked && (!requirePositive || positive),
    evalFailed,
    stillInEditor,
    editorLen: info.editorLen,
    containsExpected: info.containsExpected,
    blocked: info.blocked,
    // 未要求正向信号时为 null，便于调用方区分"未检查"与"检查未通过"
    positive: requirePositive ? positive : null,
    leftOriginalUrl,
    url: info.url,
  };
}

/** 构造统一的业务失败返回体 */
export function failureResult(action, verify, extra = {}) {
  const reason = verify.evalFailed
    ? `页面状态读取失败（核验时可能发生了跳转或页面已关闭），未确认发布结果`
    : verify.stillInEditor
      ? `正文仍留在编辑器（${verify.editorLen} 字${verify.containsExpected ? '，且与本次正文匹配' : ''}）—— 发布未生效，多半是页面有未处理弹窗或内容被拦截`
      : verify.blocked
        ? `页面出现拦截提示："${verify.blocked}"`
        : verify.positive === false
          ? `未检测到发布成功的迹象（页面仍在原地址且无成功提示，当前 ${verify.url || '未知'}）`
          : `未确认发布成功（当前 ${verify.url || '未知'}）`;
  process.stderr.write(`[FAIL] ${reason}\n[FAIL] 请勿直接重试重发，先到草稿箱/作品管理核对实际状态\n`);
  return { success: false, action: `${action}_failed`, reason, verify, ...extra };
}
