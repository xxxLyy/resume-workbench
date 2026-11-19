// talent.mjs — 「求职画像 + 求职偏好」后端编排（UPCV A1 · #7/#8；契约 dev-docs/2026-11-19-upcv-port-talent-design.md）
// 分层与 ai-helper.mjs 同口径：build* 造 prompt（纯函数）→ llm.mjs chat() 调模型 → parse* 护栏归一。
// 账本：talent.json {profile:null|{…}} / preference.json {preference:null|{…}}（对象形状）。
//   唯一写路径 = tx.mjs updateJsonLedger（跨进程锁 + 损坏停写 + initial 种子）。
//   四连登记配套：RESTORE_MANAGED_FILES + 备份 bakFiles/ALLOWED + .gitignore + test.sh 隔离 seed（见 server.mjs 接线）。
// 偏好校验照 efc apps/server/src/routes/jobs.ts preference 段翻译成 vanilla（零依赖），
//   差异按本仓设计文档：jobTypes 只收 SOCIAL|INTERNSHIP（用户已剔除校招）、salary.unit 钉 K、三组 id 收数字数组。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chat } from './llm.mjs';
import { updateJsonLedger } from './tx.mjs';
import { docToText, sectionsOf } from './extract.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
// 与 server.mjs 同一口径：RESUME_ROOT 优先，缺省 = 脚本目录（测试隔离用）。
const defaultRoot = () => process.env.RESUME_ROOT || APP_ROOT;

const TALENT_FILE = 'talent.json';
const PREF_FILE = 'preference.json';
const MASTER_TEXT_MAX = 20000;   // 设计 §1：母版正文截 20000 字
const HEADLINE_CLIP = 40;        // headline 缺失兜底句里母版标题的截断
const ID_RE = /^[a-z0-9][a-z0-9-]{0,90}$/;   // 与 server.mjs VALID_ID 同口径（恢复链路可污染 meta，id 进路径前先挡）

// kindOf 与 server.mjs:720 同口径照抄（量小不抽公共模块；本文件禁改 server.mjs）
const kindOf = (m) => ((m && (m.kind === 'job' || (!m.kind && m.job))) ? 'job' : 'master');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const corruptErr = (name, cause) => {
  const e = new Error(`数据文件损坏，已停止写入：${name}。请先人工修复或从备份恢复。`);
  e.httpCode = 500; e.code = 'CORRUPT'; if (cause) e.cause = cause;
  return e;
};

// ===== 账本读取：缺失 → null（未初始化）；损坏/形状错 → CORRUPT 500（停写口径同 apply-profiles）=====
const talentShapeOk = (d) => isObj(d) && Object.prototype.hasOwnProperty.call(d, 'profile')
  && (d.profile === null || isObj(d.profile));
const prefShapeOk = (d) => isObj(d) && Object.prototype.hasOwnProperty.call(d, 'preference')
  && (d.preference === null || isObj(d.preference));
function readLedger(root, file, shapeOk) {
  const fp = path.join(root, file);
  if (!fs.existsSync(fp)) return null;
  let d = null;
  try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (err) { throw corruptErr(file, err); }
  if (!shapeOk(d)) throw corruptErr(file);
  return d;
}

// ===== 母版查找：未归档 kind:'master' 且 docs/<id>.html 在盘；多份取 mtime 最新（确定性）=====
// docs-meta.json 损坏 → CORRUPT（不能当空表误报「无母版」）。
export function findMaster(root = defaultRoot()) {
  const mp = path.join(root, 'docs-meta.json');
  if (!fs.existsSync(mp)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(mp, 'utf8')); }
  catch (err) { throw corruptErr('docs-meta.json', err); }
  if (!isObj(meta)) throw corruptErr('docs-meta.json');
  const cands = [];
  for (const id of Object.keys(meta)) {
    const m = meta[id];
    if (!isObj(m) || m.archivedAt || kindOf(m) !== 'master' || !ID_RE.test(id)) continue;
    const f = path.join(root, 'docs', id + '.html');
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    let title = '';
    try { title = ((fs.readFileSync(f, 'utf8').match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]*>/g, '').trim(); } catch {}
    cands.push({ id, title: title || id, file: f, mtimeMs: st.mtimeMs });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return cands[0];
}

// ===== 画像 prompt（纯函数）：母版正文截 20000 字 + 章节标题清单作结构提示 =====
export function buildTalentPrompt(master) {
  let text = '';
  let sectionNames = [];
  try { text = docToText(fs.readFileSync(master.file, 'utf8'), { includeHidden: false }).slice(0, MASTER_TEXT_MAX); }
  catch { text = ''; }
  try { sectionNames = sectionsOf(fs.readFileSync(master.file, 'utf8')).map((s) => s.title).filter(Boolean).slice(0, 12); }
  catch { sectionNames = []; }
  const sys = '你是资深职业顾问。基于用户母版简历生成求职画像，只输出 JSON，形状严格如下：'
    + '{"timeline":[{"period":"起止时间","title":"身份/职位","org":"学校/公司","kind":"education|experience|project|other"}],'
    + '"directions":[{"name":"求职方向","confidence":0到1之间的小数,"reason":"判定依据"}],'
    + '"competitiveness":{"level":1到5的整数,"label":"水平描述","strengths":["优势"],"gaps":["短板"]},'
    + '"headline":"一句话画像定位"}\n'
    + '规则：\n'
    + '- 只依据简历内容，不虚构任何经历、公司、学历或数据。\n'
    + '- strengths 与 gaps 如实呈现；简历信息不足就在 gaps 里如实指出。\n'
    + '- timeline 按时间先后排序，覆盖教育、工作/实习与项目经历；period 用简历原文时间。\n'
    + '- directions 给 1-3 个，confidence 取 0 到 1 的小数。\n'
    + '- competitiveness.level 必须是 1-5 的整数。\n'
    + '- 只输出 JSON，不要任何解释或代码围栏。';
  const user = `【简历标题】${master.title}\n`
    + (sectionNames.length ? `【简历章节】${sectionNames.join('、')}\n` : '')
    + `\n【母版正文】\n${text}`;
  return { sys, user };
}

// ===== 画像解析（三护栏，口径照 eval.mjs parseEvalReport：两段式 JSON 提取 + 越界整份作废）=====
// ① level 非整数/越界 → 整份作废；② directions 非数组/空 → 整份作废；
// ③ headline 缺失 → 不作废，由 generate 用母版标题兜底（服务端事实句，不编造）。
export function parseTalent(raw) {
  const fail = (reason) => ({ ok: false, profile: null, reason });
  const cleaned = String(raw ?? '').trim().replace(/```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let data;
  try { data = JSON.parse(cleaned); }
  catch {
    const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
    if (a < 0 || b <= a) return fail('模型输出不是合法 JSON');
    try { data = JSON.parse(cleaned.slice(a, b + 1)); }
    catch { return fail('模型输出不是合法 JSON'); }
  }
  if (!isObj(data)) return fail('模型输出不是 JSON 对象');

  const comp = data.competitiveness;
  if (!isObj(comp)) return fail('competitiveness 缺失');
  const level = comp.level;
  // 写成 !Number.isInteger || 越界（而非 isInteger && x<1||x>5 反向），NaN/小数一并拦下，同 eval score 口径
  if (typeof level !== 'number' || !Number.isInteger(level) || !(level >= 1 && level <= 5)) {
    return fail('competitiveness.level 必须是 1-5 的整数，实际 ' + JSON.stringify(level ?? null));
  }
  if (!Array.isArray(data.directions) || !data.directions.length) return fail('directions 必须是非空数组');

  // timeline 逐条归一、畸形丢弃（不整份作废，同 eval matches 口径）
  const timeline = (Array.isArray(data.timeline) ? data.timeline : [])
    .filter(isObj)
    .map((it) => ({
      period: typeof it.period === 'string' ? it.period.trim() : '',
      title: typeof it.title === 'string' ? it.title.trim() : '',
      org: typeof it.org === 'string' ? it.org.trim() : '',
      kind: ['education', 'experience', 'project', 'other'].includes(it.kind) ? it.kind : 'other'
    }))
    .filter((it) => it.title);

  const directions = data.directions.filter(isObj)
    .map((it) => {
      const conf = typeof it.confidence === 'number' && Number.isFinite(it.confidence) ? Math.min(1, Math.max(0, it.confidence)) : 0.5;
      return {
        name: typeof it.name === 'string' ? it.name.trim() : '',
        confidence: conf,
        reason: typeof it.reason === 'string' ? it.reason.trim() : ''
      };
    })
    .filter((it) => it.name);

  const strList = (x) => (Array.isArray(x) ? x.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean) : []);
  return {
    ok: true,
    profile: {
      timeline,
      directions,
      competitiveness: {
        level,
        label: typeof comp.label === 'string' ? comp.label.trim() : '',
        total: 5,   // 参考评分满分固定 5（UPCV 竞争力 5 级条口径；不采信模型给的 total）
        strengths: strList(comp.strengths),
        gaps: strList(comp.gaps)
      },
      headline: typeof data.headline === 'string' ? data.headline.trim() : ''
    }
  };
}

// ===== 生成/刷新（同一实现，UPCV 语义区分）=====
// 抛错口径：NO_MASTER 400 / CORRUPT 500；chat 抛错原样上抛（路由统一 502）；解析两轮失败 502。
export async function generateTalent({ root = defaultRoot(), lease, profile } = {}) {
  const master = findMaster(root);
  if (!master) {
    const e = new Error('先创建或导入一份母版简历，画像基于母版生成');
    e.httpCode = 400; e.code = 'NO_MASTER';
    throw e;
  }
  const p = buildTalentPrompt(master);
  let parsed = null, lastReason = '';
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const r = parseTalent(await chat(root, p.sys, p.user, { lease, profile }));
    if (r.ok) parsed = r.profile; else lastReason = r.reason;
  }
  if (!parsed) {
    const e = new Error('画像结果解析失败：' + lastReason);
    e.httpCode = 502; e.code = 'BAD_TALENT';
    throw e;
  }
  // 护栏③：headline 缺失 → 服务端事实句兜底（标题取自母版 <h1>，不是编造）
  if (!parsed.headline) parsed.headline = `基于「${master.title.slice(0, HEADLINE_CLIP)}」的求职画像`;
  const next = updateJsonLedger(root, TALENT_FILE, () => ({
    profile: { ...parsed, generatedAt: new Date().toISOString(), sourceDocId: master.id }
  }), { lockFile: '.talent.json.lock', validate: talentShapeOk, initial: { profile: null } });
  return next.profile;
}

export function getTalentProfile(root = defaultRoot()) {
  // 文件缺失（未初始化）→ null；损坏 → readLedger 抛 CORRUPT（原样上抛，见上）
  return readLedger(root, TALENT_FILE, talentShapeOk)?.profile ?? null;
}

// ===== 求职偏好（设计 §2；枚举/范围非法 → 400 中文首因）=====
export const PREF_JOB_TYPES = ['SOCIAL', 'INTERNSHIP'];   // 用户已剔除校招，CAMPUS 不在合法集
export const PREF_STATUSES = ['actively_looking', 'open_to_offers', 'not_looking'];
export const PREF_COMPANY_TYPES = ['CENTRAL_SOE', 'STATE_OWNED', 'PUBLIC_INSTITUTION', 'LISTED', 'FOREIGN', 'JV', 'PRIVATE', 'STARTUP'];
export const PREF_AVAILABILITY = ['随时', '1周内', '1个月内', '1-3个月', '3个月以上', '待定'];
export const COMPANY_TYPE_LABELS = Object.assign(Object.create(null), {
  CENTRAL_SOE: '央企', STATE_OWNED: '国企', PUBLIC_INSTITUTION: '事业单位', LISTED: '上市公司',
  FOREIGN: '外企', JV: '合资', PRIVATE: '民企', STARTUP: '创业公司'
});

// 数字 id 数组（UPCV 契约：cityIds/industryIds/functionIds；A2 接字典后才有可读名，占位期存 id）
const numIds = (x) => {
  if (!Array.isArray(x)) return null;
  const out = [];
  for (const v of x) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out.push(v);
  }
  return out;
};
const enumCheck = (x, list) => {
  if (!Array.isArray(x)) return null;
  const out = [];
  for (const v of x) {
    if (typeof v !== 'string' || !list.includes(v)) return null;
    out.push(v);
  }
  return out;
};

/** 全量校验偏好体：字段出现即校验，合法字段进 pref（整体覆盖写，PUT 语义）；非法 → {error} 首因。 */
export function validatePreference(body) {
  if (!isObj(body)) return { error: 'body 必须是 JSON 对象' };
  const pref = {};
  if (body.jobTypes !== undefined) {
    const v = enumCheck(body.jobTypes, PREF_JOB_TYPES);
    if (!v) return { error: 'jobTypes 必须是数组，元素 ∈ SOCIAL | INTERNSHIP' };
    pref.jobTypes = v;
  }
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !PREF_STATUSES.includes(body.status)) {
      return { error: 'status 必须是 actively_looking | open_to_offers | not_looking' };
    }
    pref.status = body.status;
  }
  if (body.salary !== undefined) {
    const s = body.salary;
    if (!isObj(s)) return { error: 'salary 必须是对象 {min,max,unit}' };
    const min = s.min === undefined || s.min === null ? undefined : Number(s.min);
    const max = s.max === undefined || s.max === null ? undefined : Number(s.max);
    if (min !== undefined && (!Number.isFinite(min) || min < 0)) return { error: 'salary.min 必须是非负数字' };
    if (max !== undefined && (!Number.isFinite(max) || max < 0)) return { error: 'salary.max 必须是非负数字' };
    if (min !== undefined && max !== undefined && min > max) return { error: 'salary.min 不能大于 salary.max' };
    if (s.unit !== undefined && s.unit !== 'K') return { error: 'salary.unit 必须是 K' };
    pref.salary = {
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(s.unit !== undefined ? { unit: 'K' } : {})
    };
  }
  for (const key of ['cityIds', 'industryIds', 'functionIds']) {
    if (body[key] !== undefined) {
      const v = numIds(body[key]);
      if (!v) return { error: `${key} 必须是数字 id 数组` };
      pref[key] = v;
    }
  }
  if (body.companyTypes !== undefined) {
    const v = enumCheck(body.companyTypes, PREF_COMPANY_TYPES);
    if (!v) return { error: 'companyTypes 必须是数组，元素 ⊆ ' + PREF_COMPANY_TYPES.join(' | ') };
    pref.companyTypes = v;
  }
  if (body.availability !== undefined) {
    if (typeof body.availability !== 'string' || !PREF_AVAILABILITY.includes(body.availability)) {
      return { error: 'availability 必须是 ' + PREF_AVAILABILITY.join(' | ') };
    }
    pref.availability = body.availability;
  }
  if (body.allowContact !== undefined) {
    if (typeof body.allowContact !== 'boolean') return { error: 'allowContact 必须是布尔值' };
    pref.allowContact = body.allowContact;
  }
  return { pref };
}

export function getPreference(root = defaultRoot()) {
  // 同 getTalentProfile：缺失 → null（A2 推荐链路依赖该分支——无偏好降级裸 SOCIAL feed）；
  // 损坏 → readLedger 抛 CORRUPT 原样上抛。
  return readLedger(root, PREF_FILE, prefShapeOk)?.preference ?? null;
}

export function savePreference(pref, root = defaultRoot()) {
  const next = updateJsonLedger(root, PREF_FILE, () => ({ preference: pref }),
    { lockFile: '.preference.json.lock', validate: prefShapeOk, initial: { preference: null } });
  return next.preference;
}
