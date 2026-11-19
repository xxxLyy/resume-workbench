# 2026-11-19 AI 面合并设计（方案 2）：四件套并入 /agent 工具环，/ai-helper 退役

用户拍板（2026-11-19「合并」）：AI 简历助手独立页退役，四件套能力（智能检查/一键优化/润色/定制改写）注册进求职助手工具环，导航 10→9 项。形态对齐 UPCV（无独立四件套页，简历操作由对话触发）。编辑器内嵌 AI（选中 ✨ 改写 + 🤖 对话调整）不动。

## 1. 现状锚点（已核实的 file:line）

| 锚点 | 位置 | 事实 |
|---|---|---|
| 工具环 | agent.mjs:452 TOOL_DEFS | 4 个只读同步工具；runToolTimed :464 有 30s race（注释明言「为未来异步工具预留」） |
| 工具环常量 | agent.mjs:33-36 | TOOL_ROUND_MAX=3 / TOOL_CALL_CAP=4 / TOOL_TIMEOUT_MS=30000 / TOOL_FACT_CLIP=2000 |
| 系统提示 | agent.mjs:475-497 AGENT_SYSTEM | 【可用工具】清单 + 「全部只读」声明 |
| 模型调用 | agent.mjs:775 | streamChatMsgs(R(), msgs, {lease, meta, profile})，ctx 透传 |
| 四件套编排 | ai-helper.mjs:124-149 | smartCheck/improveAll/customRewrite/improveWriting(text,{root,lease,profile})，全部走 llm.mjs chat()，无 lease 时底层 aiPool.acquire 兜底（llm.mjs:153） |
| 环内租约时序 | agent.mjs:730 注释 | 同一 lease 顺序 claim/unclaim 多轮合法；工具执行发生在两轮之间，agent 自身租约此时不占槽 → 工具内部 acquire 不会死锁 |
| /ai-helper 路由 | server.mjs:9403-9537 | 页面 + /docs 下拉 + check/improve-all/rewrite/polish + 2 个 stream 端点 + pipeSSE |
| 导航 | server.mjs:2198 | topnav 10 项，含 `${nav('ai-helper', '/ai-helper', 'AI 助手', 'bot')}` |
| AI 闸门正则 | server.mjs:777 | 含 `/^\/ai-helper\//` |
| server 侧 import | server.mjs:21-22 | 从 ai-helper.mjs import 六函数（退役后仅 agent.mjs 需要） |
| 前端工具卡 | agent-panel.js:155-220 | toolPartHtml 通用渲染：name + state 徽章 + input/output 摘要（toolOutputLines ≤3 行） |
| aora 化身 | /ai-helper 页注入 aora-bot/aora-face（server.mjs:9408-9409） | agent/interview 页同样注入；退役后 aora 面缩为两页，文件保留 |
| 测试钉值 | test-aora.mjs:47/58-60/72-76 | 页清单含 'ai-helper'、页面注入断言、ai-helper-panel.js 接线断言 G 段 |

## 2. 新工具契约（TOOL_DEFS 增四项）

命名前缀 `resume_`，args 白名单走既有 argCheck。四件套函数原样复用（ai-helper.mjs 不改逻辑）。

| 工具 | args | 内部编排 | 回灌给模型（system【工具结果】） | 用户交付（tool part output，面板渲染） |
|---|---|---|---|---|
| resume_check | {docId} 必填 | smartCheck(text) | {ok, docId, title, count, issues 全量（≤20 条）}，per-tool factClip=4000 | issues 红黄清单（error/warning 两色行） |
| resume_improve | {docId} 必填 | 先 smartCheck 得 issues，再 improveAll(text, issues) 一呼完成「检查+修复」 | {ok, docId, title, chars, issuesFixed, preview:前 300 字} | rewritten 全文卡：pre 块 + 复制按钮 |
| resume_polish | {docId} 必填 | improveWriting(text) | 同上压缩形状 | 同上全文卡 |
| resume_tailor | {docId, requirement} 均必填 | customRewrite(text, requirement) | 同上压缩形状（附 requirement 回显 ≤80 字） | 同上全文卡 |

公共约定：

1. text 来源 = `docToLines(readDoc(docId), { includeHidden: false }).join('\n')`（agent.mjs 已有同款用法，:444）。文档不存在回 `NOT_FOUND`（同 get_resume_summary 口径）。
2. 超时（2026-11-19 真模型抽验修正）：工具竞速 per-tool `timeoutMs: 600000`，底层 LLM 调用 per-call `timeoutMs: 540000`（RESUME_LLM_TIMEOUT_MS，经 llm.mjs 新增的 per-call 覆盖，优先级 per-call > profile > 120s 默认）——首版 240s 假设被抽验证伪：active 档未配 timeoutMs 时 120s 默认先掐底层请求，竞速形同虚设。现底层永远先于竞速结束。默认 30s 只读工具不变。runToolTimed 读 `def.timeoutMs ?? TOOL_TIMEOUT_MS`。
3. runTool 签名扩为 `run(args, ctx)`，ctx={root, lease, profile} 由 chatStream 轮内透传（沿用 agent 自身 ctx.profile，工具与对话同档案）；chat() 抛错（槽忙/网络/超时）→ 现有 catch 归 toolErr('ERROR', 中文错)。
4. **回灌与交付分离（本设计核心）**：改写全文只进 tool part output（面板渲染 + 会话落盘），system 回灌只给压缩摘要——全文不过模型第二道手，零漂移零重复计费。resume_check 的 issues 是模型要转述的内容，走 4000 clip 回灌全量。
5. requirement ≤200 字：ai-helper.mjs REQ_MAX=200 是 UPCV 页面原契约（buildCustomRewrite 内部 clip），不改。工具描述里明写「把 JD 关键要求浓缩成 ≤200 字」——模型自己会从【工具结果】/对话里拿 JD 摘要。
6. AGENT_SYSTEM 【可用工具】增四行：何时用（用户说「检查/体检」→resume_check；「一键优化/修一下」→resume_improve；「润色」→resume_polish；「按 JD 定制/针对性改写」→resume_tailor，requirement 填浓缩 JD）；并声明四件套输出不自动写回文档，指导用户复制全文到编辑器应用（保持工具环「只读」承诺成立——只读指零落盘，文本变换不算写）。
7. 策略区补一条：改写结果必须原样转告「全文见上方工具卡」，不得在 reply 里复述全文或再加工。

## 3. 面板渲染增量（agent-panel.js）

toolOutputLines/toolPartHtml 加一个分支：output 带 `rewritten` → 渲染 pre 全文（esc 全程）+ 「复制全文」按钮（navigator.clipboard，兜底 textarea 选中）；output 带 `issues` → 逐条红/黄行（type=error 红、warning 黄）。既有 cardPart/cardsOfMsg 通道不动，历史消息自动兼容。

## 4. /ai-helper 退役切口清单（server.mjs）

1. :2198 导航行删 `${nav('ai-helper', …)}`（10→9 项）。
2. :9403-9537 整块删除（页面 + /docs + 4 POST + 2 stream + pipeSSE 本体——pipeSSE 只被这两个 stream 端点使用，确认无其他调用方后一起删）。
3. :4847-4848 `/ai-helper-panel.js` 静态服务端点删除。
4. :21-22 import 清理：ai-helper 六函数 import 移除，注释同步（ai-helper.mjs 改由 agent.mjs import）。
5. :777 AI 闸门正则删 `/^\/ai-helper\//` 分支。
6. :9620 注释里「错误口径同 ai-helper」改「错误口径同 /ai/*」。
7. 文件系统：ai-helper-panel.js 删除；ai-helper.mjs 保留（agent.mjs 的库），文件头注释加一行退役说明。

## 5. 规范文档同步

- ai-helper.routes.md：文件头加退役注记（2026-11-19 起四件套经 agent 工具环提供，契约正文保留作历史参考）。
- agent.routes.md：工具清单增四项（对齐 AGENT_SYSTEM 新文案），注明 timeoutMs/回灌摘要/交付卡三口径。
- README/DESIGN.md 如有 /ai-helper 或导航 10 项表述，grep 后同步（实施时确认清单，逐处列出）。

## 6. 测试（断言与实现同提交）

1. test-aora.mjs：:47 页清单删 'ai-helper'；:58-60 ai-helper 页断言删；:72-76 G 段（ai-helper-panel 接线）删。其余 agent/interview 断言不动。
2. 工具环测试（新）：查现有 agent 测试文件（test-agent*.mjs 或结构夹具里 agent 段）——有则扩展，无则新建 `test-fixtures/reliability/test-agent-resume-tools.mjs` 并登记进 test-structure.sh。隔离 RESUME_ROOT + 桩 LLM（复用 test-gen-*.mjs 的假 llmFn 注入套路）覆盖：
   - 四工具 BAD_ARGS（缺 docId / requirement 空 / 未知字段）；
   - NOT_FOUND（假 docId）；
   - resume_check 桩回 issues 形状（≤20 条、type 归一）；
   - resume_improve/polish/tailor 桩回 rewritten → 断言回灌摘要形状（chars/preview）与 part output 全文分离；
   - AGENT_SYSTEM 文案含四个新工具名（源级钉值，同 upcv-port 系列 fixture 风格）；
   - 超时路径：stub 一个永不 resolve 的 chat + timeoutMs=100 的临时 def，断言 TIMEOUT toolErr（不依赖真模型）。
3. 全量：`bash test-structure.sh` 必须 EXIT=0。

## 7. 明确不做（YAGNI）

- 不自动写回文档（改写结果只交付到对话卡，编辑器仍是应用面；自动落母版无预览不可逆，风险大）。
- 不加 SSE 心跳（工具执行期间静默，卡片 state 徽章已有「执行中」语义；本地直连无代理超时）。
- 不动 REQ_MAX=200、不动 aora-bot/aora-face、不动编辑器 ai-panel、不做工具流式输出。
- 不动四件套 prompt 与 NO_FABRICATE（零漂移复用）。

## 8. 纪律红线

真实数据禁写禁删（测试一律隔离 RESUME_ROOT）；frozen 文件不碰；esc 全程；断言与实现同提交；git commit 不用 --no-verify；不重启/不杀 7766（launchd 管护，验证由主会话 kickstart）；GateGuard 首改拒绝 → 陈述事实重试即过；ponytail 最短 diff。

## 9. 验收（主会话独立复验）

`bash test-structure.sh` EXIT=0；test-aora 六步过；kickstart 后 curl：/agent 200 且导航 9 项、/ai-helper 404、/ai-helper/check 404；grep 锚点四工具名在 TOOL_DEFS/AGENT_SYSTEM；真会话抽验一次 resume_check（真模型，主会话执行）。
