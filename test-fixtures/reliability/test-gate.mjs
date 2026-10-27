// test-fixtures/reliability/test-gate.mjs — /ai/* 与渲染的共享容量闸门（行为验收）
// 覆盖：SEC-2 的行为合同 —— 全进程 AI 实际并发 ≤2、渲染实际并发 ≤2、超限返回 429。
// 说明：本文件替代原先对 server.mjs 的源码关键词检查 —— 源码形状不是行为，
// 并发峰值与 429 只能靠真实并发请求证明。
// 约束：隔离 RESUME_ROOT + 本机假 LLM + 本机假渲染器；不读真实简历、不调真实模型。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-gate-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 母版用真实模板装配（freezeHtml 需要合法模板形状，否则渲染会在冻结阶段就失败）
{
  const { assembleTemplate } = await import('../../template.mjs');
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'doc1']]) {
    doc = doc.replaceAll(k, () => v);
  }
  fs.writeFileSync(path.join(root, 'docs', 'doc1.html'), doc);
}
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ doc1: { rev: 1, flow: 'draft' } }));

// 假 LLM：延迟返回并记录同时在跑的请求数（峰值 = 真实并发）
let llmActive = 0, llmPeak = 0, llmCalls = 0;
const llm = http.createServer(async (req, res) => {
  llmCalls++;
  llmActive++;
  if (llmActive > llmPeak) llmPeak = llmActive;
  await new Promise((r) => setTimeout(r, 1200));
  llmActive--;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: '合成回复' } }] }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }]
}));

// 假渲染器：慢返回（用于占住渲染槽）
const fakeRender = path.join(root, 'fake-render.cjs');
fs.writeFileSync(fakeRender, [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "setTimeout(() => {",
  "  const a = process.argv.slice(2); const i = a.indexOf('--out');",
  "  fs.writeFileSync(a[i + 1], Buffer.alloc(3000, 0x25));",
  "  // renderInputId 必须与本次冻结输入一致，否则成对发布校验不通过（那属于另一条用例）",
  "  fs.writeFileSync(a[i + 1] + '.env.json', JSON.stringify({ renderInputId: process.env.RESUME_RENDER_INPUT_ID || null, at: new Date().toISOString() }));",
  "  process.exit(0);",
  "}, 1200);"
].join('\n'));
fs.chmodSync(fakeRender, 0o755);   // spawn 直接执行该路径 → 必须可执行

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port), RESUME_RENDER_BIN: fakeRender },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const base = `http://127.0.0.1:${port}`;

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const post = (p, body) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });

  // ===== AI 闸门：5 并发 → 恰好 2 个进入模型，其余 429；模型侧峰值 ≤2 =====
  {
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => post('/ai/chat?id=doc1', { message: '合成问题' })));
    for (const r of rs) await r.text();
    const busy = rs.filter((r) => r.status === 429).length;
    if (busy < 1) fail('5 并发 AI 请求应有超限被拒（429），实际 429 数=' + busy + ' 状态=' + rs.map((r) => r.status).join(','));
    if (busy > 3) fail('AI 闸门放行过多：429 数=' + busy + '（应只放行 2 个）');
    if (llmPeak > 2) fail('模型侧实际并发峰值 ' + llmPeak + ' 超过 2');
    if (llmCalls > 2) fail('进入模型的请求数 ' + llmCalls + ' 超过 2');
  }
  // 等在途请求结束，避免与下一段叠加
  await new Promise((r) => setTimeout(r, 1500));

  // ===== 渲染闸门：4 并发 → 最多 2 个进入渲染，其余 429 =====
  {
    const before = llmCalls;
    const rs = await Promise.all([0, 1, 2, 3].map(() => post('/render?id=doc1')));
    for (const r of rs) await r.text();
    const busy = rs.filter((r) => r.status === 429).length;
    if (busy < 1) fail('4 并发渲染请求应有超限被拒（429），实际 429 数=' + busy + ' 状态=' + rs.map((r) => r.status).join(',') + ' 服务日志：' + serverLog.slice(-1200));
    const entered = rs.filter((r) => r.status !== 429).length;
    if (entered !== 2) fail('渲染闸门应只放行 2 个，实际放行 ' + entered);
    if (busy > 2) fail('渲染闸门放行过多：429 数=' + busy + '（应只放行 2 个）');
    if (llmCalls !== before) fail('渲染闸门段不应触发模型调用');
  }

  console.log('PASS SEC-2: AI 与渲染各自实际并发 ≤2，超限返回 429（行为验收）');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
