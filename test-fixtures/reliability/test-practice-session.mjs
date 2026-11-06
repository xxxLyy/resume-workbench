// test-practice-session.mjs — 练习会话 API（批 4 · 卡片 b4c1）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §5 批 4「面试练习包」（本卡只管 API 层）。
// 合同（本卡边界：练习会话 API；投递详情/复盘页入口 UI、缺素材一键转待补充素材不在本卡）：
//   ① 出题 = 复用既有面试追问 kind=interview 产物：POST /app/practice/start 只读该投递关联
//      岗位草稿的 meta.job.interview（chains+generic，interviewSourceView 读视图）快照成练习会话，
//      **零模型调用**；没有岗位草稿 / 没有面试追问 → 409 明确拒绝（不留空会话）。
//   ② 逐题文本作答：POST /app/practice/answer（qid 级；空文本/超长 400 形状错即拒；重交 = 最近一次为准）。
//   ③ AI 对照证据表反馈：POST /app/practice/feedback/start（先有作答才生成；走既有 genTasks 口径：
//      真实阶段/真实用量/可取消/取消迟到零落账/并发闸）；结果形状 = {hit,missing,exaggeration,advice}——
//      **答到的事实 / 缺的指标 / 夸大倾向 / 逐题改进建议**；**无百分位、无排名、无评分字段**；
//      prompt 里钉诚实禁令；作答在反馈期间被改 → 反馈不落账（批次隔离同款）。
//   ④ 练习历史随投递持久化：app.practice（applications.json 既有账本，无新文件），最新在前截 20（F3 同款）。
//   ⑤ 诚实口径：反馈只落本机练习会话记录，**没有任何代码路径改动简历正文/meta 正文维度**（API 层逐字节验证）。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档/投递/岗位草稿 + 本机假 LLM；
//       不读真实数据、不碰 7766、不调真实模型、仓库零写入；API 夹具无浏览器段（exit 0/1）。
// 隐私门禁：合成数据不含 1[3-9]\d{9} 形态的长数字（座机号、example.invalid、短指标数字）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';
import { normalizeZids, parasOf } from '../../zone.mjs';
import { contentHash } from '../../extract.mjs';
import { paraFingerprint } from '../../evidence.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-practice-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};

// —— 合成岗位草稿正文：一条带指标的经历段（parasOf 可取到 data-zid 段落）——
const JOB = 'practicejob';        // 有面试追问产物
const JOB_EMPTY = 'practiceempty'; // 岗位草稿但未生成面试追问
const JOB_NOPOINTS = 'practicenopoints'; // 岗位草稿、追问在但没有任何可用要点（题面在、answerPoints 全空）
const MASTER = 'practicemaster';  // 母版（不是岗位草稿）
const entry = (title, role, date, bullet) =>
  `<div class="entry-head"><div class="entry-title">${title}</div><div class="entry-role">${role}</div><div class="entry-date">${date}</div></div>\n<ul>\n<li>${bullet}</li>\n</ul>`;
let jobDoc = assembleTemplate('classic');
const jobMap = {
  '{{NAME}}': '合成姓名',
  '{{CONTACT}}': '座机：021-5555-6666 邮箱：tester@example.invalid',
  '{{INTENT}}': '后端工程师',
  '{{SUMMARY}}': '合成自评：做过合成交易系统与合成风控。',
  '{{SKILLS}}': '<p><strong>语言：</strong>Go / Python</p>',
  '{{WORK}}': entry('合成公司', '后端工程师', '2021-02', '负责合成交易系统，把合成延迟压到 80ms，合成吞吐提升 40%'),
  '{{PROJECTS}}': '<p>项目一：合成数据管道重设计</p>',
  '{{EDU}}': entry('合成大学', '计算机', '2017-01', ''),
  '{{DOC_ID}}': JOB,
};
for (const [k, v] of Object.entries(jobMap)) jobDoc = jobDoc.replaceAll(k, () => v);
jobDoc = normalizeZids(jobDoc);   // 与真实保存管线同源：正文带 data-zid 才有可引用段落
const jobParas = parasOf(jobDoc);
const workPara = jobParas.find((p) => p.text.includes('合成延迟压到 80ms'));
if (!workPara) fail('夹具基础设施错误：合成岗位草稿里取不到工作经历段落（parasOf 口径变了？）');
const ZID = workPara.zid;
const PF = paraFingerprint(workPara.text);
const jobDocBytes = Buffer.from(jobDoc, 'utf8');   // ⑤ 逐字节比对基线

const REQ = '有高并发交易系统的优化经验';
const CHAIN_Q = '你在合成交易系统里是怎么把延迟压到 80ms 的？';
const CHAIN_FU = '如果流量再涨十倍，哪一层先扛不住？';
const POINT_TXT = '先讲压延迟的两个手段，再给结果数字';
const QUOTE = '把合成延迟压到 80ms';
const GENERIC_Q = '自我介绍';
const GENERIC_POINT = '结构思路：背景 → 与岗位相关的合成项目 → 为什么投这个岗';
const jobMeta = (interview) => ({
  kind: 'job', rev: 1,
  jd: '合成 JD：负责高并发交易系统的延迟与吞吐优化',
  company: '合成公司', role: '合成岗位',
  job: {
    evidence: [{ id: 'e1', req: REQ, status: 'covered',
      refs: [{ refId: 'b2r1', type: 'para', id: null, zid: ZID, srcStatus: 'confirmed', hash: PF, title: '', quote: QUOTE }],
      note: '', noteConfirmed: false }],
    evidenceGen: 2,
    ...(interview ? {
      interview,
      interviewGen: 1,
      interviewBaseHash: contentHash(jobDoc),
      interviewEvidenceGen: 2,
    } : {}),
  },
});
const INTERVIEW = {
  chains: [{ evIndex: 0, zid: ZID, question: CHAIN_Q, followUp: CHAIN_FU,
    answerPoints: [{ text: POINT_TXT, quote: QUOTE, source: { type: 'para', zid: ZID, hash: PF }, anchored: true, guard: 'normal' }], empty: false }],
  generic: [{ evIndex: -1, zid: '', question: GENERIC_Q, followUp: '',
    answerPoints: [{ text: GENERIC_POINT, quote: '', source: { type: 'none' }, anchored: false, guard: 'normal' }], empty: false }],
  dropped: 0, omitted: [],
};

// —— 合成投递记录（A=岗位草稿有关键产物 / B=母版 / C=空追问 / D=无简历）——
const APP_IDS = { a: '2026-02-01-000000-001', b: '2026-02-02-000000-002', c: '2026-02-03-000000-003', d: '2026-02-04-000000-004', e: '2026-02-05-000000-005' };
const mkApp = (id, over = {}) => Object.assign({
  id, company: '合成公司', role: '合成岗位', docId: JOB, jd: '', note: '',
  channel: '官网', link: '', appliedAt: '2026-02-01', nextStep: '', dueDate: '',
  snapTs: '', exportId: null, contentHash: '', status: '已投递',
  createdAt: id, updatedAt: id, interviews: [],
}, over);

const root = mkRoot('main');
const rootNoLlm = mkRoot('nollm');
const cleanupAll = () => {
  for (const r of [root, rootNoLlm]) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
};

// —— 假 LLM：可控延迟 / 可切坏输出；返回真实 usage（桩值即「服务商返回的用量」）——
let llmDelay = 0;
let llmMode = 'good';       // 'good' | 'bad'（非 JSON）| 'shape'（形状错）
let llmCalls = 0;
let lastLlmBody = '';
const FEEDBACK_JSON = {
  hit: ['答到了把合成延迟压到 80ms 的手段'],
  missing: ['没有给吞吐提升 40% 的对照口径'],
  exaggeration: [],
  advice: '建议先讲手段再给数字，并说明 40% 的测量方式。',
};
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  lastLlmBody = body;
  llmCalls++;
  if (llmDelay) await new Promise((r) => setTimeout(r, llmDelay));
  let content = JSON.stringify(FEEDBACK_JSON);
  if (llmMode === 'bad') content = '这不是 JSON';
  if (llmMode === 'shape') content = JSON.stringify({ hit: '应该是数组', missing: [], exaggeration: [], advice: '' });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 },
  }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const writeConfig = (r) => fs.writeFileSync(path.join(r, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }],
}));

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const startServer = async (r) => {
  const port = await freePort();
  const srv = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
    cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: r, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { const resp = await fetch(base + '/'); if (resp.ok) { await resp.text(); break; } } catch {}
    await new Promise((res2) => setTimeout(res2, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + log.slice(-800));
  }
  return { base, kill: () => { try { srv.kill('SIGKILL'); } catch {} }, log: () => log };
};

const getJson = async (base, p) => {
  const r = await fetch(base + p);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const postJson = async (base, p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const state = (base, id, pid) => getJson(base, '/app/practice/state?id=' + encodeURIComponent(id) + (pid ? '&pid=' + encodeURIComponent(pid) : ''));
const history = (base, id) => getJson(base, '/app/practice/history?id=' + encodeURIComponent(id));
const waitFeedback = async (base, id, pid, qid, until, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const s = await state(base, id, pid);
    last = s.json;
    const fb = last && last.session && last.session.feedback ? last.session.feedback[qid] : null;
    if (fb && until(fb)) return fb;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last && last.session ? (last.session.feedback || {})[qid] || null : null;
};
const appsOnDisk = (r) => JSON.parse(fs.readFileSync(path.join(r, 'applications.json'), 'utf8'));
const appOnDisk = (r, id) => (appsOnDisk(r).find((a) => a.id === id) || null);
// 临时根内包含某子串的文件（排除指定文件）——⑤「反馈只落练习记录」用
const filesContaining = (r, needle, { exclude = [] } = {}) => {
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (exclude.some((x) => p.endsWith(x))) continue;
      try { if (fs.readFileSync(p, 'utf8').includes(needle)) hits.push(p); } catch {}
    }
  };
  walk(r);
  return hits;
};

let server = null;
let serverNoLlm = null;
try {
  // —— 铺数据 ——
  fs.writeFileSync(path.join(root, 'docs', JOB + '.html'), jobDoc);
  const jobEmptyDoc = jobDoc.replaceAll(JOB, () => JOB_EMPTY);
  fs.writeFileSync(path.join(root, 'docs', JOB_EMPTY + '.html'), jobEmptyDoc);
  fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), jobDoc.replaceAll(JOB, () => MASTER));
  // 「没有任何可用要点」的岗位草稿：追问在（有题面），但 answerPoints 全空 → buildPracticeSession 收不到题
  const INTERVIEW_NOPOINTS = {
    chains: [{ evIndex: 0, zid: ZID, question: CHAIN_Q, followUp: CHAIN_FU, answerPoints: [], empty: false }],
    generic: [],
    dropped: 0, omitted: [],
  };
  fs.writeFileSync(path.join(root, 'docs', JOB_NOPOINTS + '.html'), jobDoc.replaceAll(JOB, () => JOB_NOPOINTS));
  fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
    [JOB]: jobMeta(INTERVIEW),
    [JOB_EMPTY]: jobMeta(null),
    [JOB_NOPOINTS]: jobMeta(INTERVIEW_NOPOINTS),
    [MASTER]: { rev: 1, flow: 'draft' },
  }, null, 2));
  writeConfig(root);
  fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([
    mkApp(APP_IDS.a, { company: '甲公司' }),
    mkApp(APP_IDS.b, { company: '乙公司', docId: MASTER }),
    mkApp(APP_IDS.c, { company: '丙公司', docId: JOB_EMPTY }),
    mkApp(APP_IDS.d, { company: '丁公司', docId: '' }),
    mkApp(APP_IDS.e, { company: '戊公司', docId: JOB_NOPOINTS }),
  ], null, 2));
  // 无模型对照根：同数据、不写 config.json
  fs.writeFileSync(path.join(rootNoLlm, 'docs', JOB + '.html'), jobDoc);
  fs.writeFileSync(path.join(rootNoLlm, 'docs', MASTER + '.html'), jobDoc.replaceAll(JOB, () => MASTER));
  fs.writeFileSync(path.join(rootNoLlm, 'docs-meta.json'), JSON.stringify({ [JOB]: jobMeta(INTERVIEW), [MASTER]: { rev: 1, flow: 'draft' } }, null, 2));
  fs.writeFileSync(path.join(rootNoLlm, 'applications.json'), JSON.stringify([
    mkApp(APP_IDS.a, { company: '甲公司' }), mkApp(APP_IDS.b, { company: '乙公司', docId: MASTER }),
  ], null, 2));

  server = await startServer(root);
  const base = server.base;

  // ===== ① 出题：复用 kind=interview 产物快照成会话（零模型调用；无产物明确 409）=====
  {
    const callsBefore = llmCalls;
    const start = await postJson(base, '/app/practice/start', { id: APP_IDS.a });
    assert.equal(start.status, 200, '出题应 200，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    assert.ok(start.json && start.json.pid, '出题应返回 pid，实际：' + start.text.slice(0, 200));
    const PID = start.json.pid;
    const st = await state(base, APP_IDS.a, PID);
    assert.equal(st.status, 200, 'state 应 200，实际 ' + st.status + ' ' + st.text.slice(0, 200));
    const s = st.json.session;
    assert.equal(s.questions.length, 2, '会话应快照 2 题（1 chain + 1 generic），实际：' + JSON.stringify(s.questions.map((q) => q.question)));
    const [q1, q2] = s.questions;
    assert.equal(q1.kind, 'chain', 'q1 应为 chain 题');
    assert.equal(q1.evIndex, 0, 'chain 题应保留 evIndex');
    assert.equal(q1.question, CHAIN_Q, 'chain 题面应来自既有追问产物');
    assert.equal(q1.followUp, CHAIN_FU, '追问应随题快照');
    assert.equal(q1.req, REQ, '证据批次绑定时 chain 题应带对应证据表要求行，实际：' + JSON.stringify(q1.req));
    assert.equal(q1.points.length, 1, 'chain 题应带证据要点');
    assert.equal(q1.points[0].quote, QUOTE, '要点应带已核验引文');
    assert.equal(q1.points[0].sourceState, 'fresh', '未改动正文时要点来源应为 fresh，实际：' + q1.points[0].sourceState);
    assert.equal(q2.kind, 'generic', 'q2 应为 generic 题');
    assert.equal(q2.req, null, 'generic 题没有对应要求行（req=null，不硬凑）');
    assert.equal(s.interviewStale, false, '正文未动、证据批次一致 → 不应标 stale');
    assert.equal(s.docId, JOB, '会话应记录出处（docId）');
    assert.equal(llmCalls, callsBefore, '出题只读既有产物，不得调用模型（实际调了 ' + (llmCalls - callsBefore) + ' 次）');
    // state 形状守卫
    const badPid = await state(base, APP_IDS.a, 'pr-nope');
    assert.equal(badPid.status, 404, '不存在的 pid 应 404，实际 ' + badPid.status);
    const noPid = await state(base, APP_IDS.a, '');
    assert.equal(noPid.status, 400, '缺 pid 应 400，实际 ' + noPid.status);
    // 出题的拒绝路径（诚实：不是每份简历都有岗位草稿/追问）
    const r404 = await postJson(base, '/app/practice/start', { id: '2026-09-09-000000-999' });
    assert.equal(r404.status, 404, '不存在的投递应 404，实际 ' + r404.status);
    const r400 = await postJson(base, '/app/practice/start', { id: '../etc' });
    assert.equal(r400.status, 400, '非法 id 形状应 400，实际 ' + r400.status);
    const rB = await postJson(base, '/app/practice/start', { id: APP_IDS.b });
    assert.equal(rB.status, 409, '母版（非岗位草稿）应 409，实际 ' + rB.status);
    assert.ok(String((rB.json && rB.json.error) || '').includes('岗位草稿'), '409 原因应说明出题复用岗位草稿的面试追问，实际：' + rB.text.slice(0, 200));
    const rC = await postJson(base, '/app/practice/start', { id: APP_IDS.c });
    assert.equal(rC.status, 409, '岗位草稿但没生成面试追问应 409，实际 ' + rC.status);
    assert.ok(String((rC.json && rC.json.error) || '').includes('面试追问'), '409 原因应写明先去生成面试追问，实际：' + rC.text.slice(0, 200));
    const rD = await postJson(base, '/app/practice/start', { id: APP_IDS.d });
    assert.equal(rD.status, 409, '没关联简历的投递应 409，实际 ' + rD.status);
    // 四类 409 的最后一类：追问在、但没有任何可用要点（题面在、要点全空 → 收不到题，不留空会话）
    const rE = await postJson(base, '/app/practice/start', { id: APP_IDS.e });
    assert.equal(rE.status, 409, '追问没有任何可用要点应 409，实际 ' + rE.status + ' ' + rE.text.slice(0, 200));
    assert.ok(String((rE.json && rE.json.error) || '').includes('可用要点'), '409 原因应写明没有可用要点，实际：' + rE.text.slice(0, 200));
  }

  // ===== ② 练习历史随投递持久化（截 20，F3 同款：最新在前）=====
  {
    const h0 = await history(base, APP_IDS.a);
    assert.equal(h0.status, 200, 'history 应 200，实际 ' + h0.status);
    assert.equal(h0.json.sessions.length, 1, '①段出题后历史应有 1 条');
    const firstPid = h0.json.sessions[0].pid;
    for (let i = 0; i < 20; i++) {
      const s = await postJson(base, '/app/practice/start', { id: APP_IDS.a });
      assert.equal(s.status, 200, '第 ' + (i + 1) + ' 次出题应 200');
    }
    const h1 = await history(base, APP_IDS.a);
    assert.equal(h1.json.sessions.length, 20, '历史应截 20（F3 同款），实际：' + h1.json.sessions.length);
    assert.notEqual(h1.json.sessions[0].pid, firstPid, '最新在前：最老会话应被挤出');
    assert.ok(!h1.json.sessions.some((x) => x.pid === firstPid), '最老会话不应再出现在历史里');
    const disk = appOnDisk(root, APP_IDS.a);
    assert.ok(Array.isArray(disk.practice) && disk.practice.length === 20, '落盘应截 20，实际：' + (disk.practice || []).length);
    assert.equal(disk.practice[0].pid, h1.json.sessions[0].pid, '落盘第一条应为最新会话（最新在前）');
    assert.ok(h1.json.sessions.every((x) => x.questionCount === 2 && x.company === '甲公司'), 'history 摘要应带题数与投递公司快照，实际：' + JSON.stringify(h1.json.sessions[0]));
    const hB = await history(base, '2026-09-09-000000-999');
    assert.equal(hB.status, 404, '不存在投递的 history 应 404');
  }

  // ===== ③ 逐题文本作答（形状错即拒；重交 = 最近一次为准）=====
  const PID = (await history(base, APP_IDS.a)).json.sessions[0].pid;   // 最新会话
  const ANSWER1 = '我用连接池预热和批量合并把合成延迟压到 80ms，压测口径是固定请求速率下的 P99。';
  {
    const badPid = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: 'pr-nope', qid: 'q1', text: ANSWER1 });
    assert.equal(badPid.status, 404, '不存在的会话作答应 404，实际 ' + badPid.status);
    const badQid = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q99', text: ANSWER1 });
    assert.equal(badQid.status, 404, '不存在的题目作答应 404，实际 ' + badQid.status);
    const empty = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q1', text: '   ' });
    assert.equal(empty.status, 400, '空白作答应 400（形状错即拒），实际 ' + empty.status);
    const missing = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q1' });
    assert.equal(missing.status, 400, '缺 text 应 400，实际 ' + missing.status);
    const tooLong = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q1', text: '长'.repeat(4001) });
    assert.equal(tooLong.status, 400, '超长作答应 400，实际 ' + tooLong.status);
    const ok = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q1', text: ANSWER1 });
    assert.equal(ok.status, 200, '合法作答应 200，实际 ' + ok.status + ' ' + ok.text.slice(0, 200));
    const disk = appOnDisk(root, APP_IDS.a).practice.find((x) => x.pid === PID);
    assert.ok(disk && disk.answers && disk.answers.q1 && disk.answers.q1.text === ANSWER1, '作答应落本会话 answers[qid]，实际：' + JSON.stringify(disk && disk.answers));
    assert.ok(disk.answers.q1.at, '作答应记录时间（at）');
    // 重交 = 最近一次为准（改口不另开题）
    const ANSWER1B = ANSWER1 + ' 补一句：40% 是对比改造前同一压测的吞吐。';
    const ok2 = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q1', text: ANSWER1B });
    assert.equal(ok2.status, 200, '重交应 200');
    const disk2 = appOnDisk(root, APP_IDS.a).practice.find((x) => x.pid === PID);
    assert.equal(disk2.answers.q1.text, ANSWER1B, '重交后应以最近一次为准，实际：' + JSON.stringify(disk2.answers.q1));
  }

  // ===== ④ AI 对照证据表反馈（答到/缺的指标/夸大倾向/逐题建议；无百分位无排名；不改正文）=====
  {
    // 没作答就生成反馈 → 409（先作答再反馈）
    const noAns = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q2' });
    assert.equal(noAns.status, 409, '未作答的题生成反馈应 409，实际 ' + noAns.status);
    assert.ok(String((noAns.json && noAns.json.error) || '').includes('作答'), '409 原因应写明先作答，实际：' + noAns.text.slice(0, 200));
    // 作答 q2（generic）→ 对 q1（chain）生成反馈
    await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q2', text: '我是合成姓名，做过合成交易系统与合成风控，和贵司这个岗位方向一致。' });
    const docBefore = fs.readFileSync(path.join(root, 'docs', JOB + '.html'));
    const metaBefore = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'))[JOB];
    const fb = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q1' });
    assert.equal(fb.status, 200, '反馈生成应 200，实际 ' + fb.status + ' ' + fb.text.slice(0, 200));
    assert.ok(fb.json && fb.json.taskId, '反馈应返回 taskId');
    const done = await waitFeedback(base, APP_IDS.a, PID, 'q1', (x) => x.task && x.task.status !== 'running');
    assert.equal(done.task.status, 'done', '反馈应完成，实际：' + JSON.stringify(done.task));
    assert.equal(done.task.usage && done.task.usage.total, 333, '用量应取服务商真实返回（total=333），实际：' + JSON.stringify(done.task.usage));
    assert.equal(done.task.model, 'stub-model', '任务应记录模型名');
    assert.ok(!('percent' in done.task) && !('progress' in done.task), '任务记录不得有百分比/进度字段（诚实最小进度）');
    assert.ok(done.result && typeof done.result === 'object', '应有反馈结果');
    assert.deepEqual(Object.keys(done.result).sort(), ['advice', 'exaggeration', 'hit', 'missing'],
      '反馈结果只准四个字段（答到的事实/缺的指标/夸大倾向/改进建议），不得有评分/百分位/排名字段，实际：' + JSON.stringify(Object.keys(done.result)));
    assert.ok(Array.isArray(done.result.hit) && done.result.hit.length > 0, '应给出答到的事实');
    assert.ok(Array.isArray(done.result.missing), '缺的指标应为数组');
    assert.ok(Array.isArray(done.result.exaggeration), '夸大倾向应为数组（空数组=未发现，诚实）');
    assert.ok(typeof done.result.advice === 'string' && done.result.advice.length > 0, '应有逐题改进建议');
    // prompt 契约：题目/要点/引文/要求行/作答都在；诚实禁令钉死
    assert.ok(lastLlmBody.includes(CHAIN_Q), 'prompt 应带题面，实际：' + lastLlmBody.slice(0, 400));
    assert.ok(lastLlmBody.includes(QUOTE), 'prompt 应带证据要点引文');
    assert.ok(lastLlmBody.includes(REQ), 'prompt 应带证据表要求行（对照证据表）');
    assert.ok(lastLlmBody.includes('80ms'), 'prompt 应带作答原文');
    assert.ok(lastLlmBody.includes('百分位') && lastLlmBody.includes('排名'), 'prompt 应钉诚实禁令（不做百分位/排名）');
    assert.ok(lastLlmBody.includes('不直接改') || lastLlmBody.includes('不改写'), 'prompt 应钉「反馈不改正文」口径');
    // ⑤ 诚实口径：正文与 meta 正文维度逐字节不变；反馈只落 applications.json
    assert.deepEqual(fs.readFileSync(path.join(root, 'docs', JOB + '.html')), docBefore, '反馈不得改动简历正文（逐字节）');
    const metaAfter = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'))[JOB];
    assert.deepEqual(metaAfter, metaBefore, '反馈不得改动岗位草稿 meta（追问/证据表/批次）');
    const needle = FEEDBACK_JSON.advice.slice(0, 12);
    const hits = filesContaining(root, needle, { exclude: ['applications.json'] });
    assert.deepEqual(hits, [], '反馈结果不得落在练习记录以外的文件，实际：' + JSON.stringify(hits));
    const diskFb = appOnDisk(root, APP_IDS.a).practice.find((x) => x.pid === PID).feedback.q1;
    assert.equal(diskFb.result.advice, FEEDBACK_JSON.advice, '反馈结果应落练习会话记录');
    // 解析失败：坏输出显式失败，result 保持 null（不落半个结果）
    llmMode = 'bad';
    const fb2 = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q2' });
    assert.equal(fb2.status, 200, '坏输出场景的启动仍应 200（失败在任务态里如实呈现）');
    const done2 = await waitFeedback(base, APP_IDS.a, PID, 'q2', (x) => x.task && x.task.status !== 'running');
    assert.equal(done2.task.status, 'error', '无法解析应置 error，实际：' + JSON.stringify(done2.task));
    assert.ok(String(done2.task.error || '').includes('无法解析'), '错误应写明无法解析，实际：' + done2.task.error);
    assert.equal(done2.result ?? null, null, '解析失败不得落任何结果');
    llmMode = 'shape';
    const fb3 = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q2' });
    assert.equal(fb3.status, 200, '形状错场景的启动仍应 200');
    const done3 = await waitFeedback(base, APP_IDS.a, PID, 'q2', (x) => x.task && x.task.status !== 'running');
    assert.equal(done3.task.status, 'error', '形状错应置 error（形状错即拒），实际：' + JSON.stringify(done3.task));
    assert.equal(done3.result ?? null, null, '形状错不得落任何结果');
    llmMode = 'good';
  }

  // ===== ⑤ 取消 → 迟到结果零落账；⑥ 并发闸（同投递 1 个 running）=====
  {
    llmDelay = 1500;
    const fb = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q2' });
    assert.equal(fb.status, 200, '取消场景启动应 200');
    const taskId = fb.json.taskId;
    const cancel = await postJson(base, '/app/practice/feedback/cancel', { id: APP_IDS.a, pid: PID, qid: 'q2', taskId });
    assert.equal(cancel.status, 200, '取消应 200，实际 ' + cancel.status + ' ' + cancel.text.slice(0, 200));
    const again = await postJson(base, '/app/practice/feedback/cancel', { id: APP_IDS.a, pid: PID, qid: 'q2', taskId });
    assert.equal(again.status, 409, '重复取消应 409（taskId 不再匹配 running），实际 ' + again.status);
    const wrongId = await postJson(base, '/app/practice/feedback/cancel', { id: APP_IDS.a, pid: PID, qid: 'q2', taskId: 'f-nope' });
    assert.equal(wrongId.status, 409, 'taskId 不匹配应 409，实际 ' + wrongId.status);
    // 被取消的任务仍占着 AI 槽直到这次真实调用结束（释放 = 工作真正结束，RES-02 口径）：
    // 等槽释放后再测并发闸，否则 409 闸会被更早的 429（槽满）挡住，测不到想测的东西。
    await new Promise((r) => setTimeout(r, 1700));
    // 同投递并发闸：q1 的反馈在跑时，再启动 q2 应 409
    const par = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q1' });
    assert.equal(par.status, 200, 'q1 反馈启动应 200（同会话不同题可排队后启动）');
    const par2 = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q2' });
    assert.equal(par2.status, 409, '同投递已有一个反馈在跑时应 409，实际 ' + par2.status);
    assert.ok(String((par2.json && par2.json.error) || '').includes('进行中'), '409 原因应写明已有任务进行中，实际：' + par2.text.slice(0, 200));
    llmDelay = 0;
    const doneQ1 = await waitFeedback(base, APP_IDS.a, PID, 'q1', (x) => x.task && x.task.status !== 'running');
    assert.equal(doneQ1.task.status, 'done', '排队后的 q1 反馈应正常完成');
    // ⑤ 迟到零落账：已取消的 q2 不得出现结果
    await new Promise((r) => setTimeout(r, 2200));
    const stQ2 = await state(base, APP_IDS.a, PID);
    const fbQ2 = stQ2.json.session.feedback.q2;
    assert.equal(fbQ2.task.status, 'cancelled', '被取消的任务应为 cancelled，实际：' + JSON.stringify(fbQ2.task));
    assert.equal(fbQ2.result ?? null, null, '取消后迟到结果零落账（不得出现反馈结果）');
  }

  // ===== ⑥b 作答在反馈期间被改 → 反馈不落账（practice.mjs 的 expectedAnswer 快照闭包）=====
  {
    const ANSWER_OLD = '反馈期间不改口的原始作答。';
    await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q2', text: ANSWER_OLD });
    llmDelay = 2000;   // 让反馈任务停在 running，好在其间改作答
    const fb = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q2' });
    assert.equal(fb.status, 200, '反馈启动应 200，实际 ' + fb.status + ' ' + fb.text.slice(0, 200));
    // 反馈运行期间改口（重交 = 最近一次为准，作答本身是合法动作）
    const ANSWER_NEW = '反馈期间改口后的新作答（对照关系已与本次生成脱节）。';
    const re = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q2', text: ANSWER_NEW });
    assert.equal(re.status, 200, '反馈期间重交作答应 200（作答合法），实际 ' + re.status);
    const done = await waitFeedback(base, APP_IDS.a, PID, 'q2', (x) => x.task && x.task.status !== 'running');
    assert.equal(done.task.status, 'error', '作答被改后反馈应显式失败（不张冠李戴），实际：' + JSON.stringify(done.task));
    assert.ok(String(done.task.error || '').includes('被修改'), '错误应写明作答在反馈期间被修改，实际：' + done.task.error);
    assert.equal(done.result ?? null, null, '被拒的反馈不得落任何结果');
    // 新作答保留（不回滚旧作答）；prompt 用的是启动时的旧作答快照（快照闭包）
    const disk = appOnDisk(root, APP_IDS.a).practice.find((x) => x.pid === PID);
    assert.equal(disk.answers.q2.text, ANSWER_NEW, '改口后的作答应保留（反馈拒绝不回滚作答）');
    assert.ok(lastLlmBody.includes('反馈期间不改口的原始作答'), 'prompt 应带启动时快照的旧作答（快照闭包），实际：' + lastLlmBody.slice(0, 400));
    llmDelay = 0;
  }

  // ===== ⑦ 无模型：出题照常（零模型），反馈 409 明确降级 =====
  {
    serverNoLlm = await startServer(rootNoLlm);
    const s = await postJson(serverNoLlm.base, '/app/practice/start', { id: APP_IDS.a });
    assert.equal(s.status, 200, '无模型时出题应照常 200（出题不调模型），实际 ' + s.status + ' ' + s.text.slice(0, 200));
    const pidN = s.json.pid;
    await postJson(serverNoLlm.base, '/app/practice/answer', { id: APP_IDS.a, pid: pidN, qid: 'q1', text: '合成作答。' });
    const fb = await postJson(serverNoLlm.base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: pidN, qid: 'q1' });
    assert.equal(fb.status, 409, '无模型时反馈应 409，实际 ' + fb.status);
    assert.ok(String((fb.json && fb.json.error) || '').includes('未配置大模型'), '409 原因应写明未配置大模型，实际：' + fb.text.slice(0, 200));
  }

  // ===== ⑧ DESIGN.md 红线 + 冻结件零改动 =====
  {
    const classic = fs.readFileSync(path.join(APP_ROOT, 'themes', 'resume-classic.css'));
    assert.equal(createHash('sha1').update(classic).digest('hex'), 'e6efa7fa09f10e658ba73d62d4866aa1e24f5c1f',
      'themes/resume-classic.css 是渲染契约，不得改动');
    assert.equal(createHash('sha1').update(fs.readFileSync(path.join(APP_ROOT, 'template.html'))).digest('hex'),
      '29609d7474746b8f7825e35999c96c92297f15f3', 'template.html 冻结件不得改动');
    assert.equal(createHash('sha1').update(fs.readFileSync(path.join(APP_ROOT, 'render.mjs'))).digest('hex'),
      'fc5e3aaf16fd62c425c4b6925a765df7a6a239cb', 'render.mjs 冻结件不得改动');
  }

  console.log('✅ 练习会话 API：出题复用 kind=interview 产物（零模型）+ 逐题作答 + AI 对照证据表反馈（无百分位无排名、不改正文）+ 历史随投递截 20');
} catch (e) {
  console.error('❌ ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  if (server) server.kill();
  if (serverNoLlm) serverNoLlm.kill();
  try { llm.close(); } catch {}
  cleanupAll();
}
