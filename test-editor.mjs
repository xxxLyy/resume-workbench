// test-editor.mjs — 浏览器级验证（playwright-core + 本机 Chromium headless shell）
// 用法: node test-editor.mjs <baseURL> <docId> <dataRoot>
// 覆盖：保存期间继续编辑不误判已保存、离线正文+排版恢复、多标签冲突、审阅面板接受与持久化、导航无障碍。
// 仅使用隔离数据根，绝不触碰真实数据。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
// 受信渲染输入（AUD-05）只剥离脚本与注释等非正文内容 → 比对正文即可确认「仍来自冻结产物」
const stripNonBody = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveChromium, invalidateCache, readCache } from './chromium.mjs';
import { updateMeta } from './tx.mjs';
import { freezeHtml } from './freeze.mjs';
import { assembleTemplate } from './template.mjs';
import { paraFingerprint, contentFingerprint } from './evidence.mjs';

const [base, docId, dataRoot] = process.argv.slice(2);
// 参数错误是调用方问题，不是环境缺失：返回 1（失败），不得落到 2（仅浏览器环境不可用）。
if (!base || !docId || !dataRoot) { console.error('用法: node test-editor.mjs <baseURL> <docId> <dataRoot>'); process.exit(1); }
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
  // 旁车 <out>.env.json 与 PDF 成对（AUD-07：发布要求两者齐备且身份一致）
  fs.writeFileSync(fr, '#!/bin/bash\nshift\nif [ "$1" = "--src" ]; then src="$2"; out="$4"; else src="$RESUME_ROOT/docs/$1.html"; out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\nprintf "%%PDF-1.4 fake\\n" > "$out"\necho \'{"renderInputId":"\'"$RESUME_RENDER_INPUT_ID"\'","reproducible":true,"dpi":150}\' > "$out.env.json"\n');
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
    if (ready) return { child, base, pid: child.pid, stderr: () => stderr };
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

    // ---------- ROOT4（beginTx 标记/载荷之间被杀）：⑦ I-1 kill -9 → 重启恢复不得误删文档 meta ----------
    const ROOT4 = path.join(TX_TMP, 'r4');
    const fr4 = seedRoot(ROOT4, { 'orphan-a': txDoc('orphan-a', 'ORPHAN-V1', '') }, { 'orphan-a': { typo: '/*OA*/body{font-size:11px}', rev: 7 } });
    const srv4 = await spawnServer(ROOT4, { RESUME_RENDER_BIN: fr4, RESUME_TEST_TX_META_GAP_MS: '4000' });
    servers.push(srv4.child);
    const B4 = srv4.base;
    const readMeta4 = () => JSON.parse(fs.readFileSync(path.join(ROOT4, 'docs-meta.json'), 'utf8'));
    const readDoc4 = () => fs.readFileSync(path.join(ROOT4, 'docs', 'orphan-a.html'), 'utf8');
    const txMarkers4 = () => fs.existsSync(path.join(ROOT4, '.tx')) ? fs.readdirSync(path.join(ROOT4, '.tx')).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')) : [];
    {
      // autosave=1 → oldSnapTs=''（不产生快照），把断言聚焦到"标记无载荷时 meta 是否被误删"
      const saveP = fetch(B4 + '/save?id=orphan-a&autosave=1', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: txDoc('orphan-a', 'ORPHAN-V2', '') })
        .then((r) => r.json().then((j) => ({ status: r.status, body: j }), () => ({ status: r.status }))).catch((e) => ({ inflight: String(e) }));
      const t0 = Date.now();
      while (!txMarkers4().length && Date.now() - t0 < 1500) await sleep(20);   // 修复前：标记先落盘即刻可见；修复后：标记最后写 → 轮询超时（仍在钩子窗口内）
      srv4.child.kill('SIGKILL');                                              // kill -9 于"标记/载荷"窗口
      const res4 = await saveP;
      const htmlMid = readDoc4();
      const srv4b = await spawnServer(ROOT4, { RESUME_RENDER_BIN: fr4 });         // 重启：recoverPending 先于 listen
      servers.push(srv4b.child);
      const htmlPost = readDoc4();
      const metaPost = readMeta4();
      const markersPost = txMarkers4();
      if (!res4 || !res4.inflight) bad('⑦ 前置失败：保存应在事务窗口内被杀（请求在途）', JSON.stringify(res4));
      else if (htmlMid.includes('ORPHAN-V2')) bad('⑦ 前置失败：rename#1 不应执行（被杀于 beginTx 内）');
      else if (htmlPost.includes('ORPHAN-V2') || !htmlPost.includes('ORPHAN-V1')) bad('⑦ 被杀于 beginTx 窗口 → 正文应原封不动', htmlPost.slice(0, 80));
      else if (!metaPost['orphan-a'] || metaPost['orphan-a'].rev !== 7 || metaPost['orphan-a'].typo !== '/*OA*/body{font-size:11px}') bad('⑦ I-1 恢复不得因"标记无载荷"删/改文档 meta', JSON.stringify(metaPost));
      else if (markersPost.length) bad('⑦ 重启后 .tx 不应残留标记', markersPost.join(','));
      else ok('⑦ I-1 kill -9 于 beginTx 标记/载荷之间 → 重启后正文与 meta 零改动、无残留标记');
    }

    // ---------- ROOT5（rename#2 与 meta 恢复双失败）：⑧ I-2 错误路径不得无条件 commitTx ----------
    const ROOT5 = path.join(TX_TMP, 'r5');
    const ERR_META = { 'err-a': { typo: '/*EA*/body{font-size:10px}', rev: 7 } };
    const fr5 = seedRoot(ROOT5, { 'err-a': txDoc('err-a', 'ERR-V1', '') }, ERR_META);
    const srv5 = await spawnServer(ROOT5, { RESUME_RENDER_BIN: fr5, RESUME_TEST_SAVE_GAP_MS: '1200' });
    servers.push(srv5.child);
    const B5 = srv5.base;
    const metaFile5 = path.join(ROOT5, 'docs-meta.json');
    const readMeta5 = () => JSON.parse(fs.readFileSync(metaFile5, 'utf8'));
    const readDoc5 = () => fs.readFileSync(path.join(ROOT5, 'docs', 'err-a.html'), 'utf8');
    const txMarkers5 = () => fs.existsSync(path.join(ROOT5, '.tx')) ? fs.readdirSync(path.join(ROOT5, '.tx')).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')) : [];
    const waitDoc5 = (needle, ms) => { const t = Date.now(); return new Promise((res) => { const iv = setInterval(() => { let h = ''; try { h = readDoc5(); } catch {} if (h.includes(needle) || Date.now() - t > ms) { clearInterval(iv); res(h.includes(needle)); } }, 15); }); };
    {
      const saveP = fetch(B5 + '/save?id=err-a', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: txDoc('err-a', 'ERR-V2', '/*EA2*/body{font-size:19px}') })
        .then((r) => r.text().then((t) => ({ status: r.status, text: t }), () => ({ status: r.status }))).catch((e) => ({ inflight: String(e) }));
      if (!await waitDoc5('ERR-V2', 6000)) bad('⑧ 前置失败：rename#1 未落盘（未命中 gap）');
      else {
        fs.writeFileSync(metaFile5, '{ "err-a": ');      // 强制 rename#2 失败：docs-meta 损坏 → updateMeta 抛 CORRUPT（停写不覆盖）
        const res5 = await saveP;
        const markers5 = txMarkers5();
        const htmlAfter = readDoc5();
        const metaRaw = fs.readFileSync(metaFile5, 'utf8');
        if (!res5 || res5.status !== 500) bad('⑧ rename#2 失败应 500', JSON.stringify(res5));
        else if (!htmlAfter.includes('ERR-V1') || htmlAfter.includes('ERR-V2')) bad('⑧ 正文应已回滚到旧版', htmlAfter.slice(0, 80));
        else if (!metaRaw.includes('{ "err-a": ')) bad('⑧ 损坏的 docs-meta 不应被覆盖写', metaRaw.slice(0, 60));
        else if (!markers5.length) bad('⑧ I-2 meta 恢复失败时不得 commitTx（记录须留给启动恢复）');
        else {
          fs.writeFileSync(metaFile5, JSON.stringify(ERR_META));   // 修好数据文件后重启 → 启动恢复应能据记录完整还原
          // 带 gap 钩子：⑧b 要在 rename#1 之后的窗口里写坏 meta（同 ⑧）；本段的启动恢复断言只读文件，不受影响
          const srv5b = await spawnServer(ROOT5, { RESUME_RENDER_BIN: fr5, RESUME_TEST_SAVE_GAP_MS: '1200' });
          servers.push(srv5b.child);
          const m5 = readMeta5();
          if (txMarkers5().length) bad('⑧ 重启后启动恢复应清理 tx 记录', txMarkers5().join(','));
          else if (!m5['err-a'] || m5['err-a'].rev !== 7 || m5['err-a'].typo !== '/*EA*/body{font-size:10px}') bad('⑧ 启动恢复应把 meta 还原到事务前', JSON.stringify(m5));
          else if (readDoc5().includes('ERR-V2')) bad('⑧ 启动恢复后正文不应含失败保存的内容');
          else ok('⑧ I-2 rename#2 + meta 恢复双失败 → 不 commitTx，记录留给启动恢复（重启后完整还原）');
          // ⑧b I-2 尾险：保留下来的记录一旦被"同文档后续成功保存"取代，就不得在下次启动把文档回滚掉
          {
            const B5b = srv5b.base;
            const save5 = (body) => fetch(B5b + '/save?id=err-a', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body })
              .then((r) => r.text().then((t) => ({ status: r.status, text: t }), () => ({ status: r.status })));
            // 再制造一次"rename#2 + meta 恢复"双失败 → 记录保留。必须在 rename#1 之后的 gap 窗口里写坏 meta（与 ⑧ 同法）：
            // beginTx 会在事务开始前校验 meta（BL-P5-04，712b8d9）——保存前就写坏只会让 beginTx 直接拒绝（500 但零记录），
            // 构造不出"双失败留记录"这个前置。
            const rfP = save5(txDoc('err-a', 'ERR-V3', ''));
            if (!await waitDoc5('ERR-V3', 6000)) bad('⑧b 前置失败：rename#1 未落盘（未命中 gap）');
            fs.writeFileSync(metaFile5, '{ "err-a": ');
            const rf = await rfP;
            const kept = txMarkers5().length;
            fs.writeFileSync(metaFile5, JSON.stringify(m5));   // 修好数据文件 → 同文档再次保存成功
            const rs = await save5(txDoc('err-a', 'ERR-V4', ''));
            const left = txMarkers5();
            const docBeforeRestart = readDoc5();
            const srv5c = await spawnServer(ROOT5, { RESUME_RENDER_BIN: fr5 });   // 重启：过期记录不得回滚本次成功保存
            servers.push(srv5c.child);
            const m5c = readMeta5();
            const f5 = failures;
            if (!rf || rf.status !== 500) bad('⑧b 前置失败：损坏 meta 下保存应 500', JSON.stringify(rf));
            if (!kept) bad('⑧b 前置失败：双失败后应保留 tx 记录');
            if (!rs || rs.status !== 200) bad('⑧b 前置失败：修复后保存应 200', JSON.stringify(rs));
            if (!docBeforeRestart.includes('ERR-V4')) bad('⑧b 前置失败：成功保存应落盘 ERR-V4');
            if (left.length) bad('⑧b I-2 同文档后续成功保存应取代旧未完成记录', left.join(','));
            if (!readDoc5().includes('ERR-V4') || readDoc5().includes('ERR-V3')) bad('⑧b I-2 重启后不得把正文回滚（旧记录已过期）', readDoc5().slice(0, 80));
            if (!m5c['err-a'] || m5c['err-a'].rev !== m5['err-a'].rev + 1) bad('⑧b I-2 重启后 meta 不应被过期记录回滚/删除', JSON.stringify(m5c));
            if (failures === f5) ok('⑧b I-2 成功保存取代同文档过期记录 → 重启不回滚后续保存');
          }
        }
      }
    }

    // ---------- ROOT6（备份/回退点 docs-meta 损坏）：⑨ I-3 不得把损坏 meta 当成 {} 全删 ----------
    const ROOT6 = path.join(TX_TMP, 'r6');
    const fr6 = seedRoot(ROOT6, { 'rs-a': txDoc('rs-a', 'RS-LOCAL', '') }, { 'rs-a': { typo: '/*RS*/body{font-size:12px}', rev: 4 } });
    const srv6 = await spawnServer(ROOT6, { RESUME_RENDER_BIN: fr6 });
    servers.push(srv6.child);
    const B6 = srv6.base;
    const readMeta6 = () => JSON.parse(fs.readFileSync(path.join(ROOT6, 'docs-meta.json'), 'utf8'));
    const readDoc6 = () => fs.readFileSync(path.join(ROOT6, 'docs', 'rs-a.html'), 'utf8');
    {
      const bakDir = path.join(TX_TMP, 'bak6');
      fs.mkdirSync(path.join(bakDir, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(bakDir, 'docs', 'rs-a.html'), txDoc('rs-a', 'RS-BACKUP', ''));
      fs.writeFileSync(path.join(bakDir, 'docs-meta.json'), '{ "rs-a": ');   // 半截 JSON：不可解析
      fs.writeFileSync(path.join(bakDir, 'applications.json'), '[]');
      fs.writeFileSync(path.join(bakDir, 'materials.json'), '[]');
      const tarFile = path.join(TX_TMP, 'bak6.tar.gz');
      const tr = spawnSync('tar', ['czf', tarFile, '-C', bakDir, 'docs', 'docs-meta.json', 'applications.json', 'materials.json'], { encoding: 'utf8' });
      if (tr.status !== 0) bad('⑨ 前置失败：构造备份包失败', String(tr.stderr).slice(0, 200));
      else {
        const bytes = fs.readFileSync(tarFile);
        const post = (u, body) => fetch(B6 + u, { method: 'POST', headers: body ? { 'Content-Type': 'application/gzip' } : {}, body, redirect: 'manual' })
          .then((r) => r.text().then((t) => ({ status: r.status, text: t }), () => ({ status: r.status }))).catch((e) => ({ inflight: String(e) }));
        const jbody = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
        const prev = await post('/restore?apply=0', bytes);
        const rep = await post('/restore?apply=1&mode=replace', bytes);
        const metaRep = readMeta6(), docRep = readDoc6();
        const mer = await post('/restore?apply=1&mode=merge', bytes);
        const metaMer = readMeta6(), docMer = readDoc6();
        // 回退点里 docs-meta.json 损坏 → 同样必须拒绝，且在任何删除动作之前
        const undoDir = path.join(ROOT6, 'backups', 'restore-1234567890', 'data');
        fs.mkdirSync(path.join(undoDir, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(undoDir, 'docs', 'rs-a.html'), txDoc('rs-a', 'RS-UNDO', ''));
        fs.writeFileSync(path.join(undoDir, 'docs-meta.json'), '{ "rs-a": ');
        const und = await post('/restore/undo?ts=restore-1234567890', '');
        const metaUnd = readMeta6(), docUnd = readDoc6();
        const f0 = failures;
        if (rep.status !== 500) bad('⑨ I-3 替换恢复应 500 拒绝（损坏 meta 不得当成 {}）', String(rep.status));
        if (!metaRep['rs-a'] || metaRep['rs-a'].rev !== 4 || metaRep['rs-a'].typo !== '/*RS*/body{font-size:12px}') bad('⑨ I-3 替换后本地 meta 被清空（损坏备份 meta 被当成 {}）', JSON.stringify(metaRep));
        if (!docRep.includes('RS-LOCAL')) bad('⑨ I-3 替换应被拒绝 → 正文不应被备份覆盖', docRep.slice(0, 80));
        if (mer.status !== 500) bad('⑨ I-3 合并恢复应 500 拒绝', String(mer.status));
        if (!metaMer['rs-a'] || metaMer['rs-a'].rev !== 4) bad('⑨ I-3 合并后本地 meta 应零改动', JSON.stringify(metaMer));
        if (!docMer.includes('RS-LOCAL')) bad('⑨ I-3 合并应被拒绝 → 正文不应改动');
        if (und.status !== 500) bad('⑨ I-3 回退应 500 拒绝', String(und.status));
        if (!metaUnd['rs-a'] || metaUnd['rs-a'].rev !== 4 || metaUnd['rs-a'].typo !== '/*RS*/body{font-size:12px}') bad('⑨ I-3 回退后本地 meta 被清空', JSON.stringify(metaUnd));
        if (!docUnd.includes('RS-LOCAL') || docUnd.includes('RS-UNDO')) bad('⑨ I-3 回退应被拒绝 → 正文不应被替换');
        const pv = jbody(prev);
        if (!pv || !pv.meta || !pv.meta.corrupt) bad('⑨ I-3 预览应标记备份 meta 损坏', JSON.stringify(pv && pv.meta));
        if (failures === f0) ok('⑨ I-3 备份/回退点 docs-meta.json 损坏 → 预览标记 + 500 拒绝，本地 meta 零删除');
      }
    }
  } finally {
    for (const c of servers) { try { c.kill('SIGKILL'); } catch {} }
    await sleep(50);
    try { fs.rmSync(TX_TMP, { recursive: true, force: true }); } catch {}
  }
}
await runTxTests();

// ===== S1 Task 4：渲染/编辑入口统一组装 + staleInfo + typo 注入（node 级；自 spawn 隔离根+隔离端口，绝不触碰 base/常驻服务）=====
async function runS1T4Tests() {
  const T4_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-t4-'));
  const md5 = (b) => createHash('md5').update(b).digest('hex');
  // 受信渲染输入（AUD-05）只剥离脚本与注释等非正文内容 → 比对正文即可确认「仍来自冻结产物」
  const stripNonBody = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const servers = [];
  try {
    const ROOT7 = path.join(T4_TMP, 'r7');
    for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(ROOT7, d), { recursive: true });
    fs.writeFileSync(path.join(ROOT7, 'docs-meta.json'), '{}');
    fs.writeFileSync(path.join(ROOT7, 'applications.json'), '[]');
    fs.writeFileSync(path.join(ROOT7, 'materials.json'), '[]');
    fs.writeFileSync(path.join(ROOT7, 'docs', 't4.html'), txDoc('t4', 'T4-SEED', ''));
    // 假渲染器：记录本次渲染输入（.last-src.html）与调用次数（.render-count），供「组装渲染/不重渲/复用」断言
    const fr7 = path.join(ROOT7, 'fake-render.sh');
    fs.writeFileSync(fr7, '#!/bin/bash\nshift\nsrc=""; out=""\nif [ "$1" = "--src" ]; then src="$2"; out="$4"; else src="$RESUME_ROOT/docs/$1.html"; out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\ncp "$src" "$RESUME_ROOT/.last-src.html"\nn=$(cat "$RESUME_ROOT/.render-count" 2>/dev/null || echo 0); echo $((n+1)) > "$RESUME_ROOT/.render-count"\nprintf "%%PDF-1.4 fake\\n" > "$out"\necho \'{"renderInputId":"\'"$RESUME_RENDER_INPUT_ID"\'","reproducible":true,"dpi":150}\' > "$out.env.json"\n');
    fs.chmodSync(fr7, 0o755);
    const srv7 = await spawnServer(ROOT7, { RESUME_RENDER_BIN: fr7 });
    servers.push(srv7.child);
    const B7 = srv7.base;
    const readMeta7 = () => JSON.parse(fs.readFileSync(path.join(ROOT7, 'docs-meta.json'), 'utf8'));
    const readDoc7 = () => fs.readFileSync(path.join(ROOT7, 'docs', 't4.html'), 'utf8');
    const renderCount = () => { try { return Number(fs.readFileSync(path.join(ROOT7, '.render-count'), 'utf8').trim()); } catch { return 0; } };
    const lastSrc = () => { try { return fs.readFileSync(path.join(ROOT7, '.last-src.html'), 'utf8'); } catch { return ''; } };
    const post = (u, body, ct) => fetch(B7 + u, { method: 'POST', headers: ct ? { 'Content-Type': ct } : {}, body, redirect: 'manual' });
    const TYPO = '/*T4A*/body{font-size:14.5px}';

    // ① 保存后刷新 GET /edit 仍显示排版：serve 前注入 meta.typo（落盘仍不含 typo-custom；无 typo 文档不注入）
    {
      const j = await (await post('/save?id=t4', txDoc('t4', 'T4-V1', TYPO), 'text/html; charset=utf-8')).json();
      const ed = await (await fetch(B7 + '/edit?id=t4')).text();
      const cnt = (ed.match(/<style id="typo-custom">/g) || []).length;
      if (!j.ok) bad('① 保存失败', JSON.stringify(j));
      else if (/<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(readDoc7())) bad('① 落盘文档不应含 typo-custom 元素');
      else if (cnt !== 1) bad('① /edit 应恰注入一个 typo-custom 块', String(cnt));
      else if (!ed.includes('<style id="typo-custom">' + TYPO + '</style>')) bad('① /edit 注入的应是 meta.typo 值');
      else if (ed.indexOf('<style id="typo-custom">') > ed.indexOf('</head>')) bad('① typo 块应注入在 </head> 前');
      else ok('① 保存后刷新 GET /edit 仍显示排版（meta.typo 注入；落盘不含 typo-custom）');
      fs.writeFileSync(path.join(ROOT7, 'docs', 't4b.html'), txDoc('t4b', 'T4B', ''));
      const ed2 = await (await fetch(B7 + '/edit?id=t4b')).text();
      if (/<style id="typo-custom">/.test(ed2)) bad('① 无 typo 的文档 /edit 不应注入 typo 块');
    }

    // ② 删除 pdfs/<id>.pdf 后 GET /pdf 触发组装渲染：渲染输入=freeze 冻结产物（md5 同、含 typo 效果），绝非磁盘 HTML 直渲；成功记 meta 标识
    {
      fs.rmSync(path.join(ROOT7, 'pdfs', 't4.pdf'), { force: true });
      const expected = freezeHtml(readDoc7(), readMeta7().t4 || {});
      const c0 = renderCount();
      const r = await fetch(B7 + '/pdf?id=t4');
      const pdfNow = fs.existsSync(path.join(ROOT7, 'pdfs', 't4.pdf'));
      const src = lastSrc();
      const m = readMeta7().t4 || {};
      if (r.status !== 200) bad('② /pdf 应 200', String(r.status));
      else if (!pdfNow) bad('② /pdf 未重渲出 PDF');
      else if (renderCount() !== c0 + 1) bad('② /pdf 应恰好触发一次组装渲染', String(renderCount() - c0));
      else if (md5(stripNonBody(src)) !== md5(stripNonBody(expected.html))) bad('② 受信渲染输入的正文应与 freeze 冻结产物一致（组装渲染）');
      else if (!src.includes('<style id="typo-custom">' + TYPO + '</style>')) bad('② 渲染输入应含 typo 效果');
      else if (src === readDoc7()) bad('② 不得直接渲染磁盘 HTML（磁盘无 typo）');
      else if (m.lastRenderInputId !== expected.renderInputId || !m.lastRenderAt) bad('② 成功渲染应记 lastRenderInputId/lastRenderAt', JSON.stringify(m));
      else if (r.headers.get('X-PDF-Stale') !== '0') bad('② 渲染后应 fresh（X-PDF-Stale=0）', String(r.headers.get('X-PDF-Stale')));
      else ok('② 删除 PDF 后 GET /pdf 走组装渲染（输入=freeze 产物含 typo；meta 记该任务标识）');
    }

    // ③ 仅 mtime 变而输入不变 → 不 stale、不重渲（/pdf 头、/export 文案、/save pdfStale、首页徽章全按渲染标识）
    {
      const f = path.join(ROOT7, 'docs', 't4.html');
      const fut = (Date.now() + 10000) / 1000;
      fs.utimesSync(f, fut, fut);
      const c0 = renderCount();
      const r = await fetch(B7 + '/pdf?id=t4');
      const ex = await (await fetch(B7 + '/export?id=t4')).text();
      const edHtml = await (await fetch(B7 + '/edit?id=t4')).text();   // 编辑器真实回传：DOM 含注入 typo + 注入块
      const sv = await (await post('/save?id=t4', edHtml, 'text/html; charset=utf-8')).json();
      const home = await (await fetch(B7 + '/')).text();
      if (renderCount() !== c0) bad('③ 仅 mtime 变不应触发重渲', String(renderCount() - c0));
      else if (r.headers.get('X-PDF-Stale') !== '0') bad('③ 仅 mtime 变不应判 stale');
      else if (!ex.includes('PDF 与当前内容一致')) bad('③ 导出页应显示 PDF 与当前内容一致');
      else if (!sv.ok || sv.pdfStale !== false) bad('③ /save 响应 pdfStale 应 false（typo 经 meta 往返，标识不变）', JSON.stringify(sv));
      else if ((readMeta7().t4 || {}).typo !== TYPO) bad('③ /edit→/save 往返后 meta.typo 应保持', JSON.stringify((readMeta7().t4 || {}).typo));
      else if (!home.includes('PDF 同步')) bad('③ 首页徽章应「PDF 同步」');
      else ok('③ 仅 mtime 变而输入不变 → 不 stale 不重渲（且 /edit→/save 往返 typo 不丢）');
    }

    // ④a 仅「复用既有不可变文件」路径校验文件哈希：/snapshot/pdf 二次请求不重渲且 md5 不变
    {
      const snaps = fs.existsSync(path.join(ROOT7, 'snapshots', 't4')) ? fs.readdirSync(path.join(ROOT7, 'snapshots', 't4')).filter((x) => x.endsWith('.html')).sort() : [];
      if (!snaps.length) bad('④ 前置失败：手动保存应产生冻结快照');
      else {
        const ts = snaps[snaps.length - 1].replace('.html', '');
        const hist = path.join(ROOT7, 'pdfs', 'history', 't4@' + ts + '.pdf');
        const c0 = renderCount();
        const r1 = await fetch(B7 + '/snapshot/pdf?id=t4&ts=' + ts);
        const h1 = fs.existsSync(hist) ? md5(fs.readFileSync(hist)) : '';
        const c1 = renderCount();
        const r2 = await fetch(B7 + '/snapshot/pdf?id=t4&ts=' + ts);
        const h2 = fs.existsSync(hist) ? md5(fs.readFileSync(hist)) : '';
        const c2 = renderCount();
        if (r1.status !== 200 || r2.status !== 200) bad('④ /snapshot/pdf 应 200', r1.status + '/' + r2.status);
        else if (c1 !== c0 + 1) bad('④ 首次历史渲染应恰好渲一次', String(c1 - c0));
        else if (c2 !== c1) bad('④ 二次请求应复用既有不可变文件（不再渲染）', String(c2 - c1));
        else if (!h1 || h1 !== h2) bad('④ 复用文件哈希应不变');
        else ok('④a 复用既有不可变文件：/snapshot/pdf 二次请求不重渲且文件 md5 不变');
      }
    }

    // ④b 重渲验收：冻结输入不变 → 两次真实渲染文本层/页数一致（不要求 PDF md5 相同；视觉门禁见 T6 像素比较）
    {
      let bin = null;
      try { bin = await resolveChromium(); } catch {}
      const hasTools = (() => { try { return spawnSync('pdftotext', ['-v']).status === 0 && spawnSync('pdfinfo', ['-v']).status === 0; } catch { return false; } })();
      if (!bin || !hasTools) {
        console.log('  ⚠️ ④b 跳过重渲验收（Chromium 或 poppler 不可用）');
      } else {
        const cache = readCache();   // 种缓存到隔离根：render.mjs 免再探针（不触碰真实根）
        if (cache) fs.writeFileSync(path.join(ROOT7, '.chromium-choice.json'), JSON.stringify(cache));
        const frozen = freezeHtml(readDoc7(), readMeta7().t4 || {});
        const srcF = path.join(T4_TMP, 'frozen.html');
        fs.writeFileSync(srcF, frozen.html);
        const doRender = (out) => spawnSync(process.execPath, [path.join(APP_ROOT, 'render.mjs'), '--src', srcF, '--out', out], {
          env: { ...process.env, RESUME_ROOT: ROOT7, RESUME_RENDER_INPUT_ID: frozen.renderInputId, RESUME_RENDER_REPRODUCIBLE: frozen.reproducible ? '1' : '0' },
          encoding: 'utf8', timeout: 180000
        });
        const o1 = path.join(T4_TMP, 'a.pdf'), o2 = path.join(T4_TMP, 'b.pdf');
        const g1 = doRender(o1), g2 = doRender(o2);
        const text = (f) => { try { return spawnSync('pdftotext', [f, '-'], { encoding: 'utf8', timeout: 30000 }).stdout || ''; } catch { return ''; } };
        const pages = (f) => { try { return (spawnSync('pdfinfo', [f], { encoding: 'utf8', timeout: 30000 }).stdout.match(/Pages:\s*(\d+)/) || [])[1] || ''; } catch { return ''; } };
        if (g1.status !== 0 || g2.status !== 0) bad('④b 真实渲染失败', String(g1.stderr || g2.stderr || '').slice(0, 300));
        else {
          const t1 = text(o1), t2 = text(o2);
          let side = null;
          try { side = JSON.parse(fs.readFileSync(o1 + '.env.json', 'utf8')); } catch {}
          if (!t1.trim() || !t1.includes('T4-V1')) bad('④b 文本层应含正文 T4-V1', t1.slice(0, 120));
          else if (t1 !== t2) bad('④b 冻结输入不变 → 两次渲染文本层应一致');
          else if (!pages(o1) || pages(o1) !== pages(o2)) bad('④b 冻结输入不变 → 两次渲染页数应一致', pages(o1) + '/' + pages(o2));
          else if (!side || side.renderInputId !== frozen.renderInputId || side.dpi !== 150 || side.reproducible !== true) bad('④b 旁车应记该任务标识/dpi=150/reproducible', JSON.stringify(side));
          else ok('④b 重渲验收：冻结输入不变 → 文本/页数一致 + 旁车标识透传（不断言 PDF md5 相同）');
        }
      }
    }
  } finally {
    for (const c of servers) { try { c.kill('SIGKILL'); } catch {} }
    await sleep(50);
    try { fs.rmSync(T4_TMP, { recursive: true, force: true }); } catch {}
  }
}
await runS1T4Tests();

// ===== S1 热修：legacy 内联排版优先于空 meta（serve/save 往返；自 spawn 隔离根+隔离端口，绝不触碰真实数据）=====
async function runS1HotfixTests() {
  const HF_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-hf-'));
  const md5 = (b) => createHash('md5').update(b).digest('hex');
  // 受信渲染输入（AUD-05）只剥离脚本与注释等非正文内容 → 比对正文即可确认「仍来自冻结产物」
  const stripNonBody = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const servers = [];
  try {
    const ROOT8 = path.join(HF_TMP, 'r8');
    for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(ROOT8, d), { recursive: true });
    const LEG_TYPO = '/*LEG*/body{font-size:14.5px}';
    const MIG_TYPO = '/*MIG*/body{font-size:17px}';
    fs.writeFileSync(path.join(ROOT8, 'docs-meta.json'), JSON.stringify({
      leg: { rev: 3 },                  // legacy：meta 无 typo 键（S1 迁移前状态）
      mig: { typo: MIG_TYPO, rev: 2 },  // 已迁移：meta.typo 非空
      mig0: { typo: '', rev: 1 }        // 已迁移：meta.typo=''（无微调）
    }));
    fs.writeFileSync(path.join(ROOT8, 'applications.json'), '[]');
    fs.writeFileSync(path.join(ROOT8, 'materials.json'), '[]');
    fs.writeFileSync(path.join(ROOT8, 'docs', 'leg.html'), txDoc('leg', 'LEG-V1', LEG_TYPO));
    fs.writeFileSync(path.join(ROOT8, 'docs', 'mig.html'), txDoc('mig', 'MIG-V1', ''));
    fs.writeFileSync(path.join(ROOT8, 'docs', 'mig0.html'), txDoc('mig0', 'MIG0-V1', ''));
    // 假渲染器：记录渲染输入（.last-src.html），供「冻结产物含内联 typo / 冻结 --src 不读 meta」断言
    const fr8 = path.join(ROOT8, 'fake-render.sh');
    fs.writeFileSync(fr8, '#!/bin/bash\nshift\nsrc=""; out=""\nif [ "$1" = "--src" ]; then src="$2"; out="$4"; else src="$RESUME_ROOT/docs/$1.html"; out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\ncp "$src" "$RESUME_ROOT/.last-src.html"\nprintf "%%PDF-1.4 fake\\n" > "$out"\necho \'{"renderInputId":"\'"$RESUME_RENDER_INPUT_ID"\'","reproducible":true,"dpi":150}\' > "$out.env.json"\n');
    fs.chmodSync(fr8, 0o755);
    const srv8 = await spawnServer(ROOT8, { RESUME_RENDER_BIN: fr8 });
    servers.push(srv8.child);
    const B8 = srv8.base;
    const readMeta8 = () => JSON.parse(fs.readFileSync(path.join(ROOT8, 'docs-meta.json'), 'utf8'));
    const readDoc8 = (id) => fs.readFileSync(path.join(ROOT8, 'docs', id + '.html'), 'utf8');
    const lastSrc = () => { try { return fs.readFileSync(path.join(ROOT8, '.last-src.html'), 'utf8'); } catch { return ''; } };
    const post = (u, body, ct) => fetch(B8 + u, { method: 'POST', headers: ct ? { 'Content-Type': ct } : {}, body, redirect: 'manual' });
    const blocks = (h) => (h.match(/<style id="typo-custom">/g) || []).length;

    // ① legacy：GET /edit 保留文档内联 typo 块（不被空 meta 剥掉）
    {
      const ed = await (await fetch(B8 + '/edit?id=leg')).text();
      if (blocks(ed) !== 1) bad('HF① legacy /edit 应恰含一个内联 typo-custom 块', String(blocks(ed)));
      else if (!ed.includes('<style id="typo-custom">' + LEG_TYPO + '</style>')) bad('HF① legacy /edit 应保留内联值');
      else ok('HF① legacy（meta 无 typo）GET /edit 保留内联排版块');
    }
    // ② legacy：renderCurrent（/render）冻结产物含内联 typo（渲染输入 = freezeHtml 产物，排版不丢）
    {
      const r = await (await post('/render?id=leg', '')).json();
      const expected = freezeHtml(readDoc8('leg'), readMeta8().leg || {});
      if (!r.ok) bad('HF② /render 应成功', JSON.stringify(r));
      else if (!expected.html.includes('<style id="typo-custom">' + LEG_TYPO + '</style>')) bad('HF② freezeHtml(legacy) 应保留内联 typo');
      else if (!lastSrc().includes('<style id="typo-custom">' + LEG_TYPO + '</style>')) bad('HF② 渲染输入应含内联 typo（legacy 排版不丢）');
      else if (md5(stripNonBody(lastSrc())) !== md5(stripNonBody(expected.html))) bad('HF② 受信渲染输入的正文应与 freezeHtml 冻结产物一致');
      else ok('HF② legacy renderCurrent：冻结产物含内联排版（渲染输入 = freeze 产物）');
    }
    // ③ legacy：首次 /save 把内联值抽入 meta（typo 变为已定义），落盘不再含内联；此后 /edit 与冻结都走 meta
    {
      const ed = await (await fetch(B8 + '/edit?id=leg')).text();   // 编辑器真实往返：serve 什么就 POST 什么
      const sv = await (await post('/save?id=leg', ed, 'text/html; charset=utf-8')).json();
      const m = readMeta8().leg || {};
      const disk = readDoc8('leg');
      if (!sv.ok) bad('HF③ 保存失败', JSON.stringify(sv));
      else if (m.typo !== LEG_TYPO) bad('HF③ 保存后 meta.typo 应=原内联值（单文档迁移完成）', JSON.stringify(m.typo));
      else if (/<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(disk)) bad('HF③ 落盘文档不应再含 typo-custom 元素');
      else {
        const ed2 = await (await fetch(B8 + '/edit?id=leg')).text();
        const r2 = await (await post('/render?id=leg', '')).json();
        const expected2 = freezeHtml(disk, m);
        if (blocks(ed2) !== 1 || !ed2.includes('<style id="typo-custom">' + LEG_TYPO + '</style>')) bad('HF③ 迁移后 /edit 应注入 meta.typo', String(blocks(ed2)));
        else if (!r2.ok || md5(stripNonBody(lastSrc())) !== md5(stripNonBody(expected2.html)) || !lastSrc().includes(LEG_TYPO)) bad('HF③ 二次冻结应使用 meta（渲染输入 = freeze 产物）');
        else ok('HF③ legacy 首次 /save 内联入 meta（迁移完成）；此后 /edit 与冻结走 meta');
      }
    }
    // ④ 已迁移文档：行为不变 —— meta.typo 非空必胜；meta.typo='' 不产生块
    {
      const edMig = await (await fetch(B8 + '/edit?id=mig')).text();
      const edMig0 = await (await fetch(B8 + '/edit?id=mig0')).text();
      const frzMig = freezeHtml(readDoc8('mig'), readMeta8().mig || {});
      if (blocks(edMig) !== 1 || !edMig.includes('<style id="typo-custom">' + MIG_TYPO + '</style>')) bad('HF④ 已迁移 /edit 应注入 meta.typo');
      else if (blocks(edMig0) !== 0) bad("HF④ meta.typo='' 的 /edit 不应注入块", String(blocks(edMig0)));
      else if (!frzMig.html.includes('<style id="typo-custom">' + MIG_TYPO + '</style>')) bad('HF④ 已迁移冻结应注入 meta.typo');
      else ok("HF④ 已迁移文档行为不变（meta 必胜；typo='' 不产生块）");
    }
    // ⑤ 铁律二回归护栏：冻结文件（--src）按其内联 typo 渲染，无视任何 meta
    {
      const snapDir8 = path.join(ROOT8, 'snapshots', 'frz');
      fs.mkdirSync(snapDir8, { recursive: true });
      fs.writeFileSync(path.join(ROOT8, 'docs', 'frz.html'), txDoc('frz', 'FRZ-V1', ''));
      const FROZEN_TYPO = '/*FROZEN*/body{font-size:13px}';
      const frozenHtml = '<!doctype html>\n<html><head><style id="typo-custom">' + FROZEN_TYPO + '</style></head>\n<body><p>FRZ-SNAP</p></body></html>\n';
      const ts = '2026-09-24-000000-000';
      fs.writeFileSync(path.join(snapDir8, ts + '.html'), frozenHtml);
      // 故意给 meta 一个不同的 typo 值：冻结 --src 渲染不得读它（render.mjs meta-blind）
      fs.writeFileSync(path.join(ROOT8, 'docs-meta.json'), JSON.stringify({ ...readMeta8(), frz: { typo: '/*META-WRONG*/body{font-size:99px}' } }));
      const r = await fetch(B8 + '/snapshot/pdf?id=frz&ts=' + ts);
      if (r.status !== 200) bad('HF⑤ /snapshot/pdf 应 200', String(r.status));
      else if (lastSrc() !== frozenHtml) bad('HF⑤ 冻结 --src 渲染输入应为冻结文件原字节');
      else if (!lastSrc().includes(FROZEN_TYPO) || lastSrc().includes('META-WRONG')) bad('HF⑤ 冻结渲染应用冻结内联排版、不得混入 meta');
      else ok('HF⑤ 铁律二：冻结 --src 按其内联排版渲染并无视 meta');
    }
  } finally {
    for (const c of servers) { try { c.kill('SIGKILL'); } catch {} }
    await sleep(50);
    try { fs.rmSync(HF_TMP, { recursive: true, force: true }); } catch {}
  }
}
await runS1HotfixTests();

// ===== S1 Task 7：迁移后 /edit 走 meta + 手工态守卫 + 已迁移文档回滚/复制（node 级；隔离根+隔离端口；迁移注入模拟检查器，真实门禁在 test-structure S1-E-2）=====
async function runS1T7Tests() {
  const T7_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-t7-'));
  const servers = [];
  try {
    const { runMigration } = await import('./migrate-meta.mjs');
    const { beginTx } = await import('./tx.mjs');
    const ROOT9 = path.join(T7_TMP, 'r9');
    const LEG = '/*T7LEG*/body{font-size:14.5px}';
    const HAND = '/*T7HAND*/body{font-size:13px}';
    const fr9 = seedRoot(ROOT9, {
      leg7: txDoc('leg7', 'LEG7-V1', LEG),      // legacy：meta 无 typo 键（迁移前形态）
      hand7: txDoc('hand7', 'HAND7-V1', HAND)   // 手工态：meta.typo='' 且内联存在（/edit 与 freezeHtml 分歧点）
    }, { leg7: { rev: 2 }, hand7: { typo: '', rev: 1 } });
    const srv9 = await spawnServer(ROOT9, { RESUME_RENDER_BIN: fr9 });
    servers.push(srv9.child);
    const B9 = srv9.base;
    const readMeta9 = () => JSON.parse(fs.readFileSync(path.join(ROOT9, 'docs-meta.json'), 'utf8'));
    const readDoc9 = (id) => fs.readFileSync(path.join(ROOT9, 'docs', id + '.html'), 'utf8');
    const blocks = (h) => (h.match(/<style id="typo-custom">/g) || []).length;
    const post = (u, body, ct) => fetch(B9 + u, { method: 'POST', headers: ct ? { 'Content-Type': ct } : {}, body, redirect: 'manual' });
    const markers9 = () => fs.existsSync(path.join(ROOT9, '.tx'))
      ? fs.readdirSync(path.join(ROOT9, '.tx')).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT9, '.tx', f), 'utf8')).docId; } catch { return null; } }).filter(Boolean)
      : [];

    // ① 手工态守卫（meta.typo='' 且内联存在）：/edit 回退内联 —— 与 freezeHtml 同款裁决，WYSIWYG 不再分裂
    {
      const ed = await (await fetch(B9 + '/edit?id=hand7')).text();
      if (blocks(ed) !== 1 || !ed.includes('<style id="typo-custom">' + HAND + '</style>')) bad('T7① meta.typo=空+内联存在时 /edit 应回退内联（恰一块）', String(blocks(ed)));
      else ok('T7① /edit 在 meta.typo=空+内联存在时回退内联（与 freezeHtml 同款，WYSIWYG 不分裂）');
    }
    // ② 迁移（注入模拟检查器；真实门禁见 test-structure S1-E-2）→ 迁移后 /edit 排版来自 meta
    {
      const mockCheckers = {
        renderPdf: async (src, out) => { fs.writeFileSync(out, '%PDF-1.4 mock\n'); return true; },
        pdftotext: () => 'T7-TEXT', pdfinfoPages: () => 1,
        comparePdfs: () => ({ pass: true, max: 0, pages: [], dpi: 150, threshold: 0.005, pixFmt: 'rgb24' })
      };
      const rep9 = await runMigration(ROOT9, { checkers: mockCheckers });
      if (!rep9.ok) bad('T7② 迁移应成功', JSON.stringify(rep9.stopped));
      const m = readMeta9();
      const edLeg = await (await fetch(B9 + '/edit?id=leg7')).text();
      const edHand = await (await fetch(B9 + '/edit?id=hand7')).text();
      if ((m.leg7 || {}).schemaVersion !== 2 || (m.leg7 || {}).typo !== LEG) bad('T7② 迁移后 meta 应登记 typo=原内联值 + schemaVersion=2', JSON.stringify(m.leg7));
      else if (/<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(readDoc9('leg7'))) bad('T7② 迁移后落盘不应含 typo-custom 元素');
      else if (blocks(edLeg) !== 1 || !edLeg.includes('<style id="typo-custom">' + LEG + '</style>')) bad('T7② 迁移后 /edit 应注入来自 meta 的排版', String(blocks(edLeg)));
      else if ((m.hand7 || {}).typo !== HAND) bad('T7② 手工态迁移应把内联提取入 meta', JSON.stringify(m.hand7));
      else if (blocks(edHand) !== 1 || !edHand.includes(HAND)) bad('T7② 手工态迁移后 /edit 仍应显示排版');
      else ok('T7② 迁移后 /edit 显示来自 meta 的排版（legacy 与手工态都落 meta）');
    }
    // ③ 已迁移文档回滚：恢复冻结 html（归一化）并正确重推 meta（typo=冻结内联值；schemaVersion 保持）；残留同文档 tx 被取代清理
    {
      await (await post('/save?id=leg7', txDoc('leg7', 'LEG7-V2', '/*T7B*/body{font-size:16px}'), 'text/html; charset=utf-8')).json();   // 快照冻结 LEG7-V1+LEG
      const snaps = fs.readdirSync(path.join(ROOT9, 'snapshots', 'leg7')).filter((f) => f.endsWith('.html')).sort();
      if (!snaps.length) bad('T7③ 前置失败：保存应产生冻结快照');
      else {
        const ts = snaps[snaps.length - 1].replace('.html', '');
        const revBefore = readMeta9().leg7.rev;
        beginTx(ROOT9, 'leg7', 'save', '');   // 残留同文档未完成记录（模拟失败保存保留）：回滚成功后应被取代清理
        await post('/rollback?id=leg7&ts=' + ts, '');
        const htmlRb = readDoc9('leg7');
        const mRb = readMeta9().leg7;
        if (htmlRb.includes('LEG7-V2') || !htmlRb.includes('LEG7-V1')) bad('T7③ 回滚应恢复冻结正文 LEG7-V1', htmlRb.slice(0, 100));
        else if (/<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(htmlRb)) bad('T7③ 回滚应归一化（html 不含 typo-custom 元素）');
        else if (mRb.typo !== LEG) bad('T7③ meta.typo 应=冻结内联值（从冻结 html 重推）', JSON.stringify(mRb.typo));
        else if (!(mRb.rev > revBefore)) bad('T7③ rev 应递增');
        else if (mRb.schemaVersion !== 2) bad('T7③ 回滚不应改 schemaVersion=2（完成判据只由迁移事务写）', JSON.stringify(mRb.schemaVersion));
        else if (!mRb.styleHash) bad('T7③ styleHash 应登记');
        else if (markers9().includes('leg7')) bad('T7③ 回滚成功后同文档残留 tx 记录应被取代清理', markers9().join(','));
        else ok('T7③ 已迁移文档回滚：冻结 html 归一化恢复、meta 正确重推（typo=冻结值、schemaVersion 保持）、残留 tx 清理');
      }
    }
    // ④ /duplicate：副本继承已迁移 meta；目标文档被取代的残留 tx 记录清理（复制不经 beginTx 直接落文档）
    {
      beginTx(ROOT9, 'leg7-dup', 'save', '');   // 目标 id 的历史残留记录：不清理会在下次启动把副本回滚掉
      await post('/duplicate?id=leg7&to=leg7-dup', '');
      const dupMeta = readMeta9()['leg7-dup'];
      if (!dupMeta || dupMeta.typo !== LEG) bad('T7④ 副本应继承 typo', JSON.stringify(dupMeta));
      else if (/<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(readDoc9('leg7-dup'))) bad('T7④ 副本 html 不应含 typo-custom');
      else if (markers9().includes('leg7-dup')) bad('T7④ 复制成功后目标文档残留 tx 记录应被清理', markers9().join(','));
      else ok('T7④ /duplicate 继承已迁移 meta 且清理目标文档被取代 tx 记录');
    }
    // ⑤ 迁移互斥代码化（I-3）：他人持 .migrate.lock 期间，会 renderCurrent→updateMeta 并覆写 pdfs/ 的 GET /pdf、/export
    //    同样 503（浏览器标签页不得与迁移三门禁并发写 meta / 抢 Chromium）；纯读 GET 不受影响；释放后恢复。
    {
      const lockFile = path.join(ROOT9, '.migrate.lock');
      const pdf9 = path.join(ROOT9, 'pdfs', 'hand7.pdf');
      fs.rmSync(pdf9, { force: true });
      const ridBefore = (readMeta9()['hand7'] || {}).lastRenderInputId || null;
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }));  // 外部鲜活 pid（模拟迁移进程持锁）
      const cPdf = (await fetch(B9 + '/pdf?id=hand7')).status;
      const cExp = (await fetch(B9 + '/export?id=hand7')).status;
      const cEdit = (await fetch(B9 + '/edit?id=hand7')).status;   // 纯读路径（不 renderCurrent/不 updateMeta）不得被阻断
      const wroteDuringLock = fs.existsSync(pdf9) || ((readMeta9()['hand7'] || {}).lastRenderInputId || null) !== ridBefore;
      fs.rmSync(lockFile, { force: true });
      const cAfter = (await fetch(B9 + '/pdf?id=hand7')).status;
      const wroteAfter = fs.existsSync(pdf9) && !!(readMeta9()['hand7'] || {}).lastRenderInputId;
      if (cPdf !== 503) bad('T7⑤ 他人持锁时 GET /pdf 应 503（它会写 meta 并覆写 PDF）', String(cPdf));
      else if (cExp !== 503) bad('T7⑤ 他人持锁时 GET /export 应 503', String(cExp));
      else if (wroteDuringLock) bad('T7⑤ 持锁期间不得写 meta/PDF（与迁移门禁并发会写脏）');
      else if (cEdit !== 200) bad('T7⑤ 纯读 GET /edit 不应被锁阻断', String(cEdit));
      else if (cAfter !== 200 || !wroteAfter) bad('T7⑤ 释放锁后 /pdf 应恢复渲染并回写标识', cAfter + '/' + wroteAfter + ' | 服务端日志：' + (srv9 && srv9.stderr ? srv9.stderr().slice(-1500) : ''));
      else ok('T7⑤ 迁移互斥代码化：他人持锁时 GET /pdf、/export 503 且零写；纯读 /edit 200；释放后恢复渲染');
    }
  } finally {
    for (const c of servers) { try { c.kill('SIGKILL'); } catch {} }
    await sleep(50);
    try { fs.rmSync(T7_TMP, { recursive: true, force: true }); } catch {}
  }
}
await runS1T7Tests();

// ===== S1 Task 8：导出不可变/并发幂等/失败恢复 + 投递绑定 exportId + 导出页按钮契约 + archived 默认隐藏（node 级；隔离根+隔离端口）=====
async function runS1T8Tests() {
  const T8_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-t8-'));
  const md5 = (b) => createHash('md5').update(b).digest('hex');
  // 受信渲染输入（AUD-05）只剥离脚本与注释等非正文内容 → 比对正文即可确认「仍来自冻结产物」
  const stripNonBody = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const md5File = (f) => md5(fs.readFileSync(f));
  const servers = [];
  try {
    const ROOT10 = path.join(T8_TMP, 'r10');
    const fr10 = seedRoot(ROOT10, { t8: txDoc('t8', 'T8-V1', ''), t8b: txDoc('t8b', 'T8B-V1', ''), t8c: txDoc('t8c', 'T8C-V1', '') }, {});
    // 假渲染器：失败开关（render-fail 控制文件）+ 原子落盘（tmp+mv，并发下无半截产物）+ .last-src.html 记录渲染输入
    //   + <out>.env.json 旁车（renderInputId 透传，与真实 render.mjs 同契约）
    //   + poison-shared 开关：共享便利文件（pdfs/<id>.pdf）落毒字节——模拟并发渲染器在渲染与物化之间原子替换共享文件（T8⑦A）
    //   + bad-sidecar 开关：旁车 renderInputId 伪造为不匹配值——服务端应拒绝物化 → 500 零痕迹（T8⑦B）
    fs.writeFileSync(fr10, '#!/bin/bash\nshift\n[ -f "$RESUME_ROOT/render-fail" ] && exit 1\nsrc=""; out=""\nif [ "$1" = "--src" ]; then src="$2"; out="$4"; else src="$RESUME_ROOT/docs/$1.html"; out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\ncp "$src" "$RESUME_ROOT/.last-src.html"\ntmp="$out.$$.tmp"\nprintf "%%PDF-1.4 fake\\n" > "$tmp"\nif [ -f "$RESUME_ROOT/poison-shared" ] && [ "$(dirname "$out")" = "$RESUME_ROOT/pdfs" ]; then printf "POISON-shared\\n" > "$tmp"; fi\nmv "$tmp" "$out"\nrid="$RESUME_RENDER_INPUT_ID"\nif [ -f "$RESUME_ROOT/bad-sidecar" ]; then rid="ffffffffffffffffffffffffffffffffffffffff"; fi\necho \'{"renderInputId":"\'"$rid"\'","reproducible":true,"dpi":150}\' > "$out.env.json"\n');
    fs.chmodSync(fr10, 0o755);
    const REC_FAIL = path.join(ROOT10, '.record-fail');
    const srv10 = await spawnServer(ROOT10, { RESUME_RENDER_BIN: fr10, RESUME_TEST_EXPORT_RECORD_FAIL_FILE: REC_FAIL });
    servers.push(srv10.child);
    const B10 = srv10.base;
    const readMeta10 = () => JSON.parse(fs.readFileSync(path.join(ROOT10, 'docs-meta.json'), 'utf8'));
    const histDir = path.join(ROOT10, 'pdfs', 'history');
    const histFiles = (docId) => fs.existsSync(histDir) ? fs.readdirSync(histDir).filter((f) => f.startsWith(docId + '@') && f.endsWith('.pdf')) : [];
    const histAll = () => fs.existsSync(histDir) ? fs.readdirSync(histDir) : [];
    const post = (u, body, ct) => fetch(B10 + u, { method: 'POST', headers: ct ? { 'Content-Type': ct } : {}, body, redirect: 'manual' });
    const postJ = (u, body, ct) => post(u, body, ct).then((r) => r.json().then((j) => ({ status: r.status, body: j }), () => ({ status: r.status, body: null })));
    const postExport = (docId) => fetch(B10 + '/export?id=' + docId, { method: 'POST' })
      .then((r) => r.json().then((j) => ({ status: r.status, body: j }), () => ({ status: r.status, body: null })));

    // ① 并发双 POST /export（Promise.all）→ 仅 1 条 exports 记录 + 仅 1 个 history 不可变文件（同一 exportId；完整 40hex 命名）
    let e1 = null;
    {
      const [ra, rb] = await Promise.all([postExport('t8'), postExport('t8')]);
      const m = readMeta10();
      const ex = (m.t8 || {}).exports || [];
      const files = histFiles('t8');
      if (!ra.body || !ra.body.ok || !rb.body || !rb.body.ok) bad('T8① 并发 POST /export 应都成功', JSON.stringify([ra, rb]).slice(0, 300) + ' | 服务端日志：' + (srv10.stderr ? srv10.stderr().slice(-1200) : ''));
      else if (!ra.body.exportId || !String(ra.body.url || '').includes('/history-pdf?exportId=')) bad('T8① 响应应含 exportId + /history-pdf 下载 URL', JSON.stringify(ra.body));
      else if (ex.length !== 1) bad('T8① 并发双 POST 应仅 1 条 exports 记录（幂等键 renderInputId）', String(ex.length));
      else if (files.length !== 1) bad('T8① 应仅 1 个 history 不可变文件', files.join(','));
      else if (ra.body.exportId !== rb.body.exportId || ex[0].exportId !== ra.body.exportId) bad('T8① 并发两响应应为同一 exportId', ra.body.exportId + '/' + rb.body.exportId);
      else if (!/^t8@[0-9a-f]{40}\.pdf$/.test(files[0])) bad('T8① 产物命名应为 <id>@<完整 renderInputId>.pdf（40hex 不截断）', files[0]);
      else if (histAll().some((f) => f.endsWith('.tmp'))) bad('T8① 不应残留 .tmp 中间文件', histAll().join(','));
      else {
        e1 = ex[0];
        const frozenExpected = freezeHtml(fs.readFileSync(path.join(ROOT10, 'docs', 't8.html'), 'utf8'), m.t8 || {});
        const miss = ['exportId', 'snapTs', 'renderInputId', 'file', 'at', 'jobId', 'bodyHash', 'pages', 'theme'].filter((k) => !(k in e1));
        if (miss.length) bad('T8① exports 条目缺字段', miss.join(','));
        else if (e1.renderInputId !== frozenExpected.renderInputId) bad('T8① renderInputId 应为当前冻结标识', e1.renderInputId);
        else if (!/^[0-9a-f]{40}$/.test(String(e1.bodyHash))) bad('T8① bodyHash 应为完整 40hex', String(e1.bodyHash));
        else if (!fs.existsSync(path.join(ROOT10, 'snapshots', 't8', e1.snapTs + '.html')) || !fs.existsSync(path.join(ROOT10, 'snapshots', 't8', e1.snapTs + '.manifest.json'))) bad('T8① snapTs 应引用冻结快照 html + manifest', e1.snapTs);
        else if (e1.jobId !== null) bad('T8① 母版导出 jobId 应为 null', JSON.stringify(e1.jobId));
        else {
          const dl = await fetch(B10 + '/history-pdf?exportId=' + encodeURIComponent(e1.exportId));
          const dl404 = await fetch(B10 + '/history-pdf?exportId=no-such-id');
          if (dl.status !== 200 || dl.headers.get('content-type') !== 'application/pdf') bad('T8① /history-pdf 应按 exportId 伺服不可变文件', String(dl.status));
          else if (dl404.status !== 404) bad('T8① 未知 exportId 应 404', String(dl404.status));
          else ok('T8① 并发双 POST /export → 1 条 exports 记录 + 1 个 history 文件（同一 exportId；/history-pdf 可伺服）');
        }
      }
    }

    // ② 记录写入失败钩子 → 500 且文件已生成、无记录；重试复用文件并补记录（文件哈希不变、不产生重复文件）
    {
      fs.writeFileSync(REC_FAIL, '1');
      const r1 = await postExport('t8b');
      const filesMid = histFiles('t8b');
      const exMid = (readMeta10().t8b || {}).exports || [];
      const md5Mid = filesMid.length === 1 ? md5File(path.join(histDir, filesMid[0])) : '';
      fs.rmSync(REC_FAIL, { force: true });
      const r2 = await postExport('t8b');
      const ex = (readMeta10().t8b || {}).exports || [];
      const files = histFiles('t8b');
      if (r1.status !== 500) bad('T8② 记录写入失败钩子下 POST /export 应 500', String(r1.status));
      else if (filesMid.length !== 1) bad('T8② 记录写入失败时不可变文件应已生成（待重试复用）', filesMid.join(','));
      else if (exMid.length) bad('T8② 记录写入失败不得留下 exports 记录', String(exMid.length));
      else if (!r2.body || !r2.body.ok) bad('T8② 重试应成功', JSON.stringify(r2));
      else if (ex.length !== 1) bad('T8② 重试后应恰 1 条记录（补齐缺失记录）', String(ex.length));
      else if (files.length !== 1 || files[0] !== filesMid[0]) bad('T8② 重试应复用同一不可变文件（不重复生成）', files.join(','));
      else if (md5File(path.join(histDir, files[0])) !== md5Mid) bad('T8② 复用文件哈希应不变');
      else if (ex[0].exportId !== r2.body.exportId) bad('T8② 响应 exportId 应与补齐记录一致');
      else ok('T8② 记录写入失败 → 重试复用文件并补记录（文件哈希不变、无重复文件、无丢失记录）');
    }

    // ③ 渲染失败 → 不记 exports（无记录、无 history 产物、无冻结快照痕迹）
    {
      fs.writeFileSync(path.join(ROOT10, 'render-fail'), '1');
      const r = await postExport('t8c');
      fs.rmSync(path.join(ROOT10, 'render-fail'), { force: true });
      const ex = (readMeta10().t8c || {}).exports || [];
      if (r.status !== 500 || (r.body && r.body.ok)) bad('T8③ 渲染失败应 500 且不报成功', JSON.stringify(r).slice(0, 200));
      else if (ex.length) bad('T8③ 渲染失败不得记 exports', String(ex.length));
      else if (histFiles('t8c').length) bad('T8③ 渲染失败不得留下 history 产物');
      else if (fs.existsSync(path.join(ROOT10, 'snapshots', 't8c'))) bad('T8③ 渲染失败不得留下冻结快照');
      else ok('T8③ 渲染失败 → 不记 exports（零痕迹）');
    }

    // ④ 投递绑定 exportId：存档 PDF 来自该导出的冻结快照；之后改正文 → 存档/快照/不可变产物全部不变（不重冻）
    {
      if (!e1) bad('T8④ 前置失败：① 未产出导出记录');
      else {
        const snapFile = path.join(ROOT10, 'snapshots', 't8', e1.snapTs + '.html');
        const histFile = path.join(histDir, histFiles('t8')[0]);
        const snapCountBefore = fs.readdirSync(path.join(ROOT10, 'snapshots', 't8')).filter((f) => f.endsWith('.html')).length;
        const addRes0 = await postJ('/app/add', JSON.stringify({ company: '绑定公司', role: '绑定岗', docId: 't8', exportId: e1.exportId }), 'application/json');
        const addRes = addRes0.body;
        const apps = addRes && addRes.ok ? JSON.parse(fs.readFileSync(path.join(ROOT10, 'applications.json'), 'utf8')) : [];
        const app = apps.find((a) => a.company === '绑定公司');
        const archFile = app ? path.join(ROOT10, 'pdfs', 'archive', app.id + '.pdf') : '';
        const snapCountAfter = fs.readdirSync(path.join(ROOT10, 'snapshots', 't8')).filter((f) => f.endsWith('.html')).length;
        const archSrc = fs.existsSync(path.join(ROOT10, '.last-src.html')) ? fs.readFileSync(path.join(ROOT10, '.last-src.html'), 'utf8') : '';
        const archMd5Before = archFile && fs.existsSync(archFile) ? md5File(archFile) : '';
        const snapMd5Before = md5File(snapFile);
        const histMd5Before = md5File(histFile);
        await post('/save?id=t8', txDoc('t8', 'T8-V2-EDIT', ''), 'text/html; charset=utf-8');   // 之后改正文（新身份）
        const m = readMeta10();
        const r404 = await postJ('/app/add', JSON.stringify({ company: '幽灵公司', role: 'x', docId: 't8', exportId: 'no-such-export' }), 'application/json');
        const appsAfter = JSON.parse(fs.readFileSync(path.join(ROOT10, 'applications.json'), 'utf8'));
        const f0 = failures;
        if (!addRes || !addRes.ok) bad('T8④ 带 exportId 的投递记录应成功', JSON.stringify(addRes));
        if (!app || app.exportId !== e1.exportId) bad('T8④ applications 条目应保存所选 exportId', JSON.stringify(app && app.exportId));
        if (!app || app.snapTs !== e1.snapTs) bad('T8④ 投递应绑定导出的冻结快照（snapTs 一致，不新冻）', JSON.stringify(app && app.snapTs));
        if (snapCountAfter !== snapCountBefore) bad('T8④ 绑定 exportId 不得再新冻快照', snapCountBefore + '→' + snapCountAfter);
        if (!archMd5Before) bad('T8④ 存档 PDF 应从冻结快照生成');
        else if (stripNonBody(archSrc) !== stripNonBody(fs.readFileSync(snapFile, 'utf8'))) bad('T8④ 存档渲染输入的正文应为该导出的冻结快照字节');
        if ((m.t8.exports || []).length !== 1) bad('T8④ 改正文/投递不得新增 exports 记录', String((m.t8.exports || []).length));
        if (archMd5Before && md5File(archFile) !== archMd5Before) bad('T8④ 改正文后存档 PDF 不得变化（不重冻后来正文）');
        if (md5File(snapFile) !== snapMd5Before) bad('T8④ 冻结快照不可变');
        if (md5File(histFile) !== histMd5Before) bad('T8④ 不可变导出产物不得变化');
        if (r404.status !== 404) bad('T8④ 无效 exportId 应 404', String(r404.status));
        if (appsAfter.some((a) => a.company === '幽灵公司')) bad('T8④ 无效 exportId 不得产生投递记录');
        if (failures === f0) ok('T8④ 投递绑定 exportId：存档来自冻结快照，之后改正文 → 存档/快照/产物 md5 全不变');
      }
    }

    // ⑤ 导出页下载按钮 = POST /export → /history-pdf 导航；页面不再有 /pdf 链接；GET 打开导出页不创建记录
    {
      const pageText = await (await fetch(B10 + '/export?id=t8')).text();
      const exLen = ((readMeta10().t8 || {}).exports || []).length;
      if (/<a[^>]+href="\/pdf/.test(pageText)) bad('T8⑤ 导出页不得再有 /pdf 链接（下载走 POST /export → /history-pdf）');
      else if (!pageText.includes("fetch('/export?id=t8', { method: 'POST' })")) bad('T8⑤ 下载按钮应先 POST /export');
      else if (!pageText.includes('/history-pdf?exportId=')) bad('T8⑤ 页面应含 /history-pdf?exportId= 下载链接');
      else if (!pageText.includes('下载最新版 PDF')) bad('T8⑤ 下载按钮文案应保留（下载最新版 PDF）');
      else if (exLen !== 1) bad('T8⑤ GET 打开导出页（含自动重渲）不得创建 exports 记录', String(exLen));
      else ok('T8⑤ 导出页按钮 POST /export → /history-pdf 下载，无 /pdf 链接；GET 打开不创建记录');
    }

    // ⑥ POST /archive 置/清 archivedAt；home 默认隐藏 archived，?archived=1 可切换显示
    {
      const ra0 = await postJ('/archive', JSON.stringify({ id: 't8b', archived: true }), 'application/json');
      const ra = ra0.body;
      const home1 = await (await fetch(B10 + '/')).text();
      const home2 = await (await fetch(B10 + '/?archived=1')).text();
      const rt0 = await postJ('/archive', JSON.stringify({ id: 't8b' }), 'application/json');   // 无显式值 → 切换（清）
      const rt = rt0.body;
      const home3 = await (await fetch(B10 + '/')).text();
      const mb = readMeta10().t8b || {};
      const f0 = failures;
      if (!ra || !ra.ok || !ra.archived || !ra.archivedAt) bad('T8⑥ POST /archive 应置 archivedAt', JSON.stringify(ra));
      else if (home1.includes('/edit?id=t8b')) bad('T8⑥ home 默认应隐藏 archived 文档');
      else if (!home1.includes('显示已归档')) bad('T8⑥ home 应提供显示归档切换');
      else if (!home2.includes('/edit?id=t8b') || !home2.includes('已归档')) bad('T8⑥ ?archived=1 应显示 archived 文档（带徽章）');
      else if (!rt || !rt.ok || rt.archived !== false || rt.archivedAt !== null) bad('T8⑥ POST /archive 无显式值应切换清除', JSON.stringify(rt));
      else if (!home3.includes('/edit?id=t8b')) bad('T8⑥ 取消归档后应恢复默认显示');
      else if (mb.archivedAt !== null) bad('T8⑥ 清除后 meta.archivedAt 应为 null', JSON.stringify(mb.archivedAt));
      else if (failures === f0) ok('T8⑥ POST /archive 置/清 archivedAt；home 默认隐藏 archived、可切换显示');
    }

    // ⑦ 名实绑定（S1-8 修复轮1 Important-1 负向）：不可变产物必须由本次冻结输入直渲物化——
    //    A) 并发渲染器在渲染与物化之间把共享 pdfs/<id>.pdf 原子替换成毒字节 → 产物仍=冻结输入渲染（旧 copy 路径会物化毒字节）
    //    B) 旁车 renderInputId 不匹配 → 500、零痕迹（无产物/无记录/无残留），撤钩子后重试成功（retryable）
    {
      const poison = path.join(ROOT10, 'poison-shared');
      const badSide = path.join(ROOT10, 'bad-sidecar');
      const goodBytes = '%PDF-1.4 fake\n';
      const f0 = failures;
      // A) 共享便利文件被替换为毒字节（介入真实发生），产物字节必须等于冻结输入渲染
      fs.writeFileSync(poison, '1');
      const rA = await postExport('t8c');
      const filesA = histFiles('t8c');
      const bytesA = filesA.length === 1 ? fs.readFileSync(path.join(histDir, filesA[0]), 'utf8') : '';
      const sharedA = fs.existsSync(path.join(ROOT10, 'pdfs', 't8c.pdf')) ? fs.readFileSync(path.join(ROOT10, 'pdfs', 't8c.pdf'), 'utf8') : '';
      const exA = (readMeta10().t8c || {}).exports || [];
      fs.rmSync(poison, { force: true });
      if (!rA.body || !rA.body.ok || rA.status !== 200) bad('T8⑦A 共享文件被污染期间 POST /export 应成功', JSON.stringify(rA).slice(0, 200));
      if (!sharedA.includes('POISON')) bad('T8⑦A 前置失败：共享便利文件应已被替换为毒字节（介入确已发生）', JSON.stringify(sharedA.slice(0, 60)));
      if (filesA.length !== 1 || !/^t8c@[0-9a-f]{40}\.pdf$/.test(filesA[0])) bad('T8⑦A 应恰 1 个完整 rid 命名的不可变产物', filesA.join(','));
      else if (bytesA !== goodBytes) bad('T8⑦A 产物字节必须等于冻结输入渲染（不得来自被替换的共享文件）', JSON.stringify(bytesA.slice(0, 60)));
      else if (exA.length !== 1 || exA[0].renderInputId !== filesA[0].slice(4, -4) || rA.body.renderInputId !== exA[0].renderInputId) bad('T8⑦A 名实绑定：文件名 rid=记录 rid=响应 rid', JSON.stringify(exA[0] && exA[0].renderInputId));
      if (histAll().some((f) => f.includes('.tmp') || f.endsWith('.env.json'))) bad('T8⑦A 不应残留 tmp/旁车中间文件', histAll().join(','));
      // B) 旁车标识不匹配 → 500 零痕迹；重试成功
      const histBefore = histAll().slice().sort().join(',');
      const exLenBefore = ((readMeta10().t8 || {}).exports || []).length;
      fs.writeFileSync(badSide, '1');
      const rB = await postExport('t8');
      fs.rmSync(badSide, { force: true });
      const histMid = histAll().slice().sort().join(',');
      const exLenMid = ((readMeta10().t8 || {}).exports || []).length;
      if (rB.status !== 500 || (rB.body && rB.body.ok)) bad('T8⑦B 旁车标识不匹配应 500 且不报成功', JSON.stringify(rB).slice(0, 200));
      if (histMid !== histBefore) bad('T8⑦B 不匹配不得留下产物/残留（history 目录不变）', histBefore + ' → ' + histMid);
      if (exLenMid !== exLenBefore) bad('T8⑦B 不匹配不得写 exports 记录', String(exLenMid));
      const rC = await postExport('t8');
      const filesC = histFiles('t8');
      const exC = (readMeta10().t8 || {}).exports || [];
      const ridC = rC.body && rC.body.renderInputId ? String(rC.body.renderInputId) : '';
      const newFile = ridC ? filesC.find((f) => f === 't8@' + ridC + '.pdf') : null;
      if (!rC.body || !rC.body.ok) bad('T8⑦B 撤钩子后重试应成功（retryable）', JSON.stringify(rC).slice(0, 200));
      else if (filesC.length !== 2 || exC.length !== exLenBefore + 1) bad('T8⑦B 重试应产出新产物与新记录', filesC.join(',') + '/' + exC.length);
      else if (!newFile || fs.readFileSync(path.join(histDir, newFile), 'utf8') !== goodBytes) bad('T8⑦B 重试产物字节应等于冻结输入渲染', String(newFile));
      if (failures === f0) ok('T8⑦ 名实绑定：共享文件并发替换不可污染不可变产物（直渲冻结输入）；旁车不匹配 → 500 零痕迹、可重试');
    }
  } finally {
    for (const c of servers) { try { c.kill('SIGKILL'); } catch {} }
    await sleep(50);
    try { fs.rmSync(T8_TMP, { recursive: true, force: true }); } catch {}
  }
}
await runS1T8Tests();

// ===== S1 Task 9：跨进程并发导出幂等 / 孤儿快照可清理且 committed 引用幸存 / 远程资源导出拒绝 / snapshots 页导出引用徽章 / history-pdf 缺产物提示（node 级；隔离根+隔离端口，双服务进程同根）=====
async function runS1T9Tests() {
  const T9_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-t9-'));
  const servers = [];
  try {
    const ROOT11 = path.join(T9_TMP, 'r11');
    const REMOTE_URL = 'https://cdn.example.com/t9r.png';
    // t9r：引用 http(s) 远程图的文档（不可复现输入 → POST /export 拒绝；普通渲染允许 + 旁车 reproducible:false）
    const t9rHtml = txDoc('t9r', 'T9R-V1', '').replace('<div class="sheet"', '<img src="' + REMOTE_URL + '" alt="远程图"><div class="sheet"');
    const fr11 = seedRoot(ROOT11, { t9: txDoc('t9', 'T9-V1', ''), t9r: t9rHtml }, {});
    // 假渲染器：原子落盘 + 旁车按 env 回显 reproducible（与真实 render.mjs 同契约：'1'→true '0'→false 未设→null）
    fs.writeFileSync(fr11, '#!/bin/bash\nshift\nsrc=""; out=""\nif [ "$1" = "--src" ]; then src="$2"; out="$4"; else src="$RESUME_ROOT/docs/$1.html"; out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\ntmp="$out.$$.tmp"\nprintf "%%PDF-1.4 fake\\n" > "$tmp"\nmv "$tmp" "$out"\nif [ "$RESUME_RENDER_REPRODUCIBLE" = "1" ]; then rp=true; elif [ "$RESUME_RENDER_REPRODUCIBLE" = "0" ]; then rp=false; else rp=null; fi\necho \'{"renderInputId":"\'"$RESUME_RENDER_INPUT_ID"\'","reproducible":\'"$rp"\',"dpi":150}\' > "$out.env.json"\n');
    fs.chmodSync(fr11, 0o755);
    // 两个独立服务进程、同一数据根（跨进程 updateMeta 锁等价性）
    const srvA = await spawnServer(ROOT11, { RESUME_RENDER_BIN: fr11 });
    const srvB = await spawnServer(ROOT11, { RESUME_RENDER_BIN: fr11 });
    servers.push(srvA.child, srvB.child);
    const readMeta11 = () => JSON.parse(fs.readFileSync(path.join(ROOT11, 'docs-meta.json'), 'utf8'));
    const snapDirT9 = path.join(ROOT11, 'snapshots', 't9');
    const snapTsAll = () => fs.existsSync(snapDirT9) ? fs.readdirSync(snapDirT9).filter((f) => f.endsWith('.html')).map((f) => f.replace('.html', '')).sort() : [];
    const histDir = path.join(ROOT11, 'pdfs', 'history');
    const histFiles = (docId) => fs.existsSync(histDir) ? fs.readdirSync(histDir).filter((f) => f.startsWith(docId + '@') && f.endsWith('.pdf')) : [];
    const postExport = (B, docId) => fetch(B + '/export?id=' + docId, { method: 'POST' })
      .then((r) => r.json().then((j) => ({ status: r.status, body: j }), () => ({ status: r.status, body: null })));

    // ① 跨进程并发 POST /export（两服务进程同时）→ 恰 1 条 exports 记录 + 恰 1 个 history 不可变文件（updateMeta 锁跨进程等价）
    let committed = null;
    {
      const [ra, rb] = await Promise.all([postExport(srvA.base, 't9'), postExport(srvB.base, 't9')]);
      const m = readMeta11();
      const ex = (m.t9 || {}).exports || [];
      const files = histFiles('t9');
      if (!ra.body || !ra.body.ok || !rb.body || !rb.body.ok) bad('T9① 跨进程并发 POST /export 应都成功', JSON.stringify([ra, rb]).slice(0, 300));
      else if (ex.length !== 1) bad('T9① 两进程并发应仅 1 条 exports 记录（跨进程 updateMeta 锁）', String(ex.length));
      else if (files.length !== 1) bad('T9① 应仅 1 个 history 不可变文件', files.join(','));
      else if (ra.body.exportId !== rb.body.exportId || ex[0].exportId !== ra.body.exportId) bad('T9① 两进程响应应为同一 exportId', ra.body.exportId + '/' + rb.body.exportId);
      else if (!/^t9@[0-9a-f]{40}\.pdf$/.test(files[0]) || ex[0].renderInputId !== files[0].slice(3, -4)) bad('T9① 产物名/记录 rid 应一致且完整 40hex', files[0]);
      else { committed = ex[0]; ok('T9① 跨进程并发 POST /export → 恰 1 条 exports 记录 + 恰 1 个 history 文件（同一 exportId，updateMeta 锁等价）'); }
    }

    // ② 孤儿快照（并发落败方写入、未被任何 committed 记录引用）：可存在，但绝不被 exports/applications 引用，且可被 prune 清理；
    //    committed 引用（exports[].snapTs）在 prune 中幸存（protectedSnaps 豁免）
    {
      if (!committed) bad('T9② 前置失败：① 未产出 committed 导出记录');
      else {
        const all = snapTsAll();
        const orphans = all.filter((ts) => ts !== committed.snapTs);   // 本根无投递/基准 → 非 committed 引用者即孤儿
        const metaNow = readMeta11();
        const appsNow = JSON.parse(fs.readFileSync(path.join(ROOT11, 'applications.json'), 'utf8'));
        const referencedByRecords = new Set([
          ...(((metaNow.t9 || {}).exports) || []).map((e) => e && e.snapTs),
          ...appsNow.filter((a) => a && a.snapTs).map((a) => a.snapTs)
        ].filter(Boolean));
        if (!fs.existsSync(path.join(snapDirT9, committed.snapTs + '.html'))) bad('T9② committed 引用的冻结快照应在盘上', committed.snapTs);
        else if (orphans.some((ts) => referencedByRecords.has(ts))) bad('T9② 孤儿快照绝不被 committed 记录引用', orphans.join(','));
        else {
          // 确定性构造：模拟落败并发写者的孤儿（更早 ts）+ 填满配额的未来 ts 填充快照 → 手动保存触发 snapshot+pruneSnapshots
          const SIM_ORPHAN = '2026-09-24-000000-000';
          fs.writeFileSync(path.join(snapDirT9, SIM_ORPHAN + '.html'), '<html>loser-orphan</html>');
          for (let i = 1; i <= 55; i++) fs.writeFileSync(path.join(snapDirT9, '2027-01-01-0000' + String(i).padStart(2, '0') + '.html'), '<html>filler</html>');
          const before = snapTsAll();
          if (!before.includes(SIM_ORPHAN) || before.length < 56) bad('T9② 前置失败：孤儿/填充快照未就位', String(before.length));
          else {
            const sv = await fetch(srvA.base + '/save?id=t9', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: txDoc('t9', 'T9-V1', '') }).then((r) => r.json());
            const after = snapTsAll();
            const fillersLeft = after.filter((ts) => ts.startsWith('2027-')).length;
            const metaT9 = readMeta11();
            const stillCommitted = (metaT9.t9 || {}).exports && metaT9.t9.exports[0].snapTs === committed.snapTs;
            if (!sv || !sv.ok) bad('T9② 保存失败（prune 未触发）', JSON.stringify(sv));
            else if (after.includes(SIM_ORPHAN)) bad('T9② 可清理孤儿快照应被 prune 清掉（配额生效）');
            else if (!after.includes(committed.snapTs)) bad('T9② committed 引用（exports[].snapTs）必须在 prune 中幸存', committed.snapTs);
            else if (!stillCommitted) bad('T9② prune 不得改动 committed 导出记录');
            else if (fillersLeft >= 55) bad('T9② 填充快照应被配额清理（55→' + fillersLeft + '）');
            else ok('T9② 孤儿快照（并发落败方）可存在但绝不被 committed 记录引用；prune 清孤儿、committed 引用幸存（真实孤儿 ' + orphans.length + ' 份）');
          }
        }
      }
    }

    // ③ /snapshots 页保护徽章包含 exports[].snapTs 引用（Task 8 review Minor-1：展示与 protectedSnaps 清理口径一致）
    {
      if (!committed) bad('T9③ 前置失败：无 committed 导出记录');
      else {
        const page = await (await fetch(srvA.base + '/snapshots?id=t9')).text();
        const liOf = (ts) => page.split('<li class="card"').find((s) => s.includes('<b>' + ts + '</b>')) || '';
        // 徽章文案（批次D 后：📦 emoji 已换成内联 SVG 图标，文字部分保持不变）
        const badgeTxt = '导出引用（不会被清理）';
        if (!liOf(committed.snapTs)) bad('T9③ /snapshots 应列出 committed 快照', committed.snapTs);
        else if (!liOf(committed.snapTs).includes(badgeTxt)) bad('T9③ exports[].snapTs 引用的快照应显示导出引用保护徽章（Task 8 Minor-1）');
        else if (page.includes('📦')) bad('T9③ 导出引用徽章不应再用 emoji（应改用内联 SVG 图标）');
        else ok('T9③ /snapshots 保护徽章含 exports[].snapTs 引用（导出引用快照标注「不会被清理」）');
      }
    }

    // ④ /history-pdf 缺失产物提示：重新 POST /export 仅在文档身份（renderInputId）未变时修复本记录（Task 8 review Minor-2）
    {
      if (!committed) bad('T9④ 前置失败：无 committed 导出记录');
      else {
        const hf = path.join(ROOT11, committed.file);
        if (!fs.existsSync(hf)) bad('T9④ 前置失败：不可变产物应在盘上', committed.file);
        else {
          fs.rmSync(hf);   // 模拟产物缺失
          const r = await fetch(srvA.base + '/history-pdf?exportId=' + encodeURIComponent(committed.exportId));
          const txt = await r.text();
          if (r.status !== 404) bad('T9④ 缺产物应 404', String(r.status));
          else if (!txt.includes('仅当文档身份 renderInputId 未变时')) bad('T9④ 提示应说明"重新导出仅在文档身份未变时修复"（Task 8 Minor-2）: ' + txt.slice(0, 160));
          else if (!txt.includes('重新 POST /export')) bad('T9④ 提示应给出可操作修复路径: ' + txt.slice(0, 160));
          else ok('T9④ /history-pdf 缺产物提示：重新 POST /export 仅在文档身份（renderInputId）未变时修复本记录');
        }
      }
    }

    // ⑤ 远程资源文档：POST /export 409 拒绝（remote 非空 + 可操作提示），零痕迹；普通渲染仍允许且旁车 reproducible:false
    {
      const rExp = await postExport(srvA.base, 't9r');
      const m = readMeta11();
      if (rExp.status !== 409 || !rExp.body || rExp.body.ok !== false) bad('T9⑤ 远程资源 POST /export 应 409 拒绝', JSON.stringify(rExp).slice(0, 200));
      else if (!Array.isArray(rExp.body.remote) || !rExp.body.remote.includes(REMOTE_URL)) bad('T9⑤ 拒绝响应应携带非空 remote[]', JSON.stringify(rExp.body.remote));
      else if (!/本地化/.test(String(rExp.body.error || ''))) bad('T9⑤ 拒绝提示应可操作（先本地化再导出）: ' + rExp.body.error);
      else if ((m.t9r || {}).exports || histFiles('t9r').length) bad('T9⑤ 拒绝导出不得留下记录/产物痕迹');
      else {
        const rRender = await fetch(srvA.base + '/render?id=t9r', { method: 'POST' }).then((r) => r.json());
        const sideFile = path.join(ROOT11, 'pdfs', 't9r.pdf.env.json');
        let side = null; try { side = JSON.parse(fs.readFileSync(sideFile, 'utf8')); } catch {}
        const expected = freezeHtml(fs.readFileSync(path.join(ROOT11, 'docs', 't9r.html'), 'utf8'), readMeta11().t9r || {});
        if (!rRender || !rRender.ok) bad('T9⑤ 普通渲染应仍被允许（spec §12.1）', JSON.stringify(rRender));
        else if (!fs.existsSync(path.join(ROOT11, 'pdfs', 't9r.pdf'))) bad('T9⑤ 渲染应产出 PDF');
        else if (!side || side.reproducible !== false) bad('T9⑤ 旁车应记 reproducible:false（远程资源）', JSON.stringify(side));
        else if (side.renderInputId !== expected.renderInputId) bad('T9⑤ 旁车标识应为该任务冻结标识', JSON.stringify(side));
        else if (expected.reproducible !== false || expected.remote.length !== 1) bad('T9⑤ 前置失败：freeze 应判该文档不可复现', JSON.stringify({ r: expected.reproducible, remote: expected.remote }));
        else ok('T9⑤ 远程资源导出拒绝（409 + remote[] + 先本地化提示，零痕迹）；普通渲染允许且旁车 reproducible:false');
      }
    }
  } finally {
    for (const c of servers) { try { c.kill('SIGKILL'); } catch {} }
    await sleep(50);
    try { fs.rmSync(T9_TMP, { recursive: true, force: true }); } catch {}
  }
}
await runS1T9Tests();
// 节点段失败也要把浏览器段跑完：早退会让浏览器层结果整段消失（2026-10-22 审查）
if (failures) console.error('❌ 事务/锁/冻结点验证失败 ' + failures + ' 项（继续跑浏览器段）');

// RELIABILITY_RESOLVE_BEGIN
let bin;
try { bin = await resolveChromium(); }
catch (e) { console.error('⚠️ Chromium 不可用，跳过浏览器级验证: ' + (e && e.message || e)); process.exit(failures > 0 ? 1 : 2); }
// RELIABILITY_RESOLVE_END

// ===== 浏览器测试专用夹具：带两个项目条目的文档 + 岗位草稿 =====
const ED_DOC = 'ed-fixture';
const JOB_DOC = 'ed-fixture-v2';
{
  let tpl = assembleTemplate('classic');   // 夹具经装配生成（themes 唯一源），不直读 template.html
  const projects = '<div class="entry-head" data-zid="za7b8c9d0"><div class="entry-title">项目A</div><div class="entry-role">负责人</div><div class="entry-date">2024-2025</div></div>\n<ul><li data-zid="zd1e2f3a4">旧项目描述</li><li data-zid="za1b2c3d4">旧项目描述</li></ul>\n<div class="entry-head" data-zid="zc9d8e7f2"><div class="entry-title">项目B</div><div class="entry-role">开发</div><div class="entry-date">2023</div></div>\n<ul><li data-zid="zb4c5d6e7">项目B描述</li></ul>';
  tpl = tpl.replaceAll('{{NAME}}', () => '测试员').replaceAll('{{CONTACT}}', () => 'test@example.com')
    .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
    .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => projects).replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => ED_DOC);
  fs.writeFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), tpl);
  // 外来内联脚本的文档：/edit 的 CSP 必须挡住它（文档正文是外部输入 → 恢复的备份可带 <script>）
  fs.writeFileSync(path.join(dataRoot, 'docs', 'ed-evil.html'),
    tpl.replace('</body>', '<script>window.__PWNED = 1;</script></body>'));
  fs.copyFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), path.join(dataRoot, 'docs', JOB_DOC + '.html'));
  const metaPath = path.join(dataRoot, 'docs-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  // S4a-T7：fresh mat ref 夹具（真实确认素材 + 指纹匹配 → 纯 sourced 徽章与事实字段原文展示）
  const mFreshFacts = { company: '在线公司', role: '', dates: '', education: '', metrics: 'P99 210ms', contribution: '', conditions: '', source: '' };
  const matsPath = path.join(dataRoot, 'materials.json');
  const matsArr = JSON.parse(fs.readFileSync(matsPath, 'utf8'));
  matsArr.push({ id: 'm-fresh', title: '在线素材', factStatus: 'confirmed', facts: mFreshFacts });
  fs.writeFileSync(matsPath, JSON.stringify(matsArr));
  meta[JOB_DOC] = {
    parent: ED_DOC, company: '浏览器测试公司', role: '前端工程师', jd: 'React', createdAt: new Date().toISOString(), tag: '浏览器测试', rev: 5,
    zones: { za1b2c3d4: { zone: 'project', status: 'confirmed' }, zd1e2f3a4: { zone: 'project', status: 'confirmed' }, za7b8c9d0: { zone: 'project', status: 'confirmed' }, zc9d8e7f2: { zone: 'project', status: 'confirmed' }, zb4c5d6e7: { zone: 'work', status: 'confirmed' } },
    job: {
      status: 'draft', sourceSnap: '', sourceHash: '', materials: [], generatedAt: null, deliveredAt: null, summary: '',
      changes: [
        // S4a-T8：bt1 带 zid + 过期 baseSnapshot → needs-compare（确认门路径）；bt2 锚定条目头（可加锁测 locked-now）
        { id: 'bt1', gen: 1, section: '项目经历', entry: '项目A', kind: 'replace', before: '旧项目描述', after: '新项目描述（定制）', reason: '对齐 JD', source: '母版', level: 'normal', status: 'pending', zid: 'za1b2c3d4', baseSnapshot: '生成基线：旧项目描述', zone: 'project' },
        { id: 'bt2', gen: 1, section: '项目经历', entry: '项目B', kind: 'hide', before: '', after: '', reason: '低相关', source: 'JD', level: 'important', status: 'pending', zid: 'za7b8c9d0', baseSnapshot: '项目A负责人2024-2025', zone: 'project' }
      ],
      todos: [{ section: '项目经历', question: '缺少量化指标', why: 'JD 要求数据驱动', resolved: false }],
      // S4a-T6：证据表夹具（sourced 条目 + 不存在的 mat id → GET live 标注 fresh:false/stale:true 的现算路径）
      // S4a-T7 扩：covered（fresh para ref，供定位）/ none（note 两级）/ todo+noteConfirmed（有据·你的补充）
      evidence: [
        { id: 'e1', req: 'React 组件化经验', status: 'sourced', refs: [{ refId: 'b1r1', type: 'mat', id: 'm-none', zid: null, srcStatus: 'confirmed', hash: 'deadbeef', title: '旧素材', quote: '' }], note: '', noteConfirmed: false },
        { id: 'e2', req: '数据管道经验', status: 'covered', refs: [{ refId: 'b1r2', type: 'para', id: null, zid: 'zb4c5d6e7', hash: paraFingerprint('项目B描述'), title: '项目经历', quote: '项目B描述' }], note: '', noteConfirmed: false },
        { id: 'e3', req: 'AB 实验设计', status: 'none', refs: [], note: '', noteConfirmed: false },
        { id: 'e4', req: '工程效率提升', status: 'todo', refs: [], note: '维护过 3 节点自建集群两年（个人项目仓库）', noteConfirmed: true },
        { id: 'e5', req: '高并发服务经验', status: 'sourced', refs: [{ refId: 'b1r3', type: 'mat', id: 'm-fresh', zid: null, srcStatus: 'confirmed', hash: contentFingerprint(mFreshFacts), title: '在线素材', quote: '' }], note: '', noteConfirmed: false }
      ],
      evidenceGen: 1
    }
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta));
}

// RELIABILITY_LAUNCH_BEGIN
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
    process.exit(failures > 0 ? 1 : 2);
  }
}
// RELIABILITY_LAUNCH_END
try {
  // ===== 1. 保存期间继续编辑：A 提交，B 期间产生，A 返回后 B 仍未保存 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
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
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
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
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
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
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } });   // ≥1440：三栏全开（宽度档不折叠）
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('#ed-pane-review .jp-item', { timeout: 5000 });
    const sel = await page.evaluate(() => document.querySelector('#ed-rtabs button[data-pane="review"]').getAttribute('aria-selected'));
    if (sel !== 'true') bad('岗位草稿默认未打开审阅视图'); else ok('岗位草稿默认打开修改清单');
    await page.click('#ed-pane-review .jp-item button.jp-accept');   // bt1 needs-compare → 先出确认门
    await page.waitForSelector('#ed-pane-review [data-change="bt1"] .jp-gate', { timeout: 3000 });
    await page.click('#ed-pane-review [data-change="bt1"] .jp-gate button.jp-accept');
    await page.waitForFunction(() => document.querySelector('.sheet').textContent.includes('新项目描述（定制）'), { timeout: 4000 });
    ok('接受修改应用到正文（确认门通过）');
    await page.waitForFunction(() => /已接受/.test((document.querySelector('#ed-pane-review [data-change="bt1"]') || document.createElement('div')).textContent || ''), { timeout: 6000 });   // 等 JSON 保存落盘并刷新
    const disk4 = fs.readFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), 'utf8');
    if (!disk4.includes('新项目描述（定制）')) bad('接受的修改未落盘');
    else ok('接受的修改落盘');
    // 同文两段：锚定建议必须只改自己那段（2026-10-22 审查 [高]：
    // 「按全文首个匹配」会改错段落，而面板照样显示「已接受」）
    const byZid = (zid) => {
      const m = disk4.match(new RegExp('data-zid="' + zid + '"[^>]*>([^<]*)'));
      return m ? m[1] : '';
    };
    if (byZid('za1b2c3d4') !== '新项目描述（定制）') bad('锚点段未被修改：' + byZid('za1b2c3d4'));
    else if (byZid('zd1e2f3a4') !== '旧项目描述') bad('同文的另一段被误改：' + byZid('zd1e2f3a4'));
    else ok('接受建议只改锚点那一段（同文另一段未动）');
    const st = await page.evaluate(() => fetch('/job/changes?id=' + window.__edDocId).then((r) => r.json()));
    const accepted = st.job.changes.find((c) => c.id === 'bt1');
    if (!accepted || accepted.status !== 'accepted') bad('审阅状态未回写服务端'); else ok('审阅状态回写并持久化');
    // 隐藏条目（important：需逐条确认）。落点按 zid（BL-P2-03，426f234：findEntry zid 优先于标题子串匹配）：
    // bt2.zid=za7b8c9d0 锚定的是「项目A」条目头，entry 文案「项目B」只是无 zid 时的退化路径 → 隐藏的必须是 zid 锚点，项目B 不受影响
    await page.click('#ed-pane-review [data-change="bt2"] button.jp-accept');
    await page.waitForTimeout(300);
    const hidden = await page.evaluate(() => {
      const anchor = document.querySelector('.sheet .entry-head[data-zid="za7b8c9d0"]');
      const byTitle = Array.from(document.querySelectorAll('.sheet .entry-head')).find((h) => h.textContent.includes('项目B'));
      return { anchorHidden: !!(anchor && anchor.classList.contains('ed-entry-hidden')), titleHidden: !!(byTitle && byTitle.classList.contains('ed-entry-hidden')) };
    });
    if (!hidden.anchorHidden) bad('隐藏条目未生效', 'zid 锚点条目头未带 ed-entry-hidden');
    else if (hidden.titleHidden) bad('隐藏落错条目', '按标题匹配到的项目B 被隐藏（应按 zid 锚点落点）');
    else ok('条目级隐藏生效（按 zid 锚点落点，内容保留可恢复）');
    const disk5 = fs.readFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), 'utf8');
    if (!disk5.includes('ed-entry-hidden')) bad('隐藏类未落盘（PDF 将不隐藏）'); else ok('隐藏类随保存落盘');
    await page.reload();
    await page.waitForSelector('#ed-pane-review .jp-item');
    const after = await page.evaluate(() => document.querySelector('#ed-pane-review .jp-st').textContent);
    if (!/已接受/.test(after)) bad('刷新后审阅状态丢失：' + after); else ok('刷新后审阅状态保留');
    await ctx.close();
  }

  // ===== 4b [S4a-T4] AI 任务迷你指示：running 可见、点击回审阅 Tab、非岗位草稿不渲染、结束后隐藏 =====
  {
    // 夹具：浏览器外直改 meta 把 changes 任务置 running（页面轮询 2.5s 内应出现「生成中…」）
    const metaPathB = path.join(dataRoot, 'docs-meta.json');
    const mkTask = (over) => Object.assign({ taskId: null, status: 'idle', startedAt: null, baseHash: null, error: null, scope: null }, over || {});
    const metaB = JSON.parse(fs.readFileSync(metaPathB, 'utf8'));
    metaB[JOB_DOC].job.genTasks = { evidence: mkTask(), changes: mkTask({ taskId: 't-feed001', status: 'running', startedAt: Date.now() }) };
    fs.writeFileSync(metaPathB, JSON.stringify(metaB));
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('.ed-gening:not([hidden])', { timeout: 6000 });
    ok('[S4a-T4] running 态迷你指示可见（生成中…）');
    await page.evaluate(() => window.__edSelectTab('ai'));
    await page.click('.ed-gening');
    await page.waitForFunction(() => document.querySelector('#ed-rtabs button[data-pane="review"]').getAttribute('aria-selected') === 'true', { timeout: 3000 });
    ok('[S4a-T4] 迷你指示点击回到审阅 Tab');
    const page2 = await ctx.newPage();
    await page2.goto(base + '/edit?id=' + ED_DOC);
    await page2.waitForSelector('#ed-navlist .ed-nav');
    if (await page2.evaluate(() => !!document.querySelector('.ed-gening'))) bad('[S4a-T4] 非岗位草稿出现了生成指示');
    else ok('[S4a-T4] 非岗位草稿无迷你指示');
    const metaB2 = JSON.parse(fs.readFileSync(metaPathB, 'utf8'));
    metaB2[JOB_DOC].job.genTasks.changes = mkTask();
    fs.writeFileSync(metaPathB, JSON.stringify(metaB2));
    await page.waitForSelector('.ed-gening', { state: 'hidden', timeout: 6000 });
    ok('[S4a-T4] 任务结束（idle）后迷你指示隐藏');
    await ctx.close();
  }

  // ===== 4c [S4a-T6] 审阅三段骨架：段切换 / 证据最小渲染 / 任务状态可取消 / 刷新后位置恢复 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 5000 });
    const secActive = () => page.evaluate(() => {
      const b = document.querySelector('#ed-pane-review .jp-secs button.on');
      return b ? b.dataset.sec : '';
    });
    // 夹具有待处理建议且无 reviewPos → 默认段 = 修改清单（既有 jp-item 渲染不破）
    if (await secActive() !== 'changes') bad('[S4a-T6] 有建议时默认段应为修改清单: ' + await secActive());
    else ok('[S4a-T6] 三段骨架默认段=修改清单（有建议）');
    if (!(await page.$('#ed-pane-review .jp-item'))) bad('[S4a-T6] 修改清单段缺既有条目渲染');
    else ok('[S4a-T6] 修改清单段保留既有渲染');
    // 要求与证据段：最小只读渲染（条目 + 状态徽章 + 任务状态）
    await page.click('#ed-pane-review .jp-secs button[data-sec="evidence"]');
    let evTxt = await page.evaluate(() => document.querySelector('#ed-pane-review').textContent);
    if (!evTxt.includes('React 组件化经验')) bad('[S4a-T6] 证据段缺条目渲染');
    else ok('[S4a-T6] 证据段最小渲染（条目可见）');
    if (!/有据/.test(evTxt)) bad('[S4a-T6] 证据段缺 sourced 徽章文案: ' + evTxt.slice(0, 120));
    if (!/证据分析未开始|未生成/.test(evTxt)) bad('[S4a-T6] 证据段缺任务状态（idle）');
    else ok('[S4a-T6] 证据任务状态可见（idle）');
    // 导出检查段：占位（T10 落地）
    await page.click('#ed-pane-review .jp-secs button[data-sec="export"]');
    evTxt = await page.evaluate(() => document.querySelector('#ed-pane-review').textContent);
    if (!/导出检查/.test(evTxt)) bad('[S4a-T6] 导出检查段缺占位');
    else ok('[S4a-T6] 导出检查段占位（T10）');
    // 刷新后位置恢复：切到要求与证据 → reload → 段恢复（reviewPos 服务端持久化）
    await page.click('#ed-pane-review .jp-secs button[data-sec="evidence"]');
    await page.waitForTimeout(400);   // 等 reviewPos POST 落盘
    await page.reload();
    await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 5000 });
    await page.waitForTimeout(600);   // 等 GET 完成后按 reviewPos 定段
    if (await secActive() !== 'evidence') bad('[S4a-T6] 刷新后未恢复到要求与证据段: ' + await secActive());
    else ok('[S4a-T6] 刷新后位置恢复（reviewPos.section=evidence）');
    // 证据任务 running 可见 + 可取消（夹具直写 running；取消走真端点，不依赖 LLM）
    const metaPathC = path.join(dataRoot, 'docs-meta.json');
    const mkTaskC = (over) => Object.assign({ taskId: null, status: 'idle', startedAt: null, baseHash: null, error: null, scope: null }, over || {});
    const metaC = JSON.parse(fs.readFileSync(metaPathC, 'utf8'));
    metaC[JOB_DOC].job.genTasks.evidence = mkTaskC({ taskId: 't-feed002', status: 'running', startedAt: Date.now() });
    fs.writeFileSync(metaPathC, JSON.stringify(metaC));
    await page.reload();
    await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 5000 });
    await page.waitForFunction(() => /正在分析证据/.test(document.querySelector('#ed-pane-review').textContent), { timeout: 6000 });
    ok('[S4a-T6] 证据任务 running 态可见（正在分析证据）');
    await page.click('#ed-pane-review button.jp-ev-cancel');
    await page.waitForFunction(() => /已取消/.test(document.querySelector('#ed-pane-review').textContent), { timeout: 5000 });
    ok('[S4a-T6] 证据任务可取消（cancelled 态可见）');
    await ctx.close();
  }

  // ===== 4d [S4a-T7] 证据表完整 UI：五态徽章/事实依据可读化/zid 定位/note 两级/入口合并/引导无死链 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 5000 });
    // 入口合并：岗位草稿右栏 Tab 恰为 审阅/区域/AI 助手/排版；普通文档无审阅也无岗位匹配
    const tabs7 = await page.evaluate(() => Array.from(document.querySelectorAll('#ed-rtabs button')).map((b) => b.textContent.trim()));
    if (tabs7.join(',') !== '审阅,区域,AI 助手,排版') bad('[S4a-T7] 岗位草稿右栏 Tab 应为 审阅/区域/AI 助手/排版: ' + tabs7.join(','));
    else ok('[S4a-T7] 入口合并：岗位草稿四 Tab（岗位匹配已移除）');
    const pageN = await ctx.newPage();
    await pageN.goto(base + '/edit?id=' + ED_DOC);
    await pageN.waitForSelector('#ed-rtabs', { timeout: 5000 });
    const tabsN = await pageN.evaluate(() => Array.from(document.querySelectorAll('#ed-rtabs button')).map((b) => b.textContent.trim()));
    if (tabsN.includes('审阅') || tabsN.includes('岗位匹配')) bad('[S4a-T7] 普通文档不应有审阅/岗位匹配 Tab: ' + tabsN.join(','));
    else ok('[S4a-T7] 普通文档无审阅/岗位匹配 Tab（现状保持）');
    const guide = await pageN.evaluate(() => { const el = document.querySelector('#ai-log'); return el ? el.textContent : ''; });
    if (/岗位匹配|🎯/.test(guide)) bad('[S4a-T7] AI 引导仍有岗位匹配死链: ' + guide.slice(0, 100));
    else ok('[S4a-T7] AI 引导无死链');
    await pageN.close();
    // 证据段：五态徽章（失效覆盖 sourced 展示）+ 事实依据可读化 + 统计行
    await page.click('#ed-pane-review .jp-secs button[data-sec="evidence"]');
    await page.waitForSelector('#ed-pane-review [data-ev="e1"]', { timeout: 5000 });
    const evTxtOf = (id) => page.evaluate((i) => { const el = document.querySelector('#ed-pane-review [data-ev="' + i + '"]'); return el ? el.textContent : ''; }, id);
    let t1 = await evTxtOf('e1');
    if (!/待重新关联/.test(t1) || !/来源已变化/.test(t1) || /素材有据·简历未表达/.test(t1)) bad('[S4a-T7] ref 全失效应显示 待重新关联/来源已变化 且不显 sourced 徽章: ' + t1.slice(0, 120));
    else ok('[S4a-T7] ref 全失效 → todo 层「待重新关联」（不显 sourced/covered）');
    if (!/素材：旧素材/.test(t1) || !/事实依据/.test(t1)) bad('[S4a-T7] mat ref 应可读化（素材标题 + 事实依据标注）: ' + t1.slice(0, 120));
    else ok('[S4a-T7] mat ref 事实依据可读化');
    const t2 = await evTxtOf('e2');
    if (!/简历已覆盖/.test(t2) || !/正文段落/.test(t2) || !/项目B描述/.test(t2)) bad('[S4a-T7] covered 条目应显 简历已覆盖 + para ref 可读化: ' + t2.slice(0, 120));
    else ok('[S4a-T7] covered 徽章 + para ref 可读化');
    const statsTxt = await page.evaluate(() => { const el = document.querySelector('#ed-pane-review .jp-sum'); return el ? el.textContent : ''; });
    if (!/简历已覆盖 1/.test(statsTxt) || !/素材有据未表达 2/.test(statsTxt) || !/待补充 2/.test(statsTxt)) bad('[S4a-T7] 三列分计统计行不符: ' + statsTxt);
    else ok('[S4a-T7] 三列分计统计行（覆盖 1 · 有据未表达 2 · 待补充 2）');
    // 纯 sourced 徽章（仅有效 mat ref）+ 事实字段原文展示
    const t5 = await evTxtOf('e5');
    if (!/素材有据·简历未表达/.test(t5) || !/指标：P99 210ms/.test(t5) || /简历已覆盖/.test(t5)) bad('[S4a-T7] sourced 条目应显「素材有据·简历未表达」+ 事实字段原文，不显 covered: ' + t5.slice(0, 140));
    else ok('[S4a-T7] sourced 徽章 + 事实字段原文（不显 covered）');
    // zid 定位：点击 para ref 的 📍定位 → 段落滚入视口 + jp-flash 高亮存在（瞬态，无 class 残留）
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#ed-pane-review [data-ev="e2"] button.jp-refbtn');
    await page.waitForFunction(() => !!(window.CSS && CSS.highlights && CSS.highlights.get('jp-flash')), { timeout: 3000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-zid="zb4c5d6e7"]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    }, { timeout: 3000 });
    ok('[S4a-T7] zid 定位（滚动到段落 + Custom Highlight 闪烁）');
    const bodyHtml = await page.evaluate(() => document.querySelector('.sheet').innerHTML);
    if (/class="[^"]*jp-flash/.test(bodyHtml)) bad('[S4a-T7] 闪烁不应给正文挂 class');
    else ok('[S4a-T7] 高亮为瞬态（正文无 class 残留）');
    // note 两级流程：none 条目输入→保存→确认计 sourced 层→退回
    const t3 = await evTxtOf('e3');
    if (!/当前已确认来源中未找到证据/.test(t3)) bad('[S4a-T7] none 条目固定文案缺失: ' + t3.slice(0, 100));
    else ok('[S4a-T7] none 文案固定（未找到证据）');
    const confSel = '#ed-pane-review [data-ev="e3"] .jp-note button.jp-pri';
    if (!(await page.evaluate((s) => document.querySelector(s) && document.querySelector(s).disabled, confSel))) bad('[S4a-T7] 空说明时「确认为证据」应禁用');
    else ok('[S4a-T7] 空说明时确认为证据禁用');
    await page.fill('#ed-pane-review [data-ev="e3"] .jp-note textarea', '维护过 3 节点自建集群两年（个人项目仓库）');
    await page.click(confSel);
    // 等待目标锁定 e3 自身徽章（不能全文匹配「已确认为证据」——e4 夹具的静态标签会提前满足）
    await page.waitForFunction(() => /有据（依据：你的补充）/.test((document.querySelector('#ed-pane-review [data-ev="e3"]') || document.createElement('div')).textContent || ''), { timeout: 5000 });
    let t3b = await evTxtOf('e3');
    // 「不显 covered」只查徽章元素——hint 文案「正文实际引用后才计『简历已覆盖』」是说明文字，不算徽章
    const e3badges = await page.evaluate(() => Array.from(document.querySelectorAll('#ed-pane-review [data-ev="e3"] .jp-st')).map((x) => x.textContent).join('|'));
    if (!/有据（依据：你的补充）·简历未表达/.test(t3b) || /简历已覆盖/.test(e3badges)) bad('[S4a-T7] 确认后应计 sourced 层（有据·你的补充）且徽章不显 covered: badges=' + e3badges);
    else ok('[S4a-T7] note 确认计 sourced 层（不显 covered）');
    // 落盘断言：note/noteConfirmed 进 meta（GET 视图含）
    const persisted = await page.evaluate(async () => {
      const d = await (await fetch('/job/changes?id=' + location.search.match(/[?&]id=([^&]+)/)[1])).json();
      const e3 = (d.job.evidence || []).find((x) => x.id === 'e3');
      return { note: e3 && e3.note, confirmed: e3 && e3.noteConfirmed };
    });
    if (!persisted.confirmed || !/自建集群/.test(String(persisted.note))) bad('[S4a-T7] note/noteConfirmed 未落盘: ' + JSON.stringify(persisted));
    else ok('[S4a-T7] note 确认经服务端落盘');
    // 退回：badge 回 todo 层，note 保留
    await page.click('#ed-pane-review [data-ev="e3"] .jp-note button:nth-of-type(2)');
    await page.waitForFunction(() => /已退回确认/.test(document.querySelector('#ed-pane-review .jp-msg').textContent), { timeout: 5000 });
    const t3c = await evTxtOf('e3');
    if (/有据（依据：你的补充）/.test(t3c) || !/待补充|未找到证据/.test(t3c)) bad('[S4a-T7] 退回后应回原状态层: ' + t3c.slice(0, 120));
    else ok('[S4a-T7] 退回确认回到原状态层');
    // noteConfirmed 条目（e4 夹具）：徽章「有据（依据：你的补充）」+ 退回按钮存在
    const t4 = await evTxtOf('e4');
    if (!/有据（依据：你的补充）·简历未表达/.test(t4) || !/退回确认/.test(t4)) bad('[S4a-T7] noteConfirmed 条目展示不符: ' + t4.slice(0, 120));
    else ok('[S4a-T7] noteConfirmed 条目计 sourced 同层展示 + 可退回');
    await ctx.close();
  }

  // ===== 4e [S4a-T7] 轮询续排：running 期间瞬时 GET 失败（abort 一次）后链条仍自续（T6 转交 b）=====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    // 夹具：evidence 任务 running（直写 meta，与 4c 同模式）
    const metaPathE = path.join(dataRoot, 'docs-meta.json');
    const metaE = JSON.parse(fs.readFileSync(metaPathE, 'utf8'));
    metaE[JOB_DOC].job.genTasks = metaE[JOB_DOC].job.genTasks || {};
    metaE[JOB_DOC].job.genTasks.evidence = { taskId: 't-poll01', status: 'running', startedAt: Date.now(), baseHash: null, error: null, scope: null };
    fs.writeFileSync(metaPathE, JSON.stringify(metaE));
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 5000 });
    await page.waitForFunction(() => /正在分析证据/.test(document.querySelector('#ed-pane-review').textContent), { timeout: 6000 });
    // 武装路由：下一次 GET /job/changes 直接 abort（模拟瞬时失败），其后放行
    let aborted = false;
    await page.route('**/job/changes*', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      if (!aborted) { aborted = true; return route.abort(); }
      return route.continue();
    });
    // 任务收尾（running→done）：只有轮询链在失败后仍自续，面板才能拉到「已生成」
    const metaE2 = JSON.parse(fs.readFileSync(metaPathE, 'utf8'));
    metaE2[JOB_DOC].job.genTasks.evidence = { taskId: null, status: 'done', startedAt: null, baseHash: null, error: null, scope: null };
    fs.writeFileSync(metaPathE, JSON.stringify(metaE2));
    await page.waitForFunction(() => /已生成/.test(document.querySelector('#ed-pane-review').textContent), { timeout: 10000 });
    ok('[S4a-T7] 轮询链瞬时 GET 失败后续排（不卡死 UI）');
    await ctx.close();
  }

  // ===== 4f [S4a-T8] JSON 保存协议端到端：待比较确认门 → 接受 → 撤回 → 旧接受重试只回执不重放 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    // 夹具重置：第 4 段接受过 bt1/bt2 → 恢复 pending+原文+无隐藏类（4f 需要原始待处理态）
    {
      const metaR = JSON.parse(fs.readFileSync(path.join(dataRoot, 'docs-meta.json'), 'utf8'));
      for (const id of ['bt1', 'bt2']) {
        const c = metaR[JOB_DOC].job.changes.find((x) => x.id === id);
        c.status = 'pending'; delete c.acceptedAt; delete c.origText; delete c.appliedText;
      }
      fs.writeFileSync(path.join(dataRoot, 'docs-meta.json'), JSON.stringify(metaR));
      let html = fs.readFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), 'utf8');
      html = html.replaceAll('新项目描述（定制）', '旧项目描述').replaceAll(' ed-entry-hidden', '');
      fs.writeFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), html);
    }
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 5000 });
    // 4c 曾持久化 reviewPos.section=evidence → 先切回修改清单段（reviewPos POST 走 /job/changes，不经 /save 路由）
    await page.click('#ed-pane-review .jp-secs button[data-sec="changes"]');
    await page.waitForTimeout(400);
    // bt1 带 zid + 过期 baseSnapshot → 应在「待比较」组并标注
    const cmpTxt = await page.evaluate(() => document.querySelector('#ed-pane-review').textContent);
    if (!/待比较（正文已变化，需确认）/.test(cmpTxt) || !/待比较（正文已变化）/.test(cmpTxt)) bad('[S4a-T8] bt1 应进待比较组并带标注: ' + cmpTxt.slice(0, 150));
    else ok('[S4a-T8] needs-compare 候选进待比较组（含标注）');
    // 拦截 /save：JSON（op 保存）放行并记录请求体；旧路径（autosave text/html）abort——避免 rev 竞态
    const saveBodies = [];
    await page.route('**/save?**', (route) => {
      const ct = (route.request().headers()['content-type'] || '');
      if (ct.includes('application/json')) { saveBodies.push(route.request().postData()); return route.continue(); }
      return route.abort();
    });
    const bt1Acc = '#ed-pane-review [data-change="bt1"] button.jp-accept';
    // 第一次点接受 → 确认门展开（当前正文 vs 候选）；取消 → 关闭不保存
    await page.click(bt1Acc);
    await page.waitForSelector('#ed-pane-review [data-change="bt1"] .jp-gate', { timeout: 3000 });
    const gateTxt = await page.evaluate(() => document.querySelector('#ed-pane-review [data-change="bt1"] .jp-gate').textContent);
    if (!/当前正文/.test(gateTxt) || !/旧项目描述/.test(gateTxt) || !/新项目描述（定制）/.test(gateTxt)) bad('[S4a-T8] 确认门应展示当前正文 vs 候选: ' + gateTxt.slice(0, 140));
    else ok('[S4a-T8] 待比较确认门（当前正文 vs 候选差异）');
    await page.click('#ed-pane-review [data-change="bt1"] .jp-gate button:nth-of-type(2)');
    if (await page.$('#ed-pane-review [data-change="bt1"] .jp-gate')) bad('[S4a-T8] 取消应关闭确认门');
    else ok('[S4a-T8] 确认门可取消（不触发保存）');
    // 确认接受 → op 随 JSON 保存同事务落账（无独立状态请求）→ 面板刷新为已接受
    await page.click(bt1Acc);
    await page.click('#ed-pane-review [data-change="bt1"] .jp-gate button.jp-accept');
    await page.waitForFunction(() => /已接受/.test(document.querySelector('#ed-pane-review [data-change="bt1"]').textContent), { timeout: 6000 });
    ok('[S4a-T8] 接受经 JSON 保存协议同事务落账（确认门→应用→刷新）');
    if (saveBodies.length !== 1) bad('[S4a-T8] 应恰一次 JSON 保存请求（得 ' + saveBodies.length + '）');
    const accBody = JSON.parse(saveBodies[0] || '{}');
    if (accBody.ops && accBody.ops[0].action === 'accept' && accBody.ops[0].changeId === 'bt1'
      && accBody.ops[0].origText === '旧项目描述' && typeof accBody.baseRev === 'number' && typeof accBody.html === 'string') {
      ok('[S4a-T8] 保存载荷形状 {requestId, baseRev, html, ops[accept+origText]}（UI 无独立状态请求）');
    } else bad('[S4a-T8] 保存载荷形状不符: ' + (saveBodies[0] || '').slice(0, 160));
    // 服务端状态：accepted + origText/appliedText 快照
    let srv = await page.evaluate(async () => (await (await fetch('/job/changes?id=' + location.search.match(/[?&]id=([^&]+)/)[1])).json()));
    let bt1 = srv.job.changes.find((c) => c.id === 'bt1');
    if (bt1.status !== 'accepted' || bt1.origText !== '旧项目描述' || bt1.appliedText !== '新项目描述（定制）' || !bt1.acceptedAt) bad('[S4a-T8] 服务端接受态/快照不符: ' + JSON.stringify(bt1));
    else ok('[S4a-T8] 服务端 accepted+origText/appliedText 快照落账');
    const revAfterAcc = srv.rev;
    // 撤回 → pending + 快照清空
    await page.click('#ed-pane-review [data-change="bt1"] .jp-ops button');
    await page.waitForFunction(() => /待处理/.test(document.querySelector('#ed-pane-review [data-change="bt1"]').textContent), { timeout: 6000 });
    srv = await page.evaluate(async () => (await (await fetch('/job/changes?id=' + location.search.match(/[?&]id=([^&]+)/)[1])).json()));
    bt1 = srv.job.changes.find((c) => c.id === 'bt1');
    if (bt1.status !== 'pending' || bt1.origText !== undefined || bt1.appliedText !== undefined || bt1.acceptedAt !== undefined) bad('[S4a-T8] 撤回后应 pending+清快照: ' + JSON.stringify(bt1));
    else ok('[S4a-T8] 撤回 → pending+清空快照（同事务）');
    const revAfterRevert = srv.rev;
    // 核心反例：旧接受请求原样重试 → 只回执不重放（正文与状态保持撤回后）
    const replay = await page.evaluate(async (body) => {
      const r = await fetch('/save?id=' + location.search.match(/[?&]id=([^&]+)/)[1], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    }, saveBodies[0]);
    if (replay.status !== 200 || replay.data.deduped !== true) bad('[S4a-T8] 旧接受重试应 200 deduped: ' + JSON.stringify(replay.data).slice(0, 120));
    else ok('[S4a-T8] 旧接受重试命中回执（deduped，不重放）');
    srv = await page.evaluate(async () => (await (await fetch('/job/changes?id=' + location.search.match(/[?&]id=([^&]+)/)[1])).json()));
    bt1 = srv.job.changes.find((c) => c.id === 'bt1');
    if (bt1.status !== 'pending' || srv.rev !== revAfterRevert) bad('[S4a-T8] 重放后状态/rev 必须保持撤回后: ' + JSON.stringify({ s: bt1.status, rev: srv.rev }));
    else ok('[S4a-T8] 重放零副作用（状态 pending、rev 不变、正文保持撤回后）');
    if (revAfterAcc !== revAfterRevert - 1) bad('[S4a-T8] 每次保存应 rev+1（acc=' + revAfterAcc + ' revert=' + revAfterRevert + '）');
    // locked-now：锁定 bt2 锚点条目头 → 重载后按钮禁用 + 标注
    const metaPathF = path.join(dataRoot, 'docs-meta.json');
    const metaF = JSON.parse(fs.readFileSync(metaPathF, 'utf8'));
    metaF[JOB_DOC].zones.za7b8c9d0.locked = true;
    fs.writeFileSync(metaPathF, JSON.stringify(metaF));
    await page.reload();
    await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 5000 });
    await page.waitForTimeout(500);
    const bt2State = await page.evaluate(() => {
      const el = document.querySelector('#ed-pane-review [data-change="bt2"]');
      return el ? { txt: el.textContent, hasAcc: !!el.querySelector('button.jp-accept') } : null;
    });
    if (!bt2State || !/该段已锁定/.test(bt2State.txt) || bt2State.hasAcc) bad('[S4a-T8] locked-now 候选应标注已锁定且无接受按钮: ' + JSON.stringify(bt2State));
    else ok('[S4a-T8] locked-now：标注+接受按钮禁用（生成后加锁拦旧候选）');
    await ctx.close();
  }

  // ===== 4g [S4a-T9] 审阅升级：筛选 / j-k / 拒绝 chips / 保留当前版本 / 撤回前置 / 主操作 / ≥1440 并排 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } });   // ≥1440：并排对照生效
    const page = await ctx.newPage();
    // 夹具重置：4f 结束时 bt2 锚点被锁定 → 解锁；bt1/bt2 保持 pending
    const metaPathG = path.join(dataRoot, 'docs-meta.json');
    const metaG = JSON.parse(fs.readFileSync(metaPathG, 'utf8'));
    metaG[JOB_DOC].zones.za7b8c9d0.locked = false;
    for (const id of ['bt1', 'bt2']) {
      const c = metaG[JOB_DOC].job.changes.find((x) => x.id === id);
      c.status = 'pending'; delete c.acceptedAt; delete c.origText; delete c.appliedText;
    }
    fs.writeFileSync(metaPathG, JSON.stringify(metaG));
    let htmlG = fs.readFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), 'utf8');
    htmlG = htmlG.replaceAll('新项目描述（定制）', '旧项目描述').replaceAll(' ed-entry-hidden', '');
    fs.writeFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), htmlG);
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('#ed-pane-review .jp-secs', { timeout: 5000 });
    await page.click('#ed-pane-review .jp-secs button[data-sec="changes"]');
    await page.waitForSelector('#ed-pane-review [data-change="bt1"]', { timeout: 5000 });
    // 筛选：仅重点 → bt1（normal，在待比较组）不再渲染；全部 → 恢复
    await page.click('#ed-pane-review .jp-filter button:nth-of-type(2)');
    await page.waitForTimeout(200);
    if (await page.$('#ed-pane-review [data-change="bt1"]')) bad('[S4a-T9] 仅重点筛选后 normal 候选不应渲染');
    else ok('[S4a-T9] 筛选「仅重点」生效');
    await page.click('#ed-pane-review .jp-filter button:nth-of-type(1)');
    await page.waitForSelector('#ed-pane-review [data-change="bt1"]', { timeout: 5000 });
    ok('[S4a-T9] 筛选「全部」恢复');
    // 主操作流转：有 pending → 橙色主操作为「接受」（至多一个橙色）
    const foot = await page.evaluate(() => {
      const f = document.querySelector('#ed-pane-review .jp-foot');
      return f ? { primary: (f.querySelector('.jp-primary') || {}).textContent || '', n: f.querySelectorAll('.jp-primary').length } : null;
    });
    if (!foot || foot.primary !== '接受' || foot.n !== 1) bad('[S4a-T9] 主操作流转应为唯一橙色「接受」: ' + JSON.stringify(foot));
    else ok('[S4a-T9] 主操作流转（pending→接受，唯一橙色）');
    // j/k 上下条
    await page.keyboard.press('j');
    await page.waitForTimeout(200);
    if (!(await page.$('#ed-pane-review .jp-item.jp-active'))) bad('[S4a-T9] j 应激活下一条候选');
    else ok('[S4a-T9] j/k 上下条激活候选');
    // 拒绝原因 chips → rejected + note + job.feedback
    await page.click('#ed-pane-review [data-change="bt1"] button:has-text("跳过…")');
    await page.waitForSelector('#ed-pane-review [data-change="bt1"] .jp-chips', { timeout: 3000 });
    await page.click('#ed-pane-review [data-change="bt1"] .jp-chips button:has-text("改变原意")');
    await page.waitForFunction(() => /已跳过/.test((document.querySelector('#ed-pane-review [data-change="bt1"]') || document.createElement('div')).textContent || ''), { timeout: 6000 });
    const fb = await page.evaluate(async () => {
      const d = await (await fetch('/job/changes?id=' + location.search.match(/[?&]id=([^&]+)/)[1])).json();
      return { f: d.job.feedback || [], bt1: d.job.changes.find((c) => c.id === 'bt1') };
    });
    if (!fb.f.includes('改变原意') || fb.bt1.status !== 'rejected' || fb.bt1.note !== '改变原意') bad('[S4a-T9] 拒绝原因应进 rejected.note 与 job.feedback: ' + JSON.stringify(fb));
    else ok('[S4a-T9] 拒绝原因 chips → note + job.feedback');
    await page.click('#ed-pane-review [data-change="bt1"] button:has-text("重新接受")');
    await page.waitForFunction(() => /待处理/.test((document.querySelector('#ed-pane-review [data-change="bt1"]') || document.createElement('div')).textContent || ''), { timeout: 6000 });
    // 「保留当前版本」：needs-compare 候选 → resolved 且退出待核对
    await page.click('#ed-pane-review [data-change="bt1"] button:has-text("保留当前版本")');
    await page.waitForFunction(() => /已处理/.test((document.querySelector('#ed-pane-review [data-change="bt1"]') || document.createElement('div')).textContent || ''), { timeout: 6000 });
    const rv = await page.evaluate(async () => {
      const d = await (await fetch('/job/changes?id=' + location.search.match(/[?&]id=([^&]+)/)[1])).json();
      const c = d.job.changes.find((x) => x.id === 'bt1');
      return { st: c.status, res: c.resolvedText, cons: c.consistency };
    });
    if (rv.st !== 'resolved' || !/旧项目描述/.test(String(rv.res)) || (rv.cons || []).includes('needs-compare')) bad('[S4a-T9] 保留当前版本应 resolved+退出待核对: ' + JSON.stringify(rv));
    else ok('[S4a-T9] 保留当前版本（resolvedText 绑定，退出待核对）');
    // 撤回前置：bt2 接受后手改条目头 → 撤回弹确认 → 接受确认后撤回成功
    page.on('dialog', (d) => d.accept());
    await page.click('#ed-pane-review [data-change="bt2"] button.jp-accept');
    await page.waitForFunction(() => /已接受/.test((document.querySelector('#ed-pane-review [data-change="bt2"]') || document.createElement('div')).textContent || ''), { timeout: 6000 });
    await page.evaluate(() => { const el = document.querySelector('[data-zid="za7b8c9d0"] .entry-date'); if (el) el.textContent = '2022'; });
    await page.evaluate(() => window.__edSaveManual());                            // 手改落盘（撤回锚点与服务端一致的前提）
    await page.evaluate(() => window.dispatchEvent(new Event('ed-review-refresh'))); // 刷新 docRev 基线
    await page.waitForTimeout(400);
    await page.click('#ed-pane-review [data-change="bt2"] button:has-text("撤回这条建议")');
    await page.waitForFunction(() => /待处理/.test((document.querySelector('#ed-pane-review [data-change="bt2"]') || document.createElement('div')).textContent || ''), { timeout: 6000 });
    ok('[S4a-T9] 撤回前置拦截（手改后要求确认）+ 撤回回 pending');
    // ≥1440 并排对照
    const grid = await page.evaluate(() => {
      const cmp = document.querySelector('#ed-pane-review .jp-cmp');
      return cmp ? getComputedStyle(cmp).display : 'missing';
    });
    if (grid !== 'grid') bad('[S4a-T9] ≥1440 对照应并排（grid），得 ' + grid);
    else ok('[S4a-T9] ≥1440 原文/候选并排对照');
    await ctx.close();
    // 1280-1439 宽度档：审阅活跃保右栏；切到 AI 助手（非活跃）→ 自动折叠；切回 → 恢复
    const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const page2 = await ctx2.newPage();
    await page2.goto(base + '/edit?id=' + JOB_DOC);
    await page2.waitForSelector('#ed-pane-review .jp-item', { timeout: 5000 });
    await page2.waitForTimeout(300);
    const activeOpen = await page2.evaluate(() => !document.getElementById('ed-right').classList.contains('ed-hidden'));
    if (!activeOpen) bad('[S4a-T9] 1280 档审阅活跃应保右栏');
    else ok('[S4a-T9] 1280-1439 审阅活跃保右栏');
    await page2.evaluate(() => window.__edSelectTab('ai'));
    await page2.waitForTimeout(200);
    const strip = await page2.evaluate(() => {
      const btn = document.querySelector('#ed-rtabs button[data-pane="zone"]');
      const r = btn ? btn.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        hidden: document.getElementById('ed-right').classList.contains('ed-hidden'),
        strip: document.body.classList.contains('ed-tier-strip'),
        tabVisible: r.width > 0 && r.height > 0,
        w: getComputedStyle(document.body).getPropertyValue('--ed-right-w').trim()
      };
    });
    // 折成竖标签条，不是整条藏起来：藏起来的话区域/AI/排版三个页签彻底点不到（2026-10-22 审查 [高]）
    if (!strip.strip || strip.hidden) bad('[S4a-T9] 1280 档非活跃应折叠为竖标签条: ' + JSON.stringify(strip));
    else if (!strip.tabVisible) bad('[S4a-T9] 竖标签条的页签不可见（区域/AI/排版切不到）: ' + JSON.stringify(strip));
    else ok('[S4a-T9] 1280-1439 非活跃折叠为竖标签条（页签仍可点）');
    await page2.evaluate(() => window.__edSelectTab('review'));
    await page2.waitForTimeout(200);
    const reOpen = await page2.evaluate(() => !document.getElementById('ed-right').classList.contains('ed-hidden'));
    if (!reOpen) bad('[S4a-T9] 切回审阅应恢复右栏');
    else ok('[S4a-T9] 切回审阅恢复右栏');
    await ctx2.close();
  }

  // ===== 4g /edit 的 CSP：文档正文里的外来内联脚本不得在应用同源执行 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=ed-evil');
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => ({ pwned: window.__PWNED === 1, sheet: !!document.querySelector('.sheet') }));
    if (r.pwned) bad('[CSP] 文档正文里的外来内联脚本被执行了（应用同源 XSS）');
    else if (!r.sheet) bad('[CSP] CSP 误伤了编辑器（正文都没了）');
    else ok('[CSP] 外来内联脚本被 CSP 挡住，编辑器仍可用');
    await ctx.close();
  }

  // ===== 4h [S4a-T11] 组件与布局：⋯ 菜单键盘化 / favicon / 素材保存失败保留输入 / 事实层默认展开 =====
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + ED_DOC);
    await page.waitForSelector('#ed-navlist .ed-nav-entry', { timeout: 5000 });
    // ⋯ 菜单键盘可达：Enter 展开 → 方向键导航 → Esc 关闭回 ⋯
    await page.focus('#ed-navlist .ed-nav-more');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#ed-navlist .ed-nav-menu:not([hidden])', { timeout: 3000 });
    ok('[S4a-T11] ⋯ 菜单 Enter 展开（aria-haspopup/expanded）');
    await page.keyboard.press('ArrowDown');
    const f1 = await page.evaluate(() => (document.activeElement || {}).textContent || '');
    await page.keyboard.press('ArrowDown');
    const f2 = await page.evaluate(() => (document.activeElement || {}).textContent || '');
    if (!f1 || f1 === f2) bad('[S4a-T11] ⋯ 菜单方向键导航未移动焦点: ' + f1 + '→' + f2);
    else ok('[S4a-T11] ⋯ 菜单方向键导航（' + f1.trim() + '→' + f2.trim() + '）');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const escState = await page.evaluate(() => ({
      closed: document.querySelector('#ed-navlist .ed-nav-menu').hidden,
      back: (document.activeElement || {}).className === 'ed-nav-more'
    }));
    if (!escState.closed || !escState.back) bad('[S4a-T11] Esc 应关闭菜单并回焦 ⋯: ' + JSON.stringify(escState));
    else ok('[S4a-T11] ⋯ 菜单 Esc 关闭 + 焦点返回');
    const fav = await page.evaluate(async () => { const r = await fetch('/favicon.ico'); return { s: r.status, t: r.headers.get('content-type') || '' }; });
    if (fav.s !== 200 || !fav.t.includes('svg')) bad('[S4a-T11] favicon 应 200 svg: ' + JSON.stringify(fav));
    else ok('[S4a-T11] favicon 路由（svg）');
    await ctx.close();
    // 素材保存失败保留输入 + 事实层默认展开 + 范围文案
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(base + '/materials');
    await page2.waitForSelector('#matForm', { state: 'attached', timeout: 5000 });
    await page2.evaluate(() => { const d = document.querySelector('details:has(#matForm)'); if (d) d.open = true; });   // ＋新增素材 details 展开
    await page2.waitForSelector('#matForm', { timeout: 5000 });
    const factsOpen = await page2.evaluate(() => { const d = document.querySelector('.mat-card details'); return d ? d.open : null; });
    if (factsOpen !== true) bad('[S4a-T11] 事实层应默认展开: ' + factsOpen);
    else ok('[S4a-T11] 事实层默认展开');
    const scopeOk = await page2.evaluate(() => (typeof matConfirmAll === 'function') && matConfirmAll.toString().includes('待确认素材标记为已确认'));
    if (!scopeOk) bad('[S4a-T11] 全部确认文案未明示范围（待确认素材）');
    else ok('[S4a-T11] 全部确认范围文案（仅待确认素材）');
    await page2.fill('#mtitle', 'T11素材');
    await page2.fill('#mbrief', 'T11 表达');
    await page2.route('**/mat/add', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }));
    await page2.click('#matForm button');
    await page2.waitForFunction(() => /保存失败|❌/.test((document.getElementById('matmsg') || {}).textContent || ''), { timeout: 4000 });
    const kept = await page2.evaluate(() => ({ t: document.getElementById('mtitle').value, b: document.getElementById('mbrief').value }));
    if (kept.t !== 'T11素材' || kept.b !== 'T11 表达') bad('[S4a-T11] 保存失败应保留输入: ' + JSON.stringify(kept));
    else ok('[S4a-T11] 素材保存失败保留输入 + 错误可见');
    await ctx2.close();
  }

  // ===== 5. 导航无障碍与交互细节 =====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    // E3 夹具：带唯一标签的合成素材（弹层重点 chips = __MATS__ tags 客户端聚合，唯一标签让断言不受其他素材干扰）
    const matsE3Path = path.join(dataRoot, 'materials.json');
    const matsE3 = JSON.parse(fs.readFileSync(matsE3Path, 'utf8'));
    matsE3.push({ id: 'm-e3', title: 'E3素材', factStatus: 'confirmed', tags: ['E3-定制重点', 'E3-次要标签'], facts: { company: '', role: '', dates: '', education: '', metrics: '', contribution: '', conditions: '', source: '' } });
    fs.writeFileSync(matsE3Path, JSON.stringify(matsE3));
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
    // ===== E3（岗位弹层定制要求）：折叠区字段 + 提交载荷与首页 briefFromForm 同形状 =====
    const briefDom = await page.evaluate(() => {
      const det = document.querySelector('#ed-jobpop details');
      if (!det) return { det: false };
      const degDef = det.querySelector('button[data-deg][aria-pressed="true"]');
      const pgDef = det.querySelector('button[data-pages][aria-pressed="true"]');
      return {
        det: true,
        summary: (det.querySelector('summary') || {}).textContent || '',
        textareas: det.querySelectorAll('textarea').length,
        degBtns: det.querySelectorAll('button[data-deg]').length,
        pageBtns: det.querySelectorAll('button[data-pages]').length,
        degPressed: det.querySelectorAll('button[data-deg][aria-pressed="true"]').length,
        pgPressed: det.querySelectorAll('button[data-pages][aria-pressed="true"]').length,
        degDefault: degDef ? degDef.getAttribute('data-deg') : null,
        pgDefault: pgDef ? pgDef.getAttribute('data-pages') : null,
        chip: !!det.querySelector('.ed-jp-chips button[data-tag="E3-定制重点"]')
      };
    });
    if (!briefDom.det || !briefDom.summary.includes('本次定制要求')) bad('E3 弹层缺「本次定制要求」折叠 details：' + JSON.stringify(briefDom.summary || ''));
    else if (briefDom.textareas !== 2) bad('E3 定制要求区应有 2 个 textarea（必须保留/不强调）：' + briefDom.textareas);
    else if (!briefDom.chip) bad('E3 重点 chips 未按 __MATS__ tags 聚合渲染（缺 E3-定制重点）');
    else if (briefDom.degBtns !== 3 || briefDom.degPressed !== 1 || briefDom.degDefault !== 'refocus') bad('E3 幅度按钮组应 3 项且默认恰 1 个 aria-pressed=refocus：' + JSON.stringify({ n: briefDom.degBtns, p: briefDom.degPressed, d: briefDom.degDefault }));
    else if (briefDom.pageBtns !== 2 || briefDom.pgPressed !== 1 || briefDom.pgDefault !== '2') bad('E3 页数按钮组应 2 项且默认恰 1 个 aria-pressed=2：' + JSON.stringify({ n: briefDom.pageBtns, p: briefDom.pgPressed, d: briefDom.pgDefault }));
    else ok('E3 弹层定制要求区（details + 2 textarea + chips + 幅度3/页数2，默认 refocus/2）');
    // 提交载荷：route 捕获 /job/create（stub 响应，不真建草稿、不跳转）。
    // 守卫：折叠区缺失（如旧实现）时上面已记 bad，这里直接跳过 fill/click，避免等元素超时炸掉整套件。
    if (!briefDom.det) bad('E3 载荷阶段跳过（折叠区不存在）');
    else {
      let e3payload = null;
      await page.route('**/job/create', (route) => {
        try { e3payload = route.request().postDataJSON(); } catch (e) { e3payload = null; }
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'E3-stub' }) });
      });
      await page.fill('#ed-jobpop input[aria-label="公司"]', 'E3公司');
      await page.fill('#ed-jobpop input[aria-label="岗位"]', 'E3岗位');
      await page.click('#ed-jobpop details summary');   // 展开「本次定制要求」（折叠态里 textarea 不可见）
      await page.evaluate(() => { const c = document.querySelector('#ed-jobpop .ed-jp-chips button[data-tag="E3-定制重点"]'); if (c) c.click(); });
      await page.fill('#ed-jobpop textarea[aria-label="必须保留的项目"]', '项目X');
      await page.fill('#ed-jobpop textarea[aria-label="不希望强调"]', '旧技术栈');
      await page.click('#ed-jobpop .ed-jp-row .ed-primary');
      await page.waitForTimeout(400);
      await page.unroute('**/job/create');
      const e3keys = e3payload && e3payload.brief ? Object.keys(e3payload.brief).sort().join(',') : '';
      if (!e3payload || !e3payload.brief) bad('E3 /job/create 载荷缺 brief：' + JSON.stringify(e3payload).slice(0, 80));
      else if (e3keys !== 'deemphasize,degree,focus,keepProjects,pages') bad('E3 brief 五键不符：' + e3keys);
      else if (JSON.stringify(e3payload.brief.focus) !== JSON.stringify(['E3-定制重点'])) bad('E3 focus 未透传选中 chip：' + JSON.stringify(e3payload.brief.focus));
      else if ((e3payload.brief.keepProjects || []).join() !== '项目X' || (e3payload.brief.deemphasize || []).join() !== '旧技术栈') bad('E3 保留/不强调未透传：' + JSON.stringify(e3payload.brief.keepProjects) + '/' + JSON.stringify(e3payload.brief.deemphasize));
      else if (e3payload.brief.degree !== 'refocus' || e3payload.brief.pages !== 2) bad('E3 幅度/页数默认不符：' + JSON.stringify({ d: e3payload.brief.degree, p: e3payload.brief.pages }));
      else ok('E3 /job/create 载荷 brief 五键齐且值透传（degree=refocus/pages=2 默认）');
    }
    await page.keyboard.press('Escape');   // 关弹层（单层 Esc），让开 jobmask 遮罩再测排版面板
    // ===== E1/E2（排版监听器外提）：程序改写排版面板即时刷新 + 监听器不叠加 =====
    await page.click('#ed-rtabs button[data-pane="typo"]');
    await page.waitForSelector('#ed-pane-typo .ed-typo');
    await page.evaluate(() => window.__edSetTypo('/*TYPO-E1*/body{font-size:14.5px;line-height:1.6}.sheet{padding-top:8.2mm;padding-bottom:8.2mm}.plain-lines p{margin-bottom:0.8mm}li{margin-top:0.8mm;margin-bottom:0.8mm}.section{margin-top:4.2mm}'));
    const e1 = await page.evaluate(() => ({
      range: (document.getElementById('ed-typo-fontSize') || {}).value || null,
      num: (document.getElementById('ed-typo-num-fontSize') || {}).value || null
    }));
    if (e1.range !== '14.5' || e1.num !== '14.5') bad('E1 程序改写排版（__edSetTypo 派发 ed-typo）面板滑杆未刷新：' + JSON.stringify(e1));
    else ok('E1 __edSetTypo 后排版面板滑杆/数值即时刷新');
    const e2 = await page.evaluate(() => {
      const pane = document.getElementById('ed-pane-typo');
      const btn = pane.querySelector('.ed-reset');
      btn.click(); btn.click();                       // 连续两次「恢复默认排版」
      const obs = new MutationObserver(() => {});
      obs.observe(pane, { childList: true });
      window.dispatchEvent(new Event('ed-typo'));     // 再派发一次 → 面板应恰重建一次
      const rebuilds = obs.takeRecords().filter((r) => r.addedNodes.length > 0).length;
      obs.disconnect();
      return { rebuilds: rebuilds, slider: (document.getElementById('ed-typo-fontSize') || {}).value || null };
    });
    if (e2.rebuilds !== 1) bad('E2 连续两次恢复默认后派发一次 ed-typo，面板重建 ' + e2.rebuilds + ' 次（监听器叠加）');
    else if (e2.slider !== '13') bad('E2 恢复默认后滑杆应回默认 13：' + e2.slider);
    else ok('E2 排版监听器全局恰一次（两次恢复默认后仍只重建一次，滑杆回默认）');
    await ctx.close();
  }

  // 6) 冻结件不变性（稳态下只打开+保存 → 字节与渲染标识全不变）；外壳跨文档一致；注入层不碰正文
  {
  const ctx6 = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
  const page = await ctx6.newPage();
  const sha1 = (s) => createHash('sha1').update(s).digest('hex');
  const docFile = path.join(dataRoot, 'docs', ED_DOC + '.html');
  const metaFile = path.join(dataRoot, 'docs-meta.json');
  const readMeta = () => (JSON.parse(fs.readFileSync(metaFile, 'utf8'))[ED_DOC] || {});
  const saveOnce = async () => {
    await page.click('#saveBtn');
    await page.waitForFunction(() => (document.getElementById('saveState') || {}).dataset?.state === 'saved', { timeout: 10000 });
  };
  await page.goto(`${base}/edit?id=${ED_DOC}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.ed-on');
  // 6a 外壳一致性采样（本文档）
  const shellSample = (pg = page) => pg.evaluate(() => {
    const pick = (sel, props) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el); const o = {};
      props.forEach((k) => { o[k] = cs[k]; });
      return o;
    };
    return {
      toolbar: pick('.edit-toolbar', ['backgroundColor', 'color', 'borderRadius', 'fontFamily']),
      btn: pick('.edit-toolbar button', ['backgroundColor', 'color']),
      state: pick('.save-state', ['color', 'backgroundColor']),
      status: pick('#ed-status', ['backgroundColor', 'color'])
    };
  });
  const sA = await shellSample();
  // 6b 正文保护：拆掉注入样式后 .sheet 计算样式必须逐项相同
  const contentProps = ['color', 'fontFamily', 'fontSize', 'lineHeight', 'marginTop', 'marginBottom', 'paddingLeft'];
  const contentSample = () => page.evaluate((props) => {
    const out = {};
    ['.sheet h1', '.sheet p', '.sheet li'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (!el) { out[sel] = null; return; }
      const cs = getComputedStyle(el); const o = {};
      props.forEach((k) => { o[k] = cs[k]; });
      out[sel] = o;
    });
    return out;
  }, contentProps);
  const cWith = await contentSample();
  await page.evaluate(() => { document.querySelector('style[data-ed-shell]').remove(); });
  const cWithout = await contentSample();
  if (JSON.stringify(cWith) !== JSON.stringify(cWithout)) {
    bad('注入层改变了 .sheet 正文计算样式', JSON.stringify({ cWith, cWithout }).slice(0, 400));
  } else ok('注入层不影响简历正文计算样式');
  // 6c 冻结件不变性：先做一次"规范化保存"（legacy 内联 typo 首次会迁到 meta，属既有 S1 语义），
  //    再以稳态为基线，只打开+保存第二次 → 字节与标识必须完全不变
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.ed-on');
  await saveOnce();
  const h0 = sha1(fs.readFileSync(docFile, 'utf8'));
  const m0 = readMeta();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.ed-on');
  await saveOnce();
  const h1v = sha1(fs.readFileSync(docFile, 'utf8'));
  const m1v = readMeta();
  if (h0 !== h1v) bad('稳态下只打开并保存导致文档字节变化（冻结件被动漂移）');
  else ok('稳态下只打开并保存：文档字节未变');
  if (m0.styleHash !== m1v.styleHash || m0.renderInputId !== m1v.renderInputId) {
    bad(`渲染标识漂移 styleHash ${m0.styleHash}->${m1v.styleHash} renderInputId ${m0.renderInputId}->${m1v.renderInputId}`);
  } else ok('styleHash / renderInputId 未漂移');
  // 6d 外壳跨文档一致 + 覆盖优先级（两侧证据）：legacy 夹具的**文档内联 chrome 故意改成另一代取值**
  //    （冷灰蓝实心底 / 方角 / 不同按钮底色 / 不同 save-state 配色，全部假数据），使得
  //      (i)  拆掉 style[data-ed-shell] 后，两份文档的采样值必然不同（legacy 逐项回到它自己写的内联值）；
  //      (ii) 注入层在场时两份文档逐项相同（sA === sB）——即 .ed-on 特异性真的压过了分叉的文档内联 chrome。
  //    另需证明"只是渲染期覆盖、文档字节没被改写"：内联 <style id="legacy-chrome"> 原文仍在页面里，
  //    且磁盘夹具 sha1 打开前后一致。
  //    夹具形态（去 data-theme + 内联 typo-custom + meta theme:'legacy'）仍照 test-structure.sh:1449-1454；
  //    txDoc 无工具栏 chrome、采样必为 null，故用 assembleTemplate 装配形态。
  const LEGACY_DOC = 'ed-legacy-fixture';
  const L_TB_BG = '#E7EAF0', L_TB_INK = '#0B1B33', L_TB_LINE = '#B9BEC9', L_RADIUS = '2px';
  const L_BTN_BG = '#3D4A63', L_BTN_INK = '#F2F4F8';
  const L_OK_INK = '#0B3D2A', L_OK_BG = '#BFE3C9';
  const rgbOf = (h) => 'rgb(' + [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
  // 只扰动注入层确实覆盖的属性（.ed-on .edit-toolbar / .ed-on .edit-toolbar button / .ed-on …[data-state]），
  // 否则 sA===sB 会因为"注入层压根没管这项"而假绿或假红。
  const LEGACY_CHROME = '<style id="legacy-chrome">'
    + `.edit-toolbar{background:${L_TB_BG};color:${L_TB_INK};border:1px solid ${L_TB_LINE};border-radius:${L_RADIUS}}`
    + `.edit-toolbar button,.edit-toolbar button.secondary{background:${L_BTN_BG};color:${L_BTN_INK};border-radius:${L_RADIUS}}`
    + `.save-state[data-state="saved"]{color:${L_OK_INK};background:${L_OK_BG}}`
    + '.save-state[data-state="dirty"]{color:#4A3000;background:#EFD9A0}'
    + '.save-state[data-state="saving"]{color:#0A2A5E;background:#C3D4F2}'
    + '.save-state[data-state="error"]{color:#5A0B0B;background:#F0C4C4}'
    + '</style>';
  const legacyFile = path.join(dataRoot, 'docs', LEGACY_DOC + '.html');
  {
    let tpl = assembleTemplate('classic');
    tpl = tpl.replaceAll('{{NAME}}', () => '遗留测试员').replaceAll('{{CONTACT}}', () => 'legacy@example.com')
      .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
      .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => '').replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => LEGACY_DOC);
    const legacyHtml = tpl
      .replace('<style data-theme="classic">', '<style>')
      .replace('</head>', '<style id="typo-custom">.sheet p{letter-spacing:0.02em}</style>\n' + LEGACY_CHROME + '\n</head>');
    fs.writeFileSync(legacyFile, legacyHtml);
    const meta6 = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta6[LEGACY_DOC] = { theme: 'legacy' };
    fs.writeFileSync(metaFile, JSON.stringify(meta6));
  }
  const legacySha0 = sha1(fs.readFileSync(legacyFile, 'utf8'));
  const pageB = await ctx6.newPage();
  await pageB.goto(`${base}/edit?id=${LEGACY_DOC}`, { waitUntil: 'networkidle' });
  await pageB.waitForSelector('body.ed-on');
  const sB = await shellSample(pageB);
  // (ii) 注入层在场：两份文档外壳逐项相同（此时 legacy 的内联 chrome 与 classic 已分叉）
  if (JSON.stringify(sA) !== JSON.stringify(sB)) bad('外壳样式跨文档不一致（classic vs 差异化 chrome 的 legacy 夹具）', JSON.stringify({ sA, sB }).slice(0, 600));
  else ok('外壳计算样式跨文档逐项一致（legacy 内联 chrome 已分叉仍被统一）');
  // 文档字节未被改写：内联 legacy-chrome 原文仍在页面中，磁盘夹具 sha1 未变
  const inlineChrome = await pageB.evaluate(() => (document.querySelector('#legacy-chrome') || {}).textContent || '');
  if (!inlineChrome.includes(L_TB_BG) || !inlineChrome.includes(L_RADIUS) || !inlineChrome.includes(L_BTN_BG) || !inlineChrome.includes(L_OK_BG)) {
    bad('legacy 夹具的内联 chrome 在页面里被改写了（应只在渲染期被覆盖，不得改写文档）', inlineChrome.slice(0, 200));
  } else ok('文档自身内联 chrome 原文仍在页面中（渲染期覆盖，未改写文档）');
  const legacySha1v = sha1(fs.readFileSync(legacyFile, 'utf8'));
  if (legacySha1v !== legacySha0) bad('legacy 夹具磁盘字节在打开后变化（serve 改写了冻结件）');
  else ok(`legacy 夹具磁盘字节打开前后一致（sha1 ${legacySha0.slice(0, 8)}）`);
  // (i) 拆掉注入层：两份文档必然不同，且 legacy 逐项回到自身内联 chrome
  await pageB.evaluate(() => { document.querySelector('style[data-ed-shell]').remove(); });
  const sBbare = await shellSample(pageB);
  await page.evaluate(() => { const s = document.querySelector('style[data-ed-shell]'); if (s) s.remove(); });
  const sAbare = await shellSample(page);
  const probe = [
    ['toolbar.backgroundColor', sA.toolbar?.backgroundColor, sB.toolbar?.backgroundColor, sBbare.toolbar?.backgroundColor, rgbOf(L_TB_BG)],
    ['toolbar.color', sA.toolbar?.color, sB.toolbar?.color, sBbare.toolbar?.color, rgbOf(L_TB_INK)],
    ['toolbar.borderRadius', sA.toolbar?.borderRadius, sB.toolbar?.borderRadius, sBbare.toolbar?.borderRadius, L_RADIUS],
    ['btn.backgroundColor', sA.btn?.backgroundColor, sB.btn?.backgroundColor, sBbare.btn?.backgroundColor, rgbOf(L_BTN_BG)],
    ['btn.color', sA.btn?.color, sB.btn?.color, sBbare.btn?.color, rgbOf(L_BTN_INK)],
    ['state.color', sA.state?.color, sB.state?.color, sBbare.state?.color, rgbOf(L_OK_INK)],
    ['state.backgroundColor', sA.state?.backgroundColor, sB.state?.backgroundColor, sBbare.state?.backgroundColor, rgbOf(L_OK_BG)]
  ];
  // 三向对照（uni/sA=注入层在场，bare=拆掉注入层，own=夹具自己写的内联值）：
  //   bare 必须等于 own   → 差异化确实被采样到（否则 6d 什么都没证明）
  //   uni 必须不等于 bare → .ed-on 覆盖真的改了渲染结果（注入层失效即红）
  //   sA 必须等于 uni     → 两份文档外壳统一
  const bareNotOwn = probe.filter(([, , , bare, own]) => bare !== own);
  const notOverridden = probe.filter(([, , uni, bare]) => uni === bare);
  const notUnified = probe.filter(([, a, b]) => a !== b);
  if (bareNotOwn.length) bad('拆掉注入层后 legacy 外壳未逐项回到自身内联 chrome（差异化没被测到）', JSON.stringify(bareNotOwn).slice(0, 500));
  else ok('拆掉注入层：legacy 外壳 7 项逐字回到自身内联 chrome（旧代际取值）');
  if (notOverridden.length) bad('.ed-on 覆盖未压过 legacy 的分叉内联 chrome（注入层失效或特异性不足）', JSON.stringify(notOverridden).slice(0, 500));
  else ok('加上注入层：同 7 项被 .ed-on 覆盖（与文档自身内联 chrome 全部不同）');
  if (notUnified.length) bad('注入层在场时两份文档外壳仍有差异（外壳未统一）', JSON.stringify(notUnified).slice(0, 500));
  else ok('加上注入层：classic 与 legacy 同 7 项逐项相同（外壳统一）');
  if (JSON.stringify(sAbare) === JSON.stringify(sBbare)) {
    bad('两份文档去掉注入层后仍完全相同 → 6d 没有差异化，证明不了覆盖优先级', JSON.stringify(sAbare).slice(0, 400));
  } else ok('去掉注入层：classic 与 legacy 外壳采样不同（文档自身 chrome 确实分叉）');
  await ctx6.close();
  }

  // 7) 看板：1440 宽下 6 列齐全且第 6 列不被截断；空列压缩不撑满（本块自成一个 { } 作用域 + 自开 ctx）
  {
  const ctx7 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const kbPage = await ctx7.newPage();
  await kbPage.goto(`${base}/applications`, { waitUntil: 'networkidle' });
  const kb = await kbPage.evaluate(() => {
    const el = document.querySelector('.kb');
    if (!el) return null;
    const cols = [...el.querySelectorAll('.kb-col')];
    const box = el.getBoundingClientRect();
    return {
      scrollW: el.scrollWidth, clientW: el.clientWidth, cols: cols.length,
      widths: cols.map((c) => Math.round(c.getBoundingClientRect().width)),
      heads: [...el.querySelectorAll('.group-head')].map((h) => h.textContent.trim()),
      lastVisible: cols.length ? (cols[cols.length - 1].getBoundingClientRect().right <= box.right + 1) : false
    };
  });
  if (!kb) bad('看板缺 .kb 容器');
  else {
    if (kb.cols !== 6) bad(`看板列数应为 6，实际 ${kb.cols}`); else ok('看板 6 列齐全');
    if (!kb.lastVisible) bad('看板第 6 列被截断（右边缘超出容器）'); else ok('看板第 6 列完整可见');
    if (kb.scrollW > kb.clientW + 1) bad(`看板仍需横向滚动 scrollW=${kb.scrollW} clientW=${kb.clientW}`); else ok('看板 1440 宽下无需横向滚动');
    const narrow = kb.widths.filter((w) => w < 130).length;
    if (narrow) ok(`空列已压缩（${narrow} 列宽 <130px）`);
    else if (kb.widths.every((w) => w >= 180)) ok('无空列（全部列宽 ≥180px）');
    else bad(`空列未压缩且列宽异常：${JSON.stringify(kb.widths)}`);
  }
  await ctx7.close();
  }

  // 8) 撤销语义（设计 §6.1 唯一口径）
  // 块 8-11 是一个连续场景，共用一个 { } 作用域与一个 ctx/page（约定见任务简报）。
  // [T5-ADJ] 标注处 = 与简报逐字代码的最小偏差，理由全部写入 task-5-report.md「简报偏差」节。
  {
   const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });   // 8f 撤销命中测试显式要求 1280×720
  const page = await ctx.newPage();
  const saveHits = [];                                   // 不引入生产钩子：用网络计数观察是否真的保存
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/save')) saveHits.push(r.url()); });
  // 有效夹具：两个 section，各带 entry-head + ul（保证导航积木的条目按钮可生成）
  // [T5-ADJ-1] <section> 补 class="section"：设计 §7.7 夹具纪律要求夹具"必须真的含 .section/.entry-head"，
  //   而 scanSections() 只认 .section（editor-shell.js:323）；简报原文的裸 <section> 会让导航进兼容模式、
  //   条目按钮为 0，本块自检（entryBtns≥6）与 8b-8d 全部失真。生产代码不为此改动。
  const FIX = '<section class="section"><h2>经历</h2><div class="entry-head">某公司 · 后端工程师</div>'
    + '<ul><li>负责<b>订单核心</b>服务</li><li>主导拆单重构</li></ul></section>'
    + '<section class="section"><h2>项目</h2><div class="entry-head">订单系统重构</div>'
    + '<ul><li>单体拆分与链路治理</li></ul></section>';
  await page.goto(`${base}/edit?id=${ED_DOC}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.ed-on');
  await page.evaluate((fix) => {
    const s = document.querySelector('.sheet');
    s.innerHTML = fix;
    s.dispatchEvent(new Event('input', { bubbles: true }));   // 合成：不算受信任输入
  }, FIX);
  // 夹具有效性自检：结构必须存在，否则本块后续断言全部无意义
  const fixtureOk = await page.evaluate(() => ({
    secs: document.querySelectorAll('.sheet section').length,
    heads: document.querySelectorAll('.sheet .entry-head').length,
    entryBtns: document.querySelectorAll('#ed-navlist button').length
  }));
  if (fixtureOk.secs !== 2 || fixtureOk.heads !== 2) bad(`夹具无效：section=${fixtureOk.secs} entry-head=${fixtureOk.heads}`);
  else if (fixtureOk.entryBtns < 6) bad(`夹具未生成条目操作按钮（实测 ${fixtureOk.entryBtns} 颗），后续撤销断言会失真`);
  else ok(`夹具有效：2 section / 2 entry-head / ${fixtureOk.entryBtns} 颗操作按钮`);

  // 8a 设计 §6.1 钉死的用例：输入 A → 加粗 A → 输入 B → 一次 ⌘Z ⇒ 撤销 B，A 与加粗保留
  await page.evaluate(() => {
    const li = document.querySelector('.sheet li');
    li.appendChild(document.createTextNode('AAA'));
    const r = document.createRange(); const tn = li.lastChild;
    r.setStart(tn, 0); r.setEnd(tn, 3);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    li.closest('.sheet').focus();
  });
  await page.click('[data-fmt="bold"]');
  const boldKeptA = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.sheet b')].find((x) => x.textContent === 'AAA');
    return !!b;
  });
  if (!boldKeptA) bad('加粗未作用于 AAA（格式组或夹具失效）'); else ok('加粗作用于 AAA');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.sheet b')].find((x) => x.textContent === 'AAA');
    const r = document.createRange(); r.setStartAfter(b); r.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    b.closest('.sheet').focus();
  });
  await page.keyboard.type('BBB');
  const textAfterType = await page.evaluate(() => document.querySelector('.sheet').textContent);
  const nativeBefore = await page.evaluate(() => window.__edNativeInputCount());
  await page.keyboard.press('Meta+z');
  const after = await page.evaluate(() => ({
    text: document.querySelector('.sheet').textContent,
    // [T5-ADJ-6] Chromium 粘性格式会把紧接 <b> 输入的 B 并进同一个 <b>（实测 <b>AAABB</b>），
    //   exact === 'AAA' 属夹具假象；设计意图是"A 仍加粗"，用 includes 忠实断言（加粗真丢失时 .some 为 false）
    boldA: [...document.querySelectorAll('.sheet b')].some((x) => x.textContent.includes('AAA')),
    native: window.__edNativeInputCount(),
    undoBtn: (document.getElementById('ed-undo-btn') || {}).textContent || ''
  }));
  if (!after.boldA) bad('⌘Z 后加粗丢失：说明格式化被压进整片快照栈（违反 §6.1）'); else ok('⌘Z 后加粗保留');
  if (!after.text.includes('AAA')) bad('⌘Z 后 A 丢失：' + after.text); else ok('⌘Z 后 A 保留');
  if (after.text === textAfterType) bad('⌘Z 未撤销任何内容（原生撤销被误拦截）');
  else if (after.text.includes('BBB')) bad('⌘Z 未撤销最近输入的 B：' + after.text);
  else ok(`一次 ⌘Z 撤销的是最近输入的 B（现文本 ${JSON.stringify(after.text)}）`);
  if (after.native >= nativeBefore) bad('受信任输入计数未随原生撤销更新（计数器实现有误）'); else ok('受信任输入计数正确递增/回退');
  // [T5-ADJ-2] 简报原文此处断言 undoBtn 必含「撤销」——但 §6.1 钉死"格式化不压程序化快照栈"，
  //   8a 全程（夹具合成 input + execCommand 加粗 + 原生打字 + 原生 ⌘Z）没有任何程序化 op 入栈，
  //   工具条理应为空。原文断言只有"加粗被压栈"才可能为真，与 §6.1 直接矛盾，故反转为守 §6.1 的断言：
  //   出现「撤销」= 格式化被误压栈。
  if (after.undoBtn.includes('撤销')) bad('格式化被压进程序化快照栈（违反 §6.1：execCommand 不压栈）：' + after.undoBtn);
  else ok('格式化未压栈：⌘Z 走原生撤销，工具条无程序化 op');

  // 8b 程序操作之后无新输入 ⇒ ⌘Z 消费该 op；之后有输入 ⇒ ⌘Z 不消费（连续两次也不得回退快照）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#ed-navlist button')].find((x) => (x.title || '').includes('隐藏'));
    if (!b) { window.__noHideBtn = true; return; } b.click();
  });
  if (await page.evaluate(() => !!window.__noHideBtn)) bad('条目隐藏按钮不存在，无法验证程序化撤销');
  const btnAfterOp = await page.evaluate(() => (document.getElementById('ed-undo-btn') || {}).textContent || '');
  if (!btnAfterOp.includes('撤销')) bad('程序操作未压栈（工具条无「↩ 撤销」）'); else ok('程序操作已压栈：' + btnAfterOp.trim());
  await page.evaluate(() => { document.querySelector('.sheet').focus(); });
  await page.keyboard.press('Meta+z');
  const consumed = await page.evaluate(() => (document.getElementById('ed-undo-btn') || {}).textContent || '');
  if (consumed.includes('撤销')) bad('该 op 之后无新输入时 ⌘Z 未消费统一栈顶'); else ok('⌘Z 消费了刚压入的程序化 op');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#ed-navlist button')].find((x) => (x.title || '').includes('隐藏'));
    if (b) b.click();
  });
  await page.keyboard.type('CCC');                       // 该 op 之后出现受信任输入
  const beforeSeq = await page.evaluate(() => ({
    text: document.querySelector('.sheet').textContent,
    btn: (document.getElementById('ed-undo-btn') || {}).textContent || ''
  }));
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');                   // 连续撤销
  const afterSeq = await page.evaluate(() => ({
    text: document.querySelector('.sheet').textContent,
    btn: (document.getElementById('ed-undo-btn') || {}).textContent || '',
    secHidden: !!document.querySelector('.sheet section.ed-sec-hidden')
  }));
  // [T5F-C1] 原断言"每个已键入字符挺过两次 ⌘Z"在原生撤销语义下不可满足：§6.1 line 87 裁决
  //   "该 op 之后有新的受信任输入 → ⌘Z 不拦截，交回原生撤销"，而原生撤销的职责恰是逐字回退后续输入
  //   （⌘⇧Z 可重做）；§7 line 117 禁止的是"整片快照回退吞掉后续文字"，不是原生逐字撤销。改写为三条：
  //   ⌘Z 确实交回原生（CCC 被回退）、程序化 op 仍在栈上（工具条仍提供它）、op 自身 DOM 效果（章节隐藏）完好。
  if (!beforeSeq.text.includes('CCC')) bad('8b 前置失败：CCC 未打进正文（后续断言无意义）');
  else if (!afterSeq.btn.includes('撤销')) bad('「程序操作 → 输入 → 连续撤销」把程序化 op 静默回退了（应保留在栈上待显式确认）');
  else if (!afterSeq.secHidden) bad('程序化 op 自身的 DOM 效果丢失：发生了整片快照回退（违反 §7"不得整片回退吞掉后续文字"）');
  else if (afterSeq.text.includes('CCC')) bad('⌘Z 被拦截成静默 no-op（既未消费 op 也未交回原生撤销，违反 §6.1 line 87"交回原生撤销"）：CCC 原样在位');
  else ok('⌘Z 交回原生撤销：后续输入被原生回退，程序化 op 仍在栈上且其隐藏效果完好（无整片回退）');

  // 8c Toast 绑 opId：消费后失效；栈顶已变时不得弹别人的 op
  const toastOneShot = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('#ed-navlist button')].find((x) => (x.title || '').includes('删除条目'));
    if (!btn) return { fail: 'no-del-btn' };
    const before = document.querySelector('.sheet').innerHTML;
    btn.click();                                          // 删除条目 A → 压栈 + Toast
    const afterDel = document.querySelector('.sheet').innerHTML;
    const t = [...document.querySelectorAll('.toast button')].pop();
    if (!t) return { fail: 'no-toast' };
    t.click();                                            // Toast 撤销 A 的那条 op
    const afterToast = document.querySelector('.sheet').innerHTML;
    t.click();                                            // 同一条不得二次消费
    const afterSecond = document.querySelector('.sheet').innerHTML;
    const btnLabel = (document.getElementById('ed-undo-btn') || {}).textContent || '';
    // [T5-ADJ-3] 原文 stackEmpty=!btnLabel.includes('撤销') 假设了空栈；但 8b 按其自身断言必然留下
    //   一条合法未决 op（隐藏章节，"应保留待确认"），它垫在栈底不是缺陷。双重恢复缺陷的判据是
    //   "Toast 消费后自己那条 op 是否还在栈顶"，故改为按 op 标签判定。
    return { fail: null, restored: afterToast === before, sameAfterSecond: afterSecond === afterToast, changed: afterDel !== before, ownOpGone: !btnLabel.includes('删除条目') };
  });
  if (toastOneShot.fail) bad(`Toast 用例前置缺失：${toastOneShot.fail}`);
  else if (!toastOneShot.changed) bad('删除条目未改变正文');
  else if (!toastOneShot.restored) bad('Toast 撤销未恢复到 op 前状态');
  else if (!toastOneShot.sameAfterSecond) bad('同一 Toast 被二次消费（内容被再次改动）');
  else if (!toastOneShot.ownOpGone) bad('Toast 撤销后其 op 仍在栈顶 → 工具条会双重恢复');
  else ok('Toast 绑定 opId：一次性消费、幂等、与工具条同一入口');

  // 8d 用户实测场景：删除 A → 又做操作 B → 点 A 尚未消失的旧 Toast ⇒ 不得破坏 B
  const staleToast = await page.evaluate(() => {
    const del = [...document.querySelectorAll('#ed-navlist button')].find((x) => (x.title || '').includes('删除条目'));
    const hide = [...document.querySelectorAll('#ed-navlist button')].find((x) => (x.title || '').includes('隐藏'));
    if (!del || !hide) return { fail: 'missing-buttons' };
    del.click();                                          // A：删除条目
    const oldToast = [...document.querySelectorAll('.toast button')].pop();
    if (!oldToast) return { fail: 'no-toast' };
    const afterA = document.querySelector('.sheet').innerHTML;
    hide.click();                                         // B：另一个程序化操作 → 栈顶已变
    const afterB = document.querySelector('.sheet').innerHTML;
    oldToast.click();                                     // 点 A 的旧 Toast → 必须拒绝
    const afterClick = document.querySelector('.sheet').innerHTML;
    const t = [...document.querySelectorAll('.toast')].map((x) => x.textContent).join('|');
    return { fail: null, bKept: afterClick === afterB, invalidated: /已失效|失效/.test(t), aChanged: afterA !== afterB };
  });
  if (staleToast.fail) bad(`陈旧 Toast 用例前置缺失：${staleToast.fail}`);
  else if (!staleToast.aChanged) bad('删除 A 与操作 B 未产生差异，用例无意义');
  else if (!staleToast.bKept) bad('点击 A 的旧 Toast 弹掉了 B 的 op（双重恢复缺陷仍在）');
  else if (!staleToast.invalidated) bad('被拒绝的陈旧 Toast 未进入「已失效」态（用户看不到状态）');
  else ok('陈旧 Toast 拒绝撤销别人的 op，并显示已失效');

  // 8e [T5F-C2] Toast 路径同样必须过确认门（§6.1 line 95 点名工具条 / Toast 两个入口）：
  //   删除条目 → 继续打字 → 5s 内点仍可见的 Toast → 必须弹 confirm；取消 → 什么都不变
  //   （Toast 不得被误置「已失效」——op 仍是栈顶）；确认 → 整片回退（删除的条目恢复，其后输入按文案一并回退）。
  //   旧缺陷：确认门 keyed on expectedId==null，Toast 恒带 id → 无确认整片 innerHTML 重写且原生撤销链被打断（不可恢复）。
  const del8e = await page.evaluate(() => {
    // 8d 把两个章节都藏了（隐藏章节的条目按钮不渲染）：先显示一个章节，再删它的条目
    const show = [...document.querySelectorAll('#ed-navlist button')].find((x) => (x.title || '').includes('显示该章节'));
    if (show) show.click();                                  // 同步 renderNav，条目按钮立即可查
    const b = [...document.querySelectorAll('#ed-navlist button')].find((x) => (x.title || '').includes('删除条目'));
    if (!b) return { fail: 'no-del-btn' };
    b.click();                                               // 删除条目 → 压栈 + Toast（5s 可见窗口）
    return { fail: null };
  });
  if (del8e.fail) bad(`8e 前置缺失：${del8e.fail}（无法验证 Toast 确认门）`);
  else {
    await page.evaluate(() => { document.querySelector('.sheet').focus(); });
    await page.keyboard.type('TTT');                         // op 之后出现受信任输入 → Toast 消费必须先过 confirm
    const pre8e = await page.evaluate(() => ({
      text: document.querySelector('.sheet').textContent,
      toastBtn: !!([...document.querySelectorAll('.toast button')].find((x) => x.textContent === '撤销' && !x.disabled))
    }));
    if (!pre8e.text.includes('TTT')) bad('8e 前置失败：TTT 未打进正文');
    else if (!pre8e.toastBtn) bad('8e 前置失败：删除 Toast 或其撤销按钮不可见');
    else {
      let dlg1 = null;
      const h1 = async (d) => { dlg1 = d.message(); await d.dismiss(); };
      page.once('dialog', h1);
      await page.evaluate(() => {
        const t = [...document.querySelectorAll('.toast button')].find((x) => x.textContent === '撤销' && !x.disabled);
        if (t) t.click();
      });
      await page.waitForTimeout(150);
      page.off('dialog', h1);   // 红态（未弹 confirm）时摘掉悬挂监听，避免误吃块 10 的 prompt
      const afterDismiss = await page.evaluate(() => ({
        text: document.querySelector('.sheet').textContent,
        toastStillOffers: !!([...document.querySelectorAll('.toast button')].find((x) => x.textContent === '撤销' && !x.disabled)),
        btn: (document.getElementById('ed-undo-btn') || {}).textContent || ''
      }));
      if (dlg1 === null) bad('点击 Toast（其后有受信任输入）未弹 confirm（§6.1 line 95 要求两个入口都显式确认）');
      else if (!/一并回退/.test(dlg1)) bad('Toast 确认文案未写明其后输入会一并回退：' + dlg1);
      else if (afterDismiss.text !== pre8e.text) bad('取消 confirm 仍改动了正文（Toast 路径无确认整片回退）：' + afterDismiss.text);
      else if (!afterDismiss.btn.includes('删除条目')) bad('取消 confirm 把 op 弹出了栈（应原样保留）：' + afterDismiss.btn);
      else if (!afterDismiss.toastStillOffers) bad('取消 confirm 把 Toast 误置「已失效」（op 仍是栈顶，入口应保持可点）');
      else ok('Toast 确认门：其后有输入 → 点 Toast 弹 confirm；取消 → 正文/栈/Toast 全不变');
      let dlg2 = null;
      const h2 = async (d) => { dlg2 = d.message(); await d.accept(); };
      page.once('dialog', h2);
      await page.evaluate(() => {
        const t = [...document.querySelectorAll('.toast button')].find((x) => x.textContent === '撤销' && !x.disabled);
        if (t) t.click();
      });
      await page.waitForTimeout(150);
      page.off('dialog', h2);   // 同上：未弹出即摘掉，绝不把悬挂监听带进后续块
      const afterAccept = await page.evaluate(() => document.querySelector('.sheet').textContent);
      if (dlg2 === null) bad('再次点击 Toast 未弹 confirm（第二次消费同样要过确认门）');
      else if (afterAccept.includes('TTT') || !afterAccept.includes('某公司')) {
        bad('确认 Toast 撤销后未回到 op 前状态（被删条目应恢复、其后输入 TTT 应一并回退）：' + afterAccept.slice(0, 160));
      } else ok('Toast 确认门：确认 → 整片回退到删除前（条目恢复、其后输入按文案一并回退）');
    }
  }

  // 8f [T5F-I6] 底部状态条不得被纸张盖住：冻结主题 .sheet{position:relative;min-height:297mm}
  //   （themes/resume-classic.css:10/:12）在矮视口让纸张溢出 grid 行、盖住静态定位的 #ed-status——
  //   「↩ 撤销」是唯一的定向撤销入口，必须真实可点。ctx 默认视口即 1280×720；
  //   断言 elementFromPoint(按钮中心) 命中按钮自身或其内部元素。
  const hit8f = await page.evaluate(() => {
    const b = document.getElementById('ed-undo-btn');
    if (!b || b.style.display === 'none' || !b.textContent.trim()) return { fail: 'no-undo-btn' };
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const desc = (n) => (n ? (n.id ? '#' + n.id : (String(n.className || n.tagName))) : 'null');
    return { fail: null, hit: el === b || b.contains(el), at: desc(el), vw: window.innerWidth, vh: window.innerHeight };
  });
  if (hit8f.fail) bad('8f 前置缺失：栈上没有 ↩ 撤销按钮可测命中');
  else if (hit8f.vw !== 1280 || hit8f.vh !== 720) bad(`8f 前置失败：视口应为 1280×720，实际 ${hit8f.vw}×${hit8f.vh}`);
  else if (!hit8f.hit) bad(`↩ 撤销按钮被纸张盖住（elementFromPoint 命中 ${hit8f.at}）：1280×720 下定向撤销不可点`);
  else ok('1280×720 下 ↩ 撤销按钮真实可点（elementFromPoint 命中按钮，状态条不再被纸张盖住）');

  // 9) 查找替换：不跨块级边界的假命中 / 跨 <b> 命中可替换 / 内容变化即重算 / 替换前二次校验 / 全部替换一条撤销
  await page.evaluate((fix) => {
    const s = document.querySelector('.sheet');
    s.innerHTML = fix;
    s.dispatchEvent(new Event('input', { bubbles: true }));
  }, '<section><h2>第一章</h2><p>结尾甲</p><p>开头乙</p></section>'
   + '<section><h2>第二章</h2><p>候选人<b>姓名</b>测试</p></section>');
  await page.keyboard.press('Meta+f');
  if (!(await page.evaluate(() => !!document.getElementById('ed-find')))) bad('⌘F 未打开查找面板'); else ok('⌘F 打开查找面板');
  // 9a 跨块假命中必须不存在（"甲" 结尾 + "开头" 拼接会造出 "甲开头"）
  await page.fill('#ed-find-q', '甲开头');
  let probe = await page.evaluate(() => document.getElementById('ed-find-count').textContent);
  if (!/^0\/0$/.test(probe)) bad(`跨块边界产生了虚假命中，count=${probe}（应为 0/0）`); else ok('不跨块级边界：无虚假命中');
  // 9b 跨行内节点命中可替换，且不破坏结构
  await page.fill('#ed-find-q', '人姓名');
  await page.fill('#ed-find-r', 'X');
  probe = await page.evaluate(() => document.getElementById('ed-find-count').textContent);
  if (!/^1\/1$/.test(probe)) bad(`跨 <b> 命中计数应为 1/1，实际 ${probe}`); else ok('跨加粗节点命中识别正确');
  await page.click('#ed-find-all');
  probe = await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    return { text: s.textContent, secs: s.querySelectorAll('section').length, h2: s.querySelectorAll('h2').length,
             ps: s.querySelectorAll('p').length, emptyBold: [...s.querySelectorAll('b')].some((b) => !b.textContent.trim()),
             marks: s.querySelectorAll('mark,.ed-find-hit,[class*=ed-find]').length,
             undo: (document.getElementById('ed-undo-btn') || {}).textContent || '' };
  });
  if (!probe.text.includes('候选X测试')) bad('跨 <b> 替换丢字/错位：' + probe.text);
  else if (probe.secs !== 2 || probe.h2 !== 2 || probe.ps !== 3) bad(`替换破坏块级结构：secs=${probe.secs} h2=${probe.h2} p=${probe.ps}`);
  else if (probe.emptyBold) bad('跨节点替换后残留空 <b>（未清理）');
  else if (probe.marks !== 0) bad('查找高亮落成 DOM 节点（会进保存 HTML）');
  else if (!probe.undo.includes('替换')) bad('全部替换未压入撤销栈');
  else ok('跨加粗替换：文本正确、块结构不变、空内联已清理、无 DOM 高亮、一条撤销');
  await page.keyboard.press('Meta+z');
  probe = await page.evaluate(() => document.querySelector('.sheet').textContent);
  if (!probe.includes('候选人姓名测试')) bad('替换全部撤销未回到原文：' + probe); else ok('替换全部一次撤销回原文');
  // 9c 缓存位置过期：查找后继续输入，命中必须重算（旧偏移不得再用）
  // [T5-ADJ-4] 原文先 evaluate 聚焦正文、后 page.fill('#ed-find-q')——fill 会把焦点留在查找输入框，
  //   随后的 keyboard.type 全打进输入框而非正文，firstHitOk 必假。把聚焦挪到 fill 之后、type 之前，
  //   才能测到本项的本意："正文输入后命中即时重算"。
  await page.fill('#ed-find-q', 'ZZZ');
  await page.evaluate(() => {
    const s = document.querySelector('.sheet'); s.focus();
    const p = s.querySelector('p');
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(true);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.type('前置ZZZ后缀');
  probe = await page.evaluate(() => ({
    count: document.getElementById('ed-find-count').textContent,
    firstHitOk: (() => { const s = document.querySelector('.sheet'); return s.textContent.includes('前置ZZZ'); })()
  }));
  if (!probe.firstHitOk) bad('测试夹具未真正插入文本');
  else if (!/\/1\s*$/.test(probe.count) && !probe.count.includes('/1')) bad(`输入后命中未重算，count=${probe.count}`);
  else ok('内容变化即重算命中：' + probe.count);
  // 9d 替换前二次校验：外部改了正文使缓存失效后点"全部替换"不得错删
  const guarded = await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    const before = s.textContent;
    const q = document.getElementById('ed-find-q');
    q.value = '不存在的词';
    q.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('ed-find-all').click();
    return { unchanged: s.textContent === before };
  });
  if (!guarded.unchanged) bad('无命中时点全部替换仍改动了正文'); else ok('无命中时替换为无操作');
  // 9d2 [T5F-I5] 陈旧位置守卫必须真被行使（committed 套件里 :776/:777 的 stale 分支是死代码，9d 只测了无命中）：
  //   收集命中后，程序化改写命中文本——**保持文本节点同一性、只改内容**，并派发合成 input（AI/面板程序化
  //   变更的真实形状；外壳只对受信任 input 重算命中，合成 input 不触发 → 缓存命中真实过期）。点「替换当前一处」：
  //   不得替换任何东西、必须告知用户、命中必须按当前正文重算。
  await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    s.innerHTML = '<section><h2>第一章</h2><p>目标词在前</p><p>目标词在后</p></section>';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    if (window.__edOpenFind) window.__edOpenFind();
  });
  await page.fill('#ed-find-q', '目标词');
  await page.fill('#ed-find-r', '替换体');
  probe = await page.evaluate(() => document.getElementById('ed-find-count').textContent);
  if (probe !== '1/2') bad(`9d2 前置失败：命中计数应 1/2，实际 ${probe}`);
  else {
    await page.evaluate(() => {
      const p = document.querySelector('.sheet p');
      p.firstChild.nodeValue = '已被改写';                    // 节点同一性不变、内容失效 → 缓存的 (元素,偏移) 与目标文本双双过期
      p.dispatchEvent(new Event('input', { bubbles: true })); // 合成 input：程序化变更形状，外壳不因此重算
    });
    await page.click('#ed-find-one');                        // 替换当前一处（唯一使用缓存命中的入口）
    const staleGuard = await page.evaluate(() => ({
      text: document.querySelector('.sheet').textContent,
      count: document.getElementById('ed-find-count').textContent,
      toast: Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join(' ')
    }));
    if (staleGuard.text.includes('替换体')) bad('陈旧命中仍被替换（替换前二次校验失效，错改正文）：' + staleGuard.text);
    else if (!/正文已变化/.test(staleGuard.toast)) bad('陈旧命中中止后没有告知用户：' + staleGuard.toast);
    else if (staleGuard.count !== '1/1') bad(`陈旧命中中止后未按当前正文重算命中，count=${staleGuard.count}（应 1/1：只剩第二处）`);
    else ok('陈旧位置守卫：未替换任何内容、已告知用户、命中按当前正文重算（1/1）');
  }
  // 9d2 用过自己的单章节夹具：恢复块 9 的两章节夹具（9e 跨章节断言依赖 secs=2/h2=2/ps=3）
  await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    s.innerHTML = '<section><h2>第一章</h2><p>结尾甲</p><p>开头乙</p></section>'
      + '<section><h2>第二章</h2><p>候选人<b>姓名</b>测试</p></section>';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => { if (window.__edCloseFind) window.__edCloseFind(); });
  // 9e 跨章节选区格式化不破坏结构
  await page.evaluate(() => {
    const s = document.querySelector('.sheet'); const ps = s.querySelectorAll('p');
    const r = document.createRange(); r.setStartBefore(ps[0].firstChild); r.setEndAfter(ps[ps.length - 1].lastChild);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); s.focus();
  });
  await page.click('[data-fmt="bold"]');
  const cross = await page.evaluate(() => {
    const s = document.querySelector('.sheet');
    return { secs: s.querySelectorAll('section').length, h2: s.querySelectorAll('h2').length, ps: s.querySelectorAll('p').length, text: s.textContent };
  });
  if (cross.secs !== 2 || cross.h2 !== 2 || cross.ps !== 3) bad(`跨章节格式化破坏结构 secs=${cross.secs} h2=${cross.h2} p=${cross.ps}`);
  else if (!cross.text.includes('第一章') || !cross.text.includes('第二章')) bad('跨章节格式化丢字：' + cross.text);
  else ok('跨章节选区格式化：结构与文本完整');

  // 10) 链接协议校验 + 瞬态状态不进落盘 HTML（解析 DOM 检查，不用磁盘子串）
  await page.evaluate(() => {
    const p = document.querySelector('.sheet p');
    const r = document.createRange(); r.selectNodeContents(p.firstChild || p);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.querySelector('.sheet').focus();
  });
  page.once('dialog', async (d) => { await d.accept('javascript:alert(1)'); });
  await page.click('[data-fmt="createLink"]');
  let link = await page.evaluate(() => { const a = document.querySelector('.sheet a'); return a ? a.getAttribute('href') : null; });
  if (link !== null) bad('javascript: 链接被插入（协议校验失效）：' + link); else ok('javascript: 链接被拒绝');
  // [T5-ADJ-7] 合并全部 toast 文本再匹配：8d 的「已失效」Toast 可能仍在其 5s 窗口内且更早入 DOM，
  //   querySelector('.toast') 会命中那条旧的造成误报；本项断言只关心"拒绝提示是否出现"。
  let tip = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent).join(' '));
  if (!/拒绝|仅允许/.test(tip)) bad('拒绝时没有明确提示文案：' + tip); else ok('拒绝有提示：' + tip.trim());
  for (const bad0 of ['JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' data:text/html;base64,AA', 'vbscript:x']) {
    page.once('dialog', async (d) => { await d.accept(bad0); });
    await page.click('[data-fmt="createLink"]');
    const has = await page.evaluate(() => !!document.querySelector('.sheet a'));
    if (has) bad(`未拦截的链接协议：${JSON.stringify(bad0)}`);
  }
  ok('多种协议伪装（大小写/制表符/前导空格/vbscript）均被拒绝');
  page.once('dialog', async (d) => { await d.accept('HTTPS://example.com/x'); });
  await page.click('[data-fmt="createLink"]');
  link = await page.evaluate(() => { const a = document.querySelector('.sheet a'); return a ? a.getAttribute('href') : null; });
  if (!link || !/^https:\/\/example\.com\/x$/i.test(link)) bad('合法链接未插入：' + link); else ok('http/https/mailto 白名单生效');
  // 瞬态：flash（已改 Highlight API，正文不得带 class）/ focus / find 面板 / 弹层 / jobpop
  await page.evaluate(() => {
    if (window.__edOpenShortcutHelp) window.__edOpenShortcutHelp();
    if (window.__edOpenFind) window.__edOpenFind();
    const el = document.querySelector('.sheet p');
    if (window.__edFlashForTest) window.__edFlashForTest(el);      // 走 flashEl 的真实实现（内部用 Highlight API）
  });
  await page.click('#saveBtn');
  await page.waitForFunction(() => (document.getElementById('saveState') || {}).dataset?.state === 'saved', { timeout: 12000 });
  const onDisk = fs.readFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), 'utf8');
  // 解析 DOM 后再判定：磁盘子串会命中脚本自身的字符串，是必然误报
  // [T5-ADJ-5] 用 DOMParser 惰性解析代替 setContent：setContent 会重放文档自带内联脚本，
  //   updatePageLines() 会在检查页里动态补出 .page-line，污染"落盘残留"判定（简报要求 pageLines 一并断言）。
  //   DOMParser 产物是惰性文档（脚本不执行），检查的仍完全是落盘 HTML 的 DOM。
  const inspect = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
  const ipage = await inspect.newPage();
  await ipage.goto('about:blank');
  const dom = await ipage.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const q = (sel) => doc.querySelectorAll(sel).length;
    return {
      bodyClass: (doc.body.className || '').split(/\s+/).filter(Boolean),
      flash: q('.ed-flash'), find: q('#ed-find'), keys: q('#ed-keys'),
      shellStyles: q('style[data-ed-shell]'), aiStyles: q('style[data-ai-panel]'), jobStyles: q('style[data-job-panel]'),
      inj: q('[data-ed-inj]'), pageLines: q('.page-line'), jobpop: q('#ed-jobpop'), jobmask: q('#ed-jobmask'),
      toolbar: q('.edit-toolbar'), content: doc.querySelector('.sheet') ? doc.querySelector('.sheet').textContent : ''
    };
  }, onDisk);
  await inspect.close();
  ['ed-on', 'ed-preview', 'ed-focus'].forEach((c) => {
    if (dom.bodyClass.includes(c)) bad(`落盘 body 仍带编辑器瞬态 class ${c}`); else ok(`落盘 body 无瞬态 class ${c}`);
  });
  [['flash', 'ed-flash'], ['find', '#ed-find'], ['keys', '#ed-keys'], ['shellStyles', 'style[data-ed-shell]'],
   ['aiStyles', 'style[data-ai-panel]'], ['jobStyles', 'style[data-job-panel]'], ['inj', '[data-ed-inj]'],
   ['jobpop', '#ed-jobpop'], ['jobmask', '#ed-jobmask']].forEach(([k, label]) => {
    if (dom[k] !== 0) bad(`落盘 HTML 残留瞬态节点 ${label}（${dom[k]} 个）`); else ok(`落盘 HTML 无 ${label}`);
  });
  // 简报注：pageLines 一并断言。夹具由 assembleTemplate 装配（模板产物不自带 .page-line，它是运行时
  // 由文档内联脚本生成、doSave 清理的瞬态），落盘实测应为 0。
  if (dom.pageLines !== 0) bad(`落盘 HTML 残留 .page-line 分页线（${dom.pageLines} 个）`); else ok('落盘 HTML 无 .page-line（夹具不自带，实测 0）');
  if (dom.toolbar === 0) bad('落盘 HTML 丢了文档自带工具栏（清理过度）');
  else if (!dom.content.includes('第一章')) bad('落盘正文异常（瞬态清理误伤正文）');
  else ok('清理未误伤文档自带结构（工具栏与正文都在）');
  // [T5-ADJ-8] 块 10 为落盘检查特意打开了快捷键弹层/查找面板且不再使用；活页 DOM 里的残留
  //   会让块 11 第一步"输入框内 ? 不弹层"读到旧弹层而误报（实测复现），检查完毕即关闭。
  await page.evaluate(() => { if (window.__edCloseFind) window.__edCloseFind(); const k = document.getElementById('ed-keys'); if (k) k.remove(); });

  // 11) 快捷键门控 [T5F-I3 裁决：typing into the user's document always wins]：
  //     输入框内 ? 不弹层；正文（contenteditable）内 ? = 正常插入问号、不弹层——旧契约"正文 ? 弹层"会让
  //     简历永远打不出问号（committed 断言锁定了该错误契约，此处按裁决反转）；焦点在正文外 ? 弹层；
  //     ⌘/ 任意焦点下都弹层；工具条 ? 按钮鼠标可达。与设计 §7 line 123 括注"仅正文/无输入焦点时触发"
  //     的偏离及理由记录在 task-5-report.md「Fix round 1」。
  //     Esc 关闭；IME 组合期不触发；⌘S 在组合期不发 /save。
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'probe-input'; i.setAttribute('data-ed-inj', '1'); document.body.appendChild(i); i.focus(); });
  await page.keyboard.type('?');
  if (await page.evaluate(() => !!document.getElementById('ed-keys'))) bad('输入框内输入 ? 触发了快捷键弹层'); else ok('输入框内 ? 不触发弹层');
  // 11b 焦点在正文：? 作为字符插入，且不弹层
  const qBefore = await page.evaluate(() => {
    const i = document.getElementById('probe-input'); if (i) i.remove();
    const p = document.querySelector('.sheet p');
    const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.querySelector('.sheet').focus();
    return p.textContent;
  });
  await page.keyboard.type('?');
  const qInSheet = await page.evaluate(() => ({
    keys: !!document.getElementById('ed-keys'),
    text: document.querySelector('.sheet p').textContent
  }));
  if (qInSheet.keys) bad('正文内输入 ? 触发了快捷键弹层（正文问号被吃掉——违反"打字进用户文档永远优先"）');
  else if (qInSheet.text !== qBefore + '?') bad(`正文聚焦时 ? 未作为字符插入：${JSON.stringify(qBefore)} → ${JSON.stringify(qInSheet.text)}`);
  else ok('正文内输入 ?：问号正常插入、不弹层（打字优先）');
  // 11c 焦点在正文外：? 打开弹层；Esc 关闭（先清场：11b 红态下旧代码可能已把弹层打开）
  await page.evaluate(() => { const k = document.getElementById('ed-keys'); if (k) k.remove(); const ae = document.activeElement; if (ae && ae.blur) ae.blur(); });
  await page.keyboard.type('?');
  if (!(await page.evaluate(() => !!document.getElementById('ed-keys')))) bad('焦点在正文外时 ? 未打开快捷键提示'); else ok('焦点在正文外 ? 打开快捷键提示');
  await page.keyboard.press('Escape');
  if (await page.evaluate(() => !!document.getElementById('ed-keys'))) bad('Esc 未关闭快捷键提示'); else ok('Esc 关闭快捷键提示');
  // 11d ⌘/ 在任意焦点下打开（正文焦点与输入框焦点各测一次；与打字永不冲突）
  await page.evaluate(() => { const k = document.getElementById('ed-keys'); if (k) k.remove(); document.querySelector('.sheet').focus(); });
  await page.keyboard.press('Meta+/');
  if (!(await page.evaluate(() => !!document.getElementById('ed-keys')))) bad('⌘/ 在正文焦点下未打开快捷键提示'); else ok('⌘/ 在正文焦点下打开弹层');
  await page.evaluate(() => {
    const k = document.getElementById('ed-keys'); if (k) k.remove();
    const i = document.createElement('input'); i.id = 'probe-input2'; i.setAttribute('data-ed-inj', '1'); document.body.appendChild(i); i.focus();
  });
  await page.keyboard.press('Meta+/');
  if (!(await page.evaluate(() => !!document.getElementById('ed-keys')))) bad('⌘/ 在输入框焦点下未打开快捷键提示'); else ok('⌘/ 在输入框焦点下打开弹层');
  // 11e 工具条 ? 按钮（正文 ? 交还打字后，弹层的鼠标可达入口）
  const keysBtnOk = await page.evaluate(() => {
    const k = document.getElementById('ed-keys'); if (k) k.remove();
    const i = document.getElementById('probe-input2'); if (i) i.remove();
    const b = document.querySelector('.edit-toolbar button.ed-keysbtn');
    if (!b) return null;
    b.click();
    return !!document.getElementById('ed-keys');
  });
  if (keysBtnOk === null) bad('工具条没有 ? 按钮（正文 ? 交还打字后，弹层缺少鼠标可达入口）');
  else if (!keysBtnOk) bad('点击工具条 ? 按钮未打开快捷键弹层');
  else ok('工具条 ? 按钮打开快捷键弹层');
  await page.evaluate(() => { const k = document.getElementById('ed-keys'); if (k) k.remove(); });
  // IME 组合期：? 与 ⌘Z 都不得生效；composing 标志可查询
  await page.evaluate(() => {
    const s = document.querySelector('.sheet'); s.focus();
    s.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  if (!(await page.evaluate(() => window.__edComposing && window.__edComposing()))) bad('compositionstart 未置组合标志'); else ok('组合标志置位');
  await page.keyboard.type('?');
  await page.keyboard.press('Meta+z');
  if (await page.evaluate(() => !!document.getElementById('ed-keys'))) bad('IME 组合期 ? 仍触发了弹层'); else ok('IME 组合期 ? 不触发');
  // ⌘S 组合期不得发保存请求（真实 IME 用 CDP 造组合态；无 CDP 时退化为合成 isComposing 事件）
  const nBefore = saveHits.length;
  let imeSession = null;
  try { imeSession = await ctx.newCDPSession(page); } catch (e) { imeSession = null; }
  if (imeSession) {
    await imeSession.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await page.keyboard.press('Meta+s');
    await imeSession.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await page.waitForTimeout(300);
    if (saveHits.length !== nBefore) bad(`IME 组合期 ⌘S 仍触发了保存（/save 请求 +${saveHits.length - nBefore}）`); else ok('IME 组合期 ⌘S 未触发保存（按 /save 请求数判定）');
    const n2 = saveHits.length;
    await page.keyboard.press('Meta+s');
    await page.waitForTimeout(900);
    if (saveHits.length === n2) bad('组合结束后 ⌘S 不再生效（门控过宽）'); else ok('组合结束后 ⌘S 正常保存');
  } else {
    await page.evaluate(() => {
      const s = document.querySelector('.sheet');
      s.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, isComposing: true, bubbles: true, cancelable: true }));
      s.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    if (saveHits.length !== nBefore) bad('组合期合成 ⌘S 仍触发保存（capture 截断未生效）'); else ok('组合期 ⌘S 被注入层截断（合成事件路径）');
    if (await page.evaluate(() => !!(window.__edComposing && window.__edComposing()))) bad('compositionend 后组合标志未复位'); else ok('compositionend 后标志复位');
  }
  // 聚焦编辑：⌘⇧F 进出，且 body 瞬态 class 由服务端剥离（块 10 已断言落盘无 ed-focus）
  await page.keyboard.press('Meta+Shift+f');
  const on = await page.evaluate(() => ({
    cls: document.body.classList.contains('ed-focus'), flag: window.__edFocusMode && window.__edFocusMode(),
    left: getComputedStyle(document.getElementById('ed-left')).display, right: getComputedStyle(document.getElementById('ed-right')).display
  }));
  if (!on.cls || on.flag !== true) bad('⌘⇧F 未进入聚焦编辑'); else if (on.left !== 'none' || on.right !== 'none') bad(`聚焦未收起左右栏 left=${on.left} right=${on.right}`); else ok('聚焦编辑：左右栏收起');
  await page.keyboard.press('Meta+Shift+f');
  const off = await page.evaluate(() => ({ cls: document.body.classList.contains('ed-focus'), flag: window.__edFocusMode(), left: getComputedStyle(document.getElementById('ed-left')).display }));
  if (off.cls || off.flag !== false || off.left === 'none') bad('再次 ⌘⇧F 未退出聚焦编辑'); else ok('聚焦编辑可退出');
  await ctx.close();
  }

  // 12) [T5F-I4] 服务端 body 瞬态 class 剥离（§6.2 硬约束 / §7.10 新旧文档同权）：legacy 形态夹具
  //     （pre-S2 模板装配：无 data-theme + 内联 typo-custom + meta theme:'legacy'；template.html 零改动，
  //     其内联 doSave 清理只认 ed-on/ed-preview、不认 ed-focus——这正是升级前已存在文档的真实形态）。
  //     客户端上送必然带着 ed-focus（先用解析 DOM 证明），落盘必须由服务端归一化剥净三个瞬态 class，
  //     同时逐字保留其余 class 与全部内容；再存一次字节稳定（剥离幂等）。
  {
  const ctx12 = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
  const page12 = await ctx12.newPage();
  const STRIP_DOC = 'ed-strip-legacy';
  const stripFile = path.join(dataRoot, 'docs', STRIP_DOC + '.html');
  {
    let tpl = assembleTemplate('classic');
    tpl = tpl.replaceAll('{{NAME}}', () => '剥离测试遗留员').replaceAll('{{CONTACT}}', () => 'strip@example.com')
      .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
      .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => '').replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => STRIP_DOC);
    const legacyHtml = tpl
      .replace('<style data-theme="classic">', '<style>')                    // legacy 形态：主题块无 data-theme（同 6d 夹具形态）
      .replace('</head>', '<style id="typo-custom">.sheet p{letter-spacing:0.02em}</style>\n</head>');
    fs.writeFileSync(stripFile, legacyHtml);
    const metaP = path.join(dataRoot, 'docs-meta.json');
    const mm = JSON.parse(fs.readFileSync(metaP, 'utf8'));
    mm[STRIP_DOC] = { theme: 'legacy' };
    fs.writeFileSync(metaP, JSON.stringify(mm));
  }
  // 夹具有效性自检（解析 DOM 查内联脚本，不做磁盘子串判定）：doSave 必须**不认识** ed-focus，
  // 否则剥净可能是客户端卫生的功劳，证明不了服务端兜底。
  const fixtureKnowsFocus = await page12.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const inline = [...doc.querySelectorAll('script')].map((s) => s.textContent).join('\n');
    return /ed-focus/.test(inline) || !/classList\.remove\('ed-on', 'ed-preview'\)/.test(inline);
  }, fs.readFileSync(stripFile, 'utf8'));
  if (fixtureKnowsFocus) bad('12 前置失败：夹具内联脚本认识 ed-focus 或缺 doSave 清理行（证明不了服务端兜底）');
  const posted12 = [];
  page12.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/save')) { const pd = r.postData(); if (pd) posted12.push(pd); } });
  await page12.goto(`${base}/edit?id=${STRIP_DOC}`, { waitUntil: 'networkidle' });
  await page12.waitForSelector('body.ed-on');
  await page12.evaluate(() => { document.body.classList.add('ed-focus', 'ed-preview', 'keep-me-legacy'); });
  const saveOnce12 = async () => {
    await page12.click('#saveBtn');
    await page12.waitForFunction(() => (document.getElementById('saveState') || {}).dataset?.state === 'saved', { timeout: 12000 });
  };
  await saveOnce12();
  // 客户端实际上送的 body class（解析 POST 体的 DOM；子串 grep 会命中 POST 体内注入脚本自身的文本，必然误报）
  const sentClass = await page12.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body ? (doc.body.getAttribute('class') || '') : '(no body)';
  }, posted12[posted12.length - 1] || '');
  const sentList = sentClass.split(/\s+/).filter(Boolean);
  if (!sentList.includes('ed-focus')) bad('12 前置失败：客户端上送的 body 未携带 ed-focus（内联清理已认它，服务端兜底证明失效）：' + sentClass);
  else ok('legacy 客户端上送 body 携带 ed-focus（其内联 doSave 不认识 → 只能靠服务端剥）');
  const onDisk12 = fs.readFileSync(stripFile, 'utf8');
  const dom12 = await page12.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return {
      bodyClass: (doc.body.getAttribute('class') || '').split(/\s+/).filter(Boolean),
      content: doc.querySelector('.sheet') ? doc.querySelector('.sheet').textContent : '',
      toolbar: doc.querySelectorAll('.edit-toolbar').length,
      typo: doc.querySelectorAll('style#typo-custom').length
    };
  }, onDisk12);
  let stripBad = null;
  ['ed-on', 'ed-preview', 'ed-focus'].forEach((c) => { if (dom12.bodyClass.includes(c)) stripBad = c; });
  if (stripBad) bad(`legacy 文档落盘 body 仍带瞬态 class ${stripBad}（服务端兜底失效）`);
  else if (!dom12.bodyClass.includes('keep-me-legacy')) bad('服务端剥离误删了非瞬态 class：' + dom12.bodyClass.join(' '));
  else if (!dom12.content.includes('剥离测试遗留员') || dom12.toolbar === 0) bad('瞬态剥离误伤了正文或文档自带工具栏');
  else ok('legacy 夹具落盘：ed-focus/ed-on/ed-preview 全被服务端剥离，keep-me-legacy 与正文/工具栏原样保留');
  // 幂等：稳态（首次保存已完成 legacy 内联 typo → meta 迁移）下重载再存一次 → 字节稳定
  const sha12 = createHash('sha1').update(onDisk12).digest('hex');
  await page12.reload({ waitUntil: 'networkidle' });
  await page12.waitForSelector('body.ed-on');
  await saveOnce12();
  const onDisk12b = fs.readFileSync(stripFile, 'utf8');
  if (createHash('sha1').update(onDisk12b).digest('hex') !== sha12) bad('legacy 文档稳态二次保存字节漂移（body class 剥离不幂等）');
  else ok('剥离幂等：legacy 文档稳态二次保存字节稳定');
  await ctx12.close();
  }

  // 13) [S2-T6｜简报称"块 12"，因 T5 已占用 12 号故顺延编号] 会话状态恢复：
  //     缩放（含夹取后真实值）/ 左右折叠 / 活动面板 / sheet 滚动位置 / 聚焦模式，刷新后逐项一致。
  //     折叠只存布尔（实测无拖拽调节，面板宽只有 208px|0px 与 320px|0px 两态，故不存在 0 宽 falsy 陷阱）；
  //     滚动容器就是 .sheet 自身（overflow-y:auto，body/html 均 overflow:hidden，已实测确认）。
  //     会话状态只进 per-doc localStorage，绝不进 docs-meta（末尾有泄漏断言）。
  {
  const ctx13 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx13.newPage();
  await page.goto(`${base}/edit?id=${ED_DOC}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.ed-on');
  if (await page.evaluate(() => typeof window.__edSetZoom) !== 'function') bad('缺 window.__edSetZoom（无法验证缩放恢复）');
  else {
    const applied = await page.evaluate(() => {
      window.__edSetZoom(3);                       // 故意越界：必须被 setZoom 的 0.4–1.5 夹取
      return { clamped: window.__edGetZoom() };
    });
    if (applied.clamped !== 1.5) bad(`缩放未走既有夹取（请求 3 → 实际 ${applied.clamped}，期望 1.5）`); else ok('缩放夹取与 setZoom 一致（3 → 1.5）');
    await page.evaluate(() => {
      window.__edSetZoom(1.25);
      const sheet = document.querySelector('.sheet');
      sheet.scrollTop = 260;                       // 真实滚动容器就是 .sheet
      window.__edToggleLeft();                    // 宽屏折叠：Step 3 导出的薄封装（内部即 toggleLeft）
      window.__edToggleRight();
      if (window.__edSelectTab) window.__edSelectTab('typo');
      window.__edPersistUi();
    });
    const st = await page.evaluate(() => ({ stored: localStorage.getItem('resume-ui:' + window.__edDocId), state: window.__edUiState && window.__edUiState() }));
    if (!st.stored) bad('未写入 resume-ui:<docId>');
    else {
      const v = JSON.parse(st.stored);
      if (v.zoom !== 1.25) bad(`zoom 未持久化（${v.zoom}）`); else ok('zoom 持久化 1.25');
      if (v.scrollTop !== 260) bad(`sheet 滚动位置未持久化（${v.scrollTop}，期望 260）`); else ok('sheet 滚动位置持久化 260');
      if (v.pane !== 'typo') bad(`活动面板未持久化（${v.pane}）`); else ok('活动面板持久化 typo');
      if (typeof v.leftHidden !== 'boolean' || typeof v.rightHidden !== 'boolean') bad('折叠状态必须是布尔（不能用 falsy 默认值兜底）：' + JSON.stringify(v));
      else if (v.leftHidden !== true || v.rightHidden !== true) bad(`折叠状态未记录（leftHidden=${v.leftHidden} rightHidden=${v.rightHidden}）`);
      else ok('左右折叠状态持久化（true/true，含 0 宽语义）');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('body.ed-on');
      await page.waitForTimeout(400);
      const back = await page.evaluate(() => ({
        zoom: window.__edGetZoom(),
        scrollTop: document.querySelector('.sheet').scrollTop,
        pane: (document.querySelector('#ed-rtabs button[aria-selected="true"]') || {}).dataset?.pane,
        leftHidden: document.getElementById('ed-left').classList.contains('ed-hidden'),
        rightHidden: document.getElementById('ed-right').classList.contains('ed-hidden'),
        leftW: document.body.style.getPropertyValue('--ed-left-w')
      }));
      if (back.zoom !== 1.25) bad(`刷新后 zoom 未恢复（${back.zoom}）`); else ok('刷新后 zoom 恢复 1.25');
      if (back.scrollTop !== 260) bad(`刷新后滚动位置未恢复（${back.scrollTop}）`); else ok('刷新后滚动位置恢复 260');
      if (back.pane !== 'typo') bad(`刷新后活动面板未恢复（${back.pane}）`); else ok('刷新后活动面板恢复 typo');
      if (!back.leftHidden || !back.rightHidden) bad('刷新后折叠状态未恢复（面板又展开了）'); else if (back.leftW !== '0px') bad(`折叠未同步列宽（--ed-left-w=${back.leftW}）`); else ok('刷新后左右仍折叠且列宽为 0px');
    }
    // 13b 聚焦编辑同属会话状态（T5 的 toggleFocusMode 已调 __edPersistUiSoon，此处补齐"存得下 + 刷得回"两端）
    await page.evaluate(() => { window.__edToggleFocus(); window.__edPersistUi(); });
    const focStored = await page.evaluate(() => (JSON.parse(localStorage.getItem('resume-ui:' + window.__edDocId) || '{}')).focusMode);
    if (focStored !== true) bad(`聚焦模式未持久化（focusMode=${focStored}）`); else ok('聚焦模式持久化 true');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('body.ed-on');
    await page.waitForTimeout(400);
    const focBack = await page.evaluate(() => ({ cls: document.body.classList.contains('ed-focus'), flag: window.__edFocusMode && window.__edFocusMode() }));
    if (!focBack.cls || focBack.flag !== true) bad(`刷新后聚焦模式未恢复（ed-focus=${focBack.cls} flag=${focBack.flag}）`); else ok('刷新后聚焦模式恢复（body 重新带上 ed-focus）');
    await page.evaluate(() => { window.__edToggleFocus(); window.__edPersistUi(); });   // 退出，避免污染下面的窄屏往返
    // 13c 窄屏（<1200）浮层态：独立往返，不与宽屏布尔混用
    await page.setViewportSize({ width: 900, height: 800 });
    await page.evaluate(() => { if (window.__edToggleLeftNarrow) window.__edToggleLeftNarrow(); });
    await page.evaluate(() => window.__edPersistUi());
    const narrow = await page.evaluate(() => JSON.parse(localStorage.getItem('resume-ui:' + window.__edDocId) || '{}'));
    if (typeof narrow.narrowLeftOpen !== 'boolean') bad('窄屏浮层展开态未持久化');
    else if (narrow.narrowLeftOpen !== true) bad(`窄屏展开后应持久化为 true（得 ${narrow.narrowLeftOpen}）`);
    else ok('窄屏浮层展开态可持久化（与宽屏折叠分字段存储）');
    // 13c-2 [S2-T7 I5b] 真端到端往返：窄屏视口下重载 → ed-open 必须被 restoreUi 真的恢复回来
    //   （旧断言只查 typeof === 'boolean'，存了没消费也绿；台账 Task 6 minor 转本波）
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('body.ed-on');
    await page.waitForTimeout(400);
    const narrowBack = await page.evaluate(() => ({
      leftOpen: document.getElementById('ed-left').classList.contains('ed-open'),
      stillNarrow: window.innerWidth < 1200
    }));
    if (!narrowBack.stillNarrow) bad('重载后视口已不是窄屏，本往返无效（需修夹具而非放宽断言）');
    else if (!narrowBack.leftOpen) bad('窄屏重载后 ed-open 浮层未恢复（存下的布尔未被 restoreUi 消费）');
    else ok('窄屏浮层展开态端到端往返：toggle → reload → ed-open 真的恢复');
    // 13d [S2-T7 I5a] 损坏会话载荷不得中断初始化：pane 含引号曾让 restoreUi 的 querySelector 抛
    //   SyntaxError，而 restoreUi 在初始化尾部内联调用 → 其后初始化（选区工具条等）全部中断。
    //   修复（CSS.escape）后：损坏 pane 静默跳过，其余字段照常恢复，页面无未捕获异常。
    const ctx13d = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx13d.addInitScript((id) => {
      try { localStorage.setItem('resume-ui:' + id, '{"v":1,"zoom":1.1,"pane":"a\\"b","scrollTop":10}'); } catch (e) {}
    }, ED_DOC);
    const page13d = await ctx13d.newPage();
    const errs13d = [];
    page13d.on('pageerror', (e) => errs13d.push(String(e)));
    await page13d.goto(`${base}/edit?id=${ED_DOC}`, { waitUntil: 'networkidle' });
    await page13d.waitForSelector('body.ed-on');
    const init13d = await page13d.evaluate(() => ({
      seltb: !!document.getElementById('ed-seltb'),
      zoom: window.__edGetZoom ? window.__edGetZoom() : null
    }));
    if (errs13d.length) bad(`损坏会话载荷（pane 含引号）引发页面级异常：${errs13d[0].slice(0, 120)}`);
    else if (!init13d.seltb) bad('restoreUi 之后的初始化被损坏载荷中断（缺 #ed-seltb 选区工具条）');
    else if (init13d.zoom !== 1.1) bad(`损坏载荷只应废掉 pane 字段，zoom 应照常恢复（得 ${init13d.zoom}）`);
    else ok('损坏会话载荷不再中断初始化（pane 跳过、zoom 照常、无 pageerror）');
    await ctx13d.close();
  }
  const metaAll = JSON.parse(fs.readFileSync(path.join(dataRoot, 'docs-meta.json'), 'utf8'));
  const leaked = Object.values(metaAll).some((m) => m && Object.keys(m).some((k) => /zoom|hidden|pane|scroll|focus|lastActive|ui/i.test(k)));
  if (leaked) bad('会话状态泄漏进 docs-meta（数据契约破坏）'); else ok('会话状态未进 docs-meta');
  await ctx13.close();
  }

  // 14) [S2-T6｜简报称"块 13"] 窄屏单栏不破 + 应用 UI 正文可读性（≥13px / 行高 ≥1.6）；简历正文不在门禁内
  //     [S2-T7 I3] 门禁回紧 1.5 → 1.6：设计 §2/§7.5 定的是 ≥1.6，旧断言放宽到 1.5 无裁决记录，
  //     1.55 的回归会静默通过。基线实测五个采样点均 ≥1.6（见 t7 报告），故收紧密口本身零 CSS 改动。
  {
  const ctxN = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const narrow = await ctxN.newPage();
  await narrow.goto(`${base}/`, { waitUntil: 'networkidle' });
  const ov = await narrow.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth, inner: window.innerWidth,
    // 2026-11-05 批 1：hero 区退役，heroArtHidden 采样（.hero-art）随元素一并移除——不再有可隐藏的插画位
    cols: (() => { const el = document.getElementById('doclist'); return el ? getComputedStyle(el).gridTemplateColumns.split(' ').length : 0; })()
  }));
  if (ov.scrollW > ov.inner + 1) bad(`首页窄屏横向溢出 scrollW=${ov.scrollW} inner=${ov.inner}`); else ok('首页窄屏无横向溢出');
  if (ov.cols > 1) bad(`窄屏文档列表仍 ${ov.cols} 栏`); else ok('窄屏文档列表单栏');
  // 14b [T3 遗留缺陷] 窄屏搜索行：视图切换按钮标签不得竖排（被挤到 min-content 后逐字换行）。
  //     判据用文本节点的客户端矩形数（一行一个矩形），比量高度更直接、不受按钮内边距影响。
  const vt = await narrow.evaluate(() => {
    const b = document.getElementById('viewToggle');
    if (!b) return null;
    const tn = [...b.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!tn) return { lines: 0, label: b.textContent };
    const r = document.createRange(); r.selectNodeContents(tn);
    return { lines: r.getClientRects().length, label: tn.textContent.trim(), h: Math.round(b.getBoundingClientRect().height) };
  });
  if (!vt) bad('首页缺 #viewToggle（窄屏搜索行结构变了，需同步本断言）');
  else if (vt.lines !== 1) bad(`窄屏「${vt.label}」按钮标签竖排换行（${vt.lines} 行，高 ${vt.h}px）`);
  else ok(`窄屏「${vt.label}」按钮标签单行不竖排（高 ${vt.h}px）`);
  await narrow.goto(`${base}/applications`, { waitUntil: 'networkidle' });
  const kb = await narrow.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, inner: window.innerWidth }));
  if (kb.scrollW > kb.inner + 1) bad(`窄屏看板横向溢出 scrollW=${kb.scrollW}（应纵向堆叠）`); else ok('窄屏看板纵向堆叠不溢出');
  await ctxN.close();
  const ctx14 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const wide = await ctx14.newPage();
  await wide.goto(`${base}/`, { waitUntil: 'networkidle' });
  // 2026-11-04 文案减负：.hero-sub 与岗位卡流程句(.card p) 已移除（DESIGN.md §9）；
  // 13px+ 档采样位改为 .statusline(13px/1.7) 与 #jobCard summary(继承 body 14px/1.6)
  const read = await wide.evaluate(() => ['.statusline', '#jobCard summary', '.doc-card', '.doclist .doc-card b'].map((s) => {
    const el = document.querySelector(s);
    if (!el) return { sel: s, missing: true };
    const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight);
    return { sel: s, fs, ratio: +(lh / fs).toFixed(2) };
  }));
  read.forEach((r) => {
    if (r.missing) bad(`可读性采样缺元素 ${r.sel}`);
    else if (r.fs < 13) bad(`应用 UI 正文字号过小 ${r.sel}=${r.fs}px（应 ≥13px）`);
    else if (r.ratio < 1.6) bad(`应用 UI 正文行高过小 ${r.sel}=${r.ratio}（应 ≥1.6，设计 §2/§7.5；不得放宽本门禁救火）`);
    else ok(`可读性通过 ${r.sel} ${r.fs}px/${r.ratio}`);
  });
  await ctx14.close();
  }

  // 15) [S2-T7 C1] 离线恢复 × 撤销栈重排基线（终审 Critical 1 的常驻复现）。
  //     序列照抄终审演示：程序化 op → 点「恢复这份修改」→ ⌘Z（op 后无受信任输入 → 旧码
  //     programmaticUndoSafeNow 成立且无确认）→ 旧码把恢复内容静默回滚，且 __edMarkProgrammatic →
  //     markDirty → writeCache 用回滚后的正文覆盖恢复缓存 → 永久丢失。修复 = 注入层在恢复条点击
  //     导致正文被整片替换后清空 undoStack（template.html 保持零改动）。
  {
    const REC_DOC = 'ed-fixture-recover-undo';
    let tpl = assembleTemplate('classic');
    tpl = tpl.replaceAll('{{NAME}}', () => '测试员').replaceAll('{{CONTACT}}', () => 'test@example.com')
      .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
      .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => '<div class="entry-head"><div class="entry-title">项目A</div><div class="entry-role">负责人</div><div class="entry-date">2024</div></div>\n<ul><li>项目A描述</li></ul>')
      .replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => REC_DOC);
    fs.writeFileSync(path.join(dataRoot, 'docs', REC_DOC + '.html'), tpl);
    const ctx15 = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    // 预置离线恢复缓存（正文与服务器不同 → 加载后必出恢复条；比块 2 的失败保存路径更确定）
    await ctx15.addInitScript((id) => {
      try {
        localStorage.setItem('resume-autosave:' + id, JSON.stringify({
          v: 2, rev: 99, typo: '', docId: id,
          body: '<div class="header"><h1>测试员</h1></div><section class="section"><div class="section-title">恢复章节</div><p>RECOVERED-MARKER</p></section>'
        }));
      } catch (e) {}
    }, REC_DOC);
    const page15 = await ctx15.newPage();
    let dialogs15 = 0;
    page15.on('dialog', async (d) => { dialogs15++; await d.dismiss(); });
    await page15.goto(`${base}/edit?id=${REC_DOC}`, { waitUntil: 'networkidle' });
    await page15.waitForSelector('body.ed-on');
    await page15.waitForSelector('.recovery-bar');
    // ① 真实程序化操作（导航「复制条目」→ __edPushUndo + notifyEdit），此后不再产生任何受信任输入
    await page15.evaluate(() => { const m = document.querySelector('#ed-navlist .ed-nav-more'); if (m && m.getAttribute('aria-expanded') !== 'true') m.click(); });   // S4a-T11：先展开 ⋯ 菜单
    const dupBtn15 = page15.locator('#ed-navlist button[aria-label^="复制条目"]').first();
    if (!(await dupBtn15.count())) bad('C1 夹具缺「复制条目」按钮（无法制造程序化 op）');
    else {
      await dupBtn15.click();
      await page15.waitForTimeout(150);
      const undoVisible15 = await page15.evaluate(() => { const b = document.getElementById('ed-undo-btn'); return !!b && b.style.display !== 'none' && !!b.textContent; });
      if (!undoVisible15) bad('C1 前置不成立：程序化操作后「↩ 撤销」按钮未出现（op 未压栈）');
      // ② 点「恢复这份修改」（恢复条第一颗按钮；「丢弃」是 .secondary）
      await page15.click('.recovery-bar button');
      await page15.waitForTimeout(250);
      const recovered15 = await page15.evaluate(() => document.querySelector('.sheet').textContent.includes('RECOVERED-MARKER'));
      if (!recovered15) bad('恢复条未把缓存正文写入 sheet（前置不成立）');
      // ③ ⌘Z：无论栈是否已清都走完终审序列，三处断言各自独立报（红证据要能指到丢失本身）
      await page15.click('.sheet');
      await page15.keyboard.press('Meta+z');
      await page15.waitForTimeout(600);                       // 跨过 writeCache 的 300ms debounce
      const post15 = await page15.evaluate((id) => ({
        stackCleared: (() => { const b = document.getElementById('ed-undo-btn'); return !b || b.style.display === 'none'; })(),
        survived: document.querySelector('.sheet').textContent.includes('RECOVERED-MARKER'),
        cache: localStorage.getItem('resume-autosave:' + id)
      }), REC_DOC);
      if (!post15.stackCleared) bad('恢复后撤销栈未重排基线（工具条「↩ 撤销」仍指向替换前的旧快照）');
      if (!post15.survived) bad('⌘Z 把刚恢复的内容静默回滚了（终审复现的永久内容丢失）');
      else if (post15.cache && !post15.cache.includes('RECOVERED-MARKER')) bad('⌘Z 后恢复缓存被回滚正文覆盖（丢失不可逆）');
      else if (dialogs15) bad(`⌘Z 在恢复场景不应弹任何 confirm（弹了 ${dialogs15} 次）`);
      else ok('离线恢复 × ⌘Z：栈已重排基线、恢复内容存活、缓存未被回滚正文覆盖、无 confirm');
    }
    await ctx15.close();
  }

  // 16) [S2-T7 I2] 输入框内 ⌘Z 属于输入框：既不消费程序化 op、也不改正文、也不弹确认
  //     （台账既定裁决"⌘Z 加 INPUT/TEXTAREA 判定"；旧码 inField 只被 ? 分支使用，⌘Z 分支裸奔）。
  //     独立夹具（§7.7 夹具纪律）：ED_DOC 的正文会被块 8-11 的场景改写，条目按钮不保证存在。
  {
    const I2_DOC = 'ed-fixture-undo-field';
    let tpl = assembleTemplate('classic');
    tpl = tpl.replaceAll('{{NAME}}', () => '测试员').replaceAll('{{CONTACT}}', () => 'test@example.com')
      .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
      .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => '<div class="entry-head"><div class="entry-title">项目A</div><div class="entry-role">负责人</div><div class="entry-date">2024</div></div>\n<ul><li>项目A描述</li></ul>')
      .replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => I2_DOC);
    fs.writeFileSync(path.join(dataRoot, 'docs', I2_DOC + '.html'), tpl);
    const ctx16 = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page16 = await ctx16.newPage();
    let dialogs16 = 0;
    page16.on('dialog', async (d) => { dialogs16++; await d.dismiss(); });
    await page16.goto(`${base}/edit?id=${I2_DOC}`, { waitUntil: 'networkidle' });
    await page16.waitForSelector('body.ed-on');
    await page16.evaluate(() => { const m = document.querySelector('#ed-navlist .ed-nav-more'); if (m && m.getAttribute('aria-expanded') !== 'true') m.click(); });   // S4a-T11：先展开 ⋯ 菜单
    const dupBtn16 = page16.locator('#ed-navlist button[aria-label^="复制条目"]').first();
    if (!(await dupBtn16.count())) bad('I2 场景缺「复制条目」按钮（无法制造程序化 op）');
    else {
      await dupBtn16.click();
      await page16.waitForTimeout(150);
      const before16 = await page16.evaluate(() => ({
        html: document.querySelector('.sheet').innerHTML,
        undoVisible: (() => { const b = document.getElementById('ed-undo-btn'); return !!b && b.style.display !== 'none'; })()
      }));
      if (!before16.undoVisible) bad('I2 前置不成立：程序化 op 未压栈');
      // 焦点进查找输入框并真实打字（INPUT 的受信任输入不进 sheet 计数器 → 旧码 ⌘Z 会被外壳劫持）
      await page16.evaluate(() => window.__edOpenFind());
      await page16.waitForSelector('#ed-find-q');
      await page16.click('#ed-find-q');
      await page16.keyboard.type('项目');
      await page16.keyboard.press('Meta+z');
      await page16.waitForTimeout(300);
      const after16 = await page16.evaluate(() => ({
        html: document.querySelector('.sheet').innerHTML,
        undoVisible: (() => { const b = document.getElementById('ed-undo-btn'); return !!b && b.style.display !== 'none'; })()
      }));
      if (after16.html !== before16.html) bad('输入框内 ⌘Z 被外壳劫持：正文被整片回滚（字段自身的撤销被偷走）');
      else if (!after16.undoVisible) bad('输入框内 ⌘Z 消费了程序化 op（工具条撤销消失）');
      else if (dialogs16) bad(`输入框内 ⌘Z 不应弹 confirm（弹了 ${dialogs16} 次）`);
      else ok('输入框内 ⌘Z：正文零变化、op 仍在栈上、无 confirm（交回字段原生撤销）');
    }
    await ctx16.close();
  }

  // 17) [S2-T7 M6] Esc 只关最上层：快捷键帮助 > 查找面板；岗位弹层 > 查找面板。
  //     旧码 dispatcher 无条件 toggleShortcutHelp(false)+closeFindPanel()，且弹层 handler 的
  //     stopPropagation 拦不住同节点上更早注册的 dispatcher → 关弹层的同一次 Esc 连带清掉查找词。
  {
    const ctx17 = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page17 = await ctx17.newPage();
    await page17.goto(`${base}/edit?id=${ED_DOC}`, { waitUntil: 'networkidle' });
    await page17.waitForSelector('body.ed-on');
    // 叠两层：查找面板（带查询词）+ 快捷键帮助（z 序更高，属最上层）
    await page17.evaluate(() => window.__edOpenFind());
    await page17.waitForSelector('#ed-find-q');
    await page17.click('#ed-find-q');
    await page17.keyboard.type('项目A');
    await page17.evaluate(() => window.__edOpenShortcutHelp());
    await page17.waitForSelector('#ed-keys');
    // Esc #1：只关帮助层，查找面板与查询词保留
    await page17.keyboard.press('Escape');
    const s1 = await page17.evaluate(() => ({
      keys: !!document.getElementById('ed-keys'),
      find: !!document.getElementById('ed-find'),
      q: (document.getElementById('ed-find-q') || {}).value || ''
    }));
    if (s1.keys) bad('Esc 未关闭快捷键帮助（最上层没被关掉）');
    else if (!s1.find || s1.q !== '项目A') bad(`Esc 关多了：帮助层连带清掉查找面板（查询词剩 "${s1.q}"）`);
    else ok('Esc 单层关闭：帮助层关掉，查找面板与查询词保留');
    // Esc #2：最上层换成岗位弹层 → 只关弹层，查找面板保留
    const jobBtn17 = page17.locator('.ed-jobbtn');
    if (!(await jobBtn17.count())) bad('M6 场景缺「＋ 岗位草稿」按钮（无法打开弹层）');
    else {
      await jobBtn17.click();
      await page17.waitForFunction(() => document.getElementById('ed-jobpop').style.display === 'block');
      await page17.keyboard.press('Escape');
      const s2 = await page17.evaluate(() => ({
        jobOpen: document.getElementById('ed-jobpop').style.display === 'block',
        find: !!document.getElementById('ed-find'),
        q: (document.getElementById('ed-find-q') || {}).value || ''
      }));
      if (s2.jobOpen) bad('Esc 未关闭岗位弹层');
      else if (!s2.find || s2.q !== '项目A') bad('关岗位弹层的同一次 Esc 连带清掉了查找面板（查询词丢失——终审复现）');
      else ok('关弹层的 Esc 不再连带清掉查找面板');
      // Esc #3：只剩查找面板 → 正常关闭（单层语义不劫持最底层能力）
      await page17.keyboard.press('Escape');
      const s3 = await page17.evaluate(() => !!document.getElementById('ed-find'));
      if (s3) bad('无更上层时 Esc 未关闭查找面板');
      else ok('仅剩查找面板时 Esc 正常关闭它');
    }
    await ctx17.close();
  }

  // ===== S3 块 A：zid 生命周期（加载即打点 / Enter 拆分 / 输入后唯一 / 未保存重开确定性）=====
  //     独立夹具（§7.7 夹具纪律）：ED_DOC 已被块 8-11 改写并经 /save normalizeZids 落盘 zid，
  //     无法验证「编辑器加载即打点」与「未保存重开确定性」——两者都要求磁盘正文零 zid 且全程不触发保存。
  {
    const S3_DOC = 'ed-fixture-zid';
    let tpl = assembleTemplate('classic');
    tpl = tpl.replaceAll('{{NAME}}', () => '测试员').replaceAll('{{CONTACT}}', () => 'test@example.com')
      .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
      .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => '<div class="entry-head"><div class="entry-title">项目A</div><div class="entry-role">负责人</div><div class="entry-date">2024</div></div>\n<ul><li>项目A描述</li></ul>')
      .replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => S3_DOC);
    fs.writeFileSync(path.join(dataRoot, 'docs', S3_DOC + '.html'), tpl);
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    await page.goto(`${base}/edit?id=${S3_DOC}`, { waitUntil: 'networkidle' });
    // 确定性基线必须在任何编辑前采集：下方拆分/打字只改内存，磁盘正文不变（全程未触发保存），
    // 未保存重开应从同一磁盘正文重新生成同一 zid 集合（全局约束 21）。
    // [S3T3-ADJ] 计划原稿在编辑后采集 zids1 再与重开集合比对——编辑后集合含新拆分段的哈希，与磁盘原文恒不等，断言不可满足；改为「首载基线 vs 重开」。
    const zids0 = await page.evaluate(() => Array.from(document.querySelectorAll('.sheet [data-zid]')).map((el) => el.getAttribute('data-zid')).sort().join(','));
    const count = await page.evaluate(() => ({
      units: document.querySelectorAll('.sheet p[data-zid], .sheet li[data-zid], .sheet h1[data-zid], .sheet h2[data-zid], .sheet h3[data-zid], .sheet h4[data-zid], .sheet .entry-head[data-zid], .sheet .contact[data-zid]').length,
      bare: document.querySelectorAll('.sheet p:not([data-zid]), .sheet li:not([data-zid])').length,
      titleTagged: !!document.querySelector('.section-title[data-zid]'),
      zids: Array.from(document.querySelectorAll('.sheet [data-zid]')).map((el) => el.getAttribute('data-zid'))
    }));
    if (count.units > 0 && count.bare === 0 && !count.titleTagged) ok('S3A 加载即全量打点且 section-title 不打'); else bad('S3A 加载即全量打点', JSON.stringify(count).slice(0, 120));
    if (new Set(count.zids).size === count.zids.length) ok('S3A zid 无重复'); else bad('S3A zid 无重复');
    // Enter 拆分：首条 li 内定位光标回车 → 新段有 zid 且全文唯一
    await page.evaluate(() => {
      const li = document.querySelectorAll('.sheet li')[0];
      const r = document.createRange(); r.setStart(li.firstChild, 2); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const afterSplit = await page.evaluate(() => Array.from(document.querySelectorAll('.sheet li')).map((el) => el.getAttribute('data-zid')));
    if (afterSplit.length && afterSplit.every(Boolean) && new Set(afterSplit).size === afterSplit.length) ok('S3A 拆分后新段有 zid 且唯一'); else bad('S3A 拆分后 zid', JSON.stringify(afterSplit));
    // 输入与合成 paste 事件后仍全量唯一
    await page.evaluate(() => { document.querySelectorAll('.sheet li')[0].dispatchEvent(new ClipboardEvent('paste', { bubbles: true })); });
    await page.keyboard.type('追加');
    await page.waitForTimeout(150);
    const zAfter = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('.sheet [data-zid]')).map((el) => el.getAttribute('data-zid'));
      return { n: all.length, u: new Set(all).size };
    });
    if (zAfter.n === zAfter.u) ok('S3A 输入后 zid 仍全量唯一'); else bad('S3A 输入后 zid 唯一性', JSON.stringify(zAfter));
    // 未保存重开：确定性 zid（同一磁盘正文两次加载生成相同 zid 集合——全局约束 21）
    await page.reload({ waitUntil: 'networkidle' });
    const zids2 = await page.evaluate(() => Array.from(document.querySelectorAll('.sheet [data-zid]')).map((el) => el.getAttribute('data-zid')).sort().join(','));
    if (zids0 && zids0 === zids2) ok('S3A 未保存重开 zid 确定性一致'); else bad('S3A 未保存重开 zid 漂移', zids0.slice(0, 40) + ' vs ' + zids2.slice(0, 40));
    await ctx.close();
  }

  // ===== S3 块 B：区域 Tab（列表 / 定位 / 着色不落盘 / 待确认分类计数）=====
  //     独立夹具 ed-fixture-zone（S3A 的 S3_DOC 是块内 const 且语义相反：A 要求全程不保存，B 要求保存落盘）。
  {
    const S3_DOC = 'ed-fixture-zone';
    let tpl = assembleTemplate('classic');
    tpl = tpl.replaceAll('{{NAME}}', () => '测试员').replaceAll('{{CONTACT}}', () => 'test@example.com')
      .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
      .replaceAll('{{WORK}}', () => '<div class="entry-head"><div class="entry-title">公司甲</div><div class="entry-role">工程师</div><div class="entry-date">2024</div></div>\n<ul><li>公司甲职责</li></ul>')
      .replaceAll('{{PROJECTS}}', () => '<div class="entry-head"><div class="entry-title">项目A</div><div class="entry-role">负责人</div><div class="entry-date">2024</div></div>\n<ul><li>项目A描述</li></ul>')
      .replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => S3_DOC);
    fs.writeFileSync(path.join(dataRoot, 'docs', S3_DOC + '.html'), tpl);
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } });   // S4a-T9：≥1440 三栏全开（1280 档右栏按活跃度折叠，不影响本段交互）
    const page = await ctx.newPage();
    await page.goto(`${base}/edit?id=${S3_DOC}`, { waitUntil: 'networkidle' });
    await page.click('#ed-rtabs button[data-pane="zone"]');
    // Tab 切换触发 ed-zone-refresh → load() 异步 fetch 落地后再断言（本地毫秒级，300ms 余量足够）
    await page.waitForTimeout(300);
    if (await page.$('#ed-pane-zone #zp-root')) ok('S3B 区域 Tab 渲染面板'); else bad('S3B 区域 Tab 渲染面板');
    const listTxt = await page.evaluate(() => document.querySelector('#ed-pane-zone').textContent);
    if (/(待确认分类|绑定完成)/.test(listTxt) && /工作/.test(listTxt)) ok('S3B 区域列表含计数'); else bad('S3B 区域列表', listTxt.slice(0, 60));
    // 着色开 → CSS.highlights 注册（-1 = 浏览器不支持，跳过不算失败）
    await page.click('#zp-color');
    const hl = await page.evaluate(() => (window.CSS && CSS.highlights) ? Array.from(CSS.highlights.keys()).filter((k) => k.indexOf('zone-') === 0).length : -1);
    if (hl > 0) ok('S3B 着色注册 Highlight'); else if (hl === 0) bad('S3B 着色未注册');
    // 保存后：落盘无 zone 痕迹（ZONE-INJECT / data-zone-panel / ::highlight 均剥离），zid 已固化
    const saveOnce = async () => {
      await page.click('#saveBtn');
      await page.waitForFunction(() => (document.getElementById('saveState') || {}).dataset?.state === 'saved', { timeout: 10000 });
    };
    await saveOnce();
    const disk = fs.readFileSync(path.join(dataRoot, 'docs', S3_DOC + '.html'), 'utf8');
    if (!disk.includes('data-zone-panel') && !disk.includes('ZONE-INJECT') && !disk.includes('::highlight')) ok('S3B 保存后落盘无 zone 痕迹'); else bad('S3B 落盘 zone 痕迹泄漏');
    if (disk.includes('data-zid')) ok('S3B zid 随保存落盘'); else bad('S3B zid 未落盘');
    // 弹窗开着保存：mask 元素由服务端 zp-modal 兜底正则剥离（客户端 doSave 无 zone 相关选择器，正则是唯一通道）
    await page.click('#zp-pend');
    if (await page.$('.zp-modal')) {
      await page.keyboard.press('Meta+s');            // 遮罩挡鼠标，⌘S 走键盘
      await page.waitForFunction(() => (document.getElementById('saveState') || {}).dataset?.state === 'saved', { timeout: 10000 });
      const disk2 = fs.readFileSync(path.join(dataRoot, 'docs', S3_DOC + '.html'), 'utf8');
      if (!/class="zp-modal"/.test(disk2)) ok('S3B 弹窗开着保存落盘无 zp-modal'); else bad('S3B 落盘 zp-modal 残留');
    } else bad('S3B 改绑弹窗未打开');
    await ctx.close();
  }

  // ===== S4a-T2 块 F2：区域确认流（取消=纯关+焦点返回 / 跳过游标推进 / Esc / 结束不回绕 / 文案空态）=====
  //     独立夹具 ed-fixture-f2（夹具纪律同 S3B：全新文档，避免与 S3 块的 zones 落盘状态互相污染）。
  //     zones 经 /zones/init 全 pending；zones0 全 pending → Z1 用 head 段（工作经历 li 属 skill 类夹带段）。
  {
    const S3_DOC = 'ed-fixture-f2';
    let tpl = assembleTemplate('classic');
    // （S4a-T9：本段在 1450 视口下运行——1280 档右栏按活跃度折叠，F2 交互不受折叠影响）
    tpl = tpl.replaceAll('{{NAME}}', () => '测试员').replaceAll('{{CONTACT}}', () => 'test@example.com')
      .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
      .replaceAll('{{WORK}}', () => '<div class="entry-head"><div class="entry-title">公司甲</div><div class="entry-role">工程师</div><div class="entry-date">2024</div></div>\n<ul><li>公司甲职责一</li><li>公司甲职责二</li></ul>')
      .replaceAll('{{PROJECTS}}', () => '<div class="entry-head"><div class="entry-title">项目A</div><div class="entry-role">负责人</div><div class="entry-date">2024</div></div>\n<ul><li>项目A描述</li></ul>')
      .replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => S3_DOC);
    fs.writeFileSync(path.join(dataRoot, 'docs', S3_DOC + '.html'), tpl);
    const zonesOf = () => (JSON.parse(fs.readFileSync(path.join(dataRoot, 'docs-meta.json'), 'utf8'))[S3_DOC] || {}).zones || {};
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } });   // S4a-T9：≥1440 三栏全开
    const page = await ctx.newPage();
    await page.goto(`${base}/edit?id=${S3_DOC}`, { waitUntil: 'networkidle' });
    await page.click('#ed-rtabs button[data-pane="zone"]');
    await page.waitForTimeout(300);
    // 文案与空态（D5）：「待确认分类 N 段」+ 不含「待绑定」+ 空 zone（获奖/教育/自评…模板未填）有「暂无内容」说明
    const listTxt0 = await page.evaluate(() => document.querySelector('#ed-pane-zone').textContent);
    if (/待确认分类 \d+ 段/.test(listTxt0) && !/待绑定/.test(listTxt0)) ok('F2 文案待确认分类'); else bad('F2 文案待确认分类', listTxt0.slice(0, 80));
    if (/暂无内容/.test(listTxt0)) ok('F2 空 zone 空态说明'); else bad('F2 空 zone 空态说明', listTxt0.slice(0, 80));
    // (a) 取消 = 纯关闭：不重开 + 焦点回 #zp-pend
    await page.click('#zp-pend');
    if (!(await page.$('.zp-modal'))) { bad('F2 弹窗未打开（夹具无 pending）'); }
    else {
      await page.click('.zp-card button.zp-cancel');
      await page.waitForTimeout(150);
      const closedAndNoReopen = await page.evaluate(() => !document.querySelector('.zp-modal'));
      const focusBack = await page.evaluate(() => (document.activeElement || {}).id === 'zp-pend');
      if (closedAndNoReopen) ok('F2 取消关闭且不重开'); else bad('F2 取消后弹窗重开（取消循环仍在）');
      if (focusBack) ok('F2 取消后焦点返回触发按钮'); else bad('F2 焦点未返回 #zp-pend');
      // (b) 跳过 = 游标推进：弹窗 data-zid 变化
      await page.click('#zp-pend');
      const zidA = await page.evaluate(() => { const c = document.querySelector('.zp-card'); return c ? c.getAttribute('data-zid') : null; });
      if (zidA) {
        await page.click('.zp-card .zp-skip');
        await page.waitForTimeout(150);
        const openAfterSkip = await page.evaluate(() => !!document.querySelector('.zp-modal'));
        const zidB = await page.evaluate(() => { const c = document.querySelector('.zp-card'); return c ? c.getAttribute('data-zid') : null; });
        if (openAfterSkip && zidB && zidB !== zidA) ok('F2 跳过推进到下一段'); else bad('F2 跳过未推进', 'zidA=' + zidA + ' zidB=' + zidB);
        // (c) Esc 关闭 + 不连带关抽屉：右栏抽屉只在 <768px 真实存在（shell resize 处理器 ≥768 会剥 ed-open）
        await page.setViewportSize({ width: 700, height: 800 });
        await page.evaluate(() => { document.getElementById('ed-right').classList.add('ed-open'); });
        await page.evaluate(() => document.querySelector('.zp-card .zp-cancel').focus());   // 保持焦点在弹窗内（真实路径 openPicker 已聚焦取消按钮）
        await page.keyboard.press('Escape');
        await page.waitForTimeout(100);
        const escState = await page.evaluate(() => ({
          modal: !!document.querySelector('.zp-modal'),
          drawer: document.getElementById('ed-right').classList.contains('ed-open'),
          ae: (document.activeElement || {}).className || (document.activeElement || {}).tagName
        }));
        if (!escState.modal && escState.drawer) ok('F2 Esc 关闭弹窗'); else bad('F2 Esc 未关闭', JSON.stringify(escState));
        if (escState.drawer) ok('F2 Esc 不连带关窄屏抽屉'); else bad('F2 Esc 连带关了抽屉（stopImmediatePropagation 缺失）');
        await page.setViewportSize({ width: 1440, height: 800 });  // 还原宽屏（resize 会清 ed-open；1440 档外不触发宽度档折叠）
        // (f) 中途确认一条：队列重排后跳过仍顺移（不跳到已确认段）
        await page.click('#zp-pend');
        const confirmedZid = await page.evaluate(() => document.querySelector('.zp-card').getAttribute('data-zid'));
        await page.click('.zp-modal .zp-sel');          // 选第一类（个人）→ bindOne confirmed
        await page.waitForTimeout(500);
        const afterConfirm = zonesOf();
        if (afterConfirm[confirmedZid] && afterConfirm[confirmedZid].status === 'confirmed') { /* 前置成立 */ } else bad('F2 中途确认未落盘', JSON.stringify(afterConfirm[confirmedZid]));
        await page.click('#zp-pend');
        const zidC = await page.evaluate(() => { const c = document.querySelector('.zp-card'); return c ? c.getAttribute('data-zid') : null; });
        await page.click('.zp-card .zp-skip');
        await page.waitForTimeout(150);
        const zidD = await page.evaluate(() => { const c = document.querySelector('.zp-card'); return c ? c.getAttribute('data-zid') : null; });
        const notConfirmedAgain = zidD !== confirmedZid;
        if (zidD && zidD !== zidC && notConfirmedAgain) ok('F2 确认后队列重排游标顺移'); else bad('F2 游标顺移异常', 'zidC=' + zidC + ' zidD=' + zidD);
        // (d) 连续跳过至队尾：关闭 + 本轮已看完提示 + 不自动重开（游标从当前 zid 继续推进）
        let guard = 0;
        while ((await page.$('.zp-modal')) && guard < 40) { await page.click('.zp-card .zp-skip'); await page.waitForTimeout(120); guard++; }
        const atEnd = await page.evaluate(() => ({
          open: !!document.querySelector('.zp-modal'),
          txt: document.querySelector('#ed-pane-zone').textContent
        }));
        if (!atEnd.open && /本轮已看完/.test(atEnd.txt)) ok('F2 队尾关闭且提示本轮已看完'); else bad('F2 队尾行为', atEnd.txt.slice(-80));
        await page.waitForTimeout(400);
        if (!(await page.$('.zp-modal'))) ok('F2 本轮结束不自动重开'); else bad('F2 队尾后自动重开');
        // (e) 重新查看入口有效：头部按钮仍在（pending 未清零）→ 再开即从头
        const pendBtn = await page.$('#zp-pend');
        if (pendBtn) {
          await page.click('#zp-pend');
          const reopen = await page.evaluate(() => !!document.querySelector('.zp-modal'));
          if (reopen) ok('F2 重新查看入口有效'); else bad('F2 重新查看未开弹窗');
          await page.click('.zp-card button.zp-cancel');
          await page.waitForTimeout(100);
        } else bad('F2 缺重新查看入口（#zp-pend 不存在）');
      }
    }
    await ctx.close();
  }

  // ===== S3 块 A2：无模型降级（拦截 409 → 按钮置灰 + 降级说明，绑定功能不受影响）=====
  //     复用 ed-fixture-zone（S3B 已保存落盘 zid 与 zones）；page.route 拦 /ai/zone-analyze 回 409 模拟未配置 LLM。
  {
    const S3_DOC = 'ed-fixture-zone';
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } });   // S4a-T9：≥1440 三栏全开
    const page = await ctx.newPage();
    // 真实服务端返回 409 + {code:'LLM_NOT_CONFIGURED'}；降级只对 LLM_NOT_CONFIGURED 生效，
    // 其它 409（文档版本陈旧）保留模型功能可用状态。
    await page.route('**/ai/zone-analyze*', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'LLM_NOT_CONFIGURED', error: '未配置大模型' }) }));
    await page.goto(`${base}/edit?id=${S3_DOC}`, { waitUntil: 'networkidle' });
    await page.click('#ed-rtabs button[data-pane="zone"]');
    await page.waitForTimeout(300);
    await page.click('.zp-row[data-zone="work"]');
    await page.waitForTimeout(600);                       // analyze fetch（409）落地 → 降级态渲染
    const degr = await page.evaluate(() => document.querySelector('#ed-pane-zone').textContent);
    if (/未配置大模型/.test(degr)) ok('S3A2 无模型降级说明'); else bad('S3A2 降级说明缺失', degr.slice(0, 60));
    const dis = await page.evaluate(() => ({
      a: (document.getElementById('zp-analyze') || {}).disabled,
      r: (document.getElementById('zp-rewrite') || {}).disabled
    }));
    if (dis.a === true && dis.r === true) ok('S3A2 分析/改写按钮置灰'); else bad('S3A2 按钮未置灰', JSON.stringify(dis));
    // 绑定功能不受影响：着色开关仍可切换
    await page.click('#zp-color');
    const pressed = await page.evaluate(() => document.getElementById('zp-color').getAttribute('aria-pressed'));
    if (pressed === 'true') ok('S3A2 降级不影响绑定功能'); else bad('S3A2 绑定功能受影响');
    await ctx.close();
  }

  // ===== S3 块 C：改绑整条回写契约（locked 不丢；复用 ed-fixture-zone：S3B 结束时 zones 全 pending 且已落盘 zid）=====
  {
    const S3_DOC = 'ed-fixture-zone';
    const metaFile = path.join(dataRoot, 'docs-meta.json');
    const readZones = () => (JSON.parse(fs.readFileSync(metaFile, 'utf8'))[S3_DOC] || {}).zones || {};
    // 预置一条 locked（走产品通道 /zones，语义 = 用户确认过且锁定的段落）
    const zones0 = readZones();
    const zidLocked = Object.keys(zones0)[0];
    const rest = Object.keys(zones0).slice(1).map((k) => zones0[k]);
    if (!zidLocked || !rest.length) { bad('S3C 夹具 zones 不足', JSON.stringify(Object.keys(zones0))); }
    else {
      zones0[zidLocked] = { zone: zones0[zidLocked].zone, status: 'confirmed', locked: true };
      const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
      const page = await ctx.newPage();
      await page.goto(`${base}/edit?id=${S3_DOC}`, { waitUntil: 'networkidle' });
      await page.evaluate((z) => fetch('/zones?id=ed-fixture-zone', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zones: z })
      }).then((r) => r.json()), zones0);
      await page.reload({ waitUntil: 'networkidle' });
      // 面板改绑另一段（待确认分类队头 ≠ zidLocked）
      await page.click('#ed-rtabs button[data-pane="zone"]');
      await page.waitForTimeout(300);
      await page.click('#zp-pend');
      await page.click('.zp-modal .zp-sel');          // 选第一类（个人）
      await page.waitForTimeout(500);
      const zones1 = readZones();
      const lockedKept = zones1[zidLocked] && zones1[zidLocked].locked === true && zones1[zidLocked].status === 'confirmed';
      const otherRebound = Object.keys(zones1).some((k) => k !== zidLocked && zones1[k].status === 'confirmed');
      if (lockedKept && otherRebound) ok('S3C 改绑整条回写保留 locked'); else bad('S3C locked 丢失或未改绑', JSON.stringify(zones1[zidLocked]));
      await ctx.close();
    }
  }
  // ===== S3 块 D：修改模式接受 → 统一撤销（⌘Z 语义与 S2 基线一致）=====
  //     [S3T6-ADJ] 计划原稿标签「S3 块 C」与 T2 改绑契约块撞名，顺延为 D；复用 ed-fixture-zone（S3B 已落盘 zid）。
  {
    const S3_DOC = 'ed-fixture-zone';
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    await page.goto(`${base}/edit?id=${S3_DOC}`, { waitUntil: 'networkidle' });
    await page.click('#ed-rtabs button[data-pane="zone"]');
    await page.waitForTimeout(300);
    // 经正式事件入口注入一条假候选（ed-zone-preview 通道；接受链路是本块被测对象，不依赖 LLM）
    // 候选必须带真实基线（operationId/before/beforeHash/zone）：接受链路走服务端的
    // 安全子集事务（磁盘正文 + 提交原文 + 归属 + 锁定 + 事实护栏 五项齐备才应用），
    // 缺基线的第三方事件不再能绕过检查（计划 I3：旧夹具的 before:'旧' 必须改为真实基线）。
    await page.evaluate(async function () {
      var el = document.querySelector('.sheet li[data-zid]');
      var zid = el.getAttribute('data-zid');
      var before = (el.textContent || '').trim();
      var d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(before));
      var hex = Array.from(new Uint8Array(d)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      window.__zpPreview = [{
        zid: zid, before: before, beforeHash: hex.slice(0, 16),
        operationId: 'op-s3d-1', zone: 'work', baselineVersion: 'zone-v1',
        candidate: '浏览器测试改写候选', level: 'normal'
      }];
      window.dispatchEvent(new Event('ed-zone-preview'));
    });
    await page.waitForTimeout(150);
    await page.click('#zp-accept');
    await page.waitForTimeout(2500);   // 接受走服务端安全子集事务（保存 → 提交 → 回执合并）
    const applied = await page.evaluate(() => document.querySelector('.sheet li[data-zid]').textContent);
    if (applied.includes('浏览器测试改写候选')) ok('S3D 接受后正文替换'); else bad('S3D 接受后正文替换', String(applied).slice(0, 60));
    const toastTxt = await page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((x) => x.textContent).join('|'));
    if (/撤销/.test(toastTxt)) ok('S3D Toast 带撤销入口'); else bad('S3D Toast 撤销入口缺失', toastTxt.slice(0, 60));
    await page.evaluate(() => document.querySelector('.sheet').focus());   // S2 既有块先例：程序化 op 消费前聚焦正文
    await page.keyboard.press('Meta+z');   // 程序化 op 消费路径（S2 语义：栈顶是区域改写且其后无受信任输入）
    await page.waitForTimeout(250);
    const undone = await page.evaluate(() => !document.querySelector('.sheet li[data-zid]').textContent.includes('浏览器测试改写候选'));
    if (undone) ok('S3D ⌘Z 撤销区域改写'); else bad('S3D ⌘Z 撤销失败');
    await ctx.close();
  }
  // ===== S4a-T5 修复轮：首页内联脚本完整性（script 块终止但 curl 全绿的回归门）=====
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } })   // S4a-T9：默认 ≥1440（1280 档右栏按活跃度折叠，避免无关断言被折叠影响）;
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e && e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    await page.goto(base + '/');
    await page.click('#jobCard > summary');                                  // 展开岗位表单
    await page.evaluate(() => { document.querySelector('#jobCard details').open = true; });   // 要求卡自身也是折叠态（默认收起）
    await page.waitForSelector('#briefFocusChips');
    if (consoleErrors.length) bad('T5 首页内联脚本抛未捕获异常（页数段选/预设/提交全失效）', consoleErrors[0]);
    else ok('T5 首页内联脚本无未捕获异常');
    // 页数段选：点击「1 页」→ aria-pressed 迁移（segPick 绑定生效的直接证据）
    await page.click('#briefPages button[data-pages="1"]');
    const pressed = await page.evaluate(() => ({
      one: document.querySelector('#briefPages button[data-pages="1"]').getAttribute('aria-pressed'),
      two: document.querySelector('#briefPages button[data-pages="2"]').getAttribute('aria-pressed')
    }));
    if (pressed.one === 'true' && pressed.two === null) ok('T5 页数段选 aria-pressed 迁移');
    else bad('T5 页数段选未生效（segPick 绑定失效）', JSON.stringify(pressed));
    // 幅度段选与预设（存→取→删走真 localStorage）
    await page.click('#briefDegree button[data-deg="light"]');
    await page.click('#briefFocusChips .chip');
    page.once('dialog', (d) => d.accept('浏览器预设'));
    await page.evaluate(() => document.getElementById('briefPresetSave').click());
    await page.waitForTimeout(200);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('s4a-presets') || '{}'));
    if (stored['浏览器预设'] && stored['浏览器预设'].brief.degree === 'light') ok('T5 预设存入 localStorage');
    else bad('T5 预设未存入', JSON.stringify(stored).slice(0, 80));
    // 取回：改乱表单 → 选回预设 → 段选恢复
    await page.click('#briefPages button[data-pages="2"]');
    await page.selectOption('#briefPresetSel', '浏览器预设');
    const back = await page.evaluate(() => ({
      deg: document.querySelector('#briefDegree button[aria-pressed="true"]').getAttribute('data-deg'),
      pages: document.querySelector('#briefPages button[aria-pressed="true"]').getAttribute('data-pages')
    }));
    if (back.deg === 'light' && back.pages === '1') ok('T5 预设取回恢复段选');
    else bad('T5 预设取回未恢复', JSON.stringify(back));
    // jobForm submit 处理器在位：填最小必填后提交 → 应发 /job/create（母版下拉首项即夹具文档）
    await page.fill('#jobCompany', '浏览器要求卡公司');
    await page.fill('#jobRole', '前端');
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/job/create'), { timeout: 8000 }).catch(() => null),
      page.click('#jobForm button[type="submit"]')
    ]);
    if (resp && resp.ok()) {
      // 响应体可能因页面立即跳转（location.href）而被浏览器丢弃——创建成功以响应 URL/状态为准，不依赖可读 body
      const created = await resp.json().catch(() => null);
      if (created === null || (created.ok && created.id)) ok('T5 jobForm 提交走 /job/create（brief 随单）');
      else bad('T5 /job/create 响应异常', JSON.stringify(created).slice(0, 80));
    } else bad('T5 jobForm 提交未发出 /job/create（submit 处理器未绑定）');
    await ctx.close();
  }

  // ===== UI-6：右栏可拖拽分栏（拖柄的浏览器行为；结构层断言在 test-structure.sh）=====
  // 之前这一段只有结构层断言，拖拽/键盘/复位/持久化一条都没跑过 → 边界问题没人发现。
  {
    const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + ED_DOC);
    await page.waitForSelector('#ed-grip', { timeout: 15000 });
    // 宽度：优先读 CSS 变量；没设过（未拖过）就读右栏实测宽 —— 否则 parseFloat('') = NaN，
    // 「变宽了吗」那种比较会静默通过（NaN 比较恒 false）→ 断言空转。
    // 量「右栏实测宽」而不是 CSS 变量：变量只是意图，实际宽度才是结果
    // （变量被写死时右栏根本没变宽，量变量会假绿 —— 2026-10-22 审查实测）
    const readW = async () => page.evaluate(() => {
      const r = document.getElementById('ed-right');
      if (!r) return NaN;
      const w = Math.round(r.getBoundingClientRect().width);
      return w > 0 ? w : NaN;
    });
    const before = await readW();
    // ① 拖柄左拖 → 右栏变宽
    const box = await page.locator('#ed-grip').boundingBox();
    const gy = box.y + box.height / 2;
    const gx = box.x + box.width / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx - 60, gy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const afterDrag = await readW();
    if (afterDrag - before < 40) bad('UI-6 拖柄左拖未使右栏变宽（' + before + ' → ' + afterDrag + '）');
    else ok('UI-6 拖柄左拖使右栏变宽（' + before + ' → ' + afterDrag + '）');
    // ② 宽度持久化到 localStorage
    const stored = await page.evaluate(() => localStorage.getItem('resume.ed.rightW'));
    if (!stored || Math.abs(Number(stored) - afterDrag) > 2) bad('UI-6 拖后宽度未持久化（localStorage=' + stored + '）');
    else ok('UI-6 拖后宽度持久化到 localStorage');
    // ③ 鼠标拖完直接按 ←/→ 也要生效（pointerdown 的 preventDefault 曾吃掉聚焦 → 键盘替代路径不可达）
    const w0 = await readW();
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(200);
    const w1 = await readW();
    if (Math.abs((w1 - w0) - 16) > 1) bad('UI-6 鼠标拖完直接按 ← 未按 16px 步进（' + w0 + ' → ' + w1 + '）');
    else ok('UI-6 鼠标拖完直接按 ← 按 16px 步进（拖柄已聚焦）');
    // ④ 双击复位 → 320px（与首屏默认一致）
    await page.dblclick('#ed-grip');
    await page.waitForTimeout(250);
    const afterDbl = await readW();
    if (Math.abs(afterDbl - 320) > 1) bad('UI-6 双击复位应回 320px，实际 ' + afterDbl);
    else ok('UI-6 双击复位回 320px');
    // ⑤ 上限跟视口走：右栏不得宽到把 210mm（≈794px）的纸张盖住
    const maxAllowed = 1450 - 208 - 794 - 24;
    if (afterDbl > maxAllowed + 1) bad('UI-6 右栏宽度超视口允许上限（' + afterDbl + ' > ' + maxAllowed + '）');
    else ok('UI-6 右栏宽度不超视口允许上限（' + afterDbl + ' ≤ ' + maxAllowed + '）');
    // ⑥ 注入层的运行时图标不得随保存落进文档文件（注入层产物不落盘）
    await page.evaluate(() => window.__edSaveManual && window.__edSaveManual());
    await page.waitForTimeout(2500);
    const diskGrip = fs.readFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), 'utf8');
    // 注入块在文件里是转义形态（\u003csvg），用 /<svg/ 匹配永远匹配不到 → 恒真。
    // 真正能红的判据：注入块自己的载荷/标记。
    // 注意别用 'data-ed-inj' —— 模板自己的脚本里就写着这个属性名（会恒真）。
    const leaks = ['__ICONS__', 'window.__MATS__', 'window.__JOB_INFO__',
      'ICON-INJECT', 'SHELL-INJECT', 'AI-INJECT', 'JOB-INJECT', 'ZONE-INJECT']
      .filter((k) => diskGrip.includes(k));
    if (leaks.length) bad('UI-6 保存的文档文件里残留注入层产物：' + leaks.join('、'));
    else ok('UI-6 保存的文档文件不含注入层产物（__ICONS__/__MATS__/注入注释对）');
    await ctx.close();
  }

} finally {
  await browser.close();
}
if (failures) { console.error('❌ 浏览器级验证失败 ' + failures + ' 项'); process.exit(1); }
console.log('浏览器级验证全部通过');
