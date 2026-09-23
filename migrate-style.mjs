// migrate-style.mjs — 一次性：把现有文档的 <style> 块替换为 template.html 的 brutal 版（先快照，幂等）
// 用法: node migrate-style.mjs [docId]   （给 docId 则只迁移该文档，供测试）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
const m = tpl.match(/<style>([\s\S]*?)<\/style>/);
if (!m || !m[1].includes('BRUTAL-V1')) throw new Error('template.html 缺少 BRUTAL-V1 样式块，先完成 Task 1');
const brutalStyle = m[0];

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const force = process.argv.includes('--force');  // 样式迭代后强制重同步（快照照打，幂等保险保留给非 force）
const docs = fs.readdirSync(path.join(root, 'docs'))
  .filter((f) => f.endsWith('.html') && !f.startsWith('.'))
  .filter((f) => !only || f === only + '.html');
for (const f of docs) {
  const p = path.join(root, 'docs', f);
  const html = fs.readFileSync(p, 'utf8');
  if (!force && html.includes('BRUTAL-V1')) { console.log('skip（已是 brutal）:', f); continue; }
  if (!/<style>[\s\S]*?<\/style>/.test(html)) { console.log('skip（无 style 块，未动）:', f); continue; }
  const dir = path.join(root, 'snapshots', f.replace('.html', ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(p, path.join(dir, timestamp() + '.html'));
  fs.writeFileSync(p, html.replace(/<style>[\s\S]*?<\/style>/, brutalStyle));
  console.log('migrated:', f);
}
