// test-zone-degrade-keep.mjs — 降级提示重绘后必须仍在（BL-P3-07，low）
// 背景：「未配置大模型」降级提示节点被 degrade() 插在 AI 框内，而 renderAi() 的 old.remove()
// 会连提示一起删除；state.aiDegraded 却仍为 true（setBusy 持续禁用分析/改写按钮）→ 重绘后
// 只剩永久禁用的按钮和「分析中…」，用户看不到原因（总账 BL-P3-07）。
// 场景（总账复现口径）：隔离实例不写 config.json → 区域 Tab 点区域行触发分析（服务端回
// 409 LLM_NOT_CONFIGURED → degrade）→ 派发 ed-zone-refresh（外壳切走再切回区域 Tab 同通道）
// → 降级提示必须仍在、按钮必须仍禁用（禁用是对的，无解释是缺陷）。
// 断言靠内容变红（.zp-degr 文本、按钮 disabled 属性），不靠超时/提示文字。
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
import { normalizeZids } from '../../zone.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-zdk-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

const DOC = 'doc1';
const P1 = 'z11111111', P2 = 'z22222222';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => '<p data-zid="' + P1 + '">项目一：负责队列服务，把延迟从 80ms 降到 12ms</p>'
  + '<p data-zid="' + P2 + '">项目二：负责限流组件，支撑双十一峰值流量</p>');
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), normalizeZids(doc));
// 关键：不写 config.json（hasLLM=false → /ai/zone-analyze 回 409 LLM_NOT_CONFIGURED → degrade 路径）
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: {
    rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
    zones: { [P1]: { zone: 'project', status: 'confirmed' }, [P2]: { zone: 'project', status: 'confirmed' } },
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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过区域降级提示回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
  const page = await ctx.newPage();

  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('.sheet [data-zid="' + P1 + '"]', { timeout: 15000 });
  await page.evaluate(() => { if (window.__edSelectTab) window.__edSelectTab('zone'); });
  await page.waitForSelector('.zp-row[data-zone="project"]', { state: 'attached', timeout: 15000 });
  await page.evaluate(() => { var r = document.querySelector('.zp-row[data-zone="project"]'); if (r) r.click(); });   // 触发分析 → 409 降级

  // 降级落地：提示出现且两按钮被禁用（禁用本身是正确行为）
  try { await page.waitForSelector('#zp-ai .zp-degr', { state: 'attached', timeout: 20000 }); }
  catch (e) { fail('降级提示未出现（服务端应回 409 LLM_NOT_CONFIGURED）服务日志=' + serverLog.slice(-300)); }
  const pre = await page.evaluate(() => ({
    note: (document.querySelector('#zp-ai .zp-degr') || {}).textContent || '',
    analyzeDisabled: (document.getElementById('zp-analyze') || {}).disabled,
    rewriteDisabled: (document.getElementById('zp-rewrite') || {}).disabled,
    out: ((document.getElementById('zp-ai-out') || {}).textContent || '')
  }));
  assert.ok(pre.note.indexOf('未配置大模型') >= 0, '夹具前置失败：降级提示文本异常，实际：' + pre.note);
  assert.equal(pre.analyzeDisabled, true, '夹具前置失败：降级后分析按钮应禁用');
  assert.equal(pre.rewriteDisabled, true, '夹具前置失败：降级后改写按钮应禁用');

  // 缺陷触发点：ed-zone-refresh（外壳切走再切回区域 Tab 同一条 load → render → renderAi 重建路径）
  await page.evaluate(() => {
    window.__zdkBox = document.getElementById('zp-ai');
    window.dispatchEvent(new Event('ed-zone-refresh'));
  });
  // 完成信号：AI 卡被重建（节点身份变化）
  try { await page.waitForFunction(() => {
    var b = document.getElementById('zp-ai');
    return b && b !== window.__zdkBox;
  }, null, { timeout: 15000 }); }
  catch (e) { fail('重绘未发生（AI 卡节点未重建）服务日志=' + serverLog.slice(-300)); }
  await page.waitForTimeout(300);   // 排空重绘收尾

  // 断言：重绘后降级提示必须仍在（带原因），按钮必须仍禁用（禁用 + 有解释 = 正确降级态）
  const post = await page.evaluate(() => ({
    note: (document.querySelector('#zp-ai .zp-degr') || {}).textContent || null,
    analyzeDisabled: (document.getElementById('zp-analyze') || {}).disabled,
    rewriteDisabled: (document.getElementById('zp-rewrite') || {}).disabled,
    out: ((document.getElementById('zp-ai-out') || {}).textContent || '')
  }));
  assert.ok(post.note !== null, '重绘后降级提示被删（只剩禁用按钮与「' + post.out + '」，用户看不到原因）');
  assert.ok(post.note.indexOf('未配置大模型') >= 0, '重绘后降级提示文本异常，实际：' + post.note);
  assert.ok(post.note.indexOf('绑定/确认/锁定不受影响') >= 0, '重绘后降级提示说明缺失，实际：' + post.note);
  assert.equal(post.analyzeDisabled, true, '重绘后分析按钮不应被重新点亮（降级态仍在）');
  assert.equal(post.rewriteDisabled, true, '重绘后改写按钮不应被重新点亮（降级态仍在）');

  console.log('PASS 区域降级提示保留：重绘后「未配置大模型…」说明仍在，按钮保持禁用（有解释的降级态）');
  process.exitCode = 0;
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
