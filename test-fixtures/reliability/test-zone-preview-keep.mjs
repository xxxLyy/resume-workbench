// test-zone-preview-keep.mjs — render() 重绘不得清空已生成的改写候选（BL-P3-06，low）
// 背景：render() 用 root.innerHTML = html 整覆面板根，#zp-preview 容器与其中的候选卡片、
// 「接受」按钮一并被毁；renderAi() 随后只能新建空容器；而 analyze() 成功后必调 load() → render()
// → 点「重新分析」或任何刷新（ed-zone-refresh）都会让候选凭空消失，JS 变量 preview 却仍保留
// 旧候选（界面与状态不一致）（总账 BL-P3-06）。
// 场景（总账复现口径）：假 LLM 对同一区域返回 2 条候选 → 生成改写（出现「接受（2 段）」）
// → 点「重新分析」→ 候选与接受按钮必须原样还在；再补一发 ed-zone-refresh（外壳切 Tab 同通道）。
// 断言靠内容变红（接受按钮在、候选文本在），不靠超时/提示文字。
// 约束：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档 + 本机假 LLM；不碰 7766、不读真实简历。
// 挂载：浏览器类 → test.sh 文件末尾追加段（本文件不自带挂载，由提交员统一处理）。
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
import { normalizeZids } from '../../zone.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-zpk-'));
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
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), normalizeZids(doc));
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    zones: { [P1]: { zone: 'project', status: 'confirmed' }, [P2]: { zone: 'project', status: 'confirmed' }, [P3]: { zone: 'work', status: 'confirmed' } },
    job: { evidence: [], changes: [], todos: [], feedback: [], materials: [], genTasks: {} }
  }
}, null, 2));

// 假 LLM：改写器对 prompt 里的每个 free 段返回一条候选（数字全保留，避免事实护栏判 conflict）；
// 分析器返回固定意见（成功路径 → 服务端轮次自增 + 客户端 load() → render() 重绘 = 缺陷触发点）
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  let content = '{}';
  try {
    const msgs = JSON.stringify(JSON.parse(body).messages || []);
    if (msgs.indexOf('区域改写器') >= 0) {
      const cands = [];
      if (msgs.indexOf('(' + P1 + ')') >= 0) cands.push({ zid: P1, candidate: '项目一：负责消息队列服务，把延迟从 80ms 降到 12ms' });
      if (msgs.indexOf('(' + P2 + ')') >= 0) cands.push({ zid: P2, candidate: '项目二：负责限流组件与缓存预热，支撑双十一峰值流量' });
      content = JSON.stringify({ rewrites: cands });
    } else if (msgs.indexOf('区域分析顾问') >= 0) {
      content = JSON.stringify({ echoes: [], reminder: '提醒', suggestion: '建议', chips: [] });
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
// 收尾钩子：fail 走 process.exit 也不留孤儿服务、不留临时根
process.on('exit', () => {
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
const base = `http://127.0.0.1:${port}`;
const previewText = (page) => page.evaluate(() => ((document.getElementById('zp-preview') || {}).textContent || ''));
const previewState = (page) => page.evaluate(() => ({
  accept: (document.getElementById('zp-accept') || {}).textContent || null,
  text: ((document.getElementById('zp-preview') || {}).textContent || '')
}));
const aiHead = (page) => page.evaluate(() => ((document.getElementById('zp-ai') || {}).firstChild || {}).textContent || '');

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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过区域候选保留回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();

  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P1 + '"]', { timeout: 15000 });
  await page.evaluate(() => { if (window.__edSelectTab) window.__edSelectTab('zone'); });
  await page.waitForSelector('#zp-root', { state: 'attached', timeout: 15000 });
  await page.waitForSelector('.zp-row[data-zone="project"]', { state: 'attached', timeout: 15000 });
  await page.evaluate(() => { var r = document.querySelector('.zp-row[data-zone="project"]'); if (r) r.click(); });   // 开 project 区 AI 卡
  await page.waitForSelector('#zp-rewrite', { state: 'attached', timeout: 15000 });

  // 生成 2 条候选（点行后的自动 analyze 期间按钮 disabled，等它收尾再交互，时序确定）
  await page.waitForFunction(() => {
    var b = document.getElementById('zp-rewrite');
    var out = document.getElementById('zp-ai-out');
    return b && !b.disabled && out && out.textContent !== '分析中…';
  }, null, { timeout: 20000 });
  await page.evaluate(() => {
    var ta = document.getElementById('zp-instr');
    if (ta) { ta.value = '更精简'; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    var btn = document.getElementById('zp-rewrite');
    if (btn) btn.click();
  });
  try { await page.waitForSelector('#zp-accept', { state: 'attached', timeout: 20000 }); }
  catch (e) { fail('改写候选未生成：预览区=' + (await previewText(page)).slice(-200) + ' 服务日志=' + serverLog.slice(-300)); }
  const before = await previewState(page);
  assert.ok(before.accept && before.accept.indexOf('2 段') >= 0, '夹具前置失败：应有「接受（2 段）」，实际：' + JSON.stringify(before).slice(0, 200));
  assert.ok(before.text.indexOf('负责消息队列服务') >= 0, '夹具前置失败：候选卡缺失，实际：' + before.text.slice(0, 200));

  // 缺陷触发点：点「重新分析」→ analyze 成功 → load() → render() 整覆重绘
  await page.evaluate(() => { var b = document.getElementById('zp-analyze'); if (b) b.click(); });
  // 完成信号：服务端轮次自增 + load() 重绘后，AI 卡头出现「（第 2 轮）」（首轮无后缀）
  try { await page.waitForFunction(() => (((document.getElementById('zp-ai') || {}).firstChild || {}).textContent || '').indexOf('第 2 轮') >= 0, null, { timeout: 20000 }); }
  catch (e) { fail('重新分析未完成（AI 卡头未进第 2 轮）：' + (await aiHead(page)) + ' 服务日志=' + serverLog.slice(-300)); }
  await page.waitForTimeout(400);   // 排空 load() 重绘与 showAnalysis 收尾

  // 断言：候选卡片与「接受（2 段）」按钮必须在重绘后原样保留
  const after = await previewState(page);
  assert.ok(after.accept !== null, '「重新分析」后接受按钮被销毁（#zp-preview 被整覆清空），重绘后预览区：' + JSON.stringify(after.text).slice(0, 200));
  assert.ok(after.accept.indexOf('2 段') >= 0, '「重新分析」后接受按钮文案变化，实际：' + after.accept);
  assert.ok(after.text.indexOf('负责消息队列服务') >= 0, '「重新分析」后候选卡片内容丢失，实际：' + after.text.slice(0, 200));

  // 再补一发刷新通道（外壳切 Tab 走 ed-zone-refresh → load → render，同一条整覆路径）
  await page.evaluate(() => window.dispatchEvent(new Event('ed-zone-refresh')));
  await page.waitForTimeout(600);
  const after2 = await previewState(page);
  assert.ok(after2.accept !== null && after2.accept.indexOf('2 段') >= 0, 'ed-zone-refresh 刷新后接受按钮丢失，实际：' + JSON.stringify(after2.text).slice(0, 200));
  assert.ok(after2.text.indexOf('负责限流组件') >= 0, 'ed-zone-refresh 刷新后候选卡内容丢失，实际：' + after2.text.slice(0, 200));

  console.log('PASS 区域候选保留：重新分析与 ed-zone-refresh 重绘后，「接受（2 段）」与候选卡片原样保留');
  process.exitCode = 0;
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
