// test-content-check.mjs — 批 2「确定性内容检查」卡片 b2c1（S4a ⑪ 补课 · 纯规则零 AI）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §3 批 2（ATS 诚实检查包 · 确定性内容检查）
//      + §0.1（诚实版：规则检查 + 文本层预览；不做「通过」徽章；不做 ATS 打分 / 录用概率）
//      + dev-docs/2026-09-23-roadmap-magazine-and-features.md §3.1 ⑪（六类 + 三级；「熟悉/精通」大量重复仅风格建议）
// 覆盖（断言逐条独立，便于逐条复核）：
//   A 六类命中（正例文档）：公司/项目名写法不一致 / 日期格式不统一 / 日期明显倒序 /
//     联系方式格式异常（邮箱 + 电话）/ 链接格式错误（协议写错 + 缺协议头）/ 重复段落 / 未替换占位符。
//   B 三级分类：需修复 / 建议核对 / 风格建议 各归其位；「精通」大量重复只落风格建议（不进需修复）。
//   C 阴性对照：干净文档零需修复、零建议核对、零风格建议（不误报是本卡的另一半合同）。
//   D 单一通道：导出页检查卡新分区 与 审阅 Tab「导出检查」段 同源同结果（同一实现、同一份数据）。
//   E 纯函数契约：contentChecks() 单模块六类 + 三级的最小直调用（不经 HTTP）。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档；不读真实简历、不碰 7766、不调真实模型；仓库零写入。
// 隐私门禁：合成数据不含 11 位手机号形态（1[3-9]\d{9}）与 13 位时间戳（长数字第二位避开 3-9）。
// 退出码契约：0=全部通过；1=任一断言失败；2=仅 Chromium 不可用且此前无失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { freezeHtml } from '../../freeze.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-content-check-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });

// ===== 合成文档 =====
// 正例：六类问题各埋一处（+ 阴性对照文档零问题）。
const entry = (title, role, date, bullets) =>
  `<div class="entry-head"><div class="entry-title">${title}</div><div class="entry-role">${role}</div><div class="entry-date">${date}</div></div>\n      <ul>\n${bullets.map((b) => `<li>${b}</li>`).join('\n')}\n      </ul>`;

const BAD = {
  name: '合成简历甲',
  contact: '邮箱：synth@@example.com ｜ 电话：1381234 ｜ 主页：htt://synth.example.com/me ｜ 作品集：www.synth.example.com',
  summary: '合成个人总结',
  skills: '<p>后端开发：Go / 分布式</p>',
  work: entry('合成甲科技有限公司', '后端工程师', '2023.07 - 至今', [
    '负责合成平台的接口性能优化与稳定性建设',
    '精通 Go 与分布式系统设计，精通服务治理，精通容量规划'
  ]) + '\n\n' + entry('合成甲科技', '高级后端工程师', '2024年3月 - 2024年9月', [
    '负责合成平台的接口性能优化与稳定性建设',
    '熟悉 Kubernetes 与可观测性体系'
  ]),
  projects: entry('合成调度平台', '负责人', '2024.09 - 2024.02', ['办公地址：{{公司地址}}']),
  edu: entry('合成大学', '本科 · 计算机', '2019.09 - 2023.06', [])
};

const CLEAN = {
  name: '合成简历乙',
  contact: '邮箱：clean@example.com ｜ 电话：010-88886666 ｜ 主页：https://clean.example.com/me',
  summary: '合成个人总结',
  skills: '<p>后端开发：Go / 分布式</p>',
  work: entry('合成甲公司', '后端工程师', '2023.07 - 2024.03', [
    '负责合成平台的接口性能优化与稳定性建设',
    '精通 Go 与分布式系统设计，熟悉服务治理'
  ]) + '\n\n' + entry('合成乙公司', '平台工程师', '2024.04 - 2025.03', [
    '负责合成平台的容量规划与成本治理'
  ]),
  projects: entry('合成调度平台', '负责人', '2024.05 - 2024.10', ['建设合成调度平台的核心链路与灰度能力']),
  edu: entry('合成大学', '本科 · 计算机', '2019.09 - 2023.06', [])
};

const buildDoc = (docId, d) => {
  let doc = assembleTemplate('classic');
  const map = [['{{NAME}}', d.name], ['{{CONTACT}}', d.contact], ['{{INTENT}}', ''], ['{{SUMMARY}}', d.summary],
    ['{{SKILLS}}', d.skills], ['{{WORK}}', d.work], ['{{PROJECTS}}', d.projects], ['{{EDU}}', d.edu], ['{{DOC_ID}}', docId]];
  for (const [k, v] of map) doc = doc.replaceAll(k, () => v);
  return doc;
};

const BAD_ID = 'ccbad';
const CLEAN_ID = 'ccclean';   // 合法 id（VALID_ID = /^[a-z0-9][a-z0-9-]*$/）
const metaPath = path.join(root, 'docs-meta.json');
const seed = (id, d) => {
  const doc = buildDoc(id, d);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  // 合成 PDF（非真实渲染）：导出页不触发自动重渲（staleInfo 判 fresh），本夹具无 Chromium 依赖也不需真渲染
  fs.writeFileSync(path.join(root, 'pdfs', id + '.pdf'), '%PDF-1.4\n% fake pdf for http fixture\n');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  meta[id] = {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} }
  };
  meta[id].lastRenderInputId = freezeHtml(doc, meta[id]).renderInputId;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
};
seed(BAD_ID, BAD);
seed(CLEAN_ID, CLEAN);

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
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
const base = `http://127.0.0.1:${port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const getJson = async (p) => { const r = await fetch(base + p); return { status: r.status, json: await r.json().catch(() => null) }; };

// ===== 期望的判定文案（实现与断言同源；断言用「三级集合全等」，措辞改动必须两侧同步）=====
const EXPECT = {
  fix: [
    '联系方式格式异常：邮箱「synth@@example.com」不是合法邮箱格式',
    '联系方式格式异常：电话「1381234」不像手机号（11 位）或固定电话（0 区号 + 7-8 位）',
    '链接格式错误：协议写成「htt://」（应为 http:// 或 https://）',
    '未替换占位符：「{{公司地址}}」',
    '日期明显倒序：「2024.09 - 2024.02」（结束早于开始）',
    '重复段落：同一段文字出现 2 次（「负责合成平台的接口性能优化与稳定性建设」）'
  ],
  verify: [
    '公司/项目名写法不一致：「合成甲科技有限公司」与「合成甲科技」',
    '日期格式不统一：共 2 种写法（2023.07（YYYY.MM）、2024年3月（YYYY年M月））',
    '链接缺协议头：「www.synth.example.com」导出后不会成为可点链接'
  ],
  style: ['「精通」出现 3 次，建议改成具体动作与场景']
};
const sorted = (a) => [...a].sort();

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== E. 纯函数契约（不经 HTTP）：六类 + 三级 =====
  let contentChecks = null;
  try {
    const mod = await import('../../content-check.mjs');
    contentChecks = mod.contentChecks;
  } catch (e) {
    fail('content-check.mjs 不可用（纯规则引擎缺失）：' + (e && e.message || e));
  }
  assert.equal(typeof contentChecks, 'function', 'contentChecks 必须是导出的纯函数');
  {
    const res = contentChecks(buildDoc(BAD_ID, BAD));
    assert.ok(res && Array.isArray(res.items), 'contentChecks 应返回含 items 的结果');
    for (const lv of ['fix', 'verify', 'style']) {
      assert.ok(Array.isArray(res[lv]), '结果应含三级的 ' + lv + ' 数组');
    }
    const all = res.items.map((it) => it.text);
    // 三级集合全等（严格：不多不少、措辞一致）
    assert.deepEqual(sorted(res.fix.map((x) => x.text)), sorted(EXPECT.fix), '需修复集合应与期望全等，实际：' + JSON.stringify(all));
    assert.deepEqual(sorted(res.verify.map((x) => x.text)), sorted(EXPECT.verify), '建议核对集合应与期望全等，实际：' + JSON.stringify(all));
    assert.deepEqual(sorted(res.style.map((x) => x.text)), sorted(EXPECT.style), '风格建议集合应与期望全等，实际：' + JSON.stringify(all));
    // 每一级内部不得有重复项（同一判定不得重复报）
    for (const lv of ['fix', 'verify', 'style']) {
      const t = res[lv].map((x) => x.text);
      assert.equal(new Set(t).size, t.length, lv + ' 级内不得重复报同一判定，实际：' + JSON.stringify(t));
    }
    // B 三级分类：精通/熟悉类重复只在风格建议，不得进需修复
    assert.ok(!res.fix.some((it) => it.text.includes('精通')), '「精通」重复不得进需修复（仅风格建议）');
    assert.ok(!res.verify.some((it) => it.text.includes('精通')), '「精通」重复不得进建议核对（仅风格建议）');
    // C 阴性对照
    const clean = contentChecks(buildDoc(CLEAN_ID, CLEAN));
    assert.equal(clean.fix.length, 0, '干净文档不得有需修复项，实际：' + JSON.stringify(clean.fix.map((x) => x.text)));
    assert.equal(clean.verify.length, 0, '干净文档不得有建议核对项，实际：' + JSON.stringify(clean.verify.map((x) => x.text)));
    assert.equal(clean.style.length, 0, '干净文档不得有风格建议项，实际：' + JSON.stringify(clean.style.map((x) => x.text)));
    // C′ 误报守卫（两条）：合法写法不得被判成坏号码 / 坏日期
    {
      const spaced = contentChecks('<div class="contact">电话：010-8888 6666</div>');
      assert.equal(spaced.fix.length, 0, '带空格分隔的固定电话不得误报，实际：' + JSON.stringify(spaced.fix.map((x) => x.text)));
      assert.equal(spaced.verify.length, 0, '带空格分隔的固定电话不得进建议核对，实际：' + JSON.stringify(spaced.verify.map((x) => x.text)));
      const hyphen = contentChecks('<div class="entry-head"><div class="entry-title">合成甲公司</div><div class="entry-date">2023-07 - 2024-03</div></div>');
      assert.equal(hyphen.fix.length, 0, '连字符日期不得误报成坏号码，实际：' + JSON.stringify(hyphen.fix.map((x) => x.text)));
      assert.equal(hyphen.verify.length, 0, '连字符日期不得误报（格式统一），实际：' + JSON.stringify(hyphen.verify.map((x) => x.text)));
    }
  }

  // ===== A + D. 导出页检查卡新分区：六类判定与三级计数 =====
  {
    const r = await get('/export?id=' + BAD_ID);
    assert.equal(r.status, 200, '导出页应 200，实际 ' + r.status + '：' + r.text.slice(0, 200));
    const html = r.text;
    assert.ok(html.includes('确定性内容检查'), '导出检查卡应有「确定性内容检查」分区，实际页面未出现');
    for (const lv of ['fix', 'verify', 'style']) {
      assert.ok(html.includes(`data-cc="${lv}"`), `导出检查卡应有 data-cc="${lv}" 分区`);
    }
    for (const t of EXPECT.fix) assert.ok(html.includes(t), '导出页需修复应显示：' + t);
    for (const t of EXPECT.verify) assert.ok(html.includes(t), '导出页建议核对应显示：' + t);
    for (const t of EXPECT.style) assert.ok(html.includes(t), '导出页风格建议应显示：' + t);
    // 阴性对照：干净文档导出页零需修复零建议核对
    const rc = await get('/export?id=' + CLEAN_ID);
    assert.equal(rc.status, 200, '干净文档导出页应 200');
    assert.ok(rc.text.includes('确定性内容检查'), '干净文档导出页也应有该分区（分区恒在，内容为空）');
    const cleanFix = (rc.text.match(/data-cc="fix"[\s\S]{0,200}?需修复\s*(\d+)\s*条/) || [])[1];
    assert.equal(cleanFix, '0', '干净文档需修复应为 0 条，实际片段：' + (rc.text.match(/data-cc="fix"[\s\S]{0,120}/) || [''])[0]);
  }

  // ===== D. 单一通道：审阅校验段（GET /job/changes）与导出页同源同结果 =====
  {
    const r = await getJson('/job/changes?id=' + BAD_ID);
    assert.equal(r.status, 200, '/job/changes 应 200，实际 ' + r.status);
    const cc = r.json && r.json.job && r.json.job.checks && r.json.job.checks.content;
    assert.ok(cc, '审阅视图的 checks 应含 content（同一实现：导出检查卡与校验段共用）');
    assert.equal(cc.fix.length, EXPECT.fix.length, '需修复条数应与期望一致，实际：' + JSON.stringify(cc.fix.map((x) => x.text)));
    assert.equal(cc.verify.length, EXPECT.verify.length, '建议核对条数应与期望一致，实际：' + JSON.stringify(cc.verify.map((x) => x.text)));
    assert.equal(cc.style.length, EXPECT.style.length, '风格建议条数应与期望一致，实际：' + JSON.stringify(cc.style.map((x) => x.text)));
    const rc = await getJson('/job/changes?id=' + CLEAN_ID);
    const cc2 = rc.json && rc.json.job && rc.json.job.checks && rc.json.job.checks.content;
    assert.ok(cc2, '干净文档的 checks 也应含 content');
    assert.equal(cc2.fix.length, 0, '干净文档需修复应为 0，实际：' + JSON.stringify(cc2.fix.map((x) => x.text)));
    assert.equal(cc2.verify.length, 0, '干净文档建议核对应为 0，实际：' + JSON.stringify(cc2.verify.map((x) => x.text)));
  }

  // ===== D′. 审阅 Tab「导出检查」段渲染出同一份三级结果（浏览器段；Chromium 缺失 exit 2）=====
  {
    let bin = null;
    try { bin = await resolveChromium(); }
    catch (e) { console.log('⚠️  Chromium 不可用，跳过面板渲染段：' + (e && e.message || e)); cleanup(); process.exit(2); }
    browser = await chromium.launch({ executablePath: bin });
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
    await page.goto(base + '/edit?id=' + BAD_ID);
    await page.waitForSelector('#jp-root .jp-secs button[data-sec="export"]', { timeout: 20000 });
    await page.click('#jp-root .jp-secs button[data-sec="export"]');
    await page.waitForSelector('#jp-root [data-cc="fix"]', { timeout: 20000 });
    const panel = await page.evaluate(() => {
      const pick = (k) => {
        const el = document.querySelector('#jp-root [data-cc="' + k + '"]');
        return el ? el.textContent : '';
      };
      return { fix: pick('fix'), verify: pick('verify'), style: pick('style') };
    });
    assert.ok(panel.fix.includes('需修复'), '审阅段应有需修复行，实际：' + panel.fix);
    assert.ok(panel.verify.includes('建议核对'), '审阅段应有建议核对行，实际：' + panel.verify);
    assert.ok(panel.style.includes('风格建议'), '审阅段应有风格建议行，实际：' + panel.style);
    assert.ok(panel.fix.includes('未替换占位符'), '审阅段需修复行应含占位符判定（与导出页同源），实际：' + panel.fix);
    assert.ok(panel.verify.includes('公司/项目名写法不一致'), '审阅段建议核对行应含名称写法判定（与导出页同源），实际：' + panel.verify);
    assert.deepEqual(pageErrors, [], '不得有页面异常：' + JSON.stringify(pageErrors));
  }

  console.log('✅ 确定性内容检查：六类命中（名称/日期×2/联系方式/链接×2/重复段落/占位符）+ 三级分类（精通重复仅风格建议）'
    + ' + 阴性对照零误报 + 导出页与审阅段单一通道同源');
} catch (e) {
  console.error('❌ ' + (e && e.message || e));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  cleanup();
}
