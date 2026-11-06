// apply-gen.mjs — AI 文案字段的生成任务层（批 3 · 卡片 b3c3）
// 上位计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4 批 3「S8 网申包 + 跟进助手」；
// 上位路线图：dev-docs/2026-09-23-roadmap-magazine-and-features.md §S8。
//
// 本模块只管「AI 文案字段（打招呼语 / 自荐信 / 跟进语）」的生成任务：
//   任务登记 → 取材 → 调模型 → 解析 → 落「待确认稿」；确认才进字段包。
//
// 与既有 genTasks 的关系（卡片口径「走既有 genTasks」）：
//   · 任务记录契约同款：{ taskId, status, startedAt, stage, error, usage, model }；
//     status ∈ idle/running/done/error/cancelled；stage ∈ queued/calling/parsing（真实阶段，**无百分比**）。
//   · 完成判定复用 gen-result.mjs 的纯函数 completeGenResult（taskId 匹配 / TTL / 显式 ok / 迟到丢弃），
//     只把「任务记录在哪」换成本账本的定位器 —— 判定逻辑不另写一份。
//   · kind = 'copy'（新增）：任务不挂在岗位草稿 meta 上（网申包不是岗位草稿），挂在 apply-profiles.json 里。
//   · 用量取服务商真实返回（meta.usage）；服务商没返回就记 null（不编 0）。
//
// 诚实边界：
//   · 生成完成 ≠ 入库：结果先落「待确认稿」，用户确认（或改过预览再确认）才写进字段。
//   · 字段被手动改写后 locked → 再生成/再确认都不得覆盖它（可显式解锁）。
//   · 文案只能取材于来源简历的派生事实（prompt 里给的是真文本），不在本地编造事实。
//   · 无模型 → 明确降级（NO_MODEL_HINT），不做「点了才知道」的死路。
import { randomBytes } from 'node:crypto';
import { chat } from './llm.mjs';
import { completeGenResult } from './gen-result.mjs';
import { updateApplyProfiles, loadApplyProfiles, copyTaskKey, copySource, scopeMeta, writeAiField, AI_COPY_KEYS } from './apply-profile.mjs';

export const COPY_KIND = 'copy';
// 任务级总时限：与 server.mjs 的 GEN_TTL_MS 同口径（10 分钟）——超时后任务标失败、结果不落账。
export const COPY_TTL_MS = 10 * 60 * 1000;
// 文案长度上限（超出截断并标注，不静默丢内容）。
export const COPY_MAX_CHARS = 4000;
// 无模型时的降级口径（接口与页面共用同一句，避免两处措辞漂移）。
export const NO_MODEL_HINT = '未配置大模型：AI 文案字段不能生成，可在设置页配置模型后重试，或直接手动填写本字段';

const STAGES = { queued: '排队等待槽位', calling: '调用模型中', parsing: '解析校验中' };
export const stageLabel = (s) => STAGES[s] || '处理中';

// 账本内的任务定位器：completeGenResult 用它找/写任务记录（默认那套是 meta.job.genTasks）。
const LEDGER_LOCATOR = {
  get(cur, key) { return (cur.copyTasks || {})[key]; },
  set(cur, key, rec) { cur.copyTasks = { ...(cur.copyTasks || {}), [key]: rec }; },
};

const genExpired = (t, now) => !!(t && t.status === 'running' && typeof t.startedAt === 'number' && t.startedAt + COPY_TTL_MS < now);
const newTaskId = () => 'c-' + randomBytes(4).toString('hex');
const newDraftId = () => 'd-' + randomBytes(4).toString('hex');
const err = (code, msg) => Object.assign(new Error(msg), { code });

// ===== 文案规格（三种字段的写法要求）=====
// 硬约束都在 sys 里：只用简历要点里的事实，不编造项目/数字/职级/时间；输出纯文本正文。
const COPY_SPEC = {
  greeting: {
    label: '打招呼语',
    ask: '写一段 3 到 5 句的中文开场白：我是谁、做过什么、与这个岗位对得上的地方、请对方查看简历。',
    extra: '不要写期望薪资，不要写「贵公司行业领先」这类空话，不要复述简历全文。',
  },
  coverLetter: {
    label: '自荐信',
    ask: '写一段 6 到 10 句的中文自荐信：自我介绍、与岗位相关的经历与做法、为什么投这个岗位、最后一句表达求职意愿。',
    extra: '只写简历里有的经历与做法；不要编造项目名、公司细节或指标数字。',
  },
  followUp: {
    label: '跟进语',
    ask: '写一段 2 到 4 句的中文跟进消息：礼貌说明已投递、点出一到两项相关经历、请对方有空时查看简历。',
    extra: '不要虚构已发生的沟通、面试或对方回复；不要催逼、不要提期望薪资。',
  },
};
export const copySpec = (key) => COPY_SPEC[key] || null;
// 「哪些字段是 AI 文案字段」的**唯一真源** = apply-profile.mjs 的字段目录（ai:true 标记 → AI_COPY_KEYS）；
// 本模块只负责「怎么写」（COPY_SPEC 的 prompt 规格）。目录与规格表若分叉（目录加了字段、规格漏了）→
// buildCopyPrompt 抛 APPLY_NO_COPY_SPEC（响亮），不会静默少一个字段（夹具有一致性断言钉住）。
export const isCopyKey = (key) => AI_COPY_KEYS.includes(String(key));

// ===== prompt 构造（取材 = 来源简历的派生纯文本）=====
export function buildCopyPrompt({ key, source = {}, company = '', role = '' }) {
  const spec = COPY_SPEC[key];
  if (!spec) throw err('APPLY_NO_COPY_SPEC', '该 AI 文案字段缺少写作规格（字段目录与规格表不一致）：' + String(key));
  const facts = [];
  const push = (label, v) => { const s = String(v == null ? '' : v).trim(); if (s) facts.push('- ' + label + '：' + s); };
  push('姓名', source.name);
  push('自评', source.selfIntro);
  push('专业技能', source.skills);
  push('工作经历', source.work);
  push('项目经历', source.projects);
  push('教育经历', source.education);
  const sys = [
    '你是求职文案助手。',
    '硬约束：只能使用下面「简历要点」里出现过的事实（经历、公司、职责、做法、技术栈、指标）；要点里没有的一律不许写出来，不得编造项目、数字、职级或时间。',
    '输出纯文本正文：不要 JSON、不要 Markdown 代码块、不要标题、不要写解释或选项。',
  ].join('\n');
  const user = [
    '字段类型：' + spec.label,
    '任务：' + spec.ask,
    spec.extra,
    '公司：' + (company || '未填'),
    '岗位：' + (role || '未填'),
    '简历要点：',
    facts.length ? facts.join('\n') : '- （没有可用要点）',
  ].join('\n');
  return { sys, user };
}

// ===== 解析（模型输出 → 可确认的纯文本）=====
export function parseCopyText(raw) {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/i, '');            // 去掉 Markdown 代码围栏
  s = s.replace(/^(?:打招呼语|自荐信|跟进语|文案|正文|草稿)\s*[:：]\s*/, '');  // 去掉模型自加的前缀标签
  s = s.trim();
  if (!s) return { ok: false, error: '模型输出为空，没有可确认的文案' };
  if (s.length > COPY_MAX_CHARS) s = s.slice(0, COPY_MAX_CHARS) + '…（已截断）';
  return { ok: true, text: s };
}

// ===== 任务登记（并发闸同款：同类 copy 全库同时只允许 1 个）=====
export function startCopyTask(root, scope, key, opts = {}) {
  if (!isCopyKey(key)) return { taskId: null, reject: { status: 400, error: '不是 AI 文案字段：' + String(key) } };
  const taskKey = copyTaskKey(scope, key);
  let taskId = null, reject = null;
  updateApplyProfiles(root, (data) => {
    const now = Date.now();
    const tasks = data.copyTasks || (data.copyTasks = {});
    for (const [tk, t] of Object.entries(tasks)) {
      if (!t || t.status !== 'running' || genExpired(t, now)) continue;   // 过期残留不占额度
      reject = { status: 409, error: '已有一个 AI 文案生成在进行中，请等它结束或取消后再试' };
      return null;
    }
    taskId = newTaskId();
    tasks[taskKey] = {
      kind: COPY_KIND, taskId, status: 'running', startedAt: now, stage: 'queued',
      error: null, usage: null, model: opts.model || null,
      scope: scope.kind === 'package' ? { kind: 'package', id: String(scope.id || '') } : { kind: 'common' },
      key: String(key),
    };
    return data;
  });
  return { taskId, reject };
}

// 任务记录打补丁（守卫同款：taskId 匹配且仍 running 才写；迟到写入零落账）。
export function patchCopyTask(root, taskKey, taskId, patch) {
  updateApplyProfiles(root, (data) => {
    const t = (data.copyTasks || {})[taskKey];
    if (!t || t.taskId !== taskId || t.status !== 'running') return null;
    data.copyTasks[taskKey] = { ...t, ...patch };
    return data;
  });
}

// 任务收口（成功 / 错误 / 超时）：判定交给 gen-result.mjs 的纯函数（同一套契约）。
export function finishCopyTask(root, taskKey, taskId, { apply, errMsg, usage } = {}) {
  let out = { dropped: true };
  updateApplyProfiles(root, (data) => {
    const result = completeGenResult(data, {
      kind: taskKey, taskId, now: Date.now(), ttlMs: COPY_TTL_MS, apply, errMsg, usage, locator: LEDGER_LOCATOR,
    });
    out = result.out;
    return result.next ? result.next : null;
  });
  return out;
}

// ===== 读状态（读取时校验：过期 running → 任务超时）=====
export function copyTaskState(root, scope, key) {
  const taskKey = copyTaskKey(scope, key);
  const l = loadApplyProfiles(root);
  if (l.corrupt) return { corrupt: true, task: null, draft: null };
  let task = (l.data.copyTasks || {})[taskKey] || null;
  const draft = (l.data.copyDrafts || {})[taskKey] || null;
  if (task && genExpired(task, Date.now())) {
    updateApplyProfiles(root, (data) => {
      const t = (data.copyTasks || {})[taskKey];
      if (t && t.status === 'running' && genExpired(t, Date.now())) {
        data.copyTasks[taskKey] = { ...t, status: 'error', error: '任务超时', stage: null };
      }
      return data;
    });
    task = { ...task, status: 'error', error: '任务超时', stage: null };
  }
  return { corrupt: false, task, draft };
}

// ===== 取消（taskId 匹配当前 running 才置 cancelled；在途结果被完成判定丢弃）=====
export function cancelCopyTask(root, scope, key, taskId) {
  const taskKey = copyTaskKey(scope, key);
  let cancelled = false;
  updateApplyProfiles(root, (data) => {
    const t = (data.copyTasks || {})[taskKey];
    if (!t || t.taskId !== taskId || t.status !== 'running') return null;   // 不匹配 → 放弃写（零改动）
    data.copyTasks[taskKey] = { ...t, status: 'cancelled', stage: null };
    cancelled = true;
    return data;
  });
  return cancelled;
}

// ===== 确认入库（待确认稿 → 字段；锁定期拒绝）=====
// text 缺省用稿原文；给了就用用户改过的文字（预览可改 → 确认入库的是改后的版本）。
export function confirmCopyDraft(root, scope, key, draftId, text) {
  const taskKey = copyTaskKey(scope, key);
  let out = { ok: false, status: 400, error: '未知结果' };
  updateApplyProfiles(root, (data) => {
    const draft = (data.copyDrafts || {})[taskKey];
    if (!draft) { out = { ok: false, status: 409, error: '没有待确认的文案（可能已丢弃或已确认），请重新生成' }; return null; }
    if (draftId && String(draft.id) !== String(draftId)) {
      out = { ok: false, status: 409, error: '待确认稿已更换（不是当前这一份），请重新确认' };
      return null;
    }
    // 入库的是「所见即所确认」的那份文字：**没传 text**（API 调用方）→ 落原稿；
    // **传了 text**（哪怕是空串）→ 落用户看到的那份（清空后确认就是空，不回落原稿）。
    const value = (text === undefined || text === null)
      ? String(draft.text == null ? '' : draft.text)
      : String(text).trim();
    const w = writeAiField(data, scope, key, value);
    if (!w.ok) { out = { ok: false, status: 409, error: w.error, code: w.code }; return null; }
    delete data.copyDrafts[taskKey];       // 入库与清稿同一事务
    out = { ok: true, value };
    return data;
  });
  return out;
}

// ===== 丢弃待确认稿 =====
export function discardCopyDraft(root, scope, key) {
  const taskKey = copyTaskKey(scope, key);
  let discarded = false;
  updateApplyProfiles(root, (data) => {
    if (!data.copyDrafts || !data.copyDrafts[taskKey]) return null;
    delete data.copyDrafts[taskKey];
    discarded = true;
    return data;
  });
  return discarded;
}

// ===== 运行器（服务端 fire-and-forget；结果只经完成判定落账）=====
export async function runCopyTask(root, scope, key, taskId, { lease, model } = {}) {
  const taskKey = copyTaskKey(scope, key);
  const src = copySource(root, scope);
  if (!src) return finishCopyTask(root, taskKey, taskId, { errMsg: '数据文件损坏，已停止写入：apply-profiles.json。请先人工修复或从备份恢复。' });
  if (!src.docId) {
    return finishCopyTask(root, taskKey, taskId, { errMsg: '还没有可依据的简历：请先绑定母版简历（或在字段包选择岗位简历）后再生成' });
  }
  const meta0 = scopeMeta(root, scope);
  let p;
  try { p = buildCopyPrompt({ key, source: src.fields, company: meta0.company, role: meta0.role }); }
  catch (e) { return finishCopyTask(root, taskKey, taskId, { errMsg: '文案规格缺失：' + ((e && e.message) || e) }); }
  patchCopyTask(root, taskKey, taskId, { stage: 'calling' });
  const genMeta = {};
  let raw = '';
  try {
    raw = await chat(root, p.sys, p.user, { lease, meta: genMeta });
  } catch (e) {
    return finishCopyTask(root, taskKey, taskId, { errMsg: '模型调用失败：' + ((e && e.message) || e) });
  }
  // 模型已返回：本地解析校验（usage 先落任务记录，终态由完成判定兜底带上）
  patchCopyTask(root, taskKey, taskId, { stage: 'parsing', usage: genMeta.usage ?? null });
  const parsed = parseCopyText(raw);
  if (!parsed.ok) return finishCopyTask(root, taskKey, taskId, { errMsg: parsed.error, usage: genMeta.usage ?? null });
  const draft = { id: newDraftId(), text: parsed.text, taskId: String(taskId), createdAt: new Date().toISOString() };
  // 成功落账 = 稿进「待确认」区；**不进字段**（确认才入库）。
  return finishCopyTask(root, taskKey, taskId, {
    usage: genMeta.usage ?? null,
    apply: (work) => {
      work.copyDrafts = { ...(work.copyDrafts || {}), [taskKey]: draft };
      return { ok: true, extra: { draftId: draft.id } };
    },
  });
}
