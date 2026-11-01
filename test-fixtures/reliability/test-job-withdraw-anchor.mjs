// test-job-withdraw-anchor.mjs — 同步撤回必须精确回到正向改动处（BL-P2-01，high）
// 背景（实测反例）：段落「负责维护与运维」，候选 before=运维/after=维护 →
// 正向首处替换得「负责维护与维护」；撤回按**首个**「维护」回退 →「负责运维与维护」← 原文被改乱；
// 服务端拒绝后面板仍提示「页面保持原样」，3 秒自动保存把改乱正文写进磁盘。
// 修法：replace 的逆操作改「段落 innerHTML 快照恢复」（位置精确、行内标记保真）。
import assert from 'node:assert/strict';
import { bootJobFixture } from './lib-job-boot.mjs';

const P1 = 'z11111111';

const h = await bootJobFixture({
  name: 'jwa',
  fillDoc: (doc) => doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">负责维护与运维</p>`),
  changes: [{ id: 'c1', kind: 'replace', zid: P1, before: '运维', after: '维护', note: '改写建议', level: 'normal' }],
  zones: { [P1]: { zone: 'project', status: 'confirmed' } }
});

try {
  // ① 拒绝路径：撤回后段落必须与原文逐字一致（不是「首个匹配回退」的改乱形态）
  await h.reload();
  await h.trackSaves('reject409');
  await h.page.click(h.acceptBtn('c1'));
  await h.waitFor(async () => /注入/.test(await h.noteText()), 8000, '409 提示');
  await h.untrackSaves();
  assert.equal(await h.paraText(P1), '负责维护与运维', '拒绝路径撤回后应为原文，实际：' + await h.paraText(P1));

  // ② 自动保存不固化改乱：等一个自动保存周期后，磁盘仍是原文
  await h.page.waitForTimeout(4600);
  const disk = h.diskHtml();
  assert.ok(disk.includes('负责维护与运维'), '自动保存后磁盘应仍是原文，实际片段：' + disk.slice(disk.indexOf('负责维护'), disk.indexOf('负责维护') + 30));
  assert.ok(!disk.includes('负责运维与维护'), '磁盘不得出现改乱形态「负责运维与维护」');

  // ③ 成功路径：落账合并后段落为改后文本且仍逐字正确
  h.resetFixture();
  await h.reload();
  await h.page.click(h.acceptBtn('c1'));
  await h.waitFor(async () => {
    const st = await h.serverState();
    return (st.job.changes.find((x) => x.id === 'c1') || {}).status === 'accepted';
  }, 10000, 'c1 落账');
  await h.waitFor(async () => (await h.paraText(P1)) === '负责维护与维护', 8000, '合并后为改后文本');

  console.log('✅ 同步撤回精确性：拒绝路径逐字复原（含同段 before/after 交叉反例）、自动保存不固化改乱、成功路径合并正确');
} finally {
  await h.browser.close().catch(() => {});
  h.cleanup();
}
