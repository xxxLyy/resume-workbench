// test-theme-picker-ui.mjs — S6-A2 模板库 B：主题选择 UI（单/双栏标签+受众一句+真实渲染缩略图+切换语义）
// 验收口径（卡片原文，逐条进断言）：
//   ① GET /theme-preview?id=&theme= 只读：响应前后 docs/<id>.html 与 docs-meta.json sha1 不变；
//      输出「当前正文+候选主题」装配（data-theme=<theme>，CSS 与 themes 文件 sha1 一致）；
//   ② id 过 VALID_ID 闸门（缺失/非法 → 400）；theme ∈ listThemes() 否则 400 且列可用主题名；
//      CSP 沿用 /snapshot/view 的锁定口径（default-src 'none'）；
//   ③ POST /theme/apply（sendJson）写 docs-meta.theme：选择后 meta.theme 变更且 GET /edit 重装配生效
//      （data-theme 变更）；非法 theme/非法 id/缺文档 → 400/404；
//   ④ 编辑器右栏「模板」入口：每主题一张卡 = 单/双栏标签 + 一句受众描述 + scaled iframe 真实渲染
//      当前文档（iframe 加载成功：contentDocument 内有 .sheet）；双栏卡带一行事实安抚；
//   ⑤ 切换语义文案：确认框明示「正文与排版微调保留，主题维度以新主题默认为准」；
//      无 ATS 恐吓/打分/警告弹窗措辞。
// 隔离：mkdtemp 根 + 随机端口 + assembleTemplate 合成文档；真实数据禁写禁删；Chromium 缺失 → exit(2)（套件惯例）。
// 先红形态：/theme-preview 404（端点不存在）+ /edit 无「模板」页签。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assembleTemplate } from '../../template.mjs';
import { sha1 } from '../../freeze.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const sha1f = (p) => sha1(fs.readFileSync(p));

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-theme-ui-' + tag + '-'));
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
  const metaPath = path.join(root, 'docs-meta.json');
  const all = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  all[id] = { rev: 1, theme: 'classic', styleHash: sha1(assembleTemplate('classic').match(/<style[^>]*>([\s\S]*?)<\/style>/)[1]), typo: '', schemaVersion: 1, kind: 'master', flow: 'draft', archivedAt: null };
  fs.writeFileSync(metaPath, JSON.stringify(all));
};
const setMetaTheme = (root, id, theme) => {
  const metaPath = path.join(root, 'docs-meta.json');
  const all = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  all[id].theme = theme;
  fs.writeFileSync(metaPath, JSON.stringify(all));
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
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text(), headers: r.headers }; },
    postJson: async (p, body) => {
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.text() };
    },
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

  // ===== ①+② /theme-preview：只读 + 闸门 + 装配输出 =====
  const beforeDoc = sha1f(docFile), beforeMeta = sha1f(metaFile);
  const pv = await sv.get('/theme-preview?id=doc1&theme=dual');
  assert.equal(pv.status, 200, '/theme-preview 应 200（先红：端点 404）');
  assert.equal(sha1f(docFile), beforeDoc, '/theme-preview 不得写 docs/<id>.html（只读性）');
  assert.equal(sha1f(metaFile), beforeMeta, '/theme-preview 不得写 docs-meta.json（只读性）');
  assert.ok(pv.html.includes('<style data-theme="dual">'), '预览应含候选主题装配块 data-theme="dual"');
  const dualCss = fs.readFileSync(path.join(APP_ROOT, 'themes', 'resume-dual.css'), 'utf8');
  const pvMain = /<style data-theme="dual">([\s\S]*?)<\/style>/.exec(pv.html);
  assert.ok(pvMain && sha1(pvMain[1]) === sha1(dualCss), '预览内联 CSS sha1 应与 themes/resume-dual.css 一致');
  assert.ok(pv.html.includes('合成'), '预览应承载当前正文（合成文档内容）');
  assert.ok(!/contenteditable/i.test(pv.html), '预览应为只读态（无 contenteditable）');
  assert.ok((pv.headers.get('content-security-policy') || '').includes("default-src 'none'"), '预览 CSP 应沿用 /snapshot/view 锁定口径（default-src \'none\'）');
  // 只读性：换一个主题再预览，仍然零写
  const pv2 = await sv.get('/theme-preview?id=doc1&theme=classic');
  assert.equal(pv2.status, 200, 'classic 预览应 200');
  assert.equal(sha1f(docFile), beforeDoc, 'classic 预览同样零写 docs');
  assert.equal(sha1f(metaFile), beforeMeta, 'classic 预览同样零写 meta');
  console.log('✅ ① /theme-preview 只读（前后 docs 与 docs-meta sha1 不变）且输出候选主题装配');

  for (const bad of ['/theme-preview?theme=dual', '/theme-preview?id=..%2Fdoc1&theme=dual', '/theme-preview?id=DOC1&theme=dual']) {
    const r = await sv.get(bad);
    assert.equal(r.status, 400, `非法 id 应 400：${bad}`);
  }
  const evil = await sv.get('/theme-preview?id=doc1&theme=evil');
  assert.equal(evil.status, 400, '未知 theme=evil 应 400');
  assert.ok(/可用主题/.test(evil.html) && evil.html.includes('classic') && evil.html.includes('dual'), '400 应列可用主题名：' + evil.html.slice(0, 160));
  const gone = await sv.get('/theme-preview?id=doc-none&theme=dual');
  assert.equal(gone.status, 404, '缺文档应 404');
  console.log('✅ ② VALID_ID 闸门（缺失/路径形态/非法字符 400）+ 未知主题 400 列主题名 + 缺文档 404');

  // ===== ③ POST /theme/apply：写 meta.theme + 重装配生效 =====
  const ap = await sv.postJson('/theme/apply', { id: 'doc1', theme: 'dual' });
  assert.equal(ap.status, 200, '/theme/apply 应 200：' + ap.body.slice(0, 160));
  assert.deepEqual(JSON.parse(ap.body), { ok: true, theme: 'dual' });
  assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).doc1.theme, 'dual', 'meta.theme 应写为 dual');
  const served = await sv.get('/edit?id=doc1');
  assert.ok(served.html.includes('<style data-theme="dual">'), '选择后 GET /edit 应按新主题重装配（A1 服务装配）');
  // 非法输入
  const apEvil = await sv.postJson('/theme/apply', { id: 'doc1', theme: 'evil' });
  assert.equal(apEvil.status, 400, '未知 theme 应 400');
  assert.ok(/可用主题/.test(apEvil.body) && apEvil.body.includes('classic'), '400 应列可用主题名');
  const apBadId = await sv.postJson('/theme/apply', { id: '..%2Fdoc1', theme: 'dual' });
  assert.equal(apBadId.status, 400, '非法 id 应 400');
  const apGone = await sv.postJson('/theme/apply', { id: 'doc-none', theme: 'dual' });
  assert.equal(apGone.status, 404, '缺文档应 404');
  assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).doc1.theme, 'dual', '失败请求不写 meta');
  setMetaTheme(root, 'doc1', 'classic');   // 复位，供浏览器段从 classic 出发
  console.log('✅ ③ POST /theme/apply 写 meta.theme 且 /edit 重装配生效；非法 theme/id/缺文档 400/404 且零写');

  // ===== ④+⑤ 浏览器段：模板入口 + 主题卡 + iframe 真渲染 + 确认切换 =====
  let bin;
  try { bin = (await import('../../chromium.mjs')).resolveChromium ? await (await import('../../chromium.mjs')).resolveChromium() : null; }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过浏览器段：' + (e && e.message || e)); cleanup(); process.exit(2); }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  const dialogs = [];
  ctx.on('page', (p) => { p.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); }); });
  const page = await ctx.newPage();
  try {
    await page.goto(sv.base + '/edit?id=doc1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#ed-rtabs', { timeout: 15000 });
    const tab = await page.$('#ed-rtabs button[data-pane="theme"]');
    assert.ok(tab, '右栏应有「模板」页签（先红：无模板入口）');
    await tab.click();
    await page.waitForSelector('#ed-pane-theme.on', { timeout: 5000 });
    const cards = await page.$$('#ed-pane-theme .ed-tcard');
    assert.ok(cards.length >= 2, '每主题一张卡（实测 ' + cards.length + '）');
    // 标签 + 受众一句
    const paneText = await page.$eval('#ed-pane-theme', (el) => el.textContent);
    assert.ok(/双栏/.test(paneText) && /单栏/.test(paneText), '主题卡应含单/双栏标签');
    assert.ok(/适合|用于|想|需要/.test(paneText), '主题卡应含一句受众描述');
    // 双栏事实安抚 + 无 ATS 恐吓/打分
    const dualCard = await page.$eval('#ed-pane-theme .ed-tcard[data-theme="dual"]', (el) => el.textContent);
    assert.ok(/纯文本/.test(dualCard), '双栏卡应有一行事实安抚（纯文本 PDF）');
    assert.ok(!/ATS|琥珀|评分|兼容度|百分|分/.test(paneText), '不得出现 ATS 恐吓/打分措辞');
    // iframe 真实渲染：每张卡一个 iframe 且加载出 .sheet
    const loaded = await page.waitForFunction(() => {
      const fs2 = [...document.querySelectorAll('#ed-pane-theme .ed-tthumb iframe')];
      return fs2.length >= 2 && fs2.every((f) => { try { return !!(f.contentDocument && f.contentDocument.querySelector('.sheet')); } catch { return false; } });
    }, null, { timeout: 15000 }).then(() => true).catch(() => false);
    assert.ok(loaded, '缩略图 iframe 应真实渲染出当前文档（contentDocument 有 .sheet）');
    const dualFrameTheme = await page.$eval('#ed-pane-theme .ed-tcard[data-theme="dual"] iframe', (f) => {
      const s = f.contentDocument && f.contentDocument.querySelector('style[data-theme]');
      return s ? s.getAttribute('data-theme') : '';
    });
    assert.equal(dualFrameTheme, 'dual', '双栏卡 iframe 应渲染 dual 主题装配');
    // 切换：确认框文案（切换语义）→ 确认 → meta 变更 + 重装配生效
    await page.$eval('#ed-pane-theme .ed-tcard[data-theme="dual"] button.ed-tapply', (b) => b.click());
    await page.waitForFunction(() => true, null, { timeout: 300 }).catch(() => {});
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try { if (JSON.parse(fs.readFileSync(metaFile, 'utf8')).doc1.theme === 'dual') break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(JSON.parse(fs.readFileSync(metaFile, 'utf8')).doc1.theme, 'dual', '确认后 meta.theme 应变更');
    const dlg = dialogs.join('\n');
    assert.ok(dlg.includes('正文') && dlg.includes('排版微调') && dlg.includes('主题'), '确认框应明示切换语义（正文与排版微调保留/主题维度以新主题为准）：' + dlg.slice(0, 200));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('style[data-theme="dual"]', { state: 'attached', timeout: 10000 });   // <style> 永远不可见：等 attached
    console.log('✅ ④⑤ 模板页签/主题卡/iframe 真渲染/双栏事实安抚/确认切换（meta.theme 变更 + 重载 data-theme=dual）');
  } finally {
    await browser.close().catch(() => {});
  }

  console.log('✅ S6-A2 test-theme-picker-ui：预览只读/闸门/选择写 meta 重装配/模板 UI/切换语义 全部通过');
} catch (e) {
  cleanup();
  fail(String((e && e.stack) || e));
}
cleanup();
