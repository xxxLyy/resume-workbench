// test-gen-retry-ui.mjs — P3 批次重试面板 UI：批次进度可见（第 x/y 批 / 重试第 x/y 批）+「重试该批」按钮行为
// 断言全靠内容与行为（纪律：不靠提示文字颜色/超时假装）：
//   ① 失败批在 done 态显示「第 N 批未完成：<原因>」与「重试该批」按钮；
//   ② 点击重试 → running 态进度行含「重试第 x/y 批」（来自 batches.retrying）与时长 ticker（data-gen-elapsed）；
//   ③ 重试成功 → 按钮消失（failed 清空）、重试批的候选内容出现在修改清单；
//   ④ 全程零百分比（诚实进度纪律）。
// 浏览器类夹具：隔离根 + 合成岗位草稿（带 zones）+ 本机桩 LLM（响应队列按批应答）；零真实模型。
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

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-genrui-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const DOC = 'doc1';
const ZW1 = 'zaaaaaa01', ZW2 = 'zaaaaaa02', ZP1 = 'zaaaaaa03', ZP2 = 'zaaaaaa04', ZP3 = 'zaaaaaa05', ZP4 = 'zaaaaaa06';
const PARA_W1 = '负责交易系统，把延迟从 80ms 降到 12ms';
const PARA_W2 = '负责订单中台，支撑日订单十二万';
const PARA_P1 = '项目甲：网关压测平台，覆盖三十万 QPS';
const PARA_P2 = '项目乙：链路追踪系统，覆盖全链路';
const PARA_P3 = '项目丙：灰度发布工具';
const PARA_P4 = '项目丁：监控告警面板';
// 文档用真实模板骨架（编辑器注入依赖模板结构）；工作/项目占位换成带 zid 的合成段落
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{WORK}}', () => `<p data-zid="${ZW1}">${PARA_W1}</p><p data-zid="${ZW2}">${PARA_W2}</p>`);
doc = doc.replace('{{PROJECTS}}', () => `<p data-zid="${ZP1}">${PARA_P1}</p><p data-zid="${ZP2}">${PARA_P2}</p><p data-zid="${ZP3}">${PARA_P3}</p><p data-zid="${ZP4}">${PARA_P4}</p>`);
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    jd: '要求：交易系统与订单经验；网关与链路追踪经验；灰度发布与监控告警经验',
    zones: { [ZW1]: { zone: 'work' }, [ZW2]: { zone: 'work' }, [ZP1]: { zone: 'project' }, [ZP2]: { zone: 'project' }, [ZP3]: { zone: 'project' }, [ZP4]: { zone: 'project' } },
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {}, reviewPos: { section: 'changes', changeId: null, filter: 'all' } } }
}, null, 2));

// —— 桩 LLM：analyze 固定可定位要求；rewrite 按响应队列应答（空队列=默认成功批 0）——
const REQS_FULL = ['交易系统与订单经验', '网关与链路追踪经验', '灰度发布与监控告警经验'];
const OPS_B0 = { summary: '工作段对齐交易系统', changes: [{ section: '工作经历', kind: 'replace', zid: ZW1, before: PARA_W1, after: '负责交易系统与网关优化，把延迟从 80ms 降到 12ms', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [{ section: '工作经历', question: '缺少团队规模数据', why: 'JD 要求带团队经验' }] };
const OPS_B1 = { summary: '项目段对齐网关与追踪', changes: [{ section: '项目经历', kind: 'replace', zid: ZP1, before: PARA_P1, after: '项目甲：网关压测平台，覆盖三十万 QPS 与突发流量', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [] };
const OPS_B2 = { summary: '监控段补充', changes: [{ section: '项目经历', kind: 'replace', zid: ZP4, before: PARA_P4, after: '项目丁：监控告警面板与值班升级', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [] };
const BROKEN = '抱歉，这不是修改操作 JSON。';
const okResp = (obj, extra = {}) => ({ content: JSON.stringify(obj), ...extra });
const brokenResp = (extra = {}) => ({ content: BROKEN, ...extra });
let responses = [];
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let sys = '';
    try { sys = JSON.parse(b).messages.find((m) => m.role === 'system').content; } catch {}
    const ok = (content, usage, delayMs = 0) => {
      const body = { choices: [{ message: { content } }] };
      if (usage) body.usage = usage;
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }, delayMs);
    };
    if (String(sys).includes('需求分析师')) return ok(JSON.stringify({ requirements: REQS_FULL }), { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 });
    if (String(sys).includes('简历定制编排器')) {
      const r = responses.length ? responses.shift() : okResp(OPS_B0);
      return ok(r.content, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, r.delayMs || 0);
    }
    return ok('{}', null);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model-ui' }]
}));

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
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { stub.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
const base = `http://127.0.0.1:${port}`;
const genStart = async () => (await fetch(base + '/job/gen-start?id=' + DOC + '&kind=changes', { method: 'POST' })).json();
async function waitTerminalHttp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await (await fetch(base + '/job/changes?id=' + DOC)).json();
    const t = v.job.genTasks.changes;
    if (t && t.status !== 'running') return t;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail('任务 20s 未结束\n' + serverLog.slice(-600));
}

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }
  // 原始运行：批 0/1 成功、批 2 失败（延迟批 2 响应供 running 进度可见）
  responses = [okResp(OPS_B0), okResp(OPS_B1), brokenResp({ delayMs: 1500 })];
  await genStart();
  // 运行中加载页面：changes 任务的批次进度行（第 x/y 批）应随面板渲染可见
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过批次重试 UI 回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage();
  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('#ed-pane-review', { timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('#ed-pane-review') || {}).textContent !== '加载中…', null, { timeout: 15000 });
  const panelHas = (needle) => page.evaluate((n) => (document.querySelector('#ed-pane-review') || {}).textContent.includes(n), needle);
  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(150); }
    const dbg = await page.evaluate(() => (document.querySelector('#ed-pane-review') || {}).textContent || '');
    let srv = '';
    try { srv = JSON.stringify((await (await fetch(base + '/job/changes?id=' + DOC)).json()).job.genTasks.changes).slice(0, 900); } catch {}
    fail('等待超时：' + what + '\n[面板] ' + dbg.slice(-700) + '\n[服务端] ' + srv);
  };

  // ① 原始运行进行中：批次进度行可见（第 1/3 批 或后续批，含「/3 批」计数 + 时长 ticker 节点）
  await waitFor(() => panelHas('/3 批'), 8000, 'running 批次进度（第 x/3 批）');
  assert.ok(await page.$('#ed-pane-review [data-gen-elapsed]'), '进度行应带 ticker 时长节点');
  assert.ok(!await panelHas('%'), '不得出现百分比');
  // ② 原始运行结束：批 2 失败 → 失败批行与「重试该批」按钮可见
  await waitTerminalHttp();
  await waitFor(() => panelHas('重试该批'), 10000, '失败批重试按钮（面板轮询刷新后）');
  assert.ok(await panelHas('第 3 批未完成'), '失败批行应含批次号与原因区');
  // ③ 点击重试：running 态显示「重试第 3/3 批」（retrying 数据源）
  responses = [okResp(OPS_B2, { delayMs: 1500 })];
  await page.click('#ed-pane-review button:has-text("重试该批")');
  await waitFor(() => panelHas('重试第 3/3 批'), 10000, '重试中进度行（重试第 3/3 批）');
  const t1 = await page.$eval('#ed-pane-review [data-gen-elapsed]', (el) => el.textContent);
  await page.waitForTimeout(2100);
  const t2 = await page.$eval('#ed-pane-review [data-gen-elapsed]', (el) => el.textContent);
  assert.notEqual(t1, t2, `重试时长应随 ticker 递增（「${t1}」→「${t2}」）`);
  // ④ 重试成功：重试批候选内容出现在清单（等待须容忍 running 相位——running 期间本就不渲染重试按钮），
  //    落账完成后按钮消失（failed 清空）。注意 toast「正在重试第 3 批…」含「重试第」字样，不能作为判定条件。
  await waitFor(() => panelHas('项目丁：监控告警面板与值班升级'), 20000, '重试批候选应出现在修改清单');
  await waitFor(async () => !(await panelHas('重试该批')), 15000, '重试成功后按钮消失（failed 清空）');
  assert.ok(await panelHas('正在重试第 3 批'), '重试启动提示应可见');
  assert.ok(!await panelHas('%'), '全程零百分比');

  console.log('✅ 批次重试 UI：失败批行+重试按钮、重试中「重试第 x/y 批」进度与 ticker、成功后按钮消失且候选可见、零百分比');
} finally {
  try { if (browser) await browser.close(); } catch {}
  cleanup();
}
