// ai-helper-panel.js — 「AI 简历助手」页前端（classic script，仿 ai-panel.js 注入方式）
// 由 GET /ai-helper 页面以 <script src="/ai-helper-panel.js" defer> 引入，挂载进 #ah-app。
// 端点（契约见 ai-helper.routes.md）：
//   GET  /ai-helper/docs      文档清单（简历下拉）
//   GET  /api/extract?id=     复用现成端点：取某份简历的正文文本（唯一文本来源，不新造）
//   POST /ai-helper/check          {text} → {issues[] | reply}（非流式）
//   POST /ai-helper/improve-all    {text,issues} → {rewritten | reply}（非流式）
//   POST /ai-helper/rewrite/stream {text,userRequirement} → SSE {delta} 帧流（定制改写/去修复走这条）
//   POST /ai-helper/polish/stream  {text} → SSE {delta} 帧流
//   （非流式 /rewrite、/polish JSON 端点保留：规范 ai-helper.routes.md §5；面板已不切回）
// 视觉：只用 page() :root 设计 token（var(--accent)/--card/--line/--mut/--ok/--warn/--err 等），零字面色。
(function () {
  var mountEl = document.getElementById('ah-app');
  if (!mountEl) return;
  // AoraFace 化身：挂 .page-head（在 #ah-app 之外，不被面板重渲染擦除）；AoraFace 未加载时全部静默跳过
  var face = null;
  var headEl = document.querySelector('.page-head');
  if (window.AoraFace && headEl) {
    var fslot = document.createElement('span');
    fslot.style.cssText = 'display:inline-flex;margin-left:auto';
    headEl.appendChild(fslot);
    face = AoraFace.mount(fslot, { page: 'ai-helper', size: 96, cornerOf: '.page-head' });
  }
  var fset = function (v) { if (face) { if (v === 'send') AoraFace.compact(face); AoraFace.set(face, v); } };
  var $ = function (id) { return document.getElementById(id); };
  // 图标/状态行由 page() 下发（__status 在 STATUS_SCRIPT 里）；__icon 由页面 nonce 注入（ICON_SCRIPT）。
  // 没拿到时降级为空串/纯文本 —— 不炸，也不显示图标（与 ai-panel.js 同口径）。
  var __icon = window.__icon || function () { return ''; };
  var __status = window.__status || function (el, kind, text) { if (el) el.textContent = text; };

  // 幂等护栏：重复注入时清掉旧样式
  document.querySelectorAll('style[data-ai-helper-panel]').forEach(function (el) { el.remove(); });
  var css = document.createElement('style');
  css.setAttribute('data-ai-helper-panel', '1');
  css.textContent = ''
    + '.ah-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr);gap:var(--space-3);align-items:start}'
    + '@media (max-width:960px){.ah-grid{grid-template-columns:1fr}}'
    + '.ah-card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px}'
    + '.ah-card+.ah-card{margin-top:var(--space-3)}'
    + '.ah-sec-title{font-size:14px;font-weight:800;margin:0 0 var(--space-2)}'
    + '.ah-row{display:flex;gap:var(--space-2);flex-wrap:wrap;align-items:center;margin:var(--space-2) 0}'
    + '#ah-text{width:100%;font-family:var(--font-mono);font-size:12.5px;line-height:1.6;resize:vertical;min-height:280px}'
    + '#ah-req{flex:1;min-width:200px}'
    + '.ah-issue{border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;margin:0 0 var(--space-2);background:var(--panel)}'
    + '.ah-issue .ah-field{font-weight:700;font-size:12.5px;margin-left:2px}'
    + '.ah-issue .ah-desc{margin-top:4px;font-size:13px}'
    + '.ah-issue .ah-sugg{margin-top:4px;font-size:12.5px;color:var(--mut)}'
    + '.ah-issue .ah-fix{margin-top:6px;min-height:26px;padding:0 10px;font-size:12px}'
    + '.ah-issue.ah-done{opacity:.72}'
    + '.ah-issue .badge{margin-right:0}'
    + '.ah-issue-head{display:flex;align-items:center;gap:var(--space-2);flex-wrap:wrap}'
    + '.ah-out-text{white-space:pre-wrap;font-size:13px;line-height:1.7;max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius);padding:10px 12px;background:var(--bg)}'
    + '.ah-status{font-size:12px;color:var(--mut);min-height:18px;margin-top:var(--space-2)}'
    + '.ah-hint{font-size:12px;color:var(--mut)}'
    + '.ah-empty{color:var(--mut);font-size:13px;padding:var(--space-4);text-align:center;border:1px dashed var(--line);border-radius:var(--radius)}';
  document.head.appendChild(css);

  // ===== DOM（全部 textContent 填数据，AI 输出/文档标题不进 innerHTML）=====
  mountEl.innerHTML = ''
    + '<div class="ah-grid">'
    + '  <div class="ah-card">'
    + '    <div class="ah-sec-title">简历文本</div>'
    + '    <div class="ah-row">'
    + '      <select id="ah-docs" aria-label="选择简历文档"></select>'
    + '      <button id="ah-load" type="button" class="secondary">' + __icon('file-text') + ' 从简历载入</button>'
    + '      <span id="ah-load-status" class="ah-hint"></span>'
    + '    </div>'
    + '    <textarea id="ah-text" rows="20" placeholder="粘贴简历文本，或点「从简历载入」取当前简历正文"></textarea>'
    + '    <div class="ah-sec-title" style="margin-top:var(--space-3)">操作</div>'
    + '    <div class="ah-row">'
    + '      <button id="ah-check" type="button">' + __icon('stethoscope') + ' 智能检查</button>'
    + '      <button id="ah-improve-all" type="button" class="secondary">' + __icon('sparkles') + ' 一键优化全部</button>'
    + '      <button id="ah-polish" type="button" class="secondary">润色</button>'
    + '    </div>'
    + '    <div class="ah-row">'
    + '      <input id="ah-req" maxlength="200" placeholder="定制改写要求，如：突出后端性能优化经验，压缩到一页" aria-label="定制改写要求">'
    + '      <button id="ah-rewrite" type="button" class="secondary">定制改写</button>'
    + '    </div>'
    + '    <div id="ah-status" class="ah-status" aria-live="polite"></div>'
    + '  </div>'
    + '  <div>'
    + '    <div class="ah-card" id="ah-issues-card" style="display:none">'
    + '      <div class="ah-sec-title">检查发现 <span id="ah-issues-count" class="ah-hint"></span></div>'
    + '      <div id="ah-issues"></div>'
    + '    </div>'
    + '    <div class="ah-card" id="ah-output-card" style="display:none">'
    + '      <div class="ah-sec-title" style="display:flex;justify-content:space-between;align-items:center;gap:var(--space-2)">'
    + '        <span id="ah-out-title">结果</span>'
    + '        <span class="ah-row" style="margin:0">'
    + '          <button id="ah-apply-input" type="button" class="secondary" style="min-height:26px;padding:0 10px;font-size:12px">替换输入文本</button>'
    + '          <button id="ah-copy" type="button" class="secondary" style="min-height:26px;padding:0 10px;font-size:12px">' + __icon('save') + ' 复制</button>'
    + '        </span>'
    + '      </div>'
    + '      <div id="ah-out-text" class="ah-out-text"></div>'
    + '    </div>'
    + '    <div id="ah-empty" class="ah-empty" style="margin-top:var(--space-3)">结果区：先跑「智能检查」看问题清单，或直接「定制改写 / 润色」</div>'
    + '  </div>'
    + '</div>';

  // ===== 状态与工具 =====
  var state = { issues: [], busy: false, aiReady: true };
  var statusEl = $('ah-status');
  var emptyEl = $('ah-empty');

  function say(kind, text) { __status(statusEl, kind, text); }

  // 统一写请求语义（与 ai-panel.js postJson 同口径）：409 JSON=stale、409 text=拒绝（含 LLM 未配置），
  // !r.ok 或 ok!==true → error；网络异常进 catch。
  async function postJson(url, body) {
    fset('send');
    var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(function (e) { fset('error'); throw e; });
    if (r.status === 409) {
      var ct = (r.headers.get('content-type') || '');
      if (ct.includes('application/json')) {
        var d409 = await r.json().catch(function () { return null; });
        var e1 = new Error((d409 && d409.error) || '文档有未同步的修改');
        e1.stale = true; fset('error'); throw e1;
      }
      var t409 = await r.text();
      var e2 = new Error(t409 || '服务拒绝'); e2.rejected = true; fset('error'); throw e2;
    }
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok || !data || data.ok !== true) {
      var e3 = new Error((data && (data.error || data.msg)) || ('HTTP ' + r.status));
      e3.rejected = true; fset('error'); throw e3;
    }
    fset('done');
    return data;
  }

  // postStream：SSE 版写请求（UPCV */stream 复刻；409/!ok 语义与 postJson 同口径）。
  // 帧协议（ai-helper.routes.md §5）：'data: {"delta":"…"}' 逐段 / 'data: [DONE]' 收尾 /
  // 'data: {"error":"…"}' 出错；非 JSON 帧按纯文本 delta 容错。
  // onDelta 逐段回调（增量渲染）。返回 {text,done}：done=false = 连接中断（结果可能不完整）。
  // 起步错误（未配置/5xx）在响应头阶段仍是普通 JSON → 走 !r.ok 分支，不进帧解析。
  async function postStream(url, body, onDelta) {
    fset('send');
    var r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      fset('error');
      throw new Error('网络连接失败：本地服务可能未在运行，请刷新或稍后重试');
    }
    if (r.status === 409) {
      var ct = (r.headers.get('content-type') || '');
      if (ct.includes('application/json')) {
        var d409 = await r.json().catch(function () { return null; });
        var e1 = new Error((d409 && d409.error) || '文档有未同步的修改');
        e1.stale = true; fset('error'); throw e1;
      }
      var t409 = await r.text();
      var e2 = new Error(t409 || '服务拒绝'); e2.rejected = true; fset('error'); throw e2;
    }
    if (!r.ok) {
      var data = null;
      try { data = await r.json(); } catch (e) { data = null; }
      var e3 = new Error((data && (data.error || data.msg)) || ('HTTP ' + r.status));
      e3.rejected = true; fset('error'); throw e3;
    }
    // 非 SSE 回包（降级/代理改写）：按普通 JSON 容错取 rewritten/reply，不炸
    if (!((r.headers.get('content-type') || '').includes('text/event-stream'))) {
      var dj = null;
      try { dj = await r.json(); } catch (e) { dj = null; }
      var whole = (dj && (dj.rewritten || dj.reply)) || '';
      if (whole && onDelta) { fset('stream'); onDelta(whole); }
      if (whole) fset('done'); else fset('error');   // 坏载荷（非 JSON/无 rewritten）不把失败当成功
      return { text: whole, done: true };
    }
    if (!r.body || !r.body.getReader) { fset('error'); throw new Error('当前浏览器不支持流式读取，请换用新版浏览器'); }
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = '', done = false, full = '';
    try {
      while (!done) {
        var chunk;
        try { chunk = await reader.read(); }
        catch (e) { fset('error'); return { text: full, done: false }; }   // 断网/连接重置：保已收内容，done=false
        if (chunk.done) { buf += dec.decode(); break; }
        buf += dec.decode(chunk.value, { stream: true });
        var cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          var frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
          var lines = frame.split('\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).trim();
            if (payload === '[DONE]') { done = true; break; }
            var obj = null;
            try { obj = JSON.parse(payload); } catch (e) { obj = { delta: payload }; }   // 纯文本帧容错
            if (obj && typeof obj.error === 'string') {
              var ee = new Error(obj.error); ee.rejected = true;
              fset('error');
              throw ee;   // 已收部分留在输出卡（追加渲染不回滚），错误由 runAction 提示
            }
            var d = obj && typeof obj.delta === 'string' ? obj.delta : '';
            if (d) { full += d; fset('stream'); if (onDelta) onDelta(d); }
          }
        }
      }
    } finally {
      try { reader.cancel(); } catch (e) {}
    }
    if (done) fset('done'); else fset('error');   // 未见 [DONE] 帧的半截流不算成功
    return { text: full, done: done };
  }

  // 「已等待 m:ss」秒表（与 ai-panel.js fmtElapsed 同口径）：等待期唯一真实进度信号是耗时，不造百分比。
  function fmtElapsed(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function startTicker(render) {
    var t0 = Date.now();
    var tick = function () { render(fmtElapsed(Date.now() - t0)); };
    tick();
    return setInterval(tick, 1000);
  }

  var ACTION_BTNS = ['ah-check', 'ah-improve-all', 'ah-polish', 'ah-rewrite', 'ah-load'];
  function setBusy(on) {
    state.busy = on;
    ACTION_BTNS.forEach(function (id) { var b = $(id); if (b) b.disabled = on || (!state.aiReady && id !== 'ah-load'); });
    document.querySelectorAll('.ah-fix').forEach(function (b) { b.disabled = on; });
  }

  function hideEmpty() { if (emptyEl) emptyEl.style.display = 'none'; }

  // runAction：按钮防抖 + 秒表进度（「<label> · 已等待 m:ss」）+ 失败保留输入。
  async function runAction(label, fn) {
    if (state.busy) return;
    setBusy(true);
    var tick = startTicker(function (mm) { statusEl.textContent = label + ' · 已等待 ' + mm; });
    try {
      await fn();
    } catch (e) {
      say('warn', (e && e.message) || e);
    } finally {
      clearInterval(tick);
      setBusy(false);
      if (statusEl.textContent.indexOf('已等待') >= 0) statusEl.textContent = '';
    }
  }

  function needText() {
    var t = $('ah-text').value.trim();
    if (!t) say('warn', '先填入简历文本（粘贴，或点「从简历载入」）');
    return t;
  }

  // ===== 输出卡 =====
  function showOutput(title, text) {
    hideEmpty();
    $('ah-out-title').textContent = title;
    $('ah-out-text').textContent = text;
    $('ah-output-card').style.display = '';
    $('ah-output-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  // 流式增量渲染：begin 清空并亮卡 → append 逐段追加【文本节点】（禁 innerHTML，
  // 与全文 textContent 同一安全口径；.ah-out-text 的 white-space:pre-wrap 保留换行）。
  function beginOutput(title) {
    hideEmpty();
    $('ah-out-title').textContent = title;
    var out = $('ah-out-text');
    out.textContent = '';
    $('ah-output-card').style.display = '';
    $('ah-output-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return out;
  }
  function appendOutput(outEl, delta) {
    outEl.appendChild(document.createTextNode(delta));
    outEl.scrollTop = outEl.scrollHeight;   // 跟随最新输出（盒内滚动，不拉页面）
  }
  $('ah-copy').onclick = function () {
    var t = $('ah-out-text').textContent;
    var label = $('ah-copy').innerHTML;
    var done = function () { $('ah-copy').textContent = '已复制'; setTimeout(function () { $('ah-copy').innerHTML = label; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, function () { say('warn', '复制失败，请手动选择文本复制'); });
    else say('warn', '浏览器不支持一键复制，请手动选择文本复制');
  };
  $('ah-apply-input').onclick = function () {
    var t = $('ah-out-text').textContent;
    if (t) { $('ah-text').value = t; say('ok', '已把结果填回输入框，可继续检查或改写'); }
  };

  // ===== 问题清单卡 =====
  function renderIssues() {
    var card = $('ah-issues-card'), box = $('ah-issues');
    box.innerHTML = '';
    var issues = state.issues;
    $('ah-issues-count').textContent = issues.length ? '（' + issues.length + ' 条）' : '';
    if (!issues.length) { card.style.display = 'none'; return; }
    hideEmpty();
    issues.forEach(function (it, i) {
      var d = document.createElement('div');
      d.className = 'ah-issue' + (it.fixed ? ' ah-done' : '');
      var head = document.createElement('div');
      head.className = 'ah-issue-head';
      var badge = document.createElement('span');
      badge.className = 'badge ' + (it.type === 'error' ? 'err' : 'warn');
      badge.textContent = it.type === 'error' ? '错误' : '警告';
      head.appendChild(badge);
      var f = document.createElement('span');
      f.className = 'ah-field';
      f.textContent = it.field || '全文';
      head.appendChild(f);
      if (it.fixed) {
        var done = document.createElement('span');
        done.className = 'ah-hint';
        done.textContent = '已修复';
        head.appendChild(done);
      }
      d.appendChild(head);
      var desc = document.createElement('div');
      desc.className = 'ah-desc';
      desc.textContent = it.description;
      d.appendChild(desc);
      if (it.suggestion) {
        var sg = document.createElement('div');
        sg.className = 'ah-sugg';
        sg.textContent = '建议：' + it.suggestion;
        d.appendChild(sg);
      }
      if (!it.fixed) {
        var fix = document.createElement('button');
        fix.type = 'button';
        fix.className = 'ah-fix secondary';
        fix.textContent = '去修复';
        fix.onclick = function () { fixOne(i, fix); };
        d.appendChild(fix);
      }
      box.appendChild(d);
    });
    card.style.display = '';
  }

  // 去修复：单条 issue → 调定制改写·流式（requirement=问题+建议），结果逐段进输出卡；
  // 只在完整收尾（done）时标「已修复」——中断的半截文本不背修复名分（诚实口径）。
  function fixOne(i, btn) {
    var it = state.issues[i];
    var text = needText();
    if (!it || !text) return;
    var req = '修复该问题——【' + (it.field || '全文') + '】' + it.description + (it.suggestion ? '；修复建议：' + it.suggestion : '');
    runAction('修复中', async function () {
      var out = beginOutput('修复结果 · ' + (it.field || '全文'));
      var rs = await postStream('/ai-helper/rewrite/stream', { text: text, userRequirement: req }, function (d) { appendOutput(out, d); });
      if (rs.done && rs.text.trim()) {
        it.fixed = true;
        renderIssues();
        say('ok', '已修复：' + (it.field || '全文'));
      } else if (!rs.done) {
        say('warn', '连接中断：上面是已收到的部分内容，结果可能不完整，请重试');
      } else {
        say('warn', '模型未返回改写结果，请重试');
      }
    });
  }

  // ===== 四动作 =====
  $('ah-check').onclick = function () {
    var text = needText();
    if (!text) return;
    runAction('检查中', async function () {
      var d = await postJson('/ai-helper/check', { text: text });
      if (d.issues) {
        state.issues = d.issues;
        renderIssues();
        if (!d.issues.length) { hideEmpty(); showOutput('检查结果', '未发现问题：文本在当前检查维度下通过。'); }
        say('ok', '检查完成：' + d.issues.length + ' 条问题');
      } else {
        state.issues = [];
        renderIssues();
        showOutput('检查结果', d.reply || '（模型未按约定输出，请重试）');
      }
    });
  };

  $('ah-improve-all').onclick = function () {
    var text = needText();
    if (!text) return;
    runAction('优化中', async function () {
      var d = await postJson('/ai-helper/improve-all', { text: text, issues: state.issues });
      if (d.rewritten) {
        state.issues.forEach(function (it) { it.fixed = true; });
        renderIssues();
        showOutput('一键优化结果', d.rewritten);
        say('ok', '已按问题清单修复全文');
      } else {
        showOutput('一键优化结果', d.reply || '（模型未返回改写结果）');
      }
    });
  };

  $('ah-rewrite').onclick = function () {
    var text = needText();
    if (!text) return;
    var req = $('ah-req').value.trim();
    if (!req) { say('warn', '先在输入框写改写要求'); $('ah-req').focus(); return; }
    runAction('改写中', async function () {
      var out = beginOutput('定制改写结果');
      var rs = await postStream('/ai-helper/rewrite/stream', { text: text, userRequirement: req }, function (d) { appendOutput(out, d); });
      if (!rs.done) say('warn', '连接中断：上面是已收到的部分内容，结果可能不完整，请重试');
      else say('ok', rs.text.trim() ? '改写完成' : '改写完成，但模型未返回内容');
    });
  };

  $('ah-polish').onclick = function () {
    var text = needText();
    if (!text) return;
    runAction('润色中', async function () {
      var out = beginOutput('润色结果');
      var rs = await postStream('/ai-helper/polish/stream', { text: text }, function (d) { appendOutput(out, d); });
      if (!rs.done) say('warn', '连接中断：上面是已收到的部分内容，结果可能不完整，请重试');
      else say('ok', rs.text.trim() ? '润色完成' : '润色完成，但模型未返回内容');
    });
  };

  // ===== 从简历载入（复用 GET /api/extract?id= —— 服务端现成的正文文本只读视图）=====
  $('ah-load').onclick = function () {
    var sel = $('ah-docs');
    var id = sel && sel.value;
    if (!id) { say('warn', '没有可载入的简历文档'); return; }
    runAction('载入中', async function () {
      var r = await fetch('/api/extract?id=' + encodeURIComponent(id));
      var d = null;
      try { d = await r.json(); } catch (e) { d = null; }
      if (!r.ok || !d || !d.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
      $('ah-text').value = d.text || '';
      $('ah-load-status').textContent = '已载入 ' + (d.lines || 0) + ' 行';
    });
  };

  // ===== 初始化：文档清单 + AI 可用性 =====
  (function init() {
    // 文档清单（/ai-helper/docs；?id=<docId> 预选）
    fetch('/ai-helper/docs').then(function (r) { return r.json(); }).then(function (d) {
      var sel = $('ah-docs');
      var docs = (d && d.ok && Array.isArray(d.docs)) ? d.docs : [];
      if (!docs.length) {
        sel.style.display = 'none';
        $('ah-load').disabled = true;
        $('ah-load-status').textContent = '暂无简历文档：先到首页新建，或直接粘贴文本';
        return;
      }
      var want = new URLSearchParams(location.search).get('id') || '';
      docs.forEach(function (doc) {
        var o = document.createElement('option');
        o.value = doc.id;
        o.textContent = (doc.title || doc.id) + '（' + doc.id + '）';
        if (doc.id === want) o.selected = true;
        sel.appendChild(o);
      });
    }).catch(function () {
      $('ah-load-status').textContent = '文档清单读取失败，仍可粘贴文本使用';
    });
    // AI 可用性（/ai/profiles 现成端点：无就绪档案 → 禁用 AI 按钮 + 明确提示）
    fetch('/ai/profiles').then(function (r) { return r.json(); }).then(function (d) {
      var ready = d && d.ok && (d.list || []).some(function (p) { return p && p.ready; });
      state.aiReady = !!ready;
      if (!ready) {
        ['ah-check', 'ah-improve-all', 'ah-polish', 'ah-rewrite'].forEach(function (id) { $(id).disabled = true; });
        var a = document.createElement('a');
        a.href = '/settings';
        a.textContent = '未配置大模型：打开 /settings 完成模型配置';
        statusEl.textContent = '';
        statusEl.appendChild(a);
      }
    }).catch(function () {
      // 清单读不到时保持可用：让请求自己去撞 409「未配置大模型」，不提前误禁
    });
  })();
})();
