// resource-slots.mjs — 共享资源槽池（设计 RES-01..05）
// 契约：
//   1) 每进程唯一的 AI 槽池与渲染槽池，各 2 个并发（aiPool / renderPool）。
//   2) 获取 / 借用 / 释放分离：acquire 排队等待，borrow 拿不到就立刻抛 ResourceBusy。
//   3) 只有实际工作结束才释放：逻辑取消、任务超时、HTTP 断连都不等于释放。
//      本模块不提供自动过期，也不感知任务状态——释放时机由调用方决定。
//   4) lease 跨层透传：入口层拿到的 lease 往下传，底层函数不再二次获取。
// 约束：零 I/O、零依赖、零网络；不引入任何 npm 包。

export class ResourceBusy extends Error {
  constructor(message, pool) {
    super(message);
    this.name = 'ResourceBusy';
    this.code = 'RESOURCE_BUSY';
    this.httpCode = 429;
    this.pool = pool;
  }
}

export class ResourceLeaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResourceLeaseError';
    this.code = 'RESOURCE_LEASE_ERROR';
    this.httpCode = 500;
  }
}

// createSlotPool({ size, name, waitMs }) → 池对象
//   size   正整数容量（必填）
//   name   池名（写进 lease.name，便于日志定位）
//   waitMs acquire 排队等待上限，默认 5000ms；超时抛 ResourceBusy
export function createSlotPool({ size, name, waitMs = 5000 } = {}) {
  const limit = Number(size);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('槽池容量 size 必须是正整数');
  const poolName = String(name ?? 'pool');
  const timeoutMs = Number.isFinite(Number(waitMs)) ? Number(waitMs) : 5000;

  const owned = new WeakSet(); // 本池发放的 lease（按对象身份校验）
  const waiters = [];          // 等待队列，FIFO
  let active = 0;              // 当前占用槽数
  let seq = 0;                 // lease 自增 id

  function makeLease() {
    const lease = {
      id: ++seq,
      name: poolName,
      released: false, // 释放后变 true；调用方可读
      inUse: false,    // 已被某个执行器占用（同一凭证不能并发给两个执行器）
      release() { releaseLease(lease); },
    };
    owned.add(lease);
    return lease;
  }

  // claim — 执行器占用凭证（内部接口合同）：
  //   ① 必须是本池签发的真实 lease（对象身份校验，伪造的 {} 一律拒）
  //   ② 必须未释放
  //   ③ 必须未被其他执行器占用（同一凭证不能被两个执行器同时使用）
  // 校验失败抛 ResourceLeaseError；调用方必须在产生任何实际工作（模型请求/渲染子进程）之前 claim。
  function claim(lease) {
    if (!lease || typeof lease !== 'object' || !owned.has(lease))
      throw new ResourceLeaseError(`槽位不属于池 ${poolName}：凭证无效`);
    if (lease.name !== poolName)
      throw new ResourceLeaseError(`槽位不属于池 ${poolName}：凭证来自其他池`);
    if (lease.released)
      throw new ResourceLeaseError(`槽位 ${poolName} 的凭证已释放：不能用于新的工作`);
    if (lease.inUse)
      throw new ResourceLeaseError(`槽位 ${poolName} 的凭证正在被其他执行器使用：同一凭证不能并发使用`);
    lease.inUse = true;
    return lease;
  }
  // unclaim — 归还执行器占用（不释放槽位；槽位由 release 归还）
  function unclaim(lease) {
    if (lease && typeof lease === 'object' && lease.inUse) lease.inUse = false;
  }

  // 把空槽交给队首等待者。同步交接：槽位不空窗，等待方的 await 在微任务里继续。
  function grantNext() {
    if (active >= limit || waiters.length === 0) return;
    const w = waiters.shift();
    if (w.timer) { clearTimeout(w.timer); w.timer = null; }
    active += 1;
    w.resolve(makeLease());
  }

  function releaseLease(lease) {
    // 身份校验：本池发的 lease 才能释放（外池的、伪造的、拷贝的都不行）。
    if (!lease || typeof lease !== 'object' || !owned.has(lease)) {
      throw new ResourceLeaseError(`槽位不属于池 ${poolName}：不能释放他人或外池的 lease`);
    }
    // 使用期间不得释放容量（2026-10-28 补丁轮三）：
    //   执行器 claim 之后，槽位代表的是「真实工作还在跑」；此时释放会让容量虚增，
    //   第二个凭证就能拿到槽 —— 真实并发就突破了上限。
    //   拒绝时容量与等待队列都不变（先判后改）；执行结束先 unclaim 再 release。
    if (lease.inUse) {
      throw new ResourceLeaseError(`槽位 ${poolName} 的凭证正在被使用：执行结束（unclaim）前不得释放容量`);
    }
    if (lease.released) return; // 幂等：重复释放不抛错、不重复腾槽
    lease.released = true;
    active -= 1;
    grantNext();
  }

  // acquire：取一个槽；池满则排队等待，超时抛 ResourceBusy。
  function acquire() {
    if (active < limit) {
      active += 1; // 入口层先占容量，避免穿透到底层
      return Promise.resolve(makeLease());
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(new ResourceBusy(`槽池 ${poolName} 繁忙：等待 ${timeoutMs}ms 未获得槽位`, poolName));
      }, timeoutMs);
      waiters.push(w);
    });
  }

  // borrow：同步非阻塞取槽；池满立刻抛 ResourceBusy。
  function borrow() {
    if (active >= limit) throw new ResourceBusy(`槽池 ${poolName} 繁忙：没有空槽`, poolName);
    active += 1;
    return makeLease();
  }

  // withLease：acquire → fn(lease) → finally 释放。fn 抛错也释放。
  async function withLease(fn) {
    const lease = await acquire();
    try {
      claim(lease);   // 执行器占用（同一凭证不得并发给两个执行器）
      // 必须 await：槽位必须在 fn 的异步工作真正结束后才释放（RES-03/04）。
      return await fn(lease);
    } finally {
      unclaim(lease);
      releaseLease(lease);
    }
  }

  return {
    name: poolName,
    get size() { return limit; },
    get activeCount() { return active; },
    get waitingCount() { return waiters.length; },
    acquire,
    borrow,
    release: releaseLease,
    claim,
    unclaim,
    withLease,
    stats() { return { name: poolName, size: limit, active, waiting: waiters.length }; },
  };
}

// 模块级单例：每进程唯一，两个池各 2 个并发。
export const aiPool = createSlotPool({ size: 2, name: 'ai' });
export const renderPool = createSlotPool({ size: 2, name: 'render' });
