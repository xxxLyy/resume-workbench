// test-visual-screens.mjs — 视觉验收截图夹具（VQA 卡）：对 7 个关键应用页截 1280x900 全页图。
// 零断言、退出 0：本夹具只负责「在隔离实例上产出真实渲染截图」（/tmp/shots-after/*.png），
// 视觉判定由人工/视觉验收流程对照 DESIGN.md 逐张进行（双区世界 / 导航唯一 / 溢出 / 对比 / 串味）。
// 启动模式逐行照 test-gen-progress-ui.mjs：mkdtemp 隔离根 + 合成岗位草稿 + 本机桩 LLM（随机端口）
// + net.createServer 抢空闲端口 + spawn(server.mjs, RESUME_ROOT=隔离根)；process.on('exit') 收尾。
// 仓库零写入：数据根/Chromium 探针缓存（chromium.mjs:13 按 RESUME_ROOT 解析）全落隔离根。
// 浏览器类夹具：Chromium 不可用 → 提示后 process.exit(2)（跳过，不红）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const OUT_DIR = '/tmp/shots-after';
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const repoRequire = createRequire(path.join(APP_ROOT, 'package.json'));
const { chromium } = repoRequire('playwright-core');
const { resolveChromium } = await import(pathToFileURL(path.join(APP_ROOT, 'chromium.mjs')).href);
const { assembleTemplate } = await import(pathToFileURL(path.join(APP_ROOT, 'template.mjs')).href);

// ===== 隔离根 + 合成岗位草稿（与视觉基线 /tmp/shot-base.mjs 同一份数据，保证逐页可比） =====
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-visual-'));
process.env.RESUME_ROOT = root;   // resolveChromium 探针缓存落隔离根，不碰仓库
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const DOC = 'doc1';
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
doc = doc.replace('{{PROJECTS}}', () => '<p data-zid="z11111111">项目一：负责交易系统</p>');
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  [DOC]: { rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位', jd: '负责高并发服务', job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} } }
}, null, 2));

// ===== 桩 LLM（本机随机端口；截图页不发 AI 请求，仅给 /settings 配置面供桩） =====
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const body = { choices: [{ message: { content: JSON.stringify({ evidence: [{ req: '高并发', refHints: [{ type: 'para', zid: 'z11111111', title: '项目一', quote: '负责交易系统' }] }] }) } }] };
      body.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      res.end(JSON.stringify(body));
    }, 0);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model-ui' }]
}));

// ===== 空闲端口 + spawn server（照夹具） =====
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
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));
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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过视觉截图：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // 记录（不断言）：页面级 JS 异常/控制台错误只打日志，供视觉验收参考
  page.on('pageerror', (e) => console.log('⚠️  pageerror: ' + (e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('⚠️  console.error: ' + m.text()); });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const routes = [
    ['home', '/'], ['onboarding', '/onboarding'], ['stats', '/stats'],
    ['materials', '/materials'], ['applications', '/applications'],
    ['evals', '/evals'], ['settings', '/settings']
  ];
  for (const [name, route] of routes) {
    await page.goto(base + route, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(600);   // 客户端渲染沉淀（与基线同口径）
    await page.screenshot({ path: path.join(OUT_DIR, name + '.png'), fullPage: true });
    console.log('📸 ' + route + ' → ' + path.join(OUT_DIR, name + '.png'));
  }
  console.log('✅ 7 张视觉验收截图完成（零断言，视觉判定走 DESIGN.md 对照）：' + OUT_DIR);
} finally {
  try { if (browser) await browser.close(); } catch {}
  cleanup();
}
