// test-stats-loop-view.mjs — F1 评估 ↦ 投递 闭环视图（复盘页 /stats）+ 评估历史「已转适配」徽章链接化
// 验收口径（卡片原文，逐条进断言）：
//   ① promotedTo 指向在盘 docId 的行渲染对应投递 status 与 /edit 链接；
//   ② verdict=apply 未转记录出现在「评估了却没投」提醒区；
//   ③ 无评估记录时空态指引文案；
//   ④ /evals 页「已转适配」为带 href 链接、promotedTo 指向已删文档时无链接；
//   ⑤ 有评估无投递时闭环卡仍渲染（早退口径 = apps 与 evals 均为空才早退）。
// join 口径：promotedTo→docId→deliveredRefs 为主；公司·岗位 trim 后精确相等作兜底行并标「同名匹配」。
// 红线：只呈现既有评估结论与投递状态事实，断言页面不含任何转化率/匹配率/录用概率包装；
//       动态文本（公司/岗位/状态/时间）注入探针必须被转义。
// HTTP 类夹具：独立 RESUME_ROOT + 随机端口 + assembleTemplate 合成文档；evaluations.json /
// applications.json 直接写数组形状夹具（shapeOk 要求根为数组，server.mjs shapeOk）；
// evaluations.json 缺失场景走读侧缺省 []。真实 ~/resume 数据禁写禁删。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const roots = [];
const servers = [];
const cleanup = () => {
  for (const s of servers) { try { s.kill('SIGKILL'); } catch {} }
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
};
process.on('exit', cleanup);

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-loop-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
  roots.push(root);
  return root;
};

// 合成文档（assembleTemplate 装配 + 占位符替换）：闭环卡只做存在性判断（docPath），正文内容不参与渲染
const writeDoc = (root, id) => {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) doc = doc.replaceAll(k, () => v);
  doc = doc.replace('{{WORK}}', () => '<p data-zid="z11111111">工作经历：负责交易系统</p>');
  doc = doc.replace('{{PROJECTS}}', () => '');
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
};

const startServer = async (root) => {
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
    cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  servers.push(server);
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
  return { base, get: async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text() }; } };
};

// ===== 评估记录（数组形状夹具，evalRecordView 视图口径：带 source → recorded）=====
const src = { type: 'resume', docId: 'master', hash: '0123456789abcdef' };
const EVALS_MAIN = [
  // evA：promotedTo=job1（在盘）→ 主 join 命中 app1（面试中 / 2 轮面试 / appliedAt 事实）
  { id: 'ev-loop-a', company: '甲公司', role: '后端', score: 4.5, verdict: 'apply', jd: '负责后端服务',
    blocks: { roleSummary: 'r' }, source: src, createdAt: '2026-10-01T08:00:00.000Z', promotedTo: 'job1' },
  // evB：promotedTo=gone-doc（不在盘）→ 转适配去向降级「原文档已删除」、无链接；主 join 仍按 docId（无投递记录）
  { id: 'ev-loop-b', company: '乙公司', role: '前端', score: 3.5, verdict: 'caution', jd: '前端',
    blocks: {}, source: src, createdAt: '2026-10-02T08:00:00.000Z', promotedTo: 'gone-doc' },
  // evC：未转适配（promotedTo=null）+ verdict=apply → 兜底同名命中 app2（company/role 夹具带首尾空格，验 trim 口径）；进提醒区
  { id: 'ev-loop-c', company: '丙公司 ', role: ' 测试', score: 4, verdict: 'apply', jd: '测试',
    blocks: {}, source: src, createdAt: '2026-10-03T08:00:00.000Z', promotedTo: null },
  // evD：verdict=skip 未转 recorded + 注入探针 → 不进提醒区；输出必须转义
  { id: 'ev-loop-d', company: '丁公司<script>alert(1)</script>', role: '安全<img src=x onerror=alert(2)>', score: 2,
    verdict: 'skip', jd: '安全', blocks: {}, source: src, createdAt: '2026-10-04T08:00:00.000Z', promotedTo: null }
];
const APPS_MAIN = [
  // app1：docId=job1（evA 主 join 命中）
  { id: 'app-loop-1', company: '', role: '', docId: 'job1', status: '面试中', appliedAt: '2026-10-05 10:00',
    channel: '', link: '', note: '', createdAt: '2026-10-05 10:00', updatedAt: '',
    interviews: [{ round: '一面', time: '2026-10-10 10:00' }, { round: '二面', time: '2026-10-12 10:00' }] },
  // app2：与 evC 公司·岗位同名（trim 后精确相等）→ 兜底命中
  { id: 'app-loop-2', company: '丙公司', role: '测试', docId: '', status: '已投递', appliedAt: '2026-10-06 09:00',
    channel: '', link: '', note: '', createdAt: '2026-10-06 09:00', updatedAt: '', interviews: [] },
  // app3：与任何评估都不同名 → 不得被兜底误配
  { id: 'app-loop-3', company: '戊公司', role: '算法', docId: '', status: '已拒', appliedAt: '2026-10-07 09:00',
    channel: '', link: '', note: '', createdAt: '2026-10-07 09:00', updatedAt: '', interviews: [] }
];
// rootEvalOnly：有评估、零投递 → 闭环卡仍渲染（验收⑤）
const EVALS_ONLY = [
  { id: 'ev-loop-e', company: '甲公司', role: '后端', score: 4, verdict: 'apply', jd: '负责后端服务',
    blocks: {}, source: src, createdAt: '2026-10-01T08:00:00.000Z', promotedTo: null }
];

try {
  // ================= 主根：apps 三条 + evals 四态 + 在盘文档 job1 =================
  const rootMain = mkRoot('main');
  writeDoc(rootMain, 'job1');
  fs.writeFileSync(path.join(rootMain, 'applications.json'), JSON.stringify(APPS_MAIN));
  fs.writeFileSync(path.join(rootMain, 'evaluations.json'), JSON.stringify(EVALS_MAIN));
  const s1 = await startServer(rootMain);

  // ===== ①② + join 口径 + 提醒区 + 转义（GET /stats）=====
  const st = await s1.get('/stats');
  assert.equal(st.status, 200, '/stats 应 200');
  const html = st.html;
  assert.ok(html.includes('评估 ↦ 投递'), '① 复盘页应有「评估 ↦ 投递」闭环卡');
  // ① 主 join：promotedTo 在盘 → /edit 链接 + 投递事实（status/appliedAt/面试轮次）
  assert.ok(html.includes('<a href="/edit?id=job1"'), '① promotedTo 在盘的行应有 /edit 链接');
  assert.ok(html.includes('面试 2 轮'), '① 投递事实应含面试轮次数（interviews.length=2）');
  // 2026-11-04 视觉收尾（DESIGN.md §9.4）：投于时间走 fmtWhen 人话格式，期望值按同口径动态计算（防跨年时间炸弹）
  const fmtExpected = (raw) => {
    const d = new Date(raw);
    const y = d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '年';
    return y + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  assert.ok(html.includes('投于 ' + fmtExpected('2026-10-05 10:00')), '① 投递事实应含 appliedAt（人话格式）');
  assert.ok(/投递 1 条：[^<]*面试中/.test(html), '① 主 join 应渲染对应投递 status（面试中），实际无「投递 1 条：…面试中」');
  // ① 已删文档降级：不渲染链接，渲染降级文案
  assert.ok(html.includes('原文档已删除'), '① promotedTo 指向已删文档的行应降级为「原文档已删除」');
  assert.ok(!html.includes('/edit?id=gone-doc'), '① 已删文档不得渲染 /edit 链接');
  // 兜底 join：公司·岗位 trim 后精确相等 → 命中 app2 且标「同名匹配」
  assert.ok(html.includes('同名匹配'), '兜底 join 命中的行应标「同名匹配」');
  assert.ok(html.includes('投于 ' + fmtExpected('2026-10-06 09:00')), '兜底 join 应渲染 app2 的 appliedAt（人话格式）');
  // 兜底不误配：戊公司的投递与任何评估都不同名
  assert.ok(!html.includes('戊公司'), '兜底 join 不得把不同名的投递误配进闭环卡');
  // ② 提醒区：verdict=apply 未转（evC）计入；evA 已转 / evB promotedTo 非空 / evD skip 均不计 → 恰 1 条
  assert.ok(html.includes('评估了却没投 1 条'), '② 提醒区应恰列 1 条（verdict=apply 未转的 evC）');
  // XSS：动态文本全部转义
  assert.ok(!html.includes('<script>alert(1)</script>'), '评估行动态文本必须转义（<script> 不得原样出现）');
  assert.ok(!html.includes('<img src=x'), '评估行动态文本必须转义（<img 不得原样出现）');
  assert.ok(html.includes('&lt;script&gt;'), '注入探针应以实体形式出现（过 escHtml）');
  // 红线：不新增任何转化率/匹配率/录用概率包装
  assert.ok(!/转化率|匹配率|录用概率|成功率/.test(html), '红线：闭环卡不得出现比率/概率包装');

  // ===== ④ /evals 页「已转适配」徽章链接化 =====
  const ev = await s1.get('/evals');
  assert.equal(ev.status, 200, '/evals 应 200');
  const evHtml = ev.html;
  assert.ok(evHtml.includes('已转适配'), '④ /evals 页应有「已转适配」徽章');
  assert.ok(/<a href="\/edit\?id=job1"[^>]*>\s*<span class="badge ok"[^>]*>[^]*?已转适配/.test(evHtml),
    '④ 在盘目标的「已转适配」应为包着徽章的 /edit 链接');
  assert.ok(!evHtml.includes('/edit?id=gone-doc'), '④ promotedTo 指向已删文档时不得渲染链接（维持纯徽章）');
  // 首页评估历史卡共用 evalHistoryRows：链接行为一致
  const home = await s1.get('/');
  assert.ok(/<a href="\/edit\?id=job1"[^>]*>\s*<span class="badge ok"[^>]*>[^]*?已转适配/.test(home.html),
    '④ 首页评估历史卡（共用渲染函数）同样链接化');

  // ================= rootNoEval：有投递、无 evaluations.json（读侧缺省 []）→ 闭环卡空态指引（③）=================
  const rootNoEval = mkRoot('noeval');
  writeDoc(rootNoEval, 'job2');
  fs.writeFileSync(path.join(rootNoEval, 'applications.json'), JSON.stringify([
    { id: 'app-loop-9', company: '', role: '', docId: 'job2', status: '已投递', appliedAt: '2026-10-08 09:00',
      channel: '', link: '', note: '', createdAt: '2026-10-08 09:00', updatedAt: '', interviews: [] }
  ]));
  const s2 = await startServer(rootNoEval);
  const st2 = await s2.get('/stats');
  assert.equal(st2.status, 200, '/stats（有投递无评估）应 200');
  assert.ok(st2.html.includes('评估 ↦ 投递'), '③ 有投递无评估时闭环卡应渲染（不早退）');
  assert.ok(st2.html.includes('还没有评估记录'), '③ 无评估记录应显示空态指引文案');

  // ================= rootEvalOnly：有评估、零投递 → 闭环卡仍渲染（⑤）；两表均空 → 恢复早退 =================
  const rootOnly = mkRoot('evalonly');
  writeDoc(rootOnly, 'job3');
  fs.writeFileSync(path.join(rootOnly, 'applications.json'), '[]');
  fs.writeFileSync(path.join(rootOnly, 'evaluations.json'), JSON.stringify(EVALS_ONLY));
  const s3 = await startServer(rootOnly);
  const st3 = await s3.get('/stats');
  assert.equal(st3.status, 200, '/stats（有评估无投递）应 200');
  assert.ok(st3.html.includes('评估 ↦ 投递'), '⑤ 有评估无投递时闭环卡仍渲染（不被空投递早退吞掉）');
  assert.ok(!st3.html.includes('先去投递看板添加记录'), '⑤ 有评估无投递时不得走空投递早退页');
  assert.ok(st3.html.includes('暂无投递记录'), '⑤ 该评估行应呈现「暂无投递记录」事实');
  // 两表均空 → 早退页（apps 与 evals 均为空才早退的反向验证：运行中清空评估表）
  fs.writeFileSync(path.join(rootOnly, 'evaluations.json'), '[]');
  const st4 = await s3.get('/stats');
  assert.ok(st4.html.includes('先去投递看板添加记录'), 'apps 与 evals 均空时才走早退页');

  console.log('✅ F1 评估↦投递闭环视图：主 join 链接与投递事实（①）/ 已删降级（①）/ 同名兜底 / 提醒区（②）/ 空态指引（③）/ /evals 徽章链接化（④）/ 有评估无投递不早退（⑤）/ 转义与零比率包装');
} catch (e) {
  cleanup();
  fail(e && e.message || String(e));
}
cleanup();   // 子进程 stdio 管道会撑住事件循环，必须显式回收后主进程才能自然退出
