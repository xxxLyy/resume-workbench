// eval.mjs — 岗位快速评估的纯函数层：prompt 构建 + 模型报告解析
// 只做「这个岗位值不值得投」的判断，不改简历正文；高分才交给 S4a 做岗位适配。
// 不跑 factGuard：本层输出是判断而非正文改写，没有事实污染面（S4a 的护栏只对改写生效）

// 枚举集中一处：prompt 里逐个列出、解析时逐个校验，两边不许各写一套
const LEVELS = new Set(['under', 'right', 'over']);
const STATUSES = new Set(['covered', 'sourced', 'partial', 'missing']);
const WEIGHTS = new Set(['must', 'should', 'nice']);
const WEIGHT_FROM = ['JD 原文', '结构推断（无出处标注）'];
const VERDICTS = new Set(['apply', 'caution', 'skip']);
const SALARY_SOURCE = ['JD 自带', 'JD 未提供'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// 模型输出契约：两段式（角色/格式/硬约束 + 母版与 JD），对齐 buildJobPrompt
export function buildEvalPrompt({ docText, jd, company, role }) {
  const sys = `你是岗位快速评估器。基于【母版简历】与【目标 JD】，判断这个岗位值不值得投。你只能输出 JSON，不能输出 HTML、脚本或解释文字。

输出格式（严格 JSON）：
{"roleSummary":"一到两句这个岗位实际在做什么","company":"从JD提取的公司名（提取不到就空串）","roleName":"从JD提取的职位名（提取不到就空串）","level":"under|right|over","levelReason":"为什么（须写明方向：低于/高于/恰好）","salary":{"text":"JD 里写的薪资原文（没有就空串）","source":"JD 自带 | JD 未提供"},"angle":"针对这个岗位，简历最该强调的一句话","matches":[{"req":"JD 的一条要求（逐字）","status":"covered|sourced|partial|missing","evidence":"简历里对应的原文片段","weight":"must|should|nice","weightFrom":"JD 原文 | 结构推断（无出处标注）"}],"score":4.0,"verdict":"apply|caution|skip","verdictReason":"一句话","gaps":["缺的能力 1"]}
硬约束（违反即遭拒）：
1. 只能输出 JSON，不得输出 HTML/脚本/解释文字。
2. evidence 必须是【母版简历】里的逐字子串，找不到就写空串并把该条 status 判 missing/partial——严禁编造简历里没有的经历。
3. weightFrom 必须如实标注：JD 原文明确写了权重才写「JD 原文」，否则写「结构推断（无出处标注）」。
4. salary 只准抄 JD 里的数字，JD 没写就 text:"" + source:"JD 未提供"，禁止引用任何外部薪资数据（本系统没有外部数据源）。
5. score 只能是 1–5 的数字（可带 .5）。score < 4.0 时 verdict 必须是 caution 或 skip。
6. level 判断的是【你的简历现有资历 vs 这个岗位的要求】，方向固定：
   under = 简历资历**低于**岗位要求（够得着但偏保守）；right = 恰好匹配；
   over = 简历**强于**岗位要求（超配，可能岗位给不了对应级别）。
   levelReason 必须写明方向，例如「简历年限略低于岗位要求的 5 年」/「技术栈深度超出岗位要求」——
   不要只写「不匹配」这种无方向的话。
6. status 取值：covered=母版有完整对应证据；sourced=JD 要求但母版无对应，仅作岗位事实列出；partial=有相关经历但不满足要求；missing=完全没有。
7. JD 是岗位要求来源，不得作为简历经历的事实来源：不得据 JD 补造母版里没有的经历或技能。`;

  const user = `【目标公司】${company || ''}\n【目标岗位】${role || ''}\n【JD】\n${jd || '（未提供 JD）'}\n\n【母版简历正文】\n${docText || ''}`;
  return { sys, user };
}

// 解析模型报告为受约束结构；坏输出返回 ok:false（调用方降级），绝不抛异常
export function parseEvalReport(raw, { docText = '' } = {}) {
  const fail = (reason) => ({ ok: false, report: null, dropped: 0, reason });
  let data;
  try {
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    data = JSON.parse(cleaned);
  } catch { return fail('模型输出不是合法 JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('模型输出不是 JSON 对象');

  // score 是这个功能的全部结论：非数字或越界一律整份作废。猜一个分数交出去，
  // 用户会照着它决定投不投——错分的代价远大于这一次评估白做。
  // 范围写成 !(x>=1 && x<=5) 而非 x<1||x>5：后者对 NaN 全为 false，会把 NaN 放行。
  const score = data.score;
  if (typeof score !== 'number' || !(score >= 1 && score <= 5)) return fail('score 必须是 1–5 的数字，实际 ' + JSON.stringify(score ?? null));

  // matches 逐条丢弃而不是整份作废：一条畸形不废掉其余有用的匹配信息
  let dropped = 0;
  const matches = [];
  for (const m of Array.isArray(data.matches) ? data.matches : []) {
    if (!m || typeof m !== 'object') { dropped++; continue; }
    const req = str(m.req);
    if (!req || !STATUSES.has(m.status)) { dropped++; continue; }
    // evidence 子串验证（第二道护栏，与 S4a 的「before 必须逐字出现在文档中」同口径）：
    // 只有 status='covered' 声称「简历原文里有这条证据」，才需要验证。
    // 模型编一段像简历的话，用户在 UI 上无从分辨——而这份报告的全部意义就是帮他判断
    // 自己有没有这段经历。编造的 evidence 会让用户误以为自己拥有它，与本项目事实护栏的
    // 核心承诺直接相反。验证不过：清空 evidence + 降级 covered→partial（不能继续声称 covered）。
    // sourced 声称来自素材（非简历正文）、partial/missing 本就不声称原文命中，都不验证。
    let status = m.status;
    let evidence = str(m.evidence);
    if (status === 'covered' && evidence && docText) {
      const hay = String(docText).replace(/\s+/g, '');
      const needle = evidence.replace(/\s+/g, '');
      if (needle && !hay.includes(needle)) { status = 'partial'; evidence = ''; }
    }
    matches.push({
      req,
      status,
      evidence,
      weight: WEIGHTS.has(m.weight) ? m.weight : '',
      weightFrom: WEIGHT_FROM.includes(str(m.weightFrom)) ? str(m.weightFrom) : ''
    });
  }

  const sal = (data.salary && typeof data.salary === 'object' && !Array.isArray(data.salary)) ? data.salary : {};
  const gaps = [];
  for (const g of Array.isArray(data.gaps) ? data.gaps : []) {
    const t = str(g);
    if (t) gaps.push(t);
  }

  return {
    ok: true,
    dropped,
    reason: '',
    report: {
      roleSummary: str(data.roleSummary),
      company: str(data.company),
      roleName: str(data.roleName),
      level: LEVELS.has(data.level) ? data.level : 'right',          // 非法档位回落中性档，不丢报告
      levelReason: str(data.levelReason),
      salary: { text: str(sal.text), source: SALARY_SOURCE.includes(str(sal.source)) ? str(sal.source) : 'JD 未提供' },
      angle: str(data.angle),
      matches,
      score,
      // 矛盾组合也要回落，不能只管「枚举外」：
      // 模型可能给出 score=3.5 + verdict='apply'（prompt 硬约束第 5 条禁止，但模型不听是常态）。
      // 用户是照 verdict 决定投不投的，一份自相矛盾的报告会误导他——与「错分代价远大于白做
      // 一次」是同一个判断标准。score 是已校验过的可靠值，verdict 可由它无损推导，故以 score 为准。
      verdict: (() => {
        const byScore = score >= 4 ? 'apply' : score >= 3 ? 'caution' : 'skip';
        return VERDICTS.has(data.verdict) && !(score < 4 && data.verdict === 'apply') ? data.verdict : byScore;
      })(),
      verdictReason: str(data.verdictReason),
      gaps
    }
  };
}
