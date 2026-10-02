// tx.mjs — 保存事务 / 共享 docs-meta 原子更新 / 跨进程锁（S1 Task 3）
// 契约（供 server.mjs 与后续 T7 迁移消费）：
//   beginTx(root, docId, phase, oldSnapTs) -> txId   写 .tx/<txId>.meta.json（目标文档旧 meta 整份副本）+ .tx/<txId>.html（旧正文副本）+ 最后 .tx/<txId>.json（标记＝提交点）
//   commitTx(root, txId)                              清空该事务的三份记录
//   dropSupersededTx(root, docId) -> n                清掉同一文档更早的未完成记录（已被后续成功保存取代，留着会在启动时回滚掉新保存）
//   recoverPending(root, {restoreDoc}) -> recovered[] 扫描 .tx/，对每条未完成事务调 restoreDoc(rec) 后清理，返回已恢复记录
//                                                     （标记无载荷＝孤儿 → 清标记不动文档；载荷损坏 → 保留记录、ok:false）
//   withDocLock(root, docId, fn)                      进程内每文档排他锁；重入抛 LockHeld（server 映射 409）
//   updateMeta(root, docId, patchFn)                  docs-meta.json 唯一写入者：跨进程锁内 读最新→只 patch 目标文档→唯一临时+原子 rename（同步）
//   rootLock.{acquire,release,isHeld}                 跨进程排他锁 <root>/.migrate.lock（open 'wx' + 陈旧破除）；server 见锁对写请求 503
// 纪律：所有落盘走"唯一命名临时文件 + rename"（对进程被杀原子）；读容忍缺失、损坏显式抛 CORRUPT（停写不覆盖）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeToCurrent } from './freeze.mjs';   // 仅默认恢复用：旧冻结快照 → 当前格式（freeze 不依赖 tx，无环）

const META_FILE = 'docs-meta.json';
const MIGRATE_LOCK = '.migrate.lock';
const META_LOCK = '.meta.lock';
const TX_DIR = '.tx';
const HOST = os.hostname();

export class LockHeld extends Error {
  constructor(msg, extra) {
    super(msg || '锁被占用');
    this.name = 'LockHeld';
    this.code = 'LOCK_HELD';
    if (extra) Object.assign(this, extra);
  }
}

const metaPath = (root) => path.join(root, META_FILE);
const txDir = (root) => path.join(root, TX_DIR);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// 同步短睡眠（跨进程自旋锁用；不交给事件循环，Node 主线程允许 Atomics.wait）
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 原子写：唯一命名临时（避免跨进程临时名碰撞）+ rename。对进程被杀原子（rename 前崩溃不动目标，之后崩溃目标已完整）。
export function atomicWrite(file, data) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + Date.now() + '.' + Math.floor(Math.random() * 1e6) + '.tmp');
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function pidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }  // EPERM=存在但无权限
}

function readLock(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
}
const GRACE_MS = 5000;   // 锁文件"已创建但 info 未写完"的空窗宽限：不可读且 mtime 新鲜 → 视为有人正在持锁，绝不当陈旧破除
function lockMtimeAge(lockPath) {
  try { return Date.now() - fs.statSync(lockPath).mtimeMs; } catch { return Infinity; }   // 文件已消失 → 视作很旧（可重建）
}
// 陈旧判定：持有者已死、或超过 staleMs（心跳缺失）、或不可读且超过宽限（半截废弃）→ 陈旧可破除。
// 不可读但 mtime 新鲜（正在写入 info 的空窗）→ 不陈旧，等待而非破除（否则两进程同入临界区丢更新）。
// self-pid 不再无条件短路（T7 承载缺陷）：crash-while-holding + pid 复用后，新进程会把前任遗留锁误判为
// 自己持有 → 启动清除失效、一切写请求 503 直至手删。启动时进程可证不持任何锁：startedAt 早于本进程
// 启动时间（1s 时钟容差）→ 必为遗留 → 陈旧；或自持超过 staleMs（本模块临界区皆同步毫秒级）→ 陈旧。
function lockIsStale(lockPath, info, staleMs) {
  if (info && typeof info === 'object') {
    if (info.pid === process.pid) {
      if (typeof info.startedAt === 'number') {
        if (info.startedAt < Date.now() - process.uptime() * 1000 - 1000) return true;
        if (staleMs && Date.now() - info.startedAt > staleMs) return true;
      }
      return false;
    }
    if (!pidAlive(info.pid)) return true;
    if (staleMs && typeof info.startedAt === 'number' && Date.now() - info.startedAt > staleMs) return true;
    return false;
  }
  return lockMtimeAge(lockPath) > GRACE_MS;   // 不可读：新鲜→等待(false)，超宽限→陈旧(true)
}

// 跨进程文件锁（open 'wx' + 陈旧破除 + 自旋重试）。同步：临界区内不含 await，持锁时间为微秒级文件操作。
function acquireLockSync(lockPath, { staleMs = 30000, timeoutMs = 8000, retryMs = 3 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      const info = { pid: process.pid, host: HOST, startedAt: Date.now() };
      try { fs.writeFileSync(fd, JSON.stringify(info)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return info;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (lockIsStale(lockPath, readLock(lockPath), staleMs)) { try { fs.unlinkSync(lockPath); } catch {} continue; }  // 破除陈旧锁后重试
      if (Date.now() >= deadline) throw new LockHeld('锁被占用（等待超时）：' + path.basename(lockPath), { lock: readLock(lockPath) });
      sleepSync(retryMs);
    }
  }
}
function releaseLockSync(lockPath) { try { fs.unlinkSync(lockPath); } catch {} }

// ===== 根级跨进程排他锁 .migrate.lock（迁移/保存持有；server 见锁写请求 503）=====
export const rootLock = {
  path: (root) => path.join(root, MIGRATE_LOCK),
  // 获取锁（timeoutMs 缺省 0：被占即抛 LockHeld，供 /save 立即 503；迁移可传 timeoutMs 长等）。staleMs 缺省 30min（迁移长任务）。
  acquire(root, { staleMs = 1800000, timeoutMs = 0, retryMs = 20 } = {}) {
    return acquireLockSync(path.join(root, MIGRATE_LOCK), { staleMs, timeoutMs, retryMs });
  },
  release(root) { releaseLockSync(path.join(root, MIGRATE_LOCK)); },
  // 是否存在他人持有的新鲜锁（陈旧/死 pid/自己持有 → false）
  isHeld(root, { staleMs = 1800000 } = {}) {
    const lp = path.join(root, MIGRATE_LOCK);
    if (!fs.existsSync(lp)) return false;
    return !lockIsStale(lp, readLock(lp), staleMs);
  },
};

// ===== docs-meta.json 唯一原子写入者（同步）=====
// 锁内读最新（损坏抛 CORRUPT，停写不覆盖）。
function readMetaLocked(mp) {
  let meta = {};
  if (fs.existsSync(mp)) {
    const raw = fs.readFileSync(mp, 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch {
      const e = new Error(`数据文件损坏，已停止写入：${META_FILE}。请先人工修复或从备份恢复。`);
      e.httpCode = 500; e.code = 'CORRUPT'; throw e;
    }
    meta = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  }
  return meta;
}

// 读最新 → patchFn(目标文档旧 meta 的深拷贝) → 只改目标文档 → 唯一临时 + 原子 rename。
// 全程持 .meta.lock（跨进程）：两进程交替 patch 不同文档也不丢字段。进程内单线程同步 RMW 天然原子。
// patchFn 返回 null/undefined → 删除该文档条目；返回对象 → 写入。文件损坏 → 抛 CORRUPT（停写，不覆盖）。
export function updateMeta(root, docId, patchFn) {
  const lockPath = path.join(root, META_LOCK);
  acquireLockSync(lockPath, { staleMs: 30000, timeoutMs: 8000, retryMs: 2 });
  try {
    const mp = metaPath(root);
    const meta = readMetaLocked(mp);
    const oldDoc = Object.prototype.hasOwnProperty.call(meta, docId) ? clone(meta[docId]) : undefined;
    const next = patchFn(oldDoc);
    if (next === null || next === undefined) delete meta[docId];
    else meta[docId] = next;
    atomicWrite(mp, JSON.stringify(meta));
    return (next === null || next === undefined) ? null : next;
  } finally { releaseLockSync(lockPath); }
}

// 全表事务版（S4a 设计 §6 v1.4）：与 updateMeta 同锁（.meta.lock）同原子写；mutator 收到整个 meta 对象，
// 返回新表写入、返回 null/undefined 放弃不写、抛错原样上抛且不落盘。用途：跨文档读改写须原子的操作
// （如 gen-start 在元数据锁内扫描各文档 genTasks 判全局并发）。
export function updateMetaAll(root, mutator) {
  const lockPath = path.join(root, META_LOCK);
  acquireLockSync(lockPath, { staleMs: 30000, timeoutMs: 8000, retryMs: 2 });
  try {
    const mp = metaPath(root);
    const next = mutator(readMetaLocked(mp));
    if (next === null || next === undefined) return null;
    atomicWrite(mp, JSON.stringify(next));
    return next;
  } finally { releaseLockSync(lockPath); }
}

// ===== 保存事务记录（覆盖异常与进程中断）=====
function newTxId() { return `${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6).toString(36)}`; }

// 写前持久化事务记录：.meta.json（目标文档旧 meta 整份副本）+ .html（旧正文整份副本）+ 最后 .json（标记）。
// 标记最后写 = 提交点：载荷未齐就不会有标记，恢复端也就绝不会把"缺失载荷"误读成"事务前无 meta"而删条目。
// beginTx 在 rename#1 之前调用，故此刻 docs/<docId>.html 仍是旧正文。
export function beginTx(root, docId, phase, oldSnapTs) {
  const dir = txDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const txId = newTxId();
  // 旧 meta（目标文档条目整份副本；无则 null）
  let oldMeta = null;
  const mp = metaPath(root);
  if (fs.existsSync(mp)) {
    try {
      const all = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
      oldMeta = (all && typeof all === 'object' && Object.prototype.hasOwnProperty.call(all, docId)) ? clone(all[docId]) : null;
    } catch { oldMeta = null; }
  }
  const rec = { txId, docId, phase: phase || 'save', oldSnapTs: oldSnapTs || '', startedAt: Date.now(), host: HOST, pid: process.pid };
  const beginGapMs = Number(process.env.RESUME_TEST_TX_META_GAP_MS || 0);
  if (beginGapMs > 0) sleepSync(beginGapMs);   // 测试钩子：模拟"载荷尚未落盘"窗口内被杀（I-1）
  atomicWrite(path.join(dir, txId + '.meta.json'), JSON.stringify(oldMeta));
  // 旧正文副本（恢复首选源：精确旧字节，无需归一化；autosave 无快照时也能恢复）
  const docFile = path.join(root, 'docs', docId + '.html');
  if (fs.existsSync(docFile)) { try { atomicWrite(path.join(dir, txId + '.html'), fs.readFileSync(docFile, 'utf8')); } catch {} }
  atomicWrite(path.join(dir, txId + '.json'), JSON.stringify(rec));   // 标记（recoverPending 的扫描入口）最后落盘
  return txId;
}

export function commitTx(root, txId) {
  const dir = txDir(root);
  for (const ext of ['.json', '.meta.json', '.html']) { try { fs.unlinkSync(path.join(dir, txId + ext)); } catch {} }
}

// 同一文档更早的未完成记录被"本次成功保存"取代：成功保存意味着正文与 meta 已自洽落盘，
// 若留着旧记录，下次启动恢复会把文档回滚到更早版本（丢掉后来的成功保存）。返回清理条数。
// 无竞态前提：/save 全程持 .migrate.lock（rootLock），同一时刻不可能有另一进程在为该文档写记录。
export function dropSupersededTx(root, docId) {
  const dir = txDir(root);
  let files;
  try { files = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.meta.json')) continue;
    const txId = f.slice(0, -'.json'.length);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!rec || rec.docId !== docId) continue;
    for (const ext of ['.json', '.meta.json', '.html']) { try { fs.unlinkSync(path.join(dir, txId + ext)); } catch {} }
    n++;
  }
  return n;
}

// 启动/重跑恢复：扫描 .tx/ 未完成事务，对每条调 restoreDoc(rec) 恢复"仅目标文档"，成功后清理该事务记录。
// rec = { txId, docId, phase, oldSnapTs, startedAt, oldMeta, oldHtml, root }（oldHtml 来自 .tx/<txId>.html，可能 undefined）。
// restoreDoc 缺省时用内置默认恢复（写回旧正文 + updateMeta 回滚目标文档 meta）。返回 recovered[]（含 ok/error 标记）。
export function recoverPending(root, { restoreDoc } = {}) {
  const dir = txDir(root);
  const recovered = [];
  let files;
  try { files = fs.readdirSync(dir); } catch { return recovered; }   // 无 .tx 目录 → 无待恢复
  const txIds = files
    .filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
  for (const txId of txIds) {
    const recPath = path.join(dir, txId + '.json');
    const metaRecPath = path.join(dir, txId + '.meta.json');
    const htmlRecPath = path.join(dir, txId + '.html');
    let rec;
    try { rec = JSON.parse(fs.readFileSync(recPath, 'utf8')); } catch {
      // 记录损坏：无法安全恢复，清孤儿文件后跳过（不阻断其他事务）
      for (const p of [recPath, metaRecPath, htmlRecPath]) { try { fs.unlinkSync(p); } catch {} }
      continue;
    }
    if (!fs.existsSync(metaRecPath)) {
      // 标记有、载荷无 = 孤儿（beginTx 现为"标记最后写"，此路径只兜底旧记录/异常）：
      // 事务尚未改动任何东西，清标记即止，绝不把"缺失载荷"当成 oldMeta=null 去删文档 meta 条目。
      for (const p of [recPath, htmlRecPath]) { try { fs.unlinkSync(p); } catch {} }
      continue;
    }
    let oldMeta;
    try { oldMeta = JSON.parse(fs.readFileSync(metaRecPath, 'utf8')); } catch (e) {
      // 载荷损坏 ≠ 事务前无 meta：保留记录、标 ok:false 待人工（静默按 null 恢复会删掉文档 meta 条目）
      recovered.push({ ...rec, root, ok: false, error: 'meta 载荷不可解析，保留记录待人工处理：' + String((e && e.message) || e) });
      continue;
    }
    let oldHtml;
    try { if (fs.existsSync(htmlRecPath)) oldHtml = fs.readFileSync(htmlRecPath, 'utf8'); } catch { oldHtml = undefined; }
    const full = { ...rec, oldMeta, oldHtml, root };
    const doRestore = restoreDoc || defaultRestoreDoc;
    try { doRestore(full); } catch (e) {
      recovered.push({ ...full, ok: false, error: String((e && e.message) || e) });   // 恢复失败：保留 tx 记录待人工/下次重试
      continue;
    }
    for (const p of [recPath, metaRecPath, htmlRecPath]) { try { fs.unlinkSync(p); } catch {} }
    recovered.push({ ...full, ok: true });
  }
  return recovered;
}

// 默认恢复：写回旧正文（优先 .tx 副本；否则归一化旧冻结快照），并把目标文档 meta 回滚到旧副本。仅动目标文档。
// 快照兜底 legacy-safe（T7 承载缺陷，热修 a7eb561 裁决）：oldMeta.typo「未定义或为空串」= 手状态/legacy → 内联排版在
// 迁移前是权威来源，归一化剥离后必须原值回注（否则兜底恢复把内联 typo 剥丢）；已迁移（meta.typo 定义且非空）→ 写归一化正文。
// 口径与 freeze.mjs:178、server.mjs:568 完全一致（"定义且非空"），空串绝不当作已迁移。
function defaultRestoreDoc(rec) {
  const { docId, oldSnapTs, oldMeta, oldHtml, root } = rec;
  const docFile = path.join(root, 'docs', docId + '.html');
  if (typeof oldHtml === 'string') {
    atomicWrite(docFile, oldHtml);
  } else if (oldSnapTs) {
    const snapFile = path.join(root, 'snapshots', docId, String(oldSnapTs).replace(/[^0-9-]/g, '') + '.html');
    if (fs.existsSync(snapFile)) {
      const snap = fs.readFileSync(snapFile, 'utf8');
      // 旧快照为冻结格式（内联 typo）→ 归一化为当前格式后写回；legacy/手状态保留内联块
      let out;
      try {
        const norm = normalizeToCurrent(snap);
        out = norm.html;
        const legacy = !(oldMeta && typeof oldMeta.typo === 'string' && oldMeta.typo !== '');
        if (legacy && norm.typo) {
          const block = `<style id="typo-custom">${norm.typo}</style>`;
          out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, (mm) => block + mm) : block + out;
        }
      } catch { out = snap; }
      atomicWrite(docFile, out);
    }
  }
  // meta 回滚（只改目标文档；oldMeta=null 表示事务前无该条目 → 删除）
  return updateMeta(root, docId, () => (oldMeta === undefined ? null : oldMeta));
}

// ===== 进程内每文档锁（/save、/rollback、/duplicate、迁移互斥；重入 → LockHeld → server 409）=====
const docLocks = new Map();   // key: `${root}\0${docId}` → true
export function withDocLock(root, docId, fn) {
  const key = path.resolve(root) + '\u0000' + docId;
  if (docLocks.has(key)) throw new LockHeld('文档正在被另一保存/回滚/复制处理：' + docId, { docId });
  docLocks.set(key, true);
  const release = () => docLocks.delete(key);
  let out;
  try { out = fn(); } catch (e) { release(); throw e; }
  if (out && typeof out.then === 'function') return out.then((v) => { release(); return v; }, (e) => { release(); throw e; });
  release();
  return out;
}
