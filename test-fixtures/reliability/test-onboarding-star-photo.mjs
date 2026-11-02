// test-onboarding-star-photo.mjs — S5F 收尾端到端：STAR AI 建议门控 + 照片可选排除 Git + 完整链路可导出
// 断言全靠内容与行为（纪律：不靠提示文字/超时假装）：
//   A（HTTP，必跑）
//   ① 端到端链路（S5R/S5U/S5F 串起）：步进建档 → 经历+事实层落档 → STAR 建议 → 确认 → 收口；
//   ② 确认门控：/onboarding/star-suggest 只产建议——响应后文档字节零变化；用户经 POST /onboarding/step
//      确认后 STAR 行（情境：…）才出现在正文；
//   ③ 桩友好：LLM 未配置 → 409 {ok:false, code:'NO_LLM'}，纯手填路径照常可用；
//   ④ 照片（0.7 步）：落 <root>/photos/<docId>.<ext>（0600）+ meta.onboarding.photo 记路径；
//      正文不注入（模板位待 S6，冻结件约束）；
//   ⑤ .gitignore 生效：git check-ignore photos/… 命中仓库 .gitignore 的 photos/ 条目（只读 git 操作）。
//   B（浏览器，Chromium 不可用 → exit 2 跳过，不假装通过）
//   ⑥ UI AI 按钮：建议只回填卡片 s/t/a/r 输入框（可改），确认提交后正文才出现 STAR 行；
//   ⑦ UI 照片上传：setInputFiles → photos/<docId>.png 落盘；
//   ⑧ 端到端可导出：0.8 完成 → POST /render → pdfs/<id>.pdf 产出。
// 隔离根 + 本机桩 LLM；零真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-s5f-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 桩 LLM：STAR 建议 JSON（值带「整理」字样，与手填可区分）
const STAR_STUB = JSON.stringify({ entries: [{ index: 1, star: { s: '情境整理S', t: '任务整理T', a: '行动整理A', r: '结果整理R' } }] });
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: STAR_STUB } }] }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubURL = `http://127.0.0.1:${stub.address().port}/v1`;
const writeStubConfig = () => fs.writeFileSync(path.join(root, 'config.json'),
  JSON.stringify({ active: 0, profiles: [{ name: 'stub', baseURL: stubURL, apiKey: 'stub-key-not-real', model: 'stub-model-s5f' }] }));
const writeNoLlmConfig = () => fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ active: 0, profiles: [] }));
writeStubConfig();

const PNG1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
const metaAll = () => JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
const docPathOf = (id) => path.join(root, 'docs', id + '.html');
const docBytes = (id) => fs.readFileSync(docPathOf(id), 'utf8');
const stepPost = async (body) => {
  const r = await fetch(base + '/onboarding/step', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① 端到端链路（HTTP）：建档 → 经历+事实层 → STAR 建议 → 确认 → 照片 → 收口 =====
  const r1 = await stepPost({ step: '0.1', payload: { name: '端到端同学', contact: 'e2e-contact', intent: '后端开发' } });
  assert.ok(r1.status === 200 && r1.ok === true, '0.1 应建档：' + JSON.stringify(r1));
  const D1 = r1.docId;
  assert.ok(D1, '建档应有 docId');
  const r2 = await stepPost({ step: '0.3', docId: D1, payload: { work: [{ title: '合成公司', points: ['负责合成模块，发布周期从两周缩短到三天'] }], facts: [{ subject: '合成公司', fact: '发布周期两周到三天', condition: '无自动化流水线', contribution: '独立搭建', source: '本人自述' }] } });
  assert.equal(r2.status, 200, '0.3 应写入：' + JSON.stringify(r2));
  assert.ok(docBytes(D1).includes('合成公司'), '经历应写入正文');
  const facts = metaAll()[D1].onboarding.facts;
  assert.ok(facts && Array.isArray(facts.items) && facts.items.some((f) => f.subject === '合成公司' && f.fact === '发布周期两周到三天' && f.source === '本人自述'),
    '事实层应随文档保存（meta.onboarding.facts），实际：' + JSON.stringify(facts));

  // ===== ② STAR 建议 + 确认门控：建议不落正文，确认后才写 =====
  const before = docBytes(D1);
  const sr = await fetch(base + '/onboarding/star-suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: D1, entries: [{ title: '合成公司', points: ['负责合成模块，发布周期从两周缩短到三天'] }] })
  });
  const sj = await sr.json();
  assert.equal(sr.status, 200, 'star-suggest 应 200：' + JSON.stringify(sj));
  assert.ok(sj.ok === true && Array.isArray(sj.suggestions) && sj.suggestions.length === 1, '应返回一条建议');
  const sug = sj.suggestions[0];
  assert.equal(sug.index, 0, '建议 index 应映射到第 0 条');
  assert.equal(sug.star.s, '情境整理S', '建议 s 应来自桩输出');
  assert.equal(docBytes(D1), before, '确认门控：建议响应后文档字节必须零变化（不落正文）');
  const rc = await stepPost({ step: '0.3', docId: D1, payload: { work: [{ title: '合成公司', points: ['负责合成模块，发布周期从两周缩短到三天'], star: sug.star }] } });
  assert.equal(rc.status, 200, '确认（同步重写）应成功：' + JSON.stringify(rc));
  const after = docBytes(D1);
  assert.ok(after.includes('情境：情境整理S') && after.includes('结果：结果整理R'), '确认后 STAR 行应写入正文');
  assert.ok(after !== before, '确认后文档应变化');

  // ===== ③ 桩友好：LLM 未配置 → NO_LLM，纯手填照常 =====
  writeNoLlmConfig();
  const nr = await fetch(base + '/onboarding/star-suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId: D1, entries: [{ title: '合成公司', points: ['负责合成模块'] }] })
  });
  const nj = await nr.json();
  assert.equal(nr.status, 409, '未配置模型应 409，实际：' + nr.status);
  assert.equal(nj.code, 'NO_LLM', '应带 NO_LLM 语义：' + JSON.stringify(nj));
  const rm = await stepPost({ step: '0.3', docId: D1, payload: { work: [{ title: '合成公司', points: ['负责合成模块，发布周期从两周缩短到三天'], star: { s: '手填情境', t: '', a: '', r: '' } }] } });
  assert.equal(rm.status, 200, 'LLM 未配置时纯手填步进应照常可用：' + JSON.stringify(rm));
  assert.ok(docBytes(D1).includes('情境：手填情境'), '手填 STAR 应写入');
  writeStubConfig();

  // ===== ④ 照片（0.7 步 API）：落 photos/ + meta 记路径 + 正文不注入（模板位待 S6） =====
  const photoBefore = docBytes(D1);
  const rp = await stepPost({ step: '0.7', docId: D1, payload: { photo: 'data:image/png;base64,' + PNG1x1.toString('base64') } });
  assert.equal(rp.status, 200, '0.7 照片应成功：' + JSON.stringify(rp));
  const photoPath = path.join(root, 'photos', D1 + '.png');
  assert.ok(fs.existsSync(photoPath), '照片应落 <root>/photos/<docId>.png');
  assert.equal(fs.statSync(photoPath).mode & 0o777, 0o600, '照片文件应为 0600');
  assert.equal(metaAll()[D1].onboarding.photo.file, 'photos/' + D1 + '.png', 'meta 应记录照片路径');
  assert.equal(docBytes(D1), photoBefore, '照片只存路径，正文不得注入（模板位待 S6）');

  // ===== ⑤ .gitignore 生效（仓库级，只读 git 操作） =====
  const gi = fs.readFileSync(path.join(APP_ROOT, '.gitignore'), 'utf8');
  assert.ok(/^photos\/$/m.test(gi), '仓库 .gitignore 应含 photos/ 条目');
  const ci = spawnSync('git', ['check-ignore', '-v', 'photos/demo.png'], { cwd: APP_ROOT, encoding: 'utf8' });
  assert.equal(ci.status, 0, 'git check-ignore photos/demo.png 应命中（exit 0），输出：' + ci.stdout);
  assert.ok(String(ci.stdout).includes('photos/'), '命中规则应为 photos/，实际：' + ci.stdout);
  assert.ok(fs.existsSync(path.join(root, 'photos', '.gitignore')), '数据目录内 photos/.gitignore 自排除兜底仍在');

  // ===== 收口（JSON 合同） =====
  const rf = await stepPost({ step: '0.8', docId: D1 });
  assert.ok(rf.status === 200 && rf.ok === true, '0.8 应收口：' + JSON.stringify(rf));
  assert.equal(rf.nextStep, null, '0.8 后 nextStep=null');

  // ===== B 段（浏览器）：AI 按钮回填 / 照片上传 / 渲染导出 =====
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过 S5F 浏览器段（HTTP 段已全绿）：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage();

  // ⑥ UI AI 按钮：建议只回填输入框，确认提交后才写正文
  await page.goto(base + '/onboarding');
  await page.waitForSelector('[data-ob-next="0.1"]');
  await page.fill('[name="name"]', '浏览器同学');
  await page.click('.ob-form button[type="submit"]:not([name="skip"])');
  await page.waitForSelector('[data-ob-next="0.2"]');
  await page.click('.ob-form button[name="skip"]');
  await page.waitForSelector('[data-ob-next="0.3"]');
  await page.fill('[data-ob-entry] [data-k="title"]', '界面公司');
  await page.fill('[data-ob-entry] [data-k="points"]', '负责界面模块');
  await page.click('.ob-sub summary');   // 展开 STAR 折叠区（AI 按钮在其内）
  await page.click('[data-ob-ai]');
  await page.waitForFunction(() => (document.querySelector('[data-k="s"]') || {}).value === '情境整理S', null, { timeout: 10000 });
  const starVals = await page.evaluate(() => ({ s: document.querySelector('[data-k="s"]').value, r: document.querySelector('[data-k="r"]').value }));
  assert.equal(starVals.r, '结果整理R', '建议应回填卡片 s/r 输入框（确认门控：此刻正文未变）');
  const docB = metaAll();
  const uiDocId = Object.keys(docB).find((k) => docB[k].onboarding && !docB[k].onboarding.finished && k !== D1);
  assert.ok(uiDocId, '浏览器会话应已建档');
  assert.ok(!docBytes(uiDocId).includes('情境整理S'), '建议只回填输入框，正文不得提前写入');
  await page.click('.ob-form button[type="submit"]:not([name="skip"])');
  await page.waitForSelector('[data-ob-next="0.4"]');
  assert.ok(docBytes(uiDocId).includes('情境：情境整理S'), '确认提交后正文才出现 STAR 行');

  // ⑦ UI 照片上传
  for (const nxt of ['0.5', '0.6', '0.7']) {
    await page.click('.ob-form button[name="skip"]');
    await page.waitForSelector(`[data-ob-next="${nxt}"]`, { timeout: 8000 });
  }
  const demoPng = path.join(root, 'demo-upload.png');
  fs.writeFileSync(demoPng, PNG1x1);
  await page.setInputFiles('[data-ob-photo-file]', demoPng);
  await page.waitForFunction(() => (document.getElementById('obPhoto') || {}).value.startsWith('data:image/png'), null, { timeout: 8000 });
  assert.ok((await page.textContent('[data-ob-photo-note]')).includes('已选择'), '选择后应提示已选文件');
  await page.click('.ob-form button[type="submit"]:not([name="skip"])');
  await page.waitForSelector('[data-ob-next="0.8"]');
  assert.ok(fs.existsSync(path.join(root, 'photos', uiDocId + '.png')), 'UI 上传的照片应落 photos/<docId>.png');

  // ⑧ 端到端可导出：0.8 完成 → /edit → POST /render → PDF 产出
  await page.click('.ob-form button[type="submit"]');
  await page.waitForURL('**/edit?id=*');
  const editUrl = page.url();
  const finalId = new URL(editUrl).searchParams.get('id');
  await page.waitForSelector('.sheet');
  assert.ok((await page.textContent('.sheet')).includes('浏览器同学'), '端到端产出文档应可编辑且含内容');
  const rr = await fetch(base + '/render?id=' + finalId, { method: 'POST' });
  const rj = await rr.json();
  assert.equal(rr.status, 200, 'POST /render 应 200：' + JSON.stringify(rj));
  assert.equal(rj.ok, true, '渲染应成功：' + JSON.stringify(rj));
  const pdfPath = path.join(root, 'pdfs', finalId + '.pdf');
  assert.ok(fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0, '端到端应产出 PDF（可导出）');
  assert.equal(metaAll()[finalId].kind, 'master', '端到端产出文档 kind=master（与手建同权）');

  console.log('✅ S5F 端到端：STAR 建议只回填卡片、确认才落正文（HTTP+UI 双验证）、NO_LLM 桩友好回落手填、事实层随文档保存、照片落 photos/（0600+meta 路径+正文不注入）、git check-ignore 命中、0.8 后 POST /render 产出 PDF');
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  cleanup();
}
