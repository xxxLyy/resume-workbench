// 用法: node dev-docs/mockups/shot.mjs <outDir>
// 产出: <outDir>/{before,after}-{home,editor}.png
// before = 隔离根 + 当前代码起的服务器（假数据夹具）；after = 本目录静态对照稿。
// 隐私纪律：只读 APP_ROOT 的代码与模板，绝不读取真实 docs/ 内容。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate, themeRegistration } from '../../template.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const outDir = path.resolve(process.argv[2] || '.');
fs.mkdirSync(outDir, { recursive: true });

const tmp = fs.mkdtempSync('/tmp/s2-mockup-');
const data = path.join(tmp, 'data');
for (const d of ['docs', 'snapshots', 'pdfs']) fs.mkdirSync(path.join(data, d), { recursive: true });

// 夹具占位符替换口径照抄 test-structure.sh:1441-1448（与 server.mjs /new 的替换集合一致）
const fill = (tpl, id, name) => tpl
  .replaceAll('{{NAME}}', () => name).replaceAll('{{CONTACT}}', () => '电话：12345678901 ｜ 邮箱：mock@example.com').replaceAll('{{INTENT}}', () => '意向岗位：后端工程师')
  .replaceAll('{{SUMMARY}}', () => '五年后端研发经验，主导高并发订单系统与数据链路建设。')
  .replaceAll('{{SKILLS}}', () => '<p>Node.js / MySQL / Redis / 消息队列</p>')
  .replaceAll('{{WORK}}', () => '<div class="entry-head"><span class="entry-title">某科技公司</span><span class="entry-role">后端工程师</span><span class="entry-date">2021-2026</span></div><ul><li>负责订单核心服务，主导拆单重构与容量治理。</li></ul>')
  .replaceAll('{{PROJECTS}}', () => '<div class="entry-head"><span class="entry-title">订单系统重构</span><span class="entry-date">2023</span></div><ul><li>单体拆分与链路治理，峰值吞吐提升一倍。</li></ul>')
  .replaceAll('{{EDU}}', () => '<div class="entry-head"><span class="entry-title">某大学</span><span class="entry-role">本科｜计算机科学与技术</span><span class="entry-date">2016-2020</span></div>')
  .replaceAll('{{DOC_ID}}', () => id);

const ids = ['mock-doc', 'mock-doc-2', 'mock-doc-3'];
ids.forEach((id, i) => fs.writeFileSync(path.join(data, 'docs', id + '.html'),
  fill(assembleTemplate('classic'), id, ['测试候选人', '示例甲', '示例乙'][i])));
fs.writeFileSync(path.join(data, 'docs-meta.json'),
  JSON.stringify(Object.fromEntries(ids.map((id) => [id, { ...themeRegistration('classic'), rev: 1 }]))));
fs.writeFileSync(path.join(data, 'applications.json'), '[]');
fs.writeFileSync(path.join(data, 'materials.json'), '[]');

const port = 17990;
const srv = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')],
  { env: { ...process.env, RESUME_ROOT: data, PORT: String(port) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));

const browser = await chromium.launch({ executablePath: await resolveChromium() });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(outDir, 'before-home.png'), fullPage: true });
  await page.goto(`http://127.0.0.1:${port}/edit?id=mock-doc`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(outDir, 'before-editor.png') });
  await page.goto('file://' + path.join(HERE, 's2-home.html'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'after-home.png'), fullPage: true });
  await page.goto('file://' + path.join(HERE, 's2-editor.html'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, 'after-editor.png') });
} finally {
  await browser.close();
  srv.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('OK screenshots ->', outDir);
