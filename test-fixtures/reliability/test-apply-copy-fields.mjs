// test-apply-copy-fields.mjs — AI 文案字段（批 3 · 卡片 b3c3）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §4 批 3「S8 网申包 + 跟进助手」；上位路线图 S8。
// 合同（本卡只管 AI 文案字段：打招呼语 / 自荐信 / 跟进语）：
//   ① 字段类型：三类 AI 文案字段进字段包（通用信息表 + 公司字段包同表），不复用简历派生。
//   ② 走既有 genTasks：kind=copy（任务记录契约同款：taskId/status/stage/usage/error），
//      进度只给真实阶段（排队/调用模型/解析），**不给百分比**；可取消；用量取服务商真实返回。
//   ③ 生成 → 预览 → 确认才入库：生成完成只落「待确认稿」，字段值不动；确认后才写进字段。
//   ④ 覆写后锁定：手动改写并保存 → 该字段被锁定，再生成/再确认都不得覆盖它（可显式解锁）。
//   ⑤ 无模型时明确降级：未配置大模型 → 接口 409 + 可读降级说明；页面生成入口禁用且写明原因。
//   ⑥ 其它纪律：并发闸（同类 copy 全库同时只允许 1 个）、取消后迟到结果零落账、
//      槽满即拒且不留 running 假任务、坏输出显式失败不写字段。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档 + 本机假 LLM；不读真实简历、不碰 7766、
//       不调真实模型；仓库零写入。
// 隐私门禁：合成数据不含 1[3-9]\d{9} 形态的 11 位长数字（电话用座机号，邮箱用 example.invalid），
//            夹具内不写 13 位时间戳（长数字第二位避开 3-9）。
// 退出码契约：0=全部通过；1=任一断言失败；2=仅 Chromium 不可用且此前无失败（浏览器段跳过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-appcopy-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });

// —— 合成母版简历（AI 文案的取材来源）——
const MASTER = 'apcopymaster';
const entry = (title, role, date, bullet) =>
  `<div class="entry-head"><div class="entry-title">${title}</div><div class="entry-role">${role}</div><div class="entry-date">${date}</div></div>\n<ul>\n<li>${bullet}</li>\n</ul>`;
let masterDoc = assembleTemplate('classic');
const masterMap = {
  '{{NAME}}': '合成姓名',
  '{{CONTACT}}': '座机：021-5555-6666 邮箱：tester@example.invalid',
  '{{INTENT}}': '后端工程师',
  '{{SUMMARY}}': '合成自评：做过合成交易系统与合成风控。',
  '{{SKILLS}}': '<p><strong>语言：</strong>Go / Python</p>',
  '{{WORK}}': entry('合成公司', '后端工程师', '2021-03', '负责合成交易系统，把合成延迟压到 80ms'),
  '{{PROJECTS}}': '<p>项目一：合成数据管道重设计</p>',
  '{{EDU}}': entry('合成大学', '计算机', '2017-06', ''),
  '{{DOC_ID}}': MASTER,
};
for (const [k, v] of Object.entries(masterMap)) masterDoc = masterDoc.replaceAll(k, () => v);
fs.writeFileSync(path.join(root, 'docs', MASTER + '.html'), masterDoc);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ [MASTER]: { rev: 1, flow: 'draft' } }, null, 2));

// —— 假 LLM：可控延迟 / 可切坏输出；返回真实 usage（桩值即「服务商返回的用量」）——
let llmDelay = 0;
let llmMode = 'good';       // 'good' | 'empty' | 'nousage'（服务商没返回 usage）
let llmCalls = 0;
let lastLlmBody = '';
const GEN_TEXT = '合成打招呼语：您好，我做过合成交易系统与合成风控，能直接上手后端。';
const llm = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  lastLlmBody = body;
  llmCalls++;
  if (llmDelay) await new Promise((r) => setTimeout(r, llmDelay));
  const content = llmMode === 'empty' ? '   ' : GEN_TEXT;
  const payload = { choices: [{ message: { content } }] };
  // 'nousage'：服务商响应里**没有** usage 字段 → 任务记 usage=null（不编 0），页面须显式说「服务商未返回」。
  if (llmMode !== 'nousage') payload.usage = { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
const CONFIG_PATH = path.join(root, 'config.json');
const writeConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  active: 0, profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }],
}));
writeConfig();

// —— 随机端口 + 隔离根起服务 ——
const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { llm.close(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));
const base = `http://127.0.0.1:${port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text(), headers: r.headers }; };
const postJson = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};
const copyState = async (scopeParam, key) => {
  const r = await get('/apply/copy/state?scope=' + encodeURIComponent(scopeParam) + '&key=' + encodeURIComponent(key));
  let json = null;
  try { json = JSON.parse(r.text); } catch {}
  return { status: r.status, json, text: r.text };
};
const waitCopy = async (scopeParam, key, until, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const s = await copyState(scopeParam, key);
    last = s.json;
    if (last && until(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
};
const ledger = () => JSON.parse(fs.readFileSync(path.join(root, 'apply-profiles.json'), 'utf8'));
const fieldValue = (scopeParam, key) => {
  const d = ledger();
  const f = scopeParam === 'common'
    ? ((d.common.fields || {})[key] || null)
    : (((d.packages || {})[pkgId] || {}).fields || {})[key] || null;
  return f;
};
// —— HTML 取样工具 ——
const section = (html, id) => {
  const i = html.indexOf('id="' + id + '"');
  if (i < 0) return '';
  const start = html.lastIndexOf('<section', i);
  const end = html.indexOf('</section>', i);
  if (start < 0 || end < 0) return '';
  return html.slice(start, end);
};
const rowOf = (html, key) => {
  for (const chunk of html.split('<div class="ap-row').slice(1)) {
    const head = chunk.slice(0, chunk.indexOf('>') + 1);
    if (head.includes('data-key="' + key + '"')) return '<div class="ap-row' + chunk;
  }
  return '';
};
const rowCount = (html) => (html.match(/<div class="ap-row"/g) || []).length;
const badgeText = (row) => {
  const m = /<span class="badge[^"]*">([^<]*)<\/span>/.exec(row);
  return m ? m[1] : '';
};
const textareaValue = (row) => {
  const m = /<textarea[^>]*>([\s\S]*?)<\/textarea>/.exec(row);
  return m ? m[1] : '';
};
let pkgId = '';

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① 字段类型：三类 AI 文案字段进字段包 =====
  {
    const r = await get('/apply-profile');
    assert.equal(r.status, 200, '/apply-profile 应 200，实际 ' + r.status);
    const common = section(r.text, 'apCommon');
    assert.ok(common, '页面应渲染通用信息表区');
    assert.equal(rowCount(common), 14, '通用表应有 14 个字段行（11 既有 + 3 AI 文案），实际 ' + rowCount(common));
    for (const [key, label] of [['greeting', '打招呼语'], ['coverLetter', '自荐信'], ['followUp', '跟进语']]) {
      const row = rowOf(common, key);
      assert.ok(row, `通用表应含 AI 文案字段行 ${key}`);
      assert.ok(row.includes('>' + label + '<'), `字段 ${key} 应显示标签「${label}」`);
      assert.ok(row.includes('data-ap="gen"'), `字段 ${key} 应有生成入口`);
      assert.ok(row.includes('data-ap="copy"'), `字段 ${key} 应有复制入口`);
      assert.ok(!row.includes('data-ap="follow"'), `AI 文案字段无来源，不应有「恢复跟随」入口`);
      assert.ok(badgeText(row), `字段 ${key} 应有状态徽章`);
    }
    // 公司字段包同样带这三类字段
    const c = await postJson('/apply/package', { company: '合成公司', role: '后端工程师' });
    assert.equal(c.status, 200, '建字段包应 200，实际 ' + c.status + ' ' + c.text.slice(0, 200));
    pkgId = c.json.id;
    const pkgSec = section((await get('/apply-profile')).text, 'apPkg-' + pkgId);
    assert.ok(pkgSec, '页面应渲染公司字段包区');
    assert.equal(rowCount(pkgSec), 14, '字段包应有 14 个字段行，实际 ' + rowCount(pkgSec));
    assert.ok(rowOf(pkgSec, 'greeting').includes('data-ap="gen"'), '包内也应能生成 AI 文案');
  }

  // ===== ② 无模型时明确降级 =====
  {
    fs.rmSync(CONFIG_PATH);                      // 拔掉模型配置（读取即时生效，无需重启）
    const start = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'greeting' });
    assert.equal(start.status, 409, '无模型时生成应 409（明确降级，不是 500），实际 ' + start.status + ' ' + start.text.slice(0, 200));
    assert.ok(start.json && start.json.ok === false, '无模型时返回体应带 ok=false');
    const msg = String((start.json && start.json.error) || '');
    assert.ok(msg.includes('未配置大模型'), '降级提示应点明「未配置大模型」，实际：' + msg);
    assert.ok(msg.includes('手动') || msg.includes('设置'), '降级提示应给出下一步（手动填写或去设置页配置），实际：' + msg);
    // 页面上：生成入口禁用 + 写明原因（不做「点了才知道」的死路）
    const html = (await get('/apply-profile')).text;
    const row = rowOf(section(html, 'apCommon'), 'greeting');
    assert.ok(/data-ap="gen"[^>]*disabled/.test(row), '无模型时生成按钮应禁用，实际：' + row.slice(0, 400));
    assert.ok(row.includes('未配置大模型'), '无模型时行内应写明降级原因，实际：' + row.slice(0, 400));
    writeConfig();                               // 装回模型配置，继续后面的用例
  }

  // ===== ③ 无来源简历 → 明确拒绝（AI 文案必须有事实依据） =====
  {
    const start = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'greeting' });
    assert.equal(start.status, 409, '没有母版简历时生成应 409，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    assert.ok(String((start.json && start.json.error) || '').includes('简历'),
      '拒绝原因应点明缺简历来源，实际：' + start.text.slice(0, 200));
    // 绑定母版后可生成
    const bind = await postJson('/apply/bind', { docId: MASTER });
    assert.equal(bind.status, 200, '绑定母版应 200，实际 ' + bind.status + ' ' + bind.text.slice(0, 200));
  }

  // ===== ④ 生成 → 进度（真实阶段/真实用量/无百分比）→ 预览但不入库 =====
  {
    llmMode = 'good'; llmDelay = 0;
    const start = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'greeting' });
    assert.equal(start.status, 200, '生成应 200，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    assert.ok(start.json && start.json.taskId, '生成应返回 taskId，实际：' + start.text.slice(0, 200));
    const st = await waitCopy('common', 'greeting', (x) => x.task && x.task.status !== 'running');
    assert.ok(st && st.task, '应有任务记录，实际：' + JSON.stringify(st));
    assert.equal(st.task.status, 'done', '生成应完成，实际：' + JSON.stringify(st.task));
    assert.ok(['queued', 'calling', 'parsing', null].includes(st.task.stage), '阶段字段应为空（终态清阶段），实际：' + st.task.stage);
    // 真实用量：服务商返回的 total 原样带出（不编 0）
    assert.ok(st.task.usage && st.task.usage.total === 333, '用量应是服务商真实返回的 total=333，实际：' + JSON.stringify(st.task.usage));
    // 无百分比：进度只给真实阶段，不给百分比
    assert.ok(!/percent|percentage|progress\s*:/i.test(JSON.stringify(st)), '状态响应不得含百分比字段，实际：' + JSON.stringify(st));
    const html = (await get('/apply-profile')).text;
    // 生成区（状态行/预览区）不得出现百分比进度（页面 CSS 里的 width:100% 不算进度，故只看生成区文本）
    const genArea = (rowOf(section(html, 'apCommon'), 'greeting').match(/<div class="ap-gen">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
    assert.ok(!genArea.includes('%'), '生成区不得显示百分比进度，实际：' + genArea.slice(0, 300));
    // 预览稿已落，字段值仍未入库
    assert.ok(st.draft && st.draft.id, '生成完成应有待确认稿，实际：' + JSON.stringify(st.draft));
    assert.ok(String(st.draft.text || '').includes('合成打招呼语'), '待确认稿应是模型生成的文案，实际：' + JSON.stringify(st.draft));
    const f = fieldValue('common', 'greeting');
    assert.ok(!f || !f.value, '生成完成不得直接入库（字段值应仍为空），实际：' + JSON.stringify(f));
    // 实际 prompt 必须带真简历事实（模型才有依据）
    assert.ok(lastLlmBody.includes('合成交易系统'), '实际 prompt 未包含简历事实，实际：' + lastLlmBody.slice(0, 400));
  }

  // ===== ⑤ 确认才入库 =====
  {
    const st = await copyState('common', 'greeting');
    const draftId = st.json.draft.id;
    const conf = await postJson('/apply/copy/confirm', { scope: { kind: 'common' }, key: 'greeting', draftId });
    assert.equal(conf.status, 200, '确认应 200，实际 ' + conf.status + ' ' + conf.text.slice(0, 200));
    const f = fieldValue('common', 'greeting');
    assert.ok(f && String(f.value || '').includes('合成打招呼语'), '确认后文案应写进字段，实际：' + JSON.stringify(f));
    const after = await copyState('common', 'greeting');
    assert.ok(!after.json.draft, '确认后待确认稿应清空，实际：' + JSON.stringify(after.json.draft));
    const html = (await get('/apply-profile')).text;
    const row = rowOf(section(html, 'apCommon'), 'greeting');
    assert.ok(textareaValue(row).includes('合成打招呼语'), '页面值框应显示已确认文案，实际：' + textareaValue(row));
    assert.equal(badgeText(row), 'AI 文案', '确认后徽章应为「AI 文案」，实际：' + badgeText(row));
    // 二次确认（稿已不存在）→ 409，不静默成功
    const again = await postJson('/apply/copy/confirm', { scope: { kind: 'common' }, key: 'greeting', draftId });
    assert.equal(again.status, 409, '稿已确认后再确认应 409，实际 ' + again.status + ' ' + again.text.slice(0, 200));
  }

  // ===== ⑥ 预览可编辑后确认（入库的是改后的文字） =====
  {
    await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'coverLetter' });
    const st = await waitCopy('common', 'coverLetter', (x) => x.task && x.task.status !== 'running');
    assert.equal(st.task.status, 'done', '自荐信生成应完成，实际：' + JSON.stringify(st.task));
    const edited = '合成自荐信（人工改过）：我做过合成交易系统。';
    const conf = await postJson('/apply/copy/confirm', { scope: { kind: 'common' }, key: 'coverLetter', draftId: st.draft.id, text: edited });
    assert.equal(conf.status, 200, '确认应 200，实际 ' + conf.status + ' ' + conf.text.slice(0, 200));
    const f = fieldValue('common', 'coverLetter');
    assert.equal(f && f.value, edited, '入库的应是用户改过的预览文字，实际：' + JSON.stringify(f));
  }

  // ===== ⑦ 覆写后锁定：再生 + 确认都不得覆盖 =====
  {
    const ov = await postJson('/apply/field', { scope: { kind: 'common' }, key: 'greeting', mode: 'override', value: '手写打招呼语' });
    assert.equal(ov.status, 200, '手动覆写应 200，实际 ' + ov.status + ' ' + ov.text.slice(0, 200));
    const f0 = fieldValue('common', 'greeting');
    assert.equal(f0 && f0.value, '手写打招呼语', '覆写后字段应是手填值，实际：' + JSON.stringify(f0));
    assert.ok(f0 && f0.locked === true, '覆写后字段应被锁定，实际：' + JSON.stringify(f0));
    const html = (await get('/apply-profile')).text;
    const row = rowOf(section(html, 'apCommon'), 'greeting');
    assert.equal(badgeText(row), '已锁定', '锁定后徽章应为「已锁定」，实际：' + badgeText(row));
    // 锁定期再生成 → 可以生成（有预览），但确认不得覆盖
    const start = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'greeting' });
    assert.equal(start.status, 200, '锁定期生成应仍可发起，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    const st = await waitCopy('common', 'greeting', (x) => x.task && x.task.status !== 'running');
    assert.equal(st.task.status, 'done', '锁定期生成应完成，实际：' + JSON.stringify(st.task));
    const conf = await postJson('/apply/copy/confirm', { scope: { kind: 'common' }, key: 'greeting', draftId: st.draft.id });
    assert.equal(conf.status, 409, '锁定字段的确认应 409（不得覆盖手写文案），实际 ' + conf.status + ' ' + conf.text.slice(0, 200));
    assert.ok(String((conf.json && conf.json.error) || '').includes('锁定'),
      '拒绝原因应点明「锁定」，实际：' + conf.text.slice(0, 200));
    const f1 = fieldValue('common', 'greeting');
    assert.equal(f1 && f1.value, '手写打招呼语', '锁定字段不得被生成结果覆盖，实际：' + JSON.stringify(f1));
    // 显式解锁后可再生覆盖
    const unlock = await postJson('/apply/field', { scope: { kind: 'common' }, key: 'greeting', mode: 'ai' });
    assert.equal(unlock.status, 200, '解锁应 200，实际 ' + unlock.status + ' ' + unlock.text.slice(0, 200));
    const f2 = fieldValue('common', 'greeting');
    assert.ok(f2 && f2.locked === false, '解锁后不应再是锁定态，实际：' + JSON.stringify(f2));
    assert.equal(f2 && f2.value, '手写打招呼语', '解锁不应改动文案内容，实际：' + JSON.stringify(f2));
    const conf2 = await postJson('/apply/copy/confirm', { scope: { kind: 'common' }, key: 'greeting', draftId: st.draft.id });
    assert.equal(conf2.status, 200, '解锁后确认应 200，实际 ' + conf2.status + ' ' + conf2.text.slice(0, 200));
    const f3 = fieldValue('common', 'greeting');
    assert.ok(f3 && String(f3.value || '').includes('合成打招呼语'), '解锁后确认应写入生成文案，实际：' + JSON.stringify(f3));
  }

  // ===== ⑧ 取消：迟到结果零落账（不产生待确认稿） =====
  {
    llmMode = 'good'; llmDelay = 1500;
    const start = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'followUp' });
    assert.equal(start.status, 200, '生成应 200，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    await new Promise((r) => setTimeout(r, 250));
    const cancel = await postJson('/apply/copy/cancel', { scope: { kind: 'common' }, key: 'followUp', taskId: start.json.taskId });
    assert.equal(cancel.status, 200, '取消应 200，实际 ' + cancel.status + ' ' + cancel.text.slice(0, 200));
    const st = await copyState('common', 'followUp');
    assert.equal(st.json.task.status, 'cancelled', '任务应标记已取消，实际：' + JSON.stringify(st.json.task));
    await new Promise((r) => setTimeout(r, 2200));   // 等在途结果到达
    const after = await copyState('common', 'followUp');
    assert.ok(!after.json.draft, '取消后的迟到结果不得产生待确认稿，实际：' + JSON.stringify(after.json.draft));
    assert.ok(after.json.task.status === 'cancelled', '取消后任务态应仍是 cancelled，实际：' + JSON.stringify(after.json.task));
    // 取消后再取消（taskId 不匹配当前 running）→ 409
    const again = await postJson('/apply/copy/cancel', { scope: { kind: 'common' }, key: 'followUp', taskId: start.json.taskId });
    assert.equal(again.status, 409, '重复取消应 409，实际 ' + again.status + ' ' + again.text.slice(0, 200));
    llmDelay = 0;
  }

  // ===== ⑨ 并发闸：同类 copy 全库同时只允许 1 个 =====
  {
    llmMode = 'good'; llmDelay = 2500;
    const first = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'greeting' });
    assert.equal(first.status, 200, '第一个生成应 200，实际 ' + first.status + ' ' + first.text.slice(0, 200));
    const second = await postJson('/apply/copy/start', { scope: { kind: 'package', id: pkgId }, key: 'greeting' });
    assert.equal(second.status, 409, '同类任务并发应 409（跨字段包也不行），实际 ' + second.status + ' ' + second.text.slice(0, 200));
    await waitCopy('common', 'greeting', (x) => x.task && x.task.status !== 'running', 20000);
    llmDelay = 0;
  }

  // ===== ⑩ 坏输出：显式失败，不写字段、不产生待确认稿 =====
  {
    llmMode = 'empty';
    const start = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'followUp' });
    assert.equal(start.status, 200, '生成应 200，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    const st = await waitCopy('common', 'followUp', (x) => x.task && x.task.status !== 'running');
    assert.equal(st.task.status, 'error', '空输出应显式失败，实际：' + JSON.stringify(st.task));
    assert.ok(st.task.error, '失败必须带可见原因');
    assert.ok(!st.draft, '失败不得产生待确认稿，实际：' + JSON.stringify(st.draft));
    llmMode = 'good';
  }

  // ===== ⑪ 丢弃预览稿 =====
  {
    await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'followUp' });
    const st = await waitCopy('common', 'followUp', (x) => x.task && x.task.status !== 'running');
    assert.ok(st.draft, '应有待确认稿');
    const dis = await postJson('/apply/copy/discard', { scope: { kind: 'common' }, key: 'followUp' });
    assert.equal(dis.status, 200, '丢弃应 200，实际 ' + dis.status + ' ' + dis.text.slice(0, 200));
    const after = await copyState('common', 'followUp');
    assert.ok(!after.json.draft, '丢弃后待确认稿应清空，实际：' + JSON.stringify(after.json.draft));
  }

  // ===== ⑫ 形状守卫：未知字段 / 未知范围 / 缺 key 都拒 =====
  {
    const badKey = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'name' });
    assert.equal(badKey.status, 400, '非 AI 文案字段不得走生成端点，实际 ' + badKey.status + ' ' + badKey.text.slice(0, 200));
    const badScope = await postJson('/apply/copy/start', { scope: { kind: 'package' }, key: 'greeting' });
    assert.equal(badScope.status, 400, '字段包缺 id 应 400，实际 ' + badScope.status + ' ' + badScope.text.slice(0, 200));
    const noKey = await postJson('/apply/copy/start', { scope: { kind: 'common' } });
    assert.equal(noKey.status, 400, '缺 key 应 400，实际 ' + noKey.status + ' ' + noKey.text.slice(0, 200));
    const badPkg = await postJson('/apply/copy/start', { scope: { kind: 'package', id: 'pkg-nosuch' }, key: 'greeting' });
    assert.equal(badPkg.status, 404, '未知字段包应 404，实际 ' + badPkg.status + ' ' + badPkg.text.slice(0, 200));
  }

  // ===== ⑬ 取材来源：字段包跟随岗位简历时，取材那份简历（不是通用表母版） =====
  {
    // 造第二份简历（内容与母版不同，好分辨取材的是哪一份）
    let jobDoc = assembleTemplate('classic');
    const jobMap = {
      '{{NAME}}': '岗位姓名',
      '{{CONTACT}}': '座机：021-5555-6688 邮箱：job@example.invalid',
      '{{INTENT}}': '后端工程师',
      '{{SUMMARY}}': '岗位自评：做过合成网关。',
      '{{SKILLS}}': '<p><strong>语言：</strong>Go</p>',
      '{{WORK}}': entry('岗位公司', '后端工程师', '2022-05', '负责合成网关'),
      '{{PROJECTS}}': '<p>项目一：合成网关重构</p>',
      '{{EDU}}': entry('合成大学', '计算机', '2017-06', ''),
      '{{DOC_ID}}': 'apcopyjob',
    };
    for (const [k, v] of Object.entries(jobMap)) jobDoc = jobDoc.replaceAll(k, () => v);
    fs.writeFileSync(path.join(root, 'docs', 'apcopyjob.html'), jobDoc);
    const metaRaw = JSON.parse(fs.readFileSync(path.join(root, 'docs-meta.json'), 'utf8'));
    metaRaw['apcopyjob'] = { rev: 1, flow: 'draft' };
    fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify(metaRaw, null, 2));
    // 字段包换源 → 跟随岗位简历
    const sw = await postJson('/apply/source', { scope: { kind: 'package', id: pkgId }, source: { kind: 'resume', docId: 'apcopyjob' } });
    assert.equal(sw.status, 200, '字段包换源应 200，实际 ' + sw.status + ' ' + sw.text.slice(0, 200));
    lastLlmBody = '';
    const start = await postJson('/apply/copy/start', { scope: { kind: 'package', id: pkgId }, key: 'greeting' });
    assert.equal(start.status, 200, '包内生成应 200，实际 ' + start.status + ' ' + start.text.slice(0, 200));
    const st = await waitCopy('package:' + pkgId, 'greeting', (x) => x.task && x.task.status !== 'running');
    assert.equal(st.task.status, 'done', '包内生成应完成，实际：' + JSON.stringify(st.task));
    assert.ok(lastLlmBody.includes('合成网关'), '包内取材应是该包跟随的岗位简历内容，实际：' + lastLlmBody.slice(0, 400));
    assert.ok(!lastLlmBody.includes('合成交易系统'), '包内取材不得取通用表母版的内容，实际：' + lastLlmBody.slice(0, 400));
    await postJson('/apply/copy/discard', { scope: { kind: 'package', id: pkgId }, key: 'greeting' });
  }

  // ===== ⑭ 导出含 AI 文案（整包导出带上确认后的文案） =====
  {
    const t = await get('/apply/export?scope=common&format=text');
    assert.equal(t.status, 200, '纯文本导出应 200');
    assert.ok(t.text.includes('打招呼语：'), '纯文本导出应含 AI 文案字段行，实际：' + t.text.slice(0, 400));
    const j = await get('/apply/export?scope=common&format=json');
    const jd = JSON.parse(j.text);
    assert.ok(jd.fields.greeting, 'JSON 导出应含 AI 文案字段，实际：' + Object.keys(jd.fields || {}).join(','));
    assert.ok(String(jd.fields.greeting.value || '').includes('合成打招呼语'), 'JSON 导出应含已确认文案，实际：' + JSON.stringify(jd.fields.greeting));
  }

  // ===== ⑮ 待确认稿被新的生成取代 → 旧稿的确认被拒（不拿别人的稿入库） =====
  {
    await postJson('/apply/copy/discard', { scope: { kind: 'common' }, key: 'greeting' });
    const s1 = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'greeting' });
    assert.equal(s1.status, 200, '第一次生成应 200，实际 ' + s1.status + ' ' + s1.text.slice(0, 200));
    const d1 = await waitCopy('common', 'greeting', (x) => x.task && x.task.status !== 'running');
    assert.ok(d1.draft && d1.draft.id, '第一次生成应有待确认稿');
    const oldDraftId = d1.draft.id;
    const s2 = await postJson('/apply/copy/start', { scope: { kind: 'common' }, key: 'greeting' });
    assert.equal(s2.status, 200, '第二次生成应 200，实际 ' + s2.status + ' ' + s2.text.slice(0, 200));
    const d2 = await waitCopy('common', 'greeting', (x) => x.task && x.task.status !== 'running');
    assert.ok(d2.draft && d2.draft.id !== oldDraftId, '第二次生成应换一份待确认稿');
    const conf = await postJson('/apply/copy/confirm', { scope: { kind: 'common' }, key: 'greeting', draftId: oldDraftId });
    assert.equal(conf.status, 409, '旧稿的确认应 409（不是当前那份），实际 ' + conf.status + ' ' + conf.text.slice(0, 200));
    assert.ok(String((conf.json && conf.json.error) || '').includes('当前'),
      '拒绝原因应说明不是当前那份稿，实际：' + conf.text.slice(0, 200));
    // 当前那份仍可确认
    const conf2 = await postJson('/apply/copy/confirm', { scope: { kind: 'common' }, key: 'greeting', draftId: d2.draft.id });
    assert.equal(conf2.status, 200, '当前稿应可确认，实际 ' + conf2.status + ' ' + conf2.text.slice(0, 200));
  }

  // ===== ⑯ 浏览器段：真点一遍「生成 → 预览 → 确认入库」 =====
  {
    // 先清掉遗留的待确认稿：浏览器段要考的是「点生成 → 新预览出现 → 确认入库」这条真路径，
    // 不是「页面加载时就带着一份旧稿」的旁路。
    await postJson('/apply/copy/discard', { scope: { kind: 'common' }, key: 'greeting' });
    const before = await copyState('common', 'greeting');
    assert.ok(!before.json.draft, '浏览器段开始前不应有遗留待确认稿，实际：' + JSON.stringify(before.json.draft));
    let bin = null;
    try { bin = await resolveChromium(); }
    catch (e) { console.log('⚠️  Chromium 不可用，跳过 AI 文案浏览器段：' + (e && e.message || e)); cleanup(); process.exit(2); }
    const browser = await chromium.launch({ executablePath: bin, headless: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
      await page.goto(base + '/apply-profile', { waitUntil: 'networkidle' });
      const rowSel = '.ap-row[data-scope="common"][data-key="greeting"]';
      // 点「生成」→ 轮询到预览出现
      llmDelay = 2500;   // 让任务停在 running 一会儿，好观察运行中的「取消」入口
      await page.click(rowSel + ' button[data-ap="gen"]');
      // 运行中「取消」：服务端只在**页面加载那一刻**已有 running 任务时渲染取消钮；点「生成」后是客户端
      // 轮询才发现 running → 客户端补建（2026-11-06 复核阻断项：此前运行中根本没有取消入口）。
      const cancelShown = await page.waitForFunction((sel) => {
        const row = document.querySelector(sel);
        return !!(row && row.querySelector('button[data-ap="gen-cancel"]'));
      }, rowSel, { timeout: 8000 }).then(() => true).catch(() => false);
      assert.ok(cancelShown, '点生成后运行中应出现「取消」按钮（客户端补建）');
      const draftVisible = await page.waitForFunction(() => {
        const box = document.querySelector('.ap-row[data-scope="common"][data-key="greeting"] .ap-gen-draft');
        return !!(box && !box.hasAttribute('hidden') && box.querySelector('textarea') && box.querySelector('textarea').value);
      }, null, { timeout: 20000 }).then(() => true).catch(() => false);
      assert.ok(draftVisible, '点生成后应出现可编辑的预览稿');
      // 预览框里改一个字再确认入库
      await page.fill(rowSel + ' .ap-gen-draft textarea', '浏览器段确认的打招呼语');
      const reloaded = page.waitForEvent('load', { timeout: 10000 }).catch(() => null);
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/apply/copy/confirm') && r.request().method() === 'POST', { timeout: 10000 }),
        reloaded,
        page.click(rowSel + ' button[data-ap="gen-confirm"]'),
      ]);
      assert.equal(resp.status(), 200, '确认入库应 200，实际 ' + resp.status());
      const value = await page.evaluate(() => {
        const ta = document.querySelector('.ap-row[data-scope="common"][data-key="greeting"] .ap-val');
        return ta ? ta.value : '';
      });
      assert.equal(value, '浏览器段确认的打招呼语', '确认后值框应显示入库文案，实际：' + value);
      // 服务商没返回 usage → 客户端状态行须显式说「服务商未返回」（不编 0、不省略用量字样）
      llmMode = 'nousage';
      await page.click(rowSel + ' button[data-ap="gen"]');
      const usageSaid = await page.waitForFunction((sel) => {
        const st = document.querySelector(sel + ' .ap-gen-status');
        return !!(st && st.textContent.indexOf('服务商未返回') >= 0);
      }, rowSel, { timeout: 20000 }).then(() => true).catch(() => false);
      assert.ok(usageSaid, '服务商未返回用量时状态行应显式说明（客户端路径）');
      llmMode = 'good'; llmDelay = 0;
      assert.deepEqual(pageErrors, [], '页面不应有 JS 异常，实际：' + pageErrors.join(' || '));
    } finally {
      await browser.close();
    }
  }

  // ===== ⑰ 复核补齐：字段目录与写作规格一致 / 空值可解锁 / 所见即所确认（空文本不回落原稿） =====
  {
    // ① 「哪些字段是 AI 文案字段」只有一个真源 = 字段目录（ai:true）；写作规格表不能漏字段
    //    （漏了 → 生成时才炸；目录与规格分叉必须响亮，不能静默少一个字段）。
    const prof = await import('../../apply-profile.mjs');
    const gen = await import('../../apply-gen.mjs');
    assert.deepEqual([...prof.AI_COPY_KEYS].sort(), ['coverLetter', 'followUp', 'greeting'],
      'AI 文案字段集合应与字段目录一致，实际：' + JSON.stringify(prof.AI_COPY_KEYS));
    for (const k of prof.AI_COPY_KEYS) {
      assert.ok(gen.copySpec(k), '目录里的 AI 字段「' + k + '」必须有写作规格（规格表不能漏）');
      assert.ok(gen.isCopyKey(k), '目录里的 AI 字段「' + k + '」应被 isCopyKey 认');
    }
    assert.equal(gen.isCopyKey('name'), false, '非 AI 字段不得被认成 AI 文案字段');

    // ② 空值锁定后**仍可解锁**：「保存」空值会把字段锁上，若解锁再报「无可解锁」就成了死路。
    await postJson('/apply/field', { scope: { kind: 'common' }, key: 'followUp', mode: 'override', value: '' });
    const un = await postJson('/apply/field', { scope: { kind: 'common' }, key: 'followUp', mode: 'ai' });
    assert.equal(un.status, 200, '空值锁定后解锁应 200（不留死路），实际 ' + un.status + ' ' + un.text.slice(0, 200));
    const fUn = fieldValue('common', 'followUp');
    assert.equal(fUn && fUn.locked, false, '解锁后不应再是锁定态，实际：' + JSON.stringify(fUn));

    // ③ 所见即所确认：传了 text（哪怕空串）就落那份；没传 text 才回落原稿。
    const st3 = await waitCopy('common', 'greeting', (x) => x.task && x.task.status !== 'running');
    const conf3 = await postJson('/apply/copy/confirm', { scope: { kind: 'common' }, key: 'greeting', draftId: st3.draft.id, text: '' });
    assert.equal(conf3.status, 200, '空文本确认应 200，实际 ' + conf3.status + ' ' + conf3.text.slice(0, 200));
    const f3 = fieldValue('common', 'greeting');
    assert.equal(String((f3 && f3.value) || ''), '', '传了空文本确认后应落空值（所见即所确认，不回落原稿），实际：' + JSON.stringify(f3 && f3.value));

    // ④ 服务端渲染路径：任务 done 且 usage=null 时，页面状态行也要显式说「服务商未返回」（不编 0）
    llmMode = 'nousage';
    await postJson('/apply/copy/discard', { scope: { kind: 'common' }, key: 'greeting' });
    const st4 = await waitCopy('common', 'greeting', (x) => x.task && x.task.status !== 'running');
    assert.equal(st4.task && st4.task.usage, null,
      '服务商没返回 usage 时任务应记 null（不编 0），实际：' + JSON.stringify(st4.task && st4.task.usage));
    const html4 = (await get('/apply-profile')).text;
    const row4 = rowOf(html4, 'greeting');
    assert.ok(row4.includes('用量：服务商未返回'),
      '服务端渲染也须显式说「服务商未返回」（不编 0、不省略用量字样），实际片段：' + row4.slice(0, 400));
    llmMode = 'good';
  }

  // ===== ⑮ DESIGN.md 红线自查（本卡新写代码，源级扫描） =====
  {
    const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    const genRules = srv.split('\n').filter((l) => { const t = l.trim(); return t.startsWith('.ap-gen') && t.includes('{'); });
    assert.ok(genRules.length > 0, '应有 .ap-gen* 样式规则（AI 文案生成区）');
    for (const line of genRules) {
      assert.ok(!/box-shadow/.test(line), '应用页新写规则不得有 box-shadow（§3.1），实际：' + line.trim());
      assert.ok(!/border-radius:\s*\d/.test(line), '圆角必须走 --radius/--radius-lg token（§5.2），实际：' + line.trim());
      const badSpacing = line.match(/(?:padding|margin|gap)(?:-(?:top|right|bottom|left))?:\s*[^;{}]*\d+px/g) || [];
      assert.deepEqual(badSpacing, [], '新写规则的间距必须用 --space-* token（§5.1），实际：' + JSON.stringify(badSpacing) + ' @ ' + line.trim());
    }
    // 冻结件零改动（本卡只碰应用页与数据层）
    const classic = fs.readFileSync(path.join(APP_ROOT, 'themes', 'resume-classic.css'));
    assert.equal(createHash('sha1').update(classic).digest('hex'), 'e6efa7fa09f10e658ba73d62d4866aa1e24f5c1f',
      'themes/resume-classic.css 是渲染契约，不得改动');
  }

  console.log('✅ AI 文案字段：三类字段进字段包 + 无模型明确降级 + 生成→预览→确认才入库 + 覆写锁定不被再生覆盖 + 取消迟到零落账 + 真实用量/无百分比 + 并发闸');
} catch (e) {
  console.error('❌ ' + (e && e.stack || e));
  process.exitCode = 1;
} finally {
  cleanup();
}
