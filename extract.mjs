// extract.mjs — 统一正文提取（唯一入口，零依赖）
// 纪律：AI 分析 / 版本对比 / 导出检查全部走这里，禁止各自正则在整份 HTML 上刮文本。
// 规则：只处理文档内容；排除工具栏/脚本/样式/注入外壳/分页线/占位符；隐藏内容默认不参与。
import { createHash } from 'node:crypto';

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

// 编辑器运行时 UI（即使未按注释对剥离也不进正文）
// S2-T5 补充：岗位弹层/遮罩 + 查找面板 + 快捷键弹层 + 聚焦态 class（第二道防线；注释对剥离是第一道）。
// 注意：ed-flash 不得加入本表——isChrome 命中即整元素跳过提取，而 .ed-flash 历史上挂在真实正文节点上；
// 该根因已由 flashEl 改走 CSS Custom Highlight API 消除（不再挂 class），由块 10 断言守护。
const CHROME_MARKERS = [
  /\bedit-toolbar\b/, /\bpage-line\b/, /\btoast\b/, /\brecovery-bar\b/,
  /\bdata-ai-panel\b/, /\bdata-ed-shell\b/, /\bdata-ed-inj\b/,
  /\bdata-ed-shot\b/, /\bed-seltb\b/, /\bed-matpop\b/, /\bed-matmask\b/,
  /\bed-left\b/, /\bed-right\b/, /\bed-status\b/, /\bed-canvas-tools\b/,
  /\bed-jobpop\b/, /\bed-jobmask\b/, /\bed-keys\b/, /\bed-find\b/, /\bed-focus\b/,
  /\bdata-zone-panel\b/
];

const HIDDEN_CLASS = /\b(?:ed-sec-hidden|ed-entry-hidden)\b/;

function isChrome(tag, attrs) {
  if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') return true;
  return CHROME_MARKERS.some((re) => re.test(attrs) && !/\bsheet\b/.test(attrs));
}

// 标签结束位置：跳过引号区间内的 '>'。indexOf('>') 会把 <div title="A > B"> 截在属性值中间，
// 导致标签名/属性解析出错、剥离元素时把 chrome 残片漏进正文（进而进 AI 上下文与版本对比）
function tagEnd(html, lt) {
  let i = lt + 1;
  let q = null;
  while (i < html.length) {
    const ch = html[i];
    if (q) { if (ch === q) q = null; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '>') return i;
    i++;
  }
  return -1;
}

// 通用：按标签深度移除匹配元素（含内容）。attrTest(tag, attrs, rawTag) 判定是否为要移除的开标签。
function removeElements(html, attrTest) {
  let out = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    // 注释：整体丢弃
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const gt = tagEnd(html, lt);
    if (gt < 0) { out += html.slice(lt); break; }
    const raw = html.slice(lt, gt + 1);
    const m = /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    if (!m) { out += raw; i = gt + 1; continue; }
    const tag = m[1].toLowerCase();
    const closing = /^<\s*\//.test(raw);
    const selfClose = /\/\s*>$/.test(raw) || VOID.has(tag);
    if (closing || selfClose || !attrTest(tag, raw)) { out += raw; i = gt + 1; continue; }
    // 命中：跳到匹配的闭合标签之后
    let depth = 1;
    let j = gt + 1;
    while (j < n && depth > 0) {
      const nextLt = html.indexOf('<', j);
      if (nextLt < 0) { j = n; break; }
      const nextGt = tagEnd(html, nextLt);
      if (nextGt < 0) { j = n; break; }
      const inner = html.slice(nextLt, nextGt + 1);
      const im = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(inner);
      if (im && im[1].toLowerCase() === tag) {
        if (/^<\s*\//.test(inner) || /\/\s*>$/.test(inner)) depth--;
        else if (!VOID.has(tag) && !/\/\s*>$/.test(inner)) depth++;
        if (depth === 0) { j = nextGt + 1; break; }
      }
      j = nextGt + 1;
    }
    i = j;
  }
  return out;
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|middot|ldquo|rdquo|lsquo|rsquo|copy|reg|times|divide);/gi, (_, name) => {
      const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', copy: '©', reg: '®', times: '×', divide: '÷' };
      return map[name.toLowerCase()] ?? _;
    });
}
function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

// 取出 <body> 内容（无 body 则整体视为 body）
export function bodyOf(html) {
  const m = /<body[^>]*>([\s\S]*)<\/body\s*>/i.exec(html);
  return m ? m[1] : html;
}

// 统一提取：返回换行分隔的纯文本行数组
/**
 * 标签剥离 · 单遍扫描（S4B-11，替代原正则 `/<(?:[^>"']|"[^"]*"|'[^']*')*>/g`）。
 *
 * 原正则是二次方：从每个 `<` 起点回扫到文末找 `>`，N 个未闭合标签 = O(N×长度)。
 * 实测（2026-10-18）：2000→64ms、4000→254ms、8000→1065ms、16000→4131ms（每档 4×）。
 * /edit、/save、/api/extract、/diff 都走这里，一份从备份进来的病态文档就能把每次保存卡 4 秒。
 *
 * 语义与原正则严格等价：
 *   - 标签 = `<` + (非 `>`/非引号 | "..." 引号内 | '...' 引号内)* + `>`
 *   - 引号内的 `>` 不算标签结束（属性值可以含 `>`）
 *   - **未闭合（扫到文末仍无 `>`）→ 原文保留**，与原正则「不匹配」一致
 *   - `indexOf` 找不到下一个 `<` → 直接返回，不做无用的全串扫描
 */
function stripTagsLinear(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  let lt = src.indexOf('<');
  while (lt !== -1) {
    out += src.slice(i, lt);
    // 从 lt+1 扫到标签结束的 '>'；引号区间内的 '>' 跳过
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const ch = src.charCodeAt(j);
      if (quote) { if (ch === quote.charCodeAt(0)) quote = ''; }
      else if (ch === 34 || ch === 39) quote = ch === 34 ? '"' : "'";   // 34='"' 39="'"
      else if (ch === 62) break;                                          // 62='>'
      j++;
    }
    if (j >= n) return out + src.slice(lt);      // 未闭合 → 保留原文
    out = out;                                    // 标签整体丢弃
    i = j + 1;
    lt = src.indexOf('<', i);
  }
  return out + src.slice(i);
}

export function docToLines(html, { includeHidden = false, keepBlank = false } = {}) {
  let s = String(html ?? '');
  s = s.replace(/<!--AI-INJECT-->[\s\S]*?<!--\/AI-INJECT-->/g, '')
    .replace(/<!--SHELL-INJECT-->[\s\S]*?<!--\/SHELL-INJECT-->/g, '');
  s = bodyOf(s);
  s = removeElements(s, (tag, attrs) => isChrome(tag, attrs));
  if (!includeHidden) s = removeElements(s, (tag, attrs) => HIDDEN_CLASS.test(attrs));
  s = removeElements(s, (tag, attrs) => /\beditable-placeholder\b/.test(attrs));
  s = s
    .replace(/<\/(?:p|li|h1|h2|h3|h4|div|section|header|footer|ul|ol|table|tr|blockquote)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    ;
  s = stripTagsLinear(s);   // 标签剥离：单遍扫描（原正则二次方，见 stripTagsLinear 注释）
  s = decodeEntities(s)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim());
  return keepBlank ? s : s.filter(Boolean);
}

// 纯文本（AI 上下文用；行以 \n 连接）
export function docToText(html, opts) {
  return docToLines(html, opts).join('\n');
}

// 内容哈希：用于 PDF/存档与文档版本绑定
export function contentHash(input) {
  return createHash('sha1').update(String(input ?? '')).digest('hex').slice(0, 16);
}

// 章节解析（供正文提取与变更锚点复用）：[{title, html, hidden}]
export function sectionsOf(html) {
  const body = bodyOf(String(html ?? ''));
  const out = [];
  const re = /<section\b[^>]*class="([^"]*)"[^>]*>/gi;
  let m;
  while ((m = re.exec(body))) {
    const attrs = m[0];
    if (!/\bsection\b/.test(m[1])) continue;
    const close = matchingClose(body, m.index, 'section');
    if (close < 0) continue;
    const inner = body.slice(m.index, close);
    const tm = /<div[^>]*class="[^"]*\bsection-title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(inner);
    out.push({
      title: tm ? decodeEntities(tm[1].replace(/<(?:[^>\"']|\"[^\"]*\"|'[^']*')*>/g, '')).trim() : '',
      html: inner,
      hidden: HIDDEN_CLASS.test(attrs),
      start: m.index,
      end: close
    });
    re.lastIndex = close;
  }
  return out;
}

export function matchingClose(html, openStart, tag) {
  let depth = 0;
  let i = openStart;
  const n = html.length;
  // 属性分支须排除引号区间内的 '>'：与 tagEnd 同口径，否则属性值含 '>' 时两处判定打架
  const re = new RegExp(`<\\s*(\\/?)${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
  re.lastIndex = openStart;
  let m;
  while ((m = re.exec(html)) && i < n) {
    if (m[1] === '/') { depth--; if (depth === 0) return m.index + m[0].length; }
    else if (!/\/\s*>$/.test(m[0])) depth++;
    i = m.index;
  }
  return -1;
}
