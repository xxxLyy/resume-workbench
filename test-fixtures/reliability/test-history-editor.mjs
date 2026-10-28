// test-fixtures/reliability/test-history-editor.mjs — DEL-01/02：历史主脚本在严格 CSP 下的真实保存
// 覆盖：当前版与历史版编辑器主脚本（脱敏夹具）都能实际「输入 → 保存 → 读隔离盘 → 刷新」；
//       未知脚本在严格 CSP 下保持拒绝（不执行）。
// 约束：隔离 RESUME_ROOT + 合成文档 + 脱敏夹具（不依赖个人文档或动态 Git 历史）；不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-he-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 脱敏夹具（DEL-01）：固化在仓库里，测试不依赖个人文档或动态 Git 历史
const HIST = path.join(APP_ROOT, 'test-fixtures', 'history');
const scripts = [
  { label: '当前版', file: 'editor-current.js' },
  { label: '历史版（区域 Tab）', file: 'editor-legacy-region-tab.js' }
].map((x) => ({ ...x, code: fs.readFileSync(path.join(HIST, x.file), 'utf8') }));

// 未知脚本：不在 CSP 白名单内 → 必须被拒绝（不执行）
const UNKNOWN = 'window.__unknownRan = (window.__unknownRan || 0) + 1;';

function makeDoc(id, script) {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) doc = doc.replaceAll(k, () => v);
  doc = doc.replace('{{PROJECTS}}', () => '<p data-zid="z11111111">原始正文</p>');
  if (script) doc = doc.replace('</body>', () => `<script>${script.replace('{{DOC_ID}}', id)}</script></body>`);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  return id;
}

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
const base = `http://127.0.0.1:${port}`;

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  let bin = null;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过历史主脚本回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });

  // ===== DEL-02：当前版与历史版主脚本在严格 CSP 下都能真实保存 =====
  for (const s of scripts) {
    const id = 'doc-' + s.file.replace(/[^a-z0-9]/gi, '-');
    makeDoc(id, s.code);
    const page = await ctx.newPage();
    const cspErrors = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to execute/i.test(m.text())) cspErrors.push(m.text()); });
    await page.goto(base + '/edit?id=' + id);
    await page.waitForSelector('.sheet [data-zid="z11111111"]', { timeout: 20000 });
    // 实际输入
    await page.click('.sheet [data-zid="z11111111"]');
    await page.keyboard.press('End');
    await page.keyboard.type('MARK-' + s.label.length);
    // 实际保存
    await page.evaluate(() => window.__edSaveManual());
    await page.waitForTimeout(1200);
    // 读隔离盘
    const disk = fs.readFileSync(path.join(root, 'docs', id + '.html'), 'utf8');
    assert.ok(disk.includes('MARK-' + s.label.length), s.label + '：保存未写入隔离盘');
    // 刷新后仍在
    await page.reload();
    await page.waitForSelector('.sheet [data-zid="z11111111"]', { timeout: 20000 });
    const shown = await page.$eval('.sheet [data-zid="z11111111"]', (el) => el.textContent);
    assert.ok(shown.includes('MARK-' + s.label.length), s.label + '：刷新后内容丢失，实际 ' + shown);
    assert.equal(cspErrors.length, 0, s.label + '：已知主脚本不应被 CSP 拒绝（' + cspErrors[0] + '）');
    await page.close();
    console.log('  ✅ DEL-02 ' + s.label + '：输入 → 保存 → 隔离盘 → 刷新 全程可用');
  }

  // ===== DEL-02：未知脚本在严格 CSP 下保持拒绝（不执行）=====
  {
    const id = 'doc-unknown';
    makeDoc(id, UNKNOWN);
    const page = await ctx.newPage();
    const cspErrors = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to execute/i.test(m.text())) cspErrors.push(m.text()); });
    await page.goto(base + '/edit?id=' + id);
    await page.waitForSelector('.sheet [data-zid="z11111111"]', { timeout: 20000 });
    await page.waitForTimeout(600);
    const ran = await page.evaluate(() => window.__unknownRan || 0);
    if (ran !== 0) console.log('  [dbg] cspErrors=' + JSON.stringify(cspErrors) + ' ran=' + ran);
    assert.equal(ran, 0, '未知脚本被执行了（严格 CSP 未拦住）');
    assert.ok(cspErrors.length > 0, '未知脚本应产生 CSP 拒绝日志');
    await page.close();
    console.log('  ✅ DEL-02 未知脚本在严格 CSP 下保持拒绝');
  }

  console.log('PASS DEL-01/02: 脱敏历史主脚本夹具 + 严格 CSP 下历史/当前脚本可保存 + 未知脚本被拒');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
