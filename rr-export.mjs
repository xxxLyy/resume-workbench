// rr-export.mjs — 本仓 HTML 文档 → Reactive Resume v4 resumeData（纯函数、零落盘、零网络）
// 路径 C（dev-docs/2026-11-18-reactive-resume-adoption.md §3）：HTML 是唯一真源，投影现算。
// 复用：extract.mjs sectionsOf（章节切分）+ apply-profile.mjs deriveResumeFields/SECTION_TITLES（派生口径）。
//
// 章节映射（标题 → v4 段；标题表 = SECTION_TITLES 同口径 + 常见英文别名，大小写不敏感）：
//   个人总结/自我评价/自评/summary/objective → sections.summary（content 段）
//   工作经历*/experience/employment        → sections.experience.items
//   项目经历*/projects                      → sections.projects.items
//   专业技能*/skills                        → sections.skills.items
//   教育经历*/education                     → sections.education.items
//   其它一切标题                            → sections.custom.<key>（key 按序 slug：s1/s2/…）
//
// 条目解析：.entry-head 三列 {entry-title,entry-role,entry-date} → {公司,职位,起止}；
//   entry-head 之后到下一 entry-head 之间的 HTML（通常是 <ul><li>）→ item.summary 原样保留。
//
// 非标结构降级口径（不猜不编，HTML 原样进 item.summary / section.content）：
//   ① 条目段内首个 entry-head 之前的非空内容 → 单独一条降级 item（字段空、summary=原样 HTML）。
//   ② 整段没有 entry-head → 单条降级 item（summary=整段正文 HTML）。
//   ③ entry-head 缺某列 → 该字段空串，不脑补。
//   ④ 技能段优先按 <p> 行解析（<strong>标签：</strong>内容 → name/description）；
//     非 <p> 残片 → 追加一条降级 item（description=残片 HTML）。
//   ⑤ 隐藏章节（.ed-sec-hidden）→ section.visible=false；隐藏条目（.ed-entry-hidden）→ item.visible=false。
//   ⑥ data-zid 是本仓内部锚点：不进导出（item.id 复用 zid 值以保稳定，HTML 串里剥掉该属性）。
import { sectionsOf, docToText } from './extract.mjs';
import { deriveResumeFields, SECTION_TITLES } from './apply-profile.mjs';
import { defaultResumeData, RR_TEMPLATES } from './rr-schema.mjs';

// 章节标题 → v4 段键。SECTION_TITLES 中文表 + 英文别名；找不到 → custom。
const TITLE_ALIASES = {
  summary: [...SECTION_TITLES.selfIntro, 'summary', 'objective', 'profile', 'professional summary', 'about me'],
  experience: [...SECTION_TITLES.work, 'experience', 'work experience', 'employment', 'work history', 'career'],
  projects: [...SECTION_TITLES.projects, 'projects', 'personal projects', 'selected projects'],
  skills: [...SECTION_TITLES.skills, 'skills', 'technical skills', 'core skills', 'competencies'],
  education: [...SECTION_TITLES.education, 'education', 'academic', 'academic background'],
};
function sectionKeyOf(title) {
  const t = String(title || '').trim().toLowerCase();
  if (!t) return null;
  for (const [key, names] of Object.entries(TITLE_ALIASES)) {
    if (names.some((n) => String(n).toLowerCase() === t)) return key;
  }
  return null;
}

// 章节标题行剥离（与 apply-profile.mjs SECTION_TITLE_RE 同口径；那边未导出，此处同形定义）
const SECTION_TITLE_RE = /<div[^>]*class="[^"]*\bsection-title\b[^"]*"[^>]*>[\s\S]*?<\/div>/i;
// sec.html 含外层 <section> 开闭标签（sectionsOf 切的是整元素）——先剥壳再剥标题行
const stripTitle = (secHtml) => String(secHtml || '')
  .replace(/^\s*<section\b[^>]*>/i, '')
  .replace(/<\/section>\s*$/i, '')
  .replace(SECTION_TITLE_RE, '');
// data-zid 是内部锚点：导出串剥掉；item.id 复用其值（见 zidOf）
const stripZidAttr = (html) => String(html || '').replace(/\sdata-zid="[^"]*"/g, '');
const textOf = (html) => docToText(String(html || '')).replace(/\n+/g, ' ').trim();
const zidOf = (attrsOrHtml) => (/data-zid="(z[0-9a-f]{8})"/.exec(String(attrsOrHtml || '')) || [])[1] || '';
const EMPTY_URL = () => ({ label: '', href: '' });

// —— .entry-head 解析：返回 [{zid,hidden,title,role,date,bodyHtml}]（文档序）+ stray（首个 head 前残片）
// 用 closeIndex 一次性算 div 配对（与 extract.mjs sectionsOf 同纪律，避免逐点重扫）。
function parseEntryHeads(secBodyHtml) {
  const html = String(secBodyHtml || '');
  const heads = [];
  const re = /<div\b[^>]*class="[^"]*\bentry-head\b[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    // entry-head 内嵌 3 个 entry-* 单元格 div：取其后第一个同层 </div> 之前的窗口解析单元格
    const openEnd = m.index + m[0].length;
    const headHtml = headBlock(html, m.index, openEnd);
    if (!headHtml) continue;
    const cell = (cls) => {
      const cm = new RegExp(`<div[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'i').exec(headHtml.html);
      return cm ? textOf(cm[1]) : '';
    };
    heads.push({
      zid: zidOf(m[0]),
      hidden: /\bed-entry-hidden\b/.test(m[0]),
      title: cell('entry-title'), role: cell('entry-role'), date: cell('entry-date'),
      start: m.index, end: headHtml.end
    });
    re.lastIndex = headHtml.end;
  }
  return heads;
}
// entry-head 开标签到其配对 </div>（含 3 个嵌套单元格 div，深度计数）
function headBlock(html, openStart, openEnd) {
  let depth = 1, j = openEnd;
  while (j < html.length) {
    const lt = html.indexOf('<', j);
    if (lt < 0) return null;
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) return null;
    const tag = html.slice(lt, gt + 1);
    const tm = /^<\s*\/?\s*div\b/i.exec(tag);
    if (tm) {
      if (/^<\s*\//.test(tag)) { depth--; if (depth === 0) return { html: html.slice(openStart, gt + 1), end: gt + 1 }; }
      else if (!/\/\s*>$/.test(tag)) depth++;
    }
    j = gt + 1;
  }
  return null;
}

// 条目段 → items：entry-head 结构优先；无 head 或 head 前残片 → 降级 item（summary=原样 HTML）
function entryItems(secBodyHtml, mkItem, counter) {
  const heads = parseEntryHeads(secBodyHtml);
  const items = [];
  if (!heads.length) {
    const body = stripZidAttr(secBodyHtml).trim();
    // 降级①：整段无 entry-head → 单条 item，summary 原样 HTML（不猜字段归属）
    if (docToText(secBodyHtml).trim()) items.push({ id: `i${counter.n++}`, visible: true, ...mkItem({ title: '', role: '', date: '' }), summary: body });
    return items;
  }
  // 降级②：首个 head 前有非空残片 → 先排一条降级 item
  const stray = secBodyHtml.slice(0, heads[0].start);
  if (docToText(stray).trim()) {
    items.push({ id: `i${counter.n++}`, visible: true, ...mkItem({ title: '', role: '', date: '' }), summary: stripZidAttr(stray).trim() });
  }
  heads.forEach((h, i) => {
    const nextStart = heads[i + 1] ? heads[i + 1].start : secBodyHtml.length;
    const bodyHtml = stripZidAttr(secBodyHtml.slice(h.end, nextStart)).trim();
    items.push({ id: h.zid || `i${counter.n++}`, visible: !h.hidden, ...mkItem(h), summary: bodyHtml });
  });
  return items;
}

// 各段 entry-head 三列 → v4 item 字段（summary 由 entryItems 统一填）
const ITEM_MAKERS = {
  experience: (h) => ({ company: h.title, position: h.role, location: '', date: h.date, url: EMPTY_URL() }),
  projects: (h) => ({ name: h.title, description: h.role, date: h.date, keywords: [], url: EMPTY_URL() }),
  // 本仓教育行惯例「学历 | 专业」→ v4 {studyType,area}；多于两段时余段并入 area，不丢字
  education: (h) => {
    const parts = h.role.split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
    return { institution: h.title, studyType: parts[0] || '', area: parts.slice(1).join(' | '), score: '', date: h.date, url: EMPTY_URL() };
  },
  custom: (h) => ({ name: h.title, description: h.role, date: h.date, location: '', keywords: [], url: EMPTY_URL() }),
};

// 技能段：<p> 行为条目（<strong>标签：</strong>内容 → name/description）；非 <p> 残片降级
function skillItems(secBodyHtml, counter) {
  const items = [];
  const consumed = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(secBodyHtml))) {
    consumed.push([m.index, m.index + m[0].length]);
    const inner = m[2];
    const sm = /<strong[^>]*>([\s\S]*?)<\/strong>/i.exec(inner);
    let name = '', description = '';
    if (sm) {
      name = textOf(sm[1]).replace(/[：:]\s*$/, '');
      description = textOf(inner.slice(sm.index + sm[0].length));
    } else {
      description = textOf(inner);
    }
    if (!name && !description) continue;
    items.push({ id: zidOf(m[1]) || `i${counter.n++}`, visible: !/\bed-entry-hidden\b/.test(m[1]), name, description, level: 0, keywords: [] });
  }
  // 降级④：剥掉全部 <p> 后仍有非空残片（如误用 entry-head/div）→ 追加降级 item，description=残片 HTML
  let rest = '', cur = 0;
  for (const [s, e] of consumed) { rest += secBodyHtml.slice(cur, s); cur = e; }
  rest += secBodyHtml.slice(cur);
  if (docToText(rest).trim()) {
    items.push({ id: `i${counter.n++}`, visible: true, name: '', description: '', level: 0, keywords: [], summary: stripZidAttr(rest).trim() });
  }
  return items;
}

// 联系方式行 → basics：电话/邮箱由 deriveResumeFields 兜底抽取；逐段分类——
// 「求职意向：…」→ headline；裸 URL → url.href；无法归类的碎片 → customFields（保值不猜）。
function parseBasics(html, fields, d) {
  const b = d.basics;
  b.name = fields.name || '';
  b.phone = fields.phone || '';
  b.email = fields.email || '';
  const cm = /<div\b[^>]*class="[^"]*\bcontact\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const contactHtml = cm ? cm[1] : '';
  const urlHit = /https?:\/\/[^\s<>"']+/.exec(contactHtml);
  if (urlHit) { b.url.href = urlHit[0]; b.url.label = ''; }
  // 行切分：<br> 后再按 | ｜ • 细分段（本仓惯例「电话：x | 邮箱：y」同行）
  const segs = contactHtml.split(/<br\s*\/?>/i)
    .flatMap((line) => textOf(line).split(/\s*[|｜•]\s*/))
    .map((s) => s.trim()).filter(Boolean);
  let fn = 0;
  for (const seg of segs) {
    const im = /^(?:求职意向|意向|求职目标)\s*[:：]?\s*(.*)$/.exec(seg);
    if (im && !b.headline) { b.headline = im[1].trim(); continue; }
    if (b.email && seg.includes(b.email)) continue;
    if (b.phone && seg.includes(b.phone)) continue;
    if (b.url.href && seg.includes(b.url.href)) continue;
    if (/^(电话|手机|邮箱|邮件|地址)\s*[:：]/.test(seg) && (seg.includes(b.phone) || seg.includes(b.email))) continue;
    b.customFields.push({ id: `f${++fn}`, icon: '', name: '', value: seg });
  }
  const av = /<img\b[^>]*class="[^"]*\bavatar\b[^"]*"[^>]*>/i.exec(html);
  if (av) {
    const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(av[0]);
    if (src) b.picture.url = src[1];
  }
}

/**
 * docToResumeData(html, meta) → v4 resumeData
 * meta = { docId, theme, typo }（docs-meta.json 条目；theme 非 18 名 → metadata.template 回退 'rhyhorn'，
 *        本仓主题名记进 _meta.theme 保真；typo → metadata.css.value 与 v4 自定义 CSS 语义对应）
 */
export function docToResumeData(html, meta = {}) {
  const src = String(html ?? '');
  const d = defaultResumeData();
  const fields = deriveResumeFields(src);
  parseBasics(src, fields, d);

  const counter = { n: 1 };
  const layoutIds = [];
  let customN = 0;
  for (const sec of sectionsOf(src)) {
    const bodyHtml = stripTitle(sec.html);
    const key = sectionKeyOf(sec.title);
    const name = String(sec.title || '').trim();
    if (key === 'summary') {
      const s = d.sections.summary;
      s.name = name || s.name; s.visible = !sec.hidden;
      s.content = stripZidAttr(bodyHtml).trim();   // v4 content 段：HTML 原样（wysiwyg 语义）
      layoutIds.push('summary');
    } else if (key) {
      // key ∈ {experience,projects,skills,education}（summary 上方已截走；null/未知标题 → custom）
      const s = d.sections[key];
      s.name = name || s.name; s.visible = !sec.hidden;
      s.items = key === 'skills' ? skillItems(bodyHtml, counter) : entryItems(bodyHtml, ITEM_MAKERS[key], counter);
      layoutIds.push(key);
    } else {
      // 其它标题 → sections.custom.<key>；v4 的 custom 是 Record，layout 引用 "custom.<key>"
      const ck = `s${++customN}`;
      const cs = { name: name || ck, columns: 1, separateLinks: true, visible: !sec.hidden, id: `custom.${ck}`, items: [] };
      if (parseEntryHeads(bodyHtml).length || !docToText(bodyHtml).trim()) {
        cs.items = entryItems(bodyHtml, ITEM_MAKERS.custom, counter);
      } else {
        cs.items = [{ id: `i${counter.n++}`, visible: true, name: '', description: '', date: '', location: '', summary: stripZidAttr(bodyHtml).trim(), keywords: [], url: EMPTY_URL() }];
      }
      d.sections.custom[ck] = cs;
      layoutIds.push(`custom.${ck}`);
    }
  }
  const m = d.metadata;
  m.template = RR_TEMPLATES.includes(meta.theme) ? meta.theme : 'rhyhorn';
  // v4 layout = 页→栏→段 id 三维数组；本仓 sheet 单栏 → 单页单栏、按文档序排段 id（custom 段用 "custom.<key>" 引用）
  m.layout = [[layoutIds.length ? layoutIds : ['summary']]];
  m.css = { value: String(meta.typo || ''), visible: true };
  // page/theme/typography 用 defaultResumeData 的 v4 缺省（a4/18/breakLine+pageNumbers/IBM Plex Sans）

  d._meta = {
    schemaVersion: '4',
    source: 'html-derived',
    docId: String(meta.docId || ''),
    exportedAt: String(meta.exportedAt || new Date().toISOString()),
    theme: String(meta.theme || '')
  };
  return d;
}
