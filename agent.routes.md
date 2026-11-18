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
- `toolCards` = `[{type:'job-detail'|'resume-card', payload}]`（非流式响应字段；流式在 parts 里作 `tool-job-detail`/`tool-resume-card`）：
  - job-detail payload：`{ref:'job', id, source:'inbox'|'app'|'eval', title, company, role, salary, url, status, score?, verdict?, dueDate?, nextStep?}`
  - resume-card payload：`{ref:'doc', id, title, kind:'master'|'job', company, role, tag, archived}`
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
2. **真实工具调用循环**：toolCards 目前由「上下文引用 + 模型 toolRefs」派生（渲染层协议），尚无 server 侧 tool 执行（job-detail/job-progress-query/resume-list 对应能力都已存在：inbox/apps/docs-meta 数据层）。
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

正常序列：

```
data: {"type":"text-delta","delta":"你好"}
data: {"type":"text-delta","delta":"，先看"}
…（0..n 个 text-delta，delta 已是纯文本：服务端从模型 JSON 输出里增量解出 reply 值）
data: {"type":"finish","message":{ …完整 assistant UIMessage… }}
data: [DONE]
```

| type | 载荷 | 消费方动作 |
|---|---|---|
| `text-delta` | `{delta:string}` | 追加到当前助手气泡正文（textContent，禁 innerHTML） |
| `finish` | `{message:UIMessage}` | 以完整 message 对账重渲（正文+工具卡+quickReplies），收尾 |
| `error` | `{errorText:string}` | 中文状态条；已到达的部分文本保留 |

### 5.3 UIMessage 形状（存储与 finish 载荷同一形状）

```json
{"id":"m-…","role":"assistant",
 "parts":[
   {"type":"step-start"},
   {"type":"text","text":"正文"},
   {"type":"tool-job-detail","input":{"id":"…"},"state":"output-available","output":{…job-detail payload…}},
   {"type":"tool-resume-card","input":{"id":"…"},"state":"output-available","output":{…resume-card payload…}},
   {"type":"tool-ui-quickReplies","input":{},"state":"output-available","output":{"options":[{label,message,description?}]}}
 ],
 "metadata":{"createdAt":"<iso>","tokenCount":123}}
```

- 用户条：`{id,role:'user',parts:[{type:'text',text}],metadata:{createdAt,refs?}}`（`refs` = 解析到的 `[context:…]` 引用）。
- `metadata.tokenCount` = `usage.total`；厂商未回 usage 记 `null`（诚实口径，不编 0）。
- 断连截断的助手条：`metadata.aborted:true` + 已显示的部分正文（不假装完整）。
- 兼容：旧 `{role,text,quickReplies?,toolCards?,refs?,at}` 消息读出时自动归一为 UIMessage（`msgToUI`），磁盘文件不改写。
- parts → 老字段对账：`tool-<x>` part ↔ `{type:'<x>',payload:output}`；`tool-ui-quickReplies` part ↔ `quickReplies`。

### 5.4 服务端行为（agent.mjs `chatStream`）

1. 先校验会话/消息（`NO_SESSION`/`EMPTY`/`CORRUPT` 仍抛错——路由在写 SSE 头前拉首帧，校验错误回 HTTP 状态码）。
2. 用户条先落盘（UIMessage），再开流：模型失败/断连也会话里留住提问。
3. 流式逐 chunk 经 `replyExtractor` 增量解出 reply 纯文本 → `text-delta`；非 JSON 输出按纯文本透传。
4. 流毕 `parseAgentReply(全文)` 终值对账 → toolCards/quickReplies 兜底 → 组 assistant UIMessage 落盘 → `finish`。
5. 提前终止（路由 `it.return()`）：`for await` 把 return 透传 `streamChatMsgs` → llm finally unclaim 租约 → AI 槽释放；`ex.shown()` 非空则按 `aborted` 落盘。

### 5.5 面板行为（agent-panel.js）

- `sendStream()`：`fetch` + `Accept:text/event-stream` + body `stream:1`；content-type 非 SSE 走整段回退。
- 首个 delta 到达即停等待秒表；增量只写 `textEl.textContent`；`finish` 用 `renderAiInto` 对账全量重渲。
- `error` 帧 / 无 finish 断连 → 中文状态条（「连接已断开：回复可能不完整」等）。
- 历史渲染 `msgText/msgCards/msgReplies` 按 parts 归一，兼吃老字段。

### 5.6 server.mjs 需要的改动（可粘贴，2 处）

1. **§1.1 import 行**：`agent.mjs` 导入补 `chatStream as agentChatStream`（见 §1.1 已更新行）。
2. **§1.5 路由块**：整段替换为 §1.5 的新代码（非流式分支原样保留 + SSE 分支）。
   无其他改动：`gatePool` 已覆盖 `POST /agent/chat`（AI 槽闸门照走）；`readBody`/`sendJson`/`leaseOf` 复用现有。
