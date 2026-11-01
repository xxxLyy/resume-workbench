// test-zone-locked-keep.mjs — 改绑整表回写不得抹掉别处设置的 locked（BL-P3-03，medium）
// 背景：bindOne 用 load() 时刻的 zones 快照整表回写 /zones，而服务端按条目整体替换
// （payload 条目未带 locked 即该条目的 locked 键消失）→ 面板加载后别处（第二写者）设置的
// locked，会被下一次与它无关的改绑静默抹掉（总账 BL-P3-03：复现口径 = 外部 POST /zones 锁段
// → 面板改绑另一 pending 段 → 读 RESUME_ROOT/docs-meta.json 看 locked 是否还在）。
// 场景（时序即缺陷触发条件）：
//   ① 面板加载完成（state 快照 = 无锁旧数据）
//   ② 外部 POST /zones 给 P3、P4 上锁（第二写者；面板不刷新）
//   ③ 面板里把 P4 改绑「个人」（触发 bindOne）
// 断言三层（内容/请求行为变红，不靠提示文字）：
//   请求层：bindOne 的 payload 只含目标条目 P4（P3 根本不进请求）；
//   磁盘层：docs-meta.json 里 P3.locked 与 P4.locked 都还在；
//   行为层：P4 改绑本身真实生效（zone=personal, status=confirmed，防「什么都不发」的假绿）。
// 约束：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档；不碰 7766、不读真实简历、不调模型。
// 挂载：浏览器类 → test.sh 文件末尾追加段（本文件不自带挂载，由提交员统一处理）。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-zlk-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P3 = 'z33333333', P4 = 'z44444444';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{WORK}}', () => '<p data-zid="' + P3 + '">项目三：负责容量规划，支撑三年增长</p>'
  + '<p data-zid="' + P4 + '">项目四：负责日常运维值班与故障演练</p>');
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
// 初始 meta：P3 已确认（project、无锁），P4 待确认（work、无锁）——两把锁都在面板加载之后才由外部写者设置
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    zones: { [P3]: { zone: 'project', status: 'confirmed' }, [P4]: { zone: 'work', status: 'pending' } },
    job: { evidence: [], changes: [], todos: [], feedback: [], materials: [], genTasks: {} }
  }
}, null, 2));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
// 收尾钩子：fail 走 process.exit 也不留孤儿服务、不留临时根
process.on('exit', () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
const base = `http://127.0.0.1:${port}`;
const serverZones = async () => {
  const d = await (await fetch(base + '/job/changes?id=' + DOC)).json();
  if (!d || !d.ok) fail('读取服务端区域状态失败：' + JSON.stringify(d).slice(0, 200));
  return d.zones || {};
};
const diskZones = () => JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'))[DOC].zones;
const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  fail('等待超时：' + what + '\n服务日志=' + serverLog.slice(-400));
};

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }
  let bin = null;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过区域锁定浏览器回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();

  // ① 面板加载（先于上锁 → 面板 state 快照里没有任何 locked）
  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P3 + '"]', { timeout: 15000 });
  await page.evaluate(() => { if (window.__edSelectTab) window.__edSelectTab('zone'); });
  await page.waitForSelector('#zp-root', { state: 'attached', timeout: 15000 });
  // 闸门：#zp-pend 出现 = 面板完成了一次成功 load()（P4 pending → 渲染出「待确认分类」按钮）
  await page.waitForSelector('#zp-pend', { state: 'attached', timeout: 15000 });
  await page.waitForTimeout(600);   // 排空切 Tab 触发的 ed-zone-refresh 二次 load，快照稳定在「无锁」态

  // ② 第二写者：外部 POST /zones 给 P3、P4 上锁（POST /zones 是契约指定的唯一写入口）
  const lockResp = await fetch(base + '/zones?id=' + DOC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ zones: {
      [P3]: { zone: 'project', status: 'confirmed', locked: true },
      [P4]: { zone: 'work', status: 'pending', locked: true }
    } })
  });
  assert.equal(lockResp.status, 200, '外部上锁请求失败');
  await until(async () => (await serverZones())[P3]?.locked === true && (await serverZones())[P4]?.locked === true, '外部上锁落盘');

  // ③ 捕获 bindOne 的改绑请求（放行到服务端真实落盘），再经面板改绑 P4 → 个人
  let bindPayload = null;
  await page.route('**/zones?id=*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST') { try { bindPayload = JSON.parse(req.postData()); } catch {} }
    await route.fetch();
  });
  await page.evaluate(() => { const b = document.getElementById('zp-pend'); if (b) b.click(); });
  await page.waitForSelector('.zp-modal .zp-card', { state: 'attached', timeout: 15000 });
  await page.evaluate(() => { const b = document.querySelector('.zp-modal .zp-sel'); if (b) b.click(); });   // 第一档 = 个人
  // 改绑落地：服务端 P4 变为 personal/confirmed（bindOne → POST /zones → load 的链路走完）
  await until(async () => {
    const z = (await serverZones())[P4];
    return z && z.zone === 'personal' && z.status === 'confirmed';
  }, 'P4 改绑落地（面板改绑请求未被服务端接受）');

  // 断言 ①请求层：payload 只含目标条目 P4 —— P3 不得混进请求（整表回写即原缺陷）
  assert.ok(bindPayload, '改绑请求未被捕获（bindOne 未发 POST /zones）');
  assert.deepEqual(Object.keys(bindPayload.zones || {}), [P4],
    'bindOne payload 应只含目标条目 P4，实际：' + JSON.stringify(bindPayload.zones));
  // 断言 ②磁盘层：两把锁都必须还在（面板加载后由外部写者设置，改绑不得抹掉）
  const after = diskZones();
  assert.equal(after[P3]?.locked, true, 'P3.locked 被无关改绑抹掉（P3 条目：' + JSON.stringify(after[P3]) + '）');
  assert.equal(after[P3]?.zone, 'project', 'P3 的绑定本身被改写（P3 条目：' + JSON.stringify(after[P3]) + '）');
  assert.equal(after[P4]?.locked, true, '目标条目 P4 自己的 locked 在改绑中被抹掉（P4 条目：' + JSON.stringify(after[P4]) + '）');
  // 断言 ③行为层：P4 改绑真实生效（防「什么都不发」的假绿）
  assert.equal(after[P4]?.zone, 'personal', 'P4 未改绑到个人：' + JSON.stringify(after[P4]));
  assert.equal(after[P4]?.status, 'confirmed', 'P4 未确认：' + JSON.stringify(after[P4]));

  console.log('PASS 区域改绑条目级回写：payload 只含目标条目；面板加载后别处设置的 locked（P3）与目标条目自身的 locked（P4）均保留；改绑本身生效');
  process.exitCode = 0;
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
