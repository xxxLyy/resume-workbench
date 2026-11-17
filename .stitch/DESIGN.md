# 简历工作台 — Design System

## Direction

冷静的「专业工具台」：浅色纸感底、克制的深靛蓝主色、密排信息、中文优先排版。
参考气质：Linear / Notion 的工具感，而非营销页。界面里大量是表格、列表、
状态标签与审阅队列——密度和可读性优先于留白。

- colorMode: LIGHT
- roundness: ROUND_FOUR（约 8–10px，工具感，不圆润）
- 平台: Web，Desktop-first（内容按 ≥1280px 设计，侧栏面板固定宽度）

## Color

- background: #FAF9F7（暖白纸感，区别于纯白后台）
- surface / card: #FFFFFF
- surface-container-low: #F4F2EE（分组底、表头底）
- primary: #2B4EC9（深靛蓝，主按钮、选中态、链接强调）
- on-primary: #FFFFFF
- primary-container: #E4EAFB（选中底、聚焦底）
- text / on-surface: #1C1B1A
- on-surface-variant / muted: #6F6B66（次要文字、说明文字）
- outline / border: #E3E1DC（1px 分隔线，不用投影堆层次）
- outline-variant: #EFEDE9
- success: #0F7B4D / success-container: #E3F4EA（接受、已建稿、已完成）
- warning: #9A5B07 / warning-container: #FBF0DC（待评估、超时、待跟进）
- danger: #B42318 / danger-container: #FBE9E7（冲突、失败、删除）
- info: #475467 / info-container: #EDF0F4（进行中、草稿态）

状态颜色只用于小面积：徽章、标签、进度条、左侧 3px 状态条。
大面积背景保持 paper/surface，不铺彩色块。

## Typography

- headline / body font: GEIST（拉丁）；中文回退 PingFang SC / 系统无衬线
- label / numeric font: JETBRAINS_MONO（评分、计数、时间戳、状态码）
- 字号阶梯：display 32 / headline 22 / title 16 / body 14 / caption 12
- 行高：body 1.6，caption 1.4；标题字距 -0.01em
- 数字与评分一律 tabular-nums 等宽呈现，便于纵向对比

## Spacing & Layout

- spacing scale: 4 / 8 / 12 / 16 / 24 / 32
- 页面最大宽 1200px，两侧 24px 边距；密集列表行高 40–48px
- 卡片 padding 16–20px；区块间距 24px；面板内分组间距 12px
- 层次靠「底色阶 + 1px 分隔线」，不用厚重投影；hover 仅底色加深

## Components

- 按钮：primary 深靛蓝实心；secondary 白底描边；danger 仅文字/描边；
  高度 36px，圆角 8px；禁用态降透明度不改色
- 输入：白底 1px outline，聚焦时 outline→primary 2px；高度 36–40px
- 标签/徽章：container 底色 + 同色文字，圆角 6px，JetBrains Mono 小号
- 表格：表头 surface-container-low，行底 hover 变化，行分隔用 outline-variant
- 侧栏面板：固定在右侧 320–360px，顶部 tab 下划线指示选中
- 进度：细轨道（4px）+ 真实阶段文字，不用假百分比
- 空状态：居中插图位 + 一句指令 + 一个主按钮，不堆营销文案
