// test-agent-resume-tools.mjs — 2026-11-19 AI 面合并：agent 工具环四件套（resume_check/improve/polish/tailor）
// 合同（设计 dev-docs/2026-11-19-ai-surface-merge-design.md §2/§6.2）：
//   ① 四工具 BAD_ARGS：args 非对象 / 缺 docId / resume_tailor 缺 requirement / 未知字段 → {ok:false,code:'BAD_ARGS'}。
//   ② NOT_FOUND：假 docId → {ok:false,code:'NOT_FOUND'}。
//   ③ resume_check 桩回 issues → output {ok,docId,title,count,issues}；type 归一（'错误'→error、未知→warning）；≤20 条截断。
//   ④ resume_improve/polish/tailor 桩回 rewritten → output 含全文 + preview≤300 + issuesFixed/requirement 口径；
//      def.fact 投影后无 rewritten（回灌与交付分离）。
//   ⑤ 模型坏输出（非改写文本）→ {ok:false,code:'ERROR'}（rewriteErr 路径）。
//   ⑥ 源级钉值：AGENT_SYSTEM 含四工具名 + 「全文见上方工具卡」策略；TOOL_DEFS 四件套竞速 timeoutMs=600000 + 底层 RESUME_LLM_TIMEOUT_MS=540000。
//   ⑦ TIMEOUT：临时 def（never-resolve + timeoutMs=100）→ runToolTimed 断言 {ok:false,code:'TIMEOUT'}。
// 夹具口径：隔离 RESUME_ROOT + 本机桩 LLM（OpenAI 兼容 {choices:[{message:{content}}]}），零真实模型；不起 server.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { init, TOOL_DEFS, runTool, runToolTimed } from '../../agent.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// —— 隔离根：一份带 h1/section 的合成简历（docToLines 口径可解析）——
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-agtools-'));
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
const DOC = 'doc1';
fs.writeFileSync(path.join(root, 'docs', DOC + '.html'),
  '<!doctype html><html><head><title>t</title></head><body><h1>合成简历一</h1>'
  + '<div class="section"><h2 class="section-title">工作经历</h2><p>负责交易系统，把延迟从 80ms 降到 12ms。</p></div>'
  + '<div class="section"><h2 class="section-title">技能</h2><p>Java / Redis / Kafka</p></div></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [DOC]: { rev: 1, kind: 'master' } }, null, 2));

// —— 桩 LLM：按 prompt 特征词分流（smartCheck / improveAll / improveWriting / buildRewrite 四 prompt 零改动）——
const ISSUES_RAW = [];
for (let i = 0; i < 22; i++) ISSUES_RAW.push({
  type: i === 0 ? '错误' : (i === 1 ? 'bogus' : (i % 2 ? 'error' : 'warning')),
  field: '工作经历·第' + (i + 1) + '段', description: '问题描述' + (i + 1), suggestion: '修复建议' + (i + 1)
});
const REWRITTEN = '合成简历一（已优化版）\n负责交易系统与网关优化，把延迟从 80ms 降到 12ms，支撑日订单十二万。\n'
  + 'Java / Redis / Kafka / 分布式链路追踪。'.padEnd(340, '。');   // >300 字：测 preview 截断
let polishCalls = 0, tailorCalls = 0;
const stub = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => { b += d; });
  req.on('end', () => {
    let sys = '', usr = '';
    try {
      const msgs = JSON.parse(b).messages;
      sys = String((msgs.find((m) => m.role === 'system') || {}).content || '');
      usr = String((msgs.find((m) => m.role === 'user') || {}).content || '');
    } catch {}
    const ok = (content) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    };
    if (req.url.includes('/broken')) return ok('```');   // 坏输出分支最前：纯围栏（llm 校验过、cleanText 剥完为空）→ {reply} 兜底 → 工具 rewriteErr（供 ⑤ 用）
    if (sys.includes('简历体检专家')) return ok(JSON.stringify({ issues: ISSUES_RAW }));
    if (sys.includes('简历润色专家')) { polishCalls++; return ok(REWRITTEN); }
    if (usr.includes('【指令】')) { tailorCalls++; return ok(REWRITTEN); }   // customRewrite → buildRewrite user 段特征
    if (usr.includes('【问题清单】')) return ok(REWRITTEN);                  // improveAll
    return ok(REWRITTEN);
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/v1`, apiKey: 'test-key', model: 'stub-model-x' }]
}, null, 2));
init(root);   // agent.mjs 数据根注入（readDoc/docTitleOf 口径）

const ctx = { root, lease: undefined, profile: 0 };   // profile:0 = stub 档案（与对话同档案语义）
const isErr = (r, code) => r && r.ok === false && r.code === code;

// ① BAD_ARGS
{
  const bad1 = await runTool('resume_check', {}, ctx);
  assert.ok(isErr(bad1, 'BAD_ARGS'), 'resume_check 缺 docId 应 BAD_ARGS，收到 ' + JSON.stringify(bad1));
  const bad2 = await runTool('resume_tailor', { docId: DOC }, ctx);
  assert.ok(isErr(bad2, 'BAD_ARGS'), 'resume_tailor 缺 requirement 应 BAD_ARGS');
  const bad3 = await runTool('resume_polish', { docId: DOC, bogus: 1 }, ctx);
  assert.ok(isErr(bad3, 'BAD_ARGS'), 'resume_polish 未知字段应 BAD_ARGS');
  const bad4 = await runTool('resume_improve', 'not-an-object', ctx);
  assert.ok(isErr(bad4, 'BAD_ARGS'), 'resume_improve args 非对象应 BAD_ARGS');
  console.log('✅ ① 四工具 BAD_ARGS');
}

// ② NOT_FOUND
{
  const nf = await runTool('resume_check', { docId: 'no-such-doc' }, ctx);
  assert.ok(isErr(nf, 'NOT_FOUND'), '假 docId 应 NOT_FOUND，收到 ' + JSON.stringify(nf));
  console.log('✅ ② NOT_FOUND');
}

// ③ resume_check：issues 形状 / type 归一 / ≤20 截断
{
  const r = await runTool('resume_check', { docId: DOC }, ctx);
  assert.ok(r && r.ok === true, 'resume_check 应 ok，收到 ' + JSON.stringify(r).slice(0, 200));
  assert.equal(r.docId, DOC);
  assert.equal(r.title, '合成简历一');
  assert.equal(r.count, 20, '桩回 22 条应截断为 20（ISSUE_CAP）');
  assert.equal(r.issues.length, 20);
  assert.equal(r.issues[0].type, 'error', "type='错误' 应归一为 error");
  assert.equal(r.issues[1].type, 'warning', "type='bogus' 应归一为 warning");
  const fact = TOOL_DEFS.resume_check.fact(r);
  assert.deepEqual(fact, r, 'resume_check fact 投影应原样全量（issues 回灌给模型转述）');
  console.log('✅ ③ resume_check 形状 + type 归一 + 截断');
}

// ④ 三改写工具：rewritten 全文交付 / preview≤300 / 回灌投影分离
{
  const imp = await runTool('resume_improve', { docId: DOC }, ctx);
  assert.ok(imp && imp.ok === true, 'resume_improve 应 ok，收到 ' + JSON.stringify(imp).slice(0, 200));
  assert.equal(imp.rewritten, REWRITTEN, 'rewritten 应为全文');
  assert.equal(imp.chars, REWRITTEN.length);
  assert.equal(imp.preview, REWRITTEN.slice(0, 300) + '…', 'preview=前 300 字+省略号（agent.mjs clip 口径）');
  assert.equal(imp.preview.length, 301);
  assert.equal(imp.issuesFixed, 20, '一呼完成：先体检得 20 条再修复');
  const fImp = TOOL_DEFS.resume_improve.fact(imp);
  assert.ok(!('rewritten' in fImp), '回灌投影不得含 rewritten（全文不过模型第二道手）');
  assert.equal(fImp.preview, imp.preview, '回灌投影保留 preview 摘要');

  const pol = await runTool('resume_polish', { docId: DOC }, ctx);
  assert.ok(pol && pol.ok === true && pol.rewritten === REWRITTEN && pol.preview === REWRITTEN.slice(0, 300) + '…');
  assert.ok(!('issuesFixed' in pol), 'polish 无 issuesFixed 字段');
  assert.ok(!('rewritten' in TOOL_DEFS.resume_polish.fact(pol)), 'polish 回灌投影无 rewritten');

  const REQ = '要求：三年后端经验，熟悉高并发与网关，有团队管理背景';
  const tal = await runTool('resume_tailor', { docId: DOC, requirement: REQ }, ctx);
  assert.ok(tal && tal.ok === true && tal.rewritten === REWRITTEN, 'resume_tailor 应 ok 且回全文');
  assert.equal(tal.requirement, REQ.slice(0, 80), 'requirement 应 ≤80 字回显');
  const fTal = TOOL_DEFS.resume_tailor.fact(tal);
  assert.ok(!('rewritten' in fTal) && fTal.requirement === REQ.slice(0, 80), 'tailor 回灌投影：无全文、保留 requirement 回显');
  assert.ok(polishCalls === 1 && tailorCalls === 1, '桩分流命中：polish/tailor 各一次');
  console.log('✅ ④ improve/polish/tailor 交付全文 + 回灌摘要分离');
}

// ⑤ 模型坏输出 → ERROR（rewriteErr 路径）
{
  const saved = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  // 桩按 req.url 含 /broken 分流坏输出 —— llm.mjs 固定 POST {base}/chat/completions，
  // 改 profile baseURL 指到 /broken/v1 触发；profile:0（ctx 同档案）读到坏分支应如实归 ERROR。
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${stub.address().port}/broken/v1`, apiKey: 'test-key', model: 'stub-model-x' }]
  }, null, 2));
  const r = await runTool('resume_polish', { docId: DOC }, ctx);
  assert.ok(isErr(r, 'ERROR'), '模型空输出应 ERROR，收到 ' + JSON.stringify(r));
  assert.ok(String(r.error).includes('模型未返回改写结果'), 'ERROR 应如实说明未返回改写结果');
  fs.writeFileSync(path.join(root, 'config.json'), saved);   // 还原好配置
  console.log('✅ ⑤ 模型坏输出 → ERROR');
}

// ⑥ 源级钉值：AGENT_SYSTEM 四工具名 + 策略 7；TOOL_DEFS per-tool 超时
{
  const src = fs.readFileSync(path.join(APP_ROOT, 'agent.mjs'), 'utf8');
  for (const t of ['resume_check', 'resume_improve', 'resume_polish', 'resume_tailor']) {
    assert.ok(src.includes('- ' + t + ' {"docId"'), 'AGENT_SYSTEM 缺工具行: ' + t);
    assert.ok(TOOL_DEFS[t] && TOOL_DEFS[t].timeoutMs === 600000, t + ' 应 per-tool 竞速 timeoutMs=600000');
  }
  assert.ok(src.includes('const RESUME_LLM_TIMEOUT_MS = 540000'), '缺底层调用预算 RESUME_LLM_TIMEOUT_MS=540000（2026-11-19 真模型抽验修正）');
  const lsrc = fs.readFileSync(path.join(APP_ROOT, 'llm.mjs'), 'utf8');
  assert.ok(lsrc.includes('Number(timeoutMs) > 0 ? Number(timeoutMs)'), 'llm.mjs 缺 per-call 超时覆盖优先级（per-call > profile > 120s）');
  assert.ok(src.includes('全文见上方工具卡'), 'AGENT_SYSTEM 缺策略 7（不复述全文）');
  assert.ok(src.includes('四件套（resume_*）输出不自动写回文档'), 'AGENT_SYSTEM 缺交付声明（不自动写回）');
  console.log('✅ ⑥ AGENT_SYSTEM 源级钉值 + timeoutMs');
}

// ⑦ TIMEOUT：临时 def（never-resolve + timeoutMs=100）
{
  TOOL_DEFS._slow_probe = { run: () => new Promise(() => {}), timeoutMs: 100 };
  const t0 = Date.now();
  const r = await runToolTimed('_slow_probe', {}, ctx);
  const dt = Date.now() - t0;
  assert.ok(isErr(r, 'TIMEOUT'), 'never-resolve def 应 TIMEOUT，收到 ' + JSON.stringify(r));
  assert.ok(String(r.error).includes('0.1 秒'), 'TIMEOUT 错误文本应带实际秒数（per-tool 口径）');
  assert.ok(dt < 5000, 'TIMEOUT 应在 100ms 量级触发，实际 ' + dt + 'ms');
  delete TOOL_DEFS._slow_probe;
  console.log('✅ ⑦ TIMEOUT 路径（per-tool timeoutMs）');
}

stub.close();
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
console.log('✅ test-agent-resume-tools 全部通过');
process.exit(0);
