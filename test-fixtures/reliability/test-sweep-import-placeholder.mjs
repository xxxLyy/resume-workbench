// test-sweep-import-placeholder.mjs — 启动清扫不得吃掉在途导入占位 <id>.html.tmp（BL-P6-06 配套）
// 缺陷：tx.mjs cleanupOrphanArtifacts（每次 server 启动经 recoverPending 触发）按「顶层 *.tmp 一律
// unlink」清扫 docs/，而 importer.mjs:36 的在途导入占位恰好叫 <id>.html.tmp（BL-P6-06 合同：
// 占位在整个结构化窗口存在且对文档列表不可见）。结构化期间（真实 LLM 可达数分钟）任何一次
// 服务重启/夹具里 server 与导入子进程并发起跑，占位都会被清扫删掉：并发同名导入的防撞闸
// （importer.mjs:24-25「<id>.html.tmp 已存在 → 跳过」）随之失效，BL-P6-06 夹具也因这层竞态
// 间歇性红（「子进程占位未出现」，观察到的失败子进程正挂在 LLM 桩上、docs/ 为空）。
// 修法合同：清扫只回收「无主的崩溃残留」（atomicWrite 的隐藏多段 .tmp、restructure 的
// <id>.html.<ts>-<rand>.tmp），豁免 <id>.html.tmp——与 importer.mjs:24-25 同一「宁滥勿删」政策：
// SIGKILL 残留惰性不回收（对文档列表不可见、恢复侧按未知形状跳过、同名再导入时惰性回收）。
// 断言：① recoverPending 后 docs/<id>.html.tmp 存活且字节不变；
//       ② atomicWrite 崩溃残留（docs/pdfs 的 .<name>.<pid>.<ts>.<rand>.tmp）仍被清（原合同不回退）；
//       ③ restructure 残留（<id>.html.<ts>-<rand>.tmp）仍被清（原合同不回退）；
//       ④ 正常文档不受清扫影响。
// 纯函数夹具（临时根，零网络零服务零子进程）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverPending } from '../../tx.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-swip-'));
for (const d of ['docs', 'pdfs', 'snapshots', 'logs', 'backups', '.tx']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 在途导入占位（importer.mjs:36 allocateDocId 的 openSync('wx') 形态；字节模拟已写入的正文）
const placeholder = path.join(root, 'docs', 'myid.html.tmp');
const placeholderBytes = '<!doctype html><html><body>在途导入正文占位</body></html>';
fs.writeFileSync(placeholder, placeholderBytes);
// atomicWrite 崩溃残留（tx.mjs:321-322 清扫合同的原始对象；隐藏名 + 多段尾缀，见 atomicWrite 实现形态；
// 数字段位刻意取短，避免 11 位手机号形态长数字串触发隐私门禁）
const atomicDocs = path.join(root, 'docs', '.myid.html.53219.1730000001.887926.tmp');
const atomicPdfs = path.join(root, 'pdfs', '.myid.pdf.53219.1730000006.112233.tmp');
fs.writeFileSync(atomicDocs, 'junk');
fs.writeFileSync(atomicPdfs, 'junk');
// restructure 残留（test-backup-restore-shapes.mjs:66 同形态：可见名、<id>.html.<ts>-<rand>.tmp）
const restructure = path.join(root, 'docs', 'myid.html.120000000009-abc123.tmp');
fs.writeFileSync(restructure, 'junk');
// 正常文档：清扫的无关方
const normalDoc = path.join(root, 'docs', 'myid.html');
fs.writeFileSync(normalDoc, '<!doctype html><html><body><script>var DOC_ID = \'myid\';</script><p>正文</p></body></html>');

const cleanup = () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

const failures = [];
const check = (label, cond, detail) => {
  if (!cond) failures.push(label + (detail ? '：' + detail : ''));
  else console.log('  ✓ ' + label);
};

try {
  recoverPending(root);   // server 启动路径的同一入口（tx.mjs:350 先清扫后恢复）

  check('① 在途导入占位 <id>.html.tmp 存活（清扫豁免）', fs.existsSync(placeholder),
    'docs/ 现存：' + fs.readdirSync(path.join(root, 'docs')).join(', '));
  if (fs.existsSync(placeholder)) {
    check('① 占位字节未被改动', fs.readFileSync(placeholder, 'utf8') === placeholderBytes, '');
  }
  check('② atomicWrite 崩溃残留（docs）仍被清', !fs.existsSync(atomicDocs), '残留仍在');
  check('② atomicWrite 崩溃残留（pdfs）仍被清', !fs.existsSync(atomicPdfs), '残留仍在');
  check('③ restructure 残留 <id>.html.<ts>-<rand>.tmp 仍被清', !fs.existsSync(restructure), '残留仍在');
  check('④ 正常文档不受影响', fs.existsSync(normalDoc), '正常文档被误删');

  if (failures.length) {
    console.error('❌ 启动清扫与在途导入占位冲突复现（' + failures.length + ' 处）：');
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✅ 启动清扫豁免在途导入占位 <id>.html.tmp，atomicWrite/restructure 崩溃残留清扫合同不回退');
} finally {
  cleanup();
}
