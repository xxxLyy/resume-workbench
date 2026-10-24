# 区域建议安全应用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 区域建议按段筛安全子集，并在生成、提交、回执合并三个时点保护用户后续输入。

**Architecture:** 在现有区域模块旁加入小型纯操作模块，扩展 JSON /save 的 zoneOps，复用事务和冲突保护。浏览器先提交未套候选的快照，得到服务端实际应用 delta 后才局部合并；不修改冻结模板。

**Tech Stack:** Node ESM、vanilla JS、内置 assert、现有 extract/zone/tx、Playwright；依赖不变。

---

设计：[/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md) §3；覆盖 Z1–Z6。本计划中的代码与命令待实施 agent 执行，本轮未实施。

## 文件地图与前置条件

| 文件 | 动作与责任 |
|---|---|
| `/Users/xxxly/resume/zone.mjs` | 区域 owner 增加 zoneEditUnits，只增加导出，不改变 parasOf 及历史指纹 |
| `/Users/xxxly/resume/zone-ops.mjs` | 区域 owner 新建纯筛选/安全替换模块 |
| `/Users/xxxly/resume/zone-panel.js` | 区域 owner 修改请求身份、保存前置、接受与回执合并 |
| `/Users/xxxly/resume/editor-shell.js` | 区域 owner 增加保存快照/回执适配，不动冻结模板 |
| `/Users/xxxly/resume/server.mjs` | 服务端 owner 接线 zone-v1、/save 与 /zones 互斥 |
| `/Users/xxxly/resume/test-fixtures/reliability/test-zone-ops.mjs` | 区域 owner 新建纯函数反例 |
| `/Users/xxxly/resume/test-structure.sh`、`/Users/xxxly/resume/test-editor.mjs` | 验证 owner 统一接入 |

前置：验证基础可识别失败；服务端 owner 已锁定工作时段。不得同时让其他包编辑 server.mjs。所有测试根由测试脚本创建；绝不以项目目录作为 RESUME_ROOT。

## Task ZONE-01：段落范围与文本口径

- [ ] 在 test-zone-ops.mjs 添加下面断言，首次运行预期模块/导出缺失而失败。

```js
import assert from 'node:assert/strict';
import { zoneEditUnits, parasOf } from '../../zone.mjs';
import { contentHash } from '../../extract.mjs';
import { applyZoneOps } from '../../zone-ops.mjs';

const html = '<ul><li data-zid="z11111111">A &amp; B<br>C</li>'
  + '<li data-zid="z22222222">负责队列处理</li></ul>';
const units = zoneEditUnits(html);
assert.equal(units[0].text, 'A & B C');
assert.equal(zoneEditUnits('<p data-zid="z11111111">&amp;amp;</p>')[0].text, '&amp;');
assert.notEqual(contentHash('A B'), contentHash('AB'));
assert.equal(parasOf('<p data-zid="z11111111">A &amp; B</p>')[0].text, 'A &amp; B');
const op = (unit, candidate) => ({
  operationId: 'op-' + unit.zid, zid: unit.zid, zone: 'work',
  baselineVersion: 'zone-v1', before: unit.text,
  beforeHash: contentHash(unit.text), candidate
});
const zones = {
  z11111111: { zone: 'work', status: 'confirmed' },
  z22222222: { zone: 'work', status: 'confirmed', locked: true }
};
const result = applyZoneOps({
  diskHtml: html, html, zones,
  zoneOps: [op(units[0], 'A & B C 说明'), op(units[1], '维护队列处理')]
});
assert.deepEqual(result.applied.map((x) => x.zid), ['z11111111']);
assert.equal(result.skipped[0].reason, 'locked');
assert.match(result.html, /A &amp; B C 说明/);
assert.match(result.html, /负责队列处理/);
assert.equal(result.html.includes('维护队列处理'), false);
assert.throws(() => applyZoneOps({ diskHtml: html, html, zones,
  zoneOps: [op(units[0], '说明'), op(units[0], '另一个说明')] }), /重复/);
const literal = applyZoneOps({ diskHtml: html, html, zones,
  zoneOps: [op(units[0], '<script>literal</script>')] });
assert.equal(literal.html.includes('<script>literal'), false);
assert.match(literal.html, /&lt;script&gt;/);
console.log('PASS ZONE-01: canonical text, subset, escaping, duplicates');
```

- [ ] 运行 `node test-fixtures/reliability/test-zone-ops.mjs`，记录首次非零；不把 import 缺失当最终反例充分性，后面还要用错误实现验证断言会失败。
- [ ] 在 zone.mjs 的现有 import 中加入 docToText；在 unitTags/isUnit 所在模块内增加以下导出，复用既有线性扫描和闭合索引。

```js
export function zoneEditUnits(html) {
  const s = String(html);
  const all = unitTags(s).filter((u) => isUnit(u.tag, u.attrs) && ZID_ATTR.test(u.attrs));
  const counts = new Map();
  for (const u of all) {
    if ((u.attrs.match(/\sdata-zid\s*=/gi) || []).length !== 1) {
      throw new Error('区域单位存在重复 data-zid 属性');
    }
    const zid = ZID_ATTR.exec(u.attrs)[1];
    counts.set(zid, (counts.get(zid) || 0) + 1);
  }
  const idx = closeIndex(s, [...new Set(all.map((u) => u.tag.toLowerCase()))]);
  let until = 0;
  const out = [];
  for (const u of all) {
    if (u.index < until) continue;
    const end = matchingClose(s, u.index, u.tag, idx);
    if (end < 0) continue;
    const innerStart = u.index + u.raw.length;
    const innerEnd = s.lastIndexOf('<', end - 1);
    if (innerEnd < innerStart) continue;
    const zid = ZID_ATTR.exec(u.attrs)[1];
    out.push({ zid, count: counts.get(zid), start: u.index, end,
      innerStart, innerEnd,
      text: docToText(s.slice(innerStart, innerEnd), { includeHidden: true })
        .replace(/\s+/g, ' ').trim() });
    until = end;
  }
  return out;
}
```

只处理现有段落单位包络，不支持的畸形 HTML 不能猜测范围；matchingClose 返回闭合标签末尾后一位，innerEnd 因此取对应最后一个 `<`。增加断言验证保留开闭标签与属性、嵌套单位不重复处理、未闭合单位不可应用。不得用反复全文正则替换重新引入平方级扫描。

## Task ZONE-02：安全子集纯函数

- [ ] 新建 zone-ops.mjs，接口与核心实现固定如下。

```js
import { contentHash } from './extract.mjs';
import { zoneEditUnits, ZONE_KEYS } from './zone.mjs';
import { factGuard } from './job.mjs';

export class ZoneOpError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_REQUEST'; this.httpCode = 400; }
}
const escapeText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function applyZoneOps({ diskHtml, html, zones, zoneOps }) {
  if (!Array.isArray(zoneOps) || !zoneOps.length) throw new ZoneOpError('zoneOps 必须为非空数组');
  const seen = new Set();
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
    seen.add(x.zid);
  }
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
    if (!a || !b) reason = 'gone';
    else if (a.text !== x.before || b.text !== x.before) reason = 'changed';
    else if (!z || z.zone !== x.zone) reason = 'rebound';
    else if (z.locked === true) reason = 'locked';
    else if (factGuard({ kind: 'replace', before: a.text, after: x.candidate }).level === 'conflict') reason = 'conflict';
    if (reason) { skipped.push({ operationId: x.operationId, zid: x.zid, reason }); continue; }
    const delta = { operationId: x.operationId, zid: x.zid, candidate: x.candidate,
      zone: x.zone, beforeHash: x.beforeHash };
    applied.push(delta);
    edits.push({ start: b.innerStart, end: b.innerEnd, text: escapeText(x.candidate) });
  }
  edits.sort((a, b) => a.start - b.start);
  const chunks = []; let at = 0;
  for (const edit of edits) {
    if (edit.start < at) throw new ZoneOpError('目标范围重叠');
    chunks.push(String(html).slice(at, edit.start), edit.text); at = edit.end;
  }
  chunks.push(String(html).slice(at));
  return { html: chunks.join(''), applied, skipped };
}
```

- [ ] 为 operationId 重复但 zid 不同补整次 400：在seen旁增加`const operationIds = new Set();`，在每次`seen.add(x.zid)`之前加入以下代码；不得让两个delta共用操作身份。

```js
if (operationIds.has(x.operationId)) throw new ZoneOpError('重复 operationId');
operationIds.add(x.operationId);
```
- [ ] 扩充 ZONE-01 测试：原文被改、段落消失、改绑、数字冲突分别得到 changed/gone/rebound/conflict；仅 pending→confirmed 不失效；零 applied 时 html 原样；格式字符只转义一次。
- [ ] 运行独立单测，预期 PASS；临时忽略 locked 校验运行应失败，再恢复。验证 owner 在 test-structure.sh 显式加入 `node ./test-fixtures/reliability/test-zone-ops.mjs`。
- [ ] 运行 `bash test-structure.sh`，预期新单测与 EXTRACT-Q、旧 parasOf/指纹用例均通过；提交独立模块、测试与接线，提交信息 `feat(zone): validate rewrite subsets without changing legacy fingerprints`。

## Task ZONE-03：生成基线、读取版本与机器码

- [ ] 服务端 owner 在 `/job/changes` 的现有 doc 响应增加 mtime：`mtime: fs.existsSync(docPath(id)) ? fs.statSync(docPath(id)).mtimeMs : null`。这是读取视图，不写 metadata，也不改变 rev。
- [ ] 区域请求必须包含正数有限 baseMtime。区域两端点在读正文前返回明确 JSON 错误；用下面公共判定，旧接口的 staleGuard 保持原样。

```js
function zoneRequestError(id, body) {
  if (!fs.existsSync(docPath(id))) return { status: 404, code: 'DOC_NOT_FOUND', error: '文档不存在' };
  if (typeof body.baseMtime !== 'number' || !Number.isFinite(body.baseMtime) || body.baseMtime <= 0) {
    return { status: 400, code: 'INVALID_REQUEST', error: 'baseMtime 必填' };
  }
  if (body.baseMtime !== fs.statSync(docPath(id)).mtimeMs) {
    return { status: 409, code: 'STALE_DOCUMENT', error: '文档已变化，请先同步内容' };
  }
  return null;
}
```

- [ ] rewrite 读到 html/meta 后，prompt与parseZoneRewrites同时使用zone-v1文本，不能只修改响应before：

```js
const zoneUnits = zoneEditUnits(html).filter((p) => meta.zones?.[p.zid]?.zone === body.zone);
const free = zoneUnits.filter((p) => meta.zones[p.zid].locked !== true);
const p = buildZoneRewritePrompt({ zoneName: ZONE_LABELS[body.zone], paras: free, instruction });
const raw = await chat(root, p.sys, p.user);
const parsed = parseZoneRewrites(raw, free);
const requestPrefix = randomBytes(8).toString('hex');
const baseline = new Map(free.map((unit) => [unit.zid, unit]));
const rewrites = parsed && parsed.map((r, i) => ({ ...r,
  operationId: requestPrefix + '-' + i, baselineVersion: 'zone-v1',
  before: baseline.get(r.zid).text, beforeHash: contentHash(baseline.get(r.zid).text),
  zone: body.zone, candidate: r.candidate
}));
```

保留原零free、解析失败及locked提示分支；资源包集成时chat多传`{lease:resources.ai}`。模型不得指定基线和operationId。分析的zoneText也从zoneUnits的规范文本构建。增加实体原文→prompt→候选→保存→刷新的端到端反例，避免把`&amp;`误当用户真实字面量。
- [ ] 未配置模型仍 409，但 JSON code 为 LLM_NOT_CONFIGURED；资源不足为 RESOURCE_BUSY。分析结果及改写结果返回 `baseMtime:body.baseMtime`。不要把所有 409 降级成未配置。

## Task ZONE-04：最终保存与归属写入的同一互斥

- [ ] 先加实际反例：预检查后向 `/zones` 锁定一个目标，再提交包含它与另一安全目标的 zoneOps，预期只写安全目标；同样验证 `/zones/init` 不能穿过保存临界区。使用已有隔离服务和保存 gap 钩子，不接真实目录。
- [ ] 形状校验处区分 `const isZoneSave = Object.hasOwn(body,'zoneOps');`。zoneOps 与非空 ops 混用整次 400；baseMtime 缺失/非数/非正值整次 400。job 不存在不拒绝 zoneOps，也不创建 job。
- [ ] 保留 rootLock→withDocLock→updateMeta 的锁顺序。在 `/zones`、`/zones/init` 的 body 读取和形状校验之后，真正写入前同步 acquire rootLock，并在同一 doc lock 内执行现有 updateMeta，finally 释放自己取得的根锁。所有相关入口必须共同遵守，不只修改 zoneSave 一侧。

```js
function withZoneWrite(id, fn) {
  rootLock.acquire(root);
  try { return withDocLock(root, id, fn); }
  finally { rootLock.release(root); }
}
```

fn 必须保持同步，只包装原 updateMeta 和响应数据计算，不在其中读网络或 await；如将来引入异步，改为 async try/finally 并 await，不能提前释放。读取 body 前的维护锁检查不代替这里的实际 acquire。

- [ ] JSON 保存锁内先查正确回执集合。zoneSave 用 oldMeta.zoneSaveReceipts，普通 ops 保持 job.saveReceipts。同请求同内容先返回保存时原回执；内容不同返回400，均不写盘。
- [ ] rev 校验后额外严格比较 zoneSave.baseMtime 与当前正文 mtime；冲突响应 code=STALE_DOCUMENT。不为了“让它成功”自动取新 rev 重放。
- [ ] 在 normalizeZids 前先用 zoneEditUnits 对提交原始剥离 HTML 检查目标唯一性，防归一化把重复目标悄悄改名。然后调用 `applyZoneOps({diskHtml:oldHtml,html:stripped,zones:oldMeta?.zones||{},zoneOps:body.zoneOps})`。此分支将其 html 交既有 normalizeToCurrent，普通 ops 分支保持现状。
- [ ] 零安全目标直接返回 409 `NO_APPLICABLE_CANDIDATES` 与 skipped；必须在 snapshot/beginTx 前返回。成功则沿用原事务，不渲染 PDF。
- [ ] 在一次 updateMeta 中保存新正文对应 zoneSync、rev、可投递失效状态及以下回执；zone分支不调用岗位 applyOps，也不让普通母版出现 job。

```js
const zoneReceipt = {
  requestId: body.requestId,
  mtime: fs.statSync(docPath(id)).mtimeMs,
  rev: base.rev,
  hash: contentHash(newHtml),
  applied: zoneResult.applied,
  skipped: zoneResult.skipped
};
base.zoneSaveReceipts = [...(base.zoneSaveReceipts || []), {
  requestId: body.requestId, contentHash: reqHash, receipt: zoneReceipt
}].slice(-50);
receipt = zoneReceipt;
```

这些名字绑定到原 saveJsonProtocol 的 body/base/newHtml/reqHash/receipt，以及本步骤命名的 zoneResult。保留原 beginTx、双恢复、commitTx 和 dropSupersededTx。响应返回 `{ok:true,...receipt,receipt,pdfStale}`，旧分支响应形状不变。

- [ ] 验证回执重放不新建快照、不推进rev；相同 ID 不同内容 400；普通母版/岗位草稿都通过；零安全目标正文/meta/快照文件清单与 mtime 均不变。运行 `bash test.sh` 的现有 JSON保存/区域/事务块，不删除S3B/S3C/S4a断言。
- [ ] 在文档复制入口现有的元数据剥离列表中加入`zoneSaveReceipts`，新副本不得继承源文档的区域回执；正常备份/恢复则保留它。为复制后无回执、原文档回执仍在补断言。
- [ ] 提交服务端与对应测试，信息 `fix(zone): commit safe rewrites with binding and version checks`。

## Task ZONE-05：浏览器生成前置与请求 epoch

- [ ] zone-panel.js 增加 `requestEpoch` 与 `activeRequest`，所有切换 aiZone 的入口调用以下失效操作；重绘同一有效上下文保留状态，不能重建卡片就把 busy 清空。

```js
var requestEpoch = 0, activeRequest = null;
function invalidateRequest() { requestEpoch++; activeRequest = null; }
function beginRequest(kind, zone) {
  var token = { epoch: ++requestEpoch, kind: kind, zone: zone };
  activeRequest = token;
  return token;
}
function isCurrent(token) { return activeRequest === token && token.epoch === requestEpoch; }
async function ensureSavedForZone() {
  if (typeof window.__edFlushSave !== 'function' || typeof window.__edIsDirty !== 'function') {
    throw new Error('当前编辑器无法确认保存，请刷新后重试');
  }
  var ok = await window.__edFlushSave();
  if (ok !== true || window.__edIsDirty()) throw new Error('当前修改尚未保存，请保存完成后重试');
  var mtime = Number(window.__edDocMtime);
  if (!Number.isFinite(mtime) || mtime <= 0) throw new Error('缺少已确认的文档版本');
  return mtime;
}
```

- [ ] analyze/rewrite 先 beginRequest，await ensureSavedForZone，然后再次 isCurrent；捕获目标 `innerHTML` Map 后发请求，body 包含 baseMtime。then/catch/finally 的渲染、lastAnalysis、preview、busy 变更都先 isCurrent。旧 finally 不得关闭新请求 busy。
- [ ] renderAi 末尾改为 `setBusy(state.aiDegraded || !!activeRequest)`；只在当前请求完成时设 activeRequest=null，再清 busy。switch入口清旧结果或明确失效，不允许旧preview继承新区域。
- [ ] 现有 `ed-zone-preview` 兼容事件只能作为有基线的响应通道；测试中任意 before:'旧' 的旧夹具必须改为真实基线。缺基线候选可展示但不可接受，不让第三方事件绕过新检查。
- [ ] 409 根据code分别显示；LLM_NOT_CONFIGURED才调用degrade。其它错误保留模型功能可用状态。

## Task ZONE-06：提交、局部合并、版本与一次撤销

- [ ] 区域owner在 editor-shell.js 增加共享序列化函数，代码完整采用既有buildPageHtml口径：

```js
window.__edBuildSaveHtml = function () {
  var clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('.page-line, .toast, .recovery-bar, [data-ai-panel], [data-ed-shell], [data-ed-inj], [data-job-panel]').forEach(function (el) { el.remove(); });
  var cbody = clone.querySelector('body');
  if (cbody) { cbody.classList.remove('ed-on', 'ed-preview'); cbody.style.cssText = ''; }
  var csheet = clone.querySelector('.sheet');
  if (csheet) { csheet.style.zoom = ''; csheet.style.transform = ''; csheet.setAttribute('contenteditable', 'true'); }
  var cstate = clone.querySelector('#saveState');
  if (cstate) { cstate.dataset.state = 'saved'; cstate.textContent = '已保存 \u2713'; }
  var csave = clone.querySelector('#saveBtn');
  if (csave) csave.removeAttribute('disabled');
  return '<!doctype html>\n' + clone.outerHTML;
};
```

来源owner收到补丁清单后，将其独占job-panel.js中的函数替换为以下包装；不得由区域owner并行直接修改该文件。

```js
function buildPageHtml() {
  if (typeof window.__edBuildSaveHtml !== 'function') throw new Error('编辑器保存通道未就绪，请刷新');
  return window.__edBuildSaveHtml();
}
```

服务端注入顺序已有shell先于job/zone，验证owner补加载顺序断言。不要第三次复制序列化器，不改template.html；状态字符串保留既有转义形式。
- [ ] 接受时对比生成时 node.innerHTML，先剔除本地变化项并保存原因；await ensureSavedForZone 后取得 `/job/changes` 的 rev/doc.mtime，必须与已确认 mtime匹配。在最后一次await之后再次检查`__edIsDirty()`，并逐段重新与**原生成时快照**比较；不是把当前DOM重新认作生成基线。若仍dirty或没有剩余安全目标，立即结束，不发送空zoneOps。之后在同一同步轮次捕获提交快照、目标innerHTML并构建固定请求对象。
- [ ] POST `/save` 的 html 使用 `__edBuildSaveHtml()` 未套候选结果，ops=[]，zoneOps为剩余候选，requestId为本次唯一值；保存网络错误不自动重发。保留该请求对象用于用户明确重试时同ID同内容重发，不能重新序列化HTML却保留旧ID。
- [ ] 回执仅对匹配requestId的请求有效。通过以下比较推进盘基线，不把旧回执覆盖新基线；已知 rev保存在zone面板本地，用于下一次同版本核对，模板继续从__edDocMtime读取。

```js
var adoptedZoneReceipts = new Set();
function adoptZoneReceipt(sent, receipt, knownRev) {
  if (receipt.requestId !== sent.requestId) return 'superseded';
  if (adoptedZoneReceipts.has(sent.requestId)) return 'already-adopted';
  if (Number(window.__edDocMtime) !== sent.baseMtime || knownRev > receipt.rev) return 'superseded';
  window.__edDocMtime = receipt.mtime;
  adoptedZoneReceipts.add(sent.requestId);
  if (adoptedZoneReceipts.size > 50) adoptedZoneReceipts.delete(adoptedZoneReceipts.values().next().value);
  return 'adopted';
}
```

调用分支固定：只有`adopted`可以进行下一步merge并更新本地knownRev；`already-adopted`只返回提示，不合并、不压栈；`superseded`保留dirty并提示核对，禁止继续merge或采用回执版本。保留最近50个已采用requestId，超限移除最早项；旧回执即使移出集合，也会被当前盘基线挡住。不能用此函数清空模板修订或缓存。补“较新普通保存先确认、旧区域回执后到”的真实控制流反例。

- [ ] 合并仅针对receipt.applied且当前innerHTML等于提交快照的节点；在途变化的节点保留。DOM合并核心为：

```js
function mergeZoneDelta(receipt, snapshots) {
  var ready = [], changed = [];
  receipt.applied.forEach(function (it) {
    var el = sheet.querySelector('[data-zid="' + it.zid + '"]');
    if (!el || el.innerHTML !== snapshots.get(it.zid)) changed.push(it.zid);
    else ready.push({ el: el, candidate: it.candidate });
  });
  var opId = null;
  if (ready.length) {
    opId = window.__edPushUndo('区域改写');
    ready.forEach(function (it) { it.el.textContent = it.candidate; });
    window.__edMarkProgrammatic();
  }
  return { opId: opId, merged: ready.length, changed: changed };
}
```

- [ ] 在途变化但没有ready时也维持已有dirty/缓存，不创建空撤销。消息明确“安全子集已保存；跳过N段；另有M段在等待期间继续编辑，已保留本地内容”。Toast绑定同一个opId。
- [ ] 保存失败、版本冲突、结果未知不整页回滚，也不把未确认候选套进正文；自动保存冲突保留现有恢复/冲突提示，不强行刷新覆盖。
- [ ] 浏览器断言必须覆盖：提交中输入另一段及目标段；回执后自动/手动保存、刷新完整；一次撤销只回退合并而保留等待期间输入；旧回执不会倒退mtime。分别运行母版与岗位草稿。

## Task ZONE-07：场景收尾与提交

- [ ] 验证 owner 把 Z1–Z6 的浏览器测试加到现有 test-editor.mjs，使用本地慢模型桩控制响应顺序。必要的受控等待以桩信号/请求事件为准，避免只用固定sleep。
- [ ] 具体的在途输入断言形态如下，接现有隔离page上下文：

```js
await page.locator('#zp-accept').click();
await page.locator('[data-zid="z22222222"]').press('End');
await page.keyboard.type(' 新输入保留');
releaseSaveResponse();
await page.waitForFunction(() => document.body.textContent.includes('已保存'));
assert.match(await page.locator('[data-zid="z22222222"]').textContent(), /新输入保留/);
await page.locator('#saveBtn').click();
await page.reload();
assert.match(await page.locator('[data-zid="z22222222"]').textContent(), /新输入保留/);
```

`releaseSaveResponse` 由page.route对本次真实保存响应进行受控延迟：必须先执行route.fetch让服务端实际保存，再延迟route.fulfill；不能用伪造200替代真实落盘。断言还须检查本轮保存response.ok及隔离磁盘内容，不能仅匹配body文字。

- [ ] 运行独立纯函数测试和 `bash test.sh`，本包相关块全部实际执行。由最终交付包统一运行strict四套件。
- [ ] 提交前端、注入辅助及浏览器用例，信息 `fix(zone): preserve edits while merging confirmed rewrite deltas`。

## 完成证据与回退

交接记录每个 Z1–Z6 的实际断言名称及输出。静态源码检查、假响应200或页面存在均不算完成证据。

回退顺序为浏览器接线→保存协议接线→纯模块。保留旧HTML保存、原岗位ops、严格CSP与验证基础；新文档级回执字段可留存但旧客户端不得解释为已确认来源。事务失败按现有旧正文/meta恢复，不使用旧页面覆盖用户输入。若本包尚未完整集成，暂不启用新的接受按钮，不能开放一个只做preflight的半成品。
