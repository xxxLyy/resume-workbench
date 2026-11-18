// ai-helper.mjs — 「AI 简历助手」页的后端编排（UPCV AI 四件套本地版；契约见 ai-helper.routes.md）
// 分层与 ai.mjs 同口径：build* 造 prompt（纯函数，无网络依赖）→ llm.mjs chat() 调模型 → parse* 校验输出。
// 复用点（不重造）：
//   ① LLM 调用层 = llm.mjs 的 chat()（含 AI 槽池租约透传 lease、profile 档案索引、超时/单次 POST 语义）；
//   ② 定制改写 prompt 直接委托 ai.mjs 的 buildRewrite（防编造口径同一来源，只追加【待补充】占位约束）；
//   ③ 输出清洗沿用 ai.mjs 的围栏剥离 + 形状校验套路（坏输出返回 null，由路由走 {reply} 兜底，同 /ai/review）。
// 维度口径对齐 buildReview 七维（结构/量化/动词/冗余/ATS/重复/一致性），但 issue 是结构化对象
// （{type,field,description,suggestion}），与 review 的 items 字符串数组形状不同 → 不能直接复用 parseReport。
// 流式（SSE）：UPCV 的 custom-rewrite / improve-writing 是 ReadableStream 流式 → 本文件提供
// customRewriteStream / improveWritingStream 两个 async generator（底层=llm.mjs streamChat），
// prompt 与非流式版逐字节一致（同一 build* 来源）；check / improve-all 按 UPCV 契约保持非流式。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, streamChat } from './llm.mjs';
import { buildRewrite } from './ai.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
// 与 server.mjs 同一口径：RESUME_ROOT 优先，缺省=脚本目录。ctx.root 可显式覆盖（测试隔离用）。
const defaultRoot = () => process.env.RESUME_ROOT || APP_ROOT;

// 输入护栏：prompt 侧先截断，路由侧仍要校验必填（双层）。
const TEXT_MAX = 20000;      // 简历正文体量：超出部分不进 prompt（护 token）
const REQ_MAX = 200;         // 改写要求上限（与前端输入框 maxlength 一致）
const ISSUE_CAP = 20;        // UPCV 契约：issues ≤ 20 条
const clip = (s, n) => String(s ?? '').slice(0, n);

// 防编造统一口径（四个 prompt 共用一段，不得漂移）：
// 只基于输入文本的事实；缺信息的位置输出【待补充】占位，不造经历/数字/头衔/日期。
const NO_FABRICATE = '只允许基于输入文本的事实：不得新增或夸大经历、公司、职位、数字、日期、技能；'
  + '需要补充但原文没有的信息，在对应位置输出【待补充】占位，不要编造填补。';

// ===== ① 智能检查（对应 UPCV POST /api/resume/smart-check）=====
// 请求 {text} → {issues:[{type:'error'|'warning',field,description,suggestion,fixed:false}]}，≤20 条
export function buildSmartCheck(text) {
  return {
    sys: '你是简历体检专家。通读简历文本，找出值得修复的问题，最多 ' + ISSUE_CAP + ' 条，按严重度从高到低排序。'
      + '每条问题给四个字段：'
      + 'type：error=事实性问题（日期矛盾、错别字、格式破损、信息缺失、明显夸大）；warning=表达性问题（缺量化、动词弱、冗余、ATS 关键词不足、表达不一致）。'
      + 'field：问题所在的段落或字段名（≤20字，如「工作经历·第二段」「技能清单」）。'
      + 'description：一句话说清问题（≤60字）。'
      + 'suggestion：一句可执行的修复建议（≤60字）。'
      + '只输出 JSON（不要任何其它文字、不要 Markdown 围栏）：{"issues":[{"type":"error","field":"","description":"","suggestion":""}]}。'
      + '没有问题就输出 {"issues":[]}。'
      + '检查维度（与体检七维同口径）：结构完整性、量化成果、动词强度、冗余表达、ATS 关键词、重复、日期与术语一致性。'
      + NO_FABRICATE,
    user: `【简历全文】\n${clip(text, TEXT_MAX)}`
  };
}

// 解析检查结果：坏输出返回 null（路由回 {reply: raw}，同 /ai/review 的兜底口径）
export function parseIssues(raw) {
  try {
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const data = JSON.parse(cleaned);
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.issues) ? data.issues : null);
    if (!list) return null;
    const normType = (t) => {
      const s = String(t || '').toLowerCase();
      if (s === 'error' || s === '错误') return 'error';
      return 'warning';   // warning/warn/警告/未知值一律归 warning（轻口径，宁轻勿重）
    };
    const issues = list
      .filter((it) => it && typeof it === 'object' && typeof it.description === 'string' && it.description.trim())
      .map((it) => ({
        type: normType(it.type),
        field: clip(String(it.field ?? ''), 20).trim() || '全文',
        description: clip(it.description.trim(), 200),
        suggestion: typeof it.suggestion === 'string' ? clip(it.suggestion.trim(), 200) : '',
        fixed: false   // UPCV 契约：issue 带 fixed 标志；修复状态由前端维护
      }))
      .slice(0, ISSUE_CAP);
    return { issues };
  } catch {
    return null;
  }
}

// ===== ② 一键优化全部（对应 UPCV POST /api/resume/smart-check-improve/all）=====
// 请求 {text, issues} → {rewritten}：把检查出/前端回传的 issue 清单回灌，输出逐条修复后的整段文本
export function buildImproveAll(text, issues) {
  const list = (Array.isArray(issues) ? issues : []).slice(0, ISSUE_CAP)
    .map((it, i) => `${i + 1}.【${clip(it && it.field, 40) || '全文'}】${clip(it && it.description, 200)}${it && it.suggestion ? ` → 修复方向：${clip(it.suggestion, 200)}` : ''}`);
  return {
    sys: '你是简历文字编辑助手。给你一段简历文本和一份问题清单：逐条修复清单中列出的问题，输出修复后的完整文本。'
      + '只输出改写后的文字本身，不要解释、不要引号包裹、不要 Markdown、不要标注改了哪里。'
      + '保持原有的换行与条目结构，未列出的部分原样保留。'
      + NO_FABRICATE,
    user: `【简历全文】\n${clip(text, TEXT_MAX)}\n\n【问题清单】\n${list.length ? list.join('\n') : '（无清单：按简历写作常识做保守的通用优化）'}`
  };
}

// ===== ③ 定制改写（对应 UPCV POST /api/resume/custom-rewrite/stream）=====
// 请求 {text, userRequirement} → {rewritten}。
// 复用 ai.mjs buildRewrite：其 sys 已含「保持事实不变，不编造数字和经历；保持原有换行与条目结构」，
// 这里只在指令尾部追加【待补充】占位约束，不重写整套 prompt。
// 流式版（customRewriteStream）复用本函数同一 prompt：只换传输层，不换提示词。
export function buildCustomRewrite(text, userRequirement) {
  const req = clip(userRequirement, REQ_MAX).trim()
    + '（附加约束：只允许基于原文事实改写；需要补充但原文没有的信息用【待补充】占位。）';
  return buildRewrite(clip(text, TEXT_MAX), req);
}

// ===== ④ 润色（对应 UPCV POST /api/resume/improve-writing/stream）=====
// 请求 {text} → {rewritten}。流式版（improveWritingStream）复用本函数同一 prompt。
export function buildImproveWriting(text) {
  return {
    sys: '你是简历润色专家。在不改变事实与结构的前提下润色整段简历文本：动词更有力、表达更专业、去除冗余、条目更整齐。'
      + '只输出润色后的文字本身，不要解释、不要引号包裹、不要 Markdown。保持原有的换行与条目结构。'
      + NO_FABRICATE,
    user: `【简历全文】\n${clip(text, TEXT_MAX)}`
  };
}

// 纯文本输出清洗：剥 Markdown 围栏；空输出返回 null（路由回 {reply} 兜底）
function cleanText(raw) {
  const s = String(raw ?? '').trim().replace(/^```(?:[\w-]+)?\s*/i, '').replace(/```\s*$/, '').trim();
  return s || null;
}

// ===== 编排函数（路由层调这四个；ctx={root,lease,profile} 全可选）=====
// 返回形状与既有 /ai/* 端点同口径：成功 {issues|rewritten}，模型输出异常时 {reply:raw} 兜底（不抛 502）。
// chat() 抛错（网络/5xx/超时/槽忙）原样上抛，由路由统一 502。

export async function smartCheck(text, { root = defaultRoot(), lease, profile } = {}) {
  const p = buildSmartCheck(text);
  const raw = await chat(root, p.sys, p.user, { lease, profile });
  return parseIssues(raw) || { reply: String(raw ?? '') };
}

export async function improveAll(text, issues, { root = defaultRoot(), lease, profile } = {}) {
  const p = buildImproveAll(text, issues);
  const raw = await chat(root, p.sys, p.user, { lease, profile });
  const rewritten = cleanText(raw);
  return rewritten ? { rewritten } : { reply: String(raw ?? '') || '（模型未返回改写结果）' };
}

export async function customRewrite(text, userRequirement, { root = defaultRoot(), lease, profile } = {}) {
  const p = buildCustomRewrite(text, userRequirement);
  const raw = await chat(root, p.sys, p.user, { lease, profile });
  const rewritten = cleanText(raw);
  return rewritten ? { rewritten } : { reply: String(raw ?? '') || '（模型未返回改写结果）' };
}

export async function improveWriting(text, { root = defaultRoot(), lease, profile } = {}) {
  const p = buildImproveWriting(text);
  const raw = await chat(root, p.sys, p.user, { lease, profile });
  const rewritten = cleanText(raw);
  return rewritten ? { rewritten } : { reply: String(raw ?? '') || '（模型未返回改写结果）' };
}

// ===== 流式编排（对应 UPCV */stream 两个端点；路由侧 SSE 管道见 ai-helper.routes.md §5）=====
// 返回 async generator：逐段 yield 模型 delta 文本片段（底层 = llm.mjs streamChat）。
// prompt 与非流式版逐字节一致（同一 build* 来源，含 NO_FABRICATE 约束）；不做 cleanText/兜底——
// 流式无法事后整形，{reply} 兜底语义只存在于非流式端点。
// 租约纪律与 chat() 同口径：透传 lease 则 claim/unclaim，缺省则底层 acquire 兜底；
// 消费者中断（for-await break / it.return()）→ generator finally 照放槽——断连 ≠ 泄漏（RES-03 同款）。
// meta（可选）：usage 采集透传，口径同 chat()。

export function customRewriteStream(text, userRequirement, { root = defaultRoot(), lease, meta, profile } = {}) {
  const p = buildCustomRewrite(text, userRequirement);
  return streamChat(root, p.sys, p.user, { lease, meta, profile });
}

export function improveWritingStream(text, { root = defaultRoot(), lease, meta, profile } = {}) {
  const p = buildImproveWriting(text);
  return streamChat(root, p.sys, p.user, { lease, meta, profile });
}
