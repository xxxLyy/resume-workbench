// test-zid-persist-autogen.mjs — 浏览器回归：zid 先落盘再自动生成 + 定制效果评估卡 + 完成提醒
// 覆盖（2026-11-15 三笔提交）：
//   (1) 无 data-zid 母版 → /job/create 建稿 → /edit?gen=1：编辑器首跑补打点并 autosave，
//       链自动跑完 → 盘上有 data-zid、parasOf>0、zones 无孤儿（key 全在正文）、证据非空（≥1 条 para 引用）、建议非空；
//   (2) 导出检查「定制效果」：点「评估定制效果（会先评估母版）」→ evaluations.json +2
//       （source.docId 分别为母版与草稿）→ 卡上两条分数都带 /evals# 链接；
//   (3) document.hidden=true（defineProperty）→ 链完成 → document.title 前缀（已完成）；
//       visibilitychange 回可见 → 标题还原。
// 退出码契约同浏览器段：0 通过 / 1 断言失败 / 2 仅 Chromium 不可用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';
import { parasOf } from '../../zone.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-zidauto-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 无 data-zid 母版（重现 linghaoxiang 场景：正文零打点 → gen=1 自动链原先拿不到引用）
const ZTXT1 = '负责交易系统，把延迟从 80ms 降到 12ms', ZTXT2 = '项目甲：网关压测平台，覆盖三十万 QPS';
let masterHtml = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '甲'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'], ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'masterz']]) masterHtml = masterHtml.replaceAll(k, () => v);
masterHtml = masterHtml.replace('{{WORK}}', () => `<p>${ZTXT1}</p>`).replace('{{PROJECTS}}', () => `<p>${ZTXT2}</p>`);
fs.writeFileSync(path.join(root, 'docs', 'masterz.html'), masterHtml);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ masterz: { rev: 1, flow: 'draft', company: '母版', role: '' } }, null, 2));

// 草稿 zid 不预知：客户端内容哈希打点、autosave 后才落盘——桩应答时从盘正文取第一个 zid（两份草稿内容同源 → zid 相同）
const readZid = () => {
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
  const did = Object.keys(meta).find((k) => meta[k].kind === 'job');
  if (!did) return '';
  const m = fs.readFileSync(path.join(root, 'docs', did + '.html'), 'utf8').match(/data-zid="(z[0-9a-f]+)"/);
  return m ? m[1] : '';
};
const REQS = { requirements: ['交易系统与订单经验'] };
const EVALR = { roleSummary: '后端研发', company: '评估公司', roleName: '后端工程师', level: 'right', levelReason: '匹配',
  salary: { text: '', source: 'JD 未提供' }, angle: '突出交易系统经验',
  matches: [{ req: '负责后端服务', status: 'covered', evidence: '负责交易系统', weight: 'must', weightFrom: 'JD 原文' }],
  score: 4.5, verdict: 'apply', verdictReason: '整体匹配', gaps: [] };
const stub = http.createServer((q, s) => {
  let b = ''; q.on('data', (c) => { b += c; });
  q.on('end', () => {
    let sys = '';
    try { sys = JSON.parse(b).messages.find((m) => m.role === 'system').content; } catch {}
    const done = (o, ms = 200) => setTimeout(() => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(o) } }] })); }, ms);
    if (String(sys).includes('岗位快速评估器')) return done(EVALR);
    if (String(sys).includes('岗位证据分析器')) return done({ evidence: [{ req: '交易系统与订单经验', status: 'covered', refHints: [{ type: 'para', zid: readZid(), title: '', quote: ZTXT1 }] }] });
    if (String(sys).includes('需求分析师')) return done(REQS);
    if (String(sys).includes('简历定制编排器')) return done({ summary: '工作段对齐', changes: [{ section: '工作经历', kind: 'replace', zid: readZid(), before: ZTXT1, after: '负责交易系统与网关优化，把延迟从 80ms 降到 12ms', reason: '对齐 JD', source: '母版', level: 'normal' }], todos: [] });
    return done({});
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'k', model: 'stub-x' }] }));

const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const B = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], { env: { ...process.env, RESUME_ROOT: root, PORT: String(PORT) }, stdio: 'pipe' });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { stub.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
const meta = () => JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
const waitTask = async (id, kind, want, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    const t = (((meta()[id] || {}).job || {}).genTasks || {})[kind];
    if (t && t.status === want) return t;
    await sleep(250);
  }
  fail(`${id} ${kind} 未等到 ${want}`);
};
let browser = null;
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/'); if (r.status === 200) break; } catch {} await sleep(200); }
  const post = async (u, body) => (await fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();

  // —— (1) 建稿 → /edit?gen=1 → 链跑完，盘上 zid 落账 ——
  const c1 = await post('/job/create', { from: 'masterz', company: '自动链公司', role: '后端', jd: '要求：交易系统与订单经验' });
  if (!c1.ok || !c1.id) fail('建稿失败：' + JSON.stringify(c1));
  const D1 = c1.id;
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { cleanup(); console.log('⚠️  Chromium 不可用，跳过：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage();
  await page.goto(`${B}/edit?id=${D1}&gen=1`);
  await page.waitForFunction(() => !location.search.includes('gen='), { timeout: 8000 });
  // 完成时通知我：仅 Notification.permission==='default' 时入口出现（headless 不支持 Notification 则跳过该断言）
  const perm = await page.evaluate(() => (typeof Notification === 'undefined' ? 'none' : Notification.permission));
  if (perm === 'default') await page.waitForSelector('text=完成时通知我', { timeout: 15000 });
  await page.screenshot({ path: '/tmp/zid-note.png', fullPage: true });
  await waitTask(D1, 'evidence', 'done');
  await waitTask(D1, 'changes', 'done');
  const d1html = fs.readFileSync(path.join(root, 'docs', D1 + '.html'), 'utf8');
  const paras = parasOf(d1html);
  if (!d1html.includes('data-zid=') || paras.length === 0) fail('自动链后盘正文仍无 data-zid（autosave 未落）');
  const zs = meta()[D1].zones || {};
  const inDoc = new Set([...d1html.matchAll(/data-zid="([^"]+)"/g)].map((m) => m[1]));
  const orphans = Object.keys(zs).filter((z) => !inDoc.has(z));
  if (orphans.length) fail('zones 出现孤儿 zid：' + orphans.join(','));
  const j1 = meta()[D1].job;
  if (!(j1.evidence || []).length) fail('链后证据表为空');
  if (!j1.evidence.some((e) => (e.refs || []).some((r) => r.type === 'para'))) fail('证据应至少 1 条 para 引用');
  if (!(j1.changes || []).length) fail('链后修改建议为空');

  // —— (2) 导出检查「定制效果」：先评母版再评草稿 → 卡上双分数 ——
  await page.click('text=导出检查');
  await page.waitForSelector('text=定制前（母版）', { timeout: 8000 });
  await page.click('text=评估定制效果');
  const evsPath = path.join(root, 'evaluations.json');
  const loadEvs = () => { try { return JSON.parse(fs.readFileSync(evsPath, 'utf8')); } catch { return []; } };
  let hits = [];
  for (let i = 0; i < 80; i++) {
    hits = loadEvs().filter((e) => e.source && (e.source.docId === 'masterz' || e.source.docId === D1) && e.jd === '要求：交易系统与订单经验');
    if (hits.length >= 2) break;
    await sleep(250);
    if (i === 79) fail('定制效果评估未落两条记录');
  }
  if (!hits.some((e) => e.source.docId === 'masterz') || !hits.some((e) => e.source.docId === D1)) fail('两条评估的 source.docId 应分别为母版与草稿');
  await page.waitForSelector('a[href^="/evals#"]', { timeout: 8000 });
  const links = await page.$$eval('a[href^="/evals#"]', (as) => as.map((a) => a.textContent));
  if (links.filter((t) => /分/.test(t)).length < 2) fail('定制效果卡应显示两条分数链接，实际 ' + JSON.stringify(links));
  await page.screenshot({ path: '/tmp/zid-export.png', fullPage: true });

  // —— (3) 隐藏页签：链完成 → 标题前缀；回可见 → 还原 ——
  const c2 = await post('/job/create', { from: 'masterz', company: '隐藏页签公司', role: '后端', jd: '要求：交易系统与订单经验' });
  const D2 = c2.id || c2.existing;
  if (!D2) fail('第二份草稿创建失败：' + JSON.stringify(c2));
  await page.goto(`${B}/edit?id=${D2}&gen=1`);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { get: () => true, configurable: true }); });
  await waitTask(D2, 'changes', 'done');
  await page.waitForFunction(() => document.title.startsWith('（已完成）'), { timeout: 30000 });
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const t2 = await page.evaluate(() => document.title);
  if (t2.startsWith('（已完成）')) fail('回可见后标题未还原：' + t2);
  console.log('✅ zid 落盘先行 + gen=1 自动链（盘 data-zid/zones 无孤儿/证据有 para 引用/建议落账）+ 定制效果评估卡（双记录双分链）+ 隐藏页签完成提醒（前缀与还原）');
} finally { try { if (browser) await browser.close(); } catch {} cleanup(); }
