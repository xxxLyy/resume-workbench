// followup.mjs — 跟进助手（批 3 · 卡片 b3c4）：投递卡「无回应超 N 天」→ 生成跟进语草稿（只生成，不发送）
// 上位计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4 批 3「S8 网申包 + 跟进助手」；
// 上位路线图：dev-docs/2026-09-23-roadmap-magazine-and-features.md §S8。
//
// 本模块只管「跟进语草稿」这一条链路的判定与任务状态机：
//   判定（无回应满 N 天）→ 任务登记 → 取材 → 调模型 → 解析 → 落「待确认草稿」。
//
// 与既有 AI 文案字段（apply-gen.mjs，b3c3）的关系：
//   · 写作规格**不另写一份**：跟进语复用 apply-gen.mjs 的 COPY_SPEC.followUp（buildCopyPrompt），
//     解析也复用 parseCopyText（剥 Markdown 围栏与模型自加的前缀标签）。
//   · 完成判定复用 gen-result.mjs 的纯函数 completeGenResult（taskId 匹配 / TTL / 显式 ok / 迟到丢弃），
//     只把「任务记录在哪」换成本账本的定位器 —— 判定逻辑不另写一份。
//   · 任务记录契约同款：{ taskId, status, startedAt, stage, error, usage, model }；
//     status ∈ running/done/error/cancelled；stage ∈ queued/calling/parsing（真实阶段，**无百分比**）。
//
// 诚实边界：
//   · **草稿不发送**：本模块没有任何「发送」能力（无外发、无跨站注入、无代填）——生成结果只落本机
//     投递记录，用户自己复制自己发（批 3 §4 硬约束：不做跨站注入/自动发送）。
//   · 「无回应」只认「仍在等回应」：状态 = 已投递 且 没有任何面试记录。进了笔试/面试说明对方已回应；
//     offer/已拒/搁置是终态或用户主动搁下 —— 都不再提示跟进。
//   · 阈值 N 默认 7 天，/settings 可配（config.json 的 followUpDays）。
//   · 取材只来自该投递记录关联的简历（派生要点），不在本地编造事实。
//   · 无模型 / 无简历 → 明确拒绝（不留注定失败的任务，也不留 running 假任务）。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chat } from './llm.mjs';
import { completeGenResult } from './gen-result.mjs';
import { buildCopyPrompt, parseCopyText } from './apply-gen.mjs';
import { deriveDocFields } from './apply-profile.mjs';

export const FOLLOW_UP_KIND = 'followUp';
// 阈值：默认 7 天（满 N 天才提示）；可配范围 1–90 天。
export const FOLLOW_UP_DAYS_DEFAULT = 7;
export const FOLLOW_UP_DAYS_MIN = 1;
export const FOLLOW_UP_DAYS_MAX = 90;
// 任务级总时限：与既有 genTasks / copy 任务同口径（10 分钟）——超时后任务标失败、结果不落账。
export const FOLLOW_UP_TTL_MS = 10 * 60 * 1000;
// 无模型时的降级口径（接口与页面共用同一句，避免两处措辞漂移）。
export const FOLLOW_UP_NO_MODEL_HINT = '未配置大模型：不能生成跟进语草稿，可在设置页配置模型后重试，或自己写一条';

const newTaskId = () => 'f-' + randomBytes(4).toString('hex');
const newDraftId = () => 'fd-' + randomBytes(4).toString('hex');

// ===== 阈值（/settings 可配；config.json 的 followUpDays）=====
// 形状错即拒：非整数 / 越界 → 400（不静默回落成默认，省得用户以为改了却没生效）。
// 类型也严：只认数字与纯数字串（设置页 number input 提交的就是数字串）——
// Number() 的隐式转换会把 true 变 1、[3] 变 3，那是形状错不是值（§10.13「形状错即拒」）。
export function normalizeFollowUpDays(v) {
  if (v === undefined || v === null || v === '') return { ok: true, days: FOLLOW_UP_DAYS_DEFAULT };
  const isNum = typeof v === 'number' || (typeof v === 'string' && /^\s*\d+\s*$/.test(v));
  if (!isNum) return { ok: false, error: '跟进语提醒阈值需为 ' + FOLLOW_UP_DAYS_MIN + '-' + FOLLOW_UP_DAYS_MAX + ' 的整数（天）' };
  const n = Number(v);
  if (!Number.isInteger(n) || n < FOLLOW_UP_DAYS_MIN || n > FOLLOW_UP_DAYS_MAX) {
    return { ok: false, error: '跟进语提醒阈值需为 ' + FOLLOW_UP_DAYS_MIN + '-' + FOLLOW_UP_DAYS_MAX + ' 的整数（天）' };
  }
  return { ok: true, days: n };
}

// 读取当前阈值：config.json 里没有 / 存的不是合法值 → 回落默认（读侧宽容，写侧严）。
export function followUpDays(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    const n = normalizeFollowUpDays(raw && raw.followUpDays);
    return n.ok ? n.days : FOLLOW_UP_DAYS_DEFAULT;
  } catch { return FOLLOW_UP_DAYS_DEFAULT; }
}

// ===== 「无回应满 N 天」判定（纯函数、零 I/O）=====
// 「已投递」= server.mjs 的 APP_STATUSES[0]（同一口径常量，字面量在此登记一次）。
const WAITING_STATUS = '已投递';

// 日历日 → UTC 日序号：投递日期（appliedAt，YYYY-MM-DD）缺省回落创建日（createdAt 的日期部分）。
// 两个日历日之差 = 已经过的完整天数（不受时区/夏令时影响）。
function calendarDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s == null ? '' : s));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (!y || !mo || !d || mo > 12 || d > 31) return null;
  return Date.UTC(y, mo - 1, d);
}

// due = 无回应 且 距投递日已满 N 天（days >= N）。
export function followUpState(app, { nowMs = Date.now(), thresholdDays = FOLLOW_UP_DAYS_DEFAULT } = {}) {
  const a = (app && typeof app === 'object') ? app : {};
  const ivs = Array.isArray(a.interviews) ? a.interviews : [];
  const base = calendarDay(a.appliedAt);
  const from = base == null ? calendarDay(a.createdAt) : base;
  const now = new Date(nowMs);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = from == null ? null : Math.floor((today - from) / 86400000);
  const responded = String(a.status || '') !== WAITING_STATUS || ivs.length > 0;
  return {
    due: !responded && days != null && days >= thresholdDays,
    days,                       // 距投递日已过的天数（null = 没有可用日期，算不出就不提示）
    responded,                  // 对方已回应（进了笔试/面试/终态）→ 不再提示跟进
    hasDate: days != null,
  };
}

// ===== 任务/草稿在投递记录上的存取（纯函数，不碰盘）=====
// 落点：投递记录本机账本 applications.json 的 app.followUp = { task, draft }（与既有 app.preps 同一落点，
// 不新增文件、不进备份之外的地方）。
export const followUpBox = (app) =>
  (app && app.followUp && typeof app.followUp === 'object' && !Array.isArray(app.followUp)) ? app.followUp : null;
export const followUpTask = (app) => {
  const b = followUpBox(app);
  return (b && b.task && typeof b.task === 'object') ? b.task : null;
};
export const followUpDraft = (app) => {
  const b = followUpBox(app);
  return (b && b.draft && typeof b.draft === 'object') ? b.draft : null;
};

// 任务记录定位器（completeGenResult 用）：任务挂在投递记录上，不挂岗位草稿 meta。
export const FOLLOW_UP_LOCATOR = {
  get(app, key) { return followUpTask(app); },
  set(app, key, rec) { app.followUp = { ...(followUpBox(app) || {}), task: rec }; },
};

export const followUpTaskExpired = (t, now) =>
  !!(t && t.status === 'running' && typeof t.startedAt === 'number' && t.startedAt + FOLLOW_UP_TTL_MS < now);

// ===== 账本适配器（server.mjs 是 applications.json 的唯一写者）=====
//   read(id) → { app } | null      读当前投递记录
//   write(app) → boolean           写回（server.mjs 内部重新读表后只回写本卡的 followUp 字段）
// 本模块不自己碰 applications.json：写路径统一在 server.mjs，避免两套写纪律。
const notFound = { status: 404, error: '投递记录不存在' };

// 登记任务（并发闸：同一条投递同时只允许 1 个 running；过期残留不占额度）。
export function startFollowUpTask(ledger, id, { model } = {}) {
  const rec = ledger.read(id);
  if (!rec) return { taskId: null, reject: notFound };
  const app = rec.app;
  const cur = followUpTask(app);
  if (cur && cur.status === 'running' && !followUpTaskExpired(cur, Date.now())) {
    return { taskId: null, reject: { status: 409, error: '这条投递已有一个跟进语生成在进行中，请等它结束或取消后再试' } };
  }
  const task = {
    kind: FOLLOW_UP_KIND, taskId: newTaskId(), status: 'running', startedAt: Date.now(),
    stage: 'queued', error: null, usage: null, model: model || null,
  };
  const ok = ledger.write({ ...app, followUp: { ...(followUpBox(app) || {}), task } });
  if (!ok) return { taskId: null, reject: { status: 404, error: '投递记录已删除，未登记本次生成' } };
  return { taskId: task.taskId, reject: null };
}

// 读状态（读取时校验：过期 running → 任务超时）。
export function followUpStateOf(ledger, id, now = Date.now()) {
  const rec = ledger.read(id);
  if (!rec) return null;
  let app = rec.app;
  const t = followUpTask(app);
  if (t && t.status === 'running' && followUpTaskExpired(t, now)) {
    const next = { ...app, followUp: { ...(followUpBox(app) || {}), task: { ...t, status: 'error', error: '任务超时', stage: null } } };
    if (ledger.write(next)) app = next;
  }
  return { task: followUpTask(app), draft: followUpDraft(app) };
}

// 取消（taskId 匹配当前 running 才置 cancelled；在途结果被完成判定丢弃 → 零落账）。
export function cancelFollowUpTask(ledger, id, taskId) {
  const rec = ledger.read(id);
  if (!rec) return false;
  const app = rec.app;
  const t = followUpTask(app);
  if (!t || t.taskId !== taskId || t.status !== 'running') return false;
  return ledger.write({ ...app, followUp: { ...(followUpBox(app) || {}), task: { ...t, status: 'cancelled', stage: null } } });
}

// 丢弃草稿（清稿；草稿只是本机的待用文本，不进任何字段包）。
export function discardFollowUpDraft(ledger, id) {
  const rec = ledger.read(id);
  if (!rec) return false;
  const app = rec.app;
  const b = followUpBox(app);
  if (!b || !b.draft) return false;
  return ledger.write({ ...app, followUp: { ...b, draft: null } });
}

// 任务阶段打补丁（守卫同款：taskId 匹配且仍 running 才写）。
function patchStage(ledger, id, taskId, patch) {
  const rec = ledger.read(id);
  if (!rec) return false;
  const app = rec.app;
  const t = followUpTask(app);
  if (!t || t.taskId !== taskId || t.status !== 'running') return false;
  return ledger.write({ ...app, followUp: { ...(followUpBox(app) || {}), task: { ...t, ...patch } } });
}

// 任务收口（成功 / 错误 / 超时）：判定交给 gen-result.mjs 的纯函数（同一套契约）。
function finish(ledger, id, taskId, { apply, errMsg, usage } = {}) {
  const rec = ledger.read(id);
  if (!rec) return { dropped: true };
  const res = completeGenResult(rec.app, {
    kind: FOLLOW_UP_KIND, taskId, now: Date.now(), ttlMs: FOLLOW_UP_TTL_MS, apply, errMsg, usage, locator: FOLLOW_UP_LOCATOR,
  });
  if (res.next) ledger.write(res.next);
  return res.out;
}

// 异常兜底：把任务收敛到 error 态（否则账本里会留下永远 running 的假任务）。
export function failFollowUpTask(ledger, id, taskId, errMsg) {
  return finish(ledger, id, taskId, { errMsg: String(errMsg || '任务失败') });
}

// ===== 取材（该投递记录关联的简历 → 派生要点）=====
// docId 闸门与拼路径都在 apply-profile.mjs 内（投递记录里的 docId 是外部可编辑内容，越界由模块挡）。
export function followUpSource(root, app) {
  const docId = String((app && app.docId) || '');
  if (!docId) return null;
  return deriveDocFields(root, docId);   // null = 简历不在本机 / docId 非法
}

// ===== 运行器（服务端 fire-and-forget；结果只经完成判定落账）=====
export async function runFollowUpTask(root, ledger, id, taskId, { lease } = {}) {
  const rec = ledger.read(id);
  if (!rec) return { dropped: true };
  const app = rec.app;
  const src = followUpSource(root, app);
  if (!src) {
    return finish(ledger, id, taskId, { errMsg: '还没有可依据的简历：这条投递关联的简历不在本机（请先在投递详情里确认简历）' });
  }
  let p;
  try {
    // 写作规格复用 apply-gen.mjs 的 followUp 规格（不另写一份：两处规格漂移 = 两处口径不一致）
    p = buildCopyPrompt({ key: 'followUp', source: src, company: String(app.company || ''), role: String(app.role || '') });
  } catch (e) {
    return finish(ledger, id, taskId, { errMsg: '文案规格缺失：' + ((e && e.message) || e) });
  }
  patchStage(ledger, id, taskId, { stage: 'calling' });
  const meta = {};
  let raw = '';
  try {
    raw = await chat(root, p.sys, p.user, { lease, meta });
  } catch (e) {
    return finish(ledger, id, taskId, { errMsg: '模型调用失败：' + ((e && e.message) || e) });
  }
  patchStage(ledger, id, taskId, { stage: 'parsing', usage: meta.usage ?? null });
  const parsed = parseCopyText(raw);
  if (!parsed.ok) return finish(ledger, id, taskId, { errMsg: parsed.error, usage: meta.usage ?? null });
  const draft = { id: newDraftId(), text: parsed.text, taskId: String(taskId), createdAt: new Date().toISOString() };
  // 成功落账 = 稿进「待确认草稿」区；**不发送、不入库任何字段包**（草稿不发送是硬约束）。
  return finish(ledger, id, taskId, {
    usage: meta.usage ?? null,
    apply: (work) => {
      work.followUp = { ...(followUpBox(work) || {}), draft };
      return { ok: true, extra: { draftId: draft.id } };
    },
  });
}
