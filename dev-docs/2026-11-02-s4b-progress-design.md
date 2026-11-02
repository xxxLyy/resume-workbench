# S4b-B 设计：诚实最小进度（2026-11-02）

> 用户拍板顺序 B（诚实最小进度）→ C（面试指南 UI）→ A（分阶段管线，择机）。本设计只覆盖 B。
> 上游：roadmap §3.2「AI 任务管理最小集」九条 + S4b ①（五阶段进度，本设计取其诚实子集）。
> 现状勘察：生成管线无阶段概念（任务记录仅 {taskId,status,startedAt,baseHash,error,scope}），
> 单次适配实测 276s；§3.2 九条中六条已有（状态/取消/防重复/返回可见/并发上限/取消零落账），
> 缺三条：所用模型、已等待时长与超时预期、真实用量。

## 0. 目标一句话

等待期间让用户看到管线**真实**所处阶段、已等待时长、所用模型、超时预期；结束后看到真实 token 用量（服务商没返回就明说「不可用」）；取消文案不暗示能撤销计费。**不显示任何百分比**（roadmap 裁决：无法准确计算时不显示）。

## 1. 数据层（server.mjs）

`genTasks[kind]` 新增三个渐进默认字段（旧记录缺字段全功能可用，读取侧不迁移）：

- `stage: 'queued' | 'calling' | 'parsing'`——只在管线真有的三个检查点写入：
  1. `queued`：gen-start 注册任务后（runGenTask 拿到槽位之前）；
  2. `calling`：拿到 aiPool 槽位、即将发起模型调用；
  3. `parsing`：模型返回、进入解析/校验（模型耗时归 calling，本地归 parsing）。
  写回本身即 finishGenTask，不设第四阶段。
- `model: string`——gen-start 时取 `loadConfig(root).model` 记录在任务上。
- `usage: {prompt,completion,total} | null`——任务结束时记录模型返回的真实用量；无则 null。

**写入合同（复用既有守卫语义）**：阶段写入走新的 `setGenStage(id, kind, taskId, stage)`——
updateMetaAll 内校验「taskId 匹配 && status==='running'」才写，否则放弃（不复活已取消/超时任务）。
每任务新增至多 2 次 meta 写入（queued→calling→parsing 中发生在本进程的两次），同步原子写，量级可接受。

`/job/changes` 响应新增 `genTtlMs: GEN_TTL_MS`（10 分钟），面板据此提示而不写死。

## 2. 用量采集（llm.mjs）

`chatMsgs` 增加可选出参 `opts.meta`（对象引用）：响应体里的 `usage` 字段原样放入 `meta.usage`。
**返回值与签名兼容不变**——全部既有调用点零改动；管线侧传 meta 出参采集。withRetry 重试成功时以最后一次响应为准。

## 3. 面板（job-panel.js）

- 三类任务（evidence / changes / interview）的 running 态：静态文案 → 「阶段标签 · 已等待 m:ss · 模型名」
  （阶段中文映射：queued=排队等待槽位、calling=调用模型中、parsing=解析校验中；旧记录无 stage → 显示「处理中」）。
- 已等待时长：一个全局 `setInterval(1s)` ticker，只更新 `[data-gen-elapsed]` 节点文本，**不触发 render**
  （避开 A9 重建吞输入）；面板 render 重建后由新节点自然接续；任务不在 running 时 ticker 自动空转跳过。
- 超时预期：已等待 > genTtlMs×70% 时追加「接近 10 分钟上限，超时后任务会标失败、可重试」
  （文案里的分钟数由 genTtlMs 换算，不写死）。
- done 态：状态旁补「用量 N tokens」（total 汇总）或「用量：服务商未返回」。
- 取消成功提示：'已取消' → '已取消（不会撤销服务商已发生的计费）'（roadmap §3.2 原文口径）。

## 4. 测试

1. **HTTP 夹具** `test-gen-progress.mjs`（挂 test-structure.sh）：桩 LLM 可控延迟/可控 usage——
   观察任务 stage 经历 calling（延迟窗口内轮询 /job/changes）；结束后 model 已记录、usage 数值正确；
   桩不返回 usage → usage=null；响应含 genTtlMs；两个慢任务占满 aiPool 后第三个任务 stage='queued'。
2. **浏览器夹具** `test-gen-progress-ui.mjs`（挂 test.sh）：running 态显示阶段+时长+模型、
   时长 1s 粒度递增（ticker 证据）、done 态显示用量、取消提示含「不会撤销服务商已发生的计费」。

## 5. 不做（边界）

百分比、五阶段拆分与分批/重试（子项目 A）、面试指南 UI（子项目 C）、新依赖、冻结件改动、
旧文档迁移（渐进默认）。

## 6. 取舍已定

- 阶段只写真实检查点（3 个），宁缺毋假——「进度显示与真实阶段一致」优先于「五阶段」的表。
- usage 走出参不改返回值：零回归面。
- ticker 不经 render：A9 纪律（重建吞在途输入）。
