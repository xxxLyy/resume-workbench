// test-job-withdraw-fail.mjs — 同步撤回失败必须被察觉并如实提示（BL-P2-02，high）
// 背景：runInv 的返回值在三处调用点全部被丢弃——撤回失败（返回 false）时未落账的候选
// 留在正文里，3 秒后自动保存把它写进磁盘，而拒绝提示仍写「页面保持原样」。
// 修法：记录 withdrawFailed，拒绝提示按实况改口；提交照发（页面与服务端一致）。
// 触发方式：包一层 __edReplaceText——正向（第 1 次）放行、反向（第 2 次）强制 false，
// 以确定性地演练「撤回失败」分支本身。
import assert from 'node:assert/strict';
import { bootJobFixture } from './lib-job-boot.mjs';

const P1 = 'z11111111';
const BEFORE = '项目一：原始内容';
const AFTER = '项目一：改写后的内容';

const h = await bootJobFixture({
  name: 'jwf',
  fillDoc: (doc) => doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">${BEFORE}</p>`),
  changes: [{ id: 'c1', kind: 'replace', zid: P1, before: BEFORE, after: AFTER, note: '改写建议', level: 'normal' }],
  zones: { [P1]: { zone: 'project', status: 'confirmed' } }
});

try {
  await h.reload();
  // 注入失败演练：__edMarkProgrammatic 第 1 次（正向）放行、第 2 次（撤回）抛错
  // → runInv 的 try/catch 捕获后返回 false，确定性地演练「撤回失败被察觉」分支
  await h.page.evaluate(() => {
    const orig = window.__edMarkProgrammatic;
    let n = 0;
    window.__edMarkProgrammatic = function () { n += 1; if (n >= 2) throw new Error('注入：撤回失败'); return orig.call(this); };
  });
  await h.trackSaves('reject409');
  await h.page.click(h.acceptBtn('c1'));
  await h.waitFor(async () => /注入/.test(await h.noteText()), 8000, '409 提示');
  await h.untrackSaves();

  const note = await h.noteText();
  assert.ok(!/页面保持原样/.test(note), '撤回失败后不得再宣称「页面保持原样」，实际提示：' + note);
  assert.ok(/未能恢复原样|仍在正文|随.*保存|未恢复/.test(note), '撤回失败必须如实告知（改动仍在正文/将随保存落盘），实际提示：' + note);

  console.log('✅ 撤回失败可见性：失败被察觉、提示如实（不再宣称页面保持原样）');
} finally {
  await h.browser.close().catch(() => {});
  h.cleanup();
}
