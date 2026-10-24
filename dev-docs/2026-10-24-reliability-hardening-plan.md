# 可信度与可靠性加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保护真实简历和冻结件的前提下，完成已批准六个工作包，使正文应用、任务状态、证据来源、资源容量与交付验证可信。

**Architecture:** 采用按风险分批的定向加固，复用既有保存事务、正文提取、任务和撤销机制。六个子计划各自形成可验收切片；共享服务端和测试文件由唯一 owner 顺序集成，独立模块与脱敏夹具可以并行准备。

**Tech Stack:** Node ESM、vanilla JS、playwright-core 1.60.0、现有 Bash/Node/浏览器/渲染/隐私套件；零新增 npm 依赖、零构建。

---

## 0. 使用本计划

用户已于 2026-10-24 确认书面设计。批准设计：[2026-10-24-reliability-hardening-design.md](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md)，原提交 `847e406`；实现基线 `627c2a8b81c2be333f0eaa493ee54da15ac63833`。

本次交付只有设计与计划，**代码、测试和真实服务尚未实施**。以下命令、代码片段、提交指令均由后续实施 agent 执行，不能当作已经通过的验证记录。用户会另行安排实施 agent，本会话不自动转入执行。

`docs/` 是真实简历目录，所以计划沿用 `dev-docs/`。六包涉及不同子系统，拆为独立计划；先读本入口、对应设计章节和本包，再按依赖执行，不要求每名 agent 把所有代码示例同时装入上下文。

### 工作包入口

| 顺序/包 | 子计划 | 交付内容 |
|---|---|---|
| 先行：验证基础 | [validation-plan](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-validation-plan.md) | 失败优先、严格模式、端口/PID/日志隔离 |
| 第一批：正文安全 | [zone-plan](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-zone-plan.md) | 生成基线、zoneOps事务安全子集、请求身份、回执合并 |
| 第一批：任务状态 | [tasks-plan](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-tasks-plan.md) | 明确成功/拒绝，保留旧结果，迟到任务零落账 |
| 第二批：来源可信 | [sources-plan](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-sources-plan.md) | 真源集合、引用校验、旧结果读时降级、评估语义 |
| 第三批：资源边界 | [resources-plan](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-resources-plan.md) | 共享容量、实际生命周期、POST单次调用 |
| 收尾：兼容交付 | [delivery-plan](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-delivery-plan.md) | 历史脚本实际保存、严格四套件、发布与文档 |

## 1. 文件地图与唯一 owner

下表是责任合同。允许一个 agent 兼任多个角色；禁止多人同时编辑同一个共享文件。普通路径均以 `/Users/xxxly/resume/` 为根，子计划给出绝对路径。

| 文件 | 变更 | 唯一编辑 owner |
|---|---|---|
| `server.mjs` | `/save`、区域/元数据端点、完成出口、来源/评估、资源准入 | 服务端集成 owner |
| `zone.mjs` | 增加局部 zone-v1 范围适配，不改变旧提取语义 | 区域 owner |
| `zone-ops.mjs` | 新增纯安全子集计算与纯文本替换 | 区域 owner |
| `zone-panel.js`、`editor-shell.js` | 基线/epoch/保存回执/局部合并；共享序列化 | 区域 owner |
| `gen-result.mjs` | 新增纯完成结果计算 | 任务 owner |
| `evidence.mjs`、`eval.mjs` | 真源、解析、响应视图 | 来源 owner |
| `job-panel.js` | 来源标签/引用/回跳；共享序列化接线由区域 owner 提供小补丁，来源 owner 统一合入 | 来源 owner |
| `resource-slots.mjs`、`llm.mjs` | 唯一共享池和底层调用边界 | 资源 owner |
| `test.sh`、`test-structure.sh`、`test-editor.mjs` | 各包共享回归及严格验收 | 验证 owner |
| `test-fixtures/reliability/test-zone-ops.mjs` | 区域纯函数反例 | 区域 owner |
| `test-fixtures/reliability/test-gen-result.mjs` | 完成结果反例 | 任务 owner |
| `test-fixtures/reliability/test-sources.mjs` | 来源/评估纯函数反例 | 来源 owner |
| `test-fixtures/reliability/test-resources.mjs` | 资源纯函数、本地桩、受控进程反例 | 资源 owner |
| `test-fixtures/reliability/test-harness.mjs`、历史脱敏夹具 | 验证基础与兼容验证 | 验证 owner |
| `README.md`、`dev-docs/handoff.md`、路线图 | 最后回写实际交付事实 | 文档 owner |

`template.html`、`themes/`、`render.mjs` 全程不改。`tx.mjs` 沿用公开锁/事务 API，本轮不重写锁基础设施。若现有接口无法满足方案，先给出具体反例和最小修订，不静默扩展至整体重构。

## 2. 必须一致的跨包接口

| 接口 | 固定合同 | 定义位置 |
|---|---|---|
| zone-v1 | `operationId,zid,baselineVersion,before,beforeHash,zone,candidate`；before为局部规范文本，hash=contentHash(before) | ZONE-01/02 |
| JSON区域保存 | `requestId,baseRev,baseMtime,html,ops:[],zoneOps`；html尚未套候选；返回applied/skipped及盘版本 | ZONE-04 |
| 区域回执 | 文档级zoneSaveReceipts≤50；母版不创建job；同ID同内容先判重 | ZONE-04/06 |
| 完成出口 | 原finishGenTask签名保持；业务回调仅返回 `{ok:true,extra}` 或 `{ok:false,error}` | TASK-02/03 |
| 完成纯函数 | `completeGenResult(cur,{kind,taskId,now,ttlMs,apply,errMsg})`→`{next,out}`；next=null表示不写 | TASK-02 |
| 面试来源 | `resolveInterviewSources({evidence,paras})`→`{sourcesByEvIndex:Map,sourceParas:[],omitted:[]}` | SRC-01 |
| 来源项 | `{zid,hash,text}`；hash基于完整段落，text仅为实际发送片段；prompt/parser共用同一sources | SRC-01/02 |
| 来源视图 | evidenceSourceView、interviewSourceView、evalRecordView，均不写输入或存储 | SRC-03/06 |
| 资源模块 | ResourceBusy、ResourceLeaseError、createSlotPool、aiPool、renderPool；acquire/borrow/release | RES-01 |
| 底层透传 | chatMsgs(root,messages,{lease}={})；chat(root,sys,user,{lease}={})；renderDoc({src,out,env,lease})；renderCurrent(id,{lease}={}) | RES-02/05 |
| runner | `runGenTask(id,kind,taskId,scope='all',{lease}={})`；最外层finally释放接管的AI凭证 | RES-04 |
| 严格验收 | `RESUME_TEST_STRICT=1 npm run test:all`；不得把必需浏览器缺失解释成通过 | VAL-02、DEL-03 |

来源包修改 runner 输入/完成回调时，采用 TASK-03 的显式结果约定；资源包只增加外层所有权与透传，不能还原旧的回调返回。区域与来源都涉及 job-panel 时先移交小补丁，由其唯一 owner 合并。

## 3. 启动与基线记录

### Task PRE-01：确认执行目录和授权范围

- [ ] 阅读批准设计与对应子计划，确认当前任务是实施，而非仅继续讨论。保存初始状态：

```bash
cd /Users/xxxly/resume
git status --short --branch
git rev-parse HEAD
git log -3 --oneline
```

预期 HEAD 包含设计与计划提交，业务实现基线仍可追溯至627c2a8；已有用户改动逐条记录并保护。若进入隔离worktree，所有代码与命令以该checkout为根替换，真实数据不复制过去。

- [ ] 检查 node、poppler、ffmpeg 和本机 Chromium 的既有探测条件；只核对安装状态，不在本步骤自动升级依赖或浏览器。已有 playwright-core 版本固定1.60.0。
- [ ] 为本轮证据建立代码目录内的忽略临时区或系统临时目录，日志不能带密钥或真实简历正文。用测试脚本自建RESUME_ROOT；不能继承指向真实目录的外部变量启动服务。
- [ ] 记录真实数据的只读指纹/mtime基线，使用既有test.sh保护机制；不要将指纹对应内容或个人数据加入提交。

### Task PRE-02：明确交接与集成时段

- [ ] 记录角色分配、每个共享文件的唯一owner和当前工作包；角色表可写在本轮本地实施记录，不更新个人长期记忆。
- [ ] 单个子代理提示中写明：所属任务、唯一文件、预期接口、禁止触碰真实数据/冻结件、其它agent正在工作且不得回退其改动。共享文件只能交付接口/补丁清单，不能并行直接修改。
- [ ] 先完成验证基础。若环境使必需验证无法运行，标明缺失条件，不开始真实发布，不宣称实现已经通过验收。

## 4. 执行依赖与可运行提交

| 阶段 | 任务 | 允许并行 | 退出条件 |
|---|---|---|---|
| A 验证基础 | VAL-01…04 | 历史夹具、各包独立纯模块可准备 | 预设失败能被真实检出；测试只拥有自己的资源 |
| B 第一批接线 | TASK-01…03、ZONE-01…07 | gen-result与zone纯模块/前端独立；server/test接线串行 | 状态纯函数反例、区域安全子集、在途输入和保存续接通过 |
| C 来源 | SRC-01…07 | 可提前准备pure/UI；最终runner接线在TASK后 | 真源、generic、旧数据与评估语义通过 |
| D 资源及综合任务反例 | RES-01…09，随后TASK-04 | 池/LLM pure可提前；server接线在B/C后 | 所有实际调用受控，断连不早放，POST不重发；新来源协议下T1/T2真实桩通过 |
| E 兼容交付 | DEL-01…05 | DEL-01脱敏夹具可早做；最终验收串行 | C1/D1及严格四套件实际成功，真实服务版本可确认 |

源文件owner在每一组公开接口改变时同步其调用点及测试迁移。例如源集合缺失时fail-closed，不能把旧runner和新parser作为“可发布”的中间提交；资源入口传lease时底层与runner所有权必须在同一可运行批次合齐。

TASK-04的完整本地桩使用SRC-02的新来源输出，且最终验证采用RES-04的runner所有权，因此综合反例在这两项接线完成后运行；TASK-01…03先完成纯判定与生产修复。该依赖不妨碍第一批修复，只避免用尚未实现的来源协议制造无意义的失败。

拆分提交可保留独立纯函数切片；跨文件接线若无法单独运行，合为一个原子提交，不留静默降级入口。各包建议的commit命令只暂存其明确文件，不能照抄命令把别人的未完成共享文件带进提交。

## 5. 设计验收到具体任务的映射

| 设计编号 | 计划任务 | 实际观测 |
|---|---|---|
| V1 | VAL-01、VAL-02 | 退出分支执行结果、外层严格模式返回码 |
| V2 | VAL-03、VAL-04 | 本轮PID、端口占用者、临时目录/日志、并行退出 |
| Z1 | ZONE-03、ZONE-05 | 保存失败/dirty时无模型请求 |
| Z2 | ZONE-02、ZONE-04、ZONE-06 | 磁盘只含安全子集，跳过原因及单次撤销 |
| Z3 | ZONE-04 | 预检查后的新锁/改绑仍被最终事务阻止 |
| Z4 | ZONE-05、ZONE-07 | A→B→A、晚到响应不改新界面或busy |
| Z5 | ZONE-04、ZONE-06、ZONE-07 | 母版/草稿回执幂等、在途输入、继续保存及刷新 |
| Z6 | ZONE-01、ZONE-02 | 实体一次解码、空白、内联、重复ID、纯文本转义 |
| T1 | TASK-01…04 | 延迟桩触发证据批次变化，error不被done覆盖 |
| T2 | TASK-01…04 | 取消/超时/替代后内容与新状态不变 |
| S1 | SRC-01、SRC-02 | prompt实际真源、原evIndex、无素材伪锚点 |
| S2 | SRC-02 | 引文实际发送片段、sourceZid、数字来源归属 |
| S3 | SRC-03、SRC-04、SRC-07 | 旧数据读时降级、UI标签/回跳、零存储修改 |
| E1 | SRC-05、SRC-07 | 模型收到可见正文；所有展示证据核验 |
| E2 | SRC-06、SRC-07 | 样式不改正文hash；历史分数与原存储保持 |
| R1 | RES-01、RES-03、RES-05、RES-07 | 所有入口实际活跃渲染≤2、拒绝前零业务写入 |
| R2 | RES-02、RES-04、RES-07 | 同步/后台共享真实AI容量，429不留running |
| R3 | RES-05、RES-06、RES-07 | 断连/取消/body中断/子进程关闭后的占用变化 |
| R4 | RES-02、RES-08、RES-09 | 本地桩计数，POST仅一次、GET有限重试，进入共享验收 |
| C1 | DEL-01、DEL-02 | 历史主脚本真实保存、隔离盘、刷新、未知脚本拒绝 |
| D1 | DEL-03…05 | 严格四套件、冻结件、真实数据保护、当前交接与生效版本 |

## 6. 共同验证、回退与停止规则

- 每个行为先建立能失败的反例，再改最小实现；关键反例记录一次错误行为确实会失败的证据。不得仅靠新增函数缺失、源码文本或控制台成功字样证明缺陷已修。
- 独立小测试只运行其包，相关检查通过后不无故反复全量；最终统一运行一次严格四套件，发生新变更或失败再按影响补跑。
- 所有独立脚本在test-structure.sh显式调用一次，浏览器用例接test-editor.mjs，保证最终test:all实际涵盖本轮变化。没有新建自动扫目录runner。
- 真实数据写入、冻结件变化、不能解释的基线漂移、锁死、旧数据误升级为可信或必需测试跳过均阻断发布。先保存本轮证据，修正该包，不通过删断言/放宽安全边界收尾。
- 代码回退按依赖逆序；保留本轮真实新增数据，不用全目录备份覆盖用户后续输入。可选字段旧代码不解释；回执与来源字段不批量删。存在未完成zone提交时先停止该入口，不能恢复仅客户端preflight作为完整防护。
- 本轮不保证模型语义事实已证明、不保证HTTP断开等于取消计费、不保证跨进程容量、不承诺任意并发自动无损合并。不能自动安全合并时保留本地输入、dirty与核对提示。

## 7. 给后续实施 agent 的启动提示

下面是一段完整的交接提示。实际分工时替换最后一句中的工作包名称与owner身份；不要删去约束。

> 在 `/Users/xxxly/resume` 实施已批准的可靠性加固。先读 `dev-docs/2026-10-24-reliability-hardening-plan.md` 总入口、对应设计和所属子计划。只在分配的文件内工作，其他agent也在修改仓库，保护他们及用户已有改动。真实 `docs/`、个人JSON和config保持只读；验证用隔离RESUME_ROOT和本地桩，不调用真实模型。冻结template.html、themes/、render.mjs。共享server和测试文件由指定owner顺序集成。按复选步骤先反例后实现，提交时使用精确文件路径和正常hook。交接时列实际通过/失败/未运行项、验收编号和回退点，不把代码完成当成真实服务已经生效。请从分配给你的工作包开始，未分配共享文件只提交接口与用例清单。

## 8. 计划编制完成条件

- [x] 六份子计划全部有规定header、文件地图、复选步骤、核心实现/测试片段、确切命令与预期结果。
- [x] 本入口21项设计验收均有任务落点，固定接口跨包名称一致，共享文件没有多owner。
- [x] 编制者完成占位/矛盾/范围/接口自查；子代理协助不替代编制者检查。
- [x] 本次提交范围仅设计/计划Markdown，未创建本轮实现文件或写入真实数据。
- [x] 本入口及六份子计划作为文档交接；本会话不启动实施，不再为已确认的设计重复征询许可。

只有本节复选项表示计划编制检查已完成；其余章节及子计划的实施复选项均未执行。文档示例的语法检查不等于应用行为、隔离集成或真实模型已通过。
