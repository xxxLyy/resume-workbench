// jobs-panel.js — 社招职位页前端（classic script，零依赖；#jobs-app 内全 DOM 构建，禁 innerHTML、零字面色）
// 端点契约见 dev-docs/2026-11-19-upcv-port-jobs-match-design.md §2-§3：
//   GET /jobs/search、GET /jobs/dictionaries、POST /match/{job,recommend}、POST /jobs/apply-draft、POST /app/add。
// 「转入适配」复用 /job/create 建岗位草稿管线（服务端 /jobs/apply-draft 编排，jdSource 记 upcv 来源）；
// 「加入待投」走既有 /app/add 口径（status to_apply + jobId 透传，A3 已铺）；幂等 by jobId = BOOT.appJobIds 防重。
(function () {
  'use strict';
  var BOOT = (window.__JOBS__ || {});
  var app = document.getElementById('jobs-app');
  if (!app) return;

  var LEVEL_LABELS = { weak: '较弱', medium: '中等', strong: '较强', excellent: '极佳' };
  var LEVEL_COLORS = { weak: '--mut', medium: '--warn', strong: '--accent', excellent: '--ok' };
  var LEVEL_BGS = { weak: '--card-2', medium: '--warn-soft', strong: '--accent-soft', excellent: '--ok-soft' };
  var state = { tab: 'search', page: 1, jobs: [], total: 0, hasMore: false, dictLoaded: false };

  // ---- 小工具（口径同 talent-panel.js）----
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  var status = function (node, kind, text) {
    if (window.__status) { try { window.__status(node, kind, text); return; } catch (e) {} }
    node.textContent = text || '';
  };
  var api = function (method, url, body) {
    return fetch(url, {
      method: method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e) { d = null; }
        return { status: r.status, ok: r.ok, data: d, text: t };
      });
    });
  };

  // ---- 骨架：Tab 条 + 消息条 + 内容区 ----
  app.textContent = '';
  var msg = el('div');
  app.appendChild(msg);
  var tabs = el('nav');
  tabs.className = 'apptabs';
  tabs.setAttribute('aria-label', '职位');
  var tabDefs = [['search', '搜索'], ['recommend', '推荐']];
  var tabBtns = {};
  tabDefs.forEach(function (pair) {
    var a = el('a', '', pair[1]);
    a.href = '#' + pair[0];
    if (pair[0] === 'search') a.className = 'on';
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      state.tab = pair[0];
      tabDefs.forEach(function (q) { tabBtns[q[0]].className = q[0] === state.tab ? 'on' : ''; });
      renderTab();
    });
    tabBtns[pair[0]] = a;
    tabs.appendChild(a);
  });
  app.appendChild(tabs);
  var main = el('div');
  app.appendChild(main);

  var masterHint = function () {
    var c = el('div', 'card');
    c.style.padding = 'var(--space-4)';
    c.appendChild(el('p', '', '还没有母版简历。匹配与推荐都基于母版，先到「简历」页创建或导入一份。'));
    return c;
  };

  // ---- 职位卡 ----
  var jobCard = function (j, opts) {
    opts = opts || {};
    var jid = String(j.id || '');
    var card = el('div', 'card');
    card.style.padding = 'var(--space-4)';
    card.style.marginBottom = 'var(--space-3)';
    var head = el('div');
    head.style.display = 'flex';
    head.style.alignItems = 'baseline';
    head.style.justifyContent = 'space-between';
    head.style.gap = 'var(--space-2)';
    head.style.flexWrap = 'wrap';
    var t = el('b', '', String(j.title || '（未命名岗位）'));
    head.appendChild(t);
    if (opts.score != null) {
      head.appendChild(scoreBadge(opts.score, opts.level));
    }
    card.appendChild(head);
    var meta = el('div', '', [j.companyName || '（公司未披露）', j.locationDetail || '', j.salaryDisplay || ''].filter(Boolean).join(' · '));
    meta.style.color = 'var(--mut)';
    meta.style.fontSize = '13px';
    meta.style.margin = 'var(--space-1) 0';
    card.appendChild(meta);

    var ops = el('div');
    ops.style.display = 'flex';
    ops.style.gap = 'var(--space-2)';
    ops.style.marginTop = 'var(--space-2)';
    ops.style.flexWrap = 'wrap';

    if (!opts.recommendOnly) {
      var mBtn = el('button', 'secondary', 'AI 匹配度');
      mBtn.addEventListener('click', function () { doMatch(jid, j, mBtn); });
      ops.appendChild(mBtn);
      var adBtn = el('button', 'secondary', '转入适配');
      adBtn.addEventListener('click', function () { doApplyDraft(jid, adBtn); });
      ops.appendChild(adBtn);
      var apBtn = el('button', 'secondary', BOOT.appJobIds && BOOT.appJobIds.indexOf(jid) >= 0 ? '已在待投' : '加入待投');
      apBtn.disabled = !!(BOOT.appJobIds && BOOT.appJobIds.indexOf(jid) >= 0) || !BOOT.master;
      apBtn.addEventListener('click', function () { doAddApp(jid, j, apBtn); });
      ops.appendChild(apBtn);
    } else {
      var dBtn = el('button', 'secondary', '查看匹配详情');
      dBtn.addEventListener('click', function () { doMatch(jid, j, dBtn); });
      ops.appendChild(dBtn);
    }
    card.appendChild(ops);
    return card;
  };

  var scoreBadge = function (score, level) {
    var b = el('span', '', (LEVEL_LABELS[level] || '未知') + ' ' + score);
    b.style.color = 'var(' + (LEVEL_COLORS[level] || '--mut') + ')';
    b.style.background = 'var(' + (LEVEL_BGS[level] || '--card-2') + ')';
    b.style.borderRadius = '999px';
    b.style.padding = '2px 10px';
    b.style.fontSize = '12px';
    b.style.fontWeight = '600';
    return b;
  };

  // ---- 匹配结果卡（搜索与推荐共用；「AI 参考」诚信字样）----
  var matchResultCard = function (m) {
    var card = el('div', 'card');
    card.style.padding = 'var(--space-4)';
    card.style.marginBottom = 'var(--space-3)';
    var top = el('div');
    top.style.display = 'flex';
    top.style.alignItems = 'center';
    top.style.gap = 'var(--space-3)';
    var big = el('b', '', String(m.matchScore));
    big.style.fontSize = '26px';
    big.style.color = 'var(' + (LEVEL_COLORS[m.matchLevel] || '--mut') + ')';
    top.appendChild(big);
    top.appendChild(el('span', '', '匹配度 ' + (LEVEL_LABELS[m.matchLevel] || m.matchLevel) + ' · AI 参考评估'));
    top.lastChild.style.color = 'var(--mut)';
    top.lastChild.style.fontSize = '13px';
    card.appendChild(top);
    if (m.headline) {
      var hl = el('p', '', m.headline);
      hl.style.margin = 'var(--space-2) 0';
      hl.style.fontWeight = '600';
      card.appendChild(hl);
    }
    var cols = el('div');
    cols.style.display = 'flex';
    cols.style.gap = 'var(--space-4)';
    cols.style.marginTop = 'var(--space-2)';
    var mk = function (label, items, colorVar) {
      var box = el('div');
      box.style.flex = '1';
      box.style.border = '1px solid var(--line)';
      box.style.borderRadius = 'var(--radius)';
      box.style.padding = 'var(--space-3)';
      var h = el('b', '', label);
      h.style.color = 'var(' + colorVar + ')';
      box.appendChild(h);
      var ul = el('ul');
      ul.style.margin = 'var(--space-2) 0 0';
      ul.style.paddingLeft = '18px';
      ul.style.fontSize = '13px';
      (items || []).forEach(function (s) {
        var li = el('li', '', s);
        li.style.marginBottom = 'var(--space-1)';
        ul.appendChild(li);
      });
      if (!items || !items.length) ul.appendChild(el('li', '', '（无）'));
      box.appendChild(ul);
      return box;
    };
    cols.appendChild(mk('匹配点', m.strengths, '--ok'));
    cols.appendChild(mk('差距点', m.gaps, '--warn'));
    card.appendChild(cols);
    if (m.resumeSuggestions && m.resumeSuggestions.length) {
      card.appendChild(el('b', '', '简历调整建议'));
      card.lastChild.style.display = 'block';
      card.lastChild.style.marginTop = 'var(--space-3)';
      var ul = el('ul');
      ul.style.margin = 'var(--space-2) 0 0';
      ul.style.paddingLeft = '18px';
      ul.style.fontSize = '13px';
      m.resumeSuggestions.forEach(function (s) {
        var li = el('li', '', s);
        li.style.marginBottom = 'var(--space-1)';
        ul.appendChild(li);
      });
      card.appendChild(ul);
    }
    return card;
  };

  // ---- 动作 ----
  var doMatch = function (jid, j, btn) {
    if (!BOOT.master) { status(msg, 'err', '先创建或导入一份母版简历，匹配基于母版'); return; }
    btn.disabled = true;
    btn.textContent = '匹配中…';
    api('POST', '/match/job', { docId: BOOT.master.id, jobId: jid }).then(function (r) {
      btn.disabled = false;
      btn.textContent = 'AI 匹配度';
      if (r.status === 409) { status(msg, 'err', '未配置大模型，去 /settings 完成配置后再匹配。'); return; }
      if (!r.ok || !r.data || !r.data.ok) { status(msg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status)); return; }
      var holder = el('div');
      holder.style.marginTop = 'var(--space-3)';
      holder.appendChild(matchResultCard(r.data.match));
      var back = el('button', 'secondary', '返回职位列表');
      back.addEventListener('click', function () { renderTab(); });
      holder.appendChild(back);
      main.textContent = '';
      main.appendChild(holder);
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = 'AI 匹配度';
      status(msg, 'err', '请求失败：' + (e && e.message ? e.message : e));
    });
  };

  var doApplyDraft = function (jid, btn) {
    if (!BOOT.master) { status(msg, 'err', '先创建或导入一份母版简历，岗位草稿基于母版创建'); return; }
    btn.disabled = true;
    btn.textContent = '创建中…';
    api('POST', '/jobs/apply-draft', { jobId: jid, from: BOOT.master.id }).then(function (r) {
      btn.disabled = false;
      btn.textContent = '转入适配';
      if (!r.ok || !r.data || !r.data.ok) {
        // 同岗位草稿已存在（createJobDraft 查重 409 + existing）：幂等跳既有草稿，不另建
        if (r.data && r.data.existing) { window.location.href = '/edit?id=' + encodeURIComponent(r.data.existing); return; }
        status(msg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status));
        return;
      }
      if (r.data.id) { window.location.href = '/edit?id=' + encodeURIComponent(r.data.id); return; }
      status(msg, 'ok', '岗位草稿已创建');
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = '转入适配';
      status(msg, 'err', '请求失败：' + (e && e.message ? e.message : e));
    });
  };

  var doAddApp = function (jid, j, btn) {
    if (!BOOT.master) return;
    btn.disabled = true;
    btn.textContent = '加入中…';
    api('POST', '/app/add', {
      docId: BOOT.master.id,
      company: String(j.companyName || '').trim() || '未命名公司',
      role: String(j.title || '').trim() || '未命名岗位',
      link: typeof j.detailUrl === 'string' ? j.detailUrl : (typeof j.applyLink === 'string' ? j.applyLink : ''),
      jobId: jid,
      status: 'to_apply'
    }).then(function (r) {
      if (!r.ok || !r.data || !r.data.ok) {
        btn.disabled = false;
        btn.textContent = '加入待投';
        status(msg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status));
        return;
      }
      btn.textContent = '已在待投';
      if (BOOT.appJobIds && BOOT.appJobIds.indexOf(jid) < 0) BOOT.appJobIds.push(jid);
      status(msg, 'ok', '已加入待投（/applications 看板可见）');
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = '加入待投';
      status(msg, 'err', '请求失败：' + (e && e.message ? e.message : e));
    });
  };

  // ---- 搜索 Tab ----
  var searchBox = null, kwInput = null, citySel = null, fnSel = null, cityLab = null, fnLab = null, listBox = null, pager = null;
  // 字典宽容扁平化：真实上游 grouped 结构未完全逆向——递归收集一切带数字 id + name 的节点，
  // 解析不出就静默不显示下拉（降级不炸页）；上限 200 防巨型字典拖死 DOM。
  var walkOptions = function (node, out, depth) {
    if (!node || typeof node !== 'object' || out.length >= 200 || depth > 6) return;
    if (Array.isArray(node)) { node.forEach(function (n) { walkOptions(n, out, depth + 1); }); return; }
    var id = node.id, name = node.name || node.label;
    if (typeof id === 'number' && (typeof name === 'string' && name)) out.push([String(id), name]);
    Object.keys(node).forEach(function (k) {
      if (k === 'name' || k === 'label') return;
      walkOptions(node[k], out, depth + 1);
    });
  };
  var fillDict = function (sel, data, label) {
    var opts = [];
    walkOptions(data, opts, 0);
    if (!opts.length) return false;
    var all = el('option', '', '全部' + label);
    all.value = '';
    sel.appendChild(all);
    opts.forEach(function (pair) {
      var o = el('option', '', pair[1]);
      o.value = pair[0];
      sel.appendChild(o);
    });
    return true;
  };
  var loadDicts = function () {
    if (state.dictLoaded) return;
    state.dictLoaded = true;
    api('GET', '/jobs/dictionaries').then(function (r) {
      if (!r.ok || !r.data || !r.data.ok) return;   // 静默降级：字典不可用不挡搜索
      if (citySel && fillDict(citySel, r.data.cities, '城市')) { citySel.style.display = ''; if (cityLab) cityLab.style.display = ''; }
      if (fnSel && fillDict(fnSel, r.data.functions, '职能')) { fnSel.style.display = ''; if (fnLab) fnLab.style.display = ''; }
    }).catch(function () {});
  };

  var renderSearch = function () {
    main.textContent = '';
    if (!searchBox) {
      searchBox = el('div', 'card');
      searchBox.style.padding = 'var(--space-4)';
      searchBox.style.marginBottom = 'var(--space-3)';
      var row = el('div');
      row.style.display = 'flex';
      row.style.gap = 'var(--space-2)';
      row.style.flexWrap = 'wrap';
      row.style.alignItems = 'center';
      kwInput = el('input');
      kwInput.type = 'search';
      kwInput.placeholder = '关键词（职位/公司/技能）';
      kwInput.style.border = '1px solid var(--line)';
      kwInput.style.borderRadius = 'var(--radius)';
      kwInput.style.padding = '6px 10px';
      kwInput.style.background = 'var(--panel)';
      kwInput.style.width = '240px';
      citySel = el('select');
      fnSel = el('select');
      // 直序构建：关键词 → 城市 → 职能 → 搜索按钮（label/select 均 display:none 起步，字典加载成功才显示）
      var mkSel = function (label, sel) {
        var lab = el('label', '', label);
        lab.style.display = 'none';
        lab.style.fontSize = '12px';
        lab.style.color = 'var(--mut)';
        sel.style.display = 'none';
        sel.style.border = '1px solid var(--line)';
        sel.style.borderRadius = 'var(--radius)';
        sel.style.padding = '6px 8px';
        sel.style.background = 'var(--panel)';
        return { lab: lab, sel: sel };
      };
      var cityPair = mkSel('城市', citySel), fnPair = mkSel('职能', fnSel);
      var goBtn = el('button', '', '搜索职位');
      goBtn.addEventListener('click', function () { state.page = 1; runSearch(); });
      kwInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { state.page = 1; runSearch(); } });
      row.appendChild(kwInput);
      row.appendChild(cityPair.lab); row.appendChild(cityPair.sel);
      row.appendChild(fnPair.lab); row.appendChild(fnPair.sel);
      row.appendChild(goBtn);
      cityLab = cityPair.lab; fnLab = fnPair.lab;
      searchBox.appendChild(row);
      listBox = el('div');
      pager = el('div');
    }
    main.appendChild(searchBox);
    main.appendChild(listBox);
    main.appendChild(pager);
    if (!state.jobs.length) {
      var hint = el('p', '', '输入关键词搜索 UPCV 社招职位库；选中职位可做 AI 匹配、转入适配或加入待投。');
      hint.style.color = 'var(--mut)';
      hint.style.fontSize = '13px';
      listBox.appendChild(hint);
    }
    loadDicts();
  };

  var runSearch = function () {
    var qs = new URLSearchParams();
    qs.set('jobType', 'SOCIAL');
    if (kwInput.value) qs.set('search', kwInput.value);
    if (citySel.value) qs.set('cityIds', citySel.value);
    if (fnSel.value) qs.set('functionIds', fnSel.value);
    qs.set('page', String(state.page));
    qs.set('limit', '10');
    msg.textContent = '搜索中…';   // __status 图标只有 ok/warn/err 三档，进行中提示用纯文字
    api('GET', '/jobs/search?' + qs.toString()).then(function (r) {
      msg.textContent = '';
      if (!r.ok || !r.data || !r.data.ok) { status(msg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status)); return; }
      state.jobs = r.data.items || [];
      state.total = r.data.total || 0;
      state.hasMore = !!r.data.hasMore;
      renderResults();
    }).catch(function (e) { status(msg, 'err', '请求失败：' + (e && e.message ? e.message : e)); });
  };

  var renderResults = function () {
    renderSearch();
    listBox.textContent = '';
    pager.textContent = '';
    if (!state.jobs.length) {
      var empty = el('p', '', '没有搜到职位，换个关键词试试。');
      empty.style.color = 'var(--mut)';
      listBox.appendChild(empty);
      return;
    }
    state.jobs.forEach(function (j) { listBox.appendChild(jobCard(j)); });
    var row = el('div');
    row.style.display = 'flex';
    row.style.gap = 'var(--space-2)';
    row.style.marginTop = 'var(--space-3)';
    if (state.page > 1) {
      var prev = el('button', 'secondary', '上一页');
      prev.addEventListener('click', function () { state.page -= 1; runSearch(); });
      row.appendChild(prev);
    }
    row.appendChild(el('span', '', '第 ' + state.page + ' 页 · 共 ' + state.total + ' 条'));
    row.lastChild.style.color = 'var(--mut)';
    row.lastChild.style.fontSize = '13px';
    row.lastChild.style.alignSelf = 'center';
    if (state.hasMore) {
      var next = el('button', 'secondary', '下一页');
      next.addEventListener('click', function () { state.page += 1; runSearch(); });
      row.appendChild(next);
    }
    pager.appendChild(row);
  };

  // ---- 推荐 Tab ----
  var renderRecommend = function () {
    main.textContent = '';
    var card = el('div', 'card');
    card.style.padding = 'var(--space-4)';
    if (!BOOT.hasPreference) {
      card.appendChild(el('p', '', '还没有保存求职偏好。推荐按偏好（城市/职能/薪资）筛选社招职位并逐岗计算匹配度。'));
      var a = el('a', '', '去「求职画像」页填写偏好 →');
      a.href = '/talent';
      card.appendChild(a);
      main.appendChild(card);
      return;
    }
    if (!BOOT.master) { main.appendChild(masterHint()); return; }
    var btn = el('button', '', '按偏好推荐');
    btn.addEventListener('click', function () { runRecommend(btn); });
    card.appendChild(btn);
    card.appendChild(el('span', '', ' 取偏好里的城市/职能/薪资筛社招岗，逐岗算 AI 匹配度后按分数排序（AI 参考）'));
    card.lastChild.style.color = 'var(--mut)';
    card.lastChild.style.fontSize = '12px';
    main.appendChild(card);
    var holder = el('div');
    holder.style.marginTop = 'var(--space-3)';
    main.appendChild(holder);
    state.recHolder = holder;
  };

  var runRecommend = function (btn) {
    btn.disabled = true;
    btn.textContent = '推荐中…（逐岗匹配可能要等一会儿）';
    api('POST', '/match/recommend', { limit: 12 }).then(function (r) {
      btn.disabled = false;
      btn.textContent = '按偏好推荐';
      if (r.status === 409) { status(msg, 'err', '未配置大模型，去 /settings 完成配置后再推荐。'); return; }
      if (!r.ok || !r.data || !r.data.ok) { status(msg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status)); return; }
      var holder = state.recHolder;
      holder.textContent = '';
      var items = r.data.items || [];
      if (!items.length) {
        var empty = el('p', '', '按偏好没有筛到职位，可放宽偏好（城市/职能/薪资）后再试。');
        empty.style.color = 'var(--mut)';
        holder.appendChild(empty);
        return;
      }
      items.forEach(function (j) {
        holder.appendChild(jobCard(j, { recommendOnly: true, score: j.matchScore, level: j.matchLevel }));
      });
    }).catch(function (e) {
      btn.disabled = false;
      btn.textContent = '按偏好推荐';
      status(msg, 'err', '请求失败：' + (e && e.message ? e.message : e));
    });
  };

  var renderTab = function () {
    msg.textContent = '';
    if (state.tab === 'search') { renderSearch(); return; }
    renderRecommend();
  };
  renderTab();
})();
