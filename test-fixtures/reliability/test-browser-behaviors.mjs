// test-fixtures/reliability/test-browser-behaviors.mjs — 编辑器/AI/岗位的真实浏览器行为回归
// 覆盖：AUD-02（保存失败不发磁盘型 AI 请求）、AUD-04（撤销不误伤别处且只消费一次）、
//       AUD-03（跨标签旧页提交不覆盖他人改动）。
// 约束：隔离 RESUME_ROOT + 合成文档 + 本机假 LLM；不读真实简历、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-bb-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111', P2 = 'z22222222', P3 = 'z33333333';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () =>
  `<p data-zid="${P1}">ORIGINAL-TARGET</p><p data-zid="${P2}">别的内容</p><p data-zid="${P3}">OTHER-OLD</p>`);
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    job: {
      changes: [{ id: 'c1', kind: 'replace', zid: P3, before: 'OTHER-OLD', after: 'OTHER-NEW', note: '测试建议', status: 'pending', level: 'normal' }],
      evidence: [], materials: [], todos: [], feedback: [], genTasks: {}
    }
  }
}, null, 2));

// 本机假 LLM：/ai/chat 返回一条改写建议（模型改写输出契约 = JSON 数组）
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  let content = '[]';
  try {
    const p = JSON.parse(body);
    if (p && p.messages) content = JSON.stringify([{ note: '测试建议', before: 'ORIGINAL-TARGET', after: 'EXISTING-AFTER' }]);
  } catch {}
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }]
}));

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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过浏览器行为回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });   // 撤销确认门
  const page = await ctx.newPage();
  let aiChatHits = 0;
  page.on('request', (r) => { if (r.url().includes('/ai/chat')) aiChatHits++; });
  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P1 + '"]');
  await page.waitForSelector('#ai-msg', { state: 'attached', timeout: 15000 });

  // 保存桩：文档自带模板脚本会覆盖 window.__edFlushSave → 用不可覆盖的 getter 锁定。
  // __flushMode = 'ok' → 钩子返回 true；'fail' → 返回 false（AUD-02 的失败场景）。
  await page.evaluate(() => {
    window.__flushMode = 'ok';
    var stub = function () { return Promise.resolve(window.__flushMode !== 'fail'); };
    try {
      Object.defineProperty(window, '__edFlushSave', { configurable: true, get: function () { return stub; }, set: function () {} });
    } catch (e) { window.__edFlushSave = stub; }
  });
  const send = async (msg) => {
    await page.evaluate(function (m) {
      var el = document.getElementById('ai-msg');
      el.value = m;
      document.getElementById('ai-send').click();
    }, msg);
  };
  const waitCard = async () => {
    for (let i = 0; i < 60; i++) {
      if (await page.$('.ai-change button')) return;
      await page.waitForTimeout(250);
    }
    const dbg = await page.evaluate(() => ({
      log: ((document.getElementById('ai-log') || {}).textContent || '').slice(-260)
    }));
    fail('AI 卡片未渲染：' + dbg.log);
  };

  // ===== AUD-02：保存失败（钩子返回 false）不得产生磁盘型 AI 请求 =====
  {
    aiChatHits = 0;
    await page.evaluate(() => { window.__flushMode = 'fail'; });
    await send('测试保存失败时的行为');
    await page.waitForTimeout(1500);
    if (aiChatHits !== 0) fail('保存失败后仍发出了 /ai/chat 请求（命中 ' + aiChatHits + ' 次）');
    await page.evaluate(() => { window.__flushMode = 'ok'; });
    console.log('  ✅ AUD-02 保存失败 → 零 AI 请求');
  }

  // ===== AUD-15：AI 写请求失败 → 用户输入保留、给出失败提示、不显示假成功 =====
  {
    await page.route('**/ai/chat*', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '注入的失败' })
    }));
    await page.evaluate(() => {
      var el = document.getElementById('ai-msg');
      el.value = '这条输入不应因为失败而丢失';
      document.getElementById('ai-send').click();
    });
    await page.waitForTimeout(1500);
    const kept = await page.evaluate(() => (document.getElementById('ai-msg') || {}).value || '');
    if (kept.indexOf('这条输入不应因为失败而丢失') < 0) fail('AI 写请求失败后用户输入被清空（应保留）');
    const panel = await page.evaluate(() => (document.getElementById('ai-log') || {}).textContent || '');
    assert.ok(/注入的失败/.test(panel), '失败原因应可见，实际：' + panel.slice(-160));
    assert.ok(!/AI 没有给出修改/.test(panel), '失败不得被显示成「AI 没有给出修改」这类假成功/假失败文案');
    await page.unroute('**/ai/chat*');
    console.log('  ✅ AUD-15 AI 写失败 → 保留输入 + 失败可见');
  }

  // ===== AUD-04：卡片撤销不得改到另一段，且只消费一次 =====
  {
    await send('测试保存失败时的行为');
    await waitCard();
    // 应用（卡片第一个按钮就是「应用」）
    await page.evaluate(() => {
      var btns = document.querySelectorAll('.ai-change button');
      for (var i = 0; i < btns.length; i++) { if ((btns[i].textContent || '').indexOf('应用') === 0) { btns[i].click(); return; } }
    });
    await page.waitForTimeout(400);
    const afterApply = await page.$eval('.sheet [data-zid="' + P1 + '"]', (el) => el.textContent);
    if (!afterApply.includes('EXISTING-AFTER')) fail('AI 改写未应用，实际 ' + afterApply);
    // 制造「另一段含相同文本」+「目标被手改」
    await page.evaluate((ids) => {
      var sheet = document.querySelector('.sheet');
      sheet.querySelector('[data-zid="' + ids.p2 + '"]').textContent = 'EXISTING-AFTER';
      sheet.querySelector('[data-zid="' + ids.p1 + '"]').textContent = 'USER-EDIT';
      if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    }, { p1: P1, p2: P2 });
    // 点卡片上的「撤销」（有确认门 → dialog 自动接受）
    const clicked = await page.evaluate(() => {
      var btns = document.querySelectorAll('.ai-change button');
      for (var i = 0; i < btns.length; i++) { if ((btns[i].textContent || '').indexOf('撤销') >= 0) { btns[i].click(); return true; } }
      return false;
    });
    if (!clicked) fail('未找到卡片上的撤销按钮');
    await page.waitForTimeout(700);
    const p1Text = await page.$eval('.sheet [data-zid="' + P1 + '"]', (el) => el.textContent);
    const p2Text = await page.$eval('.sheet [data-zid="' + P2 + '"]', (el) => el.textContent);
    if (p2Text.includes('ORIGINAL-TARGET')) fail('撤销改到了另一段（P2 变成原文）——按全文反向搜索了');
    if (!p1Text.includes('ORIGINAL-TARGET')) fail('撤销后目标段未回到应用前，实际 ' + p1Text);
    const stillUndoable = await page.evaluate(() => {
      var b = document.getElementById('ed-undo-btn');
      return !!(b && b.style.display !== 'none' && /区域改写|AI/.test(b.textContent || ''));
    });
    if (stillUndoable) fail('卡片撤销后工具条仍保留该操作（重复记账）');
    console.log('  ✅ AUD-04 撤销绑定目标且只消费一次');
  }

  // ===== AUD-03：另一标签页改动后，旧页提交不得覆盖它 =====
  {
    const page2 = await ctx.newPage();
    await page2.goto(base + '/edit?id=' + DOC);
    await page2.waitForSelector('.sheet [data-zid="' + P3 + '"]');
    await page2.evaluate((zid) => {
      var el = document.querySelector('.sheet [data-zid="' + zid + '"]');
      el.textContent = 'OTHER-NEW';
      if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    }, P3);
    await page2.evaluate(() => window.__edSaveManual());
    await page2.waitForTimeout(900);
    const diskP3 = fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8');
    if (!diskP3.includes('OTHER-NEW')) fail('另一页的修改未落盘（前置条件不成立）');
    // 旧页用「自己已确认的版本」提交 → 服务端必须拒绝，不得覆盖 P3
    const res = await page.evaluate(async () => {
      const d = await fetch('/job/changes?id=' + window.__edDocId).then((r) => r.json());
      const r = await fetch('/save?id=' + window.__edDocId, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // 新前端用【自己已确认的版本】（window.__edDocMtime），不取服务器最新值
          requestId: 'stale-' + Date.now(), baseRev: d.rev, baseMtime: Number(window.__edDocMtime || 0),
          html: window.__edBuildSaveHtml(), ops: []
        })
      }).then((x) => x.json().catch(() => ({})));
      return r;
    });
    const diskP3After = fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8');
    if (!diskP3After.includes('OTHER-NEW')) fail('旧页提交覆盖了另一标签页的修改（P3 丢失）');
    if (diskP3After.includes('OTHER-OLD')) fail('磁盘正文回退到旧内容');
    if (res && res.ok) fail('旧页提交被服务端接受（应为 409：正文已被其他窗口更新）');
    await page2.close();
    console.log('  ✅ AUD-03 旧页提交不覆盖他人改动');
  }

  console.log('PASS 浏览器行为回归: AUD-02 保存失败零请求 + AUD-04 撤销绑定且只消费一次 + AUD-03 跨标签不覆盖');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
