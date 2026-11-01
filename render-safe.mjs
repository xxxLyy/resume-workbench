/**
 * render-safe.mjs — 受信渲染输入构造（纯函数，零 I/O、零依赖）
 *
 * 为什么需要（审计 AUD-05）：
 *   编辑页 /edit 有严格 CSP（内联脚本只放行已知指纹），但渲染 worker（render.mjs）
 *   对文档原样 page.setContent(html)，**没有同等限制**。恢复一份带脚本的历史备份后，
 *   该脚本会在渲染时于本地 origin 执行并可对外发请求 —— 实测已被自有本地接收器收到 1 次 POST。
 *   render.mjs 是冻结件，改不了；因此在进入它之前把 HTML 净化成「受信渲染输入」。
 *
 * 契约：
 *   trustedRenderHtml(html, { knownScriptHashes, maxHtmlBytes })
 *     → { html, removed: [{kind, detail}], hasUnknownScript, bytes, outBytes }
 *   - knownScriptHashes：可信内联脚本的 sha256(base64) 指纹集合（调用方算，见 scriptHash）。
 *     命中 → 字节级保留（分页脚本等版式依赖它）；未命中 → 整个脚本块移除。
 *   - 事件属性 / javascript: / vbscript: URL / 外联载体 / meta refresh / script 类 link /
 *     base href / HTML 注释 一律剥离，逐条在 removed 里报告 kind。
 *   - 合法样式、字体、图片、meta charset、普通文本原样保留。
 *   - 超限抛错（不静默截断，避免破坏版式）：err.code='RENDER_INPUT_TOO_LARGE'，err.removed 可见。
 *
 * 剥离用一次线性扫描 + 字符串拼接实现（不做全文反复正则替换）。
 */
import { createHash } from 'node:crypto';

// removed.kind 枚举（调用方可按 kind 统计/告警）
export const RENDER_REMOVED_KINDS = Object.freeze({
  UNKNOWN_SCRIPT: 'unknown-script',       // 未知指纹的内联 <script>（整个脚本块）
  EXTERNAL_SCRIPT: 'external-script',     // <script src="...">（含 type="module"）
  EVENT_ATTRIBUTE: 'event-attribute',     // 任意 on* 内联事件属性
  JAVASCRIPT_URL: 'javascript-url',       // javascript:/vbscript: 协议的 URL 属性
  EMBED_ELEMENT: 'embed-element',         // iframe/object/embed/applet/frame/frameset
  META_REFRESH: 'meta-refresh',           // <meta http-equiv="refresh">
  SCRIPT_LINK: 'script-link',             // <link rel=import|preload|prefetch as=script>
  BASE_HREF: 'base-href',                 // <base href>（改变相对 URL 解析基准）
  COMMENT: 'comment',                     // HTML 注释（含条件注释）
  TOO_LARGE: 'too-large'                  // 超出 maxHtmlBytes（抛错，不返回净化结果）
});

// 内联事件属性：HTML 标准里所有事件处理器都是 on* 前缀，没有别的 on 前缀属性。
const EVENT_ATTR_RE = /^on[a-z]/i;
// 会执行脚本的 URL 属性
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster']);
// raw-text 元素：内容按纯文本解析（里面的 < 不是标签）
// 浏览器口径（BL-P1-01，2026-11-01 B 线批 1）：<svg>/<math> 是 foreign content，其
// <style>/<textarea>/<title> 不切 raw-text（内容按标记解析）；<noscript> 在脚本开启时
// 才是 raw-text（收尾按字面 </noscript> 匹配，引号不参与）。
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'noscript']);
// 需要连内容一起剥掉的外联载体（embed/frame 是空元素，只去标签）
const EMBED_CONTAINERS = new Set(['iframe', 'object', 'applet', 'frameset']);
const EMBED_VOID = new Set(['embed', 'frame']);
// <link> 里能拉起脚本的 rel
const SCRIPT_LINK_RELS = new Set(['import', 'modulepreload', 'preload', 'prefetch']);

/**
 * 脚本归一化（与 server.mjs 的 normEditorScript 逐字一致）：
 * DOC_ID 的值随文档变 → 比对指纹前先还原成占位符。
 * 注意：只替换第一处（String.replace + 非全局正则），与 server.mjs 行为相同。
 */
export function normalizeScriptForHash(code) {
  return String(code ?? '').replace(/var DOC_ID = '[^']*';/, "var DOC_ID = '{{DOC_ID}}';");
}

/** 脚本指纹：sha256(base64)，与 server.mjs 的 sha256b64(normEditorScript(code)) 同口径 */
export function scriptHash(code) {
  return createHash('sha256').update(normalizeScriptForHash(code), 'utf8').digest('base64');
}

function clip(s, n = 120) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// 标签扫描：返回 { end, name, attrs, isEnd, selfClosing }；不是标签时返回 null。
// 属性带字节区间（lead/end），便于整段删除（含前置空白）。
function scanTag(src, start) {
  let i = start + 1;
  let isEnd = false;
  if (src[i] === '/') { isEnd = true; i++; }
  const nameStart = i;
  while (i < src.length && !/[\s/>]/.test(src[i])) i++;
  const rawName = src.slice(nameStart, i);
  if (!rawName || !/^[a-zA-Z]/.test(rawName)) return null;   // '<' 后不是标签名 → 当文本
  const name = rawName.toLowerCase();
  const attrs = [];
  let selfClosing = false;
  while (i < src.length) {
    const lead = i;                                     // 属性前的空白起点
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    if (src[i] === '>') { i++; break; }
    if (src[i] === '/') {
      if (src[i + 1] === '>') { selfClosing = true; i += 2; break; }
      i++; continue;
    }
    const aStart = i;
    while (i < src.length && !/[\s/>=]/.test(src[i])) i++;
    const aName = src.slice(aStart, i);
    if (!aName) { i++; continue; }
    let value = null, valueEnd = i;
    let j = i;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] === '=') {
      j++;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j];
        const vs = ++j;
        while (j < src.length && src[j] !== q) j++;
        value = src.slice(vs, j);
        valueEnd = Math.min(j + 1, src.length);
        j = valueEnd;
      } else {
        const vs = j;
        while (j < src.length && !/[\s>]/.test(src[j])) j++;
        value = src.slice(vs, j);
        valueEnd = j;
      }
      i = j;
    }
    attrs.push({ name: aName.toLowerCase(), value, lead, end: valueEnd });
  }
  return { end: i, name, attrs, isEnd, selfClosing };
}

function attrValue(tag, name) {
  for (const a of tag.attrs) if (a.name === name) return a.value;
  return null;
}

// 去掉字符实体后再判协议（浏览器先解码实体再解析 URL）。
function decodeEntities(v) {
  const cp = (n) => (n === 0 || n > 0x10ffff ? '' : String.fromCodePoint(n));
  return String(v)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => cp(parseInt(d, 10)))
    .replace(/&colon;/gi, ':')
    .replace(/&Tab;/gi, '\t')
    .replace(/&NewLine;/gi, '\n');
}

// javascript: / vbscript: 判定：先去控制字符与空白（浏览器会忽略它们），再比协议。
function isScriptUrl(value) {
  if (value === null || value === undefined) return false;
  const compact = decodeEntities(value).replace(/[\u0000-\u0020\u00a0\u2028\u2029]/g, '').toLowerCase();
  return compact.startsWith('javascript:') || compact.startsWith('vbscript:');
}

// raw-text 元素的内容与结束标签位置（HTML raw-text 规则：第一个 `</name` + 分隔符即结束）
function rawTextContent(src, lower, from, name) {
  const close = '</' + name;
  let i = from;
  while (true) {
    const idx = lower.indexOf(close, i);
    if (idx < 0) return { content: src.slice(from), contentEnd: src.length, elemEnd: src.length };
    const after = idx + close.length;
    const c = src[after];
    if (c === undefined || c === '>' || c === '/' || /\s/.test(c)) {
      const gt = src.indexOf('>', after);
      return { content: src.slice(from, idx), contentEnd: idx, elemEnd: gt < 0 ? src.length : gt + 1 };
    }
    i = idx + 1;
  }
}

// 跳过带内容的元素（含同名嵌套计数）
function skipElement(src, from, name) {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) return src.length;
    const t = scanTag(src, lt);
    if (!t) { i = lt + 1; continue; }
    if (t.name === name) {
      if (t.isEnd) { depth--; if (depth === 0) return t.end; }
      else if (!t.selfClosing) depth++;
    }
    i = t.end;
  }
  return src.length;
}

// 区间删除（cuts 已按出现顺序）
function applyCuts(slice, cuts) {
  let res = '';
  let pos = 0;
  for (const [s, e] of cuts) { res += slice.slice(pos, s); pos = e; }
  return res + slice.slice(pos);
}

/**
 * 构造受信渲染输入。
 * @param {string} html 待渲染 HTML（通常是 freezeHtml 的产物）
 * @param {{knownScriptHashes?: Set<string>|Iterable<string>, maxHtmlBytes?: number}} [options]
 * @returns {{html: string, removed: {kind: string, detail: string}[], hasUnknownScript: boolean,
 *            bytes: number, outBytes: number}}
 */
export function trustedRenderHtml(html, options = {}) {
  const src = String(html ?? '');
  const bytes = Buffer.byteLength(src, 'utf8');
  const maxHtmlBytes = Number.isFinite(options.maxHtmlBytes) ? options.maxHtmlBytes : 4 * 1024 * 1024;
  const known = options.knownScriptHashes instanceof Set
    ? options.knownScriptHashes
    : new Set(options.knownScriptHashes || []);
  const removed = [];

  // 超限：抛错而不是静默截断（截断会破坏版式）。err.removed 保留报告。
  if (bytes > maxHtmlBytes) {
    removed.push({ kind: RENDER_REMOVED_KINDS.TOO_LARGE, detail: `HTML ${bytes} 字节 > 上限 ${maxHtmlBytes}` });
    const err = new Error(`渲染输入超限: ${bytes} 字节 > 上限 ${maxHtmlBytes}`);
    err.code = 'RENDER_INPUT_TOO_LARGE';
    err.bytes = bytes;
    err.removed = removed;
    throw err;
  }

  const lower = src.toLowerCase();
  const out = [];
  let i = 0;
  let hasUnknownScript = false;
  // foreign content 深度（<svg>/<math>）：深度 > 0 时其 style/textarea/title 内容按标记解析。
  // 不模拟浏览器 breakout 列表：breakout 后浏览器把后续 style 当 inert raw-text，本净化器
  // 继续按标记扫只会多剥不会少剥（保守方向，安全）。
  let foreignDepth = 0;

  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { out.push(src.slice(i)); break; }
    if (lt > i) out.push(src.slice(i, lt));

    // HTML 注释（含条件注释 <!--[if IE]> 与注释内脚本）→ 全部移除
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      const stop = end < 0 ? src.length : end + 3;
      removed.push({ kind: RENDER_REMOVED_KINDS.COMMENT, detail: clip(src.slice(lt, stop)) });
      i = stop;
      continue;
    }
    // 声明与处理指令（<!DOCTYPE html>、<?xml ...?>）→ 原样保留
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      const end = src.indexOf('>', lt);
      const stop = end < 0 ? src.length : end + 1;
      out.push(src.slice(lt, stop));
      i = stop;
      continue;
    }

    const tag = scanTag(src, lt);
    if (!tag) { out.push('<'); i = lt + 1; continue; }   // 普通文本里的 '<'

    // 结束标签：没有对应开标签时原样保留（浏览器忽略孤立结束标签）
    if (tag.isEnd) {
      if ((tag.name === 'svg' || tag.name === 'math') && foreignDepth > 0) foreignDepth--;
      out.push(src.slice(lt, tag.end));
      i = tag.end;
      continue;
    }
    if ((tag.name === 'svg' || tag.name === 'math') && !tag.selfClosing) foreignDepth++;

    // ① 通用属性清洗：事件属性 + javascript:/vbscript: URL（对所有标签生效，包括 script/style）
    const cuts = [];
    for (const a of tag.attrs) {
      if (EVENT_ATTR_RE.test(a.name)) {
        removed.push({ kind: RENDER_REMOVED_KINDS.EVENT_ATTRIBUTE, detail: `<${tag.name} ${a.name}>` });
        cuts.push([a.lead, a.end]);
        continue;
      }
      if (URL_ATTRS.has(a.name) && isScriptUrl(a.value)) {
        removed.push({ kind: RENDER_REMOVED_KINDS.JAVASCRIPT_URL, detail: `<${tag.name} ${a.name}="javascript:...">` });
        cuts.push([a.lead, a.end]);
      }
    }
    const openTag = cuts.length ? applyCuts(src.slice(lt, tag.end), cuts.map(([s, e]) => [s - lt, e - lt])) : src.slice(lt, tag.end);

    // ② <script>：外链 → 整个移除；内联 → 按指纹决定保留还是移除
    if (tag.name === 'script') {
      const raw = rawTextContent(src, lower, tag.end, 'script');
      const srcAttr = attrValue(tag, 'src');
      if (srcAttr !== null) {
        removed.push({ kind: RENDER_REMOVED_KINDS.EXTERNAL_SCRIPT, detail: `外链脚本: ${clip(srcAttr)}` });
        hasUnknownScript = true;
        i = raw.elemEnd;
        continue;
      }
      const h = scriptHash(raw.content);
      if (known.has(h)) {
        // 字节级保留：开标签（已清事件属性）+ 原样脚本内容 + 原样结束标签
        out.push(openTag, raw.content, src.slice(raw.contentEnd, raw.elemEnd));
      } else {
        removed.push({ kind: RENDER_REMOVED_KINDS.UNKNOWN_SCRIPT, detail: `未知内联脚本 sha256-b64=${h}` });
        hasUnknownScript = true;
      }
      i = raw.elemEnd;
      continue;
    }

    // ③ raw-text 元素，原样保留（只清过属性）。两个例外对齐浏览器（BL-P1-01）：
    // - foreign content（svg/math）内的 style/textarea/title 不是 raw-text → 落到普通路径，
    //   内容按标记继续扫（内嵌 script 走 ② 剥除、on* 走 ① 剪掉）；
    // - <noscript> 无论在哪层都按 raw-text（渲染 worker 脚本常开），字面 </noscript> 收尾
    //   与浏览器一致 → 引号里的 </noscript> 之后的逃逸标记回到主循环正常清洗。
    if (RAW_TEXT_TAGS.has(tag.name) && (tag.name === 'noscript' || foreignDepth === 0)) {
      const raw = rawTextContent(src, lower, tag.end, tag.name);
      out.push(openTag, raw.content, src.slice(raw.contentEnd, raw.elemEnd));
      i = raw.elemEnd;
      continue;
    }

    // ④ 外联载体
    if (EMBED_CONTAINERS.has(tag.name)) {
      const elemEnd = skipElement(src, tag.end, tag.name);
      removed.push({ kind: RENDER_REMOVED_KINDS.EMBED_ELEMENT, detail: `<${tag.name}> 外部载体` });
      i = elemEnd;
      continue;
    }
    if (EMBED_VOID.has(tag.name)) {
      removed.push({ kind: RENDER_REMOVED_KINDS.EMBED_ELEMENT, detail: `<${tag.name}> 外部载体` });
      i = tag.end;
      continue;
    }

    // ⑤ <meta http-equiv="refresh">
    if (tag.name === 'meta') {
      const he = attrValue(tag, 'http-equiv');
      if (he !== null && he.trim().toLowerCase() === 'refresh') {
        removed.push({ kind: RENDER_REMOVED_KINDS.META_REFRESH, detail: 'meta http-equiv=refresh' });
        i = tag.end;
        continue;
      }
    }

    // ⑥ <link> 里能拉起脚本的 rel
    if (tag.name === 'link') {
      const rels = String(attrValue(tag, 'rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
      const as = String(attrValue(tag, 'as') || '').toLowerCase();
      const isScriptLink = rels.some((r) => SCRIPT_LINK_RELS.has(r)) && (rels.some((r) => r === 'import' || r === 'modulepreload') || as === 'script');
      if (isScriptLink) {
        removed.push({ kind: RENDER_REMOVED_KINDS.SCRIPT_LINK, detail: `<link rel="${rels.join(' ')}" as="${as}">` });
        i = tag.end;
        continue;
      }
    }

    // ⑦ <base href>（改变相对 URL 解析基准）
    if (tag.name === 'base' && attrValue(tag, 'href') !== null) {
      removed.push({ kind: RENDER_REMOVED_KINDS.BASE_HREF, detail: '<base href> 改变相对 URL 基准' });
      i = tag.end;
      continue;
    }

    out.push(openTag);
    i = tag.end;
  }

  const result = out.join('');
  return {
    html: result,
    removed,
    hasUnknownScript,
    bytes,
    outBytes: Buffer.byteLength(result, 'utf8')
  };
}
