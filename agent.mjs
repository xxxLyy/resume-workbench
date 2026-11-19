// agent.mjs — 「Agent 求职助手」会话与编排（本地版）。
// 协议参照 docs/upcv-features-implementation.md §5（UPCV Agent）：
//   会话管理 · [context:doc|job:<id>] 上下文注入 · toolCard/quickReplies 下发 · 泄露策略手册本地化。
//   消息存储 = Vercel AI SDK v5 UIMessage 形状 {id,role,parts:[{type:'text'|'step-start'|'tool-<name>'}],metadata:{createdAt,tokenCount}}；
//   chatStream() = 多轮工具环：模型每轮给 {"toolCalls":[…]} 或 {"reply":…}（契约见 AGENT_SYSTEM），
//   server 侧真实执行工具（get_job_detail / query_job_progress / list_resumes / get_resume_summary，全只读），
//   结果回灌下一轮 system【工具结果】区，轮数封顶 3；产出 UIMessage 事件流
//   （tool-part{call→output-available}* → text-delta* → finish{message}），路由转 SSE（agent.routes.md §5）。
// 数据根注入：server.mjs 启动时调一次 init(root)（root = RESUME_ROOT，与数据文件同口径）。
// 读：docs-meta.json / docs/<id>.html / inbox.json / applications.json / evaluations.json（只读）。
// 写：仅 agent-sessions.json —— 与 server.mjs 同口径（tmp+rename、0600、形状校验、损坏停写）。
// 调用层：llm.mjs streamChatMsgs（profile 选择、aiPool 池化、租约都在那里）；
//   ai.mjs 只导出 prompt 构建/解析纯函数，本文件按同款模式把 Agent 的 prompt 与解析内聚在此处。
// 兼容：旧 {role,text,quickReplies,toolCards,at} 消息读出时自动归一为 UIMessage（msgToUI）；
//   非流式 chat() 保留：内部 drain chatStream，响应形状不变（渐进降级）。

import fs from 'node:fs';
import path from 'node:path';
import { streamChatMsgs } from './llm.mjs';
import { docToText, docToLines, sectionsOf } from './extract.mjs';
import { agentDraftTick } from './draft.mjs';   // UPCV A3：建简历草稿快照接缝（chatStream 用户条落盘后调用）

export const AGENT_NO_LLM = '未配置大模型：打开 /settings 完成模型配置';
const AGENT_FILE = 'agent-sessions.json';
const SESS_CAP = 100;      // 会话总数上限（超出裁最旧）
const MSG_CAP = 200;       // 单会话持久化消息上限
const HIST_CAP = 12;       // 发给模型的最近消息条数（上下文窗口控制）
const REF_CAP = 4;         // 单条消息解析的上下文引用上限
const JD_EXCERPT = 800;    // 注入 system 的 JD 摘要长度
const DOC_EXCERPT = 1200;  // 注入 system 的简历正文摘要长度
const ID_RE = /^[a-z0-9][a-z0-9-]{0,90}$/;
const TOOL_ARG_ID = /^[A-Za-z0-9_-]{1,90}$/;  // 工具参数 id 白名单（比会话 id 宽：允许大写/下划线；仍无路径分隔符）
const TOOL_ROUND_MAX = 3;  // 工具环轮数封顶：单条用户消息最多 3 轮模型交互（防死循环）
const TOOL_CALL_CAP = 4;   // 单轮最多执行的工具调用数（防一次刷几十个调用）
const TOOL_TIMEOUT_MS = 30000;  // 单工具执行超时（超时结果按 ok:false 回灌，不炸会话）
const TOOL_FACT_CLIP = 2000;    // 单条工具结果回灌 system 的 JSON 长度上限

// ===== 投递状态机（与 server.mjs 同口径：UPCV「我的职位」六态 + closed）=====
// to_apply(待投递) → preparing(准备中) → applied(已投递) → replied(有回复) → interviewing(面试中) → offer(Offer)；
// 老数据读时归一，不改写 applications.json。三张表照抄 server.mjs（本文件禁改 server.mjs，量小不抽公共模块）。
const APP_STATUSES = ['to_apply', 'preparing', 'applied', 'replied', 'interviewing', 'offer'];
const APP_STATUS_ALL = [...APP_STATUSES, 'closed'];
const APP_STATUS_LEGACY = Object.assign(Object.create(null), { '已投递': 'applied', '笔试': 'replied', '面试中': 'interviewing', 'offer': 'offer', '已拒': 'closed', '搁置': 'closed' });
const APP_STATUS_LABEL = Object.assign(Object.create(null), { to_apply: '待投递', preparing: '准备中', applied: '已投递', replied: '有回复', interviewing: '面试中', offer: 'Offer', closed: '已关闭' });
const appStatusEnum = (s) => (APP_STATUS_ALL.includes(s) ? s : (APP_STATUS_LEGACY[s] || 'applied'));
const appStatusLabel = (s) => APP_STATUS_LABEL[s] || String(s == null ? '' : s);
// 工具入参 status 归一：枚举值 / 老枚举 / 中文标签都收 → 六态枚举；认不出回 null（调用方转 400）
const appStatusArg = (s) => {
  const t = String(s == null ? '' : s).trim();
  if (!t) return null;
  if (APP_STATUS_ALL.includes(t)) return t;
  if (APP_STATUS_LEGACY[t]) return APP_STATUS_LEGACY[t];
  return APP_STATUS_ALL.find((k) => APP_STATUS_LABEL[k] === t) || null;
};

let ROOT = null;
// 参数化注入数据根：server.mjs 在启动路径调一次 init(process.env.RESUME_ROOT || APP_ROOT)。
export function init(root) { ROOT = root; }
const R = () => { if (!ROOT) throw new Error('agent.mjs 未初始化：先调 init(root)'); return ROOT; };

// ===== JSON 持久化（仿 server.mjs readJson/writeJson：读容忍缺失、形状错=损坏、写前断言、tmp+rename 0600）=====
const isArr = (d) => Array.isArray(d);
const isObj = (d) => !!d && typeof d === 'object' && !Array.isArray(d);
function readJson(file, fallback, check) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return check(d) ? d : fallback;
  } catch { return fallback; }
}
function writeJson(file, data, check) {
  // 写前校验现存文件：损坏即停写（不拿空表盖掉用户数据），口径同 server.mjs assertWritable
  if (fs.existsSync(file)) {
    let bad = false;
    try { bad = !check(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { bad = true; }
    if (bad) {
      throw Object.assign(
        new Error(`数据文件损坏，已停止写入：${path.basename(file)}。请先人工修复或删除该文件后重建。`),
        { httpCode: 500, code: 'CORRUPT' });
    }
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const agentFile = () => path.join(R(), AGENT_FILE);
const loadSessions = () => readJson(agentFile(), [], isArr);
const saveSessions = (list) => writeJson(agentFile(), list, isArr);
const loadMeta = () => readJson(path.join(R(), 'docs-meta.json'), {}, isObj);
const loadInbox = () => readJson(path.join(R(), 'inbox.json'), [], isArr);
const loadApps = () => readJson(path.join(R(), 'applications.json'), [], isArr);
const loadEvals = () => readJson(path.join(R(), 'evaluations.json'), [], isArr);
const docFile = (id) => path.join(R(), 'docs', String(id) + '.html');
const readDoc = (id) => { try { return fs.readFileSync(docFile(id), 'utf8'); } catch { return null; } };
// 文档标题口径同首页：正文首个 <h1>，取不到回退 id
const docTitleOf = (html, id) => {
  const m = String(html || '').match(/<h1[^>]*>([\s\S]*?)<\/h1>/);
  return (m ? m[1].replace(/<[^>]*>/g, '').trim() : '') || id;
};

const nowIso = () => new Date().toISOString();
const newId = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };

// ===== 会话 CRUD =====
const sessionView = (s) => ({
  id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
  messageCount: (s.messages || []).length,
  lastText: clip(textOf((s.messages || [])[(s.messages || []).length - 1]), 40)
});
const findSession = (list, id) => list.find((s) => s && s.id === id) || null;

export function listSessions() {
  return loadSessions()
    .filter((s) => s && typeof s.id === 'string')
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .map(sessionView);
}

export function createSession({ title } = {}) {
  const t = String(title || '').trim().slice(0, 40) || '新会话';
  const at = nowIso();
  const s = { id: newId('ag'), title: t, purpose: 'chat', platform: 'local', createdAt: at, updatedAt: at, messages: [] };
  const list = loadSessions();
  list.unshift(s);
  saveSessions(list.slice(0, SESS_CAP));
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: [] };
}

export function getSession(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const s = findSession(loadSessions(), String(id));
  if (!s) return null;
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: (s.messages || []).map(msgToUI) };
}

export function renameSession(id, title) {
  if (!ID_RE.test(String(id || ''))) return null;
  const t = String(title || '').trim().slice(0, 40);
  if (!t) return null;
  const list = loadSessions();
  const s = findSession(list, String(id));
  if (!s) return null;
  s.title = t; s.updatedAt = nowIso();
  saveSessions(list);
  return sessionView(s);
}

export function deleteSession(id) {
  if (!ID_RE.test(String(id || ''))) return false;
  const list = loadSessions();
  const next = list.filter((s) => s && s.id !== String(id));
  if (next.length === list.length) return false;
  saveSessions(next);
  return true;
}

// ===== 上下文注入协议：[context:doc:<id>] / [context:job:<id>]（尾段可选 :<title>，照 UPCV 样本）=====
const CTX_RE = /\[context:(doc|job):([A-Za-z0-9_-]{1,90})(?::[^\]\n]*)?\]/g;
export function parseContextRefs(message) {
  const out = [], seen = new Set();
  const re = new RegExp(CTX_RE.source, 'g');
  let m;
  while ((m = re.exec(String(message || ''))) && out.length < REF_CAP) {
    const key = m[1] + ':' + m[2];
    if (!seen.has(key)) { seen.add(key); out.push({ type: m[1], id: m[2] }); }
  }
  return out;
}
// 发给模型与落盘的用户文本剥掉协议前缀（上下文改由 system 注入，避免双份）
export function stripContextRefs(message) {
  return String(message || '').replace(new RegExp(CTX_RE.source, 'g'), '').replace(/\s{2,}/g, ' ').trim();
}

// ===== 引用解析（只读事实层）=====
function inboxView(it) {
  return {
    source: 'inbox', id: it.id, title: it.title || '', company: it.company || '', role: it.role || '',
    salary: it.salary || '', url: it.url || '', status: it.status || '',
    score: it.score ?? null, verdict: it.verdict || '', jd: String(it.jd || '').slice(0, JD_EXCERPT)
  };
}
// 按源视图（resolveJob 与 get_job_detail 工具共用同一份字段口径）：
//   status=原值入档；statusEnum/statusLabel=六态归一与中文标签（新枚举进人语文案走 label，枚举值不进文案）
function appView(ap) {
  const st = appStatusEnum(ap.status);
  return {
    source: 'app', id: ap.id, title: `${ap.company || ''}·${ap.role || ''}`, company: ap.company || '',
    role: ap.role || '', salary: '', url: ap.link || '', status: ap.status || '', statusEnum: st, statusLabel: appStatusLabel(st),
    appliedAt: ap.appliedAt || '', dueDate: ap.dueDate || '', nextStep: ap.nextStep || '', docId: ap.docId || '',
    jd: String(ap.jd || '').slice(0, JD_EXCERPT)
  };
}
function evalView(ev) {
  // evaluations.json 的 salary 是 {text,source} 对象；老数据可能是裸字符串——两种都收，取可读文本
  const sal = (ev.salary && typeof ev.salary === 'object') ? String(ev.salary.text || '') : String(ev.salary || '');
  return {
    source: 'eval', id: ev.id, title: `${ev.company || ''}·${ev.role || ''}`, company: ev.company || '',
    role: ev.role || '', salary: sal, url: '', status: '评估', score: ev.score ?? null,
    verdict: ev.verdict || '', jd: String(ev.jd || '').slice(0, JD_EXCERPT)
  };
}
function resolveJob(id) {
  const s = String(id);
  const ib = loadInbox().find((x) => x && x.id === s);
  if (ib) return inboxView(ib);
  const ap = loadApps().find((x) => x && x.id === s);
  if (ap) return appView(ap);
  const ev = loadEvals().find((x) => x && x.id === s);
  if (ev) return evalView(ev);
  return null;
}
function resolveDoc(id) {
  const s = String(id);
  const meta = loadMeta()[s] || null;
  const html = readDoc(s);
  if (!meta && html == null) return null;
  const text = html == null ? '' : docToText(html, { includeHidden: false });
  return {
    id: s, title: docTitleOf(html, s), kind: (meta && meta.kind) || 'master',
    company: (meta && meta.company) || '', role: (meta && meta.role) || '',
    tag: (meta && meta.tag) || '', archived: !!(meta && meta.archivedAt),
    excerpt: text.slice(0, DOC_EXCERPT)
  };
}
// /agent/context-preview：给前端/调试看「这条消息会注入什么」，不发模型
export function previewContext(text) {
  return { refs: parseContextRefs(text).map((r) => ({ ...r, data: r.type === 'job' ? resolveJob(r.id) : resolveDoc(r.id) })) };
}

// ===== 事实层（system 注入；全部来自本仓 JSON，无编造空间）=====
function listResumes() {
  const meta = loadMeta();
  return Object.keys(meta)
    .filter((id) => meta[id] && !meta[id].archivedAt && fs.existsSync(docFile(id)))
    .map((id) => {
      const m = meta[id];
      return { id, title: docTitleOf(readDoc(id), id), kind: m.kind || 'master', company: m.company || '', role: m.role || '', tag: m.tag || '' };
    });
}
function todayStr() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 求职画像/偏好标签（UPCV A1）：值域与 talent.mjs 同源照抄（本文件不 import talent.mjs，量小照抄同 APP_STATUS 三张表纪律）
const PREF_JOB_TYPE_LABEL = Object.assign(Object.create(null), { SOCIAL: '社招', INTERNSHIP: '实习' });
const PREF_STATUS_LABEL = Object.assign(Object.create(null), { actively_looking: '在看机会', open_to_offers: '机会合适会考虑', not_looking: '暂不看机会' });
const PREF_COMPANY_LABEL = Object.assign(Object.create(null), {
  CENTRAL_SOE: '央企', STATE_OWNED: '国企', PUBLIC_INSTITUTION: '事业单位', LISTED: '上市公司',
  FOREIGN: '外企', JV: '合资', PRIVATE: '民企', STARTUP: '创业公司'
});
function factsBlock(ctxResolved) {
  const resumes = listResumes();
  const inbox = loadInbox().filter((x) => x && x.status !== 'dismissed');
  const fresh = inbox.filter((x) => x.status === 'new');
  const apps = loadApps();
  const now = Date.now();
  // 临近截止口径同投递页 DUE_SOON_MS（server.mjs:146，7d；UPCV A3 收尾对齐——原 48h 与投递页 7d 两档漂移已并）
  const due = apps.filter((a) => a && a.dueDate && (new Date(a.dueDate).getTime() - now) < 7 * 24 * 3600 * 1000);
  // 状态计数走六态归一（老数据 '已投递' 与新枚举 'applied' 合并成同一桶，不进人语两个名）
  const byStatus = {};
  for (const a of apps) { if (a) { const k = appStatusLabel(appStatusEnum(a.status)); byStatus[k] = (byStatus[k] || 0) + 1; } }
  const L = [];
  L.push(`【今天】${todayStr()}`);
  L.push(`【简历】共 ${resumes.length} 份${resumes.length ? '' : '（没有任何简历）'}`);
  for (const r of resumes.slice(0, 12)) {
    L.push(`- id=${r.id}「${r.title}」类型=${r.kind === 'job' ? '岗位定制' : '母版'}${r.company ? ` 公司=${r.company}` : ''}${r.role ? ` 岗位=${r.role}` : ''}`);
  }
  L.push(`【收件箱】待筛选 ${fresh.length} 条 / 共 ${inbox.length} 条（未含已不考虑）`);
  for (const it of fresh.slice(0, 8)) {
    L.push(`- id=${it.id}「${clip(it.title, 40)}」公司=${it.company || '?'} 岗位=${it.role || '?'}${it.salary ? ` 薪资=${it.salary}` : ''}${it.score != null ? ` 评分=${it.score}` : ''}${it.verdict ? ` 结论=${it.verdict}` : ''}${it.url ? ` 链接=${it.url}` : ' 无申请链接'}`);
  }
  L.push(`【投递记录】共 ${apps.length} 条${Object.keys(byStatus).length ? '（' + Object.entries(byStatus).map(([k, v]) => `${k}×${v}`).join('、') + '）' : ''}`);
  for (const a of due.slice(0, 8)) {
    L.push(`- 临近截止 id=${a.id}「${a.company || ''}·${a.role || ''}」截止=${a.dueDate} 状态=${appStatusLabel(appStatusEnum(a.status))}${a.nextStep ? ` 下一步=${a.nextStep}` : ''}`);
  }
  // 求职画像/偏好（UPCV A1）：药丸自动携带的背景事实，非查询对象；有则注入无则静默。
  // 读取容忍损坏（readJson 回退 null）：facts 是装饰性注入，不因坏账本炸对话；坏账本由 /talent 主路径 500 停写兜底。
  const talLed = readJson(path.join(R(), 'talent.json'), null, isObj);
  const prof = (talLed && isObj(talLed.profile)) ? talLed.profile : null;
  if (prof) {
    const dirs = (Array.isArray(prof.directions) ? prof.directions : [])
      .filter((d) => d && typeof d.name === 'string' && d.name.trim())
      .map((d) => `${d.name}(${typeof d.confidence === 'number' && Number.isFinite(d.confidence) ? d.confidence : '?'})`)
      .slice(0, 3);
    const comp = isObj(prof.competitiveness) ? prof.competitiveness : null;
    L.push(`【求职画像】${typeof prof.headline === 'string' && prof.headline.trim() ? prof.headline : '（无一句话定位）'}`
      + `${dirs.length ? '；方向：' + dirs.join('、') : ''}`
      + `${comp && Number.isInteger(comp.level) ? `；竞争力 ${comp.level}/5${typeof comp.label === 'string' && comp.label.trim() ? ' ' + comp.label : ''}` : ''}`);
  }
  const preLed = readJson(path.join(R(), 'preference.json'), null, isObj);
  const pref = (preLed && isObj(preLed.preference)) ? preLed.preference : null;
  if (pref) {
    const p = [];
    const jts = (Array.isArray(pref.jobTypes) ? pref.jobTypes : []).map((t) => PREF_JOB_TYPE_LABEL[t] || String(t)).filter(Boolean);
    if (jts.length) p.push(`求职类型：${jts.join('、')}`);
    if (pref.status) p.push(`状态：${PREF_STATUS_LABEL[pref.status] || String(pref.status)}`);
    if (isObj(pref.salary) && (pref.salary.min != null || pref.salary.max != null)) {
      p.push(`期望 ${pref.salary.min != null ? pref.salary.min : '?'}-${pref.salary.max != null ? pref.salary.max : '?'}K`);
    }
    // 城市/行业/职能是数字 id（A2 字典未落地）：如实注 id，不编造可读地名；A2 接字典后此处升级
    for (const [k, name] of [['cityIds', '城市'], ['industryIds', '行业'], ['functionIds', '职能']]) {
      const ids = Array.isArray(pref[k]) ? pref[k].filter((v) => Number.isFinite(v)) : [];
      if (ids.length) p.push(`意向${name} id：${ids.slice(0, 6).join('、')}${ids.length > 6 ? '…' : ''}`);
    }
    const cts = (Array.isArray(pref.companyTypes) ? pref.companyTypes : []).map((t) => PREF_COMPANY_LABEL[t] || String(t)).filter(Boolean);
    if (cts.length) p.push(`公司类型：${cts.join('、')}`);
    if (typeof pref.availability === 'string' && pref.availability) p.push(`到岗：${pref.availability}`);
    if (p.length) L.push(`【求职偏好】` + p.join('；'));
  }
  if (ctxResolved.length) {
    L.push('【本条消息引用的上下文】');
    for (const r of ctxResolved) {
      if (!r.data) { L.push(`[context:${r.type}:${r.id}] → 未找到该 id（不要编造其内容）`); continue; }
      if (r.type === 'job') {
        const j = r.data;
        L.push(`[context:job:${j.id}] 来源=${j.source === 'inbox' ? '收件箱' : j.source === 'app' ? '投递记录' : '评估'}「${clip(j.title, 60)}」公司=${j.company || '?'} 岗位=${j.role || '?'}${j.salary ? ` 薪资=${j.salary}` : ''}${(j.statusLabel || j.status) ? ` 状态=${j.statusLabel || j.status}` : ''}${j.score != null ? ` 评分=${j.score}` : ''}${j.dueDate ? ` 截止=${j.dueDate}` : ''}${j.url ? ` 申请链接=${j.url}` : ' 无申请链接'}`);
        if (j.jd) L.push(`  JD 摘要：${j.jd}`);
      } else {
        const d = r.data;
        L.push(`[context:doc:${d.id}] 简历「${d.title}」类型=${d.kind === 'job' ? '岗位定制' : '母版'}${d.company ? ` 公司=${d.company}` : ''}${d.role ? ` 岗位=${d.role}` : ''}${d.archived ? '（已归档）' : ''}`);
        if (d.excerpt) L.push(`  正文摘要：${d.excerpt}`);
      }
    }
  }
  return L.join('\n');
}

// ===== Server 侧真实工具（对照 UPCV §5 工具集：job-detail / job-progress-query / resume-list）=====
// 契约：模型输出 {"toolCalls":[{"name,"args"}]} → 本层执行 → {ok:…} 结果 JSON 回灌下一轮 system【工具结果】区。
//   纪律：白名单参数校验（未知字段/非法值 → ok:false 中文错）；全部只读（零落盘）；单调用 30s 超时兜底。
//   错误对象 {ok:false, code:'BAD_ARGS'|'NOT_FOUND'|'TIMEOUT'|'ERROR', error:'中文'}——
//   概念上的 400/404 不进 HTTP 层（工具调用发生在流内），原样回灌给模型如实转告用户。
const docIdsOnDisk = () => {
  try {
    return fs.readdirSync(path.join(R(), 'docs'))
      .filter((f) => f.endsWith('.html') && !f.startsWith('.'))
      .map((f) => f.slice(0, -'.html'.length))
      .filter((id) => ID_RE.test(id))   // 口径同 server.mjs VALID_ID + 必须是普通文件（同名目录 readFileSync 会炸）
      .filter((id) => { try { return fs.statSync(docFile(id)).isFile(); } catch { return false; } });
  } catch { return []; }
};
const toolErr = (code, error) => ({ ok: false, code, error });
// 白名单校验：args 必须是普通对象；字段集合 ⊆ allowed；required 里的键非空。通过回 null，不通过回 toolErr。
function argCheck(name, args, allowed, required = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolErr('BAD_ARGS', `参数错误：${name} 的 args 必须是对象`);
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) return toolErr('BAD_ARGS', `参数错误：${name} 不支持字段 ${extra.join('、')}（允许：${allowed.join('、') || '无'}）`);
  for (const k of required) {
    if (args[k] === undefined || args[k] === null || args[k] === '') return toolErr('BAD_ARGS', `参数错误：${name} 缺必填字段 ${k}`);
  }
  return null;
}
function toolGetJobDetail(args) {
  const bad = argCheck('get_job_detail', args, ['ref', 'id'], ['ref', 'id']);
  if (bad) return bad;
  const ref = String(args.ref);
  if (!['inbox', 'app', 'eval'].includes(ref)) return toolErr('BAD_ARGS', `参数错误：ref 只能是 inbox/app/eval（收到 ${clip(ref, 20) || '空'}）`);
  const id = String(args.id);
  if (!TOOL_ARG_ID.test(id)) return toolErr('BAD_ARGS', '参数错误：id 格式非法');
  const it = (ref === 'inbox' ? loadInbox() : ref === 'app' ? loadApps() : loadEvals()).find((x) => x && x.id === id);
  const srcLabel = ref === 'inbox' ? '收件箱' : ref === 'app' ? '投递记录' : '评估';
  if (!it) return toolErr('NOT_FOUND', `${srcLabel}里没有 id=${id} 的岗位`);
  const v = ref === 'inbox' ? inboxView(it) : ref === 'app' ? appView(it) : evalView(it);
  const { jd, ...rest } = v;
  return { ok: true, ref, ...rest, ...(jd ? { jdExcerpt: jd } : {}) };
}
function toolQueryJobProgress(args) {
  const bad = argCheck('query_job_progress', args, ['status']);
  if (bad) return bad;
  let filter = null;
  if (args.status !== undefined && args.status !== null && args.status !== '') {
    filter = appStatusArg(args.status);
    if (!filter) return toolErr('BAD_ARGS', `参数错误：status 非法（允许：${APP_STATUS_ALL.join(' / ')} 或中文标签，收到 ${clip(String(args.status), 20)}）`);
  }
  const apps = loadApps().filter(Boolean);
  const norm = (a) => appStatusEnum(a.status);
  const brief = (a) => ({
    id: a.id, company: a.company || '', role: a.role || '', status: norm(a), statusLabel: appStatusLabel(norm(a)),
    appliedAt: a.appliedAt || '', dueDate: a.dueDate || '', nextStep: a.nextStep || '', docId: a.docId || ''
  });
  const byStatus = {};
  for (const s of APP_STATUS_ALL) byStatus[s] = 0;
  for (const a of apps) byStatus[norm(a)] += 1;
  // 近 7 日到期：dueDate ≤ 今天+7 天（含已逾期，overdue 标出）；按截止升序，封顶 20 条
  const now = Date.now(), horizon = now + 7 * 24 * 3600 * 1000;
  const dueSoon = apps
    .filter((a) => a.dueDate && !Number.isNaN(new Date(a.dueDate).getTime()) && new Date(a.dueDate).getTime() <= horizon)
    .sort((x, y) => new Date(x.dueDate).getTime() - new Date(y.dueDate).getTime())
    .slice(0, 20)
    .map((a) => ({ ...brief(a), overdue: new Date(a.dueDate).getTime() < now }));
  const out = {
    ok: true, total: apps.length, byStatus,
    byStatusLabel: Object.fromEntries(APP_STATUS_ALL.map((s) => [appStatusLabel(s), byStatus[s]])),
    dueSoonDays: 7, dueSoon
  };
  if (filter) {
    out.status = filter; out.statusLabel = appStatusLabel(filter);
    out.items = apps.filter((a) => norm(a) === filter).map(brief).slice(0, 30);
  }
  return out;
}
function toolListResumes(args) {
  const bad = argCheck('list_resumes', args, ['archived']);
  if (bad) return bad;
  const av = args.archived;
  if (av !== undefined && av !== true && av !== false && av !== 'all') {
    return toolErr('BAD_ARGS', `参数错误：archived 只能是 true/false/"all"（收到 ${clip(String(av), 20)}）`);
  }
  const meta = loadMeta();
  const items = docIdsOnDisk().map((id) => {
    const m = meta[id] || {};
    let updatedAt = '';
    try { updatedAt = fs.statSync(docFile(id)).mtime.toISOString(); } catch { /* 竞态删除：留空 */ }
    return {
      id, title: docTitleOf(readDoc(id), id), theme: m.theme || '', kind: m.kind || 'master',
      company: m.company || '', role: m.role || '', tag: m.tag || '', archived: !!m.archivedAt, updatedAt
    };
  });
  const filtered = (av === 'all' ? items : items.filter((d) => d.archived === !!av))
    .sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  return { ok: true, total: filtered.length, archived: av === undefined ? false : av, items: filtered.slice(0, 50) };
}
function toolGetResumeSummary(args) {
  const bad = argCheck('get_resume_summary', args, ['docId'], ['docId']);
  if (bad) return bad;
  const id = String(args.docId);
  if (!TOOL_ARG_ID.test(id)) return toolErr('BAD_ARGS', '参数错误：docId 格式非法');
  const html = readDoc(id);
  if (html == null) return toolErr('NOT_FOUND', `没有 id=${id} 的简历文档（用 list_resumes 拿真实 id）`);
  const m = loadMeta()[id] || {};
  // 章节口径复用 extract.mjs sectionsOf（class="section" 块 + .section-title）
  const sections = sectionsOf(html).slice(0, 40).map((s) => ({ title: s.title || '（无标题）', hidden: !!s.hidden }));
  // 无 section 结构的文档（如 PDF 降级稿）：退到 h2/h3 标题凑目录
  let headings = [];
  if (!sections.length) {
    const re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi;
    let mm;
    while ((mm = re.exec(html)) && headings.length < 20) {
      const t = mm[1].replace(/<[^>]*>/g, '').trim();
      if (t) headings.push(clip(t, 40));
    }
  }
  const lines = docToLines(html, { includeHidden: false });
  return {
    ok: true, id, title: docTitleOf(html, id), kind: m.kind || 'master', theme: m.theme || '',
    company: m.company || '', role: m.role || '', tag: m.tag || '', archived: !!m.archivedAt,
    sectionCount: sections.length, sections, ...(headings.length ? { headings } : {}),
    lineCount: lines.length, preview: lines.slice(0, 8).map((l) => clip(l, 80))
  };
}
const TOOL_DEFS = {
  get_job_detail: { run: toolGetJobDetail },
  query_job_progress: { run: toolQueryJobProgress },
  list_resumes: { run: toolListResumes },
  get_resume_summary: { run: toolGetResumeSummary }
};
function runTool(name, args) {
  const def = TOOL_DEFS[name];
  if (!def) return toolErr('BAD_ARGS', `未知工具：${clip(String(name), 40)}（可用：${Object.keys(TOOL_DEFS).join('、')}）`);
  try { return def.run(args); } catch (e) { return toolErr('ERROR', '工具执行失败：' + clip(String((e && e.message) || e), 120)); }
}
// 30s 超时兜底：现工具全是同步读盘（远快于上限），race 主要为契约与未来异步工具预留
function runToolTimed(name, args) {
  let t;
  const timeout = new Promise((res) => {
    t = setTimeout(() => res(toolErr('TIMEOUT', `工具 ${name} 执行超时（${TOOL_TIMEOUT_MS / 1000} 秒）`)), TOOL_TIMEOUT_MS);
    if (t && typeof t.unref === 'function') t.unref();
  });
  return Promise.race([Promise.resolve().then(() => runTool(name, args)), timeout])
    .then((r) => { clearTimeout(t); return r; });
}

// ===== Prompt 策略（UPCV 泄露手册本地化：先判断+动作、quickReplies、不代投、不代记、防编造）=====
const AGENT_SYSTEM = `你是「简历工作台」内置的本地求职助手。只能使用【事实】区、【工具结果】区与对话中出现过的信息作答：绝不编造公司、岗位、薪资、数字、链接、投递状态或用户经历；材料不足时先列出要问用户的问题。

输出协议：每轮只输出一个 JSON 对象（不要其它文字、不要 Markdown 围栏），二选一：
A. 需要先查数据 → {"toolCalls":[{"name":"工具名","args":{…}}]}
   本轮不给最终答复；可同时带 "reply":"我先查一下…" 一句过渡（会展示给用户）。
B. 直接回复 → {"reply":"正文：先给判断+动作，再给依据；中文，简洁，可分短段",
 "quickReplies":[{"label":"≤12字","message":"用户点选后要发给你的完整消息","description":"可选，一句话说明"}],
 "toolRefs":[{"type":"job或doc","id":"你在 reply 中引用过的真实 id"}]}
工具执行结果会以 JSON 出现在下一轮的【工具结果】区，据实作答。同一问题最多 3 轮：拿到结果就回复，不要反复调同一个工具。quickReplies 固定给 2-3 条最可能的下一步；toolRefs 只允许引用【事实】/【工具结果】区出现过的 id，没有就给 []。

【可用工具】（全部只读；args 只许填列出的字段；不知道 id 就先查列表，别猜）
- get_job_detail {"ref":"inbox|app|eval","id":"…"}：按来源查一个岗位详情（inbox=收件箱、app=投递记录、eval=评估），回公司/岗位/状态/评分/截止/JD 摘要。问「这个岗位详情/值不值得投」时用。
- query_job_progress {"status":"可选"}：投递进度汇总——六态聚合计数 + 近 7 日到期列表；status 可填 to_apply/preparing/applied/replied/interviewing/offer/closed 或中文标签。问「投递进度/哪些快截止/某状态有哪些」时用。
- list_resumes {"archived":可选}：列简历文档（id/标题/主题/类型）；archived 缺省=只列在用的，true=只列已归档，"all"=全部。问「我有哪些简历」时用。
- get_resume_summary {"docId":"…"}：读一份简历的结构——标题/章节清单/行数/开头预览。问「某份简历内容/结构」时用。

策略（必须遵守）：
1. 投递前必须有简历。【事实】显示没有任何简历时：先引导用户去首页新建简历或导入 PDF，不讨论投递细节（硬阻塞）。
2. 岗位缺申请链接时：先和用户核对「同一岗位、招聘主体、地点、批次」，确认后才建议用户去官网/招聘平台自行搜索；你不替他拼 URL。
3. 本平台不代投：你只给网申链接与材料清单，由用户自己去网站提交。
4. 用户明确说「帮我记一笔投递/我已投递」才引导他去「投递」页登记；你不替他写任何投递记录。
5. 不夸大、不承诺结果；简历里没有的事实让用户先补充再写。
6. 工具回 {"ok":false} 时，把 error 如实转告用户（如「投递记录里没有这个 id」），不要编造结果或换个 id 重试超过一次。`;

// ===== 回复解析（坏输出降级为纯文本回复）=====
function parseAgentReply(raw) {
  try {
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const d = JSON.parse(cleaned);
    if (!d || typeof d.reply !== 'string' || !d.reply) return { reply: String(raw), quickReplies: [], toolRefs: [] };
    const qr = (Array.isArray(d.quickReplies) ? d.quickReplies : [])
      .filter((q) => q && typeof q.label === 'string' && typeof q.message === 'string' && q.label && q.message)
      .slice(0, 3)
      .map((q) => ({
        label: q.label.slice(0, 20), message: q.message.slice(0, 300),
        ...(typeof q.description === 'string' && q.description ? { description: q.description.slice(0, 60) } : {})
      }));
    const tr = (Array.isArray(d.toolRefs) ? d.toolRefs : [])
      .map((t) => {
        if (!t || typeof t.id !== 'string') return null;
        const ty = String(t.type || '');
        const type = (ty === 'job' || ty === 'job-detail') ? 'job' : (ty === 'doc' || ty === 'resume-card') ? 'doc' : null;
        return type && /^[A-Za-z0-9_-]{1,90}$/.test(t.id) ? { type, id: t.id } : null;
      })
      .filter(Boolean);
    return { reply: d.reply, quickReplies: qr, toolRefs: tr };
  } catch {
    return { reply: String(raw), quickReplies: [], toolRefs: [] };
  }
}

// ===== 轮次解析（工具环契约）：模型每轮要么 toolCalls 要么 reply =====
// {"toolCalls":[{name,args}]}（可带过渡 "reply"）→ 工具路径；其余一律按 parseAgentReply 走回复路径。
// toolCalls 条数超 TOOL_CALL_CAP 的尾部丢弃（dropped 记数，回灌告知）；单条调用缺 name/args
// 不在这里拦——丢给 runTool 出 BAD_ARGS，错误结果照样回灌让模型自己修正。
function parseAgentTurn(raw) {
  try {
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const d = JSON.parse(cleaned);
    if (d && Array.isArray(d.toolCalls) && d.toolCalls.length) {
      const calls = d.toolCalls.slice(0, TOOL_CALL_CAP).map((c) => ({
        name: (c && typeof c.name === 'string') ? c.name : '',
        args: (c && c.args && typeof c.args === 'object' && !Array.isArray(c.args)) ? c.args : {}
      }));
      const parsed = parseAgentReply(raw);   // quickReplies/toolRefs 清洗复用同一口径
      // reply 只认 d.reply 本身是字符串的情形——纯 toolCalls 输出下 parseAgentReply 会把整段 JSON 当 reply
      return {
        toolCalls: calls, dropped: Math.max(0, d.toolCalls.length - TOOL_CALL_CAP),
        reply: (typeof d.reply === 'string' && d.reply) ? parsed.reply : '',
        quickReplies: parsed.quickReplies, toolRefs: parsed.toolRefs
      };
    }
  } catch { /* 非 JSON / 无 toolCalls → 回复路径 */ }
  return { toolCalls: [], dropped: 0, ...parseAgentReply(raw) };
}

// 模型没给/给不够时的兜底下一步（按事实状态选）
function defaultReplies() {
  if (!listResumes().length) {
    return [
      { label: '新建简历', message: '我想从零新建一份简历，告诉我入口和步骤' },
      { label: '导入 PDF', message: '我有一份 PDF 简历，告诉我怎么导入' }
    ];
  }
  if (loadInbox().some((x) => x && x.status === 'new')) {
    return [
      { label: '评估收件箱', message: '评估收件箱里现在的岗位，告诉我哪些值得推进' },
      { label: '看今天的截止', message: '看看今天有哪些投递临近截止或需要跟进' }
    ];
  }
  return [
    { label: '帮我改简历', message: '帮我看看现在的简历还能怎么改' },
    { label: '看今天的截止', message: '看看今天有哪些投递临近截止或需要跟进' }
  ];
}
function ensureReplies(qr) {
  const out = qr.slice(0, 3);
  for (const d of defaultReplies()) {
    if (out.length >= 2) break;
    if (!out.some((q) => q.message === d.message)) out.push(d);
  }
  return out;
}

// ===== 引用展示卡（渲染层协议：{type:'job-detail'|'resume-card', payload}）=====
// 来源 = 上下文引用 [context:…] + 模型 toolRefs，不是工具执行——与真实工具 part（tool-<name> 带 toolCallId）分工不同。
function buildToolCards(ctxResolved, toolRefs) {
  const cards = [], seen = new Set();
  const pushJob = (j) => {
    if (!j || seen.has('job:' + j.id)) return;
    seen.add('job:' + j.id);
    const { jd, ...rest } = j;
    cards.push({ type: 'job-detail', payload: rest });
  };
  const pushDoc = (d) => {
    if (!d || seen.has('doc:' + d.id)) return;
    seen.add('doc:' + d.id);
    const { excerpt, ...rest } = d;
    cards.push({ type: 'resume-card', payload: rest });
  };
  for (const r of ctxResolved) { if (r.data) (r.type === 'job' ? pushJob : pushDoc)(r.data); }
  for (const t of toolRefs) { (t.type === 'job' ? pushJob : pushDoc)(t.type === 'job' ? resolveJob(t.id) : resolveDoc(t.id)); }
  return cards;
}

// ===== UIMessage 形状（UPCV §5 / AI SDK v5）：{id,role,parts:[...],metadata:{createdAt,tokenCount}} =====
// parts 按时间序记录：step-start 开场 → [工具轮：过渡 text? + tool-<name>{toolCallId,state:'call'→'output-available',input,output}]*
//   → text 正文 → tool-job-detail/tool-resume-card 引用卡 → tool-ui-quickReplies 选项。
const textOf = (m) => {
  if (!m || typeof m !== 'object') return '';
  if (typeof m.text === 'string') return m.text;   // 老格式 {role,text}
  const ps = Array.isArray(m.parts) ? m.parts : [];
  return ps.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('');
};
const cardPart = (c) => ({ type: 'tool-' + c.type, input: { id: (c.payload && c.payload.id) || '' }, state: 'output-available', output: c.payload });
const qrPart = (options) => ({ type: 'tool-ui-quickReplies', input: {}, state: 'output-available', output: { options } });
function assistantMsgOf({ parts, usage, aborted, rounds }) {
  const metadata = { createdAt: nowIso(), tokenCount: (usage && typeof usage.total === 'number') ? usage.total : null };
  if (rounds > 1) metadata.rounds = rounds;   // 工具环实际跑的模型轮数（单轮回复不记，与旧消息同形）
  if (aborted) metadata.aborted = true;   // 断连截断的部分正文：诚实标记，不假装完整回复
  return { id: newId('m'), role: 'assistant', parts, metadata };
}
const userMsgOf = (text, refs) => ({
  id: newId('m'), role: 'user', parts: [{ type: 'text', text }],
  metadata: { createdAt: nowIso(), ...(refs && refs.length ? { refs } : {}) }
});
// UIMessage → 老响应字段（chat() 非流式兼容 + 面板兜底渲染共用口径）
const qrOfMsg = (m) => {
  const p = (Array.isArray(m && m.parts) ? m.parts : []).find((x) => x && x.type === 'tool-ui-quickReplies');
  return (p && p.output && Array.isArray(p.output.options)) ? p.output.options : [];
};
const cardsOfMsg = (m) => (Array.isArray(m && m.parts) ? m.parts : [])
  .filter((p) => p && typeof p.type === 'string' && p.type.startsWith('tool-') && p.type !== 'tool-ui-quickReplies' && p.state === 'output-available' && p.output)
  .map((p) => ({ type: p.type.slice(5), payload: p.output }));
// 读出归一：老 {role,text,quickReplies?,toolCards?,refs?,at} → UIMessage；新形状补 metadata 兜底
function msgToUI(m) {
  if (!m || typeof m !== 'object') return m;
  if (Array.isArray(m.parts)) {
    return { ...m, metadata: (m.metadata && typeof m.metadata === 'object') ? m.metadata : { createdAt: m.at || null } };
  }
  const createdAt = (m.metadata && m.metadata.createdAt) || m.at || null;
  if (m.role === 'assistant') {
    const parts = [{ type: 'step-start' }];
    if (typeof m.text === 'string' && m.text) parts.push({ type: 'text', text: m.text });
    for (const c of (Array.isArray(m.toolCards) ? m.toolCards : [])) { if (c && c.type && c.payload) parts.push(cardPart(c)); }
    if (Array.isArray(m.quickReplies) && m.quickReplies.length) parts.push(qrPart(m.quickReplies));
    return { id: m.id, role: 'assistant', parts, metadata: { createdAt, tokenCount: null } };
  }
  return {
    id: m.id, role: m.role || 'user', parts: [{ type: 'text', text: typeof m.text === 'string' ? m.text : '' }],
    metadata: { createdAt, ...(Array.isArray(m.refs) && m.refs.length ? { refs: m.refs } : {}) }
  };
}
// 追加写：重读列表再落盘（流式回复期间用户可能改名/删会话，不拿开流前的快照盖并发改动）
function appendMsg(sid, msg) {
  const list = loadSessions();
  const s = findSession(list, sid);
  if (!s) return false;
  s.messages = (s.messages || []).concat([msg]).slice(-MSG_CAP);
  s.updatedAt = nowIso();
  saveSessions(list);
  return true;
}

// ===== 增量 reply 提取 =====
// 模型输出是整段 JSON（{reply,quickReplies,toolRefs}）：流式把 reply 字符串的已到达部分解成
// 纯文本 delta；escape 序列没凑齐就等下一帧。非 JSON 输出按纯文本透传。
// 终值一律以 parseAgentReply(全文) 为准——finish 事件的 message 对账增量显示。
function replyExtractor() {
  let raw = '', mode = null, shown = '', done = false;
  // 从 {"reply":"<值>" 里把「值」已到达部分解码出来；{wait:true}=键还没到，null=不是 JSON
  function partial() {
    let s = raw.trimStart();
    if (s.startsWith('```')) { const i = s.indexOf('{'); if (i < 0) return { wait: true }; s = s.slice(i); }
    if (!s.startsWith('{')) return null;
    const m = /[{,]\s*"reply"\s*:\s*"/.exec(s);   // 前置 { 或 , 限定键位，避开字符串值里的同名文本
    if (!m) return { wait: true };
    let i = m.index + m[0].length, out = '';
    for (; i < s.length;) {
      const c = s[i];
      if (c === '"') return { text: out, complete: true };
      if (c === '\\') {
        if (i + 1 >= s.length) break;   // 半个 escape：等下一帧
        const n = s[i + 1];
        if (n === 'u') {
          if (i + 5 >= s.length) break;
          const cp = parseInt(s.slice(i + 2, i + 6), 16);
          if (!Number.isNaN(cp)) out += String.fromCharCode(cp);
          i += 6; continue;
        }
        out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' })[n] ?? n;
        i += 2; continue;
      }
      out += c; i++;
    }
    return { text: out, complete: false };
  }
  return {
    push(chunk) {
      raw += chunk;
      if (done) return '';
      if (mode == null) {
        const t = raw.trimStart();
        if (!t) return '';
        mode = (t[0] === '{' || t.startsWith('```')) ? 'json' : 'plain';
        if (mode === 'plain') { shown = raw; return raw; }
      }
      if (mode === 'plain') { const d = raw.slice(shown.length); shown = raw; return d; }
      const r = partial();
      // 防御分支（实际不可达：json 模式要求首字符 { 或 ```）：先前猜 JSON 实际不是 →
      // 转纯文本但不再补发已解码内容，防重复；终值由 finish 对账。
      if (!r) { mode = 'plain'; shown = raw; return ''; }
      if (r.complete) done = true;
      if (r.wait || r.text.length <= shown.length) return '';
      const d = r.text.slice(shown.length); shown = r.text; return d;
    },
    raw: () => raw,
    shown: () => shown
  };
}

// ===== chatStream：流式主入口 → UIMessage 事件流（多轮工具环）=====
// 产出序列：{type:'tool-part',part{state:'call'→'output-available'}}* → {type:'text-delta',delta}*
//   → {type:'finish',message:<完整 assistant UIMessage>}。
// 工具环：模型每轮输出二选一（契约写在 AGENT_SYSTEM）——
//   {"toolCalls":[{name,args}]} → server 侧真实执行 → 结果回灌下一轮 system【工具结果】区；
//   {"reply",quickReplies,toolRefs} → 收尾落盘。轮数封顶 TOOL_ROUND_MAX=3 防死循环；
//   封顶轮仍只要工具 → 调用照执行入档，补一句系统兜底 text（诚实标注，不冒充模型）。
// 校验/模型错误仍按 throw 抛出（路由在写 SSE 头之前先拉首帧，可回 HTTP 错误码；
//   已进入流的错误由路由转 {type:'error',errorText} 帧）。
// 持久化两段式：用户条先落盘（模型失败/断连也会话里留住提问），助手条在 finish 落盘。
//   parts 按时间序记录；工具 part 只落 'output-available' 终态（'call' 是 SSE 实况帧的过程态）。
// 提前终止（路由断连调 it.return()）：for-await 把 return 透传给 streamChatMsgs →
//   其 finally unclaim 租约（AI 槽按 llm.mjs 口径释放）；已收工具 parts+已显示正文按 aborted 落盘。
// ctx（可选）：{ lease, profile, meta } 原样透传 llm.mjs（池化/租约/档案语义不变）；
//   同一 lease 顺序 claim/unclaim 多轮合法（resource-slots claim 合同③只管并发占用）。
export async function* chatStream(id, message, ctx = {}) {
  const list = loadSessions();
  const s = (ID_RE.test(String(id || '')) && findSession(list, String(id))) || null;
  if (!s) { const e = new Error('会话不存在'); e.code = 'NO_SESSION'; throw e; }
  const raw = String(message || '');
  const text = stripContextRefs(raw) || raw.trim();
  if (!text) { const e = new Error('消息不能为空'); e.code = 'EMPTY'; throw e; }
  // 上下文注入：解析消息前缀 → 读仓内数据 → 拼进 system（不走消息体）
  const refs = parseContextRefs(raw);
  const ctxResolved = refs.map((r) => ({ ...r, data: r.type === 'job' ? resolveJob(r.id) : resolveDoc(r.id) }));
  // 历史只取一次：多轮工具环共享同一份对话（每轮只重拼 system 的【工具结果】区）
  const hist = [];
  for (const m of (s.messages || []).slice(-HIST_CAP)) {
    const t = textOf(m);
    if (m && (m.role === 'user' || m.role === 'assistant') && t) hist.push({ role: m.role, content: t });
  }
  // ① 用户条先落盘（UIMessage）；首条用户消息自动命名（默认名才覆盖）
  const at = nowIso();
  s.messages = (s.messages || []).concat([userMsgOf(text, refs)]).slice(-MSG_CAP);
  if (s.title === '新会话' && s.messages.filter((m) => m.role === 'user').length === 1) {
    s.title = clip(text, 18) || s.title;
  }
  s.updatedAt = at;
  saveSessions(list);
  // A3 快照接缝（UPCV #2）：建简历意图（或已有未完成草稿）→ 服务端草稿现场 UPSERT；普通会话零写入（draft.mjs 内判定）。
  // 账本损坏时吞错：对话主流程不因快照账本炸断，坏账本由 /api/resume-creation/* 读侧如实报 CORRUPT。
  try { agentDraftTick(R(), s.id, text, hist); } catch { /* 快照现场失败不放大为对话故障 */ }
  // ② 工具环主循环
  const meta = (ctx.meta && typeof ctx.meta === 'object') ? ctx.meta : {};
  const parts = [{ type: 'step-start' }];
  const toolFacts = [];
  const usageSum = { prompt: 0, completion: 0, total: 0 };   // 多轮合计（llm 每轮覆盖写 meta.usage，逐轮快照累加）
  let usageSeen = false, rounds = 0, finished = false, lastEx = null, replyCommitted = false;
  const usageOf = () => ({ total: usageSeen ? usageSum.total : null });
  try {
    for (let round = 1; round <= TOOL_ROUND_MAX; round++) {
      rounds = round;
      replyCommitted = false;
      let sys = AGENT_SYSTEM + '\n\n【事实】\n' + factsBlock(ctxResolved);
      if (toolFacts.length) sys += '\n\n【工具结果】\n' + toolFacts.join('\n');
      if (round === TOOL_ROUND_MAX) sys += '\n\n【注意】这是本消息的最后一次作答机会：请直接输出 reply 总结已有信息，不要再发 toolCalls。';
      const msgs = [{ role: 'system', content: sys }, ...hist, { role: 'user', content: text }];
      const ex = replyExtractor();
      lastEx = ex;
      for await (const chunk of streamChatMsgs(R(), msgs, { lease: ctx.lease, meta, profile: ctx.profile })) {
        const d = ex.push(chunk);
        if (d) yield { type: 'text-delta', delta: d };
      }
      if (meta.usage) {
        usageSeen = true;
        usageSum.prompt += meta.usage.prompt || 0;
        usageSum.completion += meta.usage.completion || 0;
        usageSum.total += meta.usage.total || 0;
      }
      const turn = parseAgentTurn(ex.raw());
      if (turn.toolCalls.length) {
        // —— 工具路径：同帧 "reply" 是过渡句（已流式给用户，按时间序排在工具卡之前入档）——
        if (turn.reply) { parts.push({ type: 'text', text: turn.reply }); replyCommitted = true; }
        const results = [];
        for (const call of turn.toolCalls) {
          const p0 = { type: 'tool-' + clip(String(call.name || '?'), 40), toolCallId: newId('tc'), state: 'call', input: call.args };
          yield { type: 'tool-part', part: p0 };
          const output = await runToolTimed(call.name, call.args);
          const p1 = { ...p0, state: 'output-available', output };
          parts.push(p1);
          yield { type: 'tool-part', part: p1 };
          results.push({ name: p0.type.slice(5), args: call.args, output });
        }
        for (const r of results) toolFacts.push(`- ${r.name}(${JSON.stringify(r.args)}) → ${clip(JSON.stringify(r.output), TOOL_FACT_CLIP)}`);
        if (turn.dropped) toolFacts.push(`（另有 ${turn.dropped} 条 toolCalls 超单轮上限 ${TOOL_CALL_CAP} 未执行）`);
        if (round < TOOL_ROUND_MAX) continue;   // 下一轮：system 带上【工具结果】重问
        // 封顶轮仍只要工具：调用已执行入档但模型没给答复 → 系统兜底句（诚实标注，不冒充模型输出）
        if (!turn.reply) parts.push({ type: 'text', text: '已到最大检索轮数。以上是刚查到的结果，需要我据此继续分析请再发一句。' });
      } else {
        parts.push({ type: 'text', text: turn.reply });
        replyCommitted = true;
      }
      // —— 收尾（reply 路径与封顶轮共用）：上下文/引用卡 + quickReplies 兜底 + finish 对账 ——
      const toolCards = buildToolCards(ctxResolved, turn.toolRefs);
      const quickReplies = ensureReplies(turn.quickReplies);
      for (const c of toolCards) parts.push(cardPart(c));
      if (quickReplies.length) parts.push(qrPart(quickReplies));
      const msg = assistantMsgOf({ parts, usage: usageOf(), rounds: round });
      appendMsg(s.id, msg);
      finished = true;
      yield { type: 'finish', message: msg };
      return;
    }
  } finally {
    // 断连/上游错误：已收工具 parts + 最后一段可见正文按 aborted 落盘（不假装完整）。
    // replyCommitted=本轮文本已进 parts（断在工具执行段）→ 不再追加 shown，防同一文本记两遍。
    if (!finished && lastEx && (lastEx.shown() || parts.length > 1)) {
      try {
        const p2 = parts.slice();
        if (lastEx.shown() && !replyCommitted) p2.push({ type: 'text', text: lastEx.shown() });
        appendMsg(s.id, assistantMsgOf({ parts: p2, usage: usageOf(), aborted: true, rounds }));
      } catch { /* 损坏停写/会话已删：断连清理不放大故障 */ }
    }
  }
}

// ===== chat：非流式兼容入口（无 stream 参数的旧路由/调用方零改动）=====
// 内部 drain chatStream：响应形状不变 {reply,quickReplies,toolCards,sessionId}。
export async function chat(id, message, ctx = {}) {
  let finalMsg = null;
  for await (const ev of chatStream(id, message, ctx)) {
    if (ev && ev.type === 'finish' && ev.message) finalMsg = ev.message;
  }
  if (!finalMsg) { const e = new Error('模型调用失败：未产出完整回复'); e.code = 'NO_FINISH'; throw e; }
  return { reply: textOf(finalMsg), quickReplies: qrOfMsg(finalMsg), toolCards: cardsOfMsg(finalMsg), sessionId: String(id) };
}
