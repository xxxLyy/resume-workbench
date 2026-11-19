# 社招职位源 + 匹配 + 推荐设计（UPCV A2 · #10/#11）

> 2026-11-19。总控：`2026-11-19-upcv-port-plan.md`。契约源：efc `docs/upcv-match-implementation.md`（matchScore 0-100 / weak|medium|strong|excellent / headline≤80 / 三数组各≤3 条）+ efc `platform/upcv.ts`（上游 fetch 纪律逐字可抄）。
> 定性（侦察结论）：本仓 `upcv-api.mjs` 是零网络的契约本地投影，**不能当上游代理用**；职位源照 efc 纪律另写真 fetch 层。eval.mjs 的 JD 评估是岗位草稿链路，保留不动；match 是独立新链路。

## 1. 上游 fetch 层 `upcv-jobs.mjs`（新文件，纯函数 + 出网）

```
const UPCV_BASE = process.env.RESUME_UPCV_BASE || 'https://www.upcv.tech/api';
const UPSTREAM_TIMEOUT_MS = 20000;               // 同 efc
const SEARCH_PARAMS 白名单 = jobType|search|cityIds|functionIds|jobIds|page|limit（同 efc UPCV_SEARCH_PARAMS）
export async function fetchUpcvJobs(params)     // 白名单过滤 → fetch → res.ok 校验 → 中文错误「上游不可达/上游 <status>」
export async function fetchUpcvJob(jobId)       // /campus/jobs/:id
export async function fetchUpcvDictionaries()   // cities/functions/industry 三字典（页面筛选用）
```

- SSRF 面为零（固定 base + env 覆盖，不出用户输入 URL）；上游失败如实 502 中文，不缓存上游。
- gatePool：本模块端点不调 LLM 的（/jobs/search、字典）零改动。

## 2. 端点

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/jobs/search?jobType=SOCIAL&page&limit&search&cityIds…` | 透传白名单 → 上游 → `{ok:true, items, page, hasMore}`（limit 封顶 20） |
| GET | `/jobs/dictionaries` | 三字典透传缓存进程内 10 分钟 |
| POST | `/match/job` | `{docId, jobId? \| jdText?, refresh?}` → UPCV 形状 `{matchScore 0-100, matchLevel, headline, strengths≤3, gaps≤3, resumeSuggestions≤3}` |
| POST | `/match/recommend` | `{jobType, limit≤12, refresh?}` → 偏好映射参数 → feed 首页逐岗匹配 → 按 matchScore 降序 |
| POST | `/extension/match-score` | `{docId, jobId}` → 轻量 `{matchScore, matchLevel}`（A4 用，同 match/job 核心） |

- **匹配核心 `match.mjs`**：docId → docToText 母版/草稿文本 + (jobId → fetchUpcvJob 裁剪 2000 字 | jdText 截 64KB 同 JD_MAX_CHARS) → `buildMatchPrompt`（只输出 JSON；score 整数 0-100；四枚举；**strengths 必须附 evidence 逐字子串**，子串验证不过 → 该条降级剔除——移植 eval.mjs 护栏纪律）→ `chat({lease})` → `parseMatch` 兜底 + score 越界整份作废。
- **缓存 `match-cache.json`**（对象，键 = `docId + '|' + (jobId || 'fp:' + jdFp)`）：命中且无 refresh 直返（零成本）；jdFp 复用 `vendors/jd-fingerprint` 现有实现。四连登记。
- gatePool：`/match/` 与 `/jobs/` 中调 LLM 的前缀进 AI 池（/match/job、/match/recommend、/extension/match-score）；feed/字典不进。
- 推荐参数映射：preference.json 存在 → salary→search 关键词、cityIds/industryIds/functionIds 透传、jobTypes→jobType=SOCIAL（校招位忽略）；无偏好 → 裸 SOCIAL feed（A1 未落地也可用）。

## 3. 页面 `/jobs` + topnav 第 9 项

- `page('社招职位', jobsPageInner(), 'apps')`；面板 `jobs-panel.js`（静态路由 + defer）。
- topnav `nav('jobs','/jobs','职位','briefcase')`（icon 查白名单，不在则白名单内改选；**同步导航断言**）。
- 页内两 Tab：**搜索**（关键词 + 城市/职能下拉（字典端点）+ 分页 → 职位卡：title/company/salary/city + 「AI 匹配度」按钮 → 结果卡四色徽标 weak 灰/medium 黄/strong 蓝/excellent 绿 + headline + 双列 + 建议列表 + 「转入适配」（复用既有 /job/create 管线建岗位草稿——同仓闭环，勿另造草稿路径）+ 「加入待投」→ 写 applications {jobId, company, role, link, status:'to_apply'}（幂等 by jobId，走 server.mjs 既有 /app/add 口径内新增 jobId 字段透传））。
- **推荐 Tab**：无偏好提示去 /talent；有则 POST recommend → 岗位卡带分数徽标排序 + 「查看匹配详情」复用搜索结果卡。
- token 纪律：全部 var(--*)；分数带「AI 参考」字样。

## 4. 测试（test-jobs-match.mjs 六步样板）

1. 隔离根 + 假 LLM + seed 母版夹具；
2. 上游层 stub：进程内 monkey-patch 或 RESUME_UPCV_BASE 指向本地假上游（test.sh 假渲染器同思路）→ /jobs/search 透传与白名单丢弃断言；
3. 假 LLM 回合法匹配 JSON → /match/job 200 逐字段；同参二次调用命中缓存（假 LLM 计数 =1 断言）；refresh 重算；
4. strengths 编造（evidence 不在简历原文）→ 剔除断言；
5. /match/recommend 偏好映射断言；
6. 源码断言：gatePool 前缀行、match-cache 账本登记、nav 项、无新增字面色。

## 5. 验收

隔离实例全端点 + 假上游 + kickstart + 浏览器实点（搜索→匹配→四色徽标→加入待投→/applications 出现 to_apply 行；推荐 Tab 出分数排序）。

## 6. 边界（如实）

- 上游是 UPCV 公网接口，改版/限流属外部现实，失败如实中文报错（本仓不做重试：POST 语义 + efc 同款单次）。
- 「转入适配」依赖既有岗位草稿管线（/job/create 冻结语义不动，只做入口）。
- 字典缓存 10 分钟进程内，不落盘。
