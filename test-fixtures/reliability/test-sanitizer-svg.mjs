// test-sanitizer-svg.mjs — 净化器标签模型必须对齐浏览器解析（BL-P1-01，high）
// 背景：RAW_TEXT_TAGS 与浏览器 HTML 解析模型不一致——<svg> 是 foreign content，其
// <style>/<textarea>/<title> 不切 raw-text（内容按标记解析）；脚本开启时 <noscript> 内容
// 才是 raw-text（引号里的 </noscript> 照样收尾）。净化器把这两处都判反 → 未知 <script> 与
// on* 事件属性原样通过净化，在无 CSP 的渲染 worker 里执行（实测可把简历正文外传）。
// 纯函数段（不依赖 Chromium）+ 浏览器执行段（真实 setContent 验证零执行）。
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { trustedRenderHtml, RENDER_REMOVED_KINDS } from '../../render-safe.mjs';

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// ---------- 纯函数段 ----------
const cases = [
  {
    name: 'svg style 内嵌 script',
    input: '<svg><style><script>window.X=1</script></style></svg>',
    mustNot: ['<script'],
    expectRemoved: RENDER_REMOVED_KINDS.UNKNOWN_SCRIPT
  },
  {
    name: 'svg textarea 内嵌 script',
    input: '<svg><textarea><script>window.X=1</script></textarea></svg>',
    mustNot: ['<script'],
    expectRemoved: RENDER_REMOVED_KINDS.UNKNOWN_SCRIPT
  },
  {
    name: 'svg title 内嵌 script',
    input: '<svg><title><script>window.X=1</script></title></svg>',
    mustNot: ['<script'],
    expectRemoved: RENDER_REMOVED_KINDS.UNKNOWN_SCRIPT
  },
  {
    name: 'svg style 内 onerror 事件属性',
    input: '<svg><style><img src=x onerror=window.XgXg></style></svg>',
    mustNot: ['onerror'],
    expectRemoved: RENDER_REMOVED_KINDS.EVENT_ATTRIBUTE
  },
  {
    name: 'noscript 引号内收尾 + 逃逸 img onerror',
    input: '<noscript><p title="</noscript><img src=x onerror=window.XnXn>">',
    mustNot: ['onerror'],
    expectRemoved: RENDER_REMOVED_KINDS.EVENT_ATTRIBUTE
  }
];

const sanitizedOutputs = [];
for (const c of cases) {
  const r = trustedRenderHtml(c.input);
  for (const bad of c.mustNot) {
    if (r.html.toLowerCase().includes(bad)) fail(`[${c.name}] 净化输出仍含「${bad}」：${r.html}`);
  }
  if (!r.removed.some((x) => x.kind === c.expectRemoved)) {
    fail(`[${c.name}] removed 未含 ${c.expectRemoved}（实际：${JSON.stringify(r.removed)}）`);
  }
  sanitizedOutputs.push([c.name, r.html]);
}
// 对照组：普通 html <style>（非 foreign）内容仍是 inert raw-text，应原样保留（不回归）
const ctl = trustedRenderHtml('<style>p{color:red}</style>');
assert.ok(ctl.html.includes('p{color:red}'), '普通 style 的 raw-text 保留被回归了');

console.log('✅ 净化器标签模型（纯函数段）：svg 内 style/textarea/title 按标记解析、noscript 按 raw-text 收尾、html style 保留不回归');

// ---------- 浏览器执行段 ----------
let browser = null;
try {
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过浏览器执行段：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });

  for (const [name, html] of sanitizedOutputs) {
    await page.setContent(html, { waitUntil: 'load' });
  }
  await new Promise((r) => setTimeout(r, 400));
  const fired = await page.evaluate(() => ({ X: window.X ?? null, Xg: window.XgXg ?? null, Xn: window.XnXn ?? null }));
  if (fired.X !== null || fired.Xg !== null || fired.Xn !== null) {
    fail(`浏览器执行段：净化产物仍执行了脚本/事件（${JSON.stringify(fired)}）`);
  }
  if (dialogs.length) fail(`浏览器执行段：出现 dialog ${JSON.stringify(dialogs)}`);

  console.log('✅ 净化器标签模型（浏览器段）：五例净化产物真实 setContent 零执行、零 dialog');
} finally {
  try { if (browser) await browser.close(); } catch {}
}
