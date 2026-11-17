# 简历工作台 — Design System（UP简历方向）

## Direction

参考 UP简历（upcv.tech）的产品化语言：**高饱和亮蓝 + 浅灰底 + 大圆角白卡**，
友好但专业的求职工具感，比开发者工具更明亮、更有人味。
布局上突出「Agent 帮你干活」的叙事：任务输入 → 运行状态 → 结果卡片流。

- colorMode: LIGHT
- roundness: 12–16px（卡片大圆角），按钮/标签 8–10px
- 平台: Web，Desktop-first，内容区最大宽 1200px

## Color

- primary: #1E4AFF（UP 同款亮蓝，主按钮/选中态/分节标题/关键词高亮）
- on-primary: #FFFFFF
- primary-container: #E8EEFF（选中底、徽标底、关键词高亮底）
- background: #F5F6F8（浅灰工作区底）
- surface / card: #FFFFFF（内容卡全用大圆角白卡）
- surface-container-low: #F0F2F5（表头底、分组底）
- on-surface: #1F2329
- on-surface-variant / muted: #6B7280
- outline: #E5E7EB（1px 边线）
- success: #16A34A / success-container: #E7F6EC（已定制、已投递、通过）
- warning: #D97706 / warning-container: #FEF3E2（待评估、待跟进）
- danger: #DC2626 / danger-container: #FDECEC（冲突、失败）
- info: #2563EB / info-container: #E8EEFF（进行中、解析中）

简历文档预览内的分节标题（教育经历/实习经历/项目经历）用 primary 蓝色；
正文内被 AI 高亮的关键词用 primary-container 底 + primary 字。

## Typography

- font: IBM PLEX SANS（拉丁，UP 同款）；中文回退 PingFang SC
- label font: IBM PLEX SANS，加粗即用于数字与状态（不用等宽字体，更亲切）
- 字号：页面大标题 22–24、卡标题 15–16、正文 14、说明 12–13
- 行高：正文 1.7（简历文档可读性优先）

## Spacing & Layout

- spacing: 4 / 8 / 12 / 16 / 20 / 24 / 32
- 卡 padding 20–24px；列表行高 56–64px（比工具版更松）
- 分栏模式：左侧 240px 导航/任务栏 + 右侧内容区（UP 的 dashboard 骨架）
- 简历文档卡：A4 比例白卡 + 细边线，分节标题蓝色
- 岗位/JD 卡：左侧公司 logo 圆角方块 + 公司·岗位 + 状态 chips

## Components

- 按钮：primary 亮蓝实心 10px 圆角；secondary 白底描边；文字按钮用 primary 色
- 导航：左侧栏深色字 + 选中项 primary-container 圆角底（整页左栏，非顶部）
- 标签/徽章：container 底圆角 999px 胶囊形
- 进度条：8px 粗圆角轨道，填充 primary 蓝
- Agent 状态卡：左侧蓝色渐变图标块 + 「运行中/已完成」状态
- 空状态：图标 + 一句人话指令 + 亮蓝主按钮
