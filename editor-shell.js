// editor-shell.js — 编辑器外壳（A 方向：清爽专业＋轻立体三栏）
// 由 server /edit 幂等注入（SHELL-INJECT 注释对），/save 随注释对剥离，落盘文档零污染
// 布局：body 级 CSS Grid，.sheet 不移动 DOM（光标/选区/AI 定位零风险）；缩放用 zoom（布局级，caret 正确）
(function () {
  var DOC_ID = document.currentScript.getAttribute('data-doc');
  // 初始磁盘 mtime 暴露给模板保存状态机（多标签冲突检测的基线）
  window.__edDocMtime = Number(document.currentScript.getAttribute('data-mtime') || 0);
  var sheet = document.querySelector('.sheet');
  if (!sheet) return;
  // 幂等：清掉历史落盘/重复注入的外壳 DOM 与样式后重建（落盘残留无事件绑定，复用会是死 UI）
  ['ed-left', 'ed-right', 'ed-status', 'ed-canvas-tools', 'ed-seltb', 'ed-matpop', 'ed-matmask'].forEach(function (id) {
    var stale = document.getElementById(id);
    if (stale) stale.remove();
  });
  document.querySelectorAll('style[data-ed-shell]').forEach(function (el) { el.remove(); });

  var MM = 3.7795275591;
  var SHEET_W = 210 * MM;   // 794px
  var SHEET_H = 297 * MM;   // 1123px
  var MATS = Array.isArray(window.__MATS__) ? window.__MATS__ : [];
  var JOB_INFO = window.__JOB_INFO__ || { hasJob: false };

  // ===== 设计令牌 + 外壳样式（仅屏幕；print 一律隐藏外壳、还原文档流）=====
  var css = document.createElement('style');
  css.setAttribute('data-ed-shell', '1');
  css.textContent = '@media screen{'
    +  'body.ed-on{--ed-bg:#F0EBE2;--ed-panel:#FFFCF5;--ed-ink:#26221C;--ed-mut:#6E675C;--ed-line:#DED3C0;--ed-accent:#C2410C;--ed-accent-ink:#FFF7ED;--ed-accent-soft:#FBE9D8;--ed-ok:#2F6B4F;--ed-ok-soft:#E4EFE6;--ed-warn:#A25711;--ed-warn-soft:#FBEEDC;--ed-err:#A32B2B;--ed-err-soft:#F7E4E1;--ed-serif:"Songti SC","Noto Serif CJK SC","Source Han Serif SC",Georgia,serif;--ed-sans:"PingFang SC",-apple-system,sans-serif;'
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
    + '.ed-on .edit-toolbar .save-state[data-state="saving"]{color:var(--ed-accent);background:var(--ed-accent-soft)}'
    + '.ed-on .edit-toolbar .save-state[data-state="error"]{color:var(--ed-err);background:var(--ed-err-soft)}'
    + '.ed-on .edit-toolbar button{min-height:32px;padding:0 12px;border-radius:8px;font-size:12px;font-weight:600;transition:transform .12s,box-shadow .12s,background .12s;'
    + 'background:var(--ed-panel);color:var(--ed-ink);border:1px solid var(--ed-line)}'
    + '.ed-on .edit-toolbar button:hover{transform:translateY(-1px);box-shadow:0 3px 9px rgba(24,27,48,.12)}'
    + '.ed-on .edit-toolbar button:active{transform:translateY(1px);box-shadow:none}'
    + '.ed-on .edit-toolbar button:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}'
    + '.ed-on .edit-toolbar button.ed-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '.ed-on .edit-toolbar button.ed-ghost{border-color:transparent;background:transparent;color:var(--ed-mut)}'
    + '.ed-on .edit-toolbar button.ed-ghost:hover{background:var(--ed-bg);color:var(--ed-ink)}'
    + '.ed-on .edit-toolbar button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.ed-on .edit-toolbar .save-state{font-size:11px}'
    + '.ed-on .edit-toolbar .badge{margin:0}'
    // 画布工具条（缩放）
    + '#ed-canvas-tools{grid-row:2;grid-column:2;display:flex;align-items:center;gap:6px;padding:6px 16px;font-size:11px;color:var(--ed-mut);min-width:0}'
    + '#ed-canvas-tools .ed-zoom{margin-left:auto;display:flex;align-items:center;gap:4px}'
    + '#ed-canvas-tools button{min-height:24px;min-width:24px;padding:0 6px;border:1px solid var(--ed-line);border-radius:6px;background:var(--ed-panel);color:var(--ed-ink);font-size:12px;cursor:pointer}'
    + '#ed-canvas-tools button:hover{background:var(--ed-bg)}'
    + '#ed-canvas-tools button:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '#ed-canvas-tools .ed-znum{width:56px;text-align:right;font-variant-numeric:tabular-nums;border:1px solid var(--ed-line);border-radius:6px;padding:3px 6px;font-size:12px;min-height:24px}'
    + '#ed-canvas-tools .ed-zunit{color:var(--ed-mut)}'
    // 纸张：grid item 原地落位，内部滚动；zoom 缩放只影响屏幕
    + '.ed-on .sheet{grid-row:3;grid-column:2;justify-self:center;height:100%;overflow-y:auto;margin:0 0 16px;'
    + 'box-shadow:0 4px 17px rgba(37,50,75,.08);transition:box-shadow .2s}'
    // 左栏
    + '#ed-left{grid-row:2/4;grid-column:1;overflow-y:auto;background:var(--ed-panel);border-right:1px solid var(--ed-line);padding:16px 12px;min-width:0}'
    + '#ed-left.ed-hidden{display:none}'
    + '.ed-label{font-family:var(--ed-serif);font-size:10px;letter-spacing:1px;color:var(--ed-mut);margin:2px 0 10px;text-transform:uppercase}'
    + '.ed-jobtitle{font-size:13px;font-weight:700;color:var(--ed-ink);margin:-4px 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-nav{display:flex;align-items:center;gap:4px;width:100%;text-align:left;padding:8px 10px;margin:2px 0;border:none;border-radius:7px;font-size:12px;color:var(--ed-mut);background:transparent;cursor:pointer;min-height:32px}'
    + '.ed-nav:hover{background:var(--ed-bg)}'
    + '.ed-nav.active{background:var(--ed-accent-soft);color:var(--ed-accent);font-weight:600}'
    + '.ed-nav:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.ed-nav .ed-nav-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-nav .ed-nav-ops{display:none;gap:2px;flex:none}'
    + '.ed-nav:hover .ed-nav-ops,.ed-nav:focus-within .ed-nav-ops{display:inline-flex}'
    + '.ed-nav .ed-nav-ops button{min-width:22px;min-height:22px;padding:0;border:none;background:transparent;color:var(--ed-mut);cursor:pointer;border-radius:4px;font-size:11px;line-height:1}'
    + '.ed-nav .ed-nav-ops button:hover{background:var(--ed-line);color:var(--ed-ink)}'
    + '.ed-nav-go{flex:1;min-width:0;border:none;background:transparent;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-nav-go:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    // 条目级积木行（项目/经历）
    + '.ed-nav-entries{margin:0 0 6px 12px;border-left:1px solid var(--ed-line);padding-left:6px}'
    + '.ed-nav-entry{display:flex;align-items:center;gap:2px;padding:2px 4px;border-radius:5px;font-size:11px;color:var(--ed-mut)}'
    + '.ed-nav-entry:hover{background:var(--ed-bg)}'
    + '.ed-nav-entry .ed-entry-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-nav-entry.ed-entry-off .ed-entry-name{text-decoration:line-through;color:var(--ed-mut)}'
    + '.ed-nav-entry .ed-nav-ops{display:inline-flex;gap:2px;flex:none}'
    + '.ed-nav-entry .ed-nav-ops button{min-width:20px;min-height:20px;padding:0;border:none;background:transparent;color:var(--ed-mut);cursor:pointer;border-radius:4px;font-size:10px;line-height:1}'
    + '.ed-nav-entry .ed-nav-ops button:hover{background:var(--ed-line);color:var(--ed-ink)}'
    + '.ed-nav.ed-sec-off .ed-nav-name{text-decoration:line-through;color:var(--ed-mut)}'
    + '.ed-divider{height:1px;background:var(--ed-line);margin:16px -4px}'
    + '.ed-addsec{width:100%;margin-top:10px;min-height:32px;padding:0 12px;border:1px dashed var(--ed-line);border-radius:8px;background:transparent;color:var(--ed-mut);font-size:12px;cursor:pointer}'
    + '.ed-addsec:hover{border-color:var(--ed-accent);color:var(--ed-accent)}'
    + '.ed-mat{border:1px solid var(--ed-line);border-radius:9px;padding:10px;font-size:12px;margin-top:10px;cursor:pointer;transition:box-shadow .15s,transform .15s;background:var(--ed-panel)}'
    + '.ed-mat:hover{box-shadow:0 3px 9px rgba(24,27,48,.10);transform:translateY(-1px)}'
    + '.ed-mat:focus-visible{outline:2px solid var(--ed-accent);outline-offset:1px}'
    + '.ed-mat small{display:block;margin-top:4px;font-size:10px;color:var(--ed-mut)}'
    + '.ed-mat .ed-mat-unconf{margin-left:6px;font-size:10px;font-weight:600;color:var(--ed-warn);background:var(--ed-warn-soft);border-radius:999px;padding:1px 6px}'
    + '.ed-matpop-warn{font-size:12px;color:var(--ed-warn);background:var(--ed-warn-soft);border-radius:7px;padding:6px 8px;margin-bottom:6px}'
    + '.ed-mat-search{width:100%;box-sizing:border-box;border:1px solid var(--ed-line);border-radius:7px;padding:6px 8px;font-size:12px;margin-top:4px}'
    + '.ed-compat{font-size:11px;color:var(--ed-mut);line-height:1.6;padding:8px 10px;background:var(--ed-bg);border-radius:7px}'
    // 右栏
    + '#ed-right{grid-row:2/4;grid-column:3;background:var(--ed-panel);border-left:1px solid var(--ed-line);display:flex;flex-direction:column;min-width:0;overflow:hidden}'
    + '#ed-right.ed-hidden{display:none}'
    + '#ed-rtabs{display:flex;gap:2px;border-bottom:1px solid var(--ed-line);padding:8px 8px 0;flex:none}'
    + '#ed-rtabs button{flex:1;min-height:32px;padding:0 4px;border:none;background:transparent;font-size:12px;font-weight:600;color:var(--ed-mut);cursor:pointer;border-radius:7px 7px 0 0;box-shadow:inset 0 0 0 transparent}'
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
    + '.ed-typo .ed-reset{width:100%;min-height:32px;border:1px solid var(--ed-line);border-radius:8px;background:var(--ed-panel);color:var(--ed-ink);font-size:12px;cursor:pointer}'
    + '.ed-typo .ed-reset:hover{background:var(--ed-bg)}'
    + '.ed-typo .ed-note{font-size:11px;color:var(--ed-mut);line-height:1.6;margin-top:12px}'
    // 底栏
    + '#ed-status{grid-row:4;grid-column:1/-1;display:flex;gap:16px;align-items:center;padding:5px 16px;font-size:11px;color:var(--ed-mut);background:var(--ed-panel);border-top:1px solid var(--ed-line);min-height:28px}'
    + '#ed-status .ed-st-right{margin-left:auto}'
    + '#ed-status .ed-undobtn{border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink);border-radius:999px;font-size:11px;min-height:20px;padding:0 10px;cursor:pointer}'
    + '#ed-status .ed-undobtn:hover{background:var(--ed-bg)}'
    // 折叠开关（顶栏注入的图标按钮）
    + '.ed-iconbtn{min-width:28px;min-height:28px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center}'
    // 选区工具条（4 动作，取代原 #ai-sel-btn 单钮；由 ai-panel 供电时隐藏旧钮）
    + '#ed-seltb{position:absolute;z-index:99;display:none;gap:2px;background:var(--ed-ink);color:var(--ed-panel);border-radius:8px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,.18);font-size:12px}'
    + '#ed-seltb button{min-height:26px;padding:0 8px;border:none;border-radius:6px;background:transparent;color:var(--ed-panel);font-size:11px;cursor:pointer;white-space:nowrap}'
    + '#ed-seltb button:hover{background:rgba(255,255,255,.14)}'
    + '#ed-seltb button:focus-visible{outline:2px solid var(--ed-accent-soft);outline-offset:1px}'
    // 素材选择器弹层
    + '#ed-matpop{position:fixed;z-index:102;top:50%;left:50%;transform:translate(-50%,-50%);width:min(480px,92vw);max-height:80vh;overflow-y:auto;background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:14px;box-shadow:0 18px 50px rgba(41,48,80,.16);padding:16px;display:none;font-size:13px}'
    + '#ed-matpop h3{font-family:var(--ed-serif);margin:0 0 10px;font-size:14px}'
    + '#ed-matpop .ed-matpop-sec{margin:10px 0}'
    + '#ed-matpop .ed-matpop-label{font-size:11px;color:var(--ed-mut);margin-bottom:4px}'
    + '#ed-matpop select{width:100%;border:1px solid var(--ed-line);border-radius:8px;padding:7px 10px;font-size:12px;background:var(--ed-panel)}'
    + '#ed-matpop .ed-matprev{border:1px solid var(--ed-line);border-radius:8px;padding:10px;font-size:12px;line-height:1.7;color:var(--ed-ink);background:var(--ed-bg);white-space:pre-wrap;max-height:180px;overflow-y:auto}'
    + '#ed-matpop .ed-matrow{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}'
    + '#ed-matpop .ed-matrow button{min-height:32px;padding:0 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '#ed-matpop .ed-matrow button.ed-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '#ed-matpop .ed-mattypes{display:flex;gap:6px}'
    + '#ed-matpop .ed-mattypes button{flex:1;min-height:30px;border:1px solid var(--ed-line);border-radius:7px;background:var(--ed-panel);font-size:11px;color:var(--ed-mut);cursor:pointer}'
    + '#ed-matpop .ed-mattypes button.on{border-color:var(--ed-accent);color:var(--ed-accent);background:var(--ed-accent-soft);font-weight:600}'
    + '#ed-matmask{position:fixed;inset:0;background:rgba(32,39,55,.24);z-index:101;display:none}'
    // 岗位草稿弹层（结构化输入，创建独立草稿，不依赖模型）
    + '#ed-jobmask{position:fixed;inset:0;background:rgba(32,39,55,.24);z-index:103;display:none}'
    + '#ed-jobpop{position:fixed;z-index:104;top:50%;left:50%;transform:translate(-50%,-50%);width:min(520px,94vw);max-height:86vh;overflow-y:auto;background:var(--ed-panel);border:1px solid var(--ed-line);border-radius:14px;box-shadow:0 18px 50px rgba(41,48,80,.16);padding:16px;display:none;font-size:13px}'
    + '#ed-jobpop h3{font-family:var(--ed-serif);margin:0 0 4px;font-size:14px}'
    + '#ed-jobpop .ed-jp-note{font-size:11px;color:var(--ed-mut);margin-bottom:10px}'
    + '#ed-jobpop label{display:block;font-size:12px;color:var(--ed-ink);margin:8px 0 2px}'
    + '#ed-jobpop input,#ed-jobpop textarea,#ed-jobpop select{width:100%;border:1px solid var(--ed-line);border-radius:8px;padding:7px 10px;font-size:12px;background:var(--ed-panel);box-sizing:border-box}'
    + '#ed-jobpop textarea{min-height:70px;resize:vertical}'
    + '#ed-jobpop .ed-jp-row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}'
    + '#ed-jobpop .ed-jp-row button{min-height:32px;padding:0 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)}'
    + '#ed-jobpop .ed-jp-row button.ed-primary{background:var(--ed-accent);border-color:var(--ed-accent);color:var(--ed-accent-ink)}'
    + '#ed-jobpop .ed-jp-msg{font-size:11px;color:var(--ed-warn);margin-top:8px;min-height:14px}'
    // 预览模式：纸张短过渡后归正，正文保持平面
    + '.ed-preview .sheet{transition:transform .35s ease,box-shadow .35s ease;box-shadow:0 12px 32px rgba(37,50,75,.14)}'
    + '.ed-preview .sheet p:hover,.ed-preview .sheet li:hover,.ed-preview .sheet h1:hover,.ed-preview .sheet .entry-head:hover,.ed-preview .sheet .contact:hover{outline:none!important}'
    // 定位高亮闪记
    + '@keyframes edFlash{0%{outline:2px solid var(--ed-accent);outline-offset:2px}100%{outline:2px solid transparent;outline-offset:2px}}'
    + '.ed-flash{animation:edFlash 1.2s ease-out}'
    // 面板/布局过渡（折叠列宽过渡在 body.ed-on 上）
    // 响应式：中屏收左栏，窄屏单栏切换
    + '@media(max-width:1200px){body.ed-on{--ed-left-w:0px;--ed-right-w:300px}#ed-left{position:absolute;z-index:60;top:0;bottom:0;left:0;width:240px;box-shadow:4px 0 16px rgba(41,48,80,.10);display:none}#ed-left.ed-open{display:block}}'
    + '@media(max-width:767px){body.ed-on{grid-template-columns:minmax(0,1fr);--ed-right-w:0px}'
    + '#ed-canvas-tools{display:none}'
    + '#ed-right{position:fixed;z-index:70;top:0;right:0;bottom:0;width:min(340px,94vw);box-shadow:-4px 0 16px rgba(41,48,80,.12);display:none}'
    + '#ed-right.ed-open{display:flex}}'
    + '@media(prefers-reduced-motion:reduce){body.ed-on{transition:none}.ed-on .edit-toolbar button,.ed-mat,.ed-preview .sheet{transition:none!important}.ed-flash{animation:none!important}}'
    // 外壳视觉兜底覆盖：存量文档内联的工具栏/toast/恢复条版本不一，一律由注入层统一（仅屏幕、不落盘、不进 PDF）
    + '.ed-on .edit-toolbar button{background:var(--ed-panel);color:var(--ed-ink);border:1px solid var(--ed-line);border-radius:8px}'
    + '.ed-on .edit-toolbar button.secondary{background:var(--ed-panel);color:var(--ed-ink);border:1px solid var(--ed-line)}'
    // 主次（用户定）：操作区默认中性描边，只有主任务「导出 PDF」用橙色实心；撤销按钮不得比主任务抢眼
    + '.ed-on .edit-toolbar button#pdfBtn,.ed-on .edit-toolbar button.primary{background:var(--ed-accent);color:var(--ed-accent-ink);border:1px solid var(--ed-accent);font-weight:700}'
    // 左右栏正文（用户定）：13px/1.6，条目名用省略号而非频繁断行；衬线只留给标题类
    + '.ed-on #ed-left,.ed-on #ed-right{font-size:13px;line-height:1.6}'
    + '.ed-on .ed-nav .item{display:flex;gap:4px;align-items:center;flex-wrap:wrap;font-size:13px;line-height:1.6}'
    + '.ed-on .ed-nav .item > .label,.ed-on .ed-nav .item > span:first-child{flex:1 1 90px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ed-on .save-state[data-state="saved"]{color:var(--ed-ok);background:var(--ed-ok-soft)}'
    + '.ed-on .save-state[data-state="dirty"]{color:var(--ed-warn);background:var(--ed-warn-soft)}'
    + '.ed-on .save-state[data-state="saving"]{color:var(--ed-accent);background:var(--ed-accent-soft)}'
    + '.ed-on .save-state[data-state="error"]{color:var(--ed-err);background:var(--ed-err-soft)}'
    + '.ed-on .toast{background:var(--ed-ink);color:var(--ed-panel)}'
    + '.ed-on .recovery-bar{background:var(--ed-warn);color:var(--ed-accent-ink)}'
    + '.ed-on .recovery-bar button{background:var(--ed-panel);color:var(--ed-warn)}'
    + '.ed-on .recovery-bar button.secondary{background:var(--ed-warn);color:var(--ed-accent-ink);border:1px solid var(--ed-accent-ink)}'
    + '.ed-on .page-line{border-top-color:rgba(166,90,18,.34)}'
    + '.ed-on .page-line span{color:rgba(166,90,18,.78);background:rgba(255,252,245,.88)}'
    + '.ed-on .sheet{caret-color:var(--ed-accent)}'
    + '.ed-on .sheet p:hover,.ed-on .sheet li:hover,.ed-on .sheet h1:hover,.ed-on .sheet .entry-head:hover,.ed-on .sheet .contact:hover{outline-color:rgba(194,65,12,.45)}'
    + '.ed-on button:focus-visible,.ed-on input:focus-visible,.ed-on textarea:focus-visible,.ed-on a:focus-visible{outline-color:var(--ed-accent)}'
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
  if (pdfBtn) { pdfBtn.classList.remove('secondary'); pdfBtn.classList.add('ed-primary'); pdfBtn.textContent = '导出 PDF'; pdfBtn.title = '导出前检查并下载 PDF'; }
  if (saveBtn) { saveBtn.classList.add('ed-ghost'); saveBtn.textContent = '保存'; saveBtn.title = '保存（⌘/Ctrl+S，打历史快照）'; }
  if (histBtn) { histBtn.classList.remove('secondary'); histBtn.title = '版本历史'; }
  if (homeBtn) { homeBtn.textContent = '‹ 工作台'; homeBtn.title = '返回工作台'; homeBtn.classList.add('ed-ghost'); }

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
    ltBtn.textContent = '☰';
    toolbar.insertBefore(ltBtn, toolbar.firstChild);
  }
  if (toolbar && !rtBtn) {
    rtBtn = document.createElement('button');
    rtBtn.type = 'button';
    rtBtn.className = 'ed-iconbtn ed-ghost ed-right-toggle';
    rtBtn.setAttribute('data-ed-inj', '1');
    rtBtn.setAttribute('aria-label', '辅助面板');
    rtBtn.title = 'AI 助手 / 排版 / 岗位匹配';
    rtBtn.textContent = '⚙';
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
  // 目标顺序（appendChild 移动已有节点，幂等）
  if (toolbar) {
    [ltBtn, homeBtn, docName, verBadge].forEach(function (el) { if (el) toolbar.appendChild(el); });
    var spacer = toolbar.querySelector('.spacer');
    if (spacer) toolbar.appendChild(spacer);
    [jobBtn, saveState, saveBtn, histBtn, previewBtn, pdfBtn, rtBtn].forEach(function (el) { if (el) toolbar.appendChild(el); });
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

  function notifyEdit() { sheet.dispatchEvent(new Event('input', { bubbles: true })); }

  // ===== 统一程序化撤销栈（覆盖章节/条目/素材/AI/审阅的自动修改；原生输入撤销仍用 ⌘Z）=====
  var undoStack = [];
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
    undoStack.push({ label: label || '', state: snapshotState() });
    if (undoStack.length > 30) undoStack.shift();
    updateUndoBtn();
  };
  window.__edUndoLast = function () {
    var op = undoStack.pop();
    if (!op) return false;
    sheet.innerHTML = op.state.body;
    if (window.__edSetTypo) window.__edSetTypo(op.state.typo);
    notifyEdit();
    renderNav();
    updateUndoBtn();
    return true;
  };

  var navlist = left.querySelector('#ed-navlist');
  function entryPair(entry) { return entry.ul ? [entry.head, entry.ul] : [entry.head]; }
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
          mk('↑', '上移条目', function () {
            var prev = entries[idx - 1];
            if (!prev) return;
            sheet.insertBefore(en.head, prev.head);
            if (en.ul) sheet.insertBefore(en.ul, prev.head);
          }, idx === 0);
          mk('↓', '下移条目', function () {
            var next = entries[idx + 1];
            if (!next) return;
            sheet.insertBefore(next.head, en.head);
            if (next.ul) sheet.insertBefore(next.ul, en.head);
          }, idx === entries.length - 1);
          mk(off ? '显' : '隐', (off ? '显示' : '隐藏') + '该条目（不删除内容，PDF 同步）', function () {
            setEntryHidden(en, !off);
          }, false);
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
  function flashEl(el) {
    el.classList.remove('ed-flash');
    void el.offsetWidth;  // 重触发动画
    el.classList.add('ed-flash');
    setTimeout(function () { el.classList.remove('ed-flash'); }, 1300);
  }
  renderNav();

  // 滚动同步当前章节（sheet 内部滚动；取观察带内最靠上的章节，底部排除带收窄让末节可命中）
  var navTimer = null;
  var io = null;
  function observeTitles() {
    if (!io) return;
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
    var sec = document.createElement('section');
    sec.className = 'section';
    var t = document.createElement('div');
    t.className = 'section-title';
    t.textContent = name.trim();
    var p = document.createElement('p');
    p.textContent = '点击编辑内容…';
    sec.appendChild(t); sec.appendChild(p);
    sheet.appendChild(sec);
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
      confBtn.style.cssText = 'min-height:30px;padding:0 12px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--ed-line);background:var(--ed-panel);color:var(--ed-ink)';
      confBtn.addEventListener('click', function () {
        fetch('/mat/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [m.id], confirmed: true }) })
          .then(function () { m.confirmed = true; warn.textContent = '已确认 ✓ 可参与自动生成'; confBtn.remove(); renderMats(left.querySelector('#ed-matsearch').value.trim().toLowerCase()); });
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
    if (e.key === 'Escape' && matpop.style.display === 'block') { e.stopPropagation(); closeMatPop(); }
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
    if (e.key === 'Escape' && jobpop.style.display === 'block') { e.stopPropagation(); closeJobPop(); }
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
    h.textContent = '🎯 针对岗位生成简历草稿';
    var note = document.createElement('div');
    note.className = 'ed-jp-note';
    note.textContent = '基于当前文档创建独立草稿（不修改母版）。未配置模型也可先创建；配置后可在右侧「审阅」面板生成并审阅建议。';
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
      fetch('/job/create', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: DOC_ID, company: company, role: role, jd: inJd.value, jdLink: inLink.value.trim() }) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); })
        .then(function (d) {
          ok.disabled = false;
          if (d && d.existing) { if (confirm('同岗位草稿已存在（' + d.existing + '），打开它？')) location.href = '/edit?id=' + d.existing; return; }
          if (d && d.ok && d.id) { location.href = '/edit?id=' + d.id; return; }
          msg.textContent = '⚠️ ' + ((d && d.error) || '创建失败');
        })
        .catch(function (e) { ok.disabled = false; msg.textContent = '⚠️ ' + e.message; });
    });
    row.append(cancel, ok);
    jobpop.append(row, msg);
    jobmask.style.display = 'block';
    jobpop.style.display = 'block';
    inCompany.focus();
  }
  if (jobBtn) jobBtn.addEventListener('click', openJobPop);

  // 插入：章节内有 ul 则 append li，否则 append p；撤销 = 移除节点
  function insertIntoSection(secEl, text) {
    window.__edPushUndo('插入素材');
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
    notifyEdit();
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashEl(node);
    undoToast('已插入素材', function () { node.remove(); notifyEdit(); });
  }
  // 撤销 toast（复用现有 .toast 样式，加按钮）
  function undoToast(msg, undo) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.style.pointerEvents = 'auto';
    var span = document.createElement('span');
    span.textContent = msg + '　';
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = '撤销';
    b.style.cssText = 'background:transparent;border:1px solid var(--ed-panel);color:var(--ed-panel);border-radius:4px;padding:1px 8px;font-size:12px;cursor:pointer';
    b.addEventListener('click', function () { undo(); t.remove(); });
    t.appendChild(span); t.appendChild(b);
    mount(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 400); }, 5000);
  }

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
    zoom = Math.min(1.5, Math.max(0.4, Math.round(z * 100) / 100));
    sheet.style.zoom = zoom === 1 ? '' : String(zoom);
    zval.value = Math.round(zoom * 100);
    updateStatus();
  }
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
    + '<button type="button" role="tab" data-pane="ai" aria-selected="' + (JOB_INFO.hasJob ? 'false' : 'true') + '">AI 助手</button>'
    + '<button type="button" role="tab" data-pane="typo" aria-selected="false">排版</button>'
    + '<button type="button" role="tab" data-pane="match" aria-selected="false">岗位匹配</button>'
    + '</div>'
    + (JOB_INFO.hasJob ? '<div id="ed-pane-review" class="ed-pane on" role="tabpanel" aria-label="修改清单"></div>' : '')
    + '<div id="ed-pane-ai" class="ed-pane' + (JOB_INFO.hasJob ? '' : ' on') + '" role="tabpanel" aria-label="AI 助手"></div>'
    + '<div id="ed-pane-typo" class="ed-pane" role="tabpanel" aria-label="排版设置"></div>'
    + '<div id="ed-pane-match" class="ed-pane" role="tabpanel" aria-label="岗位匹配"></div>';
  mount(right);

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
  }
  function toggleRight() {
    if (window.innerWidth < 768) right.classList.toggle('ed-open');
    else {
      right.classList.toggle('ed-hidden');
      document.body.style.setProperty('--ed-right-w', right.classList.contains('ed-hidden') ? '0px' : '320px');
    }
  }
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
  });

  // ===== 排版设置（typo-custom 落盘进 head，render.mjs 读到 → PDF 一致）=====
  var TYPO_DEFAULTS = { fontSize: 13, lineHeight: 1.43, pagePad: 9.4, paraGap: 0.45, secGap: 2.9 };
  var typoPane = right.querySelector('#ed-pane-typo');
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
  buildTypoPane();
  // 排版被恢复缓存/程序改写时，面板同步刷新（模板侧负责参考线与保存标记）
  window.addEventListener('ed-typo', function () { buildTypoPane(); });
  }
  function buildTypoPane() {
    var v = readTypo();
    typoPane.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'ed-typo';
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
    var note = document.createElement('div');
    note.className = 'ed-note';
    note.textContent = '设置随文档保存，导出 PDF 与屏幕预览一致。修改正文排版不影响编辑器界面。';
    box.appendChild(note);
    typoPane.appendChild(box);
  }
  buildTypoPane();

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
    stWords.textContent = '字数 ' + sheet.textContent.replace(/\s/g, '').length + (overflow ? ' · ⚠️ 内容横向溢出' : '');
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
