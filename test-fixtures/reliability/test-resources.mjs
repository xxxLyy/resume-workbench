// test-fixtures/reliability/test-resources.mjs — 共享资源槽池（设计 RES-01..05）
// 覆盖：容量上限、FIFO、超时、幂等释放、跨池释放、withLease 异常释放、
//       逻辑取消不等于物理释放、模块级单例、并发峰值不超上限。
// 约束：零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ResourceBusy, ResourceLeaseError, createSlotPool, aiPool, renderPool } from '../../resource-slots.mjs';

// 脚本开头切到项目根：可从任意目录直接运行。
process.chdir(fileURLToPath(new URL('../../', import.meta.url)));

// 让微任务与定时器跑完一个回合（等 acquire 的 resolve 生效）。
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== A. 容量上限 =====
{
  const p = createSlotPool({ size: 2, name: 'cap' });
  const l1 = p.borrow();
  const l2 = p.borrow();
  assert.throws(() => p.borrow(), ResourceBusy, '池满时 borrow 必须抛 ResourceBusy');
  assert.equal(p.stats().active, 2, 'active 只能是 2');
  assert.equal(p.stats().size, 2);
  assert.equal(p.stats().name, 'cap');
  assert.deepEqual(p.stats(), { name: 'cap', size: 2, active: 2, waiting: 0 });
  // lease 形状：release() / released / name / id
  assert.equal(typeof l1.release, 'function');
  assert.equal(l1.released, false);
  assert.equal(l1.name, 'cap');
  assert.ok(l1.id);
  l1.release();
  l2.release();
  assert.equal(p.stats().active, 0, '释放后 active 归零');
}

// ===== B. FIFO：先等待者先拿到释放的槽 =====
{
  const q = createSlotPool({ size: 1, name: 'fifo', waitMs: 1000 });
  const hold = q.borrow();
  const order = [];
  const w1 = q.acquire().then((l) => { order.push('w1'); return l; });
  const w2 = q.acquire().then((l) => { order.push('w2'); return l; });
  assert.equal(q.stats().waiting, 2, '等待期间 waiting 计数必须可见');
  assert.equal(q.stats().active, 1);
  hold.release();
  await tick();
  assert.deepEqual(order, ['w1'], '先等待者先拿到槽');
  const l1 = await w1;
  l1.release();
  await tick();
  assert.deepEqual(order, ['w1', 'w2'], '第二个等待者接着拿到槽');
  const l2 = await w2;
  l2.release();
  assert.equal(q.stats().active, 0);
  assert.equal(q.stats().waiting, 0);
}

// ===== C. 超时：池满 + waitMs 用尽 → ResourceBusy =====
{
  const t = createSlotPool({ size: 1, name: 'timeout', waitMs: 40 });
  const held = t.borrow();
  await assert.rejects(t.acquire(), (e) => {
    assert.ok(e instanceof ResourceBusy, '必须是 ResourceBusy');
    assert.equal(e.code, 'RESOURCE_BUSY');
    assert.equal(e.httpCode, 429);
    return true;
  });
  assert.equal(t.stats().waiting, 0, '超时后排队数归零');
  assert.equal(t.stats().active, 1, '超时不得占用槽位');
  held.release();
  assert.equal(t.stats().active, 0);
}

// ===== D. 幂等释放 =====
{
  const d = createSlotPool({ size: 1, name: 'idem' });
  const dl = d.borrow();
  assert.equal(d.stats().active, 1);
  dl.release();
  assert.equal(d.stats().active, 0);
  assert.equal(dl.released, true);
  dl.release();   // 第二次：不抛错
  assert.equal(d.stats().active, 0, '重复释放不得再腾槽');
  dl.release();   // 第三次：仍不抛错
  assert.equal(d.stats().active, 0);
  assert.equal(d.stats().waiting, 0);
}

// ===== E. 跨池释放：别人的 lease 不能在本池释放 =====
{
  const pa = createSlotPool({ size: 1, name: 'pa' });
  const pb = createSlotPool({ size: 1, name: 'pb' });
  const la = pa.borrow();
  assert.throws(() => pb.release(la), ResourceLeaseError, '外池 lease 必须抛 ResourceLeaseError');
  assert.throws(() => pb.release({}), ResourceLeaseError, '伪造对象必须抛 ResourceLeaseError');
  assert.throws(() => pb.release(null), ResourceLeaseError);
  assert.equal(pa.stats().active, 1, '跨池释放不得影响原池');
  la.release();
  // 单例池同样如此
  const aiLease = aiPool.borrow();
  assert.throws(() => renderPool.release(aiLease), ResourceLeaseError, 'aiPool 的 lease 不能在 renderPool 释放');
  assert.equal(aiPool.stats().active, 1);
  aiLease.release();
}

// ===== F. withLease：fn 抛错也释放，返回 fn 的返回值 =====
{
  const f = createSlotPool({ size: 1, name: 'wl' });
  await assert.rejects(f.withLease(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(f.stats().active, 0, 'fn 抛错必须释放槽位');
  const v = await f.withLease(async () => 42);
  assert.equal(v, 42, 'withLease 必须返回 fn 的返回值');
  assert.equal(f.stats().active, 0);
}

// ===== G. RES-03/04：逻辑取消 ≠ 物理释放 =====
{
  const g = createSlotPool({ size: 1, name: 'cancel', waitMs: 2000 });
  const gl = g.borrow();
  // 调用方逻辑取消，但没有调用 release()：槽位必须继续被占用。
  await sleep(30);
  assert.equal(g.stats().active, 1, '逻辑取消不得自动腾空槽');
  assert.throws(() => g.borrow(), ResourceBusy, '取消后新任务仍拿不到槽');
  let settled = false;
  const pending = g.acquire().then(
    (l) => { settled = true; return l; },
    (e) => { settled = true; throw e; }
  );
  await sleep(30);
  assert.equal(settled, false, '未释放前另一个 acquire 必须继续等待');
  assert.equal(g.stats().waiting, 1);
  // 真正的物理释放：等待者立刻拿到槽
  gl.release();
  const got = await pending;
  assert.equal(got.name, 'cancel');
  assert.equal(settled, true);
  got.release();
  assert.equal(g.stats().active, 0);
  assert.equal(g.stats().waiting, 0);
}

// ===== H. withLease 在异步工作结束前不得释放槽 =====
{
  const h = createSlotPool({ size: 1, name: 'hold' });
  let seen = -1;
  await h.withLease(async () => {
    await sleep(20);
    seen = h.stats().active; // 此刻 fn 仍在跑
  });
  assert.equal(seen, 1, 'fn 仍在运行时槽必须被占用');
  assert.equal(h.stats().active, 0, 'fn 结束后槽才释放');
}

// ===== I. 模块级单例 =====
{
  assert.equal(aiPool.size, 2);
  assert.equal(renderPool.size, 2);
  assert.equal(aiPool.stats().name, 'ai');
  assert.equal(renderPool.stats().name, 'render');
  assert.equal(aiPool.activeCount, 0);
  assert.equal(renderPool.activeCount, 0);
  assert.equal(aiPool.waitingCount, 0);
}

// ===== J. 并发峰值：8 个任务，任何时刻不超过 2 个并发 =====
{
  const c = createSlotPool({ size: 2, name: 'peak' });
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 8 }, (_, i) => c.withLease(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    active -= 1;
    return i;
  }));
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7], '每个任务都必须拿到结果');
  assert.ok(maxActive <= 2, '任一时刻并发不得超过 2，实际 ' + maxActive);
  assert.equal(maxActive, 2, '并发必须真的用满 2 个槽（否则上面的断言无效）');
  assert.equal(c.stats().active, 0);
  assert.equal(c.stats().waiting, 0);
}

// ===== K. 模块不访问网络或磁盘（结构检查）=====
{
  const src = fs.readFileSync(new URL('../../resource-slots.mjs', import.meta.url), 'utf8');
  for (const bad of ['node:fs', 'node:http', 'node:net', 'fetch(']) {
    assert.equal(src.includes(bad), false, 'resource-slots.mjs 不得引入 ' + bad);
  }
}

console.log('PASS RES-01..05: capacity, FIFO, timeout, idempotent release, cross-pool, withLease, cancel!=release, singletons, peak');
