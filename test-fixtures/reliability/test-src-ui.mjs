// test-fixtures/reliability/test-src-ui.mjs — 来源语义的真实读视图与真实 UI（SRC-03/05/07）
// 覆盖：① 旧数据的 anchored 不被信任（读时降级，界面标签同步降级）；
//       ② 真实来源可回跳（证据条目的「定位」与面试追问的「回跳」都是真实按钮，点了能定位到段落）；
//       ③ 读取视图零回写（读完之后 meta 的字节与 mtime 都不变）。
// 约束：隔离 RESUME_ROOT + 合成文档；不读真实简历、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-srcui-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111', P2 = 'z22222222';
const T1 = '项目一：负责队列服务，把延迟从 80ms 降到 12ms';
const T2 = '项目二：负责限流组件，支撑双十一峰值流量';
const fingerprint = (t) => crypto.createHash('sha1').update(String(t).replace(/\s+/g, ' ').trim()).digest('hex');

let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">${T1}</p><p data-zid="${P2}">${T2}</p>`);
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);

const metaPath = path.join(root, 'docs-meta.json');
const writeMeta = () => fs.writeFileSync(metaPath, JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    zones: { [P1]: { zone: 'work', status: 'confirmed' }, [P2]: { zone: 'work', status: 'confirmed' } },
    job: {
      changes: [], todos: [], feedback: [], materials: [],
      genTasks: { interview: { taskId: 't-synth', status: 'done', startedAt: 1 } },
      evidence: [
        // 新数据：来源是真段落 → fresh
        { id: 'e1', req: '要求一：队列服务', status: 'covered', note: '', noteConfirmed: false,
          refs: [{ type: 'para', zid: P1, hash: fingerprint(T1), title: '项目', quote: '负责队列服务' }] },
        // 旧数据：只有引文 + anchored=true（历史遗留）→ 读时降级，不得当成有据
        { id: 'e2', req: '要求二：旧的引文记录', status: 'sourced', anchored: true, note: '', noteConfirmed: false,
          refs: [{ type: 'para', quote: '某个根本不存在的引文' }] }
      ],
      interview: {
        chains: [{
          evIndex: 0, zid: P1, question: '问题一：队列怎么做的',
          answerPoints: [{ text: '要点一：做了限流与降级', anchored: true, quote: '负责队列服务',
            source: { type: 'para', zid: P1, hash: fingerprint(T1) } }]
        }],
        generic: []
      }
    }
  }
}, null, 2));
writeMeta();

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const base = `http://127.0.0.1:${port}`;

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  // ===== ① 服务端读视图：来源身份只认段落 zid；旧 anchored 不被信任 =====
  const beforeBytes = fs.readFileSync(metaPath);
  const beforeMtime = fs.statSync(metaPath).mtimeMs;
  const d = await (await fetch(base + '/job/changes?id=' + DOC)).json();
  const ev1 = (d.job.evidence || []).find((e) => e.id === 'e1');
  const ev2 = (d.job.evidence || []).find((e) => e.id === 'e2');
  assert.ok(ev1 && ev1.refs && ev1.refs[0], 'e1 的引用缺失');
  assert.equal(ev1.refs[0].sourceState, 'fresh', 'e1 的真段落来源应为 fresh，实际：' + JSON.stringify(ev1.refs[0]));
  assert.equal(ev1.refs[0].sourceZid, P1, 'e1 的来源身份应是段落 zid');
  assert.ok(ev2 && ev2.stale === true, 'e2（只有引文的旧记录）应被判 stale，实际：' + JSON.stringify(ev2));
  // 面试追问：旧的 anchored 布尔不被信任 —— 有真 source 且段落指纹匹配才是 fresh
  const pt = d.job.interview.chains[0].answerPoints[0];
  assert.equal(pt.sourceState, 'fresh', '面试要点的来源应为 fresh，实际：' + JSON.stringify(pt));
  assert.equal(pt.anchored, true, '真来源的要点应可回跳');
  assert.equal(pt.quoteForDisplay, '负责队列服务', '引文展示应来自真实段落，实际：' + pt.quoteForDisplay);

  // ===== ② 读取视图零回写 =====
  await new Promise((r) => setTimeout(r, 300));
  const afterBytes = fs.readFileSync(metaPath);
  assert.ok(afterBytes.equals(beforeBytes), '读取后 meta 字节被改写（历史存储不得被回写）');
  assert.equal(fs.statSync(metaPath).mtimeMs, beforeMtime, '读取后 meta mtime 被改写（不得落盘）');
  console.log('  ✅ SRC 读视图：真源集合生效 + 旧 anchored 降级 + 零回写');

  // ===== ③ 真实 UI：标签与回跳 =====
  let bin = null;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过来源 UI 回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();
  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 15000 });
  await page.click('#ed-pane-review .jp-secs button[data-sec="evidence"]');
  await page.waitForTimeout(900);
  const pane = await page.evaluate(() => document.querySelector('#ed-pane-review').textContent || '');
  assert.ok(/简历已覆盖/.test(pane), 'e1 的标签应为「简历已覆盖」，实际面板：' + pane.slice(0, 300));
  assert.ok(/来源已变化/.test(pane), 'e2（旧的引文记录）应显示来源已变化，实际面板：' + pane.slice(0, 300));
  assert.ok(!/素材有据·简历未表达/.test(pane), '旧的 anchored 记录不得仍显示「素材有据·简历未表达」，实际：' + pane.slice(0, 300));
  // 真回跳：证据条目的「定位」与面试追问的「回跳」都是真实按钮
  const btns = await page.evaluate(() => {
    var all = Array.prototype.slice.call(document.querySelectorAll('#ed-pane-review button'));
    return {
      locate: all.filter((b) => /定位/.test(b.textContent || '')).length,
      back: all.filter((b) => /回跳/.test(b.textContent || '')).length
    };
  });
  assert.ok(btns.locate >= 1, '证据条目应有「定位」按钮（真实回跳）');
  assert.ok(btns.back >= 1, '面试追问应有「回跳」按钮（真实回跳）');
  // 点回跳：必须真的定位到那一段（定位函数滚动并高亮，不抛错）
  await page.evaluate(() => {
    var b = Array.prototype.slice.call(document.querySelectorAll('#ed-pane-review button')).find((x) => /回跳/.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(600);
  const located = await page.evaluate(() => {
    var el = document.querySelector('.sheet [data-zid="z11111111"]');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { text: el.textContent, top: Math.round(r.top), inView: r.top < window.innerHeight && r.bottom > 0 };
  });
  assert.ok(located && located.inView, '回跳后目标段落应进入视口，实际：' + JSON.stringify(located));
  console.log('  ✅ SRC 真实 UI：标签按真源判定 + 定位/回跳是真实按钮且生效');

  console.log('PASS 来源 UI 回归: 读视图降级 + 零回写 + 真实标签与回跳');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
