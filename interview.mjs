// interview.mjs — 模拟面试会话机（文字版）：会话 CRUD + AI 出题 / 答题提示 / 复盘报告
// 形状复刻自 upcv-features-implementation.md §6（只复刻形状，不调用其接口）：
//   类型三选 comprehensive/professional/hr、questionCap=14、声音 4 项占位（文字版禁用）。
//
// 与既有模块的口径关系：
//   · 持久化：interviews.json（repo 根），读写纪律复刻 server.mjs 的 readJson/writeJson ——
//     根值必须是数组、写前 assertWritable、tmp+rename 原子落盘、0600。本模块自管这张表，
//     不借 server.mjs 的 JSON_FILES（该表不可改）。
//   · AI 调用：llm.mjs 的 chat(root, sys, user, {lease, meta, profile}) —— 只借道不重造：
//     槽池由 llm.mjs 的 aiPool 兜底（或调用方透传 lease），本模块零池化代码。
//   · 诚实红线：报告/提示/出题只允许基于「简历文本 + 职位 JD + 本会话问答」，数字类事实
//     必须来自输入材料；不打分、不排名、不预测录用概率（与 practice.mjs 反馈口径一致）。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, hasLLM, loadProfiles } from './llm.mjs';
import { docToText } from './extract.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));   // 与 server.mjs 同目录 = repo 根
const FILE = path.join(ROOT, 'interviews.json');

// ===== 契约常量（UPCV §6 形状复刻）=====
export const QUESTION_CAP = 14;
export const INTERVIEW_TYPES = ['comprehensive', 'professional', 'hr'];
export const TYPE_LABELS = { comprehensive: '综合面试', professional: '专业面试', hr: 'HR 面试' };
// 文字版：声音是占位项（UPCV 用 Qwen-Audio realtime，本地文字版不开）。仍收存用户选择，字段只为前向兼容。
export const VOICES = [
  { id: 'zh-female', label: '中文女声', enabled: false },
  { id: 'zh-male', label: '中文男声', enabled: false },
  { id: 'en-female', label: '英文女声', enabled: false },
  { id: 'en-male', label: '英文男声', enabled: false },
];
// UPCV /api/mock-interview/config 的形状：{enabled, voices, interviewTypes, questionCap}。
// enabled=true 表示文字版可用；voices[].enabled=false 逐条表达「占位禁用」。
export const getConfig = () => ({
  enabled: true,
  voices: VOICES.map((v) => ({ ...v })),
  interviewTypes: [...INTERVIEW_TYPES],
  questionCap: QUESTION_CAP,
});
export const NO_MODEL_HINT = '未配置大模型：请到「设置」完成模型配置后再开始面试';
const ANSWER_MAX_CHARS = 4000;      // 与 practice.mjs 作答上限同口径
const RESUME_MAX_CHARS = 12000;     // 简历文本进 prompt 的上限（界内截断，防 token 烧穿）
const JD_MAX_CHARS = 8000;          // 与 server.mjs extractJd 兜底截断同量级
const SESSION_CAP = 50;             // 本地历史上限：最新在前截 50（practice 截 20 的同款收敛）
const SESSION_ID_RE = /^iv-[0-9a-f]{8}$/;

// ===== interviews.json 持久化（复刻 server.mjs readJson/writeJson 纪律）=====
// 根值形状：会话数组。形状错 → 读取降级为空表 + 写路径抛错停写（不静默覆盖用户历史）。
let corruptFlag = false;
function readStore() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(d)) { corruptFlag = true; return []; }
    corruptFlag = false; return d;
  } catch { corruptFlag = true; return []; }
}
function writeStore(list) {
  // 写前校验（server.mjs assertWritable 同款）：文件存在时重读一次，坏形状/坏 JSON 一律停写，
  // 不拿内存里的空表去覆盖用户历史。
  if (fs.existsSync(FILE)) {
    let ok = false;
    try { ok = Array.isArray(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { ok = false; }
    if (!ok || corruptFlag) {
      corruptFlag = true;
      throw Object.assign(new Error('数据文件损坏，已停止写入：interviews.json。请先人工修复或从备份恢复。'), { httpCode: 500, code: 'CORRUPT' });
    }
  } else if (corruptFlag) {
    throw Object.assign(new Error('数据文件损坏，已停止写入：interviews.json。请先人工修复或从备份恢复。'), { httpCode: 500, code: 'CORRUPT' });
  }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });   // 0600 同 server.mjs 口径
  fs.renameSync(tmp, FILE);
}

// ===== 形状守卫（历史数据不可信：坏形状当无记录，与 practice.mjs 同口径）=====
const isSession = (s) => !!(s && typeof s === 'object' && !Array.isArray(s) && SESSION_ID_RE.test(String(s.id || '')));
const sessions = () => readStore().filter(isSession);
const findIdx = (list, id) => list.findIndex((s) => s && s.id === id);

const fail = (status, error) => ({ ok: false, status, error });
const now = () => new Date().toISOString();

// ===== 会话视图（读取侧派生字段不落盘：pending/answeredCount/finished 由 questions+answers 算出）=====
const answeredCount = (s) => (Array.isArray(s.questions) ? s.questions : [])
  .filter((q) => q && q.status === 'answered').length;
const pendingOf = (s) => (Array.isArray(s.questions) ? s.questions : [])
  .find((q) => q && q.status === 'pending') || null;
const finishedOf = (s) => (Array.isArray(s.questions) ? s.questions : []).length >= (s.questionCap || QUESTION_CAP)
  && !pendingOf(s);
export function sessionView(s) {
  if (!isSession(s)) return null;
  const p = pendingOf(s);
  return {
    ...s,
    pending: p ? { index: p.index, question: p.text } : null,
    answeredCount: answeredCount(s),
    skippedCount: (Array.isArray(s.questions) ? s.questions : []).filter((q) => q && q.status === 'skipped').length,
    finished: finishedOf(s),
    hasReport: !!(s.report && typeof s.report === 'object'),
  };
}
export const sessionSummary = (s) => {
  const v = sessionView(s);
  return v && {
    id: v.id, createdAt: v.createdAt, type: v.type, typeLabel: TYPE_LABELS[v.type] || v.type,
    company: v.company || '', role: v.role || '', resumeId: v.resumeId || '', jobRef: v.jobRef || '',
    asked: v.questions.length, answered: v.answeredCount, cap: v.questionCap || QUESTION_CAP,
    finished: v.finished, hasReport: v.hasReport,
  };
};

export function listSessions() {
  return sessions().map(sessionSummary).filter(Boolean);
}
export function getSession(id) {
  return sessionView(sessions().find((s) => s.id === id) || null);
}
const getRaw = (id) => sessions().find((s) => s.id === id) || null;
const saveRaw = (session) => {
  const list = readStore();
  const i = findIdx(list, session.id);
  if (i < 0) return false;
  list[i] = session;
  writeStore(list);
  return true;
};

// ===== 材料解析：jobRef → applications.json 条目（JD 快照）；resumeId → docs/<id>.html 文本 =====
// JD 在创建时快照进会话（投递记录被删/被改不漂移本会话）；简历按 resumeId 每次现读
// （文档是用户会改的活物，现读才不算过期材料；读不到 → 空文本降级，不假装有简历）。
const loadApps = () => {
  const f = path.join(ROOT, 'applications.json');
  try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
};
const loadMetaMap = () => {
  const f = path.join(ROOT, 'docs-meta.json');
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; }
};
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;   // 与 server.mjs VALID_ID 同口径
const resumeTextOf = (resumeId) => {
  if (!resumeId) return '';
  try {
    const html = fs.readFileSync(path.join(ROOT, 'docs', resumeId + '.html'), 'utf8');
    return docToText(html, { includeHidden: false }).slice(0, RESUME_MAX_CHARS);
  } catch { return ''; }
};
const resumeTitleOf = (resumeId) => {
  const m = loadMetaMap()[resumeId];
  return String((m && (m.tag || m.role)) || resumeId);
};

// ===== CRUD =====
export function createSession({ voice = '', type = '', jobRef = '', resumeId = '' } = {}) {
  if (!INTERVIEW_TYPES.includes(type)) {
    return fail(400, '面试类型无效（仅支持 comprehensive / professional / hr）');
  }
  const vid = String(voice || 'zh-female');
  if (voice && !VOICES.some((v) => v.id === vid)) return fail(400, '声音选项无效（文字版为占位项，可不选）');
  jobRef = String(jobRef || ''); resumeId = String(resumeId || '');
  let company = '', role = '', jd = '';
  if (jobRef) {
    const app = loadApps().find((a) => a && a.id === jobRef);
    if (!app) return fail(404, '关联职位不存在（投递记录里没有这条）');
    company = String(app.company || ''); role = String(app.role || ''); jd = String(app.jd || '');
  }
  if (resumeId) {
    if (!DOC_ID_RE.test(resumeId) || !fs.existsSync(path.join(ROOT, 'docs', resumeId + '.html'))) {
      return fail(404, '关联简历不存在（docs/ 里没有这份文档）');
    }
  }
  if (!jobRef && !resumeId) return fail(400, '至少要关联一个职位或一份简历：AI 出题需要材料依据');
  const s = {
    id: 'iv-' + randomBytes(4).toString('hex'),
    createdAt: now(), updatedAt: now(),
    voice: vid, type,
    jobRef, company, role, jd,                       // JD/公司/岗位快照：创建时钉死，防源记录变动
    resumeId, resumeTitle: resumeId ? resumeTitleOf(resumeId) : '',
    questionCap: QUESTION_CAP,
    questions: [], answers: {}, hints: {}, report: null,
  };
  const list = readStore();
  list.unshift(s);
  writeStore(list.slice(0, SESSION_CAP));
  return { ok: true, session: sessionView(s) };
}

export function deleteSession(id) {
  const list = readStore();
  const i = findIdx(list, String(id || ''));
  if (i < 0) return fail(404, '面试会话不存在');
  list.splice(i, 1);
  writeStore(list);
  return { ok: true };
}

// ===== AI 编排：prompt 构建（防编造约束钉在 sys 里）=====
const TYPE_GUIDES = {
  comprehensive: '综合面试：自我介绍、项目经历、岗位匹配与行为问题混合，广度优先、由浅入深。',
  professional: '专业面试：只问专业技术与项目深挖题——技术栈选型、实现细节、难点取舍、排查思路。',
  hr: 'HR 面试：只问软素质题——求职动机、职业规划、协作冲突、抗压与稳定性。',
};
const materialsBlock = (s) => {
  const parts = [];
  if (s.company || s.role) parts.push(`【目标职位】${s.company || ''}${s.company && s.role ? '·' : ''}${s.role || ''}`);
  if (s.jd) parts.push(`【职位 JD】\n${String(s.jd).slice(0, JD_MAX_CHARS)}`);
  const rt = resumeTextOf(s.resumeId);
  if (rt) parts.push(`【候选人简历】\n${rt}`);
  return parts.join('\n\n') || '（无关联材料）';
};
const qaBlock = (s, uptoIndex = Infinity) => {
  const qs = (Array.isArray(s.questions) ? s.questions : []).filter((q) => q && q.index < uptoIndex);
  if (!qs.length) return '（还没有问答记录）';
  return qs.map((q) => {
    const a = s.answers && s.answers[String(q.index)];
    const ans = q.status === 'answered' && a ? String(a.text || '').slice(0, 800) : '（跳过，未作答）';
    return `第 ${q.index + 1} 题：${q.text}\n回答：${ans}`;
  }).join('\n\n');
};

function buildQuestionPrompt(s) {
  const asked = (Array.isArray(s.questions) ? s.questions : []).map((q) => q.text);
  const next = asked.length + 1;
  const sys = `你是面试官，正在进行${TYPE_LABELS[s.type] || '面试'}（${TYPE_GUIDES[s.type] || ''}）。这是第 ${next}/${s.questionCap || QUESTION_CAP} 题。\n`
    + '规则：\n'
    + '1. 只出一道题，中文，不超过 80 字，一次只问一件事。\n'
    + '2. 出题只能基于【职位 JD】与【候选人简历】：材料里的公司、项目、技术、数字可以追问；材料没有的事实不得编造、不得假设。\n'
    + '3. 不得与已问过的问题重复或换汤不换药；已是最后几题时逐步收尾（职业规划、提问环节类）。\n'
    + '4. 只输出 JSON：{"question":"…"}，不要任何其它文字。';
  const user = materialsBlock(s) + '\n\n【已问过的问题】\n' + (asked.length ? asked.map((t, i) => `${i + 1}. ${t}`).join('\n') : '（无）');
  return { sys, user };
}
function buildHintPrompt(s, q) {
  const sys = '你是面试答题教练。给【当前问题】列答题要点，帮候选人组织思路，不替他写完整答案。\n'
    + '规则：\n'
    + '1. 要点只能指向简历/JD/已答记录里真实存在的经历与事实；材料里有的数字可以引用，材料没有的事实不得编造。题目需要材料外的经历时，写「用你材料外的真实经历补充」，不得虚构。\n'
    + '2. 只输出 JSON：{"points":["…"]}，3~6 条，每条不超过 50 字。';
  const user = materialsBlock(s) + `\n\n【当前问题】\n${q.text}\n\n【已有问答记录】\n` + qaBlock(s, q.index);
  return { sys, user };
}
function buildReportPrompt(s) {
  const sys = '你是面试复盘教练。根据这一场模拟面试的问答记录写复盘报告。\n'
    + '规则：\n'
    + '1. 事实边界：报告只允许基于【职位 JD】【候选人简历】与【问答记录】；数字、公司名、项目名、技术名词必须来自输入材料，材料没有的不得写进报告。\n'
    + '2. 只做定性复盘：不打分、不排名、不做百分位、不预测录用概率、不写「超过 X% 候选人」一类不可验证的比较。\n'
    + '3. 被跳过的问题在短板里如实写「第 k 题未作答」，不猜测原因。\n'
    + '4. 只输出 JSON：{"strengths":["…"],"gaps":["…"],"advice":["…"]}——优势、短板、建议各 2~6 条，每条不超过 60 字。';
  const user = materialsBlock(s) + '\n\n【问答记录】\n' + qaBlock(s);
  return { sys, user };
}

// ===== AI 输出解析（形状错即拒；practice.mjs 同款 stripFence）=====
const stripFence = (raw) => String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
function parseQuestion(raw) {
  const cleaned = stripFence(raw);
  try {
    const d = JSON.parse(cleaned);
    if (d && typeof d.question === 'string' && d.question.trim()) return { ok: true, question: d.question.trim().slice(0, 200) };
  } catch {}
  // 兜底：模型给了纯文本题面（不合 JSON 但确是一道题）→ 收下，不白烧这次调用
  if (cleaned && cleaned.length <= 300 && !/^[{[]/.test(cleaned)) return { ok: true, question: cleaned.replace(/^["']|["']$/g, '').trim() };
  return { ok: false, error: '模型输出无法解析为面试问题，本题未生成' };
}
const strList = (v, cap = 8, len = 200) => Array.isArray(v)
  ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, cap).map((x) => x.slice(0, len))
  : null;
function parseReport(raw) {
  try {
    const d = JSON.parse(stripFence(raw));
    const strengths = strList(d && d.strengths), gaps = strList(d && d.gaps), advice = strList(d && d.advice);
    if (strengths === null || gaps === null || advice === null) {
      return { ok: false, error: '模型输出无法解析为面试报告（strengths/gaps/advice 需为字符串数组），未写入任何结果' };
    }
    if (!strengths.length && !gaps.length && !advice.length) {
      return { ok: false, error: '模型报告为空（三个数组都没有内容），未写入任何结果' };
    }
    return { ok: true, report: { strengths, gaps, advice } };
  } catch { return { ok: false, error: '模型输出无法解析为面试报告（不是合法 JSON），未写入任何结果' }; }
}
function parsePoints(raw) {
  try {
    const d = JSON.parse(stripFence(raw));
    const points = strList(d && d.points, 10, 200);
    if (!points || !points.length) return { ok: false, error: '模型输出无法解析为答题要点（points 需为非空字符串数组）' };
    return { ok: true, points };
  } catch { return { ok: false, error: '模型输出无法解析为答题要点（不是合法 JSON）' }; }
}

// ===== AI 编排：出题 / 作答 / 提示 / 报告 =====
// nextQuestion：幂等——pending 题还在就原样返回（刷新/重复点击不重出题、不重复扣费）；
//   达到 cap → {done:true}；否则 AI 出一道、落账、返回 {index, question}。
//   形参按契约收 session 对象（视图或原始记录皆可）：内部按 session.id 重读存储行再操作，
//   不信传入副本的其它字段。
export async function nextQuestion(session, { lease, meta, profile } = {}) {
  const id = session && session.id;
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  const p = pendingOf(s);
  if (p) return { ok: true, index: p.index, question: p.text, pending: true };
  const cap = s.questionCap || QUESTION_CAP;
  if ((s.questions || []).length >= cap) return { ok: true, done: true, cap };
  if (!hasLLM(ROOT)) return fail(409, NO_MODEL_HINT);
  const prompt = buildQuestionPrompt(s);
  let raw;
  try { raw = await chat(ROOT, prompt.sys, prompt.user, { lease, meta, profile }); }
  catch (e) { return fail(502, '模型调用失败：' + String((e && e.message) || e).slice(0, 200)); }
  const parsed = parseQuestion(raw);
  if (!parsed.ok) return fail(502, parsed.error);
  const index = (s.questions || []).length;
  s.questions = [...(s.questions || []), { index, text: parsed.question, askedAt: now(), status: 'pending' }];
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，本题未保存');
  return { ok: true, index, question: parsed.question };
}

// submitAnswer：回答落在「当前 pending 题」上（唯一可作答位置）；重交 = 最近一次为准。
export function submitAnswer(id, answer) {
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  const p = pendingOf(s);
  if (!p) return fail(409, '当前没有待作答的问题（可能已全部答完，请先取下一题）');
  const t = String(answer == null ? '' : answer).trim();
  if (!t) return fail(400, '回答需为非空文本（跳过请用 skip）');
  if (t.length > ANSWER_MAX_CHARS) return fail(400, `回答过长（上限 ${ANSWER_MAX_CHARS} 字）`);
  s.questions = s.questions.map((q) => (q.index === p.index ? { ...q, status: 'answered' } : q));
  s.answers = { ...(s.answers || {}), [String(p.index)]: { text: t, at: now() } };
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，回答未保存');
  return { ok: true, index: p.index };
}

// skipQuestion：跳过当前 pending 题（跳过也记账：报告据此如实写「未作答」）。
export function skipQuestion(id) {
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  const p = pendingOf(s);
  if (!p) return fail(409, '当前没有可跳过的问题');
  s.questions = s.questions.map((q) => (q.index === p.index ? { ...q, status: 'skipped' } : q));
  s.answers = { ...(s.answers || {}), [String(p.index)]: { skipped: true, at: now() } };
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，操作未保存');
  return { ok: true, index: p.index };
}

// genHint：答题要点（存 hints[index]，重复生成覆盖旧值——重生成语义，与反馈重算同口径）。
export async function genHint(id, questionIndex, { lease, meta, profile } = {}) {
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  const q = (Array.isArray(s.questions) ? s.questions : []).find((x) => x && x.index === questionIndex);
  if (!q) return fail(404, '题目不存在（questionIndex 不在这场面试里）');
  if (!hasLLM(ROOT)) return fail(409, NO_MODEL_HINT);
  const prompt = buildHintPrompt(s, q);
  let raw;
  try { raw = await chat(ROOT, prompt.sys, prompt.user, { lease, meta, profile }); }
  catch (e) { return fail(502, '模型调用失败：' + String((e && e.message) || e).slice(0, 200)); }
  const parsed = parsePoints(raw);
  if (!parsed.ok) return fail(502, parsed.error);
  s.hints = { ...(s.hints || {}), [String(q.index)]: { points: parsed.points, at: now() } };
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，提示未保存');
  return { ok: true, index: q.index, points: parsed.points };
}

// genReport：至少答过 1 题才可复盘（零作答的报告全是编造）；生成后存档进 session.report。
export async function genReport(id, { lease, meta, profile } = {}) {
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  if (answeredCount(s) < 1) return fail(409, '还没有任何作答：至少回答 1 题后才能生成复盘报告');
  if (!hasLLM(ROOT)) return fail(409, NO_MODEL_HINT);
  const prompt = buildReportPrompt(s);
  const m = meta && typeof meta === 'object' ? meta : {};
  let raw;
  try { raw = await chat(ROOT, prompt.sys, prompt.user, { lease, meta: m, profile }); }
  catch (e) { return fail(502, '模型调用失败：' + String((e && e.message) || e).slice(0, 200)); }
  const parsed = parseReport(raw);
  if (!parsed.ok) return fail(502, parsed.error);
  const pm = (() => {
    try { const { active, profiles } = loadProfiles(ROOT); const c = (profiles || [])[profile == null ? active : profile] || {}; return c.model || null; } catch { return null; }
  })();
  s.report = { ...parsed.report, at: now(), model: pm, usage: m.usage ?? null };
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，报告未保存');
  return { ok: true, report: s.report };
}
