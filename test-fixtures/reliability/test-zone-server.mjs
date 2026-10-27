// test-fixtures/reliability/test-zone-server.mjs — ZONE-03/04 服务端行为回归
// 覆盖：生成基线（doc.mtime）、区域请求的版本基线、zone-v1 形状、安全子集事务、零目标不写、通道互斥、归属写入同锁。
// 约束：隔离 RESUME_ROOT + 合成文档 + 本机假 LLM；不读真实简历、不调真实模型。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-zs-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const DOC = 'doc1';
const ZID = 'z11111111';
const DOC_HTML = `<!doctype html><html><head><title>t</title></head><body><p data-zid="${ZID}">原始正文内容</p></body></html>`;
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), DOC_HTML);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: { rev: 1, flow: 'draft', zones: { [ZID]: { zone: 'work', status: 'confirmed' } } }
}, null, 2));

// 本机假 LLM：返回固定 JSON（zone-rewrite 的形状）
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ rewrites: [{ zid: ZID, candidate: '改写后的正文内容', level: 'normal' }] }) } }]
  }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }]
}));

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
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const docMtime = () => fs.statSync(path.join(root, 'docs', DOC + '.html')).mtimeMs;

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // ===== ZONE-03：/job/changes 暴露 doc.mtime =====
  let mtime = null;
  {
    const r = await fetch(base + '/job/changes?id=' + DOC);
    const d = await r.json();
    if (!d.ok) fail('/job/changes 未返回 ok');
    if (typeof d.doc.mtime !== 'number' || d.doc.mtime <= 0) fail('/job/changes 的 doc.mtime 缺失（区域请求无版本基线）');
    mtime = d.doc.mtime;
  }

  // ===== ZONE-03：区域请求必须带 baseMtime =====
  {
    const r = await post('/ai/zone-analyze?id=' + DOC, { zone: 'work' });
    if (r.status !== 400) fail('缺 baseMtime 的区域请求应 400，实际 ' + r.status);
    if (!r.json || r.json.code !== 'INVALID_REQUEST') fail('缺 baseMtime 应返回 INVALID_REQUEST，实际 ' + r.text.slice(0, 200));
  }
  {
    const r = await post('/ai/zone-analyze?id=' + DOC, { zone: 'work', baseMtime: mtime + 100000 });
    if (r.status !== 409) fail('陈旧 baseMtime 的区域请求应 409，实际 ' + r.status);
    if (!r.json || r.json.code !== 'STALE_DOCUMENT') fail('陈旧 baseMtime 应返回 STALE_DOCUMENT，实际 ' + r.text.slice(0, 200));
  }

  // ===== ZONE-03：zone-rewrite 返回 zone-v1 形状（基线与操作身份由服务端生成）=====
  {
    const r = await post('/ai/zone-rewrite?id=' + DOC, { zone: 'work', instruction: '精简', baseMtime: mtime });
    if (r.status !== 200 || !r.json || !r.json.ok) fail('zone-rewrite 失败：' + r.status + ' ' + r.text.slice(0, 300));
    const rw = (r.json.rewrites || [])[0];
    if (!rw) fail('zone-rewrite 未返回候选');
    if (rw.baselineVersion !== 'zone-v1') fail('候选缺 baselineVersion=zone-v1');
    if (typeof rw.operationId !== 'string' || !rw.operationId) fail('候选缺 operationId（模型不得自报身份）');
    if (rw.before !== '原始正文内容') fail('候选的 before 必须取实际发送的单位文本，实际 ' + JSON.stringify(rw.before));
    if (rw.zone !== 'work') fail('候选缺 zone');
    if (typeof rw.beforeHash !== 'string' || !rw.beforeHash) fail('候选缺 beforeHash');
    if (r.json.baseMtime !== mtime) fail('响应应带回 baseMtime');
  }

  // ===== ZONE-04：zoneOps 与 ops 互斥 / baseMtime 必填 =====
  {
    const r = await post('/save?id=' + DOC, { requestId: 'z1', baseRev: 1, baseMtime: mtime, html: DOC_HTML, ops: [{ id: 'x' }], zoneOps: [{ operationId: 'o1', zid: ZID, zone: 'work', baselineVersion: 'zone-v1', before: 'x', beforeHash: 'y', candidate: 'z' }] });
    if (r.status !== 400) fail('zoneOps 与 ops 混用应 400，实际 ' + r.status);
  }
  {
    const r = await post('/save?id=' + DOC, { requestId: 'z2', baseRev: 1, html: DOC_HTML, ops: [], zoneOps: [{ operationId: 'o1', zid: ZID, zone: 'work', baselineVersion: 'zone-v1', before: 'x', beforeHash: 'y', candidate: 'z' }] });
    if (r.status !== 400) fail('区域保存缺 baseMtime 应 400，实际 ' + r.status);
  }

  // ===== ZONE-04：安全子集事务（正确 before → 应用成功并落盘）=====
  {
    const r = await post('/save?id=' + DOC, {
      requestId: 'z3', baseRev: 1, baseMtime: mtime, html: DOC_HTML, ops: [],
      zoneOps: [{ operationId: 'o1', zid: ZID, zone: 'work', baselineVersion: 'zone-v1', before: '原始正文内容', beforeHash: (await import('../../extract.mjs')).contentHash('原始正文内容'), candidate: '改写后的正文内容' }]
    });
    if (r.status !== 200 || !r.json || !r.json.ok) fail('合法 zoneOps 应保存成功：' + r.status + ' ' + r.text.slice(0, 300));
    if (!r.json.receipt || !Array.isArray(r.json.receipt.applied) || r.json.receipt.applied.length !== 1) fail('回执缺 applied');
    const html = fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8');
    if (!html.includes('改写后的正文内容')) fail('正文未落盘改写结果');
    if (html.includes('原始正文内容')) fail('正文仍保留原文');
    // 母版不因区域保存出现 job
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    if (meta[DOC].job) fail('母版不得因区域保存出现 job');
    if (!Array.isArray(meta[DOC].zoneSaveReceipts) || meta[DOC].zoneSaveReceipts.length !== 1) fail('zoneSaveReceipts 未记录');
  }

  // ===== ZONE-04：零安全目标 → 409 且正文/版本零变化 =====
  {
    const before = fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8');
    const beforeMeta = fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8');
    const m2 = fs.statSync(path.join(root, 'docs', DOC + '.html')).mtimeMs;
    const r = await post('/save?id=' + DOC, {
      requestId: 'z4', baseRev: 2, baseMtime: m2, html: before, ops: [],
      zoneOps: [{ operationId: 'o2', zid: ZID, zone: 'work', baselineVersion: 'zone-v1', before: '完全不匹配的原文', beforeHash: (await import('../../extract.mjs')).contentHash('完全不匹配的原文'), candidate: 'x' }]
    });
    if (r.status !== 409) fail('零安全目标应 409，实际 ' + r.status);
    if (!r.json || r.json.code !== 'NO_APPLICABLE_CANDIDATES') fail('零安全目标应返回 NO_APPLICABLE_CANDIDATES，实际 ' + r.text.slice(0, 200));
    if (fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8') !== before) fail('零安全目标后正文被改了');
    if (fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8') !== beforeMeta) fail('零安全目标后 meta 被改了');
  }

  // ===== ZONE-04：陈旧 baseMtime → 409 且零落盘 =====
  {
    const before = fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8');
    const m3 = fs.statSync(path.join(root, 'docs', DOC + '.html')).mtimeMs;
    const r = await post('/save?id=' + DOC, {
      requestId: 'z5', baseRev: 2, baseMtime: m3 + 5000, html: before, ops: [],
      zoneOps: [{ operationId: 'o3', zid: ZID, zone: 'work', baselineVersion: 'zone-v1', before: '改写后的正文内容', beforeHash: (await import('../../extract.mjs')).contentHash('改写后的正文内容'), candidate: 'y' }]
    });
    if (r.status !== 409) fail('陈旧 baseMtime 的区域保存应 409，实际 ' + r.status);
    if (fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8') !== before) fail('陈旧 baseMtime 后正文被改了');
  }

  // ===== ZONE-04：归属写入（/zones、/zones/init）仍可用 =====
  {
    const r = await post('/zones?id=' + DOC, { zones: { [ZID]: { zone: 'project', status: 'confirmed' } } });
    if (r.status !== 200 || !r.json || !r.json.ok) fail('/zones 写入失败：' + r.status + ' ' + r.text.slice(0, 200));
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    if (!meta[DOC].zones[ZID] || meta[DOC].zones[ZID].zone !== 'project') fail('/zones 未写归属');
    // 幂等：已有 zones 时 /zones/init 不动（既有契约）
    const r2 = await post('/zones/init?id=' + DOC, { entries: [{ zid: 'z22222222', sectionTitle: '工作经历' }] });
    if (r2.status !== 200 || !r2.json || !r2.json.ok) fail('/zones/init 失败：' + r2.status + ' ' + r2.text.slice(0, 200));
    if (r2.json.zones && r2.json.zones['z22222222']) fail('已有 zones 时 /zones/init 应幂等不动');
    // 无 zones 的文档：/zones/init 建立归属
    fs.writeFileSync(path.join(root, 'docs', 'doc2.html'), '<!doctype html><html><body><p data-zid="z33333333">正文</p></body></html>');
    fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
      ...JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8')),
      doc2: { rev: 1, flow: 'draft' }
    }, null, 2));
    const r3 = await post('/zones/init?id=doc2', { entries: [{ zid: 'z33333333', sectionTitle: '工作经历' }] });
    if (r3.status !== 200 || !r3.json || !r3.json.ok) fail('/zones/init（新文档）失败：' + r3.status + ' ' + r3.text.slice(0, 200));
    if (!r3.json.zones || !r3.json.zones['z33333333']) fail('/zones/init 未建立归属：' + r3.text.slice(0, 200));
  }

  console.log('PASS ZONE-03/04: 生成基线 + 版本基线 + zone-v1 形状 + 安全子集事务 + 零目标不写 + 归属写入');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
