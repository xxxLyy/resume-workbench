// extension.mjs — 投递浏览器扩展五端点核心（UPCV A4 · #14；规范 dev-docs/2026-11-19-upcv-port-extension-design.md §1）
// 编排照 efc routes/extension.ts 翻译成 vanilla mjs；/extension/match-score 在 server.mjs A2 区复用 computeMatch（不重复实现）。
// 纪律：
//   - applications.json 是本仓既有账本：本模块照 server.mjs /app/* 的读写纪律自带一份（损坏停写 CORRUPT、
//     原子写 0600、读时归一 legacy 枚举）——零新账本，账本四连登记不适用。
//   - 鉴权在 server.mjs 路由层（X-Resume-Token 口令，importToken 先例）；本模块只管业务与校验。
//   - LLM 两端点（greeting/chat-reply）走 llm.mjs chat + 调用方透传 lease（gatePool 在 server.mjs 精确登记）。
//     散文体护栏只设可验证项：清洗后非空（空→502，两试）；长度截断（招呼 ≤120 契约字 / 回复 ≤300）。
//     编造无法程序化对账（match/eval 的 evidence 逐字子串护栏只适用于结构化输出），如实不设假护栏。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chat } from './llm.mjs';
import { docToText } from './extract.mjs';
import { findMaster } from './talent.mjs';
import { safeUrl } from './safe-url.mjs';
import { fetchUpcvJob } from './upcv-jobs.mjs';
import { jobPromptText } from './match.mjs';
import { atomicWrite } from './tx.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = () => process.env.RESUME_ROOT || APP_ROOT;

// 六态三张表 + 前向 rank：与 server.mjs:128-139 / agent.mjs 同源照抄（量小照抄、不跨模块 import 的既定纪律）。
// STATUS_RANK 供 apply-record 前向推进判定（efc 同款：closed 排最末，from applied 起算「已沟通过」）。
const APP_STATUSES = ['to_apply', 'preparing', 'applied', 'replied', 'interviewing', 'offer'];
const APP_STATUS_ALL = [...APP_STATUSES, 'closed'];
const APP_STATUS_LEGACY = Object.assign(Object.create(null), { '已投递': 'applied', '笔试': 'replied', '面试中': 'interviewing', 'offer': 'offer', '已拒': 'closed', '搁置': 'closed' });
const appStatus = (s) => (APP_STATUS_ALL.includes(s) ? s : (APP_STATUS_LEGACY[s] || 'applied'));
const STATUS_RANK = Object.assign(Object.create(null), { to_apply: 0, preparing: 1, applied: 2, replied: 3, interviewing: 4, offer: 5, closed: 6 });

// 闸门（与 server.mjs /app/add、match.mjs 两处同尺，不得漂移）：
// VALID_ID 管文档 id（拼路径）；VALID_JOB_ID 管岗位幂等键（站点采集 id 形如 site-zhipin-com-xxx）。
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const VALID_JOB_ID = /^[A-Za-z0-9_-]{1,90}$/;
const JD_TEXT_MAX = 64 * 1024;   // jdText 入口截断，与 server.mjs JD_MAX_CHARS 同尺
const JD_FIELD_MAX = 2000;       // 账本行 jd 喂 LLM 的截断（match.mjs JD_FIELD_MAX 同尺）
const HISTORY_MAX = 8000;       // 聊天历史截断（efc 口径：客户端送末 12000，服务端再留末 8000——最新消息优先）
const DOC_TEXT_MAX = 20000;      // 简历正文截断（护 token，同 talent/match 尺）
const GREETING_MAX = 120;        // UPCV 契约：招呼语 ≤120 字
const DRAFT_MAX = 300;           // 回复草稿上限（efc 未约定；聊天单条消息的合理尺）
const CLIP = (s, n) => String(s ?? '').slice(0, n);

const err = (status, message) => Object.assign(new Error(message), { httpCode: status });
const corruptErr = (cause) => {
  const e = new Error('数据文件损坏，已停止写入：applications.json。请先人工修复或从备份恢复。');
  e.httpCode = 500; e.code = 'CORRUPT'; if (cause) e.cause = cause;
  return e;
};
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// ===== applications.json 读写（server.mjs readJson/assertWritable/atomicWrite 同款纪律）=====
// 读侧 fail-closed：解析失败/形状错直接 500（upcv-api.mjs applicationRecords 同款先例）——
// 扩展拿错数据会误发招呼，宁可 500 不降级成「空表照常干活」。
function loadAppsTable(root) {
  const fp = path.join(root, 'applications.json');
  if (!fs.existsSync(fp)) return [];
  let d = null;
  try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { throw corruptErr(e); }
  if (!Array.isArray(d)) throw corruptErr();
  return d;
}
function saveAppsTable(root, list) { atomicWrite(path.join(root, 'applications.json'), JSON.stringify(list)); }

// 行 id：server.mjs timestamp() 同格式（/app/update 与 /app/del 校验 /^[0-9-]+$/，漂移即删改不了行）。
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}
const todayStr = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

// jobId → 行：jobId 命中优先；短清单对无 jobId 的老行回退行 id（站点 id 以 site- 开头，与时间戳行 id 无碰撞）。
const rowByJobKey = (apps, key) =>
  apps.find((a) => isObj(a) && ((typeof a.jobId === 'string' && a.jobId.trim() === key) || String(a.id || '') === key));

// ===== 简历正文（母版/指定文档；agent.mjs resolveDoc 同口径 docToText(includeHidden:false)）=====
function docTextOf(root, docIdRaw) {
  let did = String(docIdRaw || '').trim();
  if (!did) {
    const m = findMaster(root);   // talent.mjs；docs-meta 损坏 → CORRUPT 上抛
    if (!m) { throw err(400, '先创建或导入一份母版简历，扩展的招呼与回复都基于母版'); }
    did = m.id;
  }
  if (!VALID_ID.test(did)) throw err(400, '非法 docId');
  const f = path.join(root, 'docs', did + '.html');
  if (!fs.existsSync(f)) throw err(404, '简历文档不存在');
  return { id: did, text: docToText(fs.readFileSync(f, 'utf8'), { includeHidden: false }) };
}

// ===== GET /extension/shortlist =====
// items 只回 to_apply（appStatus 归一口径）；statuses 附带全表 jobId→状态投影（幂等跳过「已沟通过」依据，
// efc /api/jobs/tracking 的职责并入本端点——本仓无独立 tracking 端点，避免第七端点）。
export function extensionShortlist(root = defaultRoot()) {
  const apps = loadAppsTable(root);
  const items = [];
  const bestByJob = new Map();   // jobId → 最高态（同 jobId 多行取最前状态，幂等跳过按最前判定）
  for (const a of apps) {
    if (!isObj(a)) continue;
    const st = appStatus(a.status);
    const jid = typeof a.jobId === 'string' ? a.jobId.trim() : '';
    if (jid) {
      const prev = bestByJob.get(jid);
      if (prev === undefined || (STATUS_RANK[st] ?? -1) > (STATUS_RANK[prev] ?? -1)) bestByJob.set(jid, st);
    }
    if (st !== 'to_apply') continue;
    items.push({
      jobId: jid || String(a.id || ''),   // 老行无 jobId → 行 id 兜底（greeting/apply-record 都按此键命中本行）
      title: String(a.role || ''),
      companyName: String(a.company || ''),
      salaryDisplay: String(a.salaryDisplay || '') || null,   // 本仓行无此键 → null（面板 filter(Boolean) 跳过）
      detailUrl: safeUrl(a.link) || null,
      dueDate: String(a.dueDate || '') || null,
    });
  }
  const statuses = [...bestByJob.entries()].map(([jobId, status]) => ({ jobId, status }));
  return { ok: true, items, statuses };
}

// ===== POST /extension/apply-record =====
// 幂等 by jobId（A3 铺的字段）：已有行 → 状态只许前向推进（回退请求原样返回现态，sidepanel 据此标「已沟通过」）；
// 无行 → 建行（docId 必填——/applications 页卡片链接 /edit?id= 需要它）。
// 不做冻结快照/存档 PDF（那是 /app/add「记录已发生投递」的重链路；扩展行是真投递前的待投卡，轻建即可）。
export function extensionApplyRecord(root, body) {
  const b = isObj(body) ? body : {};
  const jobId = String(b.jobId || '').trim();
  if (!VALID_JOB_ID.test(jobId)) throw err(400, '缺少或非法 jobId（站点采集 id 形如 site-zhipin-com-xxx）');
  const status = (b.status === undefined || b.status === '') ? 'to_apply' : String(b.status);
  if (!APP_STATUS_ALL.includes(status)) throw err(400, '非法 status（允许值：' + APP_STATUS_ALL.join(' / ') + '）');
  const company = String(b.company || '').trim();
  const role = String(b.role || '').trim();
  const link = safeUrl(b.link);
  const docId = String(b.docId || '').trim();

  const apps = loadAppsTable(root);
  const hit = rowByJobKey(apps, jobId);
  if (hit) {
    const cur = appStatus(hit.status);
    if ((STATUS_RANK[status] ?? -1) > (STATUS_RANK[cur] ?? -1)) {
      hit.status = status;
      // 首次推进到 applied 及之后 → 补投递日期（followup 的「无回应 N 天」从 appliedAt 起算）
      if ((STATUS_RANK[status] ?? -1) >= STATUS_RANK.applied && !String(hit.appliedAt || '').trim()) hit.appliedAt = todayStr();
      hit.updatedAt = timestamp();
      saveAppsTable(root, apps);
      return { ok: true, id: String(hit.id || ''), status };
    }
    return { ok: true, id: String(hit.id || ''), status: cur };   // 幂等/回退：现态原样返回，不回退
  }

  if (!company) throw err(400, '缺少 company');
  if (!role) throw err(400, '缺少 role');
  if (!docId) throw err(400, '缺少 docId（先在面板选择默认简历）');
  if (!VALID_ID.test(docId)) throw err(400, '非法 docId');
  if (!fs.existsSync(path.join(root, 'docs', docId + '.html'))) throw err(404, '简历文档不存在');

  // 行时间戳与 /app/add 同格式（timestamp()——updatedAt 混格式会让按它排序的投影漂移）
  const id = timestamp();
  const now = id;
  apps.push({
    id, company, role, docId, jobId,
    jd: '', note: '', channel: 'extension',
    link, appliedAt: (STATUS_RANK[status] ?? -1) >= STATUS_RANK.applied ? todayStr() : '',
    nextStep: '', dueDate: '', status,
    createdAt: now, updatedAt: now,
  });
  saveAppsTable(root, apps);
  return { ok: true, id, status };
}

// ===== GET /extension/resume-text =====
export function extensionResumeText(root, docIdRaw) {
  const { id, text } = docTextOf(root, docIdRaw);
  return { ok: true, docId: id, text };
}

// ===== 散文清洗：剥代码围栏与包裹引号 → 单行 → 截断 =====
function cleanProse(raw, max) {
  return String(raw ?? '')
    .replace(/```(?:\w+)?\s*/g, '')
    .replace(/^[「『"'“]+\s*/, '')
    .replace(/\s*[」』"'”]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ===== POST /extension/greeting =====
// 岗位文本三来源：jdText 直用 > jobId 命中投递行（role/company + 行 jd）> jobId 走上游详情（A2 jobPromptText）。
// 站点采集岗必有投递行（加入待投即建行），上游路径只服务本仓 /jobs 页那类真上游 id。
export async function extensionGreeting({ root = defaultRoot(), body, lease } = {}) {
  const b = isObj(body) ? body : {};
  const doc = docTextOf(root, b.docId);
  const jid = String(b.jobId || '').trim();
  const jd = typeof b.jdText === 'string' ? CLIP(b.jdText, JD_TEXT_MAX) : '';
  if (!jid && !jd.trim()) throw err(400, '缺少 jobId 或 jdText');
  if (jid && !VALID_JOB_ID.test(jid)) throw err(400, '非法 jobId');

  let jobText = jd.trim();
  if (!jobText && jid) {
    const row = rowByJobKey(loadAppsTable(root), jid);
    if (isObj(row)) {
      jobText = [
        `职位：${String(row.role || '?')}（${String(row.company || '?')}）`,
        String(row.jd || '').trim() ? `\n【职位描述】\n${CLIP(row.jd, JD_FIELD_MAX)}` : '',
      ].filter(Boolean).join('\n');
    } else {
      try { jobText = jobPromptText(await fetchUpcvJob(jid)); }
      catch (e) { const x = err(502, '职位详情失败：' + String((e && e.message) || e)); x.cause = e; throw x; }
    }
  }

  const sys = '你是求职者本人，在招聘网站给招聘方发第一条打招呼消息。根据你的简历亮点和目标岗位写这段招呼语。\n'
    + '规则：\n'
    + '- 只输出招呼语本身，不要解释、引号或客套框架。\n'
    + '- 突出与岗位最相关的 1-2 个亮点；语气自然礼貌，不卑不亢。\n'
    + '- 严禁编造简历里没有的经历、技能或数字；找不到直接相关亮点时，用真实且笼统的表述。\n'
    + `- 不超过 ${GREETING_MAX} 字。`;
  const user = `【目标岗位】\n${jobText || '（未提供职位详情）'}\n\n【我的简历】\n${CLIP(doc.text, DOC_TEXT_MAX)}`;

  let out = '';
  for (let i = 0; i < 2 && !out; i++) out = cleanProse(await chat(root, sys, user, { lease }), GREETING_MAX);
  if (!out) throw err(502, '招呼语生成失败（模型输出为空）');
  return { ok: true, greeting: out };
}

// ===== POST /extension/chat-reply =====
// 简历基底 = 母版（契约无 docId）；jobId 命中投递行时附岗位上下文（行 jd/company/role）。
export async function extensionChatReply({ root = defaultRoot(), body, lease } = {}) {
  const b = isObj(body) ? body : {};
  const hist = typeof b.historyText === 'string' ? b.historyText : '';
  if (!hist.trim()) throw err(400, '缺少 historyText');
  const jid = String(b.jobId || '').trim();
  if (jid && !VALID_JOB_ID.test(jid)) throw err(400, '非法 jobId');
  const doc = docTextOf(root, '');   // 母版

  let jobCtx = '';
  if (jid) {
    const row = rowByJobKey(loadAppsTable(root), jid);
    if (isObj(row)) {
      jobCtx = `\n\n【目标岗位】\n${String(row.role || '?')}（${String(row.company || '?')}）`
        + (String(row.jd || '').trim() ? `\n${CLIP(row.jd, JD_FIELD_MAX)}` : '');
    }
  }

  const sys = '你是求职者本人，正在招聘网站与招聘方（HR/面试官）聊天。根据聊天记录写一条回复草稿。\n'
    + '规则：\n'
    + '- 直接回应对方最后一条消息的问题或请求；可用简历里的真实经历支撑。\n'
    + '- 严禁编造简历里没有的经历或数字；不主动报价、不承诺简历里没有的条件。\n'
    + `- 只输出回复正文，不要解释或引号。不超过 ${DRAFT_MAX} 字。`;
  const user = `【聊天记录】\n${hist.slice(-HISTORY_MAX)}\n\n【我的简历】\n${CLIP(doc.text, DOC_TEXT_MAX)}${jobCtx}`;

  let out = '';
  for (let i = 0; i < 2 && !out; i++) out = cleanProse(await chat(root, sys, user, { lease }), DRAFT_MAX);
  if (!out) throw err(502, '回复草稿生成失败（模型输出为空）');
  return { ok: true, draft: out };
}
