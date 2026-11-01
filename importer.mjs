// importer.mjs — PDF → 文本 → 可编辑文档（无 LLM 配置时降级为纯文本导入）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hasLLM, loadConfig } from './llm.mjs';
import { structureText } from './structure.mjs';
import { assembleTemplate, themeRegistration } from './template.mjs';
import { updateMeta, atomicWrite } from './tx.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slugify(name) {
  const base = String(name || 'doc').replace(/\.pdf$/i, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
  return base.slice(0, 40);
}

// 原子分配文档 id（AUD-12）：fs.openSync(path, 'wx') 是原子的「不存在才创建」——
// 两个同名上传同时通过「不存在」检查 → 只保留一份文档（实测过：并发两个同名请求拿到同一个 id）。
// 占位文件用 .tmp 后缀（BL-P6-06）：结构化期间（真实 LLM 可达数分钟）0 字节占位若叫
// <id>.html，会被 docIdsOnDisk 计入首页列表成为点不开的「文档已损坏」条目，且 SIGKILL 后
// 永久残留；.tmp 形态对文档列表不可见，正文就绪后 rename 转正。
// 碰撞双闸：<id>.html 已存在（上一轮同名导入已完成）→ 跳过该候选，防转正时覆盖既有文档；
// <id>.html.tmp 已存在（并发在途或 SIGKILL 残留）→ 同样跳过。残留不可见且惰性，不做
// reclaim——无法区分「死进程残留」与「活导入在途」，宁滥勿删（同名残留会在转正时被覆盖回收）。
function allocateDocId(root, name) {
  const base = slugify(name);
  let id = base, n = 2;
  for (;;) {
    const finalPath = path.join(root, 'docs', id + '.html');
    const tmpPath = finalPath + '.tmp';
    let finalTaken = false;
    try { fs.statSync(finalPath); finalTaken = true; } catch {}
    if (!finalTaken) {
      try {
        const fd = fs.openSync(tmpPath, 'wx', 0o600);
        fs.closeSync(fd);
        return { id, tmpPath };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    id = `${base}-${n++}`;
  }
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
  // 先原子占位再干活：结构化可能耗时几十秒，占位必须先落，否则并发同名会撞车。
  // 占位是 .tmp 形态（BL-P6-06）：结构化期间对文档列表不可见；正文原子写入 .tmp 后
  // rename 转正——列表只在文档完整就绪后才可见，SIGKILL 残留也不再是可见的空壳条目。
  const { id, tmpPath } = allocateDocId(root, name);
  const finalPath = path.join(root, 'docs', id + '.html');
  try {
    let html;
    if (hasLLM(root)) {
      html = await structureText(root, text);   // 失败返回 null 则降级
      if (!html) html = buildRawDoc(root, text, name, 'failed', id);
      else html = html.replaceAll('{{DOC_ID}}', () => esc(id));   // 与降级路径 :52-53 同契约：落盘字节带真实 docId（函数替换防 $& 解释）
    } else {
      html = buildRawDoc(root, text, name, loadConfig(root) ? 'partial' : null, id);   // 实参顺序：name→degradeReason→docId（错位会把 docId 喂进 degradeReason、docId 槽缺参落空串）
    }
    atomicWrite(tmpPath, html);   // 导入的简历正文同样收紧（0o600）；先写 .tmp 再转正
    fs.renameSync(tmpPath, finalPath);
    // 新建即登记样式来源（meta 唯一写入者 updateMeta）：theme/styleHash/typo/schemaVersion
    updateMeta(root, id, (m) => ({ ...(m || {}), ...themeRegistration('classic') }));
  } catch (e) {
    // 不留空壳文档：转正前失败清 .tmp，转正后失败（如 meta 写入抛错）清已转正文件
    try { fs.rmSync(tmpPath, { force: true }); } catch {}
    try { fs.rmSync(finalPath, { force: true }); } catch {}
    throw e;
  }
  return id;
}
