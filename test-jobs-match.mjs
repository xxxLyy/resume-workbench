// test-jobs-match.mjs — UPCV A2（社招职位 + 匹配 + 推荐）接入断言。退出码 0=全过；1=任一断言失败。
// 六步样板照 test-aora.mjs/test-talent.mjs：隔离根/动态口/spawn/exit 钩子/fetch+源码断言/✅ 段式。
// LLM 一律本地假 stub；上游一律进程内假上游（RESUME_UPCV_BASE 覆盖，test.sh 假渲染器同思路）——零真实网络。
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
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-'));
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

// ===== 假上游（UPCV 公开接口形状投影；记录 jobs 查询供白名单/偏好映射断言）=====
const ROOT = mkRoot();
const UP_PORT = await freePort();
const upCalls = { jobsQuery: null, jobsCount: 0, dictCount: 0, detailIds: [] };
const JOBS_PAGE = {
  data: [
    { id: 'job-1', title: '内容运营专家', companyName: '测试科技', locationDetail: '上海', salaryDisplay: '15-25K', detailUrl: 'https://example.test/job1' },
    { id: 'job-2', title: '产品运营', companyName: '示例公司', locationDetail: '北京', salaryDisplay: '20-30K' },
  ],
  total: 2,
};
const detailOf = (id) => ({
  job: {
    title: id === 'job-1' ? '内容运营专家' : '产品运营',
    companyName: id === 'job-1' ? '测试科技' : '示例公司',
    description: '负责公众号内容策划与用户增长，搭建数据看板驱动迭代。',
    requirements: '3 年以上内容运营经验，熟悉主流分发平台与 A/B 实验。',
    locationDetail: id === 'job-1' ? '上海' : '北京',
    salaryDisplay: id === 'job-1' ? '15-25K' : '20-30K',
  },
  company: { name: id === 'job-1' ? '测试科技' : '示例公司' },
});
const upstream = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://up');
  if (u.pathname === '/campus/jobs') {
    upCalls.jobsQuery = u.searchParams;
    upCalls.jobsCount += 1;
    s.writeHead(200, { 'Content-Type': 'application/json' });
    return s.end(JSON.stringify(JOBS_PAGE));
  }
  const m = /^\/campus\/jobs\/([^/]+)$/.exec(u.pathname);
  if (m) {
    upCalls.detailIds.push(decodeURIComponent(m[1]));
    s.writeHead(200, { 'Content-Type': 'application/json' });
    return s.end(JSON.stringify(detailOf(decodeURIComponent(m[1]))));
  }
  if (u.pathname === '/campus/cities/grouped') {
    upCalls.dictCount += 1;
    return s.end(JSON.stringify([{ id: 1, name: '上海' }, { id: 2, name: '北京' }]));
  }
  if (u.pathname === '/campus/functions/grouped') {
    return s.end(JSON.stringify([{ id: 3, name: '内容' }]));
  }
  if (u.pathname === '/campus/concepts/industry') {
    return s.end(JSON.stringify([]));
  }
  s.writeHead(404); s.end('{}');
});
await new Promise((res) => upstream.listen(UP_PORT, '127.0.0.1', res));
procs.push({ kill: () => { try { upstream.close(); } catch {} } });

// ===== 假 LLM（OpenAI 兼容；llm-bad 控制文件切换「strengths 编造」回复）=====
const LLM_PORT = await freePort();
let llmCalls = 0;
const MATCH_OK = JSON.stringify({
  matchScore: 82, matchLevel: 'strong', headline: '内容运营经验与岗位高度重合',
  strengths: [{ text: 'A/B 实验驱动增长', evidence: '负责公众号增长与 A/B 实验' }],
  gaps: ['缺少电商行业背景'],
  resumeSuggestions: ['把 A/B 实验的量化结果放进首条经历'],
});
const MATCH_FABRICATED = JSON.stringify({
  matchScore: 55, matchLevel: 'medium', headline: '匹配中等',
  strengths: [{ text: '编造的量子计算经验', evidence: '量子计算平台架构负责人' }],
  gaps: ['缺 B 端经验'],
  resumeSuggestions: ['补充项目量化'],
});
const llm = http.createServer((q, s) => {
  let b = '';
  q.on('data', (c) => { b += c; });
  q.on('end', () => {
    llmCalls += 1;
    const content = fs.existsSync(path.join(ROOT, 'llm-bad')) ? MATCH_FABRICATED : MATCH_OK;
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((res) => llm.listen(LLM_PORT, '127.0.0.1', res));
procs.push({ kill: () => { try { llm.close(); } catch {} } });

// ===== 被测服务：隔离根 + 虚拟 config 指向假 LLM + RESUME_UPCV_BASE 指向假上游 =====
// UPCV A4 起 /extension/* POST 统一验 X-Resume-Token（importToken 书签同源口令）——预 seed 口令文件，match-score 调用带头。
const TOKEN = 'a'.repeat(32);   // 32 位 hex 假口令（importToken 形状校验 [0-9a-f]{32}）
fs.writeFileSync(path.join(ROOT, '.import-token'), TOKEN);
const PORT = await freePort();
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: 'test-key', model: 'stub-model' }]
}));
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: {
    ...process.env, RESUME_ROOT: ROOT, PORT: String(PORT),
    RESUME_UPCV_BASE: `http://127.0.0.1:${UP_PORT}`, RESUME_MATCH_INTERVAL_MS: '0',
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

// ===== 1. /jobs/search 白名单透传 + 非法参数丢弃 + limit 封顶 20 + 字典缓存 =====
{
  const r = await j('GET', '/jobs/search?jobType=SOCIAL&search=运营&cityIds=1&evilParam=1&page=2&limit=999');
  assert.equal(r.status, 200, 'search 应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.data.ok, 'search 应 ok:true');
  assert.equal(r.data.items.length, 2, '假上游两岗应透传');
  assert.equal(r.data.items[0].id, 'job-1');
  assert.equal(r.data.page, 2, 'page 应回显 2');
  assert.equal(r.data.limit, 20, 'limit 应封顶 20');
  assert.equal(r.data.hasMore, false, 'page*limit>=total → hasMore false');
  const q = upCalls.jobsQuery;
  assert.equal(q.get('search'), '运营', '白名单参数 search 应透传');
  assert.equal(q.get('cityIds'), '1', '白名单参数 cityIds 应透传');
  assert.equal(q.get('limit'), '20', 'limit 应封顶后透传 20');
  assert.ok(!q.has('evilParam'), '白名单外参数应被丢弃');
  assert.equal(q.get('jobType'), 'SOCIAL', 'jobType 应透传');
  const dict1 = await j('GET', '/jobs/dictionaries');
  assert.equal(dict1.status, 200, '字典应 200');
  assert.ok(dict1.data.ok && Array.isArray(dict1.data.cities) && dict1.data.cities.length === 2, 'cities 字典应透传');
  assert.equal(upCalls.dictCount, 1, '字典端点应打一次上游');
  await j('GET', '/jobs/dictionaries');   // 二次：进程内缓存，不打上游
  assert.equal(upCalls.dictCount, 1, '10 分钟内字典应命中进程内缓存（上游调用数不变）');
  console.log('✅ 1 上游白名单透传 + 非法参数丢弃 + limit 封顶 + 字典缓存');
}

// ===== 2. /match/job：seed 母版 → 合法 JSON 逐字段 + 缓存命中（LLM 计数=1）+ refresh 重算 =====
fs.writeFileSync(path.join(ROOT, 'docs-meta.json'), JSON.stringify({ mastertest: {} }));
fs.writeFileSync(path.join(ROOT, 'docs', 'mastertest.html'),
  '<html><body><h1>测试母版简历</h1><section class="section"><div class="section-title">工作经历</div>'
  + '<p>2023-2024 测试公司 内容运营实习，负责公众号增长与 A/B 实验</p></section></body></html>');
{
  const badBody = await j('POST', '/match/job', { docId: 'mastertest' });
  assert.equal(badBody.status, 400, '缺 jobId/jdText 应 400，实际 ' + badBody.status);
  const r = await j('POST', '/match/job', { docId: 'mastertest', jobId: 'job-1' });
  assert.equal(r.status, 200, 'match/job 应 200，实际 ' + r.status + ' ' + r.text);
  const m = r.data.match;
  assert.equal(r.data.cached, false, '首次应未命中缓存');
  assert.equal(m.matchScore, 82);
  assert.equal(m.matchLevel, 'strong');
  assert.equal(m.headline, '内容运营经验与岗位高度重合');
  assert.deepEqual(m.strengths, ['A/B 实验驱动增长'], 'evidence 过子串验证 → strengths 保留 text');
  assert.deepEqual(m.gaps, ['缺少电商行业背景']);
  assert.deepEqual(m.resumeSuggestions, ['把 A/B 实验的量化结果放进首条经历']);
  assert.equal(llmCalls, 1, '首次匹配应恰好调一次假 LLM');
  const disk = JSON.parse(fs.readFileSync(path.join(ROOT, 'match-cache.json'), 'utf8'));
  assert.ok(disk['mastertest|job-1'] && disk['mastertest|job-1'].matchScore === 82, 'match-cache.json 应落盘且键为 docId|jobId');
  // 同参二次 → 缓存命中（零 LLM）
  const r2 = await j('POST', '/match/job', { docId: 'mastertest', jobId: 'job-1' });
  assert.equal(r2.status, 200);
  assert.equal(r2.data.cached, true, '同参二次应命中缓存');
  assert.equal(r2.data.match.matchScore, 82, '缓存回读应一致');
  assert.equal(llmCalls, 1, '缓存命中不应再调 LLM（计数仍为 1）');
  // refresh → 重算
  const r3 = await j('POST', '/match/job', { docId: 'mastertest', jobId: 'job-1', refresh: true });
  assert.equal(r3.status, 200);
  assert.equal(r3.data.cached, false, 'refresh 应重算');
  assert.equal(llmCalls, 2, 'refresh 应再调一次 LLM（计数 2）');
  // jdText 路径：指纹键（不走上游详情）
  const rt = await j('POST', '/match/job', {
    docId: 'mastertest',
    jdText: '内容运营岗位，要求熟悉公众号增长与 A/B 实验，负责内容策划与用户增长指标，要求三年以上内容平台经验，熟悉数据看板与实验设计流程。'.repeat(3),
  });
  assert.equal(rt.status, 200, 'jdText 路径应 200，实际 ' + rt.status + ' ' + rt.text);
  assert.equal(llmCalls, 3, 'jdText 新键应再调一次 LLM');
  const disk2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'match-cache.json'), 'utf8'));
  const fpKeys = Object.keys(disk2).filter((k) => k.startsWith('mastertest|fp:'));
  assert.equal(fpKeys.length, 1, 'jdText 应按指纹键落账');
  console.log('✅ 2 match/job 逐字段 + 缓存命中（LLM=1）+ refresh 重算 + jdText 指纹键');
}

// ===== 3. strengths 编造（evidence 不在简历原文）→ 剔除该条，其余字段保留 =====
fs.writeFileSync(path.join(ROOT, 'llm-bad'), '1');
{
  const r = await j('POST', '/match/job', { docId: 'mastertest', jobId: 'job-2' });
  assert.equal(r.status, 200, '编造分支应仍 200（剔除不整份作废），实际 ' + r.status + ' ' + r.text);
  const m = r.data.match;
  assert.equal(m.matchScore, 55, 'score 合法应保留');
  assert.equal(m.matchLevel, 'medium');
  assert.deepEqual(m.strengths, [], 'evidence 不在简历原文 → 该条剔除，strengths 应为空');
  assert.deepEqual(m.gaps, ['缺 B 端经验'], 'gaps 不走 evidence 验证应保留');
  fs.rmSync(path.join(ROOT, 'llm-bad'));
  console.log('✅ 3 strengths 编造剔除断言（eval.mjs 逐字子串纪律移植）');
}

// ===== 4. /match/recommend：无偏好裸 SOCIAL feed → PUT 偏好 → 城市职能薪资映射 + 分数降序 =====
{
  const r = await j('POST', '/match/recommend', {});
  assert.equal(r.status, 200, '无偏好 recommend 应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.data.ok);
  const q0 = upCalls.jobsQuery;
  assert.equal(q0.get('jobType'), 'SOCIAL', '无偏好应裸 SOCIAL feed');
  assert.ok(!q0.has('cityIds') && !q0.has('search'), '无偏好不应带 cityIds/search');
  assert.equal(r.data.items.length, 2, '推荐应返回两岗');
  const s1 = r.data.items.map((it) => it.matchScore);
  assert.deepEqual(s1, [...s1].sort((a, b) => (b ?? -1) - (a ?? -1)), 'items 应按 matchScore 降序');
  assert.ok(r.data.items[0].matchScore === 82 && r.data.items[1].matchScore === 55, '两岗应都有缓存分数（82>55）');
  const noLLMGrowth = llmCalls;   // 全缓存命中 → 推荐不应新增 LLM 调用
  const pref = { jobTypes: ['SOCIAL'], salary: { min: 15, max: 25, unit: 'K' }, cityIds: [1, 2], functionIds: [3] };
  const put = await j('PUT', '/preference', pref);
  assert.equal(put.status, 200, '偏好 PUT 应 200，实际 ' + put.status + ' ' + put.text);
  const r2 = await j('POST', '/match/recommend', { limit: 12 });
  assert.equal(r2.status, 200);
  const q1 = upCalls.jobsQuery;
  assert.equal(q1.get('jobType'), 'SOCIAL', 'jobTypes→jobType=SOCIAL（校招位忽略）');
  assert.equal(q1.get('cityIds'), '1,2', '偏好 cityIds 应映射搜索参数');
  assert.equal(q1.get('functionIds'), '3', '偏好 functionIds 应映射搜索参数');
  assert.equal(q1.get('search'), '15-25K', '偏好 salary 应映射 search 关键词');
  assert.equal(q1.get('limit'), '12', '推荐 limit 封顶 12');
  assert.equal(llmCalls, noLLMGrowth, '推荐逐岗全命中缓存 → 零新增 LLM 调用');
  console.log('✅ 4 偏好映射断言（cityIds/functionIds/salary→search/jobType）+ 推荐吃缓存 + 分数降序');
}

// ===== 5. /jobs/apply-draft 转入适配（复用 /job/create 管线：建档 + 409 幂等）+ extension/match-score =====
{
  const r = await j('POST', '/jobs/apply-draft', { jobId: 'job-1', from: 'mastertest' });
  assert.equal(r.status, 200, 'apply-draft 应 200，实际 ' + r.status + ' ' + r.text);
  assert.ok(r.data.ok && typeof r.data.id === 'string' && r.data.id, '应返回草稿 id');
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', r.data.id + '.html')), '岗位草稿应落盘');
  const dup = await j('POST', '/jobs/apply-draft', { jobId: 'job-1', from: 'mastertest' });
  assert.equal(dup.status, 409, '同岗重复创建应 409 幂等，实际 ' + dup.status);
  assert.equal(dup.data.existing, r.data.id, '409 应携带 existing 指向既有草稿');
  const ms = await j('POST', '/extension/match-score', { docId: 'mastertest', jobId: 'job-1' }, { 'X-Resume-Token': TOKEN });
  assert.equal(ms.status, 200, 'extension/match-score 带 token 应 200，实际 ' + ms.status + ' ' + ms.text);
  assert.equal(ms.data.matchScore, 82, '轻量端点应回缓存分数');
  assert.equal(ms.data.matchLevel, 'strong', '轻量端点应回缓存档位');
  console.log('✅ 5 转入适配建档 + 409 幂等 + extension/match-score 轻量两字段');
}

// ===== 6. 页面与面板路由 + 源码断言（gatePool 前缀 / 五处账本登记 / nav 第 9 项 / 零字面色）=====
{
  const pg = await j('GET', '/jobs');
  assert.equal(pg.status, 200, '/jobs 页应 200');
  assert.ok(pg.text.includes('社招职位') && pg.text.includes('jobs-panel.js'), '/jobs 页应带面板脚本');
  assert.ok(pg.text.includes('window.__JOBS__'), '/jobs 页应带 boot 数据');
  assert.ok(pg.text.includes('AI 匹配参考'), '/jobs 页应带 AI 参考字样（诚信口径）');
  assert.ok(pg.text.includes('"appJobIds"'), 'boot 数据应含 appJobIds（加入待投幂等依据）');
  const pan = await j('GET', '/jobs-panel.js');
  assert.equal(pan.status, 200);
  assert.match(pan.text, /jobs-app|__JOBS__/, '面板脚本应引用挂载点');

  const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
  const mt = fs.readFileSync(path.join(APP_ROOT, 'match.mjs'), 'utf8');
  const uj = fs.readFileSync(path.join(APP_ROOT, 'upcv-jobs.mjs'), 'utf8');
  const pnl = fs.readFileSync(path.join(APP_ROOT, 'jobs-panel.js'), 'utf8');
  // gatePool：只有调 LLM 的三个端点进 AI 池（精确匹配，/jobs/* 不进）
  for (const route of ["pathname === '/match/job'", "pathname === '/match/recommend'", "pathname === '/extension/match-score'"]) {
    assert.ok(srv.includes(route), 'gatePool 应含 ' + route);
  }
  // topnav 第 9 项（icon 在白名单内改选 box）+ S2-B1 路由集合基线登记（登记非放宽）
  assert.ok(srv.includes("nav('jobs', '/jobs', '职位', 'box')"), 'topnav 应含职位项');
  const tss = fs.readFileSync(path.join(APP_ROOT, 'test-structure.sh'), 'utf8');
  assert.ok(tss.includes("'/jobs','/jobs-panel.js','/jobs/search','/jobs/dictionaries','/jobs/apply-draft','/match/job','/match/recommend','/extension/match-score'"),
    'S2-B1 ROUTES_FROZEN 应登记 A2 八路由（登记非放宽）');
  // 五处账本登记
  assert.ok(srv.includes("'match-cache.json'", 'RESTORE_MANAGED_FILES 应登记 match-cache'));
  assert.ok(/bakFiles/.test(srv) && /\.concat\(\[.*'match-cache\.json'/.test(srv), '备份 bakFiles 应登记 match-cache');
  assert.ok(srv.includes('resume-draft|match-cache)\\.json$'), '恢复侧 ⑤ 形状层正则应登记 match-cache');
  assert.equal([...srv.matchAll(/match-cache\\\.json\$/g)].length, 1, '恢复侧入口 ALLOWED 正则应登记 match-cache（与 ⑤ 形状层两道白名单各自一处）');
  assert.equal([...srv.matchAll(/for \(const f of \['talent\.json', 'preference\.json', 'resume-draft\.json', 'match-cache\.json'\]\) copyObjLedgerIfSound/g)].length, 2,
    'copyObjLedgerIfSound replace/merge 两循环都应登记 match-cache');
  // .gitignore + test.sh seed
  const gi = fs.readFileSync(path.join(APP_ROOT, '.gitignore'), 'utf8');
  assert.ok(gi.includes('match-cache.json') && gi.includes('.match-cache.json.lock'), '.gitignore 应登记账本与锁');
  const tsh = fs.readFileSync(path.join(APP_ROOT, 'test.sh'), 'utf8');
  assert.ok(tsh.includes("echo '{}' > \"$RESUME_ROOT/match-cache.json\""), 'test.sh 隔离根应 seed match-cache');
  // B1 口径：新增文件零字面色（唯一亮蓝字面 #0033d2 只允许出现在 server.mjs 的 A-VARS 行）
  for (const [name, src] of [['match.mjs', mt], ['upcv-jobs.mjs', uj], ['jobs-panel.js', pnl]]) {
    const hits = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.equal(hits.length, 0, name + ' 应零字面色，实得: ' + hits.join(','));
  }
  assert.equal([...srv.matchAll(/#0033d2/g)].length, 1, 'server.mjs 亮蓝字面仍应唯一（B1）');
  // 面板纪律：零 innerHTML
  assert.ok(!/\.innerHTML\s*=/.test(pnl), 'jobs-panel.js 应零 innerHTML 赋值');
  console.log('✅ 6 页面/面板路由 + 源码断言（gatePool/五处登记/nav 第 9 项/零字面色/零 innerHTML）');
}

console.log('✅ test-jobs-match 全部通过');
server.kill(); process.exit(0);
