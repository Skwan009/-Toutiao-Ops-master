#!/usr/bin/env node
/**
 * 一次性：在已登录会话内直接请求一个站内接口，打印 JSON 结构（只读）
 * 用法：node tools/fetch-api.mjs <account> <url> [--full]
 * 说明：用于快速确认接口的返回字段结构，不写任何数据。
 */
import { launchBrowser, closeBrowser, browserFetch } from '../src/browser.js';
import { ensureLoggedIn } from '../src/auth-guard.js';

const account = process.argv[2] || 'n1';
const url = process.argv[3];
const full = process.argv.includes('--full');

if (!url) {
  console.error('用法: node tools/fetch-api.mjs <account> <url> [--full]');
  process.exit(1);
}

function summarize(v, d = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return d >= 4 ? `array(${v.length})` : { __array: v.length, __sample: v.length ? summarize(v[0], d + 1) : null };
  if (typeof v === 'object') {
    if (d >= 4) return 'object';
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = summarize(x, d + 1);
    return o;
  }
  return typeof v;
}

const { context, page } = await launchBrowser({ account });
try {
  await ensureLoggedIn(page);
  const res = await browserFetch(page, url);
  const out = { ok: res.ok, status: res.status };
  if (full) out.data = res.data;
  else out.summary = summarize(res.data);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await closeBrowser(context);
}
