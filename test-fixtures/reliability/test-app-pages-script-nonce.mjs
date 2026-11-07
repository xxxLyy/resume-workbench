// test-app-pages-script-nonce.mjs — 批 5 b5c2：应用页内联脚本块 nonce 化 + script-src 收口 'self'
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §6-1（CSP 'unsafe-inline' 移除：内联脚本块 → 外置或 nonce 化；
//       收口 script-src 'self'）。本卡裁决：全部内联块 nonce 化（send() 响应时现发一次性 nonce），
//       因为既有断言多处从 server.mjs 源码/渲染 HTML 抽取内联脚本内容（test.sh:448 沙箱跑首页脚本、
//       test-structure.sh EV-7 从页面抠 EVAL_CARD_JS 单跑、test-structure.sh 源级钉设置页脚本）——
//       外置文件会让这些断言全部失锚，nonce 化则零断言迁移。
// 口径：
//   ① 应用页（page() 模板）每个内联 <script> 块都带 nonce，且等于该响应 CSP script-src 里的 nonce；
//      script-src 收口 'self' 'nonce-…'，'unsafe-inline' 移除（2026-11-07 b5c2）。
//   ② /edit 既有 nonce+sha256 口径不动；/snapshot/view 锁定策略不动（本夹具核对未被默认策略波及）。
//   ③ 数据块（var APPS/DATA/MATS/APPID/EVAL_RECORDS）载荷仍随页下发（nonce 块内）。
// 覆盖：
//   A 15 个页面形态：零 nonce 的内联 <script> 一个都不能有；带 nonce 的必须与 CSP 同值；占位符不残留；
//   B script-src 无 'unsafe-inline'、不放外部主机；关键指令仍在；
//   C nonce 逐响应现发（两次请求 nonce 不同）；
//   D 数据块载荷仍在 + 页壳三件（__status/__acts/__wv）仍随页下发；
//   E 每个内联块内容可独立通过 node --check（历史上这些块从未被语法验证过）；
//   F /edit（nonce+hash）与 /snapshot/view（锁定）策略原样；
//   G JSON 接口不带 CSP。
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成数据；不读真实简历、不碰 7766、不调真实模型；仓库零写入。
// 隐私门禁：合成数据不含 ≥11 位连续数字（门禁 1[3-9]\d{9} 不适用）。
// 退出码契约：0=全部通过；1=任一断言失败（本夹具不依赖 Chromium）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// —— 合成数据（长数字第二位避开 3-9：投递 id '11075'、快照 ts '2026-10-20-101010' 均不含 ≥11 位连续数字）——
// d1 用真模板装配（同 test-home-eval-card-removed 的种子法）：/edit 的 sha256 放行路径要对真编辑器主脚本成立，
// 合成裸 HTML 的外来脚本本来就该被 /edit 的 hash 白名单拒（那是它自己的防护，不是本卡要核对的对象）。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-scriptnonce-'));
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

  // 覆盖每个 page() 页面形态（含 onboarding 三种脚本态：0.1 基础 / 0.3 条目卡 OB_CARDS_JS / 0.7 照片步 OB_PHOTO_JS）
  const pages = ['/', '/job/new', '/apply-profile', '/materials', '/evals', '/snapshots?id=d1',
    '/applications', '/applications?view=table', '/app?id=11075', '/settings', '/stats', '/export?id=d1',
    '/onboarding', '/onboarding?next=0.3', '/onboarding?next=0.7'];
  const nonceRe = /<script nonce="([A-Za-z0-9+/=]+)">([\s\S]*?)<\/script>/g;
  const bareInlineRe = /<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)[^>]*>/g;
  const cspNonceOf = (csp) => {
    const m = /script-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp || '');
    return m ? m[1] : '';
  };
  const checked = new Set();   // node --check 去重（页壳块各页重复）
  let totalNonceBlocks = 0;
  const syntaxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptnonce-js-'));
  let syntaxSeq = 0;

  for (const p of pages) {
    const r = await get(p);
    const ct = String(r.headers['content-type'] || '');
    if (!/text\/html/.test(ct)) fail(`${p} 不是 HTML 页（HTTP ${r.status}，${ct}）：${r.body.slice(0, 300)}`);
    // B：script-src 收口（无 unsafe-inline、无外部主机）+ 关键指令仍在
    //（unsafe-inline 只查 script-src 段——style-src 'unsafe-inline' 是既有口径，不在本卡范围）
    const csp = r.headers['content-security-policy'] || '';
    if (!csp) fail(`${p} 无 CSP 头`);
    const sc = /script-src([^;]*)/.exec(csp);
    if (!sc) fail(`${p} CSP 缺 script-src：${csp}`);
    if (/unsafe-inline/.test(sc[1])) fail(`${p} script-src 仍放行 'unsafe-inline'（b5c2 未收口）：${csp}`);
    if (/https?:|\*/.test(sc[1])) fail(`${p} script-src 放行了外部主机：${csp}`);
    if (!csp.includes("default-src 'self'") || !csp.includes("base-uri 'none'")) fail(`${p} 关键指令缺失：${csp}`);
    // A：每个内联块必须带 nonce 且与 CSP 同值；零 nonce 的内联标签一个不能有
    const wantNonce = cspNonceOf(csp);
    if (!wantNonce) fail(`${p} CSP script-src 缺一次性 nonce（应为 'self' 'nonce-…'）：${csp}`);
    const bare = [...r.body.matchAll(bareInlineRe)].map((m) => m[0]);
    if (bare.length) fail(`${p} 存在未 nonce 化的内联 <script>（CSP 下会被浏览器拒执行）：${JSON.stringify(bare)}`);
    if (r.body.includes('__CSP_NONCE__')) fail(`${p} nonce 占位符泄漏到响应（send() 替换未生效）`);
    let n = 0;
    for (const m of r.body.matchAll(nonceRe)) {
      if (m[1] !== wantNonce) fail(`${p} 第 ${n + 1} 个内联块的 nonce 与 CSP 不一致（CSP=${wantNonce}，标签=${m[1]}）`);
      n++;
      if (!checked.has(m[2])) {
        checked.add(m[2]);
        const f = path.join(syntaxTmp, 'blk' + (++syntaxSeq) + '.js');
        fs.writeFileSync(f, m[2]);
        const ck = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
        if (ck.status !== 0) fail(`${p} 第 ${n} 个内联块语法校验失败（node --check）:${(ck.stderr || '').slice(0, 400)}`);
      }
    }
    totalNonceBlocks += n;
    if (n < 2) fail(`${p} nonce 化内联块只有 ${n} 个（页壳至少 2 块：状态+委托分发 / 写助手），脚本注入层被误伤？`);
  }
  fs.rmSync(syntaxTmp, { recursive: true, force: true });
  if (totalNonceBlocks < 20) fail(`15 页合计 nonce 化内联块仅 ${totalNonceBlocks} 个（应 ≥20：页壳 2×15 + 各页脚本块）`);

  // C：nonce 逐响应现发（同一路由两次请求 nonce 不同）
  const n1 = cspNonceOf((await get('/')).headers['content-security-policy']);
  const n2 = cspNonceOf((await get('/')).headers['content-security-policy']);
  if (!n1 || !n2 || n1 === n2) fail(`nonce 应逐响应现发（两次请求 ${n1 ? '相同' : '缺失'}）`);
  if ((await get('/applications')).body.includes(n1)) fail('上一次响应的 nonce 出现在另一响应里（nonce 复用）');

  // D：数据块载荷仍在 + 页壳三件仍随页下发
  const dApp = (await get('/applications')).body;
  if (!dApp.includes('var APP_STATUSES') || !dApp.includes('var APPS =')) fail('/applications 的 APP_STATUSES/APPS 数据块丢失');
  if (!dApp.includes('合成公司')) fail('/applications 的投递记录数据未随页下发');
  const dSet = (await get('/settings')).body;
  if (!/var DATA = \{/.test(dSet)) fail('/settings 的 DATA 数据块丢失');
  const dMat = (await get('/materials')).body;
  if (!dMat.includes('var MATS =')) fail('/materials 的 MATS 数据块丢失');
  const dAppPage = (await get('/app?id=11075')).body;
  if (!dAppPage.includes("var APPID = ") || !dAppPage.includes('11075')) fail('/app 的 APPID 数据块丢失');
  const dEval = (await get('/evals')).body;
  if (!dEval.includes('var EVAL_RECORDS =')) fail('/evals 的 EVAL_RECORDS 数据块丢失');
  const dJobNew = (await get('/job/new')).body;
  if (!dJobNew.includes('EVAL_CARD_JS_START')) fail('/job/new 的报告渲染器（EVAL_CARD_JS）丢失（EV-7 抽取锚点）');
  const home = (await get('/')).body;
  if (!home.includes('window.__status') || !home.includes('window.__acts') || !home.includes('window.__wv')) {
    fail('页壳三件（__status/__acts/__wv）未随首页下发');
  }

  // F：/edit 既有 nonce+sha256 口径不动；/snapshot/view 锁定策略不动
  //（unsafe-inline 只查 script-src 段：/edit 与应用页的 style-src 'unsafe-inline' 是既有口径，不动）
  const edit = (await get('/edit?id=d1')).headers['content-security-policy'] || '';
  const esc = /script-src([^;]*)/.exec(edit);
  if (!esc || !/'nonce-/.test(esc[1]) || !esc[1].includes("'sha256-") || /unsafe-inline/.test(esc[1])) {
    fail('/edit 的 nonce+hash 策略被波及（b5c2 口径：不动）：' + edit);
  }
  const snap = (await get('/snapshot/view?id=d1&ts=2026-10-20-101010')).headers['content-security-policy'] || '';
  if (!snap.includes("default-src 'none'")) fail('/snapshot/view 锁定策略被波及：' + snap);

  // G：JSON 接口不带 CSP（nonce 机制只作用于 HTML）
  const j = await get('/job/changes?id=d1');
  if (j.headers['content-security-policy']) fail('JSON 接口不应带 CSP：' + j.headers['content-security-policy']);

  console.log('✅ b5c2 应用页内联脚本 nonce 化：15 页面形态 ' + totalNonceBlocks + ' 个内联块全部带同响应 nonce、'
    + "script-src 收口 'self' 'nonce-…'（无 unsafe-inline）、nonce 逐响应现发、占位符零残留、"
    + '数据块与页壳三件仍随页下发、内联块逐个过 node --check；/edit nonce+hash 与快照锁定策略原样；JSON 接口不受影响');
} finally {
  cleanup();
}
