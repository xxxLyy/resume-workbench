// test-import-placeholder-file.mjs — 导入期间 0 字节占位文档不可见（BL-P6-06）
// 缺陷：importPdfText 在调 LLM 之前用 openSync('wx') 占位创建 docs/<id>.html——结构化期间
// （真实 LLM 可达数分钟）这个 0 字节文件对 docIdsOnDisk（server.mjs:104-109，只认非隐藏
// *.html、不查大小）可见 → 首页出现一条点不开的「文档已损坏」（/edit 对无 var DOC_ID 的
// 文档回 500，server.mjs:2294）；catch 清理只在正常抛错时执行，SIGKILL/断电则永久残留。
// 修法合同（任务卡）：占位改 .tmp 后缀，正文就绪后 rename 转正；残留 .tmp 不被文档列表计入。
// 断言：① 结构化在途时（真实子进程走到 LLM 分支后挂住）文档列表（GET /）不含该 id；
// ② SIGKILL 子进程后该 id 仍不在列表、磁盘无 <id>.html（只有 .tmp 形态残留）；
// ③ 正常路径最终字节正确（var DOC_ID = '<真实id>'、无 .tmp 残留、完成后进列表且 /edit 可打开）。
// 手法：隔离 RESUME_ROOT + 随机端口 server.mjs 真实例 + 手工构造合成 PDF + 子进程真跑
// importPdfText（桩 LLM 端点 accept-后-挂住，制造数分钟级结构化窗口）+ SIGKILL 模拟断电。
// 不读真实数据、不碰 7766、不调真实模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { importPdfText } from '../../importer.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

// —— 合成 PDF：最小合法 1 页 PDF（ASCII 文本 / Helvetica），pdftotext 真提取 ——
function makePdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const off = [0];
  for (let i = 1; i < objs.length; i++) {
    off[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-iph-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
const pdfPath = path.join(root, 'placeholder-race.pdf');
fs.writeFileSync(pdfPath, makePdf('Jane Doe Placeholder Race Fixture'));

// 桩 LLM 端点：accept 后永不响应 → structureText 挂在 chat 上（120s 超时远大于夹具窗口），
// 制造与真实 LLM 同级的「结构化在途」窗口。挂在父进程，收尾钩子统一关闭。
const hang = net.createServer((sock) => { /* 故意不回应答 */ });
await new Promise((res) => hang.listen(0, '127.0.0.1', res));
hang.unref();
// 桩模型配置：结构化在途窗口所需。key 为占位假值。
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0,
  profiles: [{ name: 'stub', baseURL: 'http://127.0.0.1:' + hang.address().port, apiKey: 'stub-key-not-real', model: 'stub-model' }],
}));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

// 子进程：真跑 importPdfText（占位→结构化挂住），父进程观察在途状态后 SIGKILL（断电模拟）
const child = spawn(process.execPath, [
  '--input-type=module', '-e',
  `import { importPdfText } from ${JSON.stringify(path.join(APP_ROOT, 'importer.mjs'))};
   try { const id = await importPdfText(process.argv[1], process.argv[2], 'placeholder-race.pdf'); console.log('CHILD-DONE ' + id); }
   catch (e) { console.error('CHILD-ERR ' + (e && e.message)); process.exit(1); }`,
  root, pdfPath,
], { cwd: APP_ROOT, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

const cleanup = () => {
  try { child.kill('SIGKILL'); } catch {}
  try { server.kill('SIGKILL'); } catch {}
  try { hang.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
  }).on('error', reject);
});

const failures = [];
const check = (label, cond, detail) => {
  if (!cond) failures.push(label + (detail ? '：' + detail : ''));
  else console.log('  ✓ ' + label);
};

try {
  // 服务就绪（GET / 通即就绪）
  for (let i = 0; ; i++) {
    if (child.exitCode !== null && child.exitCode !== undefined) break;   // 子进程提前退出就不再等
    try { const r = await get('/'); if (r.status === 200) break; } catch {}
    if (i === 100) { console.error('❌ 服务 20s 未就绪\n' + serverLog.slice(-800)); process.exit(1); }
    await new Promise((r) => setTimeout(r, 200));
  }

  // ===== ① 结构化在途：真实子进程占位已落、结构化挂住（桩 LLM 不应答）=====
  // 中立轮询：等 docs/ 里出现 placeholder-race*（不预判是 .html 还是 .html.tmp）
  let seen = null;
  for (let i = 0; i < 150; i++) {
    const hit = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.startsWith('placeholder-race'));
    if (hit.length) { seen = hit; break; }
    if (childLog.includes('CHILD-DONE') || childLog.includes('CHILD-ERR')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!seen) {
    console.error('❌ 子进程占位未出现（20s），childLog=' + childLog.slice(-300) + ' serverLog=' + serverLog.slice(-300));
    process.exit(1);
  }
  const inFlight = await get('/');
  check('① 结构化在途时列表不含该 id（占位不可见）',
    inFlight.status === 200 && !inFlight.body.includes('placeholder-race'),
    `GET / status=${inFlight.status}，列表含 placeholder-race=${inFlight.body.includes('placeholder-race')}（在途文件：${seen.join(',')}）`);

  // ===== ② SIGKILL 子进程（断电模拟）：残留不得成为永久可见条目 =====
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  const docsNow = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.startsWith('placeholder-race'));
  const afterKill = await get('/');
  check('② SIGKILL 后该 id 不在列表', afterKill.status === 200 && !afterKill.body.includes('placeholder-race'),
    `GET / status=${afterKill.status}，列表含 placeholder-race=${afterKill.body.includes('placeholder-race')}（磁盘残留：${docsNow.join(',')}）`);
  check('② SIGKILL 后未转正（无 <id>.html）', !docsNow.includes('placeholder-race.html'),
    `磁盘上存在已转正的空壳：${docsNow.join(',')}`);

  // ===== ③ 正常路径：最终字节正确、无 .tmp 残留、完成后进列表且可打开 =====
  // 去掉 LLM 配置 → 降级路径（确定性、不外呼），同名规则不受 ①② 残留影响
  fs.rmSync(path.join(root, 'config.json'), { force: true });
  const pdf2 = path.join(root, 'placeholder-final.pdf');
  fs.writeFileSync(pdf2, makePdf('Jane Doe Placeholder Final Fixture'));
  const id2 = await importPdfText(root, pdf2, 'placeholder-final.pdf');
  const finalFile = path.join(root, 'docs', id2 + '.html');
  const bytes = fs.readFileSync(finalFile, 'utf8');
  check('③ 正常导入返回约定 id', id2 === 'placeholder-final', '实际 ' + id2);
  check('③ 落盘字节带真实 docId', bytes.includes(`var DOC_ID = '${id2}';`), 'DOC_ID 行缺失或不是真实 id');
  check('③ 落盘非空（正文已转正）', bytes.length > 200 && !fs.existsSync(finalFile + '.tmp'), `bytes=${bytes.length}`);
  const listed = await get('/');
  check('③ 完成后进列表', listed.status === 200 && listed.body.includes('placeholder-final'), `列表含=${listed.body.includes('placeholder-final')}`);
  const edit = await get('/edit?id=' + id2);
  check('③ /edit 可打开（非「文档已损坏」500）', edit.status === 200, `GET /edit status=${edit.status}`);

  if (failures.length) {
    console.error('❌ 导入占位可见性缺陷复现（' + failures.length + ' 处）：');
    for (const f of failures) console.error('  ✗ ' + f);
    console.error('  （磁盘 docs/：' + fs.readdirSync(path.join(root, 'docs')).filter((f) => f.startsWith('placeholder')).join(', ') + '）');
    process.exit(1);
  }
  console.log('✅ 导入占位不可见：在途/SIGKILL 残留均不进文档列表，正常路径最终字节正确且 /edit 可打开');
} finally {
  cleanup();
}
