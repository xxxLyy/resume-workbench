// test-eval-promote-brief-ui.mjs — F2 面板「本次重点（来自评估报告，可逐条删除）」行（验收②）
// 验收口径：面板渲染 focus 行；逐条删除 → POST /job/brief 回写 → GET /job/changes 反映更新；
//           逐条删空后行消失（focus=[]）。清空 = 逐条删完的等价路径，不新增输入框，仅呈现与删除。
// 预填落库（promote → meta.job.brief.focus）由 test-eval-promote-brief.mjs 覆盖；本夹具直接落
// 同形状的 meta.job.brief（normBrief 产物），只测面板行为。浏览器夹具：复用 lib-job-boot.mjs
// （隔离根 + 合成岗位草稿 + 随机端口 + 真实 Chromium）；Chromium 不可用 exit 2。
import assert from 'node:assert/strict';
import { bootJobFixture } from './lib-job-boot.mjs';

const BRIEF = { focus: ['突出高并发交易系统经验', '补充量化指标', '补充领域证书'], keepProjects: [], deemphasize: [], degree: 'refocus', pages: 2, preset: null };
const h = await bootJobFixture({
  name: 'evbrief-ui',
  fillDoc: (d) => d.replace('{{WORK}}', () => '<p data-zid="z11111111">工作经历：负责交易系统</p>'),
  changes: [],
  metaExtra: {
    // 面板默认段 = evidence（job-panel:1118，changes 空时）；「生成按钮区」在修改清单段 →
    // job.reviewPos.section='changes' 让面板直接落在修改清单段（reviewPos 是 job 内字段，jobView 渐进默认）
    job: { changes: [], evidence: [], materials: [], todos: [], feedback: [], genTasks: {}, brief: BRIEF, generatedAt: null, deliveredAt: null, reviewPos: { section: 'changes', changeId: null, filter: 'all' } }
  }
});

try {
  await h.reload();

  const focusRows = () => h.page.$$eval('[data-brief-focus]', (els) => els.map((e) => e.textContent.replace(/删除|清空/g, '').trim()));
  const delCount = () => h.page.$$eval('[data-brief-del]', (els) => els.length);
  const hasHead = () => h.page.evaluate(() => (document.querySelector('#ed-pane-review') || { textContent: '' }).textContent.includes('本次重点（来自评估报告，可逐条删除）'));

  // ② 行渲染：标题 + 3 条 focus 条目
  await h.waitFor(async () => hasHead(), 8000, '「本次重点（来自评估报告，可逐条删除）」行渲染');
  assert.deepEqual(await focusRows(), ['突出高并发交易系统经验', '补充量化指标', '补充领域证书'],
    '② focus 行应逐条呈现预填条目，实际：' + JSON.stringify(await focusRows()));

  // ② 逐条删除第一条 → POST /job/brief 回写 → GET /job/changes 反映更新
  await h.page.click('[data-brief-del="0"]');
  await h.waitFor(async () => (await delCount()) === 2, 8000, '删除后面板剩 2 条');
  const st = await h.serverState();
  assert.deepEqual(st.job.brief.focus, ['补充量化指标', '补充领域证书'],
    '② 删除一条后服务端 brief.focus 应反映更新，实际：' + JSON.stringify(st.job.brief));
  assert.ok(!st.job.brief.focus.includes('突出高并发交易系统经验'), '② 被删条目不得残留在服务端 focus');

  // ② 继续删空 → focus=[] 且行消失
  await h.page.click('[data-brief-del="0"]');
  await h.waitFor(async () => (await delCount()) === 1, 8000, '第二次删除后剩 1 条');
  await h.page.click('[data-brief-del="0"]');
  await h.waitFor(async () => !(await hasHead()), 8000, '删空后「本次重点」行消失');
  const st2 = await h.serverState();
  assert.deepEqual(st2.job.brief.focus, [], '② 删空后服务端 focus 应为空数组');

  console.log('✅ F2 面板本次重点行：预填条目逐条呈现 / 删除回写 /job/brief 且 GET /job/changes 反映 / 删空后行消失');
} finally {
  await h.browser.close().catch(() => {});
  h.cleanup();
}
