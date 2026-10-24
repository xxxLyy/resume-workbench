# 历史兼容、最终验收与交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 C1 验证当前及两种历史主脚本仍可真实保存且拒绝未知脚本；用 D1 证明完整加固通过严格四套件、冻结件未变、真实数据未被写入，并如实完成发布与文档交接。

**Architecture:** 将已经受支持的历史主脚本作为脱敏静态夹具保存，复用现有 test-editor 的隔离浏览器流程。最终只调用现有 test:all，显式接入新增回归，不扫描目录自动找测试，不新增 runner；真实服务发布阶段只做读取检查，写操作留在隔离实例。

**Tech Stack:** Node.js ESM、Git、原生 assert/crypto/child_process、现有 playwright-core、Bash、launchd、已有四套测试。

---

## 前置、所有权与完成层级

- 批准设计：[2026-10-24-reliability-hardening-design.md](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md)，重点第 7.3–7.4 节和第 8 节。
- 必须先完成：[验证基础计划](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-validation-plan.md)；区域、任务、来源与资源各包的接口和反例也须已集成。
- 独立夹具 owner 只负责新增静态夹具；`test-editor.mjs` 和 `test-structure.sh` 的接入只由验证 owner 串行完成。`server.mjs` 始终由服务端集成 owner 管理，本计划不另设并行编辑者。
- Create: `/Users/xxxly/resume/test-fixtures/reliability/editor-scripts/0c3fed0.js`。
- Create: `/Users/xxxly/resume/test-fixtures/reliability/editor-scripts/72cd098.js`。
- Create: `/Users/xxxly/resume/test-fixtures/reliability/editor-scripts/manifest.json`。
- Modify: `/Users/xxxly/resume/test-editor.mjs`：C1 当前/历史主脚本正例与故意移除放行 hash 的反例。
- Modify: `/Users/xxxly/resume/test-structure.sh`：显式接入各包已经创建的回归脚本，接入列表由验证 owner 维护一次。
- Modify: `/Users/xxxly/resume/README.md`、`dev-docs/handoff.md`、`dev-docs/2026-09-23-roadmap-magazine-and-features.md`。
- Create after acceptance: `/Users/xxxly/resume/dev-docs/2026-10-24-reliability-acceptance.md`，只记实际结果和限制。
- 不修改 `template.html`、`themes/`、`render.mjs`；不扩大 CSP 白名单，不为旧文档发起迁移，不读真实配置或使用真实模型。
- 结论分四层：代码完成、隔离验证通过、真实服务已生效、真实模型质量。前三者不能推导最后一项。

## Task DEL-01：固化历史主脚本，测试不依赖 Git 历史

**Owner:** 夹具 owner；无共享测试文件编辑权。覆盖 C1 的夹具准备。

- [ ] **Step 1：确认当前白名单声明的两种规范化 hash，与批准设计一致。**

仅查看 `server.mjs` 中 `EDITOR_SCRIPT_HASHES`；若实现期间该清单被别人更改，暂停本任务与集成 owner 对齐，不把新内容自动认成已批准支持范围。

已批准基线：

| Git 版本 | 规范化主脚本 sha256/base64 |
|---|---|
| `0c3fed0` | `7dwc1dIu5F63H9JhH0TVbYzH9xrpWfPtT5OLVxbPFAY=` |
| `72cd098` | `n0YyHsUh6KVazqH4o/zf7MI0FX8u8DIS67soPeUsp20=` |

- [ ] **Step 2：执行一次生成命令，仅从受版本管理的模板抽取脚本，不打开 docs 或 config。**

```bash
cd /Users/xxxly/resume
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const output = path.resolve('test-fixtures/reliability/editor-scripts');
const versions = [
  { revision: '0c3fed0', normalizedSha256: '7dwc1dIu5F63H9JhH0TVbYzH9xrpWfPtT5OLVxbPFAY=' },
  { revision: '72cd098', normalizedSha256: 'n0YyHsUh6KVazqH4o/zf7MI0FX8u8DIS67soPeUsp20=' }
];
const norm = (s) => s.replace(/var DOC_ID = '[^']*';/, "var DOC_ID = '{{DOC_ID}}';");
const digest = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
fs.mkdirSync(output, { recursive: true });
for (const v of versions) {
  const html = execFileSync('git', ['show', v.revision + ':template.html'], { encoding: 'utf8' });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, '历史模板主脚本数变化: ' + v.revision);
  const script = scripts[0][1];
  assert(/var DOC_ID = '[^']*';/.test(script), '缺 DOC_ID 声明');
  assert.equal(digest(norm(script)), v.normalizedSha256, '来源与白名单不一致');
  v.file = v.revision + '.js';
  v.rawSha256 = digest(script);
  fs.writeFileSync(path.join(output, v.file), script, 'utf8');
}
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('✅ C1 两份历史主脚本已逐字节固化');
NODE
```

Expected: exit 0；两种不同 normalized hash，生成文件只包含主脚本代码。不能格式化、加文件头、换行转换或清理旧脚本；虚拟文档组装时只允许替换 DOC_ID 值，并验证 normalized hash 不变。缺 Git 提交或 hash 不符必须阻断，不能拿当前脚本冒充历史脚本。

- [ ] **Step 3：读取新增脚本确认不含个人文档内容，再提交。**

```bash
git add test-fixtures/reliability/editor-scripts
git commit -m "test: preserve supported historical editor scripts as synthetic fixtures"
```

这里固化的是旧主脚本，不声称覆盖所有曾经存在的完整历史模板形态；原 legacy DOM/样式兼容用例仍保留。

## Task DEL-02：CSP 必须同时证明“拒绝未知脚本”和“主脚本能保存”

**Owner:** 验证 owner，独占 `test-editor.mjs`。覆盖 C1；依赖 DEL-01。

- [ ] **Step 1：在 test-editor.mjs 的浏览器夹具初始化处准备三个正例及一个否定对照。**

使用虚拟正文和现有 `assembleTemplate('classic')`，不复制真实简历：

```js
const cspDir = path.join(APP_ROOT, 'test-fixtures', 'reliability', 'editor-scripts');
const cspVersions = JSON.parse(fs.readFileSync(path.join(cspDir, 'manifest.json'), 'utf8'));
const cspNorm = (s) => s.replace(/var DOC_ID = '[^']*';/, "var DOC_ID = '{{DOC_ID}}';");
const cspDigest = (s) => createHash('sha256').update(s, 'utf8').digest('base64');
const cspCases = [{ id: 'ed-csp-current', script: null }];
for (const v of cspVersions) {
  const script = fs.readFileSync(path.join(cspDir, v.file), 'utf8');
  if (cspDigest(script) !== v.rawSha256 || cspDigest(cspNorm(script)) !== v.normalizedSha256) {
    throw new Error('CSP 历史夹具字节漂移: ' + v.file);
  }
  cspCases.push({ id: 'ed-csp-' + v.revision, script, hash: v.normalizedSha256 });
}
function cspFixture(id, historicalScript) {
  let html = assembleTemplate('classic');
  const values = {
    NAME: '虚拟候选人', CONTACT: 'candidate@example.invalid', INTENT: '隔离测试',
    SUMMARY: 'CSP_SAVE_BASE', SKILLS: '<p>虚拟技能</p>',
    WORK: '', PROJECTS: '', EDU: '', DOC_ID: id
  };
  for (const [key, value] of Object.entries(values)) {
    html = html.replaceAll('{{' + key + '}}', () => value);
  }
  if (historicalScript !== null) {
    const code = historicalScript.replace(/var DOC_ID = '[^']*';/, () => "var DOC_ID = '" + id + "';");
    if (cspDigest(cspNorm(code)) !== cspDigest(cspNorm(historicalScript))) {
      throw new Error('替换 DOC_ID 改坏历史主脚本');
    }
    html = html.replace(/<script>[\s\S]*?<\/script>/, () => '<script>' + code + '</script>');
  }
  return html.replace('</body>',
    '<script>window.__CSP_CANARY__ = 1;</script></body>');
}
for (const c of cspCases) {
  fs.writeFileSync(path.join(dataRoot, 'docs', c.id + '.html'), cspFixture(c.id, c.script));
}
fs.writeFileSync(path.join(dataRoot, 'docs', 'ed-csp-blocked.html'),
  cspFixture('ed-csp-blocked', null));
```

不要把待测函数的 hash 识别结果直接当预期值；manifest 的固定值来自已批准的支持列表。

- [ ] **Step 2：替换只有 .sheet 存在的最终结论，加入实际保存行为函数。**

将函数放在浏览器已启动后的作用域，复用现有 `browser/base/dataRoot`：

```js
async function exerciseCspSave(id, marker, stripMainHashes = false) {
  const ctx = await browser.newContext({ viewport: { width: 1450, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  try {
    if (stripMainHashes) {
      await page.route('**/edit?id=' + id, async (route) => {
        const response = await route.fetch();
        const headers = { ...response.headers() };
        const csp = headers['content-security-policy'];
        if (!csp) throw new Error('CSP_HEADER_MISSING');
        headers['content-security-policy'] = csp.replace(/'sha256-[^']+'/g, '');
        await route.fulfill({ response, headers });
      });
    }
    const response = await page.goto(base + '/edit?id=' + id);
    const csp = response.headers()['content-security-policy'] || '';
    const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src '));
    if (!scriptSrc || scriptSrc.includes("'unsafe-inline'")) {
      throw new Error('CSP_HEADER_INVALID');
    }
    await page.waitForSelector('.sheet .summary', { timeout: 10000 });
    if (await page.evaluate(() => window.__CSP_CANARY__ === 1)) throw new Error('CSP_CANARY_EXECUTED');
    await page.click('.sheet .summary');
    await page.keyboard.press('End');
    await page.keyboard.type(marker);
    const saved = page.waitForResponse((r) => {
      const u = new URL(r.url());
      return r.request().method() === 'POST' && u.pathname === '/save'
        && u.searchParams.get('id') === id;
    }, { timeout: stripMainHashes ? 1200 : 12000 }).catch(() => null);
    await page.click('#saveBtn');
    const saveResponse = await saved;
    if (!saveResponse) throw new Error('CSP_MAIN_SAVE_NOT_RUNNING');
    const result = await saveResponse.json();
    if (!saveResponse.ok() || !result.ok) throw new Error('CSP_SAVE_REJECTED');
    await page.waitForFunction(
      () => document.getElementById('saveState')?.dataset.state === 'saved',
      undefined,
      { timeout: 12000 }
    );
    const disk = fs.readFileSync(path.join(dataRoot, 'docs', id + '.html'), 'utf8');
    if (!disk.includes(marker)) throw new Error('CSP_SAVE_NOT_ON_DISK');
    await page.reload();
    await page.waitForSelector('.sheet .summary', { timeout: 10000 });
    const after = await page.evaluate((m) => ({
      kept: document.querySelector('.sheet').textContent.includes(m),
      pwned: window.__CSP_CANARY__ === 1
    }), marker);
    if (!after.kept || after.pwned) throw new Error('CSP_RELOAD_FAILED');
    if (errors.length) throw new Error('CSP_PAGE_ERROR: ' + errors.join(' | '));
  } finally { await ctx.close(); }
}
```

Playwright 的 `waitForFunction` 选项使用第三个参数，不能把 timeout 当浏览器函数参数。整个函数不调用 `__edSaveManual`、不直接 fetch 保存、不补按钮监听器；使用真实主脚本绑定的按钮证明其运行。

- [ ] **Step 3：加入一个断言本身必须能失败的否定对照，再跑三个正例。**

```js
let blockedReason = '';
try {
  await exerciseCspSave('ed-csp-blocked', 'CSP_NEGATIVE_MARKER', true);
} catch (e) { blockedReason = String(e.message || e); }
const blockedDisk = fs.readFileSync(path.join(dataRoot, 'docs', 'ed-csp-blocked.html'), 'utf8');
if (blockedReason !== 'CSP_MAIN_SAVE_NOT_RUNNING' || blockedDisk.includes('CSP_NEGATIVE_MARKER')) {
  bad('[C1] 断言没有检出主脚本被禁止的夹具', blockedReason);
} else ok('[C1] 负对照：保留 sheet 但禁止主脚本时，真实保存检查失败');
for (const c of cspCases) {
  try {
    await exerciseCspSave(c.id, 'CSP_POSITIVE_' + c.id.replaceAll('-', '_'));
    ok('[C1] ' + c.id + ' 主保存→磁盘→刷新成功，未知脚本被拒绝');
  } catch (e) { bad('[C1] ' + c.id, String(e.message || e)); }
}
```

负对照只在 Playwright 接收到的测试响应中移除主脚本 hash，保留 nonce 和所有其他 CSP；不修改应用代码或白名单。它证明“.sheet 仍在”并不足以验证可保存。

- [ ] **Step 4：执行一次现有主套件验证接线。**

```bash
cd /Users/xxxly/resume
RESUME_TEST_STRICT=1 bash test.sh
```

Expected: exit 0；出现一个 C1 负对照通过、当前及两种历史主脚本实际保存通过。旧代码的纯 sheet 断言先前无法证明这件事，不声称旧基线必然存在历史 hash 缺失。任一正例失败都不能通过扩大白名单或自动格式化脚本消除。

- [ ] **Step 5：提交。**

```bash
git add test-editor.mjs test-fixtures/reliability/editor-scripts
git commit -m "test: verify CSP compatibility through real editor saves"
```

回退边界：可以撤回本任务新夹具接入，不放松应用 CSP。若某个已支持历史脚本不能保存，阻断发布并记录具体版本；不能删除该版本用例后声称兼容。

## Task DEL-03：完整接入、严格四套件和冻结件验证

**Owner:** 验证 owner。覆盖 D1；各业务包和 C1 完成后执行。

- [ ] **Step 1：逐项确认新增小回归已显式接入现有聚合，未重复调用。**

本包已知的接线位于 `test-structure.sh`，由验证 owner 添加一次：

```bash
node test-fixtures/reliability/test-harness.mjs exit
node test-fixtures/reliability/test-harness.mjs strict
node test-fixtures/reliability/test-harness.mjs lifecycle
node test-fixtures/reliability/test-zone-ops.mjs
node test-fixtures/reliability/test-gen-result.mjs
node --test test-fixtures/reliability/test-sources.mjs
node --test test-fixtures/reliability/test-resources.mjs
```

上面七条分别只接入一次；三个 harness 子命令执行不同分支，zone/gen 使用直接 Node，来源/资源使用 Node 内置 `--test`。本步骤逐条核对对应工作包计划，不能用 `find/glob` 自动执行文件，也不能因单独脚本通过就宣告交付。C1 已在 test-editor，test-editor 由 test.sh 调用；其余原测试不删减。

- [ ] **Step 2：确认冻结件相对批准代码基线零差异。**

```bash
cd /Users/xxxly/resume
git cat-file -e 627c2a8b81c2be333f0eaa493ee54da15ac63833^{commit}
git diff --exit-code 627c2a8b81c2be333f0eaa493ee54da15ac63833 -- template.html themes/ render.mjs
git status --short -- template.html themes/ render.mjs
```

Expected: 三条均成功，后两条无差异/状态输出。若冻结件已有用户独立修改，先与用户和 owner 对齐它的基线，不覆盖、不擅自重设基线。本轮实现不能通过修改冻结件让测试绿。

- [ ] **Step 3：准备同一轮证据目录，并用既有真实数据指纹函数做前后比较。只比较摘要，不输出原文或配置。**

```bash
REPORT_DIR="$PWD/logs/reliability-acceptance-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$REPORT_DIR"
touch "$REPORT_DIR/all.log"
GUARD_FILE=$(mktemp /tmp/resume-real-guard.XXXXXX)
sed -n '/^real_fp() {$/,/^}$/p' test.sh > "$GUARD_FILE"
test -s "$GUARD_FILE"
REAL_BEFORE=$(REAL_ROOT="$PWD" bash -c 'source "$1"; real_fp' bash "$GUARD_FILE")
if RESUME_TEST_STRICT=1 npm run test:all > "$REPORT_DIR/all.log" 2>&1; then
  ALL_RC=0
else
  ALL_RC=$?
fi
REAL_AFTER=$(REAL_ROOT="$PWD" bash -c 'source "$1"; real_fp' bash "$GUARD_FILE")
rm -f "$GUARD_FILE"
test "$REAL_BEFORE" = "$REAL_AFTER"
test "$ALL_RC" -eq 0
```

证据目录和 all.log 在 BEFORE 前已创建，因此现有函数对 logs 的列表保护不会被自身报告误触发。函数读取真实文件只为内存内摘要，不能打印/记录私有 JSON、简历正文或 API key。任何隐私检查失败只向用户报告文件位置与类别，不转贴疑似敏感行。

Expected: 聚合 exit 0、前后摘要相等；严格浏览器与冻结基线没有被跳过。读取日志确认四套件实际结束，记录各套件实际结果与用例编号，不引用旧交接中的 347/129 作为本轮数字。

- [ ] **Step 4：处理失败，保持真实结果。**

若失败：先保存失败编号与退出码，定位是否本轮引入；修改后只重跑相关检查，相关反例通过后再执行最终严格聚合。若是已有环境缺失，明确尚未验收；不能删除必需测试或把 strict 改回普通模式。

- [ ] **Step 5：填写验收记录。**

在 `dev-docs/2026-10-24-reliability-acceptance.md` 记录：实施提交、V1/V2、Z1–Z6、T1/T2、S1–S3、E1/E2、R1–R4、C1、D1 的实际测试落点和结果；严格命令及退出码；冻结件差异和真实摘要是否一致；证据日志目录；尚未运行项目。每行结果只能是实际通过、实际失败或明确未运行，不填推定通过。

该记录是对实际证据的摘录，原始日志放 git 忽略的本项目 logs 目录。不能将真实个人数据附在文档或提交中。

## Task DEL-04：真实服务生效，只做读取检查

**Owner:** 发布 owner；依赖 DEL-03 通过。此任务不产生真实简历写入、不使用真实模型。

- [ ] **Step 1：确认用户没有未保存编辑或在途 AI/渲染，查明服务身份。**

不能用“没有 TCP 连接”推断没有未保存编辑。通过当前用户状态/既有界面确认；无法确认时保留“隔离验收已完成、真实服务尚未更新”，仅澄清重启时机，不自行中断用户工作。

```bash
launchctl print gui/$(id -u)/com.lhx.resume-server | awk '/state =|pid =|last exit code =/'
```

Expected: 确认目标确为既有 resume 服务。不要查看设置页、输出进程完整环境或读取真实 config。若服务不存在，报告事实，不擅自新增 launchd 配置。

- [ ] **Step 2：在已授权的实施范围内重启既有服务。**

```bash
launchctl kickstart -k gui/$(id -u)/com.lhx.resume-server
launchctl print gui/$(id -u)/com.lhx.resume-server | awk '/state =|pid =|last exit code =/'
```

Expected: 服务 running，PID 与重启前不同；代码是否更新以已保存的实施提交与服务工作目录核对，不单凭 PID 推断版本。

- [ ] **Step 3：查该 PID 的实际监听端口，再读首页。**

使用 Step 2 返回的 PID，不按固定端口杀进程：

```bash
SERVICE_PID=$(launchctl print gui/$(id -u)/com.lhx.resume-server | awk '/^[[:space:]]*pid = / { print $3; exit }')
test -n "$SERVICE_PID"
lsof -a -p "$SERVICE_PID" -d cwd -Fn
lsof -a -nP -p "$SERVICE_PID" -iTCP -sTCP:LISTEN -Fn
git rev-parse HEAD
```

按输出确认工作目录为本项目、实施提交已保存，以及 7766/7767/7768 中实际端口，再在浏览器打开该服务首页，检查页面加载、导航和本轮可见文案，无未捕获异常。不将真实资料截图放进提交。

```bash
curl --fail --silent --show-error --output /dev/null http://127.0.0.1:7766/
```

若实际监听顺延端口，命令使用确认后的实际地址。此 curl 只读首页；不要把 `GET /pdf`、`/export`、`/snapshot/pdf` 或 `/job/changes` 当只读发布探针，它们可能渲染或改状态。保存、生成、导出与对抗性检查全部已经在隔离实例验证，不能在真实简历上重复。

- [ ] **Step 4：记录真实服务是否生效。**

确认读取检查通过后才写“已更新并生效”；无法确认、未重启或只完成隔离测试时按原样写明。真实模型质量仍标“本轮未验证”，不得通过真实用户模型配置做顺手连通测试。

## Task DEL-05：同步使用说明、当前状态与实施交接

**Owner:** 文档 owner。只在实际验收后修改，不能提前填写成功。

- [ ] **Step 1：修正 README 已过时的保存/PDF 表述，并写明严格入口。**

将开头替换为：

```markdown
本地简历编辑平台：浏览器编辑与保存 → 按需导出 PDF；岗位适配建议经过审阅后应用。
```

在测试说明中增加：

```markdown
- 开发回归：`npm test`。
- 完整交付验收：`RESUME_TEST_STRICT=1 npm run test:all`；浏览器环境或冻结基线缺失会阻断验收。
- 测试使用独立数据根、本轮端口与本轮子进程，不按端口清理其他服务；真实模型验证须单独授权。
```

不把内部凭证或测试控制协议写入产品界面说明，不改用户未要求的安装流程。

- [ ] **Step 2：在 handoff 最新章节回写本轮事实，并在开头给出最新章节入口。**

内容包含：六包实际交付边界、zoneOps 请求为未套候选 HTML、服务端安全子集、母版回执及在途 DOM 合并、任务拒绝不改旧结果、来源分级、实际工作释放资源、POST 不自动重发、V/C/D 证据、发布状态、已接受限制。保留历史章节，只标清它们是旧快照。

不得把旧的“CSP 已修”当作本轮新增修复；本轮增加的是历史主脚本的行为兼容证明。不得把本轮未做的评估历史列表、后台评估任务等重新登记成意外漏项。

- [ ] **Step 3：仅校正路线图中的实际状态。**

S4a 的陈旧“代码就绪待上线”改为当前实际已交付状态；S4b 改为“部分完成：面试指南已交付；五阶段进度与批次并行暂缓”。其他 S 不凭本轮加固变成已完成。日期只使用可证实记录，未知交付日保留未填写语义，不能编造日期。

- [ ] **Step 4：提交文档与验收记录。**

```bash
git add README.md dev-docs/handoff.md dev-docs/2026-09-23-roadmap-magazine-and-features.md dev-docs/2026-10-24-reliability-acceptance.md
git commit -m "docs: record reliability guarantees acceptance and rollout status"
```

提交前确认只包含本任务文件，不带 logs、私有数据或其他 agent 未完成改动。如果需要调整已提交实现，先做该实现包的后续提交，再更新实际证据，不改写他人历史。

## 交付与回退规则

- [ ] 六包均有实现提交、测试落点及实际证据；共享测试改动由一个 owner 合并。
- [ ] 独立回归都由原 test.sh 或 test-structure 显式调用，最终 test:all 已实际覆盖；单独脚本绿不代替交付。
- [ ] 当前及两种历史主脚本实际保存通过，未知脚本仍被拒绝。
- [ ] 冻结件零差异、真实数据摘要相等、严格四套件 exit 0。
- [ ] 明确区分隔离完成与真实服务生效；真实模型质量不作本轮保证。

代码包按依赖逆序回退：先停用依赖失效的操作入口或回退上层消费者，再处理其基础模块；保留验证基础和已建立的安全边界。不通过恢复自动模型 POST 重发、按端口杀进程或放松 CSP 来回退。未执行数据迁移，因此新增可选字段留在数据中，由旧逻辑忽略，不删改真实记录。

发布后出现相关回归时，先保护用户未保存输入，停止受影响入口并报告证据；是否重启按当前在途工作状态确认。隔离复现和修复通过前不继续在真实简历上试写。
