// test-fixtures/reliability/test-job-create.mjs — 岗位创建的身份保留与去重行为回归
// 覆盖：AUD-14（同一岗位并发创建只成功一份；promote 跨 await 不丢记录；失败不孤儿）。
// 约束：隔离 RESUME_ROOT + 本机 JD 接收器 + 本机回环；不读真实简历、不调真实模型。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jc-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 本机 JD 接收器：延迟返回，让两个并发请求都进入等待窗口（去重必须在等待前生效）
let jdHits = 0;
const jdServer = http.createServer(async (req, res) => {
  jdHits++;
  await new Promise((r) => setTimeout(r, 1200));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<html><body><h1>Synthetic JD</h1><p>Backend Engineer</p></body></html>');
});
await new Promise((r) => jdServer.listen(0, '127.0.0.1', r));
const jdUrl = `http://127.0.0.1:${jdServer.address().port}/jd`;

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
const postJson = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // 母版：用真实 /new 路径造（与生产同形状）
  // /new 是 303 重定向到 /edit?id=… —— 不跟随重定向才能拿到新文档 id
  const made = await fetch(base + '/new', { method: 'POST', redirect: 'manual' });
  const loc = made.headers.get('location') || '';
  const masterId = (/id=([a-z0-9-]+)/.exec(loc) || [])[1] || '';
  if (!masterId) fail('新建母版未返回 id：' + loc + ' 状态 ' + made.status);

  // ===== AUD-14 ①：同一 (母版,公司,岗位) 的并发创建只能成功一份 =====
  {
    const [a, b] = await Promise.all([
      postJson('/job/create', { from: masterId, company: 'Acme', role: 'Backend', jdLink: jdUrl }),
      postJson('/job/create', { from: masterId, company: 'Acme', role: 'Backend', jdLink: jdUrl })
    ]);
    const okCount = [a, b].filter((r) => r.status === 200 && r.json && r.json.ok).length;
    if (okCount !== 1) fail('并发创建应恰好一份成功，实际 ' + okCount + '（状态 ' + a.status + '/' + b.status + '）');
    const loser = a.status === 200 ? b : a;
    if (loser.status !== 409) fail('落败请求应返回 409，实际 ' + loser.status + ' ' + loser.text.slice(0, 200));
    const onDisk = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.startsWith(masterId + '-v'));
    if (onDisk.length !== 1) fail('并发创建后磁盘应只有一份草稿，实际 ' + onDisk.length + '：' + onDisk.join(','));
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    const drafts = Object.entries(meta).filter(([, m]) => m && m.parent === masterId && m.company === 'Acme' && m.role === 'Backend');
    if (drafts.length !== 1) fail('meta 应只有一条对应草稿，实际 ' + drafts.length);
  }

  // ===== AUD-14 ②：不同岗位可独立创建 =====
  {
    const r = await postJson('/job/create', { from: masterId, company: 'Acme', role: 'Frontend', jdLink: jdUrl });
    if (r.status !== 200) fail('不同岗位应能独立创建，实际 ' + r.status + ' ' + r.text.slice(0, 200));
  }

  // ===== AUD-14 ③：重复串行创建 → existing（幂等，不新建）=====
  {
    const before = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.startsWith(masterId + '-v')).length;
    const r = await postJson('/job/create', { from: masterId, company: 'Acme', role: 'Backend', jdLink: jdUrl });
    if (r.status !== 409) fail('重复创建应 409，实际 ' + r.status);
    if (!r.json || !r.json.existing) fail('重复创建应返回 existing，实际 ' + r.text.slice(0, 200));
    const after = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.startsWith(masterId + '-v')).length;
    if (after !== before) fail('重复创建不应新增草稿');
  }

  // ===== AUD-14 ④：promote 跨 await 不得用旧列表写回（丢记录）=====
  {
    const evalsPath = path.join(root, 'evaluations.json');
    fs.writeFileSync(evalsPath, JSON.stringify([
      { id: 'ev-1', jd: '合成 JD', jdFp: 'fp1', company: 'Acme', role: 'Promoted', score: 4, verdict: 'good', blocks: {}, model: '', createdAt: new Date().toISOString(), promotedTo: null }
    ], null, 2));
    // promote 会跨 await（去重/快照/指纹都在 await 之后）→
    // 期间另一条评估落库；旧实现用 await 前的旧列表写回 → 新记录被覆盖丢失。
    const pending = postJson('/eval/promote', { evalId: 'ev-1', from: masterId });
    await new Promise((r) => setTimeout(r, 80));
    const list = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
    list.push({ id: 'ev-2', jd: '合成 JD 2', jdFp: 'fp2', company: 'Acme', role: 'Promoted2', score: 3, verdict: 'ok', blocks: {}, model: '', createdAt: new Date().toISOString(), promotedTo: null });
    fs.writeFileSync(evalsPath, JSON.stringify(list, null, 2));
    const res = await pending;
    if (res.status !== 200) fail('promote 应成功，实际 ' + res.status + ' ' + res.text.slice(0, 200));
    const after = JSON.parse(fs.readFileSync(evalsPath, 'utf8'));
    const ev1 = after.find((e) => e.id === 'ev-1');
    const ev2 = after.find((e) => e.id === 'ev-2');
    if (!ev1 || !ev1.promotedTo) fail('ev-1 的 promotedTo 未写入');
    if (!ev2 || ev2.jd !== '合成 JD 2' || ev2.score !== 3) fail('另一条评估记录在 promote 交错中丢失（跨 await 用旧列表写回）');
  }

  console.log('PASS AUD-14: 同岗位并发创建只成功一份 + 不同岗位可独立 + 重复得到 existing + promote 交错不丢记录');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { jdServer.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
