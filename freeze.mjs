// freeze.mjs — 冻结/归一化/渲染标识/资源指纹/陈旧判定的单一出口（S1 Task 2）
// 铁律一：当前文档渲染 = 当前 HTML + 该文档当前 meta（theme/typo），由调用方经 freezeHtml 组装。
// 铁律二：快照/存档/任意 --src 渲染只用冻结文件内容与样式；render.mjs 保持 meta-blind（本模块不读 docs-meta，
//         meta 一律由调用方传入）。
// 资源指纹 = 完整内容哈希：data: 哈希完整负载（禁止前缀截断）；本地文件（相对文档根/绝对）哈希文件内容，
//         缺失/不可读 → missing[] 且 reproducible=false；http(s) URL = 不可复现输入 → remote[] 且 reproducible=false。
// 返回对象字段为后续任务（T3 保存事务、T4 渲染入口、T7 迁移、T8 导出）的公共契约，改动须同步各消费方。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
// 文档根：本地资源相对路径的解析基准。惰性读取，测试可经 RESUME_ROOT 隔离。
const docRoot = () => process.env.RESUME_ROOT || APP_ROOT;

// 完整 40 位 hex sha1（string | Buffer）。全模块禁止截断。
export function sha1(s) {
  return createHash('sha1').update(typeof s === 'string' ? s : (s ?? '')).digest('hex');
}

// —— 文档拆分 ——
// <style id="typo-custom"> 块：只匹配 style 元素（编辑器脚本里的同名字符串不受影响）
const TYPO_STYLE_RE = /<style\b[^>]*\bid\s*=\s*["']typo-custom["'][^>]*>([\s\S]*?)<\/style>/gi;
// 所有 style 元素（含属性串，供 data-theme / data-style-origin 识别）
const STYLE_RE = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;

// splitDoc(html) → { html, typo }
//   typo: 首个内联 typo-custom 块的 CSS 文本；无该块时为 null（"无微调"是合法历史状态）。
//   html: 剥离全部 typo-custom 块后的文档（幂等）。
export function splitDoc(html) {
  const src = String(html ?? '');
  TYPO_STYLE_RE.lastIndex = 0;
  const m = TYPO_STYLE_RE.exec(src);
  const typo = m ? m[1] : null;
  return { html: src.replace(TYPO_STYLE_RE, ''), typo };
}

// 主样式（非 typo-custom）：CSS 文本按文档序拼接；同时识别来源属性
function mainStyles(html) {
  const out = [];
  STYLE_RE.lastIndex = 0;
  let m;
  while ((m = STYLE_RE.exec(html)) !== null) {
    if (/\bid\s*=\s*["']typo-custom["']/i.test(m[1])) continue;
    out.push({ attrs: m[1], css: m[2] });
  }
  return out;
}

function themeOf(styles) {
  for (const s of styles) {
    const dt = /\bdata-theme\s*=\s*["']([^"']*)["']/i.exec(s.attrs);
    if (dt) return dt[1];
    if (/\bdata-style-origin\s*=\s*["']legacy-inline["']/i.test(s.attrs)) return 'legacy';
  }
  return null;
}

// normalizeToCurrent(html) → { html, typo, theme, styleHash }
//   归一化为"当前可编辑文档"格式：剥离内联 typo-custom（typo 值交调用方存 meta，缺省空串）；
//   theme/styleHash 登记主 <style> 的来源属性与 CSS 哈希（无主样式时 styleHash 为 ''）。
//   幂等断言只对 HTML：normalizeToCurrent(normalizeToCurrent(h).html).html === normalizeToCurrent(h).html
export function normalizeToCurrent(html) {
  const { html: stripped, typo } = splitDoc(html);
  const styles = mainStyles(stripped);
  return {
    html: stripped,
    typo: typo ?? '',
    theme: themeOf(styles),
    styleHash: styles.length ? sha1(styles.map((s) => s.css).join('\n')) : ''
  };
}

// —— 正文提取（bodyHash 只取 <body> 内容 → body 外空白不影响渲染标识）——
function bodyInner(html) {
  const m = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);   // 贪婪到最后一个 </body>
  return m ? m[1] : html;                                    // 无 body 标签的片段：整体视为正文
}

// —— 资源引用收集 ——
// 会实际加载资源的标签/属性（<a href> 是导航链接、不加载资源，绝不收集——否则含超链接的简历会被误判不可复现）
const RES_TAG_RE = /<(?:img|image|script|link|source|embed|iframe|video|audio|input)\b[^>]*>/gi;
const RES_ATTR_RE = /\b(?:src|href|poster|xlink:href|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+?))\s*\)/gi;

function collectRefs(html) {
  const refs = [];
  const push = (r) => {
    const v = String(r ?? '').trim();
    if (!v || v.startsWith('#')) return;
    if (!refs.includes(v)) refs.push(v);   // 首现序去重，保证确定性
  };
  // 1) style 块（含 typo）与 style="…" 属性里的 CSS url()
  STYLE_RE.lastIndex = 0;
  let m;
  while ((m = STYLE_RE.exec(html)) !== null) {
    CSS_URL_RE.lastIndex = 0;
    let u;
    while ((u = CSS_URL_RE.exec(m[2])) !== null) push(u[1] ?? u[2] ?? u[3]);
  }
  const attrRe = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = attrRe.exec(html)) !== null) {
    CSS_URL_RE.lastIndex = 0;
    let u;
    while ((u = CSS_URL_RE.exec(m[1] ?? m[2] ?? '')) !== null) push(u[1] ?? u[2] ?? u[3]);
  }
  // 2) 资源型标签的 src/href/poster/srcset
  RES_TAG_RE.lastIndex = 0;
  while ((m = RES_TAG_RE.exec(html)) !== null) {
    const tag = m[0];
    RES_ATTR_RE.lastIndex = 0;
    let a;
    while ((a = RES_ATTR_RE.exec(tag)) !== null) push(a[1] ?? a[2]);
    const ss = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (ss) for (const cand of (ss[1] ?? ss[2] ?? '').split(',')) push(cand.trim().split(/\s+/)[0]);
  }
  return refs;
}

// resourceFingerprint(html, root?) → { resourcesHash, remote[], missing[], reproducible }
//   data:  → 哈希完整 URI 文本（含 mime 与全部负载）
//   http(s):// 与协议相对 // → remote[]（不可复现输入），不参与内容哈希
//   本地相对路径（相对文档根 root，缺省 RESUME_ROOT||模块目录）/绝对路径/file: → 哈希文件内容；
//     读取失败 → missing[]
//   reproducible = remote 与 missing 均为空
export function resourceFingerprint(html, root) {
  const base = root || docRoot();
  const remote = [];
  const missing = [];
  const entries = [];
  for (const ref of collectRefs(String(html ?? ''))) {
    if (/^data:/i.test(ref)) {
      entries.push('data:' + sha1(ref));                      // 完整负载，禁止截断
      continue;
    }
    if (/^https?:\/\//i.test(ref) || ref.startsWith('//')) {
      if (!remote.includes(ref)) remote.push(ref);
      entries.push('remote:' + ref);
      continue;
    }
    if (/^file:/i.test(ref)) {
      // file: URL 按本地文件处理
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
      continue;                                               // mailto:/tel:/blob: 等非加载资源，跳过
    }
    let p = ref.replace(/^file:\/\/(?:localhost)?/i, '');
    p = p.split(/[?#]/)[0];                                   // 去 query/fragment
    try { p = decodeURIComponent(p); } catch { /* 非法转义按原文 */ }
    const abs = path.isAbsolute(p) ? p : path.join(base, p);
    try {
      entries.push('local:' + sha1(fs.readFileSync(abs)));    // 哈希文件内容而非路径
    } catch {
      if (!missing.includes(ref)) missing.push(ref);
      entries.push('missing:' + ref);
    }
  }
  return {
    resourcesHash: sha1(entries.join('\n')),
    remote,
    missing,
    reproducible: remote.length === 0 && missing.length === 0
  };
}

// freezeHtml(html, meta) → 冻结产物与完整标识
//   { html, bodyHash, cssHash, typoHash, resourcesHash, renderInputId, remote[], missing[], reproducible }
//   语义：先归一化（剥离 html 内的内联 typo），再在 </head> 前注入「有效 typo」：
//   有效 typo = (meta.typo 定义且非空) ? meta.typo : (html 内联 typo if present else '')（S1 热修裁决）。
//   已迁移文档（meta.typo 定义）一律 meta 为准，不存在"已有 typo 就跳过注入"分支（'' 且无内联 → 产物无
//   typo-custom 块，合法：当时无微调）；legacy 文档（meta 无 typo 键、内联仍在）在 T7 迁移前回退内联值，
//   排版不被空 meta 剥掉——首次 /save 会把内联值抽入 meta（Task3 路径），完成单文档迁移。
//   renderInputId = sha1(bodyHash:cssHash:typoHash:resourcesHash)，含正文。
//   注：<style> 来源属性（data-theme/data-style-origin）的登记由 T5/T7 负责，本函数不改写主样式属性。
export function freezeHtml(html, meta) {
  const m = meta || {};
  const norm = normalizeToCurrent(html);
  const typo = (typeof m.typo === 'string' && m.typo !== '') ? m.typo : (norm.typo ?? '');
  let out = norm.html;
  if (typo) {
    const block = `<style id="typo-custom">${typo}</style>`;
    out = /<\/head>/i.test(out)
      ? out.replace(/<\/head>/i, (mm) => block + mm)          // 内联在 </head> 前
      : block + out;                                          // 无 head 的片段：前置兜底
  }
  const styles = mainStyles(out);
  const bodyHash = sha1(bodyInner(out).trim());
  const cssHash = styles.length ? sha1(styles.map((s) => s.css).join('\n')) : sha1('');
  const typoHash = sha1(typo);
  const fp = resourceFingerprint(out);
  const renderInputId = sha1(bodyHash + ':' + cssHash + ':' + typoHash + ':' + fp.resourcesHash);
  return {
    html: out,
    bodyHash,
    cssHash,
    typoHash,
    resourcesHash: fp.resourcesHash,
    renderInputId,
    remote: fp.remote,
    missing: fp.missing,
    reproducible: fp.reproducible
  };
}

// staleInfo(meta, current) → { state, stale }
//   陈旧判定单入口（/pdf、/export、POST /render、首页徽章共用）；mtime 不作正确性依据。
//   meta    = 该文档 meta（读 lastRenderInputId）
//   current = { renderInputId: 当前 freezeHtml 产物标识, pdfExists: 目标 PDF 是否存在 }
//   三态：'none' 无 PDF（或从未渲染成功）｜'stale' 有 PDF 但标识不符｜'fresh' 一致
export function staleInfo(meta, current) {
  const m = meta || {};
  const c = current || {};
  if (!c.pdfExists) return { state: 'none', stale: true };
  if (!m.lastRenderInputId || m.lastRenderInputId !== c.renderInputId) return { state: 'stale', stale: true };
  return { state: 'fresh', stale: false };
}
