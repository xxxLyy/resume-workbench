// test-fixtures/reliability/test-eval-quote-minlen.mjs — BL-P4-02 引文最小长度护栏
// 覆盖：eval.mjs 引文命中判定加长度下限，与 evidence.mjs:556 同款——normSpace 后 <6 码元不算命中，
//       covered 降 partial（走既有 evidence 清空分支，无需新分支）。
//       探针引文全部是母版逐字子串（含边界 6 码元），长度是唯一变量：
//       「的」(1)/「负责」(2)/「存储层改造」(5) 不再算「已有证据」；
//       「负责存储层改」(6，边界)/「负责存储层改造」(7) 仍算。
// 约束：纯函数夹具，零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import { parseEvalReport } from '../../eval.mjs';

// 母版正文：所有探针引文都是它的逐字子串
const DOC = '负责存储层改造，张三的职责是高并发服务治理。';
const matchOf = (status, evidence) => {
  const r = parseEvalReport(JSON.stringify({
    score: 4, verdict: 'apply', matches: [{ req: '后端能力', status, evidence }]
  }), { docText: DOC });
  assert.equal(r.ok, true, '合成报告必须解析成功');
  return r.report.matches[0];
};

// ===== A. 短引文不再保住 covered：1/2/5 码元的真子串一律降 partial + 清证据 =====
{
  const short = [['的', 1], ['负责', 2], ['存储层改造', 5]];
  for (const [quote, len] of short) {
    const m = matchOf('covered', quote);
    assert.deepEqual(
      [m.status, m.evidence], ['partial', ''],
      `「${quote}」(${len} 码元) 不得算「已有证据」，实际 ${JSON.stringify(m)}`);
  }
}

// ===== G. 长度门不得误伤：6 码元边界与 7 码元真子串仍保留 covered + 原文 =====
{
  const kept = [['负责存储层改', 6], ['负责存储层改造', 7]];
  for (const [quote, len] of kept) {
    const m = matchOf('covered', quote);
    assert.deepEqual(
      [m.status, m.evidence], ['covered', quote],
      `「${quote}」(${len} 码元) 是有效锚定，必须保留，实际 ${JSON.stringify(m)}`);
  }
}

// ===== 既有语义不回退：空引文 / 编造引文仍走清空降级；partial 的伪引文仍清空 =====
{
  assert.deepEqual([matchOf('covered', '').status, matchOf('covered', '').evidence], ['partial', ''],
    '空引文 covered 降 partial');
  assert.deepEqual([matchOf('covered', '母版里没有的引文').status, matchOf('covered', '母版里没有的引文').evidence],
    ['partial', ''], '编造引文清空降级');
  assert.deepEqual([matchOf('partial', '的').status, matchOf('partial', '的').evidence], ['partial', ''],
    'partial 的短引文仍清空、状态保留');
}

console.log('PASS EVAL-QUOTE-MINLEN: <6 码元引文不算命中（的/负责/5码元 → partial+清空）、6/7 码元真子串保留 covered、空引文与编造引文语义不回退');
