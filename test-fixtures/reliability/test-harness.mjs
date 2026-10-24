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
} else {
  console.error('未知模式: ' + mode + '（可用: exit|strict|lifecycle）');
  process.exit(2);
}
