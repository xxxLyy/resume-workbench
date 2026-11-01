# 排版布局与完善轮报告（2026-11-01）

> 复核人：独立复核员（未参与实施）｜复核对象：`git diff cf9a6da..工作区`（HEAD = `cf9a6da2caf806cba039bdf9ad1f4daa899f2ae3`）
> 本报告只记录**本次复核实际执行**的检查与其输出；未跑的一律写「未跑」。报告不含 API key、不含用户简历正文。

---

## ① 结论（一句话）

**排版布局与功能完善两块的实现是扎实的——冻结件零改动、真实数据零写删、四套件我实跑全绿、标题三档与胶囊同档经基线对照实测达标；遗留的是「排版不变量没进断言」与「两处可见变化没登记」这类收口缺口，以及 B8 原文口径里的「电话可提取」未做也未登记 deferred——都不构成红线违反。**

红线逐条核对结果（复核期实测）：

| 红线 | 核对方式 | 结果 |
|---|---|---|
| ① 冻结件禁改 | `git diff cf9a6da -- template.html themes/ render.mjs` → 输出为空 | ✅ 零改动 |
| ② 真实数据禁写禁删 | `stat` 真实数据全部 mtime：`config.json` 2026-10-19 18:34 / `applications.json` 10-19 01:09 / `materials.json` 09-11 17:37 / `docs-meta.json` 10-19 01:09 / `.chromium-choice.json` 09-23 23:41 / `docs/` 10-19 01:09 / `snapshots/` 10-05 12:10 / `pdfs/` 10-19 01:02 / `backups/` 10-19 13:45 / `logs/` 最新 2026-10-30 02:37 | ✅ 全部未变（本轮最新写入时间 10-30 02:37，早于本轮）；`evaluations.json` 在真实根**根本不存在**，无从写删 |
| ③ 零依赖 | `git diff cf9a6da -- package.json package-lock.json` → 输出为空；`package.json` 仍只有 `playwright-core@1.60.0` | ✅ 未新增依赖 |
| ④ 无 git 写操作 | `git log`/`git reflog` 顶端仍是 `cf9a6da`（10-30 02:39 提交），无新提交、无新 ref；`git status --porcelain` 仅 `M editor-shell.js / M server.mjs / M test-editor.mjs / M test-structure.sh` + `?? DESIGN.md` + dev-docs 4 个用户未跟踪文件 | ✅ 零 git 写；用户文件原样 |
| ⑤ 不杀不重启进程 | `lsof -nP -iTCP:7766 -sTCP:LISTEN` → `node 40334 … TCP 127.0.0.1:7766 (LISTEN)`，进程启动时间 `Fri Oct 30 02:37:35`（本轮未重启） | ✅ 7766 未动；我只收尾自己起的子进程 |
| ⑥ 不外泄 key / 正文 | 本报告与全部检查输出只含合成夹具（合成姓名/合成邮箱 `zhangsan@example.com`/`甲公司·后端工程师`），`config.json` 未被读取进任何输出 | ✅ |
| ⑦ 注入纪律 | 面板 UI 全在 `#ed-jobpop` 内并用 `data-tag/data-deg/data-pages` 标记（`editor-shell.js:1530-1599`）；无 `.sheet` 改动；未触碰 Custom Highlight 通道；应用页新增色值只在 `/*A-VARS*/` 行（`server.mjs:1143`）；注入层新增值只用 `--ed-*`（`--ed-radius:8px` 落在 `editor-shell.js:40` 的 `body.ed-on{--ed-…}` 单行） | ✅ S2-B1 / S2-B2 全绿 |
| ⑧ refinement preserves | 基线对照实测：全站 h1 的 font-size/weight/letter-spacing/font-family 与基线**逐项相同**；编辑器仍是暖纸世界、应用页仍近黑工作台（截图见 §④） | ✅ 视觉身份未换 |

**§① 结论：无红线违反（violations 为空）。** 详见 §⑥ 的收口缺口与需拍板项。

> 观察（非违反，未能归因）：仓库根 `.tx/`（gitignore 的事务锁目录）在本轮复核期间 mtime 变过两次（08:02:51、08:13），目录**始终为空、无残留**；真实数据文件 mtime 全部未变。`server.mjs:40` 的数据根解析是 `process.env.RESUME_ROOT || APP_ROOT`——**未设 `RESUME_ROOT` 启动的任何实例，数据根就是仓库真实根**。仓库里还留着 4 个更早的实例（`node server.mjs`，启动于 10-24/10-29，端口 29270/50544/50867/60004，cwd = `/Users/xxxly/resume`），按「不杀不重启」纪律本轮未收尾，它们就是这类「无 RESUME_ROOT 实例会碰真实根」的现成例子。**未发现任何真实数据被写入或删除**；原因未能确定，如实登记。

---

## ② 排版布局逐项

> 本轮改动单原文未随本任务下发；下表按三个实施组自报的 done 清单 + 仓库内唯一在案口径（`dev-docs/2026-10-29-ui-ux-research-and-plan.md`）重建，逐项复核。「验收」列是**我本轮实跑**的命令或浏览器实测值。

### 2.1 应用页（`server.mjs`）

| 项 | 落点 | 验收（我实跑） |
|---|---|---|
| 标题三档 + 删死规则 | `server.mjs:1181`（`.mainarea>h1,.page-head>h1` 20px/700/-.01em）、`server.mjs:1191-1197`（三档登记注释）、`server.mjs:1245`（`.hero-title` 34px/800/+.8px）；旧 `h1{26px/800/+.6px}` 整条删除 | `grep -c "^h1{" server.mjs` → **0**；基线对照实测（`git show cf9a6da:server.mjs` 副本起独立实例 + 当前工作区实例，同一份合成数据、同一 Chromium）：`/`、`/materials`、`/settings`、`/stats`、`/applications`、`/export` 六页 h1 的 fs/fw/ls/ff **逐项相同**（页题 20px/700/-0.2px，hero 34px/800/0.8px），`.topnav .brand` 同项相同 |
| 卡片标题口径 | `server.mjs:1213`（`.card-title` 14px/800/var(--font)）、`server.mjs:1215`（`.doc-card .card-title` 16px 登记层级） | `grep -c "font-family:var(--serif);font-size:14px" server.mjs` → **0**；`grep -c "card-title" server.mjs` → 18（16 处使用 + 2 条规则）；浏览器实测：设置页 14px、首页 doc-card 16px、导出页 5 张卡 14px |
| 胶囊同档 | `server.mjs:1219`（`.badge` 12px / padding 3px 11px）、`server.mjs:1224`（`.chip` 12px / 3px 11px + `min-height:26px`） | 基线对照实测：badge **21.59px → 25.19px**、chip **32px → 26px**；当前同容器高度差 **0.81px**（≤2px 验收线达标，DESIGN.md §5.3 写的「≈25.2px / 高差 ≤1px」吻合）。**这与实施组自报的「任务原文写 .chip 不动」有出入**：不碰 chip 就过不了 2px 线，实施组给 chip 加了 `min-height:26px`（仍高于 WCAG 2.2 的 24px），已在 DESIGN.md §5.3 登记为可见差异 |
| 页头模式统一 | `server.mjs:1185`（`.page-head` flex + gap var(--space-3) + flex-wrap）；素材库/复盘页题 icon 移除；投递看板两处 ⇄ 链接与复盘 `n=` 移入右栏 | `grep -c "<h1[^>]*<a" server.mjs` → **0**；`grep -c "<h1[^>]*<span" server.mjs` → **0**；浏览器实测 `/applications` 的 `.page-head` = `display:flex; gap:12px` |
| 间距基座 | `server.mjs:1143`（A-VARS 内新增 `--space-hair/1/2/3/4/6`）、`server.mjs:1182`（页题 margin-bottom → var(--space-3)）、`server.mjs:3793`（设置页备份卡 20px → var(--space-3)） | `grep -c "var(--space-" server.mjs` → **4**；基线对照实测：各页页题 margin-bottom **4px → 12px**（首页因 `.stat-grid` 自带 `margin:12px 0` 而视觉不变，与 DESIGN.md §5.1 的说法一致）；导出页页题底边到首卡顶边 12px、设置页备份卡 computed marginTop 12px |
| 二级标题档 | `server.mjs:1197`（`.mainarea h2` 16px/700/margin 16px 0 8px） | 全站唯一 h2 在「文档已损坏」页（`server.mjs:2297`）：基线 **21px / 高 33.59px / margin 17.43px** → 当前 **16px / 高 25.59px / margin 16px 8px**。**这是一处真实可见变化，DESIGN.md 未登记**（见 §⑥ 缺口 3） |

### 2.2 编辑器注入层（`editor-shell.js`）

| 项 | 落点 | 验收（我实跑） |
|---|---|---|
| 排版监听器外提 | `editor-shell.js:2155`（全局恰一次 `addEventListener('ed-typo')`）、`editor-shell.js:2088`（resetTypo 只派发一次）、`editor-shell.js:2151`（首次 buildTypoPane） | `grep -c "addEventListener('ed-typo'" editor-shell.js` → **1**；`buildTypoPane()` 调用点 **2**（初始化 + 监听器内）；本轮 `bash test.sh` 内的浏览器级用例 **E1/E2 全绿**（日志 `E1 __edSetTypo 后排版面板滑杆/数值即时刷新`、`E2 排版监听器全局恰一次`） |
| 控件圆角单值 | `editor-shell.js:40` 新增 `--ed-radius:8px`；全部控件/浮面改 token 引用 | `grep -o "border-radius:[0-9]\+px" editor-shell.js \| sort \| uniq -c` → 仅 `999px×5 / 10px×2 / 12px×1 / 14px×2 / 3px×1`（= DESIGN.md §5.2 允许的弹层容器/胶囊/拖柄），**无 4/8px 字面圆角**；`bash test.sh` 退出码 0（S2-B2 无新增 hex/rgba 家族） |
| 删死规则订注释 | `editor-shell.js` 删 `.ed-nav .item` 两条（选择器全仓 0 命中），注释改为实况（左栏导航 12px / 右栏面板正文 13px） | `grep -c "ed-nav .item" editor-shell.js` → **0** |
| 字号档位对齐 | `editor-shell.js:35`（四档梯度注释）、`editor-shell.js:107/166/186` 三处 11px → 12px（`.ed-nav-menu button` / `.ed-undobtn` / `.ed-mattypes button`） | `grep -c "font-size:11px" editor-shell.js` → **18**（实施组自报 21→18，吻合）；12px×31 / 13px×7 |
| 排版通道合同 | `editor-shell.js:2045-2049`（「屏幕=PDF」「单一通道」合同注释，本轮零功能变更） | `grep -c "typo-custom" editor-shell.js` → **2**（`getTypoEl` 与落盘块），与合同描述一致 |
| 岗位弹层字段对齐 | `editor-shell.js:1530-1599`（折叠 details + chips + 2 textarea + 幅度 3 钮/页数 2 钮）、`editor-shell.js:1618`（brief 五键组装）、`editor-shell.js:1626`（载荷加 brief）、`editor-shell.js:1513`（提示语改写） | 本轮 `bash test.sh` 内 **E3 全绿**（`E3 弹层定制要求区（details + 2 textarea + chips + 幅度3/页数2，默认 refocus/2）`、`E3 /job/create 载荷 brief 五键齐且值透传`）；载荷键集 = `deemphasize,degree,focus,keepProjects,pages`，与首页 `briefFromForm`（`server.mjs:1771-1776`，同为这 5 键）同形状 |

---

## ③ 功能完善逐项

### 3.1 评估历史（本轮 B4 的落地）

| 落点 | 实现 | 验收（我实跑） |
|---|---|---|
| 首页区块 | `server.mjs:1646-1652`（`loadEvals().map(evalRecordView)` → 首页「评估历史」卡，10 条），`server.mjs:1496-1519`（`evalHistoryRows` 服务端渲染），`server.mjs:1742`（`EVAL_RECORDS` 经 `jsonScript` 内联） | 隔离实例（临时 RESUME_ROOT + 随机端口 + 合成 evaluations.json）首页 200，卡存在，两行渲染；**首页 `<script>` 标签数 = 3（未新增）**；截图确认两行「查看报告」按钮左缘对齐（无「转入适配」的行用 `visibility:hidden` 占位保持列对齐） |
| 独立页 `/evals` | `server.mjs:2526-2539`（字面量路由，与首页共用 `evalHistoryRows/evalHistoryPayload/EVAL_CARD_JS/EVAL_HISTORY_JS`），不进 topnav / 侧栏，侧栏「文档」高亮 | 隔离实例 `/evals` → **200**；topnav 链接数 **6**、侧栏项 **5**、「文档」高亮、`h1` = 20px/700；截图确认视觉身份未变 |
| 接线与转适配 | `server.mjs:1449-1483`（`EVAL_HISTORY_JS`：查看报告 = 客户端渲染 `evalCardHtml`；转入适配 = POST `/eval/promote`，`from = source.docId`），`server.mjs:2501-2520`（服务端 promote 契约 `{evalId,from}` → `{ok,id}` / `{existing}`） | 契约对齐实测（读码 + `grep`）；`bash test.sh` 内 EV-8 两条断言全绿（`EV-8 ① 评估历史渲染函数：转义 / 按钮可见性 / 只出元数据`、`EV-8 ② 隔离实例：首页卡 + /evals 页（转义 / 入口 / 导航零变化）`） |

### 3.2 弹层对齐（本轮 B5 的落地）

编辑器岗位弹层补齐 brief 能力，与首页表单同形状：折叠「本次定制要求（可选，默认重点调整/2 页）」→ 重点 chips（`__MATS__` tags 客户端聚合、去重、按次数降序、前 12）+ 2 个 textarea（必须保留 / 不希望强调）+ 幅度 3 钮（默认恰 1 个 `aria-pressed=refocus`）+ 页数 2 钮（默认 `2`）。DOM 全在 `#ed-jobpop` 内（`/save` 剥离名单 `SKIP_RE` 覆盖 `ed-jobpop`，`editor-shell.js:1053`）。验收见 §2.2 末行（E3 绿）+ 既有断言（首焦点=公司、`aria-modal`）仍绿。

### 3.3 导出自检（本轮 B8 的落地）

`server.mjs:4716`（全文 `pdftotext` 输出保留为 `fullText`，仍是同一次调用、30s 超时、零新增进程）、`server.mjs:4750-4763`（期望串：姓名 = 文档 `<h1>` 经 `decodeName`；邮箱 = 正文首个 email 匹配；两侧剥空白后数 substring 命中）、`server.mjs:4754-4761`（fail-honest：无 PDF / 分页预算耗尽 / 文本层未取到 / 文档无该字段 → 一律「未校验」并标 ⚠）。

**我实跑**：隔离实例 + 真 `pdftotext`（合成 A4 PDF，`render.mjs` 渲染，`RESUME_ROOT` 指向临时根）→ 导出页「渲染检查」卡出现 **「姓名可提取：命中 1 处」「邮箱可提取：命中 1 处」**（截图 `/tmp/rev-shots/export.png`），且**页面上无邮箱明文**（脚本断言 `emailLeaked=false`）。未逐分支复现「未校验」文案（`budgetCut` / 无 PDF / 文本层为空三个分支只读码，未实测），实施组亦如实登记了同样一处未测分支。

---

## ④ 视觉验收与四套件结果

### 4.1 四套件（**我本轮全部实跑**，非引用上游结论）

| 套件 | 命令 | 结果 |
|---|---|---|
| test.sh | `RESUME_TEST_STRICT=1 bash test.sh` | **EXIT=0**（396 个 ✅，0 个 ❌；含浏览器级 E1/E2/E3 新断言与「浏览器级验证全部通过」） |
| test-structure.sh | `bash test-structure.sh` | **EXIT=0**（158 个 ✅；唯一 ❌ 行 = doctor 段「Chromium 选择 — 无缓存」，属隔离临时根下的探测契约预期输出，`dev-docs/handoff.md:960` 已登记该口径） |
| test-render.sh | `bash test-render.sh` | **EXIT=0**（「✅ 渲染冒烟通过」「✅ ATS 文本层字符量 109」） |
| privacy-check.sh | `bash privacy-check.sh` | **EXIT=0**（「✅ 隐私检查通过」） |

补充：`node --check` 未由我单独跑（`test.sh` 加载 server.mjs/eval.mjs、`test-editor.mjs` 加载 editor-shell.js 均成功启动，可反证语法有效）。

### 4.2 视觉验收（**我本轮独立做的，不是引用上游的 pass=true**）

隔离实例（临时 `RESUME_ROOT` + 随机端口 + 合成文档/合成 evaluations.json）+ 本机 Chromium headless shell（playwright-core 1.60.0）：

- 逐页截图：首页 / `/evals` / 导出 / 素材库 / 设置 / 复盘 / 投递看板 / 编辑器（截图存 `/tmp/rev-shots/`，合成数据，未落仓库）。
- **视觉身份保持**：编辑器仍是暖纸世界（米底 + 墨色 + 橙主行动），应用页仍是近黑工作台（白底 + 1px 边框 + 彩色只承载状态）；双区规则未被打破。
- 逐项度量与**基线对照**（`git show cf9a6da:server.mjs` 副本起第二个实例，同数据同浏览器）：h1 六档属性逐项相同；唯一差异是页题下边距 4→12px（已登记）、badge 21.59→25.19px、chip 32→26px（已登记）、doc-card/设置/导出卡片标题由内联样式改为 `.card-title` 14px（视觉等值）。
- 页面报错：无（隔离实例各页 console 0 error）。
- **未跑**：真实简历数据的视觉点验（禁读真实数据）；窄屏 / 移动端断点未点验；`/snapshot/view` 等 B 线待修页未点验。

---

## ⑤ DESIGN.md 说明

新增未跟踪文件 `DESIGN.md`（11282 字节，8 个二级标题）。它把本轮的口径沉淀成规范：双区规则（§2）、token 职责（§3，含排版单一通道 FIELDS→typoCss→`#typo-custom`→render.mjs）、字号与字距节奏（§4）、间距与圆角节奏（§5）、注入纪律 6 条（§6）、冻结件边界（§7）、改样式前检查清单（§8）。

**与实现逐条核对（我实测）**：

- §2/§3.1 A-VARS `server.mjs:1143` ✅；§3.1 `--shadow-up` 仅 `.doc-card:hover`（`server.mjs:1271`）✅；§3.2 `--ed-radius` token 行 `editor-shell.js:40` ✅；§3.2 rgba 白名单 6 项与 `test-structure.sh:2164` 的 `RGBA_OK` 逐项一致 ✅；§4.2 三档行号 `.topnav .brand`=1160 / `.mainarea>h1`=1181 / `.hero-title`=1245 ✅；§4.1 梯度 11/12/13/14 与 `editor-shell.js:35` 注释一致 ✅；§5.1 间距 token 与页题 12px ✅；§5.3 badge 12px/3px 11px、chip `min-height:26px` ✅；§6.5 `.ed-nav .item` 已 0 命中 ✅；§6.4 `SKIP_RE` 7 项名单与代码逐字一致 ✅。

**两处与代码不符（本轮新引入，量级为行号漂移）**：

1. §6.2 写 `__edMarkProgrammatic()` 在 `editor-shell.js:655` → **实际 657**（`grep -n` 实测）。
2. §6.4 写 `SKIP_RE` 在 `editor-shell.js:1051` → **实际 1053**。

两处都是差 2 行，指向同一原因：该文件在 DESIGN.md 落盘后、同一分钟内又增删了 2 行。文件自称「与代码冲突时以代码为准」，但 §4/§5 的行号是这轮的核心校对动作，**建议下一轮改这两行后即闭合**。

---

## ⑥ 剩余与需拍板项

**收口缺口（既没做也没登记 deferred，见交付回执 coverageGaps）**

1. **排版/布局不变量没有进断言**：本轮验收全靠手工 grep（h1 死规则=0、badge/chip 同档、card-title 14px、`--space-` token、标题三档、编辑器无 4/8px 字面圆角），但 `test-structure.sh` 里**没有一条对应断言**（`grep 'card-title|--space-|min-height:26px|mainarea>h1|page-head|hero-title' test-structure.sh` → 0 命中；本轮唯一被改的断言是 `ROUTES_FROZEN` 登记 `/evals`）。这些不变量下一轮可被无声改回；DESIGN.md §7/§8 却把「断言与实现同提交」列为纪律。
2. **徽章放大 3.6px 未登记为可见差异**（21.59→25.19px）：DESIGN.md §5.3「可见差异（已登记）」只写了 chip 32→26px，§4.1 虽把 `.badge` 列进 12px 档，但没写明这是本轮把 badge 从 11px/2px 9px 改上来的结果。
3. **新增 h2 档的可见变化未登记**：`.mainarea h2` 把「文档已损坏」页的唯一 h2 从 21px/33.59px 改成 16px/25.59px（margin 17.43/17.43 → 16/8）。DESIGN.md §4.2 只登记 h1 三档，没有 h2 档及其可见差异。
4. **导出文本层自检缺「电话」**：`dev-docs/2026-10-29-ui-ux-research-and-plan.md:184-185` 的 B8 原文是「校验姓名/邮箱/电话可提取」，本轮只落了姓名 + 邮箱两行（`server.mjs:4762-4763`），电话既没做也没登记 deferred。
5. **B8 附带的两条内容层 lint 未做也未登记**：「日期格式全局一致」「联系方式不在页眉页脚」（同 plan 第 185 行末句）。
6. **首页评估历史卡内联了全部记录的完整报告正文**：`server.mjs:1742` 的 `evalHistoryPayload(evalHomeRecords)` 未按 `slice(0,10)` 裁剪（列表只渲染 10 条，但页面携带全部记录正文；JD 正文已剥离、载荷经 `jsonScript` 转义，属体积/性能取舍）——本轮未登记、未做限流。

**需拍板 / 沿用既有裁决**

- **B 线安全缺陷**（`/snapshot/view` 缺 CSP 等）：本轮未动，属另一条线（`handoff.md:972` 已登记，待 B 线窗口恢复后处理）。
- **B1 双区规则的口径措辞**：DESIGN.md §2 已把「双区规则 + `--serif` 恒指 `--font`」写成**定案口径**（等于方案建议的选项 ②），而实施组自述「B1 待用户正式拍板」。本轮未改任何渲染（`--serif` 本就 = `--font`），但文档措辞与待拍板清单需对齐，请明确：**本轮是「按推荐项②落文档」还是「暂不定案、只登记」**。
- **应用页标题是否改走真衬线**（B1 的另一半）：本轮明确不改，等用户拍板。
- **跨区字号统一**（应用页按钮 13px vs 编辑器控件 12px）：已按双区密度取舍登记，未统一（统一需改一侧数十处，超本轮边界）。
- **「评估历史」入口位置**：本轮只走首页卡内链接，**不进 topnav / 侧栏**（topnav 链接数 6 被 UI-4 断言冻结）。若要进侧栏，需同轮改断言。
- **B9 编辑区 ARIA 语义**（`role=textbox` + `aria-multiline`，有随保存落盘风险）、**B6 S5 / B7 S4b** 等路线图项：本轮未做，按既定裁决暂缓。
- **7766 常驻服务仍是 10-30 的旧代码**（PID 40334，启动于 `Fri Oct 30 02:37:35`）：本轮按「不杀不重启」纪律未重启，**新代码尚未在常驻服务上生效**；何时重启由用户决定。
- **遗留进程**：4 个更早的 `node server.mjs`（10-24/10-29 起，端口 29270/50544/50867/60004）数据根指向仓库真实根，本轮未收尾。

**视觉未过项**：无。本轮我做的视觉验收全部通过（§④），未发现需返工的视觉问题；上面 2/3 两条是**登记缺口**而非视觉失败。

---

## ⑦ 回退提示

**禁止 `git reset --hard` / `git clean -fd` / `git checkout .`。** 逐文件回退（只动被点名的一个文件，不影响其他改动）：

```bash
cd /Users/xxxly/resume
git checkout cf9a6da -- server.mjs          # 应用页：排版三档 / 卡片标题 / 胶囊 / 间距 / 评估历史 / 导出自检
git checkout cf9a6da -- editor-shell.js     # 编辑器：排版监听器 / 圆角单值 / 字号档 / 岗位弹层 brief
git checkout cf9a6da -- test-structure.sh   # 结构套件：EV-8 断言与 ROUTES_FROZEN 登记
git checkout cf9a6da -- test-editor.mjs     # 浏览器级：E1/E2/E3 断言
```

- `DESIGN.md` 是**未跟踪新文件**，无 git 历史可回退 —— 需要撤销时直接删文件即可：`rm /Users/xxxly/resume/DESIGN.md`（不需要任何 git 写操作）。
- **必须成套回退**：`server.mjs` 与 `test-structure.sh` 要一起退——只退前者会留下 EV-8 断言与 `/evals` 路由断言不一致（套件必红）；`editor-shell.js` 与 `test-editor.mjs` 同理。
- **回退后必须重跑**：`RESUME_TEST_STRICT=1 bash test.sh && bash test-structure.sh && bash test-render.sh && bash privacy-check.sh`（本轮基线：四件全绿，test.sh 396 ✅、test-structure.sh 158 ✅ + 1 个 doctor 契约 ❌ 行）。
- **不要动**：`dev-docs/` 下未跟踪的 `2026-10-28-audit-observations.jsonl`、`2026-10-28-consolidated-audit.md`、`2026-10-28-consolidated-repair-brief.md`、`2026-10-29-agent-handoff.md`（用户文件）；`docs/ snapshots/ pdfs/ backups/ logs/` 与 `config.json / applications.json / materials.json / evaluations.json / docs-meta.json / .chromium-choice.json`（真实数据，禁写禁删）；`template.html / themes/ / render.mjs`（冻结件）；`.git`。

---

## 附：复核方法与证据出处

- 复核动作（全部只读 + 隔离实例）：`git status / git diff / git show / git log / git reflog`（无任何 git 写）；`grep / sed / stat` 实查；四套件实跑；隔离实例（临时 `RESUME_ROOT` + 随机端口 + 合成文档 + 合成 evaluations.json）+ 本机 Chromium headless shell 的逐页截图与 computed-style 度量；基线对照实例（`git show cf9a6da:server.mjs` 副本置于 `/tmp`，跑完即删）。
- 复核期间未在仓库写入任何文件（除本报告）；未启动/结束任何非本轮自起的进程；未读取真实 `evaluations.json`（该文件在真实根不存在），评估数据结构由 `eval.mjs` 的 `evalRecordView` 与 `server.mjs` 代码推导。
- 复核期临时物：隔离实例的临时目录与 `/tmp/rev-base` 基线副本已删除；截图留在 `/tmp/rev-shots/`（合成数据，未入仓库）。
