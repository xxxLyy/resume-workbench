// test-fixtures/reliability/test-server-io.mjs — 服务端写路径的行为回归（隔离服务 + 真实请求）
// 覆盖：AUD-10（校验失败零落盘）、AUD-08（文件流错误收敛到请求失败，服务存活）。
// 约束：隔离 RESUME_ROOT + 合成文档 + 本机回环；不读真实简历、不调真实模型、不写真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const APP = new URL('../../', import.meta.url);
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// 隔离数据根
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-io-'));
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-io-tmp-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const DOC = 'doc1';
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'),
  '<html><body><p data-zid="z11111111">正文一</p><p data-zid="z22222222">正文二</p></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft',
    job: {
      evidence: [{ id: 'e1', req: '要求一', status: 'covered', refs: [], note: 'OLD FACT', noteConfirmed: true }],
      changes: [{ id: 'c1', status: 'pending', text: '候选一' }],
      todos: [], feedback: [], genTasks: {}
    }
  }
}, null, 2));

const metaPath = path.join(root, 'docs-meta.json');
const metaStat = () => {
  const st = fs.statSync(metaPath);
  return { bytes: fs.readFileSync(metaPath, 'utf8'), mtime: st.mtimeMs, size: st.size };
};
const jobOf = () => JSON.parse(fs.readFileSync(metaPath, 'utf8'))[DOC].job;

// 空闲端口
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const port = await freePort();
const server = spawn(process.execPath, [path.join(APP.pathname, 'server.mjs')], {
  cwd: APP.pathname,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port), TMPDIR: tmpdir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let serverExited = null;
server.on('exit', (code, sig) => { serverExited = { code, sig }; });

const base = `http://127.0.0.1:${port}`;
const waitReady = async () => {
  for (let i = 0; i < 120; i++) {
    if (serverExited) fail('服务在就绪前退出：' + JSON.stringify(serverExited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); return; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  fail('服务未在 12s 内就绪\n' + serverLog.slice(-800));
};
const post = async (p, body, raw) => {
  const r = await fetch(base + p, raw
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

try {
  await waitReady();

  // ===== AUD-10：4xx 之前必须零落盘（meta 字节与 mtime 都不变）=====
  {
    const before = metaStat();
    const r = await post(`/job/changes?id=${DOC}`, { evidenceNote: { reqId: 'e1', note: '', confirmed: true } });
    if (r.status !== 400) fail('空说明的 evidenceNote 应返回 400，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    const after = metaStat();
    if (after.bytes !== before.bytes) fail('400 之后 meta 字节被改了（应零落盘）');
    if (after.mtime !== before.mtime) fail('400 之后 meta mtime 变了（应零落盘）');
    const j = jobOf();
    if (j.evidence[0].note !== 'OLD FACT') fail('空说明不得清空已有 note，实际 ' + JSON.stringify(j.evidence[0].note));
    if (j.evidence[0].noteConfirmed !== true) fail('空说明不得保持/改变已确认标志，实际 ' + JSON.stringify(j.evidence[0].noteConfirmed));
  }
  {
    // 组合请求：前半段合法（改 change 状态）、后半段非法（空说明）→ 整个更新放弃，不得半提交
    const before = metaStat();
    const r = await post(`/job/changes?id=${DOC}`, {
      updates: [{ id: 'c1', status: 'accepted' }],
      evidenceNote: { reqId: 'e1', note: '', confirmed: true }
    });
    if (r.status !== 400) fail('组合请求应返回 400，实际 ' + r.status);
    const after = metaStat();
    if (after.bytes !== before.bytes) fail('组合请求 400 之后 meta 字节被改了');
    if (after.mtime !== before.mtime) fail('组合请求 400 之后 meta mtime 变了');
    if (jobOf().changes[0].status !== 'pending') fail('组合请求不得半提交：change 状态被改了');
  }
  {
    // resolve 指向不存在的候选 → 400 且零落盘
    const before = metaStat();
    const r = await post(`/job/changes?id=${DOC}`, { resolve: { changeId: '不存在', text: 'x' } });
    if (r.status !== 400) fail('无效 resolve 应返回 400，实际 ' + r.status);
    const after = metaStat();
    if (after.bytes !== before.bytes || after.mtime !== before.mtime) fail('无效 resolve 400 之后 meta 被改了');
  }
  {
    // 合法请求 → 200 且真的落盘（证明上面的「零落盘」不是因为根本没写）
    const r = await post(`/job/changes?id=${DOC}`, { updates: [{ id: 'c1', status: 'accepted' }] });
    if (r.status !== 200) fail('合法请求应返回 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    if (jobOf().changes[0].status !== 'accepted') fail('合法请求未落盘');
  }
  {
    // 非法 reviewPos / feedback 同样零落盘
    const before = metaStat();
    const r1 = await post(`/job/changes?id=${DOC}`, { reviewPos: { section: 'bad', changeId: null, filter: 'all' } });
    const r2 = await post(`/job/changes?id=${DOC}`, { feedback: '   ' });
    if (r1.status !== 400 || r2.status !== 400) fail(`非法 reviewPos/feedback 应 400，实际 ${r1.status}/${r2.status}`);
    const after = metaStat();
    if (after.bytes !== before.bytes || after.mtime !== before.mtime) fail('非法 reviewPos/feedback 400 之后 meta 被改了');
  }

  // ===== AUD-08：恢复上传的输出流 I/O 错误 → 请求失败，服务必须存活 =====
  {
    // 让 server 的临时目录不可写 → createWriteStream 的 error 事件被触发
    fs.chmodSync(tmpdir, 0o500);
    const payload = Buffer.alloc(4096, 0x41);   // 合成 tar 字节（内容无效也不影响本用例：要的是 I/O 错误路径）
    let r;
    try {
      r = await post('/restore', payload, true);
    } finally {
      try { fs.chmodSync(tmpdir, 0o700); } catch {}
    }
    if (r.status < 400 || r.status >= 500) fail('上传 I/O 失败应返回 4xx，实际 ' + r.status);
    // 服务必须还活着：再打一次首页
    const home = await fetch(base + '/');
    if (!home.ok) fail('上传 I/O 失败后服务不可用（状态 ' + home.status + '）');
    await home.text();
    if (serverExited) fail('上传 I/O 失败导致服务退出：' + JSON.stringify(serverExited));
  }

  // ===== 收尾：服务仍存活 =====
  const home2 = await fetch(base + '/');
  if (!home2.ok) fail('收尾时服务不可用');
  await home2.text();

  console.log('PASS AUD-10/AUD-08: 4xx 零落盘（字节+mtime）+ 上传 I/O 失败收敛到请求且服务存活');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {}
}
