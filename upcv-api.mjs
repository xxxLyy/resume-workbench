// upcv-api.mjs — UPCV 契约投影层（规范 upcv-api.routes.md；上位契约 upcv-features-implementation.md §1/§3）
// 端点：GET/POST /api/resume、GET/PUT/DELETE /api/resume/:id、GET /api/application-records。
// 纪律：
//   - HTML 是唯一真源：不写 sidecar（<id>.rr.json 不落盘）；GET 每次读盘现算投影（docToResumeData），
//     PUT 走 rr-import 转 HTML 后按 /save 同款原语落盘（normalizeZids + normalizeToCurrent + atomicWrite
//     + updateMeta patch：typo/rev/zoneSync/flow 降级），文档锁 withDocLock 同款互斥。
//   - docId 闸门复用 server.mjs 同口径 VALID_ID（/^([a-z0-9][a-z0-9-]*)$/，两处同尺不得漂移）。
//   - 包壳：成功 {code:0,data}；错误 {code:<http状态码>,message:<中文>}（UPCV 风格，与本仓 {ok,error} 并存）。
//   - 读路径只读：applications.json 读侧归一（老枚举→六态，与 server.mjs loadApps 同映射表），绝不写回。
//   - 零网络、零 npm 依赖；本模块纯函数+注入 root，路由层只管解析与 sendJson。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docToResumeData } from './rr-export.mjs';
import { resumeDataToDoc } from './rr-import.mjs';
import { validateResumeData } from './rr-schema.mjs';
import { normalizeZids, zoneSync } from './zone.mjs';
import { normalizeToCurrent } from './freeze.mjs';
import { atomicWrite, updateMeta, updateMetaAll, withDocLock, LockHeld } from './tx.mjs';
import { themeRegistration } from './template.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
// 与 server.mjs/ai-helper.mjs 同口径：RESUME_ROOT 优先，缺省=脚本目录；ctx.root 可显式覆盖（测试隔离）。
const defaultRoot = () => process.env.RESUME_ROOT || APP_ROOT;

// docId 闸门：与 server.mjs VALID_ID 逐字节同口径（外部输入绝不直接拼路径）
const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

const err = (status, message) => Object.assign(new Error(message), { httpCode: status });
const ok = (data) => ({ code: 0, data });

const docPath = (root, id) => path.join(root, 'docs', id + '.html');
const docIdsOnDisk = (root) => {
  let files = [];
  try { files = fs.readdirSync(path.join(root, 'docs')); } catch { return []; }
  return files.filter((f) => f.endsWith('.html') && !f.startsWith('.'))
    .map((f) => f.slice(0, -5)).filter((id) => VALID_ID.test(id))
    .filter((id) => { try { return fs.statSync(docPath(root, id)).isFile(); } catch { return false; } });
};

// docs-meta.json 只读（写一律走 updateMeta/updateMetaAll——它们是唯一写入者）
function loadMeta(root) {
  const fp = path.join(root, 'docs-meta.json');
  if (!fs.existsSync(fp)) return {};
  try {
    const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch { return {}; }
}

// ===== 投递六态（与 server.mjs APP_STATUS_*/appStatus 同口径；读侧归一不写回）=====
const APP_STATUSES = ['to_apply', 'preparing', 'applied', 'replied', 'interviewing', 'offer'];
const APP_STATUS_ALL = [...APP_STATUSES, 'closed'];
const APP_STATUS_LEGACY = { '已投递': 'applied', '笔试': 'replied', '面试中': 'interviewing', 'offer': 'offer', '已拒': 'closed', '搁置': 'closed' };
const appStatus = (s) => (APP_STATUS_ALL.includes(s) ? s : (APP_STATUS_LEGACY[s] || 'applied'));

// ===== GET /api/resume —— 列表投影 =====
// 每文档 {id,title,updatedAt,theme,kind}；title 取 <h1>（JSON 通道不 escHtml，与 /ai-helper/docs 同口径）。
export function listResumes({ root = defaultRoot() } = {}) {
  const meta = loadMeta(root);
  const items = [];
  for (const id of docIdsOnDisk(root)) {
    let title = id;
    try { title = (fs.readFileSync(docPath(root, id), 'utf8').match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || id; } catch {}
    const st = fs.statSync(docPath(root, id));
    const m = meta[id] || {};
    items.push({
      id, title,
      updatedAt: st.mtime.toISOString(),
      theme: String(m.theme || 'classic'),
      kind: (m.kind === 'job' || (!m.kind && m.job)) ? 'job' : 'master',   // kindOf 同口径
    });
  }
  items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return ok(items);   // UPCV：列表 data 直接是数组（空账号 → []）
}

// ===== GET /api/resume/:id —— 单份投影（每次现算，不写 sidecar）=====
export function getResume({ root = defaultRoot(), id } = {}) {
  const did = assertDocId(root, id);
  const html = fs.readFileSync(docPath(root, did), 'utf8');
  const m = loadMeta(root)[did] || {};
  return ok(docToResumeData(html, { docId: did, theme: m.theme, typo: m.typo }));
}

function assertDocId(root, id) {
  const did = String(id || '');
  if (!VALID_ID.test(did)) throw err(400, '非法文档 id');
  if (!fs.existsSync(docPath(root, did))) throw err(404, '文档不存在');
  return did;
}

// 请求体解包：接受裸 resumeData，也接受 {data:{…}}/{resumeData:{…}} 包裹形（宽容入口，校验器把关）
function unwrapResumeData(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw err(400, '请求体应为 resumeData 对象');
  const d = (body.resumeData && typeof body.resumeData === 'object') ? body.resumeData
    : (body.data && typeof body.data === 'object' && (body.data.basics || body.data.sections)) ? body.data
    : body;
  return d;
}

// —— flow 降级：与 server.mjs /save 的 updateMeta 同语义（改稿使 reviewed 失效 → draft）——
function flowOf(m) {
  const mm = m || {};
  if (['draft', 'reviewing', 'reviewed'].includes(mm.flow)) return mm.flow;
  const j = mm.job;
  if (j) {
    if (j.status === 'deliverable' || j.status === 'delivered') return 'reviewed';
    if (j.status === 'draft' && Array.isArray(j.changes) && j.changes.some((c) => c && c.status === 'pending')) return 'reviewing';
  }
  return 'draft';
}
const FLOW_REVIEWED = 'reviewed';

// ===== PUT /api/resume/:id —— resumeData → HTML 落盘 =====
// 写路径复刻 /save 的核心原语（文档锁/zid 归一/typo 剥离/meta patch），但不打快照、不建事务记录、
// 不做 baseMtime 冲突检查——契约差异见 upcv-api.routes.md §3。文档锁竞争 → 409（与 /save LockHeld 同语义）。
export function putResume({ root = defaultRoot(), id, resumeData } = {}) {
  const did = assertDocId(root, id);
  const data = unwrapResumeData(resumeData);
  const v = validateResumeData(data);
  if (!v.ok) throw err(400, `resumeData 校验未通过：${v.errors[0]}`);
  let html = resumeDataToDoc(data, did);            // 转换失败（形状错/模板漂移）→ err 原样上抛
  html = normalizeZids(html);                        // /save 同款：落盘前打点归一
  const norm = normalizeToCurrent(html);             // typo 剥离（本产物无内联 typo，口径保持一致）
  const cssValue = data.metadata && data.metadata.css && typeof data.metadata.css.value === 'string'
    ? data.metadata.css.value : null;
  const doWrite = () => {
    atomicWrite(docPath(root, did), norm.html);
    const st = fs.statSync(docPath(root, did));
    updateMeta(root, did, (m) => {
      const base = { ...(m || {}) };
      base.typo = cssValue !== null ? cssValue : norm.typo;   // v4 css.value ↔ meta.typo（降级⑦）
      base.rev = (Number(base.rev) || 0) + 1;
      if (flowOf(base) === FLOW_REVIEWED) {                    // 改稿使「可投递」失效（同 /save 口径）
        base.flow = 'draft';
        if (base.job) base.job = { ...base.job, invalidatedAt: new Date().toISOString() };
      }
      Object.assign(base, zoneSync(norm.html, base));          // S3 zones 同步（正文为准）
      return base;
    });
    return { id: did, updatedAt: st.mtime.toISOString() };
  };
  try {
    return ok(withDocLock(root, did, doWrite));
  } catch (e) {
    if (e instanceof LockHeld) throw err(409, '文档正在被另一保存/回滚处理，请稍后重试');
    throw e;
  }
}

// ===== POST /api/resume —— resumeData → 新建文档 =====
// id 分配：basics.name 拉丁化 slug（过不了 VALID_ID → 'doc'）+ 序号碰撞回避（/new 同款 do-while）。
// meta 登记与 /new 同款：themeRegistration('classic') + kind/flow/archivedAt；typo 取 css.value。
export function postResume({ root = defaultRoot(), resumeData } = {}) {
  const data = unwrapResumeData(resumeData);
  const v = validateResumeData(data);
  if (!v.ok) throw err(400, `resumeData 校验未通过：${v.errors[0]}`);
  const name = (data.basics && typeof data.basics.name === 'string' && data.basics.name.trim()) || '';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'doc';
  let i = 0, newId;
  do { newId = i === 0 ? slug : `${slug}-${i}`; i++; } while (fs.existsSync(docPath(root, newId)) || fs.existsSync(docPath(root, newId) + '.tmp'));
  let html = resumeDataToDoc(data, newId);
  html = normalizeZids(html);
  const norm = normalizeToCurrent(html);
  const cssValue = data.metadata && data.metadata.css && typeof data.metadata.css.value === 'string'
    ? data.metadata.css.value : '';
  atomicWrite(docPath(root, newId), norm.html);
  updateMeta(root, newId, (m) => ({
    ...(m || {}), ...themeRegistration('classic'),
    kind: 'master', flow: 'draft', archivedAt: null,
    typo: cssValue, rev: 1,
    ...zoneSync(norm.html, m || {}),
  }));
  return ok({ id: newId });
}

// ===== DELETE /api/resume/:id =====
// 与 /delete 同口径：正文 + PDF + 渲染旁车 + meta 条目（快照保留；applications.json 不动）。
// 「至少保留一份文档」护栏沿用首页删除口径（API 侧同一产品约束，防误删唯一简历）。
export function deleteResume({ root = defaultRoot(), id } = {}) {
  const did = assertDocId(root, id);
  if (docIdsOnDisk(root).length <= 1) throw err(400, '至少保留一份文档');
  fs.unlinkSync(docPath(root, did));
  const pdf = path.join(root, 'pdfs', did + '.pdf');
  try { fs.unlinkSync(pdf); } catch {}
  try { fs.unlinkSync(pdf + '.env.json'); } catch {}
  updateMetaAll(root, (all) => { if (!(did in all)) return all; const next = { ...all }; delete next[did]; return next; });
  return ok({ id: did });
}

// ===== GET /api/application-records —— 六态看板的 UPCV 投影 =====
// data = {items:[{id,company,role,status,dueDate,updatedAt}], page, limit, hasMore, summary?}
// summary 参数存在 → 附每态计数 + dueTodayCount（UPCV 形状超集：补 repliedCount/closedCount）。
// status 查询参数支持逗号分隔过滤（如 ?status=to_apply,applied），非法值忽略。
export function applicationRecords({ root = defaultRoot(), query } = {}) {
  const fp = path.join(root, 'applications.json');
  let apps = [];
  if (fs.existsSync(fp)) {
    let parsed = null;
    try { parsed = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { throw err(500, 'applications.json 解析失败（数据文件可能损坏，请先人工修复）'); }
    if (!Array.isArray(parsed)) throw err(500, 'applications.json 形状错误（应为数组），已拒绝读取');
    apps = parsed;
  }
  const q = query || {};
  const statusFilter = typeof q.status === 'string' && q.status
    ? new Set(q.status.split(',').map((s) => s.trim()).filter((s) => APP_STATUS_ALL.includes(s)))
    : null;
  const normalized = apps
    .filter((a) => a && typeof a === 'object')
    .map((a) => ({
      id: String(a.id || ''), company: String(a.company || ''), role: String(a.role || ''),
      status: appStatus(a.status), dueDate: String(a.dueDate || ''), updatedAt: String(a.updatedAt || ''),
    }))
    .filter((a) => !statusFilter || statusFilter.has(a.status));
  normalized.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const limit = Math.max(1, Math.min(200, parseInt(q.limit, 10) || 30));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const start = (page - 1) * limit;
  const items = normalized.slice(start, start + limit);
  const data = { items, page, limit, hasMore: start + items.length < normalized.length };

  if ('summary' in q) {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    data.summary = {
      toApplyCount: 0, preparingCount: 0, appliedCount: 0, repliedCount: 0,
      interviewingCount: 0, offerCount: 0, closedCount: 0, dueTodayCount: 0,
    };
    for (const a of normalized) {
      const k = a.status === 'to_apply' ? 'toApplyCount' : a.status + 'Count';
      if (k in data.summary) data.summary[k]++;
      if (a.dueDate === todayStr) data.summary.dueTodayCount++;
    }
  }
  return ok(data);
}

// ===== 路由匹配（server.mjs 注册块用；见 upcv-api.routes.md §2）=====
// 命中 → {op,id?}；未命中 → null（server 继续既有路由）。
export function matchUpcv(method, pathname) {
  if (method === 'GET' && pathname === '/api/resume') return { op: 'resume.list' };
  if (method === 'POST' && pathname === '/api/resume') return { op: 'resume.create' };
  const m = /^\/api\/resume\/([^/]+)$/.exec(pathname);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === 'GET') return { op: 'resume.get', id };
    if (method === 'PUT') return { op: 'resume.put', id };
    if (method === 'DELETE') return { op: 'resume.delete', id };
  }
  if (method === 'GET' && pathname === '/api/application-records') return { op: 'records.list' };
  return null;
}

// ===== 统一派发：返回 {status, body}（body 已带 {code,…} 包壳）；路由未命中 → null =====
// ctx = {method, pathname, root, body(已解析), query(URLSearchParams)}
export function dispatchUpcv(ctx) {
  const hit = matchUpcv(ctx.method, ctx.pathname);
  if (!hit) return null;
  const query = ctx.query || {};
  const q = {};
  if (query && typeof query.forEach === 'function') query.forEach((v, k) => { q[k] = v; });
  try {
    let r;
    switch (hit.op) {
      case 'resume.list': r = listResumes({ root: ctx.root }); break;
      case 'resume.get': r = getResume({ root: ctx.root, id: hit.id }); break;
      case 'resume.put': r = putResume({ root: ctx.root, id: hit.id, resumeData: ctx.body }); break;
      case 'resume.create': r = postResume({ root: ctx.root, resumeData: ctx.body }); break;
      case 'resume.delete': r = deleteResume({ root: ctx.root, id: hit.id }); break;
      case 'records.list': r = applicationRecords({ root: ctx.root, query: q }); break;
      default: return null;
    }
    return { status: 200, body: r };
  } catch (e) {
    const status = (e && e.httpCode) || 500;
    const message = status === 500 ? `服务器内部错误：${String((e && e.message) || e).slice(0, 200)}` : String(e.message || e);
    return { status, body: { code: status, message } };
  }
}
