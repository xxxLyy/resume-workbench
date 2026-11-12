# 渐进呈现 UX 重设计 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让首次使用的用户不看文档就知道下一步：导航 6→3、首页按数据状态只展示「下一步」、/job/new 改单动线。藏不砍，不动数据模型。

**Architecture:** 全部改动集中在 `server.mjs` 的视图层（`page()`/`listPage()`/`jobNewPage()`/`createJobDraft()`/应用页内联 HTML）+ page() 内 `<style>` 块新增少量类。零新数据字段、零新路由、零新依赖。已批准视觉稿：`dev-docs/2026-11-12-ux-progressive-disclosure-mock.html`（样式落地时**改用 A-VARS token**，不用 mockup 里的字面 hex）。

**Tech Stack:** Node 零框架单服务、`page()` 模板字符串渲染、CSP nonce 内联脚本、test.sh/test-structure.sh/test-fixtures 断言体系。

**Spec:** `dev-docs/2026-11-12-progressive-disclosure-ux-design.md`

**关键既有事实（实施前必读）**

- `page(title, inner, active, wide)` 在 server.mjs:1609；`nav()` helper 在 1611；topnav 模板在 **1809**（单行，6 个 `${nav(...)}`）；页脚「简历平台」在 **1811**。
- A-VARS 在 :1620：`--accent:#18181b`（近黑=主操作）、`--warning:#A25711`（橙=导出/需处理）、`--success:#15803D`（绿=已投出）、`--muted:#737373`（灰=草稿）。**状态点三色全部用既有 token，零新色**。
- `listPage` 在 :2079–2357；`jobNewPage` 在 :2365 起；`createJobDraft` 在 :305（:310 公司岗位必填校验、:320 claim 键、:336-340 查重、:376-379 meta 写入）。
- `followUpState(app, {nowMs, thresholdDays})` → `{due}`（followup.mjs，/applications 在 :6313-6318 已示范用法）；`followUpDays(root)` 取阈值。
- `staleInfo`、`deliveredRefs`、`flowOf`、`deliverableNow`、`statusLabel`、`docInfo`、`loadApps`、`loadMeta`、`docIdsOnDisk` 均在 listPage 上下文可用。
- `/applications`（看板+表格两视图）内联渲染自 :6273 起；`applyProfilePage` 在 :2698（page() 收尾 `'apply'` 在 :3088）；`/stats` 在 :7491（page() 收尾 `'stats'` 在 :7495/:7574）；`/materials` 收尾 `'materials'` 在 :6018。
- 会撞的断言：`test-structure.sh` :4355-4360（/evals topnav 链接数）、:4577-4640（NAV 清单/链接数/入口名/topnav 位置）；`test.sh` :303、:357、:2547 段16u；`test-fixtures/reliability/test-job-new-page.mjs` :114-155（字段 id/required/提交体断言）。
- 纪律：可见变化先登记 DESIGN.md（Task 1）；撞断言按 R3① 先例「意图不变的用例适配、断言零放宽、同提交」；新增内联脚本必须 `nonce="__CSP_NONCE__"`，事件走 `data-action` + `__acts` 委托桶，不写内联 handler。

---

### Task 1: DESIGN.md 登记本轮裁决

**Files:**
- Modify: `DESIGN.md`（§10 组件裁决区末尾追加小节；§4 导航章如有 6 项清单则同步改）

- [ ] **Step 1: 追加登记小节**

在 DESIGN.md §10 末尾追加（编号顺延现有小节，如 §10.19）：

```markdown
## §10.19 渐进呈现（2026-11-12，spec: dev-docs/2026-11-12-progressive-disclosure-ux-design.md）

- 导航唯一 topnav 收缩为 3 项：简历 / 投递 / 设置。素材库→编辑器内；网申包、复盘→投递页内页签。
- 首页按数据状态渲染三态：无文档（两张起步卡）/ 有简历无投递（继续卡+引导卡）/ 有投递（待办卡+文档行）。
- 按钮语义：实底黑 = 主操作；橙（--warning）= 只给「导出 PDF」。
- 状态点：7px 圆点+文字——灰=草稿、橙=需处理、绿=已投出。本轮落首页文档行与待办卡，其余页面的 badge 迁移为后续项。
- /job/new 单动线：JD 文本 → 母版 → 生成；公司/岗位改可选（折叠区），缺省落「未命名」占位。
- 文案：页脚与品牌统一「简历工作台」；导航「文档→简历」「投递看板→投递」；首页不出现「待结构化/PDF较旧/AI:xx」状态行。
```

- [ ] **Step 2: 提交**

```bash
cd /Users/xxxly/resume && git add DESIGN.md && git commit -m "docs(design): 渐进呈现裁决登记——导航3项/首页三态/状态点/按钮语义（spec 2026-11-12）"
```

---

### Task 2: 导航 6→3 + active 重映射 + 投递页签条 + 页脚改名

**Files:**
- Modify: `server.mjs`（:1611 后新增 appTabs helper、:1809 topnav、:1811 页脚、/applications 两处 page()、:7491 起 /stats 两处、:3088 applyProfilePage、:6018 materials）
- Modify: `test-structure.sh`（:4355-4360、:4577-4640 NAV 与计数断言）
- Modify: `test.sh`（若有 topnav 项数/名断言，先 `grep -n 'topnav\|素材库\|网申包\|投递看板\|复盘' test.sh` 全量过一遍）

- [ ] **Step 1: 改 topnav 模板（server.mjs:1809）**

```js
<nav class="topnav"><a class="brand" href="/">${icon('file-text', 17)} 简历工作台</a><span class="links">${nav('docs', '/', '简历', 'file-text')}${nav('apps', '/applications', '投递', 'columns-3')}${nav('settings', '/settings', '设置', 'settings')}</span></nav>
```

- [ ] **Step 2: 页脚统一品牌名（server.mjs:1811）**

`简历平台` → `简历工作台`（同一行的 `· 本地优先 · 数据在 …` 保留）。

- [ ] **Step 3: active 键重映射（3 处 page() 收尾实参）**

| 位置 | 现状 | 改为 |
|---|---|---|
| applyProfilePage 收尾（:3088） | `'apply'` | `'apps'` |
| /stats 两处 page()（:7495/:7574） | `'stats'` | `'apps'` |
| /materials 收尾（:6018） | `'materials'` | `'docs'` |

- [ ] **Step 4: 新增投递系页签条 helper（紧跟 nav() 定义后，约 :1612）**

```js
// 投递系页签（渐进呈现）：看板/网申包/复盘 三页共用一条页签条，active 传各自 key。
// 只是三个已有页面的互链，不是新路由。
const appTabs = (on) => `<div class="apptabs">${
  [['apps', '/applications', '看板'], ['apply', '/apply-profile', '网申包'], ['stats', '/stats', '复盘']]
    .map(([k, href, label]) => `<a href="${href}"${on === k ? ' class="on"' : ''}>${label}</a>`).join('')
}</div>`;
```

同步在 page() `<style>` 块（.topnav 规则附近，:1643 前后）加：

```css
.apptabs{display:flex;gap:4px;margin:0 0 12px;border-bottom:1px solid var(--line)}
.apptabs a{padding:6px 10px;font-size:13px;font-weight:600;color:var(--mut);border-bottom:2px solid transparent;margin-bottom:-1px}
.apptabs a.on{color:var(--ink);border-bottom-color:var(--ink)}
.apptabs a:hover{color:var(--ink)}
.cta-exp{display:inline-block;background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn);border-radius:var(--radius);padding:9px 16px;font-weight:700;font-size:14px}
```

- [ ] **Step 5: 三页注入页签条**

- `/applications` 看板视图与表格视图（:6273 起两个 page() inner 开头，紧跟 `<h1>`/`.page-head` 后）：插入 `${appTabs('apps')}`；页题「投递看板」→「投递」，title `'投递看板·表格'` → `'投递·表格'`。
- `applyProfilePage` inner 开头插入 `${appTabs('apply')}`。
- `/stats` 两处 page()（:7495 空态、:7574 主态）inner 开头分别插入 `${appTabs('stats')}`。

- [ ] **Step 6: 适配 test-structure.sh 断言（同提交，R3① 先例）**

- :4601 `NAV` 数组 → `[['file-text','简历'],['columns-3','投递'],['settings','设置']]`，图标+文字同现断言逻辑不变。
- :4623 入口名清单 → `['简历','投递','设置']`。
- 链接数断言（:4357 附近与 :4621 附近注释/计数）→ brand + 3 项 = **4**。
- 新增断言（与适配同提交）：
  - `for (const t of ['网申包', '复盘', '素材库']) assert(!navblk.includes(t), 'topnav 不应再含入口: ' + t);`
  - 请求 `/applications` 响应断言：`assert(appHtml.includes('class="apptabs"'), '投递页应有页签条'); assert(appHtml.includes('网申包') && appHtml.includes('复盘'), '页签条应含网申包与复盘');`

- [ ] **Step 7: 跑结构套件相关段并提交**

```bash
cd /Users/xxxly/resume && bash test-structure.sh 2>&1 | tail -15
git add server.mjs test-structure.sh test.sh && git commit -m "feat(ux): 导航6→3（简历/投递/设置）+投递系页签条+页脚统一简历工作台（渐进呈现 T2）"
```

---

### Task 3: 首页三态重构

**Files:**
- Modify: `server.mjs`（page() `<style>` 块 :1643-1806 追加新类；`listPage` :2079-2357 输出段重构）
- Modify: `test.sh`、`test-structure.sh`（首页空态/stat-grid/taskcard/状态行相关断言，先 `grep -n 'stat-grid\|statusline\|taskcard\|task-acts\|还没有简历文档\|stat\b' test.sh test-structure.sh` 定位）

- [ ] **Step 1: page() `<style>` 追加类（:1806 `</style>` 前）**

```css
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none}
.dot-draft{background:var(--mut)}.dot-ready{background:var(--warn)}.dot-sent{background:var(--ok)}
.st{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--mut)}
.home-start{text-align:center;padding:48px 0 32px}
.home-start h1{font-size:22px;margin-bottom:8px}
.start-cards{display:flex;gap:16px;justify-content:center;margin-top:24px;flex-wrap:wrap}
.start-card{width:260px;text-align:left;padding:20px;cursor:pointer;display:block;color:inherit;text-decoration:none}
.start-card:hover{border-color:var(--mut)}
.start-card h3{font-size:15px;font-weight:600;margin:10px 0 4px}
.start-card p{font-size:13px;color:var(--mut)}
.doc-thumb{width:34px;height:44px;background:var(--panel);border:1px solid var(--line);border-radius:3px;flex:none;padding:5px;display:flex;flex-direction:column;gap:3px}
.doc-thumb i{display:block;height:2px;background:var(--line);border-radius:1px}
.doc-thumb i:first-child{width:50%;background:var(--mut)}
.docrow{display:flex;align-items:center;gap:14px;padding:10px 16px}
.docrow+.docrow{border-top:1px solid var(--line)}
.docrow .nm{font-weight:600;font-size:13px}
.docrow .mt{font-size:12px;color:var(--mut)}
.docrow .ops{margin-left:auto;display:flex;gap:14px}
.docrow .ops a{font-size:12px;color:var(--mut)}
.docrow .ops a:hover{color:var(--ink)}
.resume-hero{display:flex;gap:20px;padding:20px;align-items:flex-start}
.resume-hero .mini{width:108px;flex:none;border:1px solid var(--line);border-radius:6px;padding:14px;background:var(--panel)}
.resume-hero .mini i{display:block;height:3px;background:var(--line);border-radius:2px;margin-bottom:4px}
.resume-hero .mini i:first-child{height:7px;width:46%;background:var(--ink);margin-bottom:10px}
.todo-list{list-style:none}
.todo-list li{display:flex;align-items:center;gap:10px;padding:10px 16px;font-size:13px}
.todo-list li+li{border-top:1px solid var(--line)}
.todo-list .t{flex:1}
.todo-list .act{font-size:12px;color:var(--warn);white-space:nowrap}
.foot-links{margin-top:16px;display:flex;gap:18px;align-items:center;font-size:13px}
.foot-links a,.foot-links summary{color:var(--mut);font-size:13px}
```

- [ ] **Step 2: listPage 数据段保留、输出段按状态分支**

保留 :2080-2232 的全部数据计算（meta/infos/activeApps/siState/degradedCount/pdf\*/jobDocs/hasMaster/nowMs/upcoming/todoBits 数据源/agendaItems/agendaCard/jobStatusBadge 依赖/allApps/byMtime/docIds/docTitles/fallbackId）。删除：`todoBits`、`pdfChip`、`taskMain`/`latestDraft`/`draftReady`、stat-grid、statusline、taskcard、「继续处理岗位草稿」卡、`cards`/byTag 分组（改平铺行式）。`cardHtml` 改造为 `docRow`（见下）。

新增状态与待办计算（插在 agendaCard 之后）：

```js
const hasApps = allApps.length > 0;
const homeState = infos.length === 0 ? 0 : (hasApps ? 2 : 1);
// 待办（人话句+行内动作；只取当前可执行的三类，spec §7.3）
const fuDays = followUpDays(root);
const fuDueApps = hasLLM(root) ? allApps.filter((a) => !APP_TERMINAL.includes(a.status) && followUpState(a, { nowMs, thresholdDays: fuDays }).due) : [];
const staleDocs = infos.filter((d) => siState(d) === 'stale');
const todoItems = [
  ...staleDocs.slice(0, 3).map((d) => ({ dot: 'ready', t: `「${d.title}」的 PDF 不是最新`, act: `/export?id=${d.id}`, actLabel: '重新导出' })),
  ...fuDueApps.slice(0, 3).map((a) => ({ dot: 'sent', t: `${escHtml(a.company || '')} 已过 ${fuDays} 天无回应，可以写一句跟进`, act: `/app?id=${escAttr(a.id)}`, actLabel: '起草跟进语' })),
  ...infos.filter((d) => d.degraded).slice(0, 2).map((d) => ({ dot: 'draft', t: `「${d.title}」还没整理成结构化简历`, act: `/edit?id=${d.id}`, actLabel: '去整理' })),
];
const docStatus = (id) => {
  const m = meta[id] || {};
  if (deliveredRefs(id, allApps).length) return ['sent', '已投递'];
  const f = flowOf(m);
  if (f === 'reviewed' && deliverableNow(id, m, docInfoMap.get(id))) return ['ready', '可投递'];
  return ['draft', '草稿'];
};
const docRow = (d) => {
  const m = meta[d.id] || {};
  const [dc, sl] = docStatus(d.id);
  const si = siState(d);
  const sub = m.parent ? `基于母版 · 更新于 ${d.mtime}` : `更新于 ${d.mtime}`;
  return `<div class="docrow"><span class="doc-thumb"><i></i><i></i><i></i><i></i><i></i></span>
    <div><div class="nm">${d.title}</div><div class="mt">${escHtml(sub)}${si === 'stale' ? ' · PDF 不是最新' : ''}</div></div>
    <span class="st"><i class="dot dot-${dc}"></i>${sl}</span>
    <div class="ops"><a href="/edit?id=${d.id}">编辑</a><a href="/export?id=${d.id}">导出</a></div></div>`;
};
const sortedRows = [...infos].sort((a, b) => ((meta[b.id] || {}).parent ? 0 : 1) - ((meta[a.id] || {}).parent ? 0 : 1) || b.mtimeMs - a.mtimeMs).map(docRow).join('');
```

- [ ] **Step 3: 三态输出模板（替换 :2233-2276 的 return 主体；保留 corruptBanner/upload 脚本/continueBtn 逻辑/search 脚本）**

```js
const uploadBox = `<details class="import-box"><summary style="cursor:pointer">导入 PDF</summary>
  <form id="up" style="margin-top:8px"><input type="file" id="upfile" accept="application/pdf" aria-label="选择 PDF 文件"><button>导入</button><span id="upmsg" role="status"></span></form></details>`;
const footLinks = `<div class="foot-links">
  <form method="post" action="/new" style="display:inline"><button class="secondary">新建空白简历</button></form>
  <a href="/onboarding/guided">从零开始（分步向导）</a>
  ${hasMaster ? '<a href="/job/new">为岗位定制</a>' : ''}
  ${uploadBox}
  <a href="${showArchived ? '/' : '/?archived=1'}">${showArchived ? '隐藏已归档' : '显示已归档'}</a></div>`;
```

- 状态 0（`homeState===0`）inner：

```js
`<div class="home-start"><h1>建你的第一份简历</h1><p class="st" style="justify-content:center">一份母版，按岗位出不同版本。数据只存在这台机器上。</p></div>
<div class="start-cards">
  <div class="card start-card"><span class="doc-thumb" style="width:34px;height:34px;padding:8px"><i></i><i></i><i></i></span><h3>导入现有简历</h3><p>拖入 PDF，自动整理成可编辑的简历</p>${uploadBox}</div>
  <a class="card start-card" href="/onboarding/guided"><h3>从零开始</h3><p>分步填写，每步可跳过，写完就是完整简历</p></a>
</div>`
```

（导入卡是 `<div>` 不是 `<a>`——内嵌 uploadBox 表单，卡内不能再套链接或内联 handler；不加新 JS。）

- 状态 1 inner：

```js
`${corruptBanner()}
<h1>继续</h1>
<div class="card resume-hero"><span class="mini"><i></i><i></i><i></i><i></i><i></i><i></i></span>
  <div style="flex:1;min-width:0"><h3 style="font-size:16px">${docTitles[fallbackId] || ''}</h3>
    <div class="mt" style="font-size:12px;color:var(--mut)">更新于 ${(docInfoMap.get(fallbackId) || {}).mtime || ''}</div>
    <span class="st"><i class="dot dot-${docStatus(fallbackId)[0]}"></i>${docStatus(fallbackId)[1]}</span>
    <div style="display:flex;gap:8px;margin-top:14px"><a class="cta" id="continueBtn" href="/edit?id=${encodeURIComponent(fallbackId)}" data-fallback="${escAttr(fallbackId)}" data-doc-ids='${jsonAttr(docIds)}' data-doc-titles='${jsonAttr(docTitles)}'>继续编辑</a><a class="cta-exp" href="/export?id=${escAttr(fallbackId)}">导出 PDF</a></div></div></div>
${hasMaster ? `<div class="card" style="margin-top:16px;padding:14px 16px;display:flex;align-items:center;gap:12px"><div style="flex:1"><b style="font-size:13px">要投某个岗位？</b><div style="font-size:12px;color:var(--mut)">按 JD 生成一份定制副本，母版不动</div></div><a href="/job/new" style="font-size:13px">为岗位定制 →</a></div>` : ''}
<h1 style="margin-top:24px">全部简历</h1>
<div class="searchrow"><input id="searchBox" placeholder="搜索文档（标题/id/标签）" aria-label="搜索文档"></div>
<div class="card" id="doclistCard">${sortedRows || `<div class="docrow" style="color:var(--mut)">没有可显示的文档——可能都已归档。<a href="/?archived=1">查看已归档</a></div>`}
<div class="docrow search-empty" style="display:none">没有匹配「<span class="q"></span>」的文档。<button type="button" class="secondary" id="clearSearch">清除搜索</button></div>
${footLinks}${agendaCard}`
```

（「▤ 切换」按钮与 list-view 切换脚本**删除**：.docrow 本身已是行式，切换无目标——同提交删除 `viewToggle` 按钮、其 onclick 脚本与 `#doclist` 隐藏 ul；搜索过滤选择器改为 `document.querySelectorAll('#doclistCard .docrow')`，search-empty 行作为 `#doclistCard` 最后一个子元素。）

- 状态 2 inner：

```js
`${corruptBanner()}
${todoItems.length ? `<h1>待办</h1><div class="card"><ul class="todo-list">${todoItems.map((i) => `<li><i class="dot dot-${i.dot}"></i><span class="t">${i.t}</span><a class="act" href="${i.act}">${i.actLabel}</a></li>`).join('')}</ul></div>` : ''}
<h1 style="margin-top:24px">简历</h1>
<div class="searchrow"><input id="searchBox" placeholder="搜索文档（标题/id/标签）" aria-label="搜索文档"></div>
<div class="card" id="doclistCard">${sortedRows}
<div class="docrow search-empty" style="display:none">没有匹配「<span class="q"></span>」的文档。<button type="button" class="secondary" id="clearSearch">清除搜索</button></div>
${footLinks}${agendaCard}`
```

- [ ] **Step 4: 断言适配与新增（同提交）**

- 适配：首页「还没有简历文档」空态文案断言 → 新文案「建你的第一份简历」；stat-grid/statusline/taskcard 相关断言删除或反转为「不渲染」；搜索空态选择器适配。
- 保留：test.sh:303 `为岗位定制`（footLinks/引导卡保留该词，微调为「为岗位定制」）、:357 `href="/job/new"`。
- 新增（test-structure.sh 首页段内）：
  - 三态分支存在：源级断言 `homeState` 三分支与 `hasApps` 判据在场；
  - 黑话缺席：首页响应不含 `待结构化`、`PDF 较旧`、`AI：`（状态行已退役）；
  - 状态点：首页响应含 `dot-draft|dot-ready|dot-sent` 至少其一与 `.docrow`；
  - 入口唯一：首页 `href="/job/new"` 出现次数 = 1（状态 1/2）——`assert((home.match(/href="\/job\/new"/g)||[]).length === 1)`。

- [ ] **Step 5: 跑测试并提交**

```bash
cd /Users/xxxly/resume && bash test.sh 2>&1 | tail -20 && bash test-structure.sh 2>&1 | tail -10
git add server.mjs test.sh test-structure.sh && git commit -m "feat(ux): 首页三态——空态起步卡/继续卡+引导/待办卡+状态点文档行，去黑话去重入口（渐进呈现 T3）"
```

---

### Task 4: /job/new 单动线 + 公司/岗位改可选

**Files:**
- Modify: `server.mjs`（`jobNewPage` :2374-2406 表单段与 :2469-2530 提交脚本；`createJobDraft` :305-380）
- Modify: `test-fixtures/reliability/test-job-new-page.mjs`（:114-155 字段断言）
- Modify: `test.sh`（段16u 相关断言文本）

- [ ] **Step 1: 表单重构（:2379-2406 那段 grid 表单）**

```js
`<form id="jobForm">
  <div class="step"><div style="font-size:13px;font-weight:600;margin-bottom:6px"><span style="color:var(--mut)">1</span> 岗位描述 <span style="font-weight:400;font-size:12px;color:var(--mut)">粘贴招聘页全文即可</span></div>
    <textarea id="jobJd" rows="6" style="width:100%" placeholder="把职位描述整段粘进来，公司、岗位会尽量自己识别"></textarea>
    <div style="font-size:12px;color:var(--mut);margin-top:4px">或 <a href="#" id="jdModeLink" style="color:inherit">粘贴招聘页链接</a>（读取失败可改回贴文本）</div>
    <div id="jdLinkRow" style="display:none;margin-top:6px"><input id="jobLink" placeholder="https://…" style="width:100%"></div></div>
  <div class="step"><div style="font-size:13px;font-weight:600;margin-bottom:6px"><span style="color:var(--mut)">2</span> 用哪份简历改</div>
    <select id="jobFrom" style="width:100%">${infos.map((d) => `<option value="${escAttr(d.id)}">${d.title}（${d.id}）</option>`).join('')}</select></div>
  <div class="step"><div style="font-size:13px;font-weight:600;margin-bottom:6px"><span style="color:var(--mut)">3</span> 生成</div>
    <details style="border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);margin-bottom:12px">
      <summary style="cursor:pointer;padding:8px 12px;font-size:13px;font-weight:600">补充要求（可选，默认已按经验填好）</summary>
      <div style="padding:2px 12px 12px;display:grid;gap:6px">
        <label style="font-size:12px">公司（可留空，自动识别）<input id="jobCompany" style="width:100%"></label>
        <label style="font-size:12px">岗位（可留空，自动识别）<input id="jobRole" style="width:100%"></label>
        <!-- 预设/chips/keep/deem/degree/pages 六组字段原样保留（:2388-2402 迁入，零改动） -->
      </div></details>
    <button type="submit">生成岗位草稿</button>
    <a href="#" id="evalBtn" style="font-size:13px;color:var(--mut);margin-left:14px">先评估匹配度</a>
    <span id="jobMsg" role="status" style="font-size:12px;color:var(--mut)"></span><span id="evalMsg" role="status" style="font-size:12px;color:var(--mut)"></span>
    <div style="font-size:12px;color:var(--mut);margin-top:10px">生成约 2–3 分钟，分批改写并校验。产出一份新草稿，可再编辑。</div></div>
</form>
<div id="evalResult"></div>`
```

- [ ] **Step 2: 提交脚本调整（:2469 起）**

- `jobCompany`/`jobRole` 的 `.value.trim()` 读取不变（元素仍在，只是可选、进 details）。
- `evalBtn` 由 `<button type="button" class="secondary">` 改 `<a href="#">`：click handler 内 `e.preventDefault()` 保留；评估仍需 JD：点击时若 `jobJd` 与 `jobLink` 均空 → `evalMsg` 显示「评估需要岗位描述文本」并 return。
- 新增 JD↔链接切换（同一 nonce 脚本内）：

```js
document.getElementById('jdModeLink').addEventListener('click', function (e) {
  e.preventDefault();
  var row = document.getElementById('jdLinkRow');
  row.style.display = row.style.display === 'none' ? '' : 'none';
});
```

- 母版下拉：多文档保持 select；`infos.length===1` 时 select 保留但只读观感——实现为 select 照渲染（单一选项），不引入新控件。

- [ ] **Step 3: createJobDraft 改可选（:305-380）**

```js
const companyRaw = String(o.company || '').trim();
const roleRaw = String(o.role || '').trim();
// 公司/岗位改可选（渐进呈现 spec §4）：全空 → 「未命名·定制」；缺一项 → 「未命名公司/岗位」。
// 去重身份不能再用 (母版,公司,岗位)——全缺省时不同 JD 会撞名；补 jd 指纹段。
const company = companyRaw || (roleRaw ? '未命名公司' : '未命名');
const role = roleRaw || (companyRaw ? '未命名岗位' : '定制');
const unnamed = !companyRaw && !roleRaw;
const jdId = createHash('sha1').update(String(o.jd || '').trim() || String(o.jdLink || '').trim()).digest('hex').slice(0, 10);
```

- 删除 :310 的必填 400。
- :320 claim → `claimPath(root, from + '|' + company + '|' + role + (unnamed ? '|jd:' + jdId : ''))`。
- :327/:338 两处查重谓词补一句：`` `m.company === company && m.role === role` `` 之后加 `&& (!unnamed || String(m.jd || '') === jd || String(m.jdSource || '') === jdLink)`——注意 :338 的查重在 JD 链接抓取之后，此时 `jd`/`jdLink` 已是终值；:327 的 dup2 路径 `jd` 未取回，用 `jdRaw || jdLink` 对 `m.jd || m.jdSource` 比较。
- :376-379 meta 写入不变（company/role 用占位终值，`tag` 现成逻辑 `(company+'·'+role).slice(0,20)` 自然得到「未命名·定制」）。

- [ ] **Step 4: 夹具适配（test-job-new-page.mjs，同提交）**

- :114-119 字段存在性：`jobForm/jobFrom/jobLink/jobJd/evalBtn/briefFocusChips/briefKeep/briefDeem/briefDegree/briefPages` 保留断言；`jobCompany`/`jobRole` 保留存在断言但去掉 `required` 断言（:119 → `assert.ok(!/id="jobCompany"[^>]*required/.test(html), '公司不再必填')`）。
- :123-124 保留「生成岗位草稿」；evalBtn 断言改为 `id="evalBtn"` + 「先评估匹配度」。
- :135-137 提交体断言字段名不变（元素仍在）。
- 新增：`id="jdModeLink"` 存在、`step` 区块三段、预期文案「产出一份新草稿」。

- [ ] **Step 5: 跑测试并提交**

```bash
cd /Users/xxxly/resume && node test-fixtures/reliability/test-job-new-page.mjs && bash test.sh 2>&1 | tail -20
git add server.mjs test-fixtures/reliability/test-job-new-page.mjs test.sh && git commit -m "feat(ux): /job/new 单动线——JD→母版→生成，公司岗位改可选+未命名兜底+去重按JD指纹（渐进呈现 T4）"
```

---

### Task 5: 全量验收 + 收口登记

- [ ] **Step 1: 全量套件**

```bash
cd /Users/xxxly/resume && RESUME_TEST_STRICT=1 npm run test:all; echo "EXIT=$?"
```

预期 EXIT=0（唯一 ❌ 行是段 X Chromium 探测契约的既有预期输出）。

- [ ] **Step 2: 真实浏览器点验（kill 让 launchd 拉起新进程后）**

```bash
kill $(lsof -tiTCP:7766 -sTCP:LISTEN) && sleep 1
RESUME_ROOT=/tmp/rr-empty node server.mjs &  # 空根起第二实例验证状态 0（端口顺延 7767）
```

点验：/（三态各一——空根=状态0；本机 7766=状态2）、/job/new、/applications 页签条。

- [ ] **Step 3: 收口登记**

`dev-docs/handoff.md` 文末追加本轮一节（任务卡/撞断言适配清单/未做清单：编辑器密度、网申包复盘页内结构、真实渲染缩略图、状态点全站迁移），commit `docs:`。

---

## Self-Review 记录

- Spec §1（导航）→ T2；§2（三态）→ T3；§3（文案）→ T2/T3 分摊；§4（job/new）→ T4；§5（按钮语义/状态点/缩略图）→ T2 CSS+T3；§6（测试）→ 各任务 Step「断言适配」；§7 已定细节 → T2 页签、T3 CSS 示意缩略图与待办三源。
- 范围外（spec 明确不做）：编辑器密度、网申包/复盘页面内容重构、真实渲染缩略图、状态点向非首页页面迁移、多用户/云。
