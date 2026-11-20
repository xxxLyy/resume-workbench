// test-home-eval-card-removed.mjs — 批 1 §0.3「首页评估历史卡撤除：评估归 /evals」（卡片 b1c5）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §0.3（首页评估历史卡撤除，评估归 /evals）+ §2 首页（次级折叠行 = 空白新建 / 导入 PDF / 为岗位定制简历，入口按钮非表单）。
// 覆盖（断言逐条独立，便于逐条复核）：
//   A 首页撤除（负向）：合成 evaluations.json 非空时，首页仍不得出现——评估历史卡标题、#evalHistory 容器、
//     评估行按钮（查看报告 / 转入适配）、评估记录内联载荷（EVAL_RECORDS）、公司·岗位回显、报告正文、
//     指向 /evals 的入口（入口迁至 /job/new 页题右侧）。
//   B /evals 页能力不变（正向）：全量列表 + 逐条「查看报告」/「转入适配」按钮 + 「来源缺失」与「已转适配」徽章
//     （已转适配且目标文档在盘 → 仍链接 /edit）+ XSS 转义 + 内联载荷 + 导航（topnav 4 链接 / 无 sidenav / 简历高亮；
//     链接数 7→4 是渐进呈现 T2 的一次性同提交迁移，与 /evals 能力无关）。
//   C /evals 入口可达：/job/new 页提供 href="/evals"，空库态与有母版态都在场（否则 /evals 成孤页）。
//   D 阴性对照：撤除范围仅评估历史卡——空库起步态结构在场（home-start/起步卡/上传区），<script> 标签数不变。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成数据；不读真实简历、不碰 7766、不调真实模型；仓库零写入。
// 隐私门禁：合成数据不含 13 位数字（门禁 1[3-9]\d{9} 不适用）。
// 退出码契约：0=全部通过；1=任一断言失败（本夹具不依赖 Chromium，无 2 分支）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-evalcard-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 合成评估记录（三条，含 XSS 载荷）：① 有母版来源 → 有「转入适配」；② 无 source 的旧记录 → 「来源缺失」；③ 已转适配
const XSS = '<script>alert(1)</script><img src=x onerror="alert(2)">';
const evalRec = (over) => ({
  id: 'ev-20261030-120000-000-000',
  company: '合成甲公司' + XSS, role: '合成后端' + XSS,
  score: 4.5, verdict: 'apply',
  blocks: {
    roleSummary: 'REPORT-BODY-MARKER', level: 'right', levelReason: '合成理由',
    salary: { text: '面议', source: 'JD 自带' }, angle: '强调后端', verdictReason: '合成结论理由',
    matches: [{ req: 'Go', status: 'covered', evidence: '三年 Go' }], gaps: []
  },
  model: 'stub',
  source: { type: 'resume', docId: 'evmaster', hash: '0123456789abcdef' },
  createdAt: '2026-10-30T12:00:00.000Z',
  promotedTo: null,
  ...over
});
fs.writeFileSync(path.join(root, 'evaluations.json'), JSON.stringify([
  evalRec({}),
  evalRec({ id: 'ev-20261029-090000-000-000', source: undefined, createdAt: '2026-10-29T09:00:00.000Z' }),
  evalRec({ id: 'ev-20261028-080000-000-000', promotedTo: 'evmaster', createdAt: '2026-10-28T08:00:00.000Z' })
]));

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
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));
const base = `http://127.0.0.1:${port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };

// 合成母版：真模板骨架 + 显式 h1 标题 + meta 直写（绕过 LLM 动线）
const metaPath = path.join(root, 'docs-meta.json');
const seedDoc = (id, title, metaEntry = {}) => {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', ''],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) doc = doc.replaceAll(k, () => v);
  doc = doc.replace(/<h1>[^<]*<\/h1>/, () => `<h1>${title}</h1>`);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  meta[id] = { rev: 1, flow: 'draft', ...metaEntry };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) throw new Error('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) throw new Error('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== A. 首页撤除（负向）：有评估记录也不得再出现评估历史卡 =====
  {
    const r = await get('/');
    assert.equal(r.status, 200, '首页应 200，实际 ' + r.status);
    const html = r.text;
    assert.ok(!html.includes('评估历史'), '首页不得再出现「评估历史」卡（评估归 /evals）');
    assert.ok(!html.includes('evalHistory'), '首页不得再出现评估历史容器/接线（evalHistory）');
    assert.ok(!html.includes('EVAL_RECORDS'), '首页不得再内联评估记录载荷（EVAL_RECORDS 为死代码）');
    assert.ok(!html.includes('查看报告'), '首页不得再出现「查看报告」按钮');
    assert.ok(!html.includes('转入适配'), '首页不得再出现「转入适配」按钮');
    assert.ok(!html.includes('合成甲公司'), '首页不得再回显评估记录的公司·岗位');
    assert.ok(!html.includes('REPORT-BODY-MARKER'), '首页不得再内联评估报告正文');
    assert.ok(!html.includes('href="/evals"'), '首页不再承担 /evals 入口（入口迁至 /job/new）');
    assert.ok(!html.includes('alert(1)'), '首页不得含评估载荷文本');
    // D 阴性对照：撤除范围仅评估历史卡，其余台面不受影响（T3 空库=起步态；任务卡/统计行/旧列表已按 T3 退役）
    assert.ok(html.includes('class="home-start"'), '空库起步态容器仍在（撤除范围仅评估历史卡）');
    assert.ok(html.includes('class="start-cards"'), '起步卡组仍在');
    assert.ok(html.includes('id="up"'), '起步卡上传区仍在');
    assert.equal((html.match(/<script/g) || []).length, 3, '首页 <script> 标签数应仍为 3（评估渲染器/接线同块撤除，未新增标签）');
  }

  // ===== C1. /evals 入口可达：/job/new 空库态也提供入口（否则 /evals 成孤页）=====
  {
    const r = await get('/job/new');
    assert.equal(r.status, 200, '/job/new 应 200，实际 ' + r.status);
    assert.ok(r.text.includes('href="/evals"'), '/job/new 应提供 /evals 入口（首页卡撤除后 /evals 不得成孤页）');
    assert.ok(r.text.includes('还没有母版简历'), '/job/new 空库态应渲染空态卡（既有契约）');
  }

  // 播种合成母版：/evals「已转适配」徽章在目标文档在盘时才是 /edit 链接（既有口径）
  seedDoc('evmaster', '合成母版简历');

  // ===== B. /evals 页能力不变（正向）=====
  {
    const r = await get('/evals');
    assert.equal(r.status, 200, '/evals 应 200，实际 ' + r.status);
    const html = r.text;
    assert.ok(html.includes('<h1>评估历史</h1>'), '/evals 页题仍应为 h1「评估历史」');
    assert.ok(html.includes('合成甲公司'), '/evals 仍应列评估记录（公司·岗位）');
    assert.ok(html.includes('data-eval-hist="report"'), '/evals 仍应提供「查看报告」按钮');
    assert.ok(html.includes('data-eval-hist="promote"'), '/evals 仍应提供「转入适配」按钮（有母版来源的记录）');
    assert.ok(html.includes('来源缺失'), '/evals 仍应标「来源缺失」（无 source 的旧记录）');
    assert.ok(html.includes('已转适配'), '/evals 仍应标「已转适配」');
    assert.ok(html.includes('href="/edit?id=evmaster"'), '/evals「已转适配」徽章仍应链接到目标文档');
    assert.ok(html.includes('EVAL_RECORDS'), '/evals 仍应内联评估记录载荷（客户端渲染报告）');
    // XSS 转义（模型/用户文本一律转实体）
    assert.ok(html.includes('&lt;script&gt;'), '/evals 的评估载荷应渲染为实体');
    assert.ok(!html.includes('<script>alert(1)'), '/evals 不得含裸 <script>');
    assert.ok(!html.includes('<img src=x onerror'), '/evals 不得含裸 <img>');
    // 导航：topnav 4 个 <a>（brand + 3 项，渐进呈现 T2 由 7 收敛为 3：简历/投递/设置）；导航唯一（无 sidenav）；「简历」高亮
    const nav = (html.match(/<nav class="topnav">[\s\S]*?<\/nav>/) || [''])[0];
    assert.equal((nav.match(/<a [^>]*>[\s\S]*?<\/a>/g) || []).length, 9, '/evals 的 topnav 链接数应为 9（brand + 8 项，2026-11-20 UPCV 职位库退役后：简历/投递/求职画像/求职助手/求职主页/模拟面试/模板库/设置）');
    assert.ok(!html.includes('class="sidenav"'), '导航唯一：/evals 不应再有 .sidenav');
    assert.ok(/<a href="\/" class="on">/.test(nav), '/evals topnav「简历」应高亮（active=docs）');
  }

  // ===== C2. /job/new 有母版态：入口仍在 + 表单既有契约不变 =====
  {
    const r2 = await get('/job/new');
    assert.equal(r2.status, 200, '/job/new 有母版应 200');
    assert.ok(r2.text.includes('href="/evals"'), '/job/new 有母版态仍应提供 /evals 入口');
    assert.ok(r2.text.includes('id="jobForm"'), '/job/new 有母版应渲染岗位表单（既有契约）');
  }

  // ===== A′. 有母版后首页仍不得出现评估历史卡 =====
  {
    const html = (await get('/')).text;
    assert.ok(!html.includes('评估历史'), '有母版后首页也不得再出现「评估历史」卡');
    assert.ok(!html.includes('合成甲公司'), '有母版后首页也不得再回显评估记录的公司·岗位');
    assert.equal((html.match(/<script/g) || []).length, 3, '有母版后首页 <script> 标签数应仍为 3');
  }

  console.log('✅ 首页评估历史卡撤除（首页无评估卡/无评估行/无死载荷 + /evals 能力不变 + /evals 入口可达 /job/new）');
} catch (e) {
  console.error('❌ ' + (e && e.message));
  process.exitCode = 1;
} finally {
  cleanup();
}
