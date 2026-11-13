// test-inbox.mjs — JD 收件箱（2026-11-13 spec dev-docs/2026-11-13-jd-inbox-batch-eval-design.md）
// 断言（任务卡 T2）：
//   ① 带口令 k 的用户态 POST /import/page（Origin=招聘站）→ 「已收入收件箱 · 共 1 条」、不含「提取通道」；
//     inbox.json 1 条（status=new / urlKey 去 query / salary 非空 / jdFp 非空），文件 0600，响应无 ACAO；
//   ② 同 JD 换 query（?lid=2）→ urlKey 判重 → 「已在收件箱」不新增；同 JD 换 URL → jdFp 判重 → 不新增；
//   ③ 不带 k / k 错 → 旧预览（含「提取结果」+「重新拖一次」），inbox.json 不变；
//   ④ .migrate.lock 新鲜持锁 → 带 k POST → 「维护中，本次未收入」，inbox.json 不变。
// 手法：隔离 RESUME_ROOT + assembleTemplate 合成母版 + 随机端口真实 server + OpenAI 兼容桩
// （同 test-eval-promote-brief.mjs；口令从 GET /job/new 的书签 href 解析）。不碰 7766，不写真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const FIX = path.join(APP_ROOT, 'test-fixtures', 'jd-pages');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-inbox-'));
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

// —— stub LLM（OpenAI 兼容，同 test-eval-promote-brief.mjs）：评估请求回合法报告 ——
const EVAL_REPORT = JSON.stringify({
  roleSummary: '负责交易系统后端研发', company: '评估甲公司', roleName: '后端工程师',
  level: 'right', levelReason: '恰好匹配',
  salary: { text: '', source: 'JD 未提供' },
  angle: '突出高并发交易系统经验',
  matches: [{ req: '负责后端服务', status: 'covered', evidence: '负责交易系统', weight: 'must', weightFrom: 'JD 原文' }],
  score: 4.5, verdict: 'apply', verdictReason: '整体匹配', gaps: ['补充量化指标']
});
const stub = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    let content = '';
    try {
      const sys = JSON.parse(b).messages.find((m) => m.role === 'system').content;
      if (String(sys).includes('岗位快速评估器')) content = EVAL_REPORT;
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

const inboxFile = path.join(root, 'inbox.json');
const loadInboxFile = () => { try { return JSON.parse(fs.readFileSync(inboxFile, 'utf8')); } catch { return []; } };
// 用户态递交：urlencoded 表单 + 招聘站 Origin（书签跨站递交的真实形态）
const postImport = (fields) => fetch(base + '/import/page', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://www.zhipin.com' },
  body: new URLSearchParams(fields).toString(),
});

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务提前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== 口令：从 GET /job/new 的书签 href 解析 =====
  const jn = await (await fetch(base + '/job/new')).text();
  const k = (jn.match(/k\.value='([0-9a-f]{32})'/) || [])[1] || '';
  assert.match(k, /^[0-9a-f]{32}$/, '书签口令应为 32 位 hex，实际：' + k);

  const zh = fs.readFileSync(path.join(FIX, 'zhipin-job.html'), 'utf8');

  // ===== ① 带口令 POST → 收入收件箱 =====
  const r1 = await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/abc.html?lid=1', title: '甲岗位', k });
  const b1 = await r1.text();
  assert.equal(r1.status, 200, '① 带口令 POST 应 200，实际：' + r1.status);
  assert.ok(b1.includes('已收入收件箱'), '① 应显示「已收入收件箱」，实际片段：' + b1.slice(0, 300));
  assert.ok(b1.includes('共 1 条'), '① 应显示「共 1 条」');
  assert.ok(!b1.includes('提取通道'), '① 已收入页不得含内部术语「提取通道」');
  assert.equal(r1.headers.get('access-control-allow-origin'), null, '① 响应不得带 ACAO');
  const ib1 = loadInboxFile();
  assert.equal(ib1.length, 1, '① inbox.json 应 1 条，实际：' + ib1.length);
  assert.equal(ib1[0].status, 'new', '① 条目 status 应为 new');
  assert.equal(ib1[0].urlKey, 'https://www.zhipin.com/job_detail/abc.html', '① urlKey 应去 query，实际：' + ib1[0].urlKey);
  assert.ok(ib1[0].salary, '① salary 应非空');
  assert.ok(ib1[0].jdFp, '① jdFp 应非空');
  assert.equal(fs.statSync(inboxFile).mode & 0o777, 0o600, '① inbox.json 权限应 0600');

  // ===== ②a 同 JD 换 query → urlKey 判重 =====
  const r2 = await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/abc.html?lid=2', title: '甲岗位', k });
  const b2 = await r2.text();
  assert.ok(b2.includes('已在收件箱'), '②a 同 urlKey 应命中去重，实际片段：' + b2.slice(0, 300));
  assert.equal(loadInboxFile().length, 1, '②a 去重后仍应 1 条');

  // ===== ②b 同 JD 换 URL → jdFp 判重 =====
  const r3 = await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/xyz.html', title: '甲岗位', k });
  const b3 = await r3.text();
  assert.ok(b3.includes('已在收件箱'), '②b 同 jdFp 应命中去重，实际片段：' + b3.slice(0, 300));
  assert.equal(loadInboxFile().length, 1, '②b 去重后仍应 1 条');

  // ===== ③ 不带 k / k 错 → 旧预览，不写收件箱 =====
  for (const [label, fields] of [
    ['不带 k', { html: zh, url: 'https://www.zhipin.com/job_detail/nok.html', title: 'x' }],
    ['k 错', { html: zh, url: 'https://www.zhipin.com/job_detail/badk.html', title: 'x', k: '0'.repeat(32) }],
  ]) {
    const r = await postImport(fields);
    const b = await r.text();
    assert.equal(r.status, 200, '③ ' + label + ' 应 200，实际：' + r.status);
    assert.ok(b.includes('提取结果'), '③ ' + label + ' 应是旧预览页（含「提取结果」）');
    assert.ok(b.includes('重新拖一次'), '③ ' + label + ' 应提示「重新拖一次」');
    assert.equal(loadInboxFile().length, 1, '③ ' + label + ' 不得新增收件箱条目');
  }

  // ===== ④ 迁移锁被持有 → 带口令也不写 =====
  fs.writeFileSync(path.join(root, '.migrate.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }));
  const r4 = await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/locked.html', title: 'x', k });
  const b4 = await r4.text();
  assert.ok(b4.includes('维护中，本次未收入'), '④ 持锁时应显示「维护中，本次未收入」，实际片段：' + b4.slice(0, 300));
  assert.equal(loadInboxFile().length, 1, '④ 持锁期间不得新增收件箱条目');
  fs.rmSync(path.join(root, '.migrate.lock'), { force: true });

  console.log('✅ inbox T2：带口令收入（去 query urlKey/0600/无 ACAO）/ urlKey 与 jdFp 双路判重 / 无口令回退旧预览 / 迁移锁挡写');
} catch (e) {
  cleanup();
  fail(e && e.message || String(e));
}
cleanup();
process.exit(0);
