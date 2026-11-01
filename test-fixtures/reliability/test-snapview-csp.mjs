// test-snapview-csp.mjs — /snapshot/view 快照预览必须带锁定 CSP（BL-P1-02≡BL-P7-01，high）
// 背景：该路由曾把冻结快照原样 text/html 同源返回且零 CSP → 快照正文里的内联脚本在应用
// origin 执行（可读 /settings 明文 Key、可 POST /save 覆写任意文档，三路独立发现）。
// 合同：预览是只读视图 → default-src 'none'（脚本/连接/框架全禁），仅放行样式（横幅观感）
// 与图片/字体（正文保真）。断言不依赖提示文字，只看响应头与正文。
// 约束：隔离 RESUME_ROOT + 合成快照；不读真实简历、不起浏览器。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-svcsp-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 合成母版（/snapshot/view 校验 VALID_ID，与 docs 目录配套）
fs.writeFileSync(path.join(root, 'docs', 's1.html'),
  '<!doctype html><html><body><script>var DOC_ID = \'s1\';</script><p>正文</p></body></html>');
// 合成快照：正文里埋一段脚本 + 一张图，验证 CSP 挡脚本、放样式/图片
fs.mkdirSync(path.join(root, 'snapshots', 's1'), { recursive: true });
fs.writeFileSync(path.join(root, 'snapshots', 's1', '2026-10-20-101010.html'),
  '<!doctype html><html><head><style>p{color:#333}</style></head><body>' +
  '<script>var DOC_ID = \'s1\'; window.X = 1;</script>' +
  '<p>历史版本正文</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><div style="font-size:12px">落款</div></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ s1: { rev: 1, flow: 'draft' } }));

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

  const r = await get('/snapshot/view?id=s1&ts=2026-10-20-101010');
  if (r.status !== 200) fail('预期 200，实际 ' + r.status);
  const csp = r.headers['content-security-policy'] || '';
  // ① 必须有 CSP 且 default-src 'none'（脚本/连接/框架全禁——预览不需要任何脚本）
  if (!csp.includes("default-src 'none'")) fail('CSP 缺 default-src \'none\'，实际：' + csp);
  // ② script-src 不得放行内联/自源脚本（显式或回落到 default 都行，但绝不能出现放行）
  if (/script-src[^;]*'self'/.test(csp) || /script-src[^;]*unsafe-inline/.test(csp)) fail('CSP 的 script-src 放行了脚本：' + csp);
  // ③ 样式放行（横幅/正文观感保真）
  if (!csp.includes("style-src 'unsafe-inline'")) fail('CSP 缺 style-src \'unsafe-inline\'（预览观感需要）：' + csp);
  // ④ 图片放行（简历正文的 data:/blob:/https: 图）
  if (!/img-src[^;]*(data:|blob:)/.test(csp)) fail('CSP 的 img-src 未放行 data:/blob:：' + csp);
  // ⑤ 横幅还在（页面仍是快照预览本体，不是被替换的错误页）
  if (!r.body.includes('历史快照只读预览')) fail('响应正文缺少只读预览横幅');
  if (!r.body.includes('历史版本正文')) fail('响应正文缺少快照内容');

  console.log('✅ /snapshot/view 预览 CSP：default-src none（脚本/连接/框架全禁）+ 样式/图片放行，横幅与正文完整');
} finally {
  cleanup();
}
