// test-ai-apply-error.mjs — 选区改写「应用」失败时提示必须可达（BL-P3-05，medium）
// 背景（总账）：#ai-apply 的失败分支挂在 else-if 链最后：__edPushUndo/__edDropUndo 在外壳
// 恒存在（editor-shell.js:675/685），失败恒走 __edDropUndo 分支（表达式真值）→
// 『原文未找到（可能已被修改），未应用』提示永不执行——用户点「应用」后既无提示也无变化。
// 复现口径：生成预览 → 生成后改掉正文里那段 → 点「应用」→ 修复前 #ai-preview 无警告、弹层仍开。
// 修法合同：失败判定改独立分支（dropUndo 照做 + 提示可达）。
// 断言以内容优先：正文未被误改 + 提示文字出现 + 弹层未当作成功关闭。
// 约束：隔离 RESUME_ROOT（mkdtemp）+ 合成文档 + 桩 /ai/rewrite；不读真实简历、不碰 7766、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-ai-apply-err-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111', P2 = 'z22222222';
const TARGET = '负责队列服务，把延迟从 80ms 降到 12ms';   // 唯一出现（不触发多处命中拒绝，直达失败分支）
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () =>
  `<p data-zid="${P1}">${TARGET}</p><p data-zid="${P2}">另一段无关内容</p>`);
const writeAll = () => {
  fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
  fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
    [DOC]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
      job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} } }
  }, null, 2));
};
writeAll();

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
const base = `http://127.0.0.1:${port}`;

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }
  let bin = null;
  try { bin = await resolveChromium(); }
  catch (e) { cleanup(); console.log('⚠️  Chromium 不可用，跳过：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));

  // 桩 /ai/rewrite
  await page.route('**/ai/rewrite', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, revised: 'REVISED-DRAFT' }) });
  });

  const paraText = (zid) => page.$eval('.sheet [data-zid="' + zid + '"]', (el) => el.textContent);

  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P1 + '"]', { timeout: 15000 });
  await page.waitForSelector('#ai-msg', { state: 'attached', timeout: 15000 });

  // ① 选区 → 工具条 → 生成预览（选区为文本节点容器，锚点正常，不经多处命中拒绝）
  await page.evaluate(([zid]) => {
    const p = document.querySelector('.sheet [data-zid="' + zid + '"]');
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStart(p.firstChild, 0);
    r.setEnd(p.firstChild, p.firstChild.data.length);
    sel.removeAllRanges();
    sel.addRange(r);
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, [P1]);
  await page.click('#ed-seltb button[data-preset="concise"]');
  await page.click('#ai-gen');
  await page.waitForFunction(() => (document.getElementById('ai-actions') || {}).style.display === 'block', null, { timeout: 8000 });

  // ② 生成后把正文里那段改掉（总账复现口径）→ 原文将找不到 → 应用必须走失败分支
  const HAND = '生成之后被人手改的内容';
  await page.evaluate(([zid, t]) => { document.querySelector('.sheet [data-zid="' + zid + '"]').firstChild.data = t; }, [P1, HAND]);
  await page.click('#ai-apply');
  await page.waitForTimeout(150);

  // ③ 断言（内容优先）
  assert.equal(await paraText(P1), HAND, '失败应用不得误改正文（P1 应保持手改后内容），实际：' + await paraText(P1));
  assert.equal(await paraText(P2), '另一段无关内容', 'P2 不得被误改，实际：' + await paraText(P2));
  const popShown = await page.$eval('#ai-pop', (el) => el.style.display);
  assert.equal(popShown, 'block', '失败路径弹层不得当作已应用关闭，实际 display：' + popShown);
  const previewText = await page.$eval('#ai-preview', (el) => el.textContent);
  assert.ok(/未应用/.test(previewText), '失败提示必须可达（#ai-preview 应含「未应用」），实际预览区文本：' + JSON.stringify(previewText));
  assert.deepEqual(pageErrors, [], '不得有页面异常：' + JSON.stringify(pageErrors));

  console.log('✅ 应用失败提示可达：正文未被误改、弹层未关闭、#ai-preview 出现「未应用」警告、无页面异常');
} catch (e) {
  console.error('❌ ' + (e && e.message || e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  cleanup();
}
