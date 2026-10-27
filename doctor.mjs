// doctor.mjs — 首次启动/开源交付检查。只读；不触发网络连接测试（连接由用户主动触发）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readCache, cacheValid, expectedRevision, playwrightVersion } from './chromium.mjs';
import { loadProfiles } from './llm.mjs';   // 与运行时同口径：旧单配置 {baseURL,apiKey,model} 也算已配置
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 而不是 new URL(...).pathname：后者是百分号编码（路径含空格/中文时读不到真实目录）
const ROOT = process.env.RESUME_ROOT || path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const add = (name, ok, detail, fix) => checks.push({ name, ok: ok === undefined ? true : ok, detail: detail || '', fix: fix || '' });

try { fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true }); fs.accessSync(ROOT, fs.constants.W_OK); add('数据目录可写', true, ROOT); }
catch (e) { add('数据目录可写', false, e.message, `chmod u+w "${ROOT}"`); }

const c = readCache();
add('Chromium 选择', cacheValid(c), c ? c.bin : '无缓存', '运行一次 node render.mjs 触发探测，或设 RESUME_CHROMIUM');
if (process.argv.includes('--probe')) {
  const { resolveChromium } = await import('./chromium.mjs');
  try {
    const bin = await resolveChromium();   // 成功即写入缓存
    add('Chromium 探针', true, bin);
    // 探针成功后重判「Chromium 选择」：否则会保留探针前的「无缓存」失败（自相矛盾的结论）
    const after = readCache();
    const idx = checks.findIndex((x) => x.name === 'Chromium 选择');
    if (idx >= 0) checks[idx] = { ...checks[idx], ok: cacheValid(after), detail: cacheValid(after) ? after.bin : '无缓存' };
  }
  catch (e) { add('Chromium 探针', false, String(e.message).split('\n')[0], '见 dev-docs/2026-09-23-s0-design.md §2.2'); }
}
for (const t of ['pdftotext', 'pdfinfo', 'pdftoppm']) {
  // execFileSync 而非 execSync + 字符串插值（2026-10-19 安全审查 ⚪-2 扩展）：
  // command -v 是 shell 内建，execFileSync 找不到它，改用真实二进制 which（macOS/Linux 都有）。
  let ok = false; try { execFileSync('which', [t], { stdio: 'ignore' }); ok = true; } catch {}
  add(t, ok, '', 'brew install poppler');
}
{ let ok = false; try { execFileSync('which', ['ffmpeg'], { stdio: 'ignore' }); ok = true; } catch {}
  add('ffmpeg', ok, '视觉门禁 RGB24 比较依赖（tools/pixel-diff.mjs）', 'brew install ffmpeg'); }
// 配置判定复用 llm.loadProfiles（生产归一层）：旧单配置 {baseURL,apiKey,model} 归一为「默认」profile，
// 损坏 JSON 归一为「无配置」。原先 doctor 自己读 profiles → 旧格式被误报为「不可用」。
const { active, profiles } = loadProfiles(ROOT);
const p = profiles[active] || null;
add('模型配置字段完整', !!(p && p.baseURL && p.apiKey && p.model), p ? `profile=${p.name}` : '无 config.json', '参考 config.example.json；无需模型也能编辑/保存/导出/投递记录');
add('模型连接', null, '未测试（网络连接测试由用户主动触发）', '');
add('无需模型可用能力', true, '编辑/保存/快照/导出/投递记录/版本对比');
let bk = '无 backups/ 记录';
try { const ds = fs.readdirSync(path.join(ROOT, 'backups')).sort(); if (ds.length) bk = ds[ds.length - 1]; } catch {}
add('最近备份', true, bk, '在设置页做一次备份');

// --json 时人读行走 stderr、stdout 只留 JSON 数组，保证 `node doctor.mjs --json | jq` 可解析
const jsonMode = process.argv.includes('--json');
for (const x of checks) (jsonMode ? console.error : console.log)(`${x.ok === false ? '❌' : x.ok === null ? '⚪' : '✅'} ${x.name}${x.detail ? ' — ' + x.detail : ''}${x.ok === false && x.fix ? '｜修复: ' + x.fix : ''}`);
if (jsonMode) console.log(JSON.stringify(checks, null, 2));
process.exit(checks.some(x => x.ok === false) ? 1 : 0);
