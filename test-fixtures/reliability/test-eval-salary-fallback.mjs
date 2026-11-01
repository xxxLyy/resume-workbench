// test-fixtures/reliability/test-eval-salary-fallback.mjs — BL-P4-01 薪资矛盾组合回落（复核 13110 收窄口径）
// 覆盖：salary 归一的四个组合探针——
//       A 矛盾回落：text 非空 + source「JD 未提供」→ 回落空文本（eval.mjs 注释点名、此前未执行的另一半）
//       B 矛盾回落：text 空 + source「JD 自带」→ 回落空文本（既有 if(!t) 半边，守住不回退）
//       C 空文本回落：合法空组合保持空；纯空白 text 视同空
//       D 非法 source 归一：枚举外 source 归「JD 未提供」，text 原样保留（既有契约，
//         与 test-structure.sh EV-3 ④ 的「salary.text 原样保留」同口径）
//       外加守卫：合法组合（JD 自带 + 非空 text）必须原样通过，修复不得扩大回落面。
// 约束：纯函数夹具，零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import { parseEvalReport } from '../../eval.mjs';

const DOC = '合成母版正文：负责存储层改造，交付异步任务平台。';
const parse = (salary) => parseEvalReport(JSON.stringify({
  score: 4.5, verdict: 'apply', salary, matches: []
}), { docText: DOC }).report.salary;

// ===== A. 矛盾组合回落：模型给了数字却声称「JD 未提供」→ 自相矛盾，回落为空 =====
{
  const out = parse({ text: '年薪 100 万', source: 'JD 未提供' });
  assert.deepEqual(out, { text: '', source: 'JD 未提供' },
    'A 矛盾组合（text 非空 + JD 未提供）必须回落空文本，实际 ' + JSON.stringify(out));
}

// ===== B. 矛盾组合回落：模型声称「JD 自带」却没给数字 → 回落为空 + 未提供（既有半边） =====
{
  const out = parse({ text: '', source: 'JD 自带' });
  assert.deepEqual(out, { text: '', source: 'JD 未提供' },
    'B 矛盾组合（text 空 + JD 自带）必须回落，实际 ' + JSON.stringify(out));
}

// ===== C. 空文本回落：合法空组合保持空；纯空白 text 视同空 =====
{
  assert.deepEqual(parse({ text: '', source: 'JD 未提供' }),
    { text: '', source: 'JD 未提供' }, 'C 合法空组合应保持空文本 + 未提供');
  assert.deepEqual(parse({ text: '   ', source: 'JD 自带' }),
    { text: '', source: 'JD 未提供' }, 'C 纯空白 text 应视同空并回落');
}

// ===== D. 非法 source 归一：枚举外 source 归「JD 未提供」，text 原样保留（既有契约，不扩大） =====
{
  const out = parse({ text: '月薪 3 万', source: '模型瞎猜的出处' });
  assert.deepEqual(out, { text: '月薪 3 万', source: 'JD 未提供' },
    'D 非法 source 只归一标签、不动 text，实际 ' + JSON.stringify(out));
}

// ===== 守卫：合法组合（JD 自带 + 非空 text）原样通过，回落分支不得误伤 =====
{
  const out = parse({ text: '月薪 1.5 万 · 14 薪', source: 'JD 自带' });
  assert.deepEqual(out, { text: '月薪 1.5 万 · 14 薪', source: 'JD 自带' },
    '守卫 合法组合必须原样保留，实际 ' + JSON.stringify(out));
}

console.log('PASS EVAL-SALARY-FALLBACK: salary 矛盾组合回落（A/B）+ 空文本回落（C）+ 非法 source 归一（D）+ 合法组合守卫');
