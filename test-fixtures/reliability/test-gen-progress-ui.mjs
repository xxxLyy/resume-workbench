// test-gen-progress-ui.mjs — 面板的诚实最小进度 UI（S4b-B）：阶段/时长 ticker/用量/取消文案
// 断言全靠内容与行为（纪律：不靠提示文字颜色/超时假装）：
//   ① running 态显示「已等待 m:ss · 阶段 · 模型名」，时长 1s 粒度递增（ticker 证据）；
//   ② done 态显示「用量 N tokens」（桩带 usage）/「用量：服务商未返回」（桩无 usage）；
//   ③ 取消成功提示含「不会撤销服务商已发生的计费」。
// 浏览器类夹具：隔离根 + 合成岗位草稿 + 本机桩 LLM（可控延迟/usage）；零真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';
import { normalizeZids } from '../../zone.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-genpui-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const DOC = 'doc1';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => '<p data-zid="z11111111">项目一：负责交易系统</p>');
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), normalizeZids(doc));
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位', jd: '负责高并发服务', job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} } }
}, null, 2));

let stubDelayMs = 0, stubWithUsage = true;
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const body = { choices: [{ message: { content: JSON.stringify({ evidence: [{ req: '高并发', refHints: [{ type: 'para', zid: 'z11111111', title: '项目一', quote: '负责交易系统' }] }] }) } }] };
      if (stubWithUsage) body.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      res.end(JSON.stringify(body));
    }, stubDelayMs);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model-ui' }]
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
const base = `http://127.0.0.1:${port}`;

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(base + '/'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过生成进度 UI 回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage();
  await page.goto(base + '/edit?id=' + DOC);
  await page.waitForSelector('#ed-pane-review', { timeout: 15000 });
  await page.waitForFunction(() => (document.querySelector('#ed-pane-review') || {}).textContent !== '加载中…', null, { timeout: 15000 });
  const noteText = () => page.evaluate(() => (document.querySelector('#ed-pane-review .jp-msg') || {}).textContent || '');
  const panelHas = (needle) => page.evaluate((n) => (document.querySelector('#ed-pane-review') || {}).textContent.includes(n), needle);
  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(150); }
    fail('等待超时：' + what + '（面板提示：' + (await noteText()).slice(-120) + '）');
  };

  // ===== ①②a：延迟桩 + usage → running 行（阶段/时长/模型，时长递增）→ done 用量 =====
  stubDelayMs = 4000; stubWithUsage = true;
  await page.click('#ed-pane-review button:has-text("生成证据")');
  await waitFor(() => panelHas('已等待'), 8000, 'running 进度行出现');
  await waitFor(() => panelHas('调用模型中'), 8000, '阶段标签（calling）');
  assert.ok(await panelHas('stub-model-ui'), '进度行应含模型名');
  // ticker：时长文本 1s 粒度递增
  const t1 = await page.$eval('#ed-pane-review [data-gen-elapsed]', (el) => el.textContent);
  await page.waitForTimeout(2100);
  const t2 = await page.$eval('#ed-pane-review [data-gen-elapsed]', (el) => el.textContent);
  assert.notEqual(t1, t2, `时长应随 ticker 递增（「${t1}」→「${t2}」）`);
  assert.ok(!await panelHas('%'), '不得出现百分比');
  // done → 用量徽章
  await waitFor(() => panelHas('用量 120 tokens'), 20000, 'done 用量徽章（真实 total）');

  // ===== ②b：无 usage 的 done → 「服务商未返回」 =====
  stubWithUsage = false;
  await page.click('#ed-pane-review button:has-text("重新分析")');
  await waitFor(() => panelHas('用量：服务商未返回'), 20000, '无 usage 时诚实文案');

  // ===== ③：取消提示含计费说明 =====
  stubDelayMs = 12000; stubWithUsage = false;
  await page.click('#ed-pane-review button:has-text("重新分析")');
  await waitFor(() => panelHas('取消'), 8000, 'running 态取消按钮');
  await page.click('#ed-pane-review button:has-text("取消")');
  await waitFor(async () => /不会撤销服务商已发生的计费/.test(await noteText()), 8000, '取消提示含计费说明');

  console.log('✅ 生成进度 UI：running 行（阶段/时长 ticker 递增/模型）+ done 用量（真实数值与「未返回」两态）+ 取消文案含计费说明 + 零百分比');
} finally {
  try { if (browser) await browser.close(); } catch {}
  cleanup();
}
