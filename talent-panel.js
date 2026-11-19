// talent-panel.js — 求职画像 + 偏好页前端（classic script，零依赖；#talent-app 内全 DOM 构建，禁 innerHTML）
// 端点契约见 dev-docs/2026-11-19-upcv-port-talent-design.md：GET /talent/profile、POST /talent/{generate,refresh}、
// GET /preference/state、PUT /preference。状态条用 page() 下发的 window.__status(el, kind, text)。
(function () {
  'use strict';
  var BOOT = (window.__TALENT__ || {});
  var app = document.getElementById('talent-app');
  if (!app) return;

  var COMPANY_LABELS = {
    CENTRAL_SOE: '央企', STATE_OWNED: '国企', PUBLIC_INSTITUTION: '事业单位', LISTED: '上市公司',
    FOREIGN: '外企', JV: '合资', PRIVATE: '民企', STARTUP: '创业公司'
  };
  var COMPANY_ORDER = ['CENTRAL_SOE', 'STATE_OWNED', 'PUBLIC_INSTITUTION', 'LISTED', 'FOREIGN', 'JV', 'PRIVATE', 'STARTUP'];
  var JOB_TYPE_LABELS = { SOCIAL: '社招', INTERNSHIP: '实习' };
  var STATUS_LABELS = { actively_looking: '在看机会', open_to_offers: '机会合适会考虑', not_looking: '暂不看机会' };
  var AVAILABILITY = ['随时', '1周内', '1个月内', '1-3个月', '3个月以上', '待定'];

  // ---- 小工具 ----
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

  // ---- 画像区 ----
  var profileBox = el('section');
  profileBox.style.marginBottom = 'var(--space-6)';
  var profileMsg = el('div');
  var prefBox = el('section');
  var prefMsg = el('div');
  app.textContent = '';
  app.appendChild(profileBox);
  app.appendChild(prefBox);

  var renderProfile = function (p) {
    profileBox.textContent = '';
    var card = el('div', 'card');
    card.style.padding = 'var(--space-4)';
    var head = el('div');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.justifyContent = 'space-between';
    head.style.gap = 'var(--space-2)';
    var title = el('h2', '', '求职画像');
    title.style.margin = '0';
    title.style.fontSize = '15px';
    head.appendChild(title);

    if (!p) {
      var hint = el('p', '', BOOT.hasLLM ? '还没有生成过求职画像。画像 = 经历时间线 + 求职方向 + 竞争力参考评分，基于母版简历由大模型生成。'
        : '还没有生成过求职画像。生成前需先在设置页配置大模型。');
      hint.style.color = 'var(--mut)';
      hint.style.fontSize = '13px';
      var btn = el('button', '', '生成我的求职画像');
      btn.style.marginTop = 'var(--space-3)';
      btn.addEventListener('click', function () { go(false); });
      card.appendChild(head);
      card.appendChild(hint);
      if (!BOOT.hasLLM) {
        var warn = el('p', '', '未配置大模型，去 /settings 完成配置后再生成。');
        warn.style.color = 'var(--warn)';
        warn.style.fontSize = '12px';
        card.appendChild(warn);
      }
      card.appendChild(btn);
      profileBox.appendChild(card);
      return;
    }

    // 有画像：headline + 刷新 + 5 级条 + strengths/gaps + timeline + directions
    var refreshBtn = el('button', 'secondary', '刷新画像');
    refreshBtn.addEventListener('click', function () { go(true); });
    head.appendChild(refreshBtn);
    card.appendChild(head);

    var hl = el('p', '', p.headline || '（无一句话定位）');
    hl.style.margin = 'var(--space-3) 0 var(--space-2)';
    hl.style.fontWeight = '600';
    card.appendChild(hl);

    var comp = p.competitiveness || {};
    var lvl = Number(comp.level) || 0;
    var total = Number(comp.total) || 5;
    var compRow = el('div');
    compRow.style.display = 'flex';
    compRow.style.alignItems = 'center';
    compRow.style.gap = 'var(--space-2)';
    compRow.style.margin = 'var(--space-2) 0';
    var bar = el('div');
    bar.style.display = 'flex';
    bar.style.gap = 'var(--space-hair)';
    for (var i = 1; i <= total; i++) {
      var seg = el('span');
      seg.style.display = 'inline-block';
      seg.style.width = '18px';
      seg.style.height = '8px';
      seg.style.borderRadius = 'var(--radius)';
      seg.style.background = i <= lvl ? 'var(--accent)' : 'var(--card-2)';
      bar.appendChild(seg);
    }
    compRow.appendChild(bar);
    compRow.appendChild(el('span', '', (comp.label ? comp.label + ' · ' : '') + lvl + '/' + total));
    compRow.appendChild(el('span', '', 'AI 参考评分'));
    compRow.lastChild.style.color = 'var(--mut)';
    compRow.lastChild.style.fontSize = '12px';
    card.appendChild(compRow);

    var cols = el('div');
    cols.style.display = 'flex';
    cols.style.gap = 'var(--space-4)';
    cols.style.margin = 'var(--space-3) 0';
    var mk = function (label, items, colorVar, softVar) {
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
    cols.appendChild(mk('优势', comp.strengths, '--ok', '--ok-soft'));
    cols.appendChild(mk('短板', comp.gaps, '--warn', '--warn-soft'));
    card.appendChild(cols);

    if (p.timeline && p.timeline.length) {
      var th = el('b', '', '经历时间线');
      th.style.display = 'block';
      th.style.marginTop = 'var(--space-3)';
      card.appendChild(th);
      var tl = el('div');
      tl.style.borderLeft = '2px solid var(--line)';
      tl.style.margin = 'var(--space-2) 0 0 var(--space-2)';
      tl.style.paddingLeft = 'var(--space-3)';
      p.timeline.forEach(function (t) {
        var row = el('div');
        row.style.marginBottom = 'var(--space-2)';
        row.style.fontSize = '13px';
        var when = el('div', '', t.period || '');
        when.style.color = 'var(--mut)';
        when.style.fontSize = '12px';
        row.appendChild(when);
        row.appendChild(el('div', '', (t.title || '') + (t.org ? ' · ' + t.org : '')));
        tl.appendChild(row);
      });
      card.appendChild(tl);
    }

    if (p.directions && p.directions.length) {
      var dh = el('b', '', '求职方向（置信度）');
      dh.style.display = 'block';
      dh.style.marginTop = 'var(--space-3)';
      card.appendChild(dh);
      var cloud = el('div');
      cloud.style.display = 'flex';
      cloud.style.flexWrap = 'wrap';
      cloud.style.gap = 'var(--space-2)';
      cloud.style.marginTop = 'var(--space-2)';
      p.directions.forEach(function (d) {
        var tag = el('span', '', d.name + '（' + d.confidence + '）');
        tag.style.border = '1px solid var(--line)';
        tag.style.borderRadius = '999px';
        tag.style.padding = '2px 10px';
        tag.style.fontSize = '12px';
        tag.style.background = 'var(--accent-soft)';
        cloud.appendChild(tag);
        if (d.reason) {
          var r = el('span', '', d.reason);
          r.style.fontSize = '12px';
          r.style.color = 'var(--mut)';
          r.style.alignSelf = 'center';
          cloud.appendChild(r);
        }
      });
      card.appendChild(cloud);
    }
    if (p.generatedAt) {
      var at = el('p', '', '生成于 ' + p.generatedAt + (p.sourceDocId ? ' · 依据母版 ' + p.sourceDocId : '') + ' · 评分与方向为 AI 参考输出');
      at.style.color = 'var(--mut)';
      at.style.fontSize = '12px';
      at.style.margin = 'var(--space-3) 0 0';
      card.appendChild(at);
    }
    profileBox.appendChild(card);
  };

  var go = function (isRefresh) {
    var btns = profileBox.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) { btns[i].disabled = true; btns[i].textContent = isRefresh ? '刷新中…' : '生成中…'; }
    api('POST', isRefresh ? '/talent/refresh' : '/talent/generate').then(function (r) {
      if (r.status === 409) { status(profileMsg, 'err', '未配置大模型，去 /settings 完成配置后再' + (isRefresh ? '刷新' : '生成') + '。'); return; }
      if (!r.ok || !r.data || !r.data.ok) {
        status(profileMsg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status));
        return;
      }
      status(profileMsg, 'ok', isRefresh ? '人才画像已刷新' : '人才画像生成成功');
      renderProfile(r.data.profile);
    }).catch(function (e) {
      status(profileMsg, 'err', '请求失败：' + (e && e.message ? e.message : e));
    });
  };

  // ---- 偏好运 ----
  var prefForm = null;
  var renderPrefForm = function (q) {
    q = q || {};
    prefBox.textContent = '';
    var card = el('div', 'card');
    card.style.padding = 'var(--space-4)';
    var h = el('h2', '', '求职偏好');
    h.style.margin = '0 0 var(--space-3)';
    h.style.fontSize = '15px';
    card.appendChild(h);
    prefForm = el('div');

    var row = function (labelText) {
      var r = el('div');
      r.style.marginBottom = 'var(--space-3)';
      var lab = el('div', '', labelText);
      lab.style.fontSize = '13px';
      lab.style.marginBottom = 'var(--space-1)';
      r.appendChild(lab);
      prefForm.appendChild(r);
      return r;
    };

    // 求职类型（社招/实习；校招枚举位保留但不提供勾选——用户已剔除校招）
    var jtRow = row('求职类型');
    var jtBox = el('div');
    jtBox.style.display = 'flex';
    jtBox.style.gap = 'var(--space-4)';
    var jtChecks = {};
    ['SOCIAL', 'INTERNSHIP'].forEach(function (k) {
      var wrap = el('label');
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = 'var(--space-1)';
      wrap.style.fontSize = '13px';
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!(q.jobTypes && q.jobTypes.indexOf(k) >= 0);
      jtChecks[k] = cb;
      wrap.appendChild(cb);
      wrap.appendChild(el('span', '', JOB_TYPE_LABELS[k]));
      jtBox.appendChild(wrap);
    });
    jtRow.appendChild(jtBox);

    // 求职状态
    var stRow = row('求职状态');
    var stSel = el('select');
    stSel.style.border = '1px solid var(--line)';
    stSel.style.borderRadius = 'var(--radius)';
    stSel.style.padding = '4px 8px';
    stSel.style.background = 'var(--panel)';
    Object.keys(STATUS_LABELS).forEach(function (k) {
      var opt = el('option', '', STATUS_LABELS[k]);
      opt.value = k;
      if (q.status === k) opt.selected = true;
      stSel.appendChild(opt);
    });
    stRow.appendChild(stSel);

    // 期望薪资（K）
    var salRow = row('期望薪资（单位 K，月薪）');
    var salBox = el('div');
    salBox.style.display = 'flex';
    salBox.style.alignItems = 'center';
    salBox.style.gap = 'var(--space-2)';
    var salMin = el('input');
    salMin.type = 'number';
    salMin.min = '0';
    salMin.placeholder = '下限';
    salMin.value = q.salary && q.salary.min != null ? q.salary.min : '';
    salMin.style.width = '90px';
    var salMax = el('input');
    salMax.type = 'number';
    salMax.min = '0';
    salMax.placeholder = '上限';
    salMax.value = q.salary && q.salary.max != null ? q.salary.max : '';
    salMax.style.width = '90px';
    [salMin, salMax].forEach(function (inp) {
      inp.style.border = '1px solid var(--line)';
      inp.style.borderRadius = 'var(--radius)';
      inp.style.padding = '4px 8px';
      inp.style.background = 'var(--panel)';
    });
    salBox.appendChild(salMin);
    salBox.appendChild(el('span', '', '—'));
    salBox.appendChild(salMax);
    salBox.appendChild(el('span', '', 'K'));
    salRow.appendChild(salBox);

    // 城市/行业/职能（A2 字典未落地：逗号分隔的数字 id 占位输入，A2 接 /jobs 字典后升级 select）
    var idInputs = {};
    [['cityIds', '意向城市'], ['industryIds', '意向行业'], ['functionIds', '意向职能']].forEach(function (pair) {
      var r = row(pair[1] + '（数字 id，逗号分隔；字典接入后升级为选择）');
      var inp = el('input');
      inp.type = 'text';
      inp.placeholder = '如 1,2';
      inp.value = (q[pair[0]] || []).join(',');
      inp.style.border = '1px solid var(--line)';
      inp.style.borderRadius = 'var(--radius)';
      inp.style.padding = '4px 8px';
      inp.style.width = '260px';
      inp.style.background = 'var(--panel)';
      idInputs[pair[0]] = inp;
      r.appendChild(inp);
    });

    // 公司类型 8 类
    var ctRow = row('公司类型');
    var ctBox = el('div');
    ctBox.style.display = 'flex';
    ctBox.style.flexWrap = 'wrap';
    ctBox.style.gap = 'var(--space-2)';
    var ctChecks = {};
    COMPANY_ORDER.forEach(function (k) {
      var wrap = el('label');
      wrap.style.display = 'inline-flex';
      wrap.style.alignItems = 'center';
      wrap.style.gap = 'var(--space-1)';
      wrap.style.fontSize = '13px';
      var cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!(q.companyTypes && q.companyTypes.indexOf(k) >= 0);
      ctChecks[k] = cb;
      wrap.appendChild(cb);
      wrap.appendChild(el('span', '', COMPANY_LABELS[k]));
      ctBox.appendChild(wrap);
    });
    ctRow.appendChild(ctBox);

    // 到岗时间
    var avRow = row('到岗时间');
    var avSel = el('select');
    avSel.style.border = '1px solid var(--line)';
    avSel.style.borderRadius = 'var(--radius)';
    avSel.style.padding = '4px 8px';
    avSel.style.background = 'var(--panel)';
    AVAILABILITY.forEach(function (a) {
      var opt = el('option', '', a);
      opt.value = a;
      if (q.availability === a) opt.selected = true;
      avSel.appendChild(opt);
    });
    avRow.appendChild(avSel);

    card.appendChild(prefForm);
    var actions = el('div');
    actions.style.display = 'flex';
    actions.style.alignItems = 'center';
    actions.style.gap = 'var(--space-3)';
    var saveBtn = el('button', '', '保存求职偏好');
    saveBtn.addEventListener('click', function () {
      saveBtn.disabled = true;
      var body = {};
      var jts = ['SOCIAL', 'INTERNSHIP'].filter(function (k) { return jtChecks[k].checked; });
      if (jts.length) body.jobTypes = jts;
      if (stSel.value) body.status = stSel.value;
      var mn = salMin.value === '' ? undefined : Number(salMin.value);
      var mx = salMax.value === '' ? undefined : Number(salMax.value);
      var sal = {};
      if (mn !== undefined && !Number.isNaN(mn)) sal.min = mn;
      if (mx !== undefined && !Number.isNaN(mx)) sal.max = mx;
      if (salMin.value !== '' || salMax.value !== '') { sal.unit = 'K'; body.salary = sal; }
      ['cityIds', 'industryIds', 'functionIds'].forEach(function (k) {
        var nums = String(idInputs[k].value || '').split(/[，,]/).map(function (s) { return s.trim(); })
          .filter(Boolean).map(Number).filter(function (n) { return Number.isFinite(n); });
        if (nums.length) body[k] = nums;
      });
      var cts = COMPANY_ORDER.filter(function (k) { return ctChecks[k].checked; });
      if (cts.length) body.companyTypes = cts;
      if (avSel.value) body.availability = avSel.value;
      if (typeof q.allowContact === 'boolean') body.allowContact = q.allowContact;   // 保留字段不展示，回读有则原样带回
      api('PUT', '/preference', body).then(function (r) {
        saveBtn.disabled = false;
        if (!r.ok || !r.data || !r.data.ok) { status(prefMsg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status)); return; }
        status(prefMsg, 'ok', '求职偏好已保存');
        renderPrefForm(r.data.preference);
      }).catch(function (e) {
        saveBtn.disabled = false;
        status(prefMsg, 'err', '请求失败：' + (e && e.message ? e.message : e));
      });
    });
    actions.appendChild(saveBtn);
    card.appendChild(actions);
    card.appendChild(prefMsg);
    prefBox.appendChild(card);
  };

  // ---- 启动：并行拉画像 + 偏好 ----
  api('GET', '/talent/profile').then(function (r) {
    if (!r.ok || !r.data || !r.data.ok) {
      profileBox.textContent = '';
      var c = el('div', 'card');
      c.style.padding = 'var(--space-4)';
      status(profileMsg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status));
      c.appendChild(profileMsg);
      profileBox.appendChild(c);
      return;
    }
    profileBox.textContent = '';
    profileBox.appendChild(profileMsg);
    renderProfile(r.data.profile);
  }).catch(function () {
    profileBox.textContent = '';
    var c = el('div', 'card');
    c.style.padding = 'var(--space-4)';
    profileBox.appendChild(c);
  });
  api('GET', '/preference/state').then(function (r) {
    prefBox.textContent = '';
    prefBox.appendChild(prefMsg);
    if (!r.ok || !r.data || !r.data.ok) { status(prefMsg, 'err', (r.data && r.data.error) || ('HTTP ' + r.status)); return; }
    renderPrefForm(r.data.preference);
  }).catch(function () {
    prefBox.textContent = '';
    var c = el('div', 'card');
    c.style.padding = 'var(--space-4)';
    prefBox.appendChild(c);
  });
})();
