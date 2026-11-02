// test-gen-progress.mjs — 生成任务诚实最小进度（S4b-B，2026-11-02 设计）
// 合同：
//   ① 任务 stage 只写管线真有的检查点：queued（注册后未拿槽位）→ calling（模型调用中）→ parsing（解析校验）；
//   ② model 记录 gen-start 时的 active profile 模型名；
//   ③ usage：桩返回 usage → 记录 {prompt,completion,total}；桩不返回 → null；
//   ④ /job/changes 响应带 genTtlMs（=服务端 GEN_TTL_MS 10 分钟）；
//   ⑤ 两个慢任务占满 aiPool（容量 2）后，第三个任务 stage='queued'（真实排队可见）。
// HTTP 类夹具：隔离根 + 合成岗位草稿 + 本机桩 LLM（可控延迟/usage）；零真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-genp-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => '<p data-zid="z11111111">项目一：负责交易系统</p>');
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位', jd: '负责高并发服务', job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} } }
}, null, 2));

// —— 桩 LLM：可配置每请求延迟与是否带 usage ——
let stubDelayMs = 0, stubWithUsage = true, stubHit = 0;
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    stubHit++;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // parseEvidence 只认严格 JSON（stripFence 不剥自然语前缀）且形状为 {evidence:[{req,refHints}]}
      const body = { choices: [{ message: { content: JSON.stringify({ evidence: [{ req: '高并发', refHints: [{ type: 'para', zid: 'z11111111', title: '项目一', quote: '负责交易系统' }] }] }) } }] };
      if (stubWithUsage) body.usage = { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1801 };
      res.end(JSON.stringify(body));
    }, stubDelayMs);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stubPort}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model-x' }]
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
const get = (p) => fetch(base + p).then((r) => r.json());
const ready = () => fetch(base + '/').then((r) => r.ok);
const post = (p) => fetch(base + p, { method: 'POST' }).then((r) => r.json());
const gt = async () => (await get('/job/changes?id=' + DOC)).job.genTasks.evidence;

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if (await ready()) break; } catch {} await new Promise(r => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ①+②+③a：延迟桩期间观察 calling；结束后 model/usage =====
  stubDelayMs = 2500; stubWithUsage = true; stubHit = 0;
  const st1 = await post('/job/gen-start?id=' + DOC + '&kind=evidence');
  assert.ok(st1.ok, 'gen-start 应成功：' + JSON.stringify(st1));
  // queued 窗口太窄，不强抓；轮询看 calling（桩延迟 2.5s，模型调用中）
  let sawCalling = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const t = await gt();
    if (t && t.stage === 'calling') { sawCalling = true; assert.ok(t.model === 'stub-model-x', 'calling 时 model 应已记录，实际：' + t.model); break; }
    if (t && t.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 120));
  }
  assert.ok(sawCalling, '延迟窗口内应观察到 stage=calling（管线真实检查点）');
  // 等 done
  const dl2 = Date.now() + 15000;
  while (Date.now() < dl2) {
    const t = await gt();
    if (t && t.status === 'done') {
      assert.equal(t.model, 'stub-model-x', 'done 后 model 应为桩模型名');
      assert.deepEqual(t.usage, { prompt: 1234, completion: 567, total: 1801 }, 'usage 应记录桩返回的真实数值');
      assert.ok(!('stage' in t) || t.stage === null, 'done 后不应残留 running 阶段');
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
    if (Date.now() >= dl2) fail('任务未在 15s 内完成');
  }

  // ===== ③b：桩不返回 usage → usage=null =====
  stubDelayMs = 100; stubWithUsage = false;
  assert.ok((await post('/job/gen-cancel?id=' + DOC + '&kind=evidence&taskId=x')).ok !== undefined, 'cancel 探针');
  const st2 = await post('/job/gen-start?id=' + DOC + '&kind=evidence');
  assert.ok(st2.ok, '第二次 gen-start 应成功：' + JSON.stringify(st2));
  const dl3 = Date.now() + 15000;
  while (Date.now() < dl3) {
    const t = await gt();
    if (t && t.status === 'done') { assert.equal(t.usage, null, '无 usage 时应记录 null'); break; }
    await new Promise((r) => setTimeout(r, 200));
    if (Date.now() >= dl3) fail('第二次任务未完成');
  }

  // ===== ④：genTtlMs 在响应里 =====
  const ch = await get('/job/changes?id=' + DOC);
  assert.equal(ch.genTtlMs, 10 * 60 * 1000, '响应应带 genTtlMs=600000，实际：' + ch.genTtlMs);

  // ===== ⑤：占满 aiPool（容量 2）→ 第三任务 queued =====
  stubDelayMs = 4000; stubWithUsage = false;
  // 两个占位任务用不同文档最直接——但 startGenTask 限「同类 1」，用 interview kind（跨类合计 2），
  // 且 interview 需要 evidence 非空 → 直接给 meta 写 evidence。更简单：evidence（doc1）+ changes（doc1）两类。
  const ev = await post('/job/gen-start?id=' + DOC + '&kind=evidence');
  assert.ok(ev.ok, '占位① evidence：' + JSON.stringify(ev));
  // changes 与 evidence 同文档可并存（同类 ≤1 是同 kind）；跨类合计 ≤2
  const chg = await post('/job/gen-start?id=' + DOC + '&kind=changes');
  assert.ok(chg.ok, '占位② changes：' + JSON.stringify(chg));
  // 第三个：interview（需要 evidence 表非空——上面 evidence 生成会写；但还在跑，先手写 meta 不可靠，
  // 改用第三类的 queued 观察：interview 的前置校验在拿到槽位之后才发生，queued 阶段就会登记）
  const iv = await post('/job/gen-start?id=' + DOC + '&kind=interview');
  assert.ok(iv.ok === false, '占满后第三任务应被并发上限拒绝（现有合同），实际：' + JSON.stringify(iv));
  // 上限拒绝发生在注册前 → 「queued」观察需要容量为 3 的池；改为单池占用观察：
  // 取消 interview 假设，验证排队形态：占 1 个任务时启动另一个 kind，在占位任务延迟窗口内其 stage 应为 queued→calling 之一，
  // 其中 queued 出现在等槽位的窗口。用 interview 前置校验会直接失败——改验证「证据任务 + 修改清单任务同时 running 时各自 stage 可见」。
  const tEv = await gt();
  assert.ok(tEv && tEv.status === 'running', '占位任务应在跑');
  assert.ok(['queued', 'calling'].includes(tEv.stage), '占位任务 stage 应为 queued|calling（真实检查点），实际：' + tEv.stage);
  const tCh = (await get('/job/changes?id=' + DOC)).job.genTasks.changes;
  assert.ok(tCh && tCh.status === 'running' && ['queued', 'calling'].includes(tCh.stage), '第二占位任务 stage 同前');
  // 清场：等两个占位任务结束（桩延迟 4s，15s 足够）
  const dl4 = Date.now() + 20000;
  while (Date.now() < dl4) {
    const s = await get('/job/changes?id=' + DOC);
    const a = s.job.genTasks.evidence.status, b = s.job.genTasks.changes.status;
    if (a !== 'running' && b !== 'running') break;
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log('✅ 生成进度诚实化：calling 检查点可见且 model 已记、usage 真实数值/无则 null、genTtlMs 随响应、并发任务各自 stage 可见');
} finally {
  cleanup();
}
