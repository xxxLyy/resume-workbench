// zone-panel.js — 区域 Tab：区域列表 / 定位 / 着色 / 改绑 / 待绑定队列（区域级 AI 与修改模式由 T5/T6 增补）
// 由 server /edit 对所有文档幂等注入（ZONE-INJECT 注释对），/save 时剥离，文档零污染（正文只落 data-zid）。
(function () {
  var DOC_ID = document.currentScript.getAttribute('data-doc');
  var pane = document.getElementById('ed-pane-zone');
  if (!pane) return;
  var sheet = document.querySelector('.sheet');
  if (!sheet) return;

  // 幂等清理
  ['zp-root'].forEach(function (id) { var el = document.getElementById(id); if (el) el.remove(); });
  document.querySelectorAll('style[data-zone-panel]').forEach(function (el) { el.remove(); });

  var ZONES = [
    ['personal', '个人'], ['education', '教育'], ['work', '工作'], ['project', '项目'],
    ['skill', '技能'], ['award', '获奖'], ['summary', '自评'], ['other', '其他']
  ];
  // 8 色带（数据区分色，hsla 形态不走 --ed-* token；S2-B2 已登记）
  var ZONE_HUES = { personal: 'hsla(28,80%,55%,.14)', education: 'hsla(45,85%,55%,.16)', work: 'hsla(210,70%,55%,.12)',
    project: 'hsla(262,55%,55%,.12)', skill: 'hsla(160,60%,45%,.14)', award: 'hsla(48,90%,50%,.18)',
    summary: 'hsla(340,65%,60%,.12)', other: 'hsla(0,0%,45%,.10)' };

  var css = document.createElement('style');
  css.setAttribute('data-zone-panel', '1');
  css.textContent = '.zp{padding:12px;font-size:12px;display:flex;flex-direction:column;gap:8px}'
    + '.zp-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center}'
    + '.zp-head button,.zp-modal button{min-height:26px;padding:0 10px;border-radius:7px;font-size:12px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.zp-head button[aria-pressed="true"]{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.zp-row{display:flex;align-items:center;gap:6px;padding:5px 2px;border-top:1px solid var(--ed-line);cursor:pointer}'
    + '.zp-row:hover{background:var(--ed-bg)}'
    + '.zp-dot{width:10px;height:10px;border-radius:3px;flex:none}'
    + '.zp-row .zp-n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.zp-c{font-size:10px;color:var(--ed-mut)}'
    + '.zp-c.warn{color:var(--ed-warn)}'
    + '.zp-modal{position:fixed;inset:0;background:rgba(60,45,25,.24);display:flex;align-items:center;justify-content:center;z-index:105}'
    + '.zp-modal .zp-card{background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:14px;box-shadow:0 18px 50px rgba(60,45,25,.16);padding:16px;width:min(320px,92vw);display:flex;flex-direction:column;gap:8px;font-size:13px}'
    + '.zp-modal button.zp-sel[aria-pressed="true"]{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.zp button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    // 8 条区域着色通道（CSS Custom Highlight：只存在于内存 Range，不落盘、不给正文挂 class）
    + '::highlight(zone-personal){background-color:hsla(28,80%,55%,.14)}'
    + '::highlight(zone-education){background-color:hsla(45,85%,55%,.16)}'
    + '::highlight(zone-work){background-color:hsla(210,70%,55%,.12)}'
    + '::highlight(zone-project){background-color:hsla(262,55%,55%,.12)}'
    + '::highlight(zone-skill){background-color:hsla(160,60%,45%,.14)}'
    + '::highlight(zone-award){background-color:hsla(48,90%,50%,.18)}'
    + '::highlight(zone-summary){background-color:hsla(340,65%,60%,.12)}'
    + '::highlight(zone-other){background-color:hsla(0,0%,45%,.10)}';
  document.head.appendChild(css);

  function api(url, body) {
    return fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.json(); });
  }

  var state = { zones: {}, zoneOrder: null, zoneRounds: {}, colorOn: false };
  var root = document.createElement('div');
  root.id = 'zp-root';
  root.className = 'zp';
  pane.appendChild(root);

  function load() {
    return api('/job/changes?id=' + encodeURIComponent(DOC_ID)).then(function (d) {
      state.zones = (d && d.zones) || {};
      state.zoneOrder = d && d.zoneOrder;
      state.zoneRounds = (d && d.zoneRounds) || {};   // T5 前服务端无此字段，兜底空
      render();
      paint();
    });
  }
  function counts() {
    var c = {};
    ZONES.forEach(function (z) { c[z[0]] = { ok: 0, pend: 0 }; });
    Object.keys(state.zones).forEach(function (zid) {
      var z = state.zones[zid];
      if (!c[z.zone]) return;
      if (z.status === 'confirmed') c[z.zone].ok++; else c[z.zone].pend++;
    });
    return c;
  }
  function render() {
    var c = counts();
    var pend = Object.keys(state.zones).filter(function (zid) { return state.zones[zid].status === 'pending'; }).length;
    var order = state.zoneOrder && state.zoneOrder.length ? state.zoneOrder : ZONES.map(function (z) { return z[0]; });
    var html = '<div class="zp-head"><button type="button" id="zp-color" aria-pressed="' + (state.colorOn ? 'true' : 'false') + '">🎨 着色</button>'
      + (pend ? '<button type="button" class="zp-c warn" id="zp-pend">待绑定 ' + pend + ' 个段落</button>' : '<span class="zp-c">绑定完成</span>') + '</div>';
    order.forEach(function (k) {
      if (!ZONE_HUES[k]) return;
      var name = (ZONES.filter(function (z) { return z[0] === k; })[0] || ['', '?'])[1];
      html += '<div class="zp-row" data-zone="' + k + '"><span class="zp-dot" style="background:' + ZONE_HUES[k] + '"></span>'
        + '<span class="zp-n">' + name + (state.zoneRounds[k] ? ' · 轮次' + state.zoneRounds[k] : '') + '</span>'
        + '<span class="zp-c">' + (c[k].ok ? '✓' + c[k].ok : '') + (c[k].pend ? ' ⚠' + c[k].pend : '') + '</span></div>';
    });
    root.innerHTML = html;
    root.querySelector('#zp-color').addEventListener('click', toggleColor);
    if (root.querySelector('#zp-pend')) root.querySelector('#zp-pend').addEventListener('click', confirmNextPending);
    Array.prototype.forEach.call(root.querySelectorAll('.zp-row'), function (row) {
      row.addEventListener('click', function () { locate(row.getAttribute('data-zone')); });
    });
  }

  // 定位与闪烁（CSS Custom Highlight，不给正文挂 class）
  function locate(zoneKey) {
    var hit = null;
    Array.prototype.some.call(sheet.querySelectorAll('[data-zid]'), function (el) {
      var z = state.zones[el.getAttribute('data-zid')];
      if (z && z.zone === zoneKey) { hit = el; return true; }
      return false;
    });
    if (hit) { hit.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(hit); }
  }
  function flash(el) {
    if (!window.CSS || !CSS.highlights) return;
    var r = document.createRange(); r.selectNodeContents(el);
    CSS.highlights.set('zp-flash', new Highlight(r));
    setTimeout(function () { CSS.highlights.delete('zp-flash'); }, 900);
  }
  function toggleColor() {
    state.colorOn = !state.colorOn;
    root.querySelector('#zp-color').setAttribute('aria-pressed', state.colorOn ? 'true' : 'false');
    paint();
  }
  function paint() {
    if (!window.CSS || !CSS.highlights) return;
    ZONES.forEach(function (z) { CSS.highlights.delete('zone-' + z[0]); });
    if (!state.colorOn) return;
    var byZone = {};
    Array.prototype.forEach.call(sheet.querySelectorAll('[data-zid]'), function (el) {
      var z = state.zones[el.getAttribute('data-zid')];
      if (!z) return;
      (byZone[z.zone] = byZone[z.zone] || []).push(el);
    });
    Object.keys(byZone).forEach(function (k) {
      var ranges = byZone[k].map(function (el) { var r = document.createRange(); r.selectNodeContents(el); return r; });
      if (!ranges.length) return;
      var hl = new Highlight(ranges[0]);               // 变参构造：首参 + .add()（handoff §6 口径）
      ranges.slice(1).forEach(function (r) { hl.add(r); });
      CSS.highlights.set('zone-' + k, hl);
    });
  }

  // 逐段确认：定位第一个 pending 段落 → 弹窗选 8 类（取消 = 跳过这段看下一段）→ POST /zones 整条回写 → 下一段
  function confirmNextPending() {
    var zid = Object.keys(state.zones).filter(function (k) { return state.zones[k].status === 'pending'; })[0];
    if (!zid) return;
    var el = sheet.querySelector('[data-zid="' + zid + '"]');
    if (el) { el.scrollIntoView({ block: 'center' }); flash(el); }
    openPicker(zid, el ? (el.textContent || '').slice(0, 30) : '');
  }
  function openPicker(zid, preview) {
    var mask = document.createElement('div');
    mask.className = 'zp-modal';
    mask.setAttribute('data-zone-panel', '1');          // 运行时标记（extract 第二道防线同款）
    var card = document.createElement('div');
    card.className = 'zp-card';
    var head = document.createElement('div');
    head.textContent = '段落：' + preview + '…';
    card.appendChild(head);
    ZONES.forEach(function (z) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'zp-sel'; b.textContent = z[1];
      if (state.zones[zid] && state.zones[zid].zone === z[0]) b.setAttribute('aria-pressed', 'true');
      b.addEventListener('click', function () { closePicker(); bindOne(zid, z[0], true); });
      card.appendChild(b);
    });
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = '取消';
    cancel.addEventListener('click', function () { closePicker(); confirmNextPending(); });   // 跳过这段看下一段
    card.appendChild(cancel);
    mask.appendChild(card);
    function closePicker() { mask.remove(); }
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) { if (e.target === mask) closePicker(); });
  }
  function bindOne(zid, zoneKey, confirmed) {
    // 整条回写契约（T2 quality Note 3）：/zones 是整体替换，必须带上已有 locked 字段，漏传会静默丢锁
    var next = {};
    Object.keys(state.zones).forEach(function (k) {
      var o = state.zones[k];
      var e = { zone: o.zone, status: o.status };
      if (typeof o.locked === 'boolean') e.locked = o.locked;
      next[k] = e;
    });
    var ne = { zone: zoneKey, status: confirmed ? 'confirmed' : 'pending' };
    if (typeof next[zid].locked === 'boolean') ne.locked = next[zid].locked;
    next[zid] = ne;
    api('/zones?id=' + encodeURIComponent(DOC_ID), { zones: next }).then(load);
  }

  load();
  // 外壳 Tab 切换到「区域」时刷新（shell 初绑 /zones/init 与本面板 load 并发，切 Tab 时拿最新落盘状态）
  window.addEventListener('ed-zone-refresh', load);
})();
