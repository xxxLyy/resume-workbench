// test-followup-assistant.mjs — 跟进助手（批 3 · 卡片 b3c4）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4 批 3「S8 网申包 + 跟进助手」（跟进助手条目）。
// 合同（本卡只管跟进助手，不做分享副本/投递记录关联字段包——那是批 3 后续卡）：
//   ① 判定：投递卡「无回应超 N 天（默认 7，/settings 可配）」→ 显示「生成跟进语」入口。
//      「无回应」= 状态仍是「已投递」且没有任何面试记录（进了笔试/面试 = 对方已回应；终态/搁置不再提示）。
//      天数基准 = 投递日期（appliedAt，缺省回落创建日），满 N 天（days >= N）才提示。
//   ② 阈值可配：/settings 有输入；config.json 落库；缺省 = 7；非法值 400（形状错即拒）。
//   ③ 生成走既有 genTasks 口径：真实阶段（无百分比）、服务商真实用量、可取消、取消后迟到结果零落账。
//   ④ 草稿不发送：生成结果只落本机投递记录；页面只有「复制/丢弃」，**没有任何发送/代填/外发入口**。
//   ⑤ 与既有逾期/临近截止提醒并存不冲突：同一张卡可同时有「临近截止」与「生成跟进语」；
//      首页既有「逾期/近期面试提醒」日程卡不受影响。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档与投递 + 本机假 LLM；
//       不读真实数据、不碰 7766、不调真实模型、仓库零写入。
// 隐私门禁：合成数据不含 1[3-9]\d{9} 形态的 11 位长数字（电话用座机号，邮箱用 example.invalid）；
//            夹具内不写 13 位时间戳（长数字第二位避开 3-9）。
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

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-followup-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};

// —— 合成日期串（本地日历日）：N 天前 = 今天减 N 天 ——
// 判定口径：满 N 天（days >= N）才提示跟进；与 followup.mjs 的天算法一致（两个日历日之差）。
const dayStr = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// —— 合成母版简历（跟进语的取材来源）——
const MASTER = 'fupmaster';
const entry = (title, role, date, bullet) =>
  `<div class="entry-head"><div class="entry-title">${title}</div><div class="entry-role">${role}</div><div class="entry-date">${date}</div></div>\n<ul>\n<li>${bullet}</li>\n</ul>`;
let masterDoc = assembleTemplate('classic');
const masterMap = {
  '{{NAME}}': '合成姓名',
  '{{CONTACT}}': '座机：021-5555-6666 邮箱：tester@example.invalid',
  '{{INTENT}}': '后端工程师',
  '{{SUMMARY}}': '合成自评：做过合成交易系统与合成风控。',
  '{{SKILLS}}': '<p><strong>语言：</strong>Go / Python</p>',
  '{{WORK}}': entry('合成公司', '后端工程师', '2021-03', '负责合成交易系统，把合成延迟压到 80ms'),
  '{{PROJECTS}}': '<p>项目一：合成数据管道重设计</p>',
  '{{EDU}}': entry('合成大学', '计算机', '2017-06', ''),
  '{{DOC_ID}}': MASTER,
};
for (const [k, v] of Object.entries(masterMap)) masterDoc = masterDoc.replaceAll(k, () => v);

// —— 合成投递记录（判定矩阵）——
// A1 满 8 天无回应 → 应有入口；A2 才 2 天 → 不该有；A3 已在面试中 → 不该有；
// A4 有面试记录 → 不该有；A5 满 9 天且临近截止 → 两者并存；A6 已录用 → 不该有；A7 满 7 天（默认阈值的边界）→ 应有。
const APP_IDS = {
  a1: '2026-02-01-000000-001',
  a2: '2026-02-02-000000-002',
  a3: '2026-02-03-000000-003',
  a4: '2026-02-04-000000-004',
  a5: '2026-02-05-000000-005',
  a6: '2026-02-06-000000-006',
  a7: '2026-02-07-000000-007',
  a8: '2026-02-08-000000-008',
};
const mkApp = (id, over = {}) => Object.assign({
  id, company: '合成公司', role: '合成岗位', docId: MASTER, jd: '', note: '',
  channel: '官网', link: '', appliedAt: dayStr(8), nextStep: '', dueDate: '',
  snapTs: '', exportId: null, contentHash: '', status: '已投递',
  createdAt: id, updatedAt: id, interviews: [],
}, over);

const root = mkRoot('main');
const rootNoLlm = mkRoot('nollm');
const cleanupAll = () => {
  for (const r of [root, rootNoLlm]) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
};

// —— 假 LLM：可控延迟 / 可切空输出；返回真实 usage（桩值即「服务商返回的用量」）——
let llmDelay = 0;
let llmMode = 'good';       // 'good' | 'empty'
let llmCalls = 0;
let lastLlmBody = '';
const FOLLOW_TEXT = '合成跟进语：您好，我是合成公司的合成工程师，做过合成交易系统，方便时看下简历。';
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  lastLlmBody = body;
  llmCalls++;
  if (llmDelay) await new Promise((r) => setTimeout(r, llmDelay));
  const content = llmMode === 'empty' ? '   ' : FOLLOW_TEXT;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 },
  }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const writeConfig = (r, extra = {}) => fs.writeFileSync(path.join(r, 'config.json'), JSON.stringify(Object.assign({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }],
}, extra)));

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

const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const postJson = async (base, p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const fuState = async (base, id) => {
  const r = await get(base, '/app/followup/state?id=' + encodeURIComponent(id));
  let json = null;
  try { json = JSON.parse(r.text); } catch {}
  return { status: r.status, json, text: r.text };
};
const waitFollow = async (base, id, until, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const s = await fuState(base, id);
    last = s.json;
    if (last && until(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
};
const appsOnDisk = (r) => JSON.parse(fs.readFileSync(path.join(r, 'applications.json'), 'utf8'));
const appOnDisk = (r, id) => (appsOnDisk(r).find((a) => a.id === id) || null);
// 卡片里的跟进块：data-fu-app="<id>" 的整块（按 div 深度取到配对的收尾，不靠猜标记）
const fuBox = (html, id) => {
  const key = 'data-fu-app="' + id + '"';
  const i = html.indexOf(key);
  if (i < 0) return '';
  const start = html.lastIndexOf('<div class="fu-box"', i);
  if (start < 0) return '';
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (m[0] === '</div>') { depth--; if (depth === 0) return html.slice(start, m.index + 6); }
    else depth++;
  }
  return html.slice(start);
};

let server = null;
let serverNoLlm = null;
try {
  let firstDraftId = '';   // ④ 段首次生成的草稿 id（⑤ 段「重新生成换新稿」断言要用：新稿必须换掉它）
  // —— 铺数据 ——
  fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), masterDoc);
  fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [MASTER]: { rev: 1, flow: 'draft' } }, null, 2));
  writeConfig(root);
  const apps = [
    mkApp(APP_IDS.a1, { company: '甲公司', appliedAt: dayStr(8) }),
    // a2 加过期截止（昨天）：T3 起「逾期」提醒面 = 首页近期日程卡「已逾期」徽章（状态条已撤），
    // 需要一个真实逾期样本才能复核该口径；a2 的 fuBox 判定只看 appliedAt（2 天）不受影响。
    mkApp(APP_IDS.a2, { company: '乙公司', appliedAt: dayStr(2), dueDate: dayStr(1) }),
    mkApp(APP_IDS.a3, { company: '丙公司', appliedAt: dayStr(9), status: '面试中' }),
    mkApp(APP_IDS.a4, { company: '丁公司', appliedAt: dayStr(9), interviews: [{ round: '一面', time: '', questions: '', answer: '', feedback: '', next: '' }] }),
    mkApp(APP_IDS.a5, { company: '戊公司', appliedAt: dayStr(9), dueDate: dayStr(-1) }),   // 临近截止（48h 内到期）
    mkApp(APP_IDS.a6, { company: '己公司', appliedAt: dayStr(9), status: 'offer' }),
    mkApp(APP_IDS.a7, { company: '庚公司', appliedAt: dayStr(7) }),                        // 默认阈值边界：满 7 天
    mkApp(APP_IDS.a8, { company: '辛公司', appliedAt: dayStr(3) }),                        // 阈值=3 时的边界：满 3 天
  ];
  fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify(apps, null, 2));
  // 无模型对照根：同数据、不写 config.json
  fs.writeFileSync(path.join(rootNoLlm, 'docs', MASTER + '.html'), masterDoc);
  fs.writeFileSync(path.join(rootNoLlm, 'docs-meta.json'), JSON.stringify({ [MASTER]: { rev: 1, flow: 'draft' } }, null, 2));
  fs.writeFileSync(path.join(rootNoLlm, 'applications.json'), JSON.stringify(apps, null, 2));

  server = await startServer(root);
  const base = server.base;

  // ===== ① 判定：无回应满 N 天 → 卡片出现「生成跟进语」入口；不该出现的都不出现 =====
  {
    const html = (await get(base, '/applications')).text;
    const b1 = fuBox(html, APP_IDS.a1);
    assert.ok(b1.includes('生成跟进语'), '满 8 天无回应（状态=已投递）的投递卡应出现「生成跟进语」入口');
    assert.ok(/无回应\s*8\s*天/.test(b1), '入口处应给出真实等待天数（行动时刻的真实数据），实际：' + b1.slice(0, 300));
    for (const [id, why] of [[APP_IDS.a2, '才 2 天'], [APP_IDS.a3, '已在面试中（对方已回应）'],
      [APP_IDS.a4, '已有面试记录（对方已回应）'], [APP_IDS.a6, '已录用（终态）'],
      [APP_IDS.a8, '才 3 天（默认阈值 7 未到）']]) {
      assert.equal(fuBox(html, id), '', `不该出现跟进入口：${why}（${id}）`);
    }
    const b7 = fuBox(html, APP_IDS.a7);
    assert.ok(b7.includes('生成跟进语'), '满 7 天（默认阈值边界，days >= N）应出现入口，实际：' + b7.slice(0, 300));
  }

  // ===== ② 与既有逾期/临近截止提醒并存不冲突 =====
  {
    const html = (await get(base, '/applications')).text;
    const b5 = fuBox(html, APP_IDS.a5);
    assert.ok(b5.includes('生成跟进语'), '临近截止的卡也应同时有跟进入口');
    assert.ok(html.includes('临近截止'), '既有「临近截止」提醒必须仍在（不被跟进入口顶掉），实际片段：' + html.slice(0, 400));
    // 首页既有「逾期/近期面试提醒」日程卡不受影响（T3：提醒面 = 日程卡「已逾期」徽章，状态条已撤）
    const home = (await get(base, '/')).text;
    assert.ok(home.includes('近期日程'), '首页既有「近期日程」卡应仍在（逾期/临近截止提醒并存）');
    assert.ok(home.includes('已逾期'), '首页既有逾期提醒口径应仍在（日程卡「已逾期」徽章），实际片段：' + home.slice(0, 600));
  }

  // ===== ③ 阈值默认 7 且 /settings 可配 =====
  {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(cfg.followUpDays, undefined, '未配置时不应凭空写入阈值（缺省走代码默认 7）');
    // 设置页有该输入
    const s = (await get(base, '/settings')).text;
    assert.ok(s.includes('id="fuDays"'), '/settings 应有跟进语阈值输入，实际片段：' + s.slice(0, 600));
    assert.ok(s.includes('value="7"'), '/settings 的阈值输入应显示当前值 7');
    // 改阈值 = 3 → 3 天前出现、2 天前不出现（用 A2=2 天与 A1=8 天验证边界）
    const set3 = await postJson(base, '/settings', { active: 0, profiles: JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).profiles, followUpDays: 3 });
    assert.equal(set3.status, 200, '保存阈值应 200，实际 ' + set3.status + ' ' + set3.text.slice(0, 200));
    const cfg3 = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(cfg3.followUpDays, 3, '阈值应落库到 config.json，实际：' + JSON.stringify(cfg3.followUpDays));
    const html3 = (await get(base, '/applications')).text;
    assert.ok(fuBox(html3, APP_IDS.a1).includes('生成跟进语'), '阈值 3 天时，8 天无回应的卡仍应有入口');
    // 阈值真的在改判定（两个方向都验）：满 3 天的卡在阈值 3 时该出现
    assert.ok(fuBox(html3, APP_IDS.a8).includes('生成跟进语'), '阈值 3 天时，满 3 天无回应的卡应出现入口，实际：' + fuBox(html3, APP_IDS.a8).slice(0, 200));
    // 非法值 400（形状错即拒，不静默忽略）——含「Number() 会静默转换的类型」：
    // true → 1、[3] → 3 不是值错误而是形状错误，必须一并被拒（§10.13 形状错即拒）。
    const bad = await postJson(base, '/settings', { active: 0, profiles: cfg3.profiles, followUpDays: 0 });
    assert.equal(bad.status, 400, '阈值 0 应 400（低于下限），实际 ' + bad.status);
    const bad2 = await postJson(base, '/settings', { active: 0, profiles: cfg3.profiles, followUpDays: 'x' });
    assert.equal(bad2.status, 400, '非数字阈值应 400，实际 ' + bad2.status);
    const badBool = await postJson(base, '/settings', { active: 0, profiles: cfg3.profiles, followUpDays: true });
    assert.equal(badBool.status, 400, '布尔阈值应 400（true 经 Number() 变 1，是形状错不是值），实际 ' + badBool.status);
    const badArr = await postJson(base, '/settings', { active: 0, profiles: cfg3.profiles, followUpDays: [3] });
    assert.equal(badArr.status, 400, '数组阈值应 400（[3] 经 Number() 变 3，是形状错不是值），实际 ' + badArr.status);
    const cfgAfter = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(cfgAfter.followUpDays, 3, '被拒的保存不得改写已有阈值，实际：' + JSON.stringify(cfgAfter.followUpDays));
    // 纯数字串应被认（设置页 number input 提交的就是数字串），落库为数字
    const okStr = await postJson(base, '/settings', { active: 0, profiles: cfg3.profiles, followUpDays: '5' });
    assert.equal(okStr.status, 200, '纯数字串应被认（设置页 number input 提交的就是数字串），实际 ' + okStr.status);
    const cfgStr = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(cfgStr.followUpDays, 5, '数字串阈值应落库为数字 5，实际：' + JSON.stringify(cfgStr.followUpDays));
    // 阈值回到 7 后，满 3 天的卡又该消失（阈值不是一次性生效）
    const set7 = await postJson(base, '/settings', { active: 0, profiles: cfg3.profiles, followUpDays: 7 });
    assert.equal(set7.status, 200, '还原阈值 7 应 200');
    const html7 = (await get(base, '/applications')).text;
    assert.equal(fuBox(html7, APP_IDS.a8), '', '阈值回到 7 后，满 3 天的卡不该再有入口');
    assert.ok(fuBox(html7, APP_IDS.a7).includes('生成跟进语'), '阈值回到 7 后，满 7 天的卡仍应有入口');
  }

  // ===== ④ 生成 → 草稿（真实阶段/真实用量/无百分比/落本机投递记录） =====
  {
    const start = await postJson(base, '/app/followup/start', { id: APP_IDS.a1 });
    assert.equal(start.status, 200, '生成入口应 200，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    assert.ok(start.json && start.json.taskId, '生成应返回 taskId，实际：' + start.text.slice(0, 200));
    const st = await waitFollow(base, APP_IDS.a1, (x) => x.task && x.task.status !== 'running');
    assert.ok(st && st.task, '应有任务记录，实际：' + JSON.stringify(st));
    assert.equal(st.task.status, 'done', '生成应完成，实际：' + JSON.stringify(st.task));
    assert.equal(st.task.usage && st.task.usage.total, 333, '用量应取服务商真实返回（total=333），实际：' + JSON.stringify(st.task.usage));
    assert.ok(!('percent' in st.task) && !('progress' in st.task), '任务记录不得有百分比/进度字段（诚实最小进度）');
    assert.ok(st.draft && st.draft.text.includes('合成跟进语'), '应产出跟进语草稿，实际：' + JSON.stringify(st.draft));
    // 取材：该投递的简历要点（诚实：不编造）
    assert.ok(lastLlmBody.includes('合成交易系统'), '取材应来自该投递的简历，实际：' + lastLlmBody.slice(0, 400));
    assert.ok(lastLlmBody.includes('甲公司'), 'prompt 应带该投递的公司，实际：' + lastLlmBody.slice(0, 400));
    // 草稿落本机投递记录（不进别的文件）
    const onDisk = appOnDisk(root, APP_IDS.a1);
    assert.ok(onDisk && onDisk.followUp && onDisk.followUp.draft, '草稿应落在投递记录里，实际：' + JSON.stringify(onDisk && onDisk.followUp));
    assert.ok(String(onDisk.followUp.draft.text).includes('合成跟进语'), '落盘的草稿应是生成的文案');
    firstDraftId = String(onDisk.followUp.draft.id);
  }

  // ===== ⑤ 草稿不发送（没有任何发送/代填/外发入口；模型只被调用一次） =====
  {
    const callsAfterGen = llmCalls;
    assert.equal(callsAfterGen, 1, '生成只应调用模型一次，实际：' + callsAfterGen);
    const html = (await get(base, '/applications')).text;
    const b1 = fuBox(html, APP_IDS.a1);
    assert.ok(b1.includes('复制'), '草稿区应有复制入口');
    assert.ok(b1.includes('丢弃'), '草稿区应有丢弃入口');
    // 「不发送」= 没有发送动作（按钮/表单），不是「页面上不能出现『发送』两个字」——
    // 草稿区的诚实边界句「草稿不会自动发送」本身就得含这两个字。
    const btnLabels = (b1.match(/<button[^>]*>[\s\S]*?<\/button>/g) || []).join(' ');
    assert.ok(!btnLabels.includes('发送'), '跟进块里不得有「发送」按钮（草稿不发送），实际按钮：' + btnLabels);
    assert.ok(b1.includes('不会自动发送'), '草稿区应写明不会自动发送（诚实边界），实际：' + b1.slice(0, 400));
    assert.ok(!/mailto:|target="_blank"|<form/i.test(b1), '跟进块里不得有外发/代填链接或表单，实际：' + b1.slice(0, 400));
    // 草稿只落在投递记录：临时根内除 applications.json 外不得出现草稿正文
    const text = FOLLOW_TEXT.slice(0, 12);
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (p.endsWith('applications.json')) continue;
        try { if (fs.readFileSync(p, 'utf8').includes(text)) hits.push(p); } catch {}
      }
    };
    walk(root);
    assert.deepEqual(hits, [], '草稿正文不得出现在投递记录以外的文件，实际：' + JSON.stringify(hits));
    // 页面上的草稿正文 = 落盘那份（所见即所复制）
    assert.ok(b1.includes('合成跟进语'), '卡片应展示落盘的草稿');
    // 重新生成换一份新稿：旧稿被新稿替换，不两份并存（§10.13 登记口径的对应断言）
    const start2 = await postJson(base, '/app/followup/start', { id: APP_IDS.a1 });
    assert.equal(start2.status, 200, '重新生成应 200，实际 ' + start2.status + ' ' + start2.text.slice(0, 200));
    const st2 = await waitFollow(base, APP_IDS.a1, (x) => x.task && x.task.status !== 'running');
    assert.equal(st2.task && st2.task.status, 'done', '重新生成应完成，实际：' + JSON.stringify(st2.task));
    const draft2 = st2.draft;
    assert.ok(draft2 && draft2.id, '重新生成应产出新稿，实际：' + JSON.stringify(draft2));
    assert.notEqual(String(draft2.id), firstDraftId, '新稿应是另一份（旧稿被替换，不是沿用旧 id）');
    const onDisk2 = appOnDisk(root, APP_IDS.a1);
    assert.equal(onDisk2.followUp.draft.id, draft2.id, '投递记录里应只留新稿（旧稿被替换）');
    assert.equal(onDisk2.followUp.draft.text, draft2.text, '落盘草稿正文应与新稿一致（不两份并存）');
    const raw2 = JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, 'applications.json'), 'utf8')));
    assert.equal((raw2.split(draft2.id).length - 1), 1,
      '整份投递账本里新稿 id 应只出现一次（磁盘上只有一份草稿），实际：' + raw2.slice(0, 200));
    assert.ok(!raw2.includes(firstDraftId), '旧稿 id 不应再出现在投递账本里（不两份并存），实际账本片段：' + raw2.slice(0, 200));
  }

  // ===== ⑥ 无模型 → 明确降级（入口禁用并写明原因）+ 接口 409 =====
  {
    serverNoLlm = await startServer(rootNoLlm);
    const html = (await get(serverNoLlm.base, '/applications')).text;
    const b1 = fuBox(html, APP_IDS.a1);
    assert.ok(b1.includes('生成跟进语'), '无模型时入口仍在（但应禁用并写明原因），实际：' + b1.slice(0, 400));
    assert.ok(/data-fu="gen"[^>]*disabled/.test(b1), '无模型时「生成跟进语」应禁用，实际：' + b1.slice(0, 400));
    assert.ok(b1.includes('未配置大模型'), '无模型时入口旁应写明原因，实际：' + b1.slice(0, 400));
    const r = await postJson(serverNoLlm.base, '/app/followup/start', { id: APP_IDS.a1 });
    assert.equal(r.status, 409, '无模型时生成接口应 409，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    assert.ok(String((r.json && r.json.error) || '').includes('未配置大模型'), '409 原因应写明未配置大模型，实际：' + r.text.slice(0, 200));
  }

  // ===== ⑦ 取消 → 迟到结果零落账（不产生草稿） =====
  {
    llmDelay = 1500;
    const start = await postJson(base, '/app/followup/start', { id: APP_IDS.a7 });
    assert.equal(start.status, 200, 'A7 生成应 200，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    const taskId = start.json.taskId;
    const cancel = await postJson(base, '/app/followup/cancel', { id: APP_IDS.a7, taskId });
    assert.equal(cancel.status, 200, '取消应 200，实际 ' + cancel.status + ' ' + cancel.text.slice(0, 200));
    const again = await postJson(base, '/app/followup/cancel', { id: APP_IDS.a7, taskId });
    assert.equal(again.status, 409, '重复取消应 409（taskId 不再匹配 running），实际 ' + again.status);
    llmDelay = 0;
    await new Promise((r) => setTimeout(r, 2200));
    const st = await fuState(base, APP_IDS.a7);
    assert.ok(!st.json.draft, '取消后迟到结果零落账（不得产生草稿），实际：' + JSON.stringify(st.json.draft));
    const onDisk = appOnDisk(root, APP_IDS.a7);
    assert.ok(!onDisk.followUp || !onDisk.followUp.draft, '取消后投递记录里也不得有草稿，实际：' + JSON.stringify(onDisk.followUp));
    assert.equal(st.json.task.status, 'cancelled', '任务态应为 cancelled，实际：' + JSON.stringify(st.json.task));
  }

  // ===== ⑧ 丢弃草稿 → 清稿 =====
  {
    const d = await postJson(base, '/app/followup/discard', { id: APP_IDS.a1 });
    assert.equal(d.status, 200, '丢弃应 200，实际 ' + d.status + ' ' + d.text.slice(0, 200));
    const st = await fuState(base, APP_IDS.a1);
    assert.ok(!st.json.draft, '丢弃后不得再有草稿，实际：' + JSON.stringify(st.json.draft));
    const html = (await get(base, '/applications')).text;
    assert.ok(!fuBox(html, APP_IDS.a1).includes('合成跟进语'), '丢弃后卡片不应再展示草稿正文');
  }

  // ===== ⑨ 浏览器段：真点「生成跟进语」→ 出草稿 → 复制；零 JS 异常 =====
  {
    let bin = null;
    try { bin = await resolveChromium(); }
    catch (e) { console.log('⚠️  Chromium 不可用，跳过跟进助手浏览器段：' + (e && e.message || e)); cleanupAll(); process.exit(2); }
    const browser = await chromium.launch({ executablePath: bin, headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      await page.goto(base + '/applications', { waitUntil: 'networkidle' });
      const sel = '.fu-box[data-fu-app="' + APP_IDS.a1 + '"]';
      assert.ok(await page.isVisible(sel), '浏览器段：跟进块应在卡上可见');
      await page.click(sel + ' button[data-fu="gen"]');
      const draftShown = await page.waitForFunction((s) => {
        const box = document.querySelector(s);
        if (!box) return false;
        const d = box.querySelector('.fu-draft');
        const ta = box.querySelector('.fu-text');
        return !!(d && !d.hasAttribute('hidden') && ta && ta.value);
      }, sel, { timeout: 25000 }).then(() => true).catch(() => false);
      assert.ok(draftShown, '浏览器段：点「生成跟进语」后应出现草稿');
      const draftText = await page.evaluate((s) => {
        const ta = document.querySelector(s + ' .fu-text');
        return ta ? ta.value : '';
      }, sel);
      assert.ok(draftText.includes('合成跟进语'), '浏览器段：草稿应是模型返回的文案，实际：' + draftText);
      // 复制：桩掉剪贴板 API（headless 里 writeText 可能挂起/被拒），断言「复制源 = 草稿正文」这件事本身
      await page.evaluate(() => {
        window.__copied = null;
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: function (t) { window.__copied = String(t == null ? '' : t); return Promise.resolve(); } },
        });
      });
      await page.click(sel + ' button[data-fu="copy"]');
      const copied = await page.waitForFunction(() => window.__copied, null, { timeout: 8000 }).then(() => true).catch(() => false);
      assert.ok(copied, '点「复制」应调用剪贴板写入（复制源 = 草稿正文）');
      const copiedText = await page.evaluate(() => window.__copied);
      assert.equal(copiedText, draftText, '复制的应是草稿正文（所见即所复制），实际：' + copiedText);
      const copyMsg = await page.evaluate((s) => {
        const el = document.querySelector(s + ' .fu-msg');
        return el ? el.textContent : '';
      }, sel);
      assert.ok(copyMsg.includes('已复制') || copyMsg.includes('复制失败'), '复制后应给明确反馈（成功或如实失败），实际：' + copyMsg);
      assert.deepEqual(pageErrors, [], '页面不应有 JS 异常，实际：' + pageErrors.join(' || '));
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // ===== ⑩ DESIGN.md 红线自查 + 冻结件零改动 =====
  {
    const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    const fuRules = srv.split('\n').filter((l) => { const t = l.trim(); return t.startsWith('.fu-') && t.includes('{'); });
    assert.ok(fuRules.length > 0, '应有 .fu-* 样式规则（跟进助手区）');
    for (const line of fuRules) {
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
    // 冻结件逐字节钉定（固定 sha1 值，不是自反比较——自反恒真，钉不住任何东西）：
    // template.html = 简历骨架契约、render.mjs = PDF 渲染契约，都是 §7 冻结清单里的件。
    assert.equal(createHash('sha1').update(fs.readFileSync(path.join(APP_ROOT, 'template.html'))).digest('hex'),
      '29609d7474746b8f7825e35999c96c92297f15f3', 'template.html 冻结件不得改动');
    assert.equal(createHash('sha1').update(fs.readFileSync(path.join(APP_ROOT, 'render.mjs'))).digest('hex'),
      'fc5e3aaf16fd62c425c4b6925a765df7a6a239cb', 'render.mjs 冻结件不得改动');
  }

  console.log('✅ 跟进助手：满 N 天无回应才提示（默认 7，/settings 可配）+ 走 genTasks 口径生成草稿 + 草稿不发送 + 与逾期/临近截止提醒并存');
} catch (e) {
  console.error('❌ ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  if (server) server.kill();
  if (serverNoLlm) serverNoLlm.kill();
  try { llm.close(); } catch {}
  cleanupAll();
}
