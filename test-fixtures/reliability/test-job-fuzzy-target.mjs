// test-job-fuzzy-target.mjs — hide/reorder 落点必须优先用服务端解析好的 zid（BL-P2-03，high）
// 背景：findEntry 按「章节名/条目标题双向子串模糊匹配」定位，忽略候选自带的精确 zid →
// 同名/子标题条目场景隐藏/移动错条目并写进磁盘，候选状态却记在正确条目上（复核 13174 已复现）。
// 场景：两个条目标题互为子串（「合成公司」与「合成公司华东分部」），候选 zid 指向第二个、
// entry 文本只写短名（模糊匹配会命中第一个）。
import assert from 'node:assert/strict';
import { bootJobFixture } from './lib-job-boot.mjs';

const EH1 = 'z22222222';   // 「合成公司」（文档序在前，模糊匹配会先命中它）
const EH2 = 'z44444444';   // 「合成公司华东分部」（zid 真正指向的目标）

const h = await bootJobFixture({
  name: 'jft',
  fillDoc: (doc) => doc.replace('{{WORK}}', () => `
<div class="entry-head" data-zid="${EH1}"><div class="entry-title">合成公司</div><div class="entry-role">工程师</div></div>
<ul><li data-zid="z33333333">工作段一：负责交易系统</li></ul>
<div class="entry-head" data-zid="${EH2}"><div class="entry-title">合成公司华东分部</div><div class="entry-role">负责人</div></div>
<ul><li data-zid="z55555555">工作段二：负责风控</li></ul>`),
  changes: [
    { id: 'c1', kind: 'hide', zid: EH2, section: '工作经历', entry: '合成公司', before: '合成公司华东分部', after: '', note: '隐藏分部', level: 'normal' },
    { id: 'c2', kind: 'reorder', zid: EH2, section: '工作经历', entry: '合成公司', to: 'top', before: '', after: '', note: '分部置顶', level: 'normal' }
  ],
  zones: { [EH1]: { zone: 'work', status: 'confirmed' }, [EH2]: { zone: 'work', status: 'confirmed' } }
});

const hiddenOf = (zid) => h.page.$eval('.sheet [data-zid="' + zid + '"]', (el) => el.classList.contains('ed-entry-hidden'));

try {
  // ① hide：接受并真实落账 → 合并后只有 zid 指向的 EH2 被隐藏
  await h.reload();
  await h.page.click(h.acceptBtn('c1'));
  await h.waitFor(async () => {
    const st = await h.serverState();
    return (st.job.changes.find((x) => x.id === 'c1') || {}).status === 'accepted';
  }, 10000, 'c1 落账');
  assert.equal(await hiddenOf(EH2), true, 'zid 指向的条目（华东分部）应被隐藏');
  assert.equal(await hiddenOf(EH1), false, '模糊匹配的误命中条目（合成公司）不得被隐藏');

  // ② reorder：接受并落账 → EH2 移到条目首位（当前代码会把 EH1 挪到首位）
  h.resetFixture();
  await h.reload();
  await h.page.click(h.acceptBtn('c2'));
  await h.waitFor(async () => {
    const st = await h.serverState();
    return (st.job.changes.find((x) => x.id === 'c2') || {}).status === 'accepted';
  }, 10000, 'c2 落账');
  await h.page.waitForTimeout(400);
  const firstHead = await h.page.$eval('.sheet .section .entry-head', (el) => el.getAttribute('data-zid'));
  assert.equal(firstHead, EH2, '排序后首位应是 zid 指向的条目（华东分部），实际首位：' + firstHead);

  console.log('✅ hide/reorder zid 落点：zid 优先于标题模糊匹配，同名子串场景不再隐藏/移动错条目');
} finally {
  await h.browser.close().catch(() => {});
  h.cleanup();
}
