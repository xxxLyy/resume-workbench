// test-gen-batches.mjs — S4b-A P2：分批并行改写 + 每批校验与空间预算 + 批次进度
// 合同：
//   ① 批次规划：locate 命中的目标 zid 按 meta.zones 归属分桶（区域唯一真源），每桶按文档序切成 ≤3 zid/批；
//      无 zones 数据或零命中 → 回退单批（全文任务保持 P1 全文 prompt 形状、zone:<key> 任务保持 P1 整区域形状）。
//   ② 批次执行为【顺序】（卡片允许的简化，取舍见 server.mjs runChangesPipeline 头注）：每批独立 chat、
//      整任务共用 /job/gen-start 借出的那一个 AI 槽（租约透传合同不变）。
//   ③ 每批完成后校验：factGuard（在 parseJobOps 内）+ 空间预算（口径见 server.mjs batchBudgetError 注释：
//      Σ|改后| ≤ Σ|该批目标段落原文| ×1.3 + 80 字符）；失败批登记 batches.failed、不进 assemble（单批失败
//      不污染成功批），成功批合并后一次 assemble 落账（applyChangesResult 语义不变）。
//   ④ 批次进度：genTasks.changes.batches = {total, done, failed:[{batch(0 基), error}]} 随 /job/changes 暴露，
//      随批推进可见（不等任务结束）；不显示百分比（诚实进度纪律——只暴露真实计数）。
//   ⑤ 终态语义（自定，见 server.mjs 头注）：只要有一批成功 → 任务 done（batches.failed 即「待重试」的可见
//      登记，不发明新状态污染面板/状态机）；全部批失败 → 沿用 P1 既有 error 文案。
//   ⑥ usage 为 analyze + 全部批次调用（含失败批——服务商调用已发生）之和。
// HTTP 类夹具：隔离根 + 合成岗位草稿（带 zones）+ 本机桩 LLM（按 system 分流 + 按批计数应答）；零真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-genb-'));
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

// —— 桩 LLM：analyze 按 system 分流；rewrite 按调用序（=批序）走 batchScript(idx) 应答 ——
const REQS_FULL = ['交易系统与订单经验', '网关与链路追踪经验', '灰度发布与监控告警经验'];
const OPS_B0 = { summary: '工作段对齐交易系统', changes: [{ section: '工作经历', kind: 'replace', zid: ZW1, before: PARA_W1, after: '负责交易系统与网关优化，把延迟从 80ms 降到 12ms', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [{ section: '工作经历', question: '缺少团队规模数据', why: 'JD 要求带团队经验' }] };
const OPS_B1 = { summary: '项目段对齐网关与追踪', changes: [{ section: '项目经历', kind: 'replace', zid: ZP1, before: PARA_P1, after: '项目甲：网关压测平台，覆盖三十万 QPS 与突发流量', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [{ section: '项目经历', question: '缺少压测口径', why: '量化可信度' }] };
const OPS_B2 = { summary: '监控段补充', changes: [{ section: '项目经历', kind: 'replace', zid: ZP4, before: PARA_P4, after: '项目丁：监控告警面板与值班升级', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [] };
const OPS_FULL = { summary: '全文定制', changes: [{ section: '工作经历', kind: 'replace', before: PARA_W1, after: PARA_W1 + '（定制版）', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [] };
const BROKEN = '抱歉，这不是修改操作 JSON。';
const USAGE_A = { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 };
const USAGE_B = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
let analyzeReqs = REQS_FULL;
let batchScript = null;        // (idx) => { content, usage, delayMs }
let rewriteCalls = 0;
const rewriteBodies = [];
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
    if (String(sys).includes('需求分析师')) return ok(JSON.stringify({ requirements: analyzeReqs }), USAGE_A);
    if (String(sys).includes('简历定制编排器')) {
      const idx = rewriteCalls++;
      rewriteBodies.push(b);
      const r = batchScript(idx);
      return ok(r.content, r.usage, r.delayMs || 0);
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
const view = async () => { const r = await fetch(base + '/job/changes?id=' + DOC); return r.json(); };
const taskOf = (v) => v.job.genTasks.changes;
const genStart = async () => { const r = await fetch(base + '/job/gen-start?id=' + DOC + '&kind=changes', { method: 'POST' }); return r.json(); };
// 等任务离开 running；窗口断言在等待期间采样
async function runToTerminal(onSample) {
  const started = await genStart();
  assert.ok(started && started.ok, 'gen-start 应成功：' + JSON.stringify(started));
  const deadline = Date.now() + 20000;
  let last = null;
  while (Date.now() < deadline) {
    const v = await view();
    last = taskOf(v);
    if (onSample) onSample(last);
    if (last && last.status !== 'running') return { task: last, view: v };
    await new Promise((r) => setTimeout(r, 60));
  }
  fail('任务 20s 未结束，最后：' + JSON.stringify(last) + '\n' + serverLog.slice(-600));
}

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== A：3 批（work 2 zid 一批；project 4 zid 按 ≤3 切两批），批 2 失败 → 成功批落账、失败批登记、终态 done =====
  {
    analyzeReqs = REQS_FULL; rewriteCalls = 0; rewriteBodies.length = 0;
    batchScript = (i) => i === 0 ? { content: JSON.stringify(OPS_B0), usage: USAGE_B }
      : i === 1 ? { content: JSON.stringify(OPS_B1), usage: USAGE_B }
      : { content: BROKEN, usage: USAGE_B, delayMs: 1200 };   // 批 2 失败 + 延迟窗口供在途断言
    let sawInflight = null;
    const { task, view: v } = await runToTerminal((t) => {
      if (t && t.status === 'running' && t.batches && t.batches.total === 3 && t.batches.done === 2 && t.batches.failed.length === 0) sawInflight = t;
    });
    // A1：批 2 调用期间——batches 实时推进可见（total 3 / done 2），粗粒度 calling（模型调用中）
    assert.ok(sawInflight, '批 2 在途窗口应看到 batches {total:3, done:2} 实时推进（最后：' + JSON.stringify(task) + '）');
    assert.equal(sawInflight.stage, 'calling', '批次 chat 调用点粗粒度 stage 应为 calling');
    // A2：终态——done + 失败批登记（0 基批号），成功批内容全部落账且只有一个 gen
    assert.equal(task.status, 'done', '有成功批时任务应 done（终态语义见头注），实际：' + JSON.stringify(task));
    assert.deepEqual(task.batches, { total: 3, done: 2, failed: [{ batch: 2, error: '模型输出无法解析为修改操作' }] }, '失败批应登记且不污染 done 计数');
    assert.equal(task.stage, null, '终态粗粒度 stage 清空');
    assert.deepEqual(task.usage, { prompt: 41, completion: 37, total: 78 }, 'usage = analyze + 三次批调用（失败批的调用已发生，照实计入）');
    assert.deepEqual(task.stages.map((s) => s.stage), ['analyze', 'locate', 'rewrite', 'validate', 'assemble'], '五阶段明细保持');
    const job = v.job;
    assert.equal(job.changes.length, 2, '只有成功批的候选入库（失败批内容不得出现）');
    const c1 = job.changes[0], c2 = job.changes[1];
    assert.equal(c1.id, 'g1-c1');
    assert.equal(c1.zid, ZW1, '批 0 候选锚定其 zid');
    assert.equal(c1.zone, 'work', '批 0 候选 zone=work（zones 真源）');
    assert.equal(c1.baseSnapshot, PARA_W1, 'baseSnapshot 为段落快照');
    assert.equal(c1.status, 'pending');
    assert.equal(c2.id, 'g1-c2');
    assert.equal(c2.zid, ZP1, '批 1 候选锚定其 zid');
    assert.equal(c2.zone, 'project', '批 1 候选 zone=project');
    assert.equal(c2.gen, 1, '两批合并为一次落账（同一 gen）');
    assert.equal(job.changes.some((c) => c.zid === ZP4), false, '失败批（批 2）的候选不得入库');
    assert.equal(job.todos.length, 2, '成功批 todos 合并落账');
    assert.equal(job.flow, 'reviewing', '有候选 flow=reviewing');
    // A3：批 prompt 隔离与数据流——批 0 请求只带本批 zid 标注 + 本批对应 JD 要求
    const b0 = JSON.parse(rewriteBodies[0]);
    const b0u = b0.messages.find((m) => m.role === 'user').content;
    assert.ok(b0u.includes('（zid：' + ZW1 + '）' + PARA_W1), '批 0 应带本批段落 zid 标注');
    assert.ok(!b0u.includes('（zid：' + ZP4 + '）'), '批 0 不得带其他批的 zid 标注（批间隔离）');
    assert.ok(b0u.includes('本批对应 JD 要求') && b0u.includes('交易系统与订单经验'), 'locate 的要求应流入对应批的 prompt');
    assert.ok(b0.messages.find((m) => m.role === 'system').content.includes('局部重生成'), '区域批走既有局部重生成 prompt 合同（zid 回传 + 越界禁令）');
  }

  // ===== B：空间预算——批 1 改后文本超预算 → 该批登记失败，其余批照常落账 =====
  {
    analyzeReqs = REQS_FULL; rewriteCalls = 0; rewriteBodies.length = 0;
    const inflated = { ...OPS_B1, changes: [{ ...OPS_B1.changes[0], after: '胀'.repeat(300) }], todos: [] };
    batchScript = (i) => i === 0 ? { content: JSON.stringify(OPS_B0), usage: USAGE_B }
      : i === 1 ? { content: JSON.stringify(inflated), usage: USAGE_B }
      : { content: JSON.stringify(OPS_B2), usage: USAGE_B };
    const { task, view: v } = await runToTerminal(null);
    assert.equal(task.status, 'done', '预算失败批不影响任务 done');
    assert.equal(task.batches.total, 3);
    assert.equal(task.batches.done, 2, '批 0/批 2 成功');
    assert.equal(task.batches.failed.length, 1, '仅批 1 失败');
    assert.ok(task.batches.failed[0].batch === 1 && task.batches.failed[0].error.includes('空间预算'), '失败批应带预算错误：' + JSON.stringify(task.batches.failed));
    const job = v.job;
    const pend = (job.changes || []).filter((c) => c.status === 'pending');
    assert.equal(pend.length, 2, '只有成功批的新候选 pending（A 轮候选已被 superseded）');
    assert.equal(job.changes.some((c) => c.status === 'superseded'), true, 'A 轮候选应被本轮落账 superseded');
    assert.equal(pend.some((c) => c.zid === ZW1), true, '批 0 候选入库');
    assert.equal(pend.some((c) => c.zid === ZP4), true, '同任务的批 2 候选照常入库');
    assert.equal(pend.some((c) => c.zid === ZP1), false, '超预算批（批 1）候选不得入库');
  }

  // ===== C：全部批失败 → 沿用 P1 既有 error 文案，零落账 =====
  {
    analyzeReqs = REQS_FULL; rewriteCalls = 0; rewriteBodies.length = 0;
    const before = await view();
    const beforeChanges = JSON.stringify(before.job.changes);
    batchScript = () => ({ content: BROKEN, usage: USAGE_B });
    const { task } = await runToTerminal(null);
    assert.equal(task.status, 'error', '全部批失败 → 任务 error');
    assert.ok((task.error || '').includes('无法解析为修改操作'), '错误文案与 P1 一致，实际：' + task.error);
    assert.deepEqual(task.batches, {
      total: 3, done: 0,
      failed: [{ batch: 0, error: '模型输出无法解析为修改操作' }, { batch: 1, error: '模型输出无法解析为修改操作' }, { batch: 2, error: '模型输出无法解析为修改操作' }]
    }, '三批全部登记失败');
    const after = await view();
    assert.equal(JSON.stringify(after.job.changes), beforeChanges, '全部失败零落账');
  }

  // ===== D：零命中回退——analyze 返回空要求 → 单批全文（P1 prompt 形状），batches={total:1} =====
  {
    analyzeReqs = []; rewriteCalls = 0; rewriteBodies.length = 0;
    batchScript = () => ({ content: JSON.stringify(OPS_FULL), usage: USAGE_B });
    const { task, view: v } = await runToTerminal(null);
    assert.equal(task.status, 'done');
    assert.deepEqual(task.batches, { total: 1, done: 1, failed: [] }, '零命中回退单批');
    const b0 = JSON.parse(rewriteBodies[0]);
    const b0u = b0.messages.find((m) => m.role === 'user').content;
    assert.ok(b0u.includes('【母版简历正文】'), '回退批保持 P1 全文 prompt 形状');
    assert.ok(!b0u.includes('（zid：'), '回退批（全文形状）不带 zid 标注');
    const c = (v.job.changes || []).filter((x) => x.status === 'pending')[0];
    assert.equal(c && c.zid, ZW1, '回退批候选按 before 文本锚定');
    assert.equal((v.job.changes || []).filter((x) => x.status === 'pending').length, 1);
  }

  console.log('✅ 分批改写：batches 实时推进、失败批登记不污染成功批、预算校验拦截超编批、全部失败沿用既有文案、回退单批保持 P1 形状');
} finally {
  cleanup();
}
