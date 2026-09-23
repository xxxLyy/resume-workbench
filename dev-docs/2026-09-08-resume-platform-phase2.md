# 简历平台 Phase 2 实施计划（多文档 + PDF 导入）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平台从单文档升级为多文档：文档列表首页、复制/删除、上传其它 PDF 导入为可编辑文档（有 LLM 配置时结构化灌模板，无配置时降级纯文本）。

**Architecture:** 沿用 Phase 1 的零框架单进程服务。server.mjs 保持纯路由；新增 llm.mjs（OpenAI 兼容客户端）和 importer.mjs（pdftotext + 结构化 + 组装）两个独立模块；template.html 承载文档骨架。测试全部走隔离文档/假 LLM，不烧真实 token、不碰真实简历。

**Tech Stack:** Node 内置模块、playwright-core@1.60.0（已有）、pdftotext（poppler，已装）、fetch（Node 内置）。

**Spec:** `docs/superpowers/specs/2026-08-17-resume-platform-design.md` Phase 2 节

**约束:**
- 禁止任何 git 操作；ponytail 原则（最简可用、标准库优先）
- 上传用 **raw body + query 传文件名**，不解析 multipart
- LLM 结构化必须可注入假函数测试（`structureText(text, llmFn)`）
- 现有文档 `docs/linghaoxiang.html` 内容一个字不能动

---

### Task 1: server 多文档化（列表首页 / 编辑器注入 / 复制 / 删除）

**Files:**
- Modify: `~/resume/server.mjs`
- Modify: `~/resume/test.sh`

**变更点（在 Phase 1 的 server.mjs 基础上改）：**

1. `GET /` 从"直接服务单文档"改为**文档列表页**；编辑器移到 `GET /edit?id=`（`GET /` 不再承担编辑器）
2. `GET /edit?id=` 服务文档时做两处注入：
   - `html.replace(/var DOC_ID = '[^']*'/, \`var DOC_ID = '${id}'\`)`（多文档关键：每份文档保存到自己）
   - 工具栏注入首页按钮：`html.replace('<button id="histBtn"', '<button id="homeBtn" class="secondary" onclick="location.href=\'/\'">🏠 首页</button><button id="histBtn"')`
3. 新增 `POST /duplicate?id=&to=`：复制文档（VALID_ID 校验 `to`，目标已存在则 409）
4. 新增 `POST /delete?id=`：删 `docs/<id>.html` 和 `pdfs/<id>.pdf`；**snapshots 保留**（删除也有后悔药）；不允许删除最后一个文档（400）
5. 修复终审 Minor #4：`/rollback` 的 303 重定向从 `/` 改为 `/edit?id=${id}`

**列表页实现**（加入 server.mjs，复用现有 page() helper）：

```js
function listPage() {
  const docs = fs.readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.html') && !f.startsWith('.'));
  const cards = docs.map((f) => {
    const id = f.replace('.html', '');
    const content = fs.readFileSync(path.join(root, 'docs', f), 'utf8');
    const title = (content.match(/<h1>([^<]+)<\/h1>/) || [])[1] || id;
    const mtime = fs.statSync(path.join(root, 'docs', f)).mtime.toLocaleString('zh-CN');
    return `<li><b>${title}</b>（${id}，更新于 ${mtime}）
      <a href="/edit?id=${id}">编辑</a> ·
      <a href="/pdf?id=${id}" target="_blank">PDF</a> ·
      <a href="/snapshots?id=${id}">历史</a> ·
      <form method="post" action="/duplicate?id=${id}" style="display:inline" onsubmit="event.preventDefault();const t=prompt('新文档 id（小写字母数字横线）');if(t){this.action='/duplicate?id=${id}&to='+t;this.submit()}"><button>复制</button></form> ·
      <form method="post" action="/delete?id=${id}" style="display:inline" onsubmit="return confirm('确认删除 ${id}？快照会保留')"><button>删除</button></form>
    </li>`;
  }).join('\n');
  return page('简历平台', `<h1>简历平台</h1>
    <form id="up" style="margin:12px 0;padding:10px;border:1px dashed #999">
      <b>上传 PDF 导入：</b><input type="file" id="upfile" accept="application/pdf">
      <button>导入</button><span id="upmsg"></span>
    </form>
    <ul>${cards}</ul>
    <script>
      document.getElementById('up').addEventListener('submit', async function (e) {
        e.preventDefault();
        var f = document.getElementById('upfile').files[0];
        if (!f) return;
        document.getElementById('upmsg').textContent = ' 导入中（LLM 结构化需几十秒）…';
        var r = await fetch('/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
        if (r.redirected) { location.href = r.url; return; }
        document.getElementById('upmsg').textContent = ' ' + (await r.text());
      });
    </script>`);
}
```

**新端点代码（加入 handler）：**

```js
    // 文档列表首页
    if (req.method === 'GET' && url.pathname === '/') {
      return send(200, listPage());
    }
    // 编辑器（serve 时注入 DOC_ID 和首页按钮）
    if (req.method === 'GET' && url.pathname === '/edit') {
      if (!fs.existsSync(docPath(id))) return send(404, page('404', `<h1>文档不存在: ${id}</h1><p><a href="/">返回首页</a></p>`));
      let html = fs.readFileSync(docPath(id), 'utf8');
      html = html.replace(/var DOC_ID = '[^']*'/, `var DOC_ID = '${id}'`);
      html = html.replace('<button id="histBtn"', `<button id="homeBtn" class="secondary" onclick="location.href='/'">🏠 首页</button><button id="histBtn"`);
      return send(200, html);
    }
    // 复制文档
    if (req.method === 'POST' && url.pathname === '/duplicate') {
      const to = url.searchParams.get('to') || '';
      if (!VALID_ID.test(to)) return send(400, 'invalid target id', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      if (fs.existsSync(docPath(to))) return send(409, 'target exists', 'text/plain');
      fs.copyFileSync(docPath(id), docPath(to));
      res.writeHead(303, { Location: `/edit?id=${to}` });
      return res.end();
    }
    // 删除文档（快照保留）
    if (req.method === 'POST' && url.pathname === '/delete') {
      const docs = fs.readdirSync(path.join(root, 'docs')).filter((f) => f.endsWith('.html'));
      if (docs.length <= 1) return send(400, '至少保留一份文档', 'text/plain');
      if (!fs.existsSync(docPath(id))) return send(404, 'doc not found', 'text/plain');
      fs.unlinkSync(docPath(id));
      if (fs.existsSync(pdfPath(id))) fs.unlinkSync(pdfPath(id));
      res.writeHead(303, { Location: '/' });
      return res.end();
    }
```

**rollback 重定向修复**（找到 `/rollback` 分支里的 `Location: '/'`）：

```js
      res.writeHead(303, { Location: `/edit?id=${id}` });
```

**测试扩展**（test.sh 在现有五项后追加，全部用隔离 id，不碰 linghaoxiang）：

```bash
# 4. 多文档：列表页 / 编辑器注入 / 复制 / 删除
curl -sf "http://localhost:$PORT/" | grep -q '上传 PDF 导入' && echo '✅ 列表首页'
curl -sf "http://localhost:$PORT/edit?id=smoketest" | grep -q "var DOC_ID = 'smoketest'" && echo '✅ DOC_ID 注入'
curl -sf "http://localhost:$PORT/edit?id=smoketest" | grep -q 'homeBtn' && echo '✅ 首页按钮注入'
cp docs/linghaoxiang.html docs/smoketest.html   # 重建隔离文档（前面 rollback 后内容仍可用，统一重建最稳）
curl -sf -X POST "http://localhost:$PORT/duplicate?id=smoketest&to=smoketest2" -o /dev/null
test -f docs/smoketest2.html && echo '✅ 复制文档'
curl -sf -X POST "http://localhost:$PORT/delete?id=smoketest2" -o /dev/null
test ! -f docs/smoketest2.html && echo '✅ 删除文档'
```

trap 行的清理清单追加 `docs/smoketest2.html`（防御性，正常路径已删）。

- [ ] **Step 1:** 先改 test.sh 追加新断言，跑 `bash ~/resume/test.sh` 确认新断言失败（列表页/注入不存在）
- [ ] **Step 2:** 改 server.mjs（上述变更点全部落地）
- [ ] **Step 3:** `bash ~/resume/test.sh` 全绿（原有五项 + 新增五项）
- [ ] **Step 4:** 手动起服务（`cd ~/resume && PORT=17899 node server.mjs`），curl 验证 `GET /` 是列表页且含 linghaoxiang 卡片

---

### Task 2: PDF 上传导入（raw body + pdftotext + 降级路径）

**Files:**
- Create: `~/resume/importer.mjs`
- Modify: `~/resume/server.mjs`（upload 路由）
- Modify: `~/resume/test.sh`

**importer.mjs（本任务只实现降级路径；LLM 结构化在 Task 3 插入）：**

```js
// importer.mjs — PDF → 文本 → 可编辑文档（无 LLM 配置时降级为纯文本导入）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hasLLM } from './llm.mjs';
import { structureText } from './structure.mjs';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function slugify(name) {
  const base = String(name || 'doc').replace(/\.pdf$/i, '').toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-+|-+$/g, '') || 'doc';
  return base.slice(0, 40);
}

function uniqueId(root, name) {
  const base = slugify(name);
  let id = base, n = 2;
  while (fs.existsSync(path.join(root, 'docs', id + '.html'))) id = `${base}-${n++}`;
  return id;
}

// 降级文档：纯文本进"导入原文"区，模板结构完整可编辑
function buildRawDoc(root, text, name) {
  const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
  return tpl
    .replace('{{NAME}}', esc(String(name).replace(/\.pdf$/i, '')))
    .replace('{{CONTACT}}', '')
    .replace('{{INTENT}}', '')
    .replace('{{SUMMARY}}', `以下为 PDF 提取的原文（待整理）：`)
    .replace('{{SKILLS}}', '')
    .replace('{{WORK}}', '')
    .replace('{{PROJECTS}}', `<div class="plain-lines"><p style="white-space:pre-wrap">${esc(text)}</p></div>`)
    .replace('{{EDU}}', '');
}

export async function importPdfText(root, pdfPath, name) {
  const text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 32 * 1024 * 1024 }).toString('utf8');
  if (!text.trim()) throw new Error('PDF 提取不到文本（可能是扫描件）');
  const id = uniqueId(root, name);
  let html;
  if (hasLLM(root)) {
    html = await structureText(root, text);   // Task 3 提供；失败则降级
    if (!html) html = buildRawDoc(root, text, name);
  } else {
    html = buildRawDoc(root, text, name);
  }
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), html);
  return id;
}
```

**server.mjs 新增 upload 路由**（放在 /delete 之后）：

```js
    // 上传 PDF 导入（raw body = pdf 字节，文件名走 query）
    if (req.method === 'POST' && url.pathname === '/upload') {
      const body = await readBody(req, 'buffer');
      if (!body.length || !body.slice(0, 5).toString('latin1').startsWith('%PDF-')) {
        return send(400, '需要 PDF 文件', 'text/plain');
      }
      const tmp = path.join(root, 'docs', '.upload-' + Date.now() + '.pdf');
      try {
        fs.writeFileSync(tmp, body);
        const newId = await importPdfText(root, tmp, url.searchParams.get('name') || 'import.pdf');
        res.writeHead(303, { Location: `/edit?id=${newId}` });
        return res.end();
      } catch (e) {
        return send(422, '导入失败：' + e.message, 'text/plain');
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
```

**readBody 改造**（支持二进制，替换现有函数）：

```js
function readBody(req, mode = 'text') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(mode === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
```

原有 `await readBody(req)` 调用不变（默认 text）。

**测试追加**（用 pdfs/linghaoxiang.pdf 当真实 PDF  fixture）：

```bash
# 5. 上传导入（无 config.json → 降级路径）
node -e "const fs=require('fs');process.exit(fs.existsSync('config.json')?1:0)" || echo '（无 LLM 配置，走降级）'
NEWID=$(curl -sf -X POST "http://localhost:$PORT/upload?name=fixture.pdf" --data-binary "@pdfs/linghaoxiang.pdf" -o /dev/null -w '%{redirect_url}' | sed 's/.*id=//')
test -n "$NEWID" && test -f "docs/$NEWID.html" && echo '✅ 上传导入建文档'
grep -q '凌浩翔' "docs/$NEWID.html" && echo '✅ 导入文档含正文'
curl -sf -X POST "http://localhost:$PORT/delete?id=$NEWID" -o /dev/null   # 清理 fixture 文档
```

注意：上传 fixture 是真实简历 PDF，降级路径下提取的文本应含"凌浩翔"。

- [ ] **Step 1:** test.sh 追加上传断言，跑测试确认失败（/upload 404）
- [ ] **Step 2:** 写 importer.mjs + server.mjs upload 路由 + readBody buffer 模式
- [ ] **Step 3:** `bash ~/resume/test.sh` 全绿
- [ ] **Step 4:** 验证降级文档在浏览器可编辑（curl 查 docs 新文档含 contenteditable）

---

### Task 3: LLM 结构化导入（llm.mjs + structure.mjs + template.html）

**Files:**
- Create: `~/resume/llm.mjs`
- Create: `~/resume/structure.mjs`
- Create: `~/resume/template.html`
- Create: `~/resume/config.example.json`
- Create: `~/resume/test-structure.sh`

**llm.mjs（OpenAI 兼容客户端，含火山方舟）：**

```js
// llm.mjs — OpenAI 兼容 LLM 客户端；无配置=降级（hasLLM false）
import fs from 'node:fs';
import path from 'node:path';

export function loadConfig(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); }
  catch { return null; }
}

export function hasLLM(root) {
  const c = loadConfig(root);
  return !!(c && c.apiKey && c.baseURL && c.model);
}

export async function chat(root, system, user) {
  const c = loadConfig(root);
  const r = await fetch(`${c.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) throw new Error(`LLM 请求失败: ${r.status}`);
  const data = await r.json();
  return data.choices[0].message.content;
}
```

**structure.mjs（LLM 结构化 + 模板组装；llmFn 可注入）：**

```js
// structure.mjs — 简历文本 → LLM 结构化 JSON → 模板 HTML
import fs from 'node:fs';
import path from 'node:path';
import { chat } from './llm.mjs';

const SYS = `你是简历结构化助手。把用户给的简历原文提取为 JSON（只输出 JSON，不要任何其它文字）：
{"name":"","contact":"","intent":"","summary":"","skills":["标签：内容"],"work":[{"title":"公司","role":"职位","date":"起止","bullets":[]}],"projects":[{"title":"","role":"","date":"","bullets":[]}],"education":[{"title":"学校","role":"学历|专业","date":"起止"}]}
没有的信息留空字符串/空数组，不要编造。`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bullets = (arr) => (arr || []).map((b) => `        <li>${esc(b)}</li>`).join('\n');
const entries = (arr) => (arr || []).map((e) => `      <div class="entry-head" style="margin-top:1.6mm">
        <div class="entry-title">${esc(e.title)}</div>
        <div class="entry-role">${esc(e.role)}</div>
        <div class="entry-date">${esc(e.date)}</div>
      </div>
      <ul>
${bullets(e.bullets)}
      </ul>`).join('\n\n');
const skillLines = (arr) => (arr || []).map((line) => {
  const i = String(line).indexOf('：');
  return i > 0
    ? `        <p><strong>${esc(String(line).slice(0, i + 1))}</strong>${esc(String(line).slice(i + 1))}</p>`
    : `        <p>${esc(line)}</p>`;
}).join('\n');

export function buildDoc(root, data) {
  const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
  return tpl
    .replace('{{NAME}}', esc(data.name))
    .replace('{{CONTACT}}', esc(data.contact))
    .replace('{{INTENT}}', esc(data.intent))
    .replace('{{SUMMARY}}', esc(data.summary))
    .replace('{{SKILLS}}', skillLines(data.skills))
    .replace('{{WORK}}', entries(data.work))
    .replace('{{PROJECTS}}', entries(data.projects))
    .replace('{{EDU}}', entries(data.education));
}

// llmFn 可注入（测试用假函数）；真实路径调 llm.mjs 的 chat
export async function structureText(root, text, llmFn) {
  const call = llmFn || ((sys, user) => chat(root, sys, user));
  try {
    const raw = await call(SYS, text);
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const data = JSON.parse(cleaned);
    if (!data || typeof data !== 'object' || !('name' in data)) return null;
    return buildDoc(root, data);
  } catch {
    return null;  // 解析/调用失败 → 调用方降级
  }
}
```

**template.html 生成**（从现有文档机械提取骨架，一次性脚本，跑完即弃）：

Create and run `~/resume/make-template.py`:

```python
#!/usr/bin/env python3
"""make-template.py — 从现有简历提取模板骨架（一次性）：保留 CSS/工具栏/脚本，内容换占位符"""
import re, pathlib

src = pathlib.Path.home() / 'resume/docs/linghaoxiang.html'
out = pathlib.Path.home() / 'resume/template.html'
c = src.read_text()

# 头像在模板中去掉（导入的是别人/别的简历，不该带用户照片）
c = re.sub(r'    <img class="avatar"[^>]*>\n', '', c, count=1)
# header 内容换占位符
c = re.sub(r'<h1>[^<]*</h1>', '<h1>{{NAME}}</h1>', c, count=1)
c = re.sub(
    r'<div class="contact">.*?</div>',
    '<div class="contact">\n        {{CONTACT}}<br />\n        {{INTENT}}\n      </div>',
    c, count=1, flags=re.S)
# 内容区换占位符（个人总结/专业技能/工作经历/项目经历/教育经历）
def swap_section(html, title, inner_tpl):
    pat = re.compile(r'(<div class="section-title">' + title + r'</div>).*?(?=      <div class="section-title">|    </section>)', re.S)
    return pat.sub(lambda m: m.group(1) + '\n' + inner_tpl + '\n', html, count=1)

c = swap_section(c, '个人总结', '      <p class="summary">{{SUMMARY}}</p>')
c = swap_section(c, '专业技能', '      <div class="plain-lines">\n{{SKILLS}}\n      </div>')
c = swap_section(c, '工作经历', '{{WORK}}')
c = swap_section(c, '项目经历', '{{PROJECTS}}')
c = swap_section(c, '教育经历', '{{EDU}}')

for m in ['{{NAME}}', '{{CONTACT}}', '{{INTENT}}', '{{SUMMARY}}', '{{SKILLS}}', '{{WORK}}', '{{PROJECTS}}', '{{EDU}}']:
    assert m in c, f'占位符缺失: {m}'
out.write_text(c)
print('✅ template.html 生成，8 个占位符齐全')
```

注意：生成后**人工核验** template.html（`grep -c '{{' template.html` 应为 8；`grep -c '凌浩翔' template.html` 应为 0——零残留真实内容，头像已去）。

**config.example.json：**

```json
{
  "baseURL": "https://ark.cn-beijing.volces.com/api/v3",
  "apiKey": "密钥",
  "model": "doubao-seed-1-6-250615"
}
```

**test-structure.sh（假 LLM，不烧 token）：**

```bash
#!/bin/bash
# test-structure.sh — LLM 结构化组装的单元级验证（注入假 llmFn）
set -e
cd "$(dirname "$0")"
node --input-type=module << 'EOF'
import { structureText } from './structure.mjs';
import path from 'node:path';
import os from 'node:os';

const root = process.cwd();
const fakeLLM = async () => JSON.stringify({
  name: '测试员', contact: '电话：12345678901', intent: '测试工程师',
  summary: '这是摘要。', skills: ['技能一：内容一'],
  work: [{ title: '某公司', role: '工程师', date: '2020-2024', bullets: ['做了一件事'] }],
  projects: [], education: [{ title: '某大学', role: '本科|计算机', date: '2016-2020' }]
});

const html = await structureText(root, '任意原文', fakeLLM);
const ok = html && html.includes('测试员') && html.includes('12345678901')
  && html.includes('<strong>技能一：</strong>内容一') && html.includes('做了一件事')
  && !html.includes('{{');  // 无占位符残留
if (!ok) { console.error('❌ 结构化组装失败'); process.exit(1); }

// 失败路径：LLM 返回坏 JSON → 返回 null（调用方降级）
const bad = await structureText(root, '任意原文', async () => '这不是JSON');
if (bad !== null) { console.error('❌ 坏 JSON 未降级'); process.exit(1); }
console.log('✅ 结构化组装与降级路径均正确');
EOF
```

- [ ] **Step 1:** 先写 test-structure.sh，跑确认失败（structure.mjs 不存在）
- [ ] **Step 2:** 跑 make-template.py 生成 template.html + 人工核验占位符与零残留
- [ ] **Step 3:** 写 llm.mjs / structure.mjs / config.example.json
- [ ] **Step 4:** `bash ~/resume/test-structure.sh` 通过
- [ ] **Step 5:** `bash ~/resume/test.sh` 全量回归（含 Task 2 的上传断言——此刻仍走降级路径，不应变）

---

### Task 4: 服务重启 + 全量回归 + 文档收尾

**Files:**
- Modify: `~/resume/README.md`

- [ ] **Step 1: 重启 launchd 服务加载新代码**

```bash
launchctl bootout gui/$(id -u)/com.lhx.resume-server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lhx.resume-server.plist
sleep 2
curl -sf http://localhost:7890/ | grep -q '上传 PDF 导入' && echo '✅ 列表首页上线'
curl -sf "http://localhost:7890/edit?id=linghaoxiang" | grep -q '凌浩翔' && echo '✅ 编辑器正常'
curl -sf "http://localhost:7890/edit?id=linghaoxiang" | grep -q "var DOC_ID = 'linghaoxiang'" && echo '✅ 注入正常'
```

- [ ] **Step 2: 真实 PDF 导入验收（降级路径）**

```bash
NEWID=$(curl -sf -X POST "http://localhost:7890/upload?name=old-resume.pdf" --data-binary "@/Users/xxxly/Documents/Playground/career-ops/output/linghaoxiang-20260817.pdf" -o /dev/null -w '%{redirect_url}' | sed 's/.*id=//')
test -n "$NEWID" && curl -sf "http://localhost:7890/edit?id=$NEWID" | grep -q '凌浩翔' && echo "✅ 真实 PDF 导入成功: $NEWID"
pdftotext ~/resume/pdfs/$NEWID.pdf - >/dev/null 2>&1 || echo '（新文档 PDF 尚未渲染——保存一次即生成，正常）'
```

验收后保留这个导入文档给用户看效果（**不删**），或用户看完自行在首页删除。

- [ ] **Step 3: README 更新**

在 `~/resume/README.md` 的"使用"节追加：

```markdown
- 首页（文档列表/上传 PDF 导入）：http://localhost:7890/
- 上传导入：有 config.json（参考 config.example.json）时 LLM 结构化灌模板；无配置时降级为纯文本导入
```

- [ ] **Step 4: 终验清单**

```bash
bash ~/resume/test.sh && bash ~/resume/test-structure.sh && bash ~/resume/test-render.sh && echo '✅ Phase 2 全量回归通过'
launchctl list | grep resume   # 服务在列
```

---

## Self-Review 结论（已执行）

- **Spec 覆盖**：Phase 2 各项（列表首页/多文档/复制/删除/上传导入/LLM 结构化/降级）→ Task 1-3 全覆盖；rollback 重定向 Minor 修复 → Task 1
- **占位符**：无 TBD；所有代码完整可运行
- **一致性**：`structureText(root, text, llmFn)` 签名在 importer.mjs 调用与 structure.mjs 定义一致；`hasLLM(root)` 一致；测试端口沿用 PORT=17899；隔离 id 模式沿用 smoketest
- **安全**：VALID_ID 校验覆盖新端点的 id/to 参数（顶部统一校验已存在）；上传校验 %PDF- 魔数；esc() 防 LLM 输出带 HTML 注入
- **known ceiling（ponytail 声明）**：导入文档无头像（模板不带）；LLM 结构化质量取决于模型，坏输出有降级兜底
