// test-logrotate-fail-path.mjs — 轮转备份写失败不得仍截断主日志（BL-P6-01，medium）
// 背景：rotateLogIfNeeded 是「先写 .1 备份、再截断主文件」，但写 .1 的异常被空 catch
// 吞掉后 truncateSync 照做——备份没写成功也照样把整份主日志清零（ENOSPC/EISDIR 同路）。
// 修法合同（S0 设计口径「失败只 console.error 不影响服务」）：写 .1 抛错 →
// console.error('日志轮转失败(备份未写入，跳过截断): '+e.message) 并 return 不截断。
// 读后写前窗口丢失属 copytruncate 固有代价——注释登记，不在本夹具断言。
// 约束：纯函数 + 临时文件夹具；零网络、零依赖；不启动服务、不读真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rotateLogIfNeeded } from '../../logrotate.mjs';

const MB = 1024 * 1024;
const LOG_SIZE = 51 * MB;              // > logrotate.mjs 的 CAP(50MB)，必触发轮转
const MARKER = 'LRP-TAIL-MARKER-v1\n'; // 轮转只留尾部 2MB，用尾部标记核对备份内容
const tail = Buffer.from(MARKER.repeat(400));

const roots = [];
const mkCase = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-lrp-'));
  roots.push(root);
  return root;
};
// 稀疏写：定位写到 51MB 末尾，size 即 51MB（不真占盘）
const seedLog = (log) => {
  const fd = fs.openSync(log, 'w');
  try { fs.writeSync(fd, tail, 0, tail.length, LOG_SIZE - tail.length); } finally { fs.closeSync(fd); }
};
// 捕获 console.error，断言失败路径按合同打了诊断日志
const captureErr = (fn) => {
  const orig = console.error;
  const errs = [];
  console.error = (...a) => errs.push(a.map(String).join(' '));
  try { fn(); } finally { console.error = orig; }
  return errs;
};
process.on('exit', () => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} } });

// ===== A. 失败路径：.1 是目录（writeFileSync 抛 EISDIR）→ 主文件必须原样保留 =====
{
  const root = mkCase();
  const log = path.join(root, 'server.log');
  seedLog(log);
  fs.mkdirSync(log + '.1'); // 预置目录 → 备份写入必失败
  const errs = captureErr(() => rotateLogIfNeeded(log)); // 不得向外抛错（S0：不影响服务）
  assert.equal(fs.statSync(log).size, LOG_SIZE, `.1 写失败后主日志被截断（size=${fs.statSync(log).size}，整份日志清零且零备份）`);
  assert.ok(!fs.statSync(log + '.1').isFile(), '失败路径不得产出假备份文件');
  assert.equal(errs.length, 1, `应打一条诊断日志，实际 ${errs.length} 条`);
  assert.ok(errs[0].includes('日志轮转失败(备份未写入，跳过截断)'), '诊断日志未按合同措辞：' + errs[0]);
  fs.rmSync(root, { recursive: true, force: true });
}

// ===== B. 失败路径：.1 不可写（0444 → EACCES）→ 主文件必须原样保留 =====
if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  const root = mkCase();
  const log = path.join(root, 'server.log');
  seedLog(log);
  fs.writeFileSync(log + '.1', 'OLD-BACKUP');
  fs.chmodSync(log + '.1', 0o444); // 非 root 下覆盖写必失败
  const errs = captureErr(() => rotateLogIfNeeded(log));
  assert.equal(fs.statSync(log).size, LOG_SIZE, `.1 不可写时主日志被截断（size=${fs.statSync(log).size}）`);
  assert.equal(errs.length, 1, `应打一条诊断日志，实际 ${errs.length} 条`);
  assert.ok(errs[0].includes('日志轮转失败(备份未写入，跳过截断)'), '诊断日志未按合同措辞：' + errs[0]);
  fs.rmSync(root, { recursive: true, force: true });
}

// ===== C. 对照：正常路径（.1 可写）契约不回退——备份 2MB/0600 带尾部标记，主文件截 0 =====
{
  const root = mkCase();
  const log = path.join(root, 'server.log');
  seedLog(log);
  rotateLogIfNeeded(log);
  assert.equal(fs.existsSync(log + '.1'), true, '正常路径必须生成 .1');
  const bak = fs.statSync(log + '.1');
  assert.equal(bak.size, 2 * MB, '.1 应为尾部 2MB');
  assert.equal(bak.mode & 0o777, 0o600, '.1 应为 0600');
  assert.ok(fs.readFileSync(log + '.1').includes(Buffer.from(MARKER.trim())), '.1 应含尾部标记');
  assert.equal(fs.statSync(log).size, 0, '正常路径主文件应被 truncate 为 0');
  fs.rmSync(root, { recursive: true, force: true });
}

// ===== D. 基线不回退：未超容量不轮转、文件缺失不抛 =====
{
  const root = mkCase();
  const log = path.join(root, 'small.log');
  fs.writeFileSync(log, 'x');
  rotateLogIfNeeded(log);
  assert.equal(fs.existsSync(log + '.1'), false, '未超容量不应轮转');
  rotateLogIfNeeded(path.join(root, 'definitely-missing.log')); // 缺失不抛
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('PASS LOGROTATE-FAIL-PATH: .1 目录/不可写 → 主日志原样保留并按合同报「备份未写入，跳过截断」；正常路径 2MB/0600 备份与截 0 契约不回退');
