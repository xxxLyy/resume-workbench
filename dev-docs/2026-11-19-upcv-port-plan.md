# UPCV 复刻 A 路线移植总控（efc 参照 → 本仓落地）

> 2026-11-19 产出。用户拍板：UPCV 一比一复刻以**本仓（简历工作台）为产品主体**，efc 工作台（`personal-ai-workbench-efc-20261116`）降级为契约参照 + 可抄逻辑源。本文件是移植总控：范围、顺序、共享纪律。各块细节见同日四份设计文档。

## 0. 范围（四块，对应逆向清单缺口）

| 块 | 设计文档 | 覆盖 UPCV 项 | 依赖 |
|---|---|---|---|
| A1 画像+偏好 | `2026-11-19-upcv-port-talent-design.md` | #7 画像 / #8 偏好 | 无（母版文档） |
| A2 职位源+匹配+推荐 | `2026-11-19-upcv-port-jobs-match-design.md` | #10 匹配 / #11 推荐 | A1（偏好映射，可选降级） |
| A3 快照+六态收尾 | `2026-11-19-upcv-port-snapshot-status-design.md` | #2 快照 / #13 六态 | 无（agent.mjs 已有建简历流） |
| A4 投递扩展接线 | `2026-11-19-upcv-port-extension-design.md` | #14 自动投递 | A2（match-score）+ A3（shortlist/幂等字段） |

派工顺序：**A1 与 A3 并行 → A2 → A4**。已在正轨不重做：Agent/四件套/模板/导入/JD 链（本仓 11-18 已按同源契约落地，见 `2026-11-18-reactive-resume-adoption.md` §4 边界表）。

## 1. 契约源与参照

- 形状契约：`/Users/xxxly/projects/personal-ai-workbench-efc-20261116/docs/upcv-profile-preference-implementation.md`、`upcv-match-implementation.md`、`upcv-resume-snapshot-implementation.md`、`upcv-apply-extension-implementation.md`；字段溯源 `/Users/xxxly/claude_data/upcv-features-v1.md` §12.4b。
- 可抄逻辑源（翻译成 vanilla mjs，禁带依赖）：efc `apps/server/src/routes/{talent,match,extension}.ts`、`platform/upcv.ts`、`apps/extension/` 整目录。
- 活体对照：efc 实例 `http://127.0.0.1:60331`（curl 比响应形状；停服前先问）。
- 本仓内先例：LLM 编排样板 `ai-helper.mjs`；新账本 `tx.mjs updateJsonLedger`（b3c1 apply-profiles.json）；六态枚举 `APP_STATUSES`（server.mjs:128，勿重定义）；SSE `pipeSSE`（server.mjs:9428）。

## 2. 共享纪律清单（每块开工前过一遍，违者返工）

1. **新运行时账本四连登记**（evaluations.json 踩过整包 500）：① `tx.mjs updateJsonLedger`（跨进程锁+损坏停写）② backup tar 清单 / RESTORE_MANAGED_FILES ③ `.gitignore`（与 applications.json 同列）④ test.sh 隔离数据根 seed。数组 vs 对象形状先看 shapeOk 口径。
2. **路由接线五步**（agent.routes.md §1 样板）：import 区 + init(root) → 静态面板路由 → 页面路由 `page(title, inner, 'apps')` → topnav（server.mjs:2175，icon 须在 vendors/icons.mjs 白名单，**改行同步 test-structure.sh 导航断言**）→ gatePool（server.mjs:754，只有调 LLM 的前缀加 AI 池；计数器必须在模块级）。
3. **会写盘的 GET 必须登记 `WRITE_ON_GET`**（server.mjs:122）。
4. **转义口径**：属性 `escAttr`、JS 串 `escAttr(JSON.stringify(...))`、内联 boot 数据 `jsonScript`；新外部字段名进 XSS-4 启发式名单。
5. **样式**：色一律 `var(--…)`（B1 钉亮蓝 `#0033d2`，全文件唯一字面；**DESIGN.md §2 表格「近黑」是 11-02 旧口径，以 A-VARS 行与 B1 断言为准**）；间距 `--space-*`；零阴影；页题两档不新增。
6. **断言与实现同提交，不许放宽**；哨兵打在真炸路径；反向验证用 `git checkout <commit> -- <file>`。
7. **AI 测试一律本地 stub（假 LLM 虚拟 config）**，真实 LLM 验证需用户授权 token；LLM 编排护栏沿用 eval.mjs 三道（score 越界整份作废 / verdict 一致回落 / strengths 逐字子串验证，编造即清空降级）。
8. **交付收尾**：`node --check` → `bash test-structure.sh` → 相关 test.sh 段 → `launchctl kickstart -k gui/$(id -u)/com.lhx.resume-server` → **浏览器实点**（curl 不算完成）→ 提示用户硬刷新。
9. 真实数据禁写禁删；一切验收 `RESUME_ROOT=<tmp> PORT=<随机>` 隔离实例；**绝不裸 kill 7766**（launchd KeepAlive 会拉起且误伤用户）。
10. 新模块测试照 `test-aora.mjs` 六步样板（隔离根/动态口/spawn/exit 钩子/fetch+源码断言/✅ 段式）。
