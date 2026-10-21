# UI 重设计：零构建 + 浅色克制设计系统

> 日期：2026-10-21 · 状态：**设计已与用户确认，待评审后出 plan** · 范围：视觉语言 + 图标体系 + 首页/编辑器布局
> 决策来源：brainstorming 四轮（路线 → 视觉方向 → 落地细节 → 布局）

---

## 1. 目标与硬约束

### 1.1 用户诉求

「网页设计太过丑和 AI 化了」。要求：复用成熟库、组件源代码可控、统一设计语言、严格限制重复依赖。

### 1.2 项目硬约束（决定了技术选型）

| 约束 | 事实 | 对选型的影响 |
|---|---|---|
| `docs/*.html` 是**数据文件** | contenteditable 直接编辑、随 `/save` 落盘 | React 接管 DOM 会与直接编辑冲突 |
| 快照要**自包含可独立渲染** | 冻结的是 HTML+CSS 全文 | React 构建产物做不到 |
| **零构建**、零依赖 | 仅 `playwright-core`，`scripts: {test}` | 引入 React/Vite = 引入构建链 |
| 未来并入 **Mac 桌面版** | 纯静态资源最好搬 | 构建链增加移植负担 |
| 冻结件 | `template.html` / `themes/` / `render.mjs` 不可动 | 设计只能在注入层与服务端 CSS 落地 |
| 注入层不能写进正文 | `/save` 有剥离清单 | 所有 UI 改动必须是「注入层」或「服务端模板」 |

### 1.3 诊断：AI 味的真实来源（实测，非印象）

| 症状 | 实测数据 |
|---|---|
| **emoji 当图标** | **42 种 / 257 处**。其中 `⚠️` 111 次、`❌` 29 次、`✅`+`✓` 28 次 |
| 硬编码颜色 | 仅 18 种 —— **不是问题**（已有 A-VARS token 体系） |
| 动画 | 仅 3 条 transition、0 个 keyframes —— 偏少但不是 AI 味主因 |
| 布局写死 | 编辑器正文 794px + 右栏 300px 固定，**无任何可调空间**；中间 96px 空白浪费 |
| 首页结构 | 7 个等宽 1060px 横条堆叠，信息密度低、层级弱；仅 1 个 H1 |

**结论**：AI 味主要来自 **emoji 图标层**（占视觉噪声 90%+），次要是**布局写死**。配色不是主要问题。

---

## 2. 四个已确认决策

| # | 决策 | 依据 |
|---|---|---|
| 1 | **路线 A：零构建 + 借鉴设计系统** | 与全部硬约束兼容；新增 npm 依赖 0 |
| 2 | **视觉方向 B：浅色克制（shadcn 风）** | 主行动用近黑不用蓝；彩色只留给状态；`--shadow: none` 靠边框不靠阴影 |
| 3 | **首页：侧栏 + 内容区** | 5 个导航入口从「挤在横条」变成有存在感的侧栏；shadcn 标准范式 |
| 4 | **编辑器：可拖拽双栏** | 现状写死；项目**自己已确认无拖拽调节**（`test-editor.mjs:2598` 原文注释）；左栏 `ed-left` 已是文档结构目录，故不引入第三栏 |

### 2.1 灵感来源：allan.xin（优设美地）

抓到的设计语言：深色优先 `--paper #151515` / `--surface #232323`、单一强调色 `--accent #335cff`、**硬编码颜色 0（全 token 化）**、字体 `Geist + PingFang SC`、缓动 `cubic-bezier(.2,.75,.25,1)`。

**借鉴其中三条**（不抄配色）：① 全 token 化 ② 单一强调色 ③ Geist + 中文回退的字体栈。

---

## 3. 设计语言：token 表

### 3.1 替换现有 A-VARS

新 token **同名覆盖**（改动集中在一处）。现有 `themes/` 目录是**简历正文**主题（冻结件），与本 token 无关。

```css
:root{
  --background:#ffffff;  --foreground:#0a0a0a;
  --muted:#737373;       --muted-2:#a1a1aa;
  --card:#ffffff;        --card-2:#fafafa;
  --border:#e5e5e5;
  --accent:#18181b;      --accent-fg:#ffffff;   /* 主行动=近黑 */
  --success:#16a34a;     --success-bg:#f0fdf4;
  --warning:#d97706;     --warning-bg:#fffbeb;
  --danger:#dc2626;      --danger-bg:#fef2f2;
  --radius:4px;          --radius-lg:6px;
  --shadow:none;         /* 靠边框不靠阴影 */
  --font:"Geist",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  --font-mono:"Geist Mono",ui-monospace,Menlo,monospace;
}
```

### 3.2 关键原则

| 原则 | 说明 |
|---|---|
| **主行动用近黑** | 彩色只承载**状态**，不用在按钮上 → 页面不被强调色污染 |
| **零阴影** | 层级靠 1px 边框 + 背景差（`--card` vs `--card-2` vs `--background`）表达 |
| **圆角 4/6px** | 比现有 8/12px 更克制；徽章例外（99px 胶囊） |
| **语义 token 唯一来源** | 组件里不出现裸 hex |
| **深色模式不在本轮** | 一次性做完双主题是范围膨胀；token 结构为将来留位（`--card`/`--muted` 已成对） |

### 3.3 对比度基线（WCAG AA）

| 组合 | 比值 | 判定 |
|---|---|---|
| `--foreground` #0a0a0a on `--background` #ffffff | 19.9:1 | ✅ AAA |
| `--muted` #737373 on #ffffff | 4.9:1 | ✅ AA（正文级） |
| `--muted-2` #a1a1aa on #ffffff | 2.6:1 | ⚠️ 仅占位/禁用，**不用于正文** |
| `--success` #16a34a on `--success-bg` #f0fdf4 | 4.6:1 | ✅ AA |
| `--warning` #d97706 on `--warning-bg` #fffbeb | 3.5:1 | ⚠️ 需配图标+文字，不单用 |
| `--danger` #dc2626 on `--danger-bg` #fef2f2 | 4.8:1 | ✅ AA |

---

## 4. 图标体系

### 4.1 落地方式：一次性提取 → 零依赖

```
lucide-react v0.468.0 (ISC 许可)
  → 提取 44 个图标的 path 数据（[["path",{d:"..."}],...]）
  → vendors/icons.mjs   （约 8 KB 纯数据，无任何 npm 依赖）
  → 服务端 icon(name, size) helper 输出内联 SVG（stroke:currentColor 跟随主题）
```

**为什么不是 CDN**：违反本地优先 + 离线不可用。
**为什么不是 npm 装 lucide**：装 `lucide` 是 React 包；`lucide-static` 的 SVG 资产需引入文件树，不如直接内联路径数据——**源码完全可读可改**（用户诉求：组件源代码可控）。

**可重现**：提取脚本随 commit 保留（`scripts/extract-icons.mjs`），换图标集时可重跑。

### 4.2 emoji → 图标映射（42 种全覆盖）

| emoji | 次数 | → Lucide | 用途 |
|---|---|---|---|
| 📄 | 2 | `file-text` | 导航·简历/文档 |
| 🧱 | 2 | `box` | 导航·素材库 |
| 📋 | 3 | `columns-3` | 导航·投递看板 |
| 📊 | 3 | `chart-bar` | 导航·复盘 |
| ⚙️ | 9 | `settings` | 导航·设置 |
| 🏠 | 1 | `house` | 首页 |
| 🗄 | 5 | `archive` | 归档 |
| 📦 | 1 | `package` | 打包/导出 |
| 📜 | 1 | `text-quote` | 文档/快照 |
| 🧭 | 2 | `compass` | 引导/流程 |
| 🤖 | 4 | `bot` | AI 面板 |
| 💡 | 1 | `lightbulb` | 提示 |
| 🎯 | 3 | `target` | 针对岗位 |
| ✨ | 2 | `sparkles` | 精修/生成 |
| 👋 | 2 | `hand` | 欢迎/引导 |
| 💬 | 1 | `message-square` | 对话 |
| 🩺 | 3 | `stethoscope` | 体检/诊断 |
| 📍 | 4 | `map-pin` | 位置 |
| 🎨 | 1 | `palette` | 区域/样式 |
| ✎ | 1 | `square-pen` | 编辑 |
| ✏️ | 3 | `pencil` | 编辑 |
| 🗑 | 3 | `trash-2` | 删除 |
| ➕ | 1 | `plus` | 新增 |
| 💾 | 1 | `save` | 保存 |
| 📌 | 2 | `pin` | 固定/锚定 |
| 🏷 | 1 | `tag` | 标签 |
| 🔗 | 1 | `link` | 链接 |
| ☰ | 2 | `menu` | 菜单 |
| ✕ | 2 | `x` | 关闭 |
| 📅 | 1 | `calendar` | 日程 |
| 🔁 | 1 | `refresh-cw` | 刷新/重生成 |
| 🗑/↩ | — | `undo-2` | 回滚 |
| ⛔ | 3 | `circle-slash` | 阻断/取消 |
| ❌ | 29 | → **状态徽章**（见 4.3） | 失败/冲突 |
| ✅ | 19 | → **状态徽章** | 完成/可投递 |
| ✓ | 9 | → **状态徽章** | 通过 |
| ⚠️ | 58 | → **状态徽章** | 警告/待补充 |
| ⚪ | 7 | → **状态徽章** | 待处理 |
| 🟡 | 6 | → **状态徽章** | 提示 |
| 🔴 | 1 | → **状态徽章** | 错误 |

> **全部 44 个 Lucide 名已逐个核实存在于 lucide-react v0.468.0**（含 `compass`/`pin`/`tag`/`undo-2`/`circle-slash`，2026-10-21 复核通过）。落地时按此表提取，无需再查。

### 4.3 状态徽章规范（消灭 111 次 ⚠️）

**不再用裸 emoji 表示状态**。改为「底色 + 语义色 + 小图标 + 文字」四件套：

```html
<span class="badge badge--ok">   <svg …/>  可投递 </span>
<span class="badge badge--warn"> <svg …/>  待补充 </span>
<span class="badge badge--err">  <svg …/>  已冲突 </span>
<span class="badge badge--mute"> <svg …/>  待结构化 </span>
```

| 语义 | 底色 | 前景 | 图标 |
|---|---|---|---|
| ok | `--success-bg` | `--success` | `circle-check` |
| warn | `--warning-bg` | `--warning` | `circle-alert` |
| err | `--danger-bg` | `--danger` | `circle-x` |
| mute | `--card-2` | `--muted` | `circle-help` |

**样式**：11px 字号、99px 圆角、`gap:4px`、`font-weight:500`、内联 SVG 11×11 stroke-width 2.4。

**可访问性**：颜色**不单独承载语义**（配图标+文字，WCAG `color-not-only`）；`--warning` 前景仅 3.5:1，故**必须**有图标+文字，不可只上色。

---

## 5. 布局改造

### 5.1 首页：侧栏 + 内容区

```
┌──────────┬────────────────────────────────────────┐
│ 侧栏      │ H1 文档                                  │
│ 112px    │ 4 个统计块（文档/待结构化/投递中/待办提醒）  │
│          │ 文档列表（每项：状态徽章 + 更新时间）        │
│ 文档 ●   │ ─────────────────────────────────────  │
│ 素材库    │ [针对岗位生成]  [导入 PDF]                 │
│ 投递看板  │                                        │
│ 复盘      │                                        │
│ 设置      │                                        │
└──────────┴────────────────────────────────────────┘
```

- 侧栏：图标 + 文字，当前项高亮（`--card-2` 底 + `--foreground` 字）
- 内容区替代现有 7 个等宽横条 → 「统计块 + 列表 + 操作」三段
- 「针对岗位生成」表单收进右侧操作区（`details` 折叠保留，但样式重做）
- 状态条（`⚠️1份待结构化·⏰1份逾期`）→ 拆成 4 个统计块
- 响应式：<768px 侧栏收为顶部横条（复用现有 topnav 形态）

### 5.2 编辑器：可拖拽双栏

**现状**（实测）：正文 `.sheet` 写死 `width:210mm`（A4 纸宽，**在数据文件里，属冻结语义不可动**）；右栏 `#ed-right` 写死 300px；左栏 `#ed-left` 是文档结构目录（已存在，1200px 下自动折叠）。

**改法**：

```
┌──────────────────────┬┬──────────────┐
│ 正文（宽度可调）        ││ 右栏（可调）  │
│  .sheet 210mm 不动     ││  260–460px  │
└──────────────────────┴┴──────────────┘
                   ↑ 拖柄
```

- 拖柄：Pointer Events 实现（`pointerdown` → `pointermove` → `pointerup`），非 HTML5 DnD
- 宽度写入 `--ed-right-w`（**该变量已被 `ai-panel.js:181` 设置但从未被 CSS 消费** —— 正好接上，不新增变量）
- 持久化：localStorage，沿用现有 `--ed-left-w`/`--ed-right-w` 折叠状态的存取范式
- 双击拖柄 → 复位 300px
- 窄屏（<768px）：右栏折叠为抽屉，沿用现有 `ed-open`/`ed-hidden` 机制
- 键盘可达：拖柄可聚焦，`←/→` 每次调 16px（WCAG `dragging-alternative`）

**不引入 react-resizable-panels**（它要 React）。原生实现约 60 行。

**不引入第三栏**：`ed-left` 已是文档结构目录，加目录会与 S3 区域绑定功能重叠。

---

## 6. 落地文件清单

| 文件 | 改动 | 量 |
|---|---|---|
| `vendors/icons.mjs` | **新建** — 44 图标 path 数据 | 生成物约 8 KB |
| `scripts/extract-icons.mjs` | **新建** — 提取脚本（可重现） | ~40 行 |
| `server.mjs` | `icon()` helper + A-VARS 覆盖 + 徽章 CSS + 首页侧栏重排 | ~200 行 |
| `server.mjs`（编辑器页） | 拖柄 DOM + Pointer Events 脚本 | ~80 行 |
| `editor-shell.js` / `job-panel.js` / `zone-panel.js` / `ai-panel.js` | emoji → 图标/徽章替换（257 处） | 逐处 |
| `test-structure.sh` | 新增断言组（token 存在性 / 无裸 hex / 无 emoji 残留 / 图标渲染正确） | ~60 行 |
| `test-editor.mjs` | 新增拖拽用例（拖动改变宽度 / 持久化 / 双击复位 / 键盘调节） | ~80 行 |

**冻结件不动**：`template.html` / `themes/` / `render.mjs`。

**新增 npm 依赖：0。**

---

## 7. 测试策略

### 7.1 新增断言（`test-structure.sh`）

| 组 | 断言 |
|---|---|
| UI-1 | 新 token 全部存在且值正确 |
| UI-2 | 组件层**无裸 hex**（`#[0-9a-f]{3,6}` 只允许出现在 `:root` 块内） |
| UI-3 | **无 emoji 残留**（前端源码中不再出现结构/状态 emoji） |
| UI-4 | `icon()` 输出合法 SVG（`viewBox`/`stroke`/`currentColor` 齐全） |
| UI-5 | 徽章四类语义色与图标对应正确 |

### 7.2 新增用例（`test-editor.mjs`，浏览器级）

| 用例 | 断言 |
|---|---|
| 拖柄存在且可聚焦 | 键盘可达 |
| 拖动改变 `--ed-right-w` | 宽度变化符合预期 |
| 宽度持久化 | 刷新后保持 |
| 双击复位 | 回到 300px |
| 键盘调节 | `←/→` 每次 16px |
| 窄屏折叠 | <768px 右栏为抽屉，不挤压正文 |

### 7.3 回归保证

四件套基线 **115 ✅ / 339 ✅** 只增不减；`test-editor.mjs` 全量通过（它是独立套件，不在 `test.sh` 内，需单独跑）。

---

## 8. 明确不做（YAGNI）

| 不做 | 理由 |
|---|---|
| 深色模式 | 双主题是范围膨胀；token 已成对留位 |
| 引入 React / 任何 npm 包 | 与全部硬约束冲突 |
| 引入 Motion / dnd-kit / Zustand / react-resizable-panels | 均为 React 生态；动效需求小（3 条 transition 够用），拖拽仅一处（约 60 行原生 Pointer Events） |
| 动效系统（Motion 级） | 当前无动效需求；先做静态设计，动效等有需求再补 |
| 图表库 | 复盘页暂无图表 |
| 编辑器三栏 | `ed-left` 已是目录，功能重叠 |
| 移动端专项 | 本机桌面工具；但布局需在 <768px 不破版 |

---

## 9. 风险

| 风险 | 缓解 |
|---|---|
| **注入层不能写进正文**（`/save` 剥离清单） | 徽章/图标/侧栏全部在服务端模板或注入层，**不进 `docs/*.html`**；改完用 `test-editor.mjs` 的注入层隔离用例验证 |
| 改 257 处 emoji 时误伤正文文本 | emoji 替换只在 HTML 模板字符串与 JS 字符串内，**不碰 `docToText`/`extract` 的文本处理路径** |
| `.sheet { width:210mm }` 在数据文件里 | 正文宽度**不动**；只让正文容器（外层）可调，内部纸张仍 A4 —— 视觉上正文居中，不影响 PDF 导出 |
| 新 token 与 `themes/`（简历正文主题）混淆 | 二者是**不同层**：token 管应用界面，`themes/` 管简历正文；本轮不动 `themes/` |
| 257 处替换引入 XSS | `icon()` 的 name 走**白名单**（不存在于 `ICONS` 则回退为空）；所有插值仍走 `escHtml`/`escAttr` |
| 一次改动量过大 | 按 4 个批次落地：① token+图标基建 ② 首页重排 ③ 编辑器拖拽 ④ 剩余 emoji 替换。每批独立可验 |

---

## 10. 实施批次

```
批次 A · 地基     token 覆盖 + vendors/icons.mjs + icon() helper + 徽章 CSS
批次 B · 首页     侧栏 + 内容区重排 + 统计块
批次 C · 编辑器   拖柄 + Pointer Events + 持久化
批次 D · 收尾     剩余 emoji 批量替换 + 新增断言 + 四件套回归
```

每批次结束跑四件套，基线只增不减。
