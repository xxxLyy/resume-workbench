// test-fixtures/reliability/test-gen-task.mjs — TASK-04：后台生成任务的真实生命周期回归
// 覆盖：T1（证据换批 / 业务拒绝不被 done 覆盖）与 T2（取消 / 迟到结果不落账）。
// 约束：隔离 RESUME_ROOT + 合成文档 + 本机假 LLM（可控延迟）；不读真实简历、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-gt-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const ZID = 'z11111111';
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'),
  `<!doctype html><html><head><title>t</title></head><body><p data-zid="${ZID}">项目一：负责队列服务，把延迟从 80ms 降到 12ms</p></body></html>`);
const metaPath = path.join(root, 'docs-meta.json');
const writeMeta = (extra) => fs.writeFileSync(metaPath, JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位', jd: '合成 JD',
    job: { evidence: [], changes: [], todos: [], feedback: [], materials: [], genTasks: {}, ...extra }
  }
}, null, 2));
writeMeta({});

// 假 LLM：可延迟；可切换为坏输出
let llmDelay = 0;
let llmMode = 'good';   // 'good' | 'broken'
let lastLlmBody = '';   // 实际发到模型的那份请求体（验证「实际 prompt 输入」而不是只看构造函数）
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  lastLlmBody = body;
  if (llmDelay) await new Promise((r) => setTimeout(r, llmDelay));
  const content = llmMode === 'broken'
    ? '这不是 JSON'
    : JSON.stringify({ evidence: [{ req: '要求一：队列服务', status: 'covered', refHints: [{ type: 'para', zid: ZID, title: '项目', quote: '负责队列服务' }] }] });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }]
}));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const base = `http://127.0.0.1:${port}`;
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const jobState = async () => {
  const r = await fetch(base + '/job/changes?id=' + DOC);
  const d = await r.json();
  return d;
};
const waitTask = async (kind, until, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const d = await jobState();
    last = d.job && d.job.genTasks ? d.job.genTasks[kind] : null;
    if (last && until(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  return last;
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // ===== T1-a：成功路径落账 =====
  {
    llmMode = 'good'; llmDelay = 0;
    const started = await post('/job/gen-start?id=' + DOC + '&kind=evidence', {});
    if (started.status !== 200 || !started.json || !started.json.taskId) fail('gen-start 失败：' + started.text.slice(0, 200));
    const t = await waitTask('evidence', (x) => x.status !== 'running');
    assert.ok(t && t.status === 'done', '证据生成应完成，实际 ' + JSON.stringify(t));
    const d = await jobState();
    const ev = (d.job.evidence || [])[0];
    assert.ok(ev && ev.req === '要求一：队列服务', '证据未落账');
    assert.ok(ev.refs && ev.refs.length === 1 && ev.refs[0].zid === ZID, '证据来源未绑定段落 zid');
    // 实际 prompt 输入（真正发出去的那份）：必须带真源段落的文本与 zid，模型才可能引用真源
    assert.ok(lastLlmBody.indexOf('项目一：负责队列服务，把延迟从 80ms 降到 12ms') >= 0,
      '实际 prompt 未包含真源段落文本（模型无法引用真源）');
    assert.ok(lastLlmBody.indexOf(ZID) >= 0, '实际 prompt 未包含真源段落 zid');
    console.log('  ✅ T1-a 证据生成成功落账');
  }

  // ===== T1-b：证据换批 → 迟到结果被拒，新批次不被污染 =====
  {
    llmMode = 'good'; llmDelay = 1500;
    const started = await post('/job/gen-start?id=' + DOC + '&kind=evidence', {});
    assert.ok(started.json && started.json.taskId, 'gen-start 失败');
    // 生成期间证据表被替换（evidenceGen 前进）
    await new Promise((r) => setTimeout(r, 300));
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    raw[DOC].job.evidence = [{ id: 'e-new', req: '新批次的要求', status: 'covered', refs: [], note: '', noteConfirmed: false }];
    raw[DOC].job.evidenceGen = 9;
    fs.writeFileSync(metaPath, JSON.stringify(raw, null, 2));
    const t = await waitTask('evidence', (x) => x.status !== 'running', 20000);
    const dbgMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))[DOC].job;
    console.log('  [dbg] gen=' + dbgMeta.evidenceGen + ' ev=' + JSON.stringify((dbgMeta.evidence||[]).map(e=>e.req)) + ' task=' + JSON.stringify(t));
    assert.ok(t && t.status === 'error', '换批后迟到结果应被拒（error），实际 ' + JSON.stringify(t));
    const d = await jobState();
    const ev = (d.job.evidence || [])[0];
    assert.ok(ev && ev.req === '新批次的要求', '迟到结果污染了新批次的证据表');
    console.log('  ✅ T1-b 证据换批：迟到结果被拒且不污染新状态');
  }

  // ===== T1-c：业务拒绝不被 done 覆盖 =====
  {
    llmMode = 'broken'; llmDelay = 0;
    await post('/job/gen-start?id=' + DOC + '&kind=evidence', {});
    const t = await waitTask('evidence', (x) => x.status !== 'running');
    assert.ok(t && t.status === 'error', '模型输出不可解析时应为 error，实际 ' + JSON.stringify(t));
    assert.ok(t.error, 'error 状态必须带可见原因');
    console.log('  ✅ T1-c 业务拒绝不被 done 覆盖');
  }

  // ===== T2-a：取消 → 迟到结果不落账 =====
  {
    llmMode = 'good'; llmDelay = 1500;
    const before = await jobState();
    const beforeEv = JSON.stringify(before.job.evidence || []);
    const started = await post('/job/gen-start?id=' + DOC + '&kind=evidence', {});
    assert.ok(started.json && started.json.taskId, 'gen-start 失败');
    await new Promise((r) => setTimeout(r, 200));
    const cancelled = await post('/job/gen-cancel?id=' + DOC + '&kind=evidence&taskId=' + encodeURIComponent(started.json.taskId), {});
    if (cancelled.status !== 200) fail('gen-cancel 失败：' + cancelled.text.slice(0, 200));
    // 等在途结果到达
    await new Promise((r) => setTimeout(r, 2500));
    const d = await jobState();
    assert.deepEqual(d.job.evidence || [], JSON.parse(beforeEv), '取消后的迟到结果落账了');
    const t = (d.job.genTasks || {}).evidence;
    assert.ok(t && (t.status === 'cancelled' || t.status === 'error'), '取消后任务态异常：' + JSON.stringify(t));
    console.log('  ✅ T2-a 取消后迟到结果不落账');
  }

  // ===== T2-b：过期任务（超过 TTL）→ 结果不落账 =====
  {
    llmMode = 'good'; llmDelay = 1500;
    const started = await post('/job/gen-start?id=' + DOC + '&kind=evidence', {});
    assert.ok(started.json && started.json.taskId, 'gen-start 失败');
    // 把任务的 startedAt 改到很久以前 → 超过 TTL
    await new Promise((r) => setTimeout(r, 200));
    const raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    raw[DOC].job.genTasks.evidence.startedAt = Date.now() - 60 * 60 * 1000;
    fs.writeFileSync(metaPath, JSON.stringify(raw, null, 2));
    const t = await waitTask('evidence', (x) => x.status !== 'running', 20000);
    assert.ok(t && t.status === 'error', '过期任务应被拒，实际 ' + JSON.stringify(t));
    console.log('  ✅ T2-b 过期任务的结果不落账');
  }

  // ===== T3：资源准入（RES-02/04）：AI 槽占满 → gen-start 必须拒绝，且不得留下 running 假任务 =====
  // 反例（旧实现）：gen-start 先登记 running，runner 才去等槽；等满 5s 抛 ResourceBusy 被 catch(()=>{}) 吞掉
  //   → meta 里留下永远 running 的假任务，页面一直转圈。
  {
    llmMode = 'good'; llmDelay = 2500;
    const chat = (msg) => fetch(base + '/ai/chat?id=' + DOC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg })
    });
    const p1 = chat('占位一').catch(() => null);
    const p2 = chat('占位二').catch(() => null);
    await new Promise((r) => setTimeout(r, 500));            // 两个同步请求都已借到槽
    const started = await post('/job/gen-start?id=' + DOC + '&kind=evidence', {});
    assert.ok(started.status !== 200, 'AI 槽占满时 gen-start 不得返回 200/running，实际 ' + started.status + ' ' + started.text.slice(0, 160));
    const d = await jobState();
    const t = (d.job.genTasks || {}).evidence;
    assert.ok(!t || t.status !== 'running', '被拒的 gen-start 不得留下 running 假任务，实际 ' + JSON.stringify(t));
    await Promise.all([p1, p2]);
    llmDelay = 0;
    console.log('  ✅ T3 资源准入：槽满即拒绝且不留 running 假任务');
  }

  // ===== T3-b：容量拒绝不得改动 feedback / 任务 / 版本（准入在业务写入之前）=====
  {
    llmMode = 'good'; llmDelay = 3000;
    const chatReq = (msg) => fetch(base + '/ai/chat?id=' + DOC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg })
    }).catch(() => null);
    const p1 = chatReq('占位一');
    const p2 = chatReq('占位二');
    await new Promise((r) => setTimeout(r, 600));            // 两个同步请求已占满两个槽
    const before = await jobState();
    const gen = await post('/job/generate?id=' + DOC, { feedback: ['容量拒绝测试反馈'] });
    assert.notEqual(gen.status, 200, '容量满时 /job/generate 不得成功，实际 ' + gen.status + ' ' + gen.text.slice(0, 160));
    const after = await jobState();
    assert.deepEqual(after.job.feedback || [], before.job.feedback || [], '容量拒绝不得写入 feedback');
    assert.deepEqual(after.job.genTasks || {}, before.job.genTasks || {}, '容量拒绝不得登记任务');
    assert.equal(after.rev, before.rev, '容量拒绝不得推进版本');
    await Promise.all([p1, p2]);
    llmDelay = 0;
    console.log('  ✅ T3-b 容量拒绝 → feedback/任务/版本零改动');
  }

  // ===== T4：断连 → 真实工作结束前不腾槽（RES-03）=====
  {
    llmMode = 'good'; llmDelay = 2500;
    const ac = new AbortController();
    const chatAborted = (msg) => fetch(base + '/ai/chat?id=' + DOC, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }), signal: ac.signal
    }).catch(() => null);
    const p = chatAborted('断连测试一');
    const p2 = chatAborted('断连测试二');                    // 占满两个槽
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();                                               // 客户端断连
    await new Promise((r) => setTimeout(r, 200));
    const started = await post('/job/gen-start?id=' + DOC + '&kind=interview', {});
    assert.ok(started.status !== 200, '断连后真实工作仍在跑，gen-start 应被拒，实际 ' + started.status + ' ' + started.text.slice(0, 160));
    await Promise.all([p, p2]);
    llmDelay = 0;
    let freed = false;
    for (let i = 0; i < 60; i++) {
      const r = await fetch(base + '/ai/chat?id=' + DOC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '释放检查' })
      });
      await r.text();
      if (r.status !== 429) { freed = true; break; }
      await new Promise((x) => setTimeout(x, 300));
    }
    assert.ok(freed, '真实工作结束后 AI 槽应释放（断连不等于释放）');
    console.log('  ✅ T4 断连不早释放：真实工作结束后槽位才归还');
  }

  console.log('PASS TASK-04: 成功落账 + 换批拒绝 + 业务拒绝 + 取消不落账 + 过期不落账 + 资源准入 + 断连不腾槽');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
