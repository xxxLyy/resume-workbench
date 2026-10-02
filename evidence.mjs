// evidence.mjs — 岗位适配数据层纯函数（S4a 设计 §4/§5.3：证据表 / 来源有效性 / 三时态失效 / 候选应用校验 / 导出检查）
// 纪律：零网络零落盘；模型输出只经解析校正入库，判定以程序侧指纹与 ID 为准（title/quote 仅展示）。
import { createHash } from 'node:crypto';
import { parasOf } from './zone.mjs';
import { DATE_TOKEN_RE, pageSuggestions } from './job.mjs';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// ===== 内容指纹 =====
// mat：facts 序列化指纹（只认非空字符串键 + 稳定键序 → 键序无关、空键不扰动）；
// para：段落文本指纹（空白归一，与 parasOf 的文本口径一致）。
export function contentFingerprint(facts) {
  const f = (facts && typeof facts === 'object') ? facts : {};
  const keys = Object.keys(f).filter((k) => typeof f[k] === 'string' && f[k] !== '').sort();
  return sha1(keys.map((k) => k + ':' + f[k]).join('\n'));
}

export function paraFingerprint(text) {
  return sha1(String(text ?? '').replace(/\s+/g, ' ').trim());
}

// ===== 证据表解析（设计 §5.1：ID 精确匹配 + refId 请求前分配 + 五态校正）=====
// raw = 模型输出 {"evidence":[{req,status,refHints:[{type,id|zid,title?,quote?}]}]}；ctx = { gen, mats, paras }。
// 匹配只认请求内 ID：matId 必须在已确认素材集（factStatus==='confirmed'）、zid 必须在正文段落——
// 两份同名素材/两段相同正文无歧义；title/quote 原样保留仅作展示，不参与匹配。ID 不在集合 → 该 ref 丢弃。
// refId 由本函数按 b<批次>r<序号> 分配（gen = 证据生成次数，调用方传 evidenceGen+1），全局唯一、跨批次不复用。
const stripFence = (raw) => String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

// 五态校正（v1.3 反例5 / v1.4 validity-coverage 分离）：ref 实际形态与模型输出矛盾时以 ref 形态为准——
// para 存在 = 简历已表达（充分性机判 covered/thin）；仅有效 mat = sourced（有据未表达，绝不显示"已覆盖"）；
// 无任何有效 ref = todo（模型明示 none 保留原词——「已确认来源中未找到证据」口径）。
function resolveStatus(modelStatus, hasPara, hasMat) {
  if (hasPara) return modelStatus === 'thin' ? 'thin' : 'covered';
  if (hasMat) return 'sourced';
  return modelStatus === 'none' ? 'none' : 'todo';
}

export function parseEvidence(raw, ctx = {}) {
  let d;
  try { d = JSON.parse(stripFence(raw)); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const confirmed = new Map((ctx.mats || []).filter((m) => m && m.factStatus === 'confirmed' && typeof m.id === 'string').map((m) => [m.id, m]));
  const byZid = new Map((ctx.paras || []).filter((p) => p && p.zid).map((p) => [p.zid, p]));
  const gen = Number(ctx.gen) || 1;
  let n = 0, i = 0;
  const out = [];
  for (const e of Array.isArray(d.evidence) ? d.evidence : []) {
    if (!e || typeof e.req !== 'string' || !e.req.trim()) continue;
    i++;
    const refs = [];
    let hasPara = false, hasMat = false;
    for (const h of Array.isArray(e.refHints) ? e.refHints : []) {
      if (!h || typeof h !== 'object') continue;
      const display = { title: typeof h.title === 'string' ? h.title : '', quote: typeof h.quote === 'string' ? h.quote : '' };
      if (h.type === 'mat' && typeof h.id === 'string' && confirmed.has(h.id)) {
        const m = confirmed.get(h.id);
        // srcStatus：引用建立时来源素材 factStatus 快照（仅 mat 型）
        refs.push({ refId: `b${gen}r${++n}`, type: 'mat', id: h.id, zid: null, srcStatus: 'confirmed', hash: contentFingerprint(m.facts), ...display });
        hasMat = true;
      } else if (h.type === 'para' && typeof h.zid === 'string' && byZid.has(h.zid)) {
        const p = byZid.get(h.zid);
        refs.push({ refId: `b${gen}r${++n}`, type: 'para', id: null, zid: h.zid, hash: paraFingerprint(p.text), ...display });
        hasPara = true;
      }
      // ID 不在输入集合 / 未确认素材 → 该 ref 丢弃（不建 refId），状态由 resolveStatus 降级
    }
    out.push({ id: 'e' + i, req: e.req.trim(), status: resolveStatus(e.status, hasPara, hasMat), refs, note: '', noteConfirmed: false });
  }
  return out;
}

// ===== 来源有效性（v1.4：validity 与 coverage 分离；ref-stale 判定的唯一输入）=====
// mat：内容指纹匹配 且 该素材当前 factStatus==='confirmed'（取消事实确认即使 hash 未变也失效）；
// para：zid 段落文本指纹匹配（段落删除即失效）。
export function refFresh(ref, ctx = {}) {
  if (!ref || typeof ref !== 'object') return false;
  if (ref.type === 'mat') {
    const m = (ctx.mats || []).find((x) => x && x.id === ref.id);
    return !!m && m.factStatus === 'confirmed' && contentFingerprint(m.facts) === ref.hash;
  }
  if (ref.type === 'para') {
    const p = (ctx.paras || []).find((x) => x && x.zid === ref.zid);
    return !!p && paraFingerprint(p.text) === ref.hash;
  }
  return false;
}

// ===== 候选状态判定（设计 §4.2：三时态，多命中集合，[] = ok）=====
// ctx = { paras:[{zid,text}], gen, evidence:[{refs}], mats, locked:Set }。
// 输出按优先级表排序（主标签 = 第一个命中）：anchor-gone / batch-stale / ref-stale / locked-now / needs-compare / hand-edited。
const STATE_ORDER = ['anchor-gone', 'batch-stale', 'ref-stale', 'locked-now', 'needs-compare', 'hand-edited'];
// 与 parasOf 同口径的空白归一：appliedText/baseSnapshot 等快照可能含原始换行，比较前先归一（避免假 hand-edited）
const normText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

export function candidatesState(change, ctx = {}) {
  const c = change || {};
  const hits = new Set();
  const cur = (ctx.paras || []).find((p) => p && p.zid === c.zid);
  // anchor-gone：replace/hide/reorder 落点消失；add = 插入容器消失（新段落 zid 尚不存在不构成失效）
  if (!cur) hits.add('anchor-gone');
  // 来源维度（读取时即时计算，不依赖正文保存）：批次隔离 + 指纹/factStatus
  const evMap = new Map();
  for (const e of ctx.evidence || []) for (const r of (e && e.refs) || []) evMap.set(r.refId, r);
  const gen = Number(ctx.gen) || 0;
  const refIds = Array.isArray(c.evidenceRefs) ? c.evidenceRefs : [];
  let refBad = false;
  for (const rid of refIds) {
    const ref = evMap.get(rid);
    const bm = /^b(\d+)r\d+$/.exec(String(rid));
    if (!ref || (bm && Number(bm[1]) !== gen)) { refBad = true; hits.add('batch-stale'); continue; }
    if (!refFresh(ref, ctx)) { refBad = true; hits.add('ref-stale'); }
  }
  const pending = c.status === 'pending';
  if (pending && ctx.locked instanceof Set && ctx.locked.has(c.zid)) hits.add('locked-now');
  if (pending) {
    // needs-compare（v1.4 锚点化）：只看候选自身锚点文本 vs baseSnapshot，或 evidenceRefs 依赖失效；整文哈希不参与
    if (typeof c.baseSnapshot === 'string' && cur && cur.text !== normText(c.baseSnapshot)) hits.add('needs-compare');
    if (refBad && refIds.length) hits.add('needs-compare');
  }
  // add 的落点是新段落（newZid），容器文本与本候选无关——hand-edited / resolvedText 都按 tracked 比较
  const tracked = (c.kind === 'add' && c.newZid)
    ? (ctx.paras || []).find((p) => p && p.zid === c.newZid)
    : cur;
  // hand-edited：accepted 后手改。resolve 后由 resolvedText 分支接管检测（设计 §4.2 状态机：resolve → []，再变才回待核对）
  if (c.acceptedAt && !c.resolvedAt && tracked && typeof c.appliedText === 'string' && tracked.text !== normText(c.appliedText)) hits.add('hand-edited');
  // 「保留当前版本」（v1.4）：resolvedText/resolvedRefs 绑定确认时内容，之后再变 → 重新进待核对（resolvedAt 保留）
  if (c.resolvedAt) {
    if (typeof c.resolvedText === 'string' && tracked && tracked.text !== normText(c.resolvedText)) hits.add('needs-compare');
    if (c.resolvedRefs && typeof c.resolvedRefs === 'object') {
      for (const [rid, hash] of Object.entries(c.resolvedRefs)) {
        const ref = evMap.get(rid);
        if (!ref || ref.hash !== hash || !refFresh(ref, ctx)) { hits.add('needs-compare'); break; }
      }
    }
  }
  return STATE_ORDER.filter((s) => hits.has(s));
}

// ===== 正文维度一致性刷新（设计 §4.2：/save 时 zoneSync 之后同一 updateMeta 事务内调用）=====
// 逐条跑 candidatesState 写 change.consistency（UI 只读不判）；来源维度不落盘、读取时即时算。
// opts = { zones: meta.zones（locked 派生）, mats }。纯函数：返回新 job，不改入参。
export function reviewConsistency(job, html, opts = {}) {
  const zones = opts.zones || {};
  const locked = new Set(Object.entries(zones).filter(([, z]) => z && z.locked === true).map(([zid]) => zid));
  const ctx = {
    paras: parasOf(String(html ?? '')),
    gen: Number(job && job.evidenceGen) || 0,
    evidence: (job && job.evidence) || [],
    mats: opts.mats || [],
    locked
  };
  return {
    ...(job || {}),
    changes: ((job && job.changes) || []).map((c) => ({ ...c, consistency: candidatesState(c, ctx) }))
  };
}

// ===== 候选处理状态机（v1.5：撤回统一 pending+清快照；resolved 绑定内容与来源版本）=====
const TRANSITIONS = {
  accept: { from: ['pending'], to: 'accepted' },
  revert: { from: ['accepted'], to: 'pending' },
  reject: { from: ['pending'], to: 'rejected' },
  unreject: { from: ['rejected'], to: 'pending' },
  skip: { from: ['pending'], to: 'skipped' },
  unskip: { from: ['skipped'], to: 'pending' },
  resolve: { from: ['pending', 'accepted'], to: 'resolved' }
};

// ctx（resolve 用）= { now, text: 确认时段落当前文本, refs: { refId: 指纹 } 快照 }。非法转换返回 null。
export function transitionOp(change, action, ctx = {}) {
  const t = TRANSITIONS[action];
  if (!t || !change || typeof change !== 'object' || !t.from.includes(change.status)) return null;
  const c = { ...change };
  if (action === 'revert') {
    // 撤回存储状态统一：清 origText/appliedText/acceptedAt/newZid（不留旧快照误导后续判定）
    delete c.origText; delete c.appliedText; delete c.acceptedAt; delete c.newZid;
  }
  if (action === 'resolve') {
    if (typeof ctx.text === 'string') c.resolvedText = ctx.text;
    if (ctx.refs && typeof ctx.refs === 'object') c.resolvedRefs = { ...ctx.refs };
    c.resolvedAt = ctx.now || new Date().toISOString();
  }
  c.status = t.to;
  return c;
}

// ===== 操作应用与校验（设计 §4.2 v1.6：保存协议 ④，任一失败整份拒绝）=====
// ops = [{ operationId, changeId, action:'accept'|'revert', origText, newZid?(add 接受) }]；
// 校验对「服务器当前正文」（调用方传磁盘旧 html，锁内无并发窗口）：origText 锚点匹配是并发编辑防线。
// 应用 = 候选状态转移与快照落账（正文由客户端在 html 内先行应用，本函数不改正文）。纯函数：失败零变更。
export function applyOps(ops, job, html, opts = {}) {
  const changes = (job && Array.isArray(job.changes)) ? job.changes : [];
  const byZid = new Map(parasOf(String(html ?? '')).map((p) => [p.zid, p]));
  const locked = opts.locked instanceof Set ? opts.locked : new Set();
  const now = opts.now || new Date().toISOString();
  const next = changes.map((c) => ({ ...c }));
  const applied = [];
  const seen = new Set();
  for (let i = 0; i < (Array.isArray(ops) ? ops.length : 0); i++) {
    const op = ops[i];
    const bad = (reason) => ({ ok: false, badOp: (op && typeof op.operationId === 'string') ? op.operationId : ('#' + i), reason });
    if (!op || typeof op !== 'object') return bad('操作不是对象');
    if (typeof op.operationId !== 'string' || !op.operationId.trim() || op.operationId.length > 128) return bad('operationId 非法');
    if (seen.has(op.operationId)) return bad('同请求内 operationId 重复：' + op.operationId);
    seen.add(op.operationId);
    if (typeof op.changeId !== 'string' || !op.changeId) return bad('changeId 缺失');
    if (op.action !== 'accept' && op.action !== 'revert') return bad('action 非法：' + String(op.action));
    const idx = next.findIndex((c) => c.id === op.changeId);
    if (idx < 0) return bad('changeId 不存在：' + op.changeId);
    const c = next[idx];
    // 锚点：accept 时 add 用容器 zid（新段落尚不存在）；revert 时 add 用 newZid（已存在）
    const anchorZid = (op.action === 'revert' && c.kind === 'add' && c.newZid) ? c.newZid : c.zid;
    const anchor = anchorZid ? byZid.get(anchorZid) : undefined;
    if (op.action === 'accept') {
      if (c.status !== 'pending') return bad('前置不满足：候选不在 pending（当前 ' + (c.status || '未知') + '）');
      if (!anchor) return bad('前置不满足：落点不存在（anchor-gone）');
      if (locked.has(anchorZid)) return bad('前置不满足：该段已锁定（locked-now）');
      // origText 与锚点比较走 parasOf 同口径空白归一（客户端快照可能含原始换行；与 candidatesState 口径一致）
      if (typeof op.origText !== 'string' || anchor.text !== normText(op.origText)) return bad('origText 与当前正文锚点不匹配（正文已被并发修改，请刷新后重试）');
      if (c.kind === 'add' && (typeof op.newZid !== 'string' || !op.newZid.trim())) return bad('add 接受必须携带 newZid（客户端已插入的新段落 ID）');
      // appliedText = 接受后锚点文本：replace/add 记 after；hide/reorder 文本不变 → 记 origText
      // （否则 hand-edited 判定对空 after 永真命中，整体完成被永久卡死）
      const acc = { ...c, status: 'accepted', origText: op.origText, appliedText: (c.kind === 'hide' || c.kind === 'reorder') ? op.origText : (typeof c.after === 'string' ? c.after : ''), acceptedAt: now };
      if (c.kind === 'add') acc.newZid = op.newZid;
      next[idx] = acc;
    } else {
      if (c.status !== 'accepted') return bad('前置不满足：候选不在 accepted（当前 ' + (c.status || '未知') + '）');
      if (!anchor) return bad('前置不满足：撤回目标不存在');
      if (typeof op.origText !== 'string' || anchor.text !== normText(op.origText)) return bad('origText 与当前正文锚点不匹配（撤回会覆盖你的调整；经确认门后携带当前文本重试）');
      const rc = transitionOp(c, 'revert');
      next[idx] = rc;
    }
    applied.push({ operationId: op.operationId, changeId: op.changeId, action: op.action });
  }
  return { ok: true, job: { ...(job || {}), changes: next }, applied };
}

// ===== 事实护栏 guardOps（设计 §4.3：①范围全操作 ②锁定 ③hide 展开∩保留/锁定 ④受保护字段强制 conflict）=====
// ops = 生成候选（replace/add/hide/reorder，带 zid；reorder 另带 toZid）；ctx = {
//   scope: null|'zone:<key>', zones: {zid:{zone}}, locked:Set, keepZids:Set（必须保留条目/段落，已按名称解析）,
//   expand: (zid)=>[条目 zid 集合]（hide 目标展开；缺省恒等）, protectedTokens: [公司/职位精确串] }。
export function guardOps(ops, ctx = {}) {
  const zones = ctx.zones || {};
  const zoneOf = (zid) => (zid && zones[zid] ? zones[zid].zone : null);
  const locked = ctx.locked instanceof Set ? ctx.locked : new Set(ctx.locked || []);
  const keep = ctx.keepZids instanceof Set ? ctx.keepZids : new Set(ctx.keepZids || []);
  const expand = typeof ctx.expand === 'function' ? ctx.expand : (zid) => [zid];
  const tokens = (ctx.protectedTokens || []).filter((t) => typeof t === 'string' && t);
  const scopeZone = (typeof ctx.scope === 'string' && ctx.scope.startsWith('zone:')) ? ctx.scope.slice(5) : null;
  const kept = [], dropped = [];
  const drop = (op, rule, reason) => dropped.push({ op, rule, reason });
  for (const op of Array.isArray(ops) ? ops : []) {
    if (!op || typeof op !== 'object') { drop(op, 'shape', '候选不是对象'); continue; }
    // ① 范围（v1.2 全操作）：锚点（与 reorder 终点）区域归属；scope 未设（全文生成）不拒
    const anchors = [op.zid];
    if (op.kind === 'reorder' && op.toZid) anchors.push(op.toZid);
    if (scopeZone && anchors.some((z) => zoneOf(z) !== scopeZone)) {
      drop(op, 'scope', `候选不在目标区域 ${scopeZone} 内（越界拒绝）`);
      continue;
    }
    if (op.kind === 'hide') {
      // ②+③ hide 目标（章节或条目）展开为条目集合，与必须保留条目及集合内任一 locked 段落求交集
      const entryZids = expand(op.zid).filter((z) => typeof z === 'string');
      const hitKeep = entryZids.filter((z) => keep.has(z));
      const hitLocked = entryZids.filter((z) => locked.has(z));
      if (hitKeep.length || hitLocked.length) {
        drop(op, 'keep', 'hide 目标包含必须保留/已锁定内容：' + [...new Set([...hitKeep, ...hitLocked])].join('、'));
        continue;
      }
    } else if (anchors.some((z) => locked.has(z))) {
      drop(op, 'locked', '目标段落已锁定：' + anchors.filter((z) => locked.has(z)).join('、'));
      continue;
    }
    // ④ 受保护字段：before 中命中的日期 token 与公司/职位 token 必须在 after 原值保留 → 违反强制 conflict（不拒收）
    const g = { ...op };
    if (g.kind === 'replace' && typeof g.before === 'string' && typeof g.after === 'string') {
      const norm = (s) => String(s).replace(/\s+/g, '');
      const lostDates = [...new Set(g.before.match(DATE_TOKEN_RE) || [])].filter((d) => !norm(g.after).includes(norm(d)));
      const lostTok = tokens.filter((t) => g.before.includes(t) && !g.after.includes(t));
      if (lostDates.length || lostTok.length) {
        g.level = 'conflict';
        g.reason = (g.reason ? g.reason + '；' : '') + '⚠️ 修改了受保护字段（必须原值保留）：' + [...lostDates, ...lostTok].join('、');
      }
    }
    kept.push(g);
  }
  return { kept, dropped };
}

// ===== 导出检查（设计 §5.3：三级分类 + 两级完成的整体完成判定）=====
// ctx = { mats, paras?, lines?, projects? }——style 走 job.mjs pageSuggestions（数据级，渲染级排版诊断在导出页另算）。
export function exportChecks(job, ctx = {}) {
  const changes = (job && Array.isArray(job.changes)) ? job.changes : [];
  // 阻断：pending 与 skipped 的 conflict 都算未解决（skipped 仅表稍后处理，不解冲突）
  const blocking = changes.filter((c) => c && c.level === 'conflict' && (c.status === 'pending' || c.status === 'skipped'));
  const evidence = (job && Array.isArray(job.evidence)) ? job.evidence : [];
  const evCtx = { mats: ctx.mats || [], paras: ctx.paras || [] };
  const thin = evidence.filter((e) => e && e.status === 'thin');
  const stale = evidence.filter((e) => e && Array.isArray(e.refs) && e.refs.length > 0 && e.refs.every((r) => !refFresh(r, evCtx)));
  // 待核对集合：consistency 命中且非历史态（rejected/superseded 豁免，不阻塞完成）
  const toVerify = changes.filter((c) => c && !['rejected', 'superseded'].includes(c.status)
    && Array.isArray(c.consistency) && c.consistency.length > 0);
  const style = pageSuggestions(ctx.lines || [], { projects: ctx.projects || 0 });
  const open = changes.filter((c) => c && (c.status === 'pending' || c.status === 'skipped')).length;
  return {
    blocking,
    check: { thin, stale, toVerify },
    style,
    canExport: blocking.length === 0,
    reviewComplete: open === 0 && blocking.length === 0 && toVerify.length === 0   // 整体完成（job 级）：无 pending 且无 skipped + 冲突清零 + 待核对空
  };
}
