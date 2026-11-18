// interview.mjs — 模拟面试会话机（文字版）：题库橱窗 + 会话 CRUD + AI 出题 / 答题提示 / 复盘报告
// 形状复刻自 upcv-features-implementation.md §6（只复刻形状，不调用其接口）：
//   类型三选 comprehensive/professional/hr、questionCap=14、声音 4 项占位（文字版禁用）、
//   GET /api/question-banks 题库橱窗（内置种子）、*/stream 提示/报告 SSE（genHintStream/genReportStream）。
//
// 与既有模块的口径关系：
//   · 持久化：interviews.json（repo 根），读写纪律复刻 server.mjs 的 readJson/writeJson ——
//     根值必须是数组、写前 assertWritable、tmp+rename 原子落盘、0600。本模块自管这张表，
//     不借 server.mjs 的 JSON_FILES（该表不可改）。
//   · AI 调用：llm.mjs 的 chat(root, sys, user, {lease, meta, profile}) —— 只借道不重造：
//     槽池由 llm.mjs 的 aiPool 兜底（或调用方透传 lease），本模块零池化代码。
//   · 诚实红线：报告/提示/出题只允许基于「简历文本 + 职位 JD + 本会话问答」，数字类事实
//     必须来自输入材料；不打分、不排名、不预测录用概率（与 practice.mjs 反馈口径一致）。
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, streamChat, hasLLM, loadProfiles } from './llm.mjs';
import { docToText } from './extract.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));   // 与 server.mjs 同目录 = repo 根
const FILE = path.join(ROOT, 'interviews.json');

// ===== 契约常量（UPCV §6 形状复刻）=====
export const QUESTION_CAP = 14;
export const INTERVIEW_TYPES = ['comprehensive', 'professional', 'hr'];
export const TYPE_LABELS = { comprehensive: '综合面试', professional: '专业面试', hr: 'HR 面试' };
// 文字版：声音是占位项（UPCV 用 Qwen-Audio realtime，本地文字版不开）。仍收存用户选择，字段只为前向兼容。
export const VOICES = [
  { id: 'zh-female', label: '中文女声', enabled: false },
  { id: 'zh-male', label: '中文男声', enabled: false },
  { id: 'en-female', label: '英文女声', enabled: false },
  { id: 'en-male', label: '英文男声', enabled: false },
];
// UPCV /api/mock-interview/config 的形状：{enabled, voices, interviewTypes, questionCap}。
// enabled=true 表示文字版可用；voices[].enabled=false 逐条表达「占位禁用」。
export const getConfig = () => ({
  enabled: true,
  voices: VOICES.map((v) => ({ ...v })),
  interviewTypes: [...INTERVIEW_TYPES],
  questionCap: QUESTION_CAP,
});
export const NO_MODEL_HINT = '未配置大模型：请到「设置」完成模型配置后再开始面试';

// ===== 题库橱窗（UPCV §6 GET /api/question-banks 形状复刻）=====
// 内置种子：题库是内容数据不是用户数据——不落 interviews.json 外的存储、不接外部服务、
// 不做题库持久化；改题 = 改这份代码。卡片字段照 UPCV：
//   {id,slug,type:'POSITION',title,category:'TECH'|'GENERAL',intro,questionCount,
//    isFeatured,banner,previewQuestions:[{question,answerPoints}],updatedAt}
// banner 本地版恒 null（无 OSS 图）：前端用 slug 派生占位色块。
// questions = 全量题目序列（橱窗 previewQuestions 只切前 N 条）；answerPoints 是出题参考
// 要点：它随卡片下发做预览，也进提示流 prompt 作「出题参考」（种子内容，非模型编造）。
const QB_UPDATED = '2026-11-18T00:00:00.000Z';
const qb = (id, slug, title, category, intro, isFeatured, questions) => ({
  id, slug, type: 'POSITION', title, category, intro,
  questionCount: questions.length, isFeatured: !!isFeatured, banner: null,
  questions, updatedAt: QB_UPDATED,
});
export const QUESTION_BANKS = [
  qb(1, 'frontend-engineer', '前端工程师', 'TECH',
    '覆盖框架原理、浏览器机制与工程化的高频前端面试题，适合初中级前端岗位自测。', true, [
      { question: '请讲讲浏览器从输入 URL 到页面渲染完成经历了哪些关键阶段？',
        answerPoints: ['DNS 解析与 TCP/TLS 建连', 'HTML 解析构建 DOM 与 CSSOM', '渲染树、布局与绘制分层', 'JS 阻塞与 async/defer 差异'] },
      { question: 'React 的 setState 为什么是异步的？批量更新发生在什么时机？',
        answerPoints: ['性能：合并多次更新减少重渲染', '事件循环与微任务时机', 'React 18 自动批处理范围', '函数式更新拿到最新 state'] },
      { question: '解释闭包，并举一个你在项目里实际用到闭包的场景。',
        answerPoints: ['定义：函数记住其词法作用域', '真实项目场景（防抖/缓存/私有变量）', '内存占用与释放注意点'] },
      { question: 'HTTP 缓存的强缓存与协商缓存分别由哪些头控制？',
        answerPoints: ['Cache-Control / Expires', 'ETag 与 If-None-Match', 'Last-Modified 与 If-Modified-Since', 'max-age=0 与 no-cache 区别'] },
      { question: 'Vue 与 React 的响应式更新机制有什么本质差异？',
        answerPoints: ['Proxy 依赖收集 vs setState 触发 diff', '细粒度更新 vs 组件级重渲染', '编译期优化（Vue3 静态提升 / React Compiler）'] },
      { question: '一次页面白屏或卡顿，你的排查思路是什么？',
        answerPoints: ['先复现与分诊：网络/脚本/渲染', 'DevTools Performance 与火焰图', '长任务拆分、懒加载与缓存', '你真实排查过的一个案例'] },
      { question: '讲讲 Event Loop：宏任务、微任务的执行顺序。',
        answerPoints: ['调用栈清空后先跑微任务队列', 'setTimeout/IO 是宏任务', 'Promise.then/queueMicrotask 是微任务', 'UI 渲染插入在宏任务之间'] },
      { question: '前端工程化里你做过哪些提升构建或产物质量的优化？',
        answerPoints: ['按需加载与代码分割', 'Tree-shaking 与包体积分析', '缓存策略与产物指纹', '你项目里真实做的一项'] },
    ]),
  qb(2, 'backend-engineer', '后端工程师', 'TECH',
    '数据库、缓存、并发与系统设计的高频后端面试题，覆盖服务稳定性与性能取舍。', false, [
      { question: '一条慢 SQL 到你手里，你的定位与优化路径是什么？',
        answerPoints: ['EXPLAIN 看执行计划与索引命中', '区分索引失效/回表/数据量问题', '覆盖索引、联合索引顺序', '你优化过的真实慢查询案例'] },
      { question: 'MySQL 的隔离级别有哪几级？可重复读解决了什么问题、还留什么问题？',
        answerPoints: ['读未提交/读已提交/可重复读/串行化', 'MVCC 快照读与 undo log', '幻读与 next-key lock', '业务里实际遇到过的一致性场景'] },
      { question: 'Redis 缓存穿透、击穿、雪崩的区别与各自解法？',
        answerPoints: ['穿透：布隆过滤器/缓存空值', '击穿：互斥锁/逻辑过期', '雪崩：过期时间加随机抖动', '多级缓存与限流降级'] },
      { question: '接口幂等性你怎么保证？举一个支付或下单场景。',
        answerPoints: ['唯一请求号/幂等键', '数据库唯一约束兜底', '状态机校验防重复流转', '重试与超时补偿策略'] },
      { question: '消息队列消息丢失与重复消费分别怎么防？',
        answerPoints: ['发送确认 + 本地表/事务消息', 'Broker 持久化与副本', '消费端幂等 + 手动 ack', '死信队列与补偿链路'] },
      { question: '怎么设计一个每秒万级的短链/秒杀类接口？说下你的分层思路。',
        answerPoints: ['限流与静态化前置', '缓存扛读、队列削峰写', '库存预热与原子扣减', '降级预案与监控指标'] },
      { question: '分布式锁为什么容易出问题？你实际用过哪种实现？',
        answerPoints: ['SET NX PX + 唯一持有者标识', '锁续期（看门狗）与业务超时', '误删他人锁的校验', 'Redisson/ZK 实现的真实使用'] },
      { question: '一次线上故障从告警到恢复，你的处理流程是什么？',
        answerPoints: ['先止血：回滚/降级/扩容', '定位：日志、链路追踪、变更记录', '复盘：根因与整改项', '你真实处理过的一次故障'] },
    ]),
  qb(3, 'data-analyst', '数据分析师', 'TECH',
    'SQL 取数、指标体系、实验分析到业务结论输出的分析师高频题。', false, [
      { question: '指标某天突然下跌 20%，你的分析框架是什么？',
        answerPoints: ['先验数：口径、埋点、调度是否变了', '维度下钻：渠道/版本/地区/人群', '拆分漏斗定位流失环节', '外部因素：季节、活动、竞品'] },
      { question: '写 SQL：连续 7 天活跃用户的统计思路（说思路即可）。',
        answerPoints: ['去重活跃明细表', '窗口函数或自连判定连续性', '日期差分组数等差数列法', '性能：分区裁剪与预聚合'] },
      { question: 'A/B 实验里样本量不够就提前看结果，有什么问题？',
        answerPoints: ['多重比较放大假阳性', '需事先算最小样本量', 'p 值与置信区间含义', '新奇效应与长跑验证'] },
      { question: '相关不等于因果——举一个你工作里差点误判的例子或常见陷阱。',
        answerPoints: ['混淆变量的存在', '幸存者偏差', '用对照/实验/断点验证因果', '你材料外的真实经历补充'] },
      { question: '给管理层搭一套业务看板，你怎么选北极星指标和护栏指标？',
        answerPoints: ['北极星对齐业务阶段目标', '护栏指标防单一指标优化走偏', '可分解、可行动、可归因', '口径文档与数据 owner'] },
      { question: '用户留存低，你会从哪些角度拆问题？',
        answerPoints: ['分群看留存曲线形态', '新用户激活路径断点', '功能使用深度与频次', '同期群对比排除季节因素'] },
      { question: '一次数据埋点需求，你怎么保证埋点质量？',
        answerPoints: ['埋点文档：事件/属性/触发时机', '上线前抓包验收', '上线后数据波动监控', '口径变更的版本管理'] },
      { question: '把一个分析结论讲给不懂数据的业务方听，你怎么表达？',
        answerPoints: ['先结论后论据', '用业务语言不用统计术语', '图只承载一个观点', '给出可执行的下一步'] },
    ]),
  qb(4, 'qa-engineer', '测试工程师', 'TECH',
    '用例设计、自动化、性能与质量保障体系的测试岗位高频题。', false, [
      { question: '设计一个登录功能的测试用例，你会覆盖哪些维度？',
        answerPoints: ['正常流：正确账号密码', '边界：空值/超长/特殊字符', '安全：SQL 注入/暴力破解/验证码', '异常：网络断开/服务超时'] },
      { question: '自动化测试投入产出比你怎么看？哪些场景不适合自动化？',
        answerPoints: ['回归稳定、重复高频的适合', '界面频繁变动/一次性需求不适合', '分层：接口自动化优先于 UI', '维护成本要算进 ROI'] },
      { question: '线上发现一个漏测的缺陷，复盘时你怎么分析？',
        answerPoints: ['复现路径与影响面', '漏测归因：用例覆盖/需求理解/环境差异', '补充用例进回归集', '流程改进项而非追责'] },
      { question: '性能测试你会关注哪些指标？怎么定压测目标？',
        answerPoints: ['TPS/RT 分位数/错误率', '资源水位：CPU/内存/GC', '目标来自业务量预估', '瓶颈定位到具体层'] },
      { question: '接口测试里依赖下游不可用，你怎么做隔离？',
        answerPoints: ['Mock/桩服务替身', '契约测试', '测试数据独立构造', '环境分层与开关'] },
      { question: '讲讲你对持续集成里质量门禁的理解。',
        answerPoints: ['流水线卡点：单测/静态扫描/接口用例', '覆盖率阈值与增量覆盖', '失败即阻断的纪律', '你真实搭过或用过的一套'] },
      { question: '探索性测试和脚本化测试怎么配合？',
        answerPoints: ['脚本化保回归底线', '探索性找未知风险', '会话制：定章程、记录、汇报', '发现的问题沉淀为新用例'] },
      { question: '版本要发布了但还有中等级缺陷没修完，你怎么处理？',
        answerPoints: ['缺陷分级：严重/一般/建议', '风险评估：影响面与概率', '给出放行/延迟的建议依据', '遗留问题的跟踪闭环'] },
    ]),
  qb(5, 'product-manager', '产品经理', 'GENERAL',
    '需求分析、优先级、沟通推进与复盘的产品岗高频题，偏通用能力考察。', false, [
      { question: '讲一个你从 0 到 1 做过的需求：怎么发现、怎么验证、结果如何？',
        answerPoints: ['需求来源与用户痛点', '验证方式与关键数据', '上线后的真实结果', '用你材料里的真实项目补充'] },
      { question: '需求太多排不过来，你的优先级框架是什么？',
        answerPoints: ['价值 × 成本的评估口径', '对齐当期业务目标', '依赖关系与机会成本', '明确说不的底气与依据'] },
      { question: '研发说你的需求做不了或要砍一半，你怎么处理？',
        answerPoints: ['先问清是成本问题还是方案问题', '一起拆 MVP 找最小闭环', '技术方案可以共创', '不轻易退到「不做」'] },
      { question: '上线后数据不达预期，你的复盘动作是什么？',
        answerPoints: ['预期与实际的差距量化', '归因：判断错/执行偏/外部变', '保留有效部分迭代', '复盘结论同步给相关方'] },
      { question: '怎么向老板要资源推一个他不太看好的方向？',
        answerPoints: ['先对齐他要的目标', '用数据和小步验证说话', '给风险边界与止损点', '用你材料外的真实经历补充'] },
      { question: '竞品抄了你的功能还做得更快，你怎么办？',
        answerPoints: ['冷静看差异与用户反馈', '回到自己的用户与节奏', '差异化点在哪里', '不盲目跟随'] },
      { question: '用户提了一个很具体的功能要求，你怎么判断要不要做？',
        answerPoints: ['听诉求不听方案', '找背后的真实场景', '评估普适性与成本', '给用户一个交代'] },
      { question: '介绍一次跨部门协作最困难的经历及处理。',
        answerPoints: ['冲突点是什么', '换位找对方的目标', '用什么机制推进', '结果与关系修复'] },
    ]),
  qb(6, 'behavioral-general', '通用行为面试', 'GENERAL',
    '自我介绍、动机、协作冲突、职业规划——任何岗位都绕不开的通用题组。', true, [
      { question: '请用两分钟左右做一次自我介绍。',
        answerPoints: ['与岗位相关的三段经历', '关键成果带真实数字', '为什么匹配这个岗位', '控制在两分钟内'] },
      { question: '你为什么想离开现在的公司？',
        answerPoints: ['说发展诉求不抱怨现东家', '与新岗位机会的连接', '真实且不踩雷的表达'] },
      { question: '讲一次你和同事意见严重分歧的经历，最后怎么解决的？',
        answerPoints: ['分歧的具体内容', '你怎么表达与倾听', '达成共识的机制', '结果与关系'] },
      { question: '你近三年最大的失败是什么？你从中学到什么？',
        answerPoints: ['真实失败不包装成「假失败」', '你在其中的责任', '具体改进行动', '后续效果如何验证'] },
      { question: '同时压来几件紧急的事，你怎么处理？',
        answerPoints: ['先确认各方真实期限', '按影响排优先级', '主动同步预期', '你真实处理过的一次'] },
      { question: '你的职业规划是什么？为什么是这个方向？',
        answerPoints: ['3-5 年的能力目标', '与应聘岗位的成长路径重合', '不是职位口号是能力规划'] },
      { question: '讲一次你主动多做一点、超出职责范围的事。',
        answerPoints: ['主动发现的契机', '额外付出的具体动作', '带来的真实影响', '不夸大、可验证'] },
      { question: '你有什么问题想问我们？',
        answerPoints: ['团队当前最大的挑战', '岗位三个月的期望产出', '团队的协作方式', '不问薪资加班等红灯题'] },
    ]),
];

const getBankRaw = (slug) => QUESTION_BANKS.find((b) => b && b.slug === String(slug || '')) || null;
// bankCard：卡片视图 = 落盘字段以外的全部对外形状；preview=N 切前 N 条预览题。
const bankCard = (b, preview) => ({
  id: b.id, slug: b.slug, type: b.type, title: b.title, category: b.category,
  intro: b.intro, questionCount: b.questionCount, isFeatured: b.isFeatured,
  banner: b.banner,
  previewQuestions: b.questions
    .slice(0, Math.max(0, Number.isFinite(preview) ? Math.floor(preview) : 0))
    .map((q) => ({ question: q.question, answerPoints: Array.isArray(q.answerPoints) ? q.answerPoints.slice() : [] })),
  updatedAt: b.updatedAt,
});
// listBanks：橱窗分页。featured 优先（UPCV 橱窗语义），其余按数组声明序（=人工策展序）。
export function listBanks({ page = 1, limit = 12, preview = 2 } = {}) {
  const lim = Math.min(50, Math.max(1, Math.floor(Number(limit)) || 12));
  const pg = Math.max(1, Math.floor(Number(page)) || 1);
  const pv = preview == null ? 2 : Number(preview);   // null/undefined → UPCV 默认 2 条预览；preview=0 显式关预览
  const ordered = QUESTION_BANKS.slice().sort((a, b) => ((b.isFeatured ? 1 : 0) - (a.isFeatured ? 1 : 0)));
  const total = ordered.length;
  const data = ordered.slice((pg - 1) * lim, pg * lim).map((b) => bankCard(b, pv));
  return { ok: true, data, total, page: pg, limit: lim };
}
// getBank：详情态 —— previewQuestions 返回全量题目（含 answerPoints）。
export function getBank(slug) {
  const b = getBankRaw(slug);
  if (!b) return fail(404, '题库不存在（slug 不在内置题库里）');
  return { ok: true, bank: bankCard(b, b.questions.length) };
}

const ANSWER_MAX_CHARS = 4000;      // 与 practice.mjs 作答上限同口径
const RESUME_MAX_CHARS = 12000;     // 简历文本进 prompt 的上限（界内截断，防 token 烧穿）
const JD_MAX_CHARS = 8000;          // 与 server.mjs extractJd 兜底截断同量级
const SESSION_CAP = 50;             // 本地历史上限：最新在前截 50（practice 截 20 的同款收敛）
const SESSION_ID_RE = /^iv-[0-9a-f]{8}$/;

// ===== interviews.json 持久化（复刻 server.mjs readJson/writeJson 纪律）=====
// 根值形状：会话数组。形状错 → 读取降级为空表 + 写路径抛错停写（不静默覆盖用户历史）。
let corruptFlag = false;
function readStore() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(d)) { corruptFlag = true; return []; }
    corruptFlag = false; return d;
  } catch { corruptFlag = true; return []; }
}
function writeStore(list) {
  // 写前校验（server.mjs assertWritable 同款）：文件存在时重读一次，坏形状/坏 JSON 一律停写，
  // 不拿内存里的空表去覆盖用户历史。
  if (fs.existsSync(FILE)) {
    let ok = false;
    try { ok = Array.isArray(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { ok = false; }
    if (!ok || corruptFlag) {
      corruptFlag = true;
      throw Object.assign(new Error('数据文件损坏，已停止写入：interviews.json。请先人工修复或从备份恢复。'), { httpCode: 500, code: 'CORRUPT' });
    }
  } else if (corruptFlag) {
    throw Object.assign(new Error('数据文件损坏，已停止写入：interviews.json。请先人工修复或从备份恢复。'), { httpCode: 500, code: 'CORRUPT' });
  }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });   // 0600 同 server.mjs 口径
  fs.renameSync(tmp, FILE);
}

// ===== 形状守卫（历史数据不可信：坏形状当无记录，与 practice.mjs 同口径）=====
const isSession = (s) => !!(s && typeof s === 'object' && !Array.isArray(s) && SESSION_ID_RE.test(String(s.id || '')));
const sessions = () => readStore().filter(isSession);
const findIdx = (list, id) => list.findIndex((s) => s && s.id === id);

const fail = (status, error) => ({ ok: false, status, error });
const now = () => new Date().toISOString();

// ===== 会话视图（读取侧派生字段不落盘：pending/answeredCount/finished 由 questions+answers 算出）=====
const answeredCount = (s) => (Array.isArray(s.questions) ? s.questions : [])
  .filter((q) => q && q.status === 'answered').length;
const pendingOf = (s) => (Array.isArray(s.questions) ? s.questions : [])
  .find((q) => q && q.status === 'pending') || null;
const finishedOf = (s) => (Array.isArray(s.questions) ? s.questions : []).length >= (s.questionCap || QUESTION_CAP)
  && !pendingOf(s);
export function sessionView(s) {
  if (!isSession(s)) return null;
  const p = pendingOf(s);
  return {
    ...s,
    pending: p ? { index: p.index, question: p.text } : null,
    answeredCount: answeredCount(s),
    skippedCount: (Array.isArray(s.questions) ? s.questions : []).filter((q) => q && q.status === 'skipped').length,
    finished: finishedOf(s),
    hasReport: !!(s.report && typeof s.report === 'object'),
  };
}
export const sessionSummary = (s) => {
  const v = sessionView(s);
  return v && {
    id: v.id, createdAt: v.createdAt, type: v.type, typeLabel: TYPE_LABELS[v.type] || v.type,
    company: v.company || '', role: v.role || '', resumeId: v.resumeId || '', jobRef: v.jobRef || '',
    questionSource: v.questionSource === 'bank' ? 'bank' : 'ai', bankSlug: v.bankSlug || '', bankTitle: v.bankTitle || '',
    asked: v.questions.length, answered: v.answeredCount, cap: v.questionCap || QUESTION_CAP,
    finished: v.finished, hasReport: v.hasReport,
  };
};

export function listSessions() {
  return sessions().map(sessionSummary).filter(Boolean);
}
export function getSession(id) {
  return sessionView(sessions().find((s) => s.id === id) || null);
}
const getRaw = (id) => sessions().find((s) => s.id === id) || null;
const saveRaw = (session) => {
  const list = readStore();
  const i = findIdx(list, session.id);
  if (i < 0) return false;
  list[i] = session;
  writeStore(list);
  return true;
};

// ===== 材料解析：jobRef → applications.json 条目（JD 快照）；resumeId → docs/<id>.html 文本 =====
// JD 在创建时快照进会话（投递记录被删/被改不漂移本会话）；简历按 resumeId 每次现读
// （文档是用户会改的活物，现读才不算过期材料；读不到 → 空文本降级，不假装有简历）。
const loadApps = () => {
  const f = path.join(ROOT, 'applications.json');
  try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
};
const loadMetaMap = () => {
  const f = path.join(ROOT, 'docs-meta.json');
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; } catch { return {}; }
};
const DOC_ID_RE = /^[a-z0-9][a-z0-9-]*$/;   // 与 server.mjs VALID_ID 同口径
const resumeTextOf = (resumeId) => {
  if (!resumeId) return '';
  try {
    const html = fs.readFileSync(path.join(ROOT, 'docs', resumeId + '.html'), 'utf8');
    return docToText(html, { includeHidden: false }).slice(0, RESUME_MAX_CHARS);
  } catch { return ''; }
};
const resumeTitleOf = (resumeId) => {
  const m = loadMetaMap()[resumeId];
  return String((m && (m.tag || m.role)) || resumeId);
};

// ===== CRUD =====
export function createSession({ voice = '', type = '', jobRef = '', resumeId = '', bankSlug = '' } = {}) {
  if (!INTERVIEW_TYPES.includes(type)) {
    return fail(400, '面试类型无效（仅支持 comprehensive / professional / hr）');
  }
  const vid = String(voice || 'zh-female');
  if (voice && !VOICES.some((v) => v.id === vid)) return fail(400, '声音选项无效（文字版为占位项，可不选）');
  jobRef = String(jobRef || ''); resumeId = String(resumeId || ''); bankSlug = String(bankSlug || '');
  let company = '', role = '', jd = '';
  if (jobRef) {
    const app = loadApps().find((a) => a && a.id === jobRef);
    if (!app) return fail(404, '关联职位不存在（投递记录里没有这条）');
    company = String(app.company || ''); role = String(app.role || ''); jd = String(app.jd || '');
  }
  if (resumeId) {
    if (!DOC_ID_RE.test(resumeId) || !fs.existsSync(path.join(ROOT, 'docs', resumeId + '.html'))) {
      return fail(404, '关联简历不存在（docs/ 里没有这份文档）');
    }
  }
  // 题库（可选）：命中内置种子即钉 slug/title 进会话；题库题是内容数据，不依赖简历/JD 也可开场。
  let bank = null;
  if (bankSlug) {
    bank = getBankRaw(bankSlug);
    if (!bank) return fail(404, '题库不存在（slug 不在内置题库里）');
  }
  if (!jobRef && !resumeId && !bank) return fail(400, '至少要关联一个职位、一份简历或一个题库：出题需要材料依据');
  const s = {
    id: 'iv-' + randomBytes(4).toString('hex'),
    createdAt: now(), updatedAt: now(),
    voice: vid, type,
    jobRef, company, role, jd,                       // JD/公司/岗位快照：创建时钉死，防源记录变动
    resumeId, resumeTitle: resumeId ? resumeTitleOf(resumeId) : '',
    // questionSource='bank' → 出题先走题库题序（内容数据不调模型），题库用尽再由 AI 续出；
    // ='ai' → 全程 AI 出题。题库 slug/title 创建时快照，与 JD 快照同口径。
    questionSource: bank ? 'bank' : 'ai',
    bankSlug: bank ? bank.slug : '', bankTitle: bank ? bank.title : '',
    questionCap: QUESTION_CAP,
    questions: [], answers: {}, hints: {}, report: null,
  };
  const list = readStore();
  list.unshift(s);
  writeStore(list.slice(0, SESSION_CAP));
  return { ok: true, session: sessionView(s) };
}

export function deleteSession(id) {
  const list = readStore();
  const i = findIdx(list, String(id || ''));
  if (i < 0) return fail(404, '面试会话不存在');
  list.splice(i, 1);
  writeStore(list);
  return { ok: true };
}

// ===== AI 编排：prompt 构建（防编造约束钉在 sys 里）=====
const TYPE_GUIDES = {
  comprehensive: '综合面试：自我介绍、项目经历、岗位匹配与行为问题混合，广度优先、由浅入深。',
  professional: '专业面试：只问专业技术与项目深挖题——技术栈选型、实现细节、难点取舍、排查思路。',
  hr: 'HR 面试：只问软素质题——求职动机、职业规划、协作冲突、抗压与稳定性。',
};
const materialsBlock = (s) => {
  const parts = [];
  if (s.company || s.role) parts.push(`【目标职位】${s.company || ''}${s.company && s.role ? '·' : ''}${s.role || ''}`);
  if (s.jd) parts.push(`【职位 JD】\n${String(s.jd).slice(0, JD_MAX_CHARS)}`);
  const rt = resumeTextOf(s.resumeId);
  if (rt) parts.push(`【候选人简历】\n${rt}`);
  return parts.join('\n\n') || '（无关联材料）';
};
const qaBlock = (s, uptoIndex = Infinity) => {
  const qs = (Array.isArray(s.questions) ? s.questions : []).filter((q) => q && q.index < uptoIndex);
  if (!qs.length) return '（还没有问答记录）';
  return qs.map((q) => {
    const a = s.answers && s.answers[String(q.index)];
    const ans = q.status === 'answered' && a ? String(a.text || '').slice(0, 800) : '（跳过，未作答）';
    return `第 ${q.index + 1} 题：${q.text}\n回答：${ans}`;
  }).join('\n\n');
};

function buildQuestionPrompt(s) {
  const asked = (Array.isArray(s.questions) ? s.questions : []).map((q) => q.text);
  const next = asked.length + 1;
  const sys = `你是面试官，正在进行${TYPE_LABELS[s.type] || '面试'}（${TYPE_GUIDES[s.type] || ''}）。这是第 ${next}/${s.questionCap || QUESTION_CAP} 题。\n`
    + '规则：\n'
    + '1. 只出一道题，中文，不超过 80 字，一次只问一件事。\n'
    + '2. 出题只能基于【职位 JD】与【候选人简历】：材料里的公司、项目、技术、数字可以追问；材料没有的事实不得编造、不得假设。\n'
    + '3. 不得与已问过的问题重复或换汤不换药；已是最后几题时逐步收尾（职业规划、提问环节类）。\n'
    + '4. 只输出 JSON：{"question":"…"}，不要任何其它文字。';
  const user = materialsBlock(s) + '\n\n【已问过的问题】\n' + (asked.length ? asked.map((t, i) => `${i + 1}. ${t}`).join('\n') : '（无）');
  return { sys, user };
}
// bankRefOf：题库题的「出题参考要点」（种子内容）。提示 prompt 把它作为参考方向喂给模型——
// 要点来自题库不是编造源；模型仍被规则约束只能指向真实材料。
const bankRefOf = (s, q) => {
  if (!q || q.source !== 'bank' || s.questionSource !== 'bank') return [];
  const bq = (getBankRaw(s.bankSlug) || { questions: [] }).questions[q.index];
  return bq && Array.isArray(bq.answerPoints) ? bq.answerPoints.filter((x) => typeof x === 'string' && x.trim()) : [];
};
const HINT_NO_FABRICATE = '要点只能指向简历/JD/已答记录里真实存在的经历与事实；材料里有的数字可以引用，材料没有的事实不得编造。题目需要材料外的经历时，写「用你材料外的真实经历补充」，不得虚构。';
function buildHintPrompt(s, q) {
  const sys = '你是面试答题教练。给【当前问题】列答题要点，帮候选人组织思路，不替他写完整答案。\n'
    + '规则：\n'
    + '1. ' + HINT_NO_FABRICATE + '\n'
    + '2. 只输出 JSON：{"points":["…"]}，3~6 条，每条不超过 50 字。';
  const ref = bankRefOf(s, q);
  const user = materialsBlock(s) + `\n\n【当前问题】\n${q.text}\n`
    + (ref.length ? `\n【出题参考】\n` + ref.map((x) => `- ${x}`).join('\n') + '\n' : '')
    + `\n【已有问答记录】\n` + qaBlock(s, q.index);
  return { sys, user };
}
// buildHintStreamPrompt：流式版同一教练角色与防编造约束（第 1 条逐字一致）；
// 输出协议改纯文本——逐行要点直接增量渲染，不在前端剥 JSON 壳。
function buildHintStreamPrompt(s, q) {
  const sys = '你是面试答题教练。给【当前问题】列答题要点，帮候选人组织思路，不替他写完整答案。\n'
    + '规则：\n'
    + '1. ' + HINT_NO_FABRICATE + '\n'
    + '2. 直接逐条输出要点：每条一行、以「- 」开头，3~6 条，每条不超过 50 字；不要 JSON、不要标题、不要额外说明。';
  const ref = bankRefOf(s, q);
  const user = materialsBlock(s) + `\n\n【当前问题】\n${q.text}\n`
    + (ref.length ? `\n【出题参考】\n` + ref.map((x) => `- ${x}`).join('\n') + '\n' : '')
    + `\n【已有问答记录】\n` + qaBlock(s, q.index);
  return { sys, user };
}
function buildReportPrompt(s) {
  const sys = '你是面试复盘教练。根据这一场模拟面试的问答记录写复盘报告。\n'
    + '规则：\n'
    + '1. 事实边界：报告只允许基于【职位 JD】【候选人简历】与【问答记录】；数字、公司名、项目名、技术名词必须来自输入材料，材料没有的不得写进报告。\n'
    + '2. 只做定性复盘：不打分、不排名、不做百分位、不预测录用概率、不写「超过 X% 候选人」一类不可验证的比较。\n'
    + '3. 被跳过的问题在短板里如实写「第 k 题未作答」，不猜测原因。\n'
    + '4. 只输出 JSON：{"strengths":["…"],"gaps":["…"],"advice":["…"]}——优势、短板、建议各 2~6 条，每条不超过 60 字。';
  const user = materialsBlock(s) + '\n\n【问答记录】\n' + qaBlock(s);
  return { sys, user };
}

// ===== AI 输出解析（形状错即拒；practice.mjs 同款 stripFence）=====
const stripFence = (raw) => String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
function parseQuestion(raw) {
  const cleaned = stripFence(raw);
  try {
    const d = JSON.parse(cleaned);
    if (d && typeof d.question === 'string' && d.question.trim()) return { ok: true, question: d.question.trim().slice(0, 200) };
  } catch {}
  // 兜底：模型给了纯文本题面（不合 JSON 但确是一道题）→ 收下，不白烧这次调用
  if (cleaned && cleaned.length <= 300 && !/^[{[]/.test(cleaned)) return { ok: true, question: cleaned.replace(/^["']|["']$/g, '').trim() };
  return { ok: false, error: '模型输出无法解析为面试问题，本题未生成' };
}
const strList = (v, cap = 8, len = 200) => Array.isArray(v)
  ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, cap).map((x) => x.slice(0, len))
  : null;
function parseReport(raw) {
  try {
    const d = JSON.parse(stripFence(raw));
    const strengths = strList(d && d.strengths), gaps = strList(d && d.gaps), advice = strList(d && d.advice);
    if (strengths === null || gaps === null || advice === null) {
      return { ok: false, error: '模型输出无法解析为面试报告（strengths/gaps/advice 需为字符串数组），未写入任何结果' };
    }
    if (!strengths.length && !gaps.length && !advice.length) {
      return { ok: false, error: '模型报告为空（三个数组都没有内容），未写入任何结果' };
    }
    return { ok: true, report: { strengths, gaps, advice } };
  } catch { return { ok: false, error: '模型输出无法解析为面试报告（不是合法 JSON），未写入任何结果' }; }
}
function parsePoints(raw) {
  try {
    const d = JSON.parse(stripFence(raw));
    const points = strList(d && d.points, 10, 200);
    if (!points || !points.length) return { ok: false, error: '模型输出无法解析为答题要点（points 需为非空字符串数组）' };
    return { ok: true, points };
  } catch { return { ok: false, error: '模型输出无法解析为答题要点（不是合法 JSON）' }; }
}

// ===== AI 编排：出题 / 作答 / 提示 / 报告 =====
// nextQuestion：幂等——pending 题还在就原样返回（刷新/重复点击不重出题、不重复扣费）；
//   达到 cap → {done:true}；否则 AI 出一道、落账、返回 {index, question}。
//   形参按契约收 session 对象（视图或原始记录皆可）：内部按 session.id 重读存储行再操作，
//   不信传入副本的其它字段。
export async function nextQuestion(session, { lease, meta, profile } = {}) {
  const id = session && session.id;
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  const p = pendingOf(s);
  if (p) return { ok: true, index: p.index, question: p.text, pending: true };
  const cap = s.questionCap || QUESTION_CAP;
  const index = (s.questions || []).length;
  if (index >= cap) return { ok: true, done: true, cap };
  // 题库会话：题目序列先取题库内置题（内容数据，不调模型、不需 hasLLM）；
  // 题库题用尽 → 落回 AI 续出到 cap。题库 slug 失配（种子被删）同样降级 AI。
  if (s.questionSource === 'bank') {
    const bq = (getBankRaw(s.bankSlug) || { questions: [] }).questions[index];
    if (bq) {
      s.questions = [...(s.questions || []), { index, text: bq.question, askedAt: now(), status: 'pending', source: 'bank' }];
      s.updatedAt = now();
      if (!saveRaw(s)) return fail(404, '会话已删除，本题未保存');
      return { ok: true, index, question: bq.question };
    }
  }
  if (!hasLLM(ROOT)) return fail(409, NO_MODEL_HINT);
  const prompt = buildQuestionPrompt(s);
  let raw;
  try { raw = await chat(ROOT, prompt.sys, prompt.user, { lease, meta, profile }); }
  catch (e) { return fail(502, '模型调用失败：' + String((e && e.message) || e).slice(0, 200)); }
  const parsed = parseQuestion(raw);
  if (!parsed.ok) return fail(502, parsed.error);
  s.questions = [...(s.questions || []), { index, text: parsed.question, askedAt: now(), status: 'pending', source: 'ai' }];
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，本题未保存');
  return { ok: true, index, question: parsed.question };
}

// submitAnswer：回答落在「当前 pending 题」上（唯一可作答位置）；重交 = 最近一次为准。
export function submitAnswer(id, answer) {
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  const p = pendingOf(s);
  if (!p) return fail(409, '当前没有待作答的问题（可能已全部答完，请先取下一题）');
  const t = String(answer == null ? '' : answer).trim();
  if (!t) return fail(400, '回答需为非空文本（跳过请用 skip）');
  if (t.length > ANSWER_MAX_CHARS) return fail(400, `回答过长（上限 ${ANSWER_MAX_CHARS} 字）`);
  s.questions = s.questions.map((q) => (q.index === p.index ? { ...q, status: 'answered' } : q));
  s.answers = { ...(s.answers || {}), [String(p.index)]: { text: t, at: now() } };
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，回答未保存');
  return { ok: true, index: p.index };
}

// skipQuestion：跳过当前 pending 题（跳过也记账：报告据此如实写「未作答」）。
export function skipQuestion(id) {
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  const p = pendingOf(s);
  if (!p) return fail(409, '当前没有可跳过的问题');
  s.questions = s.questions.map((q) => (q.index === p.index ? { ...q, status: 'skipped' } : q));
  s.answers = { ...(s.answers || {}), [String(p.index)]: { skipped: true, at: now() } };
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，操作未保存');
  return { ok: true, index: p.index };
}

// genHint：答题要点（存 hints[index]，重复生成覆盖旧值——重生成语义，与反馈重算同口径）。
export async function genHint(id, questionIndex, { lease, meta, profile } = {}) {
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  const q = (Array.isArray(s.questions) ? s.questions : []).find((x) => x && x.index === questionIndex);
  if (!q) return fail(404, '题目不存在（questionIndex 不在这场面试里）');
  if (!hasLLM(ROOT)) return fail(409, NO_MODEL_HINT);
  const prompt = buildHintPrompt(s, q);
  let raw;
  try { raw = await chat(ROOT, prompt.sys, prompt.user, { lease, meta, profile }); }
  catch (e) { return fail(502, '模型调用失败：' + String((e && e.message) || e).slice(0, 200)); }
  const parsed = parsePoints(raw);
  if (!parsed.ok) return fail(502, parsed.error);
  s.hints = { ...(s.hints || {}), [String(q.index)]: { points: parsed.points, at: now() } };
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，提示未保存');
  return { ok: true, index: q.index, points: parsed.points };
}

// genReport：至少答过 1 题才可复盘（零作答的报告全是编造）；生成后存档进 session.report。
const reportModelOf = (profile) => {
  try { const { active, profiles } = loadProfiles(ROOT); const c = (profiles || [])[profile == null ? active : profile] || {}; return c.model || null; } catch { return null; }
};
export async function genReport(id, { lease, meta, profile } = {}) {
  const s = getRaw(id);
  if (!s) return fail(404, '面试会话不存在');
  if (answeredCount(s) < 1) return fail(409, '还没有任何作答：至少回答 1 题后才能生成复盘报告');
  if (!hasLLM(ROOT)) return fail(409, NO_MODEL_HINT);
  const prompt = buildReportPrompt(s);
  const m = meta && typeof meta === 'object' ? meta : {};
  let raw;
  try { raw = await chat(ROOT, prompt.sys, prompt.user, { lease, meta: m, profile }); }
  catch (e) { return fail(502, '模型调用失败：' + String((e && e.message) || e).slice(0, 200)); }
  const parsed = parseReport(raw);
  if (!parsed.ok) return fail(502, parsed.error);
  s.report = { ...parsed.report, at: now(), model: reportModelOf(profile), usage: m.usage ?? null };
  s.updatedAt = now();
  if (!saveRaw(s)) return fail(404, '会话已删除，报告未保存');
  return { ok: true, report: s.report };
}

// ===== 流式变体（UPCV */stream 端点复刻：text/event-stream 经路由层泵出）=====
// 产出帧契约（路由层据此写 SSE）：
//   {type:'delta', text:'…'}        — 模型正文增量（每帧一个 data: 行）
//   {type:'done', ...payload}       — 流结束 + 解析/落账成功后的结构化结果
//   {type:'error', status, error}   — 终态错误；首帧即 error → 路由回 JSON，不写 SSE 头
// 释放纪律：本生成器内部 for-await 消费 streamChat；调用方中断迭代（it.return()，
// 对应路由层 res close）→ for-await 调内层 return() → llm.mjs finally 释放 AI 槽。
// 落账纪律：与非流式一致——原始输出解析成功才写 hints/report；中途断流不留半成品。
const streamErr = (status, error) => ({ type: 'error', status, error });

export async function* genHintStream(id, questionIndex, { lease, meta, profile } = {}) {
  const s = getRaw(id);
  if (!s) { yield streamErr(404, '面试会话不存在'); return; }
  const q = (Array.isArray(s.questions) ? s.questions : []).find((x) => x && x.index === questionIndex);
  if (!q) { yield streamErr(404, '题目不存在（questionIndex 不在这场面试里）'); return; }
  if (!hasLLM(ROOT)) { yield streamErr(409, NO_MODEL_HINT); return; }
  const prompt = buildHintStreamPrompt(s, q);
  let raw = '';
  try {
    for await (const chunk of streamChat(ROOT, prompt.sys, prompt.user, { lease, meta, profile })) {
      raw += chunk;
      yield { type: 'delta', text: chunk };
    }
  } catch (e) { yield streamErr(502, '模型调用失败：' + String((e && e.message) || e).slice(0, 200)); return; }
  const parsed = parseHintText(raw);
  if (!parsed.ok) { yield streamErr(502, parsed.error); return; }
  // 重读再写：流期间会话可能被删/被并发推进，不能拿开场时的引用去覆盖。
  const cur = getRaw(id);
  if (!cur) { yield streamErr(404, '会话已删除，提示未保存'); return; }
  cur.hints = { ...(cur.hints || {}), [String(q.index)]: { points: parsed.points, at: now() } };
  cur.updatedAt = now();
  if (!saveRaw(cur)) { yield streamErr(404, '会话已删除，提示未保存'); return; }
  yield { type: 'done', index: q.index, points: parsed.points };
}

export async function* genReportStream(id, { lease, meta, profile } = {}) {
  const s = getRaw(id);
  if (!s) { yield streamErr(404, '面试会话不存在'); return; }
  if (answeredCount(s) < 1) { yield streamErr(409, '还没有任何作答：至少回答 1 题后才能生成复盘报告'); return; }
  if (!hasLLM(ROOT)) { yield streamErr(409, NO_MODEL_HINT); return; }
  const prompt = buildReportPrompt(s);
  const m = meta && typeof meta === 'object' ? meta : {};
  let raw = '';
  try {
    for await (const chunk of streamChat(ROOT, prompt.sys, prompt.user, { lease, meta: m, profile })) {
      raw += chunk;
      yield { type: 'delta', text: chunk };
    }
  } catch (e) { yield streamErr(502, '模型调用失败：' + String((e && e.message) || e).slice(0, 200)); return; }
  const parsed = parseReport(raw);
  if (!parsed.ok) { yield streamErr(502, parsed.error); return; }
  const cur = getRaw(id);
  if (!cur) { yield streamErr(404, '会话已删除，报告未保存'); return; }
  cur.report = { ...parsed.report, at: now(), model: reportModelOf(profile), usage: m.usage ?? null };
  cur.updatedAt = now();
  if (!saveRaw(cur)) { yield streamErr(404, '会话已删除，报告未保存'); return; }
  yield { type: 'done', report: cur.report };
}

// parseHintText：流式提示的纯文本解析——优先收「- / * / • / 数字. 」开头的行；
// 无标记行时退化为全部非空行（不白烧这次调用，与 parseQuestion 的纯文本兜底同口径）。
function parseHintText(raw) {
  const lines = stripFence(String(raw || '')).split('\n').map((l) => l.trim()).filter((l) => l && !/^```/.test(l));
  const MARK = /^(?:[-*•·]|\d{1,2}[.、)）])\s*/;
  const marked = lines.filter((l) => MARK.test(l)).map((l) => l.replace(MARK, '').trim()).filter(Boolean);
  const pts = (marked.length ? marked : lines).slice(0, 6).map((x) => x.slice(0, 200));
  if (!pts.length) return { ok: false, error: '模型输出无法解析为答题要点（需要逐行要点文本），未写入任何结果' };
  return { ok: true, points: pts };
}
