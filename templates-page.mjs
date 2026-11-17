// templates-page.mjs — 「模板库」页面模块（个人简历工作台 · 本地工具，无商业化）
// 本文件为新增文件，不修改任何既有文件。导出：
//   - THEMES：内置主题清单（id = themes/resume-<id>.css 的真实标识）
//   - renderTemplatesPage(opts)：返回 inner HTML 字符串，由路由传给 page(title, inner, active)
//
// 复用口径（不自拼、不另起实现）：
//   ① 主题可用性 = template.mjs listThemes()（themes/resume-*.css 文件名唯一源）；
//     出卡前按可用性过滤（同向导 0.8 选模板过滤口径，server.mjs:4088-4090）。
//   ② 缩略图预览 = /theme-preview 同一份装配 themePreviewHtml()（server.mjs:1680，DESIGN.md §10.1
//     「装配单一实现」）：卡内 srcdoc 必须与 GET /theme-preview 响应体逐字节相等 → 本模块不装配，
//     由路由把逐主题装配结果经 opts.previews 传入。
//   ③ 主题名称对齐 OB_THEME_CARDS（server.mjs:4067-4072：经典单栏/紧凑单栏/双栏紧凑/杂志展示）。
//
// 安全：本页零 <script>（按钮 = 纯 form POST，无 nonce 需求）；docId/主题 id 等外部数据一律
//   escHtml/escAttr 进 HTML；预览 HTML 是 themePreviewHtml 的已剥离产物，进 srcdoc 属性仍整体 escAttr。
// 视觉：只引用 :root token（--accent/--accent-soft/--card-2/--radius-lg/--space-*）与全局类
//   （.badge/.page-head），自有类名一律 tpl- 前缀避免撞全局。
import { listThemes } from './template.mjs';

// 内置主题清单：id = themes/resume-<id>.css 标识；name 与向导 0.8 卡同源；scene = 一句场景说明；
// industry/density 进标签胶囊（行业 / 密度各一枚）。
export const THEMES = [
  { id: 'classic',  name: '经典单栏', scene: '最通用的单栏版式，投递大多数岗位都稳妥', industry: '全行业通用', density: '密度适中' },
  { id: 'compact',  name: '紧凑单栏', scene: '行距与字号收紧，同样一页纸装下更多内容', industry: '全行业通用', density: '密度高' },
  { id: 'dual',     name: '双栏紧凑', scene: '主栏放经历、侧栏放技能与联系，经历多也能一页排满', industry: '经验密集型', density: '密度高' },
  { id: 'magazine', name: '杂志展示', scene: '大留白展示向版式，适合作品导向与创意岗位', industry: '创意展示向', density: '密度低' }
];

// 与 server.mjs:2243-2244 同口径的转义（本模块独立成文件，不依赖 server.mjs 内部函数）
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');

// 卡片与网格样式（scoped <style> 随 inner 进 body；CSP style-src 'unsafe-inline' 放行）。
// 缩略图机制复刻 .ob-tthumb（server.mjs:4633-4645）：外层固定高 + container-type:inline-size，
// 内层 iframe 保持 A4 尺寸（794×1123）再按容器宽 transform 缩放；pointer-events:none 防预览内交互。
const TPL_CSS = `
.tpl-sub{color:var(--mut);font-size:13px;margin:0 0 var(--space-4)}
.tpl-flash{background:var(--ok-soft);color:var(--ok);border:1px solid var(--ok);border-radius:var(--radius);padding:var(--space-2) var(--space-3);font-size:13px;margin:0 0 var(--space-3)}
.tpl-grid{--tpl-page-w:794px;--tpl-page-h:1123px;--tpl-thumb-h:210px;--tpl-thumb-scale:.45;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3)}
.tpl-card{display:flex;flex-direction:column;gap:var(--space-2);border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-3);background:var(--card);margin:0}
.tpl-thumb{display:block;height:var(--tpl-thumb-h);overflow:hidden;border:1px solid var(--border);border-radius:var(--radius);background:var(--card-2);container-type:inline-size}
.tpl-thumb iframe{width:var(--tpl-page-w);height:var(--tpl-page-h);border:0;transform:scale(min(var(--tpl-thumb-scale),calc((100cqw - 2px)/var(--tpl-page-w))));transform-origin:0 0;pointer-events:none;display:block}
.tpl-thumb-empty{display:flex;align-items:center;justify-content:center;height:100%;font-size:12px;color:var(--mut)}
.tpl-head{display:flex;align-items:baseline;gap:var(--space-2);flex-wrap:wrap}
.tpl-head .badge{margin-right:0}
.tpl-name{font-size:14px;font-weight:700}
.tpl-id{font-family:var(--font-mono);font-size:12px;color:var(--mut)}
.tpl-scene{font-size:12px;color:var(--mut);margin:0;flex:1}
.tpl-tags{display:flex;gap:var(--space-2);flex-wrap:wrap}
.tpl-tags .badge{margin-right:0}
.tpl-acts{display:flex;flex-direction:column;gap:var(--space-2);margin-top:auto;padding-top:var(--space-2)}
.tpl-use{margin:0}
.tpl-use button{width:100%}
.tpl-zoom{font-size:12px;color:var(--mut);text-align:center}
.tpl-zoom:hover{color:var(--accent)}
.tpl-empty{grid-column:1/-1;font-size:13px;color:var(--mut)}
@media (max-width:1100px){.tpl-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:720px){.tpl-grid{grid-template-columns:1fr}}
`;

// 单张模板卡：srcdoc 缩略图 + 主题名 + 场景说明 + 标签胶囊 +「使用此模板」按钮。
// ctx = { previews, docId, currentTheme, action, zoomBase }（见 renderTemplatesPage 注释）。
function tplCardHtml(t, ctx) {
  const preview = typeof ctx.previews[t.id] === 'string' ? ctx.previews[t.id] : '';
  const thumb = preview
    ? `<iframe title="${escAttr(t.name)} 模板预览" srcdoc="${escAttr(preview)}" tabindex="-1" loading="lazy"></iframe>`
    : `<span class="tpl-thumb-empty">预览不可用</span>`;
  const current = ctx.currentTheme === t.id ? '<span class="badge ai">使用中</span>' : '';
  // 「放大预览」直接打开 GET /theme-preview（该端点要求既有文档 id；frame-ancestors 'none'
  // 只禁嵌框、直接访问合法）。无文档上下文时不出此链。
  const zoom = ctx.docId
    ? `<a class="tpl-zoom" href="${escAttr(ctx.zoomBase)}?id=${escAttr(ctx.docId)}&theme=${escAttr(t.id)}" target="_blank" rel="noopener">放大预览</a>`
    : '';
  // 待接点：ctx.action 指向的 POST 路由尚未在 server.mjs 注册（接入规范见 templates.routes.md §3）；
  // 落库建议复用 updateMeta(root, id, m => ({...m, theme}))（与 POST /theme/apply 同一写入路径）。
  const hid = ctx.docId ? `<input type="hidden" name="id" value="${escAttr(ctx.docId)}">` : '';
  return `<section class="tpl-card" data-theme="${escAttr(t.id)}">
  <span class="tpl-thumb">${thumb}</span>
  <div class="tpl-head"><span class="tpl-name">${escHtml(t.name)}</span><code class="tpl-id">${escHtml(t.id)}</code>${current}</div>
  <p class="tpl-scene">${escHtml(t.scene)}</p>
  <div class="tpl-tags"><span class="badge">${escHtml(t.industry)}</span><span class="badge">${escHtml(t.density)}</span></div>
  <div class="tpl-acts">
    <!-- 待接点：form action 指向未注册路由，接法见 templates.routes.md §3 -->
    <form class="tpl-use" method="post" action="${escAttr(ctx.action)}">
      ${hid}<input type="hidden" name="theme" value="${escAttr(t.id)}">
      <button type="submit" data-theme="${escAttr(t.id)}">使用此模板</button>
    </form>
    ${zoom}
  </div>
</section>`;
}

// renderTemplatesPage(opts) → inner HTML（传给 page('模板库', inner, 'templates')）。
// opts（全部可选）：
//   previews     { [themeId]: html } —— 路由侧用 themePreviewHtml(src, theme) 逐主题生成传入；
//                                      缺某主题的项时该卡缩略图位显示「预览不可用」，不渲染空 iframe。
//   docId        已存在文档 id —— 提供时：①「使用此模板」表单附 hidden id；② 每卡加「放大预览」链接。
//   currentTheme 当前文档已用主题 id —— 命中的卡片渲染「使用中」徽章。
//   applied      刚应用成功的主题 id —— 渲染提示条（配 POST 303 回跳 ?applied=<theme> 用）。
//   action       「使用此模板」form action，缺省 '/templates/use'（待接点占位）。
//   zoomBase     「放大预览」基础路径，缺省 '/theme-preview'。
export function renderTemplatesPage(opts = {}) {
  const previews = (opts && typeof opts.previews === 'object' && opts.previews) || {};
  const ctx = {
    previews,
    docId: String(opts.docId || ''),
    currentTheme: String(opts.currentTheme || ''),
    action: typeof opts.action === 'string' && opts.action ? opts.action : '/templates/use',
    zoomBase: typeof opts.zoomBase === 'string' && opts.zoomBase ? opts.zoomBase : '/theme-preview'
  };
  const avail = new Set(listThemes());   // 可用主题 = themes/resume-*.css 唯一源；未知/缺失主题不出卡
  const list = THEMES.filter((t) => avail.has(t.id));
  const cards = list.map((t) => tplCardHtml(t, ctx)).join('');
  const appliedTheme = THEMES.find((t) => t.id === String(opts.applied || ''));
  const flash = appliedTheme
    ? `<p class="tpl-flash" role="status">已把模板「${escHtml(appliedTheme.name)}」应用到当前文档。</p>`
    : '';
  return `<div class="page-head"><h1>模板库</h1><span class="page-meta">${list.length} 套内置模板</span></div>
<p class="tpl-sub">选一个模板起步，再让 AI 帮你填内容</p>
${flash}
<div class="tpl-grid">${cards || '<p class="tpl-empty">themes/ 目录下暂无可用模板。</p>'}</div>
<style>${TPL_CSS}</style>`;
}
