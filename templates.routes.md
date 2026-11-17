# templates.routes.md — 「模板库」路由接入规范

配套文件：`templates-page.mjs`（新增，导出 `THEMES` 与 `renderTemplatesPage(opts)`）。
本规范描述 server.mjs 需要的改动；`templates-page.mjs` 自身不含服务端代码。

## 1. 建议路径与页面壳

- 路由：`GET /templates`，可选 `?id=<docId>` 携带既有文档上下文。
- 页面壳复用 `page(title, inner, active)`（server.mjs:1910）：
  `page('模板库', renderTemplatesPage({...}), 'templates')`。
- `active='templates'` 目前不匹配任何 topnav 项（无高亮，属预期；见 §4 可选导航）。

## 2. server.mjs 需要的改动

### 2.1 文件头追加一行 import

```js
import { renderTemplatesPage } from './templates-page.mjs';
```

`listThemes` / `assembleTemplate` / `themeRegistration` 已在 server.mjs:37 导入；
`updateMeta` 已在 server.mjs:21 从 `./tx.mjs` 导入；`themePreviewHtml` /
`obBlankDocHtml` / `VALID_ID` / `docPath` / `loadMeta` 均为 handler 可见的内部函数，无需新导入。

### 2.2 注册 GET /templates（建议放 `/theme-preview` 块附近，server.mjs:6899 之后）

```js
// ===== 模板库（只读页）：主题卡 srcdoc 缩略图 +「使用此模板」表单 =====
// 预览装配走单一实现 themePreviewHtml()（DESIGN.md §10.1）：卡内 srcdoc 与
// GET /theme-preview 响应体逐字节相等，本路由生成后经 opts.previews 传入页面模块。
if (req.method === 'GET' && url.pathname === '/templates') {
  const qid = url.searchParams.get('id') || '';
  if (qid && !VALID_ID.test(qid)) return send(400, 'invalid id', 'text/plain');
  if (qid && !fs.existsSync(docPath(qid))) return send(404, 'doc not found', 'text/plain');
  // 缩略图源：带 id 用该文档正文（同 obPreviewSourceHtml 口径）；无 id 用空白模板装配。
  const src = qid ? fs.readFileSync(docPath(qid), 'utf8') : obBlankDocHtml('doc');
  const previews = {};
  for (const th of listThemes()) previews[th] = themePreviewHtml(src, th);
  const cur = qid ? String((loadMeta()[qid] || {}).theme || '') : '';
  return send(200, page('模板库', renderTemplatesPage({
    previews,
    docId: qid,
    currentTheme: cur,
    applied: url.searchParams.get('applied') || ''
  }), 'templates'));
}
```

## 3. 「使用此模板」落库 —— POST /templates/use（当前为占位待接点）

页面每个模板卡已输出：

```html
<form method="post" action="/templates/use">
  <input type="hidden" name="id" value="...">     <!-- 仅 ?id= 上下文存在时 -->
  <input type="hidden" name="theme" value="classic">
  <button type="submit" data-theme="classic">使用此模板</button>
</form>
```

建议实现（`readBodyAuto` 已兼容 `application/x-www-form-urlencoded`，server.mjs:1756）：

```js
if (req.method === 'POST' && url.pathname === '/templates/use') {
  const body = await readBodyAuto(req);
  const th = String((body && body.theme) || '');
  if (!listThemes().includes(th)) {
    return sendJson(400, { ok: false, error: `未知主题: ${th || '(空)'}` });
  }
  const docId = String((body && body.id) || '');
  if (docId) {
    // 既有文档换模板：与 POST /theme/apply（server.mjs:6913-6923）同一写入 helper。
    // meta.theme 写入即生效——/edit 服务装配与渲染装配都以 meta.theme 为数据源，不重写正文。
    if (!VALID_ID.test(docId)) return sendJson(400, { ok: false, error: 'invalid id' });
    if (!fs.existsSync(docPath(docId))) return sendJson(404, { ok: false, error: 'doc not found' });
    updateMeta(root, docId, (m) => ({ ...(m || {}), theme: th }));
    return redirect('/templates?id=' + encodeURIComponent(docId) + '&applied=' + encodeURIComponent(th));
  }
  // 无文档上下文 = 从模板库新建文档：复用 POST /new（server.mjs:4875-4894）同路径，
  // 差异仅主题由 'classic' 改为所选 th（装配与 meta 登记用同一主题，风格一致）。
  const newId = obNewDocId();
  fs.writeFileSync(docPath(newId), obBlankDocHtml(newId));
  updateMeta(root, newId, (m) => ({
    ...(m || {}), ...themeRegistration(th), kind: 'master', flow: 'draft', archivedAt: null
  }));
  return redirect('/edit?id=' + encodeURIComponent(newId));
}
```

说明：
- 既有文档路径的唯一写 = `docs-meta.theme`（`updateMeta`，tx.mjs），与「onboarding 完成路径」
  `obCreateDoc` 里 `themeRegistration('classic') + { theme: themeName }`（server.mjs:4267-4275）同源。
- `themeRegistration(th)` 生成 `{ theme, styleHash, typo, schemaVersion }` 登记载荷
  （template.mjs:51），只用于新建文档；既有文档只 patch `theme` 字段。
- 表单 PRG 回跳带 `?applied=<theme>`，页面渲染「已应用」提示条。

## 4. 可选：topnav 导航入口

`page()` 内导航行（server.mjs:2138）追加一项即可高亮 `active='templates'`：

```js
${nav('templates', '/templates', '模板', 'palette')}
```

`'palette'` 在 `vendors/icons.mjs` 白名单内（`icon()` 白名单外返回空串，安全）。

## 5. 安全与口径检查

- 预览 srcdoc 必须来自 `themePreviewHtml()`（单一实现）；不要在本模块自拼，也不要用
  `iframe src="/theme-preview?..."` —— 该端点带 `frame-ancestors 'none'`，嵌框会被拒。
- 本页零 `<script>`（按钮为纯 form POST），无 `__CSP_NONCE__` 需求；默认 CSP 的
  `style-src 'unsafe-inline'` 放行随 inner 下发的 scoped `<style>`，`form-action 'self'` 放行同源 POST。
- 外部数据（docId / theme / applied）进 HTML 一律 `escHtml`/`escAttr`（模块内已处理）。
- `renderTemplatesPage` 只读：不碰 fs、不写 meta；可用性过滤以 `listThemes()` 为准。

## 6. 未接点清单

1. `POST /templates/use` 未注册 → 接入前点「使用此模板」返回 404（预期，占位）。
2. topnav 无「模板」入口 → `GET /templates` 需直接访问或按 §4 加导航。
3. `GET /templates` 未注册 → 按 §2.2 接入后生效。
