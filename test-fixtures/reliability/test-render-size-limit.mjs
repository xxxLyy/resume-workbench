// test-fixtures/reliability/test-render-size-limit.mjs — 渲染/保存尺寸口径一致（BL-P1-04）
// 缺陷：保存入口接受 ≤10MB 正文（readBody 默认上限），renderDoc 调 trustedRenderHtml 却取
// render-safe.mjs 的 4MB 默认 → 大文档能存能编辑却永远出不了 PDF，且前端只见
// 「渲染失败（详见服务日志）」，没有任何尺寸原因可诊断。
// 修法合同：renderDoc 传与保存同源的 maxHtmlBytes；超限错误带尺寸原因
// （客户端可见「文档 X MB 超过渲染上限 Y MB」）。
// 约束：隔离 RESUME_ROOT + 合成文档 + 本机假渲染器（不真渲大 PDF，只断言净化放行/超限两个
// 分支）；不读真实简历、不新增依赖、不碰 7766 服务。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); return !!ok; };

// 隔离根：合成数据只落 mkdtemp，真实数据目录零写删
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-rsl-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'backups', 'logs']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 假渲染器：写假 PDF + 旁车（renderInputId 取自透传 env，过成对身份校验）+ .ran 标记。
// .ran 标记是防假绿的关键：只有净化放行、真到达渲染子进程才会出现。
const fake = path.join(root, 'fake-render.cjs');
fs.writeFileSync(fake, [
  "#!/usr/bin/env node",
  "const fs = require('node:fs');",
  "const a = process.argv.slice(2); const i = a.indexOf('--out'); const out = a[i + 1];",
  "fs.writeFileSync(out, Buffer.alloc(3000, 0x25));",
  "fs.writeFileSync(out + '.ran', 'x');",
  "fs.writeFileSync(out + '.env.json', JSON.stringify({ renderInputId: process.env.RESUME_RENDER_INPUT_ID, at: new Date().toISOString() }));",
  "process.exit(0);"
].join('\n'));
fs.chmodSync(fake, 0o755);

// 合成文档（直接落隔离 docs/，等价「已保存成功」的大文档；保存口径 readBody 默认 10MB 不在本夹具改动范围）：
//   mid：5MB —— 高于旧渲染默认 4MB、低于保存上限 10MB（缺陷带：能存能编辑却渲不出）
//   oversize：11MB —— 高于统一后的 10MB（超限错误分支，净化层就该拦下，无需真渲染）
const MB = 1024 * 1024;
const synthDoc = (bytes) => '<!doctype html><html><head><meta charset="utf-8"><title>合成</title></head><body><p>' + 'x'.repeat(bytes) + '</p></body></html>';
fs.writeFileSync(path.join(root, 'docs', 'mid.html'), synthDoc(5 * MB));
fs.writeFileSync(path.join(root, 'docs', 'oversize.html'), synthDoc(11 * MB));
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ mid: { rev: 1, flow: 'draft' }, oversize: { rev: 1, flow: 'draft' } }));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port), RESUME_RENDER_BIN: fake },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const base = `http://127.0.0.1:${port}`;
const pdfsDir = path.join(root, 'pdfs');
const ranMarkers = (id) => fs.readdirSync(pdfsDir).filter((f) => f.startsWith(id + '.pdf.stage-') && f.endsWith('.ran'));

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { server.kill('SIGTERM'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);   // fail 走 process.exit 也不留孤儿服务/临时根

try {
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); ready = true; } } catch {}
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) { console.error('❌ 隔离服务未就绪\n' + serverLog.slice(-800)); process.exit(1); }

  // ===== 用例 1（口径统一）：>4MB 且 ≤10MB 的文档必须能走完渲染（假渲染器真跑过、/render 200）=====
  // 旧实现：净化取 4MB 默认上限硬拒 → /render 500「渲染失败（详见服务日志）」，渲染子进程根本不会启动。
  {
    const r = await fetch(base + '/render?id=mid', { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    const okResp = check(r.status === 200 && body.ok === true,
      `5MB 文档应能渲染（渲染上限与保存一致），实际 status=${r.status} body=${JSON.stringify(body).slice(0, 200)}`);
    check(ranMarkers('mid').length >= 1, '假渲染器未被执行（无 .ran 标记）→ 5MB 在净化层被拒，口径未统一');
    check(fs.existsSync(path.join(pdfsDir, 'mid.pdf')), '渲染成功后 PDF 应存在');
    console.log(okResp ? '  ✅ 5MB 文档通过净化并完成渲染（渲染上限与保存口径一致）' : '  ❌ 用例1（5MB 应能渲染）未过');
  }

  // ===== 用例 2（超限文案）：>10MB 文档渲染失败时必须带尺寸原因，而不是只有「详见服务日志」=====
  {
    const r = await fetch(base + '/render?id=oversize', { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    check(r.status === 500 && body.ok === false, `超限渲染应 500 失败，实际 status=${r.status}`);
    const sized = typeof body.error === 'string' && /^文档 11 MB 超过渲染上限 10 MB$/.test(body.error);
    check(sized, `超限错误文案应可诊断（「文档 11 MB 超过渲染上限 10 MB」），实际 error=${JSON.stringify(body.error)}`);
    check(ranMarkers('oversize').length === 0, '超限输入不得进入渲染子进程（净化层就该拦下）');
    check(!fs.existsSync(path.join(pdfsDir, 'oversize.pdf')), '超限渲染不得产出 PDF');
    console.log(sized ? '  ✅ 超限错误带尺寸原因（客户端可诊断）' : '  ❌ 用例2（超限文案含尺寸原因）未过');
  }

  if (failures.length) {
    console.error('❌ BL-P1-04 渲染尺寸口径：' + failures.length + ' 项未过');
    for (const f of failures) console.error('  - ' + f);
    console.error('--- 服务日志尾部 ---\n' + serverLog.slice(-1200));
    process.exit(1);
  }
  console.log('PASS BL-P1-04: 渲染上限与保存同源（10MB）+ 超限错误带尺寸原因（文档 11 MB 超过渲染上限 10 MB）');
} finally {
  cleanup();
}
