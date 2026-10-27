// test-fixtures/reliability/test-sources.mjs — 来源可信层反例（SRC-01～07）
// 覆盖：真源集合（Map / evIndex 不重编号 / quote-title 兜底无效 / 段落消失 / 600 UTF-16 上限）、
//       prompt 与 parser 共用同一真源集合、generic 来源归属、数字归属、空引用不授予核验标记、
//       旧数据读时降级（anchored / sourced / score-verdict）、eval 可见正文 hash、视图零回写。
// 约束：零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import * as E from '../../evidence.mjs';
import * as V from '../../eval.mjs';
import { docToText, contentHash } from '../../extract.mjs';

// ===== 合成夹具 =====
const P1 = { zid: 'za1111111', text: '负责存储层改造，QPS 从 300 提升到 5000' };
const P2 = { zid: 'zb2222222', text: '交付异步任务平台，每天处理 100000 个任务' };
const P3 = { zid: 'zc3333333', text: '主导跨部门协同，交付周期缩短一半' };
const MAT = {
  id: 'm-source01',
  title: '合成素材',
  factStatus: 'confirmed',
  facts: { contribution: '主导订单系统拆分', metrics: '覆盖 3 个业务线' }
};

// 证据行走真实 parseEvidence：模型给的 quote/title 只是展示字段，不是来源身份
const rowFor = (para, req = '后端能力', quote = 'FAKE_QUOTE_DO_NOT_FORWARD') => E.parseEvidence(JSON.stringify({
  evidence: [{ req, status: 'covered', refHints: [{ type: 'para', zid: para.zid, title: '模型标题', quote }] }]
}), { gen: 1, mats: [], paras: [para] })[0];

const materialRow = () => E.parseEvidence(JSON.stringify({
  evidence: [{ req: '订单经验', status: 'sourced', refHints: [{ type: 'mat', id: MAT.id, title: '伪素材标题', quote: '伪造了战略并购经历' }] }]
}), { gen: 1, mats: [MAT], paras: [] })[0];

// 只有 quote、没有 zid 的引用：parseEvidence 直接丢弃该 ref → 该行没有任何来源
const quoteOnlyRow = () => E.parseEvidence(JSON.stringify({
  evidence: [{ req: '只有引文没有 zid', status: 'covered', refHints: [{ type: 'para', title: '模型标题', quote: '负责存储层改造' }] }]
}), { gen: 1, mats: [], paras: [P1] })[0];

const sourcesFor = (evidence, paras) => E.resolveInterviewSources({ evidence, paras });
const interview = (raw, evidence, paras, sources = sourcesFor(evidence, paras)) =>
  E.parseInterview(JSON.stringify(raw), { evidence, sources });

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

// ===== A. SRC-01 真源集合 =====
{
  // 0 仅素材 / 1 有真源 / 2 段落消失 / 3 只有 quote / 4 重复段落 / 5 段落被改
  const rows = [materialRow(), rowFor(P1), rowFor(P2), quoteOnlyRow(), rowFor(P1, '重复段落要求'), rowFor(P3)];
  const before = JSON.stringify(rows);
  const sources = sourcesFor(rows, [P1, { ...P3, text: P3.text + '（已改写）' }]);

  assert.ok(sources.sourcesByEvIndex instanceof Map, 'sourcesByEvIndex 必须是真正的 Map');
  assert.deepEqual([...sources.sourcesByEvIndex.keys()], [1, 4], 'evIndex 用原始下标，不重编号');
  assert.equal(sources.sourcesByEvIndex.get(1).zid, P1.zid);
  assert.equal(sources.sourcesByEvIndex.get(1).hash, E.paraFingerprint(P1.text), 'hash 基于完整段落');
  assert.deepEqual(sources.sourceParas.map((p) => p.zid), [P1.zid], 'sourceParas 按 zid 去重');
  assert.deepEqual(sources.omitted, [
    { evIndex: 0, reason: 'material-only' },
    { evIndex: 2, reason: 'stale' },
    { evIndex: 3, reason: 'missing' },
    { evIndex: 5, reason: 'stale' }
  ], '四种省略原因必须互相可区分');
  assert.equal(JSON.stringify(rows), before, '来源集合构造不得改写输入 evidence');
  assert.ok(!JSON.stringify(sources.sourceParas).includes('FAKE_QUOTE'), 'quote 不得兜底成来源');
  assert.ok(!JSON.stringify(sources.sourceParas).includes('伪造了战略并购经历'), '素材标题/引文不得兜底成来源');
  assert.equal(sources.sourceParas.length, 1, '只有 quote 的引用不产生任何来源项');
}
{
  // 600 上限按 UTF-16 码元算（emoji 占 2 个码元），hash 仍基于完整段落
  const emojiPara = { zid: 'zd4444444', text: '😀'.repeat(400) };   // 400 码点 / 800 码元
  const sources = sourcesFor([rowFor(emojiPara)], [emojiPara]);
  assert.equal(sources.sourceParas[0].text.length, 600, '片段截断到 600 个 UTF-16 码元');
  assert.equal([...sources.sourceParas[0].text].length, 300, '若按码点截断会是 800 —— 必须按码元');
  assert.equal(sources.sourceParas[0].hash, E.paraFingerprint(emojiPara.text), 'hash 仍是完整段落');
}
{
  // ref 自带 quote 但没有可用 zid → 不得产生来源项（quote/title 不兜底）
  const forged = {
    id: 'e9', req: '只有引文没有 zid',
    refs: [{ refId: 'b1r9', type: 'para', zid: '', id: null, hash: '0'.repeat(40), title: '模型标题', quote: '负责存储层改造' }]
  };
  const sources = sourcesFor([forged], [P1]);
  assert.equal(sources.sourceParas.length, 0, '只有 quote 的引用不产生任何来源项');
  assert.equal(sources.sourcesByEvIndex.size, 0);
  assert.equal(sources.omitted.length, 1);
  assert.ok(!JSON.stringify(sources).includes('负责存储层改造'), 'quote 不得成为来源文本');
}
{
  // 段落为空（指纹有效但正文为空）
  const emptyPara = { zid: 'ze5555555', text: '' };
  const sources = sourcesFor([rowFor(emptyPara)], [emptyPara]);
  assert.deepEqual(sources.omitted, [{ evIndex: 0, reason: 'empty' }]);
  assert.equal(sources.sourceParas.length, 0);
}

// ===== B. SRC-02 prompt 与 parser 共用同一真源集合 =====
{
  const rows = [materialRow(), rowFor(P1), rowFor(P2)];
  const sources = sourcesFor(rows, [P1, P2]);
  const prompt = E.buildInterviewPrompt({
    company: '合成公司', role: '后端', jd: '要求存储经验', evidence: rows, sources
  });
  assert.ok(prompt.user.includes('evIndex=1'), 'prompt 必须标出原始 evIndex');
  assert.ok(prompt.user.includes(P1.text));
  assert.ok(prompt.user.includes(P2.text));
  assert.ok(!prompt.user.includes('FAKE_QUOTE_DO_NOT_FORWARD'), 'prompt 不得发送模型自报 quote');
  assert.ok(!prompt.user.includes('伪造了战略并购经历'), 'prompt 不得发送模型自报素材引文');
  assert.ok(prompt.sys.includes('sourceZid'), 'prompt 必须教模型回 sourceZid');
  // 缺 sources → fail-closed
  assert.throws(() => E.buildInterviewPrompt({ evidence: rows }), TypeError);
  assert.equal(E.parseInterview('{"generic":[]}', { evidence: rows, paras: [P1] }), null);
}
{
  // generic 的非空引文必须给出本批来源里的合法 sourceZid
  const rows = [rowFor(P1), rowFor(P2)];
  const point = { text: '我负责存储层改造', quote: '负责存储层改造', sourceZid: P1.zid };
  const run = (p) => interview({ generic: [{ question: '自我介绍', answerPoints: [p] }] }, rows, [P1, P2]);
  const valid = run(point).generic[0].answerPoints[0];
  assert.deepEqual(valid.source, { type: 'para', zid: P1.zid, hash: E.paraFingerprint(P1.text) });
  assert.equal(valid.anchored, true);
  for (const bad of [
    { ...point, sourceZid: undefined },        // 没有 zid
    { ...point, sourceZid: 'zffffffff' },      // 不在来源集合里
    { ...point, sourceZid: P2.zid },           // 跨段：引文不在 P2
    { ...point, quote: '完全不存在的原文证据' },  // 伪引文
    { ...point, quote: '负责' }                // 太短，等于没锚
  ]) {
    const result = run(bad);
    assert.equal(result.generic[0].answerPoints.length, 0, '非法 generic 引用必须整条丢弃');
    assert.equal(result.dropped, 1);
  }
  // 空引用：只给作答思路，不授予核验标记
  const none = run({ text: '先介绍与岗位相关的经历', quote: '' }).generic[0].answerPoints[0];
  assert.deepEqual(none.source, { type: 'none' });
  assert.equal(none.anchored, false);
}
{
  // 引文只能命中本次实际发送的片段（600 码元之内）；链的 evIndex 保留原值
  const long = { zid: 'zf6666666', text: '甲'.repeat(600) + '真实但从未发给模型的引文' };
  const rows = [materialRow(), rowFor(P1), rowFor(long)];
  const result = interview({
    chains: [
      { evIndex: 0, question: '素材问题', answerPoints: [{ text: '不要接受', quote: '伪造了战略并购经历' }] },
      { evIndex: 1, question: '负责什么', answerPoints: [{ text: '我负责存储层改造', quote: '负责存储层改造' }] },
      { evIndex: 2, question: '截断后有什么', answerPoints: [{ text: '不要接受', quote: '真实但从未发给模型的引文' }] }
    ]
  }, rows, [P1, long]);
  assert.deepEqual(result.chains.map((c) => c.evIndex), [1, 2], '保留原始 evIndex，缺真源的行整链丢弃');
  assert.equal(result.chains[0].answerPoints[0].source.zid, P1.zid);
  assert.equal(result.chains[1].answerPoints.length, 0, '600 码元之后的引文从未发出，必须丢弃');
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.omitted, [{ evIndex: 0, reason: 'material-only' }]);
}
{
  // 数字归属：数字只能由它自己引用的段落支持
  const rows = [rowFor(P1), rowFor(P2)];
  const points = interview({
    generic: [{ question: '自我介绍', answerPoints: [
      { text: '我负责存储层改造', quote: '负责存储层改造', sourceZid: P1.zid },
      { text: '我把 QPS 提升到 100000', quote: '负责存储层改造', sourceZid: P1.zid },
      { text: '说明自己的贡献边界', quote: '' }
    ] }]
  }, rows, [P1, P2]).generic[0].answerPoints;
  assert.deepEqual(points.map((p) => p.guard), ['normal', 'conflict', 'normal']);
  assert.equal(points[0].anchored, true);
  assert.equal(points[1].anchored, false, '数字只出现在别的段落 → 不授予核验标记');
  assert.equal(points[2].anchored, false, '空引用 → 不授予核验标记');
  // 同一个数字锚到真正含它的段落 → 不算编造
  const own = interview({
    generic: [{ question: '自我介绍', answerPoints: [
      { text: '我把任务量提升到 100000', quote: '每天处理 100000 个任务', sourceZid: P2.zid }] }]
  }, rows, [P1, P2]).generic[0].answerPoints[0];
  assert.equal(own.guard, 'normal');
  assert.equal(own.anchored, true);
}

// ===== C. SRC-03 / SRC-04 读时降级（旧数据不回写、不升级）=====
{
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
  assert.deepEqual(points.map((p) => p.sourceState), ['fresh', 'none', 'legacy', 'invalid', 'stale']);
  assert.deepEqual(points.map((p) => p.anchored), [true, false, false, false, false],
    '旧 anchored:true 不得显示为已核验');
  assert.equal(points[0].quoteForDisplay, '负责存储层改造');
  assert.equal(points[0].sourceZid, P1.zid);
  assert.ok(points.slice(1).every((p) => p.quoteForDisplay === '' && p.sourceZid === ''));
  assert.equal(JSON.stringify(raw), before, '读取视图不得回写输入');
  // 段落被改 / 被删 → stale
  assert.equal(E.interviewSourceView(raw, { paras: [{ ...P1, text: '当前正文已经变化' }] })
    .chains[0].answerPoints[0].sourceState, 'stale');
  assert.equal(E.interviewSourceView(raw, { paras: [] }).chains[0].answerPoints[0].sourceState, 'stale');
}
{
  // 单条 ref 的来源视图：模型 quote 永不冒充来源；素材空 facts 不回退到 quote
  const paraRef = deepFreeze(rowFor(P1).refs[0]);
  const refBefore = JSON.stringify(paraRef);
  const paraView = E.evidenceSourceView(paraRef, { paras: [P1], mats: [] });
  assert.equal(paraView.sourceState, 'fresh');
  assert.equal(paraView.quoteForDisplay, '', '模型伪 quote 不进展示');
  assert.equal(paraView.sourceZid, P1.zid);
  assert.equal(JSON.stringify(paraRef), refBefore);

  const matRef = materialRow().refs[0];
  const matView = E.evidenceSourceView(matRef, { paras: [], mats: [MAT] });
  assert.equal(matView.sourceTitle, MAT.title);
  assert.ok(matView.sourceText.includes('贡献：主导订单系统拆分'));
  assert.ok(!matView.sourceText.includes('战略并购'));
  const emptyFacts = E.evidenceSourceView({ ...matRef, hash: E.contentFingerprint({}) },
    { paras: [], mats: [{ ...MAT, facts: {} }] });
  assert.equal(emptyFacts.sourceState, 'unavailable');
  assert.equal(emptyFacts.sourceText, '');
  const outdated = E.evidenceSourceView(matRef, { paras: [], mats: [{ ...MAT, factStatus: 'outdated' }] });
  assert.equal(outdated.sourceState, 'stale');
  assert.equal(outdated.sourceText, '');
}
{
  // 历史评估记录：旧 sourced 降级为 missing，不升级为 covered；分数与结论保持原值
  const legacy = deepFreeze({
    id: 'ev-legacy', score: 4.5, verdict: 'caution',
    blocks: {
      score: 4.5, verdict: 'caution',
      matches: [{ req: '管理经验', status: 'sourced', evidence: '未经核验的素材声称' }]
    }
  });
  const before = JSON.stringify(legacy);
  const view = V.evalRecordView(legacy);
  assert.equal(view.sourceState, 'legacy');
  assert.equal(view.score, 4.5, '历史 score 不重算');
  assert.equal(view.verdict, 'caution', '历史 verdict 不重算');
  assert.equal(view.blocks.matches[0].status, 'missing');
  assert.notEqual(view.blocks.matches[0].status, 'covered', '旧 sourced 不得升级为 covered');
  assert.equal(view.blocks.matches[0].evidence, '');
  assert.equal(view.blocks.matches[0].compatibilityReason, 'LEGACY_SOURCED');
  assert.equal(JSON.stringify(legacy), before, '评估视图不得回写输入');
  const broken = V.evalRecordView({ source: { type: 'resume', docId: 7 }, blocks: { matches: null } });
  assert.equal(broken.sourceState, 'invalid');
  assert.deepEqual(broken.blocks.matches, []);
}

// ===== D. SRC-05 / SRC-06 eval：同一份可见正文 =====
{
  const html = (color) => '<!doctype html><html><head><style>p{color:' + color
    + '}</style></head><body><div class="sheet"><p>负责存储层改造</p>'
    + '<div class="ed-entry-hidden"><p>HIDDEN_DO_NOT_SEND</p></div>'
    + '<script>SCRIPT_DO_NOT_SEND()</script>'
    + '<div data-ai-panel="1">PANEL_DO_NOT_SEND</div></div></body></html>';
  const a = docToText(html('red'), { includeHidden: false });
  const b = docToText(html('blue'), { includeHidden: false });
  const changed = docToText(html('blue').replace('负责存储层改造', '负责数据库治理'), { includeHidden: false });
  assert.ok(a.includes('负责存储层改造'));
  for (const marker of ['HIDDEN_DO_NOT_SEND', 'SCRIPT_DO_NOT_SEND', 'PANEL_DO_NOT_SEND']) {
    assert.ok(!a.includes(marker), '隐藏/脚本/UI 内容不得进入评估正文：' + marker);
  }
  assert.equal(contentHash(a), contentHash(b), '样式变化不得改变正文 hash');
  assert.notEqual(contentHash(a), contentHash(changed), '正文变化必须改变 hash');
  // 来源 hash 与 prompt/parser 用同一份可见正文
  assert.deepEqual(V.evalSource(a, 'fixture-master'),
    { type: 'resume', docId: 'fixture-master', hash: contentHash(a) });
  assert.equal(V.evalSource(a, 'fixture-master').hash, V.evalSource(b, 'fixture-master').hash);
  assert.notEqual(V.evalSource(a, 'fixture-master').hash, V.evalSource(changed, 'fixture-master').hash);
}
{
  // 评估：每条展示引文都要核验；covered 无有效引文不得保留
  const evaluationRaw = (status, evidence) => JSON.stringify({
    score: 4, verdict: 'apply', matches: [{ req: '后端能力', status, evidence }]
  });
  const parse = (status, evidence, docText = P1.text) =>
    V.parseEvalReport(evaluationRaw(status, evidence), { docText }).report.matches[0];
  assert.equal(parse('covered', '负责存储层改造').status, 'covered');
  assert.deepEqual([parse('covered', '').status, parse('covered', '').evidence], ['partial', '']);
  assert.deepEqual([parse('covered', '不存在的引文').status, parse('covered', '不存在的引文').evidence], ['partial', '']);
  assert.equal(parse('partial', '负责存储层改造').evidence, '负责存储层改造');
  assert.deepEqual([parse('partial', '不存在的引文').status, parse('partial', '不存在的引文').evidence], ['partial', '']);
  assert.equal(parse('missing', '负责存储层改造').evidence, '');
  const legacySourced = parse('sourced', '素材库任意表述');
  assert.equal(legacySourced.status, 'missing');
  assert.equal(legacySourced.evidence, '');
  assert.equal(legacySourced.compatibilityReason, 'LEGACY_SOURCED');
  // 没有正文基准 → 不得声称 covered
  assert.deepEqual([parse('covered', '任意', '').status, parse('covered', '任意', '').evidence], ['partial', '']);
  // prompt 不再给模型「素材支持」这个选项
  const prompt = V.buildEvalPrompt({ docText: P1.text, jd: '后端要求', company: '合成公司', role: '后端' });
  assert.ok(prompt.sys.includes('"status":"covered|partial|missing"'));
  assert.ok(!prompt.sys.includes('covered|sourced'));
  assert.ok(!prompt.sys.includes('sourced='));
  assert.ok(prompt.user.includes(P1.text), 'prompt 与 parser 必须用同一份可见正文');
}

// ===== E. SRC-07 三个视图零回写 =====
{
  const interviewInput = deepFreeze({
    chains: [{ question: '测试', answerPoints: [{ text: '要点', quote: '负责存储层改造', anchored: true }] }],
    generic: [{ question: '自我介绍', answerPoints: [{ text: '思路', quote: '' }] }]
  });
  const evalInput = deepFreeze({
    id: 'ev-x', score: 3, verdict: 'caution',
    blocks: { matches: [{ req: '要求', status: 'sourced', evidence: '声称' }] }
  });
  const refInput = deepFreeze(rowFor(P1).refs[0]);
  const parasInput = deepFreeze([P1, P2]);
  const snapshots = [interviewInput, evalInput, refInput, parasInput].map((x) => structuredClone(x));

  E.interviewSourceView(interviewInput, { paras: parasInput });
  V.evalRecordView(evalInput);
  E.evidenceSourceView(refInput, { paras: parasInput, mats: [] });
  E.resolveInterviewSources({ evidence: [{ id: 'e1', req: '要求', refs: [refInput] }], paras: parasInput });

  assert.deepEqual(interviewInput, snapshots[0], '面试视图不得回写输入');
  assert.deepEqual(evalInput, snapshots[1], '评估视图不得回写输入');
  assert.deepEqual(refInput, snapshots[2], '来源视图不得回写输入');
  assert.deepEqual(parasInput, snapshots[3], '来源集合构造不得回写正文段落');
}

console.log('PASS SOURCES-01～07: true source catalog, shared prompt/parser sources, program-assigned source fields, legacy read-time downgrade, visible-text eval hash, zero-write views');
