// test-fixtures/reliability/test-slots-unclaim-guard.mjs — BL-P4-04 回归夹具
// 缺陷：unclaim 不校验凭证归属（合同三条件①本池签发②未释放③当前被占用一个不查），
//       跨池 unclaim 能把别的池凭证的 inUse 清成 false → 同一凭证随后可被第二个
//       执行器并发 claim → 容量上限被突破（总账 BL-P4-04）。
// 修法合同：unclaim 补合同三条件，任一不满足 → 返回 false、状态分文不动；
//       合法归还 → 返回 true；重复 unclaim 幂等；不抛错（与既有调用方 try/catch 兼容）。
// 约束：零 I/O、零依赖；不启动服务、不调用模型、不读真实数据。
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ResourceLeaseError, createSlotPool, aiPool, renderPool } from '../../resource-slots.mjs';

// 脚本开头切到项目根：可从任意目录直接运行。
process.chdir(fileURLToPath(new URL('../../', import.meta.url)));

// ===== A. 跨池 unclaim 不动状态（缺陷主场景）=====
{
  const pa = createSlotPool({ size: 1, name: 'pa' });
  const pb = createSlotPool({ size: 1, name: 'pb' });
  const lb = pb.borrow();
  pb.claim(lb); // 执行器一号占用中
  assert.equal(lb.inUse, true, '前置：claim 后 inUse 应为 true');
  const r = pa.unclaim(lb); // A 池试图归还 B 池的凭证
  assert.equal(r, false, '跨池 unclaim 必须返回 false');
  assert.equal(lb.inUse, true, '跨池 unclaim 不得清掉别的池凭证的占用标记');
  // 容量上限不被突破：第二个执行器并发 claim 同一凭证必须被拒
  assert.throws(
    () => pb.claim(lb),
    ResourceLeaseError,
    '跨池 unclaim 之后同一凭证不得被第二个执行器并发 claim'
  );
  // 合法路径收尾：本池 unclaim → release
  assert.equal(pb.unclaim(lb), true, '本池合法 unclaim 返回 true');
  pb.release(lb);
  assert.equal(pb.stats().active, 0, 'A 池越权不得影响 B 池容量账目');
  assert.equal(pa.stats().active, 0);
  console.log('  ✅ A. 跨池 unclaim 返回 false、状态不动、容量上限不被突破');
}

// ===== B. 伪造 / 异常入参：返回 false、不抛错 =====
{
  const p = createSlotPool({ size: 1, name: 'fake' });
  assert.equal(p.unclaim(null), false);
  assert.equal(p.unclaim(undefined), false);
  assert.equal(p.unclaim({}), false, '伪造空对象 unclaim 返回 false');
  assert.equal(p.unclaim({ inUse: true }), false, '伪造 inUse 的裸对象 unclaim 返回 false');
  assert.equal(p.stats().active, 0, '伪造入参不得改变容量账目');
  console.log('  ✅ B. 伪造/异常入参 unclaim 幂等无效（返回 false 不抛错）');
}

// ===== C. 未占用凭证（inUse=false）unclaim → false、状态不动 =====
{
  const p = createSlotPool({ size: 1, name: 'idle' });
  const l = p.borrow(); // 借了槽但执行器尚未 claim
  assert.equal(l.inUse, false, '前置：未 claim 的凭证 inUse 应为 false');
  assert.equal(p.unclaim(l), false, '未占用凭证 unclaim 返回 false');
  assert.equal(l.inUse, false);
  p.release(l);
  assert.equal(p.stats().active, 0);
  console.log('  ✅ C. 未占用凭证 unclaim 返回 false、状态不动');
}

// ===== D. 已释放凭证 unclaim → false（不得复活）=====
{
  const p = createSlotPool({ size: 1, name: 'dead' });
  const l = p.borrow();
  p.claim(l);
  assert.equal(p.unclaim(l), true);
  p.release(l);
  assert.equal(p.unclaim(l), false, '已释放凭证 unclaim 返回 false');
  assert.equal(l.released, true, '已释放凭证不得被 unclaim 复活');
  assert.equal(p.stats().active, 0);
  console.log('  ✅ D. 已释放凭证 unclaim 返回 false、不复活');
}

// ===== E. 合法归还返回 true；重复 unclaim 幂等 =====
{
  const p = createSlotPool({ size: 1, name: 'ok' });
  const l = p.borrow();
  p.claim(l);
  assert.equal(p.unclaim(l), true, '合法归还返回 true');
  assert.equal(l.inUse, false);
  assert.equal(p.unclaim(l), false, '重复 unclaim 幂等：第二次返回 false');
  assert.equal(l.inUse, false, '重复 unclaim 状态不变');
  p.release(l); // 腾槽后再验 release 先后合同
  // 既有合同不回归：使用中（inUse=true）release 仍被拒，unclaim 后 release 才腾槽
  const l2 = p.borrow();
  p.claim(l2);
  assert.throws(() => p.release(l2), ResourceLeaseError, '使用中 release 仍必须被拒');
  p.unclaim(l2);
  p.release(l2);
  assert.equal(p.stats().active, 0);
  console.log('  ✅ E. 合法归还 true、重复 unclaim 幂等、release 先后合同不回归');
}

// ===== F. 模块级单例池同样互不越界 =====
{
  const aiLease = aiPool.borrow();
  aiPool.claim(aiLease);
  assert.equal(renderPool.unclaim(aiLease), false, 'aiPool 凭证在 renderPool unclaim 必须无效');
  assert.equal(aiLease.inUse, true, '跨池 unclaim 后共享池凭证占用标记不变');
  assert.equal(aiPool.unclaim(aiLease), true);
  aiPool.release(aiLease);
  console.log('  ✅ F. 单例池 aiPool/renderPool 互不越界');
}

// ===== G. withLease 内部路径不回归（自签发 + 占用中 → 归还成功、槽位正常腾出）=====
{
  const p = createSlotPool({ size: 1, name: 'wl' });
  const v = await p.withLease(async () => 'done');
  assert.equal(v, 'done', 'withLease 返回值透传');
  assert.equal(p.stats().active, 0, 'withLease 结束后槽位必须腾出');
  console.log('  ✅ G. withLease 内部 unclaim→release 链路不回归');
}

console.log('test-slots-unclaim-guard: 全部通过');
