// rr-schema.mjs — Reactive Resume v4 resumeData 形状常量 + 手写轻量校验（零依赖，不引 zod）
// 权威来源：上游 v6 仓库 packages/import/src/reactive-resume-v4-json.tsx 的 V4ResumeData 类型
//   （dev-docs/2026-11-18-reactive-resume-adoption.md §3 裁决：以 v4 形状输出 + 标 schemaVersion）。
// 形状要点（与上游逐字段对应）：
//   - summary 是「内容段」：{…sectionHead, content:<html>}，不是 items 数组（v4 wysiwyg 直出 HTML）。
//   - 其余 12 个标准段是「条目段」：{name,columns,separateLinks,visible,id,items:[{id,visible,…,summary}]}。
//   - sections.custom 是 Record<key, 条目段>：v4 用户自定义段，layout 里以 "custom.<key>" 引用。
//   - metadata.page.margin/format/options、picture.effects 与 UPCV templateData 实测一致。
// basics 里没有 summary 字段——任务清单的字段枚举是简写，v4 权威形状里 summary 只住在 sections.summary.content。
// _meta 是本仓扩展命名空间（UPCV/RR 消费方忽略未知键）：{schemaVersion:'4',source:'html-derived',docId,exportedAt,…}。

// 18 套 v4 模板名（宝可梦命名，rxresu.me/resume-templates 同源）
export const RR_TEMPLATES = [
  'azurill', 'bronzor', 'chikorita', 'ditgar', 'ditto', 'gengar', 'glalie', 'kakuna', 'lapras',
  'leafish', 'meowth', 'onyx', 'persian', 'pikachu', 'porygon', 'rhyhorn', 'scizor', 'smeargle'
];

// 条目段（items 数组）的标准段键；summary 单列（content 形状）。次序 = v4 导出序。
export const RR_ITEM_SECTIONS = [
  'awards', 'certifications', 'education', 'experience', 'volunteer',
  'interests', 'languages', 'profiles', 'projects', 'publications', 'references', 'skills'
];
export const RR_SECTION_KEYS = ['summary', ...RR_ITEM_SECTIONS];   // custom 不在键表内：它是 Record<key, 段>

const sectionHead = (id, name) => ({
  name, columns: 1, separateLinks: true, visible: true, id
});

// v4 空档形状（常量模板；消费一律走 defaultResumeData() 取深拷贝，不得就地改）
export const RR_EMPTY = deepFreeze({
  basics: {
    name: '', headline: '', email: '', phone: '', location: '',
    url: { label: '', href: '' },
    customFields: [],   // [{id,icon,name,value}]
    picture: {
      url: '', size: 120, aspectRatio: 1, borderRadius: 0,
      effects: { hidden: false, border: false, grayscale: false }
    }
  },
  sections: {
    summary: { ...sectionHead('summary', '个人总结'), content: '' },
    awards: { ...sectionHead('awards', '获奖'), items: [] },
    certifications: { ...sectionHead('certifications', '证书'), items: [] },
    education: { ...sectionHead('education', '教育经历'), items: [] },
    experience: { ...sectionHead('experience', '工作经历'), items: [] },
    volunteer: { ...sectionHead('volunteer', '志愿经历'), items: [] },
    interests: { ...sectionHead('interests', '兴趣'), items: [] },
    languages: { ...sectionHead('languages', '语言'), items: [] },
    profiles: { ...sectionHead('profiles', '社交主页'), items: [] },
    projects: { ...sectionHead('projects', '项目经历'), items: [] },
    publications: { ...sectionHead('publications', '出版物'), items: [] },
    references: { ...sectionHead('references', '推荐人'), items: [] },
    skills: { ...sectionHead('skills', '专业技能'), items: [] },
    custom: {}
  },
  metadata: {
    template: 'rhyhorn',
    layout: [[['summary', 'experience', 'education', 'projects', 'skills']]],
    css: { value: '', visible: true },
    page: { margin: 18, format: 'a4', options: { breakLine: true, pageNumbers: true } },
    theme: { background: '#ffffff', text: '#000000', primary: '#dc2626' },
    typography: {
      font: { family: 'IBM Plex Sans', subset: 'latin', variants: ['regular'], size: 14 },
      lineHeight: 1.5, hideIcons: false, underlineLinks: true
    },
    notes: ''
  }
});

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    return Object.freeze(o);
  }
  return o;
}

// 新空 resumeData（深拷贝常量模板；无条目 → 无需生成 item id）
export function defaultResumeData() {
  return JSON.parse(JSON.stringify(RR_EMPTY));
}

// ===== 手写轻量校验（不引 zod）=====
// 口径与仓内其它账本校验一致（apply-profile.mjs validateProfiles）：「有则须对」——
// 缺字段不算损坏（由导入侧的 normalizeResumeData 用默认值补齐），类型错才报错。
// 返回 {ok, errors:[中文…]}；errors 逐条列出，调用方取首条做错误提示即可。
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isBool = (x) => typeof x === 'boolean';

function checkUrl(u, where, errors) {
  if (u === undefined) return;
  if (!isObj(u)) { errors.push(`${where} 应为对象 {label,href}`); return; }
  if (u.label !== undefined && !isStr(u.label)) errors.push(`${where}.label 应为字符串`);
  if (u.href !== undefined && !isStr(u.href)) errors.push(`${where}.href 应为字符串`);
}

function checkSectionHead(s, where, errors) {
  if (s.name !== undefined && !isStr(s.name)) errors.push(`${where}.name 应为字符串`);
  if (s.columns !== undefined && !isNum(s.columns)) errors.push(`${where}.columns 应为数字`);
  if (s.separateLinks !== undefined && !isBool(s.separateLinks)) errors.push(`${where}.separateLinks 应为布尔值`);
  if (s.visible !== undefined && !isBool(s.visible)) errors.push(`${where}.visible 应为布尔值`);
  if (s.id !== undefined && !isStr(s.id)) errors.push(`${where}.id 应为字符串`);
}

function checkItems(items, where, errors) {
  if (!Array.isArray(items)) { errors.push(`${where}.items 应为数组`); return; }
  items.forEach((it, i) => {
    const w = `${where}.items[${i}]`;
    if (!isObj(it)) { errors.push(`${w} 应为对象`); return; }
    if (it.id !== undefined && !isStr(it.id)) errors.push(`${w}.id 应为字符串`);
    if (it.visible !== undefined && !isBool(it.visible)) errors.push(`${w}.visible 应为布尔值`);
    if (it.summary !== undefined && !isStr(it.summary)) errors.push(`${w}.summary 应为字符串（HTML）`);
    if (it.url !== undefined) checkUrl(it.url, `${w}.url`, errors);
  });
}

export function validateResumeData(d) {
  const errors = [];
  if (!isObj(d)) return { ok: false, errors: ['resumeData 应为对象 {basics,sections,metadata}'] };

  // —— basics ——
  if (d.basics !== undefined) {
    const b = d.basics;
    if (!isObj(b)) errors.push('basics 应为对象');
    else {
      for (const k of ['name', 'headline', 'email', 'phone', 'location']) {
        if (b[k] !== undefined && !isStr(b[k])) errors.push(`basics.${k} 应为字符串`);
      }
      if (b.url !== undefined) checkUrl(b.url, 'basics.url', errors);
      if (b.customFields !== undefined) {
        if (!Array.isArray(b.customFields)) errors.push('basics.customFields 应为数组');
        else b.customFields.forEach((f, i) => {
          if (!isObj(f)) errors.push(`basics.customFields[${i}] 应为对象`);
        });
      }
      if (b.picture !== undefined) {
        const p = b.picture;
        if (!isObj(p)) errors.push('basics.picture 应为对象');
        else {
          if (p.url !== undefined && !isStr(p.url)) errors.push('basics.picture.url 应为字符串');
          for (const k of ['size', 'aspectRatio', 'borderRadius']) {
            if (p[k] !== undefined && !isNum(p[k])) errors.push(`basics.picture.${k} 应为数字`);
          }
          if (p.effects !== undefined) {
            if (!isObj(p.effects)) errors.push('basics.picture.effects 应为对象');
            else for (const k of ['hidden', 'border', 'grayscale']) {
              if (p.effects[k] !== undefined && !isBool(p.effects[k])) errors.push(`basics.picture.effects.${k} 应为布尔值`);
            }
          }
        }
      }
    }
  }

  // —— sections ——
  if (d.sections !== undefined) {
    const s = d.sections;
    if (!isObj(s)) errors.push('sections 应为对象');
    else {
      if (s.summary !== undefined) {
        if (!isObj(s.summary)) errors.push('sections.summary 应为对象');
        else {
          checkSectionHead(s.summary, 'sections.summary', errors);
          if (s.summary.content !== undefined && !isStr(s.summary.content)) errors.push('sections.summary.content 应为字符串（HTML）');
        }
      }
      for (const key of RR_ITEM_SECTIONS) {
        const sec = s[key];
        if (sec === undefined) continue;
        if (!isObj(sec)) { errors.push(`sections.${key} 应为对象`); continue; }
        checkSectionHead(sec, `sections.${key}`, errors);
        if (sec.items !== undefined) checkItems(sec.items, `sections.${key}`, errors);
      }
      if (s.custom !== undefined) {
        if (!isObj(s.custom)) errors.push('sections.custom 应为对象（Record<key, 条目段>）');
        else for (const [ck, sec] of Object.entries(s.custom)) {
          const w = `sections.custom.${ck}`;
          if (!isObj(sec)) { errors.push(`${w} 应为对象`); continue; }
          checkSectionHead(sec, w, errors);
          if (sec.items !== undefined) checkItems(sec.items, w, errors);
        }
      }
    }
  }

  // —— metadata ——
  if (d.metadata !== undefined) {
    const m = d.metadata;
    if (!isObj(m)) errors.push('metadata 应为对象');
    else {
      if (m.template !== undefined && !isStr(m.template)) errors.push('metadata.template 应为字符串（18 套模板名之一）');
      if (m.layout !== undefined && !Array.isArray(m.layout)) errors.push('metadata.layout 应为三维数组（页→栏→段 id）');
      if (m.css !== undefined) {
        if (!isObj(m.css)) errors.push('metadata.css 应为对象 {value,visible}');
        else {
          if (m.css.value !== undefined && !isStr(m.css.value)) errors.push('metadata.css.value 应为字符串');
          if (m.css.visible !== undefined && !isBool(m.css.visible)) errors.push('metadata.css.visible 应为布尔值');
        }
      }
      if (m.page !== undefined) {
        if (!isObj(m.page)) errors.push('metadata.page 应为对象 {margin,format,options}');
        else {
          if (m.page.margin !== undefined && !isNum(m.page.margin)) errors.push('metadata.page.margin 应为数字');
          if (m.page.format !== undefined && !['a4', 'letter'].includes(m.page.format)) errors.push("metadata.page.format 应为 'a4'|'letter'");
          if (m.page.options !== undefined) {
            if (!isObj(m.page.options)) errors.push('metadata.page.options 应为对象 {breakLine,pageNumbers}');
            else for (const k of ['breakLine', 'pageNumbers']) {
              if (m.page.options[k] !== undefined && !isBool(m.page.options[k])) errors.push(`metadata.page.options.${k} 应为布尔值`);
            }
          }
        }
      }
      if (m.theme !== undefined) {
        if (!isObj(m.theme)) errors.push('metadata.theme 应为对象 {background,text,primary}');
        else for (const k of ['background', 'text', 'primary']) {
          if (m.theme[k] !== undefined && !isStr(m.theme[k])) errors.push(`metadata.theme.${k} 应为字符串`);
        }
      }
      if (m.typography !== undefined && !isObj(m.typography)) errors.push('metadata.typography 应为对象');
      if (m.notes !== undefined && !isStr(m.notes)) errors.push('metadata.notes 应为字符串');
    }
  }

  return { ok: errors.length === 0, errors };
}
