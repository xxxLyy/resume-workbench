// site.mjs — 个人求职主页生成（UPCV 残余 #2）：母版简历 → 独立自包含 HTML 落 site/index.html
// 契约：产出物是给用户自行托管的公开页面（不放联系以外敏感字段、不挂本服务）；
//   内容只取母版真实文本——不编造头衔/数字；页面是「生成物」非文档，site/ 只进 .gitignore（可再生）。
import fs from 'node:fs';
import path from 'node:path';
import { docToLines, sectionsOf, decodeEntities } from './extract.mjs';
import { findMaster } from './talent.mjs';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripTags = (s) => decodeEntities(String(s || '').replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '')).replace(/\s+/g, ' ').trim();
const innerLines = (html) => docToLines(`<html><body>${html}</body></html>`, { includeHidden: false });

export function buildSiteHtml(root) {
  const master = findMaster(root);
  if (!master) return null;
  const html = fs.readFileSync(path.join(root, 'docs', master.id + '.html'), 'utf8');
  const lines = docToLines(html, { includeHidden: false });
  const name = lines[0] || master.title || '个人简历';
  const head5 = lines.slice(0, 6).join('\n');
  const phone = (head5.match(/1[3-9]\d{9}/) || [])[0] || '';
  const email = (head5.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0] || '';
  const intent = (lines.find((l) => /求职意向/.test(l)) || '').replace(/^求职意向[:：]?\s*/, '');
  const contact = [phone, email].filter(Boolean).join(' · ');
  const secs = sectionsOf(html).filter((s) => !s.hidden && s.title)
    .map((s) => ({ title: s.title, lines: innerLines(s.html) }))
    .filter((s) => s.lines.length);
  const at = new Date().toISOString();
  const body = secs.map((s) =>
    `<section><h2>${esc(s.title)}</h2>${s.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</section>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} · 个人求职主页</title>
<style>
:root{--ink:#1f2328;--mut:#656d76;--line:#d8dee4;--accent:#2f5d8a}
*{box-sizing:border-box}body{margin:0;font:15px/1.8 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--ink);background:#f6f7f9}
.wrap{max-width:760px;margin:0 auto;padding:48px 24px 80px}
.hero{border-bottom:2px solid var(--ink);padding-bottom:20px;margin-bottom:28px}
.hero h1{margin:0;font-size:32px;letter-spacing:.02em}
.hero .intent{margin:8px 0 0;color:var(--accent);font-weight:600}
.hero .contact{margin:6px 0 0;color:var(--mut);font-size:13px}
section{margin:0 0 26px}
h2{font-size:15px;color:var(--accent);margin:0 0 8px;letter-spacing:.06em;border-bottom:1px solid var(--line);padding-bottom:4px}
p{margin:0 0 6px}
footer{margin-top:40px;color:var(--mut);font-size:12px;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<header class="hero">
<h1>${esc(name)}</h1>
${intent ? `<p class="intent">${esc(intent)}</p>` : ''}
${contact ? `<p class="contact">${esc(contact)}</p>` : ''}
</header>
${body}
<footer>由本地「简历工作台」生成 · ${esc(at.slice(0, 10))}</footer>
</div>
</body>
</html>`;
}

// 落盘：site/index.html（0600，tmp+rename 同库惯例）；返回 {ok,path,chars,at}
export function generateSite(root) {
  const html = buildSiteHtml(root);
  if (!html) return { ok: false, error: '没有找到母版简历：先在首页完成一份母版' };
  const dir = path.join(root, 'site');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fp = path.join(dir, 'index.html');
  const tmp = fp + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, html, { mode: 0o600 });
  fs.renameSync(tmp, fp);
  return { ok: true, chars: html.length, at: new Date().toISOString() };
}
