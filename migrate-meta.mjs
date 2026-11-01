// migrate-meta.mjs — schemaVersion 迁移事务（S1 Task 7；三门禁硬闸，真实迁移由 Task 10 执行）
// 用法:
//   node migrate-meta.mjs            # 数据根 = RESUME_ROOT（缺省脚本目录）；退出码 0=完成 1=门禁失败/停止 2=用法/数据损坏 3=检查器缺失
// 编程 API（测试注入模拟检查器用）:
//   runMigration(root, { checkers }) → report；checkers = { renderPdf, pdftotext, pdfinfoPages, comparePdfs }（任一注入即跳过真实检查器预检，仅供单元测试）
// 语义（spec §6/§12，binding）:
//   逐文档 withDocLock；rootLock(.migrate.lock) 持锁贯穿整轮（server 见锁写请求 503）。
//   先快照（冻结 pre-image + manifest，落 backups/pre-s1-<ts>/migration-snapshots/ —— 不进 snapshots/ 配额目录：
//     历史快照不可变且首迁"快照数不增"（brief S1-E③）；中断窗口另有 .tx 载荷 + backups 全量副本双保险）
//   → beginTx → 归一化+登记（meta.typo 未定义时提取内联 typo；主 <style> 无来源属性时补 data-style-origin="legacy-inline"；
//     登记 theme='legacy'、styleHash=sha1(实际内联 css)、renderInputId 初值。T5+ 新建文档 theme 已登记 → 不重登记样式）
//   → 三门禁（隔离 tmp 内 before/after 真实渲染：pdftotext 文本层 0 差异、pdfinfo 页数相等、comparePdfs RGB24@150 ≤0.5%；
//     消费规则：任何非零/抛错=STOP；先判 error/pass 再判 max —— 页数不等返回 max:null）
//   → 全过才 updateMeta schemaVersion=2 + migration={state:'done',at,checks} + commitTx。schemaVersion 是唯一完成判据。
//   载荷落盘硬校验（T7 修复轮1 I-2）：beginTx 之后立即断言 .tx/<txId>.html 与 .meta.json 都在盘上（beginTx 的 .html 写入
//     包在 try{}catch{}，而迁移传 oldSnapTs:'' 没有快照兜底 → 载荷缺失就是"无恢复源"）；缺失即 TX_PAYLOAD_MISSING 硬停整轮
//     （CLI 非零退出），此刻尚未改动任何文档。
//   锁所有权复核（T7 修复轮1 I-3）：写 schemaVersion=2 前与 commitTx 前各复核 .migrate.lock 仍是本进程本次持有
//     （pid + startedAt）；不一致 → LOCK_LOST，不盖章、不清 tx 记录（留给启动恢复）、STOP 整轮，且 finally 不删他人锁。
//     server 侧同时把 GET /pdf、/export（会 renderCurrent→updateMeta 并覆写 PDF）纳入 503 门。
//   首次 vs 中断：无 tx 且 schemaVersion<2 → 首迁（不回滚历史快照）；有 tx 记录 → recoverPending 先恢复再重做。
//   任一门禁失败或 CheckerMissingError → 该文档 html+meta 完整恢复（双恢复成功才 commitTx，tx.mjs 语义），STOP 整轮，
//   其他文档 untouched（无部分 done 态）。
//   迁移前全量副本 backups/pre-s1-<ts>/（docs/snapshots/pdfs/三 JSON）；迁移只读快照做 typo 预检、绝不改写（快照不可变）。
//   兼容读即时推导不写回：未迁移文档的排版由 freezeHtml/GET /edit 按热修裁决（legacy 内联优先）即时推导，本脚本
//   不在事务之外写任何推导值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freezeHtml, normalizeToCurrent, splitDoc } from './freeze.mjs';
import { beginTx, commitTx, recoverPending, withDocLock, updateMeta, rootLock, atomicWrite, LockHeld, startLockHeartbeat } from './tx.mjs';
import { comparePdfs, assertCheckers, DEFAULT_DPI, DEFAULT_THRESHOLD } from './tools/pixel-diff.mjs';
import { migrateMats } from './zone.mjs';
import { resolveChromium } from './chromium.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = 2;

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function checkerMissing(tool, fix) {
  const e = new Error(`检查器缺失: ${tool} 不可用（门禁不降级，停止整轮）。修复: ${fix}`);
  e.code = 'CHECKER_MISSING';
  e.tool = tool;
  return e;
}
function gateFail(msg) {
  const e = new Error('门禁失败: ' + msg);
  e.code = 'GATE_FAILED';
  return e;
}

// ===== 迁移锁所有权复核（I-3：互斥代码化，不只靠流程约定）=====
// rootLock.acquire 返回 info = { pid, host, startedAt }。整轮若超 staleMs(30min)，server 会把锁判陈旧破除并放行写请求
// （含 GET /pdf、/export 这类"读名义下的写"），于是 server 与迁移同时写 meta/pdf。故在「写 schemaVersion=2 前」与
// 「commitTx 前」各复核一次锁文件仍是本进程本次持有；不一致 → 不盖章、不清 tx 记录（留给启动恢复把文档拉回旧状态）、
// STOP 整轮；finally 也只在自己仍持有时才删锁（否则等于替他人解锁，放第三方进临界区）。
function lockOwnedBy(root, info) {
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(rootLock.path(root), 'utf8')); } catch { return false; }
  return !!(info && cur && cur.pid === info.pid && cur.startedAt === info.startedAt);
}
function assertLockOwnership(root, info, where) {
  if (lockOwnedBy(root, info)) return;
  let holder = '锁文件不可读或已消失';
  try { const c = JSON.parse(fs.readFileSync(rootLock.path(root), 'utf8')); holder = `pid=${c.pid} startedAt=${c.startedAt}`; } catch {}
  const e = new Error(`迁移互斥已失效（${where}）：.migrate.lock 现持有者 ${holder}，本进程为 pid=${info && info.pid} startedAt=${info && info.startedAt}。`
    + '不写 schemaVersion=2、不清 tx 记录（保留交启动恢复），停止整轮；请确认常驻服务已停（launchctl bootout）后重跑。');
  e.code = 'LOCK_LOST';
  throw e;
}

// docs-meta.json 读：容忍缺失（{}），损坏显式抛 CORRUPT（停写不覆盖，与 tx.mjs updateMeta 同款纪律）
function readMetaAll(root) {
  const f = path.join(root, 'docs-meta.json');
  if (!fs.existsSync(f)) return {};
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {
    const e = new Error('数据文件损坏，迁移已停止：docs-meta.json（请先人工修复或从备份恢复）');
    e.code = 'CORRUPT'; throw e;
  }
  return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
}

function listDocIds(root) {
  try {
    return fs.readdirSync(path.join(root, 'docs'))
      .filter((f) => f.endsWith('.html') && !f.startsWith('.'))
      .map((f) => f.replace(/\.html$/, ''))
      .sort();
  } catch { return []; }
}

// .tx/ 里存在未完成记录的文档（半完成识别 = tx 记录 + schemaVersion 联合判断）
function listTxDocIds(root) {
  const dir = path.join(root, '.tx');
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const ids = new Set();
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.meta.json')) continue;
    try { const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (rec && rec.docId) ids.add(rec.docId); } catch {}
  }
  return [...ids];
}

// schemaVersion 是唯一完成判据：非 ≥2 的一切（缺失/1/非法值）都算待迁移
const schemaOf = (m) => { const v = Number(m && m.schemaVersion); return Number.isFinite(v) && v >= 2 ? v : 1; };

// ===== 快照 typo 预检（只读；快照不可变，绝不改写）=====
// 列出：含内联 typo-custom 的快照；文档 meta.typo 未定义（legacy）而快照不含内联 typo 的。报告计数供人工核对。
function auditSnapshots(root, metaAll) {
  const audit = { total: 0, withInlineTypo: [], legacyWithoutTypo: [] };
  const snapRoot = path.join(root, 'snapshots');
  let dirs = [];
  try { dirs = fs.readdirSync(snapRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch {}
  for (const docId of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(snapRoot, docId)).filter((f) => f.endsWith('.html')).sort(); } catch { continue; }
    const legacy = typeof (metaAll[docId] || {}).typo !== 'string';
    for (const f of files) {
      audit.total++;
      const ref = docId + '/' + f.replace(/\.html$/, '');
      let has = false;
      try { has = splitDoc(fs.readFileSync(path.join(snapRoot, docId, f), 'utf8')).typo !== null; } catch {}
      if (has) audit.withInlineTypo.push(ref);
      else if (legacy) audit.legacyWithoutTypo.push(ref);
    }
  }
  return audit;
}

// ===== 迁移前全量副本 backups/pre-s1-<ts>/ =====
function makeBackup(root, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  for (const d of ['docs', 'snapshots', 'pdfs']) {
    const src = path.join(root, d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(backupDir, d), { recursive: true });
  }
  for (const f of ['docs-meta.json', 'applications.json', 'materials.json']) {
    const src = path.join(root, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, f));
  }
  atomicWrite(path.join(backupDir, 'manifest.json'), JSON.stringify({ kind: 'pre-s1-migration', schemaTarget: SCHEMA_VERSION, at: new Date().toISOString() }));
}

// 迁移快照 manifest：与 Task 3 冻结点字段集一致（快照不强制 resolveChromium → 环境字段允许 null）
function buildManifest(frozen, html, meta) {
  const norm = normalizeToCurrent(html);
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

// 主 <style> 无来源属性（data-theme / data-style-origin）时补 data-style-origin="legacy-inline"（只动首个主样式；CSS 文本不变 → styleHash/cssHash 不变）
const STYLE_OPEN_RE = /<style\b([^>]*)>/gi;
function addLegacyOrigin(html) {
  let done = false;
  return String(html).replace(STYLE_OPEN_RE, (tag, attrs) => {
    if (done) return tag;
    if (/\bid\s*=\s*["']typo-custom["']/i.test(attrs)) return tag;                       // 非主样式（归一化后通常已不存在）
    if (/\bdata-theme\s*=/i.test(attrs) || /\bdata-style-origin\s*=/i.test(attrs)) return tag;   // 已有来源登记
    done = true;
    return '<style data-style-origin="legacy-inline"' + attrs + '>';
  });
}

// ===== 真实检查器（门禁不降级；缺失 = CHECKER_MISSING = STOP）=====
function renderPdfReal(root, src, out) {
  const once = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'render.mjs'), '--src', src, '--out', out], {
      env: { ...process.env, RESUME_ROOT: root },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 180000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(out)) return resolve(true);
      // render.mjs exit 3 = Chromium 不可用（环境检查器缺失语义）；其余非零/无产物 = 渲染失败。任何非零都 STOP，不特判。
      reject(code === 3
        ? checkerMissing('Chromium（render.mjs exit 3）', 'node doctor.mjs 查看探测详情；或 RESUME_CHROMIUM 显式指定')
        : new Error('渲染失败（exit ' + code + '）: ' + String(err).slice(0, 300)));
    });
  });
  return once().catch((e) => { if (e && e.code === 'CHECKER_MISSING') throw e; return once(); });   // 非检查器失败重试 1 次（与 server renderDoc 同语义）
}
const realCheckers = (root) => ({
  renderPdf: (src, out) => renderPdfReal(root, src, out),
  pdftotext: (pdf) => {
    try { return execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) {
      if (e && (e.code === 'ENOENT' || e.errno === 'ENOENT')) throw checkerMissing('pdftotext', 'brew install poppler');
      throw new Error('pdftotext 失败: ' + String((e && e.message) || e).slice(0, 300));
    }
  },
  pdfinfoPages: (pdf) => {
    let out;
    try { out = execFileSync('pdfinfo', [pdf], { encoding: 'utf8', timeout: 30000 }); }
    catch (e) {
      if (e && (e.code === 'ENOENT' || e.errno === 'ENOENT')) throw checkerMissing('pdfinfo', 'brew install poppler');
      throw new Error('pdfinfo 失败: ' + String((e && e.message) || e).slice(0, 300));
    }
    const m = /Pages:\s*(\d+)/.exec(out);
    if (!m) throw new Error('pdfinfo 无 Pages 字段: ' + out.slice(0, 200));
    return Number(m[1]);
  },
  comparePdfs: (a, b, o) => comparePdfs(a, b, o)
});

// 真实门禁预检（触碰任何东西之前）：pdftoppm/ffmpeg（pixel-diff）+ pdftotext/pdfinfo + Chromium 可解析
async function preflightReal() {
  assertCheckers();   // CheckerMissingError（code=CHECKER_MISSING）直接上抛
  for (const tool of ['pdftotext', 'pdfinfo']) {
    const r = spawnSync(tool, ['-v'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error && (r.error.code === 'ENOENT' || r.error.errno === 'ENOENT')) throw checkerMissing(tool, 'brew install poppler');
  }
  try { await resolveChromium(); }   // 缓存/.chromium-choice.json 落在迁移根（runMigration 已 pin RESUME_ROOT）
  catch (e) { throw checkerMissing('Chromium', String((e && e.message) || e).slice(0, 300)); }
}

// ===== 三门禁（before/after 渲染输入在隔离 tmp 内渲染比较）=====
async function runGates(chk, beforeHtml, afterHtml) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-gates-'));
  try {
    const srcA = path.join(tmp, 'before.html'), srcB = path.join(tmp, 'after.html');
    const pdfA = path.join(tmp, 'before.pdf'), pdfB = path.join(tmp, 'after.pdf');
    fs.writeFileSync(srcA, beforeHtml);
    fs.writeFileSync(srcB, afterHtml);
    await chk.renderPdf(srcA, pdfA);
    await chk.renderPdf(srcB, pdfB);
    for (const p of [pdfA, pdfB]) if (!fs.existsSync(p)) throw gateFail('渲染未产出 PDF: ' + path.basename(p));
    // 门禁一：pdftotext 文本层 0 差异
    const tA = chk.pdftotext(pdfA), tB = chk.pdftotext(pdfB);
    if (tA !== tB) throw gateFail(`文本层差异非零（before ${tA.length} 字符 vs after ${tB.length} 字符）`);
    // 门禁二：页数相等
    const pA = chk.pdfinfoPages(pdfA), pB = chk.pdfinfoPages(pdfB);
    if (pA !== pB) throw gateFail(`页数不等: before=${pA} after=${pB}`);
    // 门禁三：RGB24 视觉 ≤0.5%（消费规则：任何抛错=STOP；先判 error/pass 再判 max —— 页数不等形态 max:null，null<=阈值 为 true 会误放行）
    let v;
    try { v = chk.comparePdfs(pdfA, pdfB, { dpi: DEFAULT_DPI, threshold: DEFAULT_THRESHOLD }); }
    catch (e) {
      if (e && e.code === 'CHECKER_MISSING') throw e;
      throw gateFail('视觉门禁错误: ' + String((e && e.message) || e).slice(0, 300));
    }
    if (v && v.error) throw gateFail('视觉门禁: ' + v.error);
    if (!v || v.pass !== true) throw gateFail(`视觉门禁未通过: max ratio ${v ? v.max : 'n/a'} > 阈值 ${v ? v.threshold : DEFAULT_THRESHOLD}`);
    return {
      text: { identical: true, chars: tA.length },
      pages: { before: pA, after: pB },
      visual: { pass: true, max: v.max, threshold: v.threshold, dpi: v.dpi, pixFmt: v.pixFmt || 'rgb24' }
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ===== 单文档迁移事务 =====
async function migrateDoc(root, docId, chk, backupDir, lockInfo) {
  return await withDocLock(root, docId, async () => {
    const docFile = path.join(root, 'docs', docId + '.html');
    const oldHtml = fs.readFileSync(docFile, 'utf8');
    const all = readMetaAll(root);
    const hasEntry = Object.prototype.hasOwnProperty.call(all, docId);
    const oldMeta = hasEntry ? all[docId] : null;   // null = 事务前无条目（恢复时删除，tx.mjs 语义）
    const m = oldMeta || {};

    // ① 先快照：冻结 pre-image + manifest（落 backups/pre-s1-<ts>/migration-snapshots/，不进 snapshots/ 配额目录）
    const snapBase = docId + '-' + timestamp();
    const snapDir = path.join(backupDir, 'migration-snapshots');
    fs.mkdirSync(snapDir, { recursive: true });
    const frozenPre = freezeHtml(oldHtml, m);
    atomicWrite(path.join(snapDir, snapBase + '.html'), frozenPre.html);
    atomicWrite(path.join(snapDir, snapBase + '.manifest.json'), JSON.stringify(buildManifest(frozenPre, oldHtml, m)));

    // ② beginTx（旧正文精确字节 + 旧 meta 整份副本落 .tx/；中断/失败的恢复依据）
    // 载荷写失败时 beginTx 抛 code=TX_PAYLOAD_MISSING（tx.mjs 自 2026-10-18 审查 B1 起不再静默吞掉），
    // 原始 errno 在 err.txErrno。迁移层在此把技术错误翻译成本层的停轮语义（信息面向操作者）。
    let txId;
    try {
      txId = beginTx(root, docId, 'migrate', '');
    } catch (err) {
      if (err && err.code === 'TX_PAYLOAD_MISSING') {
        const e = new Error('事务载荷未落盘（beginTx 写入失败：' + (err.txErrno || err.message)
          + '）。本事务没有恢复源，已在改动任何文档之前停止整轮；请检查 '
          + path.join(root, '.tx') + ' 的磁盘空间/权限后重跑。');
        e.code = 'TX_PAYLOAD_MISSING';
        e.restored = true;   // 零改动：文档天然仍是旧状态（tx 记录保留，交启动恢复按孤儿/旧 meta 语义清理）
        throw e;
      }
      throw err;
    }
    // 载荷落盘硬校验（I-2，双保险）：beginTx 成功返回即两路载荷都已落盘（tx.mjs 硬失败而非静默跳过），
    // 下面的存在性检查理论上不可达；保留以防 beginTx 语义再变。
    // 而迁移传 oldSnapTs:''（迁移快照不进 snapshots/，默认恢复寻不到）→ 载荷缺失就等于本事务没有恢复源：
    // 此刻尚未改动任何文档 → 硬失败停整轮（CLI 非零退出），绝不降级续跑。
    const missingPayload = ['.html', '.meta.json'].filter((ext) => !fs.existsSync(path.join(root, '.tx', txId + ext)));
    if (missingPayload.length) {
      const e = new Error('事务载荷未落盘: ' + missingPayload.map((ext) => '.tx/' + txId + ext).join('、')
        + ' 缺失。本事务没有恢复源，已在改动任何文档之前停止整轮；请检查 '
        + path.join(root, '.tx') + ' 的磁盘空间/权限后重跑。');
      e.code = 'TX_PAYLOAD_MISSING';
      e.restored = true;   // 零改动：文档天然仍是旧状态（tx 记录保留，交启动恢复按孤儿/旧 meta 语义清理）
      throw e;
    }
    try {
      // ③ 归一化 + 登记
      const norm = normalizeToCurrent(oldHtml);
      // 有效 typo = 热修 a7eb561 裁决：(meta.typo 定义且非空) ? meta.typo : (内联 if present else '')。
      // html 已无内联且 meta.typo 已定义 → no-op（不覆盖既有值，Ruling#3）。
      const effTypo = (typeof m.typo === 'string' && m.typo !== '') ? m.typo : (norm.typo ?? '');
      let newHtml = norm.html;
      const reg = { typo: effTypo };
      if (!m.theme) {
        // legacy（含 theme 未登记的手工态）：补来源属性 + 登记 theme/styleHash；T5+ 新建（theme 已登记）不重登记（Ruling#4）
        newHtml = addLegacyOrigin(newHtml);
        const norm2 = normalizeToCurrent(newHtml);   // 属性不影响 CSS 文本 → styleHash 与 norm 相同
        reg.theme = norm2.theme || 'legacy';
        reg.styleHash = norm2.styleHash;
      }
      const frozenAfter = freezeHtml(newHtml, { ...m, ...reg });
      reg.renderInputId = frozenAfter.renderInputId;   // 迁移时点的初始身份（仅溯源）：当前身份一律由 freezeHtml 实时重算，渲染任务身份只存 meta.lastRenderInputId
      // ===== T8 状态维度映射（spec §7）：job.status → kind/flow（存储单源），随后删除 job.status =====
      // 'draft'→'draft'（job.changes 有 pending → 'reviewing'）；'deliverable'/'delivered'→'reviewed'（投递历史改由 applications.json 派生）；
      // 无 job 的母版 → kind 'master' + flow 'draft'。迁移前新代码已显式写过的 flow 不被旧映射覆盖；archivedAt 初始化为 null（独立标记）。
      const FLOWS = ['draft', 'reviewing', 'reviewed'];
      const jb = m.job;
      reg.kind = jb ? 'job' : 'master';
      if (FLOWS.includes(m.flow)) reg.flow = m.flow;
      else if (!jb) reg.flow = 'draft';
      else if (jb.status === 'deliverable' || jb.status === 'delivered') reg.flow = 'reviewed';
      else if (jb.status === 'draft' && Array.isArray(jb.changes) && jb.changes.some((c) => c && c.status === 'pending')) reg.flow = 'reviewing';
      else reg.flow = 'draft';
      if (m.archivedAt === undefined) reg.archivedAt = null;
      // 写正文前复核锁所有权（与 :351/:353 同款）：渲染耗时可能已越过 stale 窗口，
      // 此时若已被 server 破锁接管，继续写会与之互踩 —— 该复核必须早于第一次落盘
      assertLockOwnership(root, lockInfo, '写文档前');
      if (newHtml !== oldHtml) atomicWrite(docFile, newHtml);
      updateMeta(root, docId, (cur) => {
        const next = { ...(cur || {}), ...reg };
        // 删除旧状态单源（迁移完成后 flow 是唯一状态维度，避免新旧两套被不同页面读写）；job 其余字段保留
        if (next.job && typeof next.job === 'object') { next.job = { ...next.job }; delete next.job.status; }
        return next;
      });

      // ④ 三门禁（before = 迁移前有效渲染输入；after = 迁移后渲染输入；两者 renderInputId 设计上相同，门禁实证）
      const checks = await runGates(chk, frozenPre.html, frozenAfter.html);

      // ⑤ 全过才 done（schemaVersion 唯一完成判据）→ commitTx。两处写前都复核锁所有权（I-3）：
      //    所有权已失 → 不盖章、不清记录，交启动恢复；否则会与接管锁的进程同时写 meta。
      assertLockOwnership(root, lockInfo, '写 schemaVersion=2 前');
      updateMeta(root, docId, (cur) => ({ ...(cur || {}), schemaVersion: SCHEMA_VERSION, migration: { state: 'done', at: new Date().toISOString(), checks } }));
      assertLockOwnership(root, lockInfo, 'commitTx 前');
      commitTx(root, txId);
      return { docId, action: 'migrated', renderInputId: frozenAfter.renderInputId, checks };
    } catch (e) {
      // 锁所有权丧失（I-3）：另一进程可能正在写同一批文件，就地恢复会与之互踩 → 不恢复、不 commitTx，
      // 保留 tx 记录（旧正文精确字节 + 旧 meta 整份副本）交启动恢复，STOP 整轮。
      if (e && e.code === 'LOCK_LOST') { e.docId = docId; e.restored = false; throw e; }
      // 任一失败：该文档 html+meta 完整恢复；双恢复都成功才 commitTx，否则保留记录交启动恢复（tx.mjs 语义）
      let htmlBack = false, metaBack = false;
      try { atomicWrite(docFile, oldHtml); htmlBack = true; } catch {}
      try { updateMeta(root, docId, () => oldMeta); metaBack = true; } catch {}
      if (htmlBack && metaBack) { try { commitTx(root, txId); } catch {} }
      const err = e instanceof Error ? e : new Error(String(e));
      err.docId = docId;
      err.restored = htmlBack && metaBack;
      if (!err.code) err.code = 'GATE_FAILED';
      throw err;
    }
  });
}

// ===== 素材事实层迁移（S3-T7，幂等）=====
// 无待迁文档时也可能有旧形状素材 → 独立探测；有变化先快照再原子写（沿用全量副本模式）。
// 幂等判据：migrateMats 后 JSON.stringify 逐条比对（旧形状 confirmed/缺 facts 必变；已迁移原样返回必不变）。
export function migrateMaterials(root, report) {
  const f = path.join(root, 'materials.json');
  if (!fs.existsSync(f)) return;
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return; }
  let mats;
  try { mats = JSON.parse(raw); } catch {
    const e = new Error('数据文件损坏，素材迁移已跳过（不覆盖）：materials.json（请先人工修复后重跑）');
    e.code = 'CORRUPT'; throw e;
  }
  // 根值形状闸门（BL-P6-03，B 线批 2）：服务端读侧对非数组降级为 []，但迁移是「写」——
  // 根值是对象/字符串/null 时若照跑 migrateMats，会把它当空数组把整个文件改写成 []（素材全丢还报成功）。
  if (!Array.isArray(mats)) {
    const e = new Error('数据文件根值形状异常（应为数组），素材迁移已跳过（不覆盖）：materials.json（请先人工修复后重跑）');
    e.code = 'CORRUPT'; throw e;
  }
  const migrated = migrateMats(mats);
  if (JSON.stringify(migrated) === JSON.stringify(mats)) return;   // 无变化：不写盘
  const snapRel = path.join('backups', 'pre-s3-mats-' + timestamp());
  fs.mkdirSync(path.join(root, snapRel), { recursive: true });
  atomicWrite(path.join(root, snapRel, 'materials.json'), raw);
  atomicWrite(f, JSON.stringify(migrated));
  report.materials = { migrated: true, snapshot: snapRel };
}

// ===== 整轮迁移 =====
export async function runMigration(root, opts = {}) {
  root = path.resolve(root);
  const docsDir = path.join(root, 'docs');
  if (!fs.existsSync(docsDir)) { const e = new Error('docs/ 不存在，不是合法数据根: ' + root); e.code = 'USAGE'; throw e; }
  const report = { ok: false, root, at: new Date().toISOString(), backup: null, snapshotAudit: null, recovered: [], docs: [], stopped: null };
  // pin RESUME_ROOT：freeze 的相对资源解析、chromium 缓存/探针全部按迁移根隔离（结束后恢复，绝不写别根）
  const prevRR = process.env.RESUME_ROOT;
  process.env.RESUME_ROOT = root;
  try {
    const metaAll = readMetaAll(root);   // 损坏 → CORRUPT（触碰任何东西之前停）
    const ids = listDocIds(root);
    const txIds = listTxDocIds(root);
    // 半完成识别 = tx 记录 + schemaVersion 联合：schemaVersion<2 或 有 tx 记录（含"done 写入后、commitTx 前被杀"）
    const pending = ids.filter((id) => schemaOf(metaAll[id]) < 2 || txIds.includes(id));
    report.snapshotAudit = auditSnapshots(root, metaAll);   // 快照 typo 预检（只读）
    if (!pending.length) {
      migrateMaterials(root, report);   // 素材事实层（S3-T7，幂等；无文档可迁时独立跑：不需要渲染检查器）
      report.ok = true; return report;   // 无可迁：不备份、不持锁、不动文档
    }

    if (!opts.checkers) await preflightReal();   // 真实检查器预检（注入模拟检查器的单元测试路径跳过）

    const ts = timestamp();
    const backupRel = path.join('backups', 'pre-s1-' + ts);
    const backupDir = path.join(root, backupRel);
    makeBackup(root, backupDir);   // 触碰任何东西之前：全量副本
    report.backup = backupRel;

    // 整轮持锁（timeoutMs 0：被占即抛 LockHeld；server 见锁写请求 503）。
    // ⚠️ staleMs 24h 只作用于本进程自己的陈旧判定，改变不了 server（isHeld/acquire 默认 30min）
    // 的口径——整轮超 30min 后 server 仍会判陈旧破锁放行写请求（复核 13130 已实证）。
    // 正解 = 持锁期间心跳（startLockHeartbeat 周期 touch 刷新 startedAt，默认 10min ≪ 30min）；
    // 崩溃残留仍由 lockIsStale 的 !pidAlive 分支接管，不影响重启恢复。
    // 已知窄边界（登记不修）：assertLockOwnership 与 atomicWrite 之间若 server 已抢锁写入，
    // 该窗口内的用户保存会被迁移覆盖且无 tx 记录可恢复。
    const lockInfo = rootLock.acquire(root, { staleMs: 24 * 3600 * 1000, timeoutMs: 0 });
    const stopHeartbeat = startLockHeartbeat(root, Number(process.env.RESUME_TEST_MIGRATE_HB_MS || 10 * 60 * 1000));
    try {
      // 中断恢复：有 tx 记录 → 先恢复（legacy-safe 默认恢复）再重做；恢复失败 → 保留记录待人工，STOP 整轮
      const recovered = recoverPending(root);
      report.recovered = recovered.map((r) => ({ docId: r.docId, phase: r.phase || null, ok: !!r.ok, error: r.error || null }));
      const badRec = recovered.find((r) => !r.ok);
      if (badRec) {
        report.stopped = { docId: badRec.docId, code: 'TX_RECOVERY_FAILED', message: '半完成事务恢复失败（记录保留待人工）: ' + (badRec.error || ''), restored: false };
        return report;
      }
      const chk = { ...realCheckers(root), ...(opts.checkers || {}) };
      migrateMaterials(root, report);   // 素材事实层（S3-T7，幂等；锁内执行，与文档迁移互斥写）
      if (report.materials && report.materials.migrated === true) console.error('[migrate] 素材事实层迁移完成（快照 ' + report.materials.snapshot + '）');
      for (const id of pending) {
        // 恢复可能回滚了 meta → 逐文档重读；schemaVersion 是唯一完成判据
        const cur = readMetaAll(root)[id] || null;
        if (schemaOf(cur) >= 2 && !listTxDocIds(root).includes(id)) { report.docs.push({ docId: id, action: 'already-done' }); continue; }
        try {
          report.docs.push(await migrateDoc(root, id, chk, backupDir, lockInfo));
        } catch (e) {
          report.docs.push({ docId: id, action: 'failed', code: e.code || 'GATE_FAILED', restored: !!e.restored, reason: String(e.message || e) });
          report.stopped = { docId: id, code: e.code || 'GATE_FAILED', message: String(e.message || e), restored: !!e.restored };
          break;   // STOP 整轮：无部分 done 态，后续文档 untouched
        }
      }
      report.ok = !report.stopped;
      return report;
    } finally {
      stopHeartbeat();
      // 只在自己仍持有时删锁（I-3c）：所有权已失 → 该锁文件是别人的，unlink 等于替他人解锁、放第三方进临界区
      if (lockOwnedBy(root, lockInfo)) rootLock.release(root);
      else console.error('[migrate] ⚠️ .migrate.lock 所有权已丧失（现持有者非本进程本次），不删除他人锁文件');
    }
  } finally {
    if (prevRR === undefined) delete process.env.RESUME_ROOT; else process.env.RESUME_ROOT = prevRR;
  }
}

// —— CLI ——
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(process.env.RESUME_ROOT || APP_ROOT);
  const list = (a, n = 20) => a.slice(0, n).join('、') + (a.length > n ? ` …（共 ${a.length}）` : '');
  try {
    console.error(`[migrate] 数据根: ${root}`);
    const rep = await runMigration(root);
    const au = rep.snapshotAudit || { total: 0, withInlineTypo: [], legacyWithoutTypo: [] };
    console.error(`[migrate] 快照 typo 预检（只读，不改写）: 共 ${au.total} 份；含内联 typo-custom ${au.withInlineTypo.length} 份${au.withInlineTypo.length ? '：' + list(au.withInlineTypo) : ''}；legacy 文档（meta.typo 未定义）快照无内联 ${au.legacyWithoutTypo.length} 份${au.legacyWithoutTypo.length ? '：' + list(au.legacyWithoutTypo) : ''}`);
    if (rep.backup) console.error(`[migrate] 全量副本: ${rep.backup}/`);
    for (const r of rep.recovered) console.error(`[migrate] 恢复中断事务: ${r.docId}(${r.phase}) ${r.ok ? 'OK' : '失败: ' + r.error}`);
    for (const d of rep.docs) {
      if (d.action === 'migrated') console.error(`[migrate] ${d.docId}: 迁移完成（文本 0 差异 ${d.checks.text.chars} 字符/页数 ${d.checks.pages.before}=${d.checks.pages.after}/视觉 max=${d.checks.visual.max} ≤${d.checks.visual.threshold} ${d.checks.visual.pixFmt}@${d.checks.visual.dpi}）renderInputId=${d.renderInputId}`);
      else if (d.action === 'already-done') console.error(`[migrate] ${d.docId}: 已完成（schemaVersion≥2），跳过`);
      else console.error(`[migrate] ${d.docId}: ${d.code} → ${d.restored ? '已完整恢复旧状态并' : '恢复未完成（tx 记录保留）并'}停止整轮: ${d.reason}`);
    }
    if (!rep.docs.length && !rep.stopped) console.error('[migrate] 无待迁移文档（全部 schemaVersion≥2）');
    console.log(JSON.stringify(rep, null, 2));
    process.exit(rep.stopped ? (rep.stopped.code === 'CHECKER_MISSING' ? 3 : 1) : 0);
  } catch (e) {
    if (e && e.code === 'CHECKER_MISSING') { console.error(e.message); process.exit(3); }
    if (e instanceof LockHeld) { console.error('另一迁移/保存正在持有 .migrate.lock，本次迁移未开始（稍后重试，或停常驻服务后执行）'); process.exit(1); }
    if (e && e.code === 'CORRUPT') { console.error(e.message); process.exit(2); }
    if (e && e.code === 'USAGE') { console.error(e.message); process.exit(2); }
    console.error('迁移失败: ' + String((e && e.message) || e));
    process.exit(1);
  }
}
