# agent.routes.md — 「Agent 求职助手」路由规范

本文件给出把 `agent.mjs` / `agent-panel.js` 接入 `server.mjs` 的完整规范。
只涉及 **新增** 代码；不改动任何既有路由与文件。

## 0. 接入总览

```
server.mjs
├─ import 区：加一行 agent.mjs 导入 + 一行 init(root)
├─ 静态文件：GET /agent-panel.js（仿 /ai-panel.js 那条）
├─ 页面：    GET /agent            → page('求职助手', inner, 'apps')
├─ JSON API：/agent/sessions CRUD  → listSessions/createSession/getSession/renameSession/deleteSession
│           POST /agent/chat       → 非流式 agentChat / 流式 agentChatStream（§5：stream:1 或 Accept SSE）
│           GET  /agent/context-preview（可选，调试/前端预检）
└─ agent-panel.js 由页面 <script src="/agent-panel.js" defer> 加载
```

数据文件：`agent-sessions.json`（由 agent.mjs 自建自管，tmp+rename、0600、损坏停写，与 server.mjs JSON 层同口径）。
建议把 `agent-sessions.json` 加进 `.gitignore`（与 inbox.json 等数据文件同列；本文件未代改）。

## 1. server.mjs 修改点（新增行）

### 1.1 import 区（顶部既有 import 块末尾追加）

```js
import { init as agentInit, listSessions as agentListSessions, createSession as agentCreateSession, getSession as agentGetSession, renameSession as agentRenameSession, deleteSession as agentDeleteSession, chat as agentChat, chatStream as agentChatStream, previewContext as agentPreviewContext, AGENT_NO_LLM } from './agent.mjs';
```

`root` 声明之后（`const root = process.env.RESUME_ROOT || APP_ROOT;` 同一区域）加一次初始化：

```js
agentInit(root);   // Agent 数据根注入：agent.mjs 读写 root 下的 JSON/文档
```

### 1.2 静态文件路由（放在 `/ai-panel.js` 那条旁边，~L4753）

```js
    if (req.method === 'GET' && url.pathname === '/agent-panel.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'agent-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
```

### 1.3 页面路由 `GET /agent`（放在 `/inbox` 附近，应用页路由区内）

```js
    if (req.method === 'GET' && url.pathname === '/agent') {
      return send(200, page('求职助手', agentPageInner(), 'apps'));
    }
```

`agentPageInner()` —— 模块级小函数（与 `appTabs` 同级即可）：

```js
// Agent 页骨架：左会话列表 + 中对话流 + 底输入框全部由 agent-panel.js 在 #agent-app 内构建。
// 可选：inner 里再拼 `<script nonce="__CSP_NONCE__">${ICON_SCRIPT}</script>` 让面板拿到 __icon
// （不拼也能跑，agent-panel.js 已降级为空图标）。
const agentPageInner = () => `
    <div class="page-head"><h1>求职助手</h1></div>
    <div id="agent-app"></div>
    <script src="/agent-panel.js" defer></script>`;
```

说明：
- `page()` 第 3 参是 nav 高亮键；topnav 白名单只有 `docs`/`apps`/`settings` 三项。传 `'apps'`（求职归属投递线）；传 `'agent'` 则不高亮任何项。若要 topnav 加第四个「助手」入口，需同步改 `nav()` 调用处与 test-structure.sh 的导航断言（本次未动）。
- CSP：`/agent-panel.js` 走 `script-src 'self'` 正常加载；面板不内联脚本、不注脚本进 HTML，nonce 机制零冲突。
- `window.__status` 由 page() 的 STATUS_SCRIPT 提供，面板直接用；`window.__icon` 缺省降级。

### 1.4 会话 CRUD（应用页路由区）

```js
    // GET /agent/sessions → {ok:true, sessions:[{id,title,createdAt,updatedAt,messageCount,lastText}]}
    if (req.method === 'GET' && url.pathname === '/agent/sessions') {
      return sendJson(200, { ok: true, sessions: agentListSessions() });
    }
    // POST /agent/sessions {title?} → {ok:true, session:{id,title,createdAt,updatedAt,messages:[]}}
    if (req.method === 'POST' && url.pathname === '/agent/sessions') {
      const body = await readBodyAuto(req);
      return sendJson(200, { ok: true, session: agentCreateSession({ title: body.title }) });
    }
    // /agent/sessions/:id —— GET 详情 / PATCH 改名 / DELETE 删除
    const agSessM = url.pathname.match(/^\/agent\/sessions\/([a-z0-9-]{1,90})$/);
    if (agSessM) {
      const sid = agSessM[1];
      if (req.method === 'GET') {
        const s = agentGetSession(sid);
        return s ? sendJson(200, { ok: true, session: s }) : sendJson(404, { ok: false, error: '会话不存在' });
      }
      if (req.method === 'PATCH') {
        const body = await readBodyAuto(req);
        const s = agentRenameSession(sid, body.title);
        return s ? sendJson(200, { ok: true, session: s }) : sendJson(404, { ok: false, error: '会话不存在或标题为空' });
      }
      if (req.method === 'DELETE') {
        return agentDeleteSession(sid) ? sendJson(200, { ok: true }) : sendJson(404, { ok: false, error: '会话不存在' });
      }
    }
```

### 1.5 对话 `POST /agent/chat`（非流式 + SSE 流式同端点）

```js
    // 非流式 body {id, message} → {ok:true, reply, quickReplies:[{label,message,description?}], toolCards:[{type,payload}], sessionId}
    // 流式   body {id, message, stream:1} 或 Accept: text/event-stream → SSE（§5：data: <UIMessageChunk> 帧 + data: [DONE]）
    if (req.method === 'POST' && url.pathname === '/agent/chat') {
      if (!hasLLM(root)) return send(409, AGENT_NO_LLM, 'text/plain');   // 与 /ai/chat 同口径：路径直达
      const body = JSON.parse(await readBody(req));
      if (!body.id || !body.message || typeof body.message !== 'string') return send(400, 'id 和 message 必填', 'text/plain');
      const wantStream = !!body.stream || /text\/event-stream/.test(String(req.headers.accept || ''));
      // ── 非流式：原行为原样保留（渐进降级；无 stream 参数的调用方零改动）──
      if (!wantStream) {
        try {
          const r = await agentChat(String(body.id), body.message.slice(0, 8000), { lease: leaseOf(req) });
          return sendJson(200, { ok: true, ...r });
        } catch (e) {
          if (e && e.code === 'NO_SESSION') return sendJson(404, { ok: false, error: '会话不存在' });
          if (e && e.code === 'EMPTY') return sendJson(400, { ok: false, error: e.message });
          if (e && e.httpCode) return sendJson(e.httpCode, { ok: false, error: e.message });   // 含 CORRUPT 停写
          return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) });
        }
      }
      // ── SSE：先拉首帧再写头——校验类错误（会话不存在/空消息/CORRUPT）仍走 HTTP 状态码 ──
      const it = agentChatStream(String(body.id), body.message.slice(0, 8000), { lease: leaseOf(req) });
      let cur;
      try { cur = await it.next(); }
      catch (e) {
        if (e && e.code === 'NO_SESSION') return sendJson(404, { ok: false, error: '会话不存在' });
        if (e && e.code === 'EMPTY') return sendJson(400, { ok: false, error: e.message });
        if (e && e.httpCode) return sendJson(e.httpCode, { ok: false, error: e.message });
        return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) });
      }
      let closed = false;
      res.on('close', () => { closed = true; });   // 客户端断连 → 停写 + 下方 finally 关 generator
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'   // 反代存在时禁缓冲（本地直连无影响）
      });
      // 写一帧；回 false=客户端已走。背压经 write 回调自然等待，不需要额外 drain 处理。
      const sse = (obj) => new Promise((ok) => {
        if (closed || res.writableEnded || res.destroyed) return ok(false);
        res.write('data: ' + JSON.stringify(obj) + '\n\n', () => ok(!closed && !res.writableEnded));
      });
      try {
        while (!cur.done) {
          if (!await sse(cur.value)) break;   // 断连：停止拉取
          cur = await it.next();
        }
      } catch (e) {
        // 已进入流的模型错误 → 错误帧（HTTP 状态已发 200，只能帧内告知）
        await sse({ type: 'error', errorText: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) });
      } finally {
        try { await it.return(); } catch {}   // 关 generator → streamChatMsgs finally unclaim 租约（断连释放 AI 槽）
        if (!closed && !res.writableEnded) { try { res.write('data: [DONE]\n\n'); res.end(); } catch {} }
      }
      return;   // handler promise 至此才结束 → 入口 finally 归还闸门租约（RES-03 口径不变）
    }
```

要点：整段流式循环都在 handler 内 `await` —— `req.__resLease`（gatePool 已覆盖 `POST /agent/chat`）
在入口 `Promise.finally` 里统一归还，时机 = 流真正结束/断连清理完成，与非流式同一口径。

### 1.6 上下文预览 `GET /agent/context-preview`（可选）

```js
    // ?text=<含 [context:..] 的消息> → {ok:true, refs:[{type,id,data|null}]}
    if (req.method === 'GET' && url.pathname === '/agent/context-preview') {
      return sendJson(200, { ok: true, ...agentPreviewContext(String(url.searchParams.get('text') || '')) });
    }
```

## 2. 协议形状汇总

| 端点 | 方法 | 请求 | 响应 |
|---|---|---|---|
| `/agent` | GET | — | HTML 页（`page('求职助手', inner, 'apps')`） |
| `/agent-panel.js` | GET | — | classic script |
| `/agent/sessions` | GET | — | `{ok:true, sessions:[SessionMeta]}` |
| `/agent/sessions` | POST | `{title?}` | `{ok:true, session:Session}` |
| `/agent/sessions/:id` | GET | — | `{ok:true, session:Session(含 messages)}` / 404 |
| `/agent/sessions/:id` | PATCH | `{title}` | `{ok:true, session:SessionMeta}` / 404 |
| `/agent/sessions/:id` | DELETE | — | `{ok:true}` / 404 |
| `/agent/chat` | POST | `{id, message}` | `{ok:true, reply, quickReplies, toolCards, sessionId}` |
| `/agent/chat`（流式） | POST | `{id, message, stream:1}` 或 `Accept:text/event-stream` | `text/event-stream`：`data: <UIMessageChunk>` 帧 + `data: [DONE]`（§5） |
| `/agent/context-preview` | GET | `?text=` | `{ok:true, refs:[{type,id,data}]}` |

- `SessionMeta` = `{id, title, createdAt, updatedAt, messageCount, lastText}`
- `Session` = `{id, title, createdAt, updatedAt, messages:[UIMessage]}`（§5 形状；旧 `{role,text}` 消息读出时自动归一）
- `quickReplies` = `[{label, message, description?}]`（2–3 条；模型没给够时服务端兜底补齐 2 条）
- `toolCards` = `[{type, payload}]`（非流式响应字段，由 assistant parts 归一得出）：
  - 引用展示卡 `type:'job-detail'|'resume-card'`（流式在 parts 里作 `tool-job-detail`/`tool-resume-card`）：
    - job-detail payload：`{ref:'job', id, source:'inbox'|'app'|'eval', title, company, role, salary, url, status, score?, verdict?, dueDate?, nextStep?}`
    - resume-card payload：`{ref:'doc', id, title, kind:'master'|'job', company, role, tag, archived}`
  - 真实工具执行结果 `type:'get_job_detail'|'query_job_progress'|'list_resumes'|'get_resume_summary'|'resume_check'|'resume_improve'|'resume_polish'|'resume_tailor'`，payload = 工具 output（§5.7 工具表；四件套含 `rewritten` 全文卡 / `issues` 红黄行渲染，见「四件套三口径」）
- 上下文注入：消息内 `[context:doc:<id>]` / `[context:job:<id>]`（可带 `:<title>` 尾段），最多解析 4 个；解析结果拼进 system【事实】区，user 文本剥前缀。
- 错误：全部中文原因。`409` 纯文本=未配置大模型；`404/400` JSON `{ok:false,error}`；`502` `{ok:false,error:'模型调用失败：…'}`；`500 CORRUPT`=agent-sessions.json 损坏停写。

## 3. 继承的既有防线（零新增代码即生效）

1. **CSRF**：POST/PATCH/DELETE 均为 mutating → origin≠host 拒（handler 既有）。
2. **迁移锁**：mutating 期间 `rootLock.isHeld` → 503。
3. **AI 池化/租约**：`chatMsgs` 经 `leaseOf(req)` 透传占用 AI 槽；未传 lease 时 llm.mjs 兜底自借。
4. **Host 白名单 / VALID_ID**：`?id=` 校验不影响（会话 id 走 body/path，agent.mjs 内自校验）。
5. **no-store**：`send()` 对 HTML 统一 `Cache-Control: no-store`。

## 4. 待接点（明确不在本次范围）

1. ~~**流式**~~：✅ 已接（§5）。`POST /agent/chat` 带 `stream:1`/`Accept:text/event-stream` 回 SSE；agent.mjs `chatStream()` 产出 UIMessage 事件流；面板增量渲染。
2. ~~**真实工具调用循环**~~：✅ 已接（§5.7）。`chatStream` 多轮工具环：模型 `{toolCalls}` 契约 → server 执行 `get_job_detail`/`query_job_progress`/`list_resumes`/`get_resume_summary`（全只读）→ 结果回灌下一轮 system【工具结果】区，轮数封顶 3。上下文引用派生的展示卡（job-detail/resume-card）保留原口径。
3. **topnav 第四入口**：要导航高亮「助手」需在 `nav()` 调用处加一项并同步 test-structure.sh 断言。
4. **.gitignore**：`agent-sessions.json` 未登记（数据文件，建议与 inbox.json 同列加入）。
5. **投递登记写入**：策略是「用户明确发起才记录」，当前 agent 不代写 applications.json；要接 `/app/add` 式写入时再定「用户确认 → 服务端代建」流程。
6. **applyUrl 核对工具**：UPCV 手册第 2 条（核对同岗位/主体/地点/批次后补官方 URL）目前仅靠 system 约束，无专用工具/确认 UI。

## 5. 流式协议：`POST /agent/chat` SSE（UIMessage 事件流）

对齐 UPCV §5 / Vercel AI SDK v5 的 UIMessage 协议。同一端点按请求特征分流：

| 触发条件 | 响应 |
|---|---|
| body `stream` 真值 **或** `Accept` 含 `text/event-stream` | `200 text/event-stream`：SSE 事件流 |
| 否则（无 stream 参数） | `200 application/json`：原整段 `{ok:true, reply, quickReplies, toolCards, sessionId}`（渐进降级，旧调用方零改动） |

### 5.1 SSE 帧格式

每帧 = `data: <一行 JSON>\n\n`；流尾 = `data: [DONE]\n\n`。响应头：
`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`。

### 5.2 事件序列（UIMessageChunk）

正常序列（工具环 §5.7：0..n 组 tool-part 帧可穿插在 text-delta 之前/之间）：

```
data: {"type":"tool-part","part":{"type":"tool-get_job_detail","toolCallId":"tc-…","state":"call","input":{"ref":"app","id":"…"}}}
data: {"type":"tool-part","part":{"type":"tool-get_job_detail","toolCallId":"tc-…","state":"output-available","input":{…},"output":{…}}}
…（每个工具调用一对 call → output-available 帧；多轮工具环按时间序重复）
data: {"type":"text-delta","delta":"你好"}
data: {"type":"text-delta","delta":"，先看"}
…（0..n 个 text-delta，delta 已是纯文本：服务端从模型 JSON 输出里增量解出 reply 值）
data: {"type":"finish","message":{ …完整 assistant UIMessage… }}
data: [DONE]
```

| type | 载荷 | 消费方动作 |
|---|---|---|
| `tool-part` | `{part:{type:'tool-<name>', toolCallId, state:'call'|'output-available', input, output?}}` | 实况渲染工具卡：按 toolCallId 定位复用同一卡片就地更新（call→output 不换位置） |
| `text-delta` | `{delta:string}` | 追加到当前文本块（textContent，禁 innerHTML）；tool-part 之后到达的 delta 另起新文本块 |
| `finish` | `{message:UIMessage}` | 以完整 message 对账重渲（正文+工具卡+quickReplies），收尾 |
| `error` | `{errorText:string}` | 中文状态条；已到达的部分文本保留 |

### 5.3 UIMessage 形状（存储与 finish 载荷同一形状）

```json
{"id":"m-…","role":"assistant",
 "parts":[
   {"type":"step-start"},
   {"type":"text","text":"可选过渡句：我先查一下…"},
   {"type":"tool-get_job_detail","toolCallId":"tc-…","input":{"ref":"app","id":"…"},"state":"output-available","output":{…工具 output…}},
   {"type":"tool-query_job_progress","toolCallId":"tc-…","input":{},"state":"output-available","output":{…工具 output…}},
   {"type":"text","text":"正文"},
   {"type":"tool-job-detail","input":{"id":"…"},"state":"output-available","output":{…job-detail payload…}},
   {"type":"tool-resume-card","input":{"id":"…"},"state":"output-available","output":{…resume-card payload…}},
   {"type":"tool-ui-quickReplies","input":{},"state":"output-available","output":{"options":[{label,message,description?}]}}
 ],
 "metadata":{"createdAt":"<iso>","tokenCount":123,"rounds":2}}
```

- parts **按时间序**记录：`step-start` 开场 → 各轮工具 part（过渡 `text` 若模型同帧给了 `reply` 排在该轮工具卡之前）→ 最终 `text` → 引用展示卡 → `tool-ui-quickReplies`。
- 持久化的工具 part 只落 `state:'output-available'` 终态；`'call'` 是 SSE 实况帧的过程态，不落档。
- 用户条：`{id,role:'user',parts:[{type:'text',text}],metadata:{createdAt,refs?}}`（`refs` = 解析到的 `[context:…]` 引用）。
- `metadata.tokenCount` = 多轮 `usage.total` 合计；厂商未回 usage 记 `null`（诚实口径，不编 0）。
- `metadata.rounds` = 工具环实际模型轮数；单轮回复不记该字段。
- 断连截断的助手条：`metadata.aborted:true` + 已收工具 parts 与已显示的部分正文（不假装完整）。
- 兼容：旧 `{role,text,quickReplies?,toolCards?,refs?,at}` 消息读出时自动归一为 UIMessage（`msgToUI`），磁盘文件不改写。
- parts → 老字段对账：`tool-<x>` part ↔ `{type:'<x>',payload:output}`；`tool-ui-quickReplies` part ↔ `quickReplies`。

### 5.4 服务端行为（agent.mjs `chatStream`）

1. 先校验会话/消息（`NO_SESSION`/`EMPTY`/`CORRUPT` 仍抛错——路由在写 SSE 头前拉首帧，校验错误回 HTTP 状态码）。
2. 用户条先落盘（UIMessage），再开流：模型失败/断连也会话里留住提问。
   A3 快照接缝：用户条落盘后调 `draft.mjs agentDraftTick`——建简历意图（或已有未完成草稿）→ UPSERT 服务端快照（resume-draft.json，一会话一行）；草稿在场且已建出真文档（新增未归档 master）→ 置完成。普通会话零写入（设计 dev-docs/2026-11-19-upcv-port-snapshot-status-design.md §1）。
3. **工具环**（≤3 轮，§5.7）：每轮 `streamChatMsgs` 拉一轮输出 → `parseAgentTurn` 判定 `toolCalls`/`reply`。
   - `toolCalls`：逐调用发 `tool-part` 实况帧（call → output-available）→ 执行结果回灌下一轮 system【工具结果】区。
   - `reply`：增量 `text-delta` 已在流中下发 → 组 assistant UIMessage 落盘 → `finish`。
4. 流毕 `parseAgentTurn(全文)` 终值对账 → 上下文/引用卡 + quickReplies 兜底 → `finish`。
5. 提前终止（路由 `it.return()`）：`for await` 把 return 透传 `streamChatMsgs` → llm finally unclaim 租约 → AI 槽释放；已收工具 parts + `ex.shown()` 非空则按 `aborted` 落盘。

### 5.5 面板行为（agent-panel.js）

- `sendStream()`：`fetch` + `Accept:text/event-stream` + body `stream:1`；content-type 非 SSE 走整段回退。
- 首个 delta/tool-part 到达即停等待秒表；增量只写 `textEl.textContent`（tool-part 后新 delta 另起文本块）；`tool-part` 帧按 `toolCallId` 就地更新执行卡；`finish` 用 `renderAiInto` 对账全量重渲。
- `renderAiInto` 按 parts 时间序逐 part 渲染：`text` → 文本块；`tool-job-detail`/`tool-resume-card` → 引用展示卡；其余 `tool-*` → 执行卡（调用名 + state 徽章 + input/output 摘要）；`tool-ui-quickReplies` → 选项；`step-start`/未知 part 不渲染。
- `error` 帧 / 无 finish 断连 → 中文状态条（「连接已断开：回复可能不完整」等）。
- 历史渲染 `msgText/msgCards/msgReplies` 按 parts 归一，兼吃老字段（老 `{type:'get_job_detail'…}` 卡同样走执行卡渲染）。

### 5.6 server.mjs 需要的改动（可粘贴，2 处）

1. **§1.1 import 行**：`agent.mjs` 导入补 `chatStream as agentChatStream`（见 §1.1 已更新行）。
2. **§1.5 路由块**：整段替换为 §1.5 的新代码（非流式分支原样保留 + SSE 分支）。
   无其他改动：`gatePool` 已覆盖 `POST /agent/chat`（AI 槽闸门照走）；`readBody`/`sendJson`/`leaseOf` 复用现有；`tool-part` 帧由通用 `data: <json>` 透传，路由零改动。

### 5.7 工具执行环（server 侧真实执行，对照 UPCV §5 工具集）

**模型契约**（写死在 `AGENT_SYSTEM`）：模型每轮只输出一个 JSON 对象，二选一——

| 输出 | 语义 |
|---|---|
| `{"toolCalls":[{"name":"工具名","args":{…}}]}` | 工具路径：本轮不作答；可带 `"reply":"我先查一下…"` 过渡句（照常流式下发并入档） |
| `{"reply":"…","quickReplies":[…],"toolRefs":[…]}` | 回复路径：收尾落盘 |

同一 JSON 里 `reply` 与非空 `toolCalls` 同现 → **toolCalls 优先**（reply 只作过渡句入档）。

**轮次**：单条用户消息最多 `TOOL_ROUND_MAX=3` 轮模型交互（防死循环）。

1. 第 1–2 轮拿到 `toolCalls` → 执行 → 结果以 `- name(args) → output` 行追加进下一轮 system 的【工具结果】区。
2. 第 3 轮 system 追加「最后一次作答机会」提示；模型仍只给 `toolCalls` → 调用**照常执行入档**（不浪费已查数据），再补一句系统兜底 `text`（诚实标注，不冒充模型输出）。
3. 任一轮给 `reply` → 立即收尾。单轮至多执行 `TOOL_CALL_CAP=4` 条调用，超出的丢弃并在【工具结果】区注明。

**工具表**（全部只读、零落盘；`args` 白名单校验——未知字段/非法值 → `{ok:false,code:'BAD_ARGS'}`）：

| name | args | 数据源 | output（ok:true 时） |
|---|---|---|---|
| `get_job_detail` | `ref:'inbox'\|'app'\|'eval'`（必填）、`id`（必填） | inbox.json / applications.json / evaluations.json | `{ref, source, id, title, company, role, salary, url, status, statusEnum?, statusLabel?, score?, verdict?, appliedAt?, dueDate?, nextStep?, docId?, jdExcerpt?}` |
| `query_job_progress` | `status?`（六态枚举或中文标签） | applications.json | `{total, byStatus{六态+closed 计数}, byStatusLabel, dueSoonDays:7, dueSoon:[{…brief, overdue}]（dueDate≤今天+7d 含逾期、升序、≤20 条）, status?, statusLabel?, items?[≤30 条 brief]}` |
| `list_resumes` | `archived?`：`true`/`false`/`"all"`，缺省只列在用 | docs/ 目录（VALID_ID 同口径）× docs-meta.json | `{total, archived, items:[{id,title,theme,kind,company,role,tag,archived,updatedAt}]（mtime 降序 ≤50）}` |
| `get_resume_summary` | `docId`（必填） | docs/<id>.html | `{id,title,kind,theme,company,role,tag,archived,sectionCount,sections:[{title,hidden}]（extract.mjs sectionsOf 口径）,headings?（无 section 时退 h2/h3）,lineCount,preview[≤8 行]}` |
| `resume_check` | `docId`（必填） | docs/<id>.html + ai-helper.mjs smartCheck | `{ok,docId,title,count,issues:[{type:'error'\|'warning',field,description,suggestion,fixed:false}]≤20}` |
| `resume_improve` | `docId`（必填） | smartCheck → improveAll（一呼完成检查+修复） | `{ok,docId,title,chars,issuesFixed,preview[≤300字],rewritten}` |
| `resume_polish` | `docId`（必填） | ai-helper.mjs improveWriting | `{ok,docId,title,chars,preview[≤300字],rewritten}` |
| `resume_tailor` | `docId`、`requirement`（均必填；≤200 字由 buildCustomRewrite 内截断） | ai-helper.mjs customRewrite | `{ok,docId,title,chars,requirement[≤80字回显],preview[≤300字],rewritten}` |

**四件套三口径**（2026-11-19 面合并，设计 dev-docs/2026-11-19-ai-surface-merge-design.md §2）：

1. **timeoutMs**：四件套为真模型调用，工具竞速 per-tool `600000`（10 分钟，兜真卡死），底层 LLM 调用 per-call `540000`（`RESUME_LLM_TIMEOUT_MS`；2026-11-19 真模型抽验修正：active 档未配 timeoutMs 时 llm.mjs 120s 默认先掐分钟级请求，故调用面自报预算，优先级 per-call > profile > 120s）；其余只读工具默认 30s 不变（`runToolTimed` 读 `def.timeoutMs ?? TOOL_TIMEOUT_MS`）。
2. **回灌摘要**：改写全文不回灌模型——`def.fact` 投影剔掉 `rewritten`，system【工具结果】只收 `{ok,docId,title,chars,issuesFixed?,requirement?,preview}`；`resume_check` 的 issues 是模型要转述的内容，`factClip=4000` 全量回灌。
3. **交付卡**：`rewritten` 全文只进 tool part output（面板 pre 全文卡 + 「复制全文」按钮；`issues` 渲染红/黄逐条行），会话落盘同形状；不自动写回文档，用户复制到编辑器应用（工具环「只读」= 零落盘）。

ctx 透传：`runTool/runToolTimed(args, ctx)` 的 `ctx={root,lease,profile,timeoutMs}` 由 `chatStream` 轮内透传（`root=R()`、`lease`/`profile` 沿用 agent 自身 ctx；`timeoutMs=RESUME_LLM_TIMEOUT_MS=540000` 为四件套底层调用预算）；工具执行发生在两轮模型调用之间，agent 租约已 unclaim，工具内部复用同 lease 顺序 claim 不死锁（resource-slots 合同③）。

**错误对象**（概念 400/404 不进 HTTP 层——调用发生在流内，原样回灌模型如实转告）：

| code | 触发 |
|---|---|
| `BAD_ARGS` | args 非对象 / 未知字段 / 缺必填 / 枚举值非法 / 未知工具名 |
| `NOT_FOUND` | 指定来源/文档里无该 id |
| `TIMEOUT` | 单调用执行超过 def 超时（默认 30s；`resume_*` 四件套 600s 竞速兜底） |
| `ERROR` | 执行抛异常（message 截断 120 字） |

**超时口径**：单工具调用 `Promise.race` 兜底，读 `def.timeoutMs ?? TOOL_TIMEOUT_MS`（默认 30s；四件套真模型 600s 竞速，见「四件套三口径」）。模型请求级超时走 llm.mjs per-call 覆盖优先级 per-call `timeoutMs` > profile `timeoutMs` > 默认 120s（四件套 per-call 540s，永远先于竞速结束，超时语义不混层）。

**租约/断连**：同一 `lease` 逐轮 `claim → unclaim`（resource-slots 合同只拒并发占用，顺序复用合法）；路由断连 `it.return()` 经 for-await 透传 `streamChatMsgs` → finally unclaim 放槽，口径与单轮流式一致。

**UIMessage 落档**：`metadata.rounds` 记实际轮数（>1 才有）；`tokenCount` 为多轮 `usage.total` 合计。

## 6. A5 附件与语音（2026-11-20，设计 dev-docs/2026-11-20-a5-voice-attachments-design.md）

- `POST /agent/files?sid&name`（raw body ≤10MB）：pdf/docx/png/jpg/webp/txt/md 魔数白名单 → `agent-files/<sid>__<fid>.bin/.json/.txt`；返回 `{ok,fileId,name,mime,size,textChars,warning?}`。
- `/agent/chat` body +`fileIds`（≤8）：归属校验 400；用户条 parts 追 UPCV 逐字 `{type:"file",filename,url,mediaType}`；模型侧文本前注 `[context:file:<name>]\n<≤8000 提取文>`（持久化 text part 只存原文）；图片 → image_url 多模态，vision 不受理→零 delta 降级文本重试一次。
- 语音输入：仅浏览器 SpeechRecognition（无服务端 /agent/voice——active 档无转写上游，API 缺失时麦克风隐藏）。
- 会话删除连带 `sweepAgentFiles`；`agent-files/` 入 .gitignore/备份 tar/恢复 ALLOWED/RESTORE_MANAGED_DIRS。
- 夹具：test-fixtures/reliability/test-agent-files.mjs（隔离根+SSE 桩，上传/提取/归属/chat/清扫五段）。

## 7. UPCV 残余（2026-11-20 收口）

- `GET/POST /agent/prefs`：`agent-prefs.json` 全局偏好——`memory`（默认 true）= #1 记忆开关，关时 chatStream 不带历史上模型（本地落盘照常）。
- `/site` + `POST /site/generate` + `GET /site/file`（#2 个人主页）：母版 → site/index.html 自包含页（0600，可再生生成物，只进 .gitignore）。
- 扩展 autoCollect（#4）：打开职位列表页自动采集（同 URL 60s 节流、批次在跑不插队）；默认关，逐卡打分烧 token 由用户主动开。
- 夹具：test-upcv-residual.mjs（合成母版 → site）。
- **UPCV 职位库已于 2026-11-20 同日退役**（用户裁决）：/jobs 页、/jobs/* 四路由、/match/job、/match/recommend、job_monitor 工具、upcv-jobs.mjs、jobs-panel.js、test-jobs-match.mjs 全删。match.mjs 保留 computeMatch（jdText 路径）服务 /extension/match-score；agent-prefs.monitor 字段成为历史键（无害留存）。
