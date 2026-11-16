// template.mjs — 模板装配唯一入口（S1 Task 5）
// themes/resume-<name>.css 是简历样式的唯一源；template.html 只留 <!--THEME-CSS--> 标记。
// assembleTemplate(name) = 读 template.html（永远来自 APP_ROOT，与数据根无关）+ 把标记替换为
//   <style data-theme="<name>">…</style>，内联 CSS 与 themes 文件逐字节一致（sha1 相同 → 与 freeze 的
//   cssHash/styleHash 口径一致）。未知主题 → 抛错并列出可用主题。
// themeRegistration(name) = 新建文档创建时的 meta 登记载荷（经 tx.mjs updateMeta 写入；
//   既有文档保留实际内联 CSS，legacy 登记在 T7 迁移，不在这里）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha1 } from './freeze.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = path.join(APP_ROOT, 'themes');
const THEME_FILE_RE = /^resume-([^/]+)\.css$/;
const THEME_MARKER = '<!--THEME-CSS-->';

// 可用主题 = themes/resume-*.css 的文件名（去掉 resume- 前缀与 .css 后缀）
export function listThemes() {
  try {
    return fs.readdirSync(THEMES_DIR)
      .map((f) => THEME_FILE_RE.exec(f))
      .filter(Boolean)
      .map((m) => m[1])
      .sort();
  } catch { return []; }
}

// 主题 CSS 原文（与文件逐字节一致）
export function themeCss(name) {
  const avail = listThemes();
  if (!avail.includes(name)) {
    throw new Error(`未知主题: ${String(name)}（可用主题: ${avail.join(', ') || '无'}）`);
  }
  return fs.readFileSync(path.join(THEMES_DIR, `resume-${name}.css`), 'utf8');
}

// 装配完整模板 HTML（含 {{…}} 内容占位符，由调用方替换）
export function assembleTemplate(name) {
  const tpl = fs.readFileSync(path.join(APP_ROOT, 'template.html'), 'utf8');
  if (!tpl.includes(THEME_MARKER)) throw new Error(`template.html 缺少 ${THEME_MARKER} 标记`);
  const css = themeCss(name);   // 未知主题在替换前抛错
  // 函数替换：防止 CSS 里的 $& 等模式被 replace 特殊解释；内联块与 themes 文件逐字节一致
  // 主题名进 data-theme 属性 → 按属性上下文转义（" 会截断属性；当前调用点都写死 'classic'，
  // 但别留这个雷：themes/ 下多一个带引号的文件名就能注入 HTML）
  const attr = String(name).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return tpl.replace(THEME_MARKER, () => `<style data-theme="${attr}">${css}</style>`);
}

// 新建文档的 meta 登记载荷（唯一源 classic 主题）：theme/styleHash/typo/schemaVersion
export function themeRegistration(name = 'classic') {
  return { theme: name, styleHash: sha1(themeCss(name)), typo: '', schemaVersion: 1 };
}
