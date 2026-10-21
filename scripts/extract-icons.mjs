#!/usr/bin/env node
// 从本机 lucide-react 提取图标 path 数据 → vendors/icons.mjs（零运行时依赖）
// 用法: node scripts/extract-icons.mjs [lucide-icons-dir]
// 缺省从常见位置探测；探测不到就报错退出（不静默产出空文件）。
//
// ⚠️ 安全边界：源目录是**外部输入**（可以是任意路径），脚本绝不执行它的文本。
//    源文件里的图标数据是 JS 字面量（key 未加引号），这里只做「给未加引号的 key
//    补上双引号」的**纯文本规范化**，再用 JSON.parse 求值 —— 任何解析失败都 exit 1。
//    失败路径绝不写文件，已有产物保持不变。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_FILE = join(ROOT, 'scripts', 'icons.list.json');
const OUT_FILE = join(ROOT, 'vendors', 'icons.mjs');

// —— 图标清单的唯一来源：scripts/icons.list.json（脚本与 test-structure.sh 共用）——
let NAMES;
try {
  NAMES = JSON.parse(readFileSync(LIST_FILE, 'utf8'));
} catch (e) {
  console.error('读取图标清单失败: ' + LIST_FILE + ' —— ' + e.message);
  process.exit(1);
}
if (!Array.isArray(NAMES) || NAMES.length === 0) {
  console.error('图标清单必须是非空数组: ' + LIST_FILE);
  process.exit(1);
}
if (new Set(NAMES).size !== NAMES.length) {
  console.error('图标清单里有重复名: ' + LIST_FILE);
  process.exit(1);
}
for (const n of NAMES) {
  // 只允许安全 slug：既挡住注入，也挡住 __proto__ 这类对象字面量特殊键
  if (typeof n !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(n)) {
    console.error('非法图标名: ' + JSON.stringify(n));
    process.exit(1);
  }
}

// —— 探测源目录：显式参数 > 本仓库 node_modules > 用户级 node_modules ——
const HOME = process.env.HOME;
const candidates = [
  process.argv[2],
  join(ROOT, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons'),
  HOME ? join(HOME, 'node_modules', 'lucide-react', 'dist', 'esm', 'icons') : null,
].filter(Boolean);
const SRC = candidates.find((d) => existsSync(join(d, 'file-text.js')));
if (!SRC) {
  console.error('找不到 lucide-react 图标目录。已尝试:\n  ' + candidates.join('\n  '));
  console.error('用法: node scripts/extract-icons.mjs <lucide-icons-dir>');
  process.exit(1);
}

// —— 版本与来源从来源包 package.json 动态读（icons 目录上溯三级 = 包根）——
//    写死版本号会让「换目录重跑」后头部仍在宣称旧版本，溯源失真。
const PKG_DIR = join(SRC, '..', '..', '..');
const PKG_JSON = join(PKG_DIR, 'package.json');
if (!existsSync(PKG_JSON)) {
  console.error('找不到来源包 package.json: ' + PKG_JSON + '\n  期望目录布局 <pkg>/dist/esm/icons');
  process.exit(1);
}
let version;
try {
  version = JSON.parse(readFileSync(PKG_JSON, 'utf8')).version;
} catch (e) {
  console.error('解析来源包 package.json 失败: ' + PKG_JSON + ' —— ' + e.message);
  process.exit(1);
}
if (!version) {
  console.error('来源包 package.json 没有 version 字段: ' + PKG_JSON);
  process.exit(1);
}

/**
 * 把 JS 对象字面量规范化成严格 JSON：给**未加引号的 key** 补双引号。
 * 只改 key，不动任何值 —— 字符串字面量整体原样拷贝，
 * 所以值里的 { } : , 不会被误认成 key 分隔符。
 */
function toStrictJson(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"') {                                  // 字符串字面量：原样拷贝（含转义）
      out += ch; i++;
      while (i < n) {
        const c = src[i];
        out += c; i++;
        if (c === '\\') { if (i < n) { out += src[i]; i++; } continue; }
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '{' || ch === ',') {                   // 可能是「key:」的开头
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(j));
      if (m) {
        let k = j + m[0].length;
        while (k < n && /\s/.test(src[k])) k++;
        if (src[k] === ':') {
          out += ch + src.slice(i + 1, j) + '"' + m[0] + '"';
          i = k;                                      // 停在 ':' 处继续
          continue;
        }
      }
    }
    out += ch; i++;
  }
  return out;
}

const out = {};
const missing = [];
for (const n of NAMES) {
  const f = join(SRC, n + '.js');
  if (!existsSync(f)) { missing.push(n + '(文件不存在)'); continue; }
  const s = readFileSync(f, 'utf8');
  const m = s.match(/createLucideIcon\("[^"]+",\s*(\[[\s\S]*?\])\s*\)/);
  if (!m) { missing.push(n + '(未匹配到 createLucideIcon 数据)'); continue; }
  let arr;
  try {
    arr = JSON.parse(toStrictJson(m[1]));
  } catch (e) {
    missing.push(n + '(字面量解析失败: ' + e.message + ')');
    continue;
  }
  if (!Array.isArray(arr) || arr.length === 0) {
    missing.push(n + '(数据不是非空数组)');
    continue;
  }
  const norm = [];
  for (const el of arr) {
    if (!Array.isArray(el) || el.length !== 2 || typeof el[0] !== 'string'
        || !el[1] || typeof el[1] !== 'object' || Array.isArray(el[1])) {
      missing.push(n + '(元素形状非法)');
      norm.length = -1;
      break;
    }
    const a = {};
    for (const [k, v] of Object.entries(el[1])) {
      if (k === 'key') continue;                     // lucide 的 react key，不是几何属性
      a[k] = String(v);                              // SVG 属性一律字符串
    }
    norm.push([el[0], a]);
  }
  if (norm.length < 0) continue;
  out[n] = norm;
}
if (missing.length) {
  console.error('以下图标有问题（先修 scripts/icons.list.json 或来源目录再重跑）:\n  ' + missing.join('\n  '));
  process.exit(1);
}

// —— 生成产物：ESM + null 原型对象 + 一个图标一行（便于 diff）——
const body = NAMES.map((n) => '  ' + JSON.stringify(n) + ': ' + JSON.stringify(out[n]) + ',').join('\n');
const js = `// 图标数据 —— 一次性从 lucide-react v${version} 提取（ISC 许可，路径数据可自由使用/修改）。
// 上游 lucide：Copyright (c) Lucide Contributors 2020；
// 其中源自 Feather 的部分：Copyright (c) Cole Bemis 2013-2023。
// 许可全文见 vendors/icons.LICENSE（ISC）。
// 零运行时依赖：不含任何 npm 包，直接内联 SVG path。生成脚本: scripts/extract-icons.mjs
// 来源: ${SRC}
// 图标清单: scripts/icons.list.json（唯一来源，改图标集改它再重跑）。
// 共 ${NAMES.length} 个图标，一个一行 —— 改哪个一眼看得见。
export const ICONS = Object.assign(Object.create(null), {
${body}
});
`;
mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, js);
console.log('提取图标数:', NAMES.length, '| 来源版本: v' + version, '| 输出:', OUT_FILE);
