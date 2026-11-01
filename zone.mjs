// zone.mjs — 区域绑定数据层（纯函数，零网络）：zid 规范 / 初绑启发式 / meta↔正文同步 / 区域文本提取
// 纪律：zid 只落在段落单位上（p/li/h1-4/.entry-head/.contact），section 与 section-title 不打；
// 区域归属只存 docs-meta.json 的 zones map，正文只带非视觉属性 data-zid。
// 属性值含 '>' 与 data-zid 松散形态（单引号/空格/无引号）均按浏览器口径处理（B 线批 2，
// BL-P5-01/P5-05）：开标签末端引号感知扫描；松散形态识别 + 归一替换（不追加）。
import { sectionsOf, matchingClose, closeIndex, docToText } from './extract.mjs';
import { factGuard } from './job.mjs';

export const ZONE_KEYS = ['personal', 'education', 'work', 'project', 'skill', 'award', 'summary', 'other'];
const UNIT_NAMES = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'div']);
const ZID_SRC = 'z[0-9a-f]{8}';
// data-zid 属性形态（BL-P5-05）：等号两侧容空格、值容单/双/无引号；捕获组 1 = zid 本值。
// 只认「双引号紧凑」形态时，松散形态的合法 zid 被当缺失打新值、摘除正则又摘不掉旧值
// → 同一元素双 data-zid → zoneEditUnits 抛错 → 该文档区域保存通道永久 400。
const ZID_ATTR = new RegExp(`\\sdata-zid\\s*=\\s*["']?(${ZID_SRC})["']?`);
const ZID_STRICT_ATTR = new RegExp(`\\sdata-zid="(${ZID_SRC})"`);   // 规范形态（归一目标）
const ZID_ANY_ATTR = /\sdata-zid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g;   // 任意形态/任意值的 data-zid（摘除用）

// 开标签末端（引号感知，BL-P5-01）：跳过 "…"/'…' 属性值区间后找 '>'。
// 朴素 indexOf('>') 在属性值含 '>' 时（<p title="a>b">）把标签截断在引号内，
// normalizeZids 按截断片段重写开标签 → 每次保存都把正文改坏。引号未闭合 → -1（按残片处理，不猜）。
function tagEnd(s, from) {
  const n = s.length;
  let q = 0;
  for (let k = from; k < n; k++) {
    const c = s[k];
    if (q) { if (c === q) q = 0; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '>') return k;
  }
  return -1;
}

// 段落单位扫描（线性）。
// 旧写法是正则 /<(p|li|h[1-4]|div)((?:\s[^>]*)?)>/gi —— `[^>]*` 后接必有的 '>'，
// 全文没有 '>' 时每个候选点回溯 O(长度) → 整体平方级
// （实测 8000 个未闭合引号的标签 = 250ms；/save 走 normalizeZids → 每次保存都卡）。
// 语义与旧正则一致：标签名 = p/li/h1-4/div；属性区 = 标签名与 '>' 之间，
// 要么为空，要么以空白开头（所以 <p/> 这种不算单位）。
function unitTags(s) {
  const out = [];
  const n = s.length;
  const lastGt = s.lastIndexOf('>');      // 之后没有 '>' → 残片，O(1) 判定（否则每个候选点都扫到文末 → 平方级）
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    let j = lt + 1;
    const ns = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) j++;
      else break;
    }
    const tag = s.slice(ns, j);
    if (!UNIT_NAMES.has(tag.toLowerCase())) { i = lt + 1; continue; }
    if (j > lastGt) { i = lt + 1; continue; }               // 后面再没有 '>' → 不是标签（引号感知的末端只会更靠后，判定仍成立）
    const gt = tagEnd(s, j);
    if (gt < 0) { i = lt + 1; continue; }                    // 引号未闭合/没有 '>' → 不是标签
    const attrs = s.slice(j, gt);
    if (attrs && !/^\s/.test(attrs)) { i = lt + 1; continue; }
    out.push({ raw: s.slice(lt, gt + 1), tag, attrs, index: lt });
    i = gt + 1;
  }
  return out;
}

export function newZid() {
  return 'z' + Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

function isUnit(tag, attrs) {
  if (tag.toLowerCase() === 'div') return /\b(?:entry-head|contact)\b/.test(attrs);
  return true;   // p / li / h1-4
}

// 打点归一：缺失补、坏值/重复重打（保首）。幂等：已规范的输入原样返回。
export function normalizeZids(html, gen = newZid) {
  const seen = new Set();
  const s = String(html);
  const units = unitTags(s);
  if (!units.length) return s;
  let out = '', last = 0;
  for (const u of units) {
    if (!isUnit(u.tag, u.attrs)) continue;
    const m = ZID_ATTR.exec(u.attrs);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      // 已是规范形态（双引号紧凑）→ 原样保留；合法 zid 但形态松散（单引号/空格/无引号）
      // → 摘旧写新（同值、规范形态），防下游严格匹配踩空（BL-P5-05）
      if (ZID_STRICT_ATTR.test(u.attrs)) continue;
      const rep = `<${u.tag}${u.attrs.replace(ZID_ANY_ATTR, '')} data-zid="${m[1]}">`;
      out += s.slice(last, u.index) + rep;
      last = u.index + u.raw.length;
      continue;
    }
    const zid = gen();
    seen.add(zid);
    // 坏值（有 data-zid 属性但不合法）当作缺失：摘旧打新，不产生双 data-zid
    const rep = `<${u.tag}${u.attrs.replace(ZID_ANY_ATTR, '')} data-zid="${zid}">`;
    out += s.slice(last, u.index) + rep;
    last = u.index + u.raw.length;
  }
  return out + s.slice(last);
}

// 全部合法 zid（文档序去重）。只认段落单位上的：section-title 等非单位开标签手改的 data-zid 不计。
export function zidsOf(html) {
  const out = [];
  for (const u of unitTags(String(html))) {
    if (!isUnit(u.tag, u.attrs)) continue;
    const zid = ZID_ATTR.exec(u.attrs);
    if (zid && !out.includes(zid[1])) out.push(zid[1]);
  }
  return out;
}

// 段落单位 → {zid, text}（text 为去标签纯文本）。
// 嵌套单位只出最外层：跳到闭合后内层不再单独成条（text 已合并内层文字，避免重复计入；zidsOf 不跳过、内外层都登记）。
export function parasOf(html) {
  const s = String(html);
  const out = [];
  const units = unitTags(s);
  if (!units.length) return out;
  // 只为「实际用到的标签名」建索引——closeIndex 每个名字独立扫一遍，
  // 只扫用到的名字，别为 7 个名字白扫 7 遍（文档里通常只有 p/div）。
  const names = new Set();
  for (const u of units) {
    if (!isUnit(u.tag, u.attrs)) continue;
    if (!ZID_ATTR.test(u.attrs)) continue;
    names.add(u.tag.toLowerCase());
  }
  if (!names.size) return out;
  const idx = closeIndex(s, [...names]);
  let skipUntil = 0;          // 已接受的外层单位 → 其内部的单位不再单独成条
  for (const u of units) {
    if (u.index < skipUntil) continue;
    if (!isUnit(u.tag, u.attrs)) continue;
    const zidM = ZID_ATTR.exec(u.attrs);
    if (!zidM) continue;
    const close = matchingClose(s, u.index, u.tag, idx);
    if (close < 0) continue;
    const text = s.slice(u.index, close).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ zid: zidM[1], text });
    skipUntil = close;
  }
  return out;
}

// ===== 区域编辑单位（zone-v1 口径；只增加导出，不改 parasOf / zidsOf / normalizeZids / 历史指纹）=====
// 与 parasOf 的差别：给出「可替换内容范围」（innerStart/innerEnd）并用统一文本口径规范化。
// 文本口径：HTML 实体只解码一次、空白（含 NBSP）折叠为单空格、trim；
// 「A B」与「AB」是不同文本（contentHash 区分，不做空白无关的归一）。
// raw text 元素：内容按纯文本处理，结束于同名结束标签（不计嵌套）。
// RCDATA 元素（textarea/title）：内容同样不是标签（实体可解码，但标签字面量不成立）。
// noscript 在启用脚本的浏览器里走 raw text 规则（其内容不渲染）→ 归入 raw text。
const RAW_TEXT_TAGS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
const RCDATA_TAGS = new Set(['textarea', 'title']);

// 标签名字符：ASCII 字母数字、'-'、':'。
// ':' 必须收进名字里：HTML 的 tag name state 把 ':' 当普通字符追加，
// 所以 </script:fake> 的结束标签名是 "script:fake"（≠ "script"）—— 它不是 script 的结束。
const isTagNameChar = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 58;
const isWsChar = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;

// 读一个标签：{ lt, name, closing, selfClosing, end }
// end = '>' 之后一位。属性区引号内的 '>' 不结束标签；引号未闭合 → 延伸到文末（不猜范围）。
function readTag(s, lt) {
  const n = s.length;
  let j = lt + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; }   // '/'
  const ns = j;
  while (j < n && isTagNameChar(s.charCodeAt(j))) j++;
  if (j === ns) return null;                              // 没有标签名 → 不是标签
  const name = s.slice(ns, j).toLowerCase();              // 只含 ASCII → 长度不变，下标不漂移
  let k = j;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (c === 34 || c === 39) {                          // '"' / '\''：引号内的 '>' 不是标签结束
      const q = s.indexOf(c === 34 ? '"' : "'", k + 1);
      if (q < 0) return { lt, name, closing, selfClosing: false, end: n };
      k = q + 1;
      continue;
    }
    if (c === 62) {                                       // '>'
      let p = k - 1;
      while (p > j && isWsChar(s.charCodeAt(p))) p--;
      return { lt, name, closing, selfClosing: s.charCodeAt(p) === 47, end: k + 1 };
    }
    k++;
  }
  return { lt, name, closing, selfClosing: false, end: n };
}

// 注释结束位置（其后一位）
function skipComment(s, lt) {
  const end = s.indexOf('-->', lt + 4);
  return end < 0 ? s.length : end + 3;
}

// raw text / RCDATA 内容结束位置。
// 结束标签名之后必须是空白、'/' 或 '>'：所以 </scripture>、</script:fake> 都不是结束，
// 而 </script>、</script foo>、</script/> 都是。
// 用原串上的正则（带 i）而不是 toLowerCase 副本：部分字符（如 U+0130）小写后长度会变，副本会让下标漂移。
function skipRawText(s, from, tag) {
  const re = new RegExp('</' + tag + '(?=[\\s/>])', 'gi');
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) return s.length;
  const t = readTag(s, m.index);
  return t ? t.end : s.length;
}

// template 内容结束位置（真实嵌套配对）。
// 注释、属性引号里的 </template>、template 内的脚本内容都不能提前结束它。
function skipTemplate(s, from) {
  const n = s.length;
  let i = from;
  let depth = 1;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) { i = skipComment(s, lt); continue; }
    if (s.charCodeAt(lt + 1) === 33) {                  // '<!'：doctype / bogus comment → 跳到 '>'
      const gt = s.indexOf('>', lt + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    const t = readTag(s, lt);
    if (!t) { i = lt + 1; continue; }
    if (t.closing) {
      if (t.name === 'template') { depth--; if (depth === 0) return t.end; }
      i = t.end;
      continue;
    }
    if (t.name === 'template') { depth++; i = t.end; continue; }
    if (RAW_TEXT_TAGS.has(t.name)) { i = skipRawText(s, t.end, t.name); continue; }
    if (RCDATA_TAGS.has(t.name)) { i = skipRawText(s, t.end, t.name); continue; }
    i = t.end;
  }
  return n;   // 未闭合 → 延伸到文末（不猜范围）
}

// 不可写区域（脚本/样式/模板/原始文本/注释）：其内的标签字面量不是正文单位，
// 外来内联脚本里的 <li data-zid="z..."> 不得被当成可写正文。
// 单遍扫描；区域互不重叠且按文档序 → 总体线性（不做逐候选点回扫）。
function nonBodyRanges(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) {
      const stop = skipComment(s, lt);
      out.push([lt, stop]);
      i = stop;
      continue;
    }
    if (s.charCodeAt(lt + 1) === 33) {                  // doctype / bogus comment：不含标签字面量，不入屏蔽区
      const gt = s.indexOf('>', lt + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    const t = readTag(s, lt);
    if (!t) { i = lt + 1; continue; }
    if (t.closing) { i = t.end; continue; }
    if (RAW_TEXT_TAGS.has(t.name) || RCDATA_TAGS.has(t.name)) {
      const stop = skipRawText(s, t.end, t.name);
      out.push([lt, stop]);
      i = stop;
      continue;
    }
    if (t.name === 'template') {
      const stop = skipTemplate(s, t.end);
      out.push([lt, stop]);
      i = stop;
      continue;
    }
    i = t.end;
  }
  return out;
}

// 等长屏蔽视图：把非正文区域替换成空格，长度不变 → 所有下标仍对应原始 HTML。
// 单位识别与闭合配对都跑在这份视图上，注释/脚本里的假闭标签就不会参与配对。
function maskNonBody(s, ranges) {
  if (!ranges.length) return s;
  const buf = s.split('');
  for (const [a, b] of ranges) for (let k = a; k < b; k++) buf[k] = ' ';
  return buf.join('');
}

// 区域可写单位：{ zid, count, start, end, innerStart, innerEnd, text }
// - 只认段落单位（p/li/h1-4/.entry-head/.contact）上唯一的合法 data-zid；
// - 嵌套单位只出最外层（内层不再单独成条，text 已合并内层文字）；
// - 未闭合单位不猜范围（不产出）；
// - 同一 zid 出现多次 → count>1（调用方据此拒绝，不悄悄重打 ID）；
// - 同一单位出现多个 data-zid 属性 → 直接报错（形状非法，不猜）。
export function zoneEditUnits(html) {
  const s = String(html);
  const masked = maskNonBody(s, nonBodyRanges(s));
  // 单位识别与闭合配对用同一份屏蔽视图（同一套非正文排除规则）
  const all = unitTags(masked).filter((u) => isUnit(u.tag, u.attrs) && ZID_ATTR.test(u.attrs));
  const counts = new Map();
  for (const u of all) {
    if ((u.attrs.match(/\sdata-zid\s*=/gi) || []).length !== 1) {
      throw new Error('区域单位存在重复 data-zid 属性');
    }
    const zid = ZID_ATTR.exec(u.attrs)[1];
    counts.set(zid, (counts.get(zid) || 0) + 1);
  }
  const idx = closeIndex(masked, [...new Set(all.map((u) => u.tag.toLowerCase()))]);
  let until = 0;
  const out = [];
  for (const u of all) {
    if (u.index < until) continue;            // 嵌套在已接受单位内 → 不重复处理
    const end = matchingClose(masked, u.index, u.tag, idx);
    if (end < 0) continue;                    // 未闭合 → 不猜范围
    const innerStart = u.index + u.raw.length;
    const innerEnd = s.lastIndexOf('<', end - 1);
    if (innerEnd < innerStart) continue;
    const zid = ZID_ATTR.exec(u.attrs)[1];
    out.push({
      zid, count: counts.get(zid), start: u.index, end, innerStart, innerEnd,
      // 文本取自原始 HTML：屏蔽视图里的空格是屏蔽产物，不应进入用户可见文本
      text: docToText(s.slice(innerStart, innerEnd), { includeHidden: true })
        .replace(/\s+/g, ' ').trim()
    });
    until = end;
  }
  return out;
}

// 初绑启发式（单一来源）：章节标题 → 8 类。顺序敏感：summary 的“个人总结”必须先于 personal 的“个人”词根。
const ZONE_TITLES = [
  [/自我评价|自评|个人总结|个人简介|关于我/, 'summary'],
  [/个人信息|联系方式|基本信息/, 'personal'],
  [/教育|学历|学校/, 'education'],
  [/项目/, 'project'],
  [/技能|技术栈|工具/, 'skill'],
  [/获奖|荣誉|证书|奖项/, 'award'],
  [/工作|实习|职业|履历/, 'work'],
];
export function guessZone(title) {
  const t = String(title || '');
  for (const [re, z] of ZONE_TITLES) if (re.test(t)) return z;
  return 'other';
}

// meta↔正文同步（/save 时调用，正文为准）：多余清、缺失补 pending+启发式、已有归属/状态不动。
// 注意：sectionsOf 返回的 start/end 是 bodyOf() 坐标系，不能拿来切原 html——
// “sections 外的 zid”（sheet 头部 .contact 区 → personal）用集合差求，天然无坐标系问题。
export function zoneSync(html, meta) {
  const secs = sectionsOf(String(html));
  const found = new Map();
  const inSecs = new Set();
  for (const s of secs) for (const z of zidsOf(s.html)) { found.set(z, s.title); inSecs.add(z); }
  // 所有 sections 外的 zid（含文档尾部）按 '个人信息' → personal 映射
  for (const z of zidsOf(html)) if (!inSecs.has(z)) found.set(z, '个人信息');
  const zones = {};
  for (const [zid, title] of found) {
    zones[zid] = (meta.zones && meta.zones[zid]) || { zone: guessZone(title), status: 'pending' };
  }
  return { ...meta, zones };
}

// ===== S3-T5：区域级 AI 纯函数（受约束 prompt + 解析；网络与落盘在 server.mjs）=====
export const ZONE_LABELS = { personal: '个人', education: '教育', work: '工作', project: '项目', skill: '技能', award: '获奖', summary: '自评', other: '其他' };

// 区域文本提取：只取归属该区域的段落（meta.zones 为准；无归属的段落不参与）
export function zoneParas(html, meta, zone) {
  return parasOf(html).filter((p) => {
    const z = meta.zones && meta.zones[p.zid];
    return z && z.zone === zone;
  });
}

// 全文摘要（请求最小化）：每章只取标题 + 首段前 per 字，供区域分析看上下文而不带全文
export function digestOf(html, per = 40) {
  return sectionsOf(String(html)).map((s) => {
    const paras = parasOf(s.html);
    const first = paras.length ? paras[0].text : '';   // 只取首段：拼接全部再 slice 会把后续段的联系方式带进 LLM prompt
    return `【${s.title || '未命名'}】${first.slice(0, per)}`;
  }).join('\n');
}

export function buildZoneAnalyzePrompt({ zoneName, zoneText: zt, digest, rounds = 0 }) {
  const sys = `你是简历的区域分析顾问。只输出 JSON，不输出 HTML、脚本或解释文字。
格式：{"echoes":["与其他区域的呼应（指名区域）"],"reminder":"一个最重要的提醒","suggestion":"你可以这样改（具体可执行）","chips":["建议继续问的问题"]}
硬约束：不得编造事实/数字/经历；不得建议夸大；意见必须可在给定区域文本内执行；echoes ≤4 条，chips ≤3 条。`;
  const user = `【全文摘要】\n${digest}\n\n【区域：${zoneName}】\n${zt || '（该区域暂无内容）'}${rounds ? `\n\n（第 ${rounds + 1} 轮对话，意见递进不重复前轮）` : ''}`;
  return { sys, user };
}

const stripFence = (raw) => String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

export function parseZoneAnalysis(raw) {
  try {
    const d = JSON.parse(stripFence(raw));
    if (!d || typeof d !== 'object') return null;
    return {
      echoes: Array.isArray(d.echoes) ? d.echoes.filter((x) => typeof x === 'string' && x.trim()).slice(0, 4) : [],
      reminder: typeof d.reminder === 'string' ? d.reminder : '',
      suggestion: typeof d.suggestion === 'string' ? d.suggestion : '',
      chips: Array.isArray(d.chips) ? d.chips.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3) : []
    };
  } catch { return null; }
}

export function buildZoneRewritePrompt({ zoneName, paras, instruction }) {
  const sys = `你是简历区域改写器。只输出 JSON：{"rewrites":[{"zid":"段落ID","candidate":"改后纯文本"}]}
硬约束：1) 只改写给定段落，不需要改的段落不输出；2) 不得引入原文没有的数字/日期/公司/职位/技能；3) 不得改变事实归属（团队成果↔个人贡献、参与↔主导禁止互换）；4) candidate 为纯文本不含标记。`;
  const user = `【区域：${zoneName}】\n【修改意见】${instruction}\n\n【段落】\n${paras.map((p) => `(${p.zid}) ${p.text}`).join('\n')}`;
  return { sys, user };
}

// 改写解析：只收已知 zid、非空且与原文不同；每条过 factGuard（新数字/丢日期 → conflict）
export function parseZoneRewrites(raw, paras) {
  let d;
  try { d = JSON.parse(stripFence(raw)); } catch { return null; }
  const known = new Map(paras.map((p) => [p.zid, p]));
  const arr = Array.isArray(d && d.rewrites) ? d.rewrites : [];
  const out = [];
  for (const r of arr) {
    if (!r || typeof r.zid !== 'string' || typeof r.candidate !== 'string') continue;
    const p = known.get(r.zid);
    if (!p || !r.candidate.trim() || r.candidate.trim() === p.text) continue;
    out.push(factGuard({ zid: r.zid, before: p.text, after: r.candidate.trim(), candidate: r.candidate.trim(), kind: 'replace', level: 'normal' }));
  }
  return out;
}

// ===== S3-T7：素材事实层（事实与表达分离）=====
export const FACT_KEYS = ['company', 'role', 'dates', 'education', 'metrics', 'contribution', 'conditions', 'source'];
export const MAT_STATES = ['pending', 'confirmed', 'outdated'];

// 旧素材迁移为事实层形状：confirmed 布尔 → factStatus（幂等：已迁移条目原样返回，不复制）。
// facts 按 FACT_KEYS 置空/补齐（旧键 brief/technical/interview 是表达层，不动）。
export function migrateMats(mats) {
  return (Array.isArray(mats) ? mats : []).map((m) => {
    if (m && m.factStatus && m.facts && !('confirmed' in m)) return m;   // 已迁移
    const out = { ...m };
    delete out.confirmed;
    if (!FACT_KEYS.every((k) => typeof (out.facts || {})[k] === 'string')) out.facts = Object.fromEntries(FACT_KEYS.map((k) => [k, (out.facts && out.facts[k]) || '']));
    if (!MAT_STATES.includes(out.factStatus)) out.factStatus = m && m.confirmed === true ? 'confirmed' : 'pending';
    return out;
  });
}
