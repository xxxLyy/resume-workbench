// test-onboarding-ui.mjs — S5 八步向导页 UI（S5U）：可跳过/暂存续作/确认卡片流
// 断言全靠内容与路由行为（纪律：不靠提示文字颜色/超时假装）：
//   ① 完整流程（含卡片流加卡、STAR 并档、事实层暂存）产出文档，完成后跳 /edit?id= 且文档可编辑（contenteditable + DOC_ID）；
//   ② 逐跳过全部步骤 → 0.8 完成仍产出一份合法文档（与手建同权）；
//   ③ 暂存退出 → 首页显式入口重进 → 续作列表恢复到当前步，已确认内容在文档里；
//   ④ 首页入口为显式链接（零文档与有文档都在），访问首页不自动进入向导。
// 浏览器类夹具：隔离根 + 本机桩 LLM；零真实模型。Chromium 不可用 → exit 2（跳过，不假装通过）。
import assert from 'node:assert/strict';
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-onbui-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'stub' } }] }));
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
const metaAll = () => JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过引导向导 UI 回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage();

  // ===== ④a 零文档首页：显式「从零建简历」入口存在（不自动进入向导）
  //      （2026-11-05 批 1：hero 退役 → 任务卡三态，空库主行动 = 从零建简历，§0.3 改名；ob 系列内部文案改名归改名卡）=====
  await page.goto(base + '/');
  assert.equal(page.url(), base + '/', '零文档访问首页不得自动跳转向导');
  const entryZero = await page.$('a[href="/onboarding/guided"]');
  assert.ok(entryZero, '零文档首页应有显式「从零建简历」入口');
  assert.ok((await entryZero.textContent()).includes('从零建简历'), '入口文案应含「从零建简历」（2026-11-05 批 1 §0.3 改名）');

  // ===== ① 完整流程：0.1→0.2→0.3（卡片流+STAR+事实层）→0.4 跳→0.5→0.6 跳→0.7 跳→0.8 完成 → /edit =====
  await page.goto(base + '/onboarding/guided');
  await page.waitForSelector('[data-ob-next="0.1"]');
  // 步骤条 0.1–0.8 八步齐全（S5U 步序：基本信息/摘要/经历（STAR）/项目/技能/教育/照片/预览完成）
  const railText = await page.textContent('[data-ob-rail]');
  for (const label of ['基本信息', '摘要', '经历（STAR）', '项目', '技能', '教育', '照片（可选）', '预览完成']) {
    assert.ok(railText.includes(label), `步骤条应含「${label}」，实际：${railText}`);
  }
  assert.ok(await page.$('.ob-form button[name="skip"]'), '0.1 应有「跳过」按钮');
  assert.ok(await page.$('.ob-form a[href="/"]'), '0.1 应有「暂存退出」');
  // 左说明（插画+情绪文案）右卡片流的双栏壳
  assert.ok(await page.$('.ob-illust svg'), '左栏应有线描插画');
  // 0.1 基础信息
  await page.fill('[name="name"]', '向导同学');
  await page.click('.ob-form button[type="submit"]:not([name="skip"])');
  await page.waitForSelector('[data-ob-next="0.2"]');
  assert.ok(await page.$('[data-ob]'), '确认后应带向导承载标记');
  // 0.2 摘要
  await page.fill('[name="summary"]', '向导画像摘要');
  await page.click('.ob-form button[type="submit"]:not([name="skip"])');
  await page.waitForSelector('[data-ob-next="0.3"]');
  // 0.3 经历（STAR）：两张卡（一张含 STAR+事实层，一张只填名称），验证卡片流加卡
  await page.fill('[data-ob-entry] [data-k="title"]', '经历公司');
  await page.fill('[data-ob-entry] [data-k="points"]', '负责核心模块');
  await page.click('.ob-sub summary');   // 展开 STAR
  await page.fill('[data-ob-entry] [data-k="s"]', '在无自动化背景的项目里');
  await page.fill('[data-ob-entry] [data-k="t"]', '负责交付流水线');
  await page.fill('[data-ob-entry] [data-k="a"]', '搭建自动化构建');
  await page.fill('[data-ob-entry] [data-k="r"]', '发布周期减半');
  const detailsAll = await page.$$('.ob-sub');
  await detailsAll[1].$('summary').then((s) => s.click());   // 展开事实层
  await page.fill('[data-ob-entry] [data-k="fact"]', '流水线从人工到自动');
  await page.fill('[data-ob-entry] [data-k="source"]', '本人自述');
  await page.click('#obAdd');
  await page.waitForFunction(() => document.querySelectorAll('[data-ob-entry]').length === 2);
  const card2 = page.locator('[data-ob-entry]').nth(1);
  await card2.locator('[data-k="title"]').fill('第二段经历');
  await page.click('.ob-form button[type="submit"]:not([name="skip"])');
  await page.waitForSelector('[data-ob-next="0.4"]');
  // 0.4 项目：跳过
  await page.click('.ob-form button[name="skip"]');
  await page.waitForSelector('[data-ob-next="0.5"]');
  // 0.5 技能
  await page.fill('[name="skills"]', '技能甲\n技能乙');
  await page.click('.ob-form button[type="submit"]:not([name="skip"])');
  await page.waitForSelector('[data-ob-next="0.6"]');
  // 0.6 教育：跳过；0.7 照片：跳过
  await page.click('.ob-form button[name="skip"]');
  await page.waitForSelector('[data-ob-next="0.7"]');
  await page.click('.ob-form button[name="skip"]');
  await page.waitForSelector('[data-ob-next="0.8"]');
  assert.ok((await page.textContent('.ob-form')).includes('打开编辑器'), '0.8 预览卡应提供复用编辑器的入口');
  // 0.8 完成 → 跳 /edit?id=
  await page.click('.ob-form button[type="submit"]');
  await page.waitForURL('**/edit?id=*');
  const editUrl1 = page.url();
  assert.ok(/\/edit\?id=doc(-\d+)?$/.test(editUrl1), '完成后应跳 /edit?id=<docId>，实际：' + editUrl1);
  const mainId = new URL(editUrl1).searchParams.get('id');
  await page.waitForSelector('.sheet');
  assert.equal(await page.getAttribute('.sheet', 'contenteditable'), 'true', '产出文档在编辑器中可编辑');
  assert.ok((await page.content()).includes("var DOC_ID = '" + mainId + "'"), '/edit 页应带真实 DOC_ID');
  const sheetText = await page.textContent('.sheet');
  assert.ok(sheetText.includes('向导同学'), '产出文档应含 0.1 姓名');
  assert.ok(sheetText.includes('向导画像摘要'), '产出文档应含 0.2 摘要');
  assert.ok(sheetText.includes('情境：在无自动化背景的项目里'), 'STAR 应并入要点（情境行）');
  assert.ok(sheetText.includes('结果：发布周期减半'), 'STAR 应并入要点（结果行）');
  assert.ok(sheetText.includes('经历公司') && sheetText.includes('第二段经历'), '卡片流两张卡都应写入工作经历');
  assert.ok(sheetText.includes('技能甲'), '0.5 技能应写入');
  // 事实层：只暂存 meta（表达层不混入正文），带来源标注
  const obMeta = metaAll()[mainId].onboarding;
  assert.ok(obMeta.facts && Array.isArray(obMeta.facts.items) && obMeta.facts.items.some((f) => f.subject === '经历公司' && f.fact === '流水线从人工到自动' && f.source === '本人自述'),
    '事实层应暂存 meta.onboarding.facts 且带 subject/source，实际：' + JSON.stringify(obMeta.facts));
  assert.ok(!sheetText.includes('流水线从人工到自动'), '事实层不得混入正文表达层');
  assert.equal(obMeta.finished, true, '0.8 后 finished=true');
  assert.ok(obMeta.skipped.includes('0.4') && obMeta.skipped.includes('0.7'), '跳过的步应记录 skipped');

  // ===== ② 逐跳过全部步骤 → 0.8 完成仍产出合法文档 =====
  await page.goto(base + '/onboarding');
  await page.waitForSelector('[data-ob-next="0.1"]');
  for (const nxt of ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8']) {
    await page.click('.ob-form button[name="skip"]');
    await page.waitForSelector(`[data-ob-next="${nxt}"]`, { timeout: 8000 });
  }
  await page.click('.ob-form button[type="submit"]');
  await page.waitForURL('**/edit?id=*');
  const editUrl2 = page.url();
  const blankId = new URL(editUrl2).searchParams.get('id');
  await page.waitForSelector('.sheet');
  assert.equal(await page.getAttribute('.sheet', 'contenteditable'), 'true', '全跳过产出的文档应可编辑（合法文档）');
  assert.ok((await page.content()).includes("var DOC_ID = '" + blankId + "'"), '全跳过产出文档应带 DOC_ID');
  assert.equal(metaAll()[blankId].kind, 'master', '全跳过产出文档 kind=master（与手建同权）');
  assert.equal(metaAll()[blankId].flow, 'draft', '全跳过产出文档 flow=draft');

  // ===== ③ 暂存退出 → 首页显式入口重进 → 恢复到当前步，内容在文档里 =====
  // 口径：暂存 = 文档自然存在；首步确认前不建文档（未确认内容不落档，退出链接 title 亦如此说明）
  await page.goto(base + '/onboarding');
  await page.waitForSelector('[data-ob-next="0.1"]');
  await page.fill('[name="name"]', '暂存同学');
  await page.click('.ob-form button[type="submit"]:not([name="skip"])');   // 确认 0.1（建档）
  await page.waitForSelector('[data-ob-next="0.2"]');
  await page.click('text=暂存退出');
  await page.waitForURL(base + '/');
  assert.equal(page.url(), base + '/', '暂存退出应回首页（文档自然存在即暂存）');
  const entryDocs = await page.$('a[href="/onboarding/guided"]');
  assert.ok(entryDocs, '有文档用户首页仍有显式「从零建简历」入口（任务卡次级行，S5 暂存续作可达；不自动弹向导）');
  assert.equal(page.url(), base + '/', '有文档访问首页不得自动跳转向导');
  await entryDocs.click();
  await page.waitForSelector('.ob-resume');
  const resumeItem = await page.$('.ob-resume-item');
  assert.ok(resumeItem, '重进向导应出现「继续从零建简历」续作列表（2026-11-05 批 1 §0.3 改名）');
  assert.equal(await page.textContent('.ob-resume .ob-done-title'), '继续从零建简历', '继续卡标题应为「继续从零建简历」（§0.3 改名）');
  assert.ok((await resumeItem.textContent()).includes('暂存同学'), '续作列表应展示暂存文档的标题');
  const resumeHref = await resumeItem.getAttribute('href');
  const resumeId = new URL(resumeHref, base).searchParams.get('docId');
  await resumeItem.click();
  await page.waitForSelector('[data-ob-next="0.2"]');   // 恢复到当前步（0.1 已确认 → 0.2）
  assert.equal(await page.getAttribute('[data-ob]', 'data-ob-doc'), resumeId, '续作应按 docId 恢复');
  // 已确认内容在文档里（文档自然承载，重进不丢）
  await page.goto(base + '/edit?id=' + resumeId);
  await page.waitForSelector('.sheet');
  assert.ok((await page.textContent('.sheet')).includes('暂存同学'), '暂存后重进，已确认内容应保留在文档中');

  // ===== ④b 已有文档首页不自动进入向导（③中已断言 URL 不变），此处补：入口可达向导 =====
  await page.goto(base + '/onboarding/guided');
  await page.waitForSelector('[data-ob]');
  assert.ok(true, '显式点击入口可达向导页');

  console.log('✅ S5 向导 UI：完整流程产出可编辑文档（卡片流加卡/STAR 并档/事实层暂存不混正文）+ 全跳过产出合法文档 + 暂存退出重进恢复 + 首页显式入口（不自动进入向导）');
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  cleanup();
}
