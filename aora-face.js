// aora-face.js — <aora-bot> 状态化身助手（agent/interview/ai-helper 三页共用）。
// 动词→状态映射唯一口径；瞬时态 3s 回 idle；96↔28 缩放由 compact/show 驱动。
// 前置：<script src="/aora-bot.js"> 先注册 custom element；CSP script-src 'self' 已覆盖。
(function () {
  var MAP = {
    'agent':     { init: 'curious', idle: 'idle', send: 'thinking', tool: 'searching', stream: 'writing', done: 'happy',     error: 'alerting' },
    'interview': { init: 'idle',    idle: 'idle', send: 'thinking',                        stream: 'writing', 'wait-user': 'listening', done: 'celebrate', error: 'alerting' },
    'ai-helper': { init: 'idle',    idle: 'idle', send: 'working',                         stream: 'writing', done: 'happy',     error: 'confused'  }
  };
  var TRANSIENT_MS = 3000;
  var TRANSIENT = { happy: 1, celebrate: 1, alerting: 1, confused: 1 };
  var cssDone = false;
  function ensureCss() {
    if (cssDone) return; cssDone = true;
    var st = document.createElement('style');
    st.setAttribute('data-aora-face', '1');
    st.textContent = '.aora-host{position:relative}.aora-corner{position:absolute;top:10px;right:14px;z-index:6}.aora-slot{display:flex;align-items:center}';
    document.head.appendChild(st);
  }
  function mapOf(face) { return MAP[face.page] || MAP.agent; }
  function set(face, verb) {
    var st = mapOf(face)[verb];
    if (!st) return;
    face.verb = verb;
    if (face._t) { clearTimeout(face._t); face._t = 0; }
    face.el.setAttribute('state', st);
    if (TRANSIENT[st]) face._t = setTimeout(function () { face.el.setAttribute('state', mapOf(face).idle || 'idle'); face._t = 0; }, TRANSIENT_MS);
  }
  function mount(host, opts) {
    opts = opts || {};
    ensureCss();
    var slot = document.createElement('div');
    slot.className = 'aora-slot';
    var el = document.createElement('aora-bot');
    el.setAttribute('character', opts.character || 'dot');
    el.setAttribute('size', String(opts.size || 96));
    slot.appendChild(el);
    host.appendChild(slot);
    var face = { el: el, slot: slot, page: opts.page || 'agent', verb: '', _t: 0, cornerOf: opts.cornerOf || host };
    set(face, 'init');
    return face;
  }
  function compact(face) {
    // cornerOf 惰性解析：mount 时 .ag-main/.page-head 可能未建，compact 才需要它
    var host = typeof face.cornerOf === 'string' ? document.querySelector(face.cornerOf) : face.cornerOf;
    if (!host || !host.appendChild) return;
    host.classList.add('aora-host');
    var corner = host.querySelector('.aora-corner');
    if (!corner) { corner = document.createElement('div'); corner.className = 'aora-corner'; host.appendChild(corner); }
    corner.appendChild(face.slot);
    face.el.setAttribute('size', '28');
  }
  function show(face, host, sizePx) {
    if (!host || !host.appendChild) return;
    host.appendChild(face.slot);
    face.el.setAttribute('size', String(sizePx || 96));
  }
  window.AoraFace = { MAP: MAP, mount: mount, set: set, compact: compact, show: show };
})();
