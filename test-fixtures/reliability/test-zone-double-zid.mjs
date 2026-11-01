// test-zone-double-zid.mjs — data-zid 属性形态放宽 + 归一替换不追加（BL-P5-05，medium）
// 背景：ZID_ATTR/ZID_ANY_ATTR 只认「双引号且等号两侧无空格」形态。属性写成单引号/带空格/
// 无引号时，合法 zid 匹配不到 → 归一当作缺失打新值，而摘除正则也匹配不到旧值 → 同一元素
// 两个 data-zid 属性 → zoneEditUnits 抛「重复 data-zid」→ 该文档的区域保存通道永久 400。
// 纯函数夹具：零 I/O、无服务。
import assert from 'node:assert/strict';
import { normalizeZids, zoneEditUnits } from '../../zone.mjs';

const forms = [
  ['单引号', "<p data-zid='z11111111'>x</p>", 'z11111111'],
  ['等号两侧空格', '<p data-zid = "z22222222">x</p>', 'z22222222'],
  ['无引号', '<p data-zid=z33333333>x</p>', 'z33333333']
];

for (const [name, src, zid] of forms) {
  const out = normalizeZids(src);
  // ① 恰好一个 data-zid 属性，且保留原合法值（规范成双引号形态）
  assert.equal((out.match(/data-zid\s*=/g) || []).length, 1, `[${name}] data-zid 属性数不是 1：` + out);
  assert.ok(out.includes(`data-zid="${zid}"`), `[${name}] 原 zid 未保留或未规范化：` + out);
  // ② 归一后 zoneEditUnits 不抛、count=1（区域保存通道不再永久 400）
  let units = null;
  assert.doesNotThrow(() => { units = zoneEditUnits('<body>' + out + 'x</p></body>'); }, `[${name}] zoneEditUnits 抛重复 data-zid`);
  assert.equal(units.length, 1, `[${name}] zoneEditUnits 产出数异常`);
  assert.equal(units[0].count, 1, `[${name}] count 应为 1`);
  assert.equal(units[0].zid, zid, `[${name}] zid 取值异常`);
  // ③ 幂等
  assert.equal(normalizeZids(out), out, `[${name}] 归一不幂等：` + normalizeZids(out));
}

// ④ 坏值仍然摘旧打新（不回归），且同样只留一个属性
const bad = normalizeZids('<p data-zid="not-a-zid">x</p>');
assert.equal((bad.match(/data-zid\s*=/g) || []).length, 1, '坏值场景 data-zid 属性数不是 1：' + bad);
assert.ok(/data-zid="z[0-9a-f]{8}"/.test(bad), '坏值未重打：' + bad);
// ⑤ 单引号坏值同样摘旧打新
const badS = normalizeZids("<p data-zid='nope'>x</p>");
assert.equal((badS.match(/data-zid\s*=/g) || []).length, 1, '单引号坏值场景 data-zid 属性数不是 1：' + badS);
assert.ok(/data-zid="z[0-9a-f]{8}"/.test(badS), '单引号坏值未重打：' + badS);

console.log('✅ zone data-zid 形态放宽：单引号/空格/无引号均识别且归一替换不追加（区域保存通道不再 400）');
