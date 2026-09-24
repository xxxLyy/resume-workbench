// test-editor.mjs — 浏览器级验证（playwright-core + 本机 Chromium headless shell）
// 用法: node test-editor.mjs <baseURL> <docId> <dataRoot>
// 覆盖：保存期间继续编辑不误判已保存、离线正文+排版恢复、多标签冲突、审阅面板接受与持久化、导航无障碍。
// 仅使用隔离数据根，绝不触碰真实数据。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveChromium, invalidateCache } from './chromium.mjs';
import { updateMeta } from './tx.mjs';

const [base, docId, dataRoot] = process.argv.slice(2);
if (!base || !docId || !dataRoot) { console.error('用法: node test-editor.mjs <baseURL> <docId> <dataRoot>'); process.exit(2); }
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function ok(name) { console.log('  ✅ ' + name); }
function bad(name, extra) { failures++; console.error('  ❌ ' + name + (extra ? '：' + extra : '')); }

// ===== S1 Task 3：保存事务 / 共享 meta 原子 / 跨进程锁 / 冻结点（node 级；自spawn 隔离根+隔离端口的服务，绝不触碰 base 服务与常驻服务）=====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TX_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-t3-'));
// 夹具文档：主 <style> + 可选内联 typo-custom + body 正文（含 DOC_ID 标记，兼容 /edit）
const txDoc = (id, body, typo) => '<!doctype html>\n<html><head><meta charset="utf-8">\n<style>.sheet{color:#111}</style>\n'
  + (typo ? '<style id="typo-custom">' + typo + '</style>\n' : '') + '</head>\n<body><div class="sheet" contenteditable="true">'
  + body + '</div><script>var DOC_ID = \'' + id + '\';</script></body></html>\n';
function seedRoot(rootDir, docs, meta) {
  for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(rootDir, d), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'docs-meta.json'), JSON.stringify(meta || {}));
  fs.writeFileSync(path.join(rootDir, 'applications.json'), '[]');
  fs.writeFileSync(path.join(rootDir, 'materials.json'), '[]');
  for (const [id, html] of Object.entries(docs)) fs.writeFileSync(path.join(rootDir, 'docs', id + '.html'), html);
  const fr = path.join(rootDir, 'fake-render.sh');   // root-agnostic 假渲染器（读 env RESUME_ROOT），仅供 /rollback 触发的渲染
  fs.writeFileSync(fr, '#!/bin/bash\nshift\nif [ "$1" = "--src" ]; then src="$2"; out="$4"; else src="$RESUME_ROOT/docs/$1.html"; out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\nprintf "%%PDF-1.4 fake\\n" > "$out"\n');
  fs.chmodSync(fr, 0o755);
  return fr;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function spawnServer(rootDir, extraEnv) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
      env: { ...process.env, RESUME_ROOT: rootDir, PORT: String(port), ...(extraEnv || {}) },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = ''; child.stderr.on('data', (d) => { stderr += d; });
    const base = 'http://127.0.0.1:' + port;
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 12000) {
      if (child.exitCode !== null) break;                 // 提前退出（端口冲突或启动错误）
      try { await fetch(base + '/'); ready = true; break; } catch {}
      await sleep(80);
    }
    if (ready) return { child, base, pid: child.pid };
    try { child.kill('SIGKILL'); } catch {}
    if (/端口不可用|EADDRINUSE/.test(stderr)) continue;   // 端口被占 → 换端口重试
    throw new Error('测试服务启动失败: ' + stderr.slice(0, 600));
  }
  throw new Error('测试服务启动失败（端口重试耗尽）');
}

async function runTxTests() {
  const servers = [];
  try {
    // ---------- ROOT2（无 gap）：① typo 往返 / ④ 回滚归一 / ⑤ 复制继承 / ⑥ 迁移锁 503 ----------
    const ROOT2 = path.join(TX_TMP, 'r2');
    const fr2 = seedRoot(ROOT2, { t3: txDoc('t3', 'T3-SEED', '') }, {});
    const srv2 = await spawnServer(ROOT2, { RESUME_RENDER_BIN: fr2 });
    servers.push(srv2.child);
    const B2 = srv2.base;
    const readMeta2 = () => JSON.parse(fs.readFileSync(path.join(ROOT2, 'docs-meta.json'), 'utf8'));
    const readDoc2 = () => fs.readFileSync(path.join(ROOT2, 'docs', 't3.html'), 'utf8');
    const post = (u, body, ct) => fetch(B2 + u, { method: 'POST', headers: ct ? { 'Content-Type': ct } : {}, body, redirect: 'manual' });

    // ① typo 经 meta 往返（当前文档落盘不含 typo-custom，值只存 meta；rev 递增；快照 manifest 字段一次写全）
    {
      const j1 = await (await post('/save?id=t3', txDoc('t3', 'T3-V1', '/*T3A*/body{font-size:14.5px}'), 'text/html; charset=utf-8')).json();
      const m1 = readMeta2();
      if (!j1.ok) bad('① 首次保存失败', JSON.stringify(j1));
      else if (readDoc2().includes('typo-custom')) bad('① 落盘文档不应含 typo-custom');
      else if (!readDoc2().includes('T3-V1')) bad('① 正文未落盘');
      else if ((m1.t3 || {}).typo !== '/*T3A*/body{font-size:14.5px}') bad('① typo 未入 meta', JSON.stringify(m1.t3));
      else if ((m1.t3 || {}).rev !== 1) bad('① rev 应为 1', String((m1.t3 || {}).rev));
      else {
        await (await post('/save?id=t3', txDoc('t3', 'T3-V2', '/*T3B*/body{font-size:16px}'), 'text/html; charset=utf-8')).json();
        const m2 = readMeta2();
        if (readDoc2().includes('typo-custom') || !readDoc2().includes('T3-V2')) bad('① 二次保存正文/剥离异常');
        else if ((m2.t3 || {}).typo !== '/*T3B*/body{font-size:16px}' || (m2.t3 || {}).rev !== 2) bad('① 二次保存 typo/rev 不符', JSON.stringify(m2.t3));
        else ok('① typo 经 meta 往返（落盘去 typo-custom、值入 meta、rev 递增）');
      }
      // 快照 manifest 字段一次写全（chromiumBin 等允许 null）
      const mans = fs.existsSync(path.join(ROOT2, 'snapshots', 't3')) ? fs.readdirSync(path.join(ROOT2, 'snapshots', 't3')).filter((f) => f.endsWith('.manifest.json')).sort() : [];
      if (!mans.length) bad('① 手动保存未写快照 manifest');
      else {
        const man = JSON.parse(fs.readFileSync(path.join(ROOT2, 'snapshots', 't3', mans[mans.length - 1]), 'utf8'));
        const need = ['theme', 'styleHash', 'typoHash', 'renderInputId', 'editorVersion', 'chromiumBin', 'browserVersion', 'fonts', 'dpi', 'createdAt'];
        const miss = need.filter((k) => !(k in man));
        if (miss.length) bad('① manifest 缺字段', miss.join(','));
        else if (!/^[0-9a-f]{40}$/.test(man.renderInputId) || !/^[0-9a-f]{40}$/.test(man.typoHash)) bad('① manifest 哈希非完整 40hex', JSON.stringify(man));
        else if (man.chromiumBin !== null || man.browserVersion !== null || man.dpi !== null || !Array.isArray(man.fonts)) bad('① manifest 环境字段应 null/[]（快照不强制 resolveChromium）', JSON.stringify(man));
        else ok('① 快照 manifest 字段一次写全（10 字段 / renderInputId 40hex / chromium 字段 null）');
      }
    }

    // ④ /rollback 归一化（冻结→当前：html 无 typo-custom、meta.typo=冻结内联值、rev++、styleHash 登记）
    {
      await (await post('/save?id=t3', txDoc('t3', 'T3-V3', '/*T3C*/body{font-size:18px}'), 'text/html; charset=utf-8')).json();  // 快照旧状态(T3-V2+T3B)
      const snapFiles = fs.readdirSync(path.join(ROOT2, 'snapshots', 't3')).filter((f) => f.endsWith('.html')).sort();
      const snapTs = snapFiles[snapFiles.length - 1].replace('.html', '');
      const revBefore = readMeta2().t3.rev;
      await post('/rollback?id=t3&ts=' + snapTs, '');
      const htmlRb = readDoc2();
      const mRb = readMeta2().t3;
      if (htmlRb.includes('typo-custom')) bad('④ 回滚应归一化（html 不含 typo-custom）');
      else if (!htmlRb.includes('T3-V2') || htmlRb.includes('T3-V3')) bad('④ 未回到冻结正文 T3-V2', htmlRb.slice(0, 100));
      else if (mRb.typo !== '/*T3B*/body{font-size:16px}') bad('④ meta.typo 应=冻结内联值', JSON.stringify(mRb.typo));
      else if (!(mRb.rev > revBefore)) bad('④ rev 应递增', mRb.rev + ' vs ' + revBefore);
      else if (!mRb.styleHash) bad('④ styleHash 应登记');
      else ok('④ /rollback 归一化（html 无 typo-custom、meta.typo=冻结值、rev++、styleHash 登记）');
    }

    // ⑤ /duplicate 继承 meta（typo/styleHash，rev 重置 1）且 html 无 typo-custom（冻结→归一化，不 copy 冻结字节）
    {
      const srcMeta = readMeta2().t3;
      await post('/duplicate?id=t3&to=t3-copy', '');
      const dupHtml = fs.readFileSync(path.join(ROOT2, 'docs', 't3-copy.html'), 'utf8');
      const dupMeta = readMeta2()['t3-copy'];
      if (dupHtml.includes('typo-custom')) bad('⑤ 副本不应含 typo-custom');
      else if (!dupHtml.includes('T3-V2')) bad('⑤ 副本正文不符');
      else if (!dupMeta || dupMeta.typo !== srcMeta.typo) bad('⑤ meta.typo 未继承', JSON.stringify(dupMeta));
      else if (dupMeta.rev !== 1) bad('⑤ rev 应重置为 1', String(dupMeta.rev));
      else if (dupMeta.styleHash !== srcMeta.styleHash) bad('⑤ styleHash 未继承');
      else ok('⑤ /duplicate 继承 meta（typo/styleHash、rev=1）且 html 无 typo-custom');
    }

    // ⑥ 持 .migrate.lock 时 /save 与写请求 503（读不受影响），释放后恢复
    {
      fs.writeFileSync(path.join(ROOT2, '.migrate.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }));  // 外部鲜活 pid（非服务进程）
      const codeSave = (await post('/save?id=t3', txDoc('t3', 'SHOULD-NOT-WRITE', ''), 'text/html')).status;
      const codeTag = (await post('/tag', JSON.stringify({ id: 't3', tag: 'nope' }), 'application/json')).status;
      const codeGet = (await fetch(B2 + '/')).status;
      fs.rmSync(path.join(ROOT2, '.migrate.lock'), { force: true });
      const codeAfter = (await post('/save?id=t3', txDoc('t3', 'T3-AFTER-LOCK', ''), 'text/html')).status;
      const afterHtml = readDoc2();
      if (codeSave !== 503) bad('⑥ 持锁 /save 应 503', String(codeSave));
      else if (codeTag !== 503) bad('⑥ 持锁写请求 /tag 应 503', String(codeTag));
      else if (codeGet !== 200) bad('⑥ 读（GET）不应被锁阻断', String(codeGet));
      else if (codeAfter !== 200) bad('⑥ 释放锁后 /save 应恢复', String(codeAfter));
      else if (!afterHtml.includes('T3-AFTER-LOCK') || afterHtml.includes('SHOULD-NOT-WRITE')) bad('⑥ 锁语义落盘异常');
      else ok('⑥ 持 .migrate.lock 时 /save 与写请求 503（读不受影响），释放后恢复');
    }

    // ---------- ROOT3（gap=1200ms）：③ 并发 B 于 A 事务后（提交）/ ② kill -9 于两次 rename 之间 → 重启恢复 ----------
    const ROOT3 = path.join(TX_TMP, 'r3');
    const fr3 = seedRoot(ROOT3, { 'kill-a': txDoc('kill-a', 'KILL-V1', ''), 'kill-b': txDoc('kill-b', 'KILL-B', '') }, { 'kill-b': { tag: 'b-original' } });
    const srv3 = await spawnServer(ROOT3, { RESUME_RENDER_BIN: fr3, RESUME_TEST_SAVE_GAP_MS: '1200' });
    servers.push(srv3.child);
    const B3 = srv3.base;
    const readMeta3 = () => JSON.parse(fs.readFileSync(path.join(ROOT3, 'docs-meta.json'), 'utf8'));
    const readDocA3 = () => fs.readFileSync(path.join(ROOT3, 'docs', 'kill-a.html'), 'utf8');
    const waitDoc = (needle, ms) => { const t = Date.now(); return new Promise((res) => { const iv = setInterval(() => { let h = ''; try { h = readDocA3(); } catch {} if (h.includes(needle) || Date.now() - t > ms) { clearInterval(iv); res(h.includes(needle)); } }, 15); }); };

    // ③ B 在 A 事务开始之后（gap 内、rename#1 之后）更新另一文档 meta → A 提交后 B 仍在
    {
      const saveP = fetch(B3 + '/save?id=kill-a', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: txDoc('kill-a', 'KILL-V2', '/*KA*/body{font-size:13px}') }).then((r) => r.json()).catch((e) => ({ err: String(e) }));
      if (!await waitDoc('KILL-V2', 6000)) bad('③ rename#1 未落盘（无法在事务中注入 B）');
      else {
        updateMeta(ROOT3, 'kill-b', (m) => ({ ...(m || {}), tag: 'b-CONCURRENT' }));   // B 于 A 事务开始之后（直接 updateMeta：内部并发写者，绕 HTTP 503 门）
        const resA = await saveP;
        const mA = readMeta3();
        if (!resA || !resA.ok) bad('③ A 保存未成功', JSON.stringify(resA));
        else if ((mA['kill-a'] || {}).typo !== '/*KA*/body{font-size:13px}') bad('③ A typo 未入 meta', JSON.stringify(mA['kill-a']));
        else if ((mA['kill-b'] || {}).tag !== 'b-CONCURRENT') bad('③ A 提交后 B 并发更新丢失', JSON.stringify(mA['kill-b']));
        else if (readDocA3().includes('typo-custom')) bad('③ A 落盘不应含 typo-custom');
        else ok('③ B 于 A 事务开始后更新另一文档 meta → A 提交后 B 仍在（读最新、只 patch 目标文档）');
      }
    }

    // ② kill -9 于两次 rename 之间 → 重启 recoverPending → kill-a 无混版（正文+meta 回旧）、B 并发更新不丢、.tx 清空
    {
      const saveP2 = fetch(B3 + '/save?id=kill-a', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: txDoc('kill-a', 'KILL-V3', '/*KA3*/body{font-size:20px}') }).then((r) => r.json()).catch((e) => ({ killed: String(e) }));
      if (!await waitDoc('KILL-V3', 6000)) bad('② rename#1 未落盘（未命中 gap）');
      else {
        updateMeta(ROOT3, 'kill-b', (m) => ({ ...(m || {}), tag: 'b-AFTER-KILL' }));   // B 于 A 事务后、被杀前
        await sleep(150);                                                               // 仍在 gap（1200ms）内
        srv3.child.kill('SIGKILL');                                                     // 进程中断于两次 rename 之间
        await saveP2;
        const metaPre = readMeta3();
        const txPre = fs.existsSync(path.join(ROOT3, '.tx')) ? fs.readdirSync(path.join(ROOT3, '.tx')).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')) : [];
        if (!readDocA3().includes('KILL-V3')) bad('② 前置失败：rename#1 应已落盘');
        else if ((metaPre['kill-a'] || {}).typo === '/*KA3*/body{font-size:20px}') bad('② 前置失败：rename#2 不应执行（未命中 gap）');
        else if (!txPre.length) bad('② 前置失败：应有 pending tx 记录');
        else if ((metaPre['kill-b'] || {}).tag !== 'b-AFTER-KILL') bad('② B 被杀前更新应落盘', JSON.stringify(metaPre['kill-b']));
        else {
          const srv3b = await spawnServer(ROOT3, { RESUME_RENDER_BIN: fr3 });            // 重启：recoverPending 先于 listen
          servers.push(srv3b.child);
          const htmlPost = readDocA3();
          const metaPost = readMeta3();
          const txPost = fs.readdirSync(path.join(ROOT3, '.tx')).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
          if (htmlPost.includes('KILL-V3')) bad('② 恢复后正文应回滚（不含 KILL-V3）', htmlPost.slice(0, 100));
          else if (!htmlPost.includes('KILL-V2')) bad('② 恢复后正文应回到旧版 KILL-V2');
          else if (htmlPost.includes('typo-custom')) bad('② 恢复后正文不应含 typo-custom');
          else if ((metaPost['kill-a'] || {}).typo !== '/*KA*/body{font-size:13px}') bad('② 恢复后 meta 应回滚旧值', JSON.stringify(metaPost['kill-a']));
          else if ((metaPost['kill-b'] || {}).tag !== 'b-AFTER-KILL') bad('② 恢复不应覆盖 B 并发更新', JSON.stringify(metaPost['kill-b']));
          else if (txPost.length) bad('② 恢复后 .tx 应清空', txPost.join(','));
          else ok('② kill -9 于两次 rename 之间 → 重启恢复 → kill-a 无混版（正文+meta 回旧）、B 并发更新不丢、.tx 清空');
        }
      }
    }
  } finally {
    for (const c of servers) { try { c.kill('SIGKILL'); } catch {} }
    await sleep(50);
    try { fs.rmSync(TX_TMP, { recursive: true, force: true }); } catch {}
  }
}
await runTxTests();
if (failures) { console.error('❌ 事务/锁/冻结点验证失败 ' + failures + ' 项'); process.exit(1); }

let bin;
try { bin = await resolveChromium(); }
catch (e) { console.error('⚠️ Chromium 不可用，跳过浏览器级验证: ' + (e && e.message || e)); process.exit(2); }

// ===== 浏览器测试专用夹具：带两个项目条目的文档 + 岗位草稿 =====
const ED_DOC = 'ed-fixture';
const JOB_DOC = 'ed-fixture-v2';
{
  let tpl = fs.readFileSync(path.join(APP_ROOT, 'template.html'), 'utf8');
  const projects = '<div class="entry-head"><div class="entry-title">项目A</div><div class="entry-role">负责人</div><div class="entry-date">2024-2025</div></div>\n<ul><li>旧项目描述</li></ul>\n<div class="entry-head"><div class="entry-title">项目B</div><div class="entry-role">开发</div><div class="entry-date">2023</div></div>\n<ul><li>项目B描述</li></ul>';
  tpl = tpl.replaceAll('{{NAME}}', () => '测试员').replaceAll('{{CONTACT}}', () => 'test@example.com')
    .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
    .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => projects).replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => ED_DOC);
  fs.writeFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), tpl);
  fs.copyFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), path.join(dataRoot, 'docs', JOB_DOC + '.html'));
  const metaPath = path.join(dataRoot, 'docs-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta[JOB_DOC] = {
    parent: ED_DOC, company: '浏览器测试公司', role: '前端工程师', jd: 'React', createdAt: new Date().toISOString(), tag: '浏览器测试',
    job: {
      status: 'draft', sourceSnap: '', sourceHash: '', materials: [], generatedAt: null, deliveredAt: null, summary: '',
      changes: [
        { id: 'bt1', gen: 1, section: '项目经历', entry: '项目A', kind: 'replace', before: '旧项目描述', after: '新项目描述（定制）', reason: '对齐 JD', source: '母版', level: 'normal', status: 'pending' },
        { id: 'bt2', gen: 1, section: '项目经历', entry: '项目B', kind: 'hide', before: '', after: '', reason: '低相关', source: 'JD', level: 'important', status: 'pending' }
      ],
      todos: [{ section: '项目经历', question: '缺少量化指标', why: 'JD 要求数据驱动', resolved: false }]
    }
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta));
}

let browser;
try {
  browser = await chromium.launch({ executablePath: bin });
} catch (e) {
  // 缓存的二进制此刻不可启动（设计 §2.2 规则 4）：失效缓存重探一次；仍失败按环境不可用跳过（exit 2），绝不抛未捕获栈。
  invalidateCache();
  try {
    bin = await resolveChromium({ force: true });
    browser = await chromium.launch({ executablePath: bin });
  } catch (e2) {
    console.error('⚠️ Chromium 不可用，跳过浏览器级验证: ' + (e2 && e2.message || e2));
    process.exit(2);
  }
}
try {
  // ===== 1. 保存期间继续编辑：A 提交，B 期间产生，A 返回后 B 仍未保存 =====
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const orig = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).includes('/save')) {
          return new Promise((resolve, reject) => setTimeout(() => orig.apply(window, [url, opts]).then(resolve, reject), 800));
        }
        return orig.apply(window, [url, opts]);
      };
    });
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + ED_DOC);
    await page.waitForSelector('.sheet .summary');
    await page.click('.sheet .summary');
    await page.keyboard.press('End');
    await page.keyboard.type('AAA');
    const saveP = page.evaluate(() => window.__edSaveManual());
    await page.waitForTimeout(200);                       // 第一次保存已在途
    await page.keyboard.type('BBB');                      // 保存期间继续编辑
    await saveP;
    const dirtyAfterFirst = await page.evaluate(() => window.__edIsDirty());
    const cacheAfterFirst = await page.evaluate(() => localStorage.getItem('resume-autosave:' + window.__edDocId));
    if (dirtyAfterFirst !== true) bad('保存返回后新编辑被误判已保存'); else ok('保存返回后新编辑保持未保存');
    if (!cacheAfterFirst) bad('未保存修订的恢复缓存被提前清空'); else ok('未保存修订的恢复缓存仍在');
    await page.waitForTimeout(3000);                      // 等续存保存完成（保存返回后 600ms 触发 + 在途）
    const disk1 = fs.readFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), 'utf8');
    if (!disk1.includes('AAA') || !disk1.includes('BBB')) bad('排队保存未把 A、B 都写入磁盘');
    else ok('排队保存将两次编辑都写入磁盘');
    const state = await page.evaluate(() => document.getElementById('saveState').dataset.state);
    if (state !== 'saved') bad('最终状态非已保存：' + state); else ok('最终状态回到已保存');
    await ctx.close();
  }

  // ===== 2. 离线编辑（正文+排版）→ 恢复缓存 → 重载恢复 =====
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const orig = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).includes('/save') && localStorage.getItem('ed-fail-save') === '1') {
          return Promise.reject(new Error('network down (test)'));
        }
        return orig.apply(window, [url, opts]);
      };
    });
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + ED_DOC);
    await page.waitForSelector('.sheet .summary');
    await page.evaluate(() => localStorage.setItem('ed-fail-save', '1'));
    await page.click('.sheet .summary');
    await page.keyboard.press('End');
    await page.keyboard.type('RECOVER-EDIT');
    await page.evaluate(() => window.__edSetTypo('/*TYPO-CUSTOM*/body{font-size:15px;line-height:1.5}'));
    await page.waitForTimeout(700);                       // 等缓存 debounce
    const cache = await page.evaluate(() => localStorage.getItem('resume-autosave:' + window.__edDocId));
    let parsed = null;
    try { parsed = JSON.parse(cache); } catch {}
    if (!parsed || !String(parsed.body).includes('RECOVER-EDIT')) bad('失败保存未缓存正文');
    else if (!String(parsed.typo || '').includes('font-size:15px')) bad('失败保存未缓存排版设置');
    else ok('离线修改的正文与排版都进入恢复缓存');
    // 网络恢复后重载：应出现恢复条，恢复正文+排版
    await page.evaluate(() => localStorage.setItem('ed-fail-save', '0'));
    await page.reload();
    await page.waitForSelector('.recovery-bar');
    await page.click('.recovery-bar button');
    await page.waitForTimeout(200);
    const restored = await page.evaluate(() => ({
      body: document.querySelector('.sheet').textContent.includes('RECOVER-EDIT'),
      typo: (document.getElementById('typo-custom') || {}).textContent || ''
    }));
    if (!restored.body) bad('恢复后正文缺失'); else ok('恢复后正文包含离线修改');
    if (!restored.typo.includes('font-size:15px')) bad('恢复后排版缺失'); else ok('恢复后排版一并还原');
    await page.evaluate(() => window.__edSaveManual());
    const disk2 = fs.readFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), 'utf8');
    const meta2 = JSON.parse(fs.readFileSync(path.join(dataRoot, 'docs-meta.json'), 'utf8'));
    const typo2 = String((meta2[ED_DOC] || {}).typo || '');
    // 注意：模板自带编辑器脚本里有字符串 'typo-custom'（getElementById），故按 <style> 元素判定，而非裸子串
    const hasTypoStyle2 = /<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(disk2);
    if (!disk2.includes('RECOVER-EDIT')) bad('恢复正文未落盘');
    else if (hasTypoStyle2) bad('当前文档落盘不应含 typo-custom <style> 元素（排版值只存 meta）');
    else if (!typo2.includes('font-size:15px')) bad('排版未经 meta 往返落盘：' + JSON.stringify(typo2));
    else ok('恢复内容落盘：正文入 html、排版经 meta（当前文档不含 typo-custom 元素）');
    await ctx.close();
  }

  // ===== 3. 多标签：旧标签保存不能静默覆盖 =====
  {
    const ctx = await browser.newContext();
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    await a.goto(base + '/edit?id=' + ED_DOC);
    await b.goto(base + '/edit?id=' + ED_DOC);
    await a.waitForSelector('.sheet .summary');
    await b.waitForSelector('.sheet .summary');
    // A 先保存
    await a.click('.sheet .summary');
    await a.keyboard.press('End');
    await a.keyboard.type('FROM-A');
    await a.evaluate(() => window.__edSaveManual());
    await a.waitForTimeout(400);
    // B（持有旧 mtime）再保存 → 冲突条出现
    await b.click('.sheet .summary');
    await b.keyboard.press('End');
    await b.keyboard.type('FROM-B');
    await b.evaluate(() => window.__edSaveManual());
    await b.waitForSelector('.conflict-bar', { timeout: 4000 });
    ok('旧标签保存触发冲突提示');
    await Promise.all([b.waitForNavigation(), b.click('.conflict-bar button.secondary')]);  // 加载服务器版本
    const bText = await b.evaluate(() => document.querySelector('.sheet').textContent);
    if (bText.includes('FROM-B')) bad('选择服务器版本后仍显示本地内容');
    else ok('冲突后加载服务器版本正确');
    const disk3 = fs.readFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), 'utf8');
    if (!disk3.includes('FROM-A')) bad('服务器版本不是 A 的保存结果');
    else ok('未发生静默覆盖（磁盘保留先到版本）');
    await ctx.close();
  }

  // ===== 4. 审阅面板：接受修改应用到正文并持久化状态；隐藏条目可恢复 =====
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('#ed-pane-review .jp-item', { timeout: 5000 });
    const sel = await page.evaluate(() => document.querySelector('#ed-rtabs button[data-pane="review"]').getAttribute('aria-selected'));
    if (sel !== 'true') bad('岗位草稿默认未打开审阅视图'); else ok('岗位草稿默认打开修改清单');
    await page.click('#ed-pane-review .jp-item button.jp-accept');
    await page.waitForFunction(() => document.querySelector('.sheet').textContent.includes('新项目描述（定制）'), { timeout: 4000 });
    ok('接受修改应用到正文');
    await page.evaluate(() => window.__edSaveManual());
    const disk4 = fs.readFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), 'utf8');
    if (!disk4.includes('新项目描述（定制）')) bad('接受的修改未落盘');
    else ok('接受的修改落盘');
    const st = await page.evaluate(() => fetch('/job/changes?id=' + window.__edDocId).then((r) => r.json()));
    const accepted = st.job.changes.find((c) => c.id === 'bt1');
    if (!accepted || accepted.status !== 'accepted') bad('审阅状态未回写服务端'); else ok('审阅状态回写并持久化');
    // 隐藏条目（important：需逐条确认）
    await page.click('#ed-pane-review .jp-group.jp-important .jp-item button.jp-accept');
    await page.waitForTimeout(300);
    const hiddenOk = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('.sheet .entry-head'));
      const b = heads.find((h) => h.textContent.includes('项目B'));
      return !!(b && b.classList.contains('ed-entry-hidden'));
    });
    if (!hiddenOk) bad('隐藏条目未生效'); else ok('条目级隐藏生效（内容保留可恢复）');
    await page.evaluate(() => window.__edSaveManual());
    const disk5 = fs.readFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), 'utf8');
    if (!disk5.includes('ed-entry-hidden')) bad('隐藏类未落盘（PDF 将不隐藏）'); else ok('隐藏类随保存落盘');
    await page.reload();
    await page.waitForSelector('#ed-pane-review .jp-item');
    const after = await page.evaluate(() => document.querySelector('#ed-pane-review .jp-st').textContent);
    if (!/已接受/.test(after)) bad('刷新后审阅状态丢失：' + after); else ok('刷新后审阅状态保留');
    await ctx.close();
  }

  // ===== 5. 导航无障碍与交互细节 =====
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + ED_DOC);
    await page.waitForSelector('#ed-navlist .ed-nav');
    const nested = await page.evaluate(() => document.querySelectorAll('#ed-navlist button button').length);
    if (nested) bad('章节导航存在嵌套按钮：' + nested); else ok('章节导航无嵌套按钮（无障碍）');
    const entries = await page.evaluate(() => document.querySelectorAll('#ed-navlist .ed-nav-entry').length);
    if (entries < 2) bad('条目级积木未渲染：' + entries); else ok('条目级排序/隐藏入口已渲染');
    const zoom = await page.evaluate(() => document.querySelector('#ed-zval').type);
    if (zoom !== 'number') bad('缩放数值输入缺失'); else ok('缩放支持数值输入');
    await page.evaluate(() => { const z = document.getElementById('ed-zval'); z.value = '80'; z.dispatchEvent(new Event('change')); });
    const sheetZoom = await page.evaluate(() => document.querySelector('.sheet').style.zoom);
    if (sheetZoom !== '0.8') bad('缩放数值输入未生效：' + sheetZoom); else ok('缩放数值输入生效');
    // 岗位草稿入口（不依赖模型）
    const jobBtnExists = await page.evaluate(() => !!document.getElementById('ed-jobbtn') || !!document.querySelector('.ed-jobbtn'));
    if (!jobBtnExists) bad('编辑器缺岗位草稿入口'); else ok('编辑器提供岗位草稿入口');
    await page.click('.ed-jobbtn');
    await page.waitForSelector('#ed-jobpop input', { timeout: 3000 });
    const dlgFocus = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label'));
    if (dlgFocus !== '公司') bad('岗位弹层未聚焦首字段'); else ok('岗位弹层焦点管理正确');
    const modal = await page.evaluate(() => document.getElementById('ed-jobpop').getAttribute('aria-modal'));
    if (modal !== 'true') bad('岗位弹层缺 aria-modal'); else ok('岗位弹层具备模态语义');
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (failures) { console.error('❌ 浏览器级验证失败 ' + failures + ' 项'); process.exit(1); }
console.log('浏览器级验证全部通过');
