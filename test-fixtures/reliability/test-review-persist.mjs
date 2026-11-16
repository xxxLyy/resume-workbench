// test-review-persist.mjs — 体检报告持久化回归（2026-11-16）
// 覆盖：POST /ai/review 成功→落 lastReview/reviewHist；GET /ai/review 回读 last+prevScore；
//       第二次 POST 响应 prevScore=第一次分数；reviewHist 环形 ≤10（11 次后）；
//       target 透传（桩 user 收到【目标方向】）与空 target 不带；解析失败（reply）不落盘。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-review-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '甲'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'], ['{{SKILLS}}', ''], ['{{WORK}}', '<p>负责交易系统</p>'], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'd1']]) doc = doc.replaceAll(k, () => v);
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));

// 桩 LLM：体检通道按调用序回不同分数；记录每次 user 是否含【目标方向】；badFlag 时回纯文本（reply 路径）
let calls = 0, sawTarget = false, lastHadTarget = null, badFlag = false;
const stub = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    let user = ''; try { user = JSON.parse(b).messages.find((m) => m.role === 'user').content; } catch {}
    calls++; lastHadTarget = user.includes('【目标方向】'); if (lastHadTarget) sawTarget = true;
    const out = badFlag ? '这不是 JSON 报告' : JSON.stringify({ score: 70 + calls, summary: '总评' + calls, scoreBasis: '均分', items: ['【结构】8/10：清晰'], changes: [{ before: '负责交易系统', after: '负责交易系统优化', note: 'n' }] });
    s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ choices: [{ message: { content: out } }] }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
// 双就绪档案（A=active / B=对比）+ 一个不完整档案（C）：pickProfile 只收就绪索引
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ active: 0, profiles: [
  { name: 's', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'k', model: 'm' },
  { name: 'B', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'k', model: 'mb' },
  { name: 'C', baseURL: '', apiKey: '', model: '' }
] }));

const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const B = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], { env: { ...process.env, RESUME_ROOT: root, PORT: String(PORT) }, stdio: 'pipe' });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { stub.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
const meta = () => JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/'); if (r.status === 200) break; } catch {} await sleep(200); }
  const post = async (u, body) => { const r = await fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { code: r.status, j: await r.json().catch(() => null) }; };
  const get = async (u) => { const r = await fetch(B + u); return { code: r.status, j: await r.json().catch(() => null) }; };

  // ① POST full → 200 + 落盘；GET 回读同分
  const r1 = await post('/ai/review', { id: 'd1', mode: 'full' });
  assert.equal(r1.code, 200, 'POST /ai/review 应 200：' + JSON.stringify(r1.j).slice(0, 200));
  assert.ok(r1.j.ok && r1.j.report && r1.j.report.score === 71, '首次报告分=71（桩计数）');
  assert.equal(r1.j.prevScore, null, '首次无上次分');
  assert.equal(r1.j.saved, true, '首次应已落盘');
  let g = await get('/ai/review?id=d1');
  assert.ok(g.j.ok && g.j.last && g.j.last.score === 71, 'GET 回读 last.score=71');
  assert.equal(g.j.last.mode, 'full'); assert.equal(g.j.prevScore, null);

  // ② 第二次 POST（分更高）→ prevScore = 首次分
  const r2 = await post('/ai/review', { id: 'd1', mode: 'full' });
  assert.equal(r2.j.prevScore, 71, '第二次响应 prevScore 应=71');
  g = await get('/ai/review?id=d1');
  assert.equal(g.j.prevScore, 71, 'GET prevScore 应=71');

  // ③ 环形 ≤10：再跑 9 次（共 11 次）
  for (let i = 0; i < 9; i++) await post('/ai/review', { id: 'd1', mode: 'full' });
  assert.equal((meta().d1.reviewHist || []).length, 10, 'reviewHist 应截断到 10');

  // ④ target 透传与空值
  const rt = await post('/ai/review', { id: 'd1', mode: 'quant', target: '  后端开发  ' });
  assert.ok(rt.j.ok && rt.j.report, 'quant+target 应成功');
  assert.equal(lastHadTarget, true, '桩 user 应收到【目标方向】');
  const re = await post('/ai/review', { id: 'd1', mode: 'quant' });
  assert.equal(lastHadTarget, false, '空 target 的 user 不应含【目标方向】');

  // ⑤ 解析失败（reply）→ 不落盘（lastReview.score 仍是上一次分）
  const before = (meta().d1.lastReview || {}).score;
  badFlag = true;
  const rb = await post('/ai/review', { id: 'd1', mode: 'full' });
  badFlag = false;
  assert.ok(rb.j.ok && rb.j.reply && !rb.j.report, '坏输出应走 reply 路径');
  assert.equal((meta().d1.lastReview || {}).score, before, 'reply 路径不得覆盖 lastReview');
  assert.ok(sawTarget, '至少一次 target 被桩看见');

  // ⑥ 参数校验
  assert.equal((await get('/ai/review?id=bad id')).code, 400, '非法 id 应 400');
  assert.equal((await get('/ai/review?id=ghost')).code, 404, '不存在文档应 404');

  // ⑦ 多模型对比（2026-11-16）：同批 adopt:false 不盖 lastReview；adopt 选一份；GET runs=最新批；prevScore 按模型链
  const lastBefore = (meta().d1.lastReview || {});
  const mb1 = await post('/ai/review', { id: 'd1', mode: 'full', profile: 0, adopt: false, batch: 'bt1' });
  const mb2 = await post('/ai/review', { id: 'd1', mode: 'full', profile: 1, adopt: false, batch: 'bt1' });
  assert.ok(mb1.j.run && mb2.j.run, '多模型两次应各回 run');
  assert.equal(mb1.j.run.model, 'm'); assert.equal(mb2.j.run.model, 'mb');
  assert.equal(mb2.j.prevScore, null, 'B 档案首跑 prevScore 应为 null（按模型链）');
  assert.equal((meta().d1.lastReview || {}).score, lastBefore.score, 'adopt:false 不得覆盖 lastReview');
  const mb3 = await post('/ai/review', { id: 'd1', mode: 'full', profile: 1, adopt: false, batch: 'bt1' });
  assert.equal(mb3.j.prevScore, mb2.j.run.score, 'B 档案二跑 prevScore=其首跑分');
  g = await get('/ai/review?id=d1');
  assert.ok(Array.isArray(g.j.runs) && g.j.runs.length === 3, 'GET runs 应=最新批 3 条：' + JSON.stringify(g.j.runs).slice(0, 160));
  assert.equal(g.j.runs[0].batch, 'bt1');
  const ad = await post('/ai/review-adopt', { id: 'd1', batch: 'bt1', name: 'B', model: 'mb' });
  assert.ok(ad.j.ok && ad.j.last && ad.j.last.model === 'mb', 'adopt 后 lastReview 应为 B 档：' + JSON.stringify(ad.j).slice(0, 160));
  assert.equal((await post('/ai/review-adopt', { id: 'd1', batch: 'ghost', name: 'x', model: 'y' })).code, 404, '不存在的 run 应 404');
  assert.equal((await post('/ai/review', { id: 'd1', mode: 'full', profile: 2 })).code, 400, '不完整档案应 400');
  assert.equal((await post('/ai/review', { id: 'd1', mode: 'full', profile: 9 })).code, 400, '越界档案应 400');
  assert.equal((meta().d1.reviewRuns || []).length <= 12, true, 'reviewRuns 应 cap 12');
  console.log('✅ 体检持久化：POST 落盘+prevScore 链、GET 回读、环形≤10、target 透传、reply 不落盘、400/404 + 多模型 adopt/批次/分模型 prevScore');
} finally { cleanup(); }
