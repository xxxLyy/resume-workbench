#!/bin/bash
# test.sh — 全隔离回归测试
# 纪律：独立数据根（RESUME_ROOT）+ 独立端口 + 虚拟配置 + 生成夹具 + 假渲染器 + 本地假 LLM。
# 全程不接触真实 docs/snapshots/pdfs/JSON/config；测试前后对真实数据做指纹比对。
# 需要 pdftotext（poppler）。浏览器级保存语义见 test-editor.mjs（由本脚本按可用性调用）。
set -e
cd "$(dirname "$0")"
REAL_ROOT=$(pwd)
command -v pdftotext >/dev/null || { echo '需要 poppler: brew install poppler'; exit 1; }

TEST_DIR=$(mktemp -d /tmp/resume-isolated-test.XXXXXX)
export RESUME_ROOT="$TEST_DIR/data"
export PORT=${PORT:-17899}
mkdir -p "$RESUME_ROOT/docs" "$RESUME_ROOT/snapshots" "$RESUME_ROOT/pdfs"

cleanup() {
  kill $SRV $LLM $JDSTUB 2>/dev/null || true
  rm -rf "$TEST_DIR"
  rm -f /tmp/resume-test-stub.log
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
http.createServer((q, s) => {
  let b = '';
  q.on('data', (c) => b += c);
  q.on('end', () => {
    fs.writeFileSync('$TEST_DIR/llm-last.json', b.slice(0, 200000));
    s.writeHead(200, { 'Content-Type': 'application/json' });
    if (q.url.includes('/models')) return s.end(JSON.stringify({ data: [{ id: 'stub-model' }] }));
    s.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
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
h=h.replace('<p class=\"summary\">文本B</p>','<p class=\"summary\">文本B</p><section class=\"section ed-sec-hidden\"><div class=\"section-title\">隐藏节</div><p>隐藏内容XYZ</p></section>');
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
