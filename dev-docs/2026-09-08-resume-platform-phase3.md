# 简历平台 Phase 3 实施计划（大模型辅助修改）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 配置大模型 API key（OpenAI 兼容，火山方舟可直接用），编辑器内支持两种 AI 辅助：选区文字改写（预览→应用）与对话式整篇调整（逐条 before/after 建议→应用）。

**Architecture:** 沿用零框架单进程。新增三个文件：`ai.mjs`（prompt 构建 + 响应解析纯函数，可测）、`ai-panel.js`（编辑器 AI 面板，独立静态文件，serve 时注入）。配置存 `~/resume/config.json`。两种交互共享同一个 `findAndReplace(before, after)` 应用通道。

**Tech Stack:** Node 内置模块、fetch（内置）、浏览器原生 DOM API（contenteditable + TreeWalker）。

**Spec:** `docs/superpowers/specs/2026-08-17-resume-platform-design.md` Phase 3 节

**约束:**
- 禁止 git 操作；ponytail 原则
- **注入幂等纪律（终审沉淀的规则）**：serve 注入用 `<!--AI-INJECT-->` 注释标记包裹，`/save` 服务端剥离该标记块——save-serve 往返零累积
- AI 面板代码独立成 `ai-panel.js` 静态文件，不嵌进 server.mjs 字符串
- 无 config 时 AI 端点返回 409，面板引导去设置页
- 测试不烧真实 token：解析层纯函数测、端点测 409 路径

---

### Task 1: ai.mjs + settings 页 + AI 端点（409 路径）

**Files:**
- Create: `~/resume/ai.mjs`
- Modify: `~/resume/server.mjs`
- Modify: `~/resume/test.sh`、`~/resume/test-structure.sh`

**ai.mjs（完整代码——prompt 构建与解析都是纯函数，可注入测试）：**

```js
// ai.mjs — AI 辅助的 prompt 构建与响应解析（纯函数，无网络依赖）
export function buildRewrite(text, instruction) {
  return {
    sys: '你是简历文字编辑助手。按用户指令改写给定段落。只输出改写后的文字本身，不要解释、不要引号包裹、不要Markdown。保持事实不变，不要编造数字和经历。',
    user: `【原文】\n${text}\n\n【指令】\n${instruction}`
  };
}

export function buildChat(docText) {
  return `你是简历编辑助手。用户会告诉你想怎么改简历。你只输出 JSON 数组（不要任何其它文字），每个元素是一条修改：
[{"before":"文档中现有的原文片段（必须逐字，不超过80字）","after":"改后的文字","note":"这条改的什么"}]
只给真正需要改的地方；如果用户在闲聊或要求不明确，输出空数组 [] 并在 note 里没用——直接用中文简短回答会放到对话里（此时输出 {"reply":"..."} 单个对象）。

【当前简历全文】
${docText}`;
}

// 解析 LLM 输出：修改数组 或 {"reply":...} 对象；坏输出返回 null
export function parseChanges(raw) {
  try {
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const data = JSON.parse(cleaned);
    if (Array.isArray(data)) {
      return {
        changes: data.filter((c) => c && typeof c.before === 'string' && typeof c.after === 'string' && c.before.length > 0 && c.before !== c.after)
      };
    }
    if (data && typeof data.reply === 'string') return { reply: data.reply };
    return null;
  } catch {
    return null;
  }
}
```

**server.mjs 变更（4 处）：**

1. 顶部 import 区加：

```js
import { loadConfig, hasLLM, chat } from './llm.mjs';
import { buildRewrite, buildChat, parseChanges } from './ai.mjs';
```

（llm.mjs 已存在；loadConfig 也已存在，此处只是引入使用）

2. 列表页设置入口——`listPage()` 的 `<h1>简历平台</h1>` 后加一行：

```js
    <p><a href="/settings">⚙️ 大模型设置</a></p>
```

3. 新增三个端点（加在 /upload 分支之后）：

```js
    // 大模型设置页
    if (req.method === 'GET' && url.pathname === '/settings') {
      const c = loadConfig(root) || {};
      return send(200, page('大模型设置', `<h1>大模型设置</h1>
    <p>OpenAI 兼容格式，火山方舟可直接用（baseURL 填 <code>https://ark.cn-beijing.volces.com/api/v3</code>）。配置存本地 config.json，不进任何仓库。</p>
    <form id="f">
      <p>Base URL<br><input id="baseURL" size="50" value="${c.baseURL || ''}"></p>
      <p>API Key<br><input id="apiKey" size="50" type="password" value="${c.apiKey || ''}"></p>
      <p>模型<br><input id="model" size="50" value="${c.model || ''}"></p>
      <button>保存</button> <a href="/">返回首页</a> <span id="msg"></span>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', async function (e) {
        e.preventDefault();
        var r = await fetch('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseURL: document.getElementById('baseURL').value.trim(),
            apiKey: document.getElementById('apiKey').value.trim(),
            model: document.getElementById('model').value.trim() }) });
        document.getElementById('msg').textContent = r.ok ? ' ✅ 已保存' : ' ❌ ' + (await r.text());
      });
    </script>`));
    }
    // 保存设置
    if (req.method === 'POST' && url.pathname === '/settings') {
      const body = JSON.parse(await readBody(req));
      if (!body.baseURL || !body.apiKey || !body.model) return send(400, '三个字段都要填', 'text/plain');
      fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ baseURL: body.baseURL, apiKey: body.apiKey, model: body.model }, null, 2));
      return send(200, JSON.stringify({ ok: true }), 'application/json');
    }
    // AI 改写（选区）
    if (req.method === 'POST' && url.pathname === '/ai/rewrite') {
      if (!hasLLM(root)) return send(409, '未配置大模型，请先到首页的"⚙️ 大模型设置"', 'text/plain');
      const body = JSON.parse(await readBody(req));
      if (!body.text || !body.instruction) return send(400, 'text 和 instruction 必填', 'text/plain');
      const p = buildRewrite(body.text, body.instruction);
      const revised = await chat(root, p.sys, p.user);
      return send(200, JSON.stringify({ ok: true, revised }), 'application/json');
    }
    // AI 对话（整篇）
    if (req.method === 'POST' && url.pathname === '/ai/chat') {
      if (!hasLLM(root)) return send(409, '未配置大模型，请先到首页的"⚙️ 大模型设置"', 'text/plain');
      const body = JSON.parse(await readBody(req));
      if (!body.message) return send(400, 'message 必填', 'text/plain');
      const docHtml = fs.existsSync(docPath(body.id || id)) ? fs.readFileSync(docPath(body.id || id), 'utf8') : '';
      const docText = docHtml.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const msgs = [{ role: 'system', content: buildChat(docText) }];
      for (const m of (body.history || []).slice(-10)) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') msgs.push({ role: m.role, content: m.content });
      }
      msgs.push({ role: 'user', content: body.message });
      const raw = await chatMsgs(root, msgs);
      const parsed = parseChanges(raw);
      return send(200, JSON.stringify({ ok: true, ...(parsed || { reply: raw }) }), 'application/json');
    }
```

4. llm.mjs 的 chat() 是 (sys, user) 两参形态；/ai/chat 需要多消息形态——**在 llm.mjs 末尾加一个 chatMsgs**（chat 重构为它的特例，一行改动保持兼容）：

```js
// chatMsgs — 多消息形态；chat 是它的两消息特例
export async function chatMsgs(root, messages) {
  const c = loadConfig(root);
  if (!c) throw new Error('LLM 未配置');
  const r = await fetch(`${c.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.model, messages, temperature: 0.2 }),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`LLM 请求失败: ${r.status}`);
  const data = await r.json();
  return data.choices[0].message.content;
}
```

并把现有 chat() 改为（行为不变）：

```js
export async function chat(root, system, user) {
  return chatMsgs(root, [{ role: 'system', content: system }, { role: 'user', content: user }]);
}
```

同时 server.mjs 的 /ai/chat 分支 import 处补 `chatMsgs`：`import { loadConfig, hasLLM, chat, chatMsgs } from './llm.mjs';`

**测试（test.sh 追加第 8 节；放在上传断言之后）**：

```bash
# 8. Phase 3：设置页 + AI 端点 409 路径
curl -sf "http://localhost:$PORT/settings" | grep -q '大模型设置' && echo '✅ 设置页'
curl -s -X POST "http://localhost:$PORT/settings" -H 'Content-Type: application/json' -d '{"baseURL":"http://127.0.0.1:9/x","apiKey":"testkey","model":"test-model"}' | grep -q '"ok":true' && echo '✅ 设置保存'
test -f config.json && echo '✅ config.json 落盘'
curl -s -X POST "http://localhost:$PORT/ai/rewrite" -H 'Content-Type: application/json' -d '{"text":"a","instruction":"b"}' -o /dev/null -w '%{http_code}' | grep -q 409 && echo '⚠️ 注意：config.json 存在时 409 断言失效' || true
rm -f config.json   # 设置测试完毕即删，恢复无配置状态（不影响其它测试的降级路径）
curl -s -X POST "http://localhost:$PORT/ai/rewrite" -H 'Content-Type: application/json' -d '{"text":"a","instruction":"b"}' -o /dev/null -w '%{http_code}' | grep -q 409 && echo '✅ AI 改写未配置拦截'
curl -s -X POST "http://localhost:$PORT/ai/chat" -H 'Content-Type: application/json' -d '{"message":"x"}' -o /dev/null -w '%{http_code}' | grep -q 409 && echo '✅ AI 对话未配置拦截'
```

注意时序：设置保存→删 config 之间的 409 断言是假的（配置在），所以打印提示不算数；真正的 409 断言在 rm 之后。

**test-structure.sh 追加 parseChanges 用例：**

```js
// parseChanges 解析（Phase 3）
const { parseChanges } = await import('./ai.mjs');
const good = parseChanges('[{"before":"旧","after":"新","note":"x"}]');
if (!good || good.changes.length !== 1 || good.changes[0].before !== '旧') { console.error('❌ parseChanges 好 JSON'); process.exit(1); }
const fenced = parseChanges('```json\n[{"before":"a","after":"b"}]\n```');
if (!fenced || fenced.changes.length !== 1) { console.error('❌ parseChanges 围栏'); process.exit(1); }
const reply = parseChanges('{"reply":"这是闲聊回答"}');
if (!reply || reply.reply !== '这是闲聊回答') { console.error('❌ parseChanges reply'); process.exit(1); }
if (parseChanges('胡说八道') !== null) { console.error('❌ parseChanges 坏输出未拦截'); process.exit(1); }
const empty = parseChanges('[{"before":"","after":"x"},{"before":"a","after":"a"}]');
if (!empty || empty.changes.length !== 0) { console.error('❌ parseChanges 未过滤无效修改'); process.exit(1); }
console.log('✅ parseChanges 五路径正确');
```

- [ ] **Step 1:** 先追加两处测试，跑确认失败（/settings 404、ai.mjs 不存在）
- [ ] **Step 2:** 写 ai.mjs、改 llm.mjs（chatMsgs）、改 server.mjs（4 处）
- [ ] **Step 3:** `bash ~/resume/test.sh` + `bash ~/resume/test-structure.sh` 双绿

---

### Task 2: 编辑器 AI 面板（ai-panel.js + serve 注入 + save 剥离）

**Files:**
- Create: `~/resume/ai-panel.js`
- Modify: `~/resume/server.mjs`（静态文件路由 + 注入 + 剥离）
- Modify: `~/resume/test.sh`

**ai-panel.js（完整代码——选区改写浮窗 + 对话抽屉，共享 findAndReplace）：**

```js
// ai-panel.js — 编辑器 AI 面板（选区改写 + 对话整篇）；由 server /edit 注入，/save 时剥离
(function () {
  var DOC_ID = document.currentScript.getAttribute('data-doc');
  var sheet = document.querySelector('.sheet');
  if (!sheet) return;

  var css = document.createElement('style');
  css.textContent = '#ai-toggle{position:fixed;right:16px;bottom:16px;z-index:98;width:44px;height:44px;border-radius:50%;border:none;background:#7c3aed;color:#fff;font-size:20px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3)}'
    + '#ai-drawer{position:fixed;right:0;top:0;bottom:0;width:380px;background:#fff;border-left:1px solid #ddd;z-index:98;display:none;flex-direction:column;box-shadow:-4px 0 16px rgba(0,0,0,.12);font-size:13px;font-family:"PingFang SC",sans-serif}'
    + '#ai-drawer.open{display:flex}'
    + '#ai-drawer header{padding:10px 12px;font-weight:700;border-bottom:1px solid #eee;display:flex;justify-content:space-between}'
    + '#ai-log{flex:1;overflow:auto;padding:10px 12px}'
    + '#ai-log .msg{margin:8px 0;padding:8px 10px;border-radius:8px;background:#f3f4f6;white-space:pre-wrap}'
    + '#ai-log .msg.user{background:#ede9fe}'
    + '#ai-input{display:flex;gap:6px;padding:10px;border-top:1px solid #eee}'
    + '#ai-input input{flex:1;padding:6px 8px;border:1px solid #ccc;border-radius:6px}'
    + '.ai-change{border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin:8px 0}'
    + '.ai-before{background:#fee2e2;text-decoration:line-through;padding:4px;border-radius:4px;margin-bottom:4px;white-space:pre-wrap}'
    + '.ai-after{background:#dcfce7;padding:4px;border-radius:4px;white-space:pre-wrap}'
    + '.ai-change button{margin:6px 6px 0 0}'
    + '#ai-sel-btn{position:absolute;z-index:99;display:none;padding:4px 10px;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px}'
    + '#ai-pop{position:absolute;z-index:99;background:#fff;border:1px solid #ccc;border-radius:8px;padding:8px;box-shadow:0 4px 14px rgba(0,0,0,.18);display:none;width:360px;font-size:13px}'
    + '#ai-pop textarea{width:100%;height:56px;font-size:13px;box-sizing:border-box}'
    + '#ai-pop .preview{max-height:200px;overflow:auto;margin-top:6px}'
    + '#ai-pop .row{margin-top:6px;text-align:right}'
    + '@media print{#ai-toggle,#ai-drawer,#ai-sel-btn,#ai-pop{display:none!important}}';
  document.head.appendChild(css);

  var root = document.createElement('div');
  root.innerHTML = '<button id="ai-toggle" title="AI 助手">🤖</button>'
    + '<div id="ai-drawer"><header><span>🤖 AI 助手（对话改简历）</span><span id="ai-close" style="cursor:pointer">✕</span></header>'
    + '<div id="ai-log"></div><div id="ai-input"><input id="ai-msg" placeholder="例如：把项目3精简一点"><button id="ai-send">发送</button></div></div>'
    + '<button id="ai-sel-btn">✨ AI 改写</button>'
    + '<div id="ai-pop"><textarea id="ai-inst" placeholder="改写指令，例如：精简到两行、突出量化成果"></textarea>'
    + '<div class="row"><button id="ai-gen">生成预览</button></div><div class="preview" id="ai-preview"></div>'
    + '<div class="row" id="ai-actions" style="display:none"><button id="ai-apply">应用</button><button id="ai-cancel">取消</button></div></div>';
  document.body.appendChild(root);

  var $ = function (id) { return document.getElementById(id); };
  var log = $('ai-log'), history = [];

  function addMsg(text, isUser) {
    var d = document.createElement('div');
    d.className = 'msg' + (isUser ? ' user' : '');
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  // 共享应用通道：在文档里找 before 文本并替换
  function findAndReplace(before, after) {
    var walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var i = node.data.indexOf(before);
      if (i >= 0) {
        node.data = node.data.slice(0, i) + after + node.data.slice(i + before.length);
        sheet.dispatchEvent(new Event('input', { bubbles: true }));  // 触发本地自动保存兜底
        return true;
      }
    }
    return false;
  }

  function aiError(e) {
    addMsg('⚠️ ' + (e.message || e) + (String(e).includes('409') ? '' : ''), false);
  }

  // ===== 对话抽屉 =====
  $('ai-toggle').onclick = function () { $('ai-drawer').classList.toggle('open'); };
  $('ai-close').onclick = function () { $('ai-drawer').classList.remove('open'); };

  async function sendChat() {
    var input = $('ai-msg'), msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    addMsg(msg, true);
    try {
      var r = await fetch('/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: DOC_ID, message: msg, history: history }) });
      if (r.status === 409) { addMsg(await r.text(), false); return; }
      var data = await r.json();
      history.push({ role: 'user', content: msg }, { role: 'assistant', content: JSON.stringify(data) });
      if (data.reply) { addMsg(data.reply, false); return; }
      if (!data.changes || !data.changes.length) { addMsg('（AI 没有给出修改）', false); return; }
      data.changes.forEach(function (c) { renderChange(c); });
    } catch (e) { aiError(e); }
  }
  $('ai-send').onclick = sendChat;
  $('ai-msg').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });

  function renderChange(c) {
    var box = document.createElement('div');
    box.className = 'ai-change';
    var note = document.createElement('div');
    note.textContent = c.note || '';
    var b = document.createElement('div');
    b.className = 'ai-before'; b.textContent = c.before;
    var a = document.createElement('div');
    a.className = 'ai-after'; a.textContent = c.after;
    var apply = document.createElement('button');
    apply.textContent = '应用';
    var skip = document.createElement('button');
    skip.textContent = '跳过';
    apply.onclick = function () {
      if (findAndReplace(c.before, c.after)) { box.style.opacity = '0.5'; apply.disabled = skip.disabled = true; }
      else { note.textContent = '⚠️ 未在文档中找到原文，未应用（可手动改）'; }
    };
    skip.onclick = function () { box.style.opacity = '0.5'; apply.disabled = skip.disabled = true; };
    box.append(note, b, a, apply, skip);
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }

  // ===== 选区改写 =====
  var selText = '', selRect = null;
  sheet.addEventListener('mouseup', function () {
    var sel = window.getSelection();
    if (!sel.isCollapsed && sheet.contains(sel.anchorNode) && sel.toString().trim().length > 3) {
      selText = sel.toString();
      selRect = sel.getRangeAt(0).getBoundingClientRect();
      var btn = $('ai-sel-btn');
      btn.style.left = (selRect.left + window.scrollX) + 'px';
      btn.style.top = (selRect.bottom + window.scrollY + 4) + 'px';
      btn.style.display = 'block';
    } else {
      $('ai-sel-btn').style.display = 'none';
    }
  });

  $('ai-sel-btn').onclick = function () {
    $('ai-sel-btn').style.display = 'none';
    var pop = $('ai-pop');
    pop.style.left = (selRect.left + window.scrollX) + 'px';
    pop.style.top = (selRect.bottom + window.scrollY + 6) + 'px';
    pop.style.display = 'block';
    $('ai-preview').innerHTML = '';
    $('ai-actions').style.display = 'none';
    $('ai-inst').value = '';
    $('ai-inst').focus();
  };

  var pendingAfter = null;
  $('ai-gen').onclick = async function () {
    var inst = $('ai-inst').value.trim();
    if (!inst) return;
    $('ai-gen').disabled = true;
    try {
      var r = await fetch('/ai/rewrite', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: DOC_ID, text: selText, instruction: inst }) });
      if (r.status === 409) { $('ai-preview').textContent = await r.text(); return; }
      var data = await r.json();
      pendingAfter = data.revised;
      $('ai-preview').innerHTML = '';
      var b = document.createElement('div'); b.className = 'ai-before'; b.textContent = selText;
      var a = document.createElement('div'); a.className = 'ai-after'; a.textContent = pendingAfter;
      $('ai-preview').append(b, a);
      $('ai-actions').style.display = 'block';
    } catch (e) { $('ai-preview').textContent = '⚠️ ' + (e.message || e); }
    finally { $('ai-gen').disabled = false; }
  };
  $('ai-apply').onclick = function () {
    if (pendingAfter && findAndReplace(selText, pendingAfter)) {
      $('ai-pop').style.display = 'none';
    }
  };
  $('ai-cancel').onclick = function () { $('ai-pop').style.display = 'none'; };
  document.addEventListener('mousedown', function (e) {
    if (!$('ai-pop').contains(e.target) && e.target.id !== 'ai-sel-btn') $('ai-pop').style.display = 'none';
  });
})();
```

**server.mjs 变更（3 处）：**

1. 注入块构造函数（加在 page() helper 附近）：

```js
const AI_MARK = '<!--AI-INJECT-->';
function aiBlock(id) {
  return `\n${AI_MARK}<script src="/ai-panel.js" data-doc="${id}" defer></script><!--/AI-INJECT-->\n`;
}
```

2. /edit 分支注入（在 DOC_ID 校验之后、返回之前加；幂等：已含标记则跳过）：

```js
      if (!html.includes(AI_MARK)) html = html.replace('</body>', aiBlock(id) + '</body>');
```

3. /save 剥离（在 `snapshot(id);` 之前加——保存进文档的内容永远不带注入块）：

```js
      const html = (await readBody(req)).replace(/\n?<!--AI-INJECT-->[\s\S]*?<!--\/AI-INJECT-->\n?/g, '\n');
```

注意：/save 原有行是 `const html = await readBody(req);`——整行替换为上面这行。

4. 静态文件路由（加在 /settings 分支之前）：

```js
    // AI 面板静态文件
    if (req.method === 'GET' && url.pathname === '/ai-panel.js') {
      return send(200, fs.readFileSync(path.join(root, 'ai-panel.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
```

**测试（test.sh 追加第 9 节）：**

```bash
# 9. Phase 3：AI 面板注入与剥离（幂等）
python3 - << 'PYEOF'
import os, urllib.request
port = os.environ['PORT']
html = urllib.request.urlopen(f'http://localhost:{port}/edit?id=smoketest').read().decode()
assert html.count('<!--AI-INJECT-->') == 1, '注入块应恰好 1 个'
assert 'ai-panel.js' in html and 'data-doc="smoketest"' in html, '注入块内容不对'
req = urllib.request.Request(f'http://localhost:{port}/save?id=smoketest', data=html.encode(), headers={'Content-Type': 'text/html'})
urllib.request.urlopen(req)
onDisk = open('docs/smoketest.html').read()
assert '<!--AI-INJECT-->' not in onDisk, '注入块不应落盘'
html2 = urllib.request.urlopen(f'http://localhost:{port}/edit?id=smoketest').read().decode()
assert html2.count('<!--AI-INJECT-->') == 1, '保存后再 serve 注入块仍应恰好 1 个'
print('✅ AI 注入/剥离幂等')
PYEOF
curl -sf "http://localhost:$PORT/ai-panel.js" | grep -q 'findAndReplace' && echo '✅ ai-panel.js 可访问'
```

- [ ] **Step 1:** 先追加测试，跑确认失败（无注入块、ai-panel.js 404）
- [ ] **Step 2:** 写 ai-panel.js + server.mjs 3+1 处变更
- [ ] **Step 3:** `bash ~/resume/test.sh` 全绿 + `bash ~/resume/test-structure.sh` 不回归

---

### Task 3: 重启 + 全量回归 + README + 验收

**Files:**
- Modify: `~/resume/README.md`

- [ ] **Step 1: 重启常驻服务**

```bash
launchctl bootout gui/$(id -u)/com.lhx.resume-server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lhx.resume-server.plist
sleep 2
curl -sf http://localhost:7890/settings | grep -q '大模型设置' && echo '✅ 设置页上线'
curl -sf "http://localhost:7890/edit?id=linghaoxiang" | grep -q 'ai-panel.js' && echo '✅ AI 面板注入'
```

- [ ] **Step 2: 全量回归**

```bash
bash ~/resume/test.sh && bash ~/resume/test-structure.sh && bash ~/resume/test-render.sh && echo '✅ Phase 3 全量回归通过'
```

- [ ] **Step 3: README 更新**（使用节追加）

```markdown
- 大模型设置：http://localhost:7890/settings（OpenAI 兼容；火山方舟 baseURL 见 config.example.json）
- AI 辅助：编辑器里选中文字点"✨ AI 改写"（预览后应用）；右下角 🤖 打开对话整篇调整
- config.json 含 API key，属于本地私密文件，不要分享/提交
```

- [ ] **Step 4: 实机验收引导**

```bash
open http://localhost:7890/settings
```

提示用户填入真实 key 后：编辑器选一段文字 → ✨ AI 改写 → 预览 → 应用 → 保存 → PDF 验证。

---

## Self-Review 结论（已执行）

- **Spec 覆盖**：settings 页 / 区块改写 / 对话整篇 / 共享应用通道 / config.json 本地私密 → Task 1-3 全覆盖
- **注入幂等规则落实**：AI 面板 = 标记包裹注入 + save 服务端剥离 + test.sh 幂等断言（含落盘检查）
- **一致性**：`chatMsgs(root, messages)` 签名在 llm.mjs 定义与 server.mjs 调用一致；`buildRewrite/buildChat/parseChanges` 导出与 import 一致；`parseChanges` 返回形态（{changes}|{reply}|null）与 /ai/chat 分支和面板渲染一致
- **占位符**：无 TBD，全部代码完整
- **known ceiling**：before 文本跨标签时 findAndReplace 未命中（引导用户手动）；LLM 输出不守 JSON 时走 reply 兜底展示
