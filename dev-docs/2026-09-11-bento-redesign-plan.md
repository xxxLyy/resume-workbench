# S5 Bento 网站化 + 🟢 四项 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（适配为 xiang/ling/hao 三会话分工）。步骤用 checkbox 跟踪。
> **禁止一切 git 操作**；"提交"步骤 = 向 xiang 报告改动摘要。
> Spec：`dev-docs/2026-09-11-bento-redesign-design.md`（用户已批准）

**Goal:** 平台五页换 Bento 风 + 全局导航骨架 + 满宽 1100px，打包渲染重试/重新结构化/PORT flaky/新建文档四项。

**Architecture:** page() 壳一次改全站生效（nav/footer/tokens）；listPage 重构为统计卡行+大卡网格；新端点 /new、/restructure；render() 包重试；ai-panel.js 同风换肤。简历文档模板零改动。

**Tech Stack:** Node 内置模块、零框架、CSS 变量、bash 冒烟。

**纪律：** ponytail；禁 git；断言禁裸 `&&`；不读不打印 config.json；先红后绿；**只有 ling 跑 test.sh**（config 竞态教训）；改前 xiang 先备份。

---

## 文件结构

| 文件 | 改动 | 执行者 |
|---|---|---|
| `server.mjs` | page()/listPage 重构 + /new /restructure + render 重试 | ling |
| `test.sh` | S5 断言红绿 + PORT 轮询 + BRUTAL-V1→BENTO-V1 更新 | ling |
| `ai-panel.js` | Bento 换肤（功能逻辑零改动） | xiang |
| `diff.mjs` / `llm.mjs` / `structure.mjs` / `importer.mjs` / `render.mjs` | **不动** | — |

**既有断言锚点（必须保留或按本计划改名）**：`简历工作台`/`card doc-card`/`上传 PDF 导入`/`选择 PDF 文件导入为新文档`/`大模型设置`/`测试连接`/`📋 投递看板`/group-head 分组逻辑/D3 快照说明行。**改名**：`BRUTAL-V1`→`BENTO-V1`（列表/设置/历史三处断言）；`badge ai` 断言 → `AI 配置`（AI 状态迁入统计卡）。

---

### Task 0: 备份（xiang，先于一切）

- [ ] `cp /Users/xxxly/resume/server.mjs /tmp/server.mjs.bento-backup && cp /Users/xxxly/resume/ai-panel.js /tmp/ai-panel.js.bento-backup`

---

### Task 1: test.sh S5 红断言（ling）

**Files:** Modify `/Users/xxxly/resume/test.sh`

- [ ] **Step 1: 更新三处 BRUTAL-V1 断言为 BENTO-V1**（列表/设置/历史）；`badge ai` 断言改为 `grep -q 'AI 配置'`
- [ ] **Step 2: 追加 S5 断言块**（放在 S3 断言之后）：

```bash
# S5：Bento 壳（导航/页脚/统计卡/满宽标记）
curl -sf "http://localhost:$PORT/" | grep -q 'class="topnav"' || { echo '❌ S5 缺导航栏'; exit 1; }
curl -sf "http://localhost:$PORT/" | grep -q '<footer>' || { echo '❌ S5 缺页脚'; exit 1; }
curl -sf "http://localhost:$PORT/" | grep -q 'stat-grid' || { echo '❌ S5 缺统计卡行'; exit 1; }
curl -sf "http://localhost:$PORT/" | grep -q '投递中' || { echo '❌ S5 缺投递统计卡'; exit 1; }
curl -sf "http://localhost:$PORT/settings" | grep -q 'class="topnav"' || { echo '❌ S5 设置页缺壳'; exit 1; }
curl -sf "http://localhost:$PORT/applications" | grep -q 'class="topnav"' || { echo '❌ S5 看板页缺壳'; exit 1; }
echo '✅ S5 Bento 壳'
# S5-D：新建空白文档
NEWLOC=$(curl -s -X POST "http://localhost:$PORT/new" -o /dev/null -w '%{redirect_url}')
NEWID2=$(echo "$NEWLOC" | sed 's/.*id=//')
test -n "$NEWID2" && test -f "docs/$NEWID2.html" || { echo '❌ /new 未建文档'; exit 1; }
curl -sf "http://localhost:$PORT/edit?id=$NEWID2" | grep -q 'contenteditable' || { echo '❌ 新文档不可编辑'; exit 1; }
curl -sf -X POST "http://localhost:$PORT/delete?id=$NEWID2" -o /dev/null
test ! -f "docs/$NEWID2.html" && echo '✅ /new 建删往返' || { echo '❌ /new 清理失败'; exit 1; }
# S5-C：/restructure 守卫（无 config=409；非降级文档=400）
CODE=$(curl -s -X POST "http://localhost:$PORT/restructure?id=smoketest" -o /dev/null -w '%{http_code}')
[ "$CODE" = "409" ] && echo '✅ restructure 409 拦截' || { echo "❌ restructure 应 409 实得 $CODE"; exit 1; }
```

（restructure 的 400 非降级文档断言放在 409 之后无 config 时不可达——guard 顺序 409 在先；400 路径由代码审查+假 LLM 覆盖，见 Task 4 说明）

- [ ] **Step 3: S5-B render 重试断言**（注入一次性失败渲染器）：

```bash
# S5-B：render 重试——假渲染器首次必败第二次成功，验证 /save 自动重试
cat > /tmp/resume-render-fixture.sh << 'FIX'
#!/bin/bash
if [ -f /tmp/resume-render-fixture.once ]; then rm -f /tmp/resume-render-fixture.once; exit 0; fi
touch /tmp/resume-render-fixture.once; exit 1
FIX
chmod +x /tmp/resume-render-fixture.sh
trap 补充清理: rm -f /tmp/resume-render-fixture.sh /tmp/resume-render-fixture.once（加进现有 trap 字符串）
# 重启测试服使 env 生效需要新实例：直接用环境变量起第二个实例太重——改为本断言独立起实例：
PORT=17911 RESUME_RENDER_BIN=/tmp/resume-render-fixture.sh node server.mjs & RT=$!
sleep 0.5
cp docs/linghaoxiang.html docs/zz-retry.html
curl -s -X POST "http://localhost:17911/save?id=zz-retry" --data-binary "$(cat docs/zz-retry.html)" | grep -q '"pdf":true' || { echo '❌ render 重试未生效'; kill $RT; exit 1; }
kill $RT; rm -f docs/zz-retry.html pdfs/zz-retry.pdf snapshots/zz-retry -r
echo '✅ render 失败自动重试'
```

（注意：zz-retry 不撞 trap 现有清理模式，就地清理）

- [ ] **Step 4: 跑红**：`bash test.sh` 应在 `❌ S5 缺导航栏` 失败。报 xiang 红证据。

---

### Task 2: page() 壳 Bento 重写（ling）

**Files:** Modify `server.mjs` 的 `page()`（现 59-83 行区域）

- [ ] **Step 1: 整体替换 page()**（签名加 active 参数用于导航高亮）：

```js
function page(title, inner, active = '') {
  const nav = (key, href, label) => `<a href="${href}"${active === key ? ' class="on"' : ''}>${label}</a>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>/*BENTO-V1*/
:root{--bg:#f5f5f4;--ink:#111;--mut:#6b7280;--line:#e7e5e4;--indigo:#4f46e5;--radius:12px;--shadow:0 1px 3px rgba(0,0,0,.06)}
*{box-sizing:border-box}
body{font-family:"PingFang SC",-apple-system,sans-serif;max-width:1100px;margin:0 auto;padding:0 20px 40px;font-size:14px;background:var(--bg);color:var(--ink)}
a{color:var(--indigo);text-decoration:none;font-weight:600}
.topnav{display:flex;justify-content:space-between;align-items:center;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);padding:10px 18px;margin:16px 0 20px;position:sticky;top:12px;z-index:50}
.topnav .brand{font-weight:800;font-size:15px;color:var(--ink)}
.topnav .links a{margin-left:16px;color:var(--mut);font-weight:600}
.topnav .links a.on{color:var(--indigo)}
.topnav .links a:hover{color:var(--ink)}
h1{font-size:22px;font-weight:800;margin:6px 0 12px}
button{cursor:pointer;background:var(--ink);color:#fff;border:none;border-radius:8px;padding:6px 14px;font-weight:600;font-size:13px}
button.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}
button:hover{opacity:.85}
input,textarea{border:1px solid var(--line);border-radius:8px;padding:7px 10px;background:#fff;font-size:13px}
button:focus-visible,input:focus-visible,a:focus-visible,textarea:focus-visible{outline:2px solid var(--indigo);outline-offset:1px}
.card{background:#fff;border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:14px 16px}
.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;background:#f3f4f6;color:#374151;margin-right:6px}
.badge.ok{background:#dcfce7}.badge.warn{background:#fef3c7}.badge.ai{background:#ede9fe;color:#5b21b6}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:12px 0}
.stat{border-radius:var(--radius);padding:12px 14px;box-shadow:var(--shadow);border:1px solid var(--line)}
.stat b{font-size:22px;display:block}
.stat span{font-size:12px;color:var(--mut)}
.stat.s1{background:#ede9fe}.stat.s2{background:#dbeafe}.stat.s3{background:#dcfce7}.stat.s4{background:#fef3c7}
ul.doclist{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.group-head{list-style:none;grid-column:1/-1;font-weight:800;font-size:14px;margin:10px 0 0;padding-bottom:4px;border-bottom:1px solid var(--line);color:var(--mut)}
.diff-line{padding:3px 8px;border-radius:6px;margin:2px 0;font-size:13px}
.diff-line.same{color:var(--mut)}
.diff-line.del{background:#fee2e2;text-decoration:line-through}
.diff-line.ins{background:#dcfce7}
footer{margin-top:36px;text-align:center;color:#a8a29e;font-size:12px}
</style></head><body>
<nav class="topnav"><a class="brand" href="/">📄 简历工作台</a><span class="links">${nav('docs', '/', '文档')}${nav('apps', '/applications', '📋 投递看板')}${nav('settings', '/settings', '⚙️ 设置')}</span></nav>
${inner}
<footer>简历平台 · 本地优先 · 数据在 ~/resume</footer>
</body></html>`;
}
```

- [ ] **Step 2: 更新 page() 全部调用点**加 active 参数：listPage→`'docs'`、settings→`'settings'`、snapshots→`'docs'`、diff→`'docs'`、applications→`'apps'`、404→不加。
- [ ] **Step 3: 跑 test.sh**——壳断言应转绿（列表页内容断言仍红，属 Task 3）。
- [ ] **Step 4: 报 xiang**。

---

### Task 3: listPage Bento 重构（ling）

**Files:** Modify `server.mjs` 的 `listPage()`（现 110-160 行区域）

- [ ] **Step 1: 整体替换 listPage()**：

```js
function listPage() {
  const meta = loadMeta();
  const docs = fs.readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.html') && !f.startsWith('.'));
  const pdfCount = docs.filter((f) => fs.existsSync(pdfPath(f.replace('.html', '')))).length;
  const activeApps = loadApps().filter((a) => !APP_TERMINAL.includes(a.status)).length;
  const { active, profiles } = loadProfiles(root);
  const cfg = profiles[active];
  const cardHtml = (f) => {
    const id = f.replace('.html', '');
    const tag = (meta[id] && meta[id].tag) || '';
    const content = fs.readFileSync(path.join(root, 'docs', f), 'utf8');
    const title = escHtml((content.match(/<h1>([^<]+)<\/h1>/) || [])[1] || id);
    const mtime = fs.statSync(path.join(root, 'docs', f)).mtime.toLocaleString('zh-CN');
    const snaps = fs.existsSync(snapDir(id)) ? fs.readdirSync(snapDir(id)).filter((s) => s.endsWith('.html')).length : 0;
    const hasPdf = fs.existsSync(pdfPath(id));
    const degraded = content.includes('以下为 PDF 提取的原文');
    return `<li class="card doc-card"><b style="font-size:16px">${title}</b>
      <div style="color:var(--mut);font-size:12px;margin:6px 0">${id} · 更新于 ${mtime}</div>
      <div style="margin-bottom:8px"><span class="badge">快照 ${snaps}</span><span class="badge ${hasPdf ? 'ok' : 'warn'}">${hasPdf ? 'PDF ✓' : 'PDF ✗'}</span>${tag ? `<span class="badge">${escHtml(tag)}</span>` : ''}${degraded ? '<span class="badge warn">待结构化</span>' : ''}</div>
      <a href="/edit?id=${id}">编辑</a> ·
      <a href="/pdf?id=${id}" target="_blank">PDF</a> ·
      <a href="/snapshots?id=${id}">历史</a> ·
      <a href="/diff?base=${id}">对比</a> ·
      ${degraded ? `<form method="post" action="/restructure?id=${id}" style="display:inline" onsubmit="return confirm('用 LLM 重新结构化这份文档？会先自动留快照')"><button class="secondary">🔁 结构化</button></form> · ` : ''}
      <form method="post" action="/tag" style="display:inline" onsubmit="event.preventDefault();const t=prompt('标签（≤20字，留空清除）','${tag}');if(t!==null){fetch('/tag',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'${id}',tag:t})}).then(()=>location.reload())}"><button class="secondary">🏷</button></form> ·
      <form method="post" action="/duplicate?id=${id}" style="display:inline" onsubmit="event.preventDefault();const t=prompt('新文档 id（小写字母数字横线）');if(t){this.action='/duplicate?id=${id}&to='+t;this.submit()}"><button>复制</button></form> ·
      <form method="post" action="/delete?id=${id}" style="display:inline" onsubmit="return confirm('确认删除 ${id}？快照会保留')"><button class="secondary">删除</button></form>
    </li>`;
  };
  const byTag = new Map();
  for (const f of docs) {
    const key = (meta[f.replace('.html', '')] && meta[f.replace('.html', '')].tag) || '未标记';
    if (!byTag.has(key)) byTag.set(key, []);
    byTag.get(key).push(cardHtml(f));
  }
  const keys = [...byTag.keys()].sort((x, y) => (x === '未标记') - (y === '未标记') || x.localeCompare(y));
  // 全部无标签时不显示组标题（纯平铺），有标签才分组
  const cards = keys.length === 1 && keys[0] === '未标记'
    ? byTag.get('未标记').join('\n')
    : keys.map((k) => `<li class="group-head">${escHtml(k)}</li>\n${byTag.get(k).join('\n')}`).join('\n');
  return page('简历平台', `<h1>简历工作台</h1>
    <div class="stat-grid">
      <div class="stat s1"><b>${docs.length}</b><span>📄 文档</span></div>
      <div class="stat s2"><b>${activeApps}</b><span>📋 投递中</span></div>
      <div class="stat s3"><b>${cfg ? escHtml(cfg.name || '') : '未配置'}</b><span>🤖 AI 配置</span></div>
      <div class="stat s4"><b>${pdfCount}</b><span>📑 PDF 就绪</span></div>
    </div>
    <form id="up" class="card">
      <b>上传 PDF 导入：</b><span style="color:#666">选择 PDF 文件导入为新文档</span><input type="file" id="upfile" accept="application/pdf">
      <button>导入</button><span id="upmsg"></span>
    </form>
    <ul class="doclist">${cards}
      <li class="card" style="border-style:dashed;text-align:center;display:flex;align-items:center;justify-content:center"><form method="post" action="/new"><button>＋ 新建空白文档</button></form></li>
    </ul>
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
    </script>`, 'docs');
}
```

- [ ] **Step 2: 跑 test.sh**——列表页断言应全绿（/new、restructure、render 重试断言仍红，属 Task 4）。
- [ ] **Step 3: 报 xiang**。

---

### Task 4: /new + render 重试 + /restructure（ling）

**Files:** Modify `server.mjs`

- [ ] **Step 1: 顶部 import 加 structureText**：

```js
import { structureText } from './structure.mjs';
```

- [ ] **Step 2: render() 加重试**（替换现 render 函数，保留 60s 兜底注释）：

```js
function render(id) {
  const attempt = () => new Promise((resolve) => {
    // RESUME_RENDER_BIN 仅供测试注入假渲染器（test.sh S5-B），生产勿设
    const child = spawn(process.env.RESUME_RENDER_BIN || 'node', [path.join(root, 'render.mjs'), id], { stdio: 'inherit' });
    const timer = setTimeout(() => child.kill(), 60000);  // ponytail: 60s 兜底，挂住不至于永久悬挂
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
  });
  return attempt().then((ok) => ok || attempt());  // 🟢B：渲染偶发失败自动重试 1 次
}
```

- [ ] **Step 3: /new 端点**（放在 /duplicate 之前）：

```js
    // 新建空白文档（template 空骨架，doc/doc-N 顺延不撞名）
    if (req.method === 'POST' && url.pathname === '/new') {
      const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
      let i = 0, newId;
      do { newId = i === 0 ? 'doc' : 'doc-' + i; i++; } while (fs.existsSync(docPath(newId)));
      const html = tpl
        .replaceAll('{{NAME}}', () => '未命名')
        .replaceAll('{{CONTACT}}', () => '')
        .replaceAll('{{INTENT}}', () => '')
        .replaceAll('{{SUMMARY}}', () => '点击开始编辑…')
        .replaceAll('{{SKILLS}}', () => '<p>技能…</p>')
        .replaceAll('{{WORK}}', () => '')
        .replaceAll('{{PROJECTS}}', () => '')
        .replaceAll('{{EDU}}', () => '')
        .replaceAll('{{DOC_ID}}', () => newId);
      fs.writeFileSync(docPath(newId), html);
      res.writeHead(303, { Location: `/edit?id=${newId}` });
      return res.end();
    }
```

- [ ] **Step 4: /restructure 端点**（放在 /ai/chat 之后）：

```js
    // 🟢C：降级文档重新结构化（读原文 → LLM 结构化 → 成功才快照覆盖；失败原样保留）
    if (req.method === 'POST' && url.pathname === '/restructure') {
      if (!hasLLM(root)) return send(409, '未配置大模型，请先到"⚙️ 大模型设置"', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      const html = fs.readFileSync(docPath(id), 'utf8');
      if (!html.includes('以下为 PDF 提取的原文')) return send(400, '该文档不是降级文档', 'text/plain');
      const text = docToLines(html).filter((l) => !l.includes('以下为 PDF 提取的原文')).join('\n');
      const structured = await structureText(root, text).catch(() => null);
      if (!structured) return send(502, 'LLM 结构化失败，文档未改动', 'text/plain');
      snapshot(id);
      const tmp = docPath(id) + '.' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.tmp';
      fs.writeFileSync(tmp, structured);
      fs.renameSync(tmp, docPath(id));
      const pdfOk = await render(id);
      res.writeHead(303, { Location: `/edit?id=${id}` });
      return res.end();
    }
```

（成功路径在 test.sh 无法覆盖——测试期无 config，与 AI chat 同款既有缺口；由 test-structure.sh 的 structureText 假 LLM 测试 + 代码审查兜底，属已接受口径）

- [ ] **Step 5: 跑 test.sh 全绿**，报 xiang。

---

### Task 5: PORT NaN flaky 加固（ling）

**Files:** Modify `test.sh` 的 B 段（现 `sleep 0.5` 处）

- [ ] **Step 1: 固定 sleep 改轮询**：

```bash
# 轮询等日志就绪（替代固定 sleep 0.5 的计时抖动）
for i in $(seq 1 15); do grep -q 'localhost:77' /tmp/resume-port-nan.log 2>/dev/null && break; sleep 0.2; done
```

（删掉后续重复的 grep 断言？不——保留，轮询只是等就绪，断言仍要）
- [ ] **Step 2: 连跑 3 遍 `bash test.sh`** 全绿（消除 flaky 的实证）。报 xiang。

---

### Task 6: ai-panel.js Bento 换肤（xiang，与 ling 并行）

**Files:** Modify `ai-panel.js` 的 css.textContent 段

- [ ] **Step 1: css.textContent 整体替换**（功能逻辑零改动；保留 z-index 101、✕ 24px、补丁块）：

```js
  css.textContent = '#ai-toggle{position:fixed;right:16px;bottom:16px;z-index:101;width:44px;height:44px;border-radius:50%;border:none;background:#4f46e5;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18)}'
    + '#ai-drawer{position:fixed;right:0;top:0;bottom:0;width:380px;background:#f5f5f4;border-left:1px solid #e7e5e4;z-index:101;display:none;flex-direction:column;box-shadow:-4px 0 16px rgba(0,0,0,.08);font-size:13px;font-family:"PingFang SC",-apple-system,sans-serif}'
    + '#ai-drawer.open{display:flex}'
    + '#ai-drawer header{padding:10px 12px;font-weight:700;border-bottom:1px solid #e7e5e4;display:flex;justify-content:space-between;align-items:center;background:#fff}'
    + '#ai-close{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;font-size:14px;border-radius:6px;border:1px solid #e7e5e4;background:#fff}'
    + '#ai-close:hover{background:#f3f4f6}'
    + '#ai-tabs{display:flex;border-bottom:1px solid #e7e5e4;background:#fff;flex:none}'
    + '#ai-tabs button{flex:1;padding:8px 0;background:#fff;border:none;border-right:1px solid #e7e5e4;font-weight:600;cursor:pointer;font-size:13px;color:#6b7280}'
    + '#ai-tabs button:last-child{border-right:none}'
    + '#ai-tabs button.on{background:#fff;color:#4f46e5;box-shadow:inset 0 -2px 0 #4f46e5}'
    + '.ai-pane{display:none;flex:1;flex-direction:column;min-height:0}'
    + '.ai-pane.on{display:flex}'
    + '#ai-pane-review,#ai-pane-match{overflow:auto}'
    + '.ai-actions{padding:10px;border-bottom:1px solid #e7e5e4;background:#fff;display:flex;gap:8px;flex-wrap:wrap;flex:none}'
    + '#ai-jd{width:100%;height:110px;border:1px solid #e7e5e4;border-radius:8px;padding:6px;box-sizing:border-box;font-size:12px}'
    + '#ai-review-out,#ai-match-out{padding:10px;overflow:auto;flex:1}'
    + '.ai-score{border:1px solid #e7e5e4;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);background:#fff;padding:10px;text-align:center;margin:8px 0;font-size:13px}'
    + '.ai-score b{font-size:32px;display:block;color:#4f46e5}'
    + '#ai-log{flex:1;overflow:auto;padding:10px 12px}'
    + '#ai-drawer .msg{margin:8px 0;padding:8px 10px;border-radius:10px;border:1px solid #e7e5e4;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.04);white-space:pre-wrap}'
    + '#ai-drawer .msg.user{background:#ede9fe}'
    + '#ai-input{display:flex;gap:6px;padding:10px;border-top:1px solid #e7e5e4;background:#fff}'
    + '#ai-input input{flex:1;padding:6px 8px;border:1px solid #e7e5e4;border-radius:8px;background:#fff}'
    + '#ai-input button,#ai-pop button,.ai-actions button{border:none;border-radius:8px;background:#4f46e5;color:#fff;padding:6px 12px;font-weight:600;cursor:pointer}'
    + '.ai-change{border:1px solid #e7e5e4;border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.04);background:#fff;padding:8px;margin:8px 0}'
    + '.ai-before{background:#fee2e2;text-decoration:line-through;padding:4px;border-radius:6px;margin-bottom:4px;white-space:pre-wrap}'
    + '.ai-after{background:#dcfce7;padding:4px;border-radius:6px;white-space:pre-wrap}'
    + '.ai-change button{margin:6px 6px 0 0;border:1px solid #e7e5e4;border-radius:6px;background:#fff;padding:3px 10px;cursor:pointer}'
    + '#ai-sel-btn{position:absolute;z-index:99;display:none;padding:4px 10px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.15)}'
    + '#ai-pop{position:absolute;z-index:99;background:#fff;border:1px solid #e7e5e4;border-radius:12px;box-shadow:0 4px 14px rgba(0,0,0,.12);padding:8px;display:none;width:360px;font-size:13px}'
    + '#ai-pop textarea{width:100%;height:56px;font-size:13px;box-sizing:border-box;border:1px solid #e7e5e4;border-radius:8px;background:#fff}'
    + '#ai-pop .preview{max-height:200px;overflow:auto;margin-top:6px}'
    + '#ai-pop .row{margin-top:6px;text-align:right}'
    + '@media print{#ai-toggle,#ai-drawer,#ai-sel-btn,#ai-pop{display:none!important}}'
    + '#ai-drawer button:focus-visible,#ai-drawer input:focus-visible,#ai-pop button:focus-visible,#ai-pop textarea:focus-visible,#ai-toggle:focus-visible,#ai-sel-btn:focus-visible{outline:2px solid #4f46e5;outline-offset:1px}'
    // 经典文档样式补丁：经典模板文档的 D2/D4/D9 改进（工具栏加高/分页线淡化/焦点环），
    // serve 注入覆盖、/save 随面板剥离；template.html 经典版已内含同款值，此处为幂等覆盖
    + '.edit-toolbar button{padding:10px 14px;font-size:13px}'
    + '.page-line{border-top-color:rgba(231,76,60,.32)}'
    + '.page-line span{top:1.5mm;font-size:9px;color:rgba(231,76,60,.7)}'
    + 'button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #409eff;outline-offset:1px}';
```

- [ ] **Step 2: 验证**：`node --check ai-panel.js` + `curl -sf http://127.0.0.1:7766/ai-panel.js | grep -c '4f46e5'`（应 ≥6）。
- [ ] **Step 3: 报 xiang（自查即我）**。

---

### Task 7: 审查 + 总回归（xiang）

- [ ] **Step 1: 双段审查**：ling 的 server.mjs/test.sh 改动逐行对本计划代码块；重点核：page() 调用点 active 参数全更新、/save 的 A1/A7 守卫未被波及、kanban/diff 页在新壳下断言不破
- [ ] **Step 2: 独立三套件串行**：`bash test.sh && bash test-structure.sh && bash test-render.sh` 全绿
- [ ] **Step 3: 重启服务**：`launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server"` + curl 200 + 抽查 `/` 含 topnav/stat-grid、`/applications` 含 topnav

---

### Task 8: hao 视觉回归（hao）

- [ ] **Step 1: Bento 落地实证**（截图 /tmp/resume-audit/s6/）：列表页（导航栏 sticky/统计四卡/文档大卡网格/新建虚线卡/页脚）、设置页、历史页、看板页（六列在新壳下不爆版）、对比页
- [ ] **Step 2: 满宽与响应**：1280px 与 375px 两视口——1280 内容区应 ~1100px 不再细条；375 无横向溢出（统计卡 auto-fit 换行）
- [ ] **Step 3: 编辑器+抽屉**：经典文档 + bento 面板共存（白卡圆角微阴影，无 brutal 残留）；✕ 24px 可点；三 Tab 正常
- [ ] **Step 4: 功能快路径**：/new 建文档→编辑→保存→删除；看板加一条→🎯 桥接→删除；全程 console 零报错
- [ ] **Step 5: 逐项 ✅/❌ 报 xiang**

---

### Task 9: 目检与收尾（xiang）

- [ ] 用户浏览器目检（可能 1 轮迭代：彩卡配色/密度）
- [ ] 更新 dev-docs/2026-09-10-optimization-audit.md 追加 S5 段
- [ ] 关可视化伴侣服务器

---

## Self-Review 记录

- **Spec 覆盖**：§1 壳→T2 ✓；§2 列表页→T3 ✓；§3 B→T4.2/T1.3、C→T4.4/T1.2、flaky→T5、D→T4.3/T1.2 ✓；§4 回退→T0 ✓；§5 测试→T1/5/7/8 ✓
- **一致性**：BENTO-V1 在 T1（断言）/T2（产生）拼写一致；`stat-grid`/`topnav`/`AI 配置` 断言与 T2/T3 实现一致；RESUME_RENDER_BIN 在 T1.3（注入）/T4.2（消费）一致；zz-retry fixture 不撞 test.sh trap 的 zz-test*/zz-diff* 模式 ✓
- **占位符**：无；所有代码块完整可直接落
- **风险点记录**：kanban 六列复用的 .group-head 样式在新壳下变为"细线 muted"风（原 brutal 紫条退役），hao T8 目检确认
