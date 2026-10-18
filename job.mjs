// job.mjs — 岗位草稿生成：受约束 prompt 构建 + 模型输出 op 解析（纯函数，零网络依赖）
// 纪律：模型只输出「修改操作 JSON」，由程序校验后应用到已知结构；禁止输出 HTML/脚本。
// 每项建议必带：对应章节/项目、修改类型、原文→新文、理由、事实来源、是否需要重点审阅。
const KINDS = new Set(['replace', 'reorder', 'hide', 'add']);
const LEVELS = new Set(['normal', 'important', 'conflict']);

// S4a-T3（设计 §5.1）：素材事实层进 prompt——事实字段与表达层分列；JD 边界声明；brief.degree 三档指令。
// 事实字段标签（与 zone.mjs FACT_KEYS 同键，本地声明避免 job↔zone 循环依赖）。
export const FACT_LABELS = { company: '公司', role: '职位', dates: '日期', education: '学历', metrics: '指标', contribution: '贡献', conditions: '条件', source: '来源' };
const DEGREE_RULES = {
  light: '本轮修改幅度为轻度精简：优先删冗余、合并重复表达，不移动章节与项目顺序。',
  refocus: '本轮修改幅度为聚焦调整：可调整项目顺序与详略、隐藏低相关经历，不做大结构改动。',
  restructure: '本轮修改幅度为结构重组：可调整章节顺序与项目取舍，但事实字段仍不得修改。'
};
const DEGREE_NAMES = { light: '轻度精简', refocus: '聚焦调整', restructure: '结构重组' };

export function buildJobPrompt({ docText, jd, company, role, materials = [], twoPage = true, brief = null, scope = null, feedback = null }) {
  const degree = (brief && DEGREE_RULES[brief.degree]) || DEGREE_RULES.refocus;   // 无 brief 默认 refocus 档
  // S4a-T8：scope = { zone, zoneLabel, digest } 时为局部重生成——sys 加越界禁令，输出格式带 zid 回传要求
  const sys = `你是简历定制编排器。基于【母版简历】与【目标 JD】，输出一组修改操作来定制这个岗位的简历草稿。你只能输出 JSON，不能输出 HTML、脚本或解释文字。

输出格式（严格 JSON）：
{"summary":"一句话说明定制策略","changes":[{"section":"章节名","entry":"条目名（如公司或项目名，可空）","kind":"replace|reorder|hide|add","before":"文档中现有原文片段（逐字，≤80字）","after":"改后文字（kind=reorder/hide 时为空的字符串）","to":"kind=reorder 时的目标位置（top|bottom|上一条|下一条）"${scope ? ',"zid":"目标段落 zid（局部重生成必填，原样返回请求中标注的 zid）"' : ''},"reason":"为什么这样改","source":"母版|素材:素材标题|JD","level":"normal|important|conflict"}],"todos":[{"section":"章节名","question":"缺少什么信息","why":"为什么需要"}]}
${scope ? `\n本次为局部重生成（仅限区域「${scope.zoneLabel}」）：每段已标注 zid，change.zid 原样返回；区域外的段落与章节一律不得触碰，越界即遭拒。\n` : ''}
硬约束（违反即遭拒）：
1. 禁止编造指标、数字、职责、技能、公司、职位、日期、学历。before 中已有的数字必须原样保留。
2. 公司、职位、日期、学历一律不得修改；before/after 不得触碰这些字段所在文本。
3. 不得把团队成果写成未经证实的个人成果；不得为匹配 JD 添加不存在的技能。
4. 允许：精简表达、调整项目顺序、隐藏低相关项目/章节、用【素材】中已验证的表述替换。
5. 每项 replace 的 before 必须逐字出现在文档中；找不到就不要输出。
6. level 规则：普通措辞/排序=normal；隐藏整段经历、改写可能改变原意=important；与其他来源冲突或数字不一致=conflict。
7. 缺少的信息只能写进 todos（待补充），绝不能编造后写进 changes。
8. JD 是岗位要求来源，不得作为经历或技能的事实来源：JD 提到的要求只能用于取舍与措辞，不得据 JD 补造事实。
${twoPage ? '9. 目标两页：优先保留与 JD 最相关的 2-3 个项目，精简重复与低价值细节。' : ''}
${degree}
changes 最多 12 条，todos 最多 6 条。`;

  const matBlock = materials.length
    ? materials.map((m) => {
      const f = (m && m.facts && typeof m.facts === 'object') ? m.facts : {};
      const facts = Object.keys(FACT_LABELS).filter((k) => typeof f[k] === 'string' && f[k]).map((k) => `${FACT_LABELS[k]}：${f[k]}`).join(' / ');
      return `【素材：${m.title}】\n事实：${facts || '（无结构化事实）'}\n表达：${m.brief || ''}\n技术：${m.technical || ''}`;
    }).join('\n\n')
    : '（无已确认素材）';
  // S4a-T9：过往反馈（审阅中拒绝原因 + 长期偏好）进 prompt，避免重蹈
  const feedbackBlock = (Array.isArray(feedback) && feedback.length)
    ? '【过往反馈（用户拒绝过同类建议的原因，务必避免）】\n' + feedback.map((f) => '· ' + f).join('\n') + '\n\n' : '';
  const briefBlock = brief ? [
    '【本次定制要求】',
    Array.isArray(brief.focus) && brief.focus.length ? `重点：${brief.focus.join('、')}` : '',
    Array.isArray(brief.keepProjects) && brief.keepProjects.length ? `必须保留：${brief.keepProjects.join('、')}` : '',
    Array.isArray(brief.deemphasize) && brief.deemphasize.length ? `不希望强调：${brief.deemphasize.join('、')}` : '',
    `修改幅度：${DEGREE_NAMES[brief.degree] || DEGREE_NAMES.refocus}`,
    `页数目标：${brief.pages || 2} 页`
  ].filter(Boolean).join('\n') : '';
  const user = `【目标公司】${company}\n【目标岗位】${role}\n【JD】\n${jd || '（未提供 JD）'}\n\n【已确认素材（只可引用，不可改写事实）】\n${matBlock}\n\n${briefBlock ? briefBlock + '\n\n' : ''}`
    + feedbackBlock
    + (scope
      ? `【全文摘要（上下文参考；只允许修改下方目标区域内段落）】\n${scope.digest}\n\n【目标区域「${scope.zoneLabel}」段落（局部重生成，仅限此区域）】\n${docText}`
      : `【母版简历正文】\n${docText}`);
  return { sys, user };
}

// 解析模型输出为受约束的 op 列表；坏输出返回 null（调用方降级为手动草稿）
// 同时执行确定性事实护栏：改写引入新数字 / 丢失原文数字或日期 → 强制标记 conflict（导出前必须人工处理）
// 捕获负号与中文数量单位（-30% / 12万 / 12 万），供 normNum 归一化；无单位时保持原样（S4B-1）
// 负号必须捕获：`-30%` 若被切成 `30%`，符号丢失会让「-30 → 30」这类改写被误判为「数字原值保留」（漏报）
const NUM_RE = /-?\d+(?:\.\d+)?\s*[千万亿]?\s*%?/g;
export const DATE_TOKEN_RE = /(?:19|20)\d{2}(?:\s*[.\-/年]\s*\d{1,2}(?:\s*月)?)?/g;

// 数字归一化：展开中文数量单位，使 12万 与 120000 判为同一个数字（S4B-1）
// 无单位时保留原字符串——避免 Math.round 把 1.5 变成 2、把 2021.03 变成 2021
export function normNum(n) {
  const s = String(n).trim();
  const m = /^(-?\d+(?:\.\d+)?)\s*(千|万|亿)?\s*(%)?$/.exec(s);
  if (!m) return s;
  if (!m[2]) return m[1] + (m[3] || '');
  return String(Math.round(parseFloat(m[1]) * { 千: 1e3, 万: 1e4, 亿: 1e8 }[m[2]])) + (m[3] || '');
}

// checkLoss（默认 true）：是否检查「丢失方向」。答法要点等提炼场景传 false——
//   要点天然不逐字复述原文，漏数字是精简不是编造；只有「新增原文没有的数字」才是编造。
export function factGuard(c, opts = {}) {
  const notes = [];
  const checkLoss = opts.checkLoss !== false;
  if (c.kind === 'replace') {
    const beforeNums = new Set((c.before.match(NUM_RE) || []).map(normNum));
    const added = [...new Set((c.after.match(NUM_RE) || []).map(normNum))].filter((n) => !beforeNums.has(n));
    if (added.length) notes.push('改写引入原文没有的数字：' + added.join('、') + '（请核对来源）');
    if (checkLoss) {
      const norm = (s) => String(s).replace(/\s+/g, '');
      const lostDates = [...new Set(c.before.match(DATE_TOKEN_RE) || [])].filter((d) => !norm(c.after).includes(norm(d)));
      if (lostDates.length) notes.push('原文日期未原值保留：' + lostDates.join('、'));
      // S4B-1：原文数字未在改写后原值保留（经 normNum 归一化，避免 12万/120000 误报）
      const afterSet = new Set((c.after.match(NUM_RE) || []).map(normNum));
      const lostNums = [...new Set((c.before.match(NUM_RE) || []).map(normNum))].filter((n) => !afterSet.has(n));
      if (lostNums.length) notes.push('原文数字未原值保留：' + lostNums.join('、'));
    }
  }
  if (c.kind === 'add' && (c.after.match(NUM_RE) || []).length) {
    notes.push('新增内容含数字，需人工核对来源');
  }
  if (notes.length) {
    c.level = 'conflict';
    c.reason = (c.reason ? c.reason + '；' : '') + '⚠️ ' + notes.join('；');
  }
  return c;
}

export function parseJobOps(raw) {
  let data;
  try {
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    data = JSON.parse(cleaned);
  } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const out = { summary: typeof data.summary === 'string' ? data.summary : '', changes: [], todos: [] };
  const arr = Array.isArray(data.changes) ? data.changes : [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    const kind = KINDS.has(c.kind) ? c.kind : 'replace';
    const before = typeof c.before === 'string' ? c.before.trim() : '';
    const after = typeof c.after === 'string' ? c.after.trim() : '';
    if (kind === 'replace' && (!before || !after || before === after)) continue;
    if ((kind === 'hide' || kind === 'reorder') && !before && !(typeof c.entry === 'string' && c.entry.trim())) continue;
    if (kind === 'add' && !after) continue;
    out.changes.push(factGuard({
      section: typeof c.section === 'string' ? c.section.trim() : '',
      entry: typeof c.entry === 'string' ? c.entry.trim() : '',
      kind, before, after,
      to: typeof c.to === 'string' ? c.to.trim() : '',
      zid: typeof c.zid === 'string' ? c.zid.trim() : '',   // S4a-T8：局部重生成回传的落点 zid（服务端按请求内段落校验）
      reason: typeof c.reason === 'string' ? c.reason.trim() : '',
      source: typeof c.source === 'string' ? c.source.trim() : '',
      level: LEVELS.has(c.level) ? c.level : 'normal'
    }));
  }
  const todos = Array.isArray(data.todos) ? data.todos : [];
  for (const t of todos) {
    if (!t || typeof t.question !== 'string' || !t.question.trim()) continue;
    out.todos.push({
      section: typeof t.section === 'string' ? t.section.trim() : '',
      question: t.question.trim(),
      why: typeof t.why === 'string' ? t.why.trim() : ''
    });
  }
  return out;
}

// 两页建议（导出前提示，纯文本级检查，不代替实际渲染页数）
export function pageSuggestions(lines, { projects = 0, maxBullet = 90 } = {}) {
  const norm = (s) => s.replace(/[\s，。、；：,.;:!！?？]/g, '');
  const seen = new Map();
  for (const l of lines) {
    if (l.length < 12) continue;
    const k = norm(l);
    if (!k) continue;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  const longLines = lines.filter((l) => l.length > maxBullet);
  const out = [];
  if (dups.length) out.push({ key: 'dup', text: `发现 ${dups.length} 处重复表达（如「${dups[0][0].slice(0, 24)}…」），建议合并去重`, count: dups.length });
  if (longLines.length) out.push({ key: 'long', text: `${longLines.length} 条要点超过 ${maxBullet} 字，建议压缩到一行内`, count: longLines.length });
  if (projects > 3) out.push({ key: 'projects', text: `项目经历 ${projects} 个，建议只保留与目标岗位最相关的 2-3 个（可用左侧导航隐藏其余）`, count: projects });
  return out;
}
