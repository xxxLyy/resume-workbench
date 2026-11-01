// gen-result.mjs — 任务完成判定的纯函数（设计 §4；T1/T2）
// 契约：
//   1) 完成判定在独立工作副本上运行；业务拒绝不得提交副本里的内容、批次或版本变化。
//   2) 业务回调显式返回 {ok:true,extra} 或 {ok:false,error}；不得再靠自行改写任务状态暗示结果。
//   3) 只有成功落账才写 done；拒绝写 error 并给出可见原因。
//   4) next=null 表示放弃写入（迟到/被替代/已取消），不是「删除文档元数据」；超时例外：写入 error 状态并推进 next。
// 约束：零 I/O、零依赖；调用方负责把 next 写回元数据。
const copy = (x) => JSON.parse(JSON.stringify(x));

// cur：当前文档元数据（不会就地修改）。
// options: { kind, taskId, now, ttlMs, apply, errMsg }
// 返回：{ next, out } —— next 为要落盘的元数据或 null（放弃写入）；out 为对外结果。
export function completeGenResult(cur, { kind, taskId, now, ttlMs, apply, errMsg }) {
  const gt = cur?.job?.genTasks?.[kind];
  // 迟到回调 / taskId 已被替代 / 任务已取消：整条丢弃，不碰任何状态（零落账）。
  if (!gt || gt.taskId !== taskId || gt.status !== 'running') {
    return { next: null, out: { dropped: true } };
  }
  // 拒绝分支：从原 cur 生成，绝不采用回调的工作副本——副本里的内容、批次、版本变化一律不提交。
  // dropped=true 用于「结果不落账但原因可见」的超时路径：对外仍是 dropped（既有 /job/generate 409 形状不变）。
  const reject = (error, dropped = false) => {
    const next = copy(cur);
    next.job.genTasks[kind] = { ...gt, status: 'error', error };
    return { next, out: dropped ? { dropped: true, error } : { ok: false, error } };
  };
  if (typeof gt.startedAt === 'number' && gt.startedAt + ttlMs < now) {
    return reject('任务超时', true);   // 已超过任务期限：结果不落账
  }
  if (errMsg !== undefined) return reject(String(errMsg));   // 预置错误（模型失败/解析失败等）：回调不执行
  // 成功路径：在独立副本上跑回调；只有回调明确成功才提交该副本。
  const work = copy(cur);
  const result = apply ? apply(work) : { ok: true, extra: {} };
  if (!result || typeof result.ok !== 'boolean') return reject('完成回调契约不合法');
  if (!result.ok) return reject(String(result.error || '生成结果不再适用'));
  work.job.genTasks[kind] = { ...gt, status: 'done', error: null };
  return { next: work, out: { ok: true, job: work.job, ...(result.extra || {}) } };
}
