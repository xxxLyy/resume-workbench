// test-fixtures/reliability/test-upload-migrate.mjs — PDF 上传入口与编辑器迁移锁的行为回归
// 覆盖：AUD-12（上传入口接回 + 同名并发不覆盖 + 类型/体积闸门）、AUD-11（迁移遵守共享根锁）。
// 约束：隔离 RESUME_ROOT + 合成 PDF（cupsfilter 本地生成）+ 本机回环；不读真实简历、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync, spawnSync } from 'node:child_process';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-up-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 合成 PDF（本地 cupsfilter 生成，pdftotext 可读；不依赖任何外部资源）
const samplePdf = (() => {
  const p = path.join(root, 'sample.pdf');
  try {
    const out = spawnSync('cupsfilter', ['-i', 'text/plain', '-m', 'application/pdf'],
      { input: 'Hello Resume Upload Test\nSecond line of text.\n', maxBuffer: 8 * 1024 * 1024 });
    if (out.status !== 0 || !out.stdout || out.stdout.length < 100) return null;
    fs.writeFileSync(p, out.stdout);
    return p;
  } catch { return null; }
})();

try {
// ===== AUD-11：编辑器迁移必须遵守共享根锁 =====
const legacyDoc = (id) => `<!doctype html><html><head><title>${id}</title></head><body>
<div class="edit-toolbar" data-editor="v4"><button>旧工具栏</button></div>
<p data-zid="z11111111">正文段落</p>
<script>
(function () { var DOC_ID = '${id}'; window.__OLD__ = 1; })();
</script></body></html>`;
const migRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-mig-'));
for (const d of ['docs', 'backups']) fs.mkdirSync(path.join(migRoot, d), { recursive: true });
fs.writeFileSync(path.join(migRoot, 'docs', 'doc1.html'), legacyDoc('doc1'));
const runMigrate = () => spawnSync(process.execPath, [path.join(APP_ROOT, 'migrate-editor.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: migRoot }, encoding: 'utf8'
});
const doc1 = () => fs.readFileSync(path.join(migRoot, 'docs', 'doc1.html'), 'utf8');
{
  // ① 外来新鲜锁：迁移必须拒绝（退出码非 0）、不动文档、不删别人的锁
  const { rootLock } = await import(path.join(APP_ROOT, 'tx.mjs'));
  rootLock.acquire(migRoot);
  const before = doc1();
  const r = runMigrate();
  if (r.status === 0) fail('外来锁持有时 migrate-editor 不应以 0 退出');
  if (doc1() !== before) fail('外来锁持有时文档被修改了（应在他人锁下不写）');
  if (!fs.existsSync(rootLock.path(migRoot))) fail('迁移不得删除他人持有的锁');
  rootLock.release(migRoot);
}
{
  // ② 无锁：迁移成功，且留有备份
  const r = runMigrate();
  if (r.status !== 0) fail('无锁时 migrate-editor 应成功，实际 ' + r.status + ' ' + (r.stderr || '').slice(0, 200));
  if (!doc1().includes('data-editor="v5"')) fail('迁移后应是 v5 编辑器');
  const bak = fs.readdirSync(path.join(migRoot, 'backups'));
  if (!bak.length) fail('迁移必须留备份');
  const bdir = path.join(migRoot, 'backups', bak[0], 'doc1');
  if (!fs.existsSync(path.join(bdir, 'doc1.html'))) fail('备份内容缺失');
}
{
  // ③ 幂等：再跑一次应 skip，文档字节不变
  const before = doc1();
  const r = runMigrate();
  if (r.status !== 0) fail('幂等重跑应成功');
  if (!r.stdout.includes('skip')) fail('幂等重跑应报告 skip，实际：' + r.stdout.slice(0, 200));
  if (doc1() !== before) fail('幂等重跑不应改动文档');
}
{
  // ④ 陈旧锁（持有者已死）：必须接管并完成迁移
  const { rootLock } = await import(path.join(APP_ROOT, 'tx.mjs'));
  fs.writeFileSync(rootLock.path(migRoot), JSON.stringify({ pid: 999999, host: 'x', startedAt: Date.now() }));
  fs.writeFileSync(path.join(migRoot, 'docs', 'doc2.html'), legacyDoc('doc2'));
  const r = runMigrate();
  if (r.status !== 0) fail('陈旧锁应被接管后完成迁移，实际 ' + r.status + ' ' + (r.stderr || '').slice(0, 200));
  if (!fs.readFileSync(path.join(migRoot, 'docs', 'doc2.html'), 'utf8').includes('data-editor="v5"')) fail('陈旧锁接管后 doc2 未迁移');
}

// ===== AUD-12：PDF 上传入口 + 同名并发 =====
if (!samplePdf) {
  console.log('⚠️  本机无 cupsfilter，跳过 PDF 上传段（迁移锁段已通过）');
} else {
  const pdfBytes = fs.readFileSync(samplePdf);
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
    const upload = (bytes, name) => fetch(base + '/upload?name=' + encodeURIComponent(name), {
      method: 'POST', body: bytes, redirect: 'manual'
    });

    // ① 正常上传 → 303 重定向到 /edit?id=<新文档>
    {
      const r = await upload(pdfBytes, 'resume-sample.pdf');
      if (r.status !== 303) fail('上传成功应 303 重定向，实际 ' + r.status + ' ' + (await r.text()).slice(0, 200));
      const loc = r.headers.get('location') || '';
      const m = /\/edit\?id=([a-z0-9-]+)/.exec(loc);
      if (!m) fail('重定向目标应带文档 id，实际 ' + loc);
      const id = m[1];
      if (!fs.existsSync(path.join(root, 'docs', id + '.html'))) fail('上传后文档文件不存在：' + id);
      const html = fs.readFileSync(path.join(root, 'docs', id + '.html'), 'utf8');
      if (!html.includes('Hello Resume Upload Test')) fail('导入文档不含 PDF 提取的文本（降级路径失效）');
      const page = await fetch(base + '/edit?id=' + id);
      if (!page.ok) fail('导入后编辑页不可用，状态 ' + page.status);
      await page.text();
    }
    // ② 同名并发：两份都在、id 不同
    {
      const [a, b] = await Promise.all([upload(pdfBytes, 'same-name.pdf'), upload(pdfBytes, 'same-name.pdf')]);
      const ids = [a, b].map((r) => (/id=([a-z0-9-]+)/.exec(r.headers.get('location') || '') || [])[1]).filter(Boolean);
      if (ids.length !== 2) fail('并发上传应都成功，实际 id=' + JSON.stringify(ids) + ' 状态 ' + [a.status, b.status]);
      if (ids[0] === ids[1]) fail('并发同名上传拿到了同一个 id：' + ids[0]);
      for (const id of ids) if (!fs.existsSync(path.join(root, 'docs', id + '.html'))) fail('并发上传后文档缺失：' + id);
      const onDisk = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.startsWith('same-name'));
      if (onDisk.length !== 2) fail('并发同名上传后磁盘应有两份，实际 ' + onDisk.length);
    }
    // ③ 类型闸门：非 PDF 拒绝
    {
      const r = await upload(Buffer.from('这不是 PDF', 'utf8'), 'fake.pdf');
      if (r.status !== 400) fail('非 PDF 应返回 400，实际 ' + r.status);
      await r.text();
    }
    // ④ 体积闸门：超 20MB 拒绝
    {
      const big = Buffer.concat([pdfBytes, Buffer.alloc(21 * 1024 * 1024, 0x20)]);
      const r = await upload(big, 'big.pdf');
      if (r.status !== 413) fail('超限上传应返回 413，实际 ' + r.status);
      await r.text();
    }
    // ⑤ 服务仍存活
    const home = await fetch(base + '/');
    if (!home.ok) fail('上传段结束后服务不可用');
    await home.text();
  } finally {
    try { server.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 400));
    try { server.kill('SIGKILL'); } catch {}
  }
  console.log('PASS AUD-11/AUD-12: 迁移遵守共享根锁（拒绝/接管/幂等）+ 上传入口可用且同名并发不覆盖');
}
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(migRoot, { recursive: true, force: true }); } catch {}
}
