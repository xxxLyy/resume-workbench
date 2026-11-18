# Aora Bot 接入简历工作台 · 设计定稿

> 2026-11-18。状态：用户已逐节确认，待 spec 审阅后进入 writing-plans。
> 上游：github.com/sam70361/aora-bot（@aora-bot/* 0.2.0，自定义分级许可）。

## 1. 目标与范围

把 aora-bot 程序化角色接入工作台，两种定位共存：

- **状态化身**：跟随前端已知事件变表情（有动画），覆盖 `/agent`、`/interview`、`/ai-helper` 三页。
- **装饰角色**：静态、不跟状态，落在空态与署名位（零运行时 JS）。

**不做**：简历正文/PDF 内放角色、React 包、头像 API（大陆不可用且违 render-safe 外联纪律）、语音、错误页装饰（记二期可选项）。

## 2. 已验证事实（动手前钉死）

| 事实 | 证据 |
|---|---|
| `dist/aora-bot.js` = 356KB 单文件自包含构建（引擎已内） | npm pack @aora-bot/element@0.2.0 实测 |
| element 属性：`character`/`state`/`size`/`style-id`/`face`/`style-options`；shadow DOM，页 CSS 够不着 | dist/element.d.ts |
| 状态全集 44 个，含 agent 向词汇 | engine dist/motion/states.d.ts `CHARACTER_STATES` |
| 页面 CSP `script-src 'self'`（+可选 nonce）；本地路由脚本免 nonce | server.mjs:4725-4727 |
| 三面板事件点齐备（SSE 帧/wait 类/catch/finally），状态映射纯客户端可完成，**后端逻辑零改动** | agent-panel.js:398-503 / interview-panel.js:99-137 / ai-helper-panel.js:98-149 |
| `ROUTES_FROZEN` 字面表在 test-structure.sh，新路由先登记再动 | test-structure.sh:2212-2231 |
| 空态锚点：会话列表 `.ag-empty-side`、看板「（空）」~server.mjs:7306、「暂无投递」~:7201、复盘空 ~:8483/:8521、练习空 ~:8552 | grep 实测 |

## 3. 用户已拍板决策

| 决策点 | 选项 | 结果 |
|---|---|---|
| 角色定位 | 状态化身 / 纯装饰 / 两者 | **两者都要** |
| 状态化身覆盖面 | agent / +interview / 三页 | **三页全上** |
| 化身落点 | A顶栏/B欢迎块/C浮伴/D输入旁 | **B：hello 块 96px → 活动后缩 28px 钉角落** |
| 装饰落点 | A空态/B署名位/C首页横幅/D错误页 | **A+B**（C 否决：违 hero 退役决策；D 记二期可选） |
| 接入形态 | A混合/B全element/C全静态 | **A 混合** |

## 4. 架构

```
┌─ 运行时（3 个 AI 页）────────────────────────┐
│ vendors/aora-bot.js  356KB vendored 单文件   │← GET /aora-bot.js  [登记]
│ aora-face.js         ~80 行状态助手          │← GET /aora-face.js [登记]
│ 三面板在既有事件点调 AoraFace.set(verb)       │
└───────────────────────────────────────────────┘
┌─ 构建期 ─────────────────────────────────────┐
│ scripts/gen-aora-assets.mjs                  │
│   @aora-bot/engine(devDep) /static → SVG     │
│   → assets/aora/{happy,confused,sleeping}.svg│
└───────────────────────────────────────────────┘
┌─ 服务端（装饰渲染）───────────────────────────┐
│ aora.mjs：svgAsset 式读入 + aoraEmpty(文案)   │
│   + aoraFoot() 署名卡                         │
└───────────────────────────────────────────────┘
```

### 4.1 新增/改动清单

**新增**

- `vendors/aora-bot.js` — vendored `dist/aora-bot.js`（入库跟踪；随 `vendors/` 惯例，零 npm 运行时依赖）。
- `aora-face.js` — 客户端助手：`AoraFace.mount(host, opts)`、`AoraFace.set(verb)`、96↔28 缩放。语义动词 → 状态名的唯一映射表在此。
- `aora.mjs` — 服务端：`aoraSvg(name)`（仿 svgAsset 读 `assets/aora/`）、`aoraEmpty(text)`（SVG+文案空态块）、`aoraFoot()`（署名卡 HTML）。
- `scripts/gen-aora-assets.mjs` — dev 脚本，`engine/static` 渲三张 48px SVG。
- `aora-bot.routes.md` — 契约文档：路由、element 属性、动词映射表、注入点。
- `test-aora.mjs` — 见 §7。
- `dev-docs/2026-11-18-aora-bot-integration-design.md` — 本文件。

**改动（主控接线，server.mjs）**

- 路由 2 条：`GET /aora-bot.js`→`vendors/aora-bot.js`、`GET /aora-face.js`→`aora-face.js`，`application/javascript; charset=utf-8`（同 :4806 `/zone-panel.js` 先例）。
- script 注入 3 处：/agent 骨架（:2193）、/ai-helper（:9344）、/interview（:9568），各加两行 `<script src="..." defer>`。
- 空态 5 处换 `aoraEmpty()`：会话列表空、看板「（空）」、「暂无投递」行、复盘空、练习空。
- `/settings` 页尾插 `aoraFoot()`：SVG + `Powered by Aora Bot` + 仓库链接。

**改动（三面板 JS）**：仅在既有事件点插 `AoraFace.set(...)` 调用与化身 DOM 挂载，不改协议。

**登记**：`test-structure.sh` ROUTES_FROZEN += 上述两路由字面量。

**依赖**：`package.json` 仅加 devDependency `@aora-bot/engine`（构建期渲 SVG 用）。运行时零新 dep。

## 5. 状态化身细则

### 5.1 落点与尺寸

- 初始/空会话：96px，agent 页放 `.ag-hello` 块内；interview/ai-helper 放页头。
- 会话激活后：缩 28px 钉位——agent 钉 `.ag-main` 右上，interview/ai-helper 钉页头。同一 `AoraFace` 实例管两态（实现上移动同一 `<aora-bot>` 节点或双元素共享状态，由 aora-face 内部封装，面板无感）。
- 默认造型：`character="dot"`（球球）、`face="cute"`、`style-id` 默认 vector/solid。均为单属性可换。

### 5.2 动词 → 状态映射表（aora-face.js 唯一口径）

| 动词（面板调用） | agent | interview | ai-helper |
|---|---|---|---|
| `init`（页载/无会话） | `curious` | `idle` | `idle` |
| `idle` | `idle` | `idle` | `idle` |
| `send`（请求在途） | `thinking` | `thinking` | `working` |
| `tool`（工具调用中） | `searching` | — | — |
| `stream`（流式输出） | `writing` | `writing` | `writing` |
| `wait-user`（等作答） | — | `listening` | — |
| `done` | `happy`→3s 后 `idle` | `celebrate`→3s 后 `idle` | `happy`→3s 后 `idle` |
| `error` | `alerting` | `alerting` | `confused` |

- 状态名全部 ∈ `CHARACTER_STATES` 44 全集（engine 0.2.0 实测）。
- 面板只调动词不调状态名；映射表改一处全生效。
- `happy`/`celebrate`/`alerting`/`confused` 为瞬时态：展示 ~3s 自动回 `idle`（aora-face 内置 timer）。

### 5.3 事件点对照（不改协议）

- **agent**：发送→`send`；工具卡 `'call'`/`'input-streaming'`→`tool`；首个 `text-delta`→`stream`；`finish` 帧→`done`；catch→`error`；无选中会话→`init`。
- **interview**：取题/生成 hint/report 在途→`send`；题已出等作答→`wait-user`；delta 流→`stream`；done 帧→`done`；error 帧/catch→`error`。
- **ai-helper**：check/improve/rewrite/polish 发出→`send`；delta→`stream`；done→`done`；`error` 帧/409/catch→`error`。

## 6. 装饰角色细则

- `scripts/gen-aora-assets.mjs` 渲染三张：`happy`（空态默认）、`confused`（二期错误页备）、`sleeping`（列表空态备选），48px，落 `assets/aora/` 入库。
- `aora.mjs` 三个导出：`aoraSvg(name)`、`aoraEmpty(text)`、`aoraFoot()`。
- 空态统一形态：SVG 居左 + 文案居右，颜色/字号沿用各处现有 `--mut` 语义，不引入新 token。
- 署名卡（/settings 页尾）：`happy` SVG + 文案「角色形象 Powered by [Aora Bot](仓库链接)」。满足许可的公开发布署名义务（个人项目本就在免费档，此卡同时是合规保险）。

## 7. 测试与验收

- `test-aora.mjs`：两路由 GET 200 + `application/javascript`；`aoraEmpty` 输出含 `<svg` 与文案；映射表动词覆盖三页、状态名 ∈ 44 全集（从 engine 导入读真表比对）。
- `test-structure.sh`：ROUTES_FROZEN 登记后 `missing`/`extra` 断言归零；导航 7 项不动。
- `bash test.sh`、`privacy-check.sh` 全绿；无外链资源、无 `sk-` 类字面量引入。
- playwright 截图（仓内跑以解析 node_modules）：三页角色实渲染 + agent 页一次 send→stream→done 状态切换。

## 8. 许可

- 个人项目免费档（含商用）。公开发布时署名义务已由 §6 署名卡满足。
- 禁止项（转售引擎/角色托管服务/贴纸商品/训练生成模型）本场景均不触碰。
- vendored `aora-bot.js` 与生成 SVG 均为衍生素材，入库不违许可；许可证文本随 vendors 文件注释注明来源版本。

## 9. 二期可选（本期不做）

- 错误/失败页 `aoraEmpty` 变体（`confused` 脸）——素材已备，仅差落点接线。
- 其余 69 个角色/7 主题包按需扩展；`character`/`style-id` 做成单属性即可换。
