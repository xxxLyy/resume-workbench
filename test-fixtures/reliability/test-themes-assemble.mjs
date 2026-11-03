// test-themes-assemble.mjs — S6-A1 模板库 A：新增主题 CSS 与按 meta.theme 装配（数据与渲染集成）
// 验收口径（卡片原文，逐条进断言）：
//   ① 隔离根夹具建档（POST /new）→ updateMeta theme=dual（夹具直写隔离根 docs-meta.json，synthetic 数据）→
//      GET /edit 装配 HTML 含 <style data-theme="dual"> 且内联 CSS 与 themes/resume-dual.css sha1 一致（freeze 口径）；
//   ② 渲染同源（铁律一）：假渲染器（RESUME_RENDER_BIN）捕获渲染输入 → 主样式 sha1 == dual 文件 sha1
//      （render.mjs 冻结零改动：主题在服务端装配 HTML 时选好）；
//   ③ 未知主题值 → 报错列可用主题名 且 不写脏数据（docs/ 与 docs-meta.json 字节零变化）；
//   ④ classic 文档装配零回归：GET /edit 输出与磁盘文档的主样式块逐字节一致，渲染输入同样零回归；
//   ⑤ legacy 文档（meta.theme='legacy'，T7 迁移哨兵）保留实际内联 CSS：装配输出主样式块与磁盘逐字节一致；
//   ⑥ 快照冻结主题：手动保存触发的冻结快照按 meta.theme 装配（主样式 sha1 == dual 文件 sha1）。
// 隔离：mkdtemp 根 + 随机端口 + assembleTemplate 合成文档 + 假渲染器；真实数据禁写禁删；零浏览器（无 Chromium 依赖）。
// 先红形态：现状装配调用点写死 classic → meta.theme=dual 时 /edit 仍输出 <style data-theme="classic">。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';
import { sha1, normalizeToCurrent } from '../../freeze.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const PRINT_LINE = '@media print { .edit-toolbar, .page-line, .toast, .recovery-bar { display: none !important; } }';

const themeCssFile = (name) => {
  const p = path.join(APP_ROOT, 'themes', `resume-${name}.css`);
  if (!fs.existsSync(p)) fail(`缺 themes/resume-${name}.css（S6-A1 交付物）`);
  return fs.readFileSync(p, 'utf8');
};

// 主样式块提取（与 freeze.mjs mainStyles 同序：首个非 typo-custom 的 <style>）
const MAIN_STYLE_RE = /<style\b([^>]*)>([\s\S]*?)<\/style>/i;
function mainStyleOf(html) {
  const all = [...String(html).matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi)];
  const m = all.find((x) => !/\bid\s*=\s*["']typo-custom["']/i.test(x[1]));
  return m ? { attrs: m[1], css: m[2], whole: m[0] } : null;
}

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-theme-asm-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs-meta.json'), '{}');
  fs.writeFileSync(path.join(root, 'applications.json'), '[]');
  fs.writeFileSync(path.join(root, 'materials.json'), '[]');
  return root;
};

// 假渲染器：把净化后的渲染输入拷进捕获目录（供夹具断言「渲染输入按主题装配」），再产假 PDF + 旁车
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
    "const base = path.basename(out).replace(/\\.stage-.*/, '');",   // renderDoc 渲染到 staging 路径（out + '.stage-…'），归一为产物名
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

const writeSyntheticDoc = (root, id, styleTag, meta) => {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) doc = doc.replaceAll(k, () => v);
  if (styleTag) doc = doc.replace(MAIN_STYLE_RE, () => styleTag);   // 函数替换：防 CSS 里 $& 被特殊解释
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  const metaPath = path.join(root, 'docs-meta.json');
  const all = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  all[id] = Object.assign({ rev: 1, kind: 'master', flow: 'draft', typo: '', schemaVersion: 1 }, meta);
  fs.writeFileSync(metaPath, JSON.stringify(all));
  return doc;
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

  // ===== ① 建档 → updateMeta theme=dual → 装配 HTML 按 dual 输出 =====
  const rNew = await fetch(sv.base + '/new', { method: 'POST', redirect: 'manual' });
  assert.equal(rNew.status, 303, 'POST /new 应 303');
  const docId = /id=([\w-]+)/.exec(rNew.headers.get('location') || '')?.[1];
  assert.ok(docId, '/new 应重定向到 /edit?id=…');
  const metaPath = path.join(root, 'docs-meta.json');
  const metaAll = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(metaAll[docId].theme, 'classic', '新建文档 themeRegistration 默认 classic（卡片口径，A2 前不变）');
  metaAll[docId].theme = 'dual';   // updateMeta 等价操作：夹具直写隔离根 meta（synthetic）
  fs.writeFileSync(metaPath, JSON.stringify(metaAll));

  const served = await sv.get(`/edit?id=${docId}`);
  assert.equal(served.status, 200, '/edit 应 200');
  // 先红断言（现状装配写死 classic → 此处红）：先钉行为，再比对交付物 CSS
  assert.ok(served.html.includes('<style data-theme="dual">'), '装配 HTML 应含 <style data-theme="dual">（现状仍输出 classic → S6-A1 先红）\n实际主样式属性：' + (mainStyleOf(served.html)?.attrs || '(无)'));
  assert.ok(!served.html.includes('<style data-theme="classic">'), '装配 HTML 不应再保留 classic 主题块');
  const dualCss = themeCssFile('dual');
  const sMain = mainStyleOf(served.html);
  assert.ok(sMain, '装配 HTML 应有主样式块');
  assert.equal(sha1(sMain.css), sha1(dualCss), '装配内联 CSS sha1 应与 themes/resume-dual.css 一致');
  assert.equal(normalizeToCurrent(served.html).styleHash, sha1(dualCss), 'freeze 口径 styleHash 应为 dual 文件 sha1');
  assert.ok(sMain.css.includes(PRINT_LINE) || dualCss.includes(PRINT_LINE), 'dual 主题自带最小 print 隐藏规则');
  console.log('✅ ① meta.theme=dual → /edit 装配 HTML 含 data-theme="dual" 且内联 CSS sha1 与 themes/resume-dual.css 一致（freeze 口径）');

  // ===== ② 渲染同源：渲染输入按 meta.theme 装配（render.mjs 冻结零改动）=====
  const rr = await sv.postJson(`/render?id=${docId}`, {});
  assert.equal(rr.status, 200, 'POST /render（假渲染器）应 200：' + rr.body.slice(0, 200));
  assert.ok(fs.existsSync(path.join(root, 'pdfs', docId + '.pdf')), '渲染应产出 pdfs/<id>.pdf');
  const capFile = path.join(capture, docId + '.pdf.input.html');
  assert.ok(fs.existsSync(capFile), '假渲染器应捕获渲染输入');
  const rMain = mainStyleOf(fs.readFileSync(capFile, 'utf8'));
  assert.ok(rMain, '渲染输入应有主样式块');
  assert.equal(sha1(rMain.css), sha1(dualCss), '渲染输入内联 CSS sha1 应为 dual 文件 sha1（服务端装配时选好主题）');
  console.log('✅ ② 渲染输入按 meta.theme 装配（假渲染器捕获验证，render.mjs 零改动）');

  // ===== ③ 未知主题值：报错列可用主题名 且 不写脏数据 =====
  const bogusId = 'docbogus';
  const bogusDoc = writeSyntheticDoc(root, bogusId, null, { theme: 'no-such-theme', styleHash: '' });
  const before = {
    doc: fs.readFileSync(path.join(root, 'docs', bogusId + '.html'), 'utf8'),
    meta: fs.readFileSync(metaPath, 'utf8'),
    docs: fs.readdirSync(path.join(root, 'docs')).sort()
  };
  const rb = await sv.get(`/edit?id=${bogusId}`);
  assert.ok(rb.status >= 400, '未知主题 GET /edit 应报错（实测 ' + rb.status + '）');
  assert.ok(/可用主题/.test(rb.html) && rb.html.includes('classic'), '报错应列出可用主题名（含 classic）：' + rb.html.slice(0, 200));
  assert.equal(fs.readFileSync(path.join(root, 'docs', bogusId + '.html'), 'utf8'), before.doc, '报错路径不写文档');
  assert.equal(fs.readFileSync(metaPath, 'utf8'), before.meta, '报错路径不写 meta（不写脏数据）');
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs')).sort(), before.docs, '报错路径不新增文件');
  console.log('✅ ③ 未知主题值 → 报错列可用主题名且不写脏数据（docs/ 与 docs-meta.json 字节零变化）');

  // ===== ④ classic 文档装配零回归（服务与渲染两条装配路径）=====
  const rNew2 = await fetch(sv.base + '/new', { method: 'POST', redirect: 'manual' });
  const doc2 = /id=([\w-]+)/.exec(rNew2.headers.get('location') || '')?.[1];
  assert.ok(doc2 && doc2 !== docId, '第二次 /new 应分配新 id');
  const disk2 = fs.readFileSync(path.join(root, 'docs', doc2 + '.html'), 'utf8');
  const served2 = await sv.get(`/edit?id=${doc2}`);
  assert.equal(served2.status, 200);
  const dMain = mainStyleOf(disk2);
  const s2Main = mainStyleOf(served2.html);
  assert.equal(s2Main.whole, dMain.whole, 'classic 文档服务输出的主样式块应与磁盘逐字节一致（零回归）');
  assert.equal(sha1(s2Main.css), sha1(fs.readFileSync(path.join(APP_ROOT, 'themes', 'resume-classic.css'), 'utf8')), 'classic 内联 sha1 == themes/resume-classic.css');
  const rc2 = await sv.postJson(`/render?id=${doc2}`, {});
  assert.equal(rc2.status, 200, 'classic 文档渲染应 200');
  const cap2 = mainStyleOf(fs.readFileSync(path.join(capture, doc2 + '.pdf.input.html'), 'utf8'));
  assert.equal(sha1(cap2.css), sha1(dMain.css), 'classic 渲染输入主样式应与磁盘一致（渲染零回归）');
  console.log('✅ ④ classic 文档装配零回归（服务输出与渲染输入主样式块均与磁盘逐字节一致）');

  // ===== ⑤ legacy 文档（T7 哨兵）保留实际内联 CSS，不做迁移 =====
  const legId = 'doclegacy';
  const legCss = '  @page { size: A4; margin: 0; }\n  .sheet { width: 210mm; background: #fff; }\n  h1 { color: #222; }\n' + PRINT_LINE + '\n';
  writeSyntheticDoc(root, legId, `<style data-style-origin="legacy-inline">${legCss}</style>`, { theme: 'legacy', styleHash: sha1(legCss) });
  const legDisk = fs.readFileSync(path.join(root, 'docs', legId + '.html'), 'utf8');
  const legServed = await sv.get(`/edit?id=${legId}`);
  assert.equal(legServed.status, 200, 'legacy 文档 /edit 应 200（不抛未知主题错）');
  assert.equal(mainStyleOf(legServed.html).whole, mainStyleOf(legDisk).whole, 'legacy 文档装配输出主样式块应与磁盘逐字节一致（保留实际内联 CSS）');
  const rl = await sv.postJson(`/render?id=${legId}`, {});
  assert.equal(rl.status, 200, 'legacy 文档渲染应 200');
  const capL = mainStyleOf(fs.readFileSync(path.join(capture, legId + '.pdf.input.html'), 'utf8'));
  assert.equal(sha1(capL.css), sha1(legCss), 'legacy 渲染输入保留实际内联 CSS');
  console.log('✅ ⑤ legacy 文档保留实际内联 CSS（服务与渲染两条路径均逐字节一致）');

  // ===== ⑥ 快照冻结主题：手动保存触发的冻结快照按 meta.theme 装配 =====
  const snapDir = path.join(root, 'snapshots', docId);
  const snapBefore = fs.existsSync(snapDir) ? fs.readdirSync(snapDir).length : 0;
  const sv1 = await sv.get(`/edit?id=${docId}`);
  const curRev = Number(JSON.parse(fs.readFileSync(metaPath, 'utf8'))[docId].rev) || 0;   // /new 未写 rev → 0
  const rs = await sv.postJson(`/save?id=${docId}`, { requestId: 's6a1-snap-1', baseRev: curRev, html: sv1.html, ops: [] });
  assert.equal(rs.status, 200, 'POST /save 应 200：' + rs.body.slice(0, 200));
  const snaps = fs.readdirSync(snapDir).filter((f) => f.endsWith('.html'));
  assert.ok(snaps.length > snapBefore || snaps.length > 0, '保存应产生旧版快照');
  const snapMain = mainStyleOf(fs.readFileSync(path.join(snapDir, snaps[snaps.length - 1]), 'utf8'));
  assert.equal(sha1(snapMain.css), sha1(dualCss), '冻结快照内联 CSS sha1 应为 dual 文件 sha1（快照冻结主题 CSS）');
  console.log('✅ ⑥ 冻结快照按 meta.theme 装配（主题 CSS 随快照冻结）');

  console.log('✅ S6-A1 test-themes-assemble：dual 装配（服务+渲染+快照三路径）/ 未知主题报错不写盘 / classic 零回归 / legacy 保留 全部通过');
} catch (e) {
  cleanup();
  fail(String((e && e.stack) || e));
}
cleanup();   // 显式收尾：杀服务（close stdio 管道）+ 删隔离根，事件循环自然排空退出
