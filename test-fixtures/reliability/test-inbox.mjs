// test-inbox.mjs — JD 收件箱（2026-11-13 spec dev-docs/2026-11-13-jd-inbox-batch-eval-design.md）
// 断言（任务卡 T2）：
//   ① 带口令 k 的用户态 POST /import/page（Origin=招聘站）→ 「已收入收件箱 · 共 1 条」、不含「提取通道」；
//     inbox.json 1 条（status=new / urlKey 去 query / salary 非空 / jdFp 非空），文件 0600，响应无 ACAO；
//   ② 同 JD 换 query（?lid=2）→ urlKey 判重 → 「已在收件箱」不新增；同 JD 换 URL → jdFp 判重 → 不新增；
//   ③ 不带 k / k 错 → 旧预览（含「提取结果」+「重新拖一次」），inbox.json 不变；
//   ④ .migrate.lock 新鲜持锁 → 带 k POST → 「维护中，本次未收入」，inbox.json 不变。
//   ⑤ 复核修复：并发同页收入至多 1 条；dismissed/drafted 命中文案分流。
//   ⑥ T4 批量评估：/inbox/eval 入队 → 串行 worker（桩并发峰值=1）→ scored；
//     桩 500 → error → 重评 scored；scored 可重评/不存在 id 跳过；重启 running→queued 恢复；未配模型 409。
//   ⑦ T5 建草稿/不考虑：已评估→promote(brief.focus 含 angle、promotedTo 回写)；未评估→jdSource「收件箱」；
//     同 JD 409 existing → 仍 ok+drafted；/inbox/dismiss → status 摘除+文件留 dismissed；不存在 id → 404。
//   ⑧ T6：评估中被 dismiss → 留 dismissed 但补记 evalId（worker 不复活状态）；
//     /inbox 页（导航/排序/复选框/徽章/空态/nonce/无内部字段）；/evals 行锚点；首页待办。
// 手法：隔离 RESUME_ROOT + assembleTemplate 合成母版 + 随机端口真实 server + OpenAI 兼容桩
// （同 test-eval-promote-brief.mjs；口令从 GET /job/new 的书签 href 解析）。不碰 7766，不写真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const FIX = path.join(APP_ROOT, 'test-fixtures', 'jd-pages');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-inbox-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
// 引文「负责交易系统」6 码元（parseEvalReport 引文下限），必须逐字出现在母版可见正文
doc = doc.replace('{{WORK}}', () => '<p data-zid="z11111111">工作经历：负责交易系统</p>');
doc = doc.replace('{{PROJECTS}}', () => '');
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [DOC]: { rev: 1, flow: 'draft', kind: 'master' } }, null, 2));

// —— stub LLM（OpenAI 兼容，同 test-eval-promote-brief.mjs）：评估请求回合法报告 ——
const EVAL_REPORT = JSON.stringify({
  roleSummary: '负责交易系统后端研发', company: '评估甲公司', roleName: '后端工程师',
  level: 'right', levelReason: '恰好匹配',
  salary: { text: '', source: 'JD 未提供' },
  angle: '突出高并发交易系统经验',
  matches: [{ req: '负责后端服务', status: 'covered', evidence: '负责交易系统', weight: 'must', weightFrom: 'JD 原文' }],
  score: 4.5, verdict: 'apply', verdictReason: '整体匹配', gaps: ['补充量化指标']
});
// 桩并发观测：评估请求 inflight 计数 + 峰值记录 + 300ms 延时（串行 worker 的峰值应恒为 1）。
// 控制文件 llm-eval-fail-once 存在时 → 对第一个评估请求回 HTTP 500 并删除该文件。
let llmInflight = 0, llmPeak = 0;
const stub = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    let isEval = false, content = '';
    try {
      const sys = JSON.parse(b).messages.find((m) => m.role === 'system').content;
      if (String(sys).includes('岗位快速评估器')) { isEval = true; content = EVAL_REPORT; }
    } catch {}
    if (!isEval) {
      s.writeHead(200, { 'Content-Type': 'application/json' });
      return s.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }
    llmInflight++; llmPeak = Math.max(llmPeak, llmInflight);
    const failOnce = path.join(root, 'llm-eval-fail-once');
    const boom = fs.existsSync(failOnce);
    if (boom) fs.rmSync(failOnce, { force: true });
    setTimeout(() => {
      llmInflight--;
      if (boom) { s.writeHead(500); return s.end('{"error":"stub fail once"}'); }
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ choices: [{ message: { content } }] }));
    }, 300);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubPort = stub.address().port;
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stubPort}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model-x' }]
}));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
let server = null, serverLog = '', exited = null;
const startServer = () => {
  serverLog = ''; exited = null;
  server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
    cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  server.on('exit', (c, sg) => { exited = { c, s: sg }; });
};
startServer();
const base = `http://127.0.0.1:${port}`;
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { stub.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);

const inboxFile = path.join(root, 'inbox.json');
const loadInboxFile = () => { try { return JSON.parse(fs.readFileSync(inboxFile, 'utf8')); } catch { return []; } };
// 用户态递交：urlencoded 表单 + 招聘站 Origin（书签跨站递交的真实形态）
const postImport = (fields) => fetch(base + '/import/page', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://www.zhipin.com' },
  body: new URLSearchParams(fields).toString(),
});
// 同源写请求（JSON + 同源 Origin，照该夹具现有写请求头约定）
const postJson = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const getJson = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const urlKeyOf = (u) => { const x = new URL(u); return x.origin + x.pathname; };
const ready = async () => {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务提前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) return; } catch {}
    await sleep(200);
  }
  fail('服务 30s 未就绪\n' + serverLog.slice(-800));
};
const waitItem = async (id, status, ms = 20000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    const st = await getJson('/inbox/status');
    const it = st.body && st.body.items && st.body.items.find((x) => x.id === id);
    if (it && it.status === status) return it;
    await sleep(200);
  }
  return null;
};
// 收入一条并返回其收件箱 id（按 urlKey 在 inbox.json 里找）
const collect = async (jdHtml, url, title, k) => {
  const r = await postImport({ html: jdHtml, url, title, k });
  await r.text();
  const it = loadInboxFile().find((x) => x.urlKey === urlKeyOf(url));
  assert.ok(it, '收入后应在 inbox.json 找到条目：' + url);
  return it.id;
};

try {
  await ready();

  // ===== 口令：从 GET /job/new 的书签 href 解析 =====
  const jn = await (await fetch(base + '/job/new')).text();
  const k = (jn.match(/k\.value='([0-9a-f]{32})'/) || [])[1] || '';
  assert.match(k, /^[0-9a-f]{32}$/, '书签口令应为 32 位 hex，实际：' + k);

  const zh = fs.readFileSync(path.join(FIX, 'zhipin-job.html'), 'utf8');

  // ===== ① 带口令 POST → 收入收件箱 =====
  const r1 = await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/abc.html?lid=1', title: '甲岗位', k });
  const b1 = await r1.text();
  assert.equal(r1.status, 200, '① 带口令 POST 应 200，实际：' + r1.status);
  assert.ok(b1.includes('已收入收件箱'), '① 应显示「已收入收件箱」，实际片段：' + b1.slice(0, 300));
  assert.ok(b1.includes('共 1 条'), '① 应显示「共 1 条」');
  assert.ok(!b1.includes('提取通道'), '① 已收入页不得含内部术语「提取通道」');
  assert.equal(r1.headers.get('access-control-allow-origin'), null, '① 响应不得带 ACAO');
  const ib1 = loadInboxFile();
  assert.equal(ib1.length, 1, '① inbox.json 应 1 条，实际：' + ib1.length);
  assert.equal(ib1[0].status, 'new', '① 条目 status 应为 new');
  assert.equal(ib1[0].urlKey, 'https://www.zhipin.com/job_detail/abc.html', '① urlKey 应去 query，实际：' + ib1[0].urlKey);
  assert.ok(ib1[0].salary, '① salary 应非空');
  assert.ok(ib1[0].jdFp, '① jdFp 应非空');
  assert.equal(fs.statSync(inboxFile).mode & 0o777, 0o600, '① inbox.json 权限应 0600');

  // ===== ②a 同 JD 换 query → urlKey 判重 =====
  const r2 = await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/abc.html?lid=2', title: '甲岗位', k });
  const b2 = await r2.text();
  assert.ok(b2.includes('已在收件箱'), '②a 同 urlKey 应命中去重，实际片段：' + b2.slice(0, 300));
  assert.equal(loadInboxFile().length, 1, '②a 去重后仍应 1 条');

  // ===== ②b 同 JD 换 URL → jdFp 判重 =====
  const r3 = await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/xyz.html', title: '甲岗位', k });
  const b3 = await r3.text();
  assert.ok(b3.includes('已在收件箱'), '②b 同 jdFp 应命中去重，实际片段：' + b3.slice(0, 300));
  assert.equal(loadInboxFile().length, 1, '②b 去重后仍应 1 条');

  // ===== ③ 不带 k / k 错 → 旧预览，不写收件箱 =====
  for (const [label, fields] of [
    ['不带 k', { html: zh, url: 'https://www.zhipin.com/job_detail/nok.html', title: 'x' }],
    ['k 错', { html: zh, url: 'https://www.zhipin.com/job_detail/badk.html', title: 'x', k: '0'.repeat(32) }],
  ]) {
    const r = await postImport(fields);
    const b = await r.text();
    assert.equal(r.status, 200, '③ ' + label + ' 应 200，实际：' + r.status);
    assert.ok(b.includes('提取结果'), '③ ' + label + ' 应是旧预览页（含「提取结果」）');
    assert.ok(b.includes('重新拖一次'), '③ ' + label + ' 应提示「重新拖一次」');
    assert.equal(loadInboxFile().length, 1, '③ ' + label + ' 不得新增收件箱条目');
  }

  // ===== ④ 迁移锁被持有 → 带口令也不写 =====
  fs.writeFileSync(path.join(root, '.migrate.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }));
  const r4 = await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/locked.html', title: 'x', k });
  const b4 = await r4.text();
  assert.ok(b4.includes('维护中，本次未收入'), '④ 持锁时应显示「维护中，本次未收入」，实际片段：' + b4.slice(0, 300));
  assert.equal(loadInboxFile().length, 1, '④ 持锁期间不得新增收件箱条目');
  fs.rmSync(path.join(root, '.migrate.lock'), { force: true });

  // ===== 复核修复①：并发同页收入 → 至多 1 条（inboxAdd 跨 await 重读后再判重）=====
  // 注意用与既有条目不同的 JD 文本——同 jdFp 会被①判重吃掉，测不到并发窗口。
  const zhR = zh.replace('必须有带团队经验', '必须有带团队经验·竞');
  const [ra, rb] = await Promise.all([
    postImport({ html: zhR, url: 'https://www.zhipin.com/job_detail/race.html?lid=1', title: '竞态', k }),
    postImport({ html: zhR, url: 'https://www.zhipin.com/job_detail/race.html?lid=2', title: '竞态', k }),
  ]);
  await ra.text(); await rb.text();
  assert.equal(loadInboxFile().filter((x) => x.urlKey === 'https://www.zhipin.com/job_detail/race.html').length, 1, '并发同页应只收入 1 条');

  // ===== 复核修复②：去重命中文案随条目状态（dismissed / drafted / 其他）=====
  {
    const ib = loadInboxFile();
    const dup = ib.find((x) => x.urlKey === 'https://www.zhipin.com/job_detail/abc.html');
    assert.ok(dup, '应能找到 ① 收入的条目');
    dup.status = 'dismissed';
    fs.writeFileSync(inboxFile, JSON.stringify(ib));
    const bd = await (await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/abc.html?lid=9', title: 'x', k })).text();
    assert.ok(bd.includes('标记过不考虑'), 'dismissed 命中应显示「标记过不考虑」');
    dup.status = 'drafted'; dup.draftId = 'd1';
    fs.writeFileSync(inboxFile, JSON.stringify(ib));
    const bg = await (await postImport({ html: zh, url: 'https://www.zhipin.com/job_detail/abc.html?lid=10', title: 'x', k })).text();
    assert.ok(bg.includes('已建过草稿'), 'drafted 命中应显示「已建过草稿」');
    assert.ok(bg.includes('href="/edit?id=d1"'), 'drafted 命中应带 /edit?id=d1 链接');
    fs.writeFileSync(inboxFile, '[]');   // 清空，进入评估阶段
  }

  // ===== T4：批量评估（后台串行 worker，桩并发峰值应 = 1）=====
  const jdOf = (tag) => zh.replace('必须有带团队经验', '必须有带团队经验·' + tag);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(await collect(jdOf('批' + 'ABC'[i]), `https://www.zhipin.com/job_detail/e${i + 1}.html`, '批' + 'ABC'[i], k));
  }
  const evr = await postJson('/inbox/eval', { ids, from: DOC });
  assert.equal(evr.status, 200, '批量评估应 200：' + JSON.stringify(evr.body));
  assert.ok(evr.body && evr.body.queued === 3, '应入队 3 条，实际：' + JSON.stringify(evr.body));
  for (const id of ids) assert.ok(await waitItem(id, 'scored'), '条目应到 scored：' + id);
  assert.equal(llmPeak, 1, '评估并发峰值应为 1（串行 worker 只占 1 个 AI 槽），实际：' + llmPeak);
  const evalsFile = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'evaluations.json'), 'utf8')); } catch { return []; } };
  assert.equal(evalsFile().length, 3, '应落 3 条评估记录');
  {
    const ib = loadInboxFile();   // evalId 在 inbox.json 记录上（/inbox/status 契约不含此字段）
    const stAll = await getJson('/inbox/status');
    for (const id of ids) {
      const it = ib.find((x) => x.id === id);
      assert.ok(it.evalId && evalsFile().some((e) => e.id === it.evalId), '条目 evalId 应指向评估记录：' + id);
      assert.equal(typeof it.score, 'number', '条目 score 应为数字：' + id);
      const sv = stAll.body.items.find((x) => x.id === id);
      assert.equal(sv && sv.status, 'scored', 'status 接口应报 scored：' + id);
      assert.equal(typeof (sv && sv.score), 'number', 'status 接口 score 应为数字：' + id);
    }
  }

  // 失败重试：llm-eval-fail-once → 首个评估请求 500 → 条目 error；再次入队 → scored
  fs.writeFileSync(path.join(root, 'llm-eval-fail-once'), '1');
  const id4 = await collect(jdOf('批D'), 'https://www.zhipin.com/job_detail/e4.html', '批D', k);
  const evr4 = await postJson('/inbox/eval', { ids: [id4], from: DOC });
  assert.ok(evr4.body && evr4.body.queued === 1, '第 4 条应入队');
  const errIt = await waitItem(id4, 'error');
  assert.ok(errIt, '桩 500 后条目应到 error');
  assert.ok(errIt.error, 'error 字段应非空');
  await postJson('/inbox/eval', { ids: [id4], from: DOC });
  assert.ok(await waitItem(id4, 'scored'), '重试后应 scored');

  // 跳过规则：scored 条目计入 queued（允许重评）；不存在 id 不计入
  const evs = await postJson('/inbox/eval', { ids: [ids[0], 'ib-not-exist'], from: DOC });
  assert.ok(evs.body && evs.body.queued === 1, 'scored 可重评 + 不存在 id 跳过 → queued=1，实际：' + JSON.stringify(evs.body));
  assert.ok(await waitItem(ids[0], 'scored'), '重评后应回到 scored');

  // 重启恢复：running → queued → 启动后自动跑完
  server.kill('SIGKILL');
  await new Promise((r) => { const t = setInterval(() => { if (exited) { clearInterval(t); r(); } }, 100); });
  {
    const ib = loadInboxFile();
    const t = ib.find((x) => x.id === id4);
    t.status = 'running'; t.score = null; t.evalId = null;
    fs.writeFileSync(inboxFile, JSON.stringify(ib));
  }
  startServer();
  await ready();
  assert.ok(await waitItem(id4, 'scored'), '重启后 running 条应恢复并跑完');

  // 未配置模型：无 config.json 的隔离根 → /inbox/eval 409 + settingsPath
  {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-inbox-nomodel-'));
    for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root2, d), { recursive: true });
    const port2 = await new Promise((res) => {
      const s2 = net.createServer();
      s2.listen(0, '127.0.0.1', () => { const p = s2.address().port; s2.close(() => res(p)); });
    });
    const server2 = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
      cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root2, PORT: String(port2) }, stdio: ['ignore', 'pipe', 'pipe']
    });
    try {
      const base2 = `http://127.0.0.1:${port2}`;
      for (let i = 0; i < 150; i++) {
        try { if ((await fetch(base2 + '/')).ok) break; } catch {}
        await sleep(200);
        if (i === 149) fail('未配置模型服务 30s 未就绪');
      }
      const nm = await fetch(base2 + '/inbox/eval', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base2 }, body: JSON.stringify({ ids: ['ib-x'], from: DOC }) });
      const nmb = await nm.json().catch(() => null);
      assert.equal(nm.status, 409, '未配置模型应 409，实际：' + nm.status);
      assert.ok(nmb && nmb.settingsPath, '409 响应应带 settingsPath');
    } finally {
      try { server2.kill('SIGKILL'); } catch {}
      try { fs.rmSync(root2, { recursive: true, force: true }); } catch {}
    }
  }

  // ===== T5：建草稿 / 不考虑 =====
  // 已评估条目 → promote 路径：brief.focus 含评估 angle，promotedTo 回写，条目 drafted
  {
    const it1 = loadInboxFile().find((x) => x.id === ids[0]);
    const dr = await postJson('/inbox/draft', { id: ids[0], from: DOC });
    assert.equal(dr.status, 200, '已评估建稿应 200：' + JSON.stringify(dr.body));
    assert.ok(dr.body && dr.body.id, '应返回草稿 id');
    const draftId = dr.body.id;
    const ch = await getJson('/job/changes?id=' + draftId);
    assert.equal(ch.status, 200, '/job/changes 应 200');
    assert.ok(ch.body.job.brief.focus.includes('突出高并发交易系统经验'), 'brief.focus 应含评估 angle：' + JSON.stringify(ch.body.job.brief));
    const it1b = loadInboxFile().find((x) => x.id === ids[0]);
    assert.equal(it1b.status, 'drafted', '条目应置 drafted');
    assert.equal(it1b.draftId, draftId, 'draftId 应一致');
    assert.equal(evalsFile().find((e) => e.id === it1.evalId).promotedTo, draftId, '评估记录 promotedTo 应指向草稿');
  }

  // 未评估条目 → createJobDraft 路径：jdSource === '收件箱'
  // （岗位名须不同：createJobDraft 判重是 parent+company+role，同司同岗会被判重指回批A 草稿）
  const idNew = await collect(zh.replace('必须有带团队经验', '必须有带团队经验·批E').replace("job_name: '数据标注项目管理 双休远程面试'", "job_name: '平台运营专员·批E'"), 'https://www.zhipin.com/job_detail/e5.html', '批E', k);
  const dr2 = await postJson('/inbox/draft', { id: idNew, from: DOC });
  assert.equal(dr2.status, 200, '未评估建稿应 200：' + JSON.stringify(dr2.body));
  assert.ok(dr2.body && dr2.body.id, '应返回草稿 id');
  {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    assert.equal(meta[dr2.body.id].jdSource, '收件箱', 'jdSource 应为「收件箱」：' + JSON.stringify(meta[dr2.body.id]).slice(0, 200));
  }

  // 同 JD 另一条（手工插入同 jd 不同 id/urlKey）→ createJobDraft 409 existing → 仍 ok + drafted
  {
    const ib = loadInboxFile();
    const src = ib.find((x) => x.id === idNew);
    const dup = { ...src, id: 'ib-manual-dup', url: 'https://www.zhipin.com/job_detail/dup.html', urlKey: 'https://www.zhipin.com/job_detail/dup.html', status: 'new', evalId: null, score: null, draftId: null };
    ib.unshift(dup);
    fs.writeFileSync(inboxFile, JSON.stringify(ib));
    const dr3 = await postJson('/inbox/draft', { id: 'ib-manual-dup', from: DOC });
    assert.equal(dr3.status, 200, '同 JD 重复建稿应仍 200：' + JSON.stringify(dr3.body));
    assert.equal(dr3.body && dr3.body.id, dr2.body.id, '应指回已存在草稿');
    const d = loadInboxFile().find((x) => x.id === 'ib-manual-dup');
    assert.equal(d.status, 'drafted', '重复条目应置 drafted');
    assert.equal(d.draftId, dr2.body.id, 'draftId 应 = existing');
  }

  // dismiss：/inbox/status 不再列出；文件里保留 dismissed；不存在 id → 404
  const dm = await postJson('/inbox/dismiss', { id: idNew });
  assert.ok(dm.status === 200 && dm.body && dm.body.ok, 'dismiss 应 ok');
  {
    const st = await getJson('/inbox/status');
    assert.ok(!st.body.items.some((x) => x.id === idNew), 'dismiss 后 status 不应再列出');
    assert.equal(loadInboxFile().find((x) => x.id === idNew).status, 'dismissed', '文件里应留 dismissed');
  }
  assert.equal((await postJson('/inbox/dismiss', { id: 'ib-nope' })).status, 404, '不存在 id 应 404');
  assert.equal((await postJson('/inbox/draft', { id: 'ib-nope', from: DOC })).status, 404, 'draft 不存在 id 应 404');

  // ===== T6 复核：worker 回写不复活 status——评估中被 dismiss → 留 dismissed 但补记 evalId =====
  {
    const idC = await collect(jdOf('批F'), 'https://www.zhipin.com/job_detail/e6.html', '批F', k);
    await postJson('/inbox/eval', { ids: [idC], from: DOC });
    const run = await waitItem(idC, 'running');
    assert.ok(run, '条目应进入 running');
    await postJson('/inbox/dismiss', { id: idC });
    // 等桩返回后 worker 回写：inbox.json 里 evalId 出现，但 status 仍是 dismissed
    const dl = Date.now() + 20000;
    let it = null;
    while (Date.now() < dl) {
      it = loadInboxFile().find((x) => x.id === idC);
      if (it && it.evalId) break;
      await sleep(200);
    }
    assert.ok(it && it.evalId, '评估完成后应补记 evalId');
    assert.equal(it.status, 'dismissed', '被 dismiss 的条目不应被 worker 复活，实际：' + it.status);
    fs.writeFileSync(inboxFile, '[]');   // 清空进入页面断言
  }

  // ===== T6：/inbox 页 =====
  const getHtml = async (p) => { const r = await fetch(base + p); return { status: r.status, html: await r.text() }; };
  {
    // 造排序数据：scored 4分、scored 2分、new 各一
    const ib = [
      { id: 'ib-s4', url: 'https://www.zhipin.com/job_detail/s4.html', urlKey: 'https://www.zhipin.com/job_detail/s4.html', title: '', company: '甲公司', role: '岗位甲', salary: '30-40K', jd: 'x'.repeat(60), jdFp: 'fp1', dupHints: [], status: 'scored', from: DOC, evalId: 'ev-s4', score: 4, verdict: 'apply', error: null, draftId: null, createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' },
      { id: 'ib-s2', url: 'https://www.zhipin.com/job_detail/s2.html', urlKey: 'https://www.zhipin.com/job_detail/s2.html', title: '', company: '乙公司', role: '岗位乙', salary: '', jd: 'y'.repeat(60), jdFp: 'fp2', dupHints: [], status: 'scored', from: DOC, evalId: 'ev-s2', score: 2, verdict: 'caution', error: null, draftId: null, createdAt: '2026-11-13T02:00:00Z', updatedAt: '2026-11-13T02:00:00Z' },
      { id: 'ib-n1', url: 'https://www.zhipin.com/job_detail/n1.html', urlKey: 'https://www.zhipin.com/job_detail/n1.html', title: '', company: '丙公司', role: '岗位丙', salary: '15-20K', jd: 'z'.repeat(60), jdFp: 'fp3', dupHints: [], status: 'new', from: null, evalId: null, score: null, verdict: null, error: null, draftId: null, createdAt: '2026-11-13T03:00:00Z', updatedAt: '2026-11-13T03:00:00Z' },
    ];
    fs.writeFileSync(inboxFile, JSON.stringify(ib));
    const { status, html } = await getHtml('/inbox');
    assert.equal(status, 200, '/inbox 应 200');
    assert.ok(html.includes('<a href="/inbox" class="on" aria-current="page">待筛选</a>'), '投递导航首项应为「待筛选」且高亮');
    // 排序：4分 → 2分 → new（按 [data-ib] 出现次序）
    const order = [...html.matchAll(/data-ib="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
    assert.deepEqual(order, ['ib-s4', 'ib-s2', 'ib-n1'], '行序应为 scored 降分在前、new 在后：' + order.join(','));
    assert.ok(html.includes('name="ib" value="ib-s4"'), '每行应有 name=ib 复选框');
    assert.ok(html.includes('30-40K'), '行应显示薪资');
    assert.ok(html.includes('>建草稿</button>') && html.includes('>不考虑</button>'), '行应有建草稿/不考虑');
    assert.ok(html.includes('href="/evals#ev-s4"'), 'scored 分数徽章应链到 /evals#evalId');
    assert.ok(html.includes('>待评估</span>'), 'new 应有「待评估」徽章');
    // 不暴露内部字段
    assert.ok(!html.includes('jdFp') && !html.includes('urlKey'), '页面不得出现内部字段名');
    // 全部内联脚本带 nonce
    const scripts = html.match(/<script(?![^>]*nonce=)[^>]*>/g);
    assert.ok(!scripts, '存在无 nonce 的内联脚本：' + JSON.stringify(scripts));
    // /applications 页同一条投递导航含 /inbox
    const apps = await getHtml('/applications');
    assert.ok(apps.html.includes('href="/inbox"'), '投递页导航应含 /inbox');
    // /evals 行锚点：evalHistoryRows 行外层 id = evalId
    const evalsPage = await getHtml('/evals');
    assert.ok(/id="ev-[^"]+"/.test(evalsPage.html), '/evals 行应有 id=evalId 锚点');
    // 空态：写空 → 「收件箱是空的」+ 书签 href
    fs.writeFileSync(inboxFile, '[]');
    const em = await getHtml('/inbox');
    assert.ok(em.html.includes('收件箱是空的'), '空态文案缺失');
    assert.ok(em.html.includes('javascript:'), '空态应给可拖书签链接');
    // 首页待办（需状态 2：有投递记录才渲染待办列表）
    fs.writeFileSync(inboxFile, JSON.stringify(ib));
    fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([{ id: 'a-t1', company: '丙公司', role: '岗位丙', status: '已投递', createdAt: '2026-11-13T00:00:00Z' }]));
    const home = await getHtml('/');
    assert.ok(home.html.includes('收件箱有 1 个岗位待评估'), '首页应显示收件箱待办：' + (home.html.match(/收件箱有[^<]*/) || ['（无）'])[0]);
    assert.ok(/href="\/inbox"[^>]*>去筛选</.test(home.html), '待办应链接 /inbox 带「去筛选」');
    fs.writeFileSync(inboxFile, '[]');
    fs.rmSync(path.join(root, 'applications.json'), { force: true });
  }

  console.log('✅ inbox T2+T4+T5+T6：口令收入/判重/锁挡/旧预览回退；并发 1 条；dismissed/drafted 文案；批量评估串行(峰值1)/失败重试/重评+跳过/重启恢复/未配模型 409；建草稿(评估/未评估/同JD 409)/不考虑/404；worker 不复活 dismissed；/inbox 页(导航/排序/徽章/空态/nonce/无内部字段)；/evals 锚点；首页待办');
} catch (e) {
  cleanup();
  fail(e && e.message || String(e));
}
cleanup();
process.exit(0);
