# Reliability Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落实批准设计 R1–R4，使同一服务进程的 AI 与渲染工作各受容量 2 的共享池约束，断连不早放槽，模型 POST 不自动重发。

**Architecture:** 新增一个零依赖资源模块，唯一创建 AI 与 render 两个池。同步入口在副作用前预留并向执行器传递同一 lease；后台任务接管 lease；真正执行请求与子进程的底层负责借用检查及没有入口凭证时的兜底。保留现有任务状态机、无队列准入、冻结/事务流程与一次本地渲染失败重试。

**Tech Stack:** Node.js ESM、内置 test/assert/http/net/events/vm、现有零框架 server、临时数据根、本地模型桩与假渲染器；不新增 npm 依赖。

---

## 执行边界与文件所有权

- 批准设计：`/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md` 第 6 节及 R1–R4；代码基线 `627c2a8b81c2be333f0eaa493ee54da15ac63833`。行号会漂移，使用函数/路由定位。
- 本文件只规划，不代表实现、测试或发布已经完成。当前会话仅创建本计划，不执行下述代码/测试/提交。
- 资源 owner 独占 `/Users/xxxly/resume/resource-slots.mjs`、`/Users/xxxly/resume/llm.mjs`。服务端集成 owner 独占 `/Users/xxxly/resume/server.mjs`，按本计划接线；不能让两个 agent 同时编辑 server。
- 资源反例统一放 `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`。验证 owner 最后将该入口接入现有结构套件；资源 owner 不同时改 `test.sh`、`test-editor.mjs`、`test-structure.sh`、`package.json`。
- `template.html`、`themes/`、`render.mjs` 保持冻结。所有运行示例以仓库为代码根，以 mkdtemp 目录为数据根，配置仅写虚拟模型与 loopback 地址。禁止连接真实收费模型、启动真实数据根服务或重启 launchd。
- 任务状态包会增加 `gen-result.mjs`；本计划不改 `finishGenTask` 的业务返回协议。runner 仅增加第五参数 `{lease}`、三处透传及最外层释放。
- 每个 checkbox 是一次约 2–5 分钟的动作。耗时较长的综合验证由总计划统一运行，不在每个任务重复整套回归。
- 提交命令是未来实施步骤；本次计划编制不得 git commit。实施提交只包含本任务拥有文件，使用显式路径，不能 `git add .`。

## 固定接口与不变量

`resource-slots.mjs` 固定导出 `ResourceBusy`、`ResourceLeaseError`、`createSlotPool`、`aiPool`、`renderPool`。

- `pool.acquire()` 返回 lease 或抛 `code='RESOURCE_BUSY', httpCode=429`；不排队。
- `pool.borrow(lease)` 验证同池、有效、未被借用，返回结束借用函数；结束函数幂等。
- `pool.release(lease)` 幂等，但借用中释放必须抛 `ResourceLeaseError`，不得悄悄释放容量。
- 容量计算凭证预留；一个凭证同时最多一个执行器。`chat`、`renderCurrent` 只透传，不能再次 borrow。
- 入口所有者在实际工作结束后释放；后台所有者是 runner，不是已经返回的 HTTP。
- 固定签名：`chatMsgs(root,messages,{lease}={})`、`chat(root,sys,user,{lease}={})`、`renderDoc({src,out,env,lease})`、`renderCurrent(id,{lease}={})`。
- 仅同一进程共享池；不声称约束独立 CLI、其他服务进程或已取消后的远端执行。

## RES-01：资源模块与可失败的纯函数反例

**Files**
- Create: `/Users/xxxly/resume/resource-slots.mjs`
- Create: `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`

- [ ] **Step 1（2–5 分钟）：创建测试入口和 R1 池行为测试。**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ResourceBusy, ResourceLeaseError, createSlotPool, aiPool, renderPool
} from '../../resource-slots.mjs';
import { chat, chatMsgs, listModels, withRetry } from '../../llm.mjs';

const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(10);
  }
  assert.fail('等待失败: ' + label);
}
function assertCapacity(pool) {
  const a = pool.acquire(), b = pool.acquire();
  assert.throws(() => pool.acquire(), (e) =>
    e instanceof ResourceBusy && e.code === 'RESOURCE_BUSY' && e.httpCode === 429);
  pool.release(a); pool.release(b);
}

test('R1 pool: capacity, borrow, ownership and idempotence', () => {
  const p = createSlotPool('unit', 2), q = createSlotPool('other', 2);
  const a = p.acquire(), b = p.acquire();
  assert.throws(() => p.acquire(), ResourceBusy);
  assert.throws(() => q.borrow(a), ResourceLeaseError);
  assert.throws(() => p.borrow({}), ResourceLeaseError);
  const end = p.borrow(a);
  assert.throws(() => p.borrow(a), ResourceLeaseError);
  assert.throws(() => p.release(a), ResourceLeaseError);
  assert.throws(() => p.acquire(), ResourceBusy);
  end(); end();
  const endAgain = p.borrow(a); endAgain();
  p.release(a); p.release(a);
  assert.throws(() => p.borrow(a), ResourceLeaseError);
  p.release(b);
  assertCapacity(p);
  assertCapacity(aiPool);
  assertCapacity(renderPool);
});
~~~

- [ ] **Step 2（2 分钟）：运行红灯。**

Run: `cd /Users/xxxly/resume && node --test --test-name-pattern='R1 pool' test-fixtures/reliability/test-resources.mjs`

Expected: 非零，缺少 `resource-slots.mjs`。不得先创建返回固定通过值的假模块。

- [ ] **Step 3（2–5 分钟）：创建完整资源模块。**

~~~js
// resource-slots.mjs — 每个进程唯一的两类容量池；没有等待队列。
export class ResourceBusy extends Error {
  constructor(resource) {
    super(resource + '同时执行已达上限，请稍后重试');
    this.name = 'ResourceBusy';
    this.code = 'RESOURCE_BUSY';
    this.httpCode = 429;
    this.resource = resource;
  }
}
export class ResourceLeaseError extends Error {
  constructor(message = '资源占用凭证无效') {
    super(message);
    this.name = 'ResourceLeaseError';
    this.code = 'RESOURCE_LEASE_INVALID';
    this.httpCode = 500;
  }
}
export function createSlotPool(name, max = 2) {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('invalid slot capacity');
  let active = 0;
  const records = new WeakMap();
  const recordOf = (lease) => {
    const r = records.get(lease);
    if (!r) throw new ResourceLeaseError('凭证不属于当前资源池');
    return r;
  };
  return Object.freeze({
    acquire() {
      if (active >= max) throw new ResourceBusy(name);
      const lease = Object.freeze({});
      records.set(lease, { released: false, borrowed: false });
      active++;
      return lease;
    },
    borrow(lease) {
      const r = recordOf(lease);
      if (r.released) throw new ResourceLeaseError('凭证已经释放');
      if (r.borrowed) throw new ResourceLeaseError('同一凭证不能并发借用');
      r.borrowed = true;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        r.borrowed = false;
      };
    },
    release(lease) {
      const r = recordOf(lease);
      if (r.released) return;
      if (r.borrowed) throw new ResourceLeaseError('执行器未结束，不能释放凭证');
      r.released = true;
      active--;
    }
  });
}
export const aiPool = createSlotPool('AI', 2);
export const renderPool = createSlotPool('渲染', 2);
~~~

- [ ] **Step 4（2 分钟）：重跑 Step 2。** Expected: 指定用例通过；池恢复到可连续申请两份凭证，第三份被拒。

- [ ] **Step 5（2 分钟）：独立提交。**

~~~sh
git add resource-slots.mjs test-fixtures/reliability/test-resources.mjs
git commit -m "feat(resources): add shared bounded slot pools"
~~~

## RES-02：LLM 底层借用与 POST 单次请求

**Files**
- Modify: `/Users/xxxly/resume/llm.mjs:49–123`
- Modify: `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`

- [ ] **Step 1（2–5 分钟）：追加只使用本地 HTTP 的桩工具。**

~~~js
async function withModel(handler, run, timeoutMs = 2000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-resource-model-'));
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    baseURL: base + '/v1', apiKey: 'stub-key', model: 'stub', timeoutMs
  }), { mode: 0o600 });
  try { return await run(root, base); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const resultJSON = () => JSON.stringify({
  choices: [{ message: { content: '{"evidence":[],"changes":[],"todos":[]}' } }]
});
async function bodyOf(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}
~~~

- [ ] **Step 2（2–5 分钟）：追加“入口已占两槽，底层不得重复占用”与“响应头不释放”反例。**

~~~js
test('R2 llm: borrowed lease shares singleton and returns capacity', async () => {
  let calls = 0;
  await withModel(async (req, res) => {
    await bodyOf(req); calls++; res.end(resultJSON());
  }, async (root) => {
    const a = aiPool.acquire(), b = aiPool.acquire();
    try {
      assert.match(await chat(root, 'sys', 'user', { lease: a }), /evidence/);
      assert.match(await chatMsgs(root, [{ role: 'user', content: 'again' }], { lease: a }), /changes/);
      await assert.rejects(chat(root, 'sys', 'without-lease'), ResourceBusy);
      assert.throws(() => aiPool.acquire(), ResourceBusy);
      assert.equal(calls, 2);
    } finally { aiPool.release(a); aiPool.release(b); }
    assertCapacity(aiPool);
  });
});

test('R3 llm: response headers do not finish the borrowed request', async () => {
  const headers = deferred(), complete = deferred();
  await withModel(async (req, res) => {
    await bodyOf(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.flushHeaders(); headers.resolve();
    await complete.promise; res.end(resultJSON());
  }, async (root) => {
    const request = chat(root, 'sys', 'body is pending');
    await headers.promise;
    const other = aiPool.acquire();
    try {
      assert.throws(() => aiPool.acquire(), ResourceBusy);
      complete.resolve();
      await request;
    } finally { complete.resolve(); aiPool.release(other); }
    assertCapacity(aiPool);
  });
});
~~~

- [ ] **Step 3（2 分钟）：运行红灯。**

Run: `cd /Users/xxxly/resume && node --test --test-name-pattern='R[23] llm' test-fixtures/reliability/test-resources.mjs`

Expected: 非零。现有 chat 未借用池；无 lease 调用也会发送，或响应正文等待时仍能申请第三份。

- [ ] **Step 4（2–5 分钟）：替换 withRetry，明确 GET 保留有界重试，POST 不重试。**

~~~js
export async function withRetry(fn, {
  retries = 2, delayMs = 1500, idempotent = true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const retryable = idempotent && e.name !== 'AbortError'
        && (e.status === undefined || e.status >= 500);
      if (i >= retries || !retryable) throw e;
      console.warn('[retry] 第' + (i + 1) + '次失败，稍后重试');
      await sleep(delayMs);
    }
  }
}
~~~

此处不根据 `fetch failed`、`ECONNREFUSED` 或无 status 推断 POST 未送达。不改变默认 retries、delayMs，不记录 prompt、认证或请求体。

- [ ] **Step 5（2–5 分钟）：在 llm.mjs 导入共享 aiPool，完整替换 chatMsgs/chat。**

~~~js
import { aiPool } from './resource-slots.mjs';

export async function chatMsgs(root, messages, { lease } = {}) {
  const owned = lease === undefined;
  const active = owned ? aiPool.acquire() : lease;
  let end;
  try {
    end = aiPool.borrow(active);
    const c = loadConfig(root);
    if (!c) throw new Error('LLM 未配置');
    const base = assertSafeBaseURL(c.baseURL).toString().replace(/\/$/, '');
    try {
      const r = await withRetry(() => fetch(base + '/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + c.apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: c.model, messages,
          ...(c.reasoningEffort ? { reasoning_effort: c.reasoningEffort } : {})
        }),
        signal: AbortSignal.timeout(Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 120000)
      }).then(okOrThrow('LLM 请求失败')), { idempotent: false });
      const data = await r.json();
      if (!data.choices?.[0]?.message?.content) throw new Error('LLM 返回格式异常');
      return data.choices[0].message.content;
    } catch (e) {
      throw new Error('本次模型调用未完成，未自动重试：' + (e.message || e), { cause: e });
    }
  } finally {
    if (end) end();
    if (owned) aiPool.release(active);
  }
}
export async function chat(root, sys, user, { lease } = {}) {
  return chatMsgs(root, [
    { role: 'system', content: sys }, { role: 'user', content: user }
  ], { lease });
}
~~~

保留 `loadConfig/loadProfiles/assertSafeBaseURL/listModels/okOrThrow`。配置读取只来自调用方 root；本地桩配置不能指向真实 baseURL。ResourceBusy/ResourceLeaseError 发生在内层模型 catch 之外，不能包装丢失机器码。

- [ ] **Step 6（2 分钟）：重跑 Step 3。** Expected: 两个用例通过、桩只收到两次显式带凭证调用，响应正文完成后容量恢复。

- [ ] **Step 7（2 分钟）：独立提交。**

~~~sh
git add llm.mjs test-fixtures/reliability/test-resources.mjs
git commit -m "fix(llm): hold shared slots through response parsing and disable POST retries"
~~~

## RES-03：服务端提前占位与全链透传

**Files**
- Modify（仅服务端集成 owner）: `/Users/xxxly/resume/server.mjs:297–332,1742–1789,4231–4239`
- Modify（接线）: server.mjs 中本节清单的全部调用点
- Test: `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`（RES-07 提供端到端反例）

- [ ] **Step 1（2–5 分钟）：删除旧计数器/gate，导入同一资源模块并加入完整新 gate。**

~~~js
import {
  aiPool, renderPool, ResourceBusy, ResourceLeaseError
} from './resource-slots.mjs';

const RENDER_ROUTES = new Set([
  'GET /pdf', 'GET /export', 'GET /snapshot/pdf',
  'POST /render', 'POST /export', 'POST /export/layout-apply',
  'POST /app/add', 'POST /app/archive-regenerate',
  'POST /rollback', 'POST /restructure'
]);
function gate(req, pathname) {
  const resources = {};
  try {
    if (req.method === 'POST'
      && ((pathname.startsWith('/ai/') && pathname !== '/ai/test')
        || pathname === '/eval/create' || pathname === '/restructure')) {
      resources.ai = aiPool.acquire();
    }
    if (RENDER_ROUTES.has(req.method + ' ' + pathname)) {
      resources.render = renderPool.acquire();
    }
    return resources;
  } catch (e) {
    if (resources.render !== undefined) renderPool.release(resources.render);
    if (resources.ai !== undefined) aiPool.release(resources.ai);
    throw e;
  }
}
~~~

`/ai/jd-text` 本轮继续沿用既有 /ai 准入语义；`/ai/test` 仍豁免。不要再留 `aiSlot/renderSlot` 或第二份 createSlotPool。`WRITE_ON_GET` 不变。

- [ ] **Step 2（2–5 分钟）：把 gate 纳入 handler 现有 try，统一 finally 释放；对已关闭响应停止写。**

删除旧 `const gated = gate(req, res, url.pathname)` 与紧接的判断。现有 handler 的 try 之前声明：

~~~js
let resources = {};
~~~

现有 try 第一条语句：

~~~js
resources = gate(req, url.pathname);
~~~

现有 catch 第一段加入：

~~~js
if (res.destroyed) return;
if (e instanceof ResourceBusy) {
  return sendJson(429, { ok: false, code: e.code, error: e.message });
}
~~~

在现有 catch 后新增 finally（保留原有异常映射）：

~~~js
finally {
  if (resources.render !== undefined) renderPool.release(resources.render);
  if (resources.ai !== undefined) aiPool.release(resources.ai);
}
~~~

现有 redirect 改为：

~~~js
const redirect = (loc) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(303, { Location: loc });
  res.end();
};
~~~

在 `GET /snapshot/pdf` 与 `GET /pdf` 异步渲染后直接调用 `res.writeHead` 前加入：

~~~js
if (res.destroyed || res.writableEnded) return;
~~~

删除所有旧 gate 的 `res.on('finish',rel)`、`res.on('close',rel)`。备份/恢复自己的维护锁事件监听不是资源槽，不能误删。

- [ ] **Step 3（2–5 分钟）：完成全部同步 AI 调用透传，不改该路由其他业务逻辑。**

| 函数/入口（基线） | 将调用替换为下列实际表达式 |
|---|---|
| /eval/create:1981 | `await chat(root,p.sys,p.user,{lease:resources.ai})` |
| /ai/prep:3153 | `await chat(root,sys,user,{lease:resources.ai})` |
| /ai/rewrite:3413 | `await chat(root,p.sys,p.user,{lease:resources.ai})` |
| /ai/chat:3431 | `await chatMsgs(root,msgs,{lease:resources.ai})` |
| /restructure:3446 | `await structureText(root,text,(sys,user)=>chat(root,sys,user,{lease:resources.ai})).catch(()=>null)` |
| /ai/review:3482 | `await chat(root,p.sys,p.user,{lease:resources.ai})` |
| /ai/match:3497 | `await chat(root,p.sys,p.user,{lease:resources.ai})` |
| /ai/zone-analyze:3514 | `await chat(root,p.sys,p.user,{lease:resources.ai})` |
| /ai/zone-rewrite:3535 | `await chat(root,p.sys,p.user,{lease:resources.ai})` |

区域包会改 zone 路由错误码/版本协议；只对最终已有模型调用补第四参数，不能覆盖其新增校验。

- [ ] **Step 4（2–5 分钟）：为所有当前/快照/存档渲染调用传入同一 render 凭证。**

以下完整表达式分别替换对应调用；renderCurrent 内部自己的 renderDoc 透传见 RES-05：

~~~js
// POST /render；POST /export 的当前渲染；/export/layout-apply
const r = await renderCurrent(id, { lease: resources.render });
// POST /export 的不可变产物渲染
hok = await renderDoc({
  src: srcTmp, out: tmp, lease: resources.render,
  env: {
    RESUME_RENDER_INPUT_ID: frozen.renderInputId,
    RESUME_RENDER_REPRODUCIBLE: frozen.reproducible ? '1' : '0'
  }
});
// /app/add
const archiveOk = await renderDoc({ src: frozenFile, out, lease: resources.render });
// /app/archive-regenerate
const ok = await renderDoc({ src: frozen, out: archivePath(app.id), lease: resources.render });
// /rollback；/restructure；GET /pdf
await renderCurrent(id, { lease: resources.render });
// GET /snapshot/pdf
const ok = await renderDoc({ src: snapFile, out, lease: resources.render });
// GET /export
const r = await renderCurrent(id, { lease: resources.render });
~~~

同一函数里变量声明位置保持现有代码；以上按调用点替换，不能把互斥路由的多个 `const r` 粘到同一作用域。POST /export 两次渲染必须 await 顺序执行，不能改成 Promise.all。

- [ ] **Step 5（2 分钟）：接线清单核对与语法检查。**

~~~sh
node --check server.mjs
rg -n 'chat\(|chatMsgs\(|structureText\(|await renderDoc|await renderCurrent|res\.on' server.mjs
~~~

Expected: 语法 exit 0；每个同步调用都有 resources 凭证；runner 三个模型点留给 RES-04；备份/恢复锁监听保持。此检查只是接线检查，不能据此宣布 R1/R2 行为通过。

- [ ] **Step 6（2 分钟）：由集成 owner 提交本任务接线。** RES-04/05 尚未接好时不发布、不跑真实实例；可与紧接两任务作为一组可运行提交。

~~~sh
git add server.mjs
git commit -m "refactor(resources): reserve route capacity before side effects"
~~~

## RES-04：后台任务转交凭证，保留 409/429 区分

**Files**
- Modify（仅服务端集成 owner）: `/Users/xxxly/resume/server.mjs` 的 startGenTask、runGenTask、/job/gen-start、/job/generate
- Test: `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`（RES-07）

- [ ] **Step 1（2–5 分钟）：用下列完整函数替换 startGenTask。**

~~~js
function startGenTask(id, kind, scope = 'all') {
  let baseHash = null;
  try { baseHash = contentHash(fs.readFileSync(docPath(id), 'utf8')); } catch {}
  let taskId = null, reject = null, lease;
  try {
    updateMetaAll(root, (all) => {
      const m = all[id];
      if (!m || !m.job) {
        reject = { status: 404, error: '该文档不是岗位草稿' }; return null;
      }
      const now = Date.now();
      let ownFresh = false, sameKindOther = false, total = 0;
      for (const [did, dm] of Object.entries(all)) {
        const gt = dm && dm.job && dm.job.genTasks;
        if (!gt) continue;
        for (const k of GEN_KINDS) {
          const t = gt[k];
          if (!t || t.status !== 'running' || genExpired(t, now)) continue;
          total++;
          if (k === kind) {
            if (did === id) ownFresh = true;
            else sameKindOther = true;
          }
        }
      }
      if (ownFresh || sameKindOther || total >= 2) {
        reject = {
          status: 409,
          error: ownFresh ? '该类型任务正在进行中，请稍候'
            : sameKindOther ? '另一文档的任务进行中，请稍后再试'
              : '并发任务已达上限，请稍后再试'
        };
        return null;
      }
      try { lease = aiPool.acquire(); }
      catch (e) {
        if (!(e instanceof ResourceBusy)) throw e;
        reject = { status: 429, code: e.code, error: e.message };
        return null;
      }
      taskId = newGenTaskId();
      const job = {
        ...m.job,
        genTasks: {
          ...(m.job.genTasks || {}),
          [kind]: { taskId, status: 'running', startedAt: now, baseHash, error: null, scope }
        }
      };
      return { ...all, [id]: { ...m, job } };
    });
    return { taskId, reject, lease };
  } catch (e) {
    if (lease !== undefined) aiPool.release(lease);
    throw e;
  }
}
~~~

申请发生在锁内业务校验之后，操作同步、不 await。元数据写失败走 catch 释放；ResourceBusy 不写新 running。不要重写已有任务完成纯函数或结果状态包。

- [ ] **Step 2（2–5 分钟）：在现有 runner 增第五参数和外层 finally；三处 chat 传入 lease。**

以下是针对现有函数边界的完整一次性编辑器；由集成 owner 审阅后在实施阶段执行。它保留函数内部的任务状态包代码，只包裹外层；不能对整个 server 全局替换 chat：

~~~python
from pathlib import Path
p = Path('/Users/xxxly/resume/server.mjs')
s = p.read_text()
start = s.index("async function runGenTask(")
end = s.index("\n// 原子启动", start)
old = s[start:end]
opening = "async function runGenTask(id, kind, taskId, scope = 'all') {\n"
assert old.startswith(opening), "runner signature changed; reconcile with owner"
body = old[len(opening):].rstrip()
assert body.endswith("}"), "runner closing brace missing"
body = body[:-1]
needle = "await chat(root, p.sys, p.user)"
assert body.count(needle) == 3, "expected three runner model calls"
body = body.replace(needle, "await chat(root, p.sys, p.user, { lease })")
new = (
    "async function runGenTask(id, kind, taskId, scope = 'all', { lease } = {}) {\n"
    "  try {\n" + body +
    "  } finally {\n"
    "    if (lease !== undefined) aiPool.release(lease);\n"
    "  }\n}\n"
)
p.write_text(s[:start] + new + s[end:])
~~~

这个 finally 不 borrow；真正 borrow 在 chatMsgs。三个分支任何提前 return、解析失败、finishGenTask 拒绝与异常都经过同一个 finally。

- [ ] **Step 3（2–5 分钟）：替换 /job/gen-start 的启动四行。**

~~~js
const { taskId, reject, lease } = startGenTask(id, kind, scope);
if (reject) return sendJson(reject.status, {
  ok: false, ...(reject.code ? { code: reject.code } : {}), error: reject.error
});
runGenTask(id, kind, taskId, scope, { lease }).catch((e) => {
  console.error('[gen] runner 收尾失败:', e.code || e.name);
});
return sendJson(200, { ok: true, taskId, status: 'running' });
~~~

此 lease 不写入 handler 的 resources，不在 HTTP finally 释放。cancel 接口只改既有任务逻辑状态，不新增池 release。

- [ ] **Step 4（2–5 分钟）：修改 /job/generate 顺序，容量不足不能先写 feedback。**

删除该入口中 startGenTask 之前的 feedback 写入块；保留 body 读取与 doc 存在校验。用以下代码替换原 startGenTask 到 await runner 的部分，后面的 dropped/ok 响应分支继续使用 r：

~~~js
const { taskId, reject, lease } = startGenTask(id, 'changes');
if (reject) return sendJson(reject.status, {
  ok: false, ...(reject.code ? { code: reject.code } : {}), error: reject.error
});
let r, handedToRunner = false;
try {
  if (Array.isArray(genBody.feedback) && genBody.feedback.length) {
    updateMeta(root, id, (m) => {
      if (!m || !m.job) return m;
      m.job.feedback = (Array.isArray(m.job.feedback) ? m.job.feedback : [])
        .concat(genBody.feedback.filter((x) => typeof x === 'string' && x.trim())
          .map((x) => x.trim())).slice(-20);
      return m;
    });
  }
  handedToRunner = true;
  r = await runGenTask(id, 'changes', taskId, 'all', { lease });
} catch (e) {
  if (!handedToRunner) {
    finishGenTask(id, 'changes', taskId, null, '任务启动失败，未调用模型');
  }
  throw e;
} finally {
  if (!handedToRunner) aiPool.release(lease);
}
~~~

异步函数调用会返回 Promise；设 handed 后其 finally 由 runner 保证。前置 feedback 写入抛错时，入口负责释放并将新 running 收敛为 error，不能让两处同时拥有凭证。

- [ ] **Step 5（2 分钟）：语法与接线检查。**

~~~sh
node --check server.mjs
rg -n 'runGenTask\(|chat\(root, p.sys, p.user|aiPool.release|finishGenTask' server.mjs
~~~

Expected: 语法成功；两个 runner 启动点都带第五参数，三个模型调用都带 lease；finishGenTask 仍使用任务包既定返回契约。409 先于物理取槽，429 分支无 feedback/running 写入。行为验收必须继续执行 RES-07。

- [ ] **Step 6（2 分钟）：由集成 owner 独立提交。**

~~~sh
git add server.mjs
git commit -m "fix(resources): transfer AI leases to generation runners"
~~~

## RES-05：renderDoc 底层兜底、一次结算与顺序重试

**Files**
- Modify（仅服务端集成 owner）: `/Users/xxxly/resume/server.mjs:748–805`
- Modify: `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`
- Frozen: `/Users/xxxly/resume/render.mjs` 不变

- [ ] **Step 1（2–5 分钟）：追加实际执行 renderDoc 函数的受控子进程反例。**

测试只截取指定函数后在隔离 vm 中注入 EventEmitter 子进程与可控计时器；断言执行结果、调用次数和容量，不匹配源码字符串冒充行为验证。

~~~js
function functionSource(startMarker, endMarker) {
  const source = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, '执行函数边界必须可定位');
  return source.slice(start, end).trim();
}
function renderHarness() {
  const children = [], timers = [], pool = createSlotPool('vm-render', 2);
  let kills = 0;
  const renderDoc = vm.runInNewContext('(' + functionSource(
    'async function renderDoc(', '// 当前文档陈旧状态单出口'
  ) + ')', {
    path, APP_ROOT, root: '/unused-local-test-root', process: { env: {} }, renderPool: pool,
    spawn() {
      const child = new EventEmitter();
      child.pid = 40000 + children.length;
      child.kill = () => { kills++; return true; };
      children.push(child);
      return child;
    },
    setTimeout(fn, ms) { assert.equal(ms, 60000); timers.push(fn); return fn; },
    clearTimeout() {}
  });
  return { renderDoc, pool, children, timers, kills: () => kills };
}

test('R3 render: kill and error wait for close, then retry once', async () => {
  const h = renderHarness();
  const a = h.pool.acquire(), b = h.pool.acquire();
  const result = h.renderDoc({ src: 'a', out: 'b', lease: a });
  assert.equal(h.children.length, 1);
  h.children[0].emit('error', new Error('simulated error with a live pid'));
  h.timers[0]();
  await wait(0);
  assert.equal(h.kills(), 1);
  assert.equal(h.children.length, 1);
  assert.throws(() => h.pool.acquire(), ResourceBusy);
  assert.throws(() => h.pool.release(a), ResourceLeaseError);
  h.children[0].emit('close', 1);
  await until(() => h.children.length === 2, 'close 后第二次尝试');
  h.children[0].emit('close', 0);
  h.children[1].emit('close', 0);
  assert.equal(await result, true);
  assert.throws(() => h.pool.acquire(), ResourceBusy);
  h.pool.release(a); h.pool.release(b);
  assertCapacity(h.pool);
});

test('R1 render: no-entry lease is owned and final failure returns both slots', async () => {
  const h = renderHarness();
  const result = h.renderDoc({ src: 'a', out: 'b' });
  const other = h.pool.acquire();
  assert.throws(() => h.pool.acquire(), ResourceBusy);
  h.children[0].emit('close', 1);
  await until(() => h.children.length === 2, '第二次尝试');
  h.children[1].emit('close', 1);
  assert.equal(await result, false);
  h.pool.release(other);
  assertCapacity(h.pool);
});
~~~

- [ ] **Step 2（2 分钟）：运行红灯。**

Run: `cd /Users/xxxly/resume && node --test --test-name-pattern='R[13] render' test-fixtures/reliability/test-resources.mjs`

Expected: 未替换时缺少 async 函数边界或旧错误处理提前结算，非零。新实现下 error/kill 均不能启动第二个尝试，只有 close 才能启动。

- [ ] **Step 3（2–5 分钟）：完整替换 renderDoc。**

~~~js
async function renderDoc({ src, out, env, lease }) {
  const owned = lease === undefined;
  const active = owned ? renderPool.acquire() : lease;
  let end;
  try {
    end = renderPool.borrow(active);
    const args = [path.join(APP_ROOT, 'render.mjs'), '--src', src, '--out', out];
    const attempt = () => new Promise((resolve) => {
      let child, timer, settled = false;
      const settle = (ok) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(ok);
      };
      try {
        child = spawn(process.env.RESUME_RENDER_BIN || 'node', args, {
          stdio: 'inherit',
          env: { ...process.env, RESUME_ROOT: root, ...(env || {}) }
        });
      } catch {
        settle(false);
        return;
      }
      child.once('close', (code) => settle(code === 0));
      child.on('error', () => {
        // 没有 pid 表示启动未成功；已启动进程的 error 不代表进程结束。
        if (!child.pid) settle(false);
      });
      timer = setTimeout(() => {
        try { child.kill(); } catch {}
        // 等待 close，不能在此处 resolve 或 release。
      }, 60000);
    });
    const first = await attempt();
    return first || await attempt();
  } finally {
    if (end) end();
    if (owned) renderPool.release(active);
  }
}
~~~

严格保留 60000ms 与最多两次尝试。timer 触发后子进程若尚未终结，继续占位；不能为了“恢复容量”添加未经批准的提前结算或强杀真实进程树。

- [ ] **Step 4（2–5 分钟）：修改 renderCurrent 签名及其唯一 renderDoc 调用。**

~~~js
async function renderCurrent(id, { lease } = {}) {
~~~

该函数体中调用替换为：

~~~js
ok = await renderDoc({
  src: tmp,
  out: pdfPath(id),
  lease,
  env: {
    RESUME_RENDER_INPUT_ID: frozen.renderInputId,
    RESUME_RENDER_REPRODUCIBLE: frozen.reproducible ? '1' : '0'
  }
});
~~~

保留原函数剩余的 freeze、临时文件 try/finally、成功 updateMeta、返回值。不在 renderCurrent 申请、borrow 或 release。

- [ ] **Step 5（2 分钟）：重跑 Step 2，再运行 `node --check server.mjs`。** Expected: 两个用例通过；旧 child 的重复 close 不多建进程，失败两次后 owned 凭证被释放。

- [ ] **Step 6（2 分钟）：独立提交。**

~~~sh
git add server.mjs test-fixtures/reliability/test-resources.mjs
git commit -m "fix(render): settle each child once and share leases across retries"
~~~

## RES-06：请求体中断不悬挂

**Files**
- Modify（仅服务端集成 owner）: `/Users/xxxly/resume/server.mjs` 的 readBody
- Modify: `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`
- Outside scope: readBodyToFile/恢复上传协议，本包不扩大修改

- [ ] **Step 1（2–5 分钟）：追加 readBody 的 EventEmitter 行为反例。**

~~~js
function readBodyFunction() {
  return vm.runInNewContext('(' + functionSource(
    'function readBody(', '// 表单/JSON 双兼容 body'
  ) + ')', { Buffer, Error });
}
function fakeRequest(props = {}) {
  return Object.assign(new EventEmitter(), {
    aborted: false, destroyed: false, complete: false, resume() {}
  }, props);
}
test('R3 body: aborted, incomplete close, already aborted and normal completion', async () => {
  const readBody = readBodyFunction();
  for (const event of ['aborted', 'close', 'error']) {
    const req = fakeRequest();
    const p = readBody(req);
    req.emit('data', Buffer.from('half'));
    if (event === 'error') req.emit(event, new Error('transport broken'));
    else req.emit(event);
    await assert.rejects(p);
    if (event !== 'close') {
      req.emit('error', new Error('late transport error after body rejection'));
      req.emit('close');
    }
    assert.equal(req.listenerCount('data'), 0);
    assert.equal(req.listenerCount('error'), 0);
    assert.equal(req.listenerCount('close'), 0);
  }
  const already = fakeRequest({ aborted: true, destroyed: true });
  await assert.rejects(readBody(already), (e) => e.code === 'REQUEST_ABORTED');
  assert.equal(already.listenerCount('data'), 0);
  already.emit('error', new Error('late error after pre-aborted body'));
  already.emit('close');
  assert.equal(already.listenerCount('error'), 0);

  const normal = fakeRequest();
  const good = readBody(normal, 'buffer');
  normal.emit('data', Buffer.from('complete'));
  normal.complete = true;
  normal.emit('end');
  normal.emit('close');
  assert.equal((await good).toString(), 'complete');

  const large = fakeRequest();
  const tooLarge = readBody(large, 'text', 3);
  large.emit('data', Buffer.from('four'));
  await assert.rejects(tooLarge, /body too large/);
  large.complete = true;
  large.emit('close');
  assert.equal(large.listenerCount('error'), 0);
});
~~~

- [ ] **Step 2（2 分钟）：运行红灯。**

Run: `cd /Users/xxxly/resume && node --test --test-name-pattern='R3 body' test-fixtures/reliability/test-resources.mjs`

Expected: 旧 readBody 在 aborted/close 不结算或监听器未清理，测试失败/被 test runner 判为未完成，不能加固定延时掩盖。

- [ ] **Step 3（2–5 分钟）：用下列完整函数替换 readBody。**

~~~js
function readBody(req, mode = 'text', maxSize = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    const cleanupBody = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
    };
    const cleanupTransport = () => {
      req.off('error', onError);
      req.off('close', onClose);
    };
    const finish = (error, value) => {
      if (done) return;
      done = true;
      cleanupBody();
      if (req.complete || req.closed) cleanupTransport();
      if (error) reject(error);
      else resolve(value);
    };
    const abortedError = () => Object.assign(new Error('请求正文未完整接收'), {
      code: 'REQUEST_ABORTED', httpCode: 400
    });
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxSize) {
        chunks.length = 0;
        finish(new Error('body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      const value = Buffer.concat(chunks);
      finish(null, mode === 'buffer' ? value : value.toString('utf8'));
    };
    const onError = (error) => finish(error);
    const onAborted = () => finish(abortedError());
    const onClose = () => {
      if (!req.complete) finish(abortedError());
      cleanupBody();
      cleanupTransport();
    };
    req.on('error', onError);
    req.once('close', onClose);
    if (req.aborted || (req.destroyed && !req.complete)) {
      finish(abortedError());
      return;
    }
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
  });
}
~~~

本函数只结算 body，不直接释放池。handler 的 finally 收到拒绝后返还未投入使用的入口 lease；已开始模型/渲染的连接关闭不走这个提前释放路径。aborted 之后可能再有 error，故提前失败只停止正文监听，保留 no-op 的错误收敛监听直到 close 再清理，不能让晚到的 error 变成未处理异常。

- [ ] **Step 4（2 分钟）：重跑 Step 2。** Expected: 正常、三类中断、已中断及超限均完成，监听器被清理。

- [ ] **Step 5（2 分钟）：独立提交。**

~~~sh
git add server.mjs test-fixtures/reliability/test-resources.mjs
git commit -m "fix(http): finish interrupted request bodies and release entry reservations"
~~~

## RES-07：真实服务接线的本地桩验收

**Files**
- Modify: `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`
- Read-only under test: `/Users/xxxly/resume/server.mjs`
- Generated only at runtime: mkdtemp 下 docs/JSON/假渲染器；不向仓库写夹具数据

- [ ] **Step 1（2–5 分钟）：追加隔离服务生命周期工具。**

~~~js
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([ended, wait(1500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL'); await ended;
  }
}
function dataFingerprint(root) {
  const rows = [];
  function walk(relative) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) walk(path.join(relative, name));
    } else rows.push([relative, fs.readFileSync(full).toString('base64')]);
  }
  for (const name of [
    'docs', 'snapshots', 'pdfs', 'docs-meta.json',
    'applications.json', 'materials.json', 'evaluations.json'
  ]) walk(name);
  return JSON.stringify(rows);
}
async function withApp(run) {
  const pending = [];
  await withModel(async (req, res) => {
    const body = await bodyOf(req);
    pending.push({ res, body, finished: false });
  }, async (root) => {
    for (const dir of ['docs', 'snapshots', 'pdfs', 'control']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    const html = '<!doctype html><html><head><style>.sheet{color:#111}</style></head>'
      + '<body><div class="sheet"><div class="section"><h2>项目经历</h2>'
      + '<p data-zid="z12345678">负责交易系统；以下为 PDF 提取的原文</p>'
      + '</div></div><script>var DOC_ID = \'seed\';</script></body></html>';
    const job = () => ({
      status: 'draft', materials: [], changes: [], todos: [], evidence: [], genTasks: {}
    });
    for (const id of ['seed', 'other']) {
      fs.writeFileSync(path.join(root, 'docs', id + '.html'), html.replace("'seed'", "'" + id + "'"));
    }
    const ts = '2026-10-24-000000-000';
    fs.mkdirSync(path.join(root, 'snapshots', 'seed'), { recursive: true });
    fs.writeFileSync(path.join(root, 'snapshots', 'seed', ts + '.html'), html);
    fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
      seed: { flow: 'draft', rev: 1, job: job() },
      other: { flow: 'draft', rev: 1, job: job() }
    }));
    fs.writeFileSync(path.join(root, 'materials.json'), '[]');
    fs.writeFileSync(path.join(root, 'evaluations.json'), '[]');
    fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([{
      id: '2026-10-24-000000-001', docId: 'seed', snapTs: ts,
      company: 'stub', role: 'stub', contentHash: 'stub'
    }]));
    const control = path.join(root, 'control');
    const worker = path.join(root, 'fake-render.mjs');
    fs.writeFileSync(worker, [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const c=path.join(process.env.RESUME_ROOT,'control');",
      "const marker=path.join(c,process.pid+'.active');",
      "const log=path.join(c,'events');",
      "const out=process.argv[process.argv.indexOf('--out')+1];",
      "fs.writeFileSync(marker,''); fs.appendFileSync(log,'start '+process.pid+'\\n');",
      "try {",
      " const deadline=Date.now()+8000;",
      " while(!fs.existsSync(path.join(c,'release-all'))){",
      "  if(Date.now()>deadline) throw new Error('stub timeout');",
      "  await new Promise(r=>setTimeout(r,10));",
      " }",
      " if(fs.existsSync(path.join(c,'fail-once'))){",
      "  fs.unlinkSync(path.join(c,'fail-once')); process.exitCode=1;",
      " } else {",
      "  fs.mkdirSync(path.dirname(out),{recursive:true});",
      "  fs.writeFileSync(out,'%PDF-1.4 local resource stub\\n');",
      "  fs.writeFileSync(out+'.env.json',JSON.stringify({",
      "   renderInputId:process.env.RESUME_RENDER_INPUT_ID,reproducible:true,dpi:150",
      "  }));",
      " }",
      "} finally {",
      " fs.appendFileSync(log,'end '+process.pid+'\\n');",
      " fs.rmSync(marker,{force:true});",
      "}"
    ].join('\n'));
    const shQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
    const launcher = path.join(root, 'fake-render.sh');
    fs.writeFileSync(launcher, '#!/bin/sh\nexec ' + shQuote(process.execPath)
      + ' ' + shQuote(worker) + ' "$@"\n', { mode: 0o700 });
    let child, base, output = '';
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const port = await availablePort();
        output = '';
        child = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
          cwd: APP_ROOT,
          env: {
            ...process.env, RESUME_ROOT: root, PORT: String(port),
            RESUME_RENDER_BIN: launcher, RESUME_TEST_SAVE_GAP_MS: '0',
            RESUME_LOG_FILE: path.join(root, 'stub-service.log')
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });
        const remember = (chunk) => { output = (output + chunk.toString()).slice(-12000); };
        child.stdout.on('data', remember); child.stderr.on('data', remember);
        base = 'http://127.0.0.1:' + port;
        try {
          await until(async () => {
            if (child.exitCode !== null) throw new Error(output);
            try { return (await fetch(base + '/')).ok; } catch { return false; }
          }, '隔离服务启动');
          break;
        } catch (e) {
          await stopChild(child);
          if (attempt === 2 || !/EADDRINUSE|端口不可用/.test(output)) throw e;
        }
      }
      const request = (route, body) => fetch(base + route, body === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), redirect: 'manual'
      });
      const activeRenders = () => fs.readdirSync(control).filter((name) => name.endsWith('.active')).length;
      const releaseRenders = () => fs.writeFileSync(path.join(control, 'release-all'), '');
      const finishModels = () => {
        for (const item of pending) {
          if (!item.finished) {
            item.finished = true;
            if (!item.res.destroyed) item.res.end(resultJSON());
          }
        }
      };
      await run({ root, base, request, pending, activeRenders, releaseRenders, finishModels, control, ts });
    } finally {
      fs.writeFileSync(path.join(control, 'release-all'), '');
      for (const item of pending) if (!item.res.destroyed) item.res.end(resultJSON());
      try {
        await until(() => fs.readdirSync(control).every((name) => !name.endsWith('.active')),
          '本轮假渲染器结束', 9000);
      } finally {
        await stopChild(child);
      }
    }
  }, 15000);
}
~~~

安全约束：只记录/终止本轮 child；不按端口杀进程。不检查真实 config/docs，不需要真实 Chromium。启动端口竞争最多重选三次；不得清理占用者。

- [ ] **Step 2（2–5 分钟）：追加 R1 全渲染入口拒绝前零副作用与 R2 共享物理槽。**

~~~js
test('R1 app: all rendering entries refuse before writes; export reuses one lease', async () => {
  await withApp(async (app) => {
    const first = app.request('/render?id=seed', {});
    const second = app.request('/render?id=other', {});
    await until(() => app.activeRenders() === 2, '两个慢渲染均已启动');
    const before = dataFingerprint(app.root);
    const cases = [
      ['/pdf?id=seed', undefined],
      ['/export?id=seed', undefined],
      ['/snapshot/pdf?id=seed&ts=' + app.ts, undefined],
      ['/render?id=seed', {}],
      ['/export?id=seed', {}],
      ['/export/layout-apply?id=seed', { fontSize: 13, lineHeight: 1.5, paraGap: 1 }],
      ['/app/add', { company: 'stub', role: 'stub', docId: 'seed' }],
      ['/app/archive-regenerate', { id: '2026-10-24-000000-001' }],
      ['/rollback?id=seed&ts=' + app.ts, {}],
      ['/restructure?id=seed', {}]
    ];
    for (const [route, body] of cases) {
      const response = await app.request(route, body);
      assert.equal(response.status, 429, route);
      assert.equal((await response.json()).code, 'RESOURCE_BUSY');
      assert.equal(dataFingerprint(app.root), before, route + '不得先写数据');
    }
    assert.equal(app.pending.length, 0, 'restructure 组合申请失败不能先调模型');
    app.releaseRenders();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    fs.writeFileSync(path.join(app.control, 'fail-once'), '');
    const exported = await app.request('/export?id=seed', {});
    assert.equal(exported.status, 200);
    assert.equal((await exported.json()).ok, true);
    let active = 0, peak = 0;
    const log = fs.readFileSync(path.join(app.control, 'events'), 'utf8');
    for (const row of log.trim().split('\n')) {
      active += row.startsWith('start ') ? 1 : -1;
      peak = Math.max(peak, active);
      assert.ok(active >= 0);
    }
    assert.ok(peak <= 2);
    assert.equal(active, 0);
  });
});

test('R2 app: sync and generation share two slots; cancel does not release early', async () => {
  await withApp(async (app) => {
    const sync = app.request('/ai/rewrite', { text: 'old', instruction: 'rewrite' });
    await until(() => app.pending.length === 1, '同步模型已收到');
    const started = await app.request('/job/gen-start?id=seed&kind=evidence', {});
    assert.equal(started.status, 200);
    const { taskId } = await started.json();
    await until(() => app.pending.length === 2, '后台模型已收到');
    const duplicate = await app.request('/job/gen-start?id=seed&kind=evidence', {});
    assert.equal(duplicate.status, 409);
    const metaPath = path.join(app.root, 'docs-meta.json');
    const before = fs.readFileSync(metaPath, 'utf8');
    const third = await app.request('/job/gen-start?id=other&kind=changes', {});
    assert.equal(third.status, 429);
    assert.equal(fs.readFileSync(metaPath, 'utf8'), before);
    const syncThird = await app.request('/ai/rewrite', { text: 'x', instruction: 'y' });
    assert.equal(syncThird.status, 429);
    const cancelled = await app.request('/job/gen-cancel?id=seed&kind=evidence&taskId=' + taskId, {});
    assert.equal(cancelled.status, 200);
    const afterCancel = fs.readFileSync(metaPath, 'utf8');
    const replacement = await app.request('/job/gen-start?id=other&kind=changes', {});
    assert.equal(replacement.status, 429);
    assert.equal(fs.readFileSync(metaPath, 'utf8'), afterCancel);
    app.finishModels();
    assert.equal((await sync).status, 200);
    const after = app.request('/ai/rewrite', { text: 'probe', instruction: 'probe' });
    await until(() => app.pending.length === 3, '实际请求终结后模型接受新调用');
    app.finishModels();
    assert.equal((await after).status, 200);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.seed.job.genTasks.evidence.status, 'cancelled');
    assert.deepEqual(meta.seed.job.evidence, []);
  });
});
~~~

恢复容量 probe 在同步请求返回之后发出；同步入口的 finally 此时已释放至少一个槽。测试先观察桩收到 probe，再让桩响应，避免测试自己等待未释放的响应而死锁。

- [ ] **Step 3（2–5 分钟）：追加 R3 两类断连反例。**

~~~js
test('R3 app: incomplete body disconnect returns its entry reservation', async () => {
  await withApp(async (app) => {
    const u = new URL(app.base);
    const socket = net.connect(Number(u.port), '127.0.0.1');
    socket.on('error', () => {});
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('POST /ai/rewrite HTTP/1.1\r\nHost: 127.0.0.1:' + u.port
      + '\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"text":');
    const first = app.request('/ai/rewrite', { text: 'a', instruction: 'b' });
    await until(() => app.pending.length === 1, '完整请求经过同一服务');
    socket.destroy();
    await new Promise((resolve) => {
      if (socket.closed) resolve(); else socket.once('close', resolve);
    });
    const second = app.request('/ai/rewrite', { text: 'c', instruction: 'd' });
    await until(() => app.pending.length === 2, '中断 body 凭证已经返还');
    app.finishModels();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  });
});

test('R3 app: finished request body then client close keeps actual model slot', async () => {
  await withApp(async (app) => {
    const u = new URL(app.base), payload = JSON.stringify({ text: 'a', instruction: 'b' });
    const socket = net.connect(Number(u.port), '127.0.0.1');
    socket.on('error', () => {});
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('POST /ai/rewrite HTTP/1.1\r\nHost: 127.0.0.1:' + u.port
      + '\r\nContent-Type: application/json\r\nContent-Length: '
      + Buffer.byteLength(payload) + '\r\n\r\n' + payload);
    await until(() => app.pending.length === 1, '模型完整收到断连请求');
    const other = app.request('/ai/rewrite', { text: 'c', instruction: 'd' });
    await until(() => app.pending.length === 2, '第二个模型请求');
    socket.destroy();
    await new Promise((resolve) => {
      if (socket.closed) resolve(); else socket.once('close', resolve);
    });
    const denied = await app.request('/ai/rewrite', { text: 'e', instruction: 'f' });
    assert.equal(denied.status, 429);
    assert.equal(app.pending.length, 2);
    app.finishModels();
    assert.equal((await other).status, 200);
  });
});
~~~

- [ ] **Step 4（2–5 分钟）：运行服务接线反例。**

Run: `cd /Users/xxxly/resume && node --test --test-name-pattern='R[123] app' test-fixtures/reliability/test-resources.mjs`

Expected: 所有 app 用例通过；全程只有 mkdtemp 数据根、动态端口、本地模型桩和假渲染器。出现 429/409 不符、pending 数量不符或超时必须修复本包代码，不通过延长真实模型 timeout 回避。

- [ ] **Step 5（2 分钟）：测试 owner 接收本用例并独立提交。**

~~~sh
git add test-fixtures/reliability/test-resources.mjs
git commit -m "test(resources): cover mixed admission, side effects and disconnect ownership"
~~~

## RES-08：R4 模型 POST 单次与 GET 有界重试

**Files**
- Modify: `/Users/xxxly/resume/test-fixtures/reliability/test-resources.mjs`
- Read-only under test: `/Users/xxxly/resume/llm.mjs`

- [ ] **Step 1（2–5 分钟）：追加“完整收到 POST 后断 socket”的实际本地网络反例。**

~~~js
test('R4 post: received body then disconnect is sent exactly once', async () => {
  let received = 0;
  await withModel(async (req) => {
    const body = JSON.parse(await bodyOf(req));
    assert.equal(body.model, 'stub');
    assert.equal(body.messages[1].content, 'received-before-disconnect');
    received++;
    req.socket.destroy();
  }, async (root) => {
    await assert.rejects(chat(root, 'sys', 'received-before-disconnect'),
      /未自动重试/);
    assert.equal(received, 1);
    assertCapacity(aiPool);
  });
});

for (const mode of ['401', '503', 'bad-json', 'bad-format', 'timeout']) {
  test('R4 post: ' + mode + ' sends once and releases', async () => {
    let received = 0;
    await withModel(async (req, res) => {
      await bodyOf(req); received++;
      if (mode === 'timeout') return;
      if (mode === '401' || mode === '503') {
        res.writeHead(Number(mode)); res.end('stub failure'); return;
      }
      res.end(mode === 'bad-json' ? '{' : '{}');
    }, async (root) => {
      await assert.rejects(chat(root, 'sys', mode), /未自动重试/);
      assert.equal(received, 1);
      assertCapacity(aiPool);
    }, mode === 'timeout' ? 250 : 2000);
  });
}
~~~

250ms 只作用于本地 timeout 桩配置，其他错误场景沿用 2000ms 测试上限；不修改生产请求 timeout。timeout 用例保留连接直到客户端超时，由 withModel 的 finally 关闭本轮 socket。

- [ ] **Step 2（2–5 分钟）：追加没有网络的连接拒绝/取消边界及真正 GET 桩。**

~~~js
test('R4 retry: POST refuses automatic retries even for connection refused', async () => {
  for (const name of ['TypeError', 'AbortError', 'TimeoutError']) {
    let calls = 0;
    const sleeps = [];
    const error = Object.assign(new Error('local synthetic connection failure'), {
      name, cause: { code: 'ECONNREFUSED' }
    });
    await assert.rejects(withRetry(async () => { calls++; throw error; }, {
      idempotent: false, sleep: async (ms) => { sleeps.push(ms); }
    }), (e) => e === error);
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  }
  let abortedCalls = 0;
  await assert.rejects(withRetry(async () => {
    abortedCalls++;
    throw Object.assign(new Error('explicit abort'), { name: 'AbortError' });
  }, { sleep: async () => assert.fail('明确取消不允许重试等待') }));
  assert.equal(abortedCalls, 1);
});

test('R4 get: model list retries a 502 within existing bound', async () => {
  let received = 0;
  await withModel(async (req, res) => {
    await bodyOf(req); received++;
    assert.equal(req.method, 'GET');
    if (received === 1) { res.writeHead(502); res.end('try again'); return; }
    res.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
  }, async (_root, base) => {
    assert.deepEqual(await listModels(base + '/v1', 'stub-key'), ['stub-model']);
    assert.equal(received, 2);
  });
});
~~~

- [ ] **Step 3（2–5 分钟）：补子进程未启动的错误与跨池误用反例。**

~~~js
test('R3 render: failed spawn has no live pid and is settled once', async () => {
  const h = renderHarness();
  const result = h.renderDoc({ src: 'a', out: 'b' });
  h.children[0].pid = undefined;
  h.children[0].emit('error', new Error('spawn ENOENT'));
  await until(() => h.children.length === 2, '未启动的进程允许下一次尝试');
  h.children[0].emit('close', -1);
  assert.equal(h.children.length, 2);
  h.children[1].emit('close', 0);
  assert.equal(await result, true);
  assertCapacity(h.pool);
});

test('R2 llm: foreign lease is rejected without sending and without releasing its owner', async () => {
  let received = 0;
  await withModel(async (req, res) => {
    await bodyOf(req); received++; res.end(resultJSON());
  }, async (root) => {
    const wrong = renderPool.acquire();
    try {
      await assert.rejects(chat(root, 'sys', 'foreign', { lease: wrong }), ResourceLeaseError);
      assert.equal(received, 0);
      const end = renderPool.borrow(wrong); end();
    } finally { renderPool.release(wrong); }
    assertCapacity(aiPool);
    assertCapacity(renderPool);
  });
});
~~~

- [ ] **Step 4（2–5 分钟）：运行本包完整测试一次。**

Run: `cd /Users/xxxly/resume && node --test test-fixtures/reliability/test-resources.mjs`

Expected: 全部测试通过；没有失败、取消或未完成测试。POST 各故障模式收到 1 次；GET 收到 2 次；测试退出后没有本轮 service/fake-render 子进程。不能用输出中出现“通过”两个字替代 test runner 的退出码。

- [ ] **Step 5（2 分钟）：独立提交。**

~~~sh
git add test-fixtures/reliability/test-resources.mjs
git commit -m "test(llm): prove POST single-send and bounded GET retries"
~~~

## RES-09：共享测试接入、交付证据与独立回退

**Files**
- Modify（仅验证 owner）: `/Users/xxxly/resume/test-structure.sh` 中旧 SEC-2 段，基线 3916–3934
- Read-only: 本计划中的实际实现文件与冻结件
- Modify（仅文档 owner）: 总交接与执行记录，不在本包抢写

- [ ] **Step 1（2–5 分钟）：把旧 SEC-2 源码形状断言替换为真实行为测试入口。**

旧断言要求 `AI_MAX_INFLIGHT`、`aiSlot/renderSlot`、`gate(req,res,pathname)` 等具体拼写，会因批准的新模块设计失败，不能为保持这些字符串而留第二套池。验证 owner 用下面完整内容替换旧 SEC-2 heredoc 段：

~~~sh
# —— SEC-2：共享资源池、真实模型请求/子进程占位、断连及重试反例 ——
node --test test-fixtures/reliability/test-resources.mjs
~~~

不再保留“源码有 429 字样就通过”作为容量证明。结构套件本来已经 set -e，node 非零必须使套件失败。不要同时加入另一条相同 npm 聚合入口造成重复整跑。

- [ ] **Step 2（2–5 分钟）：检查所有调用路径与冻结边界。**

~~~sh
node --check resource-slots.mjs
node --check llm.mjs
node --check server.mjs
node --check test-fixtures/reliability/test-resources.mjs
rg -n 'createSlotPool|aiPool|renderPool|runGenTask\(|chat\(|chatMsgs\(|await renderDoc|await renderCurrent' resource-slots.mjs llm.mjs server.mjs
git diff 627c2a8b81c2be333f0eaa493ee54da15ac63833 -- template.html themes render.mjs
~~~

Expected: 四个语法检查 exit 0；生产 createSlotPool 实例只在资源模块创建两次；所有当前路由/runner 透传正确；冻结件 diff 为空。本步骤不是费用、物理线程或真实 Chromium 峰值的证明。

- [ ] **Step 3（2–5 分钟）：执行一次定向反例失效检查。**

在本轮独立工作区，仅临时把 `llm.mjs` 中 `{idempotent:false}` 改成 `{idempotent:true}`，运行：

~~~sh
node --test --test-name-pattern='R4 post: received body' test-fixtures/reliability/test-resources.mjs
~~~

Expected: 桩收到超过 1 次或断言非零。立即只撤销这次临时探针改动，不能回退其他 agent 工作；重跑同命令应通过。第二个探针暂时移除 `POST /app/add` 的提前登记，运行 R1 app 用例；Expected: 返回非 429 或发生副作用，测试必须失败。恢复该行后通过。记录反例名称与退出码，不保留探针代码。

- [ ] **Step 4（2–5 分钟）：把本包交给唯一验证 owner 做总验收，不自行重复整套。**

集成完成且各包相关反例通过后，由总计划验证 owner 执行：

~~~sh
RESUME_TEST_STRICT=1 npm run test:all
~~~

Expected: 现有四套件严格成功，包括本包新行为入口；必需环境不可用算未完成，不能声称通过。此命令沿用项目隔离机制，不授权真实 LLM 或服务发布。若总计划已在同一最终代码版本运行成功，不再为了本包单独重跑。

资源 owner 提交给文档 owner 的记录应包含：最终代码提交、定向用例命令及退出码、POST 接收次数、混合请求峰值、是否做过反例失效检查、未测真实模型/跨进程边界。记录不包含配置、prompt、正文或认证信息。

- [ ] **Step 5（2 分钟）：验证 owner 仅提交共享测试接入。**

~~~sh
git add test-structure.sh
git commit -m "test(resources): run behavioral resource checks in structure suite"
~~~

## 依赖、停止条件与回退

依赖顺序：RES-01 → RES-02 → RES-03/04/05/06 接线 → RES-07/08 → RES-09。资源模块、LLM 改造与纯函数测试可由资源 owner 准备；server 任务由唯一集成 owner 串行接入。任务完成状态/来源/区域包不得同时重写 runner 完成协议、gate 或 readBody。

出现以下任一情况先停在当前任务修正，不发布：一个凭证被并发借用；错误释放导致容量泄漏/负数；HTTP 200 使后台释放；429 发生前写入数据；正文中断用例悬挂；POST 桩收到多次；共享 pool 实例不唯一；冻结件变化；本地测试试图请求非 loopback 模型端点。

实施阶段的回退只撤本包提交，按最新到最旧执行 `git revert <实际提交>`；由集成 owner 处理 server 重叠上下文，保留已合并的其他工作包。建议本包独立提交序列如下：

| 提交 | 内容 | 回退影响 |
|---|---|---|
| A | RES-01 资源模块及纯函数用例 | 若仍被导入，不能先撤此提交 |
| B | RES-02 LLM 借用及 POST 单次 | 恢复旧 LLM 行为，需同时撤依赖的新接口接线 |
| C | RES-03/04/05/06 服务端接线 | 可按任务分提交；整体回退须先撤资源测试接入 |
| D | RES-07/08 本地桩反例 | 不改变生产状态，但撤掉会损失回归保护 |
| E | RES-09 共享测试接入 | 完整回退先撤此提交，防止引用已撤测试 |

不回滚用户正文、配置、快照、meta 或现有历史产物。本包没有数据迁移。没有跨进程/远端 exactly-once 保证，不新增等待队列、供应商幂等键、费用核对、进程树管理或取消请求注册表。

## 编制自检与 R1–R4 映射

| 设计验收 | 实施 | 可执行证据 |
|---|---|---|
| R1 全渲染入口、顺序导出、本地重试 | RES-01/03/05 | R1 pool、R1 render、R1 app |
| R2 同步 AI + 后台共池、409/429、无新 running | RES-02/03/04 | R2 llm、R2 app、foreign lease |
| R3 HTTP 关闭、cancel、body、子进程终结 | RES-04/05/06 | R3 llm/body/render/app |
| R4 POST 接收后断开、HTTP/解析/超时、GET | RES-02/08 | R4 post/retry/get |

编制时只检查本计划和批准设计，不运行其中的实施命令、收费请求或发布操作。执行者必须重新产出动态证据，不能引用本表充当已通过证明。
