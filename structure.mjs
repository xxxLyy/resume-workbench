// structure.mjs — 简历文本 → LLM 结构化 JSON → 模板 HTML
import { chat } from './llm.mjs';
import { assembleTemplate } from './template.mjs';

const SYS = `你是简历结构化助手。把用户给的简历原文提取为 JSON（只输出 JSON，不要任何其它文字）：
{"name":"","contact":"","intent":"","summary":"","skills":["标签：内容"],"work":[{"title":"公司","role":"职位","date":"起止","bullets":[]}],"projects":[{"title":"","role":"","date":"","bullets":[]}],"education":[{"title":"学校","role":"学历|专业","date":"起止"}]}
没有的信息留空字符串/空数组，不要编造。`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bullets = (arr) => (arr || []).map((b) => `        <li>${esc(b)}</li>`).join('\n');
const entries = (arr) => (arr || []).map((e) => `      <div class="entry-head" style="margin-top:1.6mm">
        <div class="entry-title">${esc(e.title)}</div>
        <div class="entry-role">${esc(e.role)}</div>
        <div class="entry-date">${esc(e.date)}</div>
      </div>
      <ul>
${bullets(e.bullets)}
      </ul>`).join('\n\n');
const skillLines = (arr) => (arr || []).map((line) => {
  const i = String(line).indexOf('：');
  return i > 0
    ? `        <p><strong>${esc(String(line).slice(0, i + 1))}</strong>${esc(String(line).slice(i + 1))}</p>`
    : `        <p>${esc(line)}</p>`;
}).join('\n');

// 注意：模板中的 {{DOC_ID}} 由 server /edit 在 serve 时注入，本函数不替换
// replaceAll + 函数替换：防止 LLM 输出含 $& 等模式时被 replace 特殊解释
export function buildDoc(root, data) {
  const tpl = assembleTemplate('classic');   // 主题唯一源装配（与数据根无关，永远来自 APP_ROOT）
  return tpl
    .replaceAll('{{NAME}}', () => esc(data.name))
    .replaceAll('{{CONTACT}}', () => esc(data.contact))
    .replaceAll('{{INTENT}}', () => esc(data.intent))
    .replaceAll('{{SUMMARY}}', () => esc(data.summary))
    .replaceAll('{{SKILLS}}', () => skillLines(data.skills))
    .replaceAll('{{WORK}}', () => entries(data.work))
    .replaceAll('{{PROJECTS}}', () => entries(data.projects))
    .replaceAll('{{EDU}}', () => entries(data.education));
}

// llmFn 可注入（测试用假函数）；真实路径调 llm.mjs 的 chat
export async function structureText(root, text, llmFn) {
  const call = llmFn || ((sys, user) => chat(root, sys, user));
  try {
    const raw = await call(SYS, text);
    const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const data = JSON.parse(cleaned);
    if (!data || typeof data !== 'object' || !('name' in data)) return null;
    return buildDoc(root, data);
  } catch {
    return null;  // 解析/调用失败 → 调用方降级
  }
}
