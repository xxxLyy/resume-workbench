# upcv-api 路由规范 —— UPCV 契约端点（RR v4 schema 交换层）

> 对应契约：`upcv-features-implementation.md` §3（简历 CRUD，`/api/resume` 系列）+ §1（`/api/application-records`）
> + §2（`/api/resume/parse`，本期文本体先行）+ §4（`/api/showcases` 模板橱窗投影）。
> 落地路径：`dev-docs/2026-11-18-reactive-resume-adoption.md` §3「C 先行 + B-lite」——HTML 仍是唯一真源，
> RR resumeData 是导入导出交换格式（不写 sidecar，每次读投影现算）。
> 新文件：`rr-schema.mjs`（v4 形状+校验）、`rr-export.mjs`（doc→resumeData）、`rr-import.mjs`（resumeData→doc HTML）、
> `upcv-api.mjs`（端点实现）。server.mjs 只加 import + 一个注册块 + gatePool/WRITE_ON_GET 两处判断（可选）。

## 1. 端点表

| 端点 | 方法 | 请求体 | 响应（包壳 `{code:0,data}`） | 说明 |
|---|---|---|---|---|
| `/api/resume` | GET | — | `{code:0,data:[{id,title,updatedAt,theme,kind}]}` | 列表投影（data 直接是数组，空账号 `[]`），updatedAt 降序 |
| `/api/resume` | POST | resumeData（或 `{data:{…}}`/`{resumeData:{…}}` 包裹） | `{code:0,data:{id}}` | resumeData→HTML 建文档（classic 主题登记 + kind=master） |
| `/api/resume/:id` | GET | — | `{code:0,data:resumeData}` | 每次现算投影；`_meta:{schemaVersion:'4',source:'html-derived',docId,exportedAt,theme}` |
| `/api/resume/:id` | PUT | resumeData（同 POST 可包裹） | `{code:0,data:{id,updatedAt}}` | resumeData→HTML 落盘（走 rr-import + /save 同款原语） |
| `/api/resume/:id` | DELETE | — | `{code:0,data:{id}}` | 与 `/delete` 同口径（正文+PDF+渲染旁车+meta 条目；快照保留） |
| `/api/application-records` | GET | `?limit=&page=&status=a,b&summary` | `{code:0,data:{items,page,limit,hasMore,summary?}}` | 六态看板投影；items `[{id,company,role,status,dueDate,updatedAt}]` |
| `/api/resume/parse` | POST | `{html?}` 或 `{text?}`（同给 html 优先） | `{code:0,data:resumeData}` | 只读解析投影：html 直投 `docToResumeData`；text 拼最小 doc 走同一管线。不落盘、不写 meta |
| `/api/showcases` | GET | `?limit=`（1..50，缺省全量） | `{code:0,data:[showcase…]}` | 模板橱窗投影（data 直接是数组）；条目 `{id,slug,type:'RESUME',title,description,category:'RESUME',preview:{themeId,accentHex},isFeatured,downloadCount,updatedAt}` |

### 错误包壳（中文 message，code=http 状态码）

| 场景 | status | body |
|---|---|---|
| 非法 docId / 请求体非对象 / 形状校验不过 | 400 | `{code:400,message}` |
| parse 输入：`html`/`text` 缺失、类型非字符串、内容为空或无可解析文本 | 400 | `{code:400,message}` |
| 文档不存在 | 404 | `{code:404,message:'文档不存在'}` |
| 文档锁竞争（LockHeld） | 409 | `{code:409,message:'文档正在被另一保存/回滚处理…'}` |
| applications.json 损坏/形状错 | 500 | `{code:500,message:'applications.json …已拒绝读取'}` |
| 其它未捕获 | 500 | `{code:500,message:'服务器内部错误：…'}` |

### summary 形状（`?summary` 存在时附带）

```json
{"toApplyCount":0,"preparingCount":0,"appliedCount":0,"repliedCount":0,
 "interviewingCount":0,"offerCount":0,"closedCount":0,"dueTodayCount":0}
```

UPCV 实测样本无 `repliedCount/closedCount`（§1），此处为「每态计数」补齐——超集字段，兼容端忽略即可。
`status` 过滤参数：`?status=to_apply,applied`（逗号分隔、非法值忽略）。`dueDate` 口径 `YYYY-MM-DD`，`dueTodayCount` 按本地今日比对。

### parse 与 showcases 口径说明

**`POST /api/resume/parse`**：UPCV 侧是 multipart 文件上传（AI_PARSE_RESUME），本期不接真文件，
先接 `{html}`（整页文档或片段皆可）/ `{text}`（纯文本简历）。解析管线与 `GET /api/resume/:id`
完全同源：`html` 直投 `docToResumeData`；`text` 先经 `textToDoc` 拼最小 doc（首行→`<h1>`、
首个标题行之前余行→`.contact`、每个标题行开 `<section class="section">`、正文行一律 `<p>`）
再投同一函数。标题行判定 = 去首尾装饰符后与别名表等值（`PARSE_TITLE_SET`，镜像
`rr-export.mjs` 的 TITLE_ALIASES——那边未导出，两处同尺维护，漂移风险见 §4）。产出过
`validateResumeData` 自检。**纯读：不查 root、不落盘、不写 meta、不计费**。

**`GET /api/showcases`**：源清单 = `templates-page.mjs` `THEMES`（与「模板库」页同一份）×
`listThemes()` 可用性过滤。字段口径：

| showcase 字段 | 取值来源 |
|---|---|
| `id` | 橱窗位次顺序号 1..N（UPCV 为数字 id，本仓无持久 id 源） |
| `slug` | 本仓主题 id（`classic`/`compact`/`dual`/`magazine`） |
| `preview.themeId` | RR v4 模板名（`THEME_TO_RR` 映射，取舍见 upcv-api.mjs 注释：classic→rhyhorn、compact→kakuna、dual→glalie、magazine→lapras） |
| `preview.accentHex` | 主题 css 真实强调色（classic/compact 黑白灰版式取墨色） |
| `isFeatured` | 仅 classic（运营旗舰位） |
| `downloadCount` | **恒 0——本仓无下载/曝光埋点，语义是「未计量」而非「零下载」** |
| `updatedAt` | `themes/resume-<id>.css` 文件 mtime（唯一时间源） |

## 2. server.mjs 需要的改动（3 处，全部新增行）

### 2.1 import（文件头 import 区，ai-helper.mjs 行之后）

```js
import { dispatchUpcv, matchUpcv } from './upcv-api.mjs';   // UPCV 契约端点（规范 upcv-api.routes.md）
```

### 2.2 路由注册块（建议加在 `/api/extract` 路由之后，约 4830 行）

```js
// ===== UPCV 契约端点（规范 upcv-api.routes.md；编排 upcv-api.mjs）=====
// 只匹配 /api/resume、/api/resume/<id>、/api/resume/parse、/api/application-records、/api/showcases；
// 未命中 fallthrough 到既有 404。路径表唯一源 = matchUpcv（server.mjs:4832 行内注释仍列旧子集，
// 仅注释滞后，分发不受影响——本任务约束不改 server.mjs）。
{
  const hit = matchUpcv(req.method, url.pathname);
  if (hit) {
    let upcvBody = null;
    if (req.method === 'PUT' || req.method === 'POST') {
      try { upcvBody = await readBodyAuto(req); }
      catch { return sendJson(400, { code: 400, message: '请求体解析失败' }); }
    }
    const r = dispatchUpcv({ method: req.method, pathname: url.pathname, root, body: upcvBody, query: url.searchParams });
    if (r) return sendJson(r.status, r.body);
  }
}
```

### 2.3 WRITE_ON_GET（可选，不推荐加）

本层全部 GET 是纯读（现算投影零落盘），**不进** `WRITE_ON_GET`——无需改动。

## 3. 防线适配说明（mutating / CSRF / 迁移锁 / gatePool）

### mutating（server.mjs:4767）

`POST /api/resume`、`PUT /api/resume/:id`、`DELETE /api/resume/:id`、`POST /api/resume/parse` 天然命中
`req.method !== 'GET' && !== 'HEAD'` → 自动进 mutating 语义：`.migrate.lock` 持锁期间 503（无需登记）。
注意 `POST /api/resume/parse` 语义上是纯读投影，只是传输层走了 POST 带体——进 mutating 是无害超集。

### CSRF（server.mjs:4775）

浏览器发起的写请求带 `Origin` → host 必须与 `Host` 头一致。本组端点走同一防线，无豁免需求：
- UPCV 侧若由本仓页面 fetch → 同源自带 Origin 一致，放行。
- curl/脚本不带 Origin → 非浏览器客户端口径放行（与全站写请求同）。

### Host 白名单（server.mjs:4749）

全部端点共享 `^(127.0.0.1|localhost|\[::1\])(:\d+)?$` 判定，无需适配。

### gatePool（server.mjs:746）

**不进池**：本组端点不调 LLM、不拉渲染（投影是纯函数 + 文件读写）。gatePool 判定只认
`/pdf|/export|/snapshot/pdf`（render 池）与 `POST /ai/*|/ai-helper/*|/agent/chat|/eval/create|/restructure|/onboarding/star-suggest`（AI 池）——
`/api/resume`、`/api/resume/parse`、`/api/application-records`、`/api/showcases` 均不命中，零改动。

### 文档锁与原子写

- `PUT`：rr-import 产 HTML → `normalizeZids` → `normalizeToCurrent` → `withDocLock`（LockHeld→409）→
  `atomicWrite`（0600）→ `updateMeta` patch（`typo=css.value || norm.typo`、`rev++`、reviewed→draft 降级、`zoneSync`）。
  **与 /save 的差异（已知偏差）**：不打历史快照、不写 .tx 事务记录、不查 baseMtime——UPCV 契约无这些参数，
  恢复靠既有快照/备份体系，如需对齐可把注册块里的 dispatch 换成 `saveJsonProtocol` 同款管线（见 §4-3）。
- `POST`：slug 冲突回避（`doc`/`doc-N` + `.tmp` 双查，`/new`+importer 同口径）→ `atomicWrite` →
  `updateMeta` 登记 `themeRegistration('classic') + kind:'master' + flow:'draft' + archivedAt:null + typo=css.value`。
- `DELETE`：与 `/delete` 同口径（正文+PDF+env.json+`updateMetaAll` 删条目）；沿用「至少保留一份文档」护栏。

## 4. 待接点（本期未做，已按优先级标注）

1. **ROUTES_FROZEN 登记**：`test-structure.sh`（约 2212 行）冻结 `url.pathname` 字面量集合。
   本组注册块用了 `matchUpcv()` 函数分发，路径字面量（现 4 条：`/api/resume`、`/api/resume/parse`、
   `/api/application-records`、`/api/showcases`）都在 matchUpcv 内部，不在 handler 的 `url.pathname ===` 表。
   若走 §2.2 注册块（推荐），handler 无新字面量 → ROUTES_FROZEN 零改动；
   若改用逐条 `url.pathname ===` 写法，需登记 8 条字面量（登记非放宽；本任务按约束不改 test*.sh）。
2. **sidecar（B-lite）**：现按「HTML 唯一真源、读现算」实现，零 `<id>.rr.json` 落盘。
   若将来要缓存投影，在 `/save` 管线挂 docToResumeData 增量重算即可，本层端点契约不变。
3. **PUT 与 /save 全管线对齐**：如需快照+事务记录+冲突检查，注册块内改为构造
   `{requestId, baseRev, html: resumeDataToDoc(data,id), ops:[]}` 走 `saveJsonProtocol`（内部函数，需其签名稳定）。
4. **`POST /api/resume` 的 id 语义**：UPCV 用服务端分配 id，本仓用 slug 冲突回避；`_meta.docId` 回写新 id。
5. **AI 四件套/模板库**：`smart-check` 等端点已由 ai-helper.mjs 按 `/ai-helper/*` 命名落地（见 ai-helper.routes.md）；
   如需 `/api/resume/smart-check` 字面别名，在此层加一个转发分支即可。
6. ~~**`/api/resume-creation/snapshots/latest`**：UPCV 契约返回 `{snapshot:null}` 即可，本层未实现（低频端点）~~
   ✅ A3 已落（2026-11-19，规范 dev-docs/2026-11-19-upcv-port-snapshot-status-design.md §1）：`/api/resume-creation/snapshots` 四端点
   （GET `latest?schemaVersion=2` / POST UPSERT / PATCH `:id/complete` / DELETE `:id`），编排 `draft.mjs`（账本 resume-draft.json、
   tx.mjs updateJsonLedger），`{code,data}` 包壳同全层；恢复侧白名单（ALLOWED/条目形状/对象账本拷贝）与备份清单已同步扩。
7. **parse 真文件上传**：UPCV 是 multipart 上传（PDF/DOCX），本期只接 `{html|text}` 文本体；
   要接文件需在注册块前加 multipart 解析（readBodyAuto 只认 JSON/表单）+ 文档转 HTML 前置，管线仍归 `docToResumeData`。
8. **`PARSE_TITLE_SET` 漂移**：text→doc 的标题别名表是 rr-export `TITLE_ALIASES` 的同尺副本（那边未导出）；
   任一侧新增标题别名需另一侧同步，否则 text 输入的该标题会退化为正文行（不报错、只降级）。
9. **showcases 计量字段**：`downloadCount` 恒 0 是「未计量」占位；若将来加使用埋点（如「使用此模板」表单
   落库计数，见 templates.routes.md §3），在此直读同一账本即可，契约不变。

## 5. 数据结构说明（投影 ↔ 存储）

| 层 | 形状 | 说明 |
|---|---|---|
| 磁盘 `docs/<id>.html` | 整页 HTML（唯一真源） | `sectionsOf`+`deriveResumeFields` 派生，绝不改存 |
| `GET /api/resume/:id` | v4 resumeData | 现算；`_meta.source='html-derived'` |
| `PUT /api/resume/:id` | v4 resumeData → HTML | rr-import 装配 + /save 原语落盘 |
| `applications.json` | `[{id,company,role,docId,status,dueDate,updatedAt,…}]` | 六态枚举 + 读侧老枚举归一（不写回） |
| `GET /api/application-records` | `{items,page,limit,hasMore,summary}` | 投影只取 `{id,company,role,status,dueDate,updatedAt}` |
| `POST /api/resume/parse` | `{html|text}` → v4 resumeData | 纯读投影，无存储侧；`_meta.source='html-derived'`、docId 为空 |
| `GET /api/showcases` | `[showcase…]` | 源 = `THEMES`×`listThemes`；`preview.themeId` 记 RR 名，`downloadCount` 恒 0 |
