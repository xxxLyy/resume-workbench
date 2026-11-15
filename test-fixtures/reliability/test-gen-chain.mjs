// test-gen-chain.mjs — 建稿后自动链：/job/gen-start?then=changes（证据 → 修改建议同槽串行）回归
// 断言（独立隔离根 + 本地桩 LLM，非浏览器段）：
//   (a) kind=evidence&then=changes → 200；证据与修改建议最终都落账（job.evidence/job.changes 非空）；
//   (b) 桩 inflight 峰值 ≤1——整条链只占 1 个 AI 槽（同一租约接力）；
//   (c) 证据在跑时取消 → 链停在证据（out.dropped），changes 任务永不创建；
//   (d) kind=changes&then=changes / kind=evidence&then=x / then=changes&scope=zone:… → 400；
//   (e) body {feedback:['偏好A']} → 并入 job.feedback；
//   (f) 不带 then 的普通 gen-start 仍回 {ok,taskId,status:'running'}（旧契约不变）。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const B = `http://127.0.0.1:${PORT}`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-genchain-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const ZW1 = 'zaaaaaa01', ZP1 = 'zaaaaaa03';
const PARA_W1 = '负责交易系统，把延迟从 80ms 降到 12ms';
const PARA_P1 = '项目甲：网关压测平台，覆盖三十万 QPS';
const REQS = ['交易系统与订单经验', '网关与链路追踪经验'];
const OPS = { summary: '工作段对齐交易系统', changes: [{ section: '工作经历', kind: 'replace', zid: ZW1, before: PARA_W1, after: '负责交易系统与网关优化，把延迟从 80ms 降到 12ms', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [] };
const EVID = { evidence: [{ req: '交易系统与订单经验', status: 'covered', refHints: [{ type: 'para', zid: ZW1, title: '', quote: PARA_W1 }] }] };

// 合成岗位草稿 ×4：同一正文骨架（带 zid 段落），meta 各不相同文档 id
const meta = {};
for (const id of ['doc1', 'doc2', 'doc3', 'doc4']) {
  let html = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'], ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) html = html.replaceAll(k, () => v);
  html = html.replace('{{WORK}}', () => `<p data-zid="${ZW1}">${PARA_W1}</p>`);
  html = html.replace('{{PROJECTS}}', () => `<p data-zid="${ZP1}">${PARA_P1}</p>`);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), html);
  meta[id] = { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    jd: '要求：交易系统与订单经验；网关与链路追踪经验',
    zones: { [ZW1]: { zone: 'work' }, [ZP1]: { zone: 'project' } },
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {}, reviewPos: { section: 'changes', changeId: null, filter: 'all' } } };
}
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify(meta, null, 2));

// —— 桩 LLM：三通道分应答 + inflight 峰值观测；证据通道延时可调（取消用例要留窗口）——
let llmInflight = 0, llmPeak = 0, evDelay = 0;
const stub = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    llmInflight++; llmPeak = Math.max(llmPeak, llmInflight);
    let sys = '';
    try { sys = JSON.parse(b).messages.find((m) => m.role === 'system').content; } catch {}
    const done = (obj, ms = 0) => setTimeout(() => {
      llmInflight--;
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
    }, ms);
    if (String(sys).includes('岗位证据分析器')) return done(EVID, evDelay);
    if (String(sys).includes('需求分析师')) return done({ requirements: REQS });
    if (String(sys).includes('简历定制编排器')) return done(OPS);
    return done({}, 0);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model-x' }]
}));

const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], { env: { ...process.env, RESUME_ROOT: root, PORT: String(PORT) }, stdio: 'pipe' });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { stub.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
try {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(B + '/'); if (r.status === 200) break; } catch {} await sleep(200); if (i === 99) fail('服务未就绪'); }
  const jobOf = async (id) => (await (await fetch(`${B}/job/changes?id=${id}`)).json()).job;
  const waitTask = async (id, kind, want, tries = 100) => {
    for (let i = 0; i < tries; i++) {
      const j = await jobOf(id);
      const gt = (j.genTasks || {})[kind];
      if (gt && gt.status === want) return gt;
      await sleep(200);
    }
    fail(`${id} ${kind} 未等到状态 ${want}`);
  };
  const post = async (u, body) => (await fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  const postCode = async (u, body) => (await fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).status;

  // (a)+(b) 链：证据 → 修改建议同槽接棒
  let r = await post('/job/gen-start?id=doc1&kind=evidence&then=changes');
  assert.equal(r.ok, true, '链式 gen-start 应 ok');
  assert.equal(r.status, 'running', '链式 gen-start 应 running');
  await waitTask('doc1', 'evidence', 'done');
  await waitTask('doc1', 'changes', 'done');
  const j1 = await jobOf('doc1');
  assert.ok((j1.evidence || []).length > 0, '链后应有证据表');
  assert.ok((j1.changes || []).length > 0, '链后应有修改建议');
  assert.ok(llmPeak <= 1, `整条链桩并发峰值应 ≤1（同一租约接力），实际 ${llmPeak}`);

  // (c) 证据在跑时取消 → 链停在证据，changes 任务永不创建
  evDelay = 1500;
  r = await post('/job/gen-start?id=doc2&kind=evidence&then=changes');
  assert.equal(r.ok, true, 'doc2 链式 gen-start 应 ok');
  await sleep(400);
  r = await post('/job/gen-cancel?id=doc2&kind=evidence&taskId=' + encodeURIComponent(r.taskId));
  assert.equal(r.ok, true, '取消在跑证据应 ok');
  evDelay = 0;
  await waitTask('doc2', 'evidence', 'cancelled');
  await sleep(600);
  const j2 = await jobOf('doc2');
  const ch2 = (j2.genTasks || {}).changes;   // genTasks 各 kind 恒有 idle 占位——看 taskId/status 而非 key 存在性
  assert.ok(!ch2 || !ch2.taskId || ch2.status === 'idle', '证据被取消后 changes 任务不应创建（链停在证据）');

  // (d) then 非法组合 → 400
  assert.equal(await postCode('/job/gen-start?id=doc1&kind=changes&then=changes'), 400, 'kind=changes&then=changes 应 400');
  assert.equal(await postCode('/job/gen-start?id=doc1&kind=evidence&then=x'), 400, 'then=x 应 400');
  assert.equal(await postCode('/job/gen-start?id=doc1&kind=changes&then=changes&scope=zone:work'), 400, 'then 带 scope 应 400');

  // (e) body feedback 并入 job.feedback
  r = await post('/job/gen-start?id=doc3&kind=evidence', { feedback: ['偏好A'] });
  assert.equal(r.ok, true, 'doc3 gen-start 应 ok');
  const j3 = await jobOf('doc3');
  assert.ok((j3.feedback || []).includes('偏好A'), 'body.feedback 应并入 job.feedback');
  await post('/job/gen-cancel?id=doc3&kind=evidence&taskId=' + encodeURIComponent(r.taskId));

  // (f) 不带 then 的旧契约：{ok,taskId,status:'running'}
  r = await post('/job/gen-start?id=doc4&kind=evidence');
  assert.equal(r.ok, true, '普通 gen-start 应 ok');
  assert.ok(typeof r.taskId === 'string' && r.taskId.length > 0, '普通 gen-start 应回 taskId');
  assert.equal(r.status, 'running', '普通 gen-start 应回 running');
  await post('/job/gen-cancel?id=doc4&kind=evidence&taskId=' + encodeURIComponent(r.taskId));

  console.log('✅ gen 自动链：evidence→changes 同槽串行（证据与建议均落账 / 桩峰值≤1 / 取消链停 / then 组合 400 / feedback 并入 / 旧契约不变）');
} finally { cleanup(); }
