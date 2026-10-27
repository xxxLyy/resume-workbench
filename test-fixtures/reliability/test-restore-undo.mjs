// test-fixtures/reliability/test-restore-undo.mjs — 恢复撤销的「存在/不存在」还原行为回归
// 覆盖：AUD-09（安全点记录存在性；撤销精确还原「原本不存在」；旧安全点不猜测删除）。
// 约束：隔离 RESUME_ROOT + 合成备份包；不读真实简历、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-ru-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 恢复前：本地有 applications.json，**没有** evaluations.json（这正是 AUD-09 的复现条件）
fs.writeFileSync(path.join(root, 'docs', 'doc1.html'), '<html><body><p>本地正文</p></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ doc1: { rev: 1 } }));
fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([{ id: '11', company: '本地公司' }]));
fs.writeFileSync(path.join(root, 'materials.json'), JSON.stringify([]));

// 备份包：含 evaluations.json（恢复前本地没有）与另一条 applications.json
const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pkg-'));
fs.mkdirSync(path.join(pkg, 'docs'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'docs', 'doc2.html'), '<html><body><p>备份正文</p></body></html>');
fs.writeFileSync(path.join(pkg, 'docs-meta.json'), JSON.stringify({ doc2: { rev: 1 } }));
fs.writeFileSync(path.join(pkg, 'applications.json'), JSON.stringify([{ id: '22', company: '备份公司' }]));
fs.writeFileSync(path.join(pkg, 'materials.json'), JSON.stringify([]));
fs.writeFileSync(path.join(pkg, 'evaluations.json'), JSON.stringify([{ id: 'ev-1', jd: '备份评估', score: 3 }]));
const tarPath = path.join(root, 'backup.tar.gz');
execFileSync('tar', ['czf', tarPath, '-C', pkg, 'docs', 'docs-meta.json', 'applications.json', 'materials.json', 'evaluations.json']);
const tarBytes = fs.readFileSync(tarPath);

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
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
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

  // ===== 恢复（merge）→ 导入 evaluations.json =====
  const restored = await post('/restore?apply=1&mode=merge', tarBytes);
  if (restored.status !== 200 || !restored.json || !restored.json.ok) fail('恢复失败：' + restored.status + ' ' + restored.text.slice(0, 300));
  const safety = restored.json.safety;
  if (!safety) fail('恢复未返回回退点名，响应：' + restored.text.slice(0, 400));
  if (!fs.existsSync(path.join(root, 'evaluations.json'))) fail('恢复后 evaluations.json 应存在');
  const appsAfterRestore = JSON.parse(fs.readFileSync(path.join(root, 'applications.json'), 'utf8'));
  if (appsAfterRestore.length !== 2) fail('merge 后 applications 应为两条，实际 ' + appsAfterRestore.length);

  // ===== 撤销 → 「原本不存在」必须被还原 =====
  const undone = await post('/restore/undo?ts=' + encodeURIComponent(safety), Buffer.alloc(0));
  if (undone.status !== 200 || !undone.json || !undone.json.ok) fail('撤销失败：' + undone.status + ' ' + undone.text.slice(0, 300));
  if (fs.existsSync(path.join(root, 'evaluations.json'))) {
    fail('AUD-09：撤销后 evaluations.json 仍在（恢复前它并不存在）——存在性未被还原');
  }
  const appsAfterUndo = JSON.parse(fs.readFileSync(path.join(root, 'applications.json'), 'utf8'));
  if (appsAfterUndo.length !== 1 || appsAfterUndo[0].id !== '11') {
    fail('撤销后 applications 应回到恢复前的一条本地记录，实际 ' + JSON.stringify(appsAfterUndo));
  }
  if (!fs.existsSync(path.join(root, 'docs', 'doc1.html'))) fail('撤销后本地文档应仍在');
  if (fs.existsSync(path.join(root, 'docs', 'doc2.html'))) fail('撤销后备份引入的文档应被移除');

  // ===== 再 undo（撤销自己的回退点）→ 仍应精确还原 =====
  const safety2 = undone.json.safety;
  if (!safety2) fail('撤销未返回自己的回退点名（无法「再撤销」）');
  const undone2 = await post('/restore/undo?ts=' + encodeURIComponent(safety2), Buffer.alloc(0));
  if (undone2.status !== 200 || !undone2.json || !undone2.json.ok) fail('二次撤销失败：' + undone2.status + ' ' + undone2.text.slice(0, 300));
  // 语义：再撤销 = 撤销「上一次撤销」→ 回到上一次撤销【之前】的状态（恢复导入后的状态）。
  if (!fs.existsSync(path.join(root, 'evaluations.json'))) fail('二次撤销后应回到撤销前的状态（evaluations.json 存在）');
  const appsAfterUndo2 = JSON.parse(fs.readFileSync(path.join(root, 'applications.json'), 'utf8'));
  if (appsAfterUndo2.length !== 2) fail('二次撤销后 applications 应回到合并后的两条，实际 ' + appsAfterUndo2.length);

  // ===== 旧安全点（无存在性台账）→ 不猜测删除用户数据 =====
  {
    const legacyTs = 'restore-1000000000000';
    const legacyDir = path.join(root, 'backups', legacyTs, 'data');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'applications.json'), JSON.stringify([{ id: '55', company: '旧回退点' }]));
    // 手动放一个 evaluations.json（模拟「恢复导入过、旧安全点没有台账」）
    fs.writeFileSync(path.join(root, 'evaluations.json'), JSON.stringify([{ id: 'ev-keep', jd: '应保留' }]));
    const r = await post('/restore/undo?ts=' + legacyTs, Buffer.alloc(0));
    if (r.status !== 200) fail('旧安全点撤销应成功，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    if (!fs.existsSync(path.join(root, 'evaluations.json'))) {
      fail('旧安全点没有存在性台账 → 不得猜测删除用户数据（evaluations.json 被删了）');
    }
  }

  console.log('PASS AUD-09: 撤销精确还原存在/不存在 + 再撤销仍准确 + 旧安全点不猜测删除');
} finally {
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(pkg, { recursive: true, force: true }); } catch {}
}
