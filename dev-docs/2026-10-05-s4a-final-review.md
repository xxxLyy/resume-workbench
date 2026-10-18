# S4a 独立终审记录（2026-10-05）

> 终审方式：会话内结构化终审（子代理通道因额度受限不可用，经用户批准 T7 起改为会话内实施+两轮审查；如需第三方复核，额度恢复后可按本清单逐条重放）。
> 范围：S4a-T7~T12（e67cd7f…4810a09）；基线 S4a_BASE = bbbbad60。

## 1. 冻结件审计（A9 前置）

- `git diff bbbad60 -- template.html themes/ render.mjs` = **空** ✓
- `git diff bbbad60 -- freeze.mjs` = **空**（T2 授权的 stripZid 偏差在基线之前已落，基线后零改动）✓
- pixel-diff：test-render.sh exit=0（冻结主题渲染等价门）✓；同一正文+meta 的渲染输入由上述零偏差文件构成，PDF 等价结构成立。

## 2. 验收用例 A1–A9 逐条 → 证据

| 用例 | 证据（测试位置） | 结论 |
|---|---|---|
| A1 无模型全流程 | S3A2 无模型降级 409 断言；gen-start hasLLM 409（T4 区间）；创建/编辑/导出与 LLM 解耦 | ✅ |
| A2 未确认/过时素材 | T6：未确认素材不入 prompt（:1117）；反例6 取消确认即失效（读取时现算） | ✅ |
| A3 JD 不虚构 | parseEvidence ID 精确匹配+降 todo（T6 六项之六）；factGuard 数字/日期（S4a-A）；prompt JD 边界声明 | ✅ |
| A4 手改/锁定/重复/删除/重排 | T8 组：needs-compare（锚点≠baseSnapshot）/locked-now 拦截/guardOps 越界+锁定列 skipped/anchor-gone；重复文本由 S3 zid 唯一性兜底 | ✅ |
| A5 重复点击/取消/刷新/重启 | T4 组：原子启动/并发双击/取消带 taskId/迟到回调丢弃/读取时过期清扫/重启 running→error | ✅ |
| A6 失效/手改/撤销/位置恢复 | T9 组（4f/4g）：三层撤销隔离、撤回前置拦截、拒绝原因进 feedback、多命中全展示、保留当前版本、位置与筛选恢复（reviewPos） | ✅ |
| A7 PDF 口径 | F1 组（fresh 分母统一/空列表/单 chip 三态，T1+T1b） | ✅ |
| A8 超页 3 轮/下限 | T10 组：layoutDiagnose 步长/下限钳制/3 轮上限/结构性表述（无“置信”、无占比%）/取舍候选带 zid/超页二出路 | ✅ |
| A9 冻结件等价 | 见 §1 | ✅ |

## 3. 契约反例逐条（v1.4/v1.5/v1.6）

- **v1.4 六项**：锁内扫描跨文档并发（T4）、接受/撤回原子提交（T8 JSON 协议）、resolved 再变重核对（T9-b）、锚点化 needs-compare（T8-b）、validity 含 factStatus（T6 反例6）、coverage 校正（T6 六项之六）✅
- **v1.5 六项**：坏操作整份拒绝（S4a 附加e）、operationId 校验（S4a-A）、skipped 门控+不计完成（T9-c + exportChecks）、无有效来源不 sourced（T6）、撤回状态统一 pending+清快照（T8-d）✅
- **v1.6 保存协议**：JSON 体分流、整次幂等只回执（同 ID 同内容 deduped）、严格 baseRev（落后/未来 409）、四反例（a 接受→撤回→重试只回执不重放【test.sh+浏览器端到端】、b 重复 ID 不同内容 400、c 未来 baseRev 409、d 中文+分隔符字面量安全）✅

## 4. 设计落地修正（实现与设计文本偏差，均已登记）

1. **§5.3 排版参数单位**：设计写 pt/em；实现 typo 通道为 px/倍数/mm。按实现单位落地：下限 字号≥12px、行高≥1.3、段距≥0.4mm；步长 −0.5px/−0.05/−0.1mm。
2. **note 持久化端点**：复用 POST /job/changes（evidenceNote 分支），未新增 /job/evidence-note（路由冻结表因此不扩）。
3. **计划卡 T7 行「四态徽章」为笔误**：按 v1.3 反例5 落五态（covered/sourced/thin/todo/none）。
4. **看板「🎯 用此 JD 匹配」链接与 jdfrom 桥同步退役**（岗位匹配能力由证据表承接，设计 §3）。
5. **排版轮次载体**：meta.layoutRounds（设计未指定存储位置）。
6. **AI 引导文案**：岗位匹配行移除后嵌入/抽屉两串保留各自措辞。

## 5. 遗留登记（后续阶段处理）

- guardOps ③（hide 目标展开 ∩ keepProjects/locked 交集）未接——生成时 hide 与必须保留条目的交集校验待 T4b/后续补（②锁定与①范围已生效）。
- reorder 候选 zid 跟随无专测（判定逻辑由 candidatesState 覆盖）。
- baseRev 409 的 UX：当前提示+刷新后手动重试（自动重试与冲突合并视图可后续增强）。
- 装饰性 5 个导航 SVG 未做（无验收断言；如需可在 T4b 补）。
- 测试载荷含数字（如「T8」）会触发 factGuard 冲突标注——后续写测试夹具时留意。

## 6. 上线清单（需用户明确指令）

1. **重启服务（须用户授权）**：`launchctl kickstart -k gui/$(id -u)/com.lhx.resume-server`
2. 重启后冒烟：打开 http://127.0.0.1:7766 → 首页徽章 → 真实岗位草稿审阅/导出各走一遍。
3. 知情项：旧文档首次保存后 zid 落盘；reviewed 岗位草稿一次性降 draft（S3 遗留，可逆）。
4. 可选：`node migrate-meta.mjs` 持久迁移真实 materials.json（读时兼容已生效，不跑不阻塞）。
5. 回滚：每任务独立提交（e67cd7f…4810a09），可逐个 revert；数据层备份 backups/ 既有机制。

---

## 上线后修复批次（2026-10-05，POST-launch；ce077dc / 6623bee / a450ce0 / 21328dc）

> 验证方式：全部在隔离数据根（test.sh 每次运行的临时实例）实测；未调用真实模型；未改真实简历与母版；正式服务未重启（改动待下次用户授权重启生效）。

| # | 修复项 | 提交 | 证据 | 核实方式 |
|---|---|---|---|---|
| 0a | guardOps ③ 接线（hide 目标展开 ∩ keepProjects/locked 成员 → 拒绝列 skipped） | ce077dc | test.sh「S4a 补遗 guardOps ③」：条目甲（keepProjects 命中）与条目乙（成员锁定）两条 hide 均列 skipped 且原因明示 | 实测 |
| 0b | /delete 同步清理 docs-meta 条目（孤儿 meta 缺口） | ce077dc | test.sh「S4a 补遗 /delete」：删除后 meta 无该条目；上线冒烟中实测删除测试草稿后 meta 无残留 | 实测（隔离根 + 生产冒烟各一次） |
| 0c | reorder 候选 zid 跟随专测 | ce077dc | test.sh「S4a 补遗 reorder」：段落移动后候选仍无失效命中 | 实测 |
| 1 | POST /export 服务端导出门控（新建与复用分支同检 pending+skipped 冲突，409 响应零副作用；/history-pdf 历史独立访问保留） | a450ce0 | test.sh「修复1」：pending 409 / skipped 409 / 记录数与产物数零变化 / 冲突清零后 200 建记录 / 二次冲突时复用分支同被 409 / 已有 exportId 经 /history-pdf 仍 200 / 清零后 reused:true | 实测 |
| 2 | 保存入口最小结构校验（JSON 与旧 HTML 两路径共用 looksLikeDoc：剥离后须含 HTML 元素标签；不用固定字符串/字数判断；兼容极简旧文档） | a450ce0 | test.sh「修复2」：'not found'、JSON 碎片、HTML 路径同载均 400；拒绝后正文 md5/rev/快照数/PDF md5 五项零变化；极简 `<body><p>` 文档可保存（兼容性） | 实测 |
| 3 | 可投递契约统一（移除导出页「打开即自动标记可投递」；deliverableNow = flow reviewed（用户显式确认，S1 契约）+ 整体审阅完成（jobViewLive.checks.reviewComplete，与审阅 Tab/导出页同源）+ PDF 非陈旧；导出页改「确认可投递」显式按钮） | a450ce0 | test.sh「修复3」：pending / skipped / 待核对（hand-edited）三场景均不可投递，全部处理完成后可投递；导出页无自动标记脚本、含确认按钮与已确认徽章；确认后 flow=reviewed（S1 契约）；打开导出页不改变 flow | 实测 |
| — | ponytail 精简（可投递门控 skipped 口径补齐前奏、setDrawer 死参数、itemHtml 形参、layoutDiagnose 冗余字段；11 个零引用导出评估后保留） | 6623bee | 四件套全绿；死导出扫描清单存档于会话 | 源码检查 + 实测 |
| — | 真实 LLM 链路验证（证据生成 5 条落账 refs 全 fresh；建议生成 6 条全带 zid；测试草稿已删） | 21328dc | 上线冒烟记录（handoff） | 实测（真实模型 Kimi k3 各一次） |

### 未跟踪文件与仓库纪律

- dev-docs/ 下 S4a 设计/计划/mockups/本终审记录为 **untracked**（设计轮纪律：不自动提交）；`2026-10-05-s4a-final-review.md` 与本批次交付记录同属此列，是否入仓由用户决定。
- `pelican-bike.html`：仓库根的无害趣味页面，**保持原样未动**（未删除、未修改、未提交）。
- 本批次仅提交 server.mjs 与 test.sh（ce077dc 另含 test.sh；a450ce0 含 server.mjs+test.sh），无批量夹带。

### 遗留（更新后）

- ~~guardOps ③~~ ✅ 已修复（ce077dc）
- ~~reorder zid 跟随无专测~~ ✅ 已修复（ce077dc）
- ~~./delete 不清 meta~~ ✅ 已修复（ce077dc）
- ~~真实 LLM 链路未验证~~ ✅ 已验证（21328dc）
- 保留：baseRev 409 的 UX 重试增强（提示+刷新手动重试现状可用）；装饰性 5 个导航 SVG（无验收断言）；正式服务运行旧代码，**本批次生效需用户授权重启**。
