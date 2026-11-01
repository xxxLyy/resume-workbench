// test-ai-apply-occurrence.mjs — 选区改写「应用」必须落在用户选中的那一处（BL-P3-01，medium）
// 背景（总账）：ai-panel.js 的 #ai-apply 调 __edReplaceText 不传 occurrence → 默认 chosen=0
// （全文首个匹配）。反例：P1/P2 两段完全同文，用户选第二段改写并应用 → 第一段被改写、
// 面板零提示——与同文件聊天路径「多处命中即拒」口径相反。
// 修法合同：选区时刻算锚点（occurrence），生成时随快照冻结，应用时传给 __edReplaceText；
//           多处命中且锚点无法唯一定位 → 拒绝并提示（与聊天路径同口径）。
// 断言全部靠内容/请求行为变红，不靠提示文字与超时。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-ai-apply-occ-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111', P2 = 'z22222222', P3 = 'z33333333';
const TWIN = '负责队列服务，把延迟从 80ms 降到 12ms';   // P1/P2 完全同文（缺陷触发前提）
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () =>
  `<p data-zid="${P1}">${TWIN}</p><p data-zid="${P2}">${TWIN}</p><p data-zid="${P3}">UNIQUE-ONLY-ONE-SENTENCE</p>`);
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

  // 桩 /ai/rewrite：不同用例返回不同 revised（桩词全大写，便于逐字比对落在哪一段）
  let stubRevised = '';
  let rewriteHits = 0;
  await page.route('**/ai/rewrite', async (route) => {
    rewriteHits++;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, revised: stubRevised }) });
  });

  const paraText = (zid) => page.$eval('.sheet [data-zid="' + zid + '"]', (el) => el.textContent);
  const reload = async () => {
    await page.goto(base + '/edit?id=' + DOC);
    await page.waitForSelector('.sheet [data-zid="' + P1 + '"]', { timeout: 15000 });
    await page.waitForSelector('#ai-msg', { state: 'attached', timeout: 15000 });
  };
  // 程序化选区 + mouseup（真实 UI 同款事件流）：
  //   mode='textnode' → Range 起点在文本节点上（真实拖选形态，锚点可折算）
  //   mode='element'  → Range 起点在元素节点上（锚点折算失败的防御路径：无法唯一定位）
  const selectPara = async (zid, mode) => {
    await page.evaluate(([zid, mode]) => {
      const p = document.querySelector('.sheet [data-zid="' + zid + '"]');
      const sel = window.getSelection();
      const r = document.createRange();
      if (mode === 'textnode') { r.setStart(p.firstChild, 0); r.setEnd(p.firstChild, p.firstChild.data.length); }
      else r.selectNodeContents(p);
      sel.removeAllRanges();
      sel.addRange(r);
      p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, [zid, mode]);
  };
  const runRewrite = async () => {
    await page.click('#ed-seltb button[data-preset="concise"]');
    await page.click('#ai-gen');
    await page.waitForFunction(() => (document.getElementById('ai-actions') || {}).style.display === 'block', null, { timeout: 8000 });
    await page.click('#ai-apply');
    await page.waitForTimeout(150);   // 让应用分支的 DOM 写入落地
  };

  // ---- CASE A（主断言）：两处同文，选第二段 → 应用必须改第二段，第一段原样 ----
  await reload();
  stubRevised = 'CASEA-REVISED-SECOND';
  await selectPara(P2, 'textnode');
  await runRewrite();
  assert.equal(await paraText(P1), TWIN, 'CASE A：未选中的第一处（P1）不得被改，实际：' + await paraText(P1));
  assert.equal(await paraText(P2), 'CASEA-REVISED-SECOND', 'CASE A：用户选中的第二处（P2）应被改，实际：' + await paraText(P2));

  // ---- CASE B（拒绝口径）：多处命中且锚点无法唯一定位 → 拒绝应用，两段均原样 ----
  writeAll();
  await reload();
  stubRevised = 'CASEB-REJECTED-DRAFT';
  await selectPara(P2, 'element');
  await runRewrite();
  assert.equal(await paraText(P1), TWIN, 'CASE B：多处命中且无法定位应拒绝，P1 不得被改，实际：' + await paraText(P1));
  assert.equal(await paraText(P2), TWIN, 'CASE B：拒绝口径下 P2 也不得被改，实际：' + await paraText(P2));
  assert.equal(await page.$eval('#ai-pop', (el) => el.style.display), 'block', 'CASE B：拒绝后弹层不得当作已应用而关闭');

  // ---- CASE C（防回归）：唯一命中照常应用（锚点机制不得破坏单处路径）----
  writeAll();
  await reload();
  stubRevised = 'CASEC-REVISED-UNIQUE';
  await selectPara(P3, 'textnode');
  await runRewrite();
  assert.equal(await paraText(P3), 'CASEC-REVISED-UNIQUE', 'CASE C：唯一命中仍应正常应用，实际：' + await paraText(P3));
  assert.equal(await paraText(P1), TWIN, 'CASE C：P1 不得被误改，实际：' + await paraText(P1));
  assert.equal(await paraText(P2), TWIN, 'CASE C：P2 不得被误改，实际：' + await paraText(P2));

  assert.ok(rewriteHits >= 3, '三次用例都应真实发出 /ai/rewrite 请求，实际命中：' + rewriteHits);
  console.log('✅ 选区改写锚点：同文两处应用落点正确（选哪改哪）、多处命中无法定位即拒绝（两段均不动）、唯一命中照常应用');
} catch (e) {
  console.error('❌ ' + (e && e.message || e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  cleanup();
}
