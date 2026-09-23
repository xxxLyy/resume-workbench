# 简历平台 Phase 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `~/resume/` 简历平台核心：本地服务直写保存（根除存错位置）、保存即快照可回滚、保存即自动出 PDF、launchd 开机自启（重启零操作），并迁移现有简历。

**Architecture:** 单进程 Node 服务（零 npm 框架，仅 playwright-core 一个渲染依赖）+ 文件系统即数据库（docs/snapshots/pdfs 三个目录）+ launchd 常驻。渲染复用系统已缓存的 Chromium。

**Tech Stack:** Node 24（内置 http/fs/child_process）、playwright-core@1.60.0（pin 死，匹配已缓存的 chromium-1161）、launchd、bash 冒烟测试。

**Spec:** `docs/superpowers/specs/2026-08-17-resume-platform-design.md`（本计划只覆盖 Phase 1）

**约束:**
- 本工作区非 git 仓库，**不执行任何 git 提交**（用户全局规则）；版本历史由快照机制承担
- 代码遵循 ponytail 原则：最简可用、标准库优先、零多余抽象
- Phase 1 只有一份文档（id 固定 `linghaoxiang`），`GET /` 直接是编辑器；文档列表首页属 Phase 2

---

### Task 1: 工作区骨架与渲染依赖

**Files:**
- Create: `~/resume/package.json`

- [ ] **Step 1: 建目录结构**

```bash
mkdir -p ~/resume/docs ~/resume/snapshots ~/resume/pdfs
```

- [ ] **Step 2: 初始化 package.json 并 pin 安装 playwright-core（版本必须匹配已缓存浏览器）**

```bash
cd ~/resume && npm init -y && npm i playwright-core@1.60.0
```

Expected: `added 2 packages`；`node_modules/playwright-core` 存在。

- [ ] **Step 3: 验证 Chromium 缓存可发现**

```bash
find "$HOME/Library/Caches/ms-playwright" -name "Chromium" -path "*chrome-mac*" | head -1
```

Expected 输出: `/Users/xxxly/Library/Caches/ms-playwright/chromium-1161/chrome-mac/Chromium.app/Contents/MacOS/Chromium`

---

### Task 2: render.mjs（HTML → PDF）

**Files:**
- Create: `~/resume/render.mjs`
- Test: `~/resume/test-render.sh`

- [ ] **Step 1: 写失败测试**

Create `~/resume/test-render.sh`:

```bash
#!/bin/bash
# test-render.sh — 渲染冒烟：渲染指定 HTML，断言 PDF 存在且含正文
set -e
cd "$(dirname "$0")"
cp /Users/xxxly/Documents/Playground/career-ops/output/linghaoxiang-resume-edit-20260814.html docs/linghaoxiang.html
node render.mjs linghaoxiang
test -s pdfs/linghaoxiang.pdf || { echo '❌ PDF 未生成'; exit 1; }
pdftotext pdfs/linghaoxiang.pdf - | grep -q '凌浩翔' && echo '✅ 渲染冒烟通过'
```

- [ ] **Step 2: 跑测试确认失败**

```bash
chmod +x ~/resume/test-render.sh && bash ~/resume/test-render.sh
```

Expected: FAIL — `node: cannot find module render.mjs`

- [ ] **Step 3: 写 render.mjs**

Create `~/resume/render.mjs`:

```js
// render.mjs — HTML → PDF（playwright-core + 系统缓存 Chromium，零浏览器下载）
// 用法: node render.mjs <docId>
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const id = process.argv[2] || 'linghaoxiang';
const root = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(root, 'docs', `${id}.html`), 'utf8');
// ATS 兼容：智能引号转直引号（与 career-ops generate-pdf.mjs 行为一致）
const normalized = html.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

const chromiumPath = execSync(
  // 注意：不能找 "Chromium" 主程序——缓存里的 chromium-1161（Chromium 134）在 macOS 15.4+ 有
  // CoreText 文本层丢失 bug（PDF 提取不出文字）。chromium_headless_shell-1223 是
  // playwright-core 1.60.0 的 browsers.json 期望修订号，实测正常。
  // 升级 playwright-core 时必须同步改此路径（看其 browsers.json 的期望修订号）。
  'find "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1223" -name "chrome-headless-shell" | head -1',
  { shell: '/bin/bash' }
).toString().trim();

const browser = await chromium.launch({ executablePath: chromiumPath });
const page = await browser.newPage();
await page.setContent(normalized, { waitUntil: 'load' });
await page.waitForTimeout(500); // 等分页线 JS 与字体稳定
await page.pdf({
  path: path.join(root, 'pdfs', `${id}.pdf`),
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true
});
await browser.close();
console.log('rendered:', id);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
bash ~/resume/test-render.sh
```

Expected: `✅ 渲染冒烟通过`

---

### Task 3: server.mjs（保存/快照/回滚/PDF/端口顺延）

**Files:**
- Create: `~/resume/server.mjs`
- Test: `~/resume/test.sh`

- [ ] **Step 1: 先写冒烟测试（此刻应失败）**

Create `~/resume/test.sh`:

```bash
#!/bin/bash
# test.sh — Phase 1 冒烟：编辑器可达 / 保存落盘 / 快照生成 / PDF 含标记 / 回滚生效
set -e
cd "$(dirname "$0")"
command -v pdftotext >/dev/null || { echo '需要 poppler: brew install poppler'; exit 1; }
export PORT=${PORT:-17899}
cp docs/linghaoxiang.html docs/smoketest.html   # 测试隔离：不碰真实简历
node server.mjs & SRV=$!
trap "kill $SRV 2>/dev/null || true; rm -rf docs/smoketest.html snapshots/smoketest pdfs/smoketest.pdf" EXIT
curl --retry 5 --retry-delay 0 --retry-connrefused -sf "http://localhost:$PORT/" -o /dev/null  # 等服务就绪

# 1. 编辑器可达
curl -sf "http://localhost:$PORT/" | grep -q 'contenteditable' && echo '✅ 编辑器页面'

# 2. 保存（注入测试标记）→ 落盘 + 快照 + PDF
MARK="链路测试$(date +%s)"
python3 - "$MARK" << 'PYEOF'
import os, sys, urllib.request
html = open('docs/smoketest.html').read()
marked = html.replace('</body>', f'<p>{sys.argv[1]}</p></body>')
url = f"http://localhost:{os.environ['PORT']}/save?id=smoketest"
req = urllib.request.Request(url, data=marked.encode(), headers={'Content-Type': 'text/html'})
print('save 响应:', urllib.request.urlopen(req).read().decode())
PYEOF
grep -q "$MARK" docs/smoketest.html && echo '✅ 保存落盘'
test "$(ls snapshots/smoketest/ | wc -l)" -ge 1 && echo '✅ 快照生成'
pdftotext pdfs/smoketest.pdf - | grep -q "$MARK" && echo '✅ PDF 含标记'

# 3. 回滚到保存前的快照（保存时的快照是"改动前"版本；隔离环境下只有一份）
TS=$(ls snapshots/smoketest/ | sort | head -1 | sed 's/\.html//')
curl -sf -X POST "http://localhost:$PORT/rollback?id=smoketest&ts=$TS" -o /dev/null
if grep -q "$MARK" docs/smoketest.html; then echo '❌ 回滚后标记仍在'; exit 1; else echo '✅ 回滚生效'; fi
echo '全部通过'
```

- [ ] **Step 2: 跑测试确认失败**

```bash
chmod +x ~/resume/test.sh && bash ~/resume/test.sh
```

Expected: FAIL — `curl: couldn't connect to server`（server.mjs 尚不存在）

- [ ] **Step 3: 写 server.mjs**

Create `~/resume/server.mjs`:

```js
// server.mjs — 简历平台服务（Node 内置模块，零框架）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(root, d), { recursive: true });

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SNAPSHOTS = 50;
const docPath = (id) => path.join(root, 'docs', id + '.html');
const pdfPath = (id) => path.join(root, 'pdfs', id + '.pdf');
const snapDir = (id) => path.join(root, 'snapshots', id);

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 保存"当前磁盘版本"为快照（在覆盖前调用）
function snapshot(id) {
  if (!fs.existsSync(docPath(id))) return;
  const dir = snapDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(docPath(id), path.join(dir, timestamp() + '.html'));
  const files = fs.readdirSync(dir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_SNAPSHOTS))) fs.unlinkSync(path.join(dir, f));
}

function render(id) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(root, 'render.mjs'), id], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function page(title, inner) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:"PingFang SC",sans-serif;max-width:720px;margin:40px auto;padding:0 16px;font-size:14px}
a{color:#2563eb}li{margin:6px 0}button{cursor:pointer}</style></head><body>${inner}</body></html>`;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const id = url.searchParams.get('id') || 'linghaoxiang';
  if (!VALID_ID.test(id)) return send(400, 'invalid id', 'text/plain');
  const send = (code, body, type = 'text/html; charset=utf-8') => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': type });
    res.end(body);
  };
  try {
    // 编辑器（Phase 1 单文档：GET / 即编辑器）
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/edit')) {
      if (!fs.existsSync(docPath(id))) return send(404, page('404', `<h1>文档不存在: ${id}</h1>`));
      return send(200, fs.readFileSync(docPath(id), 'utf8'));
    }
    // 保存：快照旧版 → 原子写新版 → 渲染 PDF
    if (req.method === 'POST' && url.pathname === '/save') {
      const html = await readBody(req);
      snapshot(id);
      const tmp = docPath(id) + '.tmp';
      fs.writeFileSync(tmp, html);
      fs.renameSync(tmp, docPath(id));
      const pdfOk = await render(id);
      return send(200, JSON.stringify({ ok: true, pdf: pdfOk }), 'application/json');
    }
    // 下载 PDF
    if (req.method === 'GET' && url.pathname === '/pdf') {
      if (!fs.existsSync(pdfPath(id))) await render(id);
      if (!fs.existsSync(pdfPath(id))) return send(500, 'render failed', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${id}.pdf"` });
      return fs.createReadStream(pdfPath(id)).on('error', () => res.destroy()).pipe(res);
    }
    // 快照列表
    if (req.method === 'GET' && url.pathname === '/snapshots') {
      const dir = snapDir(id);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse() : [];
      const items = files.map((f) => {
        const ts = f.replace('.html', '');
        return `<li>${ts} <form method="post" action="/rollback?id=${id}&ts=${ts}" style="display:inline" onsubmit="return confirm('回滚到 ${ts}？当前版本会先自动留一份快照')"><button>回滚到此版</button></form></li>`;
      }).join('');
      return send(200, page('历史版本', `<h1>历史版本</h1><p><a href="/">← 返回编辑</a></p><ul>${items || '<li>暂无快照</li>'}</ul>`));
    }
    // 回滚（先快照当前版，可再回滚回来）
    if (req.method === 'POST' && url.pathname === '/rollback') {
      const ts = url.searchParams.get('ts') || '';
      const snap = path.join(snapDir(id), path.basename(ts) + '.html');
      if (!fs.existsSync(snap)) return send(404, 'snapshot not found', 'text/plain');
      snapshot(id);
      fs.copyFileSync(snap, docPath(id));
      await render(id);
      res.writeHead(303, { Location: '/' });
      return res.end();
    }
    send(404, 'not found', 'text/plain');
  } catch (e) {
    send(500, 'server error: ' + e.message, 'text/plain');
  }
}

// 端口：env PORT 优先（测试用），否则 7890→7891→7892 顺延
const PORTS = process.env.PORT ? [Number(process.env.PORT)] : [7890, 7891, 7892];
function tryListen(i) {
  const s = http.createServer(handler);
  s.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && i < PORTS.length - 1) return tryListen(i + 1);
    console.error('端口不可用:', e.message);
    process.exit(1);
  });
  s.listen(PORTS[i], '127.0.0.1', () => console.log(`简历平台: http://localhost:${PORTS[i]}`));
}
tryListen(0);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
bash ~/resume/test.sh
```

Expected 输出（五行全绿）:
```
✅ 编辑器页面
✅ 保存落盘
✅ 快照生成
✅ PDF 含标记
✅ 回滚生效
全部通过
```

---

### Task 4: 编辑器迁移（file:// 流程 → 服务流程）

**Files:**
- Modify: `~/resume/docs/linghaoxiang.html`（由 Task 2 测试拷入，本任务改造其工具栏与脚本）
- Create: `~/resume/migrate-editor.py`

- [ ] **Step 1: 写迁移脚本**

Create `~/resume/migrate-editor.py`（一次性工具，跑完即弃）:

```python
#!/usr/bin/env python3
"""migrate-editor.py — 把 file:// 版编辑器的保存逻辑替换为服务版（一次性）"""
import re, pathlib

p = pathlib.Path.home() / 'resume/docs/linghaoxiang.html'
c = p.read_text()

TOOLBAR = '''  <div class="edit-toolbar">
    <span>✏️ 点击正文直接编辑</span>
    <button id="saveBtn">💾 保存</button>
    <button id="pdfBtn" class="secondary">📄 下载 PDF</button>
    <button id="histBtn" class="secondary">🕘 历史版本</button>
  </div>'''

SCRIPT = '''<script>
(function () {
  var DOC_ID = 'linghaoxiang';
  var sheet = document.querySelector('.sheet');
  sheet.contentEditable = 'true';

  // A4 分页参考线（仅屏幕显示，PDF 中隐藏；数量随内容高度自适应）
  var MM = 3.7795275591;
  function updatePageLines() {
    sheet.querySelectorAll('.page-line').forEach(function (el) { el.remove(); });
    var needed = Math.min(3, Math.max(1, Math.ceil(sheet.scrollHeight / (297 * MM))));
    for (var i = 1; i <= needed; i++) {
      var line = document.createElement('div');
      line.className = 'page-line';
      line.style.top = (297 * i) + 'mm';
      line.contentEditable = 'false';
      line.innerHTML = '<span>第' + i + '页末 (A4)</span>';
      sheet.appendChild(line);
    }
  }
  updatePageLines();

  // 本地自动保存兜底（服务未响应时不丢内容）
  var STORE_KEY = 'resume-autosave:' + DOC_ID;
  var lineTimer;
  sheet.addEventListener('input', function () {
    clearTimeout(lineTimer);
    lineTimer = setTimeout(function () {
      updatePageLines();
      try { localStorage.setItem(STORE_KEY, sheet.innerHTML); } catch (e) {}
    }, 300);
  });
  var localVer = null;
  try { localVer = localStorage.getItem(STORE_KEY); } catch (e) {}
  if (localVer && localVer !== sheet.innerHTML) {
    var bar = document.createElement('div');
    bar.className = 'recovery-bar';
    var msg = document.createElement('span');
    msg.textContent = '⚠️ 浏览器里有一份未保存到服务器的修改';
    bar.appendChild(msg);
    var btnYes = document.createElement('button');
    btnYes.textContent = '恢复这份修改';
    btnYes.onclick = function () {
      sheet.innerHTML = localVer;
      updatePageLines();
      toast('已恢复，请点"保存"写入服务器');
      bar.remove();
    };
    var btnNo = document.createElement('button');
    btnNo.textContent = '丢弃';
    btnNo.className = 'secondary';
    btnNo.onclick = function () {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      bar.remove();
    };
    bar.appendChild(btnYes);
    bar.appendChild(btnNo);
    document.body.appendChild(bar);
  }

  // 粘贴强制纯文本
  sheet.addEventListener('paste', function (e) {
    e.preventDefault();
    var t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; });
    setTimeout(function () {
      t.style.opacity = '0';
      setTimeout(function () { t.remove(); }, 400);
    }, 2500);
  }

  document.getElementById('saveBtn').addEventListener('click', async function () {
    try {
      var r = await fetch('/save?id=' + DOC_ID, {
        method: 'POST',
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: '<!doctype html>\\n' + document.documentElement.outerHTML
      });
      var data = await r.json();
      if (data.ok) {
        try { localStorage.removeItem(STORE_KEY); } catch (e) {}
        toast(data.pdf ? '✅ 已保存，PDF 已更新' : '✅ 已保存（PDF 渲染失败，见 /tmp/resume-server.log）');
      } else {
        toast('❌ 保存失败');
      }
    } catch (e) {
      toast('⚠️ 服务未运行：内容已存浏览器本地，下次打开会提示恢复');
    }
  });
  document.getElementById('pdfBtn').addEventListener('click', function () { location.href = '/pdf?id=' + DOC_ID; });
  document.getElementById('histBtn').addEventListener('click', function () { location.href = '/snapshots?id=' + DOC_ID; });
})();
</script>'''

# 替换工具栏（无嵌套 div，非贪婪安全）
c, n1 = re.subn(r'  <div class="edit-toolbar">.*?</div>', lambda _: TOOLBAR, c, count=1, flags=re.S)
# 替换脚本块（全文仅一个 <script>）
c, n2 = re.subn(r'<script>.*?</script>', lambda _: SCRIPT, c, count=1, flags=re.S)
assert n1 == 1 and n2 == 1, f'替换失败: toolbar={n1} script={n2}'
p.write_text(c)
print('✅ 编辑器迁移完成: toolbar=1 script=1')
```

- [ ] **Step 2: 跑迁移 + 断言**

```bash
python3 ~/resume/migrate-editor.py && curl -sf http://localhost:7899/ >/dev/null 2>&1; grep -c "fetch('/save" ~/resume/docs/linghaoxiang.html && grep -c "showSaveFilePicker" ~/resume/docs/linghaoxiang.html || echo '✅ 旧弹窗逻辑已清除'
```

Expected: `1`（fetch 存在）→ `✅ 旧弹窗逻辑已清除`（showSaveFilePicker 为 0）

- [ ] **Step 3: 完整冒烟回归**

```bash
bash ~/resume/test.sh
```

Expected: 五项全绿 + `全部通过`

---

### Task 5: launchd 常驻（开机自启）

**Files:**
- Create: `~/Library/LaunchAgents/com.lhx.resume-server.plist`

- [ ] **Step 1: 写 plist**

Create `~/Library/LaunchAgents/com.lhx.resume-server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lhx.resume-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/xxxly/resume/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/resume-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/resume-server.log</string>
</dict>
</plist>
```

- [ ] **Step 2: 加载并验证**

```bash
launchctl bootout gui/$(id -u)/com.lhx.resume-server 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lhx.resume-server.plist
sleep 2
curl -sf http://localhost:7890/ | grep -q '凌浩翔' && echo '✅ 服务已自启'
```

Expected: `✅ 服务已自启`

- [ ] **Step 3: 模拟重启（unload/load）再验证**

```bash
launchctl bootout gui/$(id -u)/com.lhx.resume-server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lhx.resume-server.plist
sleep 2
curl -sf http://localhost:7890/ | grep -q '凌浩翔' && echo '✅ 重启后服务自愈'
```

Expected: `✅ 重启后服务自愈`

---

### Task 6: 旧机制清理 + 端到端验收

**Files:**
- Modify: `~/.zshrc`（删除旧 watcher 启动块）

- [ ] **Step 1: 停掉并移除旧 watcher**

```bash
pkill -f resume-pdf-watch.sh || true
python3 - << 'EOF'
import pathlib, re
p = pathlib.Path.home() / '.zshrc'
c = p.read_text()
c2 = re.sub(r'\n# 简历 PDF 自动同步.*?\nfi\n', '\n', c, flags=re.S)
assert c2 != c, '未找到 watcher 块'
p.write_text(c2)
print('✅ .zshrc 旧 watcher 块已移除')
EOF
```

Expected: `✅ .zshrc 旧 watcher 块已移除`（若报 assert 失败：人工检查 .zshrc 尾部该块并手动删除）

- [ ] **Step 2: 端到端验收（走真实服务 7890）**

```bash
MARK="验收$(date +%s)"
python3 - "$MARK" << 'PYEOF'
import sys, urllib.request
html = open('/Users/xxxly/resume/docs/linghaoxiang.html').read()
marked = html.replace('</body>', f'<p>{sys.argv[1]}</p></body>')
req = urllib.request.Request('http://localhost:7890/save?id=linghaoxiang',
                             data=marked.encode(), headers={'Content-Type': 'text/html'})
print('save:', urllib.request.urlopen(req).read().decode())
PYEOF
pdftotext ~/resume/pdfs/linghaoxiang.pdf - | grep -q "$MARK" && echo '✅ PDF 自动更新'
TS=$(ls ~/resume/snapshots/linghaoxiang/ | sort | head -1 | sed 's/\.html//')
curl -sf -X POST "http://localhost:7890/rollback?id=linghaoxiang&ts=$TS" -o /dev/null
grep -q "$MARK" ~/resume/docs/linghaoxiang.html && { echo '❌ 回滚失败'; exit 1; } || echo '✅ 验收通过，标记已回滚'
```

Expected: `✅ PDF 自动更新` + `✅ 验收通过，标记已回滚`

- [ ] **Step 3: 交付用户手动确认**

```bash
open http://localhost:7890/
```

请用户在浏览器里：改一个字 → 点保存 → 看到"已保存，PDF 已更新"→ 点"下载 PDF"能打开最新版 → 点"历史版本"能看到快照列表。

---

## Self-Review 结论（已执行）

- **Spec 覆盖**：Phase 1 各项（~/resume 落地 / 直写保存 / 快照 / 回滚 / 渲染 / launchd / 迁移 / .zshrc 清理）→ Task 1-6 全覆盖；端口顺延 → Task 3 server.mjs 末尾；plist PATH → Task 5 Step 1
- **占位符**：无 TBD/TODO，所有代码块为完整可运行内容
- **一致性**：端点参数 `id`/`ts` 全文一致；`DOC_ID='linghaoxiang'` 在 server 默认值与编辑器一致；快照语义=「覆盖前的旧版」，test.sh 与 server.mjs 一致
- **TDD**：Task 2/3 均先写测试、跑出失败、再实现、跑出通过
