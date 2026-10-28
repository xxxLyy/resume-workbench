// test-fixtures/reliability/test-render-boundary.mjs — 渲染信任边界与成对产物发布的行为回归
// 覆盖：AUD-05（未知脚本不得在渲染时执行/外联）、AUD-07（渲染失败不得留下新 PDF 配旧旁车）。
// 约束：隔离 RESUME_ROOT + 合成文档 + 本机接收器 + 本机假渲染器；不读真实简历、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-rb-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 复制 Chromium 探测缓存（只复制缓存元数据，不复制任何真实数据），避免每次渲染重新探测
const cacheSrc = path.join(APP_ROOT, '.chromium-choice.json');
if (fs.existsSync(cacheSrc)) fs.copyFileSync(cacheSrc, path.join(root, '.chromium-choice.json'));

// 本机接收器：任何到达的请求都计数（脚本外联 / 事件属性 / iframe 都会命中）
let hits = [];
const sink = http.createServer((req, res) => {
  hits.push(req.url);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});
await new Promise((r) => sink.listen(0, '127.0.0.1', r));
const sinkPort = sink.address().port;

// 合成母版：合法模板 + 未知 inline 脚本 + 事件属性 + iframe（全部指向本地接收器）
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'doc1']]) {
  doc = doc.replaceAll(k, () => v);
}
const evil = `<script>fetch("http://127.0.0.1:${sinkPort}/inline-script").catch(function(){});</script>`
  + `<img src="x" onerror="fetch('http://127.0.0.1:${sinkPort}/event-attr').catch(function(){})">`
  + `<iframe src="http://127.0.0.1:${sinkPort}/iframe"></iframe>`;
doc = doc.replace('</body>', evil + '</body>');
fs.writeFileSync(path.join(root, 'docs', 'doc1.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ doc1: { rev: 1, flow: 'draft' } }));

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
const base = `http://127.0.0.1:${port}`;

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // 临时渲染输入（resume-render-src-*）在渲染前后数量必须一致：
  // 反例（旧实现）：renderSrc 在 try 内声明，finally 里访问不到 → ReferenceError 被空 catch 吞掉
  //   → 每次成功渲染都泄漏一个临时文件，且无人知晓。
  const tmpPrefix = 'resume-render-src-';
  const countTmp = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(tmpPrefix)).length;
  const tmpBefore = countTmp();

  // ===== AUD-05：真实渲染时未知脚本不得执行/外联 =====
  {
    const r = await fetch(base + '/render?id=doc1', { method: 'POST' });
    const text = await r.text();
    if (!r.ok) fail('渲染应成功，实际 ' + r.status + ' ' + text.slice(0, 300) + '\n' + serverLog.slice(-1200));
    await new Promise((r) => setTimeout(r, 800));   // 给可能的异步外联留出到达时间
    assert.deepEqual(hits, [], '未知脚本/事件属性/iframe 在渲染时不得发出任何请求，实际收到：' + JSON.stringify(hits));
    const pdf = path.join(root, 'pdfs', 'doc1.pdf');
    if (!fs.existsSync(pdf)) fail('渲染成功后 PDF 应存在');
    if (fs.statSync(pdf).size < 1000) fail('PDF 异常小，疑似空壳');
    // 如实记录：meta 应留下净化痕迹
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    if (!meta.doc1 || meta.doc1.lastRenderSanitized !== true) fail('净化发生时应如实记录 lastRenderSanitized');
    assert.equal(countTmp(), tmpBefore, '成功渲染后不得留下临时渲染输入文件（finally 访问失败被空 catch 吞掉 → 泄漏）');
  }

  // ===== 渲染临时输入的所有权：失败路径不得删掉【调用方】的输入文件，且不留临时文件 =====
  // 反例（旧实现）：renderDoc 的 finally 无条件 rmSync(renderSrc)；
  //   净化失败时 renderSrc 仍指向调用方的源文件 → /snapshot/pdf 的快照文件会被删掉（用户数据丢失）。
  {
    const snapDirP = path.join(root, 'snapshots', 'doc1');
    fs.mkdirSync(snapDirP, { recursive: true });
    const ts = '2026-10-28-120000';
    const snapFile = path.join(snapDirP, ts + '.html');
    // 超过 4MB 上限 → 净化必然抛错（渲染输入超限）
    fs.writeFileSync(snapFile, '<!doctype html><html><body>' + 'x'.repeat(4 * 1024 * 1024 + 1024) + '</body></html>');
    const before = countTmp();
    const r = await fetch(base + '/snapshot/pdf?id=doc1&ts=' + ts);
    await r.text();
    assert.ok(!r.ok || r.status !== 200, '超限渲染应失败，实际 ' + r.status);
    assert.ok(fs.existsSync(snapFile), '渲染输入超限后不得删除调用方的快照文件（数据丢失）');
    await new Promise((x) => setTimeout(x, 300));
    assert.equal(countTmp(), before, '渲染失败后不得留下临时渲染输入文件');
    fs.rmSync(snapFile, { force: true });
    console.log('  ✅ 渲染临时输入：失败路径只清理自己拥有的文件');
  }

  // ===== AUD-07：旁车写失败 → 旧 PDF 与旧旁车都保留，不得出现混合产物 =====
  {
    const pdf = path.join(root, 'pdfs', 'doc1.pdf');
    const side = pdf + '.env.json';
    const oldPdf = fs.readFileSync(pdf);
    const oldSide = fs.readFileSync(side);
    // 假渲染器：只写 PDF，不写旁车（模拟旁车写失败）
    const fake = path.join(root, 'fake-render.cjs');
    fs.writeFileSync(fake, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const a = process.argv.slice(2); const i = a.indexOf('--out');",
      "fs.writeFileSync(a[i + 1], Buffer.alloc(3000, 0x25));",   // 只写 PDF，不写旁车
      "fs.writeFileSync(a[i + 1] + '.ran', 'x');",              // 标记：确实跑到了渲染阶段
      "process.exit(0);"
    ].join('\n'));
    fs.chmodSync(fake, 0o755);   // spawn 直接执行 → 必须有 shebang 且可执行
    // 重启服务并注入假渲染器
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    const server2 = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
      cwd: APP_ROOT,
      env: { ...process.env, RESUME_ROOT: root, PORT: String(port), RESUME_RENDER_BIN: fake },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server2.stdout.on('data', (d) => { serverLog += d; });
    server2.stderr.on('data', (d) => { serverLog += d; });
    try {
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      // 清掉 lastRenderInputId → 强制重新渲染
      const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
      delete meta.doc1.lastRenderInputId;
      fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify(meta, null, 2));
      const r = await fetch(base + '/render?id=doc1', { method: 'POST' });
      await r.text();
      await new Promise((r2) => setTimeout(r2, 500));
      // 假渲染器确实跑过（写出了标记）——否则本段是假绿
      const ran = fs.readdirSync(path.join(root, 'pdfs')).filter((f) => f.includes('.ran'));
      if (!ran.length) fail('假渲染器未被执行（无 .ran 标记）——本用例会变成假绿');
      const newPdf = fs.existsSync(pdf) ? fs.readFileSync(pdf) : null;
      const newSide = fs.existsSync(side) ? fs.readFileSync(side) : null;
      assert.ok(newPdf, '渲染失败后旧 PDF 应仍在');
      assert.ok(newSide, '渲染失败后旧旁车应仍在');
      assert.ok(newPdf.equals(oldPdf), '渲染失败后 PDF 不得被替换（不得出现新 PDF 配旧旁车）');
      assert.ok(newSide.equals(oldSide), '渲染失败后旁车不得被替换');
      assert.ok(newPdf.equals(oldPdf) && newSide.equals(oldSide), '必须保持「旧 PDF + 旧旁车」这一对完整产物');
    } finally {
      server2.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      try { server2.kill('SIGKILL'); } catch {}
    }
  }

  // ===== 子进程超时终止：忽略 SIGTERM 的渲染器必须被 KILL 收场（否则槽位永不释放）=====
  {
    const pdf = path.join(root, 'pdfs', 'doc1.pdf');
    const side = pdf + '.env.json';
    const oldPdf = fs.readFileSync(pdf);
    const oldSide = fs.readFileSync(side);
    // 假渲染器：无视 SIGTERM（只能靠 KILL 收场），且永不产出
    const stubborn = path.join(root, 'stubborn-render.cjs');
    fs.writeFileSync(stubborn, [
      "#!/usr/bin/env node",
      "process.on('SIGTERM', function () {});   // 无视 TERM：只能靠 KILL 收场",
      "setInterval(function () {}, 1000);"
    ].join('\n'));
    fs.chmodSync(stubborn, 0o755);
    const server3 = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
      cwd: APP_ROOT,
      env: { ...process.env, RESUME_ROOT: root, PORT: String(port), RESUME_RENDER_BIN: stubborn, RESUME_TEST_RENDER_TIMEOUT_MS: '1200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server3.stdout.on('data', (d) => { serverLog += d; });
    server3.stderr.on('data', (d) => { serverLog += d; });
    try {
      for (let i = 0; i < 100; i++) {
        try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      const t0 = Date.now();
      const r = await fetch(base + '/render?id=doc1', { method: 'POST' });
      await r.text();
      const spent = Date.now() - t0;
      assert.ok(!r.ok, '超时的渲染应失败，实际 ' + r.status);
      assert.ok(spent < 30000, '渲染超时未收敛（请求挂住）：' + spent + 'ms');
      assert.ok(fs.readFileSync(pdf).equals(oldPdf), '渲染超时后旧 PDF 被替换');
      assert.ok(fs.readFileSync(side).equals(oldSide), '渲染超时后旧旁车被替换');
      // 服务仍可用（渲染槽已归还：请求能收敛就说明 finally 已释放）
      const alive = await fetch(base + '/');
      assert.ok(alive.ok, '渲染超时后服务不可用');
      await alive.text();
    } finally {
      server3.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 400));
      try { server3.kill('SIGKILL'); } catch {}
    }
    console.log('  ✅ 子进程超时：忽略 SIGTERM 的渲染器被 KILL 收场，旧成对产物保留');
  }

  console.log('PASS AUD-05/AUD-07: 未知脚本渲染零外联 + 渲染失败保持旧成对产物 + 临时输入所有权 + 子进程超时终止');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { sink.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
