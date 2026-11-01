// test-tx-corrupt-meta.mjs — beginTx 不得把 docs-meta.json 损坏吞成「事务前无条目」（BL-P5-04，medium）
// 背景：beginTx 读旧 meta 失败时 `catch { oldMeta = null; }` → 损坏被记成「无条目」，
// 这份事务记录被启动恢复消费时会把该文档的整条 meta（rev/job/zones/tag）删除。
// 修法合同：读失败 → 抛 META_CORRUPT 中止事务（不写任何载荷/标记），把损坏上抛给调用方。
// 纯函数夹具（临时根，零网络零服务）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beginTx } from '../../tx.mjs';

const mkRoot = (metaContent, withDoc) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-txcm-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  if (withDoc) fs.writeFileSync(path.join(root, 'docs', 'd1.html'), '<!doctype html><html><body><script>var DOC_ID = \'d1\';</script><p>x</p></body></html>');
  if (metaContent !== null) fs.writeFileSync(path.join(root, 'docs-meta.json'), metaContent);
  return root;
};
const txFiles = (root) => {
  const d = path.join(root, '.tx');
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

// ① 损坏 meta（截断 JSON）→ 抛 META_CORRUPT，且不落任何事务文件
{
  const root = mkRoot('{"d1": {"rev": 1,', true);   // 截断
  let err = null;
  try { beginTx(root, 'd1', 'save', ''); } catch (e) { err = e; }
  assert.ok(err, '损坏 meta 时 beginTx 未抛错');
  assert.equal(err.code, 'META_CORRUPT', '错误码应为 META_CORRUPT，实际：' + err.code + ' / ' + err.message);
  assert.equal(txFiles(root).length, 0, '中止的事务不应留下任何载荷/标记，实际：' + JSON.stringify(txFiles(root)));
  fs.rmSync(root, { recursive: true, force: true });
}

// ② 损坏 meta（非法 JSON）→ 同上
{
  const root = mkRoot('not json at all', true);
  let err = null;
  try { beginTx(root, 'd1', 'save', ''); } catch (e) { err = e; }
  assert.ok(err && err.code === 'META_CORRUPT', '非法 JSON 场景应抛 META_CORRUPT');
  assert.equal(txFiles(root).length, 0, '非法 JSON 场景不应留下事务文件');
  fs.rmSync(root, { recursive: true, force: true });
}

// ③ 对照：合法 meta 无该条目 → 正常开事务，oldMeta 载荷为 null（「事务前无条目」语义保留）
{
  const root = mkRoot('{"other": {"rev": 1}}', true);
  const txId = beginTx(root, 'd1', 'save', '');
  const files = txFiles(root);
  assert.ok(files.some((f) => f === txId + '.meta.json'), '对照③缺 meta 载荷：' + JSON.stringify(files));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.tx', txId + '.meta.json'), 'utf8')), null, '无条目场景 oldMeta 应为 null');
  fs.rmSync(root, { recursive: true, force: true });
}

// ④ 对照：合法 meta 含该条目 → 载荷为条目整份副本
{
  const root = mkRoot('{"d1": {"rev": 7, "flow": "draft"}}', true);
  const txId = beginTx(root, 'd1', 'save', '');
  const payload = JSON.parse(fs.readFileSync(path.join(root, '.tx', txId + '.meta.json'), 'utf8'));
  assert.equal(payload.rev, 7, '对照④ oldMeta 副本缺 rev');
  fs.rmSync(root, { recursive: true, force: true });
}

// ⑤ 对照：meta 文件不存在 → 与「无条目」同路（不是损坏），正常开事务
{
  const root = mkRoot(null, true);
  const txId = beginTx(root, 'd1', 'save', '');
  assert.ok(txId, 'meta 不存在场景应正常开事务');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('✅ tx 损坏 meta：beginTx 抛 META_CORRUPT 中止且零载荷；「无条目/有条目/无文件」三态语义不回归');
