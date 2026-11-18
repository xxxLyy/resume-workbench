// interview-panel.js — 模拟面试页前端（classic script，与 ai-panel/job-panel 同约定）
// 由 /interview 页内 inner 以 <script src="/interview-panel.js"> 挂入（CSP script-src 'self' 放行；
// 不经 nonce 占位符——本文件零内联）。启动数据由服务端内联 window.__INTERVIEW__ 下发（nonce 脚本）。
// 职责：配置卡（新面试）+ 会话列表 + 面试进行卡（出题/作答/跳过/提示）+ 报告卡（优势/短板/建议）。
// 诚实边界：等待期唯一进度信号 = 「· 已等待 m:ss」秒表（job-panel fmtElapsed 同口径），不造百分比。
(function () {
  var boot = window.__INTERVIEW__ || {};
  var mount = document.getElementById('ivApp');
  if (!mount) return;
  var CAP = (boot.config && boot.config.questionCap) || 14;
  var TYPES = (boot.config && boot.config.interviewTypes) || ['comprehensive', 'professional', 'hr'];
  var TYPE_LABELS = { comprehensive: '综合面试', professional: '专业面试', hr: 'HR 面试' };
  var VOICES = (boot.config && boot.config.voices) || [];
  var JOBS = Array.isArray(boot.jobs) ? boot.jobs : [];
  var RESUMES = Array.isArray(boot.resumes) ? boot.resumes : [];
  var hasLLM = !!boot.hasLLM;
  var BANKS = [];            // 题库橱窗（GET /interview/banks 运行时拉取；端点未接时静默降级隐藏）
  var selBank = '';          // 选中的题库 slug；'' = 不用题库（纯 AI 出题）

  var __status = window.__status || function (el, kind, text) { if (el) el.textContent = text; };
  var __wv = window.__wv || function (url, body, msgEl) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok || d.ok === false) { var m = (d && d.error) || ('HTTP ' + r.status); if (msgEl) __status(msgEl, 'err', m); throw new Error(m); } return d; }); });
  };

  // ===== 秒表（与 job-panel fmtElapsed / ai-panel startTicker 同口径；请求落定必停表）=====
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

  // ===== 样式（token 化：--accent/--card/--line/--mut/--space-* 全部取自 page() :root）=====
  var css = document.createElement('style');
  css.setAttribute('data-interview-panel', '1');
  css.textContent =
    '.iv-stack{display:flex;flex-direction:column;gap:var(--space-3)}'
    + '.iv-row{display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:flex-end}'
    + '.iv-field{display:flex;flex-direction:column;gap:var(--space-1);font-size:13px}'
    + '.iv-field>span{font-size:12px;font-weight:700}'
    + '.iv-voices{display:flex;gap:var(--space-3);flex-wrap:wrap;font-size:13px;color:var(--mut)}'
    + '.iv-voices label{display:flex;align-items:center;gap:var(--space-1)}'
    + '.iv-note{font-size:12px;color:var(--mut)}'
    + '.iv-msg{font-size:12px;color:var(--mut);min-height:1em}'
    + '.iv-msg:empty{display:none}'
    + '.iv-sessions{display:flex;flex-direction:column;gap:var(--space-2)}'
    + '.iv-sess{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-2) var(--space-3);font-size:13px}'
    + '.iv-sess .iv-grow{flex:1;min-width:0;color:var(--mut);font-size:12px}'
    + '.iv-q{font-size:15px;font-weight:700;line-height:1.7;margin:var(--space-2) 0}'
    + '.iv-progress{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}'
    + '.iv-answer{width:100%;min-height:120px;font-family:var(--font);font-size:13px}'
    + '.iv-acts{display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap;margin-top:var(--space-2)}'
    + '.iv-hint{border-left:3px solid var(--accent);background:var(--accent-soft);border-radius:6px;padding:var(--space-2) var(--space-3);margin-top:var(--space-2);font-size:13px}'
    + '.iv-hint ul{margin:var(--space-1) 0 0;padding-left:var(--space-4)}'
    + '.iv-cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3);margin-top:var(--space-3)}'
    + '@media (max-width:860px){.iv-cols{grid-template-columns:1fr}}'
    + '.iv-col h3{font-size:13px;margin:0 0 var(--space-2);display:flex;align-items:center;gap:var(--space-2)}'
    + '.iv-col ul{margin:0;padding-left:var(--space-4);font-size:13px;display:flex;flex-direction:column;gap:var(--space-1)}'
    + '.iv-report-meta{font-size:12px;color:var(--mut);margin-top:var(--space-3)}'
    + '.iv-wait{font-size:12px;color:var(--mut)}'
    + '.iv-banks{display:flex;gap:var(--space-2);overflow-x:auto;padding:2px 2px 6px;scroll-snap-type:x proximity}'
    + '.iv-bank{flex:0 0 216px;scroll-snap-align:start;position:relative;border:1px solid var(--line);border-radius:var(--radius);padding:var(--space-2);cursor:pointer;display:flex;flex-direction:column;gap:var(--space-1);font-size:12px;background:var(--bg)}'
    + '.iv-bank.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}'
    + '.iv-bank .iv-cover{height:44px;border-radius:6px;display:flex;align-items:flex-end;padding:4px 8px;color:#fff;font-weight:700}'
    + '.iv-bank .iv-bq{color:var(--mut);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}'
    + '.iv-bank .iv-feat{position:absolute;top:8px;right:8px;background:var(--accent);color:#fff;border-radius:4px;padding:0 6px;font-size:11px;line-height:18px}'
    + '.iv-stream{white-space:pre-wrap;word-break:break-word;font-family:var(--font);font-size:12px;color:var(--mut);max-height:160px;overflow:auto;margin:var(--space-1) 0 0}';
  document.head.appendChild(css);

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function badgeEl(cls, text) { var b = h('span', 'badge' + (cls ? ' ' + cls : ''), text); b.style.marginRight = '0'; return b; }

  // ===== 客户端状态 =====
  var sessions = Array.isArray(boot.sessions) ? boot.sessions.slice() : [];
  var cur = null;            // 当前打开的会话全量视图（GET /interview/session）
  var curAnswerDraft = '';   // 文本域内容（渲染不吞在途输入：busy 期间不重建文本域）
  var busy = { start: false, next: false, answer: false, hint: false, report: false };

  function apiGet(u) {
    return fetch(u).then(function (r) {
      return r.text().then(function (t) {
        var d = null; try { d = JSON.parse(t); } catch (e) {}
        if (!r.ok || !d || d.ok === false) throw new Error((d && d.error) || ('HTTP ' + r.status));
        return d;
      });
    });
  }
  // ===== SSE 客户端（POST + ReadableStream 逐帧；服务端未接流式时自动回退 JSON）=====
  // 帧协议（interview.routes.md §流式规范）：event: delta|done|error + data: JSON。
  // ssePost 解析为 Promise<donePayload>；delta 经 onDelta 增量回调；error 帧 → reject。
  function pumpSSE(stream, onDelta) {
    var reader = stream.getReader();
    var dec = new TextDecoder();
    var buf = '', donePayload = null;
    var handle = function (frame) {
      var ev = 'message', data = '';
      frame.split('\n').forEach(function (line) {
        if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) data += (data ? '\n' : '') + line.slice(5).replace(/^ /, '');
      });
      var payload = null; try { payload = JSON.parse(data); } catch (e) { payload = data; }
      if (ev === 'delta') { if (onDelta) onDelta((payload && typeof payload.text === 'string') ? payload.text : ''); }
      else if (ev === 'done') { donePayload = payload; }
      else if (ev === 'error') { throw new Error((payload && payload.error) || '生成失败'); }
    };
    var loop = function () {
      return reader.read().then(function (r) {
        buf += r.done ? dec.decode() : dec.decode(r.value, { stream: true });
        var cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          var f = buf.slice(0, cut); buf = buf.slice(cut + 2);
          if (f.trim()) handle(f);
        }
        if (r.done) return donePayload;
        return loop();
      });
    };
    return loop();
  }
  function ssePost(url, body, onDelta) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('text/event-stream') < 0) {
          return res.json().then(function (d) {
            if (!res.ok || !d || d.ok === false) throw new Error((d && d.error) || ('HTTP ' + res.status));
            return d;   // 非流式回退：整段 JSON 当 done 载荷
          });
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return pumpSSE(res.body, onDelta).then(function (d) {
          if (!d) throw new Error('流式生成中断：未收到完成帧');
          return d;
        });
      });
  }
  // ===== 题库橱窗 =====
  var bankStrip;
  function bankHue(slug, alt) {
    var h0 = 0;
    for (var i = 0; i < slug.length; i++) h0 = (h0 * 31 + slug.charCodeAt(i)) >>> 0;
    return 'hsl(' + ((h0 + alt * 40) % 360) + ',42%,42%)';
  }
  function renderBankStrip() {
    if (!bankStrip) return;
    bankStrip.textContent = '';
    var none = h('div', 'iv-bank' + (selBank === '' ? ' sel' : ''));
    var cv0 = h('div', 'iv-cover', 'AI');
    cv0.style.background = 'var(--accent-soft)';
    cv0.style.color = 'var(--mut)';
    none.appendChild(cv0);
    none.appendChild(h('b', null, '不用题库'));
    none.appendChild(h('span', 'iv-bq', '全程由 AI 按你的简历与职位出题'));
    none.addEventListener('click', function () { selBank = ''; renderBankStrip(); });
    bankStrip.appendChild(none);
    BANKS.forEach(function (b) {
      var c = h('div', 'iv-bank' + (selBank === b.slug ? ' sel' : ''));
      var cov = h('div', 'iv-cover', b.title);
      cov.style.background = 'linear-gradient(135deg,' + bankHue(b.slug, 0) + ',' + bankHue(b.slug, 1) + ')';
      c.appendChild(cov);
      if (b.isFeatured) c.appendChild(h('span', 'iv-feat', '精选'));
      var row = h('div');
      row.style.display = 'flex'; row.style.gap = '6px'; row.style.alignItems = 'center';
      row.appendChild(badgeEl('ai', b.category === 'TECH' ? '技术' : '通用'));
      row.appendChild(h('span', 'iv-note', String(b.questionCount || 0) + ' 题'));
      c.appendChild(row);
      var pq = (Array.isArray(b.previewQuestions) ? b.previewQuestions : [])[0];
      c.appendChild(h('span', 'iv-bq', (pq && pq.question) || b.intro || ''));
      c.addEventListener('click', function () { selBank = (selBank === b.slug) ? '' : b.slug; renderBankStrip(); });
      bankStrip.appendChild(c);
    });
    if (!BANKS.length) {
      var tip = h('div', 'iv-note', '题库不可用：未接入题库端点或暂无题库，可仍走纯 AI 出题');
      tip.style.alignSelf = 'center';
      bankStrip.appendChild(tip);
    }
  }
  function loadBanks() {
    return apiGet('/interview/banks?preview=1&limit=12')
      .then(function (d) { BANKS = Array.isArray(d.data) ? d.data : []; renderBankStrip(); })
      .catch(function () { BANKS = []; renderBankStrip(); });
  }
  function refreshSessions() {
    return apiGet('/interview/sessions').then(function (d) { sessions = d.sessions || []; renderList(); }).catch(function () {});
  }
  function openSession(id) {
    return apiGet('/interview/session?id=' + encodeURIComponent(id))
      .then(function (d) {
        cur = d.session; curAnswerDraft = '';
        renderRun();
        // 没有 pending 且未完：进来就补取下一题（继续中断的会话零多步操作）
        if (cur && !cur.pending && !cur.finished && !busy.next) doNext();
      })
      .catch(function (e) { __status(elRunMsg, 'err', e.message); });
  }

  // ===== 卡 1：新面试配置 =====
  var elCfgMsg;
  function renderConfig() {
    var card = h('div', 'card');
    card.appendChild(h('div', 'card-title', '开始新面试'));
    var grid = h('div', 'iv-row');
    grid.style.marginTop = 'var(--space-3)';

    var fVoice = h('div', 'iv-field');
    fVoice.appendChild(h('span', null, '面试官声音'));
    var vrow = h('div', 'iv-voices');
    VOICES.forEach(function (v, i) {
      var lab = document.createElement('label');
      var r = document.createElement('input');
      r.type = 'radio'; r.name = 'ivVoice'; r.value = v.id; r.disabled = true;   // 文字版占位禁用
      if (i === 0) r.checked = true;
      lab.appendChild(r); lab.appendChild(document.createTextNode(v.label));
      vrow.appendChild(lab);
    });
    fVoice.appendChild(vrow);
    fVoice.appendChild(h('span', 'iv-note', '语音为占位项：当前为文字版，语音未开放'));
    grid.appendChild(fVoice);

    var fType = h('div', 'iv-field');
    fType.appendChild(h('span', null, '面试类型'));
    var sel = document.createElement('select'); sel.id = 'ivType';
    TYPES.forEach(function (t) { var o = document.createElement('option'); o.value = t; o.textContent = TYPE_LABELS[t] || t; sel.appendChild(o); });
    fType.appendChild(sel); grid.appendChild(fType);

    var fCap = h('div', 'iv-field');
    fCap.appendChild(h('span', null, '题数'));
    fCap.appendChild(h('span', 'iv-note', String(CAP) + ' 题（固定）'));
    grid.appendChild(fCap);

    var fJob = h('div', 'iv-field');
    fJob.appendChild(h('span', null, '关联职位'));
    var sj = document.createElement('select'); sj.id = 'ivJob';
    var o0 = document.createElement('option'); o0.value = ''; o0.textContent = '不关联'; sj.appendChild(o0);
    JOBS.forEach(function (j) { var o = document.createElement('option'); o.value = j.id; o.textContent = j.label; sj.appendChild(o); });
    fJob.appendChild(sj); grid.appendChild(fJob);

    var fResume = h('div', 'iv-field');
    fResume.appendChild(h('span', null, '关联简历'));
    var sr = document.createElement('select'); sr.id = 'ivResume';
    var o1 = document.createElement('option'); o1.value = ''; o1.textContent = '不关联'; sr.appendChild(o1);
    RESUMES.forEach(function (r) { var o = document.createElement('option'); o.value = r.id; o.textContent = r.title || r.id; sr.appendChild(o); });
    fResume.appendChild(sr); grid.appendChild(fResume);

    var fBank = h('div', 'iv-field');
    fBank.style.width = '100%';
    fBank.appendChild(h('span', null, '题库（可选）'));
    bankStrip = h('div', 'iv-banks');
    fBank.appendChild(bankStrip);
    fBank.appendChild(h('span', 'iv-note', '选题库：前几题出自题库（不耗模型），题用尽由 AI 续出到 ' + CAP + ' 题；不选则全程 AI 出题'));
    grid.appendChild(fBank);
    renderBankStrip();

    var btn = h('button', null, '开始面试');
    btn.disabled = busy.start || !hasLLM;
    btn.addEventListener('click', function () {
      busy.start = true; btn.disabled = true; __status(elCfgMsg, 'warn', '');
      __wv('/interview/sessions', { type: sel.value, jobRef: sj.value, resumeId: sr.value, voice: 'zh-female', bankSlug: selBank }, elCfgMsg)
        .then(function (d) { refreshSessions(); if (d.session && d.session.id) openSession(d.session.id); })
        .catch(function () {})
        .finally(function () { busy.start = false; btn.disabled = !hasLLM; });
    });
    grid.appendChild(btn);
    card.appendChild(grid);

    elCfgMsg = h('div', 'iv-msg'); elCfgMsg.setAttribute('role', 'status');
    card.appendChild(elCfgMsg);
    if (!hasLLM) {
      var w = h('div', 'iv-note');
      w.style.marginTop = 'var(--space-2)';
      w.textContent = '未配置大模型：出题、提示与报告不可用。可到「设置」完成模型配置；已保存的会话仍可查看。';
      card.appendChild(w);
    }
    return card;
  }

  // ===== 卡 2：历史会话 =====
  var listWrap = h('div', 'iv-sessions');
  var elListMsg;
  function renderList() {
    listWrap.textContent = '';
    if (!sessions.length) { listWrap.appendChild(h('div', 'iv-note', '还没有面试会话：在上方配置一场')); return; }
    sessions.forEach(function (s) {
      var row = h('div', 'iv-sess');
      row.appendChild(badgeEl('', s.typeLabel || TYPE_LABELS[s.type] || s.type));
      if (s.bankTitle) row.appendChild(badgeEl('ai', '题库·' + s.bankTitle));
      var title = (s.company || s.role) ? (s.company + '·' + s.role).replace(/^·|·$/g, '') : (s.bankTitle || '通用面试');
      row.appendChild(h('b', null, title));
      row.appendChild(h('span', 'iv-grow', '已问 ' + s.asked + '/' + s.cap + ' · 已答 ' + s.answered + (s.hasReport ? ' · 已出报告' : '')));
      if (s.finished) row.appendChild(badgeEl('ok', '已完成')); else row.appendChild(badgeEl('warn', '进行中'));
      var open = h('button', 'secondary', '继续');
      open.addEventListener('click', function () { openSession(s.id); });
      var del = h('button', 'danger', '删除');
      del.addEventListener('click', function () {
        if (!window.confirm('删除这场面试记录？此操作不可恢复。')) return;
        __wv('/interview/sessions/delete', { id: s.id }, elListMsg)
          .then(function () { if (cur && cur.id === s.id) { cur = null; renderRun(); } refreshSessions(); })
          .catch(function () {});
      });
      row.appendChild(open); row.appendChild(del);
      listWrap.appendChild(row);
    });
  }

  // ===== 卡 3：面试进行 =====
  var runCard = h('div', 'card'); runCard.hidden = true;
  var elRunMsg, elQ, elProg, elAnswer, elHintBox, btnSubmit, btnSkip, btnHint, elWaitQ;
  function renderRun() {
    runCard.textContent = '';
    elRunMsg = h('div', 'iv-msg'); elRunMsg.setAttribute('role', 'status');
    if (!cur) { runCard.hidden = true; return; }
    runCard.hidden = false;
    var head = h('div', 'iv-row');
    head.style.justifyContent = 'space-between';
    var title = (cur.company || cur.role) ? (cur.company + '·' + cur.role).replace(/^·|·$/g, '') : (cur.bankTitle || '通用面试');
    head.appendChild(h('div', 'card-title', title + ' — ' + (TYPE_LABELS[cur.type] || cur.type) + (cur.bankTitle ? ' · 题库·' + cur.bankTitle : '')));
    elProg = h('span', 'iv-progress', '第 ' + Math.min((cur.questions ? cur.questions.length : 0) + (cur.pending ? 0 : 1), cur.questionCap || CAP) + '/' + (cur.questionCap || CAP) + ' 题 · 已答 ' + (cur.answeredCount || 0));
    head.appendChild(elProg);
    runCard.appendChild(head);

    elWaitQ = h('div', 'iv-wait');
    elQ = h('div', 'iv-q');
    if (cur.pending) elQ.textContent = cur.pending.question;
    else if (cur.finished) elQ.textContent = '全部 ' + (cur.questionCap || CAP) + ' 题已问完：可生成面试报告，或回上方重开一场。';
    else elQ.textContent = '（还没有题目）';
    runCard.appendChild(elQ);
    runCard.appendChild(elWaitQ);

    if (!cur.finished) {
      var hintAct = h('div', 'iv-acts');
      btnHint = h('button', 'secondary', '生成提示');
      btnHint.disabled = !cur.pending || !hasLLM || busy.hint;
      btnHint.addEventListener('click', doHint);
      hintAct.appendChild(btnHint);
      runCard.appendChild(hintAct);
      elHintBox = h('div'); renderHint();
      runCard.appendChild(elHintBox);

      elAnswer = h('textarea', 'iv-answer');
      elAnswer.placeholder = '在这里输入你的回答（文字版：打字作答）';
      elAnswer.value = curAnswerDraft;
      elAnswer.addEventListener('input', function () { curAnswerDraft = elAnswer.value; });
      runCard.appendChild(elAnswer);

      var acts = h('div', 'iv-acts');
      btnSubmit = h('button', null, '提交回答');
      btnSubmit.disabled = !cur.pending || busy.answer || busy.next;
      btnSubmit.addEventListener('click', function () { doAnswer(false); });
      btnSkip = h('button', 'secondary', '跳过此题');
      btnSkip.disabled = !cur.pending || busy.answer || busy.next;
      btnSkip.addEventListener('click', function () { doAnswer(true); });
      acts.appendChild(btnSubmit); acts.appendChild(btnSkip);
      runCard.appendChild(acts);
    }
    runCard.appendChild(elRunMsg);
    renderReportCard();
  }
  function renderHint() {
    elHintBox.textContent = '';
    if (!cur || !cur.pending) return;
    var rec = cur.hints && cur.hints[String(cur.pending.index)];
    if (!rec || !Array.isArray(rec.points) || !rec.points.length) return;
    var box = h('div', 'iv-hint');
    box.appendChild(h('b', null, '答题要点'));
    var ul = document.createElement('ul');
    rec.points.forEach(function (p) { ul.appendChild(h('li', null, p)); });
    box.appendChild(ul);
    elHintBox.appendChild(box);
  }
  function doNext() {
    if (!cur || busy.next) return;
    busy.next = true;
    elWaitQ.textContent = '';
    var tick = startTicker(function (mm) { elWaitQ.textContent = '出题中 · 已等待 ' + mm; });
    __wv('/interview/next', { id: cur.id }, elRunMsg)
      .then(function (d) {
        if (d.done) { cur.finished = true; cur.pending = null; }
        else { cur.pending = { index: d.index, question: d.question }; if (!cur.questions) cur.questions = []; cur.questions.push({ index: d.index, text: d.question, status: 'pending' }); }
        curAnswerDraft = '';
        renderRun(); refreshSessions();
      })
      .catch(function () {})
      .finally(function () { clearInterval(tick); busy.next = false; if (elWaitQ) elWaitQ.textContent = ''; });
  }
  function doAnswer(skip) {
    if (!cur || !cur.pending || busy.answer) return;
    var text = skip ? '' : String(elAnswer.value || '').trim();
    if (!skip && !text) { __status(elRunMsg, 'err', '请先输入回答，或点「跳过此题」'); return; }
    busy.answer = true; btnSubmit.disabled = true; btnSkip.disabled = true;
    __wv('/interview/answer', skip ? { id: cur.id, skip: true } : { id: cur.id, answer: text }, elRunMsg)
      .then(function () { cur.pending = null; curAnswerDraft = ''; doNext(); })
      .catch(function () {})
      .finally(function () { busy.answer = false; renderRun(); });
  }
  function doHint() {
    if (!cur || !cur.pending || busy.hint) return;
    busy.hint = true; btnHint.disabled = true;
    // 流式渲染：delta 文本逐帧落进 iv-stream；done 帧（或非流式 JSON 回退）落定后渲染要点列表。
    var box = h('div', 'iv-hint');
    box.appendChild(h('b', null, '答题要点'));
    var streamEl = h('pre', 'iv-stream');
    var waitEl = h('span', 'iv-wait');
    box.appendChild(streamEl); box.appendChild(waitEl);
    elHintBox.textContent = ''; elHintBox.appendChild(box);
    var tick = startTicker(function (mm) { waitEl.textContent = '生成中 · 已等待 ' + mm; });
    var acc = '';
    ssePost('/interview/hint', { id: cur.id, index: cur.pending.index, stream: true }, function (t) {
      acc += t; streamEl.textContent = acc;
    })
      .then(function (d) {
        if (!d || d.ok === false) throw new Error((d && d.error) || '生成失败');
        if (!cur.hints) cur.hints = {};
        cur.hints[String(d.index)] = { points: d.points };
        renderHint();
      })
      .catch(function (e) { __status(elRunMsg, 'err', e.message); renderHint(); })
      .finally(function () { clearInterval(tick); busy.hint = false; if (btnHint) btnHint.disabled = !hasLLM || !cur || !cur.pending; });
  }

  // ===== 卡 4：报告 =====
  var reportCard = h('div', 'card'); reportCard.hidden = true;
  var elRepMsg, btnReport, elRepWait;
  function renderReportCard() {
    reportCard.textContent = '';
    elRepMsg = h('div', 'iv-msg'); elRepMsg.setAttribute('role', 'status');
    if (!cur) { reportCard.hidden = true; return; }
    reportCard.hidden = false;
    var head = h('div', 'iv-row');
    head.style.justifyContent = 'space-between';
    head.appendChild(h('div', 'card-title', '面试报告'));
    btnReport = h('button', 'secondary', cur.report ? '重新生成报告' : '生成报告');
    btnReport.disabled = !hasLLM || busy.report || (cur.answeredCount || 0) < 1;
    btnReport.addEventListener('click', doReport);
    head.appendChild(btnReport);
    reportCard.appendChild(head);
    elRepWait = h('div', 'iv-wait');
    reportCard.appendChild(elRepWait);
    reportCard.appendChild(elRepMsg);
    if (!hasLLM) reportCard.appendChild(h('div', 'iv-note', '未配置大模型：报告不可用。到「设置」完成模型配置后可生成。'));
    else if ((cur.answeredCount || 0) < 1) reportCard.appendChild(h('div', 'iv-note', '至少回答 1 题后才能生成报告。'));
    if (cur.report) {
      var cols = h('div', 'iv-cols');
      [['优势', 'ok', cur.report.strengths], ['短板', 'warn', cur.report.gaps], ['建议', 'ai', cur.report.advice]].forEach(function (c) {
        var col = h('div', 'iv-col');
        var t = h('h3'); t.appendChild(badgeEl(c[1], c[0])); col.appendChild(t);
        var ul = document.createElement('ul');
        (Array.isArray(c[2]) ? c[2] : []).forEach(function (x) { ul.appendChild(h('li', null, x)); });
        if (!ul.children.length) ul.appendChild(h('li', null, '（无）'));
        col.appendChild(ul);
        cols.appendChild(col);
      });
      reportCard.appendChild(cols);
      var meta = h('div', 'iv-report-meta', '生成于 ' + (cur.report.at || '未知时间') + (cur.report.model ? ' · 模型 ' + cur.report.model : ''));
      reportCard.appendChild(meta);
    }
  }
  function doReport() {
    if (!cur || busy.report) return;
    busy.report = true; btnReport.disabled = true;
    // 流式渲染：模型原文逐帧进 iv-stream（报告输出是 JSON，增量原文是诚实进度）；
    // done 帧收到 {ok:true,report}（或非流式 JSON 回退）才解析三列结构展示。
    var streamEl = h('pre', 'iv-stream');
    var waitTxt = h('span', null, '');
    elRepWait.textContent = ''; elRepWait.appendChild(waitTxt); elRepWait.appendChild(streamEl);
    var tick = startTicker(function (mm) { waitTxt.textContent = '模型调用中 · 已等待 ' + mm; });
    var acc = '';
    ssePost('/interview/report', { id: cur.id, stream: true }, function (t) {
      acc += t; streamEl.textContent = acc;
    })
      .then(function (d) {
        if (!d || d.ok === false || !d.report) throw new Error((d && d.error) || '生成失败');
        cur.report = d.report; renderReportCard(); refreshSessions();
      })
      .catch(function (e) { __status(elRepMsg, 'err', e.message); })
      .finally(function () { clearInterval(tick); busy.report = false; elRepWait.textContent = ''; if (btnReport) btnReport.disabled = !hasLLM || (cur.answeredCount || 0) < 1; });
  }

  // ===== 组装 =====
  mount.textContent = '';
  var stack = h('div', 'iv-stack');
  stack.appendChild(renderConfig());
  var listCard = h('div', 'card');
  listCard.appendChild(h('div', 'card-title', '历史会话'));
  elListMsg = h('div', 'iv-msg'); elListMsg.setAttribute('role', 'status');
  listCard.appendChild(elListMsg);
  listCard.appendChild(listWrap);
  stack.appendChild(listCard);
  stack.appendChild(runCard);
  stack.appendChild(reportCard);
  mount.appendChild(stack);
  renderList();
  refreshSessions();
  loadBanks();
})();
