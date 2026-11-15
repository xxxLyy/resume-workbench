// lib-job-boot.mjs — 岗位面板浏览器夹具的共享启动库（B 线批 3 起用）
// 职责：隔离根 + 合成岗位草稿文档 + 候选清单 → 起真实 server + Chromium，暴露常用辅助。
// 非测试件（不被套件直接运行）；约束：不读真实简历、不碰 7766、不调真实模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';
import { normalizeZids } from '../../zone.mjs';

export async function bootJobFixture({ name, fillDoc, changes, zones = {}, metaExtra = {} }) {
  const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
  const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-' + name + '-'));
  for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });

  const DOC = 'doc1';
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
    ['{{SKILLS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', DOC]]) doc = doc.replaceAll(k, () => v);
  doc = normalizeZids(fillDoc(doc));   // 预打 zid（2026-11-15）：编辑器首跑对未打点段落会先 autosave，夹具统一全打点保持「打开不写盘」
  const writeMeta = () => {
    fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
      [DOC]: Object.assign({
        rev: 1, flow: 'draft', kind: 'job', company: '合成公司', role: '合成岗位',
        zones, job: { changes: changes.map((c) => Object.assign({}, c, { status: 'pending' })), evidence: [], materials: [], todos: [], feedback: [], genTasks: {} }
      }, metaExtra)
    }, null, 2));
  };
  writeMeta();
  const resetFixture = () => { fs.writeFileSync(path.join(root, 'docs', DOC + '.html'), doc); writeMeta(); };
  resetFixture();

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
  const base = `http://127.0.0.1:${port}`;

  const cleanup = () => {
    try { server.kill('SIGKILL'); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  };
  try {
    for (let i = 0; i < 150; i++) {
      if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
      try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
      await new Promise((r) => setTimeout(r, 100));
      if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
    }
    let bin;
    try { bin = await resolveChromium(); }
    catch (e) { cleanup(); console.log('⚠️  Chromium 不可用，跳过：' + (e && e.message || e)); process.exit(2); }
    const browser = await chromium.launch({ executablePath: bin });
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 950 } });
    ctx.on('page', (p) => { p.on('dialog', (d) => d.accept().catch(() => {})); });
    const page = await ctx.newPage();

    const h = {
      DOC, root, base, page, browser, cleanup, resetFixture, fail,
      paraText: (zid) => page.$eval('.sheet [data-zid="' + zid + '"]', (el) => el.textContent),
      paraHtml: (zid) => page.$eval('.sheet [data-zid="' + zid + '"]', (el) => el.innerHTML),
      noteText: () => page.evaluate(() => (document.querySelector('#ed-pane-review .jp-msg') || {}).textContent || ''),
      serverState: async () => (await (await fetch(base + '/job/changes?id=' + DOC)).json()),
      diskHtml: () => fs.readFileSync(path.join(root, 'docs', DOC + '.html'), 'utf8'),
      reload: async () => {
        await page.goto(base + '/edit?id=' + DOC);
        await page.waitForSelector('#ed-pane-review', { timeout: 15000 });
        await page.waitForFunction(() => (document.querySelector('#ed-pane-review') || {}).textContent !== '加载中…', null, { timeout: 15000 });
      },
      acceptBtn: (id) => '#ed-pane-review [data-change="' + id + '"] button.jp-accept',
      waitFor: async (fn, ms, what) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(120); }
        fail('等待超时：' + what + '（提示：' + (await h.noteText()).slice(-160) + '）');
      },
      saveBodies: [],
      trackSaves: (mode) => page.route('**/save?**', async (route) => {
        const ct = route.request().headers()['content-type'] || '';
        if (!ct.includes('application/json')) return route.continue();
        h.saveBodies.push(JSON.parse(route.request().postData()));
        if (mode === 'reject409') return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, conflict: true, error: '注入：文档已被其他窗口更新' }) });
        if (mode === 'abort') return route.abort('failed');
        return route.continue();
      }),
      untrackSaves: () => page.unroute('**/save?**')
    };
    return h;
  } catch (e) { cleanup(); throw e; }
}
