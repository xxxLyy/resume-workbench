// test-app-pages-csp.mjs — 全站应用页默认 CSP（B 线收口新发现：除 /edit、/snapshot/view 外均无 CSP）
// 口径：在 send() 对 text/html 统一下发默认策略，显式传了 CSP 的路由（/edit nonce 策略、
// /snapshot/view 锁定策略）保持各自更严的口径。默认策略锁死除 script-src 外的全部通道：
//   default-src 'self'；connect/form-action 'self'（外传通道关死）；img-src 'self' data: blob:
//  （应用页零外链图，图片信标外传关死）；object-src 'none'；frame-ancestors 'none'（防嵌框）；
//   base-uri 'none'；frame-src 'self'（/export 的 PDF 预览 iframe 需要）。
// script-src（2026-11-07 批 5 收口后口径）：51 处内联事件属性已全部委托化为 data-action（b5c1），
// 28 个内联脚本块已全部 nonce 化（b5c2）→ 'unsafe-inline' 移除，script-src 收口 'self' 'nonce-…'
// （终检由 test-csp-script-src-closure.mjs / test-app-pages-script-nonce.mjs 承载；本夹具继续核对外传/嵌框等通道）。
// HTTP 类夹具：隔离根 + 合成文档。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-appcsp-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), '<!doctype html><html><body><script>var DOC_ID = \'d1\';</script><p>正文</p></body></html>');
fs.mkdirSync(path.join(root, 'snapshots', 'd1'), { recursive: true });
fs.writeFileSync(path.join(root, 'snapshots', 'd1', '2026-10-20-101010.html'), '<!doctype html><html><body><p>历史</p></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));

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

  // ① 应用页全部带默认 CSP，且关键指令到位
  const pages = ['/', '/settings', '/applications', '/materials', '/evals', '/stats', '/export?id=d1', '/snapshots?id=d1'];   // 404 路由回 text/plain，不在页面集
  const must = ["default-src 'self'", "connect-src 'self'", "form-action 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'", "frame-src 'self'"];
  for (const p of pages) {
    const r = await get(p);
    const ct = String(r.headers['content-type'] || '');
    if (!/text\/html/.test(ct)) fail(`${p} 不是 HTML 页（${ct}），夹具路由清单需修正`);
    const csp = r.headers['content-security-policy'] || '';
    if (!csp) fail(`${p}（HTTP ${r.status}）无 CSP 头`);
    for (const d of must) if (!csp.includes(d)) fail(`${p} CSP 缺「${d}」：${csp}`);
    // img-src 不得放行 https:（应用页零外链图；图片信标外传通道关死）
    const img = /img-src([^;]*)/.exec(csp);
    if (!img || /https:/.test(img[1])) fail(`${p} img-src 放行了 https:（外传通道）：${csp}`);
    // script-src 不得放行任何外部主机（只允许 'self' 与内联）
    const sc = /script-src([^;]*)/.exec(csp);
    if (!sc || /https?:|\*/.test(sc[1])) fail(`${p} script-src 放行了外部主机：${csp}`);
  }

  // ② 已有更严策略的路由不被默认覆盖
  const edit = (await get('/edit?id=d1')).headers['content-security-policy'] || '';
  if (!/'nonce-/.test(edit) || !edit.includes("frame-src 'none'")) fail('/edit 的 nonce 策略被默认策略覆盖了：' + edit);
  const snap = (await get('/snapshot/view?id=d1&ts=2026-10-20-101010')).headers['content-security-policy'] || '';
  if (!snap.includes("default-src 'none'")) fail('/snapshot/view 的锁定策略被默认策略覆盖了：' + snap);

  // ③ 非 HTML 响应不带 CSP（JSON 接口无需、也不应被影响）
  const j = await get('/job/changes?id=d1');
  if (j.headers['content-security-policy']) fail('JSON 接口不应带 CSP：' + j.headers['content-security-policy']);

  console.log('✅ 全站应用页默认 CSP：8 页均带策略、外传/嵌框/base/object 通道关死、img 不放 https；/edit 与快照页更严策略保留；JSON 接口不受影响');
} finally {
  cleanup();
}
