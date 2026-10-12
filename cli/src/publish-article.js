import { readFileSync } from 'fs';
import { marked } from 'marked';
import { launchBrowser, closeBrowser, sleep, waitForStable, dismissOverlays } from './browser.js';
import { ensureLoggedIn } from './auth-guard.js';
import { verifyPublishOnPage, failureResult } from './publish-verify.js';

const PUBLISH_URL = 'https://mp.toutiao.com/profile_v4/graphic/publish';
const TITLE_MAX_LEN = 30;
const TITLE_MIN_LEN = 2;

/**
 * 发布图文文章。
 * 参数:
 *   --title          文章标题（必填）
 *   --content        正文文本
 *   --content-file   从文件读取正文
 *   --cover          封面图片路径（--cover-mode single / triple 时必填）
 *   --cover-mode     封面模式: single / triple / none（默认 single；none 时无需 --cover）
 *   --first-publish  勾选"头条首发"
 *   --collection     添加至合集名称
 *   --no-weitoutiao  取消"同时发布微头条"
 *   --declaration    作品声明，逗号分隔
 *   --draft          存草稿
 */
export async function publishArticle(opts) {
  // 封面是条件必填：--cover-mode none 时不需要。先校验再启动浏览器，避免白开一次。
  const coverMode = opts.coverMode || 'single';
  if (coverMode !== 'none' && !opts.cover) {
    throw new Error('缺少封面图：--cover-mode single / triple 时必须提供 --cover <path>；若确实不要封面请加 --cover-mode none');
  }

  // 正文也必须在启动浏览器前读入并校验：
  //  1) 正文为空时若照旧跳过输入，会发出一条"只有标题"的文章，且核验按"编辑器已清空"判成功；
  //  2) --content-file 不存在/不可读时，原先要等浏览器起来并登录导航完才抛裸 ENOENT。
  let content = opts.content || '';
  if (opts.contentFile) {
    try {
      content = readFileSync(opts.contentFile, 'utf-8');
    } catch (e) {
      throw new Error(`读取正文文件失败：${opts.contentFile}（${e.message}）`);
    }
  }
  content = content.replace(/\\n/g, '\n');
  if (!content.trim()) {
    throw new Error('正文为空：请通过 --content 或 --content-file 提供正文内容');
  }

  // triple 模式需要 3 张封面：只给 1 张会以单图继续，等于静默降级
  if (coverMode === 'triple') {
    const coverCount = String(opts.cover || '').split(',').map((p) => p.trim()).filter(Boolean).length;
    if (coverCount < 3) {
      throw new Error(`--cover-mode triple 需要 3 张封面图，当前只提供 ${coverCount} 张：${opts.cover}`);
    }
  }

  const { context, page } = await launchBrowser(opts);
  try {
    await ensureLoggedIn(page);
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForStable(page);
    await sleep(1500, 2500);
    await dismissOverlays(page);

    // ── 标题（2~30 字） ──
    let title = opts.title;
    if (title.length < TITLE_MIN_LEN) {
      throw new Error(`标题过短：至少 ${TITLE_MIN_LEN} 个字，当前 ${title.length} 个字`);
    }
    if (title.length > TITLE_MAX_LEN) {
      title = title.slice(0, TITLE_MAX_LEN);
      process.stderr.write(`[warn] 标题超过 ${TITLE_MAX_LEN} 字限制，已自动截断为：${title}\n`);
    }
    const titleSelector = 'textarea[placeholder*="标题"], input[placeholder*="标题"], [class*="title"] textarea, [class*="title"] input';
    await page.waitForSelector(titleSelector, { timeout: 15000 });
    await sleep(300, 600);
    await page.click(titleSelector, { force: true });
    await page.keyboard.type(title, { delay: 50 + Math.random() * 80 });
    await sleep(500, 1000);

    // ── 正文 ──（content 已在启动浏览器前读入并校验非空）
    {
      const editorSelector = '[contenteditable="true"]';
      await page.waitForSelector(editorSelector, { timeout: 15000 });
      await sleep(300, 600);
      await page.click(editorSelector, { force: true });
      await sleep(200, 400);

      if (opts.format === 'markdown' || opts.contentFile?.match(/\.md$/i)) {
        await pasteMarkdownAsRichText(page, content, editorSelector);
      } else {
        await typePlainText(page, content);
      }

      // 读回校验：注入后编辑器必须真的有内容，否则后面会把"空正文"当成发布成功
      // （合成 ClipboardEvent 被编辑器忽略、点击落到别的 contenteditable 等都会导致静默丢失）
      const injected = await page
        .evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? (el.innerText || '').trim().length : -1;
        }, editorSelector)
        .catch(() => -1);
      if (injected <= 0) {
        throw new Error('正文注入失败：编辑器在写入后仍为空，已中止发布（避免发出空正文文章）');
      }
      // 编辑器字符数明显少于预期时告警（不中断：富文本渲染后 innerText 与源文长度本就不等）
      if (injected < content.trim().length * 0.5) {
        process.stderr.write(`[warn] 正文读回长度 ${injected} 明显小于输入长度 ${content.trim().length}，请核对发布结果\n`);
      }
    }
    await sleep(500, 1000);

    // ── 展示封面 ──
    await setCoverMode(page, opts.coverMode || 'single', opts.cover);
    await sleep(500, 1000);

    // ── 声明首发 ──
    if (opts.firstPublish) {
      await clickLabel(page, '头条首发');
    }
    await sleep(300, 500);

    // ── 合集 ──
    if (opts.collection) {
      await addToCollection(page, opts.collection);
    }
    await sleep(300, 500);

    // ── 同时发布微头条（默认已勾选，--no-weitoutiao 取消） ──
    if (opts.weitoutiao === false) {
      await uncheckWeitoutiao(page);
    }
    await sleep(300, 500);

    // ── 作品声明 ──
    if (opts.declaration) {
      await setDeclarations(page, opts.declaration);
    }
    await sleep(500, 1000);

    // ── 发布 / 草稿 ──
    await dismissOverlays(page);
    if (opts.draft) {
      // 原实现直接 return success:true（注释称"草稿已自动保存"），但从不校验，
      // 自动保存未落库时会报 draft_saved，属假成功。改为：优先点显式「存草稿」，
      // 再找正向保存信号；确认不了就如实报失败（正文仍在编辑器里，不会丢内容）。
      const draftBtn = page.locator('button:has-text("存草稿")').first();
      const hasDraftBtn = (await draftBtn.count()) > 0;
      if (hasDraftBtn) {
        await draftBtn.scrollIntoViewIfNeeded().catch(() => {});
        await sleep(300, 500);
        await draftBtn.click({ force: true, timeout: 10000 }).catch(() => {});
      }
      await sleep(2000, 4000);
      await waitForStable(page);

      const draftVerify = await page
        .evaluate(() => {
          const body = document.body.innerText || '';
          const saved = /已保存|保存成功|保存草稿成功|草稿已保存|已自动保存|已存入草稿|已存为草稿|保存于/.test(body);
          const editor = document.querySelector('[contenteditable="true"]');
          const editorLen = editor ? (editor.innerText || '').trim().length : 0;
          return { saved, editorLen, url: location.href };
        })
        .catch(() => ({ saved: false, editorLen: -1, url: '' }));

      if (!draftVerify.saved) {
        const reason = draftVerify.editorLen === -1
          ? '草稿页状态读取失败，未能确认草稿是否保存'
          : '未检测到草稿保存成功提示，无法确认草稿已落库';
        process.stderr.write(`[FAIL] ${reason}\n[FAIL] 请到草稿箱核对；正文仍在编辑器中，可直接手动保存\n`);
        return {
          success: false,
          action: 'draft_failed',
          verified: false,
          reason,
          title,
          url: page.url(),
        };
      }

      return {
        success: true,
        action: 'draft_saved',
        verified: true,
        title,
        url: page.url(),
      };
    }

    // 点击"预览并发布"按钮
    await dismissOverlays(page);
    const publishBtn = page.locator('button:has-text("预览并发布")').first();
    await publishBtn.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(300, 500);
    await publishBtn.click({ force: true, timeout: 10000 });
    await sleep(3000, 5000);
    await waitForStable(page);

    // 预览页面需要再次点击"确认发布"。
    // ⚠️ 不能再用 button:has-text("发布") 兜底：:has-text 是子串匹配，
    //    "预览并发布"也含"发布"，.first() 会重新命中编辑器页的按钮而不是确认按钮。
    //    这里优先精确找"确认发布"，退化时用 :text-is 精确匹配"发布"，并记录是否命中。
    const confirmSteps = { confirmPublish: false, confirmDialog: false };

    const confirmPublish = page.locator('button:has-text("确认发布")').first();
    if ((await confirmPublish.count()) > 0) {
      await confirmPublish.click({ timeout: 10000 }).catch(() => {});
      confirmSteps.confirmPublish = true;
    } else {
      // 精确文本匹配，排除"预览并发布"
      const exactPublish = page.locator('button:text-is("发布")').first();
      if ((await exactPublish.count()) > 0) {
        await exactPublish.click({ timeout: 10000 }).catch(() => {});
        confirmSteps.confirmPublish = true;
      }
    }
    await sleep(2000, 4000);

    // 可能还有二次确认弹窗（限定在可见的对话框内，避免误点页面其他"确定"）
    const confirmBtn = page.locator('[role="dialog"] button:has-text("确定"), .byte-modal-wrapper button:has-text("确定")').first();
    if ((await confirmBtn.count()) > 0 && (await confirmBtn.isVisible().catch(() => false))) {
      await confirmBtn.click({ timeout: 5000 }).catch(() => {});
      confirmSteps.confirmDialog = true;
    }

    await sleep(2000, 4000);
    await waitForStable(page);

    // 发布后验证：编辑器残留正文或出现拦截提示，都视为未真正发布
    const verify = await verifyPublishOnPage(page);
    if (!verify.reallyPublished) {
      return failureResult('publish', verify, { title, confirmSteps });
    }

    return {
      success: true,
      action: 'published',
      title,
      url: page.url(),
      verified: true,
      confirmSteps,
    };
  } finally {
    await closeBrowser(context);
  }
}

async function setCoverMode(page, mode, coverPath) {
  try {
    const modeLabels = {
      single: '单图',
      triple: '三图',
      none: '无封面',
    };
    const label = modeLabels[mode] || modeLabels.single;

    const radio = page.locator(`text=${label}`).first();
    await radio.click({ timeout: 5000 });
    await sleep(500, 800);

    if (mode !== 'none' && coverPath) {
      const paths = coverPath.split(',').map(p => p.trim()).filter(Boolean);

      // 点击封面区域的 + 号，打开图片上传侧边栏
      const coverArea = page.locator('[class*="cover"] [class*="add"], [class*="cover"] [class*="upload"], [class*="cover"] [class*="plus"]').first();
      await coverArea.click({ timeout: 5000 }).catch(async () => {
        // 备选：点击"预览"旁的 + 号
        await page.locator('[class*="cover-upload"]').first().click({ timeout: 3000 });
      });
      await sleep(1000, 2000);

      // 侧边栏打开后，点击"本地上传"按钮触发文件选择
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        page.locator('text=本地上传').first().click({ timeout: 5000 }),
      ]);

      if (fileChooser) {
        await fileChooser.setFiles(paths);
        await sleep(3000, 5000);
      }

      // 等待图片上传完成，点击"确定"关闭侧边栏
      const confirmBtn = page.locator('.byte-drawer-wrapper button:has-text("确定"), .upload-image-panel button:has-text("确定")').first();
      await confirmBtn.waitFor({ timeout: 10000 });
      await sleep(500, 800);
      await confirmBtn.click();
      await sleep(1000, 2000);
    }
  } catch {
    // 封面上传失败，尝试关闭可能残留的侧边栏
    await page.locator('.byte-drawer-wrapper button:has-text("取消")').first()
      .click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(500, 800);
  }
}

async function addToCollection(page, collectionName) {
  try {
    const addBtn = page.locator('text=添加至合集').first();
    await addBtn.click({ timeout: 5000 });
    await sleep(500, 1000);

    // 在弹出的合集选择面板中搜索或选择
    const searchInput = page.locator('[class*="collection"] input, [class*="search"] input').first();
    await searchInput.fill(collectionName, { timeout: 5000 }).catch(async () => {
      // 没有搜索框，直接找匹配的合集名
    });
    await sleep(500, 1000);

    const item = page.locator(`text=${collectionName}`).first();
    await item.click({ timeout: 5000 });
    await sleep(300, 600);

    // 点确认
    const confirmBtn = page.locator('button:has-text("确定"), button:has-text("确认")').first();
    await confirmBtn.click({ timeout: 3000 }).catch(() => {});
  } catch {
    // 合集添加失败不阻塞
  }
}

async function uncheckWeitoutiao(page) {
  try {
    // "同时发布微头条" 默认已勾选，点击取消
    const checkbox = page.locator('text=发布得更多收益').first();
    await checkbox.click({ timeout: 5000 });
    await sleep(200, 400);
  } catch {
    // 取消失败不阻塞
  }
}

async function clickLabel(page, labelText) {
  try {
    const el = page.locator(`text=${labelText}`).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 5000 });
    await sleep(200, 400);
  } catch {}
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
      await checkbox.scrollIntoViewIfNeeded().catch(() => {});
      await checkbox.click({ timeout: 3000 });
      await sleep(200, 400);
    } catch {}
  }
}

async function pasteMarkdownAsRichText(page, markdownContent, editorSelector) {
  const html = marked.parse(markdownContent, { breaks: true, gfm: true });
  await page.evaluate(
    ({ html, text, selector }) => {
      const editor = document.querySelector(selector);
      if (!editor) return;
      editor.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', html);
      // text/plain 必须填 markdown 源文；填编辑器当前内容（通常为空）会导致正文丢失
      dt.setData('text/plain', text);
      const evt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(evt);
    },
    { html, text: markdownContent, selector: editorSelector },
  );
  await sleep(500, 1000);
}

async function typePlainText(page, content) {
  const paragraphs = content.split('\n');
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    if (para) {
      await page.keyboard.type(para, { delay: 30 + Math.random() * 50 });
    }
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await sleep(100, 300);
    }
  }
}
