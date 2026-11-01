// test-import-docid-bytes.mjs — 导入两条路径的 docId 字节契约（BL-P6-05，按复核节点 13194 修正口径）
// 缺陷（复核修正后）：真问题是 importer.mjs 调 buildRawDoc 实参错位——降级路径调用把
// loadConfig 判定喂进 name 槽、docId 落进 degradeReason 槽、docId 槽位整体缺参，
// → 落盘 {{NAME}}='null'（无配置）或 'partial'（有配置但不完整）、var DOC_ID = ''；
//   而 LLM 结构化路径的 buildDoc（structure.mjs）不替换 {{DOC_ID}} → 落盘字节留占位符。
//   两条路径都没兑现 importer.mjs:52-53 自己写下的契约「落盘字节带 docId」：
//   受损的是落盘字节、快照与该字节派生的 bodyHash/renderInputId 身份（/edit serve 时
//   server.mjs 会把 var DOC_ID 注入真实 id → 落盘身份与 serve 身份分叉）。
// 修法合同（fix-round-plan 任务 6）：修实参顺序；LLM 路径 atomicWrite 前 {{DOC_ID}} 函数化替换为真实 id。
// 断言（每条路径）：落盘行均为 var DOC_ID = '<真实id>'; 无 {{DOC_ID}} 残留，
//   且 bodyHash 一致——freezeHtml(落盘字节).bodyHash === freezeHtml(按 /edit 口径注入真实 id 后).bodyHash。
// 手法：mkdtemp 隔离根 + 合成 PDF（手工构造最小合法 PDF，pdftotext 真提取）+
//   自起桩 OpenAI 兼容端点（随机端口，server.unref() 不吊进程）。不读真实数据、不碰 7766。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { importPdfText } from '../../importer.mjs';
import { freezeHtml } from '../../freeze.mjs';

// —— 合成 PDF：最小合法 1 页 PDF（ASCII 文本 / Helvetica），xref 偏移逐条计算 ——
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

// —— 桩 OpenAI 兼容端点：POST /chat/completions → 合法结构化 JSON（不走任何真实模型）——
const stub = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const structured = JSON.stringify({
      name: '桩模型', contact: '', intent: '', summary: '合成摘要',
      skills: [], work: [], projects: [], education: [],
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: structured } }] }));
  });
});
await new Promise((res) => stub.listen(0, '127.0.0.1', res));
stub.unref();   // 收尾钩子负责目录清理；unref 保证异常退出不留活进程

const roots = [];
const mkRoot = (tag) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-dbid-' + tag + '-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  roots.push(root);
  return root;
};
const cleanup = () => { for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} } };
process.on('exit', cleanup);

// —— docId 字节契约断言：落盘行 = 真实 id；无占位符残留；bodyHash 与 serve 口径一致 ——
function assertDocIdBytes(bytes, id, label) {
  const line = `var DOC_ID = '${id}';`;
  if (!bytes.includes(line)) {
    const actual = (bytes.match(/var DOC_ID = '[^']*';?/) || ['（未找到 DOC_ID 行）'])[0];
    throw new Error(`${label}：落盘行应为 ${line}，实际 ${actual}`);
  }
  if (bytes.includes('{{DOC_ID}}')) throw new Error(`${label}：落盘字节残留 {{DOC_ID}} 占位符`);
  // 身份一致性：/edit serve 时按 server.mjs 口径把 var DOC_ID 注入真实 id，
  // 注入前后 bodyHash 必须一致（不一致 = 落盘身份与快照/渲染输入身份分叉）
  const served = bytes.replace(/var DOC_ID = '[^']*'/, `var DOC_ID = '${id}'`);
  const hDisk = freezeHtml(bytes).bodyHash;
  const hServed = freezeHtml(served).bodyHash;
  if (hDisk !== hServed) throw new Error(`${label}：bodyHash 分叉（落盘 ${hDisk} vs serve 注入后 ${hServed}）`);
}

// 三个场景全部跑完再裁决：一处红不掩盖其余红面
const failures = [];
async function scenario(label, fn) {
  try {
    await fn();
    console.log('  ✓ ' + label);
  } catch (e) {
    failures.push((e && e.message) || String(e));
  }
}

try {
  // ===== ① LLM 结构化路径：structure.mjs buildDoc 不替换 {{DOC_ID}} → 落盘留占位符 =====
  await scenario('LLM 路径：落盘行=真实 id，无 {{DOC_ID}} 残留，bodyHash 一致', async () => {
    const root = mkRoot('llm');
    // 桩模型配置：baseURL 指向本夹具自起的桩端点（随机端口）；key 为占位假值
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      active: 0,
      profiles: [{ name: 'stub', baseURL: 'http://127.0.0.1:' + stub.address().port, apiKey: 'stub-key-not-real', model: 'stub-model' }],
    }));
    const pdf = path.join(root, 'docid-bytes-llm.pdf');
    fs.writeFileSync(pdf, makePdf('Jane Doe Senior Backend Engineer Docid Fixture'));
    const id = await importPdfText(root, pdf, 'docid-bytes-llm.pdf');
    if (id !== 'docid-bytes-llm') throw new Error(`LLM 路径：docId 应为 docid-bytes-llm，实际 ${id}`);
    const bytes = fs.readFileSync(path.join(root, 'docs', id + '.html'), 'utf8');
    assertDocIdBytes(bytes, id, 'LLM 路径');
  });

  // ===== ② 降级路径（无 LLM 配置）：buildRawDoc 实参错位（docId 落进 degradeReason 槽）=====
  await scenario('降级路径：落盘行=真实 id，{{NAME}}=文件名（非 null），bodyHash 一致', async () => {
    const root = mkRoot('raw');
    const pdf = path.join(root, 'docid-bytes-raw.pdf');
    fs.writeFileSync(pdf, makePdf('Jane Doe Plain Text Import Fixture'));
    const id = await importPdfText(root, pdf, 'docid-bytes-raw.pdf');
    const bytes = fs.readFileSync(path.join(root, 'docs', id + '.html'), 'utf8');
    assertDocIdBytes(bytes, id, '降级路径');
    // 实参顺序修复面：文件名必须落进 {{NAME}}（错位时该槽装的是 loadConfig 判定 → '<h1>null</h1>'）
    if (!bytes.includes('<h1>docid-bytes-raw</h1>')) {
      throw new Error('降级路径：{{NAME}} 应为文件名 docid-bytes-raw（实参错位时是 null）');
    }
  });

  // ===== ③ partial 降级（配置在但不完整）：同一调用行的另一半错位形态 =====
  await scenario('partial 降级：落盘行=真实 id，{{NAME}}=文件名（非 partial），说明文案正确', async () => {
    const root = mkRoot('partial');
    // profile 存在（loadConfig truthy → 走 'partial' 分支）但缺 apiKey/baseURL/model（hasLLM false）
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      active: 0,
      profiles: [{ name: 'incomplete' }],
    }));
    const pdf = path.join(root, 'docid-bytes-partial.pdf');
    fs.writeFileSync(pdf, makePdf('Jane Doe Partial Config Fixture'));
    const id = await importPdfText(root, pdf, 'docid-bytes-partial.pdf');
    const bytes = fs.readFileSync(path.join(root, 'docs', id + '.html'), 'utf8');
    assertDocIdBytes(bytes, id, 'partial 降级');
    // 错位时 name 槽装的是字符串 'partial' → '<h1>partial</h1>'
    if (!bytes.includes('<h1>docid-bytes-partial</h1>')) {
      throw new Error('partial 降级：{{NAME}} 应为文件名 docid-bytes-partial（实参错位时是 partial）');
    }
    if (!bytes.includes('LLM 配置不完整')) {
      throw new Error('partial 降级：degradeReason 槽应装 partial → 说明文案「LLM 配置不完整」');
    }
  });

  if (failures.length) {
    console.error('❌ 导入 docId 字节契约缺陷复现（' + failures.length + ' 处）：');
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✅ 导入 docId 字节契约：LLM/降级两条路径落盘行均为 var DOC_ID = \'<真实id>\';，无占位符残留，bodyHash 身份一致');
} finally {
  cleanup();
  stub.close();
}
