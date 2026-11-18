# 模拟面试 · 路由规范（interview.mjs / interview-panel.js 接线说明）

形状复刻自 `upcv-features-implementation.md` §6（只复刻形状，不调用其接口）。
本文档列出全部端点、请求/响应形状，以及 server.mjs 需要的 import 与注册行。
约束：server.mjs 未被本次改动；以下注册代码需人工接入（见「待接点」）。

## 端点总览

| 方法 | 路径 | 说明 | 调 AI |
|---|---|---|---|
| GET | `/interview` | 页面（HTML） | 否 |
| GET | `/interview-panel.js` | 前端脚本（静态） | 否 |
| GET | `/interview/config` | UPCV 形状的配置 `{enabled,voices,interviewTypes,questionCap}` | 否 |
| GET | `/interview/banks?preview=&page=&limit=` | 题库橱窗（UPCV `/api/question-banks` 形状） | 否 |
| GET | `/interview/banks/:slug` | 单题库详情（previewQuestions=全量题目） | 否 |
| GET | `/interview/sessions` | 会话摘要列表（最新在前） | 否 |
| GET | `/interview/session?id=` | 单会话全量视图 | 否 |
| POST | `/interview/sessions` | 创建会话（可带 `bankSlug`） | 否 |
| POST | `/interview/sessions/delete` | 删除会话 | 否 |
| POST | `/interview/next` | 取下一题（幂等；题库题不调 AI，题尽后 AI 续出） | 部分 |
| POST | `/interview/answer` | 提交回答 或 跳过（`skip:true`） | 否 |
| POST | `/interview/hint` | 生成答题要点；`stream:true` → `text/event-stream` | 是 |
| POST | `/interview/report` | 生成/重生成复盘报告；`stream:true` → `text/event-stream` | 是 |

错误统一 `{ok:false, error:"中文原因"}`；HTTP 码：400 参数 / 404 不存在 / 409 状态冲突或未配模型 / 429 池满 / 502 模型失败。

## server.mjs 需要的改动（人工接入）

### ① import（挂在现有 import 块尾部，第 42 行 practice import 之后即可）

```js
import { getConfig as getInterviewConfig, listSessions as ivListSessions, getSession as ivGetSession,
  createSession as ivCreateSession, deleteSession as ivDeleteSession, nextQuestion as ivNextQuestion,
  submitAnswer as ivSubmitAnswer, skipQuestion as ivSkipQuestion, genHint as ivGenHint,
  genReport as ivGenReport, genHintStream as ivGenHintStream, genReportStream as ivGenReportStream,
  listBanks as ivListBanks, getBank as ivGetBank,
  NO_MODEL_HINT as IV_NO_MODEL_HINT } from './interview.mjs';   // 模拟面试（文字版）：题库橱窗 + 会话机 + AI 出题/提示/报告（hint/report 可流式），持久化 interviews.json
```

### ② 静态资源行（与 ai-panel.js 等并列，约第 4766 行后）

```js
    if (req.method === 'GET' && url.pathname === '/interview-panel.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'interview-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
```

### ③ 路由注册（插在 `send(404, 'not found', 'text/plain')` 之前，约第 9187 行前）

AI 路由按 practice.mjs 同口径自行借槽：`hasLLM` 拦截 → `aiPool.borrow()` → 透传 `{lease}` → finally 释放。
（`/interview/*` 不在 gatePool 白名单内；如想把 `/^\/interview\//` 加进 gatePool 的 POST 判定亦可，
则路由内可改用 `leaseOf(req)` 而免去手动 borrow——二选一，不要双占。）

```js
    // ===== 模拟面试（文字版，UPCV §6 形状复刻）=====
    if (req.method === 'GET' && url.pathname === '/interview') {
      const meta = loadMeta();
      const boot = {
        hasLLM: hasLLM(root),
        config: getInterviewConfig(),
        jobs: loadApps().map((a) => ({ id: a.id, company: a.company || '', role: a.role || '',
          label: ((a.company || '') + '·' + (a.role || '')).replace(/^·|·$/g, '') || a.id })),
        resumes: docIdsOnDisk().map((did) => ({ id: did, title: (docInfo(did, meta[did]) || {}).title || did }))
          .filter((r) => !((meta[r.id] || {}).archivedAt)),
        sessions: ivListSessions(),
      };
      const inner = `<div class="page-head"><h1>模拟面试</h1><span class="page-meta">文字版 · 本地会话</span></div>
        <div id="ivApp"><div class="card" style="color:var(--mut)">加载中…</div></div>
        <script nonce="__CSP_NONCE__">window.__INTERVIEW__=${jsonScript(boot)};</script>
        <script src="/interview-panel.js"></script>`;
      return send(200, page('模拟面试', inner, 'apps'));
    }
    if (req.method === 'GET' && url.pathname === '/interview/config') {
      return sendJson(200, { ok: true, ...getInterviewConfig() });
    }
    if (req.method === 'GET' && url.pathname === '/interview/sessions') {
      return sendJson(200, { ok: true, sessions: ivListSessions() });
    }
    if (req.method === 'GET' && url.pathname === '/interview/session') {
      const s = ivGetSession(String(url.searchParams.get('id') || ''));
      if (!s) return sendJson(404, { ok: false, error: '面试会话不存在' });
      return sendJson(200, { ok: true, session: s });
    }
    if (req.method === 'GET' && url.pathname === '/interview/banks') {
      return sendJson(200, ivListBanks({ preview: url.searchParams.get('preview'),
        page: url.searchParams.get('page'), limit: url.searchParams.get('limit') }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/interview/banks/')) {
      const r = ivGetBank(decodeURIComponent(url.pathname.slice('/interview/banks/'.length)));
      if (!r.ok) return sendJson(r.status || 404, { ok: false, error: r.error });
      return sendJson(200, r);
    }
    if (req.method === 'POST' && url.pathname === '/interview/sessions') {
      const body = await readBodyAuto(req);
      const r = ivCreateSession({ voice: body.voice, type: body.type, jobRef: body.jobRef, resumeId: body.resumeId, bankSlug: body.bankSlug });
      if (!r.ok) return sendJson(r.status || 400, { ok: false, error: r.error });
      return sendJson(200, { ok: true, session: r.session });
    }
    if (req.method === 'POST' && url.pathname === '/interview/sessions/delete') {
      const body = await readBodyAuto(req);
      const r = ivDeleteSession(String(body.id || ''));
      if (!r.ok) return sendJson(r.status || 400, { ok: false, error: r.error });
      return sendJson(200, { ok: true });
    }
    // 出题/提示/报告：借 AI 槽 → 透传 lease → finally 释放（practice 反馈路由同款）。
    const ivCall = async (fn) => {
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: IV_NO_MODEL_HINT });
      let lease;
      try { lease = aiPool.borrow(); }
      catch (e) { return sendJson((e && e.httpCode) || 429, { ok: false, error: (e && e.message) || 'AI 排队已满，请稍候' }); }
      try {
        const r = await fn(lease);
        if (!r.ok) return sendJson(r.status || 400, { ok: false, error: r.error });
        return sendJson(200, r);
      } finally { try { lease.release(); } catch {} }
    };
    if (req.method === 'POST' && url.pathname === '/interview/next') {
      const body = await readBodyAuto(req);
      const s = ivGetSession(String(body.id || ''));
      if (!s) return sendJson(404, { ok: false, error: '面试会话不存在' });
      return ivCall((lease) => ivNextQuestion(s, { lease }));
    }
    if (req.method === 'POST' && url.pathname === '/interview/answer') {
      const body = await readBodyAuto(req);
      const r = body.skip === true ? ivSkipQuestion(String(body.id || '')) : ivSubmitAnswer(String(body.id || ''), body.answer);
      if (!r.ok) return sendJson(r.status || 400, { ok: false, error: r.error });
      return sendJson(200, r);
    }
    // 流式泵（UPCV */stream 复刻）：生成器首帧即 error → 回 JSON（不发 SSE 头）；
    // 否则 200 + text/event-stream，逐帧 event: delta|done|error + data: JSON。
    // 断连：res 'close' → it.return() → 内层 streamChatMsgs finally 释放其占用 → 外层 finally 放 lease。
    const ivStream = async (makeGen) => {
      if (!hasLLM(root)) return sendJson(409, { ok: false, error: IV_NO_MODEL_HINT });
      let lease;
      try { lease = aiPool.borrow(); }
      catch (e) { return sendJson((e && e.httpCode) || 429, { ok: false, error: (e && e.message) || 'AI 排队已满，请稍候' }); }
      let it;
      try { it = makeGen(lease); } catch (e) { try { lease.release(); } catch {} throw e; }
      const first = await it.next();
      if (first.done || (first.value && first.value.type === 'error')) {
        try { await it.return(); } catch {}
        try { lease.release(); } catch {}
        const v = first.value;
        return sendJson((v && v.status) || 500, { ok: false, error: (v && v.error) || '生成失败' });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      let stopped = false;
      res.on('close', () => { if (!stopped) { stopped = true; try { it.return(); } catch {} } });
      const frameOf = (fr) => {
        const { type, ...rest } = fr;
        const d = type === 'delta' ? { text: fr.text }
          : type === 'done' ? { ok: true, ...rest }
          : rest;   // error → {status,error}
        return `event: ${type}\ndata: ${JSON.stringify(d)}\n\n`;
      };
      try {
        res.write(frameOf(first.value));
        for (;;) {
          const n = await it.next();
          if (n.done) break;
          res.write(frameOf(n.value));
          if (n.value.type === 'error' || n.value.type === 'done') break;
        }
      } catch (e) {
        try { res.write(`event: error\ndata: ${JSON.stringify({ status: 502, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) })}\n\n`); } catch {}
      }
      stopped = true;
      try { res.end(); } catch {}
      try { await it.return(); } catch {}
      try { lease.release(); } catch {}
    };
    if (req.method === 'POST' && url.pathname === '/interview/hint') {
      const body = await readBodyAuto(req);
      if (!Number.isInteger(body.index) || body.index < 0) return sendJson(400, { ok: false, error: 'index 必须是非负整数' });
      if (body.stream === true) return ivStream((lease) => ivGenHintStream(String(body.id || ''), body.index, { lease }));
      return ivCall((lease) => ivGenHint(String(body.id || ''), body.index, { lease }));
    }
    if (req.method === 'POST' && url.pathname === '/interview/report') {
      const body = await readBodyAuto(req);
      if (body.stream === true) return ivStream((lease) => ivGenReportStream(String(body.id || ''), { lease }));
      return ivCall((lease) => ivGenReport(String(body.id || ''), { lease }));
    }
```

## 请求 / 响应形状

### `GET /interview/banks?preview=2&page=1&limit=12`
题库橱窗（UPCV `GET /api/question-banks` 形状复刻；数据=interview.mjs 内置种子，非持久化）。
响应 `{ok:true, data:[<BankCard>], total, page, limit}`；featured 卡排最前。
```json
{ "id":1,"slug":"frontend-engineer","type":"POSITION","title":"前端工程师",
  "category":"TECH","intro":"…","questionCount":8,"isFeatured":true,"banner":null,
  "previewQuestions":[{"question":"…","answerPoints":["…"]}],"updatedAt":"ISO" }
```
- `preview=N`：每卡返回前 N 条预览题（含 answerPoints）；`preview=0` 只回卡片元信息。
- `banner` 恒 `null`（无 OSS 图）：前端用 slug 哈希派生占位色块。

### `GET /interview/banks/:slug`
详情态：同 BankCard，`previewQuestions` 返回**全量**题目（含 answerPoints）。
404：slug 不在内置题库。

### `POST /interview/sessions`
请求 `{type:"comprehensive"|"professional"|"hr", voice?:"zh-female"|"zh-male"|"en-female"|"en-male", jobRef?:"<applications.id>", resumeId?:"<docId>", bankSlug?:"<bank.slug>"}`。
`jobRef`/`resumeId`/`bankSlug` 至少给一个（题库题是内容数据，单选题库即可开场）。
jobRef 存在即在创建时快照 `company/role/jd` 进会话；resumeId 存 id、文本每次现读；
bankSlug 存在即快照 `questionSource="bank" + bankSlug + bankTitle`。
响应 `{ok:true, session:<SessionView>}`；400 类型无效/都没给，404 职位、简历或题库不存在。

### `GET /interview/session?id=iv-xxxxxxxx`
`SessionView` = 存储行 + 派生字段：
```json
{ "id":"iv-…","createdAt":"ISO","updatedAt":"ISO","voice":"zh-female","type":"professional",
  "jobRef":"","company":"…","role":"…","jd":"…","resumeId":"…","resumeTitle":"…",
  "questionSource":"ai|bank","bankSlug":"","bankTitle":"",
  "questionCap":14,
  "questions":[{"index":0,"text":"…","askedAt":"ISO","status":"pending|answered|skipped","source":"bank|ai"}],
  "answers":{"0":{"text":"…","at":"ISO"}}, "hints":{"0":{"points":["…"],"at":"ISO"}},
  "report":null|"Report",
  "pending":{"index":0,"question":"…"}|null, "answeredCount":0, "skippedCount":0,
  "finished":false, "hasReport":false }
```

### `POST /interview/next`  `{id}`
- `{ok:true,index,question,pending:true}`：还有未答的当前题，原样返回（幂等，不重复扣费）。
- `{ok:true,index,question}`：新出了一题（已落账）。
  - `questionSource="bank"` 的会话：`questions.length` 未越过题库题数时**直接取题库第 index 题**，不调模型、无需已配 LLM；
    题库题用尽（或种子被删失配）→ 落回 AI 续出到 `questionCap=14`，此后走正常 AI 路径（需已配模型）。
- `{ok:true,done:true,cap:14}`：已满 14 题。
- 409 未配模型（仅 AI 出题路径）/ 429 池满 / 502 模型失败或输出不可解析。

### `POST /interview/answer`  `{id, answer:"…"}` 或 `{id, skip:true}`
作答落在当前 pending 题（重交=最近一次为准，≤4000 字）；skip 记 skipped。
响应 `{ok:true,index}`；400 空答/超长，409 无 pending 题。

### `POST /interview/hint`  `{id, index}` / `{id, index, stream:true}`
- 非流式：`{ok:true,index,points:["…"]}`（3~6 条，存 `hints[index]`，重生成覆盖）。
- `stream:true` → `200 text/event-stream`（协议见下「流式规范」）。
  - 模型输出协议为**纯文本逐行要点**（非 JSON）：delta 帧文本可直接增量渲染；
    服务端仍解析为 `points[]` 落 `hints[index]`，done 帧下发解析后数组。

### `POST /interview/report`  `{id}` / `{id, stream:true}`
- 非流式：`{ok:true,report:{strengths:["…"],gaps:["…"],advice:["…"],at:"ISO",model:"…"|null,usage:{…}|null}}`。
- `stream:true` → `200 text/event-stream`；delta 帧是 JSON 原文增量（前端增量显示作诚实进度），
  done 帧携带解析+落盘后的 `report` 对象（此时才渲染三列）。
- 409：answeredCount<1（零作答不生成）。

### 流式规范（hint/report 共用）
请求体加 `stream:true` 即走 SSE；未加则走原 JSON 路径（两种响应互不混用）。
- **前置校验失败**（404 会话/题目不存在、409 未配模型或零作答、429 池满）：直接回 `{ok:false,error}` JSON + 对应状态码，**不发 SSE 头**。
- **进入流式**（200 + `text/event-stream; charset=utf-8`）后每帧：

| event | data 载荷 | 说明 |
|---|---|---|
| `delta` | `{"text":"…"}` | 模型正文增量；前端逐帧拼接渲染 |
| `done` | `{ok:true,index,points}`（hint）/ `{ok:true,report:{…}}`（report） | 终态：已解析+已落账 |
| `error` | `{status,error}` | 流中错误（502 模型失败/解析失败、404 会话被删） |

- 无 `done` 帧即断流 = 失败：前端按「流式生成中断」报错；服务端不落半成品。
- **断连释放**：`res 'close'` → `it.return()` → 内层 streamChatMsgs `finally` 解占/释放 AI 槽（与 chatMsgs 同口径），随后外层 `finally` 放路由持有的 lease。
- 前端（interview-panel.js）按 `Content-Type` 自适应：不是 `text/event-stream` 就当 JSON 整段处理——未接入流式注册码的服务端上功能不降级。

## 页面组装方式
inner 拼好后 `page('模拟面试', inner, 'apps')`（第三参=顶栏高亮键，暂归「投递」；如加顶栏项
`nav('interview','/interview','面试','…')` 可改为 `'interview'`）。页内两块脚本：
`window.__INTERVIEW__` 启动数据走 `nonce="__CSP_NONCE__"` 内联块（`jsonScript()` 转义）；
`interview-panel.js` 走 `<script src>`（CSP `script-src 'self'` 放行，无需 nonce）。

## 待接点
1. 上述 ①②③ 三段接入 server.mjs（import、静态行、路由块）。本次新增：import 行换为含 `ivListBanks/ivGetBank/ivGenHintStream/ivGenReportStream` 的版本；路由块内 `/interview/sessions` 的 `ivCreateSession` 调用加 `bankSlug` 透传，并在其前加两条 banks GET；hint/report 处理器换为带 `ivStream` 泵的版本。
2. 可选：顶栏/投递页签加入口；gatePool 是否纳管 `/interview/*`（见 ③ 注释，二选一）。
3. `interviews.json` 已建议加入备份/恢复清单（RESTORE_MANAGED_FILES 目前不含它——按需要补）。
4. 前端会话列表、报告刷新均依赖上面端点形状；改形状需同步改 interview-panel.js。
5. 题库为内置种子（interview.mjs `QUESTION_BANKS`）：增删题库/题目 = 改代码重启生效；无外部服务、无题库持久化。
