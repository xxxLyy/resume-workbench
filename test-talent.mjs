// test-talent.mjs — UPCV A1（求职画像 + 偏好）接入断言。退出码 0=全过；1=任一断言失败。
// 六步样板照 test-aora.mjs：隔离根/动态口/spawn/exit 钩子/fetch+源码断言/✅ 段式。
// LLM 一律本地假 stub（虚拟 config 指向 127.0.0.1），不碰 7766、不调真实模型。
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
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-talent-'));
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

// ===== 假 LLM（OpenAI 兼容，test.sh llm-stub 同思路）：控制文件 llm-bad 切换 level 越界回复 =====
const ROOT = mkRoot();
const LLM_PORT = await freePort();
const TALENT_OK = JSON.stringify({
  timeline: [{ period: '2023.09-2027.06', title: '市场营销本科', org: '测试大学', kind: 'education' }],
  directions: [{ name: '内容产品', confidence: 0.8, reason: '两段内容运营实习' }],
  competitiveness: { level: 3, label: '中等偏上', total: 5, strengths: ['A/B 实验方法完整'], gaps: ['缺少垂直行业深度'] },
  headline: '内容+数据复合背景的内容产品候选人'
});
const TALENT_BAD = JSON.stringify({
  timeline: [], directions: [{ name: '方向甲', confidence: 0.5, reason: '判定' }],
  competitiveness: { level: 9, label: '越界', strengths: [], gaps: [] }, headline: '越界画像'
});
const llm = http.createServer((q, s) => {
  let b = '';
  q.on('data', (c) => { b += c; });
  q.on('end', () => {
    const content = fs.existsSync(path.join(ROOT, 'llm-bad')) ? TALENT_BAD : TALENT_OK;
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise((res) => llm.listen(LLM_PORT, '127.0.0.1', res));
procs.push({ kill: () => { try { llm.close(); } catch {} } });

// ===== 被测服务：隔离根 + 虚拟 config 指向假 LLM；初始无母版（第 4 步先测 400）=====
const PORT = await freePort();
fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: 'test-key', model: 'stub-model' }]
}));
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: ROOT, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe']
});
procs.push(server);
const LOG = path.join(ROOT, 'server.log');
server.stdout.on('data', (b) => { try { fs.appendFileSync(LOG, b); } catch {} });
await waitReady(server, LOG, '简历平台');
const B = `http://127.0.0.1:${PORT}`;
const j = (method, p, body) => fetch(B + p, {
  method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
}).then((r) => r.text().then((t) => { let d = null; try { d = JSON.parse(t); } catch {} return { status: r.status, data: d, text: t }; }));

// ===== 1. 无母版 → 400 中文（docs-meta 未 seed）=====
{
  const r = await j('POST', '/talent/generate');
  assert.equal(r.status, 400, '无母版应 400，实际 ' + r.status);
  assert.ok(r.data && r.data.error === '先创建或导入一份母版简历，画像基于母版生成', '无母版应回中文原因，实际: ' + r.text);
  console.log('✅ 1 无母版 400 中文');
}

// ===== 2. seed 母版 → 合法 JSON 生成 → 逐字段断言 + 缓存回读 =====
fs.writeFileSync(path.join(ROOT, 'docs-meta.json'), JSON.stringify({ mastertest: {} }));
fs.writeFileSync(path.join(ROOT, 'docs', 'mastertest.html'),
  '<html><body><h1>测试母版简历</h1><section class="section"><div class="section-title">工作经历</div>'
  + '<p>2023-2024 测试公司 内容运营实习，负责公众号增长与 A/B 实验</p></section></body></html>');
{
  const r = await j('POST', '/talent/generate');
  assert.equal(r.status, 200, 'generate 应 200，实际 ' + r.status + ' ' + r.text);
  const p = r.data.profile;
  assert.ok(p, '响应应带 profile');
  assert.equal(p.headline, '内容+数据复合背景的内容产品候选人');
  assert.equal(p.timeline.length, 1);
  assert.equal(p.timeline[0].title, '市场营销本科');
  assert.equal(p.timeline[0].org, '测试大学');
  assert.equal(p.directions.length, 1);
  assert.equal(p.directions[0].name, '内容产品');
  assert.equal(p.directions[0].confidence, 0.8);
  assert.equal(p.competitiveness.level, 3);
  assert.equal(p.competitiveness.total, 5, 'total 应固定 5（参考评分满分）');
  assert.deepEqual(p.competitiveness.strengths, ['A/B 实验方法完整']);
  assert.deepEqual(p.competitiveness.gaps, ['缺少垂直行业深度']);
  assert.equal(p.sourceDocId, 'mastertest');
  assert.ok(typeof p.generatedAt === 'string' && p.generatedAt, 'generatedAt 应为 ISO 字符串');
  const disk = JSON.parse(fs.readFileSync(path.join(ROOT, 'talent.json'), 'utf8'));
  assert.ok(disk.profile && disk.profile.headline === p.headline, 'talent.json 应已落盘');
  const g = await j('GET', '/talent/profile');
  assert.equal(g.status, 200);
  assert.equal(g.data.profile.headline, p.headline, '缓存回读应一致');
  assert.equal(g.data.profile.generatedAt, p.generatedAt, '缓存回读 generatedAt 一致');
  console.log('✅ 2 合法 JSON 生成 + 逐字段断言 + 缓存回读');
}

// ===== 3. level 越界 → 整份作废 502 + 旧画像不被覆盖 =====
fs.writeFileSync(path.join(ROOT, 'llm-bad'), '1');
{
  const before = (await j('GET', '/talent/profile')).data.profile;
  const r = await j('POST', '/talent/refresh');
  assert.equal(r.status, 502, 'level 越界应整份作废 502，实际 ' + r.status);
  assert.ok(r.data && /画像结果解析失败|1-5/.test(r.data.error), '502 应带中文解析失败原因，实际: ' + r.text);
  const after = (await j('GET', '/talent/profile')).data.profile;
  assert.equal(after.headline, before.headline, '作废后旧画像不应被覆盖');
  assert.equal(after.generatedAt, before.generatedAt, '作废后 generatedAt 不变');
  fs.rmSync(path.join(ROOT, 'llm-bad'));
  console.log('✅ 3 level 越界整份作废 502 + 旧画像保留');
}

// ===== 4. 偏好：非法 companyTypes 400 → 合法 PUT → 回读一致 =====
{
  const bad = await j('PUT', '/preference', { jobTypes: ['SOCIAL'], companyTypes: ['PRIVATE', 'EVIL_CORP'] });
  assert.equal(bad.status, 400, '非法 companyTypes 应 400，实际 ' + bad.status);
  assert.ok(bad.data && /companyTypes/.test(bad.data.error), '400 应带 companyTypes 枚举提示，实际: ' + bad.text);
  const badJobType = await j('PUT', '/preference', { jobTypes: ['CAMPUS'] });
  assert.equal(badJobType.status, 400, '校招不在合法集应 400');
  const badSal = await j('PUT', '/preference', { salary: { min: 30, max: 10, unit: 'K' } });
  assert.equal(badSal.status, 400, 'min>max 应 400');
  const pref = {
    jobTypes: ['SOCIAL'], status: 'actively_looking',
    salary: { min: 15, max: 25, unit: 'K' },
    cityIds: [1, 2], industryIds: [], functionIds: [3],
    companyTypes: ['PRIVATE', 'LISTED'], availability: '1个月内', allowContact: false
  };
  const put = await j('PUT', '/preference', pref);
  assert.equal(put.status, 200, '合法偏好应 200，实际 ' + put.status + ' ' + put.text);
  const st = await j('GET', '/preference/state');
  assert.equal(st.status, 200);
  assert.deepEqual(st.data.preference, pref, 'GET state 应与 PUT 回读一致');
  const disk = JSON.parse(fs.readFileSync(path.join(ROOT, 'preference.json'), 'utf8'));
  assert.deepEqual(disk.preference, pref, 'preference.json 应已落盘');
  console.log('✅ 4 偏好校验 400 / 合法 PUT / 回读一致');
}

// ===== 5. 页面与面板路由 =====
{
  const pg = await j('GET', '/talent');
  assert.equal(pg.status, 200, '/talent 页应 200');
  assert.ok(pg.text.includes('求职画像') && pg.text.includes('talent-panel.js'), '/talent 页应带面板脚本');
  assert.ok(pg.text.includes('window.__TALENT__'), '/talent 页应带 boot 数据');
  assert.ok(pg.text.includes('AI 参考评分'), '/talent 页应带 AI 参考评分字样（诚信口径）');
  const pan = await j('GET', '/talent-panel.js');
  assert.equal(pan.status, 200);
  assert.match(pan.text, /talent-app|__TALENT__/, '面板脚本应引用挂载点');
  console.log('✅ 5 页面 + 面板路由');
}

// ===== 6. 源码断言：gatePool 前缀 / factsBlock 两段 / topnav 项 / RESTORE 登记 / 新文件零字面色 =====
{
  const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
  const ag = fs.readFileSync(path.join(APP_ROOT, 'agent.mjs'), 'utf8');
  const tal = fs.readFileSync(path.join(APP_ROOT, 'talent.mjs'), 'utf8');
  const pan = fs.readFileSync(path.join(APP_ROOT, 'talent-panel.js'), 'utf8');
  assert.ok(srv.includes("/^\\/talent\\//.test(pathname)"), 'gatePool 应含 /talent/ AI 池前缀');
  assert.ok(srv.includes("nav('talent', '/talent', '求职画像', 'compass')"), 'topnav 应含求职画像项');
  assert.ok(srv.includes("'talent.json', 'preference.json'"), 'RESTORE_MANAGED_FILES 应登记两账本');
  assert.ok(srv.includes('|talent\\.json$|preference\\.json$'), '备份 ALLOWED 白名单应登记两账本');
  assert.ok(ag.includes('【求职画像】') && ag.includes('【求职偏好】'), 'agent factsBlock 应含画像/偏好两段');
  // B1 口径：新增文件零字面色（唯一亮蓝字面 #0033d2 只允许出现在 server.mjs 的 A-VARS 行）
  for (const [name, src] of [['talent.mjs', tal], ['talent-panel.js', pan]]) {
    const hits = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
    assert.equal(hits.length, 0, name + ' 应零字面色，实得: ' + hits.join(','));
  }
  assert.equal([...srv.matchAll(/#0033d2/g)].length, 1, 'server.mjs 亮蓝字面仍应唯一（B1）');
  console.log('✅ 6 源码断言（gatePool/factsBlock/topnav/登记/零字面色）');
}

console.log('✅ test-talent 全部通过');
server.kill(); process.exit(0);
