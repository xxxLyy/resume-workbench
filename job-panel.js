// job-panel.js — 岗位草稿审阅面板（修改清单 / 待补充 / 冲突门控）
// 由 server /edit 对岗位草稿幂等注入（JOB-INJECT 注释对），/save 时剥离，文档零污染。
// 职责：展示生成建议 → 逐条/批量接受 → 应用到正文（可撤销）→ 状态回写服务端（刷新后保留）。
(function () {
  var DOC_ID = document.currentScript.getAttribute('data-doc');
  var pane = document.getElementById('ed-pane-review');
  if (!pane) return;
  var sheet = document.querySelector('.sheet');
  if (!sheet) return;

  // 幂等清理
  ['jp-root'].forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  document.querySelectorAll('style[data-job-panel]').forEach(function (el) { el.remove(); });

  var css = document.createElement('style');
  css.setAttribute('data-job-panel', '1');
  css.textContent = '.jp{padding:12px;font-size:12px;display:flex;flex-direction:column;gap:8px}'
    + '.jp-meta{color:var(--ed-mut);font-size:11px}'
    + '.jp-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center}'
    + '.jp-head button{min-height:28px;padding:0 10px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-head button.jp-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.jp-head button:disabled{opacity:.55;cursor:not-allowed}'
    + '.jp-sum{display:flex;flex-wrap:wrap;gap:4px}'
    + '.jp-group{border:1px solid var(--ed-line);border-radius:9px;padding:8px}'
    + '.jp-group h4{margin:0 0 6px;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:6px}'
    + '.jp-group.jp-important{border-color:var(--ed-warn);background:var(--ed-warn-soft)}'
    + '.jp-group.jp-conflict{border-color:var(--ed-err-soft);background:var(--ed-err-soft)}'
    + '.jp-item{border-top:1px solid var(--ed-line);padding:6px 0}'
    + '.jp-item:first-of-type{border-top:none}'
    + '.jp-item .jp-reason{color:var(--ed-mut);font-size:11px;margin:2px 0}'
    + '.jp-before{background:var(--ed-err-soft);text-decoration:line-through;border-radius:5px;padding:2px 4px;margin:2px 0;word-break:break-all}'
    + '.jp-after{background:var(--ed-ok-soft);border-radius:5px;padding:2px 4px;margin:2px 0;word-break:break-all}'
    + '.jp-item .jp-ops{margin-top:4px;display:flex;gap:4px;flex-wrap:wrap}'
    + '.jp-item .jp-ops button{min-height:24px;padding:0 8px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-item .jp-ops button.jp-accept{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.jp-st{font-size:10px;border-radius:999px;padding:1px 7px;background:var(--ed-bg);color:var(--ed-mut);margin-left:6px}'
    + '.jp-st.accepted{background:var(--ed-ok-soft);color:var(--ed-ok)}'
    + '.jp-st.rejected{background:var(--ed-bg);color:var(--ed-mut)}'
    + '.jp-st.conflict{background:var(--ed-err-soft);color:var(--ed-err)}'
    + '.jp-todo{border-left:3px solid var(--ed-warn);background:var(--ed-warn-soft);border-radius:6px;padding:6px 8px;margin:4px 0}'
    + '.jp-empty{color:var(--ed-mut);text-align:center;padding:16px 8px}'
    + '.jp-msg{font-size:11px;color:var(--ed-warn)}'
    // S4a-T6 三段骨架（要求与证据｜修改清单｜导出检查）+ 证据表最小渲染
    + '.jp-secs{display:flex;gap:2px;border-bottom:1px solid var(--ed-line);padding-bottom:8px}'
    + '.jp-secs button{flex:1;min-height:26px;padding:0 8px;border:none;background:transparent;font-size:12px;font-weight:600;color:var(--ed-mut);cursor:pointer;border-radius:7px}'
    + '.jp-secs button.on{color:var(--ed-accent);background:var(--ed-accent-soft)}'
    + '.jp-secs button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.jp-ev-head{display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap}'
    + '.jp-ev-head button{min-height:24px;padding:0 8px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-st.sourced,.jp-st.thin{background:var(--ed-warn-soft);color:var(--ed-warn)}'
    + '.jp button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}';
  document.head.appendChild(css);

  var root = document.createElement('div');
  root.id = 'jp-root';
  root.className = 'jp';
  pane.appendChild(root);

  var job = null, doc = null, busy = false;
  // S4a-T6 三段骨架状态：当前段（evidence|changes|export）+ reviewPos 筛选位（T9 落 UI）+ 任务轮询链
  var curSec = null, posFilter = 'all', pollTimer = null;
  var SEC_LABELS = { evidence: '要求与证据', changes: '修改清单', export: '导出检查' };

  function api(url, body) {
    return fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) { d._status = r.status; return d; });
    });
  }
  function note(msg) { var m = root.querySelector('.jp-msg'); if (m) m.textContent = msg; }

  // ===== DOM 定位（章节/条目锚点）=====
  function sections() { return Array.prototype.slice.call(sheet.querySelectorAll('.section')); }
  function sectionByTitle(t) {
    if (!t) return null;
    var needle = String(t).trim();
    return sections().find(function (s) {
      var x = s.querySelector('.section-title');
      var txt = x ? x.textContent.trim() : '';
      return txt && (txt.indexOf(needle) >= 0 || needle.indexOf(txt) >= 0);
    }) || null;
  }
  function entryPairs(sec) {
    var out = [];
    if (!sec) return out;
    Array.prototype.forEach.call(sec.querySelectorAll('.entry-head'), function (head) {
      var ul = head.nextElementSibling && head.nextElementSibling.tagName === 'UL' ? head.nextElementSibling : null;
      var titleEl = head.querySelector('.entry-title');
      var roleEl = head.querySelector('.entry-role');
      out.push({
        head: head, ul: ul,
        title: (titleEl ? titleEl.textContent : roleEl ? roleEl.textContent : '').trim()
      });
    });
    return out;
  }
  function findEntry(c) {
    var sec = sectionByTitle(c.section);
    var title = String(c.entry || '').trim();
    if (sec && title) {
      var pairs = entryPairs(sec);
      var hit = pairs.find(function (p) { return p.title && (p.title.indexOf(title) >= 0 || title.indexOf(p.title) >= 0); });
      if (hit) return { sec: sec, pair: hit, all: pairs };
    }
    // 退化：全文按标题找
    var globals = [];
    sections().forEach(function (s) { entryPairs(s).forEach(function (p) { globals.push({ sec: s, pair: p }); }); });
    var g = globals.find(function (x) { return title && x.pair.title && (x.pair.title.indexOf(title) >= 0 || title.indexOf(x.pair.title) >= 0); });
    if (g) return { sec: g.sec, pair: g.pair, all: entryPairs(g.sec) };
    return null;
  }
  function hidePair(pair, on) {
    pair.head.classList.toggle('ed-entry-hidden', on);
    if (pair.ul) pair.ul.classList.toggle('ed-entry-hidden', on);
  }

  // ===== 正文替换（跨节点 + 重复消歧；与 ai-panel 同算法，模块独立）=====
  function replaceText(before, after, opts) {
    opts = opts || {};
    var walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
    var nodes = [], stream = '', n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: stream.length }); stream += n.data; }
    var matches = [], idx = stream.indexOf(before);
    while (idx >= 0) { matches.push(idx); idx = stream.indexOf(before, idx + (before.length || 1)); }
    if (!matches.length) return false;
    var chosen = 0;
    if (typeof opts.occurrence === 'number' && opts.occurrence >= 0 && opts.occurrence < matches.length) chosen = opts.occurrence;
    else if (opts.context) {
      var ci = matches.findIndex(function (m) {
        var s = Math.max(0, m - 60), e = Math.min(stream.length, m + before.length + 60);
        return stream.slice(s, e).indexOf(opts.context) >= 0;
      });
      if (ci >= 0) chosen = ci;
    }
    var start = matches[chosen], end = start + before.length, first = -1;
    for (var i = 0; i < nodes.length; i++) {
      var s0 = nodes[i].start, e0 = s0 + nodes[i].node.data.length;
      if (e0 > start && s0 < end) { first = i; break; }
    }
    if (first < 0) return false;
    for (var j = 0; j < nodes.length; j++) {
      var nd = nodes[j].node, ns = nodes[j].start, ne = ns + nd.data.length;
      if (ne <= start || ns >= end) continue;
      var from = Math.max(start, ns) - ns, to = Math.min(end, ne) - ns;
      nd.data = nd.data.slice(0, from) + (j === first ? after : '') + nd.data.slice(to);
    }
    touch();
    return true;
  }
  // 程序化变更统一出口（S2-T5）：走外壳共享入口（合成 input 保持 dirty 语义 + 补 op 时间戳）；无外壳时退回裸派发
  function touch() {
    if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    else sheet.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ===== 应用/撤销一条修改 =====
  function applyChange(c) {
    if (c.kind === 'replace') {
      if (replaceText(c.before, c.after, { occurrence: c.meta && c.meta.occurrence, context: c.context })) return { ok: true, meta: {} };
      return { ok: false, error: '原文未找到（内容可能已被手工修改）' };
    }
    if (c.kind === 'hide') {
      var found = findEntry(c);
      if (found) { hidePair(found.pair, true); touch(); return { ok: true, meta: { target: 'entry', title: found.pair.title } }; }
      var sec = sectionByTitle(c.section);
      if (sec) { sec.classList.add('ed-sec-hidden'); touch(); return { ok: true, meta: { target: 'section', title: c.section } }; }
      return { ok: false, error: '找不到要隐藏的章节/条目' };
    }
    if (c.kind === 'reorder') {
      var f2 = findEntry(c);
      if (!f2) return { ok: false, error: '找不到要调整顺序的条目' };
      var pairs = f2.all, cur = pairs.indexOf(f2.pair);
      var to = String(c.to || 'top');
      var anchorPair = null;
      if (to === 'top') anchorPair = pairs[0];
      else if (to === 'bottom') anchorPair = pairs[pairs.length - 1];
      else if (to === '上一条') anchorPair = pairs[Math.max(0, cur - 2)];
      else if (to === '下一条') anchorPair = pairs[Math.min(pairs.length - 1, cur + 2)];
      else if (c.entryTo) { anchorPair = pairs.find(function (p) { return p.title.indexOf(String(c.entryTo).trim()) >= 0; }) || null; }
      if (!anchorPair || anchorPair === f2.pair) return { ok: false, error: '排序目标不存在或无需移动' };
      var before = anchorPair.head;
      var isDown = pairs.indexOf(anchorPair) > cur;
      var moveNodes = f2.pair.ul ? [f2.pair.head, f2.pair.ul] : [f2.pair.head];
      if (isDown) {
        var afterNodes = anchorPair.ul ? [anchorPair.head, anchorPair.ul] : [anchorPair.head];
        var ref = afterNodes[afterNodes.length - 1].nextElementSibling;
        moveNodes.forEach(function (nd) { sheet.insertBefore(nd, ref); });
      } else {
        moveNodes.slice().reverse().forEach(function (nd) { sheet.insertBefore(nd, before); });
      }
      touch();
      return { ok: true, meta: { target: 'reorder', origIndex: cur, title: f2.pair.title } };
    }
    if (c.kind === 'add') {
      var sec2 = sectionByTitle(c.section);
      if (!sec2) return { ok: false, error: '找不到目标章节' };
      var ul = sec2.querySelector('ul');
      var node = document.createElement(ul ? 'li' : 'p');
      node.textContent = c.after;
      (ul || sec2).appendChild(node);
      touch();
      return { ok: true, meta: { target: 'add', title: c.section } };
    }
    return { ok: false, error: '未知修改类型：' + c.kind };
  }
  function revertChange(c) {
    if (c.kind === 'replace') return replaceText(c.after, c.before, { context: c.context }) ? { ok: true } : { ok: false, error: '撤销失败：改后文本已变化' };
    if (c.kind === 'hide') {
      var found = findEntry(c);
      if (found) { hidePair(found.pair, false); touch(); return { ok: true }; }
      var sec = sectionByTitle(c.section);
      if (sec) { sec.classList.remove('ed-sec-hidden'); touch(); return { ok: true }; }
      return { ok: false, error: '撤销失败：目标不存在' };
    }
    if (c.kind === 'reorder') {
      var f2 = findEntry(c);
      if (!f2 || !c.meta || typeof c.meta.origIndex !== 'number') return { ok: false, error: '撤销失败：找不到条目或原始位置' };
      var pairs = f2.all, cur = pairs.indexOf(f2.pair);
      var target = c.meta.origIndex;
      if (cur === target) return { ok: true };
      var refPair = pairs[target];
      var moveNodes = f2.pair.ul ? [f2.pair.head, f2.pair.ul] : [f2.pair.head];
      var refNode = refPair && refPair.head !== f2.pair.head ? refPair.head : null;
      if (target >= pairs.length) { moveNodes.forEach(function (nd) { sheet.appendChild(nd); }); }
      else if (refNode) { moveNodes.slice().reverse().forEach(function (nd) { sheet.insertBefore(nd, refNode); }); }
      touch();
      return { ok: true };
    }
    if (c.kind === 'add') {
      var hit = null;
      sheet.querySelectorAll('li,p').forEach(function (el) { if (!hit && el.childNodes.length === 1 && el.textContent.trim() === c.after.trim()) hit = el; });
      if (hit) { hit.remove(); touch(); return { ok: true }; }
      return { ok: false, error: '撤销失败：找不到插入的内容' };
    }
    return { ok: false, error: '未知类型' };
  }

  function setStatus(updates, extra) {
    return api('/job/changes?id=' + DOC_ID, Object.assign({ updates: updates }, extra || {})).then(function (d) {
      if (d.ok) job = d.job; else note('⚠️ ' + (d.error || '状态保存失败'));
      render();
      return d;
    });
  }

  function accept(c) {
    if (busy) return; busy = true;
    if (window.__edPushUndo) window.__edPushUndo('接受修改：' + (c.note || c.kind));
    var r = applyChange(c);
    busy = false;
    if (!r.ok) { note('⚠️ ' + r.error); return; }
    setStatus([{ id: c.id, status: 'accepted', meta: r.meta }]);
  }
  function revert(c) {
    if (busy) return; busy = true;
    if (window.__edPushUndo) window.__edPushUndo('撤销修改：' + (c.note || c.kind));
    var r = revertChange(c);
    busy = false;
    if (!r.ok) { note('⚠️ ' + r.error); return; }
    setStatus([{ id: c.id, status: 'reverted' }]);
  }
  function batchAccept(ids) {
    if (busy) return; busy = true;
    if (window.__edPushUndo) window.__edPushUndo('批量接受 ' + ids.length + ' 条');
    var updates = [], fails = 0;
    ids.forEach(function (id) {
      var c = job.changes.find(function (x) { return x.id === id; });
      if (!c) return;
      var r = applyChange(c);
      if (r.ok) updates.push({ id: c.id, status: 'accepted', meta: r.meta });
      else { fails++; updates.push({ id: c.id, status: 'pending', note: r.error }); }
    });
    busy = false;
    if (fails) note('⚠️ ' + fails + ' 条未能应用（原文可能已变化），其余已接受');
    setStatus(updates);
  }

  // ===== 渲染 =====
  var STATUS_LABEL = { pending: '待处理', accepted: '已接受', rejected: '已跳过', reverted: '已撤销', resolved: '已处理', superseded: '旧候选' };
  function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
  function itemHtml(c, group) {
    var div = document.createElement('div');
    div.className = 'jp-item';
    var title = document.createElement('div');
    title.innerHTML = '<b>' + esc(short(c.section || '文档', 12)) + (c.entry ? ' / ' + esc(short(c.entry, 14)) : '') + '</b>'
      + '<span class="jp-st ' + (c.level === 'conflict' ? 'conflict' : c.status) + '">' + (STATUS_LABEL[c.status] || c.status) + '</span>';
    div.appendChild(title);
    if (c.reason) { var why = document.createElement('div'); why.className = 'jp-reason'; why.textContent = '理由：' + c.reason + (c.source ? '（来源：' + c.source + '）' : ''); div.appendChild(why); }
    if (c.kind === 'replace') {
      var b = document.createElement('div'); b.className = 'jp-before'; b.textContent = c.before; div.appendChild(b);
      var a = document.createElement('div'); a.className = 'jp-after'; a.textContent = c.after; div.appendChild(a);
    } else if (c.kind === 'hide') {
      var h = document.createElement('div'); h.className = 'jp-before'; h.textContent = '隐藏：' + (c.entry || c.section) + '（内容保留，可恢复）'; div.appendChild(h);
    } else if (c.kind === 'reorder') {
      var r = document.createElement('div'); r.className = 'jp-reason'; r.textContent = '排序：' + (c.entry || '') + ' → ' + (c.to || '顶部'); div.appendChild(r);
    } else if (c.kind === 'add') {
      var ad = document.createElement('div'); ad.className = 'jp-after'; ad.textContent = '新增到「' + c.section + '」：' + c.after; div.appendChild(ad);
    }
    var ops = document.createElement('div');
    ops.className = 'jp-ops';
    var mkBtn = function (label, cls, fn) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (cls) btn.className = cls;
      btn.addEventListener('click', fn);
      ops.appendChild(btn);
    };
    var locate = function () {
      var t = c.before || c.entry || c.section;
      if (!t) return;
      var walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT);
      var n;
      while ((n = walker.nextNode())) {
        if (n.data.indexOf(t) >= 0) {
          (n.parentElement || sheet).scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        }
      }
      note('⚠️ 未找到定位目标（内容可能已变化）');
    };
    if (c.status === 'pending' || c.status === 'superseded') {
      mkBtn(c.level === 'conflict' ? '确认接受（无冲突）' : '接受', 'jp-accept', function () { accept(c); });
      mkBtn('跳过', '', function () { setStatus([{ id: c.id, status: 'rejected' }]); });
      mkBtn('定位', '', locate);
    } else if (c.status === 'accepted') {
      mkBtn('撤销', '', function () { revert(c); });
      mkBtn('定位', '', locate);
    } else if (c.status === 'reverted' || c.status === 'rejected') {
      mkBtn('重新接受', '', function () { setStatus([{ id: c.id, status: 'pending' }]); });
      mkBtn('定位', '', locate);
    }
    div.appendChild(ops);
    return div;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function groupBox(title, items, opts) {
    if (!items.length) return null;
    var box = document.createElement('div');
    box.className = 'jp-group' + (opts && opts.cls ? ' ' + opts.cls : '');
    var h = document.createElement('h4');
    h.textContent = title + '（' + items.length + '）';
    if (opts && opts.batch) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '批量接受（' + opts.batch.length + '）';
      btn.addEventListener('click', function () { batchAccept(opts.batch.map(function (c) { return c.id; })); });
      h.appendChild(btn);
    }
    box.appendChild(h);
    items.forEach(function (c) { box.appendChild(itemHtml(c)); });
    return box;
  }

  // ===== S4a-T6 三段切换（共用岗位上下文；reviewPos 服务端持久化，刷新后恢复）=====
  function secBar() {
    var bar = document.createElement('div');
    bar.className = 'jp-secs';
    ['evidence', 'changes', 'export'].forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-sec', s);
      b.textContent = SEC_LABELS[s];
      if (s === curSec) b.className = 'on';
      b.addEventListener('click', function () { setSec(s); });
      bar.appendChild(b);
    });
    return bar;
  }
  function setSec(sec) {
    if (!SEC_LABELS[sec] || sec === curSec) return;
    curSec = sec;
    savePos();
    render();
  }
  function savePos() {
    var rp = { section: curSec, changeId: null, filter: posFilter };
    if (job) job.reviewPos = rp;   // 本地先行，避免下次渲染前丢段
    api('/job/changes?id=' + DOC_ID, { reviewPos: rp }).then(function (d) { if (d.ok && d.job) job = d.job; }).catch(function () {});
  }
  // 初始进入：读 reviewPos 恢复段与筛选；无记录时有建议默认修改清单、未生成默认要求与证据（设计 §5.2 决策 2）
  function applyReviewPos() {
    var rp = job && job.reviewPos;
    posFilter = (rp && rp.filter) || 'all';
    curSec = (rp && SEC_LABELS[rp.section]) ? rp.section : (((job.changes || []).length) ? 'changes' : 'evidence');
  }
  // 数据刷新（含任务 running 时的轮询链：链只在 running 期间自续，任务结束自然停止）
  function refresh() {
    return api('/job/changes?id=' + DOC_ID).then(function (d) {
      if (!d.ok) return;
      job = d.job; doc = d.doc;
      render();
      var gt = job.genTasks || {};
      if ((gt.evidence && gt.evidence.status === 'running') || (gt.changes && gt.changes.status === 'running')) schedulePoll();
    }).catch(function () {});
  }
  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setTimeout(function () { pollTimer = null; refresh(); }, 2500);
  }

  function render() {
    if (!job) {
      root.innerHTML = '<div class="jp-empty">本文件不是岗位草稿。</div>';
      return;
    }
    root.innerHTML = '';
    root.appendChild(secBar());
    if (curSec === 'evidence') renderEvidence();
    else if (curSec === 'export') renderExport();
    else renderChanges();
    var msg = document.createElement('div');
    msg.className = 'jp-msg';
    root.appendChild(msg);
  }

  // ===== 段一「要求与证据」：本任务为最小只读版（任务状态 + 条目列表；完整 UI 见 T7）=====
  var EV_STATUS = { covered: '简历已覆盖', sourced: '素材有据·简历未表达', thin: '表达不充分', todo: '待补充', none: '未找到证据' };
  var GT_LABEL = { idle: '未生成', running: '正在分析证据…', done: '已生成', error: '失败', cancelled: '已取消' };
  function renderEvidence() {
    var gt = (job.genTasks || {}).evidence || {};
    var box = document.createElement('div');
    box.className = 'jp-group';
    var headEl = document.createElement('div');
    headEl.className = 'jp-ev-head';
    var title = document.createElement('h4');
    title.style.margin = '0';
    title.textContent = '岗位要求—证据对应（要求来源：JD）';
    headEl.appendChild(title);
    var st = document.createElement('span');
    st.className = 'jp-st ' + gt.status;
    st.textContent = GT_LABEL[gt.status] || gt.status || '未生成';
    headEl.appendChild(st);
    var act = document.createElement('button');
    act.type = 'button';
    if (gt.status === 'running') {
      act.className = 'jp-ev-cancel';
      act.textContent = '取消';
      act.addEventListener('click', function () {
        api('/job/gen-cancel?id=' + DOC_ID + '&kind=evidence&taskId=' + encodeURIComponent(gt.taskId || ''), {}).then(function (d) {
          note(d.ok ? '已取消' : '⚠️ ' + (d.error || '取消失败'));
          refresh();
        });
      });
    } else {
      act.textContent = gt.status === 'done' || gt.status === 'cancelled' ? '重新分析' : (gt.status === 'error' ? '重试' : '生成证据');
      act.addEventListener('click', function () {
        api('/job/gen-start?id=' + DOC_ID + '&kind=evidence', {}).then(function (d) {
          if (!d.ok) { note('⚠️ ' + (d.error || '启动失败')); return; }
          job.genTasks = job.genTasks || {};
          job.genTasks.evidence = { taskId: d.taskId, status: 'running', startedAt: Date.now() };
          note('正在分析证据…');
          render();
          schedulePoll();
        });
      });
    }
    headEl.appendChild(act);
    box.appendChild(headEl);
    if (gt.error) { var err = document.createElement('div'); err.className = 'jp-reason'; err.textContent = '失败原因：' + gt.error; box.appendChild(err); }
    root.appendChild(box);

    var list = job.evidence || [];
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'jp-empty';
      empty.textContent = '尚未生成证据表：从 JD 提取要求并对照已确认素材与正文段落。';
      root.appendChild(empty);
      return;
    }
    list.forEach(function (e) {
      var div = document.createElement('div');
      div.className = 'jp-item';
      var title2 = document.createElement('div');
      title2.innerHTML = '<b>' + esc(short(e.req || '（无要求描述）', 40)) + '</b>'
        + '<span class="jp-st ' + (e.status || 'todo') + '">' + (EV_STATUS[e.status] || e.status || '待补充') + '</span>'
        + (e.stale ? '<span class="jp-st conflict">来源已变化</span>' : '');
      div.appendChild(title2);
      (e.refs || []).forEach(function (r) {
        var line = document.createElement('div');
        line.className = 'jp-reason';
        var src = r.type === 'mat' ? '素材：' + (r.title || r.id || '') : '正文段落' + (r.title ? '（' + r.title + '）' : '');
        line.textContent = '· ' + src + (r.quote ? '「' + short(r.quote, 40) + '」' : '') + (r.fresh === false ? '（已失效，需重新核对）' : '');
        div.appendChild(line);
      });
      if (!(e.refs || []).length) {
        var none = document.createElement('div');
        none.className = 'jp-reason';
        none.textContent = e.status === 'none' ? '当前已确认来源中未找到证据。' : '暂无有效引用。';
        div.appendChild(none);
      }
      root.appendChild(div);
    });
  }

  // ===== 段三「导出检查」：占位（S4a-T10 落地）=====
  function renderExport() {
    var box = document.createElement('div');
    box.className = 'jp-group';
    box.innerHTML = '<h4>导出检查（第三步）</h4><div class="jp-meta">导出前的检查清单（事实冲突门控 / 待核对 / 风格建议）将在第三步落地。</div>';
    root.appendChild(box);
    var exp = document.createElement('a');
    exp.href = '/export?id=' + DOC_ID;
    exp.textContent = '前往导出页';
    exp.style.cssText = 'font-size:12px';
    root.appendChild(exp);
  }

  // ===== 段二「修改清单」：既有渲染原样保留 =====
  function renderChanges() {
    var head = document.createElement('div');
    head.className = 'jp-head';
    var meta = document.createElement('span');
    meta.className = 'jp-meta';
    meta.textContent = (doc && doc.company ? doc.company + '·' + doc.role : '') + (job.generatedAt ? ' · 建议生成于 ' + job.generatedAt.slice(0, 16).replace('T', ' ') : ' · 尚未生成建议');
    head.appendChild(meta);
    var gen = document.createElement('button');
    gen.className = 'jp-primary';
    gen.textContent = job.changes.some(function (c) { return c.status === 'pending'; }) ? '重新生成建议' : '生成建议';
    gen.disabled = busy;
    gen.title = '重新生成会产生新的候选版本，不覆盖你的手工修改';
    gen.addEventListener('click', function () {
      if (busy) return; busy = true; gen.disabled = true;
      note('生成中（约几十秒）…');
      api('/job/generate?id=' + DOC_ID, {}).then(function (d) {
        busy = false;
        if (!d.ok) { note('⚠️ ' + (d.error || '生成失败')); gen.disabled = false; return; }
        job = d.job; note('✅ 已生成 ' + d.generated + ' 条建议（旧候选标记为 superseded）'); render();
      }).catch(function (e) { busy = false; note('⚠️ ' + e.message); gen.disabled = false; });
    });
    head.appendChild(gen);
    var exp = document.createElement('a');
    exp.href = '/export?id=' + DOC_ID;
    exp.textContent = '导出';
    exp.style.cssText = 'font-size:12px;margin-left:4px';
    head.appendChild(exp);
    if (doc && doc.parent) {
      var cmp = document.createElement('a');
      cmp.href = '/diff?base=' + doc.parent + '&to=' + DOC_ID;
      cmp.textContent = '与母版对比';
      cmp.style.cssText = 'font-size:12px;margin-left:4px';
      head.appendChild(cmp);
    }
    root.appendChild(head);

    var changes = job.changes || [];
    var pending = changes.filter(function (c) { return c.status === 'pending'; });
    var normal = changes.filter(function (c) { return c.status !== 'superseded' && c.level !== 'conflict' && c.level !== 'important' && ['replace', 'add'].indexOf(c.kind) >= 0 && c.status !== 'accepted' && c.status !== 'reverted' && c.status !== 'rejected'; });
    var reorder = changes.filter(function (c) { return c.level !== 'conflict' && c.level !== 'important' && c.kind === 'reorder' && c.status !== 'superseded' && c.status !== 'accepted' && c.status !== 'reverted' && c.status !== 'rejected'; });
    var hides = changes.filter(function (c) { return c.kind === 'hide' && c.status !== 'superseded'; });
    var important = changes.filter(function (c) { return c.level === 'important' && c.status !== 'superseded'; });
    var conflicts = changes.filter(function (c) { return c.level === 'conflict' && c.status !== 'superseded'; });
    var history = changes.filter(function (c) { return ['accepted', 'reverted', 'rejected'].indexOf(c.status) >= 0; });

    var sum = document.createElement('div');
    sum.className = 'jp-sum';
    [['待处理', pending.length, 'badge'], ['重点审阅', important.filter(function (c) { return c.status === 'pending'; }).length, 'badge warn'], ['事实冲突', conflicts.filter(function (c) { return c.status === 'pending'; }).length, 'badge err'], ['已接受', changes.filter(function (c) { return c.status === 'accepted'; }).length, 'badge ok']]
      .forEach(function (x) {
        if (!x[1]) return;
        var b = document.createElement('span');
        b.className = x[2];
        b.textContent = x[0] + ' ' + x[1];
        sum.appendChild(b);
      });
    root.appendChild(sum);

    if (conflicts.some(function (c) { return c.status === 'pending'; })) {
      var gate = document.createElement('div');
      gate.className = 'jp-group jp-conflict';
      gate.innerHTML = '<b>⛔ 事实冲突未解决前不能导出</b><div class="jp-meta">逐条确认接受或撤销后解除。</div>';
      root.appendChild(gate);
    }
    [groupBox('普通表达', normal, { batch: normal }),
     groupBox('排序调整', reorder, { batch: reorder }),
     groupBox('隐藏经历（需逐条确认）', hides),
     groupBox('可能改变原意（单独审阅）', important, { cls: 'jp-important' }),
     groupBox('事实冲突', conflicts, { cls: 'jp-conflict' }),
     groupBox('已处理历史', history)
    ].forEach(function (box) { if (box) root.appendChild(box); });

    // 待补充信息（不写进正文；导出前应处理或保留在侧）
    var todos = (job.todos || []).filter(function (t) { return !t.resolved; });
    var todoBox = document.createElement('div');
    todoBox.className = 'jp-group';
    todoBox.innerHTML = '<h4>待补充信息（' + todos.length + '）</h4>' + (todos.length
      ? todos.map(function (t, i) { return '<div class="jp-todo"><b>' + esc(t.section || '') + '</b>：' + esc(t.question) + (t.why ? '<div class="jp-meta">' + esc(t.why) + '</div>' : '') + '<button data-todo="' + i + '" style="margin-top:4px;min-height:24px;padding:0 8px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel)">标记已补充</button></div>'; }).join('')
      : '<div class="jp-meta">无</div>');
    root.appendChild(todoBox);
    todoBox.querySelectorAll('button[data-todo]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = Number(btn.dataset.todo);
        var active = (job.todos || []).filter(function (t) { return !t.resolved; });
        var target = active[i];
        if (!target) return;
        var todos2 = (job.todos || []).map(function (t) { return t === target ? Object.assign({}, t, { resolved: true }) : t; });
        setStatus([], { todos: todos2 });
      });
    });

    // 生成时采用的素材
    var mats = window.__MATS__ || [];
    var usedIds = job.materials || [];
    var usedBox = document.createElement('div');
    usedBox.className = 'jp-group';
    usedBox.innerHTML = '<h4>生成时采用的素材（' + usedIds.length + '）</h4>' + (usedIds.length
      ? usedIds.map(function (mid) {
          var m = mats.find(function (x) { return x.id === mid; });
          return '<div class="jp-meta">· ' + esc(m ? m.title : mid) + (m && m.confirmed === true ? '（已确认）' : '（未确认？）') + '</div>';
        }).join('')
      : '<div class="jp-meta">未选素材；生成时只用母版与已确认素材。</div>');
    root.appendChild(usedBox);

    var help = document.createElement('div');
    help.className = 'jp-meta';
    help.textContent = '提示：接受操作会修改正文（底部「↩ 撤销」可整体回退）；隐藏内容可在外壳左栏点「显」恢复。';
    root.appendChild(help);
  }

  // 初始进入：读 reviewPos 恢复段与筛选（刷新后位置恢复）
  api('/job/changes?id=' + DOC_ID).then(function (d) {
    if (!d.ok) return;
    job = d.job; doc = d.doc;
    applyReviewPos();
    render();
    var gt = job.genTasks || {};
    if ((gt.evidence && gt.evidence.status === 'running') || (gt.changes && gt.changes.status === 'running')) schedulePoll();
  }).catch(function () {});

  // 外壳 Tab 切换到「审阅」时刷新（反映最新落盘状态；不重置当前段）
  window.addEventListener('ed-review-refresh', function () { refresh(); });
})();
