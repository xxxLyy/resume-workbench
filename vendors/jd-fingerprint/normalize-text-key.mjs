// 来源: career-ops-hq/career-ops @ 090f787e tracker-parse.mjs normalizeTextKey（MIT）
// 公司名归一化键：NFKC + 小写 + 剥组合记号 + 仅保字母/记号/数字。
// 与上游的一处差异：剥组合点用的是 U+0300–U+036F **范围**（上游只剥单个 U+0307）。
// 范围版够不到 NFKC 下仍是单一预组码位的 ż/ė/ġ（FP-8 断言 Żubr ≠ Zubr 即此保护）。
// 换 ICU 版本时若该断言转红，说明 NFKC 开始分解这些字母，需把范围收窄回单点。
export function normalizeTextKey(value, separator = '') {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    // 剥组合点 U+0307：'İ'.toLowerCase() 产生 i+U+0307，不剥则 İstanbul/Istanbul 键不同。
    // 不做 NFD：NFKC 下 ż/ė/ġ 是单一预组码位，此 replace 够不到它们的点（保护性结构）。
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, separator)
    .trim();
}
