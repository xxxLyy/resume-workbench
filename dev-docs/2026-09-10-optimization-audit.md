# 简历平台优化审计报告（2026-09-10）

> 执行：xiang（总 agent）+ ling（代码审计/后端加固/TDD）+ hao（浏览器实测/环境/UI 回归）
> 范围：可靠性、代码质量、UI/UX + retry 功能落地 ｜ 全程 ponytail + TDD + 无 git 操作

---

## 1. 结果总览

| 项 | 结果 |
|---|---|
| 代码修复 | 8 项（A1-A7 + PORT NaN 防护），全部 ≤3 行最小修复 |
| retry 功能 | ✅ 落地（交接文档候选 A），T1-T7 七场景测试全绿 |
| UI 修复 | 6 项（D1/D2/D3/D4/D7/D9），浏览器回归 6/6 实证通过 |
| 测试 | test.sh 38 断言 ✅ / test-structure.sh（含 withRetry 七场景）✅ / test-render.sh ✅ |
| 真实 LLM 链路 | listModels（4 模型）+ 最小 chat 均通过（withRetry 包装后） |
| 事故 | config.json 丢失 1 起（已恢复 + 防复发三件套上线），见第 4 节 |

## 2. 代码修复清单

**server.mjs**（ling 实施，test.sh 新增 13 条断言，10 条严格红→绿）：
- `/save` 空正文 → 400（此前会清空文档）
- 4 个 JSON 端点坏 body → 400（此前 500）
- config.json 保存改 tmp+rename 原子写
- `/save` tmp 名加唯一后缀（防并发互踩）
- `PORT` 非数字时回退默认端口（此前 launchd 崩溃循环）
- 快照页说明行："快照 = 保存前的旧版本，当前版本不在列表中。"
- 列表页上传控件中文提示

**llm.mjs**（xiang）：
- `withRetry(fn, {retries=2, delayMs=1500, sleep})`：仅网络错/5xx/超时重试，4xx 不重试；sleep 可注入
- `okOrThrow(prefix)`：HTTP 错误挂 `.status` 供重试分类
- `chatMsgs` 增加 choices 结构校验（"LLM 返回格式异常"），`r.json()` 与校验刻意在 withRetry 外（格式错不重试）
- `chatMsgs`/`listModels` 均经 withRetry 包装

**render.mjs**（xiang）：`try/finally await browser.close()`，中途抛错不再留孤儿浏览器进程。

**ai-panel.js**（xiang）：
- 对话发送防连点（sending 标志 + 按钮 disable，堵 click 与 Enter 双入口）
- `#ai-drawer`/`#ai-toggle` z-index 98→101（修复 ✕ 被 .edit-toolbar[99] 遮挡**无法关闭抽屉**的高危问题）
- ✕ 扩至 24×24px + hover 态 + aria-label
- **旧文档样式补丁**（serve 注入，/save 随面板剥离，不污染落盘文档）：工具栏按钮加高、分页线淡化+标签移页边距、focus-visible 蓝色焦点环

**template.html**：同上三项样式修正（供新文档原生使用）。

## 3. UI 验证结果（hao，Playwright 实证）

- D1 ✕ 24×24px，elementsFromPoint 首位即 `#ai-close`，点击可关 ✅
- D2 工具栏按钮 30px → 41px ✅
- D4 分页线 rgba .32，标签移至线下方页边距不压正文 ✅
- D3/D7 文案均在 ✅ ｜ D9 Tab 走查焦点环 ✅
- 核心链路（复制→编辑→保存→快照→回滚→PDF→删除）无回归，console 零报错
- 截图证据：`/tmp/resume-audit/p4/`（6 张）

## 4. 事故记录：config.json 丢失与防复发

**经过**：test.sh 的 config stash/restore 在"超时 SIGTERM 中断 trap + 后续轮次交错"下把 `config.json` 与 `.realbak` 一起删除。用户已在设置页重新录入（06:46）。

**防复发三件套（已上线并实测）**：
1. mkdir 原子并发锁（`/tmp/resume-test.sh.lock`，第二实例即时退出）
2. stash 文件名 PID 后缀（`config.json.realbak.$$`）
3. trap 完整清理（含锁 rmdir）

**教训**：任何"移动-恢复"式测试夹具必须假设自己会死于任意信号；锁 + 唯一名是底线。

## 5. 遗留项（已决策不修/暂缓）

| 项 | 决策 | 理由 |
|---|---|---|
| findAndReplace 跨标签未命中 | 不修 | Range 跨节点复杂度不成比例，已有手动兜底 |
| .upload-*.pdf 残留 | 不修 | 纯磁盘垃圾 |
| 同名 id 继承旧快照 | 不修 | 已接受的隐性恢复路径 |
| 快照 retention 50 硬编码 | 不修 | YAGNI |
| 移动端 375px 编辑器横滚 | 不修 | 桌面工具，A4 固定宽是设计使然 |
| emoji 图标换 SVG | 暂缓 | 工作量/收益不成比例 |
| 新建空白文档入口 | 暂缓 | YAGNI |
| ✕ hit area 24→44px | 记录 | 刚达 WCAG AA 下限，后续可扩 padding |
| 焦点色蓝/紫两套 | 记录 | 后续统一到设计 token |
| headless 截图中文乱码 | 不修 | 环境缺字体，真机正常 |

## 6. 测试纪律更新（增补 handoff 第 4 节）

- test.sh 现有并发锁，**不要绕过**；手工调试也不要并行跑两个 test.sh
- config.json 恢复路径：设置页重新录入（无其他备份源）

---

## 7. S1 新粗野 UI 升级 + 模板回滚（2026-09-10 同日）

**最终形态（用户拍板）**：平台 UI（列表工作台/设置/历史页 + AI 面板）= 新粗野；**简历文档模板 = 经典原版**（S1 曾上 brutal 简历模板，用户目检后回滚，brutal 版留存在快照中）。

- 平台页：server.mjs `page()` 壳 + `listPage()` 重写（文档卡片/快照数/PDF 徽标/AI 徽标/工作台头），test.sh +S1 断言
- 简历文档：`migrate-style.mjs`（快照→替换 `<style>`，BRUTAL-V1 幂等，`--force` 强制重同步）执行过迁移与回滚（回滚走平台 /rollback 端点）
- ai-panel.js：brutal 面板 + 经典文档 D2/D4/D9 补丁（serve 注入，/save 剥离）
- 修复：`@media print` 须同时重置 `html` 背景（画布色取自 html，末页不满会漏底色）——已验证末页纯白
- 设计/计划文档：`dev-docs/2026-09-10-brutalist-ui-design.md`、`dev-docs/2026-09-10-brutalist-ui-plan.md`

## 8. 多模型配置（profiles，2026-09-10）

- config.json 新格式 `{active, profiles:[{name,baseURL,apiKey,model}]}`；`llm.mjs loadProfiles()` 归一旧格式（单配置=名为"默认"的 profile），`loadConfig()` 返回 active 份，消费方零改动
- 设置页：配置卡片 UI（增删/启用 radio/每卡测试连接），POST /settings 校验（四字段非空/name 唯一/active 界内，空 profiles 合法），A3 原子写
- 列表页 AI 徽标显示当前配置名（🤖 AI: 默认）
- 删除配置卡有 confirm（误删防护）
- 已知接受项：API Key 在设置页 DOM 中明文（type=password 仅视觉打码）——本机单用户可接受，多人/远程化时需改为服务端不下发明文

**当前测试规模**：test.sh 46 断言 / test-structure.sh（含 withRetry 七场景）/ test-render.sh（含 ATS 字符量 ≥200 护栏）——全部全绿。

---

## 9. S2 内容竞争力（2026-09-10）

**交付**：AI 抽屉 Tab 化（💬 对话 / 🩺 体检 / 🎯 JD 匹配），三能力全部上线：

- **🩺 体检**：`POST /ai/review {id, mode:'full'|'quant'}`——full=五维评分（结构/量化/动词/冗余/ATS），quant=量化成果聚焦便宜版（prompt 内置"不编造事实"约束）
- **🎯 JD 匹配**：`POST /ai/match {id, jd}`——粘贴 JD 文本（明确不做 URL 抓取，YAGNI），匹配度+差距清单
- **统一报告契约**：`{report:{score, summary, items[], changes[]}}`，解析失败降级 `{reply}`（parseChanges 同款哲学）；`parseReport`（ai.mjs）围栏清洗+shape 校验
- **应用闭环**：changes 复用 renderChange/findAndReplace，逐条"应用"直改文档（before ≤80 字逐字纪律保命中率），实测正文真实替换且未保存时落盘零改动
- 前端：防连点 disable、409 降级文案、分数卡 brutal 风
- 实测（真实 token，用户批准）：quant 体检 62→72 分、JD 匹配 72 分（准确识别学历差距/TensorRT 缺失）
- 已知接受项：客户端 fetch 无重试（系统休眠可打断长请求，错误路径优雅+手动重试即可；服务端 LLM 调用已有 withRetry）

**测试规模更新**：test.sh 53 断言 / test-structure.sh（+parseReport 五路径、buildReview/buildMatch）/ test-render.sh 不变。

---

## 10. S3 多版本管理：标签 + 差异对比（2026-09-10）

- **标签**：`docs-meta.json` sidecar（`{id:{tag}}`，原子写；UI 元数据不进文档不污染快照）；`POST /tag`（VALID_ID + ≤20 字 + 空串清除）；列表页按标签分组（未标记垫底；**全空时纯平铺无组标题**——hao 实测发现噪音后修正）+ 🏷 按钮 + 徽标
- **差异对比**：`diff.mjs` 纯函数（docToLines 块级剥离 + diffLines LCS，零依赖零 token）；`GET /diff?base&to` 红删绿增对比页（每行 escHtml）；无 to 时列出可选对象
- **测试纪律新增**：docs-meta.json 纳入 test.sh stash/restore（同 config.json 模式，PID 后缀 + trap）——用户真实元数据不进测试
- 实测：分组/切换/清空/自比全同/双文档 53 删 77 增渲染，console 零报错

**测试规模更新**：test.sh 57 断言（+S3 五条）。

---

## 11. S4 求职流程：投递台账 + JD 联动（2026-09-10）

- **台账**：`applications.json`（含 createdAt/updatedAt，原子写；第三个纳入 test.sh stash/restore 的保护文件）；状态枚举 `已投递→笔试→面试中→offer / 已拒 / 搁置`（终态只出不进）
- **看板**：`GET /applications` 六列看板（brutal 壳），新增表单（关联现有文档下拉），卡片 ◀▶ 流转 / ✏️ 编辑 / 🗑 删除（confirm）/ 🎯 匹配
- **JD 联动**：🎯 → `/edit?id=X&jdfrom={appId}` → ai-panel.js 预填桥（拉 `GET /app/jd` → 填 JD Tab + 切 Tab + 开抽屉）
- **JD 链接读取**：`POST /ai/jd-text {url}`（http/https 白名单、15s 超时、5MB 上限、4000 字截断；200+ok:false 错误形态同 /ai/test）；JD Tab 加"📥 读取链接"按钮；反爬/登录墙站点失败时提示手动粘贴
- **AI prompt 加固（同批）**：修 buildChat 病句（原"输出空数组…并在 note 里没用"自相矛盾）、补 chat 的 ≤5 条上限与"不编造"约束、统一四 prompt 的 JSON 契约措辞
- 实测：看板 CRUD/状态流转/终态隐藏▶、🎯 桥接四要素、链接读取（自读列表页验证）、真实 JD 分析 92 分

**测试规模终态**：test.sh 64 断言 / test-structure.sh / test-render.sh —— 全部全绿。

**遗留观察（不阻塞）**：JD 链接读取的"读取链接中…"提示在输出区而非 textarea，位置不显眼（hao 建议）；headless 环境 emoji 渲染缺字体（真机正常）。

---

## 12. S5 Bento 网站化 + 🟢 四项（2026-09-11）

- **风格换代**：新粗野退役 → Bento 仪表盘风（灰底 #f5f5f4、白卡圆角 12px 微阴影、黑主按钮、靛蓝 #4f46e5 强调、彩卡统计）；page() 壳统一 nav（当前页高亮）+ 页脚 + 内容区 1100px（含 padding，实测内容 1060 为设计值）；ai-panel.js 同步换肤（功能零改动）
- **列表页**：统计四卡（文档数/投递中/AI 配置名/PDF 就绪数）+ 文档大卡网格 + 虚线新建卡；标签分组保留
- **🟢B 渲染重试**：render() 失败自动重试 1 次；`RESUME_RENDER_BIN` 环境变量仅供测试注入（生产勿设）
- **🟢C 重新结构化**：降级文档（含"以下为 PDF 提取的原文"标记）卡片出现 🔁 按钮 → POST /restructure（409/404/400/502 守卫链，成功先快照再覆盖）
- **🟢D 新建文档**：POST /new → doc/doc-N 顺延空骨架 → 跳编辑器
- **🟢flaky**：PORT NaN 测试固定 sleep 改 15×0.2s 轮询，三连跑实证
- **事故记录**：hao 回归时 browse refs 错位误删 old-resume——快照机制恢复 HTML（md5 核验无损），但漏恢复 PDF（/delete 连带删除），由 xiang 复核时补齐重渲染。教训：删除类自动化操作须按卡内文本精确定位；事故复核要覆盖连带产物
- 编辑器深色工具栏与 bento 抽屉左缘轻微重叠（记录，不阻塞）

**测试规模终态**：test.sh 68 断言（三连跑零 flaky）/ test-structure.sh / test-render.sh —— 全部全绿。

---

## 13. P0 核心闭环 W1（2026-09-11）

依据用户完整简报（目标：素材→通用简历→岗位定制→导出投递→面试跟进→复盘）。

- **编辑器可靠性**：顶栏（文档名/岗位徽标/保存四态机：未保存●/保存中/已保存✓/失败点按重试）；**自动保存=停笔 3s 静默存且不打快照**（`/save?autosave=1`），手动保存才打快照——解决快照淹没问题；⌘/Ctrl+S；beforeunload 离开拦截；失败 localStorage 兜底+重试
- **岗位版本**：`POST /version/create`（from/company/role/jd，id 自动 v2/v3 顺延）；meta 扩展 `{tag,parent,company,role,jd,createdAt}`（向后兼容）；编辑器 verBadge + 列表页"岗位版"徽标；**母版独立性 md5 实证**；JD 报告 →"📌 据此创建岗位版本"
- **AI 审阅增强**：📍定位（原生选区高亮，不污染 DOM）、↩撤销已应用、应用前原文检查、空态使用引导
- **抽屉让位**：抽屉打开时编辑器工具栏右移 396px（elementsFromPoint 实证可点）
- **PDF 三态徽标**：待生成/需更新（doc mtime > pdf mtime）/已同步
- **编辑器迁移机制**：`migrate-editor.mjs`（toolbar+script 块替换，`data-editor` 版本标记幂等，先快照，不匹配跳过）——v2=保存状态机，v3=导出跳 /export
- 事故顺手清理：/new 测试残留 doc.html 清除

## 14. P0 收尾 W2（2026-09-11）

- **导出前检查页** `/export?id=`：版本确认（id+最后更新时间）、pdfinfo 页数、逐页空白检测（字符<10）、孤立标题启发式（页末短行）、文本层字符量、pdf 过期自动重渲、iframe 预览 + 新窗口兜底链接（headless Chromium 不渲染 PDF 插件属环境限制）
- **体检深化**：五维→七维（+【重复】+【一致性】），items 带维度前缀；**scoreBasis 字段**（评分口径说明，prompt 明确"不得暗示录用概率"），前端分数卡下方小字显示
- **JD 匹配深化**：四段式 items（【要求】→【简历证据】→【缺口】→【建议】），区分【有但未表达】/【真缺】两类缺口
- **首页重构**：主操作区（新建+折叠导入 details）、最近编辑大卡（mtime 前 2）、待办小卡（需更新/待结构化/投递中/AI/PDF 就绪）、搜索框、卡片/列表切换、文档卡主操作收敛为"继续编辑/导出"+⋯菜单（**点外部自动收起**）
- 统计四卡拆除（信息并入待办区，回应"统计卡抢占注意力"）

**测试规模**：test.sh 73 断言（三连跑零 flaky）。

**已知限制**：素材→简历无反向引用追踪（复制即脱离，同步靠人工）；iframe PDF 预览在 headless 截图环境为空白（真机正常）。

---

## 15. P1 复用追溯 W3（2026-09-11）

- **素材库**：materials.json（第四保护文件）+ /materials 页（搜索/标签/三栏表达：精简·技术·面试讲述/附件路径引用/逐栏复制）——明确"复制即脱离，同步靠人工"
- **历史增强**：snapshots/{id}/meta.json（名称/摘要/baseline）+ 只读预览页（**禁编辑+隐藏工具栏**——审查发现原实现可从旧快照误保存覆盖现文档，已修）+ /diff 支持 id@ts 跨快照对比
- **投递增强**：字段扩展（渠道/链接/日期/下一步/截止/interviews）；**/app/add 绑定当时快照 + 存档 PDF**（pdfs/archive/，审查发现死链已修为 /archive-pdf 端点）；表格视图（筛选/搜索/列排序， ling 首版漏实现被回归抓出返工）；面试记录内联表单（prompt 链被自动化覆写而改）；ics 导出；/ai/prep 面试准备（手动触发不落库）；首页 48h 到期徽标
- **响应式**：看板/表格 375px 溢出修复（根因=size=40 输入框撑爆页面，壳层 max-width:100%）

## 16. P2 保障 W4（2026-09-11）

- **备份**：GET /backup → tar.gz（docs/snapshots/pdfs/三 json；**config.json 明确排除**，密钥不进备份）
- **恢复**：POST /restore 两段式（apply=0 预览影响范围 → confirm → apply=1 合并覆盖，当前数据先留 /tmp 安全网）；实测删除→恢复→内容完整复原
- **中英文关联**：meta {lang, linkedTo}，EN 徽标 + ⇄ 互跳；一键全文翻译刻意不做（质量不可控，用 AI 对话逐段）
- **复盘**：/stats 状态漏斗 + 渠道/版本/岗位方向分组 + 面试转化 + 样本量明示（n<10 警告）+ 空状态引导

**测试规模终态**：test.sh **85 断言**（三连跑零 flaky）/ test-structure.sh / test-render.sh 全绿。
**今日九轮总览**：审计加固 → S1 Bento 换肤 → S2 体检/JD → S3 标签/对比 → S4 投递看板 → S5 网站化 → W1 编辑器可靠性与岗位版本 → W2 导出检查与首页 → W3 素材/历史/投递深化 → W4 备份/中英文/复盘。
