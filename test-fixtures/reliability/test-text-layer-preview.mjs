// test-text-layer-preview.mjs — 批 2「文本层预览」卡片 b2c2（导出页折叠区「机器读到的样子」）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §3 批 2（ATS 诚实检查包 · 文本层预览：
//       「文本层预览：导出页折叠区「机器读到的样子」= 服务端 pdftotext 结果原样展示（能力已存在，纯展示）；无分数无结论」）
//       + §0.1（诚实版：规则检查 + 文本层预览；不做「通过」徽章；不做 ATS 打分 / 录用概率）
// 覆盖（断言逐条独立，便于逐条复核）：
//   A 折叠区在场：导出页有 <details id="textLayerPreview">，summary = 「机器读到的样子」，默认折叠、点击可展开。
//   B 原样展示：折叠区 <pre data-layer-preview> 的文本 = 服务端 pdftotext 输出的字节内容（逐字相等；
//     浏览器端 textContent 亦相等 → HTML 转义/解析不吞字符、不改写内容）。
//   C 无分数无结论：折叠区内不得出现评分/得分/通过/概率一类结论词，也不得出现百分制分数。
//   D 字符量告警口径沿用：折叠区内的字符量行与「渲染检查」行的字符量与告警文案逐字一致（同一实现、同一阈值）；
//     源级钉值：告警文案在 server.mjs 只有一处定义（单一出处，不新增第二套阈值/文案）。
//   E 诚实空态：PDF 文本层取不到时不编造文本（只说取不到）；没有 PDF 时同理，且不得给出字符量结论。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成 PDF/文档；不读真实简历、不碰 7766、不调真实模型；仓库零写入。
// 隐私门禁：合成数据不含 11 位手机号形态（1[3-9]\d{9}）与 13 位时间戳（长数字第二位避开 3-9）。
// 退出码契约：0=全部通过；1=任一断言失败；2=仅 Chromium 不可用且此前无失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { freezeHtml } from '../../freeze.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-text-layer-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'applications.json'), '[]');
fs.writeFileSync(path.join(root, 'materials.json'), '[]');

// ===== 合成 PDF（程序化计算 xref 偏移；pdftotext 可提取 ASCII 文本层）=====
const makePdf = (lines) => {
  const body = lines.map((t, i) => (i ? '0 -20 Td ' : '') + '(' + t + ') Tj').join(' ');
  const stream = 'BT /F1 12 Tf 72 720 Td ' + body + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
};

// ===== 合成文档（模板装配 + 占位符替换；无手机号形态、无长数字串）=====
const entry = (title, role, date, bullets) =>
  `<div class="entry-head"><div class="entry-title">${title}</div><div class="entry-role">${role}</div><div class="entry-date">${date}</div></div>\n      <ul>\n${bullets.map((b) => `<li>${b}</li>`).join('\n')}\n      </ul>`;
const DOC = {
  name: '合成简历丙',
  contact: '邮箱：synth.tlp@example.com ｜ 主页：https://synth.example.com',
  summary: '合成个人总结',
  skills: '<p>后端开发：Go / 分布式</p>',
  work: entry('合成丙科技有限公司', '后端工程师', '2023.07 - 至今', ['负责合成平台的接口性能优化与稳定性建设']),
  projects: entry('合成调度平台', '负责人', '2024.05 - 2024.10', ['建设合成调度平台的核心链路与灰度能力']),
  edu: entry('合成大学', '本科 · 计算机', '2019.09 - 2023.06', [])
};
const buildDoc = (docId) => {
  let doc = assembleTemplate('classic');
  const map = [['{{NAME}}', DOC.name], ['{{CONTACT}}', DOC.contact], ['{{INTENT}}', ''], ['{{SUMMARY}}', DOC.summary],
    ['{{SKILLS}}', DOC.skills], ['{{WORK}}', DOC.work], ['{{PROJECTS}}', DOC.projects], ['{{EDU}}', DOC.edu], ['{{DOC_ID}}', docId]];
  for (const [k, v] of map) doc = doc.replaceAll(k, () => v);
  return doc;
};

// ===== 三份文档：① 有可读文本层的 PDF ② PDF 读不出文本层 ③ 没有 PDF =====
const TXT_ID = 'tlptext';    // 合成 PDF，pdftotext 可提取两行文本
const BAD_ID = 'tlpbad';     // 假 PDF（pdftotext 失败）
const NOPDF_ID = 'tlpnopdf'; // 没有任何 PDF
const metaPath = path.join(root, 'docs-meta.json');
const seed = (id, pdfBuf) => {
  const doc = buildDoc(id);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  if (pdfBuf) fs.writeFileSync(path.join(root, 'pdfs', id + '.pdf'), pdfBuf);
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  meta[id] = {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} }
  };
  // 渲染标识与当前文档一致 → 导出页判定 fresh，不触发重渲（本夹具不需要真渲染）
  meta[id].lastRenderInputId = freezeHtml(doc, meta[id]).renderInputId;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
};
seed(TXT_ID, makePdf(['SYNTH TEXT LAYER LINE ONE', 'SYNTH TEXT LAYER LINE TWO']));
seed(BAD_ID, Buffer.from('%PDF-1.4\n% fake pdf (no text layer)\n', 'latin1'));
seed(NOPDF_ID, null);

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  // RESUME_RENDER_BIN 指向不存在的可执行文件：③ 号文档（无 PDF）走「缺 PDF 自动重渲」时必定失败，
  // 于是导出页进入「没有 PDF」诚实空态（不依赖 Chromium，也不产出真 PDF）。
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port), RESUME_RENDER_BIN: path.join(root, 'no-such-render-bin') },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
const base = `http://127.0.0.1:${port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };

// ===== 页面解析小工具 =====
const dec = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const sectionOf = (html) => {
  const m = String(html).match(/<details[^>]*id="textLayerPreview"[^>]*>[\s\S]*?<\/details>/);
  return m ? m[0] : '';
};
// 字符量行：既有「渲染检查」行（原文 "<200"）与折叠区行（转义 "&lt;200"）两处都能取到
const CHAR_RE = /文本层字符量：(\d+)(（(?:&lt;|<)200：图文简历可忽略，否则检查文本层）)?/;

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== A. 折叠区在场 =====
  const r = await get('/export?id=' + TXT_ID);
  assert.equal(r.status, 200, '导出页应 200，实际 ' + r.status + '：' + r.text.slice(0, 200));
  const html = r.text;
  const sec = sectionOf(html);
  assert.ok(html.includes('机器读到的样子'), '导出页应有折叠区「机器读到的样子」，实际页面未出现');
  assert.ok(sec, '导出页应有 id="textLayerPreview" 的折叠区 <details>');
  assert.ok(/<summary[^>]*>\s*机器读到的样子\s*<\/summary>/.test(sec), '折叠区 summary 应为「机器读到的样子」，实际：' + sec.slice(0, 240));
  assert.ok(!/\sopen(\s|>)/.test(sec.match(/<details[^>]*>/)[0]), '折叠区应默认折叠（无 open 属性），实际：' + sec.match(/<details[^>]*>/)[0]);

  // ===== B. 原样展示：pdftotext 输出逐字呈现 =====
  const pdfFile = path.join(root, 'pdfs', TXT_ID + '.pdf');
  const raw = execFileSync('pdftotext', [pdfFile, '-'], { encoding: 'utf8' });
  assert.ok(raw.includes('SYNTH TEXT LAYER LINE ONE'), '合成 PDF 应能提取文本层（夹具自检），实际：' + JSON.stringify(raw));
  const pre = sec.match(/<pre[^>]*data-layer-preview[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(pre, '折叠区应有 <pre data-layer-preview> 承载 pdftotext 原文');
  assert.equal(dec(pre[1]), raw, '折叠区展示的文本应与 pdftotext 输出逐字一致（原样展示）');

  // ===== C. 无分数无结论 =====
  const secText = dec(sec);
  for (const w of ['评分', '得分', '分数', '通过', '合格', '百分位', '概率', '录用']) {
    assert.ok(!secText.includes(w), '折叠区不得出现分数/结论类词：' + w + '（实际：' + secText.slice(0, 300) + '）');
  }
  assert.ok(!/\d+\s*\/\s*100/.test(secText), '折叠区不得出现百分制分数');

  // ===== D. 字符量告警口径沿用（同一实现、同一阈值与文案）=====
  const rowM = html.match(CHAR_RE);
  assert.ok(rowM, '渲染检查卡应保留「文本层字符量」行（既有体检口径）');
  const secM = secText.match(CHAR_RE);
  assert.ok(secM, '折叠区应给出文本层字符量（口径沿用），实际：' + secText.slice(0, 300));
  assert.equal(secM[1], rowM[1], '折叠区与渲染检查行的字符量应一致');
  assert.equal(secM[2] || '', rowM[2] || '', '折叠区与渲染检查行的告警文案应一致（同一口径）');
  assert.ok(rowM[2], '合成短文本应触发 <200 告警（阈值 200 沿用既有口径），实际：' + rowM[0]);
  {
    const srvSrc = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    assert.equal((srvSrc.match(/图文简历可忽略/g) || []).length, 1,
      '字符量告警文案在 server.mjs 只应有一处定义（口径沿用＝单一实现，不得出现第二套阈值/文案）');
  }

  // ===== E. 诚实空态 =====
  {
    const rb = await get('/export?id=' + BAD_ID);
    assert.equal(rb.status, 200, '② 号文档导出页应 200');
    const secB = sectionOf(rb.text);
    assert.ok(secB, 'PDF 文本层读不出时折叠区仍在');
    assert.ok(!/<pre[^>]*data-layer-preview/.test(secB), 'PDF 文本层读不出时不得展示伪造的原文块');
    assert.ok(secB.includes('PDF 文本层未取到'), 'PDF 文本层读不出时应如实说明，实际：' + secB.slice(0, 300));
  }
  {
    const rn = await get('/export?id=' + NOPDF_ID);
    assert.equal(rn.status, 200, '③ 号文档导出页应 200');
    const secN = sectionOf(rn.text);
    assert.ok(secN, '没有 PDF 时折叠区仍在');
    assert.ok(!/<pre[^>]*data-layer-preview/.test(secN), '没有 PDF 时不得展示伪造的原文块');
    assert.ok(secN.includes('还没有 PDF'), '没有 PDF 时应如实说明，实际：' + secN.slice(0, 300));
    assert.ok(!secN.includes('文本层字符量'), '没有 PDF 时不得给出字符量结论（口径沿用＝不新增口径），实际：' + secN.slice(0, 300));
  }

  // ===== F. 浏览器段：真 DOM 里折叠/展开 + 文本逐字一致（Chromium 缺失 exit 2）=====
  {
    let bin = null;
    try { bin = await resolveChromium(); }
    catch (e) { console.log('⚠️  Chromium 不可用，跳过浏览器段：' + (e && e.message || e)); cleanup(); process.exit(2); }
    browser = await chromium.launch({ executablePath: bin });
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    await page.goto(base + '/export?id=' + TXT_ID);
    const open0 = await page.evaluate(() => { const d = document.querySelector('#textLayerPreview'); return d ? d.open : null; });
    assert.equal(open0, false, '浏览器里折叠区应为折叠态');
    const got = await page.evaluate(() => { const el = document.querySelector('[data-layer-preview]'); return el ? el.textContent : null; });
    assert.equal(got, raw, '浏览器里折叠区展示的文本应与 pdftotext 输出逐字一致');
    await page.click('#textLayerPreview summary');
    const open1 = await page.evaluate(() => { const d = document.querySelector('#textLayerPreview'); return d ? d.open : null; });
    assert.equal(open1, true, '点击 summary 应能展开折叠区');
    assert.deepEqual(pageErrors, [], '不得有页面异常：' + JSON.stringify(pageErrors));
  }

  console.log('✅ 文本层预览：导出页折叠区「机器读到的样子」原样展示 pdftotext 输出（逐字相等）+ 无分数无结论'
    + ' + 字符量告警口径沿用（单一实现）+ 读不出/无 PDF 时诚实空态');
} catch (e) {
  console.error('❌ ' + (e && e.message || e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  cleanup();
}
