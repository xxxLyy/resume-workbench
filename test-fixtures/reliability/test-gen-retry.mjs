// test-gen-retry.mjs — S4b-A P3：批次重试（服务端幂等重试端点）
// 合同：
//   ① POST /job/gen-retry?id&kind=changes&batch=N&taskId=T：只重跑指定失败批——守卫照 gen-start：
//      先借 AI 槽（被拒零写入）、updateMetaAll 事务内并发闸（全库同类 ≤1/合计 ≤2）+ taskId 匹配 +
//      任务可重试态（done/error 且 batches.failed 含该批）+ batchPlan 计划存在；任一不满足 409/400。
//   ② 重试成功：该批从 failed 摘除、done+1、resultOps 合并（原成功批 + 重试批）→ 走既有 finishGenTask
//      收口重新落账（新 gen 的待审候选=全部成功批之并集；accepted/rejected 历史不被覆盖，todos 按
//      section+question 去重不重复追加）；全部批成功 → 终态 done 且 failed=[]。
//   ③ 重试失败/异常：恢复 done 终态（成功批候选不回滚），失败原因刷新进 batches.failed 该批条目；
//      usage 照实累计（失败批的服务商调用已发生）；可再次重试。
//   ④ 进度：重试期间 batches.retrying=N（数字）随 /job/changes 暴露，终态移除该键；stages 保持原运行明细。
//   ⑤ 凭证合同：重试任务与 gen-start 同池同闸——池满 429 且零状态写入。
// HTTP 类夹具：隔离根 + 合成岗位草稿（带 zones）+ 本机桩 LLM（响应队列按批计数应答）；零真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-genr-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const ZW1 = 'zaaaaaa01', ZW2 = 'zaaaaaa02', ZP1 = 'zaaaaaa03', ZP2 = 'zaaaaaa04', ZP3 = 'zaaaaaa05', ZP4 = 'zaaaaaa06';
const PARA_W1 = '负责交易系统，把延迟从 80ms 降到 12ms';
const PARA_W2 = '负责订单中台，支撑日订单十二万';
const PARA_P1 = '项目甲：网关压测平台，覆盖三十万 QPS';
const PARA_P2 = '项目乙：链路追踪系统，覆盖全链路';
const PARA_P3 = '项目丙：灰度发布工具';
const PARA_P4 = '项目丁：监控告警面板';
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'),
  `<!doctype html><html><head><title>t</title></head><body><h1>合成</h1>`
  + `<h2>工作经历</h2><p data-zid="${ZW1}">${PARA_W1}</p><p data-zid="${ZW2}">${PARA_W2}</p>`
  + `<h2>项目经历</h2><p data-zid="${ZP1}">${PARA_P1}</p><p data-zid="${ZP2}">${PARA_P2}</p>`
  + `<p data-zid="${ZP3}">${PARA_P3}</p><p data-zid="${ZP4}">${PARA_P4}</p></body></html>`);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    jd: '要求：交易系统与订单经验；网关与链路追踪经验；灰度发布与监控告警经验',
    zones: { [ZW1]: { zone: 'work' }, [ZW2]: { zone: 'work' }, [ZP1]: { zone: 'project' }, [ZP2]: { zone: 'project' }, [ZP3]: { zone: 'project' }, [ZP4]: { zone: 'project' } },
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} } }
}, null, 2));

// —— 桩 LLM：analyze 固定 3 条可定位要求；rewrite 调用按 responses 队列应答（空队列=默认成功批 0）——
const REQS_FULL = ['交易系统与订单经验', '网关与链路追踪经验', '灰度发布与监控告警经验'];
const OPS_B0 = { summary: '工作段对齐交易系统', changes: [{ section: '工作经历', kind: 'replace', zid: ZW1, before: PARA_W1, after: '负责交易系统与网关优化，把延迟从 80ms 降到 12ms', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [{ section: '工作经历', question: '缺少团队规模数据', why: 'JD 要求带团队经验' }] };
const OPS_B1 = { summary: '项目段对齐网关与追踪', changes: [{ section: '项目经历', kind: 'replace', zid: ZP1, before: PARA_P1, after: '项目甲：网关压测平台，覆盖三十万 QPS 与突发流量', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [{ section: '项目经历', question: '缺少压测口径', why: '量化可信度' }] };
const OPS_B2 = { summary: '监控段补充', changes: [{ section: '项目经历', kind: 'replace', zid: ZP4, before: PARA_P4, after: '项目丁：监控告警面板与值班升级', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [] };
const BROKEN = '抱歉，这不是修改操作 JSON。';
const USAGE_A = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };
const USAGE_B = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const okResp = (obj, extra = {}) => ({ content: JSON.stringify(obj), usage: USAGE_B, ...extra });
const brokenResp = (extra = {}) => ({ content: BROKEN, usage: USAGE_B, ...extra });
let responses = [];   // 每个 rewrite（批）调用 shift 一项；空 → 默认 okResp(OPS_B0)
let chatDelayMs = 0;  // /ai/chat 占位用延迟（池满用例）
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let sys = '';
    try { sys = JSON.parse(b).messages.find((m) => m.role === 'system').content; } catch {}
    const ok = (content, usage, delayMs = 0) => {
      const body = { choices: [{ message: { content } }] };
      if (usage) body.usage = usage;
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }, delayMs);
    };
    if (String(sys).includes('需求分析师')) return ok(JSON.stringify({ requirements: REQS_FULL }), USAGE_A);
    if (String(sys).includes('简历定制编排器')) {
      const r = responses.length ? responses.shift() : okResp(OPS_B0);
      const body = { choices: [{ message: { content: r.content } }], usage: r.usage };
      return ok(r.content, r.usage, r.delayMs || 0);
    }
    if (String(sys).includes('证据分析')) {
      return ok(JSON.stringify({ evidence: [{ req: '要求一：交易系统高并发', status: 'covered', refHints: [{ type: 'para', zid: ZW1, title: '工作经历', quote: PARA_W1 }] }] }), { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 });
    }
    return ok('{}', null, chatDelayMs);   // /ai/chat 占位请求：延迟占住 AI 槽（池满用例）
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model-x' }]
}));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { stub.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const base = `http://127.0.0.1:${port}`;
const view = async () => { const r = await fetch(base + '/job/changes?id=' + DOC); return r.json(); };
const taskOf = (v) => v.job.genTasks.changes;
const postRaw = async (p) => { const r = await fetch(base + p, { method: 'POST' }); return { status: r.status, json: await r.json().catch(() => null) }; };
const genStart = async () => postRaw('/job/gen-start?id=' + DOC + '&kind=changes');
const genRetry = async (batch, taskId) => postRaw('/job/gen-retry?id=' + DOC + '&kind=changes&batch=' + batch + (taskId !== undefined ? '&taskId=' + encodeURIComponent(taskId) : ''));
async function waitTerminal(kind = 'changes', timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const v = await view();
    last = v.job.genTasks[kind];
    if (last && last.status !== 'running') return { task: last, view: v };
    await new Promise((r) => setTimeout(r, 60));
  }
  fail('任务 20s 未结束：' + JSON.stringify(last) + '\n' + serverLog.slice(-600));
}
const pendingZids = (v) => (v.job.changes || []).filter((c) => c.status === 'pending').map((c) => c.zid);

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== A：批 2 失败 → 重试成功 → failed 摘除、全批成功收口、合并落账 =====
  {
    responses = [okResp(OPS_B0), okResp(OPS_B1), brokenResp()];   // 原始运行：批 0/1 成功、批 2 失败
    await genStart();
    let { task, view: v } = await waitTerminal();
    assert.equal(task.status, 'done', '部分成功 → done');
    assert.deepEqual(task.batches, { total: 3, done: 2, failed: [{ batch: 2, error: '模型输出无法解析为修改操作' }] });
    assert.equal(pendingZids(v).length, 2, '原始运行落账 2 条成功批候选');
    const usageBefore = { ...task.usage };

    // 守卫先行（不触发重跑）：taskId 不匹配 / 批号不在失败清单 / 非法批号
    assert.equal((await genRetry(2, 't-wrong')).status, 409, 'taskId 不匹配 → 409');
    assert.equal((await genRetry(0, task.taskId)).status, 409, '批 0 不在失败清单 → 409');
    assert.equal((await genRetry('abc', task.taskId)).status, 400, '非法批号 → 400');
    assert.equal((await postRaw('/job/gen-retry?id=' + DOC + '&kind=evidence&batch=2&taskId=' + task.taskId)).status, 400, 'kind 非 changes → 400');
    let vNow = await view();
    assert.equal(vNow.job.genTasks.changes.status, 'done', '被拒的重试零状态写入');

    // 正式重试：批 2 成功
    responses = [okResp(OPS_B2, { delayMs: 1200 })];
    const st = await genRetry(2, task.taskId);
    assert.equal(st.status, 200, '重试应受理：' + JSON.stringify(st.json));
    assert.equal(st.json.taskId, task.taskId, '重试沿用原 taskId');
    // 重试期间：running + retrying 标记（进度「重试第 3/3 批」的数据源）
    let sawRetrying = null;
    const dl = Date.now() + 8000;
    while (Date.now() < dl) {
      vNow = await view();
      const t = taskOf(vNow);
      if (t && t.status === 'running' && t.batches && t.batches.retrying === 2) { sawRetrying = t; break; }
      if (t && t.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(sawRetrying, '重试期间应可见 batches.retrying=2（最后：' + JSON.stringify(taskOf(vNow)) + '）');
    assert.equal(sawRetrying.stage, 'calling', '重试批调用点粗粒度 stage=calling');
    ({ task, view: v } = await waitTerminal());
    // A1：终态——全批成功收口（既有 finishGenTask 合同），retrying 键移除
    assert.equal(task.status, 'done', '全批成功 → done，实际：' + JSON.stringify(task));
    assert.deepEqual(task.batches, { total: 3, done: 3, failed: [] }, '失败批已摘除、done 补齐');
    assert.equal(task.batches.retrying, undefined, '终态不再带 retrying 标记');
    assert.deepEqual(task.usage, { prompt: usageBefore.prompt + 10, completion: usageBefore.completion + 5, total: usageBefore.total + 15 }, 'usage 累计重试调用');
    assert.deepEqual(task.stages.map((s) => s.stage), ['analyze', 'locate', 'rewrite', 'validate', 'assemble'], 'stages 保持原运行明细（重试不改写 stages）');
    // A2：合并落账——新 gen 候选 = 全部成功批之并集（原 2 条 + 重试批 1 条）；旧 pending 被 superseded
    const pend = (v.job.changes || []).filter((c) => c.status === 'pending');
    assert.deepEqual(pend.map((c) => c.zid).sort(), [ZW1, ZP1, ZP4].sort(), '待审候选=三批并集');
    assert.equal(pend.every((c) => c.gen === 2), true, '重试落账为一次新 gen（一次 assemble）');
    assert.equal((v.job.changes || []).filter((c) => c.status === 'superseded').length, 2, '原 gen1 pending 被 superseded');
    assert.equal(v.job.todos.length, 2, 'todos 不重复追加（按 section+question 去重）');
  }

  // ===== B：重试失败 → done 恢复 + 失败原因刷新；再次重试可成功 =====
  {
    responses = [okResp(OPS_B0), brokenResp(), okResp(OPS_B2)];   // 新一代：批 1 失败
    await genStart();
    let { task } = await waitTerminal();
    assert.equal(task.batches.failed[0].batch, 1, '批 1 失败登记');
    const pendBefore = pendingZids((await view())).length;
    const usageBefore = { ...task.usage };
    // 重试失败：done 恢复、错误刷新、usage 照记、候选不回滚
    responses = [brokenResp()];
    assert.equal((await genRetry(1, task.taskId)).status, 200);
    ({ task } = await waitTerminal());
    assert.equal(task.status, 'done', '重试失败恢复 done（成功批候选不回滚）');
    assert.equal(task.batches.done, 2, 'done 计数不变');
    assert.equal(task.batches.failed.length, 1, '失败批仍在清单');
    assert.equal(task.batches.failed[0].batch, 1, '失败的是批 1');
    assert.ok(task.batches.failed[0].error.includes('重试失败'), '失败原因应刷新为重试错误：' + JSON.stringify(task.batches.failed));
    assert.ok(task.usage.total > usageBefore.total, '失败重试的服务商调用照实计入 usage');
    assert.equal(pendingZids((await view())).length, pendBefore, '重试失败不改变候选');
    assert.equal(task.batches.retrying, undefined, '失败后 retrying 标记移除');
    // 再次重试成功
    responses = [okResp(OPS_B1)];
    assert.equal((await genRetry(1, task.taskId)).status, 200);
    const r2 = await waitTerminal();
    assert.deepEqual(r2.task.batches, { total: 3, done: 3, failed: [] }, '再次重试成功 → 全批收口');
    assert.deepEqual(pendingZids(r2.view).sort(), [ZW1, ZP1, ZP4].sort(), '三批并集落账');
  }

  // ===== C：并发闸与池满——重试与 gen-start 同池同闸，拒绝零写入 =====
  {
    responses = [okResp(OPS_B0), brokenResp(), okResp(OPS_B2)];
    await genStart();
    const { task } = await waitTerminal();
    // 池满：两个同步 /ai/chat 占满 aiPool → gen-retry 借不到槽 429，且任务状态零写入
    chatDelayMs = 3000;
    const chat = (msg) => fetch(base + '/ai/chat?id=' + DOC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) }).catch(() => null);
    const p1 = chat('占位一'), p2 = chat('占位二');
    await new Promise((r) => setTimeout(r, 600));
    const refused = await genRetry(2, task.taskId);
    assert.equal(refused.status, 429, 'AI 槽占满 → 429，实际 ' + refused.status);
    assert.equal(taskOf(await view()).status, 'done', '被拒重试零状态写入');
    await Promise.all([p1, p2]);
    // 同类并发闸：另一文档的 changes 任务运行中 → 重试 409（照 startGenTask 全库同类 ≤1）
    // 用同文档新 gen-start 模拟「任务已被新任务取代」路径：taskId 不匹配
    responses = [okResp(OPS_B0), okResp(OPS_B1), okResp(OPS_B2)];
    await genStart();
    await waitTerminal();
    assert.equal((await genRetry(2, task.taskId)).status, 409, '新任务已取代旧 taskId → 409');
  }

  console.log('✅ 批次重试：守卫照 gen-start（借槽先行/并发闸/taskId/可重试态）、成功批摘除并合并收口、失败恢复 done 可再试、retrying 进度可见、usage 照实累计');
} finally {
  cleanup();
}
