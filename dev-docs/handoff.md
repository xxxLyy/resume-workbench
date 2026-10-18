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
