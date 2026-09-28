// ai-panel.js — 编辑器 AI 面板（选区改写 + 对话整篇）；由 server /edit 注入，/save 时剥离
(function () {
  var DOC_ID = document.currentScript.getAttribute('data-doc');
  var sheet = document.querySelector('.sheet');
  if (!sheet) return;

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
    + '#ai-pane-review,#ai-pane-match{overflow:auto}'
    + '.ai-actions{padding:10px;border-bottom:1px solid var(--ed-line);background:var(--ed-panel);display:flex;gap:8px;flex-wrap:wrap;flex:none}'
    + '.ai-actions button{min-height:30px;padding:0 12px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink);transition:transform .12s,box-shadow .12s}'
    + '.ai-actions button:hover{transform:translateY(-1px);box-shadow:0 3px 9px rgba(60,45,25,.12)}'
    + '.ai-actions button:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}'
    + '#ai-jd{width:100%;height:110px;border:1px solid var(--ed-line);border-radius:8px;padding:6px;box-sizing:border-box;font-size:12px}'
    + '#ai-review-out,#ai-match-out{padding:10px;overflow:auto;flex:1}'
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
    // 经典文档样式补丁：经典模板文档的 D2/D4/D9 改进（工具栏加高/分页线淡化/焦点环），
    // serve 注入覆盖、/save 随面板剥离；template.html 经典版已内含同款值，此处为幂等覆盖
    + '.page-line{border-top-color:rgba(231,76,60,.32)}'
    + '.page-line span{top:1.5mm;font-size:9px;color:rgba(231,76,60,.7)}';
  document.head.appendChild(css);

  // 嵌入模式：外壳右栏存在时，AI 面板内容嵌入其中（抽屉模式仅作无外壳兜底，如直接打开文档文件）
  var edPaneAi = document.getElementById('ed-pane-ai');
  var edPaneMatch = document.getElementById('ed-pane-match');
  var embedded = !!(edPaneAi && edPaneMatch);

  var root = document.createElement('div');
  root.innerHTML = (embedded ? '' : '<button id="ai-toggle" title="AI 助手" aria-label="AI 助手">🤖</button>')
    + '<div id="ai-drawer"' + (embedded ? ' style="display:none"' : '') + '><header><span>🤖 AI 助手</span><span id="ai-close" role="button" aria-label="关闭">✕</span></header>'
    + '<div id="ai-tabs"><button data-tab="chat" class="on">💬 对话</button><button data-tab="review">🩺 体检</button><button data-tab="match">🎯 JD</button></div>'
    + '<div id="ai-pane-chat" class="ai-pane on"><div id="ai-log"></div><div id="ai-input"><input id="ai-msg" placeholder="例如：把项目3精简一点" aria-label="对话输入"><button id="ai-send">发送</button></div></div>'
    + '<div id="ai-pane-review" class="ai-pane"><div class="ai-actions"><button id="ai-review-full">全面体检</button><button id="ai-review-quant">仅量化增强</button></div><div id="ai-review-out"></div></div>'
    + '<div id="ai-pane-match" class="ai-pane"><div class="ai-actions"><textarea id="ai-jd" placeholder="粘贴 JD 全文，或粘贴招聘链接后点「读取链接」" aria-label="JD 全文"></textarea><button id="ai-jd-fetch">📥 读取链接</button><button id="ai-match-go">分析匹配度</button></div><div id="ai-match-out"></div></div></div>'
    + '<button id="ai-sel-btn">✨ AI 改写</button>'
    + '<div id="ai-pop" role="dialog" aria-label="选区改写"><textarea id="ai-inst" placeholder="改写指令，例如：精简到两行、突出量化成果" aria-label="改写指令"></textarea>'
    + '<div class="row"><button id="ai-gen">生成预览</button></div><div class="preview" id="ai-preview"></div>'
    + '<div class="row" id="ai-actions" style="display:none"><button id="ai-apply">应用</button><button id="ai-cancel">取消</button></div></div>';
  // 挂进 AI-INJECT 注释对之间（/save 剥离不落盘）；无注释对（直接打开文档文件）兜底 append
  var endMark = findComment('/AI-INJECT');
  if (endMark) endMark.parentNode.insertBefore(root, endMark);
  else document.body.appendChild(root);

  // 嵌入模式：把面板内容搬进外壳右栏（AI 助手 = 对话+体检；岗位匹配 = JD），DOM 移动不丢事件绑定
  // 注意：此处 $ 尚未定义（var 提升但赋值未到），用 document.getElementById
  if (embedded) {
    var tabsEl = document.getElementById('ai-tabs');
    var matchTabBtn = tabsEl.querySelector('button[data-tab="match"]');
    if (matchTabBtn) matchTabBtn.remove();  // JD 由右栏顶级 Tab「岗位匹配」承担
    edPaneAi.appendChild(tabsEl);
    edPaneAi.appendChild(document.getElementById('ai-pane-chat'));
    edPaneAi.appendChild(document.getElementById('ai-pane-review'));
    edPaneMatch.appendChild(document.getElementById('ai-pane-match'));
    document.getElementById('ai-pane-match').classList.add('on');  // pane 自身常显，显隐由右栏 Tab 管
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

  // 空态引导（不持久、不进对话历史）
  addMsg(embedded
    ? '👋 使用引导：\n· 选中正文文字 → 浮动工具条选改写方向\n· 「🩺 体检」出多维诊断报告\n· 右侧「岗位匹配」粘贴 JD 做匹配分析\n所有建议都可逐条 应用 / 📍定位 / 跳过 / 撤销'
    : '👋 使用引导：\n· 选中正文一句话 → 点「✨ AI 改写」逐句精简\n· 「🩺 体检」出五维诊断报告\n· 「🎯 JD」粘贴岗位描述或链接做匹配分析\n所有建议都可逐条 应用 / 📍定位 / 跳过 / 撤销', false);

  // 共享应用通道：在文档里找 before 文本并替换（支持跨加粗等 DOM 节点、定位第 N 个重复位置）
  // opts: { occurrence?: number, context?: string }
  function findAndReplace(before, after, opts) {
    opts = opts || {};
    var walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    var nodes = [], stream = '', node;
    while ((node = walker.nextNode())) {
      nodes.push({ node: node, start: stream.length });
      stream += node.data;
    }
    var matches = [], idx = stream.indexOf(before);
    while (idx >= 0) {
      matches.push(idx);
      idx = stream.indexOf(before, idx + (before.length || 1));
    }
    if (!matches.length) return false;
    var chosen = 0;
    if (typeof opts.occurrence === 'number' && opts.occurrence >= 0 && opts.occurrence < matches.length) {
      chosen = opts.occurrence;
    } else if (opts.context) {
      var ci = matches.findIndex(function (m) {
        var s = Math.max(0, m - 60), e = Math.min(stream.length, m + before.length + 60);
        return stream.slice(s, e).indexOf(opts.context) >= 0;
      });
      if (ci >= 0) chosen = ci;
    }
    var start = matches[chosen], end = start + before.length;
    // 找到首个受影响文本节点：after 整体写进它，其余命中节点删除对应片段（跨节点也能正确替换）
    var firstIdx = -1;
    for (var i = 0; i < nodes.length; i++) {
      var s0 = nodes[i].start, e0 = s0 + nodes[i].node.data.length;
      if (e0 > start && s0 < end) { firstIdx = i; break; }
    }
    if (firstIdx < 0) return false;
    for (var j = 0; j < nodes.length; j++) {
      var nd = nodes[j].node, ns = nodes[j].start, ne = ns + nd.data.length;
      if (ne <= start || ns >= end) continue;
      var from = Math.max(start, ns) - ns, to = Math.min(end, ne) - ns;
      nd.data = nd.data.slice(0, from) + (j === firstIdx ? after : '') + nd.data.slice(to);
    }
    // 程序化变更统一出口（S2-T5）：与外壳撤销栈共用；无外壳时退回裸派发（行为等价）
    if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    else sheet.dispatchEvent(new Event('input', { bubbles: true }));  // 触发本地自动保存兜底
    return true;
  }

  // AI 请求前确保当前内容已落盘，并带上内容版本（服务端据此拒绝落后内容）
  async function flushFirst() {
    try { if (window.__edFlushSave) await window.__edFlushSave(); } catch (e) {}
    return Number(window.__edDocMtime || 0);
  }
  function isStale(r) { return r.status === 409; }

  function aiError(e) {
    addMsg('⚠️ ' + (e.message || e), false);
  }

  // ===== 对话抽屉 =====
  // 嵌入模式：面板常驻右栏，setDrawer 转为「显示右栏 + 切 Tab」；兜底模式维持抽屉开关
  function setDrawer(open, tab) {
    if (embedded) {
      var right = document.getElementById('ed-right');
      if (open && right) {
        right.classList.remove('ed-hidden');
        right.classList.add('ed-open');
        document.body.style.setProperty('--ed-right-w', window.innerWidth >= 768 ? '320px' : '0px');
      }
      if (open && tab && window.__edSelectTab) window.__edSelectTab(tab);
      return;
    }
    $('ai-drawer').classList.toggle('open', open);
  }
  if ($('ai-toggle')) $('ai-toggle').onclick = function () { setDrawer(!$('ai-drawer').classList.contains('open')); };
  if ($('ai-close')) $('ai-close').onclick = function () { setDrawer(false); };

  var sending = false;
  async function sendChat() {
    var input = $('ai-msg'), msg = input.value.trim();
    if (!msg || sending) return;  // 防连点/Enter 重入：并发请求会打乱 history 顺序
    sending = true;
    $('ai-send').disabled = true;
    input.value = '';
    addMsg(msg, true);
    try {
      var mt = await flushFirst();
      var r = await fetch('/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: DOC_ID, message: msg, history: history, baseMtime: mt }) });
      if (r.status === 409 && (r.headers.get('content-type') || '').includes('application/json')) {
        addMsg('⚠️ 文档有未同步的修改，已自动保存，请重发这条消息', false);
        return;
      }
      if (r.status === 409) { addMsg(await r.text(), false); return; }
      var data = await r.json();
      history.push({ role: 'user', content: msg }, { role: 'assistant', content: JSON.stringify(data) });
      if (data.reply) { addMsg(data.reply, false); return; }
      if (!data.changes || !data.changes.length) { addMsg('（AI 没有给出修改）', false); return; }
      data.changes.forEach(function (c) { renderChange(c); });
    } catch (e) { aiError(e); }
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
        (node.parentElement || sheet).scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    loc.textContent = '📍 定位';
    loc.title = '在正文中选中并滚动到原文位置';
    loc.onclick = function () { if (!locateText(c.before)) note.textContent = '⚠️ 原文未找到（可能已被修改）'; };
    apply.onclick = function () {
      // 应用前检查：找不到原文即拒绝（文档可能已被改/重复文本按位置区分）
      if (window.__edPushUndo) window.__edPushUndo('AI：' + (c.note || '修改'));
      if (findAndReplace(c.before, c.after, { occurrence: c.occurrence, context: c.context })) {
        box.style.opacity = '0.6';
        apply.style.display = skip.style.display = loc.style.display = 'none';
        var undo = document.createElement('button');
        undo.textContent = '↩ 撤销';
        undo.onclick = function () {
          if (findAndReplace(c.after, c.before)) {
            box.style.opacity = '1';
            undo.remove();
            apply.style.display = skip.style.display = loc.style.display = '';
            apply.disabled = skip.disabled = false;
          } else { note.textContent = '⚠️ 撤销失败：改写后的文本已被再次修改'; }
        };
        box.appendChild(undo);
      }
      else { note.textContent = '⚠️ 未在文档中找到原文（可能已被修改），未应用（可手动改）'; }
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
      var r = await fetch('/ai/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: DOC_ID, mode: mode, baseMtime: mt }) });
      if (r.status === 409 && (r.headers.get('content-type') || '').includes('application/json')) { out.textContent = '⚠️ 文档有未同步修改，已自动保存，请重试'; return; }
      if (r.status === 409) { out.textContent = await r.text(); return; }
      renderReport(out, await r.json());
    } catch (e) { out.textContent = '⚠️ ' + (e.message || e); }
    finally { reviewing = false; btn.disabled = false; }
  }
  $('ai-review-full').onclick = function () { runReview('full'); };
  $('ai-review-quant').onclick = function () { runReview('quant'); };

  // ===== JD 匹配 =====
  var matching = false;
  $('ai-match-go').onclick = async function () {
    var jd = $('ai-jd').value.trim();
    if (!jd || matching) return;
    matching = true;
    $('ai-match-go').disabled = true;
    var out = $('ai-match-out');
    out.textContent = '分析中…';
    try {
      var mt = await flushFirst();
      var r = await fetch('/ai/match', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: DOC_ID, jd: jd, baseMtime: mt }) });
      if (r.status === 409 && (r.headers.get('content-type') || '').includes('application/json')) { out.textContent = '⚠️ 文档有未同步修改，已自动保存，请重试'; return; }
      if (r.status === 409) { out.textContent = await r.text(); return; }
      var data = await r.json();
      renderReport(out, data);
      // 匹配报告出来后提供"创建岗位草稿"入口（独立文档 + 修改清单审阅，不动母版）
      if (data.report) {
        var mk = document.createElement('button');
        mk.textContent = '📌 据此创建岗位草稿';
        mk.style.marginTop = '8px';
        mk.onclick = async function () {
          var company = prompt('公司'); if (!company || !company.trim()) return;
          var role = prompt('岗位'); if (!role || !role.trim()) return;
          var r2 = await fetch('/job/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: DOC_ID, company: company.trim(), role: role.trim(), jd: jd }) });
          var d2 = await r2.json().catch(function () { return null; });
          if (d2 && d2.existing) { if (confirm('同岗位草稿已存在（' + d2.existing + '），打开它？')) location.href = '/edit?id=' + d2.existing; return; }
          if (d2 && d2.ok && d2.id) { location.href = '/edit?id=' + d2.id; return; }
          out.textContent = '⚠️ ' + ((d2 && d2.error) || '创建失败');
        };
        out.appendChild(mk);
      }
    } catch (e) { out.textContent = '⚠️ ' + (e.message || e); }
    finally { matching = false; $('ai-match-go').disabled = false; }
  };

  // JD 链接读取：textarea 里是 http(s) 链接时拉回文本预填（失败也可手动粘贴）
  var jdFetching = false;
  $('ai-jd-fetch').onclick = async function () {
    var ta = $('ai-jd'), v = ta.value.trim();
    if (!/^https?:\/\//.test(v) || jdFetching) return;
    jdFetching = true;
    $('ai-jd-fetch').disabled = true;
    var out = $('ai-match-out');
    out.textContent = '读取链接中…';
    try {
      var r = await fetch('/ai/jd-text', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: v }) });
      var d = await r.json();
      if (d.ok && d.text) {
        ta.value = d.text;
        out.textContent = '✅ 已读取 JD（' + d.text.length + ' 字），检查后可点「分析匹配度」';
      } else {
        out.textContent = '⚠️ 读取失败：' + (d.error || '未知错误') + '（该站可能要登录/有反爬，请手动粘贴 JD 文本）';
      }
    } catch (e) { out.textContent = '⚠️ ' + (e.message || e); }
    finally { jdFetching = false; $('ai-jd-fetch').disabled = false; }
  };

  // jdfrom 桥：看板 🎯 跳来时拉取该投递的 JD 预填 + 切 Tab + 开面板
  (function () {
    var m = location.search.match(/[?&]jdfrom=([0-9-]+)/);
    if (!m) return;
    fetch('/app/jd?id=' + m[1]).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.jd) return;
      $('ai-jd').value = d.jd;
      if (embedded) { setDrawer(true, 'match'); }
      else {
        var mt = document.querySelector('#ai-tabs button[data-tab="match"]');
        if (mt) mt.click();
        setDrawer(true);
      }
    }).catch(function () {});
  })();

  // ===== 选区改写 =====
  // 预设指令（嵌入模式四按钮工具条；沿用 /ai/rewrite 审阅流，不静默覆盖正文）
  var PRESETS = {
    concise: '精简表达：压缩到最短，保留事实与数据，不丢关键信息',
    contrib: '突出个人贡献：明确"我"负责的环节、动作与产出，不夸大不编造',
    wording: '改善措辞：修正语病与口语化表达，保持原意与专业度',
    evidence: '补充证据：指出此处缺少哪些指标或事实，给出待补充占位提示，不编造任何数字'
  };
  var selText = '', selRect = null;
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
    if (pendingAfter) {
      if (window.__edPushUndo) window.__edPushUndo('AI 改写');
      if (findAndReplace(selText, pendingAfter)) $('ai-pop').style.display = 'none';
      else $('ai-preview').textContent = '⚠️ 原文未找到（可能已被修改），未应用';
    }
  };
  $('ai-cancel').onclick = function () { $('ai-pop').style.display = 'none'; };
  document.addEventListener('mousedown', function (e) {
    if (!$('ai-pop').contains(e.target) && e.target.id !== 'ai-sel-btn') $('ai-pop').style.display = 'none';
  });
})();
