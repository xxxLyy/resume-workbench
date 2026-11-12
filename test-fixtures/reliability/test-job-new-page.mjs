// test-job-new-page.mjs — 批 1 /job/new 拆页卡：首页「针对岗位生成」表单整体迁移到独立页 /job/new「为岗位定制简历」。
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §2（表单整体迁移/首页只留入口/弹层标题/视觉截图夹具七路由含 /job/new）+ §0.3 裁决。
// 覆盖（断言逐条独立）：
//   A 空库：/job/new 200 + 页题/h1「为岗位定制简历」+ 无母版空态（既有 jobCard 空态口径迁入）+ 不渲染表单。
//   B 有母版：表单字段/结构与首页拆出前零变化（id/label/默认值/按钮全保留）+ 提交与评估接线字符串在场。
//   C 首页拆出：首页无表单（#jobCard/#jobForm/brief*/evalBtn/evalResult 全不在场）；T3 起入口收敛为
//     状态 1 的岗位定制引导卡（href="/job/new"，非表单，全页唯一）。
//   D 契约零变化（行为面）：/job/new 页内联脚本按原字段构建的 payload POST /job/create → 200 {ok:true,id}、
//     meta.parent 继承；/eval/create 未配置 LLM → 409 JSON 带 settingsPath='/settings'（R2② 契约原样）。
//   E 名称统一与截图路由：server.mjs/editor-shell.js 旧名「针对岗位生成」零残留；弹层标题改「为岗位定制简历」；
//     视觉截图夹具 routes 含 ['job-new', '/job/new']。
//   F DESIGN.md 红线自查（本卡新写代码）：首页引导卡内联样式与档内间距一律 --space-* token（§5.1），
//     不留与 4/8/12/16/24 档重合的字面 px（14px 不在档内，登记为字面层级）。
//     （§9.1-2 空态不复述页题的钉在 A 段——空态只在空库渲染，须在播种母版前断言）
// 纪律：隔离 RESUME_ROOT（mkdtemp）+ 随机端口 + 合成数据；不读真实简历、不碰 7766、不调真实模型；仓库零写入。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobnew-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 刻意不写 config.json → hasLLM=false：/job/create 不依赖模型（独立文档），/eval/create 走 409 settingsPath 契约

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
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));
const base = `http://127.0.0.1:${port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, text: await r.text() }; };
const postJson = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();   // 只读一次：json/text 双读会抛「Body has already been read」
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

// 合成母版：真模板骨架 + 显式 h1 标题 + meta 直写（绕过 LLM 动线）
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

  // ===== A. 空库：/job/new 空态（既有 jobCard 空态口径迁入新页）=====
  {
    const r = await get('/job/new');
    assert.equal(r.status, 200, '/job/new 空库应 200，实际 ' + r.status);
    const html = r.text;
    assert.ok(html.includes('<title>为岗位定制简历</title>'), '页题应为「为岗位定制简历」');
    assert.ok(html.includes('<h1>为岗位定制简历</h1>'), '页面第一标题应为「为岗位定制简历」');
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, '/job/new 应只有一个 h1（三档收两档）');
    assert.ok(html.includes('还没有母版简历'), '空库应渲染「还没有母版简历」空态（原 jobCard 空态迁入）');
    assert.ok(html.includes('需要一份母版简历'), '空态应说明需要母版简历');
    assert.ok(html.includes('action="/new"'), '空态应提供「＋ 新建空白简历」直达（POST /new 既有口径）');
    assert.ok(html.includes('href="/#up"'), '空态导入指引应指向首页上传锚点 /#up（新页自身无上传区）');
    assert.ok(!html.includes('id="jobForm"'), '空库不渲染岗位表单（A3 空态既有契约）');
    assert.ok(html.includes('class="on"'), '/job/new 应由 page() 渲染并带当前项高亮（active=docs）');
    // §9.1-2：空态说明不得复述页题（h1 已说清「为岗位定制简历」）；门控说明与去向指引保留（§9.2-1/§9.2-4）
    // 取样定位：剥掉 <script> 块（页内 EVAL_CARD_JS 的模板串不是渲染内容）后，扫描全部服务端渲染的
    // <p style=...> 段落——不依赖「首个匹配」的位置，页面壳新增更早的段落也不会误指对象；
    // 空态说明段的文案指纹「需要一份母版简历」已由上方断言单独钉住。
    const renderedParas = html.replace(/<script[\s\S]*?<\/script>/g, '').match(/<p style="[^"]*">[\s\S]*?<\/p>/g) || [];
    assert.ok(renderedParas.length > 0, '/job/new 空态应有一段说明文字');
    const titleEcho = renderedParas.filter((p) => p.includes('为岗位定制简历'));
    assert.deepEqual(titleEcho, [],
      '空态说明不得复述页题「为岗位定制简历」（§9.1-2），实际：' + titleEcho.join(' || '));
  }

  // ===== B. 有母版：表单整体迁移（字段/校验/接线与拆出前零变化）=====
  {
    seedDoc('jnmaster', '合成母版简历');
    const r = await get('/job/new');
    assert.equal(r.status, 200, '/job/new 有母版应 200');
    const html = r.text;
    // 表单骨架：id 全保留（客户端接线与既有断言口径同源）
    for (const id of ['jobForm', 'jobCompany', 'jobRole', 'jobFrom', 'jobLink', 'jobJd',
      'briefPresetSel', 'briefPresetSave', 'briefPresetDel', 'briefFocusChips', 'briefKeep', 'briefDeem',
      'briefDegree', 'briefPages', 'jobMsg', 'evalMsg', 'evalResult']) {
      assert.ok(html.includes('id="' + id + '"'), `/job/new 表单应保留字段 #${id}（契约零变化）`);
    }
    assert.ok(html.includes('required'), '公司/岗位 required 客户端校验应保留');
    // 母版下拉：合成母版在场
    assert.ok(html.includes('value="jnmaster"'), '母版下拉应含合成母版 jnmaster');
    // 按钮：生成岗位草稿（submit）+ 先评估这个岗位（evalBtn）
    assert.ok(html.includes('生成岗位草稿'), '应保留「生成岗位草稿」主按钮');
    assert.ok(html.includes('id="evalBtn"') && html.includes('先评估这个岗位'), '应保留「先评估这个岗位」评估入口');
    // 要求卡：预设/重点/保留/不强调/幅度/页数六要素 label 文案原样
    for (const t of ['本次定制要求（可选，默认已按经验填好）', '取回常用预设', '存为常用预设',
      '本次重点（点击选中/取消；建议来自素材标签）', '必须保留的项目（一行一个）', '不希望强调（一行一个）',
      '轻度精简', '重点调整', '重新组织', '2 页（默认）']) {
      assert.ok(html.includes(t), `/job/new 要求卡应保留文案「${t}」`);
    }
    // 默认值：degree=refocus、pages=2 aria-pressed 初始态（与拆出前一致）
    assert.ok(/data-deg="refocus"[^>]*aria-pressed="true"/.test(html.replace(/\n/g, '')) || /data-deg="refocus"[\s\S]{0,40}aria-pressed="true"/.test(html), '幅度默认应为「重点调整」（aria-pressed）');
    assert.ok(/data-pages="2"[\s\S]{0,40}aria-pressed="true"/.test(html), '页数默认应为 2 页（aria-pressed）');
    // 提交接线：/job/create payload 由原字段构建（关键片段原样保留）
    for (const frag of ["fetch('/job/create'", "from: document.getElementById('jobFrom').value",
      "company: document.getElementById('jobCompany').value.trim()", "role: document.getElementById('jobRole').value.trim()",
      "jd: document.getElementById('jobJd').value", "jdLink: document.getElementById('jobLink').value.trim()",
      'brief: brief', "invalid from"]) {
      assert.ok(html.includes(frag), `/job/new 提交接线应保留片段：${frag}`);
    }
    // 评估接线：/eval/create → evalCardHtml 报告 → /eval/promote 转适配（同一套委托逻辑原样）
    for (const frag of ["fetch('/eval/create'", "fetch('/eval/promote'", 'evalCardHtml(', 'data-eval-act', 'EVAL_BTN_ICON']) {
      assert.ok(html.includes(frag), `/job/new 评估接线应保留片段：${frag}`);
    }
    assert.ok(html.includes('JD 必填：评估需要岗位描述文本'), '评估 JD 必填客户端校验应保留');
  }

  // ===== C. 首页拆出：无表单，只留入口按钮 =====
  {
    const home = await get('/');
    assert.equal(home.status, 200, '首页应 200');
    const html = home.text;
    // 表单与其专属 UI 整体迁出（含空态——空态已迁入 /job/new）
    for (const marker of ['id="jobCard"', 'id="jobForm"', 'id="briefFocusChips"', 'id="evalBtn"',
      'id="evalResult"', 'id="taskJobCta"', '生成岗位草稿', '先评估这个岗位', '还没有母版简历']) {
      assert.ok(!html.includes(marker), `首页不得再含岗位表单标记「${marker}」（已迁 /job/new）`);
    }
    // T3 引导卡（有母版态）：「为岗位定制 →」直达新页，全页入口唯一
    const gcA = html.indexOf('要投某个岗位');
    assert.ok(gcA >= 0, '有母版时首页应渲染岗位定制引导卡「要投某个岗位？」');
    const gc = html.slice(Math.max(0, gcA - 400), gcA + 900);
    assert.ok(gc.includes('为岗位定制') && gc.includes('href="/job/new"'), '引导卡应含「为岗位定制 →」入口直达 /job/new');
    assert.equal((html.match(/href="\/job\/new"/g) || []).length, 1,
      '首页 /job/new 入口应唯一（引导卡承载，底部入口行不重复）');
    // 底部入口行（新建/从零开始/导入/归档开关）：定制入口不在此行（状态 1 由引导卡承载）
    const foot = html.slice(html.indexOf('class="foot-links"'), html.indexOf('class="foot-links"') + 1600);
    assert.ok(foot.includes('action="/new"'), '底部入口行应保留「新建空白简历」');
    assert.ok(!foot.includes('href="/job/new"'), '状态 1 底部入口行不得重复 /job/new 入口');
  }

  // ===== D. 契约零变化（行为面）：payload 形状 = /job/new 表单构建的形状 =====
  {
    const r = await postJson('/job/create', {
      from: 'jnmaster', company: '合成公司', role: '前端工程师', jd: '负责高并发服务', jdLink: '',
      brief: { focus: [], keepProjects: [], deemphasize: [], degree: 'refocus', pages: 2, preset: null }
    });
    assert.equal(r.status, 200, '/job/create 表单形状 payload 应 200，实际 ' + r.status + ' ' + r.text.slice(0, 200));
    assert.ok(r.json && r.json.ok === true && r.json.id, '/job/create 应返回 {ok:true,id}');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal((meta[r.json.id] || {}).parent, 'jnmaster', '草稿应继承母版（meta.parent）');
    // 新建草稿回到 /job/new：母版下拉列全部在盘文档（与拆出前 infos 口径一致）
    const again = await get('/job/new');
    assert.ok(again.text.includes(r.json.id), '/job/new 母版下拉应含新建草稿（拆出前 infos 全量口径零变化）');
    // /eval/create 未配置 LLM：409 JSON + settingsPath（评估按钮依赖的既有契约，R2②）
    const ev = await postJson('/eval/create', { from: 'jnmaster', company: '合成公司', role: '前端', jd: '负责高并发服务' });
    assert.equal(ev.status, 409, '/eval/create 未配置 LLM 应 409');
    assert.ok(ev.json && ev.json.ok === false && ev.json.settingsPath === '/settings', '/eval/create 409 应带 settingsPath=/settings：' + ev.text.slice(0, 160));
  }

  // ===== F. DESIGN.md 红线自查（本卡新写代码）：间距 token =====
  {
    // F1 首页岗位定制引导卡：与 --space-* 档重合的间距（外边距/纵向内边距/列距）一律 var()；
    // 14px 不在 4/8/12/16/24 档内，登记为字面层级（§5.1「凡等于档内值必须 token」的反向边界钉）。
    const home = await get('/');
    const gcTag = (home.text.match(/<div class="card" style="[^"]*">(?=\s*<div style="flex:1"><b[^>]*>要投某个岗位)/) || [])[0];
    assert.ok(gcTag, '引导卡应为 <div class="card" style="…"> 且首子块为「要投某个岗位？」，实际取样失败');
    assert.ok(gcTag.includes('margin-top:var(--space-4)'), '引导卡外边距应引用 token：' + gcTag);
    assert.ok(gcTag.includes('var(--space-4)') && gcTag.includes('gap:var(--space-3)'), '引导卡内边距/列距应引用 token：' + gcTag);
    const rampLiteral = gcTag.match(/(?:padding|margin|gap)(?:-(?:top|right|bottom|left))?:(?:[^;"]*?\s)?(4|8|12|16|24)px/g) || [];
    assert.deepEqual(rampLiteral, [],
      '引导卡样式不得留与档内值重合的字面 px（§5.1），实际：' + JSON.stringify(rampLiteral));
  }

  // ===== E. 名称统一 + 编辑器弹层标题 + 视觉截图夹具路由（源级钉）=====
  {
    const srv = fs.readFileSync(path.join(APP_ROOT, 'server.mjs'), 'utf8');
    const sh = fs.readFileSync(path.join(APP_ROOT, 'editor-shell.js'), 'utf8');
    const vis = fs.readFileSync(path.join(APP_ROOT, 'test-fixtures/reliability/test-visual-screens.mjs'), 'utf8');
    assert.ok(!srv.includes('针对岗位生成'), 'server.mjs 旧名「针对岗位生成」应零残留（§0.3 改名统一）');
    assert.ok(!sh.includes('针对岗位生成'), 'editor-shell.js 旧名「针对岗位生成」应零残留（弹层标题/素材提示/注释）');
    assert.ok(sh.includes("h.innerHTML = __icon('target') + ' 为岗位定制简历';"), '编辑器「＋ 岗位草稿」弹层标题应改为「为岗位定制简历」');
    assert.ok(sh.includes("不会参与「为岗位定制简历」"), '素材未确认提示应同步新名称');
    assert.ok(sh.includes("aria-label', '为岗位定制简历'"), '弹层 aria-label 应与可见标题同步（可访问名称）');
    assert.ok(vis.includes("['job-new', '/job/new']"), '视觉截图夹具 routes 应含 /job/new（七路由 → 八路由）');
  }

  console.log('✅ /job/new 拆页（表单整体迁移零契约变化 + 首页只留入口 + 弹层标题 + 截图路由）');
} catch (e) {
  console.error('❌ ' + (e && e.message));
  process.exitCode = 1;
} finally {
  cleanup();
}
