#!/bin/bash
# test-structure.sh — LLM 结构化组装的单元级验证（注入假 llmFn）
set -e
cd "$(dirname "$0")"
# 本套件断言的是未覆盖 RESUME_CHROMIUM 时的探测契约（段 X cacheValid 最后一条），外部导出该变量会误红，统一取消；段 Y 内部自设自删，不受影响。
unset RESUME_CHROMIUM
node --input-type=module << 'EOF'
import { structureText } from './structure.mjs';

const root = process.cwd();
// 8 个内容占位符（{{DOC_ID}} 由 server /edit serve 时注入，构建产物中保留属设计意图）
const CONTENT_MARKERS = ['{{NAME}}','{{CONTACT}}','{{INTENT}}','{{SUMMARY}}','{{SKILLS}}','{{WORK}}','{{PROJECTS}}','{{EDU}}'];
const fakeLLM = async () => JSON.stringify({
  name: '测试员', contact: '电话：12345678901', intent: '测试工程师',
  summary: '这是摘要。', skills: ['技能一：内容一'],
  work: [{ title: '某公司', role: '工程师', date: '2020-2024', bullets: ['做了一件事'] }],
  projects: [], education: [{ title: '某大学', role: '本科|计算机', date: '2016-2020' }]
});

const html = await structureText(root, '任意原文', fakeLLM);
const ok = html && html.includes('测试员') && html.includes('12345678901')
  && html.includes('<strong>技能一：</strong>内容一') && html.includes('做了一件事')
  && !CONTENT_MARKERS.some(m => html.includes(m));  // 无内容占位符残留
if (!ok) { console.error('❌ 结构化组装失败'); process.exit(1); }

// 失败路径：LLM 返回坏 JSON → 返回 null（调用方降级）
const bad = await structureText(root, '任意原文', async () => '这不是JSON');
if (bad !== null) { console.error('❌ 坏 JSON 未降级'); process.exit(1); }

// $ 特殊模式与 HTML 转义防回归（esc 会把 $& 的 & 转成 &amp;，期望串随之）
const tricky = await structureText(root, 'x', async () => JSON.stringify({ name: '张$&三<script>', contact: '', intent: '', summary: '', skills: [], work: [], projects: [], education: [] }));
if (!tricky || !tricky.includes('张$&amp;三&lt;script&gt;') || CONTENT_MARKERS.some(m => tricky.includes(m))) { console.error('❌ $/转义防回归失败'); process.exit(1); }
console.log('✅ 结构化组装与降级路径均正确');

// parseChanges 解析（Phase 3）
const { parseChanges } = await import('./ai.mjs');
const good = parseChanges('[{"before":"旧","after":"新","note":"x"}]');
if (!good || good.changes.length !== 1 || good.changes[0].before !== '旧') { console.error('❌ parseChanges 好 JSON'); process.exit(1); }
const fenced = parseChanges('```json\n[{"before":"a","after":"b"}]\n```');
if (!fenced || fenced.changes.length !== 1) { console.error('❌ parseChanges 围栏'); process.exit(1); }
const reply = parseChanges('{"reply":"这是闲聊回答"}');
if (!reply || reply.reply !== '这是闲聊回答') { console.error('❌ parseChanges reply'); process.exit(1); }
if (parseChanges('胡说八道') !== null) { console.error('❌ parseChanges 坏输出未拦截'); process.exit(1); }
const empty = parseChanges('[{"before":"","after":"x"},{"before":"a","after":"a"},{"before":"a","after":""}]');
if (!empty || empty.changes.length !== 0) { console.error('❌ parseChanges 未过滤无效修改'); process.exit(1); }
console.log('✅ parseChanges 五路径正确');
EOF

# —— withRetry 单元测试（T1-T7）：计数器 fake + 注入 sleep，零真实等待 ——
node --input-type=module << 'EOF'
import * as llm from './llm.mjs';
const withRetry = llm.withRetry;
if (typeof withRetry !== 'function') { console.error('❌ withRetry 未导出'); process.exit(1); }

const st = (s) => { const e = new Error('HTTP ' + s); e.status = s; return e; };
const netErr = () => new Error('fetch failed');
const mkSleep = (log) => async (ms) => { log.push(ms); };
let calls = 0; const sleeps = [];

// T1 前 2 次网络错（无 status）第 3 次成功：共 3 次调用、2 次延迟各 1500
calls = 0; sleeps.length = 0;
let out = await withRetry(async () => { if (++calls < 3) throw netErr(); return 'ok'; }, { sleep: mkSleep(sleeps) });
if (out !== 'ok' || calls !== 3 || sleeps.join() !== '1500,1500') { console.error('❌ T1 网络错重试至成功'); process.exit(1); }

// T2 首次 502 第 2 次成功
calls = 0; sleeps.length = 0;
out = await withRetry(async () => { if (++calls < 2) throw st(502); return 'ok'; }, { sleep: mkSleep(sleeps) });
if (out !== 'ok' || calls !== 2 || sleeps.length !== 1) { console.error('❌ T2 5xx 重试'); process.exit(1); }

// T3 401 立即抛出，不重试
calls = 0; sleeps.length = 0;
try {
  await withRetry(async () => { calls++; throw st(401); }, { sleep: mkSleep(sleeps) });
  console.error('❌ T3 应抛出 401'); process.exit(1);
} catch (e) {
  if (calls !== 1 || sleeps.length !== 0 || e.status !== 401) { console.error('❌ T3 4xx 不应重试'); process.exit(1); }
}

// T4 400 同样不重试（4xx 下界）
calls = 0; sleeps.length = 0;
try {
  await withRetry(async () => { calls++; throw st(400); }, { sleep: mkSleep(sleeps) });
  console.error('❌ T4 应抛出 400'); process.exit(1);
} catch (e) {
  if (calls !== 1 || sleeps.length !== 0 || e.status !== 400) { console.error('❌ T4 400 不应重试'); process.exit(1); }
}

// T5 全程 503、默认 retries=2 耗尽：3 次调用、抛最后一个错
calls = 0; sleeps.length = 0;
try {
  await withRetry(async () => { calls++; throw st(503); }, { sleep: mkSleep(sleeps) });
  console.error('❌ T5 应抛出 503'); process.exit(1);
} catch (e) {
  if (calls !== 3 || sleeps.length !== 2 || e.status !== 503) { console.error('❌ T5 重试耗尽语义'); process.exit(1); }
}

// T6 TimeoutError（无 status）按可重试处理
calls = 0; sleeps.length = 0;
const timeoutErr = () => { const e = new Error('signal timed out'); e.name = 'TimeoutError'; return e; };
out = await withRetry(async () => { if (++calls < 2) throw timeoutErr(); return 'ok'; }, { sleep: mkSleep(sleeps) });
if (out !== 'ok' || calls !== 2 || sleeps.length !== 1) { console.error('❌ T6 超时应重试'); process.exit(1); }

// T7 retries=0：单次调用、零延迟
calls = 0; sleeps.length = 0;
try {
  await withRetry(async () => { calls++; throw netErr(); }, { retries: 0, sleep: mkSleep(sleeps) });
  console.error('❌ T7 应抛出'); process.exit(1);
} catch (e) {
  if (calls !== 1 || sleeps.length !== 0) { console.error('❌ T7 retries=0 语义'); process.exit(1); }
}
console.log('✅ withRetry 七场景正确');
EOF

# —— S2：parseReport / buildReview / buildMatch 单元测试 ——
node --input-type=module << 'EOF'
import * as ai from './ai.mjs';
const { parseReport, buildReview, buildMatch } = ai;
if (typeof parseReport !== 'function' || typeof buildReview !== 'function' || typeof buildMatch !== 'function') { console.error('❌ S2 函数未导出'); process.exit(1); }

// parseReport 五路径
const clean = parseReport('{"score":85,"summary":"不错","items":["结构 8/10：清晰"],"changes":[{"before":"a","after":"b","note":"n"}]}');
if (!clean || clean.score !== 85 || clean.summary !== '不错' || clean.items.length !== 1 || clean.changes.length !== 1) { console.error('❌ parseReport 干净 JSON'); process.exit(1); }
const fenced = parseReport('```json\n{"summary":"围栏"}\n```');
if (!fenced || fenced.summary !== '围栏' || fenced.score !== null) { console.error('❌ parseReport 围栏'); process.exit(1); }
if (parseReport('胡说八道') !== null) { console.error('❌ parseReport 垃圾未返回 null'); process.exit(1); }
const noChanges = parseReport('{"summary":"s"}');
if (!noChanges || noChanges.changes.length !== 0 || noChanges.items.length !== 0 || noChanges.score !== null) { console.error('❌ parseReport 缺省值不合规'); process.exit(1); }
const noScore = parseReport('{"summary":"s","items":["x"]}');
if (!noScore || noScore.score !== null || noScore.items.length !== 1) { console.error('❌ parseReport 缺 score 未给 null'); process.exit(1); }

// buildReview 两 mode：user 含文档原文，两 mode prompt 不同
const rf = buildReview('张三的简历原文内容', 'full');
if (!rf || !rf.user.includes('张三的简历原文内容') || !rf.sys.includes('维度')) { console.error('❌ buildReview full'); process.exit(1); }
const rq = buildReview('李四简历内容', 'quant');
if (!rq || !rq.user.includes('李四简历内容') || !rq.sys.includes('量化')) { console.error('❌ buildReview quant'); process.exit(1); }
if (rf.sys === rq.sys) { console.error('❌ buildReview 两 mode prompt 不应相同'); process.exit(1); }

// buildMatch：user 同时含简历与 JD 原文
const bm = buildMatch('王五简历内容', '需要五年Go经验');
if (!bm || !bm.user.includes('王五简历内容') || !bm.user.includes('需要五年Go经验') || !bm.sys.includes('匹配')) { console.error('❌ buildMatch'); process.exit(1); }
console.log('✅ S2 parseReport 五路径 + buildReview/buildMatch 正确');
EOF

# —— S3：diffLines / docToLines 单元测试 ——
node --input-type=module << 'EOF'
import * as diff from './diff.mjs';
const { diffLines, docToLines } = diff;
if (typeof diffLines !== 'function' || typeof docToLines !== 'function') { console.error('❌ S3 函数未导出'); process.exit(1); }

// 还原不变量：del+same 按序=A，ins+same 按序=B（所有用例通用）
function recombine(out) {
  const A = [], B = [];
  for (const d of out) { if (d.type !== 'ins') A.push(d.text); if (d.type !== 'del') B.push(d.text); }
  return [A, B];
}
const cases = [
  ['全同', ['a', 'b'], ['a', 'b'], { del: 0, ins: 0 }],
  ['纯增', ['a'], ['a', 'b', 'c'], { del: 0, ins: 2 }],
  ['纯删', ['a', 'b', 'c'], ['a'], { del: 2, ins: 0 }],
  ['混合乱序', ['x', 'a', 'y'], ['a', 'x', 'y'], null]
];
for (const [name, a, b, expect] of cases) {
  const out = diffLines(a, b);
  const [ra, rb] = recombine(out);
  if (JSON.stringify(ra) !== JSON.stringify(a) || JSON.stringify(rb) !== JSON.stringify(b)) { console.error('❌ diffLines ' + name + ' 还原失败'); process.exit(1); }
  if (expect) {
    const del = out.filter((d) => d.type === 'del').length, ins = out.filter((d) => d.type === 'ins').length;
    if (del !== expect.del || ins !== expect.ins) { console.error('❌ diffLines ' + name + ' 分布不符 del=' + del + ' ins=' + ins); process.exit(1); }
  } else {
    if (out.filter((d) => d.type === 'same').length !== 2) { console.error('❌ diffLines ' + name + ' LCS 应为 2'); process.exit(1); }
  }
}

// docToLines：去 script/style、块级闭合标签与 br 成行、去标签、压缩空白、滤空行
const html = '<style>.x{color:red}</style><p>你好</p><script>var a=1;</script><ul><li>第一项</li><li>第二项  多空格</li></ul><div></div><br>尾部';
const lines = docToLines(html);
if (lines.join('|') !== '你好|第一项|第二项 多空格|尾部') { console.error('❌ docToLines 输出: ' + lines.join('|')); process.exit(1); }
if (docToLines('<p>a</p>').some((l) => l.includes('a') === false)) { console.error('❌ docToLines 基本行为'); process.exit(1); }
console.log('✅ S3 diffLines 四用例 + docToLines 正确');
EOF

# —— W2：parseReport scoreBasis + prompt 深化 ——
node --input-type=module << 'EOF'
import * as ai from './ai.mjs';
const { parseReport, buildReview, buildMatch } = ai;

// parseReport 透传 scoreBasis（缺省空串）
const withBasis = parseReport('{"summary":"s","scoreBasis":"按维度均分"}');
if (!withBasis || withBasis.scoreBasis !== '按维度均分') { console.error('❌ parseReport scoreBasis 透传'); process.exit(1); }
if (parseReport('{"summary":"s"}').scoreBasis !== '') { console.error('❌ parseReport scoreBasis 缺省应空串'); process.exit(1); }

// buildReview full：七维【】前缀 + scoreBasis 契约
const rf = buildReview('doc', 'full');
for (const p of ['【结构】', '【量化】', '【动词】', '【冗余】', '【ATS】', '【重复】', '【一致性】', 'scoreBasis']) {
  if (!rf.sys.includes(p)) { console.error('❌ buildReview full 缺 ' + p); process.exit(1); }
}

// buildMatch：四段式 + 两类缺口 + scoreBasis
const bm = buildMatch('doc', 'jd');
for (const p of ['【要求】', '【简历证据】', '【缺口】', '【建议】', '有但未表达', '真缺', 'scoreBasis']) {
  if (!bm.sys.includes(p)) { console.error('❌ buildMatch 缺 ' + p); process.exit(1); }
}
console.log('✅ W2 scoreBasis 透传 + prompt 深化正确');
EOF

# —— X：Chromium 探测契约 ——
node --input-type=module << 'EOF'
import { expectedRevision, candidates, cacheValid } from './chromium.mjs';
const fail = m => { console.error('❌ ' + m); process.exit(1); };
if (expectedRevision() !== '1223') fail('expectedRevision 应读 browsers.json（pin 1.60.0 → 1223），实际 ' + expectedRevision());
const cs = candidates();
if (!cs.length) fail('候选为空：本机应至少有一个 chromium_headless_shell-*');
const revs = cs.filter(c => c.source.startsWith('chromium_headless_shell-')).map(c => parseInt(c.source.split('-')[1], 10));
for (let i = 1; i < revs.length; i++) if (revs[i - 1] < revs[i]) fail('候选未按修订号降序: ' + revs.join(','));
if (cs.some(c => c.source === 'chromium_headless_shell-1223') && cs[0].source !== 'chromium_headless_shell-1223') fail('期望修订号应排第一');
if (cacheValid(null)) fail('null 缓存不应有效');
if (cacheValid({ ok: true, bin: '/nonexistent', revision: expectedRevision(), playwright: '1.60.0' })) fail('bin 不存在不应有效');
if (cacheValid({ ok: true, bin: process.execPath, revision: '9999', playwright: '1.60.0' })) fail('修订号不符不应有效');
if (cacheValid({ ok: true, bin: process.execPath, revision: expectedRevision(), playwright: '0.0.1' })) fail('playwright 版本不符不应有效');
if (!cacheValid({ ok: true, bin: process.execPath, revision: expectedRevision(), playwright: '1.60.0' })) fail('字段齐全且无 RESUME_CHROMIUM 时应有效');
console.log('✅ X chromium 探测契约');
EOF

# —— Y：resolve 语义（显式路径报错 / 缓存命中 / 锁等待）——
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { resolveChromium, readCache, cacheValid, invalidateCache } from './chromium.mjs';
const fail = m => { console.error('❌ ' + m); process.exit(1); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-resolve-'));
process.env.RESUME_ROOT = tmp;
// 1) 显式无效路径必须报错且指明 RESUME_CHROMIUM
process.env.RESUME_CHROMIUM = '/nonexistent-chromium';
try { await resolveChromium({ tmpDir: tmp }); fail('RESUME_CHROMIUM 无效应抛错'); }
catch (e) { if (!/RESUME_CHROMIUM/.test(e.message)) fail('报错应指明 RESUME_CHROMIUM: ' + e.message); }
delete process.env.RESUME_CHROMIUM;
// 2) 正常解析：写缓存且缓存有效
const bin = await resolveChromium({ tmpDir: tmp });
if (!bin || !fs.existsSync(bin)) fail('应返回存在的 bin');
const c = readCache();
if (!cacheValid(c)) fail('解析后缓存应有效');
// 3) 缓存命中：force=false 不再探针（删掉所有候选也仍返回缓存 bin 不行——改为校验 probedAt 不变且快速返回）
const at = c.probedAt;
const bin2 = await resolveChromium({ tmpDir: tmp });
if (bin2 !== bin || readCache().probedAt !== at) fail('缓存命中不应重探');
// 4) 锁：预置新鲜锁 → 等待方超时抛错（waitMs 调小）
fs.writeFileSync(path.join(tmp, '.chromium-choice.json.probe-lock'), '999999');
invalidateCache();
try { await resolveChromium({ tmpDir: tmp, waitMs: 1500 }); fail('持锁期间应抛"另一个进程正在探测"'); }
catch (e) { if (!/另一个进程正在探测/.test(e.message)) fail('锁等待超时报错不符: ' + e.message); }
fs.rmSync(path.join(tmp, '.chromium-choice.json.probe-lock'), { force: true });
console.log('✅ Y resolve 语义');
EOF

# —— Z：日志轮转（copytruncate）——
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { rotateLogIfNeeded } from './logrotate.mjs';
const fail = m => { console.error('❌ ' + m); process.exit(1); };
const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-')), 's.log');
fs.writeFileSync(f, 'x');
rotateLogIfNeeded(f);
if (fs.existsSync(f + '.1')) fail('未超容量不应轮转');
const fd = fs.openSync(f, 'w'); fs.truncateSync(f, 60 * 1024 * 1024); fs.closeSync(fd);
rotateLogIfNeeded(f);
if (!fs.existsSync(f + '.1')) fail('超 50MB 应生成 .1');
if (fs.statSync(f + '.1').size !== 2 * 1024 * 1024) fail('.1 应为尾部 2MB');
if (fs.statSync(f).size !== 0) fail('原文件应被 truncate 为 0');
rotateLogIfNeeded(path.join(os.tmpdir(), 'definitely-missing-' + Date.now() + '.log')); // 缺失不抛
console.log('✅ Z 日志轮转');
EOF

# —— V：doctor 输出契约 ——
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execSync } from 'node:child_process';
import { candidates, expectedRevision, playwrightVersion } from './chromium.mjs';
const fail = m => { console.error('❌ ' + m); process.exit(1); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(tmp, d));
fs.writeFileSync(path.join(tmp, 'config.json'), '{"active":0,"profiles":[{"name":"t","baseURL":"http://x/v1","apiKey":"k123456","model":"m"}]}');
// 无缓存 → Chromium 选择应失败且 exit 1，并给修复动作
let r = execSync(`RESUME_ROOT="${tmp}" node doctor.mjs --json || true`, { shell: '/bin/bash' }).toString();
let j = JSON.parse(r);   // --json 下 stdout 只有 JSON 数组（人读行走 stderr）
const chr = j.find(x => x.name === 'Chromium 选择');
if (!chr || chr.ok !== false || !chr.fix) fail('无缓存时 Chromium 选择应失败并给修复动作');
// 种缓存 → 全绿 exit 0
const bin = candidates()[0].bin;
fs.writeFileSync(path.join(tmp, '.chromium-choice.json'), JSON.stringify({ bin, source: 'test', revision: expectedRevision(), playwright: playwrightVersion(), ok: true, probedAt: new Date().toISOString() }));
try {
  r = execSync(`RESUME_ROOT="${tmp}" node doctor.mjs --json`, { shell: '/bin/bash' }).toString();
} catch (e) { fail('种缓存后 doctor 应 exit 0: ' + e.message); }
j = JSON.parse(r);
for (const n of ['数据目录可写', 'pdftotext', 'pdfinfo', '模型配置字段完整', '无需模型可用能力', '最近备份']) {
  const x = j.find(y => y.name === n);
  if (!x) fail('缺检查项 ' + n);
}
if (j.find(x => x.name === '模型连接').ok !== null) fail('模型连接应为未测试(null)，不伪造');
console.log('✅ V doctor 输出契约');
EOF

# —— S1-0：真实数据指纹扩面的负向夹具（隔离 tmp 根，零接触真实数据）——
# 复现方式：用 sed 从 test.sh 原样提取 real_fp 函数（避免两份实现漂移），REAL_ROOT 指向夹具根；
# 比对逻辑按 test.sh 段 17 以函数级复现（`[ "$BEFORE" = "$AFTER" ] || fail` → 不一致时 exit≠0），不跑全量。
S1_FP_DEF=$(sed -n '/^real_fp() {$/,/^}$/p' test.sh)
[ -n "$S1_FP_DEF" ] || { echo '❌ S1-0 无法从 test.sh 提取 real_fp 定义（函数签名/结束行格式变了？）'; exit 1; }
eval "$S1_FP_DEF"
s1_fp() { ( REAL_ROOT="$1"; real_fp ); }                       # 指纹：对指定根求值
s1_cmp() { [ "$1" = "$2" ] || return 1; }                      # 比对：前后不一致 → 非零退出

S1_TMP=$(mktemp -d /tmp/resume-s1-fp.XXXXXX)
trap 'rm -rf "$S1_TMP"' EXIT
mkdir -p "$S1_TMP/docs" "$S1_TMP/snapshots/doc-a" "$S1_TMP/pdfs" "$S1_TMP/backups" "$S1_TMP/logs"
echo '<html>母版A</html>' > "$S1_TMP/docs/a.html"
echo '[]' > "$S1_TMP/applications.json"
echo '[]' > "$S1_TMP/materials.json"
echo '{}' > "$S1_TMP/docs-meta.json"
echo '{"active":0}' > "$S1_TMP/config.json"
echo '<html>快照1</html>' > "$S1_TMP/snapshots/doc-a/1.html"
echo 'pdf-bytes-1' > "$S1_TMP/pdfs/a.pdf"

S1_BASE=$(s1_fp "$S1_TMP")
[ -n "$S1_BASE" ] || { echo '❌ S1-0 指纹输出为空'; exit 1; }
# 正向基线：同一状态两次求值必须一致（指纹确定性），比对逻辑通过
s1_cmp "$S1_BASE" "$(s1_fp "$S1_TMP")" || { echo '❌ S1-0 同一状态指纹不一致（非确定性）'; exit 1; }

# 负向：每一类被覆盖改动都必须被检出 —— 指纹输出不同，且比对逻辑返回非零
s1_check_detected() {  # $1=改动描述；检出后滚动基线，继续验证下一类改动
  local after rc
  after=$(s1_fp "$S1_TMP")
  if [ "$S1_BASE" = "$after" ]; then echo "❌ S1-0 指纹未检出改动：$1"; exit 1; fi
  rc=0; s1_cmp "$S1_BASE" "$after" || rc=$?   # `|| rc=$?` 既捕获退出码又豁免 set -e
  [ "$rc" -ne 0 ] || { echo "❌ S1-0 比对逻辑在前后不一致时未失败（exit=$rc 应为非零）：$1"; exit 1; }
  S1_BASE=$after
}
echo '<html>母版B</html>' > "$S1_TMP/docs/a.html";                    s1_check_detected 'docs/*.html 内容改动'
echo '[{"id":"x"}]' > "$S1_TMP/applications.json";                    s1_check_detected 'applications.json 改动'
echo '<html>快照2</html>' > "$S1_TMP/snapshots/doc-a/2.html";         s1_check_detected 'snapshots/ 新增文件'
echo '<html>快照2改</html>' > "$S1_TMP/snapshots/doc-a/2.html";       s1_check_detected 'snapshots/ 文件内容改动（md5）'
rm "$S1_TMP/snapshots/doc-a/1.html";                                  s1_check_detected 'snapshots/ 删除文件'
echo 'pdf-bytes-2' > "$S1_TMP/pdfs/a.pdf";                            s1_check_detected 'pdfs/ 文件内容改动（md5）'
echo 'bak' > "$S1_TMP/backups/restore-1";                             s1_check_detected 'backups/ 目录列表变化'
echo 'log line' > "$S1_TMP/logs/new.log";                             s1_check_detected 'logs/ 目录列表变化'
echo '{"active":1}' > "$S1_TMP/config.json";                          s1_check_detected 'config.json 内容改动（md5）'
echo '{"ok":true}' > "$S1_TMP/.chromium-choice.json";                 s1_check_detected '.chromium-choice.json 从无到有（存在性）'
echo '✅ S1-0 指纹负向夹具（10 类改动全检出；比对逻辑不一致时 exit≠0）'
rm -rf "$S1_TMP"
trap - EXIT
