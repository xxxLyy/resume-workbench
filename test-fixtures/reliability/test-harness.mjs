// test-fixtures/reliability/test-harness.mjs — 验证基础包的最小回归（V1/V2）
// 目的：证明「原分支」真的被执行，并证明失败优先级/严格模式/进程生命周期符合设计 §7.1–7.2。
// 约束：无第三方依赖；不启动真实服务、不调用真实模型、不读取私有简历；只执行被测文件里的原分支。
// 用法：node test-fixtures/reliability/test-harness.mjs <exit|strict|lifecycle>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const mode = process.argv[2] || 'exit';

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
    assert(!exists(runs[0].pid), '中断后的自有进程残留');
    assert(!fs.existsSync(runs[0].dir), '中断后的临时根残留');
    assert(exists(runs[1].pid), '中断 A 误杀 B');
    assert(exists(unrelated.pid), '清理误杀未登记进程');
    runs[1].child.kill('SIGTERM'); await runs[1].closed;
    assert(!exists(runs[1].pid), 'B 自有进程残留');

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
} else {
  console.error('未知模式: ' + mode + '（可用: exit|strict|lifecycle）');
  process.exit(2);
}
