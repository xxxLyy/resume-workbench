# M1 总体实施计划（自用稳定：S0 → S1 → S2 → S3 → S4a）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement task-by-task. 本文件为阶段级计划；S0 的详细任务级计划见 `dev-docs/2026-09-23-s0-plan.md`，其设计见 `dev-docs/2026-09-23-s0-design.md`。
>
> **Goal:** 让简历工作台在 M1 结束时恢复并加固"编辑→保存→导出→投递"主链路：渲染可用、样式与内容分离、杂志观感、区域绑定、岗位适配核心链路。
> **Architecture:** 零框架 Node + 自包含 HTML 文档不变；新增主题层与区域绑定均为 `docs-meta.json` 上的数据契约扩展，正文 HTML 不被重构（路线图决策 3/5）。
> **Tech Stack:** Node（ESM .mjs）、playwright-core 1.60.0（pin）、系统缓存 Chromium headless shell、poppler（pdftotext/pdfinfo）、bash 测试三套件。
> **Spec:** `dev-docs/2026-09-23-roadmap-magazine-and-features.md`（v4.1）

## Global Constraints（逐字摘自 spec，所有任务默认包含）

- 一次只做一个 S；每个 S 开工前写 `dev-docs/YYYY-MM-DD-<sN>-design.md` → plan → impl → 验证，回写路线图 §3.1 状态表。
- 既有编辑方式回归门槛（决策 5）：直接点击正文编辑、章节/条目积木、选区浮动工具条改写、排版面板与缩放、统一撤销栈、历史快照回滚、多标签冲突保护；任何 S 不得使 `test-editor.mjs` 常驻套件变红。
- 真实数据保护：测试一律隔离数据根（`RESUME_ROOT`），前后真实数据指纹比对；AI/视觉/语音测试用本地 stub 并标注"模拟验证"。
- 隐私门槛：`docs/ snapshots/ pdfs/ backups/ logs/ config.json applications.json materials.json docs-meta.json` 等永不入 git；隐私检查在首次提交前完成。
- 编辑器模板版本升级必须走 `migrate-editor.mjs` 模式（先快照、幂等、护栏版本号）。
- 投递 PDF 保持 ATS 干净（决策 2）；主题/排版变化必须使旧 PDF 标记失效（决策 1）。
- 不升级 playwright-core；不做录用概率/通用 ATS 分数；不自动同步岗位版；AI 不补造经历。

## 验收参数（本计划定稿，后续计划继承，不留到实现后）

| 参数 | 值 | 用在哪 |
|---|---|---|
| Chromium 探针超时 | 60s（内含 pdftotext 30s） | S0 |
| 单次渲染超时 | 120s | S0 起全局 |
| LLM 单请求超时 | 120s；超时明确提示（§3.2） | S4a 起 |
| 渲染并发 | 1（排队） | S0 起全局 |
| 改写批次并发 | ≤3 | S4b |
| 转写并发 | 1 | S9 |
| S1 视觉回归门禁 | 文本层逐字 0 差异（硬）＋ 同环境同字体像素差异占比 ≤0.5%（硬） | S1 |
| 排版迭代上限 | 3 轮；超限走"手动取舍 / 超页导出并标注" | S4a |
| 代表性夹具 | `tests/fixtures/fixed-resume.html` + `fixed-jd.txt` 入仓（虚拟、无真实信息），S4a 计划定稿 | S4a 起 |
| 日志容量 | 50MB 触发轮转，保留尾部 2MB 到 `.1`；每 24h 与启动时检查 | S0 |

## 阶段依赖、交付物与进出准则

### S0 修渲染 P0 + 工程底线（详细计划见 s0-plan.md）
- 进入：无。退出：probe 渲染出 PDF；导出页成功；探测结果固定可复现；三套测试全绿；隐私检查通过后有首次提交；日志落 `~/resume/logs/` 且轮转生效。
- 交付物：`chromium.mjs`（探测/探针/缓存/锁）、`render.mjs`/`test-editor.mjs` 接入、`privacy-check.sh`、`.gitignore`、git 首提交、plist 日志改造。
- **S0 完成后渲染环境固定，S1 设计才能定视觉回归基线。**

### S1 样式与内容分离（地基）（已完成 · 2026-09-26）
- 进入：S0 退出准则全满足。退出（2026-09-26 S1-T10 真实数据迁移与三门禁验收通过，全部勾选）：
  - [x] 主题层与样式来源登记生效（`themes/resume-classic.css` 唯一源；legacy 文档补 `data-style-origin="legacy-inline"` + theme/styleHash 登记）；
  - [x] `docs-meta[id]` 成为排版微调唯一数据来源（当前文档落盘不含 typo）；
  - [x] **含正文的渲染标识 renderInputId**（bodyHash+cssHash+typoHash+resourcesHash）与冻结契约（快照/存档自包含、永不读当前 meta）定稿并实现；
  - [x] 旧快照/存档仍可独立渲染（28 份历史快照 md5 迁移前后逐一一致，只读预览/PDF 渲染验证通过）；
  - [x] 视觉回归门禁通过（文本层 0 差异 + 页数同 + RGB24≤0.5%；真实迁移两文档三项全过、实测 max=0）；
  - [x] 迁移事务（schemaVersion + .tx 恢复）幂等可回退（schemaVersion 1→2 双文档 done；幂等重跑 no-op；`backups/pre-s1-<ts>/` 全量副本 + 逐文档 pre-image 快照）。
- 交付物：`themes/resume-classic.css`、`freeze.mjs`（freezeHtml/normalizeToCurrent/renderInputId/staleInfo）、注入链路改造、`.tx/` 事务与文档锁、`migrate-meta.mjs`（**数据格式 schemaVersion 1→2；编辑器版本 data-editor 不变，仍 v5** —— 两者是不同字段）、导出记录表 `docs-meta[id].exports[]`（exportId/snapTs/完整 renderInputId/不可变产物）、文档状态维度模型（**存储字段** kind/flow/archivedAt；**派生自 applications.json 的仅投递关联** deliveredRefs/usedBy；可投递为派生判定）。
- 数据契约（接口级，S1 设计 v3 定稿）：`docs-meta[id] = { theme, styleHash, typo, schemaVersion, migration, rev, renderInputId 相关(lastRenderInputId/lastRenderAt), kind, flow, archivedAt, job?, exports? }`；快照冻结格式 = 自包含 HTML（内联 typo）+ 伴生 `snapshots/<id>/<ts>.manifest.json`（theme、styleHash、typoHash、renderInputId、editorVersion、chromiumBin 可 null、browserVersion、fonts 记录、dpi、createdAt）；渲染环境旁车 `<pdf>.env.json`。

### S2 应用层全量换肤（已完成 · 2026-09-29）
- 进入：S1 退出。退出：统一设计变量与可读性验收通过；业务能力/路由/数据契约兼容；既有撤销零回归；首页首屏为「继续上次任务/针对岗位生成」+ 会话状态恢复（草稿/编辑位置/缩放/面板）；基础编辑能力（查找替换/格式/项目复制与删除恢复/聚焦/快捷键）接入统一撤销栈。
- 边界：预设与分享副本仅预留设计位、不展示无效入口；不重写撤销逻辑（兼容式接入）。
- **本阶段起 `test-editor.mjs` 立"既有编辑方式"常驻套件。**
- **实际结果（commits `5208e44`..`fd6ff12`，12 个实现提交 + 3 个文档提交）**：退出准则逐条达成，`test.sh` 194 ✅ / 0 ❌（浏览器常驻套件从 5 块扩到 17 块）、`test-structure.sh` / `test-render.sh` / `privacy-check.sh` 全 exit 0。设计 §7 十条验收各有指名证据（见 `dev-docs/2026-09-27-s2-plan.md` 附 A 映射与 `.superpowers/sdd/2026-09-27-s2-plan/progress.md`）。
- **与原计划的偏差（均已回写设计，不是静默偏离）**：
  1. 撤销口径唯一化——一次 ⌘Z 撤销"最近输入的 B"、保留 A 与加粗；定向撤销只对程序化操作承诺，格式化走浏览器原生 `execCommand` 不压快照栈（设计 §6.1，取代原"格式化属程序操作"的冲突表述）。
  2. 分派依据由"最后一次来源"改为**受信任输入计数器 + op 计数快照**，并建立 `__edMarkProgrammatic()` 共享出口——因为 AI/岗位面板自行派发合成 `input`（`ai-panel.js:160`、`job-panel.js:139/142`），布尔判定会把 AI 改写误判为原生输入；同时补齐面板隐藏路径不派发事件的既有缺陷。
  3. **`template.html` 零改动**：它被冻结进每份既有文档，改它只影响新建文档；保存清理/瞬态剥离/⌘S 门控一律落在注入层 + 服务端 `/save` 归一化 + `extract.mjs`，使升级前已存在的文档同权（设计 §6.2、验收第 10 条）。
  4. `?` 快捷键不得吃掉简历正文里的问号：只在焦点不在可编辑元素时触发，另给 `⌘/` 与工具条按钮两条入口（设计 §7.7 v2.4）。
  5. 主题文件与 `render.mjs` 全程零改动，PDF 等价以"像素证据 + 渲染路径字节同一"双重成立；`render.mjs` 的 print 兜底经实测确认不需要（既有文档全部自带 print 隐藏规则）。
  6. 顺带修掉三个既有缺陷：`/save` 每次保存净增 3 换行导致冻结件永不到稳态；离线恢复与撤销栈相撞可致**永久内容丢失**；1280×720 下纸张遮住状态条使「↩ 撤销」不可点。
- **上线遗留（T7 唯一开放门槛）**：`:7766` 仍跑修复前的内存代码，需一次 `launchctl kickstart -k` 重启，`/save` 换行修复才对真实文档生效。

### S3 区域绑定与区域级分析（已完成 · 2026-09-29）
- 进入：S1 退出（与 S2 可并行，但建议 S2 后以免预览层冲突）。退出：绑定持久化；自动初绑进待确认；段落拆分/合并/复制/排序/撤销/回滚后绑定"正确保持，或明确失效且不误改"（失效语义在设计文档定：无法判定归属→待重新绑定）；未确认绑定不阻止手动编辑与普通导出；区域级分析与修改模式可用；事实与表达分离的素材模型迁移完成。
- 先验证绑定模型（小切片），再扩展区域分析面板（计划拆两个任务组）。
- **实际结果（commits `d7838f8`..`c03489d`，13 个实现提交）**：六块交付 —— ① 数据层 `zone.mjs`（zid 规范/初绑启发式/zoneSync/素材迁移纯函数）；② 服务端 `/zones` + `/zones/init` 端点、`/save` zid 归一与 zoneSync；③ 编辑器 zid 生命周期（未保存阶段确定性内容哈希、加载/input/paste/克隆四口打点、初绑客户端触发）；④ 区域 Tab UI（列表/定位/着色/改绑弹窗，`ZONE-INJECT` 注入链）；⑤ 区域级 AI（分析/改写端点，受约束解析 + 请求最小化）与修改模式接受链路（严格 S2 撤销顺序，S2 撤销块零回归）；⑥ 素材事实层（facts/factStatus 三态 + `/materials` 事实表单 + `migrate-meta.mjs` 幂等迁移）。验证：`test.sh` 219 ✅ / 0 ❌（S2 收官 194 → 219）、`test-structure.sh`/`test-render.sh`/`privacy-check.sh` 全 exit 0；冻结面（`template.html`/`themes/`/`render.mjs`）diff 为空；PDF 等价抽验（detached worktree `e87a4c9` 基线 vs S3 后，同一夹具 + zid 打点变体）双 ratio 0.000000。AI 结论均为本地 stub 模拟验证。
- **与原计划的偏差（均已回写设计 §3.2 与本文件，不是静默偏离）**：
  1. `freeze.mjs` 新增 `stripZid`（授权偏差，S3-D pin）：`renderInputId` 只度量视觉输入，`data-zid` 属非视觉 bookkeeping，bodyHash 前摘除——这是 S1-C-2（渲染身份不含非视觉属性）不放宽的唯一修法；冻结 html 逐字节不变。
  2. zid 计入内容哈希的口径代价：旧文档首次打点保存会使 reviewed 草稿一次性降级 draft（contentHash 变化触发既有"来源较旧"语义；可逆，重新导出即恢复）。S4a 前决定是否对齐口径。
  3. `/zones` 与 `/zones/init` 对不存在的 doc id 会创建孤儿 meta 条目（前端仅 `/edit` 场景调用，低风险）；建议 S4a 前补 docPath 存在性检查。
  4. 区域改写为纯文本替换，会拍平段内 inline 标记（已知限制，diff 预览可见、事实护栏仍生效）。
  4a. 设计 §3.4「粘贴/克隆后 meta 侧继承原 zone」实现为启发式近似：新 zid 不在 meta，`zoneSync` 按所在章节启发式补 pending。同章节粘贴语义等价；跨章节粘贴落到启发式 zone（仍 pending 需确认），实际影响可忽略——终审裁决明确接受。
  5. 真实 `materials.json` 持久迁移待用户手动跑 `node migrate-meta.mjs`（读时视图兼容已生效：`loadMats()` 即时推导，未迁移不影响使用）；回滚快照 `backups/pre-s3-mats-<ts>/`。
  6. T8 遗留登记（不修，供后续）：escAttr 存量 `server.mjs:2537-2538` 同病；`matConfirmAll` 会把 outdated 刷成 confirmed（confirm 门控）；素材页 fetch 无错误分支；`migrate-meta.mjs` 头注释未提素材段；factGuard 中文数字盲区（S2 共享）；digest per 调优须联动 MARKERZZ canary 夹具；S3D 测试走回落臂未覆盖 detail 主臂（生产主臂经 T6 quality 探针补证）；instruction 服务端无长度上限；接受后定位/文案 UX 微瑕；手写 HTML 双 data-zid 极端形状（`zone.mjs:4` 已文档化包络）。
- **上线遗留（T8）**：`:7766` 常驻服务需一次重启加载 S3 代码；可选：用户手动跑素材持久迁移（见偏差 5）。

### S4a 岗位适配核心：生成→审阅→导出
- 进入：S3 退出。退出：证据对应表四态可用且可定位/可追溯；定制要求卡与预设；局部重生成与手改保护；有终点的审阅面板；排版问题定位；确定性检查三级；§3.2 AI 任务管理最小集首落地；事实层校验生效。
- 计划拆三个可验收任务组：① 要求与证据（对应表+定制卡+预设）；② 局部生成与审阅（重生成/保留标记/拒绝原因/终点审阅/任务管理）；③ 排版与导出（诊断/迭代上限/确定性检查/导出记录联动）。

## 回归要求（每阶段结束必跑）

1. `bash test.sh`（含浏览器级，Chromium 不可用时 exit 2 记跳过）、`bash test-structure.sh`、`bash test-render.sh`。
2. 真实数据指纹前后一致（test.sh 内置）。
3. 既有编辑方式常驻套件（S2 起）。
4. 里程碑验收（M1 结束）：用代表性岗位任务对比成稿时间、人工修正次数、导出成功情况；真实模型效果另行授权验证，stub 结论标注"模拟验证"。

## 停止点与后续

- 每个 S 结束都是可用停止点；M1 结束即"自用稳定"，可不再继续。
- 下一份文档顺序：S1 design（S0 完成后）→ S1 plan → S2 plan 与 S3 plan（分开：视觉改造 vs 编辑行为）→ S4a 三任务组 plan。
- M2（S4b/S5/S6/S8）与 M3（S7/S9/开源检查）保持阶段级规划，开工前再细化；依赖自洽性见路线图 §3.1。

> **2026-10-05 更新（S4a 交付）**：S4a T0–T12 已全部实施并通过四件套（test-structure / test-render / privacy-check / test.sh，test.sh 332✅）。M1（自用稳定）五阶段代码全部就绪，待用户授权重启 launchd 服务即完成上线。提交链 e67cd7f…4810a09（S4a-T7 至 T11 补提交），基线 bbbbad60 冻结件零偏差。终审记录见 `dev-docs/2026-10-05-s4a-final-review.md`。
