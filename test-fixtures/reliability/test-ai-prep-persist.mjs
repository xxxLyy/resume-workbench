// test-ai-prep-persist.mjs — F3 AI 面试准备建议持久化（随投递可回看）
// 验收口径（卡片原文，逐条进断言）：
//   ① POST /ai/prep 两次 → GET /app 断言两次文本与时间可见、applications.json 中 preps 长 2 且最新在前；
//   ② 累计生成 21 次后 preps 长度截为 20；
//   ③ stub LLM 关闭（409）后 preps 不变；
//   ④ 非法 id 400。
// 持久化契约：成功生成后 {text, at} 追加进该投递记录 app.preps（最新在前，上限 20，saveApps 落
// applications.json，无新文件）；409（未配置 LLM）/502（模型失败）不写任何记录。GET /app 服务端
// 渲染：#prepOut 初始显示最近一次 text 与生成时间，更早版本收进「历史生成」details 逐条带时间。
// HTTP 类夹具：隔离 RESUME_ROOT + 随机端口 + assembleTemplate 合成母版 + 本地 OpenAI 兼容 stub LLM
// （test.sh 假 LLM 模式）；applications.json 写一条合成投递（id 过 /^[0-9-]+$/）。真实数据禁写禁删。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-prep-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{WORK}}', () => '<p data-zid="z11111111">工作经历：负责交易系统</p>');
doc = doc.replace('{{PROJECTS}}', () => '');
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [DOC]: { rev: 1, flow: 'draft', kind: 'master' } }, null, 2));

// 合成投递（id 形如卡片指定，过 /^[0-9-]+$/ 闸门）
const AID = '2026-01-01-000000-000';
const APPS_FIXTURE = [{
  id: AID, company: '合成公司', role: '合成岗位', docId: DOC, jd: '负责高并发交易系统后端研发',
  note: '', channel: '', link: '', appliedAt: '2026-01-01 09:00', nextStep: '', dueDate: '',
  status: '已投递', createdAt: AID, updatedAt: AID, interviews: []
}];
fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify(APPS_FIXTURE));

// config：先不写（启动即无 LLM → /ai/prep 409 场景可先行）；需要时写/删这个文件切换
const cfgPath = path.join(root, 'config.json');
const llmOn = () => fs.writeFileSync(cfgPath, JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stubPort}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model-x' }]
}));
const llmOff = () => fs.writeFileSync(cfgPath, JSON.stringify({ active: 0, profiles: [] }));

// —— stub LLM：面试建议回复按调用计数区分（两次生成文本可辨）——
let stubHit = 0;
const stub = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    stubHit++;
    const content = 'PREP-STUB-第' + stubHit + '次建议：复盘系统设计与量化指标。';
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;
llmOn();

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
  let parsed = null; try { parsed = await r.json(); } catch {}
  return { status: r.status, body: parsed };
};
const getHtml = async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text() }; };
const diskApps = () => JSON.parse(fs.readFileSync(path.join(root, 'applications.json'), 'utf8'));

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务提前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ③（先行）：未配置 LLM 409 且不写记录 =====
  llmOff();
  const r409 = await post('/ai/prep', { id: AID });
  assert.equal(r409.status, 409, '③ 未配置 LLM 应 409，实际：' + r409.status);
  assert.deepEqual(diskApps()[0].preps, undefined, '③ 409 不得写任何 preps 记录');
  const page0 = await getHtml('/app?id=' + AID);
  assert.equal(page0.status, 200, '③ 无 preps 时 /app 应 200');
  assert.ok(page0.html.includes('id="prepBtn"'), '③ 无 preps 时维持现状（生成按钮在）');
  assert.ok(!page0.html.includes('历史生成'), '③ 无 preps 时不得渲染「历史生成」');
  llmOn();

  // ===== ① 两次生成：GET /app 可见两次文本与时间；落盘 preps 长 2 且最新在前 =====
  const p1 = await post('/ai/prep', { id: AID });
  assert.equal(p1.status, 200, '① 第一次生成应 200：' + JSON.stringify(p1.body).slice(0, 120));
  assert.equal(p1.body.ok, true, '① 响应体 ok:true（前端就地显示合同不变）');
  assert.equal(p1.body.text, 'PREP-STUB-第1次建议：复盘系统设计与量化指标。', '① 返回本次 text');
  const p2 = await post('/ai/prep', { id: AID });
  assert.equal(p2.status, 200, '① 第二次生成应 200');
  assert.ok(p2.body && p2.body.ok, '① 第二次响应体 ok:true');

  const onDisk = diskApps()[0];
  assert.ok(Array.isArray(onDisk.preps) && onDisk.preps.length === 2, '① applications.json 中 preps 长 2，实际：' + JSON.stringify(onDisk.preps || null).slice(0, 160));
  assert.equal(onDisk.preps[0].text, 'PREP-STUB-第2次建议：复盘系统设计与量化指标。', '① preps 最新在前（第二次在前）');
  assert.equal(onDisk.preps[1].text, 'PREP-STUB-第1次建议：复盘系统设计与量化指标。', '① 旧记录在后');
  assert.ok(typeof onDisk.preps[0].at === 'string' && onDisk.preps[0].at.length > 0, '① 每条带生成时间 at');

  const page1 = await getHtml('/app?id=' + AID);
  assert.equal(page1.status, 200, '① GET /app 应 200');
  assert.ok(page1.html.includes('PREP-STUB-第2次建议：复盘系统设计与量化指标。'), '① /app 应显示最近一次文本');
  assert.ok(page1.html.includes('PREP-STUB-第1次建议：复盘系统设计与量化指标。'), '① /app 应含更早版本文本（历史生成）');
  assert.ok(page1.html.includes('历史生成'), '① 更早版本应收进「历史生成」details');
  assert.ok(page1.html.includes('生成于'), '① 最近一次应带生成时间标注');
  assert.ok(page1.html.includes(onDisk.preps[0].at), '① /app 应显示最新一次的生成时间');
  // XSS：模型输出不可信 → 历史里的注入探针必须被转义（见下 21 次场景前的探针条目断言）

  // ===== ② 累计 21 次 → preps 截为 20（先注入一条带 <script> 的探针记录验证历史转义）=====
  const probe = { text: '探针<script>alert(1)</script>', at: '2026-01-02 00:00' };
  const cur = diskApps();
  cur[0].preps = [probe, ...cur[0].preps];
  fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify(cur));
  for (let i = 0; i < 19; i++) {
    const r = await post('/ai/prep', { id: AID });
    assert.equal(r.status, 200, '② 第 ' + (i + 3) + ' 次生成应 200');
  }
  const after = diskApps()[0];
  assert.equal(after.preps.length, 20, '② 21 次生成后 preps 应截为 20，实际：' + (after.preps || []).length);
  assert.equal(after.preps[0].text, 'PREP-STUB-第21次建议：复盘系统设计与量化指标。', '② 最新在前保持');
  assert.ok(!after.preps.some((p) => p.text === 'PREP-STUB-第1次建议：复盘系统设计与量化指标。'), '② 最旧一条应被截掉（第 1 次不在 20 条内）');
  const page2 = await getHtml('/app?id=' + AID);
  assert.ok(!page2.html.includes('<script>alert(1)</script>'), '② 历史生成里的注入探针必须转义，不得出现裸 <script>');
  assert.ok(page2.html.includes('&lt;script&gt;'), '② 探针应以实体出现（过 escHtml）');
  assert.ok(page2.html.includes('历史生成（19）'), '② details 应标历史条数（20-1=19）');

  // ===== ③（补）LLM 再关闭 → 409 且 preps 不变 =====
  llmOff();
  const before = diskApps()[0].preps;
  const r409b = await post('/ai/prep', { id: AID });
  assert.equal(r409b.status, 409, '③ 再次关闭 LLM 应 409');
  assert.deepEqual(diskApps()[0].preps, before, '③ 409 后 preps 不得变化');
  llmOn();

  // ===== ④ 非法 id 400 =====
  const rbad = await post('/ai/prep', { id: 'bad_id!' });
  assert.equal(rbad.status, 400, '④ 非法 id 应 400，实际：' + rbad.status);
  const rmiss = await post('/ai/prep', {});
  assert.equal(rmiss.status, 400, '④ 缺 id 应 400');

  console.log('✅ F3 面试准备建议持久化：两次生成落盘且 /app 双版本可见（①）/ 21 次截 20 且历史转义（②）/ 409 零写（③）/ 非法 id 400（④）');
} catch (e) {
  cleanup();
  fail(e && e.message || String(e));
}
cleanup();
