// test-fixtures/reliability/test-job-merge.mjs — 成功回执合并保护在途输入 + 补查回执衔接普通保存
// 覆盖：
//   ① needs-compare 确认门接受 → 服务端已提交但响应暂停 → 用户改目标段 → 成功响应到达
//      → 页面保留用户输入、明确标待核对；未变化的目标才应用已确认修改
//   ② 普通接受 / 撤回 / 批量的在途编辑（同样不被覆盖）
//   ③ 先真实提交再丢响应 → 按 requestId 补查命中 → 基线更新 → 后续手动保存 / 自动保存 / 刷新都成立
//   ④ 较新保存先确认、旧回执后到 → 版本不倒退
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-merge-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111';
const P2 = 'z22222222';
const P3 = 'z33333333';
const BEFORE = 'ORIGINAL-TARGET';
const AFTER = 'NEW-CANDIDATE';
const BEFORE2 = 'SECOND-TARGET';
const AFTER2 = 'SECOND-CANDIDATE';
const BEFORE3 = 'THIRD-TARGET';
const AFTER3 = 'THIRD-CANDIDATE';
const INFLIGHT = 'USER-INFLIGHT-EDIT';

let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">${BEFORE}</p><p data-zid="${P2}">${BEFORE2}</p><p data-zid="${P3}">${BEFORE3}</p>`);
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);

const metaPath = path.join(root, 'docs-meta.json');
const CHANGES = [
  // c1 带过期 baseSnapshot → 需要走确认门（needs-compare）
  { id: 'c1', kind: 'replace', zid: P1, before: BEFORE, after: AFTER, note: '确认门建议', status: 'pending', level: 'normal', baseSnapshot: '确认前的旧内容' },
  { id: 'c2', kind: 'replace', zid: P2, before: BEFORE2, after: AFTER2, note: '普通建议', status: 'pending', level: 'normal' },
  { id: 'c3', kind: 'replace', zid: P3, before: BEFORE3, after: AFTER3, note: '第三条建议', status: 'pending', level: 'normal' }
];
const writeMeta = () => fs.writeFileSync(metaPath, JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    zones: { [P1]: { zone: 'project', status: 'confirmed' }, [P2]: { zone: 'project', status: 'confirmed' } },
    job: { changes: CHANGES.map((c) => Object.assign({}, c)), evidence: [], materials: [], todos: [], feedback: [], genTasks: {} }
  }
}, null, 2));
writeMeta();

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
// process.exit（断言失败）会跳过 finally → 这里用 exit 钩子保证测试服务一定被收掉（否则会留下孤儿进程）
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过岗位合并回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();

  // —— 辅助 ——
  const paraText = (zid) => page.$eval('.sheet [data-zid="' + zid + '"]', (el) => el.textContent);
  const panelText = () => page.evaluate(() => document.querySelector('#ed-pane-review').textContent || '');
  const noteText = () => page.evaluate(() => (document.querySelector('#ed-pane-review .jp-msg') || {}).textContent || '');
  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(120); }
    fail('等待超时：' + what + '（提示：' + (await noteText()).slice(-160) + '）');
  };
  const serverState = async () => (await (await fetch(base + '/job/changes?id=' + DOC)).json());
  const diskHtml = () => fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8');
  const baseline = () => page.evaluate(() => Number(window.__edDocMtime || 0));
  const reload = async () => {
    await page.goto(base + '/edit?id=' + DOC);
    await page.waitForSelector('#ed-pane-review [data-change="c1"]', { timeout: 15000 });
  };
  const resetFixture = () => {
    fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
    writeMeta();
  };
  const acceptBtn = (id) => '#ed-pane-review [data-change="' + id + '"] button.jp-accept';
  // 让用户「在请求在途时」改目标段：直接改 DOM 文本（模拟真实输入）
  const editTarget = (zid, text) => page.evaluate((a) => {
    var el = document.querySelector('.sheet [data-zid="' + a.z + '"]');
    el.textContent = a.t;
    if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
  }, { z: zid, t: text });

  // 计数客户端对 /job/changes 的请求：合并完成后客户端会刷新面板（一次 GET），
  // 用它当「合并已处理」的等待信号 —— 负向控制因此红在**内容/版本/请求行为**上，而不是提示文字或超时。
  let changesGets = 0;
  let blockReconcile = false;
  await page.route('**/job/changes?**', (route) => {
    const u = route.request().url();
    if (u.indexOf('saveReqIds=') >= 0) {           // 核对请求：不计入「合并完成」信号
      if (blockReconcile) return route.abort('failed');
      return route.continue();
    }
    changesGets++;
    return route.continue();
  });
  const waitMerge = async (what) => {
    const before = changesGets;
    await waitFor(async () => changesGets > before, 10000, what + '（面板刷新）');
  };

  // 捕获 JSON 保存请求：mode=hold → 服务端真的处理（route.fetch）但响应先不交给页面
  let held = null;
  const capture = (mode) => page.route('**/save?**', async (route) => {
    const ct = route.request().headers()['content-type'] || '';
    if (!ct.includes('application/json')) return route.continue();     // 普通保存放行
    if (mode === 'hold') { const resp = await route.fetch(); await resp.text(); held = { route, resp }; return; }
    if (mode === 'lose') { const resp = await route.fetch(); await resp.text(); return route.abort('failed'); }
    return route.continue();
  });
  const release = async () => {
    if (!held) return;
    await held.route.fulfill({ response: held.resp });
    held = null;
  };
  const unroute = () => page.unroute('**/save?**');

  // ===== ① 确认门接受 → 响应暂停 → 用户改目标段 → 成功响应到达 =====
  {
    resetFixture(); await reload();
    await capture('hold');
    // 走确认门：先点接受 → 出门 → 确认
    await page.click(acceptBtn('c1'));
    await page.waitForSelector('#ed-pane-review [data-change="c1"] .jp-gate', { timeout: 5000 });
    await page.click('#ed-pane-review [data-change="c1"] .jp-gate button.jp-accept');
    await waitFor(async () => !!held, 8000, 'JSON 保存请求进入在途');
    // 用户在请求在途时改目标段
    await editTarget(P1, INFLIGHT);
    await release();
    await waitMerge('成功回执到达并合并');
    const txt = await paraText(P1);
    assert.ok(txt.indexOf(INFLIGHT) >= 0, '成功回执合并覆盖了用户在途输入，实际：' + txt);
    assert.ok(txt.indexOf(AFTER) < 0, '成功回执把整段替换成了候选内容，实际：' + txt);
    await waitFor(async () => /待核对/.test(await panelText()), 10000, '面板标出待核对');
    const st = await serverState();
    assert.equal(st.job.changes.find((c) => c.id === 'c1').status, 'accepted', '服务端应已落账为 accepted');
    // 正文/状态/用户输入的一致性：手动保存后磁盘应等于用户的在途输入，状态仍是 accepted
    await page.evaluate(() => window.__edSaveManual());
    await page.waitForTimeout(1200);
    const disk = diskHtml();
    assert.ok(disk.indexOf(INFLIGHT) >= 0, '手动保存后磁盘未保住用户的在途输入');
    assert.ok(disk.indexOf(AFTER) < 0, '手动保存后磁盘又写回了候选内容');
    await unroute();
    console.log('  ✅ ① 确认门 + 在途输入 → 保留用户内容、标待核对、正文与状态一致');
  }

  // ===== ② 普通接受 / 撤回 / 批量的在途编辑 =====
  {
    resetFixture(); await reload();
    await capture('hold');
    await page.click(acceptBtn('c2'));
    await waitFor(async () => !!held, 8000, '接受请求在途');
    await editTarget(P2, INFLIGHT);
    await release();
    await waitMerge('接受回执到达并合并');
    const txt = await paraText(P2);
    assert.ok(txt.indexOf(INFLIGHT) >= 0, '接受合并覆盖了在途输入，实际：' + txt);
    assert.ok(txt.indexOf(AFTER2) < 0, '接受把候选写进了正文，实际：' + txt);
    await waitFor(async () => /待核对/.test(await panelText()), 10000, '接受后面板标出待核对');
    await unroute();
    console.log('  ✅ ②a 普通接受：在途输入保留');
  }
  {
    // 撤回：先接受（成功），再撤回（响应暂停 + 在途编辑）
    resetFixture(); await reload();
    await capture('allow');
    await page.click(acceptBtn('c2'));
    await waitFor(async () => /已接受/.test(await panelText()), 10000, '接受落账');
    await unroute();
    await capture('hold');
    await page.evaluate(() => {
      var b = Array.prototype.slice.call(document.querySelectorAll('#ed-pane-review [data-change="c2"] .jp-ops button'))
        .find((x) => (x.textContent || '').indexOf('撤回') >= 0);
      if (b) b.click();
    });
    await waitFor(async () => !!held, 8000, '撤回请求在途');
    await editTarget(P2, INFLIGHT);
    await release();
    await waitMerge('撤回回执到达并合并');
    const txt = await paraText(P2);
    assert.ok(txt.indexOf(INFLIGHT) >= 0, '撤回合并覆盖了在途输入，实际：' + txt);
    await waitFor(async () => /待核对/.test(await panelText()), 10000, '撤回后面板标出待核对');
    await unroute();
    console.log('  ✅ ②b 撤回：在途输入保留');
  }
  {
    // 批量：一个目标被改（跳过）、另一个没变（应用）
    resetFixture(); await reload();
    await capture('hold');
    await page.evaluate(() => {
      var b = Array.prototype.slice.call(document.querySelectorAll('#ed-pane-review button')).find((x) => (x.textContent || '').indexOf('批量接受') >= 0);
      if (b) b.click();
    });
    await waitFor(async () => !!held, 8000, '批量请求在途');
    await editTarget(P2, INFLIGHT);
    await release();
    await waitMerge('批量回执到达并合并');
    const t2 = await paraText(P2), t3 = await paraText(P3);
    assert.ok(t2.indexOf(INFLIGHT) >= 0, '批量合并覆盖了被改目标的在途输入，实际：' + t2);
    assert.ok(t3.indexOf(AFTER3) >= 0, '批量里未变化的目标应被应用，实际：' + t3);
    await waitFor(async () => /待核对/.test(await panelText()), 10000, '批量后面板标出待核对');
    await unroute();
    console.log('  ✅ ②c 批量：被改目标保留输入，未变目标正常应用');
  }

  // ===== ③ 先真实提交再丢响应 → 补查命中 → 基线更新 → 手动/自动保存与刷新都成立 =====
  {
    resetFixture(); await reload();
    await capture('lose');
    await page.click(acceptBtn('c2'));
    await waitFor(async () => /已落账|结果未知|无法核对/.test(await noteText()), 12000, '丢响应后的核对提示');
    await unroute();
    // 补查命中后基线必须更新（否则下一次手动保存拿旧 mtime → 409）
    const bl = await baseline();
    const st0 = await serverState();
    assert.ok(bl > 0, '补查命中后客户端基线（__edDocMtime）仍是旧值');
    assert.ok(Math.abs(bl - (st0.doc.mtime || 0)) <= 2, '补查命中后基线与磁盘 mtime 不一致：' + bl + ' vs ' + st0.doc.mtime);
    // 继续编辑 → 手动保存必须成功（不是 409）
    await editTarget(P2, INFLIGHT);
    const manual = await page.evaluate(async () => {
      var ok = await window.__edSaveManual();
      return { ok: ok === true };
    });
    assert.ok(manual.ok, '补查命中后的手动保存失败（基线未更新 → 409）');
    await page.waitForTimeout(600);
    assert.ok(diskHtml().indexOf(INFLIGHT) >= 0, '手动保存后磁盘未含用户的在途输入');
    // 自动保存：再改一次 → 等自动保存落盘
    await editTarget(P2, INFLIGHT + '2');
    await page.waitForTimeout(5000);
    assert.ok(diskHtml().indexOf(INFLIGHT + '2') >= 0, '自动保存未落盘（在途输入丢了）');
    // 刷新后内容仍在
    await reload();
    assert.ok((await paraText(P2)).indexOf(INFLIGHT + '2') >= 0, '刷新后用户的在途输入不见了');
    console.log('  ✅ ③ 补查命中 → 基线更新 → 手动/自动保存与刷新都成立');
  }

  // ===== ④ 较新保存先确认、旧回执后到 → 版本不倒退 =====
  {
    resetFixture(); await reload();
    await capture('hold');
    await page.click(acceptBtn('c2'));
    await waitFor(async () => !!held, 8000, '请求在途');
    // 期间做一次**更新的**保存（普通保存 → 磁盘与基线都前进）
    await page.evaluate(() => window.__edSaveManual());
    await page.waitForTimeout(1000);
    const newer = await baseline();
    assert.ok(newer > 0, '较新的保存没有推进基线');
    // 旧回执此刻才到（合并发生：目标未被用户改动 → 正常应用）
    await release();
    await waitFor(async () => (await paraText(P2)).indexOf(AFTER2) >= 0, 10000, '旧回执到达并合并');
    const after = await baseline();
    assert.ok(after >= newer, '旧回执把版本拉回去了：' + after + ' < ' + newer);
    const st = await serverState();
    assert.ok(Number(st.doc.mtime || 0) <= after + 2, '基线不应超过磁盘当前版本');
    console.log('  ✅ ④ 较新保存先确认、旧回执后到 → 版本不倒退');
  }

  // ===== ⑤ 撤销记录：只为实际发生的合并建立，且撤销不得吞掉在途修订 =====
  {
    // ⑤-a 被跳过的合并 → 不留撤销记录
    resetFixture(); await reload();
    await capture('hold');
    await page.click(acceptBtn('c2'));
    await waitFor(async () => !!held, 8000, '请求在途');
    await editTarget(P2, INFLIGHT);
    await release();
    await waitMerge('回执到达');
    const undoShown = await page.evaluate(() => { var b = document.getElementById('ed-undo-btn'); return !!(b && b.style.display !== 'none'); });
    assert.ok(!undoShown, '没有实际合并就不应留下撤销记录');
    await unroute();
    // ⑤-b 实际合并 → 有撤销记录；撤销只回退本次合并，另一段的在途修订仍在
    resetFixture(); await reload();
    await capture('hold');
    await page.click(acceptBtn('c2'));
    await waitFor(async () => !!held, 8000, '请求在途');
    await editTarget(P3, INFLIGHT);          // 另一段的在途修订
    await release();
    await waitMerge('回执到达并合并');
    assert.ok((await paraText(P2)).indexOf(AFTER2) >= 0, '未变化的目标应被应用');
    const undoVisible = await page.evaluate(() => { var b = document.getElementById('ed-undo-btn'); return !!(b && b.style.display !== 'none'); });
    assert.ok(undoVisible, '实际发生的合并应留下撤销记录');
    await page.evaluate(() => { var b = document.getElementById('ed-undo-btn'); if (b) b.click(); });
    await page.waitForTimeout(600);
    const t2b = await paraText(P2), t3b = await paraText(P3);
    assert.ok(t2b.indexOf(BEFORE2) >= 0, '撤销后目标段应回到原文，实际：' + t2b);
    assert.ok(t3b.indexOf(INFLIGHT) >= 0, '撤销吞掉了另一段的在途修订，实际：' + t3b);
    await unroute();
    console.log('  ✅ ⑤ 撤销记录只为实际合并建立，撤销不吞在途修订');
  }

  // ===== ⑥ 同 ID 重放：服务端把原回执原样返回（摊平形状）→ 基线照样更新 =====
  {
    resetFixture(); await reload();
    // 第一次：服务端真的落账，但响应丢掉；核对请求断网 → 状态保持「结果未知」
    blockReconcile = true;
    await capture('lose');
    await page.click(acceptBtn('c2'));
    await waitFor(async () => /结果未知|无法核对/.test(await noteText()), 12000, '丢响应后的未知状态');
    await unroute();
    blockReconcile = false;
    // 第二次：同一 requestId + 同一请求体重放 → 服务端返回原回执（字段摊平在响应顶层）
    await capture('allow');
    await page.click(acceptBtn('c2'));
    await waitMerge('重放响应到达');
    await unroute();
    const bl = await baseline();
    const st = await serverState();
    assert.ok(bl > 0, '同 ID 重放返回的回执必须更新基线（__edDocMtime 仍是旧值）');
    assert.ok(Math.abs(bl - (st.doc.mtime || 0)) <= 2, '同 ID 重放后基线与磁盘 mtime 不一致：' + bl + ' vs ' + st.doc.mtime);
    assert.ok((await paraText(P2)).indexOf(AFTER2) >= 0, '重放后改动应被合并到页面');
    console.log('  ✅ ⑥ 同 ID 重放回执 → 基线更新、合并生效');
  }

  console.log('PASS 岗位合并回归：回执合并保护在途输入 + 补查/重放回执衔接普通保存 + 版本不倒退 + 撤销记录范围');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  for (let i = 0; i < 40 && !exited; i++) await new Promise((r) => setTimeout(r, 50));
  try { server.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
