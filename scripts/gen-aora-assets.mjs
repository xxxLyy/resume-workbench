// scripts/gen-aora-assets.mjs — 构建期渲装饰 SVG（svgAsset 惯例的素材源）。
// 用法：node scripts/gen-aora-assets.mjs（引擎升级后重跑）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStaticSvg, castMember } from '@aora-bot/engine/static';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'assets', 'aora');
fs.mkdirSync(outDir, { recursive: true });
const m = castMember('dot');
if (!m) throw new Error('cast id "dot" 不存在');
for (const state of ['happy', 'confused', 'sleeping']) {
  const svg = renderStaticSvg({ shape: m.shape, color: m.color, face: m.face, nose: m.nose, state, sizePx: 48 });
  if (!svg.includes('<svg')) throw new Error(state + ' 渲染结果不是 SVG');
  // 原子写：tmp + rename，写途中被打断不留半截 svg（照 scripts/extract-icons.mjs 先例）
  const tmpFile = path.join(outDir, state + '.svg.tmp');
  fs.writeFileSync(tmpFile, svg);
  fs.renameSync(tmpFile, path.join(outDir, state + '.svg'));
  console.log('assets/aora/' + state + '.svg', svg.length, 'bytes');
}
