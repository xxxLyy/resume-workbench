// match.mjs — 岗位匹配 + 岗位推荐核心（UPCV A2 · #10/#11；规范 dev-docs/2026-11-19-upcv-port-jobs-match-design.md §2）
// 编排照 efc routes/match.ts 翻译成 vanilla mjs；三护栏纪律移植 eval.mjs：
//   ① matchScore 非数字/越界 → 整份作废（分数是结论本身，猜一个交出去会误导投递决策）；
//   ② strengths 每条必须附 evidence 且是简历原文逐字子串（normSpace ≥6 码元，同 eval.mjs:84 口径）
//     ——不过 → 剔除该条（编造的匹配点不许留在报告里）；
//   ③ matchLevel 非法 → 按分数落档（weak<50≤medium<70≤strong<85≤excellent），不让非法值穿过契约。
// 缓存账本 match-cache.json（对象形状，唯一写路径 = tx.mjs updateJsonLedger；五处登记见 server.mjs）：
//   键 = docId + '|' + (jobId || 'fp:' + jdFp)；jdFp 空指纹（<200 字）兜底 contentHash（防不同短 JD 撞 'fp:' 键）。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chat } from './llm.mjs';
import { updateJsonLedger } from './tx.mjs';
import { docToText, contentHash } from './extract.mjs';
import { fetchUpcvJob, fetchUpcvJobs, UPCV_SEARCH_PARAMS } from './upcv-jobs.mjs';
import { getPreference, findMaster } from './talent.mjs';
import { fingerprintText } from './vendors/jd-fingerprint/fingerprint-core.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = () => process.env.RESUME_ROOT || APP_ROOT;

const CACHE_FILE = 'match-cache.json';
// docId 闸门：与 server.mjs VALID_ID 同口径（键拼进账本前先挡非法 id）
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
// jobId 闸门：上游数字/字母 id；防任意串进缓存键（白名单同 server.mjs /app/add 的 jobId 口径）
const VALID_JOB_ID = /^[A-Za-z0-9_-]{1,90}$/;
const JD_TEXT_MAX = 64 * 1024;   // jdText 入口截断，与 server.mjs JD_MAX_CHARS 同尺（64KB）
const JD_FIELD_MAX = 2000;       // 职位详情喂 LLM 的字段截断（spec §1.2：description/requirements 各 2000 字）
const DOC_TEXT_MAX = 20000;      // 简历正文截断（护 token，同 talent.mjs MASTER_TEXT_MAX 尺）
const HEADLINE_MAX = 80;         // UPCV 契约：headline ≤80 字
const ITEM_MAX = 60;             // 三数组每条 ≤60 字
const LIST_CAP = 3;              // UPCV 契约：三数组各 ≤3 条
const RECOMMEND_LIMIT_MAX = 12;  // 设计 §2：推荐只自动算首页 ≤12 条（token 上限）
const EVIDENCE_MIN = 6;          // evidence normSpace 后 <6 码元等于没锚（同 eval.mjs 口径）

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (s, n) => String(s ?? '').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 逐岗间隔：默认 300ms；测试用 RESUME_MATCH_INTERVAL_MS 压到 0 */
const matchIntervalMs = () => Number(process.env.RESUME_MATCH_INTERVAL_MS ?? 300);

// ===== 账本读取：缺失 → null；根形状错 → CORRUPT 500（停写口径同 talent.mjs）=====
const cacheShapeOk = (d) => isObj(d) && Object.values(d).every(isObj);
const corruptErr = (name, cause) => {
  const e = new Error(`数据文件损坏，已停止写入：${name}。请先人工修复或从备份恢复。`);
  e.httpCode = 500; e.code = 'CORRUPT'; if (cause) e.cause = cause;
  return e;
};
function readCacheTable(root) {
  const fp = path.join(root, CACHE_FILE);
  if (!fs.existsSync(fp)) return null;
  let d = null;
  try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (err) { throw corruptErr(CACHE_FILE, err); }
  if (!cacheShapeOk(d)) throw corruptErr(CACHE_FILE);
  return d;
}
/** 单条缓存读取：缺失/条目形状坏 → null（重算覆盖，不整份停写）；matchScore 越界 → 当无缓存 */
function readCachedMatch(root, key) {
  const table = readCacheTable(root);
  const raw = table ? table[key] : null;
  if (!isObj(raw)) return null;
  const s = Number(raw.matchScore);
  if (!Number.isFinite(s) || s < 0 || s > 100) return null;
  const { cachedAt, ...match } = {
    matchScore: Math.round(s),
    matchLevel: str(raw.matchLevel),
    headline: str(raw.headline),
    strengths: Array.isArray(raw.strengths) ? raw.strengths.map(str).filter(Boolean) : [],
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map(str).filter(Boolean) : [],
    resumeSuggestions: Array.isArray(raw.resumeSuggestions) ? raw.resumeSuggestions.map(str).filter(Boolean) : [],
    cachedAt: str(raw.cachedAt),
  };
  return match;   // cachedAt 只留在账本里（诊断用），不进 UPCV 契约形状
}
function writeCachedMatch(root, key, match) {
  updateJsonLedger(root, CACHE_FILE, (cur) => ({ ...cur, [key]: { ...match, cachedAt: new Date().toISOString() } }),
    { lockFile: '.match-cache.json.lock', validate: cacheShapeOk, initial: {} });
}

// ===== 契约形状（UPCV §12.4b）=====
const MATCH_LEVELS = new Set(['weak', 'medium', 'strong', 'excellent']);
/** matchLevel 非法值时的推导档：按分数落档，不让非法值穿过契约（efc match.ts 同款） */
const levelOfScore = (score) => (score >= 85 ? 'excellent' : score >= 70 ? 'strong' : score >= 50 ? 'medium' : 'weak');

// ===== 职位详情 → 喂 LLM 的裁剪文本（efc jobPromptText 同款口径；server /jobs/apply-draft 复用）=====
export function jobPromptText(detail) {
  const d = isObj(detail) ? detail : {};
  const j = isObj(d.job) ? d.job : {};
  const clipJd = (s) => clip(s, JD_FIELD_MAX);
  return [
    `职位：${str(j.title) || '?'}（${str(j.companyName) || str(isObj(d.company) ? d.company.name : '') || '?'}）`,
    str(j.locationDetail) ? `地点：${str(j.locationDetail)}` : '',
    isObj(j.minEducation) && str(j.minEducation.label) ? `学历要求：${str(j.minEducation.label)}` : '',
    str(j.salaryDisplay) ? `薪资：${str(j.salaryDisplay)}` : '',
    Array.isArray(j.preferredSkills) && j.preferredSkills.length ? `技能标签：${j.preferredSkills.map(str).filter(Boolean).join('、')}` : '',
    str(j.description) ? `\n【职位描述】\n${clipJd(j.description)}` : '',
    str(j.requirements) ? `\n【任职要求】\n${clipJd(j.requirements)}` : '',
  ].filter(Boolean).join('\n');
}

// ===== prompt（纯函数）：strengths 必须附 evidence（解析侧逐字子串验证，编造即剔除）=====
export function buildMatchPrompt({ docText, jdText }) {
  const sys = '你是资深求职顾问。对比用户简历与职位信息，评估匹配度，只输出 JSON，形状严格如下：'
    + '{"matchScore":0到100的整数,"matchLevel":"weak|medium|strong|excellent","headline":"一句话结论",'
    + '"strengths":[{"text":"匹配点","evidence":"简历原文片段"}],"gaps":["差距点"],"resumeSuggestions":["简历改进建议"]}\n'
    + '规则：\n'
    + '- matchScore 是 0-100 的整数；matchLevel 只能是 weak|medium|strong|excellent 四值之一，分数越高等级越高。\n'
    + `- headline 不超过 ${HEADLINE_MAX} 字；strengths、gaps、resumeSuggestions 各不超过 ${LIST_CAP} 条，每条不超过 ${ITEM_MAX} 字。\n`
    + `- strengths 每条必须给 evidence：从【我的简历】里逐字摘出支撑该匹配点的原文片段（至少 ${EVIDENCE_MIN} 个字）；`
    + '简历里找不到原文支撑的匹配点不许写进 strengths，如实写进 gaps。严禁编造简历里没有的经历、技能或数字。\n'
    + '- resumeSuggestions 针对这份职位给出可执行的简历调整建议，不编造事实。\n'
    + '- 只输出 JSON 对象本身，不要任何解释或 markdown 代码围栏。';
  const user = `【目标职位】\n${jdText || '（未提供职位详情）'}\n\n【我的简历】\n${clip(docText, DOC_TEXT_MAX)}`;
  return { sys, user };
}

// ===== 解析（三护栏）：坏输出返回 {ok:false,reason}（调用方重试 1 次仍败 → 502），绝不抛异常 =====
export function parseMatchResult(raw, { docText = '' } = {}) {
  const fail = (reason) => ({ ok: false, match: null, dropped: 0, reason });
  const cleaned = String(raw ?? '').trim().replace(/```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let data;
  try { data = JSON.parse(cleaned); }
  catch {
    // 模型常在 JSON 前后带自然语言——截首个 { 到末个 } 再试一次（同 eval.mjs/talent.mjs 口径）
    const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
    if (a < 0 || b <= a) return fail('模型输出不是合法 JSON');
    try { data = JSON.parse(cleaned.slice(a, b + 1)); }
    catch { return fail('模型输出不是合法 JSON'); }
  }
  if (!isObj(data)) return fail('模型输出不是 JSON 对象');

  // 护栏①（eval.mjs score 同款）：score 是这个功能的全部结论，非数字/越界整份作废；
  // !(x>=0&&x<=100) 而非 x<0||x>100 —— 后者对 NaN 全 false 会把 NaN 放行。
  const score = data.matchScore;
  if (typeof score !== 'number' || !(score >= 0 && score <= 100)) {
    return fail('matchScore 必须是 0-100 的数字，实际 ' + JSON.stringify(score ?? null));
  }
  const matchScore = Math.min(100, Math.max(0, Math.round(score)));
  // 护栏③：matchLevel 非枚举 → 按分数落档（同 efc levelOfScore，不让非法值穿过契约）
  const matchLevel = MATCH_LEVELS.has(data.matchLevel) ? data.matchLevel : levelOfScore(matchScore);

  // 护栏②：strengths 每条 evidence 必须是简历原文逐字子串（normSpace 后 ≥6 码元，同 eval.mjs:84）——
  // 不过 → 剔除该条（不整份作废：一条编造不废掉其余真实匹配点，但编造的绝不能留在报告里）。
  const hay = String(docText || '').replace(/\s+/g, '');
  let dropped = 0;
  const strengths = [];
  for (const it of Array.isArray(data.strengths) ? data.strengths : []) {
    const text = isObj(it) ? str(it.text) : '';
    const needle = (isObj(it) ? str(it.evidence) : '').replace(/\s+/g, '');
    if (!text) { dropped++; continue; }
    if (!hay || !needle || [...needle].length < EVIDENCE_MIN || !hay.includes(needle)) { dropped++; continue; }
    strengths.push(clip(text, ITEM_MAX));
    if (strengths.length >= LIST_CAP) break;
  }
  const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, LIST_CAP).map((s) => clip(s, ITEM_MAX)) : []);
  return {
    ok: true,
    dropped,
    reason: '',
    match: {
      matchScore,
      matchLevel,
      headline: clip(str(data.headline), HEADLINE_MAX),
      strengths,
      gaps: strList(data.gaps),
      resumeSuggestions: strList(data.resumeSuggestions),
    },
  };
}

// ===== 文档正文（母版/岗位草稿同入口：docs/<id>.html → docToText）=====
function docTextOf(root, docId) {
  const f = path.join(root, 'docs', docId + '.html');
  if (!fs.existsSync(f)) {
    const e = new Error('简历文档不存在');
    e.httpCode = 404; e.code = 'NO_DOC';
    throw e;
  }
  return docToText(fs.readFileSync(f, 'utf8'), { includeHidden: false });
}

// ===== 匹配核心（/match/job 与 /extension/match-score 共用）=====
// 返回 {ok:true, cached, match}；错误抛带 httpCode 的 Error（路由统一 catch）：
//   400 缺参 / 404 文档不存在 / 502 上游或模型或解析失败 / 500 CORRUPT。
export async function computeMatch({ root = defaultRoot(), docId, jobId, jdText, refresh = false, lease, profile } = {}) {
  const did = String(docId || '');
  if (!VALID_ID.test(did)) { const e = new Error('缺少或非法 docId'); e.httpCode = 400; throw e; }
  const jid = String(jobId || '').trim();
  const jd = typeof jdText === 'string' ? jdText.slice(0, JD_TEXT_MAX) : '';
  if (!jid && !jd.trim()) { const e = new Error('缺少 jobId 或 jdText'); e.httpCode = 400; throw e; }
  if (jid && !VALID_JOB_ID.test(jid)) { const e = new Error('非法 jobId'); e.httpCode = 400; throw e; }
  const docText = docTextOf(root, did);   // 404 在取正文时统一抛

  // 缓存键：jobId 优先；jdText 用指纹（空指纹兜底 contentHash，防短 JD 全撞 'fp:' 键）
  const fp = fingerprintText(jd) || contentHash(jd);
  const key = did + '|' + (jid || 'fp:' + fp);
  if (!refresh) {
    const cached = readCachedMatch(root, key);
    if (cached) return { ok: true, cached: true, match: cached };
  }

  // 职位文本：jobId → 上游详情裁剪；jdText → 截 64KB 终值
  let jobText;
  if (jid) {
    try { jobText = jobPromptText(await fetchUpcvJob(jid)); }
    catch (e) { const err = new Error('职位详情失败：' + String((e && e.message) || e)); err.httpCode = 502; err.cause = e; throw err; }
  } else {
    jobText = jd.trim();
  }

  const p = buildMatchPrompt({ docText, jdText: jobText });
  let parsed = null, lastReason = '';
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const raw = await chat(root, p.sys, p.user, { lease, profile });
    const r = parseMatchResult(raw, { docText });
    if (r.ok) parsed = r.match; else lastReason = r.reason;
  }
  if (!parsed) {
    const e = new Error('匹配结果解析失败：' + lastReason);
    e.httpCode = 502; e.code = 'BAD_MATCH';
    throw e;
  }
  writeCachedMatch(root, key, parsed);
  return { ok: true, cached: false, match: parsed };
}

// ===== 推荐核心（/match/recommend；偏好映射 → feed 首页逐岗匹配 → matchScore 降序）=====
// 返回 {ok:true, items, page, limit, total, hasMore}；无母版 → 400（同 talent NO_MASTER 中文口径）。
// 上游条目无 id → 无法匹配，pending 标记；单岗失败 → 该岗 matchError 并停止补算
// （LLM 未配置/解析失败对后续条目大概率同样失败，不再烧 token；efc 同款 break）。
export async function recommendMatches({ root = defaultRoot(), docId, jobType, limit, refresh = false, lease, profile } = {}) {
  let master = null;
  const did = String(docId || '');
  if (did) {
    if (!VALID_ID.test(did)) { const e = new Error('非法 docId'); e.httpCode = 400; throw e; }
    const f = path.join(root, 'docs', did + '.html');
    if (!fs.existsSync(f)) { const e = new Error('简历文档不存在'); e.httpCode = 404; throw e; }
    master = { id: did };
  } else {
    master = findMaster(root);   // docs-meta 损坏 → CORRUPT（talent.mjs 口径，原样上抛）
    if (!master) {
      const e = new Error('先创建或导入一份母版简历，匹配与推荐都基于母版');
      e.httpCode = 400; e.code = 'NO_MASTER';
      throw e;
    }
  }

  // 偏好映射（设计 §2）：salary → search 关键词（启发式：上游 search 是全文检索，薪资区间作关键词）
  // cityIds/functionIds 逗号透传（白名单内）；industryIds 上游搜索无对应参数（不在白名单）→ 如实忽略。
  // jobTypes → jobType（校招位 A1 已剔除，只收 SOCIAL|INTERNSHIP）；无偏好 → 裸 SOCIAL feed。
  const pref = getPreference(root);   // preference.json 损坏 → CORRUPT 原样上抛
  const params = new URLSearchParams();
  const jt = (pref && Array.isArray(pref.jobTypes) ? pref.jobTypes : []).find((t) => t === 'SOCIAL' || t === 'INTERNSHIP');
  params.set('jobType', String(jobType || jt || 'SOCIAL'));
  if (pref && isObj(pref.salary)) {
    const mn = Number(pref.salary.min), mx = Number(pref.salary.max);
    if (Number.isFinite(mn) && Number.isFinite(mx)) params.set('search', `${mn}-${mx}K`);
  }
  if (pref) {
    for (const k of ['cityIds', 'functionIds']) {
      const ids = Array.isArray(pref[k]) ? pref[k].join(',') : '';
      if (ids) params.set(k, ids);
    }
  }
  const lim = Math.min(RECOMMEND_LIMIT_MAX, Math.max(1, Math.floor(Number(limit) || RECOMMEND_LIMIT_MAX) || RECOMMEND_LIMIT_MAX));
  params.set('page', '1');
  params.set('limit', String(lim));

  let search;
  try { search = await fetchUpcvJobs(params); }
  catch (e) { const err = new Error('职位搜索失败：' + String((e && e.message) || e)); err.httpCode = 502; err.cause = e; throw err; }
  const jobs = isObj(search) && Array.isArray(search.data) ? search.data : [];
  const total = isObj(search) && typeof search.total === 'number' ? search.total : jobs.length;

  const items = jobs.map((j) => ({ ...(isObj(j) ? j : {}), matchScore: null, matchLevel: null }));
  const needCompute = [];
  items.forEach((it, i) => {
    const jid = String(it.id ?? '');
    if (!jid || !VALID_JOB_ID.test(jid)) { it.pending = true; return; }   // 上游条目无合法 id，无法匹配
    const cached = readCachedMatch(root, master.id + '|' + jid);
    if (cached && !refresh) {
      it.matchScore = cached.matchScore;
      it.matchLevel = cached.matchLevel;
    } else {
      needCompute.push(i);
    }
  });
  for (const [n, i] of needCompute.entries()) {
    if (n > 0) await sleep(matchIntervalMs());
    try {
      const r = await computeMatch({ root, docId: master.id, jobId: String(items[i].id), refresh, lease, profile });
      items[i].matchScore = r.match.matchScore;
      items[i].matchLevel = r.match.matchLevel;
    } catch (e) {
      // 单岗失败即停：缺 LLM 配置/解析失败对后续岗大概率同样失败，不再烧 token（efc 同款）
      items[i].pending = true;
      items[i].matchError = String((e && e.message) || e);
      break;
    }
  }
  for (const it of items) {
    if (it.matchScore === null && it.pending === undefined) it.pending = true;   // 排序后的缺口如实标记
  }
  items.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
  return { ok: true, items, page: 1, limit: lim, total, hasMore: 1 * lim < total };
}
