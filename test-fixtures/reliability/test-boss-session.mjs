// test-boss-session.mjs — JD 网址导入轨 B T4：Boss 会话（spec dev-docs/2026-11-12-jd-import-bookmarklet-design.md §2.4/§4，DESIGN.md §10.20）
// 断言（任务卡）：
//   ① GET /boss/session/status 未登录形 → {ok:true, logged:false, loggedAt:null}；
//   ② POST /boss/session/logout → {ok:true}，boss-session/ 目录被清理（不存在的目录亦 ok）；
//   ③ 手写假 state.json → status → {ok:true, logged:true, loggedAt}（合法 loggedAt 才算已登录）；
//   ④ 已登录态 POST /boss/session/login → {ok:true, logged:true} 短路（不起浏览器）；
//   ⑤ 未登录态并发 2×login → 恰一个「登录进行中」（409）+ 一个「未检测到登录」（假上下文模拟关窗）；
//   ⑥ zhipin 链接 + 有会话 + stub htmlFile=zhipin 夹具 → /job/create 200：jd/company/role 三字段
//     全落 meta（用户未填时回填——新增行为）；用户已填 company/role 时不被提取值覆盖；
//   ⑦ stub finalUrl=/security → /job/create → 400「Boss 会话已失效，请重新登录或改用书签」+ 无孤儿文档
//      + state.json 写 deadAt（status 透传 dead:true）；stub 全缺席（空 HTML）与「无 _jobInfo 的
//      body 页」→ 同判 SESSION_DEAD（第二判据收紧：_jobInfo 缺席且 via=body）；
//   ⑧ /job/new 有母版分支渲染 Boss 会话卡（data-action 委托、零内联事件、status 读取脚本在场、
//      橙点失效态文案「会话失效 · 需重新登录」+ 400 错误分支亮 jdFailHint 接线）；
//   ⑨ 源级：visibility 覆盖脚本（document.hidden/visibilityState）、串行锁（bossFetchChain）、
//      launchPersistentContext 唯一调用点（注入点 bossLaunchContext）、userDataDir=profile 子目录；
//   ⑩ 抓取串行锁【行为断言】：两个并发 zhipin 建稿（stub markFile 记 S/E 时间线 + delayMs 撑让行窗口）
//      → 标记文件恰呈 [S,E,S,E]（无锁时第二抓的 S 必然插进第一抓的 S/E 之间）。
// 手法：隔离 RESUME_ROOT + 随机端口真实 server + RESUME_TEST_NO_BROWSER=1 假上下文（不真开浏览器）；
//       RESUME_TEST_BOSS_STUB_FILE 指向 JSON {finalUrl?, htmlFile?}，每请求重读 → 单进程覆盖成败两形。
// 不读真实数据、不碰 7766、不调真实模型、不真实扫码（真人扫码留 T5 人工点验）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-boss-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 一份合成母版（/job/new 有母版分支 + /job/create from 需要）
let d1 = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'd1']]) d1 = d1.replaceAll(k, () => v);
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), d1);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));

const stubFile = path.join(root, 'boss-stub.json');
const BOSS_DIR = path.join(root, 'boss-session');
const STATE_FILE = path.join(BOSS_DIR, 'state.json');
const metaPath = path.join(root, 'docs-meta.json');
const writeSession = (loggedAt) => { fs.mkdirSync(BOSS_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify({ loggedAt })); };

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT,
  env: { ...process.env, RESUME_ROOT: root, PORT: String(port),
    RESUME_TEST_NO_BROWSER: '1', RESUME_TEST_LOGIN_MS: '600', RESUME_TEST_BOSS_STUB_FILE: stubFile },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });   // fail() 走 process.exit 也不留孤儿
const base = `http://127.0.0.1:${port}`;
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};

const getJson = async (p) => { const r = await fetch(base + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: t }; };
const postJson = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① status 未登录形 =====
  {
    const r = await getJson('/boss/session/status');
    assert.equal(r.status, 200, 'status 应 200');
    assert.deepEqual(r.json, { ok: true, logged: false, loggedAt: null, dead: false, deadAt: null }, '未登录形应为 {ok,logged:false,loggedAt:null,dead:false,deadAt:null}，实际 ' + r.text);
  }

  // ===== ② logout 清目录（目录不存在亦 ok:true）=====
  {
    const r = await postJson('/boss/session/logout');
    assert.equal(r.status, 200, 'logout 应 200');
    assert.equal((r.json || {}).ok, true, 'logout 应 {ok:true}');
    assert.ok(!fs.existsSync(BOSS_DIR), 'logout 后 boss-session/ 不应存在');
  }

  // ===== ③ 假 state.json → 已登录形；非法 loggedAt → 未登录 =====
  {
    const ts = new Date().toISOString();
    writeSession(ts);
    const r = await getJson('/boss/session/status');
    assert.deepEqual(r.json, { ok: true, logged: true, loggedAt: ts, dead: false, deadAt: null }, '已登录形应带 loggedAt 且 dead:false');
    writeSession('not-a-date');
    const r2 = await getJson('/boss/session/status');
    assert.equal((r2.json || {}).logged, false, '非法 loggedAt 应按未登录');
    writeSession(ts);   // 恢复合法态供后续用例
  }

  // ===== ④ 已登录短路：login → {ok:true, logged:true}（不起浏览器、不建 profile 子目录）=====
  {
    const r = await postJson('/boss/session/login');
    assert.equal(r.status, 200, '已登录短路应 200');
    assert.deepEqual(r.json, { ok: true, logged: true }, '已登录短路应 {ok:true,logged:true}，实际 ' + r.text);
    assert.ok(!fs.existsSync(path.join(BOSS_DIR, 'profile')), '短路不得创建 profile 子目录');
  }

  // ===== ⑤ 并发锁：未登录态 2×login → 恰一个「登录进行中」+ 一个「未检测到登录」=====
  {
    fs.rmSync(STATE_FILE, { force: true });
    const [a, b] = await Promise.all([postJson('/boss/session/login'), postJson('/boss/session/login')]);
    const res = [a, b];
    const busy = res.filter((x) => x.status === 409 && (x.json || {}).error === '登录进行中');
    const faild = res.filter((x) => x.status === 200 && (x.json || {}).error === '未检测到登录');
    assert.equal(busy.length, 1, '并发 login 应恰一个「登录进行中」（409），实际 ' + JSON.stringify(res.map((x) => [x.status, x.json])));
    assert.equal(faild.length, 1, '并发 login 应恰一个「未检测到登录」（假身模拟关窗），实际 ' + JSON.stringify(res.map((x) => [x.status, x.json])));
    const st = await getJson('/boss/session/status');
    assert.equal((st.json || {}).logged, false, '未检测到登录后 status 应仍 logged:false');
  }

  // ===== ⑥ zhipin + 有会话 → /job/create 走轨 B：三字段提取值落 meta =====
  {
    writeSession(new Date().toISOString());
    fs.writeFileSync(stubFile, JSON.stringify({ htmlFile: path.join(APP_ROOT, 'test-fixtures', 'jd-pages', 'zhipin-job.html') }));
    const link = 'https://www.zhipin.com/job_detail/7ad5d5939a74640b1XN63dy-E1RS.html';
    const r = await postJson('/job/create', { from: 'd1', jdLink: link });
    assert.equal(r.status, 200, 'zhipin+会话建稿应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    assert.equal((r.json || {}).ok, true, '应 {ok:true}，实际 ' + r.text.slice(0, 160));
    assert.equal(r.json.jdError, null, '轨 B 成功路径不应有 jdError，实际 ' + JSON.stringify(r.json));
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const m = meta[r.json.id] || {};
    assert.equal(m.parent, 'd1', '草稿应继承母版');
    assert.ok((m.jd || '').includes('必须有带团队经验'), 'meta.jd 应含夹具 JD 正文（extractJd 提取），实际前 80 字：' + String(m.jd || '').slice(0, 80));
    assert.equal(m.jdSource, link, 'jdSource 应记来源链接');
    // 新增行为钉：用户未填 company/role → 提取值回填占位（meta 落真名而非「未命名」）
    assert.ok(String(m.company || '').includes('中软国际'), '未填公司时应回填提取值（中软国际），实际 ' + m.company);
    assert.ok(String(m.role || '').includes('数据标注'), '未填岗位时应回填提取值（数据标注），实际 ' + m.role);
    // 用户已填 → 提取值不覆盖（用户手填优先）
    const r2 = await postJson('/job/create', { from: 'd1', company: '用户公司', role: '用户岗位', jdLink: 'https://www.zhipin.com/job_detail/other999.html' });
    assert.equal(r2.status, 200, '用户已填字段的 zhipin 建稿应 200，实际 ' + r2.status + ' ' + r2.text.slice(0, 160));
    const m2 = (JSON.parse(fs.readFileSync(metaPath, 'utf8')) || {})[r2.json.id] || {};
    assert.equal(m2.company, '用户公司', '已填公司不得被提取值覆盖，实际 ' + m2.company);
    assert.equal(m2.role, '用户岗位', '已填岗位不得被提取值覆盖，实际 ' + m2.role);
    // 同链接复投 → 409 existing（抓取回填后重查 + 来源链接判同）
    const r3 = await postJson('/job/create', { from: 'd1', jdLink: link });
    assert.equal(r3.status, 409, '同 zhipin 链接复投应 409，实际 ' + r3.status + ' ' + r3.text.slice(0, 160));
    assert.equal((r3.json || {}).existing, r.json.id, '409 应回指首份草稿');
  }

  // ===== ⑦ SESSION_DEAD 两判据：/security 落地 URL；_jobInfo 缺席且 via=body =====
  {
    const docsDir = path.join(root, 'docs');
    const before = fs.readdirSync(docsDir).length;
    const metaBefore = fs.readFileSync(metaPath, 'utf8');
    fs.writeFileSync(stubFile, JSON.stringify({ finalUrl: 'https://www.zhipin.com/security/verify?x=1' }));
    const r = await postJson('/job/create', { from: 'd1', jdLink: 'https://www.zhipin.com/job_detail/dead1.html' });
    assert.equal(r.status, 400, 'security 落地应 400，实际 ' + r.status + ' ' + r.text.slice(0, 160));
    assert.equal((r.json || {}).error, 'Boss 会话已失效，请重新登录或改用书签', '400 文案应为会话失效，实际 ' + r.text.slice(0, 160));
    assert.equal(fs.readdirSync(docsDir).length, before, 'SESSION_DEAD 不得留孤儿文档');
    assert.equal(fs.readFileSync(metaPath, 'utf8'), metaBefore, 'SESSION_DEAD 不得写 meta');
    // §2.6 橙点分支：SESSION_DEAD 应把 state.json 改写为 deadAt 标记，status 透传 dead:true
    const stDead = await getJson('/boss/session/status');
    assert.equal((stDead.json || {}).dead, true, 'SESSION_DEAD 后 status 应 dead:true，实际 ' + stDead.text);
    assert.ok(stDead.json && stDead.json.deadAt && !Number.isNaN(Date.parse(stDead.json.deadAt)), 'deadAt 应为合法时间戳，实际 ' + stDead.text);
    assert.equal((stDead.json || {}).logged, false, 'dead 在场时 logged 应 false（即便 loggedAt 留档）');
    // _jobInfo 缺席 + jd 空：stub 文件删掉 → 假身回空 HTML（via=body）→ 同判 SESSION_DEAD。
    // 注意：上一用例已把会话标 dead（logged:false）——zhipin 请求会回落静态 fetch 而非轨 B，
    // 这正是「失效后不降级」的语义；故每个失效用例前须复活会话。
    writeSession(new Date().toISOString());
    fs.rmSync(stubFile, { force: true });
    const r2 = await postJson('/job/create', { from: 'd1', jdLink: 'https://www.zhipin.com/job_detail/dead2.html' });
    assert.equal(r2.status, 400, '_jobInfo 缺席+空 jd 应 400，实际 ' + r2.status + ' ' + r2.text.slice(0, 160));
    assert.equal((r2.json || {}).error, 'Boss 会话已失效，请重新登录或改用书签', '同判 SESSION_DEAD 文案，实际 ' + r2.text.slice(0, 160));
    assert.equal(fs.readdirSync(docsDir).length, before, '空页路径同样不得留孤儿文档');
    // 收紧后判据的核心场景：墙页同 URL 直出、有 body 文字但无 _jobInfo（旧判据会漏成垃圾 jd）
    writeSession(new Date().toISOString());   // 上一用例又标 dead → 复活
    fs.writeFileSync(stubFile, JSON.stringify({ htmlFile: path.join(APP_ROOT, 'test-fixtures', 'jd-pages', 'plain.html') }));
    const r3 = await postJson('/job/create', { from: 'd1', jdLink: 'https://www.zhipin.com/job_detail/dead3.html' });
    assert.equal(r3.status, 400, '无 _jobInfo 的 body 页（墙页同 URL 直出）应 400，实际 ' + r3.status + ' ' + r3.text.slice(0, 160));
    assert.equal((r3.json || {}).error, 'Boss 会话已失效，请重新登录或改用书签', 'via=body+无 _jobInfo 应判 SESSION_DEAD，实际 ' + r3.text.slice(0, 160));
    assert.equal(fs.readdirSync(docsDir).length, before, '墙页路径同样不得留孤儿文档');
    // 失效态下 status 应持续 dead（logged:false），登录短路不触发——重登走 login 流程
    const stDead2 = await getJson('/boss/session/status');
    assert.equal((stDead2.json || {}).dead, true, '持续 dead:true');
  }

  // ===== ⑧ /job/new 有母版分支渲染 Boss 会话卡 =====
  {
    const html = await (await fetch(base + '/job/new')).text();
    assert.ok(html.includes('id="bossCard"'), '有母版时应渲染 Boss 会话卡');
    assert.ok(html.includes('data-action="bossLogin"'), '会话卡应有「登录 Boss」委托按钮');
    assert.ok(html.includes('data-action="bossLogout"'), '会话卡应有「清除会话」委托按钮');
    assert.ok(html.includes('__acts.click.bossLogin'), '应注册 __acts.click.bossLogin（零内联事件委托模式）');
    assert.ok(html.includes('__acts.click.bossLogout'), '应注册 __acts.click.bossLogout');
    assert.ok(html.includes("/boss/session/status"), '会话卡应有 status 读取调用');
    assert.ok(html.includes('会话失效 · 需重新登录'), '会话卡应有橙点失效态文案「会话失效 · 需重新登录」（§2.6）');
    assert.ok(html.includes("indexOf('会话已失效')"), 'submit 错误分支应亮 jdFailHint（会话失效 400 → 书签锚点块）');
    assert.ok(!/id="bossLoginBtn"[^>]*on\w+=/.test(html), '会话卡按钮不得带内联事件属性');
    // 「只在有母版分支渲染」的源级钉：卡片字面量必须落在 id="evalResult"（有母版分支专属标记）之后——
    // 空库分支不含 evalResult，卡片在其后 ⇒ 同分支内（与书签同区）。
    const src = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    const cardPos = src.indexOf('id="bossCard"');
    const evalResultPos = src.indexOf('id="evalResult"');
    assert.ok(cardPos > 0 && cardPos > evalResultPos, '会话卡应在有母版分支模板内（evalResult 之后）');
  }

  // ===== ⑨ 源级钉：visibility 覆盖 / 串行锁 / 唯一拉起注入点 / profile 子目录 =====
  {
    const src = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    // 反爬实测后改纯 HTTP 抓取：浏览器进程抓页会被 Boss 杀且烧会话——钉死「无浏览器抓取」架构
    assert.ok(src.includes('bossFetchHttp'), '应有纯 HTTP 抓取函数 bossFetchHttp');
    assert.ok(src.includes("redirect: 'manual'"), '应手动跟跳（每跳查安全页落点）');
    assert.ok(src.includes('bossSnapshotSession'), '登录成功应快照 cookie+UA 入 state.json');
    assert.ok(/bossFetchChain\.then/.test(src), '应有串行锁链（bossFetchChain.then）');
    assert.equal((src.match(/launchPersistentContext/g) || []).length, 1, 'launchPersistentContext 应只在注入点 bossLaunchContext 出现一次');
    assert.ok(src.includes("path.join(BOSS_SESSION_DIR, 'profile')"), 'userDataDir 应为 boss-session/profile 子目录');
    assert.ok(src.includes('boss-session'), '应含 boss-session 目录常量');
  }

  // ===== ⑩ 抓取串行锁【行为断言】：两个并发 zhipin 建稿，stub content() 记 S/E 时间线 =====
  // delayMs 撑出让行窗口——无锁时第二抓的 content() 必插进第一抓的 S/E 之间（[S,S,…]）；
  // 有锁 ⇒ 文件恰呈 [S,E,S,E]。同 stub html → 同 JD → 后到的被 dup3 重查 409，两态都合法。
  {
    writeSession(new Date().toISOString());   // 复活会话（⑦ 已 dead）
    const markFile = path.join(root, 'boss-marks.txt');
    // 用 jsonld 夹具（via=json-ld 不触发「无 _jobInfo+body」失效判据，且 JD 与 ⑥ 不同 →
    // 先到者 200 建稿、后到者同 JD 重查 409；两请求共享同一 stub → 同 html 同提取结果）
    fs.writeFileSync(stubFile, JSON.stringify({
      htmlFile: path.join(APP_ROOT, 'test-fixtures', 'jd-pages', 'jsonld-job.html'),
      delayMs: 250, markFile }));
    const [ra, rb] = await Promise.all([
      postJson('/job/create', { from: 'd1', jdLink: 'https://www.zhipin.com/job_detail/lockA.html' }),
      postJson('/job/create', { from: 'd1', jdLink: 'https://www.zhipin.com/job_detail/lockB.html' }),
    ]);
    const codes = [ra.status, rb.status].sort().join(',');
    assert.equal(codes, '200,409', '并发两抓应一个建稿成功、一个被同 JD 重查 409，实际 ' + codes);
    assert.ok(fs.existsSync(markFile), 'markFile 应由两抓各自写记');
    const marks = fs.readFileSync(markFile, 'utf8').trim().split('\n');
    assert.deepEqual(marks, ['S', 'E', 'S', 'E'], '两抓应严格串行（S,E,S,E），实际 ' + marks.join(',') + '——串行锁失效');
  }

  console.log('✅ boss-session：status 未登录/已登录/失效三态形、logout 清目录、login 短路、并发锁（登录进行中）、轨 B 建稿三字段回填、SESSION_DEAD 三判据零孤儿+deadAt 透传、会话卡委托 UI+橙点态、源级钉、抓取串行锁行为断言[S,E,S,E]');
} finally {
  cleanup();
}
process.exit(0);
