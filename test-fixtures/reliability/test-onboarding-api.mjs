// test-onboarding-api.mjs — S5 从零建简历向导·服务端（设计 dev-docs/2026-11-02-s5-design.md）
// 合同：
//   ① 空输入不产出脏文档：无文档首步空载荷 → 不建档（docs/ 零新增文件），响应 docId:null；
//   ② 逐步写档：每步确认写入同一份真实草稿文档（kind=master/flow=draft，与手建同权）；
//   ③ 跳步：合法（显式 skip 与空载荷等价），skipped 如实记录，被跳区域保持模板默认；
//   ④ 步序门：回退 409 / 未知步 400 / 非向导文档 409 / finished 后 409 / 坏 docId 400；
//   ⑤ 暂存退出重进恢复：GET /onboarding?docId= 渲染进度（data-ob-next），按 docId 续作成功；
//   ⑥ 预填只补缺失：prefillFrom 提取母版文本结构，payload 已填字段胜出，prefilled 如实登记，母版字节零改动；
//   ⑦ 产出文档 GET /edit 可开且含 DOC_ID；首页可见；0.6 照片存 photos/ 且带 Git 排除。
// HTTP 类夹具：隔离根 + 本机桩 LLM（零真实模型、零浏览器）。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-onb-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const docsCount = () => fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.html') && !f.startsWith('.')).length;

// —— 合成母版（预填来源）：直接落盘，与 gen-progress 夹具同款 ——
const SRC = 'srcmaster';
let src = assembleTemplate('classic');
for (const [k, v] of [
  ['{{NAME}}', '来源样例'], ['{{CONTACT}}', 'contact-synthetic-line'], ['{{INTENT}}', 'intent-synthetic'],
  ['{{SUMMARY}}', '来源画像摘要'], ['{{SKILLS}}', '<p>合成技能一</p><p>合成技能二</p>'],
  ['{{WORK}}', '<div class="entry-head"><div class="entry-title">合成公司</div><div class="entry-role">合成岗位</div><div class="entry-date">2024.01 - 2025.01</div></div><ul><li>负责合成模块开发</li></ul>'],
  ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', SRC]
]) src = src.replaceAll(k, () => v);
fs.writeFileSync(path.join(root, 'docs', SRC + '.html'), src);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [SRC]: { rev: 1, kind: 'master', flow: 'draft' }
}, null, 2));
const srcSnapshot = () => { const p = path.join(root, 'docs', SRC + '.html'); const st = fs.statSync(p); return st.size + ':' + st.mtimeMs; };
const srcBefore = srcSnapshot();

// —— 桩 LLM（向导 API 不调模型；桩只为隔离完整、防误配外联）——
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'stub' } }] }));
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
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { stub.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const base = `http://127.0.0.1:${port}`;

const stepPost = async (body) => {
  const r = await fetch(base + '/onboarding/step', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, ...d };
};
const getText = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const docHtml = (id) => fs.readFileSync(path.join(root, 'docs', id + '.html'), 'utf8');
const metaOf = (id) => JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'))[id] || {};
const sectionOf = (html, title) => {
  const m = html.match(new RegExp('<div class="section-title">' + title + '</div>([\\s\\S]*?)</section>'));
  return m ? m[1] : '';
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { if ((await fetch(base + '/')).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① 空输入不产出脏文档：无文档首步空载荷 → 不建档 =====
  const before = docsCount();
  const r1 = await stepPost({ step: '0.1', payload: {} });
  assert.equal(r1.status, 200, '空载荷首步应成功：' + JSON.stringify(r1));
  assert.equal(r1.ok, true, '空载荷首步 ok');
  assert.equal(r1.docId, null, '空载荷首步不得建档，实际 docId=' + r1.docId);
  assert.equal(r1.created, false, '空载荷首步 created=false');
  assert.equal(docsCount(), before, '空输入不得新增文档文件');
  assert.equal(r1.nextStep, '0.2', '空载荷后应指向下一步');
  const pg0 = await getText('/onboarding');
  assert.equal(pg0.status, 200, '向导页壳应 200');
  assert.ok(pg0.text.includes('data-ob'), '向导页壳应带向导标记（data-ob-*）');

  // ===== ② 逐步写档：0.1 → 0.2 → 0.3 各步落档 =====
  const r2 = await stepPost({ step: '0.1', payload: { name: '向导同学', contact: 'wizard-contact', intent: '后端开发' } });
  assert.equal(r2.status, 200, '0.1 确认应成功：' + JSON.stringify(r2));
  assert.ok(r2.ok && r2.created === true && r2.docId && VALID_ID.test(r2.docId), '0.1 应建档且 docId 合法');
  assert.equal(r2.nextStep, '0.2');
  const D1 = r2.docId;
  assert.ok(/<h1[^>]*>向导同学<\/h1>/.test(docHtml(D1)), '0.1 姓名应写入 header h1（zid 归一后标签可带 data-zid）');
  assert.equal(metaOf(D1).kind, 'master', '向导文档 kind=master（与手建同权）');
  assert.equal(metaOf(D1).flow, 'draft', '向导文档 flow=draft');
  assert.equal(metaOf(D1).onboarding.last, '0.1', '进度 last=0.1');

  const r3 = await stepPost({ step: '0.2', docId: D1, payload: { summary: '画像摘要内容' } });
  assert.equal(r3.status, 200, '0.2 确认应成功：' + JSON.stringify(r3));
  assert.equal(r3.nextStep, '0.3');
  assert.ok(sectionOf(docHtml(D1), '个人总结').includes('画像摘要内容'), '0.2 摘要应写入个人总结区域');
  assert.equal(metaOf(D1).onboarding.last, '0.2');

  const r4 = await stepPost({ step: '0.3', docId: D1, payload: { work: [{ title: '向导公司', role: '工程师', date: '2024.01 - 2025.01', points: ['负责向导模块'] }] } });
  assert.equal(r4.status, 200, '0.3 确认应成功：' + JSON.stringify(r4));
  assert.equal(r4.nextStep, '0.4');
  const workSec = sectionOf(docHtml(D1), '工作经历');
  assert.ok(workSec.includes('向导公司') && workSec.includes('负责向导模块') && workSec.includes('entry-head'),
    '0.3 经历应写入工作经历区域（entry 形状 + 内容，zid 归一后标签可带 data-zid）');

  // ===== ③ 跳步：0.1 后直取 0.3（跳过 0.2）=====
  const r5 = await stepPost({ step: '0.1', payload: { name: '跳步同学' } });
  const D2 = r5.docId;
  assert.ok(D2 && D2 !== D1, '第二次会话应独立建档');
  const r6 = await stepPost({ step: '0.3', docId: D2, payload: { work: [{ title: '跳步公司', role: '工程师', date: '2024.02 - 2025.02', points: ['负责跳步模块'] }] } });
  assert.equal(r6.status, 200, '跳过 0.2 直取 0.3 应合法：' + JSON.stringify(r6));
  assert.equal(r6.nextStep, '0.4');
  assert.ok((metaOf(D2).onboarding.skipped || []).includes('0.2'), 'skipped 应记录 0.2');
  assert.ok(sectionOf(docHtml(D2), '个人总结').includes('点击开始编辑'), '被跳区域应保持模板默认（不被写脏）');

  // ===== ④ 步序门 =====
  const back = await stepPost({ step: '0.2', docId: D2, payload: { summary: '回退尝试' } });
  assert.equal(back.status, 409, '回退步应 409，实际：' + back.status);
  assert.equal(back.ok, false, '回退步 ok=false');
  const badStep = await stepPost({ step: '0.9', payload: {} });
  assert.equal(badStep.status, 400, '未知步应 400');
  const notOb = await stepPost({ step: '0.1', payload: { name: 'x' }, docId: SRC });
  assert.equal(notOb.status, 409, '非向导文档（无 onboarding 记录）应 409，实际：' + notOb.status);
  const badId = await stepPost({ step: '0.1', payload: {}, docId: 'BAD_ID!' });
  assert.equal(badId.status, 400, '非法 docId 应 400');
  const missDoc = await stepPost({ step: '0.2', payload: { summary: 'x' }, docId: 'no-such-doc' });
  assert.equal(missDoc.status, 404, '不存在的 docId 应 404');

  // ===== ⑤ 暂存退出重进恢复：页壳渲染进度 + 按 docId 续作 =====
  const pg1 = await getText('/onboarding?docId=' + D2);
  assert.equal(pg1.status, 200, '带 docId 的向导页应 200');
  assert.ok(pg1.text.includes('data-ob-next="0.4"'), '页壳应渲染当前进度 0.4，实际缺失 data-ob-next="0.4"');
  const r7 = await stepPost({ step: '0.5', docId: D2, payload: { skills: '合成技能甲\n合成技能乙' } });
  assert.equal(r7.status, 200, '按 docId 续作 0.5 应成功：' + JSON.stringify(r7));
  assert.equal(r7.nextStep, '0.6');
  assert.ok(sectionOf(docHtml(D2), '专业技能').includes('合成技能甲') && sectionOf(docHtml(D2), '专业技能').includes('plain-lines'),
    '0.5 技能应逐行写入专业技能区域（plain-lines 外壳保留）');

  // ===== ⑥ 预填只补缺失 =====
  const r8 = await stepPost({ step: '0.1', payload: { name: '只补缺失同学' }, prefillFrom: SRC });
  assert.equal(r8.status, 200, '预填首步应成功：' + JSON.stringify(r8));
  const D3 = r8.docId;
  assert.ok(D3, '预填产生内容 → 应建档');
  assert.ok(Array.isArray(r8.prefilled) && r8.prefilled.includes('contact') && r8.prefilled.includes('intent'),
    'prefilled 应如实登记母版带入的 contact/intent，实际：' + JSON.stringify(r8.prefilled));
  assert.ok(!r8.prefilled.includes('name'), 'payload 已填的 name 不应计入 prefilled（只补缺失）');
  const d3 = docHtml(D3);
  assert.ok(/<h1[^>]*>只补缺失同学<\/h1>/.test(d3), 'payload 已填字段应胜出');
  assert.ok(d3.includes('contact-synthetic-line') && d3.includes('intent-synthetic'), '空缺位应由母版填充');

  const r9 = await stepPost({ step: '0.2', docId: D3, skip: true });
  assert.equal(r9.status, 200, '显式 skip 应合法：' + JSON.stringify(r9));
  assert.ok((metaOf(D3).onboarding.skipped || []).includes('0.2'), '显式 skip 应记入 skipped');

  const missSrc = await stepPost({ step: '0.5', docId: D3, prefillFrom: 'no-such-src' });
  assert.equal(missSrc.status, 404, '预填来源不存在应 404');

  const r10 = await stepPost({ step: '0.5', docId: D3, prefillFrom: SRC, payload: {} });
  assert.equal(r10.status, 200, '0.5 预填应成功：' + JSON.stringify(r10));
  assert.ok((r10.prefilled || []).includes('skills'), '0.5 应登记母版带入的 skills');
  assert.ok(sectionOf(docHtml(D3), '专业技能').includes('合成技能一'), '母版技能应写入新文档专业技能区域');
  assert.equal(srcSnapshot(), srcBefore, '预填全程母版字节与 mtime 零改动');

  // ===== 0.6 照片：存 photos/ + Git 排除（可选步的真实存储）=====
  const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r11 = await stepPost({ step: '0.6', docId: D3, payload: { photo: PNG1x1 } });
  assert.equal(r11.status, 200, '0.6 照片应成功：' + JSON.stringify(r11));
  const photoDir = path.join(root, 'photos');
  assert.ok(fs.existsSync(path.join(photoDir, D3 + '.png')), '照片应存入用户数据目录 photos/');
  assert.ok(fs.existsSync(path.join(photoDir, '.gitignore')), 'photos/ 应自带 .gitignore（排除 Git，不改仓库 .gitignore）');
  const gi = fs.readFileSync(path.join(photoDir, '.gitignore'), 'utf8');
  assert.ok(gi.split('\n').map((s) => s.trim()).includes('*'), 'photos/.gitignore 应忽略全部内容');

  // ===== ⑦ 产出文档同权：0.8 收口 → /edit 可开且有 DOC_ID；首页可见 =====
  const r12 = await stepPost({ step: '0.8', docId: D3 });
  assert.equal(r12.status, 200, '0.8 收口应成功：' + JSON.stringify(r12));
  assert.equal(r12.nextStep, null, '0.8 后 nextStep=null');
  assert.equal(r12.editUrl, '/edit?id=' + D3, '0.8 响应应带 editUrl');
  const after = await stepPost({ step: '0.8', docId: D3 });
  assert.equal(after.status, 409, 'finished 后再步进应 409');
  const ed = await getText('/edit?id=' + D3);
  assert.equal(ed.status, 200, '产出文档 /edit 应可开');
  assert.ok(ed.text.includes("var DOC_ID = '" + D3 + "'"), '/edit 页面应带真实 DOC_ID');
  const home = await getText('/');
  assert.ok(home.text.includes(D3), '产出文档应出现在首页列表（同权可见）');

  console.log('✅ S5 向导服务端：空输入不建档、逐步写档、跳步、步序门、docId 续作、预填只补缺失、产出文档与手建同权（/edit + DOC_ID + 首页）、照片入 photos/ 带 Git 排除');
} finally {
  cleanup();
}
