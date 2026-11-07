// test-onboarding-theme-cards.mjs — 批1 §0.3「从零建简历」0.8 步选模板（完成步选一套模板）
// 验收口径（卡片原文，逐条进断言）：
//   ① 0.8 步呈现每主题一张模板卡（批 5 第 2 项起四张）= 主题名 + 场景短语（通用 / 单栏装更多 / 经历多一页排满 / 展示向）
//      + 真渲染缩略图（iframe）+ 选中态；
//   ② 缩略图 = /theme-preview 同装配 srcdoc 内嵌（端点不可被嵌，走同装配）：卡内嵌内容与
//      GET /theme-preview?id=&theme= 响应体逐字节相等（装配单一实现 themePreviewHtml()，DESIGN.md §10.1 口径）；
//   ③ classic 默认可跳过：0.8 不带主题直接完成 → meta.theme 仍为 classic；
//   ④ 确认完成时随文档一步写 meta.theme（/theme/apply 同口径）：POST 0.8 → meta.theme 变更，
//      且 303 落点 /edit 即新主题装配（无二次刷新）；
//   ⑤ 未知主题 → 400 且零写（meta.theme 与向导进度都不变）；
//   ⑥ 0.8 页只读：GET 不写 docs/<id>.html 与 docs-meta.json；无文档会话也不建档。
//   ⑧（浏览器段）缩略图不横向裁切：卡宽随机型栅格收窄，固定缩放会在 ≤1250px 视口裁掉右栏，
//      而版式对比是本卡缩略图的唯一目的；缩放随框宽自适应，逐视口逐卡量测钉住。
// 隔离：mkdtemp 根 + 随机端口 + 向导自身产出合成文档；真实数据禁写禁删。
// Chromium 缺失 → exit(2)（套件惯例：跳过浏览器段不算通过）。
// 先红形态：0.8 页无模板卡（.ob-tcard 不存在）+ 0.8 确认不写 meta.theme。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const sha1f = (p) => createHash('sha1').update(fs.readFileSync(p)).digest('hex');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-obtheme-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });

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
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const base = `http://127.0.0.1:${port}`;

const stepJson = async (body) => {
  const r = await fetch(base + '/onboarding/step', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};
const stepForm = async (fields) => {
  const r = await fetch(base + '/onboarding/step', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(), redirect: 'manual'
  });
  return { status: r.status, location: r.headers.get('location') || '', text: await r.text() };
};
const getText = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const metaAll = () => JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
const docPath = (id) => path.join(root, 'docs', id + '.html');
const metaPath = path.join(root, 'docs-meta.json');
const unescapeAttr = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
// 卡块 → srcdoc 原字节（属性实体还原；还原顺序 & 最后）
const cardBlock = (html, theme) => {
  const m = new RegExp('<label class="ob-tcard" data-theme="' + theme + '">([\\s\\S]*?)</label>').exec(html);
  return m ? m[1] : null;
};
const cardSrcdoc = (html, theme) => {
  const block = cardBlock(html, theme);
  if (block == null) return null;
  const m = /\ssrcdoc="([\s\S]*?)"/.exec(block);
  return m ? unescapeAttr(m[1]) : null;
};
// 向导推进到 0.8（建档 + 逐跳过 0.2–0.7）
const advanceTo08 = async (name) => {
  const r0 = await stepJson({ step: '0.1', payload: { name: name || '模板卡同学' } });
  assert.equal(r0.status, 200, '0.1 应 200：' + JSON.stringify(r0));
  assert.ok(r0.docId, '0.1 建档应返回 docId');
  for (const st of ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7']) {
    const r = await stepJson({ step: st, docId: r0.docId, skip: true });
    assert.equal(r.status, 200, `${st} 跳过应 200：${JSON.stringify(r)}`);
  }
  return r0.docId;
};
// 无文档会话：逐跳到 0.8（0.8 收口时建档）
const advanceNoDocTo08 = async () => {
  for (const st of ['0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7']) {
    const r = await stepJson({ step: st, skip: true });
    assert.equal(r.status, 200, `无文档会话 ${st} 跳过应 200：${JSON.stringify(r)}`);
    assert.equal(r.docId, null, `无文档会话 ${st} 不应建档`);
  }
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① 0.8 步：四张模板卡（主题名 + 场景短语 + 真渲染缩略图 + 选中态）=====
  const D1 = await advanceTo08('模板卡同学');
  const page08 = await getText('/onboarding?docId=' + D1);
  assert.equal(page08.status, 200, '0.8 页应 200');
  assert.ok(page08.text.includes('data-ob-next="0.8"'), '应渲染 0.8 步，实际 next=' + (/data-ob-next="([^"]*)"/.exec(page08.text) || [])[1]);
  for (const theme of ['classic', 'compact', 'dual', 'magazine']) {
    assert.ok(cardBlock(page08.text, theme) != null, `0.8 应有 ${theme} 模板卡（先红：0.8 无模板卡）`);
  }
  assert.equal((page08.text.match(/class="ob-tcard"/g) || []).length, 4, '0.8 模板卡应恰四张（批 5 第四主题 compact）');
  // 主题名 + 场景短语（§9.1-3 边界内：短标签，非受众长句）
  const pageText = page08.text.replace(/<[^>]+>/g, ' ');
  for (const scene of ['通用', '单栏装更多', '经历多一页排满', '展示向']) {
    assert.ok(pageText.includes(scene), `0.8 模板卡应带场景短语「${scene}」`);
  }
  for (const name of ['经典单栏', '紧凑单栏', '双栏紧凑', '杂志展示']) {
    assert.ok(pageText.includes(name), `0.8 模板卡应带主题名「${name}」`);
  }
  // 缩略图 = iframe srcdoc 内嵌（同装配，非静态图）
  for (const theme of ['classic', 'compact', 'dual', 'magazine']) {
    const block = cardBlock(page08.text, theme);
    assert.ok(/<iframe[^>]*\ssrcdoc="/.test(block), `${theme} 卡应有 srcdoc 内嵌缩略图`);
    assert.ok(!/src="http/.test(block), `${theme} 卡缩略图不得走外链 URL`);
    assert.ok(!/src="\/theme-preview/.test(block), `${theme} 卡缩略图不得 iframe src 指向 /theme-preview（端点 frame-ancestors 'none' 不可被嵌）`);
  }
  // 选中态：classic 默认选中（唯一 checked）
  const radios = [...page08.text.matchAll(/<input[^>]*type="radio"[^>]*name="theme"[^>]*>/g)].map((m) => m[0]);
  assert.equal(radios.length, 4, '模板选择应为四个 radio（批 5 第四主题 compact）');
  assert.equal(radios.filter((r) => /checked/.test(r)).length, 1, '模板选择应恰有一个选中项');
  assert.ok(/value="classic"/.test(radios.find((r) => /checked/.test(r))), '默认选中应为 classic（默认可跳过）');
  console.log('✅ ① 0.8 四张模板卡：主题名 + 场景短语 + srcdoc 缩略图 + classic 默认选中');

  // ===== ② 卡内嵌内容与 GET /theme-preview 响应体逐字节相等 =====
  const docBefore = sha1f(docPath(D1)), metaBefore = sha1f(metaPath);
  for (const theme of ['classic', 'compact', 'dual', 'magazine']) {
    const pv = await getText('/theme-preview?id=' + D1 + '&theme=' + theme);
    assert.equal(pv.status, 200, `/theme-preview?theme=${theme} 应 200`);
    const embedded = cardSrcdoc(page08.text, theme);
    assert.equal(embedded, pv.text, `${theme} 卡内嵌内容应与 GET /theme-preview 响应体逐字节相等`);
  }
  assert.equal(sha1f(docPath(D1)), docBefore, '0.8 页 GET 不得写 docs/<id>.html');
  assert.equal(sha1f(metaPath), metaBefore, '0.8 页 GET 不得写 docs-meta.json');
  console.log('✅ ② 卡内嵌 srcdoc 与 GET /theme-preview 响应体逐字节相等（classic/compact/dual/magazine）；0.8 页只读');

  // ===== ④ 确认完成时随文档一步写 meta.theme（/theme/apply 同口径）+ 无二次刷新 =====
  const done = await stepForm({ step: '0.8', docId: D1, theme: 'magazine' });
  assert.equal(done.status, 303, '表单流 0.8 完成应 303 回跳，实际 ' + done.status + '：' + done.text.slice(0, 200));
  assert.equal(done.location, '/edit?id=' + D1, '0.8 完成应回跳 /edit?id=<docId>');
  assert.equal(metaAll()[D1].theme, 'magazine', '0.8 完成应一步写 meta.theme=magazine，实际 ' + JSON.stringify(metaAll()[D1].theme));
  const edit1 = await getText('/edit?id=' + D1);
  assert.ok(edit1.text.includes('<style data-theme="magazine">'), '0.8 完成后的 /edit 应即新主题装配（无二次刷新）');
  console.log('✅ ④ 0.8 确认一步写 meta.theme（magazine）+ 落点 /edit 即新主题装配');

  // ===== ③ 无文档会话：0.8 收口建档时写 meta.theme；不带主题 = classic 默认可跳过 =====
  await advanceNoDocTo08();
  const docsBefore = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.html')).length;
  const blank = await stepJson({ step: '0.8' });
  assert.equal(blank.status, 200, '无文档会话 0.8 收口应 200：' + JSON.stringify(blank));
  assert.ok(blank.docId, '0.8 收口应建档');
  assert.equal(metaAll()[blank.docId].theme, 'classic', '不带主题完成 → classic 默认可跳过');
  assert.equal(fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.html')).length, docsBefore + 1, '0.8 收口应恰好建一份文档');
  await advanceNoDocTo08();
  const blank2 = await stepJson({ step: '0.8', theme: 'dual' });
  assert.equal(blank2.status, 200, '无文档会话 0.8 带主题应 200：' + JSON.stringify(blank2));
  assert.equal(metaAll()[blank2.docId].theme, 'dual', '建档一步写 meta.theme=dual，实际 ' + JSON.stringify(metaAll()[blank2.docId].theme));
  console.log('✅ ③ 0.8 收口建档时写 meta.theme；不带主题 = classic 默认可跳过');

  // ===== ⑤ 未知主题 → 400 且零写 =====
  const D2 = await advanceTo08('守门同学');
  const bad = await stepJson({ step: '0.8', docId: D2, theme: 'evil' });
  assert.equal(bad.status, 400, '未知主题应 400，实际 ' + bad.status + '：' + JSON.stringify(bad));
  assert.ok(/可用主题/.test(String(bad.error || '')), '400 应列可用主题名：' + String(bad.error || ''));
  const m2 = metaAll()[D2];
  assert.equal(m2.theme, 'classic', '失败请求不得改 meta.theme');
  assert.ok(!m2.onboarding || !m2.onboarding.finished, '失败请求不得推进向导进度');
  console.log('✅ ⑤ 未知主题 400 + 零写（meta.theme 与向导进度均不变）');

  // ===== ⑥ 无文档会话的 0.8 页：仍出全部主题卡（空白模板装配），且 GET 不建档 =====
  const docsCountBefore = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.html')).length;
  const metaCountBefore = Object.keys(metaAll()).length;
  const blankPage = await getText('/onboarding?next=0.8');
  assert.equal(blankPage.status, 200, '无文档会话 0.8 页应 200');
  for (const theme of ['classic', 'compact', 'dual', 'magazine']) {
    assert.ok(cardBlock(blankPage.text, theme) != null, `无文档会话 0.8 也应有 ${theme} 卡`);
    const embedded = cardSrcdoc(blankPage.text, theme);
    assert.ok(embedded && embedded.includes('data-theme="' + theme + '"'), `无文档会话 ${theme} 卡应内嵌该主题装配`);
  }
  assert.equal(fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.html')).length, docsCountBefore, '无文档会话 0.8 页不得建档');
  assert.equal(Object.keys(metaAll()).length, metaCountBefore, '无文档会话 0.8 页不得写 meta');
  console.log('✅ ⑥ 无文档会话 0.8 页同样出四张卡（空白模板装配）且零写');

  // ===== 浏览器段：缩略图真渲染 + 选中态 + 选完提交写 meta.theme =====
  let bin;
  try { bin = await (await import('../../chromium.mjs')).resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过浏览器段：' + (e && e.message || e)); cleanup(); process.exit(2); }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage();
  try {
    const D3 = await advanceTo08('浏览器段同学');
    await page.goto(base + '/onboarding?docId=' + D3, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ob-tcard', { timeout: 15000 });
    // 真渲染：四张卡的 iframe 都渲染出 .sheet，且各自主题装配正确
    const rendered = await page.waitForFunction(() => {
      const fs3 = [...document.querySelectorAll('.ob-tcard iframe')];
      return fs3.length === 4 && fs3.every((f) => { try { return !!(f.contentDocument && f.contentDocument.querySelector('.sheet')); } catch { return false; } });
    }, null, { timeout: 20000 }).then(() => true).catch(() => false);
    assert.ok(rendered, '四张卡的缩略图 iframe 应真实渲染出 .sheet');
    const frameThemes = await page.$$eval('.ob-tcard', (cards) => cards.map((c) => {
      const f = c.querySelector('iframe');
      const s = f && f.contentDocument && f.contentDocument.querySelector('style[data-theme]');
      return { card: c.getAttribute('data-theme'), frame: s ? s.getAttribute('data-theme') : '' };
    }));
    for (const t of frameThemes) assert.equal(t.frame, t.card, `${t.card} 卡缩略图应渲染该主题装配`);
    // ===== ⑦ 卡头版式：radio 不被既有 .ob-form input{width:100%} 撑成整行（2026-11-06 复核阻断项）=====
    // 真浏览器量测口径：radio 盒宽 ≤ 30px（原生单选钮 ≈13px，被 width:100% 撑开会到 200+px）；
    // 主题名/场景短语单行不折行（中文可在字间断行，折行即排印破损）；radio 与主题名相邻（间距 ≤ 40px）。
    const heads = await page.$$eval('.ob-tcard', (cards) => cards.map((c) => {
      const radio = c.querySelector('input[name="theme"]');
      const name = c.querySelector('.ob-tname');
      const scene = c.querySelector('.ob-scene');
      const r = radio.getBoundingClientRect(), n = name.getBoundingClientRect();
      const s = scene.getBoundingClientRect(), hd = c.querySelector('.ob-thead').getBoundingClientRect();
      return {
        theme: c.getAttribute('data-theme'),
        radioW: r.width, nameH: n.height, sceneH: s.height, headH: hd.height, gapRadioName: n.left - r.right
      };
    }));
    for (const h of heads) {
      assert.ok(h.radioW <= 30, `${h.theme} 卡 radio 不应被 .ob-form input 的 width:100% 撑宽（实测 ${h.radioW.toFixed(1)}px）`);
      assert.ok(h.nameH <= 30, `${h.theme} 卡主题名应单行不折行（实测高 ${h.nameH.toFixed(1)}px）`);
      assert.ok(h.sceneH <= 28, `${h.theme} 卡场景短语应单行不折行（实测高 ${h.sceneH.toFixed(1)}px）`);
      assert.ok(h.headH <= 30, `${h.theme} 卡卡头应单行（实测高 ${h.headH.toFixed(1)}px）`);
      assert.ok(h.gapRadioName <= 40, `${h.theme} 卡 radio 与主题名应相邻（实测间距 ${h.gapRadioName.toFixed(1)}px）`);
    }
    console.log('✅ ⑦ 卡头版式：radio 未被撑宽、主题名/场景短语单行、与 radio 相邻（真浏览器量测）');
    // ===== ⑧ 缩略图不横向裁切（2026-11-06 复核阻断项）=====
    // 卡宽随机型栅格（auto-fit minmax(200px,1fr)）随视口收窄，固定缩放（.35）在 ≤1250px 视口会把页面右栏
    // 裁掉——而「双栏紧凑 vs 杂志展示」的版式对比正是本卡缩略图的唯一目的。缩放改为随框宽自适应
    // （scale = min(.35, 框宽/页宽)），此处逐视口逐卡量测钉住：缩放后 iframe 视觉宽 ≤ 缩略图框内容宽。
    for (const vw of [1440, 1280, 1024, 900, 768, 375]) {
      await page.setViewportSize({ width: vw, height: 900 });
      const thumbs = await page.$$eval('.ob-tcard', (cards) => cards.map((c) => {
        const t = c.querySelector('.ob-tthumb');
        const f = c.querySelector('iframe');
        const fr = f.getBoundingClientRect();
        return { theme: c.getAttribute('data-theme'), boxW: t.clientWidth, ifrW: fr.width };
      }));
      for (const t of thumbs) {
        assert.ok(t.ifrW <= t.boxW + 0.5,
          `${t.theme} 卡缩略图在 ${vw}px 视口不得横向裁切（缩放后 ${t.ifrW.toFixed(1)}px > 框宽 ${t.boxW}px）`);
        assert.ok(t.ifrW > 40,
          `${t.theme} 卡缩略图在 ${vw}px 视口不得缩到不可读（实测 ${t.ifrW.toFixed(1)}px）`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    console.log('✅ ⑧ 缩略图逐视口不横向裁切（1440/1280/1024/900/768/375，缩放后宽 ≤ 框宽）');
    // 选中态：默认 classic 选中；点 dual 卡后 dual 选中且边框色与未选中卡不同
    const borderOf = (theme) => page.$eval(`.ob-tcard[data-theme="${theme}"]`, (el) => getComputedStyle(el).borderTopColor);
    const classicBorder0 = await borderOf('classic');
    const dualBorder0 = await borderOf('dual');
    assert.notEqual(classicBorder0, dualBorder0, '选中卡与未选中卡的边框色应不同（选中态可见）');
    await page.check('.ob-tcard[data-theme="dual"] input[name="theme"]');
    assert.ok(await page.isChecked('.ob-tcard[data-theme="dual"] input[name="theme"]'), '点 dual 卡应选中 dual');
    assert.notEqual(await borderOf('dual'), dualBorder0, '选中后 dual 卡边框色应变化（选中态）');
    // 提交 → 一步写 meta.theme
    await page.click('.ob-form button[type="submit"]');
    await page.waitForURL('**/edit?id=*', { timeout: 15000 });
    const editId = new URL(page.url()).searchParams.get('id');
    assert.equal(editId, D3, '完成后应跳本文档的编辑器');
    assert.equal(metaAll()[D3].theme, 'dual', '浏览器段选模板后 meta.theme 应为 dual');
    await page.waitForSelector('style[data-theme="dual"]', { state: 'attached', timeout: 10000 });
    console.log('✅ 浏览器段：四张卡缩略图真渲染（.sheet + 各自主题）+ 选中态可见 + 选中即随完成写入 meta.theme');
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('✅ 批1 0.8 选模板 + 批5 第四主题：四卡 + 同装配缩略图（逐字节相等）+ 一步写 meta.theme + 未知主题 400 零写');
} catch (e) {
  cleanup();
  fail(String((e && e.stack) || e));
}
cleanup();
