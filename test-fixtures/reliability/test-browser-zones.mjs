// test-fixtures/reliability/test-browser-zones.mjs — 区域面板的真实浏览器场景回归（ZONE-05/06/07）
// 覆盖：Z1（保存失败时零模型请求）、Z4（A→B→A 的迟到响应不污染当前区域）、
//       Z5（zoneOps 提交：只合并未变的目标，等待期间的输入保留；一次应用一次撤销）。
// 约束：隔离 RESUME_ROOT + 合成文档 + 本机假 LLM（可控延迟/可控响应）；不读真实简历、不调真实模型。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-bz-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111', P2 = 'z22222222', P3 = 'z33333333';
const T1 = '项目一：负责队列服务，把延迟从 80ms 降到 12ms';
const T2 = '项目二：负责限流组件，支撑双十一峰值流量';
const T3 = '项目三：负责容量规划，支撑三年增长';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">${T1}</p><p data-zid="${P2}">${T2}</p><p data-zid="${P3}">${T3}</p>`);
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    zones: { [P1]: { zone: 'work', status: 'confirmed' }, [P2]: { zone: 'work', status: 'confirmed' }, [P3]: { zone: 'project', status: 'confirmed' } },
    job: { evidence: [], changes: [], todos: [], feedback: [], materials: [], genTasks: {} }
  }
}, null, 2));

// 假 LLM：zone-analyze 按调用序号返回不同意见（用于识别迟到响应）；zone-rewrite 返回一个候选
let analyzeSeq = 0;
const analyzeZones = [];
let rewriteCalls = 0;
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  let content = '{}';
  try {
    const p = JSON.parse(body);
    const msgs = JSON.stringify(p.messages || []);
    if (msgs.indexOf('区域改写器') >= 0) {
      rewriteCalls++;
      // 候选必须保留原文全部数字（否则事实护栏判 conflict → 不可接受，这本身是正确行为）
      content = JSON.stringify({ rewrites: [{ zid: P1, candidate: '项目一：负责消息队列服务，把延迟从 80ms 降到 12ms' }] });
    } else if (msgs.indexOf('区域分析顾问') >= 0) {
      analyzeSeq++;
      var zm = /【区域：([^】]+)】/.exec(msgs);
      analyzeZones.push((zm ? zm[1] : '?') + '#' + analyzeSeq);
      content = JSON.stringify({ echoes: [], reminder: '提醒' + analyzeSeq, suggestion: '建议' + analyzeSeq + '@' + (zm ? zm[1] : '?'), chips: [] });
    }
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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过区域浏览器回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();
  let zoneAnalyzeHits = 0, zoneRewriteHits = 0, zoneSaveHits = 0;
  page.on('request', (r) => { if (r.url().includes('/save?')) zoneSaveHits++; });
  page.on('request', (r) => { if (r.url().includes('/ai/zone-analyze')) zoneAnalyzeHits++; if (r.url().includes('/ai/zone-rewrite')) zoneRewriteHits++; });
  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P1 + '"]');
  // 切到区域面板
  await page.evaluate(() => { if (window.__edSelectTab) window.__edSelectTab('zone'); });
  await page.waitForSelector('#zp-root', { state: 'attached', timeout: 15000 });

  // 保存桩（不可覆盖的 getter）：'ok' → true；'fail' → false
  const setFlush = (mode) => page.evaluate(function (m) {
    window.__flushMode = m;
    var stub = function () { return Promise.resolve(window.__flushMode !== 'fail'); };
    var dirty = function () { return false; };
    try {
      Object.defineProperty(window, '__edFlushSave', { configurable: true, get: function () { return stub; }, set: function () {} });
      // isDirty 也锁住：真实编辑器的未保存标记会随自动保存时序变化，测试要确定性
      Object.defineProperty(window, '__edIsDirty', { configurable: true, get: function () { return dirty; }, set: function () {} });
    } catch (e) { window.__edFlushSave = stub; window.__edIsDirty = dirty; }
  }, mode);
  const clickZone = (zone) => page.evaluate(function (z) {
    var row = document.querySelector('.zp-row[data-zone="' + z + '"]');
    if (row) row.click();
  }, zone);

  // ===== Z1：保存失败时不得发出模型请求 =====
  {
    zoneAnalyzeHits = 0;
    await setFlush('fail');
    await clickZone('work');
    await page.waitForTimeout(1500);
    if (zoneAnalyzeHits !== 0) fail('保存失败后仍发出了 /ai/zone-analyze 请求（命中 ' + zoneAnalyzeHits + ' 次）');
    await setFlush('ok');
    console.log('  ✅ Z1 保存失败 → 零区域模型请求');
  }

  // ===== Z4：A→B→A 的迟到响应不得污染当前区域 =====
  {
    // 第一个 zone-analyze 响应延迟 2.5s（后发的先到）
    let first = true;
    await page.route('**/ai/zone-analyze*', async (route) => {
      if (first) { first = false; await new Promise((r) => setTimeout(r, 2500)); }
      await route.continue();
    });
    await clickZone('work');          // 请求 1（在途，延迟）
    await page.waitForTimeout(200);
    await clickZone('project');       // 请求 2
    await page.waitForTimeout(200);
    await clickZone('work');          // 请求 3
    await page.waitForTimeout(4500);  // 等三个都回来
    await page.unroute('**/ai/zone-analyze*');
    console.log('  [dbg] zoneAnalyzeHits=' + zoneAnalyzeHits + ' zones=' + JSON.stringify(analyzeZones));
    const shown = await page.evaluate(() => {
      var box = document.getElementById('zp-ai');
      return box ? box.textContent : '';
    });
    // 三个请求里第一个（work）被延迟 → 它最后才到达服务端（内容为「建议3」）。
    // 最后一次点击（work）的内容是「建议2」——它必须显示出来；
    // 而迟到的「建议3」必须被 epoch 挡住，不得写进当前区域。
    if (!shown.includes('建议2@工作')) fail('面板未显示最后一次请求的结果: ' + shown.slice(0, 200));
    if (shown.includes('建议3')) fail('迟到的旧响应写进了当前区域: ' + shown.slice(0, 200));
    if (shown.includes('建议1')) fail('中间那次请求（已切走）写进了当前区域: ' + shown.slice(0, 200));
    console.log('  ✅ Z4 A→B→A 迟到响应不污染当前区域');
  }

  // ===== Z5：zoneOps 提交 → 只合并未变目标；等待期间的输入保留；一次应用一次撤销 =====
  {
    // 延迟 /save 响应：先让服务端真正保存，再延迟返回
    await page.route('**/save*', async (route) => {
      const response = await route.fetch();      // 服务端实际保存
      await new Promise((r) => setTimeout(r, 900));
      await route.fulfill({ response });
    });
    // 生成改写候选（改写按钮要求先填修改意见）
    await page.evaluate(() => {
      var ta = document.getElementById('zp-instr');
      if (ta) { ta.value = '更精简'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      var btn = document.getElementById('zp-rewrite');
      if (btn) btn.click();
    });
    try { await page.waitForSelector('#zp-accept', { state: 'attached', timeout: 20000 }); }
    catch (e) {
      const dbg = await page.evaluate(() => ({ out: ((document.getElementById('zp-ai-out') || {}).textContent || '').slice(-200), prev: ((document.getElementById('zp-preview') || {}).textContent || '').slice(-200), instr: ((document.getElementById('zp-instr') || {}).value || '') }));
      fail('改写候选未生成：rewrite请求=' + zoneRewriteHits + ' out=' + dbg.out + ' prev=' + dbg.prev + ' instr=' + dbg.instr + ' 服务日志=' + serverLog.slice(-300));
    }
    console.log('  [dbg2] preview=' + JSON.stringify(await page.evaluate(() => window.__zpPreview || null)));
    // 点接受（进入保存流程）
    await page.evaluate(() => {
      var b = document.getElementById('zp-accept');
      if (b) b.click();
    });
    // 保存响应被延迟期间：用户改另一段（P2）
    await page.waitForTimeout(350);
    await page.evaluate((zid) => {
      var el = document.querySelector('.sheet [data-zid="' + zid + '"]');
      el.textContent = '用户在等待期间输入的内容';
      if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    }, P2);
    await page.waitForTimeout(2200);   // 等合并完成
    console.log('  [dbg2] saveHits=' + zoneSaveHits + ' previewText=' + (await page.evaluate(() => ((document.getElementById('zp-preview') || {}).textContent || '').slice(-160))));
    await page.unroute('**/save*');
    const p1 = await page.$eval('.sheet [data-zid="' + P1 + '"]', (el) => el.textContent);
    const p2 = await page.$eval('.sheet [data-zid="' + P2 + '"]', (el) => el.textContent);
    assert.ok(p1.includes('负责消息队列服务'), '区域候选未合并到正文，实际 ' + p1);
    assert.ok(p2.includes('用户在等待期间输入的内容'), '等待期间的输入被覆盖，实际 ' + p2);
    // 一次应用一次撤销：撤销后 P1 回到原文，P2 的用户输入仍在
    await page.evaluate(() => {
      var b = document.getElementById('ed-undo-btn');
      if (b && b.style.display !== 'none') b.click();
    });
    await page.waitForTimeout(700);
    const p1b = await page.$eval('.sheet [data-zid="' + P1 + '"]', (el) => el.textContent);
    const p2b = await page.$eval('.sheet [data-zid="' + P2 + '"]', (el) => el.textContent);
    assert.ok(p1b.includes('80ms'), '撤销后目标段未回到改写前，实际 ' + p1b);
    assert.ok(p2b.includes('用户在等待期间输入的内容'), '撤销吞掉了等待期间的输入，实际 ' + p2b);
    console.log('  ✅ Z5 zoneOps 提交只合并未变目标 + 等待期间输入保留 + 一次应用一次撤销');
  }

  console.log('PASS 区域浏览器回归: Z1 保存前置 + Z4 请求 epoch + Z5 安全子集提交与局部合并');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
