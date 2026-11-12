# JD 网址导入 双轨设计 spec — 2026-11-12

> 上游：`渐进呈现` 主线 T4 已把 /job/new 收敛为单动线；本 spec 解决「贴 JD 链接」在 Boss 直聘等登录墙站点必然失败的问题。调研与 POC 结论：Boss job_detail 对一切非真实浏览器访问设三层墙（连接层拒绝 → JS 安全验证 → 登录重定向），服务端 fetch、headless Chromium、Jina Reader、Firecrawl stealth、移动端 UA 全部实测失败。
>
> **双轨并行，用户裁决对比**：
> - **轨 A（书签）**：用户浏览器把已渲染页面递进来——POC（/tmp/jd-poc）已在真实 Boss 页面验证全链路。
> - **轨 B（Boss 会话）**：playwright 持久 profile 扫码登录一次 → 贴 zhipin 链接时服务端带会话抓详情页。灵感来自 boss-agent-cli（登录态+wapi），但适配收窄为「URL→JD」单点：不做其 security_id 依赖的 detail API，直接抓详情页 DOM（会话有效时 `_jobInfo` 可读）。
> 两轨共用同一 `extractJd` 与同一「预览→带入 /job/new」出口。

## 1. 目标与边界

- **目标**：在 JD 页点一次书签 → 工作台提取出 {公司, 岗位, JD 全文} → 预览确认 → 带入 /job/new 生成草稿。
- **覆盖站点**：Boss 直聘（验证过）+ 猎聘/拉勾/前程无忧/智联（选择器表预留，未验证）+ 任意含 JSON-LD JobPosting 的站点（公司官网、Greenhouse/Lever 系）+ body 文本兜底。
- **不做**：boss-agent-cli 全套能力（搜索/打招呼/HR——我们只要 URL→JD）、CDP 连用户主 Chrome（用独立持久 profile，不碰主浏览器）、手机端分享流、OCR。静态 fetch 链路保留不动（开放站点仍秒成）。

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

### 2.4 轨 B：Boss 会话（zhipin 专属通道）

- **会话存储**：playwright 持久上下文 `userDataDir`（仓内 `boss-session/` 目录，gitignore；首次需要时创建）。只存浏览器 profile（cookie/localStorage 由 chromium 自己管），**不显式导出 cookie 文件**——登录态不离开本机 chromium 数据目录。
- **登录流程**：/job/new（或设置页）「Boss 会话」区：`POST /boss/session/login` → `chromium.launchPersistentContext(userDataDir, {headless:false})` 开真窗口到 zhipin 登录页 → 用户扫码/验证码登录 → 服务端轮询 `context.cookies()` 出现 Boss 会话 cookie（`__zp_stoken__` 或登录态标识）→ 关闭浏览器、标记已登录（存 `{loggedAt, ua}` 到 `boss-session/state.json`）。超时 5 分钟无登录 → 关闭并回报未登录。
- **抓取流程**：贴 zhipin 链接且有会话时：`launchPersistentContext(userDataDir, {headless:true, executablePath: chromium-headless-shell})` → `addInitScript` 覆盖 `document.hidden/visibilityState`（社区已知 Boss visibility 反爬对策）→ goto 详情页 waitUntil domcontentloaded + 等 `_jobInfo` 出现或 8s 超时 → 整页 HTML 喂 `extractJd`。命中登录墙/安全页（URL 含 security/web/user 或 `_jobInfo` 缺席且 JD 空）→ 判会话失效，提示重新登录。
- **降级**：headless 失败但会话有效迹象 → 可选降级 headed 一闪（抢焦点打扰用户，默认关；配置项 `bossHeadedFallback`）。
- **边界**：会话只用于 zhipin.com 域名；并发抓取串行化（一个浏览器实例锁）；失败全部落回轨 A 提示。

### 2.5 `/job/new` 预填衔接

- `POST /job/new` 新增处理（原 GET 不动）：body `{jd, company, role, jdLink, from?}` → 渲染同一表单，`jobJd` 预填 JD、`jobCompany`/`jobRole` 预填、`jobLink` 预填来源 URL、`jobFrom` 预选母版（jdLinkRow 展开显示，jdSource 即链接本身）。
- 复用现有提交管线零变化：jdSource 记原链接 → `createJobDraft` 的 jdId 指纹/查重/`sameJob` 守卫原样生效——同链接再点书签→提示已有草稿。

### 2.6 /job/new 失败引导与会话状态（文案升级）

- 静态抓取（/ai/jd-text）失败时 jobMsg 区追加：「这个站抓不到（多半要登录）。两个办法：① 回页面复制全文粘贴 ② 把下面书签拖到书签栏，在 JD 页点一下」+ 书签链接内联呈现。
- 链接区常态展示书签（小字说明「Boss/猎聘等登录站用这个」）。
- 「Boss 会话」状态块（仅 zhipin 相关区域或 /job/new 底部）：未登录→「可选：登录后贴 Boss 链接可自动抓」+登录按钮；已登录→绿点+登录时间+「重新登录/清除会话」；会话失效→橙点+重登提示。

## 3. 安全与纪律

- /import/page **零写盘**：不产生文件、不改 meta、无副作用——任何网页 POST 过来最坏只是新开一个预览标签。
- 提取输出全走 escHtml/escAttr（预览页渲染与表单回填两处）；导入 HTML 永不回显原文只回显剥离后文本。
- CSP：/import/page 响应页沿用 page() 外壳（script-src 'self' nonce）；预览页交互为零（纯表单提交，无脚本需求——「带去定制」是普通 POST form）。
- 轨 B 会话 profile 落 `boss-session/`（gitignore，新目录属运行时数据非模型变更）；`state.json` 只记 `{loggedAt}` 不导 cookie；登录窗口是用户主动动作，不静默起浏览器。
- 无 npm 依赖（playwright-core 现有）、无数据模型变更（import 不落盘）、无 on* 属性。

## 4. 测试

- `test-fixtures/reliability/` 新增 fixture：真实 Boss 详情页 HTML 修剪版（本次 POC 已抓 last.html，裁到关键区块 ~30KB；`_jobInfo` 中的 `securityId`/`user_id`/uid 类会话令牌一律剔除——公开 JD 可入仓，会话凭据不可）+ 一个 JSON-LD JobPosting 样本 + 一个无结构纯文本页。
- 断言：extractJd 三层级各命中（Boss→_jobInfo 三字段+JD；JSON-LD→结构化；body→兜底文本）；/import/page POST→200+预览含三字段；OPTIONS→CORS/PNA 头；超 8MB→截断不炸；/job/new POST 预填→表单值在位且 jdLinkRow 展开；端到端同 JD 链接二次导入→查重命中。
- 轨 B（源级为主，真登录走人工点验）：boss-session 目录 gitignore 断言；login 端点在「已登录」短路；visibility 覆盖脚本存在性；会话失效判定分支（security/user URL 或 _jobInfo 缺席）有测试替身；串行锁并发断言。
- test-structure.sh 登记新路由 + 书签 javascript: href 存在性断言（含动态端口）；DESIGN.md §10 登记一节。

## 5. 遗留/后续

- 猎聘/拉勾/51job/智联选择器初值为结构猜测，首用失败后按存证 HTML 校正（last.html 式存证机制已在 POC 验证有效，正式版可在预览页加「提取不对？存证供诊断」链接存 html 到 /tmp，**可选**——默认仍零写盘）。
- 轨 B 后续可选：CDP 连用户主 Chrome（省一次扫码，代价是主浏览器要常驻 debug 端口——本轮用独立 profile 规避了主 Chrome 介入）；headed 抓取兜底开关；会话健康巡检。
- 对比口径（交付给用户）：贴 Boss 链接时轨 A=「点书签→预览→带入」三步、轨 B=「零操作服务端抓」但需不定期重登；成功率与打扰度的取舍由用户实测裁决。
- 手机端 JD：Boss App 分享 → 复制文本 → 桌面粘贴（现有路径），不进本轮。
