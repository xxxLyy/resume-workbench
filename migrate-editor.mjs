// migrate-editor.mjs — 把现有文档的编辑器（工具栏 + 主脚本）升级为 template.html 的当前版本（先快照，幂等）
// 用法: node migrate-editor.mjs [docId]   （给 docId 则只迁移该文档，供测试）
// 护栏：旧块不匹配则跳过该文档并报告，绝不硬改；template 里 {{DOC_ID}} 会替换为各文档自身 id
// v5：保存状态机改为 revision 三态（编辑/已提交/已确认），保存期间新编辑排队续存，
//     恢复缓存含排版（typo-custom），多标签 baseMtime 冲突检测；正文保存不再触发 PDF 渲染。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
const TARGET_VERSION = 'v5';

const toolbar = tpl.match(/<div class="edit-toolbar"[^>]*>[\s\S]*?<\/div>/);
const script = tpl.match(/<script>[\s\S]*?<\/script>/);
if (!toolbar || !toolbar[0].includes(`data-editor="${TARGET_VERSION}"`)) throw new Error(`template.html 缺 data-editor="${TARGET_VERSION}" 工具栏`);
if (!script || !script[0].includes('var DOC_ID')) throw new Error('template.html 缺编辑器主脚本');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const only = process.argv[2];
const docs = fs.readdirSync(path.join(root, 'docs'))
  .filter((f) => f.endsWith('.html') && !f.startsWith('.'))
  .filter((f) => !only || f === only + '.html');
for (const f of docs) {
  const id = f.replace('.html', '');
  const p = path.join(root, 'docs', f);
  const html = fs.readFileSync(p, 'utf8');
  if (html.includes(`data-editor="${TARGET_VERSION}"`)) { console.log('skip（已是 ' + TARGET_VERSION + '）:', f); continue; }
  const hasOldBar = /<div class="edit-toolbar"[^>]*>[\s\S]*?<\/div>/.test(html);
  const hasOldScript = /<script>\s*\(function \(\) \{[\s\S]*?<\/script>/.test(html);
  if (!hasOldBar || !hasOldScript) { console.log('skip（旧编辑器块不匹配，未动）:', f); continue; }
  const dir = path.join(root, 'snapshots', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(p, path.join(dir, timestamp() + '.html'));
  const newScript = script[0].replaceAll('{{DOC_ID}}', () => id);
  const out = html
    .replace(/<div class="edit-toolbar"[^>]*>[\s\S]*?<\/div>/, toolbar[0])
    .replace(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/, newScript);
  fs.writeFileSync(p, out);
  console.log('migrated:', f);
}
