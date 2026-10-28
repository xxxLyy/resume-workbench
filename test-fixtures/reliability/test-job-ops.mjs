// test-fixtures/reliability/test-job-ops.mjs — 岗位操作的失败语义、幂等语义与正文一致性（真实浏览器）
// 覆盖：
//   ① 明确拒绝（409）→ 精确还原、状态不变
//   ② 网络异常 → 结果未知 → 核对服务端回执后判「未落账」
//   ③ 核对请求断网 → 保持未知（不得用缓存当提交证据、不得清除待重试身份）
//   ④ 先真实提交、再丢响应 → 核对命中回执 → 判定已落账 → 改动应用到页面
//   ⑤ 真实自动保存不得把「未落账的候选」写进磁盘（正文与操作状态一致）
//   ⑥ 接受 → 撤回 → 再次接受 的完整循环（每次新身份、状态与正文同步）
//   ⑦ add / hide / reorder / 批量 各自有分支证据（不靠共用 inv 函数代替）
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
const P1 = 'z11111111';          // 项目段（replace 目标）
const P2 = 'z66666666';          // 项目段（add 的容器锚点）
const EH = 'z22222222';          // 条目头（hide 目标）
const EL = 'z33333333';          // 条目里的段落
const EH2 = 'z44444444';         // 第二个条目头（reorder 用）
const BEFORE = '项目一：原始内容';
const AFTER = '项目一：改写后的内容';
const ADDED = '新增段落：补充说明';

let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">${BEFORE}</p><p data-zid="${P2}">项目二：另一个段落</p>`);
doc = doc.replace('{{WORK}}', () => `
<div class="entry-head" data-zid="${EH}"><div class="entry-title">合成公司</div><div class="entry-role">工程师</div></div>
<ul><li data-zid="${EL}">工作段一：负责交易系统</li></ul>
<div class="entry-head" data-zid="${EH2}"><div class="entry-title">另一家公司</div><div class="entry-role">负责人</div></div>
<ul><li data-zid="z55555555">工作段二：负责风控</li></ul>`);
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);

const metaPath = path.join(root, 'docs-meta.json');
const CHANGES = [
  { id: 'c1', kind: 'replace', zid: P1, before: BEFORE, after: AFTER, note: '改写建议', status: 'pending', level: 'normal' },
  { id: 'c2', kind: 'add', zid: P2, section: '项目经历', before: '', after: ADDED, note: '补充建议', status: 'pending', level: 'normal' },
  { id: 'c3', kind: 'hide', zid: EH, section: '工作经历', entry: '合成公司', before: '合成公司', after: '', note: '隐藏建议', status: 'pending', level: 'normal' },
  { id: 'c4', kind: 'reorder', zid: EH2, section: '工作经历', entry: '另一家公司', to: 'top', before: '', after: '', note: '排序建议', status: 'pending', level: 'normal' }
];
const writeMeta = () => {
  const changes = CHANGES.map((c) => Object.assign({}, c, { status: 'pending' }));
  fs.writeFileSync(metaPath, JSON.stringify({
    [DOC]: {
      rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
      zones: { [P1]: { zone: 'project', status: 'confirmed' }, [P2]: { zone: 'project', status: 'confirmed' }, [EH]: { zone: 'work', status: 'confirmed' }, [EL]: { zone: 'work', status: 'confirmed' }, [EH2]: { zone: 'work', status: 'confirmed' } },
      job: { changes, evidence: [], materials: [], todos: [], feedback: [], genTasks: {} }
    }
  }, null, 2));
};
writeMeta();

// 夹具复位：正文 + 候选状态一起回到初始（磁盘上的正文会被上一场景改过）
const resetFixture = () => {
  fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
  writeMeta();
};

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
  const reload = async () => {
    await page.goto(base + '/edit?id=' + DOC);
    await page.waitForSelector('#ed-pane-review [data-change="c1"] button.jp-accept', { timeout: 15000 });
  };
  const acceptBtn = (id) => '#ed-pane-review [data-change="' + id + '"] button.jp-accept';
  const saveBodies = [];      // 岗位操作的 JSON 保存请求体
  const trackSaves = (mode) => page.route('**/save?**', async (route) => {
    const ct = route.request().headers()['content-type'] || '';
    if (!ct.includes('application/json')) return route.continue();   // 普通保存（自动/手动）放行
    saveBodies.push(JSON.parse(route.request().postData()));
    if (mode === 'reject409') {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, conflict: true, error: '注入：文档已被其他窗口更新' }) });
    }
    if (mode === 'abort') return route.abort('failed');
    if (mode === 'commit-then-lose') {          // 服务端真的落账，但响应在客户端这里丢掉
      const resp = await route.fetch();
      await resp.text();
      return route.abort('failed');
    }
    return route.continue();
  });
  const untrackSaves = () => page.unroute('**/save?**');

  // ===== ① 明确拒绝（409）→ 精确还原 + 状态不变 =====
  {
    await reload();
    saveBodies.length = 0;
    await trackSaves('reject409');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /注入/.test(await noteText()), 8000, '409 提示');
    await untrackSaves();
    const txt = await paraText(P1);
    assert.ok(txt.includes(BEFORE), '409 后正文应回到原文，实际：' + txt);
    assert.ok(!txt.includes(AFTER), '409 后正文不得留着候选，实际：' + txt);
    const st = await serverState();
    assert.equal(st.job.changes.find((c) => c.id === 'c1').status, 'pending', '409 不得改变候选状态');
    assert.equal(saveBodies.length, 1, '409 场景应恰有一次 JSON 保存');
    console.log('  ✅ ① 明确拒绝（409）→ 精确还原、状态不变');
  }

  // ===== ② 网络异常 → 结果未知 → 核对回执后判「未落账」 =====
  {
    await reload();
    saveBodies.length = 0;
    await trackSaves('abort');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /未落账|结果未知|无法核对/.test(await noteText()), 10000, '网络异常提示');
    await untrackSaves();
    const txt = await paraText(P1);
    assert.ok(txt.includes(BEFORE) && !txt.includes(AFTER), '未落账时正文不得留着候选，实际：' + txt);
    const st = await serverState();
    assert.equal(st.job.changes.find((c) => c.id === 'c1').status, 'pending', '未落账时候选状态应仍是 pending');
    console.log('  ✅ ② 网络异常 → 核对后判未落账、正文无候选');
  }

  // ===== ③ 核对请求断网 → 保持未知（不得用缓存当提交证据、不得清除待重试身份）=====
  {
    await reload();
    saveBodies.length = 0;
    await page.route('**/job/changes?**', async (route) => {
      if (route.request().url().indexOf('saveReqIds=') >= 0) return route.abort('failed');
      return route.continue();
    });
    await trackSaves('abort');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /无法核对|结果未知/.test(await noteText()), 10000, '核对失败提示');
    await untrackSaves();
    await page.unroute('**/job/changes?**');
    const note = await noteText();
    assert.ok(!/未落账/.test(note), '核对失败时不得断言「未落账」，实际提示：' + note.slice(-160));
    assert.ok(/无法核对|结果未知/.test(note), '核对失败必须说明仍是未知，实际提示：' + note.slice(-160));
    // 待重试身份不得被清掉：再点一次接受 → 复用同一 requestId
    const firstId = saveBodies[0] && saveBodies[0].requestId;
    await trackSaves('abort');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => saveBodies.length >= 2, 8000, '重试请求');
    await untrackSaves();
    assert.equal(saveBodies[1].requestId, firstId, '同一逻辑提交的重试必须复用同一 requestId');
    console.log('  ✅ ③ 核对断网 → 保持未知、待重试身份未清');
  }

  // ===== ③-b 核对请求被拒（500）→ 保持未知 =====
  {
    await reload();
    saveBodies.length = 0;
    await page.route('**/job/changes?**', async (route) => {
      if (route.request().url().indexOf('saveReqIds=') >= 0) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"注入：核对被拒"}' });
      }
      return route.continue();
    });
    await trackSaves('abort');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /无法核对|结果未知/.test(await noteText()), 10000, '核对被拒提示');
    await untrackSaves();
    await page.unroute('**/job/changes?**');
    const note = await noteText();
    assert.ok(!/未落账/.test(note), '核对被拒时不得断言「未落账」，实际：' + note.slice(-160));
    console.log('  ✅ ③-b 核对被拒 → 保持未知');
  }

  // ===== ③-c 回执已被环形表淘汰（无回执 + 磁盘版本已变）→ 保持未知，不猜 =====
  {
    await reload();
    saveBodies.length = 0;
    await page.route('**/job/changes?**', async (route) => {
      if (route.request().url().indexOf('saveReqIds=') >= 0) {
        const resp = await route.fetch();
        const body = await resp.json().catch(() => null);
        if (body && body.job && body.job.saveReceipts) {
          body.job.saveReceipts.found = {};        // 回执查不到（像被环形表淘汰）
          body.rev = Number(body.rev || 0) + 7;     // 磁盘版本已变 → 无法判定「肯定没落账」
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
      return route.continue();
    });
    await trackSaves('abort');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /无法确认|结果未知|无法核对/.test(await noteText()), 10000, '回执缺失提示');
    await untrackSaves();
    await page.unroute('**/job/changes?**');
    const note = await noteText();
    assert.ok(!/未落账/.test(note), '回执查不到时不得断言「未落账」，实际：' + note.slice(-160));
    console.log('  ✅ ③-c 回执缺失 + 磁盘已变 → 保持未知');
  }

  // ===== ④ 先真实提交、再丢响应 → 核对命中回执 → 判定已落账 → 改动应用到页面 =====
  {
    await reload();
    saveBodies.length = 0;
    await trackSaves('commit-then-lose');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /已落账/.test(await noteText()), 12000, '核对命中回执');
    await untrackSaves();
    const txt = await paraText(P1);
    assert.ok(txt.includes(AFTER), '已落账后页面应显示改写后的内容，实际：' + txt);
    const st = await serverState();
    const c1 = st.job.changes.find((c) => c.id === 'c1');
    assert.equal(c1.status, 'accepted', '服务端应已落账为 accepted，实际：' + JSON.stringify(c1));
    assert.ok(diskHtml().includes(AFTER), '磁盘应含改写后的内容');
    console.log('  ✅ ④ 先真实提交再丢响应 → 核对命中回执 → 判定已落账');
  }

  // ===== ⑤ 真实自动保存不得把「未落账的候选」写进磁盘 =====
  {
    resetFixture();
    await reload();
    saveBodies.length = 0;
    await trackSaves('abort');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /未落账|结果未知|无法核对/.test(await noteText()), 10000, '落账结果提示');
    await untrackSaves();
    // 用户继续输入 → 文档变脏 → 真实自动保存（3s 后）会写盘
    await page.evaluate((zid) => {
      var el = document.querySelector('.sheet [data-zid="' + zid + '"]');
      el.textContent = el.textContent + '（用户后续输入）';
      if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    }, P1);
    await page.waitForTimeout(5000);   // 等自动保存（模板：最后一次输入后 3s）
    const disk = diskHtml();
    assert.ok(!disk.includes(AFTER), '自动保存把未落账的候选写进了磁盘，实际正文含候选');
    assert.ok(disk.includes('（用户后续输入）'), '自动保存应保住用户的在途输入');
    const st = await serverState();
    assert.equal(st.job.changes.find((c) => c.id === 'c1').status, 'pending', '未落账的候选状态不得变 accepted');
    console.log('  ✅ ⑤ 真实自动保存不带走未落账候选，且保住在途输入');
  }

  // ===== ⑥ 接受 → 撤回 → 再次接受 的完整循环 =====
  {
    resetFixture();
    await reload();
    saveBodies.length = 0;
    await trackSaves('allow');
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /已接受/.test(await panelText()), 10000, '接受落账');
    // 撤回
    await page.evaluate(() => {
      var b = Array.prototype.slice.call(document.querySelectorAll('#ed-pane-review [data-change="c1"] .jp-ops button'))
        .find((x) => (x.textContent || '').indexOf('撤回') >= 0);
      if (b) b.click();
    });
    await waitFor(async () => /待处理/.test(await panelText()), 10000, '撤回落账');
    // 再次接受
    await page.click(acceptBtn('c1'));
    await waitFor(async () => /已接受/.test(await panelText()), 10000, '再次接受落账');
    await untrackSaves();
    assert.ok(saveBodies.length >= 3, '循环里应至少三次 JSON 保存，实际 ' + saveBodies.length);
    const ids = saveBodies.map((b) => b.requestId);
    assert.equal(new Set(ids).size, ids.length, '三个逻辑操作必须各有身份，实际：' + JSON.stringify(ids));
    const txt = await paraText(P1);
    assert.ok(txt.includes(AFTER), '循环后正文应是改写后的内容，实际：' + txt);
    const st = await serverState();
    assert.equal(st.job.changes.find((c) => c.id === 'c1').status, 'accepted', '循环后状态应为 accepted');
    console.log('  ✅ ⑥ 接受→撤回→再次接受：三个身份、状态与正文同步');
  }

  // ===== ⑦ add / hide / reorder / 批量 各自的分支证据 =====
  {
    await resetFixture(); await reload();
    saveBodies.length = 0;
    await trackSaves('reject409');
    await page.click(acceptBtn('c2'));
    await waitFor(async () => /注入/.test(await noteText()), 8000, 'add 失败提示');
    await untrackSaves();
    const body = await page.evaluate(() => document.querySelector('.sheet').textContent);
    assert.ok(!body.includes(ADDED), 'add 失败后正文不得留着新增段落');
    const st = await serverState();
    assert.equal(st.job.changes.find((c) => c.id === 'c2').status, 'pending', 'add 失败后状态应 pending');
    console.log('  ✅ ⑦a add：失败后不留下新增段落');
  }
  {
    await resetFixture(); await reload();
    await trackSaves('reject409');
    await page.click(acceptBtn('c3'));
    await waitFor(async () => /注入/.test(await noteText()), 8000, 'hide 失败提示');
    await untrackSaves();
    const hiddenCount = await page.evaluate(() => document.querySelectorAll('.sheet .ed-entry-hidden').length);
    assert.equal(hiddenCount, 0, 'hide 失败后条目不得被隐藏');
    console.log('  ✅ ⑦b hide：失败后条目保持可见');
  }
  {
    await resetFixture(); await reload();
    const orderBefore = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll('.sheet .entry-head')).map((e) => e.getAttribute('data-zid')));
    await trackSaves('reject409');
    await page.click(acceptBtn('c4'));
    await waitFor(async () => /注入/.test(await noteText()), 8000, 'reorder 失败提示');
    await untrackSaves();
    const orderAfter = await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll('.sheet .entry-head')).map((e) => e.getAttribute('data-zid')));
    assert.deepEqual(orderAfter, orderBefore, 'reorder 失败后顺序不得变');
    console.log('  ✅ ⑦c reorder：失败后顺序不变');
  }
  {
    await resetFixture(); await reload();
    await trackSaves('reject409');
    await page.evaluate(() => {
      var b = Array.prototype.slice.call(document.querySelectorAll('#ed-pane-review button')).find((x) => (x.textContent || '').indexOf('批量接受') >= 0);
      if (b) b.click();
    });
    await waitFor(async () => /注入/.test(await noteText()), 8000, '批量失败提示');
    await untrackSaves();
    const body = await page.evaluate(() => document.querySelector('.sheet').textContent);
    assert.ok(!body.includes(AFTER), '批量失败后正文不得留着改写候选');
    assert.ok(!body.includes(ADDED), '批量失败后正文不得留着新增段落');
    console.log('  ✅ ⑦d 批量：失败后两条都不留在正文');
  }

  console.log('PASS 岗位操作回归：409 还原 / 网络异常未知 / 核对断网保持未知 / 先提交后丢响应 / 自动保存不带候选 / 三段循环 / add·hide·reorder·批量分支');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
