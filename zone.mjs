// zone.mjs — 区域绑定数据层（纯函数，零网络）：zid 规范 / 初绑启发式 / meta↔正文同步 / 区域文本提取
// 纪律：zid 只落在段落单位上（p/li/h1-4/.entry-head/.contact），section 与 section-title 不打；
// 区域归属只存 docs-meta.json 的 zones map，正文只带非视觉属性 data-zid。
import { sectionsOf, matchingClose } from './extract.mjs';

export const ZONE_KEYS = ['personal', 'education', 'work', 'project', 'skill', 'award', 'summary', 'other'];
const UNIT_RE = /<(p|li|h[1-4]|div)((?:\s[^>]*)?)>/gi;

export function newZid() {
  return 'z' + Array.from({ length: 8 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}

function isUnit(tag, attrs) {
  if (tag === 'div') return /\b(?:entry-head|contact)\b/.test(attrs);
  return true;   // p / li / h1-4
}

// 打点归一：缺失补、重复重打（保首）。幂等：已规范的输入原样返回。
export function normalizeZids(html, gen = newZid) {
  const seen = new Set();
  return String(html).replace(UNIT_RE, (raw, tag, attrs = '') => {
    if (!isUnit(tag, attrs)) return raw;
    const m = /\sdata-zid="(z[0-9a-f]{8})"/.exec(attrs);
    if (m && !seen.has(m[1])) { seen.add(m[1]); return raw; }
    const zid = gen();
    seen.add(zid);
    return m
      ? raw.replace(/\sdata-zid="z[0-9a-f]{8}"/, ` data-zid="${zid}"`)
      : `<${tag}${attrs} data-zid="${zid}">`;
  });
}

export function zidsOf(html) {
  const out = [];
  const re = /data-zid="(z[0-9a-f]{8})"/g;
  let m;
  while ((m = re.exec(String(html)))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// 段落单位 → {zid, text}（text 为去标签纯文本）
export function parasOf(html) {
  const s = String(html);
  const out = [];
  let m;
  UNIT_RE.lastIndex = 0;
  while ((m = UNIT_RE.exec(s))) {
    if (!isUnit(m[1], m[2] || '')) continue;
    const zidM = /data-zid="(z[0-9a-f]{8})"/.exec(m[2] || '');
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
  for (const z of zidsOf(html)) if (!inSecs.has(z)) found.set(z, '个人信息');   // 第一个 section 之前 = sheet 头部
  const zones = {};
  for (const [zid, title] of found) {
    zones[zid] = (meta.zones && meta.zones[zid]) || { zone: guessZone(title), status: 'pending' };
  }
  return { ...meta, zones };
}
