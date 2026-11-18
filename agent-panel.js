// agent-panel.js — 「Agent 求职助手」页面前端（classic script，仿 ai-panel.js 注入方式）。
// 挂载点：/agent 页 inner 里的 <div id="agent-app"></div>。
// 协议与 agent.mjs / agent.routes.md 对齐：sessions CRUD + /agent/chat。
// 聊天走 SSE：POST {id,message,stream:1} + Accept:text/event-stream → data: <UIMessageChunk> 帧
// （text-delta 增量渲染 + finish 的完整 UIMessage 对账）；服务端未升级仍回整段 JSON 时自动回退。
(function () {
  var mount = document.getElementById('agent-app');
  if (!mount) return;
  // __status 由 page() 的 STATUS_SCRIPT 提供；__icon 仅编辑器页注入（应用页缺省降级为空串，不炸）。
  var __status = window.__status || function (el, kind, text) { if (el) el.textContent = text; };
  var __icon = window.__icon || function () { return ''; };

  // ===== 样式（:root token；--accent 主行动）=====
  var css = document.createElement('style');
  css.setAttribute('data-agent-panel', '1');
  css.textContent =
    '#agent-app .ag-wrap{display:grid;grid-template-columns:230px minmax(0,1fr);gap:var(--space-3);height:calc(100vh - 170px);min-height:460px}'
    + '#agent-app .ag-side{display:flex;flex-direction:column;min-height:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg)}'
    + '#agent-app .ag-side .ag-newbox{padding:var(--space-2);border-bottom:1px solid var(--line)}'
    + '#agent-app #ag-new{width:100%}'
    + '#agent-app #ag-sessions{flex:1;overflow:auto;padding:var(--space-2)}'
    + '#agent-app .ag-sess{padding:7px 8px;border-radius:var(--radius);cursor:pointer;display:flex;align-items:center;gap:6px;font-size:13px}'
    + '#agent-app .ag-sess:hover{background:var(--bg)}'
    + '#agent-app .ag-sess.on{background:var(--accent-soft)}'
    + '#agent-app .ag-sess .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink)}'
    + '#agent-app .ag-sess.on .t{color:var(--accent);font-weight:600}'
    + '#agent-app .ag-sess .ops{display:none;gap:2px;flex:none}'
    + '#agent-app .ag-sess:hover .ops,#agent-app .ag-sess.on .ops{display:flex}'
    + '#agent-app .ag-sess .ops button{min-height:22px;padding:0 6px;font-size:11px;background:transparent;border:1px solid var(--line);color:var(--mut);border-radius:6px}'
    + '#agent-app .ag-sess .ops button:hover{color:var(--ink);background:var(--panel)}'
    + '#agent-app .ag-empty-side{padding:var(--space-3);font-size:12px;color:var(--mut)}'
    + '#agent-app .ag-main{display:flex;flex-direction:column;min-height:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius-lg)}'
    + '#agent-app #ag-log{flex:1;overflow:auto;padding:var(--space-4)}'
    + '#agent-app .ag-m{margin:0 0 var(--space-3);max-width:82%;padding:9px 12px;border-radius:12px;border:1px solid var(--line);background:var(--panel);white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.65}'
    + '#agent-app .ag-m.user{margin-left:auto;background:var(--accent-soft);border-color:var(--accent);color:var(--ink)}'
    + '#agent-app .ag-m.ai{background:var(--panel)}'
    + '#agent-app .ag-m.ag-wait{color:var(--mut);border-style:dashed}'
    + '#agent-app .ag-hello{margin:0 0 var(--space-4);padding:var(--space-4);border:1px solid var(--line);border-radius:var(--radius-lg);background:var(--card-2)}'
    + '#agent-app .ag-hello .h{font-size:16px;font-weight:700;margin-bottom:var(--space-2)}'
    + '#agent-app .ag-hello .s{font-size:13px;color:var(--mut);margin-bottom:var(--space-3)}'
    + '#agent-app .ag-chipset{display:flex;gap:6px;flex-wrap:wrap}'
    + '#agent-app .ag-chip{border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:12px;background:var(--panel);cursor:pointer;min-height:26px;color:var(--ink)}'
    + '#agent-app .ag-chip:hover{border-color:var(--accent);color:var(--accent)}'
    + '#agent-app .ag-tc{margin:var(--space-2) 0 0;padding:var(--space-2) var(--space-3);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:var(--radius);background:var(--card-2);font-size:12px;white-space:normal}'
    + '#agent-app .ag-tc .tt{font-weight:700;font-size:13px}'
    + '#agent-app .ag-tc .row{color:var(--mut);margin-top:2px}'
    + '#agent-app .ag-tc .ag-ts{display:inline-block;margin-left:6px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:400;border:1px solid var(--line);color:var(--mut);vertical-align:1px}'
    + '#agent-app .ag-tc .ag-ts svg{vertical-align:-2px;margin-right:2px}'
    + '#agent-app .ag-tc .ag-ts.ok{color:var(--ok);border-color:var(--ok);background:var(--ok-soft)}'
    + '#agent-app .ag-tc .ag-ts.warn{color:var(--warn);border-color:var(--warn);background:var(--warn-soft)}'
    + '#agent-app .ag-tc .ag-ts.err{color:var(--err);border-color:var(--err);background:var(--err-soft)}'
    + '#agent-app .ag-tc .ag-tin{font-family:var(--font-mono);font-size:11px}'
    + '#agent-app .ag-tc a{color:var(--accent);font-weight:600}'
    + '#agent-app .ag-qr{display:flex;gap:6px;flex-wrap:wrap;margin-top:var(--space-2)}'
    + '#agent-app .ag-qr button{border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--ink);font-size:12px;min-height:26px;padding:3px 11px;cursor:pointer}'
    + '#agent-app .ag-qr button:hover{border-color:var(--accent);color:var(--accent)}'
    + '#agent-app .ag-input{display:flex;align-items:flex-end;gap:var(--space-2);padding:var(--space-3);border-top:1px solid var(--line)}'
    + '#agent-app #ag-msg{flex:1;resize:none;border:1px solid var(--line);border-radius:var(--radius);padding:8px 10px;font:inherit;font-size:13px;background:var(--panel);color:var(--ink);max-height:160px}'
    + '#agent-app #ag-send:disabled{opacity:.55;cursor:not-allowed}'
    + '#agent-app .ag-status{margin:0 0 var(--space-3);font-size:12px}'
    + '@media (max-width:860px){#agent-app .ag-wrap{grid-template-columns:1fr;height:auto}#agent-app .ag-side{max-height:180px}#agent-app .ag-main{min-height:60vh}}';

  // ===== DOM =====
  mount.innerHTML =
    '<div class="ag-wrap">'
    + '<aside class="ag-side"><div class="ag-newbox"><button id="ag-new" type="button">＋ 新会话</button></div><div id="ag-sessions" aria-label="会话列表"></div></aside>'
    + '<section class="ag-main"><div id="ag-log" aria-live="polite"></div>'
    + '<div class="ag-input"><textarea id="ag-msg" rows="1" placeholder="输入消息（Enter 发送，Shift+Enter 换行）；可用 [context:job:岗位id] / [context:doc:简历id] 引用对象" aria-label="消息输入"></textarea><button id="ag-send" type="button">发送</button></div>'
    + '</section></div>';
  document.head.appendChild(css);

  var $ = function (id) { return document.getElementById(id); };
  var log = $('ag-log'), sessBox = $('ag-sessions'), input = $('ag-msg'), sendBtn = $('ag-send');
  var current = null;   // 当前会话 id（null = 未选/未建，发送时自动建）
  var sending = false;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // URL 白名单（与 server safe-url 同口径）：只放行 http(s)，其余协议不渲染成链接
  function linkOk(u) { return /^https?:\/\//i.test(String(u || '')); }

  // ===== 网络（写请求语义同 ai-panel postJson：非 ok/业务 ok:false 都进失败分支，409 给中文原因）=====
  async function api(method, url, body) {
    var opt = { method: method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var r = await fetch(url, opt);
    var data = null, txt = '';
    var ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { data = await r.json(); } catch (e) { data = null; } }
    else { txt = await r.text(); }
    if (!r.ok || (data && data.ok === false)) {
      var e = new Error((data && (data.error || data.msg)) || txt || ('HTTP ' + r.status));
      e.rejected = true;
      throw e;
    }
    return data;
  }

  // ===== 等待秒表（照抄 ai-panel.js：真实信号只有耗时，绝不造假百分比）=====
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

  // ===== 渲染 =====
  function scrollEnd() { log.scrollTop = log.scrollHeight; }
  function addUser(text) {
    var d = document.createElement('div');
    d.className = 'ag-m user';
    d.textContent = text;
    log.appendChild(d); scrollEnd();
  }
  function addStatus(text, kind) {
    var d = document.createElement('div');
    d.className = 'ag-m ag-status';
    log.appendChild(d);
    __status(d, kind || 'warn', text);
    scrollEnd();
  }
  // 工具卡：job-detail（岗位）/ resume-card（简历）；未知类型降级为类型名+JSON
  function cardHtml(tc) {
    var p = tc && tc.payload ? tc.payload : {};
    if (tc.type === 'job-detail') {
      var src = p.source === 'inbox' ? '收件箱' : p.source === 'app' ? '投递记录' : p.source === 'eval' ? '评估' : '';
      var meta = [p.company, p.role, p.salary].filter(Boolean).join(' · ');
      var line2 = [p.status ? '状态 ' + p.status : '', p.score != null ? '评分 ' + p.score : '', p.dueDate ? '截止 ' + p.dueDate : ''].filter(Boolean).join('　');
      var link = linkOk(p.url) ? ' <a href="' + esc(p.url) + '" target="_blank" rel="noopener">申请链接 →</a>' : (p.url ? '' : ' <span style="color:var(--mut)">无申请链接</span>');
      var act = p.source === 'inbox' ? ' <a href="/inbox">去收件箱</a>' : p.source === 'app' ? ' <a href="/app?id=' + esc(p.id) + '">投递详情</a>' : '';
      return '<div class="ag-tc"><div class="tt">' + esc(p.title || p.id) + (src ? ' <span class="badge" style="margin-right:0">' + src + '</span>' : '') + '</div>'
        + (meta ? '<div class="row">' + esc(meta) + '</div>' : '')
        + (line2 ? '<div class="row">' + esc(line2) + '</div>' : '')
        + '<div class="row">' + link + act + '</div></div>';
    }
    if (tc.type === 'resume-card') {
      var kind = p.kind === 'job' ? '岗位定制' : '母版';
      var cr = [p.company, p.role].filter(Boolean).join(' · ');
      return '<div class="ag-tc"><div class="tt">' + esc(p.title || p.id) + ' <span class="badge" style="margin-right:0">' + kind + '</span></div>'
        + (cr ? '<div class="row">' + esc(cr) + '</div>' : '')
        + '<div class="row"><a href="/edit?id=' + encodeURIComponent(p.id) + '">打开编辑 →</a></div></div>';
    }
    return '<div class="ag-tc"><div class="tt">' + esc(tc.type || 'card') + '</div><div class="row">' + esc(JSON.stringify(p).slice(0, 200)) + '</div></div>';
  }
  // ===== 真实工具执行卡（tool-<name> part：调用名 + state 徽章 + input 摘要 + output 摘要）=====
  // 与 cardHtml 分工：cardHtml 画「上下文引用」展示卡（job-detail/resume-card）；
  // toolPartHtml 画 server 侧真实执行的调用卡——多轮工具环里按 parts 时间序与过渡文本混排。
  var TOOL_SRC_LABEL = { inbox: '收件箱', app: '投递记录', eval: '评估' };
  var APP_STATUS_LB = { to_apply: '待投递', preparing: '准备中', applied: '已投递', replied: '有回复', interviewing: '面试中', offer: 'Offer', closed: '已关闭' };
  var REAL_TOOLS = ['get_job_detail', 'query_job_progress', 'list_resumes', 'get_resume_summary'];
  function toolStateBadge(st, output) {
    if (output && output.ok === false) return '<span class="ag-ts err">' + __icon('circle-alert') + '失败</span>';
    if (st === 'output-available') return '<span class="ag-ts ok">' + __icon('circle-check') + '已返回</span>';
    if (st === 'call' || st === 'input-available' || st === 'input-streaming') return '<span class="ag-ts warn">' + __icon('clock') + '调用中</span>';
    return '<span class="ag-ts err">' + __icon('circle-alert') + '失败</span>';
  }
  function kvSummary(input) {
    if (!input || typeof input !== 'object') return '';
    return Object.keys(input).map(function (k) {
      var v = input[k];
      return k + '=' + (v && typeof v === 'object' ? JSON.stringify(v) : String(v));
    }).join(' ').slice(0, 140);
  }
  // 各工具 output → 纯文本摘要行（最多 3 行；进 HTML 前逐行 esc）
  function toolOutputLines(name, o) {
    if (!o || typeof o !== 'object') return [];
    if (o.ok === false) return ['失败：' + String(o.error || '未知错误')];
    if (name === 'get_job_detail') {
      return [
        [TOOL_SRC_LABEL[o.source] || o.source || '', o.title || o.id || ''].filter(Boolean).join(' '),
        [o.company, o.role, o.salary].filter(Boolean).join(' · '),
        [(o.statusLabel || o.status) ? '状态 ' + (o.statusLabel || o.status) : '', o.score != null ? '评分 ' + o.score : '', o.dueDate ? '截止 ' + o.dueDate : ''].filter(Boolean).join('　')
      ].filter(function (l) { return l; });
    }
    if (name === 'query_job_progress') {
      var bs = o.byStatus || {};
      var cnt = Object.keys(bs).filter(function (k) { return bs[k] > 0; }).map(function (k) { return (APP_STATUS_LB[k] || k) + '×' + bs[k]; }).join('、');
      var L = ['共 ' + (o.total || 0) + ' 条投递' + (cnt ? '：' + cnt : '')];
      if (o.dueSoon && o.dueSoon.length) {
        L.push('近 ' + (o.dueSoonDays || 7) + ' 日到期 ' + o.dueSoon.length + ' 条：' + o.dueSoon.slice(0, 3).map(function (a) { return (a.company || a.id) + ' ' + a.dueDate; }).join('；') + (o.dueSoon.length > 3 ? ' 等' : ''));
      }
      if (o.items) L.push('过滤「' + (o.statusLabel || o.status) + '」' + o.items.length + ' 条');
      return L;
    }
    if (name === 'list_resumes') {
      var items = o.items || [];
      return ['共 ' + (o.total != null ? o.total : items.length) + ' 份' + (items.length ? '：' + items.slice(0, 5).map(function (d) { return d.title || d.id; }).join('、') + (items.length > 5 ? ' 等' : '') : '')];
    }
    if (name === 'get_resume_summary') {
      var secs = (o.sections || []).map(function (s) { return s.title; }).filter(Boolean);
      var hds = o.headings || [];
      var titles = secs.length ? secs : hds;
      return ['「' + (o.title || o.id) + '」' + (o.sectionCount || hds.length || 0) + ' 个章节' + (titles.length ? '：' + titles.slice(0, 6).join('、') + (titles.length > 6 ? ' 等' : '') : '')];
    }
    return [JSON.stringify(o).slice(0, 160)];
  }
  function toolPartHtml(p) {
    var name = String(p.type || '').slice(5);
    var inp = kvSummary(p.input);
    return '<div class="ag-tc"><div class="tt">' + esc(name) + toolStateBadge(p.state, p.output) + '</div>'
      + (inp ? '<div class="row ag-tin">' + esc(inp) + '</div>' : '')
      + toolOutputLines(name, p.output).slice(0, 3).map(function (l) { return '<div class="row">' + esc(l) + '</div>'; }).join('')
      + '</div>';
  }
  // 实况帧渲染：toolCallId 复用同一 wrapper（call → output-available 就地更新，多轮步序不乱）
  function upsertToolCard(bubble, part, liveMap) {
    var id = part.toolCallId || ('auto-' + Object.keys(liveMap).length);
    var w = liveMap[id];
    if (!w) { w = document.createElement('div'); liveMap[id] = w; bubble.appendChild(w); }
    w.innerHTML = toolPartHtml(part);
  }
  // ===== UIMessage 渲染：parts 归一（新形状）+ 老 {text,quickReplies,toolCards} 字段兜底 =====
  function partsOf(m) { return (m && Array.isArray(m.parts)) ? m.parts : []; }
  function msgText(m) {
    if (!m) return '';
    if (typeof m.text === 'string') return m.text;   // 老格式
    return partsOf(m).filter(function (p) { return p && p.type === 'text' && typeof p.text === 'string'; })
      .map(function (p) { return p.text; }).join('');
  }
  function msgCards(m) {
    if (m && Array.isArray(m.toolCards)) return m.toolCards;   // 老格式/非流式回退响应
    return partsOf(m).filter(function (p) {
      return p && typeof p.type === 'string' && p.type.indexOf('tool-') === 0 && p.type !== 'tool-ui-quickReplies' && p.state === 'output-available' && p.output;
    }).map(function (p) { return { type: p.type.slice(5), payload: p.output }; });
  }
  function msgReplies(m) {
    if (m && Array.isArray(m.quickReplies)) return m.quickReplies;   // 老格式/非流式回退响应
    var p = partsOf(m).filter(function (x) { return x && x.type === 'tool-ui-quickReplies'; })[0];
    return (p && p.output && Array.isArray(p.output.options)) ? p.output.options : [];
  }
  // 展示卡/执行卡统一入口：真实工具输出（非流式回退通道里也是 {type,payload} 形状）走执行卡，其余走 cardHtml
  function appendCardEl(d, tc) {
    var w = document.createElement('div');
    w.innerHTML = REAL_TOOLS.indexOf(tc.type) >= 0
      ? toolPartHtml({ type: 'tool-' + tc.type, state: 'output-available', input: {}, output: tc.payload })
      : cardHtml(tc);
    while (w.firstChild) d.appendChild(w.firstChild);
  }
  function appendQr(d, opts) {
    if (!opts || !opts.length) return;
    var qr = document.createElement('div');
    qr.className = 'ag-qr';
    opts.forEach(function (q) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = q.label;
      if (q.description) b.title = q.description;
      // 回填即发送：quickReplies.message 是完整下一步指令（协议字段，非占位符）
      b.onclick = function () { input.value = q.message; send(); };
      qr.appendChild(b);
    });
    d.appendChild(qr);
  }
  // 助手气泡整体渲染：有 parts 按时间序逐 part 渲染（多轮工具环里执行卡与过渡文本混排）；
  // 正文走 textContent（模型输出永不进 innerHTML）；卡走 cardHtml/toolPartHtml（内部全 esc）；
  // 无 parts 的老字段消息走兜底通道。
  function renderAiInto(d, m) {
    d.innerHTML = '';
    var parts = partsOf(m);
    if (parts.length) {
      var textEl = null;
      parts.forEach(function (p) {
        if (!p || typeof p.type !== 'string') return;
        if (p.type === 'text') {
          if (typeof p.text !== 'string' || !p.text) return;
          var te = document.createElement('div');
          te.textContent = p.text;
          d.appendChild(te);
          if (!textEl) textEl = te;
        } else if (p.type === 'tool-ui-quickReplies') {
          appendQr(d, (p.output && p.output.options) || []);
        } else if (p.type === 'tool-job-detail' || p.type === 'tool-resume-card') {
          appendCardEl(d, { type: p.type.slice(5), payload: p.output });   // 上下文/引用展示卡
        } else if (p.type.indexOf('tool-') === 0) {
          var w = document.createElement('div');
          w.innerHTML = toolPartHtml(p);   // 真实工具执行卡（call / output-available / 错误态都画）
          while (w.firstChild) d.appendChild(w.firstChild);
        }
        // step-start / 未知 part：不渲染（时间序占位）
      });
      return textEl;
    }
    var te2 = document.createElement('div');
    te2.textContent = msgText(m);
    d.appendChild(te2);
    msgCards(m).forEach(function (tc) { appendCardEl(d, tc); });
    appendQr(d, msgReplies(m));
    return te2;
  }
  function addAiMsg(m) {
    var d = document.createElement('div');
    d.className = 'ag-m ai';
    renderAiInto(d, m);
    log.appendChild(d); scrollEnd();
  }
  // 非流式回退响应 {reply,quickReplies,toolCards} → 借老字段通道进同一渲染
  function addAi(resp) {
    addAiMsg({ role: 'assistant', text: (resp && resp.reply) || '', quickReplies: resp && resp.quickReplies, toolCards: resp && resp.toolCards });
  }
  function renderHistory(s) {
    log.innerHTML = '';
    var msgs = (s && s.messages) || [];
    if (!msgs.length) { renderWelcome(); return; }
    msgs.forEach(function (m) {
      if (m.role === 'user') addUser(msgText(m));
      else if (m.role === 'assistant') addAiMsg(m);
    });
  }
  function renderWelcome() {
    var h = new Date().getHours();
    var greet = h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
    var d = document.createElement('div');
    d.className = 'ag-hello';
    d.innerHTML = '<div class="h">' + greet + '。今天想先推进哪一步？</div>'
      + '<div class="s">我可以帮你评估收件箱岗位、改简历、盯投递进度。引用具体对象用 [context:job:岗位id] 或 [context:doc:简历id]。</div>';
    var chips = document.createElement('div');
    chips.className = 'ag-chipset';
    [
      { t: '评估收件箱', m: '评估收件箱里现在的岗位，告诉我哪些值得推进' },
      { t: '帮我改简历', m: '帮我看看现在的简历还能怎么改' },
      { t: '看今天的截止', m: '看看今天有哪些投递临近截止或需要跟进' }
    ].forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ag-chip'; b.textContent = c.t;
      b.onclick = function () { input.value = c.m; send(); };
      chips.appendChild(b);
    });
    d.appendChild(chips);
    log.appendChild(d); scrollEnd();
  }

  // ===== 会话列表 =====
  async function loadSessions(selectId) {
    sessBox.innerHTML = '';
    var d;
    try { d = await api('GET', '/agent/sessions'); }
    catch (e) { sessBox.innerHTML = '<div class="ag-empty-side">会话列表加载失败</div>'; return; }
    var list = (d && d.sessions) || [];
    if (!list.length) { sessBox.innerHTML = '<div class="ag-empty-side">还没有会话，点上方「＋ 新会话」开始</div>'; return; }
    list.forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'ag-sess' + (s.id === (selectId || current) ? ' on' : '');
      row.title = s.lastText || s.title;
      var t = document.createElement('span');
      t.className = 't'; t.textContent = s.title || '未命名';
      var ops = document.createElement('span');
      ops.className = 'ops';
      var rn = document.createElement('button');
      rn.type = 'button'; rn.textContent = '改名'; rn.title = '重命名';
      rn.onclick = function (ev) {
        ev.stopPropagation();
        var nt = window.prompt('会话名称', s.title || '');
        if (nt == null || !nt.trim()) return;
        api('PATCH', '/agent/sessions/' + encodeURIComponent(s.id), { title: nt.trim() })
          .then(function () { loadSessions(s.id); })
          .catch(function (e) { addStatus(e.message || e, 'warn'); });
      };
      var del = document.createElement('button');
      del.type = 'button'; del.textContent = '删'; del.title = '删除会话';
      del.onclick = function (ev) {
        ev.stopPropagation();
        if (!window.confirm('删除这个会话？消息记录一并删除，不可恢复。')) return;
        api('DELETE', '/agent/sessions/' + encodeURIComponent(s.id))
          .then(function () { if (current === s.id) { current = null; log.innerHTML = ''; renderWelcome(); } loadSessions(); })
          .catch(function (e) { addStatus(e.message || e, 'warn'); });
      };
      ops.appendChild(rn); ops.appendChild(del);
      row.appendChild(t); row.appendChild(ops);
      row.onclick = function () { openSession(s.id); };
      sessBox.appendChild(row);
    });
  }
  async function openSession(id) {
    current = id;
    loadSessions(id);
    try {
      var d = await api('GET', '/agent/sessions/' + encodeURIComponent(id));
      renderHistory(d.session || d);
    } catch (e) { addStatus(e.message || e, 'warn'); }
    input.focus();
  }
  async function ensureSession() {
    if (current) return current;
    var d = await api('POST', '/agent/sessions', {});
    current = d.session.id;
    loadSessions(current);
    return current;
  }

  // ===== 发送（SSE 流式）=====
  // POST /agent/chat {id,message,stream:1} + Accept:text/event-stream → data: <UIMessageChunk> 帧。
  // text-delta 增量进当前气泡（textContent）；finish 携带完整 UIMessage 整体对账重渲；
  // {type:'error',errorText} → 中文状态条；服务端未升级仍回整段 JSON → 自动回退原渲染。
  async function sendStream(sid, msg, onFirst) {
    var r = await fetch('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ id: sid, message: msg, stream: 1 })
    });
    var ct = r.headers.get('content-type') || '';
    if (!(r.ok && ct.indexOf('text/event-stream') >= 0)) {
      // 整段回退/错误：与 api() 同口径——非 ok 或 ok:false 进失败分支，中文原因
      var data = null, txt = '';
      if (ct.indexOf('application/json') >= 0) { try { data = await r.json(); } catch (e) { data = null; } }
      else { txt = await r.text(); }
      if (!r.ok || (data && data.ok === false)) {
        var e = new Error((data && (data.error || data.msg)) || txt || ('HTTP ' + r.status));
        e.rejected = true;
        throw e;
      }
      addAi(data);
      return;
    }
    var d = null, textEl = null, shown = '', blockText = '', ended = false, errText = '', first = true;
    var toolEls = {};   // toolCallId → 实况工具卡 wrapper（call → output-available 就地更新）
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    for (;;) {
      var rd = await reader.read();
      buf += rd.done ? dec.decode() : dec.decode(rd.value, { stream: true });
      var cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        var frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
        var lines = frame.split('\n');
        for (var li = 0; li < lines.length; li++) {
          var line = lines[li];
          if (line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5);
          if (payload.charAt(0) === ' ') payload = payload.slice(1);
          if (payload === '[DONE]') { ended = true; break; }
          var ev; try { ev = JSON.parse(payload); } catch (e2) { continue; }
          if (ev.type === 'text-delta' && typeof ev.delta === 'string' && ev.delta) {
            if (first) { first = false; onFirst(); }
            if (!d) {
              d = document.createElement('div'); d.className = 'ag-m ai';
              log.appendChild(d);
            }
            if (!textEl) { textEl = document.createElement('div'); d.appendChild(textEl); blockText = ''; }
            shown += ev.delta; blockText += ev.delta;
            textEl.textContent = blockText;   // 增量全走 textContent：模型输出永不进 innerHTML
            scrollEnd();
          } else if (ev.type === 'tool-part' && ev.part && typeof ev.part === 'object') {
            if (first) { first = false; onFirst(); }
            if (!d) { d = document.createElement('div'); d.className = 'ag-m ai'; log.appendChild(d); }
            upsertToolCard(d, ev.part, toolEls);
            textEl = null;   // 下一帧 text-delta 另起文本块：过渡句与最终答复不混在同一段
            scrollEnd();
          } else if (ev.type === 'finish' && ev.message) {
            ended = true;
            if (first) { first = false; onFirst(); }
            if (!d) { d = document.createElement('div'); d.className = 'ag-m ai'; log.appendChild(d); }
            renderAiInto(d, ev.message);   // finish 的完整 UIMessage 为准（对账增量文本）
            scrollEnd();
          } else if (ev.type === 'error') {
            errText = ev.errorText || '模型调用失败';
          }
        }
        if (ended) break;
      }
      if (rd.done || ended) break;
    }
    try { reader.cancel(); } catch (e3) {}
    if (errText) { addStatus(errText, 'warn'); return; }
    if (!ended && !shown) throw new Error('未收到回复：连接已断开');
    if (!ended) addStatus('连接已断开：回复可能不完整', 'warn');
  }
  async function send() {
    var msg = input.value.trim();
    if (!msg || sending) return;   // 防连点/Enter 重入：并发请求会打乱消息顺序
    sending = true;
    sendBtn.disabled = true;
    // 清欢迎卡：首条消息发出后对话流接管
    var hello = log.querySelector('.ag-hello');
    if (hello) hello.remove();
    addUser(msg);
    var waitEl = document.createElement('div');
    waitEl.className = 'ag-m ag-wait';
    var tick = startTicker(function (mm) { waitEl.textContent = '回复中 · 已等待 ' + mm; });
    log.appendChild(waitEl); scrollEnd();
    // 首个 text-delta/finish 到达即停秒表：流式文本本身就是进度信号
    var waited = true;
    var stopWait = function () {
      if (!waited) return;
      waited = false;
      clearInterval(tick);
      waitEl.remove();
    };
    try {
      var sid = await ensureSession();
      await sendStream(sid, msg, stopWait);
      input.value = ''; input.style.height = '';   // 成功后才清空：失败时用户输入保留（同 ai-panel AUD-15）
      loadSessions(sid);   // 首条消息可能触发了自动命名，刷新列表
    } catch (e) {
      addStatus(e.message || e, 'warn');
    } finally {
      stopWait();
      sending = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }
  sendBtn.onclick = send;
  // 多行输入：Enter 发送、Shift+Enter 换行；输入法组字中的 Enter 是选词，不发送（照抄 ai-panel.js）
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  var fit = function () { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; };
  input.addEventListener('input', fit);

  // ===== 启动 =====
  $('ag-new').onclick = function () {
    if (sending) return;
    api('POST', '/agent/sessions', {})
      .then(function (d) { current = d.session.id; log.innerHTML = ''; renderWelcome(); loadSessions(current); input.focus(); })
      .catch(function (e) { addStatus(e.message || e, 'warn'); });
  };
  renderWelcome();
  loadSessions().then(function () {
    // 有历史会话时自动打开最近一个（更像「回来接着聊」）
    return api('GET', '/agent/sessions').then(function (d) {
      var first = ((d && d.sessions) || [])[0];
      if (first) openSession(first.id);
    });
  }).catch(function () { /* 列表失败不影响输入 */ });
})();
