// zone.mjs — 区域绑定数据层（纯函数，零网络）：zid 规范 / 初绑启发式 / meta↔正文同步 / 区域文本提取
// 纪律：zid 只落在段落单位上（p/li/h1-4/.entry-head/.contact），section 与 section-title 不打；
// 区域归属只存 docs-meta.json 的 zones map，正文只带非视觉属性 data-zid。
// 假设：属性值含 > 时开标签匹配退化（与 extract.mjs 同假设）——读取层只降级，写回层同样不处理该形状。
import { sectionsOf, matchingClose } from './extract.mjs';

export const ZONE_KEYS = ['personal', 'education', 'work', 'project', 'skill', 'award', 'summary', 'other'];
const UNIT_RE = /<(p|li|h[1-4]|div)((?:\s[^>]*)?)>/gi;
const ZID_SRC = 'z[0-9a-f]{8}';
const ZID_ATTR = new RegExp(`\\sdata-zid="(${ZID_SRC})"`);   // 属性区内的合法 zid
const ZID_ANY_ATTR = /\sdata-zid="[^"]*"/g;                  // 任意值的 data-zid 属性（坏值摘除用）

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
  return String(html).replace(UNIT_RE, (raw, tag, attrs = '') => {
    if (!isUnit(tag, attrs)) return raw;
    const m = ZID_ATTR.exec(attrs);
    if (m && !seen.has(m[1])) { seen.add(m[1]); return raw; }
    const zid = gen();
    seen.add(zid);
    // 坏值（有 data-zid 属性但不合法）当作缺失：摘旧打新，不产生双 data-zid
    return `<${tag}${attrs.replace(ZID_ANY_ATTR, '')} data-zid="${zid}">`;
  });
}

// 全部合法 zid（文档序去重）。只认段落单位上的：section-title 等非单位开标签手改的 data-zid 不计。
export function zidsOf(html) {
  const s = String(html);
  const out = [];
  let m;
  UNIT_RE.lastIndex = 0;
  while ((m = UNIT_RE.exec(s))) {
    if (!isUnit(m[1], m[2] || '')) continue;
    const zid = ZID_ATTR.exec(m[2] || '');
    if (zid && !out.includes(zid[1])) out.push(zid[1]);
  }
  return out;
}

// 段落单位 → {zid, text}（text 为去标签纯文本）。
// 嵌套单位只出最外层：跳到闭合后内层不再单独成条（text 已合并内层文字，避免重复计入；zidsOf 不跳过、内外层都登记）。
export function parasOf(html) {
  const s = String(html);
  const out = [];
  let m;
  UNIT_RE.lastIndex = 0;
  while ((m = UNIT_RE.exec(s))) {
    if (!isUnit(m[1], m[2] || '')) continue;
    const zidM = ZID_ATTR.exec(m[2] || '');
    if (!zidM) continue;
    const close = matchingClose(s, m.index, m[1]);
    if (close < 0) continue;
    const text = s.slice(m.index, close).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    out.push({ zid: zidM[1], text });
    UNIT_RE.lastIndex = close;
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
