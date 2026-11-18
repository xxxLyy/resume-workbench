# ai-helper 路由规范 —— 「AI 简历助手」页（UPCV AI 四件套本地版）

> 对应契约：`upcv-features-implementation.md` §2（AI 简历四件套）。
> 本文件给出 server.mjs 需要的全部接线：import、静态件路由、页面组装、6 个 POST 端点（4 JSON + 2 SSE）、闸门与导航登记。
> 新文件：`ai-helper.mjs`（编排）、`ai-helper-panel.js`（页面前端）。现有文件零改动之外只加不删。
> 流式规范：§5（`/ai-helper/rewrite/stream`、`/ai-helper/polish/stream`，对照 UPCV `custom-rewrite/stream`、`improve-writing/stream`）。

## 1. 端点表

| 端点 | 方法 | 请求体 | 响应 | 复用/说明 |
|---|---|---|---|---|
| `/ai-helper` | GET | — | `page('AI 简历助手', inner, 'ai-helper')` | 页面组装 |
| `/ai-helper-panel.js` | GET | — | `application/javascript` | 静态件，同 `/ai-panel.js` 段 |
| `/ai-helper/docs` | GET | — | `{ok:true, docs:[{id,title}]}` | 简历下拉清单（未归档） |
| `/ai-helper/check` | POST | `{text, profile?}` | `{ok:true, issues:[…]}` 或 `{ok:true, reply}` | UPCV `smart-check` |
| `/ai-helper/improve-all` | POST | `{text, issues[], profile?}` | `{ok:true, rewritten}` 或 `{ok:true, reply}` | UPCV `smart-check-improve/all` |
| `/ai-helper/rewrite` | POST | `{text, userRequirement, profile?}` | `{ok:true, rewritten}` 或 `{ok:true, reply}` | UPCV `custom-rewrite`（JSON 版保留，兼容/降级用） |
| `/ai-helper/polish` | POST | `{text, profile?}` | `{ok:true, rewritten}` 或 `{ok:true, reply}` | UPCV `improve-writing`（JSON 版保留，兼容/降级用） |
| `/ai-helper/rewrite/stream` | POST | `{text, userRequirement, profile?}` | `text/event-stream`：`{delta}` 帧流 | UPCV `custom-rewrite/stream`（§5） |
| `/ai-helper/polish/stream` | POST | `{text, profile?}` | `text/event-stream`：`{delta}` 帧流 | UPCV `improve-writing/stream`（§5） |

### issue 形状（check 响应）
```json
{"type":"error|warning","field":"≤20字","description":"≤200字","suggestion":"≤200字","fixed":false}
```
- `type`：`error`=事实性问题，`warning`=表达性问题。≤20 条（服务端截断）。
- `fixed`：契约标志位，服务端恒发 `false`；修复状态由前端维护（「去修复」成功后标「已修复」）。
- `reply` 兜底：模型未按约定输出时返回 `{ok:true, reply:原始输出}`，与 `/ai/review` 同口径，不抛 502。

### 简历文本来源（「从简历载入」复用的现成端点）
复用 **`GET /api/extract?id=<docId>`**（既有只读视图，`docToLines` 统一提取，隐藏内容不参与）。
返回 `{ok:true, lines, text, hash}`。面板不新造文本提取路径；服务端内部 `docToText` 同源于此。

### 错误口径（与既有 /ai/* 一致）
- 未配置模型：`send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain')`（面板按 409 文本分支显示）。
- 入参缺失/非法：`sendJson(400, {ok:false, error})`。
- 模型异常：`sendJson(502, {ok:false, error:'模型调用失败：…'})`。
- `profile`（可选，多模型档案索引）：`pickProfile` → `null` 时 400。面板本期不传，走 active 档。

## 2. server.mjs 需要的改动（5 处，全部新增行）

### 2.1 import（加在文件头 import 区，ai.mjs 行之后）
```js
import { smartCheck, improveAll, customRewrite, improveWriting } from './ai-helper.mjs';
```

### 2.2 gatePool（约 729 行，加 `/ai-helper/` 前缀进 AI 闸门）
```js
// 原行：
if (method === 'POST' && (/^\/ai\//.test(pathname) || pathname === '/eval/create' || pathname === '/restructure' || pathname === '/onboarding/star-suggest')
// 改为（追加一个前缀条件）：
if (method === 'POST' && (/^\/ai\//.test(pathname) || /^\/ai-helper\//.test(pathname) || pathname === '/eval/create' || pathname === '/restructure' || pathname === '/onboarding/star-suggest')
```
不进闸门的兜底也存在（chat() 底层 acquire 等 5s 后 ResourceBusy），但入口 429 语义以闸门为准。

### 2.3 静态件路由（加在 `/model-picker.js` 路由后，约 4767 行后）
```js
if (req.method === 'GET' && url.pathname === '/ai-helper-panel.js') {
  return send(200, fs.readFileSync(path.join(APP_ROOT, 'ai-helper-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
}
```

### 2.4 页面 + API 路由（建议加在 `/ai/profiles` 路由后，约 8131 行后）
```js
// ===== AI 简历助手（UPCV 四件套本地版；编排 ai-helper.mjs，规范 ai-helper.routes.md）=====
if (req.method === 'GET' && url.pathname === '/ai-helper') {
  const inner = `<div class="page-head"><h1>AI 简历助手</h1></div>
<div id="ah-app"><p style="color:var(--mut)">界面加载中…</p></div>
<script nonce="__CSP_NONCE__">${ICON_SCRIPT}</script>
<script src="/ai-helper-panel.js" defer></script>`;
  return send(200, page('AI 简历助手', inner, 'ai-helper'));
}
// 简历下拉清单：标题取 <h1> 正则（同 docInfo），但 JSON + 前端 textContent 路径【不 escHtml】，
// 否则用户看到实体字面值（docInfo.title 已过 escHtml，不可直接复用进 JSON）。
if (req.method === 'GET' && url.pathname === '/ai-helper/docs') {
  const meta = loadMeta();
  const docs = docIdsOnDisk()
    .filter((did) => !((meta[did] || {}).archivedAt))
    .map((did) => {
      let title = did;
      try { title = (fs.readFileSync(docPath(did), 'utf8').match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1] || did; } catch {}
      return { id: did, title };
    });
  return sendJson(200, { ok: true, docs });
}
if (req.method === 'POST' && url.pathname === '/ai-helper/check') {
  if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');
  const body = JSON.parse(await readBody(req));
  const text = String(body.text || '');
  if (!text.trim()) return sendJson(400, { ok: false, error: 'text 必填' });
  const prof = pickProfile(body.profile);
  if (prof === null) return sendJson(400, { ok: false, error: '模型配置不存在或不完整' });
  let out;
  try { out = await smartCheck(text, { root, lease: leaseOf(req), profile: prof }); }
  catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
  return sendJson(200, { ok: true, ...out });
}
if (req.method === 'POST' && url.pathname === '/ai-helper/improve-all') {
  if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');
  const body = JSON.parse(await readBody(req));
  const text = String(body.text || '');
  if (!text.trim()) return sendJson(400, { ok: false, error: 'text 必填' });
  if (body.issues !== undefined && !Array.isArray(body.issues)) return sendJson(400, { ok: false, error: 'issues 必须是数组' });
  const prof = pickProfile(body.profile);
  if (prof === null) return sendJson(400, { ok: false, error: '模型配置不存在或不完整' });
  let out;
  try { out = await improveAll(text, body.issues || [], { root, lease: leaseOf(req), profile: prof }); }
  catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
  return sendJson(200, { ok: true, ...out });
}
if (req.method === 'POST' && url.pathname === '/ai-helper/rewrite') {
  if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');
  const body = JSON.parse(await readBody(req));
  const text = String(body.text || '');
  const userRequirement = String(body.userRequirement || '').trim();
  if (!text.trim()) return sendJson(400, { ok: false, error: 'text 必填' });
  if (!userRequirement) return sendJson(400, { ok: false, error: 'userRequirement 必填' });
  const prof = pickProfile(body.profile);
  if (prof === null) return sendJson(400, { ok: false, error: '模型配置不存在或不完整' });
  let out;
  try { out = await customRewrite(text, userRequirement, { root, lease: leaseOf(req), profile: prof }); }
  catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
  return sendJson(200, { ok: true, ...out });
}
if (req.method === 'POST' && url.pathname === '/ai-helper/polish') {
  if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');
  const body = JSON.parse(await readBody(req));
  const text = String(body.text || '');
  if (!text.trim()) return sendJson(400, { ok: false, error: 'text 必填' });
  const prof = pickProfile(body.profile);
  if (prof === null) return sendJson(400, { ok: false, error: '模型配置不存在或不完整' });
  let out;
  try { out = await improveWriting(text, { root, lease: leaseOf(req), profile: prof }); }
  catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
  return sendJson(200, { ok: true, ...out });
}
```

### 2.5 导航（约 2138 行 topnav，「投递」与「设置」之间加一项）
```js
// 原片段：
${nav('docs', '/', '简历', 'file-text')}${nav('apps', '/applications', '投递', 'columns-3')}${nav('settings', '/settings', '设置', 'settings')}
// 改为：
${nav('docs', '/', '简历', 'file-text')}${nav('apps', '/applications', '投递', 'columns-3')}${nav('ai-helper', '/ai-helper', 'AI 助手', 'bot')}${nav('settings', '/settings', '设置', 'settings')}
```

## 3. 前端契约（ai-helper-panel.js 已实现）

- 挂载点：`#ah-app`；`ICON_SCRIPT` 提供 `window.__icon`（无则降级无图标）；`__status`/`__wv` 由 page() 自带。
- 左栏：`#ah-docs` 下拉（`/ai-helper/docs`）+「从简历载入」（`/api/extract?id=`）+ `#ah-text` 大文本域
  + 四按钮（`#ah-check`/`#ah-improve-all`/`#ah-rewrite`/`#ah-polish`）+ `#ah-req` 改写要求框（maxlength 200）。
- 右栏：`#ah-issues` 问题卡列表（`.badge err|warn` + 字段 + 描述 + 建议 +「去修复」按钮；已修复标灰）
  + `#ah-output-card` 输出卡（pre-wrap 文本 + 复制 + 替换输入文本）。
- 流式渲染（§5）：`定制改写/润色/去修复` 走 `postStream` —— fetch `Accept: text/event-stream` →
  `r.body.getReader()` 按 `\n\n` 分帧逐行读 `data:` → `{delta}` 追加**文本节点**（beginOutput/appendOutput，
  禁 innerHTML）→ `[DONE]` 置完成；中断（done=false）保留已收部分 + 中文警告。秒表照跑（runAction 不变）。
- 进度：`runAction` 统一秒表「检查中/优化中/改写中/润色中/修复中/载入中 · 已等待 m:ss」（与 ai-panel fmtElapsed 同口径，无假百分比）。
- AI 不可用：`/ai/profiles` 无就绪档 → 禁用四个 AI 按钮 + 状态区放 /settings 链接；409 文本分支兜底显示。
- `?id=<docId>`：页面参数预选下拉文档（复用 handler 顶部 `id` 变量的 VALID_ID 校验）。

## 4. 待接点（本期未做，已按优先级标注）

1. ~~**SSE 流式**~~：✅ 已接（§5）。`/ai-helper/rewrite/stream`、`/ai-helper/polish/stream` 真 SSE 流式（`streamChat` + `text/event-stream` 转发 + 面板 ReadableStream 增量渲染）；check / improve-all 按 UPCV 契约保持非流式。
2. **ROUTES_FROZEN 登记**：`test-structure.sh`（约 2212 行）冻结路由字面量集合。接入后需把 9 个新字面量（`/ai-helper`、`/ai-helper-panel.js`、`/ai-helper/docs`、`/ai-helper/check`、`/ai-helper/improve-all`、`/ai-helper/rewrite`、`/ai-helper/polish`、`/ai-helper/rewrite/stream`、`/ai-helper/polish/stream`）登记进 `ROUTES_FROZEN`（登记非放宽；本任务按约束不改 test*.sh）。
3. **模型选择**：面板本期走 active 档；4 个端点已透传 `profile`（pickProfile 口径）。如需多模型对比可挂 `/model-picker.js` + `window.__modelPicker.mount`（同 ai-panel 体检页签）。
4. **「去修复」实现口径**：本期 = 把该 issue 的「字段+描述+建议」组装成 userRequirement 调 `/ai-helper/rewrite` 整文改写，结果进输出卡。UPCV 未公开单条修复端点语义；若要段落级应用，可让 check 额外回传 `before` 锚点走 `applyOps` 管线（需扩 prompt 契约）。
5. **结果持久化**：issues/输出不落盘（UPCV 契约无此要求）。如需恢复上次检查，可把最后一次结果写 `meta[<docId>].lastHelperCheck`（同 lastReview 口径）。
6. **写回编辑器**：输出卡「替换输入文本」只写回输入框，不改磁盘文档；「应用到简历文档」需走 /save 管线（编辑锁+staleGuard），本期不做。

## 5. SSE 流式路由规范（对照 UPCV §2 `custom-rewrite/stream`、`improve-writing/stream`）

### 5.1 路径决策（二选一，已定）

**采用新增 `/stream` 后缀路径**，不用 Accept 协商。理由：UPCV 原契约就是独立路径
（`POST /api/resume/custom-rewrite/stream`、`POST /api/resume/improve-writing/stream`），
`/ai-helper/rewrite/stream`、`/ai-helper/polish/stream` 与之逐段一比一；原 JSON 端点保留作降级/兼容；
无内容协商歧义；`gatePool` 的 `/^\/ai-helper\//` 前缀天然覆盖 → **闸门零改动**（借 lease、429 排队语义原样生效）。

### 5.2 帧协议

```
data: {"delta":"一段正文增量"}\n\n      ← 每个模型 delta 一帧（JSON 单行，\n\n 分帧）
data: {"delta":"……"}\n\n
data: [DONE]\n\n                        ← 正常收尾（唯一终止标志，客户端按它置 done）
data: {"error":"模型调用失败：…"}\n\n    ← 流中途出错（响应头已发，只能帧内报错，不再改状态码）
```

- 响应头：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache`、`Connection: keep-alive`、`X-Accel-Buffering: no`，`res.flushHeaders()` 随首帧一起发出。
- **首段到达前不写头**：起步错误（未配置/4xx/5xx/超时/租约失败）落回普通 JSON 错误分支，与非流式端点同一口径（409 文本 / 400 / 502 JSON）。
- 零 delta 收尾：仍升级 SSE 只发 `[DONE]`，前端按「模型未返回内容」处理（不回 `{reply}` JSON——流式无事后整形）。
- `{reply}` 兜底语义只存在于非流式端点；流式逐段直出，错误只在帧内。

### 5.3 断连与放槽（断连必须释放 AI 槽）

- **`res.on('close')` 是断连信号，`req.on('close')` 不是**（2026-11-18 实测）：现代 Node 的 server 端
  `req 'close'` 在请求体收完就触发（消息完成语义），拿来判连会误杀正常流/漏判真断连；
  `res 'close'` 才是「连接在响应结束前终止」的触发点。另：`res.write` 写已毁连接不抛错
  （内核缓冲静默收下），写失败检测也不可靠 → 必须以 res close 竞速停消费。
- `res.once('close')` 与 `it.next()` 竞速：客户端断开**不等上游新数据**立即停消费。
- 出口统一 `await it.return()` → generator `finally` → `aiPool.unclaim`；闸门 lease 由 handler `.finally` 统一 `release`（release 要求先 unclaim，顺序天然满足）。
- 上游 LLM 请求无显式 abort 通道：断连后上游 fetch 由 profile `timeoutMs`（默认 120s）兜底断流，槽随之释放——断连放槽有界，非瞬时。
- `res.on('error')` 必须挂（写已毁 socket 触发 `error` 事件，未监听 = 未处理异常崩服务，同 AUD-08）。

### 5.4 server.mjs 需要的改动（全部新增/替换行）

**import（2.1 行替换为）：**
```js
import { smartCheck, improveAll, customRewrite, improveWriting, customRewriteStream, improveWritingStream } from './ai-helper.mjs';   // AI 简历助手四件套（规范 ai-helper.routes.md）
```

**路由块（加在既有 `/ai-helper/polish` 路由之后，同一块内）：**
```js
// ===== AI 简历助手·流式端点（UPCV */stream 复刻；帧协议与断连口径 ai-helper.routes.md §5）=====
// pipeSSE：首段到达才 writeHead——起步错误（未配置/4xx/5xx/超时/租约失败）抛回路由走普通 JSON 错误，
// 与非流式同口径；首个 delta 才升级 text/event-stream + flushHeaders。
// 断连：res 'close' 与 it.next() 竞速——客户端离开立即停消费（req 'close' 是请求收完信号，勿用！§5.3）；
// finally 里 it.return() 让 generator 走 finally 归还槽占用（上游 fetch 的 timeoutMs 兜底断流）。
const pipeSSE = async (gen) => {
  const it = gen[Symbol.asyncIterator]();
  const closedP = new Promise((resolve) => res.once('close', resolve));
  res.on('error', () => {});                          // 断连后的写失败进 error 事件：不监听会崩服务（AUD-08）
  let started = false;
  const frame = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); return true; } catch { return false; } };
  try {
    for (;;) {
      const step = await Promise.race([it.next(), closedP]);
      if (step === undefined) return;                 // 客户端断开：停消费（finally 里 it.return() 放槽）
      if (step.done) break;
      if (!started) {
        started = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'                   // 防前置代理缓冲（本地链路无害兜底）
        });
        res.flushHeaders();
      }
      if (!frame({ delta: step.value })) return;      // 写失败 = 对端已毁：停
    }
    if (!started) {                                   // 零 delta：仍回一条 SSE 空流（仅 [DONE]）
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
    }
    try { res.write('data: [DONE]\n\n'); } catch {}
    res.end();
  } catch (e) {
    if (!started) throw e;                            // 头未发：抛回路由走 JSON 502
    try { frame({ error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); } catch {}
    try { res.end(); } catch {}
  } finally {
    try { await it.return(); } catch {}               // 任何出口归还执行器占用；闸门租约由 handler .finally 统一释放
  }
};
if (req.method === 'POST' && url.pathname === '/ai-helper/rewrite/stream') {
  if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');
  const body = JSON.parse(await readBody(req));
  const text = String(body.text || '');
  const userRequirement = String(body.userRequirement || '').trim();
  if (!text.trim()) return sendJson(400, { ok: false, error: 'text 必填' });
  if (!userRequirement) return sendJson(400, { ok: false, error: 'userRequirement 必填' });
  const prof = pickProfile(body.profile);
  if (prof === null) return sendJson(400, { ok: false, error: '模型配置不存在或不完整' });
  try { return await pipeSSE(customRewriteStream(text, userRequirement, { root, lease: leaseOf(req), profile: prof })); }
  catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
}
if (req.method === 'POST' && url.pathname === '/ai-helper/polish/stream') {
  if (!hasLLM(root)) return send(409, '未配置大模型：打开 /settings 完成模型配置', 'text/plain');
  const body = JSON.parse(await readBody(req));
  const text = String(body.text || '');
  if (!text.trim()) return sendJson(400, { ok: false, error: 'text 必填' });
  const prof = pickProfile(body.profile);
  if (prof === null) return sendJson(400, { ok: false, error: '模型配置不存在或不完整' });
  try { return await pipeSSE(improveWritingStream(text, { root, lease: leaseOf(req), profile: prof })); }
  catch (e) { return sendJson(502, { ok: false, error: '模型调用失败：' + String((e && e.message) || e).slice(0, 200) }); }
}
```

### 5.5 编排与面板对应关系

- 编排：`ai-helper.mjs` 导出 `customRewriteStream(text, userRequirement, {root,lease,meta,profile})`、
  `improveWritingStream(text, {root,lease,meta,profile})` —— 返回 async generator，prompt 与非流式版逐字节一致。
- 面板：`postStream(url, body, onDelta)` → `beginOutput(title)` 亮卡 → `appendOutput` 逐段追加文本节点 → `[DONE]` 置完成。
  `done=false`（断网/连接重置）保留已收部分 + 「连接中断」中文警告；起步错误仍是 JSON 分支（409/4xx/502 同 postJson）。
