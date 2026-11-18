# Reactive Resume 接入评估（UPCV 复刻 §3 前置调研）

> 2026-11-18 调研文档。只评估，不动代码。
> 上位需求：`personal-ai-workbench-efc-20261116/docs/upcv-features-implementation.md` §3
> （「简历 CRUD+编辑器采用 Reactive Resume（MIT），自建模板与存储即可一比一」）。

## 结论（三行）

1. RR 现 v6.1.1（2026-11-13），MIT 属实；但 UPCV 的 templateData 是 **RR v4 schema**——v4 已 EOL（2026-01 停更），v5/v6 完全重写；`@reactive-resume/schema` 从未发布 npm，复用只能靠 vendor 源码。
2. 本仓是「整页 HTML + contenteditable + CSS 主题」，**没有 JSON 数据层**；RR 是「JSON schema → 渲染器」——差距是范式级，但桥接零件（sectionsOf/deriveResumeFields/structure.mjs 内部 JSON）都在。
3. **推荐路径 C（RR-schema 作导出/导入交换格式）→ 可选 B-lite（sidecar JSON 存 RR 兼容数据）**；路径 A（嵌入 RR 编辑器）与单文件零依赖架构冲突。

## 1. RR 官方现状

| 代 | 版本 | 状态 | 技术栈 |
|---|---|---|---|
| v4 | v4.5.5（2026-01-08 末版） | EOL，v4.rxresu.me | React+Vite + NestJS + Prisma/Postgres + artboard 独立 app + Puppeteer printer |
| v5 | v5.3.1（2026-09-17） | 被 v6 取代 | React SPA + Hono + Drizzle + react-pdf |
| v6 | v6.1.1 | 当前 | React 19 SPA + Hono + Postgres + TipTap + Forme（Rust→WASM PDF） |

- License MIT（docs.rxresu.me/legal/license）；仓库 reactive-resume/reactive-resume，45.8k★。
- UPCV templateData 字段（metadata.css.{value,visible}、page.format/margin、picture.effects）与 **v4** libs/schema 字段确切对应——UPCV 编辑器是 v4 artboard 时代衍生 fork。
- schema 未发布 npm（issue #2123 被拒）；复用方式 = vendor 源码（MIT，保留版权行）或 git 依赖。
- 模板 18 套真实存在：azurill/bronzor/chikorita/ditgar/ditto/gengar/glalie/kakuna/lapras/leafish/meowth/onyx/persian/pikachu/porygon/rhyhorn/scizor/smeargle（React 组件，v5=react-pdf 原语，v6=Forme 原语）。
- Forme 引擎（danmolitor/forme）可单独引入——将来替换 Chromium 渲染管线是比 react-pdf 更贴的选项。

## 2. 三条接入路径

| | A 嵌 RR 编辑器 | B RR schema 为存储模型 | C RR-schema 导入导出 |
|---|---|---|---|
| 做法 | 跑整套 RR，iframe/反代进工作台 | docs/*.html 改存 resumeData JSON，编辑器重写为表单式 + JSON→HTML 渲染器 | 本仓仍存 HTML；加 doc→RR-JSON 导出 + RR-JSON→doc 导入 |
| 接近 UPCV | v4 嵌入≈同源；v6 反而更远 | schema 字段一致，渲染自家 themes | 数据互操作一致，编辑器两样东西 |
| 工程量 | 大（v4 五件套/v6 三件套 + Postgres） | 很大（实质重做产品核心，破坏 DESIGN.md 冻结契约） | 小（复用现有解析件写纯映射） |
| 风险 | 架构冲突 + v4 EOL + 长期 fork | 存储不可逆迁移 + 所见即所得退化表单 | 有损映射（非标 HTML 降级进 summary） |
| 退出成本 | 高 | 高 | 低（纯增量端点） |

## 3. 推荐：C 先行，B-lite 可选

UPCV §3 本意是「RR schema 作数据契约 + 自建模板与存储」——它自己也没用上游编辑器，用的是上游 schema。schema 兼容的价值（与 UPCV/rxresu.me 生态互操作）90% 由 C 拿到。

### 分阶段

- **Phase 0（半天）**：以 v4.5.5 tag `libs/schema`（或 v6 `packages/import/src/reactive-resume-v4-json.tsx` 的 V4ResumeData）为权威，落 `docs/rr-schema-mapping.md` 字段映射表 + 夹具。不动代码。
- **Phase 1（约 1 天）**：`rr-export.mjs` —— sectionsOf + entry-head 解析 + deriveResumeFields → resumeData（experience/education/projects/skills/summary items `{id,visible,...,summary:<ul><li>…}`）。端点 `GET /api/export-rr?id=`（下载 *.rxresume.json）。非标结构降级进 summary HTML（不猜不编）；`_meta:{source:'html-derived',docId,exportedAt}`。
- **Phase 2（约 1 天）**：`rr-import.mjs` —— resumeData → template.html 占位符装配（走 structure.mjs buildDoc 路径）；入口首页「导入 Reactive Resume JSON」。
- **Phase 3（可选，约 2 天）**：B-lite sidecar——`<id>.rr.json` 存 RR 投影，/save 时增量重算；`/api/resume` CRUD 契约端点读写投影，正文唯一真源仍是 HTML。
- **不做 A**。重估条件：① 要像素级 RR 模板 PDF 且接受 vendor pdf+Forme WASM 管线（约 1 周独立 worker）；② 决定长期维护 RR fork。

### 风险

- schema 版本拍板：**以 v4 形状输出 + 标 `schemaVersion`**（需求源是 UPCV 契约；v6 官方 v4-importer 可兜底）。
- 映射有损是常态：contenteditable 自由编辑产生非标 DOM，口径「降级进 summary HTML」。
- vendor 纪律：只取 schema 类型定义与默认值，钉 tag，升级走显式 diff 评审。

## 4. 「一比一复刻」可行边界

| UPCV 面 | 形状一致 | 语义对齐 |
|---|---|---|
| /api/resume CRUD 契约 | ✅ 端点名/方法/`{code,data}` 包壳 | 内部 id 体系 |
| resumeData 字段 | ✅ v4 schema 逐字段（含 rhyhorn 等 template 值、page.format/margin/breakLine/pageNumbers、picture.effects） | layout/theme/typography 未用维度给固定缺省 |
| 模板库 | ✅ API 形状 + showcase 种子 | 渲染观感靠新增 themes/*.css 复刻，非复刻实现 |
| 编辑器 | ❌ | 语义对齐：本仓 contenteditable+外壳 vs RR 表单+artboard；data-zid 锚点体系对应 RR item.id/passageId（同构） |
| PDF 管线 | ❌ | 同源口径：编辑所见=导出所得（本仓 freeze 已兑现） |
| AI 四件套 | ✅ 已一比一落地 | 流式升级在途 |

**一句话边界**：数据契约层可字节级一比一；渲染层与编辑器交互层只能语义一比一——除非 vendor RR 的 React 渲染/编辑器，而那会交出「单文件零依赖」立身之本。

## 5. 来源

- github.com/reactive-resume/reactive-resume（README/Tech Stack/packages/import/src/reactive-resume-v4-json.tsx）
- docs.rxresu.me/legal/license · /changelog · /contributing/architecture
- issues #2123（schema 不发 npm）· #2499（v4→v5 迁移公告）
- github.com/danmolitor/forme（Forme 引擎）
- rxresu.me/resume-templates（18 模板名）
- 本仓：extract.mjs:178 sectionsOf、apply-profile.mjs:222 SECTION_TITLES+deriveResumeFields、structure.mjs:6 内部 JSON+buildDoc、dev-docs/2026-10-14-research-findings.md:470-547
