// test-fixtures/reliability/test-inline-delegation.mjs — b5c1 内联 handler 委托化回归
// 覆盖两件事：
//   ① 结构断言：全站应用页（page() 八路由）零内联事件属性（on*="…"）——
//      51 处 onclick/onchange/oninput/onsubmit/onkeydown 全部改为 data-action + data-* 委托；
//   ② 行为抽检：委托监听真实生效——click / change / input / submit / keydown(Enter)
//      五类事件各抽查真实交互（点击/提交 → 发出既有请求或状态变化），行为与委托化前一致。
// 约束：隔离 RESUME_ROOT + 随机端口 + 合成数据；不读真实简历、不调真实模型。
// 退出码契约：0 通过 / 1 断言失败 / 2 仅 Chromium 不可用（同 test-browser-behaviors）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// —— 合成数据（长数字第二位避开 3-9：投递 id '11075'、快照 ts '2026-10-20-101010' 均不含 ≥11 位连续数字）——
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-deleg-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const mkDoc = (id) => '<!doctype html><html><head><meta charset="utf-8"><style>.s{color:#111}</style></head>'
  + '<body><h1>夹具</h1><div class="sheet"><p>正文</p></div><script>var DOC_ID = \'' + id + '\';</script></body></html>';
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), mkDoc('d1'));
fs.writeFileSync(path.join(root, 'docs', 'd2.html'), mkDoc('d2'));   // 仅用于首页「删除」表单的点击靶（删掉也不影响 d1 组断言）
fs.mkdirSync(path.join(root, 'snapshots', 'd1'), { recursive: true });
fs.writeFileSync(path.join(root, 'snapshots', 'd1', '2026-10-20-101010.html'), mkDoc('d1'));
fs.writeFileSync(path.join(root, 'pdfs', 'd1.pdf'), '%PDF-1.4 fake\n');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));
fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([
  { id: '11075', company: '合成公司', role: '合成岗位', docId: 'd1', status: '面试中', appliedAt: '2026-11-01', channel: '官网' }
]));
fs.writeFileSync(path.join(root, 'materials.json'), JSON.stringify([
  { id: 'm1', title: '合成素材', brief: '精简表达内容', technical: '技术表达内容', interview: '面试讲述内容',
    tags: ['合成'], factStatus: 'pending', facts: { company: '合成公司', role: '合成岗位' } }
]));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0,
  profiles: [{ name: '桩配置', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'stub-key-not-real', model: 'stub-model' }]
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
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const base = `http://127.0.0.1:${port}`;
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b }));
  }).on('error', reject);
});

let browser = null;   // 提升到 try 外：finally 的兜底 close 才够得着（原先 const 在 try 内，finally 引用会 ReferenceError）
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { await get('/'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① 结构断言：八路由零内联事件属性（属性级解析，不做裸子串匹配防误红）=====
  // 与 XSS-1 同款标签切分：属性值可含 >，必须整体消费引号段。
  const TAGS = /<[a-zA-Z](?:"[^"]*"|'[^']*'|[^<>"'])*>/g;
  const PAGES = ['/', '/materials', '/applications', '/applications?view=table',
    '/settings', '/export?id=d1', '/snapshots?id=d1', '/app?id=11075'];
  for (const p of PAGES) {
    const r = await get(p);
    if (r.status !== 200 || !/text\/html/.test(r.headers['content-type'] || '')) fail(`${p} 未按 text/html 200 返回（HTTP ${r.status}）`);
    const tags = r.body.match(TAGS) || [];
    const bad = tags.filter((t) => /\s+on[a-z]+\s*=\s*("([^"]*)"|'([^']*)')/.test(t));
    if (bad.length) fail(`${p} 仍有 ${bad.length} 处内联事件属性（应已委托化为 data-action）：` + bad[0].slice(0, 120));
    const acts = (r.body.match(/data-action="/g) || []).length;
    if (!acts) fail(`${p} 无任何 data-action（委托目标缺失，夹具路由清单需核对）`);
  }

  // ===== ② 行为抽检（真实浏览器）=====
  let bin = null;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，仅完成结构断言：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  ctx.on('page', (p) => p.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '夹具输入' : undefined).catch(() => {})));
  const page = await ctx.newPage();
  const posts = [];   // { url, body }
  page.on('request', (r) => {
    if (r.method() !== 'POST') return;
    const u = r.url().replace(base, '');
    let body = null;
    try { body = JSON.parse(r.postData() || 'null'); } catch {}
    posts.push({ url: u, body });
  });
  const waitPost = async (urlPrefix, ms = 8000) => {
    for (let i = 0; i < ms / 100; i++) {
      const hits = posts.filter((x) => x.url.startsWith(urlPrefix));
      if (hits.length) return hits[hits.length - 1];   // 多次同名请求（如 /app/update）取最新一次
      await page.waitForTimeout(100);
    }
    fail('未发出 POST ' + urlPrefix + '（已捕获：' + posts.map((x) => x.url).join(', ') + '）');
  };
  const openAllDetails = () => page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  // 多数委托动作成功后页面自会 location.reload() —— goto 撞上在途导航会 ERR_ABORTED，重试等它落定
  const gotoSafe = async (url) => {
    for (let i = 0; ; i++) {
      try { await page.goto(url, { waitUntil: 'load' }); return; }
      catch (e) { if (i >= 4) throw e; await page.waitForTimeout(300); }
    }
  };

  // —— 首页四个表单（submit 委托）：每次提交后页面自会 reload/跳转 → 每次重新进入并展开 details ——
  await gotoSafe(base + '/');
  await page.waitForSelector('form[data-action="homeTag"][data-id="d1"]', { state: 'attached' });
  await openAllDetails();   // 表单在 <details class="more"> 内，先展开再点
  await page.click('form[data-action="homeTag"][data-id="d1"] button');
  let hit = await waitPost('/tag');
  if (!hit.body || hit.body.id !== 'd1' || hit.body.tag !== '夹具输入')
    fail('/tag 载荷不符（id/tag 应来自 data-* 属性解码）：' + JSON.stringify(hit));

  // —— 首页：归档表单（submit 委托 → __wv）——
  await gotoSafe(base + '/');
  await page.waitForSelector('form[data-action="homeArchive"][data-id="d1"]', { state: 'attached' });
  await openAllDetails();
  await page.click('form[data-action="homeArchive"][data-id="d1"] button');
  hit = await waitPost('/archive');
  if (!hit.body || hit.body.id !== 'd1') fail('/archive 载荷不符：' + JSON.stringify(hit));

  // —— 首页：复制表单（submit 委托，prompt 新 id → this.action 改写 + this.submit()）——
  await gotoSafe(base + '/');
  await page.waitForSelector('form[data-action="homeDup"][data-id="d2"]', { state: 'attached' });
  await openAllDetails();
  await page.click('form[data-action="homeDup"][data-id="d2"] button');
  hit = await waitPost('/duplicate?id=d2');
  if (!String(hit.url).startsWith('/duplicate?id=d2&to=')) fail('/duplicate 未按改写后的 action 原样提交：' + hit.url);

  // —— 首页：删除表单（submit 委托 confirm 门 → 原生 POST /delete）——
  await gotoSafe(base + '/');
  await page.waitForSelector('form[data-action="confirmSubmit"][action="/delete?id=d2"]', { state: 'attached' });
  await openAllDetails();
  await page.click('form[data-action="confirmSubmit"][action="/delete?id=d2"] button');
  await waitPost('/delete?id=d2');

  // —— 素材页：matStatus（click 委托）/ 事实层表单（submit 委托）/ 全部确认（click + confirm 门）——
  await gotoSafe(base + '/materials');
  await page.waitForSelector('[data-action="matStatus"][data-id="m1"]');
  await page.click('[data-action="matStatus"][data-id="m1"][data-status="confirmed"]');
  hit = await waitPost('/mat/update');
  if (!hit.body || hit.body.id !== 'm1' || hit.body.factStatus !== 'confirmed') fail('/mat/update（状态切换）载荷不符：' + JSON.stringify(hit));
  await openAllDetails();
  await page.click('form[data-action="matFacts"][data-id="m1"] button');
  hit = await waitPost('/mat/update');
  if (!hit.body || hit.body.id !== 'm1' || hit.body.facts.company !== '合成公司' || !('factStatus' in hit.body))
    fail('/mat/update（事实层）载荷不符：' + JSON.stringify(hit));
  await page.click('[data-action="matConfirmAll"]');
  hit = await waitPost('/mat/confirm');
  if (!hit.body || !Array.isArray(hit.body.ids) || !hit.body.ids.includes('m1')) fail('/mat/confirm 载荷不符：' + JSON.stringify(hit));

  // —— 投递看板（卡片）：◀（click）/ 状态下拉（change）/ 快速编辑开合（click）——
  // 六态模型（UPCV §1）：夹具 status '面试中' 读侧归一为 interviewing，◀ 的目标态是 replied
  await gotoSafe(base + '/applications');
  await page.waitForSelector('.app-card[data-app="11075"]');
  await page.click('.app-card[data-app="11075"] [data-action="appPatch"][data-status="replied"]');
  hit = await waitPost('/app/update');
  if (!hit.body || hit.body.id !== '11075' || hit.body.status !== 'replied') fail('/app/update（◀）载荷不符：' + JSON.stringify(hit));
  await gotoSafe(base + '/applications');
  await page.selectOption('.app-card[data-app="11075"] select[data-action="appStatus"]', 'offer');
  hit = await waitPost('/app/update');
  if (!hit.body || hit.body.id !== '11075' || hit.body.status !== 'offer') fail('/app/update（下拉）载荷不符：' + JSON.stringify(hit));
  await gotoSafe(base + '/applications');
  await page.click('.app-card[data-app="11075"] [data-action="appEdit"]');
  let hidden = await page.evaluate(() => document.querySelector('#editbox-11075').hidden);
  if (hidden !== false) fail('点「快速编辑」后行内编辑未展开（appEdit 委托未生效）');
  await page.click('.app-card[data-app="11075"] [data-action="appEditToggle"]');
  hidden = await page.evaluate(() => document.querySelector('#editbox-11075').hidden);
  if (hidden !== true) fail('点「取消」后行内编辑未收起（appEditToggle 委托未生效）');

  // —— 投递看板（表格）：表头 click 排序 + keydown Enter 排序 ——
  await gotoSafe(base + '/applications?view=table');
  await page.waitForSelector('#appTable th[data-action="sortCol"]');
  await page.click('#appTable th[data-idx="3"]');
  let cls = await page.evaluate(() => document.querySelector('#appTable th[data-idx="3"]').className);
  if (cls !== 'asc') fail('表头 click 排序未生效（期望 asc）：' + cls);
  await page.evaluate(() => document.querySelector('#appTable th[data-idx="1"]').focus());
  await page.keyboard.press('Enter');
  cls = await page.evaluate(() => ({ c: document.querySelector('#appTable th[data-idx="1"]').className, prev: document.querySelector('#appTable th[data-idx="3"]').className }));
  if (cls.c !== 'asc' || cls.prev !== '') fail('表头 Enter keydown 排序未生效或未清旧档：' + JSON.stringify(cls));
  await page.keyboard.press('Enter');
  cls = await page.evaluate(() => document.querySelector('#appTable th[data-idx="1"]').className);
  if (cls !== 'desc') fail('二次 Enter 未反向排序（sortIdx/sortDir 状态错）：' + cls);

  // —— 快照页：snapNote（click，双 prompt）/ snapBaseline（click）/ 回滚表单（confirm 门）——
  await gotoSafe(base + '/snapshots?id=d1');
  await page.waitForSelector('[data-action="snapNote"]');
  await page.click('[data-action="snapNote"][data-ts="2026-10-20-101010"]');
  hit = await waitPost('/snapshot/note');
  if (!hit.body || hit.body.id !== 'd1' || hit.body.ts !== '2026-10-20-101010' || hit.body.name !== '夹具输入' || hit.body.note !== '夹具输入')
    fail('/snapshot/note 载荷不符：' + JSON.stringify(hit));
  await page.click('[data-action="snapBaseline"][data-ts="2026-10-20-101010"]');
  hit = await waitPost('/snapshot/baseline');
  if (!hit.body || hit.body.id !== 'd1' || hit.body.ts !== '2026-10-20-101010') fail('/snapshot/baseline 载荷不符：' + JSON.stringify(hit));
  await page.click('form[data-action="confirmSubmit"][action*="/rollback"] button');
  await waitPost('/rollback?id=d1');

  // —— 设置页：input（profInp）/ change（radio setActive + select profEffort）委托 ——
  // 桩配置 0 本就是启用项（radio 已 checked，check() 不触发 change）→ 先补一张完整可保存的配置 1 再切它
  await gotoSafe(base + '/settings');
  await page.waitForSelector('input[data-action="profInp"][data-pf="name"]');
  await page.fill('input[data-action="profInp"][data-pf="name"]', '改名后');
  let st = await page.evaluate(() => ({ name: window.state.profiles[0].name, active: window.state.active }));
  if (st.name !== '改名后') fail('profInp（input 委托）未更新内存态：' + JSON.stringify(st));
  await page.click('#addBtn');
  const C2 = '#cards > div:nth-child(2)';
  await page.fill(C2 + ' input[data-action="profInp"][data-pf="name"]', '桩二');
  await page.fill(C2 + ' input[data-action="profInp"][data-pf="baseURL"]', 'http://127.0.0.1:9/v1');
  await page.fill(C2 + ' input[data-action="profInp"][data-pf="apiKey"]', 'stub-key-not-real');
  await page.fill(C2 + ' input[data-action="profInp"][data-pf="model"]', 'stub-model');
  await page.check(C2 + ' input[name="act"][data-action="setActive"]');
  st = await page.evaluate(() => ({ active: window.state.active, p1name: window.state.profiles[1] && window.state.profiles[1].name }));
  if (st.active !== 1 || st.p1name !== '桩二') fail('setActive（change 委托）未切换启用项或配置丢失：' + JSON.stringify(st));
  hit = await waitPost('/settings');
  if (!hit.body || !Array.isArray(hit.body.profiles) || hit.body.active !== 1) fail('/settings 保存请求未发出或载荷不符：' + JSON.stringify(hit));
  await page.selectOption('select[data-action="profEffort"][data-pi="0"]', 'low');
  st = await page.evaluate(() => window.state.profiles[0].reasoningEffort);
  if (st !== 'low') fail('profEffort（change 委托）未更新内存态：' + st);

  // —— 投递详情：regenArchive（click 委托）——
  await gotoSafe(base + '/app?id=11075');
  await page.waitForSelector('[data-action="regenArchive"]');
  await page.click('[data-action="regenArchive"]');
  hit = await waitPost('/app/archive-regenerate');
  if (!hit.body || hit.body.id !== '11075') fail('/app/archive-regenerate 载荷不符：' + JSON.stringify(hit));

  // —— 导出页：rerender（click 委托）——
  await gotoSafe(base + '/export?id=d1');
  await page.waitForSelector('[data-action="rerender"]');
  await page.click('[data-action="rerender"]');
  await waitPost('/render?id=d1');

  // —— 素材页：copyMat（click 委托，真实剪贴板写入后按钮换成功图标）——
  await gotoSafe(base + '/materials');
  await page.waitForSelector('[data-action="copyMat"][data-k="brief"]');
  await page.click('[data-action="copyMat"][data-k="brief"]');
  let copied = false;
  for (let i = 0; i < 30; i++) {
    const html = await page.evaluate(() => {
      const b = document.querySelector('[data-action="copyMat"][data-k="brief"]');
      return b ? b.innerHTML : '';
    });
    if (/<svg/i.test(html)) { copied = true; break; }
    await page.waitForTimeout(100);
  }
  if (!copied) fail('copyMat（click 委托）点击后未写入剪贴板（按钮未换成功图标）');
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''));
  if (clip !== '精简表达内容') fail('剪贴板内容不符：' + JSON.stringify(clip));

  await browser.close();
  browser = null;   // 已关：finally 的兜底 close 不再重复关
  console.log('✅ b5c1 内联 handler 委托化：八路由零内联事件属性；click/change/input/submit/keydown 五类委托行为抽检全过（首页表单/素材/投递卡片+表格排序/快照/设置/详情/导出）');
} finally {
  try { if (browser) await browser.close(); } catch {}
  cleanup();
}
