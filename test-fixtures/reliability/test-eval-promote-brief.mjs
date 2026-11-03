// test-eval-promote-brief.mjs — F2 评估报告 angle/gaps 预填岗位定制要求（/eval/promote 补传 brief）
// 验收口径（卡片原文，逐条进断言）：
//   ① POST /eval/create → /eval/promote → GET /job/changes 断言 brief.focus 含 angle 与 gaps 条目；
//   ③ angle/gaps 全空时 focus=[] 且 promote 仍 200；
//   ④ 重复 promote 仍 409 幂等（existing 指向同一草稿）；
//   附：gaps 超 20 条时经 normBrief 自动截断（focus = angle + 前 20 条 gaps）。
// 预填契约：focus = [blocks.angle, ...blocks.gaps]（eval.mjs 输出契约已采集这两字段），
//           filter 空串后经 normBrief 校验（trim / 20 条上限 / degree=refocus、pages=2 缺省）。
// HTTP 类夹具：隔离 RESUME_ROOT + 随机端口 + assembleTemplate 合成母版 + 本地 stub LLM
// （test.sh 假 LLM 模式：OpenAI 兼容 /chat/completions、按 system 关键词「岗位快速评估器」分流、
// 控制文件切换场景）；评估回复含 angle/gaps/matches 字段。真实 ~/resume 数据禁写禁删。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-evbrief-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
// 引文「负责交易系统」6 码元（parseEvalReport 引文下限），必须逐字出现在母版可见正文
doc = doc.replace('{{WORK}}', () => '<p data-zid="z11111111">工作经历：负责交易系统</p>');
doc = doc.replace('{{PROJECTS}}', () => '');
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [DOC]: { rev: 1, flow: 'draft', kind: 'master' } }, null, 2));

// —— stub LLM（OpenAI 兼容，test.sh 假 LLM 模式）：评估回复含 angle/gaps/matches，控制文件切换场景 ——
const EVAL_REPORT = (angle, gaps) => JSON.stringify({
  roleSummary: '负责交易系统后端研发', company: '评估甲公司', roleName: '后端工程师',
  level: 'right', levelReason: '恰好匹配',
  salary: { text: '', source: 'JD 未提供' },
  angle,
  matches: [{ req: '负责后端服务', status: 'covered', evidence: '负责交易系统', weight: 'must', weightFrom: 'JD 原文' }],
  score: 4.5, verdict: 'apply', verdictReason: '整体匹配', gaps
});
const MANY_GAPS = Array.from({ length: 22 }, (_, i) => '缺口' + String(i + 1).padStart(2, '0'));
const stub = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    let content = '';
    try {
      const sys = JSON.parse(b).messages.find((m) => m.role === 'system').content;
      if (String(sys).includes('岗位快速评估器')) {
        if (fs.existsSync(path.join(root, 'llm-eval-empty'))) content = EVAL_REPORT('', []);
        else if (fs.existsSync(path.join(root, 'llm-eval-many'))) content = EVAL_REPORT('突出高并发交易系统经验', MANY_GAPS);
        else content = EVAL_REPORT('突出高并发交易系统经验', ['补充量化指标', '补充领域证书']);
      }
    } catch {}
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ choices: [{ message: { content } }] }));
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
let exited = null;
server.on('exit', (c, sg) => { exited = { c, s: sg }; });
const base = `http://127.0.0.1:${port}`;
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { stub.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务提前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① 评估 → 转适配 → brief.focus 预填 =====
  const ev = await post('/eval/create', { from: DOC, jd: '负责高并发交易系统后端研发', company: '评估甲公司', role: '后端工程师' });
  assert.ok(ev.status === 200 && ev.body && ev.body.ok && ev.body.eval && ev.body.eval.id, '① /eval/create 应 200 且落库：' + JSON.stringify(ev.body).slice(0, 200));
  const evalId = ev.body.eval.id;
  assert.equal(ev.body.eval.blocks.angle, '突出高并发交易系统经验', '① 评估记录应采集 angle（eval.mjs 契约）');
  assert.deepEqual(ev.body.eval.blocks.gaps, ['补充量化指标', '补充领域证书'], '① 评估记录应采集 gaps');

  const pm = await post('/eval/promote', { evalId, from: DOC });
  assert.ok(pm.status === 200 && pm.body && pm.body.ok && pm.body.id, '① promote 应 200：' + JSON.stringify(pm.body).slice(0, 200));
  const draftId = pm.body.id;
  const ch = await get('/job/changes?id=' + draftId);
  assert.equal(ch.status, 200, '① /job/changes 应 200');
  assert.deepEqual(ch.body.job.brief.focus, ['突出高并发交易系统经验', '补充量化指标', '补充领域证书'],
    '① brief.focus 应为 [angle, ...gaps]（经 normBrief），实际：' + JSON.stringify(ch.body.job.brief));
  assert.equal(ch.body.job.brief.degree, 'refocus', '① degree 走 normBrief 缺省');
  assert.equal(ch.body.job.brief.pages, 2, '① pages 走 normBrief 缺省');

  // ===== ④ 重复 promote 幂等 409 =====
  const pm2 = await post('/eval/promote', { evalId, from: DOC });
  assert.equal(pm2.status, 409, '④ 重复 promote 应 409，实际：' + pm2.status);
  assert.equal(pm2.body && pm2.body.existing, draftId, '④ 409 的 existing 应指向同一草稿');

  // ===== ③ angle/gaps 全空 → focus=[] 且 promote 仍 200 =====
  fs.writeFileSync(path.join(root, 'llm-eval-empty'), '1');
  const ev2 = await post('/eval/create', { from: DOC, jd: '负责高并发交易系统后端研发', company: '评估乙公司', role: '测试工程师' });
  assert.ok(ev2.status === 200 && ev2.body.ok, '③ 空报告 /eval/create 应 200');
  assert.equal(ev2.body.eval.blocks.angle, '', '③ 空报告 angle 应为空串');
  assert.deepEqual(ev2.body.eval.blocks.gaps, [], '③ 空报告 gaps 应为空数组');
  const pm3 = await post('/eval/promote', { evalId: ev2.body.eval.id, from: DOC });
  assert.equal(pm3.status, 200, '③ angle/gaps 全空时 promote 仍应 200，实际：' + pm3.status + ' ' + JSON.stringify(pm3.body).slice(0, 200));
  const ch3 = await get('/job/changes?id=' + pm3.body.id);
  assert.deepEqual(ch3.body.job.brief.focus, [], '③ focus 应为空数组，实际：' + JSON.stringify(ch3.body.job.brief));
  fs.rmSync(path.join(root, 'llm-eval-empty'), { force: true });

  // ===== 附：gaps 超 20 条 → normBrief 自动截断（focus = angle + 前 20 条 gaps）=====
  fs.writeFileSync(path.join(root, 'llm-eval-many'), '1');
  const ev3 = await post('/eval/create', { from: DOC, jd: '负责高并发交易系统后端研发', company: '评估丙公司', role: '算法工程师' });
  assert.ok(ev3.status === 200 && ev3.body.ok, '附 多 gaps /eval/create 应 200');
  assert.equal(ev3.body.eval.blocks.gaps.length, 22, '附 评估记录保留模型原始 22 条 gaps');
  const pm4 = await post('/eval/promote', { evalId: ev3.body.eval.id, from: DOC });
  assert.equal(pm4.status, 200, '附 多 gaps promote 应 200');
  const ch4 = await get('/job/changes?id=' + pm4.body.id);
  // normBrief 的 20 条上限作用在 focus 全数组（既有合同 strArr slice(0,20)）：angle 占 1 条 → gaps 留 19
  assert.equal(ch4.body.job.brief.focus.length, 20, '附 focus 应经 normBrief 截为 20 条上限，实际：' + ch4.body.job.brief.focus.length);
  assert.equal(ch4.body.job.brief.focus[0], '突出高并发交易系统经验', '附 angle 仍在首位');
  assert.equal(ch4.body.job.brief.focus[1], '缺口01', '附 gaps 按序保留');
  assert.equal(ch4.body.job.brief.focus[19], '缺口19', '附 截断边界正确（缺口20/21 不得进入）');
  fs.rmSync(path.join(root, 'llm-eval-many'), { force: true });

  console.log('✅ F2 评估报告预填定制要求：promote 落 brief.focus=[angle,...gaps]（①）/ 空报告 focus=[] 且 200（③）/ 重复 promote 409 幂等（④）/ normBrief 20 条上限截断（focus 全数组 ≤20）');
} catch (e) {
  cleanup();
  fail(e && e.message || String(e));
}
cleanup();
