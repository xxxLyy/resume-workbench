// editor-shell.js — 编辑器外壳（A 方向：清爽专业＋轻立体三栏）
// 由 server /edit 幂等注入（SHELL-INJECT 注释对），/save 随注释对剥离，落盘文档零污染
// 布局：body 级 CSS Grid，.sheet 不移动 DOM（光标/选区/AI 定位零风险）；缩放用 zoom（布局级，caret 正确）
(function () {
  var DOC_ID = document.currentScript.getAttribute('data-doc');
  // 初始磁盘 mtime 暴露给模板保存状态机（多标签冲突检测的基线）
  window.__edDocMtime = Number(document.currentScript.getAttribute('data-mtime') || 0);
  var sheet = document.querySelector('.sheet');
  // 首页「继续上次任务」数据源 = 最近访问（mtime ≠ 最近访问，故用本地键；不进 docs-meta）
  try { localStorage.setItem('resume-last-active-doc', DOC_ID); } catch (e) { /* 隐私模式下忽略 */ }
  if (!sheet) return;
  // 图标：服务端把 SVG 随页面下发（vendors/icons.mjs 是唯一来源，客户端不自己拼 SVG）；
  // 没有注入时（直接打开文档文件）降级为空串 —— 不炸，也不显示图标。
  var __icon = window.__icon || function () { return ''; };
  var __status = window.__status || function (el, kind, text) { if (el) el.textContent = text; };
  var escHtml = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  // 幂等：清掉历史落盘/重复注入的外壳 DOM 与样式后重建（落盘残留无事件绑定，复用会是死 UI）
  ['ed-left', 'ed-right', 'ed-grip', 'ed-status', 'ed-canvas-tools', 'ed-seltb', 'ed-matpop', 'ed-matmask'].forEach(function (id) {
    var stale = document.getElementById(id);
    if (stale) stale.remove();
  });
  document.querySelectorAll('style[data-ed-shell]').forEach(function (el) { el.remove(); });

  var MM = 3.7795275591;
  var SHEET_W = 210 * MM;   // 794px
  var SHEET_H = 297 * MM;   // 1123px
  var MATS = Array.isArray(window.__MATS__) ? window.__MATS__ : [];
  var JOB_INFO = window.__JOB_INFO__ || { hasJob: false };
  // CSS Custom Highlight API：高亮只存在于内存 Range，不改 DOM → 瞬态天然不落盘（flashEl 与查找高亮共用）
  var HL_OK = typeof window.Highlight === 'function' && !!(window.CSS && CSS.highlights);
  var flashHl = null;

  // ===== 设计令牌 + 外壳样式（仅屏幕；print 一律隐藏外壳、还原文档流）=====
  // 字号档位（两区共用角色梯度）：11=辅助注/角标/状态栏/图标钮；12=紧凑控件与元数据；
  // 13=面板正文与输入；14=应用正文与页面级按钮。--ed-radius:8px=控件档圆角
  // （弹层容器大圆角 10/12/14 与胶囊 999 不在控件档）。
  var css = document.createElement('style');
  css.setAttribute('data-ed-shell', '1');
  css.textContent = '@media screen{'
    // B1 双区规则已定案（DESIGN.md §2，2026-11-02 用户拍板）：编辑器 --ed-accent 为暖橙；应用页 --accent 为近黑（server.mjs A-VARS），两区不互通；字面值钉 test-structure.sh B1 断言。
    +  'body.ed-on{--ed-bg:#F0EBE2;--ed-panel:#FFFCF5;--ed-ink:#26221C;--ed-mut:#6E675C;--ed-line:#DED3C0;--ed-accent:#C2410C;--ed-accent-ink:#FFF7ED;--ed-accent-soft:#FBE9D8;--ed-ok:#2F6B4F;--ed-ok-soft:#E4EFE6;--ed-warn:#A25711;--ed-warn-soft:#FBEEDC;--ed-err:#A32B2B;--ed-err-soft:#F7E4E1;--ed-accent-strong:#9A3412;--ed-serif:"Songti SC","Noto Serif CJK SC","Source Han Serif SC",Georgia,serif;--ed-sans:"PingFang SC",-apple-system,sans-serif;--ed-radius:8px;'
    + 'display:grid;height:100vh;overflow:hidden;background:var(--ed-bg);'
    + 'grid-template-columns:var(--ed-left-w,208px) minmax(0,1fr) var(--ed-right-w,320px);grid-template-rows:auto auto minmax(0,1fr) auto;'
    + 'transition:grid-template-columns .2s}'
    // 全局横向滚动防护：外壳页 html 层同步锁死（sheet 固定 794px，窄屏溢出由 zoom 适配而非滚动）
    + 'html:has(>body.ed-on){overflow:hidden}'
    // 顶栏：静态流内（覆盖 fixed），不覆盖正文；全套视觉兜底（存量文档工具栏 CSS 版本不一）
    + '.ed-on .edit-toolbar{position:static;grid-row:1;grid-column:1/-1;top:auto;left:auto;right:auto;'
    + 'border:none;border-bottom:1px solid var(--ed-line);border-radius:0;box-shadow:none;padding:6px 12px;'
    + 'background:var(--ed-panel);color:var(--ed-ink)}'
    + '.ed-on .edit-toolbar .spacer{flex:1}'
    + '.ed-on .edit-toolbar .doc-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:13px}'
    + '.ed-on .edit-toolbar .save-state{font-size:11px;padding:2px 10px;border-radius:999px;white-space:nowrap}'
    + '.ed-on .edit-toolbar .save-state[data-state="saved"]{color:var(--ed-ok);background:var(--ed-ok-soft)}'
    + '.ed-on .edit-toolbar .save-state[data-state="dirty"]{color:var(--ed-warn);background:var(--ed-warn-soft)}'
    + '.ed-on .edit-toolbar .save-state[data-state="saving"]{color:var(--ed-accent-strong);background:var(--ed-accent-soft)}'
    + '.ed-on .edit-toolbar .save-state[data-state="error"]{color:var(--ed-err);background:var(--ed-err-soft)}'
    + '.ed-on .edit-toolbar button{min-height:32px;padding:0 12px;border-radius:var(--ed-radius);font-size:12px;font-weight:600;transition:transform .12s,box-shadow .12s,background .12s;'
    + 'background:var(--ed-panel);color:var(--ed-ink);border:1px solid var(--ed-line)}'
    + '.ed-on .edit-toolbar button:hover{transform:translateY(-1px);box-shadow:0 3px 9px rgba(60,45,25,.12)}'
    + '.ed-on .edit-toolbar button:active{transform:translateY(1px);box-shadow:none}'
    + '.ed-on .edit-toolbar button:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}'
    + '.ed-on .edit-toolbar button.ed-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.ed-on .edit-toolbar button.ed-ghost{border-color:transparent;background:transparent;color:var(--ed-mut)}'
    + '.ed-on .edit-toolbar button.ed-ghost:hover{background:var(--ed-bg);color:var(--ed-ink)}'
    + '.ed-on .edit-toolbar .ed-gening{color:var(--ed-accent);background:var(--ed-accent-soft);border-radius:999px}'
    + '.ed-on .edit-toolbar button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.ed-on .edit-toolbar .save-state{font-size:11px}'
    + '.ed-on .edit-toolbar .badge{margin:0}'
    // 画布工具条（缩放）
    + '#ed-canvas-tools{grid-row:2;grid-column:2;display:flex;align-items:center;gap:6px;padding:6px 16px;font-size:11px;color:var(--ed-mut);min-width:0}'
    + '#ed-canvas-tools .ed-zoom{margin-left:auto;display:flex;align-items:center;gap:4px}'
    + '#ed-canvas-tools button{min-height:24px;min-width:24px;padding:0 6px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-panel);color:var(--ed-ink);font-size:12px;cursor:pointer}'
    + '#ed-canvas-tools button:hover{background:var(--ed-bg)}'
    + '#ed-canvas-tools button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '#ed-canvas-tools .ed-znum{width:56px;text-align:right;font-variant-numeric:tabular-nums;border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:3px 6px;font-size:12px;min-height:24px}'
    + '#ed-canvas-tools .ed-zunit{color:var(--ed-mut)}'
    // 纸张：grid item 原地落位，内部滚动；zoom 缩放只影响屏幕
    + '.ed-on .sheet{grid-row:3;grid-column:2;justify-self:center;height:100%;overflow-y:auto;margin:0 0 16px;'
    + 'box-shadow:0 4px 17px rgba(60,45,25,.08);transition:box-shadow .2s}'
    // 左栏
    + '#ed-left{grid-row:2/4;grid-column:1;overflow-y:auto;background:var(--ed-panel);border-right:1px solid var(--ed-line);padding:16px 12px;min-width:0}'
    + '#ed-left.ed-hidden{display:none}'
    + '.ed-label{font-family:var(--ed-serif);font-size:11px;letter-spacing:1px;color:var(--ed-mut);margin:2px 0 10px;text-transform:uppercase}'
    + '.ed-jobtitle{font-size:13px;font-weight:700;color:var(--ed-ink);margin:-4px 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-nav{display:flex;align-items:center;gap:4px;width:100%;text-align:left;padding:8px 10px;margin:2px 0;border:none;border-radius:var(--ed-radius);font-size:12px;color:var(--ed-mut);background:transparent;cursor:pointer;min-height:32px}'
    + '.ed-nav:hover{background:var(--ed-bg)}'
    + '.ed-nav.active{background:var(--ed-accent-soft);color:var(--ed-accent);font-weight:600}'
    + '.ed-nav:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.ed-nav .ed-nav-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-nav .ed-nav-ops{display:none;gap:2px;flex:none}'
    + '.ed-nav:hover .ed-nav-ops,.ed-nav:focus-within .ed-nav-ops{display:inline-flex}'
    // 导航行图标钮 22×22 / 24×24 与 #ed-canvas-tools 24×24 同为小图标钮 → 圆角归控件档 var(--ed-radius)（可见差异 4→8px，DESIGN.md §5.2 已登记）
    + '.ed-nav .ed-nav-ops button{min-width:22px;min-height:22px;padding:0;border:none;background:transparent;color:var(--ed-mut);cursor:pointer;border-radius:var(--ed-radius);font-size:11px;line-height:1}'
    + '.ed-nav .ed-nav-ops button:hover{background:var(--ed-line);color:var(--ed-ink)}'
    + '.ed-nav-go{flex:1;min-width:0;border:none;background:transparent;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-nav-go:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    // 条目级积木行（项目/经历）
    + '.ed-nav-entries{margin:0 0 6px 12px;border-left:1px solid var(--ed-line);padding-left:6px}'
    + '.ed-nav-entry{display:flex;align-items:center;gap:2px;padding:2px 4px;border-radius:var(--ed-radius);font-size:11px;color:var(--ed-mut)}'
    + '.ed-nav-entry:hover{background:var(--ed-bg)}'
    + '.ed-nav-entry .ed-entry-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-nav-entry.ed-entry-off .ed-entry-name{text-decoration:line-through;color:var(--ed-mut)}'
    + '.ed-nav-entry{position:relative}'
    + '.ed-nav-more{min-width:22px;min-height:22px;padding:0 4px;border:none;background:transparent;color:var(--ed-mut);cursor:pointer;border-radius:var(--ed-radius);font-size:12px}'
    + '.ed-nav-more:hover{background:var(--ed-bg)}'
    + '.ed-nav-menu{position:absolute;right:0;top:100%;background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:4px;display:flex;flex-direction:column;min-width:112px;z-index:30;box-shadow:0 4px 14px rgba(60,45,25,.12)}'
    // hidden 态显式补回：上面的 display:flex 会压过 UA 的 [hidden]{display:none}（审计 R1：菜单加载即见盖在左栏上）；
    // 开合仍由 renderNav 的 menu.hidden 驱动，语义零改动（test-shell-review-fixes.mjs 一并验证可开可关）
    + '.ed-nav-menu[hidden]{display:none}'
    + '.ed-nav-menu button{text-align:left;border:none;background:transparent;padding:4px 8px;font-size:12px;color:var(--ed-ink);cursor:pointer;border-radius:var(--ed-radius);min-height:24px}'
    + '.ed-nav-menu button:hover:not([disabled]){background:var(--ed-bg)}'
    + '.ed-nav-entry .ed-nav-ops{display:inline-flex;gap:2px;flex:none}'
    + '.ed-nav-entry .ed-nav-ops button{min-width:24px;min-height:24px;padding:0;border:none;background:transparent;color:var(--ed-mut);cursor:pointer;border-radius:var(--ed-radius);font-size:11px;line-height:1}'
    + '.ed-nav-entry .ed-nav-ops button:hover{background:var(--ed-line);color:var(--ed-ink)}'
    + '.ed-nav.ed-sec-off .ed-nav-name{text-decoration:line-through;color:var(--ed-mut)}'
    + '.ed-divider{height:1px;background:var(--ed-line);margin:16px -4px}'
    + '.ed-addsec{width:100%;margin-top:10px;min-height:32px;padding:0 12px;border:1px dashed var(--ed-line);border-radius:var(--ed-radius);background:transparent;color:var(--ed-mut);font-size:12px;cursor:pointer}'
    + '.ed-addsec:hover{border-color:var(--ed-accent);color:var(--ed-accent)}'
    + '.ed-mat{border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:10px;font-size:12px;margin-top:10px;cursor:pointer;transition:box-shadow .15s,transform .15s;background:var(--ed-panel)}'
    + '.ed-mat:hover{box-shadow:0 3px 9px rgba(60,45,25,.10);transform:translateY(-1px)}'
    + '.ed-mat:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.ed-mat small{display:block;margin-top:4px;font-size:11px;color:var(--ed-mut)}'
    + '.ed-mat .ed-mat-unconf{margin-left:6px;font-size:11px;font-weight:600;color:var(--ed-warn);background:var(--ed-warn-soft);border-radius:999px;padding:1px 6px}'
    + '.ed-matpop-warn{font-size:12px;color:var(--ed-warn);background:var(--ed-warn-soft);border-radius:var(--ed-radius);padding:6px 8px;margin-bottom:6px}'
    + '.ed-mat-search{width:100%;box-sizing:border-box;border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:6px 8px;font-size:12px;margin-top:4px}'
    + '.ed-compat{font-size:11px;color:var(--ed-mut);line-height:1.6;padding:8px 10px;background:var(--ed-bg);border-radius:var(--ed-radius)}'
    // 右栏
    + '#ed-right{grid-row:2/4;grid-column:3;background:var(--ed-panel);border-left:1px solid var(--ed-line);display:flex;flex-direction:column;min-width:0;overflow:hidden}'
    + '#ed-right.ed-hidden{display:none}'
    // 批次C：右栏拖柄。grid item，与 #ed-right 同格（行 2/4、列 3）——
    // justify-self:start + margin-left:-3px 让 6px 竖条骑在正文/右栏交界上；
    // body.ed-on 提高特异性，压过文档内联 chrome（编辑器页 HTML 是 docs/*.html 用户数据，注入层才有最终解释权）。
    + 'body.ed-on #ed-grip{grid-row:2/4;grid-column:3;justify-self:start;align-self:stretch;'
    + 'width:min(6px,100%);margin-left:-3px;z-index:6;cursor:col-resize;background:transparent;'
    + 'border-radius:3px;transition:background .12s}'
    + 'body.ed-on #ed-grip:hover,body.ed-on #ed-grip:focus-visible{background:var(--ed-line)}'
    + 'body.ed-on #ed-grip:focus-visible{outline:2px solid var(--ed-accent);outline-offset:-1px}'
    // 拖拽/键盘调宽时禁掉列宽过渡（body.ed-on 有 grid-template-columns .2s 过渡，否则每一步都拖泥带水）
    + 'body.ed-on.ed-nofx{transition:none}'
    // 聚焦模式收起左右栏 → 拖柄无意义（且不能是隐形焦点陷阱）
    + '.ed-on.ed-focus #ed-grip{display:none}'
    // 窄屏右栏是抽屉（position:fixed），没有边界可拖 → 拖柄隐藏
    + '@media(max-width:767px){body.ed-on #ed-grip{display:none}}'
    + '#ed-rtabs{display:flex;gap:2px;border-bottom:1px solid var(--ed-line);padding:8px 8px 0;flex:none;overflow-x:auto}'
    // 1280-1439 档的非活跃态：折叠成竖标签条（设计 v1.3）——页签条留着才切得动页签
    + 'body.ed-on.ed-tier-strip #ed-rtabs{flex-direction:column;gap:0;border-bottom:0;padding:6px 0;overflow-x:hidden;overflow-y:auto}'
    + 'body.ed-on.ed-tier-strip #ed-rtabs button{writing-mode:vertical-rl;min-height:72px;padding:6px 3px;flex:none;letter-spacing:1px}'
    + 'body.ed-on.ed-tier-strip .ed-pane{display:none}'
    + '#ed-rtabs button{flex:1;min-height:32px;padding:0 4px;border:none;background:transparent;font-size:12px;font-weight:600;color:var(--ed-mut);cursor:pointer;border-radius:var(--ed-radius) var(--ed-radius) 0 0;box-shadow:inset 0 0 0 transparent}'
    + '#ed-rtabs button[aria-selected="true"]{color:var(--ed-accent);box-shadow:inset 0 -2px 0 var(--ed-accent)}'
    + '#ed-rtabs button:hover{background:var(--ed-bg)}'
    + '#ed-rtabs button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.ed-pane{flex:1;overflow-y:auto;min-height:0;display:none;flex-direction:column}'
    + '.ed-pane.on{display:flex}'
    // 排版面板
    + '.ed-typo{padding:14px 12px;font-size:12px}'
    + '.ed-typo .ed-field{margin-bottom:14px}'
    + '.ed-typo label{display:flex;justify-content:space-between;font-size:12px;color:var(--ed-ink);margin-bottom:4px}'
    + '.ed-typo label output{color:var(--ed-mut);font-variant-numeric:tabular-nums}'
    + '.ed-typo input[type=range]{width:100%}'
    + '.ed-typo .ed-reset{width:100%;min-height:32px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-panel);color:var(--ed-ink);font-size:12px;cursor:pointer}'
    + '.ed-typo .ed-reset:hover{background:var(--ed-bg)}'
    + '.ed-typo .ed-note{font-size:11px;color:var(--ed-mut);line-height:1.6;margin-top:12px}'
    // 排版密度预设 + 页数感知（A3）：三档预设置顶（命中高亮 aria-pressed，手动改滑杆即失选）；
    // 页数行如实显示（无渲染历史=尚未渲染，不臆造）；超页「切到紧凑档」是普通动作 → 中性描边（非 accent 主行动）
    + '.ed-typo .ed-presets{display:flex;gap:6px;margin-bottom:14px}'
    + '.ed-typo .ed-preset{flex:1;min-height:28px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-panel);color:var(--ed-ink);font-size:12px;cursor:pointer}'
    + '.ed-typo .ed-preset:hover{background:var(--ed-bg)}'
    + '.ed-typo .ed-preset.ed-preset-on{border-color:var(--ed-accent);color:var(--ed-accent);font-weight:700}'
    + '.ed-typo .ed-pagerow{font-size:11px;color:var(--ed-mut);line-height:1.6;margin:10px 0 2px;display:flex;flex-wrap:wrap;align-items:center;gap:6px}'
    + '.ed-typo .ed-pagemore{min-height:26px;padding:0 10px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-panel);color:var(--ed-ink);font-size:12px;cursor:pointer}'
    + '.ed-typo .ed-pagemore:hover{background:var(--ed-bg)}'
    + '.ed-typo .ed-pagenote{font-size:11px;color:var(--ed-mut);line-height:1.6;margin:6px 0 0}'
    // 模板页签（S6-A2）：主题卡 = 标签 + 受众一句 + scaled iframe 真实渲染（/theme-preview 经 srcdoc 装载）
    + '.ed-theme{padding:14px 12px;font-size:12px}'
    + '.ed-theme .ed-tcard{border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:10px;margin-bottom:12px;background:var(--ed-panel)}'
    + '.ed-theme .ed-tcard.ed-tcur{border-color:var(--ed-accent)}'
    + '.ed-theme .ed-tcard-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}'
    + '.ed-theme .ed-tname{font-weight:700;color:var(--ed-ink)}'
    + '.ed-theme .ed-tbadge{font-size:11px;color:var(--ed-accent);border:1px solid var(--ed-accent);border-radius:999px;padding:0 6px;min-height:16px;line-height:15px}'
    + '.ed-theme .ed-taud{color:var(--ed-mut);line-height:1.55;margin-bottom:8px}'
    + '.ed-theme .ed-tthumb{position:relative;height:158px;overflow:hidden;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-bg)}'
    + '.ed-theme .ed-tthumb iframe{width:794px;height:1123px;border:0;transform:scale(0.35);transform-origin:0 0;pointer-events:none;display:block}'
    + '.ed-theme .ed-tthumb .ed-tload{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--ed-mut)}'
    + '.ed-theme .ed-tcalm{font-size:11px;color:var(--ed-mut);line-height:1.6;margin-top:8px}'
    + '.ed-theme .ed-tapply{width:100%;min-height:32px;margin-top:8px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-panel);color:var(--ed-ink);font-size:12px;cursor:pointer}'
    + '.ed-theme .ed-tapply:hover{background:var(--ed-bg)}'
    + '.ed-theme .ed-tsem{font-size:11px;color:var(--ed-mut);line-height:1.6;margin-top:12px}'
    // 底栏：position:relative+z-index 抬升绘制层级——冻结主题 .sheet{position:relative;min-height:297mm}
    // （themes/resume-classic.css:10/:12）在矮视口让纸张溢出 grid 行，静态定位的底栏会被盖住、
    // 「↩ 撤销」（唯一定向撤销入口）不可点；非 .sheet 规则，不声明任何文字属性
    + '#ed-status{grid-row:4;grid-column:1/-1;position:relative;z-index:5;display:flex;gap:16px;align-items:center;padding:5px 16px;font-size:11px;color:var(--ed-mut);background:var(--ed-panel);border-top:1px solid var(--ed-line);min-height:28px}'
    + '#ed-status .ed-st-right{margin-left:auto}'
    + '#ed-status .ed-undobtn{border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink);border-radius:999px;font-size:12px;min-height:24px;padding:0 10px;cursor:pointer}'
    + '#ed-status .ed-undobtn:hover{background:var(--ed-bg)}'
    // 折叠开关（顶栏注入的图标按钮）
    + '.ed-iconbtn{min-width:28px;min-height:28px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center}'
    // 选区工具条（4 动作，取代原 #ai-sel-btn 单钮；由 ai-panel 供电时隐藏旧钮）
    + '#ed-seltb{position:absolute;z-index:99;display:none;gap:2px;background:var(--ed-ink);color:var(--ed-panel);border-radius:var(--ed-radius);padding:4px;box-shadow:0 4px 12px rgba(0,0,0,.18);font-size:12px}'
    + '#ed-seltb button{min-height:26px;padding:0 8px;border:none;border-radius:var(--ed-radius);background:transparent;color:var(--ed-panel);font-size:11px;cursor:pointer;white-space:nowrap}'
    + '#ed-seltb button:hover{background:rgba(255,255,255,.14)}'
    + '#ed-seltb button:focus-visible{outline:2px solid var(--ed-accent-soft);outline-offset:1px}'
    // 素材选择器弹层
    + '#ed-matpop{position:fixed;z-index:102;top:50%;left:50%;transform:translate(-50%,-50%);width:min(480px,92vw);max-height:80vh;overflow-y:auto;background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:14px;box-shadow:0 18px 50px rgba(60,45,25,.16);padding:16px;display:none;font-size:13px}'
    + '#ed-matpop h3{font-family:var(--ed-serif);margin:0 0 10px;font-size:14px}'
    + '#ed-matpop .ed-matpop-sec{margin:10px 0}'
    + '#ed-matpop .ed-matpop-label{font-size:11px;color:var(--ed-mut);margin-bottom:4px}'
    + '#ed-matpop select{width:100%;border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:7px 10px;font-size:12px;background:var(--ed-panel)}'
    + '#ed-matpop .ed-matprev{border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:10px;font-size:12px;line-height:1.7;color:var(--ed-ink);background:var(--ed-bg);white-space:pre-wrap;max-height:180px;overflow-y:auto}'
    + '#ed-matpop .ed-matrow{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}'
    + '#ed-matpop .ed-matrow button{min-height:32px;padding:0 14px;border-radius:var(--ed-radius);font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '#ed-matpop .ed-matrow button.ed-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '#ed-matpop .ed-mattypes{display:flex;gap:6px}'
    + '#ed-matpop .ed-mattypes button{flex:1;min-height:30px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-panel);font-size:12px;color:var(--ed-mut);cursor:pointer}'
    + '#ed-matpop .ed-mattypes button.on{border-color:var(--ed-accent);color:var(--ed-accent);background:var(--ed-accent-soft);font-weight:600}'
    + '#ed-matmask{position:fixed;inset:0;background:rgba(60,45,25,.24);z-index:101;display:none}'
    // 岗位草稿弹层（结构化输入，创建独立草稿，不依赖模型）
    + '#ed-jobmask{position:fixed;inset:0;background:rgba(60,45,25,.24);z-index:103;display:none}'
    + '#ed-jobpop{position:fixed;z-index:104;top:50%;left:50%;transform:translate(-50%,-50%);width:min(520px,94vw);max-height:86vh;overflow-y:auto;background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:14px;box-shadow:0 18px 50px rgba(60,45,25,.16);padding:16px;display:none;font-size:13px}'
    + '#ed-jobpop h3{font-family:var(--ed-serif);margin:0 0 4px;font-size:14px}'
    + '#ed-jobpop .ed-jp-note{font-size:11px;color:var(--ed-mut);margin-bottom:10px}'
    + '#ed-jobpop label{display:block;font-size:12px;color:var(--ed-ink);margin:8px 0 2px}'
    + '#ed-jobpop input,#ed-jobpop textarea,#ed-jobpop select{width:100%;border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:7px 10px;font-size:12px;background:var(--ed-panel);box-sizing:border-box}'
    + '#ed-jobpop textarea{min-height:70px;resize:vertical}'
    + '#ed-jobpop .ed-jp-row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}'
    + '#ed-jobpop .ed-jp-row button{min-height:32px;padding:0 14px;border-radius:var(--ed-radius);font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '#ed-jobpop .ed-jp-row button.ed-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '#ed-jobpop .ed-jp-msg{font-size:11px;color:var(--ed-warn);margin-top:8px;min-height:14px}'
    // 定制要求折叠区（E 轮：与首页 brief 同形状；容器圆角 10px=弹层档，chips 胶囊 999，段选=控件档）
    + '#ed-jobpop details{border:1px solid var(--ed-line);border-radius:10px;background:var(--ed-bg);margin-top:10px;padding:0 10px}'
    + '#ed-jobpop details summary{cursor:pointer;padding:8px 0;font-size:12px;font-weight:600;color:var(--ed-ink)}'
    + '#ed-jobpop .ed-jp-brief{padding:2px 0 10px}'
    + '#ed-jobpop .ed-jp-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}'
    + '#ed-jobpop .ed-jp-chips button{min-height:24px;padding:0 10px;border:1px solid var(--ed-line);border-radius:999px;background:var(--ed-panel);color:var(--ed-ink);font-size:12px;cursor:pointer}'
    + '#ed-jobpop .ed-jp-chips button[aria-pressed="true"]{border-color:var(--ed-accent);color:var(--ed-accent);background:var(--ed-accent-soft);font-weight:600}'
    + '#ed-jobpop .ed-jp-seg{display:flex;gap:6px;margin-top:4px}'
    + '#ed-jobpop .ed-jp-seg button{flex:1;min-height:28px;padding:0 8px;border:1px solid var(--ed-line);border-radius:var(--ed-radius);background:var(--ed-panel);color:var(--ed-mut);font-size:12px;cursor:pointer}'
    + '#ed-jobpop .ed-jp-seg button[aria-pressed="true"]{border-color:var(--ed-accent);color:var(--ed-accent);background:var(--ed-accent-soft);font-weight:600}'
    // 预览模式：纸张短过渡后归正，正文保持平面
    + '.ed-preview .sheet{transition:transform .35s ease,box-shadow .35s ease;box-shadow:0 12px 32px rgba(60,45,25,.14)}'
    + '.ed-preview .sheet p:hover,.ed-preview .sheet li:hover,.ed-preview .sheet h1:hover,.ed-preview .sheet .entry-head:hover,.ed-preview .sheet .contact:hover{outline:none!important}'
    // 定位高亮闪记
    + '@keyframes edFlash{0%{outline:2px solid var(--ed-accent);outline-offset:2px}100%{outline:2px solid transparent;outline-offset:2px}}'
    + '.ed-flash{animation:edFlash 1.2s ease-out}'
    // 面板/布局过渡（折叠列宽过渡在 body.ed-on 上）
    // 响应式：中屏收左栏，窄屏单栏切换
    + '@media(max-width:1200px){body.ed-on{--ed-left-w:0px;--ed-right-w:300px}#ed-left{position:absolute;z-index:60;top:0;bottom:0;left:0;width:240px;box-shadow:4px 0 16px rgba(60,45,25,.10);display:none}#ed-left.ed-open{display:block}}'
    + '@media(max-width:767px){body.ed-on{grid-template-columns:minmax(0,1fr);--ed-right-w:0px}'
    + '#ed-canvas-tools{display:none}'
    + '#ed-right{position:fixed;z-index:70;top:0;right:0;bottom:0;width:min(340px,94vw);box-shadow:-4px 0 16px rgba(60,45,25,.12);display:none}'
    + '#ed-right.ed-open{display:flex}}'
    + '@media(prefers-reduced-motion:reduce){body.ed-on{transition:none}.ed-on .edit-toolbar button,.ed-mat,.ed-preview .sheet{transition:none!important}.ed-flash{animation:none!important}}'
    // 外壳视觉兜底覆盖：存量文档内联的工具栏/toast/恢复条版本不一，一律由注入层统一（仅屏幕、不落盘、不进 PDF）
    // 圆角随兜底一并归 var(--ed-radius)：同选择器后写者胜，此处再写字面 8px 会覆盖上面的 token（视觉零差，单值口径闭合）
    + '.ed-on .edit-toolbar button{background:var(--ed-panel);color:var(--ed-ink);border:1px solid var(--ed-line);border-radius:var(--ed-radius)}'
    + '.ed-on .edit-toolbar button.secondary{background:var(--ed-panel);color:var(--ed-ink);border:1px solid var(--ed-line)}'
    // 主次（用户定）：操作区默认中性描边，只有主任务「导出 PDF」用橙色实心；撤销按钮不得比主任务抢眼
    + '.ed-on .edit-toolbar button#pdfBtn,.ed-on .edit-toolbar button.primary{background:var(--ed-accent);color:var(--ed-accent-ink);border:1px solid var(--ed-accent);font-weight:700}'
    // 左右栏正文（用户定）：左栏导航行 12px（紧凑控件档，见 .ed-nav），右栏面板正文 13px；条目名用省略号而非频繁断行；衬线只留给标题类与 .ed-label
    + '.ed-on #ed-left,.ed-on #ed-right{font-size:13px;line-height:1.6}'
    + '.ed-on .save-state[data-state="saved"]{color:var(--ed-ok);background:var(--ed-ok-soft)}'
    + '.ed-on .save-state[data-state="dirty"]{color:var(--ed-warn);background:var(--ed-warn-soft)}'
    + '.ed-on .save-state[data-state="saving"]{color:var(--ed-accent-strong);background:var(--ed-accent-soft)}'
    + '.ed-on .save-state[data-state="error"]{color:var(--ed-err);background:var(--ed-err-soft)}'
    + '.ed-on .toast{background:var(--ed-ink);color:var(--ed-panel)}'
    + '.ed-on .recovery-bar{background:var(--ed-warn);color:var(--ed-accent-ink)}'
    + '.ed-on .recovery-bar button{background:var(--ed-panel);color:var(--ed-warn)}'
    + '.ed-on .recovery-bar button.secondary{background:var(--ed-warn);color:var(--ed-accent-ink);border:1px solid var(--ed-accent-ink)}'
    + '.ed-on .page-line{border-top-color:rgba(162,87,17,.34)}'
    + '.ed-on .page-line span{color:rgba(162,87,17,.78);background:rgba(255,252,245,.88)}'
    + '.ed-on .sheet{caret-color:var(--ed-accent)}'
    + '.ed-on .sheet p:hover,.ed-on .sheet li:hover,.ed-on .sheet h1:hover,.ed-on .sheet .entry-head:hover,.ed-on .sheet .contact:hover{outline-color:rgba(194,65,12,.45)}'
    + '.ed-on button:focus-visible,.ed-on input:focus-visible,.ed-on textarea:focus-visible,.ed-on a:focus-visible{outline-color:var(--ed-accent)}'
    // ===== S2-T5 基础编辑五件（全走 --ed-* token；仅屏幕，不落盘、不进 PDF）=====
    // flash / 查找高亮走 CSS Custom Highlight API（高亮只在内存 Range，正文零 DOM 变更）
    + '::highlight(ed-flash){background:var(--ed-accent-soft);color:inherit}'
    + '::highlight(ed-find){background:var(--ed-warn-soft);color:inherit}'
    + '::highlight(ed-find-cur){background:var(--ed-accent);color:var(--ed-accent-ink)}'
    // 基础格式组（顶栏）
    + '.ed-on .ed-fmt{display:flex;gap:4px;align-items:center}'
    + '.ed-on .ed-fmt button{min-height:26px;padding:0 8px;font-size:12px;line-height:1}'
    // 文内查找替换面板
    + '.ed-on #ed-find{position:fixed;top:56px;right:18px;z-index:120;display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:10px;box-shadow:0 6px 18px rgba(60,45,25,.16);padding:8px 10px}'
    + '.ed-on #ed-find input{border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:4px 8px;font-size:13px;background:var(--ed-panel);color:var(--ed-ink);width:150px}'
    + '.ed-on #ed-find button{min-height:26px;padding:0 8px;font-size:12px}'
    + '.ed-on #ed-find-count{font-size:12px;color:var(--ed-mut);min-width:44px;text-align:center}'
    // 聚焦编辑：body.ed-focus 收起左右栏（服务端 /save 归一化剥离该 class）
    + '.ed-on.ed-focus{grid-template-columns:0 minmax(0,1fr) 0}'
    + '.ed-on.ed-focus #ed-left,.ed-on.ed-focus #ed-right{display:none}'
    // 快捷键提示弹层
    + '.ed-on #ed-keys{position:fixed;z-index:130;top:50%;left:50%;transform:translate(-50%,-50%);width:min(440px,92vw);background:var(--ed-panel);color:var(--ed-ink);border:1px solid var(--ed-line);border-radius:12px;box-shadow:0 12px 32px rgba(60,45,25,.22);padding:16px 18px}'
    + '.ed-on #ed-keys b{font-family:var(--ed-serif);font-size:15px}'
    + '.ed-on #ed-keys ul{list-style:none;padding:0;margin:10px 0 0;display:grid;gap:6px}'
    + '.ed-on #ed-keys li{display:flex;gap:10px;align-items:baseline;font-size:13px;line-height:1.6}'
    + '.ed-on #ed-keys kbd{font-family:var(--ed-sans);background:var(--ed-bg);border:1px solid var(--ed-line);border-radius:var(--ed-radius);padding:1px 6px;font-size:11px;min-width:56px;text-align:center}'
    + '}'
    + '@media print{#ed-left,#ed-right,#ed-status,#ed-canvas-tools,#ed-seltb,#ed-matpop,#ed-matmask{display:none!important}'
    + 'body.ed-on{display:block;height:auto;overflow:visible;background:var(--ed-panel)}.ed-on .sheet{overflow:visible;height:auto;box-shadow:none;margin:0}}';
  document.head.appendChild(css);

  // ===== 注释对挂载：全部外壳 DOM 收进 SHELL-INJECT 之间，/save 自动剥离 =====
  function findComment(text) {
    var it = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
    var n;
    while ((n = it.nextNode())) { if (n.data === text) return n; }
    return null;
  }
  var endMark = findComment('/SHELL-INJECT');
  function mount(el) {
    if (endMark) endMark.parentNode.insertBefore(el, endMark);
    else document.body.appendChild(el);
  }

  document.body.classList.add('ed-on');
  var toolbar = document.querySelector('.edit-toolbar');

  // ===== 顶栏重排：☰ | 返回 | 名称 | 版本徽标 | … | 状态 | 保存 | 历史 | 预览 | 导出 PDF | ⚙ =====
  var pdfBtn = document.getElementById('pdfBtn');
  var saveBtn = document.getElementById('saveBtn');
  var histBtn = document.getElementById('histBtn');
  var homeBtn = document.getElementById('homeBtn');
  var verBadge = document.getElementById('verBadge');
  var docName = document.getElementById('docName');
  var saveState = document.getElementById('saveState');
  // 冻结件工具条按钮：先存原样（注入前），保存时还原 —— 见下方 cloneNode 钩子。
  var FROZEN_BTN = ['pdfBtn', 'saveBtn', 'histBtn', 'homeBtn'];   // homeBtn 也被注入层改过（class/title）→ 同样要还原
  var frozenOrig = {};
  for (var bi = 0; bi < FROZEN_BTN.length; bi++) {
    var bel = document.getElementById(FROZEN_BTN[bi]);
    if (bel) frozenOrig[FROZEN_BTN[bi]] = bel.outerHTML;
  }
  if (pdfBtn) { pdfBtn.classList.remove('secondary'); pdfBtn.classList.add('ed-primary'); pdfBtn.innerHTML = __icon('file-text') + ' 导出 PDF'; pdfBtn.title = '导出前检查并下载 PDF'; }
  if (saveBtn) { saveBtn.classList.add('ed-ghost'); saveBtn.innerHTML = __icon('save') + ' 保存'; saveBtn.title = '保存（⌘/Ctrl+S，打历史快照）'; }
  if (histBtn) { histBtn.classList.remove('secondary'); histBtn.innerHTML = __icon('clock') + ' 历史'; histBtn.title = '版本历史'; }
  if (homeBtn) {
    homeBtn.textContent = '‹ 工作台'; homeBtn.title = '返回工作台'; homeBtn.classList.add('ed-ghost');
    // 跳转在这里绑（不是内联 onclick）：/edit 的 CSP 挡内联事件属性
    homeBtn.addEventListener('click', function () { location.href = '/'; });
  }

  // ===== 注入层产物不落盘：工具条按钮的运行时覆盖必须不进用户文档文件 =====
  // 模板的 doSave 克隆整棵 DOM 再上传（它自己只还原了 #saveState，工具条按钮没人还原）→
  // 注入的 SVG 会跟着进 docs/<id>.html，文件与冻结模板不再一致，bodyHash 也跟着变。
  // 钩住 documentElement.cloneNode：克隆后立刻把三个按钮还原成模板原样
  // （emoji 字面量留在文件里，UI 里由注入层换成 SVG —— 与 #saveState/toast 同一套机制）。
  // 克隆是同步的，钩子在其后立即执行 → doSave / buildPageHtml 拿到的克隆已是原样。
  (function () {
    var rootEl = document.documentElement;
    if (!rootEl || !Object.keys(frozenOrig).length) return;
    var origClone = rootEl.cloneNode.bind(rootEl);
    rootEl.cloneNode = function (deep) {
      var c = origClone(deep);
      for (var k in frozenOrig) {
        var t = c.querySelector('#' + k);
        if (!t) continue;
        var box = document.createElement('div');
        box.innerHTML = frozenOrig[k];
        if (box.firstElementChild) t.replaceWith(box.firstElementChild);
      }
      return c;
    };
  })();

  // ===== 冻结件 template.html 的 emoji → 运行时覆盖成 SVG（模板是冻结件，不改）=====
  // template.html 的 setState()/toast() 在它自己的 IIFE 私有作用域里，注入层拿不到这两个函数，
  // 只能看 DOM：文本首/尾的 emoji 字面量 → 换成 Lucide 图标（circle-check / circle-alert）。
  // 字面量一律 \u 转义写 —— 源码里不再出现 emoji 字面量（UI-7 断言要求前端源码零 emoji）。
  var GLYPH_ICON = {
    '\u2705': 'circle-check',        // 绿勾
    '\u26a0\ufe0f': 'circle-alert',  // 警告（带变体选择符）
    '\u26a0': 'circle-alert',        // 警告（无变体选择符）
    '\u2713': 'circle-check'         // 勾
  };
  var GLYPH_SEL = '#saveState, .toast, .recovery-bar > span';
  function iconifyGlyph(el) {
    if (!el) return;
    var txt = el.textContent || '';
    if (!txt) return;
    var name = null, rest = txt;
    for (var k in GLYPH_ICON) {                       // 前缀字面量（toast / 提示条）
      if (rest.indexOf(k) === 0) { name = GLYPH_ICON[k]; rest = rest.slice(k.length).replace(/^\s+/, ''); break; }
    }
    if (!name) {
      for (var k2 in GLYPH_ICON) {                    // 后缀字面量（保存状态末尾的勾号）
        if (rest.length > k2.length && rest.slice(-k2.length) === k2) { name = GLYPH_ICON[k2]; rest = rest.slice(0, -k2.length).replace(/\s+$/, ''); break; }
      }
    }
    if (!name) return;                                // 没有字面量 → 不动（幂等，observer 不会自激）
    if (el.children.length) return;                   // 带子元素的（如外壳的撤销 toast 按钮）一律不碰，绝不拆结构
    el.innerHTML = __icon(name) + ' ' + escHtml(rest);
  }
  function sweepGlyphs(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.id === 'saveState' || (root.matches && root.matches(GLYPH_SEL))) iconifyGlyph(root);
    var list = root.querySelectorAll(GLYPH_SEL);
    for (var i = 0; i < list.length; i++) iconifyGlyph(list[i]);
  }
  // 模板私有 toast()、恢复条/冲突条是运行时插进来的；保存状态是模板改 textContent —— 都靠观察。
  var glyphObs = new MutationObserver(function (recs) {
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (r.type !== 'childList') continue;
      if (r.target && r.target.id === 'saveState') iconifyGlyph(r.target);
      for (var j = 0; j < r.addedNodes.length; j++) {
        var an = r.addedNodes[j];
        sweepGlyphs(an);
        // A8：模板运行时插入的 toast 与恢复/冲突条补读屏语义（不改冻结件，瞬态 UI 不落盘）
        if (an && an.nodeType === 1 && an.classList && (an.classList.contains('toast') || an.classList.contains('recovery-bar')) && !an.getAttribute('role')) an.setAttribute('role', 'status');
      }
    }
  });
  glyphObs.observe(document.body, { childList: true, subtree: true });
  sweepGlyphs(document.body);

  // 预览按钮（幂等：class 标记；事件不落盘，serve 后由本脚本绑定）
  var previewBtn = toolbar && toolbar.querySelector('.ed-preview-btn');
  if (toolbar && !previewBtn) {
    previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'ed-preview-btn';
    previewBtn.setAttribute('data-ed-inj', '1');
    previewBtn.textContent = '预览';
    previewBtn.title = '预览纸张效果（近似，以导出 PDF 为准）';
    toolbar.appendChild(previewBtn);
  }

  // 左栏/右栏折叠开关（幂等）
  var ltBtn = toolbar && toolbar.querySelector('.ed-left-toggle');
  var rtBtn = toolbar && toolbar.querySelector('.ed-right-toggle');
  if (toolbar && !ltBtn) {
    ltBtn = document.createElement('button');
    ltBtn.type = 'button';
    ltBtn.className = 'ed-iconbtn ed-ghost ed-left-toggle';
    ltBtn.setAttribute('data-ed-inj', '1');
    ltBtn.setAttribute('aria-label', '章节与素材面板');
    ltBtn.title = '章节与素材';
    ltBtn.innerHTML = __icon('menu') || '章';   // __icon 缺失时给文字兜底，否则是空按钮
    toolbar.insertBefore(ltBtn, toolbar.firstChild);
  }
  if (toolbar && !rtBtn) {
    rtBtn = document.createElement('button');
    rtBtn.type = 'button';
    rtBtn.className = 'ed-iconbtn ed-ghost ed-right-toggle';
    rtBtn.setAttribute('data-ed-inj', '1');
    rtBtn.setAttribute('aria-label', '辅助面板');
    rtBtn.title = '审阅 / 区域 / AI 助手 / 排版';
    rtBtn.innerHTML = __icon('columns-3') || '审';   // A15：右栏开关不再与「设置」页图标撞车（44 图标内的 columns-3）
    toolbar.appendChild(rtBtn);
  }
  // 岗位草稿入口（不依赖模型：直接创建独立草稿，模型配置后可在审阅面板生成建议）
  var jobBtn = toolbar && toolbar.querySelector('.ed-jobbtn');
  if (toolbar && !jobBtn && !JOB_INFO.hasJob) {
    jobBtn = document.createElement('button');
    jobBtn.type = 'button';
    jobBtn.className = 'ed-ghost ed-jobbtn';
    jobBtn.setAttribute('data-ed-inj', '1');
    jobBtn.textContent = '＋ 岗位草稿';
    jobBtn.title = '基于当前简历创建独立岗位草稿（不改母版）';
    toolbar.appendChild(jobBtn);
  }
  // 快捷键提示入口（S2-T5 修复轮1）：正文里的 '?' 交还给打字（打字进用户文档永远优先），
  // 弹层保留两个入口：⌘/（任意焦点）与本按钮（鼠标可达）；data-ed-inj 保证不落盘
  var keysBtn = toolbar && toolbar.querySelector('.ed-keysbtn');
  if (toolbar && !keysBtn) {
    keysBtn = document.createElement('button');
    keysBtn.type = 'button';
    keysBtn.className = 'ed-iconbtn ed-ghost ed-keysbtn';
    keysBtn.setAttribute('data-ed-inj', '1');
    keysBtn.setAttribute('aria-label', '快捷键提示');
    keysBtn.title = '快捷键提示（⌘/）';
    keysBtn.textContent = '?';
    toolbar.appendChild(keysBtn);
  }
  if (keysBtn) keysBtn.addEventListener('click', function () { toggleShortcutHelp(); });
  // ===== S4a-T4：AI 任务迷你指示（岗位草稿专属）：顶部「生成中…」，点击回审阅 Tab =====
  // 状态源 = /job/changes 轮询（最简：服务端是事实单源，刷新/离开都能找回）；data-ed-inj 保证不落盘。
  var geningBtn = toolbar && toolbar.querySelector('.ed-gening');
  if (toolbar && !geningBtn && JOB_INFO.hasJob) {
    geningBtn = document.createElement('button');
    geningBtn.type = 'button';
    geningBtn.className = 'ed-ghost ed-gening';
    geningBtn.setAttribute('data-ed-inj', '1');
    geningBtn.setAttribute('aria-label', 'AI 任务进行中，查看审阅');
    geningBtn.hidden = true;
    geningBtn.textContent = '生成中…';
    geningBtn.title = 'AI 任务进行中，点击查看审阅';
    geningBtn.addEventListener('click', function () { if (window.__edSelectTab) window.__edSelectTab('review'); });
    toolbar.appendChild(geningBtn);
  }
  if (geningBtn) {
    var pollGening = function () {
      // 标签页不可见时别轮询：/job/changes 每次都要重解析整份正文算一致性，
      // 放着不管就是每 2.5 秒一次全文重算（2026-10-22 审查 [低] 实测）
      if (document.hidden) return;
      fetch('/job/changes?id=' + encodeURIComponent(DOC_ID)).then(function (r) { return r.json(); }).then(function (d) {
        var gt = d && d.job && d.job.genTasks;
        var run = !!(gt && ((gt.evidence && gt.evidence.status === 'running') || (gt.changes && gt.changes.status === 'running')));
        geningBtn.hidden = !run;
      }).catch(function () { /* 轮询失败静默（迁移期 503 等），下一轮再试 */ });
    };
    pollGening();
    setInterval(pollGening, 2500);
  }
  // ===== 共享保存序列化（ZONE-06）=====
  // 区域面板与岗位面板必须产出**同一份字节**的正文（否则同一份文档两条路径存出不同 HTML
  // → bodyHash / renderInputId 不同 → PDF 被误判「较旧」）。
  // 口径与 template.html 的 doSave 一致：同一组瞬态元素要剥、同一组状态要写。
  window.__edBuildSaveHtml = function () {
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('.page-line, .toast, .recovery-bar, [data-ai-panel], [data-ed-shell], [data-ed-inj], [data-job-panel]').forEach(function (el) { el.remove(); });
    var cbody = clone.querySelector('body');
    if (cbody) { cbody.classList.remove('ed-on', 'ed-preview'); cbody.style.cssText = ''; }
    var csheet = clone.querySelector('.sheet');
    if (csheet) { csheet.style.zoom = ''; csheet.style.transform = ''; csheet.setAttribute('contenteditable', 'true'); }
    var dirty = (typeof window.__edIsDirty === 'function') ? window.__edIsDirty() : false;
    var cstate = clone.querySelector('#saveState');
    // emoji 用 \u 转义写（UI-7 断言：前端源码零 emoji 字面量）；运行时由注入层换成 SVG
    if (cstate) { cstate.dataset.state = dirty ? 'dirty' : 'saved'; cstate.textContent = dirty ? '未保存 \u25cf' : '已保存 \u2713'; }
    var csave = clone.querySelector('#saveBtn');
    if (csave) csave.removeAttribute('disabled');
    return '<!doctype html>\n' + clone.outerHTML;
  };

  // ===== 正文查找替换（job-panel / ai-panel 共用这一份）=====
  // 之前两个面板各抄了一份（2026-10-24 审查 [低]：三份实现，改一处要改三处；
  // 上一轮的「接受建议改错段落」缺陷就是两份副本都漏了锚点定位）。
  // opts.root：只在指定节点内找（zid 锚点）；opts.occurrence / opts.context：多处命中时消歧。
  window.__edReplaceText = function (before, after, opts) {
    opts = opts || {};
    var sheet = opts.sheet || document.querySelector('.sheet');
    if (!sheet) return false;
    var walker = document.createTreeWalker(opts.root || sheet, NodeFilter.SHOW_TEXT);
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
    // 程序化变更统一出口：走外壳的 __edMarkProgrammatic（撤销栈才能收这次改动）
    if (window.__edMarkProgrammatic) window.__edMarkProgrammatic();
    else sheet.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };

  // 目标顺序（appendChild 移动已有节点，幂等）
  if (toolbar) {
    [ltBtn, homeBtn, docName, verBadge].forEach(function (el) { if (el) toolbar.appendChild(el); });
    var spacer = toolbar.querySelector('.spacer');
    if (spacer) toolbar.appendChild(spacer);
    [jobBtn, geningBtn, saveState, saveBtn, histBtn, previewBtn, pdfBtn, keysBtn, rtBtn].forEach(function (el) { if (el) toolbar.appendChild(el); });
  }

  // ===== 左栏：章节导航 + 素材 =====
  var left = document.createElement('aside');
  left.id = 'ed-left';
  left.setAttribute('aria-label', '章节与素材');
  left.innerHTML = (JOB_INFO.hasJob
      ? '<div class="ed-label">目标岗位</div><div class="ed-jobtitle" id="ed-jobtitle"></div><div class="ed-divider"></div>'
      : '')
    + '<div class="ed-label">文档结构</div><div id="ed-navlist" role="list"></div>'
    + '<button type="button" class="ed-addsec" id="ed-addsec">＋ 添加章节</button>'
    + '<div class="ed-divider"></div>'
    + '<div class="ed-label">可用素材</div>'
    + '<input class="ed-mat-search" id="ed-matsearch" type="search" placeholder="搜索素材" aria-label="搜索素材">'
    + '<div id="ed-matlist"></div>';
  mount(left);
  if (JOB_INFO.hasJob) {
    var jt = left.querySelector('#ed-jobtitle');
    if (jt) jt.textContent = (JOB_INFO.company || '') + (JOB_INFO.role ? ' · ' + JOB_INFO.role : '');
  }

  var SEC_HIDE_CLS = 'ed-sec-hidden';
  var ENTRY_HIDE_CLS = 'ed-entry-hidden';
  // 隐藏章节/条目：屏幕与 PDF 同隐（内容保留在 DOM，可恢复）
  var hideCss = '.ed-sec-hidden{display:none}.ed-entry-hidden{display:none}';
  // 该规则需要进 PDF（隐藏章节不导出）→ 写进 typo 通道而非外壳 CSS（外壳 print 隐藏）。
  // 单独一个 style 块随正文落盘：
  var secStyle = document.getElementById('ed-sec-style');
  if (!secStyle) {
    secStyle = document.createElement('style');
    secStyle.id = 'ed-sec-style';
    document.head.appendChild(secStyle);
  }
  if (!secStyle.textContent.includes(SEC_HIDE_CLS)) secStyle.textContent = hideCss;

  // ===== S3：zid 生命周期（唯一生成点 = 本注入层；服务端 /save 归一是兜底）=====
  var ZID_SEL = '.sheet p, .sheet li, .sheet h1, .sheet h2, .sheet h3, .sheet h4, .sheet .entry-head, .sheet .contact';
  // 确定性 zid：内容哈希派生（全局约束 21）。未保存阶段两次加载生成相同 zid，
  // meta 已落的初绑 zones 不失配；落盘后 zid 固化在正文属性，textContent 再变也不重算。
  function edHashZid(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    return 'z' + ('00000000' + h.toString(16)).slice(-8);
  }
  window.__edEnsureZids = function () {
    var seen = {};
    Array.prototype.forEach.call(document.querySelectorAll(ZID_SEL), function (el) {
      var z = el.getAttribute('data-zid');
      if (!z) z = edHashZid(el.textContent || '');        // 缺失 → 内容哈希（确定性）
      if (seen[z]) {
        // 重复内容 → 按出现序号**确定性**派生，不是随机重打。
        // 随机会让「两条字面相同的段落」在每次加载拿到不同 zid：首次加载的 zid 已被
        // /zones/init 写进 docs-meta.json，刷新后即成无 DOM 节点的永久孤儿（区域 Tab 出现
        // 绑在不存在 zid 上的区域，AI 区域级改写找不到节点）。这违反 handoff §6「保证两次加载
        // 生成相同 zid、初绑 meta 不失配」。粘贴/克隆自带随机 zid 不重复，走不到这里（审查 B3）。
        var k = 1, cand;
        do { k++; cand = edHashZid((el.textContent || '') + ' ' + k); } while (seen[cand]);
        z = cand;
      }
      el.setAttribute('data-zid', z);
      seen[z] = 1;
    });
  };
  __edEnsureZids();
  // 初绑：meta 无 zones 时收集段落上送服务端启发式（全 pending，不静默生效）。参数名 ?id=（全局约束 19）
  fetch('/job/changes?id=' + encodeURIComponent(DOC_ID)).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.zones && Object.keys(d.zones).length) return;
    var secs = Array.prototype.map.call(document.querySelectorAll('.sheet section.section'), function (sec) {
      return { title: (sec.querySelector('.section-title') || {}).textContent || '', el: sec };
    });
    var entries = [];
    Array.prototype.forEach.call(document.querySelectorAll(ZID_SEL), function (el) {
      var sec = null;
      for (var i = 0; i < secs.length; i++) if (secs[i].el.contains(el)) { sec = secs[i]; break; }
      entries.push({ zid: el.getAttribute('data-zid'), sectionTitle: sec ? sec.title : '个人信息' });
    });
    return fetch('/zones/init?id=' + encodeURIComponent(DOC_ID), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: entries })
    });
  }).catch(function () {});

  function scanSections() {
    var list = [];
    var header = sheet.querySelector('.header');
    if (header) list.push({ el: header, title: '基本信息', titleEl: header, fixed: true });
    Array.prototype.forEach.call(sheet.querySelectorAll('.section'), function (sec, i) {
      var t = sec.querySelector('.section-title');
      list.push({ el: sec, title: t ? t.textContent.trim() : '章节 ' + (i + 1), titleEl: t });
    });
    return list;
  }
  // 条目级积木（项目/经历）：entry-head + 紧随的 ul（可能被隐藏）
  function scanEntries(secEl) {
    var out = [];
    if (!secEl || secEl.classList.contains(SEC_HIDE_CLS)) return out;
    Array.prototype.forEach.call(secEl.querySelectorAll('.entry-head'), function (head) {
      var ul = head.nextElementSibling && head.nextElementSibling.tagName === 'UL' ? head.nextElementSibling : null;
      var title = (head.querySelector('.entry-title') || {}).textContent || '';
      var role = (head.querySelector('.entry-role') || {}).textContent || '';
      out.push({ head: head, ul: ul, title: (title || role || '未命名条目').trim() });
    });
    return out;
  }

  // ===== 变更来源与统一撤销（设计 §6.1：一次 ⌘Z 撤销最近输入，定向撤销只对程序化操作）=====
  var undoStack = [];
  var nativeInputCount = 0;                 // 受信任 input 计数（真实打字 / IME 组合完成）
  var composing = false;                    // IME 组合中
  var opSeq = 0;                            // op 自增 id，Toast 据此绑定
  window.__edComposing = function () { return composing; };
  window.__edNativeInputCount = function () { return nativeInputCount; };

  // 程序化变更的唯一出口：外壳与 ai-panel / job-panel 共用（面板原先各自裸派发 input，无法归类）
  window.__edMarkProgrammatic = function () {
    sheet.dispatchEvent(new Event('input', { bubbles: true }));   // 保持既有 dirty 语义（isTrusted=false → 不计入原生输入）
    var top = undoStack[undoStack.length - 1];
    if (top && top.pending) { top.nativeCountAtApply = nativeInputCount; top.pending = false; }
  };
  function notifyEdit() { window.__edMarkProgrammatic(); }         // 既有一切调用点保持原义

  function snapshotState() {
    return { body: sheet.innerHTML, typo: window.__edGetTypo ? window.__edGetTypo() : '' };
  }
  function updateUndoBtn() {
    var btn = document.getElementById('ed-undo-btn');
    if (!btn) return;
    var top = undoStack[undoStack.length - 1];
    btn.style.display = top ? '' : 'none';
    btn.textContent = top ? ('↩ 撤销' + (top.label ? '「' + top.label + '」' : '')) : '';
    btn.title = top ? ('撤销最近一次操作：' + top.label) : '';
  }
  window.__edPushUndo = function (label) {
    opSeq++;
    undoStack.push({ id: opSeq, label: label || '', state: snapshotState(), nativeCountAtApply: null, pending: true });
    if (undoStack.length > 30) undoStack.shift();
    updateUndoBtn();
    return opSeq;
  };
  // 丢弃一条未生效的撤销记录（程序化替换失败时由调用方调用）：
  // 栈项 pending=true 时还没绑定 nativeCountAtApply，若不丢弃，下一次任何程序化变更
  // 都会把它误认成「已应用」→ 之后一次 ⌘Z 会回滚到错误基点。
  window.__edDropUndo = function (id) {
    for (var i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].id === id) { undoStack.splice(i, 1); updateUndoBtn(); return true; }
    }
    return false;
  };
  // 只有"该 op 之后没有新的受信任输入"时，⌘Z 才消费它；否则整片快照会吞掉后续文字
  function programmaticUndoSafeNow() {
    var top = undoStack[undoStack.length - 1];
    return !!top && top.nativeCountAtApply != null && nativeInputCount === top.nativeCountAtApply;
  }
  window.__edUndoLast = function (expectedId) {
    var top = undoStack[undoStack.length - 1];
    if (!top) return false;
    if (expectedId != null && top.id !== expectedId) return false;      // Toast 绑定的 op 已非栈顶 → 拒绝，绝不弹别人的
    // 确认门只看"被消费的这条 op 之后是否有受信任输入"，与入口无关（§6.1 line 95 点名工具条 / Toast 两个入口；
    // 旧实现 keyed on expectedId==null，Toast 恒带 id → 无确认整片 innerHTML 重写且打断原生撤销链，不可恢复）。
    if (!programmaticUndoSafeNow() &&
        !window.confirm('撤销「' + (top.label || '操作') + '」会回到该操作之前，其后的正文输入也会一并回退。确认撤销？')) return false;
    undoStack.pop();
    sheet.innerHTML = top.state.body;
    // 正文整片替换后旧的 .section-title 已脱离文档，而 IntersectionObserver 从不 unobserve →
    // 回调里 scanSections() 找不到匹配、best 恒 -1 → 左栏「当前章节」active 永久停摆（刷新才恢复）。
    // 因此每次替换后必须重建观察（2026-10-18 审查 P1-4）。
    observeTitles();
    if (window.__edSetTypo) window.__edSetTypo(top.state.typo);
    window.__edMarkProgrammatic();
    if (window.__edRefreshFind) window.__edRefreshFind();               // 正文已变：命中位置必须重算
    renderNav();
    updateUndoBtn();
    return true;
  };

  sheet.addEventListener('compositionstart', function () { composing = true; });
  sheet.addEventListener('compositionend', function () { composing = false; });
  sheet.addEventListener('input', function (e) {
    if (!e.isTrusted) return;                    // 合成事件（外壳与面板的程序化变更）不计
    // 计数随输入前进、随原生撤销（historyUndo）后退：⌘Z 交回原生（§6.1 line 87）把 op 之后的输入撤回到 op 应用时点后，等值判定重新成立 → 下一次 ⌘Z 恢复消费该 op。
    if (e.inputType === 'historyUndo') nativeInputCount = Math.max(0, nativeInputCount - 1);
    else nativeInputCount++;
    if (window.__edRefreshFind) window.__edRefreshFind();   // 内容一变即重算查找命中
    __edEnsureZids();                                       // S3：拆段/删段后补打点（无变化时是 no-op getAttribute 循环，微秒级）
  });
  // S3：粘贴插入的节点不在 input 事件里 → paste 后下一拍补打点
  sheet.addEventListener('paste', function () { setTimeout(__edEnsureZids, 0); });

  // ===== S2-T7 C1：离线恢复（template.html「恢复这份修改」）× 撤销栈重排基线 =====
  // 恢复路径整片替换 sheet.innerHTML 且不派发任何事件（template.html 冻结，无法在里面通知外壳），
  // 栈里替换前的快照全部失效且危险：⌘Z（此时 programmaticUndoSafeNow 成立）会静默回滚恢复内容，
  // 回滚又触发 __edMarkProgrammatic → markDirty → writeCache，用回滚后的正文覆盖恢复缓存 → 永久丢失（终审已复现）。
  // 检测方式：document capture 阶段监听 .recovery-bar 按钮点击（含 conflict-bar，它同样带 recovery-bar 类），
  // 本次点击的同步派发跑完后（setTimeout 0，必然晚于按钮内联 onclick）比对 sheet.innerHTML 是否被换掉，
  // 换了才清栈——「丢弃」/「强制保存」不换正文，不误清；普通打字与外壳自身的程序化操作不会点击恢复条，
  // 不可能触发本监听。不选 MutationObserver：sheet 的 childList 变更（增删章节/条目、__edUndoLast 自身
  // 回滚、冲突条"加载服务器版本"）与恢复替换在观察者眼里同形，无法归因，会违反"不得在外壳自身程序化
  // 操作期间清栈"的要求。
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('.recovery-bar button') : null;
    if (!btn) return;
    var bodyBefore = sheet.innerHTML;
    setTimeout(function () {
      if (sheet.innerHTML === bodyBefore) return;   // 正文未被整片替换 → 栈仍有意义，不动
      undoStack.length = 0;                          // 重排基线：替换前的任何快照都不许再被消费
      updateUndoBtn();                               // 工具条「↩ 撤销」随空栈隐藏
    }, 0);
  }, true);
  // ⌘S 门控：文档内联监听是 document 的 bubble 阶段，capture 必然先跑 → 组合期直接截断（template.html 不改）
  document.addEventListener('keydown', function (e) {
    if (!(e.metaKey || e.ctrlKey) || String(e.key).toLowerCase() !== 's') return;
    if (composing || e.isComposing) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('keydown', function (e) {
    if (composing || e.isComposing) return;                       // IME 组合期一律不触发外壳快捷键
    var mod = e.metaKey || e.ctrlKey;
    var k = String(e.key).toLowerCase();
    var t = e.target;
    // 打字进用户文档永远优先：光标在正文（contenteditable，含其内部节点）或任何输入控件里时，
    // '?' 是正常字符，绝不开弹层；弹层入口 = ⌘/（任意焦点，与打字永不冲突）+ 工具条「?」按钮。
    var inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
    // ⌘Z 护栏（S2-T7 I2，台账既定裁决"⌘Z 加 INPUT/TEXTAREA 判定"）：焦点在表单控件里时 ⌘Z 属于该控件
    // （浏览器原生字段撤销），外壳绝不消费程序化 op——否则查找框里一个 ⌘Z 会静默改写整篇正文。
    // 注意与 inField 的差别：sheet 本身是 contenteditable（DIV），正文里的 ⌘Z 仍走下面的消费/交回原生判定。
    var inTextField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (mod && !e.shiftKey && k === 'z') {
      // §6.1 line 87：仅当"该 op 之后没有新的受信任输入"时才消费栈顶；否则**不拦截**，
      // 原样交回浏览器原生撤销——原生撤销恰好逐字回退 op 之后的输入（⌘⇧Z 可重做），
      // 程序化 op 保留在栈上走工具条/Toast 入口（带 window.confirm 显式确认）。
      if (!inTextField && programmaticUndoSafeNow()) { e.preventDefault(); window.__edUndoLast(); }
      return;
    }
    if (mod && !e.shiftKey && k === 'f') { e.preventDefault(); openFindPanel(); return; }
    if (mod && e.shiftKey && k === 'f') { e.preventDefault(); toggleFocusMode(); return; }
    if (mod && !e.shiftKey && k === '/') { e.preventDefault(); toggleShortcutHelp(); return; }   // ⌘/：任意焦点下开快捷键弹层（不与打字冲突）
    // 真实键盘 Shift+/ 上报 key='?'；部分合成输入路径（Playwright press('Shift+/') 实测）上报 key='/' + shiftKey=true → 两种形态都认
    if (!mod && (e.key === '?' || (e.key === '/' && e.shiftKey)) && !inField) { e.preventDefault(); toggleShortcutHelp(true); return; }
    if (e.key === 'Escape') {
      // Esc 只关最上层（S2-T7 M6）：素材/岗位弹层 > 快捷键帮助 > 查找面板 > 窄屏浮层（后者由更晚注册的监听自理）。
      // 弹层开着时本次 Esc 归弹层：其自身监听（下方）负责关闭并 stopImmediatePropagation。
      // 旧实现无条件 toggleShortcutHelp(false)+closeFindPanel()——关弹层的同一次 Esc 会连带清掉查找面板
      // （丢失查询词）与快捷键帮助；弹层 handler 里的 stopPropagation 拦不住同节点上更早注册的本监听。
      // 关闭一层即 stopImmediatePropagation：同一次 Esc 不再穿透到窄屏浮层监听，保证单层语义。
      if ((matpop && matpop.style.display === 'block') || (jobpop && jobpop.style.display === 'block')) return;
      if (document.getElementById('ed-keys')) { e.stopImmediatePropagation(); toggleShortcutHelp(false); return; }
      if (findPanel) { e.stopImmediatePropagation(); closeFindPanel(); return; }
    }
  });

  var navlist = left.querySelector('#ed-navlist');
  function setEntryHidden(entry, hidden) {
    entry.head.classList.toggle(ENTRY_HIDE_CLS, hidden);
    if (entry.ul) entry.ul.classList.toggle(ENTRY_HIDE_CLS, hidden);
  }
  function renderNav() {
    var secs = scanSections();
    navlist.innerHTML = '';
    if (!secs.length) {
      var c = document.createElement('div');
      c.className = 'ed-compat';
      c.textContent = '此文档暂无法识别章节结构，以兼容模式展示全文。章节工具不可用，内容可直接在正文编辑。';
      navlist.appendChild(c);
      var addBtn0 = left.querySelector('#ed-addsec');
      if (addBtn0) addBtn0.style.display = 'none';
      return;
    }
    var addBtn2 = left.querySelector('#ed-addsec');
    if (addBtn2) addBtn2.style.display = '';
    secs.forEach(function (s, i) {
      var wrap = document.createElement('div');
      wrap.className = 'ed-navwrap';
      var item = document.createElement('div');
      item.className = 'ed-nav' + (s.el.classList.contains(SEC_HIDE_CLS) ? ' ed-sec-off' : '');
      item.setAttribute('role', 'listitem');
      item.tabIndex = 0;
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'ed-nav-name ed-nav-go';
      go.textContent = s.title;
      go.setAttribute('aria-label', '定位到章节：' + s.title);
      var focusSection = function () {
        navLockUntil = Date.now() + 1000;
        s.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        flashEl(s.el);
        setActiveNav(item);
      };
      go.addEventListener('click', function (e) { e.stopPropagation(); focusSection(); });
      item.appendChild(go);
      var ops = document.createElement('span');
      ops.className = 'ed-nav-ops';
      // ↑ 上移 / ↓ 下移 / 显隐（隐藏不删内容）；基本信息为固定抬头，不参与管理
      if (!s.fixed) {
        var upAble = i > 1;  // i=0 是基本信息
        [['↑', '上移章节', upAble], ['↓', '下移章节', i < secs.length - 1]].forEach(function (op) {
          if (!op[2]) return;
          var b = document.createElement('button');
          b.type = 'button';
          b.textContent = op[0];
          b.title = op[1];
          b.setAttribute('aria-label', op[1] + '：' + s.title);
          b.addEventListener('click', function (e) {
            e.stopPropagation();
            window.__edPushUndo(op[1]);
            if (op[0] === '↑' && s.el.previousElementSibling) sheet.insertBefore(s.el, s.el.previousElementSibling);
            if (op[0] === '↓' && s.el.nextElementSibling) sheet.insertBefore(s.el.nextElementSibling, s.el);
            notifyEdit(); renderNav();
          });
          ops.appendChild(b);
        });
        var eye = document.createElement('button');
        eye.type = 'button';
        eye.textContent = s.el.classList.contains(SEC_HIDE_CLS) ? '显' : '隐';
        eye.title = (s.el.classList.contains(SEC_HIDE_CLS) ? '显示' : '隐藏') + '该章节（不删除内容，PDF 同步' + (s.el.classList.contains(SEC_HIDE_CLS) ? '恢复' : '隐藏') + '）';
        eye.setAttribute('aria-label', eye.title);
        eye.addEventListener('click', function (e) {
          e.stopPropagation();
          window.__edPushUndo(s.el.classList.contains(SEC_HIDE_CLS) ? '显示章节' : '隐藏章节');
          s.el.classList.toggle(SEC_HIDE_CLS);
          notifyEdit(); renderNav();
        });
        ops.appendChild(eye);
      }
      item.appendChild(ops);
      item.addEventListener('click', focusSection);
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusSection(); }
      });
      wrap.appendChild(item);
      // 条目级积木：项目/经历的排序与隐藏（岗位定制常用）
      var entries = s.fixed ? [] : scanEntries(s.el);
      if (entries.length) {
        var sub = document.createElement('div');
        sub.className = 'ed-nav-entries';
        entries.forEach(function (en, idx) {
          var off = en.head.classList.contains(ENTRY_HIDE_CLS);
          var row = document.createElement('div');
          row.className = 'ed-nav-entry' + (off ? ' ed-entry-off' : '');
          var label = document.createElement('span');
          label.className = 'ed-entry-name';
          label.textContent = en.title;
          label.title = en.title;
          row.appendChild(label);
          var eops = document.createElement('span');
          eops.className = 'ed-nav-ops';
          var mk = function (txt, title, fn, disabled) {
            if (disabled) return;
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = txt;
            b.title = title;
            b.setAttribute('aria-label', title + '：' + en.title);
            b.addEventListener('click', function (e) { e.stopPropagation(); window.__edPushUndo(title); fn(); notifyEdit(); renderNav(); });
            eops.appendChild(b);
          };
          mk(off ? '显' : '隐', (off ? '显示' : '隐藏') + '该条目（不删除内容，PDF 同步）', function () {
            setEntryHidden(en, !off);
          }, false);
          // S4a-T11：复制/删除/排序收进 ⋯ 菜单——键盘可达（Tab 聚焦 + Enter 展开 + Esc 关闭 + 方向键导航）
          // 条目节点是 .section 的后代而非 .sheet 直接子节点，insertBefore 的 ref 必须是同一 parent 的子节点
          // （否则必抛 NotFoundError）；parentNode 不一致说明跨章节，不移动（同 dupEntry 的 parent 用法）
          var moveUp = function () {
            var prev = entries[idx - 1];
            if (!prev || prev.head.parentNode !== en.head.parentNode) return;
            var p = en.head.parentNode;
            p.insertBefore(en.head, prev.head);
            if (en.ul) p.insertBefore(en.ul, prev.head);
          };
          var moveDown = function () {
            var next = entries[idx + 1];
            if (!next || next.head.parentNode !== en.head.parentNode) return;
            var p = en.head.parentNode;
            p.insertBefore(next.head, en.head);
            if (next.ul) p.insertBefore(next.ul, en.head);
          };
          var more = document.createElement('button');
          more.type = 'button';
          more.className = 'ed-nav-more';
          more.textContent = '⋯';
          more.title = '条目操作（上移/下移/复制/删除）';
          more.setAttribute('aria-haspopup', 'true');
          more.setAttribute('aria-expanded', 'false');
          var menu = document.createElement('div');
          menu.className = 'ed-nav-menu';
          menu.hidden = true;
          menu.setAttribute('role', 'menu');
          var closeMenu = function () { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); };
          var mkItem = function (glyph, name, fn, dis) {
            var b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'menuitem');
            // glyph 可以是文本符号（↑↓⧉），也可以是服务端下发的内联 SVG 图标 → 统一走 innerHTML
            b.innerHTML = glyph + ' ' + escHtml(name);
            b.title = name;
            b.setAttribute('aria-label', name + '：' + en.title);   // 与旧内联按钮同契约（mk：title+'：'+条目名）
            if (dis) b.disabled = true;
            // 与 mk 同一包装：压栈 → 执行 → 通知编辑 → 重绘导航（缺压栈会丢撤销能力）
            b.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); window.__edPushUndo(name); fn(); notifyEdit(); renderNav(); });
            return b;
          };
          menu.appendChild(mkItem('↑', '上移条目', moveUp, idx === 0));
          menu.appendChild(mkItem('↓', '下移条目', moveDown, idx === entries.length - 1));
          menu.appendChild(mkItem('⧉', '复制条目', function () { dupEntry(en); }));   // mk 已内置压栈+通知（S2-T5 语义不变）
          menu.appendChild(mkItem(__icon('trash-2'), '删除条目', function () { delEntry(en); }));
          more.addEventListener('click', function () {
            var opening = menu.hidden;
            menu.hidden = !opening;
            more.setAttribute('aria-expanded', String(opening));
            if (opening) { var f = menu.querySelector('button:not([disabled])'); if (f) f.focus(); }
          });
          more.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown' && !menu.hidden) { e.preventDefault(); var f = menu.querySelector('button:not([disabled])'); if (f) f.focus(); }
          });
          menu.addEventListener('keydown', function (e) {
            var items = Array.prototype.filter.call(menu.querySelectorAll('button'), function (b) { return !b.disabled; });
            var i = items.indexOf(document.activeElement);
            if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
            else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); more.focus(); }
          });
          eops.appendChild(more);
          eops.appendChild(menu);
          row.appendChild(eops);
          sub.appendChild(row);
        });
        wrap.appendChild(sub);
      }
      navlist.appendChild(wrap);
    });
  }
  var navLockUntil = 0;
  function setActiveNav(item) {
    navlist.querySelectorAll('.ed-nav').forEach(function (n) {
      var on = n === item;
      n.classList.toggle('active', on);
      if (on) n.setAttribute('aria-current', 'true'); else n.removeAttribute('aria-current');
    });
  }
  // 定位闪记：CSS Custom Highlight API（零 DOM 变更 → 瞬态不落盘；不支持时只滚动定位，不降级为 class）
  function flashEl(el) {
    if (!el) return;
    var smooth = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    try { el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' }); } catch (e) { }
    if (!HL_OK) return;
    var r = document.createRange();
    r.selectNodeContents(el);
    if (flashHl) flashHl.add(r); else { flashHl = new Highlight(r); CSS.highlights.set('ed-flash', flashHl); }
    setTimeout(function () { CSS.highlights.delete('ed-flash'); flashHl = null; }, 1300);
  }
  window.__edFlashForTest = flashEl;   // 测试可见入口：证明 flash 不再往正文挂 class（非行为钩子）

  // 条目复制/删除：mk() 已内置压栈（label=title）+ notifyEdit + renderNav，这里只做 DOM 与 Toast
  function stripIds(el) { el.removeAttribute('id'); el.querySelectorAll('[id]').forEach(function (x) { x.removeAttribute('id'); }); }
  function dupEntry(en) {
    var parent = en.head.parentNode;
    var ref = en.ul ? en.ul.nextSibling : en.head.nextSibling;
    var headCopy = en.head.cloneNode(true); stripIds(headCopy);
    parent.insertBefore(headCopy, ref);
    if (en.ul) { var ulCopy = en.ul.cloneNode(true); stripIds(ulCopy); parent.insertBefore(ulCopy, headCopy.nextSibling); }
    __edEnsureZids();                                     // 克隆带原 zid → 去重逻辑随机重打副本
    undoToast('已复制条目');                              // 无 opId → 绑定刚压入的栈顶
  }
  function delEntry(en) {
    if (en.ul) en.ul.remove();
    en.head.remove();
    undoToast('已删除条目（可撤销）');
  }

  // ===== 基础格式：一律走浏览器原生 execCommand（参与原生撤销；不压整片快照栈——§6.1）=====
  function shellToast(msg) {                   // template.html 的 toast() 在其 IIFE 私有作用域，注入脚本取不到
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');   // A8：读屏可感知
    t.textContent = msg;
    mount(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 400); }, 2500);
  }
  var SAFE_URL = /^(?:https?:|mailto:)/i;
  function normalizeUrl(u) { return String(u).replace(/[\u0000-\u0020\u00a0]/g, ''); }   // 去空白/控制字符，防 java\tscript: 绕过
  function runFormat(cmd) {
    sheet.focus();
    if (cmd === 'createLink') {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) { shellToast('先选中要加链接的文字'); return; }
      var u = window.prompt('链接地址（仅 http/https/mailto）', 'https://');
      if (u === null) return;
      var v = normalizeUrl(u);
      if (!SAFE_URL.test(v)) { shellToast('已拒绝：仅允许 http/https/mailto 链接'); return; }
      document.execCommand('createLink', false, v);
      return;
    }
    document.execCommand(cmd, false, null);
  }
  var fmtWrap = document.createElement('span');
  fmtWrap.setAttribute('data-ed-inj', '1');
  fmtWrap.className = 'ed-fmt';
  [['B', 'bold', '加粗'], ['•', 'insertUnorderedList', '无序列表'], [__icon('link'), 'createLink', '插入链接（仅 http/https/mailto）'], ['⌫', 'removeFormat', '清除多余格式']].forEach(function (b) {
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'secondary'; btn.innerHTML = b[0]; btn.title = b[2];
    btn.setAttribute('aria-label', b[2]);   // 可访问名不能只是符号本身（2026-10-22 审查 [低]）
    btn.setAttribute('data-fmt', b[1]);
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 不抢焦点/选区：execCommand 作用于正文当前选区
    btn.addEventListener('click', function () { runFormat(b[1]); });
    fmtWrap.appendChild(btn);
  });
  if (toolbar) toolbar.insertBefore(fmtWrap, toolbar.querySelector('.spacer') || null);

  // ===== 文内查找替换：每个正文块一条独立文本流（跨 <b> 允许、跨块禁止）；高亮走 Highlight API 不改 DOM =====
  var findPanel = null, findHits = [], findCur = -1, findQuery = '';
  var BLOCK_RE = /^(P|LI|H[1-4]|TD|TH|PRE|BLOCKQUOTE|DD|DT)$/;
  var SKIP_RE = /(^|[^a-z])(page-line|ed-find|ed-keys|ed-matpop|ed-matmask|ed-jobpop|ed-jobmask)([^a-z]|$)/;

  function blockOf(textNode) {                       // 最近的块级祖先；.sheet 直接子节点也视为块
    var el = textNode.parentNode;
    while (el && el !== sheet) {
      if (BLOCK_RE.test(el.tagName)) return el;
      if (el.parentElement === sheet) return el;
      el = el.parentElement;
    }
    return null;
  }
  function inChrome(el) {                            // 排除外壳/瞬态节点里的文本
    var x = el;
    while (x && x !== sheet) {
      if (x.nodeType === 1) {
        if (x.hasAttribute && (x.hasAttribute('data-ed-inj') || x.hasAttribute('data-ed-shell'))) return true;
        if (x.className && SKIP_RE.test(String(x.className))) return true;
      }
      x = x.parentElement;
    }
    return false;
  }
  function streamBlocks() {                          // 命中只可能落在单个正文块内
    // 块身份按元素同一性线性查找：普通对象键会把 Element 串化成 '[object HTML…]'，
    // 同名标签全部并进一条流 → 制造跨块假命中（简报草案的 byEl[blk] 即此缺陷）
    var walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT), blocks = [], n;
    while ((n = walker.nextNode())) {
      if (!n.data) continue;
      var blk = blockOf(n);
      if (!blk || inChrome(n.parentNode)) continue;
      var cur = null;
      for (var i = 0; i < blocks.length; i++) { if (blocks[i].el === blk) { cur = blocks[i]; break; } }
      if (!cur) { cur = { el: blk, nodes: [], stream: '' }; blocks.push(cur); }
      cur.nodes.push({ node: n, start: cur.stream.length });
      cur.stream += n.data;
    }
    return blocks;
  }
  function locate(blk, pos) {
    for (var i = 0; i < blk.nodes.length; i++) {
      var cur = blk.nodes[i], next = i + 1 < blk.nodes.length ? blk.nodes[i + 1].start : Infinity;
      if (pos >= cur.start && pos < next) return { node: cur.node, offset: pos - cur.start };
    }
    var last = blk.nodes[blk.nodes.length - 1];
    return last ? { node: last.node, offset: last.node.data.length } : null;
  }
  function rangeIn(blk, from, to) {                  // Range 完全落在同一块内 → deleteContents 不会跨块删结构
    var a = locate(blk, from), b = locate(blk, Math.max(from, to - 1));
    if (!a || !b) return null;
    var r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, Math.min(b.offset + 1, b.node.data.length));
    return r;
  }
  function collectHits(q) {                          // 每次都用当前 DOM 现算，杜绝过期偏移
    var hits = [];
    if (!q) return hits;
    streamBlocks().forEach(function (blk) {
      var idx = blk.stream.indexOf(q);
      while (idx >= 0) { hits.push({ el: blk.el, blk: blk, from: idx, to: idx + q.length }); idx = blk.stream.indexOf(q, idx + q.length); }
    });
    return hits;
  }
  function paintFind() {
    if (!HL_OK) return;
    CSS.highlights.delete('ed-find-cur');
    var hl = null;
    findHits.forEach(function (h, i) {
      var r = rangeIn(h.blk, h.from, h.to);
      if (!r) return;
      if (i === findCur) { CSS.highlights.set('ed-find-cur', new Highlight(r)); }
      if (hl) hl.add(r); else hl = new Highlight(r);
    });
    if (hl) CSS.highlights.set('ed-find', hl); else CSS.highlights.delete('ed-find');
  }
  function clearFindPaint() { if (HL_OK) { CSS.highlights.delete('ed-find'); CSS.highlights.delete('ed-find-cur'); } }
  function refreshFind(silent) {                     // 内容变化后重算；命中数变化即回显
    var q = findQuery;
    findHits = q ? collectHits(q) : [];
    if (findCur >= findHits.length) findCur = findHits.length ? 0 : -1;
    if (findCur < 0 && findHits.length) findCur = 0;   // 正文打字重算出新命中：指向第一处（否则计数显示 0/N、「替换当前」空转）
    paintFind();
    var c = document.getElementById('ed-find-count');
    if (c) c.textContent = findHits.length ? (findCur + 1) + '/' + findHits.length : '0/0';
    else if (!silent) { /* 面板未开：无需回显 */ }
  }
  window.__edRefreshFind = function () { refreshFind(true); };
  function gotoHit(d) {
    if (!findHits.length) return;
    findCur = (findCur + d + findHits.length) % findHits.length;
    paintFind();
    var h = findHits[findCur], r = rangeIn(h.blk, h.from, h.to);
    if (r && r.startContainer.parentNode && r.startContainer.parentNode.scrollIntoView) r.startContainer.parentNode.scrollIntoView({ block: 'center' });
    var c = document.getElementById('ed-find-count');
    if (c) c.textContent = (findCur + 1) + '/' + findHits.length;
  }
  function pruneEmpty(r) {
    var c = r.commonAncestorContainer;
    var host = c && c.nodeType === 1 ? c : (c ? c.parentNode : null);
    if (host && host.querySelectorAll) host.querySelectorAll('b:empty,strong:empty,em:empty,i:empty,span:empty').forEach(function (el) { el.remove(); });
  }
  function applyReplacements(q, to, hitList) {        // 替换前逐个二次校验，任一不符即整体中止（不静默错删）
    var done = 0;
    for (var i = hitList.length - 1; i >= 0; i--) {   // 从后往前，块内偏移不失效
      var h = hitList[i], fresh = collectHits(q), match = null;
      for (var j = 0; j < fresh.length; j++) {
        // 二次校验按"元素同一性 + 偏移"匹配（重算出的块对象是新实例，不能按块对象比较）
        if (fresh[j].el === h.el && fresh[j].from === h.from) { match = fresh[j]; break; }
      }
      if (!match) return { done: done, stale: true };      // 位置已漂移：放弃本次，让调用方重算
      if (match.blk.stream.substr(match.from, q.length) !== q) return { done: done, stale: true };
      var r = rangeIn(match.blk, match.from, match.to);
      if (!r) continue;
      r.deleteContents();
      r.insertNode(document.createTextNode(to));
      pruneEmpty(r);
      done++;
    }
    return { done: done, stale: false };
  }
  function replaceOne() {
    if (findCur < 0 || !findHits[findCur]) return;
    var q = findQuery, to = document.getElementById('ed-find-r').value;
    var opId = window.__edPushUndo('替换');                // 快照必须在改动之前（改动后再压栈，撤销就变成无操作）
    var res = applyReplacements(q, to, [findHits[findCur]]);
    notifyEdit();
    refreshFind();
    if (res.stale) { window.__edUndoLast(opId); shellToast('正文已变化，已重新计算命中位置'); }
  }
  function replaceAll() {
    var q = findQuery, to = document.getElementById('ed-find-r').value;
    var hits = collectHits(q);                        // 用当下现算，不用缓存
    if (!hits.length) { refreshFind(); return; }
    var opId = window.__edPushUndo('替换全部（' + hits.length + ' 处）');
    var res = applyReplacements(q, to, hits);
    notifyEdit();
    refreshFind();
    if (res.stale) { window.__edUndoLast(opId); shellToast('正文已变化，未执行替换'); return; }
    undoToast('已替换全部', opId);
  }
  function openFindPanel() {
    if (findPanel) { var q0 = document.getElementById('ed-find-q'); if (q0) q0.focus(); return; }
    findPanel = document.createElement('div');
    findPanel.id = 'ed-find';
    findPanel.setAttribute('data-ed-inj', '1');
    findPanel.innerHTML = ''
      + '<input id="ed-find-q" placeholder="查找（当前正文）" aria-label="查找">'
      + '<input id="ed-find-r" placeholder="替换为" aria-label="替换为">'
      + '<span id="ed-find-count" role="status">0/0</span>'
      + '<button type="button" id="ed-find-prev" class="secondary" title="上一处" aria-label="上一处">↑</button>'
      + '<button type="button" id="ed-find-next" class="secondary" title="下一处" aria-label="下一处">↓</button>'
      + '<button type="button" id="ed-find-one" title="替换当前一处">替换</button>'
      + '<button type="button" id="ed-find-all" title="全部替换（一次撤销）">全部替换</button>'
      + '<button type="button" id="ed-find-close" class="secondary" title="关闭（Esc）">' + (__icon('x') || '×') + '</button>'
      + (HL_OK ? '' : '<span style="font-size:11px">此浏览器不支持高亮，仅计数与跳转</span>');
    mount(findPanel);
    document.getElementById('ed-find-q').addEventListener('input', function () {
      findQuery = this.value; findCur = 0; refreshFind();
    });
    document.getElementById('ed-find-prev').addEventListener('click', function () { gotoHit(-1); });
    document.getElementById('ed-find-next').addEventListener('click', function () { gotoHit(1); });
    document.getElementById('ed-find-one').addEventListener('click', replaceOne);
    document.getElementById('ed-find-all').addEventListener('click', replaceAll);
    document.getElementById('ed-find-close').addEventListener('click', closeFindPanel);
    document.getElementById('ed-find-q').focus();
  }
  function closeFindPanel() {
    clearFindPaint();
    if (findPanel) { findPanel.remove(); findPanel = null; }
    findHits = []; findCur = -1; findQuery = '';
  }
  window.__edOpenFind = openFindPanel;
  window.__edCloseFind = closeFindPanel;

  // ===== 聚焦编辑 + 快捷键提示弹层（都是瞬态：mount 进 SHELL-INJECT 注释对 /save 剥离；ed-focus 由服务端归一化兜底）=====
  function toggleFocusMode() {
    var on = !document.body.classList.contains('ed-focus');
    document.body.classList.toggle('ed-focus', on);
    if (window.__edPersistUiSoon) window.__edPersistUiSoon();
    shellToast(on ? '聚焦编辑：已收起左右栏（⌘⇧F 退出）' : '已退出聚焦编辑');
  }
  window.__edToggleFocus = toggleFocusMode;
  window.__edFocusMode = function () { return document.body.classList.contains('ed-focus'); };
  var KEYS = [['⌘S', '保存'], ['⌘F', '文内查找替换'], ['⌘Z', '撤销该操作（仅当它之后没有新的正文输入；否则 ⌘Z 交回浏览器原生撤销。焦点在输入框里时 ⌘Z 永远属于输入框）'],
    ['⌘⇧F', '聚焦编辑'], ['⌘/', '本快捷键提示（焦点既不在正文、也不在输入框时按 ? 亦可；在正文或输入框里 ? 就是正常打字）'], ['Esc', '关闭最上层弹层（一次只关一层）'],
    ['（说明）', '打字与加粗等格式操作由浏览器原生撤销接管；条目复制/删除、替换、排序、AI/审阅落盘等程序化改动走「↩ 撤销」按钮或 ⌘Z（该操作之后无新输入时）；排版调整不进撤销栈，用排版面板「恢复默认排版」还原']];
  function toggleShortcutHelp(show) {
    var ex = document.getElementById('ed-keys');
    if (show === false || ex) { if (ex) ex.remove(); return; }   // 幂等：未打开时直接返回（Esc 分支共用）
    var d = document.createElement('div');
    d.id = 'ed-keys'; d.setAttribute('data-ed-inj', '1'); d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', '快捷键提示'); d.setAttribute('tabindex', '-1');
    d.innerHTML = '<b>快捷键</b><ul>' + KEYS.map(function (k) { return '<li><kbd>' + k[0] + '</kbd><span>' + k[1] + '</span></li>'; }).join('') + '</ul>';
    mount(d); d.focus();
  }
  window.__edOpenShortcutHelp = function () { toggleShortcutHelp(true); };
  renderNav();

  // 滚动同步当前章节（sheet 内部滚动；取观察带内最靠上的章节，底部排除带收窄让末节可命中）
  var navTimer = null;
  var io = null;
  function observeTitles() {
    if (!io) return;
    io.disconnect();   // 必须先断开：撤销/重渲染后旧 title 节点已脱离文档，不清会一直观察游离节点（审查 P1-4）
    scanSections().forEach(function (s) { if (s.titleEl) io.observe(s.titleEl); });
  }
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(function (entries) {
      if (navTimer) return;
      navTimer = setTimeout(function () {
        navTimer = null;
        if (Date.now() < navLockUntil) return;  // 点击定位滚动中，不抢 active
        var secs = scanSections();
        var navs = navlist.querySelectorAll('.ed-nav');
        var best = -1;
        entries.forEach(function (en) {
          if (!en.isIntersecting) return;
          var idx = secs.findIndex(function (s) { return s.el === en.target || s.el.contains(en.target); });
          if (idx >= 0 && (best < 0 || idx < best)) best = idx;
        });
        if (best >= 0 && navs[best]) setActiveNav(navs[best]);
      }, 120);
    }, { root: sheet, rootMargin: '-8px 0px -45% 0px' });
    observeTitles();
  }

  // 添加章节（追加到末尾，结构同模板）
  left.querySelector('#ed-addsec').addEventListener('click', function () {
    var name = prompt('新章节名称', '自定义章节');
    if (!name || !name.trim()) return;
    window.__edPushUndo('添加章节');   // S2-T5：插入 DOM 之前压栈（下方 notifyEdit 完成 op 时间戳）
    var sec = document.createElement('section');
    sec.className = 'section';
    var t = document.createElement('div');
    t.className = 'section-title';
    t.textContent = name.trim();
    var p = document.createElement('p');
    p.textContent = '点击编辑内容…';
    sec.appendChild(t); sec.appendChild(p);
    sheet.appendChild(sec);
    __edEnsureZids();                                   // S3：程序化插入的段落补打点（T3 quality Note 1）
    notifyEdit(); renderNav(); observeTitles();
    sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  // 素材列表 + 搜索
  var matlist = left.querySelector('#ed-matlist');
  function matTypes(m) {
    var t = [];
    if (m.brief) t.push('精简');
    if (m.technical) t.push('技术');
    if (m.interview) t.push('面试');
    return t.join(' / ') || '—';
  }
  function renderMats(q) {
    matlist.innerHTML = '';
    var list = MATS.filter(function (m) {
      return !q || (m.title + ' ' + (m.tags || []).join(' ') + ' ' + m.brief).toLowerCase().includes(q);
    });
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'ed-compat';
      empty.textContent = MATS.length ? '无匹配素材' : '暂无素材，先到「素材库」页添加';
      matlist.appendChild(empty);
      return;
    }
    list.forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'ed-mat';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', '插入素材：' + m.title + (m.confirmed === true ? '' : '（待确认）'));
      var b = document.createElement('b');
      b.textContent = m.title;
      if (m.confirmed !== true) {
        var unconf = document.createElement('span');
        unconf.className = 'ed-mat-unconf';
        unconf.textContent = '待确认';
        b.appendChild(unconf);
      }
      var sm = document.createElement('small');
      sm.textContent = (m.tags || []).join(' · ') + (m.tags && m.tags.length ? '｜' : '') + matTypes(m);
      card.appendChild(b); card.appendChild(sm);
      card.addEventListener('click', function () { openMatPop(m, card); });
      card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMatPop(m, card); } });
      matlist.appendChild(card);
    });
  }
  renderMats('');
  left.querySelector('#ed-matsearch').addEventListener('input', function () { renderMats(this.value.trim().toLowerCase()); });

  // ===== 素材选择器（预览 → 选表达 → 选章节 → 插入，可撤销）=====
  var matmask = document.createElement('div');
  matmask.id = 'ed-matmask';
  mount(matmask);
  var matpop = document.createElement('div');
  matpop.id = 'ed-matpop';
  matpop.setAttribute('role', 'dialog');
  matpop.setAttribute('aria-modal', 'true');
  matpop.setAttribute('aria-label', '插入素材');
  mount(matpop);
  var matpopLastFocus = null;

  function openMatPop(m, fromEl) {
    var secs = scanSections();
    if (!secs.length) return;
    matpopLastFocus = fromEl || document.activeElement;
    var typeKey = m.brief ? 'brief' : (m.technical ? 'technical' : 'interview');
    var targetIdx = secs.length - 1;
    matpop.innerHTML = '';
    var h = document.createElement('h3');
    h.textContent = '插入素材：' + m.title;
    var secTypes = document.createElement('div');
    secTypes.className = 'ed-matpop-sec';
    var lab1 = document.createElement('div');
    lab1.className = 'ed-matpop-label';
    lab1.textContent = '选择表达';
    var types = document.createElement('div');
    types.className = 'ed-mattypes';
    var prev = document.createElement('div');
    prev.className = 'ed-matprev';
    function setType(k) {
      typeKey = k;
      prev.textContent = m[k] || '（此表达为空）';
      types.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.k === k); });
    }
    [['brief', '精简表达'], ['technical', '技术表达'], ['interview', '面试讲述']].forEach(function (pair) {
      if (!m[pair[0]]) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.dataset.k = pair[0];
      b.textContent = pair[1];
      b.addEventListener('click', function () { setType(pair[0]); });
      types.appendChild(b);
    });
    secTypes.appendChild(lab1); secTypes.appendChild(types);
    var secPrev = document.createElement('div');
    secPrev.className = 'ed-matpop-sec';
    var lab2 = document.createElement('div');
    lab2.className = 'ed-matpop-label';
    lab2.textContent = '内容预览';
    secPrev.appendChild(lab2); secPrev.appendChild(prev);
    var secTarget = document.createElement('div');
    secTarget.className = 'ed-matpop-sec';
    var lab3 = document.createElement('label');
    lab3.className = 'ed-matpop-label';
    lab3.textContent = '插入到章节';
    lab3.htmlFor = 'ed-mat-target';
    var sel = document.createElement('select');
    sel.id = 'ed-mat-target';
    secs.forEach(function (s, i) {
      var o = document.createElement('option');
      o.value = i;
      o.textContent = s.title;
      sel.appendChild(o);
    });
    sel.value = String(targetIdx);
    secTarget.appendChild(lab3); secTarget.appendChild(sel);
    var row = document.createElement('div');
    row.className = 'ed-matrow';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeMatPop);
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ed-primary';
    ok.textContent = '插入';
    ok.addEventListener('click', function () {
      var text = (m[typeKey] || '').trim();
      if (!text) return;
      var sec = secs[Number(sel.value)];
      if (!sec) return;
      insertIntoSection(sec.el, text);
      closeMatPop();
    });
    row.appendChild(cancel); row.appendChild(ok);
    var tail = [];
    if (m.confirmed !== true) {
      var warnWrap = document.createElement('div');
      warnWrap.className = 'ed-matpop-sec';
      var warn = document.createElement('div');
      warn.className = 'ed-matpop-warn';
      warn.textContent = '此素材尚未确认，不会参与「针对岗位生成」；手动插入不受限制。';
      var confBtn = document.createElement('button');
      confBtn.type = 'button';
      confBtn.textContent = '确认可用于生成';
      confBtn.style.cssText = 'min-height:30px;padding:0 12px;border-radius:var(--ed-radius);font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)';
      confBtn.addEventListener('click', function () {
        fetch('/mat/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [m.id], confirmed: true }) })
          .then(function () { m.confirmed = true; warn.innerHTML = '已确认 ' + __icon('check') + ' 可参与自动生成'; confBtn.remove(); renderMats(left.querySelector('#ed-matsearch').value.trim().toLowerCase()); });
      });
      warnWrap.append(warn, confBtn);
      tail.push(warnWrap);
    }
    matpop.append(h, secTypes, secPrev, secTarget, ...tail, row);
    setType(typeKey);
    matmask.style.display = 'block';
    matpop.style.display = 'block';
    ok.focus();
  }
  function closeMatPop() {
    matmask.style.display = 'none';
    matpop.style.display = 'none';
    if (matpopLastFocus && matpopLastFocus.focus) matpopLastFocus.focus();
  }
  matmask.addEventListener('click', closeMatPop);
  document.addEventListener('keydown', function (e) {
    // stopImmediatePropagation（S2-T7 M6）：同一次 Esc 只关本弹层，不再触发同节点上更晚注册的
    // 岗位弹层/窄屏浮层监听（stopPropagation 对同节点监听无效）。
    if (e.key === 'Escape' && matpop.style.display === 'block') { e.stopImmediatePropagation(); closeMatPop(); }
  });
  // 焦点圈定：Tab 不跑到弹层外
  function trapTab(container, e) {
    if (e.key !== 'Tab') return;
    var focusables = container.querySelectorAll('button, input, select, textarea, a[href]');
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  matpop.addEventListener('keydown', function (e) { trapTab(matpop, e); });

  // ===== 岗位草稿弹层（结构化输入 → /job/create；不依赖模型）=====
  var jobmask = document.createElement('div');
  jobmask.id = 'ed-jobmask';
  mount(jobmask);
  var jobpop = document.createElement('div');
  jobpop.id = 'ed-jobpop';
  jobpop.setAttribute('role', 'dialog');
  jobpop.setAttribute('aria-modal', 'true');
  jobpop.setAttribute('aria-label', '创建岗位草稿');
  mount(jobpop);
  var jobpopLastFocus = null;
  function closeJobPop() {
    jobmask.style.display = 'none';
    jobpop.style.display = 'none';
    if (jobpopLastFocus && jobpopLastFocus.focus) jobpopLastFocus.focus();
  }
  jobmask.addEventListener('click', closeJobPop);
  document.addEventListener('keydown', function (e) {
    // stopImmediatePropagation（S2-T7 M6）：同 matpop——Esc 单层关闭，不穿透到窄屏浮层监听。
    if (e.key === 'Escape' && jobpop.style.display === 'block') { e.stopImmediatePropagation(); closeJobPop(); }
  });
  jobpop.addEventListener('keydown', function (e) { trapTab(jobpop, e); });
  function jobField(labelTxt, inputEl) {
    var lab = document.createElement('label');
    lab.textContent = labelTxt;
    jobpop.appendChild(lab);
    jobpop.appendChild(inputEl);
    return inputEl;
  }
  function openJobPop() {
    if (!jobBtn) return;
    jobpopLastFocus = jobBtn;
    jobpop.innerHTML = '';
    var h = document.createElement('h3');
    h.innerHTML = __icon('target') + ' 针对岗位生成简历草稿';
    var note = document.createElement('div');
    note.className = 'ed-jp-note';
    note.textContent = '基于当前文档创建独立草稿（不修改母版）。未配置模型也可先创建；配置后可在右侧「审阅」面板生成并审阅建议。定制要求（重点/保留/不强调/幅度/页数）可在下方「本次定制要求」按需填写，默认重点调整/2 页。';
    jobpop.append(h, note);
    var inCompany = document.createElement('input');
    inCompany.required = true;
    inCompany.setAttribute('aria-label', '公司');
    var inRole = document.createElement('input');
    inRole.required = true;
    inRole.setAttribute('aria-label', '岗位');
    var inLink = document.createElement('input');
    inLink.placeholder = 'https://…（读取失败可在下方粘贴 JD）';
    inLink.setAttribute('aria-label', 'JD 链接');
    var inJd = document.createElement('textarea');
    inJd.setAttribute('aria-label', 'JD 文本');
    jobField('公司', inCompany);
    jobField('岗位', inRole);
    jobField('JD 链接（可留空）', inLink);
    jobField('JD 文本（可留空，稍后补）', inJd);
    // 本次定制要求（可选）：与首页「针对岗位生成」表单同形状的 brief（server.mjs briefFromForm/normBrief 消费），
    // 折叠进弹层——编辑器内一条链走完，不再要求到首页填写。DOM 全在 #ed-jobpop 内（SHELL-INJECT 注释对内，/save 剥离）。
    var briefDet = document.createElement('details');
    var briefSum = document.createElement('summary');
    briefSum.textContent = '本次定制要求（可选，默认重点调整/2 页）';
    briefDet.appendChild(briefSum);
    var briefBox = document.createElement('div');
    briefBox.className = 'ed-jp-brief';
    // 重点 chips：__MATS__ tags 客户端聚合（与首页同源同序：按出现次数降序、去重、前 12）
    var tagCount = {};
    MATS.forEach(function (mt) {
      (Array.isArray(mt.tags) ? mt.tags : []).forEach(function (t) {
        var k = String(t == null ? '' : t).trim();
        if (k) tagCount[k] = (tagCount[k] || 0) + 1;
      });
    });
    var topTags = Object.keys(tagCount).sort(function (a, b) { return tagCount[b] - tagCount[a]; }).slice(0, 12);
    var focusLab = document.createElement('label');
    focusLab.textContent = '本次重点（点击选中/取消；建议来自素材标签）';
    var chipsBox = document.createElement('span');
    chipsBox.className = 'ed-jp-chips';
    topTags.forEach(function (t) {
      var c = document.createElement('button');
      c.type = 'button';
      c.setAttribute('data-tag', t);
      c.setAttribute('aria-pressed', 'false');
      c.textContent = t;
      c.addEventListener('click', function () { c.setAttribute('aria-pressed', c.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); });
      chipsBox.appendChild(c);
    });
    focusLab.appendChild(chipsBox);
    var keepLab = document.createElement('label');
    keepLab.textContent = '必须保留的项目（一行一个）';
    var inKeep = document.createElement('textarea');
    inKeep.setAttribute('aria-label', '必须保留的项目');
    inKeep.placeholder = '一行一个';
    keepLab.appendChild(inKeep);
    var deemLab = document.createElement('label');
    deemLab.textContent = '不希望强调（一行一个）';
    var inDeem = document.createElement('textarea');
    inDeem.setAttribute('aria-label', '不希望强调');
    inDeem.placeholder = '一行一个';
    deemLab.appendChild(inDeem);
    // 段选组（同首页 segPick 语义：单选，aria-pressed 标当前值，默认值始终在组内兜底）
    var segGroup = function (labelTxt, attr, items, def) {
      var lab = document.createElement('label');
      lab.textContent = labelTxt;
      var seg = document.createElement('span');
      seg.className = 'ed-jp-seg';
      items.forEach(function (it) {
        var b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('data-' + attr, it[0]);
        if (it[0] === def) b.setAttribute('aria-pressed', 'true');
        b.textContent = it[1];
        b.addEventListener('click', function () {
          Array.prototype.forEach.call(seg.querySelectorAll('button[data-' + attr + ']'), function (x) { x.removeAttribute('aria-pressed'); });
          b.setAttribute('aria-pressed', 'true');
        });
        seg.appendChild(b);
      });
      lab.appendChild(seg);
      briefBox.appendChild(lab);
      return seg;
    };
    briefBox.append(focusLab, keepLab, deemLab);
    var degSeg = segGroup('修改幅度', 'deg', [['light', '轻度精简'], ['refocus', '重点调整'], ['restructure', '重新组织']], 'refocus');
    var pgSeg = segGroup('页数目标', 'pages', [['1', '1 页'], ['2', '2 页（默认）']], '2');
    briefDet.appendChild(briefBox);
    jobpop.appendChild(briefDet);
    var msg = document.createElement('div');
    msg.className = 'ed-jp-msg';
    var row = document.createElement('div');
    row.className = 'ed-jp-row';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeJobPop);
    var ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ed-primary';
    ok.textContent = '创建草稿';
    ok.addEventListener('click', function () {
      var company = inCompany.value.trim(), role = inRole.value.trim();
      if (!company || !role) { msg.textContent = '公司和岗位必填'; return; }
      ok.disabled = true;
      msg.textContent = '创建中…';
      // brief 组装同首页 briefFromForm 形状（server.mjs normBrief 归一：缺省渐进默认，非法值 400）
      var brief = {
        focus: Array.prototype.map.call(chipsBox.querySelectorAll('button[aria-pressed="true"]'), function (b) { return b.getAttribute('data-tag'); }),
        keepProjects: inKeep.value.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean),
        deemphasize: inDeem.value.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean),
        degree: (degSeg.querySelector('button[data-deg][aria-pressed="true"]') || degSeg.querySelector('button[data-deg="refocus"]')).getAttribute('data-deg'),
        pages: Number((pgSeg.querySelector('button[data-pages][aria-pressed="true"]') || pgSeg.querySelector('button[data-pages="2"]')).getAttribute('data-pages')) || 2
      };
      fetch('/job/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: DOC_ID, company: company, role: role, jd: inJd.value, jdLink: inLink.value.trim(), brief: brief }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
        .then(function (d) {
          ok.disabled = false;
          if (d && d.existing) { if (confirm('同岗位草稿已存在（' + d.existing + '），打开它？')) location.href = '/edit?id=' + d.existing; return; }
          if (d && d.ok && d.id) { location.href = '/edit?id=' + d.id; return; }
          __status(msg, 'warn', (d && d.error) || '创建失败');
        })
        .catch(function (e) { ok.disabled = false; __status(msg, 'warn', e.message); });
    });
    row.append(cancel, ok);
    jobpop.append(row, msg);
    jobmask.style.display = 'block';
    jobpop.style.display = 'block';
    inCompany.focus();
  }
  if (jobBtn) jobBtn.addEventListener('click', openJobPop);

  // 插入：章节内有 ul 则 append li，否则 append p；撤销 = Toast/工具条消费同一条 op（快照恢复）
  function insertIntoSection(secEl, text) {
    var opId = window.__edPushUndo('插入素材');
    var ul = secEl.querySelector('ul');
    var node;
    if (ul) {
      node = document.createElement('li');
      node.textContent = text;
      ul.appendChild(node);
    } else {
      node = document.createElement('p');
      node.textContent = text;
      secEl.appendChild(node);
    }
    __edEnsureZids();                                   // S3：程序化插入的段落补打点（T3 quality Note 1）
    notifyEdit();
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashEl(node);
    undoToast('已插入素材', opId);   // 旧实现传 node.remove() 闭包 → 绕过栈造成双重恢复，已按 opId 绑定
  }
  // 撤销 toast（复用现有 .toast 样式，加按钮）：绑定 opId，栈顶不是它 → 拒绝并置「已失效」，绝不弹别人的 op
  function undoToast(msg, opId) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');   // A8：读屏可感知
    t.style.pointerEvents = 'auto';
    var span = document.createElement('span');
    span.textContent = msg + '　';
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = '撤销';
    b.style.cssText = 'background:transparent;border:1px solid var(--ed-panel);color:var(--ed-panel);border-radius:var(--ed-radius);padding:1px 8px;font-size:12px;cursor:pointer';
    var target = opId == null ? (undoStack[undoStack.length - 1] || {}).id : opId;
    function invalidate() {
      b.disabled = true;
      b.textContent = '已失效';
      span.textContent = msg + '　该操作已不是最近一次操作，请到工具条撤销　';
    }
    b.addEventListener('click', function () {
      if (b.disabled) return;
      if (target == null || !window.__edUndoLast(target)) {
        // 返回 false 有两种：confirm 被取消（op 仍是栈顶 → Toast 保持可点，等用户再决定）；
        // 或栈顶已变（→ 置「已失效」，绝不弹别人的 op）。只有后者才失效。
        var now = undoStack[undoStack.length - 1];
        if (target == null || !now || now.id !== target) invalidate();
        return;
      }
      b.disabled = true;                                                              // 成功消费后同样禁用该入口
      t.remove();
    });
    t.appendChild(span); t.appendChild(b);
    mount(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 400); }, 5000);
  }
  window.__edUndoToast = undoToast;   // S3-T6：区域改写接受链路复用（Toast 与工具条消费同一条 op 记录，面板不自建 toast）

  // ===== 画布工具条：缩放 =====
  var tools = document.createElement('div');
  tools.id = 'ed-canvas-tools';
  tools.innerHTML = '<span>内容编辑</span><span style="color:var(--ed-mut)">／</span><span class="ed-mode-label">直接点击正文编辑</span>'
    + '<span class="ed-zoom"><button type="button" id="ed-zout" aria-label="缩小">−</button>'
    + '<input class="ed-znum" id="ed-zval" type="number" min="40" max="150" step="5" value="100" aria-label="缩放百分比">'
    + '<span class="ed-zunit">%</span>'
    + '<button type="button" id="ed-zin" aria-label="放大">＋</button>'
    + '<button type="button" id="ed-zfit">适应宽度</button>'
    + '<button type="button" id="ed-z100">100%</button></span>';
  mount(tools);

  var zoom = 1;
  var zval = tools.querySelector('#ed-zval');
  function setZoom(z) {
    // 非有限值守卫：输入框被清空 → parseFloat('') = NaN → Math.min/Math.max 对 NaN 不传染无效，
    // NaN 贯穿全局，此后「＋/−」全部空转（NaN + 0.1 仍是 NaN），状态栏显示「缩放 NaN%」。
    // 刷新后 JSON.stringify 把 NaN 写成 null，被 restoreUi 的 typeof 守卫跳过 → 故障被掩盖，更难查。
    // 一处守卫覆盖全部入口：滑杆 / ＋− / 输入框 / window.__edSetZoom / 恢复态（审查 B1）。
    if (!isFinite(z)) return;
    zoom = Math.min(1.5, Math.max(0.4, Math.round(z * 100) / 100));
    sheet.style.zoom = zoom === 1 ? '' : String(zoom);
    zval.value = Math.round(zoom * 100);
    updateStatus();
    persistSoon();                       // S2-T6：会话状态（存的是夹取后的真实值）
  }
  window.__edSetZoom = setZoom;          // S2-T6 薄封装：测试/外部走同一条夹取路径（0.4–1.5），不另开后门
  window.__edGetZoom = function () { return zoom; };
  tools.querySelector('#ed-zin').addEventListener('click', function () { setZoom(zoom + 0.1); });
  tools.querySelector('#ed-zout').addEventListener('click', function () { setZoom(zoom - 0.1); });
  tools.querySelector('#ed-z100').addEventListener('click', function () { setZoom(1); });
  zval.addEventListener('change', function () { setZoom(parseFloat(zval.value) / 100); });
  zval.addEventListener('keydown', function (e) { if (e.key === 'Enter') setZoom(parseFloat(zval.value) / 100); });
  tools.querySelector('#ed-zfit').addEventListener('click', function () {
    // 目标：纸张原始宽（210mm）适配当前画布格子宽；浮层模式的栏位不挤压画布不扣除
    var wide = window.innerWidth >= 1200;
    var leftW = wide && !left.classList.contains('ed-hidden') ? left.getBoundingClientRect().width : 0;
    var rightW = window.innerWidth >= 768 && !right.classList.contains('ed-hidden') ? right.getBoundingClientRect().width : 0;
    setZoom((document.body.clientWidth - leftW - rightW - 48) / SHEET_W);
  });

  // ===== 右栏：Tab 宿主（岗位草稿多一个「审阅」页签，且默认打开）=====
  var right = document.createElement('aside');
  right.id = 'ed-right';
  right.setAttribute('aria-label', '辅助面板');
  right.innerHTML = '<div id="ed-rtabs" role="tablist">'
    + (JOB_INFO.hasJob ? '<button type="button" role="tab" data-pane="review" aria-selected="true">审阅</button>' : '')
    + '<button type="button" role="tab" data-pane="zone" aria-selected="false">区域</button>'
    + '<button type="button" role="tab" data-pane="ai" aria-selected="' + (JOB_INFO.hasJob ? 'false' : 'true') + '">AI 助手</button>'
    + '<button type="button" role="tab" data-pane="typo" aria-selected="false">排版</button>'
    // 模板页签只给母版：岗位草稿右栏是 S4a 定稿的合并入口（恰为 审阅/区域/AI 助手/排版，见 s4a-design §右栏），
    // 主题切换属母版维度的装配选择，不进草稿审阅动线
    + (JOB_INFO.hasJob ? '' : '<button type="button" role="tab" data-pane="theme" aria-selected="false">模板</button>')
    + '</div>'
    + (JOB_INFO.hasJob ? '<div id="ed-pane-review" class="ed-pane on" role="tabpanel" aria-label="修改清单"></div>' : '')
    + '<div id="ed-pane-zone" class="ed-pane" role="tabpanel" aria-label="区域分析"></div>'
    + '<div id="ed-pane-ai" class="ed-pane' + (JOB_INFO.hasJob ? '' : ' on') + '" role="tabpanel" aria-label="AI 助手"></div>'
    + '<div id="ed-pane-typo" class="ed-pane" role="tabpanel" aria-label="排版设置"></div>'
    + (JOB_INFO.hasJob ? '' : '<div id="ed-pane-theme" class="ed-pane" role="tabpanel" aria-label="模板选择"></div>');
  mount(right);

  // ===== 批次C：右栏可拖拽分栏（拖柄 DOM 只能由注入层建）=====
  // 【为什么在注入层做】编辑器页 HTML 就是 docs/*.html（用户真实数据文件），server.mjs 不生成它；
  //   拖柄只能由注入层 createElement 挂进 body；CSS 走更高特异性（body.ed-on #ed-grip）压过文档内联 chrome。
  // 宽度写 --ed-right-w：body.ed-on 的 grid 第三列就是它（grid-template-columns:var(--ed-right-w,320px)），
  //   ai-panel.js / toggleRight 早就在写这个变量，本次接上，不新增变量。
  // 拖柄是 grid item：与 #ed-right 同格（行 2/4、列 3），justify-self:start + margin-left:-3px 骑在交界线上。
  var GRIP_KEY = 'resume.ed.rightW';
  var GRIP_MIN = 260, GRIP_MAX = 460, GRIP_DEFAULT = 320;
  // localStorage 访问必须兜底：浏览器禁用站点存储时（Chrome「阻止 Cookie」/
  // Firefox dom.storage.enabled=false）属性访问就抛 SecurityError ——
  // 无兜底会让整个 editor-shell 初始化中断（页签/拖柄/工具条全没建，点了没反应）。
  // 本文件其它 localStorage 访问都有 try/catch，这一处原来漏了。
  function gripGet() {
    try { return localStorage.getItem(GRIP_KEY); } catch (e) { return null; }
  }
  function gripSet(v) {
    try { localStorage.setItem(GRIP_KEY, String(v)); } catch (e) { /* 存不了就只是不持久化 */ }
  }
  function readGripW() {                       // 拖过才认；没拖过保持旧行为（320px）
    var s = Number(gripGet() || 0);
    return (s >= GRIP_MIN && s <= GRIP_MAX) ? s : 0;
  }
  function rightW() {                          // 折叠/宽度档复位时用：拖过就沿用拖后的宽度
    var s = readGripW();
    return s ? s + 'px' : '320px';
  }
  var grip = document.createElement('div');
  grip.id = 'ed-grip';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('tabindex', '0');
  grip.setAttribute('aria-label', '调整右侧面板宽度');
  grip.setAttribute('aria-valuemin', String(GRIP_MIN));
  grip.setAttribute('aria-valuemax', String(GRIP_MAX));
  grip.title = '拖动调整宽度，双击复位';
  right.parentNode.insertBefore(grip, right.nextSibling);
  var curW = 0;
  // 上限跟视口走：右栏太宽会把 210mm（≈794px）的纸张压住 ——
  // 纸张在中列居中，中列不够宽时向两侧各溢出，被右栏（后绘制）盖住，
  // 而状态栏查的是纸张自身 scrollWidth，查不出「被盖」。
  // 视口 - 左栏 208 - 纸张 794 - 余量 24 = 右栏可用上限。
  function gripMax() {
    var byViewport = window.innerWidth - 208 - 794 - 24;
    return Math.max(GRIP_MIN, Math.min(GRIP_MAX, byViewport));
  }
  function applyW(w) {
    w = Math.max(GRIP_MIN, Math.min(gripMax(), Math.round(w)));
    curW = w;
    document.body.style.setProperty('--ed-right-w', w + 'px');
    grip.setAttribute('aria-valuenow', String(w));
    grip.setAttribute('aria-valuemax', String(gripMax()));   // 上限跟视口走，同上
    return w;
  }
  function currentW() {                        // 当前生效宽度：内联值 → 实测宽 → 默认
    var v = Number((document.body.style.getPropertyValue('--ed-right-w') || '').replace('px', ''));
    if (v) return v;
    return Math.round(right.getBoundingClientRect().width) || GRIP_DEFAULT;
  }
  function syncGrip() {                        // 右栏折叠时拖柄同步隐身（不可见也不该被键盘聚焦）
    var off = right.classList.contains('ed-hidden');
    grip.style.display = off ? 'none' : '';
    grip.setAttribute('tabindex', off ? '-1' : '0');
  }
  var savedW = readGripW();
  if (savedW && !right.classList.contains('ed-hidden')) applyW(savedW);
  else grip.setAttribute('aria-valuenow', String(Math.round(right.getBoundingClientRect().width) || GRIP_DEFAULT));
  syncGrip();

  // 瞬时改宽：禁掉列宽过渡（body.ed-on 有 grid-template-columns .2s 过渡，否则键盘每一步都发木）
  function noFx() { document.body.classList.add('ed-nofx'); }
  function endFx() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { document.body.classList.remove('ed-nofx'); });
    });
  }
  // 拖拽：Pointer Events（非 HTML5 DnD——后者接不住既有光标语义，Safari 上也不稳）
  var dragging = false, startX = 0, startW = 0;
  grip.addEventListener('pointerdown', function (e) {
    if (window.innerWidth < 768) return;       // 窄屏右栏是抽屉，没有边界可拖
    dragging = true; startX = e.clientX;
    startW = right.getBoundingClientRect().width;
    noFx();
    try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
    // preventDefault 会吃掉「聚焦」这个默认动作 → 鼠标拖完直接按 ←/→ 没反应
    // （键盘替代路径 WCAG 要求可达）→ 显式聚焦。
    try { grip.focus({ preventScroll: true }); } catch (err) { try { grip.focus(); } catch (e2) {} }
  });
  grip.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    applyW(startW - (e.clientX - startX));     // 往左拖 → 面板变宽
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('ed-nofx');
    try { grip.releasePointerCapture(e.pointerId); } catch (err) {}
    if (curW) gripSet(curW);
  }
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  // 指针在窗口外松开时 pointerup 可能不送达 → dragging 永远为 true、
  // body.ed-nofx 不摘（列宽过渡被永久禁用），之后每次划过拖柄都用陈旧 startX 改宽度。
  // 失焦/页面隐藏兜底收尾。
  window.addEventListener('blur', endDrag);
  document.addEventListener('visibilitychange', function () { if (document.hidden) endDrag(); });
  grip.addEventListener('dblclick', function () {                  // 双击复位 300px
    applyW(GRIP_DEFAULT);
    gripSet(GRIP_DEFAULT);
  });
  // 键盘可达（WCAG dragging-alternative）：←/→ 每次 16px，Home 复位
  grip.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      noFx();
      applyW(currentW() + (e.key === 'ArrowLeft' ? 16 : -16));
      endFx();
      gripSet(curW);
      e.preventDefault();
    } else if (e.key === 'Home') {
      noFx();
      applyW(GRIP_DEFAULT);
      endFx();
      gripSet(GRIP_DEFAULT);
      e.preventDefault();
    }
  });

  right.querySelector('#ed-rtabs').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (b) selectTab(b.dataset.pane);
  });
  right.querySelector('#ed-rtabs').addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var tabs = Array.prototype.slice.call(right.querySelectorAll('#ed-rtabs button'));
    var i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    selectTab(next.dataset.pane);
  });
  function selectTab(name) {
    right.querySelectorAll('#ed-rtabs button').forEach(function (b) {
      b.setAttribute('aria-selected', b.dataset.pane === name ? 'true' : 'false');
    });
    right.querySelectorAll('.ed-pane').forEach(function (p) {
      p.classList.toggle('on', p.id === 'ed-pane-' + name);
    });
    if (name === 'review') window.dispatchEvent(new Event('ed-review-refresh'));
    if (name === 'zone') window.dispatchEvent(new Event('ed-zone-refresh'));
    if (name === 'theme') buildThemePane();   // S6-A2：首次打开才建卡/取预览（懒加载，不吃首屏）
    if (name === 'typo') loadTypoPageInfo();  // A3：页数感知懒加载（再激活重取——渲染/导出后页数会变）
    if (window.__edApplyWidthTier) window.__edApplyWidthTier();   // S4a-T9：宽度档随活跃度联动
    persistSoon();                       // S2-T6：活动面板属会话状态
  }
  // 供 ai-panel / 外部切换（jdfrom 桥等）
  window.__edSelectTab = selectTab;

  // 折叠开关逻辑（宽屏：列宽归零 + hidden；窄屏：absolute/fixed 浮层开关）
  function isNarrow() { return window.innerWidth < 1200; }
  function toggleLeft() {
    if (window.innerWidth < 1200) left.classList.toggle('ed-open');
    else {
      left.classList.toggle('ed-hidden');
      document.body.style.setProperty('--ed-left-w', left.classList.contains('ed-hidden') ? '0px' : '208px');
    }
    persistSoon();                       // S2-T6：折叠态（宽屏布尔 / 窄屏浮层布尔）
  }
  function toggleRight() {
    if (window.innerWidth < 768) right.classList.toggle('ed-open');
    else {
      right.classList.toggle('ed-hidden');
      document.body.style.setProperty('--ed-right-w', right.classList.contains('ed-hidden') ? '0px' : rightW());
      syncGrip();
    }
    persistSoon();                       // S2-T6
  }
  // S2-T6 薄封装（不改行为）：左栏仍是 208px|0px 两态；右栏批次C 起可拖拽（宽度存 resume.ed.rightW，
  // 折叠仍存布尔），故测试直接驱动真实折叠函数，不靠文本匹配猜按钮（调用方仍是工具条那两颗 data-ed-inj 按钮）。
  window.__edToggleLeft = toggleLeft;
  window.__edToggleRight = toggleRight;
  window.__edToggleLeftNarrow = function () { left.classList.toggle('ed-open'); };
  var ltBtn = toolbar && toolbar.querySelector('.ed-left-toggle');
  var rtBtn = toolbar && toolbar.querySelector('.ed-right-toggle');
  if (ltBtn) ltBtn.addEventListener('click', toggleLeft);
  if (rtBtn) rtBtn.addEventListener('click', toggleRight);
  // Esc 关闭窄屏浮层
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (left.classList.contains('ed-open')) left.classList.remove('ed-open');
    if (right.classList.contains('ed-open')) right.classList.remove('ed-open');
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth >= 1200) { left.classList.remove('ed-open'); }
    if (window.innerWidth >= 768) { right.classList.remove('ed-open'); }
    applyWidthTier();
  });

  // ===== S4a-T9：1280-1439 宽度档联动（§7.3）——右栏为审阅 Tab 且岗位草稿有待处理项（正在使用）→ 保右栏；
  // 非活跃 → 自动折叠为竖标签条（S2 折叠机制既有）；<1200 抽屉、≥1440 三栏全开均不走此逻辑。
  function reviewActive() {
    var sel = right.querySelector('#ed-rtabs button[aria-selected="true"]');
    if (!sel || sel.dataset.pane !== 'review') return false;
    if (!document.querySelector('#ed-pane-review .jp-item')) return true;   // 数据未加载：不动折叠态（防误折叠）
    return !!document.querySelector('#ed-pane-review .jp-item button.jp-accept');
  }
  function applyWidthTier() {
    var w = window.innerWidth;
    if (w < 1280 || w >= 1440) return;
    var hidden = right.classList.contains('ed-hidden');       // 用户手动折叠
    var strip = document.body.classList.contains('ed-tier-strip');   // 宽度档自己折的竖标签条
    if (reviewActive()) {
      // 审阅正在用 → 撤掉竖标签条，展开右栏。
      // 只撤「自己折的」：用户手动折叠的不动 —— 宽度档不该跟用户的手动操作打架
      // （原实现无条件展开 → 用户手动收起后拖一下窗口就弹回来，2026-10-22 审查 [中]）。
      if (strip) {
        right.classList.remove('ed-hidden');
        document.body.classList.remove('ed-tier-strip');
        document.body.style.setProperty('--ed-right-w', window.innerWidth >= 768 ? rightW() : '0px');
        syncGrip();
      }
    } else if (!hidden && !strip) {
      // 非活跃 → 折叠为竖标签条（设计 v1.3：「自动折叠为竖标签条」）
      // 原实现是整条藏起来（--ed-right-w:0px）→ 区域/AI/排版三个页签彻底点不到，
      // 而且用户连「怎么切回审阅」都不知道（2026-10-22 审查 [高]）。
      right.classList.remove('ed-hidden');
      document.body.classList.add('ed-tier-strip');
      document.body.style.setProperty('--ed-right-w', '48px');
      syncGrip();
    }
  }
  window.__edApplyWidthTier = applyWidthTier;   // 供 Tab 切换后联动（selectTab 调用）与测试驱动

  // ===== S2-T6 会话状态（per-doc localStorage；滚动容器是 .sheet 自身；折叠存布尔而非 0 宽）=====
  // 只写 localStorage：不碰正文 DOM、不调 notifyEdit()、不进 docs-meta（块 13 有泄漏断言，块 6 冻结件不变性兜底）。
  // 折叠不存宽度：左栏只有 208px|0px 两态；右栏宽度批次C 起单独存 resume.ed.rightW（拖柄持久化），
  // 折叠态仍存布尔，故 0 宽的 falsy 陷阱不存在。
  // 定义点在此（左右面板 / 页签 / 折叠函数 / isNarrow 都已就绪）；restoreUi() 的调用点在初始化尾部——
  // 必须晚于「窄屏初始自适应宽度」那次 setZoom，否则手机上恢复出来的 zoom 会被自适应值覆盖。
  var UI_KEY = 'resume-ui:' + DOC_ID;
  function uiState() {
    var sel = right.querySelector('#ed-rtabs button[aria-selected="true"]');
    return {
      v: 1,
      zoom: zoom,
      leftHidden: left.classList.contains('ed-hidden'),
      rightHidden: right.classList.contains('ed-hidden'),
      narrowLeftOpen: left.classList.contains('ed-open'),
      narrowRightOpen: right.classList.contains('ed-open'),
      pane: (sel && sel.dataset && sel.dataset.pane) || '',
      scrollTop: sheet.scrollTop || 0,
      focusMode: document.body.classList.contains('ed-focus')
    };
  }
  window.__edUiState = uiState;
  window.__edPersistUi = function () {
    try { localStorage.setItem(UI_KEY, JSON.stringify(uiState())); } catch (e) { /* 隐私模式忽略 */ }
  };
  var uiTimer = null;
  // 定时器里再取一次 __edPersistUi：初始化早期（如窄屏自适应那次 setZoom）触发的 debounce 也不会打到空引用
  function persistSoon() { clearTimeout(uiTimer); uiTimer = setTimeout(function () { if (window.__edPersistUi) window.__edPersistUi(); }, 300); }
  window.__edPersistUiSoon = persistSoon;      // T5 的 toggleFocusMode 已在调用它（此前是空引用，本任务补齐）
  function restoreUi() {
    var v;
    try { v = JSON.parse(localStorage.getItem(UI_KEY) || 'null'); } catch (e) { v = null; }
    if (!v || v.v !== 1) return;
    if (typeof v.zoom === 'number' && isFinite(v.zoom)) setZoom(v.zoom);          // 夹取交给 setZoom 本身
    if (v.focusMode) document.body.classList.add('ed-focus');                      // 直接加 class：恢复态不该弹 Toast
    if (!isNarrow()) {
      if (v.leftHidden === true && !left.classList.contains('ed-hidden')) toggleLeft();
      if (v.rightHidden === true && !right.classList.contains('ed-hidden')) toggleRight();
    } else {
      if (v.narrowLeftOpen === true) left.classList.add('ed-open');
      if (v.narrowRightOpen === true) right.classList.add('ed-open');
    }
    // S2-T7 I5a：v.pane 来自 localStorage，载荷可被外部写坏；直接内插进 querySelector 时含引号的值会抛
    // SyntaxError，而 restoreUi 在初始化尾部内联调用——抛出会中断其后全部初始化（选区工具条等）。
    // CSS.escape 使任意字符串成为合法属性值（损坏值最多匹配不到按钮 → 跳过面板恢复，不再致命）。
    if (v.pane) {
      var paneVal = String(v.pane);
      var paneEsc = (window.CSS && CSS.escape) ? CSS.escape(paneVal) : paneVal.replace(/["\\]/g, '\\$&');
      if (right.querySelector('#ed-rtabs button[data-pane="' + paneEsc + '"]')) selectTab(paneVal);
    }
    if (typeof v.scrollTop === 'number' && v.scrollTop > 0) sheet.scrollTop = v.scrollTop;   // zoom 已先应用，同一像素值即同一位置
  }
  sheet.addEventListener('scroll', persistSoon);
  window.addEventListener('resize', persistSoon);
  window.addEventListener('beforeunload', window.__edPersistUi);

  // ===== 排版设置：单一通道合同（屏幕=PDF）=====
  // 排版能力增强的唯一落点链：FIELDS（沿用 number + range 双控件 + aria-label 模式）→ typoCss()
  // → 排版样式块落盘 head → render.mjs 读取 → PDF 与屏幕一致。禁止另开注入通道绕过落盘
  // （另开即双轨，破坏「屏幕=PDF」合同）。「恢复默认排版」= 移除整段落盘样式块（见 getTypoEl），
  // 不逐项回写。本轮功能零变更，仅把合同写进代码。
  var TYPO_DEFAULTS = { fontSize: 13, lineHeight: 1.43, pagePad: 9.4, paraGap: 0.45, secGap: 2.9 };
  var typoPane = right.querySelector('#ed-pane-typo');
  // ===== 排版密度三档预设（A3）：映射既有五滑杆字段（FIELDS），应用走 applyTypo/typoCss 单一通道 =====
  // 「标准」= TYPO_DEFAULTS 逐字相同；档位只作用于呈现层参数，与主题无关、绝不触碰正文。
  var TYPO_PRESETS = {
    compact: { label: '紧凑', values: { fontSize: 12, lineHeight: 1.35, pagePad: 7.5, paraGap: 0.3, secGap: 2.2 } },
    standard: { label: '标准', values: { fontSize: 13, lineHeight: 1.43, pagePad: 9.4, paraGap: 0.45, secGap: 2.9 } },
    relaxed: { label: '宽松', values: { fontSize: 13.5, lineHeight: 1.6, pagePad: 12, paraGap: 0.8, secGap: 4.5 } }
  };
  var TYPO_FIELD_NAMES = { fontSize: '字号', lineHeight: '行距', pagePad: '页边距', paraGap: '段距', secGap: '章节距' };
  var TYPO_FIELD_UNITS = { fontSize: 'px', lineHeight: '', pagePad: 'mm', paraGap: 'mm', secGap: 'mm' };
  var typoPreset = null;        // 当前命中的预设 key；手动改任一滑杆即取消（诚实 UI）
  var typoPresetNote = '';      // 最近一次预设应用的行内结果（列出实际改变的参数）；手动改滑杆即清空
  var typoPageInfo = null;      // /layout-info 结果 {pages,target}；null=未取到（行不渲染，不臆造）
  var typoPageFailed = false;   // 页数信息获取失败（如实显示不可用，与「尚未渲染」区分）
  var typoPageRowEl = null;     // 当前行元素（buildTypoPane 重建时刷新引用）
  function getTypoEl() { return document.getElementById('typo-custom'); }
  function typoCss(v) {
    return '/*TYPO-CUSTOM*/body{font-size:' + v.fontSize + 'px;line-height:' + v.lineHeight + '}'
      + '.sheet{padding-top:' + v.pagePad + 'mm;padding-bottom:' + v.pagePad + 'mm}'
      + '.plain-lines p{margin-bottom:' + v.paraGap + 'mm}li{margin-top:' + v.paraGap + 'mm;margin-bottom:' + v.paraGap + 'mm}'
      + '.section{margin-top:' + v.secGap + 'mm}';
  }
  function readTypo() {
    var el = getTypoEl();
    var v = Object.assign({}, TYPO_DEFAULTS);
    if (!el) return v;
    var t = el.textContent;
    var m;
    if ((m = t.match(/font-size:([\d.]+)px/))) v.fontSize = parseFloat(m[1]);
    if ((m = t.match(/line-height:([\d.]+)/))) v.lineHeight = parseFloat(m[1]);
    if ((m = t.match(/padding-top:([\d.]+)mm/))) v.pagePad = parseFloat(m[1]);
    if ((m = t.match(/margin-bottom:([\d.]+)mm/))) v.paraGap = parseFloat(m[1]);
    if ((m = t.match(/section\{margin-top:([\d.]+)mm/))) v.secGap = parseFloat(m[1]);
    return v;
  }
  function applyTypo(v) {
    var el = getTypoEl();
    if (!el) {
      el = document.createElement('style');
      el.id = 'typo-custom';
      document.head.appendChild(el);
    }
    el.textContent = typoCss(v);
    notifyEdit();
  }
  function resetTypo() {
    var el = getTypoEl();
    if (el) el.remove();
    notifyEdit();
    // 恢复默认 = 移除整段落盘样式块（不逐项回写）；派发一次 ed-typo 让面板滑杆回到默认值。
    // 面板刷新监听器在外层（紧邻首次 buildTypoPane()），不随点击叠加。
    window.dispatchEvent(new Event('ed-typo'));
  }
  // 当前取值命中哪档预设（逐字段精确相等；手动调到与某档完全同值 → 如实亮该档）
  function detectTypoPreset(v) {
    var keys = Object.keys(TYPO_DEFAULTS);
    for (var k in TYPO_PRESETS) {
      var same = true;
      for (var i = 0; i < keys.length; i++) {
        if (Math.round((Number(v[keys[i]]) || 0) * 100) !== Math.round(TYPO_PRESETS[k].values[keys[i]] * 100)) { same = false; break; }
      }
      if (same) return k;
    }
    return null;
  }
  // 页数感知行（A3）：typoPageInfo 未取到前不渲染（不臆造）；有数据如实显示，超页给「切到紧凑档」。
  function renderTypoPageRow(box) {
    if (!box) box = typoPane.querySelector('.ed-typo');
    if (!box) return;
    var noteOld = box.querySelector('.ed-pagenote');
    if (noteOld) noteOld.remove();
    if (typoPageRowEl && typoPageRowEl.parentNode === box) typoPageRowEl.remove();
    if (typoPageInfo === null && !typoPageFailed) { typoPageRowEl = null; return; }   // 未取到：整行不出现
    var row = document.createElement('div');
    row.className = 'ed-pagerow';
    if (typoPageFailed) {
      row.textContent = '页数信息不可用';
    } else if (typoPageInfo && typoPageInfo.pages == null) {
      row.textContent = '尚未渲染';   // 无渲染历史：如实说明，不臆造页数
    } else if (typoPageInfo) {
      row.textContent = '上次渲染 ' + typoPageInfo.pages + ' 页（目标 ' + typoPageInfo.target + ' 页）';
      if (typoPageInfo.pages > typoPageInfo.target) {
        var more = document.createElement('button');
        more.type = 'button';
        more.className = 'ed-pagemore';
        more.textContent = '切到紧凑档';
        more.title = '一键应用紧凑预设（只调整呈现层参数，不改动内容）';
        more.addEventListener('click', function () {
          var before = readTypo();
          typoPreset = 'compact';
          applyTypo(Object.assign({}, TYPO_PRESETS.compact.values));
          var changed = Object.keys(TYPO_PRESETS.compact.values)
            .filter(function (k) { return Math.round(before[k] * 100) !== Math.round(TYPO_PRESETS.compact.values[k] * 100); })
            .map(function (k) { return TYPO_FIELD_NAMES[k] + ' ' + before[k] + '→' + TYPO_PRESETS.compact.values[k] + TYPO_FIELD_UNITS[k]; });
          typoPresetNote = changed.length
            ? '已应用紧凑预设：' + changed.join('、') + '。内容未改动，效果以下次导出为准。'
            : '当前已是紧凑档取值，无参数变化。';
          renderTypoPageRow(box);
          window.dispatchEvent(new Event('ed-typo'));
        });
        row.appendChild(more);
      }
    }
    var footerNote = box.querySelector('.ed-note');
    if (footerNote) box.insertBefore(row, footerNote); else box.appendChild(row);
    typoPageRowEl = row;
    if (typoPresetNote) {
      var note = document.createElement('div');
      note.className = 'ed-pagenote';
      note.textContent = typoPresetNote;
      if (footerNote) footerNote.parentNode.insertBefore(note, footerNote); else box.appendChild(note);
    }
  }
  // 页数数据懒加载：首次切到「排版」页签时取（/layout-info 只读；再激活时重取——渲染/导出后页数会变）。
  function loadTypoPageInfo() {
    fetch('/layout-info?id=' + encodeURIComponent(DOC_ID))
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (d) { typoPageFailed = false; typoPageInfo = (d && d.ok) ? { pages: d.pages, target: d.target } : null; })
      .catch(function () { typoPageFailed = true; })
      .then(function () { renderTypoPageRow(null); });
  }
  function buildTypoPane() {
    var v = readTypo();
    typoPreset = detectTypoPreset(v);
    typoPane.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'ed-typo';
    // 三档预设置顶：命中档高亮（aria-pressed）；应用走 applyTypo 单一通道后派发 ed-typo 让滑杆与行重建。
    var prow = document.createElement('div');
    prow.className = 'ed-presets';
    prow.setAttribute('role', 'group');
    prow.setAttribute('aria-label', '排版密度预设');
    Object.keys(TYPO_PRESETS).forEach(function (key) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-preset' + (typoPreset === key ? ' ed-preset-on' : '');
      b.setAttribute('data-preset', key);
      b.setAttribute('aria-pressed', typoPreset === key ? 'true' : 'false');
      b.textContent = TYPO_PRESETS[key].label;
      b.title = '应用「' + TYPO_PRESETS[key].label + '」密度（字号/行距/页边距/段距/章节距 五项一起调）';
      b.addEventListener('click', function () {
        typoPreset = key;
        applyTypo(Object.assign({}, TYPO_PRESETS[key].values));
        window.dispatchEvent(new Event('ed-typo'));
      });
      prow.appendChild(b);
    });
    box.appendChild(prow);
    var FIELDS = [
      ['fontSize', '正文字号', 11, 15, 0.5, 'px'],
      ['lineHeight', '行距', 1.3, 1.8, 0.01, ''],
      ['pagePad', '页边距（上下）', 6, 16, 0.2, 'mm'],
      ['paraGap', '段落间距', 0, 2, 0.05, 'mm'],
      ['secGap', '章节间距', 1, 8, 0.1, 'mm']
    ];
    FIELDS.forEach(function (f) {
      var key = f[0], label = f[1], min = f[2], max = f[3], step = f[4], unit = f[5];
      var wrap = document.createElement('div');
      wrap.className = 'ed-field';
      var lab = document.createElement('label');
      lab.htmlFor = 'ed-typo-' + key;
      lab.appendChild(document.createTextNode(label));
      var num = document.createElement('input');
      num.type = 'number';
      num.id = 'ed-typo-num-' + key;
      num.min = min; num.max = max; num.step = step;
      num.value = v[key];
      num.setAttribute('aria-label', label + '数值输入' + (unit ? '（' + unit + '）' : ''));
      num.style.cssText = 'width:68px;margin-left:auto;text-align:right';
      lab.appendChild(num);
      if (unit) lab.appendChild(document.createTextNode(unit));
      var input = document.createElement('input');
      input.type = 'range';
      input.id = 'ed-typo-' + key;
      input.setAttribute('aria-label', label + '滑杆');
      input.min = min; input.max = max; input.step = step;
      input.value = v[key];
      var commit = function (raw) {
        var val = parseFloat(raw);
        if (!isFinite(val)) return;
        val = Math.min(max, Math.max(min, val));
        v[key] = Math.round(val * 100) / 100;
        input.value = v[key];
        num.value = v[key];
        // 手动改任一滑杆 → 预设失选 + 应用结果行清空（诚实 UI：面板当前值不再代表任何档位）。
        // 只就地更新按钮态，不整面板重建（拖动中重建会打断滑杆拖拽）。
        if (typoPreset !== null || typoPresetNote) {
          typoPreset = null;
          typoPresetNote = '';
          box.querySelectorAll('.ed-preset').forEach(function (b) {
            b.classList.remove('ed-preset-on');
            b.setAttribute('aria-pressed', 'false');
          });
        }
        applyTypo(v);
      };
      input.addEventListener('input', function () { commit(input.value); });
      num.addEventListener('change', function () { commit(num.value); });
      num.addEventListener('keydown', function (e) { if (e.key === 'Enter') commit(num.value); });
      wrap.appendChild(lab); wrap.appendChild(input);
      box.appendChild(wrap);
    });
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ed-reset';
    reset.textContent = '恢复默认排版';
    reset.addEventListener('click', resetTypo);
    box.appendChild(reset);
    // 页数感知行（A3）：数据懒加载后由 renderTypoPageRow 原位填充；取到前整行不出现。
    renderTypoPageRow(box);
    var note = document.createElement('div');
    note.className = 'ed-note';
    note.textContent = '设置随文档保存，导出 PDF 与屏幕预览一致。修改正文排版不影响编辑器界面。';
    box.appendChild(note);
    typoPane.appendChild(box);
  }
  buildTypoPane();
  // 排版被恢复缓存/程序改写时，面板同步刷新（模板 __edSetTypo 每次派发 ed-typo；模板侧负责参考线与保存标记）。
  // 监听器必须在顶层注册恰一次：圈在 resetTypo() 里的话，每点一次「恢复默认排版」就叠加一个监听器，
  // 且从未点过恢复时程序改写排版面板不刷新（滑杆停在旧值）。
  window.addEventListener('ed-typo', function () { buildTypoPane(); });

  // ===== 模板选择（S6-A2）：每主题一张卡 = 单/双栏标签 + 一句受众描述 + scaled iframe 真实渲染 =====
  // 缩略图 = /theme-preview（服务端剥脚本 + 锁定 CSP + 零写）经 fetch→srcdoc iframe 装载：浏览器渲染真 HTML，
  // 不做静态截图管线。srcdoc 不产生导航 URL → /edit 的 frame-src 'none'（BL-P7-03）零改动；
  // srcdoc 文档继承本页 CSP（script-src nonce 化）→ 预览即便残留脚本也不执行。
  // 切换语义（诚实口径）：正文与排版微调保留；主题自带维度（栏式/配色/章节样式）以新主题默认为准。
  var THEME_META = {
    classic: { label: '单栏', audience: '适合通用求职主简历：一页排满、内容紧凑、打印最稳。' },
    dual: { label: '双栏', audience: '适合经历较多、想把一页排满的求职者：主栏经历、侧栏技能摘要。' },
    magazine: { label: '单栏·展示', audience: '适合现场展示与设计向岗位：衬线刊头、留白与杂志版式。' }
  };
  var THEME_SWITCH_SEMANTICS = '正文与排版微调（字号/行距/页边距）会原样保留；主题自带的维度（栏式、配色、章节样式）以新主题默认为准。';
  var THEME_DUAL_CALM = '双栏与单栏同为纯文本 PDF，文字可完整选中与复制，内容结构不变。';
  var THEME_INFO = window.__THEME_INFO__ || { themes: [], current: '' };
  var themePane = right.querySelector('#ed-pane-theme');
  var themeBuilt = false;
  function buildThemePane() {
    var cur = THEME_INFO.current || '';
    if (!themeBuilt) {
      themeBuilt = true;
      themePane.innerHTML = '';
      var box = document.createElement('div');
      box.className = 'ed-theme';
      (Array.isArray(THEME_INFO.themes) ? THEME_INFO.themes : []).forEach(function (t) {
        var meta = THEME_META[t] || { label: '主题', audience: '' };
        var card = document.createElement('div');
        card.className = 'ed-tcard' + (t === cur ? ' ed-tcur' : '');
        card.setAttribute('data-theme', t);
        var head = document.createElement('div');
        head.className = 'ed-tcard-head';
        head.innerHTML = '<span class="ed-tname">' + escHtml(meta.label) + '</span>'
          + (t === cur ? '<span class="ed-tbadge">当前</span>' : '');
        card.appendChild(head);
        var aud = document.createElement('div');
        aud.className = 'ed-taud';
        aud.textContent = meta.audience;
        card.appendChild(aud);
        var thumb = document.createElement('div');
        thumb.className = 'ed-tthumb';
        var loading = document.createElement('div');
        loading.className = 'ed-tload';
        loading.textContent = '预览加载中…';
        thumb.appendChild(loading);
        var frame = document.createElement('iframe');
        frame.setAttribute('title', '主题「' + meta.label + '」的当前简历预览');
        frame.setAttribute('loading', 'lazy');
        frame.setAttribute('tabindex', '-1');
        thumb.appendChild(frame);
        card.appendChild(thumb);
        fetch('/theme-preview?id=' + encodeURIComponent(DOC_ID) + '&theme=' + encodeURIComponent(t))
          .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); })
          .then(function (html) {
            thumb.removeChild(loading);
            frame.srcdoc = html;   // srcdoc：无导航 URL（frame-src 'none' 不受阻）且继承本页 CSP
          })
          .catch(function () { loading.textContent = '预览加载失败'; });
        if (t === 'dual') {
          var calm = document.createElement('div');
          calm.className = 'ed-tcalm';
          calm.textContent = THEME_DUAL_CALM;
          card.appendChild(calm);
        }
        var apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'ed-tapply';
        apply.textContent = t === cur ? '当前主题' : '选用此模板';
        if (t === cur) apply.disabled = true;
        else {
          apply.addEventListener('click', function () {
            var ok = window.confirm('切换到「' + meta.label + '」主题？\n\n' + THEME_SWITCH_SEMANTICS
              + '\n\n未保存的修改不会包含在切换里（可先 ⌘S 保存）。切换完成后页面会刷新。');
            if (!ok) return;
            fetch('/theme/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: DOC_ID, theme: t }) })
              .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
              .then(function (r) {
                if (r.ok && r.j && r.j.ok) location.reload();
                else __status(saveState, 'err', (r.j && r.j.error) || '主题切换失败');
              })
              .catch(function () { __status(saveState, 'err', '主题切换失败：网络错误'); });
          });
        }
        card.appendChild(apply);
        box.appendChild(card);
      });
      var sem = document.createElement('div');
      sem.className = 'ed-tsem';
      sem.textContent = '切换语义：' + THEME_SWITCH_SEMANTICS;
      box.appendChild(sem);
      themePane.appendChild(box);
    } else {
      // 仅刷新「当前」标记与按钮可用态（meta.theme 可能在别处被改过）
      var curNow = THEME_INFO.current;
      themePane.querySelectorAll('.ed-tcard').forEach(function (c) {
        var isCur = c.getAttribute('data-theme') === curNow;
        c.classList.toggle('ed-tcur', isCur);
        var badge = c.querySelector('.ed-tbadge');
        var btn = c.querySelector('.ed-tapply');
        if (isCur && !badge) {
          var b = document.createElement('span');
          b.className = 'ed-tbadge';
          b.textContent = '当前';
          c.querySelector('.ed-tcard-head').appendChild(b);
        } else if (!isCur && badge) { badge.remove(); }
        if (btn) { btn.disabled = isCur; btn.textContent = isCur ? '当前主题' : '选用此模板'; }
      });
    }
  }


  // ===== 预览模式 =====
  var previewing = false;
  function setPreview(on) {
    previewing = on;
    document.body.classList.toggle('ed-preview', on);
    sheet.contentEditable = on ? 'false' : 'true';
    var modeLabel = tools.querySelector('.ed-mode-label');
    if (modeLabel) modeLabel.textContent = on ? '预览为近似效果，以导出 PDF 为准' : '直接点击正文编辑';
    if (previewBtn) previewBtn.textContent = on ? '返回编辑' : '预览';
    if (on) {
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var isNarrowMotion = document.body.classList.contains('ed-on') && window.innerWidth < 768;
      if (!reduceMotion && !isNarrowMotion) {
        sheet.style.transform = 'perspective(1200px) rotateX(3deg)';
        setTimeout(function () { sheet.style.transform = ''; }, 360);
      }
    }
    updateStatus();
  }
  if (previewBtn) previewBtn.addEventListener('click', function () { setPreview(!previewing); });

  // ===== 底部状态区 =====
  var status = document.createElement('div');
  status.id = 'ed-status';
  status.innerHTML = '<span id="ed-st-page"></span><span id="ed-st-zoom"></span><span id="ed-st-words"></span>'
    + '<button type="button" id="ed-undo-btn" class="ed-undobtn" style="display:none"></button>'
    + '<span class="ed-st-right" id="ed-st-sug"></span>';
  mount(status);
  status.querySelector('#ed-undo-btn').addEventListener('click', function () { window.__edUndoLast(); });
  var stPage = status.querySelector('#ed-st-page');
  var stZoom = status.querySelector('#ed-st-zoom');
  var stWords = status.querySelector('#ed-st-words');
  var stSug = status.querySelector('#ed-st-sug');
  function totalPages() { return sheet.querySelectorAll('.page-line').length || 1; }
  function currentPage() {
    var y = sheet.scrollTop / zoom;
    return Math.min(totalPages(), Math.max(1, Math.floor(y / SHEET_H) + 1));
  }
  function updateStatus() {
    stPage.textContent = '约 ' + totalPages() + ' 页 · A4（估算，以导出为准）';
    stZoom.textContent = '缩放 ' + Math.round(zoom * 100) + '%';
    var overflow = sheet.scrollWidth > sheet.clientWidth + 2;
    stWords.innerHTML = '字数 ' + sheet.textContent.replace(/\s/g, '').length + (overflow ? ' · ' + __icon('circle-alert') + ' 内容横向溢出' : '');
    var pending = document.querySelectorAll('.ai-change').length
      - document.querySelectorAll('.ai-change[style*="opacity"]').length;
    stSug.textContent = pending > 0 ? '待处理建议 ' + pending : '';
  }
  var statusTimer = null;
  sheet.addEventListener('input', function () {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      updateStatus();
      if (!navlist.contains(document.activeElement)) renderNav();  // 导航内有焦点时不重建，避免丢焦点
    }, 400);
  });
  navlist.addEventListener('focusout', function () {
    setTimeout(function () { if (!navlist.contains(document.activeElement)) renderNav(); }, 0);
  });
  sheet.addEventListener('scroll', function () {
    stPage.textContent = '约 ' + totalPages() + ' 页 · A4（第 ' + currentPage() + ' 页）';
  }, { passive: true });
  // 建议数变化（AI 面板嵌入右栏后观察其子树）
  if ('MutationObserver' in window) {
    var mo = new MutationObserver(function () {
      clearTimeout(statusTimer);
      statusTimer = setTimeout(updateStatus, 300);
    });
    mo.observe(right, { childList: true, subtree: true });
  }
  updateStatus();
  // 窄屏初始自适应宽度（A4 794px 在手机上不可读，默认缩到格子宽）
  if (window.innerWidth < 768) {
    setZoom(Math.max(0.4, (window.innerWidth - 24) / SHEET_W));
  }
  // S2-T6：会话状态恢复。位置硬要求两条：① 晚于上面那次窄屏自适应 setZoom（存过的 zoom 优先于自适应默认值）；
  // ② restoreUi 内部先 setZoom 再写 sheet.scrollTop（zoom 改变布局高度，顺序反了同一像素值就不是同一位置）。
  // 导航高亮无需特殊处理：renderNav() 已在前面跑过，恢复滚动后 IntersectionObserver 会自行把 active 推到正确章节。
  restoreUi();

  // ===== 选区工具条宿主（按钮行为由 ai-panel.js 绑定；无 AI 面板时隐藏）=====
  var seltb = document.createElement('div');
  seltb.id = 'ed-seltb';
  seltb.setAttribute('role', 'toolbar');
  seltb.setAttribute('aria-label', '选区改写');
  seltb.innerHTML = '<button type="button" data-preset="concise">精简表达</button>'
    + '<button type="button" data-preset="contrib">突出个人贡献</button>'
    + '<button type="button" data-preset="wording">改善措辞</button>'
    + '<button type="button" data-preset="evidence">补充证据</button>';
  mount(seltb);
})();
