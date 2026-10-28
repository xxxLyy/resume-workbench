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

本轮起止：`main@eaf3194` → 本节所在提交（7 个提交，按动机分）：

| 提交 | 动机 |
|---|---|
| `92ae93b` | 岗位操作失败语义三态化 + 提交身份按操作实例派生 |
| `b0ad73a` | 后台任务资源准入前置 + 渲染临时输入所有权收口 |
| `cd2441c` | 区域回执基线只进不退 + Z6/Z7 行为验收 |
| `61af20d` | 「确认可投递」点真实按钮 + AUD-15 写失败矩阵 + 来源真实 UI 验收 |
| `943d0bf` | 文档：交付事实修正 + README 旧口径 |
| `1dacdee` | 渲染：子进程超时终止 + 发布中断残留恢复的验收 |
| `66969d2` | 文档：补起止提交号与逐提交回退映射 |
| （本提交） | 文档：补「实际 prompt 输入」验收说明 + 提交表 |

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
