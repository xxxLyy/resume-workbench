// test-backup-restore-shapes.mjs — 备份含临时件时恢复必须跳过而非整包拒（BL-P1-03，high 数据完整性）
// 背景：/backup 整目录打包（含渲染发布链/重构/快照元数据留下的非隐藏临时件），/restore 的
// 形状白名单撞上任何临时件即整包 fail → 从此用户打出的每个备份都无法恢复（预览与 apply 全拒），
// 而 /backup 仍 200 零提示。修法：未知形状 → 跳过该条目并逐条列出；安全边界不变
// （穿越/白名单外根/已知形状里的非法 id 仍整包拒）。
// HTTP 类夹具：两个隔离实例（备份源 A、恢复目标 B）+ 真实 tar 链路。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const mkRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-brs-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};
const startServer = async (root) => {
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
    cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const get = (p) => new Promise((resolve, reject) => {
    http.get(base + p, (r) => { const bufs = []; r.on('data', (d) => bufs.push(d)); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(bufs) })); }).on('error', reject);
  });
  const post = (p, body, method = 'POST') => new Promise((resolve, reject) => {
    const req = http.request(base + p, { method, headers: { 'Content-Type': 'application/gzip', 'Content-Length': body.length } }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject); req.end(body);
  });
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) fail('服务在就绪前退出：\n' + log.slice(-800));
    try { await get('/'); return { server, get, post, base }; } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  fail('服务 30s 未就绪\n' + log.slice(-800));
};

// —— 根 A：合法内容；临时件在服务启动【后】再落 ——
// （启动恢复的 cleanupOrphanArtifacts 会清扫 docs//pdfs//snapshots/ 顶层 *.tmp 尾缀文件；
// 真实缺陷场景 = 服务运行中残留（渲染超时/重构中断）后立刻打备份，清扫帮不上这个窗口）
const rootA = mkRoot();
fs.writeFileSync(path.join(rootA, 'docs', 'd1.html'), '<!doctype html><html><body><script>var DOC_ID = \'d1\';</script><p>正文</p></body></html>');
fs.writeFileSync(path.join(rootA, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));
fs.mkdirSync(path.join(rootA, 'snapshots', 'd1'), { recursive: true });
fs.writeFileSync(path.join(rootA, 'snapshots', 'd1', '2026-10-20-101010.html'), '<!doctype html><html><body><p>历史</p></body></html>');

const rootB = mkRoot();   // 恢复目标：全新空根
const A = await startServer(rootA);
const B = await startServer(rootB);
// 服务启动后落三种真实链路形状的非隐藏临时件：
// 渲染发布链残留（render.mjs 的 out+'.stage-<pid>-<ts>-<hash>.tmp-<pid>-<ts>' 形状，尾缀非 .tmp → 启动清扫也不吃）
fs.writeFileSync(path.join(rootA, 'pdfs', 'd1.pdf.stage-123-120000000000-abc123.tmp-124-120000000001'), 'x');
// /restructure 残留（docs/<id>.html.<ts>-<rand>.tmp）
fs.writeFileSync(path.join(rootA, 'docs', 'd1.html.120000000009-abc123.tmp'), 'x');
// saveSnapMeta 残留（snapshots/<id>/meta.json.<ts>.tmp，在子目录 → 启动清扫只扫顶层，不吃）
fs.writeFileSync(path.join(rootA, 'snapshots', 'd1', 'meta.json.120000000010.tmp'), 'x');
const cleanup = () => {
  for (const s of [A.server, B.server]) { try { s.kill('SIGKILL'); } catch {} }
  for (const r of [rootA, rootB]) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
};
process.on('exit', cleanup);

try {
  // ① /backup 正常 200（整目录打包，临时件照进包——备份宁多勿缺）
  const bak = await A.get('/backup');
  if (bak.status !== 200) fail('备份应 200，实际 ' + bak.status);
  const tarBytes = bak.body;

  // ② 预览不再整包拒：ok=true + skipped 逐条列出 3 个临时件
  const prev = await B.post('/restore?apply=0', tarBytes);
  let prevJ = {};
  try { prevJ = JSON.parse(prev.body); } catch { fail('预览响应不是 JSON：' + prev.body.slice(0, 200)); }
  if (prev.status !== 200 || prevJ.ok !== true) {
    fail('预览被整包拒（旧缺陷仍在）：HTTP ' + prev.status + ' ' + String(prevJ.error || '').slice(0, 120));
  }
  const skipped = prevJ.skipped || [];
  if (skipped.length !== 3) fail('skipped 应列出 3 个临时件，实际：' + JSON.stringify(skipped));
  for (const s of skipped) if (!s.name || s.reason !== 'unknown-shape') fail('skipped 条目形状异常：' + JSON.stringify(s));
  if (!Array.isArray(prevJ.docs && prevJ.docs.add) || !prevJ.docs.add.includes('d1')) fail('合法文档 d1 应在 docs.add：' + JSON.stringify(prevJ.docs));

  // ③ apply（merge）：合法内容恢复、临时件不落盘
  const apply = await B.post('/restore?apply=1&mode=merge', tarBytes);
  let applyJ = {};
  try { applyJ = JSON.parse(apply.body); } catch { fail('apply 响应不是 JSON：' + apply.body.slice(0, 200)); }
  if (apply.status !== 200 || applyJ.ok !== true) fail('apply 失败：HTTP ' + apply.status + ' ' + String(applyJ.error || '').slice(0, 160));
  if (!fs.existsSync(path.join(rootB, 'docs', 'd1.html'))) fail('合法文档未被恢复');
  const junkInB = fs.readdirSync(path.join(rootB, 'pdfs')).concat(
    fs.readdirSync(path.join(rootB, 'docs')), fs.readdirSync(path.join(rootB, 'snapshots', 'd1')))
    .filter((f) => f.includes('.tmp') || f.includes('.stage-'));
  if (junkInB.length) fail('临时件被恢复进目标根：' + JSON.stringify(junkInB));

  // ④ 安全边界不松：白名单外根（根级 evil.txt）仍整包拒
  const evilDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-brs-evil-'));
  fs.mkdirSync(path.join(evilDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(evilDir, 'docs', 'e1.html'), '<!doctype html><html><body><script>var DOC_ID = \'e1\';</script><p>e</p></body></html>');
  fs.writeFileSync(path.join(evilDir, 'evil.txt'), 'outside allowed roots');
  const evilTar = path.join(os.tmpdir(), 'resume-brs-evil-' + Date.now() + '.tgz');
  execFileSync('tar', ['czf', evilTar, '-C', evilDir, '.']);
  const evilBytes = fs.readFileSync(evilTar);
  const r1 = await B.post('/restore?apply=0', evilBytes);
  if (r1.status === 200 && JSON.parse(r1.body).ok === true) fail('白名单外条目应整包拒，实际放行');
  if (!String(JSON.parse(r1.body).error || '').includes('不允许的条目')) fail('白名单外拒因应为「不允许的条目」：' + r1.body.slice(0, 120));

  // ⑤ 已知形状 + 非法 id 仍整包拒（存储型 XSS 边界）
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-brs-bad-'));
  fs.mkdirSync(path.join(badDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(badDir, 'docs', "a'+alert(1)+'b.html"), '<!doctype html><html><body><p>x</p></body></html>');
  const badTar = path.join(os.tmpdir(), 'resume-brs-bad-' + Date.now() + '.tgz');
  execFileSync('tar', ['czf', badTar, '-C', badDir, '.']);
  const r2 = await B.post('/restore?apply=0', fs.readFileSync(badTar));
  if (r2.status === 200 && JSON.parse(r2.body).ok === true) fail('非法文档 id 应整包拒，实际放行');
  fs.rmSync(evilDir, { recursive: true, force: true }); fs.rmSync(evilTar, { force: true });
  fs.rmSync(badDir, { recursive: true, force: true }); fs.rmSync(badTar, { force: true });

  console.log('✅ 备份/恢复形状合同：临时件跳过并逐条列出（预览+apply 不再整包拒）、临时件不落盘、白名单外/非法 id 仍整包拒');
} finally {
  cleanup();
}
