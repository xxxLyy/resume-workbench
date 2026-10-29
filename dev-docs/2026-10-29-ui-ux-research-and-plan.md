# 简历工作台 UI/UX 调研与优化方案

> 日期：2026-10-29（v1）｜ **v1.1：2026-10-30 按独立评审逐条修订（8 问题 + 5 遗漏，处理记录见文末「诚实留白」）** ｜ 基线：`main@7430f03` ｜ 作者角色：产品设计与前端负责人
> 输入材料：三路界面走查（交互流程 / 视觉体系 / 无障碍，含 file:line 证据）+ 一路截图实测（文本报告，4 页 1280×800）+ 两路网络调研（竞品 10 家一手抓取、UX 模式 10 项）。
> 红线遵守：本方案不提议任何对冻结件（`template.html` / `themes/` / `render.mjs`）的改动；不新增 npm 依赖；注入层建议全部落在对应注释对（AI-INJECT / SHELL-INJECT / JOB-INJECT / ZONE-INJECT）或 `data-*` 标记内，临时视觉效果走 CSS Custom Highlight API，不给正文节点挂 class。已裁决口径（失败三态、落账确认前同步撤回候选、「待核对」会话内内存态、回执环形表淘汰后结果未知、iframe PDF 预览 headless 空白、设置页 key 明文、1280–1439 竖标签条折叠）**不列为问题、不重开讨论**。

**证据核验声明**：文中引用的 file:line 均经本轮 `sed -n` / `grep -a` 抽查核实（含 `editor-shell.js` NUL 陷阱按 handoff 提示加 `-a`）。**v1.1 修订**：独立评审指出 3 处行号漂移与 2 处表述失实，本轮实测确认并已修正——焦点守卫实际在 `editor-shell.js:2103`（原误引 2109-2115）、scroll-padding 实际在 `server.mjs:1153/:1157`（原误引 1175-1180）、`__icon('settings')` 实际在 `editor-shell.js:401`（原误引 :400）；侧栏「设置」入口为 `server.mjs:1136`（原误引 :1135）；「44 个 path」更正为「44 个图标」（`vendors/icons.mjs:8` 头注释原文「共 44 个图标」，一图标可含多条 path）。WCAG 对比度数值为本轮用 python3 按 WCAG 相对亮度公式**复算**（现状 3.07/3.15/4.41，A1 候选 5.18/4.79/5.91，注入层 4.70/5.33/5.83，编辑器 accent 4.38；v1.1 补算 saving pill 局部候选：`#A25711` on `#FBE9D8`=4.54、`#9A3412` on `#FBE9D8`=6.18）。截图实测一路为文本报告，其结论本轮未逐条复现；其中与 handoff 断言矛盾的一处（编辑工具栏 emoji，见 B2）单独标注。竞品结论来源均为调研轮 WebFetch 一手抓取的官方页，社区抱怨（Trustpilot/Reddit）一手数据缺失，已在相应条目标注。

---

## ① 现状诊断

### 1.1 基座扎实（明确不动的部分）

三条走查线路与截图实测对以下能力的结论一致为正面，属于**已达到或超过业界标准**，本轮与后续迭代应保护而非重构：

1. **保存与冲突处理接近教科书级**：`editRev/savedRev` 分离三态、失败写本地缓存并给重试路径、多标签 409 三出口（`template.html:83-298`）、异步任务带时间预期（`server.mjs:1716`「1–5 分钟」、`ai-panel.js:363`；**已知边界随优点一并登记**：handoff.md:180 明言该耗时文案「写死无服务端预估」，改进归 B4）。对标 saasui.design 的自动保存状态机清单逐项命中（见 ②.4）。
2. **撤销体系严谨**：统一撤销栈 + opId 一次性消费、撤销 Toast 5s 存续、栈顶已变标「已失效」、撤销后有用户输入显式 confirm（`editor-shell.js:519-604`、`:1568-1602`）。对标 NN/g「紧急出口」要求已覆盖 AI 改动（见 ②.5）。
3. **键盘与焦点基础设施远超同类**：全站 focus-visible、弹层统一 dialog 语义 + trapTab + 焦点归还（`editor-shell.js:1330-1478`）、分栏拖柄键盘替代、j/k 审阅导航、scroll-padding 防 sticky 遮挡（`server.mjs:1153` 64px 档、`:1157` 窄屏 130px 档；**边界随优点一并登记**：handoff.md:78 明言「窄屏两行 topnav 与 `z-index:1000` 横幅叠加场景尚未实测」）。
4. **审阅三段流程与导出信任语义**：主操作随状态流转且至多一个高亮（`job-panel.js:1581-1608`）、`reviewPos` 服务端持久化（`:1027-1036`）、冲突门控面板与导出页双处同源、导出记录不可变 + 「当前内容」徽章（`server.mjs:4625-4633`）。
5. **注入纪律真实落地**：三面板 CSS 除 6 处 rgba 残留外 100% 走 `--ed-*` token、四样式块全打标记、剥离清单对称（`server.mjs:1835-1839`）；A-VARS「新名+旧名别名」单行迁移 + S2-B 断言闸门是制度性保障。

### 1.2 高影响缺口（按用户旅程分组，注明位置）

**A. 首次使用断链（high）**
- 零文档时首页「针对岗位生成」旗舰流程：母版下拉由 `infos.map` 生成、无兜底 option（`server.mjs:1520`），空 select 仍可提交 → 服务端 400 `'invalid from'`（`server.mjs:269`、`:2319`）→ 前端 `__status` 直显英文错误（`server.mjs:1656`）。新手上手路径以英文报错收场。
- LLM 未配置时 5 处提示指向不存在的入口「请先到首页的『大模型设置』」（`server.mjs:2316/3844/3852/3911/3926`），实际配置入口是侧栏「设置」（`server.mjs:1136`，页面 `/settings`，标题「大模型设置」`server.mjs:3619`）。
- 文档列表三种「无内容」情形（首访 / 全部归档 / 搜索无结果）均渲染空白：`server.mjs:1471-1481`（byTag 空 → cards=''）、`:1566`（空 ul）、`:1747-1752`（搜索仅隐藏 li，无「无匹配」反馈）。

**B. 旗舰流程的一次性消耗（high）**
- 评估报告是一次性 UI：等 1–5 分钟拿到的报告刷新即丢，无「最近评估」列表；`/eval/promote` 唯一调用点在首页卡片（`server.mjs:1738`），历史数据已存 `evaluations.json` 但无任何页面渲染（`loadEvals()` 仅用于指纹比对 `server.mjs:210`）。handoff 批次2遗留已登记此条。
- 导出页 8 张线性卡片平铺且同一份 `suggestions` 渲染两遍：检查卡内「风格建议」（`server.mjs:4669`）+ 独立卡「超过两页的可读处理建议」（`server.mjs:4671`）；「记录已投递」藏于第 7 张卡（`:4676-4687`），记录成功文案无后续指引（`:4727`），导出→投递链路收尾隐式。
- 同一动作「创建岗位草稿」双入口能力不对等：首页表单带完整定制要求卡（预设/重点/保留/不强调/幅度/页数，`server.mjs:1523-1541`），编辑器弹层仅 4 字段（公司/岗位/JD 链接/JD 文本，`editor-shell.js:1496-1510`，本轮 sed 复核），差异不可发现。

**C. 无障碍三高（high×2 + medium 一组）**
- **全站动态反馈零屏幕阅读器播报**：全仓仅 2 处 `role="status"`（`editor-shell.js:1182` 查找计数、`server.mjs:1560` statusline，本轮 grep 复核）；保存失败 toast、409 冲突条、审阅 note、区域/AI 面板消息、应用页 `__wv` 失败提示全部纯 div 直写。「保存失败」「其他窗口已保存过」这类关键事件对读屏用户零感知。
- **审阅面板轮询重渲染吞输入与焦点**：生成任务 running 期间每 2500ms `refresh()→render()` 全量重建（`job-panel.js:1057-1059`、`:1067` `root.innerHTML=''`），在途的「证据补充说明」textarea 以服务端旧值重建（`:1121-1131`）、拒绝原因自定义 input 随 item 重建消失、焦点丢回 body。max 思考下任务可持续 4–5 分钟（handoff 实测 276 秒），期间面板基本不可交互。外壳导航有焦点守卫（`editor-shell.js:2103` 重建前查 `navlist.contains(document.activeElement)`，`:2106-2107` focusout 路径同款），此面板没有。
- **语义色对比度全线不过 AA**（正文尺寸需 4.5:1，本轮复算）：应用页 `--warning #d97706` on `#fffbeb`=3.07、`--success #16a34a` on `#f0fdf4`=3.15、`--danger #dc2626` on `#fef2f2`=4.41（`server.mjs:1143`），命中 11px 徽章（`:1199`）、13px 历史快照横幅（`:3250`）、14px 损坏横幅（`:361`）与导出/评估提示（`:4639`/`:1681`）；编辑器 saving 状态 pill `--ed-accent #C2410C` on `#FBE9D8`=4.38（`editor-shell.js:52`，差 0.12 达标）。注入层 `--ed-*` 语义色是校准过的一套（4.70/5.33/5.83 全过）——两套体系只有一套做过校准。
- **键盘可达缺口一组**：选区 AI 工具条仅 mouseup 触发（`ai-panel.js:400-410`），键盘选区用户四个预设入口等于不存在；ai-pop 有 `role=dialog` 无 `aria-modal`/焦点圈定/Esc（`:86`），关闭钮是 span 无 tabindex（`:81`）；区域列表行仅 click 无 role/tabindex（`zone-panel.js:142`、`:151-156`，本轮实测；handoff.md:609 登记过此问题与修法建议、未逐行标注修/未修，现状按未修处理，详见 A10）；一批控件低于 WCAG 2.2 AA 24×24：20px 定位/显隐/撤销钮（`job-panel.js:60`、`editor-shell.js:106`/`:162`）、22px chips 组。
- **表单标签三处缺失**：导出页 tkCompany/tkRole/tkChannel placeholder-only 且预填后 placeholder 消失（`server.mjs:4681-4683`，同表单 tkDate 反而有 aria-label）；面试记录 6 控件无 label 关联（`:3515-3520`）；区域修改意见 textarea 仅 placeholder（`zone-panel.js:219-222`）。

**D. 信息架构与视觉债（medium/low）**
- 全站双重导航：topnav（`server.mjs:1249`）与 sidenav（`:1130-1137`）同屏重复同一组 5 个入口，品牌一屏 3 次（截图实测截图 1/4 佐证）；当前项高亮需两处同步维护。
- 设置页「当前启用哪套配置」几乎不可辨：两卡同构，激活态仅卡头 radio checked（`server.mjs:3661`），卡片无边框/徽章变化——这是唯一决定所有 AI 请求打到哪个模型的状态；同页删除配置用 `secondary` 样式与普通操作同款同行（`:3661`），全局 `button.danger` 未用；表单按 HTML `size="46"` 定宽、右侧大片空白（`:3640-3644`）。
- 文档卡 ⋯ 菜单 9 个动作「·」相连一行平铺，删除紧随复制仅靠颜色区分（`server.mjs:1452-1465`）。
- token 表名不符实：`--muted-2 #a1a1aa` 全仓 0 引用（本轮 grep 复核）且 2.56:1 不可作文字色；`--font` 首选 "Geist"/"Geist Mono" 但全仓无 `@font-face`/link/woff（本轮 grep 复核，仅声明行 1 命中）→ 永远渲染 `-apple-system` 回退；`--serif:var(--font)` 使应用页标题实渲染无衬线，与编辑器真衬线 `--ed-serif`（`editor-shell.js:37`）语义错位。
- 注入层 6 处 rgba 字面色在 S2-B 闸门盲区（断言只拦 hex 形态）：`ai-panel.js:70-71` 外来红 rgba(231,76,60,·)=#E74C3C（不属任何 token，且被 `editor-shell.js:228-229` 高特异性规则遮蔽成死代码）；`editor-shell.js:228/229/231` 四条中 rgba(166,90,18)=#A65A12 偏离 `--ed-warn #A25711`。
- 同一主行动「导出/下载 PDF」双 accent：应用页近黑 `#18181b`（`server.mjs:1183` 默认 button，`:4643` dlBtn 即用）vs 编辑器顶栏橙 `#C2410C` 实心（`editor-shell.js:59`）。全仓 0 `prefers-color-scheme`（本轮 grep 六文件复核，单用户本地工具可接受，登记即可）。
- 右栏面板开关用 ⚙ settings 图标与全站「设置」页语义撞车（`editor-shell.js:397-401`，aria-label 是「辅助面板」但图标说「设置」）；窄屏下这是打开审阅面板的唯一入口。
- reduced-motion 覆盖不一致：CSS 层与部分定位函数已尊重，但 4 处 `scrollIntoView({behavior:'smooth'})` 无条件执行（`job-panel.js:958`/`:898`、`zone-panel.js:490`、`ai-panel.js:241`；正确范例在同文件 `job-panel.js:1100`）。
- `bindOne` 的 `/zones` POST 失败被空 catch 吞掉（`zone-panel.js:625`）：改绑未落盘无提示，用户误以为成功；openPicker 弹窗缺 dialog 语义（`:547`，其余三个弹层均有）。

---

## ② 业界对标要点（带来源）

1. **JD 匹配的主流呈现是「三态关键词面板」**：Novoresume 分 matched/close/missing 三档；Enhancv 按 JD 检查硬/软技能匹配并生成可用的定制副标题建议；Rezi 直接提示补缺失关键词并警告堆砌。本项目「岗位要求—经历证据对应表」已是**四态 + 证据可定位**的超集形态，领先；缺的不是表格本身，而是评估报告的持久化与回看（对应 B4）。
   来源：https://novoresume.com/ 、https://enhancv.com/resume-checker/ 、https://www.rezi.ai/ （WebFetch 一手）
2. **「诚实分数」是行业最佳呈现**：Enhancv 把检查拆「模拟 ATS 解析率 + 招聘者视角 27 项检查」，官方明说「不存在所谓的 ATS score」，分数落地为可执行清单；Resume.io 宣称「100% compliant」属恐吓式营销且其 Trustpilot 4.2/56,262 为本轮竞品最低。本项目确定性检查三级（需修复/建议核对/风格建议）与路线图 §5「不包装成录用概率/通用 ATS 分数」的裁决与行业最佳一致，应保持并在叙事上显性化这一差异。
   来源：https://enhancv.com/resume-checker/ 、https://resume.io/ （一手；Trustpilot 分数为官方页自显，社区抱怨原文未取得一手——调研轮 403/限流，未验证）
3. **防幻觉是 AI 简历工具的新卖点，且正在机制化**：Novoresume 宣传「每一行都由你确认」，Rezi/Resume.io 用「别用 ChatGPT 否则 robotic」做对比定位。本项目证据五态 + evidence 逐字子串验证 + 数字/日期程序级护栏是**同类机制中最强的**（竞品停留在宣传口径）——建议把「无出处的建议显式标红并要求先补素材」做成可见规则，这是最强的差异化叙事。
   来源：https://novoresume.com/ 、https://www.rezi.ai/ （一手）
4. **自动保存状态机的行业清单，项目已逐项达标**：稳定位置的常驻状态机、防抖、诚实 Saved（已确认落地才算）、失败响亮 + 重试 + 内容保留、保存状态与版本历史职责分离——saasui.design 的清单在 1.1 条 1 全部命中。**结论：不重做，只把状态指示器的对比度修到达标（A1）。**
   来源：https://www.saasui.design/blog/saas-autosave-save-states-ux-patterns （一手全文）
5. **撤销必须覆盖 AI 改动（NN/g 启发式 3/5）**：可逆操作是「紧急出口」，用户敢让 AI 批量改稿的前提是可一键回退。项目统一撤销栈 + opId 已达标；对标结论是保护现状。
   来源：https://www.nngroup.com/articles/ten-usability-heuristics/ （一手全文）
6. **AI 改动的边界与可审计性（zones of influence）**：Notion AI 作者的核心观点——AI 输出应被限定在明确容器内，无界改动混入人工内容会摧毁信任；「与其要求用户信任模型，不如提供约束输出的手段」。配套「空白页问题」教训：早期流失主因是「不知道它能对我的工作流有什么用」，解法是**预设场景操作优先于裸 prompt 输入框**。本项目审阅面板的逐条 before/after 对照已是标准实现；AI 对话面板可吸收「预设 chips 优先」一点（小改进，见 A11 附注）。
   来源：https://latent.space/p/ai-interfaces-and-notion （一手全文）
7. **局部 diff 优于全局 suggesting 模式**：Google Docs 全局模式开关的三个公认痛点（模式意外切换、无法预览全部接受后的效果、长文档建议散落难导航）。单人简历编辑器不需要全局模式——每条建议自带局部 diff 卡 + 接受/拒绝（本项目现状）就是 suggesting 的单人化降维，方向正确。
   来源：https://upcurvecloud.com/blog/how-do-i-track-changes-in-google-docs-and-other-google-apps （一手；Google 论坛痛点为搜索摘要，直连 404，未逐条验证）
8. **ATS 兼容的实证基线：单栏 + 真实文本层**：RenderCV 用 20 份 PDF 双工具提取（平均 99.1%）+ 三个商业解析引擎验证，明确指出**多栏是 ATS 失败最常见原因**、扫描件是另一大杀手；同时坦诚未量化日期格式/页边距/表格的影响（网上「ATS 清单」多为经验之谈）。本项目投递 PDF 为单栏文本层（决策 2），基线达标；「导出后文本提取回读校验」可作为不碰模板的自检步骤（B8）。
   来源：https://docs.rendercv.com/ats_compatibility （一手实读）
9. **两页简历规则已被调查数据颠覆**：ResumeGo 对 7,712 名招聘者的研究——偏好两页的概率是一页的 2.3 倍；Novoresume 统计 68.3% HR 认为两页理想。共识是**内容相关性优先于页数**。本项目「目标两页 + 超页二出路（精简或保留更多页）」的现有口径与数据一致；适配裁剪应按「相关性排序 + 目标 1–2 页」而非硬编码一页。
   来源：https://www.ere.net/articles/one-or-two-page-resumes-best （WebSearch 汇总，未逐篇一手核验——标注未验证）
10. **编辑器无障碍的参照模式**：Tiptap v2.9 默认加 `role="textbox"` 使编辑器开箱可及（Tab 进编辑区 / Alt+F10 聚焦工具栏 / 方向键导航）；MDN 口径：富文本编辑器需 `role="textbox"` + `contenteditable="true"` + `aria-multiline="true"`，且原生控件优先于 ARIA。启示：键盘交互模式可低成本原生自实现（应用层，无需依赖）；但给正文容器挂属性有随保存落盘的风险，须先核实或经剥离清单登记（列入 B9 低优先）。
    来源：https://tiptap.dev/docs/guides/accessibility 、https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/textbox_role （一手）

---

## ③ 分层建议

### A 层：立即可做（只动应用页 `server.mjs` 与注入层四文件，遵守注入与样式纪律；断言同步例外见下）

> 通用验收底座：每项落地后跑 `bash test-structure.sh` **全绿**（S2-B1/S2-B2/UI-2 等，不只抽查）+ 隔离实例（临时 `RESUME_ROOT` + 随机端口 + 合成文档）浏览器实测；服务端改动按交付纪律重启真实服务并浏览器点一遍。冻结件零改动由 `git diff --stat` 钉住。
> **范围声明（v1.1 修正）**：A 层触碰面 = `server.mjs` + 四个注入文件，**外加 `test-structure.sh` 的两处断言同步**（A1 的 UI-2 期望值、A14 的 S2-B2 rgba 扫描扩展）。该文件非冻结件、本就可改，但断言改动必须与对应实现**同一提交**，并照常做先红后绿的阴性控制。

**A1 应用页语义色三值达标（P0，修复面最小的高影响项）**
- 落点 ①（实现）：`server.mjs:1143`（单行、别名层零改动）。`--warning #d97706→#A25711`、`--success #16a34a→#15803D`、`--danger #dc2626→#B91C1C`。本轮复算 on 各自 soft 底 = 5.18 / 4.79 / 5.91，全过 AA。跨 surface 对齐口径**如实收窄（v1.1）**：三档中只有 warn 与注入层 `--ed-warn` 同值（#A25711）；注入层 `--ed-ok #2F6B4F`/`--ed-err #A32B2B` 与候选 **并不同值**（editor-shell.js:37 实读），本轮不强行对齐，ok/err 是否跨 surface 统一色相并入 B1 设计轮定。
- 落点 ②（断言同步，**不改必红**）：`test-structure.sh:4060-4067` 的 UI-2 断言逐字钉死现值——`'--success': '#16a34a', '--warning': '#d97706', '--danger': '#dc2626'`，`assert(srv.includes(k) && srv.includes(v))`（本轮 sed 实读确认）。三个期望值必须与新 token 同一提交更新，否则 A1 一落 `test-structure.sh` 就红，与通用验收底座直接冲突。
- 顺带（注入层，**只做局部、绝不动全局 token**；v1.1 收窄影响面）：saving pill `--ed-accent #C2410C` on `--ed-accent-soft #FBE9D8`=4.38 差 0.12（`editor-shell.js:52` 与 `:222` 两条 saving 规则都要改）。**不改** `--ed-accent`/`--ed-accent-soft` 的全局值——实测 `--ed-accent-soft` 在 `editor-shell.js` 有 8 处引用（:37 声明、:52/:62/:84/:170/:183/:222/:235），`--ed-accent` 全文件 47 次引用（ed-primary、caret、全部焦点环、nav 选中态），动全局 token 等于重刷编辑器观感，与 B1「编辑器暖色系是已裁决的视觉资产」立场自相矛盾。做法：在 S2-B2 allowlist 内的 `body.ed-on{…}` 声明行（`editor-shell.js:37`）新增 `--ed-accent-strong`，候选 `#9A3412` on `#FBE9D8`=**6.18:1**（本轮复算）；`--ed-warn #A25711` on 同底=4.54 亦达标但余量仅 0.04，不推荐。
- 验收：三 token on soft 底复算 ≥4.5（已验 5.18/4.79/5.91）；**`test-structure.sh` 全绿（UI-2 期望值已同步，非仅 S2-B1 绿）**；saving pill 复算 ≥4.5 且全局 accent 家族观感零变化（ed-primary/caret/焦点环/ed-nav.active 目检）；徽章「图标+文字+底色」四件套不破坏（color-not-only）；隔离实例首页/导出页/设置页目检徽章可辨。

**A2 LLM 未配置引导纠正（P0，纯文案+一处渲染）**
- 落点：`server.mjs:2316/3844/3852/3911/3926` 五处文案改为指向真实入口（侧栏「设置」/`/settings`）；`server.mjs:1656` `__status` 渲染错误处，对「未配置大模型」类错误拼一个「去设置 →」链接（`<a href="/settings">`），其余错误维持原文。
- 验收：五处（:2316/:3844/:3852/:3911/:3926）上下文不再含「首页的」——注意 `grep -n '首页的' server.mjs` 修完仍会命中 `:4173` 的**源码注释**（「文档 id 会原样拼进首页的内联 JS」，非用户可见文案），验收只针对上述五处，不做文件级 0 命中断言；无 LLM 的隔离实例触发评估/证据/建议各一处，提示含正确入口且链接可达。

**A3 母版下拉空态兜底（P0，接回首用旗舰流程）**
- 落点：`server.mjs:1520`——`infos` 为空时整块岗位表单替换为引导卡（「先创建第一份简历」+ 新建文档/上传 PDF 按钮，复用既有路由）；同时 `server.mjs:1656` 对 `'invalid from'` 映射中文兜底「请先选择母版简历」（防其他入口漏网）。
- 验收：零文档隔离实例打开首页：不出现英文报错；引导卡动作可点通；创建一份文档后表单恢复且下拉非空。

**A4 列表空态与搜索反馈（P1）**
- 落点：`server.mjs:1471-1481`（byTag 空 → 渲染引导卡：新建/上传/导入三动作）、`:1566`（空 ul 配文案）、`:1747-1752`（过滤后可见 li 为 0 时显示「无匹配“关键词”」行并带「清除搜索」动作）。
- **实现坑（必须避开，否则第一版即翻车）**：现有搜索对 `#doclist > li` **全量**切 display（`server.mjs:1748-1751`，本轮实读），分组头 `.group-head` 与新增的「无匹配」行都是 li——关键词非空时该行文字含关键词、被 `includes(q)` 判真而侥幸保留，但 **q 清空时会随全量显示而残留**。该行必须放 li 之外的独立容器，或加 class 并把过滤选择器改为 `#doclist > li:not(.search-empty)` 排除。
- 验收：三种「无内容」情形各有文案 + ≥1 个动作（SKILL empty-states 口径）；搜索清空后「无匹配」行消失、列表完整恢复；`test.sh` 首页相关断言不红。

**A5 导出页去重与收尾（P0，三处小改）**
- 落点：`server.mjs:4669` 删除检查卡内的「风格建议」重复列表（保留 `:4671` 独立卡，其含上下文说明更完整）；`server.mjs:4727` 成功文案后追加「去投递看板跟踪 →」（`<a href="/applications">`）；`server.mjs:4681-4683` 三个 input 补 `aria-label`（对齐同表单 `:4684` tkDate）。
- 验收：隔离实例导出页 `suggestions` 内容只出现一次；记录投递成功后看板链接可点通；三 input 有可访问名。

**A6 设置页状态可见性（P0，CSS 为主）**
- 落点：`server.mjs:3661`——激活配置卡渲染时加 active class（边框 `--accent`/底色微变/「使用中」徽章三选二以上）；删除按钮 `class="secondary"` → `class="danger"`（全局样式已存在，confirm 保留）；`server.mjs:3640` `inp()` 去 `size="46"` 默认、改 CSS 宽度（100% 或固定栅格）。
- 验收：两配置卡并排时激活卡一眼可辨（截图对比）；删除钮为红色系危险样式；同卡输入框宽度一致、无大片空白；S4B-14 断言（事件委托/无内联 onclick 字面量）不破坏。

**A7 破坏性动作分离（P1）**
- 落点：`server.mjs:1452-1465` ⋯ 菜单——「删除」与其余动作间加视觉分隔（左边框 + 左间距，或独占行尾第二行），与「复制」不再相邻同簇；`confirm()` 兜底保留。
- 验收：⋯ 展开后删除在视觉上与常规动作明确分离；删除仍需 confirm；菜单 HTML 仍为服务端生成（无注入层越界）。

**A8 动态反馈 aria-live（P0，读屏可感知）**
- 落点（注入层，均可直接改）：`editor-shell.js:993` shellToast 与 `:1568` undoToast 的容器建立时加 `aria-live="polite"`；`job-panel.js:119-127` `.jp-msg` 加 `role="status"`；`zone-panel.js` 输出容器（`#zp-ai-out`/`#zp-preview`）与 `ai-panel.js` 对话/体检结果容器加 `aria-live="polite"`。
- 落点（应用页）：`server.mjs:1263-1267` `__status` 的 msgEl 加 `role="status"`（错误文案自带「失败」字样，polite 足够，不用 assertive 防轰炸）。
- 冻结件 toast（`template.html:214`）**不改模板**：用 `editor-shell.js` 既有 MutationObserver 机制（emoji 覆盖同款）给 `.toast` 节点动态补 `role="status"`——瞬态 UI、不落盘，符合注入纪律。
- 验收：DOM 断言（隔离实例浏览器）：保存成功/失败、409 冲突条、审阅 note、AI 体检结果节点均带 live 语义；`grep -ac 'aria-live\|role="status"' 注入层` ≥5；落盘 HTML 不含新增属性（`/save` 后 diff）。

**A9 审阅面板轮询保输入保焦点（P0，运行期可用性）**
- 落点：`job-panel.js:1067` `render()`——重建前采集 `{焦点元素标识、所有 .jp-note textarea 当前值、拒绝原因 custom input 值}`，重建后回填值；若焦点原在面板内则恢复聚焦（参照 `editor-shell.js:2103` 的既有守卫模式：重建前查 `navlist.contains(document.activeElement)`；`:2106-2107` focusout 路径同款）。
- 顺带收口一笔既有登记（v1.1 并入）：handoff.md:611 登记「**标签页不可见时仍每 2.5 秒轮询 /job/changes**（服务端每次重解析全文）」至今未修（本轮实测 `grep -ac visibilitychange job-panel.js` = **0**）——本条正好改造这段 2500ms 轮询链路，同轮加 `document.visibilitychange` 守卫：不可见时暂停轮询、重新可见时立即 refresh 一次。不改服务端。
- 验收：隔离实例起生成任务（stub 桩即可），running 期间在补充说明输入文字，跨越 ≥2 个 2.5s 轮询周期后文字仍在、焦点未丢回 body；标签页切后台时无 /job/changes 请求、切回即恢复；既有 `test-fixtures` 审阅用例全绿。

**A10 区域面板三小项（P1）**
- 键盘化：`zone-panel.js:142` zp-row 加 `role="button" tabindex="0"`，`:151-156` 补 Enter/Space 触发（对齐 `editor-shell.js:1305-1315` 素材卡做法）。**引证更正（v1.1）**：handoff.md:609（边角审查轮的前端注入层表）登记了此问题与修法建议，但该表未逐行标注修/未修；v1 原文「曾登记已修、疑似面板重写回归」的叙事**无出处，撤回**——现状按未修处理（本轮实测 `:151-156` 仅 click 监听、全文件无 role/tabindex）。回归断言按「当前代码会红」写阴性控制即可，不依赖回归叙事。
- 吞错收口：`zone-panel.js:625` 空 catch 改为面板消息提示（参照 job-panel `note(msg,'warn')` 惯例）。
- 弹窗语义：`zone-panel.js:547` openPicker 的卡片补 `role="dialog" aria-modal="true"`（对齐同仓其余三个弹层）。
- 验收：Tab 可聚焦区域行、Enter 触发定位+打开区域 AI；`/zones` 注入 500（桩）后改绑显示失败提示；弹层有 dialog 语义。

**A11 选区 AI 键盘路径与 ai-pop 语义（P1）**
- 落点：`ai-panel.js:400-410` 补 `selectionchange` 监听走同一 `positionToolbar` 路径（键盘 Shift+方向选区也能呼出工具条）；`:86` ai-pop 补 `aria-modal="true"` + trapTab（复用 `editor-shell.js:1440` 模式）+ Esc 关闭（挂入 `editor-shell.js:738-746` Esc 分层链或面板内自监听，单层关闭不穿透）；`:81` `#ai-close` 加 `tabindex="0"`。
- 附注（对标 ②.6 启示，可选小改）：AI 指令输入框上方补 2–3 个场景预设 chips（「精简到两行」「突出量化成果」——文案已有现成示例可复用 `ai-panel.js:86` placeholder），预设优先于裸输入。
- 验收：纯键盘完成一次选区改写（选中→呼出→Enter→Esc 关闭且焦点归还）；Tab 圈定在弹层内。

**A12 微控件尺寸、字号与可访问名（P2，紧凑面板的刻意取舍）**
- 落点（尺寸）：高频可点按钮提至 24px：`job-panel.js:60`（定位 20→24）、`editor-shell.js:162`（撤销 20→24，定向撤销两个入口之一）、`:106`（条目显隐 20→24）；chips 类（`job-panel.js:65/71/77`、`zone-panel.js:51`、`editor-shell.js:89` 的 22px）**保留 22px 保底并在此登记取舍理由**（桌面鼠标单用户、面板密度优先，AA 例外登记而非全量放大）。
- 落点（字号，**点名清单 9 处 = 验收范围**，v1.1 补全）：`job-panel.js:40`（jp-st）、`:59`（jp-fact）、`:60`（jp-refbtn）三处 10→11、`:62` 11.5→12、`:67` 10.5→11；`zone-panel.js:38`（zp-c）10→11；`editor-shell.js:80`（ed-label）、`:115`（ed-mat small）、`:116`（ed-mat-unconf 徽章）10→11。更正缘由：10px 在 job-panel 实为 **3 处**（v1 只点名 :40），editor-shell 另有 :115/:116 两处（本轮 `grep -an 'font-size:10px'` 实测），清单不全就会造成「验收文件级 0 命中 → 要么假绿要么范围蔓延」。
- 落点（可访问名，顺带收口既有登记）：handoff.md:612 登记「**符号按钮只有 title，可访问名是符号本身**」至今未修（本轮实测 `grep -ac aria-label job-panel.js` = **2**，仅 :844 自定义拒绝原因与 :1130 证据补充说明）——本条正在动这批按钮，同轮给定位/显隐/撤销等符号钮补 `aria-label`。
- 验收：`grep -an 'font-size:10px\|font-size:10\.5px\|font-size:11\.5px' job-panel.js zone-panel.js editor-shell.js ai-panel.js` **0 命中**（按上述 9 处清单全改后自然为 0；**不用** `1[005]` 字符类正则——它匹配不到 11.5，v1 验收写法有假绿漏洞）；高频按钮实测高 ≥24px；符号钮有非符号可访问名；面板截图对比密度可接受。

**A13 reduced-motion 补齐（P2）**
- 落点：`job-panel.js:958`/`:898`、`zone-panel.js:490`、`ai-panel.js:241` 四处 smooth scroll 套 `matchMedia('(prefers-reduced-motion: reduce)')` 守卫（范例在同文件 `job-panel.js:1100`）；`server.mjs:1185-1189` button transform 过渡并入 `:1246` 的 reduced-motion 规则。
- 验收：`grep` 四处均有守卫；DevTools 模拟 reduce 后定位为瞬时跳转。

**A14 token 卫生（P1；触碰 `test-structure.sh`，属 A 层开头的范围声明例外）**
- 落点：`server.mjs:1143` 删 `--muted-2`（0 引用）与 "Geist"/"Geist Mono" 字族名（无加载源，恒回退）；注入层 rgba 收编——`ai-panel.js:70-71` 外来红按死代码删除（已被遮蔽）或改 `--ed-err` 派生；`editor-shell.js:228` rgba(166,90,18,·) 对齐 `--ed-warn`；`:229`/`:231` 的 `rgba(255,252,245,.88)`/`rgba(194,65,12,.45)` 登记为 `--ed-panel`/`--ed-accent` 的透明度派生（或收编为新 `--ed-*` token）。
- 断言扩展（v1.1 修正白名单面数字）：`test-structure.sh` S2-B2 增 rgba 形态扫描。**白名单必须同批登记，否则扫描一加就全红**——本轮 `grep -aohE 'rgba\([0-9]+,[0-9]+,[0-9]+,'` 四文件实测：v1 所称「6 处语义残留」（2×`rgba(231,76,60,`、2×`rgba(166,90,18,`、1×`rgba(255,252,245,`、1×`rgba(194,65,12,`）之外，另有 **25 处既有形态**：21×`rgba(60,45,25,`（暖阴影家族，S2-B2 注释已登记）、3×`rgba(0,0,0,`、1×`rgba(255,255,255,`。v1 的「6 处」表述会让执行者严重低估白名单面。白名单按「rgba 家族前缀」登记（如 `rgba(60,45,25,`），不逐行硬编码。
- 验收：`grep Geist` 0 命中、`var(--muted-2)` 仍 0；S2-B2（扩展后）绿，且四文件 rgba 总命中 = 白名单登记的家族数（语义残留 6 处收编后应只余 25 处既有形态）；page-line 实渲取色与 `--ed-warn` 一致。
- `--serif` 语义错位与双 accent 观感衔接不在此条（见 B1）。

**A15 两处提示性小改（P2）**
- 右栏开关图标：`editor-shell.js:401` `__icon('settings')` → panel-right/columns/layers 类图标（**从 `vendors/icons.mjs` 已提取的 44 个图标里选**——头注释「共 44 个图标」，一图标可含多条 path；不新增外部源，若缺合适图标改 `scripts/icons.list.json` 重跑提取脚本）；aria-label「辅助面板」保留或改「审阅与工具面板」。
- 双入口差异提示：`editor-shell.js:1493-1495` jobpop 的 note 补一句「完整定制要求（重点/保留/幅度/页数）请在首页『针对岗位生成』表单填写」（能力补齐见 B5）。
- 验收：图标不再与「设置」撞车（截图对比）；弹层提示可见、行为不变。

### B 层：需用户决策

**B1 编辑器与应用页的 CTA 双 accent——统一还是定「双区规则」（设计决策）**
同一主行动「导出/下载 PDF」在应用页是近黑 `#18181b`（`server.mjs:1183`/`:4643`）、编辑器顶栏是橙 `#C2410C`（`editor-shell.js:59`）。两个方向：① 统一 CTA 色（应用页改橙或编辑器改近黑，注入层+应用层可改，无需解冻）；② 在设计文档定「编辑器=纸面世界（暖橙墨水）/应用页=工作台（近黑工具）」双区规则并写进 token 命名注释。**建议 ②**：编辑器暖色系是已裁决的视觉资产，强行统一会动其中一边的整体观感；定规则的成本远低于统一后逐一目检的成本。`--serif` 语义错位（A14 未处理项）并入此轮设计文档一起定。

**B2 编辑工具栏 emoji 与 handoff「0 可见 emoji」断言的矛盾（先核实再处置）**
截图实测报告截图 2 称 /edit 顶栏可见「💾 保存」「📄 导出 PDF」「🕘 历史」三枚彩色 emoji（`template.html:12-14` 冻结件字面量）；handoff 2026-10-21/10-22 两处声称该三按钮「沿用 MutationObserver 覆盖机制（早已覆盖）」且「8 页浏览器实测 0 可见 emoji」。**两者矛盾，本轮未复现，不臆断谁对**。建议：隔离实例 + 真实浏览器打开 /edit 核实一次——若覆盖机制失效（回归）则在注入层修复并补回归断言；若断言口径从未覆盖工具栏，则修正断言口径。修复路径不涉及解冻（运行时覆盖机制就是为冻结件 emoji 设计的）。

**B3 themes/ 屏幕段旧蓝清除（需解冻 `themes/`，需用户拍板）**
`themes/resume-classic.css:79-105`「编辑器（仅屏幕显示）」段仍是冷色旧蓝家族（#409eff/#4b5563/#1f2937，本轮 grep 核实），靠注入层高特异性覆盖 + `@media print` 隐藏兜底，打印外观不受影响、/edit 覆盖完整。彻底清除需解冻 themes/ 重设基线（handoff §5 明确「结论出来前不动 themes/」）。**不解冻时现状已有完整兜底，非紧急**；若日后解冻（如 Type 3 字体 ATS 调研出结论需动 themes/ 时）可顺带清除并重设 S2 基线。

**B4 评估历史列表（建议优先排期）**
走查 high「评估报告一次性 UI」的产品级解法；数据已在 `evaluations.json`（含指纹第五路比对用的全量记录），只差一个呈现页/列表卡（应用页层，不动冻结件）。2026-10-28 收口轮明确其「不在批准范围」，故列 B。**建议下一轮优先**：等 1–5 分钟的报告刷新即丢，是当前旗舰流程最大的价值漏损点；竞品 Job Tracker 的每职位 match score 已是标配（②.1）。排期时注意 handoff 的告诫：新增运行时数据文件要过备份清单关——本项不新增文件，风险低。

**B5 岗位草稿双入口能力对齐**
编辑器弹层补 brief 字段（折叠式「定制要求」高级区，复用首页表单的六项）或统一走首页表单。涉及交互取舍（弹层加字段 vs 引导去首页），A15 的提示是止血，能力对齐需拍板。

**B6 S5 引导向导（优先级建议：M2 首位）**
A3 只能止血「零文档首用」，产品级解法是 S5 八步向导（可跳过、预填补缺，roadmap 已定）。调研佐证：Novoresume「从真实经历起草、散料分块确认」模式是同类首选新手路径；「先确认散料再逐层结构化，不给空表单」正对走查发现的空态/空下拉问题。**建议 S5 排 M2 第一位**（在 S4b 之前）：首用断链是当前唯一的 high 级流程缺口，S4b 的进度/分批是体验增强。**拍板须知（v1.1 明示）**：这是对 roadmap §3.1 既定 M2 顺序「S4b → S5 → S6 → S8」（roadmap.md:110）的**翻转**——属 roadmap 自许的「除依赖外内部可插队」范围，但偏离既定顺序应在拍板时明示取舍，不应默认顺延。

**B7 S4b 五阶段进度与分批（次优）**
max 思考下单次适配 276s（handoff 实测）、评估 104s，五阶段可见进度的价值被这两个数字直接支撑；「无法准确计算时不显示百分比」的裁决与调研（诚实分数）一致。**前置依赖**：A9（轮询不吞输入）必须先落，否则进度期面板仍不可交互。建议排在 S5 之后。

**B8 导出文本层只读自检（小而值）**
对标 ②.8：导出后用 `pdftotext` 回读 PDF 文本层，校验姓名/邮箱/电话可提取——不碰模板、只读校验，挂进导出检查卡。**工具口径更正（v1.1）**：`pdftotext` 属 **poppler**，并非 macOS 自带——本项目测试链已装（agent-handoff.md:39 将 `pdftotext`/`pdfinfo`/`pdftoppm` 列为「系统依赖」，严格模式缺它直接失败），故对本仓库可行；`textutil` 的支持格式不含 pdf（`textutil` 帮助实测：txt/rtf/rtfd/html/doc/docx/odt/wordml/webarchive），**不可用作此校验**。同时可把「日期格式全局一致」「联系方式不在页眉页脚」两条内容层 lint（②.8）并入 S4a 已有的确定性检查清单。

**B9 编辑区 ARIA 语义（低优先，先核实落盘风险）**
对标 ②.10：编辑区补 `role="textbox"`+`aria-multiline`。但属性挂正文容器有随保存落盘的风险，须先核实 `/save` 行为或经剥离清单登记；单用户本地场景读屏收益有限，排末位。

**B10 S6/S7/S8/S9 排序建议**
- S6 模板库：押后。模板冻结是当前约束，且 FlowCV 对照显示「模板自由度」路线的差异化弱于「适配闭环 + 事实层」路线（②.1/②.2）；本项目最强资产是防幻觉机制（②.3）。
- S7b 截图导入优先于 S7a 语音：JD 截图是岗位闭环的高频输入形态（roadmap ③已预设依赖）；语音是输入便利性。
- S8 网申包：可吸收 Rezi MCP 的「文件即接口」思路——把素材/简历以纯文本文件暴露给本机任意 AI（Markdown 进 Markdown 出），零依赖达成 MCP 式集成，比做完整网申包 UI 更低成本。
- S9 录音复盘：重基础设施（whisper.cpp 本地部署验证未做，roadmap §7 明确未实测），维持 M3 末位。

**B11 明暗主题**：全仓 0 `prefers-color-scheme`（本轮六文件 grep 复核）。本机单用户浅色可接受，**建议登记现状、不做**；若用户实际使用中有夜间编辑需求再立项（届时注入层与应用层双轨改造，工作量集中在一套暗色 token）。

**B12 freeze.mjs bodyHash 渲染身份（既有「待拍板」项的登记引用；超出本 UI/UX 方案职责，v1.1 补录防丢）**
handoff.md:518 登记：「**[高] freeze.mjs：bodyHash 把打印时不可见的编辑态算进渲染身份**——`.edit-toolbar`/`.page-line` 在 `@media print` 下不可见，但其状态文案（已保存 ✓/未保存 ●）与 `data-editor` 版本进了 hash → 同一份 PDF 像素不变却判『较旧』。未修：改 bodyHash 口径 = 改渲染身份语义，会让既有 PDF 全变陈旧、导出历史键失效，已登记待拍板」。此项属渲染语义而非 UI/UX，本方案只做登记引用，防止在「待拍板清单」里漏掉；若拍板解冻渲染身份口径，建议与 B3（themes/ 解冻）同轮处理，共享「重设基线」成本。

### C 层：明确不做及理由

1. **不引入任何 npm 依赖**（红线）：cmdk（React 组件）、Tiptap/ProseMirror（编辑器）、云端 ASR、JSON Resume 的 CLI 与 67 个主题（全是 npm 包——其 **schema 字段设计可借鉴**为本地数据模型参考，工具链不引入）。
2. **不做多人协作/OT/CRDT**：Figma 同步引擎的全部复杂度来自多人前提（调研 ② 明确「单人场景的过度设计」）；单人场景省下的复杂度预算应投给保存信任、撤销、AI 可审计——这三项已达标的结论反过来佐证预算花对了地方。
3. **不做投递代理 / 招聘者分发 / Auto Apply**：外部账号、合规与滥用风险（调研明确「对本项目不适用」）；Resume.io 的 Recruiter Match 路线是云端套件逻辑，与本地单用户定位相反。
4. **不做「ATS 通过率」类恐吓分**：roadmap §5 已裁决「不把规则检查包装成录用概率/通用 ATS 分数」；行业佐证：Enhancv 官方明说「不存在所谓的 ATS score」，Resume.io 的「100% compliant」营销伴随最低口碑（②.2）。现有三级检查（需修复/建议核对/风格建议）保持。
5. **不做全局 suggesting 模式开关**：Google Docs 的全局模式有公认三痛点（②.7）；单人场景下「每条建议局部 diff + 接受/拒绝 + 统一撤销」已是更优解，加模式开关只增加状态混乱。
6. **不做后台自动改写全文**：未经确认改动高利害内容是 AI 界面反模式（②.6「zones of influence」），且与本项目事实护栏 + 审阅门控架构直接冲突。
7. **不动冻结件打印观感**：`template.html`/`themes/`/`render.mjs` 本轮零改动（红线）；B3 是唯一涉及 themes/ 的路径且明确需用户解冻决策，不解冻时兜底完整。
8. **已裁决口径不重开**：失败三态语义、落账确认前同步撤回候选、「待核对」会话内内存态、回执环形表淘汰后保持结果未知、iframe PDF 预览 headless 空白、设置页 key 明文、1280–1439 竖标签条折叠——均按 handoff 现行裁决执行，本方案不列为问题。
9. **不做幽灵文本（ghost text）式内联补全**：其官方来源文档本轮未取得（调研标注未验证），且「不确认即不落地」的轻量特性与简历高利害属性匹配度低，不投入。

---

## ④ 快赢清单（一天内可落地）

按「改动面小 × 影响高 × 验收现成」选出，全部为 A 层条目：

1. **A1 语义色三值**（`server.mjs:1143` 单行 + `editor-shell.js:37/52` 微调）：对比度已复算达标（5.18/4.79/5.91），断言闸门现成，一次提交修复 high 级可及性问题。
2. **A2 LLM 未配置文案五处 + 链接**（`server.mjs:2316/3844/3852/3911/3926` + `:1656`）：纯文案改动，消灭「指向不存在入口」的误导。
3. **A5 导出页去重 + 投递收尾链接 + label**（`server.mjs:4669/4727/4681-4683`）：三处模板微调，直接改善旗舰流程收尾。
4. **A6 设置页激活态 + 危险样式 + 表单宽**（`server.mjs:3661`/`:3640`）：CSS 为主，消除「选错模型供应商」的高频误读点。
5. **A10 区域行键盘化 + bindOne 吞错 + openPicker 语义**（`zone-panel.js:142/151-156/625/547`）：几行 JS，模式照抄同仓素材卡，补上 handoff.md:609 登记的缺口。
6. **B2 核实半步前移（v1.1 按评审归位，零改动）**：隔离实例（临时 RESUME_ROOT + 随机端口 + 合成文档）+ 真实浏览器打开 /edit 一次，核实编辑工具栏 emoji 运行时覆盖是否生效——handoff:296-297 与截图实测报告矛盾（见 B2），此核实不需要用户决策：若覆盖失效即注入层修复并补断言，若断言口径未覆盖工具栏则修断言口径。约半小时，把 B2 从「待决策」变「可执行」。

> 前五条合计约半天到一天，第 6 条约半小时；共同验收口径：`test-structure.sh` 全绿 + 隔离实例浏览器点一遍（隔离 RESUME_ROOT + 随机端口 + 合成文档，绝不碰真实数据与 7766 服务，自起进程记录 PID 并以退出钩子回收）。

---

## 附：诚实留白

- **输入材料不在仓库（v1.1 补录，含评审能力边界）**：三路界面走查、截图实测、两路调研的原始报告均不在仓库中（仓库内只有本方案对其的引用）；遗漏核查只能对 handoff.md / consolidated-audit / roadmap 交叉进行，**无法排除走查原文尚有本方案未收录的条目**。本方案以输入材料为事实边界；后续若走查原文入仓，应做一次逐条对账。
- **v1.1 修订记录（独立评审 8 问题 + 5 遗漏逐条处理）**：全部接受或部分接受，无「不采纳」项——
  - 问题 1 接受：UI-2 断言（test-structure.sh:4060-4067）列为 A1 落点 ②，A1 验收改「test-structure.sh 全绿」。
  - 问题 2 接受：A1 顺带改「局部 `--ed-accent-strong` token」方案，明确不动全局 accent 家族（8 处/47 次引用实测），消除与 B1 的矛盾。
  - 问题 3 接受：A 层范围声明修正（test-structure.sh 两处断言同步单列为例外）；A14 白名单面改实数 25 处（21 暖阴影 + 3 黑 + 1 白）。
  - 问题 4 接受：A12 点名清单补全为 9 处、验收弃用字符类正则改字面 grep；A2 验收限定五处上下文（:4173 注释例外说明）。
  - 问题 5 接受：①「两套体系统一」改为「仅 warn 同值，ok/err 不同值待 B1 定」；②B8 工具口径更正（pdftotext 属 poppler、textutil 不支持 pdf）。
  - 问题 6 接受：4 处行号/表述漂移修正（2103、1153/1157、401、44 个图标），并在证据核验声明中留痕。
  - 问题 7 部分接受：撤回「曾修后回归」叙事（handoff.md:609 只是问题+修法登记，无「已修」明文；但该表也未标注未修——现状按未修处理），A10 修复动作保留。
  - 问题 8 接受：A4 写明搜索过滤坑与规避方案。
  - 遗漏 1/2 接受：handoff:611（不可见暂停轮询）并入 A9、handoff:612（符号钮 aria-label）并入 A12，均已实测确认未修。
  - 遗漏 3 接受：handoff:518（freeze bodyHash 待拍板）补录为 B12。
  - 遗漏 4 接受：§1.1 两处优点带上 handoff:180/:78 的已知边界。
  - 归位建议接受：B2 核实半步进快赢（第 6 条）；B6 明示翻转 roadmap:110 既定顺序。
- 截图实测一路为文本报告，4 页截图本轮未重拍；其「1280 无横向溢出、console 0 错误」等结论引用时标注来源，未复验。
- B2 的 emoji 矛盾未复现，列为「先核实再处置」而非结论。
- 对比度候选值（#A25711/#15803D/#B91C1C 及 saving pill 候选 #9A3412）已数学复算，但**色相观感**（徽章在暖色底上的和谐度）需落地时人工目检一次。
- 竞品社区抱怨（Trustpilot/Reddit 一手原文）调研轮未能访问（403/限流），相关结论仅基于官方页自显信号，标注未验证。
- A12 的 chips 22px 保底是登记的取舍而非达标项——WCAG 2.2 AA 的 24×24 若被用户要求严格执行，需回到该条重议。
- 本方案为设计文档，未动任何生产代码；所有 file:line 以 `main@7430f03` 为准，后续提交可能使行号漂移。
