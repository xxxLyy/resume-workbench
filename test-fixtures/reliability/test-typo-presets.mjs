// test-typo-presets.mjs — A3：排版密度三档预设 + 页数感知收紧建议（只建议不删内容）
// 验收口径（卡片原文，逐条进断言）：
//   ① 排版面板置顶三档预设（紧凑/标准/宽松）→ 五滑杆值联动 → #typo-custom 内容含对应值
//      （applyTypo/typoCss 单一通道，屏幕=PDF）；
//   ② 手动改任一滑杆 → 预设高亮即取消（诚实 UI）；
//   ③ 页数感知：无渲染历史 → 「尚未渲染」（不臆造）；mock 渲染历史 pages=3 > 目标 2 →
//      「上次渲染 N 页（目标 M 页）」提示与「切到紧凑档」按钮出现；
//   ④ 点击「切到紧凑档」→ 正文零变化（.sheet innerHTML 字节不变 + 磁盘文档 sha1 不变）、
//      仅 #typo-custom 变化（紧凑值）+ 行内列出实际改变的参数值（阴性对照：实现动了正文即红）；
//   ⑤ /layout-info 只读端点：pages 缺失=null、渲染历史回退、非法 id 400、缺文档 404。
// 隔离：mkdtemp 根 + 随机端口 + assembleTemplate 合成文档；真实数据禁写禁删；Chromium 缺失 → exit(2)（套件惯例）。
// 先红形态：无预设 UI（.ed-preset 不存在）/ 无页数提示行（.ed-pagerow 不存在）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';
import { sha1 } from '../../freeze.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-typo-preset-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs-meta.json'), '{}');
  fs.writeFileSync(path.join(root, 'applications.json'), '[]');
  fs.writeFileSync(path.join(root, 'materials.json'), '[]');
  return root;
};
const writeDoc = (root, id) => {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) doc = doc.replaceAll(k, () => v);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
    [id]: { rev: 1, theme: 'classic', styleHash: sha1(assembleTemplate('classic').match(/<style[^>]*>([\s\S]*?)<\/style>/)[1]), typo: '', schemaVersion: 1, kind: 'master', flow: 'draft', archivedAt: null }
  }));
};

const startServer = async (root) => {
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
    cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let exited = null;
  server.on('exit', (c, s) => { exited = { c, s }; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (exited) throw new Error('服务提前退出：' + JSON.stringify(exited) + '\n' + log.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) throw new Error('服务 30s 未就绪\n' + log.slice(-800));
  }
  return {
    base,
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.text() }; },
    kill: () => { try { server.kill('SIGKILL'); } catch {} }
  };
};

const servers = [];
const roots = [];
const cleanup = () => { for (const s of servers) s.kill(); for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} } };
process.on('exit', cleanup);

try {
  const root = mkRoot('main');
  roots.push(root);
  writeDoc(root, 'doc1');
  const sv = await startServer(root);
  servers.push(sv);
  const docFile = path.join(root, 'docs', 'doc1.html');
  const metaFile = path.join(root, 'docs-meta.json');

  // ===== ⑤ /layout-info（HTTP 直测：形状与闸门）=====
  const li0 = await sv.get('/layout-info?id=doc1');
  assert.equal(li0.status, 200, '/layout-info 应 200（先红：端点 404）');
  const li0j = JSON.parse(li0.body);
  assert.equal(li0j.ok, true, '/layout-info ok');
  assert.equal(li0j.pages, null, '无渲染历史（无 PDF、无 exports）→ pages=null（不臆造）');
  assert.equal(li0j.target, 2, '无 job.brief.pages → 目标为两页默认（与导出 overpage 同口径）');
  const liEvil = await sv.get('/layout-info?id=doc1&x=1');
  assert.equal(liEvil.status, 200, '未知查询参数不影响');
  const liBad = await sv.get('/layout-info?id=..%2Fdoc1');
  assert.equal(liBad.status, 400, '非法 id 应 400');
  const liGone = await sv.get('/layout-info?id=doc-none');
  assert.equal(liGone.status, 404, '缺文档应 404');
  const metaBefore = fs.readFileSync(metaFile, 'utf8');
  await sv.get('/layout-info?id=doc1');
  assert.equal(fs.readFileSync(metaFile, 'utf8'), metaBefore, '/layout-info 零写（docs-meta.json 字节不变）');
  console.log('✅ ⑤ /layout-info：无渲染历史 pages=null、目标默认 2、闸门 400/404、零写');

  // ===== 浏览器段 =====
  let bin;
  try { bin = await (await import('../../chromium.mjs')).resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过浏览器段：' + (e && e.message || e)); cleanup(); process.exit(2); }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  const page = await ctx.newPage();
  try {
    await page.goto(sv.base + '/edit?id=doc1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ed-rtabs', { timeout: 15000 });
    await page.click('#ed-rtabs button[data-pane="typo"]');
    await page.waitForSelector('#ed-pane-typo.on', { timeout: 5000 });

    // ===== ①+② 预设行 + 联动 =====
    await page.waitForSelector('.ed-typo .ed-preset', { timeout: 5000 });
    const presets = await page.$$eval('.ed-typo .ed-preset', (els) => els.map((e) => e.textContent));
    assert.deepEqual(presets, ['紧凑', '标准', '宽松'], '三档预设置顶：' + JSON.stringify(presets));
    await page.waitForFunction(() => !!document.querySelector('.ed-typo .ed-pagerow'), null, { timeout: 5000 });
    // 无渲染历史 → 尚未渲染（不臆造）
    const row0 = await page.$eval('.ed-typo .ed-pagerow', (e) => e.textContent);
    assert.ok(/尚未渲染/.test(row0), '无渲染历史应显示「尚未渲染」：' + row0);
    // 点宽松 → 五滑杆联动 + #typo-custom 含对应值
    await page.click('.ed-typo .ed-preset[data-preset="relaxed"]');
    await page.waitForFunction(() => {
      const el = document.getElementById('typo-custom');
      return el && el.textContent.includes('font-size:13.5px') && el.textContent.includes('padding-top:12mm');
    }, null, { timeout: 5000 });
    const sliderVals = await page.evaluate(() => ({
      fontSize: document.getElementById('ed-typo-fontSize').value,
      lineHeight: document.getElementById('ed-typo-lineHeight').value,
      pagePad: document.getElementById('ed-typo-pagePad').value,
      paraGap: document.getElementById('ed-typo-paraGap').value,
      secGap: document.getElementById('ed-typo-secGap').value
    }));
    assert.deepEqual(sliderVals, { fontSize: '13.5', lineHeight: '1.6', pagePad: '12', paraGap: '0.8', secGap: '4.5' }, '五滑杆应随预设联动：' + JSON.stringify(sliderVals));
    const typoTxt = await page.$eval('#typo-custom', (e) => e.textContent);
    assert.ok(typoTxt.includes('font-size:13.5px') && typoTxt.includes('line-height:1.6')
      && typoTxt.includes('padding-top:12mm') && typoTxt.includes('padding-bottom:12mm')
      && typoTxt.includes('margin-bottom:0.8mm') && typoTxt.includes('margin-top:4.5mm'), '#typo-custom 应含宽松档全部取值：' + typoTxt.slice(0, 200));
    const pressed = await page.$eval('.ed-typo .ed-preset[data-preset="relaxed"]', (e) => e.getAttribute('aria-pressed'));
    assert.equal(pressed, 'true', '宽松档应高亮（aria-pressed=true）');
    console.log('✅ ① 三档预设置顶 → 五滑杆联动 → #typo-custom 单一通道含对应值');

    // ===== ② 手动改滑杆 → 预设失选 =====
    await page.$eval('#ed-typo-fontSize', (el) => { el.value = '12.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => {
      const el = document.getElementById('typo-custom');
      return el && el.textContent.includes('font-size:12.5px');
    }, null, { timeout: 5000 });
    const pressedAfter = await page.$$eval('.ed-typo .ed-preset', (els) => els.map((e) => e.getAttribute('aria-pressed')));
    assert.ok(pressedAfter.every((p) => p !== 'true'), '手动改滑杆后预设应全部失选：' + JSON.stringify(pressedAfter));
    console.log('✅ ② 手动改滑杆 → 预设高亮取消（诚实 UI）');

    // ===== ③ mock 渲染历史 pages=3 > 目标 2 → 提示与按钮出现 =====
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.doc1.exports = [{ exportId: 'e1', renderInputId: 'a'.repeat(40), at: new Date().toISOString(), pages: 3 }];
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    await page.click('#ed-rtabs button[data-pane="zone"]');   // 切走再切回 → 页数行重取
    await page.click('#ed-rtabs button[data-pane="typo"]');
    await page.waitForFunction(() => /上次渲染 3 页/.test((document.querySelector('.ed-typo .ed-pagerow') || {}).textContent || ''), null, { timeout: 5000 });
    const row1 = await page.$eval('.ed-typo .ed-pagerow', (e) => e.textContent);
    assert.ok(/目标 2 页/.test(row1), '应显示目标页数：' + row1);
    const moreBtn = await page.$('.ed-typo .ed-pagemore');
    assert.ok(moreBtn, '超页（3>2）应出现「切到紧凑档」按钮');
    const moreTxt = await moreBtn.evaluate((e) => e.textContent);
    assert.ok(/紧凑/.test(moreTxt), '按钮应为切到紧凑档：' + moreTxt);
    console.log('✅ ③ mock pages=3>目标 2 → 「上次渲染 3 页（目标 2 页）」提示与「切到紧凑档」按钮出现');

    // ===== ④ 一键紧凑：正文零变化、仅 typo 块变化 + 变更值列表 =====
    const sheetBefore = await page.$eval('.sheet', (e) => e.innerHTML);
    const fileShaBefore = sha1(fs.readFileSync(docFile));
    await moreBtn.click();
    await page.waitForFunction(() => {
      const el = document.getElementById('typo-custom');
      return el && el.textContent.includes('font-size:12px') && el.textContent.includes('padding-top:7.5mm');
    }, null, { timeout: 5000 });
    const sheetAfter = await page.$eval('.sheet', (e) => e.innerHTML);
    assert.equal(sheetAfter, sheetBefore, '正文（.sheet innerHTML）必须字节零变化（绝不自动删改内容）');
    assert.equal(sha1(fs.readFileSync(docFile)), fileShaBefore, '磁盘文档零变化（不静默保存/截断）');
    const typoAfter = await page.$eval('#typo-custom', (e) => e.textContent);
    assert.ok(typoAfter.includes('font-size:12px') && typoAfter.includes('line-height:1.35')
      && typoAfter.includes('padding-top:7.5mm') && typoAfter.includes('margin-bottom:0.3mm')
      && typoAfter.includes('margin-top:2.2mm'), '#typo-custom 应为紧凑档取值：' + typoAfter.slice(0, 200));
    const noteTxt = await page.$eval('.ed-typo .ed-pagenote', (e) => e.textContent);
    assert.ok(/已应用紧凑预设/.test(noteTxt) && /→/.test(noteTxt) && /内容未改动/.test(noteTxt), '应行内列出实际改变的参数值：' + noteTxt);
    const pressedCompact = await page.$eval('.ed-typo .ed-preset[data-preset="compact"]', (e) => e.getAttribute('aria-pressed'));
    assert.equal(pressedCompact, 'true', '应用后紧凑档应高亮');
    console.log('✅ ④ 切到紧凑档：正文与磁盘文档字节零变化、仅 #typo-custom 变化、行内列出变更值（阴性对照护栏在位）');

    console.log('✅ A3 test-typo-presets：三档预设联动/失选/页数感知/一键紧凑（内容零变化） 全部通过');
  } finally {
    await browser.close().catch(() => {});
  }
} catch (e) {
  cleanup();
  fail(String((e && e.stack) || e));
}
cleanup();
