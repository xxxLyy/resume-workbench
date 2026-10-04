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
    // S4a-T7 证据表完整 UI（原型 02b）：事实依据行 / note 两级流程 / zid 定位
    + '.jp-ref{color:var(--ed-mut);font-size:11px;margin:3px 0;display:flex;gap:5px;align-items:baseline;flex-wrap:wrap}'
    + '.jp-ref .jp-fact{background:var(--ed-ok-soft);color:var(--ed-ok);font-size:10px;border-radius:4px;padding:0 6px;flex:none}'
    + '.jp-ref .jp-refbtn{min-height:20px;padding:0 6px;border-radius:5px;font-size:10px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink);flex:none}'
    + '.jp-note{margin-top:6px;border:1px dashed var(--ed-line);border-radius:6px;padding:6px 8px}'
    + '.jp-note textarea{width:100%;box-sizing:border-box;border:1px solid var(--ed-line);border-radius:5px;font-size:11.5px;padding:5px 6px;min-height:40px;background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-note .jp-note-ops{display:flex;gap:4px;margin-top:4px;align-items:center;flex-wrap:wrap}'
    + '.jp-note .jp-note-ops button{min-height:22px;padding:0 8px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-note .jp-note-ops button.jp-pri{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.jp-note .jp-note-hint{font-size:10.5px;color:var(--ed-mut)}'
    + '.jp-gate{margin-top:6px;border:1px solid var(--ed-warn);border-radius:6px;padding:6px 8px;background:var(--ed-warn-soft)}'
    // S4a-T9：筛选 / footbar / 拒绝 chips / ≥1440 并排对照
    + '.jp-filter{display:flex;gap:2px}'
    + '.jp-filter button{min-height:22px;padding:0 8px;border:none;background:transparent;font-size:11px;font-weight:600;color:var(--ed-mut);cursor:pointer;border-radius:6px}'
    + '.jp-filter button.on{color:var(--ed-accent);background:var(--ed-accent-soft)}'
    + '.jp-foot{display:flex;gap:4px;align-items:center;flex-wrap:wrap;padding-top:6px;border-top:1px solid var(--ed-line)}'
    + '.jp-foot .jp-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.jp-foot button{min-height:26px;padding:0 10px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}'
    + '.jp-chips button{min-height:22px;padding:0 8px;border-radius:999px;font-size:11px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-chips button.jp-pri{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.jp-active{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '@media (min-width:1440px){.jp-cmp{display:grid;grid-template-columns:1fr 1fr;gap:6px}}'
    + '.jp button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}';
  document.head.appendChild(css);

  var root = document.createElement('div');
  root.id = 'jp-root';
  root.className = 'jp';
  pane.appendChild(root);

  var job = null, doc = null, busy = false;
  var docRev = 0;   // S4a-T8：GET /job/changes 暴露的 meta.rev——JSON 保存协议 baseRev 基线
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
      return { ok: true, meta: { target: 'add', title: c.section }, node: node };
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

  // ===== 接受/撤回经 v1.6 JSON 保存协议与正文同事务（S4a-T8）：op 随保存提交，UI 无独立状态请求 =====
  function normWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function randZid() {
    var hex = '0123456789abcdef', s = '';
    for (var i = 0; i < 8; i++) s += hex.charAt(Math.floor(Math.random() * 16));
    return 'z' + s;
  }
  function anchorElOf(c) {
    // add 的撤回锚点是已落账的 newZid（新段落本体）；其余用落点 zid（与服务端 applyOps 同逻辑）
    var zid = (c.kind === 'add' && c.newZid) ? c.newZid : c.zid;
    return zid ? sheet.querySelector('[data-zid="' + zid + '"]') : null;
  }
  // 与旧保存路径（template doSave）同口径的整页序列化：clone + 注入块清理；服务端 stripInjections 再兜底剥离
  function buildPageHtml() {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('.page-line, .toast, .recovery-bar, [data-ai-panel], [data-ed-shell], [data-ed-inj], [data-job-panel]').forEach(function (el) { el.remove(); });
    var cbody = clone.querySelector('body');
    if (cbody) { cbody.classList.remove('ed-on', 'ed-preview'); cbody.style.cssText = ''; }
    var csheet = clone.querySelector('.sheet');
    if (csheet) { csheet.style.zoom = ''; csheet.style.transform = ''; csheet.setAttribute('contenteditable', 'true'); }
    var cstate = clone.querySelector('#saveState');
    if (cstate) { cstate.dataset.state = 'saved'; cstate.textContent = '已保存 ✓'; }
    var csave = clone.querySelector('#saveBtn');
    if (csave) csave.removeAttribute('disabled');
    return '<!doctype html>\n' + clone.outerHTML;
  }
  function postSaveOps(ops, label) {
    api('/save?id=' + DOC_ID, {
      requestId: 'op-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10),
      baseRev: docRev, html: buildPageHtml(), ops: ops
    }).then(function (d) {
      if (d.ok) {
        if (d.receipt && d.receipt.mtime) window.__edDocMtime = d.receipt.mtime;   // 同步旧路径冲突基线
      } else {
        note('⚠️ ' + (d.error || (label + '失败')));
      }
      refresh();   // 成败都按服务器最新状态重渲染（409/400 的 DOM 差异由后续保存收敛）
    }).catch(function (e) { note('⚠️ ' + (e.message || e)); refresh(); });
  }
  function accept(c, viaGate) {
    if (busy) return; busy = true;
    var hits = c.consistency || [];
    if (hits.indexOf('anchor-gone') >= 0) { busy = false; note('⚠️ 目标已删除，不可接受'); return; }
    if (hits.indexOf('locked-now') >= 0) { busy = false; note('⚠️ 该段已锁定，不可接受'); return; }
    // needs-compare 确认门（设计 §4.2 决策 4）：先展示当前正文 vs 候选差异，确认后才应用
    if (hits.indexOf('needs-compare') >= 0 && !viaGate) { busy = false; renderGate(c); return; }
    if (window.__edPushUndo) window.__edPushUndo('接受修改：' + (c.note || c.kind));
    var anchorEl = anchorElOf(c);
    var origText = anchorEl ? normWs(anchorEl.textContent) : (c.before || '');
    var op = { operationId: 'op-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10), changeId: c.id, action: 'accept', origText: origText };
    var r;
    if (c.kind === 'replace' && viaGate) {
      // 确认门通过：整段替换为候选 after（锚点=当前整段文本，与服务端 origText 校验一致）
      r = replaceText(anchorEl.textContent, c.after) ? { ok: true, meta: {} } : { ok: false, error: '原文未找到（内容可能已被手工修改）' };
    } else {
      r = applyChange(c);
    }
    if (r.ok && c.kind === 'add' && r.node) {
      var nz = randZid();                 // 客户端生成新段落 zid（applyOps 校验形状；服务端落账 newZid 永久对应）
      r.node.setAttribute('data-zid', nz);
      op.newZid = nz;
    }
    busy = false;
    if (!r.ok) { note('⚠️ ' + r.error); return; }
    postSaveOps([op], '接受');
  }
  function revert(c) {
    if (busy) return; busy = true;
    // 撤回前置（设计 §4.2）：该段已被手改 → 提示原因并要求确认，拒绝静默执行
    var preEl = anchorElOf(c);
    if (preEl && typeof c.appliedText === 'string' && normWs(preEl.textContent) !== normWs(c.appliedText)) {
      busy = false;
      if (!window.confirm('该段已被修改，撤回会覆盖你的调整——确认撤回？')) { note('已取消撤回'); return; }
      busy = true;
    }
    if (window.__edPushUndo) window.__edPushUndo('撤销修改：' + (c.note || c.kind));
    var anchorEl = anchorElOf(c);
    var op = { operationId: 'op-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10), changeId: c.id, action: 'revert', origText: anchorEl ? normWs(anchorEl.textContent) : '' };
    var r = revertChange(c);
    if (!r.ok && c.kind === 'replace' && c.origText && anchorEl) {
      r = replaceText(anchorEl.textContent, c.origText) ? { ok: true } : r;   // 确认门整段接受过的：整段恢复接受时快照
    }
    busy = false;
    if (!r.ok) { note('⚠️ ' + r.error); return; }
    postSaveOps([op], '撤回');
  }
  function batchAccept(ids) {
    if (busy) return; busy = true;
    if (window.__edPushUndo) window.__edPushUndo('批量接受 ' + ids.length + ' 条');
    var ops = [], fails = 0, failedUpdates = [];
    ids.forEach(function (id) {
      var c = job.changes.find(function (x) { return x.id === id; });
      if (!c) return;
      var anchorEl = anchorElOf(c);
      var origText = anchorEl ? normWs(anchorEl.textContent) : (c.before || '');
      var r = applyChange(c);
      if (r.ok) {
        var op = { operationId: 'op-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10) + '-' + c.id, changeId: c.id, action: 'accept', origText: origText };
        if (c.kind === 'add' && r.node) {
          var nz = randZid();
          r.node.setAttribute('data-zid', nz);
          op.newZid = nz;
        }
        ops.push(op);
      } else {
        fails++;
        failedUpdates.push({ id: c.id, status: 'pending', note: r.error });
      }
    });
    busy = false;
    if (fails) note('⚠️ ' + fails + ' 条未能应用（原文可能已变化），其余已接受');
    if (failedUpdates.length) setStatus(failedUpdates);
    if (ops.length) postSaveOps(ops, '批量接受'); else render();
  }

  // ===== 渲染 =====
  var STATUS_LABEL = { pending: '待处理', accepted: '已接受', rejected: '已跳过', reverted: '已撤销', resolved: '已处理', superseded: '旧候选', skipped: '稍后处理' };
  var CONS_LABEL = { 'anchor-gone': '目标已删除', 'batch-stale': '证据已更新，需重新核对', 'ref-stale': '来源已变化，需重新核对', 'locked-now': '该段已锁定', 'needs-compare': '待比较（正文已变化）', 'hand-edited': '已按你的修改调整' };
  function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
  // needs-compare 确认门：当前正文 vs 候选差异（设计 §4.2 决策 4，不静默覆盖正文）
  function renderGate(c) {
    var div = root.querySelector('[data-change="' + c.id + '"]');
    if (!div) return;
    var old = div.querySelector('.jp-gate');
    if (old) old.remove();
    var anchorEl = anchorElOf(c);
    var gate = document.createElement('div');
    gate.className = 'jp-gate';
    var before = document.createElement('div');
    before.className = 'jp-before';
    before.textContent = '当前正文：' + short(anchorEl ? normWs(anchorEl.textContent) : '', 120);
    var after = document.createElement('div');
    after.className = 'jp-after';
    after.textContent = '候选改为：' + short(c.kind === 'replace' ? c.after : (c.kind === 'hide' ? '隐藏「' + (c.entry || c.section) + '」' : (c.kind === 'reorder' ? '排序 → ' + (c.to || '顶部') : c.after)), 120);
    var ops2 = document.createElement('div');
    ops2.className = 'jp-ops';
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'jp-accept';
    ok.textContent = '确认接受（覆盖当前正文）';
    ok.addEventListener('click', function () { gate.remove(); accept(c, true); });
    var no = document.createElement('button');
    no.type = 'button';
    no.textContent = '取消';
    no.addEventListener('click', function () { gate.remove(); });
    ops2.appendChild(ok);
    ops2.appendChild(no);
    gate.appendChild(before);
    gate.appendChild(after);
    gate.appendChild(ops2);
    div.appendChild(gate);
  }
  // ===== S4a-T9：审阅操作升级 =====
  // 拒绝原因 chips（决策 5）：不必填；进 job.feedback（下次生成 prompt），显式「记住偏好」存 localStorage
  function renderRejectChips(c, div) {
    var old = div.querySelector('.jp-chips');
    if (old) { old.remove(); return; }
    var chips = document.createElement('div');
    chips.className = 'jp-chips';
    var pick = function (reason) {
      var updates = [{ id: c.id, status: 'rejected', note: reason }];
      api('/job/changes?id=' + DOC_ID, { updates: updates, feedback: reason }).then(function (d) {
        if (d.ok) job = d.job; else note('⚠️ ' + (d.error || '状态保存失败'));
        render();
      });
      chips.remove();
    };
    ['改变原意', '太空泛', '过度夸大', '不符合我的表达'].forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = r;
      b.addEventListener('click', function () { pick(r); });
      chips.appendChild(b);
    });
    var custom = document.createElement('input');
    custom.type = 'text';
    custom.placeholder = '自定义原因…';
    custom.setAttribute('aria-label', '自定义拒绝原因');
    custom.style.cssText = 'min-height:22px;padding:0 6px;border-radius:6px;font-size:11px;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink);width:110px';
    chips.appendChild(custom);
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'jp-pri';
    go.textContent = '跳过';
    go.addEventListener('click', function () { var v = custom.value.trim(); if (v) pick(v); });
    chips.appendChild(go);
    var remember = document.createElement('button');
    remember.type = 'button';
    remember.textContent = '记住这个偏好';
    remember.title = '存入本机 localStorage，随生成请求提交为长期反馈';
    remember.addEventListener('click', function () {
      try {
        var prefs = JSON.parse(localStorage.getItem('s4a-feedback-prefs') || '[]');
        var v = custom.value.trim();
        if (!v) { note('⚠️ 先填写自定义原因再记住偏好'); return; }
        prefs.push(v);
        localStorage.setItem('s4a-feedback-prefs', JSON.stringify(prefs.slice(-20)));
        note('✅ 偏好已存本机（生成时随请求提交）');
      } catch (e) {}
    });
    chips.appendChild(remember);
    div.appendChild(chips);
    custom.focus();
  }
  // 「保留当前版本」：resolvedText=当前段落文本 + resolvedRefs=依赖 ref 指纹快照 → 退出待核对；再变重新核对
  function keepCurrent(c) {
    var anchorEl = anchorElOf(c);
    var text = anchorEl ? normWs(anchorEl.textContent) : '';
    var refs = {};
    (c.evidenceRefs || []).forEach(function (rid) {
      (job.evidence || []).forEach(function (e) { (e.refs || []).forEach(function (r) { if (r.refId === rid) refs[rid] = r.hash; }); });
    });
    setStatus([], { resolve: { changeId: c.id, text: text, refs: refs } });
    note('✅ 已保留当前版本（再变化会重新进入待核对）');
  }
  // 主操作流转（决策 5）：浏览→「下一条」；候选待定→「接受」；全部处理→「去导出检查」；至多一个橙色
  function pendingList() {
    return (job.changes || []).filter(function (c) { return c.status === 'pending'; });
  }
  function activeIdx(list) {
    var el = root.querySelector('.jp-item.jp-active');
    if (!el) return -1;
    var id = el.getAttribute('data-change');
    return list.findIndex(function (c) { return c.id === id; });
  }
  function gotoItem(c) {
    var el = root.querySelector('[data-change="' + c.id + '"]');
    if (!el) return;
    var prev = root.querySelector('.jp-item.jp-active');
    if (prev) prev.classList.remove('jp-active');
    el.classList.add('jp-active');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function stepItem(dir) {
    var list = pendingList();
    if (!list.length) return;
    var i = activeIdx(list);
    var next = list[(i + dir + list.length) % list.length];
    gotoItem(next);
  }

  function itemHtml(c, group) {
    var div = document.createElement('div');
    div.className = 'jp-item';
    div.setAttribute('data-change', c.id);
    var title = document.createElement('div');
    title.innerHTML = '<b>' + esc(short(c.section || '文档', 12)) + (c.entry ? ' / ' + esc(short(c.entry, 14)) : '') + '</b>'
      + '<span class="jp-st ' + (c.level === 'conflict' ? 'conflict' : c.status) + '">' + (STATUS_LABEL[c.status] || c.status) + '</span>';
    div.appendChild(title);
    if (Array.isArray(c.consistency) && c.consistency.length) {
      var cons = document.createElement('div');
      cons.className = 'jp-reason';
      cons.textContent = '⚠ ' + c.consistency.map(function (h) { return CONS_LABEL[h] || h; }).join('；');
      div.appendChild(cons);
    }
    if (c.reason) { var why = document.createElement('div'); why.className = 'jp-reason'; why.textContent = '理由：' + c.reason + (c.source ? '（来源：' + c.source + '）' : ''); div.appendChild(why); }
    if (c.kind === 'replace') {
      var cmp = document.createElement('div'); cmp.className = 'jp-cmp';   // S4a-T9：默认上下对照，≥1440 并排
      var b = document.createElement('div'); b.className = 'jp-before'; b.textContent = c.before; cmp.appendChild(b);
      var a = document.createElement('div'); a.className = 'jp-after'; a.textContent = c.after; cmp.appendChild(a);
      div.appendChild(cmp);
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
    var blocked = (c.consistency || []).indexOf('anchor-gone') >= 0 || (c.consistency || []).indexOf('locked-now') >= 0;
    if ((c.status === 'pending' || c.status === 'superseded') && !blocked) {
      mkBtn(c.level === 'conflict' ? '确认接受（无冲突）' : '接受', 'jp-accept', function () { accept(c); });
      mkBtn('跳过…', '', function () { renderRejectChips(c, div); });   // S4a-T9：拒绝原因 chips
      mkBtn('稍后处理', '', function () { setStatus([{ id: c.id, status: 'skipped' }]); });
      mkBtn('定位', '', locate);
    } else if (c.status === 'accepted') {
      if (!blocked) mkBtn('撤回这条建议', '', function () { revert(c); });   // 三层撤销之二（S2 整体回退 / 快照=查看历史版本）
      mkBtn('定位', '', locate);
    } else if (c.status === 'rejected' || c.status === 'reverted') {
      if (!blocked) mkBtn('重新接受', '', function () { setStatus([{ id: c.id, status: 'pending' }]); });
      mkBtn('定位', '', locate);
    } else if (c.status === 'skipped') {
      mkBtn('恢复处理', '', function () { setStatus([{ id: c.id, status: 'pending' }]); });   // skipped ⇄ pending
      mkBtn('定位', '', locate);
    }
    // 待核对（consistency 命中且非历史态）→ 「保留当前版本」退出待核对（设计 §4.2 v1.4）
    if (!blocked && ['pending', 'accepted'].indexOf(c.status) >= 0 && (c.consistency || []).length) {
      mkBtn('保留当前版本', '', function () { keepCurrent(c); });
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
      job = d.job; doc = d.doc; docRev = d.rev || 0;
      render();
    }).catch(function () {}).then(function () {
      // 自续判定放 catch 之后的语义位：running 期间瞬时 GET 失败也续排（S4a-T7 转交 b），不断链卡死 UI
      var gt = (job && job.genTasks) || {};
      if ((gt.evidence && gt.evidence.status === 'running') || (gt.changes && gt.changes.status === 'running')) schedulePoll();
    });
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

  // ===== 段一「要求与证据」完整 UI（S4a-T7，照原型 02b：五态徽章/事实依据可读化/zid 定位/note 两级流程）=====
  var EV_STATUS = { covered: '简历已覆盖', sourced: '素材有据·简历未表达', thin: '表达不充分', todo: '待补充', none: '未找到证据' };
  var FACT_LABELS = { company: '公司', role: '职位', dates: '时间', education: '学历', metrics: '指标', contribution: '贡献', conditions: '条件' };
  var GT_LABEL = { idle: '未生成', running: '正在分析证据…', done: '已生成', error: '失败', cancelled: '已取消' };
  // 徽章口径（设计 §4.3）：失效条目盖过一切显示「待重新关联」；noteConfirmed 归 sourced 同层但绝不变「简历已覆盖」
  function evBadge(e) {
    if (e.stale) return '<span class="jp-st conflict">来源已变化，待重新关联</span>';
    if (e.noteConfirmed && e.status !== 'covered') return '<span class="jp-st sourced">有据（依据：你的补充）·简历未表达</span>';
    return '<span class="jp-st ' + (e.status || 'todo') + '">' + (EV_STATUS[e.status] || e.status || '待补充') + '</span>';
  }
  // mat ref 可读化：按 ID 取真实素材标题+事实字段原文（页面文案「事实依据」，不暴露内部字段名）
  function matRefText(r) {
    var m = (window.__MATS__ || []).find(function (x) { return x.id === r.id; });
    var facts = (m && m.facts) || {};
    var parts = [];
    Object.keys(FACT_LABELS).forEach(function (k) { if (facts[k]) parts.push(FACT_LABELS[k] + '：' + short(facts[k], 60)); });
    return { title: (m && m.title) || r.title || r.id || '', facts: parts.join(' · ') };
  }
  // zid 定位：滚动至段落 + Custom Highlight 闪烁（与 zone-panel 同机制，瞬态不落盘、不给正文挂 class）
  function locateZid(zid) {
    var el = sheet.querySelector('[data-zid="' + zid + '"]');
    if (!el) { note('⚠️ 未找到定位目标（内容可能已变化）'); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (window.CSS && CSS.highlights) {
      var r = document.createRange();
      r.selectNodeContents(el);
      CSS.highlights.set('jp-flash', new Highlight(r));
      setTimeout(function () { CSS.highlights.delete('jp-flash'); }, 900);
    }
  }
  // note 两级流程（S4a-T7 转交端点分支）：note 随时可存；「确认为证据」显式动作计 sourced 层，可退回
  function saveEvidenceNote(reqId, noteText, confirmed) {
    var body = { evidenceNote: { reqId: reqId } };
    if (noteText !== null) body.evidenceNote.note = noteText;
    if (confirmed !== null) body.evidenceNote.confirmed = confirmed;
    api('/job/changes?id=' + DOC_ID, body).then(function (d) {
      if (!d.ok) { note('⚠️ ' + (d.error || '说明保存失败')); return; }
      job = d.job;
      render();
      note(confirmed === true ? '✅ 已确认为证据（计「素材有据·简历未表达」）' : (confirmed === false ? '已退回确认' : '✅ 说明已保存'));
    }).catch(function (e2) { note('⚠️ ' + (e2.message || e2)); });
  }
  function noteBox(e) {
    var box = document.createElement('div');
    box.className = 'jp-note';
    var lbl = document.createElement('div');
    lbl.className = 'jp-meta';
    lbl.textContent = e.noteConfirmed ? '已确认为证据（你的补充说明）' : '补充事实说明（可选）';
    box.appendChild(lbl);
    var ta = document.createElement('textarea');
    ta.value = e.note || '';
    ta.setAttribute('aria-label', '证据补充说明');
    box.appendChild(ta);
    var ops = document.createElement('div');
    ops.className = 'jp-note-ops';
    var save = document.createElement('button');
    save.type = 'button';
    save.textContent = '保存说明';
    save.addEventListener('click', function () { saveEvidenceNote(e.id, ta.value, null); });
    ops.appendChild(save);
    if (e.noteConfirmed) {
      var back = document.createElement('button');
      back.type = 'button';
      back.textContent = '退回确认';
      back.addEventListener('click', function () { saveEvidenceNote(e.id, null, false); });
      ops.appendChild(back);
    } else {
      var conf = document.createElement('button');
      conf.type = 'button';
      conf.className = 'jp-pri';
      conf.textContent = '确认为证据';
      var sync = function () { conf.disabled = !ta.value.trim(); };
      ta.addEventListener('input', sync);
      sync();
      conf.addEventListener('click', function () { saveEvidenceNote(e.id, ta.value, true); });
      ops.appendChild(conf);
    }
    var hint = document.createElement('span');
    hint.className = 'jp-note-hint';
    hint.textContent = e.noteConfirmed ? '可随时退回；正文实际引用后才计「简历已覆盖」。' : '确认为证据 = 计「素材有据·简历未表达」，需正文实际引用后才升「简历已覆盖」。';
    ops.appendChild(hint);
    box.appendChild(ops);
    return box;
  }
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
    // 三列分计（设计 §4.3）：简历已覆盖 N（正文）· 素材有据未表达 M · 待补充 K；失效条目计入待补充
    var nCov = 0, nSrc = 0, nTodo = 0;
    list.forEach(function (e) {
      if (e.stale) { nTodo++; return; }
      if (e.status === 'covered') { nCov++; return; }
      if (e.status === 'sourced' || e.noteConfirmed) nSrc++; else nTodo++;
    });
    var stats = document.createElement('div');
    stats.className = 'jp-sum';
    [['简历已覆盖 ' + nCov + '（正文）', nCov, 'badge ok'], ['素材有据未表达 ' + nSrc, nSrc, 'badge warn'], ['待补充 ' + nTodo, nTodo, 'badge']]
      .forEach(function (x) {
        if (!x[1]) return;
        var b = document.createElement('span');
        b.className = x[2];
        b.textContent = x[0];
        stats.appendChild(b);
      });
    if (stats.childNodes.length) root.appendChild(stats);
    list.forEach(function (e) {
      var div = document.createElement('div');
      div.className = 'jp-item';
      div.setAttribute('data-ev', e.id || '');
      var title2 = document.createElement('div');
      title2.innerHTML = '<b>' + esc(short(e.req || '（无要求描述）', 40)) + '</b>' + evBadge(e);
      div.appendChild(title2);
      var refs = e.refs || [];
      refs.forEach(function (r) {
        var line = document.createElement('div');
        line.className = 'jp-ref';
        if (r.type === 'mat') {
          var mf = matRefText(r);
          line.innerHTML = '· 素材：<b>' + esc(mf.title) + '</b><span class="jp-fact">事实依据</span>'
            + (mf.facts ? '<span>' + esc(mf.facts) + '</span>' : (r.quote ? '<span>「' + esc(short(r.quote, 40)) + '」</span>' : ''));
        } else {
          line.innerHTML = '· 正文段落' + (r.title ? ' <b>' + esc(short(r.title, 16)) + '</b>' : '') + (r.quote ? '「' + esc(short(r.quote, 40)) + '」' : '');
          var loc = document.createElement('button');
          loc.type = 'button';
          loc.className = 'jp-refbtn';
          loc.textContent = '📍定位';
          loc.addEventListener('click', function () { locateZid(r.zid); });
          line.appendChild(loc);
        }
        if (r.fresh === false) {
          var st = document.createElement('span');
          st.className = 'jp-st conflict';
          st.textContent = '来源已变化';
          line.appendChild(st);
        }
        div.appendChild(line);
      });
      if (!refs.length) {
        var none = document.createElement('div');
        none.className = 'jp-reason';
        none.textContent = e.status === 'none' ? '当前已确认来源中未找到证据——不代表你没有做过，可补充事实说明。' : '暂无有效引用。';
        div.appendChild(none);
      }
      // note 补充区：留缺口/已有说明的条目显示（覆盖与有据条目不需要）
      if (e.status === 'none' || e.status === 'todo' || e.note || e.noteConfirmed) div.appendChild(noteBox(e));
      root.appendChild(div);
    });
    var hint = document.createElement('div');
    hint.className = 'jp-meta';
    hint.textContent = 'JD 的每条要求来自 JD 本身（非你的经历事实）；事实只来自已确认素材与正文。';
    root.appendChild(hint);
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
    gen.className = '';   // S4a-T9：唯一橙色主操作在底部 footbar（决策 5）
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
    // 筛选（reviewPos.filter 持久化）：全部 / 仅重点 / 仅本次变化
    var flt = document.createElement('div');
    flt.className = 'jp-filter';
    [['all', '全部'], ['important', '仅重点'], ['new', '仅本次变化']].forEach(function (x) {
      var fb = document.createElement('button');
      fb.type = 'button';
      fb.textContent = x[1];
      if (posFilter === x[0]) fb.className = 'on';
      fb.addEventListener('click', function () { posFilter = x[0]; savePos(); render(); });
      flt.appendChild(fb);
    });
    head.appendChild(flt);
    // 过滤应用（历史组不受筛）
    var maxGen = changes.reduce(function (m, c) { return Math.max(m, c.gen || 0); }, 0);
    var byFilter = function (list) {
      if (posFilter === 'important') return list.filter(function (c) { return c.level === 'important' || c.level === 'conflict'; });
      if (posFilter === 'new') return list.filter(function (c) { return (c.gen || 0) === maxGen; });
      return list;
    };
    var pending = changes.filter(function (c) { return c.status === 'pending'; });
    var needsCompare = byFilter(changes.filter(function (c) { return c.status === 'pending' && (c.consistency || []).indexOf('needs-compare') >= 0; }));
    var normal = byFilter(changes.filter(function (c) { return c.status !== 'superseded' && c.level !== 'conflict' && c.level !== 'important' && ['replace', 'add'].indexOf(c.kind) >= 0 && c.status !== 'accepted' && c.status !== 'reverted' && c.status !== 'rejected' && c.status !== 'skipped' && (c.consistency || []).indexOf('needs-compare') < 0; }));
    var reorder = byFilter(changes.filter(function (c) { return c.level !== 'conflict' && c.level !== 'important' && c.kind === 'reorder' && c.status !== 'superseded' && c.status !== 'accepted' && c.status !== 'reverted' && c.status !== 'rejected' && c.status !== 'skipped'; }));
    var hides = byFilter(changes.filter(function (c) { return c.kind === 'hide' && c.status !== 'superseded' && c.status !== 'skipped'; }));
    var important = byFilter(changes.filter(function (c) { return c.level === 'important' && c.status !== 'superseded' && c.status !== 'skipped'; }));
    var conflicts = byFilter(changes.filter(function (c) { return c.level === 'conflict' && c.status !== 'superseded' && c.status !== 'skipped'; }));
    var deferred = byFilter(changes.filter(function (c) { return c.status === 'skipped'; }));   // 稍后处理（v1.5：pending⇄skipped）
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
    [groupBox('稍后处理', deferred),
     groupBox('待比较（正文已变化，需确认）', needsCompare),
     groupBox('普通表达', normal, { batch: normal }),
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
    help.textContent = '提示：接受会修改正文（「↩ 撤销」整体回退 / 「撤回这条建议」单条撤回 / 快照面板=查看历史版本）；j/k 上下条。';
    root.appendChild(help);

    // 主操作随阶段流转：候选待定→「接受」；全部处理但有待核对→「去核对」；全部完成→「去导出检查」（至多一个橙色）
    var pend = pendingList();
    var toVerifyN = changes.filter(function (c) { return ['pending', 'accepted'].indexOf(c.status) >= 0 && (c.consistency || []).length; }).length;
    var foot = document.createElement('div');
    foot.className = 'jp-foot';
    var mkFoot = function (label, cls, fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      b.addEventListener('click', fn);
      foot.appendChild(b);
      return b;
    };
    mkFoot('‹ 上一条', '', function () { stepItem(-1); });
    if (pend.length) {
      mkFoot('接受', 'jp-primary', function () {
        var i = activeIdx(pend);
        accept(pend[i >= 0 ? i : 0]);
      });
    } else if (toVerifyN) {
      mkFoot('去核对（' + toVerifyN + '）', 'jp-primary', function () {
        var v = changes.find(function (c) { return ['pending', 'accepted'].indexOf(c.status) >= 0 && (c.consistency || []).length; });
        if (v) gotoItem(v);
      });
    } else {
      mkFoot('去导出检查 →', 'jp-primary', function () { setSec('export'); });
    }
    mkFoot('下一条 ›', '', function () { stepItem(1); });
    var hint = document.createElement('span');
    hint.className = 'jp-meta';
    hint.textContent = '筛选：' + ({ all: '全部', important: '仅重点', new: '仅本次变化' }[posFilter] || posFilter) + ' · j/k 上下条 · 位置自动恢复';
    foot.appendChild(hint);
    root.appendChild(foot);
  }

  // j/k 上下条（审阅段激活时；输入控件内不抢键）
  window.addEventListener('keydown', function (e) {
    if (curSec !== 'changes' || !job) return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true)) return;
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); stepItem(1); }
    else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); stepItem(-1); }
  });

  // 初始进入：读 reviewPos 恢复段与筛选（刷新后位置恢复）
  api('/job/changes?id=' + DOC_ID).then(function (d) {
    if (!d.ok) return;
    job = d.job; doc = d.doc; docRev = d.rev || 0;
    applyReviewPos();
    render();
    var gt = job.genTasks || {};
    if ((gt.evidence && gt.evidence.status === 'running') || (gt.changes && gt.changes.status === 'running')) schedulePoll();
  }).catch(function () {});

  // 外壳 Tab 切换到「审阅」时刷新（反映最新落盘状态；不重置当前段）
  window.addEventListener('ed-review-refresh', function () { refresh(); });
})();
