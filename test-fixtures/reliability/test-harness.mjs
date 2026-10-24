// test-fixtures/reliability/test-harness.mjs — 验证基础包的最小回归（V1/V2）
// 目的：证明「原分支」真的被执行，并证明失败优先级/严格模式/进程生命周期符合设计 §7.1–7.2。
// 约束：无第三方依赖；不启动真实服务、不调用真实模型、不读取私有简历；只执行被测文件里的原分支。
// 用法：node test-fixtures/reliability/test-harness.mjs <exit|strict|lifecycle>
// 内部夹具：node test-fixtures/reliability/test-harness.mjs signal-child
//   —— 由 lifecycle 模式启动、定向发信号；不是公开入口，不单独跑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.argv[2] || 'exit';
const HARNESS = path.join(ROOT, 'test-fixtures/reliability/test-harness.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ===== 本轮所有权 =====
// 只有登记在本表里的进程和目录属于本轮；清理只碰它们，绝不按端口/进程名全局清理。
const ownedChildren = new Set();
const ownedDirs = new Set();
function trackChild(child) { ownedChildren.add(child); }
function trackDir(dir) { ownedDirs.add(dir); }

// 实际只执行一次，但可以重复调用（信号处理器与正常收尾会同时调用它）。
let cleanupPromise = null;
function cleanupOnce() {
  if (!cleanupPromise) cleanupPromise = doCleanup();
  return cleanupPromise;
}
async function doCleanup() {
  // 先给本轮子进程 TERM，再等它们真的退出；超时才升级 KILL。
  const pending = [];
  for (const child of ownedChildren) {
    if (child.exitCode !== null || child.signalCode !== null) continue; // 已退出：不再 kill（避免 PID 复用误杀）
    try { child.kill('SIGTERM'); } catch {}
    pending.push(new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    }));
  }
  await Promise.all(pending);
  for (const dir of ownedDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  ownedChildren.clear();
  ownedDirs.clear();
}

// SIGINT/SIGTERM/SIGHUP 走同一条清理路径；重复信号只会触发同一次清理。
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
function installSignalHandlers() {
  for (const [sig, code] of Object.entries(SIGNAL_EXIT)) {
    process.on(sig, () => {
      cleanupOnce().catch(() => {}).then(() => { process.exit(code); });
    });
  }
}

// 就绪屏障：等文件真正写完（可解析），不用固定 sleep 当同步。
async function waitForJson(file, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    }
    if (Date.now() >= deadline) throw new Error('等待就绪屏障超时: ' + label);
    await sleep(30);
  }
}

// 就绪屏障（普通文本清单）：等文件出现且非空。
async function waitForFile(file, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
    if (Date.now() >= deadline) throw new Error('等待就绪屏障超时: ' + label);
    await sleep(30);
  }
}

// 从被测文件里原样截取一段分支。标记只用来定位，行为断言一律看真实退出码。
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

// 异步跑一段 bash：自带硬超时（SIGKILL 兜底，脚本卡死也能收场）。
// onStart 在子进程刚建立时回调，用于中途定向发信号。
function runBash(code, { env = {}, timeoutMs = 25000, onStart } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('bash', ['-c', code], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => out += d);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    if (onStart) onStart(child);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, timedOut, child, ms: Date.now() - t0 });
    });
  });
}

installSignalHandlers();

if (mode === 'exit') {
  const resolve = block('test-editor.mjs',
    '// RELIABILITY_RESOLVE_BEGIN', '// RELIABILITY_RESOLVE_END');
  const launch = block('test-editor.mjs',
    '// RELIABILITY_LAUNCH_BEGIN', '// RELIABILITY_LAUNCH_END');
  // 已有断言失败（failures>0）时，环境不可用不得返回 2 掩盖失败；纯环境缺失才返回 2。
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
  // 参数错误必须真的走到参数检查；不得用「依赖缺失」冒充退出码 1。
  const usage = spawnSync(process.execPath, [path.join(ROOT, 'test-editor.mjs')], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000
  });
  assert.equal(usage.status, 1, '参数错误不得被解释为环境跳过');
  assert.match(usage.stderr, /用法:/, '必须实际到达参数检查，不能用依赖缺失冒充');
  console.log('✅ V1 editor 退出码优先级');
} else if (mode === 'strict') {
  // 严格验收：浏览器段与冻结基线都是必需项，缺失必须阻断交付（设计 §7.1）。
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

  // 可选私有 smoke：严格模式也不得依赖真实个人简历。
  const smoke = block('test-structure.sh',
    '// RELIABILITY_PRIVATE_SMOKE_BEGIN', '// RELIABILITY_PRIVATE_SMOKE_END');
  nodeCase(`process.env.RESUME_TEST_STRICT='1';
    const existsSync=()=>false;
    const readFileSync=()=>{throw new Error('不应读私有文档')};
    ${smoke}`, 0, '严格模式仍不依赖私有文档');
  console.log('✅ V1 strict browser/baseline gate 与可选私有 smoke');
} else if (mode === 'lifecycle') {
  // V2：端口/PID/日志必须属于本轮。两个并发实例不得互串、不得互杀；
  // 显式占用端口要直接失败且不得清理占用者；中断只回收本轮子进程。
  const helper = block('test.sh',
    '# RELIABILITY_LIFECYCLE_BEGIN', '# RELIABILITY_LIFECYCLE_END');
  const observer = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-harness-observer-'));
  trackDir(observer);
  const runs = [];
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore'
  });
  trackChild(unrelated);
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
      trackChild(child);
      const closed = new Promise((resolve) => child.once('close', resolve));
      runs.push({ child, manifest, token, closed });
    }
    const deadline = Date.now() + 10000;
    while (!runs.every((r) => fs.existsSync(r.manifest)) && Date.now() < deadline) await sleep(30);
    for (const r of runs) {
      assert(fs.existsSync(r.manifest), '夹具未就绪 ' + r.token);
      const [dir, pid, ports] = fs.readFileSync(r.manifest, 'utf8').trim().split('\n');
      r.dir = dir; r.pid = Number(pid); r.ports = ports.split(' ');
      assert.equal(fs.readFileSync(path.join(dir, 'request.log'), 'utf8').trim(), r.token);
      assert.equal(new Set(r.ports).size, 5);
    }
    assert.notEqual(runs[0].dir, runs[1].dir, '目录必须隔离');
    // 两轮端口零重叠：任一端口重合都会在并行时互相抢占。
    for (const p of runs[0].ports) {
      assert(!runs[1].ports.includes(p), '两轮端口必须零重叠（重合 ' + p + '）');
    }
    runs[0].child.kill('SIGTERM');
    await runs[0].closed;
    assert(!alive(runs[0].pid), '中断后的自有进程残留');
    assert(!fs.existsSync(runs[0].dir), '中断后的临时根残留');
    assert(alive(runs[1].pid), '中断 A 误杀 B');
    assert(alive(unrelated.pid), '清理误杀未登记进程');
    runs[1].child.kill('SIGTERM'); await runs[1].closed;
    assert(!alive(runs[1].pid), 'B 自有进程残留');

    // 显式端口被占用：必须直接失败，且不得清理占用者。
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

    await waitReadyMatrix(helper, observer);
    await signalMatrix(observer);
    console.log('✅ V2 并发实例、日志和 PID 清理隔离');
  } finally {
    await cleanupOnce();
  }
} else if (mode === 'signal-child') {
  // 内部夹具（由 lifecycle 模式驱动）：建立本轮子进程后挂起，等上层只向本进程发信号。
  // 本进程被信号打断时，只有本进程自己的清理流程能救场（父进程的 finally 不参与）。
  const observer = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-signal-child-'));
  trackDir(observer);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore'
  });
  trackChild(unrelated);
  const helper = block('test.sh', '# RELIABILITY_LIFECYCLE_BEGIN', '# RELIABILITY_LIFECYCLE_END');
  const childManifest = path.join(observer, 'child.txt');
  const child = spawn('bash', ['-c', `set -e
    fail(){ echo "EXPECTED_FAILURE: $1" >&2; exit 1; }
    ${helper}
    TEST_DIR=$(mktemp -d /tmp/resume-signal-case.XXXXXX)
    install_cleanup
    PORT=0
    allocated=$(choose_test_ports)
    node -e 'setInterval(()=>{},1000)' > "$TEST_DIR/server.log" 2>&1 &
    owned=$!; track_child "$owned"
    printf '%s\\n%s\\n%s\\n' "$TEST_DIR" "$owned" "$allocated" > "$CHILD_MANIFEST"
    while :; do sleep 0.05; done
  `], {
    cwd: ROOT,
    env: { ...process.env, CHILD_MANIFEST: childManifest },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  trackChild(child);
  // 等 bash 子进程真的建立（它的清单写完）再对外宣布就绪。
  await waitForFile(childManifest, 15000, 'signal-child 子进程就绪屏障');
  const [dir, ownedPid] = fs.readFileSync(childManifest, 'utf8').trim().split('\n');
  fs.writeFileSync(process.env.SIGNAL_MANIFEST, JSON.stringify({
    observer,
    bashPid: child.pid,
    unrelatedPid: unrelated.pid,
    childDir: dir,
    grandchildPid: Number(ownedPid)
  }));
  await new Promise(() => {});   // 挂起：只有收到信号才走统一清理并退出
} else {
  console.error('未知模式: ' + mode + '（可用: exit|strict|lifecycle）');
  process.exit(2);
}

// ===== wait_ready 行为矩阵 =====
// 覆盖：正常启动、延迟启动、进程提前退出、接受连接却不返回（必须按预算超时失败）、等待期间被中断。
async function waitReadyMatrix(helper, observer) {
  const stubPath = path.join(observer, 'wait-ready-stub.mjs');
  fs.writeFileSync(stubPath, `import http from 'node:http';
const mode = process.argv[2];
const delay = Number(process.argv[3] || 0);
const port = Number(process.env.STUB_PORT);
if (mode === 'exit') process.exit(3);           // 启动即退出，没有就绪标记
setTimeout(() => {
  http.createServer((req, res) => {
    if (mode === 'hang') return;                // 接受连接，永不返回
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  }).listen(port, '127.0.0.1', () => console.error('READY STUB'));
}, delay);
`);
  const script = `set -e
fail(){ echo "EXPECTED_FAILURE: $1" >&2; exit 1; }
${helper}
TEST_DIR=$(mktemp -d /tmp/resume-wr-case.XXXXXX)
install_cleanup
read -r STUB_PORT _p2 _p3 _p4 _p5 <<< "$(choose_test_ports)"
export STUB_PORT
node "$WR_STUB" "$WR_MODE" "$WR_DELAY" > "$TEST_DIR/stub.log" 2>&1 &
SPID=$!; track_child "$SPID"
printf '%s\\n%s\\n' "$TEST_DIR" "$SPID" > "$WR_MANIFEST"
wait_ready "$SPID" "http://127.0.0.1:$STUB_PORT/" "$TEST_DIR/stub.log" 'READY STUB'
echo WAIT_READY_OK`;

  const run = (mode, delayMs, extra = {}) => runBash(script, {
    env: {
      WR_STUB: stubPath, WR_MODE: mode, WR_DELAY: String(delayMs),
      WR_MANIFEST: path.join(observer, 'wr-' + mode + '-' + delayMs + '.txt'), ...extra
    },
    timeoutMs: extra.timeoutMs || 30000
  });

  // 正常启动：立即就绪。
  let r = await run('ok', 0);
  const msNormal = r.ms;
  assert(!r.timedOut, '正常启动不得超时');
  assert.equal(r.code, 0, '正常启动应成功\n' + r.out);
  assert.match(r.out, /WAIT_READY_OK/, '正常启动应返回就绪');
  assert(r.ms < 5000, '正常启动应很快完成（实测 ' + r.ms + 'ms）');

  // 延迟启动：必须等到服务真的起来。
  r = await run('ok', 2000);
  const msLate = r.ms;
  assert(!r.timedOut, '延迟启动不得超时');
  assert.equal(r.code, 0, '延迟启动应成功\n' + r.out);
  assert.match(r.out, /WAIT_READY_OK/, '延迟启动应返回就绪');
  assert(r.ms >= 1800, '延迟启动必须真的等待（实测 ' + r.ms + 'ms）');
  assert(r.ms < 12000, '延迟启动应在预算内完成（实测 ' + r.ms + 'ms）');

  // 进程提前退出：立刻明确失败，不是一直等到预算耗尽。
  r = await run('exit', 0);
  const msExit = r.ms;
  assert(!r.timedOut, '提前退出不得等到外层超时');
  assert.equal(r.code, 1, '提前退出应失败\n' + r.out);
  assert.match(r.out, /启动失败/, '提前退出应报启动失败\n' + r.out);
  assert(r.ms < 5000, '提前退出应快速失败（实测 ' + r.ms + 'ms）');

  // 接受连接却不返回：必须按总预算超时失败，绝不能无限挂住。
  r = await run('hang', 0);
  const msHang = r.ms;
  assert(!r.timedOut, '挂起服务必须由 wait_ready 自己的预算兜住，不能靠外层超时');
  assert.equal(r.code, 1, '挂起服务应失败\n' + r.out);
  assert.match(r.out, /未在时限内就绪/, '挂起服务应报未在时限内就绪\n' + r.out);
  assert(r.ms >= 8000, '挂起服务应等到总预算（实测 ' + r.ms + 'ms）');
  assert(r.ms <= 20000, '挂起服务必须在预算上界内结束（实测 ' + r.ms + 'ms）');

  // 等待期间被中断：信号必须被及时处理，子进程与临时目录都要回收。
  const manifest = path.join(observer, 'wr-interrupt.txt');
  let bashChild = null;
  const pending = runBash(script, {
    env: { WR_STUB: stubPath, WR_MODE: 'hang', WR_DELAY: '0', WR_MANIFEST: manifest },
    timeoutMs: 30000,
    onStart: (c) => { bashChild = c; }
  });
  await waitForFile(manifest, 10000, '中断用例就绪屏障');
  const [dir, pidText] = fs.readFileSync(manifest, 'utf8').trim().split('\n');
  const childPid = Number(pidText);
  await sleep(300);
  bashChild.kill('SIGTERM');
  const res2 = await pending;
  assert(!res2.timedOut, '中断用例不应靠外层超时收场');
  assert(res2.code === 143 || res2.signal === 'SIGTERM',
    '等待期间被中断应以 143/SIGTERM 结束（实测 code=' + res2.code + ' signal=' + res2.signal + '）');
  assert(!alive(childPid), '中断后本轮子进程残留');
  assert(!fs.existsSync(dir), '中断后本轮临时目录残留');
  console.log('  ✅ wait_ready 行为矩阵 正常=' + msNormal + 'ms 延迟=' + msLate + 'ms 提前退出=' +
    msExit + 'ms 挂起超时=' + msHang + 'ms 期间中断=' + res2.ms + 'ms');
}

// ===== harness 父进程信号回收矩阵 =====
// 上层只向 harness 父进程发信号：父进程必须自己清理本轮子进程与目录，且不得碰上层的哨兵。
async function signalMatrix(observer) {
  for (const [sig, code] of Object.entries(SIGNAL_EXIT)) {
    // 上层哨兵：属于上层进程，harness 的清理不得碰它。
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    trackChild(sentinel);
    const manifest = path.join(observer, 'sig-' + sig + '.json');
    const child = spawn(process.execPath, [HARNESS, 'signal-child'], {
      cwd: ROOT,
      env: { ...process.env, SIGNAL_MANIFEST: manifest },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    trackChild(child);
    let out = '';
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', (d) => out += d);
    const info = await waitForJson(manifest, 15000, sig + ' 子进程就绪屏障');
    // 只向 harness 父进程发信号（不发进程组）。
    child.kill(sig);
    if (sig === 'SIGTERM') child.kill(sig);   // 重复信号必须被安全处理
    const closed = await new Promise((resolve) =>
      child.once('close', (c, s) => resolve({ code: c, signal: s })));
    assert.equal(closed.code, code, sig + ' 后 harness 应以 ' + code + ' 退出（实际 ' + closed.code + '/' + closed.signal + '）\n' + out);
    assert(!alive(info.bashPid), sig + ' 后本轮 bash 子进程残留');
    assert(!alive(info.grandchildPid), sig + ' 后本轮孙进程残留');
    assert(!fs.existsSync(info.childDir), sig + ' 后本轮临时目录残留');
    assert(!alive(info.unrelatedPid), sig + ' 后 harness 自建进程未被清理');
    assert(!fs.existsSync(info.observer), sig + ' 后 harness 观察目录残留');
    assert(alive(sentinel.pid), sig + ' 误杀了上层哨兵');
    sentinel.kill('SIGTERM');
  }
  console.log('  ✅ harness 父进程信号回收矩阵（SIGINT/SIGTERM/SIGHUP）');
}
