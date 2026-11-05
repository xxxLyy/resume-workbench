// test-home-task-badge.mjs — 批1 首页任务卡徽章间距（浏览器真渲染量测，无障碍几何为准）
// 计划：dev-docs/2026-11-05-roadmap-batch-plan.md §2 首页；规则依据 DESIGN.md §5.3
//   「`.badge` 自带 `margin-right`（徽章后分隔的唯一机制）；放进 `gap` 容器时**必须**给
//     `.badge{margin-right:0}`，否则双倍计距。」
// 背景：b1c1 的 `.taskcard .task-acts` 是 flex+gap 容器（有草稿态内含徽章），
//   徽章自带 6px 右距与容器 gap 叠加 → 徽章后距 = gap+6 ≠ gap（同页行内徽章却只有 6px）。
// 断言（真实浏览器 getBoundingClientRect 量测，不靠样式文本推断）：
//   ① 任务卡徽章在 gap 容器内 margin-right 归零（§5.3 明文要求）；
//   ② 徽章→下一项 距离 == 容器 gap（双倍计距消失）；
//   ③ CTA→徽章 距离 == 容器 gap（未因归零而错位）；
//   ④ 草稿卡（「继续处理岗位草稿」）行内容器里的徽章仍保留 6px 右距——修法只作用于 gap 容器，不动全局徽章机制。
//     取样对象显式化：草稿卡 = `.mainarea > .card:not(#taskCard)`（行内容器在行内 span 里，本身无 gap）。
//     不用「文档序首个 .card .badge」——那会命中文档列表卡（li.card.doc-card）的「快照 N」徽章，与本断言意图不符。
// 隔离：mkdtemp 根 + 随机端口 + 合成母版/岗位稿；不读真实简历、不碰 7766、不调真实模型。
// 退出码契约：0=全部通过；1=断言失败；2=仅 Chromium 不可用（套件惯例，跳过不假装通过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-taskbadge-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups', 'photos']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 刻意不写 config.json → 无模型（任务卡三态与徽章口径都是纯服务端派生，不依赖模型）

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);
const base = `http://127.0.0.1:${port}`;

// 合成文档：真模板骨架 + 显式 h1 标题 + meta 直写（母版 + 一份进行中岗位稿 → 任务卡走「▶ 继续处理」态，徽章在场）
const metaPath = path.join(root, 'docs-meta.json');
const seedDoc = (id, title, metaEntry = {}) => {
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', ''],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', id]]) doc = doc.replaceAll(k, () => v);
  doc = doc.replace(/<h1>[^<]*<\/h1>/, () => `<h1>${title}</h1>`);
  fs.writeFileSync(path.join(root, 'docs', id + '.html'), doc);
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : {};
  meta[id] = { rev: 1, flow: 'draft', ...metaEntry };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
};
seedDoc('badgemaster', '合成母版简历');
seedDoc('badgedraft', '合成岗位稿', {
  parent: 'badgemaster', company: '合成公司', role: '合成岗位',
  job: { kind: 'job', status: 'draft', flow: 'draft' }
});

let browser = null;
try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { console.log('⚠️  Chromium 不可用，跳过任务卡徽章间距量测：' + (e && e.message || e)); cleanup(); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#taskCard .task-acts .badge');

  const m = await page.evaluate(() => {
    const acts = document.querySelector('#taskCard .task-acts');
    const kids = Array.from(acts.children);
    const badge = acts.querySelector('.badge');
    const bi = kids.indexOf(badge);
    const box = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; };
    // 草稿卡（「继续处理岗位草稿」）行内容器里的同款徽章——修法不应波及它
    const inlineBadge = document.querySelector('.mainarea > .card:not(#taskCard) .badge');
    return {
      gap: getComputedStyle(acts).gap,
      badgeMarginRight: getComputedStyle(badge).marginRight,
      cta: box(kids[bi - 1]),
      badge: box(badge),
      next: kids[bi + 1] ? box(kids[bi + 1]) : null,
      inlineBadgeText: inlineBadge ? inlineBadge.textContent.trim() : null,
      inlineBadgeMarginRight: inlineBadge ? getComputedStyle(inlineBadge).marginRight : null
    };
  });

  const gapPx = parseFloat(m.gap);
  assert.ok(Number.isFinite(gapPx) && gapPx > 0, '任务卡操作行应是 gap 容器，实际 gap=' + m.gap);

  // ① gap 容器内徽章自带右距必须归零（DESIGN.md §5.3：否则双倍计距）
  assert.equal(m.badgeMarginRight, '0px',
    '任务卡徽章在 gap 容器内须 margin-right:0（§5.3 双倍计距禁令），实际=' + m.badgeMarginRight);

  // ② 徽章→下一项 = gap（归零后不再叠加 6px）
  assert.ok(m.next, '任务卡徽章后应有下一项（公司·岗位）');
  const afterBadge = Math.round((m.next.left - m.badge.right) * 100) / 100;
  assert.ok(Math.abs(afterBadge - gapPx) < 0.5,
    `徽章→下一项应为 gap(${gapPx}px)，实际 ${afterBadge}px（双倍计距）`);

  // ③ CTA→徽章 = gap（回归护栏：归零只影响徽章右距）
  const beforeBadge = Math.round((m.badge.left - m.cta.right) * 100) / 100;
  assert.ok(Math.abs(beforeBadge - gapPx) < 0.5,
    `CTA→徽章应为 gap(${gapPx}px)，实际 ${beforeBadge}px`);

  // ④ 草稿卡行内的徽章仍保留 6px 右距（徽章后分隔的唯一机制，全站 43 处在用）
  assert.ok(m.inlineBadgeText, '未取到草稿卡行内的徽章（取样对象缺失，无法校验 gap 容器外的徽章右距）');
  assert.equal(m.inlineBadgeMarginRight, '6px',
    `gap 容器外（草稿卡行内）的徽章「${m.inlineBadgeText}」须保留自带右距 6px（修法只作用于 .task-acts 内的徽章），实际=${m.inlineBadgeMarginRight}`);

  console.log(`✅ 任务卡徽章间距（gap 容器内 margin-right 归零；徽章后距 ${afterBadge}px = gap ${gapPx}px；草稿卡行内徽章「${m.inlineBadgeText}」仍 6px）`);
} catch (e) {
  console.error('❌ ' + (e && e.message));
  process.exitCode = 1;
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  cleanup();
}
