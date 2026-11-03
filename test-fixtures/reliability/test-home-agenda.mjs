// test-home-agenda.mjs — F4 首页近期日程聚合视图（逾期/面试）
// 验收口径（卡片原文，逐条进断言）：
//   ① applications.json 三条合成记录：dueDate=今天（已过时刻→已逾期）/ interviews[].time=明天 /
//      终态且已过期 —— GET / 断言前两条出现在「近期日程」卡内、终态不出现；
//   ② 链接 href 与转义正确（整行 <a href="/app?id=…">，id 过 escAttr；公司·岗位注入探针被 escHtml）；
//   ③ 已逾期条目排最前并标「已逾期」；类型徽章「截止」/「面试·轮次」可见；
//   ④ 空投递表时无该卡；
//   ⑤ 状态条「N 份逾期/近期面试提醒」文案不变且包成锚链指向该卡。
// 日期红线：dueDate/interviews[].time 全部测试运行时动态生成（Date.now()±偏移的 ISO），不写死日期。
// HTTP 类夹具：隔离 RESUME_ROOT + 随机端口 + assembleTemplate 合成文档；真实数据禁写禁删。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-agenda-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};
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
    kill: () => { try { server.kill('SIGKILL'); } catch {} }
  };
};

const servers = [];
const roots = [];
const cleanup = () => {
  for (const s of servers) s.kill();
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
};
process.on('exit', cleanup);

try {
  // ===== 主根：三条合成投递（日期全部运行时动态生成）=====
  const rootMain = mkRoot('main');
  writeDoc(rootMain, 'doc1');
  const overdueDue = new Date(Date.now() - 2 * 3600 * 1000).toISOString();      // 今天、已过 2h → 已逾期
  const tomorrowIv = new Date(Date.now() + 24 * 3600 * 1000).toISOString();     // 明天 → 未来 48h 窗口
  const goneDue = new Date(Date.now() - 72 * 3600 * 1000).toISOString();        // 3 天前已过期，但状态终态 → 不得出现
  const APPS = [
    { id: '2026-01-01-000000-001', company: '截止公司<img src=x onerror=alert(1)>', role: '后端', docId: 'doc1',
      jd: '', note: '', channel: '', link: '', appliedAt: '', nextStep: '', dueDate: overdueDue,
      status: '已投递', createdAt: '2026-01-01-000000-001', updatedAt: '2026-01-01-000000-001', interviews: [] },
    { id: '2026-01-01-000000-002', company: '面试公司', role: '测试<script>alert(2)</script>', docId: 'doc1',
      jd: '', note: '', channel: '', link: '', appliedAt: '', nextStep: '', dueDate: '',
      status: '面试中', createdAt: '2026-01-01-000000-002', updatedAt: '2026-01-01-000000-002',
      interviews: [{ round: '一面', time: tomorrowIv, questions: '', answer: '', feedback: '', next: '' }] },
    { id: '2026-01-01-000000-003', company: '终态公司', role: '算法', docId: 'doc1',
      jd: '', note: '', channel: '', link: '', appliedAt: '', nextStep: '', dueDate: goneDue,
      status: '已拒', createdAt: '2026-01-01-000000-003', updatedAt: '2026-01-01-000000-003', interviews: [] }
  ];
  fs.writeFileSync(path.join(rootMain, 'applications.json'), JSON.stringify(APPS));
  const s1 = await startServer(rootMain);
  servers.push(s1);

  const home = await s1.get('/');
  assert.equal(home.status, 200, 'GET / 应 200');
  const html = home.html;
  const cardIdx = html.indexOf('近期日程');
  assert.ok(cardIdx > 0, '① 首页应有「近期日程」卡');
  const cardHtml = (() => { const end = html.indexOf('searchrow', cardIdx); return html.slice(cardIdx, end); })();   // 卡体 = 标题到下一段

  // ①③ 前两条出现、终态不出现
  assert.ok(cardHtml.includes('2026-01-01-000000-001'), '① 逾期截止条目应出现在卡内');
  assert.ok(cardHtml.includes('2026-01-01-000000-002'), '① 明日面试条目应出现在卡内');
  assert.ok(!cardHtml.includes('2026-01-01-000000-003'), '① 终态（已拒）投递不得出现在卡内');
  assert.ok(!cardHtml.includes('终态公司'), '① 终态投递的公司不得出现在卡内');

  // ③ 类型徽章 + 已逾期标记 + 排序（逾期条目在前）
  assert.ok(cardHtml.includes('截止'), '③ 截止类目条目应有「截止」徽章');
  assert.ok(cardHtml.includes('面试·一面'), '③ 面试条目应有「面试·轮次」徽章');
  assert.ok(cardHtml.includes('已逾期'), '③ 已逾期条目应标「已逾期」');
  const idxOver = cardHtml.indexOf('2026-01-01-000000-001');
  const idxIv = cardHtml.indexOf('2026-01-01-000000-002');
  assert.ok(idxOver >= 0 && idxIv > idxOver, '③ 已逾期条目应排在明日面试之前（时间升序）');
  assert.ok(cardHtml.includes(overdueDue.slice(0, 10)), '③ 条目应显示时间（原样字段）');
  assert.ok(cardHtml.includes('面试公司·测试'), '③ 行应含公司·岗位');

  // ② 整行链接 + escAttr/escHtml 转义
  assert.ok(cardHtml.includes('<a href="/app?id=2026-01-01-000000-001"'), '② 整行应为 /app?id= 链接（escAttr 后 id 原样）');
  assert.ok(!cardHtml.includes('<img src=x'), '② 注入探针必须转义（<img 不得原样出现）');
  assert.ok(cardHtml.includes('&lt;img src=x'), '② 探针应以实体出现（过 escHtml）');
  assert.ok(!cardHtml.includes('<script>alert(2)'), '② role 注入探针必须转义');
  // 行内无交互元素：卡体 a 行内不得出现 button/input/select/textarea
  assert.ok(!/<a [^>]*>[^]*?(<button|<input|<select|<textarea)[^]*?<\/a>/.test(cardHtml), '② 日程行内不得有交互元素（badge 只能是 span）');
  assert.ok(cardHtml.includes('<span class="badge'), '③ 徽章为 span（合法嵌套 a）');

  // ⑤ 状态条锚链（文案不变）
  const statusIdx = html.indexOf('card statusline');
  assert.ok(statusIdx > 0 && statusIdx < cardIdx, '⑤ 近期日程卡应在状态摘要条下方');
  const statusHtml = html.slice(statusIdx, cardIdx);
  assert.ok(statusHtml.includes('href="#upcomingAgenda"'), '⑤ 状态条计数应包成锚链指向近期日程卡');
  assert.ok(/份逾期\/近期面试提醒/.test(statusHtml), '⑤ 状态条文案应保持不变');
  assert.ok(html.includes('id="upcomingAgenda"'), '⑤ 近期日程卡应带锚点 id');

  // ===== ④ 空投递表：无该卡 =====
  const rootEmpty = mkRoot('empty');
  writeDoc(rootEmpty, 'doc1');
  fs.writeFileSync(path.join(rootEmpty, 'applications.json'), '[]');
  const s2 = await startServer(rootEmpty);
  servers.push(s2);
  const home2 = await s2.get('/');
  assert.equal(home2.status, 200, '空表 GET / 应 200');
  assert.ok(!home2.html.includes('近期日程'), '④ 空投递表时不得渲染近期日程卡');
  assert.ok(!home2.html.includes('upcomingAgenda'), '④ 空投递表时不得有锚点与锚链残留');

  console.log('✅ F4 近期日程聚合：三条记录前两条入卡且终态排除（①）/ 链接与转义（②）/ 逾期排最前+类型徽章（③）/ 空表无卡（④）/ 状态条锚链文案不变（⑤）');
} catch (e) {
  cleanup();
  fail(e && e.message || String(e));
}
cleanup();
