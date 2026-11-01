# DESIGN.md — 简历工作台设计系统

> 写给未来的设计/开发接手人。本文件是**规范**（normative），不是灵感稿。
> 与代码冲突时以代码为准，但代码与本文件冲突 = 需要修代码或修本文件，不要默默分叉。
> 冻结件（`template.html` / `themes/` / `render.mjs`）不在本系统的可改范围内，见 §6。

---

## 1. 一句话

两个世界共用一台机器：**编辑器 = 暖纸世界**（写稿的地方），**应用页 = 近黑工作台**（办事的地方）。
两套世界的 token 不互通；任何「看起来像串味」的样式，先查是不是跨区用了对方的 token。

---

## 2. 双区规则

| | 编辑器区（注入层） | 应用页 |
|---|---|---|
| 载体 | `editor-shell.js` / `ai-panel.js` / `job-panel.js` / `zone-panel.js` 注入 `body.ed-on` 的 CSS | `server.mjs` 渲染的页面（首页 / 素材库 / 投递看板 / 复盘 / 设置 / 导出 / 对比 …） |
| token 前缀 | `--ed-*`（唯一通道） | A-VARS（`--background` / `--accent` / `--radius` …，`server.mjs:1143`） |
| 底色 | 暖纸 `#F0EBE2` / 面板 `#FFFCF5` | 白 `#ffffff` / 次级面 `#fafafa` |
| 字色 | 墨 `#26221C` / 次级 `#6E675C` | 近黑 `#0a0a0a` / 次级 `#737373` |
| 主行动 | 橙实心 `--ed-accent #C2410C`，**只给** `pdfBtn` / `primary`；其余操作区一律中性描边 | 近黑 `--accent #18181b` 实心 |
| 彩色 | 仅语义（ok / warn / err） | 仅语义（ok / warn / err），**不承载装饰** |
| 字族 | 正文无衬线 `--ed-sans`；**真衬线 `--ed-serif` 只给标题类与 `.ed-label` 标签类** | **单一无衬线族**；`--serif` 是历史别名，恒指 `--font`（页题有意无衬线） |
| 阴影 | 暖阴影 `rgba(60,45,25,·)` | 零阴影（`--shadow:none`），层级靠 1px 边框 + 背景差 |
| 圆角 | 控件档 `--ed-radius:8px`（已登记） | `--radius:4px` / `--radius-lg:6px`；胶囊 999 |
| 密度 | 紧凑（控件 12px / 面板正文 13px） | 宽松（正文 14px / 表单控件 13px） |

**定案口径**（本轮只定案、不换族）：

- 应用页 `--serif: var(--font)` —— `--serif` 是历史别名，**不是**第二套字族。
  应用页页题（`.mainarea>h1`）、hero 标题（`.hero-title`）、品牌（`.topnav .brand`）**都渲染为无衬线**，这是有意的。
- 真衬线只存在于编辑器：`--ed-serif`（Songti / Noto Serif CJK 栈）给 `.ed-label` 与编辑器内标题类。
- 若将来要让应用页标题走真衬线 = 换视觉身份，属于 B1 决策，须用户正式拍板，不得顺手改。

---

## 3. Token 职责

### 3.1 应用页 A-VARS（`server.mjs:1143`，单行紧凑写法）

- 语义名 → 旧名别名成对存在：`--background/--bg`、`--card/--panel`、`--foreground/--ink`、`--muted/--mut`、`--border/--line`、`--accent-soft`、`--ok/--warn/--err` + `*-soft`。旧名保留是为了几百处 CSS 零改动即生效。
- 改 token 只改这一行；**不要**在具体规则里写字面色值。
- 状态三色已定案（A1）：`--success #15803D` / `--warning #A25711` / `--danger #B91C1C`，各自配 `*-bg` 浅底，on 各自浅底均 ≥4.5:1（AA）。
- `--accent` 是近黑，不是品牌色。彩色只承载状态。
- 阴影例外仅一处已登记：`--shadow-up`（悬停投影，只用于 `.doc-card:hover`，`server.mjs:1271`）。静态层级仍然零阴影（1px 边框 + 背景差）；再要投影先在本文件登记用途。

### 3.2 编辑器 `--ed-*`（`editor-shell.js:40`，`body.ed-on{--ed-…}` 单行）

- **注入层唯一 token 通道**：`test-structure.sh` S2-B2 扫描四个注入文件，字面色只允许出现在 `body.ed-on{--ed-` 这一行；新增颜色必须先在 token 行登记。
- `rgba` 家族白名单（S2-B2）：`rgba(60,45,25,·)` 暖阴影 / `rgba(0,0,0,·)`·`rgba(255,255,255,·)` 黑白遮罩 / `rgba(162,87,17,·)`（`--ed-warn` 派生）/ `rgba(194,65,12,·)`（`--ed-accent` 派生）/ `rgba(255,252,245,·)`（`--ed-panel` 派生）。新家族要在断言里登记，**不许绕过**。
- `--ed-accent-strong #9A3412` 是 A1 登记的局部方案，只在需要更强对比的位置用；**不得翻案**全局 accent 家族。

### 3.3 排版 token（简历正文）

排版设置（字号 / 行距 / 页边距 / 段落间距 / 章节间距）走**单一通道**：

```
FIELDS（editor-shell.js） → typoCss(v) → #typo-custom（落盘进 <head>） → render.mjs 读取 → PDF
```

- 屏幕 = PDF 的合同靠的就是这一条链路。**禁止另开注入通道**（另开即双轨，PDF 与屏幕必然漂移）。
- 新增排版维度 = 扩 `FIELDS`（number + range 双控件 + `aria-label`）+ 扩 `typoCss`，两端同改。
- 「恢复默认排版」= 移除整段 `#typo-custom`，不是逐项回写。

---

## 4. 字号与字距节奏

### 4.1 角色梯度（两区共用同一套语义档，值可不同）

| 档 | 角色 | 应用页 | 编辑器 |
|---|---|---|---|
| 11px | 辅助注 / 角标 / 状态栏 / 图标钮 | 说明文字 | `.ed-note` `.ed-status` `.ed-label` `save-state` 图标钮 |
| 12px | 紧凑控件与元数据 | `.chip` `.badge` 表单标签 | 工具栏钮、弹层 input/select、导航行、菜单项 |
| 13px | 面板正文与输入 | `button` `input` `select` 正文 | 面板正文 |
| 14px | 应用正文与页面级按钮 | `body` `.card` 正文 | — |

- 同角色跨区取齐同一**语义档**；密度不同靠容器密度解决，不靠偷偷换档。
- 「相邻两档没有职责差」是违规（例：徽章 11px 与胶囊 12px 相邻且同职能 → 取齐）。

### 4.2 应用页标题三档（只此三档，不得新增第四档）

| 角色 | 落点 | 规格 |
|---|---|---|
| 品牌 | `.topnav .brand`（`server.mjs:1160`） | 16px / 800 / `letter-spacing:.4px` |
| 页题 | `.mainarea>h1`（`server.mjs:1181`） | 20px / 700 / `letter-spacing:-.01em` |
| hero | `.hero-title`（`server.mjs:1245`） | 34px / 800 / `letter-spacing:.8px` |

- 层级靠**字号 + 字重**表达，字距只作微调。
- `h1{font-size:26px;…}` 曾是死规则（全站 `h1` 都在 `.mainarea` 内，被 `.mainarea>h1` 覆盖）——**已删**，别再写「页题 26px」的假设。
- 字距地板：不低于 `-0.04em`（craft-floor）。当前 `-0.01em` 是应用页近黑工作台的克制档。

### 4.3 卡片标题口径

`.card-title` = 14px / 800 / `var(--font)`（因 `--serif:var(--font)`，与原写法零视觉差）。
`doc-card` 的 16px 是**有意层级**，单独登记为 `.doc-card .card-title{font-size:16px}`。
同一个角色（卡片标题）在首页 / 导出 / 设置 / 复盘四页必须同款。

---

## 5. 间距与圆角节奏

### 5.1 间距

- 4px 基：应用页 token `--space-1:4px` / `--space-2:8px` / `--space-3:12px` / `--space-4:16px` / `--space-6:24px`，微档 `--space-hair:2px`。
- **新写的间距一律引用 token**；存量值**不刷全站**，只在触碰到的规则里换（避免视觉回归面失控）。
- 页题与首个内容块的间距：全站单值 12px（`.mainarea>h1` 的 `margin-bottom`）。首页因 `.stat-grid` 自带 `margin-top:12px` 而折叠为同值，视觉不变。

### 5.2 圆角

- 应用页：`--radius:4px`（控件 / 卡）/ `--radius-lg:6px`（容器）/ 胶囊 999。锐利。
- 编辑器：控件与小浮面（菜单 / 选区工具条 / 素材预览框）圆角**单值** `--ed-radius`（8px）——`editor-shell.js` 内可 grep：控件与浮面规则**不得**再出现字面 4/8px 圆角（含内联 `cssText` 与同选择器的后置覆盖）。字面圆角只允许：大弹层容器 10/12/14、胶囊 999、拖柄 3px（6px 竖条的形状半圆）、重置 0。
- **已登记的既有偏差**（非本轮引入，未收口）：`ai-panel.js` / `job-panel.js` / `zone-panel.js` 的存量控件圆角仍为 5–9px 多档；收口属后续轮，动它们时按本节单值口径归 token。
- 可见差异（本轮单值闭合时登记）：导航行 22/24px 图标钮与撤销 toast 内「撤销」钮 4px→8px；其余 8px→token 处均为零视觉差。

### 5.3 胶囊（badge / chip）

- 两枚胶囊同款：字号 12px、上下内边距 3px、左右 11px。等高还差一条：`.chip` 是 `button`，会被全局 `button{min-height:32px}` 撑到 32px——**已收** `.chip{min-height:26px}`（`server.mjs`），胶囊高度回到自身盒模型，与 `.badge`（≈25.2px）高差 ≤1px。
- **可见差异（已登记）**：全站胶囊高度 32px→26px（缩 6px）。这是「两枚胶囊同档」的代价，非误改；26px 仍高于 WCAG 2.2 的 24px 最小目标尺寸。
- `.badge` 自带 `margin-right`（徽章后分隔的唯一机制）；放进 `gap` 容器时**必须**给 `.badge{margin-right:0}`，否则双倍计距。

---

## 6. 注入纪律（编辑器外壳）

1. **面板 UI 只挂对应注释对或 `data-*` 标记**，不给正文挂 class。
2. **改 `.sheet` 必须走 `window.__edMarkProgrammatic()`**（定义在 `editor-shell.js:655`），否则撤销栈收不到这次改动。
3. **临时视觉走 CSS Custom Highlight API**（`::highlight(ed-flash)` / `ed-find` / `ed-find-cur`），不给正文挂 class、不改 DOM 结构。
4. `/save` 剥离名单 `SKIP_RE`（`editor-shell.js:1051`）：`page-line|ed-find|ed-keys|ed-matpop|ed-matmask|ed-jobpop|ed-jobmask` —— 运行时节点不进正文。
5. 注入层不写页面上不存在的选择器：全仓 grep 0 命中的规则是**死规则**，它会误导后续排版判断（如 `.ed-nav .item`）——发现即删。
6. 注入层只允许 `--ed-*` token 与已登记的 rgba 家族（S2-B2 把关）。

---

## 7. 冻结件与可改边界

| 文件 | 状态 |
|---|---|
| `template.html` | **冻结**：可读不可改。简历打印排版本轮零改动。（排版设置读写钩子 `window.__edGetTypo/__edSetTypo` 在此文件，改它即越界。） |
| `themes/` | **冻结**：简历渲染主题。 |
| `render.mjs` | **冻结**：只消费 `#typo-custom`，不改。 |
| `docs/` `snapshots/` `pdfs/` `backups/` `logs/` `*.json`（`config.json` / `applications.json` / `materials.json` / `evaluations.json` / `docs-meta.json` / `.chromium-choice.json`） | **真实数据**：禁写禁删。要复现一律用临时 `RESUME_ROOT` + 随机端口 + 合成文档。 |
| `server.mjs` / `editor-shell.js` / `ai-panel.js` / `job-panel.js` / `zone-panel.js` | 可改：应用页样式与注入层样式的落点。 |
| `test-structure.sh` / `test-editor.mjs` / `test.sh` | 可改，但**断言必须与实现同提交**；不许为了让实现过关而放宽断言（登记 ≠ 放宽）。 |

---

## 8. 改一个样式前后的检查清单

- [ ] 落在正确的一区？（应用页 A-VARS / 注入层 `--ed-*`），有没有跨区串味？
- [ ] 用的是 token 还是字面值？新字面值该先进 token。
- [ ] 同角色跨页/跨区是否同款？（按钮、卡片标题、胶囊、表单控件、页题）
- [ ] 有没有落进死规则陷阱？（先 grep 确认选择器真的命中）
- [ ] 改动是否动了冻结件或真实数据？
- [ ] 断言是否与实现同提交更新？（`bash test-structure.sh`；浏览器行为走 `test-editor.mjs`）
- [ ] 可见差异是否已登记（本文件 §4/§5 的档位表）？
