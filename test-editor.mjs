// test-editor.mjs — 浏览器级验证（playwright-core + 本机 Chromium headless shell）
// 用法: node test-editor.mjs <baseURL> <docId> <dataRoot>
// 覆盖：保存期间继续编辑不误判已保存、离线正文+排版恢复、多标签冲突、审阅面板接受与持久化、导航无障碍。
// 仅使用隔离数据根，绝不触碰真实数据。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromium } from './chromium.mjs';

const [base, docId, dataRoot] = process.argv.slice(2);
if (!base || !docId || !dataRoot) { console.error('用法: node test-editor.mjs <baseURL> <docId> <dataRoot>'); process.exit(2); }
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
function ok(name) { console.log('  ✅ ' + name); }
function bad(name, extra) { failures++; console.error('  ❌ ' + name + (extra ? '：' + extra : '')); }

let bin;
try { bin = await resolveChromium(); }
catch (e) { console.error('⚠️ Chromium 不可用，跳过浏览器级验证: ' + (e && e.message || e)); process.exit(2); }

// ===== 浏览器测试专用夹具：带两个项目条目的文档 + 岗位草稿 =====
const ED_DOC = 'ed-fixture';
const JOB_DOC = 'ed-fixture-v2';
{
  let tpl = fs.readFileSync(path.join(APP_ROOT, 'template.html'), 'utf8');
  const projects = '<div class="entry-head"><div class="entry-title">项目A</div><div class="entry-role">负责人</div><div class="entry-date">2024-2025</div></div>\n<ul><li>旧项目描述</li></ul>\n<div class="entry-head"><div class="entry-title">项目B</div><div class="entry-role">开发</div><div class="entry-date">2023</div></div>\n<ul><li>项目B描述</li></ul>';
  tpl = tpl.replaceAll('{{NAME}}', () => '测试员').replaceAll('{{CONTACT}}', () => 'test@example.com')
    .replaceAll('{{INTENT}}', () => '测试').replaceAll('{{SUMMARY}}', () => '摘要文本').replaceAll('{{SKILLS}}', () => '<p>技能一：内容</p>')
    .replaceAll('{{WORK}}', () => '').replaceAll('{{PROJECTS}}', () => projects).replaceAll('{{EDU}}', () => '').replaceAll('{{DOC_ID}}', () => ED_DOC);
  fs.writeFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), tpl);
  fs.copyFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), path.join(dataRoot, 'docs', JOB_DOC + '.html'));
  const metaPath = path.join(dataRoot, 'docs-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta[JOB_DOC] = {
    parent: ED_DOC, company: '浏览器测试公司', role: '前端工程师', jd: 'React', createdAt: new Date().toISOString(), tag: '浏览器测试',
    job: {
      status: 'draft', sourceSnap: '', sourceHash: '', materials: [], generatedAt: null, deliveredAt: null, summary: '',
      changes: [
        { id: 'bt1', gen: 1, section: '项目经历', entry: '项目A', kind: 'replace', before: '旧项目描述', after: '新项目描述（定制）', reason: '对齐 JD', source: '母版', level: 'normal', status: 'pending' },
        { id: 'bt2', gen: 1, section: '项目经历', entry: '项目B', kind: 'hide', before: '', after: '', reason: '低相关', source: 'JD', level: 'important', status: 'pending' }
      ],
      todos: [{ section: '项目经历', question: '缺少量化指标', why: 'JD 要求数据驱动', resolved: false }]
    }
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta));
}

const browser = await chromium.launch({ executablePath: bin });
try {
  // ===== 1. 保存期间继续编辑：A 提交，B 期间产生，A 返回后 B 仍未保存 =====
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const orig = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).includes('/save')) {
          return new Promise((resolve, reject) => setTimeout(() => orig.apply(window, [url, opts]).then(resolve, reject), 800));
        }
        return orig.apply(window, [url, opts]);
      };
    });
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + ED_DOC);
    await page.waitForSelector('.sheet .summary');
    await page.click('.sheet .summary');
    await page.keyboard.press('End');
    await page.keyboard.type('AAA');
    const saveP = page.evaluate(() => window.__edSaveManual());
    await page.waitForTimeout(200);                       // 第一次保存已在途
    await page.keyboard.type('BBB');                      // 保存期间继续编辑
    await saveP;
    const dirtyAfterFirst = await page.evaluate(() => window.__edIsDirty());
    const cacheAfterFirst = await page.evaluate(() => localStorage.getItem('resume-autosave:' + window.__edDocId));
    if (dirtyAfterFirst !== true) bad('保存返回后新编辑被误判已保存'); else ok('保存返回后新编辑保持未保存');
    if (!cacheAfterFirst) bad('未保存修订的恢复缓存被提前清空'); else ok('未保存修订的恢复缓存仍在');
    await page.waitForTimeout(3000);                      // 等续存保存完成（保存返回后 600ms 触发 + 在途）
    const disk1 = fs.readFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), 'utf8');
    if (!disk1.includes('AAA') || !disk1.includes('BBB')) bad('排队保存未把 A、B 都写入磁盘');
    else ok('排队保存将两次编辑都写入磁盘');
    const state = await page.evaluate(() => document.getElementById('saveState').dataset.state);
    if (state !== 'saved') bad('最终状态非已保存：' + state); else ok('最终状态回到已保存');
    await ctx.close();
  }

  // ===== 2. 离线编辑（正文+排版）→ 恢复缓存 → 重载恢复 =====
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const orig = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).includes('/save') && localStorage.getItem('ed-fail-save') === '1') {
          return Promise.reject(new Error('network down (test)'));
        }
        return orig.apply(window, [url, opts]);
      };
    });
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + ED_DOC);
    await page.waitForSelector('.sheet .summary');
    await page.evaluate(() => localStorage.setItem('ed-fail-save', '1'));
    await page.click('.sheet .summary');
    await page.keyboard.press('End');
    await page.keyboard.type('RECOVER-EDIT');
    await page.evaluate(() => window.__edSetTypo('/*TYPO-CUSTOM*/body{font-size:15px;line-height:1.5}'));
    await page.waitForTimeout(700);                       // 等缓存 debounce
    const cache = await page.evaluate(() => localStorage.getItem('resume-autosave:' + window.__edDocId));
    let parsed = null;
    try { parsed = JSON.parse(cache); } catch {}
    if (!parsed || !String(parsed.body).includes('RECOVER-EDIT')) bad('失败保存未缓存正文');
    else if (!String(parsed.typo || '').includes('font-size:15px')) bad('失败保存未缓存排版设置');
    else ok('离线修改的正文与排版都进入恢复缓存');
    // 网络恢复后重载：应出现恢复条，恢复正文+排版
    await page.evaluate(() => localStorage.setItem('ed-fail-save', '0'));
    await page.reload();
    await page.waitForSelector('.recovery-bar');
    await page.click('.recovery-bar button');
    await page.waitForTimeout(200);
    const restored = await page.evaluate(() => ({
      body: document.querySelector('.sheet').textContent.includes('RECOVER-EDIT'),
      typo: (document.getElementById('typo-custom') || {}).textContent || ''
    }));
    if (!restored.body) bad('恢复后正文缺失'); else ok('恢复后正文包含离线修改');
    if (!restored.typo.includes('font-size:15px')) bad('恢复后排版缺失'); else ok('恢复后排版一并还原');
    await page.evaluate(() => window.__edSaveManual());
    const disk2 = fs.readFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), 'utf8');
    if (!disk2.includes('RECOVER-EDIT') || !disk2.includes('font-size:15px')) bad('恢复内容未保存落盘');
    else ok('恢复内容（正文+排版）保存落盘');
    await ctx.close();
  }

  // ===== 3. 多标签：旧标签保存不能静默覆盖 =====
  {
    const ctx = await browser.newContext();
    const a = await ctx.newPage();
    const b = await ctx.newPage();
    await a.goto(base + '/edit?id=' + ED_DOC);
    await b.goto(base + '/edit?id=' + ED_DOC);
    await a.waitForSelector('.sheet .summary');
    await b.waitForSelector('.sheet .summary');
    // A 先保存
    await a.click('.sheet .summary');
    await a.keyboard.press('End');
    await a.keyboard.type('FROM-A');
    await a.evaluate(() => window.__edSaveManual());
    await a.waitForTimeout(400);
    // B（持有旧 mtime）再保存 → 冲突条出现
    await b.click('.sheet .summary');
    await b.keyboard.press('End');
    await b.keyboard.type('FROM-B');
    await b.evaluate(() => window.__edSaveManual());
    await b.waitForSelector('.conflict-bar', { timeout: 4000 });
    ok('旧标签保存触发冲突提示');
    await Promise.all([b.waitForNavigation(), b.click('.conflict-bar button.secondary')]);  // 加载服务器版本
    const bText = await b.evaluate(() => document.querySelector('.sheet').textContent);
    if (bText.includes('FROM-B')) bad('选择服务器版本后仍显示本地内容');
    else ok('冲突后加载服务器版本正确');
    const disk3 = fs.readFileSync(path.join(dataRoot, 'docs', ED_DOC + '.html'), 'utf8');
    if (!disk3.includes('FROM-A')) bad('服务器版本不是 A 的保存结果');
    else ok('未发生静默覆盖（磁盘保留先到版本）');
    await ctx.close();
  }

  // ===== 4. 审阅面板：接受修改应用到正文并持久化状态；隐藏条目可恢复 =====
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + JOB_DOC);
    await page.waitForSelector('#ed-pane-review .jp-item', { timeout: 5000 });
    const sel = await page.evaluate(() => document.querySelector('#ed-rtabs button[data-pane="review"]').getAttribute('aria-selected'));
    if (sel !== 'true') bad('岗位草稿默认未打开审阅视图'); else ok('岗位草稿默认打开修改清单');
    await page.click('#ed-pane-review .jp-item button.jp-accept');
    await page.waitForFunction(() => document.querySelector('.sheet').textContent.includes('新项目描述（定制）'), { timeout: 4000 });
    ok('接受修改应用到正文');
    await page.evaluate(() => window.__edSaveManual());
    const disk4 = fs.readFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), 'utf8');
    if (!disk4.includes('新项目描述（定制）')) bad('接受的修改未落盘');
    else ok('接受的修改落盘');
    const st = await page.evaluate(() => fetch('/job/changes?id=' + window.__edDocId).then((r) => r.json()));
    const accepted = st.job.changes.find((c) => c.id === 'bt1');
    if (!accepted || accepted.status !== 'accepted') bad('审阅状态未回写服务端'); else ok('审阅状态回写并持久化');
    // 隐藏条目（important：需逐条确认）
    await page.click('#ed-pane-review .jp-group.jp-important .jp-item button.jp-accept');
    await page.waitForTimeout(300);
    const hiddenOk = await page.evaluate(() => {
      const heads = Array.from(document.querySelectorAll('.sheet .entry-head'));
      const b = heads.find((h) => h.textContent.includes('项目B'));
      return !!(b && b.classList.contains('ed-entry-hidden'));
    });
    if (!hiddenOk) bad('隐藏条目未生效'); else ok('条目级隐藏生效（内容保留可恢复）');
    await page.evaluate(() => window.__edSaveManual());
    const disk5 = fs.readFileSync(path.join(dataRoot, 'docs', JOB_DOC + '.html'), 'utf8');
    if (!disk5.includes('ed-entry-hidden')) bad('隐藏类未落盘（PDF 将不隐藏）'); else ok('隐藏类随保存落盘');
    await page.reload();
    await page.waitForSelector('#ed-pane-review .jp-item');
    const after = await page.evaluate(() => document.querySelector('#ed-pane-review .jp-st').textContent);
    if (!/已接受/.test(after)) bad('刷新后审阅状态丢失：' + after); else ok('刷新后审阅状态保留');
    await ctx.close();
  }

  // ===== 5. 导航无障碍与交互细节 =====
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base + '/edit?id=' + ED_DOC);
    await page.waitForSelector('#ed-navlist .ed-nav');
    const nested = await page.evaluate(() => document.querySelectorAll('#ed-navlist button button').length);
    if (nested) bad('章节导航存在嵌套按钮：' + nested); else ok('章节导航无嵌套按钮（无障碍）');
    const entries = await page.evaluate(() => document.querySelectorAll('#ed-navlist .ed-nav-entry').length);
    if (entries < 2) bad('条目级积木未渲染：' + entries); else ok('条目级排序/隐藏入口已渲染');
    const zoom = await page.evaluate(() => document.querySelector('#ed-zval').type);
    if (zoom !== 'number') bad('缩放数值输入缺失'); else ok('缩放支持数值输入');
    await page.evaluate(() => { const z = document.getElementById('ed-zval'); z.value = '80'; z.dispatchEvent(new Event('change')); });
    const sheetZoom = await page.evaluate(() => document.querySelector('.sheet').style.zoom);
    if (sheetZoom !== '0.8') bad('缩放数值输入未生效：' + sheetZoom); else ok('缩放数值输入生效');
    // 岗位草稿入口（不依赖模型）
    const jobBtnExists = await page.evaluate(() => !!document.getElementById('ed-jobbtn') || !!document.querySelector('.ed-jobbtn'));
    if (!jobBtnExists) bad('编辑器缺岗位草稿入口'); else ok('编辑器提供岗位草稿入口');
    await page.click('.ed-jobbtn');
    await page.waitForSelector('#ed-jobpop input', { timeout: 3000 });
    const dlgFocus = await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label'));
    if (dlgFocus !== '公司') bad('岗位弹层未聚焦首字段'); else ok('岗位弹层焦点管理正确');
    const modal = await page.evaluate(() => document.getElementById('ed-jobpop').getAttribute('aria-modal'));
    if (modal !== 'true') bad('岗位弹层缺 aria-modal'); else ok('岗位弹层具备模态语义');
    await ctx.close();
  }
} finally {
  await browser.close();
}
if (failures) { console.error('❌ 浏览器级验证失败 ' + failures + ' 项'); process.exit(1); }
console.log('浏览器级验证全部通过');
