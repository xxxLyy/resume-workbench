// test-migrate-lock-heartbeat.mjs — 迁移锁心跳：持锁期间刷新 startedAt（BL-P6-02，按复核 13130 修正口径）
// 背景：runMigration 给自己的 acquire 传 staleMs 24h 只作用于迁移自己的判定；server 的
// isHeld/acquire 仍用默认 30min → 整轮超 30min 后 server 照样判陈旧破锁放行写请求（已实证）。
// 修法合同：rootLock.touch 只刷自己持有的锁（pid+host 匹配）；startLockHeartbeat 周期调 touch、
// 返回停止函数。注释同步改实（不再声称 staleMs 参数能防 server 抢锁）。
// 纯函数夹具（临时根，零网络零服务）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootLock, startLockHeartbeat } from '../../tx.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-hb-'));
const lockPath = rootLock.path(root);
const readLock = () => JSON.parse(fs.readFileSync(lockPath, 'utf8'));

try {
  // ① touch 刷新自己持有的锁：把 startedAt 做旧到 31 分钟前 → server 默认口径已判陈旧 → touch → 新鲜
  rootLock.acquire(root);
  const stale = { ...readLock(), startedAt: Date.now() - 31 * 60 * 1000 };
  fs.writeFileSync(lockPath, JSON.stringify(stale));
  assert.equal(rootLock.isHeld(root), false, '31 分钟前的锁在默认 30min 口径下应已陈旧');
  assert.equal(rootLock.touch(root), true, 'touch 自己的锁应返回 true');
  assert.equal(rootLock.isHeld(root), true, 'touch 后应恢复新鲜');
  assert.ok(readLock().startedAt > stale.startedAt, 'startedAt 应被刷新');

  // ② 别人的锁 → touch 返回 false 不碰
  const foreign = { ...readLock(), pid: process.pid + 1 };
  fs.writeFileSync(lockPath, JSON.stringify(foreign));
  assert.equal(rootLock.touch(root), false, '别人的锁 touch 应返回 false');
  assert.equal(readLock().pid, process.pid + 1, '别人的锁文件被改动了');

  // ③ 心跳：短周期实际推进 startedAt；停止后不再推进
  rootLock.release(root);
  rootLock.acquire(root);
  const t0 = readLock().startedAt;
  const stop = startLockHeartbeat(root, 30);
  await new Promise((r) => setTimeout(r, 100));
  const t1 = readLock().startedAt;
  assert.ok(t1 > t0, '心跳应推进 startedAt');
  stop();
  await new Promise((r) => setTimeout(r, 80));
  const t2 = readLock().startedAt;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(readLock().startedAt, t2, '停止后 startedAt 不应再被推进');
  rootLock.release(root);

  // ④ 无锁时 touch 安全返回 false（不创建锁文件）
  assert.equal(rootLock.touch(root), false, '无锁时 touch 应返回 false');
  assert.equal(fs.existsSync(lockPath), false, '无锁时 touch 不应创建锁文件');

  console.log('✅ 迁移锁心跳：touch 仅自持锁生效并刷新 startedAt；startLockHeartbeat 周期推进、停止即停');
} finally {
  try { if (fs.existsSync(lockPath)) rootLock.release(root); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
