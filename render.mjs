// render.mjs — HTML → PDF（playwright-core + 系统缓存 Chromium，零浏览器下载）
// 用法:
//   node render.mjs <docId>                       # {RESUME_ROOT}/docs/<id>.html → {RESUME_ROOT}/pdfs/<id>.pdf
//   node render.mjs --src <file.html> --out <x.pdf>   # 任意源文件（存档 PDF 从冻结内容生成）
// 纪律：先渲染到临时文件，成功后原子替换目标；失败退出码非 0，绝不留下"半截新 PDF"冒充成功。
// 成功后写渲染环境旁车 <out>.env.json = { bin, browserVersion, fonts, dpi:150, renderInputId, reproducible, at }。
// 环境变量:
//   RESUME_ROOT       数据目录（默认脚本所在目录）
//   RESUME_CHROMIUM   Chromium headless shell 可执行文件路径（覆盖自动探测）
//   RESUME_RENDER_INPUT_ID / RESUME_RENDER_REPRODUCIBLE('1'|'0')
//                     渲染标识与可复现性，由调用方（server renderCurrent）传入，本脚本只透传进旁车。
//                     铁律二：本脚本对文档元数据保持盲态 —— 只读环境变量与 --src 文件，绝不读任何元数据 JSON。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromium, invalidateCache } from './chromium.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = process.env.RESUME_ROOT || APP_ROOT;

const argv = process.argv.slice(2);
let src, out;
if (argv[0] === '--src') {
  src = argv[1];
  const oi = argv.indexOf('--out');
  out = oi >= 0 ? argv[oi + 1] : null;
  if (!src || !out) { console.error('用法: node render.mjs --src <html> --out <pdf>'); process.exit(2); }
} else {
  const id = argv[0] || 'linghaoxiang';
  src = path.join(DATA_ROOT, 'docs', `${id}.html`);
  out = path.join(DATA_ROOT, 'pdfs', `${id}.pdf`);
}
if (!fs.existsSync(src)) { console.error('源文件不存在: ' + src); process.exit(2); }

const html = fs.readFileSync(src, 'utf8');
// ATS 兼容：智能引号转直引号（与 career-ops generate-pdf.mjs 行为一致）
const normalized = html.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

let bin;
try { bin = await resolveChromium(); }
catch (e) { console.error(e.message); process.exit(3); }

fs.mkdirSync(path.dirname(out), { recursive: true });
const tmpOut = out + '.tmp-' + process.pid + '-' + Date.now();
let browser;
let browserVersion = null;
try {
  browser = await chromium.launch({ executablePath: bin });
  browserVersion = browser.version();
} catch (e) {
  // 缓存的二进制此刻不可用（被删/被换）：失效重探一次，仍失败才报错。
  invalidateCache();
  try {
    bin = await resolveChromium({ force: true });
    browser = await chromium.launch({ executablePath: bin });
    browserVersion = browser.version();
  } catch (e2) {
    console.error('渲染失败（Chromium 不可用）: ' + (e2 && e2.message || e2));
    process.exit(3);
  }
}
let fonts = [];
try {
  const page = await browser.newPage();
  await page.setContent(normalized, { waitUntil: 'load' });
  await page.waitForTimeout(500); // 等分页线 JS 与字体稳定
  // 固定环境记录：实际参与渲染的字体（family/weight/style，去重排序 → 确定性）
  try {
    fonts = await page.evaluate(() => {
      const s = new Set();
      document.fonts.forEach((f) => s.add(f.family + ' ' + f.weight + ' ' + f.style));
      return Array.from(s).sort();
    });
  } catch { fonts = []; }
  await page.pdf({ path: tmpOut, format: 'A4', printBackground: true, preferCSSPageSize: true });
} catch (e) {
  try { fs.rmSync(tmpOut, { force: true }); } catch {}
  console.error('渲染失败: ' + (e && e.message || e));
  process.exit(1);
} finally {
  await browser.close(); // 中途抛错也不能留孤儿浏览器进程
}
const size = fs.existsSync(tmpOut) ? fs.statSync(tmpOut).size : 0;
if (size < 1000) {  // 空壳 PDF 视为失败，不允许替换目标
  try { fs.rmSync(tmpOut, { force: true }); } catch {}
  console.error('渲染产物异常（' + size + ' 字节），已放弃替换');
  process.exit(1);
}
fs.renameSync(tmpOut, out);  // 原子替换：成功才动目标文件
// 渲染环境旁车：只在成功后写（与 PDF 成对）；标识/可复现性仅来自 env（未设 → null，不伪造）。
// dpi=150 为固定环境约定（视觉比较基准）。原子写：唯一临时 + rename。
const envInfo = {
  bin,
  browserVersion,
  fonts,
  dpi: 150,
  renderInputId: process.env.RESUME_RENDER_INPUT_ID || null,
  reproducible: process.env.RESUME_RENDER_REPRODUCIBLE === '1' ? true
    : process.env.RESUME_RENDER_REPRODUCIBLE === '0' ? false : null,
  at: new Date().toISOString()
};
const sideTmp = out + '.env.json.tmp-' + process.pid + '-' + Date.now();
fs.writeFileSync(sideTmp, JSON.stringify(envInfo, null, 2));
fs.renameSync(sideTmp, out + '.env.json');
console.log('rendered:', out, size, 'bytes');
