# 简历平台交接文档（Handoff）

> 日期：2026-09-17 ｜ 状态：**可靠性修复（P0 全部）+ 岗位草稿主流程贯通**
> 本轮细节见 `dev-docs/2026-09-17-reliability-and-job-flow.md`；疑似测试数据调查见 `dev-docs/2026-09-17-suspect-test-records.md`；历史总账见 `dev-docs/2026-09-10-optimization-audit.md`。

---

## 0. 当前状态一句话

从「编辑器」升级为**岗位定制闭环**：拿到 JD → 独立岗位草稿（不改母版）→ 修改清单审阅（接受/撤销/冲突门控）→ 导出两页 PDF（可投递/记录投递）。保存一致性、测试隔离、PDF 与投递版本绑定、备份恢复语义四个 P0 已修复；`test.sh` 全隔离 **112 个断言守卫 + 25 项浏览器级断言全绿**，test-structure/test-render 通过；真实文档已迁移 v5；常驻服务 127.0.0.1:7766 正常。

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
- 新增数据文件：必须纳入 `test.sh` 的隔离数据根与备份/恢复清单。
- 真实 LLM 验证需用户明确授权；AI 相关测试一律走本地 stub 并标注"模拟验证"。
