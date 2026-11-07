// test-themes-compact.mjs — 批 5 第 2 项：resume-compact 第四主题（themes/ 加法边界，DESIGN.md §7；装配口径照 A1）
// 验收口径（卡片原文，逐条进断言）：
//   ① listThemes() 恰含四主题（classic/compact/dual/magazine，文件名白名单）；themes/resume-compact.css 在场，
//      自带最小 print 隐藏规则（S2 交接清单，test-structure.sh 对 themes/resume-*.css 的无条件检查同口径）；
//      themeCss('compact') 原文与文件逐字节一致。
//   ② 装配三路径（A1 口径：数据源 = meta.theme，命中 listThemes 白名单）：
//      a) GET /edit 服务 HTML 主样式 data-theme="compact"，内联 CSS sha1 == themes/resume-compact.css，
//         freeze 口径 styleHash（normalizeToCurrent）同值；
//      b) 渲染输入按 meta.theme 装配（假渲染器捕获，render.mjs 冻结零改动）主样式 sha1 == compact 文件；
//      c) 手动保存的冻结快照主样式 sha1 == compact 文件（主题 CSS 随快照冻结）。
//   ③ /theme/apply compact 写 meta.theme（只写 theme 字段）；/theme-preview?theme=compact 200 且装配 compact，
//      前后 docs/<id>.html 与 docs-meta.json sha1 不变（只读）。
//   ④ 向导 0.8「选一套模板」多一张卡：ob-tcard 恰四张，含 compact 卡（主题名「紧凑单栏」+ 场景短语「单栏装更多」），
//      compact 卡内嵌 srcdoc 与 GET /theme-preview 响应体逐字节相等（DESIGN.md §10.1 装配单一实现）。
//   ⑤ 模板页签数据源：/edit 壳 window.__THEME_INFO__.themes 含 compact 且 current 同步（listThemes 下发）；
//      editor-shell.js THEME_META 含 compact 卡片名（客户端渲染行为由 test-theme-picker-ui 浏览器段覆盖，
//      此处为源级钉值：页签标签「单栏·紧凑」不落兜底「主题」）。
//   ⑥ classic 零回归：classic 文档 /edit 服务输出主样式块与磁盘逐字节一致。
// 隔离：mkdtemp 根 + 随机端口 + assembleTemplate 合成文档 + 向导自身产出合成文档 + 假渲染器；
// 真实数据禁写禁删；零浏览器（无 Chromium 依赖）。
// 先红形态：无 themes/resume-compact.css → ① 缺文件即红；向导卡仍三张 → ④ 红。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assembleTemplate, listThemes, themeCss } from '../../template.mjs';
import { sha1, normalizeToCurrent } from '../../freeze.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const sha1f = (p) => sha1(fs.readFileSync(p));
const PRINT_LINE = '@media print { .edit-toolbar, .page-line, .toast, .recovery-bar { display: none !important; } }';

// 主样式块提取（与 freeze.mjs mainStyles 同序：首个非 typo-custom 的 <style>）
function mainStyleOf(html) {
  const all = [...String(html).matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)];
  const m = all.find((x) => !/\bid\s*=\s*["']typo-custom["']/i.test(x[1]));
  return m ? { attrs: m[1], css: m[2], whole: m[0] } : null;
}

const compactPath = path.join(APP_ROOT, 'themes', 'resume-compact.css');

// ===== ① 主题白名单与文件契约（不依赖服务，先红第一现场）=====
assert.deepEqual(listThemes(), ['classic', 'compact', 'dual', 'magazine'],
  'listThemes 应恰含四主题（文件名白名单），实际 ' + JSON.stringify(listThemes()));
assert.ok(fs.existsSync(compactPath), '缺 themes/resume-compact.css（批 5 第 2 项交付物）');
const compactCss = fs.readFileSync(compactPath, 'utf8');
assert.equal(themeCss('compact'), compactCss, "themeCss('compact') 应与文件逐字节一致");
assert.ok(compactCss.includes(PRINT_LINE), 'compact 主题应自带最小 print 隐藏规则（S2 交接清单）');
assert.ok(compactCss.includes('@page') && compactCss.includes('.sheet'), 'compact 主题内容可疑（应含 @page/.sheet）');
console.log('✅ ① listThemes 四主题白名单 + themes/resume-compact.css 在场（print 规则/内容锚点/themeCss 逐字节）');

// ===== 隔离根 + 服务 =====
const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-theme-compact-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs-meta.json'), '{}');
  fs.writeFileSync(path.join(root, 'applications.json'), '[]');
  fs.writeFileSync(path.join(root, 'materials.json'), '[]');
  return root;
};

// 假渲染器：把净化后的渲染输入拷进捕获目录（渲染路径断言），再产假 PDF + 旁车（A1 夹具同款）
const makeFakeRenderer = (root, captureDir) => {
  const p = path.join(root, 'fake-render.cjs');
  fs.writeFileSync(p, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const a = process.argv.slice(2);",
    "const src = a[a.indexOf('--src') + 1];",
    "const out = a[a.indexOf('--out') + 1];",
    "const cap = process.env.RESUME_THEME_FIXTURE_CAPTURE;",
    "const base = path.basename(out).replace(/\\.stage-.*/, '');",
    "if (cap) { try { fs.mkdirSync(cap, { recursive: true }); fs.copyFileSync(src, path.join(cap, base + '.input.html')); } catch (e) { try { fs.writeFileSync(out + '.capture-err.txt', String(e && e.stack || e)); } catch {} } }",
    "fs.writeFileSync(out, Buffer.alloc(3000, 0x25));",
    "fs.writeFileSync(out + '.env.json', JSON.stringify({ renderInputId: process.env.RESUME_RENDER_INPUT_ID || null, at: new Date().toISOString() }));",
    "process.exit(0);",
    ""
  ].join('\n'));
  fs.chmodSync(p, 0o755);
  return p;
};

const startServer = async (root, captureDir) => {
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
    cwd: APP_ROOT,
    env: {
      ...process.env, RESUME_ROOT: root, PORT: String(port),
      RESUME_RENDER_BIN: makeFakeRenderer(root, captureDir),
      RESUME_THEME_FIXTURE_CAPTURE: captureDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
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
    get: async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text() }; },
    postJson: async (p, body) => {
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.text() };
    },
    kill: () => { try { server.kill('SIGKILL'); } catch {} }
  };
};

// 向导推进到 0.8（建档 + 逐跳过 0.2–0.7；test-onboarding-theme-cards 同款）
const stepJson = async (base, body) => {
  const r = await fetch(base + '/onboarding/step', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};
const advanceTo08 = async (base, name) => {
  const r0 = await stepJson(base, { step: '0.1', payload: { name: name || '紧凑主题同学' } });
  assert.equal(r0.status, 200, '0.1 应 200：' + JSON.stringify(r0));
  assert.ok(r0.docId, '0.1 建档应返回 docId');
  for (const st of ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7']) {
    const r = await stepJson(base, { step: st, docId: r0.docId, skip: true });
    assert.equal(r.status, 200, `${st} 跳过应 200：${JSON.stringify(r)}`);
  }
  return r0.docId;
};

// 卡块 → srcdoc 原字节（属性实体还原；还原顺序 & 最后；test-onboarding-theme-cards 同款）
const unescapeAttr = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const cardSrcdoc = (html, theme) => {
  const m = new RegExp('<label class="ob-tcard" data-theme="' + theme + '">([\\s\\S]*?)</label>').exec(html);
  if (!m) return null;
  const sm = /\ssrcdoc="([\s\S]*?)"/.exec(m[1]);
  return sm ? unescapeAttr(sm[1]) : null;
};

const servers = [];
const roots = [];
const cleanup = () => { for (const s of servers) s.kill(); for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} } };
process.on('exit', cleanup);

try {
  const root = mkRoot('main');
  roots.push(root);
  const capture = path.join(root, 'render-capture');
  fs.mkdirSync(capture, { recursive: true });
  const sv = await startServer(root, capture);
  servers.push(sv);
  const metaPath = path.join(root, 'docs-meta.json');

  // ===== ②③ 建档 → /theme/apply compact → 装配三路径 =====
  const rNew = await fetch(sv.base + '/new', { method: 'POST', redirect: 'manual' });
  assert.equal(rNew.status, 303, 'POST /new 应 303');
  const docId = /id=([\w-]+)/.exec(rNew.headers.get('location') || '')?.[1];
  assert.ok(docId, '/new 应重定向到 /edit?id=…');
  assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8'))[docId].theme, 'classic', '新建文档默认 classic（themeRegistration）');

  const docFile = path.join(root, 'docs', docId + '.html');
  const ap = await sv.postJson('/theme/apply', { id: docId, theme: 'compact' });
  assert.equal(ap.status, 200, '/theme/apply compact 应 200：' + ap.body.slice(0, 200));
  assert.deepEqual(JSON.parse(ap.body), { ok: true, theme: 'compact' });
  assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8'))[docId].theme, 'compact', 'meta.theme 应写为 compact');
  console.log('✅ ③a /theme/apply compact 写 meta.theme（/theme/apply 同口径：只写 theme 字段）');

  // ②a 服务装配路径
  const served = await sv.get(`/edit?id=${docId}`);
  assert.equal(served.status, 200, '/edit 应 200');
  assert.ok(served.html.includes('<style data-theme="compact">'), '装配 HTML 应含 <style data-theme="compact">\n实际主样式属性：' + (mainStyleOf(served.html)?.attrs || '(无)'));
  assert.ok(!served.html.includes('<style data-theme="classic">'), '装配 HTML 不应再保留 classic 主题块');
  const sMain = mainStyleOf(served.html);
  assert.ok(sMain, '装配 HTML 应有主样式块');
  assert.equal(sha1(sMain.css), sha1(compactCss), '装配内联 CSS sha1 应与 themes/resume-compact.css 一致');
  assert.equal(normalizeToCurrent(served.html).styleHash, sha1(compactCss), 'freeze 口径 styleHash 应为 compact 文件 sha1');
  console.log('✅ ②a /edit 服务装配按 meta.theme=compact（内联 sha1 == 文件，freeze styleHash 同值）');

  // ②b 渲染输入路径（假渲染器捕获；render.mjs 冻结零改动）
  const rr = await sv.postJson(`/render?id=${docId}`, {});
  assert.equal(rr.status, 200, 'POST /render（假渲染器）应 200：' + rr.body.slice(0, 200));
  assert.ok(fs.existsSync(path.join(root, 'pdfs', docId + '.pdf')), '渲染应产出 pdfs/<id>.pdf');
  const capFile = path.join(capture, docId + '.pdf.input.html');
  assert.ok(fs.existsSync(capFile), '假渲染器应捕获渲染输入');
  const rMain = mainStyleOf(fs.readFileSync(capFile, 'utf8'));
  assert.ok(rMain, '渲染输入应有主样式块');
  assert.equal(sha1(rMain.css), sha1(compactCss), '渲染输入内联 CSS sha1 应为 compact 文件 sha1（服务端装配时选好主题）');
  console.log('✅ ②b 渲染输入按 meta.theme=compact 装配（假渲染器捕获验证，render.mjs 零改动）');

  // ②c 冻结快照路径（手动保存触发）
  const snapDir = path.join(root, 'snapshots', docId);
  const snapBefore = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).length : 0;
  const sv1 = await sv.get(`/edit?id=${docId}`);
  const curRev = Number(JSON.parse(fs.readFileSync(metaPath, 'utf8'))[docId].rev) || 0;
  const rs = await sv.postJson(`/save?id=${docId}`, { requestId: 'b5c4-snap-1', baseRev: curRev, html: sv1.html, ops: [] });
  assert.equal(rs.status, 200, 'POST /save 应 200：' + rs.body.slice(0, 200));
  const snaps = fs.readdirSync(snapDir).filter((f) => f.endsWith('.html'));
  assert.ok(snaps.length > snapBefore || snaps.length > 0, '保存应产生旧版快照');
  const snapMain = mainStyleOf(fs.readFileSync(path.join(snapDir, snaps[snaps.length - 1]), 'utf8'));
  assert.equal(sha1(snapMain.css), sha1(compactCss), '冻结快照内联 CSS sha1 应为 compact 文件 sha1（主题 CSS 随快照冻结）');
  console.log('✅ ②c 冻结快照按 meta.theme=compact 装配（主题 CSS 随快照冻结）');

  // ③b /theme-preview 只读 + 装配 compact（零写锚点取本调用前——前面 /save 已合法落盘文档）
  const beforeDoc = sha1f(docFile), beforeMeta = sha1f(metaPath);
  const pv = await sv.get(`/theme-preview?id=${docId}&theme=compact`);
  assert.equal(pv.status, 200, '/theme-preview?theme=compact 应 200');
  assert.equal(sha1f(docFile), beforeDoc, '/theme-preview 不得写 docs/<id>.html（只读性）');
  assert.equal(sha1f(metaPath), beforeMeta, '/theme-preview 不得写 docs-meta.json（只读性）');
  const pvMain = /<style data-theme="compact">([\s\S]*?)<\/style>/.exec(pv.html);
  assert.ok(pvMain && sha1(pvMain[1]) === sha1(compactCss), '预览内联 CSS sha1 应与 themes/resume-compact.css 一致');
  console.log('✅ ③b /theme-preview?theme=compact 200 + 装配 compact + 前后零写（docs 与 meta sha1 不变）');

  // ===== ④ 向导 0.8 多一张卡（四张，含 compact：主题名 + 场景短语 + 同装配 srcdoc）=====
  const D1 = await advanceTo08(sv.base, '紧凑主题同学');
  const page08 = await sv.get('/onboarding?docId=' + D1);
  assert.equal(page08.status, 200, '0.8 页应 200');
  assert.ok(page08.html.includes('data-ob-next="0.8"'), '应渲染 0.8 步');
  assert.equal((page08.html.match(/class="ob-tcard"/g) || []).length, 4, '0.8 模板卡应恰四张（批 5 第四主题后），实际 ' + (page08.html.match(/class="ob-tcard"/g) || []).length);
  const pageText = page08.html.replace(/<[^>]+>/g, ' ');
  for (const name of ['经典单栏', '双栏紧凑', '杂志展示', '紧凑单栏']) {
    assert.ok(pageText.includes(name), `0.8 模板卡应带主题名「${name}」`);
  }
  for (const scene of ['通用', '经历多一页排满', '展示向', '单栏装更多']) {
    assert.ok(pageText.includes(scene), `0.8 模板卡应带场景短语「${scene}」`);
  }
  assert.ok(cardSrcdoc(page08.html, 'compact') != null, '0.8 应有 compact 卡');
  const embedded = cardSrcdoc(page08.html, 'compact');
  const pvC = await sv.get(`/theme-preview?id=${D1}&theme=compact`);
  assert.equal(pvC.status, 200, '/theme-preview?theme=compact 应 200');
  assert.equal(embedded, pvC.html, 'compact 卡内嵌 srcdoc 应与 GET /theme-preview 响应体逐字节相等（装配单一实现）');
  console.log('✅ ④ 向导 0.8 恰四张卡：compact 卡（紧凑单栏/单栏装更多）+ srcdoc 与 /theme-preview 逐字节相等');

  // ===== ⑤ 模板页签数据源：__THEME_INFO__ 下发 compact；editor-shell THEME_META 卡片名 =====
  const infoMatch = /window\.__THEME_INFO__=(\{[\s\S]*?\});<\/script>/.exec(served.html);
  assert.ok(infoMatch, '/edit 壳应下发 window.__THEME_INFO__');
  const themeInfo = JSON.parse(infoMatch[1]);
  assert.deepEqual(themeInfo.themes, ['classic', 'compact', 'dual', 'magazine'], '__THEME_INFO__.themes 应为 listThemes 全量');
  assert.equal(themeInfo.current, 'compact', '__THEME_INFO__.current 应随 meta.theme');
  const shellSrc = fs.readFileSync(path.join(APP_ROOT, 'editor-shell.js'), 'utf8');
  assert.ok(/compact:\s*\{\s*label:\s*'单栏·紧凑'\s*\}/.test(shellSrc), "editor-shell.js THEME_META 应含 compact 卡片名「单栏·紧凑」（不落兜底「主题」）");
  console.log('✅ ⑤ 模板页签数据源含 compact（__THEME_INFO__ 四主题 + current）+ THEME_META 卡片名钉值');

  // ===== ⑥ classic 零回归 =====
  const rNew2 = await fetch(sv.base + '/new', { method: 'POST', redirect: 'manual' });
  const doc2 = /id=([\w-]+)/.exec(rNew2.headers.get('location') || '')?.[1];
  assert.ok(doc2 && doc2 !== docId, '第二次 /new 应分配新 id');
  const disk2 = fs.readFileSync(path.join(root, 'docs', doc2 + '.html'), 'utf8');
  const served2 = await sv.get(`/edit?id=${doc2}`);
  assert.equal(served2.status, 200);
  assert.equal(mainStyleOf(served2.html).whole, mainStyleOf(disk2).whole, 'classic 文档服务输出的主样式块应与磁盘逐字节一致（零回归）');
  console.log('✅ ⑥ classic 文档装配零回归（服务输出主样式块与磁盘逐字节一致）');

  console.log('✅ 批5 b5c4 test-themes-compact：compact 装配三路径（服务+渲染+快照）/apply+preview/向导与页签多一张卡/classic 零回归 全部通过');
} catch (e) {
  cleanup();
  fail(String((e && e.stack) || e));
}
cleanup();   // 显式收尾：杀服务 + 删隔离根，事件循环自然排空退出
