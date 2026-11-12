// test-apply-profile-page.mjs — 网申包页面（批 3 · 卡片 b3c2）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4 批 3「S8 网申包 + 跟进助手」；上位路线图 S8。
// 合同（本卡只管页面层：页面 + 投递系页签条「网申包」项 + 三态字段 UI + 单字段复制 + 整包导出；
//       AI 文案字段 / 跟进助手 / 分享副本 / 投递记录关联不在本卡）：
//   ① 页面 /apply-profile：页题「网申包」、通用信息表 + 按公司字段包同页。
//   ② 「网申包」入口：渐进呈现 T2 后由 topnav 迁入投递系页签条 .apptabs（topnav 链接数 7 → 4，UI-4 断言同步）。
//   ③ 三态字段 UI：跟随来源 / 手动覆写 / 恢复跟随（动作）+ 独立维护（独立字段，不从简历派生）。
//      漂移（来源变更）有提示；恢复跟随清漂移；独立字段无「恢复跟随」入口。
//   ④ 单字段一键复制：每个字段一行有复制入口，复制的就是该行显示的值（所见即所复制）。
//   ⑤ 整包导出：纯文本（复制用）+ JSON（含全部字段与三态），可下载（Content-Disposition）。
//   ⑥ 写路径真点一遍（浏览器段）：页面上「手动改写 → 保存」「恢复跟随」「独立字段保存」三条写路径
//      必须真的落盘 —— 页面发的作用范围形状与动态按钮携带的属性都必须对（复核阻断项 b3c2-①/②）。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档；不读真实简历、不碰 7766、不调真实模型；仓库零写入。
// 隐私门禁：合成数据不含 1[3-9]\d{9} 形态的 11 位长数字（电话用座机号，邮箱用 example.invalid），
//            夹具内不写 13 位时间戳（长数字第二位避开 3-9）。
// 退出码契约：0=全部通过；1=任一断言失败；2=仅 Chromium 不可用且此前无失败（浏览器段跳过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-appprofpage-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });

// —— 合成文档（通用母版 + 岗位简历）——
const MASTER = 'apmaster';
const JOB = 'apjob';
const entry = (title, role, date, bullet) =>
  `<div class="entry-head"><div class="entry-title">${title}</div><div class="entry-role">${role}</div><div class="entry-date">${date}</div></div>\n<ul>\n<li>${bullet}</li>\n</ul>`;
const buildDoc = (id, name, summary, work) => {
  let doc = assembleTemplate('classic');
  const map = {
    '{{NAME}}': name,
    '{{CONTACT}}': '座机：021-5555-6666 邮箱：tester@example.invalid',
    '{{INTENT}}': '后端工程师',
    '{{SUMMARY}}': summary,
    '{{SKILLS}}': '<p><strong>语言：</strong>Go / Python</p>',
    '{{WORK}}': work,
    '{{PROJECTS}}': '<p>项目一：负责合成交易系统</p>',
    '{{EDU}}': entry('合成大学', '计算机', '2017-06', ''),
    '{{DOC_ID}}': id,
  };
  for (const [k, v] of Object.entries(map)) doc = doc.replaceAll(k, () => v);
  return doc;
};
const MASTER_V1 = buildDoc(MASTER, '合成姓名', '合成自评一段', entry('合成公司', '后端工程师', '2021-03', '负责合成交易系统'));
const MASTER_V2 = buildDoc(MASTER, '合成姓名', '合成自评一段', entry('合成公司', '后端工程师', '2021-03', '负责合成交易系统与风控'));
const JOB_V1 = buildDoc(JOB, '岗位姓名', '岗位自评一段', entry('岗位公司', '后端工程师', '2022-05', '负责合成网关'));
// 转义回归用文档：标题含 & （页面上必须只转义一次，不得出现 &amp;amp;）
const AMP = 'apamp';
const AMP_V1 = buildDoc(AMP, '合成 & 伙伴', '含符号自评', entry('符号公司', '后端工程师', '2023-01', '负责合成符号'));
fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), MASTER_V1);
fs.writeFileSync(path.join(root, 'docs', JOB + '.html'), JOB_V1);
fs.writeFileSync(path.join(root, 'docs', AMP + '.html'), AMP_V1);
const metaPath = path.join(root, 'docs-meta.json');
fs.writeFileSync(metaPath, JSON.stringify({ [MASTER]: { rev: 1, flow: 'draft' }, [JOB]: { rev: 1, flow: 'draft' }, [AMP]: { rev: 1, flow: 'draft' } }, null, 2));

// 随机端口 + 隔离根起服务
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
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));
const base = `http://127.0.0.1:${port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text(), headers: r.headers }; };
const postJson = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

// —— HTML 取样工具（按 id 切段 / 按字段切行）——
const section = (html, id) => {
  const i = html.indexOf('id="' + id + '"');
  if (i < 0) return '';
  const start = html.lastIndexOf('<section', i);
  const end = html.indexOf('</section>', i);
  if (start < 0 || end < 0) return '';
  return html.slice(start, end);
};
// 字段行按标记切块（行之间不嵌套，故按标记切分即可定位单行）
const rowOf = (html, scopeId, key) => {
  for (const chunk of html.split('<div class="ap-row"').slice(1)) {
    const head = chunk.slice(0, chunk.indexOf('>') + 1);
    if (head.includes('data-key="' + key + '"')) return '<div class="ap-row"' + chunk;
  }
  return '';
};
const rowCount = (html) => (html.match(/<div class="ap-row"/g) || []).length;
const badgeText = (row) => {
  const m = /<span class="badge[^"]*">([^<]*)<\/span>/.exec(row);
  return m ? m[1] : '';
};
const textareaValue = (row) => {
  const m = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(row);
  return m ? m[1] : '';
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① 页面与导航 =====
  {
    const r = await get('/apply-profile');
    assert.equal(r.status, 200, '/apply-profile 应 200，实际 ' + r.status);
    const html = r.text;
    assert.ok(html.includes('<title>网申包</title>'), '页题应为「网申包」');
    assert.ok(html.includes('<h1>网申包</h1>'), '页面第一标题应为「网申包」');
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, '/apply-profile 应只有一个 h1（页题档两档制）');
    // 渐进呈现 T2：topnav 收敛为 brand + 3 项（7 → 4）；「网申包」入口迁入投递系页签条 .apptabs（入口移位，非功能删除）
    const nav = (html.match(/<nav class="topnav">[\s\S]*?<\/nav>/) || [''])[0];
    assert.equal((nav.match(/<a [^>]*>[\s\S]*?<\/a>/g) || []).length, 4,
      'topnav 链接数应为 4（brand + 3 项，渐进呈现 T2 收敛）');
    assert.ok(!nav.includes('href="/apply-profile"'), 'topnav 不应再含「网申包」入口（已迁至投递系页签条）');
    assert.ok(/<a href="\/applications" class="on">/.test(nav), 'topnav「投递」项应高亮（active=apps，网申包归属投递系）');
    const tabs = (html.match(/<nav class="apptabs"[\s\S]*?<\/nav>/) || [''])[0];
    assert.ok(tabs, '网申包页应有投递系页签条 .apptabs');
    assert.ok(tabs.includes('href="/apply-profile"') && tabs.includes('网申包'), '页签条应含「网申包」入口');
    assert.ok(/<a href="\/apply-profile" class="on" aria-current="page">/.test(tabs), '页签条「网申包」项应高亮（active=apply，aria-current=page）');
    // 其它页面的导航同样 4 项（导航全站一致）
    const home = await get('/');
    const homeNav = (home.text.match(/<nav class="topnav">[\s\S]*?<\/nav>/) || [''])[0];
    assert.equal((homeNav.match(/<a [^>]*>[\s\S]*?<\/a>/g) || []).length, 4, '首页 topnav 链接数应同为 4');
  }

  // ===== ② 通用信息表：字段目录齐全 + 三态 UI 骨架 =====
  let commonHtml = '';
  {
    const html = (await get('/apply-profile')).text;
    commonHtml = section(html, 'apCommon');
    assert.ok(commonHtml, '/apply-profile 应渲染通用信息表区（id=apCommon）');
    // 11 → 14（登记非放宽）：批 3 卡片 b3c3 按计划 §4 批 3「AI 文案字段（新增类型）：打招呼语/自荐信/跟进语」
    // 在字段目录里新增 3 个字段类型（不是断言放宽：计数仍精确，AI 三行的行为断言见 test-apply-copy-fields.mjs）。
    assert.equal(rowCount(commonHtml), 14, '通用表应有 14 个字段行（8 派生 + 3 独立 + 3 AI 文案），实际 ' + rowCount(commonHtml));
    // 每个字段行都有：标签 + 状态徽章 + 值 + 复制入口
    for (const [key, label] of [['name', '姓名'], ['phone', '电话'], ['email', '邮箱'], ['selfIntro', '自评'],
      ['skills', '专业技能'], ['work', '工作经历'], ['projects', '项目经历'], ['education', '教育经历'],
      ['expectedSalary', '期望薪资'], ['availability', '到岗时间'], ['workYears', '工作年限']]) {
      const row = rowOf(commonHtml, 'common', key);
      assert.ok(row, `通用表应含字段行 ${key}`);
      assert.ok(row.includes('>' + label + '<'), `字段 ${key} 应显示标签「${label}」`);
      assert.ok(row.includes('data-ap="copy"'), `字段 ${key} 应有单字段复制入口`);
      assert.ok(badgeText(row), `字段 ${key} 应有状态徽章`);
    }
    // 未绑定母版时：跟随来源 + 无值
    assert.equal(badgeText(rowOf(commonHtml, 'common', 'name')), '跟随来源', '未绑定母版时字段应为「跟随来源」');
    assert.equal(textareaValue(rowOf(commonHtml, 'common', 'name')), '', '未绑定母版时字段值为空');
    // 派生字段有「恢复跟随」；独立字段没有（独立维护，无来源）
    assert.ok(rowOf(commonHtml, 'common', 'name').includes('data-ap="follow"'), '派生字段应有「恢复跟随」入口');
    assert.ok(!rowOf(commonHtml, 'common', 'expectedSalary').includes('data-ap="follow"'), '独立字段不应有「恢复跟随」入口');
    assert.ok(rowOf(commonHtml, 'common', 'expectedSalary').includes('data-ap="save"'), '独立字段应有「保存」入口（独立维护）');
    assert.ok(!rowOf(commonHtml, 'common', 'name').includes('data-ap="save"'), '跟随态字段不应直接暴露「保存」');
  }

  // ===== ③ 绑定母版 → 跟随来源取母版派生纯文本 =====
  {
    const b = await postJson('/apply/bind', { docId: MASTER });
    assert.equal(b.status, 200, '绑定母版应 200，实际 ' + b.status + ' ' + b.text.slice(0, 200));
    const html = (await get('/apply-profile')).text;
    commonHtml = section(html, 'apCommon');
    const nameRow = rowOf(commonHtml, 'common', 'name');
    assert.equal(badgeText(nameRow), '跟随来源', '绑定后字段仍为「跟随来源」');
    assert.equal(textareaValue(nameRow), '合成姓名', '绑定后姓名字段值应等于母版派生文本');
    assert.ok(nameRow.includes('合成母版') || nameRow.includes(MASTER), '字段行应标出来源（母版），实际：' + nameRow.slice(0, 300));
    // 绑定不存在的文档 → 404（不静默绑成空来源）
    const bad = await postJson('/apply/bind', { docId: 'nosuchdoc' });
    assert.equal(bad.status, 404, '绑定不存在的文档应 404');
  }

  // ===== ④ 手动覆写 → 恢复跟随（三态动作） =====
  {
    const o = await postJson('/apply/field', { scope: 'common', key: 'name', mode: 'override', value: '手写姓名' });
    assert.equal(o.status, 200, '手动覆写应 200，实际 ' + o.status + ' ' + o.text.slice(0, 200));
    let html = (await get('/apply-profile')).text;
    commonHtml = section(html, 'apCommon');
    let row = rowOf(commonHtml, 'common', 'name');
    assert.equal(badgeText(row), '手动覆写', '覆写后徽章应为「手动覆写」');
    assert.equal(textareaValue(row), '手写姓名', '覆写后应显示手填值');
    assert.ok(row.includes('data-ap="save"'), '覆写态应暴露「保存」入口');
    // 恢复跟随 → 丢弃手填、回到来源、清漂移
    const f = await postJson('/apply/field', { scope: 'common', key: 'name', mode: 'follow' });
    assert.equal(f.status, 200, '恢复跟随应 200，实际 ' + f.status + ' ' + f.text.slice(0, 200));
    html = (await get('/apply-profile')).text;
    commonHtml = section(html, 'apCommon');
    row = rowOf(commonHtml, 'common', 'name');
    assert.equal(badgeText(row), '跟随来源', '恢复跟随后徽章应为「跟随来源」');
    assert.equal(textareaValue(row), '合成姓名', '恢复跟随后应回到来源派生文本');
  }

  // ===== ⑤ 漂移提示：来源变更 → 「来源已变」；恢复跟随 → 清漂移 =====
  {
    fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), MASTER_V2);
    let html = (await get('/apply-profile')).text;
    commonHtml = section(html, 'apCommon');
    const workRow = rowOf(commonHtml, 'common', 'work');
    assert.equal(badgeText(workRow), '来源已变', '母版变更后字段应标「来源已变」，实际：' + badgeText(workRow));
    assert.ok(textareaValue(workRow).includes('风控'), '漂移字段的值应实时取当前来源文本，实际：' + textareaValue(workRow));
    const f = await postJson('/apply/field', { scope: 'common', key: 'work', mode: 'follow' });
    assert.equal(f.status, 200, '漂移后恢复跟随应 200');
    html = (await get('/apply-profile')).text;
    commonHtml = section(html, 'apCommon');
    assert.equal(badgeText(rowOf(commonHtml, 'common', 'work')), '跟随来源', '恢复跟随后应清漂移');
  }

  // ===== ⑥ 独立字段：独立维护；不从简历派生；无源不可恢复跟随 =====
  {
    const m = await postJson('/apply/field', { scope: 'common', key: 'expectedSalary', mode: 'manual', value: '面议 30-40 万' });
    assert.equal(m.status, 200, '独立字段独立维护应 200，实际 ' + m.status + ' ' + m.text.slice(0, 200));
    const html = (await get('/apply-profile')).text;
    commonHtml = section(html, 'apCommon');
    const row = rowOf(commonHtml, 'common', 'expectedSalary');
    assert.equal(badgeText(row), '独立维护', '独立字段徽章应为「独立维护」');
    assert.equal(textareaValue(row), '面议 30-40 万', '独立字段应显示自维护值');
    // 母版再改 → 独立字段不受影响
    fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), MASTER_V1);
    const html2 = (await get('/apply-profile')).text;
    assert.equal(textareaValue(rowOf(section(html2, 'apCommon'), 'common', 'expectedSalary')), '面议 30-40 万',
      '独立字段不得被简历改动覆盖');
    // 无来源 → 拒绝恢复跟随（错误可读，不 500）
    const bad = await postJson('/apply/field', { scope: 'common', key: 'expectedSalary', mode: 'follow' });
    assert.equal(bad.status, 400, '独立字段恢复跟随应 400，实际 ' + bad.status);
    assert.ok(bad.json && bad.json.ok === false && String(bad.json.error || '').includes('独立字段'),
      '独立字段恢复跟随应给可读原因，实际：' + bad.text.slice(0, 200));
    // 派生字段不得设为独立维护
    const bad2 = await postJson('/apply/field', { scope: 'common', key: 'name', mode: 'manual', value: 'x' });
    assert.equal(bad2.status, 400, '派生字段设为独立维护应 400，实际 ' + bad2.status);
    assert.ok(bad2.json && bad2.json.ok === false, '派生字段设为独立维护应给可读原因');
  }

  // ===== ⑦ 公司字段包：建包 + 跟随通用表 + 换源跟随岗位简历 =====
  let pkgId = '';
  {
    const c = await postJson('/apply/package', { company: '合成公司', role: '后端工程师' });
    assert.equal(c.status, 200, '建字段包应 200，实际 ' + c.status + ' ' + c.text.slice(0, 200));
    assert.ok(c.json && c.json.ok === true && c.json.id, '建包应返回包 id');
    pkgId = c.json.id;
    const html = (await get('/apply-profile')).text;
    const pkgSec = section(html, 'apPkg-' + pkgId);
    assert.ok(pkgSec, '页面应渲染公司字段包区（id=apPkg-<id>）');
    assert.ok(pkgSec.includes('合成公司') && pkgSec.includes('后端工程师'), '字段包应显示公司与岗位');
    assert.equal(rowCount(pkgSec), 14, '字段包应有 14 个字段行（11 + 3 AI 文案，b3c3 登记），实际 ' + rowCount(pkgSec));
    const nameRow = rowOf(pkgSec, pkgId, 'name');
    assert.equal(textareaValue(nameRow), '合成姓名', '包内字段默认跟随通用表当前值');
    assert.ok(nameRow.includes('通用'), '包内字段应标出来源（通用信息表），实际：' + nameRow.slice(0, 300));
    // 换源 → 跟随岗位简历
    const s = await postJson('/apply/source', { scope: { kind: 'package', id: pkgId }, source: { kind: 'resume', docId: JOB } });
    assert.equal(s.status, 200, '换源应 200，实际 ' + s.status + ' ' + s.text.slice(0, 200));
    const html2 = (await get('/apply-profile')).text;
    const pkgSec2 = section(html2, 'apPkg-' + pkgId);
    assert.equal(textareaValue(rowOf(pkgSec2, pkgId, 'name')), '岗位姓名', '换源后包内字段应取岗位简历派生文本');
    assert.ok(rowOf(pkgSec2, pkgId, 'name').includes(JOB), '换源后应标出来源（岗位简历 id）');
    // 换到不存在的文档 → 404
    const bad = await postJson('/apply/source', { scope: { kind: 'package', id: pkgId }, source: { kind: 'resume', docId: 'nosuchdoc' } });
    assert.equal(bad.status, 404, '换源到不存在的文档应 404，实际 ' + bad.status);
    // 未知包 → 404
    const bad2 = await postJson('/apply/source', { scope: { kind: 'package', id: 'pkg-nosuch' }, source: { kind: 'common' } });
    assert.equal(bad2.status, 404, '未知字段包应 404，实际 ' + bad2.status);
  }

  // ===== ⑧ 单字段一键复制：复制的就是该行显示的值（所见即所复制） =====
  {
    const html = (await get('/apply-profile')).text;
    const common = section(html, 'apCommon');
    const workRow = rowOf(common, 'common', 'work');
    assert.ok(workRow.includes('data-ap="copy"'), '字段行应有复制入口');
    assert.ok(textareaValue(workRow).includes('负责合成交易系统'), '复制源应是该行显示的值');
    // 复制接线：写剪贴板的值取自该行值框（不是另一个来源）
    assert.ok(html.includes('navigator.clipboard.writeText('), '页面应有写剪贴板的接线');
    assert.ok(/querySelector\(\s*['"]\.ap-val['"]\s*\)/.test(html), '复制应取自该行的 .ap-val 值框');
    // 复制入口是按钮（有可访问名称），不是纯图标
    assert.ok(/<button[^>]*data-ap="copy"[^>]*>复制<\/button>/.test(common), '复制入口应是带「复制」文案的按钮');
  }

  // ===== ⑨ 整包导出：纯文本 + JSON =====
  {
    // 通用表纯文本
    const t = await get('/apply/export?scope=common&format=text');
    assert.equal(t.status, 200, '通用表纯文本导出应 200，实际 ' + t.status);
    assert.ok(/^text\/plain/.test(t.headers.get('content-type') || ''), '纯文本导出 Content-Type 应为 text/plain');
    assert.ok(/attachment/.test(t.headers.get('content-disposition') || ''), '导出应带 Content-Disposition attachment');
    assert.ok(t.text.includes('姓名：合成姓名'), '纯文本导出应含字段名与值，实际：' + t.text.slice(0, 300));
    assert.ok(t.text.includes('期望薪资：面议 30-40 万'), '纯文本导出应含独立维护字段的值');
    // 通用表 JSON（含全部字段与三态）
    const j = await get('/apply/export?scope=common&format=json');
    assert.equal(j.status, 200, '通用表 JSON 导出应 200');
    assert.ok(/application\/json/.test(j.headers.get('content-type') || ''), 'JSON 导出 Content-Type 应为 application/json');
    const jd = JSON.parse(j.text);
    assert.equal(jd.scope, 'common', 'JSON 导出应标 scope=common');
    assert.equal(Object.keys(jd.fields || {}).length, 14, 'JSON 导出应含全部 14 个字段（11 + 3 AI 文案，b3c3 登记），实际 ' + Object.keys(jd.fields || {}).length);
    assert.equal(jd.fields.name.value, '合成姓名', 'JSON 导出应含字段当前值');
    assert.equal(jd.fields.name.state, 'follow', 'JSON 导出应含字段计算态');
    assert.equal(jd.fields.expectedSalary.state, 'manual', 'JSON 导出应含独立字段态');
    // 公司包纯文本 + JSON
    const pt = await get('/apply/export?scope=package&pkg=' + encodeURIComponent(pkgId) + '&format=text');
    assert.equal(pt.status, 200, '字段包纯文本导出应 200，实际 ' + pt.status);
    assert.ok(pt.text.includes('合成公司'), '包导出应含公司名');
    assert.ok(pt.text.includes('后端工程师'), '包导出应含岗位名');
    assert.ok(pt.text.includes('岗位姓名'), '包导出应含该包的字段值，实际：' + pt.text.slice(0, 300));
    const pj = await get('/apply/export?scope=package&pkg=' + encodeURIComponent(pkgId) + '&format=json');
    assert.equal(pj.status, 200, '字段包 JSON 导出应 200');
    const pjd = JSON.parse(pj.text);
    assert.equal(pjd.scope, 'package', '包 JSON 应标 scope=package');
    assert.equal(pjd.package.company, '合成公司', '包 JSON 应含公司');
    assert.equal(pjd.fields.name.value, '岗位姓名', '包 JSON 应含该包字段值');
    // 未知包 → 404（不导出一份空包糊弄）
    const bad = await get('/apply/export?scope=package&pkg=pkg-nosuch&format=text');
    assert.equal(bad.status, 404, '未知包导出应 404，实际 ' + bad.status);
    // 导出范围写法：'pkg' 是 'package' 的别名；未知 scope → 400（不静默回落成通用表导出）
    const alias = await get('/apply/export?scope=pkg&pkg=' + encodeURIComponent(pkgId) + '&format=text');
    assert.equal(alias.status, 200, 'scope=pkg（package 的别名）应被认，实际 ' + alias.status);
    assert.ok(alias.text.includes('岗位姓名'), 'scope=pkg 应导出该包内容（与 scope=package 同），实际：' + alias.text.slice(0, 200));
    const badScope = await get('/apply/export?scope=bogus&format=text');
    assert.equal(badScope.status, 400, '未知导出范围应 400（形状错即拒，不静默导出通用表），实际 ' + badScope.status);
    const noScope = await get('/apply/export?format=text');
    assert.equal(noScope.status, 200, '缺 scope 应按通用表导出（登记口径），实际 ' + noScope.status);
    // 从未被写过的独立字段：导出态必须与页面徽章同口径（manual，不是 follow —— 它没有来源可跟）
    assert.equal(jd.fields.workYears.state, 'manual', '未被写过的独立字段在 JSON 导出里应为 manual（与页面「独立维护」同口径），实际：' + jd.fields.workYears.state);
    assert.equal(jd.fields.workYears.mode, 'manual', '未被写过的独立字段在 JSON 导出里 mode 应为 manual，实际：' + jd.fields.workYears.mode);
    assert.equal(jd.fields.workYears.value, '', '未被写过的独立字段导出值应为空');
  }

  // ===== ⑩ 转义：来源标注里的文档标题只转义一次（不得双重转义） =====
  {
    const s2 = await postJson('/apply/source', { scope: { kind: 'package', id: pkgId }, source: { kind: 'resume', docId: AMP } });
    assert.equal(s2.status, 200, '换源到含符号标题的文档应 200，实际 ' + s2.status);
    const html3 = (await get('/apply-profile')).text;
    const pkgSec3 = section(html3, 'apPkg-' + pkgId);
    const ampRow = rowOf(pkgSec3, pkgId, 'name');
    assert.ok(ampRow.includes('合成 &amp; 伙伴'), '来源标注里的标题应转义一次，实际：' + ampRow.slice(0, 300));
    assert.ok(!html3.includes('&amp;amp;'), '页面不得出现双重转义（&amp;amp;）');
    assert.ok(!html3.includes('<script>alert'), '页面不得含裸脚本标签');
  }

  // ===== ⑪ 作用范围形状：页面实际发送的形状必须被服务端接受（复核阻断项 ①） =====
  {
    // 页面客户端发的是**对象**形态 {kind:'common'} / {kind:'package', id}（不是字符串 'common'）——
    // 服务端两种形状都得认，否则通用表整片写动作 400「未知作用范围」。
    const objCommon = await postJson('/apply/field', { scope: { kind: 'common' }, key: 'skills', mode: 'override', value: '对象形态手写技能' });
    assert.equal(objCommon.status, 200, '对象形态 scope {kind:"common"} 应被接受，实际 ' + objCommon.status + ' ' + objCommon.text.slice(0, 160));
    const objPkg = await postJson('/apply/field', { scope: { kind: 'package', id: pkgId }, key: 'skills', mode: 'override', value: '包内对象形态手写' });
    assert.equal(objPkg.status, 200, '对象形态 scope {kind:"package",id} 应被接受，实际 ' + objPkg.status + ' ' + objPkg.text.slice(0, 160));
    // 形状错仍要拒（不猜）
    const badScope = await postJson('/apply/field', { scope: { kind: 'unknown' }, key: 'name', mode: 'follow' });
    assert.equal(badScope.status, 400, '未知作用范围应 400，实际 ' + badScope.status);
    const noId = await postJson('/apply/field', { scope: { kind: 'package' }, key: 'name', mode: 'follow' });
    assert.equal(noId.status, 400, '字段包缺 id 应 400，实际 ' + noId.status);
    // 复原（浏览器段还要用这两个字段）
    await postJson('/apply/field', { scope: 'common', key: 'skills', mode: 'follow' });
    await postJson('/apply/field', { scope: { kind: 'package', id: pkgId }, key: 'skills', mode: 'follow' });
  }

  // ===== ⑫ 浏览器段：页面上真点一遍写路径（复核阻断项 ①/② 的行为面） =====
  {
    let bin = null;
    try { bin = await resolveChromium(); }
    catch (e) { console.log('⚠️  Chromium 不可用，跳过写路径浏览器段：' + (e && e.message || e)); cleanup(); process.exit(2); }
    const browser = await chromium.launch({ executablePath: bin, headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      await page.goto(base + '/apply-profile', { waitUntil: 'networkidle' });
      const rowSel = (key) => `.ap-row[data-scope="common"][data-key="${key}"]`;
      // 点一个写按钮 → 返回该 POST 的 HTTP 状态（写失败的 400 就是断在这里）。
      // 写成功时客户端会 location.reload()：先挂上 load 事件等它落定，再读 DOM（否则读到旧 DOM）。
      const clickWrite = async (sel) => {
        const reloaded = page.waitForEvent('load', { timeout: 8000 }).catch(() => null);
        const [resp] = await Promise.all([
          page.waitForResponse((r) => r.url().includes('/apply/field') && r.request().method() === 'POST', { timeout: 10000 }),
          reloaded,
          page.click(sel),
        ]);
        return resp.status();
      };
      const rowState = async (key) => page.evaluate((k) => {
        const row = document.querySelector('.ap-row[data-scope="common"][data-key="' + k + '"]');
        if (!row) return null;
        const b = row.querySelector('.badge');
        const ta = row.querySelector('.ap-val');
        return { badge: b ? b.textContent.trim() : '', value: ta ? ta.value : '' };
      }, key);
      const ledger = () => JSON.parse(fs.readFileSync(path.join(root, 'apply-profiles.json'), 'utf8'));

      // ① 「手动改写 → 保存」：动态创建的保存按钮必须带对字段与作用范围（阻断项 ②）
      await page.click(rowSel('name') + ' button[data-ap="edit"]');
      await page.fill(rowSel('name') + ' .ap-val', '改过的姓名');
      const st1 = await clickWrite(rowSel('name') + ' button[data-ap="save"]');
      assert.equal(st1, 200, '「手动改写 → 保存」应 200，实际 ' + st1);
      const s1 = await rowState('name');
      assert.equal(s1.badge, '手动覆写', '保存后应显示「手动覆写」，实际：' + JSON.stringify(s1));
      assert.equal(s1.value, '改过的姓名', '保存后应显示新填的值，实际：' + JSON.stringify(s1));
      assert.equal(ledger().common.fields.name.override, '改过的姓名', '保存后账本应落 override 值');
      assert.equal((await page.textContent('#apMsg')).trim(), '', '写成功后不应有错误提示');

      // ② 「恢复跟随」：通用表也要能写（阻断项 ①）
      const st2 = await clickWrite(rowSel('name') + ' button[data-ap="follow"]');
      assert.equal(st2, 200, '「恢复跟随」应 200，实际 ' + st2);
      const s2 = await rowState('name');
      assert.equal(s2.badge, '跟随来源', '恢复跟随后应显示「跟随来源」，实际：' + JSON.stringify(s2));
      assert.equal(s2.value, '合成姓名', '恢复跟随后应回到来源派生值，实际：' + JSON.stringify(s2));

      // ③ 独立字段「保存」（独立维护态的值框可编辑）
      await page.fill(rowSel('expectedSalary') + ' .ap-val', '面议 35-45 万');
      const st3 = await clickWrite(rowSel('expectedSalary') + ' button[data-ap="save"]');
      assert.equal(st3, 200, '独立字段保存应 200，实际 ' + st3);
      const s3 = await rowState('expectedSalary');
      assert.equal(s3.badge, '独立维护', '独立字段保存后仍应是「独立维护」，实际：' + JSON.stringify(s3));
      assert.equal(s3.value, '面议 35-45 万', '独立字段保存后应显示新值，实际：' + JSON.stringify(s3));
      assert.equal(ledger().common.fields.expectedSalary.value, '面议 35-45 万', '独立字段保存后账本应落新值');

      assert.deepEqual(pageErrors, [], '页面不应有 JS 异常，实际：' + pageErrors.join(' || '));
    } finally {
      await browser.close();
    }
  }

  // ===== ⑬ DESIGN.md 红线自查（本卡新写代码，源级扫描） =====
  {
    const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    const apRules = srv.split('\n').filter((l) => { const t = l.trim(); return t.startsWith('.ap-') && t.includes('{'); });
    assert.ok(apRules.length > 0, '应有 .ap-* 样式规则（网申包页样式）');
    for (const line of apRules) {
      assert.ok(!/box-shadow/.test(line), '应用页新写规则不得有 box-shadow（§3.1 静态层级零阴影），实际：' + line.trim());
      assert.ok(!/border-radius:\s*\d/.test(line), '圆角必须走 --radius/--radius-lg token（§5.2），实际：' + line.trim());
      const badSpacing = line.match(/(?:padding|margin|gap)(?:-(?:top|right|bottom|left))?:\s*[^;{}]*\d+px/g) || [];
      assert.deepEqual(badSpacing, [], '新写规则的间距必须用 --space-* token（§5.1），实际：' + JSON.stringify(badSpacing) + ' @ ' + line.trim());
    }
    // 页题不挂解释性小字（§9.1-2）：h1 之后不接复述页题的说明段
    const html = (await get('/apply-profile')).text;
    const paras = html.replace(/<script[\s\S]*?<\/script>/g, '').match(/<p style="[^"]*">[\s\S]*?<\/p>/g) || [];
    const echo = paras.filter((p) => p.includes('网申包') && p.includes('字段'));
    assert.deepEqual(echo, [], '页面说明不得复述页题/卡标题（§9.1-2），实际：' + echo.join(' || '));
  }

  console.log('✅ 网申包页面：/apply-profile + 投递系页签条「网申包」项（topnav 4 链接）+ 三态字段 UI + 漂移提示 + 单字段复制 + 整包导出（纯文本/JSON）+ 写路径真点一遍（作用范围两种形状 + 手动改写→保存/恢复跟随/独立字段保存 200 且落盘）');
} catch (e) {
  console.error('❌ ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  cleanup();
}
