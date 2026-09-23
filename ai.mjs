// ai.mjs — AI 辅助的 prompt 构建与响应解析（纯函数，无网络依赖）
export function buildRewrite(text, instruction) {
  return {
    sys: '你是简历文字编辑助手。按用户指令改写给定段落。只输出改写后的文字本身，不要解释、不要引号包裹、不要Markdown。保持事实不变，不编造数字和经历；保持原有的换行与条目结构。',
    user: `【原文】\n${text}\n\n【指令】\n${instruction}`
  };
}

export function buildChat(docText) {
  return `你是简历编辑助手。用户会告诉你想怎么改简历。你的输出只能是二者之一（不要任何其它文字、不要 Markdown 围栏）：
1）需要修改文档时，输出 JSON 数组，每个元素一条修改：
[{"before":"文档中现有的原文片段（必须逐字，不超过80字）","after":"改后的文字","note":"这条改的什么","context":"可选：before 前后 20 字上下文，用于区分重复文本"}]
最多 5 条，只给真正需要改的；保持事实不变，不编造数字和经历。
2）用户在闲聊、提问或要求不明确时，输出单个对象：{"reply":"简短中文回答"}

【当前简历全文】
${docText}`;
}

// S2：体检/匹配报告解析（报告契约：summary 必填，score 缺省 null，items/changes 缺省 []；坏输出返回 null）
export function parseReport(raw) {
  try {
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const data = JSON.parse(cleaned);
    if (!data || typeof data.summary !== 'string' || !data.summary) return null;
    return {
      score: typeof data.score === 'number' ? data.score : null,
      summary: data.summary,
      scoreBasis: typeof data.scoreBasis === 'string' ? data.scoreBasis : '',  // W2：评分口径透传
      items: Array.isArray(data.items) ? data.items.filter((s) => typeof s === 'string') : [],
      changes: Array.isArray(data.changes)
        ? data.changes.filter((c) => c && typeof c.before === 'string' && typeof c.after === 'string' && c.before && c.after)
            .map((c) => ({ before: c.before, after: c.after, note: typeof c.note === 'string' ? c.note : '' }))
        : []
    };
  } catch {
    return null;
  }
}

// S2：简历体检 prompt（full=七维全面 / quant=只聚焦量化成果，便宜版）
export function buildReview(docText, mode) {
  const sys = mode === 'quant'
    ? '你是简历量化专家。只聚焦"量化成果"体检：找出缺少数字/比例/规模的表达并给量化改写建议（用【建议补充：xx】占位，不编造事实）。只输出 JSON（不要任何其它文字）：{"score":0-100,"summary":"一句话总评","scoreBasis":"评分口径一句话（不得暗示录用概率）","items":["【量化】问题：一句话"],"changes":[{"before":"文档中现有原文片段（必须逐字，不超过80字）","after":"改后的文字","note":"这条改的什么"}]} changes 最多 5 条。'
    : '你是简历体检专家。七个维度逐项评分：【结构】【量化】【动词】【冗余】【ATS】【重复】【一致性】（重复=同义表达重复出现，一致性=日期/术语前后一致）。只输出 JSON（不要任何其它文字）：{"score":0-100,"summary":"一句话总评","scoreBasis":"评分口径一句话（不得暗示录用概率）","items":["【维度】x/10：一句话诊断"],"changes":[{"before":"文档中现有原文片段（必须逐字，不超过80字）","after":"改后的文字","note":"这条改的什么"}]} changes 最多 5 条，只给真正需要改的。';
  return { sys, user: `【当前简历全文】\n${docText}` };
}

// S2：JD 匹配度分析 prompt（W2：四段式 + 区分两类缺口）
export function buildMatch(docText, jd) {
  return {
    sys: '你是简历与职位匹配分析师。对照 JD 逐条找差距：先区分【有但未表达】（简历有相关经历但没写清楚）与【真缺】（确实没有）两类缺口。每条按四段输出：【要求】→【简历证据】→【缺口】→【建议】。只输出 JSON（不要任何其它文字）：{"score":0-100 匹配度,"summary":"一句话总评","scoreBasis":"匹配度口径一句话（不得暗示录用概率）","items":["【要求】… →【简历证据】… →【缺口】（有但未表达/真缺）… →【建议】…"],"changes":[{"before":"文档中现有原文片段（必须逐字，不超过80字）","after":"改后的文字","note":"这条改的什么"}]} changes 最多 5 条。',
    user: `【目标职位 JD】\n${jd}\n\n【当前简历全文】\n${docText}`
  };
}

// 解析 LLM 输出：修改数组 或 {"reply":...} 对象；坏输出返回 null
export function parseChanges(raw) {
  try {
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const data = JSON.parse(cleaned);
    if (Array.isArray(data)) {
      return {
        changes: data.filter((c) => c && typeof c.before === 'string' && typeof c.after === 'string' && c.before.length > 0 && c.after.length > 0 && c.before !== c.after)
          .map((c) => ({
            before: c.before, after: c.after,
            note: typeof c.note === 'string' ? c.note : '',
            // 重复文本消歧：位置序号或上下文片段（模型可选提供）
            occurrence: Number.isInteger(c.occurrence) && c.occurrence >= 0 ? c.occurrence : undefined,
            context: typeof c.context === 'string' && c.context ? c.context.slice(0, 80) : undefined
          }))
      };
    }
    if (data && typeof data.reply === 'string') return { reply: data.reply };
    return null;
  } catch {
    return null;
  }
}
