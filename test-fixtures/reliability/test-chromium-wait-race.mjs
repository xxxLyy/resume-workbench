// test-chromium-wait-race.mjs — Chromium 探测等待方竞态（BL-P1-05，severity: low）
// 背景：resolveChromium 等待分支旧序「先读缓存、后看锁文件」，而持锁方是「先写缓存、
// 再放锁（finally）」。若持锁方恰好在等待方 readCache() 之后、existsSync(锁) 之前完成
// 「写缓存+删锁」，等待方这一轮会看到「缓存没读到 + 锁已消失」→ break → 抛
// 「另一个进程正在探测 Chromium，稍后重试」——尽管缓存此刻已经可用。
// 修法合同：等待循环顺序改为「锁文件还在吗→在则继续等；不在则读缓存→有缓存直接用」，
// 消除误抛窗口（锁消失必然发生在写缓存之后，此刻读到的缓存就是最终结果）。
// 夹具手法：猴补 node:fs 的 existsSync/readFileSync（只劫持隔离根下的锁/缓存两个路径，
// 其余调用原样透传），在等待方进入等待循环后的第一次观察应答完之后，注入「持锁方完成
// 事件」——按持锁方真实顺序先写缓存、再删锁——把竞态窗口钉死成确定性时序。
// 纯函数路径：等待方全程不持锁 → probe/candidates 不会执行 → 不起服务、不起浏览器。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChromium, readCache, cacheValid, expectedRevision, playwrightVersion } from '../../chromium.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-chrwait-'));
process.env.RESUME_ROOT = root;   // cachePath()/lockPath() 按调用时 RESUME_ROOT 解析

const cacheFile = path.join(root, '.chromium-choice.json');
const lockFile = cacheFile + '.probe-lock';

// 合成缓存条目：cacheValid 要求 bin 真实存在、revision/playwright 与本机一致；
// 若环境已设 RESUME_CHROMIUM，则 bin 必须与之一致才判有效。
const fakeBin = path.join(root, 'fake-chromium-headless-shell');
fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const envBin = process.env.RESUME_CHROMIUM;
const bin = envBin && fs.existsSync(envBin) ? envBin : fakeBin;
const validCache = { bin, source: 'fixture', revision: expectedRevision(), playwright: playwrightVersion(), ok: true, probedAt: new Date().toISOString() };

// 猴补：持锁方完成事件 H = 按真实顺序先写缓存（atomic 语义不必要，同步写足矣）再删锁。
// 触发时机：等待方第 2 次「观察」（第 1 次是循环外 force=false 的预读缓存；第 2 次必是
// 等待循环内的第一次观察——旧序是 readCache，新序是 existsSync(锁)）应答完之后立即注入。
const realExistsSync = fs.existsSync;
const realReadFileSync = fs.readFileSync;
let observations = 0;
let injected = false;
fs.existsSync = function patchedExistsSync(p, ...rest) {
  if (p === lockFile) {
    const answer = realExistsSync.call(fs, p, ...rest);   // 应答注入前状态（锁仍在）
    observations += 1;
    if (observations === 2 && !injected) { injected = true; injectHolderCompletion(); }
    return answer;
  }
  return realExistsSync.call(fs, p, ...rest);
};
fs.readFileSync = function patchedReadFileSync(p, ...rest) {
  if (p === cacheFile) {
    let answer;
    try { answer = realReadFileSync.call(fs, p, ...rest); } catch (e) { answer = undefined; if (e.code !== 'ENOENT') throw e; }
    observations += 1;
    if (observations === 2 && !injected) { injected = true; injectHolderCompletion(); }
    if (answer === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return answer;
  }
  return realReadFileSync.call(fs, p, ...rest);
};
function injectHolderCompletion() {
  // 持锁方完成事件：先写缓存（resolveChromium 探测成功分支的写法），再删锁（finally 放锁）
  fs.writeFileSync(cacheFile, JSON.stringify(validCache, null, 2));
  fs.rmSync(lockFile, { force: true });
}

// 收尾：正常路径走 finally；process.exit/未捕获异常路径走 exit 钩子，不留孤儿临时根
let cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  fs.existsSync = realExistsSync; fs.readFileSync = realReadFileSync;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

try {
  // 预置：新鲜锁文件（持锁方在探测中）+ 无缓存。锁新鲜 → 等待方 acquireLock 必失败 → 走等待分支
  fs.writeFileSync(lockFile, String(process.pid));

  // 毒窗口时序（确定性）：等待方进循环后的第一次观察应答完，持锁方完成事件注入
  // 旧序（先读缓存后看锁）：该次观察读到「缓存不存在」，随后缓存写成+锁删掉，
  //   同一轮紧接着看锁 → 锁已消失 → break → 抛「另一个进程正在探测」← 待修缺陷
  // 新序（先看锁后读缓存）：该次观察看到锁仍在 → continue；下一轮锁已消失 → 读缓存
  //   → 有效 → 直接采用 ← 期望行为
  let result = null, err = null;
  try { result = await resolveChromium({ tmpDir: root, force: false, waitMs: 10000 }); }
  catch (e) { err = e; }

  // 前置条件（新旧序都应成立）：持锁方完成后缓存已定稿可用——这正是「误抛时缓存已可用」的物证
  const after = readCache();
  assert.ok(cacheValid(after), '持锁方完成后缓存应有效，实际：' + JSON.stringify(after));
  assert.ok(injected, '持锁方完成事件应已注入（时序钩子未触发说明没走到等待循环）');
  assert.equal(fs.existsSync(lockFile), false, '持锁方完成后锁文件应已删除');

  assert.equal(err, null,
    '等待方不应在缓存已可用时抛「另一个进程正在探测 Chromium」——误抛窗口仍在：' + (err && err.message));
  assert.equal(result, bin, '等待方应直接采用持锁方写好的缓存 bin，实际：' + result);

  console.log('✅ Chromium 探测等待方竞态：持锁方「写缓存→放锁」落进等待方两次观察之间时，' +
    '等待方不再误抛「另一个进程正在探测」，而是下一轮看到锁消失后直接采用已定稿缓存');
} finally {
  cleanup();
}
