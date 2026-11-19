# 求职画像 + 求职偏好设计（UPCV A1 · #7/#8）

> 2026-11-19。总控：`2026-11-19-upcv-port-plan.md`（纪律清单 §2 全文适用，不重复）。
> 契约源：efc `docs/upcv-profile-preference-implementation.md`（响应形状逐字段）+ `~/claude_data/upcv-features-v1.md` §12.4b。
> 可抄逻辑：efc `apps/server/src/routes/talent.ts` + `jobs.ts` preference 段 → 翻译成 vanilla mjs。
> 零新增依赖：llm.mjs + tx.mjs updateJsonLedger + 现有 A-VARS token。

## 1. 端点（server.mjs 应用页路由区新增，error 口径 409/400/502 同 ai-helper）

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/talent/profile` | `{ok:true, profile:null \| {timeline[], directions[{name,confidence,reason}], competitiveness{level 1-5, label, strengths[], gaps[]}, headline, generatedAt, sourceDocId}}` |
| POST | `/talent/generate` | 母版 → LLM → 覆盖写 talent.json → 返回 profile |
| POST | `/talent/refresh` | 同 generate（语义区分对齐 UPCV，实现同一函数） |
| GET | `/preference/state` | `{ok:true, preference:null \| {…}}` |
| PUT | `/preference` | 全量校验后写 preference.json |

- 无母版（docs-meta 无未归档 `kind:'master'`）→ 400 「先创建或导入一份母版简历，画像基于母版生成」。
- 数据源：母版正文经 docToText（与 agent.mjs resolveDoc 同口径）截 20000 字 + sectionsOf 章节标题清单作结构提示。
- LLM 编排照 ai-helper.mjs 样板：`buildTalentPrompt`（只输出 JSON；level 整数 1-5；directions confidence 0-1 数值；timeline 按时间序；禁止虚构经历）→ `chat(root, sys, user, {lease, profile})` → `parseTalent` 兜底。
- **三护栏移植 eval.mjs 纪律**：level 越界/非整数 → 整份作废 502；directions 空或非数组 → 整份作废；headline 缺失 → 服务端兜底句（不编造）。
- gatePool：`/talent/` POST 追加 AI 池前缀（server.mjs:754）；`/preference` 不调 LLM 零改动。

## 2. 偏好校验（PUT /preference，非法 → 400 中文枚举提示）

`{jobTypes ⊆ ["SOCIAL","INTERNSHIP"]（校招保留枚举位默认不选，用户已剔除校招）、status、salary{min≤max, unit:"K"}、cityIds[]、industryIds[]、functionIds[]（数字数组）、companyTypes ⊆ 八枚举 CENTRAL_SOE|STATE_OWNED|PUBLIC_INSTITUTION|LISTED|FOREIGN|JV|PRIVATE|STARTUP、availability、allowContact:boolean（保留字段不展示，本地无导师服务）}`

## 3. 账本（四连登记，对象形状）

`talent.json` initial `{profile:null}`；`preference.json` initial `{preference:null}`——均走 `tx.mjs updateJsonLedger`（lockFile + validate + initial），登记 backup tar 清单、RESTORE_MANAGED_FILES、`.gitignore`、test.sh 隔离 seed。

## 4. 页面 `/talent` + topnav 第 8 项

- `page('求职画像', talentPageInner(), 'apps')`；面板 `talent-panel.js` 静态路由 + defer（CSP 零冲突口径同 agent.routes.md §1.3）。
- topnav 追加 `nav('talent','/talent','求职画像','compass')`（icon 先查 `vendors/icons.mjs` 白名单，不在则从白名单内改选；**改行同步 test-structure.sh 导航断言**）。
- 画像区：空态「生成我的求职画像」按钮（409 → 红条「未配置大模型，去 /settings」）；有则 headline + 竞争力 5 级条（level/total + 参考字样）+ strengths(绿)/gaps(橙) 双列 + timeline 纵列 + directions 标签云（带置信度）+ 右上「刷新画像」→ toast「人才画像已刷新」。
- 偏好运：单页表单（A2 字典未落地前城市/行业/职能用逗号文本输入占位，A2 接 /jobs 字典后升级 select）；保存 → PUT → toast；UI 带「AI 参考评分」字样（对齐 UPCV 诚信口径）。
- 样式全 `var(--*)`；主行动按钮 `var(--accent)` 亮蓝。

## 5. Agent 接缝（agent.mjs factsBlock 内追加两段，有则注入无则静默）

```
【求职画像】headline；方向：内容产品(0.8)、数据产品(0.6)；竞争力 3/5 中等偏上
【求职偏好】期望 15-25K；城市：上海/杭州；公司类型：外企、上市公司
```

不加新工具：画像/偏好在 UPCV 语义里是药丸自动携带的背景事实，非查询对象。

## 6. 测试（test-talent.mjs，照 test-aora.mjs 六步样板）

1. 隔离根 + seed 母版夹具 + 虚拟 config 指向本地假 LLM；
2. 假 LLM 回合法 JSON → POST generate 200，profile 逐字段断言；
3. 假 LLM 回 level 越界 → 整份作废断言；
4. 无母版根 → 400 中文；
5. PUT 非法 companyTypes → 400；GET state 回读一致；
6. 源码断言：gatePool 前缀行、factsBlock 画像段、topnav 项、无新增字面色（B1 唯一字面不破）。

## 7. 验收（隔离实例 + 真实收尾）

curl 五端点全过 → `bash test-structure.sh` 全绿 → test-talent.mjs 绿 → kickstart + 浏览器实点（生成→刷新→改偏好→保存→/agent 对话注入含画像行）→ 提示用户 Cmd+Shift+R。
