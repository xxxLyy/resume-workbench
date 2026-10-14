// zone.mjs — 区域绑定数据层（纯函数，零网络）：zid 规范 / 初绑启发式 / meta↔正文同步 / 区域文本提取
// 纪律：zid 只落在段落单位上（p/li/h1-4/.entry-head/.contact），section 与 section-title 不打；
// 区域归属只存 docs-meta.json 的 zones map，正文只带非视觉属性 data-zid。
// 假设：属性值含 > 时开标签匹配退化（与 extract.mjs 同假设）——读取层只降级，写回层同样不处理该形状。
import { sectionsOf, matchingClose } from './extract.mjs';
import { factGuard } from './job.mjs';

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
