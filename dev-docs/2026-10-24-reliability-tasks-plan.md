# 任务完成状态修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 证据批次变化、取消、超时或迟到回调均不能误报成功或覆盖旧结果。

**Architecture:** 把完成判定提取为很小的纯函数，使用可丢弃的工作副本承接现有回调；仅成功分支提交该副本。服务端继续通过既有元数据锁落账，保留 taskId 与并发业务规则。

**Tech Stack:** Node ESM、内置 assert、现有 tx.mjs、现有四套件；新增依赖 0。

---

设计：[/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md) §4；验收 T1/T2。当前为待执行计划，下面代码只存在本文中，尚未写入实现或运行。

## 文件与执行边界

| 动作 | 精确文件 | 职责 |
|---|---|---|
| Create | `/Users/xxxly/resume/gen-result.mjs` | 纯完成判定；零 I/O |
| Create | `/Users/xxxly/resume/test-fixtures/reliability/test-gen-result.mjs` | 状态、内容不变量及失败副本的独立验证 |
| Modify | `/Users/xxxly/resume/server.mjs` | finishGenTask、runGenTask 三个完成回调，由服务端 owner 统一修改 |
| Modify | `/Users/xxxly/resume/test-structure.sh` | 显式调用新增单测，由验证 owner 修改 |
| Modify | `/Users/xxxly/resume/test-editor.mjs` | 本地延迟模型桩的批次更新反例，由验证 owner 修改 |

前置：总计划启动检查与验证基础完成。纯函数可并行准备；server 接线与资源包修改 runner 时串行。本文不修改 GEN_TTL_MS、GEN_KINDS 或 startGenTask 的业务规则。

## Task TASK-01：先建立完成判定反例

- [ ] 在上述 test-gen-result.mjs 写入以下完整 Node 断言。

```js
import assert from 'node:assert/strict';
import { completeGenResult } from '../../gen-result.mjs';

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

{
  const cur = seed(), original = structuredClone(cur);
  const r = completeGenResult(cur, options((work) => {
    work.job.interviewGen = 99;
    work.job.interview = { chains: [{ question: '不得落盘' }] };
    return { ok: false, error: '生成期间证据表已更新，请重新生成' };
  }));
  assert.deepEqual(cur, original);
  assert.deepEqual(r.next.job.interview, original.job.interview);
  assert.equal(r.next.job.interviewGen, 4);
  assert.equal(r.next.job.genTasks.interview.status, 'error');
  assert.match(r.out.error, /证据表已更新/);
}
{
  const r = completeGenResult(seed(), options((work) => {
    work.job.interviewGen = 5;
    return { ok: true, extra: { interviewGen: 5 } };
  }));
  assert.equal(r.next.job.interviewGen, 5);
  assert.equal(r.next.job.genTasks.interview.status, 'done');
  assert.equal(r.out.interviewGen, 5);
}
for (const edit of [
  (c) => { c.job.genTasks.interview.taskId = 't-new'; },
  (c) => { c.job.genTasks.interview.status = 'cancelled'; }
]) {
  const cur = seed(); edit(cur);
  let called = false;
  const r = completeGenResult(cur, options(() => { called = true; return { ok: true }; }));
  assert.equal(called, false);
  assert.equal(r.next, null);
  assert.deepEqual(r.out, { dropped: true });
}
{
  const cur = seed(); cur.job.genTasks.interview.startedAt = 8999;
  const r = completeGenResult(cur, options(() => { throw new Error('不应调用'); }));
  assert.equal(r.next.job.genTasks.interview.status, 'error');
  assert.match(r.out.error, /超时/);
  assert.equal(r.next.job.interviewGen, 4);
}
{
  const r = completeGenResult(seed(), options(() => ({})));
  assert.equal(r.out.ok, false);
  assert.match(r.out.error, /完成回调契约/);
}
console.log('PASS TASK-01: rejected, success, cancelled, replaced, expired, malformed');
```

- [ ] 运行 `cd /Users/xxxly/resume && node test-fixtures/reliability/test-gen-result.mjs`。预期首次非零：新增模块尚不存在；禁止跳过。

## Task TASK-02：实现纯完成判定

- [ ] 新建 gen-result.mjs，采用以下实现；拒绝分支必须从原 cur 生成，不能采用回调工作副本。

```js
const copy = (x) => JSON.parse(JSON.stringify(x));

export function completeGenResult(cur, { kind, taskId, now, ttlMs, apply, errMsg }) {
  const gt = cur?.job?.genTasks?.[kind];
  if (!gt || gt.taskId !== taskId || gt.status !== 'running') {
    return { next: null, out: { dropped: true } };
  }
  const reject = (error) => {
    const next = copy(cur);
    next.job.genTasks[kind] = { ...gt, status: 'error', error };
    return { next, out: { ok: false, error } };
  };
  if (typeof gt.startedAt === 'number' && gt.startedAt + ttlMs < now) {
    return reject('任务超时');
  }
  if (errMsg !== undefined) return reject(String(errMsg));
  const work = copy(cur);
  const result = apply ? apply(work) : { ok: true, extra: {} };
  if (!result || typeof result.ok !== 'boolean') return reject('完成回调契约不合法');
  if (!result.ok) return reject(String(result.error || '生成结果不再适用'));
  work.job.genTasks[kind] = { ...gt, status: 'done', error: null };
  return { next: work, out: { ok: true, job: work.job, ...(result.extra || {}) } };
}
```

- [ ] 重跑 TASK-01 命令，预期退出 0 并输出 PASS；把当前失败控制分支临时恢复为接受 work，断言应失败，然后恢复正确实现。
- [ ] 验证 owner 在 test-structure.sh 的现有 Node 测试区显式增加 `node ./test-fixtures/reliability/test-gen-result.mjs`；该脚本开头已切到项目根，不新增另一套 APP_ROOT 变量。
- [ ] 运行 `bash test-structure.sh`，预期相关纯函数及既有状态断言通过；保留已有失败的准确记录。
- [ ] 提交：`git add gen-result.mjs test-fixtures/reliability/test-gen-result.mjs test-structure.sh`，再 `git commit -m 'fix(tasks): make completion outcomes explicit and isolated'`。共享测试文件尚未获 owner 集成时，先提交模块与独立测试，接线作为后续独立提交，不能抢改。

## Task TASK-03：服务端统一完成出口

- [ ] 服务端 owner 导入 `completeGenResult`；替换 finishGenTask 的内部实现为下列内容，保留已有函数签名，防止来源/资源包接口漂移。

```js
function finishGenTask(id, kind, taskId, apply, errMsg) {
  let out = { dropped: true };
  updateMetaAll(root, (all) => {
    const result = completeGenResult(all[id], {
      kind, taskId, now: Date.now(), ttlMs: GEN_TTL_MS, apply, errMsg
    });
    out = result.out;
    return result.next ? { ...all, [id]: result.next } : null;
  });
  return out;
}
```

`updateMetaAll` 返回 null 时不写文件，比把旧 cur 原样返回更准确地实现“迟到回调零落账”。该转换保持现有元数据跨进程锁。

- [ ] 面试完成回调采用先校验、后修改，再显式成功的形态：

```js
return finishGenTask(id, kind, taskId, (cur) => {
  if ((Number(cur.job.evidenceGen) || 0) !== evGenAtStart) {
    return { ok: false, error: '生成期间证据表已更新，请重新生成' };
  }
  cur.job.interview = iv;
  cur.job.interviewGen = gen;
  cur.job.interviewBaseHash = contentHash(html);
  cur.job.interviewEvidenceGen = evGenAtStart;
  return { ok: true, extra: {
    interview: iv.chains.length + iv.generic.length,
    interviewGen: gen, dropped: iv.dropped
  } };
});
```

- [ ] 证据成功回调保留现有两次赋值，但返回改为 `return { ok: true, extra: { evidence: ev.length, evidenceGen: gen } };`。
- [ ] changes 成功回调完整替换为：

```js
return finishGenTask(id, kind, taskId, (cur) => ({
  ok: true,
  extra: applyChangesResult(cur, ops, {
    scope, html, paras: parasStart, mats: confirmedMats, brief: m0.job.brief || null
  })
}));
```

- [ ] 运行 `rg -n 'finishGenTask\(' server.mjs` 检查全部调用点：错误参数调用保持，所有业务 apply 回调均显式返回结果；不得留下旧的 `return {}` 拒绝约定。
- [ ] 运行 `node --check server.mjs` 与 TASK-01 单测。前者只做语法门槛，不作为浏览器/并发行为证据。

## Task TASK-04：完整本地桩验证与同步兼容入口

本任务只向现有 /Users/xxxly/resume/test-editor.mjs 的 Node 隔离测试区新增代码，不创建另一套测试入口。生产实现仍只使用 TASK-02/TASK-03 的纯副本协议，不增加测试用完成回调或调试路由。

**前置：** TASK-03 服务端接线、来源包SRC-02的新prompt/parser与sources接线、资源包RES-04的runner所有权、验证包的spawnServer/退出码/子进程回收均已完成。此综合反例在上述依赖后运行，TASK-01…03可先行。下面桩明确识别新sourceZid协议，不通过兼容旧空来源来放宽解析器。使用test-editor.mjs已有fs/path/os/http、seedRoot、txDoc、spawnServer、updateMeta；assert和parseEvidence在函数内明确导入。

- [ ] **Step 1（4 分钟）：在 test-editor.mjs 中加入下述完整局部 harness；依赖完成后执行，失败反向验证按Step 3进行。**

把函数放在已有 seedRoot/spawnServer 定义之后；执行调用放在 Chromium 探测之前，使本地模型任务行为与浏览器环境可用性分开。函数内所有文件均位于自身 mkdtemp 创建的 taskRoot。配置只写本地桩的合成地址与假 key，不读取真实配置。

~~~js
async function runTaskCompletionIntegration() {
  const { default: assert } = await import('node:assert/strict');
  const { parseEvidence } = await import('./evidence.mjs');
  const taskRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-task-result-'));
  const DOC = 'fixture';
  const PARA = {
    zid: 'z11111111',
    text: '负责存储层改造，QPS 从 300 提升到 5000'
  };
  const interviewRequests = [];
  const stubErrors = [];
  let evidenceCalls = 0;
  let changesCalls = 0;
  let service = null;

  async function waitFor(check, message, limit = 15000) {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
  }

  function sendChat(res, content) {
    assert.equal(res.destroyed, false, '桩响应连接不能已断开');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }]
    }));
  }

  function interviewReply(slot, label) {
    const user = slot.messages.find(message => message.role === 'user')?.content || '';
    const fragment = /【简历片段 sourceZid=(z[0-9a-f]{8})】\n([^\n]+)/.exec(user);
    const index = /evIndex=(\d+)/.exec(user);
    assert.ok(fragment && index, '面试 prompt 必须包含本次真实来源和原始 evIndex');
    assert.equal(fragment[1], PARA.zid);
    assert.equal(fragment[2], PARA.text);
    return {
      chains: [{
        evIndex: Number(index[1]),
        question: label,
        followUp: '怎样验证个人贡献',
        answerPoints: [{
          text: '说明存储层改造中的个人贡献',
          quote: fragment[2]
        }]
      }],
      generic: [{
        question: '自我介绍',
        answerPoints: [{
          text: '说明岗位相关经历',
          quote: fragment[2],
          sourceZid: fragment[1]
        }]
      }]
    };
  }

  const llm = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.once('error', error => {
      stubErrors.push(String(error.message || error));
      res.destroy();
    });
    req.once('end', () => {
      try {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        const system = messages.find(message => message.role === 'system')?.content || '';
        const user = messages.find(message => message.role === 'user')?.content || '';

        if (system.includes('面试官')) {
          // 只在 end 且 JSON 已解析后登记；等待方据此确认请求体完整送达。
          interviewRequests.push({
            number: interviewRequests.length + 1,
            messages,
            res,
            released: false,
            sent: false
          });
          return;
        }
        if (system.includes('证据分析')) {
          evidenceCalls++;
          assert.ok(String(user).includes(PARA.zid), '证据输入应携带真实段落 ID');
          sendChat(res, {
            evidence: [{
              req: '后端存储经验',
              status: 'covered',
              refHints: [{
                type: 'para', zid: PARA.zid, title: '工作经历', quote: '负责存储层改造'
              }]
            }]
          });
          return;
        }
        if (system.includes('简历定制编排器')) {
          changesCalls++;
          sendChat(res, {
            summary: '精简表达',
            changes: [{
              section: '工作经历', entry: '', kind: 'replace',
              before: '负责存储层改造', after: '负责存储层架构改造',
              reason: '明确改造对象', source: '母版', level: 'normal'
            }],
            todos: []
          });
          return;
        }
        throw new Error('本地模型桩收到未登记的 system');
      } catch (error) {
        stubErrors.push(String(error.message || error));
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(error.message || error) }));
      }
    });
  });

  async function waitInterviewReceived(number) {
    return waitFor(
      () => interviewRequests[number - 1] || null,
      '未收到第 ' + number + ' 个完整面试请求'
    );
  }

  async function releaseInterview(number, label) {
    const slot = await waitInterviewReceived(number);
    assert.equal(slot.released, false, '同一面试请求不得放行两次');
    assert.equal(slot.res.destroyed, false, '放行前桩连接应仍存活');
    slot.released = true;
    const sent = new Promise((resolve, reject) => {
      slot.res.once('finish', resolve);
      slot.res.once('error', reject);
    });
    sendChat(slot.res, interviewReply(slot, label));
    await sent;
    slot.sent = true;
  }

  function readJob() {
    const metadata = JSON.parse(fs.readFileSync(path.join(taskRoot, 'docs-meta.json'), 'utf8'));
    assert.ok(metadata[DOC] && metadata[DOC].job, '隔离岗位文档必须存在');
    return metadata[DOC].job;
  }

  async function api(pathname, body = {}, method = 'POST') {
    assert.ok(service, '隔离服务必须已启动');
    const response = await fetch(service.base + pathname, {
      method,
      ...(method === 'GET' ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }),
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(pathname + ' 未返回 JSON：HTTP ' + response.status + ' / ' + text.slice(0, 160)); }
    return { ...data, httpStatus: response.status };
  }

  async function startTask(kind, expectedRequestNumber) {
    const result = await api('/job/gen-start?id=' + DOC + '&kind=' + kind, {});
    assert.equal(result.httpStatus, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(typeof result.taskId, 'string');
    const task = readJob().genTasks[kind];
    assert.equal(task.taskId, result.taskId, '启动回执必须对应当前元数据任务身份');
    if (kind === 'interview') await waitInterviewReceived(expectedRequestNumber);
    return result.taskId;
  }

  async function waitTask(kind, taskId, expectedStatus) {
    return waitFor(() => {
      const task = readJob().genTasks[kind];
      assert.equal(task.taskId, taskId, '轮询不得误用另一任务的状态');
      if (task.status === expectedStatus) return task;
      if (task.status !== 'running') {
        throw new Error('任务提前进入意外终态：' + JSON.stringify(task));
      }
      return false;
    }, kind + ' / ' + taskId + ' 未进入 ' + expectedStatus);
  }

  // 迟到丢弃不产生新任务终态，故采用“桩已发送 + 服务端往返屏障 + 持续状态核对”。
  // 这检查真实晚到请求后的可观察不变量，不把 res.finish 等同 runner 已完成。
  async function assertPreservedAfterLateReply(taskId, expectedInterview, expectedGen, observeMs = 600) {
    const deadline = Date.now() + observeMs;
    do {
      const current = await api('/job/changes?id=' + DOC, undefined, 'GET');
      assert.equal(current.httpStatus, 200);
      assert.equal(current.ok, true);
      const job = readJob();
      assert.equal(job.genTasks.interview.taskId, taskId);
      assert.equal(job.genTasks.interview.status, 'running');
      assert.deepEqual(job.interview, expectedInterview);
      assert.equal(job.interviewGen, expectedGen);
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
  }

  async function stopOwnService() {
    if (!service || service.child.exitCode !== null || service.child.signalCode !== null) return;
    const child = service.child;
    const closed = new Promise(resolve => child.once('close', resolve));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
    try {
      child.kill('SIGTERM');
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    // 绑定失败也进入本函数 finally，清理本轮临时根与模型桩。
    await new Promise((resolve, reject) => {
      llm.once('error', reject);
      llm.listen(0, '127.0.0.1', () => {
        llm.removeListener('error', reject);
        resolve();
      });
    });
    llm.on('error', error => { stubErrors.push(String(error.message || error)); });
    const initialEvidence = parseEvidence(JSON.stringify({
      evidence: [{
        req: '后端存储经验', status: 'covered',
        refHints: [{ type: 'para', zid: PARA.zid, title: '工作经历', quote: '负责存储层改造' }]
      }]
    }), { gen: 1, mats: [], paras: [PARA] });
    const initialInterview = {
      chains: [{ evIndex: 0, zid: PARA.zid, question: '旧问题', answerPoints: [{ text: '旧要点', quote: '' }] }],
      generic: [], dropped: 0
    };
    const fakeRender = seedRoot(taskRoot, {
      [DOC]: txDoc(DOC, '<p data-zid="' + PARA.zid + '">' + PARA.text + '</p>', '')
    }, {
      [DOC]: {
        kind: 'job', flow: 'reviewing', schemaVersion: 2, rev: 0,
        zones: { [PARA.zid]: { zone: 'work', status: 'confirmed' } },
        job: {
          status: 'draft', materials: [], changes: [], todos: [],
          sourceSnap: '', sourceHash: '',
          evidence: initialEvidence, evidenceGen: 1,
          interview: initialInterview, interviewGen: 4,
          genTasks: {
            evidence: { taskId: null, status: 'idle' },
            interview: { taskId: null, status: 'idle' },
            changes: { taskId: null, status: 'idle' }
          }
        }
      }
    });
    fs.writeFileSync(path.join(taskRoot, 'config.json'), JSON.stringify({
      active: 0,
      profiles: [{
        name: 'local-controlled-stub',
        baseURL: 'http://127.0.0.1:' + llm.address().port + '/v1',
        apiKey: 'stub-key', model: 'stub-task-result', timeoutMs: 60000
      }]
    }));
    service = await spawnServer(taskRoot, { RESUME_RENDER_BIN: fakeRender });

    // T1：先等面试请求体完整送达，再更新证据，最后放行旧面试。
    const beforeT1 = structuredClone(readJob());
    const firstInterviewId = await startTask('interview', 1);
    assert.equal(readJob().genTasks.interview.status, 'running');
    const evidenceId = await startTask('evidence');
    await waitTask('evidence', evidenceId, 'done');
    assert.equal(readJob().evidenceGen, beforeT1.evidenceGen + 1);
    await releaseInterview(1, '不得覆盖旧结果的面试');
    const rejected = await waitTask('interview', firstInterviewId, 'error');
    assert.match(rejected.error, /证据表已更新/);
    assert.deepEqual(readJob().interview, beforeT1.interview);
    assert.equal(readJob().interviewGen, beforeT1.interviewGen);

    // 正例：新证据稳定后明确重试，新的任务身份成功。
    const retryId = await startTask('interview', 2);
    assert.notEqual(retryId, firstInterviewId);
    await releaseInterview(2, '稳定证据后的新问题');
    await waitTask('interview', retryId, 'done');
    assert.equal(readJob().interviewGen, beforeT1.interviewGen + 1);
    assert.equal(readJob().interview.chains[0].question, '稳定证据后的新问题');

    // T2：取消旧任务，然后让新任务接棒；旧请求此时仍由桩持有。
    const beforeCancel = structuredClone(readJob());
    const cancelledId = await startTask('interview', 3);
    const cancelled = await api('/job/gen-cancel?id=' + DOC + '&kind=interview&taskId=' + cancelledId, {});
    assert.equal(cancelled.httpStatus, 200);
    assert.equal(cancelled.ok, true);
    assert.equal(readJob().genTasks.interview.taskId, cancelledId);
    assert.equal(readJob().genTasks.interview.status, 'cancelled');
    assert.deepEqual(readJob().interview, beforeCancel.interview);
    assert.equal(readJob().interviewGen, beforeCancel.interviewGen);
    const replacementId = await startTask('interview', 4);
    assert.notEqual(replacementId, cancelledId);
    await releaseInterview(3, '已取消任务的迟到问题');
    await assertPreservedAfterLateReply(replacementId, beforeCancel.interview, beforeCancel.interviewGen);
    await releaseInterview(4, '接棒任务的新问题');
    await waitTask('interview', replacementId, 'done');
    assert.equal(readJob().interview.chains[0].question, '接棒任务的新问题');
    assert.equal(readJob().interviewGen, beforeCancel.interviewGen + 1);

    // T2：只老化当前正确 taskId，完成回调必须走超时拒绝而非成功。
    const beforeTimeout = structuredClone(readJob());
    const timeoutId = await startTask('interview', 5);
    updateMeta(taskRoot, DOC, metadata => {
      assert.equal(metadata.job.genTasks.interview.taskId, timeoutId);
      metadata.job.genTasks.interview.startedAt = Date.now() - 11 * 60 * 1000;
      return metadata;
    });
    await releaseInterview(5, '过期任务的迟到问题');
    const expired = await waitTask('interview', timeoutId, 'error');
    assert.match(expired.error, /超时/);
    assert.deepEqual(readJob().interview, beforeTimeout.interview);
    assert.equal(readJob().interviewGen, beforeTimeout.interviewGen);

    // 同步兼容入口：真实走 changes runner 与新的完成回调契约。
    const generated = await api('/job/generate?id=' + DOC, {});
    assert.equal(generated.httpStatus, 200, JSON.stringify(generated));
    assert.equal(generated.ok, true);
    assert.equal(generated.generated, 1);
    assert.equal(generated.todos, 0);
    assert.equal(readJob().genTasks.changes.status, 'done');

    assert.equal(interviewRequests.length, 5);
    assert.ok(interviewRequests.every(request => request.released && request.sent));
    assert.equal(evidenceCalls, 1);
    assert.equal(changesCalls, 1);
    assert.deepEqual(stubErrors, []);
  } finally {
    try {
      await stopOwnService();
    } finally {
      for (const request of interviewRequests) {
        if (!request.res.writableEnded) request.res.destroy();
      }
      const closed = new Promise(resolve => llm.close(resolve));
      llm.closeAllConnections();
      await closed;
      fs.rmSync(taskRoot, { recursive: true, force: true });
    }
  }
}
~~~

- [ ] **Step 2（2 分钟）：加入一次调用与失败收敛，不重复创建入口。**

在已有 Node 测试调用区、`resolveChromium()` 之前增加：

~~~js
try {
  await runTaskCompletionIntegration();
  ok('TASK T1/T2：批次拒绝、稳定重试、取消接棒、超时与同步兼容');
} catch (error) {
  bad('TASK T1/T2 完成链路', error && error.stack ? error.stack : String(error));
}
~~~

不在 catch 中 process.exit(2)；验证基础包必须使失败优先级高于随后 Chromium 不可用。这里只复用现有 failures/ok/bad，不新建第二个失败计数。

- [ ] **Step 3（3 分钟）：先验证反例能红，再恢复正确服务端出口。**

在隔离 worktree 临时将面试批次拒绝分支接回旧的“回调写 error、外层无条件 done”行为，运行 `bash test.sh`，预期 T1 的同一 taskId 最终状态不是 error，harness 非零；记录具体断言。随后恢复 TASK-03 的显式副本结果协议，不能通过延长时间或允许 done 使反例通过。临时错误实现不提交。

T1 的关键屏障是 `startTask('interview',1)` 内部等待完整 body 的 end 登记；证据任务只有在这之后启动，且以 evidenceId 轮询到 done 才释放第一条响应。不会通过先完成新证据、再让面试读取新基线而得到假通过。

- [ ] **Step 4（3 分钟）：运行正常集成，记录与本轮桩身份对应的结果。**

~~~sh
cd /Users/xxxly/resume
bash test.sh
~~~

预期 T1/T2 块执行并通过；interview 请求 5 次、evidence 1 次、changes 1 次，没有外网请求。取消接棒的迟到副本完整性由 TASK-01 的同步纯函数断言确定性证明，本集成另外检查真实旧响应发送后、接棒任务仍 running 的观察窗口；不要将桩 res.finish 单独当作 runner 已终结证据。

纯函数与回调协议保持 TASK-02/TASK-03 原样，不为 harness 加生产特例。严格四套件仍由总交付 owner 统一执行一次；若来源/资源接线未完成，记录阻塞依赖，不改桩假装兼容。

- [ ] **Step 5（2 分钟）：由对应 owner 精确提交，不提交私有数据或临时桩配置。**

~~~sh
git add server.mjs test-editor.mjs
git commit -m 'fix(tasks): preserve rejection state when evidence changes'
~~~

server.mjs 只加入该集成 owner 已完成并审阅的 TASK-03 修改；其他包也在 server.mjs 中有未提交改动时，先由 owner 分离暂存或使用已约定的串行提交，不用整文件 git add 带入他人未完成工作。taskRoot 只在运行时临时创建并在 finally 删除，不纳入版本库。

## 完成与回退

完成证据：TASK-01 单测退出 0、T1 真实延迟桩反例通过、T2 迟到/取消/超时通过、成功与同步兼容正例通过。源码检查不能替代这些证据。

回退按两个提交撤回接线与纯函数，不改变真实数据；优先保留验证基础修复。若依赖本接口的来源/资源包已集成，按相反依赖顺序回退或保留兼容接口，禁止把新回调丢回会无条件写 done 的旧出口。
