// importer.mjs — PDF → 文本 → 可编辑文档（无 LLM 配置时降级为纯文本导入）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hasLLM, loadConfig } from './llm.mjs';
import { structureText } from './structure.mjs';
import { assembleTemplate, themeRegistration } from './template.mjs';
import { updateMeta } from './tx.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slugify(name) {
  const base = String(name || 'doc').replace(/\.pdf$/i, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
  return base.slice(0, 40);
}

function uniqueId(root, name) {
  const base = slugify(name);
  let id = base, n = 2;
  while (fs.existsSync(path.join(root, 'docs', id + '.html'))) id = `${base}-${n++}`;
  return id;
}

// 降级文档：纯文本进"导入原文"区，模板结构完整可编辑；degradeReason 说明降级原因
function buildRawDoc(root, text, name, degradeReason, docId) {
  const note = degradeReason === 'failed' ? 'LLM 结构化失败，已降级为原文导入'
    : degradeReason === 'partial' ? 'LLM 配置不完整，已降级为原文导入'
    : '待整理';
  const tpl = assembleTemplate('classic');   // 主题唯一源装配（与数据根无关，永远来自 APP_ROOT）
  return tpl
    .replaceAll('{{NAME}}', () => esc(String(name).replace(/\.pdf$/i, '')))
    .replaceAll('{{CONTACT}}', () => '')
    .replaceAll('{{INTENT}}', () => '')
    .replaceAll('{{SUMMARY}}', () => `以下为 PDF 提取的原文（${note}）：`)
    .replaceAll('{{SKILLS}}', () => '')
    .replaceAll('{{WORK}}', () => '')
    .replaceAll('{{PROJECTS}}', () => `<div class="plain-lines"><p style="white-space:pre-wrap">${esc(text)}</p></div>`)
    .replaceAll('{{EDU}}', () => '')
    // DOC_ID 占位符也要替换：/edit 服务端会替换，但快照/导出/直读磁盘拿到的字节里留着占位符
    .replaceAll('{{DOC_ID}}', () => esc(String(docId || '')));
}

export async function importPdfText(root, pdfPath, name) {
  const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 30000 }).toString('utf8');
  if (!text.trim()) throw new Error('PDF 提取不到文本（可能是扫描件）');
  const id = uniqueId(root, name);
  let html;
  if (hasLLM(root)) {
    html = await structureText(root, text);   // 失败返回 null 则降级
    if (!html) html = buildRawDoc(root, text, name, 'failed', id);
  } else {
    html = buildRawDoc(root, text, name, loadConfig(root) ? 'partial' : null, id);
  }
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), html, { mode: 0o600 });   // 导入的简历正文同样收紧（2026-10-19 审查 ⚪-6 扩展）
  // 新建即登记样式来源（meta 唯一写入者 updateMeta）：theme/styleHash/typo/schemaVersion
  updateMeta(root, id, (m) => ({ ...(m || {}), ...themeRegistration('classic') }));
  return id;
}
