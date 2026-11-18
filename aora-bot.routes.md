# aora-bot 接入契约

> 静态装饰层已于 2026-11-18 按用户决策移除（署名改纯文字）；历史见 git。

## 路由
- GET /aora-bot.js → vendors/aora-bot.js（356KB，@aora-bot/element@0.2.0 vendored 单文件）
- GET /aora-face.js → aora-face.js（状态化身助手，见下）

## element 用法
`<aora-bot character="dot" state="<CharacterState>" size="<px>" face="cute">`，shadow DOM 自绘。
状态全集 44 见 @aora-bot/engine `CHARACTER_STATES`。

## AoraFace 契约（aora-face.js）
- `AoraFace.mount(host, {page, size=96, character='dot', cornerOf}) -> face`
- `AoraFace.set(face, verb)` 动词→状态映射（MAP 为唯一口径）
- `AoraFace.compact(face)` 挪 cornerOf 角位 + size→28
- `AoraFace.show(face, host, sizePx)` 挪回 host + 指定尺寸
动词：init/idle/send/tool/stream/wait-user/done/error；未映射动词静默忽略。
瞬时态（happy/celebrate/alerting/confused）3s 自动回 idle。

## 面板动词接线点（不改协议）
- agent：send→send；工具帧→tool；text-delta→stream；finish→done；catch→error；renderWelcome→show
- interview：生成在途→send；delta→stream；done→done；pending 题→wait-user；err→error
- ai-helper：postJson/postStream 入口→send；delta→stream；done→done；err/409→error
