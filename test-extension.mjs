// test-extension.mjs — UPCV A4（投递扩展五端点 + 口令闸）接入断言。退出码 0=全过；1=任一断言失败。
// 六步样板照 test-aora.mjs/test-jobs-match.mjs：隔离根/动态口/spawn/exit 钩子/fetch+源码断言/✅ 段式。
// LLM 一律本地假 stub；上游一律 RESUME_UPCV_BASE 指向死端口（本套不依赖上游路径，未知 jobId → 502 断言用它）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const roots = [];
const procs = [];
process.on('exit', () => {
  for (const p of procs) { try { p.kill(); } catch {} }
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
});
const mkRoot = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-ext-'));
  roots.push(r);
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(r, d), { recursive: true });
  return r;
};
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const waitReady = (proc, logFile, needle) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('server 启动超时')), 15000);
  try { fs.rmSync(logFile); } catch {}
  proc.stdout.on('data', (b) => { if (String(b).includes(needle)) { clearTimeout(t); res(); } });
});

const ROOT = mkRoot();
// 口令预 seed（A4 契约：/extension/* POST 一律验 X-Resume-Token === importToken(root)）
const TOKEN = 'a'.repeat(32);
fs.writeFileSync(path.join(ROOT, '.import-token'), TOKEN);

// ===== 假 LLM（OpenAI 兼容；按 system 关键词路由：匹配 JSON / 招呼语 / 回复草稿）=====
const LLM_PORT = await freePort();
let llmCalls = 0;
const GREETING_RAW = '```您好！我是张三，五年内容运营，擅长公众号增长与 A/B 实验，与贵司岗位要求高度契合，期待能进一步交流。```';
const DRAFT_RAW = '「您好，感谢关注！我的内容运营经验五年，公众号从 0 做到 10 万粉，方便发下 JD 细节吗？」';
const MATCH_OK = JSON.stringify({
  matchScore: 82, matchLevel: 'strong', headline: '内容运营经验与岗位高度重合',
  strengths: [{ text: 'A/B 实验驱动增长', evidence: '负责公众号增长与 A/B 实验' }],
  gaps: ['缺少电商行业背景'], resumeSuggestions: ['补量化结果'],
});
const llm = http.createServer((q, s) => {
  let b = '';
  q.on('data', (c) => { b += c; });
  q.on('end', () => {
    llmCalls += 1;
    let content;
    if (b.includes('匹配度')) content = MATCH_OK;
    else if (b.includes('打招呼消息')) content = GREETING_RAW;
    else if (b.includes('回复草稿')) content = DRAFT_RAW;
    else content = MATCH_OK;
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((res) => llm.listen(LLM_PORT, '127.0.0.1', res));
procs.push({ kill: () => { try { llm.close(); } catch {} } });

// ===== 被测服务：隔离根 + 虚拟 config 指向假 LLM + 死上游端口 =====
const PORT = await freePort();
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }]
}));
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: {
    ...process.env, RESUME_ROOT: ROOT, PORT: String(PORT),
    RESUME_UPCV_BASE: `http://127.0.0.1:${await freePort()}`,   // 死端口：未知 jobId 走上游必 502，零真实网络
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
procs.push(server);
const LOG = path.join(ROOT, 'server.log');
server.stdout.on('data', (b) => { try { fs.appendFileSync(LOG, b); } catch {} });
await waitReady(server, LOG, '简历平台');
const B = `http://127.0.0.1:${PORT}`;
const j = (method, p, body, extraHeaders) => fetch(B + p, {
  method, headers: method === 'GET' ? { ...extraHeaders } : { 'Content-Type': 'application/json', ...extraHeaders },
  body: body === undefined ? undefined : JSON.stringify(body)
}).then((r) => r.text().then((t) => { let d = null; try { d = JSON.parse(t); } catch {} return { status: r.status, data: d, text: t }; }));
const AUTH = { 'X-Resume-Token': TOKEN };
const appsOnDisk = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'applications.json'), 'utf8'));

// ===== 0. seed 母版（resume-text 母版缺省 + greeting 简历基底）=====
fs.writeFileSync(path.join(ROOT, 'docs-meta.json'), JSON.stringify({ mastertest: {} }));
fs.writeFileSync(path.join(ROOT, 'docs', 'mastertest.html'),
  '<html><body><h1>测试母版简历</h1><section class="section"><div class="section-title">工作经历</div>'
  + '<p>2021-2026 某公司 内容运营，负责公众号增长与 A/B 实验，五年经验</p></section></body></html>');

// ===== 1. 口令闸：不符/缺失 401（apply-record / greeting / chat-reply / match-score 四写类端点）=====
{
  const bad = await j('POST', '/extension/apply-record', { jobId: 'site-zhipin-com-x1', company: '测试公司', role: '内容运营', docId: 'mastertest' }, { 'X-Resume-Token': 'b'.repeat(32) });
  assert.equal(bad.status, 401, '口令不符 apply-record 应 401，实际 ' + bad.status);
  for (const [p, body] of [
    ['/extension/apply-record', { jobId: 'site-zhipin-com-x1', company: '测试公司', role: '内容运营', docId: 'mastertest' }],
    ['/extension/greeting', { docId: 'mastertest', jdText: '内容运营岗位' }],
    ['/extension/chat-reply', { historyText: 'HR:你好' }],
    ['/extension/match-score', { docId: 'mastertest', jdText: '内容运营岗位，要求公众号增长与 A/B 实验经验，三年以上内容平台经验。'.repeat(3) }],
  ]) {
    const none = await j('POST', p, body);
    assert.equal(none.status, 401, '无口令 ' + p + ' 应 401，实际 ' + none.status);
  }
  console.log('✅ 1 口令闸：四写类端点缺令/错令一律 401（A2 match-score 同步纳管）');
}

// ===== 2. apply-record：建行 200 + 同 jobId 幂等 + 状态只许前向（回退不生效）=====
{
  const r = await j('POST', '/extension/apply-record', { jobId: 'site-zhipin-com-x1', company: '测试科技', role: '内容运营', link: 'https://example.test/job1', docId: 'mastertest' }, AUTH);
  assert.equal(r.status, 200, '口令正确 apply-record 应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.data.ok && r.data.status === 'to_apply', '建行应回 status to_apply');
  const id1 = r.data.id;
  let rows = appsOnDisk();
  assert.equal(rows.length, 1, '应恰好建一行');
  assert.equal(rows[0].jobId, 'site-zhipin-com-x1');
  assert.equal(rows[0].channel, 'extension', '来源渠道应标 extension');
  assert.equal(rows[0].docId, 'mastertest');
  assert.equal(rows[0].link, 'https://example.test/job1');
  // 同 jobId 二次 → 幂等（行数不变、id 不变）
  const r2 = await j('POST', '/extension/apply-record', { jobId: 'site-zhipin-com-x1', company: '测试科技', role: '内容运营', docId: 'mastertest' }, AUTH);
  assert.equal(r2.status, 200);
  assert.equal(appsOnDisk().length, 1, '同 jobId 二次建卡 → 行数不变（幂等）');
  assert.equal(r2.data.id, id1, '幂等应回同一行 id');
  assert.equal(r2.data.status, 'to_apply');
  // 前向推进：applied；再请求 to_apply → 不回退
  const r3 = await j('POST', '/extension/apply-record', { jobId: 'site-zhipin-com-x1', status: 'applied' }, AUTH);
  assert.equal(r3.status, 200);
  assert.equal(r3.data.status, 'applied', '应推进到 applied');
  const after = appsOnDisk()[0];
  assert.equal(after.status, 'applied');
  assert.ok(after.appliedAt && /^\d{4}-\d{2}-\d{2}$/.test(after.appliedAt), '推进到 applied 应补投递日期');
  const r4 = await j('POST', '/extension/apply-record', { jobId: 'site-zhipin-com-x1', status: 'to_apply' }, AUTH);
  assert.equal(r4.data.status, 'applied', '回退请求应原样返回现态（不回退）');
  assert.equal(appsOnDisk()[0].status, 'applied', '账本状态不得被回退请求改写');
  // 扩展行（无 snapTs/archive 键）进既有投递看板：页面照常渲染不炸
  const pg = await j('GET', '/applications');
  assert.equal(pg.status, 200, '/applications 页带扩展行应 200，实际 ' + pg.status + ' ' + pg.text.slice(0, 200));
  assert.ok(pg.text.includes('测试科技'), '扩展行公司名应出现在看板');
  // 参数闸：非法 jobId / 缺 company+role 建行 / 非法 status / 不存在 docId
  const e1 = await j('POST', '/extension/apply-record', { jobId: 'bad:id!', company: 'x', role: 'y', docId: 'mastertest' }, AUTH);
  assert.equal(e1.status, 400, '白名单外 jobId 应 400');
  const e2 = await j('POST', '/extension/apply-record', { jobId: 'site-zhipin-com-x2', docId: 'mastertest' }, AUTH);
  assert.equal(e2.status, 400, '建行缺 company/role 应 400');
  const e3 = await j('POST', '/extension/apply-record', { jobId: 'site-zhipin-com-x3', status: '已投递', company: 'x', role: 'y', docId: 'mastertest' }, AUTH);
  assert.equal(e3.status, 400, 'status 只收新枚举（legacy 中文值写入侧应拒）');
  const e4 = await j('POST', '/extension/apply-record', { jobId: 'site-zhipin-com-x4', company: 'x', role: 'y', docId: 'nodoc' }, AUTH);
  assert.equal(e4.status, 404, 'docId 不存在应 404');
  console.log('✅ 2 apply-record 建行 + 同 jobId 幂等 + 前向推进不回退 + 四类参数闸');
}

// ===== 3. greeting：假 LLM ≤120 字（含围栏清洗断言）；jdText / 投递行 jobId 两路 + 400 / 502 =====
{
  const r = await j('POST', '/extension/greeting', { docId: 'mastertest', jdText: '内容运营岗位：负责公众号内容策划与用户增长，要求三年以上经验，熟悉 A/B 实验。' }, AUTH);
  assert.equal(r.status, 200, 'greeting 应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.data.ok && typeof r.data.greeting === 'string' && r.data.greeting, 'greeting 应非空');
  assert.ok([...r.data.greeting].length <= 120, 'greeting 应 ≤120 字，实际 ' + [...r.data.greeting].length);
  assert.ok(!r.data.greeting.includes('```') && !r.data.greeting.startsWith('「'), '模型围栏/包裹引号应被清洗');
  assert.equal(llmCalls, 1, 'jdText 路径应恰好一次 LLM 调用');
  // 投递行 jobId 路径：行 role/company 进岗位上下文（不走上游、不烧多余调用）
  const r2 = await j('POST', '/extension/greeting', { jobId: 'site-zhipin-com-x1', docId: 'mastertest' }, AUTH);
  assert.equal(r2.status, 200, '行 jobId 路径应 200，实际 ' + r2.status + ' ' + r2.text);
  assert.ok(r2.data.greeting, '行 jobId 路径 greeting 应非空');
  assert.equal(llmCalls, 2);
  // 参数闸：缺 jobId+jdText → 400；白名单外 jobId → 400；未知 jobId 走死上游 → 502
  const e1 = await j('POST', '/extension/greeting', { docId: 'mastertest' }, AUTH);
  assert.equal(e1.status, 400, '缺 jobId/jdText 应 400');
  const e2 = await j('POST', '/extension/greeting', { docId: 'mastertest', jobId: 'bad:id!' }, AUTH);
  assert.equal(e2.status, 400, '白名单外 jobId 应 400');
  const e3 = await j('POST', '/extension/greeting', { docId: 'mastertest', jobId: 'upcv-unknown-1' }, AUTH);
  assert.equal(e3.status, 502, '未知 jobId 走上游失败应 502，实际 ' + e3.status + ' ' + e3.text);
  assert.equal(llmCalls, 2, '502 分支不应烧 LLM');
  console.log('✅ 3 greeting ≤120 字（假 LLM 围栏清洗）+ 两路岗位上下文 + 400/502 参数闸');
}

// ===== 4. shortlist：items 只回 to_apply；statuses 全表投影含 legacy 中文值归一 =====
{
  // 直接覆写账本（服务端每请求现读盘，无缓存）：覆盖六态 + legacy 中文 + 无 jobId 行
  fs.writeFileSync(path.join(ROOT, 'applications.json'), JSON.stringify([
    { id: '2026-11-19-100000-001', company: '甲公司', role: '内容运营', docId: 'mastertest', status: 'to_apply', jobId: 'site-a-1', createdAt: '', updatedAt: '' },
    { id: '2026-11-19-100000-002', company: '乙公司', role: '产品运营', docId: 'mastertest', status: 'applied', jobId: 'site-b-2', createdAt: '', updatedAt: '' },
    { id: '2026-11-19-100000-003', company: '丙公司', role: '活动运营', docId: 'mastertest', status: '已投递', jobId: 'site-c-3', createdAt: '', updatedAt: '' },
    { id: '2026-11-19-100000-004', company: '丁公司', role: '数据运营', docId: 'mastertest', status: '笔试', createdAt: '', updatedAt: '' },
    { id: '2026-11-19-100000-005', company: '戊公司', role: '社群运营', docId: 'mastertest', status: 'closed', jobId: 'site-d-4', createdAt: '', updatedAt: '' },
    { id: '2026-11-19-100000-006', company: '己公司', role: '直播运营', docId: 'mastertest', status: 'to_apply', createdAt: '', updatedAt: '' },
  ]));
  const r = await j('GET', '/extension/shortlist');
  assert.equal(r.status, 200, 'shortlist 应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.data.ok && Array.isArray(r.data.items) && Array.isArray(r.data.statuses));
  assert.deepEqual(r.data.items.map((i) => i.jobId), ['site-a-1', '2026-11-19-100000-006'],
    'items 只回 to_apply（无 jobId 老行回退行 id 兜底）');
  assert.equal(r.data.items[0].title, '内容运营', '消费字段对齐：role → title');
  assert.equal(r.data.items[0].companyName, '甲公司', '消费字段对齐：company → companyName');
  assert.equal(r.data.items[0].detailUrl, null, '无 link 行 detailUrl 应为 null');
  const map = new Map(r.data.statuses.map((s) => [s.jobId, s.status]));
  assert.equal(map.get('site-a-1'), 'to_apply');
  assert.equal(map.get('site-b-2'), 'applied');
  assert.equal(map.get('site-c-3'), 'applied', 'legacy「已投递」读时归一为 applied');
  assert.equal(map.get('site-d-4'), 'closed');
  assert.ok(!map.has('2026-11-19-100000-004') && !map.has('2026-11-19-100000-006'),
    'statuses 只投影带 jobId 的行（幂等跳过按站点幂等键）');
  console.log('✅ 4 shortlist 只回 to_apply + statuses 全表投影（legacy 中文值归一断言）');
}

// ===== 5. resume-text：指定文档非空 + 母版缺省回退 + 400/404 =====
{
  const r = await j('GET', '/extension/resume-text?docId=mastertest');
  assert.equal(r.status, 200, 'resume-text 应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.data.ok && typeof r.data.text === 'string' && r.data.text.includes('公众号增长与 A/B 实验'),
    'resume-text 应含正文（agent.mjs resolveDoc 同口径 docToText）');
  const rm = await j('GET', '/extension/resume-text');
  assert.equal(rm.status, 200);
  assert.equal(rm.data.docId, 'mastertest', '缺省应回退母版');
  const e1 = await j('GET', '/extension/resume-text?docId=bad_id!');
  assert.equal(e1.status, 400, '非法 docId 应 400');
  const e2 = await j('GET', '/extension/resume-text?docId=nodoc');
  assert.equal(e2.status, 404, '不存在 docId 应 404');
  console.log('✅ 5 resume-text 指定/母版缺省 + 400/404');
}

// ===== 6. chat-reply happy 路径 + 源码断言（CSRF 豁免行 / token 比对行 / gatePool 精确匹配行 / 冻结登记）=====
{
  const e = await j('POST', '/extension/chat-reply', { jobId: 'site-a-1' }, AUTH);
  assert.equal(e.status, 400, '缺 historyText 应 400');
  const r = await j('POST', '/extension/chat-reply', { jobId: 'site-a-1', historyText: 'HR:你好，看了你的简历，方便聊聊吗？' }, AUTH);
  assert.equal(r.status, 200, 'chat-reply 应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.data.ok && r.data.draft && r.data.draft.includes('内容运营'), '回复草稿应非空且以简历经历为据（假 LLM 固定值）');
  assert.equal(llmCalls, 3, 'greeting×2 + chat-reply×1；400 分支在进模型前拦下不烧 LLM');
  // match-score 带口令（A2 端点在 A4 口令闸纳管后的回归样张）：扩展真实流 = 站点 jobId + 卡片字段 jdText
  const ms = await j('POST', '/extension/match-score', { docId: 'mastertest', jobId: 'site-zhipin-com-j9', jdText: '内容运营岗位，要求公众号增长与 A/B 实验经验，三年以上内容平台经验，熟悉数据看板。'.repeat(3) }, AUTH);
  assert.equal(ms.status, 200, 'match-score 带口令应 200，实际 ' + ms.status + ' ' + ms.text);
  assert.equal(ms.data.matchScore, 82);
  assert.equal(ms.data.matchLevel, 'strong');
  assert.equal(llmCalls, 4, 'match-score 走 A2 核心 + 假 LLM 恰一次');
  const cache = JSON.parse(fs.readFileSync(path.join(ROOT, 'match-cache.json'), 'utf8'));
  assert.ok(Object.keys(cache).some((k) => k.startsWith('mastertest|fp:')), '站点 jobId + jdText → 应按指纹键缓存（不走上游）');

  const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
  const ext = fs.readFileSync(path.join(APP_ROOT, 'extension.mjs'), 'utf8');
  // ① CSRF/迁移锁豁免行（/import/page 先例同款）
  assert.ok(srv.includes("&& !url.pathname.startsWith('/extension/')"), 'mutating 判定应含 /extension/ 前缀豁免行');
  // ② token 比对行（importTokenOk + 头名）
  assert.ok(srv.includes("importTokenOk(req.headers['x-resume-token'])"), '口令闸应比对 X-Resume-Token');
  // ③ gatePool 精确匹配行（勿用前缀：apply-record/shortlist 不调模型不得误占 AI 槽）
  const gateLine = srv.split('\n').find((l) => l.includes("pathname === '/match/job'"));
  assert.ok(gateLine, '应找到 gatePool AI 池判定行');
  for (const route of ["pathname === '/extension/greeting'", "pathname === '/extension/chat-reply'"]) {
    assert.ok(gateLine.includes(route), 'gatePool 应精确登记 ' + route);
  }
  assert.ok(!gateLine.includes("startsWith('/extension/')"), 'gatePool 不得用 /extension/ 前缀（免误伤 apply-record 等非模型端点）');
  // ④ 路由集合冻结登记（登记非放宽）
  const tss = fs.readFileSync(path.join(APP_ROOT, 'test-structure.sh'), 'utf8');
  for (const route of ["'/extension/shortlist'", "'/extension/apply-record'", "'/extension/resume-text'", "'/extension/greeting'", "'/extension/chat-reply'"]) {
    assert.ok(tss.includes(route), 'ROUTES_FROZEN 应登记 ' + route);
  }
  // ⑤ A2 测试回归样张：match-score 调用已带头（A4 口令闸纳管后的协同改动）+ A4 修正在 route 内落锚
  const tjm = fs.readFileSync(path.join(APP_ROOT, 'test-jobs-match.mjs'), 'utf8');
  assert.ok(tjm.includes("{ 'X-Resume-Token': TOKEN }"), 'test-jobs-match 的 match-score 调用应带 X-Resume-Token');
  assert.ok(srv.includes("jobId: jd.trim() ? undefined : body.jobId"), 'match-score 路由应保留 A4 修正（站点 id 走 jdText 键，勿回退）');
  // ⑥ extension.mjs 纪律锚：前向 rank + legacy 归一表
  assert.ok(ext.includes('const STATUS_RANK'), 'extension.mjs 应有前向推进 rank 表');
  assert.ok(ext.includes("'已投递': 'applied'"), 'extension.mjs 应带 legacy 枚举归一表（server.mjs 同源照抄）');
  console.log('✅ 6 chat-reply 草稿 + match-score 口令样张 + 源码断言（豁免行/token 行/gatePool 精确/冻结登记/A2 协同）');
}

console.log('✅ test-extension 全部通过');
server.kill(); process.exit(0);
