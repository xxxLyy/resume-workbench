// test-gen-chain.mjs — 建稿后自动链：/job/gen-start?then=changes（证据 → 修改建议同槽串行）回归
// 断言（独立隔离根 + 本地桩 LLM，非浏览器段）：
//   (a) kind=evidence&then=changes → 200；证据与修改建议最终都落账（job.evidence/job.changes 非空）；
//   (b) 桩 inflight 峰值 ≤1——整条链只占 1 个 AI 槽（同一租约接力）；
//   (c) 证据在跑时取消 → 链停在证据（out.dropped），changes 任务永不创建；
//   (d) kind=changes&then=changes / kind=evidence&then=x / then=changes&scope=zone:… → 400；
//   (e) body {feedback:['偏好A']} → 并入 job.feedback；
//   (f) 不带 then 的普通 gen-start 仍回 {ok,taskId,status:'running'}（旧契约不变）；
//   (g) 正文无 data-zid 的草稿 → gen-start 409「正文段落还没有编号」且不消耗模型调用。
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
let llmInflight = 0, llmPeak = 0, evDelay = 0, llmCalls = 0;
const stub = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    llmInflight++; llmPeak = Math.max(llmPeak, llmInflight); llmCalls++;
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

  // (g) 无 data-zid 母版 → 建稿 → gen-start 零段落守卫 409（不落 running、不消耗模型调用）
  {
    const mz = fs.readFileSync(path.join(root, 'docs', 'doc1.html'), 'utf8').replace(/ data-zid="[^"]*"/g, '');
    fs.writeFileSync(path.join(root, 'docs', 'mzmaster.html'), mz);
    const dm = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    dm.mzmaster = { rev: 1, flow: 'draft', company: '无编号母版', role: '' };
    fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify(dm));
    const cr = await post('/job/create', { from: 'mzmaster', company: '守卫公司', role: '后端', jd: '守卫验证' });
    assert.ok(cr.ok && cr.id, '无 zid 母版建稿应成功');
    const callsBefore = llmCalls;
    const g = await post('/job/gen-start?id=' + cr.id + '&kind=evidence&then=changes');
    assert.equal(g.ok, false, '零段落正文 gen-start 应拒绝');
    assert.ok((g.error || '').includes('正文段落还没有编号'), '409 应带「正文段落还没有编号」文案，实际 ' + g.error);
    assert.equal(llmCalls, callsBefore, '守卫拒绝不应消耗模型调用');
    const jg = await jobOf(cr.id);
    assert.ok(!((jg.genTasks || {}).evidence || {}).taskId, '守卫拒绝不应留下 running 任务');
  }

  // (h) 多模型备选稿（2026-11-16）：alt=1 → altChanges 落账、changes 不动；adopt → 入待审并清空；alt 任务不可重试；参数组合 400
  {
    r = await post('/job/gen-start?id=doc4&kind=changes&alt=1');
    assert.equal(r.ok, true, 'alt gen-start 应 ok');
    const gtc = await waitTask('doc4', 'changes', 'done');
    assert.equal(gtc.alt, true, 'alt 任务记录应带 alt 标记');
    let j4 = await jobOf('doc4');
    const alts = j4.altChanges || [];
    assert.equal(alts.length, 1, 'alt 跑完应落 1 套备选稿');
    assert.equal(alts[0].key, 'stub|stub-model-x', '备选稿 key 应=「档案名|模型」：' + alts[0].key);
    assert.ok(alts[0].count >= 1 && alts[0].ops, '备选稿应带 count 与 ops');
    assert.equal((j4.changes || []).length, 0, 'alt 生成不得写 changes 待审队列');
    assert.equal(await postCode('/job/gen-retry?id=doc4&kind=changes&taskId=' + gtc.taskId + '&batch=0'), 409, 'alt 任务批次重试应 409');
    const ad = await post('/job/alt-adopt?id=doc4', { key: alts[0].key });
    assert.equal(ad.ok, true, 'alt-adopt 应 ok：' + JSON.stringify(ad).slice(0, 160));
    j4 = await jobOf('doc4');
    assert.ok((j4.changes || []).some((c) => c.status === 'pending'), '采用后应有 pending 候选');
    assert.equal((j4.altChanges || []).length, 0, '采用后 altChanges 应清空');
    assert.equal((await post('/job/alt-adopt?id=doc4', { key: alts[0].key })).ok, false, '重复采用应失败（备选稿已清空）');
    assert.equal((await post('/job/alt-adopt?id=doc4', { discard: true })).ok, true, 'discard 应 ok');
    assert.equal(await postCode('/job/gen-start?id=doc4&kind=evidence&then=changes&profile=0'), 400, 'profile+then 应 400');
    assert.equal(await postCode('/job/gen-start?id=doc4&kind=evidence&profile=0'), 400, 'evidence 带 profile 应 400');
    assert.equal(await postCode('/job/gen-start?id=doc4&kind=evidence&alt=1'), 400, 'evidence 带 alt 应 400');
    assert.equal(await postCode('/job/gen-start?id=doc4&kind=changes&profile=9'), 400, '越界 profile 应 400');
    assert.equal(await postCode('/job/gen-start?id=doc4&kind=changes&alt=1&scope=zone:work'), 400, 'alt 带 scope 应 400');
  }

  console.log('✅ gen 自动链：evidence→changes 同槽串行（证据与建议均落账 / 桩峰值≤1 / 取消链停 / then 组合 400 / feedback 并入 / 旧契约不变）+ alt 备选稿/采用/重试拒/参数 400');
} finally { cleanup(); }
