// test-edit-csp-frames.mjs — /edit 的 CSP 必须显式关死 frame-src/object-src（BL-P7-03，high）
// 背景：/edit 的 CSP 未约束 frame-src / object-src（回落 default-src 'self'）→ 文档正文（按代码
// 自身口径属外部输入）可内嵌任意同源页面 iframe，/settings 的明文 API Key 就在 iframe DOM 里，
// 同源脚本可直接读出。/edit 无任何合法 iframe/embed 需求（PDF 预览 iframe 在 /export 页）。
// 约束：隔离 RESUME_ROOT + 合成文档；不读真实简历、不起浏览器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-edcsp-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'd1.html'),
  '<!doctype html><html><body><script>var DOC_ID = \'d1\';</script><p>正文</p></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));

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
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b }));
  }).on('error', reject);
});

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { await get('/'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  const r = await get('/edit?id=d1');
  if (r.status !== 200) fail('预期 200，实际 ' + r.status);
  const csp = r.headers['content-security-policy'] || '';
  if (!csp) fail('/edit 无 CSP 头');
  // ① frame-src 显式关死（不允许回落到 default-src 'self' 放行同源 iframe）
  if (!csp.includes("frame-src 'none'")) fail('CSP 缺 frame-src \'none\'，实际：' + csp);
  // ② object-src 显式关死（<object>/<embed> 同理）
  if (!csp.includes("object-src 'none'")) fail('CSP 缺 object-src \'none\'，实际：' + csp);

  console.log('✅ /edit CSP：frame-src none + object-src none（同源 iframe 读设置页明文 Key 的通道关死）');
} finally {
  cleanup();
}
