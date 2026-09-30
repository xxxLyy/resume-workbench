// zone-panel.js — 区域 Tab：区域列表 / 定位 / 着色 / 改绑 / 待确认分类队列 / 区域级 AI（分析意见 + 改写候选，T5）
// 由 server /edit 对所有文档幂等注入（ZONE-INJECT 注释对），/save 时剥离，文档零污染（正文只落 data-zid）。
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
    + '.zp-empty{font-size:11px;color:var(--ed-mut);padding:2px 2px 4px 16px}'
    + '.zp-modal{position:fixed;inset:0;background:rgba(60,45,25,.24);display:flex;align-items:center;justify-content:center;z-index:105}'
    + '.zp-modal .zp-card{background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:14px;box-shadow:0 18px 50px rgba(60,45,25,.16);padding:16px;width:min(320px,92vw);display:flex;flex-direction:column;gap:8px;font-size:13px}'
    + '.zp-modal button.zp-sel[aria-pressed="true"]{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.zp button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.zp-ai{border-top:1px solid var(--ed-line);padding-top:8px;display:flex;flex-direction:column;gap:6px}'
    + '.zp-ai[hidden]{display:none}'
    + '.zp-ai .zp-echo{margin:0;padding-left:16px;color:var(--ed-ink)}'
    + '.zp-ai .zp-remind{color:var(--ed-warn);margin:0}'
    + '.zp-ai .zp-sugg{margin:0;color:var(--ed-mut)}'
    + '.zp-chips{display:flex;flex-wrap:wrap;gap:4px}'
    + '.zp-chips button{min-height:22px;padding:0 8px;font-size:11px;border-radius:6px;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '.zp-ai textarea{width:100%;min-height:44px;resize:vertical;border:1px solid var(--ed-line);border-radius:7px;background:var(--ed-panel);color:var(--ed-ink);font:inherit;padding:4px 6px;box-sizing:border-box}'
    + '.zp-cand{border:1px dashed var(--ed-line);border-radius:7px;padding:6px;font-size:11px;color:var(--ed-mut)}'
    + '.zp-cand .zp-cand-new{color:var(--ed-ink)}'
    + '.zp-cand.conflict{border-color:var(--ed-warn)}'
    + '.zp-cand.conflict .zp-cand-flag{color:var(--ed-warn)}'
    + '.zp-degr{color:var(--ed-mut);margin:0}'
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
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) { d._status = r.status; return d; });
    });
  }

  var state = { zones: {}, zoneOrder: null, zoneRounds: {}, colorOn: false, aiZone: null, aiDegraded: false, lastAnalysis: null };
  var preview = [];   // S3-T6：当前可接受候选集（非 conflict；renderPreview 维护，accept 消费）
  var root = document.createElement('div');
  root.id = 'zp-root';
  root.className = 'zp';
  pane.appendChild(root);

  function load() {
    return api('/job/changes?id=' + encodeURIComponent(DOC_ID)).then(function (d) {
      if (!d || !d.ok) return;                        // 错误响应保持上次渲染（防「待确认分类 N」误显示为「绑定完成」）
      state.zones = d.zones || {};
      state.zoneOrder = d.zoneOrder;
      state.zoneRounds = d.zoneRounds || {};          // T5 前服务端无此字段，兜底空
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
      + (pend ? '<button type="button" class="zp-c warn" id="zp-pend">待确认分类 ' + pend + ' 段</button>' : '<span class="zp-c">绑定完成</span>') + '</div>';
    order.forEach(function (k) {
      if (!ZONE_HUES[k]) return;
      var name = (ZONES.filter(function (z) { return z[0] === k; })[0] || ['', '?'])[1];
      html += '<div class="zp-row" data-zone="' + k + '"><span class="zp-dot" style="background:' + ZONE_HUES[k] + '"></span>'
        + '<span class="zp-n">' + name + (state.zoneRounds[k] ? ' · 轮次' + state.zoneRounds[k] : '') + '</span>'
        + '<span class="zp-c">' + (c[k].ok ? '✓' + c[k].ok : '') + (c[k].pend ? ' ⚠' + c[k].pend : '') + '</span></div>'
        // 空 zone 空态（D5）：无任何段落的区域行给一行说明（正文添加后自动进入待确认）
        + (!c[k].ok && !c[k].pend ? '<div class="zp-empty">' + name + '区域暂无内容——正文添加相关段落后会自动进入待确认</div>' : '');
    });
    root.innerHTML = html;
    root.querySelector('#zp-color').addEventListener('click', toggleColor);
    if (root.querySelector('#zp-pend')) root.querySelector('#zp-pend').addEventListener('click', confirmNextPending);
    Array.prototype.forEach.call(root.querySelectorAll('.zp-row'), function (row) {
      row.addEventListener('click', function () {
        locate(row.getAttribute('data-zone'));
        openAi(row.getAttribute('data-zone'));
      });
    });
    // 保留已展开的 AI 区（render() 由 load() 回调触发重绘时不把意见卡打回）
    if (state.aiZone) renderAi();
  }

  // ===== 区域级 AI（T5）：意见卡 + chips 追问 + 修改模式输入 + 改写候选预览 =====
  // 改写候选经 ed-zone-preview 事件进 renderPreview（T6 起事件是正式消费通道），接受走 S2 统一撤销链路。
  function openAi(zoneKey) {
    state.aiZone = zoneKey;
    state.aiDegraded = false;
    state.lastAnalysis = null;
    renderAi();
    analyze(zoneKey, '');
  }
  function aiBox() { return document.getElementById('zp-ai'); }
  function setBusy(busy) {
    var a = document.getElementById('zp-analyze'), r = document.getElementById('zp-rewrite');
    if (a) a.disabled = busy || state.aiDegraded;
    if (r) r.disabled = busy || state.aiDegraded;
    // S3-T6（T5 移交）：in-flight 时 chips 一并置灰，防连点双请求后到覆盖先到
    // （#zp-analyze 也在 .zp-chips 内 → 必须同带 aiDegraded 判定，否则降级态会被本行重新点亮）
    Array.prototype.forEach.call(document.querySelectorAll('#zp-ai .zp-chips button'), function (b) { b.disabled = busy || state.aiDegraded; });
  }
  function degrade(msg) {
    state.aiDegraded = true;
    var box = aiBox();
    if (box) {
      var note = document.createElement('p');
      note.className = 'zp-degr';
      note.textContent = (msg || '未配置大模型') + '，绑定/确认/锁定不受影响';
      box.insertBefore(note, box.firstChild);
    }
    setBusy(false);
  }
  function renderAi() {
    var old = aiBox();
    var keepInstr = old ? ((document.getElementById('zp-instr') || {}).value || '') : '';   // S3-T6（T5 移交）：重绘不吞已输入的修改意见
    if (old) old.remove();
    var zoneKey = state.aiZone;
    if (!zoneKey) return;
    var name = (ZONES.filter(function (z) { return z[0] === zoneKey; })[0] || ['', zoneKey])[1];
    var box = document.createElement('div');
    box.id = 'zp-ai';
    box.className = 'zp-ai';
    var head = document.createElement('div');
    head.textContent = 'AI 意见 · ' + name + (state.zoneRounds[zoneKey] ? '（第 ' + (state.zoneRounds[zoneKey] + 1) + ' 轮）' : '');
    box.appendChild(head);
    var out = document.createElement('div');
    out.id = 'zp-ai-out';
    out.textContent = '分析中…';
    box.appendChild(out);
    var acts = document.createElement('div');
    acts.className = 'zp-chips';
    var reBtn = document.createElement('button');
    reBtn.type = 'button';
    reBtn.id = 'zp-analyze';
    reBtn.textContent = '重新分析';
    reBtn.addEventListener('click', function () { analyze(zoneKey, ''); });
    acts.appendChild(reBtn);
    box.appendChild(acts);
    var ta = document.createElement('textarea');
    ta.id = 'zp-instr';
    ta.placeholder = '修改意见，如：更精简、突出量化结果';
    ta.value = keepInstr;
    box.appendChild(ta);
    var rwBtn = document.createElement('button');
    rwBtn.type = 'button';
    rwBtn.id = 'zp-rewrite';
    rwBtn.textContent = '生成改写';
    rwBtn.addEventListener('click', function () {
      var v = (document.getElementById('zp-instr').value || '').trim();
      if (!v) { out.textContent = '请先填写修改意见'; return; }
      rewrite(zoneKey, v);
    });
    box.appendChild(rwBtn);
    var prev = document.getElementById('zp-preview');
    if (prev) box.appendChild(prev);   // 认领事件通道已建的预览容器（保持单实例，避免双 id）
    else { prev = document.createElement('div'); prev.id = 'zp-preview'; box.appendChild(prev); }
    root.appendChild(box);
    if (state.lastAnalysis && state.lastAnalysis.zone === zoneKey) showAnalysis(state.lastAnalysis.data);
    setBusy(state.aiDegraded);
  }
  function showAnalysis(d) {
    var out = document.getElementById('zp-ai-out');
    if (!out) return;
    out.innerHTML = '';
    (d.echoes || []).forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'zp-echo';
      li.textContent = t;
      out.appendChild(li);
    });
    if (d.reminder) {
      var p1 = document.createElement('p');
      p1.className = 'zp-remind';
      p1.textContent = '⚠ ' + d.reminder;
      out.appendChild(p1);
    }
    if (d.suggestion) {
      var p2 = document.createElement('p');
      p2.className = 'zp-sugg';
      p2.textContent = '✎ ' + d.suggestion;
      out.appendChild(p2);
    }
    if (!(d.echoes || []).length && !d.reminder && !d.suggestion) out.textContent = '（本轮无具体意见）';
    var chips = document.querySelector('#zp-ai .zp-chips');
    (d.chips || []).forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = t;
      b.addEventListener('click', function () {
        var ta = document.getElementById('zp-instr');
        if (ta) ta.value = t;
        analyze(state.aiZone, t);       // chips 追问 = 以 chip 文本再请求（轮次服务端自增）
      });
      chips.appendChild(b);
    });
  }
  function analyze(zoneKey, extra) {
    if (state.aiDegraded) return;
    setBusy(true);
    var out = document.getElementById('zp-ai-out');
    if (out) out.textContent = '分析中…';
    api('/ai/zone-analyze?id=' + encodeURIComponent(DOC_ID), { zone: zoneKey, extra: extra }).then(function (d) {
      setBusy(false);
      if (d._status === 409) { degrade('未配置大模型'); return; }
      if (!d.ok) { if (out) out.textContent = d.error || '分析失败，稍后再试'; return; }
      if (state.aiZone !== zoneKey) return;   // 慢响应守卫：用户已切区域，旧意见不得写进新卡
      state.lastAnalysis = { zone: zoneKey, data: d };
      load();                          // 轮次自增后刷新行内计数（load 重绘保留 AI 区）
      showAnalysis(d);
    }).catch(function () { setBusy(false); if (out) out.textContent = '分析失败，稍后再试'; });
  }
  function rewrite(zoneKey, instruction) {
    if (state.aiDegraded) return;
    instruction = String(instruction || '').replace(/\s+/g, ' ').trim();   // S3-T6（T5 移交）：压单行，闭合经换行伪造段落行的注入面
    setBusy(true);
    var prev = document.getElementById('zp-preview');
    if (prev) prev.textContent = '生成中…';
    api('/ai/zone-rewrite?id=' + encodeURIComponent(DOC_ID), { zone: zoneKey, instruction: instruction }).then(function (d) {
      setBusy(false);
      if (d._status === 409) { degrade('未配置大模型'); if (prev) prev.textContent = ''; return; }
      if (!d.ok) { if (prev) prev.textContent = d.error || '改写失败，稍后再试'; return; }
      if (state.aiZone !== zoneKey) return;   // 慢响应守卫：旧候选不渲染、不派发 ed-zone-preview
      window.dispatchEvent(new CustomEvent('ed-zone-preview', { detail: { doc: DOC_ID, zone: zoneKey, rewrites: d.rewrites || [] } }));
    }).catch(function () { setBusy(false); if (prev) prev.textContent = '改写失败，稍后再试'; });
  }
  // 改写候选预览（S3-T6）：非 conflict 候选整体接受（一条撤销 op）；conflict 项只展示 ⚠ 理由，不计入可接受集合
  function renderPreview(rewrites) {
    var prev = document.getElementById('zp-preview');
    if (!prev) {                    // 事件通道不依赖 AI 卡开合：容器缺失时自建在面板根（renderAi 开卡时认领）
      prev = document.createElement('div');
      prev.id = 'zp-preview';
      root.appendChild(prev);
    }
    prev.innerHTML = '';
    preview = (rewrites || []).filter(function (r) { return r.level !== 'conflict'; });
    if (!(rewrites || []).length) { prev.textContent = '（无可应用的改写候选）'; return; }
    rewrites.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'zp-cand' + (r.level === 'conflict' ? ' conflict' : '');
      var orig = document.createElement('div');
      orig.textContent = '原：' + (r.before || '').slice(0, 60);
      var neu = document.createElement('div');
      neu.className = 'zp-cand-new';
      neu.textContent = '改：' + (r.candidate || '').slice(0, 60);
      card.appendChild(orig);
      card.appendChild(neu);
      if (r.level === 'conflict') {
        var flag = document.createElement('div');
        flag.className = 'zp-cand-flag';
        flag.textContent = '⚠ ' + (r.reason || '事实冲突，需人工核对');
        card.appendChild(flag);
      }
      prev.appendChild(card);
    });
    if (preview.length) {
      var acc = document.createElement('button');
      acc.type = 'button';
      acc.id = 'zp-accept';
      acc.textContent = preview.length > 1 ? '接受（' + preview.length + ' 段）' : '接受';
      acc.addEventListener('click', accept);
      prev.appendChild(acc);
    }
  }
  // 接受区域改写：严格走 S2 统一撤销链路——快照先压栈 → 改 DOM → 标记程序化 → Toast 绑 opId（与工具条同一条 op）
  function accept() {
    var todo = preview.filter(function (it) { return sheet.querySelector('[data-zid="' + it.zid + '"]'); });
    var stale = preview.length - todo.length;
    if (!todo.length) {
      var p = document.getElementById('zp-preview');
      if (p) p.textContent = '段落已变化，请重新生成';
      return;
    }
    var opId = window.__edPushUndo('区域改写');
    todo.forEach(function (it) {
      var el = sheet.querySelector('[data-zid="' + it.zid + '"]');
      el.textContent = it.candidate;      // 纯文本替换：整段拍平 inline 标记是 S3 已知限制（diff 预览可见原文与候选）
    });
    window.__edMarkProgrammatic();
    if (window.__edUndoToast) window.__edUndoToast('已应用区域改写' + (stale ? '（' + stale + ' 段已变化跳过）' : ''), opId);
    preview = [];
    renderPreview([]);
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

  // 逐段确认：按 zid 游标取当前 pending 段 → 弹窗选 8 类（跳过 = 游标推进；取消 = 纯关闭）→ POST /zones 整条回写 → 下一段
  // 游标语义（S4a-F2）：state.pendQueue = 当前全部 pending zid（含游标），state.pendCursor = 具体 zid；
  // 每次打开弹窗按当前 pending 集合重排队列；游标 zid 已不在队列（被确认/删除）→ 顺移旧队列中的下一条；
  // 无游标或其后无存活段 → 从队头重启（「待确认分类 N 段」按钮即重新查看入口）；越过队尾 → 本轮结束不回绕。
  function rebuildPendQueue() {
    var zids = Object.keys(state.zones).filter(function (k) { return state.zones[k].status === 'pending'; });
    var cur = state.pendCursor, old = state.pendQueue;
    if (cur && zids.indexOf(cur) >= 0) { state.pendQueue = zids; return; }   // 续轮：游标仍有效，原地续看
    if (cur && old) {                                                        // 游标段被确认/删除 → 旧队列中其后第一条存活段
      var i = old.indexOf(cur);
      for (var j = i + 1; i >= 0 && j < old.length; j++) {
        if (zids.indexOf(old[j]) >= 0) { state.pendCursor = old[j]; state.pendQueue = zids; return; }
      }
    }
    state.pendCursor = zids[0] || null;                                      // 新一轮（或游标后无存活段）→ 从头
    state.pendQueue = zids;
  }
  function confirmNextPending() {
    rebuildPendQueue();
    var zid = state.pendCursor;
    if (!zid) return;
    var el = sheet.querySelector('[data-zid="' + zid + '"]');
    if (el) { el.scrollIntoView({ block: 'center' }); flash(el); }
    openPicker(zid, el ? (el.textContent || '').slice(0, 30) : '');
  }
  function openPicker(zid, preview) {
    var opener = document.activeElement;                  // F2：记录实际触发元素，关闭后焦点返回
    var mask = document.createElement('div');
    mask.className = 'zp-modal';
    mask.setAttribute('data-zone-panel', '1');          // 运行时标记（extract 第二道防线同款）
    var card = document.createElement('div');
    card.className = 'zp-card';
    card.setAttribute('data-zid', zid);
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
    var skip = document.createElement('button');
    skip.type = 'button'; skip.className = 'zp-skip'; skip.textContent = '跳过本段';
    skip.addEventListener('click', function () {
      var i = state.pendQueue.indexOf(zid);
      var next = i >= 0 ? state.pendQueue[i + 1] || null : null;
      if (next) {
        state.pendCursor = next;
        mask.remove();                    // 换段 = 旧弹窗直接退场（新弹窗 opener 指向已移除按钮，focus 空转无害）
        var el = sheet.querySelector('[data-zid="' + next + '"]');
        if (el) { el.scrollIntoView({ block: 'center' }); flash(el); }
        openPicker(next, el ? (el.textContent || '').slice(0, 30) : '');
      } else finishRound();
    });
    card.appendChild(skip);
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'zp-cancel'; cancel.textContent = '取消';
    cancel.addEventListener('click', closePicker);        // F2：取消 = 纯关闭，不再重开下一段
    card.appendChild(cancel);
    mask.appendChild(card);
    function closePicker() { mask.remove(); if (opener && opener.focus) opener.focus(); }
    function finishRound() {
      closePicker();
      var remain = Object.keys(state.zones).filter(function (k) { return state.zones[k].status === 'pending'; }).length;
      state.pendQueue = []; state.pendCursor = null;      // 本轮结束；重开 = 从头（#zp-pend 即重新查看入口）
      var note = document.getElementById('zp-round-note');
      if (note) note.remove();
      note = document.createElement('div');
      note.id = 'zp-round-note';
      note.className = 'zp-empty';
      note.textContent = '本轮已看完（' + remain + ' 段仍待确认分类）';
      root.appendChild(note);
    }
    // Esc 同效取消；Tab 圈定在弹窗内（复用 editor-shell trapTab 模式，zone-panel 内简版）
    mask.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
      if (e.key !== 'Tab') return;
      var focusables = card.querySelectorAll('button');
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) { if (e.target === mask) closePicker(); });
    cancel.focus();                                       // F2：初始聚焦取消按钮
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
    api('/zones?id=' + encodeURIComponent(DOC_ID), { zones: next }).then(load).catch(function () {});
  }

  load();
  // 外壳 Tab 切换到「区域」时刷新（shell 初绑 /zones/init 与本面板 load 并发，切 Tab 时拿最新落盘状态）
  window.addEventListener('ed-zone-refresh', load);
  // S3-T6：ed-zone-preview 是 renderPreview 的正式消费入口（rewrite fetch 回调与外部注入都走它；detail 优先，回落 __zpPreview）
  window.addEventListener('ed-zone-preview', function (e) {
    renderPreview((e && e.detail && e.detail.rewrites) || window.__zpPreview || []);
  });
})();
