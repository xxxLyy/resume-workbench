# B 线安全收口 + E 清理包·实施计划（2026-11-01）

> **执行载体**：按设计文档 §3——动态工作流（`subagent_model=GLM-5.3-Flash`）承担 Flash 任务，主会话（GLM-5.3）承担批 1/2/3、批 6 正则与全部合同/审查/验收。步骤用 checkbox 跟踪。
> **上游文档**：设计 = `dev-docs/2026-11-01-bline-fix-round-design.md`；逐条证据/复现口径 = `dev-docs/2026-11-01-bline-inventory.md`（按 BL-P*-** 编号引用，执行时把对应条目原文附进任务卡）。
> **纪律**：全部继承设计 §4（冻结件零改动、真实数据零写删、先红后绿、断言靠内容变红、exit 钩子防孤儿、不杀进程、分动机提交、禁 reset/clean、不泄 key 与正文）。

**Goal:** 修复九路审查确认的 39 条缺陷 + 清掉 E 包 4 件登记债，全量四套件绿，真实数据零触碰。

**Architecture:** 7 批独立提交（批 1 安全 → 批 2 数据完整性 → 批 3 落账流 → 批 4 面板 UX → 批 5 评估链 → 批 6 护栏+运维 → 批 7 E 包）。每条先写会红的回归夹具再改实现；Flash 产出的每个 diff 经主会话审查后提交。

**Tech Stack:** Node 零框架单服务（server.mjs）+ 注入层四文件 + Playwright 渲染链；测试 = test.sh / test-structure.sh / test-render.sh / privacy-check.sh 四套件 + `test-fixtures/reliability/*.mjs` 自起隔离服务模式。

**夹具挂载规则**（handoff 坑 7）：浏览器类夹具挂 `test.sh` 文件末尾追加段；纯函数/HTTP 类挂 `test-structure.sh` 顶部。新夹具一律带 `process.on('exit')` 清理钩子（坑 5）。

---

## 任务 0：基线确认（主会话）

- [ ] `cd /Users/xxxly/resume && git log --oneline -1` → `5283c4e`；`git status --short` → 仅 4 份用户未跟踪 dev-docs
- [ ] `RESUME_TEST_STRICT=1 npm run test:all` → EXIT=0（记下断言总数，收口时对照）
- [ ] 记录真实数据目录 mtime 基线：`ls -lT docs docs-meta.json applications.json materials.json backups | tee /tmp/bline-mtime-baseline.txt`

## 任务 1：批 1 · 安全四件（主会话实施）

**统一前置**：每条先在 `test-fixtures/reliability/` 建夹具、跑红、再改 `server.mjs`（唯一改动文件；**不碰 template.html**）。

### 1.1 BL-P1-02≡BL-P7-01 /snapshot/view 无 CSP（high）
- 夹具 `test-snapview-csp.mjs`（HTTP 类，挂 test-structure.sh）：隔离根 + 合成文档含 `<script>` 的快照 → `GET /snapshot/view` 断言①响应头含 `Content-Security-Policy` 且 `script-src` 不含 `unsafe-inline`；②同请求 `X-Content-Type-Options: nosniff`。对照 `/edit` 的 CSP 写法（server.mjs:2336-2349）。
- 修法：`/snapshot/view`（server.mjs:3413-3422）返回前对快照 HTML 走与 `/edit` 同源的 CSP 策略头；快照只读预览不需要任何脚本 → CSP 定为 `default-src 'none'; style-src 'unsafe-inline'`（样式内联保留观感，脚本/连接全禁）。
- 验收：夹具红→绿；隔离实例浏览器打开快照页脚本不执行（console 无错误外的执行痕迹）。

### 1.2 BL-P7-02 预览页 ⌘S 保存通道（high）
- 夹具 `test-preview-save-channel.mjs`（浏览器类，挂 test.sh）：隔离实例打开快照预览页 → dispatch ⌘S → 断言 `POST /save` **未发出**（请求行为断言，不靠提示文字）。
- 修法（服务端，冻结件约束）：`/snapshot/view` 返回时中和保存通道——在返回 HTML 的 `<script>` 里注入一小段覆盖：重定义 `window.addEventListener('keydown', e => { if ((e.metaKey||e.ctrlKey)&&e.key==='s') e.stopImmediatePropagation(); }, true)`，并在 CSP（1.1）同时兜底 `connect-src 'none'`（双保险，注入层手法与 server.mjs 既有注入注释对一致）。实施时读 server.mjs:3413 现文定稿。
- 验收：夹具红→绿；预览页观感不变（样式保留）。

### 1.3 BL-P7-03 /edit CSP 缺 frame-src/object-src（high）
- 夹具 `test-edit-csp-frames.mjs`（HTTP 类，挂 test-structure.sh）：`GET /edit` 断言 CSP 含显式 `frame-src 'none'; object-src 'none'`。
- 修法：server.mjs:2338-2348 的 CSP 指令集补 `frame-src 'none'; object-src 'none'`（编辑页无任何合法 iframe 需求——若实测发现 PDF 预览 iframe 用同源，则改 `frame-src 'self'`，以夹具+浏览器点验为准，实施时核实）。
- 验收：夹具红→绿；`/edit` 真实浏览器点验 PDF 预览等功能不破。

### 1.4 BL-P1-01 净化器标签模型（high）
- 夹具 `test-sanitizer-svg.mjs`（浏览器类，挂 test.sh）+ 纯函数段（挂 test-structure.sh）：反例集 = `<svg><style><script>alert(1)</script></style></svg>`、`<noscript><script>…</noscript>`（脚本开启形态）、svg 内 `<title>`/`<textarea>` 含 `</script>` 字面量；断言 trustedRenderHtml 产物 **不含** 可执行 `<script` 与 `on*=`，且 Chromium setContent 后无 alert/无外发请求。
- 修法：render-safe.mjs:43 RAW_TEXT_TAGS 的判定改为**上下文感知**——进入 foreign content（svg/math）后 style/textarea/title 不再按 raw-text 处理（浏览器实际按普通元素解析其内容）；noscript 分脚本开/关两态（脚本开启时 noscript 内容按 raw-text、关闭时按普通——净化器按「脚本开启」从严处理）。实施时以夹具反例驱动，逐个形态定实现（状态机跟踪 foreign content 深度）。
- 验收：夹具红→绿；既有 `test-render-safe`/`test-render-boundary` 全绿（净化器无回归）。

- [ ] 批 1 提交：`fix(sec): /snapshot/view 补 CSP 并中和预览页保存通道；/edit CSP 补 frame-src/object-src` + `fix(sec): render-safe 标签模型对齐浏览器解析（svg foreign content / noscript）`（各自含夹具，分两个提交）

## 任务 2：批 2 · 数据完整性七件（主会话实施）

| 条目 | 夹具（新） | 修法合同 | 挂载 |
|---|---|---|---|
| BL-P1-03 备份无法恢复 | `test-backup-restore-shapes.mjs`（隔离服务） | `/restore`（server.mjs:4332-4396）遇未知形状条目：**跳过该条目并继续**，响应体逐条列出 `skipped`（名字+原因），不再整包 fail；`/backup`（:4259）打包保持整目录不动（备份宁多勿缺） | test-structure.sh |
| BL-P5-01 zone 引号不感知扫描 | `test-zone-quote-scan.mjs`（纯函数） | zone.mjs:38 开标签末端改为引号感知扫描（跳过 `"…"`/`'…'` 区间再找 `>`）；补带 `>` 属性值反例断言 normalizeZids 不改坏正文 | test-structure.sh |
| BL-P5-04 tx 吞 meta 损坏 | `test-tx-corrupt-meta.mjs`（纯函数） | tx.mjs:224-229 读旧 meta 失败时**中止该事务**（抛 CORRUPT 上抛，不写 tx 记录），不得把「损坏」记成「无条目」；启动恢复消费端不变 | test-structure.sh |
| BL-P5-05 双 data-zid | `test-zone-double-zid.mjs`（纯函数） | zone.mjs:11-12 属性识别放宽到「引号可有可无、等号两侧容空格」，归一化时**替换**旧值而非追加；:279 重复判定同步 | test-structure.sh |
| BL-P6-02 migrate staleMs（按复核修正） | `test-migrate-lock-heartbeat.mjs`（纯函数+临时根） | 真缺陷=注释失实+服务端 30min 判陈旧抢锁（复核节点 13130 修正口径：「启动恢复回滚用户保存」不成立，不修那半边）。修法：迁移持锁期间**周期刷新锁文件 startedAt**（如每 10min，tx.mjs 锁实现加 touch 接口），并把 migrate-meta.mjs:443-446 注释改为与实现一致；assert→atomicWrite 之间窄竞态登记为已知边界（handoff 记录） | test-structure.sh |
| BL-P6-03 materials 根值形状 | `test-migrate-materials-shape.mjs`（纯函数+临时根） | migrate-meta.mjs:395-412 补服务端同款「根值必须是数组」闸门：根值非数组 → 抛 CORRUPT 不覆盖（与 JSON.parse 失败同路） | test-structure.sh |
| BL-P6-04 migrate 裸 replace | `test-migrate-replace-escape.mjs`（纯函数） | migrate-editor.mjs:63-64 字符串替换改函数替换 `.replace(re, () => toolbar[0])`（`$&`/`` $` ``/`$'`/`$$` 不再被解释）；夹具用含 `$&` 的旧文档反例 | test-structure.sh |

- [ ] 批 2 提交：`fix(tx,zone,migrate,server): 数据完整性七件（restore 跳过未知形状/引号感知扫描/损坏中止/双 zid 归一/迁移锁心跳/根值闸门/函数化替换）`——或按动机拆 2-3 个提交，实施时定

## 任务 3：批 3 · 落账流六件（主会话实施，全部浏览器类挂 test.sh）

| 条目 | 夹具（新） | 修法合同 |
|---|---|---|
| BL-P2-01 撤回回退错位 | `test-job-withdraw-anchor.mjs` | applyChange 记录**锚点身份**（zid+occurrence 或节点引用），撤回按锚点回退，不再按「文本首个匹配」replace；断言：同文两处只回退正向改的那处、落账被拒不落盘（服务端校验拦截后的磁盘字节比对） |
| BL-P2-02 撤回失败无人察觉 | `test-job-withdraw-fail.mjs` | runInv（job-panel.js:687/721/772）返回 false → **阻断后续提交**并显式提示「页面未能恢复原样」，不再照走「页面保持原样」文案；断言：失败后自动保存不把候选写盘 |
| BL-P2-03 模糊匹配落错条目 | `test-job-fuzzy-target.mjs` | hide/reorder/add（:154-168 findEntry/sectionByTitle 调用点 :258-304）改用服务端已解析的 **zid** 定位；无 zid 的候选才回退标题匹配且回退时显式标记；断言：同名条目场景落点正确（复核节点 13174 口径） |
| BL-P2-04 批量接受整批 400 | `test-job-batch-accept.mjs` | 批量路径（:748）origText 在 **applyChange 之前**逐条采集（改前快照），保证服务端按磁盘文本校验可命中；断言：同段多条候选批量接受全部 200 |
| BL-P2-05 整段替换掏空行内标记 | `test-job-inline-marks.mjs` | needs-compare 确认门与同步撤回（:666-672/:687）改走 `__edReplaceText` 的 DOM 保标记路径（editor-shell.js:500-534），不再 `textContent` 整段回写；断言：`<b>瘦了</b>` 经撤回后仍是 `<b>瘦了</b>` |
| BL-P2-06 chips 重建丢输入 | `test-job-reject-chips.mjs` | renderRejectChips（:821-869）插入后登记「面板有 chips」状态，restorePanelInput（:1080-1088）对 chips 存在时的重建走**保留容器**路径（与 A9 同款采集-回填）；断言：输入原因后触发一次 render，输入值仍在 |

- [ ] 批 3 提交：`fix(job-panel): 落账流六件——锚点撤回/失败阻断/zid 落点/批量 origText/保标记回写/chips 回填`（含六夹具）
- [ ] 注意坑 3：改完检查既有 `test-job-ops.mjs`/`test-job-merge.mjs` 断言语义，凡「失败后 DOM 保留候选」的旧口径按新语义重写

## 任务 4：批 4 · 面板 UX 七件（Flash 实施，主会话逐 diff 审查；浏览器类挂 test.sh）

每条任务卡 = inventory 对应条目原文 + 下表合同。Flash 按「夹具红→实现→绿→自验」执行，diff 交主会话审查后由主会话提交。

| 条目 | 夹具（新） | 修法合同 |
|---|---|---|
| BL-P3-01 选区改写错位 | `test-ai-apply-occurrence.mjs` | ai-panel.js:483-490 应用时传选区上下文（occurrence 或 range 锚点）给 `__edReplaceText`，不再默认 chosen=0；多处命中且无法定位 → 拒绝并提示（与聊天路径口径一致） |
| BL-P3-02 api() 吞业务失败 | `test-zone-api-failure.mjs` | 注入层 `api()` 对 HTTP 非 2xx / `ok:false` **reject**（携带状态与信息）；**全部调用点**逐个补 `.catch` 显式提示（改动面大，grep 网先列清单进任务卡）；既有「吞错」的调用点补完后跑全量浏览器夹具防回归 |
| BL-P3-03 整表回写抹 locked | `test-zone-locked-keep.mjs` | zone-panel.js:621-632 bindOne 只回写目标条目（merge 语义：以服务端当前条目为底，仅覆盖 bind 字段），payload 保留 locked |
| BL-P3-04 skipped 明细丢弃 | `test-zone-skipped-shown.mjs` | 生成侧消费 `d.skipped`、应用侧遍历 `receipt.skipped`（zone-panel.js:326/:460-479），面板逐条显示「跳过：某段（锁定/改绑/事实冲突）」 |
| BL-P3-05 else-if 吃提示 | `test-ai-apply-error-toast.mjs` | ai-panel.js:487-488 失败分支改为**独立 if + 错误来源判定**，『原文未找到…未应用』提示可达 |
| BL-P3-06 render 清空候选 | `test-zone-preview-keep.mjs` | zone-panel.js:148 render 不再 `root.innerHTML=html` 整覆（:239-241 renderAi 保 `#zp-preview` 容器及其内容；按节点 diff 或保留区手法，与 A9 同思路） |
| BL-P3-07 降级提示被删 | `test-zone-degrade-keep.mjs` | 降级提示节点移出 AI 框（:186-196），或 renderAi 的 old.remove()（:197-200/:245）排除提示节点；`state.aiDegraded` 重绘后仍显示原因 |

- [ ] 批 4 提交：`fix(ai-panel,zone-panel): 面板 UX 七件——选区锚点/api reject/条目级回写/skipped 可见/错误提示可达/候选保留/降级提示保留`（含七夹具）

## 任务 5：批 5 · 评估链七件（Flash 实施，主会话逐 diff 审查）

| 条目 | 夹具（新） | 修法合同 | 挂载 |
|---|---|---|---|
| BL-P4-01 薪资矛盾组合（low，按复核收窄） | `test-eval-salary-fallback.mjs`（纯函数） | eval.mjs:111-116 补齐注释点名的另一半：`if (src==='JD 未提供' && t) return {text:'', source:'JD 未提供'}`——置于现有 `if (!t)` 之后、兜底 return 之前；不扩大（复核节点 13110：用户侧不可见，仅契约对齐） | test-structure.sh |
| BL-P4-02 引文最小长度 | `test-eval-quote-minlen.mjs`（纯函数） | eval.mjs:74 命中判定加长度下限，与 evidence.mjs:555-557 同款：`normSpace` 后 `<6` 码元不算命中 → covered 降 partial（走既有 :75-80 分支，无需新分支）；夹具断言 `的`/`负责` 不再算「已有证据」、`负责存储层改造` 仍算 | test-structure.sh |
| BL-P4-03 /ai/* 不捕获异常 | `test-ai-routes-error.mjs`（隔离服务，桩模型失败） | server.mjs 七处（:3763/:4017/:4035/:4090/:4105/:4124/+grep 补全）模型调用包 try-catch → 500 改为 `{ok:false, error:具体原因}` JSON（与既有错误体格式对齐）；夹具：桩返回网络错，断言响应体含可读原因 | test-structure.sh |
| BL-P4-04 unclaim 不校验归属 | `test-slots-unclaim-guard.mjs`（纯函数） | resource-slots.mjs:73-76 unclaim 补合同三条件（①本池签发 ②未释放 ③当前被占用），任一不满足 → 返回 false 不动状态；跨池/未占用凭证 unclaim 幂等无效 | test-structure.sh |
| BL-P4-05 JSON 前缀自然语言 | `test-eval-json-prefix.mjs`（纯函数） | eval.mjs:47-51 解析失败时二次尝试：截取首个 `{` 到最后一个 `}` 再 parse；仍败才 502；夹具：`好的，以下是报告：{...}` 正常解析 | test-structure.sh |
| BL-P4-06 withLease 合同互斥 | `test-slots-withlease.mjs`（纯函数） | 二选一（实施时看调用面定）：A) 删除 withLease（若零调用点）；B) 改语义为「透传已有凭证时不重复 claim，仅 fn 失败时释放自己签发的」。任务卡先跑 `grep -rn withLease` 把调用面列进合同 | test-structure.sh |
| BL-P4-07 gen-result 契约不一致 | `test-structure.sh` 追加静态断言 | gen-result.mjs 超时分支（:26-28）行为保留（写 status='error' 是对的），把头部契约注释（:6）改为与实现一致：「超时 → 写入 error 状态并推进 next」（对照头部第 4 条原文改写）；test-structure.sh 加一条 grep 断言钉住新注释 | test-structure.sh |

- [ ] 批 5 提交：`fix(eval,slots,server): 评估链七件——薪资回落/引文下限/ai 异常体/unclaim 守卫/JSON 前缀/withLease 契约/gen-result 注释`（含夹具）

## 任务 6：批 6 · 护栏误报 + 渲染运维七件（混合：正则二件主会话，其余 Flash）

| 条目 | 实施者 | 夹具（新） | 修法合同 |
|---|---|---|---|
| BL-P5-02 数词等价误报 | 主会话 | `test-fact-num-equivalence.mjs`（纯函数） | job.mjs:87-91 NUM_RE 分支③放宽：「阿拉伯→中文数词」的等价形态（含「三」「五」等无单位数词）在 lostNums 判定（:180-181）按**等价**处理不报 conflict；以夹具反例集（`3年`→`三年`、`5人`→`五人`、含百千万亿的原例不回归）驱动 |
| BL-P5-03 日期空格误报 | 主会话 | `test-fact-date-space.mjs`（纯函数） | job.mjs:155 dateParts 正则补 `\s*` 前缀与 DATE_TOKEN_RE（:94）对齐；夹具：`2024.1.1` vs `2024. 1. 1` 两形态等价不报 |
| BL-P1-04 10MB/4MB 不一致 | Flash | `test-render-size-limit.mjs`（纯函数+隔离服务） | 口径统一（实施时读 server.mjs:996/:889 现文定）：保存 10MB 与渲染 4MB 的不一致在**保存入口前置校验**——超 4MB 的保存返回明确错误「文档超过渲染上限 4MB，无法导出 PDF」？**否**——保存必须继续可用。正确修法：renderDoc 调 trustedRenderHtml 传入与保存一致的 `maxHtmlBytes=10MB`，渲染失败文案带尺寸原因。任务卡先实测 4MB 拒绝点再定稿 |
| BL-P1-05 Chromium 探测竞态 | Flash | `test-chromium-wait-race.mjs`（纯函数+猴补） | chromium.mjs:106-116 等待分支顺序改为「先看锁文件是否仍在，再读缓存，仍无才继续等」，消除「缓存已写好但等待方先读缓存失败即抛」的窗口；夹具猴补时序模拟 |
| BL-P6-01 logrotate（按复核收窄） | Flash | `test-logrotate-fail-path.mjs`（纯函数+临时文件） | logrotate.mjs:16-18：写 `.1` 失败（空 catch 处）→ `console.error('日志轮转失败(备份未写入，跳过截断): '+e.message)` 并 **return 不截断**（S0 设计口径「失败只 console.error 不影响服务」）；读后写前窗口丢失属 copytruncate 固有代价 → 注释登记不修。夹具：`.1` 为目录/不可写 → 主文件 size 不变 |
| BL-P6-05 importer 占位符（按复核修正） | Flash | `test-import-docid-bytes.mjs`（纯函数+临时根） | 复核节点 13194 修正口径：真缺陷是**参数错位**——importer.mjs:67 调 buildRawDoc 实参错位（docId 落进 degradeReason 槽），两条路径都没兑现 :52-53「落盘字节带 docId」契约。修法：修实参顺序；LLM 路径 atomicWrite 前 `{{DOC_ID}}` 函数化替换为真实 id；夹具断言两条路径落盘行均为 `var DOC_ID = '<真实id>';` 且 bodyHash 一致 |
| BL-P6-06 导入 0 字节占位可见 | Flash | `test-import-placeholder-file.mjs`（隔离服务） | importer.mjs:21-35 结构化完成后再创建 docs/<id>.html（或占位期写入 `.tmp` 后缀，完成时 rename）；SIGKILL 模拟（夹具造残留 `.tmp` → 断言列表不显示、/restore 或下次导入可清理） |

- [ ] 批 6 提交：`fix(job): 数词/日期等价改写不再误判 conflict` + `fix(render,chromium,logrotate,importer): 运维五件——尺寸口径/探测竞态/轮转失败不截断/docId 字节契约/占位不可见`（含夹具）

## 任务 7：批 7 · E 包四件（Flash 实施，主会话审查）

- [ ] **E1 排版不变量进断言**：test-structure.sh 追加静态断言——标题三档（h1/h2/h3 字号档位登记值）、chip/badge 同档（min-height 差 ≤1px 的登记值）。落点与登记值从 DESIGN.md §2/§3 取，断言写法抄 UI-2（test-structure.sh:4060-4067 逐字钉值模式）
- [ ] **E2 DESIGN.md 补登记**：h2 档位 21px→16px（全站唯一 h2 在损坏页）、chip min-height 26px（过 2px 线的登记取舍）——补进 DESIGN.md 对应小节，措辞与既有「定案口径」格式一致
- [ ] **E3 B8 电话可提取**：导出检查卡补第三项——pdftotext 回读断言电话可提取（姓名/邮箱已有）。落点：server.mjs 导出检查渲染段（grep「可提取」定位既有两项），校验函数与姓名/邮箱同款；登记 deferred 项从报告移除
- [ ] **E4 PRODUCT.md**：按 impeccable init 口径建仓库根 PRODUCT.md——产品一句话、双区世界摘要（从 DESIGN.md §1-2 提炼）、核心流程（母版→岗位草稿→评估→导出）、红线（离线、零依赖、单人本地）。不写用户数据
- [ ] 批 7 提交：`test,docs: E 包四件——排版不变量断言/DESIGN.md 补登记/B8 电话可提取/PRODUCT.md`

## 任务 8：收口（主会话）

- [ ] `RESUME_TEST_STRICT=1 npm run test:all` → EXIT=0，断言数 ≥ 基线+新增
- [ ] 重启 7766（kill PID 16033，KeepAlive 拉起）→ 真实浏览器只读点验：首页 / /edit / 快照预览 / /evals / /settings 0 报错；快照页脚本不执行、⌘S 无保存请求
- [ ] 真实数据 mtime 与 /tmp/bline-mtime-baseline.txt 逐项比对全部未变
- [ ] inventory 文件逐条标记处置（fixed / narrowed-fixed / registered-deferred）
- [ ] handoff.md 追加本轮章节：逐项结果、回归入口、起止提交、剩余事项（窄竞态登记、游离进程待确认）、进程归属
- [ ] 收口提交：`docs: B 线修复轮收口记录`

## 控制点（贯穿）

1. Flash 每完成一条：夹具红→绿证据 + diff 交主会话；主会话审查通过才进批次提交。
2. Flash 同一条两次尝试未绿 → 上交主会话，不硬磨。
3. 每批完成即跑 `bash test-structure.sh` 全绿再提交；浏览器夹具批至少跑一次。
4. 行号漂移：本计划行号来自 bfb033d 基线，实施时以 grep 语义定位为准，不盲改。

---

## 自审记录

- 覆盖对账：39 条 BL 逐条出现在任务 1-6（5+7+6+7+7+7=39）+ E4 件 = 43 项，与设计 §2 一致。
- 复核修正已并入：P4-01（只修回落半边）、P6-01（不修 copytruncate 固有代价）、P6-02（不修「启动恢复回滚」半边、加心跳）、P6-05（按参数错位口径重写）、P4-02（6 码元下限对齐 evidence.mjs 先例）。
- 占位符扫描：无 TBD/TODO；BL-P1-04 与 BL-P4-06 标注「实施时定稿」的二选一，均已给出判定程序（先实测/grep 调用面）而非空指。
- 类型/命名一致性：夹具名全局唯一；批内提交信息与设计 §2 批次命名一致。
