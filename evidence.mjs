// evidence.mjs — 岗位适配数据层纯函数（S4a 设计 §4/§5.3：证据表 / 来源有效性 / 三时态失效 / 候选应用校验 / 导出检查）
// 纪律：零网络零落盘；模型输出只经解析校正入库，判定以程序侧指纹与 ID 为准（title/quote 仅展示）。
import { createHash } from 'node:crypto';
import { parasOf, ZONE_LABELS } from './zone.mjs';
import { DATE_TOKEN_RE, pageSuggestions, FACT_LABELS, factGuard } from './job.mjs';

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
const stripFence = (raw) => String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

// 五态校正（v1.3 反例5 / v1.4 validity-coverage 分离）：ref 实际形态与模型输出矛盾时以 ref 形态为准——
// para 存在 = 简历已表达（充分性机判 covered/thin）；仅有效 mat = sourced（有据未表达，绝不显示"已覆盖"）；
// 无任何有效 ref = todo（模型明示 none 保留原词——「已确认来源中未找到证据」口径）。
function resolveStatus(modelStatus, hasPara, hasMat) {
  if (hasPara) return modelStatus === 'thin' ? 'thin' : 'covered';
  if (hasMat) return 'sourced';
  return modelStatus === 'none' ? 'none' : 'todo';
}

// ===== 证据生成 prompt（设计 §5.1：输入侧携带请求内 ID，模型 refHints 只认 ID 原样返回）=====
// materials = 已确认素材（带 id/facts/brief/technical）；zones = meta.zones（zid→{zone}）；paras = parasOf 正文段落。
// 素材块每条带 id、正文段落每条带 zid——匹配只认这些 ID；title/quote 仅作人类可读展示，不参与匹配。
export function buildEvidencePrompt({ jd = '', company = '', role = '', materials = [], zones = {}, paras = [] }) {
  const sys = `你是岗位证据分析器（证据分析）。基于【目标 JD】、【已确认素材】与【简历正文段落】，产出「岗位要求—经历证据对应表」。你只能输出 JSON，不能输出 HTML、脚本或解释文字。

输出格式（严格 JSON）：
{"evidence":[{"req":"从 JD 提取的一条要求","status":"covered|sourced|thin|todo|none","refHints":[{"type":"mat","id":"<素材 id 原样返回>","title":"素材标题（仅展示）","quote":"支撑引文（仅展示）"},{"type":"para","zid":"<段落 zid 原样返回>","title":"所在区域（仅展示）","quote":"段落摘录（仅展示）"}]}]}

硬约束（违反即遭拒）：
1. refHints 只能引用输入给出的 ID：素材引用其 id、正文段落引用其 zid，原样返回，不得编造、改写或猜测；title/quote 仅供人阅读，与 ID 不一致时以 ID 为准。
2. status 口径：covered=简历正文已有段落表达该要求（引 para）；sourced=仅已确认素材有据、正文未表达（引 mat）；thin=正文已表达但不充分（引 para）；todo=有来源但证据不足或尚未利用；none=已确认素材与正文中均未找到证据（refHints 留空）。
3. 无证据不得编造：没有可引用的 ID 就用 none/todo，不得虚构 refHints，不得把 JD 内容当作经历证据引用。
4. req 逐条拆解 JD 的关键要求（技能/经验/素质），不合并不同维度；JD 是要求来源，不是事实来源。
evidence 最多 20 条。`;
  const matBlock = materials.length
    ? materials.map((m) => {
      const f = (m && m.facts && typeof m.facts === 'object') ? m.facts : {};
      const facts = Object.keys(FACT_LABELS).filter((k) => typeof f[k] === 'string' && f[k]).map((k) => `${FACT_LABELS[k]}：${f[k]}`).join(' / ');
      return `【素材：${m.title}】（id：${m.id}）\n事实：${facts || '（无结构化事实）'}\n表达：${m.brief || ''}\n技术：${m.technical || ''}`;
    }).join('\n\n')
    : '（无已确认素材）';
  // 区域分组：zones 有归属按 ZONE_LABELS，无归属/未知键 → 待确认分类（与区域面板文案同口径）
  const zoneNameOf = (zid) => {
    const z = zones[zid] && zones[zid].zone;
    return ZONE_LABELS[z] || '待确认分类';
  };
  const groups = new Map();
  for (const p of paras) {
    const label = zoneNameOf(p.zid);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(p);
  }
  const paraBlock = groups.size
    ? [...groups.entries()].map(([label, ps]) => `【区域：${label}】\n` + ps.map((p) => `（zid：${p.zid}）${p.text}`).join('\n')).join('\n\n')
    : '（正文无段落）';
  const user = `【目标公司】${company}\n【目标岗位】${role}\n【JD】\n${jd || '（未提供 JD）'}\n\n【已确认素材（可引用，id 用于 refHints）】\n${matBlock}\n\n【简历正文段落（按区域分组，zid 用于 refHints）】\n${paraBlock}`;
  return { sys, user };
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
// opts = { zones: meta.zones（locked 派生）, mats, paras（可选预计算，调用方已有时透传避免重复解析） }。纯函数：返回新 job，不改入参。
export function reviewConsistency(job, html, opts = {}) {
  const zones = opts.zones || {};
  const locked = new Set(Object.entries(zones).filter(([, z]) => z && z.locked === true).map(([zid]) => zid));
  const ctx = {
    paras: opts.paras || parasOf(String(html ?? '')),
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
  const locked = opts.locked instanceof Set ? opts.locked
    // 未显式传 locked 时从 zones 派生（与 reviewConsistency 同口径）：
    // 原先回落空集，使下面 locked-now 拦截在生产路径恒不命中（服务端纵深防御失效）
    : new Set(Object.entries(opts.zones || {}).filter(([, z]) => z && z.locked === true).map(([zid]) => zid));
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
      if (c.kind === 'add' && (typeof op.newZid !== 'string' || !/^z[0-9a-f]{8}$/.test(op.newZid))) return bad('add 接受必须携带 newZid 且形如 z+8 位十六进制（客户端已插入的新段落 ID；坏形状会被 /save 归一重打，与落账 newZid 永久错位）');
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

// ===== 排版诊断（S4a-T10 设计 §5.3 v1.3：结构性事实表述，无置信度分级、无空间占比）=====
// pages = [{ page: 页码, text: pdftotext 该页文本 }]；ctx = {
//   paras: [{zid, text}]（正文段落，来源映射前缀匹配用）,
//   sections: [{title}]（章节标题，跨页诊断用）,
//   typo: { fontSize(pt), lineHeight(倍数), paraGap(em) }, targetPages（默认 2）, rounds（已完成迭代轮数） }。
// 输出：{ over, items:[{text, zid?, page?}], apply:{fontSize,lineHeight,paraGap}|null, atFloor, rounds, topLong:[{zid,text,len}] }。
// 定位规则：页文本行与段落文本（空白归一）前缀匹配 → 命中给 zid；不命中只报页码，不猜测定位。
// 单位落地说明：设计 §5.3 写 pt/em，实现侧 typo 通道为 px/倍数/mm（editor-shell typoCss）——按实现单位落地，设计偏差记 T12 落地修正。
const LAYOUT_FLOORS = { fontSize: 12, lineHeight: 1.3, paraGap: 0.4 };
const LAYOUT_STEPS = { fontSize: -0.5, lineHeight: -0.05, paraGap: -0.1 };
export function layoutDiagnose(pages, ctx = {}) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const pagesArr = (Array.isArray(pages) ? pages : []).filter((p) => p && typeof p.text === 'string');
  const totalPages = pagesArr.length;
  const target = Number(ctx.targetPages) || 2;
  const over = totalPages > target;
  const rounds = Number(ctx.rounds) || 0;
  const typo = { fontSize: Number(ctx.typo && ctx.typo.fontSize) || 10.5, lineHeight: Number(ctx.typo && ctx.typo.lineHeight) || 1.45, paraGap: Number(ctx.typo && ctx.typo.paraGap) || 0.35 };
  const paras = (ctx.paras || []).filter((p) => p && p.zid && p.text);
  const items = [];
  // 来源映射：页文本按行拆（pdftotext 保行结构），行前缀 ↔ 段落文本匹配 → zid
  const pageLines = pagesArr.map((p) => ({ page: p.page, lines: p.text.split('\n').map(norm).filter(Boolean) }));
  const locate = (needle) => {
    const n = norm(needle);
    if (!n) return null;
    for (const pl of pageLines) {
      for (let i = 0; i < pl.lines.length; i++) {
        const line = pl.lines[i];
        const hitPara = paras.find((p) => norm(p.text).startsWith(line) || line.startsWith(norm(p.text).slice(0, Math.min(20, norm(p.text).length))));
        if (hitPara && (n.includes(line) || line.includes(n.slice(0, Math.min(24, n.length))))) return { zid: hitPara.zid, page: pl.page };
      }
    }
    return null;
  };
  // 跨页标题：章节标题落在某页最后 2 行、其章节内容起于次页前 3 行 → 结构性事实表述
  for (const sec of (ctx.sections || [])) {
    const t = norm(sec && sec.title);
    if (!t) continue;
    for (const pl of pageLines) {
      const tail = pl.lines.slice(-2);
      const atTail = tail.some((l) => l.includes(t) && l.length <= t.length + 12);
      if (!atTail || pl.page >= totalPages) continue;
      const next = pageLines.find((x) => x.page === pl.page + 1);
      const headNext = next ? next.lines.slice(0, 3).some((l) => l.length > 0 && !l.includes(t)) : false;
      items.push({
        text: `标题「${t}」出现在第 ${pl.page} 页最后 2 行内${headNext ? '、其内容位于第 ' + (pl.page + 1) + ' 页前 3 行' : ''}——请以实际渲染核对，可考虑将该标题与其内容保持同页`,
        page: pl.page
      });
    }
  }
  // 末页偏少（定性，不做占比）：末页归一文本量显著低于前页均值
  if (totalPages >= 2) {
    const last = pageLines[pageLines.length - 1];
    const prevAvg = pageLines.slice(0, -1).reduce((s2, p) => s2 + p.lines.join('').length, 0) / Math.max(1, pageLines.length - 1);
    if (last && prevAvg > 0 && last.lines.join('').length < prevAvg / 3) {
      const loc = locate(last.lines.slice(0, 3).join(' '));
      items.push({ text: '末页内容明显偏少，建议核对是否可并入上一页', zid: loc ? loc.zid : undefined, page: last.page });
    }
  }
  // 参数建议：固定步长，不做自适应大步；下限内不再给压缩建议（转人工取舍）
  const aboveFloor = typo.fontSize > LAYOUT_FLOORS.fontSize || typo.lineHeight > LAYOUT_FLOORS.lineHeight || typo.paraGap > LAYOUT_FLOORS.paraGap;
  const step1 = (v, floor) => (v > floor ? Math.max(floor, +(v + LAYOUT_STEPS.fontSize).toFixed(2)) : v);
  const apply = over && rounds < 3 && aboveFloor
    ? {
        fontSize: step1(typo.fontSize, LAYOUT_FLOORS.fontSize),
        lineHeight: typo.lineHeight > LAYOUT_FLOORS.lineHeight ? Math.max(LAYOUT_FLOORS.lineHeight, +(typo.lineHeight + LAYOUT_STEPS.lineHeight).toFixed(2)) : typo.lineHeight,
        paraGap: typo.paraGap > LAYOUT_FLOORS.paraGap ? Math.max(LAYOUT_FLOORS.paraGap, +(typo.paraGap + LAYOUT_STEPS.paraGap).toFixed(2)) : typo.paraGap
      }
    : null;
  const atFloor = !aboveFloor;
  // 人工取舍候选：最长的 3 个正文段落（超页且到上限/下限时列出，点击跳转定位）
  const topLong = paras.map((p) => ({ zid: p.zid, text: p.text, len: norm(p.text).length }))
    .sort((a, b) => b.len - a.len).slice(0, 3);
  return { over, items, apply, atFloor, rounds, topLong, pages: totalPages, target };
}

// ===== S4B-3 面试追问（S4b③）：证据表 → 追问链 + 答法要点 =====
// 双护栏：① quote 子串验证（对不上锚定段落就丢弃并计数）② 要点文本对锚定段落跑 factGuard（只标级不丢弃）
// 不生成成稿答案——只给要点，避免制造「这不是我的风格」的距离感（小红书 2026-10-14 实测）
const normSpace = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

// 证据行 → 锚点 zid。⚠️ zid 藏在 refs[] 里，证据行顶层没有 zid 字段
// （parseEvidence 产出 {id,req,status,refs:[{refId,type,id,zid,hash,title,quote}],note}）。
// 曾按顶层 e.zid 取值 → 恒 undefined → prompt 无原文 + 双护栏全被跳过（2026-10-18 蓝军自检）。
// paras 校验：zid 必须仍在当前正文里，否则锚点已失效（证据重生成后旧 zid 会消失）。
function evAnchorZid(e, paras) {
  const refs = (e && Array.isArray(e.refs)) ? e.refs : [];
  const hit = refs.find((r) => r && r.type === 'para' && typeof r.zid === 'string'
    && (paras || []).some((p) => p && p.zid === r.zid));
  return hit ? hit.zid : null;
}

export function parseInterview(raw, ctx = {}) {
  let d;
  try { d = JSON.parse(stripFence(raw)); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const paras = ctx.paras || [];
  const byZid = new Map(paras.filter((p) => p && p.zid).map((p) => [p.zid, p]));
  const evList = Array.isArray(ctx.evidence) ? ctx.evidence : [];
  // 解析侧兜底 prompt 里声明的条数上限——模型不遵守上限时不该把超量内容整批落库
  const maxChains = Math.max(1, evList.length);
  const MAX_GENERIC = 4;
  let dropped = 0;

  const mkChain = (c, anchoredZid, guardBase) => {
    if (!c || typeof c !== 'object') return null;
    const question = typeof c.question === 'string' ? c.question.trim() : '';
    if (!question) return null;
    const anchorHit = anchoredZid ? byZid.get(anchoredZid) : null;
    const anchorText = (anchorHit && typeof anchorHit.text === 'string') ? anchorHit.text : '';
    // 有锚点就必须验证（锚定段落已被删除也算验证失败）；无锚点时用 guardBase（全篇正文）做基准
    const anchorRequired = !!anchoredZid;
    const baseText = anchorText || (typeof guardBase === 'string' ? guardBase : '');

    // ① 子串验证：quote 对不上锚定段落就丢弃（无锚点时不做此检查——通用问题的 quote 无处可锚）
    const points = [];
    for (const p of Array.isArray(c.answerPoints) ? c.answerPoints : []) {
      if (!p || typeof p !== 'object') continue;
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      if (!text) continue;
      const quote = typeof p.quote === 'string' ? p.quote.trim() : '';
      if (anchorRequired && (!anchorText || !quote || !normSpace(anchorText).includes(normSpace(quote)))) { dropped++; continue; }
      // quote 太短等于没锚：二轮安全审查实测 quote:'负责'（段落里确实有）双护栏全过，
      // 却与「主导过公司级战略并购与海外分拆上市」这种纯编造要点一同放行。
      // 子串存在 ≠ 语义相关，正则判不了语义；但「至少引用一段有信息量的原文」是能判的。
      // 门槛定 6 字：既有的 S4B-3 夹具用「负责存储层改造」（7 字）作合法锚定，
      // 它指明了具体改造对象，是有效引用，丢弃它属误报；而「负责」「完成了」
      // 这类 2–3 字动词短语不含任何被引内容，过不了这道门。6 字刚好分开这两类。
      if (quote && [...normSpace(quote)].length < 6) { dropped++; continue; }
      points.push({ text, quote, anchored: !!(anchorText && quote), guard: 'normal' });
    }

    // ② factGuard（checkLoss:false）：只查「新增原文没有的数字」= 编造。
    //    不查丢失方向——答法要点是提炼，漏数字是精简，不是编造。
    //    逐条跑而非整链跑：一条要点编造数字时，同链的正常要点不应被一起标红（误报扩散）。
    if (baseText) {
      for (const p of points) {
        const g = factGuard({ kind: 'replace', before: baseText, after: p.text }, { checkLoss: false });
        if (g.level === 'conflict') p.guard = 'conflict';
      }
    }

    return {
      evIndex: Number.isInteger(c.evIndex) ? c.evIndex : -1,
      zid: anchoredZid || '',
      question,
      followUp: typeof c.followUp === 'string' ? c.followUp.trim() : '',
      answerPoints: points,
      empty: points.length === 0
    };
  };

  const chains = [];
  const rawChains = (Array.isArray(d.chains) ? d.chains : []).slice(0, maxChains);
  for (const c of rawChains) {
    // fail-closed：证据链必须锚得上正文段落才落库。evIndex 越界/非整数、或该行无可用 para ref
    // （含锚点段落已被删除/改版）→ 整链丢弃，绝不降级成「无锚点」绕过两条护栏。
    const i = c && c.evIndex;
    if (!Number.isInteger(i) || i < 0 || i >= evList.length) { dropped++; continue; }
    const zid = evAnchorZid(evList[i], paras);
    if (!zid || !byZid.has(zid)) { dropped++; continue; }
    const chain = mkChain(c, zid);
    if (chain) chains.push(chain);
  }
  // generic 链（自我介绍/为什么选我们）没有单段锚点，但仍要有基准：
  // 用**全篇正文**当基准跑 added-only factGuard，模型编造的数字照样会被抓。
  // 完全无基准 = 模型可为通用问题凭空造事实，与「双护栏」承诺相悖（2026-10-18 OCR 护栏缺口）。
  const wholeDoc = paras.map((p) => (p && p.text) || '').join('\n').trim();
  const generic = [];
  for (const g of (Array.isArray(d.generic) ? d.generic : []).slice(0, MAX_GENERIC)) {
    const item = mkChain({ ...g, evIndex: -1 }, '', wholeDoc);
    if (item) generic.push(item);
  }
  return { chains, generic, dropped };
}

export function buildInterviewPrompt({ jd = '', company = '', role = '', evidence = [], paras = [] }) {
  const evLines = evidence.map((e, i) => {
    const zid = evAnchorZid(e, paras);
    const para = zid ? paras.find((p) => p && p.zid === zid) : null;
    // 无 para 锚点时退回该行 refs 里已校验过的 quote 片段（parseEvidence 已按 refId/zid 校验过）
    const quotes = ((e && e.refs) || []).map((r) => r && r.quote).filter(Boolean).join(' / ');
    const body = para ? para.text : quotes;
    return `【要求 ${i + 1}】${(e && e.req) || ''}\n【简历原文${zid ? '（zid=' + zid + '）' : ''}】${String(body).slice(0, 600) || '（本条无可用原文，勿据此提问）'}`;
  }).join('\n\n');
  const sys = '你是资深技术面试官，正在为一轮真实面试预判追问。\n'
    + '严格规则：\n'
    + '1. 只基于给出的简历原文与岗位要求提问，不得虚构简历里不存在的经历、项目、职级或数字。\n'
    + '2. 每条 answerPoint 必须回填支撑它的原文子串（quote），我会逐字校验；对不上就整条作废。\n'
    + '3. followUp 是这个点上再往下一层的追问，不是换个说法重问。\n'
    + '4. answerPoint 只写「要说的要点」，不要写成可直接背诵的成稿答案——用户要用自己的话讲。\n'
    + '5. 只输出 JSON，不要任何解释文字。';
  const user = `【目标公司】${company}\n【目标岗位】${role}\n【JD】\n${jd || '（未提供 JD）'}\n\n`
    + `【岗位要求与简历证据（索引即 evIndex）】\n${evLines || '（证据表为空）'}\n\n`
    + '输出格式：{"chains":[{"evIndex":0,"question":"…","followUp":"…","answerPoints":[{"text":"…","quote":"原文子串"}]}],'
    + '"generic":[{"question":"自我介绍","answerPoints":[{"text":"…","quote":""}]}]}\n'
    + `chains 最多 ${Math.max(1, evidence.length)} 条（对应证据表行），generic 最多 4 条。`;
  return { sys, user };
}
