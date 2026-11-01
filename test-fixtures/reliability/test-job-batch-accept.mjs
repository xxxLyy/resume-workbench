// test-job-batch-accept.mjs — 批量接受的 origText 必须按「批次前快照」（BL-P2-04，high）
// 背景：批量路径对共享同一 zid 的多条候选逐条 `anchorEl.textContent` 取 origText，第二条
// 起读到的是**第一条已应用后的文本**，而服务端按磁盘文本校验 → 必然 400 整批被拒。
// 修法：每个 zid 在批内首次遇到时快照文本，后续共用（与磁盘一致）。
import assert from 'node:assert/strict';
import { bootJobFixture } from './lib-job-boot.mjs';

const P1 = 'z11111111';
const ORIG = '甲乙丙丁';   // 同段两个不相交子串的候选：顺序应用互不冲突，origText 都应以磁盘文本为准

const h = await bootJobFixture({
  name: 'jba',
  fillDoc: (doc) => doc.replace('{{PROJECTS}}', () => `<p data-zid="${P1}">${ORIG}</p>`),
  changes: [
    { id: 'c1', kind: 'replace', zid: P1, before: '甲乙', after: 'AX', note: '改写一', level: 'normal' },
    { id: 'c2', kind: 'replace', zid: P1, before: '丙丁', after: 'CX', note: '改写二', level: 'normal' }
  ],
  zones: { [P1]: { zone: 'project', status: 'confirmed' } }
});

try {
  await h.reload();
  await h.page.click('#ed-pane-review button:has-text("批量接受")');
  await h.waitFor(async () => {
    const st = await h.serverState();
    const s1 = (st.job.changes.find((x) => x.id === 'c1') || {}).status;
    const s2 = (st.job.changes.find((x) => x.id === 'c2') || {}).status;
    return s1 === 'accepted' && s2 === 'accepted';
  }, 10000, '两条候选都落账为 accepted');

  const note = await h.noteText();
  assert.ok(!/400|origText|原文不符/.test(note), '批量接受不得因 origText 校验被拒，实际提示：' + note);
  // 磁盘上的正文应是两条改写都应用后的形态（AXCX）
  await h.waitFor(async () => (await h.paraText(P1)) === 'AXCX', 8000, '合并后正文为两条改写之和');
  const diskOk = h.diskHtml().includes('AXCX');
  assert.ok(diskOk, '磁盘正文应含两条改写（AXCX）');
  console.log('✅ 批量 origText 快照：同 zid 多条候选批量接受不再整批 400，全部落账且合并完整');
} finally {
  await h.browser.close().catch(() => {});
  h.cleanup();
}
