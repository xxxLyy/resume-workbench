// test-home-task-badge.mjs — 首页日程卡徽章间距（浏览器真渲染量测，无障碍几何为准）
// 计划：渐进呈现 T3（dev-docs/2026-11-12 spec）——任务卡退役后，首页唯一「gap 容器内含徽章」
//   的幸存样本是近期日程卡（#upcomingAgenda）：每条日程 = inline flex gap:var(--space-2) 行，
//   行内含类型徽章（截止/面试·轮次）+「已逾期」徽章 + 投递状态徽章。
//   规则依据 DESIGN.md §5.3「.badge 自带 margin-right（徽章后分隔的唯一机制）；放进 gap 容器
//   时必须给 .badge{margin-right:0}，否则双倍计距」——修法落在 #upcomingAgenda .badge{margin-right:0}。
// 断言（真实浏览器 getBoundingClientRect 量测，不靠样式文本推断）：
//   ① 日程卡徽章在 gap 容器内 margin-right 归零（§5.3 明文要求）；
//   ② 徽章→徽章/徽章→下一项 距离 == 容器 gap（双倍计距消失）；
//   ③ 状态徽章→行尾自然收边（gap 均一，无叠加右距）；
//   ④ /applications 看板卡（非 gap 容器）里的徽章仍保留 6px 右距——修法只作用于日程行，不动全局徽章机制。
// 隔离：mkdtemp 根 + 随机端口 + 合成母版/投递；不读真实简历、不碰 7766、不调真实模型。
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
// 刻意不写 config.json → 无模型（日程卡与徽章口径都是纯服务端派生，不依赖模型）

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

// 合成文档 + 一条「已逾期截止」投递 → 状态 2 + 日程卡单行含三枚徽章（截止/已逾期/已投递）
const metaPath = path.join(root, 'docs-meta.json');
{
  let doc = assembleTemplate('classic');
  for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', ''],
    ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'badgemaster']]) doc = doc.replaceAll(k, () => v);
  doc = doc.replace(/<h1>[^<]*<\/h1>/, () => '<h1>合成母版简历</h1>');
  fs.writeFileSync(path.join(root, 'docs', 'badgemaster.html'), doc);
  fs.writeFileSync(metaPath, JSON.stringify({ badgemaster: { rev: 1, flow: 'draft' } }));
}
const overdueDue = new Date(Date.now() - 2 * 3600 * 1000).toISOString();   // 2h 前 → 已逾期
fs.writeFileSync(path.join(root, 'applications.json'), JSON.stringify([
  { id: 'badge-app-001', company: '合成截止公司', role: '后端', docId: 'badgemaster',
    status: '已投递', dueDate: overdueDue, createdAt: '2026-01-01', updatedAt: '2026-01-01', interviews: [] }
]));

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
  catch (e) { console.log('⚠️  Chromium 不可用，跳过日程卡徽章间距量测：' + (e && e.message || e)); cleanup(); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#upcomingAgenda .badge');

  const m = await page.evaluate(() => {
    const row = document.querySelector('#upcomingAgenda a');
    const badges = Array.from(row.querySelectorAll('.badge'));
    const box = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; };
    const kids = Array.from(row.children);
    return {
      gap: getComputedStyle(row).gap,
      badgeMargins: badges.map((b) => getComputedStyle(b).marginRight),
      badgeTexts: badges.map((b) => b.textContent.trim()),
      first: badges[0] ? box(badges[0]) : null,
      second: badges[1] ? box(badges[1]) : null,
      afterFirst: kids.indexOf(badges[0]) >= 0 && kids[kids.indexOf(badges[0]) + 1] ? box(kids[kids.indexOf(badges[0]) + 1]) : null
    };
  });

  const gapPx = parseFloat(m.gap);
  assert.ok(Number.isFinite(gapPx) && gapPx > 0, '日程行应是 gap 容器，实际 gap=' + m.gap);
  assert.ok(m.badgeMargins.length >= 3, `日程行应含 ≥3 枚徽章（截止/已逾期/已投递），实际 ${m.badgeMargins.length}：${m.badgeTexts.join('/')}`);

  // ① gap 容器内徽章自带右距必须归零（DESIGN.md §5.3：否则双倍计距）
  for (const [i, mr] of m.badgeMargins.entries()) {
    assert.equal(mr, '0px', `日程卡第 ${i + 1} 枚徽章「${m.badgeTexts[i]}」在 gap 容器内须 margin-right:0（§5.3），实际=${mr}`);
  }

  // ② 徽章→徽章 距离 = gap（归零后不再叠加 6px）
  const badgeToBadge = Math.round((m.second.left - m.first.right) * 100) / 100;
  assert.ok(Math.abs(badgeToBadge - gapPx) < 0.5,
    `徽章→徽章应为 gap(${gapPx}px)，实际 ${badgeToBadge}px（双倍计距）`);

  // ③ 徽章→下一项（时间 span）距离 = gap（行内其余项未被归零波及）
  const badgeToSpan = Math.round((m.afterFirst.left - m.first.right) * 100) / 100;
  assert.ok(Math.abs(badgeToSpan - gapPx) < 0.5,
    `徽章→下一项应为 gap(${gapPx}px)，实际 ${badgeToSpan}px`);

  // ④ 对照：/applications 看板卡的徽章在普通流内（非 gap 容器）仍保留 6px 右距
  await page.goto(base + '/applications', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-card .badge');
  const ctrl = await page.evaluate(() => {
    const b = document.querySelector('.app-card .badge');
    return { marginRight: getComputedStyle(b).marginRight, text: b.textContent.trim() };
  });
  assert.equal(ctrl.marginRight, '6px',
    `gap 容器外（看板卡行内）的徽章「${ctrl.text}」须保留自带右距 6px（修法只作用于 #upcomingAgenda），实际=${ctrl.marginRight}`);

  console.log(`✅ 日程卡徽章间距（gap ${gapPx}px 容器内 margin-right 归零 ×${m.badgeMargins.length}；徽章后距 ${badgeToBadge}px = gap；看板卡行内徽章「${ctrl.text}」仍 6px）`);
} catch (e) {
  console.error('❌ ' + (e && e.message));
  process.exitCode = 1;
} finally {
  if (browser) { try { await browser.close(); } catch {} }
  cleanup();
}
