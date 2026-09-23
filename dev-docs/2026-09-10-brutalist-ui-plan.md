# S1 新粗野 UI 升级 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（本项目适配为 xiang/ling/hao 三会话分工：ling/xiang 实施、xiang 审查、hao 视觉回归）。步骤用 checkbox 跟踪。
> **本项目特例：禁止一切 git 操作**——所有"提交"步骤替换为"向 xiang 报告改动摘要"。
> Spec：`dev-docs/2026-09-10-brutalist-ui-design.md`（用户已批准）

**Goal:** 平台三页 + 简历模板 + AI 面板全面新粗野化，旧文档一次性迁移，ATS/打印可验证。

**Architecture:** Design tokens（§2 spec 已冻结）分通道交付：平台页改 server.mjs 的 `page()` 壳（一壳带三页）+ `listPage()`；简历改 template.html（新文档原生）+ migrate-style.mjs（旧文档 `<style>` 块整体替换，BRUTAL-V1 标记幂等）；编辑器 chrome/AI 面板改 ai-panel.js。

**Tech Stack:** Node 内置模块、零框架、CSS 变量、bash 冒烟（test.sh / test-render.sh）。

**纪律：** ponytail 最简；禁 git；断言禁裸 `&&`（用 `|| { echo '❌'; exit 1; }`）；不读不打印 config.json；改测试先红后绿；并行期间**只有 ling 跑 test.sh**（config 竞态教训）。

---

## 文件结构

| 文件 | 职责 | 改动 |
|---|---|---|
| `template.html` | 简历模板（新文档源头） | 换 brutal `<style>`（xiang，Task 1） |
| `ai-panel.js` | AI 面板 + serve 注入补丁 | brutal 化 + 删除临时补丁（xiang，Task 2） |
| `server.mjs` | `page()` 壳 + `listPage()` | brutal 重写（ling，Task 4） |
| `test.sh` | HTTP 冒烟 | +S1 断言（ling，Task 3） |
| `test-render.sh` | 渲染冒烟 | +ATS 字符量护栏（ling，Task 5） |
| `migrate-style.mjs` | 一次性迁移脚本 | 新建（ling，Task 6） |

---

### Task 1: template.html brutal 化（xiang）

**Files:**
- Modify: `/Users/xxxly/resume/template.html:5-107`（整个 `<style>` 块）

- [ ] **Step 1: 替换 `<style>` 块为 BRUTAL-V1 版**

正则整体替换 `<style>...</style>` 内容为（body 结构与 class 名一律不变）：

```html
<style>
  /*BRUTAL-V1*/
  :root {
    --ink: #111; --paper: #fdf6e3;
    --accent-1: #7c3aed; --accent-2: #ffe566; --accent-3: #0ea5e9;
    --border: 3px solid var(--ink);
    --shadow: 4px 4px 0 var(--ink);
    --shadow-sm: 2px 2px 0 var(--ink);
  }
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e8e4d8; color: #333; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", SimSun, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.43;
  }
  .sheet {
    position: relative;
    width: 210mm;
    min-height: 297mm;
    padding: 9.4mm 8.4mm 9.4mm;
    background: #fff;
    page-break-after: always;
  }
  .sheet:last-child { page-break-after: auto; }
  /* 姓名横幅：撞色 + 粗边 + 硬阴影 */
  .header {
    text-align: center;
    margin-bottom: 5.4mm;
    background: var(--accent-2);
    border: var(--border);
    box-shadow: var(--shadow);
    padding: 4mm 3mm 3.2mm;
  }
  h1 {
    margin: 0 0 2mm;
    font-size: 28px;
    line-height: 1;
    font-weight: 800;
    color: var(--ink);
    letter-spacing: 1px;
  }
  .contact { font-size: 13.2px; line-height: 1.52; color: var(--ink); }
  .section { margin-top: 4.5mm; }
  /* 章节标题 = 撞色标签（奇紫偶蓝） */
  .section-title {
    display: inline-block;
    font-size: 15px;
    font-weight: 800;
    color: #fff;
    background: var(--accent-1);
    border: 2.5px solid var(--ink);
    box-shadow: var(--shadow-sm);
    padding: 1mm 3mm;
    margin-bottom: 2.2mm;
    break-after: avoid;
  }
  .section:nth-of-type(even) .section-title { background: var(--accent-3); }
  .summary { margin: 0; font-weight: 700; color: #222; }
  .plain-lines p { margin: 0 0 0.45mm; }
  .entry-head {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: baseline;
    column-gap: 4.5mm;
    margin: 0 0 0.45mm;
    break-after: avoid;
    break-inside: avoid;
  }
  .entry-title { font-size: 13.8px; font-weight: 800; color: var(--ink); white-space: nowrap; }
  .entry-role { font-size: 12.6px; color: #333; white-space: nowrap; }
  .entry-date { font-size: 12.4px; color: #666; white-space: nowrap; justify-self: end; }
  ul { list-style: none; padding: 0; margin: 0; break-inside: avoid; }
  /* 条目卡片化 */
  li {
    position: relative;
    padding: 1.2mm 2.5mm 1.2mm 5.5mm;
    margin: 1mm 0;
    background: #fff;
    border: 2px solid var(--ink);
    box-shadow: var(--shadow-sm);
    break-inside: avoid;
  }
  li::before {
    content: "▪";
    position: absolute;
    left: 2mm;
    top: 1.2mm;
    color: var(--accent-1);
    font-size: 13px;
    line-height: 1.43;
  }
  /* ===== 编辑器（仅屏幕显示，PDF 中隐藏）===== */
  .edit-toolbar {
    position: fixed; top: 10px; right: 10px; z-index: 99;
    display: flex; gap: 8px; align-items: center;
    background: var(--accent-2); color: var(--ink);
    border: var(--border); box-shadow: var(--shadow);
    padding: 8px 12px; font-size: 12px;
  }
  .edit-toolbar button {
    background: var(--accent-1); color: #fff;
    border: 2.5px solid var(--ink); box-shadow: var(--shadow-sm);
    padding: 10px 14px; font-size: 13px; font-weight: 700; cursor: pointer;
  }
  .edit-toolbar button:active { box-shadow: none; transform: translate(2px,2px); }
  .edit-toolbar button.secondary { background: #fff; color: var(--ink); }
  button:focus-visible, input:focus-visible, textarea:focus-visible {
    outline: 3px solid var(--accent-1); outline-offset: 1px;
  }
  .sheet { outline: none; caret-color: var(--accent-1); }
  .sheet p:hover, .sheet li:hover, .sheet h1:hover, .sheet .entry-head:hover, .sheet .contact:hover {
    outline: 2px dashed var(--accent-3); outline-offset: 1px;
  }
  .page-line {
    position: absolute; left: 0; right: 0; border-top: 2px dashed rgba(231,76,60,.45);
    pointer-events: none; z-index: 5;
  }
  .page-line span {
    position: absolute; right: 2mm; top: 1.5mm; font-size: 9px; color: rgba(231,76,60,.8);
    background: rgba(255,255,255,.9); padding: 0 3px; border: 1.5px solid rgba(231,76,60,.5);
  }
  .toast {
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: var(--ink); color: #fff; padding: 8px 16px;
    border: 2.5px solid var(--ink); box-shadow: var(--shadow-sm);
    font-size: 13px; opacity: 0; transition: opacity .25s; z-index: 99; pointer-events: none;
  }
  .recovery-bar {
    position: fixed; top: 10px; left: 50%; transform: translateX(-50%); z-index: 100;
    display: flex; gap: 8px; align-items: center;
    background: var(--accent-2); color: var(--ink); padding: 10px 14px;
    border: var(--border); box-shadow: var(--shadow); font-size: 13px;
  }
  .recovery-bar button { background: var(--accent-1); color: #fff; border: 2px solid var(--ink); box-shadow: var(--shadow-sm); padding: 4px 10px; cursor: pointer; }
  .recovery-bar button.secondary { background: #fff; color: var(--ink); }
  @media print {
    body { background: #fff; }
    .edit-toolbar, .page-line, .toast, .recovery-bar { display: none !important; }
    .header, .section-title, li { box-shadow: none; }  /* 打印去硬阴影防伪墨盒 */
  }
</style>
```

要点：所有原 class 名/结构/分页保护（`break-inside/after`）保留；`li::before` 的 `left/top` 适配新 padding。

- [ ] **Step 2: 验证标记存在**

Run: `grep -c 'BRUTAL-V1' /Users/xxxly/resume/template.html`
Expected: `1`

- [ ] **Step 3: 向 xiang 报告**（若执行者非 xiang 本人）：改动行数 + grep 结果。

---

### Task 2: ai-panel.js brutal 化 + 删除临时补丁（xiang）

**Files:**
- Modify: `/Users/xxxly/resume/ai-panel.js:8-33`（css.textContent 段）

- [ ] **Step 1: css.textContent 替换为 brutal 版**

```js
  css.textContent = '#ai-toggle{position:fixed;right:16px;bottom:16px;z-index:101;width:44px;height:44px;border-radius:50%;border:3px solid #111;background:#7c3aed;color:#fff;font-size:20px;cursor:pointer;box-shadow:3px 3px 0 #111}'
    + '#ai-drawer{position:fixed;right:0;top:0;bottom:0;width:380px;background:#fdf6e3;border-left:3px solid #111;z-index:101;display:none;flex-direction:column;box-shadow:-4px 0 0 #111;font-size:13px;font-family:"PingFang SC",sans-serif}'
    + '#ai-drawer.open{display:flex}'
    + '#ai-drawer header{padding:10px 12px;font-weight:700;border-bottom:3px solid #111;display:flex;justify-content:space-between;align-items:center;background:#ffe566}'
    + '#ai-close{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;font-size:14px;border:2px solid #111;background:#fff;box-shadow:2px 2px 0 #111}'
    + '#ai-close:hover{background:#f3f4f6}'
    + '#ai-log{flex:1;overflow:auto;padding:10px 12px}'
    + '#ai-log .msg{margin:8px 0;padding:8px 10px;border:2px solid #111;background:#fff;box-shadow:2px 2px 0 #111;white-space:pre-wrap}'
    + '#ai-log .msg.user{background:#ede9fe}'
    + '#ai-input{display:flex;gap:6px;padding:10px;border-top:3px solid #111;background:#ffe566}'
    + '#ai-input input{flex:1;padding:6px 8px;border:2.5px solid #111;background:#fff;border-radius:0}'
    + '#ai-input button,#ai-pop button{border:2.5px solid #111;box-shadow:2px 2px 0 #111;background:#7c3aed;color:#fff;padding:6px 12px;font-weight:700;cursor:pointer;border-radius:0}'
    + '.ai-change{border:2.5px solid #111;box-shadow:2px 2px 0 #111;background:#fff;padding:8px;margin:8px 0}'
    + '.ai-before{background:#fee2e2;text-decoration:line-through;padding:4px;margin-bottom:4px;white-space:pre-wrap;border:1.5px solid #111}'
    + '.ai-after{background:#dcfce7;padding:4px;white-space:pre-wrap;border:1.5px solid #111}'
    + '.ai-change button{margin:6px 6px 0 0;border:2px solid #111;box-shadow:2px 2px 0 #111;background:#fff;padding:3px 10px;cursor:pointer}'
    + '#ai-sel-btn{position:absolute;z-index:99;display:none;padding:4px 10px;background:#7c3aed;color:#fff;border:2.5px solid #111;box-shadow:2px 2px 0 #111;cursor:pointer;font-size:12px}'
    + '#ai-pop{position:absolute;z-index:99;background:#fdf6e3;border:3px solid #111;box-shadow:4px 4px 0 #111;padding:8px;display:none;width:360px;font-size:13px}'
    + '#ai-pop textarea{width:100%;height:56px;font-size:13px;box-sizing:border-box;border:2.5px solid #111;background:#fff}'
    + '#ai-pop .preview{max-height:200px;overflow:auto;margin-top:6px}'
    + '#ai-pop .row{margin-top:6px;text-align:right}'
    + '@media print{#ai-toggle,#ai-drawer,#ai-sel-btn,#ai-pop{display:none!important}}'
    + '#ai-drawer button:focus-visible,#ai-drawer input:focus-visible,#ai-pop button:focus-visible,#ai-pop textarea:focus-visible,#ai-toggle:focus-visible,#ai-sel-btn:focus-visible{outline:3px solid #7c3aed;outline-offset:1px}';
```

**同时删除**上一轮加的"旧文档样式补丁"5 行（`.edit-toolbar button{...}`、`.page-line{...}`、`.page-line span{...}`、全局 `button:focus-visible` 及注释）——Task 6 迁移后旧文档原生 brutal，补丁冗余（ponytail：迁移与本任务同批落地，无裸奔窗口）。

- [ ] **Step 2: 验证**

Run: `curl -sf http://127.0.0.1:7766/ai-panel.js | grep -c 'ffe566'`（服务重启后）
Expected: `3`（header/input 背景 + drawer 背景）

Run: `curl -sf http://127.0.0.1:7766/ai-panel.js | grep -c 'edit-toolbar'` 
Expected: `0`（补丁已删）

- [ ] **Step 3: 向 xiang 报告**改动摘要。

---

### Task 3: test.sh S1 红断言（ling）

**Files:**
- Modify: `/Users/xxxly/resume/test.sh`（两处插入）

- [ ] **Step 1: 在"列表页导入提示"断言（现行 57-58 行）后插入**

```bash
# 4b. S1：列表页 brutal 元素（工作台头 + 文档卡片 + AI 徽标 + 标记）
curl -sf "http://localhost:$PORT/" | grep -q '简历工作台' || { echo '❌ S1 缺工作台标题'; exit 1; }
curl -sf "http://localhost:$PORT/" | grep -q 'class="card doc-card"' || { echo '❌ S1 缺文档卡片'; exit 1; }
curl -sf "http://localhost:$PORT/" | grep -q 'badge ai' || { echo '❌ S1 缺 AI 徽标'; exit 1; }
curl -sf "http://localhost:$PORT/" | grep -q 'BRUTAL-V1' || { echo '❌ S1 平台页缺 BRUTAL-V1'; exit 1; }
echo '✅ S1 列表页 brutal 元素'
curl -sf "http://localhost:$PORT/settings" | grep -q 'BRUTAL-V1' || { echo '❌ S1 设置页缺 brutal 壳'; exit 1; }
curl -sf "http://localhost:$PORT/snapshots?id=smoketest" | grep -q 'BRUTAL-V1' || { echo '❌ S1 历史页缺 brutal 壳'; exit 1; }
echo '✅ S1 设置/历史页 brutal 壳'
```

- [ ] **Step 2: 在"导入文档含正文"断言（现行 74 行）后插入**

```bash
grep -q 'BRUTAL-V1' "docs/$NEWID.html" && echo '✅ 新导入文档用 brutal 模板' || { echo '❌ 导入文档非 brutal 模板'; exit 1; }
```

- [ ] **Step 3: 跑红**

Run: `bash test.sh`
Expected: 在 `❌ S1 缺工作台标题` 处失败（列表页尚无 brutal 元素）；这是正确原因的红。

- [ ] **Step 4: 向 xiang 报告**：红断言总数（9 条新）+ 失败点截图文本。

---

### Task 4: server.mjs `page()` + `listPage()` brutal 重写（ling）

**Files:**
- Modify: `/Users/xxxly/resume/server.mjs:59-63`（page）和 `:73-107`（listPage）

- [ ] **Step 1: 替换 `page()`**

```js
function page(title, inner) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>/*BRUTAL-V1*/
:root{--ink:#111;--paper:#fdf6e3;--accent-1:#7c3aed;--accent-2:#ffe566;--accent-3:#0ea5e9;--border:3px solid var(--ink);--shadow:4px 4px 0 var(--ink);--shadow-sm:2px 2px 0 var(--ink)}
*{box-sizing:border-box}
body{font-family:"PingFang SC",sans-serif;max-width:760px;margin:40px auto;padding:0 16px;font-size:14px;background:var(--paper);color:var(--ink)}
a{color:var(--accent-1);font-weight:700}
button{cursor:pointer;background:var(--accent-1);color:#fff;border:2.5px solid var(--ink);box-shadow:var(--shadow-sm);padding:6px 12px;font-weight:700}
button:active{box-shadow:none;transform:translate(2px,2px)}
button.secondary{background:#fff;color:var(--ink)}
input{border:var(--border);padding:6px 8px;background:#fff}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid var(--accent-1);outline-offset:1px}
h1{display:inline-block;background:var(--accent-2);border:var(--border);box-shadow:var(--shadow);padding:6px 14px;font-size:20px}
.card{background:#fff;border:var(--border);box-shadow:var(--shadow);padding:12px 14px;margin:12px 0}
.badge{display:inline-block;border:2px solid var(--ink);box-shadow:var(--shadow-sm);padding:1px 8px;font-size:12px;font-weight:700;background:#fff;margin-right:6px}
.badge.ok{background:#bbf7d0}.badge.warn{background:var(--accent-2)}.badge.ai{background:var(--accent-1);color:#fff}
ul.doclist{list-style:none;padding:0}
</style></head><body>${inner}</body></html>`;
}
```

- [ ] **Step 2: 替换 `listPage()`**（保留全部功能字符串：`上传 PDF 导入`/`选择 PDF 文件导入为新文档`/`编辑`/`PDF`/`历史`/`大模型设置`；up/upfile/upmsg 三个 id 不动）

```js
function listPage() {
  const docs = fs.readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.html') && !f.startsWith('.'));
  const cards = docs.map((f) => {
    const id = f.replace('.html', '');
    const content = fs.readFileSync(path.join(root, 'docs', f), 'utf8');
    const title = escHtml((content.match(/<h1>([^<]+)<\/h1>/) || [])[1] || id);
    const mtime = fs.statSync(path.join(root, 'docs', f)).mtime.toLocaleString('zh-CN');
    const snaps = fs.existsSync(snapDir(id)) ? fs.readdirSync(snapDir(id)).filter((s) => s.endsWith('.html')).length : 0;
    const hasPdf = fs.existsSync(pdfPath(id));
    return `<li class="card doc-card"><b style="font-size:16px">${title}</b>
      <div style="color:#555;font-size:12px;margin:4px 0">${id} · 更新于 ${mtime}
        <span class="badge">快照 ${snaps}</span><span class="badge ${hasPdf ? 'ok' : 'warn'}">${hasPdf ? 'PDF ✓' : 'PDF ✗'}</span></div>
      <a href="/edit?id=${id}">编辑</a> ·
      <a href="/pdf?id=${id}" target="_blank">PDF</a> ·
      <a href="/snapshots?id=${id}">历史</a> ·
      <form method="post" action="/duplicate?id=${id}" style="display:inline" onsubmit="event.preventDefault();const t=prompt('新文档 id（小写字母数字横线）');if(t){this.action='/duplicate?id=${id}&to='+t;this.submit()}"><button>复制</button></form>
      <form method="post" action="/delete?id=${id}" style="display:inline" onsubmit="return confirm('确认删除 ${id}？快照会保留')"><button class="secondary">删除</button></form>
    </li>`;
  }).join('\n');
  const ai = hasLLM(root);
  return page('简历平台', `<h1>简历工作台</h1>
    <p><span class="badge ai">${ai ? '🤖 AI 已配置' : '🤖 AI 未配置'}</span><span class="badge">${docs.length} 份文档</span> <a href="/settings">⚙️ 大模型设置</a></p>
    <form id="up" class="card">
      <b>上传 PDF 导入：</b><span style="color:#666">选择 PDF 文件导入为新文档</span><input type="file" id="upfile" accept="application/pdf">
      <button>导入</button><span id="upmsg"></span>
    </form>
    <ul class="doclist">${cards}</ul>
    <script>
      document.getElementById('up').addEventListener('submit', async function (e) {
        e.preventDefault();
        var f = document.getElementById('upfile').files[0];
        if (!f) return;
        document.getElementById('upmsg').textContent = ' 导入中（LLM 结构化需几十秒）…';
        var r = await fetch('/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        if (r.redirected) { location.href = r.url; return; }
        document.getElementById('upmsg').textContent = ' ' + (await r.text());
      });
    </script>`);
}
```

注意：上传区从 dashed 框改为 `class="card"`，原内联 `style="margin:12px 0;padding:10px;border:1px dashed #999"` 删除。

- [ ] **Step 3: 跑绿**

Run: `bash test.sh`
Expected: 全部通过（S1 平台页断言转绿；"新导入文档用 brutal 模板"在 Task 1 落地前仍红——若 Task 1 未就绪，记录该点为**等待 xiang**，不算失败）

- [ ] **Step 4: 向 xiang 报告**：改动行数 + 套件结果。

---

### Task 5: test-render.sh ATS 护栏（ling）

**Files:**
- Modify: `/Users/xxxly/resume/test-render.sh:9`（末尾追加）

- [ ] **Step 1: 追加字符量护栏**（防"文本层存在但大面积丢失"）

```bash
CHARS=$(pdftotext pdfs/smoketest.pdf - | wc -m | tr -d ' ')
[ "$CHARS" -ge 200 ] && echo "✅ ATS 文本层字符量 $CHARS" || { echo "❌ ATS 文本层过短 ($CHARS < 200)"; exit 1; }
```

- [ ] **Step 2: 跑绿**（护栏对现行经典模板即通过，属 guard 断言——与 A3/A7 同类，无需红）

Run: `bash test-render.sh`
Expected: `✅ 渲染冒烟通过` + `✅ ATS 文本层字符量 …`

- [ ] **Step 3: 向 xiang 报告**字符量数值。

---

### Task 6: migrate-style.mjs 迁移脚本（ling）

**Files:**
- Create: `/Users/xxxly/resume/migrate-style.mjs`

- [ ] **Step 1: 新建脚本**

```js
// migrate-style.mjs — 一次性：把现有文档的 <style> 块替换为 template.html 的 brutal 版（先快照，幂等）
// 用法: node migrate-style.mjs [docId]   （给 docId 则只迁移该文档，供测试）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
const m = tpl.match(/<style>([\s\S]*?)<\/style>/);
if (!m || !m[1].includes('BRUTAL-V1')) throw new Error('template.html 缺少 BRUTAL-V1 样式块，先完成 Task 1');
const brutalStyle = m[0];

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const only = process.argv[2];
const docs = fs.readdirSync(path.join(root, 'docs'))
  .filter((f) => f.endsWith('.html') && !f.startsWith('.'))
  .filter((f) => !only || f === only + '.html');
for (const f of docs) {
  const p = path.join(root, 'docs', f);
  const html = fs.readFileSync(p, 'utf8');
  if (html.includes('BRUTAL-V1')) { console.log('skip（已是 brutal）:', f); continue; }
  if (!/<style>[\s\S]*?<\/style>/.test(html)) { console.log('skip（无 style 块，未动）:', f); continue; }
  const dir = path.join(root, 'snapshots', f.replace('.html', ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(p, path.join(dir, timestamp() + '.html'));
  fs.writeFileSync(p, html.replace(/<style>[\s\S]*?<\/style>/, brutalStyle));
  console.log('migrated:', f);
}
```

- [ ] **Step 2: fixture 验证（幂等 + 快照）**

```bash
cd /Users/xxxly/resume
cp docs/linghaoxiang.html docs/zz-migtest.html
node migrate-style.mjs zz-migtest
```
Expected: `migrated: zz-migtest.html`

```bash
grep -c 'BRUTAL-V1' docs/zz-migtest.html   # 期望 1
ls snapshots/zz-migtest/ | wc -l           # 期望 >= 1（迁移前快照）
node migrate-style.mjs zz-migtest
```
Expected 第二次: `skip（已是 brutal）: zz-migtest.html`（幂等）

```bash
rm -rf docs/zz-migtest.html snapshots/zz-migtest   # 清理 fixture
```

- [ ] **Step 3: 向 xiang 报告**：两次运行输出 + 快照验证 + 清理确认。

---

### Task 7: 审查 + 全量迁移 + 总回归（xiang）

**Files:**
- 全量执行，无新文件

- [ ] **Step 1: 双段审查**：逐行核对 ling 的 server.mjs/test.sh/test-render.sh/migrate-style.mjs 改动 vs 本计划代码块；核对 xiang 自己的 template.html/ai-panel.js。
- [ ] **Step 2: 全量迁移**

```bash
cd /Users/xxxly/resume && node migrate-style.mjs
```
Expected: `migrated: linghaoxiang.html` + `migrated: old-resume.html`（或对应 skip 报告）

- [ ] **Step 3: 重渲染全部 PDF**（样式变了，旧 PDF 是经典版）

```bash
node render.mjs linghaoxiang && node render.mjs old-resume
```
Expected: 两行 `rendered: …`

- [ ] **Step 4: ATS 实检主文档**

```bash
pdftotext pdfs/linghaoxiang.pdf - | head -5
pdftotext pdfs/linghaoxiang.pdf - | wc -m
```
Expected: 含"凌浩翔"；字符数 ≥ 200

- [ ] **Step 5: 重启服务 + 三套件串行**

```bash
launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server"
sleep 2 && curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:7766/
bash test.sh && bash test-structure.sh && bash test-render.sh
```
Expected: 200 + 三套件全绿（含 S1 全部断言）

---

### Task 8: hao 视觉回归（hao）

**Files:**
- 截图落 `/tmp/resume-audit/s1/`

- [ ] **Step 1: brutal 落地实证**（Playwright）：
  - 列表页：工作台标题（黄底粗边）、文档卡片、AI 徽标、PDF 徽标截图 + elementsFromPoint 验证无遮挡
  - 编辑器（linghaoxiang，只看不改）：姓名横幅黄底硬阴影、章节标签奇紫偶蓝、条目卡片；工具栏 brutal 化
  - AI 抽屉：黄头粗边、✕ 可点（24px+2px 边框）、消息卡片
  - 设置页/历史页：brutal 壳（h1 黄标）
- [ ] **Step 2: 打印版式**：浏览器打开 `/edit?id=linghaoxiang` → 打印预览截图（或打开 `pdfs/linghaoxiang.pdf` 截图），确认：无硬阴影残留、色块仅小面积、无爆版
- [ ] **Step 3: 375px 视口**：列表页卡片不溢出；编辑器横滚与基线一致（不新增问题）
- [ ] **Step 4: console 零报错** + 功能快路径（保存→快照→回滚在 uitest3 上走一遍，用完删除）
- [ ] **Step 5: 回复 xiang**：逐项 ✅/❌ + 截图清单

---

### Task 9: 用户目检 + 文档更新（xiang）

- [ ] **Step 1**: 请用户在浏览器目检列表页/编辑器/PDF，收集反馈（可能迭代 1 轮细节：撞色比例、卡片密度）
- [ ] **Step 2**: 更新 `dev-docs/2026-09-10-optimization-audit.md` 追加 S1 段落（或在 handoff 注明新状态）
- [ ] **Step 3**: 关闭可视化伴侣服务器（`stop-server.sh`）

---

## Self-Review 记录

- **Spec 覆盖**：tokens§2→Task1/2/4 ✓；U1→Task3/4 ✓；U2→Task1 ✓；U3→Task2 ✓；U4→Task6 ✓；U5→Task5 ✓；错误处理§5→Task6（快照/skip）+Task7.4 ✓；测试§6→Task3/5/7.5/8 ✓
- **占位符**：无；全部代码块完整
- **一致性**：`BRUTAL-V1` 标记在 Task1（产生）/Task3（断言）/Task6（检测）拼写一致；`badge ai`/`card doc-card`/`简历工作台` 断言与 Task4 实现一致；`zz-migtest` fixture 命名不撞 test.sh 的 `zz-test*` 清理模式（有意区分，由 Task6 自行清理）
- **依赖序**：Task1/2（xiang）∥ Task3-6（ling）→ Task7（xiang 汇合）→ Task8（hao）→ Task9（xiang）；Task3 的"导入文档 brutal"断言需 Task1 落地后转绿
