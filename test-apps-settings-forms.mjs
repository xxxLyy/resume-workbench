// test-apps-settings-forms.mjs — R3 投递看板与设置页：label 可访问性 / 消除 prompt 链 / 设置空态说明卡
// 覆盖（断言逐条独立）：
//   A. 投递看板（/applications 看板视图）：所有可见 input/select/textarea 有可访问名
//      （aria-label / aria-labelledby / label 包裹，简化的可访问名计算）——含「新增投递」表单与行内编辑表单。
//   B. 投递卡脚本不含 prompt( 调用（✎ 快速编辑 = 行内小表单，展开即改、取消即收）；全程零 prompt 对话框。
//   C. 行内编辑走既有 /app/update 契约：{company, role, note, jd, dueDate} 提交，其余字段（docId/channel/appliedAt/status）原样保留。
//   D. 新增投递表单走既有 /app/add 契约：字段形状与落库不变（status 默认 applied=已投递、archive 照旧生成）。
//   E. 设置页：h1 为「设置」；无配置时 #settingsGuide 说明卡在场（点「添加配置」后隐藏），
//      有配置（种子 config.json）时不渲染；全部控件有可访问名（含 inp() label 包裹与备份文件选择）。
// 阴性对照：临时解除 inp() 的 label 包裹 → E 转红（单独跑）。
// 约束：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档与投递；不读真实数据、不碰 7766、不调真实模型。
// 退出码契约：0=全部通过；1=任一断言失败；2=仅 Chromium 环境不可用且此前无失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from './chromium.mjs';
import { assembleTemplate } from './template.mjs';

const APP_ROOT = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-apps-settings-' + tag + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
};
const writeDoc = (root, id) => {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', ''],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) doc = doc.replaceAll(k, () => v);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  const metaPath = path.join(root, 'docs-meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  meta[id] = { rev: 1, flow: 'draft' };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
};
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const startServer = async (root) => {
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
    cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪');
  }
  return { base, kill: () => { try { server.kill('SIGKILL'); } catch {} } };
};
// 简化可访问名计算：aria-label → aria-labelledby → 包裹 label 文本；排除隐藏控件（ARIA 快照同口径）
const ACC_AUDIT = () => {
  const named = (el) => {
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return al.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent.trim()).join(' ');
      if (t) return t;
    }
    const lbl = el.closest('label');
    if (lbl) { const t = lbl.textContent.replace(/\s+/g, ' ').trim(); if (t) return t; }
    return '';
  };
  return Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => {
    if (el.type === 'hidden') return false;
    if (el.closest('[hidden]')) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden';
  }).map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '', name: named(el) }));
};
const assertAllNamed = (controls, where) => {
  const anon = controls.filter((c) => !c.name);
  assert.deepEqual(anon, [], `${where} 存在无可访问名的控件：` + JSON.stringify(anon));
};

const rootMain = mkRoot('main');
const rootCfg = mkRoot('cfg');
const cleanupAll = () => {
  for (const r of [rootMain, rootCfg]) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
};
process.on('exit', cleanupAll);

let browser = null;
const servers = [];
try {
  writeDoc(rootMain, 'doc1');
  // 合成投递：/app/update 编辑回归的锚点（channel/appliedAt/docId/status 应跨编辑保留）
  fs.writeFileSync(path.join(rootMain, 'applications.json'), JSON.stringify([
    { id: '2026-01-01-000000-001', company: '甲公司', role: '乙岗位', docId: 'doc1', jd: '原JD', note: '原备注',
      channel: '内推', link: '', appliedAt: '2026-01-02', nextStep: '', dueDate: '', status: '已投递',
      createdAt: '2026-01-01-000000-001', updatedAt: '2026-01-01-000000-001', interviews: [] }
  ]));
  // rootCfg：种子一份配置（③「有配置时不出现」的对照根）
  fs.writeFileSync(path.join(rootCfg, 'config.json'), JSON.stringify(
    { active: 0, profiles: [{ name: '种子配置', baseURL: 'https://example.invalid/v1', apiKey: 'stub-key-not-real', model: 'stub-model' }] }));

  let bin = null;
  try { bin = await resolveChromium(); }
  catch (e) { cleanupAll(); console.log('⚠️  Chromium 不可用，跳过：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  const dialogs = [];
  ctx.on('page', (p) => p.on('dialog', (d) => { dialogs.push(d.type()); d.accept().catch(() => {}); }));
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));

  // ===== A/B：投递看板 =====
  const s1 = await startServer(rootMain); servers.push(s1);
  await page.goto(s1.base + '/applications');
  await page.waitForSelector('.app-card', { timeout: 15000 });
  assertAllNamed(await page.evaluate(ACC_AUDIT), '投递看板');
  const scriptText = await page.evaluate(() => Array.from(document.scripts).map((s) => s.textContent).join('\n'));
  assert.ok(!scriptText.includes('prompt('), '投递卡脚本不得再调用 prompt(（快速编辑应为行内表单），实际脚本含 prompt：'
    + (scriptText.split('\n').find((l) => l.includes('prompt(')) || '').trim().slice(0, 120));
  assert.ok(scriptText.includes('appPatch') && scriptText.includes('appEdit'), '投递卡脚本应保留 appEdit/appPatch 入口（行为语义不变）');

  // ===== C：行内编辑（✎ 展开即改、取消即收）→ /app/update 契约 =====
  await page.click('button[aria-label="快速编辑"]');
  await page.waitForSelector('.app-card .app-edit', { state: 'visible', timeout: 5000 });
  assertAllNamed(await page.evaluate(ACC_AUDIT), '投递看板（行内编辑展开后）');
  assert.equal(await page.inputValue('.app-card [data-edit="company"]'), '甲公司', '行内编辑应预填当前值');
  await page.fill('.app-card [data-edit="company"]', '甲公司改');
  await page.fill('.app-card [data-edit="note"]', '备注已更新');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 20000 }),
    page.click('.app-card .app-edit button:has-text("保存")')
  ]);
  const appsAfterEdit = JSON.parse(fs.readFileSync(path.join(rootMain, 'applications.json'), 'utf8'));
  const edited = appsAfterEdit.find((a) => a.id === '2026-01-01-000000-001');
  assert.ok(edited, '编辑后投递记录应仍在');
  assert.equal(edited.company, '甲公司改', '行内编辑公司应落库（/app/update 契约不变）');
  assert.equal(edited.note, '备注已更新', '行内编辑备注应落库');
  assert.equal(edited.role, '乙岗位', '未改字段应原样保留');
  assert.equal(edited.jd, '原JD', '未改字段应原样保留');
  assert.equal(edited.channel, '内推', '表单外字段（channel）不得被编辑表单抹掉');
  assert.equal(edited.appliedAt, '2026-01-02', '表单外字段（appliedAt）不得被编辑表单抹掉');
  assert.equal(edited.docId, 'doc1', '表单外字段（docId）不得被编辑表单抹掉');
  // 六态模型（UPCV §1）：存量 '已投递' 读侧归一为 applied；本次保存把它落成新枚举（写侧只写新枚举，语义不变）
  assert.equal(edited.status, 'applied', '状态不得被编辑表单改动（老枚举经归一写回为 applied）');

  // ===== C-取消：取消即收（不发请求）=====
  await page.click('button[aria-label="快速编辑"]');
  await page.waitForSelector('.app-card .app-edit', { state: 'visible', timeout: 5000 });
  await page.fill('.app-card [data-edit="company"]', '不该落库的值');
  await page.click('.app-card .app-edit button:has-text("取消")');
  assert.equal(await page.evaluate(() => { const b = document.querySelector('.app-card .app-edit'); return b ? b.hidden : 'missing'; }), true, '取消后行内编辑应收起');

  // ===== D：新增投递（label 关联表单）→ /app/add 契约 =====
  await page.click('#appAddBox summary');
  await page.fill('#company', '看板公司');
  await page.fill('#role', '看板岗位');
  await page.fill('#channel', '官网');
  await page.fill('#jd', '看板JD');
  await page.fill('#note', '看板备注');
  await page.fill('#nextStep', '准备面试');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),   // /app/add 会同步渲染存档 PDF，耗时较长
    page.click('#appForm button:has-text("添加")')
  ]);
  const appsAfterAdd = JSON.parse(fs.readFileSync(path.join(rootMain, 'applications.json'), 'utf8'));
  const added = appsAfterAdd.find((a) => a.company === '看板公司');
  assert.ok(added, '新投递应落库');
  assert.equal(added.role, '看板岗位', '岗位应按原契约落库');
  assert.equal(added.channel, '官网', '渠道应按原契约落库');
  assert.equal(added.jd, '看板JD', 'JD 应按原契约落库');
  assert.equal(added.note, '看板备注', '备注应按原契约落库');
  assert.equal(added.nextStep, '准备面试', '下一步应按原契约落库');
  assert.equal(added.docId, 'doc1', '简历应按原契约落库');
  assert.equal(added.status, 'applied', '新投递默认状态应为 applied=已投递（六态模型，写侧只写新枚举）');
  assert.equal(added.appliedAt, '', '未填的投递日期应为空串（形状零变化）');

  // ===== E：设置页（rootMain 无 config.json → 空态说明卡在场）=====
  await page.goto(s1.base + '/settings');
  const h1 = (await page.textContent('h1')).trim();
  assert.equal(h1, '设置', '设置页 h1 应为「设置」（topnav 已叫设置，名实一致），实际：' + h1);
  assert.ok(await page.isVisible('#settingsGuide'), '无配置时应在 #cards 上方渲染说明卡');
  const guideText = await page.textContent('#settingsGuide');
  for (const bit of ['config.json', 'Base URL', 'API Key', '测试连接']) {
    assert.ok(guideText.includes(bit), '说明卡应解释 ' + bit + '，实际：' + guideText.slice(0, 200));
  }
  assertAllNamed(await page.evaluate(ACC_AUDIT), '设置页（空态）');
  // 「添加配置」后说明卡隐藏（有配置时不出现，含不刷新的动态路径）
  await page.click('#addBtn');
  await page.waitForSelector('#cards .card', { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.getElementById('settingsGuide').hidden), true, '添加配置后说明卡应隐藏');
  assertAllNamed(await page.evaluate(ACC_AUDIT), '设置页（添加配置后）');

  // ===== E-对照根：种子配置 → 说明卡不渲染 =====
  const s2 = await startServer(rootCfg); servers.push(s2);
  await page.goto(s2.base + '/settings');
  assert.equal((await page.textContent('h1')).trim(), '设置', '种子配置根的设置页 h1 应为「设置」');
  assert.equal(await page.evaluate(() => !!document.getElementById('settingsGuide')), false, '有配置时说明卡不得渲染');
  assertAllNamed(await page.evaluate(ACC_AUDIT), '设置页（有配置）');
  assert.ok(await page.isVisible('input[type="password"]'), 'API Key 输入应存在（type=password 保留）');

  // ===== 全程零 prompt 对话框 + 零页面异常 =====
  assert.ok(!dialogs.includes('prompt'), '全程不得出现 prompt 对话框：' + JSON.stringify(dialogs));
  assert.deepEqual(pageErrors, [], '不得有页面异常：' + JSON.stringify(pageErrors));

  console.log('✅ R3 表单与可访问性：两页控件全有可访问名、投递卡无 prompt( 且行内编辑/取消与 /app/update·/app/add 契约不变、设置 h1=设置、空态说明卡在场/配置后消失');
} catch (e) {
  console.error('❌ ' + (e && e.message || e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const s of servers) s.kill();
  cleanupAll();
}
