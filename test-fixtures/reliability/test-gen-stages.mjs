// test-gen-stages.mjs — S4b-A：changes 通道五阶段管线（P1 卡：kind=changes 真拆分 + 阶段上报）
// 合同：
//   ① runChangesPipeline 五阶段依次推进：analyze（JD 要求提取，独立 chat）→ locate（要求→zid 定位，纯函数）
//      → rewrite（改写，本卡单批）→ validate（parseJobOps+factGuard 既有守卫）→ assemble（applyChangesResult 落账）；
//      /job/changes 轮询可见 genTasks.changes.stages = [{stage, startedAt, ms?}] 依次追加，
//      chat 阶段在调用期间可见（开条目无 ms），完成后补 ms。
//   ② 与 S4b-B 三值 stage 并存：chat 调用点 stage='calling'、返回后 'parsing'，终态清空（既有合同零变化）。
//   ③ 产物与重构前等价（复用既有 gen 夹具断言面）：pending 候选锚定 zid/baseSnapshot/zone、todos/summary/
//      generatedAt/flow 落账、二次生成旧候选 superseded 而已处理候选不被覆盖、失败零落账（批次隔离）。
//   ④ 数据流为真：analyze 的要求与 locate 的 zid 出现在 rewrite 实际请求体里；usage 为两次 chat 调用之和
//      （桩不返回 usage → null）。
//   ⑤ evidence / interview 通道回归：通道可用且任务记录不带 stages 字段（零改动）。
// HTTP 类夹具：隔离根 + 合成岗位草稿 + 本机桩 LLM（按 system 分流、可控延迟/坏输出/usage）；零真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-gens-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const Z_WORK = 'zbbbbbbbb';   // z + 8 位十六进制
const PARA_WORK = '负责交易系统，把延迟从 80ms 降到 12ms';
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'),
  `<!doctype html><html><head><title>t</title></head><body><h1>合成</h1>`
  + `<h2>工作经历</h2><div class="entry-head" data-zid="zaaaaaaaa">公司甲 后端工程师 2021-2024</div>`
  + `<p data-zid="${Z_WORK}">${PARA_WORK}</p>`
  + `<h2>项目经历</h2><p data-zid="zcccccccc">项目一：订单系统拆分，支撑日订单十二万</p></body></html>`);
const JD = '要求：交易系统与高并发经验，量化结果导向';
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位', jd: JD,
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} } }
}, null, 2));

// —— 桩 LLM：按 system 关键词分流五阶段管线与 evidence/interview 通道；每路可控延迟/模式/usage ——
const ANALYZE_REQS = ['交易系统与高并发经验', '量化结果导向'];
const OPS_1 = {
  summary: '对齐交易系统与高并发',
  changes: [{ section: '工作经历', kind: 'replace', before: PARA_WORK,
    after: '负责交易系统与订单网关，把延迟从 80ms 降到 12ms', reason: '对齐 JD 高并发要求', source: '母版', level: 'normal' }],
  todos: [{ section: '工作经历', question: '缺少团队规模数据', why: 'JD 要求带团队经验' }]
};
const OPS_2_AFTER = '负责交易系统稳定性专项，把延迟从 80ms 降到 12ms';   // 二次生成：旧候选 superseded、新候选顶上
const EV_REQ = '要求一：交易系统高并发';
const INTERVIEW = { chains: [{ evIndex: 0, question: '延迟是怎么从 80ms 降下来的？', followUp: '压测口径是什么', answerPoints: [{ text: '讲清优化路径', quote: '把延迟从 80ms 降到 12ms' }] }], generic: [] };
let analyzeMode = 'good';      // 'good' | 'broken'
let rewriteMode = 'good';      // 'good' | 'broken'
let withUsage = true;          // 桩是否返回 usage
let rewriteAfter = null;       // null → OPS_1；字符串 → 二次生成的 after
let delayAnalyzeMs = 0, delayRewriteMs = 0;
const hits = { analyze: 0, rewrite: 0, evidence: 0, interview: 0 };
let lastAnalyzeBody = '', lastRewriteBody = '', lastEvidenceBody = '', lastInterviewBody = '';
const USAGE_A = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };
const USAGE_R = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let sys = '', delay = 0;
    try { sys = JSON.parse(b).messages.find((m) => m.role === 'system').content; } catch {}
    const ok = (content, usage) => {
      const body = { choices: [{ message: { content } }] };
      if (withUsage && usage) body.usage = usage;
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }, delay);
    };
    if (String(sys).includes('需求分析师')) {          // ① analyze：JD 要求提取
      hits.analyze++; lastAnalyzeBody = b; delay = delayAnalyzeMs;
      return ok(analyzeMode === 'good' ? JSON.stringify({ requirements: ANALYZE_REQS }) : '抱歉，这不是要求清单 JSON。', USAGE_A);
    }
    if (String(sys).includes('简历定制编排器')) {      // ③ rewrite：改写（单批）
      hits.rewrite++; lastRewriteBody = b; delay = delayRewriteMs;
      const ops = rewriteAfter
        ? { ...OPS_1, changes: [{ ...OPS_1.changes[0], after: rewriteAfter }], todos: [] }
        : OPS_1;
      return ok(rewriteMode === 'good' ? JSON.stringify(ops) : '抱歉，这不是修改操作 JSON。', USAGE_R);
    }
    if (String(sys).includes('证据分析')) {            // evidence 通道（回归）
      hits.evidence++; lastEvidenceBody = b;
      return ok(JSON.stringify({ evidence: [{ req: EV_REQ, status: 'covered', refHints: [{ type: 'para', zid: Z_WORK, title: '工作经历', quote: PARA_WORK }] }] }), { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 });
    }
    if (String(sys).includes('面试官')) {              // interview 通道（回归）
      hits.interview++; lastInterviewBody = b;
      return ok(JSON.stringify(INTERVIEW), { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 });
    }
    return ok('{}', null);
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
const getJson = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) }; };
const post = async (p) => { const r = await fetch(base + p, { method: 'POST' }); return { status: r.status, json: await r.json().catch(() => null) }; };
const view = async () => (await getJson('/job/changes?id=' + DOC)).json;
const taskOf = (v, kind) => v.job.genTasks[kind];

// 等任务离开 running；期间每 60ms 采样一次 stages 快照（窗口断言用）
async function runAndSample(kind, untilFn) {
  const started = await post('/job/gen-start?id=' + DOC + '&kind=' + kind);
  assert.ok(started.json && started.json.ok, 'gen-start 应成功：' + JSON.stringify(started.json));
  const deadline = Date.now() + 20000;
  const samples = [];
  let last = null;
  while (Date.now() < deadline) {
    const v = await view();
    last = taskOf(v, kind);
    samples.push(last);
    if (last && untilFn(last)) return { task: last, samples, view: v };
    await new Promise((r) => setTimeout(r, 60));
  }
  fail('任务 20s 未达期望状态，最后：' + JSON.stringify(last) + '\n' + serverLog.slice(-600));
}
const waitDone = async (kind) => {
  const r = await runAndSample(kind, (t) => t.status !== 'running');
  assert.equal(r.task.status, 'done', kind + ' 应 done，实际：' + JSON.stringify(r.task));
  return r;
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== A：happy path——stages 依次推进 + 粗粒度三值并存 + usage 两次调用合并 + 产物等价 =====
  {
    analyzeMode = rewriteMode = 'good'; withUsage = true; rewriteAfter = null;
    delayAnalyzeMs = 1500; delayRewriteMs = 1500;
    const started = await post('/job/gen-start?id=' + DOC + '&kind=changes');
    assert.ok(started.json && started.json.ok, 'changes gen-start 应成功：' + JSON.stringify(started.json));

    // A1：analyze chat 调用期间——stages[0]=analyze 开条目（无 ms），粗粒度 stage=calling
    //（窗口断言：只认「开条目未收 ms」的采样，错过窗口即红——不靠提示文字）
    let saw = null, lastT = null;
    const dl1 = Date.now() + 8000;
    while (Date.now() < dl1) {
      const v = await view();
      const t = taskOf(v, 'changes');
      lastT = t;
      if (t && Array.isArray(t.stages) && t.stages.length >= 1 && t.stages[0].ms === undefined && t.status === 'running') { saw = t; break; }
      if (t && t.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(saw, 'analyze 调用期间应能在 /job/changes 看到 stages 开条目（最后采样：' + JSON.stringify(lastT) + '）');
    assert.equal(saw.stages[0].stage, 'analyze', '首条明细应为 analyze，实际：' + JSON.stringify(saw.stages));
    assert.equal(saw.stages[0].ms, undefined, '调用中的阶段不应已有 ms');
    assert.equal(typeof saw.stages[0].startedAt, 'number', 'startedAt 应为毫秒数');
    assert.equal(saw.stage, 'calling', 'chat 调用点粗粒度 stage 应为 calling（S4b-B 语义保持），实际：' + saw.stage);
    assert.ok(saw.usage === null || saw.usage === undefined, '调用未返回前 usage 尚未记录');

    // A2：rewrite chat 调用期间——analyze/locate 已收口（有 ms），rewrite 开条目
    saw = null;
    const dl2 = Date.now() + 8000;
    while (Date.now() < dl2) {
      const v = await view();
      const t = taskOf(v, 'changes');
      lastT = t;
      if (t && t.status === 'running' && Array.isArray(t.stages) && t.stages.length >= 3 && t.stages[2].ms === undefined) { saw = t; break; }
      if (t && t.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.ok(saw, 'rewrite 调用期间应看到前三条明细（最后采样：' + JSON.stringify(lastT) + '）');
    assert.deepEqual(saw.stages.map((s) => s.stage), ['analyze', 'locate', 'rewrite'], '前三条应为 analyze→locate→rewrite，实际：' + JSON.stringify(saw.stages));
    assert.equal(typeof saw.stages[0].ms, 'number', 'analyze 完成后应有 ms');
    assert.equal(typeof saw.stages[1].ms, 'number', 'locate（纯函数）应有 ms');
    assert.equal(saw.stages[2].ms, undefined, 'rewrite 调用中不应已有 ms');
    assert.equal(saw.stage, 'calling', 'rewrite 调用点粗粒度 stage 仍应为 calling');
    assert.deepEqual(saw.usage, { prompt: 11, completion: 22, total: 33 }, 'analyze 返回后 usage 先落一次（S4b-B parsing 检查点合同）');

    // 等完成
    let done = null, vDone = null;
    const dl3 = Date.now() + 20000;
    while (Date.now() < dl3) {
      const v = await view();
      const t = taskOf(v, 'changes');
      if (t && t.status !== 'running') { done = t; vDone = v; break; }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(done && done.status === 'done', '任务应完成，实际：' + JSON.stringify(done));
    // A3：终态——五条明细按序、四个可收口阶段带 ms、assemble 保留开条目（落账即终态，守卫拒绝事后补写）
    assert.deepEqual(done.stages.map((s) => s.stage), ['analyze', 'locate', 'rewrite', 'validate', 'assemble'], '五阶段明细应按序齐备：' + JSON.stringify(done.stages));
    for (const s of done.stages.slice(0, 4)) assert.equal(typeof s.ms, 'number', s.stage + ' 完成后应带 ms');
    assert.equal(done.stages[4].ms, undefined, 'assemble 为终态前最后一步，不写 ms（合同 ms? 可缺省）');
    const starts = done.stages.map((s) => s.startedAt);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] >= starts[i - 1], 'startedAt 应非递减');
    assert.equal(done.stage, null, '终态后粗粒度 stage 清空（completeGenResult 既有合同）');
    assert.equal(done.error, null, '成功任务 error 为 null');
    assert.deepEqual(done.usage, { prompt: 111, completion: 72, total: 183 }, 'usage 应为 analyze+rewrite 两次调用之和');
    assert.equal(done.model, 'stub-model-x', 'model 仍记录启动时 profile 模型名');
    assert.equal(done.scope, 'all', 'scope 记录不变');

    // A4：产物等价（既有 gen 夹具断言面）：候选锚定 + todos/summary/flow
    const job = vDone.job;
    const c = (job.changes || [])[0];
    assert.ok(c, '应有候选入库');
    assert.equal(c.status, 'pending', '新候选应为 pending');
    assert.equal(c.kind, 'replace', '候选 kind 为 replace');
    assert.equal(c.gen, 1, '首批 gen=1');
    assert.equal(c.id, 'g1-c1', '候选 id 口径不变');
    assert.equal(c.zid, Z_WORK, '候选应锚定 before 文本命中的段落 zid');
    assert.equal(c.baseSnapshot, PARA_WORK, 'baseSnapshot 为生成时段落快照（S4a-T8 合同不变）');
    assert.equal(c.zone, 'work', 'zone 归属 guessZone（工作经历→work）不变');
    assert.equal(c.after, '负责交易系统与订单网关，把延迟从 80ms 降到 12ms', '候选内容为桩 rewrite 输出');
    assert.equal(job.changes.length, 1, '被 factGuard/guardOps 丢弃的输出不得入库');
    assert.equal(job.summary, '对齐交易系统与高并发', 'summary 落账不变');
    assert.equal(job.todos.length, 1, 'todos 落账不变');
    assert.equal(job.todos[0].question, '缺少团队规模数据', 'todo 内容不变');
    assert.equal(job.flow, 'reviewing', '有候选时 flow=reviewing 不变');
    assert.equal(typeof job.generatedAt, 'string', 'generatedAt 落账不变');

    // A5：数据流为真——analyze 的要求与 locate 的 zid 出现在 rewrite 实际请求体
    const rb = JSON.parse(lastRewriteBody);
    const rUser = rb.messages.find((m) => m.role === 'user').content;
    assert.ok(lastAnalyzeBody.includes('交易系统与高并发经验'), 'analyze 请求应携带 JD（要求提取的输入）');
    assert.ok(rUser.includes('要求→段落定位'), 'rewrite 请求应带定位块');
    assert.ok(rUser.includes('交易系统与高并发经验'), 'analyze 的要求应流入 rewrite 请求');
    assert.ok(rUser.includes('（zid：' + Z_WORK + '）' + PARA_WORK), 'locate 命中的 zid+段落原文应流入 rewrite 请求（before 逐字锚定依据）');
    assert.ok(rUser.includes('【母版简历正文】'), 'rewrite 仍走 buildJobPrompt 既有合同（单批）');
    assert.ok(lastRewriteBody.includes('简历定制编排器'), 'rewrite system 仍是编排器 prompt');
  }

  // ===== F：二次生成——旧候选 superseded、新候选顶上；桩不返回 usage → null =====
  {
    withUsage = false; rewriteAfter = OPS_2_AFTER; delayAnalyzeMs = 0; delayRewriteMs = 0;
    const r = await waitDone('changes');
    assert.deepEqual(r.task.usage, null, '两次调用都无 usage → 任务 usage=null');
    assert.deepEqual(r.task.stages.map((s) => s.stage), ['analyze', 'locate', 'rewrite', 'validate', 'assemble'], '二次生成五阶段明细同样齐备');
    const job = r.view.job;
    const superseded = (job.changes || []).filter((c) => c.status === 'superseded');
    const pend = (job.changes || []).filter((c) => c.status === 'pending');
    assert.equal(superseded.length, 1, '首批候选应被标 superseded');
    assert.equal(superseded[0].gen, 1, 'superseded 的是首批候选');
    assert.equal(pend.length, 1, '新候选 pending');
    assert.equal(pend[0].gen, 2, '新候选 gen=2');
    assert.equal(pend[0].after, OPS_2_AFTER, '新候选内容来自第二次 rewrite');
    assert.equal(pend[0].zid, Z_WORK, '二次生成锚定不变');
  }

  // ===== B：analyze 失败——显式失败、零落账、明细停在 analyze =====
  {
    withUsage = true; rewriteAfter = null; analyzeMode = 'broken'; rewriteMode = 'good';
    const before = await view();
    const beforeChanges = JSON.stringify(before.job.changes);
    const started = await post('/job/gen-start?id=' + DOC + '&kind=changes');
    assert.ok(started.json && started.json.ok, 'analyze 失败用例 gen-start 应成功');
    const dl = Date.now() + 15000;
    let t = null;
    while (Date.now() < dl) {
      const v = await view();
      t = taskOf(v, 'changes');
      if (t && t.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(t && t.status === 'error', 'analyze 输出不可解析 → 任务 error，实际：' + JSON.stringify(t));
    assert.ok((t.error || '').includes('要求清单'), '错误应指明要求清单解析失败，实际：' + t.error);
    assert.deepEqual(t.stages.map((s) => s.stage), ['analyze'], '失败应停在 analyze（不进 rewrite）');
    assert.equal(typeof t.stages[0].ms, 'number', 'analyze 已返回（不可解析），ms 应已收口');
    assert.equal(hits.rewrite, 2, 'analyze 失败不得再发起 rewrite 调用');
    const after = await view();
    assert.equal(JSON.stringify(after.job.changes), beforeChanges, '失败零落账（批次隔离：候选不变）');
    assert.equal(after.job.flow, 'reviewing', '失败不改 flow');
  }

  // ===== C：rewrite 失败——既有「无法解析为修改操作」合同不变，明细含 validate =====
  {
    analyzeMode = 'good'; rewriteMode = 'broken'; delayAnalyzeMs = 0; delayRewriteMs = 0;
    const started = await post('/job/gen-start?id=' + DOC + '&kind=changes');
    assert.ok(started.json && started.json.ok, 'rewrite 失败用例 gen-start 应成功');
    const dl = Date.now() + 15000;
    let t = null;
    while (Date.now() < dl) {
      const v = await view();
      t = taskOf(v, 'changes');
      if (t && t.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 80));
    }
    assert.ok(t && t.status === 'error', 'rewrite 输出不可解析 → 任务 error');
    assert.ok((t.error || '').includes('无法解析为修改操作'), '错误文案与重构前一致，实际：' + t.error);
    assert.deepEqual(t.stages.map((s) => s.stage), ['analyze', 'locate', 'rewrite', 'validate'], '失败明细应含 validate（护栏在此拒绝）');
    const after = await view();
    assert.equal((after.job.changes || []).filter((c) => c.status === 'pending').length, 1, '失败零落账：唯一 pending 仍是 F 步候选');
  }

  // ===== D+E：evidence / interview 通道回归（可用 + 不带 stages 字段）=====
  {
    analyzeMode = 'good'; rewriteMode = 'good'; rewriteAfter = null; withUsage = true;
    const ev = await waitDone('evidence');
    const evJob = ev.view.job;
    assert.equal((evJob.evidence || [])[0] && evJob.evidence[0].req, EV_REQ, 'evidence 通道可用（回归）');
    assert.equal(evJob.evidence[0].refs[0].zid, Z_WORK, 'evidence ref 绑定段落 zid（回归）');
    assert.equal(taskOf(ev.view, 'evidence').stages, undefined, 'evidence 任务记录不带 stages 字段（通道零改动）');
    assert.deepEqual(taskOf(ev.view, 'evidence').usage, { prompt: 7, completion: 8, total: 15 }, 'evidence usage 合同不变');
    const iv = await waitDone('interview');
    const ivJob = iv.view.job;
    assert.equal((ivJob.interview.chains || []).length, 1, 'interview 通道可用（回归）');
    assert.equal(taskOf(iv.view, 'interview').stages, undefined, 'interview 任务记录不带 stages 字段（通道零改动）');
  }

  // ===== F2：/job/changes 响应面回归：genTtlMs 仍在、stages 随 genTasks.changes 暴露 =====
  {
    const v = await view();
    assert.equal(v.genTtlMs, 20 * 60 * 1000, 'genTtlMs 随响应（S4b-B 合同不变）');
    assert.ok(Array.isArray(v.job.genTasks.changes.stages), 'changes 任务 stages 经 /job/changes 暴露');
  }

  console.log('✅ 生成管线五阶段：stages 依次推进可见、粗粒度三值并存、usage 两次调用合并、产物与重构前等价、evidence/interview 零回归、失败零落账');
} finally {
  cleanup();
}
