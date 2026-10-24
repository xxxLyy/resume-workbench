# 验证基础与严格验收 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 V1–V2：断言失败不能被浏览器跳过覆盖；测试进程、端口、日志互不干扰；严格四套件不能略过必需验证。

**Architecture:** 保留现有 shell + Node 测试入口；在原文件内修正退出分支、子进程生命周期和端口选择。新增一个无依赖的小型回归脚本执行原退出分支和生命周期助手，不引入测试框架、不修改应用实现。

**Tech Stack:** Node.js ESM、原生 assert/child_process/http、macOS Bash 3.2、现有 playwright-core、现有四套件。

---

## 执行边界与文件所有权

- 批准设计：[2026-10-24-reliability-hardening-design.md](/Users/xxxly/resume/dev-docs/2026-10-24-reliability-hardening-design.md)，重点 `7.1–7.2`、V1–V2。
- 本包唯一 owner：验证 owner。此 owner 同时接收区域、来源、资源及交付包提出的共享测试变更；其他 agent 不并行编辑下列文件。
- Modify: `/Users/xxxly/resume/test-editor.mjs`：参数错误、两处 Chromium 不可用出口及用于执行分支的标记。
- Modify: `/Users/xxxly/resume/test.sh`：动态端口、子进程、目录隔离、浏览器结果接收、绝对导入。
- Modify: `/Users/xxxly/resume/test-structure.sh`：严格冻结基线分支、小回归入口及测试标记。
- Create: `/Users/xxxly/resume/test-fixtures/reliability/test-harness.mjs`：本包回归。仅依赖 Node，不是新的通用 runner。
- 不修改 `package.json`、应用服务、`template.html`、`themes/`、`render.mjs`；不执行真实服务、真实模型或真实数据迁移。
- 本计划中的实现代码只在执行本计划时写入；编写计划不等于已创建这些实现文件。
- 前置：保存 `git status --short` 与代码基线；保护原有改动。测试只使用桩配置，不能打开真实 `config.json`。

## Task VAL-01：用真实控制流复现退出码掩盖

**Files:** 上述三个测试入口及新增 `test-harness.mjs`。覆盖 V1。

- [ ] **Step 1：仅加入测试边界标记，不改变原分支行为。**

在 `test-editor.mjs` 的 `let bin; try resolveChromium ... catch` 外包：

```js
// RELIABILITY_RESOLVE_BEGIN
let bin;
try { bin = await resolveChromium(); }
catch (e) {
  console.error('⚠️ Chromium 不可用，跳过浏览器级验证: ' + (e && e.message || e));
  process.exit(2);
}
// RELIABILITY_RESOLVE_END
```

在 `let browser; try chromium.launch ... catch ...` 外加 `// RELIABILITY_LAUNCH_BEGIN` / `// RELIABILITY_LAUNCH_END`，保留其中现有重探一次逻辑。在 `test.sh` 的浏览器 `if node test-editor.mjs ... fi` 外加 `# RELIABILITY_BROWSER_RESULT_BEGIN` / `# RELIABILITY_BROWSER_RESULT_END`。在 `test-structure.sh` 的 `S2_BASE=5208e44` 至对应 `fi` 外加 `# RELIABILITY_BASELINE_BEGIN` / `# RELIABILITY_BASELINE_END`；在现有真实简历可选 smoke 的 JS `if (existsSync(...)) ... else ...` 外加 `// RELIABILITY_PRIVATE_SMOKE_BEGIN` / `// RELIABILITY_PRIVATE_SMOKE_END`。

这些标记只允许回归脚本提取**待执行的原分支**，不能拿“出现某个字符串”当行为通过。

- [ ] **Step 2：创建独立回归脚本的退出码部分。**

```js
// /Users/xxxly/resume/test-fixtures/reliability/test-harness.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.argv[2] || 'exit';
function block(file, start, end) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const a = src.indexOf(start), b = src.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, '缺少回归执行边界: ' + start);
  return src.slice(a + start.length, b);
}
function nodeCase(code, expected, label) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-'], {
    cwd: ROOT, input: code, encoding: 'utf8', timeout: 10000
  });
  assert.equal(r.status, expected, label + '\n' + r.stderr);
}
function shellCase(code, env, expected, label, cwd = ROOT) {
  const r = spawnSync('bash', ['-c', code], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000
  });
  assert.equal(r.status, expected, label + '\n' + r.stdout + r.stderr);
}
if (mode === 'exit') {
  const resolve = block('test-editor.mjs',
    '// RELIABILITY_RESOLVE_BEGIN', '// RELIABILITY_RESOLVE_END');
  const launch = block('test-editor.mjs',
    '// RELIABILITY_LAUNCH_BEGIN', '// RELIABILITY_LAUNCH_END');
  for (const failures of [0, 1]) {
    nodeCase(`const failures=${failures};
      const resolveChromium=async()=>{throw new Error('fixture unavailable')};
      ${resolve}`, failures ? 1 : 2, 'resolve: failure 优先');
    nodeCase(`const failures=${failures}; let bin='fixture';
      const invalidateCache=()=>{};
      const resolveChromium=async()=> 'fixture';
      const chromium={launch:async()=>{throw new Error('fixture launch failure')}};
      ${launch}`, failures ? 1 : 2, 'launch: failure 优先');
  }
  const usage = spawnSync(process.execPath, [path.join(ROOT, 'test-editor.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000
  });
  assert.equal(usage.status, 1, '参数错误不得被解释为环境跳过');
  assert.match(usage.stderr, /用法:/, '必须实际到达参数检查，不能用依赖缺失冒充');
  console.log('✅ V1 editor 退出码优先级');
}
```

- [ ] **Step 3：运行红测。**

Run:

```bash
cd /Users/xxxly/resume
node test-fixtures/reliability/test-harness.mjs exit
```

Expected: exit 1，断言指向 `resolve: failure 优先`；实际 2，预期 1。不运行浏览器、事务测试或模型。

- [ ] **Step 4：最小修复两处环境出口和参数出口。**

```js
// 参数检查处
if (!base || !docId || !dataRoot) {
  console.error('用法: node test-editor.mjs <baseURL> <docId> <dataRoot>');
  process.exit(1);
}
// 两个“Chromium 不可用” catch 内，均使用：
process.exit(failures > 0 ? 1 : 2);
```

保留 Node 段失败后继续跑浏览器段、原缓存失效重探一次，以及最终 `failures > 0 → exit 1`。普通断言异常仍是失败，不捕获成环境缺失。

- [ ] **Step 5：重复上述单个命令，预期 exit 0 和 `V1 editor 退出码优先级`。**
- [ ] **Step 6：只提交本任务文件。**

```bash
git add test-editor.mjs test.sh test-structure.sh test-fixtures/reliability/test-harness.mjs
git commit -m "test: preserve assertion failures when browser checks are unavailable"
```

提交中的 `test.sh/test-structure.sh` 此时只有标记；后续行为修改另提交。回退条件：回归脚本未执行到真实出口、参数缺失仍返回 2，或重探逻辑丢失。修正当前提交，不删失败断言。

## Task VAL-02：严格模式复用原聚合入口

**Files:** `test.sh`、`test-structure.sh`、`test-harness.mjs`。覆盖 V1 与严格验收。

- [ ] **Step 1：在回归脚本追加可直接执行的 shell 分支矩阵。**

```js
if (mode === 'strict') {
  const result = block('test.sh',
    '# RELIABILITY_BROWSER_RESULT_BEGIN', '# RELIABILITY_BROWSER_RESULT_END');
  const shell = `set -e
    node(){ return "$FAKE_EDITOR_RC"; }
    fail(){ echo "EXPECTED_FAILURE: $1" >&2; exit 1; }
    B=fixture; DOCID=fixture; RESUME_ROOT=fixture
    ${result}`;
  for (const [strict, rc, expected] of [
    ['0', '0', 0], ['0', '2', 0], ['1', '0', 0],
    ['1', '2', 1], ['0', '1', 1], ['1', '1', 1]
  ]) shellCase(shell, { RESUME_TEST_STRICT: strict, FAKE_EDITOR_RC: rc },
    expected, 'browser gate strict=' + strict + ' rc=' + rc);

  const baseline = block('test-structure.sh',
    '# RELIABILITY_BASELINE_BEGIN', '# RELIABILITY_BASELINE_END');
  const absent = 'set -e\ngit(){ return 1; }\n' + baseline;
  shellCase(absent, { RESUME_TEST_STRICT: '0' }, 0, '普通模式缺基线可跳过');
  shellCase(absent, { RESUME_TEST_STRICT: '1' }, 1, '严格模式缺基线必须失败');

  const smoke = block('test-structure.sh',
    '// RELIABILITY_PRIVATE_SMOKE_BEGIN', '// RELIABILITY_PRIVATE_SMOKE_END');
  nodeCase(`process.env.RESUME_TEST_STRICT='1';
    const existsSync=()=>false;
    const readFileSync=()=>{throw new Error('不应读私有文档')};
    ${smoke}`, 0, '严格模式仍不依赖私有文档');
  console.log('✅ V1 strict browser/baseline gate 与可选私有 smoke');
}
```

这里 stub 的是浏览器子命令结果和 Git “找不到基线”，实际执行被测 shell 分支；不启动整套测试、不隐藏真实测试失败。

- [ ] **Step 2：运行红测。**

```bash
node test-fixtures/reliability/test-harness.mjs strict
```

Expected: exit 1，`browser gate strict=1 rc=2` 当前错误地成功。

- [ ] **Step 3：替换 test.sh 的浏览器结果接收分支。**

```bash
# RELIABILITY_BROWSER_RESULT_BEGIN
BROWSER_CHECK_SKIPPED=0
if node test-editor.mjs "$B" "$DOCID" "$RESUME_ROOT"; then
  echo '✅ 浏览器级保存/恢复/冲突/审阅验证'
else
  RC=$?
  if [ "$RC" -eq 2 ] && [ "${RESUME_TEST_STRICT:-0}" != 1 ]; then
    BROWSER_CHECK_SKIPPED=1
    echo '⚠️ 浏览器级验证未执行：Chromium 不可用'
  else
    fail "浏览器级验证未通过 (exit $RC，strict=${RESUME_TEST_STRICT:-0})"
  fi
fi
# RELIABILITY_BROWSER_RESULT_END
```

- [ ] **Step 4：仅在原冻结基线缺失的 else 分支增加 strict 失败；不动私有 smoke。**

```bash
else
  if [ "${RESUME_TEST_STRICT:-0}" = 1 ]; then
    echo "❌ 严格验收缺冻结基线 $S2_BASE；先取得该提交，不能跳过比对"
    exit 1
  fi
  echo "⏭  S2 冻结件比对（未执行：本地没有 $S2_BASE）"
fi
```

基线存在时继续执行现有 `git diff --quiet "$S2_BASE" -- themes/`；不得换一个更近提交让差异消失。不要把 strict 写成强制读取个人简历。将 test.sh 末尾原“全部通过”改为以下分支，避免普通模式略过浏览器后仍声称全套完成：

```bash
if [ "${BROWSER_CHECK_SKIPPED:-0}" -eq 1 ]; then
  echo '可执行检查通过；浏览器验证未执行，本次不构成完整交付验收'
else
  echo '全部通过（隔离数据根：本测试未触碰真实数据与真实模型）'
fi
```

- [ ] **Step 5：运行 strict 回归，预期 exit 0；检查 package.json 的 test:all 仍是原四段聚合。**
- [ ] **Step 6：将本包独立回归接到 test-structure.sh 文件末尾。**

```bash
# V1/V2：原分支执行与本轮子进程所有权（无真实模型）
node test-fixtures/reliability/test-harness.mjs exit
node test-fixtures/reliability/test-harness.mjs strict
node test-fixtures/reliability/test-harness.mjs lifecycle
```

最后一条在 VAL-03 完成后才加入，不能先留一个尚未实现的模式。命令通过工作目录定位本项目，不放机器绝对路径。

- [ ] **Step 7：提交。**

```bash
git add test.sh test-structure.sh test-fixtures/reliability/test-harness.mjs
git commit -m "test: require browser and frozen baselines in strict acceptance"
```

回退约束：保留 VAL-01。严格验收失败时补齐依赖或修测试，不能把必需段降回可跳过。

## Task VAL-03：本轮端口、PID 与日志拥有明确生命周期

**Files:** `test.sh`、`test-harness.mjs`。覆盖 V2。

- [ ] **Step 1：在 test.sh 的依赖检查后、启动任何子进程前，加入以下本地助手。旧 cleanup 的按端口杀进程在 Step 3 删除。**

```bash
# RELIABILITY_LIFECYCLE_BEGIN
TEST_CHILDREN=()
track_child() { TEST_CHILDREN+=("$1"); }
forget_child() {
  local wanted=$1 item
  local kept=()
  for item in "${TEST_CHILDREN[@]}"; do
    [ "$item" = "$wanted" ] || kept+=("$item")
  done
  TEST_CHILDREN=("${kept[@]}")
}
child_is_owned() {
  local parent
  parent=$(ps -o ppid= -p "$1" 2>/dev/null | tr -d '[:space:]')
  [ "$parent" = "$$" ] && kill -0 "$1" 2>/dev/null
}
stop_child() {
  local pid=$1 signal=${2:-TERM} round
  if child_is_owned "$pid"; then
    kill "-$signal" "$pid" 2>/dev/null || true
    for ((round=0; round<20; round++)); do
      child_is_owned "$pid" || break
      sleep 0.05
    done
    if child_is_owned "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
  fi
  wait "$pid" 2>/dev/null || true
  forget_child "$pid"
}
cleanup() {
  local pid
  for pid in "${TEST_CHILDREN[@]}"; do stop_child "$pid"; done
  if [ -n "${TEST_DIR:-}" ] && [ -d "$TEST_DIR" ]; then rm -rf "$TEST_DIR"; fi
}
install_cleanup() {
  trap 'test_exit=$?; trap - EXIT; cleanup; exit "$test_exit"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
}
wait_ready() {
  local pid=$1 url=$2 logfile=$3 marker=$4 round
  for ((round=0; round<100; round++)); do
    if ! child_is_owned "$pid"; then
      tail -n 20 "$logfile" >&2
      fail "本轮测试子进程启动失败: $pid"
    fi
    if grep -qF -- "$marker" "$logfile" &&
       curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  tail -n 20 "$logfile" >&2
  fail "本轮测试服务未在时限内就绪: $url"
}
choose_test_ports() {
  RESUME_TEST_REQUESTED_PORT="${PORT:-0}" node --input-type=module <<'NODE'
import http from 'node:http';
const requested = Number(process.env.RESUME_TEST_REQUESTED_PORT);
if (!Number.isInteger(requested) || requested < 0 || requested > 65535) {
  throw new Error('PORT 必须是 0–65535 的整数');
}
const servers = [];
const ports = [];
try {
  for (let i = 0; i < 5; i++) {
    const s = http.createServer(); servers.push(s);
    await new Promise((resolve, reject) => {
      s.once('error', reject);
      s.listen(i === 0 ? requested : 0, '127.0.0.1', resolve);
    });
    ports.push(s.address().port);
  }
  console.log(ports.join(' '));
} finally {
  await Promise.all(servers.map((s) => new Promise((resolve) => {
    if (!s.listening) return resolve();
    s.close(resolve);
  })));
}
NODE
}
# RELIABILITY_LIFECYCLE_END
```

五个端口在同一批临时监听期间分配，保证批内互不重复；释放到真实进程启动之间仍有竞争，启动失败必须报错，不能去杀占用者。PID 表只包含直接启动的子进程；父 PID 校验避免已退出 PID 被复用后误杀别的进程。

- [ ] **Step 2：在 test-harness.mjs 追加生命周期行为测试。**

```js
if (mode === 'lifecycle') {
  const helper = block('test.sh',
    '# RELIABILITY_LIFECYCLE_BEGIN', '# RELIABILITY_LIFECYCLE_END');
  const observer = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-harness-observer-'));
  const runs = [];
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const exists = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore'
  });
  try {
    for (const token of ['A', 'B']) {
      const manifest = path.join(observer, token + '.txt');
      const child = spawn('bash', ['-c', `set -e
        ${helper}
        TEST_DIR=$(mktemp -d /tmp/resume-harness-case.XXXXXX)
        install_cleanup
        PORT=0
        allocated=$(choose_test_ports)
        read -r PORT LLM_PORT JD_PORT GAP_PORT RESTART_PORT <<< "$allocated"
        node -e 'setInterval(()=>{},1000)' > "$TEST_DIR/server.log" 2>&1 &
        owned=$!; track_child "$owned"
        printf '%s\n' "$TOKEN" > "$TEST_DIR/request.log"
        printf '%s\n%s\n%s\n' "$TEST_DIR" "$owned" "$allocated" > "$MANIFEST"
        while :; do sleep 0.05; done
      `], {
        cwd: ROOT,
        env: { ...process.env, TOKEN: token, MANIFEST: manifest },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const closed = new Promise((resolve) => child.once('close', resolve));
      runs.push({ child, manifest, token, closed });
    }
    const deadline = Date.now() + 10000;
    while (!runs.every((r) => fs.existsSync(r.manifest)) && Date.now() < deadline) await pause(30);
    for (const r of runs) {
      assert(fs.existsSync(r.manifest), '夹具未就绪 ' + r.token);
      const [dir, pid, ports] = fs.readFileSync(r.manifest, 'utf8').trim().split('\n');
      r.dir = dir; r.pid = Number(pid);
      assert.equal(fs.readFileSync(path.join(dir, 'request.log'), 'utf8').trim(), r.token);
      assert.equal(new Set(ports.split(' ')).size, 5);
    }
    assert.notEqual(runs[0].dir, runs[1].dir, '目录必须隔离');
    runs[0].child.kill('SIGTERM');
    await runs[0].closed;
    assert(!exists(runs[0].pid), '中断后的自有进程残留');
    assert(!fs.existsSync(runs[0].dir), '中断后的临时根残留');
    assert(exists(runs[1].pid), '中断 A 误杀 B');
    assert(exists(unrelated.pid), '清理误杀未登记进程');
    runs[1].child.kill('SIGTERM'); await runs[1].closed;
    assert(!exists(runs[1].pid), 'B 自有进程残留');
    console.log('✅ V2 并发实例、日志和 PID 清理隔离');
  } finally {
    for (const r of runs) {
      if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill('SIGTERM');
      await r.closed;
    }
    unrelated.kill('SIGTERM');
    await new Promise((resolve) => {
      if (unrelated.exitCode !== null || unrelated.signalCode !== null) return resolve();
      unrelated.once('close', resolve);
    });
    fs.rmSync(observer, { recursive: true, force: true });
  }
}
```

- [ ] **Step 3：替换 test.sh 初始化、启动及清理接线。**

替换原默认端口/旧 cleanup：

```bash
TEST_DIR=$(mktemp -d /tmp/resume-isolated-test.XXXXXX)
export RESUME_ROOT="$TEST_DIR/data"
mkdir -p "$RESUME_ROOT/docs" "$RESUME_ROOT/snapshots" "$RESUME_ROOT/pdfs"
install_cleanup
PORT_VALUES=$(choose_test_ports) || { echo '❌ 测试端口不可用（未清理占用者）'; exit 1; }
read -r PORT LLM_PORT JD_PORT GAP_PORT RESTART_PORT <<< "$PORT_VALUES"
export PORT
```

将所有启动点立即登记：`LLM=$!; track_child "$LLM"`、`SRV=$!; track_child "$SRV"`、`JDSTUB=$!; track_child "$JDSTUB"`；每个 `SRV2/SRV3/GAPCURL` 也登记。故障注入使用 `stop_child "$SRV2" KILL`，完成的重启副本使用 `stop_child "$SRV3"`，在复用变量前回收。已自然结束的 `GAPCURL` 在 `wait` 后执行 `forget_child "$GAPCURL"`。

删掉两处旧 `trap cleanup EXIT`，改为上面的单次安装；删除所有 `lsof ... | xargs kill`，删除共享 `/tmp` 日志的清理。

- [ ] **Step 4：改动态端口所有消费者及日志路径。**

桩配置仍在隔离根生成，改用非单引号 heredoc 展开本轮 LLM 端口：

```bash
cat > "$RESUME_ROOT/config.json" <<EOF
{"active":0,"profiles":[{"name":"stub","baseURL":"http://127.0.0.1:$LLM_PORT/v1","apiKey":"stub","model":"stub-model"}]}
EOF
```

保留Node桩的单引号heredoc，禁止为展开端口而让shell解释JavaScript中的反引号和变量。启动桩前导出专用变量：

```bash
export RESUME_TEST_LLM_PORT="$LLM_PORT"
export RESUME_TEST_JD_PORT="$JD_PORT"
```

LLM 桩末尾改 `.listen(Number(process.env.RESUME_TEST_LLM_PORT), '127.0.0.1', () => console.error('READY LLM'))`；JD 桩对应使用`Number(process.env.RESUME_TEST_JD_PORT)`并输出`READY JD`。`/ai/jd-text`测试请求的shell URL使用`$JD_PORT`。保存中断段改`PORT2=$GAP_PORT`，生成重启段改`PORT2=$RESTART_PORT`。不得只改主端口留下桩端口固定。

主日志改 `"$TEST_DIR/server.log"`；桩日志分别 `llm.log/jd.log`；删除桩内复制到全局临时文件的语句。区域泄漏断言直接读已有 `"$TEST_DIR/llm-last.json"`。所有重启副本日志保留在同一 TEST_DIR 的各自文件中。

用上述 `wait_ready` 取代固定 sleep 后“只看 PID”的启动判断。它同时检查父子关系、该子进程自己的启动标记与 URL，不误把其他服务的响应当成测试就绪：

```bash
node "$TEST_DIR/llm-stub.mjs" > "$TEST_DIR/llm.log" 2>&1 &
LLM=$!; track_child "$LLM"
wait_ready "$LLM" "http://127.0.0.1:$LLM_PORT/v1/models" "$TEST_DIR/llm.log" 'READY LLM'
RESUME_RENDER_BIN="$TEST_DIR/fake-render.sh" node server.mjs > "$TEST_DIR/server.log" 2>&1 &
SRV=$!; track_child "$SRV"
B="http://127.0.0.1:$PORT"
wait_ready "$SRV" "$B/" "$TEST_DIR/server.log" "简历平台: http://localhost:$PORT"
```

JD 桩使用现有响应内容，仅替换端口并登记启动标记：

```bash
node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'Content-Type':'text/html'});s.end('<html><body><script>var a=1;</script><h1>资深后端工程师</h1><p>五年 Node 经验</p></body></html>')}).listen($JD_PORT,'127.0.0.1',()=>console.error('READY JD'))" > "$TEST_DIR/jd.log" 2>&1 &
JDSTUB=$!; track_child "$JDSTUB"
wait_ready "$JDSTUB" "http://127.0.0.1:$JD_PORT/" "$TEST_DIR/jd.log" 'READY JD'
JDR=$(curl -s -X POST "$B/ai/jd-text" -H 'Content-Type: application/json' -d "{\"url\":\"http://127.0.0.1:$JD_PORT\"}")
```

保存中断副本的启动与恢复，替换为：

```bash
PORT2=$GAP_PORT
RESUME_TEST_SAVE_GAP_MS=2500 PORT="$PORT2" node server.mjs > "$TEST_DIR/s4a-srv2.log" 2>&1 &
SRV2=$!; track_child "$SRV2"
wait_ready "$SRV2" "http://127.0.0.1:$PORT2/" "$TEST_DIR/s4a-srv2.log" "简历平台: http://localhost:$PORT2"
# 原中断点调用 stop_child "$SRV2" KILL；原 GAPCURL 请求与断言保留。
PORT="$PORT2" node server.mjs > "$TEST_DIR/s4a-srv3.log" 2>&1 &
SRV3=$!; track_child "$SRV3"
wait_ready "$SRV3" "http://127.0.0.1:$PORT2/" "$TEST_DIR/s4a-srv3.log" "简历平台: http://localhost:$PORT2"
# 原恢复断言结束后调用 stop_child "$SRV3"。
```

生成重启副本的启动与恢复，替换为：

```bash
PORT2=$RESTART_PORT
PORT="$PORT2" node server.mjs > "$TEST_DIR/s4a-t4-srv2.log" 2>&1 &
SRV2=$!; track_child "$SRV2"
wait_ready "$SRV2" "http://127.0.0.1:$PORT2/" "$TEST_DIR/s4a-t4-srv2.log" "简历平台: http://localhost:$PORT2"
# 原任务请求保留；原崩溃点调用 stop_child "$SRV2" KILL。
PORT="$PORT2" node server.mjs > "$TEST_DIR/s4a-t4-srv3.log" 2>&1 &
SRV3=$!; track_child "$SRV3"
wait_ready "$SRV3" "http://127.0.0.1:$PORT2/" "$TEST_DIR/s4a-t4-srv3.log" "简历平台: http://localhost:$PORT2"
# 原重启恢复断言结束后调用 stop_child "$SRV3"。
```

上述两个片段是相应原启动行的替换，原中断/请求/断言仍留在各启动之间，不把启动与重启连续执行。应用服务始终使用显式本轮 PORT，启动竞争失败直接结束本次测试，不连接或停止无关服务。

- [ ] **Step 5：运行 lifecycle 回归，预期 exit 0；验证显式占用不会被清理。**

```bash
node test-fixtures/reliability/test-harness.mjs lifecycle
```

在同脚本 lifecycle 分支中追加此正负行为，使用本测试自己启动的占用者：

```js
const occupied = await import('node:http').then(({ createServer }) =>
  new Promise((resolve) => {
    const s = createServer((q, r) => r.end('owned by fixture'));
    s.listen(0, '127.0.0.1', () => resolve(s));
  }));
try {
  shellCase(helper + '\nchoose_test_ports', { PORT: String(occupied.address().port) },
    1, '显式 PORT 被占用应失败');
  assert(occupied.listening, '不能清理占用者');
} finally { await new Promise((resolve) => occupied.close(resolve)); }
```

不要给这个分支加 `2>/dev/null` 后当通过；必须断言失败码和占用者仍监听。

- [ ] **Step 6：替换 test.sh 中遗留的绝对导入。**

```js
import { parasOf } from './zone.mjs';
```

该 heredoc 使用 `node --input-type=module`，test.sh 开头已切换到脚本目录，故相对导入与当前结构一致。

- [ ] **Step 7：检查并行完整主套件。**

仅在本包小回归通过后做一次完整并发验证；父目录和报告由本次执行拥有：

```bash
cd /Users/xxxly/resume
V2_LOG_ROOT=$(mktemp -d /tmp/resume-v2-evidence.XXXXXX)
bash test.sh > "$V2_LOG_ROOT/a.log" 2>&1 & V2_A=$!
bash test.sh > "$V2_LOG_ROOT/b.log" 2>&1 & V2_B=$!
wait "$V2_A"; V2_A_RC=$?
wait "$V2_B"; V2_B_RC=$?
test "$V2_A_RC" -eq 0
test "$V2_B_RC" -eq 0
```

执行该段的 shell 不开 `set -e`，先收集两个状态再断言；任一失败均查看本轮报告后修复，不能杀端口解围。预期两次均 exit 0，日志来自不同临时根；不得把两个报告覆盖到同一路径。小回归证明 PID 生命周期，完整并发证明真实 test.sh 接线未遗漏。

- [ ] **Step 8：提交本包接线。**

```bash
git add test.sh test-structure.sh test-fixtures/reliability/test-harness.mjs
git commit -m "test: isolate ports logs and child process cleanup per run"
```

回退约束：本包如需修正，不恢复按端口杀进程。保留明确失败和独占 PID 清理，只有本包自有文件可回退；不能回退其他 agent 已接入的测试块。

## Task VAL-04：交给其他工作包和最终验收 owner

- [ ] **Step 1：执行本包三条小回归和 shell 语法检查。**

```bash
bash -n test.sh
bash -n test-structure.sh
node test-fixtures/reliability/test-harness.mjs exit
node test-fixtures/reliability/test-harness.mjs strict
node test-fixtures/reliability/test-harness.mjs lifecycle
```

Expected: 全部 exit 0；这是本包完成证据，不是整个可靠性改动验收。

- [ ] **Step 2：交接给共享测试 owner：记录提交、实际命令、退出码、V1/V2 反例结果及并行日志目录。**
- [ ] **Step 3：后续业务包只追加其编号用例，由同一 owner 串行修改 test-editor/test-structure；不得重复运行两套并行 test:all。**
- [ ] **Step 4：最终严格四套件由交付计划统一执行：`RESUME_TEST_STRICT=1 npm run test:all`。**

本包不重启 launchd，不调用真实模型，不打开私有配置，也不以旧交接里的测试数字作本次通过证明。
