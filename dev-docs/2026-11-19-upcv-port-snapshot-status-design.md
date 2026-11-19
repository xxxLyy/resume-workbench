# 建简历快照 + 六态收尾设计（UPCV A3 · #2/#13）

> 2026-11-19。总控：`2026-11-19-upcv-port-plan.md`。契约源：efc `docs/upcv-resume-snapshot-implementation.md`（四端点形状）+ UPCV §12.4b。
> 本仓现况（侦察实据）：`APP_STATUSES` 六态枚举 + `appStatus()` 读时归一已存在（server.mjs:128-136），agent 工具 `query_job_progress` 已按六态输出；真实 applications.json 仅 1 条。**本块六态部分只剩 UI/口径收尾，不重造枚举**。

## 1. 建简历快照（挂 upcv-api.mjs 契约区，对齐 UPCV 4 端点 + `{code,data}` 包壳）

upcv-api.routes.md 待接点(6) 预留了 `/api/resume-creation/snapshots/latest`——本块落**真实现**：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/resume-creation/snapshots/latest?schemaVersion=2` | `{code:0, data:{snapshot:null \| {id, sessionId, snapshotData, clientVersion:'pc-web', completedResumeId, updatedAt}}}`（只回最近一条未完成） |
| POST | `/api/resume-creation/snapshots` | `{sessionId, snapshotData}` → UPSERT 该会话（一会话一行）|
| PATCH | `/api/resume-creation/snapshots/:id/complete` | `{completedResumeId}` → 置完成 |
| DELETE | `/api/resume-creation/snapshots/:id` | 删行 |

- 账本 `resume-draft.json`（对象，键=sessionId）：`{drafts:{<sessionId>:{id, sessionId, snapshotData, clientVersion, completedResumeId:null, createdAt, updatedAt}}}`；`tx.mjs updateJsonLedger` + 四连登记。
- **agent.mjs 接缝**（chatStream 用户条落盘后）：会话带建简历意图（复用 system 既有引导语义；判定 = 用户消息含「从零/新建/创建简历」类关键词且尚无进行中草稿，或已有草稿未完成时延续）→ 每轮把本轮收集模块 UPSERT：`snapshotData = {collected:{basics?,education?,projects?,skills?,summary?…按对话实际模块}, lastQuestion, rounds}`。普通会话零写入。
- **生成落库衔接**：草稿完成 → 用户在 /new 或导入建出真文档后，agent 下一轮识别 docs-meta 新增未归档 master → 调 PATCH complete（completedResumeId=新 docId）。
- **agent-panel.js 恢复提示**：挂载时 GET latest，有未完成 → 输入框上方横幅「检测到未完成的建简历现场（N 轮），继续？」→ 点击 `navigate('/agent')` 带会话 + 首条消息前缀注入草稿摘要。

## 2. 六态收尾（审计驱动，预计 ≤ 半天）

1. `/applications` 页：筛选/标签/徽章逐一对 `APP_STATUS_ALL`（to_apply 待投递 / preparing 准备中 / applied 已投递 / replied 有回应 / interviewing 面试中 / offer / closed 已关闭）+ 临近截止（dueDate ≤ 今+7d）展示口径与 agent 工具 dueSoon 一致；缺则补，口径全站同款（胶囊同档纪律）。
2. `followup.mjs`、投递表单的 status 输入面：确认只出合法枚举 + 中文标签映射同 `appStatus()`。
3. **applications.json 条目新增可选字段 `jobId`（A4 幂等键铺垫）**：写入侧（/app/add、/app/update）接受并透传，读侧未知键忽略——零迁移（缺省不落键）。
4. 既有 legacy 中文值不迁移不改写（`appStatus()` 读时归一的既定口径）。

## 3. 测试

- `test-draft.mjs` 六步样板：seed 两个会话 → POST UPSERT 两次同会话（行数不变、updatedAt 变）→ latest 只回未完成 → PATCH complete → latest 变 null → DELETE 404 语义。
- 源码断言：upcv-api 契约区四端点字面量；agent 建简历意图分支行；applications 写侧 jobId 透传行。
- 六态：既有 test.sh 投递段跑绿 + 新增断言（/applications 页六态标签与 APP_STATUS_ALL 同源，防两处漂移）。

## 4. 验收

隔离实例 curl 快照四端点 + 普通对话不写草稿断言 + kickstart + 浏览器实点（建简历 2 轮 → 刷新页面横幅 → 建出真文档 → latest 置 null）。
