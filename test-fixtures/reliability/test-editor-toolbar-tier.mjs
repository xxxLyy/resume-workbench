// test-editor-toolbar-tier.mjs — 批1 编辑器顶栏控件同档（浏览器真渲染量测）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §2「编辑器顶栏（editor-shell.js）」+ §0.2 UI 裁决
//   「编辑器顶栏：控件统一 32px 高度档；仅「导出 PDF」保留主行动实底（双区规则不变）」；
//   规则依据 DESIGN.md §2 双区规则表：编辑器区「主行动 = 橙实心 --ed-accent，只给 pdfBtn / primary；
//   其余操作区一律中性描边」。
//
// 背景（2026-11-06 Chromium 1450×950 真渲染量测，隔离实例）：
//   顶栏六个动作控件虽都是 32px 高，却分在两个视觉档——
//     · #saveBtn / .ed-jobbtn（岗位草稿）/ .ed-left-toggle / .ed-right-toggle 挂 ed-ghost 档：
//       背景与边框都是 transparent（视觉上「不像按钮」）；
//     · #histBtn / .ed-preview-btn 落在中性描边档（--ed-panel 底 + 1px --ed-line 边）。
//   同一排控件两种档 = 顶栏不齐；且与 DESIGN.md §2「其余操作区一律中性描边」相悖。
//
// 断言（真实浏览器 getComputedStyle + getBoundingClientRect 量测，不靠样式文本推断）：
//   ① 六个控件（保存/历史/预览/岗位草稿/左右栏开关）computed min-height 均为 32px；
//   ② 六个控件的实渲染高度两两差 ≤1px（同高度档）；
//   ③ 六个控件的背景色/边框色/边框宽/边框样式四项逐项相同（同一视觉档），且背景不得透明
//      （透明 = ed-ghost 档未收口，正是本卡要修的缺口）；边框须为实线（中性描边）；
//   ④ 仅「导出 PDF」是主行动实底：顶栏内背景等于 --ed-accent 的按钮有且仅有 #pdfBtn 一个
//      （其余控件一律不得实底抢眼）；--ed-accent 本身不变（双区规则不变）；
//   ⑤ 覆盖两份文档：现代 classic 模板文档 + 带「上一代内联工具栏 chrome」的存量形态文档
//      —— 后者证明注入层真的压过了文档自带的分叉 chrome（注入层同档职责），而非恰好撞上默认值。
//
// 隔离：mkdtemp 根 + 随机端口 + 合成文档；不读真实简历、不写真实数据目录、不调真实模型。
// 退出码契约：0=全部通过；1=断言失败；2=仅 Chromium 不可用（套件惯例，跳过不假装通过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-tbtier-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 刻意不写 config.json → 无模型（顶栏档位与模型无关）

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
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
const base = `http://127.0.0.1:${port}`;

// 顶栏六控件 + 主行动按钮的取样对象（选择器写死，取样对象缺失即红——防静默退化为空集假绿）
const CTRL_SEL = ['#saveBtn', '#histBtn', '.ed-preview-btn', '.ed-jobbtn', '.ed-left-toggle', '.ed-right-toggle'];
const CTRL_NAME = { '#saveBtn': '保存', '#histBtn': '历史', '.ed-preview-btn': '预览', '.ed-jobbtn': '岗位草稿', '.ed-left-toggle': '左栏开关', '.ed-right-toggle': '右栏开关' };

// 文档一：现代 classic 模板（无额外 chrome）；文档二：存量形态——文档自带上一代内联工具栏 chrome
//（冷灰蓝实底 / 方角 / 另一套按钮底色与字号，全是假数据），注入层必须压过它（注入层同档职责）。
const DOCS = [
  { id: 'tbar1', legacy: false },
  { id: 'tbar2', legacy: true }
];
const LEGACY_CHROME = '<style id="legacy-chrome">'
  + '.edit-toolbar{background:#E7EAF0;border-radius:2px;gap:12px}'
  + '.edit-toolbar button{background:#3D4A63;color:#F2F4F8;border:2px solid #0B1B33;border-radius:2px;min-height:40px;padding:6px 14px;font-size:13px}'
  + '.edit-toolbar button.secondary{background:#8A93A6;color:#F2F4F8}'
  + '</style>';
for (const d of DOCS) {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', d.id]]) doc = doc.replaceAll(k, () => v);
  if (d.legacy) doc = doc.replace('</head>', LEGACY_CHROME + '</head>');
  fs.writeFileSync(path.join(root, 'docs', d.id + '.html'), doc);
}
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify(
  Object.fromEntries(DOCS.map((d) => [d.id, { rev: 1, flow: 'draft' }])), null, 2));

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过编辑器顶栏档位量测：' + (e && e.message || e)); cleanup(); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage({ viewport: { width: 1450, height: 950 } });

  for (const d of DOCS) {
    await page.goto(base + '/edit?id=' + d.id, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body.ed-on');
    await page.waitForSelector('.ed-jobbtn');           // 注入层产物就位（岗位草稿按钮）
    await page.waitForTimeout(400);

    const m = await page.evaluate((sels) => {
      const q = (s) => document.querySelector(s);
      const ctrls = sels.map((s) => {
        const el = q(s);
        if (!el) return { sel: s, missing: true };
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          sel: s, missing: false,
          text: (el.textContent || '').trim().slice(0, 8),
          minHeight: cs.minHeight,
          height: Math.round(r.height * 100) / 100,
          bg: cs.backgroundColor,
          borderColor: cs.borderTopColor,
          borderWidth: cs.borderTopWidth,
          borderStyle: cs.borderTopStyle,
          radius: cs.borderTopLeftRadius
        };
      });
      const all = [];
      document.querySelectorAll('.edit-toolbar button').forEach((el) => {
        const cs = getComputedStyle(el);
        all.push({ id: el.id || '', cls: el.className || '', bg: cs.backgroundColor, weight: cs.fontWeight });
      });
      const body = getComputedStyle(document.body);
      return {
        ctrls, all,
        accent: body.getPropertyValue('--ed-accent').trim(),
        panel: body.getPropertyValue('--ed-panel').trim(),
        line: body.getPropertyValue('--ed-line').trim()
      };
    }, CTRL_SEL);

    const where = d.legacy ? '存量形态文档' : '现代文档';
    // 取样对象齐全（缺一个即红：否则「六个都齐」会退化成「取到的都齐」）
    const missing = m.ctrls.filter((c) => c.missing).map((c) => c.sel);
    assert.equal(missing.length, 0, `${where}：顶栏控件缺失，无法校验档位：${missing.join('、')}`);

    // ① min-height 均为 32px（控件档）
    for (const c of m.ctrls) {
      assert.equal(c.minHeight, '32px',
        `${where}：${CTRL_NAME[c.sel]}（${c.sel}）min-height 应为 32px（顶栏控件同档），实际=${c.minHeight}`);
    }
    // ② 实渲染高度同档（两两差 ≤1px）
    const hs = m.ctrls.map((c) => c.height);
    const hMin = Math.min(...hs), hMax = Math.max(...hs);
    assert.ok(hMax - hMin <= 1,
      `${where}：顶栏六控件实渲染高度应同档（差 ≤1px），实际 ${hs.join('/')}（差 ${(hMax - hMin).toFixed(2)}px）`);

    // ③ 视觉同档：背景/边框色/边框宽/边框样式逐项相同；背景不得透明；边框须实线
    const first = m.ctrls[0];
    for (const c of m.ctrls.slice(1)) {
      for (const k of ['bg', 'borderColor', 'borderWidth', 'borderStyle']) {
        assert.equal(c[k], first[k],
          `${where}：${CTRL_NAME[c.sel]}（${c.sel}）与${CTRL_NAME[first.sel]}（${first.sel}）不同档：${k} 实际=${c[k]}，参照=${first[k]}`);
      }
    }
    assert.ok(first.bg !== 'rgba(0, 0, 0, 0)',
      `${where}：顶栏控件不得是透明底（ed-ghost 档未收口；DESIGN.md §2：除主行动外一律中性描边），实际 bg=${first.bg}`);
    assert.ok(first.borderStyle !== 'none' && first.borderWidth !== '0px',
      `${where}：顶栏控件须有中性描边（DESIGN.md §2），实际 border=${first.borderWidth} ${first.borderStyle}`);

    // ④ 仅「导出 PDF」保留主行动实底（--ed-accent 实底按钮有且仅有 #pdfBtn）
    const accentRgb = (() => {
      const hex = m.accent.replace('#', '');
      const v = parseInt(hex, 16);
      return 'rgb(' + [(v >> 16) & 255, (v >> 8) & 255, v & 255].join(', ') + ')';
    })();
    const solid = m.all.filter((b) => b.bg === accentRgb);
    assert.equal(solid.length, 1, `${where}：顶栏内主行动实底按钮应恰有一个（导出 PDF），实际 ${solid.length} 个：${JSON.stringify(solid.map((b) => b.id || b.cls))}`);
    assert.equal(solid[0].id, 'pdfBtn', `${where}：实底主行动按钮应是「导出 PDF」（#pdfBtn），实际=${solid[0].id || solid[0].cls}`);
    // 双区规则不变：编辑器 --ed-accent 仍是暖橙 #C2410C（应用页 --accent 近黑由 test-structure.sh B1 断言）
    assert.equal(m.accent.toUpperCase(), '#C2410C',
      `${where}：编辑器 --ed-accent 应仍是暖橙 #C2410C（DESIGN.md §2 双区规则不变），实际=${m.accent}`);

    console.log(`  ✅ ${where}：六控件 min-height 32px / 实渲染高 ${hMin}px / 同档 ${first.bg} + ${first.borderWidth} ${first.borderStyle} ${first.borderColor}；仅导出 PDF 实底`);
  }

  console.log('✅ 编辑器顶栏控件同档（六控件 32px 高度档 + 中性描边；现代/存量两份文档一致；仅导出 PDF 实底）');
} catch (e) {
  console.error('❌ ' + (e && e.message));
  process.exitCode = 1;
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  cleanup();
}
