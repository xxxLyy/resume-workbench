// test-zone-scroll-shell.mjs — Bug1 回归（2026-11-16）：点下方区域行后外壳不得被 scrollIntoView 推动
// 断言：body.ed-on 等非画布祖先 scrollTop===0（overflow:clip 后不再是滚动容器），
//       顶栏 getBoundingClientRect().top===0，目标元素仍在画布滚动容器内可见。
// 退出码契约同浏览器段：0 通过 / 1 断言失败 / 2 仅 Chromium 不可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { resolveChromium } from '../../chromium.mjs';
import { assembleTemplate } from '../../template.mjs';
import { normalizeZids } from '../../zone.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-zscroll-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
// 长文档：工作区 40 段把「个人」区推到第二页以下（重现 scrollIntoView 推外壳场景）
const workParas = Array.from({ length: 40 }, (_, i) => `<p>工作经历第 ${i + 1} 段：负责模块${i}</p>`).join('\n');
let doc = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '甲'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'], ['{{SKILLS}}', ''], ['{{WORK}}', workParas], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'd1']]) doc = doc.replaceAll(k, () => v);
doc = normalizeZids(doc);
const zids = [...doc.matchAll(/data-zid="([^"]+)"/g)].map((m) => m[1]);
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), doc);
const zones = { [zids[zids.length - 2]]: { zone: 'personal', status: 'confirmed' }, [zids[zids.length - 1]]: { zone: 'personal', status: 'confirmed' } };
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft', zones } }));

const PORT = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const B = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], { env: { ...process.env, RESUME_ROOT: root, PORT: String(PORT) }, stdio: 'pipe' });
const cleanup = () => { try { server.kill('SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); };
let browser = null;
try {
  for (let i = 0; i < 60; i++) { try { const r = await fetch(B + '/'); if (r.status === 200) break; } catch {} await sleep(200); }
  let bin;
  try { bin = await resolveChromium(); }
  catch (e) { cleanup(); console.log('⚠️  Chromium 不可用，跳过：' + (e && e.message || e)); process.exit(2); }
  browser = await chromium.launch({ executablePath: bin, headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1450, height: 900 } })).newPage();
  await page.goto(B + '/edit?id=d1', { waitUntil: 'networkidle' });
  await page.click('#ed-rtabs button[data-pane="zone"]');
  await page.waitForSelector('.zp-row[data-zone="personal"]', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('.zp-row[data-zone="personal"]').click());
  await page.waitForTimeout(1200);   // smooth scroll 收尾
  const st = await page.evaluate(() => {
    const hit = document.querySelector('.sheet [data-zid="' + [...document.querySelectorAll('.sheet [data-zid]')].pop().getAttribute('data-zid') + '"]');
    const bad = [];
    for (let n = hit; n && n !== document; n = n.parentNode) {
      if (n.nodeType === 1 && n.scrollTop !== 0 && !n.classList.contains('sheet')) bad.push(n.tagName + '.' + String(n.className).split(' ')[0] + '=' + n.scrollTop);
    }
    const r = hit.getBoundingClientRect();
    const sheet = document.querySelector('.sheet').getBoundingClientRect();
    return {
      bad,
      toolbarTop: (document.querySelector('.edit-toolbar') || document.body).getBoundingClientRect().top,
      seTop: document.scrollingElement.scrollTop,
      hitInSheet: r.top >= sheet.top && r.top <= sheet.bottom
    };
  });
  assert.equal(st.seTop, 0, 'viewport 不应滚动，实际 scrollingElement.scrollTop=' + st.seTop);
  assert.deepEqual(st.bad, [], '非画布祖先不得滚动：' + JSON.stringify(st.bad));
  assert.equal(st.toolbarTop, 0, '顶栏不得被推离屏，实际 top=' + st.toolbarTop);
  assert.ok(st.hitInSheet, '目标元素应在画布滚动容器内可见');
  console.log('✅ 定位滚动不推外壳：body/视口 scrollTop=0、顶栏 top=0、目标在画布内可见（overflow:clip）');
} finally { try { if (browser) await browser.close(); } catch {} cleanup(); }
