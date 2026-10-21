#!/usr/bin/env node
// 从本机 lucide-react 提取图标 path 数据 → vendors/icons.js（零运行时依赖）
// 用法: node scripts/extract-icons.mjs [lucide-icons-dir]
// 缺省从常见位置探测；探测不到就报错退出（不静默产出空文件）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAMES = [
  'file-text','box','columns-3','chart-bar','settings','house','archive','trash-2',
  'pencil','plus','save','link','map-pin','bot','lightbulb','target','sparkles',
  'hand','message-square','stethoscope','palette','refresh-cw','menu','calendar',
  'type','x','check','circle-alert','circle-check','circle-x','circle-help','clock',
  'list-checks','database','package','folder-open','layout-dashboard','square-pen',
  'text-quote','compass','pin','tag','undo-2','circle-slash',
];

const candidates = [
  process.argv[2],
  join(process.env.HOME || '', 'projects/get_jobs/front/node_modules/lucide-react/dist/esm/icons'),
  join(process.env.HOME || '', 'node_modules/lucide-react/dist/esm/icons'),
].filter(Boolean);
const SRC = candidates.find((d) => existsSync(join(d, 'file-text.js')));
if (!SRC) {
  console.error('找不到 lucide-react 图标目录。已尝试:\n  ' + candidates.join('\n  '));
  console.error('用法: node scripts/extract-icons.mjs <lucide-icons-dir>');
  process.exit(1);
}

const out = {};
const missing = [];
for (const n of NAMES) {
  const f = join(SRC, n + '.js');
  if (!existsSync(f)) { missing.push(n); continue; }
  const s = readFileSync(f, 'utf8');
  const m = s.match(/createLucideIcon\("[^"]+",\s*(\[[\s\S]*?\])\s*\)/);
  if (!m) { missing.push(n + '(解析失败)'); continue; }
  // 源文件是 JS 字面量（key 未加引号），不能 JSON.parse —— 用 Function 构造器求值
  const arr = new Function('return ' + m[1])();
  out[n] = arr.map(([tag, attrs]) => { const a = { ...attrs }; delete a.key; return [tag, a]; });
}
if (missing.length) {
  console.error('以下图标未找到（先修 NAMES 列表再重跑）:\n  ' + missing.join('\n  '));
  process.exit(1);
}
mkdirSync(join(ROOT, 'vendors'), { recursive: true });
// 输出用 CommonJS（exports.ICONS）而非 ESM：本仓库 package.json 是 "type":"commonjs"，
// .js 文件会被 Node 当 CJS 解析，写 `export const` 会让 `import { ICONS } from './vendors/icons.js'`
// 直接报 "Named export 'ICONS' not found"。CJS 命名导出可被 ESM 正常 import（已实测）。
const js = `// 图标数据 —— 一次性从 lucide-react v0.468.0 提取（ISC 许可，路径数据可自由使用/修改）。
// 零运行时依赖：不含任何 npm 包，直接内联 SVG path。生成脚本: scripts/extract-icons.mjs
// 共 ${Object.keys(out).length} 个图标。改图标集 → 改脚本 NAMES → 重跑。
// 用 CommonJS 导出：仓库 package.json 是 "type":"commonjs"，.js 走 ESM 解析会失败。
exports.ICONS = ${JSON.stringify(out)};
`;
writeFileSync(join(ROOT, 'vendors', 'icons.js'), js);
console.log('提取图标数:', Object.keys(out).length, '| 输出:', join(ROOT, 'vendors', 'icons.js'));
