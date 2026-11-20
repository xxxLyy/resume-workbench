// test-agent-files.mjs — 2026-11-20 A5 附件上传（设计 dev-docs/2026-11-20-a5-voice-attachments-design.md）
// 合同：
//   ① txt 上传 → fileId/textChars + agent-files/<sid>__<fid>.{txt,json,txt原档} 三件齐；坏类型/PK非docx → 400。
//   ② docx 自建 zip（store 法 word/document.xml）→ 提取到文本。
//   ③ resolveAgentFiles：同会话命中；跨会话/坏 id → err.httpCode=400。
//   ④ chatStream fileIds：用户条 parts 含 UPCV 逐字 file part；模型侧 user content 含 [context:file:<name>] 与提取文本；
//      持久化 text part 只存用户原文（展示/输入分离）；图片附件 → content 数组含 image_url。
//   ⑤ sweepAgentFiles：删 sid__* 全件，其他会话文件不动。
// 夹具口径：隔离 RESUME_ROOT + SSE 桩 LLM（零真实模型）；不起 server.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { init, createSession, getSession, deleteSession, chatStream, setAgentPrefs } from '../../agent.mjs';
import { uploadAgentFile, resolveAgentFiles, sweepAgentFiles, docxText } from '../../agent-files.mjs';

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-agfiles-'));
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs-meta.json'), '{}');

// —— SSE 桩：抓请求体供断言，回一句 reply JSON（协议：模型只出 {"reply":…}）——
let lastBody = null;
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    lastBody = null; try { lastBody = JSON.parse(b); } catch {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = JSON.stringify({ choices: [{ delta: { content: '{"reply":"已看附件"}' } }] });
    res.end(`data: ${delta}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'test-key', model: 'stub-x' }]
}));
init(root);
const SID = createSession({}).id;

// ① 上传：txt 三件齐 + 坏类型拒
{
  const r = uploadAgentFile({ root, sid: SID, name: 'note.txt', buf: Buffer.from('附件正文一\n第二行', 'utf8') });
  assert.equal(r.ok, true); assert.equal(r.textChars, 9); assert.equal(r.mime, 'text/plain');
  const b = `${SID}__${r.fileId}`;
  assert.ok(fs.existsSync(`${root}/agent-files/${b}.txt`), 'txt sidecar 应在');
  assert.ok(fs.existsSync(`${root}/agent-files/${b}.json`), 'json meta 应在');
  const t = fs.readFileSync(`${root}/agent-files/${b}.txt`, 'utf8');
  assert.ok(t.includes('附件正文一'), '提取文本应含正文');
  globalThis.__fid = r.fileId;
  let threw = null;
  try { uploadAgentFile({ root, sid: SID, name: 'x.exe', buf: Buffer.from([0x4d, 0x5a, 1, 2, 3]) }); }
  catch (e) { threw = e; }
  assert.equal(threw && threw.httpCode, 400, 'exe 应 400');
  threw = null;
  try { uploadAgentFile({ root, sid: SID, name: 'x.docx', buf: Buffer.from('notzip-content-1234') }); }
  catch (e) { threw = e; }
  assert.equal(threw && threw.httpCode, 400, '非 zip docx 应 400');
  console.log('✅ ① txt 上传三件齐 + 坏类型 400');
}

// ② docx：store(0) 法最小 zip（local header + central + EOCD，零压缩）
{
  const name = Buffer.from('word/document.xml', 'utf8');
  const xml = Buffer.from('<w:document><w:body><w:p><w:r><w:t>你好docx附件</w:t></w:r></w:p></w:body></w:document>', 'utf8');
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(xml.length, 18); lh.writeUInt16LE(xml.length, 22); lh.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([lh, name, xml]);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(0, 10); cd.writeUInt32LE(xml.length, 20); cd.writeUInt32LE(xml.length, 24); cd.writeUInt16LE(name.length, 28);
  const central = Buffer.concat([cd, name]);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(central.length, 12); eo.writeUInt32LE(local.length, 16);
  const docx = Buffer.concat([local, central, eo]);
  assert.ok(docxText(docx).includes('你好docx附件'), 'docxText 应解出正文');
  const r2 = uploadAgentFile({ root, sid: SID, name: 'a.docx', buf: docx });
  assert.ok(r2.ok && r2.textChars > 5, 'docx 上传应提取成功: ' + JSON.stringify(r2));
  console.log('✅ ② docx 零依赖提取');
}

// ③ 归属解析：同会话命中；跨会话/坏 id → 400
{
  const one = resolveAgentFiles(root, SID, [globalThis.__fid]);
  assert.equal(one.length, 1); assert.equal(one[0].name, 'note.txt'); assert.ok(one[0].text.includes('附件正文一'));
  const s2 = createSession({}).id;
  let e = null;
  try { resolveAgentFiles(root, s2, [globalThis.__fid]); } catch (x) { e = x; }
  assert.equal(e && e.httpCode, 400, '跨会话 fid 应 400');
  e = null;
  try { resolveAgentFiles(root, SID, ['af-nonexist']); } catch (x) { e = x; }
  assert.equal(e && e.httpCode, 400, '坏 fid 应 400');
  console.log('✅ ③ 归属/坏 id 400');
}

// ④ chatStream fileIds：file part 逐字形状 + 模型侧 context 注入 + 持久化只存原文
{
  const events = [];
  for await (const ev of chatStream(SID, '看下这个附件', { fileIds: [globalThis.__fid], profile: 0 })) events.push(ev);
  assert.ok(events.some((e) => e.type === 'finish'), '应出 finish');
  const s = getSession(SID);
  const um = s.messages.find((m) => m.role === 'user');
  const fp = um.parts.find((p) => p.type === 'file');
  assert.ok(fp, '用户条应有 file part');
  assert.deepEqual({ type: fp.type, filename: fp.filename, url: fp.url, mediaType: fp.mediaType },
    { type: 'file', filename: 'note.txt', url: globalThis.__fid, mediaType: 'text/plain' });
  const tp = um.parts.find((p) => p.type === 'text');
  assert.equal(tp.text, '看下这个附件', '持久化 text part 只存原文（不含注入 context）');
  const msgs = lastBody.messages;
  const u = msgs[msgs.length - 1].content;
  const ustr = typeof u === 'string' ? u : JSON.stringify(u);
  assert.ok(ustr.includes('[context:file:note.txt]') && ustr.includes('附件正文一'), '模型侧应注入 context+文本: ' + ustr.slice(0, 200));
  console.log('✅ ④ file part 形状 + context 注入 + 展示/输入分离');
}

// ④b 图片附件 → 模型侧 content 数组含 image_url
{
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const ri = uploadAgentFile({ root, sid: SID, name: 'p.png', buf: png });
  const events = [];
  for await (const ev of chatStream(SID, '看图', { fileIds: [ri.fileId], profile: 0 })) events.push(ev);
  const u = lastBody.messages[lastBody.messages.length - 1].content;
  assert.ok(Array.isArray(u) && u.some((c) => c.type === 'image_url' && String(c.image_url.url).startsWith('data:image/png;base64,')), '图片应走 image_url 多模态');
  console.log('✅ ④b 图片多模态 content');
}

// ⑤ sweep：删本会话文件不动他会话
{
  const s2 = createSession({}).id;
  const r3 = uploadAgentFile({ root, sid: s2, name: 'keep.txt', buf: Buffer.from('keep', 'utf8') });
  deleteSession(SID);
  const left = fs.existsSync(`${root}/agent-files/${s2}__${r3.fileId}.txt`);
  assert.ok(left, '他会话附件不应被动');
  assert.ok(!fs.existsSync(`${root}/agent-files/${SID}__${globalThis.__fid}.txt`), '本会话附件应已清');
  console.log('✅ ⑤ 会话删除连带清扫');
}

// ⑥ 记忆开关（UPCV 残余 #1）：memory=false → 模型侧零历史（仅 system+当前条）；true → 历史回灌
{
  setAgentPrefs({ memory: false });
  const s3 = createSession({}).id;
  for await (const ev of chatStream(s3, '第一句', { profile: 0 })) {}
  for await (const ev of chatStream(s3, '第二句', { profile: 0 })) {}
  const n = lastBody.messages.filter((m) => m.role !== 'system').length;
  assert.equal(n, 1, '记忆关时模型应只见当前条: ' + JSON.stringify(lastBody.messages.map((m) => m.role)));
  setAgentPrefs({ memory: true });
  for await (const ev of chatStream(s3, '第三句', { profile: 0 })) {}
  const n2 = lastBody.messages.filter((m) => m.role !== 'system').length;
  assert.ok(n2 >= 3, '记忆开时历史应回灌: ' + n2);
  console.log('✅ ⑥ 记忆开关（关=每句独立 / 开=历史回灌）');
}

stub.close();
console.log('✅ 全绿：A5 附件链（上传/提取/归属/chat/清扫）+ 记忆开关');
process.exit(0);
