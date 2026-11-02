// test-themes-blue-purge.mjs — B3T：themes 旧蓝清除（用户批准解冻 themes/ 的本次卡片）
// 背景：themes/resume-classic.css 的「编辑器（仅屏幕显示）」段残留冷色旧蓝
// （#409eff 家族含 rgba(64,158,255,·) 形态；另有 #4b5563 / #1f2937 / #2563eb+#dbeafe），
// 一直靠 editor-shell.js 注入层高特异性覆盖 + @media print 隐藏兜底。
// 本卡清除段内冷色；注入层既有覆盖与 print 兜底【保留不动】（冗余无害）。
// 合同（纯文本断言，只读仓库内两个文件，零服务零浏览器）：
//   1) 整个 themes 文件：#409eff 家族（hex 与 rgba 形态）与 #4b5563 / #1f2937 0 命中；
//   2) 冷色黑名单 0 命中（同 test-structure.sh S2-B1/B2 的 COLD 表——覆盖 #2563eb/#dbeafe 等
//      同段冷色残留；简历正文区本就无冷色，整文件扫描即整段扫描的超集）；
//   3) 「编辑器（仅屏幕显示）」段：不存在，或段内无 1)/2) 所列冷色（二选一即过）；
//   4) print 兜底行原样保留（与 test-structure.sh S2-A 的 grep -qF 同句）；
//   5) 注入层既有覆盖锚点保留（themes 残留形状规则——hover 虚线/通用焦点圈/caret/toast 几何——
//      的 recolor 配对必须在 editor-shell.js 里仍然在场，防止「删覆盖留形状」的半边删除）。
import fs from 'node:fs';

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const hits = (re, text) => text.split('\n')
  .map((ln, i) => (re.test(ln) ? `${i + 1}: ${ln.trim().slice(0, 100)}` : null))
  .filter(Boolean);

const css = fs.readFileSync('themes/resume-classic.css', 'utf8');

// 1) 卡片点名的旧蓝家族（#409eff 及其 rgba 派生 + 两个冷灰）——整文件 0 命中
const PURGE = /#409eff|rgba\(64,158,255\s*,|#4b5563|#1f2937/i;
const purgeHits = hits(PURGE, css);
if (purgeHits.length) fail(`themes/resume-classic.css 旧蓝家族残留 ${purgeHits.length} 行:\n  ` + purgeHits.join('\n  '));

// 2) 冷色黑名单（与 test-structure.sh S2-B1/B2 的 COLD 同表）——整文件 0 命中
const COLD = /#F4F5F8|#202737|#697186|#DCE0E8|#5B5DE8|#EEEFFE|#409eff|#2563eb|#dbeafe|#ede9fe|#5b21b6|--indigo|rgba\(37,50,75,|rgba\(41,48,80,|rgba\(24,27,48,|rgba\(32,39,55,/i;
const coldHits = hits(COLD, css);
if (coldHits.length) fail(`themes/resume-classic.css 冷色黑名单残留 ${coldHits.length} 行:\n  ` + coldHits.join('\n  '));

// 3) 「编辑器（仅屏幕显示）」段：不存在，或段内无冷色（卡片两种验收形态都收）
const MARK = '编辑器（仅屏幕显示';
const markAt = css.indexOf(MARK);
if (markAt < 0) {
  console.log('✅ B3T 「编辑器（仅屏幕显示）」段已不存在（整段清除形态）');
} else {
  const endAt = css.indexOf('@media print', markAt);
  const seg = endAt < 0 ? css.slice(markAt) : css.slice(markAt, endAt);
  const segHits = hits(PURGE, seg).concat(hits(COLD, seg));
  if (segHits.length) fail(`「编辑器（仅屏幕显示）」段内冷色残留 ${segHits.length} 行:\n  ` + segHits.join('\n  '));
  console.log('✅ B3T 「编辑器（仅屏幕显示）」段在但无冷色（段内清除形态）');
}

// 4) print 兜底原样保留（注入层运行时插入的工具栏/分页线/toast/恢复条在打印上下文的隐藏兜底）
const PRINT_LINE = '@media print { .edit-toolbar, .page-line, .toast, .recovery-bar { display: none !important; } }';
if (!css.includes(PRINT_LINE)) fail('print 兜底行被删改（B3T 要求保留不动）: ' + JSON.stringify(PRINT_LINE));

// 5) 注入层既有覆盖锚点（editor-shell.js）——themes 残留形状规则的 recolor/override 配对
const shell = fs.readFileSync('editor-shell.js', 'utf8');
const ANCHORS = [
  ['.ed-on .sheet p:hover,.ed-on .sheet li:hover,.ed-on .sheet h1:hover,.ed-on .sheet .entry-head:hover,.ed-on .sheet .contact:hover{outline-color:rgba(194,65,12,.45)}', 'hover 虚线轮廓 recolor'],
  ['.ed-on button:focus-visible,.ed-on input:focus-visible,.ed-on textarea:focus-visible,.ed-on a:focus-visible{outline-color:var(--ed-accent)}', '通用焦点圈 recolor'],
  ['.ed-on .edit-toolbar button.secondary{background:var(--ed-panel)', '.secondary 钮覆盖'],
  ['.ed-on .save-state[data-state="saving"]{color:var(--ed-accent-strong)', 'save-state saving 覆盖'],
  ['.ed-on .toast{background:var(--ed-ink)', 'toast 底色覆盖'],
  ['.ed-on .sheet{caret-color:var(--ed-accent)}', '.sheet caret recolor'],
];
for (const [frag, label] of ANCHORS) {
  if (!shell.includes(frag)) fail(`注入层覆盖锚点丢失（${label}）: ${frag.slice(0, 80)}…`);
}

console.log('✅ B3T themes 旧蓝清除：#409eff/#4b5563/#1f2937 家族 0 命中、冷色黑名单 0 命中、print 兜底与注入层覆盖锚点俱在');
