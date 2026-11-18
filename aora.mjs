// aora.mjs — 装饰角色服务端渲染。aoraSvg 仿 svgAsset 读入（缺失→空串不炸）；
// aoraEmpty = 统一空态块（SVG+文案，textContent 口径：文案服务端 esc）；
// aoraFoot = /settings 署名卡（许可公开发布署名义务落位）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
// 空原型缓存 + hasOwn 判定：挡 __proto__/constructor 原型链命中（照 scripts/extract-icons.mjs 先例）
const cache = Object.create(null);
export function aoraSvg(name) {
  // 白名单 slug：挡路径穿越（name 直接拼进文件路径）
  if (!/^[a-z0-9-]+$/.test(name)) return '';
  if (!Object.hasOwn(cache, name)) {
    try {
      cache[name] = fs.readFileSync(path.join(APP_ROOT, 'assets', 'aora', name + '.svg'), 'utf8').replace(/^<\?xml[^>]*\?>\s*/, '');
    } catch { cache[name] = ''; }
  }
  return cache[name];
}
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function aoraEmpty(text, face = 'happy') {
  return `<div class="aora-empty" style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;color:var(--mut)">${aoraSvg(face)}<span>${esc(text)}</span></div>`;
}
export function aoraFoot() {
  return `<div class="card" style="margin-top:var(--space-3);display:flex;align-items:center;gap:10px;color:var(--mut);font-size:12px">${aoraSvg('happy')}<span>角色形象 Powered by <a href="https://github.com/sam70361/aora-bot" target="_blank" rel="noopener">Aora Bot</a></span></div>`;
}
