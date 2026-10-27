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

  console.log('PASS AUD-05/AUD-07: 未知脚本渲染零外联 + 渲染失败保持旧成对产物');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { sink.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
