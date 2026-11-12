// test-job-new-page.mjs — 批 1 /job/new 拆页卡：首页「针对岗位生成」表单整体迁移到独立页 /job/new「为岗位定制简历」。
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §2（表单整体迁移/首页只留入口/弹层标题/视觉截图夹具七路由含 /job/new）+ §0.3 裁决。
// 覆盖（断言逐条独立）：
//   A 空库：/job/new 200 + 页题/h1「为岗位定制简历」+ 无母版空态（既有 jobCard 空态口径迁入）+ 不渲染表单。
//   B 有母版：字段 id/默认值/接线全保留（提交体字段名零变化）；渐进呈现 T4 单动线结构在场——
//     三段 step（JD→母版→生成）/ jdModeLink 切换 / 公司岗位改可选（折叠区内，零 required）/ 评估降级文字链接。
//   C 首页拆出：首页无表单（#jobCard/#jobForm/brief*/evalBtn/evalResult 全不在场）；T3 起入口收敛为
//     状态 1 的岗位定制引导卡（href="/job/new"，非表单，全页唯一）。
//   D 契约零变化（行为面）：/job/new 页内联脚本按原字段构建的 payload POST /job/create → 200 {ok:true,id}、
//     meta.parent 继承；/eval/create 未配置 LLM → 409 JSON 带 settingsPath='/settings'（R2② 契约原样）。
//   D2 渐进呈现 T4（行为面）：公司/岗位全缺省 → meta 落「未命名·定制」占位；同 JD 复投 409 existing、
//     异 JD 不撞名；部分缺省单侧占位；invalid from 400 与缺母版 404 既有错误路径不动。
//   E 名称统一与截图路由：server.mjs/editor-shell.js 旧名「针对岗位生成」零残留；弹层标题改「为岗位定制简历」；
//     视觉截图夹具 routes 含 ['job-new', '/job/new']。
//   G 轨 A 收口（spec §10.20）：GET 书签行（javascript: + 实际端口 /import/page）+ 隐藏 jdFailHint + submit
//     jdError 失败回调接线；POST /job/new urlencoded {jd,company,role,jdLink,from} → 预填/展开/selected/XSS/
//     非 http(s) 拒填/非法 from 不预选/空带入 = GET 渲染等价。
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
    // 渐进呈现 T4：公司/岗位改可选——字段仍在（收入「补充要求」折叠区），required 客户端校验退役
    assert.ok(!/id="jobCompany"[^>]*required/.test(html), '公司不再必填（渐进呈现 T4：可留空自动识别）');
    assert.ok(!/id="jobRole"[^>]*required/.test(html), '岗位不再必填（渐进呈现 T4：可留空自动识别）');
    // 单动线三段（1 岗位描述 → 2 用哪份简历改 → 3 生成）+ JD↔链接小字切换 + 诚实预期文案
    assert.equal((html.match(/class="step"/g) || []).length, 3, '单动线应为三段 step（岗位描述→母版→生成）');
    assert.ok(html.includes('id="jdModeLink"') && html.includes('id="jdLinkRow"'), '应有 JD↔链接小字切换（jdModeLink/jdLinkRow）');
    assert.ok(html.includes('粘贴招聘页链接'), '应有「或粘贴招聘页链接」切换文案');
    assert.ok(html.includes('产出一份新草稿'), '应有诚实预期文案「产出一份新草稿」');
    // 母版下拉：合成母版在场
    assert.ok(html.includes('value="jnmaster"'), '母版下拉应含合成母版 jnmaster');
    // 按钮：生成岗位草稿（submit）+ 先评估匹配度（evalBtn，T4 起降级为次级文字链接 <a>）
    assert.ok(html.includes('生成岗位草稿'), '应保留「生成岗位草稿」主按钮');
    assert.ok(html.includes('id="evalBtn"') && html.includes('先评估匹配度'), '应保留「先评估匹配度」评估入口');
    assert.ok(/<a[^>]*id="evalBtn"/.test(html), 'evalBtn 应为 <a> 次级文字链接形态（T4 降级，不与主按钮平级）');
    // 要求卡：预设/重点/保留/不强调/幅度/页数六要素 label 文案原样（折叠区 T4 改名「补充要求」）
    for (const t of ['补充要求（可选，默认已按经验填好）', '取回常用预设', '存为常用预设',
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
    assert.ok(html.includes('评估需要岗位描述文本'), '评估需要 JD 的客户端校验应保留（T4：JD 与链接均空时拦截）');
    // ===== T3 轨 A 收口（spec §10.20 §2.1/§2.6）：书签交付 + 抓取失败引导锚点 =====
    // 可拖书签：href=javascript: 前缀 + action=本机实际端口 /import/page（端口不写死——顺延情形书签仍指对）。
    const bm = (html.match(/<a href="javascript:[^"]*">/) || [])[0] || '';
    assert.ok(bm.startsWith('<a href="javascript:'), '链接区应渲染可拖 javascript: 书签');
    assert.ok(bm.includes('/import/page'), '书签 action 应指向 /import/page');
    assert.ok(bm.includes(`localhost:${port}`), `书签 action 应为本实例实际端口 localhost:${port}（不写死 7766）`);
    assert.ok(html.includes('拖到书签栏') && html.includes('抓取此页 → 工作台'), '应有书签拖拽提示文案');
    // 失败引导：隐藏 #jdFailHint（含同一书签链接）；submit 回调在 d.jdError（链接抓取失败）分支
    // 留页显示它——草稿已建，给「复制全文粘贴 / 书签」两条退路（不静默跳走）。
    assert.ok(/id="jdFailHint" style="display:none/.test(html), '应有默认隐藏的 #jdFailHint 失败引导块');
    assert.ok(html.includes('这个站抓不到'), 'jdFailHint 应有「这个站抓不到（多半要登录）」文案');
    const hintBlk = (html.match(/<div id="jdFailHint"[\s\S]*?<\/div>/) || [])[0] || '';
    assert.ok(hintBlk.includes('href="javascript:') && hintBlk.includes('/import/page'), 'jdFailHint 应内联同一书签链接');
    assert.ok(html.includes('d.jdError'), 'submit 回调应有 jdError 分支（链接抓取失败路径）');
    assert.ok(html.includes("document.getElementById('jdFailHint')"), 'jdError 失败回调应显示 jdFailHint（零新事件类型）');
  }

  // ===== C. 首页拆出：无表单，只留入口按钮 =====
  {
    const home = await get('/');
    assert.equal(home.status, 200, '首页应 200');
    const html = home.text;
    // 表单与其专属 UI 整体迁出（含空态——空态已迁入 /job/new）
    for (const marker of ['id="jobCard"', 'id="jobForm"', 'id="briefFocusChips"', 'id="evalBtn"',
      'id="evalResult"', 'id="taskJobCta"', '生成岗位草稿', '先评估匹配度', '还没有母版简历']) {
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

  // ===== D2. 渐进呈现 T4：公司/岗位改可选——缺省落「未命名·定制」占位，去重身份在任一侧占位时按 JD 指纹区分 =====
  {
    // 全缺省：company/role 不传 → meta 占位终值（「未命名·定制」）
    const un1 = await postJson('/job/create', { from: 'jnmaster', jd: 'T4-JD-甲：增长方向' });
    assert.equal(un1.status, 200, '全缺省公司/岗位应 200（占位兜底），实际 ' + un1.status + ' ' + un1.text.slice(0, 160));
    const metaU = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal((metaU[un1.json.id] || {}).company, '未命名', '全缺省 meta.company 应落「未命名」');
    assert.equal((metaU[un1.json.id] || {}).role, '定制', '全缺省 meta.role 应落「定制」');
    assert.equal((metaU[un1.json.id] || {}).tag, '未命名·定制', '占位草稿 tag 应为「未命名·定制」');
    // 同一 JD 复投 → 撞既有草稿（409 existing），不得再建一份
    const un2 = await postJson('/job/create', { from: 'jnmaster', jd: 'T4-JD-甲：增长方向' });
    assert.equal(un2.status, 409, '同一 JD 的缺省草稿应查重 409，实际 ' + un2.status + ' ' + un2.text.slice(0, 160));
    assert.equal((un2.json || {}).existing, un1.json.id, '409 应回指既存草稿 ' + un1.json.id);
    // 不同 JD → 不撞名（JD 指纹段参与身份）→ 新草稿
    const un3 = await postJson('/job/create', { from: 'jnmaster', jd: 'T4-JD-乙：另一岗位' });
    assert.equal(un3.status, 200, '不同 JD 的缺省草稿不得撞名，实际 ' + un3.status + ' ' + un3.text.slice(0, 160));
    assert.notEqual(un3.json.id, un1.json.id, '不同 JD 应产出新草稿');
    // 部分缺省：只给岗位 → 公司落「未命名公司」；只给公司 → 岗位落「未命名岗位」
    const un4 = await postJson('/job/create', { from: 'jnmaster', role: '增长工程师', jd: 'T4-JD-丙' });
    assert.equal(un4.status, 200, '部分缺省应 200');
    const metaU4 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal((metaU4[un4.json.id] || {}).company, '未命名公司', '只给岗位时公司应落「未命名公司」');
    assert.equal((metaU4[un4.json.id] || {}).role, '增长工程师', '给定岗位原样保留');
    // 对称缺省：只给公司 → 岗位落「未命名岗位」
    const un5 = await postJson('/job/create', { from: 'jnmaster', company: '定制公司', jd: 'T4-JD-丁' });
    assert.equal(un5.status, 200, '只给公司应 200');
    const metaU5 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal((metaU5[un5.json.id] || {}).role, '未命名岗位', '只给公司时岗位应落「未命名岗位」');
    assert.equal((metaU5[un5.json.id] || {}).tag, '定制公司·未命名岗位', '单侧占位 tag 应为「定制公司·未命名岗位」');
    // I-1 回归钉：单侧占位 + 不同 JD → 新草稿（不得误 409）；同 JD → 409 existing
    const un6 = await postJson('/job/create', { from: 'jnmaster', role: '增长工程师', jd: 'T4-JD-戊：另一岗位' });
    assert.equal(un6.status, 200, '单侧占位+异 JD 不得撞名（I-1），实际 ' + un6.status + ' ' + un6.text.slice(0, 160));
    assert.notEqual(un6.json.id, un4.json.id, '同岗位异 JD 应产出新草稿');
    const un7 = await postJson('/job/create', { from: 'jnmaster', role: '增长工程师', jd: 'T4-JD-戊：另一岗位' });
    assert.equal(un7.status, 409, '单侧占位+同 JD 应查重 409，实际 ' + un7.status + ' ' + un7.text.slice(0, 160));
    assert.equal((un7.json || {}).existing, un6.json.id, '409 应回指 ' + un6.json.id);
    // 链接模式查重：同 jdLink 复投 → 409 existing（抓取失败也按来源链接判同）；异链接 → 新草稿
    const lk1 = await postJson('/job/create', { from: 'jnmaster', jdLink: 'http://127.0.0.1:1/t4-x' });
    assert.equal(lk1.status, 200, 'jdLink 提交应 200（抓取失败也建稿并记 jdError），实际 ' + lk1.status + ' ' + lk1.text.slice(0, 160));
    const lk2 = await postJson('/job/create', { from: 'jnmaster', jdLink: 'http://127.0.0.1:1/t4-x' });
    assert.equal(lk2.status, 409, '同 jdLink 复投应 409 existing，实际 ' + lk2.status + ' ' + lk2.text.slice(0, 160));
    assert.equal((lk2.json || {}).existing, lk1.json.id, '409 应回指 ' + lk1.json.id);
    const lk3 = await postJson('/job/create', { from: 'jnmaster', jdLink: 'http://127.0.0.1:1/t4-y' });
    assert.equal(lk3.status, 200, '异 jdLink 不得撞名（空 jd 互等不算同），实际 ' + lk3.status);
    // I-2 跨形态重查：链接建稿 → 同文本粘贴撞名；异 URL 同正文链接 → 抓取回填后重查命中
    // （自服务 /evals 作确定性抓取源：fetchPageText 剥 <script> 后文本按页内容定值，异 query 同正文）
    const sv1 = await postJson('/job/create', { from: 'jnmaster', jdLink: base + '/evals' });
    assert.equal(sv1.status, 200, '自服务链接应建稿，实际 ' + sv1.status + ' ' + sv1.text.slice(0, 160));
    const metaSv = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const fetchedJd = (metaSv[sv1.json.id] || {}).jd || '';
    assert.ok(fetchedJd.length > 20, '自服务链接应抓回正文文本，实际 jd=' + fetchedJd.slice(0, 60));
    const sv2 = await postJson('/job/create', { from: 'jnmaster', jd: fetchedJd });
    assert.equal(sv2.status, 409, '链接草稿的同文本粘贴应撞名 409，实际 ' + sv2.status);
    assert.equal((sv2.json || {}).existing, sv1.json.id, '409 应回指链接草稿 ' + sv1.json.id);
    const sv3 = await postJson('/job/create', { from: 'jnmaster', jdLink: base + '/evals?x=2' });
    assert.equal(sv3.status, 409, '异 URL 同正文链接应在抓取后重查命中（I-2），实际 ' + sv3.status + ' ' + sv3.text.slice(0, 160));
    assert.equal((sv3.json || {}).existing, sv1.json.id, 'I-2 重查 409 应回指 ' + sv1.json.id);
    // 既有 400/404 错误路径不动：非法母版 id → 400 invalid from；缺母版文档 → 404
    const bad1 = await postJson('/job/create', { from: '!!!', jd: 'x' });
    assert.equal(bad1.status, 400, '非法母版 id 仍应 400（invalid from），实际 ' + bad1.status);
    const bad2 = await postJson('/job/create', { from: 'notexist', jd: 'x' });
    assert.equal(bad2.status, 404, '缺母版文档仍应 404，实际 ' + bad2.status);
  }

  // ===== G. POST /job/new 预填（JD 导入轨 A 收口，spec §10.20 §2.5）：urlencoded 五字段 → 同表单回填 =====
  {
    const postForm = (fields) => fetch(base + '/job/new', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString()
    }).then(async (r) => ({ status: r.status, text: await r.text() }));
    // 全字段带入：jd 进 textarea 体；company/role 进 value；jdLink 进 value 且行展开；from 预选母版。
    const pre = await postForm({ jd: '合成 JD 全文：负责平台增长与稳定性建设', company: '合成公司A',
      role: '增长工程师', jdLink: 'https://www.zhipin.com/job_detail/abc123.html', from: 'jnmaster' });
    assert.equal(pre.status, 200, 'POST /job/new 应 200，实际 ' + pre.status + ' ' + pre.text.slice(0, 160));
    const ph = pre.text;
    assert.ok(/<textarea id="jobJd"[^>]*>合成 JD 全文：负责平台增长与稳定性建设<\/textarea>/.test(ph), 'jobJd 应预填 JD 文本进 textarea 体');
    assert.ok(/id="jobCompany"[^>]*value="合成公司A"/.test(ph), 'jobCompany 应预填公司 value');
    assert.ok(/id="jobRole"[^>]*value="增长工程师"/.test(ph), 'jobRole 应预填岗位 value');
    const row = (ph.match(/<div id="jdLinkRow"[^>]*>/) || [])[0] || '';
    assert.ok(row && !row.includes('display:none'), '预填 jdLink 时 jdLinkRow 应展开（无 display:none）：' + row);
    assert.ok(/id="jobLink"[^>]*value="https:\/\/www\.zhipin\.com\/job_detail\/abc123\.html"/.test(ph), 'jobLink 应预填来源链接');
    assert.ok(ph.includes('<option value="jnmaster" selected>'), 'jobFrom 应把 from 母版预选为 selected');
    // XSS：jd 内的标签必须 escHtml 进 textarea 体，不得原样回显
    const xs = await postForm({ jd: 'ok<img src=x onerror=alert(1)>', from: 'jnmaster' });
    assert.ok(!xs.text.includes('<img src=x onerror=alert(1)>'), 'textarea 预填不得残留未转义标签');
    assert.ok(xs.text.includes('&lt;img'), 'textarea 预填应转义为实体');
    // 非 http(s) jdLink 不预填：行保持折叠、jobLink 无 value（safeUrl+^https?:// 双闸门）
    const bad = await postForm({ jdLink: 'javascript:alert(1)', from: 'jnmaster' });
    const badRow = (bad.text.match(/<div id="jdLinkRow"[^>]*>/) || [])[0] || '';
    assert.ok(badRow.includes('display:none'), '非 http(s) jdLink 不预填、链接行应保持折叠');
    assert.ok(!/id="jobLink"[^>]*value=/.test(bad.text), 'javascript: 不得进 jobLink value');
    // 非法 from id（不过 VALID_ID）不预选：全页不得出现 selected 属性
    const bf = await postForm({ from: 'bad id!', jd: 'x' });
    assert.ok(!bf.text.includes(' selected'), '非法 from id 不得产生 selected');
    // 空带入 → 与 GET 渲染等价（剥逐响应 nonce 后逐字一致：GET 路径零变化的行为钉）
    const g = await get('/job/new');
    const emp = await postForm({});
    const strip = (s) => s.replace(/nonce="[^"]+"/g, 'nonce="N"');
    assert.equal(strip(emp.text), strip(g.text), 'POST /job/new 空带入应与 GET 渲染逐字一致（GET 路径零变化）');
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
