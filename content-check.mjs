// content-check.mjs — 确定性内容检查（S4a ⑪ 补课 · 批 2 ATS 诚实检查包）：纯规则、零 AI、零网络零落盘。
// 六类：①公司/项目名写法不一致 ②日期格式不统一或明显倒序 ③联系方式格式异常 ④链接格式错误
//      ⑤重复段落 ⑥未替换占位符；另「熟悉/精通」大量重复按路线图口径只作风格建议。
// 三级：需修复（fix）/ 建议核对（verify）/ 风格建议（style）。
// 单一通道：导出检查卡（/export 的导出检查分区）与审阅校验段（审阅 Tab 第三段）共用本模块的同一实现，
// 两侧数据同源（server.mjs 的 exportChecks → jobViewLive 与导出页都调本函数）。
// 诚实边界：只报「可由规则判定的事实」，不给 ATS 分数、不给录用概率、不猜「哪种写法才是对的」（写法不一致只提示核对）。
const LEVEL_LABEL = { fix: '需修复', verify: '建议核对', style: '风格建议' };

// ===== 文本工具 =====
const ENT = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const decodeEntities = (s) => String(s == null ? '' : s)
  .replace(/&(?:nbsp|lt|gt|quot|#39|apos);/gi, (m) => ENT[m.toLowerCase()] || ' ')
  .replace(/&amp;/gi, '&');
const stripTags = (s) => decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '))
  .replace(/[\s ]+/g, ' ').trim();
const toHalf = (s) => String(s == null ? '' : s)
  .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/　/g, ' ');
// 归一化比较用：去空白
const squash = (s) => String(s == null ? '' : s).replace(/[\s ]+/g, '');

// ===== 隐藏内容（编辑器隐藏的章节/条目）不参与检查：整段掩码（等长，位置不变）=====
function elementRange(s, openIdx, tag) {
  const re = new RegExp('<' + tag + '\\b[^>]*>|</' + tag + '\\s*>', 'gi');
  re.lastIndex = openIdx;
  let depth = 0, m;
  while ((m = re.exec(s))) {
    if (m[0][1] === '/') { depth--; if (depth <= 0) return m.index + m[0].length; }
    else depth++;
  }
  return -1;
}
function maskRanges(s, ranges) {
  if (!ranges || !ranges.length) return s;
  const chars = s.split('');
  for (const r of ranges) {
    if (!r) continue;
    for (let i = Math.max(0, r[0]); i < Math.min(chars.length, r[1]); i++) chars[i] = ' ';
  }
  return chars.join('');
}
function maskHidden(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  const hidden = [];
  const secRe = /<section\b[^>]*>/gi;
  let m;
  while ((m = secRe.exec(s))) {
    if (!/\bed-sec-hidden\b/.test(m[0])) continue;
    const end = elementRange(s, m.index, 'section');
    if (end > 0) hidden.push([m.index, end]);
  }
  const entRe = /<div\b[^>]*>/gi;
  while ((m = entRe.exec(s))) {
    if (!/\bed-entry-hidden\b/.test(m[0])) continue;
    const end = elementRange(s, m.index, 'div');
    if (end > 0) hidden.push([m.index, end]);
  }
  const ulRe = /<ul\b[^>]*>/gi;
  while ((m = ulRe.exec(s))) {
    if (!/\bed-entry-hidden\b/.test(m[0])) continue;
    const end = elementRange(s, m.index, 'ul');
    if (end > 0) hidden.push([m.index, end]);
  }
  return maskRanges(s, hidden);
}

// ===== 结构抽取（条目 / 段落 / 联系方式）=====
const HEAD_RE = /<div\b[^>]*class="[^"]*\bentry-head\b[^"]*"[^>]*>/gi;
const SEC_RE = /<div\b[^>]*class="[^"]*\bsection-title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
const fieldOf = (chunk, cls) => {
  const re = new RegExp('<div\\b[^>]*class="[^"]*\\b' + cls + '\\b[^"]*"[^>]*>([\\s\\S]*?)</div>', 'i');
  const m = chunk.match(re);
  return m ? stripTags(m[1]) : '';
};
function extract(html) {
  const masked = maskHidden(html);
  // 章节标题（按位置）
  const sections = [];
  let m;
  SEC_RE.lastIndex = 0;
  while ((m = SEC_RE.exec(masked))) sections.push({ pos: m.index, title: stripTags(m[1]) });
  const sectionAt = (pos) => {
    let t = '';
    for (const s of sections) { if (s.pos < pos) t = s.title; else break; }
    return t;
  };
  // 条目（entry-head 块）
  const heads = [];
  HEAD_RE.lastIndex = 0;
  while ((m = HEAD_RE.exec(masked))) heads.push({ start: m.index, end: m.index + m[0].length });
  const entries = heads.map((h, i) => {
    const chunk = masked.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : masked.length);
    return {
      title: fieldOf(chunk, 'entry-title'),
      role: fieldOf(chunk, 'entry-role'),
      date: fieldOf(chunk, 'entry-date'),
      section: sectionAt(h.start)
    };
  });
  // 段落（p / li）
  const paras = [];
  const paraRe = /<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((m = paraRe.exec(masked))) {
    const t = stripTags(m[2]);
    if (t) paras.push(t);
  }
  // 联系方式块
  const cm = masked.match(/<div\b[^>]*class="[^"]*\bcontact\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const contact = cm ? stripTags(cm[1]) : '';
  // 姓名（h1）
  const nm = masked.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const name = nm ? stripTags(nm[1]) : '';
  return { entries, paras, contact, name, sections: sections.map((s) => s.title) };
}

// ===== 名称核心（去公司后缀；只用于「同一主体」判定，不改用户原文）=====
const CORP_SUFFIX = /(股份有限公司|有限责任公司|有限公司|集团|公司|Inc\.?|Incorporated|Ltd\.?|Limited|LLC|Corp\.?|Corporation|Co\.?)$/i;
const coreName = (t) => squash(toHalf(t)).replace(CORP_SUFFIX, '');

// ===== 日期扫描（形状 + 区间）=====
function scanDates(text) {
  const s = String(text || '');
  const out = [];
  // 空白只收空格/制表（不跨行）：否则 token 会把换行吞进去，原文回显带脏换行
  const re = /(\d{4})[ \t]*([.\-/年])[ \t]*(\d{1,2})[ \t]*(月|日)?/g;
  let m;
  while ((m = re.exec(s))) {
    const y = +m[1], mo = +m[3], sep = m[2], unit = m[4] || '';
    if (y < 1970 || y > 2100 || mo < 1 || mo > 12) continue;   // 非法月/年 → 不认（正则已推进，继续扫）
    let end = m.index + m[0].length;
    let shape;
    if (sep === '年') shape = unit === '日' ? 'YYYY年M月D日' : 'YYYY年M月';
    else if (sep === '.') {
      const dd = s.slice(end).match(/^\.(\d{2})(?!\d)/);
      if (dd) { end += dd[0].length; shape = 'YYYY.MM.DD'; }
      else shape = 'YYYY.MM';
    } else if (sep === '/') shape = 'YYYY/MM';
    else shape = 'YYYY-MM';
    out.push({ start: m.index, end, ym: y * 12 + (mo - 1), shape, raw: s.slice(m.index, end).trim() });
  }
  const mre = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/gi;
  while ((m = mre.exec(s))) {
    const y = +m[2];
    if (y < 1970 || y > 2100) continue;
    out.push({ start: m.index, end: m.index + m[0].length, ym: y * 12, shape: 'Mon YYYY', raw: m[0] });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
const RANGE_SEP = /^[\s]*[-–—~～至到][\s]*$/;

// ===== 联系方式 =====
const EMAIL_OK = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const EMAIL_LABEL = /^(?:e-?mail|mail|邮箱|邮件|电邮)$/i;
const PHONE_LABEL = /^(?:电话|手机|手机号|联系电话|联系方式|tel|phone|mobile)$/i;
function phoneKind(t) {
  let d = String(t == null ? '' : t).replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2);
  if (/^1[3-9]\d{9}$/.test(d)) return 'mobile';
  if (/^0\d{2,3}\d{7,8}$/.test(d)) return 'landline';
  return null;
}

// ===== 链接 =====
const TLD = 'com|cn|net|org|io|dev|ai|co|me|info|xyz|tech|app|gov|edu|biz|site|top|shop|blog|cloud|vip|club|work|live|life|online|systems|solutions';

// ===== 归一化（重复段落比较用）=====
const normKey = (t) => String(t == null ? '' : t)
  .replace(/[\s ]+/g, '')
  .replace(/[，。、；：,.;:!！?？'"“”‘’（）()【】\[\]《》〈〉·・\-—_]/g, '');

// ===== 主函数 =====
export function contentChecks(html, opts = {}) {
  const items = [];
  const add = (level, key, text) => { if (text) items.push({ level, key, text, label: LEVEL_LABEL[level] }); };
  const ex = extract(html);
  const entries = ex.entries, paras = ex.paras;

  // 可见文本（结构化拼装，不含脚本/样式/隐藏内容）
  const parts = [];
  if (ex.name) parts.push(ex.name);
  if (ex.contact) parts.push(ex.contact);
  for (const p of paras) parts.push(p);
  for (const e of entries) { if (e.title) parts.push(e.title); if (e.role) parts.push(e.role); if (e.date) parts.push(e.date); }
  for (const s of ex.sections) parts.push(s);
  const fullText = parts.join('\n');

  // ===== ① 公司/项目名写法不一致 =====
  const nameGroups = new Map();
  for (const e of entries) {
    if (!e.title) continue;
    if (/教育/.test(e.section || '')) continue;   // 分类只管公司/项目名
    const core = coreName(e.title);
    if (!core) continue;
    const key = core.toLowerCase();
    if (!nameGroups.has(key)) nameGroups.set(key, []);
    nameGroups.get(key).push(e.title);
  }
  for (const list of nameGroups.values()) {
    const raws = [...new Set(list)];
    if (raws.length < 2) continue;
    const folded = new Set(raws.map((r) => squash(toHalf(r)).toLowerCase()));
    if (folded.size === 1) add('fix', 'name', `公司/项目名大小写或全半角不一致：「${raws[0]}」与「${raws[1]}」`);
    else add('verify', 'name', `公司/项目名写法不一致：「${raws[0]}」与「${raws[1]}」`);
  }

  // ===== ② 日期格式不统一 / 明显倒序 =====
  // 日期 token 一律在 fullText 坐标系里扫（条目日期字段与段落文本都在 fullText 内），偏移可直接用于遮蔽。
  const shapes = new Map();
  const dateRanges = [];
  const dateTokens = scanDates(fullText);
  {
    for (const tk of dateTokens) if (!shapes.has(tk.shape)) shapes.set(tk.shape, tk.raw);
    for (let i = 0; i + 1 < dateTokens.length; i++) {
      const between = fullText.slice(dateTokens[i].end, dateTokens[i + 1].start);
      if (!RANGE_SEP.test(between)) continue;
      dateRanges.push({ a: dateTokens[i], b: dateTokens[i + 1], raw: fullText.slice(dateTokens[i].start, dateTokens[i + 1].end).trim() });
    }
  }
  if (shapes.size >= 2) {
    const list = [...shapes.entries()].map(([shape, raw]) => `${raw}（${shape}）`).join('、');
    add('verify', 'date', `日期格式不统一：共 ${shapes.size} 种写法（${list}）`);
  }
  for (const r of dateRanges) {
    if (r.b.ym < r.a.ym) add('fix', 'date', `日期明显倒序：「${r.raw}」（结束早于开始）`);
  }

  // ===== ③ 联系方式格式异常（带标签的邮箱/电话）+ 疑似裸号码 =====
  // 标签与值必须同行（不跨行），否则「电话：」下一行的年份会被当成坏号码。
  // 电话值允许内部分隔符（空格/连字符/+）：「010-8888 6666」是合法写法，不能误报。
  const emailLabelRe = /(邮箱|邮件|电邮|e-?mail)[ \t]*[:：][ \t]*([^\s,，;；|｜、，。]+)/gi;
  const phoneLabelRe = /(联系电话|联系方式|手机号|电话|手机|tel|phone|mobile)[ \t]*[:：][ \t]*([ \t0-9+\-]+)/gi;
  const reserved = [];   // 已占用片段（标签值 + 日期 token）：裸号码/裸域名扫描时跳过
  const handleLabel = (label, value, lm) => {
    const vStart = lm.index + lm[0].indexOf(value);
    reserved.push([vStart, vStart + value.length]);
    if (EMAIL_LABEL.test(label)) {
      if (!EMAIL_OK.test(value)) add('fix', 'contact', `联系方式格式异常：邮箱「${value}」不是合法邮箱格式`);
    } else if (PHONE_LABEL.test(label)) {
      if (!phoneKind(value)) add('fix', 'contact', `联系方式格式异常：电话「${value}」不像手机号（11 位）或固定电话（0 区号 + 7-8 位）`);
    }
  };
  let lm;
  while ((lm = emailLabelRe.exec(fullText))) handleLabel(lm[1].trim(), lm[2].trim(), lm);
  while ((lm = phoneLabelRe.exec(fullText))) handleLabel(lm[1].trim(), lm[2].trim(), lm);
  for (const tk of dateTokens) reserved.push([tk.start, tk.end]);
  const inReserved = (a, b) => reserved.some((r) => a < r[1] && r[0] < b);
  const numRe = /\d[\d\s\-]{5,}\d/g;
  let nm2;
  while ((nm2 = numRe.exec(fullText))) {
    const digits = nm2[0].replace(/\D/g, '');
    if (digits.length < 7) continue;
    if (inReserved(nm2.index, nm2.index + nm2[0].length)) continue;
    if (phoneKind(nm2[0])) continue;
    add('verify', 'contact', `疑似联系方式格式异常：「${nm2[0].trim()}」不像手机号或固定电话`);
  }

  // ===== ④ 链接格式错误 / 缺协议头 =====
  const linkText = maskRanges(fullText, reserved);
  const schemeRe = /([A-Za-z][A-Za-z0-9+.\-]*):\/\/([^\s，。；、）)】」"'<>]+)/g;
  const schemeSpans = [];
  let um;
  while ((um = schemeRe.exec(linkText))) {
    const scheme = um[1].toLowerCase();
    const rest = um[2];
    schemeSpans.push([um.index, um.index + um[0].length]);
    if (scheme !== 'http' && scheme !== 'https') {
      add('fix', 'link', `链接格式错误：协议写成「${scheme}://」（应为 http:// 或 https://）`);
      continue;
    }
    const host = rest.split(/[/?#]/)[0];
    if (!host) { add('fix', 'link', `链接格式错误：缺少主机名「${um[0]}」`); continue; }
    if (!/\.[A-Za-z]{2,}$/.test(host)) add('fix', 'link', `链接格式错误：主机名不完整「${rest}」`);
  }
  const bareText = maskRanges(linkText, schemeSpans);
  const bareRe = new RegExp('(?<![\\w@.-])((?:www\\.)?(?:[A-Za-z0-9-]+\\.)+(?:' + TLD + ')(?:/[^\\s]*)?)', 'gi');
  let bm;
  while ((bm = bareRe.exec(bareText))) {
    if (inReserved(bm.index, bm.index + bm[0].length)) continue;
    add('verify', 'link', `链接缺协议头：「${bm[0]}」导出后不会成为可点链接`);
  }

  // ===== ⑤ 重复段落 =====
  const groups = new Map();
  for (const p of paras) {
    const k = normKey(p);
    if (k.length < 12) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    add('fix', 'dup', `重复段落：同一段文字出现 ${list.length} 次（「${list[0].slice(0, 24)}」）`);
  }

  // ===== ⑥ 未替换占位符 =====
  const braceRe = /\{\{[^{}]{1,60}\}\}/g;
  let br;
  const seenBrace = new Set();
  while ((br = braceRe.exec(fullText))) {
    if (seenBrace.has(br[0])) continue;
    seenBrace.add(br[0]);
    add('fix', 'placeholder', `未替换占位符：「${br[0]}」`);
  }
  const wordRe = /(TBD|TODO|FIXME|待补充|待填写|待完善|待填|[Xx]{3,})/g;
  let wr;
  const seenWord = new Set();
  while ((wr = wordRe.exec(fullText))) {
    if (seenWord.has(wr[0])) continue;
    seenWord.add(wr[0]);
    add('fix', 'placeholder', `未替换占位内容：「${wr[0]}」`);
  }
  const underRe = /_{3,}/g;
  let ur;
  while ((ur = underRe.exec(fullText))) add('fix', 'placeholder', `未替换占位内容：「${ur[0]}」`);

  // ===== ⑦ 「熟悉/精通」大量重复（仅风格建议）=====
  for (const w of ['熟悉', '精通']) {
    const n = (fullText.match(new RegExp(w, 'g')) || []).length;
    if (n >= 3) add('style', 'word', `「${w}」出现 ${n} 次，建议改成具体动作与场景`);
  }

  const byLevel = { fix: [], verify: [], style: [] };
  for (const it of items) (byLevel[it.level] || (byLevel[it.level] = [])).push(it);
  return {
    items,
    fix: byLevel.fix || [],
    verify: byLevel.verify || [],
    style: byLevel.style || [],
    counts: {
      fix: (byLevel.fix || []).length,
      verify: (byLevel.verify || []).length,
      style: (byLevel.style || []).length
    },
    stats: { entries: entries.length, paragraphs: paras.length }
  };
}
