// test-zone-quote-scan.mjs — 开标签末端必须引号感知（BL-P5-01，medium→数据完整性）
// 背景：unitTags 用朴素 indexOf('>') 定位属性区，属性值含 '>' 时（如 <p title="a>b">）把
// 标签截断在引号内 → normalizeZids 按截断片段重写开标签 → 每次保存都把正文改坏
// （属性值泄漏成可见文本、段落污染、该段 zid 绑定丢失）。
// 纯函数夹具：零 I/O、无服务。
import assert from 'node:assert/strict';
import { normalizeZids, zidsOf, zoneEditUnits } from '../../zone.mjs';

// ① 属性值含 '>'：归一不截断、不污染可见文本、zid 正常打上
const src = '<p title="a>b">正文一</p>';
const out1 = normalizeZids(src);
assert.ok(out1.includes('title="a>b"'), '属性值被截断/改写：' + out1);
// 泄漏判定不能裸查子串 'b">'：归一输出本身含 data-zid="z…b">（zid 末位随机，1/16 是 b），
// 裸查会把正确输出误判成泄漏（假红）。改锚定全文形态：title 完整 + 恰一个规范 zid + 正文无夹带。
assert.ok(/^<p title="a>b" data-zid="z[0-9a-f]{8}">正文一<\/p>$/.test(out1), '属性值泄漏成可见文本/归一形态异常：' + out1);
assert.ok(/<p\b[\s\S]*?data-zid="z[0-9a-f]{8}"/.test(out1), 'zid 未打上：' + out1);
assert.equal((out1.match(/data-zid=/g) || []).length, 1, 'data-zid 数量不是 1：' + out1);

// ② 幂等：已规范输入二次归一原样返回
const out2 = normalizeZids(out1);
assert.equal(out2, out1, '归一不幂等：' + out2);

// ③ 读侧一致：zidsOf / zoneEditUnits 在含 '>' 属性值的输入上正常产出
const zids = zidsOf(out1);
assert.equal(zids.length, 1, 'zidsOf 应找到 1 个 zid：' + JSON.stringify(zids));
const units = zoneEditUnits('<body>' + out1 + '正文一</p></body>');
assert.equal(units.length, 1, 'zoneEditUnits 应产出 1 个单位');
assert.equal(units[0].count, 1);

// ④ 单引号属性值同样不截断
const outS = normalizeZids("<p title='x>y'>正文二</p>");
assert.ok(outS.includes("title='x>y'"), '单引号属性值被截断：' + outS);
assert.ok(/data-zid="z[0-9a-f]{8}"/.test(outS), '单引号场景 zid 未打上：' + outS);

// ⑤ 对照：普通无属性段落行为不回归
const ctl = normalizeZids('<p>正文三</p>');
assert.ok(/<p data-zid="z[0-9a-f]{8}">正文三<\/p>/.test(ctl), '普通段落归一被回归：' + ctl);

console.log('✅ zone 引号感知扫描：含 > 的属性值不再截断正文/不丢 zid/幂等/读侧一致/普通段落不回归');
