# S1 新粗野主义 UI 升级 · 设计 Spec（2026-09-10）

> 状态：设计已获用户逐节确认 ｜ 实施分工：xiang（总）+ ling + hao
> 范围：平台界面 + 简历文档模板 ｜ 风格：Neubrutalism（平台 D 款 + 简历 3 款，用户已知晓 ATS/HR 风险并拍板）

---

## 1. 背景与目标

用户认为平台"太简单、元素太少"。本子项目（S1）只做**视觉升级**，不碰功能逻辑。后续排队：S2 内容竞争力、S3 多版本管理、S4 求职流程（各自独立 spec）。

**风格决策**（可视化伴侣点选）：
- 平台界面：D · 新粗野主义（粗黑边框 + 硬阴影 + 撞色）
- 简历文档：3 · 新粗野同款（撞色姓名横幅 + 章节色块标签 + 条目卡片化）

**成功标准**：三套件全绿 + ATS 文本层断言通过 + hao 视觉回归通过 + 用户浏览器目检满意。

## 2. Design Tokens

```
--ink:#111  --paper:#fdf6e3  --accent-1:#7c3aed(紫)  --accent-2:#ffe566(黄)  --accent-3:#0ea5e9(蓝)
--border:3px solid var(--ink)  --shadow:4px 4px 0 var(--ink)  --shadow-sm:2px 2px 0 var(--ink)
```

平台页与简历文档各自内嵌一份（简历文档自包含，PDF 打印无外部依赖）。依据：`~/.claude/skills/ui-ux-pro-max/data/styles.csv` #38 Neubrutalism。

## 3. 组件单元（5 个，职责单一）

| # | 单元 | 职责 | 改动文件 | 执行者 |
|---|---|---|---|---|
| U1 | 平台页样式重写 | 列表/设置/历史三页 brutal 化 + 加元素：文档卡片（快照数/PDF 状态徽标/操作组）、工作台头部（文档数 + AI 状态徽标）、CSS 空状态块 | server.mjs 内嵌 HTML | ling |
| U2 | 简历模板 brutal 版 | 撞色姓名横幅、章节标题色块标签、条目卡片化、硬阴影分隔 | template.html | xiang |
| U3 | AI 面板 brutal 化 + 旧文档补丁 | 面板/抽屉/按钮随主题；旧文档编辑器 chrome 覆盖补丁更新（沿用已验证的 serve 注入双通道） | ai-panel.js | xiang |
| U4 | 迁移脚本 | 现有文档 `<style>` 块整体替换；`/*BRUTAL-V1*/` 标记使迁移幂等 | 新增 migrate-style.mjs（一次性） | ling |
| U5 | ATS/打印验证 | 渲染后 pdftotext 提取非空 + 姓名在文本层 | test-render.sh 加断言 | ling |

## 4. 数据流 / 交付通道

```
新文档：导入/新建 → template.html（原生 brutal）
旧文档：migrate-style.mjs → 平台同款快照 → 替换 <style> 块（正文零改动）
        → 已含 BRUTAL-V1 标记则跳过（幂等）
编辑器 chrome（旧文档）：serve 时 ai-panel.js 注入补丁覆盖（/save 剥离，现有幂等机制不变）
PDF：printBackground:true 保留色块；@media print 去硬阴影防伪墨盒
```

## 5. 错误处理与回退

| 风险 | 对策 |
|---|---|
| 迁移改坏文档 | 先快照（snapshots/{id}/{ts}.html）再替换；`<style>` 正则不匹配 → 跳过并报告，绝不硬改 |
| 迁移跑两次 | BRUTAL-V1 标记检测，第二次全量 no-op |
| ATS 解析失败 | 渲染后 pdftotext：文本非空 + 姓名/章节关键词存在（硬断言）；内容均为真文本，色块仅背景 |
| 打印爆版/费墨 | @media print 去硬阴影、色块限小面积（姓名横幅+章节标题）；hao 打印版式截图回归 |
| 想回退 | 平台回滚 UI 退到快照；旧 template.html 保留不删 |

## 6. 测试

- test.sh（ling）：列表页断言新元素存在（文档卡片 class、AI 状态徽标）；设置/历史页路由 200 不回归；断言纪律 `... || { echo '❌'; exit 1; }`
- test-render.sh（ling）：+2 条 ATS 断言（pdftotext 非空、含姓名）
- test-structure.sh：不动（与样式无关）
- 迁移幂等（ling）：跑两次，第二次输出全部跳过
- hao 视觉回归：brutal 落地截图（列表/编辑器/抽屉/简历 A4 屏幕版+打印版）、375px 无新增横滚、console 零报错
- 全程纪律：ponytail 最简、禁 git 操作、不读不打印 config.json、测试改动先红后绿

## 7. 实施顺序与分工

1. **xiang**：U2 template.html + U3 ai-panel.js（设计先行，定义 tokens 供 ling 对齐）
2. **ling**：U1 server.mjs（先写 test.sh 红断言）→ U4 迁移脚本（幂等）→ U5 ATS 断言
3. **xiang**：跑迁移（先 linghaoxiang 外文档验证，再全量）→ 三套件串行回归
4. **hao**：浏览器视觉回归 + 打印版式验证 + 截图证据
5. **xiang**：用户目检 → 审计文档更新

依赖：ling 的 U1 需等 xiang 的 tokens 定义（§2 已冻结，可并行开工）。

## 8. 明确不做（YAGNI）

- 多模板切换 UI（旧 template 仅保留文件，S-未来再说）
- 暗色模式
- 平台页功能逻辑变更（纯视觉）
- 简历正文文字任何改动
