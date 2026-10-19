// chromium.mjs — Chromium headless shell 探测/探针/选择缓存。
// 生产渲染（render.mjs）与浏览器级测试（test-editor.mjs）共用，保证同一二进制。
// 纪律：RESUME_CHROMIUM 无效必须报错；缓存可失效；探测互斥（等待方不再发探针）。
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
// 路径按调用时 RESUME_ROOT 解析：隔离测试（test.sh/test-structure.sh）不会污染真实数据根。
const cachePath = () => path.join(process.env.RESUME_ROOT || APP_ROOT, '.chromium-choice.json');
const lockPath = () => cachePath() + '.probe-lock';
const LOCK_STALE_MS = 120000;

export function playwrightVersion() {
  return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'node_modules', 'playwright-core', 'package.json'), 'utf8')).version;
}

export function expectedRevision() {
  const b = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  return String(b.browsers.find(x => x.name === 'chromium-headless-shell').revision);
}

function binIn(dir) {
  try {
    // execFileSync 而非 execSync + 字符串插值（2026-10-19 安全审查 ⚪-2）：
    // 原写法把路径插进 shell 命令串，路径含引号/$( ) 就会被 shell 解释。
    // dir 来自 readdirSync（可控性低）但这是全项目仅剩的两处 shell 插值，消掉整类风险。
    // 不用 `-quit`（GNU 扩展，BSD 兼容性不稳），改为取输出首行。
    const out = execFileSync('find', [dir, '-name', 'chrome-headless-shell', '-type', 'f'], { maxBuffer: 4 * 1024 * 1024 }).toString();
    return out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch { return null; }
}

export function candidates() {
  const out = [];
  if (process.env.RESUME_CHROMIUM) out.push({ bin: process.env.RESUME_CHROMIUM, source: 'RESUME_CHROMIUM' });
  const base = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const want = 'chromium_headless_shell-' + expectedRevision();
  const dirs = fs.existsSync(base)
    ? fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-'))
        .sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10))
    : [];
  for (const d of [...dirs.filter(x => x === want), ...dirs.filter(x => x !== want)]) {
    const bin = binIn(path.join(base, d));
    if (bin) out.push({ bin, source: d });
  }
  return out;
}

export function readCache() { try { return JSON.parse(fs.readFileSync(cachePath(), 'utf8')); } catch { return null; } }

export function cacheValid(c) {
  return !!c && c.ok === true && !!c.bin && fs.existsSync(c.bin)
    && c.revision === expectedRevision() && c.playwright === playwrightVersion()
    && (!process.env.RESUME_CHROMIUM || c.bin === process.env.RESUME_CHROMIUM);
}

export function invalidateCache() { try { fs.rmSync(cachePath(), { force: true }); } catch {} }

const PROBE_HTML = '<html><body><p>RESUME-PROBE-中文文本层</p></body></html>';

export async function probe(bin, tmpDir) {
  const out = path.join(tmpDir, `probe-${process.pid}-${Date.now()}.pdf`);
  let browser;
  try {
    browser = await chromium.launch({ executablePath: bin });
    const page = await browser.newPage();
    await page.setContent(PROBE_HTML, { waitUntil: 'load' });
    await page.pdf({ path: out, format: 'A4', printBackground: true });
  } catch { return { ok: false, reason: 'launch-or-pdf-failed' }; }
  finally { try { await browser?.close(); } catch {} }
  try {
    const txt = execFileSync('pdftotext', [out, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 30000 }).toString();
    return txt.includes('RESUME-PROBE-中文文本层') ? { ok: true } : { ok: false, reason: 'no-text-layer' };
  } catch { return { ok: false, reason: 'pdftotext-failed' }; }
  finally { try { fs.rmSync(out, { force: true }); } catch {} }
}

function acquireLock() {
  try {
    const st = fs.statSync(lockPath());
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) return false;
    fs.rmSync(lockPath(), { force: true });   // 陈旧 → 先清，否则下面的 wx 遇 EEXIST 永远无法接管
  } catch {}
  // wx 独占创建：消掉 statSync→writeFileSync 的 TOCTOU（两进程可同时判定"无锁"并各自写入）
  try { fs.mkdirSync(path.dirname(lockPath()), { recursive: true }); fs.writeFileSync(lockPath(), String(process.pid), { flag: 'wx' }); return true; }
  catch { return false; }
}
function releaseLock() {
  // 只删自己持有的锁：本进程的锁若已被陈旧破除并由他人接管，无条件 rm 会删掉对方的
  try { if (fs.readFileSync(lockPath(), 'utf8').trim() !== String(process.pid)) return; } catch { return; }
  try { fs.rmSync(lockPath(), { force: true }); } catch {}
}

export async function resolveChromium({ tmpDir = os.tmpdir(), force = false, waitMs = 30000 } = {}) {
  if (process.env.RESUME_CHROMIUM && !fs.existsSync(process.env.RESUME_CHROMIUM)) {
    throw new Error(`RESUME_CHROMIUM 指定的路径不存在: ${process.env.RESUME_CHROMIUM}`);
  }
  if (!force) {
    const c = readCache();
    if (cacheValid(c)) return c.bin;
  }
  if (!acquireLock()) {
    // 已有进程在探测：只轮询缓存，不再对候选发探针。
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const c = readCache();
      if (cacheValid(c)) return c.bin;
      if (!fs.existsSync(lockPath())) break;
    }
    throw new Error('另一个进程正在探测 Chromium，稍后重试');
  }
  try {
    const reasons = [];
    for (const { bin, source } of candidates()) {
      const r = await probe(bin, tmpDir);
      if (r.ok) {
        fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
        fs.writeFileSync(cachePath(), JSON.stringify({ bin, source, revision: expectedRevision(), playwright: playwrightVersion(), ok: true, probedAt: new Date().toISOString() }, null, 2));
        return bin;
      }
      reasons.push(`${source}: ${r.reason}`);
    }
    throw new Error('没有通过兼容性探针的 Chromium headless shell。\n候选与失败原因:\n  ' + reasons.join('\n  ') + '\n可用 RESUME_CHROMIUM 显式指定。');
  } finally { releaseLock(); }
}
