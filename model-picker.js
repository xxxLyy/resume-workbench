// model-picker.js — 模型多选组件（2026-11-16，多模型对比）：≥2 个就绪档案才渲染；
// 勾选持久化 localStorage「ai-compare-profiles」（name|model 键数组，未知键丢弃，空选回落 active）。
// API：window.__modelPicker.mount(el) → Promise<{ el?, selected(), labelOf(i) }>（<2 就绪时返回无 UI 占位）。
(function () {
  var CACHE = null;
  function load() {
    if (!CACHE) CACHE = fetch('/ai/profiles').then(function (r) { return r.json(); }).catch(function () { return null; });
    return CACHE;
  }
  var keyOf = function (p) { return (p.name || '') + '|' + (p.model || ''); };
  async function mount(el) {
    var d = await load();
    var list = (d && d.ok ? d.list : []) || [];
    var active = d && typeof d.active === 'number' ? d.active : 0;
    var api = {
      selected: function () { return [active]; },
      labelOf: function (i) { var p = list[i] || {}; return [p.name, p.model].filter(Boolean).join('·') || ('模型 ' + i); }
    };
    var ready = list.filter(function (p) { return p && p.ready; });
    if (!el || ready.length < 2) return api;
    var saved = {};
    try { JSON.parse(localStorage.getItem('ai-compare-profiles') || '[]').forEach(function (k) { saved[k] = 1; }); } catch (e) {}
    var anySaved = ready.some(function (p) { return saved[keyOf(p)]; });
    var box = document.createElement('div');
    box.className = 'mp-row';
    box.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;margin:6px 0';
    var lab = document.createElement('span');
    lab.style.cssText = 'color:var(--ed-mut,var(--mut))';
    lab.textContent = '对比模型：';
    box.appendChild(lab);
    var cbs = [];
    ready.forEach(function (p) {
      var wrap = document.createElement('label');
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = anySaved ? !!saved[keyOf(p)] : p.i === active;
      var t = document.createElement('span');
      t.textContent = keyOf(p).replace('|', '·');   // textContent 建 DOM：档案名不拼 HTML
      wrap.appendChild(cb);
      wrap.appendChild(t);
      box.appendChild(wrap);
      cbs.push({ cb: cb, i: p.i });
    });
    var hint = document.createElement('span');
    hint.style.cssText = 'color:var(--ed-mut,var(--mut));font-size:11px';
    hint.textContent = '多选一个模型，多一次调用';
    box.appendChild(hint);
    function persist() {
      try {
        var keys = cbs.filter(function (c) { return c.cb.checked; }).map(function (c) {
          var p = ready.filter(function (x) { return x.i === c.i; })[0] || {};
          return keyOf(p);
        });
        localStorage.setItem('ai-compare-profiles', JSON.stringify(keys));
      } catch (e) {}
    }
    cbs.forEach(function (c) {
      c.cb.addEventListener('change', function () {
        if (!cbs.some(function (x) { return x.cb.checked; })) c.cb.checked = true;   // 保底：至少留一个
        persist();
      });
    });
    api.el = box;
    api.selected = function () {
      var out = cbs.filter(function (c) { return c.cb.checked; }).map(function (c) { return c.i; });
      return out.length ? out : [active];
    };
    el.appendChild(box);
    return api;
  }
  window.__modelPicker = { mount: mount };
})();
