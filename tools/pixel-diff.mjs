// tools/pixel-diff.mjs — RGB24 视觉门禁（S1 Task 6；Task 7 schemaVersion 迁移硬依赖，Task 9 复用）
// 用法（CLI，薄包装）:
//   node tools/pixel-diff.mjs <a.pdf> <b.pdf> [--dpi 150] [--threshold 0.005]
// 编程 API（进程内调用）:
//   import { comparePdfs, CheckerMissingError } from './tools/pixel-diff.mjs';
//   comparePdfs(a, b, { dpi, threshold, keepTmp }) → { pages: [{page, ratio, diffBytes, totalBytes}], max, pass, dpi, threshold, env, pixFmt }
//   页数不等 → { pass:false, pages:[], max:null, error:'页数不等…' }
// 管线（固定，不得替换为灰度）:
//   pdftoppm -png -r <dpi> 两份 PDF → 每页 ffmpeg -pix_fmt rgb24 -f rawvideo → Buffer 逐字节 diff/total。
//   RGB24 强制：灰度会漏报「仅改颜色」（等亮度色差对在灰度下逐字节相同），计划评审要求颜色级差异必须 register > 0。
// 退出码（CLI）: 0=通过；1=未通过（含页数不等）；2=用法/文件/渲染错误；3=检查器缺失（ffmpeg/pdftoppm 不在 PATH）。
//   铁律：检查器缺失 = 停止（exit 3），绝不降级为灰度或跳过门禁；Task 7 把 exit 3 视为 STOP。
// 环境记录诚实性（Task 4 评审 carry-over）: 本工具只记录 pdftoppm/ffmpeg 版本、dpi、pix_fmt——不读渲染旁车、
//   不声称字体一致。render.mjs 旁车 fonts 字段是「已声明 FontFace」清单而非实际加载字体，任何消费方不得把它当 loaded-font equality。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DPI = 150;          // 视觉比较基准（与 render.mjs 旁车 dpi=150 约定一致）
export const DEFAULT_THRESHOLD = 0.005;  // diff/total ≤ 0.5%（计划全局约束）
const CHECKERS = { pdftoppm: 'brew install poppler', ffmpeg: 'brew install ffmpeg' };

// 检查器缺失错误：CLI exit 3；进程内调用方按 code==='CHECKER_MISSING' 判 STOP（不降级）
export class CheckerMissingError extends Error {
  constructor(tool) {
    super(`检查器缺失: ${tool} 不在 PATH（视觉门禁不降级，装好后重试）。修复: ${CHECKERS[tool]}`);
    this.name = 'CheckerMissingError';
    this.tool = tool;
    this.fix = CHECKERS[tool];
    this.code = 'CHECKER_MISSING';
  }
}

// 存在性判定只认 ENOENT（spawn 失败）；版本串 best-effort 记录（ffmpeg 走 stdout，pdftoppm 走 stderr）
function checkerVersion(tool) {
  const r = spawnSync(tool, ['-version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error && (r.error.code === 'ENOENT' || r.error.errno === 'ENOENT')) throw new CheckerMissingError(tool);
  return String((r.stdout || '').split('\n')[0] || (r.stderr || '').split('\n')[0] || '').trim();
}

export function assertCheckers() {
  const env = {};
  for (const tool of ['pdftoppm', 'ffmpeg']) env[tool] = checkerVersion(tool);
  return env;
}

function renderPngs(pdf, tmp, tag, dpi) {
  const prefix = path.join(tmp, tag);
  const r = spawnSync('pdftoppm', ['-png', '-r', String(dpi), pdf, prefix], { encoding: 'utf8', timeout: 300000 });
  if (r.status !== 0) throw new Error(`pdftoppm 渲染失败（${pdf}）: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  // 同前缀同目录，页码零填充等宽 → 字典序即页序
  const pngs = fs.readdirSync(tmp).filter((f) => f.startsWith(tag + '-') && f.endsWith('.png')).sort();
  if (!pngs.length) throw new Error(`pdftoppm 未产出任何页（${pdf}）`);
  return pngs.map((f) => path.join(tmp, f));
}

function pngToRawRgb24(png, tmp) {
  const raw = path.join(tmp, path.basename(png) + '.rgb24.raw');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`ffmpeg rgb24 转换失败（${png}）: ${String(r.stderr || '').slice(0, 400)}`);
  if (!fs.existsSync(raw)) throw new Error(`ffmpeg 未产出 raw（${png}）`);
  return raw;
}

// 逐字节比较；长度不等时长度差全额计入 diff（分母取较大者）
function diffBuffers(a, b) {
  const total = Math.max(a.length, b.length);
  if (total === 0) return { diff: 0, total: 0, ratio: 0 };
  if (a.length === b.length && a.equals(b)) return { diff: 0, total, ratio: 0 };
  const n = Math.min(a.length, b.length);
  let diff = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diff++;
  return { diff, total, ratio: diff / total };
}

export function comparePdfs(a, b, opts = {}) {
  const dpi = Number(opts.dpi ?? DEFAULT_DPI);
  const threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
  if (!Number.isFinite(dpi) || dpi <= 0) throw new Error('非法 dpi: ' + String(opts.dpi));
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('非法 threshold: ' + String(opts.threshold));
  for (const f of [a, b]) if (!fs.existsSync(f)) throw new Error('PDF 不存在: ' + f);
  const env = assertCheckers(); // CheckerMissingError 直接上抛 —— 缺失即停止，绝不降级
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-diff-'));
  try {
    const pngA = renderPngs(a, tmp, 'a', dpi);
    const pngB = renderPngs(b, tmp, 'b', dpi);
    if (pngA.length !== pngB.length) {
      return {
        pass: false, pages: [], max: null, dpi, threshold, env, pixFmt: 'rgb24',
        error: `页数不等: a=${pngA.length} 页, b=${pngB.length} 页（视觉门禁要求页数相同）`
      };
    }
    const pages = [];
    for (let i = 0; i < pngA.length; i++) {
      const ra = fs.readFileSync(pngToRawRgb24(pngA[i], tmp));
      const rb = fs.readFileSync(pngToRawRgb24(pngB[i], tmp));
      const d = diffBuffers(ra, rb);
      pages.push({ page: i + 1, ratio: d.ratio, diffBytes: d.diff, totalBytes: d.total });
    }
    const max = pages.reduce((m, p) => Math.max(m, p.ratio), 0);
    return { pass: max <= threshold, pages, max, dpi, threshold, env, pixFmt: 'rgb24' };
  } finally {
    if (!opts.keepTmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// —— CLI（薄包装）：只做参数解析、输出与退出码映射，比较逻辑全在 comparePdfs ——
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const args = [];
  let dpi = DEFAULT_DPI, threshold = DEFAULT_THRESHOLD;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dpi') dpi = Number(argv[++i]);
    else if (argv[i] === '--threshold') threshold = Number(argv[++i]);
    else args.push(argv[i]);
  }
  if (args.length !== 2) {
    console.error('用法: node tools/pixel-diff.mjs <a.pdf> <b.pdf> [--dpi 150] [--threshold 0.005]');
    process.exit(2);
  }
  try {
    const r = comparePdfs(args[0], args[1], { dpi, threshold });
    for (const p of r.pages) console.log(`第 ${p.page} 页: ratio ${p.ratio.toFixed(6)}（diff ${p.diffBytes} / total ${p.totalBytes} bytes）`);
    if (r.pass) {
      console.log(`VERDICT: PASS — max ratio ${r.max.toFixed(6)} ≤ 阈值 ${r.threshold}（dpi ${r.dpi}, pix_fmt rgb24）`);
      process.exit(0);
    }
    console.log(`VERDICT: FAIL — ${r.error || `max ratio ${r.max.toFixed(6)} > 阈值 ${r.threshold}`}（dpi ${r.dpi}, pix_fmt rgb24）`);
    process.exit(1);
  } catch (e) {
    if (e && e.code === 'CHECKER_MISSING') { console.error(e.message); process.exit(3); }
    console.error('视觉门禁错误: ' + (e && e.message || e));
    process.exit(2);
  }
}
