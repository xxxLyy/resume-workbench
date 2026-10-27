// diff.mjs — 行级差异（纯函数，零依赖）
// 正文提取统一走 extract.mjs（单一出口），本模块只保留差异算法。
export { docToLines } from './extract.mjs';
// 标准 LCS DP：[{type:'same'|'del'|'ins', text}]（简历百行级，O(mn) 无压力）
export function diffLines(a, b) {
  const n = a.length, m = b.length;
  // AUD-17：分配前设规模界限。dp 是 (n+1)×(m+1) 的普通数组 —— 外部输入没有行数上限，
  // 巨大矩阵会直接吃光进程内存（分配后才拒绝等于没拒绝）。
  // 简历是百行级（真实样本约 60 行），远低于此；超限如实报错，不做静默降级。
  const MAX_CELLS = 500000;
  if ((n + 1) * (m + 1) > MAX_CELLS) {
    throw new Error(`差异规模超限：${n} 行 × ${m} 行 = ${(n + 1) * (m + 1)} 格（上限 ${MAX_CELLS}）`);
  }
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: a[i++] });
    else out.push({ type: 'ins', text: b[j++] });
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'ins', text: b[j++] });
  return out;
}
