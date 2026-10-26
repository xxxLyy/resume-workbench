// zone-ops.mjs — 区域改写的安全子集计算与纯文本替换（纯函数，零网络 / 零磁盘）
// 契约（设计 §3，zone-v1）：
//   1) 同时核对：磁盘正文（diskHtml）、提交前 HTML（html）、原文基线（before/beforeHash）、
//      区域归属（zones[zid].zone）、锁定状态（zones[zid].locked）。
//   2) 只应用安全目标；原文变化/删除/改绑/锁定/事实冲突分别给出明确跳过原因。
//   3) 候选按纯文本安全写入（& < > 只转义一次），保留目标开闭标签与属性，不动相邻内容。
//   4) 重复 zid / 重复 operationId / 非法形状 / 重叠目标一律拒绝，不重打 ID、不猜落点。
//   5) 零安全目标 → HTML 原样返回；输入对象不被修改。
import { contentHash } from './extract.mjs';
import { zoneEditUnits, ZONE_KEYS } from './zone.mjs';
import { factGuard } from './job.mjs';

export class ZoneOpError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_REQUEST';
    this.httpCode = 400;
  }
}

// 纯文本 → HTML 内容：只转义 & < >（内容区，不涉及属性，无需转义引号）；只转义一次。
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// zones: { [zid]: { zone, status, locked? } }；zoneOps: [{ operationId, zid, zone, baselineVersion, before, beforeHash, candidate }]
// 返回：{ html, applied: [...], skipped: [...] }
export function applyZoneOps({ diskHtml, html, zones, zoneOps }) {
  if (!Array.isArray(zoneOps) || !zoneOps.length) throw new ZoneOpError('zoneOps 必须为非空数组');
  // 形状校验 + 身份唯一性：同一 zid 或同一 operationId 出现两次都拒绝（不让两个 delta 共用身份）。
  const seen = new Set();
  const operationIds = new Set();
  for (const x of zoneOps) {
    if (!x || typeof x.operationId !== 'string' || !x.operationId.trim() || x.operationId.length > 128
      || typeof x.zid !== 'string' || !/^z[0-9a-f]{8}$/.test(x.zid)
      || x.baselineVersion !== 'zone-v1' || !ZONE_KEYS.includes(x.zone)
      || typeof x.before !== 'string' || typeof x.beforeHash !== 'string'
      || x.beforeHash !== contentHash(x.before)
      || typeof x.candidate !== 'string' || !x.candidate.trim()) {
      throw new ZoneOpError('非法区域操作');
    }
    if (seen.has(x.zid)) throw new ZoneOpError('重复区域操作');
    if (operationIds.has(x.operationId)) throw new ZoneOpError('重复 operationId');
    seen.add(x.zid);
    operationIds.add(x.operationId);
  }
  // 磁盘正文与提交前 HTML 各自定位单位（形状非法 → 拒绝，不猜范围）
  let disk, submitted;
  try {
    disk = new Map(zoneEditUnits(diskHtml).map((x) => [x.zid, x]));
    submitted = new Map(zoneEditUnits(html).map((x) => [x.zid, x]));
  } catch (e) { throw new ZoneOpError(e.message); }
  const applied = [], skipped = [], edits = [];
  for (const x of zoneOps) {
    const a = disk.get(x.zid), b = submitted.get(x.zid), z = zones?.[x.zid];
    if (a?.count > 1 || b?.count > 1) throw new ZoneOpError('正文存在重复 zid');
    let reason = '';
    if (!a || !b) reason = 'gone';                                   // 目标已不存在（磁盘或提交侧）
    else if (a.text !== x.before || b.text !== x.before) reason = 'changed';   // 原文已变（含磁盘侧与提交侧）
    else if (!z || z.zone !== x.zone) reason = 'rebound';              // 区域归属已改
    else if (z.locked === true) reason = 'locked';                    // 已被锁定
    else if (factGuard({ kind: 'replace', before: a.text, after: x.candidate }).level === 'conflict') reason = 'conflict';  // 事实冲突
    if (reason) { skipped.push({ operationId: x.operationId, zid: x.zid, reason }); continue; }
    const delta = { operationId: x.operationId, zid: x.zid, candidate: x.candidate, zone: x.zone, beforeHash: x.beforeHash };
    applied.push(delta);
    edits.push({ start: b.innerStart, end: b.innerEnd, text: escapeText(x.candidate) });
  }
  // 一次成型替换（不逐目标全文重扫）：按起点排序后单遍拼回
  edits.sort((a, b) => a.start - b.start);
  const chunks = []; let at = 0;
  for (const edit of edits) {
    if (edit.start < at) throw new ZoneOpError('目标范围重叠');
    chunks.push(String(html).slice(at, edit.start), edit.text); at = edit.end;
  }
  chunks.push(String(html).slice(at));
  return { html: chunks.join(''), applied, skipped };
}
