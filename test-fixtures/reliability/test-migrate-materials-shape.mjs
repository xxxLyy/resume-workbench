// test-migrate-materials-shape.mjs — 素材迁移必须挡根值形状异常（BL-P6-03，medium）
// 背景：migrateMaterials 只判 JSON.parse 成功，根值是对象/字符串/null 时 migrateMats 把它
// 当空数组处理并把整个文件改写成 []，迁移还报告成功（素材全丢）。
// 修法合同：根值非数组 → 抛 CORRUPT（与 parse 失败同族「不覆盖」），文件保持原样。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateMaterials } from '../../migrate-meta.mjs';

const mkRoot = (content) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-mms-'));
  fs.writeFileSync(path.join(root, 'materials.json'), content);
  return root;
};
const readBack = (root) => fs.readFileSync(path.join(root, 'materials.json'), 'utf8');

// ① 根值是对象 → CORRUPT，不覆盖
for (const [name, content] of [
  ['对象', '{"m1": {"title": "素材"}}'],
  ['字符串', '"hello"'],
  ['null', 'null'],
  ['数字', '42']
]) {
  const root = mkRoot(content);
  const before = readBack(root);
  let err = null;
  try { migrateMaterials(root, {}); } catch (e) { err = e; }
  assert.ok(err, `[${name}] 未抛错（文件被当空数组改写）`);
  assert.equal(err.code, 'CORRUPT', `[${name}] 错误码应为 CORRUPT，实际 ${err.code}`);
  assert.equal(readBack(root), before, `[${name}] 文件被改动（应保持原样）`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ② 对照：合法数组 → 不被新闸门拦截（正常迁移路径：产物仍是同长度数组，字段被规范化）
{
  const root = mkRoot(JSON.stringify([{ id: 'm1', title: 't', brief: 'b', technical: '', interview: '', confirmed: true, factStatus: 'done', facts: {} }]));
  const report = {};
  migrateMaterials(root, report);
  const after = JSON.parse(readBack(root));
  assert.ok(Array.isArray(after) && after.length === 1, '合法数组迁移产物应为同长度数组，实际：' + readBack(root));
  assert.equal(after[0].id, 'm1', '素材 id 应保留');
  fs.rmSync(root, { recursive: true, force: true });
}

// ③ 对照：旧形状数组 → 正常迁移路径（快照 + 写盘 + 报告）
{
  const root = mkRoot(JSON.stringify([{ id: 'm1', title: 't', brief: 'b' }]));
  const report = {};
  migrateMaterials(root, report);
  assert.equal(report.materials && report.materials.migrated, true, '旧形状应被迁移');
  const after = JSON.parse(readBack(root));
  assert.ok(Array.isArray(after) && after.length === 1, '迁移产物应为数组');
  fs.rmSync(root, { recursive: true, force: true });
}

// ④ 文件不存在 → 静默跳过（不抛）
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-mms-'));
  migrateMaterials(root, {});
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('✅ 素材迁移根值闸门：对象/字符串/null/数字 → CORRUPT 不覆盖；合法数组三态不回归');
