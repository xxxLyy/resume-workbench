// test-share-copy.mjs — 分享副本（批 3 · 卡片 b3c5）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4 批 3「S8 网申包 + 跟进助手」（分享副本条目）。
// 合同：
//   ① 勾选隐藏字段 → 独立预览/PDF：POST /share/copy {docId, hidden, appId?} 产出**独立** PDF
//      （pdfs/shares/<shareId>.pdf + 旁车成对），原简历零改动（docs/<id>.html 与 docs-meta.json 逐字节不变、
//      pdfs/<id>.pdf 不出现、不写任何渲染记账）；GET /share/pdf?id= 伺服该独立产物。
//   ② 导出前文本层校验（批 2 能力复用：pdftotext + 去空白比对）：被隐藏字段的原文只要在副本 PDF
//      文本层还出现（哪怕在正文别处）→ 整体拒绝（409），不落记录、不落产物（fail-honest）。
//      隐藏 = 物理删除（h1 / 联系方式块内摘除 / 整章节移除），副本文件里不存在隐藏载荷。
//   ③ 导出记录可查被哪些投递引用：账本 apply-profiles.json 新增 shares 段（同表，迁移不丢既有数据）；
//      /apply-profile 页「分享副本」卡列出每份记录（隐藏了什么/打开 PDF/投递引用），
//      投递引用**实时派生自 applications.json（权威来源，绝不存储）**——app.shareId === share.id。
//      关联动作 = 创建分享副本时带 appId（写 app.shareId）；未关联的记录如实显示「投递引用：无」。
//   ④ 形状守卫：hidden 非数组/为空/含未知或不可隐藏字段 → 400；docId 非法 → 400、不存在 → 404；
//      appId 不存在 → 404 且**不产生任何部分产物**；GET /share/pdf 形状错 → 400、未知 → 404。
//   ⑤ 勾选了原简历里不存在的字段 → 200 如实回报 absent（未隐藏任何内容），不静默假装隐藏了。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档与投递；不读真实数据、不碰 7766、仓库零写入。
// 隐私门禁：合成数据不含 1[3-9]\d{9} 形态的 11 位长数字（电话用座机号，邮箱用 example.invalid）；
//            夹具内不写 13 位时间戳（长数字第二位避开 3-9）。
// 退出码契约：0=全部通过；1=任一断言失败；2=仅 Chromium 不可用且此前无失败（浏览器段跳过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const squash = (t) => String(t == null ? '' : t).replace(/\s+/g, '');

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-sharecopy-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};

// —— 合成母版简历（分享副本的来源）——
const MASTER = 'sharemaster';
const entry = (title, role, date, bullet) =>
  `<div class="entry-head"><div class="entry-title">${title}</div><div class="entry-role">${role}</div><div class="entry-date">${date}</div></div>\n<ul>\n<li>${bullet}</li>\n</ul>`;
const mkMaster = (over = {}) => {
  let doc = assembleTemplate('classic');
  const map = Object.assign({
    '{{NAME}}': '合成姓名',
    '{{CONTACT}}': '座机：021-5555-6666 邮箱：tester@example.invalid',
    '{{INTENT}}': '后端工程师',
    '{{SUMMARY}}': '<p>合成自评：做过合成交易系统与合成风控。</p>',
    '{{SKILLS}}': '<p><strong>语言：</strong>Go / Python</p>',
    '{{WORK}}': entry('合成公司', '后端工程师', '2021-03', '负责合成交易系统，把合成延迟压到 80ms'),
    '{{PROJECTS}}': '<p>项目一：合成数据管道重设计</p>',
    '{{EDU}}': entry('合成大学', '计算机', '2017-06', ''),
    '{{DOC_ID}}': MASTER,
  }, over);
  for (const [k, v] of Object.entries(map)) doc = doc.replaceAll(k, () => v);
  return doc;
};

// 合成文档：
//   MASTER   全字段齐全（联系方式块含座机与邮箱）
//   DOC_C    正文里多一处座机号（残留场景：联系方式块摘不干净 → 文本层校验必须拒绝）
//   DOC_B    无邮箱、无任何章节（absent 场景：勾选了简历里没有的字段）
const DOC_C = mkMaster({ '{{SKILLS}}': '<p><strong>语言：</strong>Go / Python；联系电话 021-5555-6666</p>' });
const DOC_B = mkMaster({
  '{{CONTACT}}': '座机：021-5555-6677',
  '{{SUMMARY}}': '', '{{SKILLS}}': '', '{{WORK}}': '', '{{PROJECTS}}': '', '{{EDU}}': '',
});

const DOCS = { [MASTER]: mkMaster(), sharec: DOC_C, shareb: DOC_B };
const DOC_IDS = { master: MASTER, c: 'sharec', b: 'shareb' };

// —— 合成投递记录（引用方）——
const APP_IDS = { a1: '2026-02-01-000000-001', a2: '2026-02-02-000000-002' };
const mkApp = (id, over = {}) => Object.assign({
  id, company: '甲公司', role: '合成岗位', docId: MASTER, jd: '', note: '',
  channel: '官网', link: '', appliedAt: '', nextStep: '', dueDate: '',
  snapTs: '', exportId: null, contentHash: '', status: '已投递',
  createdAt: id, updatedAt: id, interviews: [],
}, over);

const root = mkRoot('main');
const cleanupAll = () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };

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
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, ctype: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '', text: buf.toString('utf8'), buf };
};
const postJson = async (base, p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const ledger = (r) => JSON.parse(fs.readFileSync(path.join(r, 'apply-profiles.json'), 'utf8'));
const appsOnDisk = (r) => JSON.parse(fs.readFileSync(path.join(r, 'applications.json'), 'utf8'));
const appOnDisk = (r, id) => (appsOnDisk(r).find((a) => a.id === id) || null);
const sharesDir = (r) => path.join(r, 'pdfs', 'shares');
const shareArtifacts = (r) => {
  try { return fs.readdirSync(sharesDir(r)).filter((n) => !n.startsWith('.tmp-')).sort(); } catch { return []; }
};
// 夹具侧独立校验：自己跑 pdftotext 读产物文本层（不信任服务端内部校验，验收的是磁盘上那份 PDF）
const pdfLayer = (buf) => {
  const f = path.join(os.tmpdir(), 'sharecopy-fixture-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.pdf');
  try {
    fs.writeFileSync(f, buf);
    return execFileSync('pdftotext', [f, '-'], { timeout: 30000 }).toString('utf8');
  } finally { try { fs.unlinkSync(f); } catch {} }
};

let server = null;
try {
  // —— 铺数据 ——
  for (const [id, html] of Object.entries(DOCS)) fs.writeFileSync(path.join(root, 'docs', id + '.html'), html);
  fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [MASTER]: { rev: 1, flow: 'draft' } }, null, 2));
  fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([mkApp(APP_IDS.a1, { company: '甲公司' }), mkApp(APP_IDS.a2, { company: '乙公司' })], null, 2));
  // 预置一份「旧形状」账本（无 shares 键 + 一个既有字段包）：迁移不得丢既有数据
  fs.writeFileSync(path.join(root, 'apply-profiles.json'), JSON.stringify({
    version: 1, updatedAt: '',
    common: { sourceDocId: MASTER, fields: {} },
    packages: { 'pkg-syn-1': { company: '甲公司', role: '合成岗位', note: '', sourceDocId: '', fields: {} } },
  }, null, 2));
  const metaBefore = fs.readFileSync(path.join(root, 'docs-meta.json'));
  const docBytesBefore = {};
  for (const [id, html] of Object.entries(DOCS)) docBytesBefore[id] = Buffer.from(html);

  server = await startServer(root);
  const base = server.base;

  // ===== ① 勾选隐藏联系方式 → 独立 PDF：文本层确无残留；原简历零改动 =====
  let shareA = '';
  {
    const before = shareArtifacts(root).length;
    const r = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: ['name', 'phone', 'email'] });
    assert.equal(r.status, 200, '分享副本导出应 200，实际 ' + r.status + ' ' + r.text.slice(0, 300));
    assert.ok(r.json && r.json.shareId, '应返回 shareId，实际：' + r.text.slice(0, 300));
    assert.ok(r.json.url === '/share/pdf?id=' + encodeURIComponent(r.json.shareId), '应返回独立产物 URL');
    assert.deepEqual(r.json.absent, [], '母版三字段都在，不应报 absent');
    shareA = r.json.shareId;
    // 独立产物：成对落盘 + 可经 /share/pdf 伺服
    const artifacts = shareArtifacts(root);
    assert.equal(artifacts.length, before + 2, '应恰好新增 PDF + 旁车两个产物，实际：' + JSON.stringify(artifacts));
    assert.ok(artifacts.includes(shareA + '.pdf') && artifacts.includes(shareA + '.pdf.env.json'), '产物应按 shareId 命名且成对');
    const pdf = await get(base, '/share/pdf?id=' + encodeURIComponent(shareA));
    assert.equal(pdf.status, 200, 'GET /share/pdf 应 200，实际 ' + pdf.status);
    assert.ok(pdf.buf.slice(0, 5).toString() === '%PDF-', '响应应是 PDF 内容');
    assert.ok(/application\/pdf/.test(pdf.ctype), 'Content-Type 应是 application/pdf，实际：' + pdf.ctype);
    assert.ok(/inline/.test(pdf.disp), '预览应 inline 伺服（独立预览，不动原简历的任何产物），实际：' + pdf.disp);
    const layer = squash(pdfLayer(pdf.buf));
    assert.ok(!layer.includes('合成姓名'), '文本层不得残留姓名，实际片段：' + layer.slice(0, 200));
    assert.ok(!layer.includes('021-5555-6666'), '文本层不得残留电话，实际片段：' + layer.slice(0, 200));
    assert.ok(!layer.includes('tester@example.invalid'), '文本层不得残留邮箱，实际片段：' + layer.slice(0, 200));
    assert.ok(layer.includes('Go/Python') || layer.includes('Go / Python'), '未勾选的内容应保留（技能段），实际片段：' + layer.slice(0, 300));
    // 不动原简历：docs 字节不变、docs-meta 逐字节不变、共享 pdfs/<id>.pdf 不出现
    for (const [id] of Object.entries(DOCS)) {
      assert.ok(docBytesBefore[id].equals(fs.readFileSync(path.join(root, 'docs', id + '.html'))), '原简历 ' + id + '.html 必须逐字节不变');
    }
    assert.ok(metaBefore.equals(fs.readFileSync(path.join(root, 'docs-meta.json'))), 'docs-meta.json 必须逐字节不变（不写任何渲染记账）');
    assert.ok(!fs.existsSync(path.join(root, 'pdfs', MASTER + '.pdf')), '不得生成/触碰共享便利文件 pdfs/<id>.pdf');
    // 账本：shares 段记录 + 迁移不丢既有字段包
    const led = ledger(root);
    assert.ok(led.shares && led.shares[shareA], '账本应有 shares 记录');
    assert.deepEqual(led.shares[shareA].hidden, ['name', 'phone', 'email'], '记录应记下隐藏了哪些字段');
    assert.equal(led.shares[shareA].docId, MASTER, '记录应记下来源简历');
    assert.ok(led.packages && led.packages['pkg-syn-1'], 'shares 迁移不得丢既有字段包（旧形状账本兼容）');
  }

  // ===== ② 残留门（fail-honest）：正文里还有一处座机号 → 409，零记录零产物 =====
  {
    const before = shareArtifacts(root).length;
    const ledBefore = Object.keys(ledger(root).shares || {}).length;
    const r = await postJson(base, '/share/copy', { docId: DOC_IDS.c, hidden: ['phone'] });
    assert.equal(r.status, 409, '正文残留座机号时导出应被整体拒绝（409），实际 ' + r.status + ' ' + r.text.slice(0, 300));
    assert.ok(String((r.json && r.json.error) || '').includes('电话'), '拒绝原因应点名字段（电话），实际：' + r.text.slice(0, 300));
    assert.ok(String((r.json && r.json.error) || '').includes('残留'), '拒绝原因应说明是残留校验，实际：' + r.text.slice(0, 300));
    assert.equal(shareArtifacts(root).length, before, '被拒导出不得留下任何产物文件');
    assert.equal(Object.keys(ledger(root).shares || {}).length, ledBefore, '被拒导出不得写导出记录');
    // 对照：同一份文档勾选不冲突的字段（姓名）→ 正常导出
    const ok = await postJson(base, '/share/copy', { docId: DOC_IDS.c, hidden: ['name'] });
    assert.equal(ok.status, 200, '同一文档只勾姓名（正文无姓名）应正常导出，实际 ' + ok.status + ' ' + ok.text.slice(0, 200));
    assert.deepEqual(ok.json.absent, [], 'DOC_C 有姓名，不应报 absent');
  }

  // ===== ③ 章节隐藏 + 导出记录可查被哪些投递引用（引用实时派生自 applications.json） =====
  let shareC = '', shareD = '';
  {
    const r = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: ['work'], appId: APP_IDS.a1 });
    assert.equal(r.status, 200, '隐藏整章节应 200，实际 ' + r.status + ' ' + r.text.slice(0, 300));
    shareC = r.json.shareId;
    const pdf = await get(base, '/share/pdf?id=' + encodeURIComponent(shareC));
    const layer = squash(pdfLayer(pdf.buf));
    assert.ok(!layer.includes('工作经历'), '工作经历章节（含标题）应整体移除，实际片段：' + layer.slice(0, 300));
    // 探针用工作经历独有的字符串（「合成交易系统」在自评里也出现，不能当章节移除的判据）
    assert.ok(!layer.includes('合成延迟'), '章节正文应移除（工作经历独有的句子），实际片段：' + layer.slice(0, 300));
    assert.ok(!layer.includes('合成公司'), '章节条目标题应移除，实际片段：' + layer.slice(0, 300));
    assert.ok(layer.includes('Go/Python') || layer.includes('Go / Python'), '未勾选章节应保留');
    // 关联投递：app.shareId 落在 applications.json（权威来源）
    const a1 = appOnDisk(root, APP_IDS.a1);
    assert.equal(a1.shareId, shareC, '创建时带 appId 应把 shareId 写进投递记录');
    assert.equal(appOnDisk(root, APP_IDS.a2).shareId, undefined, '未关联的投递记录不得被写入 shareId');
    // 未关联的分享副本
    const r2 = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: ['skills'] });
    assert.equal(r2.status, 200, '不带 appId 的导出应 200');
    shareD = r2.json.shareId;
    // 页面记录行：隐藏清单 / 打开 PDF / 投递引用（实时派生）
    const html = (await get(base, '/apply-profile')).text;
    const rowOf = (sid) => {
      const k = 'data-share-id="' + sid + '"';
      const i = html.indexOf(k);
      return i < 0 ? '' : html.slice(Math.max(0, i - 400), i + 600);
    };
    const rowC = rowOf(shareC);
    assert.ok(rowC, '/apply-profile 应列出分享副本记录');
    assert.ok(rowC.includes('工作经历'), '记录行应写明隐藏了什么（工作经历）');
    assert.ok(rowC.includes('投递引用：甲公司·合成岗位'), '记录行应可查被哪些投递引用（实时派生自投递记录），实际：' + rowC.slice(0, 400));
    const rowD = rowOf(shareD);
    assert.ok(rowD.includes('专业技能'), '记录行应写明隐藏了什么（专业技能）');
    assert.ok(rowD.includes('投递引用：无'), '未关联的记录应如实显示「投递引用：无」，实际：' + rowD.slice(0, 400));
    assert.ok(rowC.includes('/share/pdf?id='), '记录行应有打开独立 PDF 的入口');
  }

  // ===== ④ absent：勾选了原简历里没有的字段 → 200 + 如实回报，不假装隐藏了 =====
  {
    const r = await postJson(base, '/share/copy', { docId: DOC_IDS.b, hidden: ['email', 'skills'] });
    assert.equal(r.status, 200, 'absent 场景应仍可导出（其余字段真实隐藏），实际 ' + r.status + ' ' + r.text.slice(0, 300));
    assert.deepEqual((r.json && r.json.absent || []).sort(), ['email', 'skills'], '应如实回报原简历没有的字段，实际：' + r.text.slice(0, 300));
    const pdf = await get(base, '/share/pdf?id=' + encodeURIComponent(r.json.shareId));
    const layer = squash(pdfLayer(pdf.buf));
    assert.ok(!layer.includes('tester@example.invalid'), 'DOC_B 本无邮箱');
    assert.ok(layer.includes('合成姓名') && layer.includes('021-5555-6677'), '未勾选的姓名/座机应保留，实际片段：' + layer.slice(0, 300));
  }

  // ===== ⑤ 形状守卫：形状错即拒；appId 不存在 → 404 且零部分产物 =====
  {
    const ledBefore = Object.keys(ledger(root).shares || {}).length;
    const artsBefore = shareArtifacts(root).length;
    const bad1 = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: [] });
    assert.equal(bad1.status, 400, '空 hidden 应 400，实际 ' + bad1.status);
    const bad2 = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: 'phone' });
    assert.equal(bad2.status, 400, 'hidden 非数组应 400，实际 ' + bad2.status);
    const bad3 = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: ['nope'] });
    assert.equal(bad3.status, 400, '未知字段应 400，实际 ' + bad3.status);
    const bad4 = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: ['greeting'] });
    assert.equal(bad4.status, 400, 'AI 文案字段不在简历里，不可隐藏 → 400，实际 ' + bad4.status);
    const bad5 = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: ['expectedSalary'] });
    assert.equal(bad5.status, 400, '独立字段不在简历里，不可隐藏 → 400，实际 ' + bad5.status);
    const bad6 = await postJson(base, '/share/copy', { docId: 'no-such-doc', hidden: ['name'] });
    assert.equal(bad6.status, 404, 'docId 不存在应 404，实际 ' + bad6.status);
    const bad7 = await postJson(base, '/share/copy', { docId: '../etc', hidden: ['name'] });
    assert.equal(bad7.status, 400, 'docId 形状非法应 400，实际 ' + bad7.status);
    const bad8 = await postJson(base, '/share/copy', { docId: DOC_IDS.master, hidden: ['name'], appId: '2026-02-03-000000-003' });
    assert.equal(bad8.status, 404, 'appId 不存在应 404，实际 ' + bad8.status);
    assert.equal(Object.keys(ledger(root).shares || {}).length, ledBefore, '被拒请求不得写导出记录（含 appId 404：零部分产物）');
    assert.equal(shareArtifacts(root).length, artsBefore, '被拒请求不得留下 PDF 文件');
    const nf = await get(base, '/share/pdf?id=sh-no-such-record');
    assert.equal(nf.status, 404, '未知 shareId 应 404，实际 ' + nf.status);
    const trav = await get(base, '/share/pdf?id=..%2Fdocs%2F' + MASTER);
    assert.equal(trav.status, 400, 'shareId 形状非法（路径穿越尝试）应 400，实际 ' + trav.status);
  }

  // ===== ⑥ 页面 UI：分享副本卡（8 个可隐藏字段勾选 + 来源简历 + 关联投递 + 记录列表） =====
  {
    const html = (await get(base, '/apply-profile')).text;
    assert.ok(html.includes('id="apShareForm"'), '应有分享副本表单');
    // 只在表单块内数（页面脚本里的 querySelectorAll 字面量也会出现同样的串，不能算进去）
    const formBlock = html.slice(html.indexOf('id="apShareForm"'), html.indexOf('</form>', html.indexOf('id="apShareForm"')));
    const boxes = formBlock.match(/type="checkbox"/g) || [];
    assert.equal(boxes.length, 8, '可隐藏字段勾选应恰为 8 个派生字段（姓名/电话/邮箱/自评/技能/工作/项目/教育），实际 ' + boxes.length);
    for (const v of ['name', 'phone', 'email', 'selfIntro', 'skills', 'work', 'projects', 'education']) {
      assert.ok(html.includes(`value="${v}"`), '勾选应含字段 ' + v);
    }
    assert.ok(html.includes(`value="${MASTER}"`), '来源简历下拉应含母版文档');
    assert.ok(html.includes('id="apShareApp"'), '应有关联投递下拉');
    assert.ok(html.includes(APP_IDS.a1) && html.includes('甲公司'), '关联投递下拉应列出现有投递记录');
    assert.ok(html.includes('data-share-id="' + shareA + '"'), '既有记录应 server 渲染在列表里');
  }

  // ===== ⑦ 浏览器段：真点「导出分享副本」→ 新记录出现 + 产物可打开；零 JS 异常 =====
  {
    let bin = null;
    try { bin = await resolveChromium(); }
    catch (e) { console.log('⚠️  Chromium 不可用，跳过分享副本浏览器段：' + (e && e.message || e)); cleanupAll(); process.exit(2); }
    const browser = await chromium.launch({ executablePath: bin, headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      await page.goto(base + '/apply-profile', { waitUntil: 'networkidle' });
      const rowsBefore = await page.locator('[data-share-id]').count();
      await page.selectOption('#apShareDoc', MASTER);
      await page.check('#apShareForm input[name="apShareHide"][value="phone"]');
      await page.check('#apShareForm input[name="apShareHide"][value="email"]');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
        page.click('#apShareForm button[type="submit"]'),
      ]);
      const rowsAfter = await page.locator('[data-share-id]').count();
      assert.equal(rowsAfter, rowsBefore + 1, '浏览器段：导出后记录列表应多一条，实际 ' + rowsBefore + ' → ' + rowsAfter);
      // 新记录的产物真实可打开（独立 PDF）
      const newId = await page.locator('[data-share-id]').last().getAttribute('data-share-id');
      const led = ledger(root);
      assert.ok(led.shares[newId] && led.shares[newId].docId === MASTER, '浏览器段导出应落账本记录');
      const pdf = await get(base, '/share/pdf?id=' + encodeURIComponent(newId));
      assert.equal(pdf.status, 200, '浏览器段导出的 PDF 应可经 /share/pdf 打开');
      const layer = squash(pdfLayer(pdf.buf));
      assert.ok(!layer.includes('021-5555-6666') && !layer.includes('tester@example.invalid'), '浏览器段产物文本层应无勾选字段残留');
      assert.deepEqual(pageErrors, [], '页面不应有 JS 异常，实际：' + pageErrors.join(' || '));
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // ===== ⑧ DESIGN.md 红线自查 + 冻结件零改动 =====
  {
    const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    const shRules = srv.split('\n').filter((l) => { const t = l.trim(); return t.startsWith('.ap-sh') && t.includes('{'); });
    assert.ok(shRules.length > 0, '应有 .ap-sh* 样式规则（分享副本区）');
    for (const line of shRules) {
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

  console.log('✅ 分享副本：勾选隐藏字段 → 独立预览/PDF（原简历零改动）+ 文本层无残留校验（残留 409 零产物）+ 导出记录实时可查被哪些投递引用');
} catch (e) {
  console.error('❌ ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  if (server) server.kill();
  cleanupAll();
}
