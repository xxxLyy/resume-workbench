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

# —— S1-A：freeze.mjs 冻结/归一化/渲染标识/完整资源指纹 ——
# 隔离：本地资源夹具写在 mktemp 根内（经 RESUME_ROOT 解析），零接触真实 docs/snapshots/pdfs。
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { splitDoc, normalizeToCurrent, freezeHtml, resourceFingerprint, staleInfo, sha1 } from './freeze.mjs';
const fail = m => { console.error('❌ S1-A ' + m); process.exit(1); };

// sha1：完整 40 位十六进制，已知向量核对（禁止截断）
if (typeof sha1('abc') !== 'string' || !/^[0-9a-f]{40}$/.test(sha1('abc'))) fail('sha1 应为完整 40 位 hex');
if (sha1('abc') !== 'a9993e364706816aba3e25717850c26c9cd0d89d') fail('sha1 已知向量不符');

// 夹具文档：单 <style> 主样式 + data: 头像 + body 正文
const DATA_AVATAR = 'data:image/png;base64,' + 'A'.repeat(60);
const mkDoc = ({ css = '.a{color:red}', body = '<p>正文一</p>', avatar = DATA_AVATAR, typo = null } = {}) =>
  '<!doctype html>\n<html><head>\n<meta charset="utf-8">\n<style>\n' + css + '\n</style>\n' +
  (typo !== null ? '<style id="typo-custom">' + typo + '</style>\n' : '') +
  '</head>\n<body>\n<img class="avatar" src="' + avatar + '" alt="头像">\n' + body + '\n</body></html>\n';

// ① splitDoc 两态：提取 / 无 typo
const withTypo = mkDoc({ typo: '.x{font-size:15px}' });
const sp1 = splitDoc(withTypo);
if (sp1.typo !== '.x{font-size:15px}') fail('splitDoc 应提取 typo 文本');
if (sp1.html.includes('typo-custom"') || sp1.html.includes('<style id="typo-custom">')) fail('splitDoc 应从 html 剥离 typo-custom 元素');
if (!sp1.html.includes('.a{color:red}') || !sp1.html.includes('<p>正文一</p>')) fail('splitDoc 不应误伤主样式/正文');
const sp2 = splitDoc(mkDoc());
if (sp2.typo !== null) fail('无内联 typo 时应返回 null，实际 ' + JSON.stringify(sp2.typo));
if (sp2.html !== mkDoc()) fail('无 typo 时 html 应原样');

// ② 归一化 HTML 幂等（完整对象不要求同）：对"有 typo / 无 typo"两态都成立
for (const h of [withTypo, mkDoc()]) {
  const n1 = normalizeToCurrent(h);
  const n2 = normalizeToCurrent(n1.html);
  if (n2.html !== n1.html) fail('normalizeToCurrent HTML 不幂等');
}
const nz = normalizeToCurrent(withTypo);
if (nz.typo !== '.x{font-size:15px}') fail('normalizeToCurrent 应返回提取的 typo');
if (normalizeToCurrent(mkDoc()).typo !== '') fail('normalizeToCurrent 无 typo 时应为空串');
if (nz.styleHash !== sha1('\n.a{color:red}\n')) fail('styleHash 应为主 <style> CSS 文本的 sha1');
const themed = normalizeToCurrent(mkDoc({ css: '.a{}' }).replace('<style>', '<style data-theme="classic">'));
if (themed.theme !== 'classic') fail('theme 应取 <style> data-theme 属性');

// ③ freezeHtml 以 meta.typo 为准（html 内旧内联值被覆盖；无"已有就跳过"分支）
const fz = freezeHtml(withTypo, { typo: '.x{font-size:20px}' });
if (!fz.html.includes('<style id="typo-custom">.x{font-size:20px}</style>')) fail('freezeHtml 应注入 meta.typo');
if (fz.html.includes('font-size:15px')) fail('freezeHtml 中旧内联 typo 应被 meta.typo 覆盖');
const cnt = fz.html.split('<style id="typo-custom">').length - 1;
if (cnt !== 1) fail('freezeHtml 应恰有一个 typo-custom 块，实际 ' + cnt);
if (!/<style id="typo-custom">[^<]*<\/style>\s*<\/head>/.test(fz.html)) fail('typo 块应内联在 </head> 前');
const fzNoTypo = freezeHtml(withTypo, {});
if (fzNoTypo.html.includes('typo-custom"')) fail('meta 无 typo 时冻结产物不应含 typo-custom（先归一化）');

// ④ renderInputId：随正文/typo/css 变化；随 body 外空白不变；含正文且完整
for (const k of ['bodyHash', 'cssHash', 'typoHash', 'resourcesHash', 'renderInputId']) {
  if (!/^[0-9a-f]{40}$/.test(fz[k])) fail(k + ' 应为完整 40 位 hex');
}
if (fz.renderInputId !== sha1(fz.bodyHash + ':' + fz.cssHash + ':' + fz.typoHash + ':' + fz.resourcesHash)) fail('renderInputId 组合式不符');
const baseId = freezeHtml(mkDoc(), { typo: '' }).renderInputId;
if (freezeHtml(mkDoc({ body: '<p>正文二</p>' }), { typo: '' }).renderInputId === baseId) fail('renderInputId 应随正文变化');
if (freezeHtml(mkDoc(), { typo: '.q{color:blue}' }).renderInputId === baseId) fail('renderInputId 应随 typo 变化');
if (freezeHtml(mkDoc({ css: '.a{color:blue}' }), { typo: '' }).renderInputId === baseId) fail('renderInputId 应随 css 变化');
const wsDoc = mkDoc().replace('</head>\n<body>', '</head>\n\n   \n<body>').replace('</body></html>\n', '</body>\n\n  </html>\n\n\n');
if (freezeHtml(wsDoc, { typo: '' }).renderInputId !== baseId) fail('renderInputId 不应随 body 外空白变化');

// ⑤ 资源指纹：完整内容哈希（data: 第 70 字符差异可检出）+ 本地文件内容哈希 + http(s) 远程 + 缺失
const PRE = 'data:image/png;base64,' + 'A'.repeat(47);           // 前缀恰 69 字符
const d1 = PRE + 'X' + 'B'.repeat(30), d2 = PRE + 'Y' + 'B'.repeat(30);
if (d1.slice(0, 69) !== d2.slice(0, 69) || d1[69] === d2[69]) fail('夹具构造错误：应仅第 70 字符不同');
const fp1 = resourceFingerprint(mkDoc({ avatar: d1 }));
const fp2 = resourceFingerprint(mkDoc({ avatar: d2 }));
if (fp1.resourcesHash === fp2.resourcesHash) fail('data: 仅第 70 字符不同也必须检出（禁止前缀截断）');
if (fp1.reproducible !== true || fp1.remote.length !== 0 || fp1.missing.length !== 0) fail('纯 data: 应 reproducible=true');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-s1a-'));
fs.mkdirSync(path.join(tmpRoot, 'fonts'), { recursive: true });
const fontFile = path.join(tmpRoot, 'fonts', 'f.woff2');
fs.writeFileSync(fontFile, 'FONT-CONTENT-V1');
process.env.RESUME_ROOT = tmpRoot;   // 本地相对路径按文档根（RESUME_ROOT）解析
const fontDoc = (extraCss = '') => mkDoc({ css: '@font-face{src:url(fonts/f.woff2)}' + extraCss });
const lf1 = resourceFingerprint(fontDoc());
if (!lf1.reproducible) fail('可读本地字体应 reproducible=true: ' + JSON.stringify(lf1));
fs.writeFileSync(fontFile, 'FONT-CONTENT-V2');   // 改 1 字节
const lf2 = resourceFingerprint(fontDoc());
if (lf2.resourcesHash === lf1.resourcesHash) fail('本地字体文件内容改 1 字节应改变 resourcesHash');
const absDoc = mkDoc({ css: '@font-face{src:url(' + fontFile + ')}' });   // 绝对路径同样按内容哈希
if (resourceFingerprint(absDoc).resourcesHash !== lf2.resourcesHash) fail('绝对路径与相对路径应同为文件内容哈希');

// http(s) 远程 URL：入 remote[] 且 reproducible=false（不在本任务实现 /export 拒绝）
const rmt = resourceFingerprint(fontDoc('@page{background:url(https://cdn.example.com/bg.png)}')
  .replace('</head>', '<link rel="stylesheet" href="http://x.example.com/a.css"></head>'));
if (rmt.remote.length !== 2 || !rmt.remote.includes('https://cdn.example.com/bg.png') || !rmt.remote.includes('http://x.example.com/a.css')) fail('remote 应收集 http(s) URL: ' + JSON.stringify(rmt.remote));
if (rmt.reproducible !== false) fail('含远程 URL 应 reproducible=false');

// 缺失/不可读本地文件：入 missing[] 且 reproducible=false
const miss = resourceFingerprint(mkDoc({ css: '@font-face{src:url(fonts/nope.woff2)}' }));
if (miss.missing.length !== 1 || miss.missing[0] !== 'fonts/nope.woff2') fail('missing 应含缺失引用: ' + JSON.stringify(miss.missing));
if (miss.reproducible !== false) fail('缺失文件应 reproducible=false');
delete process.env.RESUME_ROOT;
fs.rmSync(tmpRoot, { recursive: true, force: true });

// freezeHtml 透传资源三字段
const fzRemote = freezeHtml(mkDoc({ css: '.a{background:url(https://e.com/x.png)}' }), { typo: '' });
if (!Array.isArray(fzRemote.remote) || fzRemote.remote.length !== 1 || fzRemote.reproducible !== false || !Array.isArray(fzRemote.missing)) fail('freezeHtml 应透传 remote/missing/reproducible');

// ⑥ staleInfo 三态：fresh / stale / none（mtime 不参与判定）
const sFresh = staleInfo({ lastRenderInputId: 'a1' }, { renderInputId: 'a1', pdfExists: true });
const sStale = staleInfo({ lastRenderInputId: 'a1' }, { renderInputId: 'b2', pdfExists: true });
const sNone = staleInfo({}, { renderInputId: 'b2', pdfExists: false });
if (sFresh.state !== 'fresh' || sFresh.stale !== false) fail('staleInfo fresh 态: ' + JSON.stringify(sFresh));
if (sStale.state !== 'stale' || sStale.stale !== true) fail('staleInfo stale 态: ' + JSON.stringify(sStale));
if (sNone.state !== 'none' || sNone.stale !== true) fail('staleInfo none 态: ' + JSON.stringify(sNone));
if (staleInfo({ lastRenderInputId: 'a1' }, { renderInputId: 'a1', pdfExists: false }).state !== 'none') fail('无 PDF 时即使标识一致也应 none');

// render.mjs meta-blind 静态确认：不读 docs-meta，入口只有 --src/--out（及 docId 便利模式）
const renderSrc = fs.readFileSync('render.mjs', 'utf8');
if (/docs-meta|loadMeta|meta\.typo/.test(renderSrc)) fail('render.mjs 不得引用 docs-meta / meta.typo（铁律二）');
if (!renderSrc.includes("'--src'") || !renderSrc.includes("'--out'")) fail('render.mjs 应保留 --src/--out 入口');
console.log('✅ S1-A freeze 六导出：splitDoc 两态/HTML 幂等/meta.typo 覆盖/renderInputId 含正文/完整资源指纹/staleInfo 三态/render meta-blind');
EOF

# —— S1-B：tx.mjs 保存事务恢复 + 共享 docs-meta 原子更新（含两进程并发不丢字段）+ 文档锁/根锁 ——
# 隔离：全部写在 mktemp 根内，零接触真实 docs/snapshots/pdfs/JSON。
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawn } from 'node:child_process'; import { pathToFileURL } from 'node:url';
import { beginTx, commitTx, dropSupersededTx, recoverPending, withDocLock, updateMeta, rootLock, LockHeld } from './tx.mjs';
const fail = (m) => { console.error('❌ S1-B ' + m); process.exit(1); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-s1b-'));
fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
const metaFile = path.join(tmp, 'docs-meta.json');
const txFile = (id, ext) => path.join(tmp, '.tx', id + ext);
const readMeta = () => JSON.parse(fs.readFileSync(metaFile, 'utf8'));

// ① beginTx/commitTx 生命周期：写 .json + .meta.json（目标文档旧 meta 整份副本）+ .html（旧正文），commit 清空
fs.writeFileSync(path.join(tmp, 'docs', 'A.html'), '<html><body>OLD-A</body></html>');
fs.writeFileSync(metaFile, JSON.stringify({ A: { typo: 'a-typo', rev: 3 }, B: { tag: 'b-tag' } }));
const txId = beginTx(tmp, 'A', 'save', '2026-01-01-000000');
if (!fs.existsSync(txFile(txId, '.json'))) fail('beginTx 未写 .tx/<txId>.json');
if (!fs.existsSync(txFile(txId, '.meta.json'))) fail('beginTx 未写 .tx/<txId>.meta.json');
if (!fs.existsSync(txFile(txId, '.html'))) fail('beginTx 未备份旧正文到 .tx/<txId>.html');
const rec0 = JSON.parse(fs.readFileSync(txFile(txId, '.json'), 'utf8'));
if (rec0.docId !== 'A' || rec0.phase !== 'save' || rec0.oldSnapTs !== '2026-01-01-000000') fail('tx 记录字段不符: ' + JSON.stringify(rec0));
const backed = JSON.parse(fs.readFileSync(txFile(txId, '.meta.json'), 'utf8'));
if (!backed || backed.typo !== 'a-typo' || backed.rev !== 3) fail('.meta.json 应为目标文档旧 meta 整份副本: ' + JSON.stringify(backed));
if (!fs.readFileSync(txFile(txId, '.html'), 'utf8').includes('OLD-A')) fail('.html 应为旧正文副本');
commitTx(tmp, txId);
if (fs.existsSync(txFile(txId, '.json')) || fs.existsSync(txFile(txId, '.meta.json')) || fs.existsSync(txFile(txId, '.html'))) fail('commitTx 未清空 tx 记录');
console.log('✅ S1-B-1 beginTx/commitTx 生命周期（.json/.meta.json/.html 写全并清空）');

// ② recoverPending 只恢复目标文档：A 半程（html 新、meta 新）回滚到旧；A 事务开始后并发更新的 B 不被覆盖
fs.writeFileSync(path.join(tmp, 'docs', 'A.html'), '<html><body>OLD-A</body></html>');
fs.writeFileSync(metaFile, JSON.stringify({ A: { typo: 'a-typo', rev: 3 }, B: { tag: 'b-tag' } }));
const tx2 = beginTx(tmp, 'A', 'save', '');          // 捕获 OLD-A + A.meta(rev3)
// 模拟中断：rename#1 改了正文、rename#2 改了 A.meta（推进到 rev4），且 B 在 A 事务开始之后并发更新
fs.writeFileSync(path.join(tmp, 'docs', 'A.html'), '<html><body>NEW-A</body></html>');
updateMeta(tmp, 'A', () => ({ typo: 'a-typo', rev: 4 }));
updateMeta(tmp, 'B', (m) => ({ ...(m || {}), tag: 'b-CONCURRENT' }));
const recovered = recoverPending(tmp, { restoreDoc: (rec) => {
  if (rec.docId !== 'A') fail('recoverPending 应只处理事务指名文档，实得 ' + rec.docId);
  if (typeof rec.oldHtml === 'string') fs.writeFileSync(path.join(tmp, 'docs', rec.docId + '.html'), rec.oldHtml);
  updateMeta(tmp, rec.docId, () => rec.oldMeta);
} });
if (recovered.length !== 1) fail('recovered 应含 1 条: ' + recovered.length);
const afterMeta = readMeta();
if (afterMeta.A.rev !== 3) fail('A.meta 应回滚到旧值 rev=3: ' + JSON.stringify(afterMeta.A));
if (afterMeta.B.tag !== 'b-CONCURRENT') fail('B 的并发更新被恢复覆盖（应保留）: ' + JSON.stringify(afterMeta.B));
if (!fs.readFileSync(path.join(tmp, 'docs', 'A.html'), 'utf8').includes('OLD-A')) fail('A.html 应回滚到旧正文');
if (fs.readdirSync(path.join(tmp, '.tx')).some((f) => f.endsWith('.json'))) fail('recoverPending 未清空 tx 记录');
console.log('✅ S1-B-2 recoverPending 只恢复目标文档（B 事务后并发更新不丢）');

// ③ updateMeta 两进程并发交替 patch 不同文档 → 两文档字段都在（无丢失更新）
fs.writeFileSync(metaFile, JSON.stringify({}));
const txUrl = pathToFileURL(path.join(process.cwd(), 'tx.mjs')).href;
const childFile = path.join(tmp, 'child.mjs');
fs.writeFileSync(childFile, `import { updateMeta } from '${txUrl}';
const root = process.argv[2], docId = process.argv[3], prefix = process.argv[4], n = Number(process.argv[5]);
for (let i = 0; i < n; i++) {
  updateMeta(root, docId, (m) => ({ ...(m || {}), [prefix + i]: i }));
  const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, 1 + (i % 3)); // 主动让出，制造跨进程读改写交错
}
`);
const runChild = (docId, prefix, n) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [childFile, tmp, docId, prefix, String(n)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => err += d);
  c.on('error', reject); c.on('exit', (code) => code === 0 ? resolve() : reject(new Error('child exit ' + code + ': ' + err)));
});
await Promise.all([runChild('docA', 'a', 60), runChild('docB', 'b', 60)]);
const cm = readMeta();
if (!cm.docA || !cm.docB) fail('两进程并发后两文档都应存在: ' + JSON.stringify(Object.keys(cm)));
for (let i = 0; i < 60; i++) {
  if (cm.docA['a' + i] !== i) fail('docA 丢失字段 a' + i + '（并发丢失更新）');
  if (cm.docB['b' + i] !== i) fail('docB 丢失字段 b' + i + '（并发丢失更新）');
}
console.log('✅ S1-B-3 updateMeta 两进程并发 60×2 交替 patch → 两文档字段全在');

// ④ withDocLock：同文档重入抛 LockHeld；释放后可再用；不同文档不互斥
if (withDocLock(tmp, 'A', () => 'done-A') !== 'done-A') fail('withDocLock 同步 fn 应返回其值');
const hold = withDocLock(tmp, 'A', async () => { await new Promise((r) => setTimeout(r, 60)); return 'held'; });
let threw = false; try { withDocLock(tmp, 'A', () => 'x'); } catch (e) { if (e instanceof LockHeld) threw = true; }
if (!threw) fail('持锁期间同文档重入应抛 LockHeld');
if (withDocLock(tmp, 'B', () => 'b-ok') !== 'b-ok') fail('不同文档不应互斥');
if ((await hold) !== 'held') fail('withDocLock 异步 fn 应返回其值');
if (withDocLock(tmp, 'A', () => 'again') !== 'again') fail('释放后应可再次持锁');
console.log('✅ S1-B-4 withDocLock 重入 LockHeld/释放/异文档不互斥');

// ⑤ rootLock：acquire/release/isHeld + 死 pid 陈旧锁自动破除；持锁期间再 acquire 抛 LockHeld
if (rootLock.isHeld(tmp)) fail('无锁时 isHeld 应 false');
rootLock.acquire(tmp);
if (!rootLock.isHeld(tmp)) fail('acquire 后 isHeld 应 true');
let migThrew = false; try { rootLock.acquire(tmp); } catch (e) { if (e instanceof LockHeld) migThrew = true; }
if (!migThrew) fail('持锁期间再 acquire 应抛 LockHeld（同 pid 非陈旧）');
rootLock.release(tmp);
if (rootLock.isHeld(tmp)) fail('release 后 isHeld 应 false');
fs.writeFileSync(path.join(tmp, '.migrate.lock'), JSON.stringify({ pid: 999999, host: 'x', startedAt: Date.now() }));  // 死 pid（超 pid_max）
if (rootLock.isHeld(tmp)) fail('死 pid 锁应视为陈旧（isHeld=false）');
rootLock.acquire(tmp);                                  // 应破除陈旧锁后成功持有
if (!rootLock.isHeld(tmp)) fail('破除陈旧锁后应持有');
rootLock.release(tmp);
console.log('✅ S1-B-5 rootLock acquire/release/isHeld + 陈旧锁破除');

// ⑥ I-1：标记（.json）已落盘但载荷（.meta.json）未落盘时被杀 → 恢复视为孤儿：清标记、绝不动文档正文/meta
fs.writeFileSync(path.join(tmp, 'docs', 'C.html'), '<html><body>OLD-C</body></html>');
fs.writeFileSync(metaFile, JSON.stringify({ C: { typo: 'c-typo', rev: 9 } }));
const orphanId = 'orphan-marker-1';
fs.mkdirSync(path.join(tmp, '.tx'), { recursive: true });
fs.writeFileSync(txFile(orphanId, '.json'), JSON.stringify({ txId: orphanId, docId: 'C', phase: 'save', oldSnapTs: '', startedAt: Date.now(), host: 'x', pid: process.pid }));
const r6 = recoverPending(tmp);                       // 内置默认恢复（与 server 版同语义：oldMeta=null → 删条目）
const m6 = readMeta();
if (fs.existsSync(txFile(orphanId, '.json'))) fail('I-1 孤儿标记（无载荷）应被清理');
if (!m6.C || m6.C.typo !== 'c-typo' || m6.C.rev !== 9) fail('I-1 标记无载荷时不得删/改文档 meta 条目: ' + JSON.stringify(m6));
if (!fs.readFileSync(path.join(tmp, 'docs', 'C.html'), 'utf8').includes('OLD-C')) fail('I-1 孤儿事务不得改动正文');
if (r6.length) fail('I-1 孤儿事务不应计入 recovered: ' + r6.length);
console.log('✅ S1-B-6 I-1 标记无载荷 = 孤儿（清标记，文档正文/meta 零改动）');

// ⑦ I-1：载荷损坏（.meta.json 不可解析）→ 不得当成"事务前无 meta"而删条目；保留记录 + ok:false 待人工
const corruptId = 'corrupt-payload-1';
fs.writeFileSync(txFile(corruptId, '.json'), JSON.stringify({ txId: corruptId, docId: 'C', phase: 'save', oldSnapTs: '', startedAt: Date.now(), host: 'x', pid: process.pid }));
fs.writeFileSync(txFile(corruptId, '.meta.json'), '{ "typo": ');      // 半截 JSON
const r7 = recoverPending(tmp);
const m7 = readMeta();
if (!fs.existsSync(txFile(corruptId, '.json')) || !fs.existsSync(txFile(corruptId, '.meta.json'))) fail('I-1 载荷损坏时应保留 tx 记录待重试/人工');
if (r7.length !== 1 || r7[0].ok !== false) fail('I-1 载荷损坏应返回 ok:false（不得静默按 null 恢复）: ' + JSON.stringify(r7.map((x) => ({ ok: x.ok, e: x.error }))));
if (!m7.C || m7.C.typo !== 'c-typo' || m7.C.rev !== 9) fail('I-1 载荷损坏不得删/改文档 meta: ' + JSON.stringify(m7));
if (!fs.readFileSync(path.join(tmp, 'docs', 'C.html'), 'utf8').includes('OLD-C')) fail('I-1 载荷损坏不得改动正文');
commitTx(tmp, corruptId);
console.log('✅ S1-B-7 I-1 载荷损坏 → 保留记录 + ok:false，文档零改动');

// ⑧ I-2 尾险：成功保存后 dropSupersededTx 只清"同文档"的旧未完成记录（异文档记录是别人恢复的依据，必须保留）
const txA8 = beginTx(tmp, 'A', 'save', '');
const txB8 = beginTx(tmp, 'B', 'save', '');
const n8 = dropSupersededTx(tmp, 'A');
if (n8 !== 1) fail('I-2 dropSupersededTx 应清掉同文档 1 条记录，实得 ' + n8);
if (fs.existsSync(txFile(txA8, '.json')) || fs.existsSync(txFile(txA8, '.meta.json')) || fs.existsSync(txFile(txA8, '.html'))) fail('I-2 同文档旧记录三份都应清掉');
if (!fs.existsSync(txFile(txB8, '.json')) || !fs.existsSync(txFile(txB8, '.meta.json'))) fail('I-2 异文档记录不得被清（其他文档仍要靠它恢复）');
if (dropSupersededTx(tmp, 'B') !== 1) fail('I-2 dropSupersededTx 应能清掉 B 的记录');
if (fs.readdirSync(path.join(tmp, '.tx')).some((f) => f.endsWith('.json'))) fail('I-2 清理后 .tx 不应残留标记');
console.log('✅ S1-B-8 I-2 dropSupersededTx 只清同文档旧记录（异文档保留）');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✅ S1-B tx 恢复/updateMeta 并发不丢字段/文档锁/根锁 全部通过');
EOF

# —— S1-C：渲染环境旁车 <out>.env.json（真实 render.mjs）+ staleInfo 三态（服务级：徽章/头部/标识记录；mtime 不作正确性依据）——
# 隔离：旁车段在 mktemp 根内真实渲染夹具（零接触真实 docs/pdfs）；三态段自 spawn 隔离根 + 隔离端口 + 假渲染器的服务。
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { freezeHtml } from './freeze.mjs';
import { resolveChromium } from './chromium.mjs';
const fail = (m) => { console.error('❌ S1-C ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RENDER_MJS = path.join(process.cwd(), 'render.mjs');

// ---------- S1-C-1 旁车字段（bin/browserVersion/fonts/dpi=150/renderInputId/reproducible/at；env 透传，render.mjs meta-blind）----------
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 's1c-env-'));
const RDATA = path.join(tmpA, 'data');
fs.mkdirSync(RDATA, { recursive: true });
process.env.RESUME_ROOT = RDATA;   // chromium 缓存/探针都落在隔离根（段 Y 同款语义）
try { await resolveChromium({ tmpDir: tmpA }); }
catch (e) { fail('Chromium 不可用（旁车需真实渲染）: ' + (e && e.message || e)); }
const srcFile = path.join(tmpA, 'fixture.html');
fs.writeFileSync(srcFile, '<!doctype html><html><head><meta charset="utf-8"></head><body><p>旁车夹具</p></body></html>');
const RID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const runRender = (out, env) => {
  const r = spawnSync(process.execPath, [RENDER_MJS, '--src', srcFile, '--out', out], {
    env: { ...process.env, RESUME_ROOT: RDATA, ...env }, encoding: 'utf8', timeout: 180000
  });
  if (r.status !== 0) fail('render.mjs 退出码 ' + r.status + ': ' + String(r.stderr || r.stdout || '').slice(0, 400));
};
const readSidecar = (out) => {
  const f = out + '.env.json';
  if (!fs.existsSync(f)) fail('未写旁车: ' + f);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { fail('旁车不可解析: ' + e.message); }
};
// ① 完整 env：7 字段全、dpi=150、renderInputId/reproducible 按 env 透传
const out1 = path.join(tmpA, 'o1.pdf');
runRender(out1, { RESUME_RENDER_INPUT_ID: RID, RESUME_RENDER_REPRODUCIBLE: '1' });
if (!fs.existsSync(out1)) fail('PDF 未生成');
const s1 = readSidecar(out1);
for (const k of ['bin', 'browserVersion', 'fonts', 'dpi', 'renderInputId', 'reproducible', 'at']) if (!(k in s1)) fail('旁车缺字段 ' + k + ': ' + JSON.stringify(s1));
if (s1.dpi !== 150) fail('dpi 应为 150，实际 ' + s1.dpi);
if (s1.renderInputId !== RID) fail('renderInputId 未按 env 透传: ' + s1.renderInputId);
if (s1.reproducible !== true) fail('RESUME_RENDER_REPRODUCIBLE=1 应记 true: ' + s1.reproducible);
if (typeof s1.bin !== 'string' || !s1.bin || !fs.existsSync(s1.bin)) fail('bin 应为存在的可执行路径: ' + s1.bin);
if (typeof s1.browserVersion !== 'string' || !s1.browserVersion) fail('browserVersion 应为非空字符串: ' + JSON.stringify(s1.browserVersion));
if (!Array.isArray(s1.fonts)) fail('fonts 应为数组: ' + JSON.stringify(s1.fonts));
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s1.at))) fail('at 应为 ISO 时间: ' + s1.at);
// ② reproducible=0 → false（remote/missing 由 freeze 判定，render 只记录）
const out2 = path.join(tmpA, 'o2.pdf');
runRender(out2, { RESUME_RENDER_INPUT_ID: RID, RESUME_RENDER_REPRODUCIBLE: '0' });
if (readSidecar(out2).reproducible !== false) fail('RESUME_RENDER_REPRODUCIBLE=0 应记 false');
// ③ 未设 env（快照/存档等直调路径）：renderInputId/reproducible 记 null，环境字段照写（不伪造）
const out3 = path.join(tmpA, 'o3.pdf');
runRender(out3, {});
const s3 = readSidecar(out3);
if (s3.renderInputId !== null || s3.reproducible !== null) fail('未设 env 应记 null（不伪造）: ' + JSON.stringify(s3));
if (s3.dpi !== 150 || !s3.browserVersion || !Array.isArray(s3.fonts)) fail('未设 env 环境字段仍应写全: ' + JSON.stringify(s3));
fs.rmSync(tmpA, { recursive: true, force: true });
console.log('✅ S1-C-1 渲染旁车 <out>.env.json（7 字段/dpi=150/renderInputId+reproducible env 透传/未设记 null）');

// ---------- S1-C-2 staleInfo 三态（服务级）：none/stale/fresh 全按渲染标识；仅 mtime 变不 stale 不重渲 ----------
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 's1c-srv-'));
const ROOT = path.join(tmpB, 'data');
for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs-meta.json'), '{}');
fs.writeFileSync(path.join(ROOT, 'applications.json'), '[]');
fs.writeFileSync(path.join(ROOT, 'materials.json'), '[]');
const docFile = path.join(ROOT, 'docs', 'sc1.html');
const mkHtml = (body) => '<!doctype html><html><head><meta charset="utf-8"><style>.s{color:#111}</style></head><body><h1>夹具</h1><div class="sheet">' + body + "</div><script>var DOC_ID = 'sc1';</script></body></html>";
fs.writeFileSync(docFile, mkHtml('SC-V1'));
const fr = path.join(tmpB, 'fake-render.sh');
fs.writeFileSync(fr, '#!/bin/bash\nshift\nn=$(cat "$RESUME_ROOT/.render-count" 2>/dev/null || echo 0); echo $((n+1)) > "$RESUME_ROOT/.render-count"\nif [ "$1" = "--src" ]; then out="$4"; else out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\nprintf "%%PDF-1.4 fake\\n" > "$out"\n');
fs.chmodSync(fr, 0o755);
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = await freePort();
process.env.RESUME_ROOT = ROOT;
const srv = spawn(process.execPath, ['server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, RESUME_ROOT: ROOT, PORT: String(port), RESUME_RENDER_BIN: fr },
  stdio: ['ignore', 'ignore', 'pipe']
});
let serr = ''; srv.stderr.on('data', (d) => { serr += d; });
const B = 'http://127.0.0.1:' + port;
const metaOf = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'docs-meta.json'), 'utf8'))['sc1'] || {}; } catch { return {}; } };
const renderCount = () => { try { return Number(fs.readFileSync(path.join(ROOT, '.render-count'), 'utf8').trim()); } catch { return 0; } };
try {
  let up = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) { if (srv.exitCode !== null) break; try { await fetch(B + '/'); up = true; break; } catch {} await sleep(80); }
  if (!up) fail('测试服务启动失败: ' + serr.slice(0, 500));
  // —— none 态：无 PDF → 徽章「PDF 未生成」；GET /pdf 组装渲染 → fresh 并记 meta.lastRenderInputId/lastRenderAt ——
  const home1 = await (await fetch(B + '/')).text();
  if (!home1.includes('PDF 未生成')) fail('none 态首页徽章应「PDF 未生成」');
  const rid1 = freezeHtml(fs.readFileSync(docFile, 'utf8'), {}).renderInputId;
  const r1 = await fetch(B + '/pdf?id=sc1');
  if (r1.status !== 200) { const t = await r1.text().catch(() => ''); fail('/pdf 应 200，实际 ' + r1.status + '：' + t.slice(0, 200)); }
  if (r1.headers.get('X-PDF-Stale') !== '0') fail('渲染成功后 X-PDF-Stale 应为 0');
  if (!(r1.headers.get('Content-Disposition') || '').includes("filename*=UTF-8''")) fail('中文文件名应走 RFC 5987 filename*（非 ASCII 直写头会 500）: ' + r1.headers.get('Content-Disposition'));
  if (!fs.existsSync(path.join(ROOT, 'pdfs', 'sc1.pdf'))) fail('/pdf 未生成 PDF');
  if (renderCount() !== 1) fail('/pdf 应恰好触发一次组装渲染，实际 ' + renderCount());
  const m1 = metaOf();
  if (m1.lastRenderInputId !== rid1) fail('成功渲染应记该任务标识 lastRenderInputId: ' + JSON.stringify(m1));
  if (!m1.lastRenderAt) fail('成功渲染应记 lastRenderAt: ' + JSON.stringify(m1));
  const home2 = await (await fetch(B + '/')).text();
  if (!home2.includes('PDF 同步')) fail('fresh 态首页徽章应「PDF 同步」');
  // —— 仅 mtime 变（输入不变）→ 不 stale、不重渲（mtime 不作正确性依据）——
  const future = (Date.now() + 10000) / 1000;
  fs.utimesSync(docFile, future, future);
  const r2 = await fetch(B + '/pdf?id=sc1');
  if (r2.headers.get('X-PDF-Stale') !== '0') fail('仅 mtime 变不应判 stale');
  if (renderCount() !== 1) fail('仅 mtime 变不应触发重渲（' + renderCount() + '）');
  const home2b = await (await fetch(B + '/')).text();
  if (!home2b.includes('PDF 同步')) fail('仅 mtime 变徽章仍应「PDF 同步」');
  // —— stale 态：正文改 → 徽章「PDF 较旧」、/save pdfStale=true；GET /pdf 重渲并更新为该任务标识 ——
  fs.writeFileSync(docFile, mkHtml('SC-V2'));
  const home3 = await (await fetch(B + '/')).text();
  if (!home3.includes('PDF 较旧')) fail('stale 态首页徽章应「PDF 较旧」');
  const sv1 = await (await fetch(B + '/save?id=sc1', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: mkHtml('SC-V2') })).json();
  if (!sv1.ok) fail('/save 失败: ' + JSON.stringify(sv1));
  if (sv1.pdfStale !== true) fail('标识不符时 /save pdfStale 应 true: ' + JSON.stringify(sv1));
  const r3 = await fetch(B + '/pdf?id=sc1');
  if (r3.headers.get('X-PDF-Stale') !== '0') fail('stale 重渲后应 fresh');
  if (renderCount() !== 2) fail('stale 应恰好触发一次重渲（' + renderCount() + '）');
  const rid2 = freezeHtml(fs.readFileSync(docFile, 'utf8'), metaOf()).renderInputId;
  if (metaOf().lastRenderInputId !== rid2) fail('重渲后应更新为该任务标识: ' + JSON.stringify(metaOf()));
  const sv2 = await (await fetch(B + '/save?id=sc1', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: mkHtml('SC-V2') })).json();
  if (sv2.pdfStale !== false) fail('fresh 时 /save pdfStale 应 false: ' + JSON.stringify(sv2));
  // —— none 态（删 PDF 后）：标识一致也判 none ——
  fs.rmSync(path.join(ROOT, 'pdfs', 'sc1.pdf'), { force: true });
  const home4 = await (await fetch(B + '/')).text();
  if (!home4.includes('PDF 未生成')) fail('删 PDF 后应回 none 态（未生成）');
  console.log('✅ S1-C-2 staleInfo 三态服务级（徽章三态/X-PDF-Stale/lastRenderInputId 记录//save pdfStale；仅 mtime 变不 stale 不重渲）');
} finally {
  srv.kill('SIGKILL');
  await sleep(50);
  fs.rmSync(tmpB, { recursive: true, force: true });
  delete process.env.RESUME_ROOT;
}
EOF
