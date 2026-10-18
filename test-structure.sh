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
// S1 热修：meta 无 typo（legacy）→ 冻结产物保留内联 typo（不得被空 meta 剥掉；裁决见 S1-HF 节）
const fzLegacy = freezeHtml(withTypo, {});
if (!fzLegacy.html.includes('<style id="typo-custom">.x{font-size:15px}</style>')) fail('S1 热修：legacy（meta 无 typo）冻结产物应保留内联 typo');

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

// ⑤b 负向（Task 2 review Minor-1 → S1-T9 加固）：属性值含 '>' 时标签不得被截断漏收 src
//     旧正则 [^>]* 在 <img alt="a > b" src="x.png"> 的引号内 '>' 处截断 → src 漏收 → 误判 reproducible:true（方向错误）
const gtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-s1a-gt-'));
process.env.RESUME_ROOT = gtRoot;   // 相对资源落在隔离根（绝不写真实根）
const gtDoc = '<!doctype html><html><head></head><body><img alt="a > b" src="pic.png"></body></html>';
const gt = resourceFingerprint(gtDoc);
if (gt.missing.length !== 1 || gt.missing[0] !== 'pic.png') fail('属性值含 > 时标签被截断漏收 src（应入 missing）: ' + JSON.stringify(gt.missing));
if (gt.reproducible !== false) fail('缺失 src 应 reproducible=false');
const gtRemote = resourceFingerprint('<body><img alt="a > b" src="https://e.com/gt.png"></body>');
if (gtRemote.remote.length !== 1 || gtRemote.reproducible !== false) fail('属性值含 > 时远程 src 不得漏收（漏收=误判可复现，方向错误）: ' + JSON.stringify(gtRemote));
fs.writeFileSync(path.join(gtRoot, 'pic.png'), 'PNG-GT');
const gt2 = resourceFingerprint(gtDoc);
if (gt2.reproducible !== true || gt2.missing.length !== 0 || gt2.resourcesHash === gt.resourcesHash) fail('src 落盘后应按文件内容哈希且 reproducible=true: ' + JSON.stringify(gt2));
const gtSingle = resourceFingerprint("<body><img alt='a > b' src='p2.png'></body>");
if (gtSingle.missing.length !== 1 || gtSingle.missing[0] !== 'p2.png') fail('单引号属性值含 > 同样不得截断: ' + JSON.stringify(gtSingle.missing));
delete process.env.RESUME_ROOT;
fs.rmSync(gtRoot, { recursive: true, force: true });

// ⑤c 负向（Task 9 review Minor-1）：病态未闭合引号（<img src=x alt=a"b>）RES_TAG_RE 整标签不匹配，
//     但宽松回退仍须收集 src —— 本地缺失入 missing[]、远程 url 翻 reproducible=false（漏收=误判可复现，方向错误）
const mfRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-s1a-mf-'));
process.env.RESUME_ROOT = mfRoot;   // 隔离根，绝不触碰真实数据
const mfLocal = resourceFingerprint('<body><img src=malformed.png alt=a"b></body>');
if (mfLocal.missing.length !== 1 || mfLocal.missing[0] !== 'malformed.png') fail('未闭合引号 malformed 标签的 src 应经回退收集入 missing: ' + JSON.stringify(mfLocal.missing));
if (mfLocal.reproducible !== false) fail('malformed 标签缺失 src 应 reproducible=false');
const mfRemote = resourceFingerprint('<body><img src=https://e.com/mf.png alt=a"b></body>');
if (mfRemote.remote.length !== 1 || mfRemote.remote[0] !== 'https://e.com/mf.png' || mfRemote.reproducible !== false) fail('未闭合引号 malformed 标签的远程 src 应收集且 reproducible=false: ' + JSON.stringify(mfRemote));
delete process.env.RESUME_ROOT;
fs.rmSync(mfRoot, { recursive: true, force: true });

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
console.log('✅ S1-A freeze 六导出：splitDoc 两态/HTML 幂等/meta.typo 覆盖/renderInputId 含正文/完整资源指纹（含属性值带 > 不截断/malformed 回退）/staleInfo 三态/render meta-blind');
EOF

# —— S1-HF：热修 — legacy 内联排版优先于空 meta（裁决：effective typo = (meta.typo 定义且非空) ? meta.typo : (内联值 if present else '')）——
# 隔离：纯函数，零 IO，绝不触碰真实 docs/snapshots/pdfs。
node --input-type=module << 'EOF'
import { freezeHtml, sha1 } from './freeze.mjs';
const fail = m => { console.error('❌ S1-HF ' + m); process.exit(1); };
const doc = (typo) => '<!doctype html>\n<html><head>\n<style>.a{color:red}</style>\n'
  + (typo !== null ? '<style id="typo-custom">' + typo + '</style>\n' : '') + '</head>\n<body><p>正文</p></body></html>\n';
const INLINE = '.x{font-size:15px}';
const cnt = (h) => h.split('<style id="typo-custom">').length - 1;

// ① legacy（meta.typo 未定义）：内联值保留进冻结产物（恰一块、</head> 前、typoHash=内联值 sha1）
const f1 = freezeHtml(doc(INLINE), {});
if (!f1.html.includes('<style id="typo-custom">' + INLINE + '</style>')) fail('① legacy 冻结产物应保留内联 typo');
if (cnt(f1.html) !== 1) fail('① 应恰有一个 typo-custom 块，实际 ' + cnt(f1.html));
if (f1.typoHash !== sha1(INLINE)) fail('① typoHash 应为内联值 sha1');
if (!/<style id="typo-custom">[^<]*<\/style>\s*<\/head>/.test(f1.html)) fail('① typo 块应内联在 </head> 前');
// 冻结标识与「内联值已迁进 meta」的形态等价（迁移前后渲染输入一致 → 不触发假 stale）
if (f1.renderInputId !== freezeHtml(doc(null), { typo: INLINE }).renderInputId) fail('① legacy 冻结标识应等于内联值入 meta 后的标识');

// ② meta.typo=''（定义但空）且内联存在 → 仍回退内联（裁决："undefined or empty" 才回退）
if (!freezeHtml(doc(INLINE), { typo: '' }).html.includes('<style id="typo-custom">' + INLINE + '</style>')) fail('② meta.typo 空串且内联存在应回退内联');

// ③ 已迁移（meta.typo 非空）：meta 必胜、覆盖旧内联值（现行为不变）
const f3 = freezeHtml(doc(INLINE), { typo: '.x{font-size:20px}' });
if (!f3.html.includes('<style id="typo-custom">.x{font-size:20px}</style>')) fail('③ meta.typo 非空应注入 meta 值');
if (f3.html.includes('font-size:15px')) fail('③ 旧内联值应被 meta.typo 覆盖');
if (cnt(f3.html) !== 1) fail('③ 应恰有一个 typo-custom 块');

// ④ 已迁移净文档（无内联）：meta.typo='' → 无块；meta 缺失且无内联 → 无块；两者标识一致
if (cnt(freezeHtml(doc(null), { typo: '' }).html) !== 0) fail('④ meta.typo=空+无内联应无块');
if (cnt(freezeHtml(doc(null), {}).html) !== 0) fail('④ meta 缺 typo+无内联应无块');
if (freezeHtml(doc(null), {}).renderInputId !== freezeHtml(doc(null), { typo: '' }).renderInputId) fail('④ 无内联时 meta.typo 缺失与空串标识应一致');
console.log('✅ S1-HF 热修：effective typo 裁决（legacy 内联保留/空串回退/meta 非空必胜/净文档无块）四组');
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

# —— S1-D：主题唯一源（themes/resume-classic.css）+ template.mjs 装配 + 四条新建路径 meta 登记 ——
# 隔离：mktemp 根 + 隔离端口服务 + 假渲染器 + 假 LLM（本机 HTTP），零接触真实 docs/snapshots/pdfs/JSON/config。
command -v pdftotext >/dev/null || { echo '❌ S1-D 需要 poppler: brew install poppler'; exit 1; }
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const fail = (m) => { console.error('❌ S1-D ' + m); process.exit(1); };
const sha1 = (s) => createHash('sha1').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- S1-D-1 装配契约（单元级） ----------
let assembleTemplate, themeCss, listThemes;
try { ({ assembleTemplate, themeCss, listThemes } = await import('./template.mjs')); }
catch (e) { fail('template.mjs 不存在或不可导入: ' + (e && e.message || e)); }
if (!fs.existsSync('themes/resume-classic.css')) fail('缺 themes/resume-classic.css（主题唯一源）');
const cssFile = fs.readFileSync('themes/resume-classic.css', 'utf8');
if (!cssFile.includes('@page') || !cssFile.includes('.sheet')) fail('themes 文件内容可疑（应含 @page/.sheet 等 classic 规则）');
const asm = assembleTemplate('classic');
if (asm.includes('<!--THEME-CSS-->')) fail('装配输出不应残留 <!--THEME-CSS--> 标记');
if (!asm.includes('<style data-theme="classic">')) fail('装配输出应含 <style data-theme="classic">');
if (!asm.includes(cssFile)) fail('装配输出应逐字包含完整 classic CSS');
const INLINE_RE = /<style data-theme="classic">([\s\S]*?)<\/style>/;
const inline = INLINE_RE.exec(asm);
if (!inline) fail('装配输出中提取不到内联主题块');
if (sha1(inline[1]) !== sha1(cssFile)) fail('sha1(装配内联块) != sha1(themes 文件)');
if (!listThemes().includes('classic')) fail('listThemes 应含 classic，实际 ' + JSON.stringify(listThemes()));
let threw = null;
try { assembleTemplate('no-such-theme'); } catch (e) { threw = e; }
if (!threw) fail('未知主题应抛错');
else if (!threw.message.includes('classic')) fail('未知主题报错应列出可用主题: ' + threw.message);
// template.html 只留标记，不再内联简历 CSS
const tplRaw = fs.readFileSync('template.html', 'utf8');
if (!tplRaw.includes('<!--THEME-CSS-->')) fail('template.html 应保留 <!--THEME-CSS--> 标记');
if (tplRaw.includes('@page')) fail('template.html 的简历 CSS 应已抽出到 themes（不得再内联）');
// 调用点唯一入口静态核对：除 template.mjs 外，任何消费方不得再直读 template.html
for (const f of ['server.mjs', 'structure.mjs', 'importer.mjs', 'migrate-editor.mjs', 'test-editor.mjs', 'test-render.sh']) {
  const src = fs.readFileSync(f, 'utf8');
  if (/readFileSync\([^)]*template\.html/.test(src)) fail(f + ' 仍直读 template.html（应经 assembleTemplate）');
  if (!src.includes('assembleTemplate')) fail(f + ' 未接入 assembleTemplate');
}
// migrate-style.mjs 历史一次性工具：必须大声失败并指向 S1/themes，绝不静默操作 marker-only 模板
let msOut = '', msStatus = 0;
try { execFileSync(process.execPath, ['migrate-style.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
catch (e) { msStatus = e.status; msOut = String(e.stderr || '') + String(e.stdout || ''); }
if (msStatus === 0) fail('migrate-style.mjs 应报错退出（非 0），不得再执行迁移');
if (!/S1/.test(msOut) || !/themes/.test(msOut)) fail('migrate-style.mjs 报错应指向 S1 与 themes 唯一源: ' + msOut.slice(0, 300));
console.log('✅ S1-D-1 assembleTemplate 装配契约（完整 CSS 内联/data-theme/无标记残留/sha1 一致/未知主题抛错/调用点唯一入口/migrate-style 大声失败）');

// ---------- S1-D-2 四条新建路径：/new、importer（降级）、structure（LLM 结构化）、restructure ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1d-'));
// 最小合法 PDF 夹具（程序化计算 xref 偏移；pdftotext 可提取 ASCII 文本）
function makePdf(text) {
  const stream = 'BT /F1 12 Tf 72 720 Td (' + text + ') Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (const off of offsets) pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'latin1');
}
// 假 LLM（OpenAI 兼容 /chat/completions）：返回固定结构化 JSON
const LLM_CONTENT = JSON.stringify({
  name: '结构化员', contact: '电话：12300000000', intent: '测试', summary: 'LLM 结构化摘要。',
  skills: ['技能一：内容一'], work: [{ title: '某公司', role: '工程师', date: '2020-2024', bullets: ['做了一件事'] }],
  projects: [], education: []
});
const llmSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: LLM_CONTENT } }] }));
  });
});
await new Promise((r) => llmSrv.listen(0, '127.0.0.1', r));
const llmBase = 'http://127.0.0.1:' + llmSrv.address().port + '/v1';
const seedRoot = (name) => {
  const r = path.join(tmp, name);
  for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, 'docs-meta.json'), '{}');
  fs.writeFileSync(path.join(r, 'applications.json'), '[]');
  fs.writeFileSync(path.join(r, 'materials.json'), '[]');
  return r;
};
const writeLLMConfig = (r) => fs.writeFileSync(path.join(r, 'config.json'),
  JSON.stringify({ active: 0, profiles: [{ name: 't', baseURL: llmBase, apiKey: 'k123456', model: 'm' }] }));
// 断言：文档内联主题块 sha1 == themes 文件 sha1，且 meta 登记 theme/styleHash/typo/schemaVersion
const checkCreated = (rootDir, id, label, expectTypoEmpty = true) => {
  const p = path.join(rootDir, 'docs', id + '.html');
  if (!fs.existsSync(p)) fail(label + ': 未生成文档 ' + p);
  const html = fs.readFileSync(p, 'utf8');
  const m = INLINE_RE.exec(html);
  if (!m) fail(label + ': 文档缺 <style data-theme="classic"> 内联块');
  if (sha1(m[1]) !== sha1(cssFile)) fail(label + ': 内联块 sha1 ≠ themes 文件 sha1');
  if (html.includes('<!--THEME-CSS-->')) fail(label + ': 文档残留装配标记');
  const meta = JSON.parse(fs.readFileSync(path.join(rootDir, 'docs-meta.json'), 'utf8'))[id];
  if (!meta) fail(label + ': 创建时未登记 meta（docs-meta.json 无该文档）');
  if (meta.theme !== 'classic') fail(label + ': meta.theme 应为 classic: ' + JSON.stringify(meta));
  if (meta.styleHash !== sha1(cssFile)) fail(label + ': meta.styleHash ≠ sha1(themes 文件): ' + JSON.stringify(meta));
  if (meta.schemaVersion !== 1) fail(label + ': meta.schemaVersion 应为 1: ' + JSON.stringify(meta));
  if (expectTypoEmpty && meta.typo !== '') fail(label + ': meta.typo 应为空串: ' + JSON.stringify(meta));
  return meta;
};
const { importPdfText } = await import('./importer.mjs');
const pdfFile = path.join(tmp, 's1d-fixture.pdf');
fs.writeFileSync(pdfFile, makePdf('S1D IMPORT FIXTURE BODY LINE'));
if (!execFileSync('pdftotext', ['-layout', pdfFile, '-'], { encoding: 'utf8' }).includes('S1D IMPORT FIXTURE')) {
  fail('PDF 夹具不可提取文本（pdftotext 输出为空）');
}
try {
  // ② importer 降级路径（无 LLM 配置 → 原文导入文档）
  const rootImp = seedRoot('root-imp');
  const idImp = await importPdfText(rootImp, pdfFile, 's1d-imp.pdf');
  if (idImp !== 's1d-imp') fail('importer 应返回 slug id，实际 ' + idImp);
  const htmlImp = fs.readFileSync(path.join(rootImp, 'docs', idImp + '.html'), 'utf8');
  if (!htmlImp.includes('以下为 PDF 提取的原文')) fail('importer 降级文档应含原文导入标记');
  checkCreated(rootImp, idImp, 'importer(降级)');

  // ③ structure 路径（LLM 结构化 → buildDoc 建档）
  const rootStr = seedRoot('root-str');
  writeLLMConfig(rootStr);
  const idStr = await importPdfText(rootStr, pdfFile, 's1d-str.pdf');
  const htmlStr = fs.readFileSync(path.join(rootStr, 'docs', idStr + '.html'), 'utf8');
  if (!htmlStr.includes('结构化员') || htmlStr.includes('以下为 PDF 提取的原文')) fail('structure 路径应产出 LLM 结构化文档而非降级文档');
  checkCreated(rootStr, idStr, 'structure(LLM)');

  // ①④ 服务级：/new 与 /restructure（隔离根 + 假渲染器 + 假 LLM）
  const rootSrv = seedRoot('root-srv');
  writeLLMConfig(rootSrv);
  const fr = path.join(tmp, 'fake-render.sh');
  fs.writeFileSync(fr, '#!/bin/bash\nshift\nif [ "$1" = "--src" ]; then src="$2"; out="$4"; else src="$RESUME_ROOT/docs/$1.html"; out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\nprintf "%%PDF-1.4 fake\\n" > "$out"\n');
  fs.chmodSync(fr, 0o755);
  // 降级夹具文档（/restructure 入口条件：含"以下为 PDF 提取的原文"）
  const deg = assembleTemplate('classic')
    .replaceAll('{{NAME}}', () => '降级员').replaceAll('{{CONTACT}}', () => '').replaceAll('{{INTENT}}', () => '')
    .replaceAll('{{SUMMARY}}', () => '以下为 PDF 提取的原文（待整理）：').replaceAll('{{SKILLS}}', () => '')
    .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => '<div class="plain-lines"><p style="white-space:pre-wrap">原始文本行</p></div>')
    .replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => 'deg');
  fs.writeFileSync(path.join(rootSrv, 'docs', 'deg.html'), deg);
  const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const port = await freePort();
  const srv = (await import('node:child_process')).spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, RESUME_ROOT: rootSrv, PORT: String(port), RESUME_RENDER_BIN: fr },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serr = ''; srv.stderr.on('data', (d) => { serr += d; });
  const B = 'http://127.0.0.1:' + port;
  try {
    let up = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) { if (srv.exitCode !== null) break; try { await fetch(B + '/'); up = true; break; } catch {} await sleep(80); }
    if (!up) fail('S1-D 测试服务启动失败: ' + serr.slice(0, 500));
    // ① /new
    const rNew = await fetch(B + '/new', { method: 'POST', redirect: 'manual' });
    if (![302, 303].includes(rNew.status)) fail('/new 应 3xx 跳转编辑器，实际 ' + rNew.status);
    const loc = rNew.headers.get('location') || '';
    const newId = new URLSearchParams(loc.split('?')[1] || '').get('id');
    if (!newId) fail('/new 未返回文档 id: ' + loc);
    checkCreated(rootSrv, newId, '/new');
    // ④ /restructure（既有降级文档整体再生：先快照，再登记 classic 主题 meta）
    const rRe = await fetch(B + '/restructure?id=deg', { method: 'POST', redirect: 'manual' });
    if (![302, 303].includes(rRe.status)) fail('/restructure 应 3xx，实际 ' + rRe.status + '（' + (await rRe.text().catch(() => '')).slice(0, 200) + '）');
    const htmlRe = fs.readFileSync(path.join(rootSrv, 'docs', 'deg.html'), 'utf8');
    if (htmlRe.includes('以下为 PDF 提取的原文')) fail('/restructure 后不应再是降级文档');
    if (!htmlRe.includes('结构化员')) fail('/restructure 应写入 LLM 结构化结果');
    checkCreated(rootSrv, 'deg', '/restructure');
    if (!fs.existsSync(path.join(rootSrv, 'snapshots', 'deg'))) fail('/restructure 前应留快照');
  } finally {
    srv.kill('SIGKILL');
    await sleep(50);
  }
  console.log('✅ S1-D-2 四条新建路径（/new、importer 降级、structure LLM、/restructure）：内联 sha1 == themes sha1 且 meta 登记 theme/styleHash/typo/schemaVersion');
} finally {
  llmSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
EOF

# —— S1-G：RGB24 视觉门禁 tools/pixel-diff.mjs（同 PDF=0/改字号失败/仅改颜色>0 证明 RGB 非灰度/页数不等失败/缺检查器 exit 3 不降级）——
# 隔离：mktemp 根 + 真实渲染管线（assembleTemplate + render.mjs）造 PDF 夹具，零接触真实 docs/snapshots/pdfs/JSON/config。
command -v ffmpeg >/dev/null || { echo '❌ S1-G 需要 ffmpeg: brew install ffmpeg'; exit 1; }
command -v pdftoppm >/dev/null || { echo '❌ S1-G 需要 poppler(pdftoppm): brew install poppler'; exit 1; }
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const fail = (m) => { console.error('❌ S1-G ' + m); process.exit(1); };
// 门禁本体：编程 API（Task 7/9 进程内调用）+ CheckerMissingError（exit 3 语义的进程内形态）
let comparePdfs, CheckerMissingError;
try { ({ comparePdfs, CheckerMissingError } = await import('./tools/pixel-diff.mjs')); }
catch (e) { fail('tools/pixel-diff.mjs 不存在或不可导入: ' + (e && e.message || e)); }
if (typeof comparePdfs !== 'function') fail('pixel-diff.mjs 应导出 comparePdfs(a, b, opts)');
if (typeof CheckerMissingError !== 'function') fail('pixel-diff.mjs 应导出 CheckerMissingError（Task 7 需按 code=CHECKER_MISSING 判 STOP）');
import { assembleTemplate } from './template.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1g-'));
const CLI = path.join(process.cwd(), 'tools', 'pixel-diff.mjs');
const RENDER = path.join(process.cwd(), 'render.mjs');
const RDATA = path.join(tmp, 'data');
fs.mkdirSync(path.join(RDATA, 'pdfs'), { recursive: true });

// ---------- 夹具：真实渲染管线（assembleTemplate 填占位符 → render.mjs），不手搓 PDF ----------
const mkHtml = (extraStyle, workHtml) => assembleTemplate('classic')
  .replace('</head>', () => (extraStyle ? `<style>${extraStyle}</style></head>` : '</head>'))
  .replaceAll('{{NAME}}', () => '门禁测试员')
  .replaceAll('{{CONTACT}}', () => '电话：12345678901 ｜ 邮箱：gate@example.com')
  .replaceAll('{{INTENT}}', () => '意向岗位：后端工程师')
  .replaceAll('{{SUMMARY}}', () => '五年后端研发经验，主导高并发订单系统与数据链路建设。')
  .replaceAll('{{SKILLS}}', () => '<p>Node.js / MySQL / Redis / 消息队列</p><p>分布式系统设计与性能调优</p>')
  .replaceAll('{{WORK}}', () => workHtml || '<div class="entry"><div class="entry-title">某科技公司</div><div class="entry-role">后端工程师</div><div class="entry-date">2021-2026</div><p>负责订单核心服务，主导拆单重构与容量治理，可用性达 99.99%。</p></div>')
  .replaceAll('{{PROJECTS}}', () => '<div class="entry"><div class="entry-title">订单系统重构</div><p>单体拆分与链路治理，峰值吞吐提升一倍。</p></div>')
  .replaceAll('{{EDU}}', () => '<div class="entry"><div class="entry-title">某大学</div><div class="entry-role">本科｜计算机科学与技术</div><div class="entry-date">2016-2020</div></div>')
  .replaceAll('{{DOC_ID}}', () => 's1g');
const renderPdf = (name, html) => {
  const src = path.join(tmp, name + '.html');
  const out = path.join(RDATA, 'pdfs', name + '.pdf');
  fs.writeFileSync(src, html);
  const r = spawnSync(process.execPath, [RENDER, '--src', src, '--out', out], {
    env: { ...process.env, RESUME_ROOT: RDATA }, encoding: 'utf8', timeout: 180000
  });
  if (r.status !== 0) fail('render.mjs 生成夹具 ' + name + ' 失败（exit ' + r.status + '）: ' + String(r.stderr || r.stdout || '').slice(0, 400));
  if (!fs.existsSync(out)) fail('夹具 PDF 未生成: ' + out);
  return out;
};
// 等亮度色差对（BT.601: 0.299×255≈76=0x4C）：#4c4c4c 与 #ff0000 在灰度管线下逐字节相同，
// 只有 RGB24 管线能登记差异 —— 这是「证明 RGB 而非灰度」的判别夹具。
const GRAY_STYLE = '.sheet,.sheet *{color:#4c4c4c !important}';
const RED_STYLE = '.sheet,.sheet *{color:#ff0000 !important}';
const BIG_STYLE = '.sheet,.sheet *{font-size:22px !important}';  // 实测 26px+行高会溢出到第 2 页，22px 保持单页且 ratio≫0.005
const LONG_WORK = Array.from({ length: 70 }, (_, i) => `<p>工作经历第 ${i + 1} 行：负责模块研发与稳定性值班，参与容量评估与压测。</p>`).join('\n');
const pdfBase = renderPdf('base', mkHtml('', ''));
const pdfBig = renderPdf('big', mkHtml(BIG_STYLE, ''));
const pdfGray = renderPdf('gray', mkHtml(GRAY_STYLE, ''));
const pdfRed = renderPdf('red', mkHtml(RED_STYLE, ''));
const pdfTwo = renderPdf('two', mkHtml('', LONG_WORK));

try {
  // ---------- (a) 同 PDF 自比：每页 ratio 0、max 0、pass ----------
  const ra = comparePdfs(pdfBase, pdfBase);
  if (!ra || !Array.isArray(ra.pages) || ra.pages.length !== 1) fail('自比应返回 1 页结果: ' + JSON.stringify(ra && ra.pages));
  if (ra.pages[0].ratio !== 0 || ra.max !== 0) fail('自比 ratio 应为 0: ' + JSON.stringify(ra.pages[0]));
  if (ra.pass !== true) fail('自比应 pass: ' + JSON.stringify(ra));
  // CLI 同 PDF → exit 0 + 每页比例 + 总判定
  const ca = spawnSync(process.execPath, [CLI, pdfBase, pdfBase], { encoding: 'utf8', timeout: 120000 });
  if (ca.status !== 0) fail('CLI 自比应 exit 0，实际 ' + ca.status + ': ' + String(ca.stderr || '').slice(0, 300));
  if (!/第 ?1 ?页|page 1/i.test(ca.stdout) || !/ratio/.test(ca.stdout)) fail('CLI 输出应含每页比例: ' + ca.stdout.slice(0, 300));
  if (!/PASS/.test(ca.stdout)) fail('CLI 输出应含总判定 PASS: ' + ca.stdout.slice(0, 300));
  console.log('✅ S1-G-a 同 PDF 自比 ratio=0 pass（API + CLI exit 0）');

  // ---------- (b) 字号改变（布局变）→ ratio > 0.005，fail，CLI exit 1 ----------
  const rb = comparePdfs(pdfBase, pdfBig);
  if (rb.pass !== false) fail('改字号应 fail: ' + JSON.stringify(rb));
  if (!(rb.max > 0.005)) fail('改字号 max ratio 应 > 0.005，实际 ' + rb.max);
  const cb = spawnSync(process.execPath, [CLI, pdfBase, pdfBig], { encoding: 'utf8', timeout: 120000 });
  if (cb.status !== 1) fail('CLI 改字号应 exit 1，实际 ' + cb.status);
  if (!/FAIL/.test(cb.stdout)) fail('CLI 改字号应输出 FAIL: ' + cb.stdout.slice(0, 300));
  console.log('✅ S1-G-b 改字号 max=' + rb.max.toFixed(4) + ' > 0.005 → fail（API + CLI exit 1）');

  // ---------- (c) 仅改颜色（同布局、等亮度色差对）→ ratio > 0，fail（证明 RGB24 而非灰度）----------
  const rc = comparePdfs(pdfGray, pdfRed);
  if (!(rc.max > 0)) fail('等亮度色差（#4c4c4c vs #ff0000）ratio 应 > 0（灰度管线会漏报，RGB24 必须登记）: ' + JSON.stringify(rc));
  if (rc.pass !== false) fail('仅改颜色应 fail: ' + JSON.stringify(rc));
  if (!(rc.max > 0.005)) fail('仅改颜色 max ratio 应 > 0.005（全文本变色），实际 ' + rc.max);
  // CLI --threshold 旗标解析：放宽阈值到 0.9 → 同一对 PDF 应 pass（exit 0）
  const cc = spawnSync(process.execPath, [CLI, pdfGray, pdfRed, '--threshold', '0.9'], { encoding: 'utf8', timeout: 120000 });
  if (cc.status !== 0) fail('CLI --threshold 0.9 应 exit 0，实际 ' + cc.status + ': ' + String(cc.stdout || cc.stderr || '').slice(0, 300));
  console.log('✅ S1-G-c 仅改颜色（等亮度 #4c4c4c↔#ff0000）max=' + rc.max.toFixed(4) + ' > 0 → RGB24 判别成立；--threshold 旗标生效');

  // ---------- (d) 页数不等 → 直接 fail（error 指明页数），CLI exit 1 ----------
  const rd = comparePdfs(pdfBase, pdfTwo);
  if (rd.pass !== false) fail('页数不等应 fail: ' + JSON.stringify(rd));
  if (!/页数不等/.test(String(rd.error || ''))) fail('页数不等应给出 error 说明: ' + JSON.stringify(rd));
  if (!Array.isArray(rd.pages) || rd.pages.length !== 0) fail('页数不等时不应产出逐页比例: ' + JSON.stringify(rd.pages));
  const cd = spawnSync(process.execPath, [CLI, pdfBase, pdfTwo], { encoding: 'utf8', timeout: 120000 });
  if (cd.status !== 1) fail('CLI 页数不等应 exit 1，实际 ' + cd.status);
  console.log('✅ S1-G-d 页数不等（1 vs 2）直接 fail（API + CLI exit 1）');

  // ---------- (e) 检查器缺失（PATH 遮蔽）→ CLI exit 3 + 可操作修复指引，绝不降级 ----------
  const whichOf = (tool) => spawnSync('/bin/bash', ['-c', 'command -v ' + tool], { encoding: 'utf8' }).stdout.trim();
  const binNoFfmpeg = path.join(tmp, 'bin-no-ffmpeg'); fs.mkdirSync(binNoFfmpeg);
  fs.symlinkSync(process.execPath, path.join(binNoFfmpeg, 'node'));
  fs.symlinkSync(whichOf('pdftoppm'), path.join(binNoFfmpeg, 'pdftoppm'));
  const ce = spawnSync(process.execPath, [CLI, pdfBase, pdfBase], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: binNoFfmpeg + ':/usr/bin:/bin' } });
  if (ce.status !== 3) fail('ffmpeg 遮蔽应 exit 3（停止不降级），实际 ' + ce.status + ': ' + String(ce.stdout || ce.stderr || '').slice(0, 300));
  const ceOut = String(ce.stderr || '') + String(ce.stdout || '');
  if (!/ffmpeg/.test(ceOut) || !/brew install ffmpeg/.test(ceOut)) fail('exit 3 应给出可操作修复指引（brew install ffmpeg）: ' + ceOut.slice(0, 300));
  const binNoPoppler = path.join(tmp, 'bin-no-pdftoppm'); fs.mkdirSync(binNoPoppler);
  fs.symlinkSync(process.execPath, path.join(binNoPoppler, 'node'));
  const cp = spawnSync(process.execPath, [CLI, pdfBase, pdfBase], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: binNoPoppler + ':/usr/bin:/bin' } });
  if (cp.status !== 3) fail('pdftoppm 遮蔽应 exit 3，实际 ' + cp.status);
  const cpOut = String(cp.stderr || '') + String(cp.stdout || '');
  if (!/pdftoppm/.test(cpOut) || !/brew install poppler/.test(cpOut)) fail('pdftoppm 缺失应指引 brew install poppler: ' + cpOut.slice(0, 300));
  console.log('✅ S1-G-e 检查器缺失（ffmpeg/pdftoppm PATH 遮蔽）→ exit 3 + 修复指引，不降级');

  // ---------- (f) 抖动基线（S1-T9）：同一冻结输入 N=3 次真实渲染 → 两两逐页像素 ratio == 0 ----------
  // 固定环境视觉基线（Task 4 验收「重渲不要求 PDF md5 相同」所引用的口径）：PDF 字节含元数据/时间戳可不同，
  // 但 pdftoppm 栅格化确定性 → 像素比较必须全 0。若未来实测非零：必须 <<0.005 并记录进任务报告后再议放宽。
  const sameHtml = mkHtml('', '');
  const pdfJ1 = renderPdf('jit1', sameHtml);
  const pdfJ2 = renderPdf('jit2', sameHtml);
  const pdfJ3 = renderPdf('jit3', sameHtml);
  let jitterMax = 0;
  for (const [x, y] of [[pdfJ1, pdfJ2], [pdfJ1, pdfJ3], [pdfJ2, pdfJ3]]) {
    const v = comparePdfs(x, y);
    if (!v || v.pass !== true) fail('抖动基线应 pass: ' + JSON.stringify(v));
    if (v.max > jitterMax) jitterMax = v.max;
  }
  if (jitterMax !== 0) fail('抖动基线：同一输入 3 次渲染两两像素 ratio 应恰为 0，实测 max=' + jitterMax + '（非零须报告并评审）');
  console.log('✅ S1-G-f 抖动基线：同一冻结输入 3 次真实渲染，两两像素 ratio max=' + jitterMax + '（==0，栅格化确定性成立）');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
EOF

# —— S1-E：schemaVersion 迁移事务（三门禁硬闸；单元路径=隔离根+模拟检查器注入）——
# 隔离：全程 mktemp 根，零接触真实 docs/snapshots/pdfs/JSON/config。opts.checkers 注入模拟检查器；
# 真实门禁端到端见 S1-E-2（不注入）。附带覆盖两条 T7 承载缺陷：启动恢复快照兜底 legacy-safe、rootLock self-pid 陈旧残锁。
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sha1, splitDoc, freezeHtml } from './freeze.mjs';
import { beginTx, updateMeta, rootLock, recoverPending, atomicWrite } from './tx.mjs';
import { CheckerMissingError } from './tools/pixel-diff.mjs';
const fail = (m) => { console.error('❌ S1-E ' + m); process.exit(1); };
const md5File = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');
let runMigration;
try { ({ runMigration } = await import('./migrate-meta.mjs')); }
catch (e) { fail('migrate-meta.mjs 不存在或不可导入: ' + (e && e.message || e)); }
if (typeof runMigration !== 'function') fail('migrate-meta.mjs 应导出 runMigration(root, opts)');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1e-'));
const CSS = '\n.sheet{color:#111}\n';
const LEG_TYPO = '/*LEG*/.sheet p{line-height:1.62}';
const legDoc = (body, typo) => '<!doctype html>\n<html><head>\n<meta charset="utf-8">\n<style>' + CSS + '</style>\n'
  + (typo !== null ? '<style id="typo-custom">' + typo + '</style>\n' : '') + '</head>\n<body>\n<div class="sheet"><p>' + body + '</p></div>\n</body></html>\n';
const seedRoot = (name, docs, meta) => {
  const r = path.join(tmp, name);
  for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, 'docs-meta.json'), JSON.stringify(meta || {}));
  fs.writeFileSync(path.join(r, 'applications.json'), '[]');
  fs.writeFileSync(path.join(r, 'materials.json'), '[]');
  for (const [id, html] of Object.entries(docs)) fs.writeFileSync(path.join(r, 'docs', id + '.html'), html);
  return r;
};
const readMeta = (r) => JSON.parse(fs.readFileSync(path.join(r, 'docs-meta.json'), 'utf8'));
const readDoc = (r, id) => fs.readFileSync(path.join(r, 'docs', id + '.html'), 'utf8');
const txMarkers = (r) => fs.existsSync(path.join(r, '.tx')) ? fs.readdirSync(path.join(r, '.tx')).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json')) : [];
const txDocIds = (r) => txMarkers(r).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(r, '.tx', f), 'utf8')).docId; } catch { return null; } }).filter(Boolean);
const mockCheckers = (over) => ({
  renderPdf: async (src, out) => { fs.writeFileSync(out, '%PDF-1.4 mock\n'); return true; },
  pdftotext: () => 'MOCK-TEXT-LAYER',
  pdfinfoPages: () => 1,
  comparePdfs: () => ({ pass: true, max: 0, pages: [{ page: 1, ratio: 0, diffBytes: 0, totalBytes: 8 }], dpi: 150, threshold: 0.005, pixFmt: 'rgb24' }),
  ...(over || {})
});
const backupsOf = (r) => fs.existsSync(path.join(r, 'backups')) ? fs.readdirSync(path.join(r, 'backups')).filter((d) => d.startsWith('pre-s1-')).sort() : [];
try {
  // ---------- ① 首迁成功：legacy 提取+登记+done；classic（T5 新建）no-op 提取+门禁；备份副本；预检计数 ----------
  const clsDoc = '<!doctype html>\n<html><head>\n<meta charset="utf-8">\n<style data-theme="classic">' + CSS + '</style>\n</head>\n<body>\n<div class="sheet"><p>CLS</p></div>\n</body></html>\n';
  const R1 = seedRoot('r1', { leg: legDoc('LEG-BODY', LEG_TYPO), cls: clsDoc }, { cls: { theme: 'classic', styleHash: sha1(CSS), typo: '', schemaVersion: 1, rev: 1 } });
  // 历史快照（typo 预检夹具）：一份含内联 typo、一份不含（其文档 meta.typo 未定义 = legacy）
  fs.mkdirSync(path.join(R1, 'snapshots', 'leg'), { recursive: true });
  fs.writeFileSync(path.join(R1, 'snapshots', 'leg', '2026-09-01-000000-000.html'), legDoc('OLD', LEG_TYPO));
  fs.writeFileSync(path.join(R1, 'snapshots', 'leg', '2026-09-02-000000-000.html'), legDoc('OLD2', null));
  const legHtml0 = readDoc(R1, 'leg'), clsHtml0 = readDoc(R1, 'cls');
  const legRid0 = freezeHtml(legHtml0, {}).renderInputId;   // legacy 冻结标识（有效 typo=内联）
  const rep1 = await runMigration(R1, { checkers: mockCheckers() });
  if (!rep1.ok || rep1.stopped) fail('① 首迁应成功: ' + JSON.stringify(rep1.stopped));
  const m1 = readMeta(R1);
  const leg1 = m1.leg || {}, cls1 = m1.cls || {};
  if (leg1.schemaVersion !== 2) fail('① leg schemaVersion 应为 2: ' + JSON.stringify(leg1));
  if (!leg1.migration || leg1.migration.state !== 'done' || !leg1.migration.at || !leg1.migration.checks) fail('① leg migration 应登记 done/at/checks: ' + JSON.stringify(leg1.migration));
  if (/<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(readDoc(R1, 'leg'))) fail('① 迁移后 html 不应含 typo-custom 元素');
  if (!readDoc(R1, 'leg').includes('LEG-BODY')) fail('① 正文不得改动');
  if (leg1.typo !== LEG_TYPO) fail('① meta.typo 应=原内联值: ' + JSON.stringify(leg1.typo));
  if (!readDoc(R1, 'leg').includes('data-style-origin="legacy-inline"')) fail('① 主 <style> 应补 data-style-origin="legacy-inline"');
  if (leg1.theme !== 'legacy') fail('① theme 应登记 legacy: ' + JSON.stringify(leg1.theme));
  if (leg1.styleHash !== sha1(CSS)) fail('① styleHash 应=sha1(实际内联 css): ' + JSON.stringify(leg1.styleHash));
  if (!/^[0-9a-f]{40}$/.test(String(leg1.renderInputId))) fail('① renderInputId 初值应为完整 40hex: ' + JSON.stringify(leg1.renderInputId));
  if (freezeHtml(readDoc(R1, 'leg'), leg1).renderInputId !== legRid0) fail('① 迁移后冻结标识应与迁移前一致（不产生假 stale）');
  // classic（T5 新建形态）：不重登记样式、html 零改写、只 schemaVersion+门禁
  if (readDoc(R1, 'cls') !== clsHtml0) fail('① classic 文档 html 应零改写');
  if (cls1.schemaVersion !== 2 || !cls1.migration || cls1.migration.state !== 'done') fail('① classic 也应完成（schemaVersion=2/done）: ' + JSON.stringify(cls1));
  if (cls1.theme !== 'classic' || cls1.styleHash !== sha1(CSS) || cls1.typo !== '' || cls1.rev !== 1) fail('① classic 样式登记不得被覆盖: ' + JSON.stringify(cls1));
  // M-7（Task 7 review → S1-T9）：迁移绝不写 meta.lastRenderInputId —— 渲染任务身份只由真实渲染（renderCurrent）写，
  // 迁移写入会造成"未渲染却 fresh"的假同步（迁移登记的是溯源用 renderInputId 初值，键名不同）。
  if ('lastRenderInputId' in leg1 || 'lastRenderInputId' in cls1) fail('① 迁移绝不写 meta.lastRenderInputId（假 fresh 防线）: leg=' + JSON.stringify(leg1.lastRenderInputId) + ' cls=' + JSON.stringify(cls1.lastRenderInputId));
  // 备份副本 backups/pre-s1-<ts>/（docs/snapshots/pdfs/三 JSON）+ 迁移冻结快照（先快照，含内联 typo）
  const b1 = backupsOf(R1);
  if (b1.length !== 1) fail('① 应创建 backups/pre-s1-<ts>/ 全量副本: ' + JSON.stringify(b1));
  const bDir = path.join(R1, 'backups', b1[0]);
  for (const f of ['docs/leg.html', 'docs/cls.html', 'docs-meta.json', 'applications.json', 'materials.json', 'snapshots/leg/2026-09-01-000000-000.html']) {
    if (!fs.existsSync(path.join(bDir, f))) fail('① 备份副本缺 ' + f);
  }
  const migSnaps = fs.existsSync(path.join(bDir, 'migration-snapshots')) ? fs.readdirSync(path.join(bDir, 'migration-snapshots')) : [];
  const legSnap = migSnaps.find((f) => f.startsWith('leg-') && f.endsWith('.html'));
  if (!legSnap) fail('① 迁移应先快照（冻结 pre-image 落 backups/<pre-s1>/migration-snapshots/）: ' + JSON.stringify(migSnaps));
  if (!fs.readFileSync(path.join(bDir, 'migration-snapshots', legSnap), 'utf8').includes('<style id="typo-custom">' + LEG_TYPO + '</style>')) fail('① 迁移快照（冻结产物）应含内联 typo');
  if (!migSnaps.some((f) => f.endsWith('.manifest.json'))) fail('① 迁移快照应伴生 manifest');
  if (txMarkers(R1).length) fail('① 成功后 .tx 应清空');
  if (rootLock.isHeld(R1)) fail('① 运行结束后 rootLock 应已释放');
  // 快照 typo 预检（只读报告，绝不改写快照）：含内联 1 份；legacy 文档缺内联 1 份
  const au = rep1.snapshotAudit;
  if (!au || au.total !== 2 || au.withInlineTypo.length !== 1 || au.legacyWithoutTypo.length !== 1) fail('① 快照 typo 预检计数不符: ' + JSON.stringify(au));
  console.log('✅ S1-E-① 首迁成功（legacy 提取+登记/classic no-op/备份副本/迁移快照/预检计数/锁释放）');

  // ---------- ② 半完成 tx → 重跑先恢复再迁（必须回到精确旧状态重做，而非从半成品续迁） ----------
  const INT_TYPO = '/*INT*/.sheet p{line-height:1.7}';
  const R2 = seedRoot('r2', { int: legDoc('INT-BODY', INT_TYPO) }, {});
  beginTx(R2, 'int', 'migrate', '');                                   // 中断前 tx（旧正文+旧 meta=null 已捕获）
  atomicWrite(path.join(R2, 'docs', 'int.html'), splitDoc(readDoc(R2, 'int')).html);   // 半成品：html 已归一化
  updateMeta(R2, 'int', () => ({ typo: '', theme: 'legacy' }));                        // 半成品：meta typo 错误（''）
  const rep2 = await runMigration(R2, { checkers: mockCheckers() });
  const m2 = readMeta(R2).int || {};
  if (!rep2.recovered || !rep2.recovered.some((r) => r.docId === 'int' && r.ok)) fail('② 应先恢复半完成 tx: ' + JSON.stringify(rep2.recovered));
  if (!rep2.ok) fail('② 恢复后迁移应成功: ' + JSON.stringify(rep2.stopped));
  if (m2.typo !== INT_TYPO) fail('② 必须以恢复后的旧状态重做（typo=原内联值，而非半成品空串）: ' + JSON.stringify(m2.typo));
  if (m2.schemaVersion !== 2 || (m2.migration || {}).state !== 'done') fail('② 恢复重做后应 done: ' + JSON.stringify(m2));
  if (!readDoc(R2, 'int').includes('INT-BODY') || /<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(readDoc(R2, 'int'))) fail('② 重做后正文完整且无内联 typo');
  if (txMarkers(R2).length) fail('② .tx 应清空');
  console.log('✅ S1-E-② 半完成 tx → 先恢复再迁（typo=原内联值，done 登记完整）');

  // ---------- ③ 无 tx 且 schemaVersion=1 → 直接迁、快照数不增（历史快照不可变、不触发恢复） ----------
  const R3 = seedRoot('r3', { leg3: legDoc('L3', LEG_TYPO) }, {});
  fs.mkdirSync(path.join(R3, 'snapshots', 'leg3'), { recursive: true });
  const hist = ['2026-08-01-000000-000.html', '2026-08-02-000000-000.html'];
  for (const h of hist) fs.writeFileSync(path.join(R3, 'snapshots', 'leg3', h), legDoc('HIST-' + h, null));
  const md5Before = hist.map((h) => md5File(path.join(R3, 'snapshots', 'leg3', h)));
  if (txMarkers(R3).length) fail('③ 前置：应无 tx 记录');
  const rep3 = await runMigration(R3, { checkers: mockCheckers() });
  const sDir3 = path.join(R3, 'snapshots', 'leg3');
  const afterFiles = fs.readdirSync(sDir3).filter((f) => f.endsWith('.html')).sort();
  if (!rep3.ok) fail('③ 迁移应成功: ' + JSON.stringify(rep3.stopped));
  if (afterFiles.length !== hist.length) fail('③ 首迁快照数不应增长（迁移快照归 backups/，不进 snapshots/ 配额目录）: ' + afterFiles.length);
  hist.forEach((h, i) => { if (md5File(path.join(sDir3, h)) !== md5Before[i]) fail('③ 历史快照不可变（md5 一致）: ' + h); });
  if ((readMeta(R3).leg3 || {}).schemaVersion !== 2) fail('③ 应直接迁到 schemaVersion=2');
  if (rep3.recovered.length) fail('③ 无 tx 首迁不应触发恢复: ' + JSON.stringify(rep3.recovered));
  console.log('✅ S1-E-③ 无 tx 首迁：直接迁、snapshots/ 数不增、历史快照 md5 不变、不触发恢复');

  // ---------- ④ 任一检查失败 → 不写 done、文档完整恢复、STOP 整轮（其他文档 untouched） ----------
  const R4 = seedRoot('r4', { ga: legDoc('GA', '/*GA*/p{color:#222}'), gb: legDoc('GB', null) }, {});
  const ga0 = readDoc(R4, 'ga'), gb0 = readDoc(R4, 'gb'), meta0Raw = fs.readFileSync(path.join(R4, 'docs-meta.json'), 'utf8');
  const rep4 = await runMigration(R4, { checkers: mockCheckers({ comparePdfs: () => ({ pass: false, max: 0.42, threshold: 0.005, pages: [{ page: 1, ratio: 0.42, diffBytes: 42, totalBytes: 100 }], dpi: 150, pixFmt: 'rgb24' }) }) });
  if (rep4.ok || !rep4.stopped || rep4.stopped.docId !== 'ga') fail('④ 视觉门禁失败应 STOP 整轮: ' + JSON.stringify(rep4.stopped));
  if (rep4.stopped.code !== 'GATE_FAILED') fail('④ stopped.code 应 GATE_FAILED: ' + rep4.stopped.code);
  if (rep4.stopped.restored !== true) fail('④ stopped 应报告已完整恢复');
  if (readDoc(R4, 'ga') !== ga0) fail('④ 失败后 ga html 应完整恢复（旧字节）');
  if (fs.readFileSync(path.join(R4, 'docs-meta.json'), 'utf8') !== meta0Raw) fail('④ 失败后 docs-meta 应完整恢复（无 schemaVersion/migration/登记字段）');
  if (readDoc(R4, 'gb') !== gb0 || readMeta(R4).gb) fail('④ STOP 后其他文档 gb 应 untouched');
  if (txMarkers(R4).length) fail('④ html+meta 双恢复成功 → commitTx（tx.mjs 语义），.tx 应干净');
  // 页数不等形态：max=null + error —— 消费规则必须先判 error/pass（若先判 max：null<=0.005 为 true 会误放行）
  const R4b = seedRoot('r4b', { pc: legDoc('PC', null) }, {});
  const pc0 = readDoc(R4b, 'pc');
  const rep4b = await runMigration(R4b, { checkers: mockCheckers({ comparePdfs: () => ({ pass: false, pages: [], max: null, dpi: 150, threshold: 0.005, pixFmt: 'rgb24', error: '页数不等: a=1 页, b=2 页（视觉门禁要求页数相同）' }) }) });
  if (rep4b.ok || !rep4b.stopped) fail('④ 页数不等（max=null+error）必须判失败（先查 error/pass 再查 max）');
  if (readDoc(R4b, 'pc') !== pc0 || readMeta(R4b).pc) fail('④ 页数不等失败后应完整恢复');
  // 文本层差异非零形态
  const R4c = seedRoot('r4c', { tc: legDoc('TC', null) }, {});
  let nText = 0;
  const rep4c = await runMigration(R4c, { checkers: mockCheckers({ pdftotext: () => ('TEXT-' + (++nText)) }) });
  if (rep4c.ok || !rep4c.stopped || !/文本层/.test(rep4c.stopped.message || '')) fail('④ 文本层差异非零应 STOP: ' + JSON.stringify(rep4c.stopped));
  if (readDoc(R4c, 'tc') !== legDoc('TC', null) || readMeta(R4c).tc) fail('④ 文本层失败后应完整恢复');
  console.log('✅ S1-E-④ 门禁失败（视觉/页数不等 max=null/文本层）→ 不写 done、完整恢复、STOP 整轮');

  // ---------- ④b 检查器缺失（CheckerMissingError）→ 恢复+STOP；CLI PATH 遮蔽 → 预检 exit 3（备份前零接触） ----------
  const R5 = seedRoot('r5', { cm: legDoc('CM', '/*CM*/p{margin:0}') }, {});
  const cm0 = readDoc(R5, 'cm'), cmMeta0 = fs.readFileSync(path.join(R5, 'docs-meta.json'), 'utf8');
  const rep5 = await runMigration(R5, { checkers: mockCheckers({ comparePdfs: () => { throw new CheckerMissingError('ffmpeg'); } }) });
  if (rep5.ok || !rep5.stopped || rep5.stopped.code !== 'CHECKER_MISSING') fail('④b 检查器缺失应以 CHECKER_MISSING STOP: ' + JSON.stringify(rep5.stopped));
  if (readDoc(R5, 'cm') !== cm0 || fs.readFileSync(path.join(R5, 'docs-meta.json'), 'utf8') !== cmMeta0) fail('④b 检查器缺失后应完整恢复（不写 done）');
  const R5b = seedRoot('r5b', { cm2: legDoc('CM2', null) }, {});
  const binShadow = path.join(tmp, 'bin-shadow'); fs.mkdirSync(binShadow, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(binShadow, 'node'));
  const cli = spawnSync(process.execPath, ['migrate-meta.mjs'], { cwd: process.cwd(), encoding: 'utf8', timeout: 60000, env: { ...process.env, RESUME_ROOT: R5b, PATH: binShadow + ':/usr/bin:/bin' } });
  if (cli.status !== 3) fail('④b 检查器缺失 CLI 应 exit 3，实际 ' + cli.status + ': ' + String(cli.stdout || cli.stderr || '').slice(0, 300));
  if (backupsOf(R5b).length) fail('④b 预检失败应发生在备份之前（不产生 pre-s1 副本）');
  if (readDoc(R5b, 'cm2') !== legDoc('CM2', null)) fail('④b 预检失败不得改动任何文件');
  console.log('✅ S1-E-④b 检查器缺失 → 进程内恢复+STOP；CLI 预检 exit 3（备份前零接触）');

  // ---------- ⑤ 迁移持 rootLock：同进程对另一文档 B 的 updateMeta 与 A 事务不互踩（两文档字段都落盘） ----------
  const R6 = seedRoot('r6', { a6: legDoc('A6', '/*A6*/p{margin:1px}') }, { B: { tag: 'b-original' } });
  let heldDuringGates = null;
  const rep6 = await runMigration(R6, { checkers: mockCheckers({ comparePdfs: () => {
    heldDuringGates = rootLock.isHeld(R6);                                       // 门禁期间迁移持有 .migrate.lock
    updateMeta(R6, 'B', (m) => ({ ...(m || {}), tag: 'during-migration' }));     // 同进程对另一文档 B 的原子更新
    return { pass: true, max: 0, pages: [], dpi: 150, threshold: 0.005, pixFmt: 'rgb24' };
  } }) });
  const m6 = readMeta(R6);
  if (!rep6.ok) fail('⑤ 迁移应成功: ' + JSON.stringify(rep6.stopped));
  if (heldDuringGates !== true) fail('⑤ 门禁期间应持有 .migrate.lock（server 写请求 503 已在 T3 测）');
  if ((m6.a6 || {}).schemaVersion !== 2 || (m6.a6 || {}).typo !== '/*A6*/p{margin:1px}') fail('⑤ A 事务字段应落盘: ' + JSON.stringify(m6.a6));
  if ((m6.B || {}).tag !== 'during-migration') fail('⑤ B 的更新应落盘（与 A 事务不互踩）: ' + JSON.stringify(m6.B));
  if (rootLock.isHeld(R6)) fail('⑤ 运行结束后锁应释放');
  console.log('✅ S1-E-⑤ 迁移持 rootLock；同进程 B 文档 updateMeta 与 A 事务不互踩（两文档字段都落盘）');

  // ---------- ⑥ 启动恢复快照兜底 legacy-safe（热修 a7eb561 裁决；仅 oldHtml 载荷缺失时） ----------
  const R7 = seedRoot('r7', {}, {});
  fs.mkdirSync(path.join(R7, 'snapshots', 'fb'), { recursive: true });
  fs.writeFileSync(path.join(R7, 'snapshots', 'fb', '2026-09-20-000000-000.html'), legDoc('SNAP-BODY', LEG_TYPO));   // 冻结快照含内联 typo
  fs.writeFileSync(path.join(R7, 'docs', 'fb.html'), legDoc('PARTIAL', null));                                        // 半程状态：内联已丢
  fs.mkdirSync(path.join(R7, '.tx'), { recursive: true });
  const mkRec = (txId, docId, oldSnapTs, oldMeta) => {   // tx 记录：只有 .json + .meta.json（oldHtml 载荷缺失 → 走快照兜底）
    fs.writeFileSync(path.join(R7, '.tx', txId + '.json'), JSON.stringify({ txId, docId, phase: 'save', oldSnapTs, startedAt: Date.now(), host: 'x', pid: 1 }));
    fs.writeFileSync(path.join(R7, '.tx', txId + '.meta.json'), JSON.stringify(oldMeta));
  };
  mkRec('fb-legacy', 'fb', '2026-09-20-000000-000', { rev: 5 });   // oldMeta 无 typo 键 = legacy
  recoverPending(R7);
  const fbHtml = readDoc(R7, 'fb');
  if (!fbHtml.includes('<style id="typo-custom">' + LEG_TYPO + '</style>')) fail('⑥ legacy（meta.typo 未定义）快照兜底应保留内联排版（不得剥丢）: ' + fbHtml.slice(0, 160));
  if (!fbHtml.includes('SNAP-BODY')) fail('⑥ 兜底应恢复快照正文');
  if ((readMeta(R7).fb || {}).rev !== 5) fail('⑥ meta 应回滚旧副本');
  fs.writeFileSync(path.join(R7, 'docs', 'fb.html'), legDoc('PARTIAL2', null));
  mkRec('fb-migrated', 'fb', '2026-09-20-000000-000', { rev: 6, typo: '/*M*/p{margin:2px}' });   // 已迁移形态：meta.typo 定义
  recoverPending(R7);
  const fb2 = readDoc(R7, 'fb');
  if (/<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(fb2)) fail('⑥ 已迁移（meta.typo 定义）兜底应写归一化正文（typo 在 meta，不再内联）');
  if ((readMeta(R7).fb || {}).typo !== '/*M*/p{margin:2px}' || (readMeta(R7).fb || {}).rev !== 6) fail('⑥ 已迁移兜底 meta 应整份回滚');
  if (txMarkers(R7).length) fail('⑥ 恢复成功后 tx 记录应清理');
  // 手工态（meta.typo 定义但为空串 + 内联存在）：热修 a7eb561 裁决口径是「定义且非空」——空串不是权威来源，
  // 兜底必须把快照内联排版原值回注（freeze.mjs:178 / server.mjs:568 同款），否则恢复把用户排版剥丢。
  fs.writeFileSync(path.join(R7, 'docs', 'fb.html'), legDoc('PARTIAL3', null));   // 半程状态：内联已丢
  mkRec('fb-hand', 'fb', '2026-09-20-000000-000', { rev: 7, typo: '' });
  recoverPending(R7);
  const fb3 = readDoc(R7, 'fb');
  if (!fb3.includes('<style id="typo-custom">' + LEG_TYPO + '</style>')) fail('⑥ 手工态（meta.typo=空串）快照兜底应回注内联排版（空串非权威，同 freeze.mjs:178/server.mjs:568 口径）: ' + fb3.slice(0, 160));
  if (!fb3.includes('SNAP-BODY')) fail('⑥ 手工态兜底应恢复快照正文');
  if ((readMeta(R7).fb || {}).typo !== '' || (readMeta(R7).fb || {}).rev !== 7) fail('⑥ 手工态 meta 应整份回滚（typo 仍是空串，不得被写入内联值）');
  if (txMarkers(R7).length) fail('⑥ 手工态恢复成功后 tx 记录应清理');
  console.log('✅ S1-E-⑥ 启动恢复快照兜底 legacy-safe（legacy 保留内联 / 已迁移归一化 / 手工态 typo=空串 回注内联）');

  // ---------- ⑦ rootLock self-pid 陈旧残锁（pid 复用）：startedAt 早于本进程启动 → 判陈旧；新鲜自锁语义不变 ----------
  const R8 = path.join(tmp, 'r8'); fs.mkdirSync(R8, { recursive: true });
  const lockFile = path.join(R8, '.migrate.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: 'x', startedAt: Date.now() - Math.ceil(process.uptime() * 1000) - 5000 }));
  if (rootLock.isHeld(R8)) fail('⑦ self-pid 残锁（startedAt 早于本进程启动 = pid 复用前任遗留）应判陈旧（否则启动后写请求 503 直至手删）');
  rootLock.acquire(R8);   // 应破除陈旧残锁后成功持有
  if (!rootLock.isHeld(R8)) fail('⑦ 破除残锁后应可持有');
  rootLock.release(R8);
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: 'x', startedAt: Date.now() }));
  if (!rootLock.isHeld(R8)) fail('⑦ 新鲜 self-pid 锁仍应视为持有（同步短临界区语义不变）');
  fs.rmSync(lockFile, { force: true });
  console.log('✅ S1-E-⑦ rootLock self-pid 陈旧残锁判陈旧（pid 复用可破除）；新鲜自锁仍视为持有');

  // ---------- ⑧ beginTx 载荷落盘校验：.tx/<txId>.html 写失败 → 抛 TX_PAYLOAD_MISSING → 硬停整轮 ----------
  // 迁移传 oldSnapTs:''（无快照兜底），载荷缺失 = 本事务无恢复源；此刻尚未改动任何文档 → 必须停轮（不降级续跑）。
  // 载荷缺失的事务仍留标记（tx 记录 1 条），交启动恢复或人工介入，不得静默清理。
  const R9 = seedRoot('r9', { pa: legDoc('PA', '/*PA*/p{margin:3px}'), pb: legDoc('PB', null) }, {});
  const pa0 = readDoc(R9, 'pa'), pb0 = readDoc(R9, 'pb'), meta9Raw = fs.readFileSync(path.join(R9, 'docs-meta.json'), 'utf8');
  const realWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = function (p, ...rest) {   // 钩子：只让 .tx/ 里的 .html 载荷写入失败（ENOSPC 形态），标记/meta 载荷照常
    const s = String(p);
    if (s.includes(path.sep + '.tx' + path.sep) && /\.html\.[^/\\]+\.tmp$/.test(s)) { const e = new Error('ENOSPC: no space left on device（模拟载荷写入失败）'); e.code = 'ENOSPC'; throw e; }
    return realWriteFileSync.apply(fs, [p, ...rest]);
  };
  let rep9;
  try { rep9 = await runMigration(R9, { checkers: mockCheckers() }); } finally { fs.writeFileSync = realWriteFileSync; }
  if (!rep9 || rep9.ok || !rep9.stopped) fail('⑧ 载荷未落盘必须停整轮（不得带着"无恢复源"的事务继续迁移）: ' + JSON.stringify(rep9 && rep9.stopped));
  if (rep9.stopped.code !== 'TX_PAYLOAD_MISSING') fail('⑧ stopped.code 应 TX_PAYLOAD_MISSING: ' + rep9.stopped.code);
  if (!/载荷/.test(rep9.stopped.message || '') || !/恢复源/.test(rep9.stopped.message || '')) fail('⑧ 错误信息须说清"载荷未落盘/无恢复源/已停止": ' + rep9.stopped.message);
  if (readDoc(R9, 'pa') !== pa0 || readDoc(R9, 'pb') !== pb0) fail('⑧ 停轮发生在任何正文改动之前（pa/pb 旧字节不变）');
  if (fs.readFileSync(path.join(R9, 'docs-meta.json'), 'utf8') !== meta9Raw) fail('⑧ 停轮时不得写 meta（无 schemaVersion/登记字段）: ' + fs.readFileSync(path.join(R9, 'docs-meta.json'), 'utf8'));
  if (txDocIds(R9).length !== 1) fail('⑧ tx 记录应保留（标记 1 条）交启动恢复/人工，不得静默清理: ' + JSON.stringify(txMarkers(R9)));
  if (rootLock.isHeld(R9)) fail('⑧ 停轮后 rootLock 应释放（本进程仍持有所有权）');
  // 非静默形态（beginTx 自身抛错，.tx 路径被普通文件占位）同样停整轮、零改动
  const R9b = seedRoot('r9b', { ro: legDoc('RO', null) }, {});
  const ro0 = readDoc(R9b, 'ro'), meta9bRaw = fs.readFileSync(path.join(R9b, 'docs-meta.json'), 'utf8');
  fs.writeFileSync(path.join(R9b, '.tx'), 'not-a-dir');   // beginTx 的 mkdirSync 确定性抛 EEXIST（与 uid 无关）
  const rep9b = await runMigration(R9b, { checkers: mockCheckers() });
  if (!rep9b || rep9b.ok || !rep9b.stopped) fail('⑧b .tx 不可用（beginTx 抛错）也应停整轮: ' + JSON.stringify(rep9b && rep9b.stopped));
  if (readDoc(R9b, 'ro') !== ro0 || fs.readFileSync(path.join(R9b, 'docs-meta.json'), 'utf8') !== meta9bRaw) fail('⑧b 停轮时不得改动文档/写 meta');
  console.log('✅ S1-E-⑧ beginTx 载荷落盘校验：.html 载荷写失败 → TX_PAYLOAD_MISSING 硬停整轮（零文档改动、tx 记录保留）；.tx 不可用同样停轮');

  // ---------- ⑨ 迁移中途 rootLock 所有权丧失（>30min 被 server 判陈旧破除并接管）→ 不写 schemaVersion=2、tx 保留、不删他人锁 ----------
  const R10 = seedRoot('r10', { lost: legDoc('LOST', '/*LOST*/p{margin:4px}') }, {});
  const lost0 = readDoc(R10, 'lost');
  let sawOwnLockInGates = null;
  const rep10 = await runMigration(R10, { checkers: mockCheckers({ comparePdfs: () => {
    sawOwnLockInGates = JSON.parse(fs.readFileSync(rootLock.path(R10), 'utf8')).pid === process.pid;
    atomicWrite(rootLock.path(R10), JSON.stringify({ pid: 424242, host: 'other-holder', startedAt: Date.now() }));   // 门禁期间锁被他人接管
    return { pass: true, max: 0, pages: [], dpi: 150, threshold: 0.005, pixFmt: 'rgb24' };
  } }) });
  if (sawOwnLockInGates !== true) fail('⑨ 前置失败：门禁期间本进程应持有 .migrate.lock');
  if (rep10.ok || !rep10.stopped || rep10.stopped.code !== 'LOCK_LOST') fail('⑨ 所有权丧失应以 LOCK_LOST STOP: ' + JSON.stringify(rep10.stopped));
  const mLost = readMeta(R10).lost || null;
  if (mLost && (mLost.schemaVersion === 2 || (mLost.migration || {}).state === 'done')) fail('⑨ 所有权丧失后不得写 schemaVersion=2/done（唯一完成判据不能被无锁进程盖章）: ' + JSON.stringify(mLost));
  if (!txDocIds(R10).includes('lost')) fail('⑨ tx 记录应保留待恢复（不得 commitTx）: ' + JSON.stringify(txMarkers(R10)));
  const lockNow = JSON.parse(fs.readFileSync(rootLock.path(R10), 'utf8'));
  if (lockNow.pid !== 424242 || lockNow.host !== 'other-holder') fail('⑨ finally 只在自己仍持有时删锁（不得 unlink 他人锁）: ' + JSON.stringify(lockNow));
  // 保留的 tx 记录必须是可用恢复源：启动恢复把 html+meta 拉回迁移前旧状态
  fs.rmSync(rootLock.path(R10), { force: true });
  const rec10 = recoverPending(R10);
  if (!rec10.some((r) => r.docId === 'lost' && r.ok)) fail('⑨ 保留记录应可被启动恢复: ' + JSON.stringify(rec10.map((r) => [r.docId, r.ok, r.error])));
  if (readDoc(R10, 'lost') !== lost0) fail('⑨ 恢复后正文应为迁移前旧字节（内联排版仍在）');
  if (readMeta(R10).lost) fail('⑨ 恢复后 meta 应回滚（迁移前无条目 → 删除）: ' + JSON.stringify(readMeta(R10).lost));
  console.log('✅ S1-E-⑨ 迁移中途锁所有权丧失 → 不写 schemaVersion=2、tx 记录保留（可恢复）、不删他人锁');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
EOF

# —— S1-E-2：迁移端到端（隔离根 + 真实门禁：render.mjs 渲染 + pdftotext/pdfinfo + pixel-diff RGB24，不注入模拟）——
# legacy 夹具（真实内联 css 无来源属性 + 内联 typo-custom + 无 meta 条目）与 classic 夹具（T5+ 新建形态）各一份。
command -v ffmpeg >/dev/null || { echo '❌ S1-E-2 需要 ffmpeg: brew install ffmpeg'; exit 1; }
command -v pdftoppm >/dev/null || { echo '❌ S1-E-2 需要 poppler(pdftoppm): brew install poppler'; exit 1; }
command -v pdftotext >/dev/null || { echo '❌ S1-E-2 需要 poppler(pdftotext): brew install poppler'; exit 1; }
command -v pdfinfo >/dev/null || { echo '❌ S1-E-2 需要 poppler(pdfinfo): brew install poppler'; exit 1; }
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assembleTemplate, themeCss } from './template.mjs';
import { sha1 } from './freeze.mjs';
import { runMigration } from './migrate-meta.mjs';
const fail = (m) => { console.error('❌ S1-E-2 ' + m); process.exit(1); };
const md5File = (f) => createHash('md5').update(fs.readFileSync(f)).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1e2-'));
const R = path.join(tmp, 'data');
for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(R, d), { recursive: true });
const fill = (tpl, id, name) => tpl
  .replaceAll('{{NAME}}', () => name).replaceAll('{{CONTACT}}', () => '电话：12345678901 ｜ 邮箱：e2e@example.com').replaceAll('{{INTENT}}', () => '意向岗位：后端工程师')
  .replaceAll('{{SUMMARY}}', () => '五年后端研发经验，主导高并发订单系统与数据链路建设。')
  .replaceAll('{{SKILLS}}', () => '<p>Node.js / MySQL / Redis / 消息队列</p>')
  .replaceAll('{{WORK}}', () => '<div class="entry"><div class="entry-title">某科技公司</div><div class="entry-role">后端工程师</div><div class="entry-date">2021-2026</div><p>负责订单核心服务，主导拆单重构与容量治理。</p></div>')
  .replaceAll('{{PROJECTS}}', () => '<div class="entry"><div class="entry-title">订单系统重构</div><p>单体拆分与链路治理，峰值吞吐提升一倍。</p></div>')
  .replaceAll('{{EDU}}', () => '<div class="entry"><div class="entry-title">某大学</div><div class="entry-role">本科｜计算机科学与技术</div><div class="entry-date">2016-2020</div></div>')
  .replaceAll('{{DOC_ID}}', () => id);
// legacy 夹具：主 <style> 无来源属性（既有文档形态）+ 内联 typo-custom + 无 meta 条目
const TYPO_CSS = '.sheet p{letter-spacing:0.02em}';
const legacyHtml = fill(assembleTemplate('classic'), 'e2e-legacy', '遗留员工')
  .replace('<style data-theme="classic">', '<style>')
  .replace('</head>', '<style id="typo-custom">' + TYPO_CSS + '</style>\n</head>');
fs.writeFileSync(path.join(R, 'docs', 'e2e-legacy.html'), legacyHtml);
// classic 夹具（T5+ 新建形态）：data-theme 属性 + meta 登记齐全、schemaVersion=1
const classicHtml = fill(assembleTemplate('classic'), 'e2e-classic', '新建员工');
fs.writeFileSync(path.join(R, 'docs', 'e2e-classic.html'), classicHtml);
fs.writeFileSync(path.join(R, 'docs-meta.json'), JSON.stringify({ 'e2e-classic': { theme: 'classic', styleHash: sha1(themeCss('classic')), typo: '', schemaVersion: 1, rev: 1 } }));
fs.writeFileSync(path.join(R, 'applications.json'), '[]');
fs.writeFileSync(path.join(R, 'materials.json'), '[]');
// 历史快照（不可变）：一份含内联 typo、一份不含（其文档 meta.typo 未定义）
fs.mkdirSync(path.join(R, 'snapshots', 'e2e-legacy'), { recursive: true });
const snapA = path.join(R, 'snapshots', 'e2e-legacy', '2026-09-10-000000-000.html');
const snapB = path.join(R, 'snapshots', 'e2e-legacy', '2026-09-11-000000-000.html');
fs.writeFileSync(snapA, legacyHtml);
fs.writeFileSync(snapB, legacyHtml.replace('<style id="typo-custom">' + TYPO_CSS + '</style>\n', ''));
const snapMd5Before = [md5File(snapA), md5File(snapB)];
try {
  const rep = await runMigration(R);   // 真实门禁：不注入
  if (!rep.ok) fail('端到端迁移应成功: ' + JSON.stringify(rep.stopped));
  const m = JSON.parse(fs.readFileSync(path.join(R, 'docs-meta.json'), 'utf8'));
  const leg = m['e2e-legacy'] || {}, cls = m['e2e-classic'] || {};
  const legHtml = fs.readFileSync(path.join(R, 'docs', 'e2e-legacy.html'), 'utf8');
  if (leg.schemaVersion !== 2 || (leg.migration || {}).state !== 'done') fail('legacy 应 done: ' + JSON.stringify(leg));
  if (leg.typo !== TYPO_CSS) fail('legacy meta.typo 应=原内联 css: ' + JSON.stringify(leg.typo));
  if (/<style\b[^>]*\bid\s*=\s*["']typo-custom["']/i.test(legHtml)) fail('legacy 迁移后 html 不应含 typo-custom');
  if (!legHtml.includes('data-style-origin="legacy-inline"') || leg.theme !== 'legacy') fail('legacy 应登记来源属性 + theme=legacy');
  if (!/^[0-9a-f]{40}$/.test(String(leg.styleHash)) || !/^[0-9a-f]{40}$/.test(String(leg.renderInputId))) fail('legacy styleHash/renderInputId 应为完整 40hex');
  if (cls.schemaVersion !== 2 || cls.theme !== 'classic' || cls.typo !== '') fail('classic 应 no-op 提取+门禁+done: ' + JSON.stringify(cls));
  if ('lastRenderInputId' in leg || 'lastRenderInputId' in cls) fail('端到端迁移绝不写 meta.lastRenderInputId（M-7：渲染任务身份只由真实渲染写）');
  if (fs.readFileSync(path.join(R, 'docs', 'e2e-classic.html'), 'utf8') !== classicHtml) fail('classic html 应零改写');
  for (const id of ['e2e-legacy', 'e2e-classic']) {
    const chk = (m[id] || {}).migration && m[id].migration.checks || {};
    if (!chk.text || chk.text.identical !== true) fail(id + ' 文本层门禁应 0 差异: ' + JSON.stringify(chk.text));
    if (!chk.pages || chk.pages.before !== chk.pages.after || !(chk.pages.before >= 1)) fail(id + ' 页数门禁应相等: ' + JSON.stringify(chk.pages));
    if (!chk.visual || chk.visual.pass !== true || !(chk.visual.max <= 0.005) || chk.visual.dpi !== 150 || chk.visual.pixFmt !== 'rgb24') fail(id + ' 视觉门禁应 RGB24@150 ≤0.5% 通过: ' + JSON.stringify(chk.visual));
  }
  if (md5File(snapA) !== snapMd5Before[0] || md5File(snapB) !== snapMd5Before[1]) fail('历史快照不可变（md5 前后一致）');
  const au = rep.snapshotAudit || {};
  if (au.total !== 2 || au.withInlineTypo.length !== 1 || au.legacyWithoutTypo.length !== 1) fail('快照 typo 预检计数不符: ' + JSON.stringify(au));
  const bks = fs.existsSync(path.join(R, 'backups')) ? fs.readdirSync(path.join(R, 'backups')).filter((d) => d.startsWith('pre-s1-')) : [];
  if (bks.length !== 1 || !fs.existsSync(path.join(R, 'backups', bks[0], 'docs', 'e2e-legacy.html'))) fail('backups/pre-s1-<ts>/ 全量副本应在');
  const legChk = m['e2e-legacy'].migration.checks;
  console.log('✅ S1-E-2 隔离根端到端（真实门禁不注入）：legacy+classic 三门禁全过（文本 0 差异/页数 ' + legChk.pages.before + '=' + legChk.pages.after + '/视觉 max=' + legChk.visual.max.toFixed(6) + ' ≤0.005 RGB24@150），历史快照 md5 不变');

  // —— S1-E-2b：CLI 级证据（I-2）：事务载荷无法落盘 → 非零退出 + 明确停轮报错 + 零文档改动/零 schemaVersion ——
  const RC = path.join(tmp, 'cli-payload');
  for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(RC, d), { recursive: true });
  fs.writeFileSync(path.join(RC, 'docs', 'cli.html'), legacyHtml);
  fs.writeFileSync(path.join(RC, 'docs-meta.json'), '{}');
  fs.writeFileSync(path.join(RC, 'applications.json'), '[]');
  fs.writeFileSync(path.join(RC, 'materials.json'), '[]');
  fs.writeFileSync(path.join(RC, '.tx'), 'not-a-dir');   // beginTx 的 mkdirSync 确定性抛错（与 uid/权限无关）
  const cliDoc0 = fs.readFileSync(path.join(RC, 'docs', 'cli.html'), 'utf8');
  const cli = spawnSync(process.execPath, ['migrate-meta.mjs'], { cwd: process.cwd(), encoding: 'utf8', timeout: 180000, env: { ...process.env, RESUME_ROOT: RC } });
  if (cli.status === 0 || cli.status === null) fail('2b 载荷不可落盘时 CLI 不得 exit 0（实际 ' + cli.status + '）');
  if (!/停止整轮|迁移失败/.test(String(cli.stderr || ''))) fail('2b CLI 应给出明确停轮报错: ' + String(cli.stderr || '').slice(0, 400));
  if (fs.readFileSync(path.join(RC, 'docs', 'cli.html'), 'utf8') !== cliDoc0) fail('2b CLI 停轮时不得改动文档正文');
  if (JSON.parse(fs.readFileSync(path.join(RC, 'docs-meta.json'), 'utf8')).cli) fail('2b CLI 停轮时不得写 meta/schemaVersion');
  if (fs.existsSync(path.join(RC, '.migrate.lock'))) fail('2b CLI 停轮后应释放 .migrate.lock（自己持有 → 可删）');
  console.log('✅ S1-E-2b CLI 载荷不可落盘 → 非零退出（exit ' + cli.status + '）+ 明确停轮报错 + 零文档改动 + 锁已释放');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
EOF

# —— S1-E-3：负向真实门禁（S1-T9，plan T9 step 2 精神）：正文被改（font-size bump）的迁移必须被真实像素门禁拒绝 ——
# ratio > 0.005 → 该文档 html+meta 完整恢复（旧字节）+ STOP 整轮（不写 done）。证明门禁在真实渲染上有牙齿，不只对模拟检查器。
# 构造：只注入 renderPdf（渲染 after 前给冻结输入追加 font-size bump，模拟"迁移改了正文"）；pdftotext/pdfinfo/comparePdfs
# 全部真实（poppler+ffmpeg）——bump 不改文本层与页数（前两门先通过），拒绝必须来自第三门（真实 RGB24 像素比较）。
# 隔离：mktemp 根 + chromium 缓存种入（读真实根缓存仅只读），零接触真实 docs/snapshots/pdfs/JSON。
command -v ffmpeg >/dev/null || { echo '❌ S1-E-3 需要 ffmpeg: brew install ffmpeg'; exit 1; }
command -v pdftoppm >/dev/null || { echo '❌ S1-E-3 需要 poppler(pdftoppm): brew install poppler'; exit 1; }
command -v pdftotext >/dev/null || { echo '❌ S1-E-3 需要 poppler(pdftotext): brew install poppler'; exit 1; }
command -v pdfinfo >/dev/null || { echo '❌ S1-E-3 需要 poppler(pdfinfo): brew install poppler'; exit 1; }
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { runMigration } from './migrate-meta.mjs';
import { comparePdfs } from './tools/pixel-diff.mjs';
import { readCache } from './chromium.mjs';
const fail = (m) => { console.error('❌ S1-E-3 ' + m); process.exit(1); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1e3-'));
const R = path.join(tmp, 'data');
for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(R, d), { recursive: true });
const cache = readCache();   // 种 chromium 缓存到隔离根（真实根只读；render.mjs 免再探针）
if (cache) fs.writeFileSync(path.join(R, '.chromium-choice.json'), JSON.stringify(cache));
const CSS = '\n.sheet{color:#111}\n';
// 8 短行夹具 + 26px bump：实测文本层 0 差异、页数 1=1、像素 ratio≈0.0115（>0.005 阈值 2.3 倍，稳定拒绝）
const NEG_LINES = Array.from({ length: 8 }, (_, i) => '<p>NEG-' + i + ' 短行</p>').join('');
const negDoc = '<!doctype html>\n<html><head>\n<meta charset="utf-8">\n<style>' + CSS + '</style>\n</head>\n<body>\n<div class="sheet">' + NEG_LINES + '</div>\n</body></html>\n';
fs.writeFileSync(path.join(R, 'docs', 'neg.html'), negDoc);
fs.writeFileSync(path.join(R, 'docs-meta.json'), '{}');
fs.writeFileSync(path.join(R, 'applications.json'), '[]');
fs.writeFileSync(path.join(R, 'materials.json'), '[]');
const doc0 = fs.readFileSync(path.join(R, 'docs', 'neg.html'), 'utf8');
const meta0Raw = fs.readFileSync(path.join(R, 'docs-meta.json'), 'utf8');
const RENDER = path.join(process.cwd(), 'render.mjs');
let renderCalls = 0;
try {
  const rep = await runMigration(R, { checkers: {
    // 真实渲染；runGates 固定先渲 before 再渲 after → 第 2 次调用即 after.html：渲染前注入 font-size bump
    renderPdf: async (src, out) => {
      renderCalls++;
      if (renderCalls === 2) fs.writeFileSync(src, fs.readFileSync(src, 'utf8').replace('</head>', '<style>.sheet p{font-size:26px}</style>\n</head>'));
      const r = spawnSync(process.execPath, [RENDER, '--src', src, '--out', out], { env: { ...process.env, RESUME_ROOT: R }, encoding: 'utf8', timeout: 180000 });
      if (r.status !== 0 || !fs.existsSync(out)) throw new Error('渲染失败 exit ' + r.status + ': ' + String(r.stderr || '').slice(0, 200));
      return true;
    },
    pdftotext: (pdf) => execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 }),
    pdfinfoPages: (pdf) => Number(/Pages:\s*(\d+)/.exec(execFileSync('pdfinfo', [pdf], { encoding: 'utf8', timeout: 30000 }))[1]),
    comparePdfs: (a, b, o) => comparePdfs(a, b, o)   // 真实 RGB24@150 像素门禁（不模拟）
  } });
  if (renderCalls !== 2) fail('前置：before/after 应各真实渲染一次（calls=' + renderCalls + '）');
  if (!rep || rep.ok || !rep.stopped || rep.stopped.docId !== 'neg') fail('正文被改的迁移必须被真实门禁拒绝并 STOP 整轮: ' + JSON.stringify(rep && rep.stopped));
  if (rep.stopped.code !== 'GATE_FAILED') fail('stopped.code 应 GATE_FAILED: ' + rep.stopped.code);
  if (!/视觉门禁未通过/.test(rep.stopped.message || '')) fail('拒绝必须来自真实像素门禁（文本层/页数门应先通过）: ' + rep.stopped.message);
  const mm = /max ratio ([0-9.eE+-]+)/.exec(rep.stopped.message || '');
  if (!mm || !(Number(mm[1]) > 0.005)) fail('真实像素 ratio 应 > 0.005（实测 ' + (mm ? mm[1] : 'n/a') + '）');
  if (rep.stopped.restored !== true) fail('应报告已完整恢复（html+meta 双恢复成功）');
  if (fs.readFileSync(path.join(R, 'docs', 'neg.html'), 'utf8') !== doc0) fail('失败后文档应完整恢复旧字节（bump 不得残留）');
  if (fs.readFileSync(path.join(R, 'docs-meta.json'), 'utf8') !== meta0Raw) fail('失败后 docs-meta 应零改动（无 schemaVersion/登记字段）: ' + fs.readFileSync(path.join(R, 'docs-meta.json'), 'utf8'));
  if (fs.existsSync(path.join(R, '.tx')) && fs.readdirSync(path.join(R, '.tx')).some((f) => f.endsWith('.json'))) fail('双恢复成功 → commitTx，.tx 应干净');
  const snaps = fs.existsSync(path.join(R, 'snapshots', 'neg')) ? fs.readdirSync(path.join(R, 'snapshots', 'neg')) : [];
  if (snaps.length) fail('迁移快照归 backups/，snapshots/ 配额目录不得增长: ' + JSON.stringify(snaps));
  console.log('✅ S1-E-3 负向真实门禁：font-size bump 正文改动 → 真实像素 ratio=' + Number(mm[1]).toFixed(6) + ' > 0.005 被拒（文本/页数门先通过），per-doc 完整恢复 + STOP 整轮');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
EOF

# —— S1-F：状态维度（kind/flow/archivedAt）+ 旧值映射（迁移删 job.status）+ 派生可投递/usedBy/deliveredRefs + exports 幂等键 ——
# 隔离：全程 mktemp 根；映射段注入模拟检查器；服务段隔离端口 + 假渲染器。零接触真实 docs/snapshots/pdfs/JSON/config。
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { spawn } from 'node:child_process';
import { updateMeta } from './tx.mjs';
import { runMigration } from './migrate-meta.mjs';
const fail = (m) => { console.error('❌ S1-F ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1f-'));
const CSS = '\n.sheet{color:#111}\n';
const doc = (id, body) => '<!doctype html>\n<html><head>\n<meta charset="utf-8">\n<style>' + CSS + '</style>\n</head>\n<body>\n<h1>' + id + '</h1>\n<div class="sheet"><p>' + body + '</p></div>\n</body></html>\n';
const seedRoot = (name, docs, meta) => {
  const r = path.join(tmp, name);
  for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, 'docs-meta.json'), JSON.stringify(meta || {}));
  fs.writeFileSync(path.join(r, 'applications.json'), '[]');
  fs.writeFileSync(path.join(r, 'materials.json'), '[]');
  for (const [id, html] of Object.entries(docs)) fs.writeFileSync(path.join(r, 'docs', id + '.html'), html);
  return r;
};
const readMeta = (r) => JSON.parse(fs.readFileSync(path.join(r, 'docs-meta.json'), 'utf8'));
const mockCheckers = () => ({
  renderPdf: async (src, out) => { fs.writeFileSync(out, '%PDF-1.4 mock\n'); return true; },
  pdftotext: () => 'MOCK-TEXT', pdfinfoPages: () => 1,
  comparePdfs: () => ({ pass: true, max: 0, pages: [{ page: 1, ratio: 0 }], dpi: 150, threshold: 0.005, pixFmt: 'rgb24' })
});
try {
  // ---------- ① 映射表四例 + 无 job 母版 + 已显式写 flow 不被旧映射覆盖；迁移后删 job.status（单源） ----------
  const R1 = seedRoot('r1', { jd: doc('jd', 'D'), jp: doc('jp', 'P'), jv: doc('jv', 'V'), jl: doc('jl', 'L'), mm: doc('mm', 'M'), jw: doc('jw', 'W') }, {
    jd: { job: { status: 'draft', changes: [], todos: [] } },
    jp: { job: { status: 'draft', changes: [{ id: 'c1', status: 'pending' }], todos: [] } },
    jv: { job: { status: 'deliverable', changes: [] } },
    jl: { job: { status: 'delivered', changes: [], deliveredAt: 'x' } },
    mm: { tag: '母版' },
    jw: { flow: 'reviewed', job: { status: 'draft', changes: [] } }   // 迁移前新代码已显式写 flow → 不得被旧映射覆盖
  });
  const rep1 = await runMigration(R1, { checkers: mockCheckers() });
  if (!rep1.ok) fail('① 迁移应成功: ' + JSON.stringify(rep1.stopped));
  const m1 = readMeta(R1);
  const expect = { jd: ['job', 'draft'], jp: ['job', 'reviewing'], jv: ['job', 'reviewed'], jl: ['job', 'reviewed'], mm: ['master', 'draft'], jw: ['job', 'reviewed'] };
  for (const [id, pair] of Object.entries(expect)) {
    const e = m1[id] || {};
    if (e.kind !== pair[0]) fail('① ' + id + ' kind 应为 ' + pair[0] + ': ' + JSON.stringify(e.kind));
    if (e.flow !== pair[1]) fail('① ' + id + ' flow 应为 ' + pair[1] + '（映射表）: ' + JSON.stringify(e.flow));
    if (e.archivedAt !== null) fail('① ' + id + ' archivedAt 应初始化为 null（独立归档标记，不混入 flow）: ' + JSON.stringify(e.archivedAt));
    if (e.schemaVersion !== 2) fail('① ' + id + ' schemaVersion 应为 2');
    if (e.job && Object.prototype.hasOwnProperty.call(e.job, 'status')) fail('① ' + id + ' 迁移后应删除 job.status（单源）: ' + JSON.stringify(e.job));
    if (pair[0] === 'job' && !e.job) fail('① ' + id + ' 应保留 job 对象（只删 status 键）');
  }
  if (m1.jl.job.deliveredAt !== 'x') fail('① 只删 job.status，job 其他字段（deliveredAt）应保留');
  console.log('✅ S1-F-① 状态映射表（draft→draft / draft+pending→reviewing / deliverable→reviewed / delivered→reviewed / 无job→master+draft）+ 显式 flow 优先 + 删 job.status + archivedAt=null');

  // ---------- ② 服务级：派生可投递三条件 + 兼容读不写回 + usedBy/deliveredRefs 派生自 applications.json + exports 幂等键 + RFC5987 ----------
  const R2 = seedRoot('r2', { jdoc: doc('jdoc', 'J-V1'), exdoc: doc('exdoc', 'E-V1'), jl2: doc('jl2', 'L-V1') }, {
    jdoc: { kind: 'job', flow: 'draft', schemaVersion: 2, job: { changes: [] }, company: '测试司', role: '岗' },
    jl2: { job: { status: 'deliverable', changes: [] }, lastRenderInputId: 'seed-not-match' }   // 兼容读夹具（schemaVersion<2、无 flow、无 PDF → 不 stale 判定无关）
  });
  const fr = path.join(tmp, 'fake-render.sh');
  // 旁车 <out>.env.json 透传 RESUME_RENDER_INPUT_ID（与真实 render.mjs 同契约；POST /export 直渲物化依赖它做名实校验）
  fs.writeFileSync(fr, '#!/bin/bash\nshift\nif [ "$1" = "--src" ]; then out="$4"; else out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\nprintf "%%PDF-1.4 fake\\n" > "$out"\necho \'{"renderInputId":"\'"$RESUME_RENDER_INPUT_ID"\'","reproducible":true,"dpi":150}\' > "$out.env.json"\n');
  fs.chmodSync(fr, 0o755);
  const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const port = await freePort();
  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, RESUME_ROOT: R2, PORT: String(port), RESUME_RENDER_BIN: fr },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serr = ''; srv.stderr.on('data', (d) => { serr += d; });
  const B = 'http://127.0.0.1:' + port;
  try {
    let up = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 12000) { if (srv.exitCode !== null) break; try { await fetch(B + '/'); up = true; break; } catch {} await sleep(80); }
    if (!up) fail('② 测试服务启动失败: ' + serr.slice(0, 500));
    const home = async () => await (await fetch(B + '/')).text();
    const metaRaw = () => fs.readFileSync(path.join(R2, 'docs-meta.json'), 'utf8');
    const postJ = (u, body) => fetch(B + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? '' : JSON.stringify(body) }).then((r) => r.json());

    // 兼容读（schemaVersion<2）：flow 由 job.status 即时推导（/job/changes 兼容视图），且绝不写回
    const rawBefore = metaRaw();
    const jl2State = await (await fetch(B + '/job/changes?id=jl2')).json();
    if (!jl2State.ok || !jl2State.job) fail('② jl2 /job/changes 应成功');
    if (jl2State.job.flow !== 'reviewed') fail('② 兼容读应从 job.status=deliverable 即时推导 flow=reviewed: ' + JSON.stringify(jl2State.job.flow));
    if (jl2State.job.status !== 'deliverable') fail('② 兼容视图 status 应为旧词汇 deliverable: ' + JSON.stringify(jl2State.job.status));
    await home();
    if (metaRaw() !== rawBefore) fail('② 兼容读不得写回（docs-meta 字节不变）');

    // 派生可投递三条件（flow==='reviewed' / 无 pending 事实冲突 / !stale）——全部满足才「可投递」
    // S2-T3：匹配收进徽章文本（>可投递<）——首页 hero 文案含「可投递」散文（"生成可投递的两页 PDF"），裸子串会误报；徽章语义不变
    await postJ('/render?id=jdoc');   // fresh
    let h = await home();
    if (h.includes('>可投递<')) fail('② 条件1：flow=draft 不得可投递');
    const jc = await postJ('/job/changes?id=jdoc', { status: 'deliverable' });   // → flow=reviewed
    if (!jc.ok || jc.job.flow !== 'reviewed' || jc.job.status !== 'deliverable') fail('② status=deliverable 应映射 flow=reviewed: ' + JSON.stringify(jc.job));
    h = await home();
    if (!h.includes('>可投递<')) fail('② flow=reviewed + 无冲突 + fresh 应可投递（派生）');
    updateMeta(R2, 'jdoc', (m) => ({ ...m, job: { ...m.job, changes: [{ id: 'cf1', level: 'conflict', status: 'pending' }] } }));
    h = await home();
    if (h.includes('>可投递<')) fail('② 条件2：存在 pending 事实冲突不得可投递');
    await postJ('/job/changes?id=jdoc', { updates: [{ id: 'cf1', status: 'rejected' }] });
    h = await home();
    if (!h.includes('>可投递<')) fail('② 冲突处理后应恢复可投递');
    fs.writeFileSync(path.join(R2, 'docs', 'jdoc.html'), doc('jdoc', 'J-V2'));   // 直接改正文 → stale（不经 /save，flow 不动）
    h = await home();
    if (h.includes('>可投递<')) fail('② 条件3：stale 不得可投递');
    await postJ('/render?id=jdoc');
    h = await home();
    if (!h.includes('>可投递<')) fail('② 重渲（fresh）后应恢复可投递');
    // 改稿（/save）使 reviewed 失效 → flow 降回 draft（可投递随之失效；已有投递存档不受影响）
    await fetch(B + '/save?id=jdoc', { method: 'POST', headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: doc('jdoc', 'J-V3') });
    const jAfterSave = await (await fetch(B + '/job/changes?id=jdoc')).json();
    if (jAfterSave.job.flow !== 'draft' || jAfterSave.job.status !== 'draft') fail('② 改稿后 flow 应降回 draft（兼容视图 status=draft）: ' + JSON.stringify(jAfterSave.job && { f: jAfterSave.job.flow, s: jAfterSave.job.status }));
    h = await home();
    if (h.includes('>可投递<')) fail('② 改稿后不得可投递');

    // exports 幂等键（顺序重复 POST）+ GET 导出页 / POST /render 不创建记录
    await (await fetch(B + '/export?id=exdoc')).text();          // 打开导出页（自动重渲）
    await postJ('/render?id=exdoc');                              // 显式渲染
    let mEx = readMeta(R2).exdoc || {};
    if (mEx.exports) fail('② GET 导出页 / POST /render 不得创建 exports 记录');
    const p1 = await (await fetch(B + '/export?id=exdoc', { method: 'POST' })).json();
    const p2 = await (await fetch(B + '/export?id=exdoc', { method: 'POST' })).json();
    mEx = readMeta(R2).exdoc || {};
    const histF = () => fs.readdirSync(path.join(R2, 'pdfs', 'history')).filter((f) => f.startsWith('exdoc@'));
    if (!p1.ok || !p1.exportId || !String(p1.url || '').includes('/history-pdf?exportId=')) fail('② POST /export 应返回 exportId + /history-pdf url: ' + JSON.stringify(p1));
    if ((mEx.exports || []).length !== 1) fail('② 同身份重复 POST 应仅 1 条记录: ' + (mEx.exports || []).length);
    if (p2.exportId !== p1.exportId || p2.reused !== true) fail('② 重复 POST 应复用同一 exportId（reused=true）: ' + JSON.stringify(p2));
    if (histF().length !== 1) fail('② 应仅 1 个不可变产物: ' + histF().join(','));
    const e0 = (mEx.exports || [])[0] || {};
    if (e0.file !== 'pdfs/history/' + histF()[0]) fail('② entry.file 应指向不可变产物（相对路径）: ' + JSON.stringify(e0.file));
    if (!/^[0-9a-f]{40}$/.test(String(e0.renderInputId))) fail('② renderInputId 应为完整 40hex: ' + JSON.stringify(e0.renderInputId));
    fs.writeFileSync(path.join(R2, 'docs', 'exdoc.html'), doc('exdoc', 'E-V2'));   // 新身份
    const p3 = await (await fetch(B + '/export?id=exdoc', { method: 'POST' })).json();
    mEx = readMeta(R2).exdoc || {};
    if ((mEx.exports || []).length !== 2 || p3.exportId === p1.exportId) fail('② 新身份应新增记录（幂等键=renderInputId 而非 docId）');
    if (histF().length !== 2) fail('② 新身份应有新的不可变产物: ' + histF().join(','));

    // usedBy / deliveredRefs：读取时从 applications.json 派生（权威来源），随编辑即时变化，绝不存储/写回
    const rawBefore2 = metaRaw();
    let exPage = await (await fetch(B + '/export?id=exdoc')).text();
    if (exPage.includes('投递使用')) fail('② 无投递时不应出现 usedBy 关联');
    fs.writeFileSync(path.join(R2, 'applications.json'), JSON.stringify([
      { id: '2026-09-25-000000-000', company: '甲公司', role: '岗A', docId: 'exdoc', exportId: e0.exportId, snapTs: e0.snapTs, status: '已投递' },
      { id: '2026-09-25-000000-001', company: '乙公司', role: '岗B', docId: 'jdoc', status: '已投递' }
    ]));
    exPage = await (await fetch(B + '/export?id=exdoc')).text();
    h = await home();
    if (!exPage.includes('投递使用') || !exPage.includes('甲公司')) fail('② usedBy 应读取时派生自 applications.json（导出页导出记录）');
    if (!h.includes('已记录投递')) fail('② deliveredRefs 应派生「已记录投递」徽章（applications.json 权威）');
    if (metaRaw() !== rawBefore2) fail('② 派生不得写回 docs-meta（字节不变）');
    if (metaRaw().includes('usedBy') || metaRaw().includes('deliveredRefs')) fail('② usedBy/deliveredRefs 绝不存储');
    fs.writeFileSync(path.join(R2, 'applications.json'), JSON.stringify([
      { id: '2026-09-25-000000-001', company: '乙公司', role: '岗B', docId: 'jdoc', status: '已投递' }
    ]));
    exPage = await (await fetch(B + '/export?id=exdoc')).text();
    if (exPage.includes('甲公司')) fail('② applications.json 编辑后 usedBy 应随之消失');

    // RFC 5987 filename* ext-value：encodeURIComponent 之外还需百分号编码 !'()*（Task 4 review Minor-1 carry-in 修复）
    fs.writeFileSync(path.join(R2, 'docs', 'rfc.html'), '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body><h1>测试!\'()*名</h1><div class="sheet"><p>R</p></div></body></html>');
    const rPdf = await fetch(B + '/pdf?id=rfc');
    const cd = rPdf.headers.get('Content-Disposition') || '';
    if (rPdf.status !== 200) fail('② /pdf 含特殊字符文件名应 200: ' + rPdf.status);
    if (!cd.includes("filename*=UTF-8''")) fail('② 应含 RFC5987 filename*: ' + cd);
    if (!/%21%27%28%29/.test(cd)) fail("② ext-value 应编码 !'()*（!'() → %21%27%28%29）: " + cd);
    if (/'|\(|\)|!/.test(cd.split("filename*=UTF-8''")[1] || 'x')) fail('② ext-value 不得残留未编码的 !\'(): ' + cd);
    console.log('✅ S1-F-② 派生可投递三条件（flow/冲突/stale）+ 改稿降级 + 兼容读不写回 + usedBy/deliveredRefs 随 applications.json 即时派生（绝不存储）+ exports 幂等键（重复 POST 单记录、新身份新记录、GET/render 不记）+ RFC5987 ext-value 编码 !\'()*');
  } finally {
    srv.kill('SIGKILL');
    await sleep(50);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
EOF

# —— S1-FW：终审横切修复波回归（F-1 duplicate 继承剥离 / F-2 restructure 保留 schemaVersion / F-4 启动恢复与外锁互斥）——
# 隔离：全程 mktemp 根 + 隔离端口 + 假渲染器 + 假 LLM（本机 HTTP），零接触真实 docs/snapshots/pdfs/JSON/config。
node --input-type=module << 'EOF'
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { spawn } from 'node:child_process';
import { assembleTemplate } from './template.mjs';
import { runMigration } from './migrate-meta.mjs';
const fail = (m) => { console.error('❌ S1-FW ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's1fw-'));
const CSS = '\n.sheet{color:#111}\n';
const doc = (id, body) => '<!doctype html>\n<html><head>\n<meta charset="utf-8">\n<style>' + CSS + '</style>\n</head>\n<body>\n<h1>' + id + '</h1>\n<div class="sheet"><p>' + body + '</p></div>\n</body></html>\n';
const seedRoot = (name, docs, meta) => {
  const r = path.join(tmp, name);
  for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, 'docs-meta.json'), JSON.stringify(meta || {}));
  fs.writeFileSync(path.join(r, 'applications.json'), '[]');
  fs.writeFileSync(path.join(r, 'materials.json'), '[]');
  for (const [did, html] of Object.entries(docs || {})) fs.writeFileSync(path.join(r, 'docs', did + '.html'), html);
  return r;
};
const readMeta = (r) => JSON.parse(fs.readFileSync(path.join(r, 'docs-meta.json'), 'utf8'));
// 假渲染器：旁车 <out>.env.json 透传 RESUME_RENDER_INPUT_ID（与真实 render.mjs 同契约；POST /export 名实校验依赖它）
const fr = path.join(tmp, 'fake-render.sh');
fs.writeFileSync(fr, '#!/bin/bash\nshift\nif [ "$1" = "--src" ]; then out="$4"; else out="$RESUME_ROOT/pdfs/$1.pdf"; fi\nmkdir -p "$(dirname "$out")"\nprintf "%%PDF-1.4 fake\\n" > "$out"\necho \'{"renderInputId":"\'"$RESUME_RENDER_INPUT_ID"\'","reproducible":true,"dpi":150}\' > "$out.env.json"\n');
fs.chmodSync(fr, 0o755);
// 假 LLM（OpenAI 兼容 /chat/completions）：/restructure 结构化返回固定 JSON
const LLM_CONTENT = JSON.stringify({
  name: '重构员', contact: '', intent: '测试', summary: '重构后摘要。',
  skills: [], work: [{ title: '某公司', role: '工程师', date: '2020-2024', bullets: ['做了一件事'] }],
  projects: [], education: []
});
const llmSrv = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: LLM_CONTENT } }] })); });
});
await new Promise((r) => llmSrv.listen(0, '127.0.0.1', r));
const llmBase = 'http://127.0.0.1:' + llmSrv.address().port + '/v1';
const freePort = () => new Promise((resolve, reject) => { const s = http.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
// 起隔离根服务（假渲染器注入；stderr 累积供日志断言）
async function startSrv(rootDir) {
  const port = await freePort();
  const srv = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, RESUME_ROOT: rootDir, PORT: String(port), RESUME_RENDER_BIN: fr },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let serrBuf = ''; srv.stderr.on('data', (d) => { serrBuf += d; });
  const inst = {
    srv, B: 'http://127.0.0.1:' + port,
    get serr() { return serrBuf; },
    stop: async () => { srv.kill('SIGKILL'); await sleep(50); }
  };
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 12000) { if (srv.exitCode !== null) break; try { await fetch(inst.B + '/'); up = true; break; } catch {} await sleep(80); }
  if (!up) { await inst.stop(); fail('测试服务启动失败 (root=' + path.basename(rootDir) + '): ' + inst.serr.slice(0, 500)); }
  return inst;
}
try {
  // ---------- S1-FW-1（F-1）：/duplicate 剥离 exports/lastRenderInputId/lastRenderAt/migration、archivedAt=null；副本 POST /export 自建记录+产物 ----------
  {
    const RID_SRC = 'aa'.repeat(20);
    const srcMeta = {
      kind: 'master', flow: 'reviewed', tag: '主', theme: 'classic', styleHash: 'deadbeef', typo: '',
      schemaVersion: 2, migration: { state: 'done', at: '2026-01-01T00:00:00.000Z', checks: {} },
      exports: [{ exportId: 'e-source-0001', snapTs: '2026-01-01-000000-000', renderInputId: RID_SRC, file: 'pdfs/history/srcdoc@' + RID_SRC + '.pdf', at: '2026-01-01T00:00:00.000Z', jobId: null, bodyHash: 'bh', pages: 1, theme: 'classic' }],
      lastRenderInputId: RID_SRC, lastRenderAt: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-02-02T00:00:00.000Z', rev: 9
    };
    const R1 = seedRoot('fw1', { srcdoc: doc('srcdoc', 'S-V1') }, { srcdoc: JSON.parse(JSON.stringify(srcMeta)) });
    const s1 = await startSrv(R1);
    try {
      const rDup = await fetch(s1.B + '/duplicate?id=srcdoc&to=copy1', { method: 'POST', redirect: 'manual' });
      if (![302, 303].includes(rDup.status)) fail('FW-1 /duplicate 应 3xx，实际 ' + rDup.status + '（' + (await rDup.text().catch(() => '')).slice(0, 200) + '）');
      const m = readMeta(R1);
      const c = m.copy1 || null;
      if (!c) fail('FW-1 副本未登记 meta');
      for (const k of ['exports', 'lastRenderInputId', 'lastRenderAt', 'migration']) {
        if (Object.prototype.hasOwnProperty.call(c, k)) fail('FW-1 副本不应继承 ' + k + ': ' + JSON.stringify(c[k]));
      }
      if (c.archivedAt !== null) fail('FW-1 副本 archivedAt 应重置为 null: ' + JSON.stringify(c.archivedAt));
      // 内容维度按既有继承契约保留
      if (c.theme !== 'classic') fail('FW-1 副本 theme 应继承 classic: ' + JSON.stringify(c.theme));
      if (c.kind !== 'master' || c.flow !== 'reviewed' || c.tag !== '主') fail('FW-1 副本应继承 kind/flow/tag: ' + JSON.stringify(c));
      if (typeof c.styleHash !== 'string' || !c.styleHash) fail('FW-1 副本应登记 styleHash: ' + JSON.stringify(c.styleHash));
      if (typeof c.typo !== 'string') fail('FW-1 副本 typo 应为字符串（归一化结果）: ' + JSON.stringify(c.typo));
      if (c.schemaVersion !== 2) fail('FW-1 副本应继承 schemaVersion=2（正文为当前格式归一化产物）: ' + JSON.stringify(c.schemaVersion));
      if (c.rev !== 1) fail('FW-1 副本 rev 应重置 1: ' + JSON.stringify(c.rev));
      if (JSON.stringify(m.srcdoc) !== JSON.stringify(srcMeta)) fail('FW-1 源文档 meta 不应变化: ' + JSON.stringify(m.srcdoc));
      // 副本 POST /export：创建自己的记录 + 自己的不可变文件（绝不复用继承记录、绝不产生无记录孤儿文件）
      const pEx = await (await fetch(s1.B + '/export?id=copy1', { method: 'POST' })).json();
      if (!pEx.ok || !pEx.exportId) fail('FW-1 副本 POST /export 应成功并返回 exportId: ' + JSON.stringify(pEx));
      if (pEx.exportId === 'e-source-0001' || pEx.reused === true) fail('FW-1 副本导出不允许复用源文档继承记录: ' + JSON.stringify(pEx));
      const m2 = readMeta(R1);
      const exList = (m2.copy1 || {}).exports || [];
      if (exList.length !== 1) fail('FW-1 副本 exports 应恰有 1 条自己的记录: ' + exList.length + ' ' + JSON.stringify(exList.map((e) => e.exportId)));
      const rec0 = exList[0] || {};
      if (rec0.exportId !== pEx.exportId || rec0.renderInputId !== pEx.renderInputId) fail('FW-1 副本记录应与本次响应一致: ' + JSON.stringify(rec0));
      const own = fs.readdirSync(path.join(R1, 'pdfs', 'history')).filter((f) => f.startsWith('copy1@'));
      if (own.length !== 1) fail('FW-1 副本应恰有 1 个不可变产物: ' + own.join(','));
      if (rec0.file !== 'pdfs/history/' + own[0]) fail('FW-1 记录 file 应指向副本自己的产物: ' + JSON.stringify(rec0.file) + ' vs ' + own[0]);
      if (!fs.existsSync(path.join(R1, rec0.file))) fail('FW-1 记录指向的产物文件应存在: ' + rec0.file);
      const srcEx = (m2.srcdoc || {}).exports || [];
      if (srcEx.length !== 1 || srcEx[0].exportId !== 'e-source-0001') fail('FW-1 源文档 exports 不应受影响: ' + JSON.stringify(srcEx.map((e) => e.exportId)));
    } finally { await s1.stop(); }
    console.log('✅ S1-FW-1（F-1）/duplicate 剥离 exports/lastRenderInputId/lastRenderAt/migration + archivedAt=null + theme/styleHash/typo/kind/flow 继承；副本 POST /export 自建记录与产物文件');
  }
  // ---------- S1-FW-2（F-2）：/restructure 保留既有 schemaVersion（矛盾态消除）；migrate-meta 重跑 no-op ----------
  {
    const deg = assembleTemplate('classic')
      .replaceAll('{{NAME}}', () => '降级员').replaceAll('{{CONTACT}}', () => '').replaceAll('{{INTENT}}', () => '')
      .replaceAll('{{SUMMARY}}', () => '以下为 PDF 提取的原文（待整理）：').replaceAll('{{SKILLS}}', () => '')
      .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => '<div class="plain-lines"><p style="white-space:pre-wrap">原始文本行</p></div>')
      .replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => 'deg');
    const R2 = seedRoot('fw2', { deg }, {
      deg: { schemaVersion: 2, migration: { state: 'done', at: '2026-01-01T00:00:00.000Z', checks: {} }, theme: 'legacy', styleHash: 'old-hash', typo: 'h1{color:blue}' }
    });
    fs.writeFileSync(path.join(R2, 'config.json'), JSON.stringify({ active: 0, profiles: [{ name: 't', baseURL: llmBase, apiKey: 'k123456', model: 'm' }] }));
    const s2 = await startSrv(R2);
    try {
      const rRe = await fetch(s2.B + '/restructure?id=deg', { method: 'POST', redirect: 'manual' });
      if (![302, 303].includes(rRe.status)) fail('FW-2 /restructure 应 3xx，实际 ' + rRe.status + '（' + (await rRe.text().catch(() => '')).slice(0, 200) + '）');
      const md = readMeta(R2).deg || {};
      if (md.schemaVersion !== 2) fail('FW-2 已迁移文档 restructure 后 schemaVersion 应保持 2（不得回写 1 造成 1+migration.done 矛盾态）: ' + JSON.stringify(md.schemaVersion));
      if (!md.migration || md.migration.state !== 'done') fail('FW-2 migration.state 应保持 done（与 schemaVersion=2 一致）: ' + JSON.stringify(md.migration));
      if (md.theme !== 'classic' || typeof md.styleHash !== 'string' || !md.styleHash) fail('FW-2 restructure 仍应重登记 classic 主题: ' + JSON.stringify({ t: md.theme, h: md.styleHash }));
    } finally { await s2.stop(); }
    // migrate-meta 重跑 = no-op：无 pending、不备份、不跑门禁、docs-meta 字节不变
    const before = fs.readFileSync(path.join(R2, 'docs-meta.json'), 'utf8');
    const mockCheckers = {
      renderPdf: async (src, out) => { fs.writeFileSync(out, '%PDF-1.4 mock\n'); return true; },
      pdftotext: () => 'MOCK-TEXT', pdfinfoPages: () => 1,
      comparePdfs: () => ({ pass: true, max: 0, pages: [{ page: 1, ratio: 0 }], dpi: 150, threshold: 0.005, pixFmt: 'rgb24' })
    };
    const rep = await runMigration(R2, { checkers: mockCheckers });
    if (!rep.ok) fail('FW-2 migrate-meta 重跑应成功: ' + JSON.stringify(rep.stopped));
    if (rep.backup !== null) fail('FW-2 无 pending 不应备份（no-op）: ' + JSON.stringify(rep.backup));
    if ((rep.docs || []).length !== 0) fail('FW-2 不应有待迁文档: ' + JSON.stringify(rep.docs));
    if (fs.readFileSync(path.join(R2, 'docs-meta.json'), 'utf8') !== before) fail('FW-2 重跑不得改动 docs-meta');
    console.log('✅ S1-FW-2（F-2）/restructure 于 schemaVersion=2 文档保持 2 且 migration 保持 done；migrate-meta 重跑 no-op（不备份/不门禁/零写入）');
  }
  // ---------- S1-FW-4（F-4）：启动恢复与外来 .migrate.lock 互斥（外锁在 → 跳过；无外锁 → 恢复如常） ----------
  {
    const R4 = seedRoot('fw4', { tdoc: '<!doctype html><html><head></head><body>NEW-SAVED</body></html>' }, { tdoc: { rev: 7 } });
    // txId 用前缀+时戳构造（文件内不出现 11 连数字字面量，避免隐私门禁手机号模式自命中——S1-9 假号码红改同款纪律）
    const txId = 's1fw4-' + Date.now() + '-424242';
    const txd = path.join(R4, '.tx');
    fs.mkdirSync(txd, { recursive: true });
    // 手工种"中断保存"事务：标记 + 旧 meta 副本 + 旧正文副本（载荷齐 = 可恢复记录）
    fs.writeFileSync(path.join(txd, txId + '.meta.json'), JSON.stringify({ rev: 5, tag: 'old' }));
    fs.writeFileSync(path.join(txd, txId + '.html'), '<!doctype html><html><head></head><body>OLD-BYTES</body></html>');
    fs.writeFileSync(path.join(txd, txId + '.json'), JSON.stringify({ txId, docId: 'tdoc', phase: 'save', oldSnapTs: '', startedAt: Date.now() - 60000, host: os.hostname(), pid: 424242 }));
    const docFile = path.join(R4, 'docs', 'tdoc.html');
    const txFiles = () => fs.readdirSync(txd);
    // (a) 外来活进程持 .migrate.lock → 启动必须跳过恢复：文档不回滚、记录原样、锁不被代删、日志留痕
    const sleeper = spawn('sleep', ['60']);
    fs.writeFileSync(path.join(R4, '.migrate.lock'), JSON.stringify({ pid: sleeper.pid, host: os.hostname(), startedAt: Date.now() }));
    const s4a = await startSrv(R4);
    try {
      if (!fs.readFileSync(docFile, 'utf8').includes('NEW-SAVED')) fail('FW-4a 外来锁在持时启动不得回滚文档（迁移可能正处门禁中途）');
      if (txFiles().length !== 3) fail('FW-4a tx 记录应原样保留给持有者/下次干净启动: ' + txFiles().join(','));
      if (!fs.existsSync(path.join(R4, '.migrate.lock'))) fail('FW-4a 不得删除外来鲜活锁');
      if (!s4a.serr.includes('跳过启动恢复')) fail('FW-4a 跳过应留日志: ' + s4a.serr.slice(0, 300));
    } finally { await s4a.stop(); sleeper.kill('SIGKILL'); }
    // (b) 无外来锁 → 启动恢复如常（回滚目标文档 + 清记录 + 日志）
    fs.rmSync(path.join(R4, '.migrate.lock'), { force: true });
    const s4b = await startSrv(R4);
    try {
      if (!fs.readFileSync(docFile, 'utf8').includes('OLD-BYTES')) fail('FW-4b 无锁时启动恢复应回滚文档: ' + fs.readFileSync(docFile, 'utf8').slice(0, 100));
      if (txFiles().length !== 0) fail('FW-4b 恢复成功后记录应清理: ' + txFiles().join(','));
      if ((readMeta(R4).tdoc || {}).rev !== 5) fail('FW-4b meta 应回滚到事务前副本: ' + JSON.stringify(readMeta(R4).tdoc));
      if (!s4b.serr.includes('启动恢复未完成事务 1 条')) fail('FW-4b 应有恢复日志: ' + s4b.serr.slice(0, 300));
    } finally { await s4b.stop(); }
    console.log('✅ S1-FW-4（F-4）外来活 pid .migrate.lock → 启动跳过恢复（记录原样/文档不回滚/留日志）；无锁时恢复行为不变');
  }
} finally {
  llmSrv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
EOF

# —— S1-FW-3（F-3）：隐私门禁忽略清单 — .tx 载荷/双锁/atomicWrite 残留必须被忽略，真·未跟踪敏感文件仍被检出 ——
# 探针文件种在真实根（皆本节新建、trap 移除）；零写入真实 docs/snapshots/pdfs/JSON/config。
# 假手机号用拼接构造（本文件不出现 11 连字面量，避免门禁自命中——S1-9 假号码红改同款纪律）。
(
  S1FW_PHONE='1380013'
  S1FW_PHONE="${S1FW_PHONE}8000"
  S1FW_TX='.tx/s1fw-privacy-probe.html'
  S1FW_NOTE='s1fw-sensitive-probe.txt'
  s1fw_clean() { rm -f "$S1FW_TX" "$S1FW_NOTE"; }
  trap s1fw_clean EXIT
  mkdir -p .tx
  printf '<html><body>phone %s</body></html>\n' "$S1FW_PHONE" > "$S1FW_TX"
  if ! bash privacy-check.sh > /dev/null 2>&1; then echo '❌ S1-FW-3 .tx/ 中断事务载荷未被忽略（隐私门禁应绿）'; exit 1; fi
  printf 'phone %s\n' "$S1FW_PHONE" > "$S1FW_NOTE"
  if bash privacy-check.sh > /dev/null 2>&1; then echo '❌ S1-FW-3 真·未跟踪敏感文件未被检出（门禁应红）'; exit 1; fi
  rm -f "$S1FW_NOTE"
  # 锁与 atomicWrite 残留：模式生效性与文件存在无关 → check-ignore 直接探针（防 .gitignore 模式被误删）
  for p in .migrate.lock .meta.lock .docs-meta.json.0.0.0.tmp; do
    if ! git check-ignore -q "$p"; then echo "❌ S1-FW-3 未忽略: $p"; exit 1; fi
  done
  s1fw_clean
  trap - EXIT
  echo '✅ S1-FW-3（F-3）隐私门禁：.tx 载荷/双锁/原子写残留全忽略（门禁绿），真·未跟踪敏感文件仍检出（门禁红）'
)

# —— S2-B1：应用页面设计变量统一（server.mjs 字面色 / 冷色黑名单 / 路由集合不变）——
echo "── S2-B1: 应用页面设计变量统一（server.mjs 字面色 / 冷色黑名单 / 路由集合不变）──"
node --input-type=module << 'EOF'
import fs from 'node:fs';
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const F = 'server.mjs';
const ALLOW_DECL = /\/\*A-VARS\*\/:root\{/;            // 允许出现 hex 的行 = token 声明行
const ALLOW_FAVICON = /favicon/;                          // S4a-T11 登记：favicon 独立资产品牌色（非页面 CSS）
const HEX = /#[0-9a-fA-F]{3,8}\b/;
fs.readFileSync(F, 'utf8').split('\n').forEach((ln, i) => {
  if (HEX.test(ln) && !ALLOW_DECL.test(ln) && !ALLOW_FAVICON.test(ln)) fail(`${F}:${i + 1} 组件层残留字面色: ${ln.trim().slice(0, 90)}`);
});
// 冷色/靛蓝黑名单：任何位置（含声明行）都不得出现
const COLD = /#F4F5F8|#202737|#697186|#DCE0E8|#5B5DE8|#EEEFFE|#409eff|#2563eb|#dbeafe|#ede9fe|#5b21b6|--indigo/i;
fs.readFileSync(F, 'utf8').split('\n').forEach((ln, i) => {
  if (COLD.test(ln)) fail(`${F}:${i + 1} 冷色/靛蓝残留: ${ln.trim().slice(0, 90)}`);
});
// 路由集合不变（任何新增 pathname 字面量都会红）。初值 = S2 开工前实测冻结的 54 个字面量；S4a-T10 登记 /export/layout-apply、S4a-T11 登记 /favicon.ico（56，登记非放宽）
const sm = fs.readFileSync(F, 'utf8');
const ROUTES_FROZEN = ['/','/ai-panel.js','/ai/chat','/ai/jd-text','/ai/match','/ai/prep','/ai/review','/ai/rewrite','/ai/test',
  '/ai/zone-analyze','/ai/zone-rewrite',
  '/api/extract','/app','/app/add','/app/archive-regenerate','/app/del','/app/ics','/app/jd','/app/update','/applications',
  '/archive','/archive-pdf','/backup','/delete','/diff','/duplicate','/edit','/editor-shell.js','/export','/history-pdf',
  '/job-panel.js','/job/brief','/job/changes','/job/create','/job/generate','/job/gen-cancel','/job/gen-start','/link','/mat/add','/mat/confirm','/mat/del','/mat/update','/export/layout-apply','/favicon.ico',
  '/materials','/new','/pdf','/render','/restore','/restore/undo','/restructure','/rollback','/save','/settings',
  '/snapshot/baseline','/snapshot/note','/snapshot/pdf','/snapshot/view','/snapshots','/stats','/tag','/version/create',
  '/zones','/zones/init','/zone-panel.js'].sort();
const got = [...new Set([...sm.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]))].sort();
const missing = ROUTES_FROZEN.filter((r) => !got.includes(r));
const extra = got.filter((r) => !ROUTES_FROZEN.includes(r));
if (missing.length || extra.length) fail(`路由集合变化 missing=${missing} extra=${extra}`);
console.log('✅ S2-B1 server.mjs 设计变量统一 + 路由集合不变');
EOF

# —— S2-A：注入层纪律（编辑器外壳注入 CSS 的边界护栏；S2 全程生效）——
echo "── S2-A: 注入层纪律（仅屏幕 / 不声明正文文字属性 / !important 不增）+ print 仍在 + themes 零改动 ──"
S2_BASE=5208e44
git diff --quiet "$S2_BASE" -- themes/ || { echo "❌ themes/ 被改动（S2 全程禁止）"; git diff --stat "$S2_BASE" -- themes/; exit 1; }
grep -qF '@media print { .edit-toolbar, .page-line, .toast, .recovery-bar { display: none !important; } }' themes/resume-classic.css \
  || { echo '❌ 主题的 print 隐藏行被删改（冻结件必须自带打印隐藏规则）'; exit 1; }
node --input-type=module << 'EOF'
import fs from 'node:fs';
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const IMPORTANT_BASELINE = 4;          // 实测现状：editor-shell.js :162、:173（两处）、:197
const src = fs.readFileSync('editor-shell.js', 'utf8');
const screenOpen = src.indexOf("'@media screen{'");
if (screenOpen < 0) fail('editor-shell.js 缺少 @media screen 注入块');
const injectEnd = src.indexOf('document.head.appendChild(css)');
if (injectEnd < 0) fail('找不到注入块收尾锚点 document.head.appendChild(css)');
const injected = src.slice(screenOpen, injectEnd);
// print 段由多个 JS 字面量拼成。旧写法 /@media print\{([\s\S]*?)\}'/ 非贪婪、止步于第一个 }'，
// 只看到隐藏段；⌘P 还原段（background:var(--ed-panel)/box-shadow:none/margin:0）从未进入任何检查，
// 而 .sheet 禁令又把注入段切在 '@media print{ 之前 —— 还原字面量两头落空。
// 现在把 print 的全部字面量拼回真实 CSS，两项检查都覆盖 print 全量。
const PRINT_ANCHOR = "'@media print{";
const printOpen = injected.indexOf(PRINT_ANCHOR);
if (printOpen < 0) fail('editor-shell.js 缺少 @media print 块');
const printCss = [...injected.slice(printOpen).matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
if (!printCss.startsWith('@media print{') || !printCss.endsWith('}')) {
  fail('print 注入 CSS 拼接形状异常（不是单个完整 @media print 块，需修断言）: ' + printCss.slice(0, 140));
}
// print 段对 .sheet 的"还原"白名单（第 2 项正文禁令专用，独立登记：即使有人日后扩了下面的
// PRINT_ALLOW，也不能把正文文字属性夹带进 print 的 .sheet 规则里绕过禁令）
const PRINT_SHEET_RESTORE = new Map([
  ['.ed-on .sheet', ['overflow:visible', 'height:auto', 'box-shadow:none', 'margin:0']]
]);
// 1) @media print 块只准"隐藏 + 还原"：选择器与声明逐字登记，任何未登记项（含颜色/背景/边框/阴影）一律红。
//    逐字白名单严于原先的黑名单正则（黑名单只排除已知视觉属性，白名单要求每条声明都被显式登记）。
const PRINT_ALLOW = new Map([
  ['#ed-left,#ed-right,#ed-status,#ed-canvas-tools,#ed-seltb,#ed-matpop,#ed-matmask', ['display:none!important']],
  ['body.ed-on', ['display:block', 'height:auto', 'overflow:visible', 'background:var(--ed-panel)']],
  ...PRINT_SHEET_RESTORE
]);
const VISUAL_DECL = /^(?:color|background|background-color|border(?:-[a-z]+)*|box-shadow|font(?:-[a-z]+)*|line-height|letter-spacing|text-[a-z-]+)\s*:/;
const printInner = printCss.slice('@media print{'.length, -1);
const printRules = [...printInner.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
if (!printRules.length) fail('print 块未解析出任何规则（断言正则失效，需修断言）');
let printDecls = 0;
printRules.forEach((m) => {
  const sel = m[1].trim();
  const allow = PRINT_ALLOW.get(sel);
  if (!allow) fail(`注入层 @media print 含未登记选择器（print 只准隐藏/还原，新增须逐字登记）: ${sel.slice(0, 120)}`);
  m[2].split(';').map((d) => d.trim()).filter(Boolean).forEach((d) => {
    printDecls++;
    if (!allow.includes(d)) fail(`注入层 @media print 含${VISUAL_DECL.test(d) ? '视觉规则' : '未登记声明'}（print 只准隐藏/还原）: ${sel}{${d.slice(0, 100)}}`);
  });
});
// 解析完整性：白名单判定必须吃掉 print 全文，残留即说明断言正则漏看了内容（正是本轮修复的那个洞）
const printResidual = printRules.reduce((acc, m) => acc.replace(m[0], () => ''), printInner).trim();
if (printResidual) fail('print 块存在未被断言解析到的残留内容（需修断言）: ' + printResidual.slice(0, 140));
// 2) 正文文字属性禁令（作用域 = .sheet 及其后代）；布局/滚动/阴影/outline/caret 不受限
//    扫描范围 = 屏幕注入段 + print 段全量（print 段用同一 FORBID，只放行还原白名单里逐字登记的声明）
const FORBID = /(?:^|;)\s*(color|font-family|font-size|font-weight|font-style|line-height|letter-spacing|text-align|text-decoration|text-transform|text-indent|background|background-color|margin|margin-[a-z]+|padding|padding-[a-z]+)\s*:/;
// FORBID 按选择器分级（控制器裁决）：后代选择器保持全量禁令；裸 .sheet 只禁文字属性与背景，放行纸张框架盒属性（margin/padding/box-shadow/width/height/overflow/outline/caret/transition/grid-*/justify-self）。
// 依据：.sheet 是外壳负责定位/滚动的纸张容器，文档排版住在后代与主题里；注入仅 @media screen，打印输出不可能变化，§7.4 像素等价是兜底。
const FORBID_BARE_SHEET = /(?:^|;)\s*(color|font|font-[a-z]+|line-height|letter-spacing|text-[a-z-]+|background|background-color)\s*:/;
const printAnchor = injected.indexOf(PRINT_ANCHOR);
const screenInjected = printAnchor >= 0 ? injected.slice(0, printAnchor) : injected;
// 屏幕段与 print 臂同款"全量字面量拼接"重建真实 CSS —— 逐字面量正则看不见跨字面量的规则
// （实测盲区：editor-shell.js:64-65 的 .ed-on .sheet{…margin:0 0 16px;' + 'box-shadow:…} 两段拼接）。
const screenCss = [...screenInjected.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
if (!screenCss.startsWith('@media screen{') || !screenCss.endsWith('}')) {
  fail('屏幕注入 CSS 拼接形状异常（不是单个完整 @media screen 块，需修断言）: ' + screenCss.slice(0, 140));
}
if ((screenCss.match(/\{/g) || []).length !== (screenCss.match(/\}/g) || []).length) {
  fail('屏幕注入 CSS 拼接后花括号不平衡（字面量配对被破坏，需修断言）');
}
// 展平取最内层规则（@media 嵌套的前奏因内含 { 不会误配成规则）；选择器含 .sheet 的规则全部受禁令约束
const sheetRules = [...screenCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].includes('.sheet'));
if (!sheetRules.length) fail('注入层未匹配到任何 .sheet 规则（断言正则失效，需修断言）');
// 裸 .sheet 判定：选择器列表中每个含 .sheet 的部分都以 .sheet（可带伪类）结尾
const isBareSheetSel = (sel) => sel.split(',').map((s) => s.trim()).filter((s) => s.includes('.sheet'))
  .every((s) => /\.sheet(?:::[a-zA-Z-]+(?:\([^)]*\))?)*$/.test(s));
sheetRules.forEach((m) => {
  const sel = m[1].trim().replace(/\s+/g, ' ');
  const decls = m[2].replace(/caret-color|outline-color/g, 'editorHintOnly');
  const forbid = isBareSheetSel(sel) ? FORBID_BARE_SHEET : FORBID;
  if (forbid.test(decls)) fail(`注入层对 ${sel} 声明了正文文字属性: ${m[2].slice(0, 140)}`);
});
// 2b) print 段的 .sheet 规则同样受正文禁令约束（摘掉还原白名单后仍有 FORBID 属性即红）
const printSheetRules = printRules.filter((m) => m[1].includes('.sheet'));
if (!printSheetRules.length) fail('print 段未匹配到任何 .sheet 还原规则（断言正则失效，需修断言）');
printSheetRules.forEach((m) => {
  const sel = m[1].trim();
  const allow = PRINT_SHEET_RESTORE.get(sel) || [];
  const rest = m[2].split(';').map((d) => d.trim()).filter((d) => d && !allow.includes(d)).join(';');
  if (FORBID.test(rest)) fail(`注入层 @media print 对 ${sel} 声明了正文文字属性: ${rest.slice(0, 140)}`);
});
// 3) !important 只准持平基线（新增覆盖必须靠 .ed-on 特异性）
const imp = (injected.match(/!important/g) || []).length;
if (imp > IMPORTANT_BASELINE) fail(`注入层 !important 由基线 ${IMPORTANT_BASELINE} 增至 ${imp}（新增规则请靠特异性覆盖）`);
console.log(`✅ S2-A 注入层纪律通过（.sheet 规则 ${sheetRules.length}+${printSheetRules.length}(print) 条 / print 规则 ${printRules.length} 条 ${printDecls} 项声明全在白名单 / !important ${imp} ≤ ${IMPORTANT_BASELINE} / themes 未动 / print 规则仍在）`);
EOF

# —— S2-B2：编辑器与面板设计变量统一（三个注入文件字面色 / 冷色黑名单）——
echo "── S2-B2: 编辑器与面板设计变量统一（三个注入文件字面色 / 冷色黑名单）──"
node --input-type=module << 'EOF'
import fs from 'node:fs';
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
// S3-T4 登记：zone-panel.js 入列（其 8 条 hsla 区域色带不走 hex 形态，HEX/COLD 扫描天然不命中，无需逐条排除）
const FILES = { 'editor-shell.js': [/body\.ed-on\{--ed-/], 'ai-panel.js': [], 'job-panel.js': [], 'zone-panel.js': [] };
const HEX = /#[0-9a-fA-F]{3,8}\b/;
for (const [f, allow] of Object.entries(FILES)) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((ln, i) => {
    if (HEX.test(ln) && !allow.some((re) => re.test(ln))) fail(`${f}:${i + 1} 组件层残留字面色: ${ln.trim().slice(0, 90)}`);
  });
}
// 冷色黑名单：hex 家族 + 冷色 rgba 家族（修复轮2 起）。rgba(37,50,75/41,48,80/24,27,48,·) 是蓝灰阴影、rgba(32,39,55,·) 是蓝灰遮罩，
// hex-only 黑名单扫不到 rgba 形态（实测漏网：editor-shell.js 旧 :65 box-shadow rgba(37,50,75,.08)）；暖阴影家族 = rgba(60,45,25,·)（同 server.mjs --shadow）。
const COLD = /#F4F5F8|#202737|#697186|#DCE0E8|#5B5DE8|#EEEFFE|#409eff|#2563eb|#dbeafe|#ede9fe|#5b21b6|--indigo|rgba\(37,50,75,|rgba\(41,48,80,|rgba\(24,27,48,|rgba\(32,39,55,/i;
for (const f of Object.keys(FILES)) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((ln, i) => {
    if (COLD.test(ln)) fail(`${f}:${i + 1} 冷色/靛蓝残留: ${ln.trim().slice(0, 90)}`);
  });
}
console.log('✅ S2-B2 编辑器与面板设计变量统一');
EOF

# —— S3-A：zid 纪律（打点单位 / 幂等 / 去重 / section-title 不打）——
echo "── S3-A: zid 纪律 ──"
node --input-type=module << 'EOF'
import { normalizeZids, zidsOf, parasOf } from './zone.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S3-A ' + m); process.exit(1); } };
const doc = '<div class="sheet"><div class="contact">张三 test@x.com</div><section class="section"><div class="section-title">工作经历</div><p>段落一</p><ul><li>要点A</li></ul><h3>标题行</h3></section></div>';
const a = normalizeZids(doc);
assert(zidsOf(a).length === 4, 'p/li/h3/contact 四个打点单位');
assert(!/section-title[^>]*data-zid/.test(a), 'section-title 不打点');
const b = normalizeZids(a);
assert(a === b, '归一幂等');
const dup = '<p data-zid="z11111111">A</p><p data-zid="z11111111">B</p>';
const dedup = normalizeZids(dup);
const got = zidsOf(dedup);
assert(got.length === 2 && got[0] === 'z11111111', '重复 zid 保首重打');
assert(parasOf(dedup).every(p => p.text.length > 0), 'parasOf 出文本');
const up = normalizeZids('<DIV class="x">a</DIV><DIV class="contact">b</DIV>');
assert(!/class="x"[^>]*data-zid/.test(up), '大写 DIV 普通层不打点');
assert(/class="contact"[^>]*data-zid/.test(up), '大写 DIV contact 照常打点');
const bad = normalizeZids('<p data-zid="bad">x</p>');
assert(!/data-zid="bad"/.test(bad) && (bad.match(/data-zid="/g) || []).length === 1, '坏 zid 值按缺失重打（不双属性）');
const nest = '<ul><li data-zid="zb2222222">parent<ul><li data-zid="zc3333333">child</li></ul></li></ul>';
const ps = parasOf(nest);
assert(ps.length === 1 && ps[0].text.includes('parent') && ps[0].text.includes('child'), '嵌套单位外层吞内层（text 合并）');
assert(zidsOf(nest).length === 2, '嵌套单位内外层 zid 都登记');
console.log('✅ S3-A zid 纪律');
EOF

# —— S3-B：区域纯函数（启发式 / zoneSync / 8 类枚举）——
echo "── S3-B: 区域纯函数 ──"
node --input-type=module << 'EOF'
import { guessZone, zoneSync, ZONE_KEYS, normalizeZids, parasOf, parseZoneAnalysis, parseZoneRewrites, digestOf } from './zone.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S3-B ' + m); process.exit(1); } };
assert(ZONE_KEYS.join(',') === 'personal,education,work,project,skill,award,summary,other', '8 类枚举');
assert(guessZone('工作经历') === 'work' && guessZone('项目经历') === 'project', '章节映射');
assert(guessZone('个人总结') === 'summary', '个人总结→summary（先于 personal 匹配）');
assert(guessZone('个人信息') === 'personal' && guessZone('获奖荣誉') === 'award' && guessZone('乱七八糟') === 'other', '其余映射');
const doc = '<div class="sheet"><section class="section"><div class="section-title">项目经历</div><p data-zid="za1111111">项目段落</p></section></div>';
const m1 = zoneSync(doc, {});
assert(m1.zones.za1111111.zone === 'project' && m1.zones.za1111111.status === 'pending', '新 zid 补 pending+启发式');
const m2 = zoneSync(doc, m1);
assert(m2.zones.za1111111.status === 'pending', '同步幂等');
const m3 = zoneSync(doc, { zones: { za1111111: { zone: 'work', status: 'confirmed' }, zdead9999: { zone: 'work', status: 'confirmed' } } });
assert(m3.zones.za1111111.zone === 'work' && m3.zones.za1111111.status === 'confirmed', '同步不改已有归属/状态');
assert(!('zdead9999' in m3.zones), '正文不存在的 zid 清理');
const titleZid = '<div class="sheet"><section class="section"><div class="section-title" data-zid="zd4444444">工作经历</div><p data-zid="ze5555555">正文</p></section></div>';
const mt = zoneSync(titleZid, {});
assert(!('zd4444444' in mt.zones) && mt.zones.ze5555555.zone === 'work', 'section-title 手改 zid 不进 zones');
const contactDoc = '<div class="sheet"><div class="contact" data-zid="zf6666666">张三</div><section class="section"><div class="section-title">技能</div><p data-zid="zg7777777">JS</p></section></div>';
const mc = zoneSync(contactDoc, {});
assert(mc.zones.zf6666666.zone === 'personal', 'sections 外（contact）→ personal');
// —— S3-B2：区域级 AI 纯函数（分析解析 / 改写解析 + factGuard / 全文摘要）——
const good = parseZoneAnalysis('```json\n{"echoes":["与项目经历呼应"],"reminder":"一个提醒","suggestion":"这样改","chips":["问A","问B"]}\n```');
assert(good && good.echoes.length === 1 && good.chips.length === 2, 'zone 分析解析（含代码围栏清洗）');
assert(parseZoneAnalysis('不是json') === null, '坏输出返回 null');
const rw = parseZoneRewrites('{"rewrites":[{"zid":"za1111111","candidate":"改写后"}]}', [{ zid: 'za1111111', text: '原文 800ms' }]);
assert(rw && rw.length === 1 && rw[0].zid === 'za1111111', '改写解析');
const rwBad = parseZoneRewrites('{"rewrites":[{"zid":"za1111111","candidate":"延迟降到 210ms"}]}', [{ zid: 'za1111111', text: '原文 800ms' }]);
assert(rwBad[0].level === 'conflict', '改写引入新数字 → factGuard conflict（复用 job.mjs）');
assert(digestOf('<div class="sheet"><section class="section"><div class="section-title">技能</div><p data-zid="za8777777">Go</p></section></div>').includes('【技能】Go'), 'digestOf 全文摘要含章节与文本');
console.log('✅ S3-B 区域纯函数（含 S3-B2 区域级 AI 解析）');
EOF

# —— S3-B3：素材事实层迁移（confirmed→factStatus / 幂等 / 无状态→pending+facts 置空）——
echo "── S3-B3: 素材事实层迁移 ──"
node --input-type=module << 'EOF'
import { migrateMats, FACT_KEYS } from './zone.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S3-B3 ' + m); process.exit(1); } };
assert(FACT_KEYS.join(',') === 'company,role,dates,education,metrics,contribution,conditions,source', '8 事实键');
const old1 = [{ id: 'm-1', title: 'T', brief: 'b', technical: '', interview: '', attach: '', tags: [], createdAt: '', updatedAt: '', confirmed: true }];
const mig1 = migrateMats(old1);
assert(mig1[0].factStatus === 'confirmed' && mig1[0].facts && !('confirmed' in mig1[0]), 'confirmed→factStatus 且删旧键');
assert(JSON.stringify(migrateMats(mig1)) === JSON.stringify(mig1), '迁移幂等');
const old2 = [{ id: 'm-2', title: 'T2', brief: 'b' }];
assert(migrateMats(old2)[0].factStatus === 'pending' && migrateMats(old2)[0].facts, '无状态→pending+facts 置空');
const d0 = { id: 'm-3', factStatus: 'outdated', facts: { metrics: 'x' } };
assert(migrateMats([d0])[0] === d0, '已迁移条目原样返回');
assert(JSON.stringify(migrateMats('x')) === '[]', '非数组→空数组');
console.log('✅ S3-B3 素材事实层迁移');
EOF

# —— S3-D：renderInputId 忽略 data-zid（登记偏差 pin：非视觉属性不进渲染标识；摘除须连前导空白）——
echo "── S3-D: renderInputId 忽略 data-zid ──"
node --input-type=module << 'EOF'
import { freezeHtml } from './freeze.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S3-D ' + m); process.exit(1); } };
const withZid = freezeHtml('<p data-zid="z12345678">x</p>', { typo: '' });
const noZid = freezeHtml('<p>x</p>', { typo: '' });
assert(withZid.renderInputId === noZid.renderInputId, 'renderInputId 应忽略 data-zid');
assert(withZid.html === '<p data-zid="z12345678">x</p>', '冻结 html 应逐字节保留 data-zid');
console.log('✅ S3-D renderInputId 忽略 data-zid（冻结 html 不变）');
EOF

# —— S3-C：区域注入纪律（ZONE-INJECT 对称剥离 / data-zone-panel 双防线 / 着色不落盘）——
echo "── S3-C: 区域注入纪律 ──"
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const srv = readFileSync('./server.mjs', 'utf8');
const ext = readFileSync('./extract.mjs', 'utf8');
const zp = readFileSync('./zone-panel.js', 'utf8');
const assert = (c, m) => { if (!c) { console.error('❌ S3-C ' + m); process.exit(1); } };
const stripCount = (x) => (x.match(/ZONE-INJECT/g) || []).length;
// 剥离清单必须覆盖 ZONE（注入层内容随保存落盘 = handoff §5 纪律红线）。
// 断言从「ZONE-INJECT 字面量出现 ≥3 次」改为「剥离清单含 ZONE 且走统一注释对函数」——
// 2026-10-18 stripInjections 重构把 4 处重复 replace 收成 INJECT_KINDS 循环后，字面量降到 2 处，
// 字面量计数对等价重构变红。原断言测的是写法不是行为；此处测行为（ZONE 必须被剥离）。
assert(/INJECT_KINDS\s*=\s*\[[^\]]*'ZONE'/.test(srv), '/save 剥离清单含 ZONE（对称于 /edit 的 ZONE-INJECT 注入，防注入内容随保存落盘）');
assert(srv.includes('stripInjectCommentPair'), '注入剥离走统一注释对函数');
assert(stripCount(srv) >= 2, 'ZONE-INJECT 仍有对称引用（/edit 注入侧）');
assert((srv.match(/data-zone-panel/g) || []).length >= 2, '/save 剥离 data-zone-panel 样式块（与注入对称）');
assert(ext.includes('data-zone-panel'), 'extract CHROME_MARKERS 含 data-zone-panel（第二道防线）');
assert(!/classList\.add\(['"]zone-/.test(zp), 'zone-panel 不给正文节点挂 zone class');
assert(!zp.includes('!important'), 'zone-panel 无 !important');
assert(zp.includes('CSS.highlights') && zp.includes('::highlight(zone-'), '着色走 CSS Custom Highlight API');
console.log('✅ S3-C 区域注入纪律');
EOF

# —— S4a-A：岗位适配数据层纯函数（指纹/证据解析 ID 匹配/三时态多命中/guardOps/exportChecks/状态机）——
echo "── S4a-A: 岗位适配数据层纯函数 ──"
node --input-type=module << 'EOF'
import { createHash } from 'node:crypto';
import { contentFingerprint, paraFingerprint, parseEvidence, refFresh, candidatesState,
         reviewConsistency, applyOps, guardOps, exportChecks, transitionOp } from './evidence.mjs';
import { buildJobPrompt } from './job.mjs';
import { parasOf } from './zone.mjs';
import { pageSuggestions } from './job.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4a-A ' + m); process.exit(1); } };

const mkFacts = (o) => Object.assign({ company: '', role: '', dates: '', education: '', metrics: '', contribution: '', conditions: '', source: '' }, o);
const mats = [
  { id: 'm-1', title: '订单系统', factStatus: 'confirmed', facts: mkFacts({ company: '甲公司', role: '后端工程师', metrics: 'P99 210ms' }) },
  { id: 'm-2', title: '订单系统', factStatus: 'confirmed', facts: mkFacts({ company: '乙公司', role: '前端工程师', metrics: '首屏 1.2s' }) },   // 与 m-1 同名
  { id: 'm-3', title: '风控系统', factStatus: 'pending', facts: mkFacts({ company: '丙公司', role: '风控' }) },                              // 未确认
];
const paras = [
  { zid: 'za1111111', text: '负责交易系统，P99 800ms' },
  { zid: 'zb2222222', text: '负责交易系统，P99 800ms' },   // 与 za 正文相同
  { zid: 'zc3333333', text: '项目甲：数据管道重设计' },
];

// —— 指纹：稳定 / 变化检测（facts 键序无关；para 空白归一）——
const fp1 = contentFingerprint(mats[0].facts);
assert(/^[0-9a-f]{40}$/.test(fp1), 'contentFingerprint sha1 十六进制');
assert(fp1 === contentFingerprint(mkFacts({ role: '后端工程师', company: '甲公司', metrics: 'P99 210ms' })), '指纹与 facts 键序无关');
assert(fp1 !== contentFingerprint(mkFacts({ company: '甲公司', role: '后端工程师', metrics: 'P99 211ms' })), 'facts 变化指纹必变');
const pf1 = paraFingerprint('负责交易系统，P99 800ms');
assert(pf1 === paraFingerprint('负责交易系统，P99   800ms'), 'paraFingerprint 空白归一稳定（连续空白折叠）');
assert(pf1 !== paraFingerprint('负责交易系统，P99 801ms'), '段落文本变化指纹必变');

// —— parseEvidence：ID 精确匹配（反例1 双同名素材 / 双相同正文段落 → 各归其位；title/quote 不参与）+ refId 请求前分配 + 五态校正 ——
const raw1 = JSON.stringify({ evidence: [
  { req: '高并发经验', status: 'covered', refHints: [ { type: 'mat', id: 'm-1', title: '错误引导：乙公司素材', quote: '假引文' }, { type: 'para', zid: 'za1111111' } ] },
  { req: '前端经验', status: 'covered', refHints: [ { type: 'mat', id: 'm-2' } ] },                                        // covered 无 para ref → 降 sourced
  { req: '风控经验', status: 'sourced', refHints: [ { type: 'mat', id: 'm-3' } ] },                                        // 未确认素材 → drop → todo
  { req: '乱 ID', status: 'covered', refHints: [ { type: 'mat', id: 'm-99' }, { type: 'para', zid: 'znope999' } ] },      // ID 不在集合 → drop → todo
  { req: '同名素材按 ID', status: 'sourced', refHints: [ { type: 'mat', id: 'm-2', title: '甲公司的那个' } ] },             // title 不参与 → 仍命中 m-2（乙公司）
  { req: '同文段落按 zid', status: 'covered', refHints: [ { type: 'para', zid: 'zb2222222' } ] },
  { req: '均未匹配', status: 'none', refHints: [] }
] });
const evd = parseEvidence(raw1, { gen: 2, mats, paras });
assert(Array.isArray(evd) && evd.length === 7, 'parseEvidence 返回 evidence 数组');
const e0 = evd[0];
assert(e0.id === 'e1' && e0.req === '高并发经验', '条目 id/req 保留');
assert(e0.status === 'covered', 'para ref 存在 → covered 保持');
assert(e0.refs.length === 2, '两条 refHint 都按 ID 命中');
assert(e0.refs[0].refId === 'b2r1' && e0.refs[0].type === 'mat' && e0.refs[0].id === 'm-1' && e0.refs[0].zid === null, 'mat ref 形状（refId=b<gen>r<n>）');
assert(e0.refs[0].srcStatus === 'confirmed' && e0.refs[0].hash === fp1, 'mat ref 带来源快照与 facts 指纹');
assert(e0.refs[0].title === '错误引导：乙公司素材', 'title 仅保留展示（不参与匹配）');
assert(e0.refs[1].refId === 'b2r2' && e0.refs[1].type === 'para' && e0.refs[1].zid === 'za1111111' && e0.refs[1].id === null, 'para ref 形状');
assert(e0.refs[1].hash === paraFingerprint(paras[0].text), 'para ref 带段落文本指纹');
assert(evd[1].status === 'sourced' && evd[1].refs[0].id === 'm-2', '反例5：模型 covered 无有效 para ref → 有 mat 降 sourced');
assert(evd[2].refs.length === 0 && evd[2].status === 'todo', '未确认素材不进 refs → 降 todo');
assert(evd[3].refs.length === 0 && evd[3].status === 'todo', 'ID 不在输入集合 → ref 丢弃 + 降 todo');
assert(evd[4].refs[0].id === 'm-2' && evd[4].refs[0].hash === contentFingerprint(mats[1].facts), '反例1：同名素材按 ID 各归其位（title 引导不生效）');
assert(evd[4].status === 'sourced', '仅 mat ref → sourced');
assert(evd[5].refs[0].zid === 'zb2222222', '反例1：相同正文段落按 zid 归位');
const allRefIds = evd.flatMap((e) => e.refs.map((r) => r.refId));
assert(new Set(allRefIds).size === allRefIds.length && allRefIds.every((r) => /^b2r\d+$/.test(r)), 'refId 全局唯一且批次前缀统一（跨批次隔离基础）');
assert(evd[6].status === 'none', '模型明示均未匹配 → none 保留（不降 todo）');
assert(evd.every((e) => e.note === '' && e.noteConfirmed === false), 'note/noteConfirmed 默认两维度分离');
assert(parseEvidence('不是json', { gen: 1, mats, paras }) === null, '坏输出返回 null');

// —— refFresh：validity 含 factStatus（hash 未变但取消确认也失效）——
const matRef = { type: 'mat', id: 'm-1', srcStatus: 'confirmed', hash: fp1 };
assert(refFresh(matRef, { mats }) === true, '指纹匹配且 confirmed → 有效');
assert(refFresh(matRef, { mats: mats.map((m) => m.id === 'm-1' ? { ...m, facts: mkFacts({ company: '甲公司', role: '后端工程师', metrics: 'P99 999ms' }) } : m) }) === false, 'facts 指纹变化 → 失效');
assert(refFresh(matRef, { mats: mats.map((m) => m.id === 'm-1' ? { ...m, factStatus: 'outdated' } : m) }) === false, '反例6：factStatus≠confirmed 即使 hash 未变也失效');
assert(refFresh(matRef, { mats: mats.filter((m) => m.id !== 'm-1') }) === false, '素材被删 → 失效');
const paraRef = { type: 'para', zid: 'za1111111', hash: pf1 };
assert(refFresh(paraRef, { paras }) === true, 'para 指纹匹配 → 有效');
assert(refFresh(paraRef, { paras: paras.map((p) => p.zid === 'za1111111' ? { ...p, text: '改过的段落' } : p) }) === false, 'para 文本变化 → 失效');
assert(refFresh(paraRef, { paras: paras.filter((p) => p.zid !== 'za1111111') }) === false, '段落删除 → 失效');

// —— candidatesState：三时态多命中集合（[] = ok；顺序 = 主标签优先级）——
const mkCtx = (over = {}) => Object.assign({ paras, gen: 2, evidence: evd, mats, locked: new Set() }, over);
const baseChange = { id: 'c1', status: 'pending', kind: 'replace', zid: 'za1111111', baseSnapshot: '负责交易系统，P99 800ms' };
assert(JSON.stringify(candidatesState(baseChange, mkCtx())) === '[]', '锚点未变无依赖 → ok 空集合');
assert(candidatesState({ ...baseChange, zid: 'zgone9999' }, mkCtx()).includes('anchor-gone'), 'replace 落点消失 → anchor-gone');
// add 锚点=插入容器（反例4）：容器在 → ok；新段落 zid 尚不存在不构成失效；容器删 → anchor-gone
const addChange = { id: 'c2', status: 'pending', kind: 'add', zid: 'zc3333333', after: '新增要点', baseSnapshot: '项目甲：数据管道重设计' };
assert(JSON.stringify(candidatesState(addChange, mkCtx())) === '[]', 'add 容器在 → ok（容器是锚点）');
assert(candidatesState({ ...addChange, zid: 'zgone9999' }, mkCtx()).includes('anchor-gone'), 'add 容器删 → anchor-gone');
// batch-stale：旧批次引用 ≠ 当前 evidenceGen
assert(candidatesState({ ...baseChange, evidenceRefs: ['b1r1'] }, mkCtx()).includes('batch-stale'), '旧批次 refId → batch-stale');
// ref-stale + needs-compare（依赖失效联动 → 多命中）
const staleRef = { ...baseChange, evidenceRefs: ['b2r1'] };
const staledMats = mats.map((m) => m.id === 'm-1' ? { ...m, factStatus: 'outdated' } : m);
const multiHit = candidatesState(staleRef, mkCtx({ mats: staledMats }));
assert(multiHit.includes('ref-stale'), 'mat 来源失效 → ref-stale');
assert(multiHit.includes('needs-compare'), '依赖失效 → needs-compare 联动（多命中集合）');
// 反例9：手改 + 证据失效 → consistency 含两项
const multiHit2 = candidatesState({ ...staleRef, baseSnapshot: '生成时的旧文本' }, mkCtx({ mats: staledMats }));
assert(multiHit2.includes('needs-compare') && multiHit2.includes('ref-stale') && multiHit2.length === 2, '反例9：同时手改+证据失效 → 两项全落');
assert(multiHit2[0] === 'ref-stale' || multiHit2[0] === 'needs-compare', '命中顺序按优先级表');
// needs-compare 仅候选锚点（无关段落改动不影响本候选）
const otherChanged = paras.map((p) => p.zid === 'zb2222222' ? { ...p, text: '别的段落被改了' } : p);
assert(JSON.stringify(candidatesState(baseChange, mkCtx({ paras: otherChanged }))) === '[]', '无关段落改动不触发 needs-compare（v1.4 锚点化）');
assert(candidatesState({ ...baseChange, baseSnapshot: '生成时的旧文本' }, mkCtx()).includes('needs-compare'), '锚点文本 ≠ baseSnapshot → needs-compare');
// locked-now：pending 且当前 locked（生成后加锁同样拦截）
const lockedCtx = mkCtx({ locked: new Set(['za1111111']) });
assert(candidatesState(baseChange, lockedCtx).includes('locked-now'), 'pending 候选遇锁定 → locked-now');
assert(!candidatesState({ ...baseChange, status: 'accepted', acceptedAt: 't', appliedText: 'x' }, lockedCtx).includes('locked-now'), '非 pending 不计 locked-now');
// hand-edited：accepted 后手改（回滚降级同机理）
const acc = { ...baseChange, status: 'accepted', acceptedAt: '2026-10-01T00:00:00Z', appliedText: '负责交易系统重构，P99 800ms', origText: '负责交易系统，P99 800ms' };
assert(candidatesState(acc, mkCtx()).includes('hand-edited'), 'accepted 且当前文本 ≠ appliedText → hand-edited');
assert(JSON.stringify(candidatesState({ ...acc, appliedText: acc.origText }, mkCtx())) === '[]', 'accepted 未被手改 → ok');

// —— 反例3：接受 A 不影响 B（落点外且无依赖的候选状态不变）——
const jobAB = { evidenceGen: 2, evidence: evd, changes: [
  { ...baseChange, id: 'cA' },
  { id: 'cB', status: 'pending', kind: 'replace', zid: 'zc3333333', baseSnapshot: '项目甲：数据管道重设计' }
] };
const htmlBefore = '<div class="sheet"><p data-zid="za1111111">负责交易系统，P99 800ms</p><p data-zid="zc3333333">项目甲：数据管道重设计</p></div>';
const htmlAfter = '<div class="sheet"><p data-zid="za1111111">接受 A 后的文本</p><p data-zid="zc3333333">项目甲：数据管道重设计</p></div>';
const stB1 = candidatesState(jobAB.changes[1], mkCtx({ paras: [{ zid: 'za1111111', text: '负责交易系统，P99 800ms' }, { zid: 'zc3333333', text: '项目甲：数据管道重设计' }] }));
const stB2 = candidatesState(jobAB.changes[1], mkCtx({ paras: [{ zid: 'za1111111', text: '接受 A 后的文本' }, { zid: 'zc3333333', text: '项目甲：数据管道重设计' }] }));
assert(JSON.stringify(stB1) === JSON.stringify(stB2), '反例3：接受 A 后 candidatesState(B) 不变');
void htmlBefore; void htmlAfter;

// —— reviewConsistency：正文维度逐条写 change.consistency ——
const rcJob = reviewConsistency({ ...jobAB }, '<div class="sheet"><p data-zid="za1111111">被手改过</p><p data-zid="zc3333333">项目甲：数据管道重设计</p></div>', { zones: {}, mats });
assert(Array.isArray(rcJob.changes[0].consistency) && rcJob.changes[0].consistency.includes('needs-compare'), 'reviewConsistency 逐条写 consistency（锚点已变 → needs-compare）');
assert(JSON.stringify(rcJob.changes[1].consistency) === '[]', '未变候选 consistency 为空');
assert(jobAB.changes[0].consistency === undefined, 'reviewConsistency 纯函数不改入参');

// —— applyOps：校验（operationId/changeId/action/前置/origText 锚点匹配）+ 应用 + 整份拒绝 ——
const job1 = { changes: [ { ...baseChange, after: '负责交易系统重构，P99 800ms' } ] };
const opsOk = [ { operationId: 'o-1', changeId: 'c1', action: 'accept', origText: '负责交易系统，P99 800ms' } ];
const r1 = applyOps(opsOk, job1, '<div class="sheet"><p data-zid="za1111111">负责交易系统，P99 800ms</p></div>');
assert(r1.ok === true, 'accept 校验通过');
assert(r1.job.changes[0].status === 'accepted' && r1.job.changes[0].origText === '负责交易系统，P99 800ms' && r1.job.changes[0].appliedText === '负责交易系统重构，P99 800ms' && typeof r1.job.changes[0].acceptedAt === 'string', 'accept 落 origText/appliedText/acceptedAt 快照');
assert(job1.changes[0].status === 'pending', 'applyOps 纯函数不改入参 job');
const badAnchor = applyOps([ { operationId: 'o-2', changeId: 'c1', action: 'accept', origText: '并发已改的别的文本' } ], job1, '<div class="sheet"><p data-zid="za1111111">负责交易系统，P99 800ms</p></div>');
assert(badAnchor.ok === false && badAnchor.reason && badAnchor.badOp === 'o-2', 'origText 与当前锚点不匹配 → 拒');
assert(applyOps([ { operationId: 'o-3', changeId: 'nope', action: 'accept', origText: 'x' } ], job1, '<p data-zid="za1111111">x</p>').ok === false, 'changeId 不存在 → 拒');
assert(applyOps([ { operationId: 'o-4', changeId: 'c1', action: '魔法', origText: '负责交易系统，P99 800ms' } ], job1, '<p data-zid="za1111111">负责交易系统，P99 800ms</p>').ok === false, 'action 枚举外 → 拒');
assert(applyOps([ { operationId: '', changeId: 'c1', action: 'accept', origText: '负责交易系统，P99 800ms' } ], job1, '<p data-zid="za1111111">负责交易系统，P99 800ms</p>').ok === false, 'operationId 空 → 拒');
assert(applyOps([ { operationId: 'o-5', changeId: 'c1', action: 'accept', origText: '负责交易系统，P99 800ms' }, { operationId: 'o-5', changeId: 'c1', action: 'accept', origText: '负责交易系统，P99 800ms' } ], job1, '<p data-zid="za1111111">负责交易系统，P99 800ms</p>').ok === false, '同请求内 operationId 防重');
const accJob = { changes: [ { ...baseChange, status: 'accepted', acceptedAt: 't', origText: '负责交易系统，P99 800ms', appliedText: '负责交易系统重构，P99 800ms' } ] };
assert(applyOps([ { operationId: 'o-6', changeId: 'c1', action: 'accept', origText: '负责交易系统，P99 800ms' } ], accJob, '<p data-zid="za1111111">负责交易系统，P99 800ms</p>').ok === false, '前置：非 pending 不可接受');
assert(applyOps([ { operationId: 'o-7', changeId: 'c1', action: 'revert', origText: '负责交易系统，P99 800ms' } ], job1, '<p data-zid="za1111111">负责交易系统，P99 800ms</p>').ok === false, '前置：非 accepted 不可撤回');
const lockedJob = { changes: [ { ...baseChange, after: '新文' } ] };
assert(applyOps([ { operationId: 'o-8', changeId: 'c1', action: 'accept', origText: '负责交易系统，P99 800ms' } ], lockedJob, '<p data-zid="za1111111">负责交易系统，P99 800ms</p>', { locked: new Set(['za1111111']) }).ok === false, 'locked-now 不可接受');
const goneJob = { changes: [ { ...baseChange, zid: 'zgone9999', after: '新文' } ] };
assert(applyOps([ { operationId: 'o-9', changeId: 'c1', action: 'accept', origText: 'x' } ], goneJob, '<p data-zid="za1111111">x</p>').ok === false, 'anchor-gone 不可接受');
// add 接受：容器锚点 + op.newZid 记录
const addJob = { changes: [ { ...addChange } ] };
const rAdd = applyOps([ { operationId: 'o-10', changeId: 'c2', action: 'accept', origText: '项目甲：数据管道重设计', newZid: 'z9e000001' } ], addJob, '<div class="sheet"><p data-zid="zc3333333">项目甲：数据管道重设计</p></div>');
assert(rAdd.ok === true && rAdd.job.changes[0].newZid === 'z9e000001' && rAdd.job.changes[0].status === 'accepted', 'add 接受：容器锚点校验 + newZid 记录');
// [S4a-T4] newZid 形状校验：非 z+8hex 拒收（防 normalizeZids 重打后与落账 newZid 永久错位）
const rBadZid = applyOps([ { operationId: 'o-10b', changeId: 'c2', action: 'accept', origText: '项目甲：数据管道重设计', newZid: 'BAD-ZID' } ], addJob, '<div class="sheet"><p data-zid="zc3333333">项目甲：数据管道重设计</p></div>');
assert(rBadZid.ok === false && rBadZid.badOp === 'o-10b' && /newZid/.test(rBadZid.reason || ''), 'add 接受：坏形状 newZid 拒收（' + (rBadZid.reason || '') + '）');
// add 撤回：锚点切到 newZid
const rRevertAdd = applyOps([ { operationId: 'o-11', changeId: 'c2', action: 'revert', origText: '新增要点' } ], rAdd.job, '<div class="sheet"><p data-zid="zc3333333">项目甲：数据管道重设计</p><p data-zid="z9e000001">新增要点</p></div>');
assert(rRevertAdd.ok === true && rRevertAdd.job.changes[0].status === 'pending' && rRevertAdd.job.changes[0].origText === undefined && rRevertAdd.job.changes[0].appliedText === undefined && rRevertAdd.job.changes[0].acceptedAt === undefined && rRevertAdd.job.changes[0].newZid === undefined, '撤回：清 origText/appliedText/acceptedAt/newZid 回 pending');
// 整份拒绝：两 op 第二个坏 → 第一个也不应用
const twoOps = [ { operationId: 'o-a', changeId: 'c1', action: 'accept', origText: '负责交易系统，P99 800ms' }, { operationId: 'o-b', changeId: '幽灵', action: 'accept', origText: 'x' } ];
const rTwo = applyOps(twoOps, job1, '<div class="sheet"><p data-zid="za1111111">负责交易系统，P99 800ms</p></div>');
assert(rTwo.ok === false && rTwo.badOp === 'o-b', '任一失败整份拒绝并指明坏 op');
assert(job1.changes.every((c) => c.status === 'pending'), '整份拒绝不动任何候选状态');

// —— guardOps：范围全操作 / 锁定 / hide 展开∩保留 / 受保护 token ——
const zonesMap = { za1111111: { zone: 'work', status: 'confirmed' }, zb2222222: { zone: 'work', status: 'confirmed' }, zc3333333: { zone: 'project', status: 'confirmed' }, ze1111111: { zone: 'work', status: 'confirmed' }, ze2222222: { zone: 'project', status: 'confirmed' }, 'zs-head-1': { zone: 'work', status: 'confirmed' } };
const gctx = {
  scope: 'zone:work', zones: zonesMap, locked: new Set(['zb2222222']), keepZids: new Set(['ze2222222']),
  expand: (zid) => (zid === 'zs-head-1' ? ['ze1111111', 'ze2222222'] : [zid]),
  protectedTokens: ['甲公司', '后端工程师']
};
const gOps = [
  { id: 'g1', kind: 'replace', zid: 'za1111111', before: '文本', after: '改写' },          // work 内 → 过
  { id: 'g2', kind: 'replace', zid: 'zc3333333', before: '文本', after: '改写' },          // project → 越界
  { id: 'g3', kind: 'add', zid: 'zc3333333', after: '新增' },                              // add 容器越界
  { id: 'g4', kind: 'hide', zid: 'zc3333333', entry: '老项目' },                           // hide 越界
  { id: 'g5', kind: 'reorder', zid: 'zc3333333', toZid: 'za1111111', entry: 'X' },         // reorder 起点越界
  { id: 'g6', kind: 'reorder', zid: 'za1111111', toZid: 'zc3333333', entry: 'X' },         // reorder 终点越界
  { id: 'g7', kind: 'replace', zid: 'zb2222222', before: '文本', after: '改写' },          // locked
  { id: 'g8', kind: 'hide', zid: 'zs-head-1', entry: '某章节' },                           // 反例8：展开含 keepZids
  { id: 'g9', kind: 'replace', zid: 'za1111111', before: '甲公司 2024 后端工程师', after: '乙公司 2025 前端' },  // 受保护 token 丢失 → conflict
  { id: 'g10', kind: 'replace', zid: 'za1111111', before: '甲公司 2024 后端工程师', after: '甲公司 2024 后端工程师（精简）' }  // 原值保留 → 过
];
const g = guardOps(gOps, gctx);
const droppedIds = g.dropped.map((d) => d.op.id).sort();
assert(JSON.stringify(droppedIds) === JSON.stringify(['g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']), 'guardOps 全操作范围/锁定/hide 展开拒收: ' + JSON.stringify(droppedIds));
assert(g.dropped.every((d) => d.reason), '每条拒收带理由');
const g8rule = g.dropped.find((d) => d.op.id === 'g8');
assert(/保留|锁定/.test(g8rule.reason), '反例8：hide 展开含必须保留/锁定内容 → 拒');
const keptIds = g.kept.map((o) => o.id).sort();
assert(JSON.stringify(keptIds) === JSON.stringify(['g1', 'g10', 'g9']), '通过候选含受保护字段强制 conflict 项: ' + JSON.stringify(keptIds));
const g9 = g.kept.find((o) => o.id === 'g9');
assert(g9.level === 'conflict' && /受保护字段/.test(g9.reason || ''), '受保护 token（日期/公司/职位）原值丢失 → 强制 conflict');
const g10 = g.kept.find((o) => o.id === 'g10');
assert(g10.level !== 'conflict', '受保护 token 原值保留 → 不误标');
const gNoScope = guardOps([{ id: 'g1', kind: 'replace', zid: 'zc3333333', before: '文本', after: '改写' }], { ...gctx, scope: null });
assert(gNoScope.dropped.length === 0, '无 scope（全文生成）不做区域拒绝');

// —— transitionOp 状态机（撤回清快照 / resolved 绑定）——
const tc = { id: 't1', status: 'pending' };
assert(transitionOp(tc, 'accept').status === 'accepted', 'pending→accepted');
assert(transitionOp(tc, 'reject').status === 'rejected', 'pending→rejected');
assert(transitionOp({ ...tc, status: 'rejected' }, 'unreject').status === 'pending', 'rejected→pending（改主意）');
assert(transitionOp(tc, 'skip').status === 'skipped', 'pending→skipped');
assert(transitionOp({ ...tc, status: 'skipped' }, 'unskip').status === 'pending', 'skipped→pending');
const accSnap = { id: 't1', status: 'accepted', origText: '旧', appliedText: '新', acceptedAt: '2026-10-01T00:00:00Z' };
const reverted = transitionOp(accSnap, 'revert');
assert(reverted.status === 'pending' && reverted.origText === undefined && reverted.appliedText === undefined && reverted.acceptedAt === undefined, '撤回清 origText/appliedText/acceptedAt 回 pending');
assert(accSnap.status === 'accepted', 'transitionOp 纯函数不改入参');
const resolved = transitionOp({ ...baseChange, status: 'pending' }, 'resolve', { now: '2026-10-02T00:00:00Z', text: '当前正文', refs: { 'b2r1': fp1 } });
assert(resolved.status === 'resolved' && resolved.resolvedAt === '2026-10-02T00:00:00Z' && resolved.resolvedText === '当前正文' && resolved.resolvedRefs['b2r1'] === fp1, '反例10：resolve 绑定 resolvedText/resolvedRefs');
assert(transitionOp(accSnap, 'reject') === null, '非法转换返回 null');
// resolved 再变 → 重新进待核对（needs-compare 重现，resolvedAt 保留）
const resolvedChange = { ...resolved, baseSnapshot: '项目甲：数据管道重设计', zid: 'zc3333333' };
const reHit = candidatesState(resolvedChange, mkCtx());
assert(reHit.includes('needs-compare'), 'resolved 后正文再变 → 重新进待核对');
const resolvedOk = candidatesState({ ...resolvedChange, resolvedText: '项目甲：数据管道重设计' }, mkCtx());
assert(!resolvedOk.includes('needs-compare'), 'resolvedText 与当前一致 → 退出待核对（豁免）');

// —— exportChecks：三级分类 + 整体完成（skipped 未决口径）+ 历史态豁免 ——
const ckJob = {
  changes: [
    { id: 'k1', level: 'conflict', status: 'pending' },        // 未解决冲突 → 阻断
    { id: 'k2', level: 'conflict', status: 'skipped' },        // skipped 冲突 → 仍阻断（不解冲突）
    { id: 'k3', level: 'normal', status: 'pending', consistency: ['needs-compare'] },  // 待核对
    { id: 'k4', level: 'important', status: 'rejected', consistency: ['ref-stale'] },  // 历史态豁免
    { id: 'k5', level: 'normal', status: 'superseded' }
  ],
  evidence: [ { id: 'e1', status: 'thin', refs: [] }, { id: 'e2', status: 'sourced', refs: [matRef] } ]
};
const ck = exportChecks(ckJob, { mats: staledMats, lines: ['这条要点很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长', '这条要点很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长'], projects: 4 });
assert(ck.blocking.length === 2 && ck.blocking.every((c) => ['k1', 'k2'].includes(c.id)), '阻断 = pending+skipped 的 conflict');
assert(ck.canExport === false, '未解决冲突 → 不可导出');
assert(ck.check.thin.length === 1, 'thin 证据进建议核对');
assert(ck.check.stale.length === 1, '来源失效证据进建议核对（读取时即时算）');
assert(ck.check.toVerify.length === 1 && ck.check.toVerify[0].id === 'k3', '待核对集合不含 rejected/superseded（历史态豁免）');
assert(ck.style.length >= 2 && ck.style.some((s) => s.key === 'dup') && ck.style.some((s) => s.key === 'projects'), '风格建议 = pageSuggestions 输出');
assert(ck.reviewComplete === false, '有 pending → 整体未完成');
const ck2 = exportChecks({ changes: [ { id: 'k4', level: 'important', status: 'rejected', consistency: ['ref-stale'] } ], evidence: [] }, {});
assert(ck2.canExport === true && ck2.reviewComplete === true, 'rejected 历史不阻塞导出与完成');
const ck3 = exportChecks({ changes: [ { id: 'k6', level: 'normal', status: 'skipped' } ], evidence: [] }, {});
assert(ck3.canExport === true && ck3.reviewComplete === false, '整体完成含 skipped 未决口径（skipped 不计完成）');

// —— 修复轮1：hide/reorder/add 接受后不得假 hand-edited（appliedText 语义 + add 落点切 newZid）——
const hsHtml = '<div class="sheet"><section class="section"><div class="section-title">工作经历</div><p data-zid="za1111111">负责交易系统，P99 800ms</p><p data-zid="ze5555555">条目甲</p><p data-zid="zf6666666">条目乙</p></section></div>';
const hsJob = { changes: [
  { id: 'fx-h1', status: 'pending', kind: 'hide', zid: 'ze5555555', after: '', entry: '条目甲', baseSnapshot: '条目甲' },
  { id: 'fx-r1', status: 'pending', kind: 'reorder', zid: 'zf6666666', after: '', to: 'top', entry: '条目乙', baseSnapshot: '条目乙' },
  { id: 'fx-a1', status: 'pending', kind: 'add', zid: 'za1111111', after: '新增要点行', baseSnapshot: '负责交易系统，P99 800ms' }
] };
const hsAcc = applyOps([
  { operationId: 'fx-op1', changeId: 'fx-h1', action: 'accept', origText: '条目甲' },
  { operationId: 'fx-op2', changeId: 'fx-r1', action: 'accept', origText: '条目乙' },
  { operationId: 'fx-op3', changeId: 'fx-a1', action: 'accept', origText: '负责交易系统，P99 800ms', newZid: 'z9f000001' }
], hsJob, hsHtml);
assert(hsAcc.ok === true, '修复轮：hide/reorder/add 三类 op 接受通过');
const accHtml = '<div class="sheet"><section class="section"><div class="section-title">工作经历</div><p data-zid="za1111111">负责交易系统，P99 800ms</p><p data-zid="ze5555555">条目甲</p><p data-zid="zf6666666">条目乙</p><p data-zid="z9f000001">新增要点行</p></section></div>';
for (const ch of hsAcc.job.changes) {
  const st = candidatesState(ch, mkCtx({ paras: parasOf(accHtml) }));
  assert(JSON.stringify(st) === '[]', '修复轮：' + ch.kind + ' 接受后无假 hand-edited（实得 ' + JSON.stringify(st) + '）');
}
assert(candidatesState(hsAcc.job.changes[0], mkCtx({ paras: parasOf(accHtml.replace('条目甲', '条目甲（手改）')) })).includes('hand-edited'), '修复轮：hide 目标真手改仍检出 hand-edited');
assert(candidatesState(hsAcc.job.changes[2], mkCtx({ paras: parasOf(accHtml.replace('新增要点行', '新增要点行（手改）')) })).includes('hand-edited'), '修复轮：add 新段真手改仍检出 hand-edited');
const ecFix = exportChecks({ changes: hsAcc.job.changes, evidence: [] }, {});
assert(ecFix.reviewComplete === true && ecFix.canExport === true, '修复轮：三类 op 接受后整体完成可达 true');
// —— 修复轮2：applyOps origText 归一口径（含换行的 replace 接受→撤回不再假 400）——
const nlJob = { changes: [ { id: 'fx-nl1', status: 'pending', kind: 'replace', zid: 'za1111111', after: '第一行\n第二行', baseSnapshot: '负责交易系统，P99 800ms' } ] };
const nlAcc = applyOps([ { operationId: 'fx-nl-a', changeId: 'fx-nl1', action: 'accept', origText: '负责交易系统，P99\n800ms' } ], nlJob, '<p data-zid="za1111111">负责交易系统，P99 800ms</p>');
assert(nlAcc.ok === true, '修复轮：含原始换行的 origText 接受通过（归一比较）');
const nlRev = applyOps([ { operationId: 'fx-nl-r', changeId: 'fx-nl1', action: 'revert', origText: '第一行\n第二行' } ], nlAcc.job, '<p data-zid="za1111111">第一行\n第二行</p>');
assert(nlRev.ok === true && nlRev.job.changes[0].status === 'pending', '修复轮：含换行 origText 撤回通过（与 candidatesState 同口径）');
// —— 修复轮2：resolve 清 hand-edited + resolved add 的 resolvedText 锚点（tracked=newZid）——
// A. accepted replace → 手改命中 hand-edited → resolve（绑定当前文本）→ []（再变才经 resolvedText 分支回待核对）
const rvAcc = { ...baseChange, status: 'accepted', acceptedAt: '2026-10-02T00:00:00Z', origText: '负责交易系统，P99 800ms', appliedText: '负责交易系统重构，P99 800ms' };
assert(candidatesState(rvAcc, mkCtx({ paras: parasOf('<p data-zid="za1111111">被手改的当前文本</p>') })).includes('hand-edited'), '修复轮2 前置：手改先命中 hand-edited');
const rvResolved = transitionOp(rvAcc, 'resolve', { now: '2026-10-02T01:00:00Z', text: '被手改的当前文本', refs: {} });
assert(JSON.stringify(candidatesState(rvResolved, mkCtx({ paras: parasOf('<p data-zid="za1111111">被手改的当前文本</p>') }))) === '[]', '修复轮2：resolve 后 hand-edited 清空（[]）');
assert(candidatesState(rvResolved, mkCtx({ paras: parasOf('<p data-zid="za1111111">又改了一次</p>') })).includes('needs-compare'), '修复轮2 阴性对照：resolve 后再变 → resolvedText 分支命中回待核对');
// B. resolved add：resolvedText 绑新段文本，比较按 newZid（非容器）→ []
const rvAddAcc = hsAcc.job.changes.find((x) => x.id === 'fx-a1');   // accepted add（newZid=z9f000001，appliedText=新增要点行）
const rvAddResolved = transitionOp(rvAddAcc, 'resolve', { now: '2026-10-02T01:00:00Z', text: '新增要点行', refs: {} });
assert(JSON.stringify(candidatesState(rvAddResolved, mkCtx({ paras: parasOf(accHtml) }))) === '[]', '修复轮2：resolved add 后 []（resolvedText 按 newZid 比较）');
assert(candidatesState(rvAddResolved, mkCtx({ paras: parasOf(accHtml.replace('新增要点行', '新段被改')) })).includes('needs-compare'), '修复轮2 阴性对照：resolved add 新段再变 → 回待核对');
const ecFix2 = exportChecks({ changes: [rvResolved, rvAddResolved], evidence: [] }, {});
assert(ecFix2.reviewComplete === true, '修复轮2：resolve 路径不再卡整体完成');

// —— buildJobPrompt：facts 进素材块 / brief 三档 / JD 边界声明 ——
const p = buildJobPrompt({ docText: '正文', jd: 'JD 内容', company: '测试公司', role: '后端', materials: mats.filter((m) => m.factStatus === 'confirmed') });
assert(p.sys.includes('JD 是岗位要求来源，不得作为经历或技能的事实来源'), 'JD 边界声明进系统提示');
assert(p.user.includes('公司：甲公司') && p.user.includes('职位：后端工程师') && p.user.includes('指标：P99 210ms'), '素材块含事实字段');
assert(p.user.includes('表达：'), '素材块保留表达层');
assert(!p.user.includes('丙公司'), '未确认素材不进 prompt（调用方过滤 + 事实字段只在已确认集）');
const degLight = buildJobPrompt({ docText: 'x', jd: 'j', company: 'c', role: 'r', brief: { degree: 'light' } });
const degRefocus = buildJobPrompt({ docText: 'x', jd: 'j', company: 'c', role: 'r', brief: { degree: 'refocus' } });
const degRestruct = buildJobPrompt({ docText: 'x', jd: 'j', company: 'c', role: 'r', brief: { degree: 'restructure' } });
assert(degLight.sys.includes('轻度精简') && degRefocus.sys.includes('聚焦') && degRestruct.sys.includes('重组'), 'brief.degree 三档指令（light/refocus/restructure）');
assert(buildJobPrompt({ docText: 'x', jd: 'j', company: 'c', role: 'r' }).sys === degRefocus.sys, '无 brief 默认 refocus 档');
const pBrief = buildJobPrompt({ docText: 'x', jd: 'j', company: 'c', role: 'r', brief: { focus: ['高并发'], keepProjects: ['订单系统'], deemphasize: ['行政实习'], degree: 'light', pages: 2 } });
assert(pBrief.user.includes('高并发') && pBrief.user.includes('订单系统') && pBrief.user.includes('行政实习') && pBrief.user.includes('2 页'), '要求卡进 user prompt（focus/keepProjects/deemphasize/pages）');
void pageSuggestions; void createHash;
console.log('✅ S4a-A 岗位适配数据层纯函数（指纹/ID 匹配/三时态/guardOps/exportChecks/状态机/brief 三档）');
EOF

# —— S4a-A2：updateMetaAll 全表事务（两进程并发原子 / mutator 抛错不落盘 / null 放弃）——
echo "── S4a-A2: updateMetaAll 全表事务 ──"
node --input-type=module << 'EOF'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { updateMetaAll, updateMeta } from './tx.mjs';
const fail = (m) => { console.error('❌ S4a-A2 ' + m); process.exit(1); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4a-meta-all-'));
const metaFile = path.join(tmp, 'docs-meta.json');
fs.writeFileSync(metaFile, JSON.stringify({ docA: { rev: 1 }, docB: { rev: 1 } }));
// ① 两进程并发全表读改写 → 两文档字段全在（无丢失更新）
const txUrl = pathToFileURL(path.join(process.cwd(), 'tx.mjs')).href;
const childFile = path.join(tmp, 'child.mjs');
fs.writeFileSync(childFile, `import { updateMetaAll } from '${txUrl}';
const root = process.argv[2], docId = process.argv[3], prefix = process.argv[4], n = Number(process.argv[5]);
for (let i = 0; i < n; i++) {
  updateMetaAll(root, (all) => { const m = { ...(all[docId] || {}) }; m[prefix + i] = i; return { ...all, [docId]: m }; });
  const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, 1 + (i % 3));
}
`);
const runChild = (docId, prefix, n) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [childFile, tmp, docId, prefix, String(n)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => err += d);
  c.on('error', reject); c.on('exit', (code) => code === 0 ? resolve() : reject(new Error('child exit ' + code + ': ' + err)));
});
await Promise.all([runChild('docA', 'a', 60), runChild('docB', 'b', 60)]);
const cm = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
for (let i = 0; i < 60; i++) {
  if (!(cm.docA && cm.docA['a' + i] === i)) fail('docA 丢失字段 a' + i + '（updateMetaAll 并发丢失更新）');
  if (!(cm.docB && cm.docB['b' + i] === i)) fail('docB 丢失字段 b' + i + '（updateMetaAll 并发丢失更新）');
}
// ② mutator 抛错 → 异常上抛且不落盘
const before = fs.readFileSync(metaFile, 'utf8');
let threw = false;
try { updateMetaAll(tmp, () => { throw new Error('boom'); }); } catch (e) { threw = e.message === 'boom'; }
if (!threw) fail('mutator 抛错应原样上抛');
if (fs.readFileSync(metaFile, 'utf8') !== before) fail('mutator 抛错不得落盘');
// ③ mutator 返回 null → 放弃写入，返回 null
const r3 = updateMetaAll(tmp, () => null);
if (r3 !== null) fail('mutator 返回 null → 放弃并返回 null');
if (fs.readFileSync(metaFile, 'utf8') !== before) fail('null 放弃不得落盘');
// ④ 全表事务与单文档 updateMeta 同锁共存：交替写不丢
for (let i = 0; i < 10; i++) {
  updateMeta(tmp, 'docC', (m) => ({ ...(m || {}), c: i }));
  updateMetaAll(tmp, (all) => ({ ...all, docD: { d: i } }));
}
const cm4 = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
if (cm4.docC.c !== 9 || cm4.docD.d !== 9 || cm4.docA['a59'] !== 59) fail('updateMeta 与 updateMetaAll 交替写共存: ' + JSON.stringify({ c: cm4.docC.c, d: cm4.docD.d }));
// ⑤ mutator 返回非对象（数组/字符串）→ 抛错不落盘（防整表被写成非对象 → 下次读取强转 {} 全表丢失）
const beforeShape = fs.readFileSync(metaFile, 'utf8');
for (const badRet of [() => ['x'], () => 'oops', () => 42]) {
  let threw = false;
  try { updateMetaAll(tmp, badRet); } catch { threw = true; }
  if (!threw) fail('mutator 返回非对象应抛错（' + typeof badRet() + '）');
}
if (fs.readFileSync(metaFile, 'utf8') !== beforeShape) fail('mutator 返回非对象不得落盘');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('✅ S4a-A2 updateMetaAll 全表事务（两进程并发不丢字段 / 抛错不落盘 / null 放弃 / 与 updateMeta 同锁共存）');
EOF

# —— S4B-1：lostNums 事实护栏（原文丢数字 → conflict）——
node --input-type=module << 'EOF'
import { factGuard, normNum } from './job.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-1 ' + m); process.exit(1); } };
const t1 = factGuard({ kind: 'replace', before: '将 QPS 从 300 提升到 5000，延迟从 80ms 降到 15ms，覆盖 3 个业务线', after: '负责后端优化' });
assert(t1.level === 'conflict', '删光数字 → conflict');
assert(/300/.test(t1.reason) && /5000/.test(t1.reason), 'reason 点名丢失的数字');
const t2 = factGuard({ kind: 'replace', before: '服务 12 万日活用户', after: '服务 120000 日活用户' });
assert(t2.level !== 'conflict', '12万 → 120000 不算丢数字');
const t3 = factGuard({ kind: 'replace', before: 'QPS 从 300 提升到 5000', after: '把 QPS 从 300 提升到 5000' });
assert(t3.level !== 'conflict', '数字原样保留不拦');
const t4 = factGuard({ kind: 'replace', before: '效率提升 30%', after: '效率提升 45%' });
assert(t4.level === 'conflict', '百分比丢失也算丢数字');
assert(normNum('12') === '12', 'normNum 无单位原样');
assert(normNum('12万') === '120000', 'normNum 12万 → 120000');
assert(normNum('30%') === '30%', 'normNum 百分比保留');
assert(normNum('1.5亿') === '150000000', 'normNum 1.5亿 → 150000000');
assert(normNum('-30%') === '-30%', 'normNum 保留负号');
const tNeg = factGuard({ kind: 'replace', before: '延迟 -30%', after: '延迟 30%' });
assert(tNeg.level === 'conflict', '-30% → 30% 必须报（负号丢失会导致漏报）');
console.log('✅ S4B-1 lostNums 事实护栏');
EOF

# —— S4B-2：键盘焦点不被 sticky 头遮挡（WCAG 2.4.11 / 1.4.12）——
node --input-type=module << 'EOF'
import fs from 'fs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-2 ' + m); process.exit(1); } };
const src = fs.readFileSync('./server.mjs', 'utf8');
assert(/html\s*\{[^}]*scroll-padding-top\s*:\s*\d+px/.test(src), 'html 设了 scroll-padding-top（固定 px）');
assert(!/line-height\s*:\s*[\d.]+\s*(px|em)\b/.test(src), '服务端不硬编码 px/em 行高（WCAG 1.4.12）');
console.log('✅ S4B-2 焦点不被 sticky 头遮挡');
EOF

# —— S4B-3：面试追问解析 + 双护栏（子串验证 + factGuard）——
node --input-type=module << 'EOF'
import { parseInterview, parseEvidence } from './evidence.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-3 ' + m); process.exit(1); } };
const paras = [{ zid: 'za1111111', text: '负责存储层改造，QPS 从 300 提升到 5000' }];
// ⚠️ 必须用 parseEvidence 的真实产出做夹具，不得手写 {req, zid}——
//    真实行结构是 {id,req,status,refs:[{refId,type,id,zid,hash,title,quote}],note}，顶层没有 zid。
//    手写假结构会让「实现读顶层 zid」这个错误假设在测试里也成立，护栏假绿（2026-10-18 蓝军自检发现）。
const ev = parseEvidence(JSON.stringify({ evidence: [
  { req: '后端能力', refHints: [{ type: 'para', zid: 'za1111111', title: '存储层', quote: '负责存储层改造' }] }
] }), { gen: 1, mats: [], paras });
assert(ev && ev.length === 1 && ev[0].refs.length === 1 && ev[0].refs[0].zid === 'za1111111', '夹具：真实证据行 refs 里带 zid');
assert(!('zid' in ev[0]), '夹具自证：真实行顶层没有 zid（防止再写顶层 zid 的错假设）');

const ok = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: '你负责哪一块？', followUp: 'QPS 再翻十倍瓶颈在哪？',
             answerPoints: [{ text: '我负责存储层', quote: '负责存储层改造' }] }],
  generic: [{ question: '自我介绍', answerPoints: [{ text: '三段经历', quote: '' }] }]
}), { paras, evidence: ev });
assert(ok && ok.chains.length === 1, '正常链路解析');
assert(ok.chains[0].zid === 'za1111111', 'evIndex → zid 回填');
assert(ok.chains[0].answerPoints.length === 1 && ok.chains[0].answerPoints[0].anchored === true, '锚定要点保留');
assert(ok.generic.length === 1 && ok.generic[0].answerPoints[0].anchored === false, '通用问题允许无锚定');
assert(ok.dropped === 0, '无丢弃');

const bad = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f',
             answerPoints: [{ text: '编的', quote: '这段原文里根本没有的话' }] }]
}), { paras, evidence: ev });
assert(bad.chains[0].answerPoints.length === 0, 'quote 编造 → 要点被丢弃');
assert(bad.chains[0].empty === true, '要点全空 → 标 empty');
assert(bad.dropped === 1, '丢弃计数');

const gone = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f', answerPoints: [{ text: 'x', quote: 'y' }] }]
}), { paras: [], evidence: ev });
// fail-closed：锚定段落消失 → 整链丢弃（不是保留并标 empty）。绝不降级成「无锚点」绕过护栏。
assert(gone.chains.length === 0, '锚定段落已删 → 整链丢弃');
assert(gone.dropped === 1, '锚点失效计入 dropped');

const oob = parseInterview(JSON.stringify({
  chains: [{ evIndex: 99, question: 'q', followUp: 'f', answerPoints: [{ text: 'x', quote: '负责存储层改造' }] }]
}), { paras, evidence: ev });
assert(oob.chains.length === 0, 'evIndex 越界 → 整链丢弃（fail-closed）');

const noPara = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f', answerPoints: [{ text: 'x', quote: 'x' }] }]
}), { paras, evidence: parseEvidence(JSON.stringify({ evidence: [{ req: '仅有素材', refHints: [{ type: 'mat', id: 'mm1', title: '素材' }] }] }), { gen: 1, mats: [{ id: 'mm1', factStatus: 'confirmed', facts: {} }], paras }) });
assert(noPara.chains.length === 0, '该证据行无 para 型 ref → 整链丢弃（不可无锚点落库）');

const guardOk = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f',
             answerPoints: [{ text: '我负责存储层', quote: '负责存储层改造，QPS 从 300 提升到 5000' }] }]
}), { paras, evidence: ev });
assert(guardOk.chains[0].answerPoints[0].guard !== 'conflict', '答法要点漏数字是精简不是编造 → 不报 conflict');

const guardBad = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f',
             answerPoints: [{ text: '把 QPS 干到 100000', quote: '负责存储层改造' }] }]
}), { paras, evidence: ev });
assert(guardBad.chains[0].answerPoints[0].guard === 'conflict', '要点编造原文没有的数字 → guard=conflict');

// 误报不得扩散：一条要点编造数字，同链的正常要点必须保持 normal（2026-10-18 OCR 发现整链跑 factGuard 的缺陷）
const guardMix = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f', answerPoints: [
    { text: '我负责存储层改造', quote: '负责存储层改造' },
    { text: '干到 100000', quote: '负责存储层改造' },
    { text: '瓶颈从磁盘转到缓存', quote: '负责存储层改造' }
  ] }]
}), { paras, evidence: ev });
const gm = guardMix.chains[0].answerPoints;
assert(gm[1].guard === 'conflict' && gm[0].guard === 'normal' && gm[2].guard === 'normal', 'factGuard 逐点跑：只标编造的那条');

assert(parseInterview('不是json') === null, '坏输出返回 null');
assert(parseInterview('{"chains":"不是数组"}').chains.length === 0, '类型错不崩');
console.log('✅ S4B-3 面试追问解析 + 双护栏');
EOF

# —— S4B-4：跨文件契约断言（护栏口径漂移的护栏）（2026-10-18 OCR 后加）——
node --input-type=module << 'EOF'
import fs from 'fs';
import { parseEvidence, parseInterview } from './evidence.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-4 ' + m); process.exit(1); } };

const paras = [{ zid: 'za1111111', text: '负责存储层改造，QPS 从 300 提升到 5000' }];
const ev = parseEvidence(JSON.stringify({ evidence: [
  { req: '后端能力', refHints: [{ type: 'para', zid: 'za1111111', quote: '负责存储层改造' }] },
  { req: '前端能力', refHints: [{ type: 'para', zid: 'za1111111', quote: '负责存储层改造' }] }
] }), { gen: 1, mats: [], paras });

// ① 证据行顶层没有 zid；锚点必须从 refs[].zid 推导——这是两条护栏能否生效的地基
assert(!('zid' in ev[0]), '证据行顶层无 zid（防再写顶层 zid 的错假设）');
const p = parseInterview(JSON.stringify({ chains: [{ evIndex: 0, question: 'q', answerPoints: [{ text: '我负责存储层', quote: '负责存储层改造' }] }] }), { paras, evidence: ev });
assert(p.chains.length === 1 && p.chains[0].zid === 'za1111111', '锚点从 refs[].zid 推导成功');
assert(p.chains[0].answerPoints[0].anchored === true, 'anchored 为 true（子串验证真的执行了）');

// ② evIndex 必须原样透出，供前端显示「证据表第 N 行」——丢弃中间链后不得靠数组下标错位
const two = parseInterview(JSON.stringify({ chains: [
  { evIndex: 0, question: '丢', answerPoints: [{ text: 'x', quote: '原文没有的话' }] },   // 要点全被丢但链保留
  { evIndex: 1, question: '留', answerPoints: [{ text: '我负责存储层', quote: '负责存储层改造' }] }
] }), { paras, evidence: ev });
assert(two.chains[0].evIndex === 0 && two.chains[1].evIndex === 1, 'evIndex 原样透出，不被重编号');

// ③ prompt 必须真的带上简历原文（曾因读顶层 zid 而恒为空）
const bp = (await import('./evidence.mjs')).buildInterviewPrompt({ company: 'A', role: '后端', jd: 'J', evidence: ev, paras });
assert(bp.user.includes('负责存储层改造，QPS 从 300 提升到 5000'), 'prompt 含真实简历原文（非空串）');

// ④ stale 双口径：正文哈希 + 证据批次（证据表重生成不改正文，只靠哈希查不出来）
const src = fs.readFileSync('./server.mjs', 'utf8');
assert(src.includes('interviewEvidenceGen'), '落账记录 interviewEvidenceGen');
assert(/interviewEvidenceGen\s*!==\s*Number\(m\.job\.evidenceGen/.test(src), 'stale 判定含证据批次比对');
assert(!/interviewEvGen/.test(src), '旧的错误字段名 interviewEvGen 已清除（曾拿 interview 批次比 evidence 批次）');
console.log('✅ S4B-4 跨文件契约（锚点推导 / evIndex 透出 / prompt 原文 / stale 双口径）');
EOF

# —— S4B-5：generic 护栏缺口 + 解析侧上限（2026-10-18 OCR 中高危）——
node --input-type=module << 'EOF'
import { parseEvidence, parseInterview } from './evidence.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-5 ' + m); process.exit(1); } };
const paras = [{ zid: 'za1111111', text: '负责存储层改造，QPS 从 300 提升到 5000' }];
const ev = parseEvidence(JSON.stringify({ evidence: [{ req: '后端能力', refHints: [{ type: 'para', zid: 'za1111111', quote: '负责存储层改造' }] }] }), { gen: 1, mats: [], paras });

// generic 链无单段锚点，但仍必须有基准：编造数字要被 factGuard 抓到（原先两道护栏全跳过）
const gBad = parseInterview(JSON.stringify({ generic: [{ question: '自我介绍', answerPoints: [{ text: '我带了 50 人团队', quote: '' }] }] }), { paras, evidence: ev });
assert(gBad.generic[0].answerPoints[0].guard === 'conflict', 'generic 要点编造数字 → guard=conflict（原先两道护栏全跳过）');
const gOk = parseInterview(JSON.stringify({ generic: [{ question: '自我介绍', answerPoints: [{ text: '三段经历', quote: '' }] }] }), { paras, evidence: ev });
assert(gOk.generic[0].answerPoints[0].guard !== 'conflict', 'generic 正常要点不误报');

// 解析侧条数上限：模型不遵守 prompt 声明的条数时不整批落库
const many = parseInterview(JSON.stringify({
  chains: [0,1,2,3,4,5,6,7].map(i => ({ evIndex: 0, question: 'q' + i, answerPoints: [{ text: '我负责存储层', quote: '负责存储层改造' }] })),
  generic: [0,1,2,3,4,5,6,7].map(i => ({ question: 'g' + i, answerPoints: [{ text: '三段经历', quote: '' }] }))
}), { paras, evidence: ev });
assert(many.chains.length === 1, 'chains 超上限被截断（证据表 1 行 → 1 条）');
assert(many.generic.length === 4, 'generic 超上限被截断为 4 条');
console.log('✅ S4B-5 generic 护栏 + 解析侧上限');
EOF

# —— S4B-6：用户数据损坏的可恢复性（2026-10-18 隔离根实测发现）——
# 实测：docs-meta / materials / applications / config 损坏均优雅降级 200，唯独「HTML 被截断」
# 让 /edit 返回 500 + 裸英文 'doc missing DOC_ID marker'——用户打不开自己的简历且无法自救。
node --input-type=module << 'EOF'
import fs from 'fs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-6 ' + m); process.exit(1); } };
const src = fs.readFileSync('./server.mjs', 'utf8');
assert(!/doc missing DOC_ID marker/.test(src), '不再返回 500 裸英文');
assert(/文档已损坏/.test(src) && /backup/.test(src.match(/文档已损坏[\s\S]{0,900}/)?.[0] || ''), '损坏页给出备份恢复入口');
assert(/返回首页/.test(src.match(/文档已损坏[\s\S]{0,900}/)?.[0] || ''), '损坏页给出返回首页入口');
console.log('✅ S4B-6 文档损坏可恢复提示页');
EOF

# —— S4B-7：数据安全边界契约（2026-10-18 三路审查：tx 事务层 / freeze 快照 / 注入层）——
node --input-type=module << 'EOF'
import fs from 'fs';
import { updateMeta, beginTx } from './tx.mjs';
import os from 'node:os';
import path from 'node:path';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-7 ' + m); process.exit(1); } };
const src = fs.readFileSync('./server.mjs', 'utf8');
const txs = fs.readFileSync('./tx.mjs', 'utf8');

// ① /rollback 的目标快照必须进 prune 豁免集（否则「回滚到最早一版」会先删目标再报 500，存档永久丢失）
assert(/function protectedSnaps\(id, extraTs\)/.test(src), 'protectedSnaps 接受额外豁免 ts');
assert(/function pruneSnapshots\(id, dir, extraTs\)/.test(src), 'pruneSnapshots 透传豁免');
assert(/snapshot\(id, targetTs\)/.test(src), '/rollback 把回滚目标传给 snapshot');

const withDoc = fs.readFileSync('./tx.mjs', 'utf8');
// ② 陈旧锁 unlink 失败时必须走 deadline 判断（否则无限自旋 + Atomics.wait 冻住整个事件循环）
assert(/锁被占用且无法破除/.test(withDoc), '锁破除失败有独立的超时出口（不再死循环）');
assert(!/lockIsStale\([^)]*\) \{ try \{ fs\.unlinkSync\(lockPath\); \} catch \{\} continue; \}/.test(withDoc), '旧的无条件 continue 自旋已消除');

// ③ beginTx 写正文载荷失败必须抛 + 必须留下标记（S1-E⑧ 不变量：tx 记录保留交启动恢复/人工，不得静默清理）
assert(!/if \(fs\.existsSync\(docFile\)\) \{ try \{ atomicWrite/.test(withDoc), 'beginTx 不再用空 catch 吞正文载荷写失败');
assert(/try \{ atomicWrite\(path\.join\(dir, txId \+ '\.json'\), JSON\.stringify\(rec\)\); \} catch \{\}/.test(withDoc), '载荷写失败仍落标记（交启动恢复/人工，见 S1-E⑧）');
assert(/err\.code = 'TX_PAYLOAD_MISSING'/.test(withDoc), '载荷写失败 code 无条件置为 TX_PAYLOAD_MISSING');
assert(/err\.txErrno/.test(withDoc), '原始 errno 存 txErrno 供诊断（ENOSPC 不被覆盖丢失）');

// 行为验证：陈旧锁可破除 / 活锁被拒 / 只读目录下不死循环
const mk = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 's4b7-')); fs.mkdirSync(path.join(r, 'docs'), { recursive: true }); fs.writeFileSync(path.join(r, 'docs-meta.json'), '{}'); return r; };
const r1 = mk();
fs.writeFileSync(path.join(r1, '.meta.lock'), JSON.stringify({ pid: 999999, host: 'other', startedAt: 1 }));
let broke = false;
try { updateMeta(r1, 'd1', () => ({ rev: 1 })); broke = true; } catch {}
assert(broke, '陈旧锁仍能被破除（rootLock 的能力没被改坏）');

const r2 = mk();
const now = String(Date.now());
fs.writeFileSync(path.join(r2, '.meta.lock'), JSON.stringify({ pid: process.pid, host: 'x', startedAt: now }));
let held = false;
const t0 = Date.now();
try { updateMeta(r2, 'd1', () => ({ rev: 1 })); } catch (e) { held = e.code === 'LOCK_HELD'; }
assert(held && Date.now() - t0 >= 7000, '活锁被拒且走超时（约 8s），不是被误破除');
fs.rmSync(r1, { recursive: true, force: true });
fs.rmSync(r2, { recursive: true, force: true });
console.log('✅ S4B-7 数据安全契约（回滚豁免 / 锁不死循环 / 载荷不静默吞）');
EOF

# —— FP-8：公司名归一化（career-ops normalizeTextKey 移植）——
node --input-type=module << 'EOF'
import { normalizeTextKey } from './vendors/jd-fingerprint/normalize-text-key.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-8 ' + m); process.exit(1); } };
assert(normalizeTextKey('字节跳动（北京）') === normalizeTextKey('字节跳动 北京'), '中文公司名去标点归一');
assert(normalizeTextKey('ByteDance!') === normalizeTextKey('bytedance'), '拉丁大小写+标点归一');
assert(normalizeTextKey(null) === '', 'null → 空串（不产生 "null" 字面量）');
assert(normalizeTextKey(undefined) === '', 'undefined → 空串');
assert(normalizeTextKey('İstanbul') === normalizeTextKey('Istanbul'), '土耳其 İ 剥组合点');
assert(normalizeTextKey('Żubr') !== normalizeTextKey('Zubr'), 'Ż 与 Z 保持区分（NFKC 安全属性）');
console.log('✅ FP-8 公司名归一化');
EOF

# —— FP-1/2/5/7：指纹核心（SimHash + CJK bigram 改造）——
node --input-type=module << 'EOF'
import { normalizeJdText, fingerprintText, similarity, FINGERPRINT_MIN_TEXT } from './vendors/jd-fingerprint/fingerprint-core.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-1 ' + m); process.exit(1); } };

// FP-1: 中文 bigram 切分
const zh = '负责后端服务的开发与维护，参与系统架构设计，优化高并发场景下的性能瓶颈，配合产品团队完成需求评审。';
const tokens = normalizeJdText(zh).split(' ').filter(Boolean);
assert(tokens.length > 3, `纯中文切出多个 token（实际 ${tokens.length}）`);
assert(tokens.includes('后端') && tokens.includes('服务'), 'bigram 覆盖（后端/服务）');
const mixed = normalizeJdText('熟悉 Node.js 与 MySQL 优化');
assert(mixed.split(' ').includes('node') && mixed.split(' ').includes('熟悉'), '中英混合 token 流');
console.log('✅ FP-1 中文 bigram 切分');

// FP-2: 确定性
// 长度说明：zh 仅 49 字 → bigram 展开后 122 字符 < FINGERPRINT_MIN_TEXT(200) → 指纹为空。
// 故 FP-2 用足门槛的长文本（断言条件与 FP-7 同一量级），否则确定性断言无法执行。
const longZh = zh.repeat(5);
const fpA = fingerprintText(longZh);
assert(fpA === fingerprintText(longZh), '同文本两次计算指纹相同');
assert(/^[0-9a-f]{16}$/.test(fpA), '指纹为 16 位小写 hex');
console.log('✅ FP-2 指纹确定性');

// FP-5: 短文本静默跳过
assert(fingerprintText('太短') === '', '过短文本返回空指纹');
assert(fingerprintText('') === '', '空串返回空指纹');
assert(similarity('', fpA) === 0 && similarity(fpA, 'zz') === 0, '空/畸形指纹相似度为 0');
console.log('✅ FP-5 短文本静默跳过');

// FP-7: CJK 缺口回归哨兵 —— 必须用**无标点**纯中文。
// 上游按空格切 token。带标点中文的标点会被 [^\p{L}\p{N}]+ 折成空格，已能切出多个 token，
// 上游原版照样出指纹（那种场景测不出 bigram 的作用，测它是假绿）。只有无标点中文会归一化成
// 单一巨 token → tokens<3 → 返回空指纹 → 护栏静默失效。
// 实测（2026-10-18）：本实现 ed7376a8a0cda07a，上游等价格式返回 ''。去掉 bigramize 本断言即红。
const noPunct = '负责核心系统的设计与开发保障系统稳定性与高可用持续优化服务性能参与技术方案评审与团队协作输出高质量技术文档'.repeat(6);
assert(fingerprintText(noPunct) !== '', '无标点纯中文 JD 指纹非空（上游 SimHash 在此静默失效，bigram 已修复）');
console.log('✅ FP-7 无标点纯中文指纹非空（CJK 回归哨兵）');
EOF

# —— FP-9：重复提醒判定（repost-check 纯函数）——
node --input-type=module << 'EOF'
import { findDupHints } from './vendors/jd-fingerprint/repost-check.mjs';
import { fingerprintText, similarity } from './vendors/jd-fingerprint/fingerprint-core.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-9 ' + m); process.exit(1); } };
const jdA = '岗位要求：负责核心系统的设计与开发，保障系统稳定性与高可用，持续优化服务性能，参与技术方案评审与团队协作，输出高质量技术文档。三年以上后端开发经验，熟悉分布式架构与高并发场景，' .repeat(2) + '具备良好的沟通能力与责任心，能够独立完成模块设计与编码实现，熟悉常用中间件原理与调优。';
const jdA2 = jdA.replace(/三年/g, '3 年').replace(/良好/g, '优秀');   // 少量扰动（<5% 字符）
const jdB = '岗位职责：负责前端页面开发与交互实现，配合设计师还原视觉稿，优化页面加载性能，维护组件库，编写单元测试。熟悉 React 与 TypeScript，了解常见工程化工具链，有开源项目经验者优先，' .repeat(2) + '良好的代码风格与文档习惯，两年以上前端开发经验，能独立负责复杂交互模块。';
const today = '2026-10-18T00:00:00Z';
const mk = (over) => Object.assign({ jd: '', jdFp: '', company: '', role: '', dateStr: '', kind: 'draft', label: '' }, over);

// —— 产品主场景：原样重发（HR 原样再发 / 同 JD 换公司名）必须命中 ——
// 0.95 阈值 ≈ 汉明距离 ≤3 位 = 近逐字（上游自证 near-verbatim）。抓的就是原样重发，
// 不是「大幅改写」——后者漏报优于误报（设计 §7）。
// 注：同公司/换公司名的对照必须同时给 opts.newCompany，否则实现里的 !!newCompany 保护
// 会让 sameCompany 恒为 false，repost 断言永远走不到真分支（假绿）。以下两处均已带上。
let h = findDupHints(jdA, [mk({ jd: jdA, company: '某公司', dateStr: '2026-10-10T00:00:00Z', label: '某公司·后端' })], { today, newCompany: '某公司' });
assert(h.length === 1 && h[0].score === 1, '原样重复 → score=1 必命中');
assert(h[0].repost === true, '同公司原样重复 → repost 标记');
h = findDupHints(jdA, [mk({ jd: jdA, company: '别家猎头', dateStr: '2026-10-15T00:00:00Z' })], { today, newCompany: '某公司' });
assert(h.length === 1 && h[0].score === 1 && !h[0].repost, '换公司名原样重发 → 命中但跨公司不标 repost');

// —— 轻微改写（3% 扰动）：只防算法崩坏的下限，不断言命中 ——
// 实测值抄录进 Task 6 校准附录；若实测 ≥0.95 说明容错超预期，可另行收紧断言。
h = findDupHints(jdA, [mk({ jd: jdA2, company: '某公司', dateStr: '2026-10-10T00:00:00Z' })], { today });
const sPerturbed = h.length ? h[0].score : similarity(fingerprintText(jdA), fingerprintText(jdA2));
assert(sPerturbed >= 0.5, '3% 扰动相似度 ≥0.5（防崩坏下限，实测 ' + sPerturbed.toFixed(3) + '，抄录进校准附录）');

// 不同职位不误报（注：合成文本含 repeat 结构，权威的不误报验证在 FP-4 真实夹具）
h = findDupHints(jdA, [mk({ jd: jdB, company: '另一公司', dateStr: '2026-10-10T00:00:00Z' })], { today });
assert(h.length === 0, '不同 JD 不误报（实测 ' + h.length + ' 条）');

// 窗口外跳过（用 jdA 原样文本：若窗口逻辑失效它必定命中，断言才有牙）
h = findDupHints(jdA, [mk({ jd: jdA, dateStr: '2025-01-01T00:00:00Z' })], { today });
assert(h.length === 0, '窗口外（>90 天）不提醒');

// 窗口内跨公司 → 命中但无 repost 标记（用 jdA：3% 扰动实测 0.891 < 0.95 阈值不命中）
h = findDupHints(jdA, [mk({ jd: jdA, company: '别家', dateStr: '2026-10-15T00:00:00Z' })], { today, newCompany: '某公司' });
assert(h.length === 1 && !h[0].repost, '跨公司相似命中但不标 repost');

// link 精确相等不受窗口限制
h = findDupHints(jdA, [mk({ jd: '', link: 'https://x.zhipin.com/abc', dateStr: '2025-01-01T00:00:00Z', kind: 'app', status: '已约面' })], { today, newLink: 'https://x.zhipin.com/abc' });
assert(h.length === 1 && h[0].kind === 'app' && h[0].byLink === true && h[0].status === '已约面', 'link 命中：kind 保留原始来源 app + byLink 标记 + 带状态');

// 工作台日期格式 '2026-09-11-164709-312' 可解析（同上，用 jdA 避免被阈值挡掉）
h = findDupHints(jdA, [mk({ jd: jdA, dateStr: '2026-09-11-164709-312' })], { today });
assert(h.length === 1, 'apps 时间戳格式（YYYY-MM-DD-hhmmss-ms）可解析入窗');

// 空指纹静默
assert(findDupHints('太短', [mk({ jd: jdA })], { today }).length === 0, '新 JD 过短 → 零提醒');
console.log('✅ FP-9 重复提醒判定');
EOF

# —— FP-3/4/6：真实 JD 夹具（来源 test-fixtures/jd/，硬规矩：不手编假 JD）——
# 夹具每份首两行是 `# 来源:` / `# 截图转录` 注释，load() 必须剥掉再比对，
# 否则注释文字会进入归一化文本，把相似度全部抬高（伪绿）。
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
import { fingerprintText, similarity } from './vendors/jd-fingerprint/fingerprint-core.mjs';
import { FP_THRESHOLD } from './vendors/jd-fingerprint/repost-check.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-3/4/6 ' + m); process.exit(1); } };
const load = (f) => readFileSync('test-fixtures/jd/' + f + '.txt', 'utf8').replace(/^#.*$/gm, '').trim();
const files = ['sample-1', 'sample-2', 'sample-3', 'sample-4', 'sample-5'];
const raws = files.map(load);

// FP-3a: 夹具自检 —— 5 条真实 JD 归一化后均 ≥200 字符，全部可指纹
const fps = raws.map(fingerprintText);
for (let i = 0; i < files.length; i++) {
  assert(fps[i] !== '', files[i] + ' 产出非空指纹（归一化后须 ≥200 字符）');
}
assert(fps.every((f) => /^[0-9a-f]{16}$/.test(f)), '全部指纹为 16 位小写 hex');
assert(raws.every((r) => !/^#/.test(r)), '注释行已剥离（夹具首行不再以 # 开头）');
console.log('✅ FP-3a 真实夹具全部可指纹');

// FP-3b: 轻改写（1% 字符扰动）应仍高于阈值 —— 真实场景「HR 微调措辞后重发」可识别
const chars = Array.from(raws[0]);
const cnt = Math.max(1, Math.floor(chars.length * 0.01));
const pert = chars.map((c, i) => (i > 10 && i % Math.floor(chars.length / cnt) === 0) ? '。' : c).join('');
const s3 = similarity(fingerprintText(raws[0]), fingerprintText(pert));
assert(s3 >= FP_THRESHOLD, `1% 字符扰动应仍命中（实测 ${s3.toFixed(4)}，阈值 ${FP_THRESHOLD}）— 真实场景：HR 微调措辞后重发`);
console.log('✅ FP-3b 轻改写可识别');

// FP-4: 真实 JD 两两不误报 —— 校准 0.90 阈值的核心依据
let max = 0, pair = '';
for (let i = 0; i < files.length; i++) {
  for (let j = i + 1; j < files.length; j++) {
    const s = similarity(fps[i], fps[j]);
    assert(s < FP_THRESHOLD, `${files[i]} × ${files[j]} 相似度 ${s.toFixed(4)} ≥ 阈值 ${FP_THRESHOLD} → 会误报`);
    if (s > max) { max = s; pair = files[i] + ' × ' + files[j]; }
  }
}
console.log(`✅ FP-4 真实 JD 两两不误报（最高一对：${pair} = ${max.toFixed(4)}，阈值 ${FP_THRESHOLD}，余量 ${(FP_THRESHOLD - max).toFixed(4)}）`);

// FP-6: Boss直聘复制噪声（emoji/链接/HTML/页脚）不破坏指纹
const raw1 = raws[0];
const uiNoise = raw1.replace(/。/, '。😎') + '\nhttps://www.zhipin.com/job_detail/x.htm\n<b>加粗</b>    ';
const s6a = similarity(fps[0], fingerprintText(uiNoise));
assert(s6a >= 0.95, `UI 噪声清洗后相似度 ≥0.95（实测 ${s6a.toFixed(4)}）— emoji/URL/空白应被清掉，标签内文字保留属预期`);
const footerNoise = raw1 + ' 微信扫码分享\n举报 ' + '　'.repeat(20);
const s6b = similarity(fps[0], fingerprintText(footerNoise));
assert(s6b >= 0.90, `页脚噪声后相似度须 ≥0.90（实测 ${s6b.toFixed(4)}）— 低于阈值会导致 Boss直聘重复职位漏检，这是阈值从 0.95 降到 0.90 的直接原因`);
console.log(`✅ FP-6 复制噪声清洗稳定（UI 噪声 ${s6a.toFixed(4)} / 页脚噪声 ${s6b.toFixed(4)}）`);
EOF

# —— FP-10：2026-10-18 深度审查的 4 处阻塞修复回归（每条钉死一个曾逃逸的 bug）——
node --input-type=module << 'EOF'
import { findDupHints } from './vendors/jd-fingerprint/repost-check.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-10 ' + m); process.exit(1); } };
const jdA = '岗位要求：负责核心系统的设计与开发，保障系统稳定性与高可用，持续优化服务性能，参与技术方案评审与团队协作，输出高质量技术文档。三年以上后端开发经验，熟悉分布式架构与高并发场景，' .repeat(2) + '具备良好的沟通能力与责任心，能够独立完成模块设计与编码实现，熟悉常用中间件原理与调优。';
const today = '2026-10-18T00:00:00Z';
const mk = (over) => Object.assign({ jd: '', jdFp: '', company: '', role: '', dateStr: '', kind: 'draft', label: '' }, over);
const URL = 'https://x.zhipin.com/abc';

// 🔴 问题 1：从未投递的草稿，link 命中时 kind 不得被说成 app/link（否则 fpTodo 会写「已投递」）
let h = findDupHints(jdA, [mk({ jd: jdA, kind: 'draft', link: URL, dateStr: today, label: '某公司·后端' })], { today, newLink: URL, newCompany: '某公司' });
assert(h.length === 1, 'link 命中 1 条');
assert(h[0].kind === 'draft', '草稿的 kind 必须是 draft（不得被改写成 app/link）— 否则上层文案会说「已投递」');
assert(h[0].byLink === true, 'byLink 标记命中方式');

// 🟡 问题 3：link 命中且同公司 → 必须带 repost 标记（HR 同链接重发给同公司是最常见重发形态）
h = findDupHints(jdA, [mk({ jd: jdA, kind: 'draft', link: URL, dateStr: today, company: '某公司' })], { today, newLink: URL, newCompany: '某公司' });
assert(h[0].repost === true && h[0].sameCompany === true, 'link 命中 + 同公司 → repost=true（原实现写死 false，重发检测在此失效）');
h = findDupHints(jdA, [mk({ jd: jdA, kind: 'draft', link: URL, dateStr: today, company: '别家' })], { today, newLink: URL, newCompany: '某公司' });
assert(h[0].repost === false, 'link 命中 + 跨公司 → repost=false');

// 🟡 问题 4：link 命中的 score 必须是实测相似度，不是写死的 1
h = findDupHints(jdA, [mk({ jd: jdA + '另外还有一些补充说明需要写在这里', link: URL, dateStr: today })], { today, newLink: URL });
assert(h[0].score < 1, `link 命中的 score 须为实测相似度而非写死 1（实测 ${h[0].score}）`);
// 无 JD 文本可比时（同源链接），才退化为 1
h = findDupHints(jdA, [mk({ jd: '', link: URL, dateStr: today })], { today, newLink: URL });
assert(h[0].score === 1, '无 JD 文本可比时 score 退化为 1');

// 🟡 问题 5：工作台本地时间戳格式按本地时刻解析，不按 UTC 午夜坍缩
// '2026-04-21-110000-000' 是本地 11:00；90 天窗口内（今天 2026-07-20）必须命中
h = findDupHints(jdA, [mk({ jd: jdA, dateStr: '2026-04-21-110000-000' })], { today: '2026-07-20T02:00:00Z' });
assert(h.length === 1, '本地时间戳 11:00 在窗口内须命中（UTC 坍缩会误判为窗口外漏提醒）');
h = findDupHints(jdA, [mk({ jd: jdA, dateStr: '2026-04-21T11:00:00' })], { today: '2026-07-20T02:00:00Z' });
assert(h.length === 1, '同一天的 ISO 本地时间格式结果一致（两种格式必须同进同出）');

// link 命中不受窗口限制（保持原语义）
h = findDupHints(jdA, [mk({ jd: jdA, link: URL, dateStr: '2020-01-01T00:00:00Z' })], { today, newLink: URL });
assert(h.length === 1, 'link 精确命中不受 90 天窗口限制');
console.log('✅ FP-10 深度审查修复回归（kind 保真 / repost 不丢失 / score 实测 / 时区不坍缩）');
EOF
# —— FP-11：2026-10-18 第二轮审查新增（渲染层 fpTodo：排序 + 两处文案谎报）——
# fpTodo 已从 server.mjs 移入 repost-check.mjs 导出：server.mjs 顶层 tryListen(0)，
# 导入即起服务，渲染层此前无法被任何断言覆盖 —— 本组是该层唯一的回归网。
node --input-type=module << 'EOF'
import { fpTodo } from './vendors/jd-fingerprint/repost-check.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-11 ' + m); process.exit(1); } };
const H = (o) => Object.assign({ kind: 'draft', byLink: false, label: '甲·岗', dateStr: '2026-10-01T00:00:00Z', score: 0.9, sameCompany: false, repost: false }, o);

// 🟡 问题②（本轮修复但零断言）：按 score 降序，why 取真正最大值而非输入顺序第一条
const r = fpTodo([
  H({ label: '甲·低分', score: 0.9063 }),
  H({ kind: 'app', label: '乙·高分', score: 1, status: '已约面', repost: true }),
  H({ label: '丙·中分', score: 0.95 }),
]);
assert(r[0].question.indexOf('乙·高分') < r[0].question.indexOf('甲·低分'), `问题② 最高分那条必须排在最前（否则又向低报），实际：${r[0].question}`);
assert(r[0].why.indexOf('100%') >= 0, `问题② why 必须报真实最大值 100%，实际：${r[0].why}`);

// 🟡 第二轮新 bug 1：status 本身就是「已投递」时不得拼出「已投递·已投递」
// （/app/add 的默认 status 就是「已投递」，实测输出过「同一链接·已投递·已投递」）
let t = fpTodo([H({ kind: 'app', byLink: true, label: '乙·岗', score: 1, status: '已投递' })]);
assert(t[0].question.indexOf('已投递·已投递') < 0, `已投递 不得重复出现，实际：${t[0].question}`);
assert(t[0].question.indexOf('已投递）') > 0, `非默认 status 仍要带出来，实际：${t[0].question}`);
t = fpTodo([H({ kind: 'app', label: '乙·岗', score: 1, status: '面试中' })]);
assert(t[0].question.indexOf('已投递·面试中') > 0, `非默认 status 仍要带出来，实际：${t[0].question}`);

// 🟡 第二轮新 bug 2：纯 link 命中（历史记录无 JD 文本）时 score 是退化值 1，
// 写进文案等于谎称「指纹命中 100%」—— 实测过 jd 为空的 app 记录被这样报出来
t = fpTodo([H({ kind: 'app', byLink: true, label: '乙·岗', score: 1 })]);
assert(t[0].why.indexOf('指纹') < 0, `纯 link 命中不得谎称指纹命中，实际：${t[0].why}`);
assert(t[0].why.indexOf('相同 JD 链接') >= 0, `纯 link 命中须说明命中原因，实际：${t[0].why}`);
assert(t[0].why.indexOf('100%') < 0, `退化 score 不得当相似度报出，实际：${t[0].why}`);

// 混合命中：百分比只对真比过指纹的那条负责，不得被 link 的退化 1 顶掉
t = fpTodo([H({ byLink: true, label: '丙·仅链接', score: 1 }), H({ label: '甲·真指纹', score: 0.95 })]);
assert(t[0].why.indexOf('95%') >= 0, `混合命中的百分比取指纹最大值 95%，实际：${t[0].why}`);
assert(t[0].why.indexOf('100%') < 0, `link 的退化 score 不得污染百分比，实际：${t[0].why}`);

// 空输入零提醒
assert(fpTodo([]).length === 0 && fpTodo(null).length === 0, '空 dupHints → 无 todo');
console.log('✅ FP-11 渲染层回归（排序取真最大值 / 不重复已投递 / 不谎称指纹命中）');
EOF

# —— S4B-8：中文数字 + 三类误报（2026-10-18 二轮审查实测）——
node --input-type=module << 'EOF'
import { factGuard, normNum } from './job.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-8 ' + m); process.exit(1); } };
// 中文数字绕过护栏（原实现只认阿拉伯数字，中文简历最自然的写法一改就零告警）
assert(factGuard({ kind: 'replace', before: '年营收十二万', after: '年营收十五万' }).level === 'conflict', '中文数词「十二万→十五万」必须拦（业绩造假主路径）');
assert(factGuard({ kind: 'replace', before: '预算三千万', after: '预算四千万' }).level === 'conflict', '「三千万→四千万」必须拦');
assert(factGuard({ kind: 'replace', before: '管理两百人的团队', after: '管理三百人的团队' }).level === 'conflict', '「两百→三百」必须拦（含「百」单位）');
assert(factGuard({ kind: 'replace', before: '年营收十二万', after: '年营收12万' }).level !== 'conflict', '「十二万」与「12万」是同一个数字，不得误报');
assert(factGuard({ kind: 'replace', before: '增长1万2', after: '增长10002' }).level !== 'conflict', '中文式混写「1万2」与「10002」等价，不得误报');
// 序数/描述性量词必须放行：中文里「三段经历」的序数与「三十人」的规模量词形态相同，无法靠正则区分。
// 取舍：中文数词必须含百/千/万/亿才算可核对数字——拦业绩造假，放行序数，漏报优于误报（S4B-5 的 generic 要点会误报）。
assert(factGuard({ kind: 'replace', before: '三段经历', after: '我经历过三段经历，技术方向一致' }).level !== 'conflict', '「三段经历」序数不得误报（护栏天天误报用户会关掉它）');
assert(factGuard({ kind: 'replace', before: '方案分三部分', after: '我把方案拆成三部分落地' }).level !== 'conflict', '「三部分」不得误报');
// 已知漏报（刻意不拦，登记在 handoff）：不含大数单位的规模表述形态上与序数不可分
assert(factGuard({ kind: 'replace', before: '团队三十人', after: '团队五十人' }).level !== 'conflict', '已知漏报：不含大数单位的规模表述刻意不拦');
// 归一化：中文数词 + 中文式混写 + 科学计数法
assert(normNum('十二万') === '120000', 'normNum 十二万 → 120000');
assert(normNum('两百') === '200', 'normNum 两百 → 200（含「百」单位）');
assert(normNum('一亿') === '100000000', 'normNum 一亿 → 100000000');
assert(normNum('三千万') === '30000000', 'normNum 三千万 → 30000000');
assert(normNum('一万二') === '10002', 'normNum 一万二 → 10002（中文式混写）');
assert(normNum('1万2') === '10002', 'normNum 1万2 → 10002（中文式混写归一）');
assert(normNum('1e3') === normNum('1000'), 'normNum 科学计数法 1e3 与 1000 等价');
assert(factGuard({ kind: 'replace', before: 'QPS 从 1000 提升', after: 'QPS 从 1e3 提升' }).level !== 'conflict', '科学计数法等值改写不得误报');
// 原有的阿拉伯数字能力不得回归
assert(normNum('12万') === '120000' && normNum('1.5亿') === '150000000' && normNum('30%') === '30%', '阿拉伯数字归一能力保持');
assert(factGuard({ kind: 'replace', before: 'QPS 从 300 提升到 5000', after: '负责后端优化' }).level === 'conflict', '丢数字仍必须拦');
assert(factGuard({ kind: 'replace', before: '服务 12 万日活', after: '服务 120000 日活' }).level !== 'conflict', '12万→120000 不得误报');
console.log('✅ S4B-8 中文数字护栏 + 科学计数法/中文混写归一');
EOF

# —— S4B-9：URL 协议白名单（javascript:/data: 存储型 XSS）——
node --input-type=module << 'EOF'
import { safeUrl } from './safe-url.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-9 ' + m); process.exit(1); } };
// 危险协议必须被拒（二轮审查实测：escAttr 只转义不校验协议）
assert(safeUrl('javascript:alert(1)') === '', 'javascript: 必须拒');
assert(safeUrl('JavaScript:alert(1)') === '', '协议名大小写不敏感');
assert(safeUrl('  javascript:alert(1)') === '', '前导空白不得绕过');
assert(safeUrl('data:text/html,<script>alert(1)</script>') === '', 'data: 必须拒');
assert(safeUrl('vbscript:msgbox(1)') === '', 'vbscript: 必须拒');
// 正常 URL 必须放行
assert(safeUrl('https://www.zhipin.com/job_detail/abc') === 'https://www.zhipin.com/job_detail/abc', 'https 放行');
assert(safeUrl('http://example.com/a?b=1') === 'http://example.com/a?b=1', 'http 放行');
assert(safeUrl('mailto:a@b.com') === 'mailto:a@b.com', 'mailto 放行');
assert(safeUrl('/edit?id=x') === '/edit?id=x', '站内绝对路径放行');
assert(safeUrl('./a.png') === './a.png', '相对路径放行');
assert(safeUrl('#sec') === '#sec', '锚点放行');
// 协议相对 URL 必须拒（//evil.com 会跳到外站）
assert(safeUrl('//evil.com/x') === '', '协议相对 // 必须拒');
assert(safeUrl('') === '' && safeUrl(null) === '' && safeUrl(undefined) === '', '空值安全');
// 渲染点必须走白名单，不能只靠 escAttr
const srv = (await import('node:fs')).readFileSync('./server.mjs', 'utf8');
assert(/safeUrl\(app\.link\)/.test(srv), '投递记录 link 渲染前必须过 safeUrl');
assert(!/href="\$\{escAttr\(app\.link\)\}"/.test(srv), '不得直接 escAttr(app.link) 当 href（escAttr 不校验协议）');
console.log('✅ S4B-9 URL 协议白名单（javascript:/data: 存储型 XSS）');
EOF

# —— S4B-10：备份包解压炸弹护栏（/restore 展开尺寸上限）——
node --input-type=module << 'EOF'
import { sumExpandedBytes, MAX_EXPANDED_BYTES } from './restore-guard.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-10 ' + m); process.exit(1); } };
// macOS bsdtar 的 tzvf 输出：第 5 列是 size（目录条目为 0）
const bsd = 'drwxr-xr-x  0 xxxly  wheel       0 10月 18 17:40 docs/\n-rw-r--r--  0 xxxly  wheel      32 10月 18 17:40 docs/a.html\n-rw-r--r--  0 xxxly  wheel    5000 10月 18 17:40 big.bin';
let r = sumExpandedBytes(bsd);
assert(r.bytes === 5032 && r.parsed === 3 && r.total === 3, `bsdtar 输出求和精确（实得 ${r.bytes}）`);
// GNU tar（Linux）的 user/group 用 / 连成一列、且没有链接数列 —— 列布局与 bsdtar 不同，
// 正则若只匹配 bsdtar，fail-closed 会把 Linux 打的合法备份包全拒（2026-10-18 实测踩过）。
const gnu = '-rw-r--r-- root/root      491 2026-10-18 17:00 docs/b.html\ndrwxr-xr-x root/root        0 2026-10-18 17:00 docs/';
r = sumExpandedBytes(gnu);
assert(r.bytes === 491 && r.parsed === 2, `GNU tar 格式求和（实得 ${r.bytes}）`);
r = sumExpandedBytes('-rw-r--r--  1 root/root   491 2026-10-18 17:00 docs/b.html');
assert(r.bytes === 491, `GNU tar 带链接数列（实得 ${r.bytes}）`);
// 路径含空格也不能解析错（size 取的是固定列，不是最后一列）
r = sumExpandedBytes('-rw-r--r--  0 u g   100 2026-10-18 17:00 my docs/a b.html');
assert(r.bytes === 100, `路径含空格仍取对 size 列（实得 ${r.bytes}）`);
// fail closed：解析不出的行必须抛错，绝不放行
let threw = false;
try { sumExpandedBytes('-rw-r--r-- 0 u g ??? ??? weird-entry'); } catch (e) { threw = /无法解析/.test(e.message); }
assert(threw, '解析不出的行必须抛错（fail closed，解析失败放行等于给攻击者留后门）');
// 只用绝对上限 256MB。校准依据（2026-10-18 全部实测）：
//   真实备份 2.75MB→4.19MB（余量 61×）／多版本快照 5.1KB→207.8KB（余量 1200×）
//   炸弹 A 1.30MB→442.5MB ❌ ／ 炸弹 B 0.32MB→314.9MB ❌
// 刻意**不用压缩倍率限**（原设 50× 已撤）：多版本快照是本项目正常状态（每次 /save 一份快照），
// 实测压缩比达 40.5×，倍率限会误拒自己的合法备份——这个误拒是 test.sh「自产备份预览失败」抓出来的。
assert(MAX_EXPANDED_BYTES === 256 * 1024 * 1024, '展开绝对上限 256MB');
const srv = (await import('node:fs')).readFileSync('./server.mjs', 'utf8');
assert(/sumExpandedBytes/.test(srv), '/restore 必须调用 sumExpandedBytes');
assert(/MAX_EXPANDED_BYTES/.test(srv), '/restore 必须用 MAX_EXPANDED_BYTES 判绝对超限');
assert(!/MAX_COMPRESSION_RATIO/.test(srv), '不得引入压缩倍率限（会误拒多版本快照这种正常备份，实测 40.5×）');
assert(/'tzvf'/.test(srv), '/restore 必须用 tar tzvf 取 size（tzf 不带 -v 拿不到大小）');
// 回归：2026-10-18 踩过的坑——把路径列表也改成 tzvf 会让整行（含权限/用户/日期）当路径校验，
// 结果所有备份包全被拒。路径必须继续用 tzf。
assert(/\['tzf', tmpTar\]/.test(srv), '路径列表必须用 tzf（tzvf 整行含元信息，当路径校验会全拒备份包）');
assert(/\['tzvf', tmpTar\]/.test(srv), '尺寸求和用 tzvf');
console.log('✅ S4B-10 备份包解压炸弹护栏');
EOF

# —— S4B-11：extract.mjs 标签剥离二次方回溯 → 单遍扫描（S4B-11 性能回归网）——
node --input-type=module << 'EOF'
import { docToLines, docToText } from './extract.mjs';
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-11 ' + m); process.exit(1); } };
// ① 语义等价（单遍扫描不得改变任何提取结果——AI 上下文靠它，改错就毁核心功能）
const SYN = [
  ['无标签', '纯文本内容', '纯文本内容'],
  ['正常标签', '<p>段落</p><div class="a">块</div>', '段落\n块'],   // </p></div> 会被换成换行符（既有行为）
  ['属性含>', '<a title="a>b" href="x">链接</a>', '链接'],            // 引号内的 > 不算标签结束
  ['属性含单引号', "<a title='a>b'>链接</a>", '链接'],
  ['未闭合标签', '前<div class="x 后文', '前<div class="x 后文'],        // 未闭合 → 原文保留（与原正则一致）
  ['自闭合', '<br/><img src="x.png"/>文本', '文本'],
  ['CDATA', '<script>var a = "<div>";</script>文本', '文本'],
  ['注释', '<!-- <p>注释里的标签</p> -->正文', '正文'],
  ['空', '', ''],
  ['只有<', '<', '<'],
  ['只有>', '>', '>'],
];
for (const [n, html, want] of SYN) {
  assert(docToText(html) === want, `${n}：期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(docToText(html))}`);
}
assert(JSON.stringify(docToLines('<p>a</p><p>b</p>')) === JSON.stringify(['a', 'b']), 'docToLines 按行切分不变');
console.log('✅ S4B-11a 标签剥离语义等价（' + SYN.length + ' 种边界形态 + 行切分）');

// ② 性能：N 个未闭合标签。修复前实测 2000→64ms / 4000→254ms / 8000→1065ms / 16000→4131ms
//    （每档 4×，标准二次方）。线性版 32000 个约 8ms —— 阈值 1000ms 对线性有 125× 余量，
//    而任何回退到二次方的实现会在 32000 个上跑 16 秒以上被抓住。
const patho = '<div class="a" '.repeat(32000);
const t0 = process.hrtime.bigint();
docToLines(patho);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
assert(ms < 1000, `32000 个未闭合标签须 <1000ms（实测 ${ms.toFixed(1)}ms）— 二次方回溯已回归`);
// ③ 正常内容不许被拖慢（线性扫描不该比正则慢一个数量级）
const normal = '<p>普通段落内容</p>'.repeat(8000);
const t1 = process.hrtime.bigint();
docToLines(normal);
const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
assert(ms2 < 500, `正常 8000 段须 <500ms（实测 ${ms2.toFixed(1)}ms）`);
console.log(`✅ S4B-11b 线性化（病态 ${ms.toFixed(1)}ms / 正常 ${ms2.toFixed(1)}ms）`);

// ④ 真实简历文档不受影响
const real = readFileSync('./docs/linghaoxiang.html', 'utf8');
const lines = docToLines(real);
assert(lines.length > 10 && lines.join('').length > 50, '真实简历仍能正常提取（' + lines.length + ' 行）');
console.log('✅ S4B-11c 真实简历提取正常（' + lines.length + ' 行）');
EOF

# —— S4B-12：/job/create 粘贴 JD 长度上限（二轮审查实测 2MB → meta 12.59MB）——
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-12 ' + m); process.exit(1); } };
const srv = readFileSync('./server.mjs', 'utf8');
assert(/const JD_MAX_CHARS = 64 \* 1024/.test(srv), 'JD 粘贴上限 64KB 且提到模块级（三个入口共用）');
assert(/jdTruncated/.test(srv), '截断必须留痕（写进 jdError → todo）');
// 三个写 jd 的入口都要截断：/job/create、/version/create、/app/add。
// 漏一个就是缺口——二轮审查只点了 /job/create，实际 /version/create 与 /app/add 同样无上限（实测后补上）。
const caps = (srv.match(/slice\(0, JD_MAX_CHARS\)/g) || []).length;
assert(caps >= 3, '三个写 jd 的入口都要截断（实得 ' + caps + ' 处）');
assert(!/jd: typeof body\.jd === 'string' \? body\.jd :/.test(srv), '不得再有裸传 body.jd 的入口');
console.log('✅ S4B-12 /job/create JD 长度上限');
EOF

# —— S4B-13：quote 最小长度护栏（子串存在 ≠ 语义相关）——
node --input-type=module << 'EOF'
import { parseInterview, parseEvidence } from './evidence.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-13 ' + m); process.exit(1); } };
const paras = [{ zid: 'za1111111', text: '负责存储层改造，QPS 从 300 提升到 5000，主导跨部门技术方案评审与容量规划落地' }];
const ev = parseEvidence(JSON.stringify({ evidence: [{ req: '后端', refHints: [{ type: 'para', zid: 'za1111111', quote: '负责存储层改造' }] }] }), { gen: 1, mats: [], paras });
const mk = (q) => JSON.stringify({ chains: [{ evIndex: 0, question: '如何做容量规划', answerPoints: [{ text: 'QPS 从 300 提升到 5000，覆盖存储层改造', quote: q }] }] });
const REAL = '负责存储层改造，QPS 从 300 提升到 5000，主导跨部门技术方案评审与容量规划落地';
// 短 quote（动词短语，无信息量）必须丢弃：二轮审查实测 quote:'负责' 双护栏全过却放过纯编造要点
for (const q of ['负责', '完成了', '参与了', '存储改造']) {
  assert(parseInterview(mk(q), { paras, evidence: ev }).chains[0].answerPoints.length === 0, `短 quote「${q}」（${[...q].length} 字）必须丢弃`);
}
// 真实引用（有指标/技术名/动作对象）必须保留
assert(parseInterview(mk(REAL), { paras, evidence: ev }).chains[0].answerPoints.length === 1, '真实引用（>8 字）必须保留');
assert(parseInterview(mk('QPS 从 300 提升到 5000'), { paras, evidence: ev }).chains[0].answerPoints.length === 1, '指标型引用必须保留');
// generic 链无锚点要求，quote 为空时不受此限（否则会把所有 generic 要点全丢）
const g = parseInterview(JSON.stringify({ generic: [{ question: '自我介绍', answerPoints: [{ text: '三段经历', quote: '' }] }] }), { paras, evidence: ev });
assert(g.generic[0].answerPoints.length === 1, 'generic 链 quote 为空不受长度限制');
console.log('✅ S4B-13 quote 最小长度护栏（短引用丢弃 / 真实引用保留 / generic 不受影响）');
EOF
