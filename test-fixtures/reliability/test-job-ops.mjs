// test-fixtures/reliability/test-job-ops.mjs — 岗位操作的失败语义与幂等语义（真实浏览器）
// 覆盖：
//   ① 明确拒绝（409）→ 精确还原本次改动，用户在请求期间续写的输入必须保留
//   ② 网络异常（结果未知）→ 不断言「未落账」、不回滚（否则页面与磁盘分歧）
//   ③ 同一逻辑提交的重试 → 复用相同 requestId 与相同请求体（服务端判重只回执不重放）
//   ④ 新的合法操作 → 新身份（接受→撤回→再次接受不得命中旧回执）
// 约束：隔离 RESUME_ROOT + 合成文档 + 本机桩；不读真实简历、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobops-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111';
const BEFORE = 'ORIGINAL-TARGET';
const AFTER = 'NEW-TARGET';
const TYPED = '（我在途补充）';

let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">${BEFORE}</p>`);
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    job: {
      changes: [{ id: 'c1', kind: 'replace', zid: P1, before: BEFORE, after: AFTER, note: '测试建议', status: 'pending', level: 'normal' }],
      evidence: [], materials: [], todos: [], feedback: [], genTasks: {}
    }
  }
}, null, 2));

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

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  let bin = null;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过岗位操作浏览器回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();
  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P1 + '"]');
  await page.waitForSelector('#ed-pane-review [data-change="c1"] button.jp-accept', { timeout: 15000 });

  const paraText = () => page.$eval('.sheet [data-zid="' + P1 + '"]', (el) => el.textContent);
  const panelText = () => page.evaluate(() => document.querySelector('#ed-pane-review').textContent || '');
  const waitFor = async (fn, ms = 8000, what = '条件') => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await page.waitForTimeout(120);
    }
    fail('等待超时：' + what);
  };
  const srvChange = async (id) => {
    const d = await (await fetch(base + '/job/changes?id=' + DOC)).json();
    return (d.job.changes || []).find((c) => c.id === id) || null;
  };
  const saveBodies = [];   // JSON 保存（岗位操作）的请求体
  let holdRoute = null;   // 被挂起的 JSON 保存路由

  // ===== ① 明确拒绝（409）：精确还原，用户在途输入必须保留 =====
  {
    await page.route('**/save?**', (route) => {
      const ct = route.request().headers()['content-type'] || '';
      if (ct.includes('application/json')) { holdRoute = route; return; }   // 挂起：模拟「请求在途」
      return route.abort();   // 自动保存（HTML 路径）掐掉：不让磁盘先被改掉
    });
    await page.click('#ed-pane-review [data-change="c1"] button.jp-accept');
    await waitFor(async () => !!holdRoute, 5000, 'JSON 保存请求进入在途');
    // 用户在请求期间继续编辑同一目标段
    await page.click('.sheet [data-zid="' + P1 + '"]');
    await page.keyboard.press('End');
    await page.keyboard.type(TYPED);
    const mid = await paraText();
    assert.ok(mid.includes(AFTER) && mid.includes(TYPED), '在途编辑未生效，实际：' + mid);
    // 服务端明确拒绝（409）
    await holdRoute.fulfill({
      status: 409, contentType: 'application/json',
      body: JSON.stringify({ ok: false, conflict: true, error: '磁盘上的文档已被其他窗口更新' })
    });
    holdRoute = null;
    await page.unroute('**/save?**');
    await waitFor(async () => /磁盘上的文档已被其他窗口更新/.test(await panelText()), 8000, '面板提示失败原因');
    const after409 = await paraText();
    assert.ok(after409.includes(TYPED), '409 后用户在途输入被吞掉，实际：' + after409);
    assert.ok(after409.includes(BEFORE), '409 后本次改动未还原本页，实际：' + after409);
    assert.ok(!after409.includes(AFTER), '409 后本次改动仍留在正文，实际：' + after409);
    assert.ok(/未落账/.test(await panelText()), '明确拒绝应如实说明未落账，实际：' + (await panelText()).slice(-160));
    const st = await srvChange('c1');
    assert.ok(st && st.status === 'pending', '409（明确拒绝）不得改变服务端候选状态，实际：' + JSON.stringify(st));
    console.log('  ✅ 明确拒绝（409）→ 精确还原 + 在途输入保留');
    // 恢复正文到候选的 before（模拟用户改回）：后续场景的 op 基线必须与磁盘一致
    await page.evaluate((ids) => {
      var el = document.querySelector('.sheet [data-zid="' + ids.z + '"]');
      el.textContent = ids.before;
      if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    }, { z: P1, before: BEFORE });
    await page.waitForTimeout(300);
  }

  // ===== ② 网络异常 = 结果未知：不回滚、不断言未落账 =====
  {
    saveBodies.length = 0;
    await page.route('**/save?**', (route) => {
      const ct = route.request().headers()['content-type'] || '';
      if (ct.includes('application/json')) { saveBodies.push(route.request().postData()); return route.abort('failed'); }
      return route.abort();
    });
    await page.click('#ed-pane-review [data-change="c1"] button.jp-accept');
    await waitFor(async () => saveBodies.length >= 1, 5000, 'JSON 保存请求发出');
    await waitFor(async () => /结果未知|可能已落账/.test(await panelText()), 8000, '面板提示「结果未知」');
    const txt = await paraText();
    assert.ok(txt.includes(AFTER), '结果未知时不应回滚（服务端可能已提交），实际：' + txt);
    const noteTxt = await panelText();
    assert.ok(!/未落账/.test(noteTxt), '结果未知不得断言「未落账」，实际提示含：' + noteTxt.slice(-200));
    const st = await srvChange('c1');
    assert.ok(st && st.status === 'pending', '结果未知时服务端状态不得被客户端改写，实际：' + JSON.stringify(st));
    console.log('  ✅ 网络异常（结果未知）→ 不回滚、不断言未落账');
  }

  // ===== ③ 同一逻辑提交的重试：复用相同 requestId 与相同请求体 =====
  {
    const first = JSON.parse(saveBodies[0]);
    const retryBodies = [];
    await page.route('**/save?**', (route) => {
      const ct = route.request().headers()['content-type'] || '';
      if (ct.includes('application/json')) { retryBodies.push(route.request().postData()); return route.continue(); }
      return route.abort();
    });
    await page.click('#ed-pane-review [data-change="c1"] button.jp-accept');
    await waitFor(async () => retryBodies.length >= 1, 8000, '重试请求发出');
    await page.unroute('**/save?**');
    const retry = JSON.parse(retryBodies[0]);
    assert.equal(retry.requestId, first.requestId, '重试必须复用同一 requestId');
    assert.equal(retry.html, first.html, '重试必须复用同一请求体（html）');
    assert.equal(JSON.stringify(retry.ops), JSON.stringify(first.ops), '重试必须复用同一请求体（ops）');
    // 服务端按 requestId 判重 → 落账为已接受（此前那次未送达，故本次真正应用）
    let st = null;
    for (let i = 0; i < 60; i++) {
      st = await srvChange('c1');
      if (st && st.status === 'accepted') break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(st && st.status === 'accepted', '重试后服务端应落账为已接受，实际：' + JSON.stringify(st));
    assert.ok(st.origText === BEFORE && st.appliedText === AFTER, '重试落账的快照不符：' + JSON.stringify(st));
    console.log('  ✅ 重试复用同一 requestId 与同一请求体（服务端判重落账）');
  }

  // ===== ④ 新的合法操作 → 新身份（撤回不得命中接受的旧回执）=====
  {
    const ids = [];
    await page.route('**/save?**', (route) => {
      const ct = route.request().headers()['content-type'] || '';
      if (ct.includes('application/json')) { ids.push(JSON.parse(route.request().postData()).requestId); return route.continue(); }
      return route.abort();
    });
    // 撤回（新的合法操作）→ 必须用新身份
    await page.waitForSelector('#ed-pane-review [data-change="c1"] button', { timeout: 8000 });
    await page.evaluate(() => {
      var btns = document.querySelectorAll('#ed-pane-review [data-change="c1"] button');
      for (var i = 0; i < btns.length; i++) { if ((btns[i].textContent || '').indexOf('撤回') >= 0) { btns[i].click(); return; } }
    });
    await waitFor(async () => ids.length >= 1, 8000, '撤回请求发出');
    await page.unroute('**/save?**');
    assert.ok(ids.length >= 1, '撤回未发出保存请求');
    assert.notEqual(ids[0], JSON.parse(saveBodies[0]).requestId, '撤回（新的合法操作）不得复用旧身份');
    let st = null;
    for (let i = 0; i < 60; i++) {
      st = await srvChange('c1');
      if (st && st.status === 'pending' && st.acceptedAt === undefined) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // 撤回后回到 pending 并清快照（服务端状态机：revert → pending）
    assert.ok(st && st.status === 'pending' && st.acceptedAt === undefined && st.appliedText === undefined,
      '撤回后服务端应回到 pending 且清快照，实际：' + JSON.stringify(st));
    const disk = fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8');
    assert.ok(disk.includes(BEFORE) && !disk.includes(AFTER), '撤回后磁盘正文未回到原文');
    console.log('  ✅ 新的合法操作使用新身份（撤回未命中旧回执）');
  }

  console.log('PASS 岗位操作回归：明确拒绝保留在途输入 + 结果未知不回滚 + 重试复用身份 + 新操作新身份');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
