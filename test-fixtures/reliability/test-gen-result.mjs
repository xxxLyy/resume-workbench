// test-fixtures/reliability/test-gen-result.mjs — 任务完成判定的纯函数反例（设计 §4；T1/T2）
// 覆盖：业务拒绝、成功、被替代/已取消、过期超时、契约不合法、errMsg 预置错误。
// 约束：零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { completeGenResult } from '../../gen-result.mjs';

// 脚本开头切到项目根：可从任意目录直接运行。
process.chdir(fileURLToPath(new URL('../../', import.meta.url)));

const now = 10000;
const seed = () => ({
  flow: 'reviewing',
  job: {
    evidenceGen: 2, interviewGen: 4,
    interview: { chains: [{ question: '旧问题' }], generic: [] },
    genTasks: { interview: { taskId: 't-live', status: 'running', startedAt: 9000 } }
  }
});
const options = (apply) => ({ kind: 'interview', taskId: 't-live', now, ttlMs: 1000, apply });

// ① 业务拒绝：副本里的内容、批次、版本变化一律不得提交；任务收敛为 error 且原因可见。
{
  const cur = seed(), original = structuredClone(cur);
  const r = completeGenResult(cur, options((work) => {
    work.job.interviewGen = 99;
    work.job.interview = { chains: [{ question: '不得落盘' }], generic: [] };
    work.flow = 'draft';
    return { ok: false, error: '生成期间证据表已更新，请重新生成' };
  }));
  assert.deepEqual(cur, original, '回调不得改动传入的原对象');
  assert.deepEqual(r.next.job.interview, original.job.interview, '拒绝后不得替换旧面试内容');
  assert.equal(r.next.job.interviewGen, 4, '拒绝后不得推进 interviewGen');
  assert.equal(r.next.flow, 'reviewing', '拒绝后不得提交副本里的 flow 变化');
  assert.equal(r.next.job.genTasks.interview.status, 'error');
  assert.match(r.out.error, /证据表已更新/);
  assert.equal(r.out.ok, false);
}

// ② 成功：内容与版本提交，任务才写 done。
{
  const cur = seed(), original = structuredClone(cur);
  const r = completeGenResult(cur, options((work) => {
    work.job.interviewGen = 5;
    return { ok: true, extra: { interviewGen: 5 } };
  }));
  assert.deepEqual(cur, original, '成功路径也不得就地改动原对象');
  assert.equal(r.next.job.interviewGen, 5);
  assert.equal(r.next.job.genTasks.interview.status, 'done');
  assert.equal(r.next.job.genTasks.interview.error, null);
  assert.equal(r.out.interviewGen, 5);
  assert.equal(r.out.ok, true);
}

// ③ taskId 已被替代 / 任务已取消：迟到回调整条丢弃，回调不得被调用。
for (const edit of [
  (c) => { c.job.genTasks.interview.taskId = 't-new'; },
  (c) => { c.job.genTasks.interview.status = 'cancelled'; }
]) {
  const cur = seed(); edit(cur);
  let called = false;
  const r = completeGenResult(cur, options(() => { called = true; return { ok: true }; }));
  assert.equal(called, false, '迟到/已取消的回调不得被执行');
  assert.equal(r.next, null, 'next=null 表示放弃写入');
  assert.deepEqual(r.out, { dropped: true });
}

// ④ 过期：不得调用回调，任务 error 且原因可见，旧内容与批次不变。
{
  const cur = seed(); cur.job.genTasks.interview.startedAt = 8999;
  const r = completeGenResult(cur, options(() => { throw new Error('不应调用'); }));
  assert.equal(r.next.job.genTasks.interview.status, 'error');
  assert.match(r.out.error, /超时/);
  assert.equal(r.next.job.interviewGen, 4);
  assert.deepEqual(r.next.job.interview, seed().job.interview);
}

// ⑤ 契约不合法：回调没返回 {ok:boolean} → 视为拒绝，不得当成成功。
{
  const r = completeGenResult(seed(), options(() => ({})));
  assert.equal(r.out.ok, false);
  assert.match(r.out.error, /完成回调契约/);
}

// ⑥ 预置错误（errMsg）：回调不执行，任务 error，原因透出。
{
  let called = false;
  const r = completeGenResult(seed(), { kind: 'interview', taskId: 't-live', now, ttlMs: 1000, apply: () => { called = true; return { ok: true }; }, errMsg: '模型调用失败：boom' });
  assert.equal(called, false, 'errMsg 路径不得执行回调');
  assert.equal(r.out.ok, false);
  assert.equal(r.out.error, '模型调用失败：boom');
  assert.equal(r.next.job.genTasks.interview.status, 'error');
}

// ⑦ 任务不存在（文档不是岗位草稿）：当作丢弃，不得凭空造出任务记录。
{
  const r = completeGenResult({ job: { genTasks: {} } }, options(() => ({ ok: true })));
  assert.equal(r.next, null);
  assert.deepEqual(r.out, { dropped: true });
}

console.log('PASS TASK-01: rejected, success, cancelled, replaced, expired, malformed, errMsg, missing-task');
