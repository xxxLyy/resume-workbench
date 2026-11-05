// test-copy-semantic-fixes.mjs — R2 文案与按钮语义修复包（HTTP 夹具，隔离根，无浏览器依赖）
// 覆盖（断言逐条独立，便于逐条复核）：
//   ① 首页「待办提醒」只数真待办：空库（零文档零投递）=0；建 1 份待结构化文档后 =1
//     （投递中/PDF/AI 未配置等状态行仍在 statusline 呈现，但不再计入待办数）。
//   ② 六处「请到侧栏「设置」」死引用清零：未配置 LLM 时 /eval/create 409 JSON 带 settingsPath='/settings'；
//     /ai/rewrite、/ai/chat、/restructure、/ai/review、/ai/match 五处 409 文体直接给出 /settings 路径。
//   ⑤ 向导横幅区分 forward/resume 两态；skipped 数组内的步显示「已跳过 X」而非「最近确认 X」。
//   ⑥⑦⑧ 导出页：确认按钮为 secondary 且括号状态说明移出文案；「导出对象：」替代「正在导出：」
//     （岗位稿 company·role 徽章在前、id 次要）；字符量告警带阈值与原因（<200：图文简历可忽略…）。
// 约束：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档；不读真实简历、不碰 7766、不调真实模型。
// 退出码契约：0=全部通过；1=任一断言失败（本夹具不依赖 Chromium，无 2 分支）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { freezeHtml } from '../../freeze.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-copy-semantic-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 刻意不写 config.json → hasLLM=false（②的前置）；applications.json 缺省 → 空投递（①空库）

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
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
const base = `http://127.0.0.1:${port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const post = async (p, body, json = true) => {
  const r = await fetch(base + p, { method: 'POST', headers: json ? { 'Content-Type': 'application/json' } : {}, body: json ? JSON.stringify(body) : body });
  return { status: r.status, text: await r.text() };
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ①a 空库：零文档零投递 → 待办提醒 = 0（修复前 todoBits.length 把状态行也算进待办数）=====
  {
    const home = await get('/');
    const m = home.text.match(/<b>(\d+)<\/b><span>待办提醒<\/span>/);
    assert.ok(m, '首页应有「待办提醒」统计块');
    assert.equal(m[1], '0', `空库（零文档零投递）待办提醒应为 0，实际：${m[1]}（页面片段：${(home.text.match(/<div class="stat-grid">[\s\S]{0,400}/) || [''])[0].slice(0, 300)}）`);
    assert.ok(!/投递中|AI 未配置/.test((home.text.match(/<b>\d+<\/b><span>待办提醒<\/span>/) || [''])[0]), '待办提醒 stat 不承载状态行文案');
  }

  // ===== ①b 建 1 份待结构化文档 → 待办提醒 = 1 =====
  {
    const DOC = 'degrade1';
    let doc = assembleTemplate('classic');
    for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', ''],
      ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
    doc = doc.replace('</h1>', () => '</h1><p>以下为 PDF 提取的原文（合成待结构化标记）</p>');
    fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
    fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [DOC]: { rev: 1, flow: 'draft' } }, null, 2));
    const home = await get('/');
    const m = home.text.match(/<b>(\d+)<\/b><span>待办提醒<\/span>/);
    assert.ok(m, '建文档后首页应有「待办提醒」统计块');
    assert.equal(m[1], '1', `1 份待结构化文档 → 待办提醒应为 1，实际：${m[1]}`);
  }

  // ===== ② 六处未配置 LLM 的 409：死文案清零，路径可达 =====
  {
    const ev = await post('/eval/create', { from: 'degrade1' });
    assert.equal(ev.status, 409, '/eval/create 未配置 LLM 应 409，实际：' + ev.status);
    let body = null;
    try { body = JSON.parse(ev.text); } catch {}
    assert.ok(body && body.ok === false, '/eval/create 409 应为 JSON 错误体：' + ev.text.slice(0, 120));
    assert.equal(body.settingsPath, '/settings', '/eval/create 409 应带 settingsPath="/settings" 字段（前端按 :2210 先例渲染链接），实际：' + ev.text.slice(0, 200));
    assert.ok(!body.error.includes('侧栏'), '/eval/create 错误文案不得再指「侧栏」（编辑器/首页无侧栏）：' + body.error);
    for (const ep of ['/ai/rewrite', '/ai/chat', '/restructure', '/ai/review', '/ai/match']) {
      const r = await post(ep, {});
      assert.equal(r.status, 409, `${ep} 未配置 LLM 应 409，实际：${r.status}`);
      assert.ok(r.text.includes('/settings'), `${ep} 409 文体应直接给出 /settings 路径，实际：${r.text.slice(0, 120)}`);
      assert.ok(!r.text.includes('侧栏'), `${ep} 409 文案不得再指「侧栏」：${r.text.slice(0, 120)}`);
    }
  }

  // ===== ⑤ 向导横幅：forward/resume 两态 + skipped 步显示「已跳过」=====
  {
    const r1 = await post('/onboarding/step', { step: '0.1', payload: { name: '合成', contact: '', intent: '' } });
    assert.equal(r1.status, 200, '0.1 有内容应建档 200：' + r1.text.slice(0, 200));
    const docId = (JSON.parse(r1.text)).docId;
    assert.ok(docId, '0.1 建档应返回 docId');
    const resume1 = await get('/onboarding?docId=' + docId);
    assert.ok(resume1.text.includes('已恢复未完成的从零建简历'), 'resume 态横幅应为「已恢复未完成的从零建简历」（2026-11-05 批 1 §0.3 改名）');
    assert.ok(resume1.text.includes('最近确认'), '0.1 确认后 resume 横幅应含「最近确认」（该步不在 skipped）');
    assert.ok(!resume1.text.includes('已跳过'), '未跳过任何步时 resume 横幅不得出现「已跳过」');
    const fwd1 = await get('/onboarding?docId=' + docId + '&from=step');
    assert.ok(fwd1.text.includes('已进入下一步'), 'forward 态横幅应为「已进入下一步」（步进 PRG 回跳，不是「恢复」）');
    const r2 = await post('/onboarding/step', { step: '0.2', docId, skip: true });
    assert.equal(r2.status, 200, '0.2 跳过应 200：' + r2.text.slice(0, 200));
    const resume2 = await get('/onboarding?docId=' + docId);
    assert.ok(resume2.text.includes('已跳过'), '跳过 0.2 后横幅应显示「已跳过」（last 落在 skipped 数组）');
    assert.ok(!resume2.text.includes('最近确认'), 'last=0.2 在 skipped 内时不得显示「最近确认」：' + (resume2.text.match(/<p class="ob-note">[^<]*<\/p>/) || [''])[0]);
    const fwd2 = await get('/onboarding?docId=' + docId + '&from=step');
    assert.ok(fwd2.text.includes('已跳过') && fwd2.text.includes('已进入下一步'), 'forward 态跳过横幅应含「已进入下一步（已跳过 …）」');
    const r3 = await post('/onboarding/step', { step: '0.5', docId, payload: { skillsText: '合成技能' } });
    assert.equal(r3.status, 200, '0.5 有内容应 200：' + r3.text.slice(0, 200));
    const resume3 = await get('/onboarding?docId=' + docId);
    assert.ok(resume3.text.includes('最近确认'), '0.5 确认后横幅应恢复「最近确认」（last 不在 skipped）');
    assert.ok(!resume3.text.includes('最近确认 0.2'), '被跳过的 0.2 不得被称作「最近确认」');
  }

  // ===== ⑥⑦⑧ 导出页：确认按钮 secondary 化去括号 / 「导出对象」/ 字符量告警带阈值与原因 =====
  {
    const JDOC = 'jobexp1', PARENT = 'degrade1';
    let doc = assembleTemplate('classic');
    for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', ''],
      ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', JDOC]]) doc = doc.replaceAll(k, () => v);
    fs.writeFileSync(path.join(root, 'docs', JDOC + '.html'), doc);
    // 合成 PDF（非真实渲染）：pdfinfo/pdftotext 解析失败 → 页数 0 / 字符量 0，正好落在 ⑧ 的告警分支；
    // lastRenderInputId 按冻结合同预置（staleInfo 判 fresh）→ 导出页不触发自动重渲（本夹具无 Chromium）。
    fs.writeFileSync(path.join(root, 'pdfs', JDOC + '.pdf'), '%PDF-1.4\n% fake pdf for http fixture\n');
    const metaPath = path.join(root, 'docs-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta[JDOC] = { rev: 1, flow: 'draft', kind: 'job', parent: PARENT, company: '合成公司', role: '合成岗位',
      job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} } };
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const rid = freezeHtml(doc, meta[JDOC]).renderInputId;
    meta[JDOC].lastRenderInputId = rid;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const ex = await get('/export?id=' + JDOC);
    assert.equal(ex.status, 200, '导出页应 200：' + ex.text.slice(0, 200));
    assert.ok(ex.text.includes('导出对象：'), '导出页应为「导出对象：」（⑦）');
    assert.ok(!ex.text.includes('正在导出'), '导出页不得再出现「正在导出」（页面是状态页，不是进行时）（⑦）');
    const objRow = (ex.text.match(/<p>导出对象：[\s\S]{0,1200}?<\/p>/) || [''])[0];   // versionLine 内联 SVG 较长，窗口放宽
    assert.ok(objRow.includes('合成公司·合成岗位'), '岗位稿导出对象应以 company·role 徽章优先：' + objRow.slice(0, 200));
    assert.ok(objRow.indexOf('合成公司·合成岗位') < objRow.indexOf(JDOC), '岗位稿导出对象中 company·role 应先于 id（id 退居次要）：' + objRow.slice(0, 200));
    assert.ok(ex.text.includes('class="secondary" type="submit">确认可投递</button>'), '确认可投递按钮应为 secondary 且不含括号状态说明（⑥），页面片段：' + (ex.text.match(/<button[^>]*>确认可投递[^<]*<\/button>/) || ['(无确认按钮)'])[0]);
    assert.ok(!ex.text.includes('确认可投递（'), '括号状态说明应移出按钮文案（状态由徽章承载）（⑥）');
    assert.ok(!/class="ok"/.test(ex.text), '页面不得再引用无定义的 button.ok 类（⑥）');
    assert.ok(ex.text.includes('图文简历可忽略'), '字符量告警应带阈值与原因（<200：图文简历可忽略，否则检查文本层）（⑧）');
    const charRow = (ex.text.match(/文本层字符量：[^<]*<[^>]*>[^<]*/i) || (ex.text.match(/文本层字符量：[^<]*/) || ['']))[0];
    assert.ok(/文本层字符量：<\/span>0/.test(ex.text) || charRow.includes('0'), '合成假 PDF 的文本层字符量应为 0（走告警分支）：' + charRow);
  }

  console.log('✅ R2 文案与按钮语义：①空库待办=0/1 待结构化=1 ②六处 409 无死文案且带 /settings ⑤横幅两态+已跳过 ⑥确认按钮 secondary 去括号 ⑦导出对象 ⑧字符量告警带阈值原因');
} catch (e) {
  console.error('❌ ' + (e && e.message || e));
  process.exitCode = 1;
} finally {
  cleanup();
}
