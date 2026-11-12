# JD 网址导入（书签抓取）设计 spec — 2026-11-12

> 上游：`渐进呈现` 主线 T4 已把 /job/new 收敛为单动线；本 spec 解决「贴 JD 链接」在 Boss 直聘等登录墙站点必然失败的问题。调研与 POC 结论：Boss job_detail 对一切非真实浏览器访问设三层墙（连接层拒绝 → JS 安全验证 → 登录重定向），服务端 fetch、headless Chromium、Jina Reader、Firecrawl stealth、移动端 UA 全部实测失败；唯一可行通道是**用户自己的浏览器把已渲染页面递进来**（书签按钮 + 隐藏表单 POST）。POC（/tmp/jd-poc）已在真实 Boss 页面验证全链路。

## 1. 目标与边界

- **目标**：在 JD 页点一次书签 → 工作台提取出 {公司, 岗位, JD 全文} → 预览确认 → 带入 /job/new 生成草稿。
- **覆盖站点**：Boss 直聘（验证过）+ 猎聘/拉勾/前程无忧/智联（选择器表预留，未验证）+ 任意含 JSON-LD JobPosting 的站点（公司官网、Greenhouse/Lever 系）+ body 文本兜底。
- **不做**：CDP 连真实 Chrome（备选，需常驻 debug 端口，留作后续 power-user 项）、服务端渲染抓取 Boss（已证不可行）、手机端分享流、OCR。静态 fetch 链路保留不动（开放站点仍秒成）。

## 2. 组件

### 2.1 书签（/job/new 页面提供拖拽源）

- `<a href="javascript:…">抓取此页 → 工作台</a>`，提示「拖到书签栏；在 JD 页点它」。
- 书签代码：创建隐藏 `<form method=POST target=_blank action="/import/page 的绝对地址">`，三个字段 `html`(document.documentElement.outerHTML)、`url`(location.href)、`title`(document.title)，submit 后移除。
- 用表单导航而非 fetch：目标站 CSP 的 `connect-src` 管不到表单提交；bookmarklet 本身豁免页面 CSP；`target=_blank` 让结果直接开在新标签。
- 端口不写死：书签代码由服务端用当前实际端口渲染（7766/7767/7768 顺延情形）。

### 2.2 端点 `POST /import/page`

- 收 urlencoded body：`html`（≤ 8MB 截断保护）、`url`、`title`。零写盘、零存储——提取结果只进响应页。
- 响应头：`Access-Control-Allow-Origin: *`；`OPTIONS` 预检回 `Access-Control-Allow-Private-Network: true` + 常规 CORS 头（https→localhost 的 PNA 要求，表单导航虽不依赖但 fetch 类调用方可能走预检，统一放行）。
- 跑 `extractJd(html, url)` → 渲染「提取结果」页：来源/标题/公司/岗位/JD 长度/JD 全文预览（全部 escHtml）；页底一个表单：隐藏字段 `jd`/`company`/`role`/`jdLink`(=来源url) + 母版 select（在盘未归档文档，同 jobNewPage 口径；选中值以 `from` 字段随行）+ 提交按钮「带去定制」POST 到 `/job/new`。
- 提取失败（JD < 50 字符）：预览页如实显示「没提到 JD」+ 两个备选动作（回 JD 页复制全文粘贴 / 确认用兜底文本）。

### 2.3 `extractJd(html, url)`（服务端，零依赖正则解析，与 fetchPageText 同风格）

层级顺序：
1. **站点表**（按 host 命中；每条 `{host, jobInfoVar?, selectors{jd[],role[],company[]}}`）：
   - `zhipin.com`：优先 `_jobInfo` 内嵌对象（`job_name`/`job_salary`/`company`——POC 已验证存在于详情页）；DOM 兜底 `.company-name`、`<h1>`、`.job-sec-text`（JD，多个候选选择器按序尝试取首个 ≥50 字符者）。
   - `liepin.com`/`lagou.com`/`51job.com`/`zhaopin.com`：常见容器选择器各备 2-3 条（初值按公开结构写，未实测，失败自动走下一层）。
2. **JSON-LD `JobPosting`**：扫 `application/ld+json`，取 `description`/`title`/`hiringOrganization.name`。
3. **body 兜底**：剥 script/style/标签取纯文本，截 8000 字符（与 fetchPageText 4000 的既有口径区分——书签递交的是已验证人工可见页面，给更长额度）。

返回 `{company, role, jd, via}`（via ∈ site-jsonld/site-selectors/jobposting/body-fallback），预览页显示 via 便于诊断。

### 2.4 `/job/new` 预填衔接

- `POST /job/new` 新增处理（原 GET 不动）：body `{jd, company, role, jdLink, from?}` → 渲染同一表单，`jobJd` 预填 JD、`jobCompany`/`jobRole` 预填、`jobLink` 预填来源 URL、`jobFrom` 预选母版（jdLinkRow 展开显示，jdSource 即链接本身）。
- 复用现有提交管线零变化：jdSource 记原链接 → `createJobDraft` 的 jdId 指纹/查重/`sameJob` 守卫原样生效——同链接再点书签→提示已有草稿。

### 2.5 /job/new 失败引导（文案升级）

- 静态抓取（/ai/jd-text）失败时 jobMsg 区追加：「这个站抓不到（多半要登录）。两个办法：① 回页面复制全文粘贴 ② 把下面书签拖到书签栏，在 JD 页点一下」+ 书签链接内联呈现。
- 链接区常态展示书签（小字说明「Boss/猎聘等登录站用这个」）。

## 3. 安全与纪律

- /import/page **零写盘**：不产生文件、不改 meta、无副作用——任何网页 POST 过来最坏只是新开一个预览标签。
- 提取输出全走 escHtml/escAttr（预览页渲染与表单回填两处）；导入 HTML 永不回显原文只回显剥离后文本。
- CSP：/import/page 响应页沿用 page() 外壳（script-src 'self' nonce）；预览页交互为零（纯表单提交，无脚本需求——「带去定制」是普通 POST form）。
- 无 npm 依赖、无数据模型变更（import 不落盘）、无登录态处理、无 on* 属性。

## 4. 测试

- `test-fixtures/reliability/` 新增 fixture：真实 Boss 详情页 HTML 修剪版（本次 POC 已抓 last.html，裁到关键区块 ~30KB；`_jobInfo` 中的 `securityId`/`user_id`/uid 类会话令牌一律剔除——公开 JD 可入仓，会话凭据不可）+ 一个 JSON-LD JobPosting 样本 + 一个无结构纯文本页。
- 断言：extractJd 三层级各命中（Boss→_jobInfo 三字段+JD；JSON-LD→结构化；body→兜底文本）；/import/page POST→200+预览含三字段；OPTIONS→CORS/PNA 头；超 8MB→截断不炸；/job/new POST 预填→表单值在位且 jdLinkRow 展开；端到端同 JD 链接二次导入→查重命中。
- test-structure.sh 登记新路由 + 书签 javascript: href 存在性断言（含动态端口）；DESIGN.md §10 登记一节。

## 5. 遗留/后续

- 猎聘/拉勾/51job/智联选择器初值为结构猜测，首用失败后按存证 HTML 校正（last.html 式存证机制已在 POC 验证有效，正式版可在预览页加「提取不对？存证供诊断」链接存 html 到 /tmp，**可选**——默认仍零写盘）。
- CDP 连接真实 Chrome（`--remote-debugging-port`）是社区对 Boss 的主流方案，可作「全自动贴链接」后续项：用户 Chrome 常驻 debug 端口+已登录时，服务端开标签读 DOM——重运维、本轮不做。
- 手机端 JD：Boss App 分享 → 复制文本 → 桌面粘贴（现有路径），不进本轮。
