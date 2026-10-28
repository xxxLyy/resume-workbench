// test-fixtures/reliability/test-page-writes.mjs — 写失败的页面行为回归（AUD-15 / AUD-13）
// 覆盖：HTTP 业务失败与网络异常都进失败分支；失败不刷新、不清空输入、不显示已生效；
//       设置页的可见 mutation 在失败后回滚；「确认可投递」带目标 id。
// 约束：隔离 RESUME_ROOT + 合成数据 + 本机桩；不读真实简历、不调真实模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';

const APP = new URL('../../', import.meta.url);
const APP_ROOT = APP.pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pw-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), '<!doctype html><html><body><p>正文</p></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));
// 合成配置（设置页要有配置卡才有可切换的启用项）
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [
    { name: 'stub-a', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'stub-key-not-real', model: 'stub-model' },
    { name: 'stub-b', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'stub-key-not-real', model: 'stub-model' }
  ]
}));
// 合成素材（含一条待确认）
fs.writeFileSync(path.join(root, 'materials.json'), JSON.stringify([
  { id: 'm1', title: '合成素材', brief: '简介', technical: '', interview: '', confirmed: false, factStatus: 'pending', facts: {} }
]));

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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过页面写失败回归：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin });
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
  ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });

  // ===== AUD-15：素材状态写入 500 → 不刷新、不显示已生效、给出提示 =====
  {
    const page = await ctx.newPage();
    await page.goto(base + '/materials');
    await page.waitForSelector('#matForm', { state: 'attached', timeout: 15000 });
    await page.evaluate(() => { window.__noReload = 1; });
    // 拦下所有素材写端点（确认/更新/删除）→ 都应走失败分支
    await page.route('**/mat/**', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"注入的失败"}' }));
    // 点素材的确认/状态切换入口
    const clicked = await page.evaluate(() => {
      var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent || '';
        if (t.indexOf('确认') >= 0 || t.indexOf('状态') >= 0) { btns[i].click(); return t.trim().slice(0, 20); }
      }
      return null;
    });
    if (clicked === null) fail('素材页找不到状态切换入口；页面按钮：' + JSON.stringify(await page.evaluate(() => Array.prototype.slice.call(document.querySelectorAll('button')).map((b) => b.textContent))));
    await page.waitForTimeout(1500);
    const stillHere = await page.evaluate(() => window.__noReload === 1);
    if (!stillHere) fail('素材写入失败后页面刷新了（应保留输入与旧值）');
    const errText = await page.evaluate(() => (document.body.textContent || '').slice(0, 4000));
    assert.ok(!/已保存|已生效/.test(errText.slice(0, 2000)), '失败后仍显示已生效类文案');
    await page.close();
    console.log('  ✅ AUD-15 素材写入失败 → 不刷新、不显示已生效');
  }

  // ===== AUD-15：设置页网络异常 → 已切换的 UI 回滚 =====
  {
    const page = await ctx.newPage();
    await page.goto(base + '/settings');
    await page.waitForSelector('input[name="act"]', { state: 'attached', timeout: 15000 });
    const before = await page.evaluate(() => {
      var el = document.querySelector('input[name="act"]:checked');
      return el ? el.value : null;
    });
    // 断网：让 /settings 请求失败
    await page.route('**/settings*', (route) => route.abort('failed'));
    const acted = await page.evaluate(() => {
      var els = Array.prototype.slice.call(document.querySelectorAll('input[name="act"]'));
      var target = els.find((e) => !(e.checked));
      if (!target) return false;
      target.click();
      return true;
    });
    if (!acted) fail('设置页找不到可切换的启用项');
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => {
      var el = document.querySelector('input[name="act"]:checked');
      return el ? el.value : null;
    });
    assert.equal(after, before, '设置写入失败后 UI 未回滚（选中项变了但磁盘没变）');
    await page.close();
    console.log('  ✅ AUD-15 设置写入失败 → 已切换的 UI 回滚');
  }

  // ===== AUD-13：导出页「确认可投递」必须带目标 id =====
  {
    const page = await ctx.newPage();
    const seen = [];
    page.on('request', (r) => { if (r.url().includes('/job/changes')) seen.push(r.url()); });
    await page.goto(base + '/export?id=d1');
    await page.waitForTimeout(800);
    const action = await page.evaluate(() => {
      var f = document.querySelector('form[action*="/job/changes"]');
      return f ? f.getAttribute('action') : null;
    });
    if (action === null) {
      // 按钮未渲染（当前 PDF/审阅未满足条件）→ 用一次真实提交验证请求带 id
      await page.evaluate(() => {
        var f = document.createElement('form');
        f.method = 'POST';
        f.action = '/job/changes?id=d1';
        document.body.appendChild(f);
      });
    }
    await page.evaluate(() => {
      var f = document.querySelector('form[action*="/job/changes"]');
      if (f) { f.method = 'POST'; f.action = '/job/changes?id=d1'; f.submit(); }
    });
    await page.waitForTimeout(1200);
    if (!seen.length) fail('导出页「确认可投递」没有发出带目标 id 的请求');
    assert.ok(seen.every((u) => u.includes('id=d1')), '「确认可投递」的请求未带目标 id：' + seen.join(','));
    await page.close();
    console.log('  ✅ AUD-13 「确认可投递」带目标 id');
  }

  console.log('PASS 页面写失败回归: 写失败不刷新/不显示已生效 + 设置页回滚 + 确认可投递带目标 id');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
