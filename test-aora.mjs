// test-aora.mjs — aora-bot 接入断言。退出码 0=全过；1=任一断言失败。
// 隔离 RESUME_ROOT；不碰 7766、不调模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-aora-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 空数据文件预 seed：各页读取路径按既有缺省口径落 [] / {}，避免读空文件炸
for (const [f, v] of [['docs-meta.json', '{}'], ['applications.json', '[]'], ['interviews.json', '[]'], ['materials.json', '{}'], ['agent-sessions.json', '[]']])
  fs.writeFileSync(path.join(root, f), v);
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
// exit 钩子在 spawn 后、启动等待前挂：15s 超时 rej 也杀 server 并清隔离根（对齐 test-apps-settings-forms.mjs 先例）
process.on('exit', () => {
  try { server.kill(); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('server 启动超时')), 15000); server.stdout.on('data', (b) => { if (String(b).includes('简历平台')) { clearTimeout(t); res(); } }); });
const get = (p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.text().then((body) => ({ status: r.status, ct: r.headers.get('content-type') || '', body })));

// A. /aora-bot.js 路由 200 + content-type + 体积
const a = await get('/aora-bot.js');
assert.equal(a.status, 200, '/aora-bot.js 应 200');
assert.match(a.ct, /application\/javascript/, '/aora-bot.js content-type');
assert.ok(a.body.length > 300000, 'vendored 文件体积应 >300KB');
console.log('✅ A /aora-bot.js 路由');

// A2. /aora-face.js 断言归位（文件本任务落地）
const f = await get('/aora-face.js');
assert.equal(f.status, 200, '/aora-face.js 应 200');
assert.match(f.body, /AoraFace/, 'aora-face.js 应导出 AoraFace');

// C. 映射表状态名 ∈ engine 44 全集；动词值域无未知态
const { CHARACTER_STATES } = await import('@aora-bot/engine/static');
const src = fs.readFileSync(path.join(APP_ROOT, 'aora-face.js'), 'utf8');
const mapBlock = src.slice(src.indexOf('var MAP = {'), src.indexOf('};', src.indexOf('var MAP = {')));
const vals = [...mapBlock.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1]);
assert.ok(vals.length >= 15, '映射表应覆盖三页动词');
for (const v of vals) assert.ok(CHARACTER_STATES.includes(v), '非法状态名: ' + v);
for (const p of ['agent', 'interview', 'ai-helper']) assert.ok(mapBlock.includes("'" + p + "'"), '缺页: ' + p);
console.log('✅ C 映射表合法');
// D. 页面接线断言
const setp = await get('/settings');
assert.ok(setp.body.includes('Powered by') && setp.body.includes('aora-bot'), '设置页署名卡');
const agp = await get('/agent');
assert.ok(agp.body.includes('/aora-bot.js') && agp.body.includes('/aora-face.js'), 'agent 页脚本注入');
assert.ok(agp.body.includes('type="module" src="/aora-bot.js"'), 'agent 页 /aora-bot.js 应以 module 加载');
const ivp = await get('/interview');
assert.ok(ivp.body.includes('/aora-bot.js') && ivp.body.includes('/aora-face.js'), 'interview 页脚本注入');
assert.ok(ivp.body.includes('type="module" src="/aora-bot.js"'), 'interview 页 /aora-bot.js 应以 module 加载');
const ahp = await get('/ai-helper');
assert.ok(ahp.body.includes('/aora-bot.js') && ahp.body.includes('/aora-face.js'), 'ai-helper 页脚本注入');
assert.ok(ahp.body.includes('type="module" src="/aora-bot.js"'), 'ai-helper 页 /aora-bot.js 应以 module 加载');
console.log('✅ D 页面接线');
// E. 面板接线源级断言
const ag = fs.readFileSync(path.join(APP_ROOT, 'agent-panel.js'), 'utf8');
for (const needle of ["AoraFace.mount(slot, { page: 'agent'", "AoraFace.set(face, 'send')", "AoraFace.set(face, 'stream')", "AoraFace.set(face, 'done')", "AoraFace.set(face, 'error')", 'AoraFace.compact(face)'])
  assert.ok(ag.includes(needle), 'agent-panel 缺: ' + needle);
console.log('✅ E agent-panel 接线');
// F. interview 面板接线源级断言
const iv = fs.readFileSync(path.join(APP_ROOT, 'interview-panel.js'), 'utf8');
for (const needle of ["page: 'interview'", "fset('send')", "fset('stream')", "fset('done')", "fset('error')", "wait-user"])
  assert.ok(iv.includes(needle), 'interview-panel 缺: ' + needle);
console.log('✅ F interview-panel 接线');
// G. ai-helper 面板接线源级断言
const ah = fs.readFileSync(path.join(APP_ROOT, 'ai-helper-panel.js'), 'utf8');
for (const needle of ["page: 'ai-helper'", "fset('send')", "fset('stream')", "fset('done')", "fset('error')"])
  assert.ok(ah.includes(needle), 'ai-helper-panel 缺: ' + needle);
console.log('✅ G ai-helper-panel 接线');
// H. 眼神追踪接线
const af = fs.readFileSync(path.join(APP_ROOT, 'aora-face.js'), 'utf8');
assert.ok(af.includes('followTarget'), 'aora-face 应含 followTarget 驱动');
assert.ok(ag.includes('follow: true') && iv.includes('follow: true') && ah.includes('follow: true'), '三页 mount 应带 follow: true');
console.log('✅ H 眼神追踪');
console.log('✅ test-aora 全部通过');
server.kill(); process.exit(0);
