// test-job-reject-chips.mjs — 拒绝原因 chips 必须跨面板重建存活（BL-P2-06，medium）
// 背景：chips（含自定义原因输入框）是点击「跳过…」后插入的；面板任一 render() 整体重建
// 后 chips 连容器一起消失，A9 的在途输入回填因「元素数量已变」整体放弃 → 用户输入被丢。
// 修法：chips 开启状态（changeId）登记进面板状态，render() 在 A9 回填**之前**重开 chips，
// 让输入框回到 DOM —— A9 的按位回填自然接住值与焦点。
import assert from 'node:assert/strict';
import { bootJobFixture } from './lib-job-boot.mjs';

const P1 = 'z11111111';

const h = await bootJobFixture({
  name: 'jrc',
  fillDoc: (doc) => doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">项目一：原始内容</p>`),
  changes: [
    { id: 'c1', kind: 'replace', zid: P1, before: '项目一：原始内容', after: '项目一：改写', note: '改写建议', level: 'normal' },
    { id: 'c2', kind: 'replace', zid: P1, before: '项目一：原始内容', after: '项目一：再改写', note: '改写建议二', level: 'normal' }
  ],
  zones: { [P1]: { zone: 'project', status: 'confirmed' } }
});

try {
  await h.reload();
  // 打开 c1 的拒绝 chips，输入自定义原因（不提交）
  await h.page.click('#ed-pane-review [data-change="c1"] button:has-text("跳过…")');
  const input = h.page.locator('#ed-pane-review [data-change="c1"] .jp-chips input');
  await input.waitFor({ timeout: 5000 });
  await input.fill('语气不符');
  // 触发一次面板重建：对 c2 点「稍后处理」→ setStatus 成功 → render()
  await h.page.click('#ed-pane-review [data-change="c2"] button:has-text("稍后处理")');
  await h.waitFor(async () => {
    const st = await h.serverState();
    return (st.job.changes.find((x) => x.id === 'c2') || {}).status === 'skipped';
  }, 8000, 'c2 状态写回');

  // chips 应仍在（重开），输入值保留，焦点在
  const input2 = h.page.locator('#ed-pane-review [data-change="c1"] .jp-chips input');
  await input2.waitFor({ timeout: 5000 });
  assert.equal(await input2.inputValue(), '语气不符', '重建后自定义原因应保留');
  const focused = await h.page.evaluate(() => {
    var a = document.activeElement;
    return !!(a && a.nodeType === 1 && document.querySelector('#ed-pane-review') && document.querySelector('#ed-pane-review').contains(a) && a.tagName === 'INPUT');
  });
  assert.ok(focused, '重建后焦点应回到 chips 输入框');

  // 重开后的 chips 仍可用：提交自定义原因 → c1 状态 rejected
  await h.page.click('#ed-pane-review [data-change="c1"] .jp-chips button:has-text("跳过")');
  await h.waitFor(async () => {
    const st = await h.serverState();
    return (st.job.changes.find((x) => x.id === 'c1') || {}).status === 'rejected';
  }, 8000, 'c1 以自定义原因被跳过');

  console.log('✅ 拒绝原因 chips 存活：面板重建后 chips 重开、输入与焦点保留、可继续提交');
} finally {
  await h.browser.close().catch(() => {});
  h.cleanup();
}
