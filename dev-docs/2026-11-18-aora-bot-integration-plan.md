# Aora Bot 接入简历工作台 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 aora-bot 程序化角色接入工作台——三个 AI 页挂「动词驱动」的状态化身（有动画），空态与设置页署名位放静态装饰角色（零 JS）。

**Architecture:** 混合接入（spec §3 方案 A）：vendored `aora-bot.js`（356KB 单文件）经新登记路由 + `<aora-bot>` Web Component 驱动三页状态化身；`@aora-bot/engine`（仅 devDep）构建期渲静态 SVG 走 `svgAsset` 惯例做装饰。状态映射纯客户端，后端逻辑零改动。

**Tech Stack:** Node 内置 http（零框架）、原生 JS 面板、`@aora-bot/element@0.2.0`（vendored）、`@aora-bot/engine@0.2.0`（devDep）。

**上游 spec:** `dev-docs/2026-11-18-aora-bot-integration-design.md`（commit 8cc97c8 + 3afe753）。

**工作分支:** main（仓惯例：直改直提，commit 信息沿用 `feat(scope):` 风）。

---

## 关键既成事实（实施者必读）

| 事实 | 锚点 |
|---|---|
| 路由字面量冻结表，新路由必须先登记 | `test-structure.sh` ROUTES_FROZEN ~:2212 |
| JS 文件路由先例（readFileSync → application/javascript） | `server.mjs:4806` |
| 页面 script 注入先例 | `server.mjs:2193`（agent）/`:9344`（ai-helper）/`:9568`（interview） |
| CSP `script-src 'self'`，本地路由脚本免 nonce | `server.mjs:4725-4727` |
| `renderWelcome()` 建 hello 块；`send()` 移除 hello | `agent-panel.js:316` / `:481` |
| `log.innerHTML=''` 清屏点（切会话） | `agent-panel.js:308,371,522` |
| SSE 帧：`text-delta`/`finish`；工具卡 st `'call'\|'input-*'` | `agent-panel.js:439-460,161` |
| 空态锚点 | `server.mjs:7201`（暂无投递行）/`:7306`（看板空）/`:8483,:8521`（复盘）/`:8552`（练习）；`agent-panel.js:346`（会话列表空，客户端） |
| `/settings` 跟进语提醒卡 → 署名卡插入位 | `server.mjs:7955-7960` |
| vendored 文件小数坐标会误命中 privacy-check 手机号模式（实测 2 处） | 需 pathspec 排除登记 |
| 测试 spawn 先例：mkdtemp RESUME_ROOT + `PORT` env + `node server.mjs` | `test-apps-settings-forms.mjs:43-48` |
| element API：`character/state/size/style-id/face` 属性；shadow DOM | @aora-bot/element dist/element.d.ts |
| `castMember('dot')` → `{shape,color,face,nose}`；`renderStaticSvg(opts)` → SVG 字符串 | @aora-bot/engine dist/core/cast.d.ts, dist/render/static-svg.d.ts |

**纪律红线**：模型输出禁 innerHTML（我们的标签/属性操作不在此列，但新增 HTML 一律走服务端拼接或 `createElement`+`textContent`）；多 agent 并行禁同改 `server.mjs`（本计划串行，主控接线）；新 JSON 数据文件入 `.gitignore`（本计划无）；面板样式走注入 `<style data-*>` 先例。

---

### Task 1: vendor 运行件 + 双路由 + 三处登记

**Files:**
- Create: `vendors/aora-bot.js`
- Modify: `server.mjs`（~:4815 `/agent-panel.js` 路由旁）
- Modify: `test-structure.sh`（ROUTES_FROZEN ~:2220）
- Modify: `privacy-check.sh`（git grep pathspec）
- Test: `test-aora.mjs`（新建，本轮先放路由断言）

- [ ] **Step 1: vendor 文件落位**

```bash
cd ~/resume && mkdir -p vendors
cd /tmp && npm pack @aora-bot/element@0.2.0 --silent && mkdir -p aora-el && tar xzf aora-bot-element-0.2.0.tgz -C aora-el
{ printf '// Aora Bot element 0.2.0 — vendored from npm @aora-bot/element.\n// License: Aora Bot License (分级授权；本仓个人项目免费档，署名见 /settings 页脚).\n// Upstream: https://github.com/sam70361/aora-bot\n'; cat /tmp/aora-el/package/dist/aora-bot.js; } > ~/resume/vendors/aora-bot.js
wc -c ~/resume/vendors/aora-bot.js   # 期望 ≈356000+
```

- [ ] **Step 2: server.mjs 加两条路由**

锚点 `server.mjs` 约 :4815 `url.pathname === '/agent-panel.js'` 分支之后，同构插入：

```js
    // aora 角色引擎 vendored 运行件 + 状态助手（登记非放宽）
    if (req.method === 'GET' && url.pathname === '/aora-bot.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'vendors', 'aora-bot.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/aora-face.js') {
      return send(200, fs.readFileSync(path.join(APP_ROOT, 'aora-face.js'), 'utf8'), 'application/javascript; charset=utf-8');
    }
```

- [ ] **Step 3: ROUTES_FROZEN 登记**

`test-structure.sh` ROUTES_FROZEN 数组（.sort() 后顺序），在 `'/applications',` 行之后、`'/archive'` 行之前插入：

```js
'/aora-bot.js','/aora-face.js',   // aora 角色接入（登记非放宽）
```

- [ ] **Step 4: privacy-check.sh 排除登记**

git grep 行 pathspec 追加两个排除（与 `':!test.sh'` 同例）：

```bash
# 在该行既有 ':!config.example.json' 后追加：
':!vendors/aora-bot.js' ':!assets/aora/'
# 行上注释补一句：vendored 引擎与生成 SVG 的坐标小数会误命中手机号模式（第三方/生成产物，登记非放宽）
```

- [ ] **Step 5: 建 test-aora.mjs（首批断言：路由）**

按 `test-apps-settings-forms.mjs` 同款 harness（mkdtemp RESUME_ROOT + 随机端口 + spawn server.mjs）。文件骨架：

```js
// test-aora.mjs — aora-bot 接入断言。退出码 0=全过；1=任一断言失败。
// 隔离 RESUME_ROOT；不碰 7766、不调模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const APP_ROOT = new URL('./', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-aora-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'docs-meta.json'), '{}');
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('server 启动超时')), 15000); server.stdout.on('data', (b) => { if (String(b).includes('简历平台')) { clearTimeout(t); res(); } }); });
const get = (p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.text().then((body) => ({ status: r.status, ct: r.headers.get('content-type') || '', body })));
process.on('exit', () => { try { server.kill(); } catch {} });

// A. 两路由 200 + content-type + 体积
const a = await get('/aora-bot.js');
assert.equal(a.status, 200, '/aora-bot.js 应 200');
assert.match(a.ct, /application\/javascript/, '/aora-bot.js content-type');
assert.ok(a.body.length > 300000, 'vendored 文件体积应 >300KB');
const f = await get('/aora-face.js');
assert.equal(f.status, 200, '/aora-face.js 应 200');
assert.match(f.body, /AoraFace/, 'aora-face.js 应导出 AoraFace');
console.log('✅ A 路由与内容类型');
// （后续任务在此追加 B/C/D/E 段）
console.log('✅ test-aora 全部通过');
server.kill(); process.exit(0);
```

- [ ] **Step 6: 跑测试验证红→绿**

```bash
cd ~/resume && node test-aora.mjs   # 期望：/aora-face.js 404（文件还没建）→ FAIL 属正常预告
```

`/aora-face.js` 在 Task 3 才建。本步验收口径改：先临时把 B 段对 `/aora-face.js` 的断言注释，或接受该断言红、其余绿（实施者在 Task 3 解开）。**选择：断言分两段，Task 1 只跑 A 段前半**——把 `/aora-face.js` 断言移到 Task 3 追加。即本任务 test 只断言 `/aora-bot.js`。

- [ ] **Step 7: 结构测试 + 隐私门禁全绿**

```bash
bash test-structure.sh && bash privacy-check.sh
# 期望：路由集合 missing/extra 归零；隐私 ✅
```

- [ ] **Step 8: Commit**

```bash
git add vendors/aora-bot.js server.mjs test-structure.sh privacy-check.sh test-aora.mjs
git commit -m "feat(aora): vendored element 运行件 + 双路由 + 三处登记"
```

---

### Task 2: engine devDep + SVG codegen + aora.mjs + 契约文档

**Files:**
- Modify: `package.json`（devDependencies）
- Create: `scripts/gen-aora-assets.mjs`
- Create: `assets/aora/{happy,confused,sleeping}.svg`（生成产物，入库）
- Create: `aora.mjs`
- Create: `aora-bot.routes.md`
- Test: `test-aora.mjs`（追加 B 段：模块输出断言）

- [ ] **Step 1: 装 devDep**

```bash
cd ~/resume && npm i -D @aora-bot/engine@0.2.0
grep -A2 devDependencies package.json   # 确认字段出现
```

- [ ] **Step 2: 写 gen-aora-assets.mjs**

```js
// scripts/gen-aora-assets.mjs — 构建期渲装饰 SVG（svgAsset 惯例的素材源）。
// 用法：node scripts/gen-aora-assets.mjs（引擎升级后重跑）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderStaticSvg, castMember } from '@aora-bot/engine/static';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'assets', 'aora');
fs.mkdirSync(outDir, { recursive: true });
const m = castMember('dot');
if (!m) throw new Error('cast id "dot" 不存在');
for (const state of ['happy', 'confused', 'sleeping']) {
  const svg = renderStaticSvg({ shape: m.shape, color: m.color, face: m.face, nose: m.nose, state, sizePx: 48 });
  if (!svg.includes('<svg')) throw new Error(state + ' 渲染结果不是 SVG');
  fs.writeFileSync(path.join(outDir, state + '.svg'), svg);
  console.log('assets/aora/' + state + '.svg', svg.length, 'bytes');
}
```

- [ ] **Step 3: 跑生成并抽查**

```bash
node scripts/gen-aora-assets.mjs
head -c 200 assets/aora/happy.svg   # 期望 <svg 开头
```

- [ ] **Step 4: 写 aora.mjs**

```js
// aora.mjs — 装饰角色服务端渲染。aoraSvg 仿 svgAsset 读入（缺失→空串不炸）；
// aoraEmpty = 统一空态块（SVG+文案，textContent 口径：文案服务端 esc）；
// aoraFoot = /settings 署名卡（许可公开发布署名义务落位）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const cache = {};
export function aoraSvg(name) {
  if (!(name in cache)) {
    try {
      cache[name] = fs.readFileSync(path.join(APP_ROOT, 'assets', 'aora', name + '.svg'), 'utf8').replace(/^<\?xml[^>]*\?>\s*/, '');
    } catch { cache[name] = ''; }
  }
  return cache[name];
}
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function aoraEmpty(text, face = 'happy') {
  return `<div class="aora-empty" style="display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;color:var(--mut)">${aoraSvg(face)}<span>${esc(text)}</span></div>`;
}
export function aoraFoot() {
  return `<div class="card" style="margin-top:var(--space-3);display:flex;align-items:center;gap:10px;color:var(--mut);font-size:12px">${aoraSvg('happy')}<span>角色形象 Powered by <a href="https://github.com/sam70361/aora-bot" rel="noopener">Aora Bot</a></span></div>`;
}
```

- [ ] **Step 5: server.mjs 接线**

import 段追加：`import { aoraSvg, aoraEmpty, aoraFoot } from './aora.mjs';   // aora 装饰角色（空态+署名卡）`

- [ ] **Step 6: 写 aora-bot.routes.md**

```markdown
# aora-bot 接入契约

## 路由
- GET /aora-bot.js → vendors/aora-bot.js（356KB，@aora-bot/element@0.2.0 vendored 单文件）
- GET /aora-face.js → aora-face.js（状态化身助手，见下）

## element 用法
`<aora-bot character="dot" state="<CharacterState>" size="<px>" face="cute">`，shadow DOM 自绘。
状态全集 44 见 @aora-bot/engine `CHARACTER_STATES`。

## AoraFace 契约（aora-face.js）
- `AoraFace.mount(host, {page, size=96, character='dot', cornerOf}) -> face`
- `AoraFace.set(face, verb)` 动词→状态映射（MAP 为唯一口径）
- `AoraFace.compact(face)` 挪 cornerOf 角位 + size→28
- `AoraFace.show(face, host, sizePx)` 挪回 host + 指定尺寸
动词：init/idle/send/tool/stream/wait-user/done/error；未映射动词静默忽略。
瞬时态（happy/celebrate/alerting/confused）3s 自动回 idle。

## aora.mjs（服务端）
- aoraSvg(name) / aoraEmpty(text[,face]) / aoraFoot()
- 素材：assets/aora/*.svg，由 scripts/gen-aora-assets.mjs 生成（@aora-bot/engine devDep）

## 面板动词接线点（不改协议）
- agent：send→send；工具帧→tool；text-delta→stream；finish→done；catch→error；renderWelcome→show
- interview：生成在途→send；delta→stream；done→done；pending 题→wait-user；err→error
- ai-helper：postJson/postStream 入口→send；delta→stream；done→done；err/409→error
```

- [ ] **Step 7: test-aora.mjs 追加 B 段（模块断言，不依赖端口）**

文件尾部 `console.log('✅ test-aora 全部通过')` 之前插入：

```js
// B. aora.mjs 输出形状（直 import，不走 HTTP）
const { aoraSvg, aoraEmpty, aoraFoot } = await import(path.join(APP_ROOT, 'aora.mjs'));
assert.ok(aoraSvg('happy').includes('<svg'), 'happy.svg 应已生成可读');
assert.ok(aoraEmpty('暂无投递').includes('aora-empty'), 'aoraEmpty 容器');
assert.ok(aoraEmpty('暂无投递').includes('暂无投递'), 'aoraEmpty 文案');
assert.ok(aoraEmpty('<x>').includes('&lt;x&gt;'), 'aoraEmpty 应 esc 文案');
assert.ok(aoraFoot().includes('Powered by'), 'aoraFoot 署名');
assert.ok(aoraFoot().includes('github.com/sam70361/aora-bot'), 'aoraFoot 链接');
console.log('✅ B aora.mjs 模块');
```

- [ ] **Step 8: 跑测试 + 门禁**

```bash
node test-aora.mjs && bash test-structure.sh && bash privacy-check.sh
# 若 assets/aora/*.svg 仍命中手机号模式：privacy-check 已按 Task 1 Step 4 排除（验证之）
```

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json scripts/gen-aora-assets.mjs assets/aora/ aora.mjs aora-bot.routes.md test-aora.mjs server.mjs
git commit -m "feat(aora): engine devDep + SVG codegen + aora.mjs 装饰渲染 + 契约文档"
```

---

### Task 3: aora-face.js 客户端状态助手

**Files:**
- Create: `aora-face.js`
- Test: `test-aora.mjs`（追加 C 段：映射表合法性 + 路由断言归位）

- [ ] **Step 1: 写 aora-face.js**

```js
// aora-face.js — <aora-bot> 状态化身助手（agent/interview/ai-helper 三页共用）。
// 动词→状态映射唯一口径；瞬时态 3s 回 idle；96↔28 缩放由 compact/show 驱动。
// 前置：<script src="/aora-bot.js"> 先注册 custom element；CSP script-src 'self' 已覆盖。
(function () {
  var MAP = {
    'agent':     { init: 'curious', idle: 'idle', send: 'thinking', tool: 'searching', stream: 'writing', done: 'happy',     error: 'alerting' },
    'interview': { init: 'idle',    idle: 'idle', send: 'thinking',                        stream: 'writing', 'wait-user': 'listening', done: 'celebrate', error: 'alerting' },
    'ai-helper': { init: 'idle',    idle: 'idle', send: 'working',                         stream: 'writing', done: 'happy',     error: 'confused'  }
  };
  var TRANSIENT_MS = 3000;
  var TRANSIENT = { happy: 1, celebrate: 1, alerting: 1, confused: 1 };
  var cssDone = false;
  function ensureCss() {
    if (cssDone) return; cssDone = true;
    var st = document.createElement('style');
    st.setAttribute('data-aora-face', '1');
    st.textContent = '.aora-host{position:relative}.aora-corner{position:absolute;top:10px;right:14px;z-index:6}.aora-slot{display:flex;align-items:center}';
    document.head.appendChild(st);
  }
  function mapOf(face) { return MAP[face.page] || MAP.agent; }
  function set(face, verb) {
    var st = mapOf(face)[verb];
    if (!st) return;
    face.verb = verb;
    if (face._t) { clearTimeout(face._t); face._t = 0; }
    face.el.setAttribute('state', st);
    if (TRANSIENT[st]) face._t = setTimeout(function () { face.el.setAttribute('state', mapOf(face).idle || 'idle'); face._t = 0; }, TRANSIENT_MS);
  }
  function mount(host, opts) {
    opts = opts || {};
    ensureCss();
    var slot = document.createElement('div');
    slot.className = 'aora-slot';
    var el = document.createElement('aora-bot');
    el.setAttribute('character', opts.character || 'dot');
    el.setAttribute('size', String(opts.size || 96));
    slot.appendChild(el);
    host.appendChild(slot);
    var cornerOf = typeof opts.cornerOf === 'string' ? document.querySelector(opts.cornerOf) : opts.cornerOf;
    var face = { el: el, slot: slot, page: opts.page || 'agent', verb: '', _t: 0, cornerOf: cornerOf || host };
    set(face, 'init');
    return face;
  }
  function compact(face) {
    var host = face.cornerOf;
    if (!host || !host.appendChild) return;
    host.classList.add('aora-host');
    var corner = host.querySelector('.aora-corner');
    if (!corner) { corner = document.createElement('div'); corner.className = 'aora-corner'; host.appendChild(corner); }
    corner.appendChild(face.slot);
    face.el.setAttribute('size', '28');
  }
  function show(face, host, sizePx) {
    if (!host || !host.appendChild) return;
    host.appendChild(face.slot);
    face.el.setAttribute('size', String(sizePx || 96));
  }
  window.AoraFace = { MAP: MAP, mount: mount, set: set, compact: compact, show: show };
})();
```

- [ ] **Step 2: test-aora.mjs — /aora-face.js 断言归位 + C 段映射表合法性**

A 段末尾（`/aora-face.js` 相关断言行）启用；追加：

```js
// C. 映射表状态名 ∈ engine 44 全集；动词值域无未知态
const { CHARACTER_STATES } = await import('@aora-bot/engine/static');
const src = fs.readFileSync(path.join(APP_ROOT, 'aora-face.js'), 'utf8');
const mapBlock = src.slice(src.indexOf('var MAP = {'), src.indexOf('};', src.indexOf('var MAP = {')));
const vals = [...mapBlock.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1]);
assert.ok(vals.length >= 15, '映射表应覆盖三页动词');
for (const v of vals) assert.ok(CHARACTER_STATES.includes(v), '非法状态名: ' + v);
for (const p of ['agent', 'interview', 'ai-helper']) assert.ok(mapBlock.includes("'" + p + "'"), '缺页: ' + p);
console.log('✅ C 映射表合法');
```

- [ ] **Step 3: 跑测试**

```bash
node test-aora.mjs   # A+B+C 全绿
```

- [ ] **Step 4: Commit**

```bash
git add aora-face.js test-aora.mjs
git commit -m "feat(aora): aora-face 状态助手——动词→44态映射 + 96↔28 缩放"
```

---

### Task 4: server 装饰接线——script 注入 + 空态 + 署名卡

**Files:**
- Modify: `server.mjs`（agentPageInner ~:2193、ai-helper inner ~:9342、interview inner ~:9566、空态 4 组、settings 卡 ~:7960）
- Test: `test-aora.mjs`（追加 D 段：页面内容断言）

- [ ] **Step 1: 三处 script 注入**

`agentPageInner`（:2193）：

```js
    <script src="/aora-bot.js" defer></script>
    <script src="/aora-face.js" defer></script>
    <script src="/agent-panel.js" defer></script>`;
```

ai-helper inner（:9344，`ai-helper-panel.js` script 行前加同样两行 defer）。interview inner（:9566，`interview-panel.js` 无 defer，同构加两行不带 defer 的 src 标签于其前）。

- [ ] **Step 2: 空态换 aoraEmpty / aoraSvg**

四处（行号为近似锚点，以代码为准）：

1. `:7201` 暂无投递行 → `<td colspan="8" style="color:var(--mut);text-align:center;padding:20px">${aoraEmpty('暂无投递')}</td>`
2. `:7306` 看板空列 → 原 `'<div style="color:var(--mut);font-size:12px;padding:4px 8px">（空）</div>'` 换 `aoraEmpty('（空）')`
3. `:8521` refsHtml 空 → `'<div style="font-size:12px;color:var(--mut);margin-top:var(--space-hair)">暂无投递记录</div>'` 换 `aoraEmpty('暂无投递记录')`
4. 富内容两处用 aoraSvg 前置（不改文案/链接结构）：
   - `:8483` 复盘空卡 → `<div class="card" style="text-align:center;padding:40px;color:var(--mut)">${aoraSvg('happy')}<br>暂无投递记录<br><br><a href="/applications">先去「投递」页添加记录</a></div>`
   - `:8552` 练习空 → `<p ...>` 前插 `<div style="margin:var(--space-2) 0">${aoraSvg('sleeping')}</div>`（同卡内）

- [ ] **Step 3: /settings 署名卡**

跟进语提醒卡 `</div>`（:7960 附近，fuDays `</label>` 闭合后）插一行：

```js
    ${aoraFoot()}
```

- [ ] **Step 4: test-aora.mjs 追加 D 段**

```js
// D. 页面接线断言
const apps = await get('/applications');
assert.ok(apps.body.includes('aora-empty') || apps.body.includes('<svg'), '投递页空态应带 aora 装饰');
const st = await get('/stats');
assert.ok(st.status === 200 && st.body.includes('<svg'), '复盘页应带 aora 装饰');
const setp = await get('/settings');
assert.ok(setp.body.includes('Powered by') && setp.body.includes('aora-bot'), '设置页署名卡');
const agp = await get('/agent');
assert.ok(agp.body.includes('/aora-bot.js') && agp.body.includes('/aora-face.js'), 'agent 页脚本注入');
const ivp = await get('/interview');
assert.ok(ivp.body.includes('/aora-bot.js') && ivp.body.includes('/aora-face.js'), 'interview 页脚本注入');
const ahp = await get('/ai-helper');
assert.ok(ahp.body.includes('/aora-bot.js') && ahp.body.includes('/aora-face.js'), 'ai-helper 页脚本注入');
console.log('✅ D 页面接线');
```

- [ ] **Step 5: 跑全门禁**

```bash
node test-aora.mjs && bash test.sh && bash test-structure.sh && bash privacy-check.sh
```

- [ ] **Step 6: Commit**

```bash
git add server.mjs test-aora.mjs
git commit -m "feat(aora): server 接线——三页脚本注入 + 五处空态 + settings 署名卡"
```

---

### Task 5: agent-panel 状态化身接线

**Files:**
- Modify: `agent-panel.js`（renderWelcome ~:316、send ~:477、消息渲染 :308、SSE :439-460、css 串、会话空态 :346）

- [ ] **Step 1: 面板顶加 face 句柄 + hello 改 flex**

css 串（现有 `+ '#agent-app ...'` 链）追加：

```js
    + '#agent-app .ag-hello{display:flex;gap:14px;align-items:flex-start}'
    + '#agent-app .ag-hello .ag-hb{flex:1;min-width:0}'
```

renderWelcome() 改造（h/s 包进 .ag-hb，前插 aora 槽位）：

```js
    d.innerHTML = '<div class="ag-hb"><div class="h">' + greet + '。今天想先推进哪一步？</div>'
      + '<div class="s">我可以帮你评估收件箱岗位、改简历、盯投递进度。引用具体对象用 [context:job:岗位id] 或 [context:doc:简历id]。</div></div>';
    var hb = d.querySelector('.ag-hb');
    hb.appendChild(chips);              // 原 d.appendChild(chips) 改落 hb
    var slot = document.createElement('div');
    d.insertBefore(slot, d.firstChild);
    if (window.AoraFace) {
      if (!face) face = AoraFace.mount(slot, { page: 'agent', size: 96, cornerOf: '.ag-main' });
      else AoraFace.show(face, slot, 96);
    }
```

模块顶 `var face = null;`（mount 变量区附近）。

- [ ] **Step 2: hello 清除前 compact（两处 + send）**

`:308` 与 `:371`、`:522` 的 `log.innerHTML = ''` 之前，以及 send() 里 `hello.remove()` 之前，统一先：

```js
    if (face) AoraFace.compact(face);
```

send() 在 compact 后追加 `AoraFace.set(face, 'send');`

- [ ] **Step 3: SSE 帧挂钩**

`:439` `var ev; try { ev = JSON.parse(payload); } catch (e2) { continue; }` 之后插：

```js
          if (face && ev && ev.type) {
            if (ev.type === 'text-delta') AoraFace.set(face, 'stream');
            else if (ev.type.indexOf('tool') === 0) AoraFace.set(face, 'tool');
          }
```

`ev.type === 'finish'` 分支内加 `if (face) AoraFace.set(face, 'done');`。send 的 catch（:501 附近）加 `if (face) AoraFace.set(face, 'error');`。非流式 JSON 回退路径（:411-420 成功分支）加 `if (face) AoraFace.set(face, 'done');`，失败分支 `error`。

- [ ] **Step 4: 会话列表空态上 live element**

`:346` →

```js
    if (!list.length) { sessBox.innerHTML = '<div class="ag-empty-side"><aora-bot character="dot" state="sleeping" size="36"></aora-bot><div style="margin-top:6px">还没有会话，点上方「＋ 新会话」开始</div></div>'; return; }
```

- [ ] **Step 5: test-aora.mjs 追加 E 段（源级断言）**

```js
// E. 面板接线源级断言
const ag = fs.readFileSync(path.join(APP_ROOT, 'agent-panel.js'), 'utf8');
for (const needle of ["AoraFace.mount(slot, { page: 'agent'", "AoraFace.set(face, 'send')", "AoraFace.set(face, 'stream')", "AoraFace.set(face, 'done')", "AoraFace.set(face, 'error')", 'AoraFace.compact(face)'])
  assert.ok(ag.includes(needle), 'agent-panel 缺: ' + needle);
console.log('✅ E agent-panel 接线');
```

- [ ] **Step 6: 测试 + Commit**

```bash
node test-aora.mjs && bash test.sh
git add agent-panel.js test-aora.mjs
git commit -m "feat(aora): agent 页状态化身——hello 96px→角落 28px + SSE 动词接线"
```

---

### Task 6: interview-panel 状态化身接线

**Files:**
- Modify: `interview-panel.js`（mount #ivApp :8、page-head 槽位、ssePost :131、pumpSSE :101、render 尾部、模块顶 face 句柄）

- [ ] **Step 1: mount 于 .page-head（不被 #ivApp 重渲染擦除）**

面板 init 早期（mount 变量之后）：

```js
    var face = null;
    var headEl = document.querySelector('.page-head');
    if (window.AoraFace && headEl) {
      var fslot = document.createElement('span');
      fslot.style.cssText = 'display:inline-flex;margin-left:auto';
      headEl.appendChild(fslot);
      face = AoraFace.mount(fslot, { page: 'interview', size: 96, cornerOf: '.page-head' });
    }
    var fset = function (v) { if (face) { if (v === 'send') AoraFace.compact(face); AoraFace.set(face, v); } };
```

`.page-head` 需能放角标：aora-face 的 `.aora-host{position:relative}` 由 compact 自动加；`.page-head` 若已是 flex，角标仍按 absolute 钉右上（aora-corner 生效）。

- [ ] **Step 2: 动词接线（choke point）**

- 每个生成路径入口（doNext/genHintStream/genReportStream/submitAnswer 的 ssePost/fetch 前）加 `fset('send');`
- `pumpSSE(stream, onDelta)` 各调用点的 `onDelta` 回调首行加 `fset('stream');`
- 各 promise 成功 then（done 载荷处）加 `fset('done');`，catch 加 `fset('error');`
- render() 尾部（DOM 稳定后）加：

```js
    fset(cur && cur.pending ? 'wait-user' : 'idle');
```

- [ ] **Step 3: test-aora.mjs 追加 F 段**

```js
const iv = fs.readFileSync(path.join(APP_ROOT, 'interview-panel.js'), 'utf8');
for (const needle of ["page: 'interview'", "fset('send')", "fset('stream')", "fset('done')", "fset('error')", "wait-user"])
  assert.ok(iv.includes(needle), 'interview-panel 缺: ' + needle);
console.log('✅ F interview-panel 接线');
```

- [ ] **Step 4: 测试 + Commit**

```bash
node test-aora.mjs && bash test.sh
git add interview-panel.js test-aora.mjs
git commit -m "feat(aora): interview 页状态化身——页头钉位 + SSE 动词接线"
```

---

### Task 7: ai-helper-panel 状态化身接线

**Files:**
- Modify: `ai-helper-panel.js`（mountEl #ah-app :13、page-head 槽位、postJson :100、postStream :128）

- [ ] **Step 1: mount + fset（同 Task 6 款，page 改 'ai-helper'）**

```js
    var face = null;
    var headEl = document.querySelector('.page-head');
    if (window.AoraFace && headEl) {
      var fslot = document.createElement('span');
      fslot.style.cssText = 'display:inline-flex;margin-left:auto';
      headEl.appendChild(fslot);
      face = AoraFace.mount(fslot, { page: 'ai-helper', size: 96, cornerOf: '.page-head' });
    }
    var fset = function (v) { if (face) { if (v === 'send') AoraFace.compact(face); AoraFace.set(face, v); } };
```

- [ ] **Step 2: 动词接线（choke point 覆盖全页 AI 操作）**

`postJson`（:100）入口加 `fset('send');`；其成功返回前 `fset('done');`、catch `fset('error');`。
`postStream`（:128）入口加 `fset('send');`；`onDelta` 每次回调 `fset('stream');`；`{done:true}` 返回处 `fset('done');`；catch/非 2xx/409 分支 `fset('error');`。

> 注：postJson/postStream 是本页全部 AI 操作的唯一通道（check/improve-all/rewrite/polish），choke point 接线即全覆盖，无需逐调用点。

- [ ] **Step 3: test-aora.mjs 追加 G 段**

```js
const ah = fs.readFileSync(path.join(APP_ROOT, 'ai-helper-panel.js'), 'utf8');
for (const needle of ["page: 'ai-helper'", "fset('send')", "fset('stream')", "fset('done')", "fset('error')"])
  assert.ok(ah.includes(needle), 'ai-helper-panel 缺: ' + needle);
console.log('✅ G ai-helper-panel 接线');
```

- [ ] **Step 4: 测试 + Commit**

```bash
node test-aora.mjs && bash test.sh
git add ai-helper-panel.js test-aora.mjs
git commit -m "feat(aora): ai-helper 页状态化身——页头钉位 + choke 动词接线"
```

---

### Task 8: 端到端验收

- [ ] **Step 1: 全量门禁**

```bash
cd ~/resume && node test-aora.mjs && bash test.sh && bash test-structure.sh && bash test-render.sh && bash privacy-check.sh
```

- [ ] **Step 2: playwright 截图验收（仓内跑）**

起本地服务后 chromium 截三页：/agent（空会话 hello 96px）、/agent（发一条消息——无 LLM 时走 stub 或观察 thinking→error 切换）、/interview、/ai-helper。截图存 /tmp 目检角色渲染与缩放。

- [ ] **Step 3: 清理 brainstorm 服务器**

```bash
/Users/xxxly/.agents/skills/brainstorming/scripts/stop-server.sh /Users/xxxly/resume/.superpowers/brainstorm/25492-1794990285
```

- [ ] **Step 4: 收尾 commit（如有测试/文档小修）**

---

## 自审记录

- spec 覆盖：§4 全部改动项→Task 1/2/4；§5 化身→Task 3/5/6/7；§6 装饰→Task 2/4；§7 测试→各 Task + Task 8；§8 许可→Task 1（vendor 头注释）/Task 2（aoraFoot）；§9 二期不做，无需任务。
- 无 TBD/TODO 占位；所有步骤带可执行码。
- 命名一致：AoraFace.mount/set/compact/show；动词 init/idle/send/tool/stream/wait-user/done/error；aoraSvg/aoraEmpty/aoraFoot。
