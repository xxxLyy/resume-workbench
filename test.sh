#!/bin/bash
# test.sh — 全隔离回归测试
# 纪律：独立数据根（RESUME_ROOT）+ 独立端口 + 虚拟配置 + 生成夹具 + 假渲染器 + 本地假 LLM。
# 全程不接触真实 docs/snapshots/pdfs/JSON/config；测试前后对真实数据做指纹比对。
# 需要 pdftotext（poppler）与 ffmpeg（RGB24 视觉门禁 tools/pixel-diff.mjs 的系统检查器）。
# 浏览器级保存语义见 test-editor.mjs（由本脚本按可用性调用）。
set -e
cd "$(dirname "$0")"
REAL_ROOT=$(pwd)
command -v pdftotext >/dev/null || { echo '需要 poppler: brew install poppler'; exit 1; }
command -v ffmpeg >/dev/null || { echo '需要 ffmpeg（视觉门禁不降级）: brew install ffmpeg'; exit 1; }

TEST_DIR=$(mktemp -d /tmp/resume-isolated-test.XXXXXX)
export RESUME_ROOT="$TEST_DIR/data"
export PORT=${PORT:-17899}
mkdir -p "$RESUME_ROOT/docs" "$RESUME_ROOT/snapshots" "$RESUME_ROOT/pdfs"

cleanup() {
  kill $SRV $LLM $JDSTUB 2>/dev/null || true
  kill ${SRV2:-} ${SRV3:-} 2>/dev/null || true
  # 按端口兜底清夹具服务：SRV2/SRV3 变量被后面夹具复用（附加f 与 T4-j），cleanup 只杀到最后一个，
  # 前面夹具的孤儿进程占住 17902/17903 会让下一次整跑「夹具服务启动失败」。只清测试端口，不碰断言。
  # lsof 双端口必须分开 -i（本机 lsof 4.91 对 `:a :b` 报 status error 退出非零 → 兜底曾整体失效）。
  lsof -ti :17902 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :17903 2>/dev/null | xargs kill 2>/dev/null || true
  rm -rf "$TEST_DIR"
  rm -f /tmp/resume-test-stub.log /tmp/resume-test-llm-last.json
}
trap cleanup EXIT

fail() { echo "❌ $1"; exit 1; }

# ===== 真实数据指纹（前后必须一致）=====
# 覆盖面（S1 扩面）：docs/*.html 内容、三个 JSON 内容、snapshots/ 与 pdfs/ 全文件列表+md5、
# backups/ 与 logs/ 目录列表（只列名不哈希：运行中服务的日志追加/备份属合法变化，不视为测试污染）、
# config.json 与 .chromium-choice.json 存在性+md5。输出仍为单行 md5。
# 注意：test-structure.sh 段 S1-0 用 sed 按 `^real_fp() {$` .. `^}$` 原样提取本函数做负向夹具，改签名/缩进需同步。
real_fp() {
  (cd "$REAL_ROOT" && {
    md5 -q docs/*.html 2>/dev/null || true
    cat applications.json materials.json docs-meta.json 2>/dev/null || true
    find snapshots pdfs -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\n' "$f" "$(md5 -q "$f" 2>/dev/null)"; done
    find backups logs 2>/dev/null | LC_ALL=C sort
    for f in config.json .chromium-choice.json; do
      if [ -f "$f" ]; then printf '%s %s\n' "$f" "$(md5 -q "$f")"; else echo "$f absent"; fi
    done
  } | md5)
}
REAL_BEFORE=$(real_fp)

# ===== 夹具：JSON + config（虚拟配置指向本地假 LLM）=====
echo '[]' > "$RESUME_ROOT/applications.json"
echo '[]' > "$RESUME_ROOT/materials.json"
echo '{}' > "$RESUME_ROOT/docs-meta.json"
cat > "$RESUME_ROOT/config.json" << 'EOF'
{"active":0,"profiles":[{"name":"stub","baseURL":"http://127.0.0.1:17900/v1","apiKey":"test-key","model":"stub-model"}]}
EOF

# ===== 假 PDF 生成器（真实可被 pdftotext 解析，文本层含 TESTPDF 标记）=====
cat > "$TEST_DIR/mkpdf.mjs" << 'EOF'
import fs from 'node:fs';
const src = process.argv[2] || 'x', out = process.argv[3] || 'out.pdf';
const tag = 'TESTPDF ' + String(src).split('/').pop().replace(/[^A-Za-z0-9._-]/g, '');
const content = `BT /F1 14 Tf 72 770 Td (${tag}) Tj ET`;
const objs = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
];
let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
fs.writeFileSync(out, pdf, 'latin1');
EOF

# ===== 假渲染器：成功后原子落盘；失败开关用控制文件（不重启服务即可切换）=====
# 注意：server 以 spawn(RESUME_RENDER_BIN, [render.mjs, ...args]) 调用，$1 是脚本路径，需 shift
cat > "$TEST_DIR/fake-render.sh" << EOF
#!/bin/bash
shift
[ -f "$TEST_DIR/render-fail" ] && exit 1
src=""; out=""
if [ "\$1" = "--src" ]; then src="\$2"; out="\$4"; else src="$RESUME_ROOT/docs/\$1.html"; out="$RESUME_ROOT/pdfs/\$1.pdf"; fi
mkdir -p "\$(dirname "\$out")"
exec node "$TEST_DIR/mkpdf.mjs" "\$src" "\$out"
EOF
chmod +x "$TEST_DIR/fake-render.sh"

# ===== 假 LLM（OpenAI 兼容）：固定回复 + 记录最后一次请求体供断言 =====
cat > "$TEST_DIR/stub-response.json" << 'EOF'
{"summary":"按JD定制","changes":[{"section":"个人总结","kind":"replace","before":"文本A","after":"文本A（定制版）","reason":"对齐JD关键词","source":"母版","level":"normal"},{"section":"项目经历","kind":"hide","entry":"老项目","before":"","after":"","reason":"与JD低相关","source":"JD","level":"important"}],"todos":[{"section":"项目经历","question":"缺少量化指标","why":"JD要求数据驱动"}]}
EOF
cat > "$TEST_DIR/llm-stub.mjs" << EOF
import http from 'node:http';
import fs from 'node:fs';
const reply = fs.readFileSync('$TEST_DIR/stub-response.json', 'utf8');
// 区域级 AI（S3-T5）：所有 AI 端点共用 /chat/completions，按 system 关键词分流；
// 最后请求体落盘供泄漏断言（区域文本最小化：只带本区域段落 + 有界全文摘要）。
const zoneAnalyze = JSON.stringify({ echoes: ['与项目经历呼应'], reminder: '注意量化指标', suggestion: '可以合并前两条', chips: ['这个区域和项目经历如何呼应？', '量化数据够吗？'] });
const zoneRewrite = JSON.stringify({ rewrites: [{ zid: 'zdeadbeef', candidate: '负责交易系统稳定性，P99 800ms' }] });
http.createServer((q, s) => {
  let b = '';
  q.on('data', (c) => b += c);
  q.on('end', () => {
    fs.writeFileSync('$TEST_DIR/llm-last.json', b.slice(0, 200000));
    fs.copyFileSync('$TEST_DIR/llm-last.json', '/tmp/resume-test-llm-last.json');
    // S4a-T4 控制文件（不重启服务即可切换）：llm-slow=延迟毫秒（占住 running 窗口）；llm-err=5xx（错误回调路径）
    const respond = () => {
      if (q.url.includes('/models')) { s.writeHead(200, { 'Content-Type': 'application/json' }); return s.end(JSON.stringify({ data: [{ id: 'stub-model' }] })); }
      let content = reply;
      try {
        const sys = JSON.parse(b).messages.find((m) => m.role === 'system').content;
        if (String(sys).includes('区域分析顾问')) content = zoneAnalyze;
        else if (String(sys).includes('区域改写器')) content = zoneRewrite;
        else if (String(sys).includes('简历定制编排器')) {
          // S4a-T8 控制文件：llm-changes-zone=局部重生成（从请求 zid 标注提取，zids[0] 由测试锁定）；llm-changes-add=全文生成含 add 候选
          if (String(sys).includes('局部重生成') && fs.existsSync('$TEST_DIR/llm-changes-zone')) {
            const u = JSON.parse(b).messages.find((m) => m.role === 'user').content;
            const zids = [];
            String(u).replace(/（zid：(z[0-9a-f]{8})）/g, function (_, x) { if (zids.indexOf(x) < 0) zids.push(x); return _; });
            content = JSON.stringify({ summary: '局部重生成', changes: [
              { section: '工作经历', kind: 'replace', zid: zids[0], before: '目标一（before 与正文无关，zid 提示优先）', after: '工作段一（锁定探测，不该落 pending）', reason: '越权目标', source: 'JD', level: 'normal' },
              { section: '工作经历', kind: 'replace', zid: zids[1], before: '目标二（before 与正文无关，zid 提示优先）', after: '工作段二（定制版 T8）', reason: '对齐JD', source: '母版', level: 'normal' }
            ], todos: [] });
          } else if (fs.existsSync('$TEST_DIR/llm-changes-add')) {
            content = JSON.stringify({ summary: '全文生成含新增', changes: [
              { section: '工作经历', kind: 'add', after: '新增条目内容（T8 全文）', reason: '补充相关经历', source: '母版', level: 'normal' }
            ], todos: [] });
          }
          // 无控制文件 → content 保持默认 reply，既有测试零影响
        }
        else if (String(sys).includes('证据分析')) {
          // S4a-T7 控制文件（保护门用例）：llm-ev-raw=非 JSON 文本；llm-ev-bad=合法 JSON 但 refId 全部无法匹配
          if (fs.existsSync('$TEST_DIR/llm-ev-raw')) { content = '抱歉，我无法以 JSON 格式输出该证据表。'; }
          else if (fs.existsSync('$TEST_DIR/llm-ev-bad')) {
            content = JSON.stringify({ evidence: [
              { req: '要求一：全无效素材引用', status: 'sourced', refHints: [{ type: 'mat', id: 'm-ghost99', title: '幽灵素材', quote: 'x' }] },
              { req: '要求二：全无效段落引用', status: 'covered', refHints: [{ type: 'para', zid: 'zdeadbee', title: '幽灵段落', quote: 'y' }] }
            ] });
          } else {
          // S4a-T6：从请求正文动态提取请求内 ID（matId/zid）——验证「refHints 按 ID 原样返回与解析」，
          // 同时返回幽灵 ID 与空 refHints 各一条，覆盖解析层的丢弃与降级路径。
          const u = JSON.parse(b).messages.find((m) => m.role === 'user').content;
          const matIds = [];
          String(u).replace(/（id：([^）]+)）/g, function (_, x) { matIds.push(x); return _; });
          const zids = [];
          String(u).replace(/（zid：(z[0-9a-f]{8})）/g, function (_, x) { if (zids.indexOf(x) < 0) zids.push(x); return _; });
          content = JSON.stringify({ evidence: [
            { req: '要求一：后端服务经验', status: 'covered', refHints: [{ type: 'para', zid: zids[0] || 'zdeadbee', title: '工作经历', quote: '负责交易系统' }] },
            { req: '要求二：订单系统拆分', status: 'sourced', refHints: [{ type: 'mat', id: matIds[0] || 'm-none00', title: '素材甲', quote: '主导订单系统拆分' }] },
            { req: '要求三：全部无效引用', status: 'covered', refHints: [{ type: 'mat', id: 'm-ghost00', title: '幽灵素材', quote: 'x' }, { type: 'para', zid: 'zdeadbee', title: '幽灵段落', quote: 'y' }] },
            { req: '要求四：无引用', status: 'covered', refHints: [] }
          ] });
          }
        }
      } catch {}
      if (fs.existsSync('$TEST_DIR/llm-err')) { s.writeHead(500, { 'Content-Type': 'text/plain' }); return s.end('stub forced error'); }
      s.writeHead(200, { 'Content-Type': 'application/json' });
      s.end(JSON.stringify({ choices: [{ message: { content } }] }));
    };
    let slow = 0;
    try { if (fs.existsSync('$TEST_DIR/llm-slow')) slow = Number(fs.readFileSync('$TEST_DIR/llm-slow', 'utf8')) || 0; } catch {}
    if (slow > 0) return setTimeout(respond, slow);
    respond();
  });
}).listen(17900, '127.0.0.1');
EOF
node "$TEST_DIR/llm-stub.mjs" > /dev/null 2>&1 & LLM=$!

# ===== 启动被测服务（假渲染器注入）=====
RESUME_RENDER_BIN="$TEST_DIR/fake-render.sh" node server.mjs > /tmp/resume-test-stub.log 2>&1 & SRV=$!
trap cleanup EXIT
sleep 0.6
kill -0 $SRV 2>/dev/null || fail "server 启动失败（端口 $PORT？）"
B="http://localhost:$PORT"
curl --retry 5 --retry-delay 0 --retry-connrefused -sf "$B/" -o /dev/null || fail "服务不可达"

# ===== 1. 首页与文档创建 =====
curl -sf "$B/" | grep -q '简历工作台' || fail '首页缺标题'
curl -sf "$B/" | grep -q '针对岗位生成简历' || fail '首页缺岗位生成入口'
curl -sf "$B/" | grep -q 'BENTO-V1' || fail '首页缺设计系统'
echo '✅ 首页（岗位生成入口 + 设计系统）'
NEWLOC=$(curl -s -X POST "$B/new" -o /dev/null -w '%{redirect_url}')
DOCID=$(echo "$NEWLOC" | sed 's/.*id=//')
[ -n "$DOCID" ] && [ -f "$RESUME_ROOT/docs/$DOCID.html" ] || fail '/new 未建文档'
curl -sf "$B/edit?id=$DOCID" | grep -q 'contenteditable' || fail '编辑器不可编辑'
curl -sf "$B/edit?id=$DOCID" | grep -q 'editor-shell.js' || fail '缺外壳注入'
curl -sf "$B/edit?id=$DOCID" | grep -q 'job-panel.js' || fail '缺审阅面板注入'
CNT=$(curl -sf "$B/edit?id=$DOCID" | grep -o 'SHELL-INJECT' | wc -l | tr -d ' ')
[ "$CNT" = "2" ] || fail "外壳注入非幂等（${CNT}）"
curl -sf "$B/edit?id=$DOCID" | grep -q '__MATS__' || fail '缺素材数据注入'
curl -sf "$B/" | grep -q "/edit?id=$DOCID" || fail '新文档未出现在首页列表'
curl -sf "$B/" | grep -q 'class="card doc-card"' || fail '首页缺文档卡片'
echo "✅ 新建文档与编辑器注入幂等（${DOCID}）"

# S2-T3: 首页结构（hero / 一行状态摘要 / 折叠岗位表单 / 继续上次任务）
# 放在文档创建之后：无文档时 hero 渲染「新建第一份简历」空态，continueBtn/data-doc-ids 不存在（回退链契约如此）
HOME_HTML=$(curl -s "$B/")
echo "$HOME_HTML" | grep -qF '<h1 class="hero-title">简历工作台</h1>' || fail '首页缺 hero 标题'
echo "$HOME_HTML" | grep -qF 'id="continueBtn"' || fail '首页缺「继续上次任务」入口'
echo "$HOME_HTML" | grep -qF 'data-doc-ids=' || fail '继续按钮缺 data-doc-ids（回退链无依据）'
echo "$HOME_HTML" | grep -qF '<details class="card" id="jobCard"' || fail '岗位表单未收进 <details> 折叠'
echo "$HOME_HTML" | grep -qF 'id="jobCompany"' || fail '岗位表单公司字段丢失（业务契约破坏）'
echo "$HOME_HTML" | grep -qF 'id="jobJd"' || fail '岗位表单 JD 字段丢失'
echo "$HOME_HTML" | grep -qF 'id="jobForm"' || fail '岗位表单 id 丢失（既有脚本依赖）'
[ "$(printf '%s' "$HOME_HTML" | grep -cF 'class="card statusline"')" = "1" ] || fail '状态摘要应为一行（0 处或多处）'
echo "$HOME_HTML" | grep -qF 'hero-art' || fail '缺插画位'
echo "$HOME_HTML" | grep -qF '<svg' || fail '插画未内联为 SVG（禁止外链）'
if printf '%s' "$HOME_HTML" | grep -qE 'https?://[^"'"'"']*\.(png|jpg|jpeg|svg)'; then fail '首页出现外链图片'; fi
echo '✅ S2-T3 首页结构（hero/折叠岗位表单/一行状态摘要/继续上次任务）'

# S4a-T1b F1: 首页 PDF 单摘要 chip 三态（已同步/较旧/未生成，零项省略）；空列表隐藏 chip；独立「份 PDF 较旧」行撤除
# 夹具 = 当前唯一文档 DOCID，走 未生成→最新→较旧→归档筛选→空列表 全周期；结尾还原内容与归档态。
HOME_HTML=$(curl -s "$B/")
echo "$HOME_HTML" | grep -qF '📑 PDF 未生成 1' || fail "F1 未生成口径: $(printf '%s' "$HOME_HTML" | grep -oE '📑 PDF[^<]*' | head -1)"
echo "$HOME_HTML" | grep -qF 'PDF 全部同步' && fail 'F1 存在未生成文档却显示「全部同步」'
curl -s -X POST "$B/render?id=$DOCID" | grep -q '"ok":true' || fail 'F1 渲染夹具失败'
HOME_HTML=$(curl -s "$B/")
echo "$HOME_HTML" | grep -qF '📑 PDF 全部同步' || fail "F1 全同步应显示「全部同步」: $(echo "$HOME_HTML" | grep -oE '📑 PDF[^<]*' | head -1)"
# 较旧：保存新内容但不渲染 → 单 chip 含「较旧 1」段，独立较旧行不再出现
curl -s -X POST "$B/save?id=$DOCID" --data-binary "$(sed 's/点击开始编辑…/F1-STALE-MARKER/' "$RESUME_ROOT/docs/$DOCID.html")" | grep -q '"ok":true' || fail 'F1 较旧夹具保存失败'
HOME_HTML=$(curl -s "$B")
CHIP=$(printf '%s' "$HOME_HTML" | grep -oE '📑 PDF[^<]*' | head -1)
[ "$CHIP" = '📑 PDF 较旧 1' ] || fail "F1 较旧口径（零项省略后应恰为「较旧 1」）: $CHIP"
printf '%s' "$HOME_HTML" | grep -qF '份 PDF 较旧，导出时重渲' && fail 'F1 独立较旧行应已撤除'
# 归档筛选 + 空列表：归档唯一文档后默认视图为空 → chip 不显示；?archived=1 → 分母含归档文档
curl -s -X POST "$B/archive" -H 'Content-Type: application/json' -d "{\"id\":\"$DOCID\",\"archived\":true}" | grep -q '"ok":true' || fail 'F1 归档夹具失败'
HOME_HTML=$(curl -s "$B/")
if echo "$HOME_HTML" | grep -qF '📑 PDF'; then fail 'F1 空列表不应显示 PDF chip'; fi
ARCH_HTML=$(curl -s "$B/?archived=1")
ARCH_CHIP=$(printf '%s' "$ARCH_HTML" | grep -oE '📑 PDF[^<]*' | head -1)
[ "$ARCH_CHIP" = '📑 PDF 较旧 1' ] || fail "F1 归档筛选分母应含归档文档: $ARCH_CHIP"
# 还原夹具：取消归档 + 内容还原（还原后 renderInputId 与渲染基线一致 → fresh，与卡片徽章口径自洽）
curl -s -X POST "$B/archive" -H 'Content-Type: application/json' -d "{\"id\":\"$DOCID\",\"archived\":false}" -o /dev/null
curl -s -X POST "$B/save?id=$DOCID" --data-binary "$(sed 's/F1-STALE-MARKER/点击开始编辑…/' "$RESUME_ROOT/docs/$DOCID.html")" | grep -q '"ok":true' || fail 'F1 夹具内容还原失败'
echo '✅ F1 首页 PDF 状态口径（fresh 数/分母 infos/空列表不显示）'

# S2-T3 修复轮1：撇号标题回归 —— data-doc-titles 单引号属性不得被 ' 截断，内联脚本不得抛未捕获异常
# 夹具为假数据（Jane's Resume）；块末删除夹具，后续段落看到的文档集合与本块之前一致。
cat > "$TEST_DIR/apos-attr-check.cjs" << 'EOF'
// 按浏览器口径校验：单引号属性值 = 开引号到下一个单引号，随后实体解码，再 JSON.parse。
// 并把承载回退链的内联 <script> 放进最小 DOM 桩真跑一遍 —— 抛未捕获异常即失败。
// 零依赖（不引 jsdom、不起浏览器）。输入 = 隔离根上被测服务自己渲染的首页（假夹具，非不可信输入）。
'use strict';
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8'), fid = process.argv[3];
const die = (m) => { console.error('   ❌ ' + m); process.exit(1); };
// 实体解码顺序：&amp; 必须最后，否则 &amp;#39; 会被二次解码成 '
const decode = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
// 引号感知取出某 id 所在开始标签原文（引号内的 > 不结束标签 —— 与 HTML 解析器同口径）
function tagOf(idv) {
  const at = html.indexOf('id="' + idv + '"');
  if (at < 0) return null;
  let i = at, q = null;
  for (; i < html.length; i++) {
    const c = html[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '>') break;
  }
  return html.slice(html.lastIndexOf('<', at), i + 1);
}
// 引号感知属性扫描：单引号属性在下一个 ' 处结束（这正是本缺陷的截断点）
function attrsOf(tag) {
  const out = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    out[m[1]] = decode(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}
const btnTag = tagOf('continueBtn');
if (!btnTag) die('首页缺 id="continueBtn"（撇号夹具应使 hero 走非空态）');
const btnAttrs = attrsOf(btnTag);
for (const n of ['data-doc-ids', 'data-doc-titles', 'data-fallback']) {
  if (!(n in btnAttrs)) die('继续按钮缺 ' + n);
}
// (a) 属性端到端可解析
let ids, titles;
try { ids = JSON.parse(btnAttrs['data-doc-ids']); } catch (e) {
  die('data-doc-ids 按浏览器口径解析失败：' + e.message + '\n      属性值=' + JSON.stringify(btnAttrs['data-doc-ids']));
}
try { titles = JSON.parse(btnAttrs['data-doc-titles']); } catch (e) {
  die('data-doc-titles 按浏览器口径解析失败：' + e.message + '\n      属性值=' + JSON.stringify(btnAttrs['data-doc-titles']));
}
if (!Array.isArray(ids) || ids.indexOf(fid) < 0) die('data-doc-ids 未含夹具 id：' + JSON.stringify(ids));
if (!titles || typeof titles !== 'object') die('data-doc-titles 不是对象：' + JSON.stringify(titles));
if (titles[fid] !== "Jane's Resume") die('撇号标题未端到端还原：' + JSON.stringify(titles[fid]));
// (b) 内联脚本真跑（最小 DOM 桩）
const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const target = scripts.filter((s) => s.includes('continueBtn')).pop();
if (!target) die('未找到承载「继续上次任务」回退链的内联脚本');
const els = new Map();
function makeEl(idv) {
  const t = tagOf(idv), a = t ? attrsOf(t) : {};
  return {
    id: idv, style: {}, open: false, value: '', files: [], textContent: '', innerHTML: '',
    href: a.href || '', _a: a,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._a, n) ? this._a[n] : null; },
    setAttribute(n, v) { this._a[n] = String(v); },
    removeAttribute(n) { delete this._a[n]; },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, focus() {},
    contains() { return false; }
  };
}
const sandbox = {
  document: {
    getElementById(idv) { if (!els.has(idv)) els.set(idv, makeEl(idv)); return els.get(idv); },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return makeEl('__created__'); }
  },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  window: {}, location: { href: '' },
  fetch() { return Promise.resolve({ json() { return Promise.resolve(null); }, text() { return Promise.resolve(''); } }); },
  confirm() { return false; }, alert() {}, encodeURIComponent, JSON, console
};
try {
  new Function(...Object.keys(sandbox), target)(...Object.values(sandbox));
} catch (e) {
  die('首页内联脚本抛出未捕获异常 → ' + (e && e.name) + ': ' + (e && e.message));
}
const btn = els.get('continueBtn');
if (!btn) die('内联脚本未触达 continueBtn');
if (btn.style.display === 'none') die('属性可解析却把继续按钮隐藏了（回退链未生效）');
const fb = btn.getAttribute('data-fallback') || '';
if (!btn.textContent.includes(titles[fb] || fb)) {
  die('回退链未改写按钮文案（个性化未生效）：' + JSON.stringify(btn.textContent));
}
console.log('   ↳ data-doc-titles 解析成功（' + Object.keys(titles).length + ' 项，撇号原样）；按钮文案=' + JSON.stringify(btn.textContent));
EOF
APOS_ID=$(curl -s -X POST "$B/new" -o /dev/null -w '%{redirect_url}' | sed 's/.*id=//')
[ -n "$APOS_ID" ] && [ -f "$RESUME_ROOT/docs/$APOS_ID.html" ] || fail '撇号标题夹具未建成'
curl -s -X POST "$B/save?id=$APOS_ID" --data-binary "$(sed "s|<h1>未命名</h1>|<h1>Jane's Resume</h1>|" "$RESUME_ROOT/docs/$APOS_ID.html")" | grep -q '"ok":true' || fail '撇号标题夹具保存失败'
grep -qF "Jane's Resume</h1>" "$RESUME_ROOT/docs/$APOS_ID.html" || fail '撇号标题未落盘'
curl -s "$B/" > "$TEST_DIR/home-apos.html"
node "$TEST_DIR/apos-attr-check.cjs" "$TEST_DIR/home-apos.html" "$APOS_ID" || fail "撇号标题（${APOS_ID}）使 data-doc-titles 属性截断或内联脚本抛异常"
curl -s -X POST "$B/delete?id=$APOS_ID" -o /dev/null
[ -f "$RESUME_ROOT/docs/$APOS_ID.html" ] && fail '撇号标题夹具未清理（污染后续段落）'
echo "✅ S2-T3 修复轮1 撇号标题（data-doc-titles 属性完整 + 内联脚本不抛）"

# 写入基线内容
curl -s -X POST "$B/save?id=$DOCID" --data-binary "$(sed 's/点击开始编辑…/文本A/' "$RESUME_ROOT/docs/$DOCID.html")" | grep -q '"ok":true' || fail '基线保存失败'
grep -q '文本A' "$RESUME_ROOT/docs/$DOCID.html" || fail '基线未落盘'
echo '✅ 保存落盘'

# ===== 2. 保存边界：空正文/空白拒绝；autosave 免快照；手动打快照 =====
CODE=$(curl -s -X POST "$B/save?id=$DOCID" --data-binary '' -o /dev/null -w '%{http_code}')
[ "$CODE" = "400" ] || fail "空正文未拦截（${CODE}）"
CODE=$(curl -s -X POST "$B/save?id=$DOCID" --data-binary '   ' -o /dev/null -w '%{http_code}')
[ "$CODE" = "400" ] || fail "空白未拦截（${CODE}）"
# 快照计数只数冻结 html（*.html）；manifest（*.manifest.json）为伴生记录，不计入"快照数"
snap_count() { find "$RESUME_ROOT/snapshots/$DOCID" -maxdepth 1 -name '*.html' 2>/dev/null | wc -l | tr -d ' '; }
N0=$(snap_count)
curl -s -X POST "$B/save?id=$DOCID&autosave=1" --data-binary "$(cat "$RESUME_ROOT/docs/$DOCID.html")" -o /dev/null
N1=$(snap_count)
[ "$N1" = "$N0" ] || fail "autosave 打了快照（$N0→${N1}）"
curl -s -X POST "$B/save?id=$DOCID" --data-binary "$(cat "$RESUME_ROOT/docs/$DOCID.html")" -o /dev/null
N2=$(snap_count)
[ "$N2" = "$((N1+1))" ] || fail "手动保存未打快照（$N1→${N2}）"
echo '✅ 保存边界 + 快照策略'

# ===== 3. 多标签冲突：baseMtime 落后 → 409；force 覆盖放行 =====
MT=$(node -e "console.log(require('fs').statSync('$RESUME_ROOT/docs/$DOCID.html').mtimeMs)")
CODE=$(curl -s -X POST "$B/save?id=$DOCID&baseMtime=1" --data-binary "$(cat "$RESUME_ROOT/docs/$DOCID.html" | sed 's/文本A/文本B/')" -o /dev/null -w '%{http_code}')
[ "$CODE" = "409" ] || fail "旧修订保存未被拦（${CODE}）"
grep -q '文本B' "$RESUME_ROOT/docs/$DOCID.html" && fail '冲突时仍写入了磁盘'
R=$(curl -s -X POST "$B/save?id=$DOCID&baseMtime=$MT&force=1" --data-binary "$(cat "$RESUME_ROOT/docs/$DOCID.html" | sed 's/文本A/文本B/')")
echo "$R" | grep -q '"ok":true' || fail "force 覆盖失败: $R"
grep -q '文本B' "$RESUME_ROOT/docs/$DOCID.html" || fail 'force 覆盖未落盘'
echo '✅ 多标签冲突检测（409 + force 覆盖）'

# ===== 4. 正文与 PDF 分离：save 不渲染，POST /render 才渲染 =====
rm -f "$RESUME_ROOT/pdfs/$DOCID.pdf"
curl -s -X POST "$B/save?id=$DOCID" --data-binary "$(cat "$RESUME_ROOT/docs/$DOCID.html")" -o /dev/null
[ -f "$RESUME_ROOT/pdfs/$DOCID.pdf" ] && fail 'save 触发了 PDF 渲染（应分离）'
curl -s -X POST "$B/render?id=$DOCID" | grep -q '"ok":true' || fail '/render 失败'
[ -f "$RESUME_ROOT/pdfs/$DOCID.pdf" ] || fail '/render 未生成 PDF'
pdftotext "$RESUME_ROOT/pdfs/$DOCID.pdf" - | grep -q 'TESTPDF' || fail 'PDF 文本层缺失'
echo '✅ 正文保存与 PDF 生成分离（/render 显式渲染）'

# ===== 5. 渲染失败：不冒充成功；/export 明确报错且不出现"已重新生成" =====
touch "$TEST_DIR/render-fail"
R=$(curl -s -X POST "$B/render?id=$DOCID")
echo "$R" | grep -q '"ok":false' || fail '渲染失败仍报成功'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/render?id=$DOCID")
[ "$CODE" = "500" ] || fail "渲染失败应 500（${CODE}）"
# 改正文内容（渲染标识变化 → staleInfo 判 stale；mtime 不作正确性依据）→ 导出页会尝试重渲并失败
node -e "const fs=require('fs');const f='$RESUME_ROOT/docs/$DOCID.html';fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('文本B','文本B-导出失败夹具'))"
EXPORT=$(curl -sf "$B/export?id=$DOCID")
echo "$EXPORT" | grep -q '重新生成失败' || fail 'export 页未显示失败原因'
echo "$EXPORT" | grep -q '已为你重新生成' && fail 'export 页出现旧版成功文案'
echo "$EXPORT" | grep -q '旧版本 PDF' || fail 'export 页未标注旧版 PDF'
rm -f "$TEST_DIR/render-fail"
# 还原正文后成功重渲（标识回到原值，后续段仍以 文本B 口径断言）
node -e "const fs=require('fs');const f='$RESUME_ROOT/docs/$DOCID.html';fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace('文本B-导出失败夹具','文本B'))"
curl -s -X POST "$B/render?id=$DOCID" -o /dev/null
echo '✅ 渲染失败不冒充成功'

# ===== 6. 统一正文提取：排除工具条/占位符/隐藏内容 =====
POL=$(node -e "
const fs=require('fs');
let h=fs.readFileSync('$RESUME_ROOT/docs/$DOCID.html','utf8');
h=h.replace(/<p class=\"summary\"[^>]*>文本B<\/p>/,'<p class=\"summary\">文本B</p><section class=\"section ed-sec-hidden\"><div class=\"section-title\">隐藏节</div><p>隐藏内容XYZ</p></section>');
fs.writeFileSync('$RESUME_ROOT/docs/$DOCID.html',h);
")
TXT=$(curl -s "$B/api/extract?id=$DOCID")
echo "$TXT" | grep -q '隐藏内容XYZ' && fail '默认提取包含隐藏内容'
echo "$TXT" | grep -q '导出 PDF' && fail '提取包含工具栏文案'
echo "$TXT" | grep -q '{{' && fail '提取包含模板占位符'
curl -s "$B/api/extract?id=$DOCID&hidden=1" | grep -q '隐藏内容XYZ' || fail 'hidden=1 未包含隐藏内容'
echo '✅ 正文提取统一出口（工具条/占位符/隐藏内容隔离）'

# ===== 7. 素材确认流：新增默认待确认，确认后才参与生成 =====
MATID=$(curl -s -X POST "$B/mat/add" -H 'Content-Type: application/json' -d '{"title":"素材甲","brief":"主导订单系统拆分","tags":["后端"]}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
[ -n "$MATID" ] || fail '素材新增失败'
curl -sf "$B/materials" | grep -q '待确认' || fail '新素材未标待确认'
curl -s -X POST "$B/mat/confirm" -H 'Content-Type: application/json' -d "{\"ids\":[\"$MATID\"],\"confirmed\":true}" | grep -q '"confirmed":1' || fail '批量确认失败'
curl -sf "$B/materials" | grep -q '已确认' || fail '确认后未显示已确认'
UNCONF=$(curl -s -X POST "$B/mat/add" -H 'Content-Type: application/json' -d '{"title":"素材乙-未确认","brief":"不应参与生成"}' | sed 's/.*"id":"\([^"]*\)".*/\1/')
echo '✅ 素材确认状态'

# ===== 8. 岗位草稿：独立文档、不依赖模型、同岗位幂等、母版不动 =====
MOTHER_MD5=$(md5 -q "$RESUME_ROOT/docs/$DOCID.html")
JOBLOC=$(curl -s -X POST "$B/job/create" -H 'Content-Type: application/json' -d "{\"from\":\"$DOCID\",\"company\":\"测试公司\",\"role\":\"后端工程师\",\"jd\":\"负责 Node 服务与数据链路\",\"materials\":[\"$MATID\"]}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id||'')}catch{console.log('')}})")
[ -n "$JOBLOC" ] || fail '岗位草稿创建失败'
[ -f "$RESUME_ROOT/docs/$JOBLOC.html" ] || fail '岗位草稿文件不存在'
[ "$(md5 -q "$RESUME_ROOT/docs/$DOCID.html")" = "$MOTHER_MD5" ] || fail '创建岗位草稿改动了母版'
grep -q '"parent":"'$DOCID'"' "$RESUME_ROOT/docs-meta.json" || fail 'meta 缺 parent'
grep -q '"company":"测试公司"' "$RESUME_ROOT/docs-meta.json" || fail 'meta 缺 company'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/create" -H 'Content-Type: application/json' -d "{\"from\":\"$DOCID\",\"company\":\"测试公司\",\"role\":\"后端工程师\"}")
[ "$CODE" = "409" ] || fail "重复岗位草稿未拦截（${CODE}）"
ls "$RESUME_ROOT/snapshots/$DOCID"/*.html >/dev/null 2>&1 || fail '创建时未冻结来源快照'
echo "✅ 岗位草稿独立创建（${JOBLOC}）"

# ===== 8b. S4a-T5 要求卡：create brief 落 meta / 无 brief 默认值 / 校验 / /job/brief 往返 / 旧草稿兼容 =====
BRIEF0=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const b=(m[process.argv[2]].job||{}).brief;console.log(b?JSON.stringify(b):"")' "$RESUME_ROOT/docs-meta.json" "$JOBLOC")
[ "$BRIEF0" = '{"focus":[],"keepProjects":[],"deemphasize":[],"degree":"refocus","pages":2,"preset":null}' ] || fail "S4a-T5 无 brief 创建应落渐进默认值: $BRIEF0"
BRIEFJOB=$(curl -s -X POST "$B/job/create" -H 'Content-Type: application/json' -d "{\"from\":\"$DOCID\",\"company\":\"要求卡公司\",\"role\":\"前端工程师\",\"jd\":\"S4a-T5 验证\",\"brief\":{\"focus\":[\"高并发\",\"\"],\"keepProjects\":[\"订单系统\"],\"deemphasize\":[\"行政实习\"],\"degree\":\"light\",\"pages\":1,\"preset\":\"后端通用\"}}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id||'')}catch{console.log('')}})")
[ -n "$BRIEFJOB" ] && [ -f "$RESUME_ROOT/docs/$BRIEFJOB.html" ] || fail 'S4a-T5 带 brief 创建失败'
BRIEF=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(m[process.argv[2]].job.brief))' "$RESUME_ROOT/docs-meta.json" "$BRIEFJOB")
[ "$BRIEF" = '{"focus":["高并发"],"keepProjects":["订单系统"],"deemphasize":["行政实习"],"degree":"light","pages":1,"preset":"后端通用"}' ] || fail "S4a-T5 create 带 brief 落 meta 异常: $BRIEF"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/create" -H 'Content-Type: application/json' -d "{\"from\":\"$DOCID\",\"company\":\"要求卡公司\",\"role\":\"前端工程师二\",\"brief\":{\"degree\":\"huge\"}}")
[ "$CODE" = "400" ] || fail "S4a-T5 非法 degree 应 400 得 $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/brief?id=$BRIEFJOB" -H 'Content-Type: application/json' -d '{"pages":"two"}')
[ "$CODE" = "400" ] || fail "S4a-T5 非法 pages 应 400 得 $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/brief?id=$BRIEFJOB" -H 'Content-Type: application/json' -d '{"focus":"高并发"}')
[ "$CODE" = "400" ] || fail "S4a-T5 非数组 focus 应 400 得 $CODE"
# /job/brief 往返：省略字段默认补齐（不整对象覆盖语义由 normBrief 保证）
curl -s -X POST "$B/job/brief?id=$JOBLOC" -H 'Content-Type: application/json' -d '{"focus":["性能优化"],"degree":"restructure"}' | grep -q '"ok":true' || fail 'S4a-T5 /job/brief 更新失败'
BRIEF=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify(m[process.argv[2]].job.brief))' "$RESUME_ROOT/docs-meta.json" "$JOBLOC")
[ "$BRIEF" = '{"focus":["性能优化"],"keepProjects":[],"deemphasize":[],"degree":"restructure","pages":2,"preset":null}' ] || fail "S4a-T5 /job/brief 落 meta 异常: $BRIEF"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/brief?id=$DOCID" -H 'Content-Type: application/json' -d '{"degree":"light"}')
[ "$CODE" = "404" ] || fail "S4a-T5 普通文档 /job/brief 应 404 得 $CODE"
# 旧草稿兼容：meta 无 brief → /job/changes 渐进默认；/job/brief 可直接补写
node -e 'const fs=require("fs");const f=process.argv[1];const m=JSON.parse(fs.readFileSync(f,"utf8"));delete m[process.argv[2]].job.brief;fs.writeFileSync(f,JSON.stringify(m));' "$RESUME_ROOT/docs-meta.json" "$BRIEFJOB"
BRIEFVIEW=$(curl -s "$B/job/changes?id=$BRIEFJOB" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s).job;console.log(j.brief&&j.brief.degree==="refocus"&&j.brief.pages===2&&Array.isArray(j.brief.focus)?"1":"0")})')
[ "$BRIEFVIEW" = "1" ] || fail 'S4a-T5 旧草稿（无 brief）GET /job/changes 未出渐进默认值'
curl -s -X POST "$B/job/brief?id=$BRIEFJOB" -H 'Content-Type: application/json' -d '{"focus":["高并发"],"keepProjects":["订单系统"],"deemphasize":["行政实习"],"degree":"light","pages":1,"preset":"后端通用"}' | grep -q '"ok":true' || fail 'S4a-T5 旧草稿补写 brief 失败'
# 生成消费 brief（stub 记录 prompt）
R=$(curl -s -X POST "$B/job/generate?id=$BRIEFJOB" -H 'Content-Type: application/json' -d '{}')
echo "$R" | grep -q '"generated":2' || fail "S4a-T5 带 brief 生成失败: $(echo "$R" | head -c 260)"
grep -q '重点：高并发' "$TEST_DIR/llm-last.json" || fail 'prompt 未消费 brief.focus'
grep -q '必须保留：订单系统' "$TEST_DIR/llm-last.json" || fail 'prompt 未消费 brief.keepProjects'
grep -q '轻度精简' "$TEST_DIR/llm-last.json" || fail 'prompt 未消费 brief.degree'
grep -q '页数目标：1 页' "$TEST_DIR/llm-last.json" || fail 'prompt 未消费 brief.pages'
# 转交修 a：/job/generate 同步等待的 dropped 409 读锁内已写 error（真超时如实说「任务超时」，不再恒称「已被取消或取代」）
echo 3000 > "$TEST_DIR/llm-slow"
curl -s -X POST "$B/job/generate?id=$JOBLOC" -H 'Content-Type: application/json' -d '{}' -o "$TEST_DIR/t5-gen409.json" -w '%{http_code}' > "$TEST_DIR/t5-gen409.code" & GC=$!
sleep 0.8   # startGenTask 已写 running+taskId
T4TG=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=((m[process.argv[2]].job||{}).genTasks||{}).changes||{};console.log(t.taskId||"")' "$RESUME_ROOT/docs-meta.json" "$JOBLOC")
[ -n "$T4TG" ] || fail 'S4a-T5 转交修 a 夹具未进入 running'
node -e 'const fs=require("fs");const f=process.argv[1],doc=process.argv[2];const m=JSON.parse(fs.readFileSync(f,"utf8"));const t=m[doc].job.genTasks.changes;m[doc].job.genTasks.changes={...t,startedAt:Date.now()-11*60*1000};fs.writeFileSync(f,JSON.stringify(m));' "$RESUME_ROOT/docs-meta.json" "$JOBLOC"
wait $GC
rm -f "$TEST_DIR/llm-slow"
[ "$(cat "$TEST_DIR/t5-gen409.code")" = "409" ] || fail "S4a-T5 转交修 a 应 409 得 $(cat "$TEST_DIR/t5-gen409.code")"
grep -q '任务超时' "$TEST_DIR/t5-gen409.json" || fail "S4a-T5 转交修 a：同步 409 应如实标任务超时: $(cat "$TEST_DIR/t5-gen409.json")"
grep -q '已被取消或取代' "$TEST_DIR/t5-gen409.json" && fail 'S4a-T5 转交修 a：真超时不应再称已被取消或取代'
# 首页要求卡（服务端直渲染 + 预设键）
curl -sf "$B/" | grep -q '本次定制要求' || fail '首页缺要求卡折叠区'
curl -sf "$B/" | grep -q 'briefFocusChips' || fail '首页缺重点 chips'
curl -sf "$B/" | grep -q 's4a-presets' || fail '首页缺预设存储键'
echo '✅ S4a-T5 要求卡（create/brief 端点 + 默认值 + 校验 + 旧草稿兼容 + 生成消费 + 首页表单 + 转交修 a）'

# ===== 9. 生成建议（假 LLM）：只带已确认素材；状态入库可持久化 =====
R=$(curl -s -X POST "$B/job/generate?id=$JOBLOC" -H 'Content-Type: application/json' -d '{}')
echo "$R" | grep -q '"generated":2' || fail "生成建议数量异常: $(echo "$R" | head -c 200)"
grep -q '素材甲' "$TEST_DIR/llm-last.json" || fail 'prompt 未包含已确认素材'
grep -q '不应参与生成' "$TEST_DIR/llm-last.json" && fail 'prompt 混入未确认素材'
curl -s "$B/job/changes?id=$JOBLOC" | grep -q '"status":"pending"' || fail '变更未入库'
C1=$(curl -s "$B/job/changes?id=$JOBLOC" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d).job;console.log(j.changes[0].id)})")
curl -s -X POST "$B/job/changes?id=$JOBLOC" -H 'Content-Type: application/json' -d "{\"updates\":[{\"id\":\"$C1\",\"status\":\"accepted\",\"meta\":{\"occurrence\":0}}]}" | grep -q '"status":"accepted"' || fail '状态回写失败'
curl -s "$B/job/changes?id=$JOBLOC" | grep -q '"status":"accepted"' || fail '刷新后状态丢失'
curl -s "$B/job/changes?id=$JOBLOC" | grep -q '缺少量化指标' || fail '待补充信息未入库'
# 重新生成：旧候选标 superseded，已接受历史不被覆盖（新候选供比较）
R2=$(curl -s -X POST "$B/job/generate?id=$JOBLOC" -H 'Content-Type: application/json' -d '{}')
echo "$R2" | grep -q '"generated":2' || fail "二次生成失败: $(echo "$R2" | head -c 160)"
curl -s "$B/job/changes?id=$JOBLOC" | grep -q '"status":"superseded"' || fail '旧候选未标记 superseded'
curl -s "$B/job/changes?id=$JOBLOC" | grep -q '"status":"accepted"' || fail '二次生成覆盖了已处理的修改'
echo '✅ 岗位建议生成与审阅状态持久化（模拟 LLM；重新生成不覆盖已处理修改）'

# ===== 10. 导出门控：事实冲突未处理 → 阻止下载；处理后解除 =====
node -e "
const fs=require('fs');
const f='$RESUME_ROOT/docs-meta.json';
const m=JSON.parse(fs.readFileSync(f,'utf8'));
m['$JOBLOC'].job.changes.push({id:'x-conflict',gen:1,section:'工作经历',entry:'',kind:'replace',before:'文本B',after:'文本C',reason:'数字冲突',source:'JD',level:'conflict',status:'pending'});
fs.writeFileSync(f,JSON.stringify(m));
"
curl -sf "$B/export?id=$JOBLOC" | grep -q '暂不能下载' || fail '冲突未阻断导出'
curl -sf "$B/export?id=$JOBLOC" | grep -q '事实冲突' || fail '冲突未在导出页展示'
curl -s -X POST "$B/job/changes?id=$JOBLOC" -H 'Content-Type: application/json' -d '{"updates":[{"id":"x-conflict","status":"rejected"}]}' -o /dev/null
curl -sf "$B/export?id=$JOBLOC" | grep -q '暂不能下载' && fail '冲突撤销后仍阻断导出'
curl -sf "$B/export?id=$JOBLOC" | grep -q '下载最新版 PDF' || fail '导出页缺下载按钮'
echo '✅ 导出事实冲突门控'

# ===== 11. 投递：冻结内容 + 从冻结内容生成存档 PDF + 版本/哈希绑定 =====
APPID=$(curl -s -X POST "$B/app/add" -H 'Content-Type: application/json' -d "{\"company\":\"测试公司\",\"role\":\"后端工程师\",\"docId\":\"$JOBLOC\",\"channel\":\"BOSS\",\"appliedAt\":\"2026-09-17\"}" | sed 's/.*"id":"\([^"]*\)".*/\1/')
[ -n "$APPID" ] || fail '投递记录失败'
[ -f "$RESUME_ROOT/pdfs/archive/$APPID.pdf" ] || fail '存档 PDF 未从冻结内容生成'
grep -q '"contentHash":"' "$RESUME_ROOT/applications.json" || fail '缺内容哈希绑定'
SNAPTS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RESUME_ROOT/applications.json','utf8')).find(a=>a.id==='$APPID').snapTs)")
[ -f "$RESUME_ROOT/snapshots/$JOBLOC/$SNAPTS.html" ] || fail '冻结快照缺失'
curl -sf -o /dev/null -w '%{http_code}' "$B/archive-pdf?id=$APPID" | grep -q 200 || fail '存档 PDF 不可下载'
# 之后改稿不影响存档
BEFORE_ARCH=$(md5 -q "$RESUME_ROOT/pdfs/archive/$APPID.pdf")
curl -s -X POST "$B/save?id=$JOBLOC" --data-binary "$(sed 's/文本B/文本B-修改后/' "$RESUME_ROOT/docs/$JOBLOC.html")" -o /dev/null
[ "$(md5 -q "$RESUME_ROOT/pdfs/archive/$APPID.pdf")" = "$BEFORE_ARCH" ] || fail '改稿改动了历史投递存档'
# 存档丢失 → 明确标注；从冻结快照重生成（不允许用当前文档冒充）
rm -f "$RESUME_ROOT/pdfs/archive/$APPID.pdf"
curl -s "$B/archive-pdf?id=$APPID" | grep -q '存档 PDF' || fail '缺档未明确提示'
curl -s -X POST "$B/app/archive-regenerate" -H 'Content-Type: application/json' -d "{\"id\":\"$APPID\"}" | grep -q '"ok":true' || fail '从快照重生成存档失败'
pdftotext "$RESUME_ROOT/pdfs/archive/$APPID.pdf" - | grep -q 'TESTPDF' || fail '重生成存档无文本层'
echo '✅ 投递冻结内容 + 存档生成 + 改稿隔离'

# ===== 12. 投递存档快照免配额清理 =====
curl -s -X POST "$B/save?id=$JOBLOC" --data-binary "$(cat "$RESUME_ROOT/docs/$JOBLOC.html")" -o /dev/null
for i in $(seq 1 55); do cp "$RESUME_ROOT/docs/$JOBLOC.html" "$RESUME_ROOT/snapshots/$JOBLOC/2026-01-01-0000$i.html"; done
SNAP_COUNT=$(ls "$RESUME_ROOT/snapshots/$JOBLOC"/*.html | wc -l | tr -d ' ')
curl -s -X POST "$B/save?id=$JOBLOC" --data-binary "$(cat "$RESUME_ROOT/docs/$JOBLOC.html")" -o /dev/null
[ -f "$RESUME_ROOT/snapshots/$JOBLOC/$SNAPTS.html" ] || fail '投递引用的快照被配额清理'
NEW_COUNT=$(ls "$RESUME_ROOT/snapshots/$JOBLOC"/*.html | wc -l | tr -d ' ')
[ "$NEW_COUNT" -le 51 ] || fail "配额未生效（$SNAP_COUNT→${NEW_COUNT}）"
echo '✅ 投递快照免清理 + 配额仍生效'

# ===== 12b. 历史版本 PDF / 交付状态失效 / 事实护栏 / 自产备份往返 =====
SNAP_FIRST=$(ls "$RESUME_ROOT/snapshots/$DOCID"/*.html | sort | head -1 | xargs -n1 basename | sed 's/\.html//')
curl -s -o "$TEST_DIR/hist.pdf" -w '%{http_code}' "$B/snapshot/pdf?id=$DOCID&ts=$SNAP_FIRST" | grep -q 200 || fail '历史版本 PDF 下载失败'
pdftotext "$TEST_DIR/hist.pdf" - | grep -q 'TESTPDF' || fail '历史版本 PDF 无文本层'
echo '✅ 历史版本 PDF（从快照渲染，语义独立）'
# 可投递状态：标记 → 保存新内容后自动失效
curl -s -X POST "$B/job/changes?id=$JOBLOC" -H 'Content-Type: application/json' -d '{"status":"deliverable"}' -o /dev/null
curl -s "$B/job/changes?id=$JOBLOC" | grep -q '"status":"deliverable"' || fail '可投递状态未保存'
curl -s -X POST "$B/save?id=$JOBLOC" --data-binary "$(sed 's/文本B/文本B-改可投递/' "$RESUME_ROOT/docs/$JOBLOC.html")" -o /dev/null
curl -s "$B/job/changes?id=$JOBLOC" | grep -q '"status":"deliverable"' && fail '改稿后可投递状态未失效'
echo '✅ 改稿使「可投递」失效（不影响已有投递存档）'
# 事实护栏：新增数字/丢失日期 → 强制 conflict
node --input-type=module -e "
import { parseJobOps } from '/Users/xxxly/resume/job.mjs';
const ops = parseJobOps(JSON.stringify({ summary: 'x', changes: [
  { section: 's', kind: 'replace', before: '提升明显', after: '提升40%', reason: 'r' },
  { section: 's', kind: 'replace', before: '2024-2025 任职', after: '任职两年', reason: 'r' },
  { section: 's', kind: 'replace', before: '负责模块', after: '负责模块（精简）', reason: 'r' }
], todos: [] }));
if (ops.changes[0].level !== 'conflict') { console.error('❌ 新增数字未拦截'); process.exit(1); }
if (ops.changes[1].level !== 'conflict') { console.error('❌ 丢失日期未拦截'); process.exit(1); }
if (ops.changes[2].level !== 'normal') { console.error('❌ 正常改写被误标'); process.exit(1); }
console.log('✅ 事实护栏（数字/日期）');
" || fail '事实护栏单元测试失败'
# 自产备份往返（下载 → 预览 → 合并恢复）
curl -s "$B/backup" -o "$TEST_DIR/self.tar.gz"
tar tzf "$TEST_DIR/self.tar.gz" | grep -q 'materials.json' || fail '自产备份缺 materials.json'
curl -s -X POST "$B/restore?apply=0" --data-binary "@$TEST_DIR/self.tar.gz" | grep -q '"ok":true' || fail '自产备份预览失败'
curl -s -X POST "$B/restore?apply=1&mode=merge" --data-binary "@$TEST_DIR/self.tar.gz" | grep -q '"ok":true' || fail '自产备份恢复失败'
echo '✅ 自产备份可恢复（合并语义）'

# ===== 13. 备份/恢复：合并语义、冲突预览、本地独有保留、回退点 =====
curl -s "$B/backup" -o "$TEST_DIR/backup.tar.gz"
tar tzf "$TEST_DIR/backup.tar.gz" | grep -q 'docs/' || fail '备份缺 docs/'
tar tzf "$TEST_DIR/backup.tar.gz" | grep -q 'config.json' && fail '备份含 config.json（密钥泄漏）'
echo '✅ 备份不含密钥'
# 构造备份包：一个新文档 + 与本地冲突的文档 + 一条投递（外加一条本地独有投递保留验证）
mkdir -p "$TEST_DIR/bak/docs"
echo '<html><body>备份新文档</body></html>' > "$TEST_DIR/bak/docs/zz-bak-new.html"
sed 's/文本B/文本B-备份版/' "$RESUME_ROOT/docs/$DOCID.html" > "$TEST_DIR/bak/docs/$DOCID.html"
node -e "
const fs=require('fs');
const apps=[{id:'9999-0001',company:'备份公司',role:'岗位X',docId:'$DOCID',status:'已投递',createdAt:'x',updatedAt:'x'}];
fs.writeFileSync('$TEST_DIR/bak/applications.json',JSON.stringify(apps));
fs.writeFileSync('$TEST_DIR/bak/materials.json','[]');
fs.writeFileSync('$TEST_DIR/bak/docs-meta.json','{}');
"
# 本地独有投递（应先于恢复存在）
curl -s -X POST "$B/app/add" -H 'Content-Type: application/json' -d "{\"company\":\"本地公司\",\"role\":\"本地岗位\",\"docId\":\"$DOCID\"}" -o /dev/null
TARFILE="$TEST_DIR/bak.tar.gz"
(cd "$TEST_DIR/bak" && tar czf "$TARFILE" docs applications.json materials.json docs-meta.json)
PREV=$(curl -s -X POST "$B/restore?apply=0" --data-binary "@$TARFILE")
echo "$PREV" | grep -q '"zz-bak-new"' || fail "预览缺新增文档: $(echo "$PREV" | head -c 200)"
echo "$PREV" | grep -q "\"$DOCID\"" || fail '预览缺冲突文档'
echo "$PREV" | grep -q '9999-0001' || fail '预览缺备份投递'
curl -s -X POST "$B/restore?apply=1&mode=merge" --data-binary "@$TARFILE" | grep -q '"ok":true' || fail '合并恢复失败'
[ -f "$RESUME_ROOT/docs/zz-bak-new.html" ] || fail '合并未导入新文档'
grep -q '文本B-备份版' "$RESUME_ROOT/docs/$DOCID.html" || fail '冲突文档未以备份为准'
grep -q '本地公司' "$RESUME_ROOT/applications.json" || fail '合并丢失本地独有记录'
grep -q '备份公司' "$RESUME_ROOT/applications.json" || fail '合并未导入备份记录'
echo '✅ 合并恢复（保留本地独有 + 冲突以备份为准）'
# 回退点
BEFORE_UNDO_MD5=$(md5 -q "$RESUME_ROOT/docs/$DOCID.html")
SAFETY=$(curl -s -X POST "$B/restore?apply=1&mode=merge" --data-binary "@$TARFILE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).safety||'')})")
[ -n "$SAFETY" ] || fail '恢复未生成回退点'
curl -s -X POST "$B/restore/undo?ts=$SAFETY" | grep -q '"ok":true' || fail '回退失败'
[ "$(md5 -q "$RESUME_ROOT/docs/$DOCID.html")" = "$BEFORE_UNDO_MD5" ] || fail '回退未还原到操作前状态'
echo '✅ 恢复回退点可用'
# 非法包：路径穿越拒绝（bsdtar 用 -s 重命名制造 ../ 条目）
mkdir -p "$TEST_DIR/evil" && echo x > "$TEST_DIR/evil/pwned"
(cd "$TEST_DIR/evil" && tar czf "$TEST_DIR/evil.tar.gz" -s '|^pwned$|../pwned|' pwned) || true
[ -f "$TEST_DIR/evil.tar.gz" ] || fail '构造非法备份包失败'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/restore?apply=0" --data-binary "@$TEST_DIR/evil.tar.gz")
[ "$CODE" = "400" ] || fail "路径穿越包未被拒绝（${CODE}）"
echo '✅ 非法恢复包拒绝'

# ===== 14. 损坏 JSON：停写 + 明确提示，不静默清空 =====
cp "$RESUME_ROOT/applications.json" "$TEST_DIR/apps-good.json"
printf '{broken json' > "$RESUME_ROOT/applications.json"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/app/add" -H 'Content-Type: application/json' -d "{\"company\":\"x\",\"role\":\"y\",\"docId\":\"$DOCID\"}")
[ "$CODE" = "500" ] || fail "损坏 JSON 未停写（${CODE}）"
grep -q 'broken json' "$RESUME_ROOT/applications.json" || fail '损坏文件被覆盖'
curl -sf "$B/applications" | grep -q '数据文件损坏' || fail '看板未提示损坏'
cp "$TEST_DIR/apps-good.json" "$RESUME_ROOT/applications.json"
curl -s -X POST "$B/app/add" -H 'Content-Type: application/json' -d "{\"company\":\"恢复公司\",\"role\":\"y\",\"docId\":\"$DOCID\"}" | grep -q '"ok":true' || fail '修复后仍不可写'
echo '✅ 损坏 JSON 停写与提示'

# ===== 15. 兼容回归：标签/复制/删除/diff/快照/统计/设置/JD 链接 =====
curl -s -X POST "$B/tag" -H 'Content-Type: application/json' -d "{\"id\":\"$DOCID\",\"tag\":\"测试组\"}" | grep -q '"ok":true' || fail '打标签失败'
curl -sf "$B/" | grep -q '测试组' || fail '列表页未见标签'
curl -s -X POST "$B/duplicate?id=$DOCID&to=zz-copy" -o /dev/null
[ -f "$RESUME_ROOT/docs/zz-copy.html" ] || fail '复制失败'
curl -s -X POST "$B/delete?id=zz-copy" -o /dev/null
[ -f "$RESUME_ROOT/docs/zz-copy.html" ] && fail '删除失败'
curl -sf "$B/diff?base=$DOCID&to=$JOBLOC" | grep -q 'diff-line' || fail 'diff 渲染失败'
curl -sf "$B/diff?base=$DOCID&to=$JOBLOC" | grep -q '不含隐藏内容' || fail 'diff 未标注隐藏口径'
curl -sf "$B/snapshots?id=$DOCID" | grep -q '当前版本不在列表中' || fail '快照页语义缺失'
curl -sf "$B/stats" | grep -q '状态分布' || fail '统计页缺状态分布'
curl -sf "$B/applications?view=table" | grep -q '<table' || fail '表格视图缺失'
CODE=$(curl -s -X POST "$B/settings" -H 'Content-Type: application/json' -d '{"active":5,"profiles":[{"name":"a","baseURL":"http://x","apiKey":"k","model":"m"}]}' -o /dev/null -w '%{http_code}')
[ "$CODE" = "400" ] || fail '设置 active 越界未拦'
for EP in ai/test settings ai/rewrite ai/chat ai/review ai/match tag app/add app/update job/create; do
  CODE=$(curl -s -X POST "$B/$EP" -H 'Content-Type: application/json' -d '{bad json' -o /dev/null -w '%{http_code}')
  [ "$CODE" = "400" ] || fail "坏 JSON /$EP 应 400 得 $CODE"
done
echo '✅ 兼容回归（标签/复制/删除/diff/统计/设置/坏 JSON 400）'
# JD 链接 stub
node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'Content-Type':'text/html'});s.end('<html><body><script>var a=1;</script><h1>资深后端工程师</h1><p>五年 Node 经验</p></body></html>')}).listen(17901,'127.0.0.1')" > /dev/null 2>&1 & JDSTUB=$!
sleep 0.3
JDR=$(curl -s -X POST "$B/ai/jd-text" -H 'Content-Type: application/json' -d '{"url":"http://127.0.0.1:17901"}')
echo "$JDR" | grep -q '资深后端工程师' || fail 'JD 提取缺标题'
echo "$JDR" | grep -q 'var a=1' && fail 'JD 提取未剔脚本'
CODE=$(curl -s -X POST "$B/ai/jd-text" -H 'Content-Type: application/json' -d '{"url":"file:///etc/passwd"}' -o /dev/null -w '%{http_code}')
[ "$CODE" = "400" ] || fail '非 http 协议未拦'
echo '✅ JD 链接读取'

# ===== S3：区域绑定（已知正文 → /zones/init → /zones → /save 同步）=====
cat > "$TEST_DIR/s3-doc.html" << 'EOF'
<body><div class="sheet"><div class="contact">测试员 s3@t.cn</div>
<section class="section"><div class="section-title">个人总结</div><p>五年后端经验</p></section>
<section class="section"><div class="section-title">专业技能</div><p>技能一：Go 与调度系统，配套说明文字用于把摘要窗口填满，确保后续标记不会进入其他区域的请求体 MARKERZZ</p></section>
<section class="section"><div class="section-title">工作经历</div><p>负责交易系统，P99 800ms</p></section>
<section class="section"><div class="section-title">项目经历</div><p>项目甲：数据管道重设计</p></section>
</div></body>
EOF
S3DOC=$(curl -s -X POST "$B/new" -o /dev/null -w '%{redirect_url}' | sed 's/.*id=//')
[ -n "$S3DOC" ] && [ -f "$RESUME_ROOT/docs/$S3DOC.html" ] || fail 'S3 夹具文档创建'
curl -s -X POST "$B/save?id=$S3DOC" --data-binary "@$TEST_DIR/s3-doc.html" | grep -q '"ok":true' || fail 'S3 夹具正文保存'
# /zones/init：按客户端形状构造 entries（zid + sectionTitle，sectionsOf 分组；服务端只认形状）
node --input-type=module -e '
import { normalizeZids, parasOf } from "./zone.mjs";
import { sectionsOf } from "./extract.mjs";
import { readFileSync, writeFileSync } from "node:fs";
const f = process.argv[1];
const html = normalizeZids(readFileSync(f, "utf8"));
writeFileSync(f, html);
const entries = [];
for (const s of sectionsOf(html)) for (const p of parasOf(s.html)) entries.push({ zid: p.zid, sectionTitle: s.title, text: p.text.slice(0, 40) });
for (const p of parasOf(html.replace(/<section[\s\S]*$/, ""))) entries.push({ zid: p.zid, sectionTitle: "个人信息", text: p.text.slice(0, 40) });
writeFileSync(process.argv[2], JSON.stringify(entries));' "$TEST_DIR/s3-doc.html" "$TEST_DIR/s3-entries.json" || fail 'S3 夹具 entries 构造'
S3Z=$(curl -s -X POST "$B/zones/init?id=$S3DOC" -H 'Content-Type: application/json' -d "{\"entries\":$(cat "$TEST_DIR/s3-entries.json")}")
echo "$S3Z" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const zs=Object.values(j.zones||{});if(!j.ok||!zs.length||!zs.every(z=>z.status==="pending")){console.error("❌ S3 zones/init "+JSON.stringify(j).slice(0,200));process.exit(1)}})' || fail 'S3 /zones/init 全 pending'
echo '✅ S3 /zones/init 全 pending'
Z1=$(node -e 'console.log("z"+"1".repeat(8))')
curl -s -X POST "$B/zones?id=$S3DOC" -H 'Content-Type: application/json' \
  -d "{\"zones\":{\"$Z1\":{\"zone\":\"work\",\"status\":\"confirmed\",\"locked\":true}},\"zoneOrder\":[\"work\",\"personal\",\"education\",\"project\",\"skill\",\"award\",\"summary\",\"other\"]}" \
  | grep -q '"ok":true' || fail 'S3 /zones 回写'
curl -s -X POST "$B/zones?id=$S3DOC" -H 'Content-Type: application/json' \
  -d "{\"zones\":{\"$Z1\":{\"zone\":\"nope\",\"status\":\"confirmed\"}}}" | grep -q '"ok":false' || fail 'S3 /zones 坏枚举拒绝'
echo '✅ S3 /zones 回写与枚举校验'
# /save 同步：打点正文再保存 → meta zones 与正文 zid 一致（补 pending / 清孤儿：Z1 不在正文，预期被清）
curl -s -X POST "$B/save?id=$S3DOC" --data-binary "@$TEST_DIR/s3-doc.html" | grep -q '"ok":true' || fail 'S3 /save 打点正文'
node -e '
const fs = require("fs");
const meta = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]] || {};
const docHtml = fs.readFileSync(process.argv[3], "utf8");
const inDoc = [...docHtml.matchAll(/data-zid="(z[0-9a-f]{8})"/g)].map((m) => m[1]);
const zs = meta.zones || {};
const missing = inDoc.filter((z) => !zs[z]);
const orphan = Object.keys(zs).filter((z) => !inDoc.includes(z));
if (missing.length || orphan.length) { console.error("❌ S3 zones 同步 missing=" + missing + " orphan=" + orphan); process.exit(1); }
console.log("zones=" + inDoc.length);' "$RESUME_ROOT/docs-meta.json" "$S3DOC" "$TEST_DIR/s3-doc.html" || fail 'S3 /save 后 zones 同步'
echo '✅ S3 /save 后 zones 与正文一致（孤儿清/缺失补）'
# S3-T5 区域级 AI（stub 模拟验证）：端点结构 / 请求最小化 / 改写候选
# S3-T6：带 extra（chips 追问）请求——同一次捕获体上同时断言「最小化」与「追问进 prompt」
AZ=$(curl -s -X POST "$B/ai/zone-analyze?id=$S3DOC" -H 'Content-Type: application/json' -d '{"zone":"work","extra":"量化数据够吗"}')
echo "$AZ" | grep -q '"echoes"' || fail "S3 zone-analyze 返回结构化意见（模拟验证）: $(echo "$AZ" | head -c 160)"
if grep -q 'MARKERZZ' /tmp/resume-test-llm-last.json 2>/dev/null; then fail 'S3 zone-analyze 请求泄漏其他区域全文（超出摘要窗口）'; fi
grep -q '【追问】量化数据够吗' /tmp/resume-test-llm-last.json || fail 'S3 zone-analyze 追问文本未进 prompt'
pass() { echo "✅ $1"; }
pass "S3 zone-analyze 请求最小化（模拟验证）"
RW=$(curl -s -X POST "$B/ai/zone-rewrite?id=$S3DOC" -H 'Content-Type: application/json' -d '{"zone":"work","instruction":"更精简"}')
echo "$RW" | grep -q '"rewrites"' || fail "S3 zone-rewrite 返回候选（模拟验证）: $(echo "$RW" | head -c 160)"
pass "S3 zone-rewrite（模拟验证）"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/ai/zone-analyze?id=$S3DOC" -H 'Content-Type: application/json' -d '{"zone":"nope"}')
[ "$CODE" = "400" ] || fail "S3 zone-analyze 坏区域应 400 得 $CODE"

# ===== S3-T7：素材事实层三态 =====
curl -s -X POST "$B/mat/add" -H 'Content-Type: application/json' -d '{"title":"事实素材","brief":"b","facts":{"metrics":"P99 800ms→210ms"},"factStatus":"confirmed"}' | grep -q '"ok":true' || fail 'S3 mat/add 带 facts'
MATID=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const x=m.find(v=>v.title==="事实素材");console.log(x?x.id:"")' "$RESUME_ROOT/materials.json")
[ -n "$MATID" ] || fail 'S3 素材夹具读取'
curl -s -X POST "$B/mat/update" -H 'Content-Type: application/json' -d '{"id":"'"$MATID"'","factStatus":"outdated"}' | grep -q '"ok":true' || fail 'S3 mat/update 三态'
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const x=m.find(v=>v.title==="事实素材");if(!x||x.factStatus!=="outdated"||!x.facts||x.facts.metrics!=="P99 800ms→210ms"){console.error("❌ S3 三态落盘");process.exit(1)}' "$RESUME_ROOT/materials.json" || fail 'S3 factStatus/facts 落盘'
pass "S3 素材事实层三态"
# /mat/confirm 兼容映射：confirmed:false → outdated 落盘 pending（旧前端形状垫片）
curl -s -X POST "$B/mat/confirm" -H 'Content-Type: application/json' -d "{\"ids\":[\"$MATID\"],\"confirmed\":false}" | grep -q '"ok":true' || fail 'S3 mat/confirm 兼容请求'
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const x=m.find(v=>v.title==="事实素材");if(!x||x.factStatus!=="pending"){console.error("❌ S3 confirm 映射");process.exit(1)}' "$RESUME_ROOT/materials.json" || fail 'S3 mat/confirmed:false→pending 落盘'
# /mat/update facts 白名单整替：白名单外键丢弃、值 String 化
curl -s -X POST "$B/mat/update" -H 'Content-Type: application/json' -d '{"id":"'"$MATID"'","facts":{"metrics":210,"hacker":"x"}}' | grep -q '"ok":true' || fail 'S3 mat/update facts 整替'
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const x=m.find(v=>v.title==="事实素材");const ks=Object.keys(x.facts);if(!x.facts||ks.length!==8||x.facts.metrics!=="210"||ks.includes("hacker")){console.error("❌ S3 facts 白名单 "+JSON.stringify(ks));process.exit(1)}' "$RESUME_ROOT/materials.json" || fail 'S3 facts 白名单整替落盘'
pass "S3 mat/confirm 兼容映射与 facts 白名单"

# ===== S4a-T3：v1.6 JSON 保存协议（四反例 + 三附加；设计 §4.2 复审批定顺序）=====
# 夹具：独立岗位草稿 T3DOC + 三段已知正文 + 手工注入三条带 zid 的候选（t3-c1/c2/c3）。
# JSON 体 = {requestId, baseRev, html, ops}；正文由客户端先行应用（html 已含改后段落），服务端对「当前磁盘正文」校验 origText。
JOB2=$(curl -s -X POST "$B/job/create" -H 'Content-Type: application/json' -d "{\"from\":\"$DOCID\",\"company\":\"协议测试公司\",\"role\":\"后端\",\"jd\":\"S4a 保存协议验证\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id||'')}catch{console.log('')}})")
[ -n "$JOB2" ] && [ -f "$RESUME_ROOT/docs/$JOB2.html" ] || fail 'S4a 保存协议夹具岗位草稿创建'
cat > "$TEST_DIR/t3-body.html" << 'EOF'
<html><head><title>T3</title></head><body><div class="sheet">
<section class="section"><div class="section-title">工作经历</div><p>T3段落甲：负责结算系统，日均百万单</p><p>T3段落乙：负责库存中台</p><p>T3段落丙：主导灰度发布平台</p></section>
</div></body></html>
EOF
# 旧 HTML 路径回归（无 JSON CT 的保存现行为不变；后续四反例全部依赖这条基线落盘）
curl -s -X POST "$B/save?id=$JOB2" --data-binary "@$TEST_DIR/t3-body.html" | grep -q '"ok":true' || fail 'S4a 旧 HTML 保存路径回归失败'
T3REV=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].rev||0)' "$RESUME_ROOT/docs-meta.json" "$JOB2")
# 注入三条候选（zid 取自落盘正文的归一化打点；baseSnapshot = 段落当前文本）
node -e '
const fs = require("fs");
const docId = process.argv[2];
const h = fs.readFileSync(process.argv[3], "utf8");
const zids = [...h.matchAll(/data-zid="(z[0-9a-f]{8})"/g)].map((m) => m[1]);
if (zids.length < 3) { console.error("❌ S4a 夹具段落不足: " + zids.length); process.exit(1); }
const f = process.argv[1];
const meta = JSON.parse(fs.readFileSync(f, "utf8"));
const T3D = `第一行：负责库存中台重构\n第二行："引用"与 \u0027单引号\u0027 🎉\n含分隔符 <!-- 开头与 --> 结尾及 </div> 字面量`;
meta[docId].job.changes.push(
  { id: "t3-c1", gen: 9, kind: "replace", zid: zids[0], section: "工作经历", before: "T3段落甲：负责结算系统，日均百万单", after: "T3段落甲：负责结算清算中台，日均百万单（定制）", reason: "对齐 JD", source: "母版", level: "normal", status: "pending", baseSnapshot: "T3段落甲：负责结算系统，日均百万单" },
  { id: "t3-c2", gen: 9, kind: "replace", zid: zids[1], section: "工作经历", before: "T3段落乙：负责库存中台", after: T3D, reason: "中文长文本", source: "母版", level: "normal", status: "pending", baseSnapshot: "T3段落乙：负责库存中台" },
  { id: "t3-c3", gen: 9, kind: "replace", zid: zids[2], section: "工作经历", before: "T3段落丙：主导灰度发布平台", after: "T3段落丙：主导灰度平台（精简）", reason: "精简", source: "母版", level: "normal", status: "pending", baseSnapshot: "T3段落丙：主导灰度发布平台" }
);
fs.writeFileSync(f, JSON.stringify(meta));
fs.writeFileSync(process.argv[4], JSON.stringify(zids));
' "$RESUME_ROOT/docs-meta.json" "$JOB2" "$RESUME_ROOT/docs/$JOB2.html" "$TEST_DIR/t3-zids.json" || fail 'S4a 夹具候选注入'
T3ZA=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[0])' "$TEST_DIR/t3-zids.json")
T3ZB=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[1])' "$TEST_DIR/t3-zids.json")
T3ZC=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[2])' "$TEST_DIR/t3-zids.json")
# 组装 JSON 保存体：按 zid 替换段落内容 → {requestId, baseRev, html, ops}（走 argv，不经环境/内插）
t3_body() { # $1=输出文件 $2=requestId $3=baseRev $4=zid::新文本 $5=ops(JSON)；正文基线 = $TEST_DIR/t3-cur.html
  node -e '
  const fs = require("fs");
  const [out, rid, baseRev, reps, ops, src] = process.argv.slice(1);
  let h = fs.readFileSync(src, "utf8");
  for (const pair of reps.split(";;")) {
    if (!pair) continue;
    const [zid, txt] = pair.split("::", 2);
    h = h.replace(new RegExp(`(<p[^>]*data-zid="${zid}"[^>]*>)[\\s\\S]*?(</p>)`), (mm, a, b) => a + txt + b);
  }
  fs.writeFileSync(out, JSON.stringify({ requestId: rid, baseRev: Number(baseRev), html: h, ops: JSON.parse(ops) }));
  ' "$1" "$2" "$3" "$4" "$5" "$TEST_DIR/t3-cur.html"
}
cp "$RESUME_ROOT/docs/$JOB2.html" "$TEST_DIR/t3-cur.html"

# —— 反例 a：接受成功 → 撤回成功 → 旧接受重试（同 requestId 同内容）→ 只回执不重放 ——
t3_body "$TEST_DIR/t3-acc.json" "t3-req-acc" "$T3REV" "$T3ZA::T3段落甲：负责结算清算中台，日均百万单（定制）" '[{"operationId":"t3-op-1","changeId":"t3-c1","action":"accept","origText":"T3段落甲：负责结算系统，日均百万单"}]'
R=$(curl -s -X POST "$B/save?id=$JOB2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/t3-acc.json")
echo "$R" | grep -q '"ok":true' || fail "S4a 反例a 接受失败: $(echo "$R" | head -c 200)"
echo "$R" | grep -q '"appliedOps":\["t3-op-1"\]' || fail 'S4a 反例a 回执缺 appliedOps'
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c = m.job.changes.find((x) => x.id === "t3-c1");
if (c.status !== "accepted" || c.origText !== "T3段落甲：负责结算系统，日均百万单" || c.appliedText !== "T3段落甲：负责结算清算中台，日均百万单（定制）" || !c.acceptedAt) { console.error("❌ S4a 接受快照: " + JSON.stringify(c)); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$JOB2" || fail 'S4a 反例a 接受快照落账'
cp "$RESUME_ROOT/docs/$JOB2.html" "$TEST_DIR/t3-cur.html"   # 撤回基于接受后的磁盘正文
t3_body "$TEST_DIR/t3-rev.json" "t3-req-rev" "$((T3REV+1))" "$T3ZA::T3段落甲：负责结算系统，日均百万单" '[{"operationId":"t3-op-2","changeId":"t3-c1","action":"revert","origText":"T3段落甲：负责结算清算中台，日均百万单（定制）"}]'
R=$(curl -s -X POST "$B/save?id=$JOB2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/t3-rev.json")
echo "$R" | grep -q '"ok":true' || fail "S4a 反例a 撤回失败: $(echo "$R" | head -c 200)"
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c = m.job.changes.find((x) => x.id === "t3-c1");
if (c.status !== "pending" || c.origText !== undefined || c.appliedText !== undefined || c.acceptedAt !== undefined) { console.error("❌ S4a 撤回清快照: " + JSON.stringify(c)); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$JOB2" || fail 'S4a 反例a 撤回清快照回 pending'
REV_AFTER_REVERT=$((T3REV+2))
MTIME_BEFORE=$(node -e 'console.log(require("fs").statSync(process.argv[1]).mtimeMs)' "$RESUME_ROOT/docs/$JOB2.html")
SNAPS_BEFORE=$(find "$RESUME_ROOT/snapshots/$JOB2" -maxdepth 1 -name '*.html' 2>/dev/null | wc -l | tr -d ' ')
# 旧接受请求重试：同 requestId 同内容 → 只回执，零重写（正文/change/rev/mtime/快照数全部保持撤回后状态）
R=$(curl -s -X POST "$B/save?id=$JOB2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/t3-acc.json")
echo "$R" | grep -q '"deduped":true' || fail "S4a 反例a 重试未走回执: $(echo "$R" | head -c 200)"
echo "$R" | grep -q "\"rev\":$((T3REV+1))" || fail 'S4a 反例a 重试应返回旧回执的 rev'
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c = m.job.changes.find((x) => x.id === "t3-c1");
if (c.status !== "pending" || c.origText !== undefined || m.rev !== Number(process.argv[3])) { console.error("❌ S4a 反例a 重试重放了操作: status=" + c.status + " rev=" + m.rev); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$JOB2" "$REV_AFTER_REVERT" || fail 'S4a 反例a 重试不得重放'
MTIME_AFTER=$(node -e 'console.log(require("fs").statSync(process.argv[1]).mtimeMs)' "$RESUME_ROOT/docs/$JOB2.html")
[ "$MTIME_AFTER" = "$MTIME_BEFORE" ] || fail 'S4a 反例a 重试改动了正文 mtime（零重写被破坏）'
SNAPS_AFTER=$(find "$RESUME_ROOT/snapshots/$JOB2" -maxdepth 1 -name '*.html' 2>/dev/null | wc -l | tr -d ' ')
[ "$SNAPS_AFTER" = "$SNAPS_BEFORE" ] || fail "S4a 反例a 重试改动了快照数（$SNAPS_BEFORE→$SNAPS_AFTER）"
echo '✅ S4a 反例a：接受→撤回→旧接受重试只回执零重写（正文/状态/rev/mtime/快照数全不变）'

# —— 反例 b：同 requestId 不同内容 → 400 ——
node -e 'const fs=require("fs");const b=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));b.html+=" ";fs.writeFileSync(process.argv[2],JSON.stringify(b));' "$TEST_DIR/t3-acc.json" "$TEST_DIR/t3-acc-diff.json"
CODE=$(curl -s -o "$TEST_DIR/t3-b-resp.json" -w '%{http_code}' -X POST "$B/save?id=$JOB2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/t3-acc-diff.json")
[ "$CODE" = "400" ] || fail "S4a 反例b 同 ID 不同内容应 400 得 $CODE"
grep -q '不同' "$TEST_DIR/t3-b-resp.json" || fail 'S4a 反例b 错误信息应指明内容不同'
echo '✅ S4a 反例b：重复 requestId 不同内容 → 400'

# —— 反例 c：baseRev 未来值 → 409（与落后区分）——
CODE=$(curl -s -o "$TEST_DIR/t3-c-resp.json" -w '%{http_code}' -X POST "$B/save?id=$JOB2" -H 'Content-Type: application/json' -d "{\"requestId\":\"t3-req-fut\",\"baseRev\":$((REV_AFTER_REVERT+5)),\"html\":\"<html><body>x</body></html>\",\"ops\":[]}")
[ "$CODE" = "409" ] || fail "S4a 反例c 未来 baseRev 应 409 得 $CODE"
grep -q '未来' "$TEST_DIR/t3-c-resp.json" || fail "S4a 反例c 错误信息应区分未来: $(cat "$TEST_DIR/t3-c-resp.json")"
CODE=$(curl -s -o "$TEST_DIR/t3-c2-resp.json" -w '%{http_code}' -X POST "$B/save?id=$JOB2" -H 'Content-Type: application/json' -d "{\"requestId\":\"t3-req-old\",\"baseRev\":$((REV_AFTER_REVERT-1)),\"html\":\"<html><body>x</body></html>\",\"ops\":[]}")
[ "$CODE" = "409" ] || fail "S4a 反例c 落后 baseRev 应 409 得 $CODE"
grep -q '落后' "$TEST_DIR/t3-c2-resp.json" || fail "S4a 反例c 错误信息应区分落后: $(cat "$TEST_DIR/t3-c2-resp.json")"
echo '✅ S4a 反例c：baseRev 严格相等（未来与落后 409 且信息区分）'

# —— 附加 e：坏操作整份拒绝（400 + 正文未保存 + 指明坏 op）——
T3DISK_MD5=$(md5 -q "$RESUME_ROOT/docs/$JOB2.html")
T3DISK_REV=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].rev)' "$RESUME_ROOT/docs-meta.json" "$JOB2")
T3ZB_AFTER=$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].job.changes.find(c=>c.id==="t3-c2").after))' "$RESUME_ROOT/docs-meta.json" "$JOB2")
cp "$RESUME_ROOT/docs/$JOB2.html" "$TEST_DIR/t3-cur.html"
# 多段落替换的 JSON 体组装（反例 d 与附加 e 共用形状；差别只在 ops）
t3_multi_body() { # $1=输出文件 $2=requestId $3=baseRev $4=ops(JSON)；正文 = t3-cur.html 三段替换（甲回原文、乙=T3ZB_AFTER、丙=精简版）
  node -e '
  const fs = require("fs");
  const [out, rid, baseRev, ops, za, zb, zc, afterB, src] = process.argv.slice(1);
  let h = fs.readFileSync(src, "utf8");
  for (const [zid, txt] of [[za, "T3段落甲：负责结算系统，日均百万单"], [zb, JSON.parse(afterB)], [zc, "T3段落丙：主导灰度平台（精简）"]])
    h = h.replace(new RegExp(`(<p[^>]*data-zid="${zid}"[^>]*>)[\\s\\S]*?(</p>)`), (mm, a, b) => a + txt + b);
  fs.writeFileSync(out, JSON.stringify({ requestId: rid, baseRev: Number(baseRev), html: h, ops: JSON.parse(ops) }));
  ' "$1" "$2" "$3" "$4" "$T3ZA" "$T3ZB" "$T3ZC" "$T3ZB_AFTER" "$TEST_DIR/t3-cur.html"
}
t3_multi_body "$TEST_DIR/t3-bad.json" "t3-req-badmulti" "$REV_AFTER_REVERT" '[{"operationId":"t3-op-b1","changeId":"t3-c2","action":"accept","origText":"T3段落乙：负责库存中台"},{"operationId":"t3-op-b2","changeId":"幽灵候选","action":"accept","origText":"x"}]'
CODE=$(curl -s -o "$TEST_DIR/t3-e-resp.json" -w '%{http_code}' -X POST "$B/save?id=$JOB2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/t3-bad.json")
[ "$CODE" = "400" ] || fail "S4a 附加e 坏操作整份应 400 得 $CODE"
grep -q '"badOp":"t3-op-b2"' "$TEST_DIR/t3-e-resp.json" || fail "S4a 附加e 应指明坏 op: $(cat "$TEST_DIR/t3-e-resp.json")"
grep -q 'changeId 不存在' "$TEST_DIR/t3-e-resp.json" || fail 'S4a 附加e 应给出失败原因'
[ "$(md5 -q "$RESUME_ROOT/docs/$JOB2.html")" = "$T3DISK_MD5" ] || fail 'S4a 附加e 坏操作保存仍写了正文'
T3REV_NOW=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].rev)' "$RESUME_ROOT/docs-meta.json" "$JOB2")
[ "$T3REV_NOW" = "$T3DISK_REV" ] || fail "S4a 附加e 坏操作推进了 rev（$T3DISK_REV→$T3REV_NOW）"
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
if (m.job.changes.some((x) => x.id === "t3-c2" && x.status !== "pending")) { console.error("❌ S4a 附加e 整份拒绝仍应用了第一条"); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$JOB2" || fail 'S4a 附加e 整份拒绝不得应用任何一条'
echo '✅ S4a 附加e：坏操作整份拒绝（400 + 正文未保存 + rev 不动 + 指明坏 op）'

# —— 反例 d：中文长文本（换行/引号/emoji）+ 含 <!-- 、--> 、</div> 字面量经 JSON 体安全往返 + 批量多 op ——
t3_multi_body "$TEST_DIR/t3-multi.json" "t3-req-multi" "$REV_AFTER_REVERT" '[{"operationId":"t3-op-d1","changeId":"t3-c2","action":"accept","origText":"T3段落乙：负责库存中台"},{"operationId":"t3-op-d2","changeId":"t3-c3","action":"accept","origText":"T3段落丙：主导灰度发布平台"}]'
R=$(curl -s -X POST "$B/save?id=$JOB2" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/t3-multi.json")
echo "$R" | grep -q '"appliedOps":\["t3-op-d1","t3-op-d2"\]' || fail "S4a 反例d 批量多 op 失败: $(echo "$R" | head -c 240)"
grep -qF '<!-- 开头与 --> 结尾及 </div> 字面量' "$RESUME_ROOT/docs/$JOB2.html" || fail 'S4a 反例d 分隔符字面量未落盘正文'
grep -q '🎉' "$RESUME_ROOT/docs/$JOB2.html" || fail 'S4a 反例d emoji 未落盘'
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c2 = m.job.changes.find((x) => x.id === "t3-c2");
const c3 = m.job.changes.find((x) => x.id === "t3-c3");
const expect = "第一行：负责库存中台重构\n第二行：\"引用\"与 \u0027单引号\u0027 🎉\n含分隔符 <!-- 开头与 --> 结尾及 </div> 字面量";
if (c2.status !== "accepted" || c2.appliedText !== expect) { console.error("❌ S4a 反例d appliedText 往返失真: " + JSON.stringify(c2.appliedText)); process.exit(1); }
if (!c3.acceptedAt) { console.error("❌ S4a 反例d 第二条未落账"); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$JOB2" || fail 'S4a 反例d 长文本/emoji/分隔符经 JSON 体往返失真'
echo '✅ S4a 反例d：中文长文本+HTML 分隔符字面量+emoji 经 JSON 体安全往返（单请求批量 2 op）'

# —— /job/changes GET 新字段渐进默认（旧草稿无字段全功能可用）——
curl -s "$B/job/changes?id=$JOB2" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const j = JSON.parse(s).job;
  const bad = (c, m) => { console.error("❌ S4a /job/changes 默认值 " + m); process.exit(1); };
  if (!j.brief || j.brief.degree !== "refocus" || j.brief.pages !== 2 || !Array.isArray(j.brief.focus)) bad(0, "brief");
  if (!Array.isArray(j.evidence) || j.evidenceGen !== 0) bad(0, "evidence/evidenceGen");
  if (!j.genTasks || j.genTasks.evidence.status !== "idle" || j.genTasks.changes.taskId !== null) bad(0, "genTasks");
  if (!j.saveReceipts || typeof j.saveReceipts.count !== "number" || j.saveReceipts.lastRequestId !== "t3-req-multi") bad(0, "saveReceipts 摘要: " + JSON.stringify(j.saveReceipts));
  if (!j.reviewPos || j.reviewPos.changeId !== null || j.reviewPos.filter !== "all") bad(0, "reviewPos");
});' || fail 'S4a /job/changes GET 新字段默认值'
echo '✅ S4a /job/changes GET 新字段渐进默认（brief/evidence/genTasks/saveReceipts 摘要/reviewPos）'

# —— 附加 f：事务失败共同恢复（RESUME_TEST_SAVE_GAP_MS 模拟两次 rename 之间被杀 → 重启恢复正文与 meta 一致）——
# kill -9 只针对本测试自起的夹具服务（模拟进程崩溃，无 trap 可走）；主服务与真实数据不涉及。
GAPDOC=$(curl -s -X POST "$B/new" -o /dev/null -w '%{redirect_url}' | sed 's/.*id=//')
[ -n "$GAPDOC" ] && [ -f "$RESUME_ROOT/docs/$GAPDOC.html" ] || fail 'S4a 附加f 夹具文档创建'
curl -s -X POST "$B/save?id=$GAPDOC" --data-binary "<html><body><p>GAP-BASE 基线</p></body></html>" | grep -q '"ok":true' || fail 'S4a 附加f 基线保存'
GAPREV=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].rev)' "$RESUME_ROOT/docs-meta.json" "$GAPDOC")
PORT2=17902
RESUME_TEST_SAVE_GAP_MS=2500 PORT=$PORT2 node server.mjs > "$TEST_DIR/s4a-srv2.log" 2>&1 & SRV2=$!
sleep 0.6
kill -0 $SRV2 2>/dev/null || fail 'S4a 附加f 夹具服务启动失败'
node -e '
const fs = require("fs");
const h = fs.readFileSync(process.argv[2], "utf8").replace("GAP-BASE 基线", "GAP-MARKER 已写入新正文");
fs.writeFileSync(process.argv[1], JSON.stringify({ requestId: "t3-req-gap", baseRev: Number(process.argv[3]), html: h, ops: [] }));
' "$TEST_DIR/t3-gap.json" "$RESUME_ROOT/docs/$GAPDOC.html" "$GAPREV"
curl -s --max-time 20 -X POST "http://localhost:$PORT2/save?id=$GAPDOC" -H 'Content-Type: application/json' --data-binary "@$TEST_DIR/t3-gap.json" > "$TEST_DIR/t3-gap-resp.json" 2>/dev/null &
GAPCURL=$!
sleep 0.9          # 停在 rename#1（正文已写）与 rename#2（meta 未写）之间
kill -9 $SRV2 2>/dev/null
wait $GAPCURL 2>/dev/null || true   # 被杀服务的响应必然失败（curl 非零）——这正是夹具要的形态
grep -q '"ok":true' "$TEST_DIR/t3-gap-resp.json" && fail 'S4a 附加f 中断的保存不应有成功响应'
grep -q 'GAP-MARKER' "$RESUME_ROOT/docs/$GAPDOC.html" || fail 'S4a 附加f 夹具未进入「正文已写、meta 未写」窗口（调整时序）'
GAPREV_MID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].rev)' "$RESUME_ROOT/docs-meta.json" "$GAPDOC")
[ "$GAPREV_MID" = "$GAPREV" ] || fail "S4a 附加f 中断点 meta rev 应未推进（$GAPREV→$GAPREV_MID）"
PORT=$PORT2 node server.mjs > "$TEST_DIR/s4a-srv3.log" 2>&1 & SRV3=$!
sleep 0.8
grep -q 'GAP-MARKER' "$RESUME_ROOT/docs/$GAPDOC.html" && fail 'S4a 附加f 重启后未恢复旧正文'
GAPREV_AFTER=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]].rev)' "$RESUME_ROOT/docs-meta.json" "$GAPDOC")
[ "$GAPREV_AFTER" = "$GAPREV" ] || fail "S4a 附加f 恢复后 rev 应回到基线（$GAPREV→$GAPREV_AFTER）"
TXLEFT=$(find "$RESUME_ROOT/.tx" -name '*.json' ! -name '*.meta.json' 2>/dev/null | wc -l | tr -d ' ')
[ "$TXLEFT" = "0" ] || fail "S4a 附加f 恢复后 .tx 应清空（剩 $TXLEFT 条）"
echo '✅ S4a 附加f：保存中断后重启恢复（旧正文+旧 meta 一致、.tx 清空）'

# ===== S4a-T4：AI 任务可靠性（gen-start 锁内扫描 / 三类回调 taskId / 双层超时 / 取消 / 重启恢复）=====
# 夹具：独立岗位草稿 T4DOC（无历史 changes，计数干净）；跨文档夹具复用 JOB2；stub 延迟/错误走控制文件。
T4DOC=$(curl -s -X POST "$B/job/create" -H 'Content-Type: application/json' -d "{\"from\":\"$DOCID\",\"company\":\"任务可靠性公司\",\"role\":\"后端\",\"jd\":\"S4a-T4 验证\"}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id||'')}catch{console.log('')}})")
[ -n "$T4DOC" ] && [ -f "$RESUME_ROOT/docs/$T4DOC.html" ] || fail 'S4a-T4 夹具岗位草稿创建'
gt_status() { # $1=doc $2=kind → genTasks[kind].status（经 /job/changes，读取时超时清理随之生效）
  curl -s "$B/job/changes?id=$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s).job;console.log(((j.genTasks||{})[process.argv[1]]||{}).status||"")}catch{console.log("")}})' "$2"
}
gt_taskid() { # $1=doc $2=kind → genTasks[kind].taskId
  curl -s "$B/job/changes?id=$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s).job;console.log(((j.genTasks||{})[process.argv[1]]||{}).taskId||"")}catch{console.log("")}})' "$2"
}
gt_error() { # $1=doc $2=kind → genTasks[kind].error
  curl -s "$B/job/changes?id=$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s).job;console.log(((j.genTasks||{})[process.argv[1]]||{}).error||"")}catch{console.log("")}})' "$2"
}
wait_gt() { # $1=doc $2=kind $3=期望status $4=超时秒（默认 15）
  local i; for i in $(seq 1 $(( ${4:-15} * 4 ))); do
    [ "$(gt_status "$1" "$2")" = "$3" ] && return 0
    sleep 0.25
  done
  return 1
}
t4_count() { # 直接读 meta（无 GET 副作用）：T4DOC 的 changes 条数
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];console.log(m&&m.job&&Array.isArray(m.job.changes)?m.job.changes.length:-1)' "$RESUME_ROOT/docs-meta.json" "$T4DOC"
}
t4_age_task() { # $1=kind $2=taskId → 把该任务改写为「running 且 startedAt=11 分钟前」（过期残留夹具）
  node -e 'const fs=require("fs");const f=process.argv[1],doc=process.argv[2],kind=process.argv[3],tid=process.argv[4];
  const m=JSON.parse(fs.readFileSync(f,"utf8"));
  const j=m[doc].job; j.genTasks=j.genTasks||{};
  const t=j.genTasks[kind]||{};
  j.genTasks[kind]={taskId:tid,status:"running",startedAt:Date.now()-11*60*1000,baseHash:(t.baseHash==null?null:t.baseHash),error:null,scope:(t.scope==null?null:t.scope)};
  fs.writeFileSync(f,JSON.stringify(m));' "$RESUME_ROOT/docs-meta.json" "$T4DOC" "$1" "$2"
}
t4_config_timeout() { # $1=毫秒（空串=移除，恢复默认 120s）
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));
  if(process.argv[2]){c.profiles[0].timeoutMs=Number(process.argv[2])}else{delete c.profiles[0].timeoutMs}
  fs.writeFileSync(f,JSON.stringify(c));' "$RESUME_ROOT/config.json" "$1"
}

# —— a. 原子启动：并发双击同一文档同类 → updateMetaAll 锁内只有一个 running ——
echo 5000 > "$TEST_DIR/llm-slow"
curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=changes" -o "$TEST_DIR/t4-a.json" & CA=$!
curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=changes" -o "$TEST_DIR/t4-b.json" & CB=$!
wait $CA $CB
OKN=$(grep -hc '"ok":true' "$TEST_DIR/t4-a.json" "$TEST_DIR/t4-b.json" | awk '{s+=$1}END{print s}')
[ "$OKN" = "1" ] || fail "S4a-T4 并发双击应恰一个成功（得 ${OKN}）: $(cat "$TEST_DIR/t4-a.json") | $(cat "$TEST_DIR/t4-b.json")"
T4T1=$(node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){try{const j=JSON.parse(fs.readFileSync(f,"utf8"));if(j.ok&&j.taskId){console.log(j.taskId);break}}catch{}}' "$TEST_DIR/t4-a.json" "$TEST_DIR/t4-b.json")
[ -n "$T4T1" ] || fail 'S4a-T4 成功响应缺 taskId'
CODE409=$(grep -hc '"ok":false' "$TEST_DIR/t4-a.json" "$TEST_DIR/t4-b.json" | awk '{s+=$1}END{print s}')
[ "$CODE409" = "1" ] || fail 'S4a-T4 双击的败者应拿到 ok:false（409）'
grep -h '正在进行中' "$TEST_DIR/t4-a.json" "$TEST_DIR/t4-b.json" | grep -q . || fail 'S4a-T4 同文档同类 409 应说明任务正在进行中'
[ "$(gt_status "$T4DOC" changes)" = 'running' ] || fail 'S4a-T4 启动后应为 running'
[ "$(gt_taskid "$T4DOC" changes)" = "$T4T1" ] || fail 'S4a-T4 running 的 taskId 与响应不一致'
# 坏 kind / 非岗位草稿
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/gen-start?id=$T4DOC&kind=nope")
[ "$CODE" = "400" ] || fail "S4a-T4 坏 kind 应 400 得 $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/gen-start?id=$DOCID&kind=changes")
[ "$CODE" = "404" ] || fail "S4a-T4 非岗位草稿应 404 得 $CODE"
echo '✅ S4a-T4 原子启动（并发双击单 running / taskId 返回 / 坏 kind 400 / 非草稿 404）'

# —— b. 跨文档并发：docA running → docB 同类被拒（updateMetaAll 锁内扫描全表）——
R=$(curl -s -X POST "$B/job/gen-start?id=$JOB2&kind=changes")
echo "$R" | grep -q '另一文档的任务进行中' || fail "S4a-T4 跨文档同类应被拒: $(echo "$R" | head -c 160)"
echo '✅ S4a-T4 跨文档并发（锁内扫描各文档 genTasks，同类 ≤1）'

# —— c. 两任务独立：changes running 时 evidence 可启动，互不清除 ——
# （S4a-T6 后 evidence 通道为真实 runner：占位 error 断言随之改为独立完成断言；
#   先摘 slow 让 evidence 快速完成——d 节取消用例依赖 T4T1（slow=5000 在途）尚未回调）
rm -f "$TEST_DIR/llm-slow"
R=$(curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=evidence")
echo "$R" | grep -q '"ok":true' || fail "S4a-T4 evidence 任务应可独立启动: $(echo "$R" | head -c 160)"
[ "$(gt_taskid "$T4DOC" changes)" = "$T4T1" ] || fail 'S4a-T4 启动 evidence 清掉了 changes 的 taskId'
[ "$(gt_status "$T4DOC" changes)" = 'running' ] || fail 'S4a-T4 启动 evidence 干扰了 changes 的 running'
wait_gt "$T4DOC" evidence done 15 || fail "S4a-T4 evidence 任务应独立完成（得 $(gt_status "$T4DOC" evidence)）"
[ "$(gt_status "$T4DOC" changes)" = 'running' ] || fail 'S4a-T4 evidence 结束后 changes 应仍 running（互不阻塞）'
echo '✅ S4a-T4 两任务独立（evidence 启动/完成不清 changes 状态）'

# —— d. 取消：taskId 匹配才 cancelled；迟到成功回调被丢弃 ——
R=$(curl -s -X POST "$B/job/gen-cancel?id=$T4DOC&kind=changes&taskId=$T4T1")
echo "$R" | grep -q '"ok":true' || fail "S4a-T4 取消失败: $(echo "$R" | head -c 160)"
CODE=$(curl -s -o "$TEST_DIR/t4-c2.json" -w '%{http_code}' -X POST "$B/job/gen-cancel?id=$T4DOC&kind=changes&taskId=$T4T1")
[ "$CODE" = "409" ] || fail "S4a-T4 重复取消应 409 得 $CODE"
sleep 5.6   # 迟到的成功回调（slow=5000）到达 → taskId 校验不过 → 丢弃
[ "$(gt_status "$T4DOC" changes)" = 'cancelled' ] || fail "S4a-T4 迟到成功回调污染了 cancelled 状态（得 $(gt_status "$T4DOC" changes)）"
[ "$(t4_count)" = "0" ] || fail "S4a-T4 取消后的迟到成功仍落了 changes（$(t4_count) 条）"
echo '✅ S4a-T4 取消带 taskId（重复取消 409 / 迟到成功回调丢弃不落盘）'

# —— d2. 迟到错误回调同样丢弃 ——
rm -f "$TEST_DIR/llm-slow"
touch "$TEST_DIR/llm-err"
T4TE=$(curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=changes" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.ok?j.taskId:"")})')
[ -n "$T4TE" ] || fail 'S4a-T4 错误路径夹具启动失败'
curl -s -X POST "$B/job/gen-cancel?id=$T4DOC&kind=changes&taskId=$T4TE" -o /dev/null
sleep 6   # 5xx 经 withRetry 重试 2 次后错误回调到达 → 已取消 → 丢弃
[ "$(gt_status "$T4DOC" changes)" = 'cancelled' ] || fail "S4a-T4 迟到错误回调污染 cancelled（得 $(gt_status "$T4DOC" changes)）"
gt_error "$T4DOC" changes | grep -q . && fail 'S4a-T4 迟到错误回调被落账（error 字段应保持空）'
rm -f "$TEST_DIR/llm-err"
echo '✅ S4a-T4 迟到错误回调丢弃（error 不落账）'

# —— e. 取消不误伤新任务：旧 taskId 取消 → 409 且新任务照常完成 ——
R=$(curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=changes")
echo "$R" | grep -q '"ok":true' || fail "S4a-T4 取消后重新启动失败: $(echo "$R" | head -c 160)"
T4T2=$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).taskId)})')
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/gen-cancel?id=$T4DOC&kind=changes&taskId=$T4T1")
[ "$CODE" = "409" ] || fail "S4a-T4 旧 taskId 取消新任务应 409 得 $CODE"
wait_gt "$T4DOC" changes done 15 || fail "S4a-T4 新任务未完成（得 $(gt_status "$T4DOC" changes)）"
[ "$(t4_count)" = "2" ] || fail "S4a-T4 成功回调应落 2 条 changes（得 $(t4_count)）"
echo '✅ S4a-T4 取消不误伤新任务（旧 taskId 409 / 新任务正常完成落账）'

# —— f. 请求级超时：config timeoutMs 覆盖 → 任务 error ——
# slow=100 保证请求耗时 ≥100ms：无它时本地 stub 往返可 <1ms 抢在 AbortSignal.timeout(1) 前完成 → 偶发 done（实测 flake）
echo 100 > "$TEST_DIR/llm-slow"
t4_config_timeout 1
R=$(curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=changes")
echo "$R" | grep -q '"ok":true' || fail 'S4a-T4 超时夹具启动失败'
wait_gt "$T4DOC" changes error 25 || fail "S4a-T4 请求级超时应落 error（得 $(gt_status "$T4DOC" changes)）"
gt_error "$T4DOC" changes | grep -q '模型调用失败' || fail "S4a-T4 请求级超时错误信息异常: $(gt_error "$T4DOC" changes)"
[ "$(t4_count)" = "2" ] || fail 'S4a-T4 超时不得落 changes'
t4_config_timeout ''
rm -f "$TEST_DIR/llm-slow"   # slow 只为超时夹具兜底耗时，恢复配置后移除（重试须正常完成）
R=$(curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=changes")
echo "$R" | grep -q '"ok":true' || fail 'S4a-T4 恢复配置后重试启动失败'
wait_gt "$T4DOC" changes done 15 || fail "S4a-T4 重试未完成（得 $(gt_status "$T4DOC" changes)）"
[ "$(t4_count)" = "4" ] || fail "S4a-T4 重试应再落 2 条（得 $(t4_count)）"
echo '✅ S4a-T4 请求级超时（timeoutMs 覆盖 → error）+ 失败重试可用'

# —— g. 任务级总时限·读取时：过期 running 在 /job/changes 组装前被清为 error，且不落账 ——
CNT_BEFORE=$(t4_count)
t4_age_task changes t-legacy01
[ "$(gt_status "$T4DOC" changes)" = 'error' ] || fail "S4a-T4 读取时应清过期 running（得 $(gt_status "$T4DOC" changes)）"
gt_error "$T4DOC" changes | grep -q '任务超时' || fail 'S4a-T4 读取时清理应标任务超时'
[ "$(t4_count)" = "$CNT_BEFORE" ] || fail 'S4a-T4 读取时清理不得落 changes'
echo '✅ S4a-T4 任务级总时限·读取时（过期 running → error 且不落账）'

# —— h. 任务级总时限·完成回调时：过期回调不落账 ——
# 断言直读 meta（同 t4_count 模式），不经 GET sweep：隔离「finishGenTask 锁内 genExpired 路径」，
# 不与「读取时清理」（g 节已覆盖）混淆——两条路径各有独立断言。
gt_meta() { # $1=doc $2=kind → 直接读 meta 的 "status error"（无 GET 副作用）
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=((m[process.argv[2]].job||{}).genTasks||{})[process.argv[3]]||{};console.log((t.status||"")+" "+(t.error==null?"":t.error))' "$RESUME_ROOT/docs-meta.json" "$1" "$2"
}
wait_gtm() { # $1=doc $2=kind $3=期望status $4=超时秒（默认 15）
  local i; for i in $(seq 1 $(( ${4:-15} * 4 ))); do
    [ "$(gt_meta "$1" "$2" | awk '{print $1}')" = "$3" ] && return 0
    sleep 0.25
  done
  return 1
}
echo 2000 > "$TEST_DIR/llm-slow"
T4T3=$(curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=changes" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).taskId)})')
t4_age_task changes "$T4T3"   # 启动后立刻把 startedAt 改老 → 回调到达时已过期
rm -f "$TEST_DIR/llm-slow"
wait_gtm "$T4DOC" changes error 15 || fail "S4a-T4 过期回调应判 error（得 $(gt_meta "$T4DOC" changes)）"
gt_meta "$T4DOC" changes | grep -q '任务超时' || fail 'S4a-T4 过期回调应标任务超时（回调路径直读 meta）'
[ "$(t4_count)" = "$CNT_BEFORE" ] || fail "S4a-T4 过期回调仍落了 changes（$(t4_count) 条）"
echo '✅ S4a-T4 任务级总时限·完成回调时（过期回调不落账）'

# —— i. 任务级总时限·启动时：过期残留不阻塞新任务（拒过期残留）——
t4_age_task changes t-old0001
R=$(curl -s -X POST "$B/job/gen-start?id=$T4DOC&kind=changes")
echo "$R" | grep -q '"ok":true' || fail "S4a-T4 过期残留阻塞了新任务: $(echo "$R" | head -c 160)"
wait_gt "$T4DOC" changes done 15 || fail "S4a-T4 残留清理后新任务未完成（得 $(gt_status "$T4DOC" changes)）"
[ "$(t4_count)" = "$((CNT_BEFORE+2))" ] || fail "S4a-T4 新任务应落 2 条（得 $(t4_count)）"
echo '✅ S4a-T4 任务级总时限·启动时（过期残留不阻新任务）'

# —— j. 重启恢复：隔离服务杀重启 → running → error(重启中断) 且 taskId=null ——
echo 3000 > "$TEST_DIR/llm-slow"
PORT2=17903
PORT=$PORT2 node server.mjs > "$TEST_DIR/s4a-t4-srv2.log" 2>&1 & SRV2=$!
sleep 0.6
kill -0 $SRV2 2>/dev/null || fail 'S4a-T4 重启夹具服务启动失败'
T4T5=$(curl -s -X POST "http://localhost:$PORT2/job/gen-start?id=$T4DOC&kind=changes" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.ok?j.taskId:"")})')
[ -n "$T4T5" ] || fail 'S4a-T4 重启夹具任务启动失败'
sleep 0.5          # 任务仍在 LLM 等待中（slow=3000）
kill -9 $SRV2 2>/dev/null
rm -f "$TEST_DIR/llm-slow"
[ "$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];const t=m.job.genTasks.changes;console.log(t.status+" "+t.taskId)' "$RESUME_ROOT/docs-meta.json" "$T4DOC")" = "running $T4T5" ] || fail 'S4a-T4 重启夹具未处于 running'
PORT=$PORT2 node server.mjs > "$TEST_DIR/s4a-t4-srv3.log" 2>&1 & SRV3=$!
sleep 0.8
[ "$(gt_taskid "$T4DOC" changes)" = '' ] || fail "S4a-T4 重启恢复应置 taskId=null（得 $(gt_taskid "$T4DOC" changes)）"
[ "$(gt_status "$T4DOC" changes)" = 'error' ] || fail "S4a-T4 重启恢复应置 error（得 $(gt_status "$T4DOC" changes)）"
gt_error "$T4DOC" changes | grep -q '重启中断' || fail 'S4a-T4 重启恢复错误应说明中断可重试'
[ "$(t4_count)" = "$((CNT_BEFORE+2))" ] || fail 'S4a-T4 重启恢复不得改动已落盘 changes'
echo '✅ S4a-T4 重启恢复（running → error(重启中断) + taskId 置空 + 落盘数据不动）'

# ===== S4a-T6：证据表后端（runner 接入 / ID 匹配 / 批次替换时点 / 来源即时计算 / reviewPos）=====
# 夹具：独立岗位草稿 T6DOC（挂已确认素材「素材甲」——$MATID 已被 S3 段复用指向他表，按标题重解析；
# 先保存一次让 zid 归一与 zoneSync 有真实输入）。
T6MAT=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const x=m.find(v=>v.title==="素材甲");console.log(x?x.id:"")' "$RESUME_ROOT/materials.json")
[ -n "$T6MAT" ] || fail 'S4a-T6 夹具素材（素材甲）缺失'
T6DOC=$(curl -s -X POST "$B/job/create" -H 'Content-Type: application/json' -d "{\"from\":\"$DOCID\",\"company\":\"证据公司\",\"role\":\"后端\",\"jd\":\"S4a-T6 JD-EVIDENCE-MARK 验证\",\"materials\":[\"$T6MAT\"]}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id||'')}catch{console.log('')}})")
[ -n "$T6DOC" ] && [ -f "$RESUME_ROOT/docs/$T6DOC.html" ] || fail 'S4a-T6 夹具岗位草稿创建'
curl -s -X POST "$B/save?id=$T6DOC" --data-binary "$(cat "$RESUME_ROOT/docs/$T6DOC.html")" | grep -q '"ok":true' || fail 'S4a-T6 夹具保存（zid 归一 + zoneSync）'
t6_changes() { # 直接读 meta（无 GET 副作用）：T6DOC 的 changes 条数
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];console.log(m&&m.job&&Array.isArray(m.job.changes)?m.job.changes.length:-1)' "$RESUME_ROOT/docs-meta.json" "$T6DOC"
}
t6_ev_bytes() { # evidence 数组 + evidenceGen 的规范化串（反例2 逐字节不变断言用）
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];console.log(JSON.stringify({e:m.job.evidence,gen:m.job.evidenceGen}))' "$RESUME_ROOT/docs-meta.json" "$T6DOC"
}

# —— a. evidence runner 真实接入：prompt 只含已确认素材 facts+区域段落；refHints 按 ID 返回并解析落账 ——
R=$(curl -s -X POST "$B/job/gen-start?id=$T6DOC&kind=evidence")
echo "$R" | grep -q '"ok":true' || fail "S4a-T6 evidence 任务启动失败: $(echo "$R" | head -c 160)"
wait_gt "$T6DOC" evidence done 15 || fail "S4a-T6 evidence 任务未完成（得 $(gt_status "$T6DOC" evidence)）"
grep -q 'JD-EVIDENCE-MARK' "$TEST_DIR/llm-last.json" || fail 'S4a-T6 证据 prompt 未含 JD'
grep -q '素材甲' "$TEST_DIR/llm-last.json" || fail 'S4a-T6 证据 prompt 未含已确认素材'
grep -q '不应参与生成' "$TEST_DIR/llm-last.json" && fail 'S4a-T6 证据 prompt 混入未确认素材'
grep -q '（id：' "$TEST_DIR/llm-last.json" || fail 'S4a-T6 证据 prompt 素材块缺请求内 id'
grep -q '（zid：' "$TEST_DIR/llm-last.json" || fail 'S4a-T6 证据 prompt 段落缺请求内 zid'
grep -q '【区域：' "$TEST_DIR/llm-last.json" || fail 'S4a-T6 证据 prompt 未按区域分组'
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const bad = (msg) => { console.error("❌ S4a-T6 落账 " + msg); process.exit(1); };
const ev = m.job.evidence || [];
if (m.job.evidenceGen !== 1) bad("evidenceGen 应为 1（得 " + m.job.evidenceGen + "）");
if (ev.length !== 4) bad("evidence 应 4 条（得 " + ev.length + "）");
const e1 = ev[0], e2 = ev[1], e3 = ev[2], e4 = ev[3];
if (e1.status !== "covered" || e1.refs.length !== 1 || e1.refs[0].type !== "para" || !/^z[0-9a-f]{8}$/.test(e1.refs[0].zid || "")) bad("条1 para ref: " + JSON.stringify(e1));
if (e1.refs[0].refId !== "b1r1") bad("条1 refId 应 b1r1（得 " + e1.refs[0].refId + "）");
if (!fs.readFileSync(process.argv[3], "utf8").includes(e1.refs[0].zid)) bad("条1 zid 不在正文");
if (e1.refs[0].title !== "工作经历") bad("条1 title/quote 应保留仅展示: " + JSON.stringify(e1.refs[0]));
if (e2.status !== "sourced" || e2.refs[0].type !== "mat" || e2.refs[0].id !== process.argv[4]) bad("条2 mat ref: " + JSON.stringify(e2));
if (e2.refs[0].refId !== "b1r2" || e2.refs[0].srcStatus !== "confirmed" || !/^[0-9a-f]{40}$/.test(e2.refs[0].hash || "")) bad("条2 refId/srcStatus/hash: " + JSON.stringify(e2.refs[0]));
// ID 精确匹配：幽灵 ID（形状合法但不在输入集合）→ ref 丢弃
if (e3.status !== "todo" || (e3.refs || []).length !== 0) bad("条3 全无效引用应降 todo 且 ref 丢弃: " + JSON.stringify(e3));
// 六项之六：模型输出 covered 但无任何有效 ref → 解析降 todo（无有效来源不得 sourced/covered）
if (e4.status !== "todo") bad("条4 无引用 covered 应降 todo（得 " + e4.status + "）");
for (const e of ev) if (e.note !== "" || e.noteConfirmed !== false || !/^e\d+$/.test(e.id || "")) bad("条目默认字段: " + JSON.stringify(e));
' "$RESUME_ROOT/docs-meta.json" "$T6DOC" "$RESUME_ROOT/docs/$T6DOC.html" "$T6MAT" || fail 'S4a-T6 证据落账（ID 匹配/五态校正/refId 分配/批次替换）'
echo '✅ S4a-T6 evidence runner（prompt 只含已确认素材+区域段落；ID 匹配解析；无效引用丢弃与降 todo）'

# —— b. 两任务独立（evidence running 不阻塞 changes；各自落账互不清）——
echo 2500 > "$TEST_DIR/llm-slow"
R=$(curl -s -X POST "$B/job/gen-start?id=$T6DOC&kind=evidence")
echo "$R" | grep -q '"ok":true' || fail "S4a-T6 evidence 二次启动失败: $(echo "$R" | head -c 160)"
R2=$(curl -s -X POST "$B/job/gen-start?id=$T6DOC&kind=changes")
echo "$R2" | grep -q '"ok":true' || fail "S4a-T6 evidence running 时 changes 应可独立启动: $(echo "$R2" | head -c 160)"
wait_gt "$T6DOC" evidence done 15 || fail "S4a-T6 二次 evidence 未完成（得 $(gt_status "$T6DOC" evidence)）"
wait_gt "$T6DOC" changes done 15 || fail "S4a-T6 changes 未完成（得 $(gt_status "$T6DOC" changes)）"
rm -f "$TEST_DIR/llm-slow"
[ "$(t6_changes)" = "2" ] || fail "S4a-T6 changes 应落 2 条（得 $(t6_changes)）"
node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];if(m.job.evidenceGen!==2||!(m.job.evidence||[]).every(e=>e.refs.every(r=>String(r.refId).startsWith("b2")))){console.error("❌ S4a-T6 二次生成批次应整批替换为 b2 前缀");process.exit(1)}' "$RESUME_ROOT/docs-meta.json" "$T6DOC" || fail 'S4a-T6 二次证据生成批次替换（b2 前缀整批）'
echo '✅ S4a-T6 两任务独立（evidence running 不阻塞 changes；新批次整批替换 refId 不复用）'

# —— c. 反例2：取消丢弃迟到回调 / 任务失败——旧 evidence 数组与 evidenceGen 逐字节不变 ——
EV_BEFORE=$(t6_ev_bytes)
echo 4000 > "$TEST_DIR/llm-slow"
T6T1=$(curl -s -X POST "$B/job/gen-start?id=$T6DOC&kind=evidence" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.ok?j.taskId:"")})')
[ -n "$T6T1" ] || fail 'S4a-T6 取消夹具启动失败'
curl -s -X POST "$B/job/gen-cancel?id=$T6DOC&kind=evidence&taskId=$T6T1" | grep -q '"ok":true' || fail 'S4a-T6 evidence 取消失败'
sleep 4.6   # 迟到的成功回调到达 → taskId 校验不过 → 丢弃
[ "$(gt_status "$T6DOC" evidence)" = 'cancelled' ] || fail "S4a-T6 迟到成功回调污染了 cancelled（得 $(gt_status "$T6DOC" evidence)）"
[ "$(t6_ev_bytes)" = "$EV_BEFORE" ] || fail 'S4a-T6 取消后旧 evidence/evidenceGen 被改动（反例2）'
rm -f "$TEST_DIR/llm-slow"
touch "$TEST_DIR/llm-err"
R=$(curl -s -X POST "$B/job/gen-start?id=$T6DOC&kind=evidence")
echo "$R" | grep -q '"ok":true' || fail 'S4a-T6 失败路径夹具启动失败'
wait_gt "$T6DOC" evidence error 15 || fail "S4a-T6 evidence 失败应落 error（得 $(gt_status "$T6DOC" evidence)）"
gt_error "$T6DOC" evidence | grep -q '模型调用失败' || fail "S4a-T6 evidence 失败原因异常: $(gt_error "$T6DOC" evidence)"
[ "$(t6_ev_bytes)" = "$EV_BEFORE" ] || fail 'S4a-T6 失败后旧 evidence/evidenceGen 被改动（反例2）'
rm -f "$TEST_DIR/llm-err"
echo '✅ S4a-T6 反例2（取消/失败/迟到回调：旧 evidence 数组与 evidenceGen 逐字节不变）'

# —— S4a-T7 转交（c/d）：零有效 ref 保护门 + 非 JSON 输出——error 落账，旧 evidence/evidenceGen 逐字节不变 ——
EV_T7=$(t6_ev_bytes)
touch "$TEST_DIR/llm-ev-raw"
R=$(curl -s -X POST "$B/job/gen-start?id=$T6DOC&kind=evidence")
echo "$R" | grep -q '"ok":true' || fail "S4a-T7 非 JSON 夹具启动失败: $(echo "$R" | head -c 160)"
wait_gt "$T6DOC" evidence error 15 || fail "S4a-T7 非 JSON 输出应落 error（得 $(gt_status "$T6DOC" evidence)）"
gt_error "$T6DOC" evidence | grep -q '无法解析' || fail "S4a-T7 非 JSON 错误原因异常: $(gt_error "$T6DOC" evidence)"
[ "$(t6_ev_bytes)" = "$EV_T7" ] || fail 'S4a-T7 非 JSON 输出改动旧 evidence（旧表应逐字节不变）'
rm -f "$TEST_DIR/llm-ev-raw"
touch "$TEST_DIR/llm-ev-bad"
R=$(curl -s -X POST "$B/job/gen-start?id=$T6DOC&kind=evidence")
echo "$R" | grep -q '"ok":true' || fail "S4a-T7 全无效引用夹具启动失败: $(echo "$R" | head -c 160)"
wait_gt "$T6DOC" evidence error 15 || fail "S4a-T7 零有效 ref 应落 error（得 $(gt_status "$T6DOC" evidence)）"
gt_error "$T6DOC" evidence | grep -q '无任何有效来源引用' || fail "S4a-T7 零有效 ref 错误原因异常: $(gt_error "$T6DOC" evidence)"
[ "$(t6_ev_bytes)" = "$EV_T7" ] || fail 'S4a-T7 零有效 ref 改动旧 evidence（保护门失效）'
rm -f "$TEST_DIR/llm-ev-bad"
echo '✅ S4a-T7 保护门（非 JSON / 全无效引用：error 落账，旧 evidence/evidenceGen 逐字节不变）'

# —— S4a-T7：证据 note 两级流程端点（POST /job/changes evidenceNote 分支；模拟验证，走 stub 实例）——
R=$(curl -s -X POST "$B/job/changes?id=$T6DOC" -H 'Content-Type: application/json' -d '{"evidenceNote":{"reqId":"e1","note":"维护过 3 节点自建集群两年（个人项目仓库）"}}')
echo "$R" | grep -q '"ok":true' || fail "S4a-T7 note 保存失败: $(echo "$R" | head -c 200)"
R=$(curl -s -X POST "$B/job/changes?id=$T6DOC" -H 'Content-Type: application/json' -d '{"evidenceNote":{"reqId":"e1","confirmed":true}}')
echo "$R" | grep -q '"ok":true' || fail "S4a-T7 确认为证据失败: $(echo "$R" | head -c 200)"
curl -s "$B/job/changes?id=$T6DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const bad = (m) => { console.error("❌ S4a-T7 note 端点 " + m); process.exit(1); };
  const e1 = (JSON.parse(s).job.evidence || []).find((e) => e.id === "e1");
  if (!e1) bad("e1 缺失");
  if (e1.note !== "维护过 3 节点自建集群两年（个人项目仓库）") bad("note 未落盘: " + e1.note);
  if (e1.noteConfirmed !== true) bad("noteConfirmed 未落盘");
});' || fail 'S4a-T7 note/confirmed 落账'
# 退回：confirmed=false → noteConfirmed=false 且 note 保留
R=$(curl -s -X POST "$B/job/changes?id=$T6DOC" -H 'Content-Type: application/json' -d '{"evidenceNote":{"reqId":"e1","confirmed":false}}')
echo "$R" | grep -q '"ok":true' || fail 'S4a-T7 退回失败'
curl -s "$B/job/changes?id=$T6DOC" | grep -q '"noteConfirmed":false' || fail 'S4a-T7 退回后 noteConfirmed 应 false'
# 非法路径：不存在条目 400 / 空说明确认 400 / 坏形状 400 / 非岗位草稿 404
R=$(curl -s -X POST "$B/job/changes?id=$T6DOC" -H 'Content-Type: application/json' -d '{"evidenceNote":{"reqId":"e999","note":"x"}}')
echo "$R" | grep -q '"ok":false' || fail "S4a-T7 不存在条目应 400: $R"
R=$(curl -s -X POST "$B/job/changes?id=$T6DOC" -H 'Content-Type: application/json' -d '{"evidenceNote":{"reqId":"e2","confirmed":true}}')
echo "$R" | grep -q '先填写说明内容' || fail "S4a-T7 空说明确认应 400: $R"
R=$(curl -s -X POST "$B/job/changes?id=$T6DOC" -H 'Content-Type: application/json' -d '{"evidenceNote":{"reqId":"","note":123}}')
echo "$R" | grep -q 'evidenceNote 非法' || fail "S4a-T7 坏形状应 400: $R"
R=$(curl -s -X POST "$B/job/changes?id=$DOCID" -H 'Content-Type: application/json' -d '{"evidenceNote":{"reqId":"e1","note":"x"}}')
echo "$R" | grep -q '不是岗位草稿' || fail "S4a-T7 非岗位草稿应 404: $R"
echo '✅ S4a-T7 证据 note 两级流程端点（保存/确认/退回/四非法路径）'

# —— d. 来源维度读取时即时计算（反例6：取消素材确认不保存正文 → GET 即见失效）——
# 挂两条带 evidenceRefs 的候选（程序注入模拟依赖证据的建议）：一条引当前批次 mat ref，一条引旧批次 b0。
node -e '
const fs = require("fs");
const f = process.argv[1], doc = process.argv[2];
const m = JSON.parse(fs.readFileSync(f, "utf8"));
const refId = m[doc].job.evidence.find((e) => e.status === "sourced").refs[0].refId;
const mk = (id, refs) => ({ id, gen: 9, section: "项目经历", entry: "", kind: "replace", before: "x", after: "y", reason: "r", source: "母版", level: "normal", status: "pending", evidenceRefs: refs });
m[doc].job.changes.push(mk("t6-refdep", [refId]), mk("t6-batchold", ["b0r1"]));
fs.writeFileSync(f, JSON.stringify(m));
' "$RESUME_ROOT/docs-meta.json" "$T6DOC"
# 基线：素材仍 confirmed → mat ref fresh；旧批次 → batch-stale（GET 现算，落盘 consistency 本就为空）
curl -s "$B/job/changes?id=$T6DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const j = JSON.parse(s).job;
  const bad = (m) => { console.error("❌ S4a-T6 即时计算基线 " + m); process.exit(1); };
  const ev2 = (j.evidence || []).find((e) => e.status === "sourced");
  if (!ev2 || ev2.refs[0].fresh !== true) bad("mat ref 应 fresh: " + JSON.stringify(ev2 && ev2.refs[0]));
  if (ev2.stale === true) bad("fresh 时条目不应标 stale");
  const dep = j.changes.find((c) => c.id === "t6-refdep");
  const old = j.changes.find((c) => c.id === "t6-batchold");
  if ((dep.consistency || []).includes("ref-stale") || (dep.consistency || []).includes("batch-stale")) bad("t6-refdep 应无来源失效命中: " + JSON.stringify(dep.consistency));
  if (!(old.consistency || []).includes("batch-stale")) bad("旧批次引用应命中 batch-stale: " + JSON.stringify(old.consistency));
});' || fail 'S4a-T6 即时计算基线（fresh/batch-stale GET 现算）'
# 反例6：取消素材确认（factStatus→outdated，内容指纹未变）→ 不保存简历正文，GET 即见失效
curl -s -X POST "$B/mat/update" -H 'Content-Type: application/json' -d "{\"id\":\"$T6MAT\",\"factStatus\":\"outdated\"}" | grep -q '"ok":true' || fail 'S4a-T6 素材取消确认失败'
curl -s "$B/job/changes?id=$T6DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const j = JSON.parse(s).job;
  const bad = (m) => { console.error("❌ S4a-T6 反例6 " + m); process.exit(1); };
  const ev2 = (j.evidence || []).find((e) => e.status === "sourced");
  if (!ev2 || ev2.refs[0].fresh !== false) bad("取消确认后 mat ref 应失效（factStatus≠confirmed，hash 未变也失效）");
  if (ev2.stale !== true) bad("条目应标 stale");
  const dep = j.changes.find((c) => c.id === "t6-refdep");
  if (!(dep.consistency || []).includes("ref-stale")) bad("依赖候选应命中 ref-stale: " + JSON.stringify(dep.consistency));
});' || fail 'S4a-T6 反例6（来源维度读取时即时计算，不依赖正文保存）'
# 来源维度不落盘：GET 现算值不在 meta（期间无 /save）
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const dep = m.job.changes.find((c) => c.id === "t6-refdep");
if (Array.isArray(dep.consistency) && dep.consistency.includes("ref-stale")) { console.error("❌ S4a-T6 来源维度被落盘"); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$T6DOC" || fail 'S4a-T6 来源维度不落盘'
# 恢复确认 → GET 即恢复 fresh（无保存动作）
curl -s -X POST "$B/mat/update" -H 'Content-Type: application/json' -d "{\"id\":\"$T6MAT\",\"factStatus\":\"confirmed\"}" | grep -q '"ok":true' || fail 'S4a-T6 素材恢复确认失败'
curl -s "$B/job/changes?id=$T6DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const ev2 = JSON.parse(s).job.evidence.find((e) => e.status === "sourced");
  if (!ev2 || ev2.refs[0].fresh !== true) { console.error("❌ S4a-T6 恢复确认后应即时恢复 fresh"); process.exit(1); }
});' || fail 'S4a-T6 即时计算可逆（恢复确认即恢复 fresh）'
echo '✅ S4a-T6 来源维度即时计算（refFresh/entry stale/候选 ref-stale·batch-stale 均读取时现算不落盘）'

# —— e. reviewPos 持久化（段名+changeId+filter 经 /job/changes POST；非法 400）——
curl -s -X POST "$B/job/changes?id=$T6DOC" -H 'Content-Type: application/json' -d '{"reviewPos":{"section":"evidence","changeId":"t6-refdep","filter":"important"}}' | grep -q '"ok":true' || fail 'S4a-T6 reviewPos 保存失败'
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const r = m.job.reviewPos;
if (!r || r.section !== "evidence" || r.changeId !== "t6-refdep" || r.filter !== "important") { console.error("❌ S4a-T6 reviewPos 落盘: " + JSON.stringify(r)); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$T6DOC" || fail 'S4a-T6 reviewPos 落 meta'
curl -s "$B/job/changes?id=$T6DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const r = JSON.parse(s).job.reviewPos;
  if (!r || r.section !== "evidence" || r.filter !== "important") { console.error("❌ S4a-T6 GET reviewPos: " + JSON.stringify(r)); process.exit(1); }
});' || fail 'S4a-T6 GET 返回 reviewPos'
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/job/changes?id=$T6DOC" -H 'Content-Type: application/json' -d '{"reviewPos":{"section":"nope","filter":"all"}}')
[ "$CODE" = "400" ] || fail "S4a-T6 非法 reviewPos 应 400 得 $CODE"
echo '✅ S4a-T6 reviewPos（段名+changeId+filter 经 /job/changes POST 持久化；非法 400）'

# ===== S4a-T8：局部生成与候选生命周期（scope/锚定落账/supersede 同 zone/guardOps 锁定/JSON 保存协议接入）=====
# 夹具：专用文档（工作经历 2 段 + 项目经历 1 段）→ /job/create → 保存一次（zid 归一 + zoneSync）
cat > "$TEST_DIR/t8-doc.html" << 'EOF'
<body><div class="sheet"><div class="contact">测试员 t8@t.cn</div>
<section class="section"><div class="section-title">个人总结</div><p>五年后端经验</p></section>
<section class="section"><div class="section-title">工作经历</div><p>工作段一：负责交易系统</p><p>工作段二：负责订单系统</p></section>
<section class="section"><div class="section-title">项目经历</div><p>项目甲：数据管道</p></section>
</div></body>
EOF
T8SRC=$(curl -s -X POST "$B/new" -o /dev/null -w '%{redirect_url}' | sed 's/.*id=//')
[ -n "$T8SRC" ] || fail 'S4a-T8 夹具源文档创建'
curl -s -X POST "$B/save?id=$T8SRC" --data-binary "@$TEST_DIR/t8-doc.html" | grep -q '"ok":true' || fail 'S4a-T8 夹具正文保存（zid 归一 + zoneSync）'
T8DOC=$(curl -s -X POST "$B/job/create" -H 'Content-Type: application/json' -d "{\"from\":\"$T8SRC\",\"company\":\"局部公司\",\"role\":\"后端\",\"jd\":\"S4a-T8 JD-SCOPE-MARK 验证\",\"materials\":[]}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id||'')}catch{console.log('')}})")
[ -n "$T8DOC" ] && [ -f "$RESUME_ROOT/docs/$T8DOC.html" ] || fail 'S4a-T8 夹具岗位草稿创建'
curl -s -X POST "$B/save?id=$T8DOC" --data-binary "$(cat "$RESUME_ROOT/docs/$T8DOC.html")" | grep -q '"ok":true' || fail 'S4a-T8 夹具保存（zid 归一 + zoneSync）'
# 工作经历区域前两个 zid（文档序）；GET rev 基线
read -r T8Z0 T8Z1 << EOF2
$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const wz = Object.entries(m.zones || {}).filter(([, z]) => z && z.zone === "work").map(([zid]) => zid);
console.log(wz.slice(0, 2).join(" "));
' "$RESUME_ROOT/docs-meta.json" "$T8DOC")
EOF2
[ -n "$T8Z0" ] && [ -n "$T8Z1" ] || fail "S4a-T8 夹具工作区域段落不足（z0=$T8Z0 z1=$T8Z1）"
T8_REV0=$(curl -s "$B/job/changes?id=$T8DOC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).rev))')
[ -n "$T8_REV0" ] || fail 'S4a-T8 GET /job/changes 应暴露 rev（JSON 保存协议 baseRev 来源）'

# —— a. 局部生成 scope=zone:work：锁定跳过标注 + zid/baseSnapshot/zone 落账 + supersede 只清同 zone ——
node -e '
const fs = require("fs");
const f = process.argv[1], doc = process.argv[2], z0 = process.argv[3];
const m = JSON.parse(fs.readFileSync(f, "utf8"));
m[doc].zones[z0].locked = true;   // 生成前加锁：guardOps ② 应把锁定目标候选列入 skipped
m[doc].job.changes.push({ id: "t8-otherzone", gen: 1, section: "项目经历", kind: "replace", before: "项目甲", after: "x", reason: "r", source: "母版", level: "normal", status: "pending", zone: "project" });
fs.writeFileSync(f, JSON.stringify(m));
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8Z0"
touch "$TEST_DIR/llm-changes-zone"
R=$(curl -s -X POST "$B/job/gen-start?id=$T8DOC&kind=changes&scope=zone:work")
echo "$R" | grep -q '"ok":true' || fail "S4a-T8 局部生成启动失败: $(echo "$R" | head -c 160)"
wait_gt "$T8DOC" changes done 15 || fail "S4a-T8 局部生成未完成（得 $(gt_status "$T8DOC" changes)）"
grep -q 'JD-SCOPE-MARK' "$TEST_DIR/llm-last.json" || fail 'S4a-T8 局部 prompt 未含 JD'
grep -q '（zid：' "$TEST_DIR/llm-last.json" || fail 'S4a-T8 局部 prompt 段落缺 zid 标注'
grep -q '全文摘要' "$TEST_DIR/llm-last.json" || fail 'S4a-T8 局部 prompt 缺全文摘要（digestOf）'
grep -q '工作段一：负责交易系统' "$TEST_DIR/llm-last.json" || fail 'S4a-T8 局部 prompt 应只带目标区域段落'
# 区域外内容只允许经全文摘要（digest）出现：zid 标注恰为区域段落数（2），区域外段落不带 zid 标注
node -e '
const fs = require("fs");
const last = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const u = last.messages.find((m) => m.role === "user").content;
const sys = last.messages.find((m) => m.role === "system").content;
const n = (u.match(/（zid：z[0-9a-f]{8}）/g) || []).length;
if (n !== 2) { console.error("❌ S4a-T8 局部 prompt zid 标注应恰 2 处（得 " + n + "）——区域外段落不得带标注"); process.exit(1); }
if (!/【全文摘要（上下文参考；只允许修改下方目标区域内段落）】/.test(u)) { console.error("❌ S4a-T8 局部 prompt 缺摘要块"); process.exit(1); }
if (!/仅限区域「工作」/.test(sys)) { console.error("❌ S4a-T8 局部 sys 缺越界禁令"); process.exit(1); }
if (!/zid":"目标段落 zid/.test(sys)) { console.error("❌ S4a-T8 局部 sys 输出格式缺 zid 回传要求"); process.exit(1); }
' "$TEST_DIR/llm-last.json" || fail 'S4a-T8 局部 prompt 形状（zid 标注数量/摘要块/越界禁令）'
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const bad = (msg) => { console.error("❌ S4a-T8 局部落账 " + msg); process.exit(1); };
const gt = m.job.genTasks.changes;
if (gt.scope !== "zone:work") bad("scope 应为 zone:work（得 " + gt.scope + "）");
if (!/^[0-9a-f]{16}$/.test(String(gt.baseHash || ""))) bad("baseHash 应记录（得 " + gt.baseHash + "）");
const news = m.job.changes.filter((c) => c.gen >= 2);
const skip = news.find((c) => c.status === "skipped");
const pend = news.find((c) => c.status === "pending" && c.kind === "replace");
if (!skip || !(skip.note || "").includes("锁定")) bad("锁定目标应列入 skipped 并标注原因: " + JSON.stringify(skip));
if (skip.zid !== process.argv[3]) bad("skipped 候选应锚定锁定段 zid（得 " + skip.zid + "）");
if (!pend) bad("自由目标应 pending: " + JSON.stringify(news));
if (pend.zid !== process.argv[4]) bad("pending 候选应锚定 zids[1]（得 " + pend.zid + "）");
if (pend.baseSnapshot !== "工作段二：负责订单系统") bad("baseSnapshot 应为生成时段落快照（得 " + JSON.stringify(pend.baseSnapshot) + "）");
if (pend.zone !== "work") bad("候选应带 zone=work（得 " + pend.zone + "）");
const other = m.job.changes.find((c) => c.id === "t8-otherzone");
if (!other || other.status !== "pending") bad("局部 supersede 不得动其他 zone 的 pending（影响隔离反例3）");
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8Z0" "$T8Z1" || fail 'S4a-T8 局部生成落账（scope/锚定/锁定跳过/影响隔离）'
echo '✅ S4a-T8 局部生成（scope prompt 带 zid 标注+摘要；guardOps 锁定列入 skipped；baseSnapshot/zone 落账；supersede 只清同 zone）'

# —— b. locked-now 门（生成后加锁 → 旧 pending 不可接受）+ needs-compare（手改 → 待比较）——

node -e '
const fs = require("fs");
const f = process.argv[1], doc = process.argv[2], z1 = process.argv[3];
const m = JSON.parse(fs.readFileSync(f, "utf8"));
m[doc].zones[z1].locked = true;
fs.writeFileSync(f, JSON.stringify(m));
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8Z1"
curl -s "$B/job/changes?id=$T8DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const j = JSON.parse(s).job;
  const c = (j.changes || []).find((x) => x.zid === process.argv[1] && x.kind === "replace" && x.status === "pending");
  if (!c || !(c.consistency || []).includes("locked-now")) { console.error("❌ S4a-T8 锁定后 pending 候选应命中 locked-now: " + JSON.stringify(c && c.consistency)); process.exit(1); }
});' "$T8Z1" || fail 'S4a-T8 locked-now 命中（生成后加锁拦旧候选）'
# 解锁 + 手改段落 → needs-compare（锚点文本 ≠ baseSnapshot）
node -e '
const fs = require("fs");
const fm = process.argv[1], doc = process.argv[2], z1 = process.argv[3], fd = process.argv[4];
const m = JSON.parse(fs.readFileSync(fm, "utf8"));
m[doc].zones[z1].locked = false;
fs.writeFileSync(fm, JSON.stringify(m));
let html = fs.readFileSync(fd, "utf8");
html = html.replace("工作段二：负责订单系统", "工作段二：负责订单系统（手改）");
fs.writeFileSync(fd, html);
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8Z1" "$RESUME_ROOT/docs/$T8DOC.html"
curl -s "$B/job/changes?id=$T8DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const c = (JSON.parse(s).job.changes || []).find((x) => x.zid === process.argv[1] && x.kind === "replace" && x.status === "pending");
  if (!c || !(c.consistency || []).includes("needs-compare")) { console.error("❌ S4a-T8 手改后应命中 needs-compare: " + JSON.stringify(c && c.consistency)); process.exit(1); }
});' "$T8Z1" || fail 'S4a-T8 needs-compare 命中（锚点当前文本 ≠ baseSnapshot）'
# evidenceRefs 依赖失效联动（T6 夹具 t6-batchold：旧批次 b0r1 引用 → batch-stale + refBad → needs-compare；不依赖素材状态）
curl -s "$B/job/changes?id=$T6DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const c = (JSON.parse(s).job.changes || []).find((x) => x.id === "t6-batchold");
  if (!c || !(c.consistency || []).includes("needs-compare") || !(c.consistency || []).includes("batch-stale")) { console.error("❌ S4a-T8 evidenceRefs 失效应联动 needs-compare: " + JSON.stringify(c && c.consistency)); process.exit(1); }
});' || fail 'S4a-T8 evidenceRefs 失效联动 needs-compare'
echo '✅ S4a-T8 失效判定（locked-now 拦截 / 手改→待比较 / evidenceRefs 依赖失效联动）'

# —— c. JSON 保存协议：接受同事务落账（origText/appliedText/rev/receipt）+ 整次幂等 ——
T8_PEND2=$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c = m.job.changes.find((x) => x.zid === process.argv[3] && x.kind === "replace" && x.status === "pending");
if (!c) { console.error("❌ S4a-T8 z1 pending 候选缺失"); process.exit(1); }
console.log(c.id);
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8Z1")
T8_REV1=$(curl -s "$B/job/changes?id=$T8DOC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).rev))')
node -e '
const fs = require("fs");
const out = process.argv[1], fmeta = process.argv[2], doc = process.argv[3], fdoc = process.argv[4];
const m = JSON.parse(fs.readFileSync(fmeta, "utf8"));
const c = m[doc].job.changes.find((x) => x.kind === "replace" && x.status === "pending" && x.zid === process.argv[6]);
let html = fs.readFileSync(fdoc, "utf8");
html = html.replace("工作段二：负责订单系统（手改）", c.after);   // 仅入载荷：服务端磁盘保持接受前状态（origText 锚点与其比对）
const body = { requestId: "t8-acc-1", baseRev: Number(process.argv[5]), html,
  ops: [{ operationId: "t8-op-1", changeId: c.id, action: "accept", origText: "工作段二：负责订单系统（手改）" }] };
fs.writeFileSync(out, JSON.stringify(body));
' "$TEST_DIR/t8-acc1.json" "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$RESUME_ROOT/docs/$T8DOC.html" "$T8_REV1" "$T8Z1"
R=$(curl -s -X POST "$B/save?id=$T8DOC" -H 'Content-Type: application/json' --data-binary @"$TEST_DIR/t8-acc1.json")
echo "$R" | grep -q '"ok":true' || fail "S4a-T8 JSON 接受失败: $(echo "$R" | head -c 200)"
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const bad = (msg) => { console.error("❌ S4a-T8 接受落账 " + msg); process.exit(1); };
const c = m.job.changes.find((x) => x.id === process.argv[3]);
if (c.status !== "accepted") bad("应 accepted（得 " + c.status + "）");
if (c.origText !== "工作段二：负责订单系统（手改）" || c.appliedText !== "工作段二（定制版 T8）") bad("origText/appliedText 快照: " + JSON.stringify({ o: c.origText, a: c.appliedText }));
if (!c.acceptedAt) bad("acceptedAt 应落账");
if ((Number(m.rev) || 0) !== Number(process.argv[4]) + 1) bad("rev 应 +1（得 " + m.rev + "）");
if (!Array.isArray(m.job.saveReceipts) || !m.job.saveReceipts.some((r) => r.requestId === "t8-acc-1")) bad("saveReceipts 应记录回执");
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8_PEND2" "$T8_REV1" || fail 'S4a-T8 接受同事务落账（状态+快照+rev+回执）'
# 幂等：同 requestId 同内容重试 → 只回执零重写
R2=$(curl -s -X POST "$B/save?id=$T8DOC" -H 'Content-Type: application/json' --data-binary @"$TEST_DIR/t8-acc1.json")
echo "$R2" | grep -q '"deduped":true' || fail "S4a-T8 同请求重试应命中回执（deduped）: $(echo "$R2" | head -c 160)"
echo '✅ S4a-T8 JSON 保存协议接受（正文+状态同事务；origText/appliedText/rev/saveReceipts 落账；同请求幂等回执）'

# —— d. 核心反例（端到端服务侧）：接受→撤回→旧接受重试只回执不重放，正文与状态保持撤回后 ——
T8_REV2=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];console.log(m.rev)' "$RESUME_ROOT/docs-meta.json" "$T8DOC")
node -e '
const fs = require("fs");
const out = process.argv[1], fdoc = process.argv[2];
let html = fs.readFileSync(fdoc, "utf8");
html = html.replace("工作段二（定制版 T8）", "工作段二：负责订单系统（手改）");   // 撤回载荷 = 客户端恢复后 DOM 文本；服务端磁盘在保存前仍是接受后状态
fs.writeFileSync(out, JSON.stringify({ requestId: "t8-rev-1", baseRev: Number(process.argv[3]), html,
  ops: [{ operationId: "t8-op-2", changeId: process.argv[4], action: "revert", origText: "工作段二（定制版 T8）" }] }));
' "$TEST_DIR/t8-rev1.json" "$RESUME_ROOT/docs/$T8DOC.html" "$T8_REV2" "$T8_PEND2"
R=$(curl -s -X POST "$B/save?id=$T8DOC" -H 'Content-Type: application/json' --data-binary @"$TEST_DIR/t8-rev1.json")
echo "$R" | grep -q '"ok":true' || fail "S4a-T8 撤回失败: $(echo "$R" | head -c 200)"
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const bad = (msg) => { console.error("❌ S4a-T8 撤回落账 " + msg); process.exit(1); };
const c = m.job.changes.find((x) => x.id === process.argv[3]);
if (c.status !== "pending") bad("撤回后应回 pending（得 " + c.status + "）");
if (c.origText !== undefined || c.appliedText !== undefined || c.acceptedAt !== undefined) bad("撤回应清空 origText/appliedText/acceptedAt（不留旧快照误导后续判定）");
if (fs.readFileSync(process.argv[4], "utf8").includes("工作段二（定制版 T8）")) bad("正文应保持撤回后版本");
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8_PEND2" "$RESUME_ROOT/docs/$T8DOC.html" || fail 'S4a-T8 撤回（pending+清快照+正文恢复）'
# 旧接受请求原样重试（同 requestId 同内容；baseRev 已落后）→ 只回执不重放
R3=$(curl -s -X POST "$B/save?id=$T8DOC" -H 'Content-Type: application/json' --data-binary @"$TEST_DIR/t8-acc1.json")
echo "$R3" | grep -q '"deduped":true' || fail "S4a-T8 旧接受重试应只回执: $(echo "$R3" | head -c 200)"
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const bad = (msg) => { console.error("❌ S4a-T8 重放隔离 " + msg); process.exit(1); };
const c = m.job.changes.find((x) => x.id === process.argv[3]);
if (c.status !== "pending") bad("重放后正文与状态必须保持撤回后（得 " + c.status + "）");
if (fs.readFileSync(process.argv[4], "utf8").includes("工作段二（定制版 T8）")) bad("重放不得重写正文");
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8_PEND2" "$RESUME_ROOT/docs/$T8DOC.html" || fail 'S4a-T8 反例：接受→撤回→旧接受重试只回执不重放'
echo '✅ S4a-T8 核心反例（接受→撤回→旧接受重试：只回执不重放，正文与状态保持撤回后）'

# —— e. 503 路径：保存被拒时 accepted 不落 ——
touch "$RESUME_ROOT/.migrate.lock"
T8_REV3=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];console.log(m.rev)' "$RESUME_ROOT/docs-meta.json" "$T8DOC")
node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({ requestId: "t8-acc-503", baseRev: Number(process.argv[4]), html: fs.readFileSync(process.argv[2], "utf8"),
  ops: [{ operationId: "t8-op-3", changeId: process.argv[3], action: "accept", origText: "工作段二：负责订单系统（手改）" }] }));
' "$TEST_DIR/t8-503.json" "$RESUME_ROOT/docs/$T8DOC.html" "$T8_PEND2" "$T8_REV3"
CODE=$(curl -s -X POST "$B/save?id=$T8DOC" -H 'Content-Type: application/json' --data-binary @"$TEST_DIR/t8-503.json" -o /dev/null -w '%{http_code}')
[ "$CODE" = "503" ] || fail "S4a-T8 持锁期间保存应 503（得 $CODE）"
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c = m.job.changes.find((x) => x.id === process.argv[3]);
if (c.status !== "pending" || c.acceptedAt) { console.error("❌ S4a-T8 503 路径 meta 出现 accepted"); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8_PEND2" || fail 'S4a-T8 503 时 accepted 不落'
rm -f "$RESUME_ROOT/.migrate.lock"
echo '✅ S4a-T8 503 路径（保存被拒：正文与 meta 均未写，accepted 不落）'

# —— f. add 候选接受流程（容器锚点 → newZid 记录）+ 全文生成 supersede 全部 pending ——
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
m[process.argv[2]].zones[process.argv[3]].locked = false;   // 解锁容器锚点（a 块的锁；解锁只是允许后续生成/接受，不替换内容）
fs.writeFileSync(process.argv[1], JSON.stringify(m));
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8Z0"
touch "$TEST_DIR/llm-changes-add"
R=$(curl -s -X POST "$B/job/gen-start?id=$T8DOC&kind=changes")
echo "$R" | grep -q '"ok":true' || fail "S4a-T8 全文生成启动失败: $(echo "$R" | head -c 160)"
wait_gt "$T8DOC" changes done 15 || fail "S4a-T8 全文生成未完成（得 $(gt_status "$T8DOC" changes)）"
T8_ADD=$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c = m.job.changes.find((x) => x.kind === "add" && x.status === "pending");
if (!c) { console.error("❌ S4a-T8 add 候选未落 pending"); process.exit(1); }
if (c.zid !== process.argv[3]) { console.error("❌ S4a-T8 add 容器锚点应为目标章节首段 zid（得 " + c.zid + "）"); process.exit(1); }
console.log(c.id);
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8Z0") || fail 'S4a-T8 add 候选落账（容器锚点）'
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const b = m.job.changes.find((x) => x.id === process.argv[3]);
if (!b || b.status !== "superseded") { console.error("❌ S4a-T8 全文生成应 supersede 全部 pending（影响隔离只限局部）"); process.exit(1); }
const other = m.job.changes.find((x) => x.id === "t8-otherzone");
if (!other || other.status !== "superseded") { console.error("❌ S4a-T8 全文生成应 supersede 其他 zone pending"); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8_PEND2" || fail 'S4a-T8 全文 supersede 口径'
T8_REV4=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]];console.log(m.rev)' "$RESUME_ROOT/docs-meta.json" "$T8DOC")
node -e '
const fs = require("fs");
const out = process.argv[1], fdoc = process.argv[2], z0 = process.argv[3];
let html = fs.readFileSync(fdoc, "utf8");
// 客户端 add 语义：容器段落后插入新段落（自带 newZid）；只入载荷，服务端磁盘保持插入前状态
html = html.replace(new RegExp("(<p data-zid=\"" + z0 + "\">[\\s\\S]*?</p>)"), "$1\n<p data-zid=\"z0ddba114\">新增条目内容（T8 全文）</p>");
fs.writeFileSync(out, JSON.stringify({ requestId: "t8-acc-add", baseRev: Number(process.argv[5]), html,
  ops: [{ operationId: "t8-op-4", changeId: process.argv[4], action: "accept", origText: "工作段一：负责交易系统", newZid: "z0ddba114" }] }));
' "$TEST_DIR/t8-acc2.json" "$RESUME_ROOT/docs/$T8DOC.html" "$T8Z0" "$T8_ADD" "$T8_REV4"
R=$(curl -s -X POST "$B/save?id=$T8DOC" -H 'Content-Type: application/json' --data-binary @"$TEST_DIR/t8-acc2.json")
echo "$R" | grep -q '"ok":true' || fail "S4a-T8 add 接受失败: $(echo "$R" | head -c 200)"
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c = m.job.changes.find((x) => x.id === process.argv[3]);
if (c.status !== "accepted" || c.newZid !== "z0ddba114") { console.error("❌ S4a-T8 add 接受应落 newZid: " + JSON.stringify({ s: c.status, n: c.newZid })); process.exit(1); }
if (!fs.readFileSync(process.argv[4], "utf8").includes("data-zid=\"z0ddba114\"")) { console.error("❌ S4a-T8 新段落应已入正文"); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8_ADD" "$RESUME_ROOT/docs/$T8DOC.html" || fail 'S4a-T8 add 接受（容器锚点校验→插入→newZid 落账）'
rm -f "$TEST_DIR/llm-changes-add"
# scope 非法 400
CODE=$(curl -s -X POST "$B/job/gen-start?id=$T8DOC&kind=changes&scope=zone:nope" -o /dev/null -w '%{http_code}')
[ "$CODE" = "400" ] || fail "S4a-T8 非法 scope 应 400（得 $CODE）"
echo '✅ S4a-T8 add 接受流程（容器锚点校验→插入→newZid 落账）+ 全文 supersede 口径 + scope 校验'


# ===== S4a-T9：审阅升级（feedback 进 prompt / 保留当前版本 / skipped 状态机与导出门控）=====
# —— a. 拒绝原因 → job.feedback（环形 ≤20）→ 下一次生成 prompt 消费 ——
R=$(curl -s -X POST "$B/job/changes?id=$T8DOC" -H 'Content-Type: application/json' -d '{"feedback":"不要动个人总结的排序"}')
echo "$R" | grep -q '"ok":true' || fail "S4a-T9 feedback 写入失败: $(echo "$R" | head -c 160)"
R=$(curl -s -X POST "$B/job/changes?id=$T8DOC" -H 'Content-Type: application/json' -d '{"feedback":"太空泛的建议直接跳过"}')
echo "$R" | grep -q '"ok":true' || fail 'S4a-T9 feedback 二次写入失败'
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const f = m.job.feedback || [];
if (f.length !== 2 || f[0] !== "不要动个人总结的排序" || f[1] !== "太空泛的建议直接跳过") { console.error("❌ S4a-T9 feedback 落盘: " + JSON.stringify(f)); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" || fail 'S4a-T9 feedback 落 meta'
R=$(curl -s -X POST "$B/job/changes?id=$T8DOC" -H 'Content-Type: application/json' -d '{"feedback":"  "}')
echo "$R" | grep -q '"ok":false' || fail "S4a-T9 空 feedback 应 400: $R"
touch "$TEST_DIR/llm-changes-add"
R=$(curl -s -X POST "$B/job/generate?id=$T8DOC" -H 'Content-Type: application/json' -d '{}')
echo "$R" | grep -q '"ok":true' || fail "S4a-T9 反馈生成失败: $(echo "$R" | head -c 160)"
grep -q '过往反馈' "$TEST_DIR/llm-last.json" || fail 'S4a-T9 prompt 未含过往反馈块'
grep -q '不要动个人总结的排序' "$TEST_DIR/llm-last.json" || fail 'S4a-T9 prompt 未消费 feedback 内容'
rm -f "$TEST_DIR/llm-changes-add"
echo '✅ S4a-T9 拒绝原因进 feedback（环形落账 + 生成 prompt 消费 + 空 400）'

# —— b. 「保留当前版本」：resolve 绑定 resolvedText/resolvedRefs → 退出待核对；再变重新核对 ——
# 夹具：专用 pending replace 候选（锚 z0）+ 手改正文制造 needs-compare
node -e '
const fs = require("fs");
const f = process.argv[1], doc = process.argv[2];
const m = JSON.parse(fs.readFileSync(f, "utf8"));
const gen = m[doc].job.changes.reduce((mx, c) => Math.max(mx, c.gen || 0), 0) + 1;
m[doc].job.changes.push({ id: "t9-rp", gen, section: "工作经历", kind: "replace", before: "工作段一", after: "工作段一（定制）", reason: "r", source: "母版", level: "normal", status: "pending", zid: process.argv[3], baseSnapshot: "生成基线：工作段一：负责交易系统", zone: "work" });
fs.writeFileSync(f, JSON.stringify(m));
let raw = fs.readFileSync(process.argv[4], "utf8");
raw = raw.replace("工作段一：负责交易系统", "工作段一：负责交易系统（T9手改）");
fs.writeFileSync(process.argv[4], raw);
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8Z0" "$RESUME_ROOT/docs/$T8DOC.html"
T8_RP=t9-rp
curl -s "$B/job/changes?id=$T8DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const c = (JSON.parse(s).job.changes || []).find((x) => x.id === "t9-rp");
  if (!c || !(c.consistency || []).includes("needs-compare")) { console.error("❌ S4a-T9 夹具应命中 needs-compare: " + JSON.stringify(c && c.consistency)); process.exit(1); }
});' || fail 'S4a-T9 resolve 夹具（needs-compare）'
R=$(curl -s -X POST "$B/job/changes?id=$T8DOC" -H 'Content-Type: application/json' -d '{"resolve":{"changeId":"'"$T8_RP"'","text":"工作段一：负责交易系统（T9手改）"}}')
echo "$R" | grep -q '"ok":true' || fail "S4a-T9 resolve 失败: $(echo "$R" | head -c 200)"
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
const c = m.job.changes.find((x) => x.id === process.argv[3]);
if (c.status !== "resolved" || !c.resolvedAt || !String(c.resolvedText || "").includes("T9手改")) { console.error("❌ S4a-T9 resolve 落账: " + JSON.stringify({ s: c.status, t: c.resolvedText, at: c.resolvedAt })); process.exit(1); }
' "$RESUME_ROOT/docs-meta.json" "$T8DOC" "$T8_RP" || fail 'S4a-T9 resolve 落账（resolvedText/resolvedAt）'
# 再变 → 重新进待核对（resolvedText ≠ 当前文本）
node -e '
const fs = require("fs");
const f = process.argv[1];
let raw = fs.readFileSync(f, "utf8");
raw = raw.replace("（T9手改）", "（T9手改2）");
fs.writeFileSync(f, raw);
' "$RESUME_ROOT/docs/$T8DOC.html"
curl -s "$B/job/changes?id=$T8DOC" | node -e '
let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
  const c = (JSON.parse(s).job.changes || []).find((x) => x.id === process.argv[1]);
  if (!c || !(c.consistency || []).includes("needs-compare")) { console.error("❌ S4a-T9 resolve 后再变应重新进待核对: " + JSON.stringify(c && c.consistency)); process.exit(1); }
});' "$T8_RP" || fail 'S4a-T9 resolved 再变重新核对'
# 非法与状态前置
R=$(curl -s -X POST "$B/job/changes?id=$T8DOC" -H 'Content-Type: application/json' -d '{"resolve":{"changeId":"nope","text":"x"}}')
echo "$R" | grep -q '"ok":false' || fail "S4a-T9 resolve 不存在候选应 400: $R"
R=$(curl -s -X POST "$B/job/changes?id=$T8DOC" -H 'Content-Type: application/json' -d '{"resolve":{"changeId":"'"$T8_RP"'"}}')
echo "$R" | grep -q '"ok":false' || fail "S4a-T9 resolve 缺 text 应 400: $R"
echo '✅ S4a-T9 保留当前版本（resolvedText/resolvedAt 落账 + 再变重新核对 + 400 路径）'

# —— c. skipped 状态机 + 导出门控（skipped 的 conflict 仍阻止导出；skipped 不满足整体完成）——
node -e '
const fs = require("fs");
const f = process.argv[1], doc = process.argv[2];
const m = JSON.parse(fs.readFileSync(f, "utf8"));
const gen = m[doc].job.changes.reduce((mx, c) => Math.max(mx, c.gen || 0), 0) + 1;
m[doc].job.changes.push({ id: "t9-skipconf", gen, section: "工作经历", kind: "replace", before: "x", after: "y", reason: "冲突稍后处理", source: "JD", level: "conflict", status: "skipped" });
fs.writeFileSync(f, JSON.stringify(m));
' "$RESUME_ROOT/docs-meta.json" "$T8DOC"
# skipped 的 conflict 计入门控（条数 +1）；恢复 pending 计数不变；resolved 退出计数（v1.5：skipped 不解冲突）
curl -sf "$B/export?id=$T8DOC" | grep -q '存在 2 条事实冲突' || fail 'S4a-T9 skipped 的 conflict 未计入门控'
curl -s -X POST "$B/job/changes?id=$T8DOC" -H 'Content-Type: application/json' -d '{"updates":[{"id":"t9-skipconf","status":"pending"}]}' | grep -q '"ok":true' || fail 'S4a-T9 skipped 恢复失败'
curl -sf "$B/export?id=$T8DOC" | grep -q '存在 2 条事实冲突' || fail 'S4a-T9 恢复 pending 后门控计数应保持'
curl -s -X POST "$B/job/changes?id=$T8DOC" -H 'Content-Type: application/json' -d '{"updates":[{"id":"t9-skipconf","status":"resolved"}]}' | grep -q '"ok":true' || fail 'S4a-T9 conflict 处理失败'
curl -sf "$B/export?id=$T8DOC" | grep -q '存在 2 条事实冲突' && fail 'S4a-T9 resolved 后应退出门控计数'
echo '✅ S4a-T9 skipped 状态机与导出门控（skipped 计入/恢复保持/resolved 退出）'

# ===== 16. 浏览器级保存语义（可选，需要本机 Chromium）=====
if node test-editor.mjs "$B" "$DOCID" "$RESUME_ROOT"; then
  echo '✅ 浏览器级保存/恢复/冲突/审阅验证'
else
  RC=$?
  if [ "$RC" -eq 2 ]; then echo '⚠️ 跳过浏览器级验证（Chromium 不可用）'; else fail "浏览器级验证失败 (exit $RC)"; fi
fi

# ===== 17. 真实数据指纹比对 =====
REAL_AFTER=$(real_fp)
[ "$REAL_BEFORE" = "$REAL_AFTER" ] || fail '真实数据被测试改动（指纹不一致）'
echo '✅ 真实数据零接触（前后指纹一致）'
echo ''
echo '全部通过（隔离数据根：本测试未触碰真实数据与真实模型）'
