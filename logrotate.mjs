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
    try { fs.writeFileSync(file + '.1', buf, { mode: 0o600 }); } catch {}
    try { fs.chmodSync(file + '.1', 0o600); } catch {}   // 轮转副本同为主日志权限（2026-10-19 审查 ⚪-6）
    fs.truncateSync(file, 0);
  } catch (e) { console.error('日志轮转失败: ' + e.message); }
}
