// test-shell-review-fixes.mjs — R1 修复验证：编辑器壳条目菜单 hidden 态 + 审阅面板空态死翻页钮
// 背景（审计 R1）：
//   ① editor-shell.js 的 .ed-nav-menu{display:flex} 压过 UA 对 [hidden] 的 display:none——
//      条目「⋯」菜单 hidden=true 仍渲染（约 112px 宽的小浮面盖在左栏上），页面加载即见。
//   ② job-panel.js 审阅面板 footer 无条件渲染「‹ 上一条 / 下一条 ›」，changes 为空也渲染（死钮）。
// 合同：
//   ① 补 .ed-nav-menu[hidden]{display:none}；开合逻辑（renderNav 的 menu.hidden 驱动）零改动——
//      因此本夹具同时验证「点 ⋯ 可开、Esc 可关」（语义不变，防过度修复）。
//   ② changes 为空时不渲染两枚翻页钮；主行动流转（接受/去核对/去导出检查）不动——
//      因此本夹具同时验证「空态仍有主行动钮」「非空态两枚翻页钮仍在」（防过度隐藏）。
// 断言以内容/行为优先（不靠提示文字或超时）：hidden 态 computed display=none 且可见矩形 0。
// 约束：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档；不读真实简历、不碰 7766、不调真实模型。
// 退出码契约：0=全部通过；1=任一断言失败；2=仅 Chromium 环境不可用且此前无失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.mjs';
import { assembleTemplate } from './template.mjs';

const APP_ROOT = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-shell-review-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC_A = 'doca';   // 空建议岗位草稿（含两条经历条目 → 导航里有 .ed-nav-menu）
const DOC_B = 'docb';   // 一条待处理建议的岗位草稿（翻页钮存在性的阳性对照）
const EH1 = 'za1b2c3d4', EH2 = 'ze5f6a7b8';
const WORK_ENTRIES =
  `<div class="entry-head" data-zid="${EH1}"><div class="entry-title">甲公司</div><div class="entry-role">后端工程师</div></div>` +
  `<ul><li>负责合成模块开发</li></ul>` +
  `<div class="entry-head" data-zid="${EH2}"><div class="entry-title">乙公司</div><div class="entry-role">平台工程师</div></div>` +
  `<ul><li>负责合成平台维护</li></ul>`;
const BEFORE = '负责合成模块开发';
const AFTER = '负责合成模块的性能优化';

const buildDoc = (docId, work) => {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', docId]]) doc = doc.replaceAll(k, () => v);
  return doc.replace('{{WORK}}', () => work);
};

const emptyJob = { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} };
const withChangeJob = {
  changes: [{ id: 'c1', kind: 'replace', before: BEFORE, after: AFTER, section: '工作经历',
    reason: '合成建议', status: 'pending', level: 'normal', gen: 1 }],
  evidence: [], materials: [], todos: [], feedback: [], genTasks: {}
};
fs.writeFileSync(path.join(root, 'docs', DOC_A + '.html'), buildDoc(DOC_A, WORK_ENTRIES));
fs.writeFileSync(path.join(root, 'docs', DOC_B + '.html'), buildDoc(DOC_B, WORK_ENTRIES));
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC_A]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位', job: emptyJob },
  [DOC_B]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位', job: withChangeJob }
}, null, 2));

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

  const menuState = () => page.evaluate(() => {
    const menus = Array.from(document.querySelectorAll('.ed-nav-menu'));
    return menus.map((m) => {
      const r = m.getBoundingClientRect();
      return { hidden: m.hidden, display: getComputedStyle(m).display, w: r.width, h: r.height };
    });
  });

  // ===== ① 条目菜单 hidden 态：页面加载即断言（审计口径：加载即见 = 缺陷现场）=====
  await page.goto(base + '/edit?id=' + DOC_A);
  await page.waitForSelector('.sheet [data-zid="' + EH1 + '"]', { timeout: 15000 });
  await page.waitForSelector('.ed-nav-menu', { state: 'attached', timeout: 15000 });
  const loadState = await menuState();
  assert.ok(loadState.length >= 1, '导航应已生成条目菜单（.ed-nav-menu），实际数量：' + loadState.length);
  for (const [i, m] of loadState.entries()) {
    assert.equal(m.hidden, true, `菜单 ${i} 加载时应为 hidden 态`);
    assert.equal(m.display, 'none', `菜单 ${i} hidden 态 computed display 应为 none（修复合同①），实际：${m.display}`);
    assert.equal(m.w, 0, `菜单 ${i} hidden 态可见宽度应为 0，实际：${m.w}`);
    assert.equal(m.h, 0, `菜单 ${i} hidden 态可见高度应为 0，实际：${m.h}`);
  }

  // ===== ① 开合行为语义不变：⋯ 可开、Esc 可关（menu.hidden 驱动逻辑零改动的行为证据）=====
  await page.click('.ed-nav-entry .ed-nav-more');
  const openState = await menuState();
  const opened = openState.find((m) => !m.hidden);
  assert.ok(opened, '点击 ⋯ 后应有菜单转开（hidden=false）');
  assert.notEqual(opened.display, 'none', '打开的菜单 computed display 不得为 none');
  assert.ok(opened.w > 0 && opened.h > 0, '打开的菜单应有可见矩形，实际：' + JSON.stringify(opened));
  await page.keyboard.press('Escape');
  const reclosed = await menuState();
  assert.ok(reclosed.every((m) => m.hidden && m.display === 'none' && m.w === 0 && m.h === 0),
    'Esc 关闭后所有菜单应回到 hidden 态（display none / 矩形 0），实际：' + JSON.stringify(reclosed));

  // ===== ② 审阅面板空态：无翻页钮，主行动仍在 =====
  await page.waitForSelector('#jp-root .jp-secs button[data-sec="changes"]', { timeout: 15000 });
  await page.click('#jp-root .jp-secs button[data-sec="changes"]');
  await page.waitForSelector('#jp-root .jp-foot', { timeout: 15000 });
  const footEmpty = await page.evaluate(() => {
    const foot = document.querySelector('#jp-root .jp-foot');
    const texts = Array.from(foot.querySelectorAll('button')).map((b) => b.textContent);
    return { texts, primary: texts.filter((t) => /去导出检查|接受|去核对/.test(t)) };
  });
  assert.equal(footEmpty.texts.filter((t) => t === '‹ 上一条' || t === '下一条 ›').length, 0,
    'changes 为空时 footer 不得渲染翻页钮（修复合同②），实际按钮：' + JSON.stringify(footEmpty.texts));
  assert.equal(footEmpty.primary.length, 1,
    '空态主行动应恰好一枚（去导出检查 →），实际：' + JSON.stringify(footEmpty.primary));

  // ===== ② 阳性对照：有建议时两枚翻页钮仍在（防过度隐藏；交互语义不变）=====
  await page.goto(base + '/edit?id=' + DOC_B);
  await page.waitForSelector('#jp-root .jp-secs button[data-sec="changes"]', { timeout: 15000 });
  await page.click('#jp-root .jp-secs button[data-sec="changes"]');
  await page.waitForSelector('#jp-root .jp-foot', { timeout: 15000 });
  const footNonEmpty = await page.evaluate(() => {
    const foot = document.querySelector('#jp-root .jp-foot');
    return Array.from(foot.querySelectorAll('button')).map((b) => {
      const r = b.getBoundingClientRect();
      return { t: b.textContent, hidden: b.hidden, w: r.width, h: r.height };
    });
  });
  for (const label of ['‹ 上一条', '下一条 ›']) {
    const b = footNonEmpty.find((x) => x.t === label);
    assert.ok(b, '有建议时翻页钮应存在：' + label + '，实际按钮：' + JSON.stringify(footNonEmpty.map((x) => x.t)));
    assert.equal(b.hidden, false, '有建议时「' + label + '」不得处于 hidden 态');
    assert.ok(b.w > 0 && b.h > 0, '有建议时「' + label + '」应可见，实际：' + JSON.stringify(b));
  }
  assert.deepEqual(pageErrors, [], '不得有页面异常：' + JSON.stringify(pageErrors));

  console.log('✅ R1 修复验证：hidden 菜单 display=none/矩形 0、⋯开-Esc关语义不变；空态无翻页钮且有主行动、非空态翻页钮仍在；无页面异常');
} catch (e) {
  console.error('❌ ' + (e && e.message || e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  cleanup();
}
