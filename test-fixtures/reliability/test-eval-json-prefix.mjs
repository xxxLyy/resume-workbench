// test-fixtures/reliability/test-eval-json-prefix.mjs — BL-P4-05 JSON 前带自然语言整份作废
// 覆盖：parse 失败时二次尝试——截取首个 { 到最后一个 } 再 parse，仍败才 ok:false：
//       A 前缀句 + 合法 JSON 正常解析；A2 后缀句同理（首个 { 到最后一个 } 的对称半边）；
//       B 纯文本仍报错；C 带花括号的畸形输出重试后仍败；D 数组仍按「不是 JSON 对象」作废；
//       E 裸 JSON 基线路径不变。
// 约束：纯函数夹具，零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import { parseEvalReport } from '../../eval.mjs';

const BODY = '{"roleSummary":"合成岗位摘要","score":4,"verdict":"apply","salary":{"text":"","source":"JD 未提供"},"matches":[],"gaps":[]}';

// ===== A. 前缀句 + 合法 JSON：不再整份作废，正常解析 =====
{
  const r = parseEvalReport(`好的，以下是本次评估报告：${BODY}`, { docText: '合成母版正文' });
  assert.equal(r.ok, true, `前缀句 + 合法 JSON 必须能解析，实际 ok=${r.ok} reason=${r.reason}`);
  assert.equal(r.report.score, 4, '前缀句场景 score 必须正确解析');
  assert.equal(r.report.verdict, 'apply', '前缀句场景 verdict 必须正确解析');
  assert.deepEqual(r.report.salary, { text: '', source: 'JD 未提供' }, '前缀句场景 salary 必须正确解析');
}

// ===== A2. 后缀句（JSON 后跟一句自然语言）：同一合同的后半边，也要能解析 =====
{
  const r = parseEvalReport(`${BODY} 以上，请参考。`, { docText: '合成母版正文' });
  assert.equal(r.ok, true, `后缀句 + 合法 JSON 必须能解析，实际 ok=${r.ok} reason=${r.reason}`);
  assert.equal(r.report.score, 4, '后缀句场景 score 必须正确解析');
}

// ===== B. 纯文本（无任何 JSON 体）：仍然报错，不得瞎猜 =====
{
  const r = parseEvalReport('这不是 JSON，很抱歉我无法输出。', { docText: '合成母版正文' });
  assert.equal(r.ok, false, '纯文本必须 ok:false');
  assert.equal(r.report, null, '纯文本不得带出报告');
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, '纯文本必须带 reason');
}

// ===== C. 带花括号的畸形输出：重试后仍败，干净作废 =====
{
  const r = parseEvalReport('报告如下：{"score":', { docText: '合成母版正文' });
  assert.equal(r.ok, false, '畸形 JSON 重试后必须仍 ok:false');
  assert.equal(r.report, null, '畸形 JSON 不得带出报告');
}

// ===== D. 数组：JSON.parse 能过但不是对象 → 仍按「不是 JSON 对象」作废（既有契约不回退） =====
{
  const r = parseEvalReport('[1,2]', { docText: '合成母版正文' });
  assert.equal(r.ok, false, '数组必须 ok:false');
}

// ===== E. 裸 JSON 基线：直连路径不受二次尝试影响 =====
{
  const r = parseEvalReport(BODY, { docText: '合成母版正文' });
  assert.equal(r.ok, true, '裸 JSON 必须照常解析');
  assert.equal(r.report.score, 4, '裸 JSON score 正确');
}

console.log('PASS EVAL-JSON-PREFIX: 前缀/后缀自然语言不再整份作废（首个{到最后}重试）、纯文本与畸形仍干净报错、数组与裸 JSON 契约不回退');
