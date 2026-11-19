# 投递浏览器扩展接线设计（UPCV A4 · #14）

> 2026-11-19。总控：`2026-11-19-upcv-port-plan.md`。契约源：efc `docs/upcv-apply-extension-implementation.md`（四功能 + 外发状态机三档 + 风控识别-暂停-恢复 + 幂等）；扩展底座 = efc `apps/extension/` 整目录复制（esbuild 仅构建期依赖，**不进本仓运行时，零依赖红线不破**——类比 vendors/ 钉 tag 先例）。

## 1. 服务端 `extension.mjs`（新模块，六端点）

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/extension/shortlist` | applications 中 `status='to_apply'`（`appStatus()` 归一口径）→ `{ok:true, items}` |
| POST | `/extension/apply-record` | `{jobId, company, role, link?, docId?}` → 幂等（**by jobId**，A3 已铺字段）→ 建行 status:'to_apply' → `{ok:true, id}` |
| GET | `/extension/resume-text?docId=` | 母版/指定文档 docToText → `{ok:true, text}` |
| POST | `/extension/greeting` | `{docId, jobId? \| jdText?}` → LLM 招呼语 ≤120 字（简历亮点 × 岗位）→ `{ok:true, greeting}` |
| POST | `/extension/chat-reply` | `{jobId?, historyText}` → LLM 回复草稿 → `{ok:true, draft}` |
| POST | `/extension/match-score` | 转 A2 match 核心 → `{matchScore, matchLevel}` |

- LLM 三端点走 llm.mjs + gatePool AI 池前缀 `/extension/`；错误口径 409/400/502。
- **鉴权走 importToken() 先例（书签同款）**：`/extension/*` mutating 从 CSRF 豁免名单加入（同 `/import/page` 先例：mutating 排除 + 自带 token 把关），要求头 `X-Resume-Token === importToken(root)`，不符 401。扩展首次配置 = sidepanel 输入本机地址 + token（用户从书签菜单同源复制）。Host 白名单天然放行 127.0.0.1。

## 2. 扩展底座移植（`tools/extension/`）

1. `cp -r efc:apps/extension → ~/resume/tools/extension`；改 `config.js` 默认 base = `http://127.0.0.1:7766` + token 头名 `X-Resume-Token`；`build.mjs` esbuild 照搬（构建期 devDependency 只在 tools/extension/package.json，不进根 package.json）。
2. 面板/sidepanel/三站适配器（BOSS 全量 + 猎聘/智联骨架）照搬；端点路径改 `/extension/*`；shortlist 消费字段对齐本仓 applications 形状。
3. 外发状态机三档（逐岗确认 ⇄ 全自动 ⇄ 无需确认）、不可逆保护、幂等跳过（applications 已 applied/replied 的岗位标注「已沟通过」）、批次上限 20 岗、动作间隔 3-8s、风控文案匹配进 PAUSED——全部按 efc 扩展文档 §6 照抄，不改语义。

## 3. 不做（对齐 efc 文档边界）

积分计费/extension-detected 奖励（本地无积分）；验证码绕过（遇码即停交人工）；其他站点。网申自动填表（功能④）后置：三站聊天/招呼先落地，表单映射二阶段再说。

## 4. 测试

- `test-extension.mjs` 六步样板：隔离根 + 假 LLM；token 不符 401 / 符合 200；apply-record 幂等（同 jobId 两次行数不变）；greeting ≤120 字断言；shortlist 只回 to_apply。
- 扩展构建：`cd tools/extension && npm i && node build.mjs` 产物 dist/ 可加载（人工验，不进 CI）。

## 5. 验收

1. 隔离实例端点全过 + 源码断言（CSRF 豁免行 + importToken 比对行 + gatePool 前缀行）；
2. kickstart + 真机：`chrome://extensions` 加载 dist → sidepanel 配地址+token → zhipin 搜索页采集 ≥1 页 → match-score 过滤 → 「加入待投」→ 本仓 /applications 出现 to_apply 行 → 生成招呼填入不发送 → 人工发送后 apply-record 置 applied → 模式 A 确认卡出现、停止批次即停；
3. 风控演练：构造一次受限 → PAUSED + 提示（红条文案如实）。

## 6. 边界（如实）

- 三站 DOM 改版属预期失效面（efc 同款声明）；适配器 config 化，失效改 json 不改码。
- BOSS 为主战场，猎聘/智联允许骨架后补。
- 扩展打真站消耗的是站方风控额度非 token；LLM 招呼/回复走本仓 config 模型，测试期一律假 LLM。
