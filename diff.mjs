// diff.mjs — 行级差异（纯函数，零依赖）
// 正文提取统一走 extract.mjs（单一出口），本模块只保留差异算法。
export { docToLines } from './extract.mjs';
import { docToLines } from './extract.mjs';

// 标准 LCS DP：[{type:'same'|'del'|'ins', text}]（简历百行级，O(mn) 无压力）
export function diffLines(a, b) {
  const n = a.length, m = b.length;
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

// 便捷：直接从两份 HTML 出 diff（供版本对比页复用统一提取）
export function diffHtml(aHtml, bHtml, opts) {
  return diffLines(docToLines(aHtml, opts), docToLines(bHtml, opts));
}
