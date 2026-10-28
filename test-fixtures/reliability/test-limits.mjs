// test-fixtures/reliability/test-limits.mjs — AUD-17：重活前置有界（差异矩阵 / JD 远程读取 / 外部工具超时）
// 约束：隔离 RESUME_ROOT + 合成数据 + 本机桩；不读真实简历、不调真实模型、不外联。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { diffLines } from '../../diff.mjs';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// ===== ① 差异矩阵：分配前设规模界限（超大输入必须被拒，而不是吃光内存）=====
{
  const small = diffLines(['a', 'b'], ['a', 'c']);
  assert.deepEqual(small.map((x) => x.type), ['same', 'del', 'ins'], '正常规模差异结果不变');
  let threw = null;
  try { diffLines(new Array(3000).fill('x'), new Array(3000).fill('y')); } catch (e) { threw = e; }
  assert.ok(threw, '超大差异矩阵必须被拒（分配前有界）');
  assert.match(String(threw.message), /规模|上限/, '拒绝原因应说明规模界限：' + threw.message);
  console.log('  ✅ 差异矩阵分配前有界');
}

// ===== ② JD 远程读取：声明超大的响应立即被拒，不把内容收进内存 =====
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-lim-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), '<!doctype html><html><body><p>正文</p></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));

let bigHits = 0;
const web = http.createServer((req, res) => {
  if (req.url.startsWith('/big')) {
    bigHits++;
    // 声明超大长度但只发一点：服务端若先收全量就会挂住；先看长度应立即拒绝
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(50 * 1024 * 1024) });
    res.write('<html>' + 'x'.repeat(1000) + '</html>');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body><h1>合成 JD</h1><p>岗位要求</p></body></html>');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));

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

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // ② 超大声明 → 服务端立即拒绝（/ai/jd-text 走有界读取）
  {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/ai/jd-text`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${web.address().port}/big` })
    });
    const d = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    assert.ok(d.ok !== true, '超大的远程页面必须被拒（实际 ok=' + d.ok + '）');
    assert.match(String(d.error || ''), /上限|MB|超过/, '拒绝原因应说明上限：' + String(d.error));
    assert.ok(ms < 8000, '应立即拒绝而不是收完再判（耗时 ' + ms + 'ms）');
    console.log('  ✅ JD 远程读取：超大声明立即被拒（' + ms + 'ms）');
  }

  // ③ 正常页面仍可读（有界读取不能误伤正常输入）
  {
    const r = await fetch(`http://127.0.0.1:${port}/ai/jd-text`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${web.address().port}/ok` })
    });
    const d = await r.json().catch(() => ({}));
    assert.ok(d.ok, '正常页面应可读：' + JSON.stringify(d).slice(0, 200));
    assert.ok(String(d.text || '').includes('合成 JD'), '读到的正文不对：' + String(d.text).slice(0, 120));
    console.log('  ✅ JD 远程读取：正常页面不受影响');
  }

  console.log('PASS AUD-17: 差异矩阵有界 + JD 远程读取有界且不误伤正常输入');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { web.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
