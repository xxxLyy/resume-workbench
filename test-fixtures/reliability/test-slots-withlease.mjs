// test-fixtures/reliability/test-slots-withlease.mjs — BL-P4-06 回归夹具
// 缺陷：withLease 自己先 claim（inUse=true）再进 fn，fn 内把同一凭证透传给下层
//       （llm.mjs:102 / server.mjs:870 的 pool.claim(lease) 模式）必然二次 claim
//       抛 ResourceLeaseError——用这个 helper 承接透传，下层调用全部打挂。
// 修法合同（调用面 grep 定夺：生产代码零调用点，但既有夹具 test-resources.mjs
//       F/H/J 段有调用 → 选「改语义」分支）：withLease 不再预先 claim，凭证以
//       未占用状态交给 fn 由下层自行 claim（透传不重复占用）；finally 只清理
//       自己签发的凭证（守卫版 unclaim + release），fn 抛错也释放、原始错误不被掩盖。
// 约束：零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ResourceLeaseError, createSlotPool } from '../../resource-slots.mjs';

// 脚本开头切到项目根：可从任意目录直接运行。
process.chdir(fileURLToPath(new URL('../../', import.meta.url)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== A. 透传主场景：fn 内下层 claim 同一凭证不再互斥（缺陷主场景）=====
{
  const p = createSlotPool({ size: 1, name: 'pass' });
  const v = await p.withLease(async (lease) => {
    const held = p.claim(lease); // 模拟 llm.mjs:102 / server.mjs:870 的下层透传 claim
    assert.equal(held, lease, '下层 claim 应返回同一凭证');
    p.unclaim(held); // 下层工作结束归还占用
    return 'ok';
  });
  assert.equal(v, 'ok', 'withLease 必须返回 fn 的返回值');
  assert.equal(p.stats().active, 0, 'withLease 结束后槽位必须腾出');
  console.log('  ✅ A. fn 内下层透传 claim 同一凭证 → 不再抛 ResourceLeaseError');
}

// ===== B. fn 收到的凭证未被预占用（新语义直接钉住）=====
{
  const p = createSlotPool({ size: 1, name: 'raw' });
  await p.withLease(async (lease) => {
    assert.equal(lease.inUse, false, '交给 fn 的凭证不得预先被 withLease 自己 claim');
    assert.equal(lease.released, false);
  });
  console.log('  ✅ B. fn 收到未占用（inUse=false）的凭证');
}

// ===== C. fn 抛错也释放（既有 F 段合同不回归）=====
{
  const p = createSlotPool({ size: 1, name: 'boom' });
  await assert.rejects(p.withLease(async () => { throw new Error('boom'); }), /boom/);
  assert.equal(p.stats().active, 0, 'fn 抛错必须释放槽位');
  const v = await p.withLease(async () => 42);
  assert.equal(v, 42);
  assert.equal(p.stats().active, 0);
  console.log('  ✅ C. fn 抛错也释放、返回值透传（既有合同不回归）');
}

// ===== D. fn 抛错且下层已 claim 未归还 → finally 守卫兜底，原始错误不被掩盖 =====
{
  const p = createSlotPool({ size: 1, name: 'guard' });
  let leaseSeen = null;
  await assert.rejects(
    p.withLease(async (lease) => {
      leaseSeen = lease;
      p.claim(lease); // 下层 claim 后 fn 中途抛错，没走到 unclaim
      throw new Error('work failed');
    }),
    /work failed/,
    'finally 兜底后抛出的必须是 fn 的原始错误'
  );
  assert.equal(leaseSeen.inUse, false, '兜底 unclaim 必须归还下层遗留的占用标记');
  assert.equal(leaseSeen.released, true, '兜底后凭证应已释放');
  assert.equal(p.stats().active, 0, 'fn 抛错后槽位必须腾出（不得因 inUse 遗留而卡死）');
  console.log('  ✅ D. 下层 claim 未归还 + fn 抛错 → finally 守卫兜底、原始错误透出');
}

// ===== E. 只释放自己签发的：fn 内占用外池凭证，withLease 不得越权清理 =====
{
  const pa = createSlotPool({ size: 1, name: 'own' });
  const pb = createSlotPool({ size: 1, name: 'other' });
  const lb = pb.borrow();
  await assert.rejects(
    pa.withLease(async (ownLease) => {
      assert.equal(ownLease.name, 'own');
      pb.claim(lb); // fn 自己占用外池凭证后抛错
      throw new Error('cross boom');
    }),
    /cross boom/
  );
  assert.equal(pa.stats().active, 0, '本池自己签发的凭证必须被释放');
  assert.equal(lb.inUse, true, 'withLease 不得越权 unclaim 外池凭证');
  assert.equal(pb.stats().active, 1, '外池容量账目不得被 withLease 改动');
  // 收尾归还原池
  assert.equal(pb.unclaim(lb), true);
  pb.release(lb);
  console.log('  ✅ E. 仅释放自己签发的凭证、不碰外池占用');
}

// ===== F. 异步工作结束前槽不腾空（既有 H 段合同不回归）=====
{
  const p = createSlotPool({ size: 1, name: 'hold' });
  let seen = -1;
  await p.withLease(async () => {
    await sleep(20);
    seen = p.stats().active; // fn 仍在跑
  });
  assert.equal(seen, 1, 'fn 运行中槽位必须保持占用');
  assert.equal(p.stats().active, 0, 'fn 结束后才释放');
  console.log('  ✅ F. 异步工作结束前槽不腾空（既有合同不回归）');
}

// ===== G. 并发峰值不超上限、结果齐全（既有 J 段合同不回归）=====
{
  const p = createSlotPool({ size: 1, name: 'peak1' });
  let active = 0;
  let maxActive = 0;
  const tasks = Array.from({ length: 8 }, (_, i) => p.withLease(async (lease) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const held = p.claim(lease); // 并发下每个任务的凭证都能被下层正常 claim
    assert.equal(held, lease);
    await sleep(2);
    p.unclaim(held);
    active -= 1;
    return i;
  }));
  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7], '每个任务都必须拿到结果');
  assert.ok(maxActive <= 1, '任一时刻并发不得超过 1，实际 ' + maxActive);
  assert.equal(p.stats().active, 0);
  console.log('  ✅ G. 并发峰值不超上限、透传 claim 下结果齐全（既有合同不回归）');
}

console.log('test-slots-withlease: 全部通过');
