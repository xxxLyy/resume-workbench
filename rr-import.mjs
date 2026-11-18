// rr-import.mjs — Reactive Resume v4 resumeData → 本仓可编辑文档 HTML（纯函数、零落盘、零网络）
// 装配路径与 structure.mjs buildDoc 同款：assembleTemplate('classic') + {{…}} 占位符替换 +
// {{DOC_ID}} 函数替换（落盘字节带真实 docId，快照/导出不留占位符）。
// custom 段追加为标准 .section 块插在 sheet 末尾（锚点 = 教育段闭合 + sheet 闭合 + <script>，
// 模板漂移时抛错而不是静默丢段）。
//
// 降级/有损口径（不猜不编；写进注释防两处规格漂移）：
//   ① item.summary 已是 HTML：剥离 script/style/iframe/object/embed/form 元素与 on* 事件属性后
//     原样注入；纯文本 → <ul><li>转义文本</li></ul>；含 <li> 无 <ul> → 补 <ul> 壳。
//   ② sections.summary.content → 纯文本行 <br> 连接进 <p class="summary">（模板槽是行内 p，
//     块级 HTML 无法原样嵌入；多段摘要保行序，标记保不住属预期有损）。
//   ③ entry-head 只有三列：experience.location → 并入 position 显示（「职位 · 地点」）；
//     education.score → 并入 role 列；projects.keywords / skills.level / skills.keywords、
//     item.url、languages/profiles 等无对应段的条目字段无处安放 → 丢弃（本仓模型无槽位）。
//   ④ 本仓没有的 v4 标准段（awards/volunteer/profiles/languages/…）→ 追加为 custom .section，
//     段名用 v4 section.name，条目按 name/description/date 三列渲染。
//   ⑤ visible:false 段 → .ed-sec-hidden；visible:false 条目 → .ed-entry-hidden（编辑器隐藏态同口径）。
//   ⑥ basics.customFields → 联系方式行尾部追加段（name 非空取「name：value」，否则 value）。
//   ⑦ metadata.css.value → 不进落盘 HTML（typo 是 meta 字段）；由 upcv-api 写路径写 meta.typo。
//   ⑧ picture.url 非空且未隐藏 → 在 header 前插 <img class="avatar">（与存量文档同位）。
import { assembleTemplate } from './template.mjs';
import { defaultResumeData } from './rr-schema.mjs';
import { docToText } from './extract.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (s) => String(s ?? '').trim();

// 注入 HTML 清洗（降级①）：v4 summary/content 是外部富文本，进可编辑文档前剥可执行/嵌入载体。
// 不剥 <b>/<i>/<ul>/<a> 这类排版标签——那是 RR wysiwyg 的正常产物，剥了才是丢数据。
const SANITIZE_RE = /<(\/?)(script|style|iframe|object|embed|form|link|meta)\b[^>]*>/gi;
const ON_ATTR_RE = /\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g;
const cleanItemHtml = (html) => String(html ?? '').replace(ON_ATTR_RE, '').replace(SANITIZE_RE, '');

// item.summary → 条目内容块：含 <li> 无 <ul> → 补壳；无标签 → 单 bullet；其余原样注入
function summaryBlock(html) {
  const h = String(html ?? '').trim();
  if (!h) return '';
  const cleaned = cleanItemHtml(h);
  if (/<li[\s>]/i.test(cleaned) && !/<ul[\s>]/i.test(cleaned)) return `      <ul>${cleaned}</ul>`;
  if (!/<[a-zA-Z][^>]*>/.test(cleaned)) return `      <ul>\n        <li>${esc(cleaned)}</li>\n      </ul>`;
  return `      ${cleaned}`;
}

// entry-head 三列（与 structure.mjs entries() 同形：title=公司/学校/项目名，role=职位/学历，date=起止）
function entryHtml(title, role, date, hidden, bodyHtml) {
  const cls = hidden ? 'entry-head ed-entry-hidden' : 'entry-head';
  return `      <div class="${cls}" style="margin-top:1.6mm">
        <div class="entry-title">${esc(title)}</div>
        <div class="entry-role">${esc(role)}</div>
        <div class="entry-date">${esc(date)}</div>
      </div>
${bodyHtml}`;
}

// 各 v4 段 item → {title,role,date}（三列映射；无处可去的字段见降级③）
const ITEM_READERS = {
  experience: (it) => ({ title: it.company, role: [it.position, it.location].filter(Boolean).join(' · '), date: it.date }),
  education: (it) => ({ title: it.institution, role: [it.studyType, it.area, it.score].filter(Boolean).join(' | '), date: it.date }),
  projects: (it) => ({ title: it.name, role: it.description, date: it.date }),
  custom: (it) => ({ title: it.name, role: [it.description, it.location].filter(Boolean).join(' · '), date: it.date }),
  // 本仓无对应段、落到 custom .section 渲染的 v4 段：各自取最贴的三列
  awards: (it) => ({ title: it.title, role: it.awarder, date: it.date }),
  certifications: (it) => ({ title: it.name, role: it.issuer, date: it.date }),
  volunteer: (it) => ({ title: it.organization, role: [it.position, it.location].filter(Boolean).join(' · '), date: it.date }),
  publications: (it) => ({ title: it.name, role: it.publisher, date: it.date }),
  references: (it) => ({ title: it.name, role: it.description, date: it.date }),
  languages: (it) => ({ title: it.name, role: it.description, date: it.date }),
  profiles: (it) => ({ title: [it.network, it.username].filter(Boolean).join(' / '), role: it.url && (it.url.label || it.url.href), date: it.date }),
  interests: (it) => ({ title: it.name, role: (Array.isArray(it.keywords) ? it.keywords.join('、') : ''), date: it.date }),
};

// 条目段渲染：每个 item 一组 entry-head+summary；无 name 三列全空且无 summary → 跳过
function renderItems(items, reader) {
  const out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || typeof it !== 'object') continue;
    const c = reader(it);
    const body = summaryBlock(it.summary);
    if (!text(c.title) && !text(c.role) && !text(c.date) && !body) continue;
    out.push(entryHtml(text(c.title), text(c.role), text(c.date), it.visible === false, body));
  }
  return out.join('\n\n');
}

// 技能段 → .plain-lines 的 <p> 行（structure.mjs skillLines 同形：<strong>名：</strong>描述）
function renderSkills(items) {
  const out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || typeof it !== 'object') continue;
    const name = text(it.name);
    let description = text(it.description);
    if (!description && Array.isArray(it.keywords) && it.keywords.length) description = it.keywords.map(String).join('、');
    // 降级：导出侧产生的降级 item 用 summary 存原样 HTML → 这里原样回（summary 优先于 name/description）
    const raw = cleanItemHtml(it.summary || '');
    let line;
    if (raw) line = raw;
    else if (name && description) line = `<strong>${esc(name)}：</strong>${esc(description)}`;
    else if (description) line = esc(description);
    else if (name) line = `<strong>${esc(name)}</strong>`;
    else line = '';
    if (!line) continue;
    const pAttrs = it.visible === false ? ' class="ed-entry-hidden"' : '';
    out.push(`        <p${pAttrs}>${line}</p>`);
  }
  return out.join('\n');
}

// —— 宽容归一：输入部分字段缺失/类型错时用 v4 缺省补齐；根值非对象 → 抛错 ——
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x, d = '') => (typeof x === 'string' ? x : d);
function normalizeResumeData(input) {
  if (!isObj(input)) throw new Error('resumeData 应为对象 {basics,sections,metadata}');
  const d = defaultResumeData();
  const b = input.basics;
  if (b !== undefined && !isObj(b)) throw new Error('resumeData.basics 应为对象');
  if (b) {
    for (const k of ['name', 'headline', 'email', 'phone', 'location']) d.basics[k] = str(b[k], '');
    if (isObj(b.url)) { d.basics.url.label = str(b.url.label, ''); d.basics.url.href = str(b.url.href, ''); }
    if (Array.isArray(b.customFields)) {
      d.basics.customFields = b.customFields.filter(isObj).map((f, i) => ({
        id: str(f.id, `f${i + 1}`), icon: str(f.icon, ''), name: str(f.name, ''),
        // v4 字段名是 value；v6 importer 类型里出现过 text —— 两读一写，进口侧兼容
        value: str(f.value, str(f.text, ''))
      }));
    }
    if (isObj(b.picture)) {
      d.basics.picture.url = str(b.picture.url, '');
      for (const k of ['size', 'aspectRatio', 'borderRadius']) {
        if (typeof b.picture[k] === 'number' && Number.isFinite(b.picture[k])) d.basics.picture[k] = b.picture[k];
      }
      if (isObj(b.picture.effects)) {
        for (const k of ['hidden', 'border', 'grayscale']) {
          if (typeof b.picture.effects[k] === 'boolean') d.basics.picture.effects[k] = b.picture.effects[k];
        }
      }
    }
  }
  const s = input.sections;
  if (s !== undefined && !isObj(s)) throw new Error('resumeData.sections 应为对象');
  if (s) {
    if (isObj(s.summary)) {
      d.sections.summary.name = str(s.summary.name, d.sections.summary.name);
      if (typeof s.summary.columns === 'number') d.sections.summary.columns = s.summary.columns;
      if (typeof s.summary.visible === 'boolean') d.sections.summary.visible = s.summary.visible;
      d.sections.summary.content = str(s.summary.content, '');
    }
    const readItemSec = (key, target) => {
      const sec = s[key];
      if (sec === undefined) return;
      if (!isObj(sec)) throw new Error(`resumeData.sections.${key} 应为对象`);
      target.name = str(sec.name, target.name);
      if (typeof sec.columns === 'number') target.columns = sec.columns;
      if (typeof sec.visible === 'boolean') target.visible = sec.visible;
      target.items = Array.isArray(sec.items) ? sec.items.filter(isObj) : [];
    };
    for (const key of ['experience', 'education', 'projects', 'skills']) readItemSec(key, d.sections[key]);
    // 其余 v4 标准段 → 追加 custom 渲染（本仓模板无槽位，见降级④）
    d._extraSections = [];
    for (const key of ['awards', 'certifications', 'volunteer', 'interests', 'languages', 'profiles', 'publications', 'references']) {
      const sec = s[key];
      if (!isObj(sec) || !Array.isArray(sec.items) || !sec.items.length) continue;
      d._extraSections.push({ name: str(sec.name, key), visible: sec.visible !== false, items: sec.items.filter(isObj), reader: ITEM_READERS[key] || ITEM_READERS.custom });
    }
    if (isObj(s.custom)) {
      for (const [ck, sec] of Object.entries(s.custom)) {
        if (!isObj(sec) || !Array.isArray(sec.items)) continue;
        d._extraSections.push({ name: str(sec.name, ck), visible: sec.visible !== false, items: sec.items.filter(isObj), reader: ITEM_READERS.custom });
      }
    }
  }
  const md = input.metadata;
  if (md !== undefined && !isObj(md)) throw new Error('resumeData.metadata 应为对象');
  if (md && isObj(md.css)) d.metadata.css = { value: str(md.css.value, ''), visible: md.css.visible !== false };
  return d;
}

/**
 * resumeDataToDoc(resumeData, docId) → 完整可编辑文档 HTML（含 {{DOC_ID}} 已替换的真实 id）
 * 落盘由调用方负责（upcv-api 写路径：normalizeZids + normalizeToCurrent + atomicWrite + updateMeta）。
 */
export function resumeDataToDoc(resumeData, docId) {
  const d = normalizeResumeData(resumeData);
  const b = d.basics;

  // 联系方式行：电话/邮箱带标签（与本仓派生正则同口径），其余段原样展示
  const contactSegs = [];
  if (text(b.phone)) contactSegs.push(`电话：${esc(b.phone)}`);
  if (text(b.email)) contactSegs.push(`邮箱：${esc(b.email)}`);
  if (text(b.location)) contactSegs.push(esc(b.location));
  if (text(b.url.href) || text(b.url.label)) contactSegs.push(esc(text(b.url.label) || text(b.url.href)));
  for (const f of b.customFields) {
    const v = text(f.value);
    if (!v) continue;
    contactSegs.push(text(f.name) ? `${esc(f.name)}：${esc(v)}` : esc(v));
  }

  // summary content（HTML）→ 纯文本行 <br> 连接（降级②：块级标记保不住属预期有损）
  const summaryText = docToText(d.sections.summary.content).split('\n').map((l) => l.trim()).filter(Boolean);
  const summaryHtml = summaryText.map((l) => esc(l)).join('<br>\n');

  const skillsHtml = renderSkills(d.sections.skills.items);
  const workHtml = renderItems(d.sections.experience.items, ITEM_READERS.experience);
  const projHtml = renderItems(d.sections.projects.items, ITEM_READERS.projects);
  const eduHtml = renderItems(d.sections.education.items, ITEM_READERS.education);

  // custom + 本仓无槽位的 v4 标准段 → 追加 .section（降级④）
  const extraHtml = (d._extraSections || []).map((sec) => {
    const items = renderItems(sec.items, sec.reader);
    if (!items) return '';
    const cls = sec.visible === false ? 'section ed-sec-hidden' : 'section';
    return `    <section class="${cls}">\n      <div class="section-title">${esc(sec.name)}</div>\n${items}\n    </section>`;
  }).filter(Boolean).join('\n');

  let tpl = assembleTemplate('classic');
  tpl = tpl
    .replaceAll('{{NAME}}', () => esc(text(b.name) || '未命名'))
    .replaceAll('{{CONTACT}}', () => contactSegs.join(' | '))
    .replaceAll('{{INTENT}}', () => (text(b.headline) ? `求职意向：${esc(b.headline)}` : ''))
    .replaceAll('{{SUMMARY}}', () => summaryHtml || '点击开始编辑…')
    .replaceAll('{{SKILLS}}', () => (skillsHtml ? `<div class="plain-lines">\n${skillsHtml}\n      </div>` : ''))
    .replaceAll('{{WORK}}', () => workHtml)
    .replaceAll('{{PROJECTS}}', () => projHtml)
    .replaceAll('{{EDU}}', () => eduHtml)
    .replaceAll('{{DOC_ID}}', () => esc(String(docId || '')));

  // 段可见性后处理：五个固定段标题唯一 → 按标题把 ed-sec-hidden 补进对应 <section class="section">
  const fixedVisible = [
    ['个人总结', d.sections.summary.visible], ['专业技能', d.sections.skills.visible],
    ['工作经历', d.sections.experience.visible], ['项目经历', d.sections.projects.visible],
    ['教育经历', d.sections.education.visible],
  ];
  for (const [title, visible] of fixedVisible) {
    if (visible !== false) continue;
    tpl = tpl.replace(
      new RegExp(`<section class="section">(\\s*<div class="section-title">${title}</div>)`),
      `<section class="section ed-sec-hidden">$1`
    );
  }
  // 追加 custom/额外段：锚 = 教育段闭合 + sheet 闭合 + <script>（模板漂移 → 抛错，不静默丢段）
  if (extraHtml) {
    const anchor = '    </section>\n  </section>\n<script>';
    if (!tpl.includes(anchor)) throw new Error('template.html 结构漂移：找不到 sheet 闭合锚点，custom 段无法落位');
    tpl = tpl.replace(anchor, `    </section>\n${extraHtml}\n  </section>\n<script>`);
  }
  // 头像：非隐藏且有 url → header 前插（降级⑧）
  if (text(b.picture.url) && !b.picture.effects.hidden) {
    tpl = tpl.replace('<header class="header">', `<img class="avatar" src="${esc(b.picture.url)}">\n    <header class="header">`);
  }
  return tpl;
}
