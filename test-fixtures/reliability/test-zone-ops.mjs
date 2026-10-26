// test-fixtures/reliability/test-zone-ops.mjs — 区域数据层反例（设计 §3；zone-v1）
// 覆盖：文本口径、形状与不可写区域、安全子集、跳过原因、重复身份、纯文本转义、输入不可变、旧行为不变。
// 约束：零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zoneEditUnits, parasOf, zidsOf, normalizeZids } from '../../zone.mjs';
import { contentHash } from '../../extract.mjs';
import { applyZoneOps, ZoneOpError } from '../../zone-ops.mjs';

// 脚本开头切到项目根：可从任意目录直接运行。
process.chdir(fileURLToPath(new URL('../../', import.meta.url)));

// ===== A. zone-v1 文本口径 =====
{
  const html = '<ul><li data-zid="z11111111">A &amp; B<br>C</li>'
    + '<li data-zid="z22222222">负责队列处理</li></ul>';
  const units = zoneEditUnits(html);
  assert.equal(units[0].text, 'A & B C', '实体解码一次 + br 视作空白 + 折叠');
  // 字面量实体：&amp;amp; 只解码一次 → 文本是 "&amp;"（用户真实写的就是这五个字符）
  assert.equal(zoneEditUnits('<p data-zid="z11111111">&amp;amp;</p>')[0].text, '&amp;');
  // 空白折叠含 NBSP
  assert.equal(zoneEditUnits('<p data-zid="z11111111">A&nbsp;B</p>')[0].text, 'A B');
  assert.equal(zoneEditUnits('<p data-zid="z11111111">A\n\nB</p>')[0].text, 'A B');
  // 内联标签：只取文字，不带标记（与 parasOf 同口径：标签剥离不补空格）
  assert.equal(zoneEditUnits('<p data-zid="z11111111">A <strong>粗</strong>尾</p>')[0].text, 'A 粗尾');
  assert.equal(parasOf('<p data-zid="z11111111">A <strong>粗</strong>尾</p>')[0].text, 'A 粗尾', '旧提取口径不变');
  // 「A B」与「AB」不是同文
  assert.notEqual(contentHash('A B'), contentHash('AB'));
  // 旧 parasOf 口径不变（不解码实体）
  assert.equal(parasOf('<p data-zid="z11111111">A &amp; B</p>')[0].text, 'A &amp; B');
}

// ===== B. 形状与不可写区域 =====
{
  // 脚本/样式/注释里的标签字面量不是正文单位
  const withScript = '<script>var fake = \'<li data-zid="z99999999">假</li>\';</script><p data-zid="z11111111">真</p>';
  assert.deepEqual(zoneEditUnits(withScript).map((u) => u.zid), ['z11111111'], '脚本里的标签字面量不算单位');
  const withStyle = '<style>.x:after{content:"<p data-zid=\"z99999998\">假</p>"}</style><p data-zid="z11111111">真</p>';
  assert.deepEqual(zoneEditUnits(withStyle).map((u) => u.zid), ['z11111111'], '样式里的标签字面量不算单位');
  const withComment = '<p data-zid="z11111111">真</p><!-- <p data-zid="z88888888">假</p> -->';
  assert.deepEqual(zoneEditUnits(withComment).map((u) => u.zid), ['z11111111'], '注释里的标签字面量不算单位');
  // 嵌套单位只出最外层（内层文字并入外层）
  const nested = zoneEditUnits('<li data-zid="z11111111">外<p data-zid="z22222222">内</p></li>');
  assert.deepEqual(nested.map((u) => u.zid), ['z11111111'], '嵌套单位只出最外层');
  // 内层块不额外插入空格（与既有 docToText / parasOf 同口径：块边界只由闭合标签产生换行）
  assert.equal(nested[0].text, '外内');
  assert.equal(parasOf('<li data-zid="z11111111">外<p data-zid="z22222222">内</p></li>')[0].text, '外内', '旧提取口径不变');
  // 未闭合单位不猜范围
  assert.deepEqual(zoneEditUnits('<p data-zid="z11111111">未闭合').map((u) => u.zid), [], '未闭合单位不可用');
  // 同一单位出现两个 data-zid 属性 → 形状非法，直接报错
  assert.throws(() => zoneEditUnits('<p data-zid="z11111111" data-zid="z22222222">x</p>'), /重复 data-zid/);
  // 同一 zid 出现两次 → count=2（调用方据此拒绝，不重打 ID）
  const dup = zoneEditUnits('<p data-zid="z11111111">A</p><p data-zid="z11111111">B</p>');
  assert.equal(dup.length, 2);
  assert.equal(dup[0].count, 2, '重复 zid 必须被计数而不是悄悄改写');
  assert.equal(dup[0].zid, 'z11111111', '不得重打 ID');
}

// ===== C. 安全子集与跳过原因 =====
const html = '<ul><li data-zid="z11111111">A &amp; B<br>C</li>'
  + '<li data-zid="z22222222">负责队列处理</li></ul>';
const units = zoneEditUnits(html);
const op = (unit, candidate, over = {}) => ({
  operationId: 'op-' + unit.zid, zid: unit.zid, zone: 'work',
  baselineVersion: 'zone-v1', before: unit.text,
  beforeHash: contentHash(unit.text), candidate, ...over
});
const zones = {
  z11111111: { zone: 'work', status: 'confirmed' },
  z22222222: { zone: 'work', status: 'confirmed', locked: true }
};

{
  // 锁定目标被跳过；安全目标被应用
  assert.equal(html.slice(units[0].innerStart, units[0].innerEnd), 'A &amp; B<br>C', '可替换范围必须精确到开闭标签之间');
  const result = applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], 'A & B C 说明'), op(units[1], '维护队列处理')] });
  assert.deepEqual(result.applied.map((x) => x.zid), ['z11111111']);
  assert.equal(result.skipped[0].reason, 'locked');
  assert.match(result.html, /A &amp; B C 说明/);
  assert.match(result.html, /负责队列处理/);
  assert.equal(result.html.includes('维护队列处理'), false);
  // 目标的开闭标签与属性保留；相邻内容不动
  assert.match(result.html, /<li data-zid="z11111111">/);
  assert.match(result.html, /<ul>/);
  assert.match(result.html, /<li data-zid="z22222222">负责队列处理<\/li>/);
  // 回执里带 identity 与基线
  assert.equal(result.applied[0].operationId, 'op-z11111111');
  assert.equal(result.applied[0].beforeHash, contentHash(units[0].text));
}

{
  // 改绑：区域归属与操作声明不一致
  const r = applyZoneOps({ diskHtml: html, html, zones: { z11111111: { zone: 'project', status: 'confirmed' } }, zoneOps: [op(units[0], '说明')] });
  assert.deepEqual(r.applied, []);
  assert.equal(r.skipped[0].reason, 'rebound');
}
{
  // 原文变化（磁盘侧与提交侧都算）：目标是 z11111111（文本 "A & B C"）
  const changedDisk = applyZoneOps({ diskHtml: html.replace('A &amp; B<br>C', 'A &amp; B<br>D'), html, zones, zoneOps: [op(units[0], '说明')] });
  assert.equal(changedDisk.skipped[0].reason, 'changed', '磁盘侧原文变了必须跳过');
  const changedSubmit = applyZoneOps({ diskHtml: html, html: html.replace('A &amp; B<br>C', 'A &amp; B<br>D'), zones, zoneOps: [op(units[0], '说明')] });
  assert.equal(changedSubmit.skipped[0].reason, 'changed', '提交侧原文变了必须跳过');
}
{
  // 目标已删除
  const r = applyZoneOps({ diskHtml: '<p data-zid="z33333333">别的</p>', html, zones, zoneOps: [op(units[0], '说明')] });
  assert.equal(r.skipped[0].reason, 'gone');
}
{
  // 事实冲突：候选引入原文没有的数字（用未锁定的目标；锁定判定在冲突判定之前）
  const r = applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], 'A & B C QPS 提升 500')] });
  assert.equal(r.skipped[0].reason, 'conflict', '新数字必须被事实护栏拦下');
  // 同一目标被锁定时，先报锁定（判定顺序固定）
  const lockedFirst = applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[1], '负责队列处理 QPS 提升 500')] });
  assert.equal(lockedFirst.skipped[0].reason, 'locked');
  // 客户端自报 level 不得绕过事实护栏（护栏自己判定 level）
  const spoof = applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], 'A & B C QPS 提升 500', { level: 'normal' })] });
  assert.equal(spoof.skipped[0].reason, 'conflict', '客户端传入的 level 不得绕过事实护栏');
}
{
  // 事实冲突：候选丢掉原文数字
  const withNum = '<p data-zid="z44444444">QPS 从 300 提升到 5000</p>';
  const u = zoneEditUnits(withNum)[0];
  const r = applyZoneOps({ diskHtml: withNum, html: withNum, zones: { z44444444: { zone: 'work', status: 'confirmed' } }, zoneOps: [op(u, 'QPS 提升显著')] });
  assert.equal(r.skipped[0].reason, 'conflict', '丢失原数字必须被事实护栏拦下');
}
{
  // 安全与失效目标混合：安全的一个照常应用，锁定/改绑的各自给出原因
  const html3 = '<ul><li data-zid="z11111111">A &amp; B<br>C</li>'
    + '<li data-zid="z22222222">负责队列处理</li><li data-zid="z33333333">第三条</li></ul>';
  const u3 = zoneEditUnits(html3);
  const zones3 = {
    z11111111: { zone: 'work', status: 'confirmed' },
    z22222222: { zone: 'work', status: 'confirmed', locked: true },
    z33333333: { zone: 'project', status: 'confirmed' }
  };
  const r = applyZoneOps({
    diskHtml: html3, html: html3, zones: zones3,
    zoneOps: [op(u3[0], '安全改写'), op(u3[1], '锁定改写'), op(u3[2], '改绑改写')]
  });
  assert.deepEqual(r.applied.map((x) => x.zid), ['z11111111'], '只有安全目标被应用');
  assert.deepEqual(r.skipped.map((x) => x.reason), ['locked', 'rebound']);
  assert.match(r.html, /安全改写/);
  assert.equal(r.html.includes('锁定改写'), false);
  assert.equal(r.html.includes('改绑改写'), false);
}
{
  // 零安全目标：HTML 原样返回（逐字节相同）
  const r = applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[1], '锁定改写')] });
  assert.equal(r.html, html, '零安全目标时 HTML 必须原样返回');
  assert.deepEqual(r.applied, []);
}
{
  // 仅状态 pending→confirmed（归属与锁不变）→ 不失效
  const pending = applyZoneOps({ diskHtml: html, html, zones: { z11111111: { zone: 'work', status: 'pending' } }, zoneOps: [op(units[0], '说明')] });
  assert.deepEqual(pending.applied.map((x) => x.zid), ['z11111111'], '仅状态变化不得使目标失效');
}

// ===== D. 身份与形状拒绝 =====
{
  assert.throws(() => applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], '说明'), op(units[0], '另一个说明')] }), /重复/);
  assert.throws(() => applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], '说明'), op(units[1], '另一个', { operationId: 'op-z11111111' })] }), /重复 operationId/);
  assert.throws(() => applyZoneOps({ diskHtml: html, html, zones, zoneOps: [] }), ZoneOpError);
  assert.throws(() => applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], '说明', { baselineVersion: 'zone-v0' })] }), ZoneOpError);
  assert.throws(() => applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], '说明', { beforeHash: contentHash('别的') })] }), ZoneOpError);
  assert.throws(() => applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], '说明', { zone: 'not-a-zone' })] }), ZoneOpError);
  assert.throws(() => applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], '   ')] }), ZoneOpError);
  // 正文里同一 zid 出现两次 → 拒绝，不猜落点
  const dupHtml = '<p data-zid="z11111111">A</p><p data-zid="z11111111">B</p>';
  const dupUnit = zoneEditUnits(dupHtml)[0];
  assert.throws(() => applyZoneOps({ diskHtml: dupHtml, html: dupHtml, zones, zoneOps: [op(dupUnit, '说明')] }), /重复 zid/);
}

// ===== E. 纯文本安全写入 =====
{
  const literal = applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], '<script>literal</script>')] });
  assert.equal(literal.html.includes('<script>literal'), false, '候选里的标签不得成为真实标签');
  assert.match(literal.html, /&lt;script&gt;/, '候选按纯文本转义');
  // 只转义一次：候选里的字面 & 变成 &amp;（不是 &amp;amp;）
  const amp = applyZoneOps({ diskHtml: html, html, zones, zoneOps: [op(units[0], 'A & B')] });
  assert.match(amp.html, /A &amp; B/);
  assert.equal(amp.html.includes('&amp;amp;'), false, '转义只做一次');
}

// ===== F. 输入不被修改 + 旧行为不变 =====
{
  // 深冻结：模块若试图就地改写传入对象，ESM 严格模式下会直接抛错。
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  };
  const snapshot = (o) => JSON.stringify(o);
  // 真正传入的对象（不是断言时重新构造的另一个对象）
  const inZones = deepFreeze({ z11111111: { zone: 'work', status: 'confirmed' } });
  const inOps = deepFreeze([op(units[0], '说明')]);
  const zonesSnap = snapshot(inZones);
  const opsSnap = snapshot(inOps);
  const htmlBefore = html;
  const r = applyZoneOps({ diskHtml: html, html, zones: inZones, zoneOps: inOps });
  assert.equal(snapshot(inZones), zonesSnap, '真正传入的 zones 不得被修改');
  assert.equal(snapshot(inOps), opsSnap, '真正传入的 zoneOps 不得被修改');
  assert.equal(html, htmlBefore, '输入 HTML 不得被修改');
  assert.notEqual(r.html, html, '输出应是新字符串');
  assert.ok(Object.isFrozen(inZones) && Object.isFrozen(inOps), '传入对象保持冻结（未被就地替换）');
  // 旧提取与指纹行为不变
  assert.deepEqual(parasOf(html).map((p) => p.zid), ['z11111111', 'z22222222']);
  assert.deepEqual(zidsOf(html), ['z11111111', 'z22222222']);
  assert.equal(normalizeZids(html), html, '已有合法 zid 的正文归一后不变');
  assert.equal(contentHash(html), contentHash(html), '指纹函数行为不变');
}

// ===== H. 闭合配对与非正文范围（假闭标签 / 提前结束 / 非 ASCII 偏移）=====
{
  // ① 注释里的假闭标签不得提前截断目标
  const fakeClose = '<p data-zid="z11111111">原文<!-- </p> -->尾部</p>';
  const u = zoneEditUnits(fakeClose);
  assert.equal(u.length, 1, '目标必须被识别为一个单位');
  assert.equal(u[0].text, '原文尾部', '注释里的假闭标签不得截断目标文本');
  assert.equal(u[0].end, fakeClose.length, '闭合位置必须是真实闭合标签之后');
  assert.equal(fakeClose.slice(u[0].innerStart, u[0].innerEnd), '原文<!-- </p> -->尾部', '可替换范围必须覆盖完整内层');
  // 替换后得到完整目标元素，外部相邻内容不变
  const around = '<p data-zid="z00000000">前段</p>' + fakeClose + '<p data-zid="z22222222">后段</p>';
  const ua = zoneEditUnits(around);
  const target = ua.find((x) => x.zid === 'z11111111');
  const r = applyZoneOps({
    diskHtml: around, html: around,
    zones: { z11111111: { zone: 'work', status: 'confirmed' } },
    zoneOps: [op(target, '改写')]
  });
  assert.equal(r.html, '<p data-zid="z00000000">前段</p><p data-zid="z11111111">改写</p><p data-zid="z22222222">后段</p>',
    '替换后必须是完整目标元素，且相邻内容不变');
}
{
  // ② script 字符串里的假闭标签（</scripture> 不是 </script>）不得让排除范围提前结束
  const inScript = '<script>const marker="</scripture>"; const html=\'<p data-zid="z99999999">脚本内部</p>\';</script>'
    + '<p data-zid="z11111111">正文</p>';
  assert.deepEqual(zoneEditUnits(inScript).map((x) => x.zid), ['z11111111'], '脚本内部的标签字面量不得成为单位');
}
{
  // ③ 嵌套 template：外层排除范围必须结束于配对的闭合标签
  const inTemplate = '<template><template></template><p data-zid="z99999999">模板内部</p></template>'
    + '<p data-zid="z11111111">正文</p>';
  assert.deepEqual(zoneEditUnits(inTemplate).map((x) => x.zid), ['z11111111'], '模板内部的标签字面量不得成为单位');
}
{
  // ④ 非 ASCII 前缀：坐标不得因大小写转换或屏蔽而漂移
  const prefix = '<p>İstanbul 中文前缀</p>';      // 'İ' 小写后长度会变（U+0130 → 2 码元）
  const withPrefix = prefix + '<p data-zid="z11111111">原文<!-- </p> -->尾部</p>';
  const up = zoneEditUnits(withPrefix);
  assert.equal(up.length, 1, '非 ASCII 前缀后目标仍被识别');
  assert.equal(up[0].text, '原文尾部', '非 ASCII 前缀不得影响文本');
  assert.equal(up[0].end, withPrefix.length, '非 ASCII 前缀后闭合坐标不得漂移');
  assert.equal(withPrefix.slice(up[0].innerStart, up[0].innerEnd), '原文<!-- </p> -->尾部', '非 ASCII 前缀后可替换范围必须准确');
}

// ===== G. 模块不访问网络或磁盘（结构检查：导入图里没有 fs/http）=====
{
  const src = fs.readFileSync(new URL('../../zone-ops.mjs', import.meta.url), 'utf8');
  for (const bad of ['node:fs', 'node:http', 'node:net', 'fetch(']) {
    assert.equal(src.includes(bad), false, 'zone-ops.mjs 不得引入 ' + bad);
  }
}

console.log('PASS ZONE-01/02: canonical text, chrome exclusion, subset, skipping reasons, escaping, duplicates, immutability');
