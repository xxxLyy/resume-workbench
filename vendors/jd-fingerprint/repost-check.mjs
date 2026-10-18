// 自写薄壳（设计 §3）：career-ops detect-reposts 的国内场景两路化——
// 同公司窗口内相似 = 疑似重发；任意来源相似 = 重复提醒。纯函数，无 IO。
import { fingerprintText, similarity } from './fingerprint-core.mjs';
import { normalizeTextKey } from './normalize-text-key.mjs';

// 阈值 0.90 —— 由 5 条真实 Boss直聘 JD 校准确定（2026-10-18，矩阵见计划文档）：
//   跨职位最高 0.6406（两条语义高度重叠的数据标注 JD，是真实数据里最难区分的一对）
//   字符扰动 1%  0.9063
//   页脚噪声     0.9219（Boss直聘 UI 文案：微信扫码分享/举报/全角空格）
//   字符扰动 4%  0.8906（不命中 = 预期，轻度改写漏报优于误报）
// 取 0.90：距跨职位仍有 0.26 余量（误报风险低），同时能拓到页脚噪声与 1% 字符扰动。
export const FP_THRESHOLD = 0.90;
export const FP_WINDOW_DAYS = 90;

/** 宽松日期解析：ISO 或工作台 'YYYY-MM-DD-hhmmss-ms' 格式 */
function parseAnyDate(s) {
  if (!s) return NaN;
  let t = Date.parse(s);
  if (Number.isNaN(t) && s.length >= 10) t = Date.parse(s.slice(0, 10));
  return t;
}

/**
 * 新 JD 与历史记录比对，产出提醒（纯函数）。
 * records: [{ jd?, jdFp?, company?, dateStr?, kind: 'draft'|'app', label?, link?, status? }]
 * opts: { newCompany?, newLink?, threshold?, windowDays?, today? }
 * 返回 [{ kind: 'draft'|'app'|'link', label, dateStr, score, sameCompany, repost, status? }]
 */
export function findDupHints(jdText, records, opts = {}) {
  const threshold = opts.threshold ?? FP_THRESHOLD;
  const windowDays = opts.windowDays ?? FP_WINDOW_DAYS;
  const today = opts.today ? new Date(opts.today) : new Date();
  const cutoff = today.getTime() - windowDays * 86400000;
  const fp = fingerprintText(jdText || '');
  if (!fp) return [];                       // 新 JD 不可指纹 → 静默零提醒
  const newCompany = normalizeTextKey(opts.newCompany || '');
  const hints = [];
  for (const r of records) {
    // 路 b：link 精确相等，不受窗口限制
    if (r.link && opts.newLink && r.link === opts.newLink) {
      hints.push({ kind: 'link', label: r.label || '', dateStr: r.dateStr || '', score: 1, sameCompany: normalizeTextKey(r.company || '') === newCompany, repost: false, status: r.status });
      continue;
    }
    const t = parseAnyDate(r.dateStr);
    if (Number.isNaN(t) || t < cutoff) continue;
    const rfp = r.jdFp || fingerprintText(r.jd || '');
    if (!rfp) continue;                     // 历史条目不可指纹 → 跳过
    const score = similarity(fp, rfp);
    if (score < threshold) continue;
    const sameCompany = !!newCompany && normalizeTextKey(r.company || '') === newCompany;
    hints.push({ kind: r.kind, label: r.label || '', dateStr: r.dateStr || '', score, sameCompany, repost: sameCompany, status: r.status });
  }
  return hints;
}
