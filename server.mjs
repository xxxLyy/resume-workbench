// server.mjs — 简历平台服务（Node 内置模块，零框架）
// 数据根：RESUME_ROOT（缺省=脚本目录）。测试隔离靠它，代码/静态资源永远来自 APP_ROOT。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importPdfText } from './importer.mjs';
import { structureText } from './structure.mjs';
import { loadProfiles, hasLLM, chat, chatMsgs, listModels } from './llm.mjs';
import { buildRewrite, buildChat, parseChanges, buildReview, buildMatch, parseReport } from './ai.mjs';
import { buildJobPrompt, parseJobOps, pageSuggestions } from './job.mjs';
import { docToLines, docToText, contentHash, sectionsOf } from './extract.mjs';
import { rotateLogIfNeeded } from './logrotate.mjs';
import { freezeHtml, normalizeToCurrent, splitDoc, staleInfo } from './freeze.mjs';
import { beginTx, commitTx, dropSupersededTx, recoverPending, withDocLock, updateMeta, rootLock, atomicWrite, LockHeld } from './tx.mjs';
import { assembleTemplate, themeRegistration } from './template.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const root = process.env.RESUME_ROOT || APP_ROOT;   // 数据根（docs/snapshots/pdfs/JSON/backups 全在此）
for (const d of ['docs', 'snapshots', 'pdfs', 'backups', 'logs', '.tx']) fs.mkdirSync(path.join(root, d), { recursive: true });

// 服务日志由 launchd 写入 RESUME_LOG_FILE：启动时轮转一次，此后每 24h 检查（copytruncate，50MB 触发、留尾部 2MB 到 .1）
rotateLogIfNeeded(process.env.RESUME_LOG_FILE);
setInterval(() => rotateLogIfNeeded(process.env.RESUME_LOG_FILE), 24 * 3600 * 1000).unref();

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SNAPSHOTS = 50;
const APP_STATUSES = ['已投递', '笔试', '面试中', 'offer', '已拒', '搁置'];
const APP_TERMINAL = ['offer', '已拒', '搁置'];
const docPath = (id) => path.join(root, 'docs', id + '.html');
const pdfPath = (id) => path.join(root, 'pdfs', id + '.pdf');
const snapDir = (id) => path.join(root, 'snapshots', id);
const archivePath = (aid) => path.join(root, 'pdfs', 'archive', aid + '.pdf');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// ===== JSON 数据层：读容忍缺失、损坏必须显式暴露；写前校验，损坏即停写 =====
const JSON_FILES = { meta: 'docs-meta.json', apps: 'applications.json', mats: 'materials.json' };
const corrupt = new Set();
const dataFile = (name) => path.join(root, JSON_FILES[name]);
function readJson(name, fallback) {
  const f = dataFile(name);
  if (!fs.existsSync(f)) return fallback;
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); corrupt.delete(name); return d ?? fallback; }
  catch { corrupt.add(name); return fallback; }
}
function assertWritable(name) {
  const f = dataFile(name);
  if (!fs.existsSync(f)) return;
  let bad = false;
  try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch { bad = true; }
  if (bad) {
    corrupt.add(name);
    throw Object.assign(new Error(`数据文件损坏，已停止写入：${JSON_FILES[name]}。请先人工修复或从备份恢复。`), { httpCode: 500, code: 'CORRUPT' });
  }
  corrupt.delete(name);
}
function writeJson(name, data) {
  assertWritable(name);
  const tmp = dataFile(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, dataFile(name));
}
const loadMeta = () => readJson('meta', {});
const loadMats = () => { const a = readJson('mats', []); return Array.isArray(a) ? a : []; };
const loadApps = () => { const a = readJson('apps', []); return Array.isArray(a) ? a : []; };
const saveMats = (mats) => writeJson('mats', mats);
const saveApps = (apps) => writeJson('apps', apps);
// docs-meta.json 无 saveMeta：唯一写入者为 tx.mjs 的 updateMeta（读最新→只 patch 目标文档→原子 rename），见各写路径。
const corruptBanner = () => corrupt.size
  ? `<div class="card" style="border-color:#f3c2c2;background:#fef2f2;color:#7f1d1d"><b>⚠️ 检测到数据文件损坏，相关写入已停止：</b>${[...corrupt].map((k) => JSON_FILES[k]).join('、')} —— 请先在设置页用备份恢复，或人工修复 JSON 后刷新。</div>`
  : '';

// ===== 快照（被投递引用的快照与基准快照免配额清理）=====
const snapMetaPath = (docId) => path.join(snapDir(docId), 'meta.json');
const loadSnapMeta = (docId) => { try { return JSON.parse(fs.readFileSync(snapMetaPath(docId), 'utf8')) || {}; } catch { return {}; } };
const saveSnapMeta = (docId, meta) => {
  fs.mkdirSync(snapDir(docId), { recursive: true });
  const tmp = snapMetaPath(docId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta));
  fs.renameSync(tmp, snapMetaPath(docId));
};
function protectedSnaps(id) {
  const keep = new Set();
  for (const a of loadApps()) if (a.docId === id && a.snapTs) keep.add(a.snapTs);
  const base = loadSnapMeta(id).__baseline;
  if (base) keep.add(base);
  return keep;
}
// 冻结产物伴生 manifest：字段一次写全（快照不强制 resolveChromium → chromium 字段允许 null）。
function buildManifest(frozen, html, meta) {
  const norm = normalizeToCurrent(html);   // 主样式来源属性与 styleHash（typo 已分离，不影响主样式）
  const edVer = (frozen.html.match(/data-editor="([^"]+)"/) || [])[1] || null;
  return {
    theme: (meta && meta.theme) || norm.theme || null,
    styleHash: norm.styleHash || null,
    typoHash: frozen.typoHash || null,
    renderInputId: frozen.renderInputId,
    editorVersion: edVer,
    chromiumBin: null,
    browserVersion: null,
    fonts: [],
    dpi: null,
    createdAt: new Date().toISOString()
  };
}
// 冻结点统一出口：freezeHtml（内联 typo、自包含）→ 原子写 <ts>.html + <ts>.manifest.json。返回 frozen 结果。
function writeFrozenSnapshot(dir, ts, html, meta) {
  const frozen = freezeHtml(html, meta || {});
  atomicWrite(path.join(dir, ts + '.html'), frozen.html);
  atomicWrite(path.join(dir, ts + '.manifest.json'), JSON.stringify(buildManifest(frozen, html, meta || {})));
  return frozen;
}
function pruneSnapshots(id, dir) {
  const htmls = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  const overflow = htmls.length - MAX_SNAPSHOTS;
  if (overflow <= 0) return;
  const keep = protectedSnaps(id);
  const removable = htmls.filter((f) => !keep.has(f.replace('.html', '')));
  for (const f of removable.slice(0, overflow)) {
    const ts = f.replace(/\.html$/, '');
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
    try { fs.unlinkSync(path.join(dir, ts + '.manifest.json')); } catch {}   // manifest 与冻结 html 成对清理
  }
}
// 快照 = 冻结当前文档（freezeHtml）+ manifest；返回冻结 ts（无文档 → ''）。被投递引用/基准快照免配额清理。
function snapshot(id) {
  if (!fs.existsSync(docPath(id))) return '';
  const dir = snapDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const html = fs.readFileSync(docPath(id), 'utf8');
  const meta = loadMeta()[id] || {};
  const ts = timestamp();
  writeFrozenSnapshot(dir, ts, html, meta);
  pruneSnapshots(id, dir);
  return ts;
}

// ===== 渲染（原子替换；RETRY=1 次；测试可用 RESUME_RENDER_BIN 注入假渲染器）=====
// renderDoc 只接受 --src 冻结/组装输入（render.mjs 对文档元数据盲态）；env 透传渲染标识与可复现性（旁车用）。
function renderDoc({ src, out, env }) {
  const args = [path.join(APP_ROOT, 'render.mjs'), '--src', src, '--out', out];
  const attempt = () => new Promise((resolve) => {
    const child = spawn(process.env.RESUME_RENDER_BIN || 'node', args, {
      stdio: 'inherit',
      env: { ...process.env, RESUME_ROOT: root, ...(env || {}) }
    });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
  return attempt().then((ok) => ok || attempt());
}

// 当前文档陈旧状态单出口（staleInfo）：当前 HTML + 当前 meta 冻结出 renderInputId，
// 对照 meta.lastRenderInputId 与 PDF 存在性 → none/stale/fresh。mtime 不作正确性依据（仅日志/展示）。
// 调用方：首页徽章、/save 响应 pdfStale、/pdf、/export。
function currentRenderState(id) {
  const html = fs.readFileSync(docPath(id), 'utf8');
  const meta = loadMeta()[id] || {};
  const frozen = freezeHtml(html, meta);
  const pdfExists = fs.existsSync(pdfPath(id));
  const si = staleInfo(meta, { renderInputId: frozen.renderInputId, pdfExists });
  let docMtime = null;   // 仅日志参考（判定不看它）
  try { docMtime = new Date(fs.statSync(docPath(id)).mtimeMs).toISOString(); } catch {}
  return { frozen, meta, pdfExists, state: si.state, stale: si.stale, docMtime };
}

// 当前文档渲染唯一入口（铁律一）：freezeHtml(当前 HTML, 当前 meta) → tmp 冻结文件 → render.mjs --src
// （RESUME_RENDER_INPUT_ID / RESUME_RENDER_REPRODUCIBLE 经 env 传入，供 <pdf>.env.json 旁车记录）
// → 成功经 updateMeta 记 meta.lastRenderInputId/lastRenderAt（记的是本任务冻结的标识，不是完成时的"当前"标识；
//   渲染期间又保存 → 下次判定自然 stale，无需 mtime）。
// POST /render、/export 与 /pdf 的缺失/过期自动重渲、/rollback、/restructure 一律走这里；绝不直渲磁盘 HTML
// （迁移后当前文档不含内联 typo，直渲会丢排版）。
async function renderCurrent(id) {
  const html = fs.readFileSync(docPath(id), 'utf8');
  const meta = loadMeta()[id] || {};
  const frozen = freezeHtml(html, meta);   // 任务启动即冻结输入
  const tmp = path.join(os.tmpdir(), `resume-frozen-${id}-${Date.now()}-${process.pid}.html`);
  atomicWrite(tmp, frozen.html);
  let ok = false;
  try {
    ok = await renderDoc({
      src: tmp,
      out: pdfPath(id),
      env: { RESUME_RENDER_INPUT_ID: frozen.renderInputId, RESUME_RENDER_REPRODUCIBLE: frozen.reproducible ? '1' : '0' }
    });
    ok = ok && fs.existsSync(pdfPath(id));
    if (ok) {
      updateMeta(root, id, (m) => ({ ...(m || {}), lastRenderInputId: frozen.renderInputId, lastRenderAt: new Date().toISOString() }));
      console.error(`[render] 已渲染 id=${id} renderInputId=${frozen.renderInputId} reproducible=${frozen.reproducible}`);
    } else {
      console.error(`[render] 渲染失败 id=${id} renderInputId=${frozen.renderInputId}（详见上方渲染输出）`);
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return { ok, frozen };
}

function readBody(req, mode = 'text', maxSize = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxSize) { chunks.length = 0; reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(mode === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
// 表单/JSON 双兼容 body
async function readBodyAuto(req) {
  const text = await readBody(req);
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) return JSON.parse(text);
  if (ct.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { return Object.fromEntries(new URLSearchParams(text)); }
}

// 流式写文件（大备份上传用）
function readBodyToFile(req, file, maxSize) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(file);
    let size = 0, stopped = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxSize) { stopped = true; ws.destroy(); reject(new Error('body too large')); return; }
      ws.write(c);
    });
    req.on('end', () => { if (!stopped) ws.end(() => resolve(size)); });
    req.on('error', (e) => { ws.destroy(); reject(e); });
  });
}

function page(title, inner, active = '') {
  const nav = (key, href, label) => `<a href="${href}"${active === key ? ' class="on"' : ''}>${label}</a>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>/*BENTO-V1*/
/*A-VARS*/:root{--bg:#F4F5F8;--ink:#202737;--mut:#697186;--line:#DCE0E8;--indigo:#5B5DE8;--ok:#2F7D5A;--warn:#B45309;--err:#B91C1C;--radius:10px;--shadow:0 1px 3px rgba(41,48,80,.06);--shadow-up:0 10px 24px rgba(41,48,80,.10)}
*{box-sizing:border-box}
body{font-family:"PingFang SC",-apple-system,sans-serif;max-width:1100px;margin:0 auto;padding:0 20px 40px;font-size:14px;background:var(--bg);color:var(--ink)}
a{color:var(--indigo);text-decoration:none;font-weight:600}
.topnav{display:flex;justify-content:space-between;align-items:center;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:10px 18px;margin:16px 0 20px;position:sticky;top:12px;z-index:50;flex-wrap:wrap;gap:8px}
.topnav .brand{font-weight:800;font-size:15px;color:var(--ink)}
.topnav .links a{margin-left:16px;color:var(--mut);font-weight:600}
.topnav .links a.on{color:var(--indigo)}
.topnav .links a:hover{color:var(--ink)}
h1{font-size:22px;font-weight:800;margin:6px 0 12px}
button{cursor:pointer;background:var(--indigo);color:#fff;border:none;border-radius:8px;min-height:32px;padding:0 12px;font-weight:600;font-size:13px;transition:transform .12s,box-shadow .12s,background .12s}
button.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}
button.danger{background:#fff;color:var(--err);border:1px solid #f3c2c2}
button.danger:hover{background:#fef2f2}
button:hover{transform:translateY(-1px);box-shadow:0 3px 9px rgba(24,27,48,.12)}
button:active{transform:translateY(1px);box-shadow:none}
button.secondary:hover{background:#F4F5F8}
button:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}
input,textarea{border:1px solid var(--line);border-radius:8px;padding:7px 10px;background:#fff;font-size:13px;max-width:100%}
select{border:1px solid var(--line);border-radius:8px;padding:7px 10px;background:#fff;font-size:13px}
button:focus-visible,input:focus-visible,a:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--indigo);outline-offset:1px}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px}
.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;background:#f3f4f6;color:#374151;margin-right:6px}
.badge.ok{background:#dcfce7}.badge.warn{background:#fef3c7}.badge.ai{background:#ede9fe;color:#5b21b6}.badge.err{background:#fee2e2;color:#991b1b}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:12px 0}
.stat{border-radius:var(--radius);padding:12px 14px;box-shadow:var(--shadow);border:1px solid var(--line)}
.stat b{font-size:22px;display:block}
.stat span{font-size:12px;color:var(--mut)}
.stat.s1{background:#ede9fe}.stat.s2{background:#dbeafe}.stat.s3{background:#dcfce7}.stat.s4{background:#fef3c7}
ul.doclist{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
ul.doclist.list-view{grid-template-columns:1fr}
.group-head{list-style:none;grid-column:1/-1;font-weight:800;font-size:14px;margin:10px 0 0;padding-bottom:4px;border-bottom:1px solid var(--line);color:var(--mut)}
.diff-line{padding:3px 8px;border-radius:6px;margin:2px 0;font-size:13px}
.diff-line.same{color:var(--mut)}
.diff-line.del{background:#fee2e2;text-decoration:line-through}
.diff-line.ins{background:#dcfce7}
footer{margin-top:36px;text-align:center;color:#a8a29e;font-size:12px}
.kb{display:flex;gap:10px;overflow-x:auto;align-items:flex-start;padding-bottom:8px}
.tablewrap{overflow-x:auto}
@media (max-width:600px){.kb{flex-direction:column;overflow-x:visible}.kb>div{min-width:0!important;width:100%}}
@media(hover:hover) and (pointer:fine){
.doc-card{transition:transform .25s,box-shadow .25s}
.doc-card:hover{transform:perspective(900px) rotateX(2deg) rotateY(-2px) translateY(-3px);box-shadow:var(--shadow-up)}}
.doc-card:focus-within{outline:2px solid var(--indigo);outline-offset:2px}
@media(prefers-reduced-motion:reduce){.doc-card{transition:none!important}.doc-card:hover{transform:none!important}}
</style></head><body>
<nav class="topnav"><a class="brand" href="/">📄 简历工作台</a><span class="links">${nav('docs', '/', '文档')}${nav('materials', '/materials', '🧱 素材库')}${nav('apps', '/applications', '📋 投递看板')}${nav('stats', '/stats', '📊 复盘')}${nav('settings', '/settings', '⚙️ 设置')}</span></nav>
${inner}
<footer>简历平台 · 本地优先 · 数据在 ${path.basename(root) === 'resume' ? '~/resume' : 'RESUME_ROOT'}</footer>
</body></html>`;
}

// 注入块（serve 幂等注入；/save 按注释对剥离，文档永不落盘）
const AI_MARK = '<!--AI-INJECT-->';
const SHELL_MARK = '<!--SHELL-INJECT-->';
const JOB_MARK = '<!--JOB-INJECT-->';
function aiBlock(id) {
  return `\n${AI_MARK}<script src="/ai-panel.js" data-doc="${id}" defer></script><!--/AI-INJECT-->\n`;
}
function shellBlock(id, mtimeMs) {
  const mats = loadMats().map((m) => ({ id: m.id, title: m.title, tags: m.tags || [],
    brief: m.brief, technical: m.technical || '', interview: m.interview || '', confirmed: m.confirmed === true }));
  const meta = loadMeta()[id] || {};
  const job = meta.job
    ? { hasJob: true, status: meta.job.status || 'draft', company: meta.company || '', role: meta.role || '', materials: meta.job.materials || [] }
    : { hasJob: false };
  return `\n${SHELL_MARK}<script>window.__MATS__=${JSON.stringify(mats).replace(/</g, '\\u003c')};window.__JOB_INFO__=${JSON.stringify(job).replace(/</g, '\\u003c')};</script><script src="/editor-shell.js" data-doc="${id}" data-mtime="${Number(mtimeMs) || 0}" defer></script><!--/SHELL-INJECT-->\n`;
}
function jobBlock(id) {
  return `\n${JOB_MARK}<script src="/job-panel.js" data-doc="${id}" defer></script><!--/JOB-INJECT-->\n`;
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function docInfo(id, m) {
  const f = docPath(id);
  if (!fs.existsSync(f)) return null;
  const content = fs.readFileSync(f, 'utf8');
  const stat = fs.statSync(f);
  return {
    id,
    title: escHtml((content.match(/<h1>([^<]+)<\/h1>/) || [])[1] || id),
    mtime: stat.mtime.toLocaleString('zh-CN'),   // 仅展示（陈旧判定一律走 renderInputId）
    mtimeMs: stat.mtimeMs,
    degraded: content.includes('以下为 PDF 提取的原文'),
    hash: contentHash(content),
    renderInputId: freezeHtml(content, m || {}).renderInputId   // 当前 HTML+当前 meta 的冻结标识（供 staleInfo）
  };
}

function listPage() {
  const meta = loadMeta();
  const docs = fs.readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.html') && !f.startsWith('.'));
  const docInfoMap = new Map();
  for (const f of docs) { const did = f.replace('.html', ''); docInfoMap.set(did, docInfo(did, meta[did])); }
  const infos = [...docInfoMap.values()].filter(Boolean);
  const activeApps = loadApps().filter((a) => !APP_TERMINAL.includes(a.status)).length;
  const { active, profiles } = loadProfiles(root);
  const cfg = profiles[active];
  // 陈旧计数按 staleInfo（渲染标识），mtime 不参与
  const staleCount = infos.filter((d) => staleInfo(meta[d.id] || {}, { renderInputId: d.renderInputId, pdfExists: fs.existsSync(pdfPath(d.id)) }).state === 'stale').length;
  const degradedCount = infos.filter((d) => d.degraded).length;
  const pdfCount = infos.filter((d) => fs.existsSync(pdfPath(d.id))).length;
  const jobDocs = infos.filter((d) => meta[d.id] && (meta[d.id].parent || meta[d.id].job));
  const nowMs = Date.now();
  const upcoming = loadApps().filter((a) => {
    if (APP_TERMINAL.includes(a.status)) return false;
    const due = a.dueDate ? new Date(a.dueDate).getTime() : null;
    if (due && due - nowMs < 48 * 3600 * 1000) return true;   // 已逾期或 48h 内到期（逾期不清零）
    const ivs = Array.isArray(a.interviews) ? a.interviews : [];
    return ivs.some((iv) => { const t = iv.time ? new Date(iv.time).getTime() : null; return t && t - nowMs < 48 * 3600 * 1000; });
  });
  const todoBits = [
    staleCount && `🔄 ${staleCount} 份 PDF 内容有更新，导出时重渲`,
    degradedCount && `⚠️ ${degradedCount} 份待结构化`,
    activeApps && `📋 ${activeApps} 份投递中`,
    upcoming.length && `⏰ ${upcoming.length} 份逾期/近期面试提醒`,
    cfg ? `🤖 AI 配置：${escHtml(cfg.name || '')}` : '🤖 AI 配置：未配置（岗位草稿仍可手动生成）',
    `📑 PDF 已生成 ${pdfCount}/${docs.length}（以导出页实际渲染为准）`
  ].filter(Boolean);
  const jobStatusBadge = (id) => {
    const m = meta[id] || {};
    const j = m.job || {};
    if (j.status === 'deliverable') return '<span class="badge ok">可投递</span>';
    if (j.status === 'delivered') return '<span class="badge ai">已记录投递</span>';
    return '<span class="badge warn">草稿</span>';
  };
  const cardHtml = (id) => {
    const m = meta[id] || {};
    const info = docInfoMap.get(id);
    if (!info) return '';
    const tag = m.tag || '';
    const snaps = fs.existsSync(snapDir(id)) ? fs.readdirSync(snapDir(id)).filter((s) => s.endsWith('.html')).length : 0;
    // 徽章三态 = staleInfo（渲染标识）：none 未生成｜stale 较旧｜fresh 同步（mtime 不参与判定）
    const si = staleInfo(m, { renderInputId: info.renderInputId, pdfExists: fs.existsSync(pdfPath(id)) });
    const pdfBadge = si.state === 'none' ? '<span class="badge warn">PDF 未生成</span>'
      : si.state === 'stale' ? '<span class="badge warn">PDF 较旧</span>'
      : '<span class="badge ok">PDF 同步</span>';
    return `<li class="card doc-card"><b style="font-size:16px">${info.title}</b>
      <div style="color:var(--mut);font-size:12px;margin:6px 0">${id} · 更新于 ${info.mtime}</div>
      <div style="margin-bottom:8px"><span class="badge">快照 ${snaps}</span>${pdfBadge}${m.job ? jobStatusBadge(id) : ''}${tag ? `<span class="badge">${escHtml(tag)}</span>` : ''}${info.degraded ? '<span class="badge warn">待结构化</span>' : ''}</div>
      ${m.parent ? `<div style="font-size:12px;color:var(--mut)">岗位版：${escHtml((m.company || '') + '·' + (m.role || ''))}（母版 ${escHtml(m.parent)}）</div>` : ''}
      <a href="/edit?id=${id}">继续编辑</a> ·
      <a href="/export?id=${id}">导出</a>
      <details class="more" style="display:inline"><summary style="display:inline;cursor:pointer;color:var(--mut)">⋯</summary>
      <div style="margin-top:4px;font-size:13px">
      <a href="/pdf?id=${id}" target="_blank">最新 PDF</a> ·
      <a href="/snapshots?id=${id}">历史版本</a> ·
      <a href="/diff?base=${id}">对比</a> ·
      ${m.parent ? `<a href="/diff?base=${escHtml(m.parent)}&to=${id}">对比母版</a> · ` : ''}
      ${info.degraded ? `<form method="post" action="/restructure?id=${id}" style="display:inline" onsubmit="return confirm('用 LLM 重新结构化这份文档？会先自动留快照')"><button class="secondary">🔁 结构化</button></form> · ` : ''}
      <form method="post" action="/tag" style="display:inline" onsubmit="event.preventDefault();const t=prompt('标签（≤20字，留空清除）','${tag}');if(t!==null){fetch('/tag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'${id}',tag:t})}).then(()=>location.reload())}"><button class="secondary">🏷</button></form> ·
      <form method="post" action="/duplicate?id=${id}" style="display:inline" onsubmit="event.preventDefault();const t=prompt('新文档 id（小写字母数字横线）');if(t){this.action='/duplicate?id=${id}&to='+t;this.submit()}"><button>复制</button></form> ·
      <form method="post" action="/delete?id=${id}" style="display:inline" onsubmit="return confirm('确认删除 ${id}？快照会保留')"><button class="danger">删除</button></form>
      </div></details>
    </li>`;
  };
  const drafts = jobDocs
    .filter((d) => (meta[d.id].job || {}).status !== 'delivered')
    .sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 4);
  const byTag = new Map();
  for (const d of docInfoMap.keys()) {
    const key = (meta[d] && meta[d].tag) || '未标记';
    if (!byTag.has(key)) byTag.set(key, []);
    byTag.get(key).push(cardHtml(d));
  }
  const keys = [...byTag.keys()].sort((x, y) => (x === '未标记') - (y === '未标记') || x.localeCompare(y));
  const cards = keys.length === 1 && keys[0] === '未标记'
    ? byTag.get('未标记').join('\n')
    : keys.map((k) => `<li class="group-head">${escHtml(k)}</li>\n${byTag.get(k).join('\n')}`).join('\n');
  return page('简历工作台', `<h1>简历工作台</h1>
    ${corruptBanner()}
    <div class="card" id="jobCard">
      <b style="font-size:15px">🎯 针对岗位生成简历</b>
      <p style="font-size:12px;color:var(--mut);margin:6px 0">拿到 JD → 生成独立岗位草稿（不改母版）→ 审阅修改清单 → 导出两页 PDF。不配置模型也可手动生成草稿。</p>
      <form id="jobForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;align-items:end">
        <label style="font-size:12px">公司<input id="jobCompany" required style="width:100%"></label>
        <label style="font-size:12px">岗位<input id="jobRole" required style="width:100%"></label>
        <label style="font-size:12px">母版简历<select id="jobFrom" style="width:100%">${infos.map((d) => `<option value="${d.id}">${d.title}（${d.id}）</option>`).join('')}</select></label>
        <label style="font-size:12px">JD 链接（可留空）<input id="jobLink" placeholder="https://…读取失败可改贴文本" style="width:100%"></label>
        <label style="font-size:12px;grid-column:1/-1">JD 文本（可留空，稍后补）<textarea id="jobJd" rows="3" style="width:100%"></textarea></label>
        <div style="grid-column:1/-1"><button type="submit">生成岗位草稿</button><span id="jobMsg" style="font-size:12px;color:var(--mut)"></span></div>
      </form>
    </div>
    ${drafts.length ? `<div class="card" style="margin-top:12px"><b>继续处理岗位草稿</b>
      ${drafts.map((d) => `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><span><b>${d.title}</b> <span class="badge warn">${((meta[d.id] || {}).job || {}).status === 'deliverable' ? '可投递' : '草稿'}</span><span style="color:var(--mut);font-size:12px">${escHtml(((meta[d.id] || {}).company || '') + '·' + ((meta[d.id] || {}).role || ''))} · ${d.mtime}</span></span><a href="/edit?id=${d.id}"><button>继续处理</button></a></div>`).join('')}
    </div>` : ''}
    <div class="card" style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <form method="post" action="/new"><button class="secondary">＋ 新建空白文档</button></form>
      <details class="import-box" style="flex:1;min-width:220px"><summary style="cursor:pointer;font-weight:700">📄 导入 PDF</summary>
        <form id="up" style="margin-top:8px">
          <span style="color:#666">选择 PDF 文件导入为新文档</span><input type="file" id="upfile" accept="application/pdf">
          <button>导入</button><span id="upmsg"></span>
        </form>
      </details>
    </div>
    <div class="card" style="margin-top:12px;display:flex;gap:14px;flex-wrap:wrap;font-size:13px">${todoBits.map((t) => `<span>${t}</span>`).join('')}</div>
    <div style="display:flex;gap:10px;align-items:center;margin:12px 0">
      <input id="searchBox" placeholder="搜索文档（标题/id/标签）" style="flex:1" aria-label="搜索文档">
      <button class="secondary" id="viewToggle">▤ 切换</button>
    </div>
    <ul class="doclist" id="doclist">${cards}</ul>
    <script>
      document.getElementById('up').addEventListener('submit', async function (e) {
        e.preventDefault();
        var f = document.getElementById('upfile').files[0];
        if (!f) return;
        document.getElementById('upmsg').textContent = ' 导入中（LLM 结构化需几十秒）…';
        var r = await fetch('/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        if (r.redirected) { location.href = r.url; return; }
        document.getElementById('upmsg').textContent = ' ' + (await r.text());
      });
      document.getElementById('jobForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = document.getElementById('jobMsg');
        msg.textContent = ' 创建中…';
        try {
          var r = await fetch('/job/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: document.getElementById('jobFrom').value, company: document.getElementById('jobCompany').value.trim(),
              role: document.getElementById('jobRole').value.trim(), jd: document.getElementById('jobJd').value,
              jdLink: document.getElementById('jobLink').value.trim() }) });
          var d = await r.json().catch(function () { return null; });
          if (r.redirected) { location.href = r.url; return; }
          if (d && d.existing) { if (confirm('已存在同一母版+岗位的草稿（' + d.existing + '）。打开它？')) location.href = '/edit?id=' + d.existing; return; }
          if (d && d.ok && d.id) { location.href = '/edit?id=' + d.id; return; }
          msg.textContent = ' ❌ ' + ((d && d.error) || (await r.text()));
        } catch (err) { msg.textContent = ' ❌ ' + err.message; }
      });
      document.getElementById('searchBox').addEventListener('input', function () {
        var q = this.value.toLowerCase();
        document.querySelectorAll('#doclist > li').forEach(function (li) {
          li.style.display = !q || li.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
      document.getElementById('viewToggle').onclick = function () {
        document.getElementById('doclist').classList.toggle('list-view');
      };
      document.addEventListener('click', function (e) {
        document.querySelectorAll('details.more[open]').forEach(function (d) {
          if (!d.contains(e.target)) d.removeAttribute('open');
        });
      });
    </script>`, 'docs');
}

// 备份恢复/回退：把 docs-meta.json 整体替换为 target（成对语义），但一律经 updateMeta 逐文档写（不裸 copyFileSync 覆盖共享文件）。
// 本地存在而 target 无的文档条目 → 删除；target 的每个条目 → 写入。保证 html 与 meta 成对且不踩其他并发写。
function applyMetaSnapshot(target) {
  const t = (target && typeof target === 'object' && !Array.isArray(target)) ? target : {};
  const cur = loadMeta();
  for (const k of Object.keys(cur)) if (!Object.prototype.hasOwnProperty.call(t, k)) updateMeta(root, k, () => null);
  for (const k of Object.keys(t)) updateMeta(root, k, () => t[k]);
}
// 读备份包/回退点里的 docs-meta.json：缺失 → null（该备份不含 meta，既有语义）；
// 存在但不可解析或不是对象 → 显式抛 CORRUPT（500）。绝不退化成 {}：那等于删掉本地全部 meta 条目。
function readMetaSnapshotAt(f) {
  if (!fs.existsSync(f)) return null;
  const bad = (why) => Object.assign(new Error(`备份中的 docs-meta.json ${why}，已拒绝恢复（不覆盖本地 meta）`), { httpCode: 500, code: 'CORRUPT' });
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { throw bad('损坏'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('格式非法（应为对象）');
  return parsed;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id') || 'linghaoxiang';
  const send = (code, body, type = 'text/html; charset=utf-8') => {
    if (res.destroyed || res.writableEnded) return;
    const extra = {};
    res.writeHead(code, { 'Content-Type': type, ...extra });
    res.end(body);
  };
  const sendJson = (code, obj) => send(code, JSON.stringify(obj), 'application/json; charset=utf-8');
  const redirect = (loc) => { res.writeHead(303, { Location: loc }); res.end(); };
  if (!VALID_ID.test(id)) return send(400, 'invalid id', 'text/plain');
  // 跨进程排他锁：迁移/保存持有 .migrate.lock（他人新鲜持锁）期间，一切写请求（非 GET/HEAD）一律 503；读不受影响。
  if (req.method !== 'GET' && req.method !== 'HEAD' && rootLock.isHeld(root)) {
    return send(503, '迁移/维护进行中（.migrate.lock 被持有），写请求暂不可用，请稍后重试', 'text/plain');
  }
  try {
    // ===== 静态资源（代码目录，非数据目录）=====
    if (req.method === 'GET' && url.pathname === '/ai-panel.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'ai-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/editor-shell.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'editor-shell.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/job-panel.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'job-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    // ===== 首页 =====
    if (req.method === 'GET' && url.pathname === '/') return send(200, listPage());
    // 正文提取 API（统一出口的只读视图，便于验证与调试）
    if (req.method === 'GET' && url.pathname === '/api/extract') {
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      const html = fs.readFileSync(docPath(id), 'utf8');
      const includeHidden = url.searchParams.get('hidden') === '1';
      const lines = docToLines(html, { includeHidden });
      return sendJson(200, { ok: true, lines: lines.length, text: lines.join('\n'), hash: contentHash(html) });
    }
    // ===== 编辑器 =====
    if (req.method === 'GET' && url.pathname === '/edit') {
      if (!fs.existsSync(docPath(id))) return send(404, page('404', `<h1>文档不存在: ${id}</h1><p><a href="/">返回首页</a></p>`));
      let html = fs.readFileSync(docPath(id), 'utf8');
      if (!/var DOC_ID = '[^']*'/.test(html)) return send(500, 'doc missing DOC_ID marker', 'text/plain');
      html = html.replace(/var DOC_ID = '[^']*'/, `var DOC_ID = '${id}'`);
      if (!html.includes('id="homeBtn"')) {
        html = html.replace('<button id="histBtn"', `<button id="homeBtn" class="secondary" onclick="location.href='/'">🏠 首页</button><button id="histBtn"`);
      }
      const vm = loadMeta()[id] || {};
      // 铁律一（编辑入口=渲染组装同款）+ S1 热修裁决：有效 typo = (meta.typo 定义且非空) ? meta.typo : 内联值。
      // 已迁移文档（meta.typo 定义）：serve 前剥离残留内联，非空则注入 meta.typo（'' 且无内联 → 不注入），编辑器所见即渲染所得。
      // meta.typo='' 且内联存在（手工态）：与 freezeHtml 同款回退内联（T7 承载缺陷修复，消除 WYSIWYG 分裂）。
      // legacy 文档（meta 无 typo 键）：保留内联 typo-custom 原样供编辑器显示；/save 按 Task3 路径
      // （normalizeToCurrent）把内联值抽入 meta，完成单文档迁移，往返幂等。
      if (typeof vm.typo === 'string') {
        const sp = splitDoc(html);
        html = sp.html;
        const effTypo = vm.typo || sp.typo || '';
        if (effTypo) {
          const typoBlock = `<style id="typo-custom">${effTypo}</style>`;
          html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, (mm) => typoBlock + mm) : typoBlock + html;
        }
      }
      if (vm.parent && !html.includes('id="verBadge"')) {
        html = html.replace('<button id="histBtn"', `<span id="verBadge" class="badge">${escHtml((vm.company || '') + '·' + (vm.role || ''))}</span><button id="histBtn"`);
      }
      const mtimeMs = fs.statSync(docPath(id)).mtimeMs;
      if (!html.includes(SHELL_MARK)) html = html.replace('</body>', shellBlock(id, mtimeMs) + '</body>');
      if (!html.includes(AI_MARK)) html = html.replace('</body>', aiBlock(id) + '</body>');
      if (!html.includes(JOB_MARK)) html = html.replace('</body>', jobBlock(id) + '</body>');
      return send(200, html);
    }
    // ===== 文档创建/复制/删除 =====
    if (req.method === 'POST' && url.pathname === '/new') {
      const tpl = assembleTemplate('classic');   // 主题唯一源装配（template.mjs）；代码/静态资源永远来自 APP_ROOT
      let i = 0, newId;
      do { newId = i === 0 ? 'doc' : 'doc-' + i; i++; } while (fs.existsSync(docPath(newId)));
      const html = tpl
        .replaceAll('{{NAME}}', () => '未命名')
        .replaceAll('{{CONTACT}}', () => '')
        .replaceAll('{{INTENT}}', () => '')
        .replaceAll('{{SUMMARY}}', () => '点击开始编辑…')
        .replaceAll('{{SKILLS}}', () => '<p>技能…</p>')
        .replaceAll('{{WORK}}', () => '')
        .replaceAll('{{PROJECTS}}', () => '')
        .replaceAll('{{EDU}}', () => '')
        .replaceAll('{{DOC_ID}}', () => newId);
      fs.writeFileSync(docPath(newId), html);
      // 新建即登记样式来源（meta 唯一写入者 updateMeta）：theme/styleHash/typo/schemaVersion
      updateMeta(root, newId, (m) => ({ ...(m || {}), ...themeRegistration('classic') }));
      return redirect(`/edit?id=${newId}`);
    }
    if (req.method === 'POST' && url.pathname === '/duplicate') {
      const to = url.searchParams.get('to') || '';
      if (!VALID_ID.test(to)) return send(400, 'invalid target id', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      if (fs.existsSync(docPath(to))) return send(409, 'target exists', 'text/plain');
      // 冻结点：读源文档 → freezeHtml（自包含内联 typo）→ 归一化为当前格式（禁止把冻结字节直接落成活文档）；meta 继承（rev 重置 1）。
      try {
        await withDocLock(root, id, () => {
          const srcHtml = fs.readFileSync(docPath(id), 'utf8');
          const srcMeta = loadMeta()[id] || {};
          const frozen = freezeHtml(srcHtml, srcMeta);
          const norm = normalizeToCurrent(frozen.html);
          atomicWrite(docPath(to), norm.html);
          updateMeta(root, to, () => ({
            ...(srcMeta || {}),
            typo: norm.typo,
            theme: srcMeta.theme || norm.theme || null,
            styleHash: norm.styleHash,
            rev: 1
          }));
          // 复制不经 beginTx 直接落新文档：目标 id 若残留历史未完成记录已被取代（T7 承载缺陷；留着会在下次启动恢复时把副本回滚掉）
          try { const n = dropSupersededTx(root, to); if (n) console.error(`[tx] 同文档过期事务记录已清理 ${n} 条：${to}（/duplicate）`); } catch {}
        });
      } catch (e) {
        if (e instanceof LockHeld) return sendJson(409, { ok: false, retry: true, error: '该文档正在被处理，请稍后重试' });
        throw e;
      }
      return redirect(`/edit?id=${to}`);
    }
    if (req.method === 'POST' && url.pathname === '/delete') {
      if (!url.searchParams.get('id')) return send(400, 'id required', 'text/plain');
      const docs = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.html') && !f.startsWith('.'));
      if (docs.length <= 1) return send(400, '至少保留一份文档', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      fs.unlinkSync(docPath(id));
      if (fs.existsSync(pdfPath(id))) fs.unlinkSync(pdfPath(id));
      try { fs.unlinkSync(pdfPath(id) + '.env.json'); } catch {}   // 渲染环境旁车与 PDF 成对清理
      return redirect('/');
    }
    // ===== 岗位草稿（独立文档；不依赖模型；同岗位不重复建）=====
    if (req.method === 'POST' && url.pathname === '/job/create') {
      const body = await readBodyAuto(req);
      const from = String(body.from || '');
      const company = String(body.company || '').trim();
      const role = String(body.role || '').trim();
      if (!VALID_ID.test(from)) return sendJson(400, { ok: false, error: 'invalid from' });
      if (!company || !role) return sendJson(400, { ok: false, error: '公司、岗位必填' });
      if (!fs.existsSync(docPath(from))) return sendJson(404, { ok: false, error: '母版文档不存在' });
      const metaAll = loadMeta();
      const dup = Object.keys(metaAll).find((k) => {
        const m = metaAll[k];
        return m && m.parent === from && m.company === company && m.role === role && fs.existsSync(docPath(k));
      });
      if (dup) return sendJson(409, { ok: false, existing: dup });
      // 冻结来源版本（快照 = freezeHtml + manifest），返回冻结 ts 供之后追溯
      const srcSnap = snapshot(from);
      let to, n = 2;
      while (fs.existsSync(docPath(`${from}-v${n}`))) n++;
      to = `${from}-v${n}`;
      // 冻结点：母版 freezeHtml（自包含内联 typo）→ 归一化为当前格式落活文档（禁止直接 copy 冻结字节）
      const srcHtml = fs.readFileSync(docPath(from), 'utf8');
      const srcMeta = metaAll[from] || {};
      const normJob = normalizeToCurrent(freezeHtml(srcHtml, srcMeta).html);
      atomicWrite(docPath(to), normJob.html);
      // JD：优先文本；给了链接且无文本时尝试读取，失败则记录待补充
      let jd = typeof body.jd === 'string' ? body.jd.trim() : '';
      let jdLink = typeof body.jdLink === 'string' ? body.jdLink.trim() : '';
      let jdError = '';
      if (!jd && jdLink) {
        try {
          if (!/^https?:\/\//.test(jdLink)) throw new Error('仅支持 http/https 链接');
          const r = await fetch(jdLink, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 5 * 1024 * 1024) throw new Error('页面超过 5MB 上限');
          jd = buf.toString('utf8').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
        } catch (e) { jdError = String(e.message || e); }
      }
      const nowIso = new Date().toISOString();
      // meta 唯一写入者 updateMeta：只写目标文档 to（不整表覆盖，避免踩并发更新）
      updateMeta(root, to, () => ({
        parent: from, company, role, jd, jdSource: jd ? (body.jdSource ? String(body.jdSource) : (jdLink ? jdLink : '手动')) : (jdLink || ''),
        createdAt: nowIso,
        tag: (company + '·' + role).slice(0, 20),
        typo: normJob.typo, theme: srcMeta.theme || normJob.theme || null, styleHash: normJob.styleHash, rev: 1,
        job: {
          status: 'draft', sourceSnap: srcSnap, sourceHash: contentHash(srcHtml),
          materials: Array.isArray(body.materials) ? body.materials.filter((x) => typeof x === 'string') : [],
          changes: [], todos: jdError ? [{ section: '岗位信息', question: 'JD 链接读取失败（' + jdError + '），请粘贴 JD 文本', why: '岗位匹配分析需要 JD', resolved: false }] : [],
          generatedAt: null, deliveredAt: null
        }
      }));
      if ((req.headers.accept || '').includes('application/json') || (req.headers['content-type'] || '').includes('application/json')) {
        return sendJson(200, { ok: true, id: to, jdError: jdError || null });
      }
      return redirect(`/edit?id=${to}`);
    }
    // 兼容旧入口（编辑器旧按钮）：按 /job/create 语义处理
    if (req.method === 'POST' && url.pathname === '/version/create') {
      const body = JSON.parse(await readBody(req));
      if (typeof body.company !== 'string' || !body.company.trim() || typeof body.role !== 'string' || !body.role.trim())
        return send(400, 'company 和 role 必填', 'text/plain');
      if (!body.from || !VALID_ID.test(body.from)) return send(400, 'invalid from', 'text/plain');
      if (!fs.existsSync(docPath(body.from))) return send(404, 'doc not found', 'text/plain');
      const metaAll = loadMeta();
      const dup = Object.keys(metaAll).find((k) => metaAll[k] && metaAll[k].parent === body.from && metaAll[k].company === body.company.trim() && metaAll[k].role === body.role.trim() && fs.existsSync(docPath(k)));
      if (dup) return sendJson(409, { ok: false, existing: dup, error: '同岗位草稿已存在' });
      const srcSnap = snapshot(body.from);   // 冻结点：freezeHtml + manifest，返回冻结 ts
      let to = body.to, n = 2;
      if (to) {
        if (!VALID_ID.test(to)) return send(400, 'invalid to', 'text/plain');
        if (fs.existsSync(docPath(to))) return send(409, 'target exists', 'text/plain');
      } else { while (fs.existsSync(docPath(`${body.from}-v${n}`))) n++; to = `${body.from}-v${n}`; }
      // 冻结点：母版 freezeHtml → 归一化为当前格式落活文档（禁止直接 copy 冻结字节）
      const srcHtml = fs.readFileSync(docPath(body.from), 'utf8');
      const srcMeta = metaAll[body.from] || {};
      const normVer = normalizeToCurrent(freezeHtml(srcHtml, srcMeta).html);
      atomicWrite(docPath(to), normVer.html);
      updateMeta(root, to, () => ({ parent: body.from, company: body.company.trim(), role: body.role.trim(), jd: typeof body.jd === 'string' ? body.jd : '',
        createdAt: new Date().toISOString(), tag: (body.company.trim() + '·' + body.role.trim()).slice(0, 20),
        typo: normVer.typo, theme: srcMeta.theme || normVer.theme || null, styleHash: normVer.styleHash, rev: 1,
        job: { status: 'draft', sourceSnap: srcSnap, sourceHash: contentHash(srcHtml), materials: [], changes: [], todos: [], generatedAt: null, deliveredAt: null } }));
      return redirect(`/edit?id=${to}`);
    }
    // 岗位修改清单读/写（状态持久化；应用动作由前端 DOM 执行后回写状态）
    if (req.method === 'GET' && url.pathname === '/job/changes') {
      const metaAll = loadMeta();
      const m = metaAll[id] || {};
      return sendJson(200, { ok: true, job: m.job || null, doc: { id, parent: m.parent || '', company: m.company || '', role: m.role || '', jd: m.jd || '', jdSource: m.jdSource || '' } });
    }
    if (req.method === 'POST' && url.pathname === '/job/changes') {
      const body = JSON.parse(await readBody(req));
      const updates = Array.isArray(body.updates) ? body.updates : [];
      let jobOut = null, isJob = false;
      // docs-meta 唯一写入者 updateMeta：读最新→只改本文档 job 子树→原子写（不整表覆盖）
      updateMeta(root, id, (m) => {
        if (!m || !m.job) return m;   // 非岗位草稿：原样返回（下方 404）
        isJob = true;
        for (const u of updates) {
          if (!u || typeof u.id !== 'string') continue;
          const c = m.job.changes.find((x) => x.id === u.id);
          if (!c) continue;
          if (typeof u.status === 'string' && ['pending', 'accepted', 'rejected', 'reverted', 'resolved', 'superseded'].includes(u.status)) c.status = u.status;
          if (typeof u.note === 'string') c.note = u.note;
          if (u.meta && typeof u.meta === 'object') c.meta = { ...(c.meta || {}), ...u.meta };
          c.updatedAt = new Date().toISOString();
        }
        if (Array.isArray(body.todos)) m.job.todos = body.todos;
        if (typeof body.status === 'string' && ['draft', 'deliverable', 'delivered'].includes(body.status)) m.job.status = body.status;
        jobOut = m.job;
        return m;
      });
      if (!isJob) return sendJson(404, { ok: false, error: '该文档不是岗位草稿' });
      return sendJson(200, { ok: true, job: jobOut });
    }
    // 生成建议（LLM 可选；失败不影响已有草稿与母版）
    if (req.method === 'POST' && url.pathname === '/job/generate') {
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: '未配置大模型：草稿仍可手动编辑，配置后可生成建议' });
      const body = JSON.parse(await readBody(req));
      const m0 = loadMeta()[id];
      if (!m0 || !m0.job) return sendJson(404, { ok: false, error: '该文档不是岗位草稿' });
      if (!fs.existsSync(docPath(id))) return sendJson(404, { ok: false, error: 'doc not found' });
      const docText = docToText(fs.readFileSync(docPath(id), 'utf8'), { includeHidden: false });
      const confirmedMats = loadMats().filter((x) => x.confirmed === true && m0.job.materials.includes(x.id));
      const p = buildJobPrompt({ docText, jd: m0.jd || '', company: m0.company || '', role: m0.role || '', materials: confirmedMats, twoPage: true });
      let raw;
      try { raw = await chat(root, p.sys, p.user); }
      catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + (e.message || e) }); }
      const ops = parseJobOps(raw);
      if (!ops) return sendJson(502, { ok: false, error: '模型输出无法解析为修改操作，未应用任何修改' });
      let jobOut = null, isJob = false;
      updateMeta(root, id, (m) => {
        if (!m || !m.job) return m;
        isJob = true;
        const gen = (m.job.changes.reduce((mx, c) => Math.max(mx, c.gen || 0), 0)) + 1;
        // 旧候选未处理的标记为 superseded（不覆盖已接受/已撤销的历史）
        for (const c of m.job.changes) if (c.status === 'pending') c.status = 'superseded';
        let ci = 0;
        for (const c of ops.changes) {
          ci++;
          m.job.changes.push({ id: 'g' + gen + '-c' + ci, gen, ...c, status: 'pending', createdAt: new Date().toISOString() });
        }
        m.job.todos = (m.job.todos || []).concat(ops.todos.map((t) => ({ ...t, resolved: false })));
        m.job.generatedAt = new Date().toISOString();
        m.job.status = 'draft';
        m.job.summary = ops.summary;
        jobOut = m.job;
        return m;
      });
      if (!isJob) return sendJson(404, { ok: false, error: '该文档不是岗位草稿' });
      return sendJson(200, { ok: true, job: jobOut, generated: ops.changes.length, todos: ops.todos.length });
    }
    // ===== 保存（正文与 PDF 分离；revision 冲突检测）=====
    if (req.method === 'POST' && url.pathname === '/save') {
      if (!url.searchParams.get('id')) return send(400, 'id required', 'text/plain');
      let html = await readBody(req);
      html = html
        .replace(/\n?<!--AI-INJECT-->[\s\S]*?<!--\/AI-INJECT-->\n?/g, '\n')
        .replace(/\n?<!--SHELL-INJECT-->[\s\S]*?<!--\/SHELL-INJECT-->\n?/g, '\n')
        .replace(/\n?<!--JOB-INJECT-->[\s\S]*?<!--\/JOB-INJECT-->\n?/g, '\n')
        // 运行时面板样式（head 中，不在注释对里）也要剥离
        .replace(/<style[^>]*data-ai-panel[^>]*>[\s\S]*?<\/style>/g, '')
        .replace(/<style[^>]*data-ed-shell[^>]*>[\s\S]*?<\/style>/g, '')
        .replace(/<style[^>]*data-job-panel[^>]*>[\s\S]*?<\/style>/g, '');
      if (!html.trim()) return send(400, 'empty save rejected', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      // 跨进程排他锁：保存与迁移互斥（被他人持有 → 503）。持锁贯穿整个事务，覆盖两次 rename 之间被杀的窗口。
      try { rootLock.acquire(root); }
      catch (e) { if (e instanceof LockHeld) return send(503, '另一保存/迁移正在进行（.migrate.lock），请稍后重试', 'text/plain'); throw e; }
      let out;
      try {
        out = await withDocLock(root, id, async () => {
          // 多标签保护（文档锁内检查，避免与 /rollback、/duplicate 竞态）：磁盘 mtime 已被别处推进 → 409 冲突
          const baseMtime = Number(url.searchParams.get('baseMtime') || 0);
          const force = url.searchParams.get('force') === '1';
          if (baseMtime > 0 && !force) {
            const cur = fs.statSync(docPath(id)).mtimeMs;
            if (cur > baseMtime + 2) return { status: 409, body: { ok: false, conflict: true, mtime: cur, error: '磁盘上的文档已被其他窗口更新' } };
          }
          const autosave = !!url.searchParams.get('autosave');
          const oldHtml = fs.readFileSync(docPath(id), 'utf8');
          const oldMeta = loadMeta()[id] ?? null;
          // 当前文档落盘不含 typo：剥离内联 typo-custom，值只存 meta（normalizeToCurrent 幂等）
          const norm = normalizeToCurrent(html);
          const newHtml = norm.html;
          const newTypo = norm.typo;                       // '' 表示无微调（合法历史状态）
          // 旧版冻结快照（手动保存）：freezeHtml 内联旧 meta.typo + manifest；autosave 免快照（配额）
          const oldSnapTs = autosave ? '' : snapshot(id);
          // 写前持久化事务记录（含旧正文副本 + 旧 meta 整份副本），覆盖进程中断
          const txId = beginTx(root, id, 'save', oldSnapTs);
          try {
            atomicWrite(docPath(id), newHtml);              // rename #1：正文
            const gapMs = Number(process.env.RESUME_TEST_SAVE_GAP_MS || 0);
            if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));   // 测试钩子：模拟两次 rename 之间被杀
            const prevHash = contentHash(oldHtml), newHash = contentHash(newHtml);
            updateMeta(root, id, (m) => {                   // rename #2：meta（读最新→只 patch 本文档→原子写）
              const base = { ...(m || {}) };
              base.typo = newTypo;
              base.rev = (Number(base.rev) || 0) + 1;
              // 改稿使「可投递」失效（已有投递存档不受影响）
              if (prevHash && prevHash !== newHash && base.job && base.job.status === 'deliverable') {
                base.job = { ...base.job, status: 'draft', invalidatedAt: new Date().toISOString() };
              }
              return base;
            });
            commitTx(root, txId);                           // 成功：删事务记录
          } catch (e2) {
            // 任一异常：用旧正文 + 旧 meta 副本恢复两者，再抛（外层映射状态码）。
            // 只有两次恢复都成功才删事务记录；任一失败 → 保留记录交启动恢复（否则混合态在下次启动已无从恢复）。
            let htmlBack = false, metaBack = false;
            try { atomicWrite(docPath(id), oldHtml); htmlBack = true; } catch {}
            try { updateMeta(root, id, () => oldMeta); metaBack = true; } catch {}
            if (htmlBack && metaBack) { try { commitTx(root, txId); } catch {} }
            throw e2;
          }
          // 本次保存成功 → 同文档更早的未完成记录（上一次回滚不全而保留的）已过期：
          // 留着会在下次启动恢复时把文档回滚到更早版本，丢掉这次成功保存。
          try {
            const stale = dropSupersededTx(root, id);
            if (stale) console.error(`[tx] 同文档过期事务记录已清理 ${stale} 条：${id}`);
          } catch {}
          const st = fs.statSync(docPath(id));
          // pdfStale 按渲染标识判定（staleInfo），mtime 不作依据：本次落盘正文+typo 冻结出标识，对照 lastRenderInputId。
          const savedRid = freezeHtml(newHtml, { typo: newTypo }).renderInputId;
          const saveSi = staleInfo(loadMeta()[id] || {}, { renderInputId: savedRid, pdfExists: fs.existsSync(pdfPath(id)) });
          return { status: 200, body: { ok: true, mtime: st.mtimeMs, hash: contentHash(newHtml), pdfStale: saveSi.stale } };
        });
      } catch (e) {
        if (e instanceof LockHeld) return sendJson(409, { ok: false, retry: true, error: '该文档正在被另一保存/回滚/复制处理，请稍后重试' });
        throw e;
      } finally {
        try { rootLock.release(root); } catch {}
      }
      return sendJson(out.status, out.body);
    }
    // 显式渲染 PDF（正文保存不触发渲染，避免自动保存拖渲染进程）：统一走 renderCurrent 组装，绝不直渲磁盘 HTML
    if (req.method === 'POST' && url.pathname === '/render') {
      if (!fs.existsSync(docPath(id))) return sendJson(404, { ok: false, error: 'doc not found' });
      const r = await renderCurrent(id);
      const exists = fs.existsSync(pdfPath(id));
      return sendJson(r.ok && exists ? 200 : 500, { ok: r.ok && exists, mtime: exists ? fs.statSync(pdfPath(id)).mtimeMs : 0, renderInputId: r.frozen.renderInputId, error: r.ok && exists ? null : '渲染失败（详见服务日志）' });
    }
    // ===== 投递：冻结内容 + 从冻结内容生成存档 PDF =====
    if (req.method === 'POST' && url.pathname === '/app/add') {
      const body = JSON.parse(await readBody(req));
      if (typeof body.company !== 'string' || !body.company.trim() || typeof body.role !== 'string' || !body.role.trim())
        return send(400, 'company 和 role 必填', 'text/plain');
      if (!body.docId || !VALID_ID.test(body.docId)) return send(400, 'invalid docId', 'text/plain');
      if (!fs.existsSync(docPath(body.docId))) return send(404, 'doc not found', 'text/plain');
      const now = timestamp();
      const snapTs = timestamp();
      const sDir = snapDir(body.docId);
      fs.mkdirSync(sDir, { recursive: true });
      const frozenFile = path.join(sDir, snapTs + '.html');
      // 冻结点：freezeHtml（内联当时 meta.typo、自包含）+ manifest 全字段；存档 PDF 从冻结内容渲染（铁律二）
      const frozen = writeFrozenSnapshot(sDir, snapTs, fs.readFileSync(docPath(body.docId), 'utf8'), loadMeta()[body.docId] || {});
      const hash = contentHash(frozen.html);
      fs.mkdirSync(path.join(root, 'pdfs', 'archive'), { recursive: true });
      const out = archivePath(now);
      const archiveOk = await renderDoc({ src: frozenFile, out });  // 从冻结内容生成，绝不复用旧 PDF
      const apps = loadApps();
      apps.push({
        id: now, company: body.company.trim(), role: body.role.trim(), docId: body.docId,
        jd: typeof body.jd === 'string' ? body.jd : '', note: typeof body.note === 'string' ? body.note : '',
        channel: typeof body.channel === 'string' ? body.channel.trim() : '',
        link: typeof body.link === 'string' ? body.link.trim() : '',
        appliedAt: typeof body.appliedAt === 'string' ? body.appliedAt : '',
        nextStep: typeof body.nextStep === 'string' ? body.nextStep.trim() : '',
        dueDate: typeof body.dueDate === 'string' ? body.dueDate : '',
        snapTs, contentHash: hash, status: '已投递', createdAt: now, updatedAt: now,
        archive: archiveOk && fs.existsSync(out)
          ? { status: 'ok', generatedAt: now, hash }
          : { status: 'failed', hash, error: '渲染失败，未生成存档 PDF' }
      });
      saveApps(apps);
      return sendJson(200, { ok: true, id: now, archiveOk: archiveOk && fs.existsSync(out), warning: archiveOk ? null : '存档 PDF 生成失败：已记录投递与内容快照，但存档 PDF 缺失（可在详情页从快照重新生成）' });
    }
    if (req.method === 'POST' && url.pathname === '/app/update') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      if (body.status !== undefined && !APP_STATUSES.includes(body.status)) return send(400, '非法 status', 'text/plain');
      if (body.docId !== undefined && (!VALID_ID.test(body.docId) || !fs.existsSync(docPath(body.docId)))) return send(400, 'invalid docId', 'text/plain');
      const apps = loadApps();
      const app = apps.find((a) => a.id === body.id);
      if (!app) return send(404, 'app not found', 'text/plain');
      for (const k of ['company', 'role', 'note', 'jd', 'docId', 'channel', 'link', 'appliedAt', 'nextStep', 'dueDate', 'interviews']) if (body[k] !== undefined) app[k] = body[k];
      if (body.status !== undefined) app.status = body.status;
      app.updatedAt = timestamp();
      saveApps(apps);
      return sendJson(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/app/del') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const apps = loadApps();
      if (!apps.some((a) => a.id === body.id)) return send(404, 'app not found', 'text/plain');
      saveApps(apps.filter((a) => a.id !== body.id));
      return sendJson(200, { ok: true });
    }
    // 存档 PDF：缺失明确标注；重新生成只从冻结快照还原（不用当前文档冒充）
    if (req.method === 'GET' && url.pathname === '/archive-pdf') {
      const aid = url.searchParams.get('id') || '';
      if (!/^[0-9-]+$/.test(aid)) return send(400, 'invalid id', 'text/plain');
      const p = archivePath(aid);
      if (!fs.existsSync(p)) return send(404, '该投递没有存档 PDF（当时生成失败或文件缺失）。可在投递详情页点「从快照重新生成存档」。', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="archive-${aid}.pdf"` });
      return fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/app/archive-regenerate') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const apps = loadApps();
      const app = apps.find((a) => a.id === body.id);
      if (!app) return sendJson(404, { ok: false, error: 'app not found' });
      const frozen = path.join(snapDir(app.docId), String(app.snapTs || '').replace(/[^0-9-]/g, '') + '.html');
      if (!app.snapTs || !fs.existsSync(frozen)) return sendJson(409, { ok: false, error: '原始内容快照已缺失，无法还原当时版本（不允许用当前文档冒充）' });
      const ok = await renderDoc({ src: frozen, out: archivePath(app.id) });
      app.archive = ok && fs.existsSync(archivePath(app.id))
        ? { status: 'ok', generatedAt: timestamp(), hash: app.contentHash || '' }
        : { status: 'failed', hash: app.contentHash || '', error: '渲染失败' };
      app.updatedAt = timestamp();
      saveApps(apps);
      return sendJson(ok ? 200 : 500, { ok, error: ok ? null : '渲染失败' });
    }
    // ===== 素材库（确认状态）=====
    if (req.method === 'GET' && url.pathname === '/materials') {
      const mats = loadMats();
      const unconfirmed = mats.filter((m) => m.confirmed !== true).length;
      const matCard = (m) => `<div class="card mat-card" data-mat="${escHtml(m.id)}" style="margin:10px 0">
        <b>${escHtml(m.title)}</b>${(m.tags || []).map((t) => `<span class="badge">${escHtml(t)}</span>`).join('')}${m.confirmed === true ? '<span class="badge ok">已确认</span>' : '<span class="badge warn">待确认</span>'}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:8px;font-size:13px">
          <div><b style="font-size:12px;color:var(--mut)">精简表达</b><div class="mat-brief">${escHtml(m.brief)}</div><button class="secondary" style="padding:2px 8px;font-size:12px" onclick="copyMat(this,'brief')">复制</button></div>
          <div><b style="font-size:12px;color:var(--mut)">技术表达</b><div class="mat-tech">${escHtml(m.technical || '')}</div><button class="secondary" style="padding:2px 8px;font-size:12px" onclick="copyMat(this,'tech')">复制</button></div>
          <div><b style="font-size:12px;color:var(--mut)">面试讲述</b><div class="mat-itv">${escHtml(m.interview || '')}</div><button class="secondary" style="padding:2px 8px;font-size:12px" onclick="copyMat(this,'itv')">复制</button></div>
        </div>
        ${m.attach ? `<div style="font-size:12px;color:var(--mut);margin-top:4px">附件：${escHtml(m.attach)}</div>` : ''}
        <div style="margin-top:6px;font-size:12px">${m.confirmed === true
          ? `<button class="secondary" onclick="matConfirm('${m.id}',false)">取消确认</button>`
          : `<button onclick="matConfirm('${m.id}',true)">确认可用于生成</button>`}
          <button class="secondary" onclick="matEdit('${m.id}')">✏️ 编辑</button> <button class="danger" onclick="matDel('${m.id}')">🗑 删除</button></div>
      </div>`;
      return send(200, page('素材库', `<h1>🧱 素材库</h1>
    ${corruptBanner()}
    <p style="font-size:13px;color:var(--mut)">只有「已确认」的素材会参与岗位草稿生成；旧素材默认待确认，需你预览后确认。${unconfirmed ? ` 当前 ${unconfirmed} 条待确认。` : ''}
    ${unconfirmed ? `<button class="secondary" onclick="matConfirmAll()">全部标记已确认（先预览再用）</button>` : ''}</p>
    <input id="matSearch" placeholder="搜索素材（标题/标签/内容）" style="width:100%;margin-bottom:10px" aria-label="搜索素材">
    <details class="card"><summary style="cursor:pointer;font-weight:700">＋ 新增素材</summary>
      <form id="matForm" style="margin-top:10px">
        <p>标题 <input id="mtitle" required></p>
        <p>标签（逗号分隔）<input id="mtags"></p>
        <p>精简表达<br><textarea id="mbrief" rows="2" cols="60" required></textarea></p>
        <p>技术表达<br><textarea id="mtech" rows="2" cols="60"></textarea></p>
        <p>面试讲述<br><textarea id="mitv" rows="2" cols="60"></textarea></p>
        <p>附件路径（可选）<input id="mattach"></p>
        <button>添加（默认待确认）</button><span id="matmsg"></span>
      </form>
    </details>
    <div id="matList">${mats.map(matCard).join('') || '<div style="color:var(--mut);text-align:center;padding:20px">暂无素材</div>'}</div>
    <script>var MATS = ${JSON.stringify(mats).replace(/</g, '\\u003c')};</script>
    <script>
      function copyMat(btn, key) {
        var card = btn.closest('.mat-card');
        var sel = card.querySelector(key === 'brief' ? '.mat-brief' : key === 'tech' ? '.mat-tech' : '.mat-itv');
        navigator.clipboard.writeText(sel.textContent).then(function () { btn.textContent = '✓'; setTimeout(function () { btn.textContent = '复制'; }, 800); });
      }
      function matConfirm(id, on) {
        fetch('/mat/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], confirmed: on }) }).then(function () { location.reload(); });
      }
      function matConfirmAll() {
        if (!confirm('把全部 ' + MATS.length + ' 条素材标记为已确认？先确认内容准确再操作。')) return;
        fetch('/mat/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: MATS.map(function (m) { return m.id; }), confirmed: true }) }).then(function () { location.reload(); });
      }
      function matEdit(id) {
        var m = MATS.find(function (x) { return x.id === id; });
        if (!m) return;
        var t = prompt('标题', m.title); if (t === null) return;
        var b = prompt('精简表达', m.brief); if (b === null) return;
        var te = prompt('技术表达', m.technical || ''); if (te === null) return;
        var iv = prompt('面试讲述', m.interview || ''); if (iv === null) return;
        var at = prompt('附件路径', m.attach || ''); if (at === null) return;
        fetch('/mat/update', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, title: t, brief: b, technical: te, interview: iv, attach: at }) }).then(function () { location.reload(); });
      }
      function matDel(id) {
        if (!confirm('删除这条素材？')) return;
        fetch('/mat/del', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) }).then(function () { location.reload(); });
      }
      document.getElementById('matForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var r = await fetch('/mat/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: document.getElementById('mtitle').value.trim(), brief: document.getElementById('mbrief').value.trim(),
            technical: document.getElementById('mtech').value.trim(), interview: document.getElementById('mitv').value.trim(),
            attach: document.getElementById('mattach').value.trim(), confirm: true,
            tags: document.getElementById('mtags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean) }) });
        if (r.ok) location.reload(); else document.getElementById('matmsg').textContent = ' ❌ ' + (await r.text());
      });
      document.getElementById('matSearch').addEventListener('input', function () {
        var q = this.value.toLowerCase();
        document.querySelectorAll('.mat-card').forEach(function (c) {
          c.style.display = !q || c.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      });
    </script>`, 'materials'));
    }
    if (req.method === 'POST' && url.pathname === '/mat/add') {
      const body = JSON.parse(await readBody(req));
      if (typeof body.title !== 'string' || !body.title.trim() || typeof body.brief !== 'string' || !body.brief.trim())
        return send(400, 'title 和 brief 必填', 'text/plain');
      const now = timestamp();
      const mats = loadMats();
      mats.push({ id: now, title: body.title.trim(), brief: body.brief.trim(),
        technical: typeof body.technical === 'string' ? body.technical.trim() : '',
        interview: typeof body.interview === 'string' ? body.interview.trim() : '',
        attach: typeof body.attach === 'string' ? body.attach.trim() : '',
        tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string') : [],
        confirmed: body.confirm === true,
        createdAt: now, updatedAt: now });
      saveMats(mats);
      return sendJson(200, { ok: true, id: now });
    }
    if (req.method === 'POST' && url.pathname === '/mat/update') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const mats = loadMats();
      const m = mats.find((x) => x.id === body.id);
      if (!m) return send(404, 'mat not found', 'text/plain');
      for (const k of ['title', 'brief', 'technical', 'interview', 'attach', 'tags']) if (body[k] !== undefined) m[k] = body[k];
      m.updatedAt = timestamp();
      saveMats(mats);
      return sendJson(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/mat/confirm') {
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.ids)) return send(400, 'ids 必填数组', 'text/plain');
      const mats = loadMats();
      let n = 0;
      for (const m of mats) if (body.ids.includes(m.id)) { m.confirmed = body.confirmed === true; m.updatedAt = timestamp(); n++; }
      saveMats(mats);
      return sendJson(200, { ok: true, confirmed: n });
    }
    if (req.method === 'POST' && url.pathname === '/mat/del') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const mats = loadMats();
      if (!mats.some((m) => m.id === body.id)) return send(404, 'mat not found', 'text/plain');
      saveMats(mats.filter((m) => m.id !== body.id));
      return sendJson(200, { ok: true });
    }
    // ===== 快照 =====
    if (req.method === 'POST' && url.pathname === '/snapshot/note') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const ts = path.basename(body.ts || '');
      if (!/^[0-9-]+$/.test(ts)) return send(400, 'invalid ts', 'text/plain');
      const snapFile = path.join(snapDir(body.id), ts + '.html');
      if (!fs.existsSync(snapFile)) return send(404, 'snapshot not found', 'text/plain');
      const meta = loadSnapMeta(body.id);
      meta[ts] = { name: typeof body.name === 'string' ? body.name.trim() : '', note: typeof body.note === 'string' ? body.note.trim() : '' };
      saveSnapMeta(body.id, meta);
      return sendJson(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/snapshot/baseline') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const ts = path.basename(body.ts || '');
      if (!/^[0-9-]+$/.test(ts)) return send(400, 'invalid ts', 'text/plain');
      if (!fs.existsSync(path.join(snapDir(body.id), ts + '.html'))) return send(404, 'snapshot not found', 'text/plain');
      const meta = loadSnapMeta(body.id);
      meta.__baseline = ts;
      saveSnapMeta(body.id, meta);
      return sendJson(200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/snapshot/view') {
      const ts = path.basename(url.searchParams.get('ts') || '');
      if (!VALID_ID.test(id) || !/^[0-9-]+$/.test(ts)) return send(400, 'invalid id/ts', 'text/plain');
      const snapFile = path.join(snapDir(id), ts + '.html');
      if (!fs.existsSync(snapFile)) return send(404, 'snapshot not found', 'text/plain');
      let html = fs.readFileSync(snapFile, 'utf8');
      const banner = `<div style="position:sticky;top:0;z-index:1000;background:#fef3c7;color:#92400e;padding:8px 16px;font-size:13px;text-align:center;border-bottom:2px solid #f59e0b">📜 历史快照只读预览（${ts}）</div><style>.edit-toolbar,.page-line{display:none!important}</style>`;
      html = html.replace('contenteditable="true"', '').replace("sheet.contentEditable = 'true'", '');
      return send(200, html.replace('<body>', '<body>' + banner));
    }
    if (req.method === 'GET' && url.pathname === '/snapshots') {
      const dir = snapDir(id);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse() : [];
      const meta = loadSnapMeta(id);
      const baseline = meta.__baseline || '';
      const apps = loadApps();
      const referenced = new Set(apps.filter((a) => a.docId === id && a.snapTs).map((a) => a.snapTs));
      const items = files.filter((f) => f.endsWith('.html')).map((f) => {
        const ts = f.replace('.html', '');
        const m = meta[ts] || {};
        return `<li class="card" style="margin:6px 0;padding:10px 12px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div><b>${ts}</b>${m.name ? ` <span class="badge">${escHtml(m.name)}</span>` : ''}${ts === baseline ? ' <span class="badge ok">📌 基准</span>' : ''}${referenced.has(ts) ? ' <span class="badge ai">📋 投递引用（不会被清理）</span>' : ''}
            ${m.note ? `<div style="font-size:12px;color:var(--mut);margin-top:2px">${escHtml(m.note)}</div>` : ''}</div>
            <div style="font-size:12px">
              <a href="/snapshot/view?id=${id}&ts=${ts}">预览</a> ·
              <a href="/snapshot/pdf?id=${id}&ts=${ts}" target="_blank">下载该版本 PDF</a> ·
              <a href="/diff?base=${id}@${ts}&to=${id}">对比当前</a> ·
              <button class="secondary" style="padding:2px 8px" onclick="snapNote('${id}','${ts}')">✏️</button>
              <button class="secondary" style="padding:2px 8px" onclick="snapBaseline('${id}','${ts}')">📌</button>
              <form method="post" action="/rollback?id=${id}&ts=${ts}" style="display:inline" onsubmit="return confirm('回滚到 ${ts}？当前版本会先自动留一份快照')"><button class="secondary" style="padding:2px 8px">回滚</button></form>
            </div>
          </div>
        </li>`;
      }).join('');
      return send(200, page('历史版本', `<h1>历史版本</h1>
    <p>快照 = 保存前的旧版本，当前版本不在列表中。被投递引用的快照不会被配额清理。 <a href="/edit?id=${id}">← 返回编辑</a></p>
    <ul class="doclist" style="grid-template-columns:1fr">${items || '<li>暂无快照</li>'}</ul>
    <script>
      function snapNote(id, ts) {
        var name = prompt('快照名', ''); if (name === null) return;
        var note = prompt('备注', ''); if (note === null) return;
        fetch('/snapshot/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, ts: ts, name: name, note: note }) }).then(function () { location.reload(); });
      }
      function snapBaseline(id, ts) {
        fetch('/snapshot/baseline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, ts: ts }) }).then(function () { location.reload(); });
      }
    </script>`, 'docs'));
    }
    if (req.method === 'POST' && url.pathname === '/rollback') {
      if (!url.searchParams.get('id')) return send(400, 'id required', 'text/plain');
      const ts = url.searchParams.get('ts') || '';
      const snap = path.join(snapDir(id), path.basename(ts) + '.html');
      if (!fs.existsSync(snap)) return send(404, 'snapshot not found', 'text/plain');
      // 冻结点：回滚先冻结当前版（snapshot），再读冻结快照 → 归一化为当前格式（禁止把冻结字节直接落成活文档）→ 写正文 + meta（typo/theme/styleHash 从冻结解析）→ rev++
      try {
        await withDocLock(root, id, () => {
          snapshot(id);
          const norm = normalizeToCurrent(fs.readFileSync(snap, 'utf8'));
          atomicWrite(docPath(id), norm.html);
          updateMeta(root, id, (m) => {
            const base = { ...(m || {}) };
            base.typo = norm.typo;
            base.styleHash = norm.styleHash;
            if (norm.theme != null) base.theme = norm.theme;
            base.rev = (Number(base.rev) || 0) + 1;
            return base;
          });
          // 回滚不经 beginTx 直接改文档：成功后同文档残留的未完成记录已被取代（T7 承载缺陷；留着会在下次启动恢复时把文档回滚到更早版本）
          try { const n = dropSupersededTx(root, id); if (n) console.error(`[tx] 同文档过期事务记录已清理 ${n} 条：${id}（/rollback）`); } catch {}
        });
      } catch (e) {
        if (e instanceof LockHeld) return sendJson(409, { ok: false, retry: true, error: '该文档正在被处理，请稍后重试' });
        throw e;
      }
      await renderCurrent(id);   // 当前文档渲染一律走组装入口（回滚后的正文+meta）
      return redirect(`/edit?id=${id}`);
    }
    // ===== 差异对比（统一提取；隐藏内容默认不参与，需显式 hidden=1）=====
    if (req.method === 'GET' && url.pathname === '/diff') {
      const parseRef = (ref) => {
        const m = ref.match(/^([a-z0-9][a-z0-9-]*)(?:@([0-9-]+))?$/);
        if (!m) return null;
        const [, docId, ts] = m;
        if (ts) {
          const f = path.join(snapDir(docId), ts + '.html');
          return fs.existsSync(f) ? { id: docId, label: `${docId}@${ts}`, file: f } : null;
        }
        return fs.existsSync(docPath(docId)) ? { id: docId, label: docId, file: docPath(docId) } : null;
      };
      const base = parseRef(url.searchParams.get('base') || '');
      if (!base) return send(400, 'invalid base', 'text/plain');
      const toRaw = url.searchParams.get('to') || '';
      if (!toRaw) {
        const others = fs.readdirSync(path.join(root, 'docs'))
          .filter((f) => f.endsWith('.html') && !f.startsWith('.') && f.replace('.html', '') !== base.id)
          .map((f) => f.replace('.html', ''));
        return send(200, page('对比', `<h1>选对比对象</h1><p>${escHtml(base.label)} 与谁对比？</p><ul class="doclist">${others.map((o) => `<li class="card"><a href="/diff?base=${base.label}&to=${o}">${escHtml(o)}</a></li>`).join('')}</ul><p><a href="/">返回首页</a></p>`, 'docs'));
      }
      const to = parseRef(toRaw);
      if (!to) return send(404, 'doc not found', 'text/plain');
      const includeHidden = url.searchParams.get('hidden') === '1';
      const { diffLines } = await import('./diff.mjs');
      const rows = diffLines(
        docToLines(fs.readFileSync(base.file, 'utf8'), { includeHidden }),
        docToLines(fs.readFileSync(to.file, 'utf8'), { includeHidden })
      ).map((d) => `<div class="diff-line ${d.type}">${escHtml(d.text)}</div>`).join('\n');
      return send(200, page('对比', `<h1>对比：${escHtml(base.label)} ↔ ${escHtml(to.label)}</h1>
    <p style="font-size:12px;color:var(--mut)">正文对比：${includeHidden ? '含隐藏内容' : '不含隐藏内容（隐藏章节/条目默认不参与）'}${includeHidden ? ` · <a href="/diff?base=${escHtml(base.label)}&to=${escHtml(toRaw)}">按默认口径看</a>` : ` · <a href="/diff?base=${escHtml(base.label)}&to=${escHtml(toRaw)}&hidden=1">含隐藏看</a>`}</p>
    <div class="diff">${rows}</div><p><a href="/">返回首页</a></p>`, 'docs'));
    }
    // ===== 投递看板 =====
    if (req.method === 'GET' && url.pathname === '/applications') {
      const apps = loadApps();
      const docIds = fs.readdirSync(path.join(root, 'docs'))
        .filter((f) => f.endsWith('.html') && !f.startsWith('.')).map((f) => f.replace('.html', ''));
      const nowMs = Date.now();
      if (url.searchParams.get('view') === 'table') {
        const channels = [...new Set(apps.map((a) => a.channel).filter(Boolean))];
        const row = (a) => {
          const due = a.dueDate && (new Date(a.dueDate).getTime() - nowMs) < 48 * 3600 * 1000 && new Date(a.dueDate).getTime() >= nowMs - 24 * 3600 * 1000 ? '<span class="badge warn">⚠️</span>' : '';
          const archiveBadge = a.archive && a.archive.status === 'failed' ? '<span class="badge err">存档缺失</span>' : '';
          return `<tr data-ch="${escHtml(a.channel || '')}"><td><b>${escHtml(a.company)}</b></td><td>${escHtml(a.role)}</td><td>${escHtml(a.channel || '')}</td><td>${escHtml(a.status)}</td><td>${escHtml(a.appliedAt || '')}</td><td>${escHtml(a.nextStep || '')}</td><td>${escHtml(a.dueDate || '')}${due}</td><td>${archiveBadge}<a href="/app?id=${escHtml(a.id)}">详情</a></td></tr>`;
        };
        return send(200, page('投递看板·表格', `<h1>投递看板 <a href="/applications" style="font-size:13px;font-weight:400">⇄ 看板视图</a></h1>
      ${corruptBanner()}
      <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <select id="chFilter" aria-label="渠道筛选"><option value="">全部渠道</option>${channels.map((c) => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('')}</select>
        <input id="appSearch" placeholder="搜索（公司/岗位/渠道/下一步）" style="flex:1" aria-label="搜索投递">
      </div>
      <div class="tablewrap"><table id="appTable" style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr><th tabindex="0" onclick="sortCol(0)" onkeydown="if(event.key==='Enter')sortCol(0)">公司</th><th tabindex="0" onclick="sortCol(1)" onkeydown="if(event.key==='Enter')sortCol(1)">岗位</th><th tabindex="0" onclick="sortCol(2)" onkeydown="if(event.key==='Enter')sortCol(2)">渠道</th><th tabindex="0" onclick="sortCol(3)" onkeydown="if(event.key==='Enter')sortCol(3)">状态</th><th tabindex="0" onclick="sortCol(4)" onkeydown="if(event.key==='Enter')sortCol(4)">投递日期</th><th tabindex="0" onclick="sortCol(5)" onkeydown="if(event.key==='Enter')sortCol(5)">下一步</th><th tabindex="0" onclick="sortCol(6)" onkeydown="if(event.key==='Enter')sortCol(6)">截止时间</th><th>操作</th></tr></thead>
        <tbody>${apps.map(row).join('') || '<tr><td colspan="8" style="color:var(--mut);text-align:center;padding:20px">暂无投递</td></tr>'}</tbody>
      </table></div>
      <style>#appTable th{cursor:pointer;text-align:left;padding:8px;border-bottom:2px solid var(--line)}#appTable th:hover{background:#f9fafb}#appTable td{padding:8px;border-bottom:1px solid var(--line)}#appTable th.asc::after{content:' ↑'}#appTable th.desc::after{content:' ↓'}</style>
      <script>
        var sortDir = 1, sortIdx = -1;
        function sortCol(i) {
          sortDir = sortIdx === i ? -sortDir : 1; sortIdx = i;
          document.querySelectorAll('#appTable th').forEach(function (th) { th.className = ''; });
          document.querySelectorAll('#appTable th')[i].className = sortDir === 1 ? 'asc' : 'desc';
          var tbody = document.querySelector('#appTable tbody');
          Array.from(tbody.querySelectorAll('tr')).sort(function (a, b) {
            return a.cells[i].textContent.localeCompare(b.cells[i].textContent, 'zh') * sortDir;
          }).forEach(function (tr) { tbody.appendChild(tr); });
        }
        function filterRows() {
          var ch = document.getElementById('chFilter').value, q = document.getElementById('appSearch').value.toLowerCase();
          document.querySelectorAll('#appTable tbody tr').forEach(function (tr) {
            var ok = (!ch || tr.dataset.ch === ch) && (!q || tr.textContent.toLowerCase().includes(q));
            tr.style.display = ok ? '' : 'none';
          });
        }
        document.getElementById('chFilter').onchange = filterRows;
        document.getElementById('appSearch').oninput = filterRows;
      </script>`, 'apps'));
      }
      const appCard = (a) => {
        const idx = APP_STATUSES.indexOf(a.status);
        const due = a.dueDate && (new Date(a.dueDate).getTime() - nowMs) < 48 * 3600 * 1000 && new Date(a.dueDate).getTime() >= nowMs - 24 * 3600 * 1000 ? '<span class="badge warn">⚠️</span>' : '';
        const arch = a.archive && a.archive.status === 'failed' ? '<span class="badge err" title="存档 PDF 生成失败">存档缺失</span>' : '';
        return `<div class="app-card card" data-status="${escHtml(a.status)}" data-app="${escHtml(a.id)}" style="margin:8px 0;padding:8px 10px">
          <b>${escHtml(a.company)}</b> <span style="color:#555">${escHtml(a.role)}</span>${due}
          <div style="font-size:12px;color:#555;margin:2px 0"><a href="/edit?id=${escHtml(a.docId)}">${escHtml(a.docId)}</a> <span class="badge ${a.jd ? 'ok' : 'warn'}">${a.jd ? 'JD ✓' : 'JD ✗'}</span>${arch}${a.channel ? `<span class="badge">${escHtml(a.channel)}</span>` : ''}</div>
          ${a.nextStep || a.dueDate ? `<div style="font-size:12px;color:#555">${a.nextStep ? '下一步：' + escHtml(a.nextStep) : ''}${a.dueDate ? ' 截止：' + escHtml(a.dueDate) : ''}</div>` : ''}
          ${a.note ? `<div style="font-size:12px;color:#777">${escHtml(a.note)}</div>` : ''}
          <div style="margin-top:4px;font-size:12px">
            ${idx > 0 ? `<button class="secondary" style="padding:2px 8px" onclick="appPatch('${a.id}',{status:APP_STATUSES[${idx - 1}]})">◀</button>` : ''}
            ${idx < APP_STATUSES.length - 1 && !APP_TERMINAL.includes(a.status) ? `<button class="secondary" style="padding:2px 8px" onclick="appPatch('${a.id}',{status:APP_STATUSES[${idx + 1}]})">▶</button>` : ''}
            <select style="font-size:12px;padding:2px" aria-label="状态" onchange="if(this.value)appPatch('${a.id}',{status:this.value})"><option value="">⇅</option>${APP_STATUSES.map((s) => `<option value="${s}"${s === a.status ? ' selected' : ''}>${s}</option>`).join('')}</select>
            <a href="/app?id=${escHtml(a.id)}">详情</a>
            <button class="secondary" style="padding:2px 8px" aria-label="快速编辑" onclick="appEdit('${a.id}')">✏️</button>
            <a href="/edit?id=${escHtml(a.docId)}&jdfrom=${escHtml(a.id)}" aria-label="用此 JD 匹配">🎯</a>
            <button class="danger" style="padding:2px 8px;min-height:28px" aria-label="删除投递" onclick="appDel('${a.id}')">🗑</button>
          </div>
        </div>`;
      };
      const cols = APP_STATUSES.map((st) => `<div style="min-width:200px;flex:1"><div class="group-head">${st}</div>${apps.filter((a) => a.status === st).map(appCard).join('') || '<div style="color:#999;font-size:12px;padding:4px 8px">（空）</div>'}</div>`).join('');
      return send(200, page('投递看板', `<h1>投递看板 <a href="/applications?view=table" style="font-size:13px;font-weight:400">⇄ 表格视图</a></h1>
    ${corruptBanner()}
    <p><a href="/">返回首页</a></p>
    <details class="card" id="appAddBox"><summary style="cursor:pointer;font-weight:700">＋ 新增投递（记录已发生的投递，不自动发送）</summary>
    <form id="appForm" style="margin-top:10px">
      <p>公司 <input id="company" required> 岗位 <input id="role" required> 简历 <select id="docId">${docIds.map((d) => `<option value="${d}">${escHtml(d)}</option>`).join('')}</select></p>
      <p>渠道 <input id="channel" size="12"> 投递日期 <input id="appliedAt" type="date"> 截止 <input id="dueDate" type="date"></p>
      <p>岗位链接 <input id="link" size="40"> 下一步 <input id="nextStep" size="30"></p>
      <p>JD（可选）<br><textarea id="jd" rows="3" cols="60"></textarea></p>
      <p>备注（可选）<input id="note" size="30"> <button>添加</button><span id="appmsg"></span></p>
    </form></details>
    <div class="kb">${cols}</div>
    <script>var APP_STATUSES = ${JSON.stringify(APP_STATUSES)}; var APPS = ${JSON.stringify(apps).replace(/</g, '\\u003c')};</script>
    <script>
      function appPatch(id, patch) {
        fetch('/app/update', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ id: id }, patch)) }).then(function () { location.reload(); });
      }
      function appEdit(id) {
        var a = APPS.find(function (x) { return x.id === id; });
        if (!a) return;
        var c = prompt('公司', a.company); if (c === null) return;
        var r = prompt('岗位', a.role); if (r === null) return;
        var n = prompt('备注（可空）', a.note || ''); if (n === null) return;
        var j = prompt('JD（可空）', a.jd || ''); if (j === null) return;
        appPatch(id, { company: c, role: r, note: n, jd: j });
      }
      function appDel(id) {
        if (!confirm('删除这条投递？')) return;
        fetch('/app/del', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) }).then(function () { location.reload(); });
      }
      document.getElementById('appForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var r = await fetch('/app/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company: document.getElementById('company').value.trim(), role: document.getElementById('role').value.trim(), docId: document.getElementById('docId').value,
            jd: document.getElementById('jd').value, note: document.getElementById('note').value,
            channel: document.getElementById('channel').value.trim(), link: document.getElementById('link').value.trim(),
            appliedAt: document.getElementById('appliedAt').value, nextStep: document.getElementById('nextStep').value.trim(), dueDate: document.getElementById('dueDate').value }) });
        if (r.ok) { var d = await r.json().catch(function () { return null; }); if (d && d.warning) alert(d.warning); location.reload(); }
        else document.getElementById('appmsg').textContent = ' ❌ ' + (await r.text());
      });
    </script>`, 'apps'));
    }
    // ===== 投递详情 =====
    if (req.method === 'GET' && url.pathname === '/app') {
      const aid = url.searchParams.get('id') || '';
      if (!/^[0-9-]+$/.test(aid)) return send(404, 'app not found', 'text/plain');
      const app = loadApps().find((a) => a.id === aid);
      if (!app) return send(404, 'app not found', 'text/plain');
      const interviews = Array.isArray(app.interviews) ? app.interviews : [];
      const now = Date.now();
      const dueBadge = app.dueDate && (new Date(app.dueDate).getTime() - now) < 48 * 3600 * 1000 ? '<span class="badge warn">⚠️ 到期</span>' : '';
      const archiveMissing = !app.archive || app.archive.status !== 'ok';
      const archiveLine = archiveMissing
        ? `<span class="badge err">存档 PDF 缺失</span> <button class="secondary" style="padding:2px 8px;font-size:12px" onclick="regenArchive()">从快照重新生成</button><span id="regenMsg" style="font-size:12px"></span>`
        : `<a href="/archive-pdf?id=${escHtml(app.id)}" target="_blank">存档 PDF</a> <span class="badge ok">内容哈希 ${escHtml((app.contentHash || '').slice(0, 8))}</span>`;
      return send(200, page('投递详情', `<h1>投递详情</h1>
    <div class="card">
      <b style="font-size:16px">${escHtml(app.company)}</b> ${escHtml(app.role)} ${dueBadge}
      <div style="font-size:13px;color:var(--mut);margin-top:6px">
        状态：<span class="badge">${escHtml(app.status)}</span>
        ${app.channel ? `渠道：<span class="badge">${escHtml(app.channel)}</span>` : ''}
        ${app.link ? `<a href="${escHtml(app.link)}" target="_blank" rel="noopener">岗位链接</a>` : ''}
        简历：<a href="/edit?id=${escHtml(app.docId)}">${escHtml(app.docId)}</a>
        ${app.appliedAt ? `投递日期：${escHtml(app.appliedAt)}` : ''}
        ${app.nextStep ? `下一步：${escHtml(app.nextStep)}` : ''}
        ${app.dueDate ? `截止：${escHtml(app.dueDate)}` : ''}
        ${app.snapTs ? `当时快照：<a href="/snapshot/view?id=${escHtml(app.docId)}&ts=${escHtml(app.snapTs)}">${escHtml(app.snapTs)}</a>` : ''}
        ${archiveLine}
      </div>
      ${app.jd ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--mut)">JD 全文</summary><pre style="font-size:12px;white-space:pre-wrap">${escHtml(app.jd)}</pre></details>` : ''}
      ${app.note ? `<div style="margin-top:6px;font-size:13px">${escHtml(app.note)}</div>` : ''}
    </div>
    <div class="card" style="margin-top:12px">
      <b>面试记录</b> <button class="secondary" style="padding:2px 8px;font-size:12px" onclick="ivAdd()">＋</button>
      <div id="ivList">${interviews.map((iv, i) => `<div style="border-left:3px solid var(--indigo);padding:8px;margin:8px 0;background:#fafafa">
        <b>${escHtml(iv.round || '第' + (i + 1) + '轮')}</b> <span style="color:var(--mut);font-size:12px">${escHtml(iv.time || '')}</span>
        <a href="/app/ics?id=${escHtml(app.id)}&i=${i}" target="_blank" style="font-size:12px;margin-left:8px">📅 ICS</a>
        ${iv.questions ? `<div style="font-size:13px;margin-top:4px"><b>问题：</b>${escHtml(iv.questions)}</div>` : ''}
        ${iv.answer ? `<div style="font-size:13px"><b>回答要点：</b>${escHtml(iv.answer)}</div>` : ''}
        ${iv.feedback ? `<div style="font-size:13px"><b>反馈：</b>${escHtml(iv.feedback)}</div>` : ''}
        ${iv.next ? `<div style="font-size:12px;color:var(--mut)">下一步：${escHtml(iv.next)}</div>` : ''}
      </div>`).join('') || '<div style="color:var(--mut);font-size:12px">暂无面试记录</div>'}</div>
      <details style="margin-top:8px"><summary style="cursor:pointer;font-size:13px;color:var(--indigo)">＋ 添加面试记录</summary>
        <div style="margin-top:8px;font-size:13px">
          <p>轮次 <input id="ivRound" size="10" placeholder="如：一面" required> 时间 <input id="ivTime" type="datetime-local"></p>
          <p>问题<br><textarea id="ivQ" rows="2" cols="60"></textarea></p>
          <p>回答要点<br><textarea id="ivA" rows="2" cols="60"></textarea></p>
          <p>反馈<br><textarea id="ivF" rows="2" cols="60"></textarea></p>
          <p>下一步 <input id="ivN" size="30"></p>
          <button id="ivSave">保存</button><span id="ivMsg"></span>
        </div>
      </details>
    </div>
    <div class="card" style="margin-top:12px">
      <b>AI 面试准备建议</b> <button id="prepBtn">生成</button><span id="prepMsg"></span>
      <div id="prepOut" style="margin-top:8px;font-size:13px;white-space:pre-wrap"></div>
    </div>
    <script>var APPID = '${escHtml(app.id)}';</script>
    <script>
      function regenArchive() {
        document.getElementById('regenMsg').textContent = ' 生成中…';
        fetch('/app/archive-regenerate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: APPID }) })
          .then(function (r) { return r.json(); })
          .then(function (d) { document.getElementById('regenMsg').textContent = d.ok ? ' ✅ 已生成' : (' ❌ ' + (d.error || '失败')); if (d.ok) location.reload(); })
          .catch(function (e) { document.getElementById('regenMsg').textContent = ' ❌ ' + e.message; });
      }
      document.getElementById('ivSave').onclick = function () {
        var round = document.getElementById('ivRound').value.trim();
        if (!round) { document.getElementById('ivMsg').textContent = ' ❌ 轮次必填'; return; }
        var ivs = ${JSON.stringify(interviews)};
        ivs.push({ round: round, time: document.getElementById('ivTime').value,
          questions: document.getElementById('ivQ').value, answer: document.getElementById('ivA').value,
          feedback: document.getElementById('ivF').value, next: document.getElementById('ivN').value });
        fetch('/app/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: APPID, interviews: ivs }) }).then(function () { location.reload(); });
      };
      document.getElementById('prepBtn').onclick = async function () {
        document.getElementById('prepMsg').textContent = ' 生成中…';
        try {
          var r = await fetch('/ai/prep', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: APPID }) });
          var data = await r.json();
          document.getElementById('prepOut').textContent = data.ok ? data.text : '❌ ' + (data.error || '失败');
          document.getElementById('prepMsg').textContent = data.ok ? ' ✅' : '';
        } catch (e) { document.getElementById('prepMsg').textContent = ' ❌ ' + e.message; }
      };
    </script>`, 'apps'));
    }
    if (req.method === 'GET' && url.pathname === '/app/ics') {
      const aid = url.searchParams.get('id') || '';
      const idx = parseInt(url.searchParams.get('i') || '0', 10);
      if (!/^[0-9-]+$/.test(aid)) return send(404, 'app not found', 'text/plain');
      const app = loadApps().find((a) => a.id === aid);
      if (!app) return send(404, 'app not found', 'text/plain');
      const ivs = Array.isArray(app.interviews) ? app.interviews : [];
      if (idx < 0 || idx >= ivs.length) return send(404, 'interview not found', 'text/plain');
      const iv = ivs[idx];
      const dt = (iv.time || '').replace(/[-:]/g, '').replace('T', 'T') + '00';
      const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
        `UID:${app.id}-${idx}@resume.local`, `DTSTART:${dt}`,
        `SUMMARY:${app.company} ${iv.round || '面试'}`.replace(/[,;\\]/g, (m) => '\\' + m),
        `DESCRIPTION:${(iv.questions || '').replace(/\n/g, '\\n')}`.slice(0, 500),
        'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="interview-${idx + 1}.ics"` });
      return res.end(ics);
    }
    if (req.method === 'POST' && url.pathname === '/ai/prep') {
      if (!hasLLM(root)) return send(409, '未配置大模型', 'text/plain');
      const body = JSON.parse(await readBody(req));
      if (!body.id || !/^[0-9-]+$/.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const app = loadApps().find((a) => a.id === body.id);
      if (!app) return send(404, 'app not found', 'text/plain');
      const docText = fs.existsSync(docPath(app.docId)) ? docToText(fs.readFileSync(docPath(app.docId), 'utf8')) : '';
      const sys = '你是面试准备教练。根据 JD 和简历给出 3-5 条具体准备建议（可能问什么、怎么答、注意什么），中文简洁。';
      const user = `【JD】\n${app.jd || '（无 JD）'}\n\n【简历】\n${docText}`;
      const text = await chat(root, sys, user);
      return sendJson(200, { ok: true, text });
    }
    // ===== JD 链接读取 =====
    if (req.method === 'POST' && url.pathname === '/ai/jd-text') {
      const body = JSON.parse(await readBody(req));
      if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url.trim()))
        return send(400, 'url 仅支持 http/https', 'text/plain');
      try {
        const r = await fetch(body.url.trim(), { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) throw new Error('页面超过 5MB 上限');
        const text = buf.toString('utf8')
          .replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
        return sendJson(200, { ok: true, text });
      } catch (e) {
        return sendJson(200, { ok: false, error: String(e.message || e) });
      }
    }
    if (req.method === 'GET' && url.pathname === '/app/jd') {
      const aid = url.searchParams.get('id') || '';
      if (!/^[0-9-]+$/.test(aid)) return send(404, 'app not found', 'text/plain');
      const app = loadApps().find((a) => a.id === aid);
      if (!app) return send(404, 'app not found', 'text/plain');
      return sendJson(200, { ok: true, jd: app.jd || '' });
    }
    // ===== 设置页 + 备份恢复 =====
    if (req.method === 'GET' && url.pathname === '/settings') {
      const { active, profiles } = loadProfiles(root);
      return send(200, page('大模型设置', `<h1>大模型设置</h1>
    ${corruptBanner()}
    <p>OpenAI 兼容格式，火山方舟可直接用（baseURL 填 <code>https://ark.cn-beijing.volces.com/api/v3</code>）。配置存本地 config.json，不进任何仓库、不进备份。</p>
    <div id="cards"></div>
    <p><button type="button" id="addBtn">➕ 添加配置</button> <button type="button" id="saveBtn">保存</button> <a href="/">返回首页</a> <span id="msg"></span></p>
    <div class="card" style="margin-top:20px">
      <b>💾 备份与恢复</b>
      <p style="font-size:13px;color:var(--mut)">备份含 docs/snapshots/pdfs 与三个 JSON（docs-meta/applications/materials），<b>不含 config.json（密钥不进备份）</b>。</p>
      <p><a href="/backup"><button>下载备份</button></a> <span style="font-size:12px;color:var(--mut)">恢复默认「合并」：本地独有记录保留，同 id 冲突以备份为准，预览里逐条列出</span></p>
      <form id="restoreForm"><input type="file" id="restoreFile" accept=".tar.gz,.tgz">
        <label style="font-size:13px"><input type="radio" name="rmode" value="merge" checked> 合并（推荐）</label>
        <label style="font-size:13px"><input type="radio" name="rmode" value="replace"> 替换（清空现有后导入）</label>
        <button type="submit">恢复</button><span id="restoreMsg"></span></form>
      <div id="restorePreview" style="font-size:13px;margin-top:8px"></div>
      <p style="font-size:12px;color:var(--mut)">每次恢复前自动生成回退点（backups/），失败可一键回退。</p>
      <div id="undoBox"></div>
    </div>
    <script>var DATA = ${JSON.stringify({ active, profiles }).replace(/</g, '\\u003c')}</script>
    <script>
      var state = DATA;
      function escAttr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
      function inp(i, f, label, val, extra) {
        return '<p>' + label + '<br><input ' + (extra || 'size="46"') + ' value="' + escAttr(val) + '" oninput="state.profiles[' + i + '].' + f + '=this.value"></p>';
      }
      function render() {
        var box = document.getElementById('cards');
        box.innerHTML = '';
        state.profiles.forEach(function (p, i) {
          var card = document.createElement('div');
          card.className = 'card';
          card.innerHTML =
            '<p><label><input type="radio" name="act"' + (i === state.active ? ' checked' : '') + ' onchange="state.active=' + i + '"> 启用</label> <b>配置 ' + (i + 1) + '</b> <button type="button" class="secondary" onclick="delCard(' + i + ')">删除</button></p>'
            + inp(i, 'name', '名称', p.name, 'size="12"')
            + inp(i, 'baseURL', 'Base URL', p.baseURL)
            + inp(i, 'apiKey', 'API Key', p.apiKey, 'size="46" type="password"')
            + inp(i, 'model', '模型', p.model, 'size="46" list="models-' + i + '"')
            + '<datalist id="models-' + i + '"></datalist>'
            + '<p><button type="button" onclick="testCard(' + i + ')">测试连接</button> <span id="msg-' + i + '"></span></p>';
          box.appendChild(card);
        });
      }
      function delCard(i) {
        if (!confirm('删除该配置？保存后生效')) return;
        state.profiles.splice(i, 1);
        if (state.active >= state.profiles.length) state.active = Math.max(0, state.profiles.length - 1);
        render();
      }
      async function testCard(i) {
        var p = state.profiles[i], msg = document.getElementById('msg-' + i);
        msg.textContent = ' 测试中…';
        try {
          var r = await fetch('/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ baseURL: p.baseURL.trim(), apiKey: p.apiKey.trim() }) });
          var data = await r.json();
          if (data.ok) {
            msg.textContent = ' ✅ 连接成功，' + data.models.length + ' 个模型可用';
            document.getElementById('models-' + i).innerHTML = data.models.map(function (m) { return '<option value="' + String(m).replace(/"/g, '') + '">'; }).join('');
          } else msg.textContent = ' ❌ ' + data.error;
        } catch (e) { msg.textContent = ' ❌ ' + (e.message || e); }
      }
      document.getElementById('addBtn').onclick = function () { state.profiles.push({ name: '', baseURL: '', apiKey: '', model: '' }); render(); };
      document.getElementById('saveBtn').onclick = async function () {
        var r = await fetch('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
        document.getElementById('msg').textContent = r.ok ? ' ✅ 已保存' : ' ❌ ' + (await r.text());
      };
      render();
      function diffLinesToHtml(prev) {
        var lines = [];
        function sec(title, items) { if (!items || !items.length) return; lines.push('<div style="margin-top:6px"><b>' + title + '</b></div>'); items.forEach(function (x) { lines.push('<div>· ' + x + '</div>'); }); }
        var d = prev.docs || {}, a = prev.apps || {}, m = prev.mats || {}, meta = prev.meta || {};
        sec('文档（新增 ' + (d.add || []).length + ' / 冲突 ' + (d.conflict || []).length + ' / 本地保留 ' + (d.keep || []).length + '）',
          (d.add || []).slice(0, 10).map(function (x) { return '新增 ' + x; })
            .concat((d.conflict || []).slice(0, 10).map(function (x) { return '覆盖（同 id 内容不同）' + x; }))
            .concat((d.keep || []).slice(0, 10).map(function (x) { return '保留本地独有 ' + x; })));
        sec('投递（新增 ' + (a.add || []).length + ' / 冲突 ' + (a.conflict || []).length + ' / 本地保留 ' + (a.keep || []).length + '）',
          (a.conflict || []).slice(0, 8).map(function (x) { return '以备份为准覆盖：' + x; }));
        sec('素材（新增 ' + (m.add || []).length + ' / 冲突 ' + (m.conflict || []).length + '）',
          (m.conflict || []).slice(0, 8).map(function (x) { return '以备份为准覆盖：' + x; }));
        lines.push('<div style="margin-top:6px;color:var(--mut)">快照 ' + (prev.snapshots || 0) + ' 个 · PDF ' + (prev.pdfs || 0) + ' 个 · 预计恢复点数 ' + (prev.total || 0) + '</div>');
        return lines.join('');
      }
      document.getElementById('restoreForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var f = document.getElementById('restoreFile').files[0];
        if (!f) return;
        var msg = document.getElementById('restoreMsg');
        msg.textContent = ' 上传中…';
        var buf = await f.arrayBuffer();
        var prev = await fetch('/restore?apply=0', { method: 'POST', body: buf }).then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: '上传失败' }; });
        if (!prev.ok) { msg.textContent = ' ❌ ' + (prev.error || '非法备份包'); return; }
        document.getElementById('restorePreview').innerHTML = diffLinesToHtml(prev);
        var mode = document.querySelector('input[name=rmode]:checked').value;
        if (!confirm('按「' + (mode === 'merge' ? '合并' : '替换') + '」恢复？恢复前会自动生成回退点。')) { msg.textContent = ' 已取消'; return; }
        msg.textContent = ' 执行恢复…';
        var r2 = await fetch('/restore?apply=1&mode=' + mode, { method: 'POST', body: buf });
        var data = await r2.json();
        msg.textContent = data.ok ? ' ✅ 已恢复' : ' ❌ ' + (data.error || '失败');
        if (data.ok && data.safety) {
          document.getElementById('undoBox').innerHTML = '<button class="secondary" onclick="undoRestore(\\'' + data.safety + '\\')">↩ 回退这次恢复</button> <span id="undoMsg" style="font-size:12px"></span>';
        }
      });
      async function undoRestore(ts) {
        if (!confirm('回退到恢复前状态？')) return;
        var r = await fetch('/restore/undo?ts=' + encodeURIComponent(ts), { method: 'POST' });
        var d = await r.json().catch(function () { return { ok: false }; });
        document.getElementById('undoMsg').textContent = d.ok ? ' ✅ 已回退' : ' ❌ ' + (d.error || '失败');
      }
    </script>`, 'settings'));
    }
    if (req.method === 'POST' && url.pathname === '/ai/test') {
      const body = JSON.parse(await readBody(req));
      if (!body.baseURL || !body.apiKey) return send(400, JSON.stringify({ ok: false, error: 'Base URL 和 API Key 必填' }), 'application/json');
      try {
        const models = await listModels(body.baseURL, body.apiKey);
        return sendJson(200, { ok: true, models });
      } catch (e) {
        return sendJson(200, { ok: false, error: String(e.message || e) });
      }
    }
    if (req.method === 'POST' && url.pathname === '/settings') {
      const body = JSON.parse(await readBody(req));
      const profiles = body.profiles;
      if (!Array.isArray(profiles)) return send(400, 'profiles 必填', 'text/plain');
      const names = new Set();
      for (const p of profiles) {
        if (!p || !['name', 'baseURL', 'apiKey', 'model'].every((k) => typeof p[k] === 'string' && p[k].trim()))
          return send(400, '每个配置需 name/baseURL/apiKey/model 非空字符串', 'text/plain');
        if (names.has(p.name)) return send(400, 'name 重复: ' + p.name, 'text/plain');
        names.add(p.name);
      }
      if (profiles.length && (typeof body.active !== 'number' || !Number.isInteger(body.active) || body.active < 0 || body.active >= profiles.length))
        return send(400, 'active 需为 0-' + (profiles.length - 1) + ' 的整数', 'text/plain');
      const cfgTmp = path.join(root, 'config.json.tmp');
      fs.writeFileSync(cfgTmp, JSON.stringify({ active: profiles.length ? body.active : 0, profiles }));
      fs.renameSync(cfgTmp, path.join(root, 'config.json'));
      return sendJson(200, { ok: true });
    }
    // ===== AI（统一正文提取；不再包含工具栏/占位符/隐藏内容）=====
    if (req.method === 'POST' && url.pathname === '/ai/rewrite') {
      if (!hasLLM(root)) return send(409, '未配置大模型，请先到首页的"⚙️ 大模型设置"', 'text/plain');
      const body = JSON.parse(await readBody(req));
      if (!body.text || !body.instruction) return send(400, 'text 和 instruction 必填', 'text/plain');
      const p = buildRewrite(body.text, body.instruction);
      const revised = await chat(root, p.sys, p.user);
      return sendJson(200, { ok: true, revised });
    }
    if (req.method === 'POST' && url.pathname === '/ai/chat') {
      if (!hasLLM(root)) return send(409, '未配置大模型，请先到首页的"⚙️ 大模型设置"', 'text/plain');
      const body = JSON.parse(await readBody(req));
      if (!body.message) return send(400, 'message 必填', 'text/plain');
      if (body.id && !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const docId = body.id || id;
      const stale = staleGuard(docId, body.baseMtime);
      if (stale) return sendJson(409, stale);
      const docHtml = fs.existsSync(docPath(docId)) ? fs.readFileSync(docPath(docId), 'utf8') : '';
      const docText = docToText(docHtml, { includeHidden: false });
      const msgs = [{ role: 'system', content: buildChat(docText) }];
      for (const m of (body.history || []).slice(-10)) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') msgs.push({ role: m.role, content: m.content });
      }
      msgs.push({ role: 'user', content: body.message });
      const raw = await chatMsgs(root, msgs);
      const parsed = parseChanges(raw);
      return sendJson(200, { ok: true, ...(parsed || { reply: raw }) });
    }
    if (req.method === 'POST' && url.pathname === '/restructure') {
      if (!hasLLM(root)) return send(409, '未配置大模型，请先到"⚙️ 大模型设置"', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      const html = fs.readFileSync(docPath(id), 'utf8');
      if (!html.includes('以下为 PDF 提取的原文')) return send(400, '该文档不是降级文档', 'text/plain');
      const text = docToLines(html).filter((l) => !l.includes('以下为 PDF 提取的原文')).join('\n');
      const structured = await structureText(root, text).catch(() => null);
      if (!structured) return send(502, 'LLM 结构化失败，文档未改动', 'text/plain');
      snapshot(id);
      const tmp = docPath(id) + '.' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.tmp';
      fs.writeFileSync(tmp, structured);
      fs.renameSync(tmp, docPath(id));
      // 再生文档 = 装配产出的全新 classic 文档：重新登记样式来源（旧正文与旧 typo 已在上方快照中冻结）
      updateMeta(root, id, (m) => ({ ...(m || {}), ...themeRegistration('classic') }));
      await renderCurrent(id);   // 当前文档渲染一律走组装入口
      return redirect(`/edit?id=${id}`);
    }
    if (req.method === 'POST' && url.pathname === '/ai/review') {
      if (!hasLLM(root)) return send(409, '未配置大模型，请先到首页的"⚙️ 大模型设置"', 'text/plain');
      const body = JSON.parse(await readBody(req));
      if (body.id && !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      if (body.mode !== 'full' && body.mode !== 'quant') return send(400, "mode 仅支持 'full'|'quant'", 'text/plain');
      const docId = body.id || id;
      if (!fs.existsSync(docPath(docId))) return send(404, 'doc not found', 'text/plain');
      const stale = staleGuard(docId, body.baseMtime);
      if (stale) return sendJson(409, stale);
      const docText = docToText(fs.readFileSync(docPath(docId), 'utf8'), { includeHidden: false });
      const p = buildReview(docText, body.mode);
      const raw = await chat(root, p.sys, p.user);
      const parsed = parseReport(raw);
      return sendJson(200, parsed ? { ok: true, report: parsed } : { ok: true, reply: raw });
    }
    if (req.method === 'POST' && url.pathname === '/ai/match') {
      if (!hasLLM(root)) return send(409, '未配置大模型，请先到首页的"⚙️ 大模型设置"', 'text/plain');
      const body = JSON.parse(await readBody(req));
      if (body.id && !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      if (typeof body.jd !== 'string' || !body.jd.trim()) return send(400, 'jd 必填', 'text/plain');
      const docId = body.id || id;
      if (!fs.existsSync(docPath(docId))) return send(404, 'doc not found', 'text/plain');
      const stale = staleGuard(docId, body.baseMtime);
      if (stale) return sendJson(409, stale);
      const docText = docToText(fs.readFileSync(docPath(docId), 'utf8'), { includeHidden: false });
      const p = buildMatch(docText, body.jd);
      const raw = await chat(root, p.sys, p.user);
      const parsed = parseReport(raw);
      return sendJson(200, parsed ? { ok: true, report: parsed } : { ok: true, reply: raw });
    }
    // ===== 标签 / 关联 =====
    if (req.method === 'POST' && url.pathname === '/tag') {
      const body = JSON.parse(await readBody(req));
      if (body.id && !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      const docId = body.id || id;
      if (typeof body.tag !== 'string') return send(400, 'tag 必填字符串', 'text/plain');
      if (!fs.existsSync(docPath(docId))) return send(404, 'doc not found', 'text/plain');
      const tag = body.tag.trim().slice(0, 20).replace(/['"\\]/g, '');
      // docs-meta 唯一写入者 updateMeta：只改本文档 tag（空 → 删 tag；条目空 → 删条目）
      updateMeta(root, docId, (m) => {
        const next = { ...(m || {}) };
        if (tag) next.tag = tag; else delete next.tag;
        return Object.keys(next).length ? next : null;
      });
      return sendJson(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/link') {
      const body = JSON.parse(await readBody(req));
      if (!body.id || !VALID_ID.test(body.id)) return send(400, 'invalid id', 'text/plain');
      if (!['zh', 'en'].includes(body.lang)) return send(400, 'lang 仅 zh|en', 'text/plain');
      if (!fs.existsSync(docPath(body.id))) return send(404, 'doc not found', 'text/plain');
      if (!body.linkedTo) {
        updateMeta(root, body.id, (m) => { if (!m) return m; const next = { ...m }; delete next.linkedTo; delete next.lang; return next; });
      } else {
        if (!VALID_ID.test(body.linkedTo)) return send(400, 'invalid linkedTo', 'text/plain');
        if (!fs.existsSync(docPath(body.linkedTo))) return send(404, 'linked doc not found', 'text/plain');
        updateMeta(root, body.id, (m) => ({ ...(m || {}), lang: body.lang, linkedTo: body.linkedTo }));
      }
      return sendJson(200, { ok: true });
    }
    // ===== 复盘 =====
    if (req.method === 'GET' && url.pathname === '/stats') {
      const apps = loadApps();
      if (!apps.length) return send(200, page('复盘', `<h1>📊 复盘统计</h1><div class="card" style="text-align:center;padding:40px;color:var(--mut)">暂无投递记录<br><br><a href="/applications">先去投递看板添加记录</a></div>`, 'apps'));
      const funnel = APP_STATUSES.map((s) => [s, apps.filter((a) => a.status === s).length]);
      const byCh = {}; apps.forEach((a) => { byCh[a.channel || '未填'] = (byCh[a.channel || '未填'] || 0) + 1; });
      const byDoc = {}; apps.forEach((a) => { byDoc[a.docId] = (byDoc[a.docId] || 0) + 1; });
      const byTag = {}; const meta = loadMeta(); apps.forEach((a) => { const t = (meta[a.docId] || {}).tag || '未标记'; byTag[t] = (byTag[t] || 0) + 1; });
      const interviewed = apps.filter((a) => ['面试中', 'offer'].includes(a.status) || (Array.isArray(a.interviews) && a.interviews.length)).length;
      const n = apps.length;
      const funnelBar = funnel.map(([s, c]) => `<div style="display:flex;align-items:center;margin:4px 0"><span style="width:70px;font-size:12px">${s}</span><div style="flex:1;background:#f3f4f6;border-radius:4px;height:20px"><div style="background:var(--indigo);height:100%;border-radius:4px;width:${n ? (c / n * 100) : 0}%"></div></div><span style="width:30px;text-align:right;font-size:12px">${c}</span></div>`).join('');
      const warn = n < 10 ? `<div class="badge warn" style="margin-bottom:10px">样本量小（n=${n}），仅供参考</div>` : '';
      return send(200, page('复盘', `<h1>📊 复盘统计 <span style="font-size:13px;font-weight:400;color:var(--mut)">n=${n}</span></h1>${warn}
    <div class="card"><b>状态分布</b><div style="font-size:11px;color:var(--mut);margin:4px 0">当前状态计数（非阶段漏斗；有面试记录即计入面试口径）</div>${funnelBar}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:12px">
      <div class="card"><b>按渠道</b>${Object.entries(byCh).map(([k, v]) => `<div style="display:flex;justify-content:space-between;margin:4px 0"><span>${escHtml(k)}</span><span>${v}</span></div>`).join('')}</div>
      <div class="card"><b>按简历版本</b>${Object.entries(byDoc).map(([k, v]) => `<div style="display:flex;justify-content:space-between;margin:4px 0"><span>${escHtml(k)}</span><span>${v}</span></div>`).join('')}</div>
      <div class="card"><b>按岗位方向</b>${Object.entries(byTag).map(([k, v]) => `<div style="display:flex;justify-content:space-between;margin:4px 0"><span>${escHtml(k)}</span><span>${v}</span></div>`).join('')}</div>
    </div>
    <div class="card" style="margin-top:12px"><b>面试参与</b><p style="font-size:13px">${interviewed}/${n} 有面试安排或已进入面试（${n ? Math.round(interviewed / n * 100) : 0}%）；预约不等于完成。</p></div>`, 'apps'));
    }
    // ===== 备份 =====
    if (req.method === 'GET' && url.pathname === '/backup') {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + new Date().toTimeString().slice(0, 5).replace(':', '');
      const child = spawn('tar', ['czf', '-', '-C', root, 'docs', 'snapshots', 'pdfs', 'docs-meta.json', 'applications.json', 'materials.json'], { stdio: ['ignore', 'pipe', 'ignore'] });
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="resume-backup-${stamp}.tar.gz"` });
      child.stdout.pipe(res);
      child.on('close', () => { if (!res.writableEnded) res.end(); });
      return;
    }
    // ===== 恢复（校验 → 预览 → 安全点 → 合并/替换；支持回退）=====
    if (req.method === 'POST' && url.pathname === '/restore') {
      const ts = Date.now();
      const tmpTar = path.join(os.tmpdir(), `resume-restore-${ts}.tar.gz`);
      try { await readBodyToFile(req, tmpTar, 300 * 1024 * 1024); }
      catch (e) {
        fs.rmSync(tmpTar, { force: true });
        return send(e.message === 'body too large' ? 413 : 400, JSON.stringify({ ok: false, error: '备份包上传失败：' + e.message }), 'application/json');
      }
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-restore-'));
      const fail = (msg, code = 400) => { fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(tmpTar, { force: true }); return sendJson(code, { ok: false, error: msg }); };
      // 条目校验：类型/路径/大小，防路径穿越
      let list = '';
      try { list = execFileSync('tar', ['tzf', tmpTar], { maxBuffer: 20 * 1024 * 1024 }).toString('utf8'); }
      catch { return fail('不是合法的 tar.gz 备份包'); }
      const entries = list.split('\n').filter(Boolean);
      if (!entries.length || entries.length > 20000) return fail('备份包条目数异常');
      const ALLOWED = /^(docs\/|snapshots\/|pdfs\/|docs-meta\.json$|applications\.json$|materials\.json$)/;
      for (const e of entries) {
        if (e.startsWith('/') || e.includes('..') || !ALLOWED.test(e.replace(/^\.\//, ''))) return fail('备份包含不允许的条目：' + e.slice(0, 80));
      }
      try { execFileSync('tar', ['xzf', tmpTar, '-C', stage], { stdio: 'pipe' }); }
      catch { return fail('解包失败，备份包可能损坏'); }
      const hasContent = ['docs', 'snapshots', 'pdfs', 'docs-meta.json', 'applications.json', 'materials.json'].some((x) => fs.existsSync(path.join(stage, x)));
      if (!hasContent) return fail('备份包中没有可恢复的内容');
      // 预览：逐条差异（新增/冲突/保留）
      const idsOf = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => f.replace('.html', '')) : [];
      const hashFile = (f) => contentHash(fs.readFileSync(f));
      const compareDocs = () => {
        const localIds = idsOf(path.join(root, 'docs'));
        const bakIds = idsOf(path.join(stage, 'docs'));
        const result = { add: [], conflict: [], keep: [] };
        for (const bid of bakIds) {
          const bf = path.join(stage, 'docs', bid + '.html');
          const lf = path.join(root, 'docs', bid + '.html');
          if (!fs.existsSync(lf)) result.add.push(bid);
          else if (hashFile(bf) !== hashFile(lf)) result.conflict.push(bid);
        }
        result.keep = localIds.filter((lid) => !bakIds.includes(lid));
        return result;
      };
      const jsonIds = (file, key = 'id') => {
        const f = path.join(stage, file);
        if (!fs.existsSync(f)) return null;
        try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a : []; }
        catch { return 'CORRUPT'; }
      };
      const compareJson = (file) => {
        const bak = jsonIds(file);
        if (bak === 'CORRUPT') return { corrupt: true, add: [], conflict: [], keep: [] };
        if (bak === null) return { add: [], conflict: [], keep: [] };
        const local = file === 'materials.json' ? loadMats() : loadApps();
        const localIds = new Set(local.map((x) => x.id));
        const bakIds = new Set(bak.map((x) => x.id));
        const result = { add: [], conflict: [], keep: [] };
        for (const b of bak) {
          if (!localIds.has(b.id)) result.add.push(b.id);
          else {
            const l = local.find((x) => x.id === b.id);
            if (JSON.stringify(l) !== JSON.stringify(b)) result.conflict.push(b.id);
          }
        }
        result.keep = [...localIds].filter((x) => !bakIds.has(x));
        return result;
      };
      let metaPreview = {};                                  // 备份 meta：缺失 → {}；损坏 → { corrupt: true }（apply 前拒绝，不退化成 {} 全删）
      try { const sm = readMetaSnapshotAt(path.join(stage, 'docs-meta.json')); metaPreview = sm ? { count: Object.keys(sm).length } : {}; }
      catch { metaPreview = { corrupt: true }; }
      const preview = {
        ok: true,
        docs: compareDocs(),
        apps: compareJson('applications.json'),
        mats: compareJson('materials.json'),
        meta: metaPreview,
        snapshots: entries.filter((l) => l.startsWith('snapshots/') && l.endsWith('.html')).length,
        pdfs: entries.filter((l) => l.startsWith('pdfs/') && l.endsWith('.pdf')).length
      };
      preview.total = preview.docs.add.length + preview.docs.conflict.length + preview.apps.add.length + preview.apps.conflict.length + preview.mats.add.length + preview.mats.conflict.length;
      if (url.searchParams.get('apply') !== '1') {
        fs.rmSync(stage, { recursive: true, force: true });
        fs.rmSync(tmpTar, { force: true });
        return sendJson(200, preview);
      }
      // 损坏的备份 meta 必须在任何删除/覆盖动作之前拒绝：否则 replace 会先清空本地 docs 再把 meta 当成 {} 全删
      if (preview.meta.corrupt) return fail('备份中的 docs-meta.json 损坏，拒绝恢复（不覆盖本地 meta）', 500);
      if (preview.apps.corrupt || preview.mats.corrupt) return fail('备份中的 JSON 损坏，拒绝恢复');
      const mode = url.searchParams.get('mode') === 'replace' ? 'replace' : 'merge';
      // 回退点（可操作）：数据根 backups/restore-<ts>/
      const safety = path.join(root, 'backups', 'restore-' + ts);
      fs.mkdirSync(path.join(safety, 'data'), { recursive: true });
      for (const d of ['docs', 'snapshots', 'pdfs']) if (fs.existsSync(path.join(root, d))) fs.cpSync(path.join(root, d), path.join(safety, 'data', d), { recursive: true });
      for (const f of ['docs-meta.json', 'applications.json', 'materials.json']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(safety, 'data', f));
      fs.writeFileSync(path.join(safety, 'manifest.json'), JSON.stringify({ ts, mode, at: new Date().toISOString(), preview }));
      try {
        if (mode === 'replace') {
          for (const d of ['docs', 'snapshots', 'pdfs']) {
            const src = path.join(stage, d);
            if (!fs.existsSync(src)) continue;
            for (const f of fs.readdirSync(path.join(root, d))) fs.rmSync(path.join(root, d, f), { recursive: true, force: true });
            fs.cpSync(src, path.join(root, d), { recursive: true });
          }
          for (const f of ['applications.json', 'materials.json']) if (fs.existsSync(path.join(stage, f))) fs.copyFileSync(path.join(stage, f), path.join(root, f));
          // docs-meta 成对替换：经 updateMeta 逐文档写（唯一写入者），不裸 copyFileSync 覆盖共享文件；损坏 → 抛 CORRUPT（500），绝不当成 {}
          const repMeta = readMetaSnapshotAt(path.join(stage, 'docs-meta.json'));
          if (repMeta) applyMetaSnapshot(repMeta);
        } else {
          // 合并：文档/快照按文件合并（同 id 以备份为准）；JSON 按 id 合并，本地独有保留
          for (const d of ['docs', 'snapshots']) {
            const src = path.join(stage, d);
            if (fs.existsSync(src)) fs.cpSync(src, path.join(root, d), { recursive: true });
          }
          // PDF：只补本地缺失的（不覆盖本地较新产物）；存档 PDF 缺失时补齐
          const srcP = path.join(stage, 'pdfs');
          if (fs.existsSync(srcP)) {
            const copyMissing = (from, to) => {
              for (const f of fs.readdirSync(from)) {
                const s = path.join(from, f), t = path.join(to, f);
                if (fs.statSync(s).isDirectory()) { fs.mkdirSync(t, { recursive: true }); copyMissing(s, t); }
                else if (!fs.existsSync(t)) fs.copyFileSync(s, t);
              }
            };
            fs.mkdirSync(path.join(root, 'pdfs'), { recursive: true });
            copyMissing(srcP, path.join(root, 'pdfs'));
          }
          const mergeById = (file, loadFn, saveFn) => {
            const bak = jsonIds(file);
            if (!bak) return;
            const local = loadFn();
            const map = new Map(local.map((x) => [x.id, x]));
            for (const b of bak) map.set(b.id, b);   // 同 id：以备份为准（预览中已列出冲突）
            saveFn([...map.values()]);
          };
          mergeById('applications.json', loadApps, saveApps);
          mergeById('materials.json', loadMats, saveMats);
          const metaStage = path.join(stage, 'docs-meta.json');
          const bakMeta = readMetaSnapshotAt(metaStage);      // 损坏 → 抛 CORRUPT（500），绝不静默跳过或当成 {}
          if (bakMeta) {
            // 成对合并：同 id 以备份为准，逐文档经 updateMeta 写（本地独有文档保留，不整表覆盖）
            for (const k of Object.keys(bakMeta)) updateMeta(root, k, () => bakMeta[k]);
          }
        }
      } catch (e) {
        return sendJson(500, { ok: false, error: '恢复过程中失败：' + (e.message || e) + '（回退点：' + safety + '）', safety });
      } finally {
        fs.rmSync(stage, { recursive: true, force: true });
        fs.rmSync(tmpTar, { force: true });
      }
      return sendJson(200, { ok: true, safety: path.basename(safety), mode, applied: preview });
    }
    if (req.method === 'POST' && url.pathname === '/restore/undo') {
      const tsParam = path.basename(url.searchParams.get('ts') || '');
      if (!/^restore-[0-9]+$/.test(tsParam)) return send(400, 'invalid ts', 'text/plain');
      const dir = path.join(root, 'backups', tsParam, 'data');
      if (!fs.existsSync(dir)) return sendJson(404, { ok: false, error: '回退点不存在' });
      // 回退点里的 docs-meta 先校验：损坏 → 500 拒绝，且发生在任何删除/覆盖之前（否则会先清空本地再把 meta 当成 {} 全删）
      let undoMeta;
      try { undoMeta = readMetaSnapshotAt(path.join(dir, 'docs-meta.json')); }
      catch (e) { return sendJson(e.httpCode || 500, { ok: false, error: '回退失败：' + (e.message || e) }); }
      // 先把当前状态留一份（回退也可再次回退）
      const ts2 = Date.now();
      const safety2 = path.join(root, 'backups', 'restore-' + ts2);
      fs.mkdirSync(safety2, { recursive: true });
      for (const d of ['docs', 'snapshots', 'pdfs']) if (fs.existsSync(path.join(root, d))) fs.cpSync(path.join(root, d), path.join(safety2, d), { recursive: true });
      for (const f of ['docs-meta.json', 'applications.json', 'materials.json']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(safety2, f));
      try {
        for (const d of ['docs', 'snapshots', 'pdfs']) {
          const src = path.join(dir, d);
          if (!fs.existsSync(src)) continue;
          fs.rmSync(path.join(root, d), { recursive: true, force: true });
          fs.cpSync(src, path.join(root, d), { recursive: true });
        }
        for (const f of ['applications.json', 'materials.json']) if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(root, f));
        // docs-meta 成对回退：经 updateMeta 逐文档写（唯一写入者）
        if (undoMeta) applyMetaSnapshot(undoMeta);
      } catch (e) {
        return sendJson(500, { ok: false, error: '回退失败：' + (e.message || e) + '（本次操作前的状态在 ' + safety2 + '）' });
      }
      return sendJson(200, { ok: true });
    }
    // ===== PDF / 导出 =====
    // 历史版本 PDF：从快照内容渲染到独立文件，语义与「最新版」明确分开
    if (req.method === 'GET' && url.pathname === '/snapshot/pdf') {
      const ts = path.basename(url.searchParams.get('ts') || '');
      if (!VALID_ID.test(id) || !/^[0-9-]+$/.test(ts)) return send(400, 'invalid id/ts', 'text/plain');
      const snapFile = path.join(snapDir(id), ts + '.html');
      if (!fs.existsSync(snapFile)) return send(404, 'snapshot not found', 'text/plain');
      const out = path.join(root, 'pdfs', 'history', id + '@' + ts + '.pdf');
      if (!fs.existsSync(out)) {
        const ok = await renderDoc({ src: snapFile, out });
        if (!ok || !fs.existsSync(out)) return send(500, '历史版本渲染失败，请重试（详见服务日志）', 'text/plain');
      }
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${sanitizeFileName(id + '_' + ts)}.pdf"` });
      return fs.createReadStream(out).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/pdf') {
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      // 陈旧判定 = 渲染标识（staleInfo），mtime 仅日志；缺失/过期自动重渲一律走 renderCurrent 冻结组装。
      // 绝不直渲磁盘 HTML：迁移后当前文档不含内联 typo，直渲会丢排版。
      let rst = currentRenderState(id);
      if (rst.stale) {
        console.error(`[render] /pdf 自动重渲 id=${id} state=${rst.state} renderInputId=${rst.frozen.renderInputId} docMtime=${rst.docMtime}（mtime 仅日志）`);
        await renderCurrent(id);
        rst = currentRenderState(id);   // 复判：渲染期间文档可能又被保存（仍按标识，不用 mtime）
      }
      if (!rst.pdfExists) return send(500, '渲染失败：PDF 未生成，请到导出页重试（详见服务日志）', 'text/plain');
      const meta = rst.meta;
      const docHtml = fs.readFileSync(docPath(id), 'utf8');
      const name = decodeName((docHtml.match(/<h1>([^<]*)<\/h1>/) || [])[1] || id);
      const date = new Date().toISOString().slice(0, 10);
      const parts = meta.parent ? [name, meta.role || '', meta.company || '', date] : [name, id, date];
      const fileName = sanitizeFileName(parts.filter(Boolean).join('_')) + (rst.stale ? '_旧版本' : '') + '.pdf';
      // 文件名含中文：Node 头仅允许 Latin1 —— ASCII 兜底 + RFC 5987 filename*（既有直写非 ASCII 会 500，随本段修复）
      const asciiName = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'X-PDF-Stale': rst.stale ? '1' : '0'
      });
      return fs.createReadStream(pdfPath(id)).on('error', () => res.destroy()).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/export') {
      if (!VALID_ID.test(id)) return send(400, 'invalid id', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      const docStat = fs.statSync(docPath(id));   // mtime 仅展示/日志，陈旧判定走 staleInfo
      let rst = currentRenderState(id);
      let renderError = null;
      if (rst.stale) {
        console.error(`[render] /export 自动重渲 id=${id} state=${rst.state} renderInputId=${rst.frozen.renderInputId} docMtime=${rst.docMtime}（mtime 仅日志）`);
        const r = await renderCurrent(id);   // 组装渲染（当前 HTML+当前 meta），绝不直渲磁盘 HTML
        rst = currentRenderState(id);
        if (!r.ok || !rst.pdfExists) renderError = '渲染失败（详见服务日志）';
      }
      const meta = rst.meta;
      const job = meta.job || null;
      const pdfStat = rst.pdfExists ? fs.statSync(pdfPath(id)) : null;
      const pdfCurrent = rst.state === 'fresh' && !renderError;
      const lines = docToText(fs.readFileSync(docPath(id), 'utf8'), { includeHidden: false }).split('\n');
      const projects = countProjects(docPath(id));
      let pages = 0, rows = [], checksOk = false;
      if (pdfStat) {
        try { pages = parseInt(execFileSync('pdfinfo', [pdfPath(id)]).toString().match(/Pages:\s*(\d+)/)?.[1] || '0', 10); } catch { pages = 0; }
        const blank = [], orphan = [];
        for (let p = 1; p <= pages; p++) {
          let t = '';
          try { t = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), pdfPath(id), '-'], { timeout: 15000 }).toString('utf8'); } catch {}
          const clean = t.replace(/\s+/g, ' ').trim();
          if (clean.length < 10) blank.push(p);
          const lastLine = t.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
          if (lastLine && lastLine.length <= 10 && !/[，。、；：！？,.0-9]/.test(lastLine) && clean.length >= 10) orphan.push(p);
        }
        const totalChars = (() => { try { return execFileSync('pdftotext', [pdfPath(id), '-'], { timeout: 30000 }).toString('utf8').length; } catch { return 0; } })();
        rows.push(`${pages > 0 ? '✓' : '⚠️'} 实际页数：${pages || '读取失败'}${pages === 2 ? '（符合两页目标）' : pages > 2 ? '（超过两页，见下方建议）' : ''}`);
        rows.push(`${blank.length ? '⚠️' : '✓'} 空白页检查：${blank.length ? `疑似空白页：${blank.join('、')}` : '无'}`);
        rows.push(`${orphan.length ? '⚠️' : '✓'} 孤立标题检查：${orphan.length ? orphan.map((p) => `第${p}页末疑似孤立标题`).join('；') : '无'}`);
        rows.push(`${totalChars >= 200 ? '✓' : '⚠️'} 文本层字符量：${totalChars}`);
        checksOk = pages > 0 && !blank.length && totalChars >= 200;
      }
      const suggestions = pageSuggestions(lines, { projects }).map((s) => `<li>${escHtml(s.text)}</li>`).join('');
      // 事实冲突/重点审阅门控
      const pendingConflicts = (job ? job.changes.filter((c) => c.level === 'conflict' && ['pending'].includes(c.status)) : []);
      const pendingImportant = (job ? job.changes.filter((c) => c.level === 'important' && c.status === 'pending') : []);
      const gate = pendingConflicts.length
        ? `<div class="card" style="border-color:#f3c2c2;background:#fef2f2"><b>⛔ 存在 ${pendingConflicts.length} 条事实冲突未处理，暂不能下载</b>
           <p style="font-size:13px">请到编辑器右侧「审阅」面板逐条处理（接受或撤销）后再导出：</p>
           <ul style="font-size:13px">${pendingConflicts.map((c) => `<li>${escHtml((c.section || '') + '：' + (c.reason || c.before || c.id))}</li>`).join('')}</ul>
           <p><a href="/edit?id=${id}">去处理 →</a></p></div>`
        : '';
      const importantWarn = pendingImportant.length
        ? `<div class="badge warn">${pendingImportant.length} 条重点审阅建议待处理（不阻塞导出）</div>`
        : '';
      const versionLine = pdfCurrent
        ? `<span class="badge ok">PDF 与当前内容一致</span>`
        : pdfStat
          ? `<span class="badge err">当前显示的是旧版本 PDF（生成于 ${new Date(pdfStat.mtimeMs).toLocaleString('zh-CN')}），不是最新内容</span>`
          : `<span class="badge err">尚无 PDF</span>`;
      const trackSrc = meta.parent ? `<span class="badge ai">${escHtml((meta.company || '') + '·' + (meta.role || ''))}</span>` : '';
      return send(200, page('导出', `<h1>导出 PDF</h1>
    <div class="card">
      <p>正在导出：<b>${escHtml(id)}</b> ${trackSrc} ${versionLine}</p>
      <p style="font-size:13px;color:var(--mut)">最后编辑 ${docStat.mtime.toLocaleString('zh-CN')}${pdfStat ? ` ｜ PDF 生成于 ${new Date(pdfStat.mtimeMs).toLocaleString('zh-CN')}` : ''}</p>
      ${renderError ? `<p style="color:var(--err)">❌ 重新生成失败：${escHtml(renderError)}。下方数据基于${pdfStat ? '旧版本 PDF' : '无 PDF'}，请修复渲染环境后重试。</p>` : ''}
      ${!pdfCurrent && pdfStat && !renderError ? `<p style="color:var(--warn)">⚠️ 文档内容已更新（渲染标识不一致），当前 PDF 不是最新内容。</p>` : ''}
      ${gate}
      ${importantWarn}
      <p>
        ${pdfCurrent && !pendingConflicts.length ? `<a href="/pdf?id=${id}"><button>下载最新版 PDF</button></a>` : `<button disabled title="先解决上方问题">下载最新版 PDF</button>`}
        <button class="secondary" type="button" onclick="rerender()">重新生成</button>
        <a href="/snapshots?id=${id}" class="secondary" style="margin-left:8px">历史导出</a>
        <a href="/edit?id=${id}" class="secondary" style="margin-left:8px">返回编辑</a>
        <span id="rrMsg" style="font-size:12px"></span>
      </p>
      <details style="font-size:13px;margin-top:6px"><summary style="cursor:pointer">语义说明</summary>
        <div>· 最新版 PDF：与当前文档内容一致，文件名 姓名_岗位_公司_日期.pdf<br>· 历史导出：从历史快照重新渲染，在「历史版本」页操作<br>· 投递存档：点击「记录已投递」时从当时冻结内容生成，之后改稿不影响它</div></details>
    </div>
    ${rows.length ? `<div class="card" style="margin-top:12px"><b>渲染检查</b>${rows.map((r) => `<div style="margin:6px 0">${r}</div>`).join('')}</div>` : ''}
    ${suggestions ? `<div class="card" style="margin-top:12px"><b>超过两页的可读处理建议</b><ol style="font-size:13px">${suggestions}</ol><p style="font-size:12px;color:var(--mut)">不需要靠缩小字号硬塞：优先去重、精简、隐藏低相关项目；也可以保留更多页。</p></div>` : ''}
    <div class="card" style="margin-top:12px">
      <b>记录已投递</b>
      <p style="font-size:12px;color:var(--mut)">只做记录，不会自动发送任何文件。记录时绑定当前内容快照与存档 PDF。</p>
      <form id="trackForm">
        <input id="tkCompany" placeholder="公司" value="${escHtml(meta.company || '')}" required>
        <input id="tkRole" placeholder="岗位" value="${escHtml(meta.role || '')}" required>
        <input id="tkChannel" placeholder="渠道（可选）" size="12">
        <input id="tkDate" type="date" aria-label="投递日期">
        <button ${pdfCurrent && !pendingConflicts.length ? '' : 'disabled title="先解决上方问题"'}>记录已投递</button><span id="tkMsg" style="font-size:12px"></span>
      </form>
    </div>
    ${pdfStat ? `<iframe src="/pdf?id=${id}" title="PDF 预览" style="width:100%;height:70vh;margin-top:12px;border:1px solid var(--line);border-radius:12px"></iframe><p style="color:var(--mut);font-size:12px">预览不显示？<a href="/pdf?id=${id}" target="_blank">新窗口打开 PDF</a></p>` : ''}
    <script>
      ${meta.parent && pdfCurrent && !pendingConflicts.length ? `fetch('/job/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '${id}', status: 'deliverable' }) }).catch(function () {});` : ''}
      async function rerender() {
        var msg = document.getElementById('rrMsg');
        msg.textContent = ' 生成中…';
        try {
          var r = await fetch('/render?id=${id}', { method: 'POST' });
          var d = await r.json();
          msg.textContent = d.ok ? ' ✅ 已重新生成' : (' ❌ ' + (d.error || '失败'));
          if (d.ok) setTimeout(function () { location.reload(); }, 600);
        } catch (e) { msg.textContent = ' ❌ ' + e.message; }
      }
      document.getElementById('trackForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var msg = document.getElementById('tkMsg');
        msg.textContent = ' 记录中…';
        var r = await fetch('/app/add', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company: document.getElementById('tkCompany').value.trim(), role: document.getElementById('tkRole').value.trim(),
            docId: '${id}', channel: document.getElementById('tkChannel').value.trim(), appliedAt: document.getElementById('tkDate').value }) });
        var d = await r.json().catch(function () { return null; });
        if (d && d.ok) {
          msg.textContent = ' ✅ 已记录（未自动发送）';
          if (d.warning) alert(d.warning);
          await fetch('/job/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '${id}', status: 'delivered' }) }).catch(function () {});
        } else msg.textContent = ' ❌ ' + ((d && d.error) || '失败');
      });
    </script>`, 'docs'));
    }
    send(404, 'not found', 'text/plain');
  } catch (e) {
    if (e instanceof LockHeld) return send(409, '另一个写操作正在进行，请稍后重试', 'text/plain');
    send(e instanceof SyntaxError ? 400 : e.message === 'body too large' ? 413 : (e.httpCode || 500),
      e instanceof SyntaxError ? 'bad JSON body' : (e.code === 'CORRUPT' ? e.message : 'server error: ' + e.message), 'text/plain');
  }
}

// 内容版本守卫：客户端送来它认为的磁盘 mtime，不一致说明有未同步的编辑 → 409
function staleGuard(docId, baseMtime) {
  const base = Number(baseMtime || 0);
  if (!base || !fs.existsSync(docPath(docId))) return null;
  const cur = fs.statSync(docPath(docId)).mtimeMs;
  if (cur > base + 2) return { ok: false, stale: true, mtime: cur, error: '文档有未同步的修改，请先保存再让 AI 分析' };
  return null;
}
function countProjects(docFile) {
  try {
    const html = fs.readFileSync(docFile, 'utf8');
    const secs = sectionsOf(html);
    const p = secs.find((s) => s.title.includes('项目'));
    if (!p) return 0;
    return Math.max(0, (p.html.match(/class="entry-head"/g) || []).length);
  } catch { return 0; }
}
function sanitizeFileName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'resume';
}
function decodeName(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() || 'resume';
}

const PORTS = process.env.PORT && Number.isFinite(Number(process.env.PORT)) ? [Number(process.env.PORT)] : [7766, 7767, 7768];
function tryListen(i) {
  const s = http.createServer(handler);
  s.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && i < PORTS.length - 1) return tryListen(i + 1);
    console.error('端口不可用:', e.message);
    process.exit(1);
  });
  s.listen(PORTS[i], '127.0.0.1', () => console.log(`简历平台: http://localhost:${PORTS[i]}`));
}
// 启动恢复：扫描 .tx/ 未完成事务（进程被杀于两次 rename 之间等），只恢复目标文档的正文与 meta，不覆盖其他文档的并发更新。
// 必须先于 listen（避免恢复完成前对外提供写服务）。陈旧 .migrate.lock（持有者已死）顺手清除，避免重启后写请求被误 503。
try {
  if (fs.existsSync(rootLock.path(root)) && !rootLock.isHeld(root)) rootLock.release(root);
} catch {}
try {
  // 默认恢复（tx.mjs defaultRestoreDoc）：首选事务内旧正文副本（精确旧字节）；仅 oldHtml 载荷缺失时走快照兜底，
  // 兜底按热修 a7eb561 裁决 legacy-safe（oldMeta.typo 未定义 → 保留快照内联排版；已迁移 → 归一化正文）。
  const recovered = recoverPending(root);
  const done = recovered.filter((r) => r.ok);
  if (done.length) console.error(`[tx] 启动恢复未完成事务 ${done.length} 条：` + done.map((r) => `${r.docId}(${r.phase})`).join('、'));
  const failed = recovered.filter((r) => !r.ok);
  for (const r of failed) console.error(`[tx] 恢复失败（记录保留待重试）：${r.docId} — ${r.error}`);
} catch (e) {
  console.error('[tx] 启动恢复异常：', e && e.message || e);
}
tryListen(0);
