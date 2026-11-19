// draft.mjs — 建简历快照账本（UPCV A3 #2；规范 dev-docs/2026-11-19-upcv-port-snapshot-status-design.md §1）
// 契约源：efc docs/upcv-resume-snapshot-implementation.md（四端点形状）+ UPCV §12.4b「引导建简历」。
// 账本 resume-draft.json（对象，键=sessionId）：{drafts:{<sessionId>:{id,sessionId,snapshotData,clientVersion,completedResumeId,createdAt,updatedAt}}}；
//   一会话一行（UPSERT by sessionId，同会话覆盖更新，最后写胜——单人工作台可接受，同 efc 简化口径）。
// 纪律：写入一律走 tx.mjs updateJsonLedger（跨进程锁 + 损坏停写 + 唯一临时原子 rename 0600）；
//   快照只是「现场」不是简历本体；completed 后唯一用途是 latest 判空（latest 只回未完成行）。
import fs from 'node:fs';
import path from 'node:path';
import { updateJsonLedger } from './tx.mjs';

const DRAFT_FILE = 'resume-draft.json';
const SESS_RE = /^[a-z0-9][a-z0-9-]{0,90}$/;   // 会话 id 闸门（与 agent.mjs ID_RE 同口径；completedResumeId=docId 也走它）
const newSnapId = () => 'snap-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
const isObj = (d) => !!d && typeof d === 'object' && !Array.isArray(d);
const shapeOk = (d) => isObj(d) && isObj(d.drafts);   // 根形状校验（shapeOk 口径：形状错=损坏停写）
const INITIAL = { drafts: {} };

const draftPath = (root) => path.join(root, DRAFT_FILE);

// 读整账：缺失 → null（无快照）；损坏/形状错 → 显式抛 CORRUPT（读侧不静默当空表，与全仓账本一致）
function loadDrafts(root) {
  if (!fs.existsSync(draftPath(root))) return null;
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(draftPath(root), 'utf8')); }
  catch { parsed = null; }
  if (!shapeOk(parsed)) {
    const e = new Error(`数据文件损坏，已停止读取：${DRAFT_FILE}。请先人工修复或从备份恢复。`);
    e.httpCode = 500; e.code = 'CORRUPT'; throw e;
  }
  return parsed;
}
const draftRows = (root) => { const t = loadDrafts(root); return t ? Object.values(t.drafts) : []; };
const unfinished = (r) => !!r && r.completedResumeId == null;
// 对外行形状（照 UPCV latest 样本字段；createdAt 不出投影）
const projection = (r) => ({ id: r.id, sessionId: r.sessionId, snapshotData: r.snapshotData, clientVersion: r.clientVersion, completedResumeId: r.completedResumeId, updatedAt: r.updatedAt });

// 最近一条未完成行（UPCV latest 语义：completed 非空的行不返回）；无 → null
export function latestDraft(root) {
  const rows = draftRows(root).filter(unfinished);
  if (!rows.length) return null;
  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return projection(rows[0]);
}

// 该会话的未完成草稿（agent 延续判定用；完成/已删 → null）
export function findDraftBySession(root, sessionId) {
  return draftRows(root).find((r) => unfinished(r) && r.sessionId === sessionId) || null;
}

// 草稿开建时未归档 master 的 id 快照（A3 遗留风险修复：此后「已建出」只认新增文档——
// 排除集内的旧母版即使被编辑（mtime 变新）也不算「建出」，防提前误 complete）。
// docs-meta 读不到/损坏 → 空数组（宁可晚 complete 也不错杀现场；老行缺该字段同此口径）。
function unarchivedMasterIds(root) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    if (!isObj(meta)) return [];
    return Object.keys(meta).filter((id) => isObj(meta[id]) && meta[id].kind === 'master' && !meta[id].archivedAt);
  } catch { return []; }
}

// UPSERT：同会话覆盖更新（id/createdAt/clientVersion/masterIdsAtStart 保留，snapshotData/updatedAt 刷新；行数不变）
export function upsertDraft(root, sessionId, snapshotData) {
  if (!SESS_RE.test(String(sessionId || ''))) { const e = new Error('sessionId 非法（应为会话 id）'); e.httpCode = 400; throw e; }
  if (!isObj(snapshotData)) { const e = new Error('snapshotData 必须是对象'); e.httpCode = 400; throw e; }
  let row = null;
  updateJsonLedger(root, DRAFT_FILE, (t) => {
    const drafts = t.drafts;
    const prev = drafts[sessionId];
    const now = nowIso();
    row = prev
      ? { ...prev, snapshotData, updatedAt: now }
      : { id: newSnapId(), sessionId, snapshotData, clientVersion: 'pc-web', completedResumeId: null, createdAt: now, updatedAt: now, masterIdsAtStart: unarchivedMasterIds(root) };
    drafts[sessionId] = row;
    return t;
  }, { validate: shapeOk, initial: INITIAL });
  return row;
}

// 置完成（completedResumeId=新 docId）：完成后 latest 不再返回该行
export function completeDraft(root, id, completedResumeId) {
  if (!SESS_RE.test(String(completedResumeId || ''))) { const e = new Error('completedResumeId 非法（应为简历文档 id）'); e.httpCode = 400; throw e; }
  let row = null;
  updateJsonLedger(root, DRAFT_FILE, (t) => {
    const found = Object.values(t.drafts).find((r) => r && r.id === String(id || ''));
    if (!found) { const e = new Error('快照不存在'); e.httpCode = 404; throw e; }
    found.completedResumeId = String(completedResumeId);
    found.updatedAt = nowIso();
    row = found;
    return t;
  }, { validate: shapeOk, initial: INITIAL });
  return row;
}

// 删行（按快照行 id；不存在 → 404 抛出，账本不创建）
export function deleteDraft(root, id) {
  updateJsonLedger(root, DRAFT_FILE, (t) => {
    const drafts = t.drafts;
    const key = Object.keys(drafts).find((k) => drafts[k] && drafts[k].id === String(id || ''));
    if (!key) { const e = new Error('快照不存在'); e.httpCode = 404; throw e; }
    delete drafts[key];
    return t;
  }, { validate: shapeOk, initial: INITIAL });
  return true;
}

// ===== A3 agent 接缝：建简历意图 → 草稿快照（agent.mjs chatStream 用户条落盘后调用；UPCV #2）=====
// 判定 = 用户消息含「从零/新建/创建简历」类关键词且尚无进行中草稿，或已有未完成草稿时延续（含本轮继续答模块）。
// 普通会话零写入：无关键词且无草稿 → 直接 return，账本不触碰、文件不创建。
const DRAFT_INTENT_RE = /(从零|从头|重新建|新建|创建|帮我建|做一份|写一份|整一份).{0,8}简历|简历.{0,6}(从零|从头|新建|创建)/;
// 模块收集启发式（对话文本 → collected 键；值=最近一条命中该模块的用户文本，截断现场——快照只是现场不是简历本体）
const DRAFT_MODULES = [
  ['basics', /姓名|名字|我叫|电话|手机|邮箱|联系方式|基本信息/],
  ['education', /教育|学校|学历|大学|学院|专业|毕业/],
  ['projects', /项目|实习|工作经历|任职|就职/],
  ['skills', /技能|技术栈|熟练|掌握|工具|编程语言/],
  ['summary', /自我评价|个人总结|个人简介|自我介绍/],
];

// 草稿创建之后**新建**的未归档 master（/new、导入、复制都登记 kind=master + archivedAt:null；job 草稿与已归档不算）。
// 排除集 = 草稿开建时的 masterIdsAtStart：旧母版被编辑（mtime 变新）不算「建出」（A3 遗留风险修复）。
// docs-meta 读不到/损坏 → null（宁可晚 complete 也不错杀现场）。
function freshMasterDoc(root, sinceIso, excludeIds) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    if (!isObj(meta)) return null;
    const since = sinceIso ? (Date.parse(sinceIso) || 0) : 0;
    const skip = new Set(Array.isArray(excludeIds) ? excludeIds : []);
    let best = null;
    for (const id of Object.keys(meta)) {
      const m = meta[id];
      if (!isObj(m) || m.kind !== 'master' || m.archivedAt) continue;
      if (skip.has(id)) continue;   // 草稿开建前就在的旧母版：编辑不算「建出」
      let st; try { st = fs.statSync(path.join(root, 'docs', id + '.html')); } catch { continue; }
      if (st.mtimeMs <= since) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { id };
    }
    return best;
  } catch { return null; }
}

// hist = chatStream 已拼好的 [{role,content}]（不含本轮 text；本轮单独传）。
export function agentDraftTick(root, sid, text, hist) {
  const existing = findDraftBySession(root, sid);
  if (!existing && !DRAFT_INTENT_RE.test(String(text || ''))) return null;
  // 生成落库衔接：草稿在场且用户已建出真文档（/new、导入、复制）→ 置完成（latest 随之变 null，横幅消失）
  if (existing) {
    const fresh = freshMasterDoc(root, existing.createdAt, existing.masterIdsAtStart);
    if (fresh) return completeDraft(root, existing.id, fresh.id);
  }
  const users = [...(Array.isArray(hist) ? hist : []).filter((m) => m && m.role === 'user' && typeof m.content === 'string'), String(text || '')];
  const collected = {};
  for (const u of users) for (const [k, re] of DRAFT_MODULES) if (re.test(u)) collected[k] = clip(u, 240);
  const lastQ = [...(Array.isArray(hist) ? hist : [])].reverse().find((m) => m && m.role === 'assistant' && typeof m.content === 'string');
  const prev = isObj(existing && existing.snapshotData) ? existing.snapshotData : {};
  return upsertDraft(root, sid, {
    collected,
    lastQuestion: lastQ ? clip(lastQ.content, 200) : '',
    rounds: (typeof prev.rounds === 'number' ? prev.rounds : 0) + 1,
  });
}
