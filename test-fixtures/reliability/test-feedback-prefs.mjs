// test-feedback-prefs.mjs — A4：AI 反馈接线与偏好透明化（prefs 随生成提交 + 记忆管理 + 采纳率摘要）
// 验收口径（卡片原文，逐条进断言）：
//   ① 接线：生成请求体含 feedback=本机 prefs（现状空 body → 先红）；服务端并入 job.feedback 环形 ≤20
//      （随既有 buildJobPrompt【过往反馈】块进下次 prompt —— 桩 LLM 捕获 sys 断言）；
//   ② 「AI 记住的偏好」小节：审阅面板列出两类记忆（服务端 job.feedback 环形 + 本机 prefs），
//      可删单条、可清空；删除走新增小端点（400/404/409 守卫 + 环形重写）；无模型配置也可管理；
//   ③ 采纳率摘要：一行「上一轮 N 条建议：接受 x、拒绝 y（原因 top1…）」数字与 changes 一致；
//      拒绝集中表达类 → 「可考虑把幅度调到轻度精简」；零新存储、零 AI 调用；
//   ④ 无 prefs/无 changes → 自然为空不渲染。
// 隔离：mkdtemp 根 + 随机端口 + 合成岗位草稿 + 桩 LLM（apiKey 桩字面量沿用既有 ≥5 夹具先例，
// ECC 误报按流程旁路登记）；真实数据禁写禁删；Chromium 缺失 → exit(2)（套件惯例）。
// 先红形态：/job/feedback-del 404；生成请求体无 feedback；面板无偏好小节。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { assembleTemplate } from '../../template.mjs';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-fbprefs-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const DOC = 'doc1';       // 主夹具：有生成、有反馈
const DOC_EMPTY = 'doc2'; // 空态夹具：无 changes、无 feedback
const DOC_PLAIN = 'doc3'; // 非岗位草稿（守卫 409）
const PARA = ['项目一：负责队列服务，把延迟从 80ms 降到 12ms', '项目二：负责网关开发，支撑千万级请求', '项目三：负责数据平台，优化查询性能'];
const makeDoc = () => {
  let doc = assembleTemplate('classic');   // 模板自带 DOC_ID 脚本（/edit 完整性校验必需）
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{WORK}}', PARA.map((t, i) => `<p data-zid="z1111111${i}">${t}</p>`).join('\n')],
    ['{{PROJECTS}}', ''], ['{{EDU}}', '']]) doc = doc.replaceAll(k, () => v);
  return doc;
};
const metaPath = path.join(root, 'docs-meta.json');
const writeMeta = () => fs.writeFileSync(metaPath, JSON.stringify({
  [DOC]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位', jd: '合成 JD 要求高并发经验',
    job: { changes: [], todos: [], feedback: [], materials: [], genTasks: {} } },
  [DOC_EMPTY]: { rev: 1, flow: 'draft', kind: 'job', company: '空态公司', role: '空态岗位', jd: '空态 JD',
    job: { changes: [], todos: [], feedback: [], materials: [], genTasks: {} } },
  [DOC_PLAIN]: { rev: 1, flow: 'draft', kind: 'master' }
}, null, 2));
writeMeta();
for (const id of [DOC, DOC_EMPTY, DOC_PLAIN]) fs.writeFileSync(path.join(root, 'docs', id + '.html'), makeDoc());

// 桩 LLM：analyze（需求提取）与 changes（改写）按 sys 内容分派；捕获最后一份 sys（prompt 契约断言）
let lastSys = '';
let lastUser = '';
const OPS = {
  summary: '对齐高并发要求',
  changes: PARA.map((b, i) => ({ section: '项目经历', kind: 'replace', before: b, after: '项目' + '一二三四'[i] + '（对齐版）：' + b.slice(4), reason: '对齐 JD 高并发要求', source: '母版', level: 'normal' })),
  todos: []
};
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  let sys = '';
  try {
    const msgs = JSON.parse(body).messages || [];
    sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    lastUser = msgs.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  } catch {}
  lastSys = sys;
  const content = String(sys).includes('需求分析师')
    ? JSON.stringify({ requirements: ['高并发经验'] })
    : JSON.stringify(OPS);
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
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const base = `http://127.0.0.1:${port}`;
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const jobOf = (id) => JSON.parse(fs.readFileSync(metaPath, 'utf8'))[id].job;
const editMeta = (fn) => { const all = JSON.parse(fs.readFileSync(metaPath, 'utf8')); fn(all); fs.writeFileSync(metaPath, JSON.stringify(all, null, 2)); };
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { llm.close(); } catch {} try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务提前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ② HTTP：/job/feedback-del 守卫与环形重写 =====
  const dBad = await post('/job/feedback-del?id=' + DOC, { id: '..%2Fdoc1', index: 0 });
  assert.equal(dBad.status, 400, '非法 id 应 400：' + dBad.text.slice(0, 120));
  const dGone = await post('/job/feedback-del', { id: 'doc-none', index: 0 });
  assert.equal(dGone.status, 404, '缺文档应 404');
  const dPlain = await post('/job/feedback-del', { id: DOC_PLAIN, index: 0 });
  assert.equal(dPlain.status, 409, '非岗位草稿应 409：' + dPlain.text.slice(0, 120));
  const dBadIdx = await post('/job/feedback-del', { id: DOC, index: 0 });
  assert.equal(dBadIdx.status, 400, 'index 超界应 400（当前 0 条）：' + dBadIdx.text.slice(0, 120));
  editMeta((all) => { all[DOC].job.feedback = ['偏好甲', '偏好乙', '偏好丙']; });
  const dDel = await post('/job/feedback-del', { id: DOC, index: 1 });
  assert.equal(dDel.status, 200, '删除单条应 200：' + dDel.text.slice(0, 120));
  assert.deepEqual(JSON.parse(fs.readFileSync(metaPath, 'utf8'))[DOC].job.feedback, ['偏好甲', '偏好丙'], '环形重写应移除 index=1');
  const dClr = await post('/job/feedback-del', { id: DOC, clear: true });
  assert.equal(dClr.status, 200, '清空应 200');
  assert.deepEqual(jobOf(DOC).feedback, [], '清空后环形为空');
  console.log('✅ ② /job/feedback-del：400（非法 id/超界）/404/409 守卫 + 单删与清空的环形重写');

  // ===== ① HTTP：/job/generate 请求体 feedback 并入环形 ≤20 =====
  editMeta((all) => { all[DOC].job.feedback = Array.from({ length: 18 }, (_, i) => '旧偏好' + i); });
  const gen = await post('/job/generate?id=' + DOC, { feedback: ['新一', '新二', '新三', '新四', '新五'] });
  assert.equal(gen.status, 200, '生成应 200（桩 LLM）：' + gen.text.slice(0, 160));
  const fb = jobOf(DOC).feedback;
  assert.equal(fb.length, 20, '环形 ≤20（18+5 → 保留最近 20）');
  assert.ok(fb.includes('新五') && fb.includes('新二') && !fb.includes('旧偏好0'), '应保留最新并入项、淘汰最旧');
  assert.ok(lastUser.includes('过往反馈') && lastUser.includes('新五'), '合并后的反馈应进下次生成 prompt（桩捕获 user，job.mjs feedbackBlock 在 user）');
  console.log('✅ ① /job/generate feedback 并入环形 ≤20 且进 prompt（桩 user 捕获）');

  // ===== 浏览器段：接线（请求体）、偏好小节、采纳率摘要 =====
  let bin;
  try { bin = await (await import('../../chromium.mjs')).resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过浏览器段：' + (e && e.message || e)); cleanup(); process.exit(2); }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  const page = await ctx.newPage();
  let genBody = null;
  await page.route('**/job/generate*', async (route) => {
    try { genBody = JSON.parse(route.request().postData() || '{}'); } catch { genBody = {}; }
    await route.continue();
  });
  try {
    // 重置 doc1 反馈（上一段 HTTP 已并入旧偏好）→ 只留本机 prefs，断言请求体原样携带
    editMeta((all) => { all[DOC].job.feedback = []; });
    await page.goto(base + '/edit?id=' + DOC, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ed-pane-review .jp-head', { timeout: 15000 });
    // 先红断言形态：无偏好小节
    assert.equal(await page.$('.jp-prefs'), null, '先红：审阅面板应无偏好小节（现状未实现）');
    // 本机 prefs 走真实 UI 入口之外的最短路径：直接种 localStorage（管理 UI 的增删在下方驱动）
    await page.evaluate(() => localStorage.setItem('s4a-feedback-prefs', JSON.stringify(['多写量化结果', '不要用夸张形容词'])));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ed-pane-review .jp-head', { timeout: 15000 });
    // 生成 → 请求体应并入 prefs（先红：现状空 body）
    await page.click('#ed-pane-review .jp-head button');
    await page.waitForFunction(() => document.querySelectorAll('#ed-pane-review .jp-item').length >= 3, null, { timeout: 30000 });
    // 生成动作前先等 zid 落盘（__edZidsStart）——请求比按钮点击晚到是预期，断言必须等它真正发出
    for (let i = 0; i < 40 && !genBody; i++) await page.waitForTimeout(250);
    assert.ok(genBody && Array.isArray(genBody.feedback) && genBody.feedback.length === 2
      && genBody.feedback[0] === '多写量化结果' && genBody.feedback[1] === '不要用夸张形容词',
      '生成请求体应含 feedback=本机 prefs：' + JSON.stringify(genBody));
    let tail = [];
    const mergeDeadline = Date.now() + 8000;
    while (Date.now() < mergeDeadline) {
      tail = jobOf(DOC).feedback;
      if (tail.length >= 2 && tail.includes('多写量化结果')) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.deepEqual(tail.slice(-2), ['多写量化结果', '不要用夸张形容词'], '浏览器路径的 prefs 应并入服务端环形');
    console.log('✅ ① 生成请求体含 feedback=prefs 且服务端并入环形（浏览器路径，route 捕获）');

    // ===== ② 偏好小节：两来源列表 + 删除/清空 =====
    await page.waitForSelector('.jp-prefs', { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll('.jp-prefs [data-src="server"]').length >= 2, null, { timeout: 15000 });
    const secText = await page.$eval('.jp-prefs', (e) => e.textContent);
    assert.ok(secText.includes('AI 记住的偏好') && secText.includes('随文档保存') && secText.includes('本机'), '小节应列出两类记忆：' + secText.slice(0, 160));
    const serverRows = await page.$$eval('.jp-prefs .jp-prefrow [data-src="server"]', (els) => els.length);
    assert.ok(serverRows >= 2, '服务端组应列出环形条目（实测 ' + serverRows + '）');
    // 删本机单条
    await page.click('.jp-prefs .jp-prefrow [data-src="local"][data-index="0"]');
    await page.waitForFunction(() => {
      try { return JSON.parse(localStorage.getItem('s4a-feedback-prefs') || '[]').length === 1; } catch { return false; }
    }, null, { timeout: 5000 });
    // 删服务端单条
    const beforeDel = jobOf(DOC).feedback.length;
    await page.click('.jp-prefs .jp-prefrow [data-src="server"][data-index="0"]');
    await page.waitForFunction((n) => document.querySelectorAll('.jp-prefs .jp-prefrow [data-src="server"]').length === n, beforeDel - 1, { timeout: 5000 });
    assert.equal(jobOf(DOC).feedback.length, beforeDel - 1, '服务端单删应使环形减一');
    // 清空本机
    await page.click('.jp-prefs .jp-prefclear[data-src="local"]');
    await page.waitForFunction(() => {
      try { return (JSON.parse(localStorage.getItem('s4a-feedback-prefs') || '[]') || []).length === 0; } catch { return false; }
    }, null, { timeout: 5000 });
    console.log('✅ ② 偏好小节两来源渲染 + 单删（本机/服务端）与清空生效（管理不依赖生成）');

    // ===== ③ 采纳率摘要：数字与 changes 一致 + 表达类提示 =====
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const allCh = meta[DOC].job.changes;
    const maxGen = allCh.reduce(function (m, c) { return Math.max(m, c.gen || 0); }, 0);
    const chs = allCh.filter((c) => (c.gen || 0) === maxGen);   // 上一轮 = 最大轮次（HTTP 段的 gen=1 已被浏览器生成取代）
    assert.ok(chs.length >= 3, '应有三条本轮建议（实测 ' + chs.length + '）');
    const st = await post('/job/changes?id=' + DOC, { updates: [
      { id: chs[0].id, status: 'accepted' },
      { id: chs[1].id, status: 'rejected', note: '不符合我的表达' },
      { id: chs[2].id, status: 'rejected', note: '改变原意' }
    ] });
    if (st.status !== 200 || !st.json || !st.json.ok) fail('updates 提交失败：' + st.status + ' ' + st.text.slice(0, 200));
    const stCheck = JSON.parse((await (await fetch(base + '/job/changes?id=' + DOC)).text())).job;
    assert.equal(stCheck.changes.filter((c) => c.status === 'accepted').length, 1, 'updates 应落账：accepted=1');
    assert.equal(stCheck.changes.filter((c) => c.status === 'rejected').length, 2, 'updates 应落账：rejected=2');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ed-pane-review .jp-adopt', { timeout: 10000 });
    const adopt = await page.$eval('.jp-adopt', (e) => e.textContent);
    assert.ok(/上一轮 3 条建议：接受 1、拒绝 2/.test(adopt), '摘要行数字应与 changes 一致：' + adopt);
    assert.ok(/原因 top1/.test(adopt), '摘要应含拒绝原因 top1：' + adopt);
    assert.ok(/可考虑把幅度调到轻度精简/.test(adopt), '拒绝集中表达类应提示轻度精简：' + adopt);
    console.log('✅ ③ 采纳率摘要行（接受 1/拒绝 2/原因 top1）+ 表达类集中提示轻度精简');

    // ===== ④ 空态：无 prefs/无 changes → 不渲染 =====
    await page.goto(base + '/edit?id=' + DOC_EMPTY, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ed-pane-review', { timeout: 15000 });
    // 空草稿默认落在「要求与证据」段（job-panel.js:1129：无 changes → evidence）→ 点「修改清单」到 changes 视图
    await page.click('#ed-pane-review button:has-text("修改清单")');
    await page.waitForSelector('#ed-pane-review .jp-head', { timeout: 15000 });
    assert.equal(await page.$('.jp-prefs'), null, '无 prefs/无 feedback → 不渲染偏好小节');
    assert.equal(await page.$('.jp-adopt'), null, '无 changes → 不渲染采纳率摘要');
    console.log('✅ ④ 无 prefs/无 changes → 自然为空不渲染');
    console.log('✅ A4 test-feedback-prefs：接线/环形/小节管理/摘要/空态 全部通过');
  } finally {
    await browser.close().catch(() => {});
  }
} catch (e) {
  cleanup();
  fail(String((e && e.stack) || e));
}
cleanup();
