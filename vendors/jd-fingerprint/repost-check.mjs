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

/**
 * 宽松日期解析：ISO（含 Z，按 UTC 精确解析）或工作台 'YYYY-MM-DD-hhmmss-ms' 本地格式。
 * 后者必须拼成带时间分量的本地串再 Date.parse —— 只取前 10 位会按 UTC 午夜解析，
 * 在东八区把当天所有记录坍缩到本地 08:00，90 天窗口边界日误差可达 -16h ~ +8h。
 */
function parseAnyDate(s) {
  if (!s) return NaN;
  let t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  const m = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})/.exec(s);
  if (m) return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`);
  if (s.length >= 10) { t = Date.parse(s.slice(0, 10) + 'T00:00:00'); if (!Number.isNaN(t)) return t; }
  return NaN;
}

/**
 * 新 JD 与历史记录比对，产出提醒（纯函数）。
 * records: [{ jd?, jdFp?, company?, dateStr?, kind: 'draft'|'app', label?, link?, status? }]
 * opts: { newCompany?, newLink?, threshold?, windowDays?, today? }
 * 返回 [{ kind: 'draft'|'app'|'eval', byLink, label, dateStr, score, sameCompany, repost, status?, evalScore?, evalVerdict? }]
 *   kind = 记录原始来源（draft 建过草稿 / app 投递记录）；byLink = 是否由 link 精确匹配命中
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
    const sameCompany = !!newCompany && normalizeTextKey(r.company || '') === newCompany;
    const rfp = r.jdFp || fingerprintText(r.jd || '');
    const score = rfp ? similarity(fp, rfp) : 0;
    // 路 b：link 精确相等，不受窗口限制。
    // kind 必须是 r.kind 的原始来源（draft=建过草稿 / app=投递记录）——用 'link' 当 kind 会让
    // 上层文案把「从未投递的草稿」说成「已投递」（2026-10-18 审查 🔴 问题 1）。
    // byLink 单独标记命中方式；score 用实测相似度（有 JD 时），无 JD 时按同源链接记 1。
    // repost 取 sameCompany —— HR 把同一链接重发给同公司是最常见的重发形态，不能在这里丢标记。
    if (r.link && opts.newLink && r.link === opts.newLink) {
      hints.push({ kind: r.kind || 'draft', byLink: true, label: r.label || '', dateStr: r.dateStr || '', score: rfp ? score : 1, sameCompany, repost: sameCompany, status: r.status, evalScore: r.score, evalVerdict: r.verdict });
      continue;                              // 已记一条，不重复走相似路径
    }
    const t = parseAnyDate(r.dateStr);
    if (Number.isNaN(t) || t < cutoff) continue;
    if (!rfp) continue;                     // 历史条目不可指纹 → 跳过
    if (score < threshold) continue;
    hints.push({ kind: r.kind, byLink: false, label: r.label || '', dateStr: r.dateStr || '', score, sameCompany, repost: sameCompany, status: r.status, evalScore: r.score, evalVerdict: r.verdict });
  }
  return hints;
}

/**
 * dupHints → todo 条目（纯函数，与 findDupHints 同文件，保证渲染层可被测试直接导入）。
 * 文案口径（2026-10-18 审查 🔴 问题 1）：只按 kind 的原始来源说话，从不把草稿说成已投递。
 *   kind='draft' → 建过草稿；kind='app' → 已投递（带 status）；kind='eval' → 评估过（带评分与结论）。
 *   byLink=true → 同一链接（额外标注来源）。
 */
export function fpTodo(dupHints) {
  if (!dupHints || !dupHints.length) return [];
  // 按相似度降序：slice(0,3) 取最高的 3 条。原实现取 [0]（输入顺序第一条），多条命中时向低报。
  const ranked = dupHints.slice().sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, 3).map((h) => {
    // status 已是「已投递」时不重复拼接 —— /app/add 的默认 status 就是「已投递」，
    // 直接拼会输出「已投递·已投递」（2026-10-18 端到端实测确认）。
    // kind='eval' → 评估过（带分数与结论）。评估记录是「用户已经看过这个岗位」的独立一类：
    // 沿用 draft/app 的文案会把「只评估过、没建草稿」说成「建过草稿」（与 🔴 问题 1 同源的口径错误）。
    const what = h.kind === 'app' ? '已投递' + (h.status && h.status !== '已投递' ? '·' + h.status : '')
      : h.kind === 'eval' ? '评估过 ' + h.evalScore + ' 分（' + (h.evalVerdict || '') + '）'
        : '建过草稿';
    return `${h.label}（${String(h.dateStr).slice(0, 10)} ${h.byLink ? '同一链接·' + what : what}${h.repost ? '，疑似重发' : ''}）`;
  }).join('；');
  // 百分比只对「真的比过指纹」的命中负责：纯 link 命中的 score 是退化值 1，不是相似度，
  // 写进文案等于谎称指纹命中（2026-10-18 端到端实测：历史 app 记录 jd 为空仍显示 100%）。
  const fpScores = ranked.filter((h) => !h.byLink).map((h) => h.score);
  const why = fpScores.length
    ? 'JD 内容指纹命中历史记录（最高相似度 ' + Math.round(Math.max(...fpScores) * 100) + '%），请确认是否仍要适配'
    : '相同 JD 链接命中历史记录，请确认是否仍要适配';
  return [{ section: '岗位信息', question: '疑似重复职位：' + top, why, resolved: false }];
}
