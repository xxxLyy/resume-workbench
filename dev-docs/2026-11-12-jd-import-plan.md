# JD 网址导入（双轨）实施计划 — 2026-11-12

> Spec：`dev-docs/2026-11-12-jd-import-bookmarklet-design.md`（91a2294）。轨 A 书签已 POC 验证（/tmp/jd-poc：表单 POST→localhost→提取 Boss `_jobInfo` 成功）。执行方式：Subagent-Driven，每任务实现→规格复核→返工→质量复核，main 分支直推。
>
> **红线**：零 npm 依赖；template.html/render.mjs/themes 零改动；真实数据文件与 7766 常驻进程只在 T5 验收时动；断言适配走 R3① 先例（意图不变同提交）；`boss-session/` 进 .gitignore 且永不入仓。

### Task 1: DESIGN.md 登记 + 路由/gitignore 预埋

- DESIGN.md §10.20 登记：/import/page（零写盘预览）、extractJd 三层级、/job/new POST 预填、Boss 会话（持久 profile+扫码登录+headless 抓取）、书签 javascript: 交付形态、CORS/PNA 口径。
- `ROUTES_FROZEN`（test-structure.sh）登记新路由：`POST /import/page`、`OPTIONS /import/page`、`POST /job/new`（预填）、`POST /boss/session/login`、`POST /boss/session/logout`、`GET /boss/session/status`。
- `.gitignore` 加 `boss-session/`。
- 同提交：断言登记。预期一处提交即可，无行为变化。

### Task 2: extractJd + /import/page + 预览页（共享轨）

- `extractJd(html, url)`（server.mjs 模块级，~fetchPageText 旁）：
  - 站点表常量 `JD_SITE_RULES`：`zhipin.com` → ① `var _jobInfo = {...}` 正则提取 `job_name/job_salary/company`；② DOM 兜底 `.company-name`/`h1`/`.job-sec-text`（多候选取首个 ≥50 字符）；`liepin/lagou/51job/zhaopin` 各备 2-3 条常见容器选择器（未实测，注释标注）。
  - JSON-LD `JobPosting` 层：解析 `application/ld+json`（含数组/@graph 形态），取 description/title/hiringOrganization.name。
  - body 兜底：复用 fetchPageText 同款剥离，额度 8000 字符（与远程抓取 4000 区分）。
  - 返回 `{company, role, jd, via}`；所有输出只进剥离文本，不回显原 HTML。
- `POST /import/page`：urlencoded 解析（html≤8MB、url、title）→ extractJd → `page('提取结果', ...)` 预览：来源/标题/通道/公司/岗位/JD 长度/全文预览 + 隐藏字段表单（jd/company/role/jdLink=来源url/from=母版 select 同 jobNewPage infos 口径）+「带去定制」POST /job/new；JD<50 字符时明示「没提到 JD」+回退指引。全部 escHtml/escAttr。
- `OPTIONS /import/page` → 204 + CORS 四头（Allow-Origin:*, Methods:POST,OPTIONS, Headers:Content-Type, Allow-Private-Network:true）。POST 响应同样带 ACAO。
- 测试：fixture 存 Boss 修剪页（`test-fixtures/jd-pages/zhipin-job.html`，~30KB，剔除 securityId/user_id）+ `test-fixtures/jd-pages/jsonld-job.html` + `plain.html`；新夹具 `test-import-page.mjs`：三层提取断言、POST 预览字段、CORS 头、超限截断、XSS（html 注入 <img onerror> 不出现）。

### Task 3: /job/new POST 预填 + 书签 + 失败引导（轨 A 收口）

- `POST /job/new`：body {jd,company,role,jdLink,from?} → 调 jobNewPage() 变体渲染：jobJd 预填（value→textarea 内容 escHtml）、jobCompany/jobRole value 预填（escAttr）、jobLink 预填且 jdLinkRow `display:block`、jobFrom 预选 `from`。GET 路径零变化。
- 书签：jobNewPage 链接区新增「Boss/猎聘等登录站抓不到时」提示行 + `<a href="javascript:…">抓取此页 → 工作台</a>`——javascript 代码由服务端模板生成，action URL 用 `http://localhost:${PORT}/import/page`（PORT=实际监听端口变量）。href 属性整体 escAttr。
- 失败引导：submit/eval 的 jd-text fetch 失败回调里，jobMsg 追加书签提示 DOM（既有 nonce 脚本内，textContent 写文案 + 预置锚点元素复用，不 innerHTML 拼接）。
- 测试：test-job-new-page.mjs 断言书签 href 前缀 `javascript:`+含 `/import/page`+含实际端口；POST /job/new 预填四值在位；预填 jd>50 时 jdLinkRow 展开；失败引导文案断言（源级）。

### Task 4: Boss 会话（轨 B）

- `boss-session/`（gitignore）：`userDataDir` 持久 profile + `state.json` {loggedAt}。
- `POST /boss/session/login`：已登录短路返回；`chromium.launchPersistentContext(dir,{headless:false, executablePath: chromium-1243 全量（非 headless_shell——需要窗口）})` → goto zhipin 登录页 → 轮询 `context.cookies('https://www.zhipin.com')` 含 `__zp_stoken__`（或等价登录 cookie，实现时实测确认键名，断言写宽为「任一 zhipin 登录标识 cookie」）→ 成功写 state.json 关浏览器；300s 超时关并回报。chromium-1243 路径解析复用 PDF 导出的既有 chromium 定位逻辑（headless_shell→同版本 chromium 目录）。
- 抓取：`fetchBossPage(url)`——launchPersistentContext(dir,{headless:true, executablePath: headless-shell})+`addInitScript`（visibilityState/hidden 覆盖）→ goto → waitForFunction `_jobInfo` 8s 超时 → `page.content()` 给 extractJd。判定失效：final URL 含 `security|web/user` 或 `_jobInfo` 缺席 → throw SESSION_DEAD。串行锁（模块级 promise 队列，并发二请求排队）。
- /job/create 接入：jdLink 命中 zhipin.com 且会话存在时，静态 fetch 失败 **或** 直接走会话抓（裁决：直接走——静态必败省一跳）；抓到 jd 后走既有回填查重。无会话→维持现状「读取失败可改回贴文本」+ 会话提示。
- `GET /boss/session/status`→{ok,logged,loggedAt}；`POST /boss/session/logout`→删 boss-session/ 目录（fs.rm recursive，仅此目录）。
- /job/new UI：表单下方「Boss 会话」卡：status 轮询渲染状态点（绿=已登录/灰=未登录/橙=失效）+登录/重登/清除按钮（data-action 委托注册）。
- 测试：路由存在性、gitignore 断言、登录短路、status JSON 形、logout 清理、SESSION_DEAD 分支（mock page）；**不测试真登录**——人工点验项登记 T5。

### Task 5: 验收 + handoff + 对比登记

- `RESUME_TEST_STRICT=1 npm run test:all` EXIT=0。
- 人工点验（子代理代做 + 用户确认）：① 轨 A 书签真实 Boss 页再跑一遍正式实现；② 轨 B 真扫码登录→贴 zhipin 链接→会话抓取成功/失败如实记录（这是唯一需要真人扫码的一步）。
- handoff.md 登记双轨实现、验证结果、**轨 A vs 轨 B 对比表**（操作步数/成功率/维护面），未做项（其余站点选择器实测、headed 兜底、CDP 主 Chrome）。
- kill 7766 让 launchd 拉新码；commit `docs(handoff):`。

## Self-Review

- 轨 B 唯一真人依赖是扫码（T5 人工点验）；headless 抓取的 visibility 对抗有社区先例（boss-zhipin-scraper issue #18/PR#20）。
- /import/page 与 fetchPageText 是两条路径：前者吃用户浏览器递来的已渲染 HTML（无 SSRF 面），后者服务端外联（既有 SSRF 防线不动）。
- extractJd 的正则 DOM 解析与项目既有风格一致（fetchPageText/restructure 均正则级）；未来若精度不足再议解析器，不预判加依赖。
