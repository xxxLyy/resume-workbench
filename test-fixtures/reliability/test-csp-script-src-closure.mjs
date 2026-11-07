// test-csp-script-src-closure.mjs — 批 5 b5c3：CSP 收口终检（响应头实测，全站 HTML 路由面）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §6-1（CSP 'unsafe-inline' 移除：收口 script-src 'self'；
//       全站按钮回归=既有浏览器夹具+新增委托行为夹具——委托行为由 test-inline-delegation.mjs 与
//       test.sh 浏览器段承载，本夹具只负责「响应头实测无 unsafe-inline」这一半）。
// 与既有 CSP 夹具的分工（不重复造轮子，只补覆盖面）：
//   test-app-pages-csp.mjs      —— 默认策略通道锁（img/connect/base/object/frame），断言 script-src 不放外部主机；
//   test-app-pages-script-nonce.mjs —— b5c2：15 页面形态 nonce 同值、占位符零残留、内联块语法；
//   本夹具（b5c3）—— **全部** GET HTML 路由的响应头实测收口终检：
//     ① 20 个路由形态（含 b5c2 清单之外的 /diff、/theme-preview、/edit 404 页）逐路由实测
//        Content-Security-Policy 响应头；
//     ② 带 script-src 的路由：script-src 必须以 'self' 开头（收口 → 'self' [nonce|hash]），不得含
//        'unsafe-inline'，不得放外部主机（https?:/*）；
//     ③ 锁定预览（/snapshot/view、/theme-preview，LOCKED_PREVIEW_CSP 无 script-src 段）：default-src
//        'none' 必须在场（脚本被一刀切关死，'unsafe-inline' 无处附着）；
//     ④ /edit 显式策略仍为 'self' 'nonce-…' 'sha256-…'（b5c2 口径：不动）。
// 口径说明：style-src 'unsafe-inline' 是既有口径（b5c2 裁决不动），本夹具只查 script-src 段——
//   与 test-app-pages-script-nonce.mjs:103 的边界注释同一口径。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成数据；不读真实简历、不碰 7766、不调真实模型；仓库零写入。
// 隐私门禁：合成数据不含 ≥11 位连续数字（投递 id '11075'、快照 ts '2026-10-20-101010'，门禁 1[3-9]\d{9} 不适用）。
// 退出码契约：0=全部通过；1=任一断言失败（本夹具不直接依赖 Chromium；/export stale 自动渲染复用环境既有渲染通道）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// —— 合成数据（同 test-app-pages-script-nonce.mjs 的种子法：d1 用真模板装配，/edit 的 sha256
// 放行路径才对真编辑器主脚本成立；长数字第二位避开 3-9）——
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-cspclosure-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
let d1 = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', ''],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'd1']]) d1 = d1.replaceAll(k, () => v);
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), d1);
fs.mkdirSync(path.join(root, 'snapshots', 'd1'), { recursive: true });
fs.writeFileSync(path.join(root, 'snapshots', 'd1', '2026-10-20-101010.html'), d1);
fs.writeFileSync(path.join(root, 'pdfs', 'd1.pdf'), '%PDF-1.4 fake\n');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));
fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([
  { id: '11075', company: '合成公司', role: '合成岗位', docId: 'd1', status: '面试中', appliedAt: '2026-11-01', channel: '官网' }
]));
fs.writeFileSync(path.join(root, 'materials.json'), JSON.stringify([
  { id: 'm1', title: '合成素材', brief: '精简表达内容', technical: '技术表达内容', interview: '面试讲述内容',
    tags: ['合成'], factStatus: 'pending', facts: { company: '合成公司', role: '合成岗位' } }
]));
fs.writeFileSync(path.join(root, 'evaluations.json'), '[]');

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
process.on('exit', cleanup);
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: b }));
  }).on('error', reject);
});

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { await get('/'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    if (i === 149) fail('服务 30s 未就绪\n' + serverLog.slice(-800));
  }

  // 全部 GET HTML 路由形态（枚举依据：server.mjs 内 send(200, page(…))/send(200, html, 'text/html') 的
  // 路由清单 grep 实测（本卡 2026-11-07）：/ 4093、/edit 4098、/onboarding 4227/4234、/job/new 4481、
  // /evals 4568、/apply-profile 4582、/materials 5925、/snapshot/view 6112、/theme-preview 6127、
  // /snapshots 6191、/diff 6256/6266、/applications 6283/6395、/app 6850、/settings 7022、/stats 7493/7568、
  // /export 8220；/edit 404 页 4104。锁定预览两条无 script-src 段，其余全部走默认 CSP 拼装或 /edit 显式策略。
  const lockedPreview = ['/snapshot/view?id=d1&ts=2026-10-20-101010', '/theme-preview?id=d1&theme=classic'];
  const editExplicit = ['/edit?id=d1'];   // 显式 nonce+sha256 策略
  const defaultPages = ['/', '/?archived=1', '/job/new', '/apply-profile', '/materials', '/evals',
    '/snapshots?id=d1', '/applications', '/applications?view=table', '/app?id=11075', '/settings',
    '/stats', '/export?id=d1', '/onboarding', '/onboarding?next=0.3', '/diff?base=d1',
    '/edit?id=no-such-doc'];   // 末位为 404 页（page() 兜底，同样必须带默认 CSP）
  const measured = { withScriptSrc: 0, locked: 0 };

  const assertCsp = (p, r) => {
    const ct = String(r.headers['content-type'] || '');
    if (!/text\/html/.test(ct)) fail(`${p} 不是 HTML 页（HTTP ${r.status}，${ct}）：${r.body.slice(0, 200)}`);
    const csp = r.headers['content-security-policy'] || '';
    if (!csp) fail(`${p}（HTTP ${r.status}）无 CSP 头（响应头实测失败）`);
    const sc = /script-src([^;]*)/.exec(csp);
    if (sc) {
      const seg = sc[1].trim();
      measured.withScriptSrc++;
      if (!seg.startsWith("'self'")) fail(`${p} script-src 未收口为 'self' 开头：${csp}`);
      if (/unsafe-inline/.test(seg)) fail(`${p} script-src 仍含 'unsafe-inline'（收口失败）：${csp}`);
      if (/https?:|\*/.test(seg)) fail(`${p} script-src 放行外部主机：${csp}`);
    } else {
      // 锁定预览：无 script-src 段 → 脚本唯一通道是 default-src，必须 'none' 一刀切。
      //（style-src 'unsafe-inline' 是 LOCKED_PREVIEW_CSP 的既有登记口径（横幅/正文观感），server.mjs:105，
      //  b5c2 裁决 style-src 不动——本夹具边界同 test-app-pages-script-nonce.mjs:103：只查脚本通道。）
      measured.locked++;
      if (!csp.includes("default-src 'none'")) fail(`${p} 无 script-src 段但 default-src 不是 'none'（脚本通道未关死）：${csp}`);
    }
  };

  for (const p of defaultPages) assertCsp(p, await get(p));
  for (const p of editExplicit) assertCsp(p, await get(p));
  for (const p of lockedPreview) assertCsp(p, await get(p));

  // /edit 显式策略的收口形态：'self' 开头 + nonce + sha256（b5c2 口径：/edit 不动，但 'unsafe-inline' 同样不得出现）
  const edit = (await get('/edit?id=d1')).headers['content-security-policy'] || '';
  const esc = /script-src([^;]*)/.exec(edit);
  if (!esc || !/'nonce-/.test(esc[1]) || !esc[1].includes("'sha256-")) fail('/edit 的 nonce+hash 策略形态不符（应保持不动）：' + edit);

  // 全站实测汇总线（响应头实测：每条都是真实 HTTP 响应头，不是源码静态扫描）
  console.log('✅ b5c3 CSP 收口终检（响应头实测）：' + (defaultPages.length + editExplicit.length + lockedPreview.length)
    + ' 个 HTML 路由形态全部实测——script-src 带 ' + measured.withScriptSrc + ' 条全部以 ' + "'self'" + ' 开头且无 '
    + "'unsafe-inline'" + ' 不放外部主机；锁定预览 ' + measured.locked + ' 条 default-src ' + "'none'"
    + '（脚本通道一刀切）；/edit nonce+hash 策略原样');
} finally {
  cleanup();
}
