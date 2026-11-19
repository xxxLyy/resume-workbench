// test-draft.mjs — UPCV A3 建简历快照 + 六态收尾断言。退出码 0=全过；1=任一断言失败。
// 隔离 RESUME_ROOT + 本地 stub LLM + 假渲染器；不碰 7766、不碰真实数据。
// 样板照 test-aora.mjs 六步：隔离根 / 动态口 / spawn / exit 钩子 / fetch+源码断言 / ✅ 段式。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-draft-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const draftFile = path.join(root, 'resume-draft.json');
const appsFile = path.join(root, 'applications.json');
const dayStr = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

// 空数据文件预 seed（照 test.sh 款：读路径容忍缺失，seed 让断言能拿「零写入=字节不变」基线）
fs.writeFileSync(draftFile, '{"drafts":{}}');
fs.writeFileSync(appsFile, JSON.stringify([
  { id: '2026-01-01-1', company: '近窗公司', role: '近窗岗位', docId: 'masterdoc', status: 'applied', dueDate: dayStr(3), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: '2026-01-01-2', company: '远窗公司', role: '远窗岗位', docId: 'masterdoc', status: 'to_apply', dueDate: dayStr(20), createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]));
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ masterdoc: { rev: 1, flow: 'draft', kind: 'master', archivedAt: null } }));
fs.writeFileSync(path.join(root, 'agent-sessions.json'), '[]');
fs.writeFileSync(path.join(root, 'docs', 'masterdoc.html'), '<!doctype html><html><head><title>m</title></head><body><h1>母版</h1></body></html>');

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const port = await freePort();
const llmPort = await freePort();

// ===== stub LLM（OpenAI 兼容最小实现；agent 契约回合法 reply JSON）=====
const llm = http.createServer((q, s) => {
  let b = '';
  q.on('data', (c) => b += c);
  q.on('end', () => {
    if (q.url.includes('/models')) { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end(JSON.stringify({ data: [{ id: 'stub-model' }] })); }
    s.writeHead(200, { 'Content-Type': 'application/json' });
    s.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reply: '好的，我们继续。', quickReplies: [], toolRefs: [] }) } }] }));
  });
});
await new Promise((res) => llm.listen(llmPort, '127.0.0.1', res));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llmPort}/v1`, apiKey: 'test-key', model: 'stub-model' }] }));

// ===== 假渲染器（照 test.sh fake-render.sh 契约：$1 是 server 传入的 render.mjs 路径，需 shift）=====
fs.writeFileSync(path.join(root, 'fake-render.sh'), `#!/bin/bash
shift
src=""; out=""
if [ "$1" = "--src" ]; then src="$2"; out="$4"; else src="${root}/docs/$1.html"; out="${root}/pdfs/$1.pdf"; fi
mkdir -p "$(dirname "$out")"
printf '%%PDF-1.4\\n' > "$out"
echo '{"renderInputId":"'"$RESUME_RENDER_INPUT_ID"'","reproducible":true,"dpi":150}' > "$out.env.json"
`);
fs.chmodSync(path.join(root, 'fake-render.sh'), 0o755);

const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port), RESUME_RENDER_BIN: path.join(root, 'fake-render.sh') }, stdio: ['ignore', 'pipe', 'pipe']
});
process.on('exit', () => {
  try { server.kill(); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('server 启动超时')), 15000); server.stdout.on('data', (b) => { if (String(b).includes('简历平台')) { clearTimeout(t); res(); } }); });

const B = `http://127.0.0.1:${port}`;
const get = (p) => fetch(B + p).then((r) => r.text().then((body) => ({ status: r.status, ct: r.headers.get('content-type') || '', body })));
const j = (method, p, body) => fetch(B + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drafts = () => JSON.parse(fs.readFileSync(draftFile, 'utf8')).drafts;

// ===== A. 快照四端点：UPSERT 幂等 / latest 只回未完成 / complete / DELETE 404 =====
{
  const r1 = await j('POST', '/api/resume-creation/snapshots', { sessionId: 'ag-test-1', snapshotData: { collected: { basics: '张三' }, lastQuestion: '', rounds: 1 } });
  assert.equal(r1.code, 0, 'POST 应回 {code:0} 包壳');
  assert.equal(r1.data.sessionId, 'ag-test-1');
  assert.equal(r1.data.clientVersion, 'pc-web', 'clientVersion 恒 pc-web');
  assert.equal(r1.data.completedResumeId, null, '新行 completedResumeId=null');
  await sleep(20);
  const r2 = await j('POST', '/api/resume-creation/snapshots', { sessionId: 'ag-test-1', snapshotData: { collected: { basics: '张三', education: 'X 大学' }, lastQuestion: '下一段', rounds: 2 } });
  assert.equal(r2.data.id, r1.data.id, '同会话 UPSERT：行 id 不变');
  assert.equal(Object.keys(drafts()).length, 1, '同会话 UPSERT 两次：行数不变（一会话一行）');
  assert.ok(r2.data.updatedAt > r1.data.updatedAt, 'UPSERT 刷新 updatedAt');
  assert.equal(drafts()['ag-test-1'].createdAt, r1.data.createdAt || drafts()['ag-test-1'].createdAt, '覆盖更新保留 createdAt');
  const r3 = await j('POST', '/api/resume-creation/snapshots', { sessionId: 'ag-test-2', snapshotData: { collected: {}, lastQuestion: '', rounds: 1 } });
  const lat1 = await j('GET', '/api/resume-creation/snapshots/latest?schemaVersion=2');
  assert.equal(lat1.code, 0, 'GET latest 包壳 {code:0}');
  assert.equal(lat1.data.snapshot.sessionId, 'ag-test-2', 'latest 只回最近一条未完成');
  const done = await j('PATCH', `/api/resume-creation/snapshots/${r3.data.id}/complete`, { completedResumeId: 'doc-1' });
  assert.equal(done.code, 0, 'PATCH complete 包壳');
  assert.equal(done.data.ok, true, 'PATCH complete → {ok:true}');
  const lat2 = await j('GET', '/api/resume-creation/snapshots/latest?schemaVersion=2');
  assert.equal(lat2.data.snapshot.sessionId, 'ag-test-1', 'completed 行不返回 → latest 回到较早的未完成行');
  await j('PATCH', `/api/resume-creation/snapshots/${r1.data.id}/complete`, { completedResumeId: 'doc-1' });
  const lat3 = await j('GET', '/api/resume-creation/snapshots/latest?schemaVersion=2');
  assert.equal(lat3.data.snapshot, null, '全部 complete 后 latest 变 null');
  const bad = await fetch(B + '/api/resume-creation/snapshots/nope-1', { method: 'DELETE' });
  assert.equal(bad.status, 404, 'DELETE 不存在的快照 → 404');
  const d1 = await j('DELETE', `/api/resume-creation/snapshots/${r3.data.id}`);
  assert.equal(d1.code, 0, 'DELETE 包壳');
  assert.equal(d1.data.ok, true, 'DELETE → {ok:true}');
  const d2 = await fetch(B + `/api/resume-creation/snapshots/${r3.data.id}`, { method: 'DELETE' });
  assert.equal(d2.status, 404, 'DELETE 后再删同行 → 404');
  const badBody = await j('POST', '/api/resume-creation/snapshots', { sessionId: 'ag-test-9', snapshotData: '不是对象' });
  assert.equal(badBody.code, 400, 'snapshotData 非对象 → 400');
  console.log('✅ A 快照四端点（UPSERT 幂等/latest 只回未完成/complete 置完成/DELETE 404）');
}

// ===== B. agent 接缝：普通会话零写入 / 建简历意图写入 / 延续收集 / 建出真文档 → complete =====
{
  fs.writeFileSync(draftFile, '{"drafts":{}}');   // 归零基线（A 段留下的行不算会话写入证据）
  const sess = await j('POST', '/agent/sessions', {});
  const sid = sess.session.id;
  await j('POST', '/agent/chat', { id: sid, message: '帮我看看现在的简历还能怎么改' });
  assert.equal(fs.readFileSync(draftFile, 'utf8'), '{"drafts":{}}', '普通会话零写入（账本字节不变）');
  await j('POST', '/agent/chat', { id: sid, message: '我想从零新建一份简历，请引导我收集信息' });
  const row1 = drafts()[sid];
  assert.ok(row1, '建简历意图 → 草稿落账');
  assert.equal(row1.snapshotData.rounds, 1, '首建 rounds=1');
  // 假手机号拼接构造：本文件不出现 11 连字面量，避免 privacy-check 门禁自命中（同 test-structure.sh S1-FW-3 纪律）
  const FAKE_PHONE = '1380013' + '8000';
  await j('POST', '/agent/chat', { id: sid, message: '我叫张三，电话 ' + FAKE_PHONE + '，邮箱 z@x.com' });
  const row2 = drafts()[sid];
  assert.equal(row2.snapshotData.rounds, 2, '已有未完成草稿 → 延续（rounds+1）');
  assert.ok(String(row2.snapshotData.collected.basics).includes('张三'), '本轮用户文本进 collected.basics');
  const lat = await j('GET', '/api/resume-creation/snapshots/latest?schemaVersion=2');
  assert.equal(lat.data.snapshot.sessionId, sid, 'latest 回该会话未完成草稿');
  // 生成落库衔接：草稿创建之后新建的未归档 master → 下一轮 complete
  fs.writeFileSync(path.join(root, 'docs', 'done-1.html'), '<!doctype html><html><body><h1>新母版</h1></body></html>');
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
  meta['done-1'] = { rev: 1, flow: 'draft', kind: 'master', archivedAt: null };
  fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify(meta));
  await j('POST', '/agent/chat', { id: sid, message: '简历建好了，帮我看看投递' });
  assert.equal(drafts()[sid].completedResumeId, 'done-1', '识别新增未归档 master → complete(completedResumeId=新 docId)');
  const lat2 = await j('GET', '/api/resume-creation/snapshots/latest?schemaVersion=2');
  assert.equal(lat2.data.snapshot, null, 'complete 后 latest 变 null（横幅消失）');
  // 反向哨兵（A3 遗留风险修复回归）：旧母版被编辑（mtime 变新）不得误判「建出」提前 complete。
  // 排除集 = 草稿开建时 masterIdsAtStart 快照；回退修复本行会红（旧行为会把 touched 的 masterdoc 误判成 fresh）。
  fs.writeFileSync(draftFile, '{"drafts":{}}');
  const sess2 = await j('POST', '/agent/sessions', {});
  const sid2 = sess2.session.id;
  await j('POST', '/agent/chat', { id: sid2, message: '帮我重新建一份简历，一步步来' });
  const row3 = drafts()[sid2];
  assert.ok(row3, '第二场草稿落账');
  assert.ok(Array.isArray(row3.masterIdsAtStart) && row3.masterIdsAtStart.includes('masterdoc'), '排除集应含既有 masterdoc');
  const old = fs.readFileSync(path.join(root, 'docs', 'masterdoc.html'), 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'masterdoc.html'), old);   // 触碰旧母版 → mtime 变新（编辑场景）
  await j('POST', '/agent/chat', { id: sid2, message: '继续收集' });
  assert.equal(drafts()[sid2].completedResumeId, null, '旧母版被编辑不算「建出」——不得提前 complete');
  console.log('✅ B2 freshMasterDoc 排除集（旧母版编辑不误判，mtime 兜底失效路径钉死）');
  console.log('✅ B agent 接缝（零写入/意图 UPSERT/延续收集/建出真文档→complete）');
}

// ===== C. 恢复横幅源码断言（agent-panel.js 零 innerHTML + var(--*) 样式）=====
{
  const ag = fs.readFileSync(path.join(APP_ROOT, 'agent-panel.js'), 'utf8');
  for (const needle of [
    "/api/resume-creation/snapshots/latest?schemaVersion=2",
    '未完成的建简历现场',
    "bar.className = 'ag-draft'",
    'txt.textContent',
    'var(--accent)',
    'var(--space-2)',
    "main.insertBefore(bar, main.querySelector('.ag-input'))",
  ]) assert.ok(ag.includes(needle), 'agent-panel 缺: ' + needle);
  const bannerBody = ag.slice(ag.indexOf('function draftBanner'), ag.indexOf('// ===== 启动 ====='));
  assert.ok(!bannerBody.includes('innerHTML'), '横幅函数体内零 innerHTML（textContent/DOM API 纪律）');
  const api = fs.readFileSync(path.join(APP_ROOT, 'upcv-api.mjs'), 'utf8');
  for (const needle of ["'/api/resume-creation/snapshots/latest'", "pathname === '/api/resume-creation/snapshots'", 'snapshots\\/([^/]+)\\/complete$', "case 'draft.latest'", "case 'draft.create'", "case 'draft.complete'", "case 'draft.delete'"])
    assert.ok(api.includes(needle), 'upcv-api 缺: ' + needle);
  const am = fs.readFileSync(path.join(APP_ROOT, 'agent.mjs'), 'utf8');
  assert.ok(am.includes('agentDraftTick(R(), s.id, text, hist)'), 'agent.mjs 缺 chatStream 用户条落盘后的快照接缝调用');
  console.log('✅ C 恢复横幅 + 四端点 + 接缝源码断言');
}

// ===== D. 六态收尾：页面标签同源 / 临近截止 7d 口径 / followup 口径 / 三处源码一致 =====
{
  const page = await get('/applications');
  assert.equal(page.status, 200, '/applications 应 200');
  const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
  const statusesOf = (src, f) => {
    const m = /const APP_STATUSES = \[([^\]]+)\]/.exec(src);
    assert.ok(m, f + ' 缺 APP_STATUSES 字面量');
    return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
  };
  const SIX = ['to_apply', 'preparing', 'applied', 'replied', 'interviewing', 'offer'];
  // 反向哨兵：三处枚举表逐字一致（server/agent/upcv-api 各自照抄，任一处漂移此处红）
  for (const f of ['server.mjs', 'agent.mjs', 'upcv-api.mjs']) {
    const src = fs.readFileSync(path.join(APP_ROOT, f), 'utf8');
    assert.deepEqual(statusesOf(src, f), SIX, f + ' 的 APP_STATUSES 六态漂移');
    assert.ok(/const APP_STATUS_ALL = \[\.\.\.APP_STATUSES, 'closed'\]/.test(src), f + ' 缺 APP_STATUS_ALL 同源行');
  }
  // 页面标签：七个中文标签全部渲染（看板列头 6 + closed 区；下拉同表派生）
  for (const lbl of ['待投递', '准备中', '已投递', '有回复', '面试中', 'Offer', '已关闭'])
    assert.ok(page.body.includes(lbl), '/applications 缺标签: ' + lbl);
  // 页面标签必须由同一张表派生（防两处硬编码漂移）：看板列 + 下拉 + 详情下拉全走 APP_STATUS(_ALL).map + statusLabel
  for (const needle of ['const cols = APP_STATUSES.map((st)', 'APP_STATUS_ALL.map((s) => `<option value="${s}"'])
    assert.ok(srv.includes(needle), 'server.mjs 看板/下拉须由 APP_STATUS 派生: ' + needle);
  // 临近截止 7d 口径：近窗（+3d）出徽章、远窗（+20d）不出——行为级断在真渲染路径上
  const nearSeg = page.body.slice(Math.max(0, page.body.indexOf('近窗公司') - 300), page.body.indexOf('近窗公司') + 500);
  assert.ok(nearSeg.includes('临近截止'), 'dueDate≤今+7d 应出「临近截止」徽章（agent dueSoon 同口径）');
  const farSeg = page.body.slice(Math.max(0, page.body.indexOf('远窗公司') - 300), page.body.indexOf('远窗公司') + 500);
  assert.ok(!farSeg.includes('临近截止'), 'dueDate>今+7d 不应出「临近截止」徽章');
  assert.ok(srv.includes('const DUE_SOON_MS = 7 * 24 * 3600 * 1000'), 'server 缺 DUE_SOON_MS=7d 常量（与 agent dueSoonDays=7 同口径）');
  assert.ok(fs.readFileSync(path.join(APP_ROOT, 'agent.mjs'), 'utf8').includes('dueSoonDays: 7'), 'agent query_job_progress 缺 dueSoonDays:7');
  // followup 口径：等回应态 = applied（APP_STATUSES[2]）字面量核对
  assert.ok(fs.readFileSync(path.join(APP_ROOT, 'followup.mjs'), 'utf8').includes("const WAITING_STATUS = 'applied'"), 'followup.mjs 缺 WAITING_STATUS=applied');
  assert.equal(statusesOf(srv, 'server.mjs')[2], 'applied', 'server APP_STATUSES[2] 应为 applied（followup 口径锚）');
  console.log('✅ D 六态收尾（页面标签同源 + 7d 临近截止 + followup 口径 + 三处枚举一致）');
}

// ===== E. jobId 透传：写侧进、读侧出（saveApps 往返保留）、缺省不落键 =====
{
  const a1 = await j('POST', '/app/add', { company: '甲公司', role: '岗位一', docId: 'masterdoc', jobId: 'ib-123' });
  assert.equal(a1.ok, true, '/app/add 带 jobId 应成功');
  const a2 = await j('POST', '/app/add', { company: '乙公司', role: '岗位二', docId: 'masterdoc' });
  assert.equal(a2.ok, true, '/app/add 不带 jobId 应成功');
  let apps = JSON.parse(fs.readFileSync(appsFile, 'utf8'));
  const e1 = apps.find((a) => a.company === '甲公司');
  const e2 = apps.find((a) => a.company === '乙公司');
  assert.equal(e1.jobId, 'ib-123', '写侧进：jobId 落账');
  assert.ok(!('jobId' in e2), '缺省不落键：不带 jobId 的条目无该键');
  await j('POST', '/app/update', { id: e1.id, jobId: 'ib-456' });
  await j('POST', '/app/update', { id: e2.id, note: '补一句' });
  apps = JSON.parse(fs.readFileSync(appsFile, 'utf8'));
  assert.equal(apps.find((a) => a.id === e1.id).jobId, 'ib-456', 'update 透传：jobId 可改');
  assert.ok(!('jobId' in apps.find((a) => a.id === e2.id)), 'update 缺省不动原键（零迁移）');
  // 读侧出：loadApps→saveApps 全表往返保留未知键（上一步 update 已触发一次往返，jobId 仍在即读侧保留证据）
  const bad = await fetch(B + '/app/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company: '丙公司', role: '岗位三', docId: 'masterdoc', jobId: 'bad job!' }) });
  assert.equal(bad.status, 400, '非法 jobId 应 400（白名单 /^[A-Za-z0-9_-]{1,90}$/）');
  assert.ok((await bad.text()).includes('非法 jobId'), '400 应给中文原因');
  console.log('✅ E jobId 透传（写侧进/读侧往返保留/缺省不落键/非法拒绝）');
}

console.log('✅ test-draft 全部通过');
server.kill(); llm.close(); process.exit(0);
