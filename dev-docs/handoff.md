# 简历平台交接文档（Handoff）

> 日期：2026-09-17 编制 ｜ **2026-09-30 状态更新**：S0-S3 已全部交付上线；S4a 设计轮完成待审。本文件 §1-§5 是 2026-09-17 历史快照（文件清单与 P0 修复记录仍有参考价值；其中"112 断言"等测试数为当时口径）；§6 纪律条目持续有效并被 S2/S3 增补。
> 最新状态看：路线图 §3.1（`dev-docs/2026-09-23-roadmap-magazine-and-features.md`）+ 各阶段设计/计划文档。

---

## 0. 当前状态一句话

**（2026-09-30）** S3 区域绑定已上线（2026-09-29，`e87a4c9..bbbad60` 16 提交，test.sh 219 ✅ / 0 ❌，PDF 像素等价归档于 `.superpowers/sdd/2026-09-29-s3-plan/`）：8 类语义区域绑定（`data-zid` 落盘 + `meta.job.zones`）、区域 Tab（列表/定位/着色/改绑）、区域级 AI 分析与修改模式（stub 模拟验证）、素材事实层（facts/factStatus 三态）。**S4a 岗位适配核心已完成设计与实施计划（`dev-docs/2026-09-30-s4a-design.md` v1.0 + `2026-09-30-s4a-plan.md`，含 8 组用户决策、两个先行修复任务 F1/F2、原型四屏 `dev-docs/mockups/s4a-shots/`），停在独立审查点，未动生产代码。**

**（2026-09-17 历史快照，见 §1-§5）** 从「编辑器」升级为岗位定制闭环：拿到 JD → 独立岗位草稿（不改母版）→ 修改清单审阅（接受/撤销/冲突门控）→ 导出两页 PDF。保存一致性、测试隔离、PDF 与投递版本绑定、备份恢复语义四个 P0 已修复。

## 1. 文件清单（本轮新增/重写标 🆕）

| 文件 | 职责 |
|---|---|
| server.mjs 🆕 | 全部路由；**RESUME_ROOT 数据根**；JSON 损坏停写；revision 冲突保存；渲染分离（`/render`）；投递冻结+存档；备份恢复（预览/回退点）；岗位接口（`/job/*`）；统一提取 |
| extract.mjs 🆕 | **正文提取唯一出口**：去工具栏/脚本/占位符/注入外壳，隐藏内容默认排除（`hidden=1` 可含），实体解码，内容哈希，章节解析 |
| job.mjs 🆕 | 岗位 prompt 构建 + 受约束 op 解析 + **事实护栏**（新增数字/丢失日期 → conflict）+ 两页建议（纯函数） |
| job-panel.js 🆕 | 右栏「审阅」面板：修改清单分组、批量/单独接受、撤销、定位、待补充、冲突门控、生成/重新生成 |
| template.html 🆕 (v5) | 保存状态机三态（编辑/提交/确认修订）、续存排队、baseMtime 冲突、恢复缓存含排版、导出前自动保存 |
| editor-shell.js 🆕 | 外壳：导航无障碍（无嵌套按钮）+ 条目级积木（项目隐藏/排序）、岗位草稿入口弹层、缩放数值输入、排版数值输入、统一撤销栈、审阅 Tab |
| render.mjs 🆕 | `--src/--out` 从任意源渲染；**临时文件成功才原子替换**；`RESUME_ROOT`/`RESUME_CHROMIUM`/`RESUME_RENDER_BIN` 注入 |
| diff.mjs 🆕 | 委托 extract 统一提取；保留 LCS 差异 |
| migrate-editor.mjs 🆕 | v4→v5 迁移（先快照、幂等、护栏版本号） |
| test.sh 🆕 | **全隔离回归**（独立数据根/端口/虚拟配置/假渲染器/本地假 LLM + 真实数据指纹比对） |
| test-editor.mjs 🆕 | Playwright 浏览器级：保存期间编辑、离线恢复、多标签冲突、审阅接受与持久化、无障碍与弹层 |
| test-render.sh 🆕 | 真实 Chromium 渲染冒烟（隔离夹具） |

## 2. 关键架构决策（不要翻案）

1. **数据根 = RESUME_ROOT（缺省项目目录）**：所有数据（docs/snapshots/pdfs/backups/JSON/config）走它；代码与静态资源永远从 APP_ROOT 读。测试隔离靠它。
2. **保存 = revision 三态**：请求成功只确认它提交的修订；期间编辑保持未保存并续存；恢复缓存按修订清理且含排版；多标签用 `baseMtime` 拒绝静默覆盖。
3. **正文保存与 PDF 分离**：`/save` 只写正文（手动保存打快照）；`POST /render` 显式渲染；导出页按需渲染并如实报告成败；`render.mjs` 原子替换。
4. **投递 = 冻结内容**：`/app/add` 冻结快照 + 内容哈希，**从冻结内容**生成存档 PDF；缺失明确标注且只能从快照重建；被引用的快照免配额清理。
5. **岗位草稿 = 独立文档**：`meta.job{status,sourceSnap,sourceHash,materials,changes,todos}`；不依赖模型；重复创建 409；重新生成产生新候选不覆盖手工修改；改稿使「可投递」失效。
6. **审阅在客户端应用、状态在服务端**：DOM 操作由 job-panel 执行（可进统一撤销栈），状态经 `/job/changes` 回写 docs-meta.json；刷新后保留。
7. **冲突门控**：`level=conflict` 且 pending → 导出页禁用下载与「记录已投递」；重点审阅仅提示。
8. **正文提取唯一出口**：AI/diff/导出检查/restructure 一律用 `extract.mjs`；隐藏条目/章节默认不参与 AI 与对比（可显式包含）。
9. **注入纪律不变**：AI/外壳/审阅面板都挂在注释对之间（`AI-INJECT`/`SHELL-INJECT`/`JOB-INJECT`），`/save` 双保险剥离；运行时样式块（`data-ai-panel/data-ed-shell/data-job-panel`）也在服务端剥离。
10. **备份不含 config.json**；恢复默认合并（本地独有保留、同 id 以备份为准）、有回退点、tar 条目校验（拒绝绝对路径/`..`）。

## 3. 本轮修复的存量 bug（验证点之外的收获）

- `extract.mjs` 首版深度扫描正则漏闭合斜杠 → 整段文档被"吞掉"（被隔离测试当场抓住，已修）。
- 首页文档卡 `docInfo(文件名)` 误传 id 后缀 → 列表全空（被真实服务验证抓住，已修）。
- 多标签保护在浏览器失效（`window.__edDocMtime` 从未赋值）→ baseMtime 恒 0（被浏览器测试抓住，已修）。
- 保存完成后有未保存修订时等待 3s 才续存 → 改为 600ms 续存。
- 章节导航嵌套按钮 / 输入重建导航丢焦点 / 新增章节脱离 observer（均修）。
- 逾期提醒 24h 后消失 → 逾期保留。

## 4. 怎么跑

```bash
bash test.sh            # 全隔离回归（不碰真实数据；需要 poppler；浏览器级需本机 Chromium）
bash test-structure.sh  # 纯函数/解析
bash test-render.sh     # 真实渲染冒烟（隔离夹具）
node migrate-editor.mjs # 文档编辑器迁移（有快照；仅当 template 版本升级时）
launchctl kickstart -k gui/$(id -u)/com.lhx.resume-server   # 重启常驻服务
```

## 5. 未完成 / 有原因的留白

| 项 | 原因 | 触发条件 |
|---|---|---|
| 真实模型全流程复验（生成/体检/匹配/面试建议） | 需用户授权 token 成本；本轮全部为本地 stub 模拟验证 | 用户授权后过一遍 |
| 移动真机 | 只有 viewport + 单栏 CSS，未在真实设备验证 | 用户窄屏高频使用时 |
| 全局撤销合并原生逐字输入 | 程序化撤销栈（章节/条目/素材/AI/审阅）已具备，原生输入仍用浏览器 ⌘Z | 用户反馈撤销混乱时 |
| 公司/学历等文案改写的程序级护栏 | 目前靠 prompt + 审阅；数字/日期已是程序级拦截 | 出现一次真实误导后 |
| 面试记录编辑/改期/取消 | 判定为辅助功能，本轮只保留新增 | 用户高频改期时 |
| 一键全文翻译 / 素材双向同步 / 模板商城 / 自动投递 | 决策暂缓 | 明确高频需求出现 |
| 超大备份（>300MB） | 恢复上限 300MB（流式） | 真实备份超过时再放宽 |
| 空口径数字规则化（「提升30%」vs「从300到5000」） | 纯程序判不了真假：合法的「效率提升30%」与编造的在字符串上完全一致。规则化只能判「纯百分比且同句无基线」，误报一次用户就会忽略整个护栏 | 出现可程序化的判定口径时 |
| 非退化下限（长度 / 数字保留率阈值） | 依赖 lostNums 先落地，要看到它的真实误报率再定阈值，否则阈值是拍的 | lostNums 上线并积累真实样本后 |
| S4b① 五阶段可见进度 / S4b② 分批并行 | 本轮只做 S4b③；调研未给这两项新证据，只有路线图自身规划支撑 | 决定做 S4b 全量时 |
| Type 3 字体是否破坏 ATS 文本提取 | 调研挂账：poppler `pdftotext` 实测正常，但 Workday/Greenhouse/Lever 侧未验证。**结论出来前不动 `themes/`**（冻结件，改它=重设基线） | 补完 ATS 调研后 |
| 窄屏两行 topnav / 快照横幅叠加时的 scroll-padding 加档 | 64px 默认值已实测通过（对照实验：设为 0px 焦点即被遮挡）。窄屏两行与 `z-index:1000` 横幅叠加场景尚未实测 | 窄屏键盘导航反馈遮挡时 |
| 面试追问的真实 LLM 链路 | 本轮全为 stub + 注入假数据验证渲染/护栏/stale，未消耗 token 跑真实模型 | 用户授权 token 后 |

**已知接受项**：iframe PDF 预览在 headless 下空白（真机正常）；API Key 在设置页为明文（本机单用户）；`pdfs/linghaoxiang.pdf`、`pdfs/old-resume.pdf` 为 9-11 版本（首页显示「PDF 较旧」为正确口径，导出时自动重渲）。

## 6. 若继续开发

- 改编辑器行为：改 `template.html` → bump `data-editor` 版本 → `migrate-editor.mjs`（护栏同步改）。
- **S2 起的纪律：只想改"行为"而不迁移，就别碰 `template.html`。** 模板会被冻结进每份既有文档，改模板只有新建文档受益，真实旧文档仍跑旧逻辑。 serve 注入的 `editor-shell.js` 对新老文档同权，`server.mjs` 的 `/save` 归一化不依赖客户端脚本版本，`extract.mjs` 的 `CHROME_MARKERS` 是第二道防线——瞬态剥离、快捷键门控、临时高亮这类修正一律走这三条通道。
- **撤销边界（S2 定稿，改任何编辑行为前先读）**：
  - 两套栈并存且互不接管。打字与格式化（`execCommand` 加粗/列表/链接/清除格式）由**浏览器原生撤销**接管，一次 ⌘Z 撤销的就是最近那次输入；格式化**不得**压入程序化栈——栈里的 op 是整片 `sheet.innerHTML` 快照，压进去就会连带回退用户之后的输入。
  - 程序化操作（条目增删改、区块排序、查找替换、素材插入、AI/审阅落盘）走 `window.__edPushUndo(label)` → 变更 → `window.__edMarkProgrammatic()`，返回的 `opId` 要传给 `undoToast(msg, opId)`，Toast 与工具条「↩ 撤销」消费**同一条**记录；栈顶不是它 → 拒绝并显示「已失效」。
  - **任何改动 `.sheet` 的代码都必须经 `__edMarkProgrammatic()`**（面板原先自己裸派发 `new Event('input')`，会被误判成原生输入）。判定用的是 `e.isTrusted`：合成 `input` 不算用户输入。
  - 快照回退遇到"该操作之后用户又打了字"→ 必须 `window.confirm` 显式确认，不允许静默吞掉正文。
  - 临时视觉效果（高亮、定位闪烁）一律走 CSS Custom Highlight API（`CSS.highlights` + `::highlight()`，构造函数是变参 `new Highlight(range)`，多区间用 `.add()`），**不要给正文节点挂 class**——那会随保存进落盘 HTML。
- 改外壳/审阅面板：改 `editor-shell.js` / `job-panel.js`（serve 注入即生效，零迁移）；DOM 必须挂注释对之间或打 `data-ed-inj`/`data-job-panel` 标记。
- **样式分层（S2 起）**：应用页面色值只准引用 `server.mjs` 的 `/*A-VARS*/:root` token；编辑器与两个面板只准引用 `editor-shell.js` 注入的 `--ed-*`（编辑器页拿不到页面级 `:root`，故有独立的 `--ed-sans`/`--ed-serif`）。`test-structure.sh` 的 `S2-B1`/`S2-B2` 会拦字面色与冷色残留，`S2-A` 拦"注入层声明简历正文文字属性"和新增 `!important`（基线 4）——要放宽的是登记，不是断言。
- **zid 纪律（S3 起，改区域绑定前先读）**：`data-zid` 格式固定 `z` + 8 位 hex（`z[0-9a-f]{8}`，`zone.mjs` ZID_SRC 单一规范）。**生成点单一 = 编辑器注入层**（`editor-shell.js` 的 `edHashZid`/`edNewZid`）：未保存阶段用确定性内容哈希（djb2），保证两次加载生成相同 zid、初绑 meta 不失配；同内容重复/粘贴克隆才随机重打。唯一性双保险 = 编辑器四口打点（加载/input/paste/克隆）+ `/save` 归一（重复保首重打）。服务端任何端点**不得**自造 zid。
- **区域面板注入纪律（S3 起）**：区域 Tab 一切 UI 挂 `ZONE-INJECT` 注释对之间，运行时样式块打 `data-zone-panel` 标记（`/save` 剥离清单已登记）；区域着色只用 CSS Custom Highlight API（`::highlight(zone-*)`），**绝不给正文节点挂 class**——否则随保存落盘（S2 纪律的区域版，`test-structure.sh` S3-C 断言把关）。
- **`/zones` 整条回写是 locked 契约（S3-D pin）**：确认/改绑/调序/锁定全走 `POST /zones?id=`，条目校验 zid 格式 + zone 枚举 + status 枚举；`locked` 只在显式传 `true`/`false` 时落键（缺省不写）。改这个端点的行为前先看 `test.sh` S3B/S3C 断言。
- **`renderInputId` 忽略 `data-zid`（freeze.mjs 口径，S3-D pin）**：`freeze.mjs` 在 bodyHash 前摘除 `data-zid`（`stripZid`）——渲染身份只度量视觉输入，zid 是非视觉 bookkeeping。zid 格式若变，`freeze.mjs` 与 `zone.mjs` 两处正则必须同步（freeze 刻意零本地依赖，不共享常量）。
- 新增数据文件：必须纳入 `test.sh` 的隔离数据根与备份/恢复清单。
- 真实 LLM 验证需用户明确授权；AI 相关测试一律走本地 stub 并标注"模拟验证"。

---

## S4a 交付快照（2026-10-05，T12 回写）

**S4a 岗位适配核心（生成→审阅→导出）T0–T12 全部完成**：要求卡（brief+预设）、证据表（五态/事实依据可读化/zid 定位/note 两级）、局部生成（scope=zone，zid 标注+摘要）、候选生命周期（zid/baseSnapshot/zone 锚定、guardOps 锁定与范围护栏、局部 supersede 同 zone）、v1.6 JSON 保存协议（接受/撤回与正文同事务、整次幂等、严格 baseRev）、审阅升级（筛选/j-k/主操作流转/拒绝原因 chips 进 feedback/保留当前版本/skipped 状态机/撤回前置）、导出检查三级+排版诊断（结构性表述、半自动 3 轮、超页二出路）、组件布局轮（⋯ 菜单键盘化、素材库补强、favicon、宽度档联动）。

- 测试：四件套全绿（test-structure / test-render / privacy-check / test.sh 332✅ / 浏览器级含端到端反例）；frozen-diff 对 bbbbad60 零偏差。
- 提交链：e67cd7f → d0fc926 → e063cb8 → b8774a4 → 83b4dbf → 9b185bc → 4810a09。
- 终审与遗留：`dev-docs/2026-10-05-s4a-final-review.md`（A1–A9 逐条、v1.4/v1.5/v1.6 反例逐条、落地修正 6 条、遗留 5 条、上线清单）。
- 状态：**已上线**（2026-10-05 用户授权重启 launchd，pid 确认新代码生效）。上线后修复批次（a450ce0：导出门控服务端强制 / 保存入口结构校验 / 可投递契约统一；ce077dc：guardOps③+/delete 清 meta+reorder 专测）已提交，**待用户授权重启生效**。上线冒烟通过：建草稿→四 Tab 注入（岗位匹配已退役）→保存 zid/zoneSync 落盘→真实渲染导出（2 页=目标，诊断面板齐全）→首页徽章→删除清理。真实 LLM 链路已验证（2026-10-05，Kimi k3：证据生成 5 条落账 refs 全 fresh、建议生成 6 条全带 zid 锚定、guardOps ③ 线上无误伤；测试草稿已删）。登记一个 S1 时代既有缺口：POST /delete 不清理 docs-meta.json 条目（孤儿 meta 累积，非 S4a 回归）。

---

## 批次1 交付快照（2026-10-18 · career-ops JD 指纹去重）

**背景**：从开源 career-ops（MIT，`090f787e`）移植 JD 内容指纹，给岗位草稿创建流程加重复检测。本批次**不含任何 AI 调用**——纯确定性脚本，全链路可真实验证。

- **落点**：`vendors/jd-fingerprint/` 三文件（`fingerprint-core.mjs` 移植+CJK 改造、`normalize-text-key.mjs` 移植、`repost-check.mjs` 自写薄壳）。**零 npm 依赖**（仅 `node:crypto`）。
- **接线**：`server.mjs` 的 `computeFpGuard()`/`fpTodo()`（101–131 行），双入口 `/job/create`（1514/1526/1527/1532）与 `/version/create`（1557/1562）都挂。精确 409 去重语义不变，模糊只进 `job.todos` 提醒不阻断。护栏任何异常降级跳过（动态 import，vendors 损坏不拖垮启动）。
- **测试**：`test-structure.sh` FP-1…FP-9 共 9 组（基线 86 → **95**）；`test.sh` **338** ✅；四件套 exit=0；冻结件零偏差。

### ⚠️ 三个必须知道的坑

1. **`FP_THRESHOLD = 0.90` 是实测校准的，不是拍的**（原设计初值 0.95，**已下调**）。依据 5 条真实 Boss直聘 JD（`test-fixtures/jd/sample-1..5.txt`）的两两矩阵：跨职位最高 0.6406（两条语义高度重叠的数据标注 JD，是真实数据里最难区分的一对）→ 余量 0.26；Boss直聘**页脚噪声**（微信扫码分享/举报/全角空格）0.9219、1% 字符扰动 0.9063 → 0.95 会漏检。**若日后样本变化需复校，改阈值前先跑 FP-4 看余量。**
2. **CJK bigram 改造是必做项不是优化项**：上游 SimHash 按空格切 token，无标点中文归一化成单一巨 token → `tokens<3` → **空指纹、永不匹配且无提示**。改造后无标点中文指纹非空。**FP-7 是这个缺口的回归哨兵，fixture 必须用无标点纯中文**——用带标点的 fixture 测是假绿（标点被折成空格，上游原版照样能过）。已用「关掉 `bigramize` 看断言是否转红」验证过是真哨兵。
3. **`CJK_RUN` 正则必须写 `\u` 转义**：`/[㐀-鿿豈-﫿]{2,}/gu` 用 Write 和 Edit 工具写都会把 U+F900 归一化成 U+8C48，**且落盘范围变成超集、中文照样能切、测试照样绿**——只有码位比对能发现。正确写法 `[㐀-鿿豈-﫿]{2,}`（用 python3 字节级写入）。

### 上游同步纪律

来源 career-ops-hq/career-ops @ `090f787e2499f4fd29b615272946c99dfcab1c28`（MIT）。**同步只 diff `fingerprint-core.mjs` 一个文件**（每季度或遇 bug），diff 后**必跑 FP-7**（CJK 哨兵）。`repost-check.mjs` 是本地自写薄壳，无同步负担。设计/计划文档：`dev-docs/2026-10-18-career-ops-jd-fingerprint-{design,plan}.md`。

### 2026-10-18 二轮深度审查遗留登记

**已修（4 项）**：见 commits `eb6718b`（JD 指纹 4 阻塞+3 可选）、`04ba507`（FP-11 渲染层 + ReDoS + S3-C 断言行为化）、本 commit（中文数字）。

**中文数字护栏的刻意取舍（重要，改 `job.mjs` 前必读）**：

`NUM_RE` 现在认中文数词，但**中文数词必须含百/千/万/亿才算「可核对数字」**。原因：中文里「三段经历」的序数与「三十人」的规模量词**形态完全相同，正则无法区分**。

| 场景 | 处理 | 理由 |
|---|---|---|
| 「十二万→十五万」「三千万→四千万」「两百→三百」 | 🔴 拦 | 业绩造假主路径，含大数单位 |
| 「三段经历」「三部分」 | ✅ 放行 | 否则 generic 要点天天误报（S4B-5 实测会红），用户会关掉护栏 |
| 「三十人→五十人」 | ⚪ **漏报** | 不含大数单位，形态上与序数不可分。**已知且刻意**，漏报优于误报 |

要扩大覆盖就得引入语境判断（如「团队/规模/编制」邻近词），那是另一轮的事——改前先想清楚会不会把「三段经历」重新变成误报。

## 批次2：岗位快速评估（2026-10-19，已实现并经真实模型验证）

**做了什么**：粘贴 JD → AI 一次调用 → 前置快筛报告（1–5 分 + 结论 + 逐条匹配 + 缺失能力）→ 高分一键转 S4a 完整适配。评估记录存 `evaluations.json`，并作为**指纹比对第五路**（建草稿时提醒「这个岗位评估过 4.5 分 apply」）。

- 新增 `eval.mjs`（92 行：`buildEvalPrompt` + `parseEvalReport`）
- 新增路由 `POST /eval/create`、`POST /eval/promote`（已登记 `ROUTES_FROZEN`）
- UI：首页岗位表单内「🧭 先评估」按钮 + 报告卡片（**未新建独立页**，照设计文档）

**真实 MiniMax 实测**（`MiniMax-M3.1-Flash-Preview` + max 思考，104 秒）：

| 验证点 | 结果 |
|---|---|
| JSON 契约被遵守 | ✅ 完整结构化报告 |
| 12 条 matches，weightFrom 如实标注 | ✅ |
| **evidence 逐字子串** | ✅ **10/10 命中真实简历原文，0 条编造** |
| score/verdict 一致 | ✅ 3 分 / caution，无矛盾 |
| 判断质量 | ✅ 感知算法背景投标注管理岗 → 判 3 分 caution，指出学历不符 + 缺管理经验 + 驻场问题——判断正确 |

**三道护栏（都是这轮补的，不在原设计里）**：

1. **score 越界 → 整份报告作废**。score 是这个功能的全部结论，用户照它决定投不投；错分的代价远大于白做一次。
2. **verdict/score 矛盾 → 以 score 为准回落**。prompt 硬约束禁止「score<4 却 verdict=apply」，但模型不听是常态。一致的组合原样保留，**包括「4.5 分但 verdict=caution」这种保守判断——不被 score 提升**。
3. **evidence 子串验证**（只对 `status='covered'`）。模型编一段像简历的话，用户在 UI 上无从分辨，与本项目事实护栏的核心承诺直接相反。验证不过 → 清空 evidence + 降级 `partial`。sourced（声称来自素材）/ partial / missing 不参与。

**`level` 语义必须写进 prompt**（本轮补）：原 schema 只给 `"level":"under|right|over"` 三个枚举**没说含义**，模型只能瞎猜。已补硬约束第 6 条（under=简历资历**低于**岗位要求 / right=恰好 / over=高于），UI 文案同步改为「低于岗位要求 / 恰好匹配 / 高于岗位要求」——写明方向，不只给档位名。

**promote 复用 `createJobDraft()`**：`/job/create` 与 `/eval/promote` 调同一个函数，去重判定/快照冻结/指纹护栏/meta 落盘只有一份。改草稿创建逻辑只改一处。

**⚠️ 备份改动（踩过的坑）**：`/backup` 的 tar 清单原本硬编码文件路径，而 `evaluations.json` 首次评估前**根本不存在** → tar 遇到不存在的路径**整包失败** → 备份功能直接 500。已改为按 `existsSync` 过滤 JSON（目录不过滤，启动时必在）。**加任何新的运行时数据文件都要过这一关。**

**遗留**：报告卡片不跨刷新保留（记录在 `evaluations.json`，首页无「最近评估」列表）；耗时文案「1–5 分钟」写死无服务端预估；恢复后 evaluations 的冲突语义照 applications。

---

## ⚠️ 交付纪律补丁（2026-10-19 因连续翻车新增，两条硬规矩）

### 规矩一：改完必须重启真实服务，并用浏览器实际点一遍

**起因**：连续三次「代码写完、隔离实例验证通过、报告说已完成」，但 **launchd 真实服务（7766）从没重启过**——用户看到的是旧代码，等于我给了一个没兑现的功能（他报「设置里看不到思考程度」）。修的时候又连栽三次，全是同一个根因：**只跑 `node --check` 就宣布完成**。

| # | 错误 | 怎么暴露的 |
|---|---|---|
| 1 | 设置页用了 `esc()`，但该页只有 `escAttr()` | 点「测试连接」→ `esc is not defined` |
| 2 | `onclick="pickModel(0,"` 被双引号截断（`JSON.stringify` 的引号与 HTML 属性冲突） | 点按钮无反应 + 控制台 `SyntaxError: Unexpected end of input` |
| 3 | `modelButtonsHtml(p)` 漏传 `i` → `data-pi="undefined"` | 第二次切换报 `Cannot read properties of undefined` |

**硬规矩**：
- **前端改动必须用浏览器实际点一遍**才算完成。`node --check`/`grep` 只能证明代码能解析，**不能证明它能跑**。
- **改动提交后必须 `launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server"`**，并提示用户 `Cmd+Shift+R` 硬刷新，否则他看到的永远是旧代码（这与纪律 §3「改服务端 JS 后旧标签页跑旧逻辑」同源，但更隐蔽：不是标签页，是**服务进程本身**）。
- 端到端验证一律用**隔离实例 + 真实浏览器**，`curl` 只够看 HTTP 状态码，看不见控制台报错。

### 规矩二：`<datalist>` 在 input 已有值时不可用，别再用它做选择器

实测：模型名一旦填进 input，datalist 下拉就点不开、换不了模型（同理思考程度）。**设置页的选择器一律用**：
- 固定少量选项 → `<select>`
- 服务端返回的动态列表 → **可点按钮组 + `data-*` + 事件委托**

事件委托还有一条硬要求：**不要用内联 `onclick` 拼 JS 字面量**（`JSON.stringify` 的双引号会截断 HTML 属性），改用 `data-pi`/`data-pm` 索引 + `document.addEventListener('click', ...)` 委托。回归哨兵见 `test-structure.sh` 的 S4B-14（含「不得出现内联 onclick 拼字面量」「按钮组重建必须传对下标」两条）。

---

## 大模型链路现状（2026-10-19 实测，替代原 §4 的「无可用模型」）

**当前配置**：MiniMax · `https://api.minimax.cn/v1` · `MiniMax-M3.1-Flash-Preview` · `reasoningEffort: max` · `timeoutMs: 600000`。API 连通已实测（`content` 正常返回）。

**⚠️ max 思考的真实成本**（实测，不是估算）：

| 项 | 实测值 |
|---|---|
| 岗位适配 prompt 规模 | 39890 字符 ≈ **27K token**（简历全文 + JD） |
| max 思考产出 | **21506 token** |
| 单次耗时 | 276 秒（真实适配）／160s／265s／简单 prompt 5.68s |
| `high` 对照 | 4.02s vs max 5.68s（简单 prompt） |

**换模型或调 effort 前必看**：max 下一次岗位适配要等 4–5 分钟，属预期不是卡死。嫌慢就把设置页「思考程度」改 `high`。

**已修的两个坑**：

1. **`reasoning_effort` 落地**（补上原 §4 记的「未实现」）。答案是 MiniMax——官方文档明确支持 `low/medium/high/xhigh/max`，默认 `max`；当初用户说的 max 就是这家。实现为 **profile 级可选**（设置页新增输入框），**有值才发该参数**：不是所有厂商认这个字段，本文件已因硬编码 `temperature` 让 Kimi 报过 400，同一个坑不踩第二次。
2. **`withRetry` 判定有真 bug**（原实现 POST 只在 `e.status >= 500` 时重试）。但**网络层失败（`fetch failed` / 超时）根本没有 status**，`undefined >= 500` 为 false → **最该重试的「请求没送达」反而不重试**。现象：max + 27K prompt 的长请求偶发断连（实测 302 秒后 `fetch failed`），一次断连整个岗位适配就失败。
   改为 **POST 只重试网络错误（`status === undefined`），不重试 5xx**——5xx 可能已计费，重发就是重复扣费（POST 重复计费比失败更糟）。

**本轮（第三轮）已修**：

| 项 | 位置 | 要点 |
|---|---|---|
| 🟡 | `javascript:`/`data:` 存储型 XSS | 新增 `safe-url.mjs`（URL 协议白名单）。**双重防护**：`/app/add`+`/app/update` 写入时清洗；渲染点也过滤（覆盖存量脏数据，实测绕过写入层直接改 applications.json 注入仍被拦并显示提示）。`/app/update` 的批量赋值 for 循环也要单独处理——它是第二个写入入口，漏一个就是缺口 |
| 🟡 | `/restore` 解压炸弹 | 新增 `restore-guard.mjs`。**只用绝对上限 256 MB，刻意不用压缩倍率限**——见下方踩坑 |
| 🟡 | `extract.mjs` 标签剥离二次方 | 原正则 `/<(?:[^>"']|"[^"]*"|'[^']*')*>/g` 从每个 `<` 起点回扫到文末。实测 2000→64ms / 4000→254 / 8000→1065 / 16000→4131（每档 4×）。改为单遍扫描 `stripTagsLinear()`，32000 个未闭合标签 **7.9ms**（500×）；**15 个样本（真实简历 + 11 种边界形态）逐字节对照一致** |
| ⚪ | `/job/create` JD 无长度上限 | 提到模块级 `JD_MAX_CHARS = 64 KB`，**三个写 jd 的入口全部截断**（`/job/create`、`/version/create`、`/app/add`——二轮审查只点了第一个，实际三个都漏） |

**本轮踩的三个坑（都值得记）**：

1. **压缩倍率限会误拒自己的备份**。原设 50× 上限，结果 `test.sh` 的「自产备份预览失败」红了——实测本项目的正常场景（60 份高度相似快照）压缩比就达 **40.5×**，逼近阈值。**多版本快照是 /save 的常态**，倍率限天然打不中自己的正常数据。改用绝对上限 256 MB（真实备份 4.19 MB，余量 61×；炸弹 442 MB / 314.9 MB 被拦）。已加反向哨兵断言「不得引入倍率限」。
2. **`tar tzvf` 不能直接替换 `tar tzf`**。tzvf 每行带 权限/用户/组/大小/日期，整行当路径校验会把**所有**备份包全拒。正确做法：路径继续用 `tzf`（纯路径），尺寸另跑一次 `tzvf` 求第 5 列。已加两条断言钉住这个形状。
3. **`tar tzvf` 的列布局两平台不同**：bsdtar(macOS) 是 `权限 链接数 user group size`，GNU tar(Linux) 是 `权限 user/group size`（无链接数列）。正则只匹配前者 → **Linux 打的合法备份包会被 fail-closed 误拒**。已用 `^\S+\s+(?:\d+\s+)?(?:\S+\s+){1,2}(\d+)\s` 兼容两者并加断言。

**一个审计陷阱（比 bug 更隐蔽）**：`editor-shell.js` 含 NUL 分隔符 → `grep` 静默跳过整个文件，任何 grep 式审计必须加 `-a`。同理：**改 `server.mjs` 里跨多行的长块时，python 脚本的 assert 失败会在写盘前中止**——如果脚本里有两处替换，第一处成功第二处失败，结果是**两处都没生效**（文件根本没写），而下一次改动又基于旧内容继续做，看起来"改了但没反应"。改完必须 `node --check` + 端到端实测，不能只看脚本退出码。

**本轮判定为「不修」的两项（附理由，防下轮重复讨论）**：

| 项 | 不修理由 |
|---|---|
| `GET /pdf` / `/export` 的 Origin 绕过 | CSRF 门的设计是「无 Origin = CLI 客户端放行」，测试脚本和 curl 都依赖它。加 `Sec-Fetch-Site` 挡跨站会**误伤合法场景**（用户从邮件/聊天里点「打开你的简历 PDF」链接 = 跨站导航到 localhost）。危害仅是任意网站可盲触发**幂等**渲染（同一正文渲染同一 PDF，不改数据），影响是资源消耗而非泄露。收益 < 误伤成本 |
| `/ai/jd-text` 的 SSRF 原语 | **这本身就是功能**（粘贴 JD 链接抓取岗位描述）。CSRF 已挡死网页触发路径，剩下的只有「用户自己粘一个链接」——那正是功能预期行为。要「修」只能砍功能 |

**未修（按优先级，等拍板）**：

| # | 问题 | 位置 | 为什么没修 |
|---|---|---|---|
| 🟡 | `/restore` 无解压尺寸上限（0.32MB 炸弹 → 314.9MB，放大 98 万倍） | `server.mjs` 备份/恢复 | 这是唯一能整体覆盖用户真实简历的路径，是数据安全网；改它必须跑满全量场景。修法已验证可行：`tar tzvf` 求第 5 列之和，超阈值拒绝，**任一行解析不出 size 就 fail closed** |
| 🟡 | `extract.mjs` 同型二次方回溯（1482ms vs 正常 0.4ms） | `extract.mjs:122` `matchingClose` | **不能顺手加定量**：`/edit` 页面里 `<img src="data:image/png;base64,…">` 属性可达数十万字符，加上限会把 base64 当正文提取出来，改坏 AI 上下文。要真正线性化得换单遍扫描器（`removeElements` 那种），改动面大且要重跑全部提取相关用例。**单开一轮做** |
| 🟡 | `app.link` 未过滤 `javascript:` 协议 → 存储型 XSS | `server.mjs` 投递记录 | 修法是一行：写入时校验 `https?://` 开头。触发需用户自粘 `javascript:` URL，概率低但后果是简历外泄 |
| ⚪ | `/job/create` 粘贴 JD 无长度上限（链接路径 cap 4000 字，粘贴路径无 cap） | `server.mjs:1481` | 实测 6 次 2MB JD → docs-meta.json 涨到 12.59MB。建议 cap 到 64KB |
| ⚪ | `GET /pdf` / `/export` 的 Origin 绕过（跨域 `<img src>` 不带 Origin） | `server.mjs:1327` | CSRF 门只拦带 Origin 的请求。渲染幂等，影响有限 |
| ✅已修 | `quote` 子串校验语义弱 | `evidence.mjs` | 加最小长度护栏（6 字，挡「负责」「完成了」这类虚词，保留「负责存储层改造」这类有效锚定）。**注意门槛定 6 不是 8**：既有 S4B-3 夹具用 7 字锚定，8 字会误杀它。语义级判断正则做不到，纯编造仍需人眼过 |
| ⚪ | `/ai/jd-text` 是 SSRF 原语（服务端 fetch 任意 http/https） | `server.mjs:2707` | CSRF 已挡死网页触发，只剩用户自粘链接一条路 |

**已实证排除 8 项**（有命令输出，别重复查）：路径穿越 24 种攻击全灭（`VALID_ID` 全局闸门）、tar 条目穿越/绝对路径/symlink 3 种全拒、CSRF 有效（跨站/null Origin 均 403）、服务端 HTML 转义扎实、前端 XSS 0 处可注入、tx 崩溃恢复正确（SIGKILL 实测回滚成功）、rootLock 陈旧判定正确、并发保存无死锁无丢失（50 路全 200 + 双标签 409 冲突闭环）。

> ⚠️ **审计陷阱**：`editor-shell.js` 第 34597 字节是**有意为之的 NUL 分隔符**（`edHashZid()` 哈希输入）。副作用是 `file` 判为 binary、**`grep` 会静默跳过整个文件**。任何 grep 式审计必须加 `-a`。

### 本批次已知遗留

- 老草稿（无 `job.jdFp`）每次创建都要现算 SimHash，历史量大时会变慢——先量到再优化。
- `/version/create` 传 `newLink: ''`，link 精确去重那条路在该入口不触发（该入口 body 无 jdLink 字段），spec 定的行为非缺陷。
- 夹具缺「同公司同岗位的两个版本」（重发检测最真实场景），该场景目前靠 FP-9 合成文本 + Task 5 端到端（同 JD 换公司名 → score=1 命中）覆盖。
- **批次 2（岗位快速评估，AI）未开工**：当前 `config.json` 无可用模型，评估类功能只能 stub 验证。结构就绪后模型到位即插即用。设计见 design 文档 §5。
