// test-preview-save-channel.mjs — 快照预览页的 ⌘S 保存通道必须被整体关死（BL-P7-02，high）
// 背景：/snapshot/view 曾原样返回带模板编辑器脚本的快照 → 预览页按 ⌘S/Ctrl+S 会把
// 「预览中的历史版本」POST /save 写回当前文档，且预览页无 __edDocMtime 会跳过 baseMtime
// 并发检测——当前简历被静默回退。修复口径：预览 CSP default-src 'none' → 编辑器脚本不执行
// （⌘S 监听器不存在）、connect-src 禁（即便有脚本也发不出请求）。
// 断言靠请求行为与脚本执行痕迹，不靠提示文字（纪律同 test-job-ops）。
// 约束：隔离 RESUME_ROOT + 合成快照（内嵌模拟保存脚本）；不读真实简历、不碰 7766。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-psv-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 's1.html'),
  '<!doctype html><html><body><script>var DOC_ID = \'s1\';</script><p>当前正文</p></body></html>');
// 合成快照：模拟模板编辑器脚本的行为形状——加载即标记、⌘S/Ctrl+S → POST /save。
// 真实模板的 doSave 也是同款（template.html 冻结件 ⌘S 绑定 + /save 提交）。
fs.mkdirSync(path.join(root, 'snapshots', 's1'), { recursive: true });
fs.writeFileSync(path.join(root, 'snapshots', 's1', '2026-10-20-101010.html'),
  '<!doctype html><html><head><style>p{color:#333}</style></head><body>' +
  '<script>var DOC_ID = \'s1\'; window.__probeRan = 1;' +
  'window.addEventListener(\'keydown\', function(e){ if ((e.metaKey||e.ctrlKey) && (e.key===\'s\')) {' +
  'fetch(\'/save\', {method:\'POST\', headers:{\'Content-Type\':\'text/html\'}, body:document.documentElement.outerHTML}); } });' +
  '</script><p>历史版本正文</p></body></html>');
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
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
  }).on('error', reject);
});

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { await get('/'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过快照预览保存通道回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });

  const page = await browser.newPage();
  const saveRequests = [];
  page.on('request', (req) => { if (new URL(req.url()).pathname === '/save') saveRequests.push(req.url()); });
  const resp = await page.goto(`http://127.0.0.1:${port}/snapshot/view?id=s1&ts=2026-10-20-101010`);
  assert.equal(resp.status(), 200, '预览页应 200');
  // 页面本体渲染正常（横幅 + 快照正文可见），不是被 CSP 误伤成白页
  await page.waitForSelector('text=历史版本正文');
  assert.ok(await page.isVisible('text=历史快照只读预览'), '只读预览横幅应可见');

  // ① 内联脚本必须没执行（__probeRan 未定义 + ⌘S/Ctrl+S 不产生任何 /save 请求）
  const probeRan = await page.evaluate(() => window.__probeRan);
  assert.notEqual(probeRan, 1, '快照里的内联脚本被执行了（CSP 未挡住脚本）');
  await page.keyboard.press('Meta+s');
  await page.keyboard.press('Control+s');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(saveRequests.length, 0, '预览页按 ⌘S/Ctrl+S 发出了 ' + saveRequests.length + ' 个 /save 请求（保存通道未关死）');

  // ② 磁盘侧双保险：当前文档正文未被改写
  const disk = fs.readFileSync(path.join(root, 'docs', 's1.html'), 'utf8');
  assert.ok(disk.includes('当前正文') && !disk.includes('历史版本正文'), '当前文档被历史版本覆盖了');

  await page.close();
  console.log('✅ 快照预览保存通道：内联脚本不执行（CSP script 挡）+ ⌘S/Ctrl+S 零 /save 请求（connect 挡）+ 磁盘正文未变');
} finally {
  try { if (browser) await browser.close(); } catch {}
  cleanup();
}
