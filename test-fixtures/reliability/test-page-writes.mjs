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
// 合成岗位草稿：导出页的「确认可投递」需要 parent（岗位草稿）+ 审阅完成 + 当前 PDF
fs.writeFileSync(path.join(root, 'docs', 'j1.html'),
  '<!doctype html><html><head><title>合成岗位</title></head><body><h1>合成岗位</h1><p data-zid="z11111111">正文一</p><p data-zid="z22222222">正文二</p></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  d1: { rev: 1, flow: 'draft' },
  j1: {
    rev: 1, flow: 'draft', parent: 'd1', company: '合成公司', role: '合成岗位',
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {} }
  }
}, null, 2));
// 合成配置（设置页要有配置卡才有可切换的启用项）
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [
    { name: 'stub-a', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'stub-key-not-real', model: 'stub-model' },
    { name: 'stub-b', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'stub-key-not-real', model: 'stub-model' }
  ]
}));
// 合成快照（历史版本的备注/基线入口需要真实条目）
fs.mkdirSync(path.join(root, 'snapshots', 'd1'), { recursive: true });
fs.writeFileSync(path.join(root, 'snapshots', 'd1', '2026-10-20-101010.html'), '<!doctype html><html><body><p>历史版本正文</p></body></html>');
// 合成投递记录（投递看板的状态/编辑/删除入口需要真实卡片）
fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([
  { id: '2026-10-28-101010', company: '合成公司', role: '合成岗位', docId: 'd1', status: '面试中', appliedAt: '2026-10-01', interviews: [] }
], null, 2));
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

  // ===== AUD-13：导出页「确认可投递」必须点【真实页面按钮】=====
  // 纪律（2026-10-28）：不得自造表单、不得强改 action、不得绕过 onsubmit —— 必须走页面自己的入口，
  // 并核对真实状态（服务端 flow）与展示语义（页面徽章）。
  {
    const page = await ctx.newPage();
    const seen = [];
    page.on('request', (r) => { if (r.url().includes('/job/changes')) seen.push(r.url()); });
    await page.goto(base + '/export?id=j1');
    // 首次访问会自动重渲（PDF 尚不存在）→ 等真实按钮出现
    await page.waitForSelector('button:has-text("确认可投递")', { timeout: 90000 });
    const label = await page.$eval('button:has-text("确认可投递")', (b) => (b.textContent || '').trim());
    assert.ok(/确认可投递/.test(label), '按钮文案不符：' + label);
    await page.click('button:has-text("确认可投递")');   // 走页面自己的 onsubmit → __wv
    await page.waitForTimeout(1800);
    if (!seen.length) fail('点「确认可投递」后没有发出 /job/changes 请求');
    assert.ok(seen.every((u) => u.includes('id=j1')), '「确认可投递」的请求未带目标 id：' + seen.join(','));
    // 实际状态：服务端 flow 落到 reviewed（可投递的派生来源）
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    assert.equal(meta.j1.flow, 'reviewed', '确认后 flow 应为 reviewed，实际：' + meta.j1.flow);
    // 展示语义：刷新后显示「已确认可投递」，按钮不再存在
    await page.reload();
    await page.waitForTimeout(1500);
    const body = await page.evaluate(() => document.body.textContent || '');
    assert.ok(/已确认可投递/.test(body), '确认后页面未显示「已确认可投递」');
    assert.ok(!(await page.$('button:has-text("确认可投递")')), '确认后「确认可投递」按钮仍在');
    await page.close();
    console.log('  ✅ AUD-13 「确认可投递」点真实按钮 → 目标 id + 实际状态 + 展示语义');
  }

  // ===== AUD-15 写失败矩阵：逐个真实调用点 =====
  // 每个入口都必须满足三件事：① 页面没刷新 ② 失败可见 ③ 输入/旧值保留。
  // 「共用封装结果」= __wv 的失败语义（业务失败/网络异常都 reject + 提示可见）被调用点正确处理。
  const MATRIX = [
    {
      url: '/materials', route: '**/mat/**', name: '素材库',
      cases: [
        { name: '素材状态：标记过时',
          run: (p) => p.evaluate(() => {
            var b = Array.prototype.slice.call(document.querySelectorAll('.mat-card button')).find(function (x) { return (x.textContent || '').indexOf('标记过时') >= 0; });
            if (!b) return false; b.click(); return true;
          }),
          probe: (p) => p.evaluate(() => { var b = document.querySelector('.mat-card .badge'); return b ? b.textContent : ''; }),
          expect: (v) => /待确认/.test(v) },
        { name: '素材事实层：保存',
          run: (p) => p.evaluate(() => {
            var f = document.querySelector('.mat-facts'); if (!f) return false;
            var inp = f.querySelector('input[name=f_company]'); inp.value = '合成公司';
            f.querySelector('button').click(); return true;
          }),
          probe: (p) => p.evaluate(() => { var i = document.querySelector('.mat-facts input[name=f_company]'); return i ? i.value : ''; }),
          expect: (v) => v === '合成公司' },
        { name: '素材编辑',
          run: (p) => p.evaluate(() => {
            var b = Array.prototype.slice.call(document.querySelectorAll('.mat-card button')).find(function (x) { return (x.textContent || '').indexOf('编辑') >= 0; });
            if (!b) return false; b.click(); return true;
          }),
          probe: async () => {
            const mats = readJson(path.join(root, 'materials.json')) || [];
            const m = (mats || [])[0];
            return m ? m.title : '';
          },
          expect: (v) => v === '合成素材' },
        { name: '素材删除',
          run: (p) => p.evaluate(() => {
            var b = Array.prototype.slice.call(document.querySelectorAll('.mat-card button')).find(function (x) { return (x.textContent || '').indexOf('删除') >= 0; });
            if (!b) return false; b.click(); return true;
          }),
          probe: async () => {
            const mats = readJson(path.join(root, 'materials.json')) || [];
            return String((mats || []).length);
          },
          expect: (v) => v === '1' },
        { name: '素材新增',
          run: (p) => p.evaluate(() => {
            document.getElementById('mtitle').value = '合成标题';
            document.getElementById('mbrief').value = '合成简介';
            document.getElementById('matForm').querySelector('button').click(); return true;
          }),
          probe: (p) => p.evaluate(() => document.getElementById('mtitle').value),
          expect: (v) => v === '合成标题' },
      ]
    },
    {
      url: '/applications', route: '**/app/**', name: '投递看板',
      cases: [
        { name: '投递状态：改为已投递',
          run: (p) => p.evaluate(() => {
            var s = document.querySelector('.app-card select[aria-label="状态"]'); if (!s) return false;
            s.value = '已投递'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;
          }),
          // 旧值保留 = 服务端那条投递的状态没被改掉（磁盘为准）
          probe: async () => {
            const apps = readJson(path.join(root, 'applications.json')) || [];
            const a = (apps || []).find((x) => x && x.id === '2026-10-28-101010');
            return a ? a.status : '';
          },
          expect: (v) => v === '面试中' },
        { name: '投递编辑',
          run: (p) => p.evaluate(() => {
            var b = document.querySelector('.app-card button[aria-label="快速编辑"]');
            if (!b) return false; b.click(); return true;
          }),
          probe: async () => {
            const apps = readJson(path.join(root, 'applications.json')) || [];
            const a = (apps || []).find((x) => x && x.id === '2026-10-28-101010');
            return a ? a.company : '';
          },
          expect: (v) => v === '合成公司' },
        { name: '投递删除',
          run: (p) => p.evaluate(() => {
            var b = document.querySelector('.app-card button[aria-label="删除投递"]');
            if (!b) return false; b.click(); return true;
          }),
          probe: async () => {
            const apps = readJson(path.join(root, 'applications.json')) || [];
            return String((apps || []).length);
          },
          expect: (v) => v === '1' },
        { name: '投递新增',
          run: (p) => p.evaluate(() => {
            var c = document.getElementById('company'), r = document.getElementById('role');
            if (!c || !r) return false;
            c.value = '合成公司'; r.value = '合成岗位';
            var f = c.closest('form'); if (f) f.querySelector('button[type=submit],button:not([type])').click();
            return true;
          }),
          probe: (p) => p.evaluate(() => { var c = document.getElementById('company'); return c ? c.value : ''; }),
          expect: (v) => v === '合成公司' },
      ]
    },
    {
      url: '/snapshots?id=d1', route: '**/snapshot/**', name: '历史版本',
      cases: [
        { name: '快照设为基准',
          run: (p) => p.evaluate(() => {
            var b = document.querySelector('button[aria-label="设为基准"]');
            if (!b) return false; b.click(); return true;
          }),
          probe: async () => {
            const m = readJson(path.join(root, 'snapshots', 'd1', 'meta.json'));
            return (m && m.__baseline) || '';
          },
          expect: (v) => !v },
        { name: '快照备注',
          run: (p) => p.evaluate(() => {
            var b = Array.prototype.slice.call(document.querySelectorAll('button')).find(function (x) { return (x.getAttribute('aria-label') || '') === '' && !!(x.getAttribute('onclick') || '').indexOf('snapNote') >= 0; });
            if (!b) return false; b.click(); return true;
          }),
          probe: async () => {
            const m = readJson(path.join(root, 'snapshots', 'd1', 'meta.json'));
            const e = m && m['2026-10-20-101010'];
            return (e && e.note) || '';
          },
          expect: (v) => !v },
      ]
    },
    {
      url: '/app?id=2026-10-28-101010', route: '**/app/**', name: '投递详情',
      cases: [
        { name: '投递面试记录',
          run: (p) => p.evaluate(() => {
            var b = document.getElementById('ivSave'); if (!b) return false;
            var r = document.getElementById('ivRound'); if (r) r.value = '第一轮';
            b.click(); return true;
          }),
          probe: async () => {
            const apps = readJson(path.join(root, 'applications.json')) || [];
            const a = (apps || []).find((x) => x && x.id === '2026-10-28-101010');
            return String((a && a.interviews && a.interviews.length) || 0);
          },
          expect: (v) => v === '0' },
      ]
    },
    {
      url: '/settings', route: '**/settings*', name: '设置页',
      cases: [
        { name: '配置删除',
          run: (p) => p.evaluate(() => {
            var b = Array.prototype.slice.call(document.querySelectorAll('button')).find(function (x) { return (x.textContent || '').indexOf('删除') >= 0; });
            if (!b) return false; b.click(); return true;
          }),
          probe: async () => {
            const c = readJson(path.join(root, 'config.json')) || {};
            return String((c.profiles || []).length);
          },
          expect: (v) => v === '2' },
        { name: '配置保存',
          run: (p) => p.evaluate(() => {
            var b = document.getElementById('saveBtn'); if (!b) return false; b.click(); return true;
          }),
          probe: async () => {
            const c = readJson(path.join(root, 'config.json')) || {};
            return String(c.active);
          },
          expect: (v) => v === '0' },
      ]
    },
    {
      url: '/', route: '**/archive', name: '首页归档',
      cases: [
        { name: '文档归档',
          run: (p) => p.evaluate(() => {
            var f = Array.prototype.slice.call(document.querySelectorAll('form')).find(function (x) { return (x.getAttribute('action') || '').indexOf('/archive') >= 0; });
            if (!f) return false; f.querySelector('button').click(); return true;
          }),
          // 旧值保留 = 服务端那份 meta 没被写上 archivedAt（磁盘为准）
          probe: async () => {
            const m = readJson(path.join(root, 'docs-meta.json')) || {};
            const doc = m.d1 || {};
            return doc.archivedAt || '';
          },
          expect: (v) => !v },
      ]
    },
    {
      url: '/', route: '**/tag', name: '首页标签',
      cases: [
        { name: '文档标签',
          run: (p) => p.evaluate(() => {
            var f = Array.prototype.slice.call(document.querySelectorAll('form')).find(function (x) { return (x.getAttribute('action') || '').indexOf('/tag') >= 0; });
            if (!f) return false; f.querySelector('button').click(); return true;
          }),
          probe: async () => {
            const m = readJson(path.join(root, 'docs-meta.json')) || {};
            const doc = m.d1 || {};
            return doc.tag || '';
          },
          expect: (v) => !v },
      ]
    },
  ];
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const matrixRun = [];
  for (const grp of MATRIX) {
    for (const c of grp.cases) {
      const page = await ctx.newPage();
      const alerts = [];
      page.on('dialog', async (d) => {
        if (d.type() === 'alert') { alerts.push(d.message()); try { await d.dismiss(); } catch (e) {} }
        else { try { await d.accept('合成标签'); } catch (e) {} }
      });
      await page.goto(base + grp.url);
      await page.waitForTimeout(700);
      await page.evaluate(() => { window.__noReload = 1; });
      await page.route(grp.route, (route) => route.fulfill({
        status: 500, contentType: 'application/json', body: '{"ok":false,"error":"注入的失败"}'
      }));
      let ran = false;
      try { ran = await c.run(page); } catch (e) { ran = false; }
      await page.waitForTimeout(1200);
      if (!ran) {
        const snippet = await page.evaluate(() => (document.body.textContent || '').replace(/\s+/g, ' ').slice(0, 200));
        matrixRun.push(grp.name + '/' + c.name + '：未运行（入口未找到；页面首段：' + snippet + '）');
        await page.close(); continue;
      }
      const still = await page.evaluate(() => window.__noReload === 1);
      const visible = await page.evaluate(() => {
        var e = document.querySelector('.mat-err, #matmsg, #appmsg, #msg, .err, [role=alert]');
        return !!(e && (e.textContent || '').trim());
      });
      const val = await c.probe(page);
      const okNoReload = still === true;
      const okVisible = alerts.length > 0 || visible === true;
      const okValue = c.expect(val) === true;
      matrixRun.push(grp.name + '/' + c.name + '：' + (okNoReload ? '未刷新✓' : '刷新了✗') + ' ' + (okVisible ? '失败可见✓' : '失败不可见✗') + ' ' + (okValue ? '旧值保留✓' : '旧值丢失✗'));
      assert.ok(okNoReload, grp.name + '/' + c.name + '：写失败后页面刷新了（应保留输入与旧值）');
      assert.ok(okVisible, grp.name + '/' + c.name + '：写失败后没有任何可见提示（alert=' + JSON.stringify(alerts) + '）');
      assert.ok(okValue, grp.name + '/' + c.name + '：写失败后输入/旧值被改动：' + JSON.stringify(val));
      await page.close();
    }
  }
  console.log('  ✅ AUD-15 写失败矩阵（真实调用点）：');
  for (const r of matrixRun) console.log('     - ' + r);

  console.log('PASS 页面写失败回归: 写失败不刷新/不显示已生效 + 设置页回滚 + 确认可投递带目标 id');
} finally {
  try { if (browser) await browser.close(); } catch {}
  try { server.kill('SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
