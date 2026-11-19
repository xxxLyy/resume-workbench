// 批 5 §6.3 ECC 钩子白名单夹具：根治用户级 pre-commit 对夹具桩 apiKey 字面量的误报。
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §6（批 5 技术遗留三件之 3）。
//
// 被拦历史字面量（handoff.md 旁路登记的 eebcfb8 / 6ced332 / 84bbfb6 / df2bf96 等提交逐字同款，
// 已用 git show 逐一核对存在该字面量）：
//   apiKey: 'stub-key-not-real'   —— 来自 eebcfb8 / 6ced332 / a9b966c / 84bbfb6 / f600e34 等
// 本夹具把该行原样写进临时仓库 staged 文件，用真实用户钩子（core.hooksPath 解析，git commit 实跑）验证放行；
// 原负控四项（prod-…/stubborn-…/ghp_…/sk-…）曾以「必须拦」做门禁；2026-11-19 用户拍板放行真实密钥模式，
// 已降级为登记观察（不再计失败），恢复把关的方法见下方「登记组」注释。放行组 P1-P3 仍是门禁。
//
// 方法：mktemp 临时 git 仓库（合成数据，零真实数据目录触碰；本夹具验证的是钩子而非服务，不开端口）。
// 负控密钥值一律运行时拼接构造（'ghp_'+'a'.repeat(36) 等），不把可命中钩子/隐私门禁的完整字面量写进本文件，
// 否则本夹具自身的提交会被新钩子拦下（自批 5 本项起 resume 仓库禁止 ECC_SKIP_PRECOMMIT 旁路）。
// 钩子文件缺失 exit 2（环境不可用，与浏览器夹具 Chromium 缺失同口径）。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fails = [];
const note = (ok, msg) => { console.log((ok ? '✅ ' : '❌ ') + msg); if (!ok) fails.push(msg); };

// 子进程环境显式移除两类旁路开关：本夹具的判定必须来自钩子本体，不得来自旁路。
const hookEnv = { ...process.env };
delete hookEnv.ECC_SKIP_PRECOMMIT;
delete hookEnv.ECC_SKIP_GIT_HOOKS;

const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: hookEnv, ...opts });

const parent = mkdtempSync(join(tmpdir(), 'ecc-hook-whitelist.'));
try {
  // 探针 0：钩子在不在（git commit 在无钩子时会静默放行，缺钩子只能 exit 2 而不能判绿）
  const probeRepo = join(parent, 'probe0');
  git(['init', '-q', '-b', 'main', probeRepo]);
  const hooksPath = git(['-C', probeRepo, 'config', 'core.hooksPath']).trim();
  const hookFile = hooksPath ? join(hooksPath, 'pre-commit') : join(probeRepo, '.git', 'hooks', 'pre-commit');
  if (!hooksPath || !existsSync(hookFile)) {
    console.error('⚠️  用户级 ECC pre-commit 钩子不存在（core.hooksPath=' + (hooksPath || '未设') + '），无法验证钩子契约');
    process.exit(2);
  }
  console.log('钩子文件：' + hookFile);

  // 探针仓库构造：init → 本地身份 → 写入 staged 内容 → git commit（实跑钩子）
  const commitProbe = (name, content) => {
    const repo = join(parent, name);
    git(['init', '-q', '-b', 'main', repo]);
    git(['-C', repo, 'config', 'user.email', 'fixture@example.invalid']);
    git(['-C', repo, 'config', 'user.name', 'fixture']);
    writeFileSync(join(repo, 'probe.js'), content);
    git(['-C', repo, 'add', 'probe.js']);
    let blocked = null, out = '';
    try {
      git(['-C', repo, 'commit', '-qm', 'probe: ' + name]);
      blocked = false;
    } catch (e) {
      blocked = true;
      out = String((e.stderr || '') + (e.stdout || ''));
    }
    return { repo, blocked, out };
  };
  const committed = (repo) => {
    try { git(['-C', repo, 'rev-parse', '-q', '--verify', 'HEAD']); return true; } catch { return false; }
  };

  // ── 放行组（白名单根治目标）───────────────────────────────────────────
  // P1 历史被拦字面量（eebcfb8 test-apps-settings-forms.mjs:103 的 apiKey 字段段逐字同款——
  // 钩子唯一扫描对象是字段段；整行 name 字段两侧不同：'stub' vs '种子配置'）
  const p1 = commitProbe('stub-historical',
    "{ active: 0, profiles: [{ name: 'stub', baseURL: 'https://example.invalid/v1', apiKey: 'stub-key-not-real', model: 'stub-model' }] }\n");
  note(p1.blocked === false && committed(p1.repo),
    'P1 历史被拦桩字面量 apiKey: stub-key-not-real 应放行' + (p1.blocked ? '——仍被拦：\n' + p1.out.split('\n').filter((l) => l.includes('ECC') || l.includes('stub-key')).join('\n') : ''));

  // P2 仓库另一既有桩形态 apiKey: 'stub'（<12 字符本就在门槛下，防回归）
  const p2 = commitProbe('stub-short',
    "{ active: 0, profiles: [{ name: 'stub', baseURL: 'https://example.invalid/v1', apiKey: 'stub', model: 'stub-model' }] }\n");
  note(p2.blocked === false && committed(p2.repo), 'P2 既有短桩值 apiKey: stub 应放行');

  // P3 白名单第二词 generality：password: 'dummy-…' 同为显式假值形态
  const p3 = commitProbe('dummy-password', "password: 'dummy-password-0000'\n");
  note(p3.blocked === false && committed(p3.repo), 'P3 显式假值 password: dummy-password-0000 应放行');

  // ── 登记组（原「拦截负控」；2026-11-19 用户拍板：用户级 ECC 钩子白名单有意放行真实密钥模式）──
  // 降级为非门禁观察项：探针逻辑原样保留（仍是每次跑的真实观测），只是不再 push 进 fails。
  // 恢复把关：把本组四条 info(...) 换回 note(...) 断言版（消息模板见 git 历史）即可，探针无需改。
  const info = (ok, msg) => console.log((ok ? '✅ ' : '⚠️  ') + msg + (ok ? '' : '【登记非失败：2026-11-19 用户拍板放行】'));
  const fakeGeneric = 'prod-' + 'aaaa1111bbbb2222';               // 21 字符非桩前缀通用凭证值
  const fakeStubborn = 'stub' + 'born-aaaa1111bbbb2222';          // 桩词紧粘真值：stub 后无分隔符
  const fakeGithub = 'ghp_' + 'a'.repeat(36);                     // GitHub classic token 结构规则
  const fakeOpenai = 'sk-' + 'a'.repeat(20);                      // OpenAI key 结构规则

  const p4 = commitProbe('generic-prod', "apiKey: '" + fakeGeneric + "', model: 'stub-model-x'\n");
  info(p4.blocked, 'P4 观察项 通用凭证非桩值（prod-… 21 字符）：' + (p4.blocked ? '仍拦' : '当前放行'));

  const p5 = commitProbe('stubborn', "apiKey: '" + fakeStubborn + "'\n");
  info(p5.blocked, 'P5 观察项 桩词紧粘真值（stubborn-…）：' + (p5.blocked ? '仍拦' : '当前放行'));

  const p6 = commitProbe('github-token', fakeGithub + '\n');
  info(p6.blocked, 'P6 观察项 结构规则 ghp_ 36 位：' + (p6.blocked ? '仍拦' : '当前放行'));

  const p7 = commitProbe('openai-key', fakeOpenai + '\n');
  info(p7.blocked, 'P7 观察项 结构规则 sk- 20 位：' + (p7.blocked ? '仍拦' : '当前放行'));

  if (fails.length) {
    console.error('\n❌ ECC 钩子白名单夹具失败 ' + fails.length + ' 项');
    process.exit(1);
  }
  console.log('\n✅ ECC 钩子白名单夹具：放行组 ×3 门禁绿；拦截组 ×4 为登记观察（2026-11-19 用户拍板放行真实密钥模式）');
  process.exit(0);
} finally {
  rmSync(parent, { recursive: true, force: true });
}
