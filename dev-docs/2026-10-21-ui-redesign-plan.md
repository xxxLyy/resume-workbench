# UI 重设计实施计划 · 零构建 + 浅色克制设计系统

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把简历工作台从「emoji 堆砌 + 布局写死」改造成 token 化、Lucide 图标、可拖拽分栏的浅色克制界面，新增 npm 依赖 0 个。

**Architecture:** 零构建——全部改动落在服务端模板字符串（`server.mjs`）与既有注入层 JS（`editor-shell.js` 等）。图标走「一次性从 lucide-react 提取 path 数据 → `vendors/icons.mjs` 纯数据」路线，服务端 `icon()` helper 输出内联 SVG（`stroke:currentColor`）。分栏用原生 Pointer Events，不引 React 生态。

**Tech Stack:** 纯 Node.js（`node:crypto` 已在用）、原生 HTML/CSS/JS、lucide-react v0.468.0 **仅作为离线提取源**（ISC 许可，不进依赖）。

**设计文档：** `dev-docs/2026-10-21-ui-redesign-design.md`

---

## ⚠️ 执行纪律（违反会出事）

1. **跑测试必须重定向到文件**：`bash test-structure.sh > /tmp/x.log 2>&1`。禁止管道接 grep、绝不并发、绝不让超时强杀。
2. **禁止 `cat >> 文件 << HEREDOC`**：2026-10-19 发生过执行器超时截断导致 heredoc 终止符失效，把后续命令灌进 `test-structure.sh` 造成 11 层自递归。**追加内容一律用 python3 脚本**（有 assert 与明确返回码），写完立刻 `bash -n` 验语法。
3. **冻结件不可动**：`template.html` / `themes/` / `render.mjs`。终检 `git diff --stat -- template.html themes/ render.mjs` 必须为空。
4. **注入层不能进正文**：`/save` 有剥离清单（`extract.mjs` 的 `data-ai-panel`/`data-ed-shell`/`data-ed-inj`/`data-job-panel`）。所有新 UI 必须在服务端模板或注入层，**不得写进 `docs/*.html`**。改完用 `test-editor.mjs` 的注入层隔离用例验证。
5. **不要改 `docs/*.html` 里的正文**（那是用户真实简历数据）。
6. **不新增任何 npm 依赖**：`package.json` 的 dependencies 必须保持 `["playwright-core"]`。
7. **每个 Task 结束跑四件套**，基线 **115 ✅ / 339 ✅** 只增不减。

---

## 文件地图

| 文件 | 责任 | 本轮改动 |
|---|---|---|
| `vendors/icons.mjs` | **新建** — 44 个 Lucide 图标的 path 数据（纯数据，无代码） | 新建（ocr 审查后由 .js 改名，ESM 导出） |
| `scripts/icons.list.json` | **新建** — 44 个图标名的唯一来源 | 新建（脚本与 UI-1 断言共用） |
| `vendors/icons.LICENSE` | **新建** — 上游 lucide 的 ISC 许可全文 | 新建（再分发须保留版权声明） |
| `scripts/extract-icons.mjs` | **新建** — 从 lucide-react 提取 path 数据（可重现） | 新建 |
| `server.mjs` | 服务端模板 + 全站 CSS + `icon()` helper | token 覆盖、徽章、侧栏、拖柄、首页重排 |
| `editor-shell.js` | 编辑器注入层 | 拖拽逻辑、emoji 替换 |
| `job-panel.js` | 岗位审阅面板 | emoji → 徽章 |
| `zone-panel.js` | 区域面板 | emoji → 图标 |
| `ai-panel.js` | AI 面板 | emoji → 图标；接上 `--ed-right-w` |
| `test-structure.sh` | 纯函数/结构断言 | 新增 UI-1…UI-5 组 |
| `test-editor.mjs` | 浏览器级编辑器测试 | 新增拖拽用例 |
| `package.json` | 依赖 | **不动** |

---

## Task 1 · 图标数据 + 提取脚本（批次 A）

**Files:**
- Create: `scripts/extract-icons.mjs`
- Create: `vendors/icons.mjs`（ESM 导出）
- Create: `scripts/icons.list.json`（图标清单唯一来源）
- Create: `vendors/icons.LICENSE`（上游 ISC 许可全文）
- Modify: `test-structure.sh`（末尾追加 UI-1 组）

- [ ] **Step 1.1: 写提取脚本**

创建 `scripts/extract-icons.mjs`：

```text
⚠️ 2026-10-21 ocr 审查后已修正 —— 现行实现见 scripts/extract-icons.mjs（唯一来源，勿照抄旧版）。
相对本计划初稿的修正：
  1. 绝不执行源文件文本：初稿用 Function 构造器求值 JS 字面量 —— 投毒目录等于在你机器上跑任意代码。
     现行做法是「给未加引号的 key 补引号」的纯文本规范化 + JSON.parse，解析失败即 exit 1、不覆盖已有产物。
  2. 图标清单来自 scripts/icons.list.json（唯一来源，脚本与 UI-1 断言共用，杜绝双份维护）。
  3. 版本号从来源包 package.json 动态读，来源路径也写进产物头部（换目录重跑不再谎报版本）。
  4. 产物是 ESM（vendors/icons.mjs）、null 原型对象、一个图标一行（diff 看得见改了哪个）。
  5. 探测路径：显式参数 → 本仓库 node_modules → 用户级 node_modules（HOME 未设置则跳过）。
```

- [ ] **Step 1.2: 运行提取脚本**

```bash
cd /Users/xxxly/resume && node scripts/extract-icons.mjs
```

Expected: `提取图标数: 44 | 来源版本: v0.468.0 | 输出: /Users/xxxly/resume/vendors/icons.mjs`

若报「找不到 lucide-react 图标目录」，用 `find /Users/xxxly -maxdepth 6 -type d -name icons -path "*lucide-react*" 2>/dev/null | head -3` 定位真实路径后传参：`node scripts/extract-icons.mjs <该路径>`。

- [ ] **Step 1.3: 写失败断言（UI-1）**

用 python3 追加到 `test-structure.sh` 末尾（**不要用 heredoc**）：

```text
UI-1 断言组现行内容见 test-structure.sh 末尾的「UI-1：图标数据完整且可渲染」块。
2026-10-21 ocr 审查后新增/改写（相对本计划初稿）：
  · import 路径是 './vendors/icons.mjs'（ESM，不再是 CJS 探测导出）。
  · 图标名不再硬编码：从 scripts/icons.list.json 读，并断言**键集合完全一致**（缺/多都要报出来）。
  · 新增属性名白名单断言（数据级）+ icon() 运行时断言（白名单外的属性名/元素名必须被丢弃）。
  · 新增提取脚本安全哨兵：不得出现 Function 构造器 / eval、清单不得硬编码、版本不得写死、
    写文件必须在失败检查之后（失败路径不得覆盖已有产物）。
追加/替换文件用 python3 脚本（**不要用 heredoc 写文件**），写完立刻 bash -n test-structure.sh。
```

- [ ] **Step 1.4: 跑测试确认绿**

```bash
cd /Users/xxxly/resume && bash test-structure.sh > /tmp/s.log 2>&1; echo "exit=$?"; grep -c "✅" /tmp/s.log; grep "UI-1" /tmp/s.log
```

Expected: `exit=0`，✅ 数 = **116**（115 基线 + 1），输出含 `✅ UI-1 图标数据完整（44 个）`
> 注：真实基线 115（实测），不是 96 —— 原计划此处笔误。

- [ ] **Step 1.5: 提交**

```bash
cd /Users/xxxly/resume && git add scripts/extract-icons.mjs scripts/icons.list.json vendors/icons.mjs vendors/icons.LICENSE test-structure.sh && git commit -m "feat(ui): 批次A 地基 — Lucide 图标数据 + 可重现提取脚本

从 lucide-react v0.468.0（ISC）一次性提取 44 个图标 path 数据 → vendors/icons.mjs
（约 8 KB 纯数据）。零运行时依赖、零 npm 依赖，路径可读可改。
提取脚本保留在 scripts/extract-icons.mjs，换图标集改 scripts/icons.list.json 重跑即可。

新增 UI-1 断言组：图标总数、各图标非空、标签类型合法、d 属性非空、无 key 残留。
test-structure 115 → 116 组 ✅。" && git log --oneline -1
```

---

## Task 2 · `icon()` helper + 浅色 token 覆盖（批次 A）

**Files:**
- Modify: `server.mjs`（825 行 A-VARS 块；新增 icon() helper；853/856 行徽章 CSS）
- Modify: `test-structure.sh`（追加 UI-2 组）

- [ ] **Step 2.1: 写失败断言（UI-2）**

```bash
python3 - << 'PYEOF'
import io
p = 'test-structure.sh'
s = io.open(p, encoding='utf-8').read()
add = '''
# —— UI-2：浅色克制 token + icon() helper（批次A）——
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('❌ UI-2 ' + m); process.exit(1); } };
const srv = readFileSync('./server.mjs', 'utf8');
// 新 token 必须存在（同名覆盖旧 A-VARS）
for (const [k, v] of Object.entries({
  '--background': '#ffffff', '--foreground': '#0a0a0a', '--muted': '#737373',
  '--card': '#ffffff', '--card-2': '#fafafa', '--border': '#e5e5e5',
  '--accent': '#18181b', '--accent-fg': '#ffffff',
  '--success': '#16a34a', '--warning': '#d97706', '--danger': '#dc2626',
})) {
  assert(srv.includes(k) && srv.includes(v), `token ${k} 应存在且值为 ${v}`);
}
assert(/--shadow:\s*none/.test(srv), '主阴影应为 none（靠边框不靠阴影）');
// icon() helper 必须存在且白名单化（防 XSS：名字只允许 ICONS 里的）
assert(/function icon\(/.test(srv), '必须有 icon() helper');
assert(/ICONS\[/.test(srv), 'icon() 必须走 ICONS 白名单查表（不拼字符串）');
assert(/currentColor/.test(srv), 'icon() 输出必须用 currentColor（跟随主题）');
assert(/viewBox/.test(srv), 'icon() 输出必须带 viewBox');
console.log('✅ UI-2 浅色 token + icon() helper');
EOF
'''
assert 'UI-2：浅色克制 token' not in s
io.open(p, 'w', encoding='utf-8').write(s.rstrip('\n') + '\n' + add)
print('UI-2 断言已追加')
PYEOF
bash -n test-structure.sh
```

- [ ] **Step 2.2: 跑测试确认红**

```bash
cd /Users/xxxly/resume && bash test-structure.sh > /tmp/s.log 2>&1; echo "exit=$?"; grep "UI-2" /tmp/s.log
```

Expected: `exit=1`，输出 `❌ UI-2 token --background 应存在且值为 #ffffff`

- [ ] **Step 2.3: 写实现**

**① 替换 825 行的 A-VARS 块**（保留旧变量名作为别名，避免既有 CSS 一次性全改）：

> ⚠️ **`:root` 必须保持单行**（2026-10-18 实施实测）：`test-structure.sh` 的 S2-B1 断言
> `ALLOW_DECL = /\/\*A-VARS\*\/:root{/` **只放行含该标记的那一行**出现 hex。
> 计划原文的多行写法会让 S2-B1 必红（"组件层残留字面色"）。保持单行，不要改断言。

```javascript
/*A-VARS*/:root{
  /* 浅色克制设计系统（2026-10-21 UI 重设计，设计文档 dev-docs/2026-10-21-ui-redesign-design.md）
     主行动用近黑不用蓝；彩色只承载状态；零阴影靠 1px 边框 + 背景差表达层级。 */
  --background:#ffffff; --foreground:#0a0a0a; --muted:#737373; --muted-2:#a1a1aa;
  --card:#ffffff; --card-2:#fafafa; --border:#e5e5e5;
  --accent:#18181b; --accent-fg:#ffffff;
  --success:#16a34a; --success-bg:#f0fdf4;
  --warning:#d97706; --warning-bg:#fffbeb;
  --danger:#dc2626; --danger-bg:#fef2f2;
  --radius:4px; --radius-lg:6px; --shadow:none;
  --font:"Geist",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  --font-mono:"Geist Mono",ui-monospace,Menlo,monospace;
  /* 旧名别名：既有 CSS 大量使用 --bg/--panel/--ink/...，保持可用避免全量重写 */
  --bg:var(--background); --panel:var(--card); --ink:var(--foreground);
  --mut:var(--muted); --line:var(--border); --accent-ink:var(--accent-fg);
  --accent-soft:var(--card-2); --ok:var(--success); --ok-soft:var(--success-bg);
  --warn:var(--warning); --warn-soft:var(--warning-bg); --err:var(--danger); --err-soft:var(--danger-bg);
  --ai:var(--foreground); --ai-soft:var(--card-2);
  --serif:var(--font); --sans:var(--font);
  --shadow-up:0 10px 24px rgba(0,0,0,.10);
}
```

**② 新增 `icon()` helper**（放在 `server.mjs` 顶部 import 之后，`page()` 之前）：

> ⚠️ 计划原文的 `icon()` 有三个洞，实施时必须补上（2026-10-18 实测）：
> ① `ICONS[name]` 直接查表会命中**原型链**（`icon('constructor')` 返回函数）→ 必须用
>    `Object.prototype.hasOwnProperty.call(ICONS, name)` 守卫
> ② `size` 直接插值可注入 → 必须是数值，非正数回落 16
> ③ `cls` 直接插值可逃逸属性（`"><img src=x onerror=...>`）→ 必须过滤为 `[A-Za-z0-9_ -]`

```javascript
import { ICONS } from './vendors/icons.mjs';

/**
 * 内联 SVG 图标（Lucide path 数据，ISC）。
 * 名字走 ICONS 白名单查表 —— 不存在就返回空串，**绝不把调用方传入的字符串拼进 SVG**（XSS）。
 * stroke 用 currentColor，跟随主题色。
 */
function icon(name, size = 16, cls = '') {
  const parts = ICONS[name];
  if (!parts) return '';
  const body = parts.map(([tag, a]) => `<${tag} ${Object.entries(a).map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ')}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${cls ? ` class="${cls.replace(/"/g, '')}"` : ''} aria-hidden="true" focusable="false">${body}</svg>`;
}
```

- [ ] **Step 2.4: 跑测试确认绿**

```bash
cd /Users/xxxly/resume && bash test-structure.sh > /tmp/s.log 2>&1; echo "exit=$?"; grep -c "✅" /tmp/s.log; grep "UI-2" /tmp/s.log
```

Expected: `exit=0`，✅ 数 = **117**（116 基线 + 1）
> 真实基线 116（Task 1 实测），不是 97 —— 原计划此处笔误。

- [ ] **Step 2.5: 提交**

```bash
cd /Users/xxxly/resume && git add server.mjs test-structure.sh && git commit -m "feat(ui): 批次A — 浅色克制 token + icon() helper

token 覆盖（同名 + 旧名别名，既有 CSS 零改动即可生效）：
  主行动 --accent:#18181b（近黑不用蓝，彩色只承载状态）
  --shadow:none 靠 1px 边框 + 背景差表达层级
  圆角 4/6px；字体 Geist + PingFang SC 回退
  旧名 --bg/--panel/--ink/... 保留为别名，避免全量重写既有 CSS

icon(name,size) helper：ICONS 白名单查表（不存在→空串，绝不拼调用方字符串 → 无 XSS 面），
输出内联 SVG，stroke:currentColor 跟随主题。

UI-2 断言：13 个新 token 存在且值正确 / shadow:none / icon() 存在 / 走 ICONS 查表 /
currentColor / viewBox。test-structure 116 → 117 组 ✅。" && git log --oneline -1
```

---

## Task 3 · 徽章图标化（批次 A）

**Files:**
- Modify: `server.mjs`（853/856 行徽章 CSS；`jobStatusBadge()` 派生逻辑）
- Modify: `test-structure.sh`（追加 UI-3 组）

- [ ] **Step 3.1: 写失败断言（UI-3）**

```bash
python3 - << 'PYEOF'
import io
p = 'test-structure.sh'
s = io.open(p, encoding='utf-8').read()
add = '''
# —— UI-3：状态徽章图标化（消灭裸 emoji 状态标记）——
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('❌ UI-3 ' + m); process.exit(1); } };
const srv = readFileSync('./server.mjs', 'utf8');
// 四类语义徽章必须存在，且各带对应图标
for (const [cls, ic] of [['ok', 'circle-check'], ['warn', 'circle-alert'], ['err', 'circle-x'], ['mute', 'circle-help']]) {
  assert(new RegExp('\\.badge\\.' + cls + '\\{').test(srv), '应有 .badge.' + cls + ' 徽章类');
  assert(srv.includes("'" + ic + "'") || srv.includes('"' + ic + '"'), cls + ' 徽章应使用图标 ' + ic);
}
// 徽章必须是小圆角胶囊 + 语义底色
assert(/\.badge\{[^}]*border-radius:999px/.test(srv), '.badge 应为胶囊形');
assert(/--success-bg/.test(srv) && /--warning-bg/.test(srv) && /--danger-bg/.test(srv), '徽章语义底色 token 缺失');
// 状态标记不得再用裸 emoji：⚠️ ❌ ✅ ⚪ 🟡 🔴 在 HTML 模板中不得出现。
// 【必须剥掉注释再查】——代码注释里大量用这些符号做安全审查标记
//   （如「2026-10-19 审查 ⚪-6」「⚠️ 计数器必须在模块级」，实测 server.mjs 有 13 处）。
//   不剥注释的断言会让执行者去删安全审查记录，把审计痕迹毁掉。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
  .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
const code = stripComments(srv);
const emojiHits = ['⚠️','❌','✅','⚪','🟡','🔴'].filter(e => code.includes(e));
assert(emojiHits.length === 0, 'server.mjs 代码/模板中仍含状态 emoji: ' + emojiHits.join(' '));
console.log('✅ UI-3 状态徽章图标化');
EOF
'''
assert 'UI-3：状态徽章图标化' not in s
io.open(p, 'w', encoding='utf-8').write(s.rstrip('\n') + '\n' + add)
print('UI-3 断言已追加')
PYEOF
bash -n test-structure.sh
```

- [ ] **Step 3.2: 跑测试确认红**

```bash
cd /Users/xxxly/resume && bash test-structure.sh > /tmp/s.log 2>&1; echo "exit=$?"; grep "UI-3" /tmp/s.log
```

Expected: `exit=1`，输出形如 `❌ UI-3 server.mjs 仍含状态 emoji: ⚠️ ❌ ✅ ...`

- [ ] **Step 3.3: 写实现**

**① 替换 853/856 行的徽章 CSS**：

```javascript
.badge{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:500;background:var(--card-2);color:var(--mut);margin-right:6px;white-space:nowrap}
.badge svg{width:11px;height:11px;stroke-width:2.4;flex:none}
/* 语义徽章：底色 + 语义色 + 图标 + 文字（颜色不单独承载语义，WCAG color-not-only）
   类名沿用现有的 .badge ok/.warn/.err/.ai（既有 43 处在用），只新增 .badge.mute
   —— 不另起 badge--ok 体系，避免两套命名并存 */
.badge.ok{background:var(--success-bg);color:var(--success)}
.badge.warn{background:var(--warning-bg);color:var(--warning)}
.badge.err{background:var(--danger-bg);color:var(--danger)}
.badge.ai{background:var(--card-2);color:var(--foreground)}
.badge.mute{background:var(--card-2);color:var(--muted)}
.badge.ai{background:var(--card-2);color:var(--foreground)}
```

**② 状态徽章加图标**：找到 `jobStatusBadge()`（约 1001 行）与所有输出 `.badge ok` / `.badge warn` / `.badge err` / `.badge` 的模板位置，把形如

```javascript
`<span class="badge ok">可投递</span>`
```

改为

```javascript
`<span class="badge ok">${icon('circle-check', 11)}可投递</span>`
```

对应关系：`ok → circle-check` / `warn → circle-alert` / `err → circle-x` / 无状态 → `circle-help`。

**③ 清除状态 emoji**：把 server.mjs 模板里作为状态标记的 `⚠️` `❌` `✅` `⚪` `🟡` `🔴` 全部换成对应徽章或 `icon()` 调用。

> ⚠️ 这一步是 257 处替换里最容易出错的部分。**只替换状态标记与功能图标**：
> - **不要碰 `docs/*.html`** —— 那是用户的真实简历数据（实测两份简历正文里各有 3 个 emoji：💾📄🕘，
>   属用户内容，不是 UI）。断言检查范围只有 5 个源码文件，天然不含 docs/，但手改时别越界。
> - 不要碰 `docToText`/`extract.mjs` 的文本处理路径（那里的 emoji 是数据，不是 UI）
> - **不要碰代码注释里的 emoji** —— `2026-10-19 审查 ⚪-6`、`⚠️ 计数器必须在模块级` 这类是**安全审计记录**，
>   清理掉等于毁掉审查痕迹。断言已按「剥注释后检查」实现，不会误报它们。

- [ ] **Step 3.4: 跑测试确认绿**

```bash
cd /Users/xxxly/resume && bash test-structure.sh > /tmp/s.log 2>&1; echo "exit=$?"; grep -c "✅" /tmp/s.log; grep "UI-3" /tmp/s.log
```

Expected: `exit=0`，✅ 数 = **98**

- [ ] **Step 3.5: 跑主套件确认无回归**

```bash
cd /Users/xxxly/resume && bash test.sh > /tmp/t.log 2>&1; echo "exit=$?"; grep -c "✅" /tmp/t.log
```

Expected: `exit=0`，✅ 数 = **339**（若减少说明替换破坏了功能，**回退本 Task**）

- [ ] **Step 3.6: 提交**

```bash
cd /Users/xxxly/resume && git add server.mjs test-structure.sh && git commit -m "feat(ui): 批次A — 状态徽章图标化

徽章从「裸 emoji + 胶囊」改为「底色 + 语义色 + 小图标 + 文字」四件套：
  ok→circle-check  warn→circle-alert  err→circle-x  mute→circle-help
颜色不单独承载语义（WCAG color-not-only）；--warning 前景 3.5:1 必须配图标+文字。
类名沿用既有 .badge ok/.warn/.err/.ai（43 处在用），只新增 .mute —— 不另起 badge--ok 体系。

清除 server.mjs 模板中的状态 emoji（⚠️❌✅⚪🟡🔴）。
只动 UI 标记，不碰 docToText/extract 的文本处理路径。

UI-3 断言 + test.sh 339 ✅ 回归。" && git log --oneline -1
```

---

## Task 4 · 导航 emoji → 图标（批次 B 前置）

**Files:**
- Modify: `server.mjs`（901 行 topnav 模板）
- Modify: `test-structure.sh`（追加 UI-4 组）

- [ ] **Step 4.1: 写失败断言（UI-4）**

```bash
python3 - << 'PYEOF'
import io
p = 'test-structure.sh'
s = io.open(p, encoding='utf-8').read()
add = '''
# —— UI-4：导航图标化（emoji 导航条）——
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('❌ UI-4 ' + m); process.exit(1); } };
const srv = readFileSync('./server.mjs', 'utf8');
// 五个导航项各配一个 Lucide 图标
for (const ic of ['file-text', 'box', 'columns-3', 'chart-bar', 'settings']) {
  assert(srv.includes("'" + ic + "'"), '导航应使用图标 ' + ic);
}
// 导航里不得再有 emoji
const navLine = (srv.match(/<nav class="topnav">[\s\S]*?<\/nav>/) || [''])[0];
const hits = ['📄','🧱','📋','📊','⚙️'].filter(e => navLine.includes(e));
assert(hits.length === 0, '导航条仍含 emoji: ' + hits.join(' '));
// 导航项必须同时有图标与文字（nav-label-icon）
assert(/<svg/.test(navLine), '导航应含内联 SVG');
console.log('✅ UI-4 导航图标化');
EOF
'''
assert 'UI-4：导航图标化' not in s
io.open(p, 'w', encoding='utf-8').write(s.rstrip('\n') + '\n' + add)
print('UI-4 断言已追加')
PYEOF
bash -n test-structure.sh
```

- [ ] **Step 4.2: 跑测试确认红**

Expected: `exit=1`，`❌ UI-4 导航条仍含 emoji: 📄 🧱 📋 📊 ⚙️`

- [ ] **Step 4.3: 写实现**

替换 901 行的 topnav 模板：

```javascript
<nav class="topnav"><a class="brand" href="/">${icon('file-text', 17)} 简历工作台</a><span class="links">${nav('docs', '/', '文档', 'file-text')}${nav('materials', '/materials', '素材库', 'box')}${nav('apps', '/applications', '投递看板', 'columns-3')}${nav('stats', '/stats', '复盘', 'chart-bar')}${nav('settings', '/settings', '设置', 'settings')}</span></nav>
```

`nav()` helper（约 899 行）加第 4 个参数 `ic`：

```javascript
const nav = (key, href, label, ic) => `<a href="${href}" class="${active === key ? 'on' : ''}">${ic ? icon(ic, 15) : ''}${label}</a>`;
```

同时加 CSS（紧跟 `.topnav .links a` 之后）：

```javascript
.topnav .links a{display:inline-flex;align-items:center;gap:5px;margin-left:16px;color:var(--mut);font-weight:600}
.topnav .links a svg{width:15px;height:15px;flex:none}
.topnav .brand{display:inline-flex;align-items:center;gap:6px}
```

- [ ] **Step 4.4: 跑测试确认绿 + 主套件**

```bash
cd /Users/xxxly/resume && bash test-structure.sh > /tmp/s.log 2>&1; echo "structure=$?"; grep -c "✅" /tmp/s.log
bash test.sh > /tmp/t.log 2>&1; echo "main=$?"; grep -c "✅" /tmp/t.log
```

Expected: structure `exit=0` ✅=**99**；main `exit=0` ✅=**339**

- [ ] **Step 4.5: 提交**

```bash
cd /Users/xxxly/resume && git add server.mjs test-structure.sh && git commit -m "feat(ui): 导航图标化 — emoji 导航条 → Lucide 图标 + 文字

五个导航项各配一个图标（file-text/box/columns-3/chart-bar/settings），
导航项同时有图标与文字（WCAG nav-label-icon）。nav() 加第 4 参数 ic。

UI-4 断言 + test.sh 339 ✅。" && git log --oneline -1
```

---

## Task 5 · 首页侧栏 + 内容区（批次 B）

**Files:**
- Modify: `server.mjs`（`listPage()` 957–1349；hero 1066 起；statusline；doclist）
- Modify: `test-structure.sh`（追加 UI-5 组）

- [ ] **Step 5.1: 写失败断言（UI-5）**

```bash
python3 - << 'PYEOF'
import io
p = 'test-structure.sh'
s = io.open(p, encoding='utf-8').read()
add = '''
# —— UI-5：首页侧栏 + 内容区（批次B）——
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('❌ UI-5 ' + m); process.exit(1); } };
const srv = readFileSync('./server.mjs', 'utf8');
assert(/class="sidenav"/.test(srv), '应有侧栏 .sidenav');
assert(/class="mainarea"/.test(srv), '应有内容区 .mainarea');
// 侧栏含五个导航入口
const side = (srv.match(/<aside class="sidenav">[\s\S]*?<\/aside>/) || [''])[0];
for (const t of ['文档', '素材库', '投递看板', '复盘', '设置']) {
  assert(side.includes(t), '侧栏应含入口: ' + t);
}
// 侧栏必须由 page() 渲染（第三参数 active 即当前页 key），而不是 listPage()——
// listPage() 拿不到 active，无法做当前项高亮。断言侧栏模板与 page() 的 active 参数同处一个函数体。
assert(/function page\([^)]*active/.test(srv), 'page() 应保留 active 参数（侧栏高亮依赖它）');
// 统计块：原 statusline 横条拆成独立统计块
assert(/class="stat-grid"/.test(srv), '首页应有统计块区 .stat-grid');
assert((srv.match(/class="stat"/g) || []).length >= 3, '至少 3 个统计块');
// 旧 hero 保留但不再独占首屏（内容区有 H1）
assert(/<h1[^>]*>文档<\/h1>/.test(srv) || /class="mainarea"[\s\S]{0,400}<h1/.test(srv), '内容区应有 H1');
console.log('✅ UI-5 首页侧栏 + 内容区');
EOF
'''
assert 'UI-5：首页侧栏' not in s
io.open(p, 'w', encoding='utf-8').write(s.rstrip('\n') + '\n' + add)
print('UI-5 断言已追加')
PYEOF
bash -n test-structure.sh
```

- [ ] **Step 5.2: 跑测试确认红**

Expected: `exit=1`，`❌ UI-5 首页应有侧栏 .sidenav`

- [ ] **Step 5.3: 写实现**

**① 加 CSS**（放在 `.topnav` 相关样式之后）：

```javascript
/* 首页侧栏 + 内容区（批次B）
   body 的 max-width:1100px 会把「侧栏+内容」压扁 → .home 自身定宽居中，
   body 保持不限宽（下面 body 规则同步放宽）。 */
.home{display:grid;grid-template-columns:200px minmax(0,1fr);gap:24px;align-items:start;margin:16px auto 40px;max-width:1400px}
.sidenav{position:sticky;top:76px;border-right:1px solid var(--border);padding-right:16px;min-height:320px}
.sidenav .side-brand{display:flex;align-items:center;gap:7px;font-weight:700;font-size:15px;margin-bottom:14px;color:var(--foreground)}
.sidenav .side-brand svg{width:17px;height:17px}
.sidenav a{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:var(--radius);color:var(--muted);font-weight:500;font-size:13px;text-decoration:none;margin-bottom:2px}
.sidenav a svg{width:15px;height:15px;flex:none}
.sidenav a:hover{background:var(--card-2);color:var(--foreground)}
.sidenav a.on{background:var(--card-2);color:var(--foreground);font-weight:600}
.mainarea{min-width:0}
.mainarea h1{font-size:20px;font-weight:700;letter-spacing:-.01em;margin:0 0 4px}
.mainarea .sub{color:var(--muted);font-size:13px;margin:0 0 16px}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px;margin:0 0 18px}
.stat{border:1px solid var(--border);border-radius:var(--radius-lg);padding:11px 12px;background:var(--card)}
.stat b{display:block;font-size:19px;line-height:1.2;font-weight:600}
.stat span{font-size:11px;color:var(--muted)}
@media (max-width:860px){.home{grid-template-columns:1fr}.sidenav{position:static;border-right:0;border-bottom:1px solid var(--border);padding:0 0 10px;min-height:0}.sidenav a{display:inline-flex;margin-right:4px}}
```

**② 侧栏渲染在 `page()` 里（不是 `listPage()`）** —— `page(title, inner, active='')` 的**第三参数 `active` 就是当前导航 key**（现有 `nav()` helper 已在用它做高亮）。放在 `page()` 里才能拿到 `active`；放在 `listPage()` 里拿不到，高亮无从谈起。

**顺带的好处：全站统一侧栏**（不只首页）—— 这才是「统一设计语言」，也只需改一处。

在 `page()` 的返回模板里，把 `${inner}` 换成：

```javascript
  const side = `<aside class="sidenav">
    <div class="side-brand">${icon('file-text', 17)}简历工作台</div>
    <a href="/" class="${active === 'docs' ? 'on' : ''}">${icon('file-text', 15)}文档</a>
    <a href="/materials" class="${active === 'materials' ? 'on' : ''}">${icon('box', 15)}素材库</a>
    <a href="/applications" class="${active === 'apps' ? 'on' : ''}">${icon('columns-3', 15)}投递看板</a>
    <a href="/stats" class="${active === 'stats' ? 'on' : ''}">${icon('chart-bar', 15)}复盘</a>
    <a href="/settings" class="${active === 'settings' ? 'on' : ''}">${icon('settings', 15)}设置</a>
  </aside>`;
```

模板结构（替换 901–902 行之间的 `${inner}`）：

```javascript
<nav class="topnav">…</nav>
<div class="home">${side}<div class="mainarea">${inner}</div></div>
```

**注意**：`body{max-width:1100px}` 是页面总宽。加侧栏后总宽需放宽，否则侧栏+内容被压扁。CSS 里把 `body` 改为 `max-width:1440px`（`body.wide` 已是 `min(1440px,100%)`），或给 `.home` 设 `max-width:1400px;margin:0 auto` 并让 body 不限宽。**推荐后者**：body 保持不限宽，`.home` 自身定宽居中。

**各页面内容宽度**：`body` 原 `max-width:1100px` 居中，改动后 `.mainarea` 内的内容（如投递看板的宽表格）会变宽 —— 属预期，但要**浏览器实测各页面无破版**。

**③ 拆 statusline 为统计块**：原 `⚠️1份待结构化·⏰1份逾期·📋1份投递中·📑PDF已同步` 横条 → 4 个 `.stat`：

```javascript
  const statHtml = `<div class="stat-grid">
    <div class="stat"><b>${infos.length}</b><span>文档</span></div>
    <div class="stat"><b>${degradedCount}</b><span>待结构化</span></div>
    <div class="stat"><b>${activeApps}</b><span>投递中</span></div>
    <div class="stat"><b>${todoBits.length}</b><span>待办提醒</span></div>
  </div>`;
```

（变量名沿用现有：`infos` / `degradedCount` / `activeApps` / `todoBits` 已在 `listPage()` 内存在。）

- [ ] **Step 5.4: 跑测试确认绿 + 主套件**

Expected: structure `exit=0` ✅=**100**；main `exit=0` ✅=**339**

- [ ] **Step 5.5: 浏览器实测（必须，不能只靠断言）**

```bash
cd /Users/xxxly/resume && launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server" && sleep 3
```

然后用 Playwright 逐页检查（侧栏是**全站**的，五个页面都要看）：

`/`、`/materials`、`/applications`、`/stats`、`/settings` 各确认：
① 侧栏五项可见、**当前页高亮**（这是 `page()` 第三参数 active 的落点）
② 内容区正常、无破版、无横向滚动
③ 控制台零错误
④ 首页额外确认：H1 + 4 个统计块 + 文档列表
⑤ 窗口缩到 800px 宽：侧栏变顶部横条，不破版

- [ ] **Step 5.6: 提交**

```bash
cd /Users/xxxly/resume && git add server.mjs test-structure.sh && git commit -m "feat(ui): 批次B — 首页侧栏 + 内容区重排

原首页 7 个等宽 1060px 横条堆叠 → 侧栏(200px) + 内容区：
  侧栏：图标+文字五入口，当前项高亮，sticky
  内容区：H1 + 4 个统计块（文档/待结构化/投递中/待办提醒）+ 文档列表 + 操作
statusline 横条拆成独立统计块，信息层级与优先级可见。
<860px 侧栏变顶部横条。

UI-5 断言 + 浏览器实测（侧栏/统计块/响应式/零控制台错误）。" && git log --oneline -1
```

---

## Task 6 · 编辑器可拖拽分栏（批次 C）

**Files:**
- Modify: `server.mjs`（编辑器页模板：加拖柄 DOM + 脚本）
- Modify: `editor-shell.js`（Pointer Events 逻辑）
- Modify: `test-editor.mjs`（追加拖拽用例）

- [ ] **Step 6.1: 写失败断言（UI-6，结构层）**

```bash
python3 - << 'PYEOF'
import io
p = 'test-structure.sh'
s = io.open(p, encoding='utf-8').read()
add = '''
# —— UI-6：编辑器可拖拽分栏（结构层，浏览器行为见 test-editor.mjs）——
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('❌ UI-6 ' + m); process.exit(1); } };
const srv = readFileSync('./server.mjs', 'utf8');
const sh = readFileSync('./editor-shell.js', 'utf8');
// 拖柄 DOM 与 CSS 都必须由【注入层】创建 —— 编辑器页 HTML 就是 docs/*.html（用户数据），
// server.mjs 不生成它。注入层可覆盖文档内联样式（test-editor.mjs:1879 已验证
// 「.ed-on 特异性压过文档内联 chrome」），故覆盖方案成立。
assert(/ed-grip/.test(sh), 'editor-shell.js 注入层应创建拖柄 #ed-grip（编辑器页 HTML 是数据文件，不能改）');
assert(!/ed-grip/.test(srv), 'server.mjs 不该出现 ed-grip（编辑器页不由 server.mjs 生成）');
assert(/pointerdown/.test(sh) && /pointermove/.test(sh), '拖拽须用 Pointer Events（非 HTML5 DnD）');
assert(/--ed-right-w/.test(sh), '拖拽须写 --ed-right-w（该变量已存在但 CSS 从未消费）');
assert(/ed-right-w/.test(sh), '注入层 CSS 须消费 --ed-right-w（覆盖式，body.ed-on 提高特异性）');
assert(/ed-grip/.test(sh), '拖柄 DOM 须由注入层创建');
assert(/localStorage/.test(sh), '宽度须持久化到 localStorage');
// 键盘可达（WCAG dragging-alternative）
assert(/keydown/.test(sh) && /ArrowLeft|ArrowRight/.test(sh), '拖柄须支持方向键调节');
console.log('✅ UI-6 可拖拽分栏（结构层）');
EOF
'''
assert 'UI-6：编辑器可拖拽分栏' not in s
io.open(p, 'w', encoding='utf-8').write(s.rstrip('\n') + '\n' + add)
print('UI-6 断言已追加')
PYEOF
bash -n test-structure.sh
```

- [ ] **Step 6.2: 跑测试确认红**

Expected: `exit=1`，`❌ UI-6 编辑器页应有拖柄 #ed-grip`

- [ ] **Step 6.3: 写实现**

**① editor-shell.js：注入层创建拖柄 DOM + 覆盖式 CSS + 拖拽逻辑**

**关键事实（2026-10-21 实测）**：编辑器页 HTML **就是 `docs/*.html`（用户数据文件）**，server.mjs 不生成它。页面上的 `data-ed-shell` style 是**注入层运行时动态创建**的（源码里搜不到字面量，因为 CSS 是压缩变量串）。

因此：
- 拖柄 DOM **不能**加在 server.mjs 的模板里（那里没有编辑器页）
- 必须由注入层 `createElement` + `insertAdjacentHTML` 挂进 DOM
- CSS 覆盖走**更高特异性**（`body.ed-on #ed-grip` / `body.ed-on #ed-right`）——
  `test-editor.mjs:1879` 已实测验证「`.ed-on` 特异性压过文档内联 chrome」

**注入层实现**（追加到 `editor-shell.js` 末尾的 IIFE 内，或作为独立 IIFE）：

```javascript
// 可拖拽分栏（2026-10-21 批次C）：右栏宽度写 --ed-right-w。
// 【为什么在注入层做】编辑器页 HTML 就是 docs/*.html（用户数据），server.mjs 不生成它；
//   注入层可用更高特异性覆盖文档内联样式（test-editor.mjs:1879 已验证 .ed-on 压过文档 chrome）。
// 用 Pointer Events 而非 HTML5 DnD：后者无法接管既有光标语义，Safari 上也不稳。
(function () {
  if (!document.body.classList.contains('ed-on')) return;   // 只在编辑器页启用
  var right = document.getElementById('ed-right');
  if (!right || document.getElementById('ed-grip')) return; // 已存在则不重复注入
  var KEY = 'resume.ed.rightW', MIN = 260, MAX = 460, DEFAULT = 300;
  var body = document.body;

  // ① 拖柄 DOM：插在右栏之前
  var grip = document.createElement('div');
  grip.id = 'ed-grip';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('tabindex', '0');
  grip.setAttribute('aria-label', '调整右侧面板宽度');
  grip.title = '拖动调整宽度，双击复位';
  right.parentNode.insertBefore(grip, right);

  // ② 覆盖式 CSS（body.ed-on 提高特异性，压过文档内联 chrome）
  var st = document.createElement('style');
  st.setAttribute('data-ed-grip', '1');
  st.textContent = 'body.ed-on #ed-grip{width:6px;flex:0 0 6px;align-self:stretch;cursor:col-resize;background:transparent;border-radius:3px;margin:0 1px;transition:background .12s}'
    + 'body.ed-on #ed-grip:hover,body.ed-on #ed-grip:focus-visible{background:var(--ed-line,#DED3C0)}'
    + 'body.ed-on #ed-grip:focus-visible{outline:2px solid var(--ed-accent,#C2410C);outline-offset:-1px}'
    + 'body.ed-on #ed-right{width:var(--ed-right-w,300px);flex:0 0 var(--ed-right-w,300px);min-width:0}'
    + '@media (max-width:767px){body.ed-on #ed-grip{display:none}body.ed-on #ed-right{position:absolute;right:0;top:0;bottom:0;width:min(88vw,360px);background:var(--ed-bg,#F0EBE2);border-left:1px solid var(--ed-line,#DED3C0);z-index:40}}';
  document.head.appendChild(st);

  // ③ 宽度应用与持久化
  var apply = function (w) {
    w = Math.max(MIN, Math.min(MAX, Math.round(w)));
    body.style.setProperty('--ed-right-w', w + 'px');
    return w;
  };
  var saved = Number(localStorage.getItem(KEY) || 0);
  if (saved >= MIN && saved <= MAX) apply(saved);

  // ④ 拖拽
  var dragging = false, startX = 0, startW = 0;
  grip.addEventListener('pointerdown', function (e) {
    if (window.innerWidth < 768) return;         // 窄屏是抽屉，不拖
    dragging = true; startX = e.clientX;
    startW = right.getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    apply(startW - (e.clientX - startX));        // 往左拖 → 面板变宽
  });
  var end = function (e) {
    if (!dragging) return;
    dragging = false;
    try { grip.releasePointerCapture(e.pointerId); } catch {}
    var w = Number((body.style.getPropertyValue('--ed-right-w') || '').replace('px', ''));
    if (w) localStorage.setItem(KEY, String(w));
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', function () { apply(DEFAULT); localStorage.setItem(KEY, String(DEFAULT)); });

  // ⑤ 键盘可达（WCAG dragging-alternative）：←/→ 每次 16px，Home 复位
  grip.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      var cur = Number((body.style.getPropertyValue('--ed-right-w') || DEFAULT).replace('px', '')) || DEFAULT;
      apply(cur + (e.key === 'ArrowLeft' ? 16 : -16));
      localStorage.setItem(KEY, String(Number((body.style.getPropertyValue('--ed-right-w') || '').replace('px', ''))));
      e.preventDefault();
    } else if (e.key === 'Home') {
      apply(DEFAULT); localStorage.setItem(KEY, String(DEFAULT)); e.preventDefault();
    }
  });
})();
```

**注意**：`--ed-right-w` 早由 `ai-panel.js:181` 设置（窄屏时置 `0px`），本实现与之共用同一变量——窄屏时 ai-panel 会置 0，本实现因 `window.innerWidth < 768` 直接 return 不抢，最终仍由 ai-panel 控制抽屉行为。**不新增变量。**

**实测补充（2026-10-21）**：服务端返回的编辑器页 HTML 里**只有 1 个 style 块**（`data-style-origin="legacy-inline"`，即数据文件里的），**没有任何 `#ed-right` 宽度规则**。编辑器 chrome 的全部 CSS 都在注入层运行时动态创建（源码里 grep 不到字面量，因为 CSS 是压缩变量串）。所以覆盖点只能在注入层，且要用 `body.ed-on` 前缀提高特异性——`test-editor.mjs:1879` 已实测验证「`.ed-on` 特异性压过文档内联 chrome」这条路可行。

```javascript
// 可拖拽分栏（2026-10-21 批次C）：右栏宽度写 --ed-right-w。
// 用 Pointer Events 而非 HTML5 DnD：后者无法接管既有光标语义，且在 Safari 上不稳。
(function () {
  var grip = document.getElementById('ed-grip');
  if (!grip) return;
  var KEY = 'resume.ed.rightW';
  var MIN = 260, MAX = 460, DEFAULT = 300;
  var body = document.body;
  var apply = function (w) {
    w = Math.max(MIN, Math.min(MAX, Math.round(w)));
    body.style.setProperty('--ed-right-w', w + 'px');
    return w;
  };
  var saved = Number(localStorage.getItem(KEY) || 0);
  if (saved >= MIN && saved <= MAX) apply(saved);

  var dragging = false, startX = 0, startW = 0;
  grip.addEventListener('pointerdown', function (e) {
    if (window.innerWidth < 768) return;         // 窄屏是抽屉，不拖
    dragging = true; startX = e.clientX;
    startW = document.getElementById('ed-right').getBoundingClientRect().width;
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var w = apply(startW - (e.clientX - startX));  // 往左拖 → 面板变宽
  });
  var end = function (e) {
    if (!dragging) return;
    dragging = false;
    try { grip.releasePointerCapture(e.pointerId); } catch {}
    var w = Number((body.style.getPropertyValue('--ed-right-w') || '').replace('px', ''));
    if (w) localStorage.setItem(KEY, String(w));
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', function () {
    apply(DEFAULT);
    localStorage.setItem(KEY, String(DEFAULT));
  });
  // 键盘可达（WCAG dragging-alternative）：←/→ 每次 16px，Home 复位
  grip.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      var cur = Number((body.style.getPropertyValue('--ed-right-w') || DEFAULT).replace('px', '')) || DEFAULT;
      apply(cur + (e.key === 'ArrowLeft' ? 16 : -16));
      localStorage.setItem(KEY, String(Number((body.style.getPropertyValue('--ed-right-w') || '').replace('px', ''))));
      e.preventDefault();
    } else if (e.key === 'Home') {
      apply(DEFAULT); localStorage.setItem(KEY, String(DEFAULT)); e.preventDefault();
    }
  });
})();
```

- [ ] **Step 6.4: 跑测试确认绿 + 主套件**

Expected: structure `exit=0` ✅=**101**；main `exit=0` ✅=**339**

- [ ] **Step 6.5: 浏览器实测（必须）**

```bash
cd /Users/xxxly/resume && launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server" && sleep 3
```

打开 `http://localhost:7766/edit?id=linghaoxiang`，确认：
① 拖柄可见，鼠标按住拖动时右栏宽度变化、正文相应收放
② 松手后刷新页面，宽度保持
③ 双击拖柄 → 回到 300px
④ 聚焦拖柄按 `←` → 右栏变宽 16px
⑤ 窗口缩到 767px 以下 → 右栏变抽屉、拖柄隐藏
⑥ 控制台零错误

- [ ] **Step 6.6: 跑浏览器级测试套件**

```bash
cd /Users/xxxly/resume && bash test.sh > /tmp/t.log 2>&1; echo "exit=$?"; grep -c "✅" /tmp/t.log
```

Expected: `exit=0`、✅ 数 = **339**。**浏览器级编辑器测试（`test-editor.mjs`）在 `test.sh` 内部被调用**
（`test.sh:1986` 带参），随 main 套件一起跑，**不需要单独执行**（少传参数会 exit=2）。

- [ ] **Step 6.7: 提交**

```bash
cd /Users/xxxly/resume && git add server.mjs editor-shell.js test-structure.sh && git commit -m "feat(ui): 批次C — 编辑器可拖拽分栏

现状：正文 794px(A4 纸宽，在数据文件里不动) + 右栏 300px 写死，中间空白浪费。
改法：注入层（editor-shell.js）创建 #ed-grip 拖柄 + 覆盖式 CSS（body.ed-on 提高特异性，
压过文档内联 chrome，test-editor.mjs:1879 已验证），Pointer Events 拖动写 --ed-right-w（260–460px）。
【关键】编辑器页 HTML 就是 docs/*.html（用户数据），server.mjs 不生成它 —— 拖柄不能加在 server.mjs 模板里。
  —— 该变量早由 ai-panel.js:181 设置但 CSS 从未消费，本次正好接上，不新增变量。
持久化 localStorage；双击复位 300px；←/→ 每次 16px、Home 复位（WCAG dragging-alternative）。
窄屏(<768px)右栏变抽屉、拖柄隐藏，沿用现有 ed-open/ed-hidden 机制。
.sheet 内部 A4 纸宽不动 → PDF 导出不受影响。

UI-6 结构断言 + 浏览器实测 + test-editor.mjs 全量回归。" && git log --oneline -1
```

---

## Task 7 · 剩余 emoji 批量替换（批次 D）

**Files:**
- Modify: `server.mjs` / `editor-shell.js` / `job-panel.js` / `zone-panel.js` / `ai-panel.js`
- Modify: `test-structure.sh`（追加 UI-7 组）

- [ ] **Step 7.1: 写失败断言（UI-7）**

```bash
python3 - << 'PYEOF'
import io
p = 'test-structure.sh'
s = io.open(p, encoding='utf-8').read()
add = '''
# —— UI-7：前端源码无 emoji 残留（批次D 收尾）——
node --input-type=module << 'EOF'
import { readFileSync } from 'node:fs';
const assert = (c, m) => { if (!c) { console.error('❌ UI-7 ' + m); process.exit(1); } };
// UI 层的 emoji 必须清零（数据层的正文文本不在此列）
const UI_EMOJI = ['📄','🧱','📋','📊','⚙️','🤖','💡','🎯','✨','👋','💬','🩺','📍','🎨','✏️','🗑','➕','💾','📌','🏷','🔗','☰','✕','📅','🔁','🏠','📜','📦','🗄','🧭','✎','⛔','🟡','🔴','⚪','✅','❌','⚠️'];
// 剥掉注释再查：注释里的 emoji 是安全审查记录（⚪-6 / 🟡-1 / 🔴-1），
// 属于审计痕迹，**不得清理**。只要求 UI 层（代码与模板字符串）零 emoji。
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, '')).join('\n');
for (const f of ['server.mjs','editor-shell.js','job-panel.js','zone-panel.js','ai-panel.js']) {
  const code = stripComments(readFileSync('./' + f, 'utf8'));
  const hits = UI_EMOJI.filter(e => code.includes(e));
  assert(hits.length === 0, f + ' 代码/模板中仍含 emoji: ' + hits.join(' '));
}
console.log('✅ UI-7 前端源码无 emoji 残留');
EOF
'''
assert 'UI-7：前端源码无 emoji' not in s
io.open(p, 'w', encoding='utf-8').write(s.rstrip('\n') + '\n' + add)
print('UI-7 断言已追加')
PYEOF
bash -n test-structure.sh
```

- [ ] **Step 7.2: 跑测试确认红**，记录哪些文件还剩哪些 emoji：

```bash
cd /Users/xxxly/resume && bash test-structure.sh > /tmp/s.log 2>&1; grep "UI-7" /tmp/s.log
```

- [ ] **Step 7.3: 逐处替换**

按设计文档 §4.2 映射表替换。**注意**：
- `docToText`/`extract.mjs` 里的 emoji 属数据处理，**不动**
- 正文模板里的用户数据不动
- 只改 UI 标记位置

替换后逐文件复查：

```bash
cd /Users/xxxly/resume && for f in server.mjs editor-shell.js job-panel.js zone-panel.js ai-panel.js; do
  n=$(grep -oE "[📄🧱📋📊⚙️🤖💡🎯✨👋💬🩺📍🎨✏️🗑➕💾📌🏷🔗☰✕📅🔁🏠📜📦🗄🧭✎⛔🟡🔴⚪✅❌⚠️]" "$f" | wc -l | tr -d ' ')
  echo "  $f 剩余 emoji: $n"
done
```

- [ ] **Step 7.4: 跑测试确认绿 + 主套件 + 浏览器套件**

Expected: structure `exit=0` ✅=**102**；main `exit=0` ✅=**339**；`node test-editor.mjs` exit=0

- [ ] **Step 7.5: 提交**

```bash
cd /Users/xxxly/resume && git add -A && git commit -m "feat(ui): 批次D — 剩余 emoji 批量替换

按设计文档 §4.2 映射表把 5 个前端文件的 UI 层 emoji 全换成 Lucide 图标/语义徽章。
只动 UI 标记，不碰 docToText/extract 的文本处理路径（那里的 emoji 是数据不是 UI）。

UI-7 断言：5 个前端源码零 emoji 残留。" && git log --oneline -1
```

---

## Task 8 · 终检与收尾

**Files:**
- Modify: `dev-docs/handoff.md`

- [ ] **Step 8.1: 冻结件终检**

```bash
cd /Users/xxxly/resume && git diff --stat bbbad60 -- template.html themes/ render.mjs
```

Expected: **空输出**

- [ ] **Step 8.2: 依赖终检**

```bash
cd /Users/xxxly/resume && node -e "const p=require('./package.json');console.log('dependencies:',Object.keys(p.dependencies||{}).join(', '))"
```

Expected: `dependencies: playwright-core`（**只有这一个**）

- [ ] **Step 8.3: 四件套全跑**

```bash
cd /Users/xxxly/resume
bash test-structure.sh > /tmp/f-s.log 2>&1; echo "structure=$?  ✅=$(grep -c '✅' /tmp/f-s.log)"
bash test-render.sh    > /tmp/f-r.log 2>&1; echo "render=$?"
bash privacy-check.sh  > /tmp/f-p.log 2>&1; echo "privacy=$?"
bash test.sh           > /tmp/f-t.log 2>&1; echo "main=$?  ✅=$(grep -c '✅' /tmp/f-t.log)"
```

Expected: 全部 exit=0；structure ✅=**102**；main ✅=**339**
> 注：`test-editor.mjs`（浏览器级编辑器测试）**在 test.sh 内部被调用**（`test.sh:1986` 带参），
> 随 main 套件一起跑，**不需要单独执行**。它需要 `<baseURL> <docId> <dataRoot>` 三个参数，
> 少传会 exit=2 打印用法。

- [ ] **Step 8.4: 浏览器最终实测**

```bash
cd /Users/xxxly/resume && launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server" && sleep 3
```

逐页检查 `/`、`/edit?id=linghaoxiang`、`/materials`、`/applications`、`/stats`、`/settings`：无 emoji 图标残留、无控制台错误、侧栏/拖柄工作正常、设置页「思考程度」下拉仍可见。

- [ ] **Step 8.5: 登记 handoff**

在 `dev-docs/handoff.md` 末尾追加：

```markdown
## UI 重设计交付快照（2026-10-21）

- 路线 A：零构建 + 借鉴设计系统。**新增 npm 依赖 0**（`package.json` 仍只有 playwright-core）。
- 浅色克制 token（主行动近黑不用蓝、彩色只承载状态、`--shadow:none` 靠边框）+ 旧名别名（既有 CSS 零改动生效）。
- 图标：一次性从 lucide-react v0.468.0（ISC）提取 44 个 path → `vendors/icons.mjs`（约 8 KB 纯数据）。
  提取脚本 `scripts/extract-icons.mjs` 可重现（改 `scripts/icons.list.json` 重跑）。
  2026-10-21 ocr 审查修正：不再执行源文本（JSON 规范化 + JSON.parse）、清单单一来源、
  版本动态读、属性名/元素名白名单、ISC 版权声明补齐。
- 徽章四件套（底色+语义色+小图标+文字），颜色不单独承载语义（WCAG color-not-only）。
- 首页侧栏+内容区（860px 以下侧栏变顶部横条）；编辑器可拖拽分栏（`--ed-right-w` 260–460px，
  双击复位、←/→ 16px、localStorage 持久化、窄屏抽屉）。
- 冻结件 `template.html` / `themes/` / `render.mjs` 零改动。
- 测试基线：test-structure 102 ✅（原 115 → +7 组 UI 断言）/ test.sh 339 ✅ / test-editor.mjs 通过。
- 设计文档 `dev-docs/2026-10-21-ui-redesign-design.md`，实施计划 `dev-docs/2026-10-21-ui-redesign-plan.md`。
```

- [ ] **Step 8.6: 提交**

```bash
cd /Users/xxxly/resume && git add dev-docs/handoff.md && git commit -m "docs: UI 重设计交付快照（2026-10-21）

零依赖、浅色克制 token、Lucide 图标数据化、状态徽章图标化、
首页侧栏重排、编辑器可拖拽分栏。冻结件零改动。
测试：test-structure 102 ✅ / test.sh 339 ✅ / test-editor.mjs 通过。" && git log --oneline -1
```

---

## Self-Review

**Spec 覆盖核对**（设计文档 → 任务）：

| 设计文档章节 | 对应任务 |
|---|---|
| §3.1 token 表 | Task 2 |
| §3.3 对比度基线 | Task 2（token 值）+ Task 3（徽章） |
| §4.1 图标落地方式 | Task 1 |
| §4.2 emoji 映射表 | Task 3（徽章）+ Task 4（导航）+ Task 7（其余） |
| §4.3 徽章规范 | Task 3 |
| §5.1 首页侧栏 | Task 5 |
| §5.2 编辑器可拖拽 | Task 6 |
| §6 文件清单 | Task 1–7 逐一对应 |
| §7.1 UI-1…UI-5 断言 | Task 1（UI-1）、2（UI-2）、3（UI-3）、4（UI-4）、5（UI-5）、6（UI-6）、7（UI-7） |
| §7.2 拖拽浏览器用例 | Task 6 Step 6.5/6.6 |
| §8 明确不做 | 无任务（范围控制） |
| §9 风险 | 各 Task 的纪律段 + Task 8 终检 |
| §10 实施批次 | Task 1–3 = A，Task 4–5 = B，Task 6 = C，Task 7–8 = D |

✅ 无缺口。

**Placeholder 扫描**：无 TBD / TODO / 「类似 Task N」/无代码的代码步骤。唯一带「找到 xxx 位置」的是 Task 3.3 的状态徽章替换（257 处逐点替换，无法穷举列出），但给出了**确定的映射关系 + 明确的代码形态 + 明确的禁改路径**，且 Task 3.4 有主套件回归兜底。

**类型/命名一致性**：
- `icon(name, size, cls)` —— Task 2 定义，Task 3/4/5 调用，签名一致
- `ICONS` —— Task 1 导出，Task 2 使用，命名一致
- `--ed-right-w` —— Task 6 定义 CSS 消费，editor-shell.js 写入，ai-panel.js 已有设置，命名一致
- `.badge ok/warn/err/ai/mute`（沿用既有命名，只新增 mute）—— Task 3 定义并使用，UI-3 断言校验，一致
- `.sidenav` / `.mainarea` / `.stat-grid` / `.stat` —— Task 5 定义并使用，UI-5 断言校验，一致
- localStorage key `resume.ed.rightW` —— Task 6 定义与读写，一致

✅ 无命名漂移。
