// test-fixtures/reliability/test-lease.mjs — 资源凭证合同（内部接口，2026-10-28 补丁轮）
// 合同：透传的 lease 必须①本池签发的真实凭证 ②未释放 ③未被其他执行器占用；
//       校验不通过 → 抛错，且**不产生任何模型/渲染工作**。
// 说明：这是内部接口合同 —— lease 不来自 HTTP 外部输入，外部无法伪造；
//       本用例证明的是「底层不得只判 truthy 就放行」。
// 约束：零外网、零真实模型、只用本机回环桩与临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chatMsgs } from '../../llm.mjs';
import { aiPool, renderPool, ResourceLeaseError, createSlotPool } from '../../resource-slots.mjs';

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// 本机假 LLM：计数收到的请求（用来证明「无效凭证不产生模型工作」）
let hits = 0;
const llm = http.createServer(async (req, res) => {
  hits++;
  for await (const c of req) { /* 读完请求体 */ }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-lease-'));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  active: 0,
  profiles: [{ name: 'stub', baseURL: `http://127.0.0.1:${llm.address().port}/v1`, apiKey: 'stub-key-not-real', model: 'stub-model' }]
}));
const msg = [{ role: 'user', content: '凭证合同用例' }];
const cleanup = () => { try { llm.close(); } catch {} try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };
process.on('exit', cleanup);

// ===== ① 伪造凭证（普通对象）→ 拒绝，且零模型请求 =====
{
  hits = 0;
  let threw = null;
  try { await chatMsgs(root, msg, { lease: {} }); } catch (e) { threw = e; }
  assert.ok(threw, '伪造凭证必须被拒');
  assert.ok(threw instanceof ResourceLeaseError, '必须是凭证错误，实际：' + threw.name + ' ' + threw.message);
  assert.equal(hits, 0, '无效凭证不得产生模型请求（实际发出 ' + hits + ' 次）');
  console.log('  ✅ 伪造凭证 → 拒绝且零模型请求');
}

// ===== ② 其他池的凭证 → 拒绝，且零模型请求 =====
{
  hits = 0;
  const other = renderPool.borrow();
  let threw = null;
  try { await chatMsgs(root, msg, { lease: other }); } catch (e) { threw = e; }
  renderPool.release(other);
  assert.ok(threw instanceof ResourceLeaseError, '跨池凭证必须被拒，实际：' + (threw && threw.message));
  assert.equal(hits, 0, '跨池凭证不得产生模型请求');
  console.log('  ✅ 跨池凭证 → 拒绝且零模型请求');
}

// ===== ③ 已释放的凭证 → 拒绝，且零模型请求 =====
{
  hits = 0;
  const dead = aiPool.borrow();
  aiPool.release(dead);
  let threw = null;
  try { await chatMsgs(root, msg, { lease: dead }); } catch (e) { threw = e; }
  assert.ok(threw instanceof ResourceLeaseError, '已释放的凭证必须被拒，实际：' + (threw && threw.message));
  assert.equal(hits, 0, '已释放凭证不得产生模型请求');
  console.log('  ✅ 已释放凭证 → 拒绝且零模型请求');
}

// ===== ④ 正在被别的执行器占用的凭证 → 拒绝（同一凭证不能并发给两个执行器）=====
{
  hits = 0;
  const busy = aiPool.borrow();
  aiPool.claim(busy);                       // 模拟另一个执行器已经占用
  let threw = null;
  try { await chatMsgs(root, msg, { lease: busy }); } catch (e) { threw = e; }
  aiPool.unclaim(busy);
  aiPool.release(busy);
  assert.ok(threw instanceof ResourceLeaseError, '被占用的凭证必须被拒，实际：' + (threw && threw.message));
  assert.equal(hits, 0, '被占用的凭证不得产生模型请求');
  console.log('  ✅ 被占用凭证 → 拒绝（同一凭证不并发）且零模型请求');
}

// ===== ⑤ 合法凭证 → 正常放行 =====
{
  hits = 0;
  const ok = aiPool.borrow();
  const out = await chatMsgs(root, msg, { lease: ok });
  aiPool.release(ok);
  assert.equal(out, 'OK', '合法凭证必须正常返回');
  assert.equal(hits, 1, '合法凭证应发出一次模型请求');
  console.log('  ✅ 合法凭证 → 正常放行');
}

// ===== ⑥ 池满时：底层兜底取槽要等，且超时抛 ResourceBusy（不产生模型请求）=====
{
  hits = 0;
  const a = aiPool.borrow(), b = aiPool.borrow();
  let threw = null;
  try {
    // 底层兜底路径（不传 lease）：池满 → 排队 → 5s 超时
    await chatMsgs(root, msg);
  } catch (e) { threw = e; }
  aiPool.release(a); aiPool.release(b);
  assert.ok(threw, '池满且无凭证时必须失败');
  assert.equal(hits, 0, '池满时不得产生模型请求');
  console.log('  ✅ 池满 → 兜底取槽失败且零模型请求');
}

// ===== ⑦ 渲染池同合同（同一个 claim 实现）=====
{
  let threw = null;
  try { renderPool.claim({}); } catch (e) { threw = e; }
  assert.ok(threw instanceof ResourceLeaseError, '渲染池也必须校验凭证，实际：' + (threw && threw.message));
  const r = renderPool.borrow();
  renderPool.claim(r);
  let threw2 = null;
  try { renderPool.claim(r); } catch (e) { threw2 = e; }
  renderPool.unclaim(r);
  renderPool.release(r);
  assert.ok(threw2 instanceof ResourceLeaseError, '渲染池同一凭证不得并发，实际：' + (threw2 && threw2.message));
  console.log('  ✅ 渲染池同合同（校验 + 不并发）');
}

// ===== ⑧ 使用期间不得释放容量 =====
{
  // 8-a 容量 1 的池：借出 → 占用 → 释放必须被拒 → 第二个凭证拿不到槽
  const one = createSlotPool({ size: 1, name: 'one' });
  const l = one.borrow();
  one.claim(l);
  let threw = null;
  try { l.release(); } catch (e) { threw = e; }
  assert.ok(threw, '执行期间 release 必须被拒');
  assert.ok(threw instanceof ResourceLeaseError, '必须是凭证错误，实际：' + (threw && threw.message));
  assert.equal(one.stats().active, 1, '被拒的 release 不得让容量虚增');
  assert.equal(l.released, false, '被拒的 release 不得把凭证标记为已释放');
  // 容量仍是 1 → 第二个凭证拿不到（必须排队，不是立刻拿到）
  let second = null;
  try { second = one.borrow(); } catch (e) { second = null; }
  assert.equal(second, null, '被拒的 release 之后第二个凭证仍能拿到槽（容量已被虚增）');
  // 执行结束：unclaim → release 成功 → 槽位归还
  one.unclaim(l);
  l.release();
  assert.equal(one.stats().active, 0, 'unclaim 后 release 应真正腾出槽位');
  l.release();                                   // 重复释放仍幂等
  assert.equal(one.stats().active, 0, '重复释放不得重复腾槽');
  console.log('  ✅ ⑧ 使用期间 release 被拒（容量与等待者状态不变），结束后释放成功');
}

// ===== ⑨ 共享池上同样成立 =====
{
  const l = aiPool.borrow();
  aiPool.claim(l);
  const before = aiPool.stats();
  assert.throws(() => l.release(), (e) => e instanceof ResourceLeaseError);
  const after = aiPool.stats();
  assert.equal(after.active, before.active, '共享池上被拒的 release 不得改变容量');
  assert.equal(after.waiting, before.waiting, '共享池上被拒的 release 不得改变等待者状态');
  aiPool.unclaim(l);
  l.release();
  assert.equal(aiPool.stats().active, before.active - 1, 'unclaim 后 release 应真正腾出槽位');
  l.release();
  assert.equal(aiPool.stats().active, before.active - 1, '重复释放不得重复腾槽');
  console.log('  ✅ ⑨ 共享池：使用期间 release 被拒、结束后释放成功、重复释放幂等');
}

console.log('PASS 资源凭证合同: 伪造/跨池/已释放/被占用一律拒绝且零工作 + 合法凭证放行 + 使用期间不得释放容量');
cleanup();
process.exit(0);
