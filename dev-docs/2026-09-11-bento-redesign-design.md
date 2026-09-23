# S5 Bento 网站化 + 🟢 四项打包 · 设计 Spec（2026-09-11）

> 状态：设计已获用户逐节确认 ｜ 前置：dev-docs/2026-09-10-optimization-audit.md（S1-S4 总账）
> 范围：平台五页（列表/设置/历史/对比/看板）+ AI 面板换肤 + 四个小项 ｜ **简历文档模板保持经典不动**

## 0. 背景与决策

用户反馈："页面太空、没利用完整页面、不太美观、要像真正的网站"。经澄清：
- 方向 = **布局骨架**（导航栏+页脚+满宽），不做组件动效精修、不做完整仪表盘
- 风格 = **新粗野退役**，换 **C · Bento 仪表盘风**（灰底 #f5f5f4、白卡圆角 12px 微阴影、黑主按钮、彩卡色系）
- 调研结论：recent.design 仅为灵感画廊（无可复制组件代码）；组件/配色依据 ui-ux-pro-max 数据库
- 打包 🟢 四项：渲染重试 / 降级文档重新结构化 / PORT NaN flaky 加固 / 新建空白文档

## 1. 布局骨架（page() 壳升级）

- 顶栏 nav：左 `📄 简历工作台`（链首页）；右：文档 / 📋 投递看板 / ⚙️ 设置（当前页高亮）；白底细灰下边线
- 页脚：细灰字一行（简历平台 · 本地优先）
- 内容区 max-width 760px → **1100px**
- 生效面：列表/设置/历史/对比/看板五页（共用 page() 壳）；**编辑器不套 nav**（保留自身工具栏）
- ai-panel.js 面板同步换肤（白卡圆角微阴影；保留 ✕ 24px、防连点、jdfrom 桥、读取链接等全部既有功能）

## 2. 列表页 Bento 化

- tokens：bg `#f5f5f4`、卡片 `#fff` + `border-radius:12px` + 微阴影、主按钮 `#111`、彩卡 `#ede9fe/#dbeafe/#dcfce7/#fef3c7`
- 统计小卡行：📄 文档数 / 📋 投递中（applications.json 里非终态=已投递/笔试/面试中 的计数）/ 🤖 AI 状态（active profile 名）/ 📑 PDF 就绪数（pdfs/ 有对应文件的文档数）——全部读现有数据，零新管线
- 文档大卡区：grid 自适应 2-3 列；标签分组保留（组标题换细线风）；每卡操作：编辑/PDF/历史/对比/🏷/复制/删除
- 「＋ 新建」卡（见 §3-D）

## 3. 🟢 四项

| 项 | 方案 |
|---|---|
| B 渲染重试 | server.mjs `render()` 内 spawn 非零退出自动重试 1 次；test.sh 假渲染注入验证 |
| C 重新结构化 | 检测标记=文档含"以下为 PDF 提取的原文"（importer 自带）；`POST /restructure?id=`：读原文区 → structureText → 成功则快照后覆盖+渲染，失败原样保留；卡片显示 🔁 按钮（仅降级文档） |
| PORT flaky | test.sh 的 sleep 0.5 改轮询（200ms×15 查日志） |
| D 新建文档 | `POST /new`：template.html 占位符填空骨架（NAME="未命名"等）→ 生成 docId（`doc`/`doc-N` 顺延，复用 slugify 语义）→ 303 跳编辑器；列表页「＋ 新建」卡 |

## 4. 错误处理与回退

- /restructure：无 LLM 配置 → 409；非降级文档 → 400；结构化失败 → 原样保留 + 明确提示；成功必先快照
- /new：id 撞名顺延（doc-N），不覆盖既有文档
- render 重试仅 1 次，仍败则走现有 `{pdf:false}` 路径（日志可查）
- **回退**：改前 `cp server.mjs /tmp/server.mjs.bento-backup` + ai-panel.js 同款（无 git 环境的手工保险）；简历文档零改动

## 5. 测试

- test.sh：page() 壳断言更新（nav/页脚）；统计卡存在；B/C/D 各断言（render 假失败注入、restructure 409+假成功、NaN 轮询、/new 建文档）；applications.json 等三文件 stash 模式不变
- test-structure.sh：无需新纯函数（diffLines/parseReport 不动）
- hao 视觉回归：bento 落地、1100px 满宽、375px 不炸、编辑器/抽屉无回归、看板列在新壳下正常

## 6. 分工与顺序

1. **xiang**：改前备份（server.mjs/ai-panel.js → /tmp）→ 然后**只做 ai-panel.js 换肤**（与 ling 文件无交集）
2. **ling**：server.mjs 全包——page() 壳 + 列表页 bento 重构 + 🟢B（render 重试）+ 🟢C（/restructure）+ 🟢D（/new）+ 🟢flaky + test.sh 全量红绿（TDD）——单一所有者避免并行改同文件
3. **xiang**：审查 + 三套件 + 重启
4. **hao**：视觉回归 + 功能快路径
5. **xiang**：用户目检 + 审计文档更新

## 7. 明确不做（YAGNI）

- 组件动效精修/骨架屏（用户未选）
- 完整仪表盘（最近活动流、简历缩略图预览等）
- 编辑器套全局 nav
- 简历文档模板任何改动
- 暗色模式
