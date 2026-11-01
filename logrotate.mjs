// logrotate.mjs — 启动/定时 copytruncate。launchd 以 O_APPEND 持有 fd，truncate 后追加安全。
import fs from 'node:fs';
const CAP = 50 * 1024 * 1024, TAIL = 2 * 1024 * 1024;
export function rotateLogIfNeeded(file) {
  if (!file) return;
  let st;
  try { st = fs.statSync(file); } catch { return; }
  if (st.size <= CAP) return;
  try {
    const len = Math.min(TAIL, st.size);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    // 直接以 0600 落盘：先 writeFileSync 再 chmod 的做法在两步之间被杀会留下 0644 的轮转副本
    // 备份写失败（EISDIR/ENOSPC/EACCES…）必须放弃截断（BL-P6-01）：否则备份没写成功就把整份主日志清零。
    // S0 设计口径「失败只 console.error 不影响服务」——保住主日志，等下轮轮转再试。
    try {
      fs.writeFileSync(file + '.1', buf, { mode: 0o600 });
    } catch (e) {
      console.error('日志轮转失败(备份未写入，跳过截断): ' + e.message);
      return;
    }
    try { fs.chmodSync(file + '.1', 0o600); } catch {}   // 轮转副本同为主日志权限（2026-10-19 审查 ⚪-6）
    // 登记不修（复核口径）：上面 stat 取 size 到此处 truncate 之间新写入的日志（launchd 以
    // O_APPEND 持有 fd 追加）既不进 .1 副本也被截断丢弃——copytruncate 固有代价，窗口极小，接受。
    fs.truncateSync(file, 0);
  } catch (e) { console.error('日志轮转失败: ' + e.message); }
}
