// test-fact-num-equivalence.mjs — 事实护栏：阿拉伯 ↔ 中文小数词等价改写不得判丢失/引入（BL-P5-02）
// 背景：NUM_RE 为防「负责百度搜索」误报，不把无单位的单字数词（三/五/十二）当数字；于是
// 「3年」→「三年」被判「原文数字未原值保留：3」阻断导出，反向「三年」→「3年」被判「引入原文没有的数字」。
// 修法：对 0–99 整数做阿拉伯↔中文写法等价豁免（2 兼容「两」）。政策沿用护栏自述「漏报优于误报」。
// 纯函数夹具：零 I/O。
import assert from 'node:assert/strict';
import { factGuard } from '../../job.mjs';

// factGuard 返回带 reason 的候选对象（多条 note 以「；」拼接）→ 拆回条目数组
const notesOf = (before, after) => { const c = factGuard({ kind: 'replace', before, after }); return c.reason ? String(c.reason).split('；') : []; };
const hasLoss = (ns) => ns.some((n) => n.includes('原文数字未原值保留'));
const hasAdd = (ns) => ns.some((n) => n.includes('引入原文没有的数字'));

// ① 阿拉伯 → 中文：不得判丢失
for (const [b, a] of [['3年经验', '三年经验'], ['5人团队', '五人团队'], ['12个模块', '十二个模块'], ['2年', '两年'], ['20家客户', '二十家客户'], ['35岁以下', '三十五岁以下']]) {
  const ns = notesOf(b, a);
  assert.ok(!hasLoss(ns), `[${b}→${a}] 等价改写被判丢失：` + JSON.stringify(ns));
}
// ② 中文 → 阿拉伯：不得判引入
for (const [b, a] of [['三年经验', '3年经验'], ['两年', '2年'], ['十二个模块', '12个模块']]) {
  const ns = notesOf(b, a);
  assert.ok(!hasAdd(ns), `[${b}→${a}] 等价改写被判引入：` + JSON.stringify(ns));
}
// ③ 对照：真丢数字仍拦得住
assert.ok(hasLoss(notesOf('3年经验', '丰富经验')), '真丢「3」应报丢失');
assert.ok(hasLoss(notesOf('管理两百人团队', '管理团队')), '真丢「两百」应报丢失');
// ④ 对照：真改数字仍拦得住（3 → 五 不等价）
assert.ok(hasLoss(notesOf('3年经验', '五年经验')), '「3年→五年」应报原数字丢失');
// ⑤ 对照：既有「百度」免疫不回退、带单位数词等价不回退
assert.equal(notesOf('负责百度搜索优化', '负责百度搜索的优化').length, 0, '「百度」不得被当数字');
assert.ok(!hasLoss(notesOf('管理两百人', '管理200人')), '两百 ↔ 200 既有等价不回退');

console.log('✅ 事实护栏数词等价：0–99 阿拉伯↔中文写法互认（含「两」），真丢/真改仍拦、百度免疫与带单位等价不回退');
