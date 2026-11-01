// test-fact-date-space.mjs — 事实护栏：日期两种空格写法不得判丢失（BL-P5-03）
// 背景：DATE_TOKEN_RE 允许 `\s*[.\-/年]\s*`（分隔符两侧空格），dateParts 的正则却没有 `\s*` 前缀
// → 「2024 . 1」被摘出为日期 token，但归一只得到年（月丢失）→ 与「2024.1」归一不同 → 误判
// 「原文日期未原值保留」阻断导出。修法：dateParts 与 DATE_TOKEN_RE 对空格的容忍度对齐。
// 纯函数夹具：零 I/O。
import assert from 'node:assert/strict';
import { factGuard } from '../../job.mjs';

// factGuard 返回带 reason 的候选对象（多条 note 以「；」拼接）→ 拆回条目数组
const notesOf = (before, after) => { const c = factGuard({ kind: 'replace', before, after }); return c.reason ? String(c.reason).split('；') : []; };
const hasDateLoss = (ns) => ns.some((n) => n.includes('原文日期未原值保留'));

// ① 同一日期两种空格写法：不得判丢失（双向）
for (const [b, a] of [
  ['2024.1 入职', '2024 . 1 入职'],
  ['2024 . 1 入职', '2024.1 入职'],
  ['2019年6月', '2019 年 6 月'],
  ['2019 年 6 月', '2019年6月'],
  ['2021-03', '2021 - 03'],
]) {
  const ns = notesOf(b, a);
  assert.ok(!hasDateLoss(ns), `[${b}→${a}] 同日期空格写法被判丢失：` + JSON.stringify(ns));
}
// ② 既有格式等价不回退：2019.06 / 2019年6月 / 2019年06月
assert.ok(!hasDateLoss(notesOf('2019.06 起', '2019年6月 起')), '既有格式等价回退');
assert.ok(!hasDateLoss(notesOf('2019年06月 起', '2019.6 起')), '既有格式等价回退（补零）');
// ③ 对照：真改日期仍拦得住
assert.ok(hasDateLoss(notesOf('2022.03 加入', '2023.05 加入')), '真改日期应报丢失');
assert.ok(hasDateLoss(notesOf('2019 年 6 月', '2019 年 8 月')), '空格写法下真改月份也应报丢失');

console.log('✅ 事实护栏日期空格：分隔符两侧空格的两种写法归一一致（不误报），真改日期仍拦，既有格式等价不回退');
