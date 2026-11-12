// test-home-taskbench.mjs — 渐进呈现 T3 首页三态台面（HTTP 夹具，隔离根，无浏览器依赖）
// 计划：渐进呈现重设计（dev-docs/2026-11-12 spec）——首页按数据状态渲染三态。
// 覆盖（断言逐条独立，便于逐条复核）：
//   ① hero/任务卡/统计行/状态行全部退役：无 .hero*/#taskCard/stat-grid/statusline/doclist/viewToggle 标记。
//   ② 三态分支（按数据派生，非流水线三态）：
//      A 空库（无文档）→ 起步态：「建你的第一份简历」+ 起步卡（导入 PDF / 从零开始→/onboarding/guided），
//        无列表无搜索无岗位定制入口；
//      B 有文档无投递 → 继续态：h1「继续」+ resume-hero（最近文档+回退链）+ 岗位定制引导（有母版时）
//        +「全部简历」行式列表 + 底部入口行；
//      C 有投递 → 待办态：h1「待办」（有真待办时）/「简历」+ 行式列表 + 状态点；continueBtn 不再渲染。
//   ③ 「继续编辑」回退链契约保持：状态 1 时 continueBtn + data-fallback/data-doc-ids/data-doc-titles 在场，
//     fallback 指向最近文档；状态 0/2 不渲染（T3 模板口径）。
//   ④ 状态点口径：已投递=dot-sent/可投递=dot-ready/草稿=dot-draft；行内元信息含 id/更新于/标签。
//   ⑤ 死引用清零：不渲染「还没有简历文档」「新建第一份简历」「为岗位定制简历」旧口径长文案。
//   ⑥ 源级钉值（CSS 在页面 <style> 内联，随首页响应一并核对）：
//      T3 新规则（.dot/.st/.home-start/.start-card/.docrow/.todo-list/.foot-links/.resume-hero）在场；
//      与 --space-* 档重合的间距一律 var()（§5.1）；主行动 .cta:hover 零投影、只留位移（§3.1）。
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
// 刻意不写 config.json → hasLLM=false（三态是纯服务端派生，不依赖模型）；applications.json 缺省 → 空投递

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

// 合成文档：真模板骨架 + 显式 h1 标题 + meta 直写（绕过 LLM 动线；flow/parent/company/role 即三态派生所需的全部状态）
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

  // ===== A. 空库 → 状态 0 起步态 =====
  {
    const home = await get('/');
    assert.equal(home.status, 200, '空库首页应 200');
    const html = home.text;

    // ① hero/任务卡/统计行/状态行/栅格卡全部退役（标记与死引用零残留；
    //    CSS 规则级命中不算——取 markup 形态 '="/id=" 前缀判）
    for (const marker of ['class="hero"', 'hero-txt', 'hero-title', 'hero-acts', 'hero-art', '镜子前整理简历',
      'id="taskCard"', 'class="stat-grid"', 'class="card statusline"', 'id="doclist"', 'id="viewToggle"',
      'class="group-head"', 'class="card doc-card"']) {
      assert.ok(!html.includes(marker), `T3 退役标记不得在首页残留「${marker}」`);
    }

    // ②A 起步态：居中标题 + 起步卡两张；无列表无搜索无岗位定制入口（渐进呈现：该阶段不给用不到的入口）
    assert.ok(html.includes('<h1>建你的第一份简历</h1>'), '状态 0 应有起步标题「建你的第一份简历」');
    assert.ok(html.includes('class="home-start"'), '状态 0 应有 .home-start 容器');
    assert.ok(html.includes('导入现有简历'), '起步卡①应为「导入现有简历」');
    assert.ok(html.includes('id="up"'), '起步卡①应内嵌上传区 #up（三态都在）');
    assert.ok(html.includes('从零开始'), '起步卡②应为「从零开始」');
    const startLink = (html.match(/<a class="card start-card" href="([^"]+)"/) || [])[1];
    assert.equal(startLink, '/onboarding/guided', '「从零开始」卡应整卡链接 /onboarding/guided');
    assert.ok(!html.includes('class="docrow"'), '空库不渲染文档行');
    assert.ok(!html.includes('id="doclistCard"'), '空库不渲染文档列表卡');
    assert.ok(!html.includes('id="searchBox"'), '空库不渲染搜索行（无文档可搜）');
    assert.ok(!html.includes('href="/job/new"'), '空库不渲染岗位定制入口（无母版）');
    // ③ 回退链契约：无文档时不渲染 continueBtn
    assert.ok(!html.includes('id="continueBtn"'), '空库不渲染 continueBtn（回退链契约）');
    // ⑤ 死引用清零：旧空态/旧主行动文案不再出现
    for (const dead of ['还没有简历文档', '新建第一份简历', '待结构化', 'PDF 较旧', 'AI：']) {
      assert.ok(!html.includes(dead), `首页不得再出现旧文案「${dead}」`);
    }
    // ②A 次序：起步标题 → 起步卡（首屏只此一件）
    assert.ok(idx(html, 'class="home-start"') < idx(html, 'class="start-cards"'), '起步标题应在起步卡之前');
  }

  // ===== B. 有母版无草稿无投递 → 状态 1 继续态 =====
  {
    seedDoc('masterbench', '合成母版简历');
    const html = (await get('/')).text;
    // ②B 继续卡：h1「继续」+ resume-hero + 最近文档标题 + 状态点
    assert.ok(html.includes('<h1>继续</h1>'), '状态 1 第一标题应为「继续」');
    const heroAt = idx(html, 'class="card resume-hero"');
    assert.ok(heroAt > 0, '状态 1 应有继续卡 .resume-hero');
    const heroSeg = html.slice(heroAt, heroAt + 3000);
    assert.ok(heroSeg.includes('合成母版简历'), '继续卡应显示最近文档标题');
    assert.ok(/dot-(draft|ready|sent)/.test(heroSeg), '继续卡应有状态点');
    // ③ 回退链契约：continueBtn + 三 data 属性在场，fallback 指向最近文档
    const btnTag = (html.match(/<a class="cta" id="continueBtn"[^>]*>/) || [''])[0];
    assert.ok(btnTag, '有文档时「继续编辑」回退链入口应保持');
    for (const attr of ['data-fallback', 'data-doc-ids', 'data-doc-titles']) {
      assert.ok(btnTag.includes(attr + '='), `continueBtn 应保留 ${attr}（回退链契约）`);
    }
    assert.ok(btnTag.includes('masterbench'), '回退链 fallback 应指向最近文档 masterbench');
    // ②B 岗位定制引导（有母版时在场）+「全部简历」行式列表 + 底部入口行
    assert.ok(html.includes('要投某个岗位'), '有母版时应渲染岗位定制引导卡');
    assert.ok(html.includes('href="/job/new"'), '岗位定制入口应直达 /job/new（拆页卡落地）');
    assert.equal((html.match(/href="\/job\/new"/g) || []).length, 1,
      '状态 1（有母版）/job/new 入口应唯一（引导卡承载，底部入口行不重复）');
    assert.ok(html.includes('<h1 style="margin-top:var(--space-6)">全部简历</h1>'), '状态 1 应有「全部简历」列表标题');
    assert.ok(html.includes('id="doclistCard"'), '状态 1 应渲染文档列表卡');
    assert.ok(html.includes('class="docrow"'), '状态 1 应渲染文档行');
    assert.ok(html.includes('id="searchBox"'), '状态 1 应渲染搜索行');
    assert.ok(html.includes('class="foot-links"'), '状态 1 应渲染底部入口行');
    assert.ok(html.includes('从零开始（分步向导）'), '底部入口行应保留从零开始入口（暂存续作可达）');
    // ④ 状态点口径：母版草稿 → dot-draft + 「草稿」
    assert.ok(html.includes('dot-draft'), '母版草稿文档行应出 dot-draft');
    // 行内元信息：id + 更新于（搜索契约 标题/id/标签 按行文本过滤；锚点限定 doclist 段——标题也会先在 hero 出现）
    const mRowSeg = html.slice(idx(html, 'id="doclistCard"'));
    const mRow = mRowSeg.slice(mRowSeg.indexOf('>合成母版简历<'), mRowSeg.indexOf('>合成母版简历<') + 2600);
    assert.ok(mRow.includes('masterbench') && mRow.includes('更新于'), '文档行元信息应含 id 与更新时间');
    // 岗位表单依旧整体迁出（/job/new 承接，行为面见 test-job-new-page.mjs）
    assert.ok(!html.includes('id="jobCard"') && !html.includes('id="jobForm"'), '岗位表单应整体迁出首页（/job/new 承接）');
    // ②B 首屏次序：继续卡 → 全部简历列表 → 底部入口行 → 近期日程（若有）
    const listAt = idx(html, 'id="doclistCard"'), footAt = idx(html, 'class="foot-links"');
    assert.ok(heroAt < listAt, '继续卡应在文档列表之前');
    assert.ok(listAt < footAt, '文档列表应在底部入口行之前');
    const agendaAt = idx(html, 'id="upcomingAgenda"');
    if (agendaAt >= 0) assert.ok(agendaAt > listAt, '近期日程应在文档列表之后');
  }

  // ===== C. 有岗位草稿（仍无投递）→ 状态 1 保持，岗位版行排序在母版之后 =====
  {
    seedDoc('benchdraft1', '合成岗位稿', {
      parent: 'masterbench', company: '合成公司', role: '合成岗位', tag: '合成公司·合成岗位',
      job: { kind: 'job', status: 'draft', flow: 'draft' }
    });
    const html = (await get('/')).text;
    assert.ok(html.includes('<h1>继续</h1>'), '有岗位草稿无投递仍走状态 1');
    // 行序：母版在前、岗位版在后（与 mtime 无关——排序键是先 parent 后 mtime）。
    // 锚点限定 doclistCard 段内取 .nm 标题（最新稿会先出现在 hero h3，全页锚点会误命中）
    const listSeg = html.slice(idx(html, 'id="doclistCard"'));
    const masterAt = listSeg.indexOf('>合成母版简历<'), draftAt = listSeg.indexOf('>合成岗位稿<');
    assert.ok(masterAt > 0 && draftAt > masterAt, '行序应母版在前岗位版在后');
    // 岗位版行内元信息：基于母版 + 标签（company·role 派生）；锚点向后覆盖 mt/st/ops 全行
    const draftRow = listSeg.slice(draftAt, draftAt + 3200);
    assert.ok(draftRow.includes('基于母版'), '岗位版文档行应标「基于母版」');
    assert.ok(draftRow.includes('合成公司·合成岗位'), '岗位版文档行应显示标签（company·role 派生）');
    // ④ 状态点：未投递草稿 → dot-draft「草稿」
    assert.ok(draftRow.includes('dot-draft') && draftRow.includes('>草稿<'), '岗位草稿应出 dot-draft「草稿」状态点');
    // ⋯ 菜单收全量操作（原 doc-card 全部操作能力零损失）
    for (const act of ['最新PDF', '历史版本', '对比', '对比母版', '归档', '标签', '复制', '删除']) {
      assert.ok(draftRow.includes(act), `文档行 ⋯ 菜单应保留操作「${act}」`);
    }
    for (const act of ['homeArchive', 'homeTag', 'homeDup', 'confirmSubmit']) {
      assert.ok(draftRow.includes('data-action="' + act + '"'), `文档行 ⋯ 菜单应保留委托动作 ${act}`);
    }
  }

  // ===== D. 有投递 → 状态 2：待办卡 + 状态点已投递 + continueBtn 不渲染 + /job/new 入口唯一 =====
  {
    fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([
      { id: 'app-bench-001', company: '合成投递', role: '后端', docId: 'benchdraft1', status: '已投递',
        createdAt: '2026-01-01', updatedAt: '2026-01-01', interviews: [] }
    ]));
    const html = (await get('/')).text;
    assert.ok(/<h1[^>]*>简历<\/h1>/.test(html), '状态 2 应渲染「简历」列表标题');
    assert.ok(html.includes('class="docrow"'), '状态 2 应渲染文档行');
    // ④ 已投递口径：docId 被 applications.json 引用 → dot-sent「已投递」（权威来源派生，不读存储状态）
    const draftAt = idx(html, '>合成岗位稿<');
    assert.ok(draftAt > 0 && html.slice(draftAt, draftAt + 1600).includes('dot-sent'), '已投递文档行应出 dot-sent');
    assert.ok(html.slice(draftAt, draftAt + 1600).includes('>已投递<'), '已投递文档行应出「已投递」状态点文案');
    // ③ continueBtn 按 T3 模板只在状态 1 渲染
    assert.ok(!html.includes('id="continueBtn"'), '状态 2 不渲染 continueBtn');
    // 入口唯一：有母版的状态下 /job/new 只出现一次（底部入口行）
    assert.equal((html.match(/href="\/job\/new"/g) || []).length, 1, '状态 2（有母版）/job/new 入口应唯一');
    // 待办卡：合成数据无陈旧 PDF/无 LLM/无未整理 → 真待办为空不渲染；有真待办才出现
    assert.ok(!html.includes('<h1>待办</h1>'), '无真待办时不渲染待办卡');
    // 真待办到场：写坏 lastRenderInputId 造陈旧 PDF
    fs.writeFileSync(path.join(root, 'pdfs', 'masterbench.pdf'), '%PDF-1.4 fake');
    const meta2 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta2.masterbench.lastRenderInputId = 'stale-rid-marker';
    fs.writeFileSync(metaPath, JSON.stringify(meta2));
    const html2 = (await get('/')).text;
    assert.ok(html2.includes('<h1>待办</h1>'), '有真待办时状态 2 应渲染待办卡');
    assert.ok(html2.includes('PDF 不是最新'), '待办卡应含陈旧 PDF 重导项');
    assert.ok(html2.includes('重新导出'), '待办卡陈旧项应指向重新导出');
  }

  // ===== E. 源级钉值：T3 新 CSS 规则在场 + 间距 token + 主行动 hover 零投影 =====
  {
    const html = (await get('/')).text;
    // 先剥 /* */ 注释再按 } 边界取规则体（.dot 等紧跟注释的规则否则失配）
    const css = (html.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const cssRule = (sel) => {
      const m = css.match(new RegExp('(?:^|\\})\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}'));
      return m ? m[1] : '';
    };
    for (const sel of ['.dot', '.dot-draft', '.dot-ready', '.dot-sent', '.st', '.home-start',
      '.start-cards', '.start-card', '.doc-thumb', '.docrow', '.resume-hero', '.todo-list', '.foot-links']) {
      assert.ok(cssRule(sel), `T3 新规则 ${sel} 应在页面 <style> 内`);
    }
    // 三态点色：草稿=mut / 可投递=warn / 已投递=ok（彩色只承载状态，DESIGN.md §3）
    assert.ok(cssRule('.dot-draft').includes('var(--mut)') && cssRule('.dot-ready').includes('var(--warn)') && cssRule('.dot-sent').includes('var(--ok)'),
      '状态点三色应为 mut/warn/ok（草稿/可投递/已投递）');
    // §5.1：与 --space-* 档重合的间距必须 var()（档内值不得回退字面 px）
    for (const [sel, frag] of [['.docrow', 'padding:10px var(--space-4)'], ['.todo-list li', 'var(--space-4)'],
      ['.start-cards', 'var(--space-4)'], ['.foot-links', 'var(--space-4)']]) {
      assert.ok(cssRule(sel).includes(frag), `${sel} 档内间距应引用 token（§5.1），实际: ${cssRule(sel)}`);
    }
    // 主行动 .cta:hover：零投影、保留位移（hover 删影留位移，与 R2⑩ button:hover 同款）
    const ctaHover = cssRule('.cta:hover');
    assert.ok(ctaHover.includes('translateY(-1px)'),
      '.cta:hover 应保留位移反馈（删影留位移），实际: ' + ctaHover);
    assert.ok(!ctaHover.includes('box-shadow'),
      '.cta:hover 不得有 box-shadow（§3.1 静态层级零阴影），实际: ' + ctaHover);
  }

  console.log('✅ 首页三态台面（退役标记清零 + 起步/继续/待办三态 + 行式列表 + 状态点 + 回退链契约 + ⋯ 全量操作 + T3 CSS 钉值）');
} catch (e) {
  console.error('❌ ' + (e && e.message));
  process.exitCode = 1;
} finally {
  cleanup();
}
