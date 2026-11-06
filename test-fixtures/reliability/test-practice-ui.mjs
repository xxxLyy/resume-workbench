// test-practice-ui.mjs — 练习 UI（批 4 · 卡片 b4c2）：投递详情「面试练习」区 + 复盘页入口 + 逐题作答→反馈流
//   + 「缺的素材一键转待补充」（materials 轻量关联）+ 空态与降级文案。
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §5 批 4「面试练习包」（b4c1 已落 API 层，本卡只管 UI 与反哺）。
// 合同：
//   ① 投递详情「面试练习」区：可练性判定与 /app/practice/start 的 409 拒绝共用同一份 gate（单一通道，
//      文案零漂移）——不能练就不给「开始练习」入口（不给注定失败的按钮），降级原因照实渲染；
//      能练则给入口 + 练习历史（app.practice，最新在前）；出题零模型。
//   ② 逐题作答 → 反馈流：作答保存就地反馈（不整页 reload）；反馈走既有任务态（真实阶段/真实用量/无百分比）；
//      完成后就地渲染四字段（答到的事实/缺的指标或事实/夸大倾向/改进建议），零 JS 异常；模型产物不进 innerHTML。
//   ③ 缺的素材一键转「待补充素材」：POST /app/practice/missing/material（index 指向 result.missing 第几项，
//      服务端按落账文本建条目，不信客户端文本）→ materials.json 新增占位条目（factStatus=pending +
//      「待补充」标签，形状与 /mat/add 完全一致零新字段）+ 会话侧 missingMats 轻量关联；幂等（同项同素材）。
//   ④ 复盘页入口：侧卡「面试练习」段列最近 3 条跨投递练习摘要（链接直达 /app#pr-<pid>）；空态给去向指引。
//   ⑤ 空态与降级：未配置大模型 → 出题/作答照常、反馈按钮禁用 + 降级文案；无作答点反馈 → 行动位如实报 409 原因。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成岗位草稿/投递/素材 + 本机假 LLM；
//       不读真实数据、不碰 7766、不调真实模型、仓库零写入。
// 隐私门禁：合成数据不含 1[3-9]\d{9} 形态长数字（座机号、example.invalid、短指标数字）。
// 退出码契约：0=全部通过；1=任一断言失败；2=仅 Chromium 不可用且此前无失败（浏览器段跳过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';
import { normalizeZids, parasOf } from '../../zone.mjs';
import { contentHash } from '../../extract.mjs';
import { paraFingerprint } from '../../evidence.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-prui-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};

// —— 合成岗位草稿正文（b4c1 同款口径：data-zid 段落 + 面试追问产物）——
const JOB = 'practicejob';
const MASTER = 'practicemaster';
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
jobDoc = normalizeZids(jobDoc);
const jobParas = parasOf(jobDoc);
const workPara = jobParas.find((p) => p.text.includes('合成延迟压到 80ms'));
if (!workPara) fail('夹具基础设施错误：合成岗位草稿里取不到工作经历段落（parasOf 口径变了？）');
const ZID = workPara.zid;
const PF = paraFingerprint(workPara.text);

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

// —— 合成投递记录（A=岗位草稿有追问 / B=母版 / C=无 docId）+ 合成素材库种子一条 ——
const APP_IDS = { a: '2026-02-01-000000-001', b: '2026-02-02-000000-002', c: '2026-02-03-000000-003' };
const mkApp = (id, over = {}) => Object.assign({
  id, company: '合成公司', role: '合成岗位', docId: JOB, jd: '', note: '',
  channel: '官网', link: '', appliedAt: '2026-02-01', nextStep: '', dueDate: '',
  snapTs: '', exportId: null, contentHash: '', status: '已投递',
  createdAt: id, updatedAt: id, interviews: [],
}, over);
const MAT_SEED = { id: '2026-02-01-000000-100', title: '已有素材', brief: '合成既有素材条目', technical: '', interview: '', attach: '', tags: [], factStatus: 'confirmed', createdAt: '2026-02-01-000000-100', updatedAt: '2026-02-01-000000-100' };

const root = mkRoot('main');
const rootNoLlm = mkRoot('nollm');
const cleanupAll = () => {
  for (const r of [root, rootNoLlm]) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
};

// —— 假 LLM：返回四个字段的反馈（missing 给两条，转待补充要两条可各自转）——
let llmCalls = 0;
const HIT1 = '答到了把合成延迟压到 80ms 的手段';
const MISS1 = '没有给吞吐提升 40% 的对照口径';
const MISS2 = '没有说明压测的样本规模';
const ADVICE = '建议先讲手段再给数字，并说明 40% 的测量方式。';
const ANSWER1 = '我用连接池预热和批量合并把合成延迟压到 80ms，压测口径是固定请求速率下的 P99。';
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  llmCalls++;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ hit: [HIT1], missing: [MISS1, MISS2], exaggeration: [], advice: ADVICE }) } }],
    usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 },
  }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const writeConfig = (r) => fs.writeFileSync(path.join(r, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub', model: 'stub-model' }],
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

const get = async (base, p) => {
  const r = await fetch(base + p);
  return { status: r.status, text: await r.text() };
};
const postJson = async (base, p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const waitFeedback = async (base, id, pid, qid, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await get(base, '/app/practice/state?id=' + encodeURIComponent(id) + '&pid=' + encodeURIComponent(pid));
    let j = null; try { j = JSON.parse(s.text); } catch {}
    const fb = j && j.session && j.session.feedback ? j.session.feedback[qid] : null;
    if (fb && fb.task && fb.task.status !== 'running') return fb;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;   // 超时：让后续断言以显式失败收场（finally 仍可清理临时根）
};
const matsOnDisk = (r) => JSON.parse(fs.readFileSync(path.join(r, 'materials.json'), 'utf8'));
const appOnDisk = (r, id) => (JSON.parse(fs.readFileSync(path.join(r, 'applications.json'), 'utf8')).find((a) => a.id === id) || null);

let server = null;
let serverNoLlm = null;
let browser = null;
try {
  // —— 铺数据 ——
  fs.writeFileSync(path.join(root, 'docs', JOB + '.html'), jobDoc);
  fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), jobDoc.replaceAll(JOB, () => MASTER));
  fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [JOB]: jobMeta(INTERVIEW), [MASTER]: { rev: 1, flow: 'draft' } }, null, 2));
  writeConfig(root);
  fs.writeFileSync(path.join(root, 'materials.json'), JSON.stringify([MAT_SEED], null, 2));
  fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([
    mkApp(APP_IDS.a, { company: '甲公司' }),
    mkApp(APP_IDS.b, { company: '乙公司', docId: MASTER }),
    mkApp(APP_IDS.c, { company: '丙公司', docId: '' }),
  ], null, 2));
  // 无模型对照根：同数据、不写 config.json
  fs.writeFileSync(path.join(rootNoLlm, 'docs', JOB + '.html'), jobDoc);
  fs.writeFileSync(path.join(rootNoLlm, 'docs', MASTER + '.html'), jobDoc.replaceAll(JOB, () => MASTER));
  fs.writeFileSync(path.join(rootNoLlm, 'docs-meta.json'), JSON.stringify({ [JOB]: jobMeta(INTERVIEW), [MASTER]: { rev: 1, flow: 'draft' } }, null, 2));
  fs.writeFileSync(path.join(rootNoLlm, 'materials.json'), JSON.stringify([MAT_SEED], null, 2));
  fs.writeFileSync(path.join(rootNoLlm, 'applications.json'), JSON.stringify([mkApp(APP_IDS.a, { company: '甲公司' })], null, 2));

  server = await startServer(root);
  const base = server.base;
  const appPage = async (id) => get(base, '/app?id=' + encodeURIComponent(id));

  // ===== ① 投递详情「面试练习」区：入口 + 空态 + 门控降级（与 start 409 共用同一份判定文案）=====
  {
    const pA = await appPage(APP_IDS.a);
    assert.equal(pA.status, 200, '投递详情应 200，实际 ' + pA.status);
    assert.ok(pA.text.includes('id="practice"'), '应有「面试练习」区锚点（复盘页入口直达用），实际页面截断：' + pA.text.slice(pA.text.indexOf('投递详情'), pA.text.indexOf('投递详情') + 400));
    assert.ok(pA.text.includes('面试练习'), '应有「面试练习」卡题');
    assert.ok(pA.text.includes('data-pr="start"'), '可练（岗位草稿有追问）应给「开始练习」入口');
    assert.ok(pA.text.includes('开始练习'), '入口文案应为「开始练习」');
    assert.ok(pA.text.includes('id="prMsg"'), '应有入口失败信息位（服务端 409 原因就地呈现）');
    assert.ok(!pA.text.includes('class="pr-session'), '还没有练习历史时不应有会话列表（空态=只有入口）');
    // 门控降级：不能练就不给入口，原因照实渲染（文案与 /app/practice/start 409 同源）
    const pB = await appPage(APP_IDS.b);
    assert.equal(pB.status, 200, '母版投递详情应 200');
    assert.ok(pB.text.includes('不是岗位草稿'), '母版（非岗位草稿）应渲染降级原因（与 start 409 文案同源），实际：' + pB.text.slice(pB.text.indexOf('面试练习'), pB.text.indexOf('面试练习') + 300));
    assert.ok(!pB.text.includes('data-pr="start"'), '不能练就不给「开始练习」入口（不给注定失败的按钮）');
    const pC = await appPage(APP_IDS.c);
    assert.ok(pC.text.includes('还没有关联简历'), '无关联简历应渲染降级原因');
    assert.ok(!pC.text.includes('data-pr="start"'), '无关联简历不应有入口');
  }

  // ===== ② 复盘页入口：空态给去向指引 =====
  {
    const st = await get(base, '/stats');
    assert.equal(st.status, 200, '复盘页应 200，实际 ' + st.status);
    assert.ok(st.text.includes('面试练习'), '复盘侧卡应有「面试练习」段');
    assert.ok(st.text.includes('还没有练习记录'), '无练习时侧卡应给空态去向指引，实际：' + st.text.slice(st.text.indexOf('面试参与'), st.text.indexOf('面试参与') + 600));
  }

  // ===== ③ 出题 → 作答 → 反馈 done 后，练习区服务端渲染逐题视图（四字段/阶段用量/作答时间）=====
  const start = await postJson(base, '/app/practice/start', { id: APP_IDS.a });
  assert.equal(start.status, 200, '出题应 200，实际 ' + start.status + ' ' + start.text.slice(0, 200));
  const PID = start.json.pid;
  const ans = await postJson(base, '/app/practice/answer', { id: APP_IDS.a, pid: PID, qid: 'q1', text: ANSWER1 });
  assert.equal(ans.status, 200, '作答应 200，实际 ' + ans.status);
  const fbStart = await postJson(base, '/app/practice/feedback/start', { id: APP_IDS.a, pid: PID, qid: 'q1' });
  assert.equal(fbStart.status, 200, '反馈启动应 200，实际 ' + fbStart.status + ' ' + fbStart.text.slice(0, 200));
  const fbDone = await waitFeedback(base, APP_IDS.a, PID, 'q1');
  assert.equal(fbDone.task.status, 'done', '反馈应完成，实际：' + JSON.stringify(fbDone.task));
  {
    const p = await appPage(APP_IDS.a);
    assert.ok(p.text.includes('id="pr-' + PID + '"'), '练习会话应有锚点元素（复盘页直达）');
    assert.ok(p.text.includes(CHAIN_Q), '应渲染题面');
    assert.ok(p.text.includes(CHAIN_FU), '应渲染追问');
    assert.ok(p.text.includes('证据表要求'), '链题应渲染证据表要求行');
    assert.ok(p.text.includes(POINT_TXT), '应渲染证据要点');
    assert.ok(p.text.includes('引文已核验'), '要点应带来源状态标注（诚实：不当未核验事实）');
    assert.ok(p.text.includes(ANSWER1), '已保存作答应回填在输入框里');
    assert.ok(p.text.includes('作答于'), '应渲染作答时间');
    assert.ok(p.text.includes('2 题 · 答 1 · 反馈 1'), '会话摘要应如实呈现 2 题/已答 1/有反馈 1，实际：' + p.text.slice(p.text.indexOf('pr-session'), p.text.indexOf('pr-session') + 300));
    assert.ok(p.text.includes('答到的事实'), '反馈应渲染「答到的事实」');
    assert.ok(p.text.includes(HIT1), '应渲染答到的事实内容');
    assert.ok(p.text.includes('缺的指标或事实'), '反馈应渲染「缺的指标或事实」');
    assert.ok(p.text.includes(MISS1) && p.text.includes(MISS2), '应渲染两条缺项');
    assert.equal((p.text.match(/data-pr="mat"/g) || []).length, 2, '两条缺项各带一个「转待补充素材」按钮，实际：' + (p.text.match(/data-pr="mat"/g) || []).length);
    assert.ok(p.text.includes('转待补充素材'), '缺项行动位文案为「转待补充素材」');
    assert.ok(p.text.includes('夸大倾向') && p.text.includes('未发现夸大倾向'), '夸大倾向空数组应如实呈现「未发现夸大倾向」（不硬凑）');
    assert.ok(p.text.includes('改进建议') && p.text.includes(ADVICE), '应渲染逐题改进建议');
    assert.ok(p.text.includes('用量 333 tokens'), '应渲染服务商真实用量，实际：' + (p.text.match(/用量[^<]*/) || [''])[0]);
    assert.ok(!p.text.includes('百分位') && !p.text.includes('排名') && !p.text.includes('评分'), '诚实红线：练习区不得出现百分位/排名/评分字样');
  }

  // ===== ④ 缺的素材一键转「待补充素材」：materials 占位条目 + 会话侧轻量关联 + 幂等 + 守卫 =====
  let MATID1 = null;
  {
    const n0 = matsOnDisk(root).length;
    const r1 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q1', index: 0 });
    assert.equal(r1.status, 200, '转待补充应 200，实际 ' + r1.status + ' ' + r1.text.slice(0, 200));
    assert.ok(r1.json && r1.json.matId, '应返回素材 id');
    MATID1 = r1.json.matId;
    const mats = matsOnDisk(root);
    assert.equal(mats.length, n0 + 1, '素材库应恰好 +1');
    const m = mats.find((x) => x.id === MATID1);
    assert.ok(m, '新素材应落 materials.json');
    assert.equal(m.factStatus, 'pending', '转出的素材应为待确认（占位条目，事实层待用户补）');
    assert.equal(m.brief, MISS1, 'brief 应为反馈缺项原文（服务端按落账文本建，不信客户端文本）');
    assert.ok(m.title.startsWith('待补充：'), '标题应以「待补充：」开头，实际：' + m.title);
    assert.ok(Array.isArray(m.tags) && m.tags.includes('待补充'), '应带「待补充」标签（素材库可筛）');
    assert.deepEqual(Object.keys(m).sort(), ['attach', 'brief', 'createdAt', 'factStatus', 'id', 'interview', 'tags', 'technical', 'title', 'updatedAt'],
      '素材条目形状必须与 /mat/add 完全一致（零新字段，备份/恢复/合并路径不受影响），实际：' + JSON.stringify(Object.keys(m).sort()));
    const disk = appOnDisk(root, APP_IDS.a).practice.find((x) => x.pid === PID);
    assert.equal(disk.feedback.q1.missingMats['0'].matId, MATID1, '会话侧应记录轻量关联（missingMats）');
    // 幂等：同项再点 → 同一素材，不重复建条目
    const r2 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q1', index: 0 });
    assert.equal(r2.status, 200, '幂等重放应 200');
    assert.equal(r2.json.matId, MATID1, '幂等重放应返回同一素材 id');
    assert.equal(matsOnDisk(root).length, n0 + 1, '幂等重放不得新增条目');
    // 页面：已转的缺项呈现为链接态，未转的仍是按钮
    let p = await appPage(APP_IDS.a);
    assert.ok(p.text.includes('已转待补充素材'), '已转缺项应呈现「已转待补充素材」链接态');
    assert.equal((p.text.match(/data-pr="mat"/g) || []).length, 1, '未转的那条还是按钮，实际：' + (p.text.match(/data-pr="mat"/g) || []).length);
    // 第二条缺项 → 各自成条
    const r3 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q1', index: 1 });
    assert.equal(r3.status, 200, '第二项转待补充应 200');
    assert.notEqual(r3.json.matId, MATID1, '不同缺项应是不同素材');
    assert.equal(matsOnDisk(root).length, n0 + 2, '第二项应再 +1');
    p = await appPage(APP_IDS.a);
    assert.equal((p.text.match(/data-pr="mat"/g) || []).length, 0, '两条都转完后不应再有按钮，实际：' + (p.text.match(/data-pr="mat"/g) || []).length);
    assert.ok((p.text.match(/已转待补充素材/g) || []).length >= 2, '两条缺项都应呈现链接态');
    // 守卫矩阵：形状错即拒、越界/未知如实 4xx
    const g1 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q1', index: -1 });
    assert.equal(g1.status, 400, '负 index 应 400，实际 ' + g1.status);
    const g2 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q1', index: 1.5 });
    assert.equal(g2.status, 400, '非整数 index 应 400，实际 ' + g2.status);
    const g3 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q1', index: 99 });
    assert.equal(g3.status, 400, '越界 index 应 400，实际 ' + g3.status);
    const g4 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q1' });
    assert.equal(g4.status, 400, '缺 index 应 400，实际 ' + g4.status);
    const g5 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q99', index: 0 });
    assert.equal(g5.status, 404, '未知 qid 应 404，实际 ' + g5.status);
    const g6 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: 'pr-nope', qid: 'q1', index: 0 });
    assert.equal(g6.status, 404, '未知 pid 应 404，实际 ' + g6.status);
    const g7 = await postJson(base, '/app/practice/missing/material', { id: '2026-09-09-000000-999', pid: PID, qid: 'q1', index: 0 });
    assert.equal(g7.status, 404, '未知投递应 404，实际 ' + g7.status);
    const g8 = await postJson(base, '/app/practice/missing/material', { id: '../etc', pid: PID, qid: 'q1', index: 0 });
    assert.equal(g8.status, 400, '非法 id 形状应 400，实际 ' + g8.status);
    // 反馈还没生成的题：没有缺项记录 → 如实 400（不硬造）
    const g9 = await postJson(base, '/app/practice/missing/material', { id: APP_IDS.a, pid: PID, qid: 'q2', index: 0 });
    assert.equal(g9.status, 400, '无反馈结果的题应 400，实际 ' + g9.status);
  }

  // ===== ⑤ 复盘页入口：有数据 → 最近练习摘要 + 直达锚点 =====
  {
    const st = await get(base, '/stats');
    assert.ok(st.text.includes('/app?id=' + APP_IDS.a + '#pr-' + PID), '复盘侧卡应链接到 /app#pr-<pid>（直达练习会话）');
    assert.ok(st.text.includes('甲公司'), '摘要应带投递公司');
    assert.ok(st.text.includes('2 题 · 答 1 · 反馈 1'), '摘要应带题数/已答/反馈计数');
    assert.ok(!st.text.includes('还没有练习记录'), '有练习后空态指引应消失');
  }

  // ===== ⑥ 无模型降级：出题/作答照常给入口，反馈按钮禁用 + 降级文案 =====
  {
    serverNoLlm = await startServer(rootNoLlm);
    const p = await get(serverNoLlm.base, '/app?id=' + encodeURIComponent(APP_IDS.a));
    assert.ok(p.text.includes('未配置大模型'), '无模型应渲染降级文案（与反馈 409 同源），实际：' + p.text.slice(p.text.indexOf('面试练习'), p.text.indexOf('面试练习') + 300));
    assert.ok(/data-pr="fb"[^>]*disabled/.test(p.text), '无模型时反馈按钮应禁用');
    assert.ok(p.text.includes('data-pr="start"') && !/data-pr="start"[^>]*disabled/.test(p.text), '出题零模型 → 开始练习入口照常可用');
    assert.ok(!/data-pr="save"[^>]*disabled/.test(p.text), '作答不需要模型 → 保存作答照常可用');
  }

  // ===== ⑦ 浏览器段：逐题作答→反馈就地渲染→缺项一键转待补充（零整页 reload、零 JS 异常）=====
  {
    let bin = null;
    try { bin = await resolveChromium(); }
    catch (e) { console.log('⚠️  Chromium 不可用，跳过练习 UI 浏览器段：' + (e && e.message || e)); cleanupAll(); process.exit(2); }
    browser = await chromium.launch({ executablePath: bin, headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
    await page.goto(base + '/app?id=' + APP_IDS.a, { waitUntil: 'networkidle' });
    const q2 = '.pr-q[data-qid="q2"]';
    assert.ok(await page.isVisible(q2), '浏览器段：q2 应渲染');
    // 行动位诚实：无作答点反馈 → 服务端 409 原因就地呈现
    await page.click(q2 + ' button[data-pr="fb"]');
    const noAnsMsg = await page.waitForFunction((s) => {
      const el = document.querySelector(s + ' .pr-msg');
      return el && el.textContent.includes('作答');
    }, q2, { timeout: 8000 }).then(() => true).catch(() => false);
    assert.ok(noAnsMsg, '无作答点反馈应就地呈现「先作答」原因');
    // 作答保存就地反馈（不 reload）
    await page.evaluate(() => { window.__prMark = 'keep'; });
    await page.fill(q2 + ' .pr-answer', '我是合成姓名，做过合成交易系统与合成风控，和岗位方向一致。');
    await page.click(q2 + ' button[data-pr="save"]');
    const saved = await page.waitForFunction((s) => {
      const el = document.querySelector(s + ' .pr-status');
      return el && el.textContent.includes('作答已保存');
    }, q2, { timeout: 8000 }).then(() => true).catch(() => false);
    assert.ok(saved, '保存作答应就地呈现「作答已保存」');
    // 反馈：轮询真实阶段 → 完成就地渲染四字段（页面不刷新）
    await page.click(q2 + ' button[data-pr="fb"]');
    const fbRendered = await page.waitForFunction((s) => {
      const q = document.querySelector(s);
      const fb = q && q.querySelector('.pr-fb');
      return !!(fb && fb.textContent.includes('改进建议'));
    }, q2, { timeout: 25000 }).then(() => true).catch(() => false);
    assert.ok(fbRendered, '反馈完成后应就地渲染四字段（含改进建议）');
    const hitShown = await page.evaluate((s) => {
      const fb = document.querySelector(s + ' .pr-fb');
      return fb ? fb.textContent : '';
    }, q2);
    assert.ok(hitShown.includes(HIT1) && hitShown.includes('转待补充素材'), '就地渲染应含答到的事实与缺项按钮，实际：' + hitShown.slice(0, 200));
    // 缺项一键转待补充：就地按钮 → 链接态；materials.json 真的 +1；全程未整页 reload
    const matsBefore = matsOnDisk(root).length;
    await page.click(q2 + ' .pr-mat-line button[data-pr="mat"]');
    const matLinked = await page.waitForFunction((s) => !!document.querySelector(s + ' .pr-mat-line a'), q2, { timeout: 8000 }).then(() => true).catch(() => false);
    assert.ok(matLinked, '转待补充成功后按钮应就地变「已转待补充素材」链接');
    assert.equal(matsOnDisk(root).length, matsBefore + 1, '浏览器段转待补充应在素材库真实 +1');
    const mark = await page.evaluate(() => window.__prMark);
    assert.equal(mark, 'keep', '作答/反馈/转待补充全程不得整页 reload（未保存输入不丢）');
    assert.deepEqual(pageErrors, [], '页面不应有 JS 异常，实际：' + pageErrors.join(' || '));
  }

  // ===== ⑧ DESIGN.md 红线（.pr-* 新规则扫描）+ 冻结件零改动 =====
  {
    const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    const prRules = srv.split('\n').filter((l) => { const t = l.trim(); return t.startsWith('.pr-') && t.includes('{'); });
    assert.ok(prRules.length > 0, '应有 .pr-* 样式规则（练习区）');
    for (const line of prRules) {
      assert.ok(!/box-shadow/.test(line), '应用页新写规则不得有 box-shadow（§3.1），实际：' + line.trim());
      assert.ok(!/border-radius:\s*\d/.test(line), '圆角必须走 --radius/--radius-lg token（§5.2），实际：' + line.trim());
      const badSpacing = line.match(/(?:padding|margin|gap)(?:-(?:top|right|bottom|left))?:\s*[^;{}]*\d+px/g) || [];
      assert.deepEqual(badSpacing, [], '新写规则的间距必须用 --space-* token（§5.1），实际：' + JSON.stringify(badSpacing) + ' @ ' + line.trim());
      const badFont = line.match(/font-size:\s*(\d+)px/g) || [];
      for (const f of badFont) {
        assert.ok(['12px', '13px', '14px'].includes(f.replace('font-size:', '').trim()), '字号只准取既有档（§4.1：12/13/14px），实际：' + f + ' @ ' + line.trim());
      }
    }
    const classic = fs.readFileSync(path.join(APP_ROOT, 'themes', 'resume-classic.css'));
    assert.equal(createHash('sha1').update(classic).digest('hex'), 'e6efa7fa09f10e658ba73d62d4866aa1e24f5c1f',
      'themes/resume-classic.css 是渲染契约，不得改动');
    assert.equal(createHash('sha1').update(fs.readFileSync(path.join(APP_ROOT, 'template.html'))).digest('hex'),
      '29609d7474746b8f7825e35999c96c92297f15f3', 'template.html 冻结件不得改动');
    assert.equal(createHash('sha1').update(fs.readFileSync(path.join(APP_ROOT, 'render.mjs'))).digest('hex'),
      'fc5e3aaf16fd62c425c4b6925a765df7a6a239cb', 'render.mjs 冻结件不得改动');
  }

  console.log('✅ 练习 UI：投递详情「面试练习」区（gate 单一通道空态降级）+ 逐题作答→反馈就地渲染 + 缺项一键转待补充（materials 轻量关联、幂等）+ 复盘页入口 + 无模型降级');
} catch (e) {
  console.error('❌ ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  if (server) server.kill();
  if (serverNoLlm) serverNoLlm.kill();
  if (browser) { try { await browser.close(); } catch {} }
  try { llm.close(); } catch {}
  if (process.exitCode !== 2) cleanupAll();
}
