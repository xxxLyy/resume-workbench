// practice.mjs — 练习会话数据层（批 4 · 卡片 b4c1）：出题（复用 kind=interview 产物）+ 逐题作答 + AI 对照证据表反馈
// 上位计划：dev-docs/2026-11-05-roadmap-batch-plan.md §5 批 4「面试练习包」；
// 本卡只管练习会话 API 层（投递详情/复盘页入口 UI、缺素材一键转待补充素材是后续卡）。
//
// 出题（零模型调用）：POST /app/practice/start 只读该投递关联岗位草稿的 meta.job.interview
//   （既有面试追问 kind=interview 产物，经 interviewSourceView 读视图）快照成练习会话，
//   链题顺带快照对应证据表要求行（req，仅当追问仍绑定当前证据批次）——**不新写一份出题规格**。
// 作答：qid 级文本作答（形状错即拒；重交 = 最近一次为准）。
// 反馈：走既有 genTasks 口径（followup.mjs 同款任务链路）——任务记录契约
//   { taskId, status, startedAt, stage, error, usage, model }；stage ∈ queued/calling/parsing（真实阶段，
//   无百分比）；完成判定复用 gen-result.mjs 的纯函数 completeGenResult（taskId 匹配 / TTL / 显式 ok /
//   迟到丢弃），只把「任务记录在哪」换成本会话的定位器。
//
// 诚实边界（计划 §5 原文口径）：
//   · 反馈结果形状 = { hit, missing, exaggeration, advice }——答到的事实 / 缺的指标 / 夸大倾向 /
//     逐题改进建议；**无评分、无百分位、无排名**（prompt 钉死 + 解析只认这四个字段，多一样就拒）。
//   · AI 反馈不直接改正文：反馈只落本机练习会话记录（app.practice），本模块没有任何写 docs/ 或
//     meta 正文维度的代码路径；作答在反馈期间被改 → 反馈不落账（批次隔离同款）。
//   · 历史随投递持久化：applications.json 既有账本的 app.practice（无新文件），最新在前截 20（F3 同款）；
//     挤出会话的迟到任务由 completeGenResult 的「找不到定位器 → dropped」兜住（零落账）。
//   · 无模型 / 无作答 / 无产物 → 明确拒绝（不留注定失败的 running 任务）。
import { randomBytes } from 'node:crypto';
import { chat } from './llm.mjs';
import { completeGenResult } from './gen-result.mjs';

export const PRACTICE_KIND = 'practiceFeedback';
// 历史上限：随投递截 20（计划 §5「复用 F3 模式」= /ai/prep 的 app.preps 同款：最新在前，slice(0,20)）。
export const PRACTICE_CAP = 20;
// 单题作答上限：一道面试题的口头回答转写，4000 字足够；与 JD 上限同理防账本被单请求撑爆。
export const ANSWER_MAX_CHARS = 4000;
// 任务级总时限：与既有 genTasks / followup 同口径（10 分钟）。
export const PRACTICE_TTL_MS = 10 * 60 * 1000;
// 无模型时的降级口径（接口共用同一句，避免两处措辞漂移）。
export const PRACTICE_NO_MODEL_HINT = '未配置大模型：不能生成练习反馈，可在设置页配置模型后重试';

const newPid = () => 'pr-' + randomBytes(4).toString('hex');
const newTaskId = () => 'pf-' + randomBytes(4).toString('hex');

// ===== 会话/题目/反馈盒的形状守卫（历史数据不可信：坏形状当无记录，与 F3 preps 同款口径）=====
export const practiceSessions = (app) =>
  (Array.isArray(app && app.practice) ? app.practice : [])
    .filter((s) => s && typeof s === 'object' && typeof s.pid === 'string' && s.pid);
export const findSession = (app, pid) => practiceSessions(app).find((s) => s.pid === pid) || null;
export const findQuestion = (session, qid) =>
  ((session && Array.isArray(session.questions) ? session.questions : [])
    .find((q) => q && typeof q === 'object' && q.qid === qid) || null);
const feedbackBoxOf = (session, qid) => {
  const fb = session && session.feedback && typeof session.feedback === 'object' && !Array.isArray(session.feedback)
    ? session.feedback : {};
  return (fb[qid] && typeof fb[qid] === 'object' && !Array.isArray(fb[qid])) ? fb[qid] : {};
};

// ===== 出题：既有面试追问产物 → 练习会话快照（纯函数，零 I/O、零模型）=====
// interviewView = interviewSourceView(interview, {paras}) 的读视图（每个要点的 sourceState 由程序判定，
// 不信模型自报）；bindingFresh = 追问是否仍绑定当前证据批次（与 server.mjs interviewStale 判定同口径）——
// 只有绑定时链题才快照对应要求行 req（批次换了 evIndex 就可能指向别的表，宁可 req=null 不硬凑）。
// 只收「有题面且至少一个要点」的题（与 runGenTaskInner 的有效追问口径一致）；一题都没有 → null。
export function buildPracticeSession({
  docId = '', company = '', role = '', interviewView,
  evidence = [], bindingFresh = false, interviewStale = false,
  interviewGen = null, evidenceGen = null, nowMs = Date.now(),
}) {
  const iv = interviewView && typeof interviewView === 'object' ? interviewView : {};
  const rows = Array.isArray(evidence) ? evidence : [];
  const questions = [];
  let n = 0;
  const push = (kind, c) => {
    const question = c && typeof c.question === 'string' ? c.question.trim() : '';
    const rawPoints = c && Array.isArray(c.answerPoints) ? c.answerPoints : [];
    const points = rawPoints
      .map((p) => (p && typeof p === 'object') ? {
        text: typeof p.text === 'string' ? p.text.trim() : '',
        quote: typeof p.quoteForDisplay === 'string' ? p.quoteForDisplay.trim() : '',   // 只收核验命中的引文（quoteForDisplay 空就是不展示）
        sourceState: typeof p.sourceState === 'string' ? p.sourceState : 'invalid',
        sourceZid: typeof p.sourceZid === 'string' ? p.sourceZid : '',
      } : null)
      .filter((p) => p && p.text);
    if (!question || !points.length) return;
    n++;
    const evIndex = (kind === 'chain' && c && Number.isInteger(c.evIndex)) ? c.evIndex : -1;
    const row = (kind === 'chain' && bindingFresh && evIndex >= 0 && evIndex < rows.length) ? rows[evIndex] : null;
    questions.push({
      qid: 'q' + n, kind, evIndex,
      req: (row && typeof row.req === 'string' && row.req.trim()) ? row.req.trim() : null,
      question,
      followUp: (c && typeof c.followUp === 'string') ? c.followUp.trim() : '',
      points,
    });
  };
  for (const c of (Array.isArray(iv.chains) ? iv.chains : [])) push('chain', c);
  for (const c of (Array.isArray(iv.generic) ? iv.generic : [])) push('generic', c);
  if (!questions.length) return null;
  return {
    pid: newPid(), createdAt: new Date(nowMs).toISOString(),
    docId: String(docId || ''), company: String(company || ''), role: String(role || ''),
    interviewGen: Number.isInteger(interviewGen) ? interviewGen : null,
    evidenceGen: Number.isInteger(evidenceGen) ? evidenceGen : null,
    interviewStale: !!interviewStale,
    questions, answers: {}, feedback: {},
  };
}

// ===== 会话摘要（history 路由用；纯函数）=====
export function sessionSummary(s) {
  const q = s && typeof s === 'object' ? s : {};
  const answers = q.answers && typeof q.answers === 'object' && !Array.isArray(q.answers) ? q.answers : {};
  const feedback = q.feedback && typeof q.feedback === 'object' && !Array.isArray(q.feedback) ? q.feedback : {};
  return {
    pid: typeof q.pid === 'string' ? q.pid : '',
    createdAt: typeof q.createdAt === 'string' ? q.createdAt : '',
    docId: typeof q.docId === 'string' ? q.docId : '',
    company: typeof q.company === 'string' ? q.company : '',
    role: typeof q.role === 'string' ? q.role : '',
    interviewStale: !!q.interviewStale,
    questionCount: Array.isArray(q.questions) ? q.questions.length : 0,
    answeredCount: Object.values(answers).filter((a) => a && typeof a === 'object' && String(a.text || '').trim()).length,
    feedbackCount: Object.values(feedback).filter((b) => b && typeof b === 'object' && b.result).length,
  };
}

// ===== 会话读取视图（零写盘：过期 running 只加 derived 标记，不落库——写盘收敛交给 finish 的 TTL 分支）=====
export function practiceSessionView(session, now = Date.now()) {
  const s = session && typeof session === 'object' ? session : {};
  const fb = s.feedback && typeof s.feedback === 'object' && !Array.isArray(s.feedback) ? s.feedback : {};
  const out = { ...s, feedback: {} };
  for (const [qid, box] of Object.entries(fb)) {
    if (!box || typeof box !== 'object') continue;
    const t = box.task;
    out.feedback[qid] = (t && t.status === 'running' && feedbackTaskExpired(t, now))
      ? { ...box, task: { ...t, expired: true } } : box;
  }
  return out;
}

// ===== 并发闸辅助：同一条投递同时只允许 1 个 running（过期残留不占额度，startGenTask 同款）=====
export const feedbackTaskExpired = (t, now) =>
  !!(t && t.status === 'running' && typeof t.startedAt === 'number' && t.startedAt + PRACTICE_TTL_MS < now);
export function findRunningFeedback(app, now = Date.now()) {
  for (const s of practiceSessions(app)) {
    const fb = s.feedback && typeof s.feedback === 'object' && !Array.isArray(s.feedback) ? s.feedback : {};
    for (const [qid, box] of Object.entries(fb)) {
      const t = box && typeof box === 'object' ? box.task : null;
      if (t && t.status === 'running' && !feedbackTaskExpired(t, now)) return { pid: s.pid, qid, task: t };
    }
  }
  return null;
}

// ===== 出题落账（新会话插队头 + 截 20；挤出的在途任务由定位器 dropped 兜住）=====
export function appendPracticeSession(ledger, id, session) {
  const rec = ledger.read(id);
  if (!rec) return { ok: false, status: 404, error: '投递记录不存在' };
  const next = [session, ...practiceSessions(rec.app)].slice(0, PRACTICE_CAP);
  if (!ledger.write({ ...rec.app, practice: next })) return { ok: false, status: 404, error: '投递记录已删除，未保存本次练习' };
  return { ok: true };
}

// ===== 逐题作答（重交 = 最近一次为准；不碰该题既有反馈——新旧对照由作答/反馈时间戳呈现）=====
export function savePracticeAnswer(ledger, id, pid, qid, text) {
  const rec = ledger.read(id);
  if (!rec) return { ok: false, status: 404, error: '投递记录不存在' };
  const app = rec.app;
  const session = findSession(app, pid);
  if (!session) return { ok: false, status: 404, error: '练习会话不存在或已被清理（历史保留最近 ' + PRACTICE_CAP + ' 次）' };
  if (!findQuestion(session, qid)) return { ok: false, status: 404, error: '问题不存在（qid 不在这条练习里）' };
  const sessions = practiceSessions(app);
  const i = sessions.findIndex((s) => s.pid === pid);
  const nextSessions = sessions.slice();
  nextSessions[i] = { ...session, answers: { ...(session.answers || {}), [qid]: { text: String(text), at: new Date().toISOString() } } };
  if (!ledger.write({ ...app, practice: nextSessions })) return { ok: false, status: 404, error: '投递记录已删除，未保存本次作答' };
  return { ok: true };
}

export function normalizeAnswerText(v) {
  if (typeof v !== 'string') return { ok: false, error: '回答需为非空文本' };
  const t = v.trim();
  if (!t) return { ok: false, error: '回答需为非空文本' };
  if (t.length > ANSWER_MAX_CHARS) return { ok: false, error: '回答过长（上限 ' + ANSWER_MAX_CHARS + ' 字）' };
  return { ok: true, text: t };
}

// ===== 反馈任务（followup.mjs 同款链路：登记 → fire-and-forget → 完成判定落账）=====
// 登记任务（并发闸：同一条投递跨会话只允许 1 个 running；过期残留不占额度）。
export function startPracticeFeedbackTask(ledger, id, pid, qid, { model } = {}) {
  const rec = ledger.read(id);
  if (!rec) return { taskId: null, reject: { status: 404, error: '投递记录不存在' } };
  const app = rec.app;
  const session = findSession(app, pid);
  if (!session) return { taskId: null, reject: { status: 404, error: '练习会话不存在或已被清理（历史保留最近 ' + PRACTICE_CAP + ' 次）' } };
  if (!findQuestion(session, qid)) return { taskId: null, reject: { status: 404, error: '问题不存在（qid 不在这条练习里）' } };
  const ans = (session.answers && typeof session.answers === 'object') ? session.answers[qid] : null;
  if (!ans || !String(ans.text || '').trim()) {
    return { taskId: null, reject: { status: 409, error: '这一题还没有作答：先提交文本回答，再生成对照反馈' } };
  }
  if (findRunningFeedback(app)) {
    return { taskId: null, reject: { status: 409, error: '这条投递已有一个练习反馈在进行中，请等它结束或取消后再试' } };
  }
  const task = {
    kind: PRACTICE_KIND, taskId: newTaskId(), status: 'running', startedAt: Date.now(),
    stage: 'queued', error: null, usage: null, model: model || null,
  };
  const sessions = practiceSessions(app);
  const i = sessions.findIndex((s) => s.pid === pid);
  const box = feedbackBoxOf(session, qid);
  const nextSessions = sessions.slice();
  nextSessions[i] = { ...session, feedback: { ...(session.feedback || {}), [qid]: { task, result: (box && box.result) || null } } };
  if (!ledger.write({ ...app, practice: nextSessions })) return { taskId: null, reject: { status: 404, error: '投递记录已删除，未登记本次生成' } };
  return { taskId: task.taskId, reject: null };
}

// 任务记录定位器（completeGenResult 用）：任务挂在本投递的会话 practice[i].feedback[qid].task 上。
// 会话被挤出历史（截 20）→ get 返回 null → completeGenResult 判 dropped（迟到零落账）。
export function sessionFeedbackLocator(pid, qid) {
  return {
    get(app) {
      const s = findSession(app, pid);
      const box = s ? feedbackBoxOf(s, qid) : null;
      return (box && box.task && typeof box.task === 'object') ? box.task : null;
    },
    set(app, _kind, rec) {
      const sessions = practiceSessions(app);
      const i = sessions.findIndex((s) => s.pid === pid);
      if (i < 0) return;
      const s = sessions[i];
      const box = feedbackBoxOf(s, qid);
      const nextSessions = sessions.slice();
      nextSessions[i] = { ...s, feedback: { ...(s.feedback || {}), [qid]: { ...(box || {}), task: rec } } };
      app.practice = nextSessions;
    },
  };
}

// 任务阶段打补丁（守卫同款：taskId 匹配且仍 running 才写）。
function patchTask(ledger, id, pid, qid, taskId, patch) {
  const rec = ledger.read(id);
  if (!rec) return false;
  const app = rec.app;
  const t = sessionFeedbackLocator(pid, qid).get(app);
  if (!t || t.taskId !== taskId || t.status !== 'running') return false;
  const sessions = practiceSessions(app);
  const i = sessions.findIndex((s) => s.pid === pid);
  const s = sessions[i];
  const box = feedbackBoxOf(s, qid);
  const nextSessions = sessions.slice();
  nextSessions[i] = { ...s, feedback: { ...(s.feedback || {}), [qid]: { ...box, task: { ...t, ...patch } } } };
  return ledger.write({ ...app, practice: nextSessions });
}

// 任务收口（成功 / 错误 / 超时）：判定交给 gen-result.mjs 的纯函数（同一套契约）。
function finishPracticeFeedback(ledger, id, pid, qid, taskId, { apply, errMsg, usage } = {}) {
  const rec = ledger.read(id);
  if (!rec) return { dropped: true };
  const res = completeGenResult(rec.app, {
    kind: PRACTICE_KIND, taskId, now: Date.now(), ttlMs: PRACTICE_TTL_MS, apply, errMsg, usage,
    locator: sessionFeedbackLocator(pid, qid),
  });
  if (res.next) ledger.write(res.next);
  return res.out;
}

// 异常兜底：把任务收敛到 error 态（否则账本里会留下永远 running 的假任务）。
export function failPracticeFeedbackTask(ledger, id, pid, qid, taskId, errMsg) {
  return finishPracticeFeedback(ledger, id, pid, qid, taskId, { errMsg: String(errMsg || '任务失败') });
}

// 取消（taskId 匹配当前 running 才置 cancelled；在途结果被完成判定丢弃 → 零落账）。
export function cancelPracticeFeedbackTask(ledger, id, pid, qid, taskId) {
  const rec = ledger.read(id);
  if (!rec) return false;
  const app = rec.app;
  const sessions = practiceSessions(app);
  const i = sessions.findIndex((s) => s.pid === pid);
  if (i < 0) return false;
  const s = sessions[i];
  const box = feedbackBoxOf(s, qid);
  const t = box && box.task;
  if (!t || t.taskId !== taskId || t.status !== 'running') return false;
  const nextSessions = sessions.slice();
  nextSessions[i] = { ...s, feedback: { ...(s.feedback || {}), [qid]: { ...box, task: { ...t, status: 'cancelled', stage: null } } } };
  return ledger.write({ ...app, practice: nextSessions });
}

// ===== 反馈 prompt（对照证据表；诚实红线钉在 sys 里）=====
// 事实依据只有出题时快照的证据要点与引文：不虚构、不脑补；标注「来源已变动/仅作参考」的要点不当已核验事实。
const POINT_STATE_LABEL = {
  fresh: '引文已核验',
  stale: '来源已变动（引文不再命中当前正文，仅作参考）',
  none: '作答思路（无引文锚点，未经核验）',
  legacy: '旧数据（未带来源快照，仅作参考）',
  invalid: '来源状态未知（仅作参考）',
};
export function buildFeedbackPrompt({ company = '', role = '', question, answer = '' }) {
  const q = question && typeof question === 'object' ? question : {};
  const points = Array.isArray(q.points) ? q.points : [];
  const lines = [];
  if (q.req) lines.push('【证据表对应要求】' + String(q.req));
  if (points.length) {
    lines.push('【证据要点（出题时快照，事实判断的唯一依据）】');
    points.forEach((p, i) => {
      const st = POINT_STATE_LABEL[p.sourceState] || '来源状态未知（仅作参考）';
      lines.push((i + 1) + '. ' + String(p.text || '') + (p.quote ? '（引文：' + p.quote + '；' + st + '）' : '（' + st + '）'));
    });
  } else {
    lines.push('【证据要点】（本条题目没有可用证据要点：无法核验的部分请在 hit/missing 里如实留空，并在建议里说明依据不足）');
  }
  const sys = '你是面试练习教练。对照证据表判断一段练习回答。只输出 JSON。\n'
    + '1. 事实依据只有【证据要点】及其引文：不虚构、不脑补简历里没有的事实；标注「来源已变动/仅作参考」的要点不能当已核验事实。\n'
    + '2. 反馈四个字段：hit=答到的事实；missing=缺的指标或事实；exaggeration=夸大倾向（答案里有而证据里没有的数字或程度词，没有就给空数组）；advice=只针对这一题的改进建议。\n'
    + '3. 诚实红线：不做评分、不做百分位、不做排名、不写「超过 X% 候选人」一类不可验证的比较；反馈只做对照，不直接改写简历正文。\n'
    + '4. 只输出 JSON：{"hit":["…"],"missing":["…"],"exaggeration":["…"],"advice":"…"}';
  const user = '【目标公司】' + company + '\n【目标岗位】' + role + '\n\n【面试问题】' + String(q.question || '')
    + (q.followUp ? '\n【追问】' + String(q.followUp) : '')
    + '\n\n【我的练习回答】\n' + String(answer || '')
    + '\n\n' + lines.join('\n');
  return { sys, user };
}

// ===== 反馈解析（形状错即拒：四个字段齐、类型对才收；条目截断是展示级收敛不是放行）=====
const stripFence = (raw) => String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
export function parseFeedback(raw) {
  let d;
  try { d = JSON.parse(stripFence(raw)); } catch { return { ok: false, error: '模型输出无法解析为练习反馈（不是合法 JSON），未写入任何结果' }; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) {
    return { ok: false, error: '模型输出无法解析为练习反馈（不是对象），未写入任何结果' };
  }
  const list = (v) => Array.isArray(v)
    ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, 8).map((x) => x.slice(0, 200))
    : null;
  const hit = list(d.hit);
  const missing = list(d.missing);
  const exaggeration = list(d.exaggeration);
  const advice = typeof d.advice === 'string' ? d.advice.trim().slice(0, 600) : '';
  if (hit === null || missing === null || exaggeration === null || !advice) {
    return { ok: false, error: '模型输出无法解析为练习反馈（hit/missing/exaggeration 需为字符串数组、advice 需为非空文本），未写入任何结果' };
  }
  return { ok: true, hit, missing, exaggeration, advice };
}

// ===== 运行器（服务端 fire-and-forget；结果只经完成判定落账）=====
// 作答快照闭包在任务里：反馈期间作答被改 → apply 显式拒绝（反馈不落账），不张冠李戴。
export async function runPracticeFeedbackTask(root, ledger, id, pid, qid, taskId, { lease } = {}) {
  const rec = ledger.read(id);
  if (!rec) return { dropped: true };
  const session = findSession(rec.app, pid);
  if (!session) return { dropped: true };
  const q = findQuestion(session, qid);
  const ans = (session.answers && typeof session.answers === 'object') ? session.answers[qid] : null;
  if (!q || !ans) return { dropped: true };
  const expectedAnswer = String(ans.text || '');
  let p;
  try {
    p = buildFeedbackPrompt({ company: session.company || '', role: session.role || '', question: q, answer: expectedAnswer });
  } catch (e) {
    return finishPracticeFeedback(ledger, id, pid, qid, taskId, { errMsg: '反馈规格缺失：' + ((e && e.message) || e) });
  }
  patchTask(ledger, id, pid, qid, taskId, { stage: 'calling' });
  const meta = {};
  let raw = '';
  try {
    raw = await chat(root, p.sys, p.user, { lease, meta });
  } catch (e) {
    return finishPracticeFeedback(ledger, id, pid, qid, taskId, { errMsg: '模型调用失败：' + ((e && e.message) || e) });
  }
  patchTask(ledger, id, pid, qid, taskId, { stage: 'parsing', usage: meta.usage ?? null });
  const parsed = parseFeedback(raw);
  if (!parsed.ok) return finishPracticeFeedback(ledger, id, pid, qid, taskId, { errMsg: parsed.error, usage: meta.usage ?? null });
  return finishPracticeFeedback(ledger, id, pid, qid, taskId, {
    usage: meta.usage ?? null,
    apply: (work) => {
      const sessions = practiceSessions(work);
      const i = sessions.findIndex((s) => s.pid === pid);
      if (i < 0) return { ok: false, error: '练习会话已被清理（历史保留最近 ' + PRACTICE_CAP + ' 次），本次反馈不落账' };
      const s = sessions[i];
      const cur = (s.answers && typeof s.answers === 'object') ? s.answers[qid] : null;
      if (!cur || String(cur.text || '') !== expectedAnswer) {
        return { ok: false, error: '作答内容在反馈期间被修改，本次反馈不落账，请重新生成' };
      }
      const box = feedbackBoxOf(s, qid);
      const nextSessions = sessions.slice();
      nextSessions[i] = {
        ...s,
        feedback: { ...(s.feedback || {}), [qid]: { ...box, result: { hit: parsed.hit, missing: parsed.missing, exaggeration: parsed.exaggeration, advice: parsed.advice } } },
      };
      work.practice = nextSessions;
      return { ok: true };
    },
  });
}
