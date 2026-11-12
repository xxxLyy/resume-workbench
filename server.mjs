// server.mjs — 简历平台服务（Node 内置模块，零框架）
// 数据根：RESUME_ROOT（缺省=脚本目录）。测试隔离靠它，代码/静态资源永远来自 APP_ROOT。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { structureText } from './structure.mjs';
import { importPdfText } from './importer.mjs';   // PDF 上传导入（AUD-12：接回既有首页入口）
import { loadProfiles, hasLLM, chat, chatMsgs, listModels, assertSafeBaseURL } from './llm.mjs';   // assertSafeBaseURL：/ai/jd-text 的 SSRF 防线
import { buildRewrite, buildChat, parseChanges, buildReview, buildMatch, parseReport } from './ai.mjs';
import { buildJobPrompt, parseJobOps, pageSuggestions } from './job.mjs';
import { buildEvalPrompt, parseEvalReport, evalSource, evalRecordView } from './eval.mjs';
import { docToLines, docToText, contentHash, sectionsOf, bodyOf, decodeEntities } from './extract.mjs';
import { normalizeZids, zoneSync, guessZone, ZONE_KEYS, ZONE_LABELS, zoneParas, digestOf, buildZoneAnalyzePrompt, parseZoneAnalysis, buildZoneRewritePrompt, parseZoneRewrites, FACT_KEYS, MAT_STATES, migrateMats, parasOf, zidsOf, zoneEditUnits } from './zone.mjs';
import { applyZoneOps } from './zone-ops.mjs';   // 区域安全子集（ZONE-04）：磁盘正文 + 提交原文 + 归属 + 锁 + 事实护栏 五项齐备才应用
import { rotateLogIfNeeded } from './logrotate.mjs';
import { freezeHtml, normalizeToCurrent, splitDoc, staleInfo } from './freeze.mjs';
import { beginTx, commitTx, dropSupersededTx, recoverPending, withDocLock, updateMeta, updateMetaAll, rootLock, atomicWrite, LockHeld } from './tx.mjs';
import { safeUrl } from './safe-url.mjs';   // URL 协议白名单（S4B-9；escAttr 不校验协议）
import { sumExpandedBytes, MAX_EXPANDED_BYTES } from './restore-guard.mjs';   // 备份包展开尺寸护栏（S4B-10）
import { aiPool, renderPool, ResourceBusy } from './resource-slots.mjs';
import { trustedRenderHtml } from './render-safe.mjs';   // 受信渲染输入（AUD-05）：未知脚本/事件属性/外联载体不得进入渲染
import { publishPair, makeIdentityValidator } from './render-publish.mjs';   // PDF+旁车成对发布（AUD-07）   // 共享容量池（RES-01/02/03）：AI 与渲染各 2 个并发

/**
 * JD 文本入库上限（S4B-12）。链接抓取路径 cap 在 4000 字，粘贴路径原本完全没 cap：
 * 二轮审查实测 6 次 2MB JD 粘贴 → docs-meta.json 涨到 12.59MB，而每次 updateMeta 都整表重写
 * （12.6MB 时单次 /save 0.088s vs 正常 ~10ms）——一次粘贴把之后每次保存都拖慢一个数量级。
 * 提到模块级：/job/create、/app/add 两个写 jd 的入口必须共用同一上限。
 */
const JD_MAX_CHARS = 64 * 1024;
import { applyOps, reviewConsistency, refFresh, buildEvidencePrompt, parseEvidence, buildInterviewPrompt, parseInterview, guardOps, exportChecks, layoutDiagnose, resolveInterviewSources, interviewSourceView, evidenceSourceView } from './evidence.mjs';
import { completeGenResult } from './gen-result.mjs';   // 任务完成判定纯函数（设计 §4）：显式成功/拒绝 + 独立工作副本
import { assembleTemplate, listThemes, themeCss, themeRegistration } from './template.mjs';
import { loadApplyProfilesView, loadApplyProfiles, setField, setFieldSource, bindCommonMaster, ensurePackage, updateApplyProfiles, copyTaskKey, copySource, FIELD_CATALOG, DERIVED_KEYS, MODE_FOLLOW, MODE_OVERRIDE, MODE_MANUAL, MODE_AI, SOURCE_RESUME, SOURCE_COMMON } from './apply-profile.mjs';   // 网申包数据层（批 3 卡片 b3c1）：账本/三态/派生/漂移
import { startCopyTask, runCopyTask, copyTaskState, cancelCopyTask, confirmCopyDraft, discardCopyDraft, finishCopyTask, isCopyKey, stageLabel, NO_MODEL_HINT, COPY_TTL_MS } from './apply-gen.mjs';   // AI 文案字段生成任务层（批 3 卡片 b3c3）：genTasks 口径（进度/取消/真实用量）
import { followUpState, followUpDays, normalizeFollowUpDays, followUpTask, followUpDraft, startFollowUpTask, followUpStateOf, cancelFollowUpTask, discardFollowUpDraft, runFollowUpTask, failFollowUpTask, followUpSource, FOLLOW_UP_TTL_MS, FOLLOW_UP_NO_MODEL_HINT } from './followup.mjs';   // 跟进助手（批 3 卡片 b3c4）：无回应满 N 天 → 跟进语草稿（只生成不发送）
import { hideFieldsInHtml, shareExpectations, findResidues, absentKeys, addShareRecord, sharePdfPath, SHARE_ID_RE } from './share-copy.mjs';   // 分享副本（批 3 卡片 b3c5）：勾选隐藏字段 → 独立预览/PDF + 文本层无残留校验
import { PRACTICE_CAP, PRACTICE_TTL_MS, PRACTICE_NO_MODEL_HINT, buildPracticeSession, appendPracticeSession, savePracticeAnswer, normalizeAnswerText, startPracticeFeedbackTask, cancelPracticeFeedbackTask, runPracticeFeedbackTask, failPracticeFeedbackTask, findSession, findQuestion, practiceSessions, practiceSessionView, sessionSummary, feedbackResultOf, missingMatLinkOf, linkMissingMaterial, POINT_STATE_LABEL } from './practice.mjs';   // 练习会话 API（批 4 卡片 b4c1）+ 练习 UI/缺项转待补充（批 4 卡片 b4c2）：出题复用 kind=interview 产物 + 逐题作答 + AI 对照证据表反馈（无百分位无排名）+ 历史随投递截 20
import { ICONS } from './vendors/icons.mjs';  // Lucide 图标数据（纯数据文件，零 npm 依赖）

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.RESUME_ROOT || APP_ROOT;   // 数据根（docs/snapshots/pdfs/JSON/backups 全在此）
// 自绘线稿插画：读入内联，避免新增静态资源路由（路由集合冻结）
const svgAsset = (name) => {
  try { return fs.readFileSync(path.join(APP_ROOT, 'assets', name), 'utf8').replace(/^<\?xml[^>]*\?>\s*/, ''); }
  catch { return ''; }   // 缺失 → 空插画位，不影响功能
};
const HERO_SVG = svgAsset('hero-mirror.svg');
for (const d of ['docs', 'snapshots', 'pdfs', 'backups', 'logs', '.tx', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
// photos/ 自排除 Git（S5 照片方案）：目录内 .gitignore 忽略全部内容——不改仓库 .gitignore 即达成「照片排除 Git」
try {
  const obGi = path.join(root, 'photos', '.gitignore');
  if (!fs.existsSync(obGi)) fs.writeFileSync(obGi, '# 照片属个人隐私：本目录内容一律不入库（S5 设计 §5）\n*\n!.gitignore\n');
} catch (e) { console.error('[startup] photos/.gitignore 写入失败: ' + (e && e.message)); }

// 服务日志由 launchd 写入 RESUME_LOG_FILE：启动时轮转一次，此后每 24h 检查（copytruncate，50MB 触发、留尾部 2MB 到 .1）
// 日志权限收紧（2026-10-19 安全审查 ⚪-6）：日志由 launchd 打开，创建时的 umask 决定权限，
// 实测是 0644（同机其他用户可读），内容含绝对路径与渲染栈。启动时改一次即可。
// 日志文件不在本仓库的 gitignore 关注范围，但它在数据目录里，权限应与 config.json 一致。
try {
  const _lf = process.env.RESUME_LOG_FILE;
  if (_lf && fs.existsSync(_lf)) fs.chmodSync(_lf, 0o600);
} catch (e) { console.error('[startup] 日志权限收紧失败: ' + (e && e.message)); }
// ===== 数据目录权限收紧（2026-10-19 安全审查 ⚪-6 扩展）=====
// 背景：实测数据目录里的内容（简历正文 / 投递记录 / 素材 / 快照 / PDF）全是 0644，
// 同机其他用户可读。数据文件属个人隐私，权限应与 config.json 一致（0600）。
// 覆盖三条路径：① 启动时修历史遗留 ② atomicWrite 落盘即 0600（tx.mjs）
// ③ 恢复/回退走 cpSync（不经过 atomicWrite），恢复后须再收紧一次。
function hardenDataPerms(root) {
  for (const f of ['docs-meta.json', 'applications.json', 'materials.json', 'evaluations.json', 'config.json']) {
    const fp = path.join(root, f);
    try { if (fs.existsSync(fp)) fs.chmodSync(fp, 0o600); } catch {}
  }
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else { try { fs.chmodSync(fp, 0o600); } catch {} }
    }
  };
  for (const d of ['docs', 'snapshots', 'pdfs', 'backups', 'photos']) {
    const dp = path.join(root, d);
    if (!fs.existsSync(dp)) continue;
    try { fs.chmodSync(dp, 0o700); } catch {}   // 目录不给其他用户列目录
    walk(dp);
  }
}
try { hardenDataPerms(root); } catch (e) { console.error('[startup] 数据权限收紧失败: ' + (e && e.message)); }
rotateLogIfNeeded(process.env.RESUME_LOG_FILE);
setInterval(() => rotateLogIfNeeded(process.env.RESUME_LOG_FILE), 24 * 3600 * 1000).unref();

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SNAPSHOTS = 50;
// 只读预览页统一锁定 CSP（/snapshot/view 与 S6-A2 /theme-preview 共用）：正文是外部输入且预览
// 不需要脚本/网络/框架 → default-src 'none' 一刀切（BL-P1-02≡BL-P7-01 + BL-P7-02 口径）。
const LOCKED_PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');
// 迁移互斥（S1-T7 修复轮1 I-3）：这些 GET 名义是读，实际会 renderCurrent → updateMeta(lastRenderInputId/lastRenderAt)
// 并覆写 pdfs/<id>.pdf、拉起 Chromium；迁移三门禁期间放行它们＝浏览器标签页与迁移并发写 meta / 抢渲染。
// 故与他人持 .migrate.lock 期间同样 503（纯读 GET 一律不受影响）。新增会写盘的 GET 必须登记到这里。
const WRITE_ON_GET = new Set(['/pdf', '/export', '/job/changes', '/snapshot/pdf']);   // /job/changes GET 读取时清过期 running 任务（S4a-T4）；/snapshot/pdf 渲染并写 pdfs/history/（2026-10-22 审查 [低]）
// 编辑器瞬态 body class：旧文档的内联清理选择器不认 ed-focus，必须由服务端兜底（设计 §6.2）
const EDITOR_ONLY_BODY_CLASS = new Set(['ed-on', 'ed-preview', 'ed-focus']);
const APP_STATUSES = ['已投递', '笔试', '面试中', 'offer', '已拒', '搁置'];
const APP_TERMINAL = ['offer', '已拒', '搁置'];
// 显示层映射（2026-11-04 视觉收尾轮，DESIGN.md §10）：存量数据与 /app/update 接口值仍为 'offer'，仅界面文案中文化
const statusLabel = (s) => (s === 'offer' ? '录用' : s);
// 界面时间一律人话格式（DESIGN.md §10）：ISO 串（含 datetime-local 的 T 分隔）不出现在页面上；非法值如实原样返回
const fmtWhen = (raw) => {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return String(raw);
  const hasTime = String(raw).includes(':');
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return (d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '年') + (d.getMonth() + 1) + '月' + d.getDate() + '日' + (hasTime ? ' ' + hm : '');
};
const docPath = (id) => path.join(root, 'docs', id + '.html');
// 磁盘上的文档 id 清单：只取通过 VALID_ID 的。
// 文件名是外部输入（备份恢复 / 手工放置）→ 非法 id 绝不能进任何渲染点：
// 首页、投递页、对比页都把 id 原样拼进 HTML 属性与内联脚本（value="${id}"、data-id="${id}"、
// action="?id=…"；b5c1 委托化前内联 onclick="…('{id}')" 也是注入点），
// 带引号的 id 即存储型 XSS（2026-10-22 实测：点「删除」真的执行 alert(1)）。
// 写入侧一律用 VALID_ID 闸门，读取侧同一把尺。
const docIdsOnDisk = () => fs.readdirSync(path.join(root, 'docs'))
  .filter((f) => f.endsWith('.html') && !f.startsWith('.'))
  .map((f) => f.replace('.html', ''))
  .filter((id) => VALID_ID.test(id))
  // 必须是普通文件：同名目录会让 docInfo 的 readFileSync 抛 EISDIR → 首页整体 500
  .filter((id) => { try { return fs.statSync(docPath(id)).isFile(); } catch { return false; } });
const pdfPath = (id) => path.join(root, 'pdfs', id + '.pdf');
const snapDir = (id) => path.join(root, 'snapshots', id);
const archivePath = (aid) => path.join(root, 'pdfs', 'archive', aid + '.pdf');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// ===== JSON 数据层：读容忍缺失、损坏必须显式暴露；写前校验，损坏即停写 =====
const JSON_FILES = { meta: 'docs-meta.json', apps: 'applications.json', mats: 'materials.json', evals: 'evaluations.json' };
const corrupt = new Set();
const dataFile = (name) => path.join(root, JSON_FILES[name]);
// 根值形状要求：可解析 ≠ 形状正确。docs-meta.json 必须是普通对象，applications/materials 必须是数组。
// 形状错时读取侧会静默降级为 fallback（[] / {}），随后的任意一次保存就把原表整体覆盖成空——
// 实测 applications.json 被写成对象后一次 saveApps 即清空全部投递记录。
const shapeOk = (name, d) => name === 'meta'
  ? !!d && typeof d === 'object' && !Array.isArray(d)
  : Array.isArray(d);
function readJson(name, fallback) {
  const f = dataFile(name);
  if (!fs.existsSync(f)) return fallback;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!shapeOk(name, d)) { corrupt.add(name); return fallback; }
    corrupt.delete(name); return d ?? fallback;
  } catch { corrupt.add(name); return fallback; }
}
function assertWritable(name) {
  const f = dataFile(name);
  if (!fs.existsSync(f)) return;
  let parsed = null, bad = false;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { bad = true; }
  if (!bad) bad = !shapeOk(name, parsed);
  if (bad) {
    corrupt.add(name);
    throw Object.assign(new Error(`数据文件损坏，已停止写入：${JSON_FILES[name]}。请先人工修复或从备份恢复。`), { httpCode: 500, code: 'CORRUPT' });
  }
  corrupt.delete(name);
}
function writeJson(name, data) {
  assertWritable(name);
  const tmp = dataFile(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });   // 0600：数据文件同机其他用户不该可读（2026-10-19 审查 ⚪-6 扩展）
  fs.renameSync(tmp, dataFile(name));
}
const loadMeta = () => readJson('meta', {});
// 读时迁移视图（S3-T7）：旧形状（confirmed 布尔/缺 facts）在读取时补齐，不写盘；saveMats 往返自然渐进迁移
const loadMats = () => migrateMats(readJson('mats', []));
const loadApps = () => { const a = readJson('apps', []); return Array.isArray(a) ? a : []; };
const loadEvals = () => { const a = readJson('evals', []); return Array.isArray(a) ? a : []; };
const saveMats = (mats) => writeJson('mats', mats);
const saveApps = (apps) => writeJson('apps', apps);
const saveEvals = (list) => writeJson('evals', list);
// docs-meta.json 无 saveMeta：唯一写入者为 tx.mjs 的 updateMeta（读最新→只 patch 目标文档→原子 rename），见各写路径。
// —— JD 指纹护栏（career-ops 移植，设计: dev-docs/2026-10-18-career-ops-jd-fingerprint-design.md）——
// 用动态 import 而非顶部静态 import：vendors 模块损坏（如上游同步引入语法错误）时
// 降级跳过护栏，不拖垮 server 启动。模糊匹配不阻断创建；任何异常只记日志。
// 有界远程页面读取（AUD-17）：/job/create 与 /ai/jd-text 共用同一实现。
// 两条防线：① Content-Length 已知超限 → 直接拒绝，不必下载；
// ② 没有长度 → 流式累计并即时中断。不能等完整 body 收完再判大小（那等于没有上限）。
const JD_PAGE_MAX_BYTES = 5 * 1024 * 1024;
// 请求体/渲染输入共用上限（BL-P1-04）：readBody 的默认 body 上限与 renderDoc 调
// trustedRenderHtml 的 maxHtmlBytes 必须同一常量来源。此前渲染侧取 render-safe.mjs 的
// 4MB 默认 → 「保存接受 ≤10MB、渲染 4MB 硬拒」，大文档能存能编辑却永远出不了 PDF。
// 超限时 renderDoc 返回带尺寸原因的 sizeError（客户端可见），不再只有「渲染失败（详见服务日志）」。
const MAX_BODY_BYTES = 10 * 1024 * 1024;
// MB 展示口径（BL-P1-04）：超限文案统一走这里（10 不显示成 10.0）
const mbLabel = (n) => `${Number((Number(n) / (1024 * 1024)).toFixed(1))} MB`;
// 恢复/撤销的受管项（AUD-09）：存在性台账只覆盖这些；config.json 刻意不在其中（恢复不碰配置）。
const RESTORE_MANAGED_DIRS = ['docs', 'snapshots', 'pdfs'];
const RESTORE_MANAGED_FILES = ['docs-meta.json', 'applications.json', 'materials.json', 'evaluations.json'];
async function fetchPageText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > JD_PAGE_MAX_BYTES) throw new Error('页面超过 5MB 上限');
  const chunks = []; let size = 0;
  for await (const c of r.body) {
    size += c.length;
    if (size > JD_PAGE_MAX_BYTES) throw new Error('页面超过 5MB 上限');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}

async function computeFpGuard(jd, jdLink, company, metaAll) {
  try {
    const { fingerprintText } = await import('./vendors/jd-fingerprint/fingerprint-core.mjs');
    const { findDupHints, fpTodo } = await import('./vendors/jd-fingerprint/repost-check.mjs');
    const jdFp = fingerprintText(jd || '');
    if (!jdFp) return { jdFp: '', dupHints: [], todos: [] };   // 新 JD 不可指纹 → 静默零提醒
    const records = [];
    for (const [k, m] of Object.entries(metaAll)) {
      if (!m || m.kind !== 'job') continue;
      if (!m.jd && !(m.job && m.job.jdFp)) continue;
      records.push({ jd: m.jd || '', jdFp: (m.job && m.job.jdFp) || '', company: m.company, dateStr: m.createdAt, kind: 'draft', label: `${m.company || ''}·${m.role || ''}`, link: (m.jdSource || '').startsWith('http') ? m.jdSource : '' });
    }
    for (const a of loadApps()) {
      if (!a || (!a.jd && !a.link)) continue;
      records.push({ jd: a.jd || '', company: a.company, dateStr: a.appliedAt || a.createdAt || '', kind: 'app', label: `${a.company || ''}·${a.role || ''}`, link: a.link || '', status: a.status });
    }
    // 第五路：岗位评估记录（/eval/create 落库）。评估过但没投的岗位同样要提醒，
    // 否则用户会对同一个 JD 反复评估、反复适配。score/verdict 供 fpTodo 渲染「评估过 X 分」。
    for (const e of loadEvals()) {
      if (!e || !e.jd) continue;
      records.push({ jd: e.jd, jdFp: e.jdFp || '', company: e.company, dateStr: e.createdAt, kind: 'eval', label: `${e.company || ''}·${e.role || ''}`, score: e.score, verdict: e.verdict });
    }
    // todo 与 dupHints 同源同 try：vendors 模块损坏时两者一起降级，绝不产出半截提醒。
    const dupHints = findDupHints(jd, records, { newCompany: company, newLink: jdLink || '' });
    return { jdFp, dupHints, todos: fpTodo(dupHints) };
  } catch (e) { console.error('[fp-guard] 降级跳过:', e && e.message); return { jdFp: '', dupHints: [], todos: [] }; }
}

/**
 * 岗位草稿的唯一创建路径：/job/create（用户粘贴 JD）与 /eval/promote（高分评估转适配）都调它。
 * 抽成函数而不是各写一份：去重判定、冻结快照、正文落盘、JD 截断、指纹护栏、meta 落库
 * 任一环节两处漂移，promote 就会造出与 /job/create 行为不一致的草稿——而这种不一致只在
 * 「先评估后转换」这条低频路径上暴露，正则级回归也测不出来。改这里，两条路径一起改。
 * 返回 {ok:true, id, jdError, dupHints} 或 {ok:false, status, body}（body 直接可 sendJson）。
 */
// ===== 创建保留（AUD-14）=====
// 保留文件放在 <root>/.creating/ 下：原子创建（wx）= 唯一赢家。
// 不用共享根锁：那会把整个数据根的写操作都挡住（而 JD 抓取可能等十几秒）。
const CLAIM_DIR = '.creating';
const claimPath = (root, key) => path.join(root, CLAIM_DIR, contentHash(String(key)).slice(0, 24) + '.claim');
// 陈旧保留：持有者已死，或超过 5 分钟兜底 → 可破除（否则进程崩溃会永久挡住该身份）
function claimStale(p) {
  try {
    const info = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (info && typeof info.pid === 'number' && info.pid !== process.pid) {
      try { process.kill(info.pid, 0); return false; } catch (e) { if (e.code === 'EPERM') return false; }
    }
    if (info && typeof info.at === 'number' && Date.now() - info.at > 300000) return true;
    return false;
  } catch { return false; }
}
function acquireClaim(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(p, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!claimStale(p)) return false;
      try { fs.unlinkSync(p); } catch {}   // 陈旧保留 → 破除后重试一次
    }
  }
  return false;
}
function releaseClaim(p) { try { fs.rmSync(p, { force: true }); } catch {} }
async function waitClaim(p, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (!fs.existsSync(p)) return true; await new Promise((r) => setTimeout(r, 50)); }
  return !fs.existsSync(p);
}

async function createJobDraft(root, o) {
  const from = String(o.from || '');
  const company = String(o.company || '').trim();
  const role = String(o.role || '').trim();
  if (!VALID_ID.test(from)) return { ok: false, status: 400, body: { ok: false, error: 'invalid from' } };
  if (!company || !role) return { ok: false, status: 400, body: { ok: false, error: '公司、岗位必填' } };
  const nb = normBrief(o.brief);   // S4a-T5：brief 可选（缺省渐进默认），非法值 400
  if (nb.error) return { ok: false, status: 400, body: { ok: false, error: nb.error } };
  if (!fs.existsSync(docPath(from))) return { ok: false, status: 404, body: { ok: false, error: '母版文档不存在' } };

  // 创建保留（AUD-14）：同一 (母版,公司,岗位) 的并发创建只能成功一个。
  // 原实现的去重检查发生在异步 JD 抓取【之前】→ 两个并发请求都读到同一份 meta、都没查到重复，
  // 各自建出 -v2 / -v3 两份草稿（实测两次都 200）。
  // 这里用「锁文件 + wx 原子创建」做小范围保留：只挡同一创建身份，
  // 不占共享根锁（那会把整个数据根的写操作都挡住，而网络等待可能十几秒），别的文档照常保存。
  const claim = claimPath(root, from + '|' + company + '|' + role);
  if (!acquireClaim(claim)) {
    // 别人正在创建同一身份：等它结束（最多 5s）再看结果
    await waitClaim(claim, 5000);
    const after = loadMeta();
    const dup2 = Object.keys(after).find((k) => {
      const m = after[k];
      return m && m.parent === from && m.company === company && m.role === role && fs.existsSync(docPath(k));
    });
    if (dup2) return { ok: false, status: 409, body: { ok: false, existing: dup2 } };
    return { ok: false, status: 409, body: { ok: false, error: '同一岗位正在创建中，请稍后重试' } };
  }
  let to = null;
  try {
    // 拿到保留后再查重（此刻没有同身份的并发创建）
    const metaAll = loadMeta();
    const dup = Object.keys(metaAll).find((k) => {
      const m = metaAll[k];
      return m && m.parent === from && m.company === company && m.role === role && fs.existsSync(docPath(k));
    });
    if (dup) return { ok: false, status: 409, body: { ok: false, existing: dup } };
    // 冻结来源版本（快照 = freezeHtml + manifest），返回冻结 ts 供之后追溯
    const srcSnap = snapshot(from);
    // 目标文件名也要原子分配（wx）：两个并发可能算出同一个 -v2（都看到文件不存在）
    for (let n = 2; ; n++) {
      const cand = `${from}-v${n}`;
      try { const fd = fs.openSync(docPath(cand), 'wx', 0o600); fs.closeSync(fd); to = cand; break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    // 冻结点：母版 freezeHtml（自包含内联 typo）→ 归一化为当前格式落活文档（禁止直接 copy 冻结字节）
    const srcHtml = fs.readFileSync(docPath(from), 'utf8');
    const srcMeta = metaAll[from] || {};
    const normJob = normalizeToCurrent(freezeHtml(srcHtml, srcMeta).html);
    atomicWrite(docPath(to), normJob.html);
    // JD：优先文本；给了链接且无文本时尝试读取，失败则记录待补充
    let jdRaw = typeof o.jd === 'string' ? o.jd.trim() : '';
    let jdTruncated = jdRaw.length > JD_MAX_CHARS;
    let jd = jdTruncated ? jdRaw.slice(0, JD_MAX_CHARS) : jdRaw;
    let jdLink = typeof o.jdLink === 'string' ? o.jdLink.trim() : '';
    // 截断与「链接读取失败」是两回事，todo 文案必须分开：复用后者的模板会显示成
    // 「JD 链接读取失败（…），请粘贴 JD 文本」——用户明明已经粘贴了，让他再粘一次是荒谬的（2026-10-18 实测）。
    let jdError = '';
    let jdTruncNote = jdTruncated ? 'JD 超过 64 KB，仅前 64 KB 纳入分析（尾部未读）。JD 过长通常意味着粘进了整页网页，可只保留「岗位职责 + 任职要求」两段。' : '';
    if (!jd && jdLink) {
      try {
        if (!/^https?:\/\//.test(jdLink)) throw new Error('仅支持 http/https 链接');
        // SSRF 防线：与 /ai/jd-text 同一道 assertSafeBaseURL（2026-10-22 审查 [高]）——
        // 原先这里只有 ^https?://，任意内网/云元数据地址都能被服务端抓取，原文写进 meta.jd 并回显。
        // redirect:'error'：不跟随 302，否则首跳过了校验、跟着跳到黑名单地址。
        assertSafeBaseURL(jdLink);
        jd = await fetchPageText(jdLink);
      } catch (e) { jdError = String(e.message || e); }
    }
    const { jdFp, dupHints, todos } = await computeFpGuard(jd, jdLink, company, metaAll);
    const nowIso = new Date().toISOString();
    // meta 唯一写入者 updateMeta：只写目标文档 to（不整表覆盖，避免踩并发更新）；状态维度 kind/flow/archivedAt（job.status 不再写，单源 flow）
    updateMeta(root, to, () => ({
      parent: from, company, role, jd, jdSource: jd ? (o.jdSource ? String(o.jdSource) : (jdLink ? jdLink : '手动')) : (jdLink || ''),
      createdAt: nowIso,
      tag: (company + '·' + role).slice(0, 20),
      typo: normJob.typo, theme: srcMeta.theme || normJob.theme || null, styleHash: normJob.styleHash, rev: 1,
      kind: 'job', flow: 'draft', archivedAt: null,
      job: {
        sourceSnap: srcSnap, sourceHash: contentHash(srcHtml),
        materials: Array.isArray(o.materials) ? o.materials.filter((x) => typeof x === 'string') : [],
        brief: nb.brief, jdFp,   // S4a-T5 要求卡（渐进默认：无 brief 时字段全默认）
        changes: [], todos: [...(jdError ? [{ section: '岗位信息', question: 'JD 链接读取失败（' + jdError + '），请粘贴 JD 文本', why: '岗位匹配分析需要 JD', resolved: false }] : []), ...(jdTruncNote ? [{ section: '岗位信息', question: jdTruncNote, why: '截断部分未参与岗位匹配分析，可能影响要求覆盖度判断', resolved: false }] : []), ...todos],
        generatedAt: null, deliveredAt: null
      }
    }));
    return { ok: true, id: to, jdError: jdError || null, dupHints };
  } catch (e) {
    // 失败不留冒充母版的孤儿：正文已落盘但 meta 未登记 → 删掉正文
    if (to) { try { fs.rmSync(docPath(to), { force: true }); } catch {} }
    throw e;
  } finally {
    releaseClaim(claim);   // 提交或失败都释放保留（只有实际工作结束才释放）
  }
}

const corruptBanner = () => corrupt.size
  ? `<div class="card" style="border-color:var(--err-soft);background:var(--err-soft);color:var(--err)"><b>${icon('circle-alert', 13)}检测到数据文件损坏，相关写入已停止：</b>${[...corrupt].map((k) => JSON_FILES[k]).join('、')} —— 请先在设置页用备份恢复，或人工修复 JSON 后刷新。</div>`
  : '';

// ===== 状态维度与派生关联（S1-T8，spec §7/§8，binding）=====
// 存储字段仅 kind('master'|'job') / flow('draft'|'reviewing'|'reviewed') / archivedAt(null|ts)。
// 可投递、deliveredRefs、exports[].usedBy 一律派生、绝不存储：投递关联权威来源 = applications.json，读取时计算、不写回。
const FLOW_VALUES = ['draft', 'reviewing', 'reviewed'];
// flow 单源读取：显式写入的 meta.flow 优先；未迁移旧数据（schemaVersion<2）从 job.status 即时推导
// （'deliverable'/'delivered'→'reviewed'；'draft'+存在 pending 修改→'reviewing'），兼容读绝不写回——
// 写回只发生在 migrate-meta.mjs（映射后删除 job.status，flow 成为唯一状态源）。
function flowOf(m) {
  const mm = m || {};
  if (FLOW_VALUES.includes(mm.flow)) return mm.flow;
  const j = mm.job;
  if (j) {
    if (j.status === 'deliverable' || j.status === 'delivered') return 'reviewed';
    if (j.status === 'draft' && Array.isArray(j.changes) && j.changes.some((c) => c && c.status === 'pending')) return 'reviewing';
  }
  return 'draft';
}
const kindOf = (m) => ((m && (m.kind === 'job' || (!m.kind && m.job))) ? 'job' : 'master');
// 兼容视图（旧词汇，仅供 API 响应展示）：reviewed→'deliverable'，其余→'draft'；投递历史由 deliveredRefs 派生，不再有存储的 'delivered'
const legacyFlowStatus = (m) => (flowOf(m) === 'reviewed' ? 'deliverable' : 'draft');
// ===== S4a-T3：meta.job 新字段渐进默认（计划约束 22——旧草稿无字段全功能可用，读取时补、不迁移）=====
// genTasks 两类 AI 任务各自独立（设计 §4.1/§6）；baseHash 仅任务记录，不参与候选失效判定。
const mkGenTask = () => ({ taskId: null, status: 'idle', startedAt: null, baseHash: null, error: null, scope: null });
// ===== S4a-T4：AI 任务最小可靠性（设计 §6 v1.6——taskId / 原子启动 / 三类回调校验 / 双层超时 / 取消 / 重启恢复）=====
const GEN_KINDS = ['evidence', 'changes', 'interview'];

// ===== /ai/* 与渲染的全局并发闸门（2026-10-19 安全审查 🟡-1 / 🟡-3）=====
// 起因：/job/gen-* 有 startGenTask 的「同类型最多 2 个」闸门，但 6 个 /ai/* 端点
// （rewrite/chat/review/match/zone-analyze/zone-rewrite）直接 await chat()，零闸门 ——
// 任何本地进程循环打就能无限并发调 AI API 直接烧钱。renderDoc 同理：并发 GET /pdf
// 在 stale 时各拉起一个 Chromium（实测 3 请求 = 12 个 chrome-headless-shell），无上限打爆内存。
// 实现：统一在路由分发前取槽，用 res 的 finish/close 释放 —— 不必进每个端点包 try/finally，
// 也不会漏掉将来新增的端点（豁免表显式列出）。
// ⚠️ 计数器必须在【模块级】：放请求处理函数内会每次请求归零，等于没有闸门
//   （2026-10-19 首次实现踩过这个坑，实测 6 并发全 200、假 LLM 峰值 6）。
const AI_EXEMPT = new Set(['/ai/test']);   // 测连接不调 LLM，必须放行否则无法验证配置

// 闸门判定：该路由应占用哪个共享池（null = 不受限）。容量与并发上限由 resource-slots.mjs 统一持有。
// 渲染闸门：凡会拉起 Chromium 的路由都要进（2026-10-22 审查 [中] 实测：
// 原先只管 GET /pdf 与 GET /export → /snapshot/pdf、POST /render、POST /export 各自无限并发拉浏览器）
// 闸门租约透传（RES-02）：handler 借到的 lease 必须一路传到最底层调用。
// 否则底层（llm.mjs / renderDoc）会各自兜底再占一个槽 → 一个请求占两个槽，实际并发减半。
const leaseOf = (req) => (req && req.__resLease) || undefined;

function gatePool(method, pathname) {
  if ((method === 'GET' && (pathname === '/pdf' || pathname === '/export' || pathname === '/snapshot/pdf'))
    || (method === 'POST' && (pathname === '/render' || pathname === '/export'))) {
    return { pool: renderPool, label: '渲染' };
  }
  // /eval/create、/restructure 也直连 LLM → 一并进闸门（实测 4 并发全放行、0×429）
  // /onboarding/star-suggest（S5F）：向导 STAR AI 整理同样直连 chat → 同闸门
  if (method === 'POST' && (/^\/ai\//.test(pathname) || pathname === '/eval/create' || pathname === '/restructure' || pathname === '/onboarding/star-suggest')
    && !AI_EXEMPT.has(pathname)) {
    return { pool: aiPool, label: 'AI' };
  }
  return null;
}
const GEN_TTL_MS = 10 * 60 * 1000;   // 任务级总时限：启动 / 读取 / 完成回调三点校验（兜底 status 永挂 running）
const genExpired = (t, now) => !!(t && t.status === 'running' && typeof t.startedAt === 'number' && t.startedAt + GEN_TTL_MS < now);
const newGenTaskId = () => 't-' + randomBytes(4).toString('hex');

// 读取时校验（三点之二）：/job/changes 组装前扫本文档 genTasks，过期 running → error("任务超时")。
// 只在确有过期时才写（updateMeta 单文档 patch）；返回可能刷新后的 meta 供响应组装。
function sweepGenTasks(id, m) {
  const j = m && m.job;
  if (!j || !j.genTasks) return m;
  const now = Date.now();
  if (!GEN_KINDS.some((k) => genExpired(j.genTasks[k], now))) return m;
  const next = updateMeta(root, id, (cur) => {
    if (!cur || !cur.job || !cur.job.genTasks) return cur;
    for (const k of GEN_KINDS) {
      const t = cur.job.genTasks[k];
      if (genExpired(t, now)) cur.job.genTasks[k] = { ...t, status: 'error', error: '任务超时' };
    }
    return cur;
  });
  return next || m;
}

// 三类回调统一落账口（成功 / 错误 / 超时）：完成判定交给 gen-result.mjs 的纯函数（设计 §4）。
// 约定：业务回调显式返回 {ok:true,extra} 或 {ok:false,error}，不得再靠自行改写任务状态暗示结果；
// 判定在独立工作副本上运行，业务拒绝不提交副本里的内容/批次/版本变化；只有成功落账才写 done。
// 落账用 updateMetaAll：mutator 返回 null = 放弃写入（迟到/被替代/已取消零落账），
// 而不是 updateMeta 的 null = 删除本文档元数据（设计 §4「next=null 不得误用成删除」）。
function finishGenTask(id, kind, taskId, apply, errMsg, usage) {
  let out = { dropped: true };
  updateMetaAll(root, (all) => {
    const result = completeGenResult(all[id], {
      kind, taskId, now: Date.now(), ttlMs: GEN_TTL_MS, apply, errMsg, usage
    });
    out = result.out;
    return result.next ? { ...all, [id]: result.next } : null;
  });
  return out;
}

// 任务记录打补丁（S4b-B 诚实最小进度）：只在管线真有的检查点写，守卫语义与完成回调同款——
// taskId 匹配且仍 running 才写（不复活已取消/超时任务，迟到写入零落账）。
// 检查点：queued 在 startGenTask 注册时写；calling 在拿到槽位后写；parsing+usage 在模型返回后
// 一次写入（usage 先落任务记录，终态由 completeGenResult 的 gt.usage 兜底带上——finishGenTask 各出口零改动）。
function patchGenTask(id, kind, taskId, patch) {
  updateMetaAll(root, (all) => {
    const gt = all[id] && all[id].job && all[id].job.genTasks && all[id].job.genTasks[kind];
    if (!gt || gt.taskId !== taskId || gt.status !== 'running') return null;
    const job = { ...all[id].job, genTasks: { ...(all[id].job.genTasks || {}), [kind]: { ...gt, ...patch } } };
    return { ...all, [id]: { ...all[id], job } };
  });
}

// changes 成功落账（S4a-T8：候选锚定 zid/baseSnapshot/zone + guardOps 锁定与范围护栏 + 局部 supersede 同 zone）
// ctx = { scope:'all'|'zone:<key>', html: 生成基线正文, paras: 基线段落（baseSnapshot 与锚点解析共用）, mats: 已确认素材 }。
// 与旧 /job/generate 的 updateMeta 体一致：gen 递增、旧 pending→superseded（局部仅同 zone）、新候选入列
function applyChangesResult(cur, ops, ctx = {}) {
  const gen = (cur.job.changes.reduce((mx, c) => Math.max(mx, c.gen || 0), 0)) + 1;
  const scope = ctx.scope || 'all';
  const zoneScope = (typeof scope === 'string' && scope.startsWith('zone:')) ? scope.slice(5) : null;
  const zones = cur.zones || {};
  const locked = new Set(Object.entries(zones).filter(([, z]) => z && z.locked === true).map(([zid]) => zid));
  const paras = Array.isArray(ctx.paras) ? ctx.paras : [];
  const paraByZid = new Map(paras.map((p) => [p.zid, p]));
  const zoneOfZid = (zid) => (zones[zid] && zones[zid].zone) || null;
  // supersede（影响隔离，设计 §4.2 反例3）：全文=全部 pending；局部=只清同 zone 的 pending，其他 zone 不动
  // 注意：本循环原先在 guardOps 之前执行 —— 模型输出为空或全被护栏丢弃时，旧 pending 已被抹成 superseded
  // 却没有任何新候选顶上，待审队列静默消失。故移到 guardOps 之后、且仅在确有候选时执行。
  const supersedePending = () => {
    for (const c of cur.job.changes) {
      if (c.status !== 'pending') continue;
      if (!zoneScope || (c.zone || zoneOfZid(c.zid)) === zoneScope) c.status = 'superseded';
    }
  };
  // 锚点解析：优先模型回传 zid（局部重生成的请求内标注），否则按 before/entry 文本匹配基线段落（首个命中）。
  // add = 容器锚点（目标章节首个段落；容器消失 → anchor-gone，新段落 zid 接受时才创建——设计 §4.2）
  const byText = (needle) => {
    const n = String(needle || '').trim();
    return n ? (paras.find((p) => p.text && (p.text.includes(n) || n.includes(p.text))) || null) : null;
  };
  const anchorOf = (c) => {
    if (c.kind === 'add') {
      const a = String(c.section || '').trim();
      const sec = sectionsOf(String(ctx.html || '')).find((s) => {
        const b = String(s.title || '').trim();
        return b && a && (b.includes(a) || a.includes(b));
      });
      const zid = sec ? zidsOf(sec.html)[0] : null;
      const p = zid ? paraByZid.get(zid) : null;
      return { zid: zid || null, baseSnapshot: p ? p.text : null };
    }
    const hinted = (typeof c.zid === 'string' && paraByZid.has(c.zid)) ? c.zid : null;
    const hit = hinted ? paraByZid.get(hinted) : byText(c.kind === 'hide' ? (c.entry || c.before) : (c.before || c.entry));
    return { zid: hit ? hit.zid : null, baseSnapshot: hit ? hit.text : null };
  };
  const protectedTokens = [...new Set((ctx.mats || []).flatMap((m) => [(m.facts || {}).company, (m.facts || {}).role]).filter((t) => typeof t === 'string' && t))];
  // S4a 补齐 guardOps ③：条目结构（entry-head → 其成员段落）+ keepProjects 展开
  // 条目组：按文档序扫 data-zid 单元，entry-head 开新组，其后 p/li 归入该组；组头 zid → [组头+成员] 即 expand。
  const unitZids = zidsOf(String(ctx.html || ''));
  const headSet = new Set([...String(ctx.html || '').matchAll(/<div class="entry-head"[^>]*data-zid="(z[0-9a-f]{8})"/g)].map((x) => x[1]));
  const groups = [];   // [{head, members:[zid]}]（文档序）
  let cur2 = null;
  for (const zid of unitZids) {
    if (headSet.has(zid)) { cur2 = { head: zid, members: [] }; groups.push(cur2); }
    else if (cur2) cur2.members.push(zid);
  }
  const groupOfZid = new Map();   // 任意 zid → 所在组
  for (const grp of groups) { groupOfZid.set(grp.head, grp); for (const z of grp.members) groupOfZid.set(z, grp); }
  const expandEntry = (zid) => {
    const grp = groupOfZid.get(zid);
    return grp ? [grp.head, ...grp.members] : [zid];
  };
  const keepNames = (ctx.brief && Array.isArray(ctx.brief.keepProjects)) ? ctx.brief.keepProjects : [];
  const keepZids = new Set();
  for (const grp of groups) {
    const headPara = paraByZid.get(grp.head);
    const title = headPara ? headPara.text : '';
    if (keepNames.some((n) => title.includes(String(n)))) [grp.head, ...grp.members].forEach((z) => keepZids.add(z));
  }
  // 先锚定再护栏：guardOps ①范围/②锁定/③hide 展开∩保留与锁定 按候选 zid 判定；dropped → 列入 skipped（设计 §4.3）
  const resolved = ops.changes.map((c) => {
    const a = anchorOf(c);
    return { ...c, zid: a.zid || undefined, baseSnapshot: a.baseSnapshot || undefined, zone: a.zid ? (zoneOfZid(a.zid) || guessZone(c.section)) : guessZone(c.section) };
  });
  const g = guardOps(resolved, { scope, zones, locked, protectedTokens, keepZids, expand: expandEntry });
  let ci = 0;
  const mk = (c, status, note) => ({ id: 'g' + gen + '-c' + (++ci), gen, ...c, status, note, createdAt: new Date().toISOString() });
  for (const d of g.dropped) cur.job.changes.push(mk(d.op, 'skipped', 'guardOps：' + d.reason));
  if (g.kept.length) supersedePending();
  for (const c of g.kept) cur.job.changes.push(mk(c, 'pending'));
  cur.job.todos = (cur.job.todos || []).concat(ops.todos.map((t) => ({ ...t, resolved: false })));
  cur.job.generatedAt = new Date().toISOString();
  cur.flow = g.kept.length ? 'reviewing' : cur.flow;   // 无候选时不改 flow：否则空结果会把既有待审流程推到 reviewing
  cur.job.summary = ops.summary;
  return { generated: g.kept.length, todos: ops.todos.length };
}

// ===== S4b-A：changes 通道五阶段管线（kind=changes 真拆分 + 阶段上报；P2 起分批改写）=====
// ① analyze（JD 要求提取，独立 chat）→ ② locate（要求→zid 区域定位，纯函数）→ ③ rewrite（分批改写，见下）
// → ④ validate（parseJobOps+factGuard+空间预算+既有守卫）→ ⑤ assemble（applyChangesResult 落账，语义不变）。
// 阶段上报（与 S4b-B 三值并存）：genTasks.changes.stages = [{stage, startedAt, ms?}] 只增不改的明细——
// chat 调用点仍置 calling / 返回后置 parsing（粗粒度语义零变化）；chat 阶段开条目于调用前（等待中即可见）、
// 返回后补 ms；纯函数阶段一次写入含真实起止；assemble 是终态前最后一步，只记 startedAt——落账即 done，
// patchGenTask 守卫正确拒绝事后的 ms 补写（合同 ms? 可缺省）。completeGenResult 以 {...gt} 展开收口，
// stages 原样保留，gen-result.mjs 零改动。
// 分批（P2）：rewrite 按批次执行（规划见 planBatches，每批 ≤3 个目标 zid、按 meta.zones 区域分桶；
// 无 zones/零命中回退 P1 单批形状）。并发取舍（卡片允许的简化）：批次【顺序】执行、每批独立 chat——
// /job/gen-start 为整任务借一个 AI 槽并透传租约（RES-02 合同），批间并发要么破坏「一请求一槽」的
// 容量记账、要么要求任务提前占 N 槽饿死共享池；顺序实现任务占用恒为 1 槽（「批内并发不超池余量」
// 平凡成立），进度/用量/失败记账天然无竞争。分批收益在本卡体现为失败隔离+每批预算，而非墙钟时间。
// 批次进度：genTasks.changes.batches = {total, done, failed:[{batch(0 基), error}]} 随 /job/changes 暴露，
// 每批完成后即时落账（轮询实时可见）；不显示百分比（诚实进度纪律——只暴露真实计数）。
// 每批校验：parseJobOps（内含 factGuard）+ 空间预算（口径见 batchBudgetError）；失败批登记
// batches.failed、不进 assemble（单批失败不污染成功批，登记即「待重试」——重试=用户重新生成，本卡
// 不新增端点）；成功批合并（summary 拼接/changes/todos 串联）后一次 assemble，applyChangesResult
// 语义逐字不变。终态语义（自定）：只要有一批成功 → 任务 done（failed[] 即可见的失败登记，不发明
// partial 新状态污染面板/状态机）；全部批失败 → 沿用 P1 既有 error 文案显式失败。
// 失败合同：analyze 失败（调用异常/输出不可解析）显式失败不降级——连要求清单都产不出的端点，
// 大概率同样产不出修改操作 JSON，早失败比慢失败诚实；locate 无命中不算失败（JD 无对应经历是常态）。
// 多次调用的 usage：analyze + 全部批次（含失败批——服务商调用已发生）按字段对已知部分求和
//（全未知则该字段 null）——诚实下界，不编 0。
function mergeGenUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  const f = (x, y) => (x == null && y == null) ? null : ((x || 0) + (y || 0));
  return { prompt: f(a.prompt, b.prompt), completion: f(a.completion, b.completion), total: f(a.total, b.total) };
}

// ① analyze 的 prompt（system 含「需求分析师」标记；与 buildJobPrompt 同约束风格：只准输出 JSON）
function buildAnalyzePrompt({ jd, company, role }) {
  const sys = `你是简历定制需求分析师。从【目标 JD】提取这份简历需要对照的要求清单，供后续改写与定位使用。你只能输出 JSON，不能输出解释文字。

输出格式（严格 JSON）：
{"requirements":["要求一","要求二"]}

规则：
1. 只提取 JD 明确写出的要求（技能、经验、职责领域、成果口径），每条一句话、不超过 30 字。
2. 不得编造 JD 没有的内容；最多 8 条，按重要性排序；JD 无可提取要求时输出 {"requirements":[]}。
3. JD 是要求来源，不是事实来源：不得把 JD 要求当成简历已有经历。`;
  const user = `【目标公司】${company}\n【目标岗位】${role}\n【JD】\n${jd || '（未提供 JD）'}`;
  return { sys, user };
}

// ① analyze 输出解析：null = 不可解析（任务失败）；[] 合法（JD 无可提取要求，后续 locate/rewrite 照走）
function parseAnalyzeReqs(raw) {
  let data;
  try {
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    data = JSON.parse(cleaned);
  } catch { return null; }
  const arr = Array.isArray(data) ? data
    : (data && typeof data === 'object' && Array.isArray(data.requirements) ? data.requirements : null);
  if (!arr) return null;
  return arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 8);
}

// ② locate：要求 → zid 段落定位（纯函数）。复用 zone.mjs parasOf 既有解析（与 evidence 通道同一段落口径）。
// 匹配确定性：拉丁/数字串（≥2 字符）原样包含 + 中文字符全部二元组命中任一即算；
// 按命中数降序取前 3 段（prompt 预算），并列按文档序；无命中 → 空 zids（不算失败）。
function locateReqs(reqs, paras) {
  const kwOf = (r) => {
    const kws = new Set(String(r || '').match(/[A-Za-z0-9][A-Za-z0-9.+#-]+/g) || []);
    const cjk = String(r || '').match(/[\u4e00-\u9fa5]/g) || [];
    for (let i = 0; i + 1 < cjk.length; i++) kws.add(cjk[i] + cjk[i + 1]);
    return [...kws];
  };
  return (Array.isArray(reqs) ? reqs : []).map((req) => {
    const kws = kwOf(req);
    const scored = [];
    for (const p of paras) {
      if (!p || !p.text) continue;
      let n = 0;
      for (const k of kws) if (p.text.includes(k)) n++;
      if (n > 0) scored.push({ zid: p.zid, n });
    }
    scored.sort((a, b) => b.n - a.n);
    return { req, zids: scored.slice(0, 3).map((s) => s.zid) };
  });
}

// ③ rewrite 的定位块（仅全文回退批注入）：把「要求→段落」对应关系交给改写，before 才有逐字锚定依据；
// 区域批不带此块——它自己就是按定位结果切出来的（批 prompt 另带【本批对应 JD 要求】）。
function locateBlock(located, paras) {
  const byZid = new Map(paras.map((p) => [p.zid, p]));
  return '【要求→段落定位（供改写锚定）】\n' + located.map((l) => {
    const ps = (l.zids || []).map((z) => byZid.get(z)).filter(Boolean)
      .map((p) => `（zid：${p.zid}）${p.text}`).join('；');
    return '· ' + l.req + (ps ? ' → ' + ps : ' → （正文未见直接对应段落）');
  }).join('\n');
}

// ===== P2：分批改写 =====
// 批次规划（纯函数）：locate 命中的目标 zid 按 meta.zones 归属分桶（区域唯一真源，zoneSync 维护），
// 每桶按文档序切成 ≤GEN_BATCH_ZIDS 个 zid 的批；无 zones 数据（区域维度不存在，无从分组）或零命中
// → 回退单批：全文任务（scope=all）回退批保持 P1 全文 prompt 形状，zone:<key> 局部任务回退批保持
// P1 整区域形状（它本身就是「批」粒度，S4a-T8 断言钉死其 prompt 形状）。返回 [{zoneKey, paras}]：
// zoneKey=null 表示全文回退批（paras=null，预算基线=全文段落）；其余批 paras 为该批目标段落（预算基线）。
const GEN_BATCH_ZIDS = 3;   // 每批最多目标 zid 数（默认口径，卡片指定）
function planBatches(located, parasStart, m0, scope, html) {
  const paraByZid = new Map(parasStart.map((p) => [p.zid, p]));
  if (typeof scope === 'string' && scope.startsWith('zone:')) {
    const zk = scope.slice(5);
    return [{ zoneKey: zk, paras: zoneParas(html, m0, zk) }];
  }
  const targets = [];
  for (const l of located) for (const z of l.zids) if (paraByZid.has(z) && !targets.includes(z)) targets.push(z);
  const zones = m0.zones || {};
  if (!targets.length || !Object.keys(zones).length) return [{ zoneKey: null, paras: null }];
  const byZone = new Map();   // 迭代序=首次插入序=文档序（targets 已按文档序去重）
  for (const z of targets) {
    const zk = (zones[z] && zones[z].zone) || 'other';
    if (!byZone.has(zk)) byZone.set(zk, []);
    byZone.get(zk).push(z);
  }
  const batches = [];
  for (const [zk, zids] of byZone) {
    for (let i = 0; i < zids.length; i += GEN_BATCH_ZIDS) {
      batches.push({ zoneKey: zk, paras: zids.slice(i, i + GEN_BATCH_ZIDS).map((z) => paraByZid.get(z)) });
    }
  }
  return batches;
}

// 空间预算（P2，口径自定）：批内 replace/add 的改后文本总量（空白折叠后计长）不得超过
// 该批目标段落原文总量 × 1.3 + 80 字符。理由：×1.3 容忍对齐 JD 的自然扩写（关键词补强、要点展开）；
// +80 绝对余量保护短段落（10 字的段落 ×1.3 只多 3 字，任何有效改写都写不进去）。
// hide/reorder 不占预算（不新增文本）。超预算 = 该批校验失败：登记 batches.failed（错误带数值），
// 该批 ops 不进 assemble——分批的意义就是把超编批次隔离成可重试单元，而不是让全文一起膨胀。
// 回退批同口径、以全文段落为基线——基线即全文，预算实际不构成约束（与 P1 行为等价）。
function batchBudgetError(opsB, batch, parasStart) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const used = (opsB.changes || [])
    .filter((c) => c.kind === 'replace' || c.kind === 'add')
    .reduce((n, c) => n + [...norm(c.after)].length, 0);
  if (!used) return null;
  const base = (batch.paras || parasStart).reduce((n, p) => n + [...norm(p.text)].length, 0);
  const budget = Math.round(base * 1.3) + 80;
  return used > budget ? `超出空间预算（改后 ${used} 字 > 基线 ${base} 字 ×1.3 + 80 = ${budget} 字）` : null;
}

// 五阶段管线本体。入参与旧 changes 分支一致（id/taskId/scope/租约），返回 finishGenTask 的对外结果。
async function runChangesPipeline(id, taskId, scope, held) {
  const stages = [];   // 明细只增不改；flush 落快照（条目随后原地补 ms，不影响已落盘内容）
  const flush = (patch) => patchGenTask(id, 'changes', taskId, { ...patch, stages: stages.map((s) => ({ ...s })) });
  try {
    const m0 = loadMeta()[id];
    if (!m0 || !m0.job) return finishGenTask(id, 'changes', taskId, null, '文档已不是岗位草稿');
    const html = fs.readFileSync(docPath(id), 'utf8');
    const parasStart = parasOf(html);   // S4a-T8：生成基线段落——baseSnapshot 与锚点解析共用同一份快照
    const confirmedMats = loadMats().filter((x) => x.factStatus === 'confirmed' && m0.job.materials.includes(x.id));
    // —— ① analyze：JD 要求提取（独立 chat 调用；失败显式失败，见头部合同）——
    const stAnalyze = { stage: 'analyze', startedAt: Date.now() };
    stages.push(stAnalyze); flush({});
    const pa = buildAnalyzePrompt({ jd: m0.jd || '', company: m0.company || '', role: m0.role || '' });
    const metaA = {};
    const rawA = await chat(root, pa.sys, pa.user, { lease: held, meta: metaA });
    stAnalyze.ms = Date.now() - stAnalyze.startedAt;
    flush({ stage: 'parsing', usage: metaA.usage ?? null });   // 模型已返回：本地解析校验（S4b-B 粗粒度检查点）
    const reqs = parseAnalyzeReqs(rawA);
    if (reqs === null) return finishGenTask(id, 'changes', taskId, null, '模型输出无法解析为 JD 要求清单，未应用任何修改');
    // —— ② locate：要求 → zid 区域定位（纯函数；无命中不算失败）——
    const tLocate = Date.now();
    const located = locateReqs(reqs, parasStart);
    stages.push({ stage: 'locate', startedAt: tLocate, ms: Date.now() - tLocate });
    // —— ③ rewrite：分批改写（P2）——批次规划 → 顺序执行，每批独立 chat + 校验 + 进度落账
    const stRewrite = { stage: 'rewrite', startedAt: Date.now() };
    stages.push(stRewrite);
    const digest = digestOf(html);
    const plan = planBatches(located, parasStart, m0, scope, html);
    const batchState = { total: plan.length, done: 0, failed: [] };   // {total, done, failed:[{batch,error}]}
    const snapBatches = () => ({ ...batchState, failed: [...batchState.failed] });
    const reqsByZid = new Map();   // 要求→命中 zid 反向索引：区域批 prompt 带【本批对应 JD 要求】（analyze→locate→批 数据流）
    for (const l of located) for (const z of l.zids) {
      if (!reqsByZid.has(z)) reqsByZid.set(z, []);
      reqsByZid.get(z).push(l.req);
    }
    // 批次计划随任务落账（P3 重试依据：重跑批 N 时按 zoneKey+zids+reqs 重建同一批的 prompt）
    const batchPlan = plan.map((b, bi) => ({
      batch: bi, zoneKey: b.zoneKey,
      zids: b.paras ? b.paras.map((p) => p.zid) : null,
      reqs: b.paras ? [...new Set(b.paras.flatMap((p) => reqsByZid.get(p.zid) || []))] : []
    }));
    let usageAll = metaA.usage ?? null;
    const mergedSummary = [], mergedChanges = [], mergedTodos = [];
    for (let bi = 0; bi < plan.length; bi++) {
      const b = plan[bi];
      const bScope = b.zoneKey === null ? null
        : { zone: b.zoneKey, zoneLabel: ZONE_LABELS[b.zoneKey] || b.zoneKey, digest };
      const bDocText = b.zoneKey === null
        ? docToText(html, { includeHidden: false })
        : b.paras.map((p) => `（zid：${p.zid}）${p.text}`).join('\n');
      const pb = buildJobPrompt({ docText: bDocText, jd: m0.jd || '', company: m0.company || '', role: m0.role || '', materials: confirmedMats, twoPage: true, brief: m0.job.brief || null, scope: bScope, feedback: m0.job.feedback || null });   // S4a-T9：过往反馈进 prompt
      if (b.zoneKey !== null) {
        const bReqs = [...new Set(b.paras.flatMap((p) => reqsByZid.get(p.zid) || []))];
        if (bReqs.length) pb.user += '\n\n【本批对应 JD 要求】\n' + bReqs.map((r) => '· ' + r).join('\n');
      } else if (located.length) {
        pb.user += '\n\n' + locateBlock(located, parasStart);   // 全文回退批保持 P1 定位块注入
      }
      flush({ stage: 'calling', batches: snapBatches(), batchPlan });
      const metaB = {};
      let rawB;
      try {
        rawB = await chat(root, pb.sys, pb.user, { lease: held, meta: metaB });
      } catch (e) {
        batchState.failed.push({ batch: bi, error: '模型调用失败：' + (e.message || e) });   // 单批失败不污染其他批
        stRewrite.ms = Date.now() - stRewrite.startedAt;
        flush({ stage: 'parsing', usage: usageAll, batches: snapBatches() });
        continue;
      }
      usageAll = mergeGenUsage(usageAll, metaB.usage ?? null);
      // 每批校验（卡片：每批完成后 factGuard + 空间预算）：factGuard 在 parseJobOps 内；
      // 失败批登记 batches.failed、不进 assemble；成功批累积，最终一次 assemble 落账。
      const opsB = parseJobOps(rawB);
      if (!opsB) {
        batchState.failed.push({ batch: bi, error: '模型输出无法解析为修改操作' });
      } else {
        const budgetErr = batchBudgetError(opsB, b, parasStart);
        if (budgetErr) batchState.failed.push({ batch: bi, error: budgetErr });
        else {
          mergedSummary.push(opsB.summary);
          mergedChanges.push(...opsB.changes);
          mergedTodos.push(...opsB.todos);
          batchState.done++;
        }
      }
      stRewrite.ms = Date.now() - stRewrite.startedAt;
      flush({ stage: 'parsing', usage: usageAll, batches: snapBatches() });
    }
    stRewrite.ms = Date.now() - stRewrite.startedAt;
    // —— ④ validate：合并成功批 + 终检（全部批失败 → 沿用 P1 既有文案显式失败）——
    const tValidate = Date.now();
    const ops = batchState.done
      ? { summary: mergedSummary.filter(Boolean).join('；'), changes: mergedChanges, todos: mergedTodos }
      : null;
    stages.push({ stage: 'validate', startedAt: tValidate, ms: Date.now() - tValidate });
    if (!ops) { flush({}); return finishGenTask(id, 'changes', taskId, null, '模型输出无法解析为修改操作，未应用任何修改'); }
    // —— ⑤ assemble：applyChangesResult 落账（语义不变；终态前最后一步，只记 startedAt）——
    // resultOps 随任务落账（P3 批次重试的合并基线：重试成功 = 原成功批 resultOps + 重试批 ops 再走一次收口）
    stages.push({ stage: 'assemble', startedAt: Date.now() });
    flush({ resultOps: ops });
    return finishGenTask(id, 'changes', taskId, (cur) => ({
      ok: true,
      extra: applyChangesResult(cur, ops, { scope, html, paras: parasStart, mats: confirmedMats, brief: m0.job.brief || null })
    }));
  } catch (e) {
    return finishGenTask(id, 'changes', taskId, null, '模型调用失败：' + (e.message || e));
  }
}

// ===== P3：批次重试（服务端幂等重试）=====
// 只重跑指定失败批（批次计划 batchPlan 随任务落账，重建同一批 prompt——zid/区域/对应要求不变，
// 段落文本以当前正文为准：用户可能已编辑，锚定与护栏在落账时按当前正文重评）。
// 成功：该批从 batches.failed 摘除、done+1、resultOps（原成功批合并 ops）+ 重试批 ops 合并，
// 走既有 finishGenTask 收口重新落账——新 gen 待审候选 = 全部成功批之并集（accepted/rejected 历史
// 不被覆盖，只有 pending 被 superseded——与「二次生成」同口径）；todos 按 section+question 去重
// 不重复追加（apply 回调内完成，applyChangesResult 本体零改动）。全部批成功 = 最后一次重试走同一收口。
// 失败/异常：恢复 done 终态（成功批候选不回滚），失败原因刷新进 batches.failed 该批条目，可再次重试；
// usage 照实累计（失败批的服务商调用已发生）。stages 保持原运行明细（重试不新增阶段条目，batches 是
// 重试的进度载体）。
async function runGenBatchRetry(id, taskId, batch, { lease } = {}) {
  try {
    const m0 = loadMeta()[id];
    const gt0 = m0 && m0.job && m0.job.genTasks && m0.job.genTasks.changes;
    if (!gt0 || gt0.taskId !== taskId) throw new Error('任务已被新任务取代');
    const html = fs.readFileSync(docPath(id), 'utf8');
    const parasNow = parasOf(html);
    const planEntry = (Array.isArray(gt0.batchPlan) ? gt0.batchPlan : []).find((p) => p && p.batch === batch);
    if (!planEntry) throw new Error('批次计划缺失');
    // 重建批 prompt（与 P2 同一构造）：区域批按计划 zid 取当前段落（缺段 → 批失败，正文已变化请重新生成）
    let bParas = null, bScope = null, bDocText;
    if (planEntry.zoneKey === null) {
      bDocText = docToText(html, { includeHidden: false });
    } else {
      const byZid = new Map(parasNow.map((p) => [p.zid, p]));
      bParas = (planEntry.zids || []).map((z) => byZid.get(z)).filter(Boolean);
      if (!bParas.length || bParas.length !== (planEntry.zids || []).length) {
        return finishRetryFailure(id, taskId, batch, '重试失败：批次目标段落已不存在（正文已变化），请重新生成', null);
      }
      bScope = { zone: planEntry.zoneKey, zoneLabel: ZONE_LABELS[planEntry.zoneKey] || planEntry.zoneKey, digest: digestOf(html) };
      bDocText = bParas.map((p) => `（zid：${p.zid}）${p.text}`).join('\n');
    }
    const confirmedMats = loadMats().filter((x) => x.factStatus === 'confirmed' && m0.job.materials.includes(x.id));
    const pb = buildJobPrompt({ docText: bDocText, jd: m0.jd || '', company: m0.company || '', role: m0.role || '', materials: confirmedMats, twoPage: true, brief: m0.job.brief || null, scope: bScope, feedback: m0.job.feedback || null });
    if (bScope && (planEntry.reqs || []).length) pb.user += '\n\n【本批对应 JD 要求】\n' + planEntry.reqs.map((r) => '· ' + r).join('\n');
    const metaB = {};
    let rawB;
    try {
      rawB = await chat(root, pb.sys, pb.user, { lease, meta: metaB });
    } catch (e) {
      return finishRetryFailure(id, taskId, batch, '重试失败：模型调用失败：' + (e.message || e), null);
    }
    // 每批校验（与 P2 同口径）：parseJobOps（内含 factGuard）+ 空间预算（基线=该批当前段落）
    const opsB = parseJobOps(rawB);
    if (!opsB) return finishRetryFailure(id, taskId, batch, '重试失败：模型输出无法解析为修改操作', metaB.usage);
    const budgetErr = batchBudgetError(opsB, { paras: bParas }, parasNow);
    if (budgetErr) return finishRetryFailure(id, taskId, batch, '重试失败：' + budgetErr, metaB.usage);
    // 成功：failed 摘除 + done+1 + resultOps 合并 + usage 合并 → 既有 finishGenTask 收口
    const prev = (gt0.resultOps && typeof gt0.resultOps === 'object') ? gt0.resultOps : { summary: '', changes: [], todos: [] };
    const mergedOps = {
      summary: [prev.summary, opsB.summary].filter(Boolean).join('；'),
      changes: (prev.changes || []).concat(opsB.changes),
      todos: (prev.todos || []).concat(opsB.todos)
    };
    patchGenTask(id, 'changes', taskId, {
      batches: { total: gt0.batches.total, done: gt0.batches.done + 1, failed: gt0.batches.failed.filter((f) => f.batch !== batch) },
      resultOps: mergedOps,
      usage: mergeGenUsage(gt0.usage ?? null, metaB.usage ?? null)
    });
    return finishGenTask(id, 'changes', taskId, (cur) => ({
      ok: true,
      extra: applyChangesResult(cur, {
        ...mergedOps,
        todos: (mergedOps.todos || []).filter((t) => !(cur.job.todos || []).some((u) => u.section === t.section && u.question === t.question))   // 重试不重复追加既有 todos
      }, { scope: gt0.scope || 'all', html, paras: parasNow, mats: confirmedMats, brief: m0.job.brief || null })
    }));
  } catch (e) {
    return finishRetryFailure(id, taskId, batch, '重试异常：' + (e.message || e), null);
  }
}

// 重试失败/异常收尾：恢复 done 终态（守卫：taskId 匹配且仍 running——被取消/超时打断则不复活），
// 失败原因刷新进 batches.failed 该批条目、retrying 标记移除；usage 可选累计。
function finishRetryFailure(id, taskId, batch, error, usage) {
  updateMetaAll(root, (all) => {
    const m = all[id];
    const gt = m && m.job && m.job.genTasks && m.job.genTasks.changes;
    if (!gt || gt.taskId !== taskId || gt.status !== 'running' || !gt.batches) return null;
    const next = {
      ...gt, status: 'done', stage: null, error: null,
      ...(usage ? { usage: mergeGenUsage(gt.usage ?? null, usage) } : {}),
      batches: {
        total: gt.batches.total, done: gt.batches.done,
        failed: (gt.batches.failed || []).map((f) => (f.batch === batch ? { ...f, error } : f))
      }
    };
    return { ...all, [id]: { ...m, job: { ...m.job, genTasks: { ...(m.job.genTasks || {}), changes: next } } } };
  });
  return { ok: false, error };
}

// 任务体（node 单进程 fire-and-forget：Promise 即可，不引调度平台）。interview/evidence 通道完整复用既有链路；
// changes 通道自 S4b-A 起走 runChangesPipeline 五阶段管线（analyze→locate→rewrite→validate→assemble）；
// finishGenTask 校验落账——整批替换与批次推进只在成功落账事务内（设计 §5.1 反例2：失败/取消/超时不碰旧数据）。
async function runGenTask(id, kind, taskId, scope = 'all', { lease } = {}) {
  // 后台任务自己占一个 AI 槽（RES-04）：HTTP 响应早已结束，真实占用才开始。
  // 释放 = 这次后台工作真正结束（最外层 finally）；逻辑取消/超时/HTTP 断连都不等于释放。
  // 与同步入口共用同一个 aiPool → 全进程 AI 实际并发 ≤2（RES-02）。
  const ownLease = lease ? null : await aiPool.acquire();
  // 槽位已到手 → calling（S4b-B：模型调用阶段的起点；透传 lease 时 queued 窗口极短，同 tick 内到达）
  patchGenTask(id, kind, taskId, { stage: 'calling' });
  try {
    return await runGenTaskInner(id, kind, taskId, scope, lease || ownLease);
  } finally {
    if (ownLease) { try { ownLease.release(); } catch {} }
  }
}
async function runGenTaskInner(id, kind, taskId, scope, held) {
  if (kind === 'interview') {
    try {
      const m0 = loadMeta()[id];
      if (!m0 || !m0.job) return finishGenTask(id, kind, taskId, null, '文档已不是岗位草稿');
      const ev = Array.isArray(m0.job.evidence) ? m0.job.evidence : [];
      if (!ev.length) return finishGenTask(id, kind, taskId, null, '请先生成「要求与证据」——面试追问依赖证据表');
      const html = fs.readFileSync(docPath(id), 'utf8');
      const paras = parasOf(html);
      const evGenAtStart = Number(m0.job.evidenceGen) || 0;   // 生成时的证据批次，interview 的 evIndex 绑定它
      // 真源集合（SRC-01）：来源身份只由段落 zid 决定；quote/title 不作兜底。
      // prompt 与 parser 共用同一批 sourceParas → 模型能引用的片段与被核验的片段完全一致。
      const sources = resolveInterviewSources({ evidence: ev, paras });
      const p = buildInterviewPrompt({ jd: m0.jd || '', company: m0.company || '', role: m0.role || '', evidence: ev, sources });
      const genMeta = {};
      const raw = await chat(root, p.sys, p.user, { lease: held, meta: genMeta });
      patchGenTask(id, kind, taskId, { stage: 'parsing', usage: genMeta.usage ?? null });   // 模型已返回：本地解析校验（S4b-B；usage 先落记录，终态兜底带上）
      const gen = (Number(m0.job.interviewGen) || 0) + 1;
      const iv = parseInterview(raw, { evidence: ev, sources });
      if (!iv) return finishGenTask(id, kind, taskId, null, '模型输出无法解析为面试追问，未替换任何内容');
      // 「无有效内容」要看**要点**而非链数：模型可能只给问题、要点全被护栏丢弃，
      // 这种链留着会让用户看到一屏空卡片（2026-10-18 OCR）
      const hasPoint = (c) => Array.isArray(c.answerPoints) && c.answerPoints.length > 0;
      const useful = iv.chains.filter(hasPoint).length + iv.generic.filter(hasPoint).length;
      if (!useful) return finishGenTask(id, kind, taskId, null, '模型输出的追问没有任何有效要点，未替换任何内容');
      return finishGenTask(id, kind, taskId, (cur) => {
        // 批次隔离（与 evidence 通道同口径）：生成期间证据表被整批替换 → 链上的 evIndex 已指向别的表，
        // 宁可整批不落账，也不能写出一份「标签对不上要求」的追问（2026-10-18 OCR 高危项）。
        // 显式拒绝：先校验后修改；拒绝时不提交任何内容/批次/版本变化，旧面试与 interviewGen 保持不变。
        if ((Number(cur.job.evidenceGen) || 0) !== evGenAtStart) {
          return { ok: false, error: '生成期间证据表已更新，请重新生成' };
        }
        cur.job.interview = iv;
        cur.job.interviewGen = gen;
        cur.job.interviewBaseHash = contentHash(html);       // 正文基线
        cur.job.interviewEvidenceGen = evGenAtStart;          // 证据批次基线（证据表重生成不改正文，只靠它判 stale）
        return {
          ok: true,
          extra: { interview: iv.chains.length + iv.generic.length, interviewGen: gen, dropped: iv.dropped }
        };
      });
    } catch (e) {
      return finishGenTask(id, kind, taskId, null, '模型调用失败：' + (e.message || e));
    }
  }
  if (kind === 'evidence') {
    try {
      const m0 = loadMeta()[id];
      if (!m0 || !m0.job) return finishGenTask(id, kind, taskId, null, '文档已不是岗位草稿');
      const html = fs.readFileSync(docPath(id), 'utf8');
      const mats = loadMats().filter((x) => x.factStatus === 'confirmed' && m0.job.materials.includes(x.id));
      const paras = parasOf(html);
      const p = buildEvidencePrompt({ jd: m0.jd || '', company: m0.company || '', role: m0.role || '', materials: mats, zones: m0.zones || {}, paras });
      const genMeta = {};
      const raw = await chat(root, p.sys, p.user, { lease: held, meta: genMeta });
      patchGenTask(id, kind, taskId, { stage: 'parsing', usage: genMeta.usage ?? null });   // 模型已返回：本地解析校验（S4b-B；usage 先落记录，终态兜底带上）
      // 解析用批次号在锁外读取即可：同 kind 任务被 startGenTask 串行化（running 期间新任务 409），锁内必然一致；
      // 期间任务被取消/过期也不影响——迟到落账由 finishGenTask 的 taskId 不匹配与超时分支拒绝（零落账）。
      const gen = (Number(m0.job.evidenceGen) || 0) + 1;
      // 生成时的证据批次（换批隔离）：生成期间证据表被整批替换 → 迟到结果整批不落账，
      // 否则新批次会被旧批次的证据覆盖（TASK-04 / T1）。
      const evGenAtStart = Number(m0.job.evidenceGen) || 0;
      const ev = parseEvidence(raw, { gen, mats, paras });
      if (!ev || !ev.length) return finishGenTask(id, kind, taskId, null, '模型输出无法解析为证据表，未替换任何证据');
      // S4a-T7 保护门：模型返回非空但整次解析零有效 ref（全部 refId 匹配不上）→ 视为解析失败，旧表与批次不动
      if (!ev.some((e) => (e.refs || []).length)) return finishGenTask(id, kind, taskId, null, '模型输出的证据无任何有效来源引用（refId 全部无法匹配），未替换任何证据——可重试');
      return finishGenTask(id, kind, taskId, (cur) => {
        // 批次隔离（与 interview 通道同口径）：生成期间证据表被换批 → 显式拒绝，旧批次不覆盖新批次
        if ((Number(cur.job.evidenceGen) || 0) !== evGenAtStart) {
          return { ok: false, error: '生成期间证据表已更新，请重新生成' };
        }
        cur.job.evidence = ev;              // 整批替换 + 批次推进只在本次成功落账事务内（旧 refId 不复用）
        cur.job.evidenceGen = gen;
        return { ok: true, extra: { evidence: ev.length, evidenceGen: gen } };
      });
    } catch (e) {
      return finishGenTask(id, kind, taskId, null, '模型调用失败：' + (e.message || e));
    }
  }
  // changes 通道（S4b-A）：五阶段管线（analyze→locate→rewrite→validate→assemble），合同见 runChangesPipeline 头注
  return runChangesPipeline(id, taskId, scope, held);
}

// 原子启动（设计 §6 v1.4：updateMetaAll 全表事务锁内扫描）：全库同类 running ≤1、两类合计 ≤2，超限 409；
// 过期残留不计入（读取时清）——启动时拒过期残留为三点校验之一。taskId 在事务内生成写入，无检查与写入分离窗口。
function startGenTask(id, kind, scope = 'all') {
  let baseHash = null;
  try { baseHash = contentHash(fs.readFileSync(docPath(id), 'utf8')); } catch {}   // 仅任务记录用（设计 §4.1）
  let taskId = null, reject = null;
  updateMetaAll(root, (all) => {
    const m = all[id];
    if (!m || !m.job) { reject = { status: 404, error: '该文档不是岗位草稿' }; return null; }
    const now = Date.now();
    let ownFresh = false, sameKindOther = false, total = 0;
    for (const [did, dm] of Object.entries(all)) {
      const gt = dm && dm.job && dm.job.genTasks;
      if (!gt) continue;
      for (const k of GEN_KINDS) {
        const t = gt[k];
        if (!t || t.status !== 'running' || genExpired(t, now)) continue;   // 过期残留不占并发额度
        total++;
        if (k === kind) { if (did === id) ownFresh = true; else sameKindOther = true; }
      }
    }
    if (ownFresh) { reject = { status: 409, error: '该类型任务正在进行中，请稍候' }; return null; }
    if (sameKindOther) { reject = { status: 409, error: '另一文档的任务进行中，请稍后再试' }; return null; }
    if (total >= 2) { reject = { status: 409, error: '并发任务已达上限（全库同类 1 + 跨类合计 ' + (GEN_KINDS.length - 1) + '），请稍后再试' }; return null; }
    taskId = newGenTaskId();
    const model = (() => { try { const c = loadProfiles(root); return (c && c.profiles && c.profiles[c.active]) ? c.profiles[c.active].model : null; } catch { return null; } })();
    // stage:'queued' = 已注册、等并发槽位（S4b-B）；model 记录启动时的 active profile 模型名
    const job = { ...m.job, genTasks: { ...(m.job.genTasks || {}), [kind]: { taskId, status: 'running', startedAt: now, baseHash, error: null, scope, stage: 'queued', model, usage: null } } };
    return { ...all, [id]: { ...m, job } };
  });
  return { taskId, reject };
}
// ===== S4a-T5 要求卡：brief 归一校验（设计 §4.1/§5.1）=====
// 输入任意对象 → {brief, error}：渐进默认（缺字段补默认，不整对象覆盖）；非法值 400 由调用方决定。
const BRIEF_DEGREES = ['light', 'refocus', 'restructure'];
function normBrief(input) {
  const b = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const strArr = (v) => v === undefined ? [] : (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 20) : null);
  const focus = strArr(b.focus);
  const keepProjects = strArr(b.keepProjects);
  const deemphasize = strArr(b.deemphasize);
  if (focus === null || keepProjects === null || deemphasize === null) return { error: 'focus/keepProjects/deemphasize 必须是字符串数组' };
  const degree = BRIEF_DEGREES.includes(b.degree) ? b.degree : null;
  const pages = b.pages === undefined || b.pages === null || b.pages === '' ? null : b.pages;
  const preset = b.preset === undefined || b.preset === null || b.preset === '' ? null : b.preset;
  if (degree === null && b.degree !== undefined && b.degree !== null && b.degree !== '') return { error: 'degree 必须是 light|refocus|restructure' };
  if ((pages !== null && (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1)) || typeof pages === 'string')
    return { error: 'pages 必须是正整数' };
  if (preset !== null && typeof preset !== 'string') return { error: 'preset 必须是字符串或 null' };
  return { brief: { focus, keepProjects, deemphasize, degree: degree || 'refocus', pages: pages || 2, preset } };
}

// /job/changes GET 兼容视图：新字段带默认值；saveReceipts 只回摘要（最近 requestId，完整回执表仅供服务端判重）。
function jobView(m) {
  if (!m || !m.job) return null;
  const j = m.job;
  const receipts = Array.isArray(j.saveReceipts) ? j.saveReceipts : [];
  return {
    ...j,
    brief: j.brief || { focus: [], keepProjects: [], deemphasize: [], degree: 'refocus', pages: 2, preset: null },
    evidence: Array.isArray(j.evidence) ? j.evidence : [],
    evidenceGen: Number(j.evidenceGen) || 0,
    interview: (j.interview && typeof j.interview === 'object') ? j.interview : { chains: [], generic: [], dropped: 0 },
    interviewGen: Number(j.interviewGen) || 0,
    genTasks: j.genTasks
      ? {
          evidence: { ...mkGenTask(), ...(j.genTasks.evidence || {}) },
          changes: { ...mkGenTask(), ...(j.genTasks.changes || {}) },
          interview: { ...mkGenTask(), ...(j.genTasks.interview || {}) }
        }
      : { evidence: mkGenTask(), changes: mkGenTask(), interview: mkGenTask() },
    saveReceipts: { count: receipts.length, lastRequestId: receipts.length ? receipts[receipts.length - 1].requestId : null },
    reviewPos: j.reviewPos || { section: null, changeId: null, filter: 'all' },
    status: legacyFlowStatus(m), flow: flowOf(m)
  };
}

// S4a-T6（设计 §4.2 来源维度）：jobView 之上叠加读取时即时计算——不落盘、不依赖正文保存（反例6）。
// ① 每条 evidence 的 refs 现算 refFresh（含 factStatus）并标注条目 stale；② 每条 change 的 consistency
// 重算（含 ref-stale/batch-stale 来源维度；正文维度与 /save 落盘的 reviewConsistency 同函数同口径）。
// 正文不可读时保持落盘视图（不阻断读取）。纯读：任何失败都不写 meta。
function jobViewLive(id, m) {
  const job = jobView(m);
  if (!job) return job;
  let html;
  try { html = fs.readFileSync(docPath(id), 'utf8'); } catch { return job; }
  const mats = loadMats();
  const paras = parasOf(html);   // S4a-T7：算一次透传给 reviewConsistency 与 refs fresh（原先每请求跑两遍）
  const out = reviewConsistency(job, html, { zones: (m || {}).zones, mats, paras });
  out.evidence = (out.evidence || []).map((e) => {
    // 来源状态由程序判定（SRC-03）：旧 anchored 布尔不被信任，来源身份只认段落 zid。
    // 兼容视图只读：不回写历史存储（evidenceSourceView 不改传入对象）。
    const refs = (Array.isArray(e.refs) ? e.refs : []).map((r) => ({ ...r, ...evidenceSourceView(r, { mats, paras }), fresh: refFresh(r, { mats, paras }) }));
    return { ...e, refs, stale: refs.length > 0 && refs.every((r) => !r.fresh) };
  });
  // S4a-T10：导出检查三级（阻止/建议核对/风格）与两级完成——与导出页共用同一纯函数，状态取即时视图（非落盘快照）
  // 批 2：html 一并透传 → 确定性内容检查（content-check.mjs）与导出页检查卡同一实现、同一结果（单一通道）
  out.checks = exportChecks(out, { mats, paras, html });
  // S4B-3 面试追问 stale：① 正文哈希变了 ② 证据表重新生成（只换 meta 不改正文，必须靠证据批次判定）
  //     两者任一发生，chains 里的 zid / evIndex 都可能已指向别处（2026-10-18 OCR 高危项）
  const ivBase = (m && m.job && m.job.interviewBaseHash) || null;
  out.interviewStale = !!(
    ivBase && (
      ivBase !== contentHash(html) ||
      (typeof m.job.interviewEvidenceGen === 'number' && m.job.interviewEvidenceGen !== Number(m.job.evidenceGen || 0))
    )
  );
  // 面试追问的引用来源：旧 anchored 只读降级（SRC-03/SRC-07），不写回 meta
  if (out.interview) out.interview = interviewSourceView(out.interview, { paras });
  return out;
}
const exportsOf = (m) => (Array.isArray(m && m.exports) ? m.exports : []);
// 该文档全部投递引用（每条 = 一次投递）。apps 可传入已读好的表：
// 首页会对每张文档卡调一次，不传就每次重读 applications.json → O(文档数 × 投递数)
// （2026-10-22 审查 [低] 实测：1200 条投递时首页 182ms → 37ms）
const deliveredRefs = (docId, apps) => (apps || loadApps()).filter((a) => a && a.docId === docId);
const usedByExport = (exportId) => loadApps().filter((a) => a && a.exportId && a.exportId === exportId); // 使用某导出的投递
// 引用某分享副本的投递（批 3 卡片 b3c5）：实时派生自 applications.json（权威来源，绝不存储）——
// 与 usedByExport 同款口径：app.shareId === 分享副本记录 id；可传已取好的 apps 复用（页面每渲染一次只读一遍账本）。
const usedByShare = (shareId, apps) => (apps || loadApps()).filter((a) => a && a.shareId && a.shareId === shareId);
const pendingConflictsOf = (m) => {
  const j = m && m.job;
  return (j && Array.isArray(j.changes)) ? j.changes.filter((c) => c && c.level === 'conflict' && ['pending', 'skipped'].includes(c.status)) : [];   // S4a-T9 后补齐：skipped 的 conflict 仍算未解决（可投递与导出页同口径）
};
// 可投递 = 派生（S4a 上线后修复3，契约口径）：用户显式确认 flow==='reviewed'（S1 契约不动）
// && 整体审阅完成（jobViewLive.checks.reviewComplete——无 pending/skipped、冲突清零、待核对空，与审阅 Tab/导出页同源）
// && PDF 非陈旧（staleInfo）。允许导出 ≠ 完成审阅：导出门控只看冲突，可投递另要求完成。
function deliverableNow(id, m, info) {
  if (!info || !info.renderInputId) return false;
  if (flowOf(m) !== 'reviewed') return false;
  const live = jobViewLive(id, m);
  if (!live || !live.checks || !live.checks.reviewComplete) return false;
  return !staleInfo(m || {}, { renderInputId: info.renderInputId, pdfExists: fs.existsSync(pdfPath(id)) }).stale;
}
// 不可变导出产物路径（完整 renderInputId 命名，禁止截断；存在即复用、绝不覆盖）
const histPathOf = (docId, rid) => path.join(root, 'pdfs', 'history', `${docId}@${rid}.pdf`);

// ===== 快照（被投递引用的快照与基准快照免配额清理）=====
const snapMetaPath = (docId) => path.join(snapDir(docId), 'meta.json');
const loadSnapMeta = (docId) => { try { return JSON.parse(fs.readFileSync(snapMetaPath(docId), 'utf8')) || {}; } catch { return {}; } };
const saveSnapMeta = (docId, meta) => {
  fs.mkdirSync(snapDir(docId), { recursive: true });
  const tmp = snapMetaPath(docId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });   // 同上
  fs.renameSync(tmp, snapMetaPath(docId));
};
function protectedSnaps(id, extraTs) {
  const keep = new Set();
  // 调用方指定的额外豁免（如 /rollback 的回滚目标）：用户明确要回到的那一版绝不能被本次操作的
  // 配额清理删掉——否则「回滚到最早一版」会把目标先删再报 500，存档永久丢失（2026-10-18 审查 P0）
  if (extraTs) keep.add(extraTs);
  for (const a of loadApps()) if (a.docId === id && a.snapTs) keep.add(a.snapTs);
  // exports[].snapTs 引用的冻结快照豁免配额（S1-T8，spec §8）：manifest 与 html 成对清理（pruneSnapshots），随之同豁免。
  // pdfs/history 不可变产物不经任何清理器（无配额），天然豁免。
  for (const e of exportsOf(loadMeta()[id] || {})) if (e && e.snapTs) keep.add(e.snapTs);
  const base = loadSnapMeta(id).__baseline;
  if (base) keep.add(base);
  return keep;
}
// 冻结产物伴生 manifest：字段一次写全（快照不强制 resolveChromium → chromium 字段允许 null）。
function buildManifest(frozen, html, meta) {
  const norm = normalizeToCurrent(html);   // 主样式来源属性与 styleHash（typo 已分离，不影响主样式）
  const edVer = (frozen.html.match(/data-editor="([^"]+)"/) || [])[1] || null;
  return {
    theme: (meta && meta.theme) || norm.theme || null,
    styleHash: norm.styleHash || null,
    typoHash: frozen.typoHash || null,
    renderInputId: frozen.renderInputId,
    editorVersion: edVer,
    chromiumBin: null,
    browserVersion: null,
    fonts: [],
    dpi: null,
    createdAt: new Date().toISOString()
  };
}
// 冻结点统一出口：freezeHtml（内联 typo、自包含）→ 原子写 <ts>.html + <ts>.manifest.json。返回 frozen 结果。
function writeFrozenSnapshot(dir, ts, html, meta) {
  const themed = applyDocTheme(html, meta || {});   // S6-A1：快照冻结的是按主题装配的渲染输入（主题 CSS 随快照冻结）
  const frozen = freezeHtml(themed, meta || {});
  atomicWrite(path.join(dir, ts + '.html'), frozen.html);
  atomicWrite(path.join(dir, ts + '.manifest.json'), JSON.stringify(buildManifest(frozen, themed, meta || {})));
  return frozen;
}
function pruneSnapshots(id, dir, extraTs) {
  const htmls = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  const overflow = htmls.length - MAX_SNAPSHOTS;
  if (overflow <= 0) return;
  const keep = protectedSnaps(id, extraTs);
  const removable = htmls.filter((f) => !keep.has(f.replace('.html', '')));
  for (const f of removable.slice(0, overflow)) {
    const ts = f.replace(/\.html$/, '');
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
    try { fs.unlinkSync(path.join(dir, ts + '.manifest.json')); } catch {}   // manifest 与冻结 html 成对清理
  }
}
// 快照 = 冻结当前文档（freezeHtml）+ manifest；返回冻结 ts（无文档 → ''）。被投递引用/基准快照免配额清理。
function snapshot(id, keepExtraTs) {
  if (!fs.existsSync(docPath(id))) return '';
  const dir = snapDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const html = fs.readFileSync(docPath(id), 'utf8');
  const meta = loadMeta()[id] || {};
  const ts = timestamp();
  writeFrozenSnapshot(dir, ts, html, meta);
  pruneSnapshots(id, dir, keepExtraTs);
  return ts;
}

// ===== 渲染（原子替换；RETRY=1 次；测试可用 RESUME_RENDER_BIN 注入假渲染器）=====
// renderDoc 只接受 --src 冻结/组装输入（render.mjs 对文档元数据盲态）；env 透传渲染标识与可复现性（旁车用）。
async function renderDoc({ src, out, env, lease }) {
  // 渲染容量（RES-05）：入口层拿到 lease 就透传；没拿到就在底层兜底占一个渲染槽。
  // 释放 = 渲染子进程真正结束（含超时终止），不是 HTTP 响应结束。
  // 凭证校验（内部接口合同）：透传的 lease 必须真实、同池、未释放、未被其他执行器占用；
  //   校验不通过 → 抛错，且**不拉起任何渲染子进程**（此前只判 truthy）。
  const ownLease = lease ? null : await renderPool.acquire();
  const heldLease = lease ? renderPool.claim(lease) : null;   // 校验失败即抛：渲染子进程还没起
  // 成对发布（AUD-07）：先渲染到 staging 位置，PDF 与旁车都成功且身份匹配后才发布到最终路径。
  // 直接渲染到最终路径存在「新 PDF + 旧旁车」的混合窗口（注入 ENOSPC 复现：PDF 已换、旁车写失败）。
  const stamp = `${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const stage = out + '.stage-' + stamp;
  const stageSide = stage + '.env.json';
  let removed = [];
  // 临时渲染输入的所有权（2026-10-28）：只清理【自己创建】的文件。
  // 原实现在 try 内声明 renderSrc、finally 无条件 rmSync(renderSrc)：
  //   净化失败时 renderSrc 仍指向调用方的源文件 → 失败路径会把别人的输入删掉；
  //   且 try 内声明使 finally 访问可能落在 TDZ，异常又被空 catch 吞掉 → 临时文件泄漏且无人知晓。
  let renderSrc = src;         // 默认指向调用方的文件：我们不拥有它，绝不删
  let ownRenderSrc = null;     // 自己创建的临时输入（写成功或写失败都由我们负责清理）
  try {
    // 受信渲染输入（AUD-05）：冻结的 render.mjs 用 page.setContent 渲染，**没有 CSP** ——
    // 文档里的未知脚本会在渲染时执行并外联（编辑页有 CSP，渲染页没有）。
    // 所有渲染路径（当前/快照/不可变导出/投递存档/补生成）都经过本函数 → 在这里统一净化。
    let safe;
    try {
      // maxHtmlBytes 与保存入口同源（BL-P1-04）：readBody 默认上限 = MAX_BODY_BYTES。
      safe = trustedRenderHtml(fs.readFileSync(src, 'utf8'), { knownScriptHashes: knownEditorScriptHashes(), maxHtmlBytes: MAX_BODY_BYTES });
    } catch (e) {
      // 净化失败（含超限）→ 不渲染：宁可不产出，也不渲染未净化的内容
      console.error(`[render] 渲染输入净化失败：${(e && e.message) || e}`);
      // 超限（BL-P1-04）：尺寸原因必须客户端可见，不能只有「渲染失败（详见服务日志）」
      if (e && e.code === 'RENDER_INPUT_TOO_LARGE') {
        return { ok: false, removed: (e.removed || removed), sizeError: `文档 ${mbLabel(e.bytes)} 超过渲染上限 ${mbLabel(MAX_BODY_BYTES)}` };
      }
      return { ok: false, removed };
    }
    removed = safe.removed || [];
    ownRenderSrc = path.join(os.tmpdir(), `resume-render-src-${stamp}.html`);
    renderSrc = ownRenderSrc;
    fs.writeFileSync(renderSrc, safe.html, { mode: 0o600 });
    const args = [path.join(APP_ROOT, 'render.mjs'), '--src', renderSrc, '--out', stage];
    const attempt = () => new Promise((resolve) => {
      const child = spawn(process.env.RESUME_RENDER_BIN || 'node', args, {
        stdio: 'inherit',
        env: { ...process.env, RESUME_ROOT: root, ...(env || {}) }
      });
      // 超时终止：先 TERM，宽限期后 KILL。只发 TERM 时不响应的子进程会永远挂着
      // → close 不触发 → 这次渲染的槽位永不释放（RES-03）。
      // RESUME_TEST_RENDER_TIMEOUT_MS 只是测试钩子（把 60s 缩短），生产默认 60s。
      const timeoutMs = Math.max(200, Number(process.env.RESUME_TEST_RENDER_TIMEOUT_MS || 60000));
      let hardTimer = null;
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        hardTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      }, timeoutMs);
      const done = (ok) => { clearTimeout(timer); if (hardTimer) clearTimeout(hardTimer); resolve(ok); };
      child.on('close', (code) => done(code === 0));
      child.on('error', () => done(false));
    });
    let ok = false;
    try { ok = await attempt(); } catch { ok = false; }
    if (!ok) { try { ok = await attempt(); } catch { ok = false; } }
    if (!ok) return { ok: false, removed };
    // 成对身份校验：旁车 renderInputId 必须与本次冻结输入一致，且旁车不得早于 PDF
    const expected = (env && env.RESUME_RENDER_INPUT_ID) || null;
    const pub = publishPair({
      tmpPdf: stage, tmpSidecar: stageSide,
      outPdf: out, outSidecar: out + '.env.json',
      validate: makeIdentityValidator({ expectedRenderInputId: expected })
    });
    if (!pub.ok) {
      console.error(`[render] 产物发布失败（${pub.reason}）：${pub.detail}` + (pub.retained && pub.retained.length ? ` —— 恢复源保留：${pub.retained.join('、')}` : ' —— 旧产物原样保留'));
      return { ok: false, removed, publish: pub };
    }
    return { ok: true, removed, published: pub };
  } finally {
    // 只清理自己拥有的临时文件；清理失败要留下痕迹（空 catch 会把泄漏变成无人知晓）
    if (ownRenderSrc) {
      try { fs.rmSync(ownRenderSrc, { force: true }); }
      catch (e) { console.error(`[render] 临时渲染输入清理失败：${ownRenderSrc}（${(e && e.message) || e}）`); }
    }
    try { fs.rmSync(stage, { force: true }); } catch {}
    try { fs.rmSync(stageSide, { force: true }); } catch {}
    if (heldLease) { try { renderPool.unclaim(heldLease); } catch {} }
    if (ownLease) { try { ownLease.release(); } catch {} }
  }
}

// ===== S6-A1（模板库 A）：按文档 meta.theme 的装配解析（数据与渲染集成的唯一出口）=====
// meta.theme 是文档主题的数据源（docs-meta 既有字段；主题选择 UI 属 A2，本卡只通管线）：
//   - 值命中 themes/resume-*.css → 装配输出（/edit 服务与渲染/快照冻结输入）内联该主题 CSS，
//     与 themes 文件逐字节一致（sha1 同 freeze cssHash 口径）；主样式块已登记同一 data-theme 时零改动
//     （classic 文档渲染零回归，既有文档字节不动）。
//   - 无值 / 'legacy'（T7 迁移哨兵）→ 原样保留实际内联 CSS（不做迁移）。
//   - 其余未知值 → 沿用 themeCss 抛错并列可用主题（template.mjs 既有口径）；装配先于任何写盘 → 不写脏数据。
// 新建文档路径（/new、向导建档、导入）仍 themeRegistration('classic') 默认（A2 承接选择入口），不经本函数。
const MAIN_STYLE_RE = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
function docThemeAttr(html) {
  MAIN_STYLE_RE.lastIndex = 0;
  let m;
  while ((m = MAIN_STYLE_RE.exec(String(html))) !== null) {
    if (/\bid\s*=\s*["']typo-custom["']/i.test(m[1])) continue;
    const dt = /\bdata-theme\s*=\s*["']([^"']*)["']/i.exec(m[1]);
    return dt ? dt[1] : null;
  }
  return null;
}
function applyDocTheme(html, meta) {
  const t = String((meta && meta.theme) || '').trim();
  if (!t || t === 'legacy') return html;                 // 既有文档保留实际内联 CSS，不做迁移
  return applyThemeNamed(html, t);
}
// 按显式主题名装配（调用方保证 t 已验明在 listThemes() 内；themeCss 对未知值兜底抛错）。
// S6-A2 的 /theme-preview 用它做「候选主题」预览（预览主题 = 显式参数，非 meta.theme）。
function applyThemeNamed(html, t) {
  if (docThemeAttr(html) === t) return html;             // 已是该主题 → 字节零改动
  const css = themeCss(t);                               // 未知主题在替换前抛错（列可用主题）
  const block = `<style data-theme="${t}">${css}</style>`;
  MAIN_STYLE_RE.lastIndex = 0;
  let m;
  while ((m = MAIN_STYLE_RE.exec(String(html))) !== null) {
    if (/\bid\s*=\s*["']typo-custom["']/i.test(m[1])) continue;
    return html.slice(0, m.index) + block + html.slice(m.index + m[0].length);
  }
  return html;                                           // 无主样式块：无从装配，原样（与「无主样式」容忍口径一致）
}
// /theme-preview 的唯一装配实现（DESIGN.md §10.1 口径）：入参 = 源正文 HTML（文档正文或空白模板装配）
// + 主题名；出参 = 预览 HTML（只读态 + 剥脚本 + 隐藏编辑器条）。
// 「装配单一实现」= 端点响应体与向导 0.8 卡片内嵌的 srcdoc 必须逐字节相等 → 两处只调本函数，不各自拼装。
function themePreviewHtml(srcHtml, theme) {
  let phtml = stripInjections(String(srcHtml || ''));
  phtml = applyThemeNamed(phtml, theme);
  phtml = phtml.replace('contenteditable="true"', '').replace("sheet.contentEditable = 'true'", '');
  // 预览是装配产物（非存档字节）：模板残留的编辑器脚本整体剥除（srcdoc 装载时不携带死脚本）；
  // 锁定 CSP 仍随端点响应下发——直接以 URL 打开预览时由 CSP 兜底判死脚本。
  phtml = phtml.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  phtml = phtml.replace('<body>', '<body><style>.edit-toolbar,.page-line{display:none!important}</style>');
  return phtml;
}

// 当前文档陈旧状态单出口（staleInfo）：当前 HTML + 当前 meta 冻结出 renderInputId，
// 对照 meta.lastRenderInputId 与 PDF 存在性 → none/stale/fresh。mtime 不作正确性依据（仅日志/展示）。
// 调用方：首页徽章、/save 响应 pdfStale、/pdf、/export。
function currentRenderState(id) {
  const html = fs.readFileSync(docPath(id), 'utf8');
  const meta = loadMeta()[id] || {};
  const frozen = freezeHtml(applyDocTheme(html, meta), meta);   // S6-A1：陈旧判定与渲染同用一份按主题装配的输入
  const pdfExists = fs.existsSync(pdfPath(id));
  const si = staleInfo(meta, { renderInputId: frozen.renderInputId, pdfExists });
  let docMtime = null;   // 仅日志参考（判定不看它）
  try { docMtime = new Date(fs.statSync(docPath(id)).mtimeMs).toISOString(); } catch {}
  return { frozen, meta, pdfExists, state: si.state, stale: si.stale, docMtime };
}

// 当前文档渲染唯一入口（铁律一）：freezeHtml(当前 HTML, 当前 meta) → tmp 冻结文件 → render.mjs --src
// （RESUME_RENDER_INPUT_ID / RESUME_RENDER_REPRODUCIBLE 经 env 传入，供 <pdf>.env.json 旁车记录）
// → 成功经 updateMeta 记 meta.lastRenderInputId/lastRenderAt（记的是本任务冻结的标识，不是完成时的"当前"标识；
//   渲染期间又保存 → 下次判定自然 stale，无需 mtime）。
// POST /render、/export 与 /pdf 的缺失/过期自动重渲、/rollback、/restructure 一律走这里；绝不直渲磁盘 HTML
// （迁移后当前文档不含内联 typo，直渲会丢排版）。
async function renderCurrent(id, { lease } = {}) {
  const meta = loadMeta()[id] || {};
  const html = applyDocTheme(fs.readFileSync(docPath(id), 'utf8'), meta);   // S6-A1：渲染输入按 meta.theme 装配
  const frozen = freezeHtml(html, meta);   // 任务启动即冻结输入
  const tmp = path.join(os.tmpdir(), `resume-frozen-${id}-${Date.now()}-${process.pid}.html`);
  atomicWrite(tmp, frozen.html);
  let ok = false;
  let sizeError = null;   // BL-P1-04：超限时带尺寸原因透出，路由层用它替换「渲染失败（详见服务日志）」
  try {
    const rr = await renderDoc({
      src: tmp,
      out: pdfPath(id),
      env: { RESUME_RENDER_INPUT_ID: frozen.renderInputId, RESUME_RENDER_REPRODUCIBLE: frozen.reproducible ? '1' : '0' },
      lease
    });
    ok = rr.ok && fs.existsSync(pdfPath(id));
    sizeError = rr.sizeError || null;
    if (ok) {
      // 净化情况如实记录（AUD-05）：实际参与渲染的输入被改过就必须留痕，不能声称「与原文一致」
      updateMeta(root, id, (m) => ({ ...(m || {}), lastRenderInputId: frozen.renderInputId, lastRenderAt: new Date().toISOString(),
        lastRenderSanitized: !!(rr.removed && rr.removed.length), lastRenderRemoved: (rr.removed || []).slice(0, 20) }));
      console.error(`[render] 已渲染 id=${id} renderInputId=${frozen.renderInputId} reproducible=${frozen.reproducible}`);
    } else {
      console.error(`[render] 渲染失败 id=${id} renderInputId=${frozen.renderInputId}（详见上方渲染输出）`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return { ok, frozen, sizeError };
}

function readBody(req, mode = 'text', maxSize = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxSize) { chunks.length = 0; reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(mode === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
// 表单/JSON 双兼容 body
async function readBodyAuto(req) {
  const text = await readBody(req);
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) return JSON.parse(text);
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { return Object.fromEntries(new URLSearchParams(text)); }
}

// 流式写文件（大备份上传用）
// AUD-08：一次结算 —— 输入错误、输出错误、超限、客户端中断都只 reject 一次；
// 输出流的 'error' 必须监听：未监听的 error 事件是未处理异常，会直接终止整个服务
// （2026-10-28 隔离复现：给文件 sink 注入受控 I/O 错误 → 请求断开、服务退出 1）。
// 背压：write 返回 false 时暂停输入、等 drain 再继续（否则大上传会把内存撑爆）。
function readBodyToFile(req, file, maxSize) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file);
    let size = 0, done = false;
    const finish = (err, n) => {
      if (done) return;
      done = true;
      try { ws.destroy(); } catch {}
      if (err) reject(err);
      else resolve(n);
    };
    // 成功判定必须等 fd 真正打开并写完：
    // writable.end(cb) 的回调（'finish'）在 open 失败时【也会触发】（数据只是进了内部缓冲），
    // 旧实现据此 resolve → 「写入失败被当成成功」。故以 open+finish+close 三者齐备为准。
    let opened = false, flushed = false;
    ws.on('open', () => { opened = true; });
    ws.on('finish', () => { flushed = true; });
    ws.on('error', (e) => finish(e));            // 输出侧：EIO / ENOSPC / 权限
    ws.on('close', () => finish(opened && flushed ? null : new Error('写入未完成'), size));
    req.on('error', (e) => finish(e));           // 输入侧
    req.on('aborted', () => finish(new Error('上传中断')));
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxSize) { finish(new Error('body too large')); return; }
      if (!ws.write(c)) {
        req.pause();
        ws.once('drain', () => { if (!done) req.resume(); });
      }
    });
    req.on('end', () => { if (!done) ws.end(); });
  });
}

/* icon() 的渲染白名单。
   ⚠️ 图标数据来自**外部来源目录**（lucide 提取产物可被替换）——属性名/标签名若原样
   拼进 HTML，onload / onfocus 之类就会进到每一页的 SVG 里。这里只放行 SVG 的
   几何与呈现属性、只放行 lucide 用到的元素名；白名单外的一律**丢弃**，不原样输出。
   本段被 test-structure.sh 的 UI-1/UI-2 抽取做运行时断言，改这里必须同步改断言。 */
const ICON_TAG_WHITELIST = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const ICON_ATTR_WHITELIST = new Set([
  'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'width', 'height',
  'x1', 'x2', 'y1', 'y2', 'points',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity',
]);

/**
 * 内联 SVG 图标（Lucide path 数据，ISC）。
 * 名字走 ICONS 白名单查表 —— 不存在就返回空串，**绝不把调用方传入的字符串拼进 SVG**（XSS）。
 * 元素名与属性名再走 ICON_*_WHITELIST —— 外部数据里的 onload 之类一律丢弃。
 * stroke 用 currentColor，跟随主题色。
 * @param name  ICONS 里的键名（白名单外一律返回空串）
 * @param size  像素边长（非数字回落 16）
 * @param cls   附加 class（只保留安全字符，防属性逃逸）
 */
function icon(name, size = 16, cls = '') {
  if (!Object.prototype.hasOwnProperty.call(ICONS, name)) return '';   // 白名单外 → 空串
  const parts = ICONS[name];
  const s = Number(size) > 0 ? Number(size) : 16;
  const c = String(cls).replace(/[^a-zA-Z0-9_ -]/g, '');
  const body = parts.map(([tag, a]) => {
    if (!ICON_TAG_WHITELIST.has(tag)) return '';                        // 白名单外的元素名 → 丢弃
    if (!a || typeof a !== 'object' || Array.isArray(a)) return '';    // 形状非法 → 丢弃
    const attrs = Object.entries(a)
      .filter(([k]) => ICON_ATTR_WHITELIST.has(k))                      // 白名单外的属性名 → 丢弃
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`)
      .join(' ');
    return `<${tag} ${attrs}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${c ? ` class="${c}"` : ''} aria-hidden="true" focusable="false">${body}</svg>`;
}


// 写请求统一失败语义（AUD-15）：HTTP 业务失败与网络异常都进失败分支；
// 失败时保留输入与旧有效值，不 reload、不显示已生效。
// 由 page() 统一注入到每个页面 —— 各写入口只调 __wv(url, body, msgEl)。
const WRITE_HELPER_JS = `<script nonce="__CSP_NONCE__">
window.__wv = function (url, body, msgEl) {
  var setMsg = function (m) {
    if (msgEl && window.__status) { try { window.__status(msgEl, 'err', m); return; } catch (e) {} }
    if (window.alert) window.alert(m);
  };
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = JSON.parse(t); } catch (e) {}
        if (!r.ok || (d && d.ok === false)) {
          var msg = (d && (d.error || d.msg)) || ('HTTP ' + r.status);
          setMsg(msg);
          var e = new Error(msg); e.__writeFailed = true; throw e;
        }
        return d || {};
      });
    })
    .catch(function (e) {
      if (e && e.__writeFailed) throw e;
      var m2 = '网络异常：' + ((e && e.message) || e);
      setMsg(m2);
      var e2 = new Error(m2); e2.__writeFailed = true; throw e2;
    });
};
</script>`;

// 内联 handler 委托化（2026-11-07 批 5 b5c1）：page() 统一注入（拼进 STATUS_SCRIPT 同一个
// <script> 标签，不新增标签——首页 <script> 标签数有 test-home-eval-card-removed 钉值=3）。
// 全站 51 处内联事件属性（onclick/onchange/oninput/onsubmit/onkeydown）改为 data-action="动作名"
// + data-* 携带参数；各页脚本把实现注册进 window.__acts[事件类型][动作名]，本段在 document 级统一监听分发。
// 按事件类型分桶：表单的 data-action 只注册在 submit 桶 —— 其内部按钮的 click 冒泡到表单元素时，
// click 桶查不到同名注册 → 静默，与「内联 onclick 只绑在被点元素自身」的语义一致。
// submit 处理器返回 false ⇔ 内联 onsubmit="return false"（取消提交）；处理器内自行 preventDefault 亦可。
// keydown 只分发 Enter：内联 onkeydown 只钉过 Enter（投递表格排序表头）。
const ACT_DISPATCH_JS = `
window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} };
(function () {
  var find = function (ev) {
    var t = ev.target;
    return (t && t.closest) ? t.closest('[data-action]') : null;
  };
  var run = function (type) {
    return function (ev) {
      var el = find(ev);
      if (!el) return;
      var fn = window.__acts[type][el.getAttribute('data-action')];
      if (fn) fn(el, ev);
    };
  };
  document.addEventListener('click', run('click'));
  document.addEventListener('change', run('change'));
  document.addEventListener('input', run('input'));
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    run('keydown')(ev);
  });
  document.addEventListener('submit', function (ev) {
    var el = find(ev);
    if (!el) return;
    var fn = window.__acts.submit[el.getAttribute('data-action')];
    if (fn && fn(el, ev) === false) ev.preventDefault();
  });
})();`;

function page(title, inner, active = '', wide = false) {
  // 第 4 参 ic = Lucide 图标名（白名单外 icon() 返回空串 → 退化为纯文字，不炸）
  const nav = (key, href, label, ic) => `<a href="${href}"${active === key ? ' class="on"' : ''}>${ic ? icon(ic, 15) : ''}${label}</a>`;
  // 导航唯一（用户裁决 2026-11-03：页头只显示一个）——topnav 是全站唯一页头（sticky + 当前项
  // 高亮由 active 驱动）；旧 .sidenav 左栏与其完全重复，已移除（断言 UI-5 同步反转为「导航唯一」）。
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>/*BENTO-V1*/
/* 浅色克制设计系统（2026-10-21 UI 重设计，设计文档 dev-docs/2026-10-21-ui-redesign-design.md）：
   主行动用近黑不用蓝；彩色只承载状态；零阴影靠 1px 边框 + 背景差表达层级。
   旧名（--bg/--panel/--ink/...）保留为别名，既有 CSS 几百处零改动即生效。 */
/* B1 双区规则已定案（DESIGN.md §2，2026-11-02 用户拍板）：应用页主行动 --accent 为近黑；编辑器 --ed-accent 为暖橙（editor-shell.js），两区不互通；字面值已钉 test-structure.sh B1 断言。 */
/*A-VARS*/:root{--background:#ffffff;--foreground:#0a0a0a;--muted:#737373;--card:#ffffff;--card-2:#fafafa;--border:#e5e5e5;--accent:#18181b;--accent-fg:#ffffff;--success:#15803D;--success-bg:#f0fdf4;--warning:#A25711;--warning-bg:#fffbeb;--danger:#B91C1C;--danger-bg:#fef2f2;--radius:4px;--radius-lg:6px;--shadow:none;--font:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;--font-mono:ui-monospace,Menlo,monospace;--bg:var(--background);--panel:var(--card);--ink:var(--foreground);--fg:var(--foreground);--mut:var(--muted);--line:var(--border);--accent-ink:var(--accent-fg);--accent-soft:var(--card-2);--ok:var(--success);--ok-soft:var(--success-bg);--warn:var(--warning);--warn-soft:var(--warning-bg);--err:var(--danger);--err-soft:var(--danger-bg);--ai:var(--foreground);--ai-soft:var(--card-2);--serif:var(--font);--sans:var(--font);--shadow-up:0 10px 24px rgba(0,0,0,.10);--space-hair:2px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-6:24px}
*{box-sizing:border-box}
/* 批次B：body 不再限宽（max-width:1100px 会把「侧栏+内容」压扁）——
   页面总宽改由 .home / .topnav 自身定宽居中（各 1400px），body 只留左右 20px 内边距。 */
body{font-family:var(--sans);line-height:1.6;margin:0;padding:0 20px 40px;font-size:14px;background:var(--bg);color:var(--ink)}
body.wide{max-width:min(1440px,100%)}
a{color:var(--accent);text-decoration:none;font-weight:600}
/* S4B-2：键盘 Tab 焦点不被 sticky 顶栏遮挡（WCAG 2.4.11 Focus Not Obscured, AA 级）。
   64px = topnav 的 top:12px + 单行实测高约 40px + 12px 余量。
   窄屏 .topnav 折成两行时 64px 不够 —— 见下方窄屏档位（媒体查询单独加一档，不改此默认值）。 */
html{scroll-padding-top:64px}
/* 窄屏档位（批次B 实测补）：390px 下 .topnav 折成两行，实测高 106px，
   sticky 顶栏底部 = top:12px + 106px = 118px，64px 的 scroll-padding 会被顶栏压住 Tab 焦点。
   取值 = top 偏移 12px + 两行实测高 106px + 12px 余量 = 130px。 */
@media (max-width:640px){html{scroll-padding-top:130px}}
/* 批次B：body 不再限宽，页面总宽由 .topnav / .home 各自定宽居中（1400px），两者左右对齐。 */
.topnav{display:flex;justify-content:space-between;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow);padding:10px 18px;margin:16px auto 20px;max-width:1400px;position:sticky;top:12px;z-index:50;flex-wrap:wrap;gap:8px}
.topnav .brand{display:inline-flex;align-items:center;gap:6px;font-family:var(--serif);letter-spacing:.4px;font-weight:800;font-size:16px;color:var(--ink)}
.topnav .brand svg{width:17px;height:17px;flex:none}
.topnav .links a{display:inline-flex;align-items:center;gap:5px;margin-left:16px;color:var(--mut);font-weight:600;padding-bottom:2px;border-bottom:2px solid transparent}
.topnav .links a svg{width:15px;height:15px;flex:none}
.topnav .links a.on{color:var(--accent);border-bottom-color:var(--accent)}
.topnav .links a:hover{color:var(--ink)}
/* 投递系页签条（渐进呈现 T2）：看板/网申包/复盘 三页共用，挂在页题下方。 */
.apptabs{display:flex;gap:var(--space-1);margin:0 0 var(--space-3);border-bottom:1px solid var(--line)}
/* margin-bottom:-1px 是边框补偿字面值（页签底边框与条底边框重合压线），非间距，不走 token。 */
.apptabs a{padding:var(--space-2) var(--space-3);font-size:13px;font-weight:600;color:var(--mut);border-bottom:2px solid transparent;margin-bottom:-1px}
.apptabs a.on{color:var(--ink);border-bottom-color:var(--ink)}
.apptabs a:hover{color:var(--ink)}
.cta-exp{display:inline-block;background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn);border-radius:var(--radius);padding:var(--space-2) var(--space-4);font-weight:700;font-size:14px}
/* 批次B → 导航唯一后（2026-11-03）：.home 只剩内容区，单列流式定宽居中。
   旧 .sidenav 左栏规则已随 DOM 移除（topnav 是唯一页头，见 page() 注释）。 */
.home{margin:0 auto 40px;max-width:1400px}
.mainarea{min-width:0}
/* 内容区页标题（现档 20px/700/-.01em）：.mainarea 的直接子级，或 .page-head 容器内的 h1。 */
.mainarea>h1,.page-head>h1{font-size:20px;font-weight:700;letter-spacing:-.01em}
.mainarea>h1{margin:0 0 var(--space-3)}
/* 页头统一容器：页题 + 右侧动作/计数两栏（视图切换链接、n= 一律移出 h1，h1 只放标题文字）。
   窄屏靠 flex-wrap 自然折行；右侧动作靠 justify-content 右对齐。 */
.page-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-3);flex-wrap:wrap;margin:0 0 var(--space-3)}
.page-head>h1{margin:0}
.page-head .page-meta{font-size:13px;font-weight:400;color:var(--mut);font-variant-numeric:tabular-nums}
/* 标题两档（A-VARS 登记的唯一档位表；新增标题必须归入其中一档，不得新增第三档）：
     ① brand .topnav .brand          16px / 800 / +0.4px
     ② 页题  .mainarea>h1,.page-head>h1  20px / 700 / -0.01em
   层级只靠「字号 + 字重」拉开，字距只作微调（tracking 下限 -0.04em）。
   —— 旧 ③ hero 大标题档（34px/800/+.8px）已随首页 hero 区退役删除（2026-11-05 批 1 §0.2，
      DESIGN.md §4.2 撤销登记）：品牌身份归 topnav，页面第一标题 = h1「文档」。
   —— 更早的 h1{26px/800/+0.6px} 也是死规则（全站 h1 都由 page() 包进 .mainarea，被上两档覆盖），同样已删。 */
/* 二级标题档：此前全站无 h2 样式，落浏览器默认 1.5em（比页题还大） */
.mainarea h2{font-size:16px;font-weight:700;margin:16px 0 8px}
button{cursor:pointer;background:var(--accent);color:var(--accent-ink);border:none;border-radius:var(--radius);min-height:32px;padding:0 12px;font-weight:600;font-size:13px;transition:transform .12s,background .12s}
button.secondary{background:var(--panel);color:var(--ink);border:1px solid var(--line)}
button.danger{background:var(--panel);color:var(--err);border:1px solid var(--err-soft)}
button.danger:hover{background:var(--err-soft)}
/* R2⑩：hover 删影保留 translateY（零阴影定案见 DESIGN.md §3.1，阴影例外仅 --shadow-up 已登记；transition 同步清理 box-shadow） */
button:hover{transform:translateY(-1px)}
button:active{transform:translateY(1px);box-shadow:none}
button.secondary:hover{background:var(--bg)}
button:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}
input,textarea{border:1px solid var(--line);border-radius:var(--radius);padding:7px 10px;background:var(--panel);color:var(--ink);font-size:13px;max-width:100%}
select{border:1px solid var(--line);border-radius:var(--radius);padding:7px 10px;background:var(--panel);color:var(--ink);font-size:13px}
button:focus-visible,input:focus-visible,a:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px}
.card-active{border-color:var(--accent);background:var(--card-2)}
/* 卡片标题唯一口径（全仓卡片标题只此一处，首页/导出/设置/复盘四页同款）：
   14px/800。font-family 写 var(--font) 而非 var(--serif) —— 两者同族（--serif:var(--font)），零视觉差。 */
.card-title{font-family:var(--font);font-size:14px;font-weight:800}
/* doc-card 的 16px 是有意层级（文档标题比卡片标题大一号），单独登记，不是第四档。 */
.doc-card .card-title{font-size:16px}
/* 复盘层级（2026-11-05 批 1 §0.2）：主卡 2/3 + 侧卡 1/3。
   主列（.stats-main）承载主卡「评估 ↦ 投递」+ 三分布网格（收窄在 2/3 内，不再满宽铺开）；
   侧卡（.stats-side）合并「状态分布」与「面试参与」两段。
   间距一律走 §5.1 token；静态层级零阴影（阴影例外仅 --shadow-up 限 .doc-card:hover，§3.1）。 */
.stats-grid{display:grid;grid-template-columns:2fr 1fr;gap:var(--space-3);align-items:start;margin-top:var(--space-3)}
.stats-main{display:flex;flex-direction:column;gap:var(--space-3)}
.stats-dists{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3)}
.stats-sec{border-top:1px solid var(--line);margin-top:var(--space-3);padding-top:var(--space-3)}
@media (max-width:860px){.stats-grid{grid-template-columns:1fr}}
@media (max-width:560px){.stats-dists{grid-template-columns:1fr}}
/* 徽章与胶囊同档：字号 12px、内边距 3px 11px，与 .chip 完全一致，两枚胶囊只剩 1px 边框差。
   margin-right:6px 保留 —— 它是徽章后分隔的唯一机制（全站 43 处在用，删则粘连）。
   注意：徽章自带右距；放进 flex/gap 容器必须给 .badge{margin-right:0}，否则双倍计距。 */
.badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:3px 11px;font-size:12px;font-weight:500;background:var(--card-2);color:var(--mut);margin-right:6px}
.badge svg{width:11px;height:11px;stroke-width:2.4;flex:none}
/* 胶囊：字号 12px / 内边距 3px 11px 与 .badge 完全同款（两枚胶囊同一字号与内边距）。
   min-height 收为 26px：全局 button{min-height:32px} 会把胶囊撑到 32px，比徽章高 6.8px —— 两枚就不同档了。
   胶囊高度改由自身盒模型决定（27.2px，与徽章 25.2px 只差 chip 的 1px 边框）；26px 下限仍高于 WCAG 2.2 的 24px 目标尺寸。 */
.chip{border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:12px;background:var(--panel);cursor:pointer;min-height:26px}
.chip[aria-pressed="true"]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
/* 语义徽章：底色 + 语义色 + 图标 + 文字（颜色不单独承载语义，WCAG color-not-only）。
   类名沿用既有的 .badge ok/.warn/.err/.ai（既有 43 处在用），只新增 .badge.mute
   —— 不另起 badge--ok 体系，避免两套命名并存。
   不用 white-space:nowrap：长文案徽章（导出页「旧版本 PDF」那条）要能换行，与改前一致。 */
.badge.ok{background:var(--success-bg);color:var(--success)}.badge.warn{background:var(--warning-bg);color:var(--warning)}.badge.err{background:var(--danger-bg);color:var(--danger)}.badge.ai{background:var(--card-2);color:var(--foreground)}.badge.mute{background:var(--card-2);color:var(--muted)}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:12px 0}
.stat{border-radius:var(--radius);padding:12px 14px;box-shadow:var(--shadow);border:1px solid var(--line)}
.stat b{font-size:22px;display:block;font-variant-numeric:tabular-nums}
.stat span{font-size:12px;color:var(--mut)}
.stat.s1{background:var(--ai-soft)}.stat.s2{background:var(--accent-soft)}.stat.s3{background:var(--ok-soft)}.stat.s4{background:var(--warn-soft)}
ul.doclist{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
ul.doclist.list-view{grid-template-columns:1fr}
.group-head{list-style:none;grid-column:1/-1;font-family:var(--serif);font-weight:800;font-size:15px;margin:10px 0 0;padding-bottom:4px;border-bottom:1px solid var(--line);color:var(--mut)}
.diff-line{padding:3px 8px;border-radius:6px;margin:2px 0;font-size:13px}
.diff-line.same{color:var(--mut)}
.diff-line.del{background:var(--err-soft);text-decoration:line-through}
.diff-line.ins{background:var(--ok-soft)}
footer{margin-top:36px;text-align:center;color:var(--mut);font-size:12px}
/* 任务卡（2026-11-05 批 1 §0.2：hero 退役后的首屏主行动，三态=草稿继续/从零建简历/为岗位定制简历）；
   间距引用 §5.1 token，不新增间距档；主行动仍用 .cta 实底。 */
.taskcard{margin:0 0 var(--space-3)}
.taskcard .task-acts{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center}
/* 徽章在 gap 容器内必须归零自带右距（DESIGN.md §5.3：否则 gap+6px 双倍计距）；
   只作用于本容器——行内容器里的徽章仍靠 6px 右距分隔（徽章后分隔的唯一机制，全站 43 处在用）。 */
.taskcard .task-acts .badge{margin-right:0}
.taskcard .task-side{margin-top:var(--space-2);display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap}
/* 网申包页（2026-11-06 批 3 §4 卡片 b3c2）：字段行 + 三态徽章 + 操作行。
   间距一律 --space-* token（§5.1）；圆角 --radius（§5.2）；零 box-shadow（§3.1 静态层级零投影，阴影例外仅 --shadow-up 限 .doc-card:hover）；
   字号只取既有档（§4.1：12px 表单标签/元数据、13px 面板正文与输入），不新增档位。 */
.ap-sec{margin:0 0 var(--space-4)}
.ap-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:var(--space-3);margin-top:var(--space-3)}
.ap-row{border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-3);background:var(--panel);display:flex;flex-direction:column;gap:var(--space-2)}
.ap-head{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}
.ap-head .badge{margin-right:0}
.ap-label{font-size:12px;font-weight:700}
.ap-src{font-size:12px;color:var(--mut)}
.ap-val{width:100%;font-family:var(--font);font-size:13px}
.ap-val[readonly]{background:var(--card-2);color:var(--mut)}
.ap-acts{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center}
.ap-bar{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center;margin-top:var(--space-3)}
.ap-note{font-size:12px;color:var(--mut)}
.ap-gen{display:flex;flex-direction:column;gap:var(--space-2)}
.ap-gen-status{font-size:12px;color:var(--mut)}
.ap-gen-draft{display:flex;flex-direction:column;gap:var(--space-2)}
.ap-gen-draft[hidden]{display:none}
.ap-gen-text{width:100%;font-family:var(--font);font-size:13px}
/* 跟进助手（2026-11-06 批 3 §4 卡片 b3c4）：投递卡「无回应满 N 天」→ 生成跟进语草稿（只生成，不发送）。
   间距一律 --space-* token（§5.1）；圆角 --radius（§5.2）；零 box-shadow（§3.1）；
   字号只取既有档（§4.1：12px 元数据、13px 面板正文与输入），不新增档位。 */
.fu-box{display:flex;flex-direction:column;gap:var(--space-2);margin-top:var(--space-2)}
.fu-line{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap}
.fu-line .badge{margin-right:0}
.fu-status,.fu-msg,.fu-note{font-size:12px;color:var(--mut)}
.fu-draft{display:flex;flex-direction:column;gap:var(--space-2)}
.fu-draft[hidden]{display:none}
.fu-text{width:100%;font-family:var(--font);font-size:13px}
.fu-acts{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap}
/* 分享副本（2026-11-07 批 3 §4 卡片 b3c5）：勾选隐藏字段 → 独立预览/PDF + 文本层无残留校验。
   间距一律 --space-* token（§5.1）；圆角走既有 --radius（§5.2）；零 box-shadow（§3.1 静态层级零投影）；
   字号只取既有档（§4.1：12px 元数据、13px 面板正文与勾选行），不新增档位。 */
.ap-sh-keys{display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:center}
.ap-sh-key{display:flex;align-items:center;gap:var(--space-2);font-size:13px}
.ap-sh-list{margin-top:var(--space-3)}
.ap-sh-row{display:flex;justify-content:space-between;align-items:center;gap:var(--space-2);flex-wrap:wrap;border-top:1px dashed var(--line);margin-top:var(--space-2);padding-top:var(--space-2)}
/* 面试练习（2026-11-07 批 4 §5 卡片 b4c2）：投递详情「面试练习」区——逐题作答 → 反馈流 + 缺的素材一键转待补充。
   间距一律 --space-* token（§5.1）；圆角走既有 --radius（§5.2）；零 box-shadow（§3.1 静态层级零投影）；
   字号只取既有档（§4.1：12px 元数据、13px 面板正文与输入），不新增档位。 */
.pr-session{margin-top:var(--space-2);border-top:1px solid var(--line);padding-top:var(--space-2)}
.pr-session>summary{cursor:pointer;font-size:13px}
.pr-q{margin-top:var(--space-3);border-top:1px dashed var(--line);padding-top:var(--space-3)}
.pr-qtext{font-size:13px;font-weight:700}
.pr-meta{font-size:12px;color:var(--mut);margin-top:var(--space-1)}
.pr-points{margin:var(--space-1) 0 0;padding-left:var(--space-4);font-size:13px}
.pr-answer{width:100%;font-family:var(--font);font-size:13px;margin-top:var(--space-2)}
.pr-acts{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-2)}
.pr-status,.pr-msg,.pr-note{font-size:12px;color:var(--mut)}
.pr-msg:empty,.pr-status:empty{display:none}
.pr-fb{margin-top:var(--space-2);border-top:1px solid var(--line);padding-top:var(--space-2)}
.pr-fb-label{font-size:12px;font-weight:700;margin-top:var(--space-2)}
.pr-list{margin:var(--space-1) 0 0;padding-left:var(--space-4);font-size:13px}
.pr-mat-line{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-1);font-size:13px}
.pr-empty{font-size:13px;color:var(--mut)}
.cta{display:inline-block;background:var(--accent);color:var(--accent-ink);border:none;border-radius:var(--radius);padding:9px 16px;font-weight:700;font-size:14px;cursor:pointer}
.cta:hover{transform:translateY(-1px)}
.cta-alt{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:var(--radius);padding:9px 14px;font-weight:600;font-size:13px;cursor:pointer}
.statusline{margin-top:12px;font-size:13px;line-height:1.7;color:var(--mut)}
.statusline .sep{margin:0 8px;color:var(--line)}
/* 搜索行（S2-T6 窄屏修复）：整行可换行 + 输入框可收缩到 0，按钮/链接标签一律 nowrap。
   390px 下「▤ 切换」曾被 flex 挤到 min-content 而竖排成 3 行；只加 nowrap 会把整行顶出横向溢出，
   故同时放开换行——窄屏自然折成两行（搜索+切换 / 归档），宽屏视觉与改前逐像素一致。 */
.searchrow{display:flex;gap:10px;align-items:center;margin:12px 0;flex-wrap:wrap}
.searchrow input{flex:1 1 180px;min-width:0}
.searchrow button,.searchrow a{flex:0 0 auto;white-space:nowrap}
.kb{display:flex;gap:10px;overflow-x:auto;align-items:flex-start;padding-bottom:8px}
.kb-col{flex:1 1 0;min-width:180px}
.kb-col.empty{flex:0 0 92px;min-width:92px}
.kb-col .group-head{margin-top:0}
.tablewrap{overflow-x:auto}
@media (max-width:600px){.kb{flex-direction:column;overflow-x:visible}.kb>div{min-width:0!important;width:100%}}
@media(hover:hover) and (pointer:fine){
.doc-card{transition:transform .25s,box-shadow .25s}
.doc-card:hover{transform:perspective(900px) rotateX(2deg) rotateY(-2px) translateY(-3px);box-shadow:var(--shadow-up)}}
.doc-card:focus-within{outline:2px solid var(--accent);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.doc-card{transition:none!important}.doc-card:hover{transform:none!important}button{transition:none!important}button:hover,button:active{transform:none!important}}
</style></head><body${wide ? ' class="wide"' : ''}>
<script nonce="__CSP_NONCE__">${STATUS_SCRIPT}${ACT_DISPATCH_JS}</script>
<nav class="topnav"><a class="brand" href="/">${icon('file-text', 17)} 简历工作台</a><span class="links">${nav('docs', '/', '简历', 'file-text')}${nav('apps', '/applications', '投递', 'columns-3')}${nav('settings', '/settings', '设置', 'settings')}</span></nav>
<div class="home"><div class="mainarea">${inner}</div></div>
<footer>简历工作台 · 本地优先 · 数据在 ${path.basename(root) === 'resume' ? '~/resume' : 'RESUME_ROOT'}</footer>
${WRITE_HELPER_JS}</body></html>`;
}

// 投递系页签（渐进呈现）：看板/网申包/复盘 三页共用一条页签条，active 传各自 key。
// 只是三个已有页面的互链，不是新路由。
// 模块级（与 page() 同级）：各路由把 inner 拼好才传进 page()，定义在 page() 体内够不到调用点。
const appTabs = (on) => `<nav class="apptabs" aria-label="投递">${
  [['apps', '/applications', '看板'], ['apply', '/apply-profile', '网申包'], ['stats', '/stats', '复盘']]
    .map(([k, href, label]) => `<a href="${href}"${on === k ? ' class="on" aria-current="page"' : ''}>${label}</a>`).join('')
}</nav>`;

// 徽章：底色 + 语义色 + 小图标 + 文字。类名沿用既有的 .badge ok/.warn/.err/.ai（既有 43 处在用），
// 只新增 .mute —— 不另起 badge--ok 体系。ic 省略时按 cls 取默认图标；cls 为空（纯标签徽章）默认无图标。
const BADGE_ICON = Object.assign(Object.create(null), { ok: 'circle-check', warn: 'circle-alert', err: 'circle-x', mute: 'circle-help' });
const badge = (cls, text, ic) => `<span class="badge${cls ? ' ' + cls : ''}">${icon(ic || BADGE_ICON[cls] || '', 11)}${text}</span>`;

// 客户端状态提示：浏览器端 textContent 装不下 SVG，改用 innerHTML + 逐字符转义。
// 图标由服务端 icon() 生成后随页面下发（唯一来源仍是 vendors/icons.mjs），文本绝不原样进 HTML。
const STATUS_ICONS = Object.assign(Object.create(null), { ok: icon('circle-check', 12), warn: icon('circle-alert', 12), err: icon('circle-x', 12) });
const STATUS_SCRIPT = `window.__STATUS_ICONS__=${JSON.stringify(STATUS_ICONS).replace(/</g, '\\u003c')};`
  + `window.__status=function(el,kind,text){if(!el)return;var s=String(text==null?'':text)`
  + `.replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});`
  + `el.innerHTML=(window.__STATUS_ICONS__[kind]||'')+s;};`;

// 客户端图标（批次D）：编辑器页的 4 个面板脚本是 classic script，拿不到服务端 icon()。
// 服务端把 SVG 渲染好随页面下发 —— 唯一来源仍是 vendors/icons.mjs，客户端只按名字取，不自己拼 SVG。
// 尺寸烘焙成 13px（对齐既有行内图标）；需要更大时用 CSS 覆盖 svg{width;height}（SVG 尺寸属性可被 CSS 覆盖）。
const CLIENT_ICON_NAMES = ['menu', 'trash-2', 'link', 'x', 'target', 'map-pin', 'circle-slash',
  'palette', 'square-pen', 'bot', 'message-square', 'stethoscope', 'sparkles', 'hand', 'check',
  'circle-alert', 'circle-check', 'settings', 'save', 'file-text', 'clock'];
const CLIENT_ICONS = Object.assign(Object.create(null), {});
for (const n of CLIENT_ICON_NAMES) CLIENT_ICONS[n] = icon(n, 13);
const ICON_SCRIPT = `window.__ICONS__=${JSON.stringify(CLIENT_ICONS).replace(/</g, '\\u003c')};`
  + `window.__icon=function(n){return window.__ICONS__[n]||'';};`;

// 注入块（serve 幂等注入；/save 按注释对剥离，文档永不落盘）
const AI_MARK = '<!--AI-INJECT-->';
const ICON_MARK = '<!--ICON-INJECT-->';
const SHELL_MARK = '<!--SHELL-INJECT-->';
const JOB_MARK = '<!--JOB-INJECT-->';
const ZONE_MARK = '<!--ZONE-INJECT-->';
// 客户端图标 + 状态图标（__status）：编辑器页没有 page() 的 STATUS_SCRIPT，这里单独下发一份。
// ===== /edit 的 CSP：文档正文是外部输入，恢复的备份可带 <script> =====
// /edit 把文档原样同源返回 → 恢复一份带脚本的备份后，打开该文档即在应用同源执行
// （能读设置页的 LLM Key 与全部简历）。2026-10-22 审查 [高]。
// 处置：/edit 加严格 CSP —— 内联脚本只放行两类：
//   ① 编辑器主脚本：内容与已知版本逐字节相同（DOC_ID 值归一化后比对指纹）→ 用 sha256 放行
//   ② 服务端自己注入的块（__MATS__ / __ICONS__ 等数据）→ 用 nonce 放行
// 其余内联脚本一律被 CSP 挡掉。模板与注入层都不用内联事件属性（已核）→ 不误伤交互。
// 已知指纹（含历史版本）：换模板版本时要把它加进来，否则旧文档的编辑器会被挡掉。
const EDITOR_SCRIPT_HASHES = new Set([
  '7dwc1dIu5F63H9JhH0TVbYzH9xrpWfPtT5OLVxbPFAY=',   // 0c3fed0（S3-T4 修复轮，当前）
  'n0YyHsUh6KVazqH4o/zf7MI0FX8u8DIS67soPeUsp20='    // 72cd098（S3-T4 区域 Tab，历史版本）
]);
// 脚本归一化：DOC_ID 的值随文档变 → 比对前先还原成占位符
const normEditorScript = (code) => String(code).replace(/var DOC_ID = '[^']*';/, "var DOC_ID = '{{DOC_ID}}';");
const sha256b64 = (s) => createHash('sha256').update(String(s), 'utf8').digest('base64');
// 已知指纹 = 运行期算出的【当前模板版】+ 历史版本表。
// 当前版每次运行现算 → 模板换版时不会忘记加（否则所有文档的编辑器都被 CSP 挡掉 ✗）；
// 历史版本表只影响「恢复旧备份后的编辑器能不能跑」。
const knownEditorScriptHashes = () => {
  const set = new Set(EDITOR_SCRIPT_HASHES);
  try {
    const tpl = assembleTemplate('classic');   // 主题只换 CSS，编辑器主脚本各主题一致
    const m = /<script>([\s\S]*?)<\/script>/.exec(tpl);
    if (m) set.add(sha256b64(normEditorScript(m[1])));
  } catch { /* 模板读不到就只用历史表 */ }
  return set;
};
// 返回该 html 里「可以放行」的编辑器主脚本的 CSP hash（原始字节的 hash，供浏览器比对）
function allowedEditorScriptHashes(html) {
  const known = knownEditorScriptHashes();
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (known.has(sha256b64(normEditorScript(m[1])))) out.push("'sha256-" + sha256b64(m[1]) + "'");
  }
  return out;
}
function iconBlock(nonce) {
  return `\n${ICON_MARK}<script nonce="${nonce}">${STATUS_SCRIPT}</script><script nonce="${nonce}">${ICON_SCRIPT}</script><!--/ICON-INJECT-->\n`;
}
function aiBlock(id) {
  return `\n${AI_MARK}<script src="/ai-panel.js" data-doc="${id}" defer></script><!--/AI-INJECT-->\n`;
}
function shellBlock(id, mtimeMs, nonce) {
  const mats = loadMats().map((m) => ({ id: m.id, title: m.title, tags: m.tags || [],
    brief: m.brief, technical: m.technical || '', interview: m.interview || '', confirmed: m.factStatus === 'confirmed', facts: m.facts || {} }));   // S4a-T7：facts 随 __MATS__ 供给证据表「事实依据」可读化
  const meta = loadMeta()[id] || {};
  const job = meta.job
    ? { hasJob: true, status: flowOf(meta), company: meta.company || '', role: meta.role || '', materials: meta.job.materials || [] }
    : { hasJob: false };
  // S6-A2：主题清单与当前主题随壳下发（模板页签数据源；主题元数据/文案在 editor-shell.js 客户端侧）
  const themeInfo = { themes: listThemes(), current: (typeof meta.theme === 'string' ? meta.theme : '') || '' };
  return `\n${SHELL_MARK}<script nonce="${nonce}">window.__MATS__=${JSON.stringify(mats).replace(/</g, '\\u003c')};window.__JOB_INFO__=${JSON.stringify(job).replace(/</g, '\\u003c')};window.__THEME_INFO__=${JSON.stringify(themeInfo).replace(/</g, '\\u003c')};</script><script src="/editor-shell.js" data-doc="${id}" data-mtime="${Number(mtimeMs) || 0}" defer></script><!--/SHELL-INJECT-->\n`;
}
function jobBlock(id) {
  return `\n${JOB_MARK}<script src="/job-panel.js" data-doc="${id}" defer></script><!--/JOB-INJECT-->\n`;
}
function zoneBlock(id) {
  return `\n${ZONE_MARK}<script src="/zone-panel.js" data-doc="${id}" defer></script><!--/ZONE-INJECT-->\n`;
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escHtml(s).replace(/"/g, '&quot;');   // 属性值转义（value="..." 防双引号截断）
// 三种上下文必须用不同的转义，别混用（2026-10-22 XSS 审计）：
//   ① HTML 文本节点 → escHtml（引号在文本节点里无害）
//   ② HTML 属性值 → escAttr（不转义 " 就能闭合属性注入事件处理器；实测 '" onmouseover="x' 可打穿）
//   ③ JS 字符串上下文（onclick/onsubmit 里的 '...'）→ escAttr 不够！单引号能闭合 JS 串，
//      必须先 JSON.stringify 成 JS 字面量、再按 HTML 属性转义：jsStr(v)
//   ④ 内联 <script> 里的 JSON → jsonScript（见下）
// 不要把 escHtml 改成「顺手也转义双引号」：那会打穿 docInfo.title → jsonAttr → data-doc-titles
// 的实体还原链（属性里的 &quot; 被浏览器解码回 " 后 JSON.parse 失败，标题全丢）。
// 单引号属性内嵌 JSON：沿用本文件既有 JSON.stringify(...).replace(...) 写法（见 shellBlock 的 __MATS__/__JOB_INFO__、
// 备份页 DATA），把唯一能截断单引号属性的 ' 换成 JSON 转义 \u0027 —— 属性里不再出现裸 '，JSON.parse 原样还原为 '。
// 值（docInfo.title）已过 escHtml：& < > 以实体形式存在并由属性解析还原，故此处绝不能再转 &（会把 &amp; 变成 &amp;amp;）。
// JS 字符串上下文（onclick/onsubmit 里的 '…'）：先 JSON.stringify 成 JS 字面量、再按 HTML 属性转义。
// 单引号能闭合 JS 串 → 只 escAttr 不够（实测 "x'+alert(1)+'b" 会执行）。
// 同款写法全仓统一走这里：少写 20 个字符，也少一个能写错的地方。
const jsStr = (v) => escAttr(JSON.stringify(v));
const jsonAttr = (v) => JSON.stringify(v).replace(/'/g, '\\u0027');
// 内联 <script> 里的 JSON：必须连 < 一起转，否则数据里的 "</script>" 会闭合脚本标签（实测可执行任意脚本）。
// 不转 &：值多已过 escHtml（& < > 以实体存在），此处再转会变成 &amp;amp;
const jsonScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

// ===== 岗位评估：报告渲染器 + 历史列表接线（/evals 页与 /job/new 页共用同一份）=====
// EVAL_CARD_JS：客户端报告渲染器。**必须能独立执行**（test-structure.sh EV-7 会把本块抽出来单跑）——
// 图标在服务端内联进块内，不依赖页面级全局（vendors/icons.mjs 仍是唯一来源）。
// 本块只定义变量与函数：**顶层不得碰 document**（单跑时没有 DOM）。
const EVAL_CARD_JS = `/*EVAL_CARD_JS_START*/
// 报告渲染器必须能独立执行（测试会单独把本块抽出来跑）——图标在服务端内联进块内，
// 不依赖页面级全局（vendors/icons.mjs 仍是唯一来源）。
var EVAL_ICON = { ok: ${jsonScript(icon('circle-check', 12))}, warn: ${jsonScript(icon('circle-alert', 12))} };
var EVAL_BTN_ICON = ${jsonScript(icon('compass', 13))};
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function evalCardHtml(rec, opts) {
  var b = (rec && rec.blocks) || {};
  var VERDICT = { apply: '建议投', caution: '谨慎', skip: '不建议' };
  // 文案写明方向而不只给档位名：under/right/over 说的是「简历资历 vs 岗位要求」，
  // 用户看到「偏保守」不知道是谁对谁保守（2026-10-19 补 prompt 语义时同步）。
  var LEVEL = { under: '低于岗位要求', right: '恰好匹配', over: '高于岗位要求' };
  var STATUS = { covered: '已有证据', sourced: '素材支持', partial: '部分匹配', missing: '未找到' };
  var sal = b.salary || {};
  var h = [];
  h.push('<div class="card" style="margin-top:12px">');
  h.push('<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><b style="font-size:24px">' + esc(rec.score == null ? '-' : rec.score) + ' / 5</b><b style="font-size:16px">' + esc(VERDICT[rec.verdict] || rec.verdict || '未定') + '</b><span style="font-size:12px;color:var(--mut)">岗位评估报告</span></div>');
  h.push('<p style="margin:6px 0"><b>角色摘要：</b>' + esc(b.roleSummary) + '</p>');
  h.push('<p style="margin:6px 0"><b>级别：</b>' + esc(LEVEL[b.level] || b.level || '') + (b.levelReason ? '（' + esc(b.levelReason) + '）' : '') + '</p>');
  if (sal.source === 'JD 未提供') {
    h.push('<p style="margin:6px 0"><b>薪资：</b><b style="color:var(--warn)">JD 未提供</b> ' + EVAL_ICON.warn + ' 无外部薪资数据（本系统不查外部薪资库，别当成市场价）</p>');
  } else {
    h.push('<p style="margin:6px 0"><b>薪资：</b>' + esc(sal.text) + ' <span style="font-size:12px;color:var(--mut)">（来源：' + esc(sal.source) + '）</span></p>');
  }
  h.push('<p style="margin:6px 0"><b>最该强调：</b>' + esc(b.angle) + '</p>');
  h.push('<p style="margin:6px 0"><b>结论理由：</b>' + esc(b.verdictReason) + '</p>');
  h.push('<div style="margin-top:10px"><b>逐条匹配</b>');
  var ms = Array.isArray(b.matches) ? b.matches : [];
  if (!ms.length) h.push('<p style="font-size:13px;color:var(--mut)">（无）</p>');
  ms.forEach(function (m) {
    h.push('<div style="margin-top:6px;font-size:13px">· ' + esc(m.req) + ' — ' + esc(STATUS[m.status] || m.status || '') +
      (m.evidence ? '<div style="color:var(--mut);font-size:12px">证据：' + esc(m.evidence) + '</div>' : '') + '</div>');
  });
  h.push('</div>');
  h.push('<div style="margin-top:10px"><b>缺失能力</b>');
  var gs = Array.isArray(b.gaps) ? b.gaps : [];
  if (!gs.length) h.push('<p style="font-size:13px;color:var(--mut)">（无）</p>');
  gs.forEach(function (g) { h.push('<div style="font-size:13px">· ' + esc(g) + '</div>'); });
  h.push('</div>');
  // 动作行（转入适配 / 重新评估）只在「刚评估完」的场景出现：历史记录是回看，
  // 来源缺失的旧记录没有可转的母版 —— 动作由列表行自己出（那里才判 sourceState）。
  if (!(opts && opts.hideActions)) {
    h.push('<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" data-eval-act="promote" data-eval-id="' + esc(rec.id) + '">' + EVAL_ICON.ok + ' 就它了，转入适配</button><button type="button" class="secondary" data-eval-act="redo">重新评估</button></div>');
  }
  h.push('</div>');
  return h.join('');
}
/*EVAL_CARD_JS_END*/`;

// EVAL_HISTORY_JS：评估历史列表的客户端接线（/evals 页用；批 1 §0.3 起首页评估历史卡已撤除）。
// 「查看报告」= 把页面内联的记录交给 evalCardHtml 渲染；「转入适配」= POST /eval/promote。
// 作用域限定在 #evalHistory 容器内：/job/new 页「刚评估完」那条流程（#evalResult）另有自己的处理器，互不干扰。
const EVAL_HISTORY_JS = `
(function () {
  var box = document.getElementById('evalHistory');
  if (!box) return;
  var msg = document.getElementById('evalHistoryMsg');
  var recs = (typeof EVAL_RECORDS !== 'undefined' && EVAL_RECORDS) || {};
  box.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-eval-hist]');
    if (!t) return;
    var act = t.getAttribute('data-eval-hist');
    var id = String(t.getAttribute('data-eval-id') || '');
    if (act === 'report') {
      var slot = document.getElementById('evalSlot-' + id);
      if (!slot || !Object.prototype.hasOwnProperty.call(recs, id)) return;
      var open = slot.getAttribute('data-open') === '1';
      slot.innerHTML = open ? '' : evalCardHtml(recs[id], { hideActions: true });
      slot.setAttribute('data-open', open ? '0' : '1');
      t.textContent = open ? '查看报告' : '收起报告';
      return;
    }
    if (act === 'promote') {
      t.disabled = true;
      try {
        var r = await fetch('/eval/promote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ evalId: id, from: t.getAttribute('data-eval-from') }) });
        var d = await r.json().catch(function () { return null; });
        if (d && d.existing) { location.href = '/edit?id=' + encodeURIComponent(d.existing); return; }
        if (!r.ok || !d || !d.ok || !d.id) { if (msg) __status(msg, 'err', (d && d.error) || ('HTTP ' + r.status)); t.disabled = false; return; }
        location.href = '/edit?id=' + encodeURIComponent(d.id);
      } catch (err) { if (msg) __status(msg, 'err', err.message); t.disabled = false; }
    }
  });
})();`;

// ===== 评估历史（/evals 页专用渲染函数；批 1 §0.3 起首页评估历史卡已撤除）=====
// 列表**只出元数据**（评分 / 结论 / 公司·岗位 / 时间 / 状态），不回显报告正文；
// 报告正文由 evalCardHtml 在客户端渲染（记录经 jsonScript 内联进页面，见 EVAL_RECORDS）。
const EVAL_VERDICT_TEXT = { apply: '建议投', caution: '谨慎', skip: '不建议' };
const EVAL_VERDICT_CLS = { apply: 'ok', caution: 'warn', skip: 'err' };
const evalTimeText = (s) => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN') : String(s || ''); };
// 内联载荷：JD 正文不进页面（可达 6 万字，报告渲染也用不到）；其余字段原样带出。
const evalRecordPayload = (rec) => { const r = { ...rec }; delete r.jd; delete r.jdFp; return r; };
const evalHistoryPayload = (records) => {
  const out = {};
  for (const rec of records) { const rid = String((rec && rec.id) || ''); if (rid) out[rid] = evalRecordPayload(rec); }
  return out;
};
// docExists（可选）= (docId) => boolean：调用方提供时，「已转适配」徽章在目标文档在盘时渲染为
// /edit 链接（F1）；目标缺失或未提供判定（历史调用方/纯渲染切片）维持纯徽章，不做链接承诺。
function evalHistoryRows(records, docExists) {
  if (!records.length) return '<div style="color:var(--mut);font-size:13px">还没有评估记录。到<a href="/job/new">「为岗位定制简历」</a>页点「先评估这个岗位」，评估结果会记在这里。</div>';
  return records.map((rec) => {
    const rid = String((rec && rec.id) || '');
    const v = String((rec && rec.verdict) || '');
    const cls = EVAL_VERDICT_CLS[v] || 'mute';
    const promoted = !!(rec && rec.promotedTo);
    const pid = promoted ? String(rec.promotedTo) : '';
    // sourceState ≠ recorded 的旧记录没有记录过母版 → 无从「转入适配」（from 取 rec.source.docId），按钮隐藏。
    const srcDoc = (rec && rec.source && rec.source.docId) ? String(rec.source.docId) : '';
    const canPromote = rec.sourceState === 'recorded' && !!srcDoc && !promoted;
    const promotedBadge = pid && typeof docExists === 'function' && docExists(pid)
      ? `<a href="/edit?id=${escAttr(pid)}">${badge('ok', '已转适配', 'circle-check')}</a>`
      : (pid ? badge('ok', '已转适配', 'circle-check') : '');
    const status = promotedBadge
      + (rec.sourceState !== 'recorded' ? badge('warn', '来源缺失', 'circle-alert') : '');
    // 动作列对齐：行容器 space-between 右对齐，按钮数不同的行会把「查看报告」挤到不同横坐标（实测两行左缘差 83px，扫读找不到同一列）。
    // 无「转入适配」的行放一枚同款隐形占位（visibility:hidden 保持同宽、disabled 且不带 data-eval-hist，
    // 不可点不可聚焦也不进测试断言口径）——动作组逐行等宽，「查看报告」在 /evals 页各行列对齐。
    const promoteBtn = canPromote
      ? `<button type="button" data-eval-hist="promote" data-eval-id="${escAttr(rid)}" data-eval-from="${escAttr(srcDoc)}">转入适配</button>`
      : `<button type="button" disabled style="visibility:hidden">转入适配</button>`;
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap">
      <span>${badge('ai', ((rec && rec.score) == null ? '—' : String(rec.score)) + ' / 5')}${badge(cls, EVAL_VERDICT_TEXT[v] || '未定')}<span style="color:var(--mut);font-size:12px">${escHtml(String((rec && rec.company) || '') + '·' + String((rec && rec.role) || ''))} · ${escHtml(evalTimeText(rec && rec.createdAt))}</span>${status}</span>
      <span style="display:flex;gap:6px;align-items:center"><button type="button" class="secondary" data-eval-hist="report" data-eval-id="${escAttr(rid)}">查看报告</button>${promoteBtn}</span>
    </div>
    <div id="evalSlot-${escAttr(rid)}" data-eval-slot="1"></div>`;
  }).join('');
}

function docInfo(id, m) {
  const f = docPath(id);
  if (!fs.existsSync(f)) return null;
  const content = fs.readFileSync(f, 'utf8');
  const stat = fs.statSync(f);
  return {
    id,
    title: escHtml((content.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || id),
    mtime: stat.mtime.toLocaleString('zh-CN'),   // 仅展示（陈旧判定一律走 renderInputId）
    mtimeMs: stat.mtimeMs,
    degraded: content.includes('以下为 PDF 提取的原文'),
    hash: contentHash(content),
    renderInputId: freezeHtml(applyDocTheme(content, m), m || {}).renderInputId   // S6-A1：与渲染输入同源（当前 HTML+当前 meta 的冻结标识，供 staleInfo）
  };
}

function listPage(showArchived = false) {
  const meta = loadMeta();
  const docs = docIdsOnDisk();
  const docInfoMap = new Map();
  for (const did of docs) docInfoMap.set(did, docInfo(did, meta[did]));
  // archived 独立标记（不混入 flow）：home 默认隐藏，?archived=1 切换显示（S1-T8）
  const isArchived = (did) => !!((meta[did] || {}).archivedAt);
  const infos = [...docInfoMap.values()].filter(Boolean).filter((d) => showArchived || !isArchived(d.id));
  const activeApps = loadApps().filter((a) => !APP_TERMINAL.includes(a.status)).length;
  const { active, profiles } = loadProfiles(root);
  const cfg = profiles[active];
  // 陈旧计数按 staleInfo（渲染标识），mtime 不参与；PDF 摘要单 chip 三态 = fresh/stale/none 计数
  const siState = (d) => staleInfo(meta[d.id] || {}, { renderInputId: d.renderInputId, pdfExists: fs.existsSync(pdfPath(d.id)) }).state;
  const degradedCount = infos.filter((d) => d.degraded).length;
  const pdfStates = infos.map(siState);
  const pdfFresh = pdfStates.filter((s) => s === 'fresh').length;
  const pdfStale = pdfStates.filter((s) => s === 'stale').length;
  const pdfNone = pdfStates.length - pdfFresh - pdfStale;
  const jobDocs = infos.filter((d) => meta[d.id] && (meta[d.id].parent || meta[d.id].job));
  // 母版 = 非岗位版文档（无 parent/job）。与 jobCard 空态（infos.length===0）刻意不同：
  // 只剩已投递岗位稿时「有母版」不成立——此时任务卡应指回「从零建简历」而非开一张选不到母版的定制表单。
  const hasMaster = infos.some((d) => { const m = meta[d.id] || {}; return !m.parent && !m.job; });
  const nowMs = Date.now();
  const upcoming = loadApps().filter((a) => {
    if (APP_TERMINAL.includes(a.status)) return false;
    const due = a.dueDate ? new Date(a.dueDate).getTime() : null;
    if (due && due - nowMs < 48 * 3600 * 1000) return true;   // 已逾期或 48h 内到期（逾期不清零）
    const ivs = Array.isArray(a.interviews) ? a.interviews : [];
    return ivs.some((iv) => { const t = iv.time ? new Date(iv.time).getTime() : null; return t && t - nowMs < 48 * 3600 * 1000; });
  });
  // 状态摘要：一行、按优先级排序（告警 > 时限 > 进行中 > 同步口径 > 配置）；PDF 单 chip 三态（§7.2，零项段省略）
  const pdfChip = infos.length === 0 ? ''
    : pdfFresh === infos.length ? icon('file-text', 12) + ' PDF 全部同步'
    : icon('file-text', 12) + ' PDF ' + [
      pdfFresh > 0 && `已同步 ${pdfFresh}`,
      pdfStale > 0 && `较旧 ${pdfStale}`,
      pdfNone > 0 && `未生成 ${pdfNone}`
    ].filter(Boolean).join(' · ');
  const todoBits = [
    { p: 1, t: degradedCount && icon('circle-alert', 12) + ` ${degradedCount} 份待结构化` },
    { p: 2, t: upcoming.length && `<a href="#upcomingAgenda" style="color:inherit">${icon('clock', 12)} ${upcoming.length} 份逾期/近期面试提醒</a>` },
    { p: 3, t: activeApps && icon('list-checks', 12) + ` ${activeApps} 份投递中` },
    { p: 4, t: pdfChip },
    { p: 5, t: cfg ? icon('bot', 12) + ` AI：${escHtml(cfg.name || '')}` : icon('bot', 12) + ' AI 未配置（岗位草稿仍可手动生成）' }
  ].filter((b) => b.t).sort((a, b) => a.p - b.p).map((b) => b.t);
  // F4 近期日程聚合视图：条目视图从已计算的 upcoming 即时展开（同一 48h 窗口判定，数据零新算、零新字段）。
  // 每条日程一行（同一投递的截止与多轮面试各自成行）：类型徽章 + 时间原样 + 公司·岗位 + 投递状态，
  // 整行 <a href="/app?id=…">（行内全为 span/文本，无交互元素，徽章合法嵌套）；纯时间升序 =
  // 已逾期（更早时间）自然排最前，行内标「已逾期」。upcoming 为空则整卡不渲染，不占版面。
  const agendaItems = [];
  for (const a of upcoming) {
    const due = a.dueDate ? new Date(a.dueDate).getTime() : null;
    if (due && due - nowMs < 48 * 3600 * 1000) agendaItems.push({ t: due, when: a.dueDate, app: a, kind: '截止', round: '' });
    const ivs = Array.isArray(a.interviews) ? a.interviews : [];
    ivs.forEach((iv, i) => {
      const t = iv.time ? new Date(iv.time).getTime() : null;
      if (t && t - nowMs < 48 * 3600 * 1000) agendaItems.push({ t, when: iv.time, app: a, kind: '面试', round: '·' + (iv.round || '第' + (i + 1) + '轮') });
    });
  }
  agendaItems.sort((x, y) => x.t - y.t);
  const agendaCard = agendaItems.length ? `<div class="card" id="upcomingAgenda" style="margin-top:12px"><b class="card-title">近期日程</b>
      ${agendaItems.map((it) => `<a href="/app?id=${escAttr(it.app.id)}" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--line);color:inherit;font-weight:400;font-size:13px">
        ${badge('', it.kind + escHtml(it.round))}${it.t < nowMs ? badge('warn', '已逾期') : ''}
        <span style="font-size:12px;color:var(--mut)">${escHtml(fmtWhen(it.when))}</span>
        <span>${escHtml(String(it.app.company || ''))}·${escHtml(String(it.app.role || ''))}</span>
        <span class="badge">${escHtml(statusLabel(String(it.app.status || '')))}</span>
      </a>`).join('')}
    </div>` : '';
  // 岗位状态徽章 = 全部派生（S1-T8）：已投递 ← applications.json（权威）；可投递 ← flow+冲突+stale 三条件；其余按 flow
  const allApps = loadApps();   // 投递表读一次（首页每张卡都要用）
  const jobStatusBadge = (id) => {
    const m = meta[id] || {};
    if (deliveredRefs(id, allApps).length) return badge('ai', '已记录投递', 'circle-check');
    const f = flowOf(m);
    if (f === 'reviewed') return deliverableNow(id, m, docInfoMap.get(id))
      ? badge('ok', '可投递')
      : badge('warn', '已审阅·PDF 未同步');
    return f === 'reviewing' ? badge('warn', '审阅中') : badge('warn', '草稿');
  };
  const cardHtml = (id) => {
    const m = meta[id] || {};
    const info = docInfoMap.get(id);
    if (!info) return '';
    const tag = m.tag || '';
    const snaps = fs.existsSync(snapDir(id)) ? fs.readdirSync(snapDir(id)).filter((s) => s.endsWith('.html')).length : 0;
    // 徽章三态 = staleInfo（渲染标识）：none 未生成｜stale 较旧｜fresh 同步（mtime 不参与判定）
    const si = staleInfo(m, { renderInputId: info.renderInputId, pdfExists: fs.existsSync(pdfPath(id)) });
    const pdfBadge = si.state === 'none' ? badge('warn', 'PDF 未生成')
      : si.state === 'stale' ? badge('warn', 'PDF 较旧')
      : badge('ok', 'PDF 同步');
    return `<li class="card doc-card"><b class="card-title">${info.title}</b>
      <div style="color:var(--mut);font-size:12px;margin:6px 0">${id} · 更新于 ${info.mtime}</div>
      <div style="margin-bottom:8px"><span class="badge">快照 ${snaps}</span>${pdfBadge}${m.job ? jobStatusBadge(id) : ''}${m.archivedAt ? badge('', '已归档', 'archive') : ''}${tag ? `<span class="badge">${escHtml(tag)}</span>` : ''}${info.degraded ? badge('warn', '待结构化') : ''}</div>
      ${m.parent ? `<div style="font-size:12px;color:var(--mut)">岗位版：${escHtml((m.company || '') + '·' + (m.role || ''))}（母版 ${escHtml(m.parent)}）</div>` : ''}
      <a href="/edit?id=${id}">继续编辑</a> ·
      <a href="/export?id=${id}">导出</a>
      <details class="more" style="display:inline"><summary style="display:inline;cursor:pointer;color:var(--mut)">⋯</summary>
      <div style="margin-top:4px;font-size:13px">
      <a href="/pdf?id=${id}" target="_blank">最新 PDF</a> ·
      <a href="/snapshots?id=${id}">历史版本</a> ·
      <a href="/diff?base=${id}">对比</a> ·
      ${m.parent ? `<a href="/diff?base=${escAttr(m.parent)}&to=${id}">对比母版</a> · ` : ''}
      ${info.degraded ? `<form method="post" action="/restructure?id=${id}" style="display:inline" data-action="confirmSubmit" data-msg="${escAttr('用 LLM 重新结构化这份文档？会先自动留快照')}"><button class="secondary">${icon('refresh-cw', 13)} 结构化</button></form> · ` : ''}
      <form method="post" action="/archive?id=${id}" style="display:inline" data-action="homeArchive" data-id="${escAttr(id)}"><button class="secondary">${m.archivedAt ? icon('archive', 13) + ' 取消归档' : icon('archive', 13) + ' 归档'}</button></form> ·
      <!-- tag 是任意文本（company·role 派生，不经 /tag 的 '" 清洗）：data-* 属性上下文 → escAttr；
           提交处理在下方脚本按 data-tag 原样读回（getAttribute 返回实体解码后的原文）。b5c1 前 tag 落在
           onsubmit 的 JS 单引号串里，须 JSON.stringify 后再转义——委托化后属性即原文，不再有 JS 串上下文。 -->
      <form method="post" action="/tag" style="display:inline" data-action="homeTag" data-id="${escAttr(id)}" data-tag="${escAttr(tag)}"><button class="secondary" aria-label="标签" title="标签">${icon('tag', 13)}</button></form> ·
      <form method="post" action="/duplicate?id=${id}" style="display:inline" data-action="homeDup" data-id="${escAttr(id)}"><button>复制</button></form> ·
      <form method="post" action="/delete?id=${id}" style="display:inline;margin-left:12px;padding-left:12px;border-left:1px solid var(--line)" data-action="confirmSubmit" data-msg="${escAttr('确认删除 ' + id + '？快照会保留')}"><button class="danger">删除</button></form>
      </div></details>
    </li>`;
  };
  const drafts = jobDocs
    .filter((d) => !deliveredRefs(d.id, allApps).length)   // 已投递 = 派生自 applications.json（权威来源），不再读存储状态
    .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 4);
  const byTag = new Map();
  for (const d of docInfoMap.keys()) {
    if (!showArchived && isArchived(d)) continue;   // archived 默认隐藏
    const key = (meta[d] && meta[d].tag) || '未标记';
    if (!byTag.has(key)) byTag.set(key, []);
    byTag.get(key).push(cardHtml(d));
  }
  const keys = [...byTag.keys()].sort((x, y) => (x === '未标记') - (y === '未标记') || x.localeCompare(y));
  const cards = keys.length === 1 && keys[0] === '未标记'
    ? byTag.get('未标记').join('\n')
    : keys.map((k) => `<li class="group-head">${escHtml(k)}</li>\n${byTag.get(k).join('\n')}`).join('\n');
  const doclistEmpty = cards.trim() === '';   // A4：无文档，或文档都在归档态被隐藏
  // 「继续上次任务」回退链数据源：最近 mtime 排序（浏览器端再按 localStorage['resume-last-active-doc'] 优先）
  const byMtime = [...infos].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const fallbackId = byMtime.length ? byMtime[0].id : '';
  const docIds = byMtime.map((d) => d.id);
  const docTitles = Object.fromEntries(byMtime.map((d) => [d.id, d.title]));
  // S4a-T5：重点 chips 建议值 = 素材 tags 聚合（首版不做历史 brief 聚合）
  const tagCount = new Map();
  for (const mt of loadMats()) for (const t of (Array.isArray(mt.tags) ? mt.tags : [])) if (typeof t === 'string' && t.trim()) tagCount.set(t.trim(), (tagCount.get(t.trim()) || 0) + 1);
  const tagChips = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([t]) => `<button type="button" class="chip" data-tag="${escAttr(t)}">${escHtml(t)}</button>`).join('');
  // 任务卡（2026-11-05 批 1 §0.2/§0.3）：hero 退役后的首屏主行动，三态由流水线状态派生——
  // ① 有进行中岗位草稿 → 「▶ 继续处理」+ deliverableNow 口径徽章摘要（与下方草稿卡同一函数同口径）；
  // ② 无母版（无非岗位版文档，归档同不计）→ 「＋ 从零建简历」（八步向导）；
  // ③ 有母版无草稿 → 「为岗位定制简历」直达独立页 /job/new（§0.3 拆页：表单整体迁移，/job/create 与 /eval/create 契约零变化）。
  // 次级行（有文档态）：「继续上次任务」回退链保持既有契约（id/data-* 与内联脚本零变化）；
  // 另保留「从零建简历」显式入口——S5 暂存续作契约要求有文档用户也能从首页重进向导（落地页渲染续作列表），
  // hero 退役后若无此入口，暂存过的从零建简历会话将不可达（test-onboarding-ui ③ 钉此动线）。
  const latestDraft = drafts[0] || null;
  const draftReady = latestDraft ? deliverableNow(latestDraft.id, meta[latestDraft.id] || {}, latestDraft) : false;
  const taskMain = latestDraft
    ? `<a class="cta" href="/edit?id=${escAttr(latestDraft.id)}">▶ 继续处理：${latestDraft.title}</a>`
      + badge(draftReady ? 'ok' : 'warn', draftReady ? '可投递' : '草稿')
      + `<span style="color:var(--mut);font-size:12px">${escHtml(((meta[latestDraft.id] || {}).company || '') + '·' + ((meta[latestDraft.id] || {}).role || ''))}</span>`
    : hasMaster
      ? `<a class="cta" href="/job/new">为岗位定制简历</a>`
      : `<a class="cta" href="/onboarding/guided" title="八步从零建简历：可跳过、可暂存续作，已有简历可预填补缺">＋ 从零建简历</a>`;
  return page('简历工作台', `
    <div class="card taskcard" id="taskCard">
      <div class="task-acts">${taskMain}</div>
      ${fallbackId
        ? `<div class="task-side"><a id="continueBtn" class="cta-alt" href="/edit?id=${encodeURIComponent(fallbackId)}" data-fallback="${escAttr(fallbackId)}" data-doc-ids='${jsonAttr(docIds)}' data-doc-titles='${jsonAttr(docTitles)}'>▶ 继续上次任务</a><a href="/onboarding/guided" title="八步从零建简历：可跳过、可暂存续作，已有简历可预填补缺">从零建简历</a></div>`
        : ''}
    </div>
    ${corruptBanner()}
    <h1>文档</h1>
    <div class="stat-grid">
      <div class="stat"><b>${infos.length}</b><span>文档</span></div>
      <div class="stat"><b>${degradedCount}</b><span>待结构化</span></div>
      <div class="stat"><b>${activeApps}</b><span>投递中</span></div>
      <!--R2①：待办提醒=真待办（待结构化+逾期与面试提醒）；投递中/PDF/AI 配置是状态行，只呈现在 statusline 不计入。-->
      <div class="stat"><b>${degradedCount + upcoming.length}</b><span>待办提醒</span></div>
    </div>
    <div class="searchrow">
      <input id="searchBox" placeholder="搜索文档（标题/id/标签）" aria-label="搜索文档">
      <button class="secondary" id="viewToggle">▤ 切换</button>
      <a class="secondary" style="border:1px solid var(--line);border-radius:var(--radius);padding:7px 12px;background:var(--panel);color:var(--ink);font-weight:600;font-size:13px" href="${showArchived ? '/' : '/?archived=1'}">${showArchived ? icon('archive', 13) + ' 隐藏已归档' : icon('archive', 13) + ' 显示已归档'}</a>
    </div>
    <ul class="doclist" id="doclist">${cards}${doclistEmpty ? (docInfoMap.size
      ? `<li class="list-empty">没有可显示的文档——可能都已归档。<a href="/?archived=1">查看已归档</a></li>`
      : `<li class="list-empty">还没有简历文档。点上方「从零建简历」开始，或 <a href="#up">上传 PDF 导入</a>。</li>`)
      : ''}<li class="search-empty" style="display:none">没有匹配「<span class="q"></span>」的文档。<button type="button" class="secondary" id="clearSearch">清除搜索</button></li></ul>
    ${drafts.length ? `<div class="card" style="margin-top:12px"><b class="card-title">继续处理岗位草稿</b>
      ${drafts.map((d) => { const dl = deliverableNow(d.id, meta[d.id] || {}, d);   // 每草稿只算一次：原写法在同一模板串里调两次，2N 次同步解析卡首屏
        return `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><span><b>${d.title}</b> ${badge(dl ? 'ok' : 'warn', dl ? '可投递' : '草稿')}<span style="color:var(--mut);font-size:12px">${escHtml(((meta[d.id] || {}).company || '') + '·' + ((meta[d.id] || {}).role || ''))} · ${d.mtime}</span></span><a href="/edit?id=${escAttr(d.id)}"><button>继续处理</button></a></div>`; }).join('')}
    </div>` : ''}
    <div class="card" style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <form method="post" action="/new"><button class="secondary">＋ 新建空白文档</button></form>
      <!-- 次级行入口按钮（批 1 §0.2/§0.3）：岗位定制表单已整体迁出 → /job/new，这里只留入口（非表单）。
           内边距按 §5.1 引用 token（原字面 7px→--space-2 = 8px，1px 差已登记于 DESIGN.md §5.1 可见差异）。
           注意：搜索行同类次级链接仍是字面 7px 12px，两者现已不同款——要恢复「同款」须两处同改（收口归后续卡）。 -->
      <a class="secondary" style="border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-2) var(--space-3);background:var(--panel);color:var(--ink);font-weight:600;font-size:13px" href="/job/new">${icon('target', 13)} 为岗位定制简历</a>
      <details class="import-box" style="flex:1;min-width:220px"><summary style="cursor:pointer;font-weight:700">${icon('file-text', 13)} 导入 PDF</summary>
        <form id="up" style="margin-top:8px">
          <input type="file" id="upfile" accept="application/pdf" aria-label="选择 PDF 文件">
          <button>导入</button><span id="upmsg" role="status"></span>
        </form>
      </details>
    </div>
    <div class="card statusline" role="status">${todoBits.join('<span class="sep">·</span>')}</div>
    ${agendaCard}
    <script nonce="__CSP_NONCE__">
      document.getElementById('up').addEventListener('submit', async function (e) {
        e.preventDefault();
        var f = document.getElementById('upfile').files[0];
        if (!f) return;
        document.getElementById('upmsg').textContent = ' 导入中（LLM 结构化需几十秒）…';
        var r = await fetch('/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        if (r.redirected) { location.href = r.url; return; }
        document.getElementById('upmsg').textContent = ' ' + (await r.text());
      });
      // 评估记录列表已整体迁出首页（批 1 §0.3：评估归 /evals）：本页不再内联评估记录载荷，
      // 也不再挂报告渲染器（EVAL_CARD_JS）与历史接线（EVAL_HISTORY_JS）——该列表的唯一落点是 /evals 页。
      document.getElementById('searchBox').addEventListener('input', function () {
        var q = this.value.toLowerCase();
        var any = false;   // A4：空态行（list-empty/search-empty）不参与过滤，否则关键词清空后无匹配行残留
        document.querySelectorAll('#doclist > li:not(.search-empty):not(.list-empty)').forEach(function (li) {
          var hit = !q || li.textContent.toLowerCase().includes(q);
          li.style.display = hit ? '' : 'none';
          if (hit) any = true;
        });
        var nm = document.querySelector('#doclist > li.search-empty');
        if (nm) {
          var show = q && !any;
          nm.style.display = show ? '' : 'none';
          if (show) nm.querySelector('.q').textContent = this.value;
        }
      });
      document.getElementById('clearSearch').addEventListener('click', function () {
        var sb = document.getElementById('searchBox'); sb.value = ''; sb.dispatchEvent(new Event('input'));
      });
      document.getElementById('viewToggle').onclick = function () {
        document.getElementById('doclist').classList.toggle('list-view');
      };
      document.addEventListener('click', function (e) {
        document.querySelectorAll('details.more[open]').forEach(function (d) {
          if (!d.contains(e.target)) d.removeAttribute('open');
        });
      });
      // 任务卡「为岗位定制简历」已改为直接链接 /job/new（拆页），无需展开脚本；本 IIFE 只剩 continueBtn 回退链。
      (function () {
        var btn = document.getElementById('continueBtn');
        if (!btn) return;                                    // 空库不渲染次级行，无此按钮
        // 解析必须非致命：属性损坏时抛出的 SyntaxError 会中断整段内联脚本（含 localStorage 陈旧键清理）。
        // 兜底 = 服务端已渲染好的 mtime 链接与原文案，故此处直接 return，不走下面的隐藏分支。
        // 修复轮1 起 jsonAttr() 已保证属性不可能被 ' 截断，本分支只是纵深防御，正常路径永不触发。
        var ids = null, titles = null;
        try { ids = JSON.parse(btn.getAttribute('data-doc-ids') || '[]'); } catch (e) { ids = null; }
        try { titles = JSON.parse(btn.getAttribute('data-doc-titles') || '{}'); } catch (e) { titles = null; }
        if (!Array.isArray(ids) || !titles || typeof titles !== 'object') return;
        var fb = btn.getAttribute('data-fallback') || '';
        var last = '';
        try { last = localStorage.getItem('resume-last-active-doc') || ''; } catch (e) { last = ''; }
        if (last && ids.indexOf(last) < 0) { try { localStorage.removeItem('resume-last-active-doc'); } catch (e) {} last = ''; }
        var pick = last || fb;
        if (!pick || ids.indexOf(pick) < 0) { btn.style.display = 'none'; return; }   // 不展示无效入口
        btn.href = '/edit?id=' + encodeURIComponent(pick);
        btn.textContent = (last ? '▶ 继续：' : '▶ 最近编辑：') + (titles[pick] || pick);
      })();
      // ===== 内联 handler 委托化注册（b5c1）：data-action → 实现（与原内联 onsubmit 行为一致）=====
      // 注册自足兜底：正常路径 head 分发段（page() 注入）先建 window.__acts 五桶，var 绑定的是同一对象；
      // 本脚本被单独抽取执行时（静态桩夹具 new Function 沙箱里 window 只是普通对象参数，对它赋值
      // 不产生全局绑定）或 b5c2 外置后顺序变化时，var + 兜底建桶保证注册可用，行为不分叉。
      var __acts = window.__acts || (window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} });
      // confirmSubmit 复用于结构化/删除（本页）与快照回滚（/snapshots）：返回 false ⇔ 取消原生提交。
      __acts.submit.confirmSubmit = function (el, ev) { return confirm(el.getAttribute('data-msg')); };
      __acts.submit.homeArchive = function (el, ev) {
        ev.preventDefault();
        __wv('/archive', { id: el.getAttribute('data-id') }).then(function () { location.reload(); }).catch(function () {});
      };
      __acts.submit.homeTag = function (el, ev) {
        ev.preventDefault();
        var t = prompt('标签（≤20字，留空清除）', el.getAttribute('data-tag'));
        if (t !== null) __wv('/tag', { id: el.getAttribute('data-id'), tag: t }).then(function () { location.reload(); }).catch(function () {});
      };
      __acts.submit.homeDup = function (el, ev) {
        ev.preventDefault();
        var t = prompt('新文档 id（小写字母数字横线）');
        if (t) { el.action = '/duplicate?id=' + el.getAttribute('data-id') + '&to=' + t; el.submit(); }
      };
    </script>`, 'docs');
}

// ===== /job/new「为岗位定制简历」（批 1 §0.3 拆页）=====
// 首页岗位表单整体迁移到此：字段 id/label/默认值/客户端校验/提交与评估接线自 listPage 原样迁入，
// POST /job/create 与 /eval/create 契约零变化（§0.3 裁决）。首页只留入口按钮（任务卡主行动 + 次级行按钮）。
// 不进 topnav（/evals 不占导航位；渐进呈现 T2 起导航收敛为 3 项：简历/投递/设置）；active 传 'docs'（由首页进入，归属「简历」高亮）。
// 页题右侧「评估历史 →」= /evals 入口（批 1 §0.3：首页评估历史卡撤除后，评估归 /evals；
// 评估在本页发起（先评估这个岗位），故入口落本页题右侧；入口不进导航）。
function jobNewPage() {
  const meta = loadMeta();
  // 母版下拉口径与拆出前 listPage infos 完全一致（在盘且未归档的全部文档，jobInfo 派生不筛选）。
  const infos = docIdsOnDisk().map((did) => docInfo(did, meta[did])).filter(Boolean).filter((d) => !((meta[d.id] || {}).archivedAt));
  // S4a-T5：重点 chips 建议值 = 素材 tags 聚合（与拆出前同一推导，零口径漂移）
  const tagCount = new Map();
  for (const mt of loadMats()) for (const t of (Array.isArray(mt.tags) ? mt.tags : [])) if (typeof t === 'string' && t.trim()) tagCount.set(t.trim(), (tagCount.get(t.trim()) || 0) + 1);
  const tagChips = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([t]) => `<button type="button" class="chip" data-tag="${escAttr(t)}">${escHtml(t)}</button>`).join('');
  return page('为岗位定制简历', `
    <div class="page-head"><h1>为岗位定制简历</h1><a href="/evals" style="font-size:13px;font-weight:400">评估历史 →</a></div>
    ${infos.length === 0 ? `<div class="card" style="border-style:dashed"><b>还没有母版简历</b>
        <p style="font-size:13px;color:var(--mut);margin:6px 0 10px">需要一份母版简历：先新建一份，或到<a href="/#up">首页上传 PDF 导入</a>，再回到这里为岗位定制可投递的两页版本。</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><form method="post" action="/new" style="display:inline"><button class="cta" type="submit">＋ 新建空白简历</button></form><a class="cta-alt" href="/#up">${icon('file-text', 13)} 上传 PDF 导入</a></div>
      </div>` : `<form id="jobForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;align-items:end">
        <label style="font-size:12px">公司<input id="jobCompany" required style="width:100%"></label>
        <label style="font-size:12px">岗位<input id="jobRole" required style="width:100%"></label>
        <label style="font-size:12px">母版简历<select id="jobFrom" style="width:100%">${infos.map((d) => `<option value="${escAttr(d.id)}">${d.title}（${d.id}）</option>`).join('')}</select></label>
        <label style="font-size:12px">JD 链接（可留空）<input id="jobLink" placeholder="https://…读取失败可改贴文本" style="width:100%"></label>
        <label style="font-size:12px;grid-column:1/-1">JD 文本（可留空，稍后补）<textarea id="jobJd" rows="3" style="width:100%"></textarea></label>
        <details style="grid-column:1/-1;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)">
          <summary style="cursor:pointer;padding:8px 12px;font-size:13px;font-weight:600">本次定制要求（可选，默认已按经验填好）</summary>
          <div style="padding:2px 12px 12px;display:grid;gap:6px">
            <label style="font-size:12px">预设<span style="display:flex;gap:6px;margin-top:3px">
              <select id="briefPresetSel" style="flex:1"><option value="">— 取回常用预设 —</option></select>
              <button type="button" class="secondary" id="briefPresetSave">存为常用预设</button>
              <button type="button" class="secondary" id="briefPresetDel">删除</button></span></label>
            <label style="font-size:12px">本次重点（点击选中/取消；建议来自素材标签）<span id="briefFocusChips" class="chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:3px">${tagChips}</span></label>
            <label style="font-size:12px">必须保留的项目（一行一个）<textarea id="briefKeep" rows="2" style="width:100%;margin-top:3px"></textarea></label>
            <label style="font-size:12px">不希望强调（一行一个）<textarea id="briefDeem" rows="2" style="width:100%;margin-top:3px"></textarea></label>
            <label style="font-size:12px">修改幅度<span id="briefDegree" style="display:flex;gap:6px;margin-top:3px">
              <button type="button" class="secondary" data-deg="light">轻度精简</button>
              <button type="button" class="secondary" data-deg="refocus" aria-pressed="true">重点调整</button>
              <button type="button" class="secondary" data-deg="restructure">重新组织</button></span></label>
            <label style="font-size:12px">页数目标<span id="briefPages" style="display:flex;gap:6px;margin-top:3px">
              <button type="button" class="secondary" data-pages="1">1 页</button>
              <button type="button" class="secondary" data-pages="2" aria-pressed="true">2 页（默认）</button></span></label>
          </div>
        </details>
        <div style="grid-column:1/-1"><button type="submit">生成岗位草稿</button><button type="button" class="secondary" id="evalBtn">${icon('compass', 13)} 先评估这个岗位</button><span id="jobMsg" role="status" style="font-size:12px;color:var(--mut)"></span><span id="evalMsg" role="status" style="font-size:12px;color:var(--mut)"></span></div>
      </form>
      <div id="evalResult"></div>`}
    <script nonce="__CSP_NONCE__">
      // 要求卡接线（自首页迁入，逻辑零变化）：chips 切换 / 幅度与页数段选 / 预设（localStorage，不进 meta）
      (function () {
        if (!document.getElementById('briefFocusChips')) return;   // 空态：无母版时不渲染岗位表单，预设逻辑一并跳过
        var lines = function (id) { return document.getElementById(id).value.split(/[\\n]+/).map(function (s) { return s.trim(); }).filter(Boolean); };
        document.getElementById('briefFocusChips').addEventListener('click', function (e) {
          var b = e.target.closest('.chip'); if (!b) return;
          b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
        });
        var segPick = function (spanId, attr) {
          document.getElementById(spanId).addEventListener('click', function (e) {
            var b = e.target.closest('button[data-' + attr + ']'); if (!b) return;
            this.querySelectorAll('button[data-' + attr + ']').forEach(function (x) { x.removeAttribute('aria-pressed'); });
            b.setAttribute('aria-pressed', 'true');
          });
        };
        segPick('briefDegree', 'deg'); segPick('briefPages', 'pages');
        var PRESET_KEY = 's4a-presets';
        var loadPresets = function () { try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}') || {}; } catch (e) { return {}; } };
        var savePresets = function (p) { try { localStorage.setItem(PRESET_KEY, JSON.stringify(p)); } catch (e) {} };
        var briefFromForm = function () {
          return { focus: Array.prototype.map.call(document.querySelectorAll('#briefFocusChips .chip[aria-pressed="true"]'), function (b) { return b.getAttribute('data-tag'); }),
            keepProjects: lines('briefKeep'), deemphasize: lines('briefDeem'),
            degree: (document.querySelector('#briefDegree button[aria-pressed="true"]') || {}).getAttribute ? document.querySelector('#briefDegree button[aria-pressed="true"]').getAttribute('data-deg') : 'refocus',
            pages: Number((document.querySelector('button[data-pages][aria-pressed="true"]') || {}).getAttribute ? document.querySelector('button[data-pages][aria-pressed="true"]').getAttribute('data-pages') : 2) || 2 };
        };
        var applyBrief = function (b) {
          if (!b) return;
          document.querySelectorAll('#briefFocusChips .chip').forEach(function (c) {
            c.setAttribute('aria-pressed', (b.focus || []).indexOf(c.getAttribute('data-tag')) >= 0 ? 'true' : 'false');
          });
          document.getElementById('briefKeep').value = (b.keepProjects || []).join('\\n');
          document.getElementById('briefDeem').value = (b.deemphasize || []).join('\\n');
          var deg = b.degree || 'refocus';
          document.querySelectorAll('#briefDegree button[data-deg]').forEach(function (x) {
            if (x.getAttribute('data-deg') === deg) x.setAttribute('aria-pressed', 'true'); else x.removeAttribute('aria-pressed');
          });
          var pg = String(b.pages || 2);
          document.querySelectorAll('button[data-pages]').forEach(function (x) {
            if (x.getAttribute('data-pages') === pg) x.setAttribute('aria-pressed', 'true'); else x.removeAttribute('aria-pressed');
          });
        };
        var refreshPresets = function () {
          var sel = document.getElementById('briefPresetSel'), p = loadPresets();
          sel.innerHTML = '<option value="">— 取回常用预设 —</option>' + Object.keys(p).map(function (k) {
            return '<option value="' + k.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '">' + k.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</option>';
          }).join('');
        };
        refreshPresets();
        document.getElementById('briefPresetSel').addEventListener('change', function () {
          var p = loadPresets()[this.value]; if (p) applyBrief(p.brief || p);
        });
        document.getElementById('briefPresetSave').addEventListener('click', function () {
          var name = prompt('预设名称', document.getElementById('jobRole').value.trim() || '常用岗位'); if (!name) return;
          var p = loadPresets(); p[name] = { brief: briefFromForm() }; savePresets(p); refreshPresets();
          var sel = document.getElementById('briefPresetSel'); sel.value = name;
        });
        document.getElementById('briefPresetDel').addEventListener('click', function () {
          var sel = document.getElementById('briefPresetSel'); if (!sel.value) return;
          var p = loadPresets(); delete p[sel.value]; savePresets(p); refreshPresets();
        });
      })();
      var jobFormEl = document.getElementById('jobForm');   // 空态：无母版时表单不渲染，绑定随之跳过（顶层不能 return，用 if 包裹）
      if (jobFormEl) jobFormEl.addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = document.getElementById('jobMsg');
        msg.textContent = ' 创建中…';
        try {
          var brief = { focus: Array.prototype.map.call(document.querySelectorAll('#briefFocusChips .chip[aria-pressed="true"]'), function (b) { return b.getAttribute('data-tag'); }),
            keepProjects: document.getElementById('briefKeep').value.split(/[\\n]+/).map(function (s) { return s.trim(); }).filter(Boolean),
            deemphasize: document.getElementById('briefDeem').value.split(/[\\n]+/).map(function (s) { return s.trim(); }).filter(Boolean),
            degree: (document.querySelector('#briefDegree button[aria-pressed="true"]') || document.querySelector('#briefDegree button[data-deg="refocus"]')).getAttribute('data-deg'),
            pages: Number(document.querySelector('button[data-pages][aria-pressed="true"]').getAttribute('data-pages')) || 2,
            preset: document.getElementById('briefPresetSel').value || null };
          var r = await fetch('/job/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: document.getElementById('jobFrom').value, company: document.getElementById('jobCompany').value.trim(),
              role: document.getElementById('jobRole').value.trim(), jd: document.getElementById('jobJd').value,
              jdLink: document.getElementById('jobLink').value.trim(), brief: brief }) });
          var d = await r.json().catch(function () { return null; });
          if (r.redirected) { location.href = r.url; return; }
          if (d && d.existing) { if (confirm('已存在同一母版+岗位的草稿（' + d.existing + '）。打开它？')) location.href = '/edit?id=' + d.existing; return; }
          if (d && d.ok && d.id) { location.href = '/edit?id=' + d.id; return; }
          var jobErr = (d && d.error) || (await r.text());
          if (jobErr.indexOf('invalid from') >= 0) jobErr = '请先选择母版简历';   // 兜底：服务端校验直出英文会让首用路径断链
          __status(msg, 'err', jobErr);
          if (jobErr.indexOf('未配置大模型') >= 0) msg.appendChild(Object.assign(document.createElement('a'), { href: '/settings', textContent: ' 去设置 →' }));   // A2：真实入口可点击
        } catch (err) { __status(msg, 'err', err.message); }
      });
      // ===== 岗位评估 UI（自首页迁入，逻辑零变化）：/eval/create → 报告卡片 → /eval/promote =====
      // 报告内容全部来自模型：渲染前逐字段转义（模型输出直接进 innerHTML = XSS）。
      ${EVAL_CARD_JS}
      (function () {
        var btn = document.getElementById('evalBtn');
        var box = document.getElementById('evalResult');
        var msg = document.getElementById('evalMsg');
        if (!btn || !box || !msg) return;
        var ctx = null;   // {id, from}：评估用哪个母版，转适配必须用同一个母版
        var run = async function () {
          var from = document.getElementById('jobFrom').value;
          var jd = document.getElementById('jobJd').value.trim();
          if (!jd) { __status(msg, 'err', 'JD 必填：评估需要岗位描述文本'); return; }
          btn.disabled = true;
          btn.textContent = '评估中，通常需要 1–5 分钟…';
          msg.textContent = '';
          box.innerHTML = '';
          try {
            var r = await fetch('/eval/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: from, company: document.getElementById('jobCompany').value.trim(), role: document.getElementById('jobRole').value.trim(), jd: jd }) });
            var d = await r.json().catch(function () { return null; });
            if (!r.ok || !d || !d.ok || !d.eval) { __status(msg, 'err', (d && d.error) || ('HTTP ' + r.status)); if (d && d.settingsPath) msg.appendChild(Object.assign(document.createElement('a'), { href: d.settingsPath, textContent: ' 去设置 →' })); return; }   // R2②：settingsPath → 可点击入口（同 :2210 先例）
            ctx = { id: d.eval.id, from: from };
            box.innerHTML = evalCardHtml(d.eval);
          } catch (err) { __status(msg, 'err', err.message); }
          finally { btn.disabled = false; btn.innerHTML = EVAL_BTN_ICON + ' 先评估这个岗位'; }
        };
        btn.addEventListener('click', run);
        // 事件委托：卡片会被重新渲染，监听器不能绑在会被替换的节点上
        box.addEventListener('click', async function (e) {
          var t = e.target.closest('[data-eval-act]');
          if (!t) return;
          if (t.getAttribute('data-eval-act') === 'redo') { run(); return; }
          if (!ctx) return;
          t.disabled = true;
          try {
            var r = await fetch('/eval/promote', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ evalId: t.getAttribute('data-eval-id'), from: ctx.from }) });
            var d = await r.json().catch(function () { return null; });
            if (d && d.existing) { location.href = '/edit?id=' + encodeURIComponent(d.existing); return; }
            if (!r.ok || !d || !d.ok || !d.id) { __status(msg, 'err', (d && d.error) || ('HTTP ' + r.status)); t.disabled = false; return; }
            location.href = '/edit?id=' + encodeURIComponent(d.id);
          } catch (err) { __status(msg, 'err', err.message); t.disabled = false; }
        });
      })();
    </script>`, 'docs');
}

// ===== 网申包页 /apply-profile（批 3 卡片 b3c2 · 计划 §4 批 3「网申包 + 跟进助手」）=====
// 通用信息表 + 按公司字段包同页；字段三态（跟随来源 / 手动覆写 / 恢复跟随）+ 独立维护；
// 单字段一键复制 + 整包导出（纯文本 / JSON）。
// 数据层口径（账本形状/三态/漂移/派生）见 apply-profile.mjs 与 DESIGN.md §10.10；本页口径见 §10.11。
// AI 文案字段（打招呼语/自荐信/跟进语）是批 3 卡片 b3c3 的增量：新增字段类型 + 生成区（进度/预览/确认）。
// 跟进助手、分享副本、投递记录关联字段包不在本卡（批 3 后续卡）。
const AP_STATE_LABEL = { follow: '跟随来源', drift: '来源已变', override: '手动覆写', manual: '独立维护', ai: 'AI 文案', ai_locked: '已锁定', ai_empty: '待生成' };
const AP_STATE_CLS = { follow: 'mute', drift: 'warn', override: '', manual: 'ai', ai: 'ai', ai_locked: 'warn', ai_empty: 'mute' };

// 请求体的 scope 归一 → 数据层 scope 对象（形状错即拒，不猜）。
// **两种形状都认**：字符串 'common'（旧调用方）与对象 {kind:'common'} / {kind:'package', id}（页面客户端发的形状）。
// 页面客户端发的是对象形态 —— 服务端只认字符串会让通用表整片写动作 400（2026-11-06 复核阻断项 ①）。
const apScopeOf = (s) => {
  if (s === 'common' || s === undefined || s === null || s === '') return { scope: { kind: 'common' }, err: '' };
  if (typeof s === 'object' && !Array.isArray(s)) {
    const kind = String(s.kind || '');
    if (kind === 'common') return { scope: { kind: 'common' }, err: '' };
    if (kind === 'package') {
      const id = String(s.id || '');
      if (!id) return { scope: null, err: '字段包 id 缺省' };
      return { scope: { kind: 'package', id }, err: '' };
    }
  }
  return { scope: null, err: '未知作用范围' };
};

// 字段行：标签 + 三态徽章 + 来源标注 + 值框 + 操作行（复制 / 手动改写|保存 / 恢复跟随）。
// 值框即复制源：所见即所复制（复制动作只取该行值框内容，不另取来源）。
// AI 文案字段（b3c3）走另一支：值框恒可编辑（手动改写 = 覆写并锁定），另加生成区。
function apFieldRow(scope, key, item, f, srcLabel, gen) {
  if (item.ai) return apAiFieldRow(scope, key, item, f, srcLabel, gen);
  const derived = !!item.derived;
  const state = derived ? String(f.state || 'follow') : 'manual';   // 独立字段永不派生 → 恒为独立维护
  const editable = state === 'override' || state === 'manual';
  const pkgAttr = scope.kind === 'package' ? ` data-pkg="${escAttr(scope.id)}"` : '';
  const cls = AP_STATE_CLS[state] || '';
  const badgeHtml = `<span class="badge${cls ? ' ' + cls : ''}">${escHtml(AP_STATE_LABEL[state] || state)}</span>`;
  const acts = [`<button type="button" class="secondary" data-ap="copy" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">复制</button>`];
  if (editable) {
    acts.push(`<button type="button" class="secondary" data-ap="save" data-mode="${state === 'manual' ? 'manual' : 'override'}" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">保存</button>`);
  } else {
    acts.push(`<button type="button" class="secondary" data-ap="edit" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">手动改写</button>`);
  }
  if (derived) acts.push(`<button type="button" class="secondary" data-ap="follow" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">恢复跟随</button>`);
  return `<div class="ap-row" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">
      <div class="ap-head"><span class="ap-label">${escHtml(item.label)}</span>${badgeHtml}<span class="ap-src">来源：${escHtml(srcLabel)}</span></div>
      <textarea class="ap-val" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}" rows="3"${editable ? '' : ' readonly'}>${escHtml(String(f.value == null ? '' : f.value))}</textarea>
      <div class="ap-acts">${acts.join('')}</div>
    </div>`;
}

// AI 文案字段行（b3c3）：标签 + 状态徽章 + 取材来源 + 值框（可编辑）+ 操作行（复制/保存/解锁/生成）
// + 生成区（状态行：阶段/失败原因/真实用量；待确认预览稿 + 确认入库 / 丢弃）。
// 生成区只报真实阶段（排队/调用模型/解析），**不给百分比**（诚实进度口径，与既有 genTasks 一致）。
function apAiFieldRow(scope, key, item, f, srcLabel, gen) {
  const g = gen || {};
  const pkgAttr = scope.kind === 'package' ? ` data-pkg="${escAttr(scope.id)}"` : '';
  const state = String(f.state || 'ai_empty');
  const locked = state === 'ai_locked';
  const cls = AP_STATE_CLS[state] || '';
  const badgeHtml = `<span class="badge${cls ? ' ' + cls : ''}">${escHtml(AP_STATE_LABEL[state] || state)}</span>`;
  const acts = [
    `<button type="button" class="secondary" data-ap="copy" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">复制</button>`,
    `<button type="button" class="secondary" data-ap="save" data-mode="override" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">保存</button>`,
  ];
  if (locked) acts.push(`<button type="button" class="secondary" data-ap="unlock" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">解锁</button>`);
  // 无模型 → 生成按钮禁用并写明原因（不做「点了才知道」的死路；降级口径见 apply-gen.mjs 的 NO_MODEL_HINT）
  acts.push(`<button type="button" class="secondary" data-ap="gen" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}"${g.noModel ? ' disabled' : ''}>生成</button>`);
  const task = g.task || null;
  const draft = g.draft || null;
  let statusText = '';
  if (g.noModel) statusText = '未配置大模型，不能生成（可手动填写）';
  else if (task && task.status === 'running') statusText = '生成中 · ' + stageLabel(task.stage);
  else if (task && task.status === 'error') statusText = String(task.error || '生成失败');
  else if (task && task.status === 'cancelled') statusText = '已取消';
  else if (task && task.status === 'done') statusText = '已生成，待确认入库';
  // 用量：取服务商真实返回；没返回（null）就显式说「服务商未返回」，不编 0（§10.12 诚实口径）。
  if (task && task.status === 'done') {
    statusText += ' · ' + (task.usage && typeof task.usage.total === 'number' ? '用量 ' + task.usage.total + ' tokens' : '用量：服务商未返回');
  }
  const cancelBtn = (task && task.status === 'running')
    ? `<button type="button" class="secondary" data-ap="gen-cancel" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}" data-task="${escAttr(String(task.taskId || ''))}">取消</button>`
    : '';
  const draftHtml = draft
    ? `<div class="ap-gen-draft" data-draft="${escAttr(String(draft.id || ''))}" data-draft-text="${escAttr(String(draft.text == null ? '' : draft.text))}">
        <textarea class="ap-gen-text" rows="4">${escHtml(String(draft.text == null ? '' : draft.text))}</textarea>
        <div class="ap-acts">
          <button type="button" data-ap="gen-confirm" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}" data-draft="${escAttr(String(draft.id || ''))}">确认入库</button>
          <button type="button" class="secondary" data-ap="gen-discard" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">丢弃</button>
        </div>
      </div>`
    : '';
  return `<div class="ap-row" data-ai="1" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}">
      <div class="ap-head"><span class="ap-label">${escHtml(item.label)}</span>${badgeHtml}<span class="ap-src">来源：${escHtml(srcLabel)}</span></div>
      <textarea class="ap-val" data-scope="${scope.kind}"${pkgAttr} data-key="${escAttr(key)}" rows="3">${escHtml(String(f.value == null ? '' : f.value))}</textarea>
      <div class="ap-acts">${acts.join('')}</div>
      <div class="ap-gen">
        <div class="ap-gen-status" role="status">${escHtml(statusText)}</div>
        ${cancelBtn ? `<div class="ap-acts">${cancelBtn}</div>` : ''}
        ${draftHtml}
      </div>
    </div>`;
}

// 导出文案（纯文本 = 复制用的一行一字段；空字段不进纯文本，页面里仍可见其状态；JSON 含全部字段与三态）。
function apExportText(view, pkgId) {
  const lines = [];
  let fields;
  if (pkgId) {
    const p = view.packages[pkgId];
    fields = p.fields;
    lines.push('公司：' + p.company);
    lines.push('岗位：' + p.role);
    if (p.note) lines.push('备注：' + p.note);
  } else {
    fields = view.common.fields;
  }
  for (const item of FIELD_CATALOG) {
    const f = fields[item.key];
    if (!f) continue;
    const v = String(f.value == null ? '' : f.value);
    if (!v.trim()) continue;
    lines.push(item.label + '：' + v);
  }
  return lines.join('\n') + '\n';
}

function apExportJson(view, pkgId) {
  const fields = pkgId ? view.packages[pkgId].fields : view.common.fields;
  const out = {
    version: 1,
    scope: pkgId ? 'package' : 'common',
    generatedAt: new Date().toISOString(),
    fields: {},
  };
  for (const item of FIELD_CATALOG) {
    const f = fields[item.key] || {};
    out.fields[item.key] = {
      label: item.label, derived: !!item.derived,
      mode: String(f.mode || 'follow'), state: String(f.state || 'follow'),
      value: String(f.value == null ? '' : f.value), drift: !!f.drift,
      source: (f.source && typeof f.source === 'object') ? f.source : null,
    };
    // AI 文案字段多一个锁定标记（手动改写后锁定 → 再生不覆盖）
    if (item.ai) out.fields[item.key].locked = !!f.locked;
  }
  if (pkgId) {
    const p = view.packages[pkgId];
    out.package = { id: pkgId, company: p.company, role: p.role, note: p.note };
  } else {
    out.common = { sourceDocId: view.common.sourceDocId };
  }
  return JSON.stringify(out, null, 2) + '\n';
}

function applyProfilePage() {
  const led = loadApplyProfilesView(root);
  const view = led.view;
  const raw = led.data;
  const meta = loadMeta();
  const infos = docIdsOnDisk().map((did) => docInfo(did, meta[did])).filter(Boolean).filter((d) => !((meta[d.id] || {}).archivedAt));
  // 文档标题取原文（docInfo.title 已转义，这里再转义会双重转义）→ 先建 id→原标题表。
  // docLabel 返回**原文**，转义只在渲染处做一次（apFieldRow 的 escHtml）。
  // 只对在盘文档建表（docIdsOnDisk 出来的文件名无路径分隔符），账本里的未知 docId 走纯 id 分支。
  const rawTitles = new Map();
  for (const d of infos) {
    let raw = d.id;
    try {
      const html = fs.readFileSync(path.join(root, 'docs', d.id + '.html'), 'utf8');
      raw = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || d.id;
    } catch { /* 读不到就用 id */ }
    rawTitles.set(d.id, raw);
  }
  const docLabel = (did) => {
    const id = String(did || '');
    if (!rawTitles.has(id)) return id;
    return `${rawTitles.get(id)}（${id}）`;
  };
  // 来源标注：通用表 = 母版简历；公司包 = 通用信息表 或 岗位简历（逐字段记来源，见 apply-profile.mjs）。
  const srcLabelOf = (scope, key, item) => {
    if (!item.derived) return '不从简历派生';   // 独立字段无来源（徽章已说「独立维护」，此处只说来源为何空）
    const holder = scope.kind === 'package' ? (raw.packages[scope.id] || { fields: {} }) : raw.common;
    const entry = (holder.fields || {})[key] || null;
    const src = entry && entry.source && typeof entry.source === 'object' ? entry.source : null;
    if (scope.kind === 'common') {
      // 通用表的逐字段来源不被读路径承认（DESIGN.md §10.10 已登记限制）→ 来源标注一律取通用表自己的母版。
      const did = raw.common.sourceDocId;
      return did ? `母版简历 · ${docLabel(did)}` : '未绑定母版';
    }
    const kind = src ? String(src.kind) : 'common';
    if (kind === 'resume') return `岗位简历 · ${docLabel(src.docId)}`;
    return '通用信息表';
  };
  // AI 文案字段（b3c3）：取材来源 = 该作用范围当前跟随的简历（通用表取母版；公司包取包级来源，否则通用表母版）。
  // 只标「取材于哪份简历」，不写模型名/规格等静态说明（§9.1-2/§9.1-3）。
  const noModel = !hasLLM(root);
  const srcDocCache = new Map();
  const srcDocOf = (scope) => {
    const ck = scope.kind === 'package' ? 'package:' + scope.id : 'common';
    if (srcDocCache.has(ck)) return srcDocCache.get(ck);
    let did = '';
    try { const s = copySource(root, scope); did = s && s.docId ? s.docId : ''; } catch { did = ''; }
    srcDocCache.set(ck, did);
    return did;
  };
  const aiSrcLabel = (scope) => {
    const did = srcDocOf(scope);
    return did ? `AI 生成 · 取材 ${docLabel(did)}` : 'AI 生成（还没有可取材的简历）';
  };
  const rowsOf = (scope, fields) => FIELD_CATALOG
    .map((item) => {
      const f = fields[item.key] || {};
      if (!item.ai) return apFieldRow(scope, item.key, item, f, srcLabelOf(scope, item.key, item));
      const tk = copyTaskKey(scope, item.key);
      const gen = {
        task: (view.tasks || {})[tk] || null,
        draft: (view.drafts || {})[tk] || null,
        noModel,
      };
      return apFieldRow(scope, item.key, item, f, aiSrcLabel(scope), gen);
    })
    .join('');

  const commonScope = { kind: 'common', id: '' };
  const commonGrid = rowsOf(commonScope, view.common.fields);

  const masterOptions = infos.map((d) => `<option value="${escAttr(d.id)}"${d.id === raw.common.sourceDocId ? ' selected' : ''}>${d.title}（${escAttr(d.id)}）</option>`).join('');
  const masterBar = infos.length
    ? `<div class="ap-bar"><label class="ap-src">母版来源<select id="apMaster">${masterOptions}</select></label><button type="button" class="secondary" id="apBind">绑定母版</button></div>`
    : `<div class="ap-bar"><span class="ap-note">还没有可绑定的母版简历</span></div>`;

  const pkgSections = Object.values(view.packages).map((p) => {
    const scope = { kind: 'package', id: p.id };
    const srcOpts = [`<option value="common"${p.sourceDocId ? '' : ' selected'}>通用信息表</option>`]
      .concat(infos.map((d) => `<option value="resume:${escAttr(d.id)}"${p.sourceDocId === d.id ? ' selected' : ''}>${d.title}（${escAttr(d.id)}）</option>`)).join('');
    return `<section class="ap-sec" id="apPkg-${escAttr(p.id)}">
      <div class="card">
        <b class="card-title">${escHtml(p.company || '（未填公司）')} · ${escHtml(p.role || '（未填岗位）')}</b>
        ${p.note ? `<div class="ap-bar"><span class="ap-note">网申地址备注：${escHtml(p.note)}</span></div>` : ''}
        <div class="ap-bar"><label class="ap-src">跟随来源<select data-ap-src="${escAttr(p.id)}">${srcOpts}</select></label><button type="button" class="secondary" data-ap="source" data-pkg="${escAttr(p.id)}">切换来源</button></div>
        <div class="ap-grid">${rowsOf(scope, p.fields)}</div>
        <div class="ap-bar">
          <a class="cta-alt" href="/apply/export?scope=package&amp;pkg=${encodeURIComponent(p.id)}&amp;format=text">导出纯文本</a>
          <a class="cta-alt" href="/apply/export?scope=package&amp;pkg=${encodeURIComponent(p.id)}&amp;format=json">导出 JSON</a>
          <span class="ap-note">导出的内容需自己粘贴到网申系统；本工具不代填、不发送</span>
        </div>
      </div>
    </section>`;
  }).join('');

  // ===== 分享副本（批 3 卡片 b3c5）：勾选隐藏字段 → 独立预览/PDF；记录可查被哪些投递引用 =====
  // 可隐藏字段 = 8 个从简历派生的字段（AI 文案/独立字段不在简历里，无从隐藏）；引用实时派生自投递记录。
  const apps4share = loadApps();
  const shareRows = Object.values(raw.shares || {})
    .sort((a, b) => String(b.id || '').localeCompare(String(a.id || '')))
    .map((s) => {
      const used = usedByShare(s.id, apps4share);
      const hiddenLabels = (Array.isArray(s.hidden) ? s.hidden : [])
        .map((k) => { const it = FIELD_CATALOG.find((f) => f.key === k); return it ? it.label : String(k); });
      const when = s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN') : String(s.id || '');
      return `<div class="ap-sh-row" data-share-id="${escAttr(s.id)}">
        <span class="ap-note">${escHtml(when)} · 文档 ${escHtml(docLabel(s.docId))} · 隐藏：${hiddenLabels.length ? escHtml(hiddenLabels.join('、')) : '（无）'} · 文本层 ${Number(s.chars) || 0} 字符 · 投递引用：${used.length ? escHtml(used.map((a) => String(a.company || '') + '·' + String(a.role || '')).join('、')) : '无'}</span>
        <a class="cta-alt" href="/share/pdf?id=${encodeURIComponent(String(s.id || ''))}">打开 PDF</a>
      </div>`;
    }).join('');
  const shareKeys = FIELD_CATALOG.filter((f) => f.derived)
    .map((f) => `<label class="ap-sh-key"><input type="checkbox" name="apShareHide" value="${escAttr(f.key)}">${escHtml(f.label)}</label>`).join('');
  const shareDocOptions = infos.map((d) => `<option value="${escAttr(d.id)}"${d.id === raw.common.sourceDocId ? ' selected' : ''}>${d.title}（${escAttr(d.id)}）</option>`).join('');
  const shareAppOptions = apps4share.map((a) => `<option value="${escAttr(a.id)}">${escHtml(String(a.company || '') + '·' + String(a.role || ''))}（${escAttr(a.id)}）</option>`).join('');
  const shareForm = infos.length
    ? `<form id="apShareForm" class="ap-bar">
        <label class="ap-src">来源简历<select id="apShareDoc">${shareDocOptions}</select></label>
        <label class="ap-src">关联投递<select id="apShareApp"><option value="">不关联</option>${shareAppOptions}</select></label>
        <div class="ap-sh-keys">${shareKeys}</div>
        <button type="submit">导出分享副本</button>
      </form>`
    : `<div class="ap-bar"><span class="ap-note">还没有可导出的简历</span></div>`;

  return page('网申包', `<div class="page-head"><h1>网申包</h1><span id="apMsg" role="status" class="ap-note"></span></div>${appTabs('apply')}
    ${led.corrupt ? `<div class="card" style="border-color:var(--err-soft);background:var(--err-soft);color:var(--err)"><b>${icon('circle-alert', 13)}数据文件损坏，已停止写入：</b>apply-profiles.json —— 请先人工修复或从备份恢复。</div>` : ''}
    <section class="ap-sec" id="apCommon">
      <div class="card">
        <b class="card-title">通用信息表</b>
        ${masterBar}
        <div class="ap-grid">${commonGrid}</div>
        <div class="ap-bar">
          <a class="cta-alt" href="/apply/export?scope=common&amp;format=text">导出纯文本</a>
          <a class="cta-alt" href="/apply/export?scope=common&amp;format=json">导出 JSON</a>
          <span class="ap-note">导出的内容需自己粘贴到网申系统；本工具不代填、不发送</span>
        </div>
      </div>
    </section>
    <section class="ap-sec" id="apPkgNew">
      <div class="card">
        <b class="card-title">新建字段包</b>
        <form id="apPkgForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:var(--space-2);align-items:end;margin-top:var(--space-3)">
          <label class="ap-src">公司<input id="apPkgCompany" required></label>
          <label class="ap-src">岗位<input id="apPkgRole"></label>
          <label class="ap-src">网申地址备注<input id="apPkgNote"></label>
          <button type="submit">新建字段包</button>
        </form>
      </div>
    </section>
    ${pkgSections}
    <section class="ap-sec" id="apShare">
      <div class="card">
        <b class="card-title">分享副本</b>
        ${shareForm}
        <div class="ap-sh-list" id="apShareList">${shareRows || '<div class="ap-note" style="margin-top:var(--space-3)">还没有分享副本（勾选要隐藏的字段并导出后，这里会列出每一份独立 PDF）</div>'}</div>
      </div>
    </section>
    <script nonce="__CSP_NONCE__">
    (function () {
      var msg = document.getElementById('apMsg');
      var post = function (url, body) {
        // __wv 已把失败原因写进 msg 元素（不 reload、不清空输入）；这里只吞掉拒绝，避免未处理拒绝刷控制台。
        return __wv(url, body, msg).then(function () { location.reload(); }).catch(function () {});
      };
      // 作用域与字段一律从**行容器**读（.ap-row 上带 data-scope / data-key / data-pkg）：
      // 「手动改写」是运行时动态创建的保存按钮，天然不带这些属性 —— 从按钮读会拿到 null
      // （2026-11-06 复核阻断项 ②）。行外按钮（如「切换来源」）不在 .ap-row 内，读自己。
      var scopeOf = function (host) {
        var pkg = host.getAttribute('data-pkg') || '';
        return pkg ? { kind: 'package', id: pkg } : { kind: 'common' };
      };
      // ===== AI 文案字段（b3c3）：生成 → 预览 → 确认才入库 =====
      // 状态行只报真实阶段（排队/调用模型/解析）与服务商真实用量，**不给百分比**（诚实进度口径）。
      var GEN_STAGE = { queued: '排队等待槽位', calling: '调用模型中', parsing: '解析校验中' };
      // api：写接口但**不 reload**（生成流程要在原地轮询到预览出现）。
      var api = function (url, body) {
        return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
          .then(function (r) {
            return r.text().then(function (t) {
              var d = null; try { d = JSON.parse(t); } catch (e) {}
              if (!r.ok || (d && d.ok === false)) {
                var e = new Error((d && d.error) || ('HTTP ' + r.status)); e.__failed = true; throw e;
              }
              return d || {};
            });
          });
      };
      var genStatus = function (row, text) {
        var el = row && row.querySelector('.ap-gen-status');
        if (el) el.textContent = text;
        if (msg) msg.textContent = text;
      };
      var usageText = function (u) {
        if (u && typeof u.total === 'number') return '用量 ' + u.total + ' tokens';
        return '用量：服务商未返回';
      };
      var scopeParam = function (scope, pkg) { return scope === 'package' ? ('package:' + pkg) : 'common'; };
      // 运行中「取消」：服务端只在**页面加载那一刻**已有 running 任务时渲染它；点「生成」后是客户端
      // 轮询才发现 running —— 这里补建（带 taskId），否则运行中就没有取消入口，只能刷新页面
      // （2026-11-06 复核阻断项）。任务结束/失败/取消后撤掉它。
      var showCancel = function (row, taskId) {
        var box = row && row.querySelector('.ap-gen');
        if (!box) return;
        var btn = box.querySelector('button[data-ap="gen-cancel"]');
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'secondary';
          btn.setAttribute('data-ap', 'gen-cancel');
          var wrap = document.createElement('div');
          wrap.className = 'ap-acts';
          wrap.appendChild(btn);
          var st = box.querySelector('.ap-gen-status');
          if (st && st.nextSibling) box.insertBefore(wrap, st.nextSibling);
          else box.appendChild(wrap);
        }
        btn.textContent = '取消';
        btn.setAttribute('data-scope', row.getAttribute('data-scope') || '');
        var pkg2 = row.getAttribute('data-pkg');
        if (pkg2) btn.setAttribute('data-pkg', pkg2); else btn.removeAttribute('data-pkg');
        btn.setAttribute('data-key', row.getAttribute('data-key') || '');
        btn.setAttribute('data-task', String(taskId || ''));
      };
      var hideCancel = function (row) {
        var box = row && row.querySelector('.ap-gen');
        var btn = box && box.querySelector('button[data-ap="gen-cancel"]');
        if (!btn) return;
        var w = btn.parentNode;
        if (w && w !== box && w.children.length === 1 && w.parentNode) w.parentNode.removeChild(w);
        else if (btn.parentNode) btn.parentNode.removeChild(btn);
      };
      // 预览稿：服务端渲染的那份已在 DOM 里（行内 .ap-gen-draft）；轮询到新稿时补建。
      // 文案与 draftId 必须同源：用户没改过预览 → 两样一起换成当前那份稿；
      // 用户改过预览 → 文案与 id 一起留在原那份（那份若已被新生成取代，确认会被服务端拒并提示重新确认，
      // 不静默拿别人的稿入库，也不静默改掉用户正在写的字）。
      var showDraft = function (row, draft) {
        var box = row.querySelector('.ap-gen-draft');
        if (!draft) {
          if (box) { box.setAttribute('hidden', ''); box.removeAttribute('data-draft'); }
          return;
        }
        if (!box) {
          box = document.createElement('div');
          box.className = 'ap-gen-draft';
          box.innerHTML = '<textarea class="ap-gen-text" rows="4"></textarea>'
            + '<div class="ap-acts"><button type="button" data-ap="gen-confirm">确认入库</button>'
            + '<button type="button" class="secondary" data-ap="gen-discard">丢弃</button></div>';
          row.appendChild(box);
        }
        box.removeAttribute('hidden');
        var ta = box.querySelector('textarea');
        var shown = box.getAttribute('data-draft-text') || '';
        if (ta && ta.value === shown) {
          ta.value = draft.text || '';
          box.setAttribute('data-draft', draft.id || '');
          box.setAttribute('data-draft-text', draft.text || '');
        }
      };
      var pollGen = function (row) {
        var scope = row.getAttribute('data-scope');
        var pkg = row.getAttribute('data-pkg') || '';
        var key = row.getAttribute('data-key');
        var tick = function () {
          fetch('/apply/copy/state?scope=' + encodeURIComponent(scopeParam(scope, pkg)) + '&key=' + encodeURIComponent(key))
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok) { genStatus(row, '状态读取失败'); return; }
              var t = d.task || {};
              if (t.status === 'running') {
                showCancel(row, t.taskId);
                genStatus(row, '生成中 · ' + (GEN_STAGE[t.stage] || '处理中'));
                setTimeout(tick, 700);
                return;
              }
              hideCancel(row);
              if (t.status === 'error') genStatus(row, t.error || '生成失败');
              else if (t.status === 'cancelled') genStatus(row, '已取消');
              else if (t.status === 'done') genStatus(row, '已生成，待确认入库 · ' + usageText(t.usage));
              showDraft(row, d.draft);
            })
            .catch(function () { genStatus(row, '状态读取失败：网络异常'); });
        };
        tick();
      };
      document.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-ap]');
        if (!b) return;
        var act = b.getAttribute('data-ap');
        var row = b.closest('.ap-row');
        var host = row || b;
        var scope = scopeOf(host);
        var key = (row || b).getAttribute('data-key') || '';
        if (act === 'copy') {
          var ta = row.querySelector('.ap-val');
          var text = ta.value;
          navigator.clipboard.writeText(text).then(function () {
            b.textContent = '已复制';
            setTimeout(function () { b.textContent = '复制'; }, 1200);
          }).catch(function () { if (msg) msg.textContent = '复制失败：浏览器未授权剪贴板，请手动选中值框内容复制'; });
          return;
        }
        if (act === 'edit') {
          var box = row.querySelector('.ap-val');
          box.removeAttribute('readonly');
          var save = document.createElement('button');
          save.type = 'button'; save.className = 'secondary';
          save.setAttribute('data-ap', 'save'); save.setAttribute('data-mode', 'override');
          save.textContent = '保存';
          b.replaceWith(save);
          box.focus();
          return;
        }
        if (act === 'save') {
          var val = row.querySelector('.ap-val').value;
          post('/apply/field', { scope: scope, key: key, mode: b.getAttribute('data-mode') || 'override', value: val });
          return;
        }
        if (act === 'follow') {
          post('/apply/field', { scope: scope, key: key, mode: 'follow' });
          return;
        }
        if (act === 'unlock') {
          // 解锁：把被手动改写锁住的 AI 文案交回 AI 接管（文案内容不动）
          post('/apply/field', { scope: scope, key: key, mode: 'ai' });
          return;
        }
        if (act === 'gen') {
          genStatus(row, '已发起生成…');
          api('/apply/copy/start', { scope: scope, key: key }).then(function () {
            pollGen(row);
          }).catch(function (e) { genStatus(row, (e && e.message) || '生成失败'); });
          return;
        }
        if (act === 'gen-cancel') {
          api('/apply/copy/cancel', { scope: scope, key: key, taskId: b.getAttribute('data-task') || '' }).then(function () {
            genStatus(row, '已取消');
          }).catch(function (e) { genStatus(row, (e && e.message) || '取消失败'); });
          return;
        }
        if (act === 'gen-confirm') {
          var box2 = row.querySelector('.ap-gen-draft');
          var ta2 = box2 ? box2.querySelector('textarea') : null;
          post('/apply/copy/confirm', {
            scope: scope, key: key,
            draftId: box2 ? (box2.getAttribute('data-draft') || '') : '',
            text: ta2 ? ta2.value : ''
          });
          return;
        }
        if (act === 'gen-discard') {
          post('/apply/copy/discard', { scope: scope, key: key });
          return;
        }
        if (act === 'source') {
          var sel = document.querySelector('select[data-ap-src="' + b.getAttribute('data-pkg') + '"]');
          var v = sel ? sel.value : 'common';
          post('/apply/source', { scope: scope, source: v.indexOf('resume:') === 0 ? { kind: 'resume', docId: v.slice(7) } : { kind: 'common' } });
          return;
        }
      });
      var bindBtn = document.getElementById('apBind');
      if (bindBtn) bindBtn.addEventListener('click', function () {
        var sel = document.getElementById('apMaster');
        if (!sel || !sel.value) return;
        post('/apply/bind', { docId: sel.value });
      });
      var form = document.getElementById('apPkgForm');
      if (form) form.addEventListener('submit', function (e) {
        e.preventDefault();
        var company = document.getElementById('apPkgCompany').value.trim();
        if (!company) { if (msg) msg.textContent = '公司必填'; return; }
        __wv('/apply/package', { company: company, role: document.getElementById('apPkgRole').value.trim(), note: document.getElementById('apPkgNote').value.trim() }, msg)
          .then(function () { location.reload(); }).catch(function () {});
      });
      // 分享副本导出（b3c5）：勾选隐藏字段 → POST /share/copy；有如实提醒（absent/关联失败）时先展示再刷新。
      var shareFormEl = document.getElementById('apShareForm');
      if (shareFormEl) shareFormEl.addEventListener('submit', function (e) {
        e.preventDefault();
        var keys = Array.prototype.map.call(shareFormEl.querySelectorAll('input[name="apShareHide"]:checked'), function (i) { return i.value; });
        var appId = document.getElementById('apShareApp').value;
        __wv('/share/copy', { docId: document.getElementById('apShareDoc').value, hidden: keys, appId: appId || undefined }, msg)
          .then(function (d) {
            var extra = (d && d.absent && d.absent.length) ? '原简历没有这些字段：' + d.absent.join('、') + '（未隐藏任何内容）' : '';
            if (d && d.warning) extra = extra ? extra + '；' + d.warning : d.warning;
            if (extra) { if (window.__status) { try { __status(msg, 'err', '已导出；' + extra); } catch (e2) {} } else if (msg) { msg.textContent = '已导出；' + extra; } }
            setTimeout(function () { location.reload(); }, extra ? 2600 : 0);
          })
          .catch(function () {});
      });
    })();
    </script>`, 'apps');
}

// 备份恢复/回退：把 docs-meta.json 整体替换为 target（成对语义），但一律经 updateMeta 逐文档写（不裸 copyFileSync 覆盖共享文件）。
// 本地存在而 target 无的文档条目 → 删除；target 的每个条目 → 写入。保证 html 与 meta 成对且不踩其他并发写。
function applyMetaSnapshot(target) {
  const t = (target && typeof target === 'object' && !Array.isArray(target)) ? target : {};
  const cur = loadMeta();
  for (const k of Object.keys(cur)) if (!Object.prototype.hasOwnProperty.call(t, k)) updateMeta(root, k, () => null);
  for (const k of Object.keys(t)) updateMeta(root, k, () => t[k]);
}
// 读备份包/回退点里的 docs-meta.json：缺失 → null（该备份不含 meta，既有语义）；
// 存在但不可解析或不是对象 → 显式抛 CORRUPT（500）。绝不退化成 {}：那等于删掉本地全部 meta 条目。
function readMetaSnapshotAt(f) {
  if (!fs.existsSync(f)) return null;
  const bad = (why) => Object.assign(new Error(`备份中的 docs-meta.json ${why}，已拒绝恢复（不覆盖本地 meta）`), { httpCode: 500, code: 'CORRUPT' });
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw bad('损坏'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('格式非法（应为对象）');
  // key 须过 VALID_ID：否则 applyMetaSnapshot 会把非法 id 写进 meta 表，此后所有基于 id 的路径拼接都不可信
  // （实测无原型污染——JSON.parse 的 "__proto__" 是自有属性，赋值退化为普通属性写——但数据完整性仍须守住）
  for (const k of Object.keys(parsed)) if (!VALID_ID.test(k)) throw bad(`含非法文档 id「${String(k).slice(0, 40)}」`);
  return parsed;
}

// ===== /save 剥离归一链（HTML 路径与 JSON 协议共用，抽出保持两路径字节同口径）=====
// 注释对剥离必须与 serve 注入对称（注入 `\nPAIR\n`、剥离归 ''）：save(serve(D)) === D 逐字节成立。
// 若剥离归 '\n'，每次保存净增 3 个换行（S2-T2 块 6c 冻结件不变性断言实测抓到的漂移），绝不可回改。
// 注入注释对的闭标记缺失时不做剥离（本来也剥不掉），且开标记出现多次时同样跳过：
// 两者都是 [\s\S]*? 的回溯放大形状——每个开标记起点都要扫到文末找闭标记，O(开标记数 × 正文长度)。
// 真实正文里每个注入对至多 1 个（server 幂等注入 + 保存即剥离），>2 个必是病态/攻击形状。
const INJECT_KINDS = ['AI', 'SHELL', 'JOB', 'ZONE', 'ICON'];
function stripInjectCommentPair(s, kind) {
  const open = '<!--' + kind + '-INJECT-->';
  const close = '<!--/' + kind + '-INJECT-->';
  let n = 0, i = s.indexOf(open);
  while (i !== -1) { if (++n > 2) return s; i = s.indexOf(open, i + open.length); }
  if (n === 0 || s.indexOf(close) === -1) return s;
  return s.replace(new RegExp('\\n?' + open + '[\\s\\S]*?' + close + '\\n?', 'g'), '');
}
function stripInjections(html) {
  let s = String(html);
  for (const kind of INJECT_KINDS) s = stripInjectCommentPair(s, kind);
  return s
    // 运行时面板样式（head 中，不在注释对里）也要剥离。
    // 属性扫描必须定量（[^>]{0,400}）而非 [^>]*：无界 [^>]* 在「目标属性名缺席 + 全文无 '>'」的正文上
    // 每个起点回扫到文末，O(<style 出现次数 × 正文长度) —— 实测 0.13MB body 卡死 8.2s，
    // 按 body 上限 10MB 外推可达数小时，且这些 replace 是同步的 → 整个事件循环冻结、全部端点不可用。
    // 400 字符远大于注入侧实际属性长度（data-ai-panel / data-ed-shell / class="zp-modal" 等），语义不变。
    .replace(/<style(?=[^>]{0,400}data-ai-panel)[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<style(?=[^>]{0,400}data-ed-shell)[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<style(?=[^>]{0,400}data-job-panel)[^>]*>[\s\S]*?<\/style>/g, '')
    // 区域面板运行时样式（data-zone-panel）与弹窗标记同款剥离，与注入对称
    .replace(/<style(?=[^>]{0,400}data-zone-panel)[^>]*>[\s\S]*?<\/style>/g, '')
    // 改绑弹窗挂 body 末尾（fixed 遮罩不受窄屏浮层祖先影响）；旧文档内联 doSave 预清理选择器无 data-zone-panel，服务端兜底剥整元素。
    // 双锚 class+data-zone-panel：面板创建恒先 className 后 setAttribute（序列化顺序确定），与全链按运行时标记锚定的纪律一致，防误删用户手写同形状 div
    .replace(/<div(?=[^>]{0,400}class="zp-modal"[^>]{0,400}data-zone-panel)[^>]*>[\s\S]*?<\/div>\s*<\/div>(?=\s*<\/body>)/g, '')
    // body class 归一化（S2-T5，设计 §6.2）：只删编辑器瞬态项，其余属性与内容原样保留。
    // ed-focus 是注入层加的聚焦态，旧文档 doSave 的内联清理选择器不认它 → 服务端兜底。
    // 幂等：无 class 的 <body> 原样返回；save(serve(D)) === D 的字节稳定性不受影响。
    .replace(/<body\b[^>]*>/g, (tag) => tag.replace(/\sclass="([^"]*)"/, (m, cls) => {
      const keep = String(cls).trim().split(/\s+/).filter((c) => c && !EDITOR_ONLY_BODY_CLASS.has(c));
      return keep.length ? ` class="${keep.join(' ')}"` : '';
    }));
}

// S4a 上线后修复2：保存入口最小结构校验（JSON 与旧 HTML 两路径共用）。
// 判据 = 剥离注入后至少含一个 HTML 元素标签——拒绝错误响应/纯文本/JSON 碎片等非文档载荷；
// 不用固定错误字符串或最低字数判断，兼容一切旧文档（含 S1 夹具的极简 body）。拒绝必须发生在快照与写入之前。
const DOC_PAYLOAD_RE = /<[a-zA-Z][^>]*>/;
const looksLikeDoc = (html) => DOC_PAYLOAD_RE.test(String(html ?? ''));

// ===== 区域请求的版本基线（ZONE-03）=====
// 区域分析/改写读的是磁盘正文：客户端必须带「它已确认的那一版正文」的 mtime，
// 否则它可能基于旧内容生成建议，再把旧候选写回新正文。
function zoneRequestError(id, body) {
  if (!fs.existsSync(docPath(id))) return { status: 404, code: 'DOC_NOT_FOUND', error: '文档不存在' };
  if (typeof body.baseMtime !== 'number' || !Number.isFinite(body.baseMtime) || body.baseMtime <= 0) {
    return { status: 400, code: 'INVALID_REQUEST', error: 'baseMtime 必填（区域请求必须绑定已确认的正文版本）' };
  }
  if (body.baseMtime !== fs.statSync(docPath(id)).mtimeMs) {
    return { status: 409, code: 'STALE_DOCUMENT', error: '文档已变化，请先同步内容再生成区域建议' };
  }
  return null;
}

// ===== S4a-T3：JSON 保存协议（设计 §4.2 v1.6，复审批定顺序：全部校验通过前零写入）=====
// ① 请求指纹 = 转换前原始请求体的规范化序列化 sha1（键序无关；重试方重发原文即同指纹；
//    "转换"指 html 剥离归一——指纹绝不受其影响）→ ② saveReceipts 判重（同 requestId 同内容 → 只回执零重写；
// 不同内容 → 400）→ ③ baseRev 严格相等（落后/未来均 409，错误信息区分两种情况；JSON 路径不携带 baseMtime）
// → ④ ops 逐条校验（对服务器当前正文；任一失败整份 400，正文不保存）→ 四步全过才 ⑤ 旧版快照 + beginTx
// 单事务：剥离归一 → 正文 atomicWrite → zoneSync → applyOps → rev+1 → saveReceipts 环形 ≤50 → commitTx。
// 恢复顺序沿用既有（事务异常：旧正文 + 旧 meta 副本双恢复，机制不改）。旧 HTML 路径不经此函数，行为零改动。
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

async function saveJsonProtocol(req, id, url) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw); } catch { return { status: 400, body: { ok: false, error: 'bad JSON body' } }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, body: { ok: false, error: '请求体必须是 {requestId, baseRev, html, ops} 对象' } };
  if (typeof body.requestId !== 'string' || !body.requestId.trim() || body.requestId.length > 128)
    return { status: 400, body: { ok: false, error: 'requestId 必填（非空字符串 ≤128 字符）' } };
  if (typeof body.html !== 'string') return { status: 400, body: { ok: false, error: 'html 必填（整页字符串）' } };
  if (!Array.isArray(body.ops)) body.ops = [];
  if (typeof body.baseRev !== 'number' || !Number.isInteger(body.baseRev) || body.baseRev < 0)
    return { status: 400, body: { ok: false, error: 'baseRev 必须是非负整数（客户端所见的 meta.rev）' } };
  // 区域保存（ZONE-04）：一次保存只走一条通道（zoneOps 与岗位 ops 互斥）；且必须绑定已确认的正文版本
  const isZoneSave = Object.hasOwn(body, 'zoneOps');
  if (isZoneSave) {
    if (!Array.isArray(body.zoneOps) || !body.zoneOps.length)
      return { status: 400, body: { ok: false, error: 'zoneOps 必须是非空数组' } };
    if (body.ops.length)
      return { status: 400, body: { ok: false, error: 'zoneOps 与 ops 不能混用（一次保存只走一条通道）' } };
    if (typeof body.baseMtime !== 'number' || !Number.isFinite(body.baseMtime) || body.baseMtime <= 0)
      return { status: 400, body: { ok: false, error: 'baseMtime 必填（区域保存必须绑定已确认的正文版本）' } };
  }
  if (!fs.existsSync(docPath(id))) return { status: 404, body: { ok: false, error: 'doc not found' } };
  const reqHash = createHash('sha1').update(canonicalJson(body)).digest('hex');
  try { rootLock.acquire(root); }
  catch (e) { if (e instanceof LockHeld) return { status: 503, body: { ok: false, error: '另一保存/迁移正在进行（.migrate.lock），请稍后重试' } }; throw e; }
  let out;
  try {
    out = await withDocLock(root, id, async () => {
      const oldMeta = loadMeta()[id] ?? null;
      const job = (oldMeta && oldMeta.job) ? oldMeta.job : null;
      // ② 判重先于 baseRev：同 ID 同内容 → 只返回已存回执，任何文件、版本、快照零重写（事务不写）；
      //    接受成功→撤回成功→旧接受重试走这里：正文与状态保持撤回后版本（baseRev 已落后是双保险，非依赖）。
      const receipts = isZoneSave
        ? (Array.isArray(oldMeta && oldMeta.zoneSaveReceipts) ? oldMeta.zoneSaveReceipts : [])
        : ((job && Array.isArray(job.saveReceipts)) ? job.saveReceipts : []);
      const hit = receipts.find((r) => r && r.requestId === body.requestId);
      if (hit) {
        if (hit.contentHash === reqHash) return { status: 200, body: { ok: true, deduped: true, ...hit.receipt } };
        return { status: 400, body: { ok: false, error: '重复 requestId 但请求内容不同：同 ID 必须重发完全相同的内容' } };
      }
      // ③ 严格基线
      // baseMtime 存在时以它为准：它是「本地正文所基于的磁盘版本」的精确信号。
      //   baseRev 会被本地自动保存推进而显得落后，不能拿它判断「有没有别人动过正文」；
      //   取服务器最新 rev 给旧整页背书，会把另一标签页的改动整页覆盖掉
      //   （实测：另一页把 P2 改成 OTHER-NEW，旧页接受 P1 后带最新 rev 提交，P2 回到 OTHER-OLD）。
      // 没有 baseMtime 的旧客户端仍走 baseRev 严格相等（既有语义不变）。
      const curRev = Number(oldMeta && oldMeta.rev) || 0;
      const baseMtime = Number(body.baseMtime || 0);
      if (baseMtime > 0) {
        const curM = fs.existsSync(docPath(id)) ? fs.statSync(docPath(id)).mtimeMs : 0;
        if (Math.abs(curM - baseMtime) > 2) {
          return { status: 409, body: { ok: false, conflict: true, mtime: curM, error: '磁盘上的文档已被其他窗口更新（请求基线 ' + baseMtime + '，当前 ' + curM + '）：请载入最新版本后重试' } };
        }
      } else if (body.baseRev !== curRev) {
        return { status: 409, body: { ok: false, conflict: true, rev: curRev, error: body.baseRev < curRev
          ? `baseRev 落后（请求 ${body.baseRev}，当前 ${curRev}）：正文已被其他保存更新，请载入最新版本后重试`
          : `baseRev 来自未来（请求 ${body.baseRev}，当前 ${curRev}）：客户端版本状态异常，请刷新页面` } };
      }
      // ④ 全量校验（任一失败整份 400，正文不保存——快照与事务尚未开启）
      const strippedRaw = stripInjections(body.html);
      const stripped = normalizeZids(strippedRaw);
      if (!stripped.trim()) return { status: 400, body: { ok: false, error: 'empty save rejected' } };
      if (!looksLikeDoc(stripped)) return { status: 400, body: { ok: false, error: '非文档载荷：剥离后不含任何 HTML 元素，已拒绝（正文、meta、rev、快照均未变化）' } };
      const oldHtml = fs.readFileSync(docPath(id), 'utf8');
      let zoneResult = null, pre = { ok: true, applied: [] };
      if (isZoneSave) {
        // 区域安全子集（ZONE-04）：磁盘正文、提交原文、归属、锁定、事实护栏 五项齐备才应用。
        // ① 磁盘正文必须仍是我们确认过的那一版（baseMtime 严格比对；不自动取新 rev 重放）
        const curM = fs.statSync(docPath(id)).mtimeMs;
        if (Math.abs(curM - body.baseMtime) > 2) {
          return { status: 409, body: { ok: false, code: 'STALE_DOCUMENT', error: '文档已变化（请求基线 ' + body.baseMtime + '，当前 ' + curM + '），请刷新后重试' } };
        }
        // ② 归一化前检查目标唯一性（防 normalizeZids 把重复目标悄悄改名）
        try {
          const seen = new Set();
          for (const u2 of zoneEditUnits(strippedRaw)) {
            if (seen.has(u2.zid)) return { status: 400, body: { ok: false, error: '正文存在重复 zid：' + u2.zid + '（整份拒绝）' } };
            seen.add(u2.zid);
          }
        } catch (e) { return { status: 400, body: { ok: false, error: '正文形状非法，整份拒绝：' + (e.message || e) } }; }
        // ③ 计算安全子集（不猜落点、不重打 ID）
        try {
          zoneResult = applyZoneOps({ diskHtml: oldHtml, html: strippedRaw, zones: (oldMeta && oldMeta.zones) || {}, zoneOps: body.zoneOps });
        } catch (e) {
          return { status: 400, body: { ok: false, error: '区域操作校验失败，整份拒绝（正文未保存）：' + (e.message || e) } };
        }
        // ④ 零安全目标 → 不写（正文/meta/快照/版本全部零变化）
        if (!zoneResult.applied.length) {
          return { status: 409, body: { ok: false, code: 'NO_APPLICABLE_CANDIDATES', error: '没有可安全应用的目标（正文、meta、快照与版本均未变化）', skipped: zoneResult.skipped } };
        }
      } else {
        if (body.ops.length && !job) return { status: 400, body: { ok: false, error: '该文档不是岗位草稿（无 changes 可操作）' } };
        // hide 接受要求目标段落在正文（删除式隐藏会被 anchor-gone 拒）——T4+ UI 必须属性式实现 hide（加隐藏标记类，不删节点）。
        pre = applyOps(body.ops, job, oldHtml, { zones: (oldMeta && oldMeta.zones) || {} });
        if (!pre.ok) return { status: 400, body: { ok: false, badOp: pre.badOp, reason: pre.reason, error: '操作校验失败，整份拒绝（正文未保存）：' + pre.reason } };
      }
      // ⑤ 四步全过 → 旧版快照（既有手动快照）+ beginTx 写入
      const autosave = !!url.searchParams.get('autosave');
      // 区域分支：正文来自安全子集结果（只转义一次、保留目标开闭标签）
      const norm = normalizeToCurrent(zoneResult ? zoneResult.html : stripped);
      const newHtml = norm.html, newTypo = norm.typo;
      const oldSnapTs = autosave ? '' : snapshot(id);
      const txId = beginTx(root, id, 'save', oldSnapTs);
      let receipt = null;
      try {
        atomicWrite(docPath(id), newHtml);              // rename #1：正文
        const gapMs = Number(process.env.RESUME_TEST_SAVE_GAP_MS || 0);
        if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));   // 测试钩子：模拟两次 rename 之间被杀
        const prevHash = contentHash(oldHtml), newHash = contentHash(newHtml);
        updateMeta(root, id, (m) => {                   // rename #2：meta（读最新→只 patch 本文档→原子写）
          const base = { ...(m || {}) };
          base.typo = newTypo;
          base.rev = (Number(base.rev) || 0) + 1;
          // 改稿使「可投递」失效（既有口径，与 HTML 路径一致）
          if (prevHash && prevHash !== newHash && flowOf(base) === 'reviewed') {
            base.flow = 'draft';
            if (base.job) base.job = { ...base.job, invalidatedAt: new Date().toISOString() };
          }
          Object.assign(base, zoneSync(newHtml, base));
          if (zoneResult) {
            // 区域回执（ZONE-04）：文档级 zoneSaveReceipts 环形 ≤50；母版不因区域保存出现 job
            const zoneReceipt = {
              requestId: body.requestId, mtime: fs.statSync(docPath(id)).mtimeMs, hash: contentHash(newHtml),
              rev: base.rev, applied: zoneResult.applied, skipped: zoneResult.skipped
            };
            base.zoneSaveReceipts = [...(Array.isArray(base.zoneSaveReceipts) ? base.zoneSaveReceipts : []),
              { requestId: body.requestId, contentHash: reqHash, receipt: zoneReceipt }].slice(-50);
            receipt = zoneReceipt;
          } else if (base.job) {
            // 审阅状态与正文同事务（v1.6）：applyOps 在锁内新鲜 meta 上复核（④已过，兜底极小并发窗口；
            // 失败抛错走既有双恢复）；reviewConsistency 正文维度逐条写 consistency（zoneSync 之后、同一事务）；
            // saveReceipts 环形 ≤50 记进 meta.job。非 job 文档（母版）不记回执——meta.job 是岗位草稿子树，
            // 不为其造壳（kindOf 会把带 job 的母版误判成岗位草稿）。
            const re = applyOps(body.ops, base.job, oldHtml, { zones: base.zones || {} });
            if (!re.ok) throw new Error('操作校验失败（并发状态变化，已整份回滚）：' + re.reason);
            base.job = reviewConsistency(re.job, newHtml, { zones: base.zones, mats: loadMats() });
            const rec = {
              requestId: body.requestId, contentHash: reqHash,
              // 回执带上 requestId：客户端要能校验「这条回执确实属于本次提交」
              receipt: { requestId: body.requestId, mtime: fs.statSync(docPath(id)).mtimeMs, hash: newHash, rev: base.rev, appliedOps: pre.applied.map((a) => a.operationId) }
            };
            base.job.saveReceipts = [...(Array.isArray(base.job.saveReceipts) ? base.job.saveReceipts : []), rec].slice(-50);
            receipt = rec.receipt;
          }
          return base;
        });
        commitTx(root, txId);                           // 成功：删事务记录
      } catch (e2) {
        // 任一异常：用旧正文 + 旧 meta 副本恢复两者，再抛（外层映射状态码）——与 HTML 路径同机制。
        let htmlBack = false, metaBack = false;
        try { atomicWrite(docPath(id), oldHtml); htmlBack = true; } catch {}
        try { updateMeta(root, id, () => oldMeta); metaBack = true; } catch {}
        if (htmlBack && metaBack) { try { commitTx(root, txId); } catch {} }
        throw e2;
      }
      // 本次保存成功 → 同文档更早的未完成记录已被取代（留着会在下次启动恢复时回滚掉这次成功保存）
      try {
        const stale = dropSupersededTx(root, id);
        if (stale) console.error(`[tx] 同文档过期事务记录已清理 ${stale} 条：${id}`);
      } catch {}
      const st = fs.statSync(docPath(id));
      const savedRid = freezeHtml(newHtml, { typo: newTypo }).renderInputId;
      const saveSi = staleInfo(loadMeta()[id] || {}, { renderInputId: savedRid, pdfExists: fs.existsSync(pdfPath(id)) });
      const newRev = (Number(oldMeta && oldMeta.rev) || 0) + 1;
      if (!receipt) receipt = { mtime: st.mtimeMs, hash: contentHash(newHtml), rev: newRev, appliedOps: [] };   // 非 job 文档：回执只在本次响应，不落盘判重
      return { status: 200, body: { ok: true, mtime: st.mtimeMs, hash: contentHash(newHtml), pdfStale: saveSi.stale, rev: newRev, receipt } };
    });
  } catch (e) {
    if (e instanceof LockHeld) return { status: 409, body: { ok: false, retry: true, error: '该文档正在被另一保存/回滚/复制处理，请稍后重试' } };
    throw e;
  } finally {
    try { rootLock.release(root); } catch {}
  }
  return out;
}

// ===== S5 从零建简历向导（设计：dev-docs/2026-11-02-s5-design.md；S5U 前端卡定稿步序）=====
// 核心决策：向导进度不新建文件 —— 首个「合并预填后仍有内容」的确认步创建一份真实草稿文档
// （kind=master / flow=draft，与 /new 产出同权），此后每步确认写入该文档；暂存 = 文档自然存在。
// 「空输入不产出脏文档」由「首步确认前不建文档」保证；无文档阶段的进度由客户端持有。
// S5U 步序定稿（八步）：基本信息→摘要→经历（STAR）→项目→技能→教育→照片（可选，S5F 前留位）→预览完成。
// 与设计文档 §1 表（roadmap 初版八步）的差异：STAR 并入经历步（0.3）、项目/技能/教育各自成步、
// 预览微调并入 0.8（复用编辑器链接）。API 对旧步号保持兼容：0.6 载荷带 photo 照样收（照片处理不限步）。
const OB_STEPS = ['0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8'];
const OB_LABELS = { '0.1': '基本信息', '0.2': '摘要', '0.3': '经历（STAR）', '0.4': '项目', '0.5': '技能', '0.6': '教育', '0.7': '照片（可选）', '0.8': '预览完成' };
const OB_COPY = {
  '0.1': '先留下名字和联系方式，简历的骨架就有了',
  '0.2': '用几句话说清你是谁、想去哪里',
  '0.3': '一段经历一张卡，逐条套 STAR，也可以先跳过',
  '0.4': '项目单独摆出来，写法和经历一样',
  '0.5': '会什么就写什么，一行一条',
  '0.6': '学校、专业与时间，一段一张卡',
  '0.7': '证件照完全可选，不选也不影响后续',
  '0.8': '预览与微调复用编辑器，完成后与手建文档完全同权'
};
// 每步右侧说明（左栏插画+情绪文案之下的操作说明）
const OB_HINT = {
  '0.1': '联系方式与求职意向都可以留空，之后随时回编辑器补',
  '0.2': '摘要放在简历最显眼的位置，写不好可以先跳过',
  '0.3': '要点可逐条套 STAR（情境/任务/行动/结果，允许只填部分或跳过），也可用「AI 套 STAR」生成建议——建议只回填卡片，确认提交后才写入；事实层（事实/条件/个人贡献/来源）如实记录并标注来源，表达层可后补',
  '0.4': '项目卡片与经历同款：名称、角色、时间加要点',
  '0.5': '技能按行拆分，每行一条',
  '0.6': '教育经历按段录入，最新的在前更好',
  '0.7': '照片会存入本地数据目录（photos/，已排除 Git）；模板照片位待模板库（S6）提供。完全可选，可直接跳过。',
  '0.8': '点「打开编辑器」可预览微调（复用编辑器）；确认完成后走既有导出链路。全程未填内容也会产出一份合法空白文档。'
};
// 内容步 → 目标区域标题（写档 splice 与预填提取共用同一映射；header 由 0.1 专写）
const OB_TITLES = { '0.2': [['summary', '个人总结']], '0.3': [['work', '工作经历']], '0.4': [['projects', '项目经历']], '0.5': [['skills', '专业技能']], '0.6': [['edu', '教育经历']] };
// 「原始内联」约定与模板占位符一致：个人总结=纯文本、专业技能=<p> 行、其余=entry HTML。
// splice 落档时再套区域外壳；创建路径直接填占位符（模板自带外壳）。
const OB_SECTION_WRAP = {
  '个人总结': (t) => `<p class="summary">${t}</p>`,
  '专业技能': (t) => `<div class="plain-lines">${t}</div>`
};
const OB_PHOTO_MAX = 5 * 1024 * 1024;
const OB_PHOTO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const OB_PAGE_SVG = svgAsset('hero-page.svg');

// ===== 0.8 选模板（批 1 §0.3：完成步「选一套模板」= 每主题一张卡 = 主题名 + 场景短语 + 真渲染缩略图 + 选中态；
//       批 5 第 2 项起四主题）=====
// 场景短语是短标签（通用 / 经历多一页排满 / 展示向 / 单栏装更多），非受众长句（DESIGN.md §9.1-3 边界内）。
// 缩略图 = /theme-preview 同装配 srcdoc 内嵌（端点带 frame-ancestors 'none' 不可被嵌；与编辑器模板页签同思路），
// 装配走单一实现 themePreviewHtml()（DESIGN.md §10.1）→ 卡内嵌内容与 GET /theme-preview 响应体逐字节相等。
const OB_THEME_CARDS = [
  { theme: 'classic', name: '经典单栏', scene: '通用' },
  { theme: 'compact', name: '紧凑单栏', scene: '单栏装更多' },
  { theme: 'dual', name: '双栏紧凑', scene: '经历多一页排满' },
  { theme: 'magazine', name: '杂志展示', scene: '展示向' }
];
// 空白文档装配（0.8 建档与 0.8 缩略图共用同一份内容口径；DOC_ID 只进脚本，脚本在预览里被剥除）
function obBlankDocHtml(docId) {
  return assembleTemplate('classic')
    .replaceAll('{{NAME}}', () => '未命名').replaceAll('{{CONTACT}}', () => '').replaceAll('{{INTENT}}', () => '')
    .replaceAll('{{SUMMARY}}', () => '点击开始编辑…').replaceAll('{{SKILLS}}', () => '<p>技能…</p>')
    .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => '').replaceAll('{{EDU}}', () => '')
    .replaceAll('{{DOC_ID}}', () => docId);
}
// 缩略图源：已有文档用文档正文；无文档会话（全程跳过）用空白模板装配（0.8 收口即建这份文档）
function obPreviewSourceHtml(docId) {
  if (docId && fs.existsSync(docPath(docId))) return fs.readFileSync(docPath(docId), 'utf8');
  return obBlankDocHtml('doc');
}
// 模板卡区（选中态 = radio，classic 默认可跳过；卡片标签承载主题名与场景短语）
function obThemeCardsHtml(docId) {
  const avail = listThemes();
  const src = obPreviewSourceHtml(docId);
  const cards = OB_THEME_CARDS.filter((c) => avail.includes(c.theme)).map((c) => {
    const preview = themePreviewHtml(src, c.theme);
    const checked = c.theme === 'classic' ? ' checked' : '';
    return `<label class="ob-tcard" data-theme="${escAttr(c.theme)}">`
      + `<span class="ob-thead"><input type="radio" name="theme" value="${escAttr(c.theme)}"${checked}>`
      + `<span class="ob-tname">${escHtml(c.name)}</span><span class="ob-scene">${escHtml(c.scene)}</span></span>`
      + `<span class="ob-tthumb"><iframe title="${escAttr(c.name)} 模板预览" srcdoc="${escAttr(preview)}" tabindex="-1"></iframe></span>`
      + `</label>`;
  }).join('');
  if (!cards) return '';
  return `<div class="ob-tpick"><div class="ob-done-title">选一套模板</div><div class="ob-tcards">${cards}</div></div>`;
}

const obLinesHtml = (v) => String(v ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  .map((s) => `<p>${escHtml(s)}</p>`).join('');
// entry → HTML。STAR（0.3 经历步，逐条可跳过）：填了的部分按「情境/任务/行动/结果」行并入要点（表达层）；
// 事实层不进正文（表达层可后补的原则），由 obMergeStep 收集暂存到 meta.onboarding.facts。
const OB_STAR_LINES = [['s', '情境'], ['t', '任务'], ['a', '行动'], ['r', '结果']];
const obEntriesHtml = (list) => (Array.isArray(list) ? list : []).filter((e) => e && typeof e === 'object').map((e) => {
  const star = e.star && typeof e.star === 'object' ? e.star : null;
  const starPts = star ? OB_STAR_LINES.filter(([k]) => String(star[k] ?? '').trim()).map(([k, label]) => `${label}：${String(star[k]).trim()}`) : [];
  const pts = [...starPts, ...(Array.isArray(e.points) ? e.points : []).map((x) => String(x ?? '').trim()).filter(Boolean)];
  return `<div class="entry-head"><div class="entry-title">${escHtml(String(e.title ?? '').trim())}</div>` +
    `<div class="entry-role">${escHtml(String(e.role ?? '').trim())}</div>` +
    `<div class="entry-date">${escHtml(String(e.date ?? '').trim())}</div></div>` +
    (pts.length ? `<ul>${pts.map((p) => `<li>${escHtml(p)}</li>`).join('')}</ul>` : '');
}).join('\n');
// 页壳表单（零 JS）的行式简表：`名称 | 职位 | 时间` 起段，`- ` 行进要点（确认卡片流由前端卡承接）
function obParseEntriesText(text) {
  const entries = [];
  let cur = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-•]\s*/.test(line)) {
      const pt = line.replace(/^[-•]\s*/, '').trim();
      if (pt && cur) cur.points.push(pt);
      continue;
    }
    if (cur) entries.push(cur);
    const seg = line.split('|').map((s) => s.trim());
    cur = { title: seg[0] || '', role: seg[1] || '', date: seg[2] || '', points: [] };
  }
  if (cur) entries.push(cur);
  return entries;
}
// 按区域标题替换 section 内联（sectionsOf 定位 + bodyOf 偏移换算绝对位置）；区域缺失 → null（不写，进度照走）
function obReplaceSection(html, title, rawInner) {
  const body = bodyOf(html);
  const off = html.indexOf(body);
  if (off < 0) return null;
  const sec = sectionsOf(html).find((s) => s.title === title && !s.hidden);
  if (!sec) return null;
  const tm = /<div[^>]*class="[^"]*\bsection-title\b[^"]*"[^>]*>[\s\S]*?<\/div>/i.exec(sec.html);
  const titleHtml = tm ? tm[0] : `<div class="section-title">${escHtml(title)}</div>`;
  const wrap = OB_SECTION_WRAP[title] || ((t) => t);
  const rebuilt = `<section class="section">${titleHtml}\n      ${wrap(rawInner)}\n    </section>`;
  return html.slice(0, off + sec.start) + rebuilt + html.slice(off + sec.end);
}
const obHeaderHtml = (h) =>
  `<header class="header"><h1>${escHtml(h.name || '')}</h1><div class="contact">${escHtml(h.contact || '')}<br />${escHtml(h.intent || '')}</div></header>`;
function obReplaceHeader(html, headerHtml) {
  if (!/<header class="header">[\s\S]*?<\/header>/.test(html)) return null;
  return html.replace(/<header class="header">[\s\S]*?<\/header>/, () => headerHtml);   // 函数替换防 $& 解释
}
// 预填提取（纯确定性，零 AI 零外联）：stripInjections 后按 h1 / .contact / sectionsOf 取文本结构。
// 信任边界与 /duplicate 同级（不剥正文脚本，/edit CSP 兜底）；摘除 data-zid —— 新文档由 normalizeZids 重打，不携带母版区域绑定。
function obExtractPrefill(srcHtml) {
  const html = stripInjections(String(srcHtml || ''));
  const out = { name: '', contact: '', intent: '', sections: {} };
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) out.name = decodeEntities(h1[1].replace(/<[^>]*>/g, '')).trim();
  const ct = /<div[^>]*class="[^"]*\bcontact\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (ct) {
    const lines = ct[1].split(/<br\s*\/?>/i).map((s) => decodeEntities(s.replace(/<[^>]*>/g, '')).trim());
    out.contact = lines[0] || '';
    out.intent = lines[1] || '';
  }
  for (const s of sectionsOf(html)) {
    if (s.hidden || !s.title) continue;
    const tm = /<div[^>]*class="[^"]*\bsection-title\b[^"]*"[^>]*>[\s\S]*?<\/div>/i.exec(s.html);
    let inner = s.html.slice(tm ? tm[0].length : 0).replace(/<\/section>\s*$/i, '').trim();
    inner = inner.replace(/\s*data-zid="[^"]*"/g, '');
    if (!inner) continue;
    if (s.title === '个人总结') {
      const pm = /<p[^>]*class="[^"]*\bsummary\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(inner);
      if (pm) inner = pm[1].trim();
    } else if (s.title === '专业技能') {
      const dm = /^<div[^>]*class="[^"]*\bplain-lines\b[^"]*"[^>]*>([\s\S]*)<\/div>$/i.exec(inner);
      if (dm) inner = dm[1].trim();
    }
    if (inner) out.sections[s.title] = inner;
  }
  return out;
}
// 合并本步载荷与预填：payload 非空字段胜出，空缺位由母版填充（只补缺失），prefilled 如实登记。
// 返回 {header?, sections{标题→原始内联}, facts?, prefilled[], hasContent}
function obMergeStep(step, p, prefill, skipFlag) {
  const res = { header: null, sections: {}, facts: null, prefilled: [], hasContent: false };
  if (skipFlag) return res;
  const own = (f) => String(p[f] ?? '').trim();
  const pick = (f) => {
    const v = own(f);
    if (v) return v;
    const pv = prefill ? String(prefill[f] ?? '').trim() : '';
    if (pv) { res.prefilled.push(f); return pv; }
    return '';
  };
  if (step === '0.1') {
    const name = pick('name'), contact = pick('contact'), intent = pick('intent');
    if (name || contact || intent) { res.header = { name, contact, intent }; res.hasContent = true; }
  } else if (OB_TITLES[step]) {
    for (const [field, title] of OB_TITLES[step]) {
      let inner = '';
      if (field === 'summary') inner = escHtml(pick('summary'));
      else if (field === 'skills') inner = obLinesHtml(p.skills);
      else {
        const list = Array.isArray(p[field]) ? p[field] : null;
        inner = list ? obEntriesHtml(list) : '';
      }
      if (!inner && prefill && prefill.sections[title]) { inner = prefill.sections[title]; res.prefilled.push(field); }
      if (inner) { res.sections[title] = inner; res.hasContent = true; }
    }
  }
  // 事实层（roadmap：{事实、条件、个人贡献、来源}）任意内容步可录，逐条带 subject/source，
  // 只暂存到 meta.onboarding.facts（表达层可后补；与素材库合并属后续卡）
  const rawFacts = Array.isArray(p.facts) ? p.facts
    : (Array.isArray(p.work) ? p.work.filter((e) => e && e.facts && typeof e.facts === 'object')
      .map((e) => ({ subject: e.title, ...e.facts })) : []);
  if (rawFacts.length) {
    res.facts = rawFacts.filter((f) => f && typeof f === 'object')
      .map((f) => ({
        subject: String(f.subject ?? '').slice(0, 200), fact: String(f.fact ?? '').slice(0, 2000),
        condition: String(f.condition ?? '').slice(0, 2000), contribution: String(f.contribution ?? '').slice(0, 2000),
        source: String(f.source ?? '').slice(0, 200)
      }))
      .filter((f) => f.fact || f.condition || f.contribution || f.source)
      .slice(0, 50);
    if (res.facts.length) res.hasContent = true;
  }
  // 照片载荷不限步收取（UI 走 0.7 照片步；有文档才承载，无文档由路由层 400）
  if (p.photo) res.hasContent = true;
  return res;
}
// ===== S5F ①：STAR AI 整理（0.3 经历步的建议卡；roadmap 原文的「0.4 STAR 结构化」在本步序为 0.3）=====
// 确认门控=结构性：建议只从本端点出、只能经 POST /onboarding/step（用户确认后的载荷）落正文，
// 本端点绝不写文档。prompt 显式约束只整理用户事实、不补造；解析侧再做结构性守卫（未知 index 丢弃、空字段丢弃、长度截断）。
const OB_STAR_KEYS = ['s', 't', 'a', 'r'];
const obStarPrompt = (entries) => {
  const lines = entries.map((e, i) => `第${i + 1}段 名称：${e.title || '（未填）'}\n原文要点：${e.points.join('；') || '（未填）'}`);
  return {
    sys: '你是简历写作助手，只做语句整理，不做事实创作。',
    user: `请对下面每段经历的原文逐条套 STAR 结构（s=情境 t=任务 a=行动 r=结果）。\n硬性约束：\n1. 只允许整理用户给出的原文，不得补造任何经历、公司、时间、数字或结果；\n2. 每个字段只能是原文语句的改写（可拆分、可精简用词），没有原文依据的字段一律输出空字符串；\n3. 只输出 JSON，不要任何解释与前后缀，格式：{"entries":[{"index":1,"star":{"s":"","t":"","a":"","r":""}}]}，index 从 1 起，对应下面第几段。\n\n经历原文：\n${lines.join('\n')}`
  };
};
function parseObStarSuggestions(text, count) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));   // 容错：截取首个大括号区间（自然语前缀不致命）
  if (!m) return [];
  let d = null;
  try { d = JSON.parse(m[0]); } catch { return []; }
  const arr = Array.isArray(d && d.entries) ? d.entries : [];
  const out = [];
  for (const it of arr) {
    const idx = Number(it && it.index);
    if (!Number.isInteger(idx) || idx < 1 || idx > count) continue;   // 未知/越界 index 丢弃（不产新条目）
    const st = it.star && typeof it.star === 'object' ? it.star : {};
    const star = {};
    for (const k of OB_STAR_KEYS) {
      const v = String(st[k] ?? '').trim().slice(0, 300);
      if (v) star[k] = v;   // 空字段丢弃 = 模型没依据就不给建议
    }
    if (Object.keys(star).length) out.push({ index: idx - 1, star });
  }
  return out.slice(0, 20);
}
// 建档（与 /new 同款分配与登记；差异仅：内容由向导组装 + onboarding 进度与区域初绑同事务落 meta）
const obNewDocId = () => { let i = 0, newId; do { newId = i === 0 ? 'doc' : 'doc-' + i; i++; } while (fs.existsSync(docPath(newId))); return newId; };
function obCreateDoc(newId, newHtml, onboardingRec, themeName) {
  fs.writeFileSync(docPath(newId), newHtml);
  updateMeta(root, newId, (m) => {
    const base = { ...(m || {}), ...themeRegistration('classic'), ...(themeName ? { theme: themeName } : {}), kind: 'master', flow: 'draft', archivedAt: null, onboarding: onboardingRec };
    Object.assign(base, zoneSync(newHtml, base));
    return base;
  });
  return newId;
}
// 每步写档 = /save 语义的最小复刻（同原语不打折）：stripInjections → normalizeZids → normalizeToCurrent
// → 根锁 + 文档锁 → beginTx/atomicWrite/updateMeta/commitTx（异常双恢复）→ dropSupersededTx。
// updateMeta 内 rev+1 + zoneSync（区域初绑/同步）。不打快照（同 autosave 口径，避免步进刷爆配额）。
// onboardingRec 与正文同事务落 meta（内容与进度原子一致）。
async function obWriteDoc(id, rawHtml, onboardingRec, themeName) {
  let html = stripInjections(rawHtml);
  html = normalizeZids(html);
  if (!looksLikeDoc(html)) return { status: 400, body: { ok: false, error: '向导写入被拒：载荷剥离后不含任何 HTML 元素' } };
  const norm = normalizeToCurrent(html);
  let out;
  try { rootLock.acquire(root); }
  catch (e) { if (e instanceof LockHeld) return { status: 503, body: { ok: false, error: '另一保存/迁移正在进行（.migrate.lock），请稍后重试' } }; throw e; }
  try {
    out = await withDocLock(root, id, async () => {
      const oldHtml = fs.readFileSync(docPath(id), 'utf8');
      const oldMeta = loadMeta()[id] ?? null;
      const txId = beginTx(root, id, 'save', '');
      try {
        atomicWrite(docPath(id), norm.html);
        updateMeta(root, id, (m) => {
          const base = { ...(m || {}) };
          base.typo = norm.typo;
          base.rev = (Number(base.rev) || 0) + 1;
          Object.assign(base, zoneSync(norm.html, base));   // S3：zones 同步（正文为准）
          base.onboarding = onboardingRec;
          if (themeName) base.theme = themeName;             // 0.8 选模板：与进度同事务落 meta
          return base;
        });
        commitTx(root, txId);
      } catch (e2) {
        // 与 /save 同机制：任一异常用旧正文 + 旧 meta 双恢复，再抛
        let htmlBack = false, metaBack = false;
        try { atomicWrite(docPath(id), oldHtml); htmlBack = true; } catch {}
        try { updateMeta(root, id, () => oldMeta); metaBack = true; } catch {}
        if (htmlBack && metaBack) { try { commitTx(root, txId); } catch {} }
        throw e2;
      }
      try {
        const stale = dropSupersededTx(root, id);
        if (stale) console.error(`[tx] 同文档过期事务记录已清理 ${stale} 条：${id}（onboarding）`);
      } catch {}
      return { status: 200, body: { ok: true } };
    });
  } catch (e) {
    if (e instanceof LockHeld) return { status: 409, body: { ok: false, retry: true, error: '该文档正在被另一保存/回滚/复制处理，请稍后重试' } };
    throw e;
  } finally {
    try { rootLock.release(root); } catch {}
  }
  return out;
}
// 未完成的从零建简历文档清单（暂存退出 → 重进恢复的入口）：meta.onboarding 存在且未 finished
function obUnfinishedList() {
  const meta = loadMeta();
  const items = [];
  for (const [oid, m] of Object.entries(meta)) {
    if (!m || !m.onboarding || typeof m.onboarding !== 'object' || m.onboarding.finished) continue;
    if (!VALID_ID.test(oid) || !fs.existsSync(docPath(oid))) continue;
    let title = oid;
    try {
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(fs.readFileSync(docPath(oid), 'utf8'));
      if (h1) title = decodeEntities(h1[1].replace(/<[^>]*>/g, '')).trim() || oid;
    } catch {}
    const nxt = (m.onboarding.next && OB_LABELS[m.onboarding.next]) || m.onboarding.next || '0.1';
    items.push(`<a class="ob-resume-item" href="/onboarding?docId=${escAttr(oid)}"><b>${escHtml(title)}</b><span>进行到 ${escHtml(nxt)}</span></a>`);
  }
  return items.length ? `<div class="ob-card ob-resume"><div class="ob-done-title">继续从零建简历</div><p class="ob-note">以下是暂存的从零建简历，点开从上次的步骤继续</p>${items.join('')}</div>` : '';
}
// 条目卡（0.3 经历 / 0.4 项目 / 0.6 教育）：一块散料一张卡，各带编辑；kindLabel 驱动 STAR/事实层子表单。
// canAi = 已有文档承载时才渲染「AI 套 STAR」建议按钮（S5F：建议只进卡片输入框，确认提交后才写入）。
function obEntryCard(kindLabel, canAi) {
  const starFacts = kindLabel === '经历' ? `
      <details class="ob-sub"><summary>STAR 结构化（可选，逐条套用，可跳过）</summary>
        <div class="ob-erow">
          <label>情境<input data-k="s" placeholder="在什么背景下"></label>
          <label>任务<input data-k="t" placeholder="负责什么"></label>
          <label>行动<input data-k="a" placeholder="做了什么"></label>
          <label>结果<input data-k="r" placeholder="带来什么结果"></label>
        </div>
        ${canAi ? `<button type="button" class="ob-ai" data-ob-ai>AI 套 STAR（只产建议，确认提交后才写入）</button>` : ''}
      </details>
      <details class="ob-sub"><summary>事实层（可选：事实 / 条件 / 个人贡献 / 来源；表达可后补）</summary>
        <div class="ob-erow">
          <label>事实<input data-k="fact"></label>
          <label>条件<input data-k="condition"></label>
          <label>个人贡献<input data-k="contribution"></label>
          <label>来源<input data-k="source" placeholder="来源标注（如：本人自述）"></label>
        </div>
      </details>` : '';
  return `<fieldset class="ob-ecard" data-ob-entry>
    <legend>${escHtml(kindLabel)}</legend>
    <div class="ob-erow">
      <label>名称<input data-k="title" placeholder="公司 / 项目 / 学校"></label>
      <label>角色 / 专业<input data-k="role" placeholder="职位 / 专业"></label>
      <label>时间<input data-k="date" placeholder="2024.01 - 2025.01"></label>
    </div>
    <label>要点（每行一条，可留空）<textarea data-k="points" rows="3" placeholder="负责……"></textarea></label>
    ${starFacts}
    <button type="button" class="ob-del" data-ob-del>删除这张卡</button>
  </fieldset>`;
}
// 条目卡的提交序列化（CSP 允许内联脚本；无 JS 时 details 备用简表照常可用）
const OB_STAR_KEYS_FILL_JS = `function OB_STAR_KEYS_FILL(card, star) {
  ['s', 't', 'a', 'r'].forEach(function (k) {
    if (!star[k]) return;
    var inp = card.querySelector('[data-k="' + k + '"]');
    if (inp) inp.value = star[k];
  });
}`;
// 照片步（0.7）：选文件 → data URL → 随表单走既有 POST /onboarding/step（服务端存 photos/，0600）
const OB_PHOTO_JS = `<script nonce="__CSP_NONCE__">
(function () {
  var file = document.querySelector('[data-ob-photo-file]');
  if (!file) return;
  var hidden = document.getElementById('obPhoto');
  var note = document.querySelector('[data-ob-photo-note]');
  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    hidden.value = '';
    if (note) { note.hidden = true; note.textContent = ''; }
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      if (note) { note.hidden = false; note.textContent = '文件过大（上限 5MB），已清空选择'; }
      file.value = '';
      return;
    }
    var r = new FileReader();
    r.onload = function () {
      hidden.value = String(r.result || '');
      if (note) { note.hidden = false; note.textContent = '已选择：' + f.name + '（点「确认并下一步」保存）'; }
    };
    r.onerror = function () {
      if (note) { note.hidden = false; note.textContent = '读取文件失败，请重选'; }
    };
    r.readAsDataURL(f);
  });
})();
</script>`;
const OB_CARDS_JS = `<script nonce="__CSP_NONCE__">${OB_STAR_KEYS_FILL_JS}
(function () {
  var wrap = document.querySelector('[data-ob-entries]');
  if (!wrap) return;
  var payloadInput = document.getElementById('obPayload');
  var form = wrap.closest('form');
  var field = wrap.getAttribute('data-ob-field');
  function bindDel(card) {
    var b = card.querySelector('[data-ob-del]');
    if (!b) return;
    b.addEventListener('click', function () {
      var cards = wrap.querySelectorAll('[data-ob-entry]');
      if (cards.length <= 1) {
        card.querySelectorAll('input,textarea').forEach(function (el) { el.value = ''; });
        return;
      }
      card.remove();
    });
  }
  var addBtn = document.getElementById('obAdd');
  if (addBtn) addBtn.addEventListener('click', function () {
    var c = wrap.querySelector('[data-ob-entry]').cloneNode(true);
    c.querySelectorAll('input,textarea').forEach(function (el) { el.value = ''; });
    bindDel(c);
    wrap.insertBefore(c, addBtn);
  });
  wrap.querySelectorAll('[data-ob-entry]').forEach(bindDel);
  if (form) form.addEventListener('submit', function () {
    var out = [];
    wrap.querySelectorAll('[data-ob-entry]').forEach(function (card) {
      var e = {};
      card.querySelectorAll('[data-k]').forEach(function (el) {
        var k = el.getAttribute('data-k');
        var v = el.value.trim();
        if (!v) return;
        if (k === 'points') { e.points = el.value.split(/\\n/).map(function (s) { return s.trim(); }).filter(Boolean); return; }
        if (['s', 't', 'a', 'r'].indexOf(k) >= 0) { e.star = e.star || {}; e.star[k] = v; return; }
        if (['fact', 'condition', 'contribution', 'source'].indexOf(k) >= 0) { e.facts = e.facts || {}; e.facts[k] = v; return; }
        e[k] = v;
      });
      if (e.title || (e.points && e.points.length) || (e.star && Object.keys(e.star).length) || (e.facts && Object.keys(e.facts).length)) out.push(e);
    });
    var obj = {};
    obj[field] = out;
    payloadInput.value = out.length ? JSON.stringify(obj) : '';
  });
  // S5F：AI 套 STAR——建议只回填到卡片输入框（用户可改、确认提交才落正文）；失败回落纯手填
  var docHidden = form ? form.querySelector('[name="docId"]') : null;
  wrap.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('[data-ob-ai]') : null;
    if (!btn) return;
    var card = btn.closest('[data-ob-entry]');
    if (!card) return;
    var e = { title: '', points: [] };
    card.querySelectorAll('[data-k]').forEach(function (el) {
      var k = el.getAttribute('data-k');
      var v = el.value.trim();
      if (!v) return;
      if (k === 'points') e.points = el.value.split(/\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      else if (['s', 't', 'a', 'r'].indexOf(k) < 0 && ['fact', 'condition', 'contribution', 'source'].indexOf(k) < 0) e[k] = v;
    });
    if (!e.title && !e.points.length) return;
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = 'AI 整理中…';
    fetch('/onboarding/star-suggest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId: docHidden ? docHidden.value : '', entries: [e] })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.ok !== true) { btn.textContent = (d && d.error) || 'AI 建议不可用，可手填'; return; }
      var sug = (d.suggestions || [])[0];
      if (!sug || !sug.star) { btn.textContent = '模型没有给出可用建议，可手填'; return; }
      OB_STAR_KEYS_FILL(card, sug.star);
      var det = card.querySelector('.ob-sub');
      if (det) det.open = true;
      btn.textContent = '已按建议回填（可修改，确认提交后才写入）';
    }).catch(function () {
      btn.textContent = 'AI 建议不可用，可手填';
    }).finally(function () { btn.disabled = false; setTimeout(function () { btn.textContent = old; }, 4000); });
  });
})();
</script>`;

function onboardingPage(state) {
  const ob = state.ob || null;
  const finished = !!(ob && ob.finished);
  const skipped = new Set((ob && Array.isArray(ob.skipped)) ? ob.skipped : []);
  const nextStep = finished ? '' : (ob && ob.next) || state.next || '0.1';
  const cur = OB_STEPS.includes(nextStep) ? nextStep : '0.1';
  const curIdx = OB_STEPS.indexOf(cur);
  const docId = state.docId || '';
  const badge = (st) => st === 'done' ? '<span class="badge ok">已确认</span>'
    : st === 'skip' ? '<span class="badge mute">已跳过</span>'
    : st === 'cur' ? '<span class="badge warn">进行中</span>' : '<span class="badge mute">待进行</span>';
  const rail = `<ol class="ob-rail" data-ob-rail>${OB_STEPS.map((k, i) => {
    const st = finished ? 'done' : i < curIdx ? (skipped.has(k) ? 'skip' : 'done') : i === curIdx ? 'cur' : 'pending';
    return `<li${st === 'cur' ? ' class="ob-cur"' : ''}><span class="ob-idx">${k}</span>${escHtml(OB_LABELS[k])}${badge(st)}</li>`;
  }).join('')}</ol>`;
  const field = (label, name, ph, rows) => rows
    ? `<label class="ob-field"><span>${label}</span><textarea name="${name}" rows="${rows}" placeholder="${escAttr(ph)}"></textarea></label>`
    : `<label class="ob-field"><span>${label}</span><input name="${name}" placeholder="${escAttr(ph)}"></label>`;
  const isEntryStep = cur === '0.3' || cur === '0.4' || cur === '0.6';
  const entryKind = cur === '0.3' ? '经历' : cur === '0.4' ? '项目' : '教育';
  const entryField = cur === '0.3' ? 'work' : cur === '0.4' ? 'projects' : 'edu';
  const entryFallbackName = cur === '0.3' ? 'workText' : cur === '0.4' ? 'projectsText' : 'eduText';
  let formInner = '';
  if (cur === '0.1') {
    const opts = docIdsOnDisk().filter((d) => d !== docId)
      .map((d) => `<option value="${escAttr(d)}">${escHtml(d)}</option>`).join('');
    formInner = `<div class="ob-card">
      ${field('姓名', 'name', '你的名字')}
      ${field('联系方式', 'contact', '电话 / 邮箱（可留空）')}
      ${field('求职意向', 'intent', '想投什么方向（可留空）')}
      ${opts ? `<label class="ob-field"><span>从已有简历预填（可选：只补缺失项，已填字段不会被覆盖，后续步骤自动沿用）</span><select name="prefillFrom"><option value="">不预填</option>${opts}</select></label>` : ''}
    </div>`;
  } else if (cur === '0.2') {
    formInner = `<div class="ob-card">${field('个人总结', 'summary', '几句话说清你是谁、想去哪里（可留空跳过）', 4)}</div>`;
  } else if (isEntryStep) {
    formInner = `<div class="ob-entries" data-ob-entries data-ob-field="${escAttr(entryField)}">
      ${obEntryCard(entryKind, !!docId)}
      <button type="button" class="ob-add" id="obAdd">＋ 再加一张卡</button>
      <input type="hidden" name="payload" id="obPayload" value="">
    </div>
    <details class="ob-fallback"><summary>无脚本备用输入（每段一行：名称 | 角色 | 时间，随后行以 - 写要点）</summary>
      <label class="ob-field"><textarea name="${entryFallbackName}" rows="5" placeholder="示例公司 | 工程师 | 2024.01 - 2025.01"></textarea></label>
    </details>`;
  } else if (cur === '0.5') {
    formInner = `<div class="ob-card">${field('技能（每行一条，可留空跳过）', 'skills', '技能一', 4)}</div>`;
  } else if (cur === '0.7') {
    // 照片可选（S5F ②）：选择即随本步保存到 photos/（用户数据目录，已排除 Git）；
    // 模板照片位受冻结件约束——template.html 无照片位，登记「模板位待 S6」，本步只存路径不注入
    formInner = `<div class="ob-card">
      <div class="ob-done-title">证件照（可选）</div>
      <p class="ob-note">照片会存入本地数据目录（photos/，已排除 Git）；简历模板的照片位待模板库（S6）提供，本步先保存文件。不上传可直接跳过。</p>
      <label class="ob-field"><span>选择照片（png / jpeg / webp，不超过 5MB）</span><input type="file" name="photoFile" accept="image/png,image/jpeg,image/webp" data-ob-photo-file></label>
      <input type="hidden" name="photo" id="obPhoto" value="">
      <p class="ob-note" data-ob-photo-note hidden></p>
    </div>`;
  } else if (cur === '0.8') {
    formInner = `<div class="ob-card">
      <div class="ob-done-title">预览完成</div>
      <p class="ob-note">${docId ? '预览与微调复用编辑器：' : '全程未填内容也会产出一份合法空白文档'}${docId ? `<a href="/edit?id=${escAttr(docId)}">打开编辑器</a>（改完回来确认完成）` : ''}</p>
      <p class="ob-note">确认完成后走既有导出链路；产出文档与手建文档完全同权</p>
    </div>${obThemeCardsHtml(docId)}`;
  }
  const hidden = `<input type="hidden" name="step" value="${escAttr(cur)}">${docId ? `<input type="hidden" name="docId" value="${escAttr(docId)}">` : ''}`;
  const actions = cur === '0.8'
    ? `<button type="submit">完成从零建简历</button>`
    // R2④：跳过是次级动作 → button.secondary（:1542），不与主行动同实底
    : `<button type="submit">确认并下一步</button><button type="submit" name="skip" value="1" class="secondary">跳过这步</button>`;
  const form = finished
    ? `<div class="ob-card"><div class="ob-done-title">从零建简历完成</div><p class="ob-note">文档与手建文档完全同权，可继续编辑与导出</p><p><a href="/edit?id=${escAttr(docId)}">打开编辑器</a> · <a href="/export?id=${escAttr(docId)}">导出 PDF</a></p></div>`
    : `<form method="post" action="/onboarding/step" class="ob-form">${hidden}${formInner}<div class="ob-actions">${actions}<a href="/" title="已确认内容已存入文档，随时回来继续">暂存退出</a></div></form>${isEntryStep ? OB_CARDS_JS : ''}${cur === '0.7' ? OB_PHOTO_JS : ''}`;
  // R2⑤：横幅区分 forward（from=step 步进回跳）/resume（后续再进来）两态；
  // last 落在 skipped 数组里（跳过的步也会推进 last）→ 显示「已跳过 X」，不得谎称「最近确认」。
  const lastMark = (ob && ob.last) ? `（${skipped.has(ob.last) ? '已跳过' : '最近确认'} ${escHtml(OB_LABELS[ob.last] || ob.last)}）` : '';
  const banner = docId
    ? (state.mode === 'forward'
        ? `<p class="ob-note">已进入下一步${lastMark}，从当前步继续即可</p>`
        : `<p class="ob-note">已恢复未完成的从零建简历${lastMark}，从当前步继续即可</p>`)
    : `<p class="ob-note">八步都是可跳过的组织方式：每步可跳过、可暂存续作；已有简历可预填、只补缺失项。首个有内容的确认步才创建文档，空输入不产生文件。</p>`;
  const illust = curIdx === 0 || finished ? HERO_SVG : OB_PAGE_SVG;
  return page('从零建简历', `
<h1>从零建简历</h1>
<div class="ob-shell" data-ob data-ob-doc="${escAttr(docId)}" data-ob-next="${escAttr(finished ? '' : cur)}">
  <div class="ob-side">
    <div class="ob-illust">${illust}<p>${escHtml(OB_COPY[cur] || '')}</p></div>
    <div class="ob-hint">${escHtml(OB_HINT[cur] || '')}</div>
  </div>
  <div>
    ${rail}
    ${banner}
    ${!docId ? obUnfinishedList() : ''}
    ${form}
  </div>
</div>
<style>
.ob-shell{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);gap:var(--space-6);align-items:start;margin-top:var(--space-2)}
.ob-side{position:sticky;top:76px}
.ob-illust svg{width:100%;max-width:220px;height:auto;display:block;margin:0 auto}
.ob-illust p{color:var(--muted);font-size:13px;text-align:center;margin:var(--space-2) 0 0}
.ob-hint{font-size:13px;color:var(--muted);line-height:1.7;border-top:1px solid var(--border);margin-top:var(--space-3);padding-top:var(--space-3)}
.ob-rail{list-style:none;margin:0 0 var(--space-4);padding:0;display:flex;flex-wrap:wrap;gap:var(--space-2)}
.ob-rail li{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted)}
.ob-rail li.ob-cur{border-color:var(--foreground);color:var(--foreground);font-weight:600}
.ob-idx{font-weight:700;font-family:var(--font-mono)}
.ob-form .ob-field{display:block;margin:0 0 var(--space-3)}
.ob-form .ob-field>span{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
.ob-form input,.ob-form textarea,.ob-form select{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);font:inherit;font-size:13px;background:var(--card);color:var(--foreground)}
.ob-note{font-size:13px;color:var(--muted);margin:0 0 var(--space-3)}
.ob-actions{display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap;margin-top:var(--space-4)}
.ob-card{border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-4);background:var(--card)}
/* 完成卡标题走 h2 二级档的视觉规格但不占 h2 语义位：E1 钉「全站唯一 h2 在损坏页」，
   新增 h2 须先归档 DESIGN.md 档位表（本卡不扩档），故用样式档实现同一层级。 */
.ob-done-title{font-size:16px;font-weight:700;margin:0 0 var(--space-2)}
/* 确认卡片流：一块散料一张卡（fieldset），可加可删各带编辑 */
.ob-entries{display:grid;gap:var(--space-3);margin-bottom:var(--space-3)}
.ob-ecard{border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-3) var(--space-4) var(--space-4);background:var(--card);margin:0}
.ob-ecard legend{font-size:12px;font-weight:700;color:var(--muted);padding:0 6px}
.ob-erow{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:var(--space-2);margin-bottom:var(--space-2)}
.ob-ecard label,.ob-sub label{display:block;font-size:12px;color:var(--muted)}
.ob-ecard input,.ob-ecard textarea,.ob-sub input{width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:var(--radius);font:inherit;font-size:13px;background:var(--card);color:var(--foreground);margin-top:3px}
.ob-sub{border:1px dashed var(--border);border-radius:var(--radius);padding:6px 10px;margin:0 0 var(--space-2)}
.ob-sub summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--muted)}
.ob-sub[open]{padding-bottom:10px}
/* R2③：卡片流辅助钮浅底虚线化——全局 button 是 accent 实底，辅助钮（加卡/AI/删卡）压成 --card 浅底；
   .ob-add 是 .ob-entries 的 grid 项，默认 stretch 拉满整行 → justify-self:start 收回内容宽 */
.ob-add{border-style:dashed;background:var(--card);color:var(--muted);justify-self:start}
.ob-ai{border-style:dashed;background:var(--card);font-size:12px;color:var(--muted);margin-top:var(--space-2)}
.ob-del{border-style:dashed;background:var(--card);color:var(--muted);font-size:12px}
.ob-fallback{margin-bottom:var(--space-3);font-size:13px}
.ob-fallback summary{cursor:pointer;color:var(--muted);font-size:12px}
.ob-resume .ob-resume-item{display:flex;justify-content:space-between;gap:var(--space-3);padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:var(--space-2);font-weight:400}
.ob-resume .ob-resume-item span{color:var(--muted);font-size:13px;white-space:nowrap}
/* 0.8 选模板：每主题一张卡（批 5 第 2 项起四张：主题名 + 场景短语 + 真渲染缩略图 + 选中态）。
   缩略图 = A4 页面按比例缩放进固定框（尺寸字面值只落在本行的自定义属性上，规则里只引用变量）；
   缩放随框宽自适应（框宽/页宽，上限 --ob-thumb-scale）——卡宽随机型栅格随视口收窄，固定缩放会在
   ≤1250px 视口把页面右栏裁掉（缩略图是「双栏紧凑 vs 杂志展示」的唯一对比依据，2026-11-06 复核阻断项）；
   框高固定，可见页顶比例随之变大；零投影：选中态 = 边框色 + 底色差（DESIGN.md §3.1 阴影例外仅 --shadow-up）。 */
.ob-tpick{--ob-page-w:794px;--ob-page-h:1123px;--ob-thumb-h:158px;--ob-thumb-scale:.35;margin:var(--space-4) 0}
.ob-tcards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:var(--space-3)}
.ob-tcard{display:flex;flex-direction:column;gap:var(--space-2);border:1px solid var(--border);border-radius:var(--radius-lg);padding:var(--space-3);background:var(--card);cursor:pointer}
.ob-tcard:has(input:checked){border-color:var(--foreground);background:var(--card-2)}
.ob-thead{display:flex;align-items:center;gap:var(--space-2)}
/* 中和 .ob-form input{width:100%;padding:8px 10px;border:1px solid var(--border)} 对卡内单选钮的作用：
   radio 是原生控件不吃表单框样式（被撑成整行宽会把主题名挤成折行——2026-11-06 复核阻断项）。 */
.ob-tcard input[type=radio]{width:auto;padding:0;border:0;flex:0 0 auto}
.ob-tname{font-size:13px;font-weight:700;white-space:nowrap}
.ob-scene{font-size:12px;color:var(--muted);white-space:nowrap}
/* 缩略图框 = 容器（container-type: inline-size → 100cqw 取框内容宽）；内层 iframe 固定 A4 尺寸再按比例缩放。 */
.ob-tthumb{display:block;height:var(--ob-thumb-h);overflow:hidden;border:1px solid var(--border);border-radius:var(--radius);background:var(--card-2);container-type:inline-size}
.ob-tthumb iframe{width:var(--ob-page-w);height:var(--ob-page-h);border:0;transform:scale(min(var(--ob-thumb-scale), calc((100cqw - 2px) / var(--ob-page-w))));transform-origin:0 0;pointer-events:none;display:block}
@media (max-width:860px){.ob-shell{grid-template-columns:1fr}.ob-side{position:static}}
</style>`);
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id') || 'linghaoxiang';
  const send = (code, body, type = 'text/html; charset=utf-8', extraHeaders = null) => {
    if (res.destroyed || res.writableEnded) return;
    // 页面 HTML 里内联了服务端运行时 JS（server.mjs 模板 + job-panel.js / editor-shell.js 注入）：
    // 不加 no-store 时浏览器会缓存旧 HTML —— 症状是「服务端代码已改，页面行为没变」
    // （2026-10-18：删除模型配置不落盘，根因即用户标签页跑着重启前的旧 JS）。
    // 只对 HTML 加；PDF / 附件 / 静态资源各自 res.writeHead，不经过这里，不受影响。
    const isHtml = /^text\/html/.test(type);
    const extra = isHtml ? { 'Cache-Control': 'no-store' } : {};
    // 应用页内联脚本 nonce（批 5 b5c2）：page() 模板的每个内联 <script> 都写成
    // nonce="__CSP_NONCE__"（占位符），响应时在这里现发一次性 nonce（randomBytes）替换占位符，
    // 并把同一个 nonce 写进 CSP —— 与 /edit 注入块（iconBlock/shellBlock）的 nonce 同一口径。
    // 占位符只出现在 page() 模板（含 WRITE_HELPER_JS/OB_*/prScriptHtml 常量）；文档正文与预览页
    // 不经 page()，且 < > 引号在用户数据路径全部转义，不会命中该字节序列。
    // HTML 是 no-store 的 → nonce 不可能被缓存复用；无占位符的响应（无内联脚本的页）不带 nonce。
    let cspNonce = '';
    if (isHtml && typeof body === 'string' && body.includes('<script nonce="__CSP_NONCE__">')) {
      cspNonce = randomBytes(18).toString('base64');
      body = body.split('<script nonce="__CSP_NONCE__">').join('<script nonce="' + cspNonce + '">');
    }
    // 全站应用页默认 CSP（2026-11-02 B 线收口新发现：此前只有 /edit 与 /snapshot/view 有 CSP）。
    // 显式传了 Content-Security-Policy 的路由（/edit 的 nonce+hash 策略、/snapshot/view 的锁定策略）保持各自更严口径。
    // 口径：锁死除 script-src 外的全部通道——connect/form-action 限自源（外传关死）、img 不放 https:
    //（应用页零外链图，图片信标外传关死）、object 'none'、frame-ancestors 'none'（防嵌框）、base-uri 'none'、
    // frame-src 'self'（/export 的 PDF 预览 iframe）。script-src 收口（2026-11-07 b5c2）：51 处内联事件属性已
    // 全部委托化为 data-action（b5c1），全部内联脚本块已 nonce 化 → 'unsafe-inline' 移除，内联只放行
    // 一次性 nonce。/edit 的 nonce+hash 策略不动。
    const hasCsp = extraHeaders && Object.keys(extraHeaders).some((k) => k.toLowerCase() === 'content-security-policy');
    if (isHtml && !hasCsp) {
      extra['Content-Security-Policy'] = [
        "default-src 'self'",
        "script-src 'self'" + (cspNonce ? " 'nonce-" + cspNonce + "'" : ''),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'"
      ].join('; ');
    }
    res.writeHead(code, { 'Content-Type': type, ...extra, ...(extraHeaders || {}) });
    res.end(body);
  };
  const sendJson = (code, obj) => send(code, JSON.stringify(obj), 'application/json; charset=utf-8');
  const redirect = (loc) => { res.writeHead(303, { Location: loc }); res.end(); };
  if (!VALID_ID.test(id)) return send(400, 'invalid id', 'text/plain');
  // Host 白名单（DNS rebinding 防线，2026-10-19 安全审查 🔴-1）：
  // 下面的 CSRF 判定比较 origin.host 与 req.headers.host —— 两个值都来自请求，攻击者可控。
  // DNS rebinding 下（evil.com TTL=0 重绑定到 127.0.0.1）浏览器认为同源，服务端也判定同源，
  // 于是任意网页可读全部简历正文 + 明文 API Key，可删文档、/restore 覆盖全部简历。
  // 绑 127.0.0.1 防的是网络，防不住浏览器——用户在同一台机器上开网页是日常。
  const reqHost = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(reqHost)) return send(421, 'bad Host', 'text/plain');
  // 跨进程排他锁：迁移/保存持有 .migrate.lock（他人新鲜持锁）期间，一切写请求一律 503；纯读不受影响。
  // 写请求 = 非 GET/HEAD，外加 WRITE_ON_GET 里"读名义下的写"（GET /pdf、/export 会 renderCurrent→updateMeta 并覆写 PDF）。
  const mutating = (req.method !== 'GET' && req.method !== 'HEAD')
    || (req.method === 'GET' && WRITE_ON_GET.has(url.pathname));
  if (mutating && rootLock.isHeld(root)) {
    return send(503, '迁移/维护进行中（.migrate.lock 被持有），写请求与渲染类 GET（/pdf、/export）暂不可用，请稍后重试', 'text/plain');
  }
  // CSRF 防线：服务只绑 127.0.0.1，但 text/plain + JSON body 属 CORS 简单请求（免预检），
  // 任意网站都能让浏览器对本机发写请求 —— 实测可盲写 applications.json、盲打 /restore 覆盖全部简历。
  // 浏览器发起的写请求必带 Origin，且同源时其 host 必等于 Host 头；无 Origin = 非浏览器客户端（curl/Node）放行。
  if (mutating && req.headers.origin) {
    let sameHost = false;
    try { sameHost = new URL(req.headers.origin).host === req.headers.host; } catch {}
    if (!sameHost) return send(403, 'cross-origin write rejected', 'text/plain');
  }
  // ===== /ai/* 与渲染的全局并发闸门（2026-10-19 安全审查 🟡-1 / 🟡-3）=====
  // 起因：/job/gen-* 有 startGenTask 的「同类型最多 2 个」闸门，但 6 个 /ai/* 端点
  // （rewrite/chat/review/match/zone-analyze/zone-rewrite）直接 await chat()，零闸门 ——
  // 任何本地进程循环打就能无限并发调 AI API 直接烧钱。renderDoc 同理：并发 GET /pdf
  // 在 stale 时会各拉起一个 Chromium（实测 3 请求 = 12 个 chrome-headless-shell），无上限打爆内存。
  // 实现：统一在路由分发前取槽，用 res 的 finish/close 事件释放 —— 不必进每个端点包 try/finally，
  // 也不会漏掉将来新增的端点（豁免表显式列出）。
  // 容量闸门：入口先保留槽位（满则 429）。释放由 server 入口在 handler 的 Promise
  // 真正结束时统一做 —— 客户端断连后模型请求/渲染子进程仍在跑，那段真实占用必须继续占着（RES-03）。
  const gated = gatePool(req.method, url.pathname);
  if (gated) {
    try { req.__resLease = gated.pool.borrow(); }
    catch (e) { return sendJson(429, { ok: false, error: gated.label + '排队已满（最多同时 2 个），请稍候' }); }
  }
  try {
    // ===== 静态资源（代码目录，非数据目录）=====
    if (req.method === 'GET' && url.pathname === '/ai-panel.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'ai-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/editor-shell.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'editor-shell.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/job-panel.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'job-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/zone-panel.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'zone-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    // ===== 首页 =====
    if (req.method === 'GET' && url.pathname === '/') return send(200, listPage(url.searchParams.get('archived') === '1'));
    // 正文提取 API（统一出口的只读视图，便于验证与调试）
    if (req.method === 'GET' && url.pathname === '/api/extract') {
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      const html = fs.readFileSync(docPath(id), 'utf8');
      const includeHidden = url.searchParams.get('hidden') === '1';
      const lines = docToLines(html, { includeHidden });
      return sendJson(200, { ok: true, lines: lines.length, text: lines.join('\n'), hash: contentHash(html) });
    }
    // ===== 编辑器 =====
    if (req.method === 'GET' && url.pathname === '/edit') {
      if (!fs.existsSync(docPath(id))) return send(404, page('404', `<h1>文档不存在: ${id}</h1><p><a href="/">返回首页</a></p>`));
      let html = fs.readFileSync(docPath(id), 'utf8');
      // 文档不完整（保存被中断 / 磁盘满 / 手动改坏）→ 不再吐 500 裸英文（同函数上一行的「文档不存在」
      // 已用友好页面，风格不一致）。用户打不开自己的简历时必须知道发生了什么、以及怎么自救。
      // ⚠️ 不做自动恢复：静默用快照覆盖可能吞掉用户手改内容，风险高于收益。
      if (!/var DOC_ID = '[^']*'/.test(html)) return send(500, page('文档已损坏', `
        <h1>文档「${escHtml(id)}」不完整，无法打开</h1>
        <p>这份文档的内容看起来被截断了——通常是保存写到一半被中断、磁盘写满，或被外部工具改动造成。</p>
        <h2>可以这样处理</h2>
        <ol>
          <li>先去<a href="/backup">备份与恢复</a>看看有没有这份文档的历史版本，可以还原。</li>
          <li>如果内容你还有印象，也可以直接在 <code>docs/${escHtml(id)}.html</code> 里补回缺失的结尾。</li>
          <li>实在无法恢复，就回<a href="/">首页</a>新建一份文档，把内容贴进去。</li>
        </ol>
        <p style="color:var(--mut)">修复这个文件后刷新本页即可。<a href="/">返回首页</a></p>
      `));
      html = html.replace(/var DOC_ID = '[^']*'/, `var DOC_ID = '${id}'`);
      if (!html.includes('id="homeBtn"')) {
        // 不写内联 onclick：/edit 的 CSP 挡内联事件属性 → 跳转由注入层绑定（editor-shell.js 的 homeBtn）
        html = html.replace('<button id="histBtn"', `<button id="homeBtn" class="secondary" title="返回工作台">${icon('house', 13)} 首页</button><button id="histBtn"`);
      }
      const vm = loadMeta()[id] || {};
      // S6-A1：编辑器所见即渲染所得——服务输出与渲染输入同走按主题装配（applyDocTheme，见 currentRenderState 上方）
      html = applyDocTheme(html, vm);
      // 铁律一（编辑入口=渲染组装同款）+ S1 热修裁决：有效 typo = (meta.typo 定义且非空) ? meta.typo : 内联值。
      // 已迁移文档（meta.typo 定义）：serve 前剥离残留内联，非空则注入 meta.typo（'' 且无内联 → 不注入），编辑器所见即渲染所得。
      // meta.typo='' 且内联存在（手工态）：与 freezeHtml 同款回退内联（T7 承载缺陷修复，消除 WYSIWYG 分裂）。
      // legacy 文档（meta 无 typo 键）：保留内联 typo-custom 原样供编辑器显示；/save 按 Task3 路径
      // （normalizeToCurrent）把内联值抽入 meta，完成单文档迁移，往返幂等。
      if (typeof vm.typo === 'string') {
        const sp = splitDoc(html);
        html = sp.html;
        const effTypo = vm.typo || sp.typo || '';
        if (effTypo) {
          const typoBlock = `<style id="typo-custom">${effTypo}</style>`;
          html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, (mm) => typoBlock + mm) : typoBlock + html;
        }
      }
      if (vm.parent && !html.includes('id="verBadge"')) {
        html = html.replace('<button id="histBtn"', `<span id="verBadge" class="badge">${escHtml((vm.company || '') + '·' + (vm.role || ''))}</span><button id="histBtn"`);
      }
      const mtimeMs = fs.statSync(docPath(id)).mtimeMs;
      // CSP 的 nonce：放行服务端自己注入的内联脚本（__MATS__ / __ICONS__ 等数据）
      const cspNonce = randomBytes(16).toString('base64');
      if (!html.includes(ICON_MARK)) html = html.replace('</body>', iconBlock(cspNonce) + '</body>');
      if (!html.includes(SHELL_MARK)) html = html.replace('</body>', shellBlock(id, mtimeMs, cspNonce) + '</body>');
      if (!html.includes(AI_MARK)) html = html.replace('</body>', aiBlock(id) + '</body>');
      if (!html.includes(JOB_MARK)) html = html.replace('</body>', jobBlock(id) + '</body>');
      if (!html.includes(ZONE_MARK)) html = html.replace('</body>', zoneBlock(id) + '</body>');
      // CSP：文档正文是外部输入（恢复的备份可带 <script>）→ 只放行已知的编辑器主脚本（sha256）
      // 与服务端注入块（nonce）；其余内联脚本一律被挡（2026-10-22 审查 [高]）。
      // frame-src/object-src 显式关死（BL-P7-03，2026-11-01 B 线批 1；S6-A2 维持 'none'）：
      // 模板缩略图（S6-A2）用 srcdoc iframe 装载 /theme-preview 的装配输出——srcdoc 不产生导航
      // URL、不受 frame-src 约束，且继承本页 CSP（script-src nonce 化 → 预览脚本死）；预览 HTML
      // 服务端已剥脚本。正文内嵌同源页（如 /settings 的明文 Key）的通道保持关死。
      const csp = [
        "default-src 'self'",
        "script-src 'self' 'nonce-" + cspNonce + "' " + allowedEditorScriptHashes(html).join(' '),
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'self'"
      ].join('; ');
      return send(200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': csp });
    }
    // ===== 文档创建/复制/删除 =====
    // ===== PDF 上传导入（AUD-12）=====
    // 首页「导入 PDF」入口一直在发 POST /upload?name=…，但服务端没有这条路由 → 404，功能形同缺失。
    // 口径：只收 PDF（看魔数不看文件名）、体积有上限、提取有超时、临时文件自有所有权、
    // 同名并发各自成文档（id 分配见 importer.allocateDocId）、失败不留空壳。
    if (req.method === 'POST' && url.pathname === '/upload') {
      const upName = url.searchParams.get('name') || '';
      let upBuf;
      try { upBuf = await readBody(req, 'buffer', 20 * 1024 * 1024); }
      catch (e) { return sendJson(413, { ok: false, error: '上传失败：文件过大（上限 20MB）或传输中断' }); }
      if (upBuf.length < 5 || upBuf[0] !== 0x25 || upBuf[1] !== 0x50 || upBuf[2] !== 0x44 || upBuf[3] !== 0x46) {
        return sendJson(400, { ok: false, error: '上传失败：只接受 PDF 文件' });
      }
      const upTmp = path.join(os.tmpdir(), `resume-upload-${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}.pdf`);
      try { fs.writeFileSync(upTmp, upBuf, { mode: 0o600 }); }
      catch (e) { return sendJson(500, { ok: false, error: '上传失败：临时文件写入失败' }); }
      try {
        const upId = await importPdfText(root, upTmp, upName);
        return redirect(`/edit?id=${upId}`);
      } catch (e) {
        return sendJson(400, { ok: false, error: '导入失败：' + String((e && e.message) || e).slice(0, 200) });
      } finally {
        try { fs.rmSync(upTmp, { force: true }); } catch {}   // 临时文件自有所有权：失败/断连都清掉
      }
    }
    if (req.method === 'POST' && url.pathname === '/new') {
      // S6-A1：新建文档仍 classic 默认（meta.theme 的选择入口属 A2）；既有/被指派主题的文档在
      // 服务与渲染装配时按 meta.theme 选主题（applyDocTheme），不经这里的建档装配。
      const tpl = assembleTemplate('classic');   // 主题唯一源装配（template.mjs）；代码/静态资源永远来自 APP_ROOT
      let i = 0, newId;
      do { newId = i === 0 ? 'doc' : 'doc-' + i; i++; } while (fs.existsSync(docPath(newId)));
      const html = tpl
        .replaceAll('{{NAME}}', () => '未命名')
        .replaceAll('{{CONTACT}}', () => '')
        .replaceAll('{{INTENT}}', () => '')
        .replaceAll('{{SUMMARY}}', () => '点击开始编辑…')
        .replaceAll('{{SKILLS}}', () => '<p>技能…</p>')
        .replaceAll('{{WORK}}', () => '')
        .replaceAll('{{PROJECTS}}', () => '')
        .replaceAll('{{EDU}}', () => '')
        .replaceAll('{{DOC_ID}}', () => newId);
      fs.writeFileSync(docPath(newId), html);
      // 新建即登记样式来源与状态维度（meta 唯一写入者 updateMeta）：theme/styleHash/typo/schemaVersion + kind/flow/archivedAt
      updateMeta(root, newId, (m) => ({ ...(m || {}), ...themeRegistration('classic'), kind: 'master', flow: 'draft', archivedAt: null }));
      return redirect(`/edit?id=${newId}`);
    }
    // ===== S5 从零建简历向导（设计：dev-docs/2026-11-02-s5-design.md）=====
    // GET 页壳：无 docId = 新会话；带 docId = 暂存续作（渲染进度 + 当前步表单）。/onboarding/guided 为 roadmap 原文别名。
    if (req.method === 'GET' && (url.pathname === '/onboarding' || url.pathname === '/onboarding/guided')) {
      const qid = url.searchParams.get('docId') || '';
      if (!qid) {
        // 无文档会话的进度由客户端持有（设计口径）：表单流经 ?next= 传递当前步
        const qnext = url.searchParams.get('next') || '';
        return send(200, onboardingPage({ docId: '', ob: null, next: OB_STEPS.includes(qnext) ? qnext : '0.1' }));
      }
      if (!VALID_ID.test(qid)) return send(400, 'invalid docId', 'text/plain');
      if (!fs.existsSync(docPath(qid))) return send(404, 'doc not found', 'text/plain');
      const qm = loadMeta()[qid] || null;
      if (!qm || !qm.onboarding || typeof qm.onboarding !== 'object') return send(409, '该文档不在从零建简历流程中（无向导进度）', 'text/plain');
      // R2⑤：from=step（步进 PRG 回跳）= forward 态；其余入口（首页恢复/直接续作）= resume 态
      return send(200, onboardingPage({ docId: qid, ob: qm.onboarding, mode: url.searchParams.get('from') === 'step' ? 'forward' : 'resume' }));
    }
    if (req.method === 'POST' && url.pathname === '/onboarding/step') {
      let body;
      try { body = await readBodyAuto(req); } catch { return sendJson(400, { ok: false, error: '请求体解析失败' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(400, { ok: false, error: '请求体应为对象' });
      const step = String(body.step || '');
      const obIdx = OB_STEPS.indexOf(step);
      if (obIdx < 0) return sendJson(400, { ok: false, error: `未知步骤：${step || '(空)'}（合法 0.1–0.8）` });
      // 页壳卡片流（JS）把条目卡序列化成 payload JSON 串；JSON 调用方直接给对象。两者取一。
      if (typeof body.payload === 'string') {
        if (!body.payload.trim()) body.payload = null;
        else {
          try { body.payload = JSON.parse(body.payload); }
          catch { return sendJson(400, { ok: false, error: 'payload 不是合法 JSON' }); }
        }
      }
      const p = (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)) ? body.payload : body;
      // 表单（无 JS 备用）行式简表 → 结构化载荷（JSON 调用方直接给数组）
      if (!Array.isArray(p.work) && p.workText) p.work = obParseEntriesText(p.workText);
      if (!Array.isArray(p.projects) && p.projectsText) p.projects = obParseEntriesText(p.projectsText);
      if (!Array.isArray(p.edu) && p.eduText) p.edu = obParseEntriesText(p.eduText);
      if (!p.skills && p.skillsText) p.skills = String(p.skillsText);
      const skipFlag = body.skip === true || body.skip === '1' || body.skip === 'true';
      // 表单提交（页壳）用 PRG：成功 303 回向导页/编辑页；JSON 调用方拿 JSON 合同（既有夹具口径）
      const isForm = !(req.headers['content-type'] || '').toLowerCase().includes('application/json');
      // docId 闸门（VALID_ID 全局口径；错误体 {ok,error} 与全站一致）
      let docId = null, obRec = null;
      if (body.docId != null && String(body.docId) !== '') {
        docId = String(body.docId);
        if (!VALID_ID.test(docId)) return sendJson(400, { ok: false, error: 'invalid docId' });
        if (!fs.existsSync(docPath(docId))) return sendJson(404, { ok: false, error: 'doc not found' });
        const dm = loadMeta()[docId] || null;
        obRec = dm && dm.onboarding && typeof dm.onboarding === 'object' ? dm.onboarding : null;
        if (!obRec) return sendJson(409, { ok: false, error: '该文档不在从零建简历流程中，不能按向导步进（请直接在编辑器中修改）' });
        if (obRec.finished) return sendJson(409, { ok: false, error: '该文档已完成从零建简历（后续修改请直接在编辑器中进行）' });
        const lastIdx = obRec.last ? OB_STEPS.indexOf(obRec.last) : -1;
        if (lastIdx >= 0 && obIdx < lastIdx) {
          return sendJson(409, { ok: false, error: `步骤 ${step} 已越过当前进度（${obRec.last} 已确认，不能回退；请直接在编辑器中修改）` });
        }
      }
      // 预填提取（纯确定性；显式带 prefillFrom，或沿用本会话在 0.1 选定的来源——后续步自动只补缺失）
      let prefill = null, pfUsed = '';
      const pfReq = body.prefillFrom != null && String(body.prefillFrom) !== '' ? String(body.prefillFrom)
        : (obRec && obRec.prefillFrom && !skipFlag ? String(obRec.prefillFrom) : '');
      if (pfReq) {
        pfUsed = pfReq;
        if (!VALID_ID.test(pfUsed)) return sendJson(400, { ok: false, error: 'invalid prefillFrom' });
        if (!fs.existsSync(docPath(pfUsed))) return sendJson(404, { ok: false, error: `预填来源文档不存在：${pfUsed}` });
        prefill = obExtractPrefill(fs.readFileSync(docPath(pfUsed), 'utf8'));
      }
      const merged = obMergeStep(step, p, prefill, skipFlag);
      const nextStep = OB_STEPS[obIdx + 1] || null;
      // 0.8 选模板：主题随「完成」一步写 meta.theme（/theme/apply 同口径：只写 theme 字段）。
      // 载荷来源：页壳 radio（顶层 theme）或 JSON 调用方（顶层 / payload 均可）；不带 = 不写（classic 默认可跳过）。
      let themeName = '';
      if (step === '0.8') {
        const themeRaw = (p && p.theme != null) ? p.theme : body.theme;
        const themeWant = String(themeRaw == null ? '' : themeRaw).trim();
        if (themeWant) {
          const avail = listThemes();
          if (!avail.includes(themeWant)) return sendJson(400, { ok: false, error: `未知主题: ${themeWant}（可用主题: ${avail.join(', ')}）` });
          themeName = themeWant;
        }
      }
      // 照片（可选，UI 走 0.7 照片步）：载荷带 photo 均收（API 不限步）；有文档才承载；
      // 存用户数据目录 photos/（启动时自写 .gitignore 排除 Git）；注入模板属 S5F 后续卡
      let photoSaved = null;
      if (!skipFlag && p.photo) {
        if (!docId) return sendJson(400, { ok: false, error: '照片需要先有文档承载：请先完成基本信息步（0.1）' });
        const pm = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(p.photo));
        if (!pm) return sendJson(400, { ok: false, error: '照片格式不支持（仅 png/jpeg/webp 的 data URL）' });
        let buf = null;
        try { buf = Buffer.from(pm[2].replace(/\s+/g, ''), 'base64'); } catch {}
        if (!buf || !buf.length) return sendJson(400, { ok: false, error: '照片数据无法解码' });
        if (buf.length > OB_PHOTO_MAX) return sendJson(400, { ok: false, error: '照片过大（上限 5MB）' });
        const fname = `${docId}.${OB_PHOTO_EXT[pm[1]]}`;
        try { fs.writeFileSync(path.join(root, 'photos', fname), buf, { mode: 0o600 }); }
        catch (e) { return sendJson(500, { ok: false, error: '照片写入失败：' + String((e && e.message) || e) }); }
        photoSaved = { file: 'photos/' + fname, bytes: buf.length, type: pm[1] };
      }
      // 进度记录：skipped 合并（显式 skip / 空载荷的步；向前跳步时夹在中间的步；
      // 无文档会话的进度由客户端持有 → 建档时把当前步之前一律记为 skipped）
      const lastIdxPrev = obRec && obRec.last ? OB_STEPS.indexOf(obRec.last) : -1;
      const skipped = new Set(obRec && Array.isArray(obRec.skipped) ? obRec.skipped : []);
      if (skipFlag || (!merged.hasContent && step !== '0.8')) skipped.add(step);
      else if (docId) { for (let k = lastIdxPrev + 1; k < obIdx; k++) skipped.add(OB_STEPS[k]); }
      else { for (let k = 0; k < obIdx; k++) skipped.add(OB_STEPS[k]); }
      const nextRec = { last: step, next: nextStep, skipped: [...skipped].sort() };
      if (merged.facts) nextRec.facts = { at: new Date().toISOString(), items: merged.facts };
      else if (obRec && obRec.facts) nextRec.facts = obRec.facts;
      if (photoSaved) nextRec.photo = photoSaved;
      else if (obRec && obRec.photo) nextRec.photo = obRec.photo;
      if (pfUsed) nextRec.prefillFrom = pfUsed;
      else if (obRec && obRec.prefillFrom) nextRec.prefillFrom = obRec.prefillFrom;
      if (step === '0.8') { nextRec.finished = true; nextRec.next = null; }
      // —— 无文档会话 ——
      if (!docId) {
        // 0.8 预览完成是显式收口：全程跳过也产出一份合法空白文档（与 /new 同款）——用户显式完成不是「空输入脏文档」
        if (step === '0.8') {
          const blankId = obNewDocId();
          const blankHtml0 = obBlankDocHtml(blankId);
          const newHtml = normalizeZids(stripInjections(blankHtml0));
          obCreateDoc(blankId, newHtml, nextRec, themeName);   // 选模板随建档一步写 meta.theme
          return isForm ? redirect(`/edit?id=${blankId}`) : sendJson(200, { ok: true, step, docId: blankId, created: true, nextStep: null, editUrl: '/edit?id=' + blankId });
        }
        // 其余步：合并预填后仍无内容 → 不建档（空输入不产出脏文档；首步确认前不建文档）。
        // 表单流把进度放在 URL 上（客户端持有），跳过/空步前进用 ?next= 续位。
        if (!merged.hasContent) return isForm ? redirect('/onboarding?next=' + encodeURIComponent(nextStep || ''))
          : sendJson(200, { ok: true, step, docId: null, created: false, nextStep });
        // 建档：与 /new 同款（assembleTemplate + themeRegistration + kind=master/flow=draft + 同 id 分配方案），
        // 差异仅两处：占位符填本步内容；normalizeZids + zoneSync 在建档时即做区域初绑（内容即刻可被区域功能识别）。
        const header = merged.header || { name: '', contact: '', intent: '' };
        const newId = obNewDocId();
        const newHtml0 = assembleTemplate('classic')
          .replaceAll('{{NAME}}', () => escHtml(header.name || '未命名'))
          .replaceAll('{{CONTACT}}', () => escHtml(header.contact || ''))
          .replaceAll('{{INTENT}}', () => escHtml(header.intent || ''))
          .replaceAll('{{SUMMARY}}', () => merged.sections['个人总结'] ?? '点击开始编辑…')
          .replaceAll('{{SKILLS}}', () => merged.sections['专业技能'] ?? '<p>技能…</p>')
          .replaceAll('{{WORK}}', () => merged.sections['工作经历'] ?? '')
          .replaceAll('{{PROJECTS}}', () => merged.sections['项目经历'] ?? '')
          .replaceAll('{{EDU}}', () => merged.sections['教育经历'] ?? '')
          .replaceAll('{{DOC_ID}}', () => newId);
        const newHtml = normalizeZids(stripInjections(newHtml0));
        obCreateDoc(newId, newHtml, nextRec);
        return isForm ? redirect(`/onboarding?docId=${newId}&from=step`)
          : sendJson(200, Object.assign({ ok: true, step, docId: newId, created: true, nextStep },
            merged.prefilled.length ? { prefilled: merged.prefilled } : {}));
      }
      // —— 既有文档：本步有内容 → 区域写档（/save 语义，进度与正文同事务）；无内容/skip → 只推进度 ——
      let html = fs.readFileSync(docPath(docId), 'utf8');
      let wrote = false;
      if (!skipFlag) {
        if (merged.header) {
          const nh = obReplaceHeader(html, obHeaderHtml(merged.header));
          if (nh != null) { html = nh; wrote = true; }
        }
        for (const [title, rawInner] of Object.entries(merged.sections)) {
          const nh = obReplaceSection(html, title, rawInner);
          if (nh != null) { html = nh; wrote = true; }
        }
      }
      if (wrote) {
        const w = await obWriteDoc(docId, html, nextRec, themeName);
        if (w.status !== 200) return sendJson(w.status, w.body);
      } else {
        // 进度推进（无正文变化 → 不动正文、不 bump rev）：与写路径同锁口径
        try {
          await withDocLock(root, docId, async () => {
            updateMeta(root, docId, (m) => ({ ...(m || {}), ...(themeName ? { theme: themeName } : {}), onboarding: nextRec }));
          });
        } catch (e) {
          if (e instanceof LockHeld) return sendJson(409, { ok: false, retry: true, error: '该文档正在被另一操作处理，请稍后重试' });
          throw e;
        }
      }
      if (isForm) return redirect(step === '0.8' ? `/edit?id=${docId}` : `/onboarding?docId=${docId}&from=step`);   // R2⑤：回跳带 forward 态标记
      const resp = { ok: true, step, docId, created: false, nextStep };
      if (merged.prefilled.length) resp.prefilled = merged.prefilled;
      if (step === '0.8') resp.editUrl = '/edit?id=' + docId;
      return sendJson(200, resp);
    }
    // S5F ①：STAR AI 整理——只产建议卡，绝不写文档（确认门控=结构性的：正文只认 POST /onboarding/step）
    if (req.method === 'POST' && url.pathname === '/onboarding/star-suggest') {
      // 桩友好：未配置模型 → 明确语义的失败，前端回落纯手填（该步可跳过）
      if (!hasLLM(root)) return sendJson(409, { ok: false, code: 'NO_LLM', error: '未配置模型：可在卡片中手动填写 STAR，或跳过本步' });
      let body;
      try { body = await readBodyAuto(req); } catch { return sendJson(400, { ok: false, error: '请求体解析失败' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(400, { ok: false, error: '请求体应为对象' });
      const sDocId = String(body.docId || '');
      if (!VALID_ID.test(sDocId)) return sendJson(400, { ok: false, error: 'invalid docId' });
      if (!fs.existsSync(docPath(sDocId))) return sendJson(404, { ok: false, error: 'doc not found' });
      const sMeta = loadMeta()[sDocId] || null;
      const sOb = sMeta && sMeta.onboarding && typeof sMeta.onboarding === 'object' ? sMeta.onboarding : null;
      if (!sOb || sOb.finished) return sendJson(409, { ok: false, error: '该文档不在从零建简历流程中，不能请求 STAR 建议' });
      const entries = (Array.isArray(body.entries) ? body.entries : [])
        .filter((e) => e && typeof e === 'object').slice(0, 20)
        .map((e) => ({
          title: String(e.title ?? '').slice(0, 200),
          points: (Array.isArray(e.points) ? e.points : []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 20).map((x) => x.slice(0, 500))
        }))
        .filter((e) => e.title || e.points.length);
      if (!entries.length) return sendJson(400, { ok: false, error: '请先填写经历名称或要点，再请求 STAR 建议' });
      const sp = obStarPrompt(entries);
      let out;
      try { out = await chat(root, sp.sys, sp.user, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      return sendJson(200, { ok: true, suggestions: parseObStarSuggestions(out, entries.length) });
    }
    if (req.method === 'POST' && url.pathname === '/duplicate') {
      const to = url.searchParams.get('to') || '';
      if (!VALID_ID.test(to)) return send(400, 'invalid target id', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      if (fs.existsSync(docPath(to))) return send(409, 'target exists', 'text/plain');
      // 冻结点：读源文档 → freezeHtml（自包含内联 typo）→ 归一化为当前格式（禁止把冻结字节直接落成活文档）；meta 继承（rev 重置 1）。
      try {
        await withDocLock(root, id, () => {
          const srcHtml = fs.readFileSync(docPath(id), 'utf8');
          const srcMeta = loadMeta()[id] || {};
          const frozen = freezeHtml(srcHtml, srcMeta);
          const norm = normalizeToCurrent(frozen.html);
          atomicWrite(docPath(to), norm.html);
          // S1 收尾 F-1：副本只继承内容维度（kind/flow/theme/styleHash/typo/tag/schemaVersion 等），剥离渲染/导出/迁移状态——
          // exports/lastRenderInputId/lastRenderAt 是源文档专属记账（继承会让副本导出页显示源记录、POST /export 按 renderInputId
          // 去重复用源记录 → 物化无记录的孤儿 history 文件、usedBy/投递绑定跨文档错乱）；migration 三门禁绑定源文档的迁移时点；
          // archivedAt 重置 null（副本是新生文档，不继承归档态）。
          updateMeta(root, to, () => {
            const inherited = { ...(srcMeta || {}) };
            for (const k of ['exports', 'lastRenderInputId', 'lastRenderAt', 'migration']) delete inherited[k];
            return {
              ...inherited,
              typo: norm.typo,
              theme: srcMeta.theme || norm.theme || null,
              styleHash: norm.styleHash,
              rev: 1,
              archivedAt: null
            };
          });
          // 复制不经 beginTx 直接落新文档：目标 id 若残留历史未完成记录已被取代（T7 承载缺陷；留着会在下次启动恢复时把副本回滚掉）
          try { const n = dropSupersededTx(root, to); if (n) console.error(`[tx] 同文档过期事务记录已清理 ${n} 条：${to}（/duplicate）`); } catch {}
        });
      } catch (e) {
        if (e instanceof LockHeld) return sendJson(409, { ok: false, retry: true, error: '该文档正在被处理，请稍后重试' });
        throw e;
      }
      return redirect(`/edit?id=${to}`);
    }
    if (req.method === 'POST' && url.pathname === '/delete') {
      if (!url.searchParams.get('id')) return send(400, 'id required', 'text/plain');
      const docs = docIdsOnDisk();
      if (docs.length <= 1) return send(400, '至少保留一份文档', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      fs.unlinkSync(docPath(id));
      if (fs.existsSync(pdfPath(id))) fs.unlinkSync(pdfPath(id));
      try { fs.unlinkSync(pdfPath(id) + '.env.json'); } catch {}   // 渲染环境旁车与 PDF 成对清理
      // S4a 补：meta 条目同步清理（快照按确认文案保留；applications.json 为投递权威源，不在此动）
      updateMetaAll(root, (all) => {
        if (!(id in all)) return all;
        const base = { ...all };
        delete base[id];
        return base;
      });
      return redirect('/');
    }
    // ===== /job/new「为岗位定制简历」（批 1 §0.3 拆页）：表单页，提交契约零变化（仍 POST /job/create 与 /eval/create）=====
    if (req.method === 'GET' && url.pathname === '/job/new') {
      return send(200, jobNewPage());
    }
    // ===== 岗位草稿（独立文档；不依赖模型；同岗位不重复建）=====
    if (req.method === 'POST' && url.pathname === '/job/create') {
      const body = await readBodyAuto(req);
      const r = await createJobDraft(root, { from: body.from, company: body.company, role: body.role, jd: body.jd, jdLink: body.jdLink, jdSource: body.jdSource, brief: body.brief, materials: body.materials });
      if (!r.ok) return sendJson(r.status, r.body);
      if ((req.headers.accept || '').includes('application/json') || (req.headers['content-type'] || '').includes('application/json')) {
        return sendJson(200, { ok: true, id: r.id, jdError: r.jdError, dupHints: r.dupHints });
      }
      return redirect(`/edit?id=${r.id}`);
    }
    // ===== 岗位快速评估（前置筛）：粘贴 JD → 一次模型调用 → 1–5 分报告落库 =====
    // 不复用 genTasks 三态机制：那是 S4a 给「同一文档反复生成建议」设计的（可取消/可重启恢复/可查状态），
    // 评估是一次性同步请求——UI 拿不到 docId 也没有可恢复的东西需要恢复。用 genTasks 只会凭空多一份状态。
    // 超时/失败语义直接沿用 chat() 的 profile 级 timeoutMs（默认 120s）+ withRetry 的 POST 不重试，
    // 失败一律 502 回到调用方，不写半条记录。
    if (req.method === 'POST' && url.pathname === '/eval/create') {
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: '未配置大模型：请先完成模型配置', settingsPath: '/settings' });   // R2②：settingsPath 供消费方按 :2210 先例渲染真实入口链接（「侧栏「设置」」是死引用）
      const body = await readBodyAuto(req);
      const from = String(body.from || '');
      if (!VALID_ID.test(from)) return sendJson(400, { ok: false, error: 'invalid from' });
      if (!fs.existsSync(docPath(from))) return sendJson(404, { ok: false, error: '母版文档不存在' });
      let jd = typeof body.jd === 'string' ? body.jd.trim() : '';
      if (!jd) return sendJson(400, { ok: false, error: 'JD 必填：评估需要岗位描述文本' });
      if (jd.length > JD_MAX_CHARS) jd = jd.slice(0, JD_MAX_CHARS);   // 与 /job/create 同上限（S4B-12）
      const company = String(body.company || '').trim();
      const role = String(body.role || '').trim();
      // 可见正文（不是原始 HTML）：模型看到的、parser 校验的、hash 绑定的必须是同一份文本（E1/E2）。
      // 样式变化不得改变正文 hash。
      const html = fs.readFileSync(docPath(from), 'utf8');
      const docText = docToText(html, { includeHidden: false });
      const p = buildEvalPrompt({ docText, jd, company, role });
      let raw;
      try { raw = await chat(root, p.sys, p.user, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      const parsed = parseEvalReport(raw, { docText });
      // 解析失败一律不落库：半条/错分记录会进指纹护栏（第五路）反过来污染后续所有岗位提醒
      if (!parsed.ok) return sendJson(502, { ok: false, error: '模型报告无法解析：' + parsed.reason });
      const { fingerprintText } = await import('./vendors/jd-fingerprint/fingerprint-core.mjs');
      const cfg = loadProfiles(root);
      const rec = {
        id: 'ev-' + timestamp(), jd, jdFp: fingerprintText(jd),
        company, role, score: parsed.report.score, verdict: parsed.report.verdict,
        blocks: parsed.report, model: (cfg.profiles[cfg.active] || {}).model || '',
        source: evalSource(docText, from),   // 来源字段由程序赋值：bodyHash 绑定实际送审正文
        createdAt: new Date().toISOString(), promotedTo: null
      };
      saveEvals([rec, ...loadEvals()]);   // 新记录在前：列表按时间倒序读
      // 读时视图：旧记录的 sourced 降级为 missing、历史分数不重算（SRC-04/SRC-06）
      return sendJson(200, { ok: true, eval: evalRecordView(rec) });
    }
    // 高分评估转岗位适配：与 /job/create 共用 createJobDraft（同一套去重/冻结/截断/指纹/meta 落库）
    if (req.method === 'POST' && url.pathname === '/eval/promote') {
      const body = await readBodyAuto(req);
      const list = loadEvals();
      const rec = list.find((e) => e && e.id === String(body.evalId || ''));
      if (!rec) return sendJson(404, { ok: false, error: '评估记录不存在' });
      if (rec.promotedTo) return sendJson(409, { ok: false, error: '该评估已转为岗位草稿', existing: rec.promotedTo });
      // F2：评估报告 angle/gaps 预填岗位定制要求——blocks 两字段由 parseEvalReport 契约采集（eval.mjs 输出契约），
      // focus = [angle, ...gaps] 过滤空串后经 normBrief 统一校验（trim / 20 条上限 / degree=refocus、pages=2 缺省），
      // 随 createJobDraft 落 meta.job.brief；面板可逐条删除（POST /job/brief 回写），岗位生成 prompt 消费路径不变。
      const blk = (rec.blocks && typeof rec.blocks === 'object' && !Array.isArray(rec.blocks)) ? rec.blocks : {};
      const prefillFocus = [blk.angle, ...(Array.isArray(blk.gaps) ? blk.gaps : [])]
        .filter((x) => typeof x === 'string' && x.trim());
      const r = await createJobDraft(root, { from: body.from, company: rec.company, role: rec.role, jd: rec.jd, jdSource: '评估', brief: { focus: prefillFocus } });
      if (!r.ok) return sendJson(r.status, r.body);
      // 跨 await 后重新读表（AUD-14）：createJobDraft 可能要等 JD 抓取，
      // 这期间别的评估可能已落库或已被 promote → 用 await 前的旧列表写回会丢掉它们。
      const list2 = loadEvals();
      const rec2 = list2.find((e) => e && e.id === String(body.evalId || ''));
      if (!rec2) return sendJson(409, { ok: false, error: '评估记录在转换期间消失，未写入 promotedTo' });
      if (rec2.promotedTo && rec2.promotedTo !== r.id) {
        return sendJson(409, { ok: false, error: '该评估已被转换', existing: rec2.promotedTo });
      }
      rec2.promotedTo = r.id;
      saveEvals(list2);
      return sendJson(200, { ok: true, id: r.id });
    }
    // ===== 评估历史（独立页）：全量列表 + 逐条展开报告 =====
    // 服务端渲染全量元数据（evalHistoryRows），报告正文经 jsonScript 内联，
    // 客户端由 evalCardHtml 渲染 —— 本页是评估历史的唯一落点（批 1 §0.3：首页评估历史卡已撤除）。
    // 不进 topnav / 侧栏：入口是 /job/new 页题右侧的「评估历史 →」
    // （评估在 /job/new 发起，入口落本页题右侧；/evals 不占导航位）。
    // active 传 'docs'：本页由首页进入，归属「文档」，侧栏保持「文档」高亮。
    if (req.method === 'GET' && url.pathname === '/evals') {
      const records = loadEvals().map(evalRecordView);
      return send(200, page('评估历史', `<h1>评估历史</h1>
    <div class="card">
      <div id="evalHistory">${evalHistoryRows(records, (did) => fs.existsSync(docPath(did)))}</div>
      <span id="evalHistoryMsg" role="status" style="font-size:12px;color:var(--mut)"></span>
    </div>
    <script nonce="__CSP_NONCE__">
      var EVAL_RECORDS = ${jsonScript(evalHistoryPayload(records))};
      ${EVAL_CARD_JS}
      ${EVAL_HISTORY_JS}
    </script>`, 'docs'));
    }
    // ===== 网申包（S8 · 批 3 页面卡 b3c2）：页面 + 三态字段 + 单字段复制 + 整包导出 =====
    // 写入口一律走 apply-profile.mjs 数据层（tx 纪律 + 损坏停写），页面层不自己拼文档路径。
    if (req.method === 'GET' && url.pathname === '/apply-profile') {
      return send(200, applyProfilePage());
    }
    // 整包导出（纯文本 = 复制用；JSON = 全字段 + 三态）。只读导出，不写账本。
    if (req.method === 'GET' && url.pathname === '/apply/export') {
      // 导出范围：缺省 → 通用表；'package' 与其别名 'pkg' → 字段包；未知写法 → 400（形状错即拒，不猜——
      // 否则拼错的 scope 会静默导出一份通用表糊弄用户）。
      const scopeRaw = String(url.searchParams.get('scope') || '').trim();
      let scope = 'common';
      if (scopeRaw !== '') {
        if (scopeRaw === 'common') scope = 'common';
        else if (scopeRaw === 'package' || scopeRaw === 'pkg') scope = 'package';
        else return send(400, '未知导出范围：' + scopeRaw + '（可用：common / package）', 'text/plain; charset=utf-8');
      }
      const format = url.searchParams.get('format') === 'json' ? 'json' : 'text';
      const pkgId = scope === 'package' ? String(url.searchParams.get('pkg') || '') : '';
      const led = loadApplyProfilesView(root);
      if (led.corrupt) return send(500, '数据文件损坏，已停止写入：apply-profiles.json。请先人工修复或从备份恢复。', 'text/plain; charset=utf-8');
      if (scope === 'package' && !led.view.packages[pkgId]) return send(404, '字段包不存在', 'text/plain; charset=utf-8');
      const body = format === 'json' ? apExportJson(led.view, pkgId) : apExportText(led.view, pkgId);
      const name = 'apply-' + (pkgId ? 'pkg-' + pkgId : 'common') + (format === 'json' ? '.json' : '.txt');
      const type = format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
      return send(200, body, type, { 'Content-Disposition': 'attachment; filename="' + name + '"' });
    }
    // 字段三态：follow（恢复跟随）/ override（手动覆写）/ manual（独立维护，仅独立字段）
    // ai = AI 文案字段的「解锁」（文案内容不动，把被手动改写锁住的字段交回 AI 接管）。
    if (req.method === 'POST' && url.pathname === '/apply/field') {
      const body = await readBodyAuto(req);
      const scope = apScopeOf(body.scope);
      if (scope.err) return sendJson(400, { ok: false, error: scope.err });
      const key = String(body.key || '');
      const mode = String(body.mode || '');
      if (![MODE_FOLLOW, MODE_OVERRIDE, MODE_MANUAL, MODE_AI].includes(mode)) return sendJson(400, { ok: false, error: '未知字段模式：' + mode });
      try {
        setField(root, scope.scope, key, mode, { value: body.value == null ? '' : String(body.value) });
      } catch (e) {
        return sendJson(e && e.httpCode ? e.httpCode : 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' });
      }
      return sendJson(200, { ok: true });
    }
    // ===== AI 文案字段（批 3 卡片 b3c3）：生成 → 预览 → 确认才入库 =====
    // 生成：原子登记任务（并发闸同款：同类 copy 全库同时只允许 1 个）→ fire-and-forget 跑模型；
    // 结果只经完成判定（gen-result.mjs 的纯函数）落「待确认稿」，**不进字段**。
    if (req.method === 'POST' && url.pathname === '/apply/copy/start') {
      const body = await readBodyAuto(req);
      const scope = apScopeOf(body.scope);
      if (scope.err) return sendJson(400, { ok: false, error: scope.err });
      const key = String(body.key || '');
      if (!isCopyKey(key)) return sendJson(400, { ok: false, error: '不是 AI 文案字段：' + key });
      if (scope.scope.kind === 'package' && !loadApplyProfiles(root).data.packages[scope.scope.id]) {
        return sendJson(404, { ok: false, error: '字段包不存在' });
      }
      // 无模型 → 明确降级（不做「点了才知道」的死路；措辞与页面同源）
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: NO_MODEL_HINT });
      // 无取材来源 → 明确拒绝（AI 文案只能取材于真简历；不留一个注定失败的 running 任务）
      const src = copySource(root, scope.scope);
      if (!src) return sendJson(500, { ok: false, error: '数据文件损坏，已停止写入：apply-profiles.json。请先人工修复或从备份恢复。' });
      if (!src.docId) return sendJson(409, { ok: false, error: '还没有可依据的简历：请先绑定母版简历（或在字段包选择岗位简历）后再生成' });
      // 资源准入（与 /job/gen-start 同口径）：先借 AI 槽，拿不到立刻拒 → 不留 running 假任务
      let lease;
      try { lease = aiPool.borrow(); }
      catch (e) { return sendJson((e && e.httpCode) || 429, { ok: false, error: (e && e.message) || 'AI 排队已满，请稍候' }); }
      const model = (() => { try { const c = loadProfiles(root); return (c && c.profiles && c.profiles[c.active]) ? c.profiles[c.active].model : null; } catch { return null; } })();
      let taskId = null, reject = null;
      try {
        const st = startCopyTask(root, scope.scope, key, { model });
        taskId = st.taskId; reject = st.reject;
      } catch (e) {
        try { lease.release(); } catch {}
        return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' });
      }
      if (reject) { try { lease.release(); } catch {} return sendJson(reject.status, { ok: false, error: reject.error }); }
      runCopyTask(root, scope.scope, key, taskId, { lease })
        .catch((e) => {
          // 任何异常都要收敛任务态：否则账本里会留下永远 running 的假任务
          try { finishCopyTask(root, copyTaskKey(scope.scope, key), taskId, { errMsg: '任务失败：' + ((e && e.message) || e) }); } catch {}
        })
        .finally(() => { try { lease.release(); } catch {} });
      return sendJson(200, { ok: true, taskId, status: 'running' });
    }
    // 任务状态（轮询用）：只给真实阶段与真实用量，**无百分比**。
    if (req.method === 'GET' && url.pathname === '/apply/copy/state') {
      const scope = apScopeOf(String(url.searchParams.get('scope') || 'common').indexOf('package:') === 0
        ? { kind: 'package', id: String(url.searchParams.get('scope')).slice(8) } : 'common');
      if (scope.err) return sendJson(400, { ok: false, error: scope.err });
      const key = String(url.searchParams.get('key') || '');
      if (!isCopyKey(key)) return sendJson(400, { ok: false, error: '不是 AI 文案字段：' + key });
      const st = copyTaskState(root, scope.scope, key);
      if (st.corrupt) return sendJson(500, { ok: false, error: '数据文件损坏，已停止写入：apply-profiles.json。请先人工修复或从备份恢复。' });
      const draft = st.draft ? { id: st.draft.id, text: st.draft.text, createdAt: st.draft.createdAt } : null;
      return sendJson(200, { ok: true, task: st.task || null, draft, ttlMs: COPY_TTL_MS });
    }
    // 取消：taskId 匹配当前 running 才置 cancelled；在途结果被完成判定丢弃（零落账）。
    if (req.method === 'POST' && url.pathname === '/apply/copy/cancel') {
      const body = await readBodyAuto(req);
      const scope = apScopeOf(body.scope);
      if (scope.err) return sendJson(400, { ok: false, error: scope.err });
      const key = String(body.key || '');
      const taskId = String(body.taskId || '');
      if (!isCopyKey(key) || !taskId) return sendJson(400, { ok: false, error: 'key（AI 文案字段）与 taskId 必填' });
      let cancelled = false;
      try { cancelled = cancelCopyTask(root, scope.scope, key, taskId); }
      catch (e) { return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' }); }
      if (!cancelled) return sendJson(409, { ok: false, error: '任务已结束或已被新任务取代（taskId 不匹配当前 running）' });
      return sendJson(200, { ok: true });
    }
    // 确认入库：待确认稿 → 字段（预览可改后再确认）；锁定期拒绝（覆写后锁定不被再生覆盖）。
    if (req.method === 'POST' && url.pathname === '/apply/copy/confirm') {
      const body = await readBodyAuto(req);
      const scope = apScopeOf(body.scope);
      if (scope.err) return sendJson(400, { ok: false, error: scope.err });
      const key = String(body.key || '');
      if (!isCopyKey(key)) return sendJson(400, { ok: false, error: '不是 AI 文案字段：' + key });
      let r = null;
      try {
        r = confirmCopyDraft(root, scope.scope, key, body.draftId == null ? '' : String(body.draftId),
          body.text == null ? undefined : String(body.text));
      } catch (e) {
        return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' });
      }
      if (!r.ok) return sendJson(r.status || 400, { ok: false, error: r.error, code: r.code || '' });
      return sendJson(200, { ok: true });
    }
    // 丢弃待确认稿：生成结果不进字段，丢弃即清稿。
    if (req.method === 'POST' && url.pathname === '/apply/copy/discard') {
      const body = await readBodyAuto(req);
      const scope = apScopeOf(body.scope);
      if (scope.err) return sendJson(400, { ok: false, error: scope.err });
      const key = String(body.key || '');
      if (!isCopyKey(key)) return sendJson(400, { ok: false, error: '不是 AI 文案字段：' + key });
      try { discardCopyDraft(root, scope.scope, key); }
      catch (e) { return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' }); }
      return sendJson(200, { ok: true });
    }
    // ===== 分享副本（批 3 卡片 b3c5）：勾选隐藏字段 → 独立预览/PDF（不动原简历）=====
    // 隐藏 = 物理删除（share-copy.mjs hideFieldsInHtml：姓名删 <h1>、联系方式块内摘除电话/邮箱、章节整段移除），
    // 副本文件里不存在隐藏载荷。渲染走独立 renderDoc（不经 renderCurrent）：**不写 docs/docs-meta、
    // 不触碰 pdfs/<id>.pdf**——原简历与它的渲染记账零改动。
    // 导出前文本层校验（批 2 文本层能力复用：pdftotext + 去空白比对，share-copy.mjs findResidues）：
    // 被隐藏字段原文在副本文本层仍有残留（哪怕在正文别处）→ 整体拒绝（409），不落记录不落产物。
    if (req.method === 'POST' && url.pathname === '/share/copy') {
      const body = await readBodyAuto(req);
      const docId = String(body.docId || '');
      if (!VALID_ID.test(docId)) return sendJson(400, { ok: false, error: 'invalid docId' });
      if (!fs.existsSync(docPath(docId))) return sendJson(404, { ok: false, error: 'doc not found' });
      const hidden = Array.isArray(body.hidden) ? [...new Set(body.hidden.filter((k) => typeof k === 'string'))] : null;
      if (!hidden || !hidden.length) return sendJson(400, { ok: false, error: '未勾选任何要隐藏的字段' });
      const badKey = hidden.find((k) => !DERIVED_KEYS.includes(k));
      if (badKey) return sendJson(400, { ok: false, error: '不是简历里可隐藏的字段：' + badKey + '（只有从简历派生的字段能隐藏）' });
      const appId = body.appId === undefined || body.appId === null || body.appId === '' ? '' : String(body.appId);
      if (appId) {
        if (!/^[0-9-]+$/.test(appId)) return sendJson(400, { ok: false, error: 'invalid appId' });
        // 先验后做：关联投递的校验放在任何产物/记录产生之前（不存在 → 404 零部分产物）
        if (!loadApps().some((a) => a && a.id === appId)) return sendJson(404, { ok: false, error: '投递记录不存在（appId=' + appId.slice(0, 40) + '）' });
      }
      const led0 = loadApplyProfiles(root);
      if (led0.corrupt) return sendJson(500, { ok: false, error: '数据文件损坏，已停止写入：apply-profiles.json。请先人工修复或从备份恢复。' });
      const meta = loadMeta()[docId] || {};
      const docHtml = applyDocTheme(fs.readFileSync(docPath(docId), 'utf8'), meta);   // 与当前文档渲染同源的主题装配
      const frozen = freezeHtml(hideFieldsInHtml(docHtml, hidden), meta);
      if (!frozen.reproducible) {
        return sendJson(409, { ok: false, error: '文档包含不可复现资源（远程 URL 或缺失文件），请先本地化后再导出分享副本', remote: frozen.remote, missing: frozen.missing });
      }
      const absent = absentKeys(docHtml, hidden);
      const shareId = 'sh-' + timestamp() + '-' + randomBytes(3).toString('hex');
      const shareDirPath = path.join(root, 'pdfs', 'shares');
      fs.mkdirSync(shareDirPath, { recursive: true });
      const stamp = process.pid + '-' + Date.now() + '-' + randomBytes(4).toString('hex');
      const tmpOut = path.join(shareDirPath, `.tmp-${stamp}.pdf`);
      const tmpSrc = path.join(os.tmpdir(), `resume-share-src-${stamp}.html`);
      atomicWrite(tmpSrc, frozen.html);
      let rr = null;
      try {
        rr = await renderDoc({
          src: tmpSrc, out: tmpOut,
          env: { RESUME_RENDER_INPUT_ID: frozen.renderInputId, RESUME_RENDER_REPRODUCIBLE: frozen.reproducible ? '1' : '0' },
          lease: leaseOf(req)
        });
      } finally { try { fs.unlinkSync(tmpSrc); } catch {} }
      const failShare = (code, error, extra) => {
        try { fs.rmSync(tmpOut, { force: true }); } catch {}
        try { fs.rmSync(tmpOut + '.env.json', { force: true }); } catch {}
        return sendJson(code, { ok: false, error, ...(extra || {}) });
      };
      if (!rr || !rr.ok || !fs.existsSync(tmpOut)) {
        return failShare(500, (rr && rr.sizeError) || '渲染失败，分享副本未导出（详见服务日志）');
      }
      // 文本层校验（批 2 能力复用）：先渲染到临时名，校验零残留才转正——绝不发布带残留的副本
      let layerText = '';
      try { layerText = execFileSync('pdftotext', [tmpOut, '-'], { timeout: 30000 }).toString('utf8'); } catch { layerText = ''; }
      if (!layerText) {
        return failShare(409, 'PDF 文本层未取到，无法校验隐藏字段是否残留——分享副本未导出（不产出无法核验的副本）');
      }
      const residues = findResidues(layerText, shareExpectations(docHtml, hidden));
      if (residues.length) {
        const detail = residues.map((x) => `${x.label} 仍有 ${x.count} 处残留`).join('；');
        return failShare(409, '文本层校验未通过：' + detail + '。工具只在联系方式块内摘除联系方式；正文其他位置出现同样内容时，请先在原简历中处理（工具不代改简历正文）。', { residues });
      }
      fs.renameSync(tmpOut, sharePdfPath(root, shareId));
      if (fs.existsSync(tmpOut + '.env.json')) fs.renameSync(tmpOut + '.env.json', sharePdfPath(root, shareId) + '.env.json');
      try {
        addShareRecord(root, { id: shareId, docId, hidden, createdAt: new Date().toISOString(), file: 'pdfs/shares/' + shareId + '.pdf', chars: layerText.length });
      } catch (e) {
        return sendJson((e && e.httpCode) || 500, { ok: false, error: '分享副本 PDF 已生成，但导出记录写入失败：' + String((e && e.message) || e) });
      }
      let warning = null;
      if (absent.length) warning = '原简历没有这些字段：' + absent.map((k) => (FIELD_CATALOG.find((f) => f.key === k) || { label: k }).label).join('、') + '（未隐藏任何内容）';
      if (appId) {
        try {
          const apps = loadApps();
          const app = apps.find((a) => a && a.id === appId);
          if (app) { app.shareId = shareId; app.updatedAt = timestamp(); saveApps(apps); }
          else warning = (warning ? warning + '；' : '') + '关联投递失败：记录已不存在';
        } catch (e) { warning = (warning ? warning + '；' : '') + '关联投递失败：' + String((e && e.message) || e); }
      }
      return sendJson(200, { ok: true, shareId, url: '/share/pdf?id=' + encodeURIComponent(shareId), absent, warning });
    }
    // 分享副本产物伺服（独立预览/PDF）：纯读。shareId 形状校验挡路径穿越；记录在账本、产物在
    // pdfs/shares/，两者缺一都如实 404（记录与产物成对落盘，缺失说明产物被外部删除）。
    if (req.method === 'GET' && url.pathname === '/share/pdf') {
      const sid = String(url.searchParams.get('id') || '');
      if (!SHARE_ID_RE.test(sid) || sid.length > 80) return send(400, 'invalid share id', 'text/plain');
      const ledS = loadApplyProfiles(root);
      const rec = ledS.corrupt ? null : ((ledS.data.shares || {})[sid] || null);
      if (!rec) return send(404, '分享副本不存在（shareId=' + sid.slice(0, 64) + '）', 'text/plain');
      const f = sharePdfPath(root, sid);
      if (!fs.existsSync(f)) return send(404, '分享副本记录存在但产物缺失：' + rec.file + '（产物被外部删除时，这份记录无法再打开）', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; ${dispositionFileName('share-' + sid + '.pdf')}` });
      return fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
    }
    // 绑定母版（通用表跟随来源的出处）：换母版 = 重新确认全部跟随字段的快照（清漂移）；手填与独立字段不动。
    if (req.method === 'POST' && url.pathname === '/apply/bind') {
      const body = await readBodyAuto(req);
      const docId = String(body.docId || '');
      if (!fs.existsSync(docPath(docId))) return sendJson(404, { ok: false, error: '母版文档不存在' });
      try {
        bindCommonMaster(root, docId);
      } catch (e) {
        return sendJson(e && e.httpCode ? e.httpCode : 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' });
      }
      return sendJson(200, { ok: true });
    }
    // 新建/补全公司字段包：建包即把派生字段同步到通用表当前值（跟随态 + 已确认快照）。
    if (req.method === 'POST' && url.pathname === '/apply/package') {
      const body = await readBodyAuto(req);
      const company = String(body.company || '').trim();
      const role = String(body.role || '').trim();
      if (!company) return sendJson(400, { ok: false, error: '公司必填' });
      try {
        const pkg = ensurePackage(root, { company, role, note: String(body.note || '').trim() });
        for (const item of FIELD_CATALOG) {
          if (!item.derived) continue;
          setField(root, { kind: 'package', id: pkg.id }, item.key, MODE_FOLLOW);
        }
        return sendJson(200, { ok: true, id: pkg.id });
      } catch (e) {
        return sendJson(e && e.httpCode ? e.httpCode : 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' });
      }
    }
    // 公司包换源（跟随通用信息表 ↔ 跟随岗位简历）：换源后跟随态字段重新确认快照；
    // 手填覆写与独立字段的值不动（只更新它们记录的来源，供日后「恢复跟随」用）。
    if (req.method === 'POST' && url.pathname === '/apply/source') {
      const body = await readBodyAuto(req);
      const scope = apScopeOf(body.scope);
      if (scope.err) return sendJson(400, { ok: false, error: scope.err });
      if (scope.scope.kind !== 'package') return sendJson(400, { ok: false, error: '只有公司字段包可以换源' });
      const src = (body.source && typeof body.source === 'object') ? body.source : {};
      const kind = String(src.kind || '');
      if (![SOURCE_RESUME, SOURCE_COMMON].includes(kind)) return sendJson(400, { ok: false, error: '未知来源类型：' + kind });
      const docId = String(src.docId || '');
      if (kind === SOURCE_RESUME && !fs.existsSync(docPath(docId))) return sendJson(404, { ok: false, error: '岗位简历不存在' });
      const before = loadApplyProfiles(root).data;
      if (!before.packages[scope.scope.id]) return sendJson(404, { ok: false, error: '字段包不存在' });
      try {
        for (const item of FIELD_CATALOG) {
          if (!item.derived) continue;
          const cur = (before.packages[scope.scope.id].fields || {})[item.key] || null;
          setFieldSource(root, scope.scope, item.key, { kind, docId });
          if (!cur || cur.mode === MODE_FOLLOW) setField(root, scope.scope, item.key, MODE_FOLLOW);
        }
        updateApplyProfiles(root, (d) => {
          const p = d.packages[scope.scope.id];
          if (p) p.sourceDocId = kind === SOURCE_RESUME ? docId : '';
          return d;
        });
      } catch (e) {
        return sendJson(e && e.httpCode ? e.httpCode : 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' });
      }
      return sendJson(200, { ok: true });
    }
    // 岗位修改清单读/写（状态持久化；应用动作由前端 DOM 执行后回写状态）
    if (req.method === 'GET' && url.pathname === '/job/changes') {
      let m = loadMeta()[id] || {};
      m = sweepGenTasks(id, m);   // S4a-T4 读取时校验：过期 running → error（任务级总时限三点之二）
      // 兼容视图（S1-T8）：响应里的 status 为派生旧词汇（reviewed→deliverable，其余→draft），flow 为存储单源；
      // schemaVersion<2 时 flowOf 由 job.status 即时推导，绝不写回。
      // S4a-T3：jobView 附带 brief/evidence/genTasks/saveReceipts 摘要/reviewPos 渐进默认值。
      // S4a-T6：jobViewLive 叠加来源维度即时计算（refs fresh / consistency 现算，不落盘）。
      const job = jobViewLive(id, m);
      // S4a-T8：rev 随响应暴露——客户端 JSON 保存协议的 baseRev 基线来源
      // doc.mtime = 当前正文版本（ZONE-03）：区域请求必须带它作基线，服务端据此拒绝陈旧请求
      const docMtime = fs.existsSync(docPath(id)) ? fs.statSync(docPath(id)).mtimeMs : null;
      // 提交核对（2026-10-28 补丁轮）：按 requestId 查本次落账回执。
      //   客户端用它判断「那次提交到底落没落账」——不能靠候选状态猜：
      //   撤回成功后状态回到 pending（服务端状态机 revert→pending），只看状态会把「已落账」误判成「未落账」。
      //   回执含 appliedOps（operationId/changeId/action），核对因此能对应到具体操作。
      const wantReqIds = (url.searchParams.get('saveReqIds') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
      if (wantReqIds.length) {
        const receipts = (m.job && Array.isArray(m.job.saveReceipts)) ? m.job.saveReceipts : [];
        const found = {};
        for (const r of receipts) {
          if (r && wantReqIds.includes(r.requestId)) {
            found[r.requestId] = { requestId: r.requestId, contentHash: r.contentHash || null, receipt: r.receipt || null };
          }
        }
        job.saveReceipts = { ...(job.saveReceipts || {}), found, queried: wantReqIds };
      }
      return sendJson(200, { ok: true, job, rev: Number(m.rev) || 0, zones: m.zones || null, zoneOrder: m.zoneOrder || null, zoneRounds: m.zoneRounds || null, genTtlMs: GEN_TTL_MS, doc: { id, parent: m.parent || '', company: m.company || '', role: m.role || '', jd: m.jd || '', jdSource: m.jdSource || '', mtime: docMtime } });
    }
    if (req.method === 'POST' && url.pathname === '/job/changes') {
      const body = JSON.parse(await readBody(req));
      const updates = Array.isArray(body.updates) ? body.updates : [];
      // S4a-T6：reviewPos（审阅位置：段名+changeId+筛选）经本端点持久化；写入前整体校验，坏形状 400。
      if (body.reviewPos !== undefined) {
        const rp = body.reviewPos;
        if (!rp || typeof rp !== 'object' || !['evidence', 'changes', 'export'].includes(rp.section)
          || !(rp.changeId === null || (typeof rp.changeId === 'string' && rp.changeId))
          || !['all', 'important', 'new'].includes(rp.filter)) {
          return sendJson(400, { ok: false, error: 'reviewPos 非法（section∈evidence|changes|export、changeId 字符串或 null、filter∈all|important|new）' });
        }
      }
      // S4a-T9：resolve（「保留当前版本」）与 feedback（拒绝原因进 prompt）经本端点持久化；写入前整体校验。
      if (body.resolve !== undefined) {
        const rs = body.resolve;
        if (!rs || typeof rs !== 'object' || typeof rs.changeId !== 'string' || !rs.changeId
          || typeof rs.text !== 'string'
          || (rs.refs !== undefined && (typeof rs.refs !== 'object' || rs.refs === null || Array.isArray(rs.refs)))) {
          return sendJson(400, { ok: false, error: 'resolve 非法（changeId/text 必填，refs 为 {refId:指纹} 对象可选）' });
        }
      }
      if (body.feedback !== undefined && (typeof body.feedback !== 'string' || !body.feedback.trim().slice(0, 200))) {
        return sendJson(400, { ok: false, error: 'feedback 须为非空字符串（≤200 字）' });
      }
      // S4a-T7：证据条目 note 两级流程（note 文本 / noteConfirmed 显式确认）经本端点持久化；写入前整体校验。
      if (body.evidenceNote !== undefined) {
        const en = body.evidenceNote;
        if (!en || typeof en !== 'object' || typeof en.reqId !== 'string' || !en.reqId
          || (en.note !== undefined && typeof en.note !== 'string')
          || (en.confirmed !== undefined && typeof en.confirmed !== 'boolean')) {
          return sendJson(400, { ok: false, error: 'evidenceNote 非法（reqId 必填、note 字符串可选、confirmed 布尔可选）' });
        }
      }
      let written = null, outcome = null;
      // docs-meta 唯一写入者：全表 RMW（updateMetaAll 的 mutator 返回 null → 放弃不写，字节与 mtime 都不变）。
      // AUD-10：所有业务校验与变更都在【独立工作副本】上完成；任一校验失败 → 放弃整个更新。
      //   ① 空说明不得清空已存在的 note，也不得保留「已确认」标志；
      //   ② 组合请求不得前半段成功后后半段报错（半提交）；
      //   ③ 每种 4xx 前后 meta 字节与 mtime 不变。
      written = updateMetaAll(root, (all) => {
        const m = all[id];
        if (!m || !m.job) { outcome = { status: 404, error: '该文档不是岗位草稿' }; return null; }
        const work = JSON.parse(JSON.stringify(m));   // 工作副本：校验与改动都不碰真实表
        for (const u of updates) {
          if (!u || typeof u.id !== 'string') continue;
          const c = work.job.changes.find((x) => x.id === u.id);
          if (!c) continue;
          if (typeof u.status === 'string' && ['pending', 'accepted', 'rejected', 'reverted', 'resolved', 'superseded', 'skipped'].includes(u.status)) c.status = u.status;   // S4a-T9：+skipped（稍后处理，pending⇄skipped）
          if (typeof u.note === 'string') c.note = u.note;
          if (u.meta && typeof u.meta === 'object') c.meta = { ...(c.meta || {}), ...u.meta };
          c.updatedAt = new Date().toISOString();
        }
        if (Array.isArray(body.todos)) work.job.todos = body.todos;
        if (body.reviewPos !== undefined) work.job.reviewPos = { section: body.reviewPos.section, changeId: body.reviewPos.changeId || null, filter: body.reviewPos.filter };
        if (body.evidenceNote) {
          const en = body.evidenceNote;
          const ev = (work.job.evidence || []).find((x) => x && x.id === en.reqId);
          if (!ev) { outcome = { status: 400, error: '证据条目不存在：' + en.reqId }; return null; }
          // 「确认为证据」需有说明内容（note 是证据本体）；退回（false）不要求。
          // 空说明 → 整个更新放弃：已存在的 note 不被清空，「已确认」标志也不被改。
          if (en.confirmed === true) {
            const noteText = (typeof en.note === 'string' ? en.note : (ev.note || '')).trim();
            if (!noteText) { outcome = { status: 400, error: '确认为证据前请先填写说明内容' }; return null; }
          }
          if (typeof en.note === 'string') ev.note = en.note;
          if (en.confirmed !== undefined) ev.noteConfirmed = en.confirmed;
        }
        if (body.resolve) {
          // 「保留当前版本」（设计 §4.2 v1.4）：绑定 resolvedText（当前段落文本）+ resolvedRefs（依赖 ref 指纹快照）→ 退出待核对；再变重新核对（candidatesState 读取时判定）
          const rs = body.resolve;
          const c = (work.job.changes || []).find((x) => x && x.id === rs.changeId);
          if (!c || !['pending', 'accepted'].includes(c.status)) {
            outcome = { status: 400, error: '保留当前版本：候选不存在或不在 pending/accepted（' + rs.changeId + '）' };
            return null;
          }
          c.status = 'resolved';
          c.resolvedAt = new Date().toISOString();
          c.resolvedText = rs.text;
          if (rs.refs && typeof rs.refs === 'object') c.resolvedRefs = rs.refs;
          c.updatedAt = new Date().toISOString();
        }
        if (body.feedback !== undefined) {
          // 拒绝原因 → job.feedback 环形（≤20 条，进下一次生成 prompt）
          work.job.feedback = (Array.isArray(work.job.feedback) ? work.job.feedback : []).concat(body.feedback.trim()).slice(-20);
        }
        if (typeof body.status === 'string') {
          // 状态维度单源（S1-T8）：旧词汇映射 deliverable/delivered→reviewed（投递历史改由 applications.json 派生），新词汇直通；
          // 只写 flow，不再写 job.status（迁移会删除它）
          const toFlow = { draft: 'draft', deliverable: 'reviewed', delivered: 'reviewed', reviewing: 'reviewing', reviewed: 'reviewed' };
          if (toFlow[body.status]) work.flow = toFlow[body.status];
          // 注：「是否可投递」不在这里复核 —— flow 只是状态维度（用户声明审阅完成），
          // 可投递是派生量，由 exportChecks（审阅完成）+ deliverableNow（PDF 当前身份）计算。
          // 在这里按可投递条件拦截会与既有语义冲突（flow 可先于逐条处理置位）。
        }
        return { ...all, [id]: work };
      });
      if (outcome) return sendJson(outcome.status, { ok: false, error: outcome.error });
      return sendJson(200, { ok: true, job: jobViewLive(id, written && written[id]) });   // 响应与 GET 同视图（含 live 标注与渐进默认）
      return sendJson(200, { ok: true, job: jobViewLive(id, written) });   // 响应与 GET 同视图（含 live 标注与渐进默认）
    }
    // ===== S4a-T5：岗位草稿要求卡保存（同 normBrief 校验；普通文档 404）=====
    if (req.method === 'POST' && url.pathname === '/job/brief') {
      const body = JSON.parse(await readBody(req));
      const nb = normBrief(body);
      if (nb.error) return sendJson(400, { ok: false, error: nb.error });
      let isJob = false;
      updateMeta(root, id, (m) => {
        if (!m || !m.job) return m;
        isJob = true;
        m.job = { ...m.job, brief: nb.brief };
        return m;
      });
      if (!isJob) return sendJson(404, { ok: false, error: '该文档不是岗位草稿' });
      return sendJson(200, { ok: true, brief: nb.brief });
    }
    // ===== S3：区域绑定（zones 存 meta；归属与状态由用户操作回写，一致性由 /save zoneSync 兜底）=====
    if (req.method === 'POST' && url.pathname === '/zones') {
      const body = JSON.parse(await readBody(req));
      const zonesIn = body.zones && typeof body.zones === 'object' ? body.zones : null;
      if (!zonesIn) return sendJson(400, { ok: false, error: 'zones 必填' });
      for (const [zid, z] of Object.entries(zonesIn)) {
        if (!/^z[0-9a-f]{8}$/.test(zid) || !z || typeof z !== 'object'
          || !ZONE_KEYS.includes(z.zone) || !['pending', 'confirmed'].includes(z.status)) {
          return sendJson(400, { ok: false, error: `非法条目 ${zid}` });
        }
      }
      try { rootLock.acquire(root); } catch (e) { if (e instanceof LockHeld) return sendJson(409, { ok: false, error: '另一保存/迁移正在进行（.migrate.lock），请稍后重试' }); throw e; }
      try {
        updateMeta(root, id, (m) => {
        const base = { ...(m || {}) };
        const zones = { ...(base.zones || {}) };
        for (const [zid, z] of Object.entries(zonesIn)) {
          zones[zid] = { zone: z.zone, status: z.status, ...(z.locked === true ? { locked: true } : (z.locked === false ? { locked: false } : {})) };
        }
        base.zones = zones;
        if (Array.isArray(body.zoneOrder) && body.zoneOrder.every((z) => ZONE_KEYS.includes(z)) && new Set(body.zoneOrder).size === body.zoneOrder.length) {
          base.zoneOrder = body.zoneOrder;
        }
        if (body.zoneRounds && typeof body.zoneRounds === 'object') {
          const r = { ...(base.zoneRounds || {}) };
          for (const k of Object.keys(body.zoneRounds)) if (ZONE_KEYS.includes(k) && Number.isFinite(body.zoneRounds[k])) r[k] = body.zoneRounds[k];
          base.zoneRounds = r;
        }
        return base;
      });
      return sendJson(200, { ok: true });
      } finally { try { rootLock.release(root); } catch {} }
    }
    if (req.method === 'POST' && url.pathname === '/zones/init') {
      const body = JSON.parse(await readBody(req));
      const entries = Array.isArray(body.entries) ? body.entries.filter((e) => e && /^z[0-9a-f]{8}$/.test(e.zid)) : [];
      if (!entries.length) return sendJson(400, { ok: false, error: 'entries 必填' });
      let created = null;
      try { rootLock.acquire(root); } catch (e) { if (e instanceof LockHeld) return sendJson(409, { ok: false, error: '另一保存/迁移正在进行（.migrate.lock），请稍后重试' }); throw e; }
      try {
        const w = updateMeta(root, id, (m) => {
        if (m && m.zones && Object.keys(m.zones).length) { created = 'exists'; return m; }   // 已有 zones：幂等不动
        const zones = {};
        for (const e of entries) {
          zones[e.zid] = { zone: guessZone(e.sectionTitle || ''), status: 'pending' };
        }
        created = 'created';
        return { ...(m || {}), zones, zoneOrder: ['personal', 'work', 'project', 'skill', 'education', 'award', 'summary', 'other'] };
      });
      return sendJson(200, { ok: true, zones: w.zones });   // 用写入后返回值，不回读磁盘
      } finally { try { rootLock.release(root); } catch {} }
    }
    // ===== S4a-T4：AI 任务可靠性端点（设计 §6）=====
    // gen-start：原子启动——updateMetaAll 锁内扫描全表判并发（同类 ≤1 / 合计 ≤2），立即返回 taskId；
    // LLM 跑在服务端 fire-and-forget，结果只经 finishGenTask 的 taskId 校验落账；客户端轮询 /job/changes。
    if (req.method === 'POST' && url.pathname === '/job/gen-start') {
      const kind = url.searchParams.get('kind');
      if (!GEN_KINDS.includes(kind)) return sendJson(400, { ok: false, error: 'kind 必须是 ' + GEN_KINDS.join('|') });
      // S4a-T8：scope=all|zone:<key>（局部重生成，仅 changes 通道；evidence 恒 all）
      let scope = 'all';
      const scopeRaw = url.searchParams.get('scope');
      if (scopeRaw) {
        const sm = /^zone:([a-z]+)$/.exec(scopeRaw);
        if (kind !== 'changes' || !sm || !ZONE_KEYS.includes(sm[1])) return sendJson(400, { ok: false, error: 'scope 非法（all 或 zone:<区域key>，仅 changes 通道）' });
        scope = scopeRaw;
      }
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: '未配置大模型：草稿仍可手动编辑，配置后可生成建议' });
      // 资源准入（RES-02/04）：后台任务与同步 AI 请求共用同一个 aiPool。
      // 先借一个槽（拿不到立刻拒），再登记任务 → 被拒时不会在 meta 里留下「永远 running」的假任务。
      // 此前是「先登记 running、再在 runner 里等槽」，等满 5s 抛 ResourceBusy 后异常被吞 → 任务永久假运行。
      let lease;
      try { lease = aiPool.borrow(); }
      catch (e) { return sendJson((e && e.httpCode) || 429, { ok: false, error: (e && e.message) || 'AI 排队已满，请稍候' }); }
      // 借槽之后登记任务若抛错，槽位必须归还（不能既没任务又占着容量）
      let taskId = null, reject = null;
      try {
        const st = startGenTask(id, kind, scope);
        taskId = st.taskId; reject = st.reject;
      } catch (e) {
        try { lease.release(); } catch {}
        throw e;
      }
      if (reject) { try { lease.release(); } catch {} return sendJson(reject.status, { ok: false, error: reject.error }); }
      // 槽位透传（RES-02）：后台任务不再二次获取；释放 = 这次后台工作真正结束（最外层 finally）
      runGenTask(id, kind, taskId, scope, { lease })
        .catch((e) => {
          // 任何异常都要收敛任务态：否则 meta 里会留下永远 running 的假任务
          try { finishGenTask(id, kind, taskId, null, '任务失败：' + ((e && e.message) || e)); } catch {}
        })
        .finally(() => { try { lease.release(); } catch {} });
      return sendJson(200, { ok: true, taskId, status: 'running' });
    }
    // gen-cancel：taskId 匹配当前 running 才置 cancelled（防误取消刚接棒的新任务）；在途结果被回调校验丢弃。
    if (req.method === 'POST' && url.pathname === '/job/gen-cancel') {
      const kind = url.searchParams.get('kind');
      const taskId = url.searchParams.get('taskId');
      if (!GEN_KINDS.includes(kind) || !taskId) return sendJson(400, { ok: false, error: 'kind（' + GEN_KINDS.join('|') + '）与 taskId 必填' });
      let cancelled = false;
      updateMeta(root, id, (m) => {
        if (!m || !m.job) return m;
        const gt = m.job.genTasks && m.job.genTasks[kind];
        if (gt && gt.taskId === taskId && gt.status === 'running') {
          m.job.genTasks = { ...(m.job.genTasks || {}), [kind]: { ...gt, status: 'cancelled' } };
          cancelled = true;
        }
        return m;
      });
      if (!cancelled) return sendJson(409, { ok: false, error: '任务已结束或已被新任务取代（taskId 不匹配当前 running）' });
      return sendJson(200, { ok: true });
    }
    // gen-retry（P3 批次重试）：只重跑指定失败批。守卫照 gen-start 全套——
    //   ① 资源准入先行：先借 AI 槽（借不到 429 且零写入，不造「永远 running」假任务），登记 running 若抛错归还；
    //   ② updateMetaAll 事务内并发闸照 startGenTask（全库同类 ≤1 / 合计 ≤2，过期残留不占额度）；
    //   ③ taskId 匹配当前任务记录（防误重试已被新任务取代的旧任务）；
    //   ④ 任务可重试态：done/error 且 batches.failed 含该批、batchPlan 计划在（旧记录无计划 → 请重新生成）。
    // 受理后 fire-and-forget runGenBatchRetry（凭证透传同 gen-start；释放=这次重试真正结束）。
    if (req.method === 'POST' && url.pathname === '/job/gen-retry') {
      const kind = url.searchParams.get('kind');
      const batchRaw = url.searchParams.get('batch');
      const reqTaskId = url.searchParams.get('taskId') || '';
      if (kind !== 'changes' || batchRaw === null || !/^\d+$/.test(batchRaw)) return sendJson(400, { ok: false, error: 'kind 必须是 changes 且 batch 必须是非负整数' });
      const batch = Number(batchRaw);
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: '未配置大模型：草稿仍可手动编辑，配置后可生成建议' });
      let lease;
      try { lease = aiPool.borrow(); }
      catch (e) { return sendJson((e && e.httpCode) || 429, { ok: false, error: (e && e.message) || 'AI 排队已满，请稍候' }); }
      let reject = null;
      try {
        updateMetaAll(root, (all) => {
          const m = all[id];
          if (!m || !m.job) { reject = { status: 404, error: '该文档不是岗位草稿' }; return null; }
          const now = Date.now();
          // 并发闸（照 startGenTask）：全库同类 running ≤1、两类合计 ≤2；过期残留不计入
          let sameKindOther = false, total = 0;
          for (const [did, dm] of Object.entries(all)) {
            const gt2 = dm && dm.job && dm.job.genTasks;
            if (!gt2) continue;
            for (const k of GEN_KINDS) {
              const t = gt2[k];
              if (!t || t.status !== 'running' || genExpired(t, now)) continue;
              total++;
              if (k === 'changes' && did !== id) sameKindOther = true;
            }
          }
          if (sameKindOther) { reject = { status: 409, error: '另一文档的任务进行中，请稍后再试' }; return null; }
          if (total >= 2) { reject = { status: 409, error: '并发任务已达上限（全库同类 1 + 跨类合计 ' + (GEN_KINDS.length - 1) + '），请稍后再试' }; return null; }
          const gt = m.job.genTasks && m.job.genTasks.changes;
          if (!gt || gt.taskId !== reqTaskId) { reject = { status: 409, error: 'taskId 不匹配当前任务（可能已被新任务取代），请刷新后重试' }; return null; }
          if (gt.status !== 'done' && gt.status !== 'error') { reject = { status: 409, error: '任务不在可重试状态（running/cancelled 不可重试）' }; return null; }
          const b = gt.batches;
          if (!b || !Array.isArray(b.failed) || !b.failed.some((f) => f && f.batch === batch)) { reject = { status: 409, error: '批次 ' + batch + ' 不在失败清单，无需重试' }; return null; }
          const plan = Array.isArray(gt.batchPlan) ? gt.batchPlan : [];
          if (!plan.some((p) => p && p.batch === batch)) { reject = { status: 409, error: '批次计划缺失（旧任务记录），请重新生成' }; return null; }
          // 可重试 → 任务重启 running（新 startedAt=TTL 重新起算；retrying=N 供面板显示「重试第 x/y 批」）
          const job = { ...m.job, genTasks: { ...(m.job.genTasks || {}), changes: { ...gt, status: 'running', stage: 'calling', error: null, startedAt: now, batches: { total: b.total, done: b.done, failed: b.failed, retrying: batch } } } };
          return { ...all, [id]: { ...m, job } };
        });
      } catch (e) {
        try { lease.release(); } catch {}
        throw e;
      }
      if (reject) { try { lease.release(); } catch {} return sendJson(reject.status, { ok: false, error: reject.error }); }
      runGenBatchRetry(id, reqTaskId, batch, { lease })
        .catch((e) => {
          // 重试运行器意外异常也要收敛任务态：恢复 done（成功批候选已在账上），原因进失败清单
          try { finishRetryFailure(id, reqTaskId, batch, '重试异常：' + ((e && e.message) || e), null); } catch {}
        })
        .finally(() => { try { lease.release(); } catch {} });
      return sendJson(200, { ok: true, taskId: reqTaskId, batch, status: 'running' });
    }
    // 生成建议（LLM 可选；失败不影响已有草稿与母版）
    // S4a-T4：内部转 changes 任务同步等待（响应形状不变，现有 job-panel 调用不破；T9 再切纯异步轮询）。
    // 结果经与 gen-start 完全相同的 taskId 校验链路落账（并发双击在 startGenTask 锁内只剩一个）。
    // ===== A4：偏好记忆管理（②）：删除 job.feedback 单条或清空（环形重写）=====
    // 本机 prefs 走 localStorage 不经服务端；本端点只管服务端环形（随文档保存的那份）。
    // 守卫：400（非法 id / index 非法或超界）/ 404（缺文档）/ 409（非岗位草稿）；零模型依赖（管理不依赖生成）。
    if (req.method === 'POST' && url.pathname === '/job/feedback-del') {
      const body = await readBodyAuto(req);
      const docId = String((body && body.id) || '');
      if (!VALID_ID.test(docId)) return sendJson(400, { ok: false, error: 'invalid id' });
      if (!fs.existsSync(docPath(docId))) return sendJson(404, { ok: false, error: 'doc not found' });
      const isClear = body && body.clear === true;
      const idx = Number(body && body.index);
      const m0 = loadMeta()[docId] || {};
      if (!m0.job) return sendJson(409, { ok: false, error: '该文档不是岗位草稿' });
      const list0 = Array.isArray(m0.job.feedback) ? m0.job.feedback : [];
      if (!isClear && (!Number.isInteger(idx) || idx < 0)) return sendJson(400, { ok: false, error: 'index 必须是非负整数，或 clear=true 清空' });
      if (!isClear && idx >= list0.length) return sendJson(400, { ok: false, error: `index 超出偏好列表范围（当前 ${list0.length} 条）` });
      updateMeta(root, docId, (m) => {
        if (!m || !m.job) return m;
        const cur = Array.isArray(m.job.feedback) ? m.job.feedback : [];
        m.job.feedback = isClear ? [] : cur.filter((_, i) => i !== idx);
        return m;
      });
      return sendJson(200, { ok: true, feedback: (loadMeta()[docId].job || {}).feedback || [] });
    }
    if (req.method === 'POST' && url.pathname === '/job/generate') {
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: '未配置大模型：草稿仍可手动编辑，配置后可生成建议' });
      const genBody = JSON.parse(await readBody(req) || '{}');   // 兼容既有调用形状：空对象体；坏 JSON 400 路径保持
      if (!fs.existsSync(docPath(id))) return sendJson(404, { ok: false, error: 'doc not found' });
      // 资源准入前置（与 gen-start 同口径，2026-10-28 补丁轮）：容量拒绝必须在任何业务写入之前
      //   —— 此前 feedback 先落盘再判并发，被拒时 feedback 已经写进去了。
      let lease;
      try { lease = aiPool.borrow(); }
      catch (e) { return sendJson((e && e.httpCode) || 429, { ok: false, error: (e && e.message) || 'AI 排队已满，请稍候' }); }
      let taskId = null;
      try {
        // 借槽成功后才做业务写入（S4a-T9：长期偏好随生成请求并入 job.feedback，环形 ≤20）
        if (Array.isArray(genBody.feedback) && genBody.feedback.length) {
          updateMeta(root, id, (m) => {
            if (!m || !m.job) return m;
            m.job.feedback = (Array.isArray(m.job.feedback) ? m.job.feedback : [])
              .concat(genBody.feedback.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())).slice(-20);
            return m;
          });
        }
        // 借槽之后登记任务若抛错，槽位必须归还
        let reject = null;
        try {
          const st = startGenTask(id, 'changes');
          taskId = st.taskId; reject = st.reject;
        } catch (e) { throw e; }
        if (reject) return sendJson(reject.status, { ok: false, error: reject.error });
        let r;
        try {
          r = await runGenTask(id, 'changes', taskId, 'all', { lease });
        } catch (e) {
          // 拿不到 AI 槽（等满 5s）等异常：任务态必须收敛，不能留下永远 running 的假任务
          try { finishGenTask(id, 'changes', taskId, null, '任务失败：' + ((e && e.message) || e)); } catch {}
          return sendJson((e && e.httpCode) || 500, { ok: false, error: (e && e.message) || '任务失败' });
        }
        // S4a-T5 转交修 a：dropped 读锁内已写的真实原因（finishGenTask 过期路径已落 error=任务超时），
        // 真超时不再恒称「已被取消或取代」；error 为空（真被取消/取代）才用兜底文案。
        if (r.dropped) {
          const gt = ((loadMeta()[id] || {}).job || {}).genTasks?.changes;
          return sendJson(409, { ok: false, error: (gt && gt.error) || '任务已被取消或取代' });
        }
        if (!r.ok) return sendJson(502, { ok: false, error: r.error });
        return sendJson(200, { ok: true, job: r.job, generated: r.generated, todos: r.todos });
      } finally {
        try { lease.release(); } catch {}
      }
    }
    // ===== 保存（正文与 PDF 分离；revision 冲突检测）=====
    if (req.method === 'POST' && url.pathname === '/save') {
      if (!url.searchParams.get('id')) return send(400, 'id required', 'text/plain');
      // S4a-T3（设计 §4.2 v1.6）：按 Content-Type 分流——application/json 走 JSON 保存协议
      // （{requestId, baseRev, html, ops}：整次保存幂等 + ops 与正文单事务提交）；其余 Content-Type 走既有 HTML 路径（零改动）。
      if ((req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
        const out = await saveJsonProtocol(req, id, url);
        return sendJson(out.status, out.body);
      }
      let html = await readBody(req);
      html = stripInjections(html);
      // S3：zid 归一（补缺/去重/坏值重打）必须在剥离注入块之后执行；meta zones 同步在下方 updateMeta 回调里做
      html = normalizeZids(html);
      if (!html.trim()) return send(400, 'empty save rejected', 'text/plain');
      if (!looksLikeDoc(html)) return send(400, '非文档载荷：剥离后不含任何 HTML 元素，已拒绝（正文、meta、rev、快照均未变化）', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      // 跨进程排他锁：保存与迁移互斥（被他人持有 → 503）。持锁贯穿整个事务，覆盖两次 rename 之间被杀的窗口。
      try { rootLock.acquire(root); }
      catch (e) { if (e instanceof LockHeld) return send(503, '另一保存/迁移正在进行（.migrate.lock），请稍后重试', 'text/plain'); throw e; }
      let out;
      try {
        out = await withDocLock(root, id, async () => {
          // 多标签保护（文档锁内检查，避免与 /rollback、/duplicate 竞态）：磁盘 mtime 已被别处推进 → 409 冲突
          const baseMtime = Number(url.searchParams.get('baseMtime') || 0);
          const force = url.searchParams.get('force') === '1';
          if (baseMtime > 0 && !force) {
            const cur = fs.statSync(docPath(id)).mtimeMs;
            if (cur > baseMtime + 2) return { status: 409, body: { ok: false, conflict: true, mtime: cur, error: '磁盘上的文档已被其他窗口更新' } };
          }
          const autosave = !!url.searchParams.get('autosave');
          const oldHtml = fs.readFileSync(docPath(id), 'utf8');
          const oldMeta = loadMeta()[id] ?? null;
          // 当前文档落盘不含 typo：剥离内联 typo-custom，值只存 meta（normalizeToCurrent 幂等）
          const norm = normalizeToCurrent(html);
          const newHtml = norm.html;
          const newTypo = norm.typo;                       // '' 表示无微调（合法历史状态）
          // 旧版冻结快照（手动保存）：freezeHtml 内联旧 meta.typo + manifest；autosave 免快照（配额）
          const oldSnapTs = autosave ? '' : snapshot(id);
          // 写前持久化事务记录（含旧正文副本 + 旧 meta 整份副本），覆盖进程中断
          const txId = beginTx(root, id, 'save', oldSnapTs);
          try {
            atomicWrite(docPath(id), newHtml);              // rename #1：正文
            const gapMs = Number(process.env.RESUME_TEST_SAVE_GAP_MS || 0);
            if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));   // 测试钩子：模拟两次 rename 之间被杀
            const prevHash = contentHash(oldHtml), newHash = contentHash(newHtml);
            updateMeta(root, id, (m) => {                   // rename #2：meta（读最新→只 patch 本文档→原子写）
              const base = { ...(m || {}) };
              base.typo = newTypo;
              base.rev = (Number(base.rev) || 0) + 1;
              // 改稿使「可投递」失效（已有投递存档不受影响）：flow reviewed→draft（可投递本身是派生判定，stale 即时生效；此处降级存储的审阅状态）
              if (prevHash && prevHash !== newHash && flowOf(base) === 'reviewed') {
                base.flow = 'draft';
                if (base.job) base.job = { ...base.job, invalidatedAt: new Date().toISOString() };
              }
              // S3：zones 同步（正文为准；多余清/缺失补 pending+启发式/已有归属不动）
              Object.assign(base, zoneSync(newHtml, base));
              return base;
            });
            commitTx(root, txId);                           // 成功：删事务记录
          } catch (e2) {
            // 任一异常：用旧正文 + 旧 meta 副本恢复两者，再抛（外层映射状态码）。
            // 只有两次恢复都成功才删事务记录；任一失败 → 保留记录交启动恢复（否则混合态在下次启动已无从恢复）。
            let htmlBack = false, metaBack = false;
            try { atomicWrite(docPath(id), oldHtml); htmlBack = true; } catch {}
            try { updateMeta(root, id, () => oldMeta); metaBack = true; } catch {}
            if (htmlBack && metaBack) { try { commitTx(root, txId); } catch {} }
            throw e2;
          }
          // 本次保存成功 → 同文档更早的未完成记录（上一次回滚不全而保留的）已过期：
          // 留着会在下次启动恢复时把文档回滚到更早版本，丢掉这次成功保存。
          try {
            const stale = dropSupersededTx(root, id);
            if (stale) console.error(`[tx] 同文档过期事务记录已清理 ${stale} 条：${id}`);
          } catch {}
          const st = fs.statSync(docPath(id));
          // pdfStale 按渲染标识判定（staleInfo），mtime 不作依据：本次落盘正文+typo 冻结出标识，对照 lastRenderInputId。
          const savedRid = freezeHtml(newHtml, { typo: newTypo }).renderInputId;
          const saveSi = staleInfo(loadMeta()[id] || {}, { renderInputId: savedRid, pdfExists: fs.existsSync(pdfPath(id)) });
          return { status: 200, body: { ok: true, mtime: st.mtimeMs, hash: contentHash(newHtml), pdfStale: saveSi.stale } };
        });
      } catch (e) {
        if (e instanceof LockHeld) return sendJson(409, { ok: false, retry: true, error: '该文档正在被另一保存/回滚/复制处理，请稍后重试' });
        throw e;
      } finally {
        try { rootLock.release(root); } catch {}
      }
      return sendJson(out.status, out.body);
    }
    // 显式渲染 PDF（正文保存不触发渲染，避免自动保存拖渲染进程）：统一走 renderCurrent 组装，绝不直渲磁盘 HTML
    if (req.method === 'POST' && url.pathname === '/render') {
      if (!fs.existsSync(docPath(id))) return sendJson(404, { ok: false, error: 'doc not found' });
      const r = await renderCurrent(id, { lease: leaseOf(req) });
      const exists = fs.existsSync(pdfPath(id));
      // 超限（BL-P1-04）：客户端可见「文档 X MB 超过渲染上限 Y MB」，其余失败仍走既有通用文案
      return sendJson(r.ok && exists ? 200 : 500, { ok: r.ok && exists, mtime: exists ? fs.statSync(pdfPath(id)).mtimeMs : 0, renderInputId: r.frozen.renderInputId, error: r.ok && exists ? null : (r.sizeError || '渲染失败（详见服务日志）') });
    }
    // ===== 导出记录（S1-T8，spec §8 binding）：POST /export 是唯一记录者 =====
    // 不可变产物 pdfs/history/<id>@<完整 renderInputId>.pdf：存在即复用、绝不覆盖；幂等键 = renderInputId
    // （并发/重复 POST 经 updateMeta 原子 RMW 去重 → 只 1 条 exports 记录 + 只 1 个文件）。
    // 渲染失败 → 不记 exports；文件已生成而记录写入失败 → 重试复用文件并补记录。
    // GET 打开导出页、POST /render、自动重渲都不经过这里（绝不创建 exports 记录）。
    if (req.method === 'POST' && url.pathname === '/export') {
      if (!fs.existsSync(docPath(id))) return sendJson(404, { ok: false, error: 'doc not found' });
      // S4a 上线后修复1：服务端导出门控——新建与复用分支同检（不依赖页面按钮禁用）；
      // 已生成产物的历史访问走 /history-pdf?exportId=，独立语义保留。
      const preMeta = loadMeta()[id] || {};
      const preConflicts = pendingConflictsOf(preMeta);
      if (preConflicts.length) {
        return sendJson(409, { ok: false, error: '存在 ' + preConflicts.length + ' 条未解决事实冲突（pending/skipped），不能导出', conflicts: preConflicts.map((c) => ({ id: c.id, section: c.section || '', reason: c.reason || '' })) });
      }
      const rst0 = currentRenderState(id);
      let frozen = rst0.frozen;
      // 不可复现输入（remote URL / 缺失资源）→ 拒绝导出（spec §12.1：普通渲染允许，POST /export 拒绝并提示先本地化）
      if (!frozen.reproducible) {
        return sendJson(409, { ok: false, error: '文档包含不可复现资源（远程 URL 或缺失文件），请先本地化后再导出', remote: frozen.remote, missing: frozen.missing });
      }
      const findEx = (rid) => exportsOf(loadMeta()[id] || {}).find((e) => e && e.renderInputId === rid) || null;
      const respondReuse = (e) => sendJson(200, { ok: true, exportId: e.exportId, url: '/history-pdf?exportId=' + encodeURIComponent(e.exportId), renderInputId: e.renderInputId, file: e.file, reused: true });
      // 同身份已有记录且产物在 → 完全复用（重复点击/重试不再渲染、不再快照、不再记录）
      let ex = findEx(frozen.renderInputId);
      if (ex && fs.existsSync(histPathOf(id, frozen.renderInputId))) return respondReuse(ex);
      if (!fs.existsSync(histPathOf(id, frozen.renderInputId))) {
        const r = await renderCurrent(id, { lease: leaseOf(req) });   // 便利文件 pdfs/<id>.pdf + lastRenderInputId 记账（当前文档渲染唯一入口）
        if (!r.ok) return sendJson(500, { ok: false, error: '渲染失败，未写入导出记录（详见服务日志）' });
        frozen = r.frozen;
        const hf = histPathOf(id, frozen.renderInputId);
        if (!fs.existsSync(hf)) {
          // S1-8 修复轮1 Important-1（remedy ②）：不可变产物由本次冻结输入直渲到 history tmp，再 linkSync 独占物化——
          // 绝不复制共享 pdfs/<id>.pdf（并发渲染器在渲染与物化之间原子替换共享文件会让产物名实错乱，直渲消除该窗口）。
          // 名实校验：渲染后读 <tmp>.env.json 旁车，renderInputId 必须 === 本次冻结身份；不匹配/缺失 → 删 tmp、500（可重试）。
          // linkSync EEXIST → 并发请求已产出同身份产物 → 复用，绝不覆盖。
          fs.mkdirSync(path.dirname(hf), { recursive: true });
          const srcTmp = path.join(os.tmpdir(), `resume-export-frozen-${id}-${Date.now()}-${process.pid}.html`);
          // 临时路径必须唯一：并发两个 /export 同 pid 同毫秒会算出同一个 tmp → 发布阶段互相覆盖
          const tmp = `${hf}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
          const side = tmp + '.env.json';
          atomicWrite(srcTmp, frozen.html);
          let hok = false;
          try {
            const hr = await renderDoc({
              src: srcTmp,
              out: tmp,
              env: { RESUME_RENDER_INPUT_ID: frozen.renderInputId, RESUME_RENDER_REPRODUCIBLE: frozen.reproducible ? '1' : '0' },
              lease: leaseOf(req)          // 透传闸门租约：否则一次请求占两个渲染槽
            });
            hok = hr.ok;
            let sideRid = null;
            try { sideRid = JSON.parse(fs.readFileSync(side, 'utf8')).renderInputId; } catch {}
            hok = hok && fs.existsSync(tmp) && sideRid === frozen.renderInputId;
          } finally {
            try { fs.unlinkSync(srcTmp); } catch {}
          }
          if (!hok) {
            console.error(`[export] 产物名实校验失败 id=${id} renderInputId=${frozen.renderInputId}（渲染失败或旁车标识不匹配），已删 tmp，可重试`);
            try { fs.unlinkSync(tmp); } catch {}
            try { fs.unlinkSync(side); } catch {}
            return sendJson(500, { ok: false, retry: true, error: '导出产物校验失败（渲染失败或 renderInputId 不匹配），未写入产物与记录，可重试' });
          }
          try { fs.linkSync(tmp, hf); }
          catch (e) {
            try { fs.unlinkSync(tmp); } catch {}
            try { fs.unlinkSync(side); } catch {}
            if (e.code !== 'EEXIST') throw e;
          }
          try { fs.unlinkSync(tmp); } catch {}
          try { fs.unlinkSync(side); } catch {}
        }
      }
      // 并发窗口内他人已补记录 → 复用（本路径只补缺失记录，不产生重复）
      ex = findEx(frozen.renderInputId);
      if (ex && fs.existsSync(histPathOf(id, frozen.renderInputId))) return respondReuse(ex);
      // 冻结快照（exports[].snapTs 引用；投递存档从此快照渲染，绝不重冻后来编辑的正文）——冻结的是本任务渲染输入，不是"当前"正文
      const metaNow = loadMeta()[id] || {};
      const sDir = snapDir(id);
      fs.mkdirSync(sDir, { recursive: true });
      const snapTs = timestamp();
      atomicWrite(path.join(sDir, snapTs + '.html'), frozen.html);
      atomicWrite(path.join(sDir, snapTs + '.manifest.json'), JSON.stringify(buildManifest(frozen, frozen.html, metaNow)));
      let pages = 0;
      try { pages = parseInt(execFileSync('pdfinfo', [histPathOf(id, frozen.renderInputId)], { timeout: 10000 }).toString().match(/Pages:\s*(\d+)/)?.[1] || '0', 10); } catch { pages = 0; }
      // 测试钩子：模拟"文件已生成、记录写入失败"（重试须复用文件并补记录）
      const recFailFile = process.env.RESUME_TEST_EXPORT_RECORD_FAIL_FILE;
      if (recFailFile && fs.existsSync(recFailFile)) throw Object.assign(new Error('测试钩子：导出记录写入失败（文件已存在，重试应复用并补记录）'), { httpCode: 500 });
      const rec = {
        exportId: randomUUID(),                                   // 全局唯一关联键（applications 条目引用）
        snapTs,                                                   // 冻结快照引用（配额豁免；投递存档渲染源）
        renderInputId: frozen.renderInputId,                      // 完整 40hex（幂等键）
        file: path.join('pdfs', 'history', `${id}@${frozen.renderInputId}.pdf`),   // 不可变产物（相对数据根）
        at: new Date().toISOString(),
        jobId: kindOf(metaNow) === 'job' ? id : null,             // 岗位草稿导出 → 草稿文档 id；母版 → null
        bodyHash: frozen.bodyHash,
        pages,
        overpage: pages > (Number(metaNow.job && metaNow.job.brief && metaNow.job.brief.pages) || 2),   // S4a-T10：超页标记
        company: metaNow.company || '',                           // S4a-T10：导出记录五要素（公司/岗位/正文 rev/页数/超页）
        role: metaNow.role || '',
        rev: Number(metaNow.rev) || 0,
        theme: metaNow.theme || normalizeToCurrent(frozen.html).theme || null
      };
      let out = null;
      updateMeta(root, id, (m) => {
        const base = { ...(m || {}) };
        const list = exportsOf(base);
        const hit = list.find((e) => e && e.renderInputId === frozen.renderInputId);
        if (hit) { out = hit; return base; }   // 原子去重（幂等键 renderInputId）：并发先到者胜，后到者复用同一记录
        out = rec;
        base.exports = list.concat([rec]);
        return base;
      });
      try { pruneSnapshots(id, sDir); } catch {}   // 导出冻结快照同受配额（被 exports 引用者经 protectedSnaps 豁免；并发落败方的孤儿快照可被清理）
      return sendJson(200, { ok: true, exportId: out.exportId, url: '/history-pdf?exportId=' + encodeURIComponent(out.exportId), renderInputId: out.renderInputId, file: out.file, reused: out !== rec });
    }
    // ===== S4a-T10：应用本轮排版建议（半自动第 N 轮；typo 通道 meta.typo + layoutRounds+1 → 重渲染）=====
    if (req.method === 'POST' && url.pathname === '/export/layout-apply') {
      if (!fs.existsSync(docPath(id))) return sendJson(404, { ok: false, error: 'doc not found' });
      const body = JSON.parse(await readBody(req) || '{}');
      const FLOORS = { fontSize: 12, lineHeight: 1.3, paraGap: 0.4 };
      const v = { fontSize: Number(body.fontSize), lineHeight: Number(body.lineHeight), paraGap: Number(body.paraGap) };
      for (const k of Object.keys(FLOORS)) {
        if (!Number.isFinite(v[k])) return sendJson(400, { ok: false, error: k + ' 必须是数字' });
        if (v[k] < FLOORS[k]) return sendJson(400, { ok: false, error: k + ' 低于最小可读下限（' + FLOORS[k] + '）' });
      }
      const m0 = loadMeta()[id] || {};
      // AUD-13：最终读取状态下复核前置 —— 陈旧页面不能直接盖章
      //   ① 排版轮次上限（3 轮）：到顶就不再接受新的排版应用
      if ((Number(m0.layoutRounds) || 0) >= 3) {
        return sendJson(409, { ok: false, error: '已达排版迭代 3 轮上限，不再接受新的排版应用（请人工取舍或走超页导出）' });
      }
      const rounds = (Number(m0.layoutRounds) || 0) + 1;
      const t = String(m0.typo || '');
      const css = '/*TYPO-CUSTOM*/'
        + 'body{font-size:' + v.fontSize + 'px;line-height:' + v.lineHeight + '}'
        + (t.match(/\.sheet\{[^}]*\}/) ? '' : '.sheet{padding-top:9.4mm;padding-bottom:9.4mm}')
        + '.plain-lines p{margin-bottom:' + v.paraGap + 'mm}li{margin-top:' + v.paraGap + 'mm;margin-bottom:' + v.paraGap + 'mm}'
        + (t.match(/\.section\{[^}]*\}/) || '.section{margin-top:2.9mm}');
      // typo CSS 其余字段（页边距/章节距）原值保留：从旧 CSS 抽取缺失字段用默认值拼回
      const cssFull = t.includes('/*TYPO-CUSTOM*/') ? t
        .replace(/body\{[^}]*\}/, 'body{font-size:' + v.fontSize + 'px;line-height:' + v.lineHeight + '}')
        .replace(/\.plain-lines p\{margin-bottom:[\d.]+mm\}/, '.plain-lines p{margin-bottom:' + v.paraGap + 'mm}')
        .replace(/li\{margin-top:[\d.]+mm;margin-bottom:[\d.]+mm\}/g, 'li{margin-top:' + v.paraGap + 'mm;margin-bottom:' + v.paraGap + 'mm}')
        : css;
      updateMeta(root, id, (m) => ({ ...(m || {}), typo: cssFull, layoutRounds: rounds }));
      const r = await renderCurrent(id, { lease: leaseOf(req) });
      if (!r.ok) return sendJson(500, { ok: false, error: '重渲染失败（详见服务日志），参数已保存，可重试' });
      const rst = currentRenderState(id);
      let pages = 0;
      try { pages = parseInt(execFileSync('pdfinfo', [pdfPath(id)], { timeout: 10000 }).toString().match(/Pages:\s*(\d+)/)?.[1] || '0', 10); } catch { pages = 0; }
      return sendJson(200, { ok: true, rounds, pages, typo: cssFull });
    }
    // ===== 不可变导出产物下载（S1-T8）：按 exportId（全局唯一）跨文档 meta.exports 查找并伺服；纯读 =====
    if (req.method === 'GET' && url.pathname === '/history-pdf') {
      const exportId = String(url.searchParams.get('exportId') || '');
      if (!exportId || exportId.length > 64) return send(400, 'exportId required', 'text/plain');
      const metaAll = loadMeta();
      let docId = null, entry = null;
      for (const k of Object.keys(metaAll)) {
        const hit = exportsOf(metaAll[k]).find((e) => e && e.exportId === exportId);
        if (hit) { docId = k; entry = hit; break; }
      }
      if (!entry) return send(404, '导出记录不存在（exportId=' + exportId.slice(0, 64) + '）', 'text/plain');
      const rel = path.normalize(String(entry.file || ''));
      if (path.isAbsolute(rel) || rel.startsWith('..')) return send(500, '导出记录 file 路径非法（拒绝访问数据根之外）', 'text/plain');
      const f = path.join(root, rel);
      // 缺失产物提示（S1-T9，Task 8 review Minor-2）：重新 POST /export 只有在文档身份（renderInputId）未变时才会命中幂等键修复本记录
      if (!fs.existsSync(f)) return send(404, '导出记录存在但产物文件缺失：' + rel + '（仅当文档身份 renderInputId 未变时，重新 POST /export 才会复用并修复本记录；身份已变则只会生成新导出，本记录仍缺失）', 'text/plain');
      const name = sanitizeFileName(docId + '_' + String(entry.at || '').slice(0, 10)) + '.pdf';
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; ' + dispositionFileName(name) });
      return fs.createReadStream(f).on('error', () => res.destroy()).pipe(res);
    }
    // ===== 投递：冻结内容 + 从冻结内容生成存档 PDF =====
    // S1-T8：带 exportId 时绑定该导出的冻结快照（存档 PDF 从它渲染，绝不重冻后来编辑的正文）；
    // 无 exportId（看板表单等旧入口）保持既有行为：现场冻结当前内容。
    if (req.method === 'POST' && url.pathname === '/app/add') {
      const body = JSON.parse(await readBody(req));
      if (typeof body.company !== 'string' || !body.company.trim() || typeof body.role !== 'string' || !body.role.trim())
        return send(400, 'company 和 role 必填', 'text/plain');
      if (!body.docId || !VALID_ID.test(body.docId)) return send(400, 'invalid docId', 'text/plain');
      if (!fs.existsSync(docPath(body.docId))) return send(404, 'doc not found', 'text/plain');
      const exportId = (typeof body.exportId === 'string' && body.exportId.trim()) ? body.exportId.trim() : '';
      const now = timestamp();
      let snapTs, frozenFile;
      if (exportId) {
        const entry = exportsOf(loadMeta()[body.docId] || {}).find((e) => e && e.exportId === exportId);
        if (!entry) return sendJson(404, { ok: false, error: 'exportId 不存在（请先在导出页创建导出记录，再记录投递）' });
        const f = path.join(snapDir(body.docId), String(entry.snapTs || '').replace(/[^0-9-]/g, '') + '.html');
        if (!entry.snapTs || !fs.existsSync(f)) return sendJson(409, { ok: false, error: '导出对应的冻结快照缺失，无法绑定投递（请先重新导出）' });
        snapTs = entry.snapTs;
        frozenFile = f;
      } else {
        snapTs = timestamp();
        const sDir = snapDir(body.docId);
        fs.mkdirSync(sDir, { recursive: true });
        frozenFile = path.join(sDir, snapTs + '.html');
        // 冻结点：freezeHtml（内联当时 meta.typo、自包含）+ manifest 全字段；存档 PDF 从冻结内容渲染（铁律二）
        writeFrozenSnapshot(sDir, snapTs, fs.readFileSync(docPath(body.docId), 'utf8'), loadMeta()[body.docId] || {});
      }
      const hash = contentHash(fs.readFileSync(frozenFile, 'utf8'));
      fs.mkdirSync(path.join(root, 'pdfs', 'archive'), { recursive: true });
      const out = archivePath(now);
      const archiveR = await renderDoc({ src: frozenFile, out, lease: leaseOf(req) });
      const archiveOk = archiveR.ok;  // 从冻结内容生成，绝不复用旧 PDF、绝不重冻当前正文
      const apps = loadApps();
      apps.push({
        id: now, company: body.company.trim(), role: body.role.trim(), docId: body.docId,
        jd: typeof body.jd === 'string' ? body.jd.trim().slice(0, JD_MAX_CHARS) : '',   // S4B-12
        note: typeof body.note === 'string' ? body.note : '',
        channel: typeof body.channel === 'string' ? body.channel.trim() : '',
        link: safeUrl(body.link),   // S4B-9：白名单外协议不落库（javascript:/data: 存储型 XSS）
        appliedAt: typeof body.appliedAt === 'string' ? body.appliedAt : '',
        nextStep: typeof body.nextStep === 'string' ? body.nextStep.trim() : '',
        dueDate: typeof body.dueDate === 'string' ? body.dueDate : '',
        snapTs, exportId: exportId || null, contentHash: hash, status: '已投递', createdAt: now, updatedAt: now,
        archive: archiveOk && fs.existsSync(out)
          ? { status: 'ok', generatedAt: now, hash }
          : { status: 'failed', hash, error: '渲染失败，未生成存档 PDF' }
      });
      saveApps(apps);
      return sendJson(200, { ok: true, id: now, archiveOk: archiveOk && fs.existsSync(out), warning: archiveOk ? null : '存档 PDF 生成失败：已记录投递与内容快照，但存档 PDF 缺失（可在详情页从快照重新生成）' });
    }
    if (req.method === 'POST' && url.pathname === '/app/update') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      if (body.status !== undefined && !APP_STATUSES.includes(body.status)) return send(400, '非法 status', 'text/plain');
      if (typeof body.jd === 'string' && body.jd.length > JD_MAX_CHARS) body.jd = body.jd.slice(0, JD_MAX_CHARS);   // 与 /app/add 同上限（2026-10-22 审查 [中]）
      if (body.docId !== undefined && (!VALID_ID.test(body.docId) || !fs.existsSync(docPath(body.docId)))) return send(400, 'invalid docId', 'text/plain');
      const apps = loadApps();
      const app = apps.find((a) => a.id === body.id);
      if (!app) return send(404, 'app not found', 'text/plain');
      for (const k of ['company', 'role', 'note', 'jd', 'docId', 'channel', 'link', 'appliedAt', 'nextStep', 'dueDate', 'interviews']) {
        if (body[k] === undefined) continue;
        // S4B-9：link 走协议白名单，其余字段原样赋值（这个循环是批量赋值，
        // 漏一个字段就是缺口——app/add 已单独清洗，这里必须同步，否则 update 能绕过）
        app[k] = k === 'link' ? safeUrl(body[k]) : body[k];
      }
      if (body.status !== undefined) app.status = body.status;
      app.updatedAt = timestamp();
      saveApps(apps);
      return sendJson(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/app/del') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const apps = loadApps();
      if (!apps.some((a) => a.id === body.id)) return send(404, 'app not found', 'text/plain');
      saveApps(apps.filter((a) => a.id !== body.id));
      return sendJson(200, { ok: true });
    }
    // 存档 PDF：缺失明确标注；重新生成只从冻结快照还原（不用当前文档冒充）
    if (req.method === 'GET' && url.pathname === '/archive-pdf') {
      const aid = url.searchParams.get('id') || '';
      if (!/^[0-9-]+$/.test(aid)) return send(400, 'invalid id', 'text/plain');
      const p = archivePath(aid);
      if (!fs.existsSync(p)) return send(404, '该投递没有存档 PDF（当时生成失败或文件缺失）。可在投递详情页点「从快照重新生成存档」。', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="archive-${aid}.pdf"` });
      return fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/app/archive-regenerate') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const apps = loadApps();
      const app = apps.find((a) => a.id === body.id);
      if (!app) return sendJson(404, { ok: false, error: 'app not found' });
      const frozen = path.join(snapDir(app.docId), String(app.snapTs || '').replace(/[^0-9-]/g, '') + '.html');
      if (!app.snapTs || !fs.existsSync(frozen)) return sendJson(409, { ok: false, error: '原始内容快照已缺失，无法还原当时版本（不允许用当前文档冒充）' });
      const archR2 = await renderDoc({ src: frozen, out: archivePath(app.id), lease: leaseOf(req) });
      const ok = archR2.ok;
      app.archive = ok && fs.existsSync(archivePath(app.id))
        ? { status: 'ok', generatedAt: timestamp(), hash: app.contentHash || '' }
        : { status: 'failed', hash: app.contentHash || '', error: '渲染失败' };
      app.updatedAt = timestamp();
      saveApps(apps);
      return sendJson(ok ? 200 : 500, { ok, error: ok ? null : '渲染失败' });
    }
    // ===== 跟进助手（批 3 卡片 b3c4）：投递卡「无回应满 N 天」→ 生成跟进语草稿（只生成，不发送）=====
    // 账本适配器：applications.json 的唯一写者仍是 server.mjs —— 写时重新读表、**只回写本卡的 followUp 字段**，
    // 不拿旧副本覆盖别人刚改的备注/状态/面试记录。
    const followUpLedger = {
      read(id) {
        const a = loadApps().find((x) => x.id === id);
        return a ? { app: a } : null;
      },
      write(next) {
        const apps = loadApps();
        const i = apps.findIndex((x) => x.id === next.id);
        if (i < 0) return false;
        apps[i] = { ...apps[i], followUp: next.followUp };
        saveApps(apps);
        return true;
      },
    };
    // 生成：原子登记任务（并发闸：同一条投递同时只允许 1 个）→ fire-and-forget 跑模型；
    // 结果只经完成判定（gen-result.mjs 的纯函数）落「草稿」，**不发送、不入库任何字段包**。
    if (req.method === 'POST' && url.pathname === '/app/followup/start') {
      const body = await readBodyAuto(req);
      const id = String(body.id || '');
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      const rec = followUpLedger.read(id);
      if (!rec) return sendJson(404, { ok: false, error: 'app not found' });
      // 无模型 → 明确降级（不做「点了才知道」的死路；措辞与页面同源）
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: FOLLOW_UP_NO_MODEL_HINT });
      // 无取材简历 → 明确拒绝（不留注定失败的 running 任务）
      if (!followUpSource(root, rec.app)) return sendJson(409, { ok: false, error: '还没有可依据的简历：这条投递关联的简历不在本机（请先在投递详情里确认简历）' });
      // 资源准入（与 /apply/copy/start 同口径）：先借 AI 槽，拿不到立刻拒 → 不留 running 假任务
      let lease;
      try { lease = aiPool.borrow(); }
      catch (e) { return sendJson((e && e.httpCode) || 429, { ok: false, error: (e && e.message) || 'AI 排队已满，请稍候' }); }
      const model = (() => { try { const c = loadProfiles(root); return (c && c.profiles && c.profiles[c.active]) ? c.profiles[c.active].model : null; } catch { return null; } })();
      let taskId = null, reject = null;
      try {
        const st = startFollowUpTask(followUpLedger, id, { model });
        taskId = st.taskId; reject = st.reject;
      } catch (e) {
        try { lease.release(); } catch {}
        return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' });
      }
      if (reject) { try { lease.release(); } catch {} return sendJson(reject.status, { ok: false, error: reject.error }); }
      runFollowUpTask(root, followUpLedger, id, taskId, { lease })
        .catch((e) => {
          // 任何异常都要收敛任务态：否则账本里会留下永远 running 的假任务
          try { failFollowUpTask(followUpLedger, id, taskId, '任务失败：' + ((e && e.message) || e)); } catch {}
        })
        .finally(() => { try { lease.release(); } catch {} });
      return sendJson(200, { ok: true, taskId, status: 'running' });
    }
    // 任务状态（轮询用）：只给真实阶段与真实用量，**无百分比**。
    if (req.method === 'GET' && url.pathname === '/app/followup/state') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      const st = followUpStateOf(followUpLedger, id);
      if (!st) return sendJson(404, { ok: false, error: 'app not found' });
      const draft = st.draft ? { id: st.draft.id, text: st.draft.text, createdAt: st.draft.createdAt } : null;
      return sendJson(200, { ok: true, task: st.task || null, draft, ttlMs: FOLLOW_UP_TTL_MS });
    }
    // 取消：taskId 匹配当前 running 才置 cancelled；在途结果被完成判定丢弃（零落账）。
    if (req.method === 'POST' && url.pathname === '/app/followup/cancel') {
      const body = await readBodyAuto(req);
      const id = String(body.id || '');
      const taskId = String(body.taskId || '');
      if (!/^[0-9-]+$/.test(id) || !taskId) return sendJson(400, { ok: false, error: 'id 与 taskId 必填' });
      let cancelled = false;
      try { cancelled = cancelFollowUpTask(followUpLedger, id, taskId); }
      catch (e) { return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' }); }
      if (!cancelled) return sendJson(409, { ok: false, error: '任务已结束或已被新任务取代（taskId 不匹配当前 running）' });
      return sendJson(200, { ok: true });
    }
    // 丢弃草稿：草稿只是本机的待用文本，丢弃即清稿。
    if (req.method === 'POST' && url.pathname === '/app/followup/discard') {
      const body = await readBodyAuto(req);
      const id = String(body.id || '');
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      try { discardFollowUpDraft(followUpLedger, id); }
      catch (e) { return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' }); }
      return sendJson(200, { ok: true });
    }
    // ===== 练习会话（批 4 卡片 b4c1）：出题复用 kind=interview 产物 + 逐题作答 + AI 对照证据表反馈 =====
    // 可练性判定（批 4 卡片 b4c2 抽成单一通道）：/app/practice/start 的 409 拒绝与投递详情「面试练习」区的
    // 空态/降级文案共用同一份判定与同一份文案（UI 不另抄一份会漂移的复制品）；只读零写盘。
    // ok 时带出 buildPracticeSession 的成品快照（start 直接落账它；页面只用 ok/reason，不落任何东西）。
    const practiceGate = (app) => {
      const docId = String(app.docId || '');
      if (!docId) return { ok: false, reason: '这条投递还没有关联简历，练习出题无从取材' };
      const meta = loadMeta()[docId];
      const j = (meta && meta.job) ? meta.job : null;
      if (!j) return { ok: false, reason: '还没有可练习的面试追问：这条投递关联的简历不是岗位草稿（练习出题复用岗位草稿的「面试追问」产物）' };
      const iv = (j.interview && typeof j.interview === 'object') ? j.interview : null;
      if (!iv) return { ok: false, reason: '还没有可练习的面试追问：这份岗位草稿还没生成「面试追问」，请先在编辑器里生成后再来练习' };
      let html = null;
      try { html = fs.readFileSync(docPath(docId), 'utf8'); } catch {}
      if (html == null) return { ok: false, reason: '这条投递关联的简历不在本机，练习出题无从取材（请先在投递详情里确认简历）' };
      const paras = parasOf(html);
      const ivView = interviewSourceView(iv, { paras });
      const evGenBound = (typeof j.interviewEvidenceGen === 'number' && j.interviewEvidenceGen !== Number(j.evidenceGen || 0));
      const bindingFresh = !evGenBound;   // 与 S4B-3 stale 判定同口径：字段缺失视为仍绑定（宽容读），字段在且不同 → 已换批
      const interviewStale = !!(j.interviewBaseHash && (
        j.interviewBaseHash !== contentHash(html) || evGenBound));
      const session = buildPracticeSession({
        docId, company: String(app.company || ''), role: String(app.role || ''),
        interviewView: ivView, evidence: Array.isArray(j.evidence) ? j.evidence : [],
        bindingFresh, interviewStale,
        interviewGen: Number.isInteger(j.interviewGen) ? j.interviewGen : null,
        evidenceGen: Number.isInteger(j.evidenceGen) ? j.evidenceGen : null,
      });
      if (!session) return { ok: false, reason: '还没有可练习的面试追问：这份岗位草稿的「面试追问」没有任何可用要点，请先在编辑器里重新生成' };
      return { ok: true, session };
    };
    // 账本适配器（followUpLedger 同款）：applications.json 的唯一写者仍是 server.mjs —— 写时重新读表、
    // **只回写本卡的 practice 字段**，不拿旧副本覆盖别人刚改的备注/状态/面试记录/followUp。
    const practiceLedger = {
      read(id) {
        const a = loadApps().find((x) => x.id === id);
        return a ? { app: a } : null;
      },
      write(next) {
        const apps = loadApps();
        const i = apps.findIndex((x) => x.id === next.id);
        if (i < 0) return false;
        apps[i] = { ...apps[i], practice: next.practice };
        saveApps(apps);
        return true;
      },
    };
    // 出题（零模型调用）：判定与文案走 practiceGate 单一通道（与详情页空态同源）；链题仅在追问仍绑定
    // 当前证据批次时快照对应要求行 req。没有关联简历 / 不是岗位草稿 / 没有面试追问 / 没有可用要点 →
    // 409 明确拒绝，不留空会话。
    if (req.method === 'POST' && url.pathname === '/app/practice/start') {
      const body = await readBodyAuto(req);
      const id = String(body.id || '');
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      const rec = practiceLedger.read(id);
      if (!rec) return sendJson(404, { ok: false, error: '投递记录不存在' });
      const gate = practiceGate(rec.app);
      if (!gate.ok) return sendJson(409, { ok: false, error: gate.reason });
      const appended = appendPracticeSession(practiceLedger, id, gate.session);
      if (!appended.ok) return sendJson(appended.status || 404, { ok: false, error: appended.error });
      return sendJson(200, { ok: true, pid: gate.session.pid });
    }
    // 练习历史（摘要视图）：最新在前（appendPracticeSession 已保证），上限 PRACTICE_CAP=20（F3 同款）。
    if (req.method === 'GET' && url.pathname === '/app/practice/history') {
      const id = String(url.searchParams.get('id') || '');
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      const rec = practiceLedger.read(id);
      if (!rec) return sendJson(404, { ok: false, error: '投递记录不存在' });
      return sendJson(200, { ok: true, sessions: practiceSessions(rec.app).map(sessionSummary), cap: PRACTICE_CAP });
    }
    // 单个会话全量状态（轮询用）：practiceSessionView 只加派生的 expired 标记，**零写盘**——
    // 过期 running 的写盘收敛统一交给完成判定的 TTL 分支，读取路径不做写（并发闸已忽略过期残留，不会死锁）。
    if (req.method === 'GET' && url.pathname === '/app/practice/state') {
      const id = String(url.searchParams.get('id') || '');
      const pid = String(url.searchParams.get('pid') || '');
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      if (!pid) return sendJson(400, { ok: false, error: 'pid 必填' });
      const rec = practiceLedger.read(id);
      if (!rec) return sendJson(404, { ok: false, error: '投递记录不存在' });
      const session = findSession(rec.app, pid);
      if (!session) return sendJson(404, { ok: false, error: '练习会话不存在或已被清理（历史保留最近 ' + PRACTICE_CAP + ' 次）' });
      return sendJson(200, { ok: true, session: practiceSessionView(session) });
    }
    // 逐题文本作答：形状错即拒（空/超长 400）；重交 = 最近一次为准。
    if (req.method === 'POST' && url.pathname === '/app/practice/answer') {
      const body = await readBodyAuto(req);
      const id = String(body.id || '');
      const pid = String(body.pid || '');
      const qid = String(body.qid || '');
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      if (!pid || !qid) return sendJson(400, { ok: false, error: 'pid 与 qid 必填' });
      const norm = normalizeAnswerText(body.text);
      if (!norm.ok) return sendJson(400, { ok: false, error: norm.error });
      const saved = savePracticeAnswer(practiceLedger, id, pid, qid, norm.text);
      if (!saved.ok) return sendJson(saved.status || 404, { ok: false, error: saved.error });
      return sendJson(200, { ok: true });
    }
    // 反馈生成（走既有 genTasks 口径）：先作答才生成；先借 AI 槽再登记任务（不留 running 假任务）；
    // 并发闸：同一条投递跨会话只允许 1 个 running。
    if (req.method === 'POST' && url.pathname === '/app/practice/feedback/start') {
      const body = await readBodyAuto(req);
      const id = String(body.id || '');
      const pid = String(body.pid || '');
      const qid = String(body.qid || '');
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      if (!pid || !qid) return sendJson(400, { ok: false, error: 'pid 与 qid 必填' });
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: PRACTICE_NO_MODEL_HINT });
      let lease;
      try { lease = aiPool.borrow(); }
      catch (e) { return sendJson((e && e.httpCode) || 429, { ok: false, error: (e && e.message) || 'AI 排队已满，请稍候' }); }
      const model = (() => { try { const c = loadProfiles(root); return (c && c.profiles && c.profiles[c.active]) ? c.profiles[c.active].model : null; } catch { return null; } })();
      let taskId = null, reject = null;
      try {
        const st = startPracticeFeedbackTask(practiceLedger, id, pid, qid, { model });
        taskId = st.taskId; reject = st.reject;
      } catch (e) {
        try { lease.release(); } catch {}
        return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' });
      }
      if (reject) { try { lease.release(); } catch {} return sendJson(reject.status, { ok: false, error: reject.error }); }
      runPracticeFeedbackTask(root, practiceLedger, id, pid, qid, taskId, { lease })
        .catch((e) => {
          // 任何异常都要收敛任务态：否则账本里会留下永远 running 的假任务
          try { failPracticeFeedbackTask(practiceLedger, id, pid, qid, taskId, '任务失败：' + ((e && e.message) || e)); } catch {}
        })
        .finally(() => { try { lease.release(); } catch {} });
      return sendJson(200, { ok: true, taskId, status: 'running' });
    }
    // 取消反馈生成：taskId 匹配当前 running 才置 cancelled；在途结果被完成判定丢弃（零落账）。
    if (req.method === 'POST' && url.pathname === '/app/practice/feedback/cancel') {
      const body = await readBodyAuto(req);
      const id = String(body.id || '');
      const pid = String(body.pid || '');
      const qid = String(body.qid || '');
      const taskId = String(body.taskId || '');
      if (!/^[0-9-]+$/.test(id) || !pid || !qid || !taskId) return sendJson(400, { ok: false, error: 'id、pid、qid 与 taskId 必填' });
      let cancelled = false;
      try { cancelled = cancelPracticeFeedbackTask(practiceLedger, id, pid, qid, taskId); }
      catch (e) { return sendJson((e && e.httpCode) || 400, { ok: false, error: String((e && e.message) || e), code: (e && e.code) || '' }); }
      if (!cancelled) return sendJson(409, { ok: false, error: '任务已结束或已被新任务取代（taskId 不匹配当前 running）' });
      return sendJson(200, { ok: true });
    }
    // 缺的素材一键转「待补充素材」（批 4 卡片 b4c2）：反馈里「缺的指标或事实」某一项 → 素材库占位条目。
    // 条目形状与 /mat/add 完全一致（零新字段，备份/恢复/合并路径不受影响）；factStatus=pending +
    // 「待补充」标签——它只是占位提醒，事实层待用户补齐后再确认。文本取落账的 result.missing[index]
    //（服务端按账建条目，不信客户端传文）；会话侧 missingMats 记轻量关联（practice.mjs linkMissingMaterial）。
    // 幂等：同一缺项已转过且素材还在 → 原样返回既有 matId；素材被用户删掉 → 重建并改链（素材库是事实源）。
    if (req.method === 'POST' && url.pathname === '/app/practice/missing/material') {
      const body = await readBodyAuto(req);
      const id = String(body.id || '');
      const pid = String(body.pid || '');
      const qid = String(body.qid || '');
      const index = body.index;
      if (!/^[0-9-]+$/.test(id)) return sendJson(400, { ok: false, error: 'invalid id' });
      if (!pid || !qid) return sendJson(400, { ok: false, error: 'pid 与 qid 必填' });
      if (!Number.isInteger(index) || index < 0) return sendJson(400, { ok: false, error: 'index 必须是非负整数' });
      const rec = practiceLedger.read(id);
      if (!rec) return sendJson(404, { ok: false, error: '投递记录不存在' });
      const session = findSession(rec.app, pid);
      if (!session) return sendJson(404, { ok: false, error: '练习会话不存在或已被清理（历史保留最近 ' + PRACTICE_CAP + ' 次）' });
      if (!findQuestion(session, qid)) return sendJson(404, { ok: false, error: '问题不存在（qid 不在这条练习里）' });
      const result = feedbackResultOf(session, qid);
      const missing = (result && Array.isArray(result.missing)) ? result.missing : null;
      if (!missing || index >= missing.length || !String(missing[index] || '').trim()) {
        return sendJson(400, { ok: false, error: '这一题没有对应的缺项记录（反馈可能已重新生成），请刷新后再试' });
      }
      const links = missingMatLinkOf(session, qid);
      const prev = links[String(index)];
      const mats = loadMats();
      if (prev && prev.matId && mats.some((m) => m.id === prev.matId)) {
        return sendJson(200, { ok: true, matId: prev.matId, existed: true });
      }
      const text = String(missing[index]).trim();
      const now = timestamp();
      mats.push({ id: now, title: ('待补充：' + text).slice(0, 60), brief: text,
        technical: '', interview: '', attach: '', tags: ['待补充'], factStatus: 'pending',
        createdAt: now, updatedAt: now });
      saveMats(mats);
      const linked = linkMissingMaterial(practiceLedger, id, pid, qid, index, now);
      if (!linked.ok) return sendJson(linked.status || 404, { ok: false, error: linked.error });
      return sendJson(200, { ok: true, matId: now });
    }
    // ===== 素材库（确认状态）=====
    if (req.method === 'GET' && url.pathname === '/materials') {
      const mats = loadMats();
      const unconfirmed = mats.filter((m) => m.factStatus !== 'confirmed').length;
      const FACT_LABELS = { company: '公司', role: '职位', dates: '日期', education: '学历', metrics: '成果指标', contribution: '个人贡献', conditions: '条件', source: '来源' };
      const matBadge = (s) => s === 'confirmed' ? badge('ok', '已确认') : s === 'outdated' ? badge('warn', '已过时') : badge('warn', '待确认');
      const matCard = (m) => `<div class="card mat-card" data-mat="${escAttr(m.id)}" style="margin:10px 0">
        <b>${escHtml(m.title)}</b>${(m.tags || []).map((t) => `<span class="badge">${escHtml(t)}</span>`).join('')}${matBadge(m.factStatus)}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:8px;font-size:13px">
          <div><b style="font-size:12px;color:var(--mut)">精简表达</b><div class="mat-brief">${escHtml(m.brief)}</div><button class="secondary" style="padding:2px 8px;font-size:12px" data-action="copyMat" data-k="brief">复制</button></div>
          <div><b style="font-size:12px;color:var(--mut)">技术表达</b><div class="mat-tech">${escHtml(m.technical || '')}</div><button class="secondary" style="padding:2px 8px;font-size:12px" data-action="copyMat" data-k="tech">复制</button></div>
          <div><b style="font-size:12px;color:var(--mut)">面试讲述</b><div class="mat-itv">${escHtml(m.interview || '')}</div><button class="secondary" style="padding:2px 8px;font-size:12px" data-action="copyMat" data-k="itv">复制</button></div>
        </div>
        ${(m.facts && Object.entries(m.facts).filter(([k, v]) => v).map(([k, v]) => `<div style="font-size:12px;color:var(--mut);margin-top:4px"><b style="color:var(--fg)">${escHtml(FACT_LABELS[k] || k)}</b>：${escHtml(v)}</div>`).join('')) || ''}
        ${m.attach ? `<div style="font-size:12px;color:var(--mut);margin-top:4px">附件：${escHtml(m.attach)}</div>` : ''}
        <div style="margin-top:6px;font-size:12px">${m.factStatus === 'confirmed'
          ? `<button class="secondary" data-action="matStatus" data-id="${escAttr(m.id)}" data-status="pending">取消确认</button>`
          : `<button data-action="matStatus" data-id="${escAttr(m.id)}" data-status="confirmed">确认可用于生成</button>`}
          ${m.factStatus !== 'outdated' ? `<button class="secondary" data-action="matStatus" data-id="${escAttr(m.id)}" data-status="outdated">标记过时</button>` : `<button class="secondary" data-action="matStatus" data-id="${escAttr(m.id)}" data-status="pending">恢复待确认</button>`}
          <button class="secondary" data-action="matEdit" data-id="${escAttr(m.id)}">${icon('pencil', 13)} 编辑</button> <button class="danger" data-action="matDel" data-id="${escAttr(m.id)}">${icon('trash-2', 13)} 删除</button></div>
        <details open style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;color:var(--mut)">事实层</summary>
          <form class="mat-facts" style="margin-top:6px;font-size:13px" data-action="matFacts" data-id="${escAttr(m.id)}">
            ${FACT_KEYS.map((k) => `<p style="margin:2px 0">${FACT_LABELS[k]} <input name="f_${k}" value="${escAttr((m.facts || {})[k] || '')}" style="width:60%"></p>`).join('')}
            <p style="margin:2px 0">状态 <select name="f_factStatus">
              <option value="pending"${m.factStatus === 'pending' ? ' selected' : ''}>待确认</option>
              <option value="confirmed"${m.factStatus === 'confirmed' ? ' selected' : ''}>已确认</option>
              <option value="outdated"${m.factStatus === 'outdated' ? ' selected' : ''}>已过时</option>
            </select></p>
            <button class="secondary" style="padding:2px 8px;font-size:12px">保存事实层</button>
          </form>
        </details>
      </div>`;
      return send(200, page('素材库', `<h1>素材库</h1>
    ${corruptBanner()}
    ${unconfirmed ? `<p style="margin:0 0 4px"><button class="secondary" data-action="matConfirmAll">全部标记已确认（先预览再用）</button></p>` : ''}
    <input id="matSearch" placeholder="搜索素材（标题/标签/内容）" style="width:100%;margin-bottom:10px" aria-label="搜索素材">
    <details class="card"><summary style="cursor:pointer;font-weight:700">＋ 新增素材</summary>
      <form id="matForm" style="margin-top:10px">
        <p>标题 <input id="mtitle" required></p>
        <p>标签（逗号分隔）<input id="mtags"></p>
        <p>精简表达<br><textarea id="mbrief" rows="2" cols="60" required></textarea></p>
        <p>技术表达<br><textarea id="mtech" rows="2" cols="60"></textarea></p>
        <p>面试讲述<br><textarea id="mitv" rows="2" cols="60"></textarea></p>
        <p>附件路径（可选）<input id="mattach"></p>
        <button>添加（默认待确认）</button><span id="matmsg"></span>
      </form>
    </details>
    <div id="matList">${mats.map(matCard).join('') || '<div style="color:var(--mut);text-align:center;padding:20px">暂无素材</div>'}</div>
    <script nonce="__CSP_NONCE__">var MATS = ${JSON.stringify(mats).replace(/</g, '\\u003c')};</script>
    <script nonce="__CSP_NONCE__">
      function copyMat(btn, key) {
        var card = btn.closest('.mat-card');
        var sel = card.querySelector(key === 'brief' ? '.mat-brief' : key === 'tech' ? '.mat-tech' : '.mat-itv');
        navigator.clipboard.writeText(sel.textContent).then(function () { btn.innerHTML = __STATUS_ICONS__.ok; setTimeout(function () { btn.textContent = '复制'; }, 800); });
      }
      function matStatus(id, s) {
        __wv('/mat/update', { id: id, factStatus: s }).then(function () { location.reload(); }).catch(function () {});
      }
      function matFacts(e, id) {
        e.preventDefault();
        var f = new FormData(e.target), facts = {};
        for (var en of f.entries()) if (en[0].indexOf('f_') === 0) facts[en[0].slice(2)] = en[1];
        var factStatus = facts.factStatus; delete facts.factStatus;
        var form = e.target;
        __wv('/mat/update', { id: id, facts: facts, factStatus: factStatus }).then(function () { location.reload(); }).catch(function (err) {
          matShowErr(form, '保存失败：' + (err.message || err) + '（输入已保留，可重试）');
        });
        return false;
      }
      function matConfirmAll() {
        var pend = MATS.filter(function (m) { return m.factStatus !== 'confirmed'; });   // S4a-T11：范围=待确认素材（文案明示）
        if (!pend.length) { alert('没有待确认的素材。'); return; }
        if (!confirm('将把 ' + pend.length + ' 条待确认素材标记为已确认——请先确认事实层内容准确。')) return;
        __wv('/mat/confirm', { ids: pend.map(function (m) { return m.id; }), confirmed: true }).then(function () { location.reload(); }).catch(function () {});
      }
      function matShowErr(form, msg) {
        var el = form.querySelector('.mat-err');
        if (!el) { el = document.createElement('div'); el.className = 'mat-err'; el.style.cssText = 'color:var(--err);font-size:12px;margin-top:4px'; form.appendChild(el); }
        el.textContent = msg;   // 保留输入：不清空、不 reload，可原样重试
      }
      function matEdit(id) {
        var m = MATS.find(function (x) { return x.id === id; });
        if (!m) return;
        var t = prompt('标题', m.title); if (t === null) return;
        var b = prompt('精简表达', m.brief); if (b === null) return;
        var te = prompt('技术表达', m.technical || ''); if (te === null) return;
        var iv = prompt('面试讲述', m.interview || ''); if (iv === null) return;
        var at = prompt('附件路径', m.attach || ''); if (at === null) return;
        __wv('/mat/update', { id: id, title: t, brief: b, technical: te, interview: iv, attach: at }).then(function () { location.reload(); }).catch(function () {});
      }
      function matDel(id) {
        if (!confirm('删除这条素材？')) return;
        __wv('/mat/del', { id: id }).then(function () { location.reload(); }).catch(function () {});
      }
      document.getElementById('matForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        try {
          await __wv('/mat/add', { title: document.getElementById('mtitle').value.trim(), brief: document.getElementById('mbrief').value.trim(),
            technical: document.getElementById('mtech').value.trim(), interview: document.getElementById('mitv').value.trim(),
            attach: document.getElementById('mattach').value.trim(), confirm: true,
            tags: document.getElementById('mtags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean) },
            document.getElementById('matmsg'));
          location.reload();
        } catch (err) {
          // __wv 已给出失败原因（业务失败/网络异常）；这里只补一句「输入已保留」
          __status(document.getElementById('matmsg'), 'err', '保存失败：' + (err.message || err) + '（输入已保留，可重试）');
        }
      });
      document.getElementById('matSearch').addEventListener('input', function () {
        var q = this.value.toLowerCase();
        document.querySelectorAll('.mat-card').forEach(function (c) {
          c.style.display = !q || c.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
      // ===== 内联 handler 委托化注册（b5c1）：data-action → 实现（与原内联 onclick/onsubmit 行为一致）=====
      var __acts = window.__acts || (window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} });
      __acts.click.copyMat = function (el) { copyMat(el, el.getAttribute('data-k')); };
      __acts.click.matStatus = function (el) { matStatus(el.getAttribute('data-id'), el.getAttribute('data-status')); };
      __acts.click.matEdit = function (el) { matEdit(el.getAttribute('data-id')); };
      __acts.click.matDel = function (el) { matDel(el.getAttribute('data-id')); };
      __acts.click.matConfirmAll = function (el) { return matConfirmAll(); };
      // 提交事件本就派发到表单自身（ev.target === form），matFacts 内部继续用 e.target 取 FormData
      __acts.submit.matFacts = function (el, ev) { return matFacts(ev, el.getAttribute('data-id')); };
    </script>`, 'docs'));
    }
    if (req.method === 'POST' && url.pathname === '/mat/add') {
      const body = JSON.parse(await readBody(req));
      if (typeof body.title !== 'string' || !body.title.trim() || typeof body.brief !== 'string' || !body.brief.trim())
        return send(400, 'title 和 brief 必填', 'text/plain');
      const now = timestamp();
      const mats = loadMats();
      // 事实层（S3-T7）：facts 按 FACT_KEYS 白名单逐键 String()；factStatus 三态枚举，缺省 pending
      const facts = body.facts && typeof body.facts === 'object'
        ? Object.fromEntries(FACT_KEYS.map((k) => [k, body.facts[k] === undefined || body.facts[k] === null ? '' : String(body.facts[k])])) : null;
      const factStatus = MAT_STATES.includes(body.factStatus) ? body.factStatus
        : body.confirm === true ? 'confirmed' : 'pending';
      mats.push({ id: now, title: body.title.trim(), brief: body.brief.trim(),
        technical: typeof body.technical === 'string' ? body.technical.trim() : '',
        interview: typeof body.interview === 'string' ? body.interview.trim() : '',
        attach: typeof body.attach === 'string' ? body.attach.trim() : '',
        tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : [],
        ...(facts ? { facts } : {}), factStatus,
        createdAt: now, updatedAt: now });
      saveMats(mats);
      return sendJson(200, { ok: true, id: now });
    }
    if (req.method === 'POST' && url.pathname === '/mat/update') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const mats = loadMats();
      const m = mats.find((x) => x.id === body.id);
      if (!m) return send(404, 'mat not found', 'text/plain');
      // 类型收敛（与 /mat/add 同口径）：原先原样覆盖，传字符串给 tags 会让 (m.tags||[]).map 抛 TypeError，
      // 传数字给 title/brief 同样会让模板里的 .trim() 崩 —— 两者都导致整个 /materials 页 500 且需手改 JSON 恢复
      for (const k of ['title', 'brief', 'technical', 'interview', 'attach']) if (typeof body[k] === 'string') m[k] = body[k];
      if (body.tags !== undefined) m.tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : [];
      // 事实层（S3-T7）：提供 facts 就按白名单整替；factStatus 走三态枚举
      if (body.facts && typeof body.facts === 'object')
        m.facts = Object.fromEntries(FACT_KEYS.map((k) => [k, body.facts[k] === undefined || body.facts[k] === null ? '' : String(body.facts[k])]));
      if (MAT_STATES.includes(body.factStatus)) m.factStatus = body.factStatus;
      m.updatedAt = timestamp();
      saveMats(mats);
      return sendJson(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/mat/confirm') {
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.ids)) return send(400, 'ids 必填数组', 'text/plain');
      const mats = loadMats();
      let n = 0;
      // 端点名/请求形状兼容既有前端（confirmed 布尔）——落盘走三态 factStatus
      for (const m of mats) if (body.ids.includes(m.id)) { m.factStatus = body.confirmed === true ? 'confirmed' : 'pending'; m.updatedAt = timestamp(); n++; }
      saveMats(mats);
      return sendJson(200, { ok: true, confirmed: n });
    }
    if (req.method === 'POST' && url.pathname === '/mat/del') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const mats = loadMats();
      if (!mats.some((m) => m.id === body.id)) return send(404, 'mat not found', 'text/plain');
      saveMats(mats.filter((m) => m.id !== body.id));
      return sendJson(200, { ok: true });
    }
    // ===== 快照 =====
    if (req.method === 'POST' && url.pathname === '/snapshot/note') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const ts = path.basename(body.ts || '');
      if (!/^[0-9-]+$/.test(ts)) return send(400, 'invalid ts', 'text/plain');
      const snapFile = path.join(snapDir(body.id), ts + '.html');
      if (!fs.existsSync(snapFile)) return send(404, 'snapshot not found', 'text/plain');
      const meta = loadSnapMeta(body.id);
      meta[ts] = { name: typeof body.name === 'string' ? body.name.trim() : '', note: typeof body.note === 'string' ? body.note.trim() : '' };
      saveSnapMeta(body.id, meta);
      return sendJson(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/snapshot/baseline') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const ts = path.basename(body.ts || '');
      if (!/^[0-9-]+$/.test(ts)) return send(400, 'invalid ts', 'text/plain');
      if (!fs.existsSync(path.join(snapDir(body.id), ts + '.html'))) return send(404, 'snapshot not found', 'text/plain');
      const meta = loadSnapMeta(body.id);
      meta.__baseline = ts;
      saveSnapMeta(body.id, meta);
      return sendJson(200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/snapshot/view') {
      const ts = path.basename(url.searchParams.get('ts') || '');
      if (!VALID_ID.test(id) || !/^[0-9-]+$/.test(ts)) return send(400, 'invalid id/ts', 'text/plain');
      const snapFile = path.join(snapDir(id), ts + '.html');
      if (!fs.existsSync(snapFile)) return send(404, 'snapshot not found', 'text/plain');
      let html = fs.readFileSync(snapFile, 'utf8');
      const banner = `<div style="position:sticky;top:0;z-index:1000;background:var(--warn-soft);color:var(--warn);padding:8px 16px;font-size:13px;text-align:center;border-bottom:2px solid var(--warn)">${icon('text-quote', 13)} 历史快照只读预览（${ts}）</div><style>.edit-toolbar,.page-line{display:none!important}</style>`;
      html = html.replace('contenteditable="true"', '').replace("sheet.contentEditable = 'true'", '');
      // CSP：快照正文是外部输入（恢复的备份/旧文档可带 <script>），而预览不需要任何脚本、
      // 网络请求或框架 → default-src 'none' 一刀切，只放行样式（横幅/正文观感）与图片/字体。
      // 这同时把模板残留的编辑器脚本（含 ⌘S doSave 保存通道）整体判死：脚本不执行、
      // connect-src 也禁——「预览页按保存把历史版本写回当前文档」的通道在两层被关死
      // （BL-P1-02≡BL-P7-01 + BL-P7-02，2026-11-01 B 线批 1）。
      return send(200, html.replace('<body>', '<body>' + banner), 'text/html; charset=utf-8', { 'Content-Security-Policy': LOCKED_PREVIEW_CSP });
    }
    // ===== S6-A2：模板预览（只读）：当前正文 + 候选主题的装配输出 =====
    // 零写路径（docs/ 与 docs-meta.json 字节零变化）；候选主题 = 显式 theme 参数（非 meta.theme），
    // 预览不落盘、不改 meta——「重装配生效」由 /theme/apply 写 meta.theme 后的 S6-A1 服务/渲染装配承接。
    // CSP 沿用 /snapshot/view 的锁定口径（LOCKED_PREVIEW_CSP）：预览不需要脚本/网络/框架 → 正文脚本整体判死。
    if (req.method === 'GET' && url.pathname === '/theme-preview') {
      const qid = url.searchParams.get('id') || '';
      if (!VALID_ID.test(qid)) return send(400, 'invalid id', 'text/plain');
      if (!fs.existsSync(docPath(qid))) return send(404, 'doc not found', 'text/plain');
      const th = url.searchParams.get('theme') || '';
      const avail = listThemes();
      if (!avail.includes(th)) return send(400, `未知主题: ${th || '(空)'}（可用主题: ${avail.join(', ')}）`, 'text/plain');
      // 装配走单一实现 themePreviewHtml()（DESIGN.md §10.1）：与向导 0.8 卡片内嵌的 srcdoc 逐字节相等
      const phtml = themePreviewHtml(fs.readFileSync(docPath(qid), 'utf8'), th);
      return send(200, phtml, 'text/html; charset=utf-8', { 'Content-Security-Policy': LOCKED_PREVIEW_CSP });
    }
    // ===== S6-A2：主题选择（确认交互由前端承载）：唯一写 = docs-meta.theme（updateMeta）=====
    // 「以新主题重装配」不经本端点重写正文文件：S6-A1 的服务/渲染/快照装配都以 meta.theme 为数据源，
    // meta 写入即生效（GET /edit 下一跳即新主题；编辑器前端 apply 成功后自行 reload）。
    if (req.method === 'POST' && url.pathname === '/theme/apply') {
      const body = await readBodyAuto(req);
      const docId = String((body && body.id) || '');
      if (!VALID_ID.test(docId)) return sendJson(400, { ok: false, error: 'invalid id' });
      if (!fs.existsSync(docPath(docId))) return sendJson(404, { ok: false, error: 'doc not found' });
      const th = String((body && body.theme) || '');
      const avail = listThemes();
      if (!avail.includes(th)) return sendJson(400, { ok: false, error: `未知主题: ${th || '(空)'}（可用主题: ${avail.join(', ')}）` });
      updateMeta(root, docId, (m) => ({ ...(m || {}), theme: th }));
      return sendJson(200, { ok: true, theme: th });
    }
    // ===== A3：排版密度页数感知（只读）：上次渲染页数 + 目标页数 =====
    // 数据源（如实、不臆造）：① pdfs/<id>.pdf 现测（pdfinfo，与 /export 同方法）= 上次真实渲染；
    // ② 回退 meta.exports 渲染历史里最近一条 pages（:4316 导出记录既有字段）；两者皆缺 → pages:null。
    // 目标 = job.brief.pages（normBrief 缺省 2），与导出 overpage 标记同口径（||2）。
    // 零写路径：不渲染、不 updateMeta、不碰文档——前端只据此显示「上次渲染 N 页（目标 M 页）/尚未渲染」。
    if (req.method === 'GET' && url.pathname === '/layout-info') {
      const qid = url.searchParams.get('id') || '';
      if (!VALID_ID.test(qid)) return sendJson(400, { ok: false, error: 'invalid id' });
      if (!fs.existsSync(docPath(qid))) return sendJson(404, { ok: false, error: 'doc not found' });
      const m = loadMeta()[qid] || {};
      const target = Number(m.job && m.job.brief && m.job.brief.pages) || 2;
      let pages = null;
      if (fs.existsSync(pdfPath(qid))) {
        try { pages = parseInt(execFileSync('pdfinfo', [pdfPath(qid)], { timeout: 10000 }).toString().match(/Pages:\s*(\d+)/)?.[1] || '0', 10) || null; } catch { pages = null; }
      }
      if (pages == null) {
        const list = exportsOf(m);
        for (let i = list.length - 1; i >= 0; i--) { if (Number(list[i] && list[i].pages) > 0) { pages = Number(list[i].pages); break; } }
      }
      return sendJson(200, { ok: true, pages, target });
    }
    if (req.method === 'GET' && url.pathname === '/snapshots') {
      const dir = snapDir(id);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse() : [];
      const meta = loadSnapMeta(id);
      const baseline = meta.__baseline || '';
      const apps = loadApps();
      const referenced = new Set(apps.filter((a) => a.docId === id && a.snapTs).map((a) => a.snapTs));
      // exports[].snapTs 引用的冻结快照同受 protectedSnaps 豁免（S1-T9，Task 8 review Minor-1：展示与清理口径一致）
      const exportReferenced = new Set(exportsOf(loadMeta()[id] || {}).map((e) => e && e.snapTs).filter(Boolean));
      const items = files.filter((f) => f.endsWith('.html')).map((f) => {
        const ts = f.replace('.html', '');
        const m = meta[ts] || {};
        return `<li class="card" style="margin:6px 0;padding:10px 12px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div><b>${escHtml(ts)}</b>${m.name ? ` <span class="badge">${escHtml(m.name)}</span>` : ''}${ts === baseline ? ' ' + badge('ok', '基准', 'pin') : ''}${referenced.has(ts) ? ' ' + badge('ai', '投递引用（不会被清理）', 'list-checks') : ''}${exportReferenced.has(ts) ? ' ' + badge('ai', '导出引用（不会被清理）', 'package') : ''}
            ${m.note ? `<div style="font-size:12px;color:var(--mut);margin-top:2px">${escHtml(m.note)}</div>` : ''}</div>
            <div style="font-size:12px">
              <a href="/snapshot/view?id=${escAttr(id)}&ts=${escAttr(ts)}">预览</a> ·
              <a href="/snapshot/pdf?id=${escAttr(id)}&ts=${escAttr(ts)}" target="_blank">下载该版本 PDF</a> ·
              <a href="/diff?base=${escAttr(id)}@${escAttr(ts)}&to=${escAttr(id)}">对比当前</a> ·
              <button class="secondary" style="padding:2px 8px" data-action="snapNote" data-id="${escAttr(id)}" data-ts="${escAttr(ts)}">${icon('pencil', 13)}</button>
              <button class="secondary" style="padding:2px 8px" data-action="snapBaseline" data-id="${escAttr(id)}" data-ts="${escAttr(ts)}" aria-label="设为基准" title="设为基准">${icon('pin', 13)}</button>
              <form method="post" action="/rollback?id=${escAttr(id)}&ts=${escAttr(ts)}" style="display:inline" data-action="confirmSubmit" data-msg="${escAttr('回滚到 ' + ts + '？当前版本会先自动留一份快照')}"><button class="secondary" style="padding:2px 8px">回滚</button></form>
            </div>
          </div>
        </li>`;
      }).join('');
      return send(200, page('历史版本', `<h1>历史版本</h1>
    <ul class="doclist" style="grid-template-columns:1fr">${items || '<li>暂无快照</li>'}</ul>
    <script nonce="__CSP_NONCE__">
      function snapNote(id, ts) {
        var name = prompt('快照名', ''); if (name === null) return;
        var note = prompt('备注', ''); if (note === null) return;
        __wv('/snapshot/note', { id: id, ts: ts, name: name, note: note }).then(function () { location.reload(); }).catch(function () {});
      }
      function snapBaseline(id, ts) {
        __wv('/snapshot/baseline', { id: id, ts: ts }).then(function () { location.reload(); }).catch(function () {});
      }
      // ===== 内联 handler 委托化注册（b5c1）：confirmSubmit 与首页同款（确认门 → 原生 POST /rollback）=====
      var __acts = window.__acts || (window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} });
      __acts.click.snapNote = function (el) { snapNote(el.getAttribute('data-id'), el.getAttribute('data-ts')); };
      __acts.click.snapBaseline = function (el) { snapBaseline(el.getAttribute('data-id'), el.getAttribute('data-ts')); };
      __acts.submit.confirmSubmit = function (el, ev) { return confirm(el.getAttribute('data-msg')); };
    </script>`, 'docs'));
    }
    if (req.method === 'POST' && url.pathname === '/rollback') {
      if (!url.searchParams.get('id')) return send(400, 'id required', 'text/plain');
      const ts = url.searchParams.get('ts') || '';
      const targetTs = path.basename(ts);   // 用户选中的回滚目标（防路径穿越）
      const snap = path.join(snapDir(id), targetTs + '.html');
      if (!fs.existsSync(snap)) return send(404, 'snapshot not found', 'text/plain');
      // 冻结点：回滚先冻结当前版（snapshot），再读冻结快照 → 归一化为当前格式（禁止把冻结字节直接落成活文档）→ 写正文 + meta（typo/theme/styleHash 从冻结解析）→ rev++
      try {
        await withDocLock(root, id, () => {
          snapshot(id, targetTs);   // 回滚目标进 prune 豁免集：本次冻结不得删掉它自己（审查 P0）
          const norm = normalizeToCurrent(fs.readFileSync(snap, 'utf8'));
          atomicWrite(docPath(id), norm.html);
          updateMeta(root, id, (m) => {
            const base = { ...(m || {}) };
            base.typo = norm.typo;
            base.styleHash = norm.styleHash;
            if (norm.theme != null) base.theme = norm.theme;
            base.rev = (Number(base.rev) || 0) + 1;
            return base;
          });
          // 回滚不经 beginTx 直接改文档：成功后同文档残留的未完成记录已被取代（T7 承载缺陷；留着会在下次启动恢复时把文档回滚到更早版本）
          try { const n = dropSupersededTx(root, id); if (n) console.error(`[tx] 同文档过期事务记录已清理 ${n} 条：${id}（/rollback）`); } catch {}
        });
      } catch (e) {
        if (e instanceof LockHeld) return sendJson(409, { ok: false, retry: true, error: '该文档正在被处理，请稍后重试' });
        throw e;
      }
      await renderCurrent(id, { lease: leaseOf(req) });   // 当前文档渲染一律走组装入口（回滚后的正文+meta）
      return redirect(`/edit?id=${id}`);
    }
    // ===== 差异对比（统一提取；隐藏内容默认不参与，需显式 hidden=1）=====
    if (req.method === 'GET' && url.pathname === '/diff') {
      const parseRef = (ref) => {
        const m = ref.match(/^([a-z0-9][a-z0-9-]*)(?:@([0-9-]+))?$/);
        if (!m) return null;
        const [, docId, ts] = m;
        if (ts) {
          const f = path.join(snapDir(docId), ts + '.html');
          return fs.existsSync(f) ? { id: docId, label: `${docId}@${ts}`, file: f } : null;
        }
        return fs.existsSync(docPath(docId)) ? { id: docId, label: docId, file: docPath(docId) } : null;
      };
      const base = parseRef(url.searchParams.get('base') || '');
      if (!base) return send(400, 'invalid base', 'text/plain');
      const toRaw = url.searchParams.get('to') || '';
      if (!toRaw) {
        const others = docIdsOnDisk().filter((id) => id !== base.id);
        return send(200, page('对比', `<h1>选对比对象</h1><p>${escHtml(base.label)} 与谁对比？</p><ul class="doclist">${others.map((o) => `<li class="card"><a href="/diff?base=${escAttr(base.label)}&to=${escAttr(o)}">${escHtml(o)}</a></li>`).join('')}</ul>`, 'docs'));
      }
      const to = parseRef(toRaw);
      if (!to) return send(404, 'doc not found', 'text/plain');
      const includeHidden = url.searchParams.get('hidden') === '1';
      const { diffLines } = await import('./diff.mjs');
      const rows = diffLines(
        docToLines(fs.readFileSync(base.file, 'utf8'), { includeHidden }),
        docToLines(fs.readFileSync(to.file, 'utf8'), { includeHidden })
      ).map((d) => `<div class="diff-line ${d.type}">${escHtml(d.text)}</div>`).join('\n');
      return send(200, page('对比', `<h1>对比：${escHtml(base.label)} ↔ ${escHtml(to.label)}</h1>
    <p style="font-size:12px;color:var(--mut)">${includeHidden ? `<a href="/diff?base=${escAttr(base.label)}&to=${escAttr(toRaw)}">按默认口径看</a>` : `<a href="/diff?base=${escAttr(base.label)}&to=${escAttr(toRaw)}&hidden=1">含隐藏看</a>`}</p>
    <div class="diff">${rows}</div>`, 'docs'));
    }
    // ===== 投递看板 =====
    if (req.method === 'GET' && url.pathname === '/applications') {
      const apps = loadApps();
      const docIds = docIdsOnDisk();
      const nowMs = Date.now();
      if (url.searchParams.get('view') === 'table') {
        const channels = [...new Set(apps.map((a) => a.channel).filter(Boolean))];
        const row = (a) => {
          const due = a.dueDate && (new Date(a.dueDate).getTime() - nowMs) < 48 * 3600 * 1000 && new Date(a.dueDate).getTime() >= nowMs - 24 * 3600 * 1000 ? '<span class="badge warn" role="img" aria-label="临近截止" title="临近截止">' + icon('circle-alert', 11) + '</span>' : '';
          const archiveBadge = a.archive && a.archive.status === 'failed' ? badge('err', '存档缺失') : '';
          // data-ch 是属性上下文：channel 由 /app/add、/app/update 原样落库（用户可控）→ 必须 escAttr
          return `<tr data-ch="${escAttr(a.channel || '')}"><td><b>${escHtml(a.company)}</b></td><td>${escHtml(a.role)}</td><td>${escHtml(a.channel || '')}</td><td>${escHtml(statusLabel(a.status))}</td><td>${escHtml(fmtWhen(a.appliedAt))}</td><td>${escHtml(a.nextStep || '')}</td><td>${escHtml(fmtWhen(a.dueDate))}${due}</td><td>${archiveBadge}<a href="/app?id=${escAttr(a.id)}">详情</a></td></tr>`;
        };
        return send(200, page('投递·表格', `<div class="page-head"><h1>投递</h1><a href="/applications" style="font-size:13px;font-weight:400">⇄ 看板视图</a></div>${appTabs('apps')}
      ${corruptBanner()}
      <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <!-- option value 是属性上下文：渠道名用户可控 → escAttr；显示文本走 escHtml（文本节点） -->
        <select id="chFilter" aria-label="渠道筛选"><option value="">全部渠道</option>${channels.map((c) => `<option value="${escAttr(c)}">${escHtml(c)}</option>`).join('')}</select>
        <input id="appSearch" placeholder="搜索（公司/岗位/渠道/下一步）" style="flex:1" aria-label="搜索投递">
      </div>
      <div class="tablewrap"><table id="appTable" style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr><th tabindex="0" data-action="sortCol" data-idx="0">公司</th><th tabindex="0" data-action="sortCol" data-idx="1">岗位</th><th tabindex="0" data-action="sortCol" data-idx="2">渠道</th><th tabindex="0" data-action="sortCol" data-idx="3">状态</th><th tabindex="0" data-action="sortCol" data-idx="4">投递日期</th><th tabindex="0" data-action="sortCol" data-idx="5">下一步</th><th tabindex="0" data-action="sortCol" data-idx="6">截止时间</th><th>操作</th></tr></thead>
        <tbody>${apps.map(row).join('') || '<tr><td colspan="8" style="color:var(--mut);text-align:center;padding:20px">暂无投递</td></tr>'}</tbody>
      </table></div>
      <style>#appTable th{cursor:pointer;text-align:left;padding:8px;border-bottom:2px solid var(--line)}#appTable th:hover{background:var(--bg)}#appTable td{padding:8px;border-bottom:1px solid var(--line)}#appTable th.asc::after{content:' ↑'}#appTable th.desc::after{content:' ↓'}</style>
      <script nonce="__CSP_NONCE__">
        var sortDir = 1, sortIdx = -1;
        function sortCol(i) {
          sortDir = sortIdx === i ? -sortDir : 1; sortIdx = i;
          document.querySelectorAll('#appTable th').forEach(function (th) { th.className = ''; });
          document.querySelectorAll('#appTable th')[i].className = sortDir === 1 ? 'asc' : 'desc';
          var tbody = document.querySelector('#appTable tbody');
          Array.from(tbody.querySelectorAll('tr')).sort(function (a, b) {
            return a.cells[i].textContent.localeCompare(b.cells[i].textContent, 'zh') * sortDir;
          }).forEach(function (tr) { tbody.appendChild(tr); });
        }
        function filterRows() {
          var ch = document.getElementById('chFilter').value, q = document.getElementById('appSearch').value.toLowerCase();
          document.querySelectorAll('#appTable tbody tr').forEach(function (tr) {
            var ok = (!ch || tr.dataset.ch === ch) && (!q || tr.textContent.toLowerCase().includes(q));
            tr.style.display = ok ? '' : 'none';
          });
        }
        document.getElementById('chFilter').onchange = filterRows;
        document.getElementById('appSearch').oninput = filterRows;
        // ===== 内联 handler 委托化注册（b5c1）：表头排序 = click 与 keydown(Enter) 两个桶同名注册 =====
      var __acts = window.__acts || (window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} });
        __acts.click.sortCol = function (el) { sortCol(Number(el.getAttribute('data-idx'))); };
        __acts.keydown.sortCol = function (el) { sortCol(Number(el.getAttribute('data-idx'))); };
      </script>`, 'apps'));
      }
      // 跟进助手（批 3 b3c4）：投递卡「无回应满 N 天（默认 7，/settings 可配）」→ 给「生成跟进语」入口。
      // 草稿不发送：生成结果只落本机投递记录，页面只有「复制 / 丢弃」，没有任何发送/代填入口。
      const fuDays = followUpDays(root);      // 阈值（缺省 7）；llmReady=false → 入口禁用并写明原因
      const llmReady = hasLLM(root);
      const fuBlock = (a) => {
        const st = followUpState(a, { nowMs, thresholdDays: fuDays });
        if (!st.due) return '';                // 不在等回应 / 没到阈值 → 不给入口
        const task = followUpTask(a);
        const draft = followUpDraft(a);
        const noDoc = !followUpSource(root, a);   // 取材简历不在本机 → 明确说清，不给注定失败的入口
        const disabled = !llmReady || noDoc;
        let statusText = '';
        if (!llmReady) statusText = '未配置大模型：先到设置页配置';
        else if (noDoc) statusText = '这条投递关联的简历不在本机，先在投递详情里确认简历';
        else if (task && task.status === 'running') statusText = '生成中 · ' + stageLabel(task.stage);
        else if (task && task.status === 'error') statusText = String(task.error || '生成失败');
        else if (task && task.status === 'cancelled') statusText = '已取消';
        else if (task && task.status === 'done') {
          statusText = '已生成草稿' + (task.usage && typeof task.usage.total === 'number' ? ' · 用量 ' + task.usage.total + ' tokens' : ' · 用量：服务商未返回');
        }
        const cancelBtn = (task && task.status === 'running')
          ? `<button type="button" class="secondary" data-fu="cancel" data-app="${escAttr(a.id)}" data-task="${escAttr(String(task.taskId || ''))}">取消</button>` : '';
        const draftHtml = draft ? `<div class="fu-draft" data-fu-draft="${escAttr(a.id)}">
            <textarea class="fu-text" rows="4" readonly aria-label="跟进语草稿">${escHtml(String(draft.text == null ? '' : draft.text))}</textarea>
            <div class="fu-acts">
              <button type="button" class="secondary" data-fu="copy" data-app="${escAttr(a.id)}">复制</button>
              <button type="button" class="secondary" data-fu="discard" data-app="${escAttr(a.id)}">丢弃</button>
            </div>
            <div class="fu-note">草稿不会自动发送，复制后自己发</div>
          </div>` : '';
        return `<div class="fu-box" data-fu-app="${escAttr(a.id)}">
            <div class="fu-line">
              <span class="badge">无回应 ${st.days} 天</span>
              <button type="button" class="secondary" data-fu="gen" data-app="${escAttr(a.id)}"${disabled ? ' disabled' : ''}>${draft ? '重新生成' : '生成跟进语'}</button>
              ${cancelBtn}
              <span class="fu-msg"></span>
            </div>
            <div class="fu-status" role="status">${escHtml(statusText)}</div>
            ${draftHtml}
          </div>`;
      };
      const appCard = (a) => {
        const idx = APP_STATUSES.indexOf(a.status);
        const due = a.dueDate && (new Date(a.dueDate).getTime() - nowMs) < 48 * 3600 * 1000 && new Date(a.dueDate).getTime() >= nowMs - 24 * 3600 * 1000 ? '<span class="badge warn" role="img" aria-label="临近截止" title="临近截止">' + icon('circle-alert', 11) + '</span>' : '';
        const arch = a.archive && a.archive.status === 'failed' ? '<span class="badge err" title="存档 PDF 生成失败">' + icon('circle-x', 11) + '存档缺失</span>' : '';
        return `<div class="app-card card" data-status="${escAttr(a.status)}" data-app="${escAttr(a.id)}" style="margin:8px 0;padding:8px 10px;background:var(--panel);border:1px solid var(--line)">
          <div class="card-title" style="color:var(--ink)">${escHtml(a.company)}${due}</div>
          <div style="color:var(--mut);font-size:12px">${escHtml(a.role)}</div>
          <div style="font-size:12px;color:var(--mut);margin:2px 0"><a href="/edit?id=${escAttr(a.docId)}">${escHtml(a.docId)}</a> ${badge(a.jd ? 'ok' : 'warn', 'JD')}${arch}${a.channel ? `<span class="badge">${escHtml(a.channel)}</span>` : ''}</div>
          ${a.nextStep || a.dueDate ? `<div style="font-size:12px;color:var(--mut)">${a.nextStep ? '下一步：' + escHtml(a.nextStep) : ''}${a.dueDate ? ' 截止：' + escHtml(fmtWhen(a.dueDate)) : ''}</div>` : ''}
          ${a.note ? `<div style="font-size:12px;color:var(--mut)">${escHtml(a.note)}</div>` : ''}
          ${fuBlock(a)}
          <div style="margin-top:4px;font-size:12px">
            ${idx > 0 ? `<button class="secondary" style="padding:2px 8px" data-action="appPatch" data-app="${escAttr(a.id)}" data-status="${escAttr(APP_STATUSES[idx - 1])}">◀</button>` : ''}
            ${idx < APP_STATUSES.length - 1 && !APP_TERMINAL.includes(a.status) ? `<button class="secondary" style="padding:2px 8px" data-action="appPatch" data-app="${escAttr(a.id)}" data-status="${escAttr(APP_STATUSES[idx + 1])}">▶</button>` : ''}
            <select style="font-size:12px;padding:2px" aria-label="状态" data-action="appStatus" data-app="${escAttr(a.id)}"><option value="">⇅</option>${APP_STATUSES.map((s) => `<option value="${s}"${s === a.status ? ' selected' : ''}>${escHtml(statusLabel(s))}</option>`).join('')}</select>
            <a href="/app?id=${escAttr(a.id)}">详情</a>
            <button class="secondary" style="padding:2px 8px" aria-label="快速编辑" data-action="appEdit" data-app="${escAttr(a.id)}">${icon('pencil', 13)}</button>
            <button class="danger" style="padding:2px 8px;min-height:28px" aria-label="删除投递" data-action="appDel" data-app="${escAttr(a.id)}">${icon('trash-2', 13)}</button>
          </div>
          <!--R3①：行内快速编辑（原为 4 连 prompt 链）——展开即改、取消即收；仍走 /app/update 的 {company,role,note,jd} 契约-->
          <div class="app-edit" id="editbox-${escAttr(a.id)}" hidden style="margin-top:8px;border-top:1px dashed var(--line);padding-top:8px">
            <label style="display:block;font-size:12px;color:var(--mut)"><span>公司</span><input data-edit="company" style="width:100%;margin-top:3px" value="${escAttr(a.company)}"></label>
            <label style="display:block;font-size:12px;color:var(--mut);margin-top:6px"><span>岗位</span><input data-edit="role" style="width:100%;margin-top:3px" value="${escAttr(a.role)}"></label>
            <label style="display:block;font-size:12px;color:var(--mut);margin-top:6px"><span>备注（可空）</span><textarea data-edit="note" rows="2" style="width:100%;margin-top:3px">${escHtml(a.note || '')}</textarea></label>
            <label style="display:block;font-size:12px;color:var(--mut);margin-top:6px"><span>JD（可空）</span><textarea data-edit="jd" rows="3" style="width:100%;margin-top:3px">${escHtml(a.jd || '')}</textarea></label>
            <div style="margin-top:6px"><button type="button" data-action="appEditSave" data-app="${escAttr(a.id)}">保存</button> <button type="button" class="secondary" data-action="appEditToggle" data-app="${escAttr(a.id)}" data-show="false">取消</button></div>
          </div>
        </div>`;
      };
      const cols = APP_STATUSES.map((st) => {
        const items = apps.filter((a) => a.status === st);
        return `<div class="kb-col${items.length ? '' : ' empty'}"><div class="group-head">${escHtml(statusLabel(st))} <span style="color:var(--mut);font-weight:600;font-variant-numeric:tabular-nums">${items.length}</span></div>${items.map(appCard).join('') || '<div style="color:var(--mut);font-size:12px;padding:4px 8px">（空）</div>'}</div>`;
      }).join('');
      return send(200, page('投递', `<div class="page-head"><h1>投递</h1><a href="/applications?view=table" style="font-size:13px;font-weight:400">⇄ 表格视图</a></div>${appTabs('apps')}
    ${corruptBanner()}
    <details class="card" id="appAddBox"><summary style="cursor:pointer;font-weight:700">＋ 新增投递（记录已发生的投递，不自动发送）</summary>
    <!--R3②：裸字段重排为向导 .ob-field 同款 label 包裹模式（每个控件有可访问名）；id 与提交载荷不变（/app/add 契约零变化）-->
    <style>
      .app-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--space-3);margin-top:10px}
      .app-form>label{display:block;font-size:12px;color:var(--mut)}
      .app-form>label>span{display:block}
      .app-form input,.app-form select,.app-form textarea{width:100%;margin-top:3px}
      .app-form .wide{grid-column:1/-1}
    </style>
    <form id="appForm" class="app-form" style="margin-top:10px">
      <label><span>公司</span><input id="company" required></label>
      <label><span>岗位</span><input id="role" required></label>
      <label><span>简历</span><select id="docId">${docIds.map((d) => `<option value="${d}">${escHtml(d)}</option>`).join('')}</select></label>
      <label><span>渠道</span><input id="channel"></label>
      <label><span>投递日期</span><input id="appliedAt" type="date"></label>
      <label><span>截止</span><input id="dueDate" type="date"></label>
      <label><span>岗位链接</span><input id="link"></label>
      <label><span>下一步</span><input id="nextStep"></label>
      <label class="wide"><span>JD（可选）</span><textarea id="jd" rows="3"></textarea></label>
      <label class="wide"><span>备注（可选）</span><input id="note"></label>
      <div class="wide"><button>添加</button> <span id="appmsg"></span></div>
    </form></details>
    <div class="kb">${cols}</div>
    <script nonce="__CSP_NONCE__">var APP_STATUSES = ${JSON.stringify(APP_STATUSES)}; var APPS = ${JSON.stringify(apps).replace(/</g, '\\u003c')};</script>
    <script nonce="__CSP_NONCE__">
      function appPatch(id, patch) {
        __wv('/app/update', Object.assign({ id: id }, patch)).then(function () { location.reload(); }).catch(function () {});
      }
      // R3①：快速编辑改为行内小表单（原 4 连 prompt 链）：展开即改、取消即收；
      // 提交载荷仍是 {company, role, note, jd}（/app/update 契约零变化，未涉及字段原样保留）。
      function appEditToggle(id, show) {
        var box = document.getElementById('editbox-' + id);
        if (box) box.hidden = !show;
      }
      function appEdit(id) {
        appEditToggle(id, true);
        var box = document.getElementById('editbox-' + id);
        if (box) { var f = box.querySelector('input,textarea'); if (f) f.focus(); }
      }
      function appEditSave(id) {
        var box = document.getElementById('editbox-' + id);
        if (!box) return;
        var get = function (k) { var el = box.querySelector('[data-edit="' + k + '"]'); return el ? el.value : ''; };
        appPatch(id, { company: get('company').trim(), role: get('role').trim(), note: get('note'), jd: get('jd') });
      }
      function appDel(id) {
        if (!confirm('删除这条投递？')) return;
        __wv('/app/del', { id: id }).then(function () { location.reload(); }).catch(function () {});
      }
      // ===== 跟进助手（批 3 b3c4）：生成 → 草稿（只生成不发送）=====
      // 进度只报真实阶段（排队/调用模型/解析），**不给百分比**（诚实最小进度，与既有 genTasks 同口径）。
      var FU_STAGE = { queued: '排队等待槽位', calling: '调用模型中', parsing: '解析校验中' };
      var fuMsg = function (box, text) { var el = box && box.querySelector('.fu-msg'); if (el) el.textContent = text; };
      var fuStatus = function (box, text) { var el = box && box.querySelector('.fu-status'); if (el) el.textContent = text; };
      var fuUsage = function (u) { return (u && typeof u.total === 'number') ? ('用量 ' + u.total + ' tokens') : '用量：服务商未返回'; };
      var fuGenBtn = function (box) { return box && box.querySelector('button[data-fu="gen"]'); };
      // 运行中「取消」：服务端只在页面加载那一刻已有 running 任务时渲染它；点「生成」后是客户端
      // 轮询才发现 running —— 这里补建（带 taskId），否则运行中就没有取消入口，只能刷新页面。
      var fuShowCancel = function (box, taskId) {
        if (!box) return;
        var btn = box.querySelector('button[data-fu="cancel"]');
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'secondary';
          btn.setAttribute('data-fu', 'cancel');
          btn.setAttribute('data-app', box.getAttribute('data-fu-app') || '');
          var line = box.querySelector('.fu-line');
          if (line) line.appendChild(btn);
        }
        btn.setAttribute('data-task', String(taskId || ''));
      };
      var fuHideCancel = function (box) {
        var btn = box && box.querySelector('button[data-fu="cancel"]');
        if (btn && btn.parentNode) btn.parentNode.removeChild(btn);
      };
      var fuShowDraft = function (box, draft) {
        if (!box) return;
        var d = box.querySelector('.fu-draft');
        if (!draft) { if (d) d.setAttribute('hidden', ''); return; }
        if (!d) {
          d = document.createElement('div');
          d.className = 'fu-draft';
          d.innerHTML = '<textarea class="fu-text" rows="4" readonly aria-label="跟进语草稿"></textarea>'
            + '<div class="fu-acts"><button type="button" class="secondary" data-fu="copy">复制</button>'
            + '<button type="button" class="secondary" data-fu="discard">丢弃</button></div>'
            + '<div class="fu-note">草稿不会自动发送，复制后自己发</div>';
          box.appendChild(d);
        }
        d.removeAttribute('hidden');
        var ta = d.querySelector('textarea');
        if (ta) ta.value = draft.text || '';
        var gen = fuGenBtn(box);
        if (gen) gen.textContent = '重新生成';
      };
      var fuPoll = function (box) {
        var id = box.getAttribute('data-fu-app');
        var tick = function () {
          fetch('/app/followup/state?id=' + encodeURIComponent(id))
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (!d || !d.ok) { fuStatus(box, '状态读取失败'); return; }
              var t = d.task || {};
              if (t.status === 'running') {
                fuShowCancel(box, t.taskId);
                fuStatus(box, '生成中 · ' + (FU_STAGE[t.stage] || '处理中'));
                setTimeout(tick, 700);
                return;
              }
              fuHideCancel(box);
              if (t.status === 'error') fuStatus(box, t.error || '生成失败');
              else if (t.status === 'cancelled') fuStatus(box, '已取消');
              else if (t.status === 'done') fuStatus(box, '已生成草稿 · ' + fuUsage(t.usage));
              fuShowDraft(box, d.draft);
            })
            .catch(function () { fuStatus(box, '状态读取失败：网络异常'); });
        };
        tick();
      };
      document.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('button[data-fu]') : null;
        if (!b) return;
        var act = b.getAttribute('data-fu');
        var box = b.closest('.fu-box');
        var id = b.getAttribute('data-app') || (box ? box.getAttribute('data-fu-app') : '');
        if (act === 'gen') {
          fuMsg(box, '生成中…');
          fetch('/app/followup/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
            .then(function (r) {
              return r.text().then(function (t) {
                var d = null; try { d = JSON.parse(t); } catch (err) {}
                if (!r.ok || (d && d.ok === false)) { var e2 = new Error((d && d.error) || ('HTTP ' + r.status)); throw e2; }
                return d || {};
              });
            })
            .then(function () { fuMsg(box, ''); fuPoll(box); })
            .catch(function (err) { fuMsg(box, ''); fuStatus(box, '生成失败：' + (err.message || err)); });
          return;
        }
        if (act === 'cancel') {
          fetch('/app/followup/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, taskId: b.getAttribute('data-task') || '' }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d && d.ok === false) fuStatus(box, d.error || '取消失败'); else fuStatus(box, '已取消'); })
            .catch(function () { fuStatus(box, '取消失败：网络异常'); });
          return;
        }
        if (act === 'copy') {
          var ta = box && box.querySelector('.fu-text');
          var text = ta ? ta.value : '';
          if (!text) { fuMsg(box, '没有可复制的草稿'); return; }
          // 剪贴板不可用（非安全上下文/浏览器没给权限）→ 如实说失败，不假装成功
          if (!navigator.clipboard || !navigator.clipboard.writeText) { fuMsg(box, '复制失败：浏览器未授权剪贴板，请手动选中草稿复制'); return; }
          navigator.clipboard.writeText(text)
            .then(function () { fuMsg(box, '已复制'); })
            .catch(function () { fuMsg(box, '复制失败：浏览器未授权剪贴板，请手动选中草稿复制'); });
          return;
        }
        if (act === 'discard') {
          fetch('/app/followup/discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) })
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (d && d.ok === false) { fuStatus(box, d.error || '丢弃失败'); return; }
              var dd = box && box.querySelector('.fu-draft');
              if (dd) dd.setAttribute('hidden', '');
              var gen = fuGenBtn(box);
              if (gen) gen.textContent = '生成跟进语';
              fuStatus(box, '草稿已丢弃');
            })
            .catch(function () { fuStatus(box, '丢弃失败：网络异常'); });
        }
      });
      document.getElementById('appForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        try {
          var d = await __wv('/app/add', { company: document.getElementById('company').value.trim(), role: document.getElementById('role').value.trim(), docId: document.getElementById('docId').value,
            jd: document.getElementById('jd').value, note: document.getElementById('note').value,
            channel: document.getElementById('channel').value.trim(), link: document.getElementById('link').value.trim(),
            appliedAt: document.getElementById('appliedAt').value, nextStep: document.getElementById('nextStep').value.trim(), dueDate: document.getElementById('dueDate').value },
            document.getElementById('appmsg'));
          if (d && d.warning) alert(d.warning);
          location.reload();
        } catch (err) {
          __status(document.getElementById('appmsg'), 'err', '保存失败：' + (err.message || err) + '（输入已保留，可重试）');
        }
      });
      // ===== 内联 handler 委托化注册（b5c1）：data-action → 实现（与原内联 onclick/onchange 行为一致）=====
      var __acts = window.__acts || (window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} });
      // ◀/▶ 按钮与状态下拉同走 appPatch：◀▶ 的目标状态由服务端渲染进 data-status（原为 APP_STATUSES[idx±1] 内联求值）
      __acts.click.appPatch = function (el) { appPatch(el.getAttribute('data-app'), { status: el.getAttribute('data-status') }); };
      __acts.change.appStatus = function (el) { if (el.value) appPatch(el.getAttribute('data-app'), { status: el.value }); };
      __acts.click.appEdit = function (el) { appEdit(el.getAttribute('data-app')); };
      __acts.click.appDel = function (el) { appDel(el.getAttribute('data-app')); };
      __acts.click.appEditSave = function (el) { appEditSave(el.getAttribute('data-app')); };
      __acts.click.appEditToggle = function (el) { appEditToggle(el.getAttribute('data-app'), el.getAttribute('data-show') === 'true'); };
    </script>`, 'apps', true));
    }
    // ===== 投递详情 =====
    if (req.method === 'GET' && url.pathname === '/app') {
      const aid = url.searchParams.get('id') || '';
      if (!/^[0-9-]+$/.test(aid)) return send(404, 'app not found', 'text/plain');
      const app = loadApps().find((a) => a.id === aid);
      if (!app) return send(404, 'app not found', 'text/plain');
      const interviews = Array.isArray(app.interviews) ? app.interviews : [];
      // F3：面试准备建议历史（最新在前）。形状守卫：坏形状当无记录（无 preps 时维持现状空态）；
      // 只呈现 text 为字符串的条目，模型输出与历史数据均不可信，渲染一律 escHtml。
      const preps = Array.isArray(app.preps) ? app.preps.filter((p) => p && typeof p.text === 'string') : [];
      const now = Date.now();
      const dueBadge = app.dueDate && (new Date(app.dueDate).getTime() - now) < 48 * 3600 * 1000 ? badge('warn', '到期') : '';
      const archiveMissing = !app.archive || app.archive.status !== 'ok';
      const archiveLine = archiveMissing
        ? `${badge('err', '存档 PDF 缺失')} <button class="secondary" style="padding:2px 8px;font-size:12px" data-action="regenArchive">从快照重新生成</button><span id="regenMsg" style="font-size:12px"></span>`
        : `<a href="/archive-pdf?id=${escAttr(app.id)}" target="_blank">存档 PDF</a> ${badge('ok', '内容哈希 ' + escHtml((app.contentHash || '').slice(0, 8)))}`;
      // ===== 面试练习区（批 4 卡片 b4c2）：逐题作答 → 反馈流 + 缺的素材一键转待补充 =====
      // 可练性与 /app/practice/start 409 共用 practiceGate（单一通道）：不能练就不给「开始练习」入口
      //（不给注定失败的按钮），降级原因照实渲染（§9.2-1）；练习历史照常可看（历史是已发生的事实）。
      const prGate = practiceGate(app);
      const prSessions = practiceSessions(app);
      const prLlm = hasLLM(root);
      const prNow = Date.now();
      const prHasLinks = prSessions.some((s) => s && s.feedback && typeof s.feedback === 'object' && !Array.isArray(s.feedback)
        && Object.values(s.feedback).some((b) => b && typeof b === 'object' && b.missingMats && Object.keys(b.missingMats).length));
      const prMats = prHasLinks ? loadMats() : null;   // 仅在需要核对「已转素材还在不在」时才读素材库：被删 → 恢复按钮态（可重建）
      const prMatExists = (matId) => !!prMats && prMats.some((m) => m.id === matId);
      const prUsageText = (u) => (u && typeof u.total === 'number') ? ('用量 ' + u.total + ' tokens') : '用量：服务商未返回';
      const prFbBox = (s, qid) => {
        const fb = (s.feedback && typeof s.feedback === 'object' && !Array.isArray(s.feedback)) ? s.feedback : {};
        return (fb[qid] && typeof fb[qid] === 'object' && !Array.isArray(fb[qid])) ? fb[qid] : {};
      };
      const prQuestionHtml = (s, q) => {
        const box = prFbBox(s, q.qid);
        const task = (box.task && typeof box.task === 'object') ? box.task : null;
        const expired = !!(task && task.status === 'running' && typeof task.startedAt === 'number' && task.startedAt + PRACTICE_TTL_MS < prNow);
        const running = !!(task && task.status === 'running' && !expired);
        const result = (box.result && typeof box.result === 'object' && !Array.isArray(box.result)) ? box.result : null;
        const links = (box.missingMats && typeof box.missingMats === 'object' && !Array.isArray(box.missingMats)) ? box.missingMats : {};
        const ansRec = (s.answers && typeof s.answers === 'object' && s.answers[q.qid] && typeof s.answers[q.qid] === 'object') ? s.answers[q.qid] : null;
        const saved = ansRec ? String(ansRec.text || '') : '';
        const statusText = [
          ansRec && ansRec.at ? '作答于 ' + escHtml(fmtWhen(ansRec.at)) : '',
          running ? '反馈生成中 · ' + escHtml(stageLabel(task.stage)) : '',
          expired ? '反馈超时：未生成结果，可重新生成' : '',
          task && task.status === 'error' ? escHtml(String(task.error || '反馈生成失败')) : '',
          task && task.status === 'cancelled' ? '已取消' : '',
          task && task.status === 'done' ? '反馈已生成 · ' + prUsageText(task.usage) : '',
        ].filter(Boolean).join(' · ');
        const pointsHtml = (Array.isArray(q.points) && q.points.length) ? `<div class="pr-meta">证据要点</div>
          <ul class="pr-points">${q.points.map((p) => `<li>${escHtml(p.text || '')}${p.quote ? `（引文：${escHtml(p.quote)}）` : ''} <span class="pr-meta">${escHtml(POINT_STATE_LABEL[p.sourceState] || '来源状态未知（仅作参考）')}</span></li>`).join('')}</ul>` : '';
        const matLine = (t, i) => {
          const link = links[String(i)];
          return `<div class="pr-mat-line"><span>${escHtml(t)}</span>${(link && link.matId && prMatExists(link.matId))
            ? `<a href="/materials">已转待补充素材</a>`
            : `<button class="secondary" data-pr="mat" data-idx="${i}">转待补充素材</button>`}</div>`;
        };
        const fbHtml = result ? `<div class="pr-fb">
          <div class="pr-fb-label">答到的事实</div>
          ${(Array.isArray(result.hit) && result.hit.length) ? `<ul class="pr-list">${result.hit.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>` : '<div class="pr-meta">（本次没有识别到答到的事实）</div>'}
          <div class="pr-fb-label">缺的指标或事实</div>
          ${(Array.isArray(result.missing) && result.missing.length) ? result.missing.map((t, i) => matLine(t, i)).join('') : '<div class="pr-meta">（无）</div>'}
          <div class="pr-fb-label">夸大倾向</div>
          ${(Array.isArray(result.exaggeration) && result.exaggeration.length) ? `<ul class="pr-list">${result.exaggeration.map((t) => `<li>${escHtml(t)}</li>`).join('')}</ul>` : '<div class="pr-meta">未发现夸大倾向</div>'}
          <div class="pr-fb-label">改进建议</div>
          <p style="margin:var(--space-1) 0 0;font-size:13px">${escHtml(String(result.advice || ''))}</p>
        </div>` : '';
        return `<div class="pr-q" data-pid="${escAttr(s.pid)}" data-qid="${escAttr(q.qid)}"${running ? ` data-pr-running="${escAttr(task.taskId || '')}"` : ''}>
          <div class="pr-qtext">${escHtml(q.question || '')}</div>
          ${q.followUp ? `<div class="pr-meta">追问：${escHtml(q.followUp)}</div>` : ''}
          ${q.req ? `<div class="pr-meta">证据表要求：${escHtml(q.req)}</div>` : ''}
          ${pointsHtml}
          <textarea class="pr-answer" rows="5" aria-label="作答" placeholder="口头回答的要点转写" data-pr-saved="${escAttr(saved)}">${escHtml(saved)}</textarea>
          <div class="pr-acts">
            <button class="secondary" data-pr="save">保存作答</button>
            <button class="secondary" data-pr="fb"${prLlm ? '' : ' disabled'}>生成反馈</button>
            ${running ? `<button class="secondary" data-pr="cancel" data-task="${escAttr(task.taskId || '')}">取消</button>` : ''}
            <span class="pr-status">${statusText}</span>
            <span class="pr-msg"></span>
          </div>
          ${fbHtml}
        </div>`;
      };
      const prSessionHtml = (s, i) => {
        const sum = sessionSummary(s);
        const qs = Array.isArray(s.questions) ? s.questions : [];
        return `<details class="pr-session" id="pr-${escAttr(sum.pid)}"${i === 0 ? ' open' : ''}>
          <summary>${escHtml(fmtWhen(s.createdAt))} · <span style="font-variant-numeric:tabular-nums">${sum.questionCount} 题 · 答 ${sum.answeredCount} · 反馈 ${sum.feedbackCount}</span>${s.interviewStale ? ' ' + badge('warn', '追问依据已变动') : ''}</summary>
          <div class="pr-meta">依据简历 ${escHtml(sum.docId || '')}${s.interviewStale ? '（追问或证据批次已变动，对照仅作参考）' : ''}</div>
          ${qs.map((q) => prQuestionHtml(s, q)).join('')}
        </details>`;
      };
      const prCardHtml = `<div class="card" style="margin-top:var(--space-3)" id="practice" data-pr-llm="${prLlm ? '1' : ''}">
      <b class="card-title">面试练习</b>
      ${prLlm ? '' : `<div class="pr-note">${escHtml(PRACTICE_NO_MODEL_HINT)}</div>`}
      ${prGate.ok
        ? `<div class="pr-acts"><button data-pr="start">开始练习</button><span class="pr-msg" id="prMsg"></span></div>`
        : `<div class="pr-empty">${escHtml(prGate.reason)}</div>`}
      ${prSessions.map((s, i) => prSessionHtml(s, i)).join('')}
    </div>`;
      // 客户端段：作答保存/反馈轮询/缺项转待补充全部就地更新，不整页 reload（未保存的作答不丢）。
      // 模型产物（反馈四字段）只经 textContent 进 DOM，不拼 innerHTML（模型输出不可信，F3 同口径）；
      // 就绪后的呈现与服务端初载渲染同一份 /app/practice/state 数据，状态措辞保持一致。
      const prScriptHtml = `<script nonce="__CSP_NONCE__">
      var PR_STAGES = { queued: '排队等待槽位', calling: '调用模型中', parsing: '解析校验中' };
      var PR_STAGE_FALLBACK = '处理中';
      var prQEl = function (pid, qid) { return document.querySelector('.pr-q[data-pid="' + pid + '"][data-qid="' + qid + '"]'); };
      var prStatus = function (q, text) { var el = q && q.querySelector('.pr-status'); if (el) el.textContent = text; };
      var prMsg = function (q, text) { var el = q && q.querySelector('.pr-msg'); if (el) el.textContent = text; };
      var prUsage = function (u) { return (u && typeof u.total === 'number') ? ('用量 ' + u.total + ' tokens') : '用量：服务商未返回'; };
      var prUnsaved = function () {
        return Array.prototype.some.call(document.querySelectorAll('.pr-answer'), function (ta) {
          return ta.value !== (ta.getAttribute('data-pr-saved') || '');
        });
      };
      var prHideCancel = function (q) { var b = q && q.querySelector('button[data-pr="cancel"]'); if (b && b.parentNode) b.parentNode.removeChild(b); };
      var prShowCancel = function (q, taskId) {
        if (!q) return;
        var btn = q.querySelector('button[data-pr="cancel"]');
        if (!btn) {
          btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'secondary';
          btn.setAttribute('data-pr', 'cancel');
          var acts = q.querySelector('.pr-acts');
          if (acts) acts.appendChild(btn);
        }
        btn.textContent = '取消';
        btn.disabled = false;
        btn.setAttribute('data-task', String(taskId || ''));
      };
      var prEnableFb = function (q) { var b = q && q.querySelector('button[data-pr="fb"]'); if (b) b.disabled = false; };
      var prAddList = function (fb, label, items, emptyText) {
        var h = document.createElement('div'); h.className = 'pr-fb-label'; h.textContent = label; fb.appendChild(h);
        if (!items || !items.length) {
          var e0 = document.createElement('div'); e0.className = 'pr-meta'; e0.textContent = emptyText; fb.appendChild(e0);
          return;
        }
        var ul = document.createElement('ul'); ul.className = 'pr-list';
        items.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
        fb.appendChild(ul);
      };
      var prFbRender = function (q, result, task) {
        var fb = q.querySelector('.pr-fb');
        if (!fb) { fb = document.createElement('div'); fb.className = 'pr-fb'; q.appendChild(fb); }
        fb.textContent = '';
        prAddList(fb, '答到的事实', result.hit, '（本次没有识别到答到的事实）');
        var h2 = document.createElement('div'); h2.className = 'pr-fb-label'; h2.textContent = '缺的指标或事实'; fb.appendChild(h2);
        var miss = result.missing || [];
        if (!miss.length) { var e1 = document.createElement('div'); e1.className = 'pr-meta'; e1.textContent = '（无）'; fb.appendChild(e1); }
        miss.forEach(function (t, i) {
          var row = document.createElement('div'); row.className = 'pr-mat-line';
          var sp = document.createElement('span'); sp.textContent = t; row.appendChild(sp);
          var b = document.createElement('button'); b.type = 'button'; b.className = 'secondary';
          b.setAttribute('data-pr', 'mat'); b.setAttribute('data-idx', String(i)); b.textContent = '转待补充素材';
          row.appendChild(b); fb.appendChild(row);
        });
        prAddList(fb, '夸大倾向', result.exaggeration, '未发现夸大倾向');
        var h3 = document.createElement('div'); h3.className = 'pr-fb-label'; h3.textContent = '改进建议'; fb.appendChild(h3);
        var p = document.createElement('p'); p.style.margin = 'var(--space-1) 0 0'; p.textContent = result.advice || ''; fb.appendChild(p);
        prHideCancel(q);
        prStatus(q, '反馈已生成 · ' + prUsage(task && task.usage));
      };
      var prPoll = function (pid, qid, taskId) {
        var tick = function () {
          fetch('/app/practice/state?id=' + encodeURIComponent(APPID) + '&pid=' + encodeURIComponent(pid))
            .then(function (r) { return r.json(); })
            .then(function (d) {
              var q = prQEl(pid, qid);
              if (!q) return;
              if (!d || !d.ok) { prMsg(q, '状态读取失败'); return; }
              var box = (d.session && d.session.feedback && d.session.feedback[qid]) || {};
              var t = box.task || {};
              if (!taskId || t.taskId !== taskId) return;   // 已被新任务取代/会话已变：不覆盖页面状态
              if (t.status === 'running') {
                if (t.expired) { prHideCancel(q); prStatus(q, '反馈超时：未生成结果，可重新生成'); prEnableFb(q); return; }
                prShowCancel(q, t.taskId);
                prStatus(q, '反馈生成中 · ' + (PR_STAGES[t.stage] || PR_STAGE_FALLBACK));
                setTimeout(tick, 900);
                return;
              }
              prHideCancel(q); prEnableFb(q);
              if (t.status === 'done') { prFbRender(q, box.result || {}, t); return; }
              if (t.status === 'error') { prStatus(q, t.error || '反馈生成失败'); return; }
              if (t.status === 'cancelled') { prStatus(q, '已取消'); return; }
            })
            .catch(function () {
              var q = prQEl(pid, qid);
              if (q) { prMsg(q, '状态读取失败：网络异常'); setTimeout(tick, 1800); }
            });
        };
        tick();
      };
      document.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('button[data-pr]') : null;
        if (!b) return;
        var act = b.getAttribute('data-pr');
        if (act === 'start') {
          if (prUnsaved() && !confirm('有未保存的作答，开始新练习会丢失未保存内容。继续？')) return;
          b.disabled = true;
          __wv('/app/practice/start', { id: APPID }, document.getElementById('prMsg'))
            .then(function () { location.reload(); })
            .catch(function () { b.disabled = false; });
          return;
        }
        var q = b.closest('.pr-q');
        if (!q) return;
        var pid = q.getAttribute('data-pid'), qid = q.getAttribute('data-qid');
        if (act === 'save') {
          var ta = q.querySelector('.pr-answer');
          var text = ta ? ta.value : '';
          if (!text.trim()) { prMsg(q, '作答不能为空'); return; }
          b.disabled = true;
          __wv('/app/practice/answer', { id: APPID, pid: pid, qid: qid, text: text }, q.querySelector('.pr-msg'))
            .then(function () {
              if (ta) ta.setAttribute('data-pr-saved', text);
              prStatus(q, '作答已保存');
              b.disabled = false;
            })
            .catch(function () { b.disabled = false; });
          return;
        }
        if (act === 'fb') {
          b.disabled = true;
          prMsg(q, '');
          __wv('/app/practice/feedback/start', { id: APPID, pid: pid, qid: qid }, q.querySelector('.pr-msg'))
            .then(function (d) {
              prStatus(q, '反馈生成中 · ' + (PR_STAGES.queued || PR_STAGE_FALLBACK));
              prPoll(pid, qid, (d && d.taskId) || '');
            })
            .catch(function () { b.disabled = false; });
          return;
        }
        if (act === 'cancel') {
          b.disabled = true;
          __wv('/app/practice/feedback/cancel', { id: APPID, pid: pid, qid: qid, taskId: b.getAttribute('data-task') || '' }, q.querySelector('.pr-msg'))
            .then(function () { prStatus(q, '已取消'); })
            .catch(function () { b.disabled = false; });
          return;
        }
        if (act === 'mat') {
          b.disabled = true;
          var idx = parseInt(b.getAttribute('data-idx'), 10);
          __wv('/app/practice/missing/material', { id: APPID, pid: pid, qid: qid, index: isNaN(idx) ? -1 : idx }, q.querySelector('.pr-msg'))
            .then(function () {
              var a = document.createElement('a');
              a.href = '/materials';
              a.textContent = '已转待补充素材';
              b.replaceWith(a);
            })
            .catch(function () { b.disabled = false; });
          return;
        }
      });
      // 页面加载那一刻已有 running 任务 → 接着轮询（服务端渲染了 data-pr-running 与取消按钮）
      document.querySelectorAll('.pr-q[data-pr-running]').forEach(function (q) {
        prPoll(q.getAttribute('data-pid'), q.getAttribute('data-qid'), q.getAttribute('data-pr-running'));
      });
      </script>`;
      return send(200, page('投递详情', `<h1>投递详情</h1>
    <div class="card">
      <b style="font-size:16px">${escHtml(app.company)}</b> ${escHtml(app.role)} ${dueBadge}
      <div style="font-size:13px;color:var(--mut);margin-top:6px">
        状态：<span class="badge">${escHtml(statusLabel(app.status))}</span>
        ${app.channel ? `渠道：<span class="badge">${escHtml(app.channel)}</span>` : ''}
        ${(() => { const u = safeUrl(app.link); return u ? `<a href="${escAttr(u)}" target="_blank" rel="noopener">岗位链接</a>` : (app.link ? '<span class="mut">岗位链接协议不安全，未渲染</span>' : ''); })()}
        简历：<a href="/edit?id=${escAttr(app.docId)}">${escHtml(app.docId)}</a>
        ${app.appliedAt ? `投递日期：${escHtml(fmtWhen(app.appliedAt))}` : ''}
        ${app.nextStep ? `下一步：${escHtml(app.nextStep)}` : ''}
        ${app.dueDate ? `截止：${escHtml(fmtWhen(app.dueDate))}` : ''}
        ${app.snapTs ? `当时快照：<a href="/snapshot/view?id=${escAttr(app.docId)}&ts=${escAttr(app.snapTs)}">${escHtml(app.snapTs)}</a>` : ''}
        ${archiveLine}
      </div>
      ${app.jd ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--mut)">JD 全文</summary><pre style="font-size:12px;white-space:pre-wrap">${escHtml(app.jd)}</pre></details>` : ''}
      ${app.note ? `<div style="margin-top:6px;font-size:13px">${escHtml(app.note)}</div>` : ''}
    </div>
    <div class="card" style="margin-top:12px">
      <b>面试记录</b> <button class="secondary" style="padding:2px 8px;font-size:12px" data-action="ivAdd">＋</button>
      <div id="ivList">${interviews.map((iv, i) => `<div style="border-left:3px solid var(--accent);padding:8px;margin:8px 0;background:var(--bg)">
        <b>${escHtml(iv.round || '第' + (i + 1) + '轮')}</b> <span style="color:var(--mut);font-size:12px">${escHtml(fmtWhen(iv.time))}</span>
        <a href="/app/ics?id=${escAttr(app.id)}&i=${i}" target="_blank" style="font-size:12px;margin-left:8px">${icon('calendar', 13)} ICS</a>
        ${iv.questions ? `<div style="font-size:13px;margin-top:4px"><b>问题：</b>${escHtml(iv.questions)}</div>` : ''}
        ${iv.answer ? `<div style="font-size:13px"><b>回答要点：</b>${escHtml(iv.answer)}</div>` : ''}
        ${iv.feedback ? `<div style="font-size:13px"><b>反馈：</b>${escHtml(iv.feedback)}</div>` : ''}
        ${iv.next ? `<div style="font-size:12px;color:var(--mut)">下一步：${escHtml(iv.next)}</div>` : ''}
      </div>`).join('') || '<div style="color:var(--mut);font-size:12px">暂无面试记录</div>'}</div>
      <details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:var(--accent)">＋ 添加面试记录</summary>
        <div style="margin-top:8px;font-size:13px">
          <p>轮次 <input id="ivRound" size="10" placeholder="如：一面" required> 时间 <input id="ivTime" type="datetime-local"></p>
          <p>问题<br><textarea id="ivQ" rows="2" cols="60"></textarea></p>
          <p>回答要点<br><textarea id="ivA" rows="2" cols="60"></textarea></p>
          <p>反馈<br><textarea id="ivF" rows="2" cols="60"></textarea></p>
          <p>下一步 <input id="ivN" size="30"></p>
          <button id="ivSave">保存</button><span id="ivMsg"></span>
        </div>
      </details>
    </div>
    ${prCardHtml}
    <div class="card" style="margin-top:12px">
      <b>AI 面试准备建议</b> <button id="prepBtn">生成</button><span id="prepMsg"></span>
      <div id="prepOut" style="margin-top:8px;font-size:13px;white-space:pre-wrap">${preps.length ? escHtml(preps[0].text) + (preps[0].at ? `<div style="font-size:12px;color:var(--mut);margin-top:4px">生成于 ${escHtml(preps[0].at)}</div>` : '') : ''}</div>
      ${preps.length > 1 ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--mut)">历史生成（${preps.length - 1}）</summary>${preps.slice(1).map((p) => `<div style="margin-top:8px;font-size:12px;color:var(--mut)">${escHtml(p.at || '时间缺失')}</div><pre style="font-size:12px;white-space:pre-wrap;margin:2px 0 0;font-family:inherit">${escHtml(p.text)}</pre>`).join('')}</details>` : ''}
      <!-- F3：preps 只读服务端渲染（模型输出不可信，一律 escHtml）；生成成功的前端回调仍就地覆盖
           #prepOut（行为不变），刷新后由这里承接最近一次与更早版本收起的折叠区。 -->
    </div>
    <script nonce="__CSP_NONCE__">var APPID = ${jsonScript(app.id)};</script>
    <script nonce="__CSP_NONCE__">
      function regenArchive() {
        document.getElementById('regenMsg').textContent = ' 生成中…';
        fetch('/app/archive-regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: APPID }) })
          .then(function (r) { return r.json(); })
          .then(function (d) { var el = document.getElementById('regenMsg'); if (d.ok) __status(el, 'ok', '已生成'); else __status(el, 'err', d.error || '失败'); if (d.ok) location.reload(); })
          .catch(function (e) { __status(document.getElementById('regenMsg'), 'err', e.message); });
      }
      document.getElementById('ivSave').onclick = function () {
        var round = document.getElementById('ivRound').value.trim();
        if (!round) { __status(document.getElementById('ivMsg'), 'err', '轮次必填'); return; }
        var ivs = ${jsonScript(interviews)};
        ivs.push({ round: round, time: document.getElementById('ivTime').value,
          questions: document.getElementById('ivQ').value, answer: document.getElementById('ivA').value,
          feedback: document.getElementById('ivF').value, next: document.getElementById('ivN').value });
        __wv('/app/update', { id: APPID, interviews: ivs }).then(function () { location.reload(); }).catch(function () {});
      };
      document.getElementById('prepBtn').onclick = async function () {
        document.getElementById('prepMsg').textContent = ' 生成中…';
        try {
          var r = await fetch('/ai/prep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: APPID }) });
          var data = await r.json();
          var prepOutEl = document.getElementById('prepOut');
          var prepMsgEl = document.getElementById('prepMsg');
          if (data.ok) { prepOutEl.textContent = data.text; prepMsgEl.textContent = ''; }
          else { prepOutEl.textContent = ''; __status(prepMsgEl, 'err', data.error || '失败'); }
        } catch (e) { __status(document.getElementById('prepMsg'), 'err', e.message); }
      };
      // ===== 内联 handler 委托化注册（b5c1）=====
      var __acts = window.__acts || (window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} });
      __acts.click.regenArchive = function (el) { return regenArchive(); };
      // ivAdd 无定义（既有死按钮：点击 ReferenceError、界面无变化）——委托化保持原样，
      // 只把调用点从内联属性搬进注册表；后续卡若补 ivAdd 实现，此处接线即刻生效。
      __acts.click.ivAdd = function (el) { return ivAdd(); };
    </script>
    ${prScriptHtml}`, 'apps'));
    }
    // ICS 文本转义（2026-10-19 安全审查 🟡-2）：CRLF 必须转义，否则 SUMMARY 里的换行
// 会注入出合法的 ICS 属性行（如 URL:https://evil/），日历客户端直接渲染成攻击者链接。
// 原实现只转了 , ; \（DESCRIPTION 转了 \n、SUMMARY 漏了）——现已抽成共用函数，两处都覆盖。
const icsEsc = (x) => String(x == null ? '' : x)
  .replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n')
  .replace(/,/g, '\\,').replace(/;/g, '\\;');
if (req.method === 'GET' && url.pathname === '/app/ics') {
      const aid = url.searchParams.get('id') || '';
      const idx = parseInt(url.searchParams.get('i') || '0', 10);
      if (!/^[0-9-]+$/.test(aid)) return send(404, 'app not found', 'text/plain');
      const app = loadApps().find((a) => a.id === aid);
      if (!app) return send(404, 'app not found', 'text/plain');
      const ivs = Array.isArray(app.interviews) ? app.interviews : [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= ivs.length) return send(404, 'interview not found', 'text/plain');
      const iv = ivs[idx];
      // DTSTART 须为合法紧凑时间：time 缺失时原写法生成 DTSTART:00（非法，日历客户端拒收）
      const dt = String(iv.time || '').replace(/[-:]/g, '') + '00';
      if (!/^\d{8}T\d{6}Z?$/.test(dt)) return send(400, '面试时间未设置或格式非法，无法导出日历', 'text/plain');
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
        `UID:${app.id}-${idx}@resume.local`, `DTSTART:${dt}`,
        `SUMMARY:${icsEsc(app.company)} ${icsEsc(iv.round || '面试')}`,
        `DESCRIPTION:${icsEsc(iv.questions || '')}`.slice(0, 500),
        'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="interview-${idx + 1}.ics"` });
      return res.end(ics);
    }
    if (req.method === 'POST' && url.pathname === '/ai/prep') {
      if (!hasLLM(root)) return send(409, '未配置大模型', 'text/plain');
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const app = loadApps().find((a) => a.id === body.id);
      if (!app) return send(404, 'app not found', 'text/plain');
      const docText = fs.existsSync(docPath(app.docId)) ? docToText(fs.readFileSync(docPath(app.docId), 'utf8')) : '';
      const sys = '你是面试准备教练。根据 JD 和简历给出 3-5 条具体准备建议（可能问什么、怎么答、注意什么），中文简洁。';
      const user = `【JD】\n${app.jd || '（无 JD）'}\n\n【简历】\n${docText}`;
      // BL-P4-03：模型调用异常此前一路冒到顶层错误出口 → 500 text/plain（客户端只在 JSON 体里找
      // error，用户只见『HTTP 500』、超时/网络真因全丢）。以下 7 个 /ai/* 路由统一就地兜住，
      // 与 /eval/create 对同一 chat() 的 catch 同款：502 + {ok:false, error:'模型调用失败：…'} JSON。
      let text;
      try { text = await chat(root, sys, user, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      // F3：成功才持久化 {text, at} 进 app.preps（最新在前，上限 20；saveApps 落既有 applications.json，无新文件）。
      // 409（未配置 LLM）/400（非法 id）/502（模型失败）任何失败路径都在此之前返回，零写入。
      // 跨 await 重新读表（同 /eval/promote 的 AUD-14 口径）：生成期间投递可能被删除或修改。
      const appsNow = loadApps();
      const appNow = appsNow.find((a) => a.id === body.id);
      if (!appNow) return sendJson(404, { ok: false, error: '投递记录已删除，未保存本次建议' });
      appNow.preps = [{ text, at: timestamp() }, ...(Array.isArray(appNow.preps) ? appNow.preps : [])].slice(0, 20);
      saveApps(appsNow);
      return sendJson(200, { ok: true, text });
    }
    // ===== JD 链接读取 =====
    if (req.method === 'POST' && url.pathname === '/ai/jd-text') {
      const body = JSON.parse(await readBody(req));
      // SSRF 防线复用 /ai/test 的同一道 assertSafeBaseURL（2026-10-19 安全审查 🟡-5）：
      // 原先这里只校验 ^https?://，任意内网/云元数据地址（169.254.169.254 等）都能被服务端抓取并原文回显。
      try { assertSafeBaseURL(String(body.url || '').trim()); }
      catch (e) { return sendJson(400, { ok: false, error: 'URL 不安全：' + (e && e.message || '') }); }
      if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url.trim()))
        return send(400, 'url 仅支持 http/https', 'text/plain');
      try {
        // redirect:'error'：assertSafeBaseURL 只查首个 URL，跟随 302 就绕过了黑名单
        // （2026-10-22 审查 [高] 实测：302 到 169.254.169.254 照样抓）
        // 与 /job/create 共用同一套有界读取（AUD-17）
        const text = await fetchPageText(body.url.trim());
        return sendJson(200, { ok: true, text });
      } catch (e) {
        return sendJson(200, { ok: false, error: String(e.message || e) });
      }
    }
    // ===== 设置页 + 备份恢复 =====
    if (req.method === 'GET' && url.pathname === '/settings') {
      const { active, profiles } = loadProfiles(root);
      const fuDays = followUpDays(root);   // 跟进语提醒阈值（缺省 7；可改 → 随「保存」落 config.json）
      // R3③：页名与 topnav 一致叫「设置」；无任何配置时给一张说明卡（首次使用知道每个字段是什么、怎么测）。
      const settingsGuide = `<div class="card" id="settingsGuide" style="margin-top:var(--space-3)">
      <b class="card-title">${icon('compass', 13)} 还没有模型配置——从这张卡开始</b>
      <p style="font-size:13px;color:var(--mut)">配置只存本机 config.json（不进任何仓库、不进备份、密钥不出你的电脑）。不配置模型也能完成主流程，AI 能力是可选增强。</p>
      <div style="font-size:13px;line-height:1.9">
        <b>字段含义</b><br>
        · 名称：给自己看的备注名，只用于列表区分<br>
        · Base URL：OpenAI 兼容服务地址（火山方舟填 <code>https://ark.cn-beijing.volces.com/api/v3</code>）<br>
        · API Key：服务商控制台签发的密钥，仅存本机<br>
        · 模型：可手填；也可先「测试连接」，成功后从下方可点列表里选<br>
        · 思考程度 reasoning_effort：留空=不传该参数；部分厂商不认这个字段，硬传会 400
      </div>
      <p style="font-size:13px;color:var(--mut);margin-bottom:0">测试连接流程：点「添加配置」→ 填 Base URL 与 API Key → 点该卡里的「测试连接」→ 出现可点选的模型按钮 → 选一个 → 点上方「保存」</p>
    </div>`;
      return send(200, page('设置', `<h1>设置</h1>
    ${corruptBanner()}
    ${profiles.length ? '' : settingsGuide}
    <div id="cards"></div>
    <div class="card" style="margin-top:var(--space-3)">
      <b class="card-title">${icon('clock', 13)} 跟进语提醒</b>
      <label style="display:block;font-size:12px;color:var(--mut)">投递后多少天没回应，就在投递卡上提示生成跟进语
        <input id="fuDays" type="number" min="1" max="90" step="1" value="${escAttr(String(fuDays))}" style="width:100%;margin-top:var(--space-1)">
      </label>
    </div>
    <p><button type="button" id="addBtn">${icon('plus', 13)} 添加配置</button> <button type="button" id="saveBtn">保存</button> <a href="/">返回首页</a> <span id="msg"></span></p>
    <div class="card" style="margin-top:var(--space-3)">
      <b class="card-title">${icon('save', 13)} 备份与恢复</b>
      <p style="font-size:13px;color:var(--mut)">备份含 docs/snapshots/pdfs 与四个 JSON（docs-meta/applications/materials/evaluations），<b>不含 config.json（密钥不进备份）</b></p>
      <p><a href="/backup"><button>下载备份</button></a> <span style="font-size:12px;color:var(--mut)">恢复默认「合并」：本地独有记录保留，同 id 冲突以备份为准，预览里逐条列出</span></p>
      <form id="restoreForm"><input type="file" id="restoreFile" accept=".tar.gz,.tgz" aria-label="选择备份文件（.tar.gz）">
        <label style="font-size:13px"><input type="radio" name="rmode" value="merge" checked> 合并（推荐）</label>
        <label style="font-size:13px"><input type="radio" name="rmode" value="replace"> 替换（清空现有后导入）</label>
        <button type="submit">恢复</button><span id="restoreMsg"></span></form>
      <div id="restorePreview" style="font-size:13px;margin-top:8px"></div>
      <p style="font-size:12px;color:var(--mut)">每次恢复前自动生成回退点（backups/），失败可一键回退</p>
      <div id="undoBox"></div>
    </div>
    <script nonce="__CSP_NONCE__">var DATA = ${JSON.stringify({ active, profiles, followUpDays: fuDays }).replace(/</g, '\\u003c')}</script>
    <script nonce="__CSP_NONCE__">
      var state = DATA;
      // 跟进语提醒阈值：改动只改内存态，点「保存」才落盘（与模型配置同一条保存路径）
      var fuDaysEl = document.getElementById('fuDays');
      if (fuDaysEl) fuDaysEl.oninput = function () { state.followUpDays = this.value; };
      function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
      function inp(i, f, label, val, extra) {
        // R3④：label 包裹 input（可访问名）；value 语义不变；oninput 已委托化（profInp 注册项，b5c1）
        return '<p><label style="display:block;font-size:12px;color:var(--mut)">' + label + '<input ' + ((extra || '') + ' style="width:100%;margin-top:3px"') + ' value="' + escAttr(val) + '" data-action="profInp" data-pi="' + i + '" data-pf="' + f + '"></label></p>';
      }
      // 模型按钮组：pickModel 之后 render() 会重建卡片，按钮组必须跟着重建，
      // 否则切换一次模型后按钮就消失了，还得重新点「测试连接」（2026-10-19 实测）。
      function modelButtonsHtml(p, i) {
        var list = p && p.__models;
        if (!list || !list.length) return '';
        return '<span style="font-size:12px;color:var(--mut)">可点选：</span>'
          + list.map(function (m, k) {
              return '<button type="button" class="secondary" data-pi="' + i + '" data-pm="' + k + '"'
                + ' style="margin:2px;padding:2px 8px;font-size:12px">' + escAttr(String(m)) + '</button>';
            }).join('');
      }
      function render() {
        var box = document.getElementById('cards');
        box.innerHTML = '';
        var guide = document.getElementById('settingsGuide');
        if (guide) guide.hidden = state.profiles.length > 0;   // R3③：删光配置后说明卡重新出现，有配置即隐藏（不刷新也成立）
        state.profiles.forEach(function (p, i) {
          var card = document.createElement('div');
          card.className = 'card' + (i === state.active ? ' card-active' : '');   // A6：激活卡一眼可辨（决定所有 AI 请求打到哪个模型的状态）
          card.innerHTML =
            '<p><label><input type="radio" name="act" value="' + i + '"' + (i === state.active ? ' checked' : '') + ' data-action="setActive" data-pi="' + i + '"> 启用</label> <b>配置 ' + (i + 1) + '</b>' + (i === state.active ? ' <span class="badge ok">使用中</span>' : '') + ' <button type="button" class="danger" data-action="delCard" data-pi="' + i + '">删除</button></p>'
            + inp(i, 'name', '名称', p.name, 'size="12"')
            + inp(i, 'baseURL', 'Base URL', p.baseURL)
            + inp(i, 'apiKey', 'API Key', p.apiKey, 'type="password"')
            + inp(i, 'model', '模型（可手填；点「测试连接」成功后下方出现可点的模型按钮）', p.model, '')
            + '<div id="models-' + i + '" style="margin:-6px 0 8px">' + modelButtonsHtml(p, i) + '</div>'
            + '<p><label style="display:block;font-size:12px;color:var(--mut)">思考程度 reasoning_effort（留空=不传该参数；部分厂商不认这个字段，硬传会 400）'
            + '<select data-action="profEffort" data-pi="' + i + '">'
            + '<option value=""' + (!p.reasoningEffort ? ' selected' : '') + '>（不设置）</option>'
            + ['low', 'medium', 'high', 'xhigh', 'max'].map(function (x) {
                return '<option value="' + x + '"' + (p.reasoningEffort === x ? ' selected' : '') + '>' + x + '</option>';
              }).join('')
            + '</select></label></p>'
            + '<p><button type="button" data-action="testCard" data-pi="' + i + '">测试连接</button> <span id="msg-' + i + '"></span></p>';
          box.appendChild(card);
        });
      }
      // 保存失败必须回滚内存态：否则 UI 显示已生效、磁盘没变，刷新后「又回来了」= 原 bug 复现
      // （2026-10-18 蓝军自检发现：引入即保存时漏了失败路径）
      async function applyAndSave(mutate, radio) {
        var prev = JSON.stringify(state);
        mutate();
        render();
        if (await save()) return;
        state = JSON.parse(prev);
        render();
        if (fuDaysEl) fuDaysEl.value = String(state.followUpDays == null ? 7 : state.followUpDays);
        if (radio) { var el = document.querySelector('input[name="act"][value="' + state.active + '"]'); if (el) el.checked = true; }
      }
      // 删除即落盘：原先只改内存 state，刷新后从 config.json 读回又出现（2026-10-18 修复）
      async function delCard(i) {
        if (!confirm('删除该配置？此操作立即生效')) return;
        await applyAndSave(function () {
          state.profiles.splice(i, 1);
          // 删掉启用卡**之前**的卡片时 active 必须前移，否则静默切到另一套配置
          // （[A,B,C] active=2 删 B → [A,C]，C 在下标 2，若只处理 >= length 会误设成 1=A）
          if (i < state.active) state.active -= 1;
          else if (state.active >= state.profiles.length) state.active = Math.max(0, state.profiles.length - 1);
        });
      }
      // 切换启用项即落盘；失败时把 radio 拨回原值（浏览器已自动改 checked，必须复位）
      async function setActive(i, radio) {
        await applyAndSave(function () { state.active = i; }, radio);
      }
      async function save() {
        var msgEl = document.getElementById('msg');
        var r;
        // 网络异常也必须进失败分支：原先这里抛出 → applyAndSave 不回滚 → UI 显示已切换，磁盘仍是旧值
        try { r = await fetch('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) }); }
        catch (e) { __status(msgEl, 'err', '网络异常：' + ((e && e.message) || e) + '（未生效，可重试）'); return false; }
        if (!r.ok) { __status(msgEl, 'err', await r.text().catch(function () { return 'HTTP ' + r.status; })); return false; }
        var d = null; try { d = await r.json(); } catch (e) {}
        if (d && d.ok === false) { __status(msgEl, 'err', d.error || '操作被拒绝（未生效）'); return false; }
        __status(msgEl, 'ok', '已保存');
        return true;
      }
      function pickModel(btn) {
        var i = Number(btn.getAttribute('data-pi'));
        var list = state.profiles[i].__models || [];
        var m = list[Number(btn.getAttribute('data-pm'))];
        if (m === undefined) return;
        state.profiles[i].model = String(m);
        render();
      }
      async function testCard(i) {
        var p = state.profiles[i];
        // 每次现取：fetch 期间用户可能删配置触发 render()，缓存的 msg 会变 detached 节点，
        // 写它抛 TypeError，且 catch 里再抛一次 → 未捕获 rejection（2026-10-18 蓝军自检发现）
        var say = function (kind, t) { var m = document.getElementById('msg-' + i); if (!m) return; if (kind) __status(m, kind, t); else m.textContent = t; };
        say(null, ' 测试中…');
        try {
          var r = await fetch('/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseURL: p.baseURL.trim(), apiKey: p.apiKey.trim() }) });
          var data = await r.json();
          if (data.ok) {
            say('ok', '连接成功，' + data.models.length + ' 个模型可用');
            state.profiles[i].__models = data.models.map(String);   // 供按钮 data-pm 索引取值（不入 config）
            // 模型做成「点一下就填」的按钮组，不用 <datalist>：
            // datalist 在 input 已有值时下拉极难点开（实测 2026-10-19：填了模型名后
            // 就点不开、换不了模型），而按钮组点击即切换，行为确定。
            var box = document.getElementById('models-' + i);
            if (box) {
              box.innerHTML = '<span style="font-size:12px;color:var(--mut)">可点选：</span>'
                + data.models.map(function (m, k) {
                    // 模型名走 data-* + 事件绑定，不用 onclick 内联拼字面量：
                    // JSON.stringify 产生的双引号会与 HTML 属性双引号冲突，把 onclick 截断成
                    // "pickModel(0," → 浏览器 SyntaxError，点击静默无效（2026-10-19 实测）。
                    return '<button type="button" class="secondary" data-pi="' + i + '" data-pm="' + k + '"'
                      + ' style="margin:2px;padding:2px 8px;font-size:12px">' + escAttr(String(m)) + '</button>';
                  }).join('');
            }
          } else say('err', '连接失败（' + (p.baseURL || '未填 Base URL') + '）：' + data.error + '　—— 不影响手填模型名，保存即可');
        } catch (e) { say('err', '连接失败（' + (p.baseURL || '未填 Base URL') + '）：' + (e.message || e) + '　—— 不影响手填模型名，保存即可'); }
      }
      document.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('button[data-pm]') : null;
        if (b) pickModel(b);
      });
      document.getElementById('addBtn').onclick = function () { state.profiles.push({ name: '', baseURL: '', apiKey: '', model: '' }); render(); };
      document.getElementById('saveBtn').onclick = save;
      render();
      function diffLinesToHtml(prev) {
        var lines = [];
        // x 来自备份包内的文件名/记录（可由构造的备份控制），拼进 innerHTML 前必须转义
        var e = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
        function sec(title, items) { if (!items || !items.length) return; lines.push('<div style="margin-top:6px"><b>' + title + '</b></div>'); items.forEach(function (x) { lines.push('<div>· ' + e(x) + '</div>'); }); }
        var d = prev.docs || {}, a = prev.apps || {}, m = prev.mats || {}, ev = prev.evals || {}, meta = prev.meta || {};
        sec('文档（新增 ' + (d.add || []).length + ' / 冲突 ' + (d.conflict || []).length + ' / 本地保留 ' + (d.keep || []).length + '）',
          (d.add || []).slice(0, 10).map(function (x) { return '新增 ' + x; })
            .concat((d.conflict || []).slice(0, 10).map(function (x) { return '覆盖（同 id 内容不同）' + x; }))
            .concat((d.keep || []).slice(0, 10).map(function (x) { return '保留本地独有 ' + x; })));
        sec('投递（新增 ' + (a.add || []).length + ' / 冲突 ' + (a.conflict || []).length + ' / 本地保留 ' + (a.keep || []).length + '）',
          (a.conflict || []).slice(0, 8).map(function (x) { return '以备份为准覆盖：' + x; }));
        sec('素材（新增 ' + (m.add || []).length + ' / 冲突 ' + (m.conflict || []).length + '）',
          (m.conflict || []).slice(0, 8).map(function (x) { return '以备份为准覆盖：' + x; }));
        sec('评估（新增 ' + (ev.add || []).length + ' / 冲突 ' + (ev.conflict || []).length + '）',
          (ev.conflict || []).slice(0, 8).map(function (x) { return '以备份为准覆盖：' + x; }));
        lines.push('<div style="margin-top:6px;color:var(--mut)">快照 ' + (prev.snapshots || 0) + ' 个 · PDF ' + (prev.pdfs || 0) + ' 个 · 评估记录 新增 ' + (ev.add || []).length + ' / 冲突 ' + (ev.conflict || []).length + ' · 预计恢复点数 ' + (prev.total || 0) + '</div>');
        if (prev.skippedCount) lines.push('<div style="margin-top:4px;color:var(--warn)">跳过 ' + prev.skippedCount + ' 个无法识别的条目（不恢复；多为渲染/保存过程的临时残留）</div>');
        return lines.join('');
      }
      document.getElementById('restoreForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var f = document.getElementById('restoreFile').files[0];
        if (!f) return;
        var msg = document.getElementById('restoreMsg');
        msg.textContent = ' 上传中…';
        var buf = await f.arrayBuffer();
        var prev = await fetch('/restore?apply=0', { method: 'POST', body: buf }).then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: '上传失败' }; });
        if (!prev.ok) { __status(msg, 'err', prev.error || '非法备份包'); return; }
        document.getElementById('restorePreview').innerHTML = diffLinesToHtml(prev);
        var mode = document.querySelector('input[name=rmode]:checked').value;
        if (!confirm('按「' + (mode === 'merge' ? '合并' : '替换') + '」恢复？恢复前会自动生成回退点。')) { msg.textContent = ' 已取消'; return; }
        msg.textContent = ' 执行恢复…';
        var r2 = await fetch('/restore?apply=1&mode=' + mode, { method: 'POST', body: buf });
        var data = await r2.json();
        if (data.ok) __status(msg, 'ok', '已恢复'); else __status(msg, 'err', data.error || '失败');
        if (data.ok && data.safety) {
          document.getElementById('undoBox').innerHTML = '<button class="secondary" data-action="undoRestore" data-ts="' + escAttr(data.safety) + '">↩ 回退这次恢复</button> <span id="undoMsg" style="font-size:12px"></span>';
        }
      });
      async function undoRestore(ts) {
        if (!confirm('回退到恢复前状态？')) return;
        var r = await fetch('/restore/undo?ts=' + encodeURIComponent(ts), { method: 'POST' });
        var d = await r.json().catch(function () { return { ok: false }; });
        var undoEl = document.getElementById('undoMsg');
        if (d.ok) __status(undoEl, 'ok', '已回退'); else __status(undoEl, 'err', d.error || '失败');
      }
      // ===== 内联 handler 委托化注册（b5c1）：render() 动态重建的卡片同样只需 data-action，无需重绑 =====
      var __acts = window.__acts || (window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} });
      __acts.input.profInp = function (el) { state.profiles[Number(el.getAttribute('data-pi'))][el.getAttribute('data-pf')] = el.value; };
      __acts.change.profEffort = function (el) { state.profiles[Number(el.getAttribute('data-pi'))].reasoningEffort = el.value; };
      __acts.change.setActive = function (el) { return setActive(Number(el.getAttribute('data-pi')), el); };
      __acts.click.delCard = function (el) { return delCard(Number(el.getAttribute('data-pi'))); };
      __acts.click.testCard = function (el) { return testCard(Number(el.getAttribute('data-pi'))); };
      __acts.click.undoRestore = function (el) { return undoRestore(el.getAttribute('data-ts')); };
    </script>`, 'settings'));
    }
    if (req.method === 'POST' && url.pathname === '/ai/test') {
      const body = JSON.parse(await readBody(req));
      if (!body.baseURL || !body.apiKey) return send(400, JSON.stringify({ ok: false, error: 'Base URL 和 API Key 必填' }), 'application/json');
      try {
        const models = await listModels(body.baseURL, body.apiKey);
        return sendJson(200, { ok: true, models });
      } catch (e) {
        return sendJson(200, { ok: false, error: String(e.message || e) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/settings') {
      const body = JSON.parse(await readBody(req));
      const profiles = body.profiles;
      if (!Array.isArray(profiles)) return send(400, 'profiles 必填', 'text/plain');
      const names = new Set();
      for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        // 指名道姓是哪一张卡——原话「每个配置需…非空」在多配置时无法定位（2026-10-18）
        if (!p || !['name', 'baseURL', 'apiKey', 'model'].every((k) => typeof p[k] === 'string' && p[k].trim()))
          return send(400, '配置 ' + (i + 1) + '（' + ((p && p.name) || '未命名') + '）的 name/baseURL/apiKey/model 必须都填', 'text/plain');
        if (names.has(p.name)) return send(400, 'name 重复: ' + p.name, 'text/plain');
        names.add(p.name);
      }
      if (profiles.length && (typeof body.active !== 'number' || !Number.isInteger(body.active) || body.active < 0 || body.active >= profiles.length))
        return send(400, 'active 需为 0-' + (profiles.length - 1) + ' 的整数', 'text/plain');
      // 跟进语提醒阈值（/settings 可配，缺省 7）：形状错即拒（不静默回落成默认——用户以为改了却没生效）
      let fuDays = followUpDays(root);
      if (body.followUpDays !== undefined && body.followUpDays !== null && body.followUpDays !== '') {
        const n = normalizeFollowUpDays(body.followUpDays);
        if (!n.ok) return send(400, n.error, 'text/plain');
        fuDays = n.days;
      }
      const cfgTmp = path.join(root, 'config.json.tmp');
      // mode 0o600：config.json 含明文 API Key，默认 0644 让同机其他用户可读（实测 -rw-r--r--）。
      // 先 chmod 再 rename，避免 tmp 创建瞬间的默认权限窗口
      fs.writeFileSync(cfgTmp, JSON.stringify({ active: profiles.length ? body.active : 0, profiles, followUpDays: fuDays }), { mode: 0o600 });
      try { fs.chmodSync(cfgTmp, 0o600); } catch {}
      fs.renameSync(cfgTmp, path.join(root, 'config.json'));
      return sendJson(200, { ok: true });
    }
    // ===== AI（统一正文提取；不再包含工具栏/占位符/隐藏内容）=====
    if (req.method === 'POST' && url.pathname === '/ai/rewrite') {
      if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');   // R2②：路径直达（「侧栏「设置」」是死引用）
      const body = JSON.parse(await readBody(req));
      if (!body.text || !body.instruction) return send(400, 'text 和 instruction 必填', 'text/plain');
      const p = buildRewrite(body.text, body.instruction);
      let revised;
      try { revised = await chat(root, p.sys, p.user, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      return sendJson(200, { ok: true, revised });
    }
    if (req.method === 'POST' && url.pathname === '/ai/chat') {
      if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');   // R2②：路径直达（「侧栏「设置」」是死引用）
      const body = JSON.parse(await readBody(req));
      if (!body.message) return send(400, 'message 必填', 'text/plain');
      if (body.id && !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const docId = body.id || id;
      const stale = staleGuard(docId, body.baseMtime);
      if (stale) return sendJson(409, stale);
      const docHtml = fs.existsSync(docPath(docId)) ? fs.readFileSync(docPath(docId), 'utf8') : '';
      const docText = docToText(docHtml, { includeHidden: false });
      const msgs = [{ role: 'system', content: buildChat(docText) }];
      for (const m of (body.history || []).slice(-10)) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') msgs.push({ role: m.role, content: m.content });
      }
      msgs.push({ role: 'user', content: body.message });
      let raw;
      try { raw = await chatMsgs(root, msgs, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      const parsed = parseChanges(raw);
      return sendJson(200, { ok: true, ...(parsed || { reply: raw }) });
    }
    if (req.method === 'POST' && url.pathname === '/restructure') {
      if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');   // R2②：路径直达（「侧栏「设置」」是死引用）
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      // 文档锁 + 冲突检测（2026-10-22 审查 [中]）：结构化要跑几秒 LLM，
      // 这期间用户可能又保存了一次 → 结构化结果会把用户的编辑整篇覆盖（实测用户的编辑消失）。
      // 与 /save 同口径：持文档锁（进程内）+ 事后比对 mtime（跨进程/跨标签）。
      return withDocLock(root, id, async () => {
      const mtimeBefore = fs.statSync(docPath(id)).mtimeMs;
      const html = fs.readFileSync(docPath(id), 'utf8');
      if (!html.includes('以下为 PDF 提取的原文')) return send(400, '该文档不是降级文档', 'text/plain');
      const text = docToLines(html).filter((l) => !l.includes('以下为 PDF 提取的原文')).join('\n');
      const structured = await structureText(root, text, undefined, { lease: leaseOf(req) }).catch(() => null);
      if (!structured) return send(502, 'LLM 结构化失败，文档未改动', 'text/plain');
      // LLM 跑完后再看一眼：用户在这期间保存过 → 不覆盖（409 让用户决定是否重来）
      const mtimeNow = fs.statSync(docPath(id)).mtimeMs;
      if (mtimeNow > mtimeBefore + 2) {
        return sendJson(409, { ok: false, error: '文档在结构化期间被修改过，已放弃覆盖（请重新发起）' });
      }
      snapshot(id);
      const tmp = docPath(id) + '.' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.tmp';
      fs.writeFileSync(tmp, structured);
      fs.renameSync(tmp, docPath(id));
      // 再生文档 = 装配产出的全新 classic 文档：重新登记样式来源（旧正文与旧 typo 已在上方快照中冻结）
      // S1 收尾 F-2（二选一，取「保留既有 schemaVersion」）：再生文档由当前模板装配产出，构造性满足 v2 格式；
      // themeRegistration 的 schemaVersion:1 只承载 /new（未迁移新建）语义。若回写 1，已迁移文档会落入
      // schemaVersion=1 + migration.state='done' 的矛盾态，下一轮迁移把它当 pending（白跑整轮三门禁+备份+锁窗口）。
      // 文档无 schemaVersion 时保持 themeRegistration 缺省（1，与 /new 同口径）。
      updateMeta(root, id, (m) => {
        const reg = themeRegistration('classic');
        if (m && m.schemaVersion !== undefined) reg.schemaVersion = m.schemaVersion;
        return { ...(m || {}), ...reg };
      });
      // 当前文档渲染一律走组装入口。
      // 注意：/restructure 走的是 **AI 池** 的闸门租约（它要调 LLM），
      // 渲染要用的是 **渲染池** 的租约 —— 跨池凭证会被资源凭证合同拒绝（2026-10-28 补丁轮）。
      // 这里不传租约：renderDoc 自己按渲染池借一个槽（渲染的真实占用照样计入渲染容量）。
      await renderCurrent(id, {});
      return redirect(`/edit?id=${id}`);
      });
    }
    if (req.method === 'POST' && url.pathname === '/ai/review') {
      if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');   // R2②：路径直达（「侧栏「设置」」是死引用）
      const body = JSON.parse(await readBody(req));
      if (body.id && !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      if (body.mode !== 'full' && body.mode !== 'quant') return send(400, "mode 仅支持 'full'|'quant'", 'text/plain');
      const docId = body.id || id;
      if (!fs.existsSync(docPath(docId))) return send(404, 'doc not found', 'text/plain');
      const stale = staleGuard(docId, body.baseMtime);
      if (stale) return sendJson(409, stale);
      const docText = docToText(fs.readFileSync(docPath(docId), 'utf8'), { includeHidden: false });
      const p = buildReview(docText, body.mode);
      let raw;
      try { raw = await chat(root, p.sys, p.user, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      const parsed = parseReport(raw);
      return sendJson(200, parsed ? { ok: true, report: parsed } : { ok: true, reply: raw });
    }
    if (req.method === 'POST' && url.pathname === '/ai/match') {
      if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');   // R2②：路径直达（「侧栏「设置」」是死引用）
      const body = JSON.parse(await readBody(req));
      if (body.id && !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      if (typeof body.jd !== 'string' || !body.jd.trim()) return send(400, 'jd 必填', 'text/plain');
      const docId = body.id || id;
      if (!fs.existsSync(docPath(docId))) return send(404, 'doc not found', 'text/plain');
      const stale = staleGuard(docId, body.baseMtime);
      if (stale) return sendJson(409, stale);
      const docText = docToText(fs.readFileSync(docPath(docId), 'utf8'), { includeHidden: false });
      const p = buildMatch(docText, body.jd);
      let raw;
      try { raw = await chat(root, p.sys, p.user, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      const parsed = parseReport(raw);
      return sendJson(200, parsed ? { ok: true, report: parsed } : { ok: true, reply: raw });
    }
    // ===== S3-T5：区域级 AI（analyze 意见 / rewrite 候选；只带本区域段落 + 有界全文摘要）=====
    const ZONE_KEYS_SET = new Set(ZONE_KEYS);
    if (req.method === 'POST' && url.pathname === '/ai/zone-analyze') {
      const body = JSON.parse(await readBody(req));
      if (!ZONE_KEYS_SET.has(body.zone)) return send(400, 'invalid zone', 'text/plain');
      const zerr = zoneRequestError(id, body);
      if (zerr) return sendJson(zerr.status, { ok: false, code: zerr.code, error: zerr.error });
      if (!hasLLM(root)) return sendJson(409, { ok: false, code: 'LLM_NOT_CONFIGURED', error: '未配置大模型，请先到设置页配置' });
      const html = fs.existsSync(docPath(id)) ? fs.readFileSync(docPath(id), 'utf8') : '';
      const meta = loadMeta()[id] || {};
      const zoneText = zoneParas(html, meta, body.zone).map((p) => p.text).join('\n');
      const rounds = meta.zoneRounds ? (meta.zoneRounds[body.zone] || 0) : 0;
      const p = buildZoneAnalyzePrompt({ zoneName: ZONE_LABELS[body.zone], zoneText, digest: digestOf(html), rounds });
      // S3-T6：chips 追问文本（可选字符串）拼进 user prompt；压单行 + 截断，防经换行伪造 prompt 段落结构
      if (typeof body.extra === 'string' && body.extra.trim()) p.user += '\n\n【追问】' + body.extra.trim().replace(/\s+/g, ' ').slice(0, 200);
      let raw;
      try { raw = await chat(root, p.sys, p.user, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      const parsed = parseZoneAnalysis(raw);
      if (parsed) {
        updateMeta(root, id, (m) => { const b = { ...(m || {}) }; b.zoneRounds = { ...(b.zoneRounds || {}) }; b.zoneRounds[body.zone] = (b.zoneRounds[body.zone] || 0) + 1; return b; });
      }
      return sendJson(200, parsed ? { ok: true, ...parsed } : { ok: false, error: '分析失败，稍后再试' });
    }
    if (req.method === 'POST' && url.pathname === '/ai/zone-rewrite') {
      const body = JSON.parse(await readBody(req));
      if (!ZONE_KEYS_SET.has(body.zone)) return send(400, 'invalid zone', 'text/plain');
      const zerr = zoneRequestError(id, body);
      if (zerr) return sendJson(zerr.status, { ok: false, code: zerr.code, error: zerr.error });
      if (!hasLLM(root)) return sendJson(409, { ok: false, code: 'LLM_NOT_CONFIGURED', error: '未配置大模型，请先到设置页配置' });
      if (!body.instruction || typeof body.instruction !== 'string') return send(400, 'instruction 必填', 'text/plain');
      const instruction = body.instruction.replace(/\s+/g, ' ').trim();   // S3-T6：服务端同压单行（curl 直打也过；instruction 在 prompt 独占一行，换行可伪造段落行）
      if (!instruction) return send(400, 'instruction 必填', 'text/plain');
      const html = fs.existsSync(docPath(id)) ? fs.readFileSync(docPath(id), 'utf8') : '';
      const meta = loadMeta()[id] || {};
      // 区域单位用 zone-v1 口径（与提示词、解析、落盘同一份文本）：prompt 与 parser 共用同一批单位
      const all = zoneEditUnits(html).filter((x) => meta.zones && meta.zones[x.zid] && meta.zones[x.zid].zone === body.zone);
      const locked = new Set(all.filter((x) => meta.zones[x.zid].locked === true).map((x) => x.zid));
      const free = all.filter((x) => !locked.has(x.zid));       // locked 段落跳过（段级保留标记）
      if (!free.length) return sendJson(200, { ok: true, rewrites: [], skipped: [...locked], baseMtime: body.baseMtime });
      const p = buildZoneRewritePrompt({ zoneName: ZONE_LABELS[body.zone], paras: free, instruction });
      let raw;
      try { raw = await chat(root, p.sys, p.user, { lease: leaseOf(req) }); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
      const parsed = parseZoneRewrites(raw, free);
      if (!parsed) return sendJson(200, { ok: false, error: '改写失败，稍后再试' });
      // 基线与操作身份由服务端生成（模型不得自报）：before/beforeHash 取本次实际发送的单位文本
      const requestPrefix = randomBytes(8).toString('hex');
      const baseline = new Map(free.map((u) => [u.zid, u]));
      const rewrites = parsed.map((r, i) => ({
        ...r,
        operationId: requestPrefix + '-' + i,
        baselineVersion: 'zone-v1',
        before: baseline.get(r.zid).text,
        beforeHash: contentHash(baseline.get(r.zid).text),
        zone: body.zone,
        candidate: r.candidate
      }));
      return sendJson(200, { ok: true, rewrites, skipped: [...locked], baseMtime: body.baseMtime });
    }
    // ===== 标签 / 关联 =====
    if (req.method === 'POST' && url.pathname === '/tag') {
      const body = JSON.parse(await readBody(req));
      if (body.id && !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const docId = body.id || id;
      if (typeof body.tag !== 'string') return send(400, 'tag 必填字符串', 'text/plain');
      if (!fs.existsSync(docPath(docId))) return send(404, 'doc not found', 'text/plain');
      const tag = body.tag.trim().slice(0, 20).replace(/['"\\]/g, '');
      // docs-meta 唯一写入者 updateMeta：只改本文档 tag（空 → 删 tag；条目空 → 删条目）
      updateMeta(root, docId, (m) => {
        const next = { ...(m || {}) };
        if (tag) next.tag = tag; else delete next.tag;
        return Object.keys(next).length ? next : null;
      });
      return sendJson(200, { ok: true });
    }
    // ===== 归档（S1-T8）：最小 POST /archive 置/清 archivedAt（独立标记，不混入 flow；home 默认隐藏 archived）=====
    if (req.method === 'POST' && url.pathname === '/archive') {
      const body = await readBodyAuto(req);
      const docId = String(body.id || id || '');
      if (!VALID_ID.test(docId)) return send(400, 'invalid id', 'text/plain');
      if (!fs.existsSync(docPath(docId))) return sendJson(404, { ok: false, error: 'doc not found' });
      const cur = (loadMeta()[docId] || {}).archivedAt;
      // 显式布尔 → 置/清；缺省 → 切换
      const want = (body.archived === undefined) ? !cur : (body.archived === true || body.archived === 'true' || body.archived === '1' || body.archived === 1);
      let archivedAt = null;
      updateMeta(root, docId, (m) => {
        const next = { ...(m || {}) };
        archivedAt = want ? (next.archivedAt || timestamp()) : null;
        next.archivedAt = archivedAt;
        return next;
      });
      return sendJson(200, { ok: true, archived: !!archivedAt, archivedAt });
    }
    if (req.method === 'POST' && url.pathname === '/link') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      if (!['zh', 'en'].includes(body.lang)) return send(400, 'lang 仅 zh|en', 'text/plain');
      if (!fs.existsSync(docPath(body.id))) return send(404, 'doc not found', 'text/plain');
      if (!body.linkedTo) {
        updateMeta(root, body.id, (m) => { if (!m) return m; const next = { ...m }; delete next.linkedTo; delete next.lang; return next; });
      } else {
        if (!VALID_ID.test(body.linkedTo)) return send(400, 'invalid linkedTo', 'text/plain');
        if (!fs.existsSync(docPath(body.linkedTo))) return send(404, 'linked doc not found', 'text/plain');
        updateMeta(root, body.id, (m) => ({ ...(m || {}), lang: body.lang, linkedTo: body.linkedTo }));
      }
      return sendJson(200, { ok: true });
    }
    // ===== 复盘 =====
    if (req.method === 'GET' && url.pathname === '/stats') {
      const apps = loadApps();
      const evals = loadEvals().map(evalRecordView);
      // 早退口径（F1）：投递与评估**均为空**才早退——有评估无投递时闭环卡仍要渲染，不得被空投递吞掉。
      if (!apps.length && !evals.length) return send(200, page('复盘', `<h1>复盘统计</h1>${appTabs('stats')}<div class="card" style="text-align:center;padding:40px;color:var(--mut)">暂无投递记录<br><br><a href="/applications">先去「投递」页添加记录</a></div>`, 'apps'));
      const funnel = APP_STATUSES.map((s) => [s, apps.filter((a) => a.status === s).length]);
      const byCh = {}; apps.forEach((a) => { byCh[a.channel || '未填'] = (byCh[a.channel || '未填'] || 0) + 1; });
      const byDoc = {}; apps.forEach((a) => { byDoc[a.docId] = (byDoc[a.docId] || 0) + 1; });
      const byTag = {}; const meta = loadMeta(); apps.forEach((a) => { const t = (meta[a.docId] || {}).tag || '未标记'; byTag[t] = (byTag[t] || 0) + 1; });
      // R2⑨：按简历版本的键从裸 id 映射为「标题（id）」（docInfo 现成标题，与首页母版下拉 :2061 同格式）；
      // 已删文档 docInfo 为 null → 回退裸 id。title 已在 docInfo 内转义，此处不再包 escHtml（防双转义）。
      const byDocLabel = (k) => { const di = docInfo(k, meta[k]); return di ? `${di.title}（${escAttr(k)}）` : escHtml(k); };
      const interviewed = apps.filter((a) => ['面试中', 'offer'].includes(a.status) || (Array.isArray(a.interviews) && a.interviews.length)).length;
      const n = apps.length;
      // 分布条（2026-11-04 视觉收尾，DESIGN.md §10）：单系数据不上 accent——非零行用中性 mut，accent 只留给行动；计数右对齐定宽 + tabular-nums
      const funnelBar = funnel.map(([s, c]) => `<div style="display:flex;align-items:center;margin:var(--space-2) 0"><span style="width:70px;font-size:12px">${escHtml(statusLabel(s))}</span><div style="flex:1;background:var(--bg);border-radius:var(--radius);height:20px"><div style="background:var(--mut);height:100%;border-radius:var(--radius);width:${n ? (c / n * 100) : 0}%"></div></div><span style="width:30px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums">${c}</span></div>`).join('');
      const warn = n < 10 ? `<div class="badge warn" style="margin-bottom:var(--space-3)">${icon('circle-alert', 11)}样本量小（n=${n}），仅供参考</div>` : '';
      // —— F1 评估 ↦ 投递 闭环卡（读时派生 join：零落库、零新文件、零写回）——
      // join 口径：promotedTo→docId→deliveredRefs 为主（deliveredRefs 按 docId 过滤 applications.json，
      // 文档在不在盘不影响投递事实）；未转适配时公司·岗位 trim 后精确相等作兜底并标「同名匹配」
      // （两边都非空才参与，防空名误配）。只呈现既有评估结论与投递状态事实，不做任何比率/概率包装。
      const onDisk = (id) => !!id && fs.existsSync(docPath(id));
      const evalLoopRows = evals.map((rec) => {
        const pid = String(rec.promotedTo || '');
        const refs = pid ? deliveredRefs(pid, apps)
          : apps.filter((a) => {
              const ec = String((rec && rec.company) || '').trim(), er = String((rec && rec.role) || '').trim();
              return (ec || er) && String((a && a.company) || '').trim() === ec && String((a && a.role) || '').trim() === er;
            });
        const sameName = !pid && refs.length > 0;
        const refBits = refs.map((a) => {
          const ivs = Array.isArray(a.interviews) ? a.interviews.length : 0;
          return escHtml(String((a && a.status) || '未填状态'))
            + ((a && a.appliedAt) ? '（投于 ' + escHtml(fmtWhen(String(a.appliedAt))) + '）' : '')
            + (ivs ? ' · 面试 ' + ivs + ' 轮' : '');
        }).join('；');
        const refsHtml = refs.length
          ? `<div style="font-size:12px;color:var(--mut);margin-top:var(--space-hair)">投递 ${refs.length} 条：${refBits}</div>`
          : '<div style="font-size:12px;color:var(--mut);margin-top:var(--space-hair)">暂无投递记录</div>';
        const destHtml = !pid ? '<span style="font-size:12px;color:var(--mut)">未转适配</span>'
          : onDisk(pid) ? `<a href="/edit?id=${escAttr(pid)}">已转适配 →</a>`
          : '<span style="font-size:12px;color:var(--mut)">原文档已删除</span>';
        const v = String((rec && rec.verdict) || '');
        return `<div style="border-top:1px solid var(--line);padding:var(--space-2) 0">
      <div style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap">
        ${badge('ai', ((rec && rec.score) == null ? '—' : String(rec.score)) + ' / 5')}${badge(EVAL_VERDICT_CLS[v] || 'mute', EVAL_VERDICT_TEXT[v] || '未定')}
        <span style="font-size:13px">${escHtml(String((rec && rec.company) || ''))}·${escHtml(String((rec && rec.role) || ''))}</span>
        <span style="font-size:12px;color:var(--mut)">${escHtml(evalTimeText(rec && rec.createdAt))}</span>
        ${sameName ? badge('warn', '同名匹配') : ''}${destHtml}
      </div>${refsHtml}
    </div>`;
      }).join('');
      // 提醒区：评估了却没投 = 建议投/谨慎 且未转适配 且评估来源已记录（legacy/invalid 来源不参与提醒）
      const notDelivered = evals.filter((e) => ['apply', 'caution'].includes(String((e && e.verdict) || ''))
        && !(e && e.promotedTo) && (e && e.sourceState) === 'recorded');
      const remindHtml = notDelivered.length ? `<div style="margin-top:var(--space-3)">${badge('warn', '评估了却没投 ' + notDelivered.length + ' 条', 'circle-alert')}${notDelivered.map((e) => `<div style="font-size:12px;color:var(--mut);margin-top:var(--space-1)">${escHtml(String(e.company || ''))}·${escHtml(String(e.role || ''))} · ${escHtml(evalTimeText(e.createdAt))}</div>`).join('')}</div>` : '';
      // 主卡（2/3 列）：评估 ↦ 投递闭环
      const loopCard = `<div class="card"><b class="card-title">评估 ↦ 投递</b>
      ${evalLoopRows || '<div style="color:var(--mut);font-size:13px;margin-top:var(--space-2)">还没有评估记录。到<a href="/job/new">「为岗位定制简历」</a>页点「先评估这个岗位」，评估结果会记在这里。</div>'}
      ${remindHtml}</div>`;
      // 面试练习入口（批 4 卡片 b4c2）：只列最近 3 条跨投递练习摘要（按会话时间倒序，链接直达 /app#pr-<pid>），
      // 练习明细都在投递详情页——这里不做第二份练习流（练习数据只落 app.practice，本页只读）。空态给去向指引（§9.2-4）。
      const prRows = apps.flatMap((a) => practiceSessions(a).map((s) => ({ a, s })))
        .sort((x, y) => String((y.s && y.s.createdAt) || '').localeCompare(String((x.s && x.s.createdAt) || '')))
        .slice(0, 3);
      const practiceSec = `<div class="stats-sec"><b class="card-title">面试练习</b>${prRows.length
        ? prRows.map(({ a, s }) => { const sum = sessionSummary(s);
            return `<div style="margin-top:var(--space-2)"><a href="/app?id=${escAttr(a.id)}#pr-${escAttr(sum.pid)}">${escHtml([a.company, a.role].filter(Boolean).join('·') || '未填公司岗位')}</a><div style="font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums">${sum.questionCount} 题 · 答 ${sum.answeredCount} · 反馈 ${sum.feedbackCount} · ${escHtml(fmtWhen(s.createdAt))}</div></div>`;
          }).join('')
        : `<p style="font-size:13px;color:var(--mut);margin:var(--space-2) 0 0">还没有练习记录：入口在每条投递详情的「面试练习」区（<a href="/applications">投递</a>）</p>`}</div>`;
      // 侧卡（1/3 列）：状态分布 + 面试参与合并为一张卡的两段（批 1 §0.2 复盘层级重排）；面试练习段为批 4 增段
      const sideCard = `<div class="card stats-side"><b class="card-title">状态分布</b>${funnelBar}
      <div class="stats-sec"><b class="card-title">面试参与</b><p style="font-size:13px;margin:var(--space-2) 0 0">${interviewed}/${n} 有面试安排或已进入面试（${n ? Math.round(interviewed / n * 100) : 0}%）；预约不等于完成。</p></div>${practiceSec}</div>`;
      // 三分布网格：收窄进主列（2/3）内，不再满宽铺开（批 1 §0.2）
      const distCards = `<div class="stats-dists">
      <div class="card"><b class="card-title">按渠道</b>${Object.entries(byCh).map(([k, v]) => `<div style="display:flex;justify-content:space-between;margin:var(--space-2) 0"><span>${escHtml(k)}</span><span style="font-variant-numeric:tabular-nums">${v}</span></div>`).join('')}</div>
      <div class="card"><b class="card-title">按简历版本</b>${Object.entries(byDoc).map(([k, v]) => `<div style="display:flex;justify-content:space-between;margin:var(--space-2) 0"><span>${byDocLabel(k)}</span><span style="font-variant-numeric:tabular-nums">${v}</span></div>`).join('')}</div>
      <div class="card"><b class="card-title">按岗位方向</b>${Object.entries(byTag).map(([k, v]) => `<div style="display:flex;justify-content:space-between;margin:var(--space-2) 0"><span>${escHtml(k)}</span><span style="font-variant-numeric:tabular-nums">${v}</span></div>`).join('')}</div>
    </div>`;
      return send(200, page('复盘', `<div class="page-head"><h1>复盘统计</h1><span class="page-meta">n=${n}</span></div>${appTabs('stats')}${warn}
    <div class="stats-grid">
      <div class="stats-main">${loopCard}${distCards}</div>
      ${sideCard}
    </div>`, 'apps'));
    }
    // ===== 备份 =====
    if (req.method === 'GET' && url.pathname === '/backup') {
      // 备份要与迁移/恢复互斥：迁移持锁时打出来的包是「替换中途」的混合状态，
      // 日后拿它恢复会得到不一致数据（2026-10-22 审查 [低] 实测：锁持有时 /backup 仍 200）。
      // rootLock 是排他锁：已被别人持有时直接 409，不排队（备份是用户手动点的，等一下更合理，
      // 但 rootLock 的语义是「被占即拒」——与 /save /restore 同一口径 ✓）。
      try { rootLock.acquire(root); }
      catch (e) {
        if (e instanceof LockHeld) return sendJson(409, { ok: false, error: '另一个写操作正在进行（备份/恢复/迁移），请稍后重试' });
        throw e;
      }
      // 锁持有到响应结束（tar 是异步的）：与 /restore 同一套释放口径（res finish/close）
      let lockReleased = false;
      const releaseBackupLock = () => {
        if (lockReleased) return;
        lockReleased = true;
        try { rootLock.release(root); } catch {}
      };
      res.on('finish', releaseBackupLock);
      res.on('close', releaseBackupLock);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + new Date().toTimeString().slice(0, 5).replace(':', '');
      // 先落临时文件再回传：原先 stdout 直接 pipe 且不监听退出码，tar 失败时客户端仍收到 200 + 残缺包
      const tmpTar = path.join(os.tmpdir(), `resume-backup-${Date.now()}.tar.gz`);
      // 清单里的 4 个 JSON 是运行时产物，首次写入前根本不存在。tar 遇到不存在的路径会整包失败
      // （Cannot stat → 非零退出 → 500），所以按存在性过滤；目录恒在（启动时 mkdir），不过滤。
      const bakFiles = ['docs', 'snapshots', 'pdfs']
        .concat(['docs-meta.json', 'applications.json', 'materials.json', 'evaluations.json'].filter((f) => fs.existsSync(path.join(root, f))));
      const child = spawn('tar', ['czf', tmpTar, '-C', root, ...bakFiles], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (c) => { err += c; });
      child.on('close', (code) => {
        if (code !== 0) {
          fs.rmSync(tmpTar, { force: true });
          return sendJson(500, { ok: false, error: '打包失败：' + (err.trim().slice(0, 200) || `tar exit ${code}`) });
        }
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="resume-backup-${stamp}.tar.gz"` });
        fs.createReadStream(tmpTar).pipe(res).on('close', () => fs.rmSync(tmpTar, { force: true }));
      });
      return;
    }
    // ===== 恢复（校验 → 预览 → 安全点 → 合并/替换；支持回退）=====
    if (req.method === 'POST' && url.pathname === '/restore') {
      const ts = Date.now();
      // 临时名加 pid + 随机串：原来只用 Date.now()，同毫秒的两个并发请求会撞同一个文件，
      // 其中一个的 finally rmSync 会删掉另一个还在用的（2026-10-19 审查 ⚪-4）。
      const tmpTar = path.join(os.tmpdir(), `resume-restore-${ts}-${process.pid}-${randomBytes(4).toString('hex')}.tar.gz`);
      try { await readBodyToFile(req, tmpTar, 300 * 1024 * 1024); }
      catch (e) {
        fs.rmSync(tmpTar, { force: true });
        return send(e.message === 'body too large' ? 413 : 400, JSON.stringify({ ok: false, error: '备份包上传失败：' + e.message }), 'application/json');
      }
      // 恢复全程持 rootLock（2026-10-19 审查 ⚪-4）：/restore 原来不走任何锁，
      // 两个并发恢复会交错写同一批文档（备份/合并/替换都是整目录操作）。rootLock 是跨进程排他锁，
      // 与 /save / 迁移共用同一把 —— 已被别人持有时直接拒绝，不排队。
      try { rootLock.acquire(root); }
      catch (e) {
        try { fs.rmSync(tmpTar, { force: true }); } catch {}
        if (e instanceof LockHeld) return sendJson(409, { ok: false, error: '另一个写操作正在进行（备份/恢复/迁移），请稍后重试' });
        throw e;
      }
      // 释放用 res 的 finish/close 而非 try/finally：/restore 路由是内联在 handler 里的
      // 大块代码，有多个 return 点（fail / 预览 / 合并 / 替换 / undo），逐点配对释放必漏。
      // 响应结束即释放，覆盖全部返回路径（2026-10-19 审查 ⚪-4）。
      let restoreLockReleased = false;
      const releaseRestoreLock = () => {
        if (restoreLockReleased) return;
        restoreLockReleased = true;
        try { rootLock.release(root); } catch {}
      };
      res.on('finish', releaseRestoreLock);
      res.on('close', releaseRestoreLock);
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-restore-'));
      // 清理不能自己抛：权限异常/非空目录时 rmSync 会抛 → 覆盖已发出的响应 + 泄漏 stage/tar
      const fail = (msg, code = 400) => {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(tmpTar, { force: true }); } catch {}
        return sendJson(code, { ok: false, error: msg });
      };
      // 条目校验：类型/路径/大小，防路径穿越
      // 路径列表：tzf 输出纯路径（路径白名单校验依赖这个形状，勿改成 tzvf——
      //   tzvf 每行带 权限/用户/组/大小/日期，整行当路径校验会把所有备份包全拒，2026-10-18 实测踩过）。
      let list = '';
      try { list = execFileSync('tar', ['tzf', tmpTar], { maxBuffer: 20 * 1024 * 1024, timeout: 60000 }).toString('utf8'); }
      catch { return fail('不是合法的 tar.gz 备份包'); }
      const entries = list.split('\n').filter(Boolean);
      if (!entries.length || entries.length > 20000) return fail('备份包条目数异常');
      // S4B-10 展开尺寸上限（解包之前拦）：条目数/路径白名单/禁 symlink 全都挡不住压缩炸弹——
      // 实测 1.3MB 的包展开 442.5MB（放大 340 倍），上传上限 300MB × 百万倍足以写满数据盘。
      // 尺寸另跑一次 tzvf 取第 5 列（tzf 没有 -v 拿不到 size）；与 entries 同序，不用于路径校验。
      // 任一行解析不出 size 就 fail closed：真实备份不会有这种行，解析失败放行等于留后门。
      try {
        const verbose = execFileSync('tar', ['tzvf', tmpTar], { maxBuffer: 20 * 1024 * 1024, timeout: 60000 }).toString('utf8');
        const { bytes } = sumExpandedBytes(verbose);
        // 只用绝对上限（校准见 restore-guard.mjs）：倍率限会误拒「多版本快照」这种正常场景（实测 40.5×）
        if (bytes > MAX_EXPANDED_BYTES) {
          return fail('备份包展开后 ' + Math.round(bytes / 1024 / 1024) + ' MB，超过 ' + Math.round(MAX_EXPANDED_BYTES / 1024 / 1024) + ' MB 上限，已拒绝（防压缩炸弹）', 413);
        }
      } catch (e) { return fail(e.code === 'ENOENT' ? '备份包信息读取失败' : e.message); }
      const ALLOWED = /^(docs\/|snapshots\/|pdfs\/|docs-meta\.json$|applications\.json$|materials\.json$|evaluations\.json$)/;
      for (const e of entries) {
        const ep = e.replace(/^\.\//, '');
        if (ep === '' || ep === '.') continue;         // tar czf -C dir . 的根条目
        // 隐藏文件（atomicWrite 崩溃残留的 .tmp 等）不是备份内容：跳过，
        // 否则用户会因自己机器上的一次崩溃而再也恢复不了自己的备份（2026-10-22 审查实测）
        if (path.basename(ep).startsWith('.')) continue;
        if (e.startsWith('/') || e.includes('..') || !ALLOWED.test(ep)) return fail('备份包含不允许的条目：' + e.slice(0, 80));
      }
      // 条目里的「标识」也必须合法（2026-10-22 安全审查 · 存储型 XSS）：
      // 文档 id 会原样拼进首页的 HTML 属性与内联脚本（b5c1 委托化前是 onclick="…('{id}')"），投递/素材记录的 id 同理。
      // 备份包是外部输入 → 恶意 id 即存储型 XSS
      // （实测：文档文件名 id="a'+alert(1)+'b" → 首页点「删除」真的弹出 alert(1)）。
      // 写入侧一律用 VALID_ID 闸门（/new、/save 的全局闸门），恢复侧必须同一把尺。
      // 未知形状 → 跳过不恢复并逐条上报（BL-P1-03，B 线批 2）：/backup 整目录打包，渲染发布链/
      // 重构/快照元数据留下的非隐藏临时件会进包，旧口径撞上任何一个就整包拒 → 用户此后打出的
      // 每个备份都无法恢复且 /backup 仍 200 零提示。安全边界不变：穿越/白名单外根/已知形状里
      // 的非法 id 仍然整包拒（下方 ①-⑤ 各分支）。
      const skipped = [];
      for (const e of entries) {
        const p = e.replace(/^\.\//, '');
        // ① 目录条目：每一段都要过 VALID_ID（docs/ snapshots/<id>/ pdfs/ pdfs/archive/ …）
        if (p.endsWith('/')) {
          for (const seg of p.split('/').filter(Boolean)) {
            if (!VALID_ID.test(seg)) return fail('备份包含非法目录名：' + seg.slice(0, 40));
          }
          continue;
        }
        // ② 文档：docs/<id>.html（必须是文件；同名目录会让首页 500 且删不掉）
        const mDoc = /^docs\/([^/]+)\.html$/.exec(p);
        if (mDoc) {
          if (!VALID_ID.test(mDoc[1])) return fail('备份包含非法文档 id：' + mDoc[1].slice(0, 40));
          continue;
        }
        // ③ 快照：snapshots/<id>/<ts>.html 与 <ts>.manifest.json
        //    ts 会原样拼进 /snapshots 的 href 与内联 JS → 不能带引号
        //    （口径同 /snapshot/view 的 /^[0-9-]+$/）
        // 快照元数据（saveSnapMeta 写的 meta.json：设基准等操作产生）
        const mSnapMeta = /^snapshots\/([^/]+)\/meta\.json$/.exec(p);
        if (mSnapMeta) {
          if (!VALID_ID.test(mSnapMeta[1])) return fail('备份包含非法快照目录 id：' + mSnapMeta[1].slice(0, 40));
          continue;
        }
        const mSnap = /^snapshots\/([^/]+)\/([^/]+?)(\.manifest\.json|\.html)$/.exec(p);
        if (mSnap) {
          if (!VALID_ID.test(mSnap[1])) return fail('备份包含非法快照目录 id：' + mSnap[1].slice(0, 40));
          if (!/^[0-9-]+$/.test(mSnap[2])) return fail('备份包含非法快照时间戳：' + mSnap[2].slice(0, 40));
          continue;
        }
        // ④ PDF：pdfs/<id>.pdf、pdfs/<id>.pdf.env.json（渲染旁车）、pdfs/archive/<ts>.pdf
        const mPdf = /^pdfs\/([^/]+?)(\.pdf\.env\.json|\.pdf)$/.exec(p);
        if (mPdf) {
          if (!VALID_ID.test(mPdf[1])) return fail('备份包含非法 PDF 标识：' + mPdf[1].slice(0, 40));
          continue;
        }
        const mArc = /^pdfs\/archive\/([^/]+?)\.pdf(\.env\.json)?$/.exec(p);
        if (mArc) {
          if (!/^[0-9-]+$/.test(mArc[1])) return fail('备份包含非法存档文件名：' + mArc[1].slice(0, 40));
          continue;
        }
        // ④b 导出历史：pdfs/history/<docId>@<ts>.pdf（及 .pdf.env.json 旁车）
        const mHist = /^pdfs\/history\/([^@/]+)@([0-9a-f]{40}|[0-9-]+)\.pdf(\.env\.json)?$/.exec(p);
        if (mHist) {
          if (!VALID_ID.test(mHist[1])) return fail('备份包含非法导出历史标识：' + mHist[1].slice(0, 40));
          continue;
        }
        // ⑤ 四个 JSON（运行时产物，可能不存在）
        if (/^(docs-meta|applications|materials|evaluations)\.json$/.test(p)) continue;
        // ⑥ 其余形状分两类：
        //    a) 已知内容目录（docs / pdfs / snapshots/<合法id>）直属的未知形状文件 → 多为渲染
        //       发布链/重构/快照元数据的临时残留（BL-P1-03，B 线批 2）→ 跳过不恢复并逐条上报，
        //       不再整包拒（旧口径会让用户此后打出的每个备份都无法恢复且 /backup 仍 200 零提示）；
        //    b) 更深嵌套/未知目录结构（如 pdfs/sub/x.pdf）→ 结构非法，仍整包拒（XSS-3 边界）。
        const dir = p.slice(0, p.lastIndexOf('/'));
        const knownContentDir = dir === 'docs' || dir === 'pdfs'
          || (/^snapshots\/[^/]+$/.test(dir) && VALID_ID.test(dir.slice('snapshots/'.length)));
        if (knownContentDir) { skipped.push({ name: p.slice(0, 80), reason: 'unknown-shape' }); continue; }
        return fail('备份包含不允许的条目形状：' + p.slice(0, 60));
      }
      try { execFileSync('tar', ['xzf', tmpTar, '-C', stage], { stdio: 'pipe', timeout: 120000 }); }
      catch { return fail('解包失败，备份包可能损坏'); }
      // 跳过项从 stage 剔除：后续 symlink 检查与 merge/replace 复制都只见「允许恢复」的内容
      for (const s of skipped) {
        try { fs.rmSync(path.join(stage, s.name), { recursive: true, force: true }); } catch {}
      }
      // 防 symlink：条目路径校验只查字符串，查不出「合法路径 + 符号链接指向别处」。
      // 实测 pdfs/leak.pdf -> /任意本地文件 经 copyMissing 的 copyFile 会把目标内容读进 root/pdfs/。
      let stageEntries = [];
      try { stageEntries = fs.readdirSync(stage, { withFileTypes: true, recursive: true }); }
      catch (e) { return fail('备份解包后无法读取（权限异常）：' + String(e.code || e.message).slice(0, 60)); }
      for (const ent of stageEntries) {
        if (ent.isSymbolicLink()) return fail('备份包含符号链接，已拒绝：' + ent.name.slice(0, 80));
      }
      // 注意：这里**不**校验文档正文里的内联脚本 —— 恢复入口一拒就会误伤合法文档
      // （编辑器脚本换过版本的旧文档、测试夹具的简化文档都会被拒 ✗）。
      // 防护放在 /edit 的 CSP 上：未知内联脚本一律被浏览器挡掉（实测外来脚本不执行 ✓），
      // 已知版本的编辑器主脚本按 sha256 放行 ✓。
      const hasContent = ['docs', 'snapshots', 'pdfs', 'docs-meta.json', 'applications.json', 'materials.json', 'evaluations.json'].some((x) => fs.existsSync(path.join(stage, x)));
      if (!hasContent) return fail('备份包中没有可恢复的内容');
      // 预览：逐条差异（新增/冲突/保留）
      const idsOf = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => f.replace('.html', '')) : [];
      const hashFile = (f) => contentHash(fs.readFileSync(f));
      const compareDocs = () => {
        const localIds = idsOf(path.join(root, 'docs'));
        const bakIds = idsOf(path.join(stage, 'docs'));
        const result = { add: [], conflict: [], keep: [] };
        for (const bid of bakIds) {
          const bf = path.join(stage, 'docs', bid + '.html');
          const lf = path.join(root, 'docs', bid + '.html');
          if (!fs.existsSync(lf)) result.add.push(bid);
          else if (hashFile(bf) !== hashFile(lf)) result.conflict.push(bid);
        }
        result.keep = localIds.filter((lid) => !bakIds.includes(lid));
        return result;
      };
      const jsonIds = (file, key = 'id') => {
        const f = path.join(stage, file);
        if (!fs.existsSync(f)) return null;
        // id 也要过 VALID_ID：记录 id 会原样拼进内联 JS（appPatch('{id}')/matStatus('{id}')），
        // 备份包里的 id 是外部输入 → 恶意 id 即存储型 XSS（同上，2026-10-22）。
        try {
          const a = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (!Array.isArray(a)) return 'CORRUPT';   // 形状错 ≠ 空数组：否则 replace 模式会静默清空本地记录
          for (const x of a) {
            // id 口径与写端点一致（/app/update、/mat/update、/mat/del 都是 /^[0-9-]+$/）
            // → 恢复出来的记录必须「改得了、删得掉」；用宽松的 VALID_ID 会恢复出用不了的记录（2026-10-22 审查 [低]）
            // id 口径：投递/素材是时间戳（写端点要求 /^[0-9-]+$/，恢复必须同一把尺）；
            // 评估是 'ev-' 前缀（写端点只要求 ev- 开头 + 无引号/斜杠）→ 这里守的是「不可能是注入载荷」
            const idRe = file === 'evaluations.json' ? /^ev-[a-z0-9-]+$/ : /^[0-9-]+$/;
            if (!x || typeof x.id !== 'string' || !idRe.test(x.id)) return 'BAD_ID';
            // 字段形状：materials 的 tags 必须是数组（渲染端 (m.tags||[]).map —— 非数组会整页 500）
            if (x.tags !== undefined && !Array.isArray(x.tags)) return 'BAD_SHAPE';
            // 投递记录的 docId 会拼路径（/app/archive-regenerate 的 snapDir(app.docId)）→ 必须过 VALID_ID
            if (x.docId !== undefined && (typeof x.docId !== 'string' || !VALID_ID.test(x.docId))) return 'BAD_SHAPE';
          }
          return a;
        } catch { return 'CORRUPT'; }
      };
      const compareJson = (file) => {
        const bak = jsonIds(file);
        if (bak === 'CORRUPT') return { corrupt: true, add: [], conflict: [], keep: [] };
        if (bak === 'BAD_ID') return { badId: true, add: [], conflict: [], keep: [] };
        if (bak === 'BAD_SHAPE') return { badShape: true, add: [], conflict: [], keep: [] };
        if (bak === null) return { add: [], conflict: [], keep: [] };
        const local = file === 'materials.json' ? loadMats() : file === 'evaluations.json' ? loadEvals() : loadApps();
        const localIds = new Set(local.map((x) => x.id));
        const bakIds = new Set(bak.map((x) => x.id));
        const result = { add: [], conflict: [], keep: [] };
        for (const b of bak) {
          if (!localIds.has(b.id)) result.add.push(b.id);
          else {
            const l = local.find((x) => x.id === b.id);
            if (JSON.stringify(l) !== JSON.stringify(b)) result.conflict.push(b.id);
          }
        }
        result.keep = [...localIds].filter((x) => !bakIds.has(x));
        return result;
      };
      let metaPreview = {};                                  // 备份 meta：缺失 → {}；损坏 → { corrupt: true }（apply 前拒绝，不退化成 {} 全删）
      try { const sm = readMetaSnapshotAt(path.join(stage, 'docs-meta.json')); metaPreview = sm ? { count: Object.keys(sm).length } : {}; }
      catch { metaPreview = { corrupt: true }; }
      const preview = {
        ok: true,
        docs: compareDocs(),
        apps: compareJson('applications.json'),
        mats: compareJson('materials.json'),
        evals: compareJson('evaluations.json'),
        meta: metaPreview,
        snapshots: entries.filter((l) => l.startsWith('snapshots/') && l.endsWith('.html')).length,
        pdfs: entries.filter((l) => l.startsWith('pdfs/') && l.endsWith('.pdf')).length,
        skipped: skipped.slice(0, 20),
        skippedCount: skipped.length
      };
      preview.total = preview.docs.add.length + preview.docs.conflict.length + preview.apps.add.length + preview.apps.conflict.length + preview.mats.add.length + preview.mats.conflict.length + preview.evals.add.length + preview.evals.conflict.length;
      if (url.searchParams.get('apply') !== '1') {
        fs.rmSync(stage, { recursive: true, force: true });
        fs.rmSync(tmpTar, { force: true });
        return sendJson(200, preview);
      }
      // 损坏的备份 meta 必须在任何删除/覆盖动作之前拒绝：否则 replace 会先清空本地 docs 再把 meta 当成 {} 全删
      if (preview.meta.corrupt) return fail('备份中的 docs-meta.json 损坏，拒绝恢复（不覆盖本地 meta）', 500);
      if (preview.apps.corrupt || preview.mats.corrupt || preview.evals.corrupt) return fail('备份中的 JSON 损坏，拒绝恢复');
      if (preview.apps.badId || preview.mats.badId || preview.evals.badId) {
        return fail('备份中的记录 id 非法（只允许数字与横线），拒绝恢复：防恢复出改不了/删不掉的记录');
      }
      if (preview.apps.badShape || preview.mats.badShape || preview.evals.badShape) {
        return fail('备份中的记录字段形状非法，拒绝恢复：防恢复后页面 500 或路径越界');
      }
      const mode = url.searchParams.get('mode') === 'replace' ? 'replace' : 'merge';
      // 回退点（可操作）：数据根 backups/restore-<ts>/
      const safety = path.join(root, 'backups', 'restore-' + ts);
      fs.mkdirSync(path.join(safety, 'data'), { recursive: true });
      for (const d of ['docs', 'snapshots', 'pdfs']) if (fs.existsSync(path.join(root, d))) fs.cpSync(path.join(root, d), path.join(safety, 'data', d), { recursive: true });
      try { hardenDataPerms(root); } catch {}   // cpSync 不经 atomicWrite → 权限随源文件，恢复后统一收紧
      for (const f of ['docs-meta.json', 'applications.json', 'materials.json', 'evaluations.json']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(safety, 'data', f));
      // 存在性台账（AUD-09）：安全点只复制「存在的」文件 → 「原本不存在」这一事实丢失，
      // 撤销时无法把恢复引入的文件删回去（实测：原本没有 evaluations.json，恢复后撤销，文件仍在）。
      // present 记录恢复前每个受管项是否存在；config.json 不在受管范围（恢复不碰它）。
      const present = {};
      for (const d of RESTORE_MANAGED_DIRS) present[d] = fs.existsSync(path.join(root, d));
      for (const f of RESTORE_MANAGED_FILES) present[f] = fs.existsSync(path.join(root, f));
      fs.writeFileSync(path.join(safety, 'manifest.json'), JSON.stringify({ ts, mode, at: new Date().toISOString(), preview, present }, null, 2));
      try {
        if (mode === 'replace') {
          for (const d of ['docs', 'snapshots', 'pdfs']) {
            const src = path.join(stage, d);
            // replace 语义是「清空现有后导入」：备份包里缺该目录时同样要清空，
            // 否则本地旧数据残留，与 UI 承诺相反（原先此处 continue 跳过了清理）
            if (fs.existsSync(path.join(root, d))) for (const f of fs.readdirSync(path.join(root, d))) fs.rmSync(path.join(root, d, f), { recursive: true, force: true });
            if (fs.existsSync(src)) fs.cpSync(src, path.join(root, d), { recursive: true });
            try { hardenDataPerms(root); } catch {}   // cpSync 不经 atomicWrite → 权限随源文件，恢复后统一收紧
          }
          for (const f of ['applications.json', 'materials.json', 'evaluations.json']) if (fs.existsSync(path.join(stage, f))) fs.copyFileSync(path.join(stage, f), path.join(root, f));
          // copyFileSync 保留源文件权限 → 备份里的 0644 会让本地 JSON 变同机可读（2026-10-22 审查 [中]）
          try { hardenDataPerms(root); } catch {}
          // docs-meta 成对替换：经 updateMeta 逐文档写（唯一写入者），不裸 copyFileSync 覆盖共享文件；损坏 → 抛 CORRUPT（500），绝不当成 {}
          const repMeta = readMetaSnapshotAt(path.join(stage, 'docs-meta.json'));
          if (repMeta) applyMetaSnapshot(repMeta);
        } else {
          // 合并：文档/快照按文件合并（同 id 以备份为准）；JSON 按 id 合并，本地独有保留
          for (const d of ['docs', 'snapshots']) {
            const src = path.join(stage, d);
            if (fs.existsSync(src)) fs.cpSync(src, path.join(root, d), { recursive: true });
            try { hardenDataPerms(root); } catch {}   // cpSync 不经 atomicWrite → 权限随源文件，恢复后统一收紧
          }
          // PDF：只补本地缺失的（不覆盖本地较新产物）；存档 PDF 缺失时补齐
          const srcP = path.join(stage, 'pdfs');
          if (fs.existsSync(srcP)) {
            const copyMissing = (from, to) => {
              for (const f of fs.readdirSync(from)) {
                const s = path.join(from, f), t = path.join(to, f);
                if (fs.statSync(s).isDirectory()) { fs.mkdirSync(t, { recursive: true }); copyMissing(s, t); }
                else if (!fs.existsSync(t)) fs.copyFileSync(s, t);
              }
            };
            fs.mkdirSync(path.join(root, 'pdfs'), { recursive: true });
            copyMissing(srcP, path.join(root, 'pdfs'));
          }
          const mergeById = (file, loadFn, saveFn) => {
            const bak = jsonIds(file);
            if (!bak || bak === 'CORRUPT' || bak === 'BAD_ID') return;
            const local = loadFn();
            const map = new Map(local.map((x) => [x.id, x]));
            for (const b of bak) map.set(b.id, b);   // 同 id：以备份为准（预览中已列出冲突）
            saveFn([...map.values()]);
          };
          mergeById('applications.json', loadApps, saveApps);
          mergeById('materials.json', loadMats, saveMats);
          mergeById('evaluations.json', loadEvals, saveEvals);
          const metaStage = path.join(stage, 'docs-meta.json');
          const bakMeta = readMetaSnapshotAt(metaStage);      // 损坏 → 抛 CORRUPT（500），绝不静默跳过或当成 {}
          if (bakMeta) {
            // 成对合并：同 id 以备份为准，逐文档经 updateMeta 写（本地独有文档保留，不整表覆盖）
            for (const k of Object.keys(bakMeta)) updateMeta(root, k, () => bakMeta[k]);
          }
        }
      } catch (e) {
        return sendJson(500, { ok: false, error: '恢复过程中失败：' + (e.message || e) + '（回退点：' + safety + '）', safety });
      } finally {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(tmpTar, { force: true }); } catch {}
      }
      return sendJson(200, { ok: true, safety: path.basename(safety), mode, applied: preview });
    }
    if (req.method === 'POST' && url.pathname === '/restore/undo') {
      const tsParam = path.basename(url.searchParams.get('ts') || '');
      if (!/^restore-[0-9]+$/.test(tsParam)) return send(400, 'invalid ts', 'text/plain');
      const dir = path.join(root, 'backups', tsParam, 'data');
      if (!fs.existsSync(dir)) return sendJson(404, { ok: false, error: '回退点不存在' });
      // 存在性台账（AUD-09）：旧安全点没有 present → 不猜测删除任何用户数据（只覆盖备份里有的）。
      let undoManifest = null;
      try { undoManifest = JSON.parse(fs.readFileSync(path.join(root, 'backups', tsParam, 'manifest.json'), 'utf8')); } catch {}
      const present = (undoManifest && undoManifest.present && typeof undoManifest.present === 'object') ? undoManifest.present : null;
      // 回退点里的 docs-meta 先校验：损坏 → 500 拒绝，且发生在任何删除/覆盖之前（否则会先清空本地再把 meta 当成 {} 全删）
      let undoMeta;
      try { undoMeta = readMetaSnapshotAt(path.join(dir, 'docs-meta.json')); }
      catch (e) { return sendJson(e.httpCode || 500, { ok: false, error: '回退失败：' + (e.message || e) }); }
      // 先把当前状态留一份（回退也可再次回退）
      const ts2 = Date.now();
      const safety2 = path.join(root, 'backups', 'restore-' + ts2);
      // 回退点结构须与 restore 主路径一致（backups/<ts>/data/...）：undo 的读取端按 data/ 取，
      // 原先只建 safety2 本身并把内容放在其下，等于自己造的回退点无法再回退
      fs.mkdirSync(path.join(safety2, 'data'), { recursive: true });
      for (const d of RESTORE_MANAGED_DIRS) if (fs.existsSync(path.join(root, d))) fs.cpSync(path.join(root, d), path.join(safety2, 'data', d), { recursive: true });
      try { hardenDataPerms(root); } catch {}   // cpSync 不经 atomicWrite → 权限随源文件，恢复后统一收紧
      for (const f of RESTORE_MANAGED_FILES) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(safety2, 'data', f));
      // 自己的回退点同样要带存在性台账 → 「undo 之后再 undo」也能精确还原
      {
        const p2 = {};
        for (const d of RESTORE_MANAGED_DIRS) p2[d] = fs.existsSync(path.join(root, d));
        for (const f of RESTORE_MANAGED_FILES) p2[f] = fs.existsSync(path.join(root, f));
        fs.writeFileSync(path.join(safety2, 'manifest.json'), JSON.stringify({ ts: String(ts2), mode: 'undo', at: new Date().toISOString(), present: p2 }, null, 2));
      }
      try {
        for (const d of RESTORE_MANAGED_DIRS) {
          const src = path.join(dir, d);
          // 恢复前不存在 → 撤销时必须删掉恢复引入的目录（否则「恢复→撤销」不回到原状）
          if (present && present[d] === false) {
            try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch {}
            continue;
          }
          if (!fs.existsSync(src)) continue;   // 旧安全点或备份不完整 → 不动，不猜
          fs.rmSync(path.join(root, d), { recursive: true, force: true });
          fs.cpSync(src, path.join(root, d), { recursive: true });
          try { hardenDataPerms(root); } catch {}   // cpSync 不经 atomicWrite → 权限随源文件，恢复后统一收紧
        }
        for (const f of ['applications.json', 'materials.json', 'evaluations.json']) {
          // 恢复前不存在 → 撤销时删掉恢复导入的（否则导入的评估文件留在原地）
          if (present && present[f] === false) {
            try { fs.rmSync(path.join(root, f), { force: true }); } catch {}
            continue;
          }
          if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(root, f));
        }
        // docs-meta 成对回退：经 updateMeta 逐文档写（唯一写入者）
        if (undoMeta) applyMetaSnapshot(undoMeta);
        // 恢复前没有 meta 文件 → 撤销后也不该有（applyMetaSnapshot 已把表清空）
        if (present && present['docs-meta.json'] === false) {
          try { fs.rmSync(path.join(root, 'docs-meta.json'), { force: true }); } catch {}
        }
      } catch (e) {
        return sendJson(500, { ok: false, error: '回退失败：' + (e.message || e) + '（本次操作前的状态在 ' + safety2 + '）' });
      }
      // 返回自己的回退点名 → 「撤销之后再撤销」可用（AUD-09 验收要求）
      return sendJson(200, { ok: true, safety: path.basename(safety2) });
    }
    // ===== PDF / 导出 =====
    // 历史版本 PDF：从快照内容渲染到独立文件，语义与「最新版」明确分开
    if (req.method === 'GET' && url.pathname === '/snapshot/pdf') {
      const ts = path.basename(url.searchParams.get('ts') || '');
      if (!VALID_ID.test(id) || !/^[0-9-]+$/.test(ts)) return send(400, 'invalid id/ts', 'text/plain');
      const snapFile = path.join(snapDir(id), ts + '.html');
      if (!fs.existsSync(snapFile)) return send(404, 'snapshot not found', 'text/plain');
      const out = path.join(root, 'pdfs', 'history', id + '@' + ts + '.pdf');
      if (!fs.existsSync(out)) {
        const snapR = await renderDoc({ src: snapFile, out, lease: leaseOf(req) });
        const ok = snapR.ok;
        if (!ok || !fs.existsSync(out)) return send(500, '历史版本渲染失败，请重试（详见服务日志）', 'text/plain');
      }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${sanitizeFileName(id + '_' + ts)}.pdf"` });
      return fs.createReadStream(out).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/pdf') {
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      // 陈旧判定 = 渲染标识（staleInfo），mtime 仅日志；缺失/过期自动重渲一律走 renderCurrent 冻结组装。
      // 绝不直渲磁盘 HTML：迁移后当前文档不含内联 typo，直渲会丢排版。
      // PDF 路径存在但不是普通文件（如被外部建成同名目录）时，renderCurrent 会在
      // atomicWrite 的 rename 上抛 EISDIR，异常冒泡到通用 catch；那时响应头可能已发 →
      // ERR_HTTP_HEADERS_SENT 撞掉整个进程（2026-10-19 实测）。故在【渲染之前】拦。
      const _pdfPath0 = pdfPath(id);
      if (fs.existsSync(_pdfPath0) && !fs.statSync(_pdfPath0).isFile()) {
        return send(500, 'PDF 路径不是普通文件（可能是同名目录），已拒绝渲染', 'text/plain');
      }
      let rst = currentRenderState(id);
      if (rst.stale) {
        console.error(`[render] /pdf 自动重渲 id=${id} state=${rst.state} renderInputId=${rst.frozen.renderInputId} docMtime=${rst.docMtime}（mtime 仅日志）`);
        await renderCurrent(id, { lease: leaseOf(req) });
        rst = currentRenderState(id);   // 复判：渲染期间文档可能又被保存（仍按标识，不用 mtime）
      }
      if (!rst.pdfExists) return send(500, '渲染失败：PDF 未生成，请到导出页重试（详见服务日志）', 'text/plain');
      const meta = rst.meta;
      const docHtml = fs.readFileSync(docPath(id), 'utf8');
      const name = decodeName((docHtml.match(/<h1[^>]*>([^<]*)<\/h1>/) || [])[1] || id);
      const date = new Date().toISOString().slice(0, 10);
      const parts = meta.parent ? [name, meta.role || '', meta.company || '', date] : [name, id, date];
      const fileName = sanitizeFileName(parts.filter(Boolean).join('_')) + (rst.stale ? '_旧版本' : '') + '.pdf';
      // 文件名含中文：ASCII 兜底 + RFC 5987 filename*（ext-value 额外编码 !'()*，见 dispositionFileName）
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; ${dispositionFileName(fileName)}`,
        'X-PDF-Stale': rst.stale ? '1' : '0'
      });
      return fs.createReadStream(pdfPath(id)).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      const faviconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f5d50"/><text x="16" y="22" font-size="15" text-anchor="middle" fill="#fff" font-family="serif">履</text></svg>';
      return send(200, faviconSvg, 'image/svg+xml');
    }
    if (req.method === 'GET' && url.pathname === '/export') {
      if (!VALID_ID.test(id)) return send(400, 'invalid id', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      const docStat = fs.statSync(docPath(id));   // mtime 仅展示/日志，陈旧判定走 staleInfo
      let rst = currentRenderState(id);
      let renderError = null;
      if (rst.stale) {
        console.error(`[render] /export 自动重渲 id=${id} state=${rst.state} renderInputId=${rst.frozen.renderInputId} docMtime=${rst.docMtime}（mtime 仅日志）`);
        const r = await renderCurrent(id, { lease: leaseOf(req) });   // 组装渲染（当前 HTML+当前 meta），绝不直渲磁盘 HTML
        rst = currentRenderState(id);
        if (!r.ok || !rst.pdfExists) renderError = '渲染失败（详见服务日志）';
      }
      const meta = rst.meta;
      const job = meta.job || null;
      const pdfStat = rst.pdfExists ? fs.statSync(pdfPath(id)) : null;
      const pdfCurrent = rst.state === 'fresh' && !renderError;
      const docHtml = fs.readFileSync(docPath(id), 'utf8');
      const lines = docToText(docHtml, { includeHidden: false }).split('\n');
      const projects = countProjects(docPath(id));
      
      const pageTexts = [];   // S4a-T10：分页文本层（排版诊断输入）
      const rows = [];   // PDF 体检结论行（页面/空白页/孤立标题/字符量/文本层自检）
      // 体检结论的通过/告警标记：图标 + 语义色（颜色不单独承载语义，WCAG color-not-only）
      const mark = (ok) => `<span style="color:var(--${ok ? 'ok' : 'warn'})">${icon(ok ? 'check' : 'circle-alert', 12)}</span>`;
      let pages = 0;   // 块外 3254 的 layout 门控要用到，声明须在 pdfStat 分支之前
      let fullText = '';       // 全文 pdftotext 的输出（文本层自检的输入；原来只取 .length 丢弃文本）
      let totalChars = 0;      // 全文文本层字符量（渲染检查行与「机器读到的样子」折叠区共用同一口径）
      let budgetCut = false;   // 分页提取预算耗尽 → 文本层结论不可靠（见 layerCheck）
      if (pdfStat) {
        try { pages = parseInt(execFileSync('pdfinfo', [pdfPath(id)], { timeout: 10000 }).toString().match(/Pages:\s*(\d+)/)?.[1] || '0', 10); } catch { pages = 0; }
        const blank = [], orphan = [];
        // 总预算（AUD-17）：单页 15s 超时 × 页数会累积成无界等待 → 加整轮上限，耗尽即停并如实说明。
        const EXTRACT_BUDGET_MS = 20000;
        const extractDeadline = Date.now() + EXTRACT_BUDGET_MS;
        for (let p = 1; p <= pages; p++) {
          if (Date.now() > extractDeadline) { budgetCut = true; break; }
          let t = '';
          try { t = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), pdfPath(id), '-'], { timeout: 15000 }).toString('utf8'); } catch {}
          pageTexts.push({ page: p, text: t });
          const clean = t.replace(/\s+/g, ' ').trim();
          if (clean.length < 10) blank.push(p);
          const lastLine = t.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
          if (lastLine && lastLine.length <= 10 && !/[，。、；：！？,.0-9]/.test(lastLine) && clean.length >= 10) orphan.push(p);
        }
        // 全文 pdftotext：原来只取 .length（文本被丢掉），这里保留文本本身供下面的文本层自检用。
        // 进程调用次数与超时都不变（仍是这一次全文调用，30s）。
        try { fullText = execFileSync('pdftotext', [pdfPath(id), '-'], { timeout: 30000 }).toString('utf8'); } catch { fullText = ''; }
        totalChars = fullText.length;
        rows.push(`${mark(pages > 0)} 实际页数：${pages || '读取失败'}${pages === 2 ? '（符合两页目标）' : pages > 2 ? '（超过两页，见下方建议）' : ''}`);
        if (budgetCut) rows.push(`${mark(false)} 分页文本提取：超出 ${EXTRACT_BUDGET_MS / 1000}s 总预算，只提取了前 ${pageTexts.length}/${pages} 页（结论不完整）`);
        rows.push(`${mark(!blank.length)} 空白页检查：${blank.length ? `疑似空白页：${blank.join('、')}` : '无'}`);
        rows.push(`${mark(!orphan.length)} 孤立标题检查：${orphan.length ? orphan.map((p) => `第${p}页末疑似孤立标题`).join('；') : '无'}`);
        rows.push(`${mark(totalChars >= TEXT_LAYER_MIN_CHARS)} ${textLayerCharNote(totalChars)}`);   // R2⑧：告警带阈值与原因（口径唯一出处 = textLayerCharNote）
        
      }
      // ===== 文本层自检：姓名 / 邮箱 / 电话在 PDF 文本层里能不能被提取到 =====
      // 期望串来自可见事实：姓名 = 文档 <h1> 原文（decodeName 同法）；邮箱 = 正文首个 email 匹配；
      // 电话 = 正文首个 11 位手机号（容忍 +86 前缀与空格/连字符分隔；18 位证件号等长数字串不误命中）。
      // 两侧剥掉所有空白再比 substring —— PDF 文本层常在词间断行，直接比会误判为「提取不到」。
      // 行文案只出 ✓/⚠ 与命中计数，**不回显邮箱/电话原文**（邮箱与电话是个人信息，导出页只报能不能提取）。
      // fail-honest：没有 PDF / 分页预算耗尽 / 文本层没取到 / 文档里根本没有该字段 → 一律「未校验」，绝不报通过。
      const squashWs = (t) => String(t == null ? '' : t).replace(/\s+/g, '');
      const nameRaw = (docHtml.match(/<h1[^>]*>([^<]*)<\/h1>/) || [])[1] || '';
      const nameExpect = nameRaw ? decodeName(nameRaw) : '';
      const emailExpect = (lines.join('\n').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [''])[0];
      const phoneExpect = (lines.join('\n').match(/(?<!\d)(?:\+?86[- ]?)?1[3-9](?:[ -]?\d){9}(?!\d)/) || [''])[0];
      const layerCheck = (label, expect, what) => {
        if (!pdfStat) return `${mark(false)} ${label}：未校验（还没有 PDF）`;
        if (budgetCut) return `${mark(false)} ${label}：未校验（分页文本提取超出预算，结论不可靠）`;
        if (!fullText) return `${mark(false)} ${label}：未校验（PDF 文本层未取到）`;
        if (!expect) return `${mark(false)} ${label}：未校验（文档里没有${what}）`;
        const n = squashWs(fullText).split(squashWs(expect)).length - 1;
        return n > 0 ? `${mark(true)} ${label}：命中 ${n} 处` : `${mark(false)} ${label}：未在文本层找到`;
      };
      rows.push(layerCheck('姓名可提取', nameExpect, '姓名'));
      rows.push(layerCheck('邮箱可提取', emailExpect, '邮箱'));
      rows.push(layerCheck('电话可提取', phoneExpect, '电话'));
      // ===== 批 2 b2c2：文本层预览 —— 折叠区「机器读到的样子」=====
      // 服务端 pdftotext 的结果**原样**展示：机器（ATS）真正读到的就是这些字符。
      // 只展示，不打分、不给结论、不出「通过」徽章（批 2 §0.1 诚实边界）；不新增提取调用（复用上面那一次全文提取）。
      // 字符量口径沿用既有「渲染检查」行：同一实现（textLayerCharNote）→ 同一阈值 200、同一告警文案。
      const layerPreviewText = pdfStat ? String(fullText || '') : '';
      const layerPreviewBody = !pdfStat
        ? '<p style="font-size:13px;color:var(--mut);margin:var(--space-2) 0 0">还没有 PDF——生成后这里会显示机器读到的文本层</p>'
        : !layerPreviewText
          ? '<p style="font-size:13px;color:var(--mut);margin:var(--space-2) 0 0">PDF 文本层未取到</p>'
          : `<pre data-layer-preview style="font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:var(--space-2) 0 0;padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius);background:var(--card-2)">${escHtml(layerPreviewText)}</pre>`;
      const layerPreview = `<details id="textLayerPreview" class="card" style="margin-top:var(--space-3)">
        <summary style="cursor:pointer;font-weight:700">机器读到的样子</summary>
        ${pdfStat ? `<div style="font-size:12px;color:var(--mut);margin-top:var(--space-2)">${escHtml(textLayerCharNote(totalChars))}</div>` : ''}
        ${layerPreviewBody}
      </details>`;
      const suggestions = pageSuggestions(lines, { projects }).map((s) => `<li>${escHtml(s.text)}</li>`).join('');
      // S4a-T10：排版诊断（渲染级，半自动 3 轮；结构性事实表述；下限内不再压缩；超页二出路）+ 导出检查三级（与审阅 Tab 同源 jobViewLive）
      const jobLive = jobViewLive(id, meta);
      const expChecks = exportChecks(jobLive, { mats: loadMats(), paras: parasOf(docHtml), html: docHtml });
      // 批 2 · S4a ⑪：确定性内容检查（三级：需修复 / 建议核对 / 风格建议；纯规则零 AI；不参与导出门控）
      // 与审阅 Tab 第三段同一实现（content-check.mjs）——单一通道，两侧同结果。
      const cc = expChecks.content || { fix: [], verify: [], style: [] };
      const ccSection = [['fix', '需修复', 'var(--err)'], ['verify', '建议核对', 'var(--warn)'], ['style', '风格建议', 'var(--mut)']]
        .map(([k, label, color]) => {
          const arr = Array.isArray(cc[k]) ? cc[k] : [];
          const body = arr.length ? arr.map((it) => escHtml(it.text)).join('；') : '（无）';
          return `<div data-cc="${k}" style="font-size:13px;margin:var(--space-2) 0"><span style="color:${color}">${label} ${arr.length} 条</span>：${body}</div>`;
        }).join('');
      const typoVals = (() => {
        const t = String(meta.typo || '');
        const num = (re, d) => { const m = t.match(re); return m ? parseFloat(m[1]) : d; };
        return { fontSize: num(/font-size:([\d.]+)px/, 13), lineHeight: num(/line-height:([\d.]+)/, 1.43), paraGap: num(/margin-bottom:([\d.]+)mm/, 0.45) };
      })();
      const secTitles = sectionsOf(fs.readFileSync(docPath(id), 'utf8')).map((x) => ({ title: x.title }));
      const layout = pdfStat && pages > 0
        ? layoutDiagnose(pageTexts, { paras: parasOf(fs.readFileSync(docPath(id), 'utf8')), sections: secTitles, typo: typoVals, targetPages: (job && job.brief && job.brief.pages) || 2, rounds: Number(meta.layoutRounds) || 0 })
        : null;
      const layoutBlock = !layout ? '' : `
    <div class="card" style="margin-top:12px"><b class="card-title">排版诊断</b><span style="font-size:12px;color:var(--mut)">（排版迭代 ${layout.rounds}/3 轮 · 实际 ${layout.pages} 页 / 目标 ${layout.target} 页 · 请以实际渲染核对）</span>
      ${layout.items.length ? `<ul style="font-size:13px">${layout.items.map((it) => `<li>${escHtml(it.text)}${it.zid ? `（<a href="/edit?id=${id}">定位 ${escHtml(it.zid)}</a>）` : it.page ? `（第 ${it.page} 页）` : ''}</li>`).join('')}</ul>` : '<p style="font-size:13px;color:var(--mut)">无跨页标题 / 末页偏少等结构性事项。</p>'}
      ${layout.over && layout.apply ? `<div style="font-size:13px">建议本轮参数：字号 ${typoVals.fontSize}px → <b>${layout.apply.fontSize}px</b> · 行高 ${typoVals.lineHeight} → <b>${layout.apply.lineHeight}</b> · 段距 ${typoVals.paraGap}mm → <b>${layout.apply.paraGap}mm</b>
        <form id="layApplyForm" style="display:inline;margin-left:8px"
          data-action="layApply" data-id="${escAttr(id)}">
          <input type="hidden" name="fontSize" value="${layout.apply.fontSize}">
          <input type="hidden" name="lineHeight" value="${layout.apply.lineHeight}">
          <input type="hidden" name="paraGap" value="${layout.apply.paraGap}">
          <button class="secondary" type="submit">应用本轮建议并重渲染</button>
          <span id="layMsg" style="font-size:12px"></span></form></div>` : ''}
      ${layout.over && (!layout.apply) ? `<div style="font-size:13px">${layout.atFloor ? '已达最小可读参数下限（字号 ≥12px、行高 ≥1.3、段距 ≥0.4mm），不再给压缩建议。' : '已到排版迭代 3 轮上限。'}超页出路二选一：<b>a) 人工取舍</b>——最长的候选精简项：${layout.topLong.map((p) => `<a href="/edit?id=${id}">${escHtml(p.text.slice(0, 18))}…</a>`).join('、')}；<b>b) 超页导出</b>——PDF 正常下载，导出记录将标注「超页导出：${layout.pages} 页」。</div>` : ''}
      <p style="font-size:12px;color:var(--mut)">内容精简（上方建议核对/风格建议）与排版调整（本轮参数）分别接受，互不替代。</p>
    </div>`;
      // 事实冲突/重点审阅门控
      const pendingConflicts = pendingConflictsOf(meta);   // 复用已带 Array.isArray 兜底的实现：旧 meta 缺 changes 时原写法直接抛 TypeError 让整页 500
      const pendingImportant = (job && Array.isArray(job.changes) ? job.changes.filter((c) => c.level === 'important' && c.status === 'pending') : []);
      const gate = pendingConflicts.length
        ? `<div class="card" style="border-color:var(--err-soft);background:var(--err-soft)"><b>${icon('circle-slash', 13)} 存在 ${pendingConflicts.length} 条事实冲突未处理，暂不能下载</b>
           <p style="font-size:13px">请到编辑器右侧「审阅」面板逐条处理（接受或撤销）后再导出：</p>
           <ul style="font-size:13px">${pendingConflicts.map((c) => `<li>${escHtml((c.section || '') + '：' + (c.reason || c.before || c.id))}</li>`).join('')}</ul>
           <p><a href="/edit?id=${id}">去处理 →</a></p></div>`
        : '';
      const importantWarn = pendingImportant.length
        ? `<div class="badge warn">${icon('circle-alert', 11)}${pendingImportant.length} 条重点审阅建议待处理（不阻塞导出）</div>`
        : '';
      // S4a 上线后修复3：可投递改为显式确认——整体审阅完成 + 当前 PDF 才出按钮；确认后 S1 flow 契约不变
      const flowNow = flowOf(meta);
      const confirmDeliverable = meta.parent && pdfCurrent && expChecks.reviewComplete && flowNow !== 'reviewed'
        ? `<form method="post" action="/job/changes?id=${id}" style="display:inline" data-action="jobDeliver" data-id="${escAttr(id)}"><button class="secondary" type="submit">确认可投递</button></form>`
        // R2⑥：button.ok 从无样式定义（一直误渲染成 accent 实底）→ 降 secondary；「（整体审阅已完成）」状态说明移出按钮文案——上下徽章/导出检查区已承载同一状态
        : flowNow === 'reviewed' ? badge('ok', '已确认可投递')
        : `<span class="badge mute" title="整体审阅完成 + 当前 PDF 后可确认">${icon('circle-help', 11)}未确认可投递</span>`;
      const versionLine = pdfCurrent
        ? badge('ok', 'PDF 与当前内容一致')
        : pdfStat
          ? `${badge('err', '当前显示的是旧版本 PDF（生成于 ' + new Date(pdfStat.mtimeMs).toLocaleString('zh-CN') + '），不是最新内容')}`
          : `${badge('err', '尚无 PDF')}`;
      const trackSrc = meta.parent ? `<span class="badge ai">${escHtml((meta.company || '') + '·' + (meta.role || ''))}</span>` : '';
      // R2⑦：导出对象行——岗位稿 company·role 徽章优先、id 退居次要；母版无徽章则维持 id 主显。
      //   （旧文案是进行时措辞，本页是状态页，整词已从源面清零并被 test-structure.sh 钉死。）
      const exportObj = trackSrc
        ? `${trackSrc} <span style="font-size:12px;color:var(--mut)">文档 ${escHtml(id)}</span>`
        : `<b>${escHtml(id)}</b>`;
      // 导出记录（S1-T8）：不可变产物列表；usedBy/deliveredRefs 读取时派生自 applications.json（权威来源，绝不存储）
      const apps4ex = loadApps();
      const deliveredCnt = apps4ex.filter((a) => a.docId === id).length;
      const exRows = exportsOf(meta).slice().reverse().map((e) => {
        const used = usedByExport(e.exportId);
        const fOk = e.file && fs.existsSync(path.join(root, path.normalize(String(e.file))));
        const isCur = e.renderInputId === rst.frozen.renderInputId;
        return `<div style="display:flex;justify-content:space-between;gap:8px;margin:6px 0;font-size:12px;flex-wrap:wrap">
          <span>${escHtml(String(e.at || ''))}${isCur ? ' ' + badge('ok', '当前内容') : ''} · <code>${escHtml(String(e.renderInputId || '').slice(0, 12))}…</code> · ${Number(e.pages) || 0} 页 · 主题 ${escHtml(String(e.theme || '-'))}${used.length ? ` <span class="badge ai">投递使用：${used.map((a) => escHtml(String(a.company || '') + '·' + String(a.role || ''))).join('、')}</span>` : ''}</span>
          <span>${fOk ? `<a href="/history-pdf?exportId=${encodeURIComponent(String(e.exportId || ''))}">下载</a>` : badge('err', '产物缺失')}</span>
        </div>`;
      }).join('');
      return send(200, page('导出', `<h1>导出 PDF</h1>
    <div class="card">
      <p>导出对象：${exportObj} ${versionLine}</p>
      <p style="font-size:13px;color:var(--mut)">最后编辑 ${docStat.mtime.toLocaleString('zh-CN')}${pdfStat ? ` ｜ PDF 生成于 ${new Date(pdfStat.mtimeMs).toLocaleString('zh-CN')}` : ''}</p>
      ${renderError ? `<p style="color:var(--err)">${icon('circle-x', 13)}重新生成失败：${escHtml(renderError)}。下方数据基于${pdfStat ? '旧版本 PDF' : '无 PDF'}，请修复渲染环境后重试。</p>` : ''}
      ${!pdfCurrent && pdfStat && !renderError ? `<p style="color:var(--warn)">${icon('circle-alert', 13)}文档内容已更新（渲染标识不一致），当前 PDF 不是最新内容。</p>` : ''}
      ${gate}
      ${importantWarn}
      <p>
        ${pdfCurrent && !pendingConflicts.length ? `<button id="dlBtn">下载最新版 PDF</button>` : `<button disabled title="先解决上方问题">下载最新版 PDF</button>`}
        ${confirmDeliverable}
        <button class="secondary" type="button" data-action="rerender">重新生成</button>
        <a href="/snapshots?id=${id}" class="secondary" style="margin-left:8px">历史导出</a>
        <a href="/edit?id=${id}" class="secondary" style="margin-left:8px">返回编辑</a>
        <span id="rrMsg" style="font-size:12px"></span>
      </p>
      <details style="font-size:13px;margin-top:6px"><summary style="cursor:pointer">语义说明</summary>
        <div>· 下载/记录投递：都先 POST /export 创建不可变导出记录（幂等键 renderInputId，同内容重复点击不再记录），产物存 pdfs/history/，经 /history-pdf?exportId=… 下载<br>· 投递存档：绑定所选导出的冻结快照，之后改稿不影响它（绝不重冻后来的正文）<br>· 下方预览为「最新版」便利文件（可被覆盖）；导出记录与投递存档不指向它</div></details>
    </div>
    ${rows.length ? `<div class="card" style="margin-top:12px"><b class="card-title">渲染检查</b>${rows.map((r) => `<div style="margin:6px 0">${r}</div>`).join('')}</div>` : ''}
    ${layerPreview}
    ${layoutBlock}
    <div class="card" style="margin-top:12px"><b class="card-title">导出检查（内容侧，与审阅 Tab 同源即时状态）</b>
      <div style="font-size:13px;margin:6px 0">建议核对：${(() => {
        const v = expChecks.check || {};
        const parts = [];
        if (v.toVerify && v.toVerify.length) parts.push('待核对候选 ' + v.toVerify.length + ' 条');
        const thin = (v.thin || []).length;
        if (thin) parts.push('表达不充分证据 ' + thin + ' 条');
        const stale = (v.stale || []).length;
        if (stale) parts.push('来源已变化证据 ' + stale + ' 条');
        const imp = (job && Array.isArray(job.changes) ? job.changes.filter((c) => c.level === 'important' && c.status === 'pending').length : 0);
        if (imp) parts.push('重点审阅 ' + imp + ' 条');
        return parts.length ? parts.join('；') + '（不阻塞导出）' : '无';
      })()}</div>
      <div style="font-size:13px;margin:6px 0">整体审阅完成：${expChecks.reviewComplete ? icon('circle-check', 13) + ' 是（可进入投递）' : '否（仍有待处理/稍后处理/待核对项——不阻塞导出）'}</div>
      <div style="font-size:13px;margin:var(--space-3) 0 0">确定性内容检查<span style="color:var(--mut)">（纯规则，不阻塞导出）</span></div>
      ${ccSection}
    </div>
    ${suggestions ? `<div class="card" style="margin-top:12px"><b class="card-title">超过两页的可读处理建议</b><ol style="font-size:13px">${suggestions}</ol><p style="font-size:12px;color:var(--mut)">不需要靠缩小字号硬塞：优先去重、精简、隐藏低相关项目；也可以保留更多页。</p></div>` : ''}
    <div class="card" style="margin-top:12px">
      <b class="card-title">导出记录</b> <span style="font-size:12px;color:var(--mut)">不可变产物；同内容（同 renderInputId）只记一条</span>
      ${exRows || '<div style="color:var(--mut);font-size:12px;margin-top:6px">尚无导出记录（点「下载最新版 PDF」即创建首条）</div>'}
    </div>
    <div class="card" style="margin-top:12px">
      <b class="card-title">记录已投递</b>
      <p style="font-size:12px;color:var(--mut)">只做记录，不会自动发送任何文件。记录时先创建不可变导出（同内容复用既有记录），存档 PDF 绑定该导出的冻结快照。${deliveredCnt ? `该文档已有 ${deliveredCnt} 条投递记录（关联按 exportId 派生）。` : ''}</p>
      <form id="trackForm">
        <!-- value 是属性上下文：company/role 原样落库（用户可控）→ escAttr（不转义 " 就能闭合属性注入事件处理器） -->
        <input id="tkCompany" placeholder="公司" aria-label="公司" value="${escAttr(meta.company || '')}" required>
        <input id="tkRole" placeholder="岗位" aria-label="岗位" value="${escAttr(meta.role || '')}" required>
        <input id="tkChannel" placeholder="渠道（可选）" aria-label="投递渠道" size="12">
        <input id="tkDate" type="date" aria-label="投递日期">
        <button ${pdfCurrent && !pendingConflicts.length ? '' : 'disabled title="先解决上方问题"'}>记录已投递</button><span id="tkMsg" role="status" style="font-size:12px"></span>
      </form>
    </div>
    ${pdfStat ? `<iframe src="/pdf?id=${id}" title="PDF 预览" style="width:100%;height:70vh;margin-top:12px;border:1px solid var(--line);border-radius:var(--radius-lg)"></iframe><p style="color:var(--mut);font-size:12px">预览为「最新版」便利文件；下载请用上方的导出记录（不可变产物）。</p>` : ''}
    <script nonce="__CSP_NONCE__">
      // S4a 上线后修复3：移除「打开导出页即自动标记可投递」——改为契约判定（整体审阅完成 + 当前 PDF）下的显式用户确认。
      async function rerender() {
        var msg = document.getElementById('rrMsg');
        msg.textContent = ' 生成中…';
        try {
          var r = await fetch('/render?id=${id}', { method: 'POST' });
          var d = await r.json();
          if (d.ok) __status(msg, 'ok', '已重新生成'); else __status(msg, 'err', d.error || '失败');
          if (d.ok) setTimeout(function () { location.reload(); }, 600);
        } catch (e) { __status(msg, 'err', e.message); }
      }
      // 下载按钮 = POST /export（唯一记录者，幂等）→ 导航到 /history-pdf?exportId=… 下载不可变产物（不再链 /pdf）
      var dlBtn = document.getElementById('dlBtn');
      if (dlBtn) dlBtn.onclick = async function () {
        var msg = document.getElementById('rrMsg');
        dlBtn.disabled = true; msg.textContent = ' 导出中…';
        try {
          var r = await fetch('/export?id=${id}', { method: 'POST' });
          var d = await r.json().catch(function () { return null; });
          if (d && d.ok && d.url) { __status(msg, 'ok', d.reused ? '复用既有导出记录' : '已创建导出记录'); location.href = d.url; dlBtn.disabled = false; }
          else { __status(msg, 'err', (d && d.error) || '导出失败'); dlBtn.disabled = false; }
        } catch (e) { __status(msg, 'err', e.message); dlBtn.disabled = false; }
      };
      // 记录已投递：先 POST /export 取得（或复用）当前身份的导出记录 → /app/add 绑定 exportId（存档来自该导出的冻结快照）
      document.getElementById('trackForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = document.getElementById('tkMsg');
        msg.textContent = ' 记录中…';
        try {
          var er = await fetch('/export?id=${id}', { method: 'POST' });
          var ed = await er.json().catch(function () { return null; });
          if (!ed || !ed.ok || !ed.exportId) { __status(msg, 'err', '导出失败，未记录投递：' + ((ed && ed.error) || '')); return; }
          var r = await fetch('/app/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ company: document.getElementById('tkCompany').value.trim(), role: document.getElementById('tkRole').value.trim(),
              docId: '${id}', channel: document.getElementById('tkChannel').value.trim(), appliedAt: document.getElementById('tkDate').value, exportId: ed.exportId }) });
          var d = await r.json().catch(function () { return null; });
          if (d && d.ok) {
            __status(msg, 'ok', '已记录（未自动发送；存档绑定本次导出快照）');
            msg.appendChild(Object.assign(document.createElement('a'), { href: '/applications', textContent: ' 去「投递」页跟踪 →' }));   // A5：投递收尾不隐式
            if (d.warning) alert(d.warning);
          } else __status(msg, 'err', (d && d.error) || '失败');
        } catch (err) { __status(msg, 'err', err.message); }
      });
      // ===== 内联 handler 委托化注册（b5c1）：data-action → 实现（与原内联 onsubmit/onclick 行为一致）=====
      var __acts = window.__acts || (window.__acts = { click: {}, change: {}, input: {}, submit: {}, keydown: {} });
      __acts.submit.layApply = function (el, ev) {
        ev.preventDefault();
        var f = el, m = document.getElementById('layMsg');
        m.textContent = ' 应用中…';
        __wv('/export/layout-apply?id=' + el.getAttribute('data-id'), { fontSize: Number(f.fontSize.value), lineHeight: Number(f.lineHeight.value), paraGap: Number(f.paraGap.value) }, m)
          .then(function (d) { m.textContent = ' 已应用（第 ' + d.rounds + ' 轮，实际 ' + d.pages + ' 页）'; setTimeout(function () { location.reload(); }, 900); })
          .catch(function (e) { m.textContent = ' 应用失败：' + (e.message || e); });
      };
      __acts.submit.jobDeliver = function (el, ev) {
        ev.preventDefault();
        // 载荷保持原内联的紧凑形态（status:'deliverable' 无空格）——test.sh「导出页不得自动标记」
        // 的负向钉以带空格的旧自动标记字面为探针（test.sh:2113），此处不改探针、不碰其判定。
        __wv('/job/changes?id=' + el.getAttribute('data-id'), {id: el.getAttribute('data-id'), status:'deliverable'})
          .then(function () { location.reload(); })
          .catch(function (e) { alert('确认失败：' + e.message); });
      };
      __acts.click.rerender = function (el) { return rerender(); };
    </script>`, 'docs'));
    }
    send(404, 'not found', 'text/plain');
  } catch (e) {
    // 头已发出时不能再 send() —— ERR_HTTP_HEADERS_SENT 会撞掉整个进程。
    // 2026-10-19 修 /pdf 空响应时踩到：深层异常冒泡到这里时 res 已开始写。
    if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} console.error('[handler] 响应已开始，跳过错误回传:', e && e.message); return; }
    if (e instanceof LockHeld) return send(409, '另一个写操作正在进行，请稍后重试', 'text/plain');
    send(e instanceof SyntaxError ? 400 : e.message === 'body too large' ? 413 : (e.httpCode || 500),
      e instanceof SyntaxError ? 'bad JSON body' : (e.code === 'CORRUPT' ? e.message : 'server error: ' + e.message), 'text/plain');
  }
}

// 内容版本守卫：客户端送来它认为的磁盘 mtime，不一致说明有未同步的编辑 → 409
function staleGuard(docId, baseMtime) {
  const base = Number(baseMtime || 0);
  if (!base || !fs.existsSync(docPath(docId))) return null;
  const cur = fs.statSync(docPath(docId)).mtimeMs;
  if (cur > base + 2) return { ok: false, stale: true, mtime: cur, error: '文档有未同步的修改，请先保存再让 AI 分析' };
  return null;
}
function countProjects(docFile) {
  try {
    const html = fs.readFileSync(docFile, 'utf8');
    const secs = sectionsOf(html);
    const p = secs.find((s) => s.title.includes('项目'));
    if (!p) return 0;
    return Math.max(0, (p.html.match(/class="entry-head"/g) || []).length);
  } catch { return 0; }
}
// 文本层字符量口径（唯一出处 · 批 2 b2c2）：阈值 200 + 告警文案。
// 导出页「渲染检查」行与「机器读到的样子」折叠区共用这一个实现 → 口径沿用：只有一套阈值、一套文案，
// 不存在第二处判据（源级钉值：告警文案在 server.mjs 只出现一次）。
const TEXT_LAYER_MIN_CHARS = 200;
const textLayerCharNote = (n) => `文本层字符量：${n}${n < TEXT_LAYER_MIN_CHARS ? `（<${TEXT_LAYER_MIN_CHARS}：图文简历可忽略，否则检查文本层）` : ''}`;
function sanitizeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'resume';
}
// Content-Disposition 文件名（ASCII 兜底 + RFC 5987 filename*）：Node 头仅允许 Latin1，非 ASCII 直写会 500。
// ext-value 在 encodeURIComponent 之外还需百分号编码 !'()*（RFC 5987 §3.2.1 attr-char；T4 review Minor-1 carry-in 修复）。
function dispositionFileName(fileName) {
  const asciiName = String(fileName).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  const ext = encodeURIComponent(String(fileName)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `filename="${asciiName}"; filename*=UTF-8''${ext}`;
}
function decodeName(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() || 'resume';
}

const PORTS = process.env.PORT && Number.isFinite(Number(process.env.PORT)) ? [Number(process.env.PORT)] : [7766, 7767, 7768];
function tryListen(i) {
  // 释放时机 = handler 的 Promise 真正结束（= 实际工作结束），不是 HTTP 响应结束。
  // 旧实现按 res 的 finish/close 释放：客户端一断连就腾槽，而模型请求/渲染子进程还在跑 →
  // 新请求进来会突破真实容量上限（RES-03 要求「断连后活跃工作仍占槽」）。
  const s = http.createServer((req, res) => {
    let p;
    try { p = handler(req, res); }
    catch (e) { try { res.statusCode = 500; res.end(String((e && e.message) || e)); } catch {} return; }
    // 路由里 `return somePromise` 的拒绝**不会**落进 handler 内部的 try/catch（try 只管同步抛与 await 到的拒绝），
    // 于是它会变成未处理拒绝 → 整个服务被杀（2026-10-28 补丁轮实证：/restructure 的渲染错误直接带崩服务）。
    // 这里兜住：记日志 + 回 500，服务继续活着。
    Promise.resolve(p).catch((e) => {
      console.error('[handler] 路由内部错误：', (e && e.stack) || (e && e.message) || e);
      if (!res.headersSent && !res.writableEnded) {
        try { res.statusCode = (e && e.httpCode) || 500; res.end('server error: ' + ((e && e.message) || e)); } catch {}
      }
    }).finally(() => {
      const l = req.__resLease;
      if (l) {
        req.__resLease = null;
        try { l.release(); }
        catch (e) { console.error('[slot] 归还闸门租约失败（凭证可能仍在使用中）：', (e && e.message) || e); }
      }
    });
  });
  s.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && i < PORTS.length - 1) return tryListen(i + 1);
    console.error('端口不可用:', e.message);
    process.exit(1);
  });
  s.listen(PORTS[i], '127.0.0.1', () => console.log(`简历平台: http://localhost:${PORTS[i]}`));
}
// 启动恢复：扫描 .tx/ 未完成事务（进程被杀于两次 rename 之间等），只恢复目标文档的正文与 meta，不覆盖其他文档的并发更新。
// 必须先于 listen（避免恢复完成前对外提供写服务）。陈旧 .migrate.lock（持有者已死）顺手清除，避免重启后写请求被误 503。
// S1 收尾 F-4：外来进程（活 pid）持 .migrate.lock = 迁移进行中，文档可能正处于 beginTx 与三门禁完成之间——
// 此刻回滚会让迁移随后的锁所有权复核（只验锁、不验文档）照样盖章 schemaVersion=2 → html 旧 + meta 已迁移。
// 故外锁在持时跳过本次启动恢复（记录原样留给持有者提交/清理，或下次干净启动恢复）；无外锁时行为不变。
let foreignMigrateLock = false;
try {
  foreignMigrateLock = rootLock.isHeld(root);
  if (fs.existsSync(rootLock.path(root)) && !foreignMigrateLock) rootLock.release(root);
} catch {}
if (foreignMigrateLock) {
  console.error('[tx] 跳过启动恢复：.migrate.lock 由外来进程持有（迁移进行中），未完成事务记录原样保留（持有者清理或下次干净启动恢复）');
} else {
  try {
    // 默认恢复（tx.mjs defaultRestoreDoc）：首选事务内旧正文副本（精确旧字节）；仅 oldHtml 载荷缺失时走快照兜底，
    // 兜底按热修 a7eb561 裁决 legacy-safe（oldMeta.typo 未定义 → 保留快照内联排版；已迁移 → 归一化正文）。
    const recovered = recoverPending(root);
    const done = recovered.filter((r) => r.ok);
    if (done.length) console.error(`[tx] 启动恢复未完成事务 ${done.length} 条：` + done.map((r) => `${r.docId}(${r.phase})`).join('、'));
    const failed = recovered.filter((r) => !r.ok);
    for (const r of failed) console.error(`[tx] 恢复失败（记录保留待重试）：${r.docId} — ${r.error}`);
    // S4a-T4（设计 §6 重启恢复，T3 锚点处落地）：扫全表 genTasks，running → error("应用重启中断，可重试")
    // 并置 taskId=null——重启前的在途回调（若进程还活着也回不来了）凭 taskId 校验全部失效。
    // 已落盘的 changes/todos/evidence 不动（updateMeta 原子性既有保证）；全表单事务（updateMetaAll）。
    let genInterrupted = 0;
    updateMetaAll(root, (all) => {
      for (const dm of Object.values(all)) {
        const j = dm && dm.job;
        if (!j || !j.genTasks) continue;
        for (const k of GEN_KINDS) {
          const t = j.genTasks[k];
          if (t && t.status === 'running') { j.genTasks[k] = { ...t, status: 'error', taskId: null, error: '应用重启中断，可重试' }; genInterrupted++; }
        }
      }
      return genInterrupted ? all : null;   // 无 running → 不写
    });
    if (genInterrupted) console.error(`[gen] 重启恢复：${genInterrupted} 个 AI 任务标记中断（running → error，taskId 置空）`);
  } catch (e) {
    console.error('[tx] 启动恢复异常：', e && e.message || e);
  }
}
tryListen(0);
