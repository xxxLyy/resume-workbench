// agent-files.mjs — Agent 附件上传/存储/提取（UPCV A5 · agent-files 目录）
// 契约源：efc docs/upcv-agent-implementation-phase2.md §1；本地适配：
//   - 传输 = raw body（/upload 同款惯例），不引 multipart；SQLite → agent-files/ 目录文件。
//   - 所有权编码进文件名：<sessionId>__<fileId>.bin（二进制统一 .bin：txt 原档会与提取 .txt 撞名）；
//     元数据同名 .json sidecar；提取文本同名 .txt sidecar（只在提取成功时写）。
//   - 零新 npm 依赖：pdf→pdftotext（importer.mjs 同口径）；docx→内置 zlib 迷你 unzip；
//     txt/md→UTF-8；图片不提取（走多模态，agent.mjs §1.5）。
// 纪律：
//   - 类型判定看魔数不看文件名（/upload PDF 魔数先例）；扩展名只服务 docx/txt/md 歧义档。
//   - 提取失败不拒收：存原文件 + warning（efc「将按文件名引用」契约文案照搬）。
//   - 会话删除由 agent.mjs agentDeleteSession 调 sweepAgentFiles 连带清理。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

const FILE_MAX = 10 * 1024 * 1024;      // efc 契约上限
const EXTRACT_MAX = 50000;              // efc 提取截断
const NAME_MAX = 200;

const err = (status, message) => Object.assign(new Error(message), { httpCode: status });
export const isObj = (d) => !!d && typeof d === 'object' && !Array.isArray(d);

const filesDir = (root) => path.join(root, 'agent-files');
const base = (sid, fid) => `${sid}__${fid}`;

// ===== 类型识别（魔数优先；txt/md 看扩展名+UTF-8 可解）=====
// 返回 {ext,mime,kind} kind∈text|pdf|docx|image；不识 → null
function sniff(buf, name) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] || '';
  if (buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return { ext: 'pdf', mime: 'application/pdf', kind: 'pdf' };
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png', kind: 'image' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg', kind: 'image' };
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp', kind: 'image' };
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return ext === 'docx' ? { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx' } : null;   // PK 容器但非 .docx 名（xlsx/pptx/zip）不收
  }
  if (ext === 'txt' || ext === 'md') return { ext, mime: ext === 'md' ? 'text/markdown' : 'text/plain', kind: 'text' };
  return null;
}

// ===== docx 零依赖提取：EOCD → 中央目录 → word/document.xml → inflate → 去标签 =====
// 迷你 zip 读：只支持 store(0)/deflate(8) 与 ≤4GB 常规档；异常形状一律抛错（调用方转 warning）。
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('非 zip 容器');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lhoff = buf.readUInt32LE(off + 42);
    const fname = buf.toString('utf8', off + 46, off + 46 + nlen);
    out.push({ fname, method, csize, lhoff });
    off += 46 + nlen + elen + clen;
  }
  return out;
}
function zipRead(buf, ent) {
  const lo = ent.lhoff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('zip 本地头损坏');
  const nlen = buf.readUInt16LE(lo + 26), elen = buf.readUInt16LE(lo + 28);
  const data = buf.subarray(lo + 30 + nlen + elen, lo + 30 + nlen + elen + ent.csize);
  if (ent.method === 0) return data;
  if (ent.method === 8) return zlib.inflateRawSync(data, { maxBuffer: 64 * 1024 * 1024 });
  throw new Error('不支持的 zip 压缩方式');
}
const xmlText = (s) => s
  .replace(/<w:tab[^>]*\/>/g, '\t')
  .replace(/<\/w:p>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e]));
export function docxText(buf) {
  const ent = zipEntries(buf).find((e) => e.fname === 'word/document.xml');
  if (!ent) throw new Error('docx 缺 word/document.xml');
  const xml = zipRead(buf, ent).toString('utf8');
  const text = xmlText(xml).replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('docx 正文为空');
  return text;
}

export const hasDocxBody = (buf) => {
  try { return zipEntries(buf).some((e) => e.fname === 'word/document.xml'); }
  catch { return false; }
};

// ===== 上传 =====
// body 已由路由层 readBody(buffer, FILE_MAX) 读入；name 来自 query。
export function uploadAgentFile({ root, sid, name, buf }) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw err(400, '附件为空');
  if (buf.length > FILE_MAX) throw err(413, '附件过大（上限 10MB）');
  const t = sniff(buf, name);
  if (!t) throw err(400, '不支持的文件类型（仅收 pdf/docx/png/jpg/webp/txt/md）');
  if (t.kind === 'docx' && !hasDocxBody(buf)) throw err(400, 'docx 结构不完整（缺 word/document.xml）');
  const fid = 'af-' + randomBytes(4).toString('hex');
  const dir = filesDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const b = base(sid, fid);
  fs.writeFileSync(path.join(dir, `${b}.bin`), buf, { mode: 0o600 });

  let text = null, warning;
  try {
    if (t.kind === 'text') {
      const s = buf.toString('utf8');
      if (s.includes('�')) throw new Error('非 UTF-8 文本');
      text = s;
    } else if (t.kind === 'pdf') {
      const fp = path.join(dir, `${b}.bin`);
      text = execFileSync('pdftotext', ['-layout', fp, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 30000 }).toString('utf8');
    } else if (t.kind === 'docx') {
      text = docxText(buf);
    }
    if (typeof text === 'string' && !text.trim()) text = null;
    if (typeof text === 'string') text = text.slice(0, EXTRACT_MAX);
  } catch { text = null; }
  if (text == null && t.kind !== 'image') warning = '文本提取失败，将按文件名引用';
  if (text != null) fs.writeFileSync(path.join(dir, `${b}.txt`), text, { mode: 0o600 });

  const meta = { name: String(name || '').slice(0, NAME_MAX) || `${fid}.${t.ext}`, mime: t.mime, size: buf.length, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, `${b}.json`), JSON.stringify(meta), { mode: 0o600 });
  return { ok: true, fileId: fid, name: meta.name, mime: meta.mime, size: meta.size, textChars: text ? text.length : 0, ...(warning ? { warning } : {}) };
}

// ===== 归属解析（chat 用）：fileIds → [{fileId,name,mime,text,isImage,storedPath}] =====
export function resolveAgentFiles(root, sid, fileIds) {
  const dir = filesDir(root);
  const out = [], bad = [];
  for (const fid of fileIds || []) {
    const b = base(sid, String(fid));
    const jf = path.join(dir, `${b}.json`);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(fid)) || !fs.existsSync(jf)) { bad.push(String(fid)); continue; }
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(jf, 'utf8')); } catch { bad.push(String(fid)); continue; }
    const binPath = path.join(dir, `${b}.bin`);
    if (!fs.existsSync(binPath)) { bad.push(String(fid)); continue; }
    let text = null;
    const tf = path.join(dir, `${b}.txt`);
    if (fs.existsSync(tf)) { try { text = fs.readFileSync(tf, 'utf8'); } catch {} }
    out.push({
      fileId: String(fid), name: meta.name || String(fid), mime: meta.mime || '',
      text, isImage: /^image\//.test(meta.mime || ''), storedPath: binPath
    });
  }
  if (bad.length) throw err(400, '附件不存在或不属于本会话：' + bad.join('、'));
  return out;
}

// ===== 会话删除连带清理 =====
export function sweepAgentFiles(root, sid) {
  const dir = filesDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const prefix = `${sid}__`;
  for (const f of names) if (f.startsWith(prefix)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
  try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch {}
}
