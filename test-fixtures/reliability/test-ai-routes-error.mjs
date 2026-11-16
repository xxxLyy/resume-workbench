// test-ai-routes-error.mjs — 7 个 /ai/* 路由必须捕获模型调用异常并回 {ok:false,error} JSON（BL-P4-03）
// 背景：/ai/prep、/ai/rewrite、/ai/chat、/ai/review、/ai/zone-analyze、/ai/zone-rewrite
// 的 await chat()/chatMsgs() 均无 try/catch：模型超时/拒连等异常一路冒到顶层错误出口，
// 回 500 text/plain（'server error: …'）→ 客户端 postJson 只在 JSON 体里找错误信息，
// 用户最终只见『HTTP 500』，真因（超时/网络/格式）全丢。对照组 /eval/create 对同一个 chat()
// 有 try/catch 并回 502 JSON（error='模型调用失败：…'）—— 本夹具把 7 条路由拉齐到该口径。
// 手法：隔离 RESUME_ROOT + config.json 指向必拒连的桩 baseURL（http://127.0.0.1:9/v1，
// discard 端口，回环拒连毫秒级返回）→ 每条路由的模型调用都真实走网络失败路径。
// 断言（每条路由）：状态 502 + content-type JSON + ok===false + error 含可读前缀『模型调用失败』。
// 约束：隔离根 + 合成文档/合成投递记录；不读真实数据、不起浏览器、不碰 7766。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-aier-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 桩模型配置：baseURL 指向 127.0.0.1:9（discard，必拒连）。key 为占位假值，不指向任何真实凭证。
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0,
  profiles: [{ name: 'stub', baseURL: 'http://127.0.0.1:9/v1', apiKey: 'stub-key-not-real', model: 'stub-model' }],
}));
// 合成母版：含一个带 data-zid 的段落（zone-rewrite 需要 free 段非空才会走到模型调用）
fs.writeFileSync(path.join(root, 'docs', 'synth.html'),
  '<!doctype html><html><body><script>var DOC_ID = \'synth\';</script>' +
  '<p data-zid="z11111111">负责高并发服务治理</p></body></html>');
// meta：把该段落登记进 work 区（zone-rewrite 的 free 过滤依据），rev/baseMtime 链路需要的最小字段
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({
  synth: { rev: 1, zones: { z11111111: { zone: 'work', status: 'confirmed' } } },
}));
// 合成投递记录（/ai/prep 按 body.id 查 applications）
fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([
  { id: '9001-1', docId: 'synth', company: '合成公司', role: '工程师', jd: '负责存储层改造', status: '投递中' },
]));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });

const post = (p, obj) => new Promise((resolve, reject) => {
  const body = JSON.stringify(obj);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (r) => { let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b })); });
  req.on('error', reject);
  req.end(body);
});
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    r.resume(); r.on('end', () => resolve());
  }).on('error', reject);
});

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { await get('/'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // zone 路由必须带「已确认正文版本」的 baseMtime（zoneRequestError 严格相等校验）
  const baseMtime = fs.statSync(path.join(root, 'docs', 'synth.html')).mtimeMs;

  // 7 条路由 × 各自最小合法请求体（全部通过参数校验、直抵模型调用）
  const cases = [
    ['POST /ai/prep',        '/ai/prep',                       { id: '9001-1' }],
    ['POST /ai/rewrite',     '/ai/rewrite',                    { text: '负责高并发服务治理', instruction: '改得更量化' }],
    ['POST /ai/chat',        '/ai/chat',                       { id: 'synth', message: '帮我把第一段改量化' }],
    ['POST /ai/review',      '/ai/review',                     { id: 'synth', mode: 'full' }],
    ['POST /ai/zone-analyze','/ai/zone-analyze?id=synth',      { zone: 'work', baseMtime }],
    ['POST /ai/zone-rewrite','/ai/zone-rewrite?id=synth',      { zone: 'work', baseMtime, instruction: '改得更量化' }],
  ];

  for (const [label, p, body] of cases) {
    const r = await post(p, body);
    const ct = String(r.headers['content-type'] || '');
    let json = null;
    try { json = JSON.parse(r.body); } catch {}
    // ① 状态码：502（对齐 /eval/create 对同一 chat() 的 catch 口径），而不是顶层出口的 500
    if (r.status !== 502) fail(label + '：预期 502 JSON，实际 ' + r.status + ' ' + ct + ' body=' + r.body.slice(0, 200));
    // ② 必须是 JSON 体——text/plain 的 'server error: …' 会被客户端整体丢掉，只剩 HTTP 状态码
    if (!ct.includes('application/json')) fail(label + '：content-type 不是 JSON：' + ct + ' body=' + r.body.slice(0, 200));
    // ③ 错误体与既有格式对齐：ok:false + 可读原因（『模型调用失败：』前缀 + 底层 message）
    if (!json || json.ok !== false) fail(label + '：响应体缺 ok:false：' + r.body.slice(0, 200));
    if (typeof json.error !== 'string' || !json.error.includes('模型调用失败') || json.error === '模型调用失败：')
      fail(label + '：error 缺可读原因：' + JSON.stringify(json.error));
    console.log('  ✓ ' + label + ' → 502 JSON，error=' + json.error);
  }

  console.log('✅ 7 个 /ai/* 路由：模型调用异常均回 502 {ok:false,error:可读原因}，不再 500 text/plain');
} finally {
  cleanup();
}
