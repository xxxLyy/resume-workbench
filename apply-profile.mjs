// apply-profile.mjs — 网申包数据层（S8 · 批 3 卡片 b3c1）：RESUME_ROOT/apply-profiles.json
// 上位需求：dev-docs/2026-09-23-roadmap-magazine-and-features.md §S8；本批计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4。
// 本模块只管「数据层」：账本读写、字段三态、来源派生与漂移。页面/AI 文案字段/复制导出/跟进助手不在本卡。
//
// 账本形状（通用信息表 + 按公司字段包，同一文件）：
//   { version, updatedAt,
//     common:   { sourceDocId, fields: { <key>: <字段条目> } },
//     packages: { <pkgId>: { company, role, note, sourceDocId, fields: { <key>: <字段条目> } } },
//     copyTasks:  { <taskKey>: <任务记录> },   // b3c3：AI 文案生成任务（genTasks 口径）
//     copyDrafts: { <taskKey>: <待确认稿> } }   // b3c3：生成结果只落这里，确认后才进字段
//
// 字段条目（每个字段一条，三态）：
//   follow   跟随来源：值 = 来源派生纯文本（母版简历 / 通用表）；来源变更 → 标漂移（drift）
//   override 手动覆写：值 = 手填文本，锁死不随来源变
//   manual   独立维护：仅独立字段（期望薪资等），永不从简历派生
//   条目里另存 syncedText/syncedHash = 「上次确认过的来源快照」→ 漂移判据（来源变了但未确认）。
//   「恢复跟随」是动作不是第四态：override → follow（丢弃手填、重新取来源、确认快照）；
//   manual（独立字段）无来源 → 拒绝恢复跟随。
//
// 纪律：
//   ① 读写走既有 tx 纪律（tx.mjs updateJsonLedger）：跨进程锁内读最新 → 唯一临时 + 原子 rename → 0600。
//   ② 损坏停写：解析失败或形状错 → 抛 CORRUPT（httpCode 500），停写不覆盖（口径对齐 docs-meta/applications/materials/evaluations）。
//   ③ 跟随来源 = 母版派生纯文本；来源变更只标漂移，不静默改写「已确认快照」。
//   ④ 期望薪资等独立字段不从简历派生：简历改动永不覆盖它们。
//   ⑤ 零网络、零模型调用、零 npm 依赖（只用 node 内置 + 既有模块）。
import fs from 'node:fs';
import path from 'node:path';
import { updateJsonLedger } from './tx.mjs';
import { sectionsOf, docToText } from './extract.mjs';
import { sha1 } from './freeze.mjs';

export const APPLY_PROFILES_FILE = 'apply-profiles.json';
export const APPLY_PROFILES_LOCK = '.apply-profiles.lock';
export const PROFILES_VERSION = 1;

// —— 字段三态（存储态）——
export const MODE_FOLLOW = 'follow';       // 跟随来源
export const MODE_OVERRIDE = 'override';   // 手动覆写
export const MODE_MANUAL = 'manual';       // 独立维护（不从简历派生）
export const MODE_AI = 'ai';               // AI 文案字段（b3c3）：值来自「生成→预览→确认」，覆写后 locked

// —— 字段三态（计算态，给界面用）——
export const STATE_FOLLOW = 'follow';       // 跟随来源且来源未变
export const STATE_DRIFT = 'drift';         // 跟随来源但来源已变（未确认）
export const STATE_OVERRIDE = 'override';   // 手动覆写
export const STATE_MANUAL = 'manual';       // 独立维护
export const STATE_AI = 'ai';               // AI 文案（已确认入库）
export const STATE_AI_LOCKED = 'ai_locked'; // AI 文案被手动改写 → 锁定（再生不覆盖）
export const STATE_AI_EMPTY = 'ai_empty';   // AI 文案尚未生成

// —— 来源类型 ——
export const SOURCE_RESUME = 'resume';     // 母版/岗位简历（docs/<docId>.html 派生纯文本）
export const SOURCE_COMMON = 'common';     // 通用信息表同名字段
export const SOURCE_NONE = 'none';         // 无来源（独立字段）

// 字段目录：derived=true = 可从简历派生（跟随来源/手动覆写）；derived=false = 独立维护（不从简历派生）。
// ai=true = AI 文案字段（批 3 卡片 b3c3 · 新增字段类型）：既不从简历派生、也不是独立手填 ——
//   走「AI 生成 → 预览 → 确认才入库」，入库后手动改写即锁定（再生不得覆盖）。
export const FIELD_CATALOG = [
  { key: 'name', label: '姓名', derived: true },
  { key: 'phone', label: '电话', derived: true },
  { key: 'email', label: '邮箱', derived: true },
  { key: 'selfIntro', label: '自评', derived: true },
  { key: 'skills', label: '专业技能', derived: true },
  { key: 'work', label: '工作经历', derived: true },
  { key: 'projects', label: '项目经历', derived: true },
  { key: 'education', label: '教育经历', derived: true },
  { key: 'expectedSalary', label: '期望薪资', derived: false },
  { key: 'availability', label: '到岗时间', derived: false },
  { key: 'workYears', label: '工作年限', derived: false },
  { key: 'greeting', label: '打招呼语', derived: false, ai: true },
  { key: 'coverLetter', label: '自荐信', derived: false, ai: true },
  { key: 'followUp', label: '跟进语', derived: false, ai: true },
];
export const FIELD_KEYS = FIELD_CATALOG.map((f) => f.key);
export const DERIVED_KEYS = FIELD_CATALOG.filter((f) => f.derived).map((f) => f.key);
export const INDEPENDENT_KEYS = FIELD_CATALOG.filter((f) => !f.derived && !f.ai).map((f) => f.key);
export const AI_COPY_FIELDS = FIELD_CATALOG.filter((f) => f.ai);
export const AI_COPY_KEYS = AI_COPY_FIELDS.map((f) => f.key);

// 文档 id 闸门（与 server.mjs 的 VALID_ID 同口径）：账本里的 docId 是外部可编辑内容，
// 不校验就能拼出数据根之外的路径（../ 穿越）。
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

const err = (code, msg) => Object.assign(new Error(msg), { code });

// ===== 账本形状 =====
export function emptyProfiles() {
  return { version: PROFILES_VERSION, updatedAt: '', common: { sourceDocId: '', fields: {} }, packages: {}, copyTasks: {}, copyDrafts: {} };
}

export function applyProfilesPath(root) {
  return path.join(root, APPLY_PROFILES_FILE);
}

// 形状校验：根值必须是普通对象；common/packages 及各自 fields 若是数组/非对象 → 形状错（= 损坏）。
// 只校验「有则须对」：缺字段由 migrateProfiles 补齐（旧版本账本不算损坏）。
export function validateProfiles(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  const plainObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  if (d.common !== undefined) {
    if (!plainObj(d.common)) return false;
    if (d.common.fields !== undefined && !plainObj(d.common.fields)) return false;
  }
  if (d.packages !== undefined) {
    if (!plainObj(d.packages)) return false;
    for (const p of Object.values(d.packages)) {
      if (!plainObj(p)) return false;
      if (p.fields !== undefined && !plainObj(p.fields)) return false;
    }
  }
  // AI 文案任务/待确认稿（b3c3）：有则须为对象
  if (d.copyTasks !== undefined && !plainObj(d.copyTasks)) return false;
  if (d.copyDrafts !== undefined && !plainObj(d.copyDrafts)) return false;
  return true;
}

// 结构迁移（读时补齐，不写盘；写盘时在锁内再做一次 → 迁移与写入同一事务，不另开写路径）
// 纯函数：不改传入对象（浅拷贝出新的 common/packages/fields，避免把调用方的数据改脏）。
export function migrateProfiles(d) {
  const src = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  const rawCommon = (src.common && typeof src.common === 'object' && !Array.isArray(src.common)) ? src.common : {};
  const rawPackages = (src.packages && typeof src.packages === 'object' && !Array.isArray(src.packages)) ? src.packages : {};
  const packages = {};
  for (const [pid, p] of Object.entries(rawPackages)) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) { packages[pid] = { company: '', role: '', note: '', sourceDocId: '', fields: {} }; continue; }
    packages[pid] = {
      ...p,
      company: String(p.company || ''),
      role: String(p.role || ''),
      note: String(p.note || ''),
      sourceDocId: String(p.sourceDocId || ''),
      fields: (p.fields && typeof p.fields === 'object' && !Array.isArray(p.fields)) ? { ...p.fields } : {},
    };
  }
  return {
    ...src,
    version: PROFILES_VERSION,
    updatedAt: String(src.updatedAt || ''),
    common: {
      ...rawCommon,
      sourceDocId: String(rawCommon.sourceDocId || ''),
      fields: (rawCommon.fields && typeof rawCommon.fields === 'object' && !Array.isArray(rawCommon.fields)) ? { ...rawCommon.fields } : {},
    },
    packages,
    // AI 文案生成任务与待确认稿（b3c3）：任务/稿与字段同表 → 确认入库可同事务完成
    copyTasks: (src.copyTasks && typeof src.copyTasks === 'object' && !Array.isArray(src.copyTasks)) ? { ...src.copyTasks } : {},
    copyDrafts: (src.copyDrafts && typeof src.copyDrafts === 'object' && !Array.isArray(src.copyDrafts)) ? { ...src.copyDrafts } : {},
  };
}

function corruptError(detail) {
  const e = new Error(`数据文件损坏，已停止写入：${APPLY_PROFILES_FILE}。请先人工修复或从备份恢复。`);
  e.httpCode = 500; e.code = 'CORRUPT'; e.detail = detail || '';
  return e;
}

// ===== 读 =====
export function loadApplyProfiles(root) {
  const fp = applyProfilesPath(root);
  if (!fs.existsSync(fp)) return { data: emptyProfiles(), corrupt: false, error: null };
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { return { data: emptyProfiles(), corrupt: true, error: corruptError(e && e.message) }; }
  if (!validateProfiles(parsed)) return { data: emptyProfiles(), corrupt: true, error: corruptError('根值或内层形状不是对象') };
  return { data: migrateProfiles(parsed), corrupt: false, error: null };
}

// 写前闸门：账本已损坏 → 停写（不覆盖原文件）。口径同其它 JSON 账本（server.mjs assertWritable）。
function assertWritable(root) {
  const fp = applyProfilesPath(root);
  if (!fs.existsSync(fp)) return;
  let parsed = null, bad = false;
  try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { bad = true; }
  if (!bad && !validateProfiles(parsed)) bad = true;
  if (bad) throw corruptError('写前校验未通过');
}

// ===== 写 =====
export function saveApplyProfiles(root, data) {
  assertWritable(root);   // 显式闸门（损坏 → 抛 CORRUPT，原文件不覆盖）
  const out = updateApplyProfiles(root, () => data);   // 锁内原子写（与其它写路径同一纪律）
  return out;
}

// 整表 RMW（tx 纪律：跨进程锁内读最新 → 原子写）。mutator 返回 null/undefined = 放弃不写。
export function updateApplyProfiles(root, mutator) {
  return updateJsonLedger(root, APPLY_PROFILES_FILE, (cur) => {
    const data = cur === null ? emptyProfiles() : migrateProfiles(cur);
    const next = mutator(data);
    if (next === null || next === undefined) return null;
    const out = migrateProfiles(next);
    out.version = PROFILES_VERSION;
    out.updatedAt = new Date().toISOString();
    return out;
  }, { lockFile: APPLY_PROFILES_LOCK, validate: validateProfiles, initial: () => emptyProfiles() });
}

// ===== 母版派生纯文本（跟随来源的取值口径）=====
// 纯函数、零落盘：从简历正文派生各字段的纯文本（隐藏章节不参与）。
const SECTION_TITLE_RE = /<div[^>]*class="[^"]*\bsection-title\b[^"]*"[^>]*>[\s\S]*?<\/div>/i;
function sectionPlain(sec) {
  const inner = String((sec && sec.html) || '').replace(SECTION_TITLE_RE, '');
  return docToText(inner);
}
function pickSection(sections, titles) {
  for (const t of titles) {
    const hit = sections.find((s) => String(s.title || '').trim() === t);
    if (hit) return sectionPlain(hit);
  }
  return '';
}
export function deriveResumeFields(html) {
  const src = String(html == null ? '' : html);
  const out = { name: '', phone: '', email: '', selfIntro: '', skills: '', work: '', projects: '', education: '' };
  const nm = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(src);
  out.name = nm ? docToText(nm[1]) : '';
  const cm = /<div\b[^>]*class="[^"]*\bcontact\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(src);
  const contact = cm ? docToText(cm[1]) : '';
  const em = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(contact);
  out.email = em ? em[0] : '';
  const ph = /(?:1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}|0\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4})/.exec(contact);
  out.phone = ph ? ph[0] : '';
  const sections = sectionsOf(src).filter((s) => !s.hidden);
  out.selfIntro = pickSection(sections, ['个人总结', '自我评价', '自评']);
  out.skills = pickSection(sections, ['专业技能', '技能', '专业能力']);
  out.work = pickSection(sections, ['工作经历', '工作经验', '工作履历']);
  out.projects = pickSection(sections, ['项目经历', '项目经验']);
  out.education = pickSection(sections, ['教育经历', '教育背景']);
  return out;
}

// ===== 取数上下文（每次调用内缓存派生结果；跨调用不复用 → 母版改动必被看见）=====
function makeCtx(root) {
  const cache = new Map();
  return {
    derived(docId) {
      const id = String(docId || '');
      if (!VALID_ID.test(id)) return null;   // 闸门：账本里的 docId 是外部输入
      if (cache.has(id)) return cache.get(id);
      let out = null;
      try {
        const fp = path.join(root, 'docs', id + '.html');
        if (fs.existsSync(fp)) out = deriveResumeFields(fs.readFileSync(fp, 'utf8'));
      } catch { out = null; }
      cache.set(id, out);
      return out;
    },
  };
}

// ===== 字段解析（三态 + 漂移）=====
export function catalogOf(key) {
  const item = FIELD_CATALOG.find((f) => f.key === key);
  if (!item) throw err('APPLY_UNKNOWN_FIELD', '未知字段：' + String(key));
  return item;
}

// 解析单个字段条目：mode 决定值来源；follow 时值 = 来源当前派生文本，drift = 来源已变但未确认。
export function resolveField(entry, item, sourceText) {
  const base = { key: item.key, label: item.label, derived: !!item.derived, ai: !!item.ai };
  // AI 文案字段（b3c3）：值只来自「生成→预览→确认」的入库动作或手动覆写；无来源可跟、无漂移。
  if (item.ai) {
    const v = entry && typeof entry === 'object' ? String(entry.value == null ? '' : entry.value) : '';
    const locked = !!(entry && entry.locked === true);
    return {
      ...base, mode: MODE_AI,
      state: locked ? STATE_AI_LOCKED : (v ? STATE_AI : STATE_AI_EMPTY),
      value: v, locked, drift: false, synced: true, source: null, sourceText: '',
    };
  }
  if (!entry || typeof entry !== 'object') {
    // 独立字段（derived=false）从没被写过 → 恒为「独立维护」：它没有来源可跟，报 follow 是不实的
    // （页面徽章与 JSON 导出必须同口径：页面恒显「独立维护」，导出也报 manual）。
    if (!item.derived) {
      return { ...base, mode: MODE_MANUAL, state: STATE_MANUAL, value: '', drift: false, synced: false, source: null, sourceText: '' };
    }
    return { ...base, mode: MODE_FOLLOW, state: STATE_FOLLOW, value: '', drift: false, synced: false, source: null, sourceText: String(sourceText || '') };
  }
  const src = (entry.source && typeof entry.source === 'object') ? entry.source : null;
  if (entry.mode === MODE_MANUAL) {
    return { ...base, mode: MODE_MANUAL, state: STATE_MANUAL, value: String(entry.value == null ? '' : entry.value), drift: false, synced: true, source: src };
  }
  if (entry.mode === MODE_OVERRIDE) {
    return { ...base, mode: MODE_OVERRIDE, state: STATE_OVERRIDE, value: String(entry.override == null ? '' : entry.override), drift: false, synced: true, source: src };
  }
  const cur = String(sourceText == null ? '' : sourceText);
  const syncedText = String(entry.syncedText == null ? '' : entry.syncedText);
  const hasSynced = typeof entry.syncedHash === 'string' && entry.syncedHash !== '';
  const drift = hasSynced ? (entry.syncedHash !== sha1(cur)) : (cur !== syncedText);
  return {
    ...base, mode: MODE_FOLLOW, state: drift ? STATE_DRIFT : STATE_FOLLOW,
    value: cur, drift, synced: hasSynced, source: src, sourceText: cur, syncedText,
  };
}

// scope：{ kind:'common' } 或 { kind:'package', id }
function scopeOf(data, scope) {
  const s = scope || { kind: 'common' };
  if (s.kind === 'package') {
    const pkg = data.packages && data.packages[s.id];
    if (!pkg) throw err('APPLY_NO_PACKAGE', '字段包不存在：' + String(s.id));
    return { fields: pkg.fields, holder: pkg, kind: 'package', id: s.id };
  }
  return { fields: data.common.fields, holder: data.common, kind: 'common', id: '' };
}

function defaultSourceFor(scope, holder) {
  if (scope.kind === 'package') return { kind: SOURCE_COMMON, docId: '' };
  return { kind: SOURCE_RESUME, docId: String((holder && holder.sourceDocId) || '') };
}

// 某字段的「来源当前文本」：resume = 该文档派生文本；common = 通用表同名字段的解析值。
function sourceTextFor(root, data, scope, key, ctx) {
  const item = catalogOf(key);
  if (!item.derived) return '';
  const { fields, holder } = scopeOf(data, scope);
  const entry = fields[key] || null;
  const src = (entry && entry.source && typeof entry.source === 'object') ? entry.source : defaultSourceFor(scope, holder);
  if (src.kind === SOURCE_RESUME) {
    const docId = String(src.docId || holder.sourceDocId || '');
    const d = ctx.derived(docId);
    return d ? String(d[key] || '') : '';
  }
  if (src.kind === SOURCE_COMMON) {
    const commonEntry = (data.common.fields || {})[key] || null;
    const commonText = commonSourceText(data, key, ctx);
    return resolveField(commonEntry, item, commonText).value;
  }
  return '';
}

function commonSourceText(data, key, ctx) {
  const docId = String((data.common && data.common.sourceDocId) || '');
  if (!docId) return '';
  const d = ctx.derived(docId);
  return d ? String(d[key] || '') : '';
}

// 解析整表：通用表 + 各公司包，字段带三态与漂移。
// ctx.derived(docId) → { key: 纯文本 } | null（调用方给；本模块内部用 makeCtx）。
export function resolveProfiles(data, ctx = {}) {
  const d = migrateProfiles(data);
  const c = { derived: typeof ctx.derived === 'function' ? ctx.derived : () => null };
  const commonFields = {};
  for (const item of FIELD_CATALOG) {
    const entry = d.common.fields[item.key] || null;
    commonFields[item.key] = resolveField(entry, item, commonSourceText(d, item.key, c));
  }
  const packages = {};
  for (const [pid, pkg] of Object.entries(d.packages)) {
    const fields = {};
    for (const item of FIELD_CATALOG) {
      const entry = pkg.fields[item.key] || null;
      const src = (entry && entry.source && typeof entry.source === 'object') ? entry.source : { kind: SOURCE_COMMON };
      let text = '';
      if (item.derived) {
        if (src.kind === SOURCE_RESUME) {
          const docId = String(src.docId || pkg.sourceDocId || '');
          const dd = c.derived(docId);
          text = dd ? String(dd[item.key] || '') : '';
        } else if (src.kind === SOURCE_COMMON) {
          text = commonFields[item.key] ? commonFields[item.key].value : '';
        }
      }
      fields[item.key] = resolveField(entry, item, text);
    }
    packages[pid] = {
      id: pid, company: pkg.company || '', role: pkg.role || '', note: pkg.note || '',
      sourceDocId: pkg.sourceDocId || '', fields,
    };
  }
  return {
    version: d.version, updatedAt: d.updatedAt,
    common: { sourceDocId: d.common.sourceDocId || '', fields: commonFields },
    packages,
    // AI 文案生成任务与待确认稿（b3c3）：页面层据此渲染「生成中/待确认/上次用量」
    tasks: d.copyTasks || {},
    drafts: d.copyDrafts || {},
  };
}

// ===== AI 文案字段（b3c3）辅助 =====
// 任务/稿的键：作用范围 + 字段 key（同一字段同一时刻只有一个任务）。
export function copyTaskKey(scope, key) {
  const s = scope || { kind: 'common' };
  return (s.kind === 'package' ? 'package:' + String(s.id || '') : 'common') + ':' + String(key || '');
}

// AI 文案的取材来源：该作用范围当前跟随的来源简历 → 派生要点（纯函数、只读）。
// 公司包：包的跟随来源是岗位简历时取该简历（包级 sourceDocId，/apply/source 写的就是它），
//         否则取通用表母版；通用表：取自己的母版。
// 路径拼接与 docId 闸门都留在模块内的取数上下文里（页面层不自己拼路径）。
export function copySource(root, scope) {
  const l = loadApplyProfiles(root);
  if (l.corrupt) return null;
  const data = l.data;
  const ctx = makeCtx(root);
  const { holder, kind } = scopeOf(data, scope);
  let docId = '';
  if (kind === 'package') {
    docId = String(holder.sourceDocId || '') || String((data.common.sourceDocId) || '');
  } else {
    docId = String(holder.sourceDocId || '');
  }
  if (!docId) return { docId: '', fields: {} };
  const d = ctx.derived(docId);
  return { docId, fields: d || {} };
}

// 某份文档的派生要点（纯函数、只读、零落盘）：供跟进助手按投递记录取材。
// docId 闸门与拼路径都留在模块内（投递记录里的 docId 是外部可编辑内容，越界由模块挡）。
export function deriveDocFields(root, docId) {
  const id = String(docId || '');
  if (!VALID_ID.test(id)) return null;   // 闸门：外部可编辑内容不能拼路径
  const ctx = makeCtx(root);
  return ctx.derived(id);
}

// 作用范围的抬头信息（公司/岗位）：AI 文案 prompt 用；通用表没有公司/岗位 → 空串。
export function scopeMeta(root, scope) {
  const l = loadApplyProfiles(root);
  if (l.corrupt) return { company: '', role: '' };
  const s = scope || { kind: 'common' };
  if (s.kind === 'package') {
    const p = (l.data.packages || {})[s.id];
    return p ? { company: String(p.company || ''), role: String(p.role || '') } : { company: '', role: '' };
  }
  return { company: '', role: '' };
}

// AI 文案字段的入库写入口（b3c3）：待确认稿 → 字段值（mode=ai）。
// 就地改传入的账本数据（调用方在账本事务内），返回 {ok:true} 或 {ok:false,code,error}。
// 锁定期拒绝：字段被手动改写过（locked）→ 生成结果不得覆盖它。
export function writeAiField(data, scope, key, value) {
  const item = catalogOf(key);
  if (!item.ai) throw err('APPLY_NOT_AI_FIELD', '不是 AI 文案字段：' + String(key));
  const { fields } = scopeOf(data, scope);
  const cur = (fields[key] && typeof fields[key] === 'object') ? fields[key] : null;
  if (cur && cur.locked === true) {
    return { ok: false, code: 'APPLY_AI_LOCKED', error: '该字段已手动改写并锁定，生成结果不会覆盖它（如需改用新文案，请先解锁）' };
  }
  fields[key] = { mode: MODE_AI, value: String(value == null ? '' : value), locked: false };
  return { ok: true };
}

// ===== 页面层读视图（批 3 页面卡 b3c2）=====
// 读账本 + 用模块内置取数上下文解析：取数上下文留在模块内（docId 闸门 VALID_ID 与拼路径都在这里），
// 页面层不自己拼文档路径 —— 账本里的 docId 是外部可编辑内容，越界由模块挡。
export function loadApplyProfilesView(root) {
  const l = loadApplyProfiles(root);
  return { corrupt: l.corrupt, error: l.error, data: l.data, view: resolveProfiles(l.data, makeCtx(root)) };
}

// ===== 写操作（三态切换）=====
// mode：follow = 恢复跟随（丢弃手填、重新取来源、确认快照）；override = 手动覆写；manual = 独立维护。
export function setField(root, scope, key, mode, opts = {}) {
  const item = catalogOf(key);
  return updateApplyProfiles(root, (data) => {
    const { fields, holder } = scopeOf(data, scope);
    // AI 文案字段（b3c3）：没有来源可跟、不独立手填 —— 只有两条路：
    //   override = 手动改写并保存 → **锁定**（此后再生成/再确认都不得覆盖它）；
    //   ai       = 解锁（交回 AI 接管），文案内容一字不动。
    // 确认入库（生成稿 → 字段）不走这里：它在同一事务里还要清待确认稿，由 apply-gen.mjs 落账。
    if (item.ai) {
      if (mode === MODE_OVERRIDE) {
        fields[key] = { mode: MODE_AI, value: String(opts.value == null ? '' : opts.value), locked: true };
        return data;
      }
      if (mode === MODE_AI) {
        // 解锁 = 把该字段交回 AI 接管（文案内容一字不动）。**空值也可解锁**：
        // 「保存」空值会把字段锁上，若解锁再报「无可解锁」就成了死路（用户只能先填字再解锁）。
        const curAi = (fields[key] && typeof fields[key] === 'object') ? fields[key] : null;
        fields[key] = { ...(curAi || { value: '' }), mode: MODE_AI, locked: false };
        return data;
      }
      if (mode === MODE_FOLLOW) throw err('APPLY_FIELD_NOT_FOLLOWABLE', 'AI 文案字段没有来源，不能恢复跟随：' + key);
      throw err('APPLY_BAD_MODE', 'AI 文案字段的模式只能是 override（覆写并锁定）或 ai（解锁）：' + key);
    }
    const cur = (fields[key] && typeof fields[key] === 'object') ? fields[key] : null;
    const src = (cur && cur.source && typeof cur.source === 'object') ? cur.source : defaultSourceFor(scope, holder);
    if (mode === MODE_MANUAL) {
      if (item.derived) throw err('APPLY_FIELD_NOT_MANUAL', '派生字段不能设为独立维护（只能跟随来源或手动覆写）：' + key);
      fields[key] = { mode: MODE_MANUAL, value: String(opts.value == null ? '' : opts.value) };
      return data;
    }
    if (mode === MODE_OVERRIDE) {
      fields[key] = { ...(cur || {}), mode: MODE_OVERRIDE, override: String(opts.value == null ? '' : opts.value) };
      return data;
    }
    if (mode === MODE_FOLLOW) {
      if (!item.derived) throw err('APPLY_FIELD_NOT_FOLLOWABLE', '独立字段没有来源，不能恢复跟随：' + key);
      const text = opts.sourceText !== undefined ? String(opts.sourceText) : sourceTextFor(root, data, scope, key, makeCtx(root));
      fields[key] = { mode: MODE_FOLLOW, source: src, syncedText: text, syncedHash: sha1(text), drift: false };
      return data;
    }
    throw err('APPLY_BAD_MODE', '未知字段模式：' + String(mode));
  });
}

// 换来源（公司包：跟随通用表 ↔ 跟随岗位简历；通用表：跟随某份母版）。
export function setFieldSource(root, scope, key, source) {
  catalogOf(key);
  return updateApplyProfiles(root, (data) => {
    const { fields, holder } = scopeOf(data, scope);
    const cur = (fields[key] && typeof fields[key] === 'object') ? fields[key] : {};
    const kind = source && source.kind ? String(source.kind) : SOURCE_NONE;
    const src = { kind, docId: String((source && source.docId) || '') };
    if (kind === SOURCE_RESUME && !src.docId) src.docId = String(holder.sourceDocId || '');
    fields[key] = { ...cur, source: src };
    return data;
  });
}

// 绑定母版：通用表跟随来源的出处。绑定 = 用户明确动作 → 重新确认所有跟随字段的来源快照（清漂移）。
// 手填与独立字段不动（不因换母版被覆盖）。
export function bindCommonMaster(root, docId) {
  const id = String(docId || '');
  if (!VALID_ID.test(id)) throw err('APPLY_BAD_DOC_ID', '母版文档 id 非法：' + id.slice(0, 40));
  return updateApplyProfiles(root, (data) => {
    data.common.sourceDocId = id;
    const ctx = makeCtx(root);
    for (const item of FIELD_CATALOG) {
      if (!item.derived) continue;
      const cur = data.common.fields[item.key] || null;
      if (cur && (cur.mode === MODE_OVERRIDE || cur.mode === MODE_MANUAL)) continue;
      const text = commonSourceText(data, item.key, ctx);
      data.common.fields[item.key] = {
        mode: MODE_FOLLOW, source: { kind: SOURCE_RESUME, docId: id },
        syncedText: text, syncedHash: sha1(text), drift: false,
      };
    }
    return data;
  });
}

// 公司包 id：同公司同岗位 → 同 id（稳定、可重复调用）。
export function packageId(company, role) {
  return 'pkg-' + sha1(String(company || '') + '|' + String(role || '')).slice(0, 12);
}

// 建/更新公司包。id 缺省按「公司|岗位」推导；已存在则只补空字段（不覆盖已有内容）。
export function ensurePackage(root, { id, company = '', role = '', note = '', sourceDocId = '' } = {}) {
  const pid = String(id || packageId(company, role));
  updateApplyProfiles(root, (data) => {
    if (!data.packages[pid]) data.packages[pid] = { company: '', role: '', note: '', sourceDocId: '', fields: {} };
    const p = data.packages[pid];
    if (!p.company && company) p.company = String(company);
    if (!p.role && role) p.role = String(role);
    if (!p.note && note) p.note = String(note);
    if (!p.sourceDocId && sourceDocId) p.sourceDocId = String(sourceDocId);
    return data;
  });
  const p = loadApplyProfiles(root).data.packages[pid];
  return { id: pid, company: p.company, role: p.role, note: p.note, sourceDocId: p.sourceDocId, fields: p.fields };
}
