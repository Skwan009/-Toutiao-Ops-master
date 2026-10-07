import { launchBrowser, closeBrowser, sleep, waitForStable, dismissOverlays } from './browser.js';
import { ensureLoggedIn } from './auth-guard.js';

const PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/weitoutiao/publish';

/**
 * 发布微头条。
 * 参数:
 *   --content      微头条正文（必填）
 *   --images       图片路径，逗号分隔
 *   --topic        话题名称（不含 #）
 *   --first-publish 勾选"头条首发"
 *   --declaration  作品声明，逗号分隔，可选值: 取材网络,引用站内,个人观点,引用AI,虚构演绎,投资观点,健康医疗
 *   --draft        存草稿而非发布
 */
export async function publishWeitoutiao(opts) {
  const { context, page } = await launchBrowser(opts);
  try {
    await ensureLoggedIn(page);
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForStable(page);
    await sleep(1500, 2500);
    await dismissOverlays(page);

    // ── 输入内容 ──
    const editorSelector = [
      '[contenteditable="true"]',
      '[class*="editor"] [contenteditable]',
      'textarea',
    ].join(', ');
    await page.waitForSelector(editorSelector, { timeout: 15000 });
    await sleep(300, 600);
    await page.click(editorSelector, { force: true });
    await sleep(200, 400);

    // ⚠️ 必须先清空编辑器（2026-10-04 修复）
    // 头条发布页会自动恢复上次未发布的内容作为草稿。若不清空，重试发布时
    // 新正文会直接叠在旧正文上，导致"两篇内容粘在一起"。
    // 症状：回执 success:true 但作品列表里根本没有这条内容。
    await page.keyboard.press('Control+a');
    await sleep(150, 300);
    await page.keyboard.press('Delete');
    await sleep(300, 500);
    // 二次保险：若编辑器仍非空，再删一次
    for (let i = 0; i < 2; i++) {
      const still = await page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? (el.innerText || el.value || '').trim().length : 0;
        }, editorSelector)
        .catch(() => 0);
      if (!still) break;
      await page.keyboard.press('Control+a');
      await sleep(150, 250);
      await page.keyboard.press('Delete');
      await sleep(300, 500);
    }

    // 将字面量 \n 转换为真正的换行符
    const text = opts.content.replace(/\\n/g, '\n');
    const paragraphs = text.split('\n');
    for (let i = 0; i < paragraphs.length; i++) {
      const para = paragraphs[i];
      if (para) {
        await page.keyboard.type(para, { delay: 40 + Math.random() * 80 });
      }
      if (i < paragraphs.length - 1) {
        await page.keyboard.press('Enter');
        await sleep(100, 300);
      }
    }
    await sleep(500, 1000);

    // ── 图片上传 ──
    if (opts.images) {
      const imagePaths = opts.images.split(',').map(p => p.trim()).filter(Boolean);
      if (imagePaths.length > 0) {
        await uploadImages(page, imagePaths);
      }
    }
    await sleep(500, 1000);

    // ── 话题 ──
    if (opts.topic) {
      await setTopic(page, opts.topic);
    }
    await sleep(300, 600);

    // ── 声明首发 ──
    if (opts.firstPublish) {
      await checkFirstPublish(page);
    }
    await sleep(300, 600);

    // ── 作品声明 ──
    if (opts.declaration) {
      await setDeclarations(page, opts.declaration);
    }
    await sleep(500, 1000);

    // ── 发布 / 存草稿 ──
    await dismissOverlays(page);

    if (opts.draft) {
      const draftBtn = page.locator('button:has-text("存草稿")').first();
      await draftBtn.click({ timeout: 10000 });
    } else {
      const publishBtn = page.locator('button:has-text("发布")').first();
      await publishBtn.click({ timeout: 10000 });
    }

    await sleep(2000, 4000);
    await waitForStable(page);

    // ⚠️ 必须验证发布是否真的成功（2026-10-04 修复）
    // 旧实现点完按钮就无条件返回 success:true —— 头条发布页在内容不合法、
    // 或有未处理的弹窗时会静默失败，回执照样是"成功"，导致内容实际没发出去。
    // 现在改为：读页面真实状态，判断是否已跳转到内容管理页 / 编辑器是否已清空。
    const verify = await page
      .evaluate(() => {
        const url = location.href;
        const editor = document.querySelector('[contenteditable="true"]');
        const editorText = editor ? (editor.innerText || '').trim() : '';
        // 正文仍留在编辑器里 = 没发出去
        const stillInEditor = editorText.length > 20;
        // 页面出现这些字样说明发布被拦截
        const body = document.body.innerText || '';
        const blocked = [];
        if (/存在风险|无法发布|请修改|内容违规|发布失败|去重|重复内容/.test(body))
          blocked.push(body.match(/存在风险|无法发布|请修改|内容违规|发布失败|去重|重复内容/)[0]);
        return { url, stillInEditor, editorLen: editorText.length, blocked };
      })
      .catch(() => ({ url: '', stillInEditor: null, editorLen: 0, blocked: [] }));

    // 判定"提交"的依据：编辑器已清空（正文交出去了）且页面无拦截提示。
    // ⚠️ 不要用"跳转到内容管理页"作条件 —— 头条发布成功后停在
    //    /profile_v4/weitoutiao（微头条管理页），不是 /content/all，
    //    拿内容管理页当判据会把成功误报成失败（10-04 实测踩过）。
    const reallyPublished = !verify.stillInEditor && verify.blocked.length === 0;

    if (!reallyPublished) {
      const reason =
        verify.stillInEditor
          ? `正文仍留在编辑器（${verify.editorLen} 字）—— 发布未生效，多半是页面有未处理弹窗或内容被拦截`
          : verify.blocked.length
          ? `页面出现拦截提示："${verify.blocked.join(', ')}"`
          : `未跳转到内容管理页（当前 ${verify.url || '未知'}）`;
      console.error('[FAIL] ' + reason);
      console.error('[FAIL] 请勿重试重发！先在草稿箱/作品管理确认实际状态，' +
        '避免内容叠加。CLI 已修复"打字前清空编辑器"，重复内容问题已解决。');
      return {
        success: false,
        action: 'publish_failed',
        reason,
        verify,
        content: opts.content.substring(0, 50) + (opts.content.length > 50 ? '...' : ''),
      };
    }

    return {
      success: true,
      action: opts.draft ? 'draft_saved' : 'published',
      verified: true,
      content: opts.content.substring(0, 50) + (opts.content.length > 50 ? '...' : ''),
      url: page.url(),
    };
  } finally {
    await closeBrowser(context);
  }
}

async function uploadImages(page, imagePaths) {
  try {
    // 先点击"图片"按钮打开上传对话框
    const imgBtn = page.locator('text=图片').first();
    await imgBtn.click({ timeout: 5000 });
    await sleep(800, 1200);

    // 在对话框中找到文件输入并上传
    const fileInput = page.locator('input[type="file"][accept*="image"]').first();
    await fileInput.setInputFiles(imagePaths);
    await sleep(3000, 5000);

    // 等待图片上传完成，点击"确定"按钮关闭对话框
    const confirmBtn = page.locator('button:has-text("确定")').first();
    await confirmBtn.waitFor({ timeout: 10000 });
    await sleep(500, 800);
    await confirmBtn.click();
    await sleep(1000, 2000);
  } catch {
    // 图片上传失败不阻塞发布
  }
}

async function setTopic(page, topicName) {
  // 可靠做法：唤起编辑器内置话题面板（输入 # 触发搜索），点选官方话题，
  // 这样即使话题名含空格（如「上头条 聊热点」）也能正确参与活动。
  // 兜底：若面板未出现匹配项，则回退为纯文本 #话题#（带空格话题大概率不参与活动）。
  try {
    const editorSelector = [
      '[contenteditable="true"]',
      '[class*="editor"] [contenteditable]',
      'textarea',
    ].join(', ');
    await page.click(editorSelector, { force: true }).catch(() => {});
    await page.keyboard.press('Control+End');
    await sleep(150, 300);
    // 新起一行，避免黏在正文末尾文字上
    await page.keyboard.press('Enter');
    await sleep(150, 250);
    // 触发话题搜索面板
    await page.keyboard.type('#', { delay: 90 });
    await sleep(500, 900);
    // 输入话题名（含空格也可，在搜索框内输入）
    await page.keyboard.type(topicName, { delay: 55 });
    await sleep(900, 1400);
    // 等待话题建议并点选官方话题
    const picked = await pickTopicSuggestion(page, topicName);
    if (picked) {
      await sleep(300, 600);
      console.error('[INFO] 话题已通过面板选中并参与: #' + topicName + '#');
      return;
    }
    // 兜底：敲闭合 # 形成纯文本话题
    await page.keyboard.type('#', { delay: 80 });
    await sleep(400, 800);
    console.error('[WARN] 未找到话题建议，已回退为纯文本 #' + topicName + '#（可能未参与活动）');
  } catch (e) {
    console.error('[WARN] 话题设置失败（正文打 #话题# 未生效）: ' + e.message);
  }
}

async function pickTopicSuggestion(page, topicName) {
  // 头条话题建议以可点击列表项呈现，文本包含话题名（可能带「阅读x亿」等后缀）。
  // 仅当元素文本核心就是该话题名时才点击，避免误点页面其他元素。
  const containers = [
    'li',
    '[class*="topic"]',
    '[class*="suggest"]',
    'div[role="option"]',
    '[class*="popup"] [class*="item"]',
  ];
  for (const sel of containers) {
    const items = page.locator(sel);
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const item = items.nth(i);
      const txt = (await item.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (txt && txt.includes(topicName) && txt.length <= topicName.length + 14) {
        await item.click({ timeout: 4000 }).catch(() => {});
        await sleep(300, 500);
        return true;
      }
    }
  }
  return false;
}

async function checkFirstPublish(page) {
  // 精准定位「头条首发」复选框并校验勾选状态，失败即告警（不再静默吞掉）。
  const candidates = [
    'label:has-text("头条首发")',
    'div:has-text("头条首发") >> input[type="checkbox"]',
    'text=头条首发',
  ];
  try {
    let done = false;
    for (const sel of candidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0) {
        await loc.click({ timeout: 4000 }).catch(() => {});
        await sleep(300, 500);
        // 校验是否真的勾上（针对 checkbox input）
        const checked = await page.evaluate(() => {
          const labels = [...document.querySelectorAll('label')].filter(l => l.textContent && l.textContent.includes('头条首发'));
          for (const l of labels) {
            const cb = l.querySelector('input[type="checkbox"]');
            if (cb) return cb.checked;
          }
          return null;
        });
        if (checked === true) {
          console.error('[INFO] 头条首发已勾选确认');
          done = true;
        } else if (checked === false) {
          console.error('[WARN] 头条首发点击后仍未勾选，尝试再次点击');
          await loc.click({ timeout: 3000 }).catch(() => {});
          await sleep(300, 500);
        }
        break;
      }
    }
    if (!done) console.error('[WARN] 未找到「头条首发」勾选框，首发可能未勾上');
  } catch (e) {
    console.error('[WARN] 头条首发勾选失败: ' + e.message);
  }
}

async function setDeclarations(page, declarationStr) {
  const declarations = declarationStr.split(',').map(d => d.trim()).filter(Boolean);
  const labelMap = {
    '取材网络': '取材网络',
    '引用站内': '引用站内',
    '个人观点': '个人观点，仅供参考',
    '引用AI': '引用AI',
    '虚构演绎': '虚构演绎，故事经历',
    '投资观点': '投资观点，仅供参考',
    '健康医疗': '健康医疗分享，仅供参考',
  };

  for (const decl of declarations) {
    const fullLabel = labelMap[decl] || decl;
    try {
      const checkbox = page.locator(`text=${fullLabel}`).first();
      await checkbox.click({ timeout: 3000 });
      await sleep(200, 400);
    } catch {
      // 单个声明勾选失败不阻塞
    }
  }
}
