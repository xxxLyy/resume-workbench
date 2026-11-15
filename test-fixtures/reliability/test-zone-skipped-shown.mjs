// test-zone-skipped-shown.mjs — 区域改写的 skipped 明细必须逐条可见（BL-P3-04，medium）
// 背景：服务端为「因锁定/改绑/事实冲突被跳过」的候选专门返回 skipped 明细（生成侧
// /ai/zone-rewrite → skipped:[zid…]（只因锁定跳过，server.mjs:4166/4183）；应用侧 /save 回执 →
// skipped:[{operationId,zid,reason}]（zone-ops.mjs:61，reason ∈ gone/changed/rebound/locked/conflict）），
// 客户端此前只消费 rewrites/applied → 「接受（2 段）」变「已应用 1 段」而无任何原因（总账 BL-P3-04）。
// 两个用例（内容断言，不靠提示文字/超时）：
//   A 生成侧：P2 先上锁 → 生成改写（桩模型只对 free 段返回候选）→ 面板须出现「跳过：P2 段文本（锁定）」；
//   B 应用侧：P1+P2 都 free 时生成 2 条候选 → 「接受（2 段）」前把 P1 上锁 → 接受后面板须
//     同时出现「已应用 1 段」与「跳过：P1 段文本（锁定）」。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-zss-'));
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
// P1/P2 同属 project 区（两段都能出候选）；P3 归 work 不参与
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    zones: { [P1]: { zone: 'project', status: 'confirmed' }, [P2]: { zone: 'project', status: 'confirmed' }, [P3]: { zone: 'work', status: 'confirmed' } },
    job: { evidence: [], changes: [], todos: [], feedback: [], materials: [], genTasks: {} }
  }
}, null, 2));

// 假 LLM：改写器对 prompt 里出现的每个 free 段返回一条候选（数字全保留，避免事实护栏判 conflict）
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
const setLocks = async (locks) => {
  const r = await fetch(base + '/zones?id=' + DOC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zones: {
      [P1]: { zone: 'project', status: 'confirmed', ...(locks[P1] ? { locked: true } : {}) },
      [P2]: { zone: 'project', status: 'confirmed', ...(locks[P2] ? { locked: true } : {}) },
      [P3]: { zone: 'work', status: 'confirmed' }
    } })
  });
  assert.equal(r.status, 200, '外部写 zones 失败');
};
const serverZones = async () => (await (await fetch(base + '/job/changes?id=' + DOC)).json()).zones || {};
const untilServer = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  fail('等待超时：' + what);
};
const untilPage = async (page, fn, what, ms = 12000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await page.waitForTimeout(150); }
  fail('等待超时：' + what + '（预览区：' + (await previewText(page)).slice(-260) + ' 服务日志=' + serverLog.slice(-300) + '）');
};
const previewText = (page) => page.evaluate(() => ((document.getElementById('zp-preview') || {}).textContent || ''));
const dbgPage = async (page) => JSON.stringify(await page.evaluate(() => ({
  aiBoxes: document.querySelectorAll('#zp-ai').length,
  instrs: document.querySelectorAll('#zp-instr').length,
  rewrites: document.querySelectorAll('#zp-rewrite').length,
  previews: document.querySelectorAll('#zp-preview').length,
  out: ((document.getElementById('zp-ai-out') || {}).textContent || '').slice(-160),
  instr: ((document.getElementById('zp-instr') || {}).value || ''),
  prev: ((document.getElementById('zp-preview') || {}).textContent || '').slice(-160),
  rewriteDisabled: (document.getElementById('zp-rewrite') || {}).disabled,
  mtime: Number(window.__edDocMtime || 0)
})));
let rewriteHits = 0, rewriteLastResp = '';
const generate = async (page, instr) => {
  // 点行后的自动 analyze 期间「生成改写」是 disabled（setBusy），el.click() 会静默无效；
  // 等 analyze 收尾（按钮可用且分析区不再是「分析中…」）再填意见、点生成，时序确定。
  await page.waitForFunction(() => {
    var b = document.getElementById('zp-rewrite');
    var out = document.getElementById('zp-ai-out');
    return b && !b.disabled && out && out.textContent !== '分析中…';
  }, null, { timeout: 20000 });
  await page.evaluate((v) => {
    var ta = document.getElementById('zp-instr');
    if (ta) { ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true })); }
    var btn = document.getElementById('zp-rewrite');
    if (btn) btn.click();
  }, instr);
  try { await page.waitForSelector('#zp-accept', { state: 'attached', timeout: 20000 }); }
  catch (e) { fail('改写候选未生成（rewrite请求=' + rewriteHits + ' 最后响应=' + rewriteLastResp.slice(0, 160) + '）页面状态=' + await dbgPage(page) + ' 服务日志=' + serverLog.slice(-400)); }
};

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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过区域 skipped 可见性回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror] ' + (e && e.message)));
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/ai/') || u.includes('/save?')) console.log('  [req] ' + r.method() + ' ' + u.replace(base, ''));
  });
  page.on('response', async (r) => {
    if (r.url().includes('/ai/zone-rewrite')) { rewriteHits++; try { rewriteLastResp = await r.text(); } catch {} }
  });

  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P1 + '"]', { timeout: 15000 });
  await page.evaluate(() => { if (window.__edSelectTab) window.__edSelectTab('zone'); });
  await page.waitForSelector('#zp-root', { state: 'attached', timeout: 15000 });
  await page.waitForSelector('.zp-row[data-zone="project"]', { state: 'attached', timeout: 15000 });
  await page.evaluate(() => { var r = document.querySelector('.zp-row[data-zone="project"]'); if (r) r.click(); });   // 开 project 区 AI 卡
  await page.waitForSelector('#zp-rewrite', { state: 'attached', timeout: 15000 });

  // ===== 用例 A：生成侧 skipped —— P2 先上锁，候选只可能覆盖 P1，面板须逐条显示跳过原因 =====
  {
    await setLocks({ [P2]: true });
    await untilServer(async () => (await serverZones())[P2]?.locked === true, 'P2 上锁落盘');
    await generate(page, '更精简');
    const t = await previewText(page);
    assert.ok(t.includes('跳过：'), '生成侧 skipped 明细被丢弃，预览区无任何「跳过」说明，实际：' + t.slice(0, 200));
    assert.ok(t.includes('负责限流组件'), '生成侧跳过行未带被跳过段落的文本，实际：' + t.slice(0, 200));
    assert.ok(t.includes('锁定'), '生成侧跳过原因（锁定）未显示，实际：' + t.slice(0, 200));
    assert.ok(t.includes('负责消息队列服务'), 'free 段候选卡丢失，实际：' + t.slice(0, 200));
    console.log('  ✅ A 生成侧：锁定段在「生成改写」响应中逐条显示「跳过：某段（锁定）」');
  }

  // ===== 用例 B：应用侧 receipt.skipped —— 「接受（2 段）」前锁 P1，接受后须报「已应用 1 段」+ 逐条跳过 =====
  {
    await setLocks({});                                            // 解锁，回到两段都 free
    await untilServer(async () => !(await serverZones())[P2]?.locked && !(await serverZones())[P1]?.locked, '解锁落盘');
    await generate(page, '更精简');
    const accText = await page.$eval('#zp-accept', (el) => el.textContent);
    assert.ok(accText.includes('2 段'), '桩模型应返回 2 条候选，实际按钮：' + accText);
    await setLocks({ [P1]: true });                                // 生成与应用之间锁上 P1（meta 变化，不动正文）
    await untilServer(async () => (await serverZones())[P1]?.locked === true, 'P1 上锁落盘');
    await page.evaluate(() => { var b = document.getElementById('zp-accept'); if (b) b.click(); });
    await untilPage(page, async () => {
      const t = await previewText(page);
      return t.includes('已应用 1 段') && t.includes('跳过：');
    }, '接受后回执合并（已应用 1 段 + 跳过明细）');
    const t = await previewText(page);
    assert.ok(t.includes('已应用 1 段'), '应用计数丢失，实际：' + t.slice(-240));
    assert.ok(t.includes('负责队列服务'), '应用侧跳过行未带被跳过段落的文本，实际：' + t.slice(-240));
    assert.ok(t.includes('锁定'), '应用侧跳过原因（锁定）未显示，实际：' + t.slice(-240));
    console.log('  ✅ B 应用侧：接受后「已应用 1 段」与「跳过：某段（锁定）」同屏可见');
  }

  console.log('PASS 区域改写 skipped 可见性：生成侧 skipped:[zid] 与应用侧 receipt.skipped:[{zid,reason}] 都逐条显示「跳过：某段（原因）」');
  process.exitCode = 0;
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
