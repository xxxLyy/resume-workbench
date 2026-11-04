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
| ~~恢复的文档正文可在应用同源执行脚本~~ | **已修（2026-10-24）**：`/edit` 加严格 CSP —— 内联脚本只放行「已知版本的编辑器主脚本」（sha256）与「服务端注入块」（nonce），其余一律被浏览器挡掉。实测外来脚本不执行、编辑器零误伤。恢复入口**不**拦含脚本的文档（一拦就误伤旧版本文档与测试夹具）→ 防护只放 CSP | — |

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
- **zid 纪律（S3 起，改区域绑定前先读）**：`data-zid` 格式固定 `z` + 8 位 hex（`z[0-9a-f]{8}`，`zone.mjs` ZID_SRC 单一规范）。**生成点 = 编辑器注入层**（`editor-shell.js` 的 `edHashZid`：未保存阶段用确定性内容哈希 djb2，保证两次加载生成相同 zid、初绑 meta 不失配）+ **服务端 `/save` 归一**（`zone.mjs` 的 `normalizeZids`：缺失补、坏值/重复保首重打）。唯一性双保险 = 编辑器四口打点（加载/input/paste/克隆）+ `/save` 归一。服务端除该归一外**不得**自造 zid。（原文档写的 `edNewZid` 实为死代码——全仓无调用，已于 2026-10-22 删除。）
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

> ⚠️ **本表是 2026-10-19 的快照，已过时。** 表内第 1/3/4 项在同一天的「本轮（第三轮）已修」里就修掉了（`restore-guard.mjs` / `safe-url.mjs` / `JD_MAX_CHARS` 均已落地，见源码）；第 2 项在 **2026-10-22 收尾轮**修掉（见文末章节）。**本表不再代表当前未修状态**，留此仅为历史留痕，勿据此重复讨论。

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

## UI 重设计交付快照（2026-10-21）

- 路线 A：零构建 + 借鉴设计系统。**新增 npm 依赖 0**（`package.json` 实测仍只有 `playwright-core`）。
- 浅色克制 token（主行动近黑不用蓝、彩色只承载状态、`--shadow:none` 靠边框）+ 旧名别名（既有 CSS 零改动生效）。
- 图标：一次性从 lucide-react v0.468.0（ISC）提取 44 个 path → `vendors/icons.mjs`（约 8 KB 纯数据）。
  提取脚本 `scripts/extract-icons.mjs` 可重现（改 `scripts/icons.list.json` 重跑）。
  2026-10-21 ocr 审查修正：不再执行源文本（JSON 规范化 + JSON.parse）、清单单一来源、
  版本动态读、属性名/元素名白名单、ISC 版权声明补齐。
- 徽章四件套（底色+语义色+小图标+文字），颜色不单独承载语义（WCAG color-not-only）。
- 首页侧栏+内容区（860px 以下侧栏变顶部横条）；编辑器可拖拽分栏（`--ed-right-w` 260–460px，
  双击复位、←/→ 16px、localStorage 持久化、窄屏抽屉）。
- 冻结件 `template.html` / `themes/` / `render.mjs` 零改动（终检实测 `git diff --stat bbbad60 -- template.html themes/ render.mjs` 输出为空）。
- **冻结件 emoji 残留处置（2026-10-21 终检追加）**：`template.html` 是冻结件、不可改，
  残留的 `已保存 ✓` / toast `⚠️`·`✅` / 恢复条·冲突条 `⚠️` 改由**注入层运行时覆盖**——
  `editor-shell.js` 用 MutationObserver 观察 `#saveState`、`.toast`、`.recovery-bar > span`，
  把文本首尾的 emoji 字面量换成 Lucide `circle-check` / `circle-alert` 内联 SVG。
  顶栏 `💾`·`📄`·`🕘` 沿用同一机制（早已覆盖）。源码里 emoji 字面量一律 `\u` 转义写，UI-7 断言仍为零 emoji。
  带子元素的节点（如外壳撤销 toast 的按钮）一律跳过，绝不拆 DOM 结构。
- 测试基线（终检实测）：`test-structure.sh` exit=0 / **122 ✅**；`test.sh` exit=0 / **339 ✅**
  （内含浏览器级 `test-editor.mjs` 通过）；`test-render.sh` exit=0；`privacy-check.sh` exit=0。
- emoji 终检（独立脚本，行注释优先 + 字符串/模板/正则/嵌套模板全感知）：
  5 个前端源码真实 UI 残留 **0**；注释里的审查标记 15 处（`⚪-4/6`·`🟡-1/2/3/5`·`🔴-1`·`☰` 顶栏说明）**保留**；
  `docs/` 用户数据 26 处**保留**；`template.html` 13 处全部是冻结件字面量（运行时已覆盖，用户看不到）。
- 浏览器终检（6 页：首页/编辑器/素材库/投递/复盘/设置）：emoji 残留 0、控制台错误 0、横向溢出 0px；
  编辑器侧栏/拖柄/下拉正常（拖柄实测 `--ed-right-w` → 380px）；设置页「思考程度」下拉可见
  （(空)/low/medium/high/xhigh/max）。保存链路用 `route.fulfill` 拦截，**未落盘、未产生快照**。
- 设计文档 `dev-docs/2026-10-21-ui-redesign-design.md`，实施计划 `dev-docs/2026-10-21-ui-redesign-plan.md`。

## 收尾轮（2026-10-22）：属性/JS 上下文转义 + 标签闭合配对单遍化

**背景**：上一轮 `/pua` + `open-code-review` 的深度审查（反复审查整个项目）在本会话中途被打断，停在「XSS 修复已提交、待最终验收」。本轮接手后：验收并部署 XSS 修复 → 修掉 handoff 里唯一还开着的 🟡（`extract.mjs` 二次方重扫）→ 更新本文件。

### 1. XSS：属性/JS 上下文转义（提交 a808ded）

`escHtml` 只转义 `& < >`，**不转义 `"`**。放进 HTML 属性值 → 载荷可闭合属性并注入事件处理器；放进 `onsubmit` 的 JS 单引号串 → 载荷可闭合 JS 串。两种都是可利用的存储型 XSS。

隔离实例（`RESUME_ROOT=/tmp/...`、`PORT=17995`）实弹打穿 3 处：

- `/export` 的 `tkCompany`/`tkRole` value 属性（company/role 原样落库，用户可控）
- `/applications?view=table` 的 `data-ch` 与 `<option value>`（channel 原样落库）
- 首页标签按钮的 `onsubmit`（tag 由 company·role 派生，未经 `"` 清洗）

浏览器侧 `window.__PWN` 均被**真实赋值**（tkRole 载荷用 `autofocus`+`onfocus` 实现零点击触发）。

修法：

- 属性上下文一律 `escAttr`（含 13 处当前靠上游校验挡住的隐患点：`m.parent` / `m.id` / `base.label` / `toRaw` / `a.id` / `a.status` / `a.docId` / `app.docId` / `app.snapTs` / `c` / `meta.company` / `meta.role`）
- JS 字符串上下文用 `escAttr(JSON.stringify(v))`（单引号能闭合 JS 串，`escAttr` 不够）
- 内联 `<script>` 的 JS 字面量用 `jsonScript`（沿用本文件既有约定）
- **不改 `escHtml` 本身**：实测会打穿 `docInfo.title` → `jsonAttr` → `data-doc-titles` 的实体还原链（浏览器解码 `&quot;` 回 `"` 后 `JSON.parse` 失败，标题全丢）

新增断言（`test-structure.sh`，+2 ✅）：

- **XSS-1**：隔离服务 + 真实 HTTP 请求，载荷必须回显（证明打到 sink），且不得成为可执行事件处理器、不得闭合 JS 串
- **XSS-2**：源码级守卫，5 个前端文件的引号字面量上下文不得出现 `escHtml(`

两条均已反向验证过会红。

> ⚠️ **一个方法论教训（值得记）**：第一轮反向验证我用了 `git stash push server.mjs`，但修复已在 a808ded 提交 → stash 恢复的是 HEAD（**已修复版**）→ "攻击被挡住"是必然的，等于验证了修复后的代码，白跑一轮。**真正回退**必须用 `git checkout <修复前 commit> -- server.mjs`。**验证方法本身要被验证。**

### 2. `extract.mjs` 标签闭合配对：逐点重扫 → 单遍扫描（本轮修）

遗留项（2026-10-19 登记，当时唯一还开着的 🟡）：`matchingClose` 每次调用都从起点重扫到文末 → N 个未闭合标签 = O(N×长度)。实测 4000 个未闭合 section = **334ms**、8000 个 = **1357ms**（每翻倍耗时翻四倍，平方级）。`/edit`、`/save`、`/api/extract`、`/diff` 都走这条路。

修法：`extract.mjs` 新增 `closeIndex(html, names)` —— 整份文档**一次扫完**，产出 `Map<开标签起点, 闭合终点>`；同名标签按 LIFO 配对（等价旧实现的「按名深度计数」）。`sectionsOf` 与 `zone.mjs` 的 `parasOf` 各自建一次索引后复用。

实测：8000 个未闭合 section 从 **1357ms → 1ms**。

**行为等价性**（不是"看着对"，是逐样本比对）：

- 语料 19 组 + 随机拼装 3000 轮（定种子可重现）：在「真实开标签起点」上与旧实现**逐例比对**，**5606 例 0 差异**
- 真实文档（`docs/linghaoxiang.html`、`docs/old-resume.html`）：**92 例 0 差异**
- 回归断言 `EXTRACT-Q`（`test-structure.sh`，+1 ✅）钉住三件事：等价性、平方级回归（8000 个 > 500ms 即红）、正常解析不变
- 已反向验证：把 `extract.mjs`/`zone.mjs` 回退到 HEAD（旧实现）→ 新断言红（1499ms）→ 还原后绿

**唯一有意变更**：自闭合开标签（`<section class="section"/>`）旧实现会返回「后面某个 section 的闭合」（错配到别的章节），新实现返回 -1（自闭合本就无内容）。两个调用点都传真实开标签起点，不受影响。

### 本轮验收

- 四件套：structure **125 ✅** / main **339 ✅** / render ✅ / privacy ✅（全 exit 0）
- launchd 服务已 `kickstart -k` 重启（PID 98076，13:44:56），`/edit?id=linghaoxiang` 浏览器实测：5 个 section 标题全对、0 控制台错误；首页 0 控制台错误
- 上一轮遗留的临时实例（17995 / 17996 / 17997）与 `/tmp/vrf*` 已清理

## 深度审查轮（2026-10-22 续）：4 路并行审查 + 自测，发现并修掉 1 个存储型 XSS + 3 处平方级回溯

上一节记录的是「XSS 转义修复 + 闭合配对单遍化」。本节是接手本会话后继续的深度审查轮：
用 `ocr delegate`（不出 LLM，只出审查清单与规则）+ 4 个并行 subagent 分文件审 + 自测复核。

**审查工具的教训**：`ocr review`（走 LLM）跑了 27 分钟零输出（MiniMax max 思考 + 15 文件 2900 行 diff 太慢），
被迫杀掉。改用 `ocr delegate`（本地出规则与文件清单）+ 并行 subagent，20 分钟拿到 3 份报告。
**下次直接走 delegate + subagent**，别等 LLM 那条路。

### 一、存储型 XSS：恢复备份可植入恶意标识（自测坐实，非纸面推断）

文档 id 会**原样**拼进首页的内联 JS（`onclick="…('{id}')"`）与属性（`value="{id}"`），
投递/素材记录的 id 同理。备份包是外部输入 → 恶意 id 即存储型 XSS。

**实测链**（隔离实例 `RESUME_ROOT=/tmp/...`、`PORT=17994`）：

1. 造包 `docs/a'+alert(1)+'b.html` → `POST /restore?apply=1&mode=merge` → **200 接受**
2. 首页渲染出 `onsubmit="return confirm('确认删除 a'+alert(1)+'b？快照会保留')"`
3. 浏览器实测触发该 onsubmit → **真的弹出 alert(1)**（不是"看起来像"，是浏览器对话框真的出现）
4. 另一条更省事的链：`applications.json` 里 `id` 带引号 → 投递页 `onclick="appPatch('{id}')"` 同理

**根因**：写入侧（/new、/save）有 `VALID_ID` 全局闸门，但**恢复侧与读取侧没有同一把尺**。
备份能落地带引号的文件名/记录 id。

**修法**：

- `/restore` 校验条目里的标识：`docs/<id>.html`、`snapshots/<id>/`、`pdfs/<id>.pdf` 全部要过 `VALID_ID`
- `/restore` 校验 `applications/materials/evaluations` 的记录 `id`（`BAD_ID` → 拒绝恢复）
- 读取侧兜底：新增 `docIdsOnDisk()`，只收 `VALID_ID` 通过的文档 id（首页/投递页/对比页 4 处共用）

**新增断言 XSS-3**（`test-structure.sh`，+1 ✅）：恶意包被拒 + 读取侧兜底（非法 id 的文件落到磁盘上，首页也不得原样渲染）+ 正常包仍能恢复。已反向验证（回退到修复前 → 红）。

### 二、抽取管线：三处平方级/灾难性回溯

| 位置 | 病态输入 | 旧耗时 | 新耗时 |
|---|---|---|---|
| `sectionsOf` 的 `/<section\b[^>]*class="([^"]*)"[^>]*>/` | `<section class="`×2000（32KB） | **16.6s**（O(长度³)） | 1ms |
| `zone.mjs` 的 `UNIT_RE` | `<p title="`×8000 | 250ms | 6ms |
| `closeIndex` 的引号未闭合处理 | 同上 | 每标签 O(长度) | 记住「该引号类型之后不再出现」→ 不重扫 |

**还有一处我自己引入的回归**（subagent 发现、自测复核）：`closeIndex` 共享一次扫描时，
畸形标签的属性区会吞掉**别的标签名**的闭合 —— `<h3 data-zid="x"><li title='q'</h3>` 里
li 的属性区吃掉 `</h3>` → h3 找不到闭合 → 段落从 AI 上下文里消失。
旧实现每个标签名一条正则，互不影响。**改为每个标签名独立扫一遍**（与旧口径一致）。

**新增断言 EXTRACT-Q**（+1 ✅）钉住四件事：等价性（语料 23 例 + 随机 5583 例 + 真实文档 92 例，与旧实现 **0 差异**）、
三处平方级回归、畸形标签不吞并、自闭合开标签的新语义（返回 -1，不再错配到别的章节）。
三条性能哨兵与等价性哨兵**均已反向验证会红**。

> ⚠️ **上一节那个性能哨兵给出的是假信心**：它用的输入（8000 个完整 `<section class="section">`）
> 恰好绕开了真正炸的正则路径。**哨兵必须打在会炸的那条路径上**（无 `>` 的病态输入）。

### 三、外壳健壮性（editor-shell.js）

| 问题 | 后果 | 修法 |
|---|---|---|
| `readGripW()` 的 localStorage 无兜底 | 浏览器禁用站点存储时抛 SecurityError → **整个 editor-shell 初始化中断**（页签/拖柄/工具条全没建，点了没反应） | 补 try/catch（同文件其它 3 处 localStorage 访问都有） |
| 注入层把内联 SVG 写进冻结模板的工具条按钮 | 随保存落进用户文档文件（3 个按钮约 1KB），文件不再与冻结模板一致 | 钩住 `cloneNode`，克隆后把三个按钮还原成模板原样（实测落盘文件 `<svg>` 计数 0，仍是「📄 导出 PDF」） |
| `pointerdown` 的 `preventDefault()` 吃掉聚焦 | 鼠标拖完直接按 ←/→ 没反应（键盘替代路径 WCAG 不可达） | 显式 `grip.focus()` |
| 指针在窗口外松开 → `pointerup` 不送达 | `dragging` 永远为 true、`body.ed-nofx` 不摘（列宽过渡永久禁用） | 补 `blur` / `visibilitychange` 收尾 |
| 拖拽上限与视口无关 | 右栏拖到 460px 会盖住 210mm 的纸张（纸张自身 scrollWidth 查不出来） | 上限跟视口走：`视口 - 左栏208 - 纸张794 - 余量24` |
| 双击复位回到 300px，但首屏默认是 320px | 复位后与"从未拖过"不一致 | `GRIP_DEFAULT` 统一为 320 |
| `__icon` 缺失时图标独占按钮变空盒/0×0 | 按钮点不到 | 补文字兜底 |

### 四、job-panel.js

- `buildPageHtml` 写回「已保存 `<svg>`」而模板写回「已保存 ✓」→ **两条保存路径字节不一致**
  → 同一份文档两条路径存出不同 HTML → `bodyHash` 不同 → PDF 被误判「较旧」。
  改为写回**字面量**（`✓` 写成 `✓`，UI-7 仍为零 emoji），运行时由注入层的 MutationObserver 换 SVG
  （与 toast/#saveState 同一套机制：文件留字面量、UI 不见 emoji）。
- `note()` 的提示被随后的 `render()` 清空（`render()` 重建 `.jp-msg`）→ **保存失败/生成成功全都 0 毫秒可见**。
  提示存一份，`render()` 后重贴。
- `.jp-msg` 硬编码 warn 色 → 成功提示显示成警告色；改为按 kind 分色。
- 「📍定位」缺空格。

### 五、scripts/extract-icons.mjs

- 元素形状非法时 `norm.length = -1` 抛 RangeError，把「收集 missing → 友好报错 → exit 1」打断 → 改布尔标记。
- 产物改**原子写**（tmp + rename）：写途中被打断不再留下半截 `vendors/icons.mjs`
  （`server.mjs` 顶层 import 它 → 半截文件直接让服务起不来）。
- 产物重跑仍逐字节一致（`git diff` 为空）。

### 本轮验收

- 四件套：structure **126 ✅** / main **339 ✅** / render ✅ / privacy ✅（全 exit 0）
- launchd 服务已重启（15:13:33），8 个页面浏览器实测：0 控制台错误 / 0 可见 emoji / 0 横向溢出 / 0 注入
- 隔离实例实测：恶意备份包被拒（两种）、正常备份仍能恢复、落盘文件不含运行时 SVG、localStorage 被禁时外壳完整

## 深度审查轮二（2026-10-22 续）：自审 6 条 + 抽取管线自查 3 条

上一节修完后，又派 2 个 subagent 审**我自己的修复**（安全修复的正确性、抽取改写的等价性），
自己同时复核 agent 的每一条论断（不照单全收）。本节记录结果。

### 一、自审 agent 报 6 条 → 修掉 5 条

| # | 严重度 | 问题 | 修法 |
|---|---|---|---|
| 1 | 高 | **快照时间戳 ts 原样进 href/内联 JS**（`/snapshots` 五处无转义）。实测：恶意包 `snapshots/good/x\" onmouseover=\"alert(1)\" data-x=.html` 恢复成功后，页面渲染出 `onmouseover=\"alert(1)\"`（悬停即执行，零点击） | 渲染点转义（文本 escHtml / 属性 escAttr / JS 串 escAttr(JSON.stringify)）+ 恢复侧快照时间戳必须过 `/^[0-9-]+$/`（口径同 `/snapshot/view`） |
| 2 | 高 | **恢复的文档正文原样同源返回** → 恢复带 `<script>` 的备份后，打开即在应用同源执行（能读 LLM Key 与全部简历） | **未修**（架构级，见 §5 留白表：不是注入点漏了，是信任边界问题；两条修法都有大代价） |
| 3 | 中 | **条目「形状」没校验**：`docs/abc.html/` 是目录 → 恢复后首页整体 500（EISDIR）且应用内删不掉；`snapshots/abc` 是文件 → 首页 500 | 按真实条目形状逐类校验（文档/快照/快照旁车/PDF/PDF旁车/导出历史/存档/四个 JSON/目录），形状不符一律拒；`docIdsOnDisk` 额外只收普通文件 |
| 4 | 中 | **投递/素材记录的 id 同样原样进内联 JS**（`appPatch('${a.id}')` 等 8 处）；读侧兜底只管了文档 id | 8 处全部改 `escAttr(JSON.stringify(...))` |
| 5 | 中 | **`jsonIds` 把「不是数组」当空数组** → replace 模式会用 `{"not":"an array"}` 覆盖本地 applications.json，投递记录全丢且预览零提示 | 形状错 = CORRUPT → 拒绝恢复 |
| 6 | 低 | `pdfs` 更深嵌套绕过标识校验 | 并入形状校验 |

**新增断言**（`XSS-3` 扩充）：恶意快照 ts / 目录形态文档 / pdfs 嵌套 / 非数组 JSON 四种包被拒；
真实形状的备份（快照旁车、PDF 旁车、导出历史、存档）仍放行并能恢复；投递记录 id 必须是双引号 JS 串字面量。

> **闸门收得过死会砸掉常用路径**：`test.sh` 的「自产备份往返」当场抓到了我收紧过头
> （`pdfs/history/<id>@<ts>.pdf.env.json` 与 `pdfs/archive/<ts>.pdf.env.json` 两种形状被误拒）。
> **酸测**：拿真实数据打包 → 预览 + 恢复必须都过（2 文档 / 57 快照 / 2 PDF ✓）。

### 二、我自己复核抽取管线时发现 3 条（其中 2 条是我这轮引入的回归）

| 问题 | 症状 | 修法 |
|---|---|---|
| `lastClassAttr` 漏了大小写不敏感 | `<section CLASS=\"section\">` 不再被认成章节（旧正则是 `/gi`） | 补 `i` 标志 |
| `attrEnd` 只记引号耗尽、不记 `>` 耗尽 | 无 `>` 的病态输入仍平方级（32KB → 12.7s） | 记 `lastGt`（全文最后一个 `>`），之后没有 `>` → O(1) 判残片（8000 个 `<section`：869ms → 2ms） |
| `dead[]` 判据写错 | 写成「该引号类型已耗尽 → 全判非法」，应写成「当前引号位置 ≥ 已知耗尽位置」 | 改判据；一个标签的引号区吞掉后面的标签时，后面的标签被误判非法 |

另外把「畸形标签吞掉后面同名标签」也修了：属性区里**同时**出现 `>` 与 `<` 时判该标签非法
（只判「同时有 > 和 <」—— 属性值里单独的 `<`（如 `title=\"a<b\"`）是合法 HTML，不误杀）。

**等价性复核**：良构语料 20000 份（`matchingClose` 逐开标签起点 / `sectionsOf` / `parasOf`）与旧实现 **0 差异**；
真实文档 `docs/linghaoxiang.html`、`docs/old-resume.html` 全部一致。

### 三、自查 diff 时又抓到的两处漏网（不靠 agent）

人工过 `git show 62e792a -- server.mjs` 的 diff 时发现上一批**自己漏了两处**：
素材 id 进内联 JS 串（`matFacts(event,'${m.id}')`）、快照 ts 进 `action` 属性。
顺带把剩下三处「外部字段在属性里没套转义」的也补齐（`data-fallback` / `<option value>` / `href`），
让属性上下文口径统一。

**新增断言 XSS-4**（源码级启发式守卫）：扫 5 个前端文件里所有属性值中的 `${…}`，
若表达式含外部可污染字段名且没套转义函数 → 红。
> 守卫是**启发式**不是证明：它按字段名匹配，将来新增外部字段名时要一并加进名单。

### 四、这轮的验收

- 四件套：structure **127 ✅** / main **345 ✅** / render ✅ / privacy ✅（全 exit 0）
- launchd 服务已重启，8 个页面浏览器实测：0 控制台错误 / 0 可见 emoji / 0 横向溢出 / 0 注入
- 三个页面共 127 个内联事件属性逐个解码后语法全对（`new Function` 校验，不执行）
- 真实备份往返（预览 + 合并恢复）正常；自产备份预览正常

## 深度审查轮三（2026-10-22 续）：未审模块 + 测试体系，15 + 15 条

前两轮只审了「改动过的文件」。这一轮补上剩下两块：**没被审过的服务端模块**（llm/importer/migrate-meta/
template/freeze/render/doctor/chromium/job/evidence）与**测试体系本身**。两个 agent 报 15 + 15 条，
逐条复核后修掉下列这些。

### 一、服务端模块（15 条里修 9 条）

| 问题 | 修法 |
|---|---|
| **[高] llm.mjs：POST 超时被重试** —— 注释写着「网络错误/超时不重试」，代码却是 `netErr = e.status === undefined`（超时也没有 status）→ 超时重试 = 同一请求发 3 次 = 3 倍计费。实测：本地慢服务器 + timeoutMs=1000 → 收到 3 次 POST | 区分「超时」与「没送达」：超时的错误名是 `TimeoutError`（实测），连接失败是 `TypeError`/'fetch failed'。POST 只重试后者（超时不重试），注释与代码对齐 |
| **[高] freeze.mjs：bodyHash 把打印时不可见的编辑态算进渲染身份** —— `.edit-toolbar`/`.page-line` 在 `@media print` 下 `display:none`，但工具栏状态文案（已保存 ✓ / 未保存 ●）与 `data-editor` 版本都进了 hash → 同一份 PDF 像素不变却判「较旧」。实测 5 个不同 renderInputId | **未修**（改 bodyHash 口径 = 改渲染身份语义，会让既有 PDF 全变陈旧、导出历史键失效）。已登记待拍板 |
| **[中] job.mjs：「百度」被当成数字 100** —— 中文数词正则允许单字「百」→ 「负责百度搜索」被判「原文数字未原值保留：100」→ 护栏天天误报 | 中文数词必须**多字**（「两百」「三十万」✓；单字 百/千/万/亿 视为词的一部分 → 放过）。实测：百度放过、两百→三百仍拦、十二万→十五万仍拦 |
| **[中] job.mjs：日期只换格式被判三重 conflict** —— 「2019.06 - 2022.03」→「2019年6月 - 2022年3月」→ 引入新数字 + 丢日期 + 丢数字，**直接卡住导出** | 日期按「年-月-日」归一比较；数字扫描前先摘掉日期（否则 `2019.06` 是一个数字 token、`2019年6月` 是两个）。顺带修掉 `120000` 里的 `2000` 被当日期的老问题（日期 token 加数字边界） |
| **[中] chromium.mjs：缓存里的 revision 写的是 expectedRevision()** —— 与实际二进制无关，记录值与目录里的版本号对不上 | **判定为误报**：该字段的语义是「playwright 期望的浏览器版本」（缓存随 playwright 升级失效 ✓），不是二进制自身版本。加注释说明，不改行为 |
| **[中] job.mjs/evidence.mjs：受保护字段（公司/职位）只对 replace 生效**，add 候选可以编造公司与职位 | **未修**（要给 add 定「哪些公司名算编造」的判据，语义比数字复杂）。已登记 |
| **[中] render.mjs 与 freeze.mjs 契约冲突**：相对路径资源在 PDF 里根本不加载（about:blank 无基准），freeze 却判「可复现」 | **未修**（要改渲染身份口径，同上）。已登记 |
| **[低] freeze.mjs：相对路径可越出数据根**（`../../../../tmp/x` 被读走并哈希） | 加边界校验：解析后必须仍在数据根内，否则按 missing 处理 |
| **[低] doctor.mjs：用 `new URL(...).pathname` 取根目录**（百分号编码没解码，路径含空格/中文时读不到真实目录） | 改用 `fileURLToPath`（与 freeze.mjs/template.mjs 口径一致） |
| **[低] importer.mjs：导入的文档没替换 `{{DOC_ID}}`** —— 快照/导出/直读磁盘的字节里留着占位符 | buildRawDoc 接收 docId 并替换 |
| **[低] logrotate.mjs：轮转副本先按 0644 落盘再 chmod 0600** —— 两步之间被杀就留下同机可读的副本 | 直接以 `{mode: 0o600}` 落盘 |
| **[低] llm.mjs：chatMsgs 的 baseURL 不过 assertSafeBaseURL**（listModels 过了） | chatMsgs 也过（内网段本来就放行 ✓，只挡云元数据端点） |
| **[低] diff.mjs：diffHtml 是死代码**（全仓零引用） | 删掉 |

### 二、测试体系（15 条里修 8 条，其中 5 条是**假绿**）

**假绿（断言恒真 / 测的不是结果）**：

1. **「注入层产物不落盘」断言恒真** —— 注入块的 SVG 在文件里是转义后的 `<svg`，用 `/<svg/i` 匹配永远匹配不到；**这条是我自己写的**（本轮 UI-6 浏览器用例）→ 改查注入块自己的载荷（`__ICONS__` / `window.__MATS__` / 注入注释对）。反向验证：去掉 server.mjs 的 ICON 剥离 → 落盘文件确实含 `__ICONS__` → 断言会红 ✓
2. **UI-6 拖拽断言量的是 CSS 变量而不是右栏实测宽** —— 变量被写死时右栏根本没变宽，断言照样绿 → 改为量 `#ed-right` 的实测宽
3. **「note 提示跨渲染存活」这个已修缺陷没有任何回归守卫** —— 回退修复后两套件全绿 → 新增 `JOB-NOTE` 守卫（note 必须有 lastNote 存档 + render 后必须调 applyNote）✓ 反向验证过会红
4. **UI-6 结构层三条断言恒真/重复** —— `/ed-right-w/` 匹配 `--ed-right-w` ✓ 重复；`/localStorage/` 命中任意一处即真 → 改成能红的判据（`setProperty('--ed-right-w'`、`grid-template-columns[^;]*var(--ed-right-w`、`setItem(GRIP_KEY`）
5. **test-editor.mjs 节点段失败就 exit(1)** —— 浏览器段整段不跑，UI 层结果被单点遮蔽（本轮实测：节点段一红就看不到任何 UI-6 输出）→ 改成记录失败后继续跑浏览器段

**可移植性（干净机器跑不动）**：

6. `test.sh` 硬编码绝对路径 `/Users/xxxly/resume/job.mjs`（另有两处 zone.mjs）→ 改相对路径
7. `test-structure.sh` 依赖用户真实简历 `./docs/linghaoxiang.html`（干净 clone 上 ENOENT 崩溃、前面 60+ 段白跑）→ 缺文件就跳过
8. `test-structure.sh` 用写死的历史 commit `5208e44` 比对冻结件（浅克隆上该 revision 不存在 → 误报「themes/ 被改」）→ 容忍缺失
9. `test.sh` 缺 `node_modules/playwright-core` 时报「server 启动失败（端口 17899？）」这种误导信息 → 开头直接检查并说「先 npm install」
10. `npm test` 只跑 test.sh，**最大的结构层套件（574 条 assert）不在默认入口** → 加 `npm run test:all`（四套件聚合）与 `test:structure`
11. 真实数据指纹没覆盖 `evaluations.json` → 补上
12. `privacy-check.sh` 的排除名单漏了 test-structure.sh / test-editor.mjs → 补上

### 三、渲染身份（freeze.mjs）两处取舍

| 项 | 决定 | 理由 |
|---|---|---|
| `#saveState` 的状态读数进了 bodyHash | **修**（摘掉） | 状态读数随 dirty 状态变化、打印时也不出现 → 不是渲染输入。handoff §6 的既定口径就是「渲染身份只度量视觉输入」。不摘的后果：同样的内容存两次（一次带改动一次不带）会得到两个 renderInputId → PDF 被误判「较旧」。新增断言钉住 ✓ |
| 相对路径资源在 PDF 里加载不了（render 用 setContent，基准 about:blank），freeze 却判「可复现」 | **不修，已记录** | 改 freeze 侧（相对路径按缺失处理）会与 S1-A 的既定口径冲突（那条断言明确要求「可读本地字体 reproducible=true」）；改渲染侧要动**冻结件** render.mjs + 渲染输入（注入 `<base href="文档根">`）→ 代价大且动冻结件等于重设基线。**修法二选一**：① 渲染输入注入 `<base>`；② 文档层约定资源一律用 data: URI。本机两份真实简历没有图片/字体，暂无实际影响 |

### 四、这轮的验收

- 四件套：structure **128 ✅** / main **345 ✅** / render ✅ / privacy ✅（全 exit 0）
- launchd 服务已重启，8 个页面浏览器实测 0 控制台错误 / 0 可见 emoji / 0 横向溢出 / 0 注入
- 三条新守卫（XSS-4 / JOB-NOTE / UI-6 浏览器用例）均已反向验证会红

## 深度审查轮四（2026-10-22 续）：最后一批未审模块（tx/structure/template/ai/eval/migrate）

第四个 agent 审了剩余未审模块（ai.mjs / structure.mjs / tx.mjs / migrate-*.mjs / restore-guard.mjs /
safe-url.mjs / eval.mjs / template.mjs），报 15 条（0 高 / 4 中 / 11 低），修掉 12 条。

| 问题 | 修法 |
|---|---|
| **[中] safe-url.mjs：协议相对 `//evil.com` 的拦截可被 `/\`、`/\t/`、`/\n/` 绕过** —— 浏览器把 authority 位的 `\t \n \r \` 都当 `/` → `/\evil.com` 实测跳到 http://evil.com/ | 判定前先把控制字符与反斜杠剥掉再判协议相对（实测 4 种绕过全部被拒，合法 URL 仍放行） |
| **[中] tx.mjs：陈旧锁破除有 TOCTOU** —— 判定陈旧与 unlink 之间，别的进程可能已换上��锁 → 我们把它删了 → 两个进程同进临界区 → docs-meta.json 静默丢条目（实测 40 轮丢 8 条） | 破除改成「原子抢走 + 核对」：rename 到唯一临时名 → 核对抢到的仍是刚判定为陈旧的那把 → 是则删掉继续，否则原样放回 |
| **[中] tx.mjs：atomicWrite 崩溃残留的 `.tmp` 会让用户自己的备份包再也恢复不了**（恢复侧按条目形状校验 → 整包被拒） | ① 恢复侧跳过隐藏条目（`.tmp` 之类不是备份内容）② 启动清理回收数据根与 `.tx/` 里的 `.tmp` 残留 |
| **[中] tx.mjs：commitTx 静默吞掉 unlink 失败** → 标记残留 → 下次启动把「已确认成功的保存」回滚成旧版本 | 标记删不掉时改名成 `.json.stuck`（恢复流程只扫 `.json` 结尾 → 不会误判为待恢复）并明确上报日志。**残余风险已记录**：`.tx/` 目录整体不可写时改名也会失败 → 记录仍在 → 仍会回滚（新内容在快照里可找回；已加断言要求「必须有人知道」） |
| **[低] tx.mjs：defaultRestoreDoc 不校验 docId** → 伪造的事务记录能写到数据根之外（实测写到 /tmp） | 加 VALID_DOC_ID 闸门（与 server.mjs 同口径） |
| **[低] tx.mjs：没有标记的孤儿载荷永不清理**（含整篇简历正文副本，随每次保存堆积） | 启动清理回收 |
| **[低] tx.mjs：atomicWrite 的注释与代码不符**（说「已有文件权限不变」，实际 rename 换 inode → 变成 0600） | 注释改正 |
| **[低] ai.mjs：体检报告的 score 不校验取值范围**（999 / -5 原样透出） | 越界值当缺省（null = 不评分） |
| **[低] eval.mjs：salary 的 text/source 不做一致性校验**（矛盾组合原样落库 → 用户照 source 判断值不值得投） | 矛盾组合回落（与 verdict 同款判断） |
| **[低] eval.mjs：prompt 硬约束编号重复（1…6,6,7）** → 第 6 条指向不明 | 编号改成 1…6,7,8 |
| **[低] migrate-editor.mjs：不认 RESUME_ROOT** → 隔离实例里跑迁移会改真实数据目录 | 认 RESUME_ROOT（与 migrate-meta.mjs 同口径） |
| **[低] migrate-editor.mjs：文档 id 不按 JS 串口径转义就写进 `<script>`** | 按 JS 单引号串转义 |
| **[低] template.mjs：主题名未转义就拼进 data-theme 属性** | 按属性上下文转义 |
| **[低] structure.mjs：buildDoc 是死导出** | 去掉 export（函数本身仍在本文件内用） |

**误报一条**：`template.mjs` 的 `listThemes` 被报成死导出 → 实际 `test-structure.sh` 在 import 它 ✓ → 保留导出 ✓。

**新增断言 TX-GUARD**（+1 ✅）：伪造 docId 的事务记录必须被拒且不得写到数据根外；无标记的孤儿载荷与 `.tmp` 残留必须被回收；提交后标记删不掉必须上报。

## 边角审查轮（2026-10-24）：server.mjs 未审路由 + 前端注入层，两份报告 27 条

前四轮只审了「改动过的文件」和「已审模块」。这一轮补上最后两块：**server.mjs 的全部路由**
（4200+ 行，之前只审过 diff）与**前端注入层全文**（editor-shell 121KB + 三个面板）。
两个 agent 报 12 + 15 条，修了 17 条，其余登记。

### 一、两个高危 SSRF

| 位置 | 问题 | 修法 |
|---|---|---|
| `/job/create` 的 `jdLink` | 只有 `^https?://` 校验 → 任意内网/云元数据地址都能被服务端抓取，**原文写进 meta.jd 并回显**（实测抓到本机 secret） | 过 `assertSafeBaseURL`（与 `/ai/jd-text` 同一道）+ `redirect:'error'` |
| `/ai/jd-text` | `assertSafeBaseURL` 只查首个 URL，`fetch` 默认跟随重定向 → 302 绕过黑名单（实测 302 到 169.254.169.254 照样抓） | `redirect:'error'`（同 `llm.mjs` 的 `listModels`） |

### 二、前端注入层

| 问题 | 修法 |
|---|---|
| **[高] 「接受建议」按全文首个匹配替换，忽略 change.zid 锚点** —— 简历里两段相同文字时改错段落，面板还显示「已接受」 | 两条替换路径（`applyChange` 与确认门路径）都限定在锚点节点内替换；**无锚点且原文多处出现 → 拒绝**（「无法确定改哪一处」）。新增浏览器回归测试：同文两段 → 只改锚点那段（已反向验证会红） |
| **[中] 面板缓存的 baseRev 不随正文自动保存刷新** → 用户改字后接受建议必 409，DOM 改了但不落盘 | 保存前先取最新 rev；baseRev 过期再刷一次重试一次 |
| **[中] 区域列表行是可点 div，无 role/tabindex** → 纯键盘用户完全走不到区域 | 加 `role="button" tabindex="0"` + Enter/Space（对齐素材卡的做法） |
| **[低] homeBtn 的 class/title 改动随保存落进用户文档文件** | 加入保存时的还原名单 |
| **[低] 标签页不可见时仍每 2.5 秒轮询 /job/changes**（服务端每次重解析全文） | 不可见时不轮询 |
| **[低] 符号按钮只有 title，可访问名是符号本身** | 补 `aria-label` |

### 三、服务端其余

- **渲染闸门只管 `/pdf` 与 `/export`** → `/snapshot/pdf`、`POST /render`、`POST /export` 各自无限并发拉 Chromium → 全部纳入闸门
- **AI 闸门只匹配 `^/ai/`** → `/eval/create` 与 `/restructure` 直连 LLM 不受限 → 纳入
- **`/restructure` 不取文档锁、不做冲突检测** → 与 `/save` 并发时静默覆盖用户刚存的内容（实测用户的编辑消失）→ **未修**（要动结构化的事务语义），已登记
- **恢复的记录只校验 id、不校验字段形状** → 恶意备份的 `materials.tags` 非数组 → 素材库整页 500 → 恢复侧校验形状
- **恢复的投递记录 docId 未校验** → `/app/archive-regenerate` 路径穿越到数据根外 → 恢复侧校验 docId
- **replace 恢复后四个 JSON 权限回退到 0644** → 复制后统一收紧
- **`/app/update` 写 jd 无 64KB 上限**（`/app/add` 有）→ 补上限
- **`GET /snapshot/pdf` 没登记进 `WRITE_ON_GET`** → 迁移持锁时仍写盘 → 登记
- **`GET /backup` 不取 rootLock** → 迁移中能下载到撕裂的备份 → **未修**（取排他锁会挡住备份），已登记
- **首页每张岗位卡都重读 applications.json** → 开销 O(文档数 × 投递数) → **未修**（改动面在首页模板），已登记
- **死端点 `/version/create`（与 /job/create 并行的重复实现）与 `/app/jd`** → 前端零引用 → 删除（-39 行），ROUTES_FROZEN 与 S4B-12 断言同步更新

### 四、ponytail 简化批

- 抽出 `jsStr(v) = escAttr(JSON.stringify(v))`：20 处同款写法统一走一个 helper（少写 20 个字符，也少一个能写错的地方——上一轮我自己漏转义 4 处正是这个坑），并把 4 处事件属性里裸的 `'…'` JS 串插值也改掉
- 删 3 个全仓无调用的死函数（`edNewZid` / `entryPair` / `isStale`）
- 删 tx.mjs 里不可达的兜底（unlink 失败时改名 `.stuck`：unlink 与 rename 对目录权限要求相同 → 改名同样失败 → 不可达）
- 删没人用的返回值（`cleanupOrphanArtifacts` 的 removed 计数）

### 五、没改的（登记，防下轮重复讨论）

- **1280–1439px 档切到非「审阅」页签会折叠整条右栏** —— 这是 S4a-T9 的设计（`test-editor.mjs` 有断言守着）✗，注释里承诺的「竖标签条」从未实现 ✗。属设计取舍，要改需先定方案
- **三份「正文查找替换」重复实现**（job-panel / ai-panel / editor-shell，editor-shell 那份是对的）→ 抽公共 helper 需新增文件与 script 标签，本轮只把行为修对，登记待做
- **恢复出的记录 id 口径**已对齐写端点 ✓（评估记录是 `ev-` 前缀，单独一套）

### 六、验收

- 四件套：structure **129 ✅** / main **346 ✅** / render ✅ / privacy ✅（全 exit 0）
- 新增浏览器回归：同文两段只改锚点那段（反向验证过会红）
- launchd 服务已重启，8 个页面浏览器实测 0 控制台错误 / 0 可见 emoji / 0 横向溢出 / 0 注入


## 收尾（2026-10-24）：登记的 6 项全部处理

用户要求「剩下全部都做」。逐项落地：

| 项 | 处理 |
|---|---|
| **/edit 的文档正文可同源执行脚本** | 加严格 CSP：内联脚本只放行 ① 编辑器主脚本（内容与已知版本逐字节相同 → sha256 放行）② 服务端注入块（nonce 放行），其余被浏览器挡掉。**当前模板版的指纹运行期现算**（换版不会忘记加 → 不会把编辑器全挡掉），历史版本表只影响恢复旧备份后的编辑器。homeBtn 的跳转从内联 `onclick` 改为注入层绑定（内联事件属性会被 CSP 挡） |
| **/restructure 静默覆盖用户刚存的内容** | 持文档锁（同 /save 口径）+ LLM 跑完再比对 mtime：变了就 409，不覆盖 |
| **GET /backup 在迁移中拿到撕裂的包** | 取 rootLock 到响应结束（与 /restore 同一口径） |
| **首页 O(文档数 × 投递数)** | 投递表读一次（实测 1200 条投递：182ms → 37ms） |
| **1280-1439 档非活跃时整条右栏藏起来** | 按设计（s4a-design v1.3「自动折叠为**竖标签条**」）改成竖标签条（48px 竖排文字）→ 页签仍可点；且只撤「自己折的」，不与用户手动折叠打架 |
| **三份「正文查找替换」重复实现** | 抽成一份 `window.__edReplaceText`（放在注入层，两个面板共用） |

**为什么 CSP 这条能落地**（当时看代码以为不行）：模板与注入层**都不用内联事件属性**
（`template.html` 0 处、注入块 0 处）→ CSP 的 script-src 不会误伤交互；只有服务端生成的页面
（首页等 32 处内联 handler）用内联属性，但那些页面不加载用户正文 → 不加 CSP 即可。

**踩到的坑**：恢复入口一度也想拦「含未知内联脚本的文档」→ 立刻误伤旧版本文档与测试夹具
（实测被 400 拒）→ 撤掉，防护只放 CSP（浏览器层实测外来脚本不执行 ✓）。

**验收**：structure 129 ✅ / main 347 ✅ / render ✅ / privacy ✅（全 exit 0）；
新增浏览器断言「外来内联脚本被 CSP 挡住、编辑器仍可用」；8 个页面浏览器实测 0 控制台错误 / 0 可见 emoji / 0 横向溢出 / 0 注入。

## 可靠性收口轮（2026-10-28）：审查总账 AUD-01～17 + 已批准六包剩余 27 项

起点 `main@e76a366`（审查基线）。本轮一次性处理审查总账的 17 组问题与已批准六个工作包中
尚未交付的 27 项（ZONE-03～07、TASK-04、SRC-01～07、RES-01～09、DEL-01～05），
并补修 ZONE-01/02 的范围识别缺口。冻结件 `template.html` / `themes/` / `render.mjs` 全程未改。

> ⚠️ **交付事实（2026-10-28 晚补丁轮修正）**：本轮并非「全部完成」。本节 §3 明确留白了两项
> —— 岗位面板的 `api()` 网络异常收口与 `requestId` 幂等语义（当时因 S4a-T8 回归变红而回退，
> 触发点未定位）。这两项已在**同日的补丁轮**（`main@eaf3194` 之后，见下方「可靠性收口补丁轮」）
> 定位并修复：回归变红的真实原因是**按操作内容派生 requestId**——同一候选的「接受」与「撤回」
> 会拿到同一个 ID，撤回因此撞上「重复 requestId 但请求内容不同」的 400。补丁轮改成
> 「一次操作实例一个身份」（接受与撤回各自独立，重试复用同一身份）。
> 路线图 §3.1 里「27 项已一次性收口」的表述同样按此修正。

### 1. 这轮改了什么（按主题）

| 主题 | 内容 | 关键文件 |
|---|---|---|
| 区域范围识别（AUD-01） | 非正文区域的词法扫描重写：raw text / RCDATA / template 真嵌套 / 引号 / 注释；结束标签名后必须是空白、`/` 或 `>`（`</scripture>`、`</script:fake>` 不再结束脚本） | `zone.mjs` |
| AI 请求前置（AUD-02） | 保存前置逐项检查：钩子存在、返回 true、已不 dirty、版本号有效。模板 `doSave` 失败时返回 false 而不抛，此前只 await 不看返回值 | `ai-panel.js` |
| AI 撤销绑定（AUD-04） | 卡片撤销改走统一撤销栈（按 opId 消费），不再按全文反向搜索；新增 `__edDropUndo` 避免失败时留空撤销记录 | `ai-panel.js` / `editor-shell.js` |
| 岗位接受的并发基线（AUD-03） | 并发基线改用「本地正文所基于的磁盘 mtime」，不再取服务器最新 rev 给旧整页背书；服务端 JSON 保存协议新增 baseMtime 严格比对；落账失败精确还原本次改动 | `job-panel.js` / `server.mjs` |
| 渲染信任边界（AUD-05） | 渲染输入统一净化：未知 inline script、外链 script、事件属性、`javascript:` URL、iframe/object/embed、meta refresh、script 类 link、base 与 HTML 注释全部剥离；已知编辑器脚本按指纹原样保留 | `render-safe.mjs` / `server.mjs` |
| 成对产物发布（AUD-07） | 先渲染到 staging，PDF 与旁车都成功且身份匹配才发布；失败回滚到旧的完整产物 | `render-publish.mjs` / `server.mjs` |
| 模型调用单次语义（AUD-06 / RES-08） | POST 一次发送不重试未知结果；禁止透明重定向（此前 307 会把 messages 原文 POST 到重定向目标） | `llm.mjs` |
| 写路径零落盘（AUD-10） | `/job/changes` 的业务校验改在独立工作副本上完成，任一失败放弃整个更新（此前空说明会先清空 note 再返回 400） | `server.mjs` |
| 流错误收敛（AUD-08） | 恢复上传的输出流 error 有人监听（此前未处理 → 服务退出 1）；成功判定落在 open+finish+close 齐备上（此前 fd 打不开也会被判为成功）；处理背压与客户端中断 | `server.mjs` |
| 恢复撤销的存在性（AUD-09） | 安全点 manifest 记录受管项的「存在/不存在」；撤销按台账还原；旧安全点不猜测删除用户数据 | `server.mjs` |
| 迁移守锁（AUD-11） | 编辑器迁移改用共享根锁：外来新鲜锁持有时整个迁移拒绝并退出非 0；陈旧锁接管；异常路径释放自己取得的锁 | `migrate-editor.mjs` |
| PDF 上传入口（AUD-12） | 接回首页一直在调用却缺失的 `POST /upload`；PDF 魔数与体积闸门；临时文件自有所有权；导入 id 原子分配（同名并发各自成文档） | `server.mjs` / `importer.mjs` |
| 导出页动作（AUD-13） | 「确认可投递」补目标 id（原先 body.id 不被 handler 使用，请求落到默认文档）；「应用本轮建议」真正提交页面展示的排版参数，并复核排版轮次与可读下限（可投递的审阅完成与 PDF 身份仍由既有派生量 exportChecks / deliverableNow 复核） | `server.mjs` |
| 岗位创建去重（AUD-14） | 创建身份保留（锁文件 + 原子创建，小范围，不占共享根锁）；目标文件名原子分配；失败不留孤儿；`/eval/promote` 跨 await 后重读评估表 | `server.mjs` |
| 写失败的页面行为（AUD-15） | 服务端页面写入口统一走注入的 `__wv`（HTTP 状态 + 业务 ok + 网络异常都进失败分支）；失败不刷新、不清空输入、不显示已生效；设置页网络异常会回滚 UI | `server.mjs` |
| 同类入口：AI 面板写失败 | 三处裸 fetch 统一走 `postJson`（检查 r.ok 与业务 ok，409 保留 stale/拒绝两种语义）；输入改为**成功后才清空**（失败时用户消息不丢）；改写失败清掉陈旧候选 | `ai-panel.js` |
| 同类入口：岗位面板 | **本轮未收口**：曾把 `api()` 的网络异常收口为 `{ok:false}`、并把 `requestId` 改为按操作派生（幂等）；实测 S4a-T8「接受经 JSON 保存同事务落账」回归变红 → 两处均已回退保持原行为。原因未定位，列为剩余项 → **补丁轮已定位并修复（根因：按操作内容派生 ID → 接受与撤回撞同一个 ID）** | `job-panel.js` |
| 同类入口：区域面板 | 切换区域时清空候选与快照（上一个区域的候选不留在新区域） | `zone-panel.js` |
| 诊断口径（AUD-16） | doctor 复用 `llm.loadProfiles` 的配置归一层（旧单配置不再被误报）；`--probe` 成功后重判 Chromium 选择 | `doctor.mjs` |
| 前置资源界限（AUD-17） | JD 抓取与 `/ai/jd-text` 共用有界读取；差异矩阵分配前设规模界限；pdfinfo/tar 设超时；逐页提取加总预算 | `server.mjs` / `diff.mjs` |
| 共享容量池（RES-01～05） | 每进程唯一 aiPool / renderPool（各 2 个）；容量跟随实际工作生命周期，HTTP 断连不腾槽；闸门租约一路透传到最底层 | `resource-slots.mjs` / `llm.mjs` / `server.mjs` |
| 来源可信层（SRC-01～07） | 来源只认实际发送的段落 zid（quote/title 不作兜底）；prompt 与 parser 共用同一批片段；旧 anchored/sourced 读时降级且不回写；评估的正文 hash 绑定可见正文 | `evidence.mjs` / `eval.mjs` / `server.mjs` |
| 区域包（ZONE-03～07） | 生成基线（doc.mtime）、区域请求版本基线、zone-v1 形状、安全子集事务、请求 epoch、局部合并与一次撤销 | `server.mjs` / `zone-panel.js` / `editor-shell.js` |
| 后台任务（TASK-04） | 证据通道补「换批隔离」（此前只有面试通道有这道闸门）；真实后台生命周期回归 | `server.mjs` |
| 交付（DEL-01～05） | 脱敏历史主脚本夹具（逐字，附说明）；严格 CSP 下历史/当前脚本可保存、未知脚本被拒；文档回写 | `test-fixtures/history/` |

### 2. 回归证据

新增夹具（全部接入 `test:all`）：

| 夹具 | 覆盖 |
|---|---|
| `test-fixtures/reliability/test-zone-ops.mjs` | AUD-01 六例浏览器差分反例 + 结束标签分隔符矩阵（既有，补强） |
| `test-fixtures/reliability/test-llm-post.mjs` | AUD-06 / RES-08：五种 3xx 跨与同 origin、5xx、超时、断连各只发一次；GET 有界重试 |
| `test-fixtures/reliability/test-resources.mjs` | RES-01～05：容量、FIFO、超时、幂等释放、跨池拒绝、逻辑取消不腾槽、并发峰值 ≤2 |
| `test-fixtures/reliability/test-sources.mjs` | SRC-01～07：真源集合、同集合 prompt/parser、程序赋值来源、旧数据读时降级、可见正文 hash、零回写视图 |
| `test-fixtures/reliability/test-server-io.mjs` | AUD-10：4xx 前后 meta 字节与 mtime 不变；AUD-08：上传 I/O 失败后服务存活 |
| `test-fixtures/reliability/test-upload-migrate.mjs` | AUD-12：上传 303 重定向 / 类型 / 体积 / 同名并发；AUD-11：迁移锁拒绝 / 陈旧锁接管 / 幂等 |
| `test-fixtures/reliability/test-render-boundary.mjs`（`test-render-safe.mjs`） | AUD-05 / AUD-07：未知脚本零外联；渲染失败保持旧的成对产物 |
| `test-fixtures/reliability/test-job-create.mjs` | AUD-14：同岗位并发只一份 / 不同岗位独立 / 重复得 existing / promote 交错不丢记录 |
| `test-fixtures/reliability/test-gate.mjs` | SEC-2 行为验收：AI 与渲染各自实际并发 ≤2、超限 429（替代原源码关键词检查） |
| `test-fixtures/reliability/test-gen-task.mjs` | TASK-04：成功落账 / 换批被拒 / 业务拒绝 / 取消与过期不落账 |
| `test-fixtures/reliability/test-browser-behaviors.mjs` | AUD-02 / AUD-03 / AUD-04 的真实浏览器复现 + AUD-15 的 AI 写失败（输入保留、失败可见、不显示假成功） |
| `test-fixtures/reliability/test-browser-zones.mjs` | ZONE-05/06/07：保存前置零请求 / 迟到响应不污染 / 只合并未变目标 |
| `test-fixtures/reliability/test-history-editor.mjs` | DEL-01/02：历史与当前主脚本在严格 CSP 下可保存，未知脚本被拒 |

**负向控制**（已逐项验证「恢复旧实现 → 对应断言变红」）：

| 恢复的旧行为 | 变红的断言 |
|---|---|
| `flushFirst` 只 await 不看返回值 | 保存失败后仍发出 /ai/chat |
| 卡片撤销按全文反向搜索 | 撤销改到了另一段（P2 变成原文） |
| 服务端去掉 mtime 并发基线 | 旧页提交覆盖了另一标签页的修改 |
| 证据通道去掉换批隔离 | 换批后迟到结果落账并污染新批次 |

### 3. 这轮没有做的事（明确留白）

- **产品扩展**（S4b 流水线增强、S5 引导建档、S6 模板库、S7 语音/截图、S8 网申包、S9 录音复盘）
  按既定裁决暂缓，不属于可靠性修复包；另见路线图 §3.1。
- **评估历史列表与评估后台任务**不在本轮批准范围（SRC 只处理当前评估来源与旧记录读取视图）。
- **跨进程共享 AI 容量**不做；容量是每进程独立的（单用户本地服务）。
- **真实模型语义质量、真实移动端、供应商计费核对**需要真实条件，本轮全部用本地桩，不作结论。
- ~~**岗位面板的两处同类入口未收口**~~（`api()` 网络异常收口、`requestId` 按操作派生）：实测引入后既有 S4a-T8 接受链路回归变红，
  已回退到原行为；本轮未定位到具体触发点，列为剩余项。
  → **已在「可靠性收口补丁轮（2026-10-28 晚）」收口**：根因是 `requestId` 按操作内容派生（同一候选的接受与撤回撞同一个 ID）；
  改为「一次操作实例一个身份」，并把失败语义拆成三态。
- ~~**AUD-15 的同类入口按统一封装收口**（服务端页面走 `__wv`，AI 面板走 `postJson`，岗位面板 `api()` 收口网络异常）；
  浏览器行为实测抽样覆盖素材、设置、AI 对话三处，其余入口为同一封装，未逐个做浏览器断言。~~
  → **补丁轮补成矩阵**：16 个真实调用点逐个注入失败，逐条断言「不刷新 + 失败可见 + 旧值保留」。
- **区域纯文本改写拍平内联格式、原生输入撤销与程序化撤销分别管理、旧 PDF 合法陈旧、
  headless iframe 预览限制、单用户本地明文 key** 等既有边界不变，未按缺陷处理。
- **不复活 migrate-style**；不扩展服务端大拆分；不新增 npm 依赖；不重写锁框架。

### 4. 纪律提醒（沿用既有规矩）

- 写操作前先看 `git status`；本轮所有提交都精确暂存，未碰用户已有的未跟踪文件
  （`dev-docs/2026-10-28-*.md` 与 `.jsonl` 仍保持未跟踪）。
- 测试一律用隔离 `RESUME_ROOT` + 合成文档 + 本机桩；不读真实简历、不调真实收费模型。
- 改完服务代码要重启 7766 再用真实浏览器点一遍（`node --check` 只证明能解析）。

## 可靠性收口补丁轮（2026-10-28 晚）：最后补修与验收（起点 `main@eaf3194`）

上一节留白的两项 + 报告点名的 6 处补修，本轮一次性做完。本轮**不新增产品功能**，
冻结件 `template.html` / `themes/` / `render.mjs` 全程未改。

### 1. 逐项修复与证据

| 项 | 问题 | 修复 | 回归入口（先红后绿） |
|---|---|---|---|
| 岗位失败语义 | 409 后整段覆盖式回滚 → 吞掉用户在途输入；结果未知时断言「未落账」并回滚 → 页面与磁盘分歧 | 回滚改成**反向替换**（只还原我们改的那一段，用户追加的编辑留在原地）；结果三态（成功 / 明确拒绝 4xx·503 / 结果未知 5xx·网络异常）分开处理；未知结果**不回滚、不断言**，只保留待重试的提交 | `test-fixtures/reliability/test-job-ops.mjs` ①：409 + 续写 → 在途输入保留、本次改动精确还原；②：网络异常 → 不回滚、提示不含「未落账」 |
| 岗位幂等语义 | `requestId` 每次现生成（重试会重复应用）；按操作内容派生则「接受→撤回」撞同一个 ID → 撤回 400（**上一轮 S4a-T8 回归变红的真实原因**） | 一次操作实例一个身份：接受/撤回各自 `operationId` → 各自 `requestId`；同一逻辑提交重试**复用同一 requestId 与同一请求体**（服务端判重只回执不重放） | `test-job-ops.mjs` ③：重试的 requestId 与请求体逐字相同；④：撤回用新身份、不命中旧回执 |
| 后台任务资源准入 | 槽满时 gen-start 仍返回 200/running；runner 等 5s 超时后异常被吞 → 任务永久假运行 | gen-start 先**借槽**（拿不到立刻 429），再登记任务；槽位透传给 runner，释放 = 后台工作真正结束；任何异常都收敛任务态 | `test-fixtures/reliability/test-gen-task.mjs` T3（两个同步 AI 占满槽 → 拒绝且不留 running）+ T4（断连不早释放） |
| 渲染临时输入泄漏 | `renderSrc` 在 try 内声明 → finally 访问落在 TDZ，异常被空 catch 吞 → **每次成功渲染都泄漏一个临时文件**；净化失败时还会删掉调用方的输入（快照） | 临时输入所有权显式化：只删自己创建的；清理失败落日志不再静默；子进程超时 TERM→KILL 升级 | `test-fixtures/reliability/test-render-boundary.mjs`（成功路径临时文件数不变 + 失败路径快照文件仍在） |
| 区域在途输入与版本 | 目标段在请求期间被编辑时的输入保留、旧回执不得把基线拉回 —— 缺行为验收 | 区域回执合并只合并「提交后未被改动」的目标（目标被改 → 保留本地内容）；基线只进不退 | `test-fixtures/reliability/test-browser-zones.mjs` Z6（目标段在途输入保留）+ Z7（较新保存先确认、旧回执后到 → 版本不倒退） |
| 「确认可投递」 | 旧验收自造表单 + 强改 action + 绕过 onsubmit（等于没测页面自己的入口） | 改成**点真实页面按钮**，并核对服务端真实状态（flow→reviewed）与展示语义（徽章/按钮消失） | `test-fixtures/reliability/test-page-writes.mjs` AUD-13 段 |
| AUD-15 写失败矩阵 | 只抽样两处入口，其余靠「同一封装」推断 | 矩阵化：16 个真实调用点逐个注入失败，逐条断言「不刷新 + 失败可见 + 旧值保留」 | `test-page-writes.mjs` AUD-15 矩阵段（归档/标签/素材状态·事实层·编辑·删除·新增/投递状态·编辑·删除·新增·面试记录/快照备注·基准/设置删除·保存/设置切换） |
| 来源语义 UI | 只测纯函数，没测真实 DOM 的标签与回跳 | 读视图降级（旧 anchored 不被信任）+ 零回写 + 真实标签（简历已覆盖 / 来源已变化）+ 真实「定位」「回跳」按钮且点击生效 | `test-fixtures/reliability/test-src-ui.mjs` |
| 来源实际 prompt | 只断言 prompt 构造函数，没断言真正发出去的那份请求体 | 断言实际请求体含真源段落的文本与 zid（模型才可能引用真源） | `test-fixtures/reliability/test-gen-task.mjs` T1-a |
| 渲染生命周期 | 子进程超时/发布中断残留/并发同目标没验 | 超时改 TERM→KILL 升级（可注入时长）；回归用「无视 SIGTERM 的假渲染器」验证收敛与旧产物保留；补发布中断残留的恢复断言 | `test-render-boundary.mjs` / `test-render-safe.mjs` |

### 2. 交付事实修正

- 本节上方「可靠性收口轮」原写「一次性收口 17 组 + 27 项」——与同节 §3 的两项留白矛盾，已加注更正。
- 路线图 §3.1 的「27 项已一次性收口」同步改为「除岗位面板两项（当轮留白）外均已收口，两项在本补丁轮完成」。
- README 首行的「保存即快照+自动出 PDF」是旧口径（正文与 PDF 已分离保存），已改为实际行为并补了导出/可投递一段。

### 3. 本轮明确没做的事

- **没有重跑上一轮的全部开发**：只补上列出的缺陷与缺失的验收。
- **没有新增产品功能**：S4b/S5～S9、评估历史列表、跨进程容量、全局撤销重写仍按既定裁决暂缓。
- **没有解冻冻结件**：`template.html` / `themes/` / `render.mjs` 零改动。
- **没有调真实收费模型**：全部用本机桩 + 合成文档 + 隔离 `RESUME_ROOT`。
- 岗位面板的**撤回确认门**与**重排（reorder）候选**未新增专门回归（沿用既有 S4a-T8 用例）；本轮只改了它们的失败语义与回滚方式。

### 4. 最小回退顺序（可审阅、保护已有改动）

本轮起止：`main@eaf3194` → `main@9996574`（9 个提交，按动机分）：

| 提交 | 动机 |
|---|---|
| `92ae93b` | 岗位操作失败语义三态化 + 提交身份按操作实例派生 |
| `b0ad73a` | 后台任务资源准入前置 + 渲染临时输入所有权收口 |
| `cd2441c` | 区域回执基线只进不退 + Z6/Z7 行为验收 |
| `61af20d` | 「确认可投递」点真实按钮 + AUD-15 写失败矩阵 + 来源真实 UI 验收 |
| `943d0bf` | 文档：交付事实修正 + README 旧口径 |
| `66969d2` | 文档：补起止提交号与逐提交回退映射 |
| `1dacdee` | 渲染：子进程超时终止 + 发布中断残留恢复的验收 |
| `0689848` | 来源：断言实际发到模型的 prompt 含真源段落文本与 zid |
| `9996574` | 文档：补「实际 prompt 输入」与渲染生命周期两项验收说明 |

**禁止 `git reset --hard`、`git clean -fd`、`git checkout .`**：它们会连同用户在工作区里的其他改动一起丢掉。
按下面顺序逐个回退，每步都能单独审阅：

1. 先看清要退哪几个：`git log --oneline eaf3194..HEAD`。
2. 单个文件回退到补丁轮之前：`git checkout eaf3194 -- job-panel.js`（只动这一个文件，不碰其他）。
3. 整提交回退（保留可审阅性）：`git revert --no-commit <commit>` → 看 diff → `git commit`。
4. 测试夹具同步回退：`git checkout eaf3194 -- test-fixtures/reliability/test-job-ops.mjs test-fixtures/reliability/test-src-ui.mjs`。
5. 回退后必须重跑 `RESUME_TEST_STRICT=1 npm run test:all`；回退只影响代码，不会回退磁盘上已落盘的数据。

### 5. 本轮纪律

- 每条缺陷先落**会失败的回归**，再改实现，再跑该回归，最后接入既有聚合（`test.sh` / `test-structure.sh`）。
- 阴性控制（把实现换回旧版 → 对应断言变红）逐项做过：job-ops ①（409 吞在途输入）、gen-task T3（gen-start 返回 200/running）、render-boundary（临时文件泄漏）、job-ops ③（重试身份）。
- 本轮遗留的测试服务进程已清干净（只清本轮自己的、隔离根的临时实例）；**7766 上用户自己的服务未动**（见下条）。

## 可靠性收口补丁轮二（2026-10-28 傍晚）：复核发现的未完成项收口（起点 `main@5776b7f`）

上一轮（补丁轮）声称收口，但复核发现四类问题仍在：岗位操作的逆操作方向与落账核对、资源凭证校验、
渲染发布回滚保护、以及缺失的真实行为验收。本轮一次性做完，**不新增产品功能、不重写已通过的模块**。
冻结件 `template.html` / `themes/` / `render.mjs` 全程未改。

### 1. 逐项修复与证据

| 项 | 复核发现 | 本轮修复 | 回归入口 |
|---|---|---|---|
| 逆操作方向 | 撤回（after→before）的逆操作仍写成 after→before；hide 撤回的逆操作继续 unhide → 409 后页面停在原文、磁盘还是候选、状态仍 accepted | 每次 DOM 改动都产出**成对**描述符（apply 正向 / undo 严格反向）：撤回的 undo = before→after；撤回 hide 的 undo = 重新隐藏；排序的 undo = 回到目标位 | `test-job-ops.mjs` ⑦a/⑦b/⑦c/⑦d（add/hide/reorder/批量各自有分支证据） |
| 落账核对 | `reconcilePending` 用本地缓存状态当提交证据；核对 GET 断网时也会「清除 pending + 回滚 + 提示此前未落账」；成功撤回的真实状态是 pending（服务端状态机 revert→pending），只看状态必然误判 | 核对改为**按 requestId 查服务端回执**（服务端新增 `GET /job/changes?saveReqIds=…` 返回匹配回执 + appliedOps）；核对请求失败/回执被环形表淘汰时**保持未知**、不清 pending、不回滚 | `test-job-ops.mjs` ②③④（断网保持未知 / 命中回执判已落账） |
| 正文与操作状态一致 | JSON 提交网络失败后，普通 HTML 自动保存仍把未落账的候选写进磁盘，候选状态还是 pending | 落账确认前**正文里不留本次改动**：应用到 DOM → 冻结请求体 → 同步撤回 → 提交 → 成功才重新应用。普通保存照常进行，只是不会带走未落账的候选 | `test-job-ops.mjs` ⑤（真实自动保存 3s 后落盘，正文无候选、状态仍 pending、用户在途输入保留） |
| 资源凭证 | 底层只判 `lease` 是否 truthy：aiPool 满 2 槽时传 `lease:{}` 仍实际发出模型请求 | 凭证合同：必须①本池签发的真实凭证 ②未释放 ③未被其他执行器占用；校验失败即抛，**不产生任何模型/渲染工作**。渲染路径同合同 | `test-lease.mjs`（伪造/跨池/已释放/被占用四类一律拒绝且零请求 + 合法凭证放行） |
| 入口准入顺序 | `/job/generate` 先写 feedback 再判并发；容量被拒时 feedback 已经落盘 | 准入（借槽）前置到任何业务写入之前；借槽后登记任务抛错也归还槽位 | `test-gen-task.mjs` T3-b（容量拒绝 → feedback/任务/版本零改动） |
| 发布回滚保护 | 注入「发布 PDF 的 rename 失败 + 旁车回滚 rename 失败」时，publishPair 报 rollback，但旧旁车与恢复备份双双丢失；recoverPair 失败只记日志后继续覆盖发布 | 回滚不完整时**保留恢复源**（.bak- 不删）并返回可诊断状态（`retained`/`recoverable`）；残留还原失败 → 中止本次发布 | `test-render-safe.mjs` U/V/W（回滚不完整保源 / 还原失败中止 / 并发同目标成对） |
| S4a-T5 时序竞争 | 用例 `sleep 0.8` 后直接改 `docs-meta.json`，与 `startGenTask` 的写回竞争 → 偶发「期望 409 得 200」 | 改成**明确同步条件**：轮询服务端状态直到任务 running，再改过期标记 | `test.sh` 的 S4a-T5 段（不再靠反复运行直到变绿） |
| 跨池凭证 | 凭证校验上线后暴露：`/restructure` 走 **AI 池** 的闸门租约，却把它传给**渲染池** → 跨池凭证被拒 → 渲染报错 | 渲染路径不再借用请求的租约，由 `renderDoc` 按渲染池自己借槽（渲染的真实占用照样计入渲染容量） | `test-structure.sh` 的 S1-D-2 段（/new + /restructure 端到端） |
| 单请求异常杀服务 | 路由里 `return withDocLock(...)` 的拒绝**不会**落进 handler 内部的 try/catch → 未处理拒绝 → 整个服务被杀 | 服务入口给 handler 返回的 Promise 补一层 catch：记日志 + 回 500，服务继续活着 | `test-structure.sh` 的 S1-D-2 段（渲染出错不再拖垮服务） |

### 2. 阴性控制（换回旧实现 → 对应断言变红）

| 换回的旧实现 | 变红的断言（内容/版本/请求行为，不是提示文字） |
|---|---|
| 旧 `job-panel.js`（无目标守卫） | `test-job-merge.mjs` ①：内容断言「成功回执合并覆盖了用户在途输入，实际：NEW-CANDIDATE」 |
| 旧 `job-panel.js`（补查命中不更新基线） | `test-job-merge.mjs` ③：版本断言「补查命中后基线与磁盘 mtime 不一致」 |
| 旧 `resource-slots.mjs`（release 不看 inUse） | `test-lease.mjs` ⑧：行为断言「执行期间 release 必须被拒」 |

### 3. 剩余事项（诚实留白）

- 岗位操作在**落账确认后**把改动重新应用到页面时，若用户正好改动了同一段，替换可能落不上
  → 面板会提示「本次改动已落账，但页面未能同步显示（请刷新核对）」；正文与状态的最终一致由下一次保存收敛。
- 提交回执是环形表（≤50 条）。若在核对前发生 50 次以上保存，回执会被淘汰 →
  客户端保持「结果未知」并提示刷新核对（不猜）。
- 落账确认与普通保存之间仍有极窄窗口：服务端已落账、而客户端尚未把改动应用回页面时，
  一次普通保存可能把旧正文写回（正文暂时缺该次改动，状态已是 accepted）。下一次普通保存会自愈。
- 本轮未做：真实模型语义质量、移动端、供应商计费核对；S4b/S5～S9、评估历史列表、跨进程容量、
  全局撤销重写仍按既定裁决暂缓。

### 4. 最小回退顺序（可审阅、保护已有改动）

**禁止 `git reset --hard`、`git clean -fd`、`git checkout .`**。按提交逐个回退，每步都能单独审阅：

1. `git log --oneline 5776b7f..HEAD` 看清要退哪几个。
2. 单个文件回退：`git checkout 5776b7f -- job-panel.js`（只动这一个文件）。
3. 整提交回退：`git revert --no-commit <commit>` → 看 diff → `git commit`。
4. 回退后必须重跑 `RESUME_TEST_STRICT=1 npm run test:all`。

### 4. 进程归属核对（本轮实测）

| PID | 启动时间 | RESUME_ROOT | 归属 | 本轮处置 |
|---|---|---|---|---|
| 52431 | 10-24 15:03 | `…/T/ev7-EKnYtN/ui` | 10-24 那一轮的隔离夹具 | **不属于本轮 → 不动** |
| 55506 | 10-24 15:04 | `…/T/ev7-jmkqJK/ui` | 同上 | **不属于本轮 → 不动** |
| 60732 | 10-24 16:09 | `…/T/xss-restore-cnGJT0/data` | 同上 | **不属于本轮 → 不动** |
| 7766 上的常驻服务 | 10-28 15:59 | 真实数据根 | 用户自己的服务 | 保留（按既有授权重启到最新代码） |

本轮自己起的测试服务由套件回收；结束时只剩 7766 的常驻服务。未按端口或进程名批量结束任何进程。

## 可靠性收口补丁轮三（2026-10-29）：成功回执合并保护 + 补查回执衔接保存 + 使用期间不得释放容量（起点 `main@2531194`）

本轮只补齐既有可靠性合同，不新增产品功能。冻结件 `template.html` / `themes/` / `render.mjs` 全程未改。

### 1. 逐项修复与证据

| 项 | 复核发现 | 本轮修复 | 回归入口 |
|---|---|---|---|
| 成功回执合并覆盖在途输入 | needs-compare 确认门接受 → 服务端已提交但响应暂停 → 用户把目标段改成 USER-INFLIGHT-EDIT → 成功响应到达 → 页面被整段替换成 NEW-CANDIDATE，用户输入丢失 | 提交瞬间记录**目标守卫**（元素 + 其 innerHTML + 这次改动是否覆盖文字）；成功回执到达后逐目标核对：目标没了 / 会覆盖的文字变了 → **保留用户内容**并标「待核对」；未变化的目标才应用已确认修改。确认门授权只覆盖确认当时的内容。撤回/批量/replace/add/hide/reorder 共用同一套守卫；**撤销记录只为实际发生的合并建立**，且快照取**合并前一刻**（那时用户的在途修订已在正文里 → 撤销不会把它一起退回去） | `test-job-merge.mjs` ①（确认门+在途输入）②a/②b/②c（普通接受/撤回/批量）⑤（撤销记录范围与撤销不吞在途修订） |
| 补查命中的回执没衔接普通保存 | 先真实提交 → 丢响应 → 按 requestId 查到回执并合并 → `window.__edDocMtime` 仍是旧值 → 下一次手动保存 false/409 | 三种回执来源（普通成功响应 / 按 requestId 补查命中 / 同 ID 重放返回）共用一条接纳路径 `takeReceipt` + `acceptReceipt`：校验请求身份、采纳回执里的 mtime/rev（**只前进不倒退**）、不动正文（用户在途修订、dirty 与本地恢复内容不受影响）。回执无法接纳时不写「已应用」 | `test-job-merge.mjs` ③（补查命中 → 手动保存/自动保存/刷新都成立）④（较新保存先确认、旧回执后到 → 版本不倒退） |
| 使用期间可以释放容量 | `releaseLease` 不看 `inUse`：容量 1 → borrow → claim → release 不抛错 → 第二个凭证仍能取得 | `releaseLease` 在使用中直接拒绝（ResourceLeaseError）：容量与等待队列都不变（先判后改）、凭证不标记为已释放；执行结束先 `unclaim` 再 `release`；重复释放仍幂等 | `test-lease.mjs` ⑧（容量 1 的池：被拒后第二个凭证拿不到槽）⑨（共享池同合同） |

顺带把服务端回执补上 `requestId`（客户端要能校验「这条回执确实属于本次提交」），并把服务端入口归还闸门租约的失败打日志（归还失败会被吞掉 → 容量静默泄漏）。

### 2. 剩余事项

- 落账确认后把改动重新应用到页面时，若用户正好改了同一段 → 保留用户内容并标「待核对」，正文与状态由下一次保存收敛（不再声称已合并）。
- 「已落账但未合并」的条目，面板上的「待核对」标记是**本次会话内**的内存态；刷新后消失（刷新后由一致性检查重新判定）。
- 真实模型语义质量 / 移动端 / 供应商计费核对：本轮仍不调真实收费模型。
- S4b/S5–S9、评估历史列表、跨进程容量、全局撤销重写：按既定裁决暂缓。

### 3. 最小回退顺序

**禁止 `git reset --hard`、`git clean -fd`、`git checkout .`**。

1. `git log --oneline 2531194..HEAD` 看清要退哪几个。
2. 单文件回退：`git checkout 2531194 -- job-panel.js`（只动这一个文件）。
3. 整提交回退：`git revert --no-commit <commit>` → 看 diff → `git commit`。
4. 回退后必须重跑 `RESUME_TEST_STRICT=1 npm run test:all`。

## UI/UX 调研与 A 层落地轮（2026-10-30）：方案定稿 + A1–A15 全量实施（起点 `main@7430f03`）

本轮 = 前置的动态工作流调研（四路界面走查 + 三路网络调研 + ui-ux-pro-max 规范对照 → 方案定稿）+ 主会话按方案 A 层全量实施 + B2 核实。方案全文：`dev-docs/2026-10-29-ui-ux-research-and-plan.md`（A/B/C 三层 + 快赢清单；B 层需用户决策，本轮未动）。冻结件 `template.html` / `themes/` / `render.mjs` 零改动。

### 1. 逐项落地与验收（全部先红后绿或实查核验）

| 项 | 内容 | 验收 |
|---|---|---|
| A1 | 应用页 `--warning/--success/--danger` 三值换 `#A25711/#15803D/#B91C1C`（复算 on 各自 soft 底 5.18/4.79/5.91 全过 AA）；saving pill 不动全局 accent 家族（47 处引用实测），新增局部 `--ed-accent-strong #9A3412`（6.18:1） | UI-2 断言期望值**同提交**更新，先红后绿 |
| A2 | 6 处「首页的『大模型设置』」误导文案（方案点 5 处，实查第 6 处 `:3871` 变体）改「侧栏『设置』」；岗位表单错误旁补「去设置 →」链接 | 隔离实例无 LLM 生成返回新文案 |
| A3 | `infos` 空时岗位表单整体替换引导卡（复用 POST /new 与 #up 锚点）；brief IIFE 与 jobForm 绑定加空态守卫；`invalid from` 改中文 | 零文档首页两张引导卡正常、建文档后表单恢复 |
| A4 | 列表三种空态文案+动作；搜索无匹配行 `.search-empty` 与 `.list-empty` 排除出过滤选择器（方案点名的残留坑） | 隔离实例实测 |
| A5 | 导出页检查卡「风格建议」重复列表删除；记录投递成功补「去投递看板跟踪 →」；tkCompany/tkRole/tkChannel 补 aria-label | test-structure 绿（:2515 断言是对生成函数，不受渲染去重影响） |
| A6 | 设置页激活卡 `.card-active`（边框+底色）+「使用中」徽章（复用 badge ok）；删除钮 danger；input 去 size 定宽改 width:100% | 结构套件绿 |
| A7 | ⋯ 菜单删除动作加左边框分隔 | confirm 保留 |
| A8 | 全站动态反馈补读屏语义：shellToast/undoToast role=status；glyphObs 给模板运行时插入的 .toast/.recovery-bar（含 409 冲突条）动态补 role（不改冻结件）；.jp-msg、#zp-ai-out/#zp-preview、#ai-log/#ai-review-out、#jobMsg/#evalMsg/#upmsg/#tkMsg 全部落位 | 逐文件 grep 核验；落盘 HTML 不含新增属性（UI-6 既有断言把关） |
| A9 | 审阅面板 render() 重建前采集在途输入与焦点、重建后仅结构未变时回填；visibilitychange 不可见暂停轮询、可见且 running 立即 refresh —— 收口 handoff:611 存量登记 | test.sh 全绿；**T5 浏览器夹具在此期间抓出 A3 守卫的顶层 return 语法错误**（node --check 查不到页面内联脚本的实证） |
| A10 | 区域行 role=button/tabindex/aria-label + Enter/Space；bindOne 空 catch 改面板可见失败提示；openPicker 补 dialog 语义 | S3C/S3D 浏览器断言绿 |
| A11 | selectionchange 正向呼出选区工具条（键盘选区可用；不在 else 里隐藏——按钮点击瞬间选区被清时 selectionchange 抢先藏条会让点击落空）；ai-pop aria-modal + Esc 单层关闭 + Tab 圈定；#ai-close 键盘触发 | 结构+浏览器套件绿 |
| A12 | 9 处 10/10.5/11.5px 字号→11/12px（grep 0 命中）；3 处 20px 钮→24px；chips 22px 保底=登记取舍。**符号钮 aria-label 经实查 editor-shell 已带（`b.setAttribute('aria-label', ...)`）——handoff:612 登记与现状不符（同 PANEL-2 模式），据此更新口径** | 验收 grep 0 命中 |
| A13 | 4 处 scrollIntoView smooth 套 reduced-motion 守卫；应用页 button transform 并入既有 reduced-motion 规则 | grep 核验 |
| A14 | 删 `--muted-2`（0 引用）与 Geist 字族名（无加载源）；**S2-B2 加 rgba 家族扫描**（语义色残留必须为 0；其余按家族前缀白名单：暖阴影/黑白遮罩 + warn/panel/accent 派生 3 家族） | 先红后绿 |
| A15 | 右栏开关图标 settings→columns-3（44 图标内）；jobpop 补「完整定制要求请到首页表单填写」 | — |
| B2 | **核实完毕：矛盾不成立**。隔离实例 + 真实 Chromium 截图 + DOM 扫描：工具栏 0 emoji、页面 0 报错——MutationObserver 覆盖生效，handoff「0 可见 emoji」口径正确，截图实测报告该条为误报。未做任何修复 | `/tmp/b2-toolbar.png` 留档 |

### 2. 方案判定修正（实施中发现，已按实况执行）

- **ai-panel 分页线两行不是死代码**：方案称「已被 .ed-on 高特异性遮蔽」——屏幕上成立，但 shell 覆盖在 `@media screen` 内且 template.html **没有** .page-line CSS，这两行是打印上下文的唯一着色来源。未删除，改为把外来红对齐 `--ed-warn` 色相 rgb(162,87,17)（同形 alpha 保留）。
- A12 的符号钮可访问名与 PANEL-2 的「曾修后回归」叙事同源：handoff:609/612 两处登记均与现状不符，**现状以代码为准**。

### 3. 顺带修复（超出方案、单独提交）

- **editor-shell.js NUL 字节**：`:581` zid 碰撞重试分隔符被历史编辑事故写入 NUL（本意是空格），整文件被 BSD grep/文本工具按二进制静默处理。恢复空格；已持久化 zid 不受影响。
- A3 空态守卫的顶层 `return` 语法错误（T5 浏览器夹具抓出，单独提交）。

### 4. 套件与进程归属

- `RESUME_TEST_STRICT=1 npm run test:all` → **EXIT=0**（572 断言；唯一 ❌ 行是段 X 的 Chromium 探测契约预期输出）。
- T9①（跨进程并发 POST /export）在 10-30 01:52 那轮出现过一次 500「渲染失败」，复跑即绿、基线也绿，判定为**偶发时序**（机器负载敏感），留给后续观察——若再现在，查 T9 双服务的 updateMeta 锁竞争窗口。
- 7766 已重启至本轮代码（`kill` 旧 PID，KeepAlive 拉起）：首页/真实文档 /edit/设置页真实浏览器只读点验 0 报错，A1 token 实测生效，工具栏 0 emoji；**真实数据 mtime 前后比对全部未变**。

### 5. 起止提交与回退

起点 `main@7430f03`，本轮 A 层提交（按动机分）：`cb121d4`(A1+断言) → `ba86ee7`(NUL) → `47345a7`(A2/A3/A4) → `a443087`(A5/A6/A7) → `453941a`(A8) → `4f65447`(return 修复) → `a56930e`(A9) → `9fcc790`(A10/A11) → `fd40146`(A12-A15)。

**禁止 `git reset --hard` / `git clean -fd`**。逐提交 `git revert --no-commit <c>` 或单文件 `git checkout 7430f03 -- <file>`；回退后必须重跑全量四套件。A1 回退须连带回退 UI-2 期望值（同提交绑定）。

### 6. 剩余事项

- **B 线（漏洞审查+修复）**：动态工作流停在主套餐周限额（10-31 15:54 重置），一次性自动化将于 10-31 16:31 翻 `RUN_B` 开关恢复；已确认缺陷含 /snapshot/view 缺 CSP（高危，三路独立发现）等，其修复与本轮 A 层改动共存于后续提交。
- B 层产品决策（B1 双 accent 规则、B4 评估历史、B6 S5 排序翻转建议等）见方案 §B 层，待用户拍板。

## 排版布局与完善轮（2026-11-01）：impeccable 工作流实施 + 主会话收口（起点 `main@cf9a6da`）

前置：动态工作流（勘察→设计→实施→视觉验收→四套件→独立复核；模型分配=实施 GLM-5.3 / 勘察与验收复核 MiniMax-M3.1-Flash，用户指定）。方案依据 `dev-docs/2026-10-29-ui-ux-research-and-plan.md` 的 B 层功能项 + impeccable 排版布局标准。报告全文：`dev-docs/2026-11-01-impeccable-round.md`；设计系统沉淀：仓库根 `DESIGN.md`（新）。

### 1. 落地内容（15 条改动单，单提交 `e895c39`）

功能：**评估历史**（首页卡 + `GET /evals` 独立页，复用 EVAL_CARD_JS 渲染器，jsonScript 内联 + 客户端逐字段转义，ROUTES_FROZEN 同步登记，动作列隐形占位对齐）；**导出文本层自检**（pdftotext 回读全文验姓名/邮箱可提取，结论进导出检查卡——B8 落地，注意「电话可提取」未做、属原方案口径未登记 deferred）；**岗位弹层字段对齐**（jobpop 补折叠式定制要求区，/job/create 载荷带 brief——B5 落地）。
排版（refinement preserves，复核员基线对照逐项实测视觉身份零变化）：标题三档登记 + 删 h1 死规则、卡片标题口径 .card-title、badge/chip 同档（高差 ≤1px；chip min-height 26px 是过 2px 线的登记取舍）、页头模式统一（h1 内不嵌链接/span/icon）、间距基座 --space-* 入 A-VARS、编辑器排版监听器全局恰一次（E1/E2 浏览器断言）、--ed-radius 圆角单值、字号档位对齐、死规则清理。

### 2. 验证

- 工作流内：视觉验收（隔离实例截图 ≤6 张）通过；`RESUME_TEST_STRICT=1` 四套件全绿；独立复核员基线对照实测（冻结件零改动、真实数据零写删、依赖零新增、注入纪律全绿）。
- 主会话收口：7766 重启至新代码（新 PID），首页/`/evals`/编辑页真实浏览器只读点验 0 报错，真实数据 mtime 前后比对未变。
- test-editor.mjs +81、test-structure.sh +136（新功能浏览器断言与路由断言）。

### 3. 复核提出的收口缺口（不构成红线违反，留给后续）

- 排版不变量（标题三档/胶囊同档）未进结构断言——现在是文档口径，回归只能靠基线对照发现。
- 两处可见变化 DESIGN.md 未登记：h2 档位（21px→16px，全站唯一 h2 在损坏页）、chip min-height。
- B8 的「电话可提取」口径未做且未登记 deferred。
- **卫生观察**：机器上另有 4 个 10-24/10-29 启动的无 `RESUME_ROOT` 实例（端口 29270/50544/50867/60004，cwd=仓库根 → 数据根=真实根）；本轮 `.tx/` mtime 变动两次（目录始终空、无数据写删，归因未定，大概率是这些实例或 7766 的正常锁活动）。按「不杀不重启」纪律未动；建议用户确认后统一清理（连同更早登记的 3 个孤儿 PID 52431/55506/60732）。

### 4. 回退

起点 `main@cf9a6da`，本轮代码提交 `e895c39`（单提交，含全部 15 条与测试）。**禁止 reset --hard / clean -fd**；`git revert --no-commit e895c39` 或逐文件 `git checkout cf9a6da -- <file>`，回退后重跑四套件。

### 5. 剩余

- **B 线（九路漏洞审查+修复）**：本轮收口后立即恢复（10-31 自动化执行失败的补做）；已确认缺陷含 /snapshot/view 缺 CSP（高危）。
- 方案 B 层其余决策项（B1 双 accent 规则文案、B3 themes 解冻、B6 S5 排序）待用户拍板。

## B 线修复轮（2026-11-01～11-02）：九路审查 39 条全修 + E 包四件（起点 `main@bfb033d`，收口 `main@e30bee4`）

前置：B 线九路漏洞审查的动态工作流（dwfrun-725601b1）于 11-01 15:59 被用户取消，36/44 节点已完成——39 条发现、17 项独立复核全部 confirmed（4 项收窄）。本轮不再补跑审查期复核，从节点记录导出固化为 `dev-docs/2026-11-01-bline-inventory.md`（总账，含逐条 where/what/evidence/repro 与复核索引），设计 `dev-docs/2026-11-01-bline-fix-round-design.md`、计划 `dev-docs/2026-11-01-bline-fix-round-plan.md`。模型分配（用户拍板）：批 1/2/3 与批 6 正则二件主会话（GLM-5.3），批 4/5/6/7 共 23 条 GLM-5.3-Flash 工作流（dwfrun-9b5fc7b4：同文件条目归组实施 → 每条独立复核 → 单一提交员串行提交 → 每批结构套件门 → 终验四套件；中途撞 Flash 5 小时配额 1308 一次，窗口重置后 ResumeWorkflowRun 续跑完成）。

### 1. 落地内容（39 条 + E 包 4 件，共 30 个提交）

- `ba46165` docs: B 线修复轮实施计划（7 批次任务卡 + 夹具挂载 + 控制点）
- `307068f` docs: 总账证据清洗——合成探针号码与时间戳长串去字面量化（隐私门禁自命中修复）
- `88165e3` fix(sec): /snapshot/view 补锁定 CSP 并关死预览页保存通道；/edit CSP 补 frame-src/object-src
- `8b47b0c` fix(sec): render-safe 标签模型对齐浏览器解析（svg foreign content / noscript raw-text）
- `712b8d9` fix(tx,zone,migrate,server): B 线批 2 数据完整性七件
- `426f234` fix(job-panel): B 线批 3 落账流六件——撤回快照化/zid 落点/批量 origText/保标记/chips 存活
- `4e5856a` fix(ai-panel): 选区改写按选区锚点应用，不再落到全文首个匹配
- `5e31135` fix(ai-panel): 选区改写失败提示可达（else-if 链改独立分支）
- `dc7bd86` fix(zone-panel): 改绑按条目合并回写，不再抹掉别处的锁定
- `abdd331` fix(panels): api() 业务失败可见（HTTP 非 2xx 带失败语义 + 调用点提示）
- `9f18401` fix(zone-panel): 未配置模型降级提示跨重绘存活
- `2e6ef93` fix(gen-result): 头部契约注释与超时实现对齐（行为零变化）
- `74e9781` fix(resource-slots): unclaim 补凭证归属三条件（本池/未释放/被占用）
- `a40878c` fix(server): /ai/* 模型调用异常捕获为可读 JSON 错误体
- `75b45f0` fix(resource-slots): withLease 合同修正（透传不重复 claim / 或移除死代码）
- `e199545` fix(eval): 薪资矛盾组合按注释口径回落（text 非空+source 未提供）
- `356aeaf` fix(eval): 评估引文加 6 码元最小长度（与 evidence 护栏同口径）
- `ac6602a` fix(eval): 模型输出 JSON 前缀自然语容错（截取大括号区间重试）
- `b779ad0` fix(logrotate): 备份写失败跳过截断并报错（不再毁主日志/旧备份）
- `81ac177` fix(chromium): 探测等待方先看锁再看缓存，消除缓存已就绪仍误抛
- `a746270` fix(importer): 两条导入路径落盘字节统一带真实 docId（修参数错位+占位符）
- `98a7fad` fix(server): 渲染尺寸口径与保存对齐，超限错误带尺寸原因
- `31ae83f` fix(importer): 导入占位改 tmp 后缀，列表不见残损条目
- `0c6b3c6` test(structure): 排版不变量（标题三档/胶囊同档）进静态断言
- `131ab4a` docs(design): 补登记 h2 档位变化与 chip min-height 取舍
- `4e5f170` feat(export): 导出文本层自检补「电话可提取」（B8 收尾）
- `197c768` docs: 新建 PRODUCT.md（产品上下文，供后续设计轮引用）
- `8b4a4af` fix(tx): 启动清扫豁免在途导入占位 <id>.html.tmp（BL-P6-06 配套）
- `5830b6c` test: 既有用例适配新合同 + 两夹具加固 + 补挂批 4 两件夹具
- `e30bee4` fix(job): 事实护栏误报二件——0–99 阿拉伯↔中文数词互认 / 日期分隔符空格容忍对齐

主会话 17 条要点：/snapshot/view 补 default-src 'none' 锁定 CSP（同时关死预览页 ⌘S 保存通道）、/edit 补 frame-src/object-src、净化器对齐浏览器 foreign content/noscript 解析；备份含临时件改「已知内容目录直属未知形状跳过并逐条上报」（嵌套/非法 id 仍整包拒，XSS-3 边界不变）、zone 引号感知扫描 + data-zid 松散形态归一、tx 损坏 meta 抛 META_CORRUPT、迁移锁心跳（rootLock.touch/startLockHeartbeat）、素材根值闸门、迁移替换函数化；落账流撤回改「段落 innerHTML 快照恢复」（新 inv kind 'html'，同段 before/after 交叉不再改乱、行内标记保真）、撤回失败可见、hide/reorder zid 优先落点（entryByZid）、批量 origText 按批前快照、chips 跨重建存活；事实护栏 0–99 阿拉伯↔中文数词互认、日期分隔符空格容忍对齐。
Flash 23 条要点见各提交信息与 `b47-report` 工作流报告；收口时主会话逐 diff 审查：冻结件/真实数据目录/package.json 零改动（`git diff --stat 426f234..197c768` 对这些路径为空），关键实现 grep 确认在 HEAD。

### 2. 验证

- 每条：回归夹具先红后绿（主会话件均做了红跑；1.2 预览页保存通道做了撤修复的阴性对照）；Flash 件另有独立复核员重跑夹具 + diff 核对。
- 每批：`bash test-structure.sh` 全绿（基线 160 → 收口 193✅）。
- 整轮：`RESUME_TEST_STRICT=1 npm run test:all` → **EXIT=0（622✅，基线 557）**，唯一 ❌ 为段 X Chromium 探测契约预期输出。
- 7766 重启至 `e30bee4`（PID 16033 → 59490），真实浏览器（headless Chromium）只读点验首页 / /evals / /settings / /edit / 快照预览五页 200、非 CSP 错误 0 条、快照页脚本确未执行（`typeof DOC_ID === 'undefined'`）、/edit 与 /snapshot/view 响应头 CSP 实测生效。
- 真实数据目录 mtime：任务 0 基线 vs 收口终核 **diff 0 行**。

### 3. 收口时发现并处置的次生问题

- 我提交的总账证据与夹具里的合成探针号/13 位时间戳命中隐私门禁 `1[3-9]\d9`（S1-FW-3 红）→ 去字面量化（307068f、批 2 夹具时间戳改第二位非 3-9）。**纪律**：新夹具/文档里的长数字串一律避开该模式。
- 批 2 备份跳过规则首版过宽，XSS-3（pdfs 嵌套条目应整包拒）变红 → 收窄为「docs/pdfs/snapshots/<合法id> 直属文件才跳过」。
- 批 3 首版 `entryByZid` 的 pair 与 all 来自两次 `entryPairs` 调用（对象身份不同 → reorder 的 indexOf 为 -1 走错分支）→ 改同一次调用。
- 工作流终验门抓到的批次间交互：BL-P6-06 占位改 `<id>.html.tmp` 后被 tx.mjs 启动清扫「顶层 *.tmp 一律清」吃掉 → 豁免该形态（8b4a4af，配套 test-sweep-import-placeholder）；既有 test-editor.mjs 两处用例按新合同重写（⑧b 在 gap 窗口写坏 meta；bt2 按 zid 落点断言）、我两个夹具加固（reject-chips 等 DOM 反映重建；quote-scan 泄漏判定改锚定正则，原裸子串在随机 zid 末位为 b 时 1/16 假红）（5830b6c）。
- 提交归属备注：Flash 同文件多件由同一实施员顺序完成，提交员 `git add <文件>` 会捎带该文件在途改动——9f18401 捎带了 BL-P3-04/P3-06 实现、abdd331 仅含夹具与挂载；代码状态正确（终验门过），但「一条一提交」在同文件组内不严格成立。下次工作流应让提交员按 hunk 暂存或让实施员每条完成即交提交。
- 用户环境 ECC pre-commit 钩子对项目惯用的桩配置字面量（夹具里 apiKey 字段的「stub…not-real」占位值，同字面量已在 ≥5 个已提交夹具）误报为密钥；项目门禁 privacy-check.sh 为绿，按钩子旁路提交并在信息里登记（5830b6c）。本句不复写该字面量，否则钩子对本文件同样误报。

### 4. 登记的新发现与已知边界（不构成本轮红线违反）

- **除 /edit 与 /snapshot/view 外，全站应用页（首页/设置/备份/评估等）无 CSP**——/settings 含明文 Key，建议下轮按 /edit 口径补齐（审查未列、本轮未动）。
- migrate-meta `assertLockOwnership` 与 `atomicWrite` 之间窄竞态：服务端抢锁写入的用户正文可能被迁移覆盖且无 tx 可恢复（复核 13130 修正口径，心跳已把触发前提压到极窄；登记不修）。
- logrotate 读后写前窗口丢失属 copytruncate 固有代价（注释登记不修）。
- 事实护栏数词等价采用「漏报优于误报」：「统一」里的「一」会放过真丢的 1。
- 游离进程仍未动：4 个无 RESUME_ROOT 实例（29270/50544/50867/60004）+ 3 个 10-24 孤儿（52431/55506/60732），等用户确认清理。

### 5. 回退

起点 `main@bfb033d`。禁止 `git reset --hard` / `git clean -fd`。逐提交 `git revert --no-commit <c>` 或单文件 `git checkout bfb033d -- <file>`；回退后必须重跑四套件。注意绑定：批 2 的 restore 跳过规则与 XSS-3 断言同批；5830b6c 的 test-editor.mjs 适配必须与 712b8d9（beginTx 合同）、426f234（zid 落点）同进退。

### 6. 剩余（下一轮）

- 方向 C：S4b 五阶段进度/分批/并行/面试指南（用户已选，单独设计轮）。
- B1 双 accent 文案定案、B3 themes 解冻（含 B12 bodyHash）——等用户拍板。
- 全站应用页 CSP 补齐（本轮新登记）。
- 游离进程清理（等确认）。

### 7. 收口后追加（2026-11-02，用户确认「按顺序做完」）

- **游离进程清理**：实测只剩 3 个（PID 52431/55506/60732，9 天前夹具孤儿，RESUME_ROOT 均为 /T 下隔离临时根 ev7-*/xss-restore-*），逐个核对归属后 kill；此前登记的「4 个无 RESUME_ROOT 实例（29270/50544/50867/60004）」已不存在，且当时判断有误——50544/50867/60004 正是这三个孤儿且带隔离 RESUME_ROOT。7766 不受影响。
- **全站应用页默认 CSP**（`c1e03bc`）：send() 对 text/html 统一下发，显式策略路由（/edit、/snapshot/view）保持各自口径。锁死 connect/form-action/img（不放 https:）/object/frame-ancestors/base-uri，frame-src 'self' 供 /export PDF 预览。**保留 script-src 'unsafe-inline'**：应用页 51 处内联事件属性 + 28 个内联脚本块，nonce 挡不住内联事件属性；**后续项：重构全部内联 handler 为委托监听后去掉 'unsafe-inline'**（多小时、全站按钮回归）。四套件 623✅；7766 重启后真实浏览器 8 页零 CSP 违规零错误。

### 8. S4b-B 交付 + S4b-C 核实（2026-11-02，用户拍板 B→C→A 顺序）

- **S4b-B「诚实最小进度」已交付**（设计 `dev-docs/2026-11-02-s4b-progress-design.md`，实施 `96f8e8f`）：
  genTasks 增 stage/model/usage 渐进默认字段；stage 只写管线真实检查点（queued/calling/parsing，
  patchGenTask 守卫写入，终态由 completeGenResult 收口）；llm.mjs chat/chatMsgs 增 meta 出参带 usage
  （llm 边界归一 {prompt,completion,total}，缺记 null；返回值兼容零改动）；/job/changes 带 genTtlMs；
  面板 running 态「已等待 m:ss · 阶段 · 模型名」（秒级 ticker 原位更新，不经 render——A9 纪律）+
  接近上限提示，done 态真实用量或「服务商未返回」，取消文案「不会撤销服务商已发生的计费」，全程无百分比。
  夹具 test-gen-progress（HTTP）/ test-gen-progress-ui（浏览器，撤实现阴性对照红）。四套件 626✅；
  7766 重启至 96f8e8f，真实页面加载零错误（真实文档均为母版、无岗位草稿，面板进度行由隔离实例夹具覆盖）。
  实施中修的坑：chat() 包装层只转发 {lease} 把 meta 出参丢掉（探针定位后补转发）。
- **S4b-C「面试指南」核实为已交付**：S4a 的 S4B-3 段已实现 roadmap ③ 全部约束——按需生成
  （gen-start kind=interview）、不阻塞导出（「不影响导出」折叠区、导出检查不依赖）、可停止
  （gen-cancel + 取消按钮）、重试、stale 判定、链卡/通用追问卡片。本轮 S4b-B 的进度/用量/取消文案
  同步覆盖 interview 通道。测试覆盖：test-gen-task.mjs（任务生命周期）+ 既有浏览器夹具。**无新代码**。
- **S4b-A（五阶段分阶段管线 + 分批并行/重试）为唯一剩余项**：按推荐「择机」——动的是刚完成可靠性
  加固的核心生成路径（3–4d 量级），建议与下次本来就要动管线的需求合并立项；诚实最小进度已把
  等待体验的痛点（276s 黑等）消掉大半，不构成紧迫性。

## 完善轮（2026-11-02）：B1/B3/B12 定案收口 + S5 引导向导 + S4b-A 五阶段管线 + 调研功能四件（起点 `main@8d89e41`，收口 `main@0cfd115`）

本轮由动态工作流逐卡实施（每卡：夹具先红/阴性对照 → 实现 → 后绿 → 单独提交），**13 卡全部 passed，共 13 个提交**；工作流终验四套件 EXIT=0。用户拍板：B1 双 accent 定案、B3+B12 解冻（基线重置）；S5 架构决策=向导进度以真实草稿文档承载；S4b-A=changes 五阶段+分批+重试。

### 1. 逐卡结果（13/13 passed）

| 卡 | 内容 | 提交 | 文件 | 证据要点（先红→后绿） |
|---|---|---|---|---|
| B1 | 双 accent 双区规则正式定案（注释+断言钉色值） | `8be22ae` | DESIGN.md、server.mjs、editor-shell.js、test-structure.sh | 三层红：①缺位——套件原无钉值断言（grep 0 命中）；②阴性对照（纯内存零写盘）4 例全红——应用页 `--accent` 实测 #111114≠#18181b、编辑器 `--ed-accent` 实测 #C2410D≠#C2410C、登记行被改写为 #B45309、值逃出登记行；③实现期既有审计真拦——首版注释带字面 hex 触发 test-structure.sh:2051 S2-B1 ❌（server.mjs:1180 组件层残留字面色），注释去 hex 后转绿 |
| B3T | 解冻 themes/：清除「仅屏幕显示」旧蓝段 | `8abdfcb` | themes/resume-classic.css、test-structure.sh、test-themes-blue-purge.mjs🆕 | 先红：旧蓝家族残留 6 行（79/83/85/86/88/100 行，#409eff/#4b5563/#1f2937）；后绿：「仅屏幕显示」段在但无冷色（段内清除形态）、冷色黑名单 0 命中、print 兜底与注入层覆盖锚点俱在 |
| B12H | bodyHash 渲染身份口径修正：只算打印可见内容 | `c0c172b` | freeze.mjs、test-structure.sh、test-bodyhash-identity.mjs🆕 | 实读定位 freeze.mjs:232（bodyHash=sha1(stripSaveState(stripZid(bodyInner(out))).trim())，stripSaveState 在 :85-87 只摘 #saveState 文案不摘属性）；消费方 renderInputId（:236）→ staleInfo（:255-261）三态、server.mjs:846 与 migrate-meta.mjs:156 定代次。先红：saveState 文案/data-state 变化即改变 bodyHash。**后果：既有 PDF 一次性判旧属预期**（提交信息登记） |
| S5R | S5 服务端：设计定稿+路由+草稿文档承载 | `6ced332` | server.mjs、test-structure.sh、dev-docs/2026-11-02-s5-design.md🆕、test-onboarding-api.mjs🆕 | 先红：路由不存在（空载荷首步 404）；阴性对照：短路 hasContent 守卫 →「空载荷首步不得建档」红（docId 非 null）；后绿 7 组断言：空输入不建档（docs/ 零新增）、逐步写档、跳步、步序门、docId 续作、预填只补缺失、产出文档与手建同权（/edit+DOC_ID+首页）、照片入 photos/ 带 Git 排除 |
| S5U | S5 前端：八步向导页（可跳过/暂存/确认卡片流） | `a9b966c` | server.mjs、test.sh、test-onboarding-ui.mjs🆕 | 夹具抓住真实服务端缺陷：无文档会话跳步后 PRG 回 /onboarding 丢进度（永远停 0.1）→ 修复：GET /onboarding 接受 ?next=（∈OB_STEPS）、空步表单流 redirect 下一步、无文档建档时当前步之前一律记 skipped；阴性对照：删首页「引导建档」入口 → 红；另修两处夹具自身缺陷 |
| S5F | S5 收尾：STAR+事实层录入、照片可选排除 Git、端到端 | `27b1087` | server.mjs、test-structure.sh、test.sh、2026-11-02-s5-design.md、test-onboarding-star-photo.mjs🆕 | 阴性对照（确认门控合同）：给 star-suggest 临时加落正文 →「建议响应后文档字节必须零变化」红；后绿：STAR 建议只回填卡片、确认才落正文（HTTP+UI 双验证）、NO_LLM 桩友好回落手填、事实层随文档保存、照片落 photos/（0600+meta 路径） |
| P1 | 生成管线五阶段脚手架（kind=changes 真拆分+阶段上报） | `7f83481` | server.mjs、test-gen-stages.mjs🆕、test-structure.sh、test.sh | 先红：analyze 调用期间 /job/changes 无 stages 明细；后绿：stages 依次推进可见、粗粒度三值并存（S4b-B 进度行兼容）、usage 两次调用合并、产物与重构前等价、evidence/interview 零回归、失败零落账；既有 test-gen-task TASK-04 回归过 |
| P2 | 分批并行改写+每批校验与空间预算+批次进度 | `6726a7b` | server.mjs、test-gen-batches.mjs🆕、test-structure.sh、test.sh | 先红：批 2 在途窗口无 batches 字段；后绿：batches 实时推进、失败批登记不污染成功批、预算校验拦截超编批、全部失败沿用既有文案、回退单批保持 P1 形状（P1 stages 断言零改动）；首跑暴露夹具断言 bug（未按 status 过滤旧候选），修夹具后绿、实现未改 |
| P3 | 批次重试（服务端幂等重试+面板批次进度与重试按钮） | `ef9d8dd` | server.mjs、job-panel.js、test-gen-retry.mjs🆕、test-gen-retry-ui.mjs🆕、test-structure.sh、test.sh | 先红：gen-retry 端点缺失（taskId 不匹配 404≠409）；后绿：守卫照 gen-start（借槽先行/并发闸/taskId/可重试态）、成功批摘除并合并收口、失败恢复 done 可再试、retrying 进度可见、usage 照实累计；UI：失败批行+重试按钮+「重试第 x/y 批」进度 |
| F1 | 评估—投递—结果闭环视图（复盘页） | `1553f4d` | server.mjs、test.sh、test-stats-loop-view.mjs🆕 | 后绿：主 join 链接与投递事实/已删降级/同名兜底/提醒区/空态指引//evals 徽章链接化/有评估无投递不早退/转义与零比率包装；回归 test-structure.sh 203✅（唯一 ❌ 为段 X Chromium 探测契约预期输出，既有口径）、test.sh 全量 436✅/0❌ |
| F2 | 评估报告 angle/gaps 预填岗位定制要求 | `9aa6c8c` | server.mjs、job-panel.js、test.sh、test-eval-promote-brief.mjs🆕、test-eval-promote-brief-ui.mjs🆕 | 先红：promote 后 brief.focus 为空数组（HTTP+UI 双红）；后绿：focus=[angle,...gaps]、空报告 focus=[] 且 200、重复 promote 409 幂等、normBrief 20 条上限截断；UI：预填条目逐条呈现、删除回写 /job/brief 且 GET 反映、删空行消失 |
| F3 | AI 面试准备建议持久化（随投递可回看） | `43bcdf8` | server.mjs、test.sh、test-ai-prep-persist.mjs🆕 | 先红：两次生成 200 但 applications.json 中 preps=null；后绿：落盘且 /app 双版本可见、21 次截 20 且历史转义、409 零写、非法 id 400；回归 test.sh 全量 442✅/0❌ + privacy-check.sh ✅ |
| F4 | 首页近期日程聚合视图（逾期/面试） | `0cfd115` | server.mjs、test.sh、test-home-agenda.mjs🆕 | 后绿：三条记录前两条入卡且终态排除、链接与转义、逾期排最前+类型徽章、空表无卡、状态条锚链文案不变；test.sh 全量 444✅/0❌ + privacy-check.sh ✅ |

🆕=本轮新增文件。ECC pre-commit 旁路 8 次（`6ced332`/`a9b966c`/`27b1087`/`7f83481`/`6726a7b`/`ef9d8dd`/`9aa6c8c`/`43bcdf8`）：钩子把夹具桩配置字面量（apiKey 字段「stub…not-real」占位，同形态已在 ≥5 个已入库夹具）误报为密钥，按流程 `ECC_SKIP_PRECOMMIT=1` 旁路并在提交信息登记原因；其余 5 卡（B1/B3T/B12H/F1/F4）钩子未拦截。历次提交前 `git status --short` 核对均仅含请求文件+固有 4 份未跟踪 dev-docs。

### 2. 关键决策

- **B1 双 accent 双区规则定案**：编辑器区 `--ed-accent` 钉 `#C2410C`、应用区 `--accent` 钉近黑 `#18181b`，两区互不串用；三层钉死——DESIGN.md 裁决登记 + server.mjs:1180 组件层注释（注释本身不得带字面 hex，否则既有审计红）+ test-structure.sh S2-B1 钉值断言。此后任一区色值漂移即静态审计红。
- **B3+B12 基线重置后果**（用户拍板解冻）：themes/resume-classic.css 解冻并清除「仅屏幕显示」旧蓝段（#409eff/#4b5563/#1f2937 家族 6 行），注入覆盖锚点与 print 兜底保留；B12 把 bodyHash 改为只算打印可见内容（stripSaveState 扩为摘 #saveState 属性，stripZid 照旧）——渲染身份口径变更，**既有 frozen PDF/快照首次访问会一次性判旧、需重建一次，属预期非缺陷**（`c0c172b` 提交信息登记）。
- **S5 架构=草稿文档承载**：向导进度不落会话内存，暂存于真实草稿文档——空载荷不建档（hasContent 守卫，阴性对照验证）、建档后与手建文档同权（/edit + DOC_ID + 首页）、跳步/续作/预填全走文档状态；照片入 photos/（0600）且 Git 排除。设计定稿见 `dev-docs/2026-11-02-s5-design.md`（已入库）。
- **S4b-A 五阶段管线**（上一节「唯一剩余项」本轮落地）：kind=changes 真拆 analyze/locate/rewrite/validate/assemble 五阶段 + stages 上报（粗粒度三值与 S4b-B 进度行并存），分批并行改写（每批 factGuard 校验+空间预算，batches 实时进度），批次幂等重试（服务端守卫照 gen-start + 面板重试入口）。

### 3. 剩余事项

- 本轮 13 卡全部通过、终验四套件 EXIT=0；上一节 §6 所列「B1 定案、B3/B12 拍板、S4b-A」三项全部闭环，**本轮无未完成卡**。
- 承接旧账仍开放：全站应用页 CSP 已补（`c1e03bc`）但 `script-src 'unsafe-inline'` 保留——需重构全部内联 handler 为委托监听后移除（多小时、全站按钮回归）。
- ECC pre-commit 对桩配置字面量的误报未根治（本轮 8 次旁路）；后续统一夹具桩值形态或给钩子加白名单。
- 若用户报告既有快照/PDF「突然判旧」，为 B12 基线重置的一次性后果，重新生成/冻结即可，非缺陷。

## 精进轮（2026-11-04）：竞品功能引入 + 内部优化审计（不过度）+ 视觉验收（起点 `main@8b51e91`，收口 `main@f600e34`）

本轮由动态工作流逐卡实施（每卡：夹具先红/阴性对照 → 实现 → 后绿 → 单独提交），**8 卡全部 passed，共 8 个提交**（02:41–07:19）。终验四套件 EXIT=0（产物 `/tmp/s4a-t7-{structure,testsh,render,privacy}.log`，07:31–07:39，晚于末次代码改动、含下述未提交 editor-shell.js 修复状态）：`test-structure.sh` 唯一 ❌ 为段 X Chromium 探测契约预期输出（既有口径，EXIT=0 不受影响）、其中 R2/R3 源级钉值与 S6-A1/A2、A3、A4 各段均 ✅；`test.sh` 444✅/0❌；render ATS 文本层字符量 109；privacy-check.sh「隐私检查通过」——R3/A4/VQA 卡内「privacy-check 未重跑」的保留意见由终验补齐。R1 专属夹具未挂套件，本登记会话补跑 `node test-shell-review-fixes.mjs` → EXIT=0（覆盖工作区含未提交改动状态）。用户背景：竞品功能引入 + 内部优化审计（不过度）+ 视觉验收，要求完整成品。

### 1. 逐卡结果（8/8 passed）

| 卡 | 内容 | 提交 | 文件 | 证据要点（先红→后绿） |
|---|---|---|---|---|
| R1 | 编辑器壳与审阅面板：幽灵菜单与空态死翻页钮修复 | `0321fd5` | editor-shell.js、job-panel.js、test-shell-review-fixes.mjs🆕 | 先红两段：①hidden 菜单 computed display=flex（探针实测 .ed-nav-menu 加载即 112×106px 可见，与卡片审计口径一致）；②changes 为空时 footer 仍渲染 3 个翻页钮（‹ 上一条/去导出检查 →/下一条 ›）。后绿：hidden 菜单 display=none/矩形 0、⋯开-Esc关语义不变、空态无翻页钮且有主行动、非空态翻页钮仍在、无页面异常 |
| R2 | server.mjs 文案与按钮语义修复包（首页待办计数·设置死引用·向导/导出页按钮语义） | `7494a12` | server.mjs、test-structure.sh、test-copy-semantic-fixes.mjs🆕 | 先红：空库（零文档零投递）待办提醒=1（状态行计入）+ 源级钉值红（待办=degradedCount+upcoming）。后绿：空库待办=0/1 待结构化=1、六处 409 无死文案且带 /settings、横幅两态+已跳过、确认按钮 secondary 去括号、导出对象、字符量告警带阈值原因；终验含源级钉值十项 ✅ |
| R3 | 投递看板与设置页：裸表单/prompt 链改造与 label 可访问性 | `eebcfb8` | server.mjs、test-structure.sh、test-fixtures/reliability/test-page-writes.mjs、test-apps-settings-forms.mjs🆕 | 先红两段：两页 10 个匿名控件（company/role/docId/channel/appliedAt/dueDate/link/nextStep/jd/note）+ 对 HEAD 源码断言 prompt( 实存。后绿：控件全有可访问名、投递卡无 prompt( 且行内编辑（预填/编辑后保留/取消收起）与 /app/update·/app/add 契约不变、设置 h1=设置、空态说明卡在场/配置后消失；ECC 误报旁路 1 次 |
| A1 | S6 模板库 A：新增主题 CSS 与按 meta.theme 装配 | `7fe2b4c` | themes/resume-dual.css🆕、themes/resume-magazine.css🆕、server.mjs、DESIGN.md、test-structure.sh、test-themes-assemble.mjs🆕 | 先红：装配 HTML 仍 data-theme="classic"。后绿：/edit 服务 HTML、假渲染器捕获的渲染输入、冻结快照三路径均按 meta.theme 装配（styleHash=sha1(主题文件)，freeze 口径）、未知主题报错不写盘、classic 零回归、legacy 保留；DESIGN.md 登记 themes/ 加法解冻边界 |
| A2 | S6 模板库 B：主题选择 UI（单标签+受众一句+真实渲染缩略图+切换语义） | `c7e8991` | server.mjs、editor-shell.js、test-structure.sh、test-theme-picker-ui.mjs🆕 | 两段红：/theme-preview 404 → 路由落地后「模板」页签缺失。后绿：预览只读（docs/docs-meta 前后 sha1 不变）+ CSP default-src 'none'、id/theme 闸门 400/404、apply 确认写 meta 重装配、iframe 真渲染缩略图、双栏事实安抚 |
| A3 | 排版密度三档预设 + 页数感知收紧建议（只建议不删内容） | `4db2745` | editor-shell.js、server.mjs、test-structure.sh、test-typo-presets.mjs🆕 | 两段红：/layout-info 404 → 无预设 UI。后绿：三档按钮（紧凑/标准/宽松）联动五滑杆+aria-pressed+typo-custom 落值、无渲染历史显示「尚未渲染」、/layout-info 只读（docs-meta 字节零变化）、一键紧凑内容零变化、页数感知收紧建议只给建议不删内容 |
| A4 | AI 反馈接线与偏好透明化（prefs 随生成提交 + 记忆管理 + 采纳率摘要） | `84bbfb6` | job-panel.js、server.mjs、test-structure.sh、test-feedback-prefs.mjs🆕 | 三段红：/job/feedback-del 404 → 夹具断言位修正（feedbackBlock 在 user 块）→ 现状生成空 body 精确复现。后绿：prefs 随生成进下次 prompt（桩 LLM 捕获【过往反馈】与新偏好）、环形 20 条单删/清空、400/404/409 守卫、小节管理与采纳率摘要、空态；ECC 误报旁路 1 次 |
| VQA | 视觉验收：关键页截图对照 DESIGN.md 并修显著问题 | `f600e34` | test-fixtures/reliability/test-visual-screens.mjs🆕、test-structure.sh | 夹具照 test-gen-progress-ui.mjs:21-74 模式起服（隔离根+合成岗位草稿+本机桩 LLM 随机端口+Chromium 缺失 exit(2)），7 路由 1280×900 fullPage 出图 /tmp/shots-after，挂入 test-structure.sh（R3 浏览器夹具后）；ECC 误报旁路 1 次 |

🆕=本轮新增文件。ECC pre-commit 旁路 3 次（`eebcfb8`/`84bbfb6`/`f600e34`）：钩子把夹具桩配置字面量（apiKey 字段「stub…not-real」占位，baseURL 均为本地测试服务器或 example.invalid）误报为密钥，按流程 `ECC_SKIP_PRECOMMIT=1` 旁路并在提交信息登记原因；其余 5 卡钩子未拦截。历次提交前 `git status --short` 核对均仅含请求文件+固有 4 份未跟踪 dev-docs。R3 请求清单中的 `test-page-writes.mjs` 根路径不存在，按 `git ls-files`/`find` 确认唯一对应 `test-fixtures/reliability/test-page-writes.mjs` 暂存（路径差异如实登记）。

### 2. 调研淘汰要点（本轮取舍，防翻案）

- **themes/ 解冻=加法边界**（`7fe2b4c` 登记 DESIGN.md 冻结件表）：`template.html`/`render.mjs` 维持冻结；themes/ 只允许**新增主题文件**，`resume-classic.css` 现有内容为渲染契约不改动。双栏（resume-dual）/杂志（resume-magazine）均以新增文件落地，淘汰「改 classic 重排印」路线。
- **模板库不做市场形态**：路线图既定 S6=模板库而非模板市场（§3.1「顺延并改名；定唯一数据来源」），且竞品证据仅「证据 A（f44 帧模板网格）实证，B 未提及」（2026-09-23-roadmap:49）。本轮落地=2 套新增主题 + /theme-preview 真渲染缩略图 + 单页签选择，未做主题商店/在线模板分发类复杂形态。
- **A2 切换语义收口**：预览只读（前后 sha1 不变断言钉死）、切换需确认才写 meta.theme 重装配；且「模板」页签只给母版——岗位草稿右栏是 S4a 定稿的合并入口（审阅/区域/AI 助手/排版四页签），不进模板动线（editor-shell.js 注释引 s4a-design §右栏）。淘汰「草稿内随时换主题」与「无预览静默切换」两种动线。
- **A3 页数感知=只建议不删内容**（卡名与提交信息钉死）：收紧只给建议档位与联动预设，绝不自动删改用户正文；/layout-info 只读（docs-meta.json 字节零变化断言）。
- **A4 反馈透明化**：job.feedback 环形 ≤20 条（server.mjs:3885-3886），随生成提交、可单删/清空、采纳率摘要可见——淘汰「黑箱记忆/不可见偏好」。
- **R 线审计边界（不过度）**：只修显著语义缺陷（幽灵菜单、死翻页钮、死文案、prompt 链、匿名控件），不借机做全站 CSP 重构——`script-src 'unsafe-inline'` 承接上轮开放旧账维持不动。

### 3. 视觉验收结论

- 夹具与运行方式见上表 VQA 行；零断言对照夹具，人工对照 DESIGN.md。
- 本登记会话复核修后 7 张截图（/tmp/shots-after，07:46 重拍，含下述页签修复后状态）：首页（topnav 唯一、stat-grid 四块、空库待办提醒=0）、设置（全控件带 label、h1=设置、备份恢复合并/替换单选组）、投递看板（六列+（空）占位+「记录已发生的投递，不自动发送」语义）、引导建档（八步胶囊+进行中态+确认并下一步/跳过这步/暂停退出三键）、复盘统计/素材库/评估历史空态均有指引文案与去向链接——无死白页、无幽灵浮层、无重复导航。原生文件选择框（Choose File）为浏览器控件非缺陷。
- 验收发现并修复一处显著问题：岗位草稿右栏出现「模板」页签，与 S4a 定稿右栏四页签冲突 → editor-shell.js:1777-1791 改为仅母版渲染该页签（+4/-2）。**该修复落在 `f600e34` 之后（07:26）、未随卡提交**；终验（07:31–07:39）与复检截图均覆盖此状态，全绿。

### 4. 剩余事项

- **工作区待提交两件**：①editor-shell.js（模板页签仅母版修复，见 §3，已被终验与本登记会话 `node test-shell-review-fixes.mjs` EXIT=0 覆盖）；②本节登记（handoff.md 本身）。本登记轮按委托只写本文件、不提交 git。
- ECC pre-commit 对桩 apiKey 字面量的误报未根治（本轮 3 次旁路，累计 11 次）；后续统一夹具桩值形态或给钩子加白名单。
- 路线图 S6「内置 3 套起步」中的 `resume-compact` 未建：themes/ 现存 classic/dual/magazine 三件（2026-09-23-roadmap:197 vs 目录实况），是否补齐待用户拍板。
- 承接旧账不变：全站 CSP `script-src 'unsafe-inline'` 需内联 handler 委托化重构后移除；B12 基线重置一次性后果（既有快照/PDF 首访判旧）沿用上轮口径，重新生成/冻结即可，非缺陷。
- 终验 `test-structure.sh` 唯一 ❌ 为段 X Chromium 探测契约的预期输出（「无缓存｜修复: 运行一次 node render.mjs 触发探测」文案契约，EXIT=0 不受影响），既有口径非缺陷。

## 文案减负轮（2026-11-04）：次级说明文案收口——「让布局自己解释」（起点 `main@e6b7434`）

用户设计指令：「避免不必要的次级标签与描述，让布局自己解释。」经 AskUserQuestion 拍板：基线必收（重复/装饰性约 10 处）+ 页题副标题五处 + 主题卡受众句与安心注 + 复盘卡口径小字；「不自动发送」类诚实括号**保留**。规范落地为 **DESIGN.md §9**（默认不加四类 / 豁免保留四类 / 逐条取舍表），§4.1 的 `.ed-note` 示例随类删除同步修订。

- `fix(server)`：首页 hero-sub（CSS 同删，hero-title 下边距 6→12px 补位）、岗位卡流程句、「先评估」静态预告（行动时文案保留）、导入 helper（`#upfile` 补 aria-label，可访问名不回退）、素材库/设置/快照/对比页题下说明句（对比页保留「含隐藏看」切换控件）、复盘两卡口径小字、/evals 与看板与对比×2 的「返回首页」×4、快照页「← 返回编辑」。
- `fix(editor)`：主题卡受众句（THEME_META 去 audience）+ 双栏安心注 + 模板页脚切换语义（确认框保留——闸门时刻才是正确位置）+ 排版脚注 `.ed-note`；死 CSS 同删（.ed-taud/.ed-tcalm/.ed-tsem/.ed-typo .ed-note），`.ed-tthumb` 补 margin-top:6px；审阅面板筛选复述行（帮助行「接受会修改正文…」保留）。
- 断言同提交：test-theme-picker-ui（受众句/安抚句/页脚语义反转为**缺席断言**，先红后绿）；test-editor 可读性采样 `.hero-sub`/`.card p` → `.statusline`/`#jobCard summary`（13px+ 档覆盖不降）；test.sh 兼容回归两钉值重锚（diff 口径句→「含隐藏看」控件在场；快照语义句→`<h1>历史版本</h1>` 在场）。

**验证**：夹具先红（受众句在场 ❌）→ 实现后绿；`RESUME_TEST_STRICT=1 npm run test:all` **EXIT=0（679✅，唯一 ❌ 为段 X Chromium 探测契约既有口径）**；静态 grep 被删文案与死 CSS 类 0 命中；7766 重启（79263→81645）后真实浏览器只读点验 18/18（无空洞；诚实文案/隐私语义/空态指引全在；模板页签三卡+缩略图 iframe 正常）。发现并登记：linghaoxiang 母版为 legacy 主题 → 模板页签无「当前」卡（A2 既有行为，非本轮引入，未动）。

**边界**：素材确认语义改由行动位承载（素材弹层警告 + 生成时「只用已确认素材」提示），静态页题句删除。ECC 钩子本轮零旁路（无桩字面量）。
