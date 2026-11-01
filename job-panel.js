// job-panel.js — 岗位草稿审阅面板（修改清单 / 待补充 / 冲突门控）
// 由 server /edit 对岗位草稿幂等注入（JOB-INJECT 注释对），/save 时剥离，文档零污染。
// 职责：展示生成建议 → 逐条/批量接受 → 应用到正文（可撤销）→ 状态回写服务端（刷新后保留）。
(function () {
  var DOC_ID = document.currentScript.getAttribute('data-doc');
  var pane = document.getElementById('ed-pane-review');
  if (!pane) return;
  var sheet = document.querySelector('.sheet');
  if (!sheet) return;
// 图标：服务端把 SVG 随页面下发（vendors/icons.mjs 是唯一来源，客户端不自己拼 SVG）；
// 没有注入时降级为空串 —— 不炸，也不显示图标。
var __icon = window.__icon || function () { return ''; };
var __status = window.__status || function (el, kind, text) { if (el) el.textContent = text; };

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
    + '.jp-st{font-size:11px;border-radius:999px;padding:1px 7px;background:var(--ed-bg);color:var(--ed-mut);margin-left:6px}'
    + '.jp-st.accepted{background:var(--ed-ok-soft);color:var(--ed-ok)}'
    + '.jp-st.rejected{background:var(--ed-bg);color:var(--ed-mut)}'
    + '.jp-st.conflict{background:var(--ed-err-soft);color:var(--ed-err)}'
    + '.jp-todo{border-left:3px solid var(--ed-warn);background:var(--ed-warn-soft);border-radius:6px;padding:6px 8px;margin:4px 0}'
    + '.jp-empty{color:var(--ed-mut);text-align:center;padding:16px 8px}'
    + '.jp-msg{font-size:11px;color:var(--ed-mut)}'
    + '.jp-msg.is-warn{color:var(--ed-warn)}'
    + '.jp-msg.is-ok{color:var(--ed-ok)}'
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
    + '.jp-ref .jp-fact{background:var(--ed-ok-soft);color:var(--ed-ok);font-size:11px;border-radius:4px;padding:0 6px;flex:none}'
    + '.jp-ref .jp-refbtn{min-height:24px;padding:0 6px;border-radius:5px;font-size:11px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink);flex:none}'
    + '.jp-note{margin-top:6px;border:1px dashed var(--ed-line);border-radius:6px;padding:6px 8px}'
    + '.jp-note textarea{width:100%;box-sizing:border-box;border:1px solid var(--ed-line);border-radius:5px;font-size:12px;padding:5px 6px;min-height:40px;background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-item li .jp-refbtn{margin-left:6px;vertical-align:baseline}'
    + '.jp-note .jp-note-ops{display:flex;gap:4px;margin-top:4px;align-items:center;flex-wrap:wrap}'
    + '.jp-note .jp-note-ops button{min-height:22px;padding:0 8px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.jp-note .jp-note-ops button.jp-pri{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.jp-note .jp-note-hint{font-size:11px;color:var(--ed-mut)}'
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
  root.textContent = '加载中…';   // S4a-T11：加载态（首屏数据到达后由 render 覆盖；失败提示重试入口）
  pane.appendChild(root);

  var job = null, doc = null, busy = false;
  var docRev = 0;   // S4a-T8：GET /job/changes 暴露的 meta.rev——JSON 保存协议 baseRev 基线
  // S4a-T6 三段骨架状态：当前段（evidence|changes|export）+ reviewPos 筛选位（T9 落 UI）+ 任务轮询链
  var curSec = null, posFilter = 'all', pollTimer = null;
  var SEC_LABELS = { evidence: '要求与证据', changes: '修改清单', export: '导出检查' };

  // 统一请求出口：三态可辨（写路径据此区分「明确拒绝」与「结果未知」）
  //   · 业务/HTTP 失败 → {ok:false, error, _status}
  //   · 网络异常（fetch 抛错）→ {ok:false, error, _network:true}（不 reject：调用点不必各写一遍 catch）
  //   · 成功 → {ok:true, ...}
  function api(url, body) {
    return fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        if (!d || typeof d !== 'object') return { ok: false, error: 'HTTP ' + r.status, _status: r.status };
        d._status = r.status;
        return d;
      });
    }).catch(function (e) {
      return { ok: false, error: (e && e.message) || '网络异常', _network: true };
    });
  }
  // kind 省略 → 纯文本；给了（ok/warn/err）→ 状态图标 + 转义文本（替代原来的裸 emoji 前缀）
  // 提示必须跨 render 存活：render() 会重建 .jp-msg（root.innerHTML=''），
  // 原来「先 note() 再 render()」的写法会把刚写的提示立刻清空 —— 保存失败/生成成功
  // 全都 0 毫秒可见（2026-10-22 审查）。提示存一份，render() 后重贴。
  var lastNote = null;
  function applyNote() {
    var m = root.querySelector('.jp-msg');
    if (!m || !lastNote) return;
    m.className = 'jp-msg' + (lastNote.kind === 'warn' ? ' is-warn' : lastNote.kind === 'ok' ? ' is-ok' : '');
    if (lastNote.kind) __status(m, lastNote.kind, lastNote.msg);
    else m.textContent = lastNote.msg;
  }
  function note(msg, kind) { lastNote = { msg: String(msg), kind: kind || '' }; applyNote(); }

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
    // zid 优先（BL-P2-03，B 线批 3）：候选自带服务端解析好的精确锚点 → 直接定位其所属条目；
    // 标题双向子串匹配只作无 zid 的退化路径（同名/子标题场景模糊匹配会隐藏/移动错条目）
    var byZid = entryByZid(c && c.zid);
    if (byZid) return byZid;
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
  // zid → 所属条目对：zid 元素是条目头本身、或在条目头的祖先链/后继 UL 里。
  // 注意 pair 与 all 必须来自**同一次** entryPairs 调用（reorder 的 indexOf 依赖对象身份）
  function entryByZid(zid) {
    if (!zid) return null;
    var el = sheet.querySelector('[data-zid="' + zid + '"]');
    if (!el) return null;
    var head = null;
    if (el.classList.contains('entry-head')) head = el;
    else if (el.closest && el.closest('.entry-head')) head = el.closest('.entry-head');
    else {
      var up = el.parentElement;
      if (up && up.tagName === 'UL' && up.previousElementSibling && up.previousElementSibling.classList.contains('entry-head')) head = up.previousElementSibling;
    }
    if (!head || !head.closest) return null;
    var sec = head.closest('.section');
    if (!sec) return null;
    var pairs = entryPairs(sec);
    var pair = pairs.find(function (pp) { return pp.head === head; }) || null;
    return pair ? { sec: sec, pair: pair, all: pairs } : null;
  }
  function hidePair(pair, on) {
    pair.head.classList.toggle('ed-entry-hidden', on);
    if (pair.ul) pair.ul.classList.toggle('ed-entry-hidden', on);
  }

  // 正文替换：统一走外壳的 window.__edReplaceText（2026-10-24：两个面板原本各抄一份 → 改一处要改两处）
  // 正文里该原文出现几次：>1 就无法确定改哪一处 → 盲改会改错段落（2026-10-22 审查 [高] 实测：
  // 简历里两段相同文字 → 接受锚在第二段的那条建议 → 改的是第一段，锚点段原封不动，面板还显示「已接受」）
  function textMatchCount(before) {
    var t = sheet.textContent || '';
    var n = 0, i = t.indexOf(before);
    while (i >= 0) { n++; i = t.indexOf(before, i + (before.length || 1)); }
    return n;
  }
  // 程序化变更统一出口（S2-T5）：走外壳共享入口（合成 input 保持 dirty 语义 + 补 op 时间戳）；无外壳时退回裸派发
  function touch() {
    if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    else sheet.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function anchorElOf(c) {
    // add 的撤回锚点是已落账的 newZid（新段落本体）；其余用落点 zid（与服务端 applyOps 同逻辑）
    var zid = (c.kind === 'add' && c.newZid) ? c.newZid : c.zid;
    return zid ? sheet.querySelector('[data-zid="' + zid + '"]') : null;
  }
  function normWs(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function randZid() {
    var hex = '0123456789abcdef', s = '';
    for (var i = 0; i < 8; i++) s += hex.charAt(Math.floor(Math.random() * 16));
    return 'z' + s;
  }
  // 包含指定文本（调用方保证全文唯一）的最近段落/容器元素：
  // 无 zid 候选的正向替换与撤回快照都圈定在其内（BL-P2-01）
  function blockContaining(text) {
    if (!text) return null;
    var hit = null;
    sheet.querySelectorAll('p,li,h1,h2,h3,h4,td,th,.entry-head,.contact,.section').forEach(function (b) {
      if (!hit && b.textContent.indexOf(text) >= 0) hit = b;
    });
    return hit;
  }

  // ===== 应用/撤销一条修改 =====
  // 一次改动有两个方向：apply（正向）与 undo（严格反向）。方向写反的后果（2026-10-28 补丁轮实测）：
  //   撤回是 after→before，它的 undo 必须是 before→after；写反 → 失败回滚时把「撤回」又做了一遍
  //   → 页面停在原文、磁盘还是候选、状态仍 accepted。
  // 描述符：{kind:'replace'|'hide'|'remove'|'insert'|'move'|'reapply', ...}
  function runInv(d, c) {
    if (!d) return false;
    try {
      // 段落级快照恢复（BL-P2-01/P2-05，B 线批 3）：撤回 = 精确回到正向改动前的字节，
      // 不做任何文本匹配——首个匹配回退在同段 before/after 交叉时会把原文改乱，
      // 文本节点流替换会把行内标记掏成空壳。
      if (d.kind === 'html') {
        if (!d.el || !d.el.isConnected) return false;
        d.el.innerHTML = d.html;
        touch();
        return true;
      }
      if (d.kind === 'replace') return window.__edReplaceText(d.find, d.repl, d.opts || {}) !== false;
      if (d.kind === 'hide') {
        var found = findEntry(c), sec = sectionByTitle(c.section);
        if (d.unhide) {
          if (found) { hidePair(found.pair, false); touch(); return true; }
          if (sec) { sec.classList.remove('ed-sec-hidden'); touch(); return true; }
          return false;
        }
        if (found) { hidePair(found.pair, true); touch(); return true; }
        if (sec) { sec.classList.add('ed-sec-hidden'); touch(); return true; }
        return false;
      }
      if (d.kind === 'remove') { if (d.node && d.node.parentNode) { d.node.parentNode.removeChild(d.node); touch(); return true; } return false; }
      if (d.kind === 'insert') {
        if (!d.node || !d.parent) return false;
        var before = (d.before && d.before.parentNode === d.parent) ? d.before : null;
        d.parent.insertBefore(d.node, before); touch(); return true;
      }
      if (d.kind === 'move') {
        var h = d.host, ns = d.nodes || [];
        if (!h || !ns.length) return false;
        ns.forEach(function (nd) { if (nd.parentNode === h) h.removeChild(nd); });
        var ref = (d.ref && d.ref.parentNode === h) ? d.ref : null;
        ns.forEach(function (nd) { h.insertBefore(nd, ref); });
        touch(); return true;
      }
      if (d.kind === 'reapply') { var rr = applyChange(d.c); return !!(rr && rr.ok); }
      return false;
    } catch (e) { return false; }
  }
  function applyChange(c) {
    if (c.kind === 'replace') {
      // 有 zid 锚点（局部重生成回传）→ 只在锚点节点里找，绝不按全文首个匹配盲改；
      // 撤回 = 恢复锚点 innerHTML 快照（位置精确 + 行内标记保真）
      var anchor = c.zid ? anchorElOf(c) : null;
      if (anchor) {
        var snap = anchor.innerHTML;
        if (window.__edReplaceText(c.before, c.after, { root: anchor })) {
          return { ok: true, meta: {}, inv: { kind: 'html', el: anchor, html: snap } };
        }
        return { ok: false, error: '原文未找到（内容可能已被手工修改）' };
      }
      // 无锚点但原文多处出现 → 改哪一处说不清 → 拒绝，别赌第一处
      if (textMatchCount(c.before) > 1) {
        return { ok: false, error: '原文在正文里出现多处，无法确定改哪一处，已拒绝（请手动修改）' };
      }
      // 无 zid 且全文唯一 → 圈定包含它的段落元素：正向与撤回都只动这一段（BL-P2-01）
      var blk = blockContaining(c.before);
      if (blk) {
        var snap2 = blk.innerHTML;
        if (window.__edReplaceText(c.before, c.after, { root: blk })) {
          return { ok: true, meta: {}, inv: { kind: 'html', el: blk, html: snap2 } };
        }
      }
      if (window.__edReplaceText(c.before, c.after, { occurrence: c.meta && c.meta.occurrence, context: c.context })) {
        return { ok: true, meta: {}, inv: { kind: 'replace', find: c.after, repl: c.before, opts: { occurrence: c.meta && c.meta.occurrence, context: c.context } } };
      }
      return { ok: false, error: '原文未找到（内容可能已被手工修改）' };
    }
    if (c.kind === 'hide') {
      var found = findEntry(c);
      if (found) { hidePair(found.pair, true); touch(); return { ok: true, meta: { target: 'entry', title: found.pair.title }, inv: { kind: 'hide', unhide: true } }; }
      var sec = sectionByTitle(c.section);
      if (sec) { sec.classList.add('ed-sec-hidden'); touch(); return { ok: true, meta: { target: 'section', title: c.section }, inv: { kind: 'hide', unhide: true } }; }
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
      else if (c.entryTo) { anchorPair = pairs.find(function (p) { return p.title.indexOf(String(c.entryTo).trim()) >= 0; }); }
      if (!anchorPair || anchorPair === f2.pair) return { ok: false, error: '排序目标不存在或无需移动' };
      var before = anchorPair.head;
      var isDown = pairs.indexOf(anchorPair) > cur;
      var moveNodes = f2.pair.ul ? [f2.pair.head, f2.pair.ul] : [f2.pair.head];
      // 条目节点挂在所属章节下（非 .sheet 直接子节点）：insertBefore 的 ref 必须是同一 parent 的子节点，
      // 用 sheet 必抛 NotFoundError，且异常会穿透到 busy 复位之后把面板永久锁死
      var host = f2.pair.head.parentNode;
      // 还原锚点：移动前这组节点的后继（undo 时按它放回原位）
      var restoreAt = { host: host, next: moveNodes[moveNodes.length - 1].nextSibling, nodes: moveNodes.slice() };
      if (isDown) {
        var afterNodes = anchorPair.ul ? [anchorPair.head, anchorPair.ul] : [anchorPair.head];
        var ref = afterNodes[afterNodes.length - 1].nextElementSibling;
        moveNodes.forEach(function (nd) { host.insertBefore(nd, ref); });   // ref 为 null 时即追加到章节末尾
      } else {
        moveNodes.slice().reverse().forEach(function (nd) { host.insertBefore(nd, before); });
      }
      touch();
      return { ok: true, meta: { target: 'reorder', origIndex: cur, title: f2.pair.title }, inv: { kind: 'move', host: restoreAt.host, nodes: restoreAt.nodes, ref: restoreAt.next } };
    }
    if (c.kind === 'add') {
      var sec2 = sectionByTitle(c.section);
      if (!sec2) return { ok: false, error: '找不到目标章节' };
      var ul = sec2.querySelector('ul');
      var node = document.createElement(ul ? 'li' : 'p');
      node.textContent = c.after;
      (ul || sec2).appendChild(node);
      touch();
      return { ok: true, meta: { target: 'add', title: c.section }, node: node, inv: { kind: 'remove', node: node } };
    }
    return { ok: false, error: '未知修改类型：' + c.kind };
  }
  function revertChange(c) {
    if (c.kind === 'replace') {
      // 与 applyChange 同口径：锚点里确实有改后文本时只在锚点内换
      // （正文可能有多处相同文本 → 全局首个匹配会改错段）
      var anchor = c.zid ? anchorElOf(c) : null;
      if (anchor && anchor.textContent.indexOf(c.after) >= 0) {
        if (window.__edReplaceText(c.after, c.before, { root: anchor })) {
          // 撤回的 undo = 再做一次接受（before→after）：方向必须与 apply 相反
          return { ok: true, inv: { kind: 'replace', find: c.before, repl: c.after, opts: { root: anchor } } };
        }
        return { ok: false, error: '撤销失败：改后文本已变化' };
      }
      if (window.__edReplaceText(c.after, c.before, { context: c.context })) {
        return { ok: true, inv: { kind: 'replace', find: c.before, repl: c.after, opts: { context: c.context } } };
      }
      return { ok: false, error: '撤销失败：改后文本已变化' };
    }
    if (c.kind === 'hide') {
      var found = findEntry(c);
      if (found) { hidePair(found.pair, false); touch(); return { ok: true, inv: { kind: 'hide', unhide: false } }; }
      var sec = sectionByTitle(c.section);
      if (sec) { sec.classList.remove('ed-sec-hidden'); touch(); return { ok: true, inv: { kind: 'hide', unhide: false } }; }
      return { ok: false, error: '撤销失败：目标不存在' };
    }
    if (c.kind === 'reorder') {
      var f2 = findEntry(c);
      if (!f2 || !c.meta || typeof c.meta.origIndex !== 'number') return { ok: false, error: '撤销失败：找不到条目或原始位置' };
      var pairs = f2.all, cur = pairs.indexOf(f2.pair);
      var target = c.meta.origIndex;
      if (cur === target) return { ok: true, inv: { kind: 'reapply', c: c } };
      var refPair = pairs[target];
      var moveNodes = f2.pair.ul ? [f2.pair.head, f2.pair.ul] : [f2.pair.head];
      var refNode = refPair && refPair.head !== f2.pair.head ? refPair.head : null;
      // 同 applyChange 的 reorder 分支：条目在章节内，用 sheet 会抛异常或把条目搬出章节（静默结构损坏）
      var host2 = f2.pair.head.parentNode;
      if (target >= pairs.length) { moveNodes.forEach(function (nd) { host2.appendChild(nd); }); }
      else if (refNode) { moveNodes.slice().reverse().forEach(function (nd) { host2.insertBefore(nd, refNode); }); }
      touch();
      // 撤回的 undo = 再做一次排序（回到目标位）：用 reapply 复用 applyChange 的定位逻辑
      return { ok: true, inv: { kind: 'reapply', c: c } };
    }
    if (c.kind === 'add') {
      // 优先按已落账 newZid 精确定位（anchorElOf 同逻辑）：正文可能本就有相同段落，按文本反查会误删用户原文
      var zidEl = anchorElOf(c);
      if (zidEl) {
        var rmParent = zidEl.parentNode, rmNext = zidEl.nextSibling;
        zidEl.remove(); touch();
        return { ok: true, inv: { kind: 'insert', node: zidEl, parent: rmParent, before: rmNext } };
      }
      var hit = null;   // 兜底：无 zid（未落账的旧候选）才回退文本匹配
      sheet.querySelectorAll('li,p').forEach(function (el) { if (!hit && el.childNodes.length === 1 && el.textContent.trim() === c.after.trim()) hit = el; });
      if (hit) {
        var rmParent2 = hit.parentNode, rmNext2 = hit.nextSibling;
        hit.remove(); touch();
        return { ok: true, inv: { kind: 'insert', node: hit, parent: rmParent2, before: rmNext2 } };
      }
      return { ok: false, error: '撤销失败：找不到插入的内容' };
    }
    return { ok: false, error: '未知类型' };
  }

  function setStatus(updates, extra) {
    return api('/job/changes?id=' + DOC_ID, Object.assign({ updates: updates }, extra || {})).then(function (d) {
      if (d.ok) job = d.job; else note(d.error || '状态保存失败', 'warn');
      render();
      return d;
    });
  }

  function buildPageHtml() {
    // 共享序列化（ZONE-06）：与区域面板、模板 doSave 同口径 —— 不再各自复制一份
    if (typeof window.__edBuildSaveHtml === 'function') return window.__edBuildSaveHtml();
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('.page-line, .toast, .recovery-bar, [data-ai-panel], [data-ed-shell], [data-ed-inj], [data-job-panel]').forEach(function (el) { el.remove(); });
    var cbody = clone.querySelector('body');
    if (cbody) { cbody.classList.remove('ed-on', 'ed-preview'); cbody.style.cssText = ''; }
    var csheet = clone.querySelector('.sheet');
    if (csheet) { csheet.style.zoom = ''; csheet.style.transform = ''; csheet.setAttribute('contenteditable', 'true'); }
    var cstate = clone.querySelector('#saveState');
    // 与模板 doSave 同口径：写回**字面量**「已保存 ✓」，不是 SVG。
    // 两条保存路径（模板 doSave / 本函数 buildPageHtml）必须产出同一份字节，
    // 否则同一份文档两条路径存出不同 HTML → bodyHash/renderInputId 不同 → PDF 被误判「较旧」。
    // emoji 用 \u 转义写（UI-7 断言：前端源码零 emoji 字面量）；运行时由注入层的
    // MutationObserver 把 #saveState 的 emoji 换成 SVG（与 toast 同一套机制）→ 文件留字面量、UI 不见 emoji。
    // （✓ 写成转义：UI-7 断言要求前端源码零 emoji 字面量）
    if (cstate) { cstate.dataset.state = 'saved'; cstate.textContent = '已保存 \u2713'; }
    var csave = clone.querySelector('#saveBtn');
    if (csave) csave.removeAttribute('disabled');
    return '<!doctype html>\n' + clone.outerHTML;
  }

  // ===== 岗位操作的提交身份与结果三态（2026-10-28 可靠性收口）=====
  // 服务端一致性合同（server.mjs saveJsonProtocol）：
  //   · 同 requestId + 同请求体 → 只回执、零重写（deduped）
  //   · 同 requestId + 不同请求体 → 400（同 ID 必须重发完全相同的内容）
  //   · 新操作必须新身份：按操作内容派生永久 ID 会让「接受→撤回→再次接受」命中旧回执
  // 一次逻辑提交 = {requestId, body}：body 在提交瞬间冻结；重试原样重发（同一身份、同一请求体）。
  var pendingSubs = {};   // changeId → 结果未知的提交（供同身份重试）
  // 待核对标记：本次改动已落账，但目标在等待期间被用户改过 → 保留用户内容、不覆盖，面板明确标注。
  var verifyMarks = {};   // changeId → 原因
  function markVerify(id, reason) { verifyMarks[id] = reason; }

  function newOperationId() { return 'op-' + Date.now() + '-' + Math.random().toString(16).slice(2, 10); }

  // 内容指纹：只看正文（.sheet），不看瞬态元素（保存状态、面板）。
  // 否则「自动保存把 #saveState 从 dirty 变 saved」会被误判成「正文变了」→ 正常的重试会被错判成需核对。
  function contentFingerprint() {
    var el = document.querySelector('.sheet');
    return el ? el.innerHTML : '';
  }
  // 提交体冻结：html/ops/baseRev/baseMtime 在提交瞬间固定，之后重试原样重发。
  function freezeSubmit(ops, label) {
    return {
      requestId: 'sub-' + (ops[0] && ops[0].operationId ? ops[0].operationId : ('op' + Date.now())) + '-' + ops.length,
      body: { baseRev: docRev, baseMtime: Number(window.__edDocMtime || 0), html: buildPageHtml(), ops: ops },
      content: null,   // 同步撤回之后再取（那时正文里已无本次改动）
      changeIds: ops.map(function (o) { return o.changeId; }),
      label: label
    };
  }
  // 明确拒绝 = 服务端在写入前就拒了（4xx 与 503 锁占用）；其余（5xx / 网络异常 / 响应体不可读）= 结果未知。
  function isDefiniteReject(d) {
    var s = Number(d && d._status);
    return (s >= 400 && s < 500) || s === 503;
  }
  function markPending(sub) { (sub.changeIds || []).forEach(function (cid) { pendingSubs[cid] = sub; }); }
  function clearPending(sub) { (sub.changeIds || []).forEach(function (cid) { if (pendingSubs[cid] === sub) delete pendingSubs[cid]; }); }


  // 岗位操作的提交（AUD-03）
  // 并发基线用「本地正文所基于的磁盘 mtime」，不再取服务器最新 rev 给旧整页背书：
  //   取最新 rev 时，本地 DOM 若落后于磁盘（另一标签页已改），这页的旧整页 html 会把别人的改动覆盖掉
  //   （实测：另一页把 P2 改成 OTHER-NEW，旧页接受 P1 后带最新 rev 提交，服务端返回 200，P2 回到 OTHER-OLD）。
  //   mtime 是磁盘正文的精确信号：磁盘被谁动过 → 不匹配 → 409，旧整页不会被提交。
  // 结果三态：
  //   成功       → 更新 mtime/rev；调用方把改动应用到页面
  //   明确拒绝   → 服务端保证没有提交 → 页面保持原样（正文里本来就没有本次改动）
  //   结果未知   → 不回滚、不断言「未落账」；按 requestId 核对回执后再决定
  function postSaveOps(sub, h) {
    h = h || {};
    var label = sub.label;
    api('/save?id=' + DOC_ID, {
      requestId: sub.requestId,
      baseRev: sub.body.baseRev,
      baseMtime: sub.body.baseMtime,
      html: sub.body.html,
      ops: sub.body.ops
    }).then(function (d) {
      if (d && d.ok) {
        clearPending(sub);
        // 回执接纳（与补查命中、同 ID 重放共用一条路径）：校验身份 + 采纳 mtime/rev（只前进）
        var acc = acceptReceipt(sub, takeReceipt(sub, d));
        if (!acc.accepted) note('提交已返回成功，但回执无法接纳（' + acc.reason + '）：基线未更新，请刷新核对', 'warn');
        if (h.onSuccess) h.onSuccess(d, acc);
        refresh();
        return;
      }
      if (isDefiniteReject(d)) {
        clearPending(sub);
        // 撤回失败时正文里仍留着本次改动（BL-P2-02）：不得再宣称「页面保持原样」，
        // 如实告知改动会随下一次保存落盘，并给出撤销出口
        note(((d && d.error) || (label + '失败')) + (sub.withdrawFailed
          ? '（本次改动未落账，且页面未能恢复原样：改动仍留在正文，将随下一次保存写入磁盘——可按撤销回退后重试）'
          : '（本次改动未落账，页面保持原样）'), 'warn');
        if (h.onRejected) h.onRejected(d);
        refresh();
        return;
      }
      // 结果未知：服务端可能已提交 → 不回滚、不断言「未落账」
      markPending(sub);
      note(((d && d.error) || (label + '结果未知')) + '：请求可能已落账，页面未改动；正在与服务端核对回执', 'warn');
      reconcileSub(sub, h);
    }).catch(function (e) {
      // 网络异常同样属于「结果未知」：不能断言未落账、也不能回滚
      markPending(sub);
      note((e && e.message ? e.message : String(e)) + '：请求结果未知（可能已落账），页面未改动；正在与服务端核对回执', 'warn');
      reconcileSub(sub, h);
    });
  }
  // 结果未知的落账核对：以服务端回执为准，不用本地缓存当证据。
  //   · 回执命中 → 落账了（appliedOps 说明落的是哪条操作）
  //   · 回执未命中 + 磁盘版本没动 → 肯定没落账
  //   · 回执未命中 + 磁盘动过 → 可能已被环形表淘汰（回执只留 50 条）→ 保持未知，不猜
  //   · 核对请求本身失败（断网/拒绝）→ 保持未知；绝不用缓存状态当「已落账/未落账」的证据
  function reconcileSub(sub, h) {
    h = h || {};
    api('/job/changes?id=' + encodeURIComponent(DOC_ID) + '&saveReqIds=' + encodeURIComponent(sub.requestId))
      .then(function (d) {
        if (!d || !d.ok) { note('无法核对上一次提交的结果（核对请求失败）：仍按「结果未知」处理，页面未改动，可稍后重试', 'warn'); return; }
        var found = (d.job && d.job.saveReceipts && d.job.saveReceipts.found) || {};
        var hit = found[sub.requestId];
        if (hit) {
          clearPending(sub);
          // 补查命中 → 与普通成功响应共用接纳路径（基线必须一起更新，否则下一次保存拿旧 mtime → 409）
          var acc = acceptReceipt(sub, takeReceipt(sub, { ok: true, receipt: hit.receipt, requestId: hit.requestId }));
          if (!acc.accepted) { note('核对到回执但无法接纳（' + acc.reason + '）：基线未更新，请刷新核对', 'warn'); refresh(); return; }
          if (h.onLanded) h.onLanded(hit, acc);
          refresh();
          return;
        }
        var baseM = Number(sub.body.baseMtime || 0), baseR = Number(sub.body.baseRev || 0);
        var nowM = Number((d.doc && d.doc.mtime) || 0), nowR = Number(d.rev || 0);
        var untouched = nowR === baseR && (baseM <= 0 || (nowM > 0 && Math.abs(nowM - baseM) <= 2));
        if (untouched) {
          clearPending(sub);
          note('此前的提交未落账（服务端无该次回执且磁盘版本未变）：页面未改动，可重新接受', 'warn');
          if (h.onNotLanded) h.onNotLanded();
          refresh();
          return;
        }
        note('无法确认上一次提交是否落账（回执已被环形表淘汰，磁盘版本已变化）：保持「结果未知」，页面未改动，请刷新核对', 'warn');
      })
      .catch(function () {
        note('无法核对上一次提交的结果（核对请求断网）：仍按「结果未知」处理，页面未改动，可稍后重试', 'warn');
      });
  }
  // 回执接纳：普通成功响应 / 按 requestId 补查命中 / 同 ID 重放返回 —— 共用这一条路径。
  //   · 校验请求身份（回执必须属于本次提交）
  //   · 采纳回执里的 mtime/rev（只前进，不倒退：本地已是更新版本时不得把基线拉回去）
  //   · 只动基线，不动正文 → 用户在途修订、dirty 与本地恢复内容都不受影响
  function takeReceipt(sub, d) {
    if (!d || !d.ok) return null;
    // ① 普通成功响应：回执在 d.receipt
    if (d.receipt && typeof d.receipt === 'object') return { receipt: d.receipt, requestId: d.receipt.requestId || sub.requestId };
    // ③ 同 ID 重放（deduped）：回执字段被摊平在响应顶层
    if (d.mtime || d.rev) return { receipt: { mtime: d.mtime, rev: d.rev, appliedOps: d.appliedOps }, requestId: sub.requestId };
    // ② 按 requestId 补查命中
    var found = (d.job && d.job.saveReceipts && d.job.saveReceipts.found) || {};
    var hit = found[sub.requestId];
    if (hit) return { receipt: hit.receipt || null, requestId: hit.requestId || sub.requestId };
    return null;
  }
  function acceptReceipt(sub, got) {
    if (!got || !got.receipt) return { accepted: false, reason: '回执缺失' };
    if (got.requestId && sub.requestId && got.requestId !== sub.requestId) {
      return { accepted: false, reason: '回执身份不符（' + got.requestId + ' ≠ ' + sub.requestId + '）' };
    }
    var mtime = Number(got.receipt.mtime || 0);
    var rev = Number(got.receipt.rev != null ? got.receipt.rev : 0);
    if (mtime > 0 && mtime > Number(window.__edDocMtime || 0)) window.__edDocMtime = mtime;   // 只前进
    if (rev > 0 && rev > (docRev || 0)) docRev = rev;                                      // 只前进
    return { accepted: true, mtime: mtime, rev: rev };
  }
  // 目标守卫：提交瞬间记录受影响目标的状态，回执到达时逐目标核对。
  //   目标没了 → 不能合并（保留用户内容，标待核对）
  //   这次改动会覆盖目标里的文字（replace）且文字变了 → 用户在等待期间改过 → 保留用户内容，标待核对
  //   否则 → 才应用已确认的修改
  // 确认门授权只覆盖确认当时的内容：等待期间的新输入不在授权范围内。
  function guardOf(a) {
    var c = a.c;
    if (c.kind === 'replace') {
      var el = anchorElOf(c);
      return { el: el || null, html: el ? el.innerHTML : null, writes: true };
    }
    if (c.kind === 'hide') {
      var f = findEntry(c);
      var sec = sectionByTitle(c.section);
      return { el: (f && f.pair.head) || sec || null, writes: false };
    }
    if (c.kind === 'add') {
      var sec2 = sectionByTitle(c.section);
      var ul = sec2 ? sec2.querySelector('ul') : null;
      return { el: ul || sec2 || null, writes: false };
    }
    if (c.kind === 'reorder') {
      var f2 = findEntry(c);
      return { el: f2 ? f2.pair.head : null, writes: false };
    }
    return null;
  }
  // 落账确认后把本次改动应用到页面（逐目标核对：用户在等待期间改过的目标不动）
  function applyConfirmedOne(a, guard) {
    var c = a.c;
    if (guard) {
      if (!guard.el || !guard.el.isConnected) return { ok: false, skipped: true, reason: '目标已不存在' };
      if (guard.writes && guard.el.innerHTML !== guard.html) return { ok: false, skipped: true, reason: '目标在等待期间被修改' };
    }
    var r;
    if (a.action === 'accept' && c.kind === 'replace' && a.viaGate) {
      var anchorEl = anchorElOf(c);
      if (!anchorEl) return { ok: false, reason: '锚点已不存在' };
      anchorEl.textContent = c.after;   // 整段干净替换（无空壳标记）
      touch();
      r = { ok: true };
    } else if (a.action === 'accept') {
      r = applyChange(c);
    } else {
      r = revertChange(c);
    }
    if (!r || !r.ok) return { ok: false, reason: (r && r.error) || '应用失败' };
    if (r.node && a.nz) r.node.setAttribute('data-zid', a.nz);
    return { ok: true };
  }
  // 合并已确认的改动：先逐目标核对，再只对**确实要合并**的目标建撤销记录。
  //   守卫不通过 → 保留用户内容（不覆盖）、标「待核对」。
  //   撤销快照取**合并前一刻**：那时用户的在途修订已经在正文里 → 撤销不会把用户的输入一起退回去。
  function applySubConfirmed(sub) {
    var list = sub.appliers || [];
    if (!list.length) return { applied: 0, skipped: [] };
    var guards = sub.guards || [];
    var ready = [], skipped = [];
    list.forEach(function (a, i) {
      var g = guards[i];
      if (g) {
        if (!g.el || !g.el.isConnected) { skipped.push({ a: a, reason: '目标已不存在' }); return; }
        if (g.writes && g.el.innerHTML !== g.html) { skipped.push({ a: a, reason: '目标在等待期间被修改' }); return; }
      }
      ready.push(a);
    });
    if (!ready.length) {
      skipped.forEach(function (s) { markVerify(s.a.c.id, s.reason); });
      note('本次改动已落账，但目标在等待期间被修改：已保留你的输入，未覆盖（面板标注待核对）', 'warn');
      return { applied: 0, skipped: skipped };
    }
    // 撤销快照必须在改动之前压栈（改动后再压 → 撤销变成空操作）
    var undoId = window.__edPushUndo ? window.__edPushUndo(sub.undoLabel || '岗位改动') : null;
    var applied = [];
    ready.forEach(function (a) {
      var r = applyConfirmedOne(a, null);      // 守卫已核过
      if (r && r.ok) applied.push(a);
      else skipped.push({ a: a, reason: (r && r.reason) || '应用失败' });
    });
    skipped.forEach(function (s) { markVerify(s.a.c.id, s.reason); });
    if (!applied.length && undoId != null && window.__edDropUndo) window.__edDropUndo(undoId);   // 一段都没合上 → 不留空撤销
    if (applied.length && applied.length < list.length) {
      note('本次改动部分合并：' + applied.length + ' 段已应用，' + (list.length - applied.length) + ' 段因你在等待期间的修改而保留（面板标注待核对）', 'warn');
    }
    return { applied: applied.length, skipped: skipped };
  }
  // 落账确认 → 合并 → 提示：只有真的合并了才说「已应用」
  function mergeNotice(sub, okText) {
    var res = applySubConfirmed(sub);
    if (res.applied > 0 && okText) note(okText, 'ok');
    return res;
  }
  // 同一逻辑提交的重试：原样重发（同一 requestId 与同一请求体；服务端判重只回执不重放）
  function retrySub(sub) {
    postSaveOps(sub, {
      onSuccess: function () { mergeNotice(sub); },
      onLanded: function () { mergeNotice(sub, '此前的提交已落账（以服务端回执为准），已把改动应用到页面'); }
    });
  }
  // 重试判定：正文与提交时一致 → 原样重发；正文已被用户改过 → 冻结的请求体已过时（重发会覆盖在途输入）→ 先核对
  function retryOrReconcile(sub) {
    if (contentFingerprint() === sub.content) { retrySub(sub); return; }
    reconcileSub(sub, {
      onLanded: function () { mergeNotice(sub, '此前的提交已落账（以服务端回执为准），已把改动应用到页面'); },
      onNotLanded: function () { note('此前的提交未落账：页面保持你的在途输入，可重新接受', 'warn'); }
    });
  }
  function accept(c, viaGate) {
    if (busy) return; busy = true;
    // 同一逻辑提交的重试（上次结果未知）→ 原样重发（同一 requestId 与同一请求体）
    var pending = pendingSubs[c.id];
    if (pending) { busy = false; retryOrReconcile(pending); return; }
    var hits = c.consistency || [];
    if (hits.indexOf('anchor-gone') >= 0) { busy = false; note('目标已删除，不可接受', 'warn'); return; }
    if (hits.indexOf('locked-now') >= 0) { busy = false; note('该段已锁定，不可接受', 'warn'); return; }
    // needs-compare 确认门（设计 §4.2 决策 4）：先展示当前正文 vs 候选差异，确认后才应用
    if (hits.indexOf('needs-compare') >= 0 && !viaGate) { busy = false; renderGate(c); return; }
    var anchorEl = anchorElOf(c);
    var preText = anchorEl ? anchorEl.textContent : '';
    var origText = anchorEl ? normWs(preText) : (c.before || '');
    var op = { operationId: newOperationId(), changeId: c.id, action: 'accept', origText: origText };
    var r;
    if (c.kind === 'replace' && viaGate) {
      // 确认门通过：整段干净替换为候选 after（锚点=当前整段，与服务端 origText 校验一致）
      // anchorEl 可能已失效（zid 被移除）：解引用会抛 TypeError，且抛点在本函数 busy 复位之后 → 面板永久锁死
      // 整段 textContent 干净替换（不产生 <b></b> 空壳）；撤回 = 恢复 innerHTML 快照（行内标记完整回来）
      if (anchorEl) {
        var gateSnap = anchorEl.innerHTML;
        anchorEl.textContent = c.after;
        touch();
        r = { ok: true, meta: {}, inv: { kind: 'html', el: anchorEl, html: gateSnap } };
      } else {
        r = { ok: false, error: '原文锚点已不存在（正文可能已被修改），请重新载入' };
      }
    } else {
      r = applyChange(c);
    }
    if (!r.ok) { busy = false; note(r.error, 'warn'); return; }
    var nz = null;
    if (r.node) {
      nz = randZid();                 // 客户端生成新段落 zid（applyOps 校验形状；服务端落账 newZid 永久对应）
      r.node.setAttribute('data-zid', nz);
      op.newZid = nz;
    }
    var sub = freezeSubmit([op], '接受');
    sub.appliers = [{ c: c, action: 'accept', viaGate: !!viaGate, nz: nz }];
    sub.undoLabel = '接受修改：' + (c.note || c.kind);
    // 同步撤回本次改动：落账确认前正文里不留它 —— 普通自动/手动保存因此不会把未落账的候选写进磁盘。
    // 撤回失败必须被察觉（BL-P2-02）：提交照发（冻结体与服务端一致），拒绝提示按实况改口。
    sub.withdrawFailed = !runInv(r.inv, c);
    sub.content = contentFingerprint();   // 此刻正文里已无本次改动 → 之后据此判断能否原样重发
    sub.guards = sub.appliers.map(guardOf);   // 目标快照：回执到达时逐目标核对（用户在等待期间改过 → 不覆盖）
    busy = false;
    postSaveOps(sub, {
      onSuccess: function () { mergeNotice(sub); },
      onLanded: function () { mergeNotice(sub, '此前的提交已落账（以服务端回执为准），已把改动应用到页面'); }
    });
  }
  function revert(c) {
    if (busy) return; busy = true;
    // 撤回的重试：与接受同口径（同一逻辑提交 → 同一身份）
    var pending = pendingSubs[c.id];
    if (pending) { busy = false; retryOrReconcile(pending); return; }
    // 撤回前置（设计 §4.2）：该段已被手改 → 提示原因并要求确认，拒绝静默执行
    var preEl = anchorElOf(c);
    if (preEl && typeof c.appliedText === 'string' && normWs(preEl.textContent) !== normWs(c.appliedText)) {
      busy = false;
      if (!window.confirm('该段已被修改，撤回会覆盖你的调整——确认撤回？')) { note('已取消撤回'); return; }
      busy = true;
    }
    var anchorEl = anchorElOf(c);
    var op = { operationId: newOperationId(), changeId: c.id, action: 'revert', origText: anchorEl ? normWs(anchorEl.textContent) : '' };
    var r = revertChange(c);
    if (!r.ok && c.kind === 'replace' && c.origText && anchorEl) {
      var curText = anchorEl.textContent;
      r = window.__edReplaceText(curText, c.origText, { root: anchorEl })
        ? { ok: true, inv: { kind: 'replace', find: c.origText, repl: curText, opts: { root: anchorEl } } }
        : r;   // 确认门整段接受过的：整段恢复接受时快照（圈定锚点，不按全文首个匹配）
    }
    if (!r.ok) { busy = false; note(r.error, 'warn'); return; }
    var sub = freezeSubmit([op], '撤回');
    sub.appliers = [{ c: c, action: 'revert', viaGate: false, nz: null }];
    sub.undoLabel = '撤销修改：' + (c.note || c.kind);
    sub.withdrawFailed = !runInv(r.inv, c);   // 同步撤回：页面保持原样，直到落账确认（失败必须被察觉）
    sub.content = contentFingerprint();
    sub.guards = sub.appliers.map(guardOf);
    busy = false;
    postSaveOps(sub, {
      onSuccess: function () { mergeNotice(sub); },
      onLanded: function () { mergeNotice(sub, '此前的撤回已落账（以服务端回执为准），已把改动应用到页面'); }
    });
  }
  function batchAccept(ids) {
    if (busy) return; busy = true;
    // 有未定的提交（同目标上一次落账结果未知）→ 先核对，不重复应用
    var pend = ids.map(function (id) { return pendingSubs[id]; }).filter(Boolean);
    if (pend.length) { busy = false; note('其中 ' + pend.length + ' 条上一次提交结果未知，请先核对该条再重试', 'warn'); return; }
    var ops = [], fails = 0, failedUpdates = [], applied = [];
    // 同 zid 多条候选共享「批内首次遇到时的锚点文本」（= 磁盘文本）：
    // 服务端按磁盘文本校验 origText（BL-P2-04），逐条现读会在第一条应用后读到改后文本 → 必然 400
    var origSnap = {};
    ids.forEach(function (id) {
      var c = job.changes.find(function (x) { return x.id === id; });
      if (!c) return;
      // 批量路径复用单条门控（与 accept 同判定，设计 §4.2）：
      // 冲突/锁定/待比较一律排除出批量，否则会绕过确认门静默覆盖正文
      var hits = c.consistency || [];
      if (hits.indexOf('anchor-gone') >= 0 || hits.indexOf('locked-now') >= 0 || hits.indexOf('needs-compare') >= 0) {
        fails++;
        failedUpdates.push({ id: c.id, status: 'pending', note: '存在冲突或正文已变化，需逐条确认' });
        return;
      }
      var anchorEl = anchorElOf(c);
      var origText;
      if (anchorEl) {
        if (!Object.prototype.hasOwnProperty.call(origSnap, c.zid)) origSnap[c.zid] = normWs(anchorEl.textContent);
        origText = origSnap[c.zid];
      } else origText = (c.before || '');
      var r = applyChange(c);
      if (r.ok) {
        var op = { operationId: newOperationId(), changeId: c.id, action: 'accept', origText: origText };
        var nz = null;
        if (c.kind === 'add' && r.node) {
          nz = randZid();
          r.node.setAttribute('data-zid', nz);
          op.newZid = nz;
        }
        ops.push(op);
        applied.push({ c: c, r: r, nz: nz });
      } else {
        fails++;
        failedUpdates.push({ id: c.id, status: 'pending', note: r.error });
      }
    });
    busy = false;
    if (fails) note(fails + ' 条未能应用（原文可能已变化），其余已接受', 'warn');
    if (failedUpdates.length) setStatus(failedUpdates);
    if (ops.length) {
      var sub = freezeSubmit(ops, '批量接受');
      sub.appliers = applied.map(function (it) { return { c: it.c, action: 'accept', viaGate: false, nz: it.nz }; });
      sub.undoLabel = '批量接受 ' + ops.length + ' 条';
      var wokAll = true;
      applied.forEach(function (it) { if (!runInv(it.r.inv, it.c)) wokAll = false; });   // 同步撤回：页面保持原样
      sub.withdrawFailed = !wokAll;
      sub.content = contentFingerprint();
      sub.guards = sub.appliers.map(guardOf);
      postSaveOps(sub, {
        onSuccess: function () { mergeNotice(sub); },
        onLanded: function () { mergeNotice(sub, '此前的批量接受已落账（以服务端回执为准），已把改动应用到页面'); }
      });
    } else render();
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
  // chips 的开启状态登记进面板状态（BL-P2-06，B 线批 3）：render() 整体重建面板时在
  // A9 回填之前重开 chips，输入框回到 DOM → A9 的按位回填自然接住已输入的值与焦点
  // （旧实现 chips 随重建消失、元素数量变化又让 A9 整体放弃 → 用户输入被丢）。
  var chipsOpen = null;   // { id }：当前开着 chips 的候选 id
  function renderRejectChips(c, div, opts) {
    var old = div.querySelector('.jp-chips');
    if (old) { old.remove(); chipsOpen = null; return; }
    chipsOpen = { id: c.id };
    var chips = document.createElement('div');
    chips.className = 'jp-chips';
    var pick = function (reason) {
      chipsOpen = null;
      var updates = [{ id: c.id, status: 'rejected', note: reason }];
      api('/job/changes?id=' + DOC_ID, { updates: updates, feedback: reason }).then(function (d) {
        if (d.ok) job = d.job; else note(d.error || '状态保存失败', 'warn');
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
        if (!v) { note('先填写自定义原因再记住偏好', 'warn'); return; }
        prefs.push(v);
        localStorage.setItem('s4a-feedback-prefs', JSON.stringify(prefs.slice(-20)));
        note('偏好已存本机（生成时随请求提交）', 'ok');
      } catch (e) {}
    });
    chips.appendChild(remember);
    div.appendChild(chips);
    // 面板重建后的重开不抢焦点：A9 回填「已聚焦的输入不覆值」，这里先 focus 会让值回填被跳过；
    // 焦点由 A9 按采集时的焦点位统一恢复
    if (!opts || !opts.restoreFocus) custom.focus();
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
    note('已保留当前版本（再变化会重新进入待核对）', 'ok');
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
    el.scrollIntoView({ block: 'center', behavior: (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth' });   // A13
  }
  function stepItem(dir) {
    var list = pendingList();
    if (!list.length) return;
    var i = activeIdx(list);
    var next = list[(i + dir + list.length) % list.length];
    gotoItem(next);
  }

  function itemHtml(c) {
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
      cons.innerHTML = __icon('circle-alert') + ' ' + esc(c.consistency.map(function (h) { return CONS_LABEL[h] || h; }).join('；'));
      div.appendChild(cons);
    }
    if (verifyMarks[c.id]) {
      var vm = document.createElement('div');
      vm.className = 'jp-reason';
      vm.innerHTML = __icon('circle-alert') + ' 待核对：' + esc(verifyMarks[c.id]) + '（已落账，但未覆盖你在等待期间的修改）';
      div.appendChild(vm);
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
          (n.parentElement || sheet).scrollIntoView({ block: 'center', behavior: (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'auto' : 'smooth' });   // A13
          return;
        }
      }
      note('未找到定位目标（内容可能已变化）', 'warn');
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
      if (anyRunning(gt)) schedulePoll();
    });
  }
  // 任一生成任务在跑就续排轮询。遍历而非硬编码 kind 名——新增生成类型漏改任一处都会导致
  // 「页面状态长期陈旧」（2026-10-18 OCR 发现 evidence/changes/interview 三处需同步）。
  function anyRunning(gt) {
    gt = gt || {};
    for (var k in gt) { if (gt[k] && gt[k].status === 'running') return true; }
    return false;
  }
  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setTimeout(function () { pollTimer = null; refresh(); }, 2500);
  }
  // A9：标签页不可见时暂停轮询（服务端每次 GET 都要重解析全文），重新可见时立即同步一次
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    } else if (anyRunning((job && job.genTasks) || {})) refresh();
  });

  // A9：轮询每 2.5s 全量重建面板会吞掉在途输入与焦点。重建前采集，重建后按「结构未变」回填——
  // 任务完成等结构变化场景不回填（以服务端新状态为准）。
  function capturePanelInputs() {
    var els = root.querySelectorAll('textarea, input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])');
    var vals = [];
    for (var i = 0; i < els.length; i++) vals.push(els[i].value);
    var ae = document.activeElement, fi = -1;
    if (ae && ae.nodeType === 1 && root.contains(ae)) {
      for (var j = 0; j < els.length; j++) if (els[j] === ae) { fi = j; break; }
    }
    return { vals: vals, fi: fi };
  }
  function restorePanelInputs(cap) {
    if (!cap) return;
    var els = root.querySelectorAll('textarea, input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])');
    if (els.length !== cap.vals.length) return;
    for (var i = 0; i < els.length; i++) {
      if (els[i].value !== cap.vals[i] && document.activeElement !== els[i]) els[i].value = cap.vals[i];
    }
    if (cap.fi >= 0 && els[cap.fi] && document.activeElement !== els[cap.fi]) { try { els[cap.fi].focus(); } catch (e) {} }
  }

  // BL-P2-06：面板重建后按登记状态重开 chips（候选仍在待处理才重开；否则清掉登记）
  function reopenChips() {
    if (!chipsOpen || !job || !job.changes) return;
    var c = job.changes.find(function (x) { return x.id === chipsOpen.id; });
    var div = root.querySelector('[data-change="' + chipsOpen.id + '"]');
    if (!div || !c || c.status !== 'pending') { chipsOpen = null; return; }
    renderRejectChips(c, div, { restoreFocus: true });   // 不抢焦点：值与焦点交给 A9 按位恢复
  }

  function render() {
    if (!job) {
      root.innerHTML = '<div class="jp-empty">本文件不是岗位草稿。</div>';
      return;
    }    var capInputs = capturePanelInputs();   // A9：重建前采集在途输入与焦点
    root.innerHTML = '';
    root.appendChild(secBar());
    if (curSec === 'evidence') renderEvidence();
    else if (curSec === 'export') renderExport();
    else renderChanges();
    reopenChips();          // BL-P2-06：chips 先回 DOM，A9 才能按位回填值与焦点
    var msg = document.createElement('div');
    msg.className = 'jp-msg';
    msg.setAttribute('role', 'status');   // A8：面板提示读屏可感知（render 重建后随新节点带上）
    root.appendChild(msg);
    applyNote();          // 提示跨渲染存活（见 note() 注释）
    restorePanelInputs(capInputs);   // A9：回填在途输入并恢复焦点（结构未变时）
    // 采集时焦点在按钮上（不在输入列表 → fi=-1）而 chips 开着 → 焦点回 chips 输入框
    //（用户的输入上下文在 chips，重建后不应丢到 body 上）
    if (chipsOpen && capInputs.fi < 0) {
      var ci = root.querySelector('.jp-chips input');
      if (ci && document.activeElement !== ci) { try { ci.focus(); } catch (e) {} }
    }
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
    if (!el) { note('未找到定位目标（内容可能已变化）', 'warn'); return; }
    var smooth = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
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
      if (!d.ok) { note(d.error || '说明保存失败', 'warn'); return; }
      job = d.job;
      render();
      note(confirmed === true ? '已确认为证据（计「素材有据·简历未表达」）' : (confirmed === false ? '已退回确认' : '说明已保存'), confirmed === false ? '' : 'ok');
    }).catch(function (e2) { note(e2.message || e2, 'warn'); });
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
          note(d.ok ? '已取消' : (d.error || '取消失败'), d.ok ? '' : 'warn');
          refresh();
        });
      });
    } else {
      act.textContent = gt.status === 'done' || gt.status === 'cancelled' ? '重新分析' : (gt.status === 'error' ? '重试' : '生成证据');
      act.addEventListener('click', function () {
        api('/job/gen-start?id=' + DOC_ID + '&kind=evidence', {}).then(function (d) {
          if (!d.ok) { note(d.error || '启动失败', 'warn'); return; }
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
          loc.innerHTML = __icon('map-pin') + ' 定位';
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
    // S4B-3：面试追问折叠区紧跟证据表末尾（可折叠，不参与审阅任务完成判定，导出永不依赖）
    var ivBox = renderInterview();
    if (ivBox) root.appendChild(ivBox);
  }

  // ===== S4B-3 面试追问（挂在证据表底部；按需生成，不阻塞导出，可停止/重试）=====
  function renderInterview() {
    if (!job.evidence || !job.evidence.length) return null;   // 无证据表 → 折叠区不出现
    var box = document.createElement('div');
    box.className = 'jp-group';
    var gt = (job.genTasks || {}).interview || {};
    // 形状兜底：服务端只保证 interview 是对象，不保证 chains/generic 是数组
    // （meta 是历史落盘数据，形状可能来自旧版本）——按真值取会在这里炸（2026-10-18 OCR）
    var iv = (job.interview && typeof job.interview === 'object') ? job.interview : {};
    var chains = Array.isArray(iv.chains) ? iv.chains : [];
    var generic = Array.isArray(iv.generic) ? iv.generic : [];
    var done = gt.status === 'done' && (chains.length || generic.length);

    var det = document.createElement('details');
    det.className = 'jp-iv';
    // 已生成且未过期 → 展开；error / cancelled → 也展开，否则失败原因藏在折叠里看不见
    if ((done && !job.interviewStale) || gt.status === 'error' || gt.status === 'cancelled') det.open = true;
    var sum = document.createElement('summary');
    sum.textContent = '面试追问（按需生成，不影响导出）';
    det.appendChild(sum);

    var act = document.createElement('button');
    act.type = 'button';
    act.className = 'jp-refbtn';   // 普通操作按钮；jp-ev-cancel 是「取消」语义，只用于取消
    var start = function () {
      act.disabled = true;   // 防连点：下次 render() 重建按钮时自动恢复
      api('/job/gen-start?id=' + DOC_ID + '&kind=interview', {}).then(function (d) {
        if (!d.ok) { act.disabled = false; note(d.error || '启动失败', 'warn'); return; }
        schedulePoll();
      }, function (e) {
        act.disabled = false;   // 网络层 reject：api() 内部走 fetch，不接会成未捕获 rejection
        note(e.message || e, 'warn');
      });
    };

    if (gt.status === 'running') {
      var spin = document.createElement('div');
      spin.className = 'jp-reason';
      spin.textContent = '⟳ 正在生成追问…';
      det.appendChild(spin);
      // 「可停止生成」是设计承诺，之前 running 分支不渲染任何按钮 = 无法停止（2026-10-18 OCR）
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'jp-ev-cancel';
      cancel.textContent = '取消';
      cancel.addEventListener('click', function () {
        api('/job/gen-cancel?id=' + DOC_ID + '&kind=interview&taskId=' + encodeURIComponent(gt.taskId || ''), {}).then(function (d) {
          note(d.ok ? '已取消' : (d.error || '取消失败'), d.ok ? '' : 'warn');
          refresh();
        });
      });
      det.appendChild(cancel);
    } else if (done) {
      if (job.interviewStale) {
        var w = document.createElement('div');
        w.className = 'jp-reason';
        w.innerHTML = __icon('circle-alert') + ' 来源已变化，需重新核对。';
        det.appendChild(w);
      }
      if (Number(iv.dropped) > 0) {
        var dr = document.createElement('div');
        dr.className = 'jp-reason';
        dr.textContent = '已丢弃 ' + Number(iv.dropped) + ' 条对不上原文的要点';
        det.appendChild(dr);
      }
      var card = function (c, label) {
        var it = document.createElement('div');
        it.className = 'jp-item';
        if (label) { var m = document.createElement('div'); m.className = 'jp-meta'; m.textContent = label; it.appendChild(m); }
        var q = document.createElement('b'); q.textContent = c.question; it.appendChild(q);
        if (c.followUp) { var f = document.createElement('div'); f.className = 'jp-meta'; f.textContent = '再问：' + c.followUp; it.appendChild(f); }
        if (!c.answerPoints || !Array.isArray(c.answerPoints) || !c.answerPoints.length) {
          var e0 = document.createElement('div'); e0.className = 'jp-meta'; e0.textContent = '无可用要点'; it.appendChild(e0);
        } else {
          var ul = document.createElement('ul');
          ul.style.margin = '4px 0 0 16px';
          ul.style.padding = '0';
          c.answerPoints.forEach(function (p) {
            var li = document.createElement('li');
            li.textContent = p.text;
            if (p.guard === 'conflict') {
              var gw = document.createElement('span');
              gw.className = 'jp-reason';
              gw.innerHTML = ' ' + __icon('circle-alert') + '出现原文没有的数字';
              li.appendChild(gw);
            }
            if (p.anchored && c.zid) {
              var zb = document.createElement('button');
              zb.type = 'button'; zb.className = 'jp-refbtn'; zb.textContent = '回跳';
              zb.addEventListener('click', (function (z) { return function () { locateZid(z); }; })(c.zid));
              li.appendChild(zb);
            }
            ul.appendChild(li);
          });
          it.appendChild(ul);
        }
        return it;
      };
      // 标签必须用 c.evIndex（模型给的证据表下标），不能用数组下标 i——
      // 中间任何一条链被 fail-closed 丢弃都会让后续标签整体错位（2026-10-18 OCR 高危项）
      chains.forEach(function (c) {
        det.appendChild(card(c, c.evIndex >= 0 ? '证据表第 ' + (c.evIndex + 1) + ' 行' : '未对应到证据表行'));
      });
      generic.forEach(function (c) { det.appendChild(card(c, '通用问题')); });
      act.textContent = '重新生成';
      act.addEventListener('click', start);
      det.appendChild(act);
    } else {
      var hint2 = document.createElement('div');
      hint2.className = 'jp-meta';
      hint2.textContent = gt.status === 'error'
        ? '生成失败：' + (gt.error || '未知原因')
        : (gt.status === 'cancelled' ? '已取消。' : '按你的证据表预判面试官会追问什么，附答法要点。生成失败不影响导出。');
      det.appendChild(hint2);
      act.textContent = gt.status === 'error' ? '重试' : (gt.status === 'cancelled' ? '继续生成' : '生成面试追问');
      act.addEventListener('click', start);
      det.appendChild(act);
    }

    box.appendChild(det);
    return box;
  }

  // ===== 段三「导出检查」：三级检查 + 两级完成（S4a-T10：与导出页共用 exportChecks，jobViewLive 同源即时状态）=====
  function renderExport() {
    var checks = job.checks || null;
    var box = document.createElement('div');
    box.className = 'jp-group';
    var head4 = document.createElement('h4');
    head4.textContent = '导出检查（第三步）';
    box.appendChild(head4);
    if (!checks) {
      var meta0 = document.createElement('div');
      meta0.className = 'jp-meta';
      meta0.textContent = '检查数据不可用（非岗位草稿或读取失败）。';
      box.appendChild(meta0);
    } else {
      var gate = document.createElement('div');
      gate.className = 'jp-meta';
      gate.innerHTML = checks.blocking && checks.blocking.length
        ? __icon('circle-slash') + ' 阻止导出：未解决事实冲突 ' + checks.blocking.length + ' 条（含稍后处理的冲突）。'
        : __icon('circle-check') + ' 允许导出：无未解决事实冲突。';
      box.appendChild(gate);
      var v = checks.check || {};
      var nThin = (v.thin || []).length, nStale = (v.stale || []).length, nVerify = (v.toVerify || []).length;
      var suggest = document.createElement('div');
      suggest.className = 'jp-meta';
      suggest.textContent = '建议核对（不阻塞导出）：'
        + (nVerify ? '待核对候选 ' + nVerify + '；' : '')
        + (nThin ? '表达不充分证据 ' + nThin + '；' : '')
        + (nStale ? '来源已变化证据 ' + nStale + '；' : '')
        + (!nVerify && !nThin && !nStale ? '无。' : '');
      box.appendChild(suggest);
      var done = document.createElement('div');
      done.className = 'jp-meta';
      done.innerHTML = checks.reviewComplete ? __icon('circle-check') + ' 整体审阅完成（跨全部批次：无待处理/稍后处理/待核对项）。' : '整体审阅未完成（仍有待处理/稍后处理/待核对项）。';
      box.appendChild(done);
    }
    root.appendChild(box);
    var exp = document.createElement('a');
    exp.href = '/export?id=' + DOC_ID;
    exp.textContent = '前往导出页（含排版诊断）';
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
        if (!d.ok) { note(d.error || '生成失败', 'warn'); gen.disabled = false; return; }
        job = d.job; note('已生成 ' + d.generated + ' 条建议（旧候选标记为 superseded）', 'ok'); render();
      }).catch(function (e) { busy = false; note(e.message, 'warn'); gen.disabled = false; });
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
      gate.innerHTML = '<b>' + __icon('circle-slash') + ' 事实冲突未解决前不能导出</b><div class="jp-meta">逐条确认接受或撤销后解除。</div>';
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
    if (!d.ok) { root.textContent = d._network ? '加载失败：网络错误（切到其他 Tab 再切回可重试）。' : '加载失败：不是岗位草稿或读取错误。'; return; }
    job = d.job; doc = d.doc; docRev = d.rev || 0;
    applyReviewPos();
    render();
    var gt = job.genTasks || {};
    if (anyRunning(gt)) schedulePoll();
  }).catch(function () { root.textContent = '加载失败：网络错误（切到其他 Tab 再切回可重试）。'; });

  // 外壳 Tab 切换到「审阅」时刷新（反映最新落盘状态；不重置当前段）
  window.addEventListener('ed-review-refresh', function () { refresh(); });
})();
