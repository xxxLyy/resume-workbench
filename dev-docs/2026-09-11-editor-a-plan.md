# 编辑器 A 方向（清爽专业＋轻立体）实施计划

> 日期：2026-09-11 ｜ 设计方向：A（用户已确认）｜ 视觉规格来源：editor-directions.html 草图 A CSS
> 执行方式：当前会话 inline 执行，TaskCreate 跟踪；禁 git（项目纪律）；test.sh 重定向非管道、不并发、不强杀

**Goal:** 编辑器从「单栏 + fixed 顶栏 + fixed AI 抽屉」升级为 A 方向三栏工作台（顶栏/左栏章节素材/A4 画布缩放/右侧辅助面板/底部状态区/选区工具栏），首页卡片轻 3D，全站按钮层级统一，零落盘污染、零文档迁移。

**Architecture（三板斧讲清）:**
1. 外壳全走 **serve 注入**：`editor-shell.js` 由 `/edit` 注入（`<!--SHELL-INJECT-->` 幂等标记），运行时 DOM 收进注释对之间，`/save` 正则剥离——落盘格式零变化、旧文档零迁移、PDF（render.mjs 读落盘文件）与快照预览（不注入）天然免疫。
2. 布局用 **body 级 CSS Grid**，`.sheet` 不移动 DOM（光标/选区/AI 定位零风险），缩放用 `zoom`（布局级、滚动范围自适应、Chrome caret 正确），全部屏幕样式包 `@media screen`，print 双保险隐藏。
3. **存量 bug 顺带闭环**：实测发现浏览器保存会把 ai-panel 运行时 DOM 落盘（复利膨胀）。修法：ai-panel 启动幂等清理 + 运行时 DOM 插入 `<!--AI-INJECT-->` 注释对之间（服务端正则已存在，自动剥离）。

**Tech Stack:** 零框架原生 HTML/JS（不改 React）；CSS 变量设计系统；playwright-core（既有依赖）做浏览器实证。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `editor-shell.js` 🆕 | 创建 | 外壳全部：Grid 布局 CSS（内联）、顶栏增强、左栏章节导航+素材、画布缩放、右栏 Tab 宿主、排版设置、底部状态区、选区工具栏、预览模式 |
| `ai-panel.js` | 修改 | ①幂等自清理 ②DOM 入注释对 ③检测外壳则嵌入右栏 Tab（对话+体检→AI 助手；JD→岗位匹配）④样式接设计变量 |
| `server.mjs` | 修改 | `/edit` 注入 shell+素材数据（幂等）；`/save` 增 SHELL 剥离正则；`page()` CSS 升级（设计变量+按钮层级+卡片 3D） |
| `test.sh` | 修改 | W5 断言段：注入幂等/剥离/素材/排版落盘/首页 3D 标记 |
| `template.html` | **不动** | 零迁移的关键 |
| `dev-docs/handoff.md` | 修改 | 收尾更新 |

## 设计令牌（取自草图 A，全站统一）

```
--ed-bg:#F4F5F8（工作区灰）  --ed-panel:#FFFFFF  --ed-ink:#202737
--ed-mut:#697186（次要文字，对比度≥4.5）  --ed-line:#DCE0E8（边框）
--ed-accent:#5B5DE8（靛蓝主色）  --ed-accent-ink:#FFFFFF
--ed-ok:#2F7D5A  --ed-warn:#B45309  --ed-err:#B91C1C
间距尺度：4/8/12/16/20/24  圆角：6(badge)/8(按钮)/10(卡片)/14(面板)
按钮高 32px（icon 28px），字号 12-13px，字重 600
动效：按钮 120ms / 面板 200ms / 预览 ≤350ms；transform+opacity only
```

## 按钮层级

`.btn` 基类（高 32、padding 0 12、圆角 8、gap 6、transition 120ms）
├ `.btn-primary`：导出 PDF、采纳应用（accent 实底）
├ `.btn-secondary`：预览、历史、取消（白底灰边）
├ `.btn-ghost`：低频工具（无底无边，hover 浅灰底）
├ `.btn-danger`：删除（红字红边，hover 浅红底）
└ `.btn-icon`：28px 方块，必须 aria-label + title
状态：:hover 抬升 1px+浅影 / :active translateY(1px) / :focus-visible 2px accent outline / :disabled 灰字+`cursor:not-allowed`+title 解释 / [data-loading] 宽度不变（透明字+spin 伪元素）

---

### Task 1: 存量修复 —— ai-panel DOM 落盘污染（红→绿先行）

**Files:** Modify `ai-panel.js`（开头+root 挂载处）、`test.sh`（W5 段断言）

- [ ] **Step 1: test.sh 先写红断言**（W5 段，模拟含 AI 注释对+运行时 DOM 的保存体）

```bash
# W5：AI 面板 DOM 不落地（注释对包裹 + 服务端剥离）
python3 - "$PORT" << 'PYEOF'
import sys, urllib.request
port = sys.argv[1]
html = open('docs/smoketest.html').read()
polluted = html.replace('</body>', '<!--AI-INJECT-->\n<div><button id="ai-toggle">🤖</button><div id="ai-drawer"></div></div>\n<!--/AI-INJECT-->\n</body>')
req = urllib.request.Request('http://localhost:'+port+'/save?id=smoketest', data=polluted.encode(), headers={'Content-Type':'text/html'})
urllib.request.urlopen(req).read()
PYEOF
grep -q 'ai-toggle' docs/smoketest.html && { echo '❌ W5 AI 面板 DOM 落盘'; exit 1; }
echo '✅ AI 面板 DOM 不落地'
```

- [ ] **Step 2: 跑 test.sh 确认红**（服务端正则只认 `<!--AI-INJECT--><script...><!--/AI-INJECT-->` 整块——正则 `[\s\S]*?` 非贪婪，实际已能剥任意内容。先跑确认现状红/绿，再定客户端改动范围）

- [ ] **Step 3: ai-panel.js 幂等清理 + 注释对挂载**

```js
// 开头（sheet 检查之后）：
// 幂等：清掉历史保存意外落盘/上次注入的面板 DOM，防复利膨胀
['ai-toggle', 'ai-drawer', 'ai-sel-btn', 'ai-pop'].forEach(function (id) {
  var el = document.getElementById(id); if (el) el.remove();
});
document.querySelectorAll('style[data-ai-panel]').forEach(function (el) { el.remove(); });
// css 节点打标：css.setAttribute('data-ai-panel', '1');

// root 挂载改为插入 AI-INJECT 注释对之间（保存时被服务端正则剥离，不落盘）：
function findComment(text) {
  var it = document.createNodeIterator(document.body, NodeFilter.SHOW_COMMENT);
  var n; while ((n = it.nextNode())) { if (n.data === text) return n; }
  return null;
}
var endMark = findComment('/AI-INJECT');
if (endMark) endMark.parentNode.insertBefore(root, endMark);
else document.body.appendChild(root);  // 兜底：无注释对（直接打开文档文件）时照常可用
```

- [ ] **Step 4: test.sh 绿 + 三连跑零 flaky**

### Task 2: 设计变量 + 按钮层级 + 首页卡片 3D（server.mjs `page()`）

**Files:** Modify `server.mjs:63-107`（page CSS）、`server.mjs:199`（doc-card class）、`test.sh`

- [ ] **Step 1: page() CSS 升级**（保留 BENTO-V1 标记，追加 A 方向令牌与按钮层级；`--indigo` 改指 `#5B5DE8`）

```css
/*A-VARS*/:root{--bg:#F4F5F8;--ink:#202737;--mut:#697186;--line:#DCE0E8;--indigo:#5B5DE8;
--radius:10px;--shadow:0 1px 3px rgba(41,48,80,.06);--shadow-up:0 10px 24px rgba(41,48,80,.10)}
button{font:inherit;min-height:32px;padding:0 12px;border-radius:8px;font-weight:600;transition:transform .12s,box-shadow .12s,background .12s}
button:hover{opacity:1;transform:translateY(-1px);box-shadow:0 3px 9px rgba(24,27,48,.12)}
button:active{transform:translateY(1px)}
button.secondary:hover{background:#F4F5F8}
button:disabled{opacity:.55;cursor:not-allowed;transform:none;box-shadow:none}
@media(hover:hover) and (pointer:fine){
.doc-card{transition:transform .25s,box-shadow .25s;transform:perspective(900px)}
.doc-card:hover{transform:perspective(900px) rotateX(2deg) rotateY(-2deg) translateY(-3px);box-shadow:var(--shadow-up)}}
.doc-card:focus-within{outline:2px solid var(--indigo);outline-offset:2px}
@media(prefers-reduced-motion:reduce){*{transition:none!important}.doc-card:hover{transform:none!important}}
```

- [ ] **Step 2: test.sh 断言**（首页含 `A-VARS` 与 `rotateX`；按钮 disabled 有 not-allowed）

- [ ] **Step 3: 跑 test.sh 绿**

### Task 3: 外壳注入通道（server.mjs /edit + /save 剥离）

**Files:** Modify `server.mjs:109-113`（注入函数区）、`server.mjs:292-306`（/edit）、`server.mjs:1168-1179`（/save）、`test.sh`

- [ ] **Step 1: 注入块函数 + 静态路由 + /save 正则**

```js
const SHELL_MARK = '<!--SHELL-INJECT-->';
function shellBlock(id) {
  const mats = loadMats().map((m) => ({ id: m.id, title: m.title, tags: m.tags || [],
    brief: m.brief, technical: m.technical || '', interview: m.interview || '' }));
  return `\n${SHELL_MARK}<script>window.__MATS__=${JSON.stringify(mats).replace(/</g, '\\u003c')};</script><script src="/editor-shell.js" data-doc="${id}" defer></script><!--/SHELL-INJECT-->\n`;
}
// /edit 路由内（AI 注入之后）：if (!html.includes(SHELL_MARK)) html = html.replace('</body>', shellBlock(id) + '</body>');
// /save：剥离正则扩展为两条
//   .replace(/\n?<!--SHELL-INJECT-->[\s\S]*?<!--\/SHELL-INJECT-->\n?/g, '\n')
// 静态路由：GET /editor-shell.js → 读文件返回（同 /ai-panel.js 款）
```

- [ ] **Step 2: test.sh 断言**

```bash
curl -sf "http://localhost:$PORT/edit?id=smoketest" | grep -q 'editor-shell.js' || { echo '❌ W5 缺外壳注入'; exit 1; }
CNT=$(curl -sf "http://localhost:$PORT/edit?id=smoketest" | grep -c 'SHELL-INJECT')
[ "$CNT" = "2" ] || { echo "❌ W5 外壳注入幂等破坏 ($CNT)"; exit 1; }  # 开/闭注释各一
curl -sf "http://localhost:$PORT/edit?id=smoketest" | grep -q '__MATS__' || { echo '❌ W5 缺素材注入'; exit 1; }
# 含 SHELL 注释对的保存体落盘须干净
python3 - "$PORT" << 'PYEOF'
import sys, urllib.request
port = sys.argv[1]
html = open('docs/smoketest.html').read()
polluted = html.replace('</body>', '<!--SHELL-INJECT-->\n<div id="ed-left">x</div><script>window.__MATS__=[];</script>\n<!--/SHELL-INJECT-->\n</body>')
req = urllib.request.Request('http://localhost:'+port+'/save?id=smoketest', data=polluted.encode(), headers={'Content-Type':'text/html'})
urllib.request.urlopen(req).read()
PYEOF
grep -q 'ed-left\|__MATS__' docs/smoketest.html && { echo '❌ W5 外壳 DOM 落盘'; exit 1; }
echo '✅ 外壳注入/剥离/素材数据'
```

- [ ] **Step 3: 创建空 editor-shell.js 占位 → 跑 test.sh 绿**

### Task 4: 外壳骨架 —— Grid 三栏 + 顶栏 + 缩放 + 底栏

**Files:** Modify `editor-shell.js`

- [ ] **Step 1: CSS（内联 style，@media screen 包裹 + print 隐藏）**

```css
@media screen{
body.ed-on{display:grid;height:100vh;overflow:hidden;background:#F4F5F8;
 grid-template-columns:var(--ed-left-w,208px) 1fr var(--ed-right-w,320px);
 grid-template-rows:auto auto 1fr auto}
.ed-on .edit-toolbar{position:static;grid-row:1;grid-column:1/-1;top:auto;left:auto;right:auto;
 border-radius:0;border:none;border-bottom:1px solid #DCE0E8;box-shadow:none;padding:8px 16px}
#ed-left{grid-row:2/4;grid-column:1;overflow-y:auto;background:#fff;border-right:1px solid #DCE0E8;padding:16px 12px}
#ed-canvas-tools{grid-row:2;grid-column:2;display:flex;align-items:center;gap:8px;padding:8px 16px;color:#697186;font-size:12px}
.ed-on .sheet{grid-row:3;grid-column:2;justify-self:center;align-self:stretch;height:100%;overflow-y:auto;
 box-shadow:0 4px 17px rgba(37,50,75,.08);margin:0 0 16px}
#ed-right{grid-row:2/4;grid-column:3;overflow:hidden;background:#fff;border-left:1px solid #DCE0E8;display:flex;flex-direction:column}
#ed-status{grid-row:4;grid-column:1/-1;display:flex;gap:16px;padding:6px 16px;font-size:11px;color:#697186;background:#fff;border-top:1px solid #DCE0E8}
body.ed-left-off{--ed-left-w:0px}body.ed-right-off{--ed-right-w:0px}
#ed-left.ed-hidden,#ed-right.ed-hidden{display:none}
}
@media print{#ed-left,#ed-right,#ed-status,#ed-canvas-tools,#ed-seltb,#ed-matpop{display:none!important}
 body.ed-on{display:block;height:auto;overflow:visible;background:#fff}}
```

关键实现点：
- body 加 `ed-on` 类启动外壳；`.sheet` 不移动 DOM（grid item 直接落位）
- 缩放：`sheet.style.zoom = z`（0.5–1.5，步进 0.05）；「适应宽度」=`(canvas格宽-48)/793.7`；「100%」复原。zoom 只影响屏幕，print media 不含 zoom（注入 CSS 只在 screen 生效，且落盘无此 CSS）
- 顶栏增强：pdfBtn 升级 `.btn-primary` 样式类（外壳覆盖），saveBtn 降为 ghost；注入「预览」按钮（secondary）于 histBtn 后；长标题 `text-overflow:ellipsis + title` 全名
- AI 抽屉打开时顶栏不再右移（ai-panel 嵌入右栏后 setDrawer 的 tb.style.right 逻辑删除）
- 底栏：`第 n / N 页`（分页线数+1，sheet 滚动位置估算当前页）｜`缩放 85%`｜`字数 1234`｜`待处理建议 3`（`.ai-change` 未办数；ai-panel 未开时 0 不显示）
- [ ] **Step 2: 浏览器实证**：1440px 截图——三栏成立、纸张居中灰底、顶栏不覆盖正文、底栏数据真实

### Task 5: 左栏 —— 章节导航 + 章节管理

**Files:** Modify `editor-shell.js`

- [ ] **Step 1: 导航扫描/定位/高亮**

```js
function scanSections() {
  return Array.from(sheet.querySelectorAll('.section')).map(function (sec, i) {
    var t = sec.querySelector('.section-title');
    return { el: sec, title: t ? t.textContent.trim() : '未命名', idx: i };
  });
}
// 点击 nav → sec.el.scrollIntoView({block:'start'}) + nav.active
// sheet 滚动时 IntersectionObserver 同步当前章节高亮（root: sheet）
// 无 .section 结构（降级文档）→ 显示「此文档暂无法识别章节结构」兼容提示，不转换
```

- [ ] **Step 2: 添加/排序/隐藏**（操作真实 DOM，保存即生效；隐藏用 `.ed-sec-hidden{display:none}` class——屏幕与 print 同样隐藏，内容保留可恢复）
  - 添加：prompt 名称 → append `.section` 骨架（标题+空 p）→ 触发 input 事件入保存流
  - 排序：每项 ↑↓ ghost 按钮，移动 DOM 节点
  - 隐藏：👁 切换 class；导航项显示「已隐藏」态
  - 全部操作后 `sheet.dispatchEvent(new Event('input',{bubbles:true}))` 接入现有保存状态机

- [ ] **Step 3: 浏览器实证**：点击导航定位正确、隐藏后 PDF 不含该章节（pdftotext 验证）、添加/排序落盘

### Task 6: 左栏 —— 素材入口

**Files:** Modify `editor-shell.js`

- [ ] **Step 1: 列表 + 搜索**：渲染 `__MATS__`（标题+tags+已有表达类型图标），左栏内 input 过滤
- [ ] **Step 2: 插入选择器**（`#ed-matpop` 居中弹层，role=dialog，Escape 关闭，焦点进入/返回）：
  - 预览三种表达全文 → 选表达类型 → 选目标章节（下拉，来自 scanSections）→「插入」
  - 插入：目标章节末尾 append `<p>`（plain-lines 内）或 `<li>`（ul 内，按章节现有结构判断）→ input 事件
  - 撤销：toast 5s「已插入 撤销」按钮，移除插入节点
- [ ] **Step 3: 浏览器实证**：插入到正确章节、撤销生效、保存后落盘、弹层 Esc/焦点管理

### Task 7: 右栏 —— Tab 宿主 + ai-panel 嵌入

**Files:** Modify `editor-shell.js`（Tab 骨架）、`ai-panel.js`（嵌入适配）

- [ ] **Step 1: 外壳 Tab 系统**（role=tablist，←→ 键切换，aria-selected）

```html
<div id="ed-rtabs" role="tablist">
  <button role="tab" data-pane="ai" aria-selected="true">AI 助手</button>
  <button role="tab" data-pane="typo">排版</button>
  <button role="tab" data-pane="match">岗位匹配</button>
</div>
<div id="ed-pane-ai" role="tabpanel"></div>
<div id="ed-pane-typo" role="tabpanel" hidden></div>
<div id="ed-pane-match" role="tabpanel" hidden></div>
```

- [ ] **Step 2: ai-panel.js 嵌入**：检测 `#ed-pane-ai` 存在则
  - `#ai-pane-chat` + `#ai-pane-review` 移入 AI 助手 pane（保留现 #ai-tabs 二 tab 作子切换）
  - `#ai-pane-match` 移入岗位匹配 pane
  - `#ai-toggle`/`#ai-drawer` 的 fixed 抽屉模式停用（不创建 toggle，drawer display:none）
  - 样式变量对齐（--ed-accent 系）；建议卡增加「成功✓ + 撤销」已有，保留
  - 面板切换不丢状态：Tab 只切 hidden，DOM 不重建（输入/建议/历史天然保留）
- [ ] **Step 3: 浏览器实证**：AI 面板在右栏不遮正文不遮顶栏；Tab 切换后对话输入与建议卡保留；截图

### Task 8: 右栏 —— 排版设置面板

**Files:** Modify `editor-shell.js`

- [ ] **Step 1: typo-custom 机制**（写文档 head 的 `<style id="typo-custom">`——落盘随正文保存，render.mjs 读到即 PDF 一致）

```js
var TYPO_DEFAULTS = { fontSize: 13, lineHeight: 1.43, pagePad: 9.4, paraGap: 0.45, secGap: 2.9 };
function typoCss(v) {
  return 'body{font-size:' + v.fontSize + 'px;line-height:' + v.lineHeight + '}'
    + '.sheet{padding-top:' + v.pagePad + 'mm;padding-bottom:' + v.pagePad + 'mm}'
    + '.plain-lines p{margin-bottom:' + v.paraGap + 'mm}li{margin:' + v.paraGap + 'mm 0}'
    + '.section{margin-top:' + v.secGap + 'mm}';
}
// 应用：无块则创建（含 /*TYPO-CUSTOM*/ 注释），有块则更新 textContent；触发 input 事件
// 恢复默认：移除该 style 块
// 初始化：解析现有块正则回填控件
```

- [ ] **Step 2: 面板控件**：5 组 range+number 联动输入（label for 关联）+「恢复默认」secondary 按钮
- [ ] **Step 3: test.sh 断言**（POST 含 typo-custom 块的保存体落盘后仍在 head）

```bash
grep -q 'typo-custom' docs/smoketest.html && echo '✅ 排版设置落盘' || { echo '❌ W5 排版未落盘'; exit 1; }
```

- [ ] **Step 4: 浏览器实证**：改字号 → 屏幕即时变 + 保存 + /export PDF 文本仍正常（pdftotext）+ 恢复默认

### Task 9: 选区工具栏（4 动作）

**Files:** Modify `ai-panel.js`（#ai-sel-btn 扩展）

- [ ] **Step 1: 单按钮改四按钮条**（`#ed-seltb`：精简表达/突出个人贡献/改善措辞/补充证据；定位逻辑沿用 selRect，不遮选中文字——置于选区上方，上方不足则下方）
- [ ] **Step 2: 点击 = 预设 instruction 打开现有 #ai-pop**（不直改正文）：

```js
var PRESETS = {
  concise: '精简表达：压缩到最短，保留事实与数据',
  contrib: '突出个人贡献：明确"我"负责的环节与动作，不夸大',
  wording: '改善措辞：修正语病与口语化，保持原意',
  evidence: '补充证据：指出缺哪些指标/事实并给出待补占位，不编造数字'
};
```

- [ ] **Step 3: 浏览器实证**：缩放 85% 下选中文字 → 工具条位置正确 → 点「精简表达」→ pop 打开且 selText 正确（console 无错）

### Task 10: 预览模式 + 首页 3D 之外的编辑器微交互

**Files:** Modify `editor-shell.js`

- [ ] **Step 1: 预览切换**：顶栏「预览」→ body 加 `ed-preview`：sheet contenteditable=false + 隐藏 hover 虚线 + 纸张 350ms 轻微 rotateX 过渡归正；底栏提示「近似预览，以导出 PDF 为准」；再点返回编辑（动画 ≤350ms，结束后 transform 清空）
- [ ] **Step 2: 微交互**：面板展开收起 200ms、Tab 200ms、建议采纳成功态、定位高亮闪一下（outline 动画 1s 后清除）、保存成功 toast 已有
- [ ] **Step 3: 浏览器实证**：预览进出无残留 transform、编辑态始终平面、reduced-motion 下全部跳过

### Task 11: 响应式 + 无障碍收尾

**Files:** Modify `editor-shell.js`

- [ ] **Step 1: 断点**
  - ≥1200px：三栏全显
  - 768–1200px：左栏默认收起（顶栏 ☰ 开关），右栏可切换
  - <768px：单栏，顶栏「编辑/工具」分段切换（工具视图 = 左栏+右栏内容纵排），保存/返回/导出始终顶栏可达；无全局横向滚动（body overflow:hidden 已保证）
- [ ] **Step 2: 无障碍**：全部新按钮 aria-label；focus-visible 统一；弹层 Esc + 焦点往返；触控目标 ≥32px；错误/状态不只靠颜色（图标+文字）
- [ ] **Step 3: 浏览器实证**：1440/1024/768/375 四档截图 + Tab 键走查 + 375px 无横向滚动

### Task 12: 全量回归 + 交付

- [ ] **Step 1: test.sh 三连跑零 flaky**（含 W5 新断言）
- [ ] **Step 2: 浏览器全清单实证**（验证节 14 项逐条过，隔离文档 zz-e2e，完即清理）
- [ ] **Step 3: PDF 实证**：导出真实 PDF → pdftotext + 目检无工具栏/灰底/3D
- [ ] **Step 4: 更新 handoff.md**（已实现/已验证/待验证分栏）
- [ ] **Step 5: 复盘四步法输出 + KPI 卡**

---

## Self-Review 记录

- **规格覆盖**：任务书第四节 6 块（顶栏/左栏/画布/右栏/选区/底栏）→ Task 4-9；第五节按钮 → Task 2+全量；第六节 3D 动效 → Task 2（首页）+10（预览/微交互）；第七节响应式无障碍 → Task 11；第八节数据迁移 → 注释对机制（Task 1/3）+ 排版落盘（Task 8）；第九节验证 → Task 12。
- **类型一致**：`scanSections`/`__MATS__`/`TYPO_DEFAULTS`/`PRESETS` 命名全文统一。
- **刻意不做**（YAGNI）：不新建素材系统、不动统计/备份/看板业务、不引入 Three.js/动画库、不改 render.mjs、template.html 零改动零迁移。
