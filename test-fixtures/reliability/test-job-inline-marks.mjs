// test-job-inline-marks.mjs — 确认门/同步撤回不得掏空行内标记（BL-P2-05，high）
// 背景：needs-compare 确认门与同步撤回都用「整段 textContent 级替换」回写段落——
// __edReplaceText 按文本节点流拼接替换，行内 <b>/<em> 被掏成空壳（<b></b>）、文本散到壳外；
// 落账被拒时格式已永久丢失。修法：确认门路径改「段落 innerHTML 快照 + 整段干净替换」，
// 撤回恢复快照（标记完整回来）。
import assert from 'node:assert/strict';
import { bootJobFixture } from './lib-job-boot.mjs';

const P1 = 'z11111111';
const BEFORE_TEXT = '项目一：核心负责交易系统';

const h = await bootJobFixture({
  name: 'jim',
  fillDoc: (doc) => doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">项目一：<b>核心</b>负责交易系统</p>`),
  changes: [{ id: 'c1', kind: 'replace', zid: P1, before: BEFORE_TEXT, after: '项目一：资深负责交易系统', note: '改写建议', level: 'normal', baseSnapshot: '项目一：旧版本文本' }],
  zones: { [P1]: { zone: 'project', status: 'confirmed' } }
});

try {
  await h.reload();
  await h.trackSaves('reject409');
  // needs-compare → 先出确认门，点「确认接受（覆盖当前正文）」
  await h.page.click(h.acceptBtn('c1'));
  await h.page.click('#ed-pane-review button:has-text("确认接受")');
  await h.waitFor(async () => /注入/.test(await h.noteText()), 8000, '409 提示');
  await h.untrackSaves();

  // 409（未落账）→ 撤回复原：行内标记必须完整回来（不是空壳 <b></b>）
  const html = await h.paraHtml(P1);
  assert.ok(/<b[^>]*>核心<\/b>/.test(html), '拒绝路径撤回后行内标记应完整保留，实际：' + html);
  assert.ok(!/<b[^>]*><\/b>/.test(html), '不得留下空壳标记，实际：' + html);
  assert.equal(await h.paraText(P1), BEFORE_TEXT, '文本应回到原文');

  // 成功路径：合并后整段干净替换为候选文本（无空壳残留）
  h.resetFixture();
  await h.reload();
  await h.page.click(h.acceptBtn('c1'));
  await h.page.click('#ed-pane-review button:has-text("确认接受")');
  await h.waitFor(async () => {
    const st = await h.serverState();
    return (st.job.changes.find((x) => x.id === 'c1') || {}).status === 'accepted';
  }, 10000, 'c1 落账');
  await h.waitFor(async () => (await h.paraText(P1)).includes('资深负责'), 8000, '合并后正文为候选');
  const html2 = await h.paraHtml(P1);
  assert.ok(!/<b[^>]*><\/b>/.test(html2), '成功路径不得留下空壳标记，实际：' + html2);

  console.log('✅ 行内标记保真：确认门路径拒绝时标记完整恢复、成功时干净替换（无 <b></b> 空壳）');
} finally {
  await h.browser.close().catch(() => {});
  h.cleanup();
}
