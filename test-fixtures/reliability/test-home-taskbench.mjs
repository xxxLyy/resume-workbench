// test-home-taskbench.mjs — 批 1 首页任务台面（HTTP 夹具，隔离根，无浏览器依赖）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §2 首页（listPage）+ §0.2/§0.3 裁决。
// 覆盖（断言逐条独立，便于逐条复核）：
//   ① hero 区退役：首页无 hero 标记（.hero/.hero-txt/.hero-title/.hero-acts/.hero-art 与内联插画），
//     无 .hero* 死 CSS；<h1>文档</h1> 升为页面第一标题（且全页唯一 h1）。
//   ② 任务卡三态（首屏主行动，按流水线状态派生）：
//      A 空库（无文档）→「＋ 从零建简历」→ /onboarding/guided（tooltip 八步口径）；
//      B 有母版无草稿 →「为岗位定制简历」直达岗位表单（#jobCard；/job/new 拆页落地后由该卡改指向）；
//      C 有进行中岗位草稿 →「▶ 继续处理：<草稿题>」+ deliverableNow 口径徽章摘要（与草稿卡同款）。
//   ③ 首屏次序：任务卡 → h1 文档 → 统计行 → 搜索行 → 文档列表；岗位表单/状态行/日程等退到文档列表之后。
//   ④ 「继续上次任务」回退链契约保持：有文档时 continueBtn + data-fallback/data-doc-ids/data-doc-titles 在场；
//     空库不渲染（既有契约）。
//   ⑤ 死引用清零：文档列表空态文案不再指向已删除的「＋ 新建第一份简历」。
// 约束：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成文档；不读真实简历、不碰 7766、不调真实模型。
// 隐私门禁：合成数据不含 13 位数字（门禁 1[3-9]\d{9} 不适用）。
// 退出码契约：0=全部通过；1=任一断言失败（本夹具不依赖 Chromium，无 2 分支）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-home-taskbench-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 刻意不写 config.json → hasLLM=false（任务卡三态是纯服务端派生，不依赖模型）；applications.json 缺省 → 空投递

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

// 合成文档：真模板骨架 + 显式 h1 标题 + meta 直写（绕过 LLM 动线；flow/parent/company/role 即任务卡派生所需的全部状态）
const metaPath = path.join(root, 'docs-meta.json');
const seedDoc = (id, title, metaEntry = {}) => {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', ''],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) doc = doc.replaceAll(k, () => v);
  doc = doc.replace(/<h1>[^<]*<\/h1>/, () => `<h1>${title}</h1>`);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  meta[id] = { rev: 1, flow: 'draft', ...metaEntry };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
};

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  const idx = (html, needle) => html.indexOf(needle);
  // 任务卡窗口 = id="taskCard" 起到 <h1>文档</h1> 止（实现契约：任务卡紧邻 h1 之前；窗口内含整卡与卡内次级行）
  const taskCardOf = (html) => {
    const a = idx(html, 'id="taskCard"'), b = idx(html, '<h1>文档</h1>');
    return (a >= 0 && b > a) ? html.slice(a, b) : '';
  };
  // 主行动行窗口 = task-acts 起到 task-side（次级行）或窗口末尾（空库无次级行）
  const taskActsOf = (tc) => tc.split('task-side')[0];

  // ===== A. 空库：hero 退役 + h1 升首题 + 任务卡「从零建简历」+ 首屏次序 =====
  {
    const home = await get('/');
    assert.equal(home.status, 200, '空库首页应 200');
    const html = home.text;

    // ① hero 标记与死 CSS 全部退役（首页引用与 .hero* 规则；引导页 hero-page.svg 不在本页，不受影响）
    for (const marker of ['class="hero"', 'hero-txt', 'hero-title', 'hero-acts', 'hero-art', '.hero{', '镜子前整理简历']) {
      assert.ok(!html.includes(marker), `hero 退役后首页不得再含「${marker}」`);
    }

    // ① h1「文档」升为页面第一标题：第一个 <h1 就是它，且全页唯一（改前 hero 大标题 + 文档 = 两个 h1）
    const h1Doc = idx(html, '<h1>文档</h1>');
    assert.ok(h1Doc >= 0, '首页应有 <h1>文档</h1>');
    assert.equal(idx(html, '<h1'), h1Doc, '第一个 h1 应是「文档」（hero 大标题撤销后升为页面首题）');
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, '首页应只有一个 h1（三档收两档后 hero 大标题不复存在）');

    // ② 任务卡（首屏主行动）三态之一：空库 → 从零建简历（八步向导口径 tooltip）
    assert.ok(html.includes('id="taskCard"'), '首页应有任务卡 #taskCard');
    const tc = taskCardOf(html);
    assert.ok(tc.includes('从零建简历'), `空库任务卡主行动应为「从零建简历」，任务卡片段：${tc.slice(0, 200)}`);
    assert.ok(tc.includes('href="/onboarding/guided"'), '「从零建简历」应指向八步向导 /onboarding/guided');
    assert.ok(tc.includes('八步从零建简历'), '「从零建简历」应带八步口径 tooltip');
    assert.ok(!tc.includes('继续处理'), '空库任务卡不应出现「继续处理」（无草稿）');
    assert.ok(!tc.includes('为岗位定制简历'), '空库任务卡不应出现「为岗位定制简历」（无母版）');
    assert.ok(!tc.includes('新建第一份简历'), 'hero 退役后空库主行动不再是「新建第一份简历」');
    assert.ok(!tc.includes('task-side'), '空库任务卡无次级行（无文档无回退链）');

    // ③ 首屏次序：任务卡 → h1 → 统计行 → 搜索行 → 文档列表
    //（锚点用 body 标记而非裸类名——.stat-grid/.searchrow 等在 head 内 <style> 规则里先行出现）
    const statAt = idx(html, 'class="stat-grid"'), searchAt = idx(html, 'class="searchrow"'), listAt = idx(html, 'id="doclist"');
    assert.ok(idx(html, 'id="taskCard"') < h1Doc, '任务卡应在 h1 之前（首屏主行动）');
    assert.ok(h1Doc < statAt, 'h1 应在统计行之前');
    assert.ok(statAt < searchAt, '统计行应在搜索行之前（搜索行上第一屏）');
    assert.ok(searchAt < listAt, '搜索行应紧贴文档列表（同上第一屏）');
    // 次级区退到文档列表之后：岗位表单/状态行/导入行/近期日程
    for (const [name, needle] of [['岗位表单', 'id="jobCard"'], ['状态摘要', 'class="card statusline"'], ['导入行', 'class="import-box"'], ['近期日程', 'upcomingAgenda']]) {
      const at = idx(html, needle);
      if (at >= 0) assert.ok(at > listAt, `${name}应退到文档列表之后（首屏只留任务台面），实际 index=${at} < ${listAt}`);
    }

    // ④ 回退链既有契约：无文档时不渲染 continueBtn
    assert.ok(!html.includes('id="continueBtn"'), '空库不渲染 continueBtn（回退链契约）');

    // ⑤ 死引用清零：空态文案不再指向已删除的「＋ 新建第一份简历」
    assert.ok(!html.includes('新建第一份简历'), '文档列表空态不得再引用已删除的「＋ 新建第一份简历」');
  }

  // ===== B. 有母版无草稿 → 任务卡「为岗位定制简历」直达 + 回退链在场 =====
  {
    seedDoc('masterbench', '合成母版简历');
    const html = (await get('/')).text;
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, '有文档后首页仍应只有一个 h1');
    const tc = taskCardOf(html);
    assert.ok(tc.includes('为岗位定制简历'), `有母版无草稿任务卡主行动应为「为岗位定制简历」，片段：${tc.slice(0, 200)}`);
    assert.ok(tc.includes('href="#jobCard"'), '「为岗位定制简历」应直达本页岗位表单（#jobCard；/job/new 拆页后由该卡改指向）');
    assert.ok(!taskActsOf(tc).includes('从零建简历'), '有母版时主行动不应再是「从零建简历」');
    assert.ok(!tc.includes('继续处理'), '无草稿时任务卡不应出现「继续处理」');
    // S5 暂存续作可达：有文档态次级行保留「从零建简历」显式入口（hero 退役后唯一常驻向导入口）
    assert.ok(tc.includes('task-side') && tc.includes('href="/onboarding/guided"'), '有文档态任务卡次级行应保留「从零建简历」入口');
    // 回退链契约保持：continueBtn + 三 data 属性在场，fallback 指向最近文档
    assert.ok(html.includes('id="continueBtn"'), '有文档时「继续上次任务」回退链入口应保持');
    const btnTag = (html.match(/<a id="continueBtn"[^>]*>/) || [''])[0];
    for (const attr of ['data-fallback', 'data-doc-ids', 'data-doc-titles']) {
      assert.ok(btnTag.includes(attr + '='), `continueBtn 应保留 ${attr}（回退链契约）`);
    }
    assert.ok(btnTag.includes('masterbench'), '回退链 fallback 应指向最近文档 masterbench');
  }

  // ===== C. 有进行中岗位草稿 → 任务卡「▶ 继续处理：草稿题」+ deliverableNow 口径徽章摘要 =====
  {
    seedDoc('benchdraft1', '合成岗位稿', {
      parent: 'masterbench', company: '合成公司', role: '合成岗位',
      job: { kind: 'job', status: 'draft', flow: 'draft' }
    });
    const html = (await get('/')).text;
    const tc = taskCardOf(html);
    assert.ok(tc.includes('继续处理'), `有草稿任务卡主行动应为「▶ 继续处理」，片段：${tc.slice(0, 240)}`);
    assert.ok(tc.includes('合成岗位稿'), '继续处理 CTA 应带草稿标题');
    assert.ok(tc.includes('/edit?id=benchdraft1'), '继续处理应指向草稿文档（非母版）');
    assert.ok(!taskActsOf(tc).includes('为岗位定制简历') && !taskActsOf(tc).includes('从零建简历'), '有草稿时主行动不应回落到另外两态');
    // deliverableNow 口径徽章摘要：flow=draft → 可投递=false → warn「草稿」（与下方草稿卡同款徽章；badge 自带 svg 图标）
    assert.ok(/class="badge warn"[\s\S]{0,700}?>草稿</.test(tc), '任务卡摘要徽章应为 warn「草稿」（deliverableNow=false 口径）：' + tc.slice(0, 300));
    assert.ok(tc.includes('合成公司·合成岗位'), '任务卡摘要应含公司·岗位');
    // 徽章口径与草稿卡一致：同一草稿在「继续处理岗位草稿」卡中也渲染同款徽章
    const draftCardRow = (html.match(/<b>合成岗位稿<\/b>[\s\S]{0,700}/) || [''])[0];
    assert.ok(draftCardRow.includes('>草稿<'), '草稿卡同款徽章应同口径（草稿）：' + draftCardRow.slice(0, 120));
  }

  console.log('✅ 首页任务台面（hero 退役 + 任务卡三态 + h1 首题 + 首屏次序 + 回退链契约）');
} catch (e) {
  console.error('❌ ' + (e && e.message));
  process.exitCode = 1;
} finally {
  cleanup();
}
