// ai-panel.js — 编辑器 AI 面板（选区改写 + 对话整篇）；由 server /edit 注入，/save 时剥离
(function () {
  var DOC_ID = document.currentScript.getAttribute('data-doc');
  var sheet = document.querySelector('.sheet');
  if (!sheet) return;
  // 图标：服务端把 SVG 随页面下发（vendors/icons.mjs 是唯一来源，客户端不自己拼 SVG）；
  // 没有注入时降级为空串 —— 不炸，也不显示图标。
  var __icon = window.__icon || function () { return ''; };
  var __status = window.__status || function (el, kind, text) { if (el) el.textContent = text; };

  // 幂等护栏：清掉历史保存意外落盘/重复注入的面板 DOM 与样式，防复利膨胀
  ['ai-toggle', 'ai-drawer', 'ai-sel-btn', 'ai-pop'].forEach(function (id) {
    var stale = document.getElementById(id);
    if (stale) stale.remove();
  });
  document.querySelectorAll('style[data-ai-panel]').forEach(function (el) { el.remove(); });

  // 注释对定位：运行时 DOM 挂进 <!--AI-INJECT-->…<!--/AI-INJECT--> 之间，/save 时被服务端正则剥离
  function findComment(text) {
    var it = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
    var n;
    while ((n = it.nextNode())) { if (n.data === text) return n; }
    return null;
  }

  var css = document.createElement('style');
  css.setAttribute('data-ai-panel', '1');
  css.textContent = '#ai-toggle{position:fixed;right:16px;bottom:16px;z-index:101;width:44px;height:44px;border-radius:50%;border:none;background:var(--ed-accent);color:var(--ed-accent-ink);font-size:20px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.18)}'
    + '#ai-toggle svg{width:20px;height:20px}'
    + '#ai-drawer{position:fixed;right:0;top:0;bottom:0;width:380px;background:var(--ed-panel);border-left:1px solid var(--ed-line);z-index:101;display:none;flex-direction:column;box-shadow:-4px 0 16px rgba(60,45,25,.08);font-size:13px;font-family:"PingFang SC",-apple-system,sans-serif}'
    + '#ai-drawer.open{display:flex}'
    + '#ai-drawer header{padding:10px 12px;font-weight:700;border-bottom:1px solid var(--ed-line);display:flex;justify-content:space-between;align-items:center;background:var(--ed-panel)}'
    + '#ai-close{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px;font-size:14px;border-radius:6px;border:1px solid var(--ed-line);background:var(--ed-panel)}'
    + '#ai-close:hover{background:var(--ed-bg)}'
    + '#ai-tabs{display:flex;border-bottom:1px solid var(--ed-line);background:var(--ed-panel);flex:none}'
    + '#ai-tabs button{flex:1;padding:8px 0;background:var(--ed-panel);border:none;border-right:1px solid var(--ed-line);font-weight:600;cursor:pointer;font-size:12px;color:var(--ed-mut);min-height:32px}'
    + '#ai-tabs button:last-child{border-right:none}'
    + '#ai-tabs button.on{background:var(--ed-panel);color:var(--ed-accent);box-shadow:inset 0 -2px 0 var(--ed-accent)}'
    + '.ai-pane{display:none;flex:1;flex-direction:column;min-height:0}'
    + '.ai-pane.on{display:flex}'
    + '#ai-pane-review{overflow:auto}'
    + '.ai-actions{padding:10px;border-bottom:1px solid var(--ed-line);background:var(--ed-panel);display:flex;gap:8px;flex-wrap:wrap;flex:none}'
    + '.ai-actions button{min-height:30px;padding:0 12px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink);transition:transform .12s,box-shadow .12s}'
    + '.ai-actions button:hover{transform:translateY(-1px);box-shadow:0 3px 9px rgba(60,45,25,.12)}'
    + '.ai-actions button:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}'
    + '#ai-review-out{padding:10px;overflow:auto;flex:1}'
    + '.ai-score{border:1px solid var(--ed-line);border-radius:12px;box-shadow:0 1px 3px rgba(60,45,25,.06);background:var(--ed-panel);padding:10px;text-align:center;margin:8px 0;font-size:13px}'
    + '.ai-score b{font-size:32px;display:block;color:var(--ed-accent)}'
    + '#ai-log{flex:1;overflow:auto;padding:10px 12px}'
    + '#ai-drawer .msg,#ed-right .msg{margin:8px 0;padding:8px 10px;border-radius:10px;border:1px solid var(--ed-line);background:var(--ed-panel);box-shadow:0 1px 2px rgba(60,45,25,.04);white-space:pre-wrap}'
    + '#ai-drawer .msg.user,#ed-right .msg.user{background:var(--ed-accent-soft)}'
    + '#ai-input{display:flex;gap:6px;padding:10px;border-top:1px solid var(--ed-line);background:var(--ed-panel)}'
    + '#ai-input input{flex:1;padding:6px 8px;border:1px solid var(--ed-line);border-radius:8px;background:var(--ed-panel)}'
    + '#ai-input button,#ai-pop button{border:none;border-radius:8px;background:var(--ed-accent);color:var(--ed-accent-ink);padding:6px 12px;font-weight:600;cursor:pointer;min-height:30px}'
    + '#ai-input button:disabled{opacity:.55;cursor:not-allowed}'
    + '.ai-change{border:1px solid var(--ed-line);border-radius:10px;box-shadow:0 1px 2px rgba(60,45,25,.04);background:var(--ed-panel);padding:8px;margin:8px 0}'
    + '.ai-before{background:var(--ed-err-soft);text-decoration:line-through;padding:4px;border-radius:6px;margin-bottom:4px;white-space:pre-wrap}'
    + '.ai-after{background:var(--ed-ok-soft);padding:4px;border-radius:6px;white-space:pre-wrap}'
    + '.ai-change button{margin:6px 6px 0 0;border:1px solid var(--ed-line);border-radius:6px;background:var(--ed-panel);padding:3px 10px;cursor:pointer;min-height:26px}'
    + '.ai-change button:first-of-type{background:var(--ed-accent);color:var(--ed-accent-ink);border-color:var(--ed-accent)}'
    + '#ai-sel-btn{position:absolute;z-index:99;display:none;padding:4px 10px;background:var(--ed-accent);color:var(--ed-accent-ink);border:none;border-radius:6px;cursor:pointer;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.15)}'
    + '#ai-pop{position:absolute;z-index:99;background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:12px;box-shadow:0 4px 14px rgba(60,45,25,.12);padding:8px;display:none;width:360px;font-size:13px}'
    + '#ai-pop textarea{width:100%;height:56px;font-size:13px;box-sizing:border-box;border:1px solid var(--ed-line);border-radius:8px;background:var(--ed-panel)}'
    + '#ai-pop .preview{max-height:200px;overflow:auto;margin-top:6px}'
    + '#ai-pop .row{margin-top:6px;text-align:right}'
    + '@media print{#ai-toggle,#ai-drawer,#ai-sel-btn,#ai-pop{display:none!important}}'
    + '#ai-drawer button:focus-visible,#ai-drawer input:focus-visible,#ai-pop button:focus-visible,#ai-pop textarea:focus-visible,#ai-toggle:focus-visible,#ai-sel-btn:focus-visible,#ed-right button:focus-visible,#ed-right textarea:focus-visible,#ed-right input:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    // 经典文档样式补丁：分页线基座（打印上下文的唯一着色来源——shell 的覆盖在 @media screen 内）。
    // 旧值是外来红家族（S2-B2 黑名单口径），A14 对齐 --ed-warn 色相（与屏幕覆盖一致）
    + '.page-line{border-top-color:rgba(162,87,17,.32)}'
    + '.page-line span{top:1.5mm;font-size:9px;color:rgba(162,87,17,.7)}';
  document.head.appendChild(css);

  // 嵌入模式：外壳右栏存在时，AI 面板内容嵌入其中（抽屉模式仅作无外壳兜底，如直接打开文档文件）
  // S4a-T7：岗位匹配 Tab 已退役（能力由审阅 Tab 证据表承接），嵌入判定只看 ed-pane-ai
  var edPaneAi = document.getElementById('ed-pane-ai');
  var embedded = !!edPaneAi;

  var root = document.createElement('div');
  root.innerHTML = (embedded ? '' : '<button id="ai-toggle" title="AI 助手" aria-label="AI 助手">' + __icon('bot') + '</button>')
    + '<div id="ai-drawer"' + (embedded ? ' style="display:none"' : '') + '><header><span>' + __icon('bot') + ' AI 助手</span><span id="ai-close" role="button" tabindex="0" aria-label="关闭">' + __icon('x') + '</span></header>'
    + '<div id="ai-tabs"><button data-tab="chat" class="on">' + __icon('message-square') + ' 对话</button><button data-tab="review">' + __icon('stethoscope') + ' 体检</button></div>'
    + '<div id="ai-pane-chat" class="ai-pane on"><div id="ai-log" aria-live="polite"></div><div id="ai-input"><input id="ai-msg" placeholder="例如：把项目3精简一点" aria-label="对话输入"><button id="ai-send">发送</button></div></div>'
    + '<div id="ai-pane-review" class="ai-pane"><div class="ai-actions"><button id="ai-review-full">全面体检</button><button id="ai-review-quant">仅量化增强</button></div><div id="ai-review-out" aria-live="polite"></div></div></div>'
    + '<button id="ai-sel-btn">' + __icon('sparkles') + ' AI 改写</button>'
    + '<div id="ai-pop" role="dialog" aria-modal="true" aria-label="选区改写"><textarea id="ai-inst" placeholder="改写指令，例如：精简到两行、突出量化成果" aria-label="改写指令"></textarea>'
    + '<div class="row"><button id="ai-gen">生成预览</button></div><div class="preview" id="ai-preview"></div>'
    + '<div class="row" id="ai-actions" style="display:none"><button id="ai-apply">应用</button><button id="ai-cancel">取消</button></div></div>';
  // 挂进 AI-INJECT 注释对之间（/save 剥离不落盘）；无注释对（直接打开文档文件）兜底 append
  var endMark = findComment('/AI-INJECT');
  if (endMark) endMark.parentNode.insertBefore(root, endMark);
  else document.body.appendChild(root);

  // 嵌入模式：把面板内容搬进外壳右栏（AI 助手 = 对话+体检），DOM 移动不丢事件绑定
  // 注意：此处 $ 尚未定义（var 提升但赋值未到），用 document.getElementById
  if (embedded) {
    var tabsEl = document.getElementById('ai-tabs');
    edPaneAi.appendChild(tabsEl);
    edPaneAi.appendChild(document.getElementById('ai-pane-chat'));
    edPaneAi.appendChild(document.getElementById('ai-pane-review'));
  }

  var $ = function (id) { return document.getElementById(id); };
  var log = $('ai-log'), history = [];

  function addMsg(text, isUser) {
    var d = document.createElement('div');
    d.className = 'msg' + (isUser ? ' user' : '');
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  // 状态提示：图标（服务端下发）+ 转义文本 —— 替代原来的裸 emoji 前缀
  function addStatus(text, kind) {
    var d = document.createElement('div');
    d.className = 'msg';
    log.appendChild(d);
    __status(d, kind, text);
    log.scrollTop = log.scrollHeight;
  }
  // 静态引导文案（无用户数据）：允许内联图标
  function addHtml(html) {
    var d = document.createElement('div');
    d.className = 'msg';
    d.innerHTML = html;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  // 空态引导（不持久、不进对话历史）；S4a-T7：岗位匹配已退役，引导不再提及
  addHtml(embedded
    ? __icon('hand') + ' 使用引导：\n· 选中正文文字 → 浮动工具条选改写方向\n· 「' + __icon('stethoscope') + ' 体检」出多维诊断报告\n所有建议都可逐条 应用 / ' + __icon('map-pin') + ' 定位 / 跳过 / 撤销'
    : __icon('hand') + ' 使用引导：\n· 选中正文一句话 → 点「' + __icon('sparkles') + ' AI 改写」逐句精简\n· 「' + __icon('stethoscope') + ' 体检」出五维诊断报告\n所有建议都可逐条 应用 / ' + __icon('map-pin') + ' 定位 / 跳过 / 撤销');

  // 共享应用通道：在文档里找 before 文本并替换（支持跨加粗等 DOM 节点、定位第 N 个重复位置）
  // opts: { occurrence?: number, context?: string }

  // AI 请求前确保当前内容已落盘，并带上内容版本（服务端据此拒绝落后内容）
  // 保存失败必须上抛：吞掉异常会带着旧 mtime 继续请求，服务端基于过期内容做体检/对话，
  // 给出基于旧文档的改写建议（用户看到的却是新内容）。调用方（sendChat/runReview）已在 try 内
  async function flushFirst() {
    // AUD-02：保存钩子返回 false 也是失败 —— 模板的 doSave 失败时 return false 而不抛，
    // 「保存中再次触发」也 return false。漏看返回值 → 带着旧 mtime 继续请求，
    // 服务端基于过期正文给出基于旧文档的建议（用户看到的却是新内容）。
    // 四项缺一不可：钩子存在、返回 true、已不 dirty、版本号有效。
    if (typeof window.__edFlushSave !== 'function') throw new Error('当前编辑器无法确认保存，请刷新后重试');
    var ok = await window.__edFlushSave();
    if (ok !== true) throw new Error('当前修改尚未保存成功，已停止本次请求（请先保存再试）');
    if (typeof window.__edIsDirty === 'function' && window.__edIsDirty()) throw new Error('保存期间又有新修改，已停止本次请求（请稍后重试）');
    var mt = Number(window.__edDocMtime || 0);
    if (!Number.isFinite(mt) || mt <= 0) throw new Error('缺少已确认的文档版本，已停止本次请求');
    return mt;
  }

  function aiError(e) {
    addStatus(e.message || e, 'warn');
  }

  // 统一写请求语义（AUD-15）：HTTP 状态与业务 ok 都要过；网络异常与业务拒绝都进失败分支，
  // 由调用方给出提示并保留用户输入。409 保留原有两种语义：JSON 体 = 文档版本陈旧（stale），
  // 文本体 = 服务端的其它拒绝。
  async function postJson(url, body) {
    var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 409) {
      var ct = (r.headers.get('content-type') || '');
      if (ct.includes('application/json')) {
        var d409 = await r.json().catch(function () { return null; });
        var e1 = new Error((d409 && d409.error) || '文档有未同步的修改');
        e1.stale = true;
        throw e1;
      }
      var t409 = await r.text();
      var e2 = new Error(t409 || '服务拒绝');
      e2.rejected = true;
      throw e2;
    }
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok || !data || data.ok !== true) {
      var e3 = new Error((data && (data.error || data.msg)) || ('HTTP ' + r.status));
      e3.rejected = true;
      throw e3;
    }
    return data;
  }

  // ===== 对话抽屉 =====
  // 嵌入模式：面板常驻右栏，setDrawer 转为「显示右栏 + 切 Tab」；兜底模式维持抽屉开关
  function setDrawer(open) {
    if (embedded) {
      var right = document.getElementById('ed-right');
      if (open && right) {
        right.classList.remove('ed-hidden');
        right.classList.add('ed-open');
        document.body.style.setProperty('--ed-right-w', window.innerWidth >= 768 ? '320px' : '0px');
      }
      return;
    }
    $('ai-drawer').classList.toggle('open', open);
  }
  if ($('ai-toggle')) $('ai-toggle').onclick = function () { setDrawer(!$('ai-drawer').classList.contains('open')); };
  if ($('ai-close')) {
    $('ai-close').onclick = function () { setDrawer(false); };
    $('ai-close').addEventListener('keydown', function (e) {   // A11：role=button 必须可键盘触发
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrawer(false); }
    });
  }

  var sending = false;
  async function sendChat() {
    var input = $('ai-msg'), msg = input.value.trim();
    if (!msg || sending) return;  // 防连点/Enter 重入：并发请求会打乱 history 顺序
    sending = true;
    $('ai-send').disabled = true;
    addMsg(msg, true);
    try {
      var mt = await flushFirst();
      var data = await postJson('/ai/chat', { id: DOC_ID, message: msg, history: history, baseMtime: mt });
      input.value = '';        // 成功后才清空：失败时用户输入保留（AUD-15）
      history.push({ role: 'user', content: msg }, { role: 'assistant', content: JSON.stringify(data) });
      if (data.reply) { addMsg(data.reply, false); return; }
      if (!data.changes || !data.changes.length) { addMsg('（AI 没有给出修改）', false); return; }
      data.changes.forEach(function (c) { renderChange(c); });
    } catch (e) {
      if (e && e.stale) addStatus('文档有未同步的修改，已自动保存，请重发这条消息', 'warn');
      else aiError(e);
    }
    finally { sending = false; $('ai-send').disabled = false; }
  }
  $('ai-send').onclick = sendChat;
  $('ai-msg').addEventListener('keydown', function (e) { if (e.key === 'Enter') sendChat(); });

  // 定位正文：用原生选区高亮 before 文本（selection 不进 innerHTML，不污染保存内容）
  function locateText(text) {
    var walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var i = node.data.indexOf(text);
      if (i >= 0) {
        var range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + text.length);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        (node.parentElement || sheet).scrollIntoView({ block: 'center', behavior: (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth' });   // A13
        return true;
      }
    }
    return false;
  }

  function renderChange(c, out) {
    out = out || log;
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
    var loc = document.createElement('button');
    loc.innerHTML = __icon('map-pin') + ' 定位';
    loc.title = '在正文中选中并滚动到原文位置';
    loc.onclick = function () { if (!locateText(c.before)) __status(note, 'warn', '原文未找到（可能已被修改）'); };
    apply.onclick = function () {
      // 应用前检查：找不到原文即拒绝（文档可能已被改）
      // 原文在正文里出现多次 → 改哪一处说不清 → 拒绝（2026-10-22 审查 [高] 同款问题：
      // 「取全文首个匹配」会改错段落，而面板照样显示「已应用」）
      if ((sheet.textContent || '').split(c.before).length - 1 > 1) {
        __status(note, 'warn', '原文在正文里出现多处，无法确定改哪一处，已拒绝（请手动修改）');
        return;
      }
      // 撤销身份：一次应用一个 opId，卡片 / 工具条 / Toast 共用同一个
      var opId = window.__edPushUndo ? window.__edPushUndo('AI：' + (c.note || '修改')) : null;
      if (window.__edReplaceText(c.before, c.after, { occurrence: c.occurrence, context: c.context })) {
        box.style.opacity = '0.6';
        apply.style.display = skip.style.display = loc.style.display = 'none';
        var undo = document.createElement('button');
        undo.textContent = '↩ 撤销';
        undo.onclick = function () {
          // AUD-04：撤销走统一撤销栈（按 opId 消费），不再按全文反向搜索 ——
          //   全文搜索会改到另一段含相同文本的段落（实测原目标被手改后，撤销改到了别处）；
          //   自己再反向替换还会与工具条撤销重复记账（同一次操作能被撤销两次）。
          //   整片快照回滚天然精确回到应用前，目标被手改时走既有确认门，拒绝改错段落。
          if (window.__edUndoLast && window.__edUndoLast(opId)) {
            box.style.opacity = '1';
            undo.remove();
            apply.style.display = skip.style.display = loc.style.display = '';
            apply.disabled = skip.disabled = false;
          } else { __status(note, 'warn', '撤销失败：改写后的内容已被再次修改，或该操作已被撤销'); }
        };
        box.appendChild(undo);
      }
      else {
        if (opId != null && window.__edDropUndo) window.__edDropUndo(opId);   // 失败不留空撤销记录
        __status(note, 'warn', '未在文档中找到原文（可能已被修改），未应用（可手动改）');
      }
    };
    skip.onclick = function () { box.style.opacity = '0.5'; apply.disabled = skip.disabled = true; loc.disabled = true; };
    box.append(note, b, a, apply, skip, loc);
    out.appendChild(box);
    out.scrollTop = out.scrollHeight;
  }

  // ===== Tab 切换 =====
  $('ai-tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    document.querySelectorAll('#ai-tabs button').forEach(function (t) { t.classList.toggle('on', t === b); });
    document.querySelectorAll('.ai-pane').forEach(function (p) { p.classList.toggle('on', p.id === 'ai-pane-' + b.dataset.tab); });
  });

  // ===== 报告渲染（体检/JD 共用契约：{report:{score,summary,items,changes}} 或 {reply}）=====
  function renderReport(out, data) {
    out.innerHTML = '';
    if (!data || !data.report) {
      var m0 = document.createElement('div');
      m0.className = 'msg';
      m0.textContent = (data && data.reply) || '（AI 没有给出报告）';
      out.appendChild(m0);
      return;
    }
    var r = data.report;
    if (typeof r.score === 'number') {
      var s = document.createElement('div');
      s.className = 'ai-score';
      var b = document.createElement('b');
      b.textContent = r.score;
      s.appendChild(b);
      s.appendChild(document.createTextNode('分'));
      if (r.scoreBasis) {
        var basis = document.createElement('div');
        basis.style.cssText = 'font-size:11px;color:var(--ed-mut);margin-top:4px';
        basis.textContent = '评分依据：' + r.scoreBasis;
        s.appendChild(basis);
      }
      out.appendChild(s);
    }
    if (r.summary) {
      var m = document.createElement('div');
      m.className = 'msg';
      m.textContent = r.summary;
      out.appendChild(m);
    }
    (r.items || []).forEach(function (it) {
      var d = document.createElement('div');
      d.className = 'msg';
      d.textContent = '· ' + it;
      out.appendChild(d);
    });
    (r.changes || []).forEach(function (c) { renderChange(c, out); });
  }

  // ===== 体检 =====
  var reviewing = false;
  async function runReview(mode) {
    if (reviewing) return;  // 防连点
    reviewing = true;
    var btn = mode === 'full' ? $('ai-review-full') : $('ai-review-quant');
    btn.disabled = true;
    var out = $('ai-review-out');
    out.textContent = '体检中（整篇分析约几十秒）…';
    try {
      var mt = await flushFirst();
      var data = await postJson('/ai/review', { id: DOC_ID, mode: mode, baseMtime: mt });
      renderReport(out, data);
    } catch (e) {
      if (e && e.stale) __status(out, 'warn', '文档有未同步修改，已自动保存，请重试');
      else __status(out, 'warn', e.message || e);
    }
    finally { reviewing = false; btn.disabled = false; }
  }
  $('ai-review-full').onclick = function () { runReview('full'); };
  $('ai-review-quant').onclick = function () { runReview('quant'); };

  // ===== 选区改写 =====
  // 预设指令（嵌入模式四按钮工具条；沿用 /ai/rewrite 审阅流，不静默覆盖正文）
  var PRESETS = {
    concise: '精简表达：压缩到最短，保留事实与数据，不丢关键信息',
    contrib: '突出个人贡献：明确"我"负责的环节、动作与产出，不夸大不编造',
    wording: '改善措辞：修正语病与口语化表达，保持原意与专业度',
    evidence: '补充证据：指出此处缺少哪些指标或事实，给出待补充占位提示，不编造任何数字'
  };
  var selText = '', selRect = null, selOcc = null;
  // 选区锚点：selText 在正文多处出现时算出用户选中的是第几处（occurrence，从 0 起），
  // 应用时传给 __edReplaceText——缺了它默认改全文第一处同名文本（选哪改哪说不清）。
  // 返回 null = 无法唯一定位（应用侧据此拒绝，与聊天路径「多处命中即拒」同口径）。
  function computeSelOcc(text, range) {
    var count = (sheet.textContent || '').split(text).length - 1;
    if (count <= 1) return 0;   // 唯一命中：occurrence=0 即该处，传不传等价
    if (!range) return null;
    // 与 __edReplaceText 同款文本流：把选区起点折算成流内偏移，落在哪处就是第几处
    var walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    var nodes = [], stream = '', n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: stream.length }); stream += n.data; }
    var selStart = null;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].node === range.startContainer) { selStart = nodes[i].start + range.startOffset; break; }
    }
    if (selStart == null) return null;   // 选区起点不在文本节点上（如直接框在元素上）
    if (stream.slice(selStart, selStart + text.length) !== text) return null;   // 选区与正文对不上（正文已变等）
    var occ = 0, idx = stream.indexOf(text);
    while (idx >= 0 && idx < selStart) { occ++; idx = stream.indexOf(text, idx + text.length); }
    return idx === selStart ? occ : null;
  }
  var seltb = embedded ? document.getElementById('ed-seltb') : null;
  var selBtn = $('ai-sel-btn');
  if (embedded && selBtn) selBtn.remove();  // 嵌入模式用 ed-seltb，旧单钮移除

  function positionToolbar(el, rect) {
    // 优先放选区上方（不遮挡选中文字），上方不足放下方；横向 clamp 在视口内
    el.style.display = embedded ? 'flex' : 'block';
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8));
    var top = rect.top - h - 6;
    if (top < 48) top = rect.bottom + 6;  // 顶栏下方不足时放选区下
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  sheet.addEventListener('mouseup', function () {
    var sel = window.getSelection();
    if (!sel.isCollapsed && sheet.contains(sel.anchorNode) && sel.toString().trim().length > 3) {
      selText = sel.toString();
      selOcc = computeSelOcc(selText, sel.getRangeAt(0));
      selRect = sel.getRangeAt(0).getBoundingClientRect();
      positionToolbar(seltb || selBtn, selRect);
    } else {
      if (seltb) seltb.style.display = 'none';
      if (selBtn) selBtn.style.display = 'none';
    }
  });
  // sheet 内部滚动时选区坐标失效，收起工具条
  sheet.addEventListener('scroll', function () {
    if (seltb) seltb.style.display = 'none';
    if (selBtn) selBtn.style.display = 'none';
  }, { passive: true });
  // A11：键盘选区（Shift+方向）也要能呼出工具条——mouseup 覆盖不到键盘路径。
  // 只做正向呼出，不在 else 里隐藏：隐藏仍归 mouseup/scroll，避免按钮点击瞬间浏览器
  // 清掉文档选区时 selectionchange 抢先把工具条藏掉、点击落空。
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !sheet.contains(sel.anchorNode)) return;
    if (sel.toString().trim().length <= 3) return;
    selText = sel.toString();
    selOcc = computeSelOcc(selText, sel.getRangeAt(0));
    selRect = sel.getRangeAt(0).getBoundingClientRect();
    positionToolbar(seltb || selBtn, selRect);
  });

  function openRewritePop(inst) {
    var pop = $('ai-pop');
    pop.style.display = 'block';
    var w = pop.offsetWidth;
    pop.style.left = Math.max(8, Math.min(selRect.left, window.innerWidth - w - 8)) + 'px';
    pop.style.top = (selRect.bottom + 6) + 'px';
    $('ai-preview').innerHTML = '';
    $('ai-actions').style.display = 'none';
    $('ai-inst').value = inst || '';
    $('ai-inst').focus();
  }
  if (seltb) {
    seltb.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-preset]');
      if (!b) return;
      seltb.style.display = 'none';
      openRewritePop(PRESETS[b.dataset.preset] || '');
    });
  }
  if (selBtn) {
    selBtn.onclick = function () {
      selBtn.style.display = 'none';
      openRewritePop('');
    };
  }

  var pendingAfter = null, pendingBefore = '', pendingOcc = null;
  $('ai-gen').onclick = async function () {
    var inst = $('ai-inst').value.trim();
    if (!inst) return;
    $('ai-gen').disabled = true;
    // 生成开始即冻结选区原文：请求/预览/应用三处必须用同一份快照，
    // 否则等待期间的新选区会让「原文」与「替换目标」错配，改到别的段落
    pendingBefore = selText;
    pendingOcc = selOcc;              // 选区锚点随快照一起冻结（请求/预览/应用三处同一份定位）
    pendingAfter = null;              // 每次生成前清掉上一次候选（失败也不留陈旧态）
    $('ai-actions').style.display = 'none';
    try {
      var data = await postJson('/ai/rewrite', { id: DOC_ID, text: pendingBefore, instruction: inst });
      pendingAfter = data.revised;
      $('ai-preview').innerHTML = '';
      var b = document.createElement('div'); b.className = 'ai-before'; b.textContent = pendingBefore;
      var a = document.createElement('div'); a.className = 'ai-after'; a.textContent = pendingAfter;
      $('ai-preview').append(b, a);
      $('ai-actions').style.display = 'block';
    } catch (e) {
      pendingAfter = null; pendingBefore = ''; pendingOcc = null;   // 失败不留可点的陈旧候选
      __status($('ai-preview'), 'warn', e.message || e);
    }
    finally { $('ai-gen').disabled = false; }
  };
  $('ai-apply').onclick = function () {
    if (pendingAfter) {
      // 多处命中且没有选区锚点 → 改哪一处说不清 → 拒绝（与聊天路径「多处命中即拒」同口径）。
      // 之前应用不传锚点，__edReplaceText 默认 chosen=0（全文首个匹配）——用户选第二处、第一处被改。
      if ((sheet.textContent || '').split(pendingBefore).length - 1 > 1 && typeof pendingOcc !== 'number') {
        __status($('ai-preview'), 'warn', '原文在正文里出现多处，无法确定改哪一处，已拒绝（请手动修改）');
        return;
      }
      var popOpId = window.__edPushUndo ? window.__edPushUndo('AI 改写') : null;
      if (window.__edReplaceText(pendingBefore, pendingAfter, typeof pendingOcc === 'number' ? { occurrence: pendingOcc } : undefined)) $('ai-pop').style.display = 'none';
      else if (popOpId != null && window.__edDropUndo) window.__edDropUndo(popOpId);   // 失败不留空撤销记录
      else __status($('ai-preview'), 'warn', '原文未找到（可能已被修改），未应用');
    }
  };
  $('ai-cancel').onclick = function () { $('ai-pop').style.display = 'none'; pendingAfter = null; pendingBefore = ''; pendingOcc = null; };
  document.addEventListener('mousedown', function (e) {
    if (!$('ai-pop').contains(e.target) && e.target.id !== 'ai-sel-btn') $('ai-pop').style.display = 'none';
  });
  // A11：ai-pop 是 dialog——Esc 单层关闭不穿透（stopImmediatePropagation，同 S2-T7 M6 口径），
  // Tab 圈定在弹层内（对齐外壳弹层 trapTab 模式）。
  document.addEventListener('keydown', function (e) {
    var pop = $('ai-pop');
    if (!pop || pop.style.display !== 'block') return;
    if (e.key === 'Escape') { e.stopImmediatePropagation(); $('ai-cancel').click(); return; }
    if (e.key !== 'Tab') return;
    var f = pop.querySelectorAll('button, textarea, input, [tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (!pop.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
})();
