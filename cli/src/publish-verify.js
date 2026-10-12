/**
 * 发布后的页内判定，供各发布模块共用。
 * 判定口径与 publish-weitoutiao.js 一致：
 *   reallyPublished = 编辑器已清空（正文交出去了）且页面无拦截提示
 * 注意：不要用"跳转到内容管理页"作判据，头条发布成功后停留的页面因体裁而异。
 */
const BLOCK_RE = /存在风险|无法发布|请修改|内容违规|发布失败|去重|重复内容/;

export async function verifyPublishOnPage(page, editorSelector = '[contenteditable="true"]') {
  // fail-closed：evaluate 抛错（点发布后发生跳转导致 execution context 销毁、页面被关、
  // frame detached）时，"读不到状态"绝不能被当成"已发布"，否则未发布也会返回 success:true。
  let evalFailed = false;
  const info = await page
    .evaluate((sel) => {
      const editor = document.querySelector(sel);
      const editorText = editor ? (editor.innerText || '').trim() : '';
      const body = document.body.innerText || '';
      const m = body.match(/存在风险|无法发布|请修改|内容违规|发布失败|去重|重复内容/);
      return { url: location.href, editorLen: editorText.length, blocked: m ? m[0] : '' };
    }, editorSelector)
    .catch(() => {
      evalFailed = true;
      return { url: '', editorLen: 0, blocked: '' };
    });

  const stillInEditor = info.editorLen > 20;
  return {
    reallyPublished: !evalFailed && !stillInEditor && !info.blocked,
    evalFailed,
    stillInEditor,
    editorLen: info.editorLen,
    blocked: info.blocked,
    url: info.url,
  };
}

/** 构造统一的业务失败返回体 */
export function failureResult(action, verify, extra = {}) {
  const reason = verify.evalFailed
    ? `页面状态读取失败（核验时可能发生了跳转或页面已关闭），未确认发布结果`
    : verify.stillInEditor
      ? `正文仍留在编辑器（${verify.editorLen} 字）—— 发布未生效，多半是页面有未处理弹窗或内容被拦截`
      : verify.blocked
        ? `页面出现拦截提示："${verify.blocked}"`
        : `未确认发布成功（当前 ${verify.url || '未知'}）`;
  process.stderr.write(`[FAIL] ${reason}\n[FAIL] 请勿直接重试重发，先到草稿箱/作品管理核对实际状态\n`);
  return { success: false, action: `${action}_failed`, reason, verify, ...extra };
}
