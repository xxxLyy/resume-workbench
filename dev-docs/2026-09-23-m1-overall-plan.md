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

### S1 样式与内容分离（地基）
- 进入：S0 退出准则全满足。退出：主题层生效；`docs-meta.json` 成为排版微调唯一数据来源；渲染版本标识（主题+排版参数哈希）与快照冻结格式定稿并实现；旧快照/存档仍可独立渲染；视觉回归门禁通过；迁移幂等可回退。
- 交付物：`themes/resume-classic.css`、注入链路改造、`migrate-editor.mjs` v5→v6、导出记录表 `docs-meta.json.exports[]`、文档状态维度模型（设计文档定：文档类型/流程状态/可投递/已投递关联/归档标记为独立维度，不塞互斥字段）。
- 数据契约（接口级，S1 设计定稿）：`docs-meta.docs[id] = { theme, typo, renderVersion, regions?, exports? , job? }`；快照 v6 = 自包含 HTML + `frozen/manifest.json`（theme css 哈希、typo、资源清单）。

### S2 应用层全量换肤
- 进入：S1 退出。退出：统一设计变量与可读性验收通过；业务能力/路由/数据契约兼容；既有撤销零回归；首页首屏为「继续上次任务/针对岗位生成」+ 会话状态恢复（草稿/编辑位置/缩放/面板）；基础编辑能力（查找替换/格式/项目复制与删除恢复/聚焦/快捷键）接入统一撤销栈。
- 边界：预设与分享副本仅预留设计位、不展示无效入口；不重写撤销逻辑（兼容式接入）。
- **本阶段起 `test-editor.mjs` 立"既有编辑方式"常驻套件。**

### S3 区域绑定与区域级分析
- 进入：S1 退出（与 S2 可并行，但建议 S2 后以免预览层冲突）。退出：绑定持久化；自动初绑进待确认；段落拆分/合并/复制/排序/撤销/回滚后绑定"正确保持，或明确失效且不误改"（失效语义在设计文档定：无法判定归属→待重新绑定）；未确认绑定不阻止手动编辑与普通导出；区域级分析与修改模式可用；事实与表达分离的素材模型迁移完成。
- 先验证绑定模型（小切片），再扩展区域分析面板（计划拆两个任务组）。

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
