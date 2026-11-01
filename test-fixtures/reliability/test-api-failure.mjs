// test-api-failure.mjs — 面板 api() 吞业务级失败必须可见（BL-P3-02，medium）
// 背景：zone-panel 的 api() 对任何 HTTP 状态都 resolve；bindOne 的 `.then(load)` 把
// 服务端拒绝（400/409/5xx、ok:false）静默吞掉——改绑失败后界面零反馈，用户误以为已生效。
// 断言（任务卡）：桩 409 后面板出现失败提示（.zp-msg，含服务端原因）且状态未变
//（待确认计数不变、docs-meta.json 不被改写）。
// 场景 A：409 + {ok:false,error:'非法条目 …'}（照总账复现口径）。
// 场景 B：409 + 响应体伪造 {ok:true} —— 注入层必须按 HTTP 状态判失败（resolve 值带失败语义），
//         不得把非 2xx 当成功。
// 约束：隔离 RESUME_ROOT + 合成文档；不读真实简历、不碰 7766、不调真实模型（改绑路径无 LLM）。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-zaf-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111', P2 = 'z22222222', P3 = 'z33333333';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () =>
  `<p data-zid="${P1}">项目一：负责队列服务，把延迟从 80ms 降到 12ms</p>`
  + `<p data-zid="${P2}">项目二：负责限流组件，支撑双十一峰值流量</p>`
  + `<p data-zid="${P3}">项目三：负责容量规划，支撑三年增长</p>`);
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
// P1 已确认；P2/P3 待确认 → 面板出现「待确认分类 2 段」入口
const metaPath = path.join(root, 'docs-meta.json');
fs.writeFileSync(metaPath, JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    zones: {
      [P1]: { zone: 'work', status: 'confirmed' },
      [P2]: { zone: 'work', status: 'pending' },
      [P3]: { zone: 'project', status: 'pending' }
    },
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} }
  }
}, null, 2));

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
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });   // fail() 走 process.exit 也不留孤儿
const base = `http://127.0.0.1:${port}`;

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();
  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P1 + '"]', { timeout: 15000 });
  await page.evaluate(() => { if (window.__edSelectTab) window.__edSelectTab('zone'); });
  await page.waitForSelector('#zp-root', { state: 'attached', timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('zp-pend'), null, { timeout: 15000 });

  const diskMeta = () => JSON.parse(fs.readFileSync(metaPath, 'utf8'))[DOC].zones;
  const msgText = () => page.evaluate(() => (document.querySelector('#zp-root .zp-msg') || {}).textContent || '');
  const pendText = () => page.evaluate(() => (document.getElementById('zp-pend') || {}).textContent || '');
  // 等失败提示出现（按内容判定，不用 sleep 决定成败）；超时带面板现场定位红相
  const waitFailMsg = async (what) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const t = await msgText();
      if (t) return t;
      await page.waitForTimeout(120);
    }
    const dbg = await page.evaluate(() => ({
      msg: (document.querySelector('#zp-root .zp-msg') || {}).textContent || null,
      pend: (document.getElementById('zp-pend') || {}).textContent || null,
      rootTail: ((document.getElementById('zp-root') || {}).textContent || '').slice(0, 160)
    }));
    fail('等待超时：' + what + '（面板未出现失败提示）调试：' + JSON.stringify(dbg));
  };
  // 打开待确认弹窗并点指定区域按钮（触发 bindOne → POST /zones）
  const bindPendingAs = async (label) => {
    await page.evaluate(() => document.getElementById('zp-pend').click());
    await page.waitForSelector('.zp-modal', { state: 'attached', timeout: 8000 });
    await page.evaluate((lb) => {
      var btns = document.querySelectorAll('.zp-modal button.zp-sel');
      for (var i = 0; i < btns.length; i++) { if (btns[i].textContent === lb) { btns[i].click(); return; } }
      throw new Error('找不到区域按钮：' + lb);
    }, label);
  };

  // ===== 场景 A：桩 409 + {ok:false, error:'非法条目 z…'}（总账复现口径）=====
  let hitsA = 0;
  await page.route('**/zones?id=*', (route) => {
    hitsA++;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '非法条目 ' + P2 }) });
  });
  await bindPendingAs('个人');
  const msgA = await waitFailMsg('场景 A（409 ok:false）改绑失败提示');
  if (hitsA < 1) fail('场景 A：POST /zones 请求根本没发出（桩未命中）');
  if (!/改绑未保存|失败/.test(msgA)) fail('场景 A：失败提示缺少失败语义，实际：' + msgA);
  if (!msgA.includes('非法条目')) fail('场景 A：失败提示未透出服务端原因，实际：' + msgA);
  const pendA = await pendText();
  if (!pendA.includes('待确认分类 2 段')) fail('场景 A：失败后面板状态被改动（应仍待确认 2 段），实际：' + pendA);
  const za = diskMeta()[P2];
  if (!za || za.zone !== 'work' || za.status !== 'pending') fail('场景 A：磁盘 zones 被改写，实际：' + JSON.stringify(za));
  console.log('  ✅ A 409(ok:false) → 提示「' + msgA.slice(0, 40) + '…」，待确认计数与磁盘均未变');

  // ===== 场景 B：桩 409 但响应体伪造 {ok:true} —— HTTP 非 2xx 必须按失败语义 resolve =====
  await page.evaluate(() => { var m = document.querySelector('#zp-root .zp-msg'); if (m) m.remove(); });
  let hitsB = 0;
  await page.unroute('**/zones?id=*');
  await page.route('**/zones?id=*', (route) => {
    hitsB++;
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await bindPendingAs('项目');
  const msgB = await waitFailMsg('场景 B（409 体伪造 ok:true）改绑失败提示');
  if (hitsB < 1) fail('场景 B：POST /zones 请求根本没发出（桩未命中）');
  if (!/改绑未保存|失败/.test(msgB)) fail('场景 B：非 2xx 被当成功（无失败提示），实际：' + msgB);
  if (!/409/.test(msgB)) fail('场景 B：提示未携带 HTTP 状态信息，实际：' + msgB);
  const pendB = await pendText();
  if (!pendB.includes('待确认分类 2 段')) fail('场景 B：失败后面板状态被改动，实际：' + pendB);
  const zb = diskMeta()[P2];
  if (!zb || zb.zone !== 'work' || zb.status !== 'pending') fail('场景 B：磁盘 zones 被改写，实际：' + JSON.stringify(zb));
  console.log('  ✅ B 409(体伪造 ok:true) → 仍按失败提示「' + msgB.slice(0, 40) + '…」，状态未变');

  console.log('PASS api 失败可见性（BL-P3-02）：桩 409 后面板出现失败提示且状态未变（面板 DOM + 磁盘双重核对）');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
