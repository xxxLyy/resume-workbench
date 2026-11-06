// share-copy.mjs — 分享副本（S8 · 批 3 卡片 b3c5）：勾选隐藏字段 → 独立预览/PDF（不动原简历）
// 上位需求：dev-docs/2026-09-23-roadmap-magazine-and-features.md §S8；本批计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4。
// 本模块只管「纯变换 + 文本层校验 + 账本记录」；渲染编排与路由在 server.mjs（复用 renderDoc 冻结管线，
// 不经 renderCurrent —— 绝不写 docs/docs-meta、绝不触碰 pdfs/<id>.pdf）。
//
// 诚实边界：
//   ① 隐藏 = **物理删除**：勾选的字段内容从副本 HTML 里整段移除（姓名 = 删 <h1>；电话/邮箱 = 只在
//      联系方式块内摘除匹配串；章节类 = 整个 <section> 移除，标题一并）。副本文件里不存在隐藏载荷，
//      不是 display:none 那种「文件里还躺着、只是看不见」。
//   ② 导出前文本层校验（批 2 文本层能力复用：服务端 pdftotext + 去空白子串比对）：被隐藏字段的
//      原文只要在副本 PDF 文本层还出现（哪怕出现在正文别处）→ 整体拒绝导出（409），不落记录、
//      不落产物。工具不代改简历正文（那等于篡改内容）——残留只能由用户在原简历里处理。
//   ③ 导出记录（apply-profiles.json 的 shares 段，同表同事务纪律）只记事实：隐藏了哪些字段、来源
//      文档、字符量、产物路径。**不记任何字段值**（个人数据不进第二份文件）；「被哪些投递引用」
//      实时派生自 applications.json（app.shareId === 记录 id，权威来源，绝不存储）。
//   ④ 零网络、零模型调用、零 npm 依赖（只用 node 内置 + 既有模块）。
import path from 'node:path';
import { docToText, sectionsOf, bodyOf } from './extract.mjs';
import { FIELD_CATALOG, DERIVED_KEYS, SECTION_TITLES, updateApplyProfiles, sectionBodyText, deriveResumeFields } from './apply-profile.mjs';

// shareId 形状闸门：账本键与 URL 入参都是外部可编辑内容，不校验就能拼出数据根之外的路径（../ 穿越）。
// 实际生成 = 'sh-' + timestamp() + '-' + 随机 hex，天然匹配本形状；校验是给读路径兜底的。
export const SHARE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const err = (code, msg) => Object.assign(new Error(msg), { code });
const squash = (t) => String(t == null ? '' : t).replace(/\s+/g, '');
const labelOf = (key) => { const it = FIELD_CATALOG.find((f) => f.key === key); return it ? it.label : String(key); };

// 副本产物路径：pdfs/shares/<shareId>.pdf（与 pdfs/history、pdfs/archive 同属「派生产物子目录」惯例）。
export function sharePdfPath(root, shareId) {
  const id = String(shareId || '');
  if (!SHARE_ID_RE.test(id) || id.length > 80) throw err('SHARE_BAD_ID', '分享副本 id 形状非法：' + id.slice(0, 40));
  return path.join(root, 'pdfs', 'shares', id + '.pdf');
}

// ===== 联系方式匹配口径（与 apply-profile.mjs deriveResumeFields 的联系方式块口径同源；外加
// +86 前缀容忍 —— 摘除与残留预期用同一组正则，保证「删了什么」和「查什么」不会两套口径）=====
const EMAIL_RE_G = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE_G = /(?<!\d)(?:\+?86[- ]?)?(?:1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}|0\d{2,3}[-\s]?\d{3,4}[-\s]?\d{3,4})(?!\d)/g;
const CONTACT_RE = /<div\b[^>]*class="[^"]*\bcontact\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
const H1_RE = /<h1\b[^>]*>[\s\S]*?<\/h1>/i;

// ===== 隐藏变换：doc HTML → 副本 HTML（纯函数、零落盘）=====
// hiddenKeys 只认 DERIVED_KEYS（从简历派生的字段才有得隐藏；AI 文案/独立字段不在简历里，勾了也 400）。
// 章节匹配不分「编辑器隐藏态」——分享副本关心的是 PDF 里有没有这段内容（编辑器隐藏的章节仍会渲染进 PDF）。
export function hideFieldsInHtml(html, hiddenKeys) {
  let out = String(html == null ? '' : html);
  const keys = [...new Set((Array.isArray(hiddenKeys) ? hiddenKeys : []).filter((k) => DERIVED_KEYS.includes(k)))];
  const has = (k) => keys.includes(k);
  if (has('name')) out = out.replace(H1_RE, '');
  if (has('phone') || has('email')) {
    const cm = CONTACT_RE.exec(out);
    if (cm) {
      let inner = cm[1];
      if (has('phone')) inner = inner.replace(PHONE_RE_G, '');
      if (has('email')) inner = inner.replace(EMAIL_RE_G, '');
      // 只重写开标签与闭标签之间的内容（inner 不含 '</div>'，非贪婪保证）——
      // 不用 cm[0].replace(cm[1], …)：inner 里若有正则特殊字符或 $ 序列会被二次解释。
      const openEnd = cm.index + cm[0].length - cm[1].length - '</div>'.length;
      out = out.slice(0, openEnd) + inner + out.slice(openEnd + cm[1].length);
    }
  }
  const secKeys = keys.filter((k) => Array.isArray(SECTION_TITLES[k]));
  if (secKeys.length) {
    // sectionsOf 的 start/end 是 body 内偏移（bodyOf 无 <body> 时回退整份 HTML，indexOf 兜底定位）
    const bodyHtml = bodyOf(out);
    const base = out.indexOf(bodyHtml);
    if (base >= 0) {
      const secs = sectionsOf(out).filter((s) => s.title && secKeys.some((k) => (SECTION_TITLES[k] || []).includes(String(s.title || '').trim())));
      // 从后往前删：前面的偏移不受影响（start/end 加 base 换算回全文坐标）
      for (const s of secs.slice().sort((a, b) => b.start - a.start)) {
        const gs = base + s.start;
        const ge = base + s.end;
        if (gs < 0 || ge > out.length || gs >= ge) continue;
        out = out.slice(0, gs) + out.slice(ge);
      }
    }
  }
  return out;
}

// ===== 残留预期：从原简历正文挖「被隐藏字段在文本层不该再出现的原文」（纯函数、零落盘）=====
// 期望串来自全文（docToText），不只是联系方式块 —— 正文书了同一个电话/邮箱时照样算残留（fail-honest）。
// 章节类取章节正文（剥标题）压空后的前 60 字符：足以证明整段内容还在，又不至于把「标题词在别处出现」
// 这类巧合当成残留（如自评里写「工作经历丰富」不该挡住隐藏工作经历章节）。
export function shareExpectations(html, hiddenKeys) {
  const src = String(html == null ? '' : html);
  const keys = [...new Set((Array.isArray(hiddenKeys) ? hiddenKeys : []).filter((k) => DERIVED_KEYS.includes(k)))];
  const out = [];
  for (const k of keys) {
    if (k === 'name') {
      const m = H1_RE.exec(src);
      const t = m ? docToText(m[0]).trim() : '';
      if (t) out.push({ key: k, label: labelOf(k), needle: squash(t) });
      continue;
    }
    if (k === 'phone' || k === 'email') {
      const text = docToText(src);
      const re = k === 'phone' ? PHONE_RE_G : EMAIL_RE_G;
      const seen = new Set();
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        const v = squash(m[0]);
        if (v && !seen.has(v)) { seen.add(v); out.push({ key: k, label: labelOf(k), needle: v }); }
        if (re.lastIndex === m.index) re.lastIndex++;   // 零长匹配兜底（正则不会零长，防御性）
      }
      continue;
    }
    const titles = SECTION_TITLES[k] || [];
    const sec = sectionsOf(src).find((s) => titles.includes(String(s.title || '').trim()));
    const body = sec ? squash(sectionBodyText(sec.html)).slice(0, 60) : '';
    if (body) out.push({ key: k, label: labelOf(k), needle: body });
  }
  return out;
}

// ===== 文本层残留比对（批 2 能力复用：与导出页 layerCheck 同款去空白子串口径）=====
// 返回有残留的字段 [{key,label,count}]；空数组 = 校验通过（零残留）。
export function findResidues(layerText, expectations) {
  const layer = squash(layerText);
  const out = [];
  for (const e of Array.isArray(expectations) ? expectations : []) {
    if (!e || !e.needle) continue;
    const n = layer.split(e.needle).length - 1;
    if (n > 0) out.push({ key: e.key, label: e.label, count: n });
  }
  return out;
}

// ===== absent：勾选了但原简历里没有的字段（如实回报「未隐藏任何内容」，不假装隐藏了）=====
// 判据 = deriveResumeFields 的派生值为空 —— 与字段包取值同一份派生口径。
export function absentKeys(html, hiddenKeys) {
  const d = deriveResumeFields(html);
  return (Array.isArray(hiddenKeys) ? hiddenKeys : []).filter((k) => DERIVED_KEYS.includes(k) && !String(d[k] || '').trim());
}

// ===== 导出记录落账（shares 段，走 updateApplyProfiles 同一事务纪律）=====
// 记录只存事实（id/docId/hidden/时间/文件/字符量）；调用方负责先校验 docId/hidden 形状。
export function addShareRecord(root, rec) {
  const id = String((rec && rec.id) || '');
  if (!SHARE_ID_RE.test(id) || id.length > 80) throw err('SHARE_BAD_ID', '分享副本 id 形状非法');
  return updateApplyProfiles(root, (data) => {
    data.shares = (data.shares && typeof data.shares === 'object' && !Array.isArray(data.shares)) ? data.shares : {};
    data.shares[id] = {
      id,
      docId: String((rec && rec.docId) || ''),
      hidden: Array.isArray(rec && rec.hidden) ? rec.hidden.map(String) : [],
      createdAt: String((rec && rec.createdAt) || ''),
      file: String((rec && rec.file) || ''),
      chars: Number.isFinite(rec && rec.chars) ? rec.chars : 0,
    };
    return data;
  });
}
