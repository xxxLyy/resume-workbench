# JD 收件箱 + 批量评估 设计 spec — 2026-11-13

> 上游：DESIGN.md §10.20（书签是唯一的链接导入方式）。本 spec 把「点一次书签 = 处理一个岗位」改成「点书签 = 收进收件箱，攒够了批量评估筛选」。
>
> 用户裁决（2026-11-13）：
> - 批量范围 = **收集 + 批量评估**。批量生成简历不做：每份定制稿都要人逐条审，瓶颈在审阅，不在点击。
> - 书签默认行为 = **直接收进收件箱**（不再每次停在预览页）。
> - 书签带本机口令（防任意网页往收件箱写入）；旧书签需重拖一次。
> - 列表页一键抓取不做：需在用户浏览器内批量请求 Boss 详情页，有账号风控风险且未验证。
> - 猎聘/拉勾/前程无忧/智联选择器实测不在本期：需要用户提供真实页面。

## 1. 用户动线

```
职位页 ──点书签──▶ 「已收入」小卡（去重提示 · 现在就定制 · 去收件箱，2s 后尝试自动关闭）
                         │
                         ▼
        /inbox 待筛选：勾选 + 选简历 → 批量评估（后台串行）→ 按分排序
                         │
                         ▼
               每行：建草稿（→ /edit）｜不考虑
```

## 2. 组件

### 2.1 导入口令 `importToken`

- 文件 `RESUME_ROOT/.import-token`：32 位 hex（`crypto.randomBytes(16)`），首次需要时生成，`mode 0o600`，加入 `.gitignore`。
- 读取函数 `importToken()`：文件在且内容匹配 `/^[0-9a-f]{32}$/` 则返回；否则重新生成并写回。进程内缓存。
- 比较用 `crypto.timingSafeEqual`（长度不等直接判否）。
- 不提供轮换 UI：删除该文件即轮换，旧书签随之失效（写进 /import/page 说明页一句）。

### 2.2 书签代码（`BOOKMARKLET_JS` / `bookmarkletHref()`）

- 在现有三字段 `html`/`url`/`title` 之外，加隐藏字段 `k` = `importToken()`（服务端渲染时替换占位符 `__TOKEN__`，与 `__PORT__` 同手法）。
- 其余不变：隐藏表单 POST、`target=_blank`、提交后移除。

### 2.3 `POST /import/page`（行为分叉）

| 条件 | 行为 |
|---|---|
| `k` 缺失或不匹配 | 只读预览，与现行 `importPreviewPage()` 完全一致；顶部加一句「这是旧书签，请到 /job/new 重新拖一次」 |
| `k` 匹配，迁移锁被持有 | 不写入；渲染只读预览 + 「维护中，本次未收入」 |
| `k` 匹配 | 提取 → 去重 → 写入收件箱 → 渲染「已收入」页 |

- `mutating` 判定与 CSRF 豁免对 `/import/page` 保持现状（表单导航的 Origin 必为招聘站域）。写入的授权由口令承担。迁移锁改为在处理函数内显式检查 `rootLock.isHeld(root)`。
- 响应仍**不带** `Access-Control-Allow-Origin`（「已收入」页含母版列表）。

**去重规则**（只在收件箱内部判重；判重命中 = 不新增）：
1. 链接规范化 `origin + pathname`（去 query/hash，Boss 链接带 `?lid=` 等追踪参数）相同，或
2. `jdFp`（`fingerprintText(jd)`，非空）相同。

命中时「已收入」页显示「已在收件箱（M 月 D 日收入）」，不改原记录。

**跨库提醒**：新增成功后调用现有 `computeFpGuard(jd, url, company, loadMeta())`，若 `dupHints` 非空，记录写入 `dupHints`，卡片显示「之前做过 / 投过：<label>」。不阻止收入。

**「已收入」页**（新渲染函数 `importSavedPage`）：
- 一行结论：「已收入收件箱 · 共 N 条待评估」或去重提示。
- 公司 · 岗位 · 薪资（缺失显示「未识别」）。
- JD < 50 字符时警示「没提到 JD，建议回原页复制全文」（沿用现文案）。
- 两个动作：「现在就定制」（与现预览页同一个 POST `/job/new` 预填表单，母版下拉）｜「去收件箱 →」（`/inbox`）。
- 不显示「提取通道」等内部术语。
- 带 nonce 的内联脚本：2000ms 后 `window.close()`；若页面仍在（浏览器不允许关闭），不报错、不提示。用户在页面上有任何点击/聚焦则取消自动关闭。

### 2.4 `extractJd` 增补薪资

- 返回值增加 `salary`：zhipin 取 `_jobInfo.job_salary`；JSON-LD 取 `baseSalary`（对象时拼 `minValue-maxValue unitText`，字符串时原样）；其他为空串。
- 现有返回字段与三层级逻辑不变。

### 2.5 数据 `inbox`

- `JSON_FILES.inbox = 'inbox.json'`，形状 = 数组，走现有 `readJson`/`writeJson`/`assertWritable`；`inbox.json` 加入 `.gitignore`。
- `loadInbox()` / `saveInbox(list)`，新记录在前。
- 记录：

```js
{ id: 'ib-<timestamp()>', url, urlKey, title, company, role, salary, jd /* ≤ JD_MAX_CHARS */, jdFp, dupHints: [],
  status: 'new' | 'queued' | 'running' | 'scored' | 'error' | 'drafted' | 'dismissed',
  from: null /* 评估用的母版 id */, evalId: null, score: null, verdict: null, error: null, draftId: null,
  createdAt, updatedAt }
```

### 2.6 批量评估队列

- **抽函数**：把 `/eval/create` 的主体（母版读取 → `docToText` → `buildEvalPrompt` → `chat` → `parseEvalReport` → 组装 rec → `saveEvals`）抽成 `async function evalJdCore(root, { from, jd, company, role, lease })`，返回 `{ ok:true, rec }` 或 `{ ok:false, status, error }`。`/eval/create` 改为调用它，HTTP 契约零变化。
- **串行 worker**：进程内单例 `inboxWorker`，一次只跑 1 条，保证 AI 池的另一个槽位留给交互操作。
  - 取下一条 `status === 'queued'`（按 `updatedAt` 升序）。
  - 用 `aiPool.borrow()` 拿槽；`ResourceBusy` 时 3s 后重试，不改记录状态。
  - 置 `running` → `evalJdCore` → 成功置 `scored` 并写 `evalId/score/verdict`；失败置 `error` + `error` 文本。每次写盘前重新 `loadInbox()` 再按 id 改（不持有旧列表跨 await）。
  - 释放 lease 后继续下一条，直到没有 `queued`。
- **重启恢复**：服务启动时把 `running` 改回 `queued`，有 `queued` 则启动 worker。
- 未配置模型（`!hasLLM(root)`）：入队接口直接返回 409 + `settingsPath`，与 `/eval/create` 同口径。

### 2.7 路由

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| GET | `/inbox` | — | 收件箱页 |
| GET | `/inbox/status` | — | `{ ok, items:[{id,status,score,verdict,error,draftId}] }` |
| POST | `/inbox/eval` | `{ ids:[...], from }` | `{ ok, queued:n }`；只接受 `new/error/scored` 的条目，其余跳过 |
| POST | `/inbox/dismiss` | `{ id }` | `{ ok }`；置 `dismissed` |
| POST | `/inbox/draft` | `{ id, from? }` | `{ ok, id:<draftId> }` |

- `/inbox/draft`：有 `evalId` 且该评估未 `promotedTo` → 复用 `/eval/promote` 逻辑（抽成 `promoteEval(root, evalId, from)`，`/eval/promote` 改调它）；否则 `createJobDraft(root, { from, company, role, jd, jdLink: url, jdSource: '收件箱' })`。成功后条目置 `drafted` + `draftId`。`createJobDraft` 返回 409 + `existing` 时，条目同样置 `drafted`，`draftId = existing`。
- 所有 POST 走现有 CSRF/迁移锁判定（同源写请求，无豁免）。
- 路由冻结清单 `test-structure.sh` 同步加入 5 条。

### 2.8 `/inbox` 页面

- 页签：`appTabs` 加首项 `['inbox', '/inbox', '待筛选']`，`page()` 的 active 传 `'apps'`。
- 顶部：母版下拉（同 `jobNewPage` 的 `infos` 口径）+「批量评估所选」按钮 + 「已选 N 条」。
- 列表（排除 `dismissed`）：排序 = `scored` 按分降序在前，其余按 `createdAt` 降序。每行：复选框 · 公司 · 岗位 · 薪资 · 收入日期 · 状态徽章（待评估 / 排队中 / 评估中 / X 分 · verdict / 失败：原因 / 已建稿）· 跨库提醒徽章 · 动作（建草稿 / 不考虑 / 原链接）。
- 存在 `queued/running` 时每 3s 轮询 `/inbox/status`，只更新状态格和动作格；全部结束后停止轮询并按分数重排一次。
- 评估详情：点分数徽章跳 `/evals#<evalId>`（复用评估历史页，不在收件箱重写报告渲染）。评估历史页当前不支持锚点：`evalHistoryRows` 每行加 `id="<evalId>"`，页面脚本在加载时读 `location.hash`，展开并滚动到对应行。
- 空态：「收件箱是空的。到 /job/new 把『抓取此页 → 工作台』拖到书签栏，在职位页点它。」+ 书签链接。
- 页面脚本带 nonce，复用 `WRITE_HELPER_JS` 的写请求助手。

### 2.9 首页与端口提示

- 首页待办：`new` 状态条目数 > 0 时加一条「收件箱有 N 个岗位待评估」→ `/inbox`。
- 端口提示：`!process.env.PORT && boundPort !== 7766` 时，`/job/new`、`/inbox`、`GET /import/page` 顶部显示「服务这次跑在 <port>，书签要重新拖一次」。

## 3. 安全

- 口令只出现在本机渲染的书签链接里；`GET /import/page`、`/job/new`、`/inbox` 都是本机页面，不跨源暴露（无 ACAO）。
- 收件箱 JD 是第三方页面文本，与现有手动粘贴的 JD 同等对待：全部 `escHtml` 输出；送模型时不追加额外权限。
- `inbox.json`、`.import-token` 写入 `.gitignore`，`mode 0o600`。

## 4. 测试

- 新增 `test-fixtures/reliability/test-inbox.mjs`（隔离 `RESUME_ROOT`；本地起一个 OpenAI 兼容桩 HTTP 服务，按请求序号返回合法评估 JSON / 失败）：
  1. 带口令 POST `/import/page` → 收入 1 条；同 URL 换 query 再 POST → 不新增，页面含「已在收件箱」；同 JD 换 URL → 不新增。
  2. 不带口令 / 错口令 → 只读预览，`inbox.json` 不变。
  3. `/inbox/eval` 3 条 → 桩服务观测到的并发峰值 = 1；全部 `scored`，`evaluations.json` 新增 3 条。
  4. 桩对第 2 条返回 500 → 该条 `error`，其余 `scored`；再次 `/inbox/eval` 该条 → `scored`。
  5. 启动前写入一条 `running` → 启动后被改为 `queued` 并跑完。
  6. `/inbox/draft`（已评估）→ 草稿 brief 带评估要点；（未评估）→ 草稿建成；重复 draft → 条目 `drafted`、`draftId` = existing。
  7. `/inbox/dismiss` 后 `/inbox` 页不再列出。
  8. 未配置模型 → `/inbox/eval` 409 含 `settingsPath`。
- `test-import-page.mjs`：断言书签 href 含 `k` 字段；不带 `k` 的现有断言全部保持通过；`extractJd` 返回 `salary`（zhipin 夹具 + JSON-LD 夹具）。
- `/eval/create` 与 `/eval/promote` 现有测试不改即通过（契约零变化）；`/evals` 页断言行带 `id="<evalId>"`。
- `test-structure.sh`：路由冻结同步；全量 `test.sh` 一次终检。

## 5. 不做 / 后续

- 批量生成定制稿；列表页一键抓取；其他招聘站选择器实测；口令轮换 UI。

## 6. 实施注记（2026-11-13，与正文有出入处以注记为准）

1. **首页待办只加在状态 2**：状态 0/1 首页没有待办列表可挂；dot 用 `ready`——现有枚举是 `ready/sent/draft`，没有 `warn`。
2. **`inboxAdd` 并发判重**：`computeFpGuard` 跨 await 重读列表后再做一次 urlKey/jdFp 命中检查——两个并发同页收入只会落 1 条。
3. **worker 回写不复活状态**：`inboxDrain` 在 `evalJdCore` 返回后重读条目，status 已不是 `running`（如评估中被 dismiss）时只补记 `evalId/score/verdict`，不改 status。
4. **`importSavedPage` 去重文案按命中条状态分流**：`dismissed` → 「这个岗位之前标记过不考虑（M 月 D 日收入）」；`drafted` → 「这个岗位已建过草稿」+ `/edit?id=` 链接（`VALID_ID` 校验 + escAttr）；其他 → 「已在收件箱（M 月 D 日收入）· 共 N 条待评估」。
5. **`/inbox/status` 字段 = `{id,status,score,verdict,error,draftId}`**：不含 `evalId`——评估关联从 `inbox.json` 读，页面锚点链接由 `/inbox` 服务端渲染给出。
