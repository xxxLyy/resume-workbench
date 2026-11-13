# JD 收件箱 + 批量评估 实施计划 — 2026-11-13

> 设计：`dev-docs/2026-11-13-jd-inbox-batch-eval-design.md`（下称 spec）。本计划按 spec 章节号引用，不重复设计理由。
> 执行方式：逐任务 TDD——先写/扩断言 → 跑红 → 实现 → 跑绿 → 提交（直接提交 `main`）。

**Goal**：点书签把岗位收进收件箱；收件箱勾选后在后台串行批量评估，按分数排序后逐条建草稿。

**Architecture**：全部落在 `server.mjs`（项目惯例：单文件原生 HTTP 服务）。新数据 `inbox.json` 走现有 `readJson/writeJson`。批量评估 = 进程内单例串行 worker，复用从 `/eval/create` 抽出的 `evalJdCore`。

**Tech Stack**：Node.js ESM 原生 `http`，零新依赖；测试 = 隔离 `RESUME_ROOT` + 随机端口 + 本地 OpenAI 兼容桩（同 `test-fixtures/reliability/test-eval-promote-brief.mjs` 手法）。

**纪律（每个任务都适用）**
- 不新增 npm 依赖。不改注释以外的无关代码；不删既有注释。
- 新路由必须同步 `test-structure.sh` 路由冻结数组（约 2214–2222 行），登记说明行末尾追加一句「2026-11-13 收件箱登记 /inbox、/inbox/status、/inbox/eval、/inbox/dismiss、/inbox/draft（spec dev-docs/2026-11-13-jd-inbox-batch-eval-design.md，登记非放宽）」。
- 所有外部文本输出走 `escHtml/escAttr`；页面内联脚本必须带 nonce（照 `page()` 现有脚本位写法）。
- 每个任务的验证命令 = 该任务列出的测试文件 + `bash test-structure.sh`（含路由冻结）。全量 `bash test.sh` 只在 T7 跑一次。
- `test-structure.sh` / `test.sh` 中唯一的 `❌ Chromium 选择 — 无缓存` 是既有预期输出，不算失败；以 `EXIT=0` 为准。

---

## T1 extractJd 薪资 + 导入口令 + 书签带 `k`（spec §2.1 §2.2 §2.4）

**Files**：`server.mjs`（`extractJd` ≈253、`BOOKMARKLET_JS`/`bookmarkletHref` ≈2456、文件头 import）、`.gitignore`、`test-fixtures/reliability/test-import-page.mjs`

1. 先扩测试 `test-import-page.mjs`：
   - zhipin 夹具：`extractJd` 结果（经 POST 预览页或直接导入函数——沿用该文件现有取值方式）含薪资 `job_salary` 的值。夹具里没有 `job_salary` 就在 `_jobInfo` 块里补一个，例如 `job_salary: '20-35K·14薪'`。
   - JSON-LD 夹具：`baseSalary: { "@type":"MonetaryAmount", currency:"CNY", value:{ minValue:20000, maxValue:30000, unitText:"MONTH" } }` → `salary === '20000-30000 MONTH'`；`baseSalary: "面议"` → `'面议'`。
   - `GET /job/new` 中书签 href 含 `h.name='k'` 字样且口令值 `/[0-9a-f]{32}/`；隔离根下生成了 `.import-token`，权限 `0o600`；两次 GET 口令相同。
   - 跑红。
2. 实现：
   - `extractJd` 返回 `{ company, role, jd, via, salary }`。zhipin 分支 `salary = field('job_salary')`（删掉「当前不落字段」那句注释的过时部分，改为「落 salary 字段，spec 2026-11-13 §2.4」）。JSON-LD 分支：
     ```js
     const bs = jp.baseSalary;
     if (!salary && bs) salary = typeof bs === 'string' ? htmlToText(bs)
       : (() => { const v = bs.value || bs; const lo = v.minValue ?? v.value ?? '', hi = v.maxValue ?? ''; return [hi !== '' ? `${lo}-${hi}` : String(lo), v.unitText || ''].filter(Boolean).join(' ').trim(); })();
     ```
   - 口令：
     ```js
     let importTokenCache = '';
     function importToken() {
       if (importTokenCache) return importTokenCache;
       const f = path.join(root, '.import-token');
       let t = '';
       try { t = fs.readFileSync(f, 'utf8').trim(); } catch {}
       if (!/^[0-9a-f]{32}$/.test(t)) { t = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(f, t, { mode: 0o600 }); }
       return (importTokenCache = t);
     }
     function importTokenOk(k) {
       const a = Buffer.from(String(k || '')), b = Buffer.from(importToken());
       return a.length === b.length && crypto.timingSafeEqual(a, b);
     }
     ```
     `crypto` 若未导入则 `import crypto from 'node:crypto'`（先 `rg -n "node:crypto" server.mjs` 确认）。
   - `BOOKMARKLET_JS` 在 `title` 字段之后、`appendChild(f)` 之前加：`var k=document.createElement('input');k.name='k';k.value='__TOKEN__';f.appendChild(k);`。`bookmarkletHref()` 追加 `.replace('__TOKEN__', importToken())`。
   - `.gitignore` 加 `.import-token` 与 `inbox.json`（放在 `evaluations.json` 下一行）。
3. 跑绿：`node test-fixtures/reliability/test-import-page.mjs && bash test-structure.sh`。
4. 提交：`feat(jd): extractJd 取薪资，书签带本机导入口令`。

## T2 收件箱数据 + `/import/page` 分叉 + 「已收入」页（spec §2.3 §2.5）

**Files**：`server.mjs`（`JSON_FILES` ≈154、`loadEvals` 旁 ≈194、`importPreviewPage` 旁 ≈2462、POST `/import/page` ≈4705）、新建 `test-fixtures/reliability/test-inbox.mjs`、`test-structure.sh`（在 `test-import-page.mjs` 那一行后注册 `node ./test-fixtures/reliability/test-inbox.mjs`，带同格式的注释头）

1. 新建 `test-inbox.mjs`，骨架复制 `test-eval-promote-brief.mjs` 的隔离根 / 母版合成 / 随机端口 / spawn server / stub LLM 部分。本任务先写以下断言（跑红）：
   - 从 `GET /job/new` 的书签 href 里解析出口令 `k`（正则 `k.value='([0-9a-f]{32})'`）。
   - 用户态 POST（urlencoded，带 `Origin: https://www.zhipin.com`）`/import/page`，字段 `html`(含 `_jobInfo` + `.job-sec-text` ≥50 字的 zhipin 夹具)、`url=https://www.zhipin.com/job_detail/abc.html?lid=1`、`title`、`k`：
     - 200，页面含「已收入收件箱」「共 1 条」；不含「提取通道」。
     - `inbox.json` 1 条：`status==='new'`、`urlKey==='https://www.zhipin.com/job_detail/abc.html'`、`salary` 非空、`jdFp` 非空；文件权限 `0o600`。
     - 响应头无 `access-control-allow-origin`。
   - 同 html、`url=...abc.html?lid=2` → 页面含「已在收件箱」，仍 1 条。
   - 同 html、`url=https://www.zhipin.com/job_detail/xyz.html` → jdFp 相同 → 「已在收件箱」，仍 1 条。
   - 不带 `k` / `k` 错 → 页面是旧预览（含「提取结果」）且含「重新拖一次」；`inbox.json` 不变。
   - 在隔离根写 `.migrate.lock`（内容照 `rootLock` 新鲜锁格式——先读 `restore-guard.mjs`/`rootLock` 实现确认格式，或调用其导出的加锁函数）→ 带 `k` POST → 页面含「维护中，本次未收入」，`inbox.json` 不变；删锁。
2. 实现：
   - `JSON_FILES.inbox = 'inbox.json'`；`const loadInbox = () => { const a = readJson('inbox', []); return Array.isArray(a) ? a : []; }`；`const saveInbox = (list) => writeJson('inbox', list);`。
   - `const inboxUrlKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return ''; } };`
   - `async function inboxAdd({ url, title, company, role, salary, jd })` → `{ added: true, item, total }` 或 `{ added: false, item: <命中旧条>, total }`：
     - `jd = jd.slice(0, JD_MAX_CHARS)`；`jdFp = fingerprintText(jd)`（动态 import 同 `computeFpGuard`）。
     - 判重：`list.find((x) => (urlKey && x.urlKey === urlKey) || (jdFp && x.jdFp === jdFp))`，`dismissed` 条目也参与判重。
     - 新条：spec §2.5 全字段；`id = 'ib-' + timestamp()`，若已存在则追加 `-` + 递增数字。
     - 新增后 `const { dupHints } = await computeFpGuard(jd, url, company, loadMeta())`；**跨 await 后重新 `loadInbox()`** 再 unshift 写盘（不复用 await 前的列表）。
     - `total` = 非 `dismissed` 且 `status==='new'` 的条数。
   - `importSavedPage({ added, item, total, srcUrl })`：按 spec §2.3「已收入页」。「现在就定制」表单与 `importPreviewPage` 的 `bringForm` 完全一致——把那段表单抽成 `bringFormHtml({ jd, company, role, srcUrl })` 两页共用（`importPreviewPage` 行为不变）。自动关闭脚本：
     ```html
     <script nonce="${nonce}">(function(){var t=setTimeout(function(){window.close();},2000);['pointerdown','keydown','focusin'].forEach(function(e){document.addEventListener(e,function(){clearTimeout(t);},{once:true});});})();</script>
     ```
     （nonce 取法照 `page()` 现有内联脚本；若 `page()` 只支持固定脚本位，就照 `jobNewPage` 带脚本的写法。）
   - POST `/import/page`：解析出 `k`；`if (!importTokenOk(k))` → `importPreviewPage({..., legacy: true})`（`importPreviewPage` 增加可选 `legacy`，为真时顶部加一句「这是旧书签，不会存进收件箱。到 <a href="/job/new">定制页</a> 重新拖一次书签。」）；`else if (rootLock.isHeld(root))` → `importPreviewPage({..., notice: '维护中，本次未收入'})`；否则 `inboxAdd` → `importSavedPage`。`mutating` 判定处的 `/import/page` 豁免注释补一句：「2026-11-13 起带口令时会写 inbox.json：写授权由口令承担，迁移锁在处理函数内显式检查。」
3. 跑绿：`node test-fixtures/reliability/test-inbox.mjs && node test-fixtures/reliability/test-import-page.mjs && bash test-structure.sh`。
4. 提交：`feat(jd): 书签带口令时收进收件箱，按链接/JD 指纹去重`。

## T3 抽 `evalJdCore` / `promoteEval`（纯重构，spec §2.6 §2.7）

**Files**：`server.mjs`（POST `/eval/create` ≈4730、POST `/eval/promote` ≈4764）

1. `async function evalJdCore(root, { from, jd, company, role, lease })`：搬 `/eval/create` 从 `VALID_ID` 校验到 `saveEvals` 的全部逻辑；把每个 `return sendJson(code, { ok:false, error, ...extra })` 改为 `return { ok: false, status: code, error, ...extra }`；成功 `return { ok: true, rec }`。`hasLLM` 409（含 `settingsPath`）也搬进来。路由体变为：读 body → `evalJdCore(root, { ...body, lease: leaseOf(req) })` → 失败 `sendJson(r.status, { ok:false, error:r.error, ...(r.settingsPath ? { settingsPath: r.settingsPath } : {}) })`，成功 `sendJson(200, { ok:true, eval: evalRecordView(r.rec) })`。
2. `async function promoteEval(root, evalId, from)`：同理搬 `/eval/promote` 全部逻辑，返回 `{ ok:true, id }` 或 `{ ok:false, status, body }`（body 原样给 `sendJson`，保留 `existing` 字段）。
3. 验证（契约零变化，不改测试）：`node test-fixtures/reliability/test-eval-promote-brief.mjs && node test-fixtures/reliability/test-ai-routes-error.mjs && node test-fixtures/reliability/test-job-new-page.mjs && bash test-structure.sh`。另 `rg -l "eval/create|eval/promote" test-fixtures` 列出的其余非浏览器夹具也逐个跑。
4. 提交：`refactor(eval): 抽出 evalJdCore/promoteEval 供收件箱复用`。

## T4 串行评估 worker + `/inbox/eval` `/inbox/status` + 重启恢复（spec §2.6 §2.7）

**Files**：`server.mjs`、`test-fixtures/reliability/test-inbox.mjs`、`test-structure.sh`（路由冻结）

1. 扩测试（跑红）。stub 改造：评估请求到达时 `inflight++`、记录 `peak = max(peak, inflight)`，延迟 300ms 再回复后 `inflight--`；控制文件 `llm-eval-fail-once` 存在时对**第一个**评估请求回 HTTP 500 并删除该文件。stub 暴露 `GET /__peak` 返回 `{peak, count}`（或测试进程内直接读变量——stub 在测试进程里，直接读即可）。
   - 先收入 3 条不同 JD（T2 的 POST 手法，各自不同 url 与 JD 文本）。
   - `POST /inbox/eval` `{ ids:[3 个], from:'doc1' }`（JSON + 同源 Origin，照该夹具现有写请求头）→ `{ ok:true, queued:3 }`。
   - 轮询 `GET /inbox/status`（每 200ms，上限 20s）直到 3 条都 `scored`；断言 `peak === 1`；`evaluations.json` 3 条；每条 inbox 记录 `evalId` 指向对应评估、`score` 为数字。
   - 失败重试：建 `llm-eval-fail-once` → 收入第 4 条并 `/inbox/eval` → 终态 `error` 且 `error` 非空 → 再 `/inbox/eval` 同 id → `scored`。
   - 跳过规则：对 `scored` 条目 `/inbox/eval` → 计入 queued（允许重评）；对不存在 id → 不计入。
   - 重启恢复：停服务；直接改 `inbox.json` 把一条设为 `running`、`score:null`；重启服务 → 轮询到该条 `scored`。
   - 未配置模型：另起一个无 `config.json` 的隔离根（或临时移走 config 后重启）→ `/inbox/eval` 409 且含 `settingsPath`。
2. 实现：
   ```js
   // 收件箱批量评估：进程内单例串行 worker——一次只占 1 个 AI 槽，另一个留给交互操作（spec §2.6）
   const inboxWorker = { running: false };
   function inboxPatch(id, patch) {
     const list = loadInbox();
     const it = list.find((x) => x && x.id === id);
     if (!it) return null;
     Object.assign(it, patch, { updatedAt: new Date().toISOString() });
     saveInbox(list);
     return it;
   }
   async function inboxDrain() {
     if (inboxWorker.running) return;
     inboxWorker.running = true;
     try {
       for (;;) {
         const next = loadInbox().filter((x) => x && x.status === 'queued').sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
         if (!next) break;
         let lease;
         try { lease = aiPool.borrow(); }
         catch (e) { if (e instanceof ResourceBusy) { await new Promise((r) => setTimeout(r, 3000)); continue; } throw e; }
         try {
           inboxPatch(next.id, { status: 'running', error: null });
           const r = await evalJdCore(root, { from: next.from, jd: next.jd, company: next.company, role: next.role, lease });
           inboxPatch(next.id, r.ok
             ? { status: 'scored', evalId: r.rec.id, score: r.rec.score, verdict: r.rec.verdict, error: null }
             : { status: 'error', error: r.error });
         } catch (e) {
           inboxPatch(next.id, { status: 'error', error: '评估异常：' + String((e && e.message) || e).slice(0, 200) });
         } finally { try { lease.release(); } catch {} }
       }
     } finally { inboxWorker.running = false; }
   }
   ```
   - `POST /inbox/eval`：`hasLLM` 否 → 409 `{ ok:false, error:'未配置大模型：请先完成模型配置', settingsPath:'/settings' }`；`from` 过 `VALID_ID` 且文档在盘，否则 400/404（文案同 `/eval/create`）；对 `ids` 中 `status ∈ {new, error, scored}` 的条目一次性 `loadInbox` → 置 `queued`、`from`、`error:null`、`updatedAt` → `saveInbox`；`inboxDrain()` 不 await（`.catch((e) => console.error('[inbox] worker', e))`）；回 `{ ok:true, queued:n }`。
   - `GET /inbox/status`：`{ ok:true, items: loadInbox().filter((x) => x.status !== 'dismissed').map(({ id, status, score, verdict, error, draftId }) => ({ id, status, score, verdict, error, draftId })) }`。
   - 启动恢复：在 `tryListen(0)` 调用之前（或 listen 回调里，二选一后写注释说明原因）执行：`running` → `queued`（有则 `saveInbox`）；存在 `queued` 则 `inboxDrain()`。
   - 闸门：确认 `/inbox/eval` 不进 line 547 附近的 AI 闸门判定（它不在请求内调模型；worker 自己 `borrow`）。若闸门表是白名单则无需改动——实施时读那段代码确认，并在报告中说明。
3. 跑绿：`node test-fixtures/reliability/test-inbox.mjs && bash test-structure.sh`。
4. 提交：`feat(jd): 收件箱批量评估（后台串行，占 1 个 AI 槽）`。

## T5 `/inbox/draft` `/inbox/dismiss`（spec §2.7）

**Files**：`server.mjs`、`test-fixtures/reliability/test-inbox.mjs`、`test-structure.sh`

1. 扩测试（跑红）：
   - 已评估条目 `POST /inbox/draft {id}` → `{ ok:true, id }`；`GET /job/changes?id=<draftId>`（照 `test-eval-promote-brief.mjs` 取 brief 的方式）brief.focus 含评估 angle；inbox 条目 `drafted`、`draftId` 一致；对应评估记录 `promotedTo === draftId`。
   - 未评估条目 `POST /inbox/draft {id, from:'doc1'}` → 草稿建成；`docs-meta.json` 该草稿 `jdSource === '收件箱'`。
   - 对同一未评估条目的「同 JD 另一条」（手工往 inbox.json 插一条同 jd、不同 id、不同 urlKey）再 draft → `createJobDraft` 409 existing → 仍回 `{ ok:true, id: existing }`，条目 `drafted`。
   - `POST /inbox/dismiss {id}` → `{ ok:true }`；`/inbox/status` 不再含该 id；`inbox.json` 里该条 `status==='dismissed'` 仍在。
   - 不存在 id → 404。
2. 实现：
   - `POST /inbox/draft`：取条目（404）；`from = body.from || it.from`；`it.evalId` 存在且 `loadEvals()` 中该评估 `!promotedTo` → `promoteEval(root, it.evalId, from)`；否则 `createJobDraft(root, { from, company: it.company, role: it.role, jd: it.jd, jdLink: it.url, jdSource: '收件箱' })`。结果 `ok` 或（`status===409 && body.existing`）→ `inboxPatch(it.id, { status:'drafted', draftId })`，回 `{ ok:true, id: draftId }`；其他失败原样 `sendJson(r.status, r.body)`。
   - `POST /inbox/dismiss`：存在则 `inboxPatch(id, { status:'dismissed' })`。
3. 跑绿，提交：`feat(jd): 收件箱建草稿与不考虑`。

## T6 `/inbox` 页面 + 页签 + 评估锚点 + 首页待办 + 端口提示（spec §2.8 §2.9）

**Files**：`server.mjs`（`appTabs` ≈1947、首页待办 ≈2273–2356、`evalHistoryRows` ≈2172 及评估历史脚本 ≈2122、`jobNewPage`、`importHelpPage` ≈2501）、`test-fixtures/reliability/test-inbox.mjs`、`test-structure.sh`

1. 扩测试（HTTP 层断言 HTML，跑红）：
   - `GET /inbox` 200；含页签 `<a href="/inbox" class="on" aria-current="page">待筛选</a>`；`/applications` 页同一页签条也含 `/inbox`。
   - 收件箱有 scored 4 分、scored 2 分、new 各一条时，HTML 中三者出现顺序 = 4 分 → 2 分 → new。
   - 每行含复选框 `name="ib" value="<id>"`、薪资文本、「建草稿」「不考虑」；scored 行含 `href="/evals#<evalId>"`。
   - 空收件箱（隔离新根）→ 含「收件箱是空的」与书签 href。
   - 所有 `<script` 都带 `nonce=`。
   - `GET /evals` 每行含 `id="<evalId>"`。
   - 首页 `GET /`：有 `new` 条目时含「收件箱有 1 个岗位待评估」且链接 `/inbox`。
   - 端口提示：抽纯函数 `portNotice()`，条件 `!process.env.PORT && boundPort !== 7766`。测试夹具都用 `PORT=<随机端口>` 启动，所以 HTTP 层只断言**不显示**提示。显示分支用 `test-structure.sh` 源码断言兜底：`rg -F "书签要重新拖一次" server.mjs` 至少 1 处，且 `portNotice()` 在 `/job/new`、`/inbox`、`importHelpPage` 三处被调用。
2. 实现：
   - `appTabs` 数组首项加 `['inbox', '/inbox', '待筛选']`；`/inbox` 路由 `page('待筛选', ..., 'apps')`（active 参数照其他投递页写法）+ `appTabs('inbox')`。
   - 页面按 spec §2.8；轮询脚本：存在 `queued/running` 时 `setInterval` 3000ms 拉 `/inbox/status`，更新 `[data-ib="<id>"] .st` 与动作格；全部终态后 `clearInterval` 并 `location.reload()`（一次性重排）。批量评估按钮：收集勾选 `ib` → 写请求助手 POST `/inbox/eval` → 成功后 reload。建草稿 → POST `/inbox/draft` → `location.href = '/edit?id=' + d.id`。不考虑 → POST `/inbox/dismiss` → 移除该行。写请求一律用 `WRITE_HELPER_JS` 提供的助手（先读它的函数名与调用约定）。
   - 状态徽章用现有 `badge()`/`.badge ok|warn|err|mute|ai`：new=mute「待评估」、queued=mute「排队中」、running=ai「评估中」、scored=按 `verdict`（apply→ok、其余→warn）「X 分」、error=err「失败：<error 前 40 字>」、drafted=ok「已建稿」+ `/edit?id=` 链接。跨库提醒 `dupHints` 非空 → warn「做过/投过」，`title` 放 labels。
   - `evalHistoryRows` 行外层加 `id="${escAttr(rec.id)}"`；评估历史脚本加载时：`if (location.hash) { var el = document.getElementById(decodeURIComponent(location.hash.slice(1))); if (el) { <复用现有展开逻辑展开该行>; el.scrollIntoView({ block: 'center' }); } }`。
   - 首页待办：`todoItems` 构造处（状态 2 有投递分支，以及状态 1 若有待办位）加 `{ dot: 'warn', t: '收件箱有 N 个岗位待评估', act: '/inbox', actLabel: '去筛选' }`（dot 取值沿用现有枚举，先读确认）。若状态 0/1 首页没有待办列表，只在状态 2 加，并在报告中说明。
   - `portNotice()` 返回提示 HTML 或空串，插到三页顶部。
3. 浏览器点验（不进测试套件）：起服务，收入 3 条 → `/inbox` 勾选 → 批量评估（可用桩模型配置）→ 截图「评估中」与「排序后」两张；`/evals#<id>` 跳转后该条展开。截图存 `/tmp/inbox-*.png`，路径写进报告。
4. 跑绿：`node test-fixtures/reliability/test-inbox.mjs && node test-fixtures/reliability/test-import-page.mjs && bash test-structure.sh`；首页/投递页相关既有夹具（`rg -l "todo-list|apptabs" test-fixtures` 列出的非浏览器夹具）逐个跑。
5. 提交：`feat(jd): 收件箱页面、投递页签、首页待办与端口提示`。

## T7 收口：注册、文档、全量

**Files**：`test.sh`、`DESIGN.md`、`dev-docs/handoff.md`、`dev-docs/2026-11-13-jd-inbox-batch-eval-design.md`

1. `test.sh`：照「16q」段格式新增一段运行 `test-inbox.mjs`（如果 `test.sh` 已通过 `test-structure.sh` 间接覆盖则不重复，读结构后决定并在报告中说明）。
2. `DESIGN.md` 新增 §10.21「JD 收件箱 + 批量评估」：决策（收集+评估、不批量生成、书签口令、串行 1 槽、列表页抓取不做）+ 指向 spec/plan。§10.20 末尾加一句指向 §10.21。
3. `dev-docs/handoff.md`：更新当前状态与新路由。
4. spec 若实施中有偏差（例如首页待办只加在状态 2），在 spec 对应节加「实施注记」。
5. 全量：`bash test.sh; echo EXIT=$?`，要求 `EXIT=0`。
6. 提交：`docs(jd): 收件箱决策记录与交接`。
