// eval.mjs — 岗位快速评估的纯函数层：prompt 构建 + 模型报告解析
// 只做「这个岗位值不值得投」的判断，不改简历正文；高分才交给 S4a 做岗位适配。
// 不跑 factGuard：本层输出是判断而非正文改写，没有事实污染面（S4a 的护栏只对改写生效）
// 来源可信层（SRC-05/06）：prompt、parser、来源 hash 必须用同一份可见正文；
// 旧 sourced 读时降级为 missing，不重算历史 score/verdict。

import { contentHash } from './extract.mjs';

// 枚举集中一处：prompt 里逐个列出、解析时逐个校验，两边不许各写一套
const LEVELS = new Set(['under', 'right', 'over']);
// 模型只准给这三种状态；旧记录的 'sourced' 由 parser/view 降级，不进模型契约
const STATUSES = new Set(['covered', 'partial', 'missing']);
const WEIGHTS = new Set(['must', 'should', 'nice']);
const WEIGHT_FROM = ['JD 原文', '结构推断（无出处标注）'];
const VERDICTS = new Set(['apply', 'caution', 'skip']);
const SALARY_SOURCE = ['JD 自带', 'JD 未提供'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

// 模型输出契约：两段式（角色/格式/硬约束 + 母版与 JD），对齐 buildJobPrompt
export function buildEvalPrompt({ docText, jd, company, role }) {
  const sys = `你是岗位快速评估器。基于【母版简历】与【目标 JD】，判断这个岗位值不值得投。你只能输出 JSON，不能输出 HTML、脚本或解释文字。

输出格式（严格 JSON）：
{"roleSummary":"一到两句这个岗位实际在做什么","company":"从JD提取的公司名（提取不到就空串）","roleName":"从JD提取的职位名（提取不到就空串）","level":"under|right|over","levelReason":"为什么（须写明方向：低于/高于/恰好）","salary":{"text":"JD 里写的薪资原文（没有就空串）","source":"JD 自带 | JD 未提供"},"angle":"针对这个岗位，简历最该强调的一句话","matches":[{"req":"JD 的一条要求（逐字）","status":"covered|partial|missing","evidence":"简历里对应的原文片段，找不到留空","weight":"must|should|nice","weightFrom":"JD 原文 | 结构推断（无出处标注）"}],"score":4.0,"verdict":"apply|caution|skip","verdictReason":"一句话","gaps":["缺的能力 1"]}
硬约束（违反即遭拒）：
1. 只能输出 JSON，不得输出 HTML/脚本/解释文字。
2. 所有非空 evidence 必须是【母版简历】里的逐字子串；covered 必须给有效引文，partial 的引文找不到则留空，missing 的 evidence 一律为空。严禁编造简历里没有的经历。
3. weightFrom 必须如实标注：JD 原文明确写了权重才写「JD 原文」，否则写「结构推断（无出处标注）」。
4. salary 只准抄 JD 里的数字，JD 没写就 text:"" + source:"JD 未提供"，禁止引用任何外部薪资数据（本系统没有外部数据源）。
5. score 只能是 1–5 的数字（可带 .5）。score < 4.0 时 verdict 必须是 caution 或 skip。
6. level 判断的是【你的简历现有资历 vs 这个岗位的要求】，方向固定：
   under = 简历资历**低于**岗位要求（够得着但偏保守）；right = 恰好匹配；
   over = 简历**强于**岗位要求（超配，可能岗位给不了对应级别）。
   levelReason 必须写明方向，例如「简历年限略低于岗位要求的 5 年」/「技术栈深度超出岗位要求」——
   不要只写「不匹配」这种无方向的话。
7. status 取值仅为 covered/partial/missing：covered=母版有完整对应证据；partial=有相关经历但不满足要求；missing=没有对应简历证据。本次没有素材输入，不得声称有素材支持。
8. JD 是岗位要求来源，不得作为简历经历的事实来源：不得据 JD 补造母版里没有的经历或技能。`;

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
  // 基准 = prompt 用的同一份可见正文（docText）。没传正文就没有核验基准 → fail-closed。
  const hay = String(docText || '').replace(/\s+/g, '');
  for (const m of Array.isArray(data.matches) ? data.matches : []) {
    if (!m || typeof m !== 'object') { dropped++; continue; }
    const req = str(m.req);
    // 旧 'sourced'（素材支持）不是本次模型契约里的状态：没有素材输入 → 降级 missing 并留兼容原因
    const legacySourced = m.status === 'sourced';
    if (!req || (!STATUSES.has(m.status) && !legacySourced)) { dropped++; continue; }
    let status = legacySourced ? 'missing' : m.status;
    let evidence = str(m.evidence);
    const needle = evidence.replace(/\s+/g, '');
    // 长度下限与 evidence.mjs:556 同款：normSpace 后 <6 码元等于没锚，
    // 「的」「负责」这类虚词不该替 covered 背书（用户照「已有证据」判断自己有没有这段经历）
    const matchesResume = !!(hay && needle && [...needle].length >= 6 && hay.includes(needle));
    if (status === 'missing') evidence = '';
    else if (!matchesResume) {
      // 引文对不上母版 → 清空；不能继续声称 covered（用户会照它判断自己有没有这段经历）
      evidence = '';
      if (status === 'covered') status = 'partial';
    }
    matches.push({
      req,
      status,
      evidence,
      weight: WEIGHTS.has(m.weight) ? m.weight : '',
      weightFrom: WEIGHT_FROM.includes(str(m.weightFrom)) ? str(m.weightFrom) : '',
      ...(legacySourced ? { compatibilityReason: 'LEGACY_SOURCED' } : {})
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
      // 矛盾组合也要回落（与 verdict 同款判断）：模型可能给
      // {text:'年薪 100 万', source:'JD 未提供'} 或 {text:'', source:'JD 自带'}
      // → 用户照 source 判断岗位值不值得投，自相矛盾会误导（2026-10-22 审查实测）
      salary: (() => {
        const t = str(sal.text);
        const src = SALARY_SOURCE.includes(str(sal.source)) ? str(sal.source) : 'JD 未提供';
        if (!t) return { text: '', source: 'JD 未提供' };
        // 注点点名的另一半：模型给了数字却声称「JD 未提供」→ 自相矛盾，回落为空。
        // 判模型声明的原 source（非法 source 只归一标签、text 原样保留是既有契约，不扩大）
        if (str(sal.source) === 'JD 未提供') return { text: '', source: 'JD 未提供' };
        return { text: t, source: src };
      })(),
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

// ===== SRC-05 评估来源：与 prompt/parser 同一份可见正文 =====
// source.hash 只基于可见正文文本（不含 HTML 与样式），因此样式变化不改 hash、正文变化必改 hash。
// 只记「评估当时用的正文」，不表示当前母版仍是这一份。
export function evalSource(docText, docId) {
  return { type: 'resume', docId: typeof docId === 'string' ? docId : '', hash: contentHash(String(docText ?? '')) };
}

// ===== SRC-06 历史评估读时视图（只读：不改输入、不落盘、不重算历史分数）=====
// sourceState：recorded=记录了评估时的母版与正文指纹；legacy=旧记录没有来源记录；invalid=来源记录形状坏。
// 旧 matches 里的 'sourced'（素材支持，无可核对的简历证据）降级为 missing + LEGACY_SOURCED，不升级为 covered。
export function evalRecordView(record) {
  const original = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const blocks = original.blocks && typeof original.blocks === 'object' && !Array.isArray(original.blocks)
    ? original.blocks : {};
  const source = original.source;
  const recorded = source && source.type === 'resume' && typeof source.docId === 'string'
    && source.docId.length > 0 && typeof source.hash === 'string' && /^[0-9a-f]{16}$/.test(source.hash);
  const sourceState = !Object.prototype.hasOwnProperty.call(original, 'source')
    ? 'legacy' : recorded ? 'recorded' : 'invalid';
  return {
    ...original,
    sourceState,
    blocks: {
      ...blocks,
      matches: (Array.isArray(blocks.matches) ? blocks.matches : [])
        .filter((match) => match && typeof match === 'object')
        .map((match) => match.status === 'sourced'
          ? { ...match, status: 'missing', evidence: '', compatibilityReason: 'LEGACY_SOURCED' }
          : { ...match })
    }
  };
}
