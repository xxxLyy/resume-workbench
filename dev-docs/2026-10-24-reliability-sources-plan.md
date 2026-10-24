# 来源可信与评估兼容 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不迁移真实数据、不新增事实数据库的前提下，使面试提示词、要点引文和岗位评估只声明程序实际能够核对的来源，并对旧结果作读取时降级。

**Architecture:** 复用 evidence 的 refs、paraFingerprint、refFresh，以及现有正文提取和 jobViewLive。一次生成只构造一份请求来源集合，同时交给 prompt 和 parser；来源视图只生成响应字段，不改存储。eval 继续同步调用，仅纠正输入、证据核验、来源记录及旧 sourced 的展示。

**Tech Stack:** Node.js ESM、node:test、node:assert/strict；现有原生浏览器 DOM 与 Playwright 测试设施；零新依赖。

---

## 0. 执行边界、依赖与证据

- 已批准设计：[2026-10-24-reliability-hardening-design.md](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md)，对应 `5.1–5.4`、验收 S1–S3/E1–E2。
- 源码定位基线：`627c2a8b81c2be333f0eaa493ee54da15ac63833`；执行前按函数重新定位，不依赖旧行号。
- 本计划当前仅为文档。下方代码均是后续实施内容，尚未写入实现文件、尚未运行测试。
- 不读取或改写真正的 `/Users/xxxly/resume/docs/`、`config.json`、`materials.json`、`docs-meta.json`、`evaluations.json`；集成写操作只能在测试 owner 的独立 RESUME_ROOT。
- 冻结 `template.html`、`themes/`、`render.mjs`；不扩大 CSP，不引入真实模型请求。
- 仅素材、没有可用 para 的证据行跳过证据派生追问；generic 空引文保留为明确未经事实核验的作答思路。这两项已在设计中固定，不另行改为素材型面试追问。
- 等验证基础包能如实返回失败后再接共享套件。纯函数用例可以先单独准备。
- 实施前记录自己的 worktree、初始 git status；保护其他 agent 与用户已有改动。共用文件不得由不同 owner 同时写。
- 各小步骤目标 2–5 分钟；若一次步骤超出，按下文已经列明的函数边界分段执行，不扩展任务范围。

## 1. 文件与所有权

| 文件 | 操作与唯一职责 | owner |
|---|---|---|
| /Users/xxxly/resume/evidence.mjs | 来源集合、prompt/parser、来源响应视图纯函数 | 来源 owner |
| /Users/xxxly/resume/eval.mjs | 新评估状态、证据核验、旧记录视图 | 来源 owner |
| /Users/xxxly/resume/job-panel.js | 只消费服务端来源视图，显示标签/引文/定位/跳过原因 | 来源 owner |
| /Users/xxxly/resume/test-fixtures/reliability/test-sources.mjs | 全合成纯函数回归，不加载 server 或真实配置 | 来源 owner |
| /Users/xxxly/resume/server.mjs | runGenTask、jobViewLive、评估入口与卡片接线 | 服务端集成 owner；本计划给出准确片段 |
| /Users/xxxly/resume/test-structure.sh | 旧 S4B/EV 夹具迁移与新测试调用 | 验证 owner |
| /Users/xxxly/resume/test-editor.mjs | S3 展示/定位与来源失效浏览器场景 | 验证 owner |
| /Users/xxxly/resume/test.sh | stub 请求来源与 E1/E2 端到端 | 验证 owner |
| /Users/xxxly/resume/dev-docs/handoff.md | 最终实际结果回写 | 集成交接 owner |

本计划不改 finishGenTask、zoneOps、资源池或进程治理。任务状态包新增的 gen-result.mjs 及 `{ok:true,extra}` / `{ok:false,error}` 业务返回由集成 owner 管理；本包构造 sources 必须位于 runner 的生成输入阶段，不能承担任务完成状态判断。server 的修改顺序由总计划集成 owner 决定；不要把本计划片段直接并行写进 server。

## 2. 固定接口与返回字段

### 2.1 请求来源集合

~~~text
resolveInterviewSources({ evidence, paras }) => ({
  sourcesByEvIndex: Map<number, { zid, hash, text }>,
  sourceParas: Array<{ zid, hash, text }>,
  omitted: Array<{
    evIndex: number,
    reason: 'material-only' | 'stale' | 'missing' | 'empty'
  }>
})
~~~

规则：

- hash 是完整当前段落的 `paraFingerprint`，不是截断片段的 hash。
- text 是本次实际发给模型的 `String(para.text).slice(0, 600)`，最多 600 个 JavaScript UTF-16 code units；不在 parser 内重新读取或扩大该片段。
- sourcesByEvIndex 使用原始 evidence 下标；sourceParas 按 zid 去重、保留首次出现顺序。
- 每行按 refs 顺序取第一个 `refFresh(ref,{paras})` 为 true 且非空的 para；同一行多个段落不拼接。
- material-only 仅说明该行没有 para、存在 mat ref，不声称素材当前有效。本函数不接收 mats，也不为素材构造伪 para。
- 有 para ref 但找不到匹配当前指纹的来源为 stale；有 fresh para 但文本为空为 empty；其它无来源为 missing。
- buildInterviewPrompt 与 parseInterview 必须显式收到 sources；不得偷偷回退到 ctx.paras 或 refs.quote。
- 生产缺 sources：buildInterviewPrompt 抛 TypeError；parseInterview 返回 null。已有纯函数夹具按 Task SRC-02 的明确包装器迁移。

### 2.2 模型输出与程序输出

模型 generic 的有引文要点额外回传 `sourceZid`。模型不能自报可信度：

~~~text
// 模型 generic 要点
{ text: '我负责存储层改造', quote: '负责存储层改造', sourceZid: 'za1111111' }

// 程序持久化的要点（来源由程序填写）
{
  text: '我负责存储层改造',
  quote: '负责存储层改造',
  source: { type: 'para', zid: 'za1111111', hash: paraFingerprint('负责存储层改造，QPS 从 300 提升到 5000') },
  anchored: true,
  guard: 'normal'
}

// 空引文 generic 的程序输出
{
  text: '先交代与岗位相关的经历，再解释选择理由',
  quote: '',
  source: { type: 'none' },
  anchored: false,
  guard: 'normal'
}
~~~

已有链顶层 zid 保留；generic 顶层 zid 仍为空。回跳改用要点的响应 sourceZid，不能要求 generic 的链顶层 zid 非空。

### 2.3 读取时视图

~~~text
interviewSourceView(interview, { paras }) => interviewClone
// 每个 answerPoint 增加/派生：
// sourceState: 'fresh' | 'stale' | 'none' | 'legacy' | 'invalid'
// quoteForDisplay: string  // 只有 fresh 时非空
// sourceZid: string        // 只有 fresh 时非空
// anchored: boolean       // 由 fresh 派生，覆盖旧显示值；不写回存储

evidenceSourceView(ref, { paras, mats }) => ({
  sourceState: 'fresh' | 'stale' | 'unavailable',
  sourceTitle: string,     // 只取真实素材标题或素材 ID
  sourceText: string,      // 真实素材已确认 facts 的可读串，para 留空
  quoteForDisplay: string,
  sourceZid: string
})

evalRecordView(record) => ({
  ...recordClone,
  sourceState: 'recorded' | 'legacy' | 'invalid',
  blocks: {
    ...blocksClone,
    matches: [/* 旧 sourced 映射 missing + 清证据 + compatibilityReason */]
  }
})
~~~

recorded 表示“记录了评估时的母版与正文指纹”，不表示当前母版未变化。不得用这个字段宣称当前仍 fresh。以上函数均不得修改入参或落盘。

---

## Task SRC-01（S1）：构造唯一请求来源集合

**Files**

- Modify: /Users/xxxly/resume/evidence.mjs，面试追问段 `normSpace` 后、`parseInterview` 前。
- Create/Test: /Users/xxxly/resume/test-fixtures/reliability/test-sources.mjs。

- [ ] **Step 1（3 分钟）：创建全合成测试文件与 S1 反例。**

~~~js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../../evidence.mjs';
import * as V from '../../eval.mjs';
import { docToText, contentHash } from '../../extract.mjs';

const P1 = { zid: 'za1111111', text: '负责存储层改造，QPS 从 300 提升到 5000' };
const P2 = { zid: 'zb2222222', text: '交付异步任务平台，每天处理 100000 个任务' };
const MAT = {
  id: 'm-source01',
  title: '合成素材',
  factStatus: 'confirmed',
  facts: { contribution: '主导订单系统拆分', metrics: '覆盖 3 个业务线' }
};

function rowFor(para, req = '后端能力') {
  return E.parseEvidence(JSON.stringify({
    evidence: [{ req, status: 'covered', refHints: [{
      type: 'para', zid: para.zid,
      title: '模型标题', quote: 'FAKE_QUOTE_DO_NOT_FORWARD'
    }] }]
  }), { gen: 1, mats: [], paras: [para] })[0];
}

function materialRow() {
  return E.parseEvidence(JSON.stringify({
    evidence: [{ req: '订单经验', status: 'sourced', refHints: [{
      type: 'mat', id: MAT.id, title: '伪素材标题', quote: '伪造了战略并购经历'
    }] }]
  }), { gen: 1, mats: [MAT], paras: [] })[0];
}

function sourcesFor(evidence, paras) {
  return E.resolveInterviewSources({ evidence, paras });
}

function interview(raw, evidence, paras, sources = sourcesFor(evidence, paras)) {
  return E.parseInterview(JSON.stringify(raw), { evidence, sources });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

test('S1 resolve preserves original indexes and never promotes mat quote', () => {
  const good = rowFor(P1);
  const stale = { ...rowFor(P2), refs: rowFor(P2).refs.map(r => ({ ...r, hash: '0'.repeat(40) })) };
  const missing = { id: 'e4', req: '缺来源', refs: [] };
  const rows = [materialRow(), good, stale, missing, rowFor(P1, '重复段落要求')];
  const before = JSON.stringify(rows);
  const sources = sourcesFor(rows, [P1, P2]);

  assert.deepEqual([...sources.sourcesByEvIndex.keys()], [1, 4]);
  assert.equal(sources.sourcesByEvIndex.get(1).zid, P1.zid);
  assert.equal(sources.sourcesByEvIndex.get(1).hash, E.paraFingerprint(P1.text));
  assert.deepEqual(sources.sourceParas.map(p => p.zid), [P1.zid]);
  assert.deepEqual(sources.omitted, [
    { evIndex: 0, reason: 'material-only' },
    { evIndex: 2, reason: 'stale' },
    { evIndex: 3, reason: 'missing' }
  ]);
  assert.equal(JSON.stringify(rows), before);
  assert.ok(!JSON.stringify(sources.sourceParas).includes('FAKE_QUOTE'));
});

test('S1 resolve selects first usable para and limits actual sent text', () => {
  const long = { zid: 'zc3333333', text: '甲'.repeat(600) + '只有截断后才出现的内容' };
  const empty = { zid: 'zd4444444', text: '' };
  const first = rowFor(P1);
  const longRef = rowFor(long).refs[0];
  const emptyRef = {
    refId: 'b1r9', type: 'para', zid: empty.zid, id: null,
    hash: E.paraFingerprint(empty.text), title: '', quote: ''
  };
  const rows = [
    { ...first, refs: [{ ...first.refs[0], hash: '0'.repeat(40) }, longRef] },
    { id: 'empty', req: '空段落', refs: [emptyRef] }
  ];
  const sources = sourcesFor(rows, [P1, long, empty]);

  assert.equal(sources.sourcesByEvIndex.get(0).zid, long.zid);
  assert.equal(sources.sourceParas[0].text.length, 600);
  assert.equal(sources.sourceParas[0].hash, E.paraFingerprint(long.text));
  assert.ok(!sources.sourceParas[0].text.includes('只有截断后'));
  assert.deepEqual(sources.omitted, [{ evIndex: 1, reason: 'empty' }]);
});
~~~

- [ ] **Step 2（2 分钟）：单独运行 S1，保留红灯结果。**

~~~sh
cd /Users/xxxly/resume
node --test --test-name-pattern='S1 resolve' test-fixtures/reliability/test-sources.mjs
~~~

预期：exit 1，首个失败为 `E.resolveInterviewSources is not a function`。不得通过改 fixture 为顶层 zid 假结构来让测试转绿。

- [ ] **Step 3（4 分钟）：加入 resolver 与 sources 形状检查。**

~~~js
export function resolveInterviewSources({ evidence = [], paras = [] } = {}) {
  const rows = Array.isArray(evidence) ? evidence : [];
  const currentParas = Array.isArray(paras) ? paras : [];
  const byZid = new Map(currentParas.filter(p => p && typeof p.zid === 'string')
    .map(p => [p.zid, p]));
  const sourcesByEvIndex = new Map();
  const unique = new Map();
  const omitted = [];

  rows.forEach((entry, evIndex) => {
    const refs = entry && Array.isArray(entry.refs) ? entry.refs : [];
    const paraRefs = refs.filter(r => r && r.type === 'para');
    let chosen = null;
    let sawFreshEmpty = false;

    for (const ref of paraRefs) {
      if (!refFresh(ref, { paras: currentParas })) continue;
      const para = byZid.get(ref.zid);
      const rawText = para && typeof para.text === 'string' ? para.text : '';
      if (!rawText.trim()) { sawFreshEmpty = true; continue; }
      chosen = { zid: para.zid, hash: paraFingerprint(rawText), text: rawText.slice(0, 600) };
      break;
    }
    if (!chosen) {
      const reason = sawFreshEmpty ? 'empty'
        : paraRefs.length ? 'stale'
        : refs.some(r => r && r.type === 'mat') ? 'material-only' : 'missing';
      omitted.push({ evIndex, reason });
      return;
    }
    if (!unique.has(chosen.zid)) unique.set(chosen.zid, chosen);
    sourcesByEvIndex.set(evIndex, unique.get(chosen.zid));
  });
  return { sourcesByEvIndex, sourceParas: [...unique.values()], omitted };
}

function validInterviewSources(sources) {
  if (!sources || !(sources.sourcesByEvIndex instanceof Map)
    || !Array.isArray(sources.sourceParas) || !Array.isArray(sources.omitted)) return false;
  const ok = p => p && typeof p.zid === 'string' && typeof p.hash === 'string'
    && typeof p.text === 'string' && p.text.length <= 600;
  if (!sources.sourceParas.every(ok)) return false;
  const catalog = new Map(sources.sourceParas.map(p => [p.zid, p]));
  for (const [index, p] of sources.sourcesByEvIndex) {
    if (!Number.isInteger(index) || index < 0 || !ok(p)) return false;
    const known = catalog.get(p.zid);
    if (!known || known.hash !== p.hash || known.text !== p.text) return false;
  }
  return true;
}
~~~

本函数不接受 mats，不调用模型，不依赖 ref.quote；用完整段落 hash 判来源新鲜度，text 只保存实际发送片段。

- [ ] **Step 4（2 分钟）：重跑 Step 2，预期两个 S1 用例通过、exit 0。**
- [ ] **Step 5（2 分钟）：只提交本任务文件。**

~~~sh
git add evidence.mjs test-fixtures/reliability/test-sources.mjs
git commit -m "fix: resolve interview sources from fresh paragraph refs"
~~~

回退边界：单独 revert 此提交会撤销新增导出；若 S2 已依赖它，必须先回退 S2 或整体回退来源包。不得删除真实 evidence 数据来消除失效标记。

## Task SRC-02（S2）：prompt/parser 共用 sources，核验 generic 引用与数字归属

**Files**

- Modify: /Users/xxxly/resume/evidence.mjs，`buildInterviewPrompt`、`parseInterview`；删除不再调用的 `evAnchorZid`。
- Test: /Users/xxxly/resume/test-fixtures/reliability/test-sources.mjs。
- Shared integration: /Users/xxxly/resume/server.mjs `runGenTask(kind==='interview')`。
- Shared migration: /Users/xxxly/resume/test-structure.sh 的 S4B-3/4/5/13。

- [ ] **Step 1（3 分钟）：追加 prompt 与显式依赖反例。**

~~~js
test('S2 prompt uses only sources and preserves evIndex after omission', () => {
  const rows = [materialRow(), rowFor(P1), rowFor(P2)];
  const sources = sourcesFor(rows, [P1, P2]);
  const prompt = E.buildInterviewPrompt({
    company: '合成公司', role: '后端', jd: '要求存储经验', evidence: rows, sources
  });
  assert.ok(prompt.user.includes('evIndex=1'));
  assert.ok(prompt.user.includes(P1.text));
  assert.ok(prompt.user.includes(P2.text));
  assert.ok(!prompt.user.includes('FAKE_QUOTE_DO_NOT_FORWARD'));
  assert.ok(!prompt.user.includes('伪造了战略并购经历'));
  assert.ok(prompt.sys.includes('sourceZid'));
  assert.throws(() => E.buildInterviewPrompt({ evidence: rows }), TypeError);
  assert.equal(E.parseInterview('{"generic":[]}', { evidence: rows, paras: [P1] }), null);
});

test('S2 generic quote requires matching provided sourceZid', () => {
  const rows = [rowFor(P1), rowFor(P2)];
  const point = { text: '我负责存储层改造', quote: '负责存储层改造', sourceZid: P1.zid };
  const run = p => interview({ generic: [{ question: '自我介绍', answerPoints: [p] }] }, rows, [P1, P2]);
  const valid = run(point).generic[0].answerPoints[0];
  assert.deepEqual(valid.source, { type: 'para', zid: P1.zid, hash: E.paraFingerprint(P1.text) });
  assert.equal(valid.anchored, true);

  for (const invalid of [
    { ...point, sourceZid: undefined },
    { ...point, sourceZid: 'zffffffff' },
    { ...point, sourceZid: P2.zid },
    { ...point, quote: '完全不存在的原文证据' },
    { ...point, quote: '负责' }
  ]) {
    const result = run(invalid);
    assert.equal(result.generic[0].answerPoints.length, 0);
    assert.equal(result.dropped, 1);
  }
  const none = run({ text: '先介绍与岗位相关的经历', quote: '', sourceZid: P1.zid })
    .generic[0].answerPoints[0];
  assert.deepEqual(none.source, { type: 'none' });
  assert.equal(none.anchored, false);
});
~~~

- [ ] **Step 2（3 分钟）：追加截断、数字归属与仅素材场景。**

~~~js
test('S2 parser rejects beyond sent fragment and keeps original indexes', () => {
  const long = { zid: 'zc3333333', text: '甲'.repeat(600) + '真实但从未发给模型的引文' };
  const rows = [materialRow(), rowFor(P1), rowFor(long)];
  const result = interview({
    chains: [
      { evIndex: 0, question: '素材问题', answerPoints: [{ text: '不要接受', quote: '伪造了战略并购经历' }] },
      { evIndex: 1, question: '负责什么', answerPoints: [{ text: '我负责存储层改造', quote: '负责存储层改造' }] },
      { evIndex: 2, question: '截断后有什么', answerPoints: [{ text: '不要接受', quote: '真实但从未发给模型的引文' }] }
    ]
  }, rows, [P1, long]);
  assert.deepEqual(result.chains.map(c => c.evIndex), [1, 2]);
  assert.equal(result.chains[1].answerPoints.length, 0);
  assert.equal(result.chains[0].answerPoints[0].source.zid, P1.zid);
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.omitted, [{ evIndex: 0, reason: 'material-only' }]);

  const onlyMat = interview({
    generic: [{ question: '自我介绍', answerPoints: [{ text: '先说明与岗位相关的经历', quote: '' }] }]
  }, [materialRow()], []);
  assert.equal(onlyMat.generic[0].answerPoints.length, 1);
  assert.deepEqual(onlyMat.generic[0].answerPoints[0].source, { type: 'none' });
  const inventedNumber = interview({
    generic: [{ question: '自我介绍', answerPoints: [{ text: '我带了 50 人团队', quote: '' }] }]
  }, [materialRow()], []);
  assert.equal(inventedNumber.generic[0].answerPoints[0].guard, 'conflict');
});

test('S2 quoted numeric claims use their own source only', () => {
  const rows = [rowFor(P1), rowFor(P2)];
  const result = interview({
    generic: [{ question: '自我介绍', answerPoints: [
      { text: '我负责存储层改造', quote: '负责存储层改造', sourceZid: P1.zid },
      { text: '我把 QPS 提升到 100000', quote: '负责存储层改造', sourceZid: P1.zid },
      { text: '说明自己的贡献边界', quote: '' }
    ] }]
  }, rows, [P1, P2]);
  const points = result.generic[0].answerPoints;
  assert.deepEqual(points.map(p => p.guard), ['normal', 'conflict', 'normal']);
  assert.equal(points[0].anchored, true);
  assert.equal(points[2].anchored, false);
});
~~~

- [ ] **Step 3（2 分钟）：运行 S2，确认旧 prompt 使用展示 quote、旧 generic 不验 zid 等反例变红。**

~~~sh
node --test --test-name-pattern='S2 ' test-fixtures/reliability/test-sources.mjs
~~~

预期：exit 1；旧函数缺 sources 依赖检查、generic source 字段及截断约束，至少一个行为断言失败。保存实际首条错误，不伪造特定失败消息。

- [ ] **Step 4（4 分钟）：完整替换 buildInterviewPrompt。**

~~~js
export function buildInterviewPrompt({ jd = '', company = '', role = '', evidence = [], sources }) {
  if (!validInterviewSources(sources)) throw new TypeError('interview sources required');
  const rows = Array.isArray(evidence) ? evidence : [];
  const requirements = [...sources.sourcesByEvIndex.entries()].map(([i, source]) =>
    '【要求 ' + (i + 1) + '，evIndex=' + i + '】' + String((rows[i] && rows[i].req) || '')
    + '\n【来源】' + source.zid).join('\n\n');
  const fragments = sources.sourceParas.map(p =>
    '【简历片段 sourceZid=' + p.zid + '】\n' + p.text).join('\n\n');
  const sys = '你是资深技术面试官，为真实岗位预判追问。只输出 JSON。\n'
    + '1. 只依据提供的简历片段，不得虚构经历、职级、项目或数字；JD 仅为岗位要求。\n'
    + '2. chains 的 evIndex 只可引用已提供的要求，answerPoints.quote 必须是对应来源片段中至少 6 字的子串。\n'
    + '3. generic 的非空 quote 必须同时给 sourceZid，且 quote 是该来源片段的至少 6 字子串。\n'
    + '4. generic 的 quote 为空时只给作答结构思路，不代写未经核验的个人经历，sourceZid 留空。\n'
    + '5. followUp 是再深一层的追问；answerPoints 只给要点，不写背诵稿。\n';
  const user = '【目标公司】' + company + '\n【目标岗位】' + role + '\n【JD】\n'
    + (jd || '（未提供 JD）') + '\n\n【可追问要求】\n'
    + (requirements || '（没有可用简历证据，chains 必须为空）')
    + '\n\n【本次实际提供的简历片段】\n'
    + (fragments || '（没有简历片段，仅可给无引文的 generic 作答思路）')
    + '\n\n输出格式：{"chains":[{"evIndex":0,"question":"问题","followUp":"追问",'
    + '"answerPoints":[{"text":"要点","quote":"原文子串"}]}],'
    + '"generic":[{"question":"自我介绍","answerPoints":'
    + '[{"text":"要点或作答思路","quote":"","sourceZid":""}]}]}\n'
    + 'chains 最多 ' + Math.max(1, rows.length) + ' 条，generic 最多 4 条。';
  return { sys, user };
}
~~~

- [ ] **Step 5（5 分钟）：完整替换 parseInterview；不从 ctx.paras 补来源。**

~~~js
export function parseInterview(raw, ctx = {}) {
  const sources = ctx.sources;
  if (!validInterviewSources(sources)) return null;
  let data;
  try { data = JSON.parse(stripFence(raw)); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];
  const byZid = new Map(sources.sourceParas.map(p => [p.zid, p]));
  const wholeProvided = sources.sourceParas.map(p => p.text).join('\n').trim();
  let dropped = 0;

  const makeChain = (c, fixedSource, evIndex) => {
    if (!c || typeof c !== 'object') return null;
    const question = typeof c.question === 'string' ? c.question.trim() : '';
    if (!question) return null;
    const points = [];
    for (const rawPoint of Array.isArray(c.answerPoints) ? c.answerPoints : []) {
      if (!rawPoint || typeof rawPoint !== 'object') continue;
      const text = typeof rawPoint.text === 'string' ? rawPoint.text.trim() : '';
      if (!text) continue;
      const quote = typeof rawPoint.quote === 'string' ? rawPoint.quote.trim() : '';
      const cited = fixedSource || (quote && typeof rawPoint.sourceZid === 'string'
        ? byZid.get(rawPoint.sourceZid) : null);
      if (fixedSource || quote) {
        if (!cited || !quote || [...normSpace(quote)].length < 6
          || !normSpace(cited.text).includes(normSpace(quote))) {
          dropped++;
          continue;
        }
      }
      const source = cited && quote
        ? { type: 'para', zid: cited.zid, hash: cited.hash } : { type: 'none' };
      const point = { text, quote, source, anchored: source.type === 'para', guard: 'normal' };
      const base = point.anchored ? cited.text : wholeProvided;
      const guard = factGuard({ kind: 'replace', before: base, after: text }, { checkLoss: false });
      if (guard.level === 'conflict') point.guard = 'conflict';
      points.push(point);
    }
    return {
      evIndex,
      zid: fixedSource ? fixedSource.zid : '',
      question,
      followUp: typeof c.followUp === 'string' ? c.followUp.trim() : '',
      answerPoints: points,
      empty: points.length === 0
    };
  };

  const chains = [];
  for (const c of (Array.isArray(data.chains) ? data.chains : []).slice(0, Math.max(1, evidence.length))) {
    const i = c && c.evIndex;
    const source = Number.isInteger(i) && i >= 0 && i < evidence.length
      ? sources.sourcesByEvIndex.get(i) : null;
    if (!source) { dropped++; continue; }
    const chain = makeChain(c, source, i);
    if (chain) chains.push(chain);
  }
  const generic = [];
  for (const c of (Array.isArray(data.generic) ? data.generic : []).slice(0, 4)) {
    const chain = makeChain(c, null, -1);
    if (chain) generic.push(chain);
  }
  return { chains, generic, dropped, omitted: sources.omitted.map(entry => ({ ...entry })) };
}
~~~

保留现有 “useful 要看要点而非空链数量” 的 runner 门控；不要将只有空卡片的输出记成功。quote 子串验证仍不等于 text 语义真实性，数字告警与 sourceState 分开。

- [ ] **Step 6（2 分钟）：运行 S1/S2，预期所有选中用例通过、exit 0。**

~~~sh
node --test --test-name-pattern='S[12] ' test-fixtures/reliability/test-sources.mjs
~~~

- [ ] **Step 7（3 分钟，集成 owner）：runGenTask 显式只构造一次 sources。**

在 server 现有 evidence import 中增加 `resolveInterviewSources`；在 interview 分支现有 paras/ev 之后用下述完整调用替换旧 prompt/parser 调用，hash、批次和 useful 门控保持由各自 owner 负责：

~~~js
const sources = resolveInterviewSources({ evidence: ev, paras });
const p = buildInterviewPrompt({
  jd: m0.jd || '',
  company: m0.company || '',
  role: m0.role || '',
  evidence: ev,
  sources
});
const raw = await chat(root, p.sys, p.user);
const gen = (Number(m0.job.interviewGen) || 0) + 1;
const iv = parseInterview(raw, { evidence: ev, sources });
~~~

chat 的资源凭证参数由资源包集成 owner 添加；不得复制旧 chat 调用覆盖资源包。resolver/prompt/parser 本身不接凭证。

- [ ] **Step 8（4 分钟，验证 owner）：明确迁移旧 S4B 夹具。**

四个 heredoc 是独立模块作用域，分别修改 import，并分别加入完整 wrapper；wrapper 是测试适配，不加入生产模块。

S4B-3：

~~~js
import { parseInterview as parseInterviewCore, parseEvidence, resolveInterviewSources } from './evidence.mjs';
const parseInterview = (raw, ctx = {}) => {
  const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];
  const paras = Array.isArray(ctx.paras) ? ctx.paras : [];
  return parseInterviewCore(raw, {
    evidence,
    sources: resolveInterviewSources({ evidence, paras })
  });
};
~~~

S4B-4：

~~~js
import { parseEvidence, parseInterview as parseInterviewCore, resolveInterviewSources } from './evidence.mjs';
const parseInterview = (raw, ctx = {}) => {
  const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];
  const paras = Array.isArray(ctx.paras) ? ctx.paras : [];
  return parseInterviewCore(raw, {
    evidence,
    sources: resolveInterviewSources({ evidence, paras })
  });
};
const bp = (await import('./evidence.mjs')).buildInterviewPrompt({
  company: 'A', role: '后端', jd: 'J', evidence: ev,
  sources: resolveInterviewSources({ evidence: ev, paras })
});
~~~

S4B-4 的 bp 行应替换原声明，不能在同作用域保留两个 `const bp`。保留该块原 fs import、assert、ev、paras 与所有已有行为断言。

S4B-5：

~~~js
import { parseEvidence, parseInterview as parseInterviewCore, resolveInterviewSources } from './evidence.mjs';
const parseInterview = (raw, ctx = {}) => {
  const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];
  const paras = Array.isArray(ctx.paras) ? ctx.paras : [];
  return parseInterviewCore(raw, {
    evidence,
    sources: resolveInterviewSources({ evidence, paras })
  });
};
~~~

S4B-13：

~~~js
import { parseInterview as parseInterviewCore, parseEvidence, resolveInterviewSources } from './evidence.mjs';
const parseInterview = (raw, ctx = {}) => {
  const evidence = Array.isArray(ctx.evidence) ? ctx.evidence : [];
  const paras = Array.isArray(ctx.paras) ? ctx.paras : [];
  return parseInterviewCore(raw, {
    evidence,
    sources: resolveInterviewSources({ evidence, paras })
  });
};
~~~

不要通过只传 `sources:{...空集合}` 让旧锚定断言变为空结果；每个 wrapper 必须使用其真实 paras/evidence。

- [ ] **Step 9（2 分钟）：提交来源核心；共享接线由各 owner 单独提交。**

~~~sh
git add evidence.mjs test-fixtures/reliability/test-sources.mjs
git commit -m "fix: verify interview quotes against the sent source catalog"
~~~

共享提交建议：
- 服务端：`fix: pass one source catalog through interview generation`。
- 验证：`test: migrate interview fixtures to explicit source catalogs`。

S2 回退时把 prompt/parser 与服务端调用及 wrapper 放在同一回退批次，避免缺 sources 的生产错误；保持 S1 纯新增导出无害可留。

## Task SRC-03（S3·视图）：读取时来源视图，保留原始数据

**Files**

- Modify: /Users/xxxly/resume/evidence.mjs，面试段增加 `interviewSourceView` 与 `evidenceSourceView`。
- Test: /Users/xxxly/resume/test-fixtures/reliability/test-sources.mjs。
- Shared integration: /Users/xxxly/resume/server.mjs `jobViewLive`。

- [ ] **Step 1（3 分钟）：追加 interview 旧数据与来源后变更用例。**

~~~js
test('S3 interview view is pure and separates fresh none legacy invalid stale', () => {
  const raw = deepFreeze({
    chains: [{ question: '测试', answerPoints: [
      { text: '有效要点', quote: '负责存储层改造', anchored: false,
        source: { type: 'para', zid: P1.zid, hash: E.paraFingerprint(P1.text) } },
      { text: '结构思路', quote: '', anchored: true, source: { type: 'none' } },
      { text: '旧版要点', quote: '负责存储层改造', anchored: true },
      { text: '坏来源', quote: '负责存储层改造', source: { type: 'para', zid: 7 } },
      { text: '旧段落', quote: '负责存储层改造',
        source: { type: 'para', zid: P1.zid, hash: '0'.repeat(40) } }
    ] }],
    generic: []
  });
  const before = JSON.stringify(raw);
  const view = E.interviewSourceView(raw, { paras: [P1] });
  const points = view.chains[0].answerPoints;
  assert.deepEqual(points.map(p => p.sourceState), ['fresh', 'none', 'legacy', 'invalid', 'stale']);
  assert.deepEqual(points.map(p => p.anchored), [true, false, false, false, false]);
  assert.equal(points[0].quoteForDisplay, '负责存储层改造');
  assert.equal(points[0].sourceZid, P1.zid);
  assert.ok(points.slice(1).every(p => p.quoteForDisplay === '' && p.sourceZid === ''));
  assert.equal(JSON.stringify(raw), before);

  const changed = E.interviewSourceView(raw, { paras: [{ ...P1, text: '当前正文已经变化' }] });
  assert.equal(changed.chains[0].answerPoints[0].sourceState, 'stale');
  const deleted = E.interviewSourceView(raw, { paras: [] });
  assert.equal(deleted.chains[0].answerPoints[0].sourceState, 'stale');
});
~~~

- [ ] **Step 2（3 分钟）：追加 evidence 真实 facts 与伪 quote 用例。**

~~~js
test('S3 evidence view never replaces identity or empty facts with model quote', () => {
  const paraRef = deepFreeze(rowFor(P1).refs[0]);
  const before = JSON.stringify(paraRef);
  const paraView = E.evidenceSourceView(paraRef, { paras: [P1], mats: [] });
  assert.equal(paraView.sourceState, 'fresh');
  assert.equal(paraView.quoteForDisplay, '');
  assert.equal(paraView.sourceZid, P1.zid);
  assert.equal(JSON.stringify(paraRef), before);
  assert.equal(paraRef.zid, P1.zid);

  const matRef = materialRow().refs[0];
  const matView = E.evidenceSourceView(matRef, { paras: [], mats: [MAT] });
  assert.equal(matView.sourceTitle, MAT.title);
  assert.ok(matView.sourceText.includes('贡献：主导订单系统拆分'));
  assert.ok(!matView.sourceText.includes('战略并购'));
  const empty = { ...MAT, facts: {} };
  const emptyRef = { ...matRef, hash: E.contentFingerprint({}) };
  const emptyView = E.evidenceSourceView(emptyRef, { paras: [], mats: [empty] });
  assert.equal(emptyView.sourceState, 'unavailable');
  assert.equal(emptyView.sourceText, '');
  assert.equal(emptyView.quoteForDisplay, '');
  const outdated = E.evidenceSourceView(matRef, { paras: [], mats: [{ ...MAT, factStatus: 'outdated' }] });
  assert.equal(outdated.sourceState, 'stale');
  assert.equal(outdated.sourceText, '');
});
~~~

- [ ] **Step 3（2 分钟）：运行 S3 取得未定义新视图函数的失败。**

~~~sh
node --test --test-name-pattern='S3 ' test-fixtures/reliability/test-sources.mjs
~~~

预期 exit 1，函数未定义；这一步不启动服务，不依赖私有文件。

- [ ] **Step 4（4 分钟）：加入 interviewSourceView。**

~~~js
export function interviewSourceView(interview, { paras = [] } = {}) {
  const original = interview && typeof interview === 'object' && !Array.isArray(interview) ? interview : {};
  const byZid = new Map((Array.isArray(paras) ? paras : []).filter(p => p && p.zid)
    .map(p => [p.zid, p]));
  const pointView = value => {
    const p = value && typeof value === 'object' ? value : {};
    const source = p.source;
    let sourceState = 'invalid';
    let quoteForDisplay = '';
    let sourceZid = '';

    if (!Object.prototype.hasOwnProperty.call(p, 'source')) sourceState = 'legacy';
    else if (source && source.type === 'none') sourceState = 'none';
    else if (source && source.type === 'para' && typeof source.zid === 'string'
      && typeof source.hash === 'string' && /^[0-9a-f]{40}$/.test(source.hash)) {
      const para = byZid.get(source.zid);
      if (!para || paraFingerprint(para.text) !== source.hash) sourceState = 'stale';
      else {
        const quote = typeof p.quote === 'string' ? p.quote.trim() : '';
        if (quote && [...normSpace(quote)].length >= 6
          && normSpace(String(para.text).slice(0, 600)).includes(normSpace(quote))) {
          sourceState = 'fresh';
          quoteForDisplay = quote;
          sourceZid = source.zid;
        }
      }
    }
    return { ...p, sourceState, quoteForDisplay, sourceZid, anchored: sourceState === 'fresh' };
  };
  const chainView = value => {
    const c = value && typeof value === 'object' ? value : {};
    return { ...c, answerPoints: (Array.isArray(c.answerPoints) ? c.answerPoints : []).map(pointView) };
  };
  return {
    ...original,
    chains: (Array.isArray(original.chains) ? original.chains : []).map(chainView),
    generic: (Array.isArray(original.generic) ? original.generic : []).map(chainView)
  };
}
~~~

- [ ] **Step 5（4 分钟）：加入 evidenceSourceView。**

~~~js
export function evidenceSourceView(ref, { paras = [], mats = [] } = {}) {
  const empty = {
    sourceState: 'unavailable', sourceTitle: '', sourceText: '',
    quoteForDisplay: '', sourceZid: ''
  };
  if (!ref || typeof ref !== 'object') return empty;
  if (!refFresh(ref, { paras, mats })) return { ...empty, sourceState: 'stale' };
  if (ref.type === 'para') {
    const para = paras.find(p => p && p.zid === ref.zid);
    const quote = typeof ref.quote === 'string' ? ref.quote.trim() : '';
    return {
      ...empty, sourceState: 'fresh', sourceZid: ref.zid,
      quoteForDisplay: quote && normSpace(para.text).includes(normSpace(quote)) ? quote : ''
    };
  }
  if (ref.type === 'mat') {
    const mat = mats.find(m => m && m.id === ref.id);
    const facts = mat && mat.facts && typeof mat.facts === 'object' ? mat.facts : {};
    const sourceText = Object.keys(FACT_LABELS)
      .filter(key => typeof facts[key] === 'string' && facts[key].trim())
      .map(key => FACT_LABELS[key] + '：' + facts[key].trim()).join(' · ');
    return {
      ...empty,
      sourceState: sourceText ? 'fresh' : 'unavailable',
      sourceTitle: (mat && typeof mat.title === 'string' && mat.title) || ref.id || '',
      sourceText
    };
  }
  return empty;
}
~~~

说明：有效 para ref 配伪 quote 只清展示引用，不删除身份；mat facts 为空不 fallback 到 r.quote、brief、technical。mat 的 sourceText 不是模型摘要。

- [ ] **Step 6（2 分钟）：运行全部纯函数测试，预期当前已定义用例全部通过。**

~~~sh
node --test test-fixtures/reliability/test-sources.mjs
~~~

- [ ] **Step 7（3 分钟，集成 owner）：jobViewLive 只在响应上叠加视图。**

server evidence import 增加 `interviewSourceView`、`evidenceSourceView`。在现有 `out.evidence` 组装与 interviewStale 完成处加入下述等价片段，保持 reviewConsistency/exportChecks 的现有计算位置：

~~~js
out.evidence = (out.evidence || []).map(entry => {
  const refs = (Array.isArray(entry.refs) ? entry.refs : []).map(ref => ({
    ...ref,
    fresh: refFresh(ref, { mats, paras }),
    ...evidenceSourceView(ref, { mats, paras })
  }));
  return { ...entry, refs, stale: refs.length > 0 && refs.every(ref => !ref.fresh) };
});
out.interview = interviewSourceView(out.interview, { paras });
~~~

不得调用 updateMeta/saveMeta 写回这些派生字段。正文不可读的早返回会缺少视图字段，客户端必须按未复核显示，不能反向信任原 anchored。

- [ ] **Step 8（2 分钟）：提交纯函数视图。**

~~~sh
git add evidence.mjs test-fixtures/reliability/test-sources.mjs
git commit -m "fix: derive source display states without rewriting stored results"
~~~

回退：先回退 UI 对新字段的强依赖，再回退视图接线；新持久化 source 字段保留，不批量删改。旧客户端不会得到更高可信声明。

## Task SRC-04（S3·UI）：来源标签、真实引文与回跳 UI

**Files**

- Modify: /Users/xxxly/resume/job-panel.js，`renderEvidence` 的 refs.forEach 与 `renderInterview` 的 answerPoints/card。
- Shared Test: /Users/xxxly/resume/test-editor.mjs，来源夹具由验证 owner 接入隔离服务。

- [ ] **Step 1（3 分钟，验证 owner）：给共享浏览器套件加入可执行页面断言函数。**

将以下函数放进测试模块，由共享 harness 在虚拟岗位文档页面调用；参数 page 为真实 Playwright Page，payload 来自该隔离页的 /job/changes 响应。route 只隔离 UI 输入，不作为服务端来源计算的验证。

~~~js
async function assertSourcePanelUi(page, base, docId, payload) {
  const { default: assert } = await import('node:assert/strict');
  const served = structuredClone(payload);
  served.ok = true;
  served.job.evidence = [{
    id: 'source-ui-e1', req: '来源展示测试', status: 'covered', stale: false,
    refs: [{
      refId: 'b1r1', type: 'para', zid: 'za1111111', fresh: true,
      sourceState: 'fresh', sourceZid: 'za1111111', quoteForDisplay: '负责存储层改造'
    }]
  }, {
    id: 'source-ui-e2', req: '空素材事实', status: 'sourced', stale: false,
    refs: [{
      refId: 'b1r2', type: 'mat', id: 'm-empty', fresh: true,
      sourceState: 'unavailable', sourceTitle: '空事实素材', sourceText: '',
      quote: 'DO_NOT_RENDER_FAKE_QUOTE', quoteForDisplay: '', sourceZid: ''
    }]
  }];
  served.job.genTasks = {
    ...(served.job.genTasks || {}),
    interview: { taskId: 't-ui-source', status: 'done', error: null }
  };
  served.job.interviewStale = false;
  served.job.interview = {
    chains: [], omitted: [{ evIndex: 1, reason: 'material-only' }],
    generic: [{
      question: '来源分级测试',
      answerPoints: [
        { text: '有效引文要点', sourceState: 'fresh', sourceZid: 'za1111111',
          quoteForDisplay: '负责存储层改造', guard: 'normal' },
        { text: '无引文思路', sourceState: 'none', sourceZid: '', quoteForDisplay: '', guard: 'normal' },
        { text: '旧版要点', anchored: true, sourceState: 'legacy', sourceZid: '', quoteForDisplay: '' },
        { text: '失效要点', sourceState: 'stale', sourceZid: '', quoteForDisplay: '' }
      ]
    }]
  };
  await page.route('**/job/changes?*', async route => {
    const requested = new URL(route.request().url());
    if (requested.searchParams.get('id') !== docId) return route.continue();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(served) });
  });
  await page.goto(base + '/edit?id=' + encodeURIComponent(docId), { waitUntil: 'networkidle' });
  await page.locator('#ed-rtabs button[data-pane="review"]').click();
  await page.locator('.jp-iv').evaluate(el => { el.open = true; });
  const interviewBox = page.locator('.jp-iv');
  assert.ok((await interviewBox.textContent()).includes('作答思路，无简历引文'));
  assert.ok((await interviewBox.textContent()).includes('旧版要点，来源未复核'));
  assert.ok((await interviewBox.textContent()).includes('来源已变化，待核对'));
  assert.ok((await interviewBox.textContent()).includes('仅素材'));
  assert.equal(await interviewBox.getByRole('button', { name: '回跳', exact: true }).count(), 1);
  assert.ok(!(await page.locator('#ed-pane-review').textContent()).includes('DO_NOT_RENDER_FAKE_QUOTE'));
  assert.ok((await page.locator('#ed-pane-review').textContent()).includes('当前没有可展示的已确认事实'));
}
~~~

共享 harness 须用含 `data-zid="za1111111"` 的合成正文；实际点击唯一回跳按钮后断言该段定位有效、无 pageerror。不要靠测试侧重绑业务回跳函数。服务端来源变化覆盖见后文集成矩阵。

- [ ] **Step 2（2 分钟）：在尚未修改 UI 时跑该块，预期空事实伪 quote 或标签/回跳数断言失败。**

共享命令：

~~~sh
node test-editor.mjs "$B" "$DOCID" "$RESUME_ROOT"
~~~

此命令在 test.sh 已创建的隔离 harness 内执行；B、DOCID、RESUME_ROOT 取该 harness 的隔离服务 URL、虚拟文档 ID、TEST_DIR，不从 launchd 真服务取值。test-editor 的接口是三个位置参数，不能只设置环境变量。预期 exit 1，保留该来源 UI 的具体失败行。不得因浏览器不存在报告本条通过。

- [ ] **Step 3（4 分钟）：替换证据 refs.forEach 内的展示主体。**

以下片段使用现有 `div`、`refs`、`esc`、`locateZid`；替换原 matRefText/r.quote fallback，不保留重复旧分支：

~~~js
refs.forEach(function (r) {
  var line = document.createElement('div');
  line.className = 'jp-ref';
  if (r.type === 'mat') {
    line.innerHTML = '· 素材：<b>' + esc(r.sourceTitle || r.id || '来源未复核') + '</b>';
    var fact = document.createElement('span');
    fact.textContent = r.sourceText || '当前没有可展示的已确认事实';
    line.appendChild(fact);
  } else {
    line.textContent = '· 正文段落' + (r.quoteForDisplay ? '「' + r.quoteForDisplay + '」' : '');
    if (r.sourceState === 'fresh' && r.sourceZid) {
      var loc = document.createElement('button');
      loc.type = 'button';
      loc.className = 'jp-refbtn';
      loc.textContent = '定位';
      loc.addEventListener('click', function () { locateZid(r.sourceZid); });
      line.appendChild(loc);
    }
  }
  if (r.fresh === false || r.sourceState === 'stale') {
    var changed = document.createElement('span');
    changed.className = 'jp-st conflict';
    changed.textContent = '来源已变化';
    line.appendChild(changed);
  } else if (!r.sourceState) {
    var legacy = document.createElement('span');
    legacy.className = 'jp-meta';
    legacy.textContent = '来源未复核';
    line.appendChild(legacy);
  }
  div.appendChild(line);
});
~~~

`matRefText` 若已全仓零调用，再删除这一私有 helper；不要因移除它更改其它素材插入功能。

- [ ] **Step 4（4 分钟）：替换面试要点循环，不信任旧 anchored。**

~~~js
c.answerPoints.forEach(function (p) {
  var li = document.createElement('li');
  li.textContent = p.text || '';
  var state = p.sourceState || 'legacy';
  var labels = {
    fresh: '附简历引文',
    none: '作答思路，无简历引文',
    legacy: '旧版要点，来源未复核',
    stale: '来源已变化，待核对',
    invalid: '来源不可用，待核对'
  };
  var badge = document.createElement('span');
  badge.className = 'jp-meta';
  badge.textContent = '（' + (labels[state] || labels.invalid) + '）';
  li.appendChild(badge);
  if (state === 'fresh' && p.quoteForDisplay) {
    var quote = document.createElement('div');
    quote.className = 'jp-meta';
    quote.textContent = '「' + p.quoteForDisplay + '」';
    li.appendChild(quote);
  }
  if (p.guard === 'conflict') {
    var warning = document.createElement('span');
    warning.className = 'jp-reason';
    warning.textContent = ' 出现原文没有的数字';
    li.appendChild(warning);
  }
  if (state === 'fresh' && p.sourceZid) {
    var jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'jp-refbtn';
    jump.textContent = '回跳';
    jump.addEventListener('click', function () { locateZid(p.sourceZid); });
    li.appendChild(jump);
  }
  ul.appendChild(li);
});
~~~

- [ ] **Step 5（3 分钟）：在面试 done 分支的卡片前显示被省略证据行。**

~~~js
var omitted = Array.isArray(iv.omitted) ? iv.omitted : [];
if (omitted.length) {
  var omittedLabels = {
    'material-only': '仅素材',
    stale: '来源已变化',
    missing: '缺少来源',
    empty: '来源为空'
  };
  var counts = {};
  omitted.forEach(function (entry) {
    var key = entry && entry.reason;
    if (omittedLabels[key]) counts[key] = (counts[key] || 0) + 1;
  });
  var omittedNote = document.createElement('div');
  omittedNote.className = 'jp-meta';
  omittedNote.textContent = '已跳过 ' + omitted.length + ' 条证据追问：'
    + Object.keys(counts).map(function (key) {
      return omittedLabels[key] + ' ' + counts[key] + ' 条';
    }).join('、');
  det.appendChild(omittedNote);
}
~~~

旧 interview 没 omitted 不显示此行。没有可用 para 时不新增导出门禁，不让空结果通过 runner 的 useful 检查。

- [ ] **Step 6（2 分钟）：运行纯函数与共享浏览器来源块。**

~~~sh
node --test test-fixtures/reliability/test-sources.mjs
node test-editor.mjs "$B" "$DOCID" "$RESUME_ROOT"
~~~

预期：纯函数 exit 0；浏览器来源标签/回跳/空 facts 反例通过，既有证据表计数与 note 流程保持通过。若主测试尚有共享包未集成的失败，记录为未完成，不提交“全绿”结论。

- [ ] **Step 7（2 分钟）：只提交自身 UI；共享测试由验证 owner 提交。**

~~~sh
git add job-panel.js
git commit -m "fix: distinguish source-backed interview points from unverified guidance"
~~~

回退：可单独 revert UI 提交，来源校验仍有效；但回退后的 UI 无法完整传达来源差异，因此不得将该组合宣布为来源包已交付。

## Task SRC-05（E1）：评估输入统一为可见正文，核验每条显示引文

**Files**

- Modify: /Users/xxxly/resume/eval.mjs，状态枚举、buildEvalPrompt 硬约束、parseEvalReport 的 matches 归一。
- Test: /Users/xxxly/resume/test-fixtures/reliability/test-sources.mjs。
- Shared integration: /Users/xxxly/resume/server.mjs `/eval/create`。
- Shared tests: /Users/xxxly/resume/test-structure.sh EV-1/2/3/4、/Users/xxxly/resume/test.sh stub 请求记录。

- [ ] **Step 1（3 分钟）：追加新旧 status 与证据核验用例。**

~~~js
const evaluationRaw = (status, evidence) => JSON.stringify({
  score: 4, verdict: 'apply', matches: [{ req: '后端能力', status, evidence }]
});

test('E1 eval checks every displayed resume quote and normalizes sourced', () => {
  const parse = (status, evidence, docText = P1.text) =>
    V.parseEvalReport(evaluationRaw(status, evidence), { docText }).report.matches[0];
  assert.equal(parse('covered', '负责存储层改造').status, 'covered');
  assert.deepEqual(
    [parse('covered', '').status, parse('covered', '').evidence],
    ['partial', '']
  );
  assert.deepEqual(
    [parse('covered', '不存在的引文').status, parse('covered', '不存在的引文').evidence],
    ['partial', '']
  );
  assert.equal(parse('partial', '负责存储层改造').evidence, '负责存储层改造');
  assert.equal(parse('partial', '不存在的引文').evidence, '');
  assert.equal(parse('partial', '不存在的引文').status, 'partial');
  assert.equal(parse('missing', '负责存储层改造').evidence, '');
  const sourced = parse('sourced', '素材库任意表述');
  assert.equal(sourced.status, 'missing');
  assert.equal(sourced.evidence, '');
  assert.equal(sourced.compatibilityReason, 'LEGACY_SOURCED');
  assert.equal(parse('covered', '任意', '').status, 'partial');
  assert.equal(parse('covered', '任意', '').evidence, '');
});

test('E1 eval prompt no longer offers sourced or material-backed claims', () => {
  const prompt = V.buildEvalPrompt({ docText: P1.text, jd: '后端要求', company: '合成公司', role: '后端' });
  assert.ok(prompt.sys.includes('"status":"covered|partial|missing"'));
  assert.ok(!prompt.sys.includes('covered|sourced'));
  assert.ok(!prompt.sys.includes('sourced='));
});
~~~

- [ ] **Step 2（2 分钟）：运行 E1，预期旧 covered 空引文/partial 伪引文/sourced 保留行为失败。**

~~~sh
node --test --test-name-pattern='E1 ' test-fixtures/reliability/test-sources.mjs
~~~

预期 exit 1。此时不准把 partial/sourced 的 evidence 改叫“引用示例”绕过核验。

- [ ] **Step 3（3 分钟）：调整枚举与 prompt 两处状态约束。**

~~~js
const STATUSES = new Set(['covered', 'partial', 'missing']);
~~~

buildEvalPrompt 的 JSON schema 中用以下完整 matches 字段替换旧 matches 字段：

~~~json
"matches":[{"req":"JD 的一条要求（逐字）","status":"covered|partial|missing","evidence":"简历里对应的原文片段，找不到留空","weight":"must|should|nice","weightFrom":"JD 原文 | 结构推断（无出处标注）"}]
~~~

替换硬约束第 2/7 条为：

~~~text
2. 所有非空 evidence 必须是【母版简历】里的逐字子串；covered 必须给有效引文，partial 的引文找不到则留空，missing 的 evidence 一律为空。严禁编造简历里没有的经历。
7. status 取值仅为 covered/partial/missing：covered=母版有完整对应证据；partial=有相关经历但不满足要求；missing=没有对应简历证据。本次没有素材输入，不得声称有素材支持。
~~~

其余 score、verdict、level、JD 边界与 salary 原契约保持。

- [ ] **Step 4（4 分钟）：替换 parseEvalReport 的完整 matches 循环。**

保留外围 score 校验与返回结构，不重写不相关薪资/评分逻辑。用以下代码替换现有 `let dropped=0` 到 matches 循环结束：

~~~js
let dropped = 0;
const matches = [];
const hay = String(docText || '').replace(/\s+/g, '');
for (const m of Array.isArray(data.matches) ? data.matches : []) {
  if (!m || typeof m !== 'object') { dropped++; continue; }
  const req = str(m.req);
  const legacySourced = m.status === 'sourced';
  if (!req || (!STATUSES.has(m.status) && !legacySourced)) { dropped++; continue; }
  let status = legacySourced ? 'missing' : m.status;
  let evidence = str(m.evidence);
  const needle = evidence.replace(/\s+/g, '');
  const matchesResume = !!(hay && needle && hay.includes(needle));
  if (status === 'missing') evidence = '';
  else if (!matchesResume) {
    evidence = '';
    if (status === 'covered') status = 'partial';
  }
  matches.push({
    req,
    status,
    evidence,
    weight: WEIGHTS.has(m.weight) ? m.weight : '',
    weightFrom: WEIGHT_FROM.includes(str(m.weightFrom)) ? str(m.weightFrom) : '',
    ...(legacySourced ? { compatibilityReason: 'LEGACY_SOURCED' } : {})
  });
}
~~~

未传 docText 时 fail-closed，不能保留“已核验 covered”。这改变原 EV-4 的无基准放行断言，必须显式迁移。

- [ ] **Step 5（3 分钟，集成 owner）：替换 /eval/create 读入与来源记录。**

server 已有 docToText/contentHash；只替换对应输入及 rec 字段，不触碰资源池预留/释放：

~~~js
const html = fs.readFileSync(docPath(from), 'utf8');
const docText = docToText(html, { includeHidden: false });
const p = buildEvalPrompt({ docText, jd, company, role });
// 保留当前包最终统一的 chat 调用及其错误处理。
const parsed = parseEvalReport(raw, { docText });
~~~

在当前 rec 对象加入：

~~~js
source: { type: 'resume', docId: from, hash: contentHash(docText) },
~~~

hash 只基于 prompt/parser 同用的 docText。不得使用 `contentHash(html)`，不得从标题或 model 字段猜 docId。

- [ ] **Step 6a（3 分钟，验证 owner）：同步 EV-1 的新枚举与 EV-2 的明确正文基准。**

EV-1 原有枚举 for 循环替换为：

~~~js
for (const k of ['under', 'right', 'over', 'covered', 'partial', 'missing', 'apply', 'caution', 'skip'])
  assert(p.sys.includes(k), 'sys 必须声明枚举 ' + k);
assert(!p.sys.includes('covered|sourced'), '新输出 schema 不再宣称素材来源');
~~~

EV-2 的合法报告解析原声明替换为下述调用，保留后面的 score/verdict/level/证据保真断言：

~~~js
const ok = parseEvalReport(JSON.stringify(base), { docText: '使用 SQL 进行数据查询与治理规则实现' });
~~~

在现有 matches 长度断言后追加：

~~~js
assert(ok.report.matches[1].status === 'missing', '旧 sourced 归一为 missing');
assert(ok.report.matches[1].compatibilityReason === 'LEGACY_SOURCED', '保留旧 sourced 兼容原因');
~~~

其它 score/level 的测试不核验 evidence，可继续只传原参数；不要为了它们恢复生产无基准放行。

- [ ] **Step 6b（3 分钟，验证 owner）：EV-3 的“合法条保真”必须提供真实合成正文。**

将该块原 const m 调用整体替换为：

~~~js
const m = parseEvalReport(JSON.stringify({
  ...base,
  matches: [
    { req: '要求A', status: 'covered', evidence: '原文A', weight: 'must', weightFrom: 'JD 原文' },
    { req: '要求B', status: '全覆盖了吧', evidence: '原文B', weight: 'must' },
    { req: '   ', status: 'covered', evidence: '原文C' },
    { req: '要求D' },
    null
  ]
}), { docText: '原文A' });
~~~

保留 length=1、dropped=4、合法 evidence=原文A 的断言。这验证合法引文，不能删除证据保真断言来迁就无正文输入。

- [ ] **Step 6（3 分钟，验证 owner）：替换 EV-4 的三个旧断言组。**

~~~js
r = parseEvalReport(mk('sourced', '素材库里的任意表述'), { docText: DOC });
assert(r.report.matches[0].status === 'missing' && r.report.matches[0].evidence === '',
  'sourced 没有真实素材输入，归一 missing 并清证据');
assert(r.report.matches[0].compatibilityReason === 'LEGACY_SOURCED',
  '保留兼容原因供 UI 说明');

r = parseEvalReport(mk('partial', '任何内容'), { docText: DOC });
assert(r.report.matches[0].status === 'partial' && r.report.matches[0].evidence === '',
  'partial 判断保留，伪引文清除');
r = parseEvalReport(mk('missing', '负责存储层改造'), { docText: DOC });
assert(r.report.matches[0].status === 'missing' && r.report.matches[0].evidence === '',
  'missing 不展示证据引文');

r = parseEvalReport(mk('covered', '任意'));
assert(r.report.matches[0].status === 'partial' && r.report.matches[0].evidence === '',
  '未提供正文基准不得声称 covered');
~~~

保留真实原文、坏 score 及既有评分一致性反例。

- [ ] **Step 7（2 分钟）：运行 E1 与当前全部纯函数测试。**

~~~sh
node --test --test-name-pattern='E1 ' test-fixtures/reliability/test-sources.mjs
node --test test-fixtures/reliability/test-sources.mjs
~~~

预期 exit 0，尤其不能因只比较 score 而漏掉 evidence 清空断言。

- [ ] **Step 8（2 分钟）：提交 eval 纯函数；共享 route/test 各归 owner。**

~~~sh
git add eval.mjs test-fixtures/reliability/test-sources.mjs
git commit -m "fix: validate displayed evaluation evidence and normalize legacy statuses"
~~~

回退：parser 与新 prompt 同批回退；只回退 route 会恢复完整 HTML 输入，不能把该状态宣布为 E1 完成。真实历史记录不需要任何回退脚本。

## Task SRC-06（E2）：历史评估读时降级、来源正文 hash 与 UI

**Files**

- Modify: /Users/xxxly/resume/eval.mjs 新增 `evalRecordView`。
- Test: /Users/xxxly/resume/test-fixtures/reliability/test-sources.mjs。
- Shared integration: /Users/xxxly/resume/server.mjs `evalCardHtml` 与返回评估记录的入口。

- [ ] **Step 1（3 分钟）：追加旧 sourced 不改原记录的用例。**

~~~js
test('E2 legacy eval view preserves score verdict and raw record', () => {
  const raw = deepFreeze({
    id: 'ev-legacy', score: 4.5, verdict: 'caution',
    blocks: {
      score: 4.5, verdict: 'caution',
      matches: [{ req: '管理经验', status: 'sourced', evidence: '未经核验的素材声称' }]
    }
  });
  const before = JSON.stringify(raw);
  const view = V.evalRecordView(raw);
  assert.equal(view.sourceState, 'legacy');
  assert.equal(view.score, 4.5);
  assert.equal(view.verdict, 'caution');
  assert.equal(view.blocks.matches[0].status, 'missing');
  assert.equal(view.blocks.matches[0].evidence, '');
  assert.equal(view.blocks.matches[0].compatibilityReason, 'LEGACY_SOURCED');
  assert.equal(JSON.stringify(raw), before);
  const broken = V.evalRecordView({ source: { type: 'resume', docId: 7 }, blocks: { matches: null } });
  assert.equal(broken.sourceState, 'invalid');
  assert.deepEqual(broken.blocks.matches, []);
});
~~~

- [ ] **Step 2（3 分钟）：追加真实提取+hash 恒定/变化用例。**

~~~js
test('E2 evaluation source hash measures visible text rather than style or hidden content', () => {
  const html = color => '<!doctype html><html><head><style>p{color:' + color
    + '}</style></head><body><div class="sheet"><p>负责存储层改造</p>'
    + '<div class="ed-entry-hidden"><p>HIDDEN_DO_NOT_SEND</p></div>'
    + '<script>SCRIPT_DO_NOT_SEND()</script>'
    + '<div data-ai-panel="1">PANEL_DO_NOT_SEND</div></div></body></html>';
  const a = docToText(html('red'), { includeHidden: false });
  const b = docToText(html('blue'), { includeHidden: false });
  const changed = docToText(html('blue').replace('负责存储层改造', '负责数据库治理'), { includeHidden: false });
  assert.ok(a.includes('负责存储层改造'));
  for (const marker of ['HIDDEN_DO_NOT_SEND', 'SCRIPT_DO_NOT_SEND', 'PANEL_DO_NOT_SEND']) {
    assert.ok(!a.includes(marker));
  }
  assert.equal(contentHash(a), contentHash(b));
  assert.notEqual(contentHash(a), contentHash(changed));
  const view = V.evalRecordView({
    source: { type: 'resume', docId: 'fixture-master', hash: contentHash(a) },
    blocks: { matches: [] }
  });
  assert.equal(view.sourceState, 'recorded');
});
~~~

夹具使用已核对的 `ed-entry-hidden`（extract.mjs 的 HIDDEN_CLASS 同时识别 ed-sec-hidden）；不新增隐藏类、不改正文提取器。

- [ ] **Step 3（2 分钟）：运行 E2，预期 evalRecordView 未定义，exit 1。**

~~~sh
node --test --test-name-pattern='E2 ' test-fixtures/reliability/test-sources.mjs
~~~

- [ ] **Step 4（4 分钟）：新增兼容视图纯函数。**

~~~js
export function evalRecordView(record) {
  const original = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const blocks = original.blocks && typeof original.blocks === 'object' && !Array.isArray(original.blocks)
    ? original.blocks : {};
  const source = original.source;
  const recorded = source && source.type === 'resume' && typeof source.docId === 'string'
    && source.docId.length > 0 && typeof source.hash === 'string' && /^[0-9a-f]{16}$/.test(source.hash);
  const sourceState = !Object.prototype.hasOwnProperty.call(original, 'source')
    ? 'legacy' : recorded ? 'recorded' : 'invalid';
  return {
    ...original,
    sourceState,
    blocks: {
      ...blocks,
      matches: (Array.isArray(blocks.matches) ? blocks.matches : [])
        .filter(match => match && typeof match === 'object')
        .map(match => match.status === 'sourced'
          ? { ...match, status: 'missing', evidence: '', compatibilityReason: 'LEGACY_SOURCED' }
          : { ...match })
    }
  };
}
~~~

不调用 parseEvalReport 重算旧记录，不读取当前母版来给旧记录补 source，不改变 top-level 或 blocks 内历史分数与 verdict。

- [ ] **Step 5（3 分钟，集成 owner）：评估响应仅经过 evalRecordView，不回写。**

server import 加入 `evalRecordView`。新记录保存仍保存 rec 的原始业务字段；发送响应使用：

~~~js
return sendJson(200, { ok: true, eval: evalRecordView(rec) });
~~~

当前没有历史列表，不新增列表。将来任何读取既有评估记录后送到卡片的入口也调用该函数；本轮 /eval/promote 继续只读原记录创建岗位草稿，不为了展示写回归一化结果。

- [ ] **Step 6（4 分钟，集成 owner）：评估卡片按 sourceState 显示来源。**

删除 `STATUS.sourced='素材支持'`，替换为：

~~~js
var STATUS = { covered: '已有证据', partial: '部分匹配', missing: '未找到简历证据' };
var SOURCE = {
  recorded: '评估时的母版正文（已记录来源）',
  legacy: '历史报告，来源未复核',
  invalid: '来源记录不可用'
};
~~~

在报告标题后的 h.push 增加：

~~~js
h.push('<p style="font-size:12px;color:var(--mut)">'
  + esc(SOURCE[rec.sourceState] || SOURCE.legacy) + '</p>');
~~~

将 matches 循环替换为如下兼容展示；客户端的 sourced 分支只作为旧响应兜底，不写回任何状态：

~~~js
ms.forEach(function (m) {
  var legacy = m.status === 'sourced' || m.compatibilityReason === 'LEGACY_SOURCED';
  var status = m.status === 'sourced' ? 'missing' : m.status;
  var evidence = legacy ? '' : (m.evidence || '');
  h.push('<div style="margin-top:6px;font-size:13px">· ' + esc(m.req)
    + ' — ' + esc(STATUS[status] || '来源未复核')
    + (legacy ? '<div style="color:var(--mut);font-size:12px">旧版来源状态，无可核对的简历证据</div>' : '')
    + (evidence ? '<div style="color:var(--mut);font-size:12px">'
      + (rec.sourceState === 'recorded' ? '简历引文：' : '旧版引用（来源未复核）：')
      + esc(evidence) + '</div>' : '') + '</div>');
});
~~~

这里没有“当前来源 fresh”承诺，没有“素材支持”文案；新 source 只记当时输入，不是母版快照仓库。

- [ ] **Step 7（2 分钟）：运行全部纯函数测试，预期 exit 0。**

~~~sh
node --test test-fixtures/reliability/test-sources.mjs
~~~

- [ ] **Step 8（2 分钟）：提交历史视图与 E2 测试。**

~~~sh
git add eval.mjs test-fixtures/reliability/test-sources.mjs
git commit -m "fix: show legacy evaluation provenance without rewriting history"
~~~

服务端卡片与输入/hash 接线可同一服务端提交，提交说明须列覆盖 E1/E2；来源 owner 不代替集成 owner 修改 server。

## Task SRC-07（共享接线）：交给共享 owner 的集成反例与验证落点

这一任务只定义来源包集成内容，不复制保存/资源方案。每条先写反例、观察红灯，再接线、转绿；实际运行由单一验证 owner 完成。

### I1：面试 stub 必须回传本次真实来源

- [ ] **Step 1（3 分钟，验证 owner）：在现有 fake LLM 的面试分流读取 prompt 中 sourceZid 与 evIndex。**

~~~js
function interviewStubReply(messages) {
  const user = messages.find(m => m.role === 'user')?.content || '';
  const ids = [...String(user).matchAll(/【简历片段 sourceZid=(z[0-9a-f]{8})】\n([^\n]*)/g)];
  const indexMatch = /evIndex=(\d+)/.exec(user);
  const first = ids[0];
  if (!first || !indexMatch) return JSON.stringify({
    chains: [],
    generic: [{ question: '自我介绍', answerPoints: [{ text: '先介绍与岗位相关的经历', quote: '' }] }]
  });
  return JSON.stringify({
    chains: [{
      evIndex: Number(indexMatch[1]), question: '你负责什么', followUp: '如何验证贡献',
      answerPoints: [{ text: '说明自己的贡献边界', quote: first[2] }]
    }],
    generic: [{
      question: '自我介绍',
      answerPoints: [{ text: '介绍相关经历', quote: first[2], sourceZid: first[1] }]
    }]
  });
}
~~~

夹具段落必须至少 6 字且无换行歧义；prompt 来源截断测试由纯函数覆盖。故意注入 FAKE_QUOTE_DO_NOT_FORWARD 到 evidence 的展示 quote，断言桩接收到的 user 不含它。

- [ ] **Step 2（3 分钟）：通过现有 /job/gen-start(kind=interview) 运行一次模拟任务并轮询。**

共享 helper 采用以下完整断言函数；post/get 由已隔离的公共 harness 提供，方法签名明确为 post(path,json)->parsed JSON、get(path)->parsed JSON：

~~~js
async function assertInterviewSourceIntegration({ post, get, docId, waitDone, readMeta, promptText }) {
  const started = await post('/job/gen-start?id=' + encodeURIComponent(docId) + '&kind=interview', {});
  assert.equal(started.ok, true);
  await waitDone(docId, 'interview');
  const disk = readMeta(docId);
  const beforeRead = JSON.stringify(disk);
  const data = await get('/job/changes?id=' + encodeURIComponent(docId));
  const points = data.job.interview.generic.flatMap(chain => chain.answerPoints || []);
  assert.ok(points.some(point => point.sourceState === 'fresh'));
  assert.ok(points.every(point => point.sourceState !== 'fresh' || point.sourceZid));
  assert.ok(!promptText().includes('FAKE_QUOTE_DO_NOT_FORWARD'));
  assert.equal(JSON.stringify(readMeta(docId)), beforeRead);
}
~~~

waitDone 必须有有限期限并在 error/cancelled 提前失败；不要对真实 LLM 等待。readMeta/promptText 只访问 TEST_DIR。纯读断言紧接读取，避免其它后台任务写入造成假阳性；此时服务中不得仍有其它该文档 runner。

### I2：评估输入与记录来源必须真的接线

- [ ] **Step 1（4 分钟，验证 owner）：用合成母版写入隐藏/script/UI marker，stub 返回 covered 及 partial 伪引用。**

该块在现有隔离 harness 中的具体断言：

~~~js
async function assertEvaluationSourceIntegration({ post, readEval, promptText, docId, visibleText }) {
  const result = await post('/eval/create', {
    from: docId, company: '合成评估公司', role: '后端', jd: '需要后端经验'
  });
  assert.equal(result.ok, true);
  for (const marker of ['HIDDEN_DO_NOT_SEND', 'SCRIPT_DO_NOT_SEND', 'PANEL_DO_NOT_SEND']) {
    assert.ok(!promptText().includes(marker));
  }
  const saved = readEval(result.eval.id);
  assert.deepEqual(saved.source, {
    type: 'resume', docId, hash: contentHash(visibleText)
  });
  assert.equal(result.eval.sourceState, 'recorded');
  assert.ok(saved.blocks.matches.every(match => match.status !== 'sourced'));
  assert.ok(saved.blocks.matches.every(match => match.status !== 'missing' || match.evidence === ''));
  assert.equal(saved.blocks.matches.find(match => match.req === 'partial伪引文').evidence, '');
}
~~~

stub 的报告 JSON 必须有：
~~~json
{"score":4,"verdict":"apply","matches":[{"req":"正文证据","status":"covered","evidence":"负责存储层改造"},{"req":"partial伪引文","status":"partial","evidence":"未经核验的海外并购"},{"req":"旧sourced","status":"sourced","evidence":"素材支持声称"}]}
~~~

- [ ] **Step 2（3 分钟）：仅改隔离母版样式后再评估，随后改可见正文再评估。**

~~~js
async function assertEvalHashTransitions({ createEvaluation, changeStyle, changeVisibleText }) {
  const first = await createEvaluation();
  await changeStyle();
  const styleOnly = await createEvaluation();
  assert.equal(styleOnly.source.hash, first.source.hash);
  await changeVisibleText();
  const changedText = await createEvaluation();
  assert.notEqual(changedText.source.hash, first.source.hash);
}
~~~

三个回调只操作该次虚拟母版；createEvaluation 返回保存记录，不让测试侧自己构造 source 充当服务端证据。

### I3：共享入口与旧夹具收口

- [ ] **Step 1（2 分钟，验证 owner）：在 test-structure.sh 的 cd/unset 后、首个 heredoc 前显式调用新纯函数文件一次。**

~~~sh
node --test test-fixtures/reliability/test-sources.mjs
~~~

测试脚本须保留 set -e，不包 `|| true`；若使用共享 runner，必须保留 Node exit code。package.json 现有 test:all 已包含 bash test-structure.sh，因此这个唯一调用使新文件进入最终验收，不再新增第二次同文件调用。浏览器断言放现有 test-editor.mjs，随 test.sh 进入 test:all。

- [ ] **Step 2（3 分钟）：运行相关共享套件。**

~~~sh
bash test-structure.sh
bash test.sh
~~~

test.sh 的浏览器段必须用本轮隔离实例。预期 exit 0 且 S1–S3/E1–E2 对应反例确实执行。其它未集成包导致失败时记录失败归属，不修改来源测试逃避。

- [ ] **Step 3（2 分钟）：向总计划提交完成证据，不自行重复执行最终四套件。**

给集成 owner：commit IDs、纯函数命令及 exit、共享来源反例结果、浏览器标签/回跳结果、真实数据未访问说明、仍未运行项目。总 owner 再运行 `RESUME_TEST_STRICT=1 npm run test:all`，本计划不抢占共享端口或改总套件。

## 3. 验收编号到任务/测试映射

| 设计编号 | 纯函数或 UI 场景 | 落点 |
|---|---|---|
| S1 | 真 ID+伪 quote、stale hash、仅素材、跳过中间行/保留 evIndex | S1 两测试、S2 prompt/index 测试、I1 |
| S2 | generic 缺/错 zid、跨段/伪/短引文、601 字后、数字在别段、空引文 | S2 四测试与 S3b UI |
| S3 | 旧 anchored、缺 source、坏 source、改文/删除、mat 空 facts，读取无写入 | S3a 两测试、S3b、I1 读盘前后断言 |
| E1 | 隐藏/script/UI 排除、covered 空引文、partial 伪引文、新旧 sourced | E1 两测试、E2 提取测试、I2、EV-1/2/3/4 迁移 |
| E2 | 样式 hash 恒定/正文 hash 变化、历史分数与原存储不变 | E2 两测试、I2 第二步、evalRecordView/UI |

## 4. 完成检查、回滚与交接

- [ ] 新接口名字、sourcesByEvIndex 的 Map、sourceParas 的 {zid,hash,text} 和 omitted reason 与总计划一致；prompt/parser 没有 ctx.paras 或 refs.quote fallback。
- [ ] 生产所有 buildInterviewPrompt/parseInterview 调用都显式传同一 sources；四个旧测试 heredoc 有明确适配，无 top-level zid 假结构。
- [ ] source 与 guard 语义分离；附引文不声称语义事实证明；空引文不显示回跳。
- [ ] jobViewLive/evalRecordView 不落盘；旧 score/verdict 不重算；missing/sourced 不显示未核对 evidence。
- [ ] 新 eval hash 对同一 docText 计算，style/hidden/script 不影响该正文；没有真实素材输入却显示“素材支持”的路径已消除。
- [ ] source/UI 不新增导出门禁；没有为母版创建 job；未新增运行时来源数据库。
- [ ] 冻结件和真实数据未变；只读取或写入本计划负责文件与 TEST_DIR。
- [ ] 逐任务提交可回退；任何共享提交仅包含该 owner 已审阅的来源接线，不含他人未完成代码。

回滚顺序：先停来源新生成入口或回退服务端调用到与 parser 匹配的版本，再回退 UI/视图，最后回退 prompt/parser/resolver；新 source 字段保持可选可忽略，不做真实数据清洗。若回退导致旧 UI 再次冒充来源已核验，暂时隐藏该面试来源展示并明确未完成，不能扩大可信声明来“兼容”。

来源包完成只说明代码与隔离模拟验证通过。真实服务生效由总集成 owner 核实在途工作后重启并检查；真实模型质量另行授权，不包含在此计划。
