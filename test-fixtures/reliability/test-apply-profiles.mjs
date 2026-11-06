// test-apply-profiles.mjs — 网申包数据层（批 3 · 卡片 b3c1）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4 批 3「S8 网申包 + 跟进助手」；上位路线图 S8。
// 合同（本卡只管数据层，页面/AI 文案/导出/跟进助手不在本卡）：
//   ① 账本 = RESUME_ROOT/apply-profiles.json（通用信息表 + 按公司字段包）；读写走既有 tx 纪律
//      （跨进程锁内读最新 → 唯一临时 + 原子 rename；落盘 0600；不留临时文件）。
//   ② 字段三态：跟随来源（母版派生纯文本）/ 手动覆写 / 恢复跟随（动作：重新同步来源并清漂移）。
//   ③ 来源变更标漂移：漂移时已同步的值不被静默改写（漂移只是提示，不是自动覆盖）。
//   ④ 期望薪资等独立字段不从简历派生：简历改动永不覆盖；独立字段无来源 → 拒绝「恢复跟随」。
//   ⑤ 损坏停写：解析失败或形状错 → 写抛 CORRUPT（httpCode 500），原文件不被覆盖；读降级并标记。
//   ⑥ 服务启动不改写账本（隔离根 + 随机端口 + 合成文档；零真实数据）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';
import {
  APPLY_PROFILES_FILE, FIELD_CATALOG, MODE_FOLLOW, MODE_OVERRIDE, MODE_MANUAL,
  STATE_FOLLOW, STATE_DRIFT, STATE_OVERRIDE, STATE_MANUAL,
  emptyProfiles, loadApplyProfiles, saveApplyProfiles, updateApplyProfiles,
  deriveResumeFields, resolveProfiles, setField, setFieldSource,
  bindCommonMaster, ensurePackage,
} from '../../apply-profile.mjs';
import { updateJsonLedger } from '../../tx.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-appprof-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const ledgerPath = path.join(root, APPLY_PROFILES_FILE);

// —— 合成母版（两份：通用母版 + 岗位简历）——
// 隐私门禁：夹具里不出现 1[3-9] 开头的 11 位长数字（电话用座机号，邮箱用 example.invalid）。
const MASTER = 'doc-master';
const JOB = 'doc-job';
function entry(title, role, date, bullet) {
  return `<div class="entry-head" style="margin-top:1.6mm">
  <div class="entry-title">${title}</div>
  <div class="entry-role">${role}</div>
  <div class="entry-date">${date}</div>
</div>
<ul>
  <li>${bullet}</li>
</ul>`;
}
function buildDoc(id, name, summary, work, edu) {
  let doc = assembleTemplate('classic');
  const map = {
    '{{NAME}}': name,
    '{{CONTACT}}': '座机：021-5555-6666 邮箱：tester@example.invalid',
    '{{INTENT}}': '后端工程师',
    '{{SUMMARY}}': summary,
    '{{SKILLS}}': '<p><strong>语言：</strong>Go / Python</p>',
    '{{WORK}}': work,
    '{{PROJECTS}}': '<p>项目一：负责交易系统</p>',
    '{{EDU}}': edu,
    '{{DOC_ID}}': id,
  };
  for (const [k, v] of Object.entries(map)) doc = doc.replaceAll(k, () => v);
  return doc;
}
const MASTER_V1 = buildDoc(MASTER, '合成姓名', '合成自评一段', entry('合成公司', '后端工程师', '2021-03', '负责交易系统'), entry('合成大学', '计算机', '2017-06', ''));
const MASTER_V2 = buildDoc(MASTER, '改后姓名', '改后自评一段', entry('合成公司', '后端工程师', '2021-03', '负责交易系统与风控'), entry('合成大学', '计算机', '2017-06', ''));
const JOB_V1 = buildDoc(JOB, '岗位姓名', '岗位自评一段', entry('岗位公司', '后端工程师', '2022-05', '负责网关'), entry('岗位大学', '软件工程', '2018-06', ''));
const JOB_V2 = buildDoc(JOB, '改名岗位姓名', '岗位自评一段', entry('岗位公司', '后端工程师', '2022-05', '负责网关'), entry('岗位大学', '软件工程', '2018-06', ''));
fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), MASTER_V1);
fs.writeFileSync(path.join(root, 'docs', JOB + '.html'), JOB_V1);
const readDoc = (id) => fs.readFileSync(path.join(root, 'docs', id + '.html'), 'utf8');
const derivedMaster = () => deriveResumeFields(readDoc(MASTER));
const derivedJob = () => deriveResumeFields(readDoc(JOB));
const resolver = () => ({ derived: (docId) => (docId === MASTER ? derivedMaster() : docId === JOB ? derivedJob() : null) });

let server = null;
const cleanup = () => {
  try { if (server) server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

try {
  // ===== ① 缺省账本：读不建文件、形状完整 =====
  {
    const l0 = loadApplyProfiles(root);
    assert.equal(l0.corrupt, false, '缺省账本不应判损坏');
    assert.equal(l0.error, null);
    assert.equal(l0.data.version, 1, '缺省账本版本号');
    assert.deepEqual(l0.data.common.fields, {}, '缺省通用表应无字段');
    assert.deepEqual(l0.data.packages, {}, '缺省应无公司包');
    assert.ok(!fs.existsSync(ledgerPath), '读缺省账本不得创建文件');
    assert.deepEqual(emptyProfiles().packages, {});
  }

  // ===== ② 母版派生纯文本（跟随来源的取值口径）=====
  {
    const d = derivedMaster();
    assert.equal(d.name, '合成姓名', '姓名应来自 h1');
    assert.ok(d.email.includes('tester@example.invalid'), '邮箱应来自联系方式块，实际：' + d.email);
    assert.ok(d.phone.includes('021-5555-6666'), '电话应来自联系方式块，实际：' + d.phone);
    assert.ok(d.selfIntro.includes('合成自评一段'), '自评应来自「个人总结」章节，实际：' + d.selfIntro);
    assert.ok(d.work.includes('合成公司'), '工作经历应来自「工作经历」章节');
    assert.ok(d.work.includes('负责交易系统'), '工作经历应含条目正文');
    assert.ok(d.education.includes('合成大学'), '教育经历应来自「教育经历」章节');
    assert.ok(d.skills.includes('Go'), '专业技能应来自「专业技能」章节');
    assert.ok(!('expectedSalary' in d), '期望薪资是独立字段，不得从简历派生');
    const cat = FIELD_CATALOG.find((f) => f.key === 'expectedSalary');
    assert.equal(cat.derived, false, '期望薪资在字段目录里应登记为独立字段');
    // 章节标题不进文本（派生文本只取章节正文，不含标题）
    assert.ok(!d.work.includes('工作经历'), '派生文本不应含章节标题「工作经历」，实际：' + JSON.stringify(d.work));
    assert.ok(!d.education.includes('教育经历'), '派生文本不应含章节标题「教育经历」，实际：' + JSON.stringify(d.education));
    // 隐藏章节不参与派生（ed-sec-hidden 标记的 section 整段不算）
    const HIDDEN_WORK = MASTER_V1.replace(/(<section class="section")(\s*>\s*<div class="section-title">工作经历<\/div>)/, '$1 ed-sec-hidden$2');
    assert.notEqual(HIDDEN_WORK, MASTER_V1, '隐藏章节构造应真的改动了文档（否则下列断言空转）');
    const hd = deriveResumeFields(HIDDEN_WORK);
    assert.equal(hd.work, '', '隐藏章节不得参与派生，实际：' + JSON.stringify(hd.work));
    assert.equal(hd.name, '合成姓名', '隐藏章节不应影响其它字段的派生');
  }

  // ===== ③ 绑定母版 → 通用表跟随来源首次同步 =====
  {
    bindCommonMaster(root, MASTER);
    const d = loadApplyProfiles(root).data;
    assert.equal(d.common.sourceDocId, MASTER, '通用表应记母版文档 id');
    assert.equal(d.common.fields.name.mode, MODE_FOLLOW, '默认态应为跟随来源');
    assert.equal(d.common.fields.name.syncedText, '合成姓名', '首次同步应写入来源派生文本');
    const r = resolveProfiles(d, resolver());
    assert.equal(r.common.fields.name.state, STATE_FOLLOW, '未改来源时不应漂移');
    assert.equal(r.common.fields.name.value, '合成姓名', '跟随来源的值应等于同步值');
    assert.equal(r.common.fields.name.drift, false);
  }

  // ===== ④ 手动覆写：值取手填，来源变更也不动 =====
  {
    setField(root, { kind: 'common' }, 'name', MODE_OVERRIDE, { value: '手写姓名' });
    const r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.common.fields.name.state, STATE_OVERRIDE, '手动覆写态');
    assert.equal(r.common.fields.name.value, '手写姓名', '覆写值应生效');
  }

  // ===== ⑤ 来源变更 → 标漂移（跟随来源实时取当前值；「已确认快照」不被静默改写）=====
  {
    fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), MASTER_V2);
    const r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.common.fields.work.state, STATE_DRIFT, '来源变更的跟随字段应标漂移');
    assert.equal(r.common.fields.work.drift, true);
    assert.ok(r.common.fields.work.value.includes('风控'), '跟随来源应实时取母版当前派生文本');
    // 漂移基准 = 上次确认过的来源快照（未确认前仍记着旧版，不被悄悄换掉）
    const raw = loadApplyProfiles(root).data;
    assert.ok(raw.common.fields.work.syncedText.includes('负责交易系统'), '未确认前同步快照仍是旧来源文本');
    assert.ok(!raw.common.fields.work.syncedText.includes('风控'), '未确认前同步快照不得被悄悄替换');
    assert.equal(r.common.fields.name.state, STATE_OVERRIDE, '覆写字段不受来源变更影响');
    assert.equal(r.common.fields.name.value, '手写姓名', '覆写值不被来源变更覆盖');
  }

  // ===== ⑥ 恢复跟随：重新取来源、确认快照、清漂移 =====
  {
    setField(root, { kind: 'common' }, 'name', MODE_FOLLOW);
    let r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.common.fields.name.state, STATE_FOLLOW, '恢复跟随后不应漂移');
    assert.equal(r.common.fields.name.value, '改后姓名', '恢复跟随应取当前来源派生文本');
    assert.equal(r.common.fields.name.drift, false);
    assert.equal(r.common.fields.work.state, STATE_DRIFT, '未确认的来源变更应继续标漂移');
    setField(root, { kind: 'common' }, 'work', MODE_FOLLOW);
    r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.common.fields.work.state, STATE_FOLLOW, '确认后应清漂移');
    assert.equal(r.common.fields.work.drift, false);
  }

  // ===== ⑦ 独立字段（期望薪资等）：不从简历派生、简历改动永不覆盖、无源不可恢复跟随 =====
  {
    setField(root, { kind: 'common' }, 'expectedSalary', MODE_MANUAL, { value: '面议 30-40 万' });
    const r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.common.fields.expectedSalary.state, STATE_MANUAL, '独立字段应为独立维护态');
    assert.equal(r.common.fields.expectedSalary.value, '面议 30-40 万');
    assert.equal(r.common.fields.expectedSalary.drift, false, '独立字段不参与漂移');
    // 母版再改 → 独立字段不变
    fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), MASTER_V1);
    const r2 = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r2.common.fields.expectedSalary.value, '面议 30-40 万', '独立字段不得被简历改动覆盖');
    // 派生字段不得设为独立维护（否则等于绕过「跟随来源」）
    assert.throws(
      () => setField(root, { kind: 'common' }, 'name', MODE_MANUAL, { value: 'x' }),
      (e) => e && e.code === 'APPLY_FIELD_NOT_MANUAL',
      '派生字段应拒绝设为独立维护'
    );
    // 独立字段没有来源 → 拒绝恢复跟随
    assert.throws(
      () => setField(root, { kind: 'common' }, 'expectedSalary', MODE_FOLLOW),
      (e) => e && e.code === 'APPLY_FIELD_NOT_FOLLOWABLE',
      '独立字段应拒绝恢复跟随'
    );
  }

  // ===== ⑧ 按公司字段包：跟随通用表 / 跟随岗位简历 / 手动覆写（与通用表互不串味）=====
  {
    const pkg = ensurePackage(root, { company: '合成公司', role: '后端工程师' });
    const pid = pkg.id;
    assert.ok(pid, '公司包应有稳定 id');
    // 默认跟随通用表
    setField(root, { kind: 'package', id: pid }, 'name', MODE_FOLLOW);
    let r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.packages[pid].fields.name.value, '合成姓名', '公司包默认跟随通用表当前值');
    // 通用表改名 → 包内跟随值跟着变（跟随链）
    setField(root, { kind: 'common' }, 'name', MODE_OVERRIDE, { value: '通用表手写' });
    r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.packages[pid].fields.name.value, '通用表手写', '公司包跟随通用表应读到通用表当前值');
    // 包内手动覆写 → 与通用表解耦
    setField(root, { kind: 'package', id: pid }, 'name', MODE_OVERRIDE, { value: '包内手写' });
    r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.packages[pid].fields.name.state, STATE_OVERRIDE);
    assert.equal(r.packages[pid].fields.name.value, '包内手写');
    setField(root, { kind: 'common' }, 'name', MODE_OVERRIDE, { value: '通用表又改了' });
    r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.packages[pid].fields.name.value, '包内手写', '包内覆写不受通用表变更影响');
    // 切换来源到岗位简历 → 值取岗位简历派生文本
    setFieldSource(root, { kind: 'package', id: pid }, 'name', { kind: 'resume', docId: JOB });
    setField(root, { kind: 'package', id: pid }, 'name', MODE_FOLLOW);
    r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.packages[pid].fields.name.value, '岗位姓名', '切到岗位简历后应取该简历派生文本');
    assert.equal(r.packages[pid].company, '合成公司', '公司包应记公司名');
    assert.equal(r.packages[pid].role, '后端工程师', '公司包应记岗位名');
    // 岗位简历变更 → 包内跟随字段标漂移（来源变更只提示；已确认快照不被静默改写）
    fs.writeFileSync(path.join(root, 'docs', JOB + '.html'), JOB_V2);
    r = resolveProfiles(loadApplyProfiles(root).data, resolver());
    assert.equal(r.packages[pid].fields.name.state, STATE_DRIFT, '岗位简历变更后包内跟随字段应标漂移');
    assert.ok(r.packages[pid].fields.name.value.includes('改名'), '跟随来源应实时取岗位简历当前派生文本，实际：' + r.packages[pid].fields.name.value);
    assert.ok(!loadApplyProfiles(root).data.packages[pid].fields.name.syncedText.includes('改名'),
      '未确认前已确认快照不得被静默改写，实际：' + loadApplyProfiles(root).data.packages[pid].fields.name.syncedText);
    // 条目 source 结构落盘 + 公司包 sourceDocId 持久化（已有包只补空字段 → 不新建第二个包）
    const rawPkg = loadApplyProfiles(root).data;
    assert.deepEqual(rawPkg.packages[pid].fields.name.source, { kind: 'resume', docId: JOB }, '条目 source 结构应落盘');
    const pkg2 = ensurePackage(root, { company: '合成公司', role: '后端工程师', sourceDocId: JOB });
    assert.equal(pkg2.id, pid, '同公司同岗位应得同一包 id（稳定）');
    assert.equal(pkg2.sourceDocId, JOB, '公司包 sourceDocId 应回读一致');
    assert.equal(loadApplyProfiles(root).data.packages[pid].sourceDocId, JOB, '公司包 sourceDocId 应落盘');
    assert.equal(Object.keys(loadApplyProfiles(root).data.packages).length, 1, '补 sourceDocId 不应新建第二个包');
  }

  // ===== ⑨ tx 纪律：锁内读最新 + 原子写 + 0600 + 无临时残留 =====
  {
    setField(root, { kind: 'common' }, 'skills', MODE_OVERRIDE, { value: '技能手写一' });
    setField(root, { kind: 'common' }, 'education', MODE_OVERRIDE, { value: '教育手写一' });
    const d = loadApplyProfiles(root).data;
    assert.equal(d.common.fields.skills.override, '技能手写一', '第二次写不应回退第一次的写');
    assert.equal(d.common.fields.education.override, '教育手写一');
    const st = fs.statSync(ledgerPath);
    assert.equal(st.mode & 0o777, 0o600, '账本落盘权限应为 0600，实际：' + (st.mode & 0o777).toString(8));
    const leftovers = fs.readdirSync(root).filter((f) => f.includes(APPLY_PROFILES_FILE) && f !== APPLY_PROFILES_FILE);
    assert.deepEqual(leftovers, [], '原子写不得留临时文件残留，实际：' + JSON.stringify(leftovers));
    // 通用表与公司包同表共存
    assert.ok(Object.keys(d.packages).length === 1, '公司包应与通用表同表共存');
    // updatedAt 落盘（可解析时间戳）
    assert.ok(typeof d.updatedAt === 'string' && d.updatedAt !== '', '账本应落 updatedAt，实际：' + JSON.stringify(d.updatedAt));
    assert.ok(!Number.isNaN(Date.parse(d.updatedAt)), 'updatedAt 应是可解析时间戳，实际：' + d.updatedAt);
  }

  // ===== ⑩ 服务启动不改写账本（隔离根 + 随机端口）=====
  {
    const before = fs.readFileSync(ledgerPath, 'utf8');
    const beforeMtime = fs.statSync(ledgerPath).mtimeMs;
    const port = await new Promise((res) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
    });
    server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
      cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', (d) => { log += d; });
    server.stderr.on('data', (d) => { log += d; });
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/`); if (r.ok) { ready = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, '服务 30s 未就绪\n' + log.slice(-600));
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), before, '服务启动不得改写网申包账本');
    assert.equal(fs.statSync(ledgerPath).mtimeMs, beforeMtime, '服务启动不得触碰账本 mtime');
    server.kill('SIGKILL');
    server = null;
  }

  // ===== ⑪ 损坏停写（口径对齐其它 JSON 账本）=====
  {
    const raw = fs.readFileSync(ledgerPath, 'utf8');
    fs.writeFileSync(ledgerPath, '{ 这不是合法 JSON');
    const l = loadApplyProfiles(root);
    assert.equal(l.corrupt, true, '非法 JSON 应判损坏');
    assert.ok(l.error && l.error.code === 'CORRUPT', '读侧应带 CORRUPT 标记');
    assert.equal(l.data.version, 1, '读侧损坏时降级为空结构，不抛异常');
    assert.throws(
      () => saveApplyProfiles(root, emptyProfiles()),
      (e) => e && e.code === 'CORRUPT' && e.httpCode === 500,
      '损坏账本必须停写'
    );
    assert.throws(
      () => updateApplyProfiles(root, (d) => d),
      (e) => e && e.code === 'CORRUPT',
      '损坏账本必须停写（RMW 同口径）'
    );
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), '{ 这不是合法 JSON', '损坏文件不得被覆盖');
    // 形状错（根值是数组）同口径
    fs.writeFileSync(ledgerPath, '[]');
    assert.equal(loadApplyProfiles(root).corrupt, true, '根值形状错应判损坏');
    assert.throws(
      () => saveApplyProfiles(root, emptyProfiles()),
      (e) => e && e.code === 'CORRUPT',
      '形状错必须停写'
    );
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), '[]', '形状错文件不得被覆盖');
    // 恢复成好文件后可继续写
    fs.writeFileSync(ledgerPath, raw);
    saveApplyProfiles(root, loadApplyProfiles(root).data);
    assert.equal(loadApplyProfiles(root).corrupt, false, '修好后应恢复可写');
  }

  // ===== ⑫ 通用账本事务的形状护栏（与 updateMetaAll 同款）：mutator 返回非对象 → 抛错不落盘 =====
  {
    const probeFile = 'probe-ledger.json';
    assert.throws(
      () => updateJsonLedger(root, probeFile, () => []),
      /必须返回对象/,
      '通用账本事务的 mutator 返回非对象应抛错（否则整表写成非对象 → 下次读即判损坏）'
    );
    assert.ok(!fs.existsSync(path.join(root, probeFile)), '抛错后不得落盘（账本不得被写成非对象）');
  }

  console.log('✅ 网申包数据层：通用表+公司包同表、三态（跟随/覆写/恢复跟随）、漂移标记（含包内跟随岗位简历）、独立字段不从简历派生、隐藏章节不派生/标题不进文本、条目 source 与包内 sourceDocId 落盘、updatedAt 落盘、损坏停写、tx 纪律落盘与形状护栏');
} catch (e) {
  fail((e && e.stack) || String(e));
}
