// agent.mjs — 「Agent 求职助手」会话与编排（本地版）。
// 协议参照 docs/upcv-features-implementation.md §5（UPCV Agent）：
//   会话管理 · [context:doc|job:<id>] 上下文注入 · toolCard/quickReplies 下发 · 泄露策略手册本地化。
// 数据根注入：server.mjs 启动时调一次 init(root)（root = RESUME_ROOT，与数据文件同口径）。
// 读：docs-meta.json / docs/<id>.html / inbox.json / applications.json / evaluations.json（只读）。
// 写：仅 agent-sessions.json —— 与 server.mjs 同口径（tmp+rename、0600、形状校验、损坏停写）。
// 调用层：llm.mjs chatMsgs（profile 选择、aiPool 池化、租约都在那里）；
//   ai.mjs 只导出 prompt 构建/解析纯函数，本文件按同款模式把 Agent 的 prompt 与解析内聚在此处。
// TODO(stream)：chat() 目前非流式（等整段回复）。接流式时：llm.mjs 需加 stream 透传，
//   本层改为产出 UIMessage 事件流（text delta → done{quickReplies,toolCards}），
//   路由改 SSE（参考 UPCV POST /api/agent-chat/chat）。

import fs from 'node:fs';
import path from 'node:path';
import { chatMsgs } from './llm.mjs';
import { docToText } from './extract.mjs';

export const AGENT_NO_LLM = '未配置大模型：打开 /settings 完成模型配置';
const AGENT_FILE = 'agent-sessions.json';
const SESS_CAP = 100;      // 会话总数上限（超出裁最旧）
const MSG_CAP = 200;       // 单会话持久化消息上限
const HIST_CAP = 12;       // 发给模型的最近消息条数（上下文窗口控制）
const REF_CAP = 4;         // 单条消息解析的上下文引用上限
const JD_EXCERPT = 800;    // 注入 system 的 JD 摘要长度
const DOC_EXCERPT = 1200;  // 注入 system 的简历正文摘要长度
const ID_RE = /^[a-z0-9][a-z0-9-]{0,90}$/;

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
  lastText: clip(((s.messages || [])[(s.messages || []).length - 1] || {}).text || '', 40)
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
  return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages || [] };
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
function resolveJob(id) {
  const s = String(id);
  const ib = loadInbox().find((x) => x && x.id === s);
  if (ib) return inboxView(ib);
  const ap = loadApps().find((x) => x && x.id === s);
  if (ap) {
    return {
      source: 'app', id: ap.id, title: `${ap.company || ''}·${ap.role || ''}`, company: ap.company || '',
      role: ap.role || '', salary: '', url: ap.link || '', status: ap.status || '',
      appliedAt: ap.appliedAt || '', dueDate: ap.dueDate || '', nextStep: ap.nextStep || '', docId: ap.docId || '',
      jd: String(ap.jd || '').slice(0, JD_EXCERPT)
    };
  }
  const ev = loadEvals().find((x) => x && x.id === s);
  if (ev) {
    return {
      source: 'eval', id: ev.id, title: `${ev.company || ''}·${ev.role || ''}`, company: ev.company || '',
      role: ev.role || '', salary: '', url: '', status: '评估', score: ev.score ?? null,
      verdict: ev.verdict || '', jd: String(ev.jd || '').slice(0, JD_EXCERPT)
    };
  }
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
function factsBlock(ctxResolved) {
  const resumes = listResumes();
  const inbox = loadInbox().filter((x) => x && x.status !== 'dismissed');
  const fresh = inbox.filter((x) => x.status === 'new');
  const apps = loadApps();
  const now = Date.now();
  // 临近截止口径同投递页：dueDate 距今 <48h（含已逾期 24h 内）
  const due = apps.filter((a) => a && a.dueDate && (new Date(a.dueDate).getTime() - now) < 48 * 3600 * 1000);
  const byStatus = {};
  for (const a of apps) { if (a) byStatus[a.status || '未填'] = (byStatus[a.status || '未填'] || 0) + 1; }
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
    L.push(`- 临近截止 id=${a.id}「${a.company || ''}·${a.role || ''}」截止=${a.dueDate} 状态=${a.status || ''}${a.nextStep ? ` 下一步=${a.nextStep}` : ''}`);
  }
  if (ctxResolved.length) {
    L.push('【本条消息引用的上下文】');
    for (const r of ctxResolved) {
      if (!r.data) { L.push(`[context:${r.type}:${r.id}] → 未找到该 id（不要编造其内容）`); continue; }
      if (r.type === 'job') {
        const j = r.data;
        L.push(`[context:job:${j.id}] 来源=${j.source === 'inbox' ? '收件箱' : j.source === 'app' ? '投递记录' : '评估'}「${clip(j.title, 60)}」公司=${j.company || '?'} 岗位=${j.role || '?'}${j.salary ? ` 薪资=${j.salary}` : ''}${j.status ? ` 状态=${j.status}` : ''}${j.score != null ? ` 评分=${j.score}` : ''}${j.dueDate ? ` 截止=${j.dueDate}` : ''}${j.url ? ` 申请链接=${j.url}` : ' 无申请链接'}`);
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

// ===== Prompt 策略（UPCV 泄露手册本地化：先判断+动作、quickReplies、不代投、不代记、防编造）=====
const AGENT_SYSTEM = `你是「简历工作台」内置的本地求职助手。只能使用【事实】区与对话中出现过的信息作答：绝不编造公司、岗位、薪资、数字、链接、投递状态或用户经历；材料不足时先列出要问用户的问题。

输出协议：只输出 JSON（不要其它文字、不要 Markdown 围栏）：
{"reply":"正文：先给判断+动作，再给依据；中文，简洁，可分短段",
 "quickReplies":[{"label":"≤12字","message":"用户点选后要发给你的完整消息","description":"可选，一句话说明"}],
 "toolRefs":[{"type":"job或doc","id":"你在 reply 中引用过的真实 id"}]}
quickReplies 固定给 2-3 条最可能的下一步；toolRefs 只允许引用【事实】区出现过的 id，没有就给 []。

策略（必须遵守）：
1. 投递前必须有简历。【事实】显示没有任何简历时：先引导用户去首页新建简历或导入 PDF，不讨论投递细节（硬阻塞）。
2. 岗位缺申请链接时：先和用户核对「同一岗位、招聘主体、地点、批次」，确认后才建议用户去官网/招聘平台自行搜索；你不替他拼 URL。
3. 本平台不代投：你只给网申链接与材料清单，由用户自己去网站提交。
4. 用户明确说「帮我记一笔投递/我已投递」才引导他去「投递」页登记；你不替他写任何投递记录。
5. 不夸大、不承诺结果；简历里没有的事实让用户先补充再写。`;

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

// ===== 工具卡（渲染层协议：{type:'job-detail'|'resume-card', payload}；先出卡，不做工具调用循环）=====
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

// ===== chat：主入口 =====
// ctx（可选）：{ lease, profile, meta } 原样透传 llm.mjs chatMsgs（池化/租约/档案语义不变）。
export async function chat(id, message, ctx = {}) {
  const list = loadSessions();
  const s = (ID_RE.test(String(id || '')) && findSession(list, String(id))) || null;
  if (!s) { const e = new Error('会话不存在'); e.code = 'NO_SESSION'; throw e; }
  const raw = String(message || '');
  const text = stripContextRefs(raw) || raw.trim();
  if (!text) { const e = new Error('消息不能为空'); e.code = 'EMPTY'; throw e; }
  // 上下文注入：解析消息前缀 → 读仓内数据 → 拼进 system（不走消息体）
  const refs = parseContextRefs(raw);
  const ctxResolved = refs.map((r) => ({ ...r, data: r.type === 'job' ? resolveJob(r.id) : resolveDoc(r.id) }));
  const sys = AGENT_SYSTEM + '\n\n【事实】\n' + factsBlock(ctxResolved);
  const msgs = [{ role: 'system', content: sys }];
  for (const m of (s.messages || []).slice(-HIST_CAP)) {
    if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text) {
      msgs.push({ role: m.role, content: m.text });
    }
  }
  msgs.push({ role: 'user', content: text });
  const out = await chatMsgs(R(), msgs, { lease: ctx.lease, profile: ctx.profile, meta: ctx.meta });
  const parsed = parseAgentReply(out);
  const toolCards = buildToolCards(ctxResolved, parsed.toolRefs);
  const quickReplies = ensureReplies(parsed.quickReplies);
  // 持久化：用户条 + 助手条（卡片与选项随助手条落盘，刷新可回显）
  const at = nowIso();
  s.messages = (s.messages || []).concat([
    { id: newId('m'), role: 'user', text, refs, at },
    { id: newId('m'), role: 'assistant', text: parsed.reply, quickReplies, toolCards, at }
  ]).slice(-MSG_CAP);
  // 首条用户消息自动命名（默认名才覆盖）：刚 concat 后 user 条恰为第一条用户消息
  if (s.title === '新会话' && s.messages.filter((m) => m.role === 'user').length === 1) {
    s.title = clip(text, 18) || s.title;
  }
  s.updatedAt = at;
  saveSessions(list);
  return { reply: parsed.reply, quickReplies, toolCards, sessionId: s.id };
}
