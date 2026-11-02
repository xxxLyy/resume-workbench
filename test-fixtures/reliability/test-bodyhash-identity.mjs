// test-bodyhash-identity.mjs — B12H：bodyHash 渲染身份只算打印可见内容
// 背景：freeze.mjs 的 bodyHash 把打印不可见的编辑态算进渲染身份——#saveState 的状态文案与
// data-state 属性、.edit-toolbar 整块（doc-name/按钮/SVG 图标）、.page-line、data-editor 代次
// ——同一份 PDF 像素不变却被判「较旧」（staleInfo 按 renderInputId 比对，bodyHash 是其正文分量）。
// 修法：哈希前摘除 @media print 隐藏的四个运行时元素（themes/resume-classic.css print 兜底行所列
// .edit-toolbar/.page-line/.toast/.recovery-bar）与 data-editor 属性；只摘哈希输入，
// freezeHtml 返回的 html 原样（server.mjs:846 / migrate-meta.mjs:156 要从产物 html 读 data-editor）。
// 合同（纯函数，零 I/O 零服务零浏览器）：
//   ① 同一正文 + 不同 saveState 文案/data-state → bodyHash 相同
//   ② 同一正文 + 不同 .edit-toolbar 内容（含 data-editor v5/v6 代次、增删按钮）→ bodyHash 相同
//   ③ 同一正文 ± .page-line/.toast/.recovery-bar → bodyHash 相同
//   ④ 正文真实变化 → bodyHash 不同（对照约束：可见内容仍是渲染身份）
//   ⑤ 既有合同零回退：data-zid / body 外空白 / saveState 文案（2026-10-22 口径）仍不影响身份；
//      renderInputId 组合式不变；freezeHtml 产物 html 不被摘除改写；对冻结产物再冻结身份稳定。
// 后果登记（口径切换）：既有 PDF 一次性判旧 → 下次导出自动重生成；导出历史 PDF 按完整
// renderInputId 命名、不可变，不受影响。
import assert from 'node:assert/strict';
import { freezeHtml } from '../../freeze.mjs';

const TOOLBAR = (v, state, text, extra) =>
  `<div class="edit-toolbar" data-editor="${v}">`
  + '<span class="doc-name" id="docName">测试员</span><span class="spacer"></span>'
  + `<span class="save-state" id="saveState" data-state="${state}" title="保存状态（失败时可点击重试）">${text}</span>`
  + `<button id="saveBtn" title="保存">💾 保存</button>${extra || ''}`
  + '</div>';
const SHEET = (body) => `<section class="sheet" contenteditable="true">${body}</section>`;
const doc = ({ toolbar = TOOLBAR('v5', 'saved', '已保存'), sheet = SHEET('<p>正文段落一</p>'), extra = '' } = {}) =>
  `<html><head><title>简历</title></head><body>${toolbar}${sheet}${extra}</body></html>`;

// ① saveState 文案与 data-state 变化不改变身份
const f1 = freezeHtml(doc(), {});
const f1b = freezeHtml(doc({ toolbar: TOOLBAR('v5', 'dirty', '未保存 ●') }), {});
assert.equal(f1b.bodyHash, f1.bodyHash, '① saveState 文案/data-state 变化不应改变 bodyHash');
assert.equal(f1b.renderInputId, f1.renderInputId, '① saveState 文案/data-state 变化不应改变 renderInputId');

// ② 工具栏整块不同（代次 v5→v6、按钮文案/数量不同、data-editor 缺失）→ 身份不变
const f2 = freezeHtml(doc({ toolbar: TOOLBAR('v6', 'saved', '已保存', '<button id="newBtn">新按钮</button>') }), {});
assert.equal(f2.bodyHash, f1.bodyHash, '② 工具栏内容/代次变化不应改变 bodyHash');
const f2b = freezeHtml(doc({ toolbar: TOOLBAR('v5', 'saved', '已保存').replace(' data-editor="v5"', '') }), {});
assert.equal(f2b.bodyHash, f1.bodyHash, '② data-editor 缺失不应改变 bodyHash');

// ③ 打印隐藏的运行时元素在场与否 → 身份不变（page-line 带 span 子节点、recovery-bar 带按钮）
const withRuntime = doc({
  sheet: SHEET('<div class="page-line" style="top:1122px"><span>1</span></div><p>正文段落一</p>'),
  extra: '<div class="toast">已恢复正文与排版</div>'
    + '<div class="recovery-bar conflict-bar"><span>检测到冲突</span>'
    + '<button class="secondary">用我这版</button></div>'
});
const f3 = freezeHtml(withRuntime, {});
assert.equal(f3.bodyHash, f1.bodyHash, '③ .page-line/.toast/.recovery-bar 在场不应改变 bodyHash');

// ④ 对照：正文真实变化必须改变身份（可见内容仍是渲染身份）
const f4 = freezeHtml(doc({ sheet: SHEET('<p>正文段落二</p>') }), {});
assert.notEqual(f4.bodyHash, f1.bodyHash, '④ 正文变化必须改变 bodyHash');
assert.notEqual(f4.renderInputId, f1.renderInputId, '④ 正文变化必须改变 renderInputId');

// ⑤ 既有合同零回退
const f5 = freezeHtml(doc({ sheet: SHEET('<p data-zid="za1b2c3d4">正文段落一</p>') }), {});
assert.equal(f5.bodyHash, f1.bodyHash, '⑤ data-zid 打点不应改变 bodyHash（S3 既有合同）');
const ws = doc().replace('<body>', '<body>\n  \n');
assert.equal(freezeHtml(ws, {}).renderInputId, f1.renderInputId, '⑤ body 外空白不应改变身份（既有合同）');
const ssDoc = '<html><body><span id="saveState" data-state="saved">已保存</span><div class="sheet">正文段落一</div></body></html>';
assert.equal(
  freezeHtml(ssDoc, {}).bodyHash,
  freezeHtml(ssDoc.replace('>已保存<', '>保存失败 ✗<').replace('data-state="saved"', 'data-state="error"'), {}).bodyHash,
  '⑤ 工具栏外的 #saveState 状态读数仍不影响身份（2026-10-22 口径不回退）'
);
const composition = f1.bodyHash + ':' + f1.cssHash + ':' + f1.typoHash + ':' + f1.resourcesHash;
assert.ok(/^[0-9a-f]{40}$/.test(f1.bodyHash), '⑤ bodyHash 应为完整 40hex');
assert.equal(f1.renderInputId.length, 40, '⑤ renderInputId 组合式口径不变（长度锚）');

// 产物 html 原样：摘除只作用于哈希输入（data-editor/工具栏要留给迁移与 /export 代次读取）
const out = freezeHtml(doc(), {}).html;
assert.ok(out.includes('data-editor="v5"'), '⑤ freezeHtml 返回的 html 必须保留 data-editor（server.mjs:846 口径）');
assert.ok(out.includes('id="saveState"') && out.includes('💾 保存'), '⑤ freezeHtml 返回的 html 必须原样保留工具栏');
assert.equal(
  freezeHtml(out, {}).bodyHash, f1.bodyHash,
  '⑤ 对冻结产物再冻结身份稳定（摘除幂等，不漂移）'
);

console.log('✅ B12H bodyHash 渲染身份：打印不可见编辑态（saveState/工具栏/data-editor/page-line/toast/恢复条）不影响身份，正文变化仍改变身份，产物 html 原样、再冻结稳定');
