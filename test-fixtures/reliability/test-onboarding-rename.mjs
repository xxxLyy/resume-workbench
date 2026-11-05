// test-onboarding-rename.mjs — 批 1 §0.3 改名落地：「引导建档」→「从零建简历」（向导 h1/page title/
// 继续卡/完成卡/完成按钮/ob 横幅）；「针对岗位生成」→「为岗位定制简历」（/job/new 页题，拆页卡已落，此处复核钉）。
// 断言逐条独立（纪律：断言与新文案同提交，不许为过关放宽断言）：
//   A 新会话页：page title 与 h1 均为「从零建简历」，页面零「引导」「建档」字样（ob 系列内部文案全部统一）；
//   B resume 态横幅：「已恢复未完成的从零建简历（最近确认 …）」，旧「已恢复未完成的引导」零残留；
//   C forward 态横幅：「已进入下一步」保留（R2⑤ 两态语义不变，只换名）；
//   D 0.8 完成步：按钮「完成从零建简历」，旧「完成引导」零残留；
//   E 完成卡（finished）：标题「从零建简历完成」，旧「引导完成」零残留；
//   F 继续卡（暂存续作列表）：「继续从零建简历」+ 条目展示暂存文档标题，旧「继续上次引导」零残留；
//   G 源级钉：server.mjs 旧串零残留（含 ob 系列 409/400 错误句）、新串在场；
//     /job/new 页题与 h1 为「为岗位定制简历」（拆页卡 239f3e4 已落，复核钉防回退）。
//   H ob 系列错误文案（§0.3「ob 系列内部文案全部统一」）：非向导文档/已完成向导的 409 错误句
//     旧名「引导」零残留，一律用「从零建简历」口径；运行时（HTTP 409 体）与源级双重钉。
// 约束：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成数据；不读真实简历、不碰 7766、不调模型、零浏览器依赖。
// 退出码契约：0=全部通过；1=任一断言失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-onb-rename-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 刻意不写 config.json：向导步进 API 不调模型，无 LLM 也应全程可用

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
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
const base = `http://127.0.0.1:${port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const stepPost = async (body) => {
  const r = await fetch(base + '/onboarding/step', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== A 新会话页：page title + h1 =「从零建简历」，页面零「引导」字样 =====
  {
    const p = await get('/onboarding');
    assert.equal(p.status, 200, '向导页应 200');
    assert.ok(p.text.includes('<title>从零建简历</title>'), 'page title 应为「从零建简历」（§0.3 改名），实际：' + (p.text.match(/<title>[^<]*<\/title>/) || ['(无)'])[0]);
    assert.ok(/<h1>从零建简历<\/h1>/.test(p.text), '向导 h1 应为「从零建简历」，实际：' + (p.text.match(/<h1>[^<]*<\/h1>/) || ['(无)'])[0]);
    assert.ok(p.text.includes('八步都是可跳过的组织方式'), '无文档说明横幅应保留八步口径');
    assert.ok(!p.text.includes('引导'), '新会话向导页应零「引导」字样（ob 系列内部文案全部统一）：' + (p.text.split('引导')[0].slice(-120)));
    // 旧产品词「建档」在 ob 系列可见文案里零残留（无文档说明横幅原句「首个有内容的确认步才建档」已改「才创建文档」）
    assert.ok(!p.text.includes('建档'), '新会话向导页应零「建档」旧产品词（§0.3 名称统一）：' + (p.text.split('建档')[0].slice(-120)));
  }

  // ===== B resume 态横幅：已恢复未完成的从零建简历（最近确认 …）=====
  const r1 = await stepPost({ step: '0.1', payload: { name: '改名同学', contact: '', intent: '' } });
  assert.equal(r1.status, 200, '0.1 确认应建档 200：' + JSON.stringify(r1).slice(0, 200));
  const docId = r1.json && r1.json.docId;
  assert.ok(docId, '0.1 确认应返回 docId');
  {
    const p = await get('/onboarding?docId=' + docId);
    assert.equal(p.status, 200, '带 docId 续作页应 200');
    assert.ok(p.text.includes('已恢复未完成的从零建简历'), 'resume 态横幅应为「已恢复未完成的从零建简历」');
    assert.ok(p.text.includes('最近确认 基本信息'), '0.1 未跳过 → 横幅应含「最近确认 基本信息」');
    assert.ok(!p.text.includes('已恢复未完成的引导'), '旧横幅「已恢复未完成的引导」应零残留');
    assert.ok(!p.text.includes('引导'), '续作向导页应零「引导」字样：' + (p.text.split('引导')[0].slice(-120)));
  }

  // ===== C forward 态横幅：「已进入下一步」保留（两态语义不变）=====
  {
    const p = await get('/onboarding?docId=' + docId + '&from=step');
    assert.ok(p.text.includes('已进入下一步'), 'forward 态横幅应保留「已进入下一步」（步进 PRG 回跳不是「恢复」）');
  }

  // ===== D 跳到 0.8：完成按钮「完成从零建简历」=====
  for (const st of ['0.2', '0.3', '0.4', '0.5', '0.6', '0.7']) {
    const rs = await stepPost({ step: st, docId, skip: true });
    assert.equal(rs.status, 200, `${st} 跳过应 200`);
  }
  {
    const p = await get('/onboarding?docId=' + docId);
    assert.ok(/<button type="submit">完成从零建简历<\/button>/.test(p.text), '0.8 完成按钮应为「完成从零建简历」：' + (p.text.match(/<button type="submit">[^<]*<\/button>/) || ['(无)'])[0]);
    assert.ok(!p.text.includes('完成引导'), '旧按钮文案「完成引导」应零残留');
  }

  // ===== E 完成卡（finished）：「从零建简历完成」=====
  {
    const r8 = await stepPost({ step: '0.8', docId });
    assert.equal(r8.status, 200, '0.8 收口应 200');
    const p = await get('/onboarding?docId=' + docId);
    assert.ok(/class="ob-done-title">从零建简历完成<\/div>/.test(p.text), '完成卡标题应为「从零建简历完成」：' + (p.text.match(/class="ob-done-title">[^<]*</) || ['(无)'])[0]);
    assert.ok(!p.text.includes('引导完成'), '旧完成卡标题「引导完成」应零残留');
    assert.ok(!p.text.includes('引导'), '完成态向导页应零「引导」字样：' + (p.text.split('引导')[0].slice(-120)));
  }

  // ===== F 继续卡：「继续从零建简历」+ 暂存条目 =====
  {
    const r2 = await stepPost({ step: '0.1', payload: { name: '暂存同学', contact: '', intent: '' } });
    assert.equal(r2.status, 200, '第二会话 0.1 确认应 200');
    const p = await get('/onboarding');
    const card = (p.text.match(/<div class="ob-card ob-resume">[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
    assert.ok(card.includes('继续从零建简历'), '继续卡标题应为「继续从零建简历」：' + card.slice(0, 200));
    assert.ok(card.includes('以下是暂存的从零建简历'), '继续卡说明应统一新名称：' + card.slice(0, 240));
    assert.ok(card.includes('暂存同学'), '继续卡条目应展示暂存文档标题');
    assert.ok(!p.text.includes('继续上次引导'), '旧继续卡标题「继续上次引导」应零残留');
  }

  // ===== G 源级钉：server.mjs 旧串零残留 / 新串在场；/job/new 页题复核钉 =====
  {
    const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    // 旧串清单随本轮补齐而加长：ob 系列错误句（不是引导文档/已完成引导/不在引导中）与横幅旧产品词「才建档」一并纳入
    for (const old of ['引导建档', '继续上次引导', '引导完成', '已恢复未完成的引导', '完成引导', '不是引导文档', '已完成引导', '不在引导中', '才建档']) {
      assert.ok(!srv.includes(old), `server.mjs 旧串「${old}」应零残留（§0.3 改名统一）`);
    }
    for (const neu of ['<h1>从零建简历</h1>', '已恢复未完成的从零建简历', '继续从零建简历', '从零建简历完成', '>完成从零建简历<']) {
      assert.ok(srv.includes(neu), `server.mjs 应含新串「${neu}」`);
    }
    assert.ok(srv.includes("page('为岗位定制简历'"), '/job/new 页题应为「为岗位定制简历」（拆页卡已落，复核钉）');
  }

  // ===== H ob 系列错误文案：运行时 + 源级双重钉（§0.3「ob 系列内部文案全部统一」）=====
  {
    // ① 已完成向导的文档再步进 → 409 + 新名文案
    const rr = await stepPost({ step: '0.1', docId });
    assert.equal(rr.status, 409, '已完成向导的文档再步进应 409，实际：' + rr.status);
    const rrErr = String((rr.json && rr.json.error) || '');
    assert.ok(rrErr.includes('该文档已完成从零建简历'), '完成态 409 文案应统一为「该文档已完成从零建简历」，实际：' + rrErr);
    assert.ok(!rrErr.includes('引导'), '完成态 409 文案不应再出现旧名「引导」，实际：' + rrErr);

    // ② 非向导文档（POST /new 建的普通文档）→ 页壳 409 与步进 409 均新名文案
    const nr = await fetch(base + '/new', { method: 'POST', redirect: 'manual' });
    const plainId = ((nr.headers.get('location') || '').match(/id=([^&]+)/) || [])[1] || '';
    assert.ok(plainId, 'POST /new 应建出普通文档（取 id 走门控路径），实际 location=' + (nr.headers.get('location') || '(无)'));
    const pg = await get('/onboarding?docId=' + plainId);
    assert.equal(pg.status, 409, '普通文档进向导页应 409，实际：' + pg.status);
    assert.ok(pg.text.includes('该文档不在从零建简历流程中（无向导进度）'), '页壳 409 文案应统一新名，实际：' + pg.text.slice(0, 120));
    assert.ok(!pg.text.includes('引导'), '页壳 409 文案不应再出现旧名「引导」，实际：' + pg.text.slice(0, 120));
    const ps = await stepPost({ step: '0.1', docId: plainId });
    assert.equal(ps.status, 409, '普通文档按步进应 409，实际：' + ps.status);
    const psErr = String((ps.json && ps.json.error) || '');
    assert.ok(psErr.includes('该文档不在从零建简历流程中，不能按向导步进'), '步进 409 文案应统一新名，实际：' + psErr);
    assert.ok(!psErr.includes('引导'), '步进 409 文案不应再出现旧名「引导」，实际：' + psErr);

    // ③ 源级钉：四条错误句新名在场、旧名零残留（STAR 建议句在无模型时先被 NO_LLM 截断，只做源级钉）
    const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    for (const neu of [
      '该文档不在从零建简历流程中（无向导进度）',
      '该文档不在从零建简历流程中，不能按向导步进（请直接在编辑器中修改）',
      '该文档已完成从零建简历（后续修改请直接在编辑器中进行）',
      '该文档不在从零建简历流程中，不能请求 STAR 建议'
    ]) {
      assert.ok(srv.includes(neu), `server.mjs 应含新错误文案「${neu}」`);
    }
  }

  console.log('✅ §0.3 改名落地：向导 h1/page title=从零建简历 + 页面零「引导」+ 横幅两态（恢复/下一步）+ 完成按钮/完成卡/继续卡新名 + 源级零残留 + ob 系列 409 错误句新名（运行时+源级）+ /job/new 页题复核');
} catch (e) {
  console.error('❌ ' + (e && e.message || e));
  process.exitCode = 1;
} finally {
  cleanup();
}
