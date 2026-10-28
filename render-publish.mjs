/**
 * render-publish.mjs — PDF + 旁车成对发布（失败回滚）
 *
 * 为什么需要（审计 AUD-07）：
 *   render.mjs 自己写 PDF 再写旁车，两次 rename 分离。注入 ENOSPC 时 PDF 已替换、旧旁车还在 →
 *   留下「新 PDF + 旧旁车」的混合产物。两次 rename **不是**天然原子的，不能口头声称。
 *   处置：调用方把本次渲染的 PDF/旁车先落到临时文件，再由本模块成对发布：
 *     备份旧产物 → 暂存新产物 → 逐个替换 → 任一步失败即回滚（恢复旧产物、删除暂存文件）。
 *
 * 发布顺序：**先旁车，后 PDF**。
 *   任何时刻磁盘上都不会出现「新 PDF + 旧旁车」；最坏状态是「旧 PDF + 新旁车」
 *   （PDF 比旁车旧，消费方按 renderInputId 判定为不一致并重渲）。
 *   失败时回滚 → 旧 PDF + 旧旁车（两者都是上一次成功产物，成对且一致）。
 *
 * 失败原因枚举：
 *   'missing-tmp' 临时文件缺失/不是普通文件（未触碰目标产物）
 *   'validate'    成对身份校验未通过（未触碰目标产物）
 *   'rename'      发布阶段失败（暂存或替换任一步），已回滚
 *   'rollback'    发布失败且回滚不完整（目标产物状态未知，需人工介入）
 */
import fs from 'node:fs';
import path from 'node:path';

const BAK = '.bak-';
const NEW = '.new-';

/**
 * 读旁车身份 → { renderInputId, at, raw } | null
 * 解析失败（文件不存在/坏 JSON/不是对象）返回 null，不抛。
 */
export function readSidecarIdentity(sidecarPath) {
  try {
    const raw = fs.readFileSync(sidecarPath, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return {
      renderInputId: obj.renderInputId ?? null,
      at: obj.at ?? null,
      raw: obj
    };
  } catch {
    return null;
  }
}

/**
 * 成对身份校验器（给 publishPair 的 validate 用）。
 * 校验两件事：
 *   ① 旁车的 renderInputId 等于本次渲染期望的标识（旁车属于这次渲染，不是上一轮的旧件）；
 *   ② PDF 的 mtime 不晚于旁车（render.mjs 先写 PDF 再写旁车；PDF 更新 → 旁车是旧件）。
 * 返回 { ok, detail }；也接受直接传 boolean。
 */
export function makeIdentityValidator({ expectedRenderInputId = null, maxSkewMs = 0 } = {}) {
  return (tmpPdf, tmpSidecar) => {
    const id = readSidecarIdentity(tmpSidecar);
    if (!id) return { ok: false, detail: '旁车不可读或不是合法 JSON' };
    if (expectedRenderInputId !== null && id.renderInputId !== expectedRenderInputId) {
      return { ok: false, detail: `旁车 renderInputId 不匹配: ${id.renderInputId} != ${expectedRenderInputId}` };
    }
    try {
      const pm = fs.statSync(tmpPdf).mtimeMs;
      const sm = fs.statSync(tmpSidecar).mtimeMs;
      if (pm > sm + maxSkewMs) return { ok: false, detail: `PDF 新于旁车（${pm} > ${sm}），旁车疑似旧件` };
    } catch (e) {
      return { ok: false, detail: `stat 失败: ${e.message}` };
    }
    return { ok: true, detail: '成对身份一致' };
  };
}

// 同目录下的 <prefix>.bak-* / <prefix>.new-* 兄弟文件（按戳里的时间戳升序）
function siblings(target, marker) {
  const dir = path.dirname(target);
  const base = path.basename(target) + marker;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const ts = (n) => {
    const m = /-(\d+)$/.exec(n);
    return m ? Number(m[1]) : 0;
  };
  return names.filter((n) => n.startsWith(base))
    .sort((a, b) => ts(a) - ts(b) || (a < b ? -1 : 1))
    .map((n) => path.join(dir, n));
}

// 把备份换回目标（先删目标再 rename，保证落位是原子的）
function restoreBackup(bakPath, target) {
  try {
    if (fs.existsSync(target)) {
      // 目标不是普通文件（例如被注入成目录）时不动它 —— 还原不了就报失败，绝不删目录
      const st = fs.lstatSync(target);
      if (!st.isFile() && !st.isSymbolicLink()) {
        return { ok: false, detail: `目标不是普通文件，无法还原: ${target}` };
      }
      fs.rmSync(target, { force: true });
    }
  } catch (e) {
    return { ok: false, detail: `无法移除目标 ${target}: ${e.message}` };
  }
  try {
    fs.renameSync(bakPath, target);
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `无法还原备份 ${bakPath}: ${e.message}` };
  }
}

/**
 * 清理上次发布中断的残留（幂等，失败不抛）。
 * 规则（保守、fail-closed）：
 *   - 存在 <out>.bak-* → 视为上次发布未走完 → 把备份换回目标（回到上一次成功的成对产物），
 *     再删除备份。宁可退回旧产物，也不留下半新半旧的配对。
 *   - 存在 <out>.new-* → 暂存残留，直接删除。
 * 返回 { restored: [...], failed: [...] }。
 */
export function recoverPair(outPdf, outSidecar) {
  const restored = [];
  const failed = [];   // 清理类失败（删不掉的旧残留）：不影响本次发布
  const fatal = [];    // 还原失败：唯一恢复源还在，不能继续发布（否则新件会盖掉它）
  for (const target of [outPdf, outSidecar]) {
    if (!target) continue;
    const baks = siblings(target, BAK);
    if (baks.length) {
      // 只用最新的备份还原（更旧的是历史残留），其余直接删
      const newest = baks[baks.length - 1];
      const r = restoreBackup(newest, target);
      if (r.ok) restored.push(newest);
      else fatal.push(r.detail);
      for (const b of baks.slice(0, -1)) {
        try { fs.rmSync(b, { force: true }); } catch (e) { failed.push(`无法删除旧备份 ${b}: ${e.message}`); }
      }
    }
    for (const tmp of siblings(target, NEW)) {
      try { fs.rmSync(tmp, { force: true }); } catch (e) { failed.push(`无法删除暂存 ${tmp}: ${e.message}`); }
    }
  }
  return { restored, failed, fatal };
}

/**
 * 成对发布 PDF + 旁车。
 * @param {{tmpPdf: string, tmpSidecar: string, outPdf: string, outSidecar: string,
 *          validate?: (tmpPdf: string, tmpSidecar: string) => boolean|{ok: boolean, detail?: string}}} args
 * @returns {{ok: true, bytes: number, pdfBytes: number, sidecarBytes: number, publishedAt: string}
 *          | {ok: false, reason: 'validate'|'missing-tmp'|'rename'|'rollback', detail: string}}
 */
export function publishPair({ tmpPdf, tmpSidecar, outPdf, outSidecar, validate } = {}) {
  // 戳必须唯一：同一进程同一毫秒的两次发布（并发渲染同一目标）会算出同一个戳 →
  // .new-/.bak- 兄弟文件互相覆盖，恢复路径就认错了哪一份是「上次中断的残留」。
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  // 0. 先清理上次中断的残留（fail-closed：退回上一次成对产物）
  //    还原失败（fatal）时必须中止本次发布：备份是唯一的恢复源，
  //    继续发布会用新件盖掉它 → 旧产物与恢复备份双双丢失（2026-10-28 补丁轮实证）。
  let rec = { restored: [], failed: [], fatal: [] };
  try { rec = recoverPair(outPdf, outSidecar); }
  catch (e) { return { ok: false, reason: 'recover', detail: `上次发布残留清理异常：${(e && e.message) || e}`, recoverable: true }; }
  if (rec.fatal && rec.fatal.length) {
    return { ok: false, reason: 'recover', detail: `上次发布残留还原失败，已中止本次发布（恢复源保留）：${rec.fatal.join('; ')}`, recoverable: true };
  }
  if (rec.failed && rec.failed.length) {
    console.error(`[publish] 上次发布残留清理不完整：${rec.failed.join('; ')}`);
  }

  // 1. 临时文件必须在
  for (const [label, p] of [['tmpPdf', tmpPdf], ['tmpSidecar', tmpSidecar]]) {
    if (!p) return { ok: false, reason: 'missing-tmp', detail: `${label} 未提供` };
    let st;
    try { st = fs.statSync(p); } catch (e) {
      return { ok: false, reason: 'missing-tmp', detail: `${label} 不存在: ${p}` };
    }
    if (!st.isFile()) return { ok: false, reason: 'missing-tmp', detail: `${label} 不是普通文件: ${p}` };
  }

  // 2. 临时路径不得与目标路径相同（否则备份会把自己的源搬走）
  if (path.resolve(tmpPdf) === path.resolve(outPdf) || path.resolve(tmpSidecar) === path.resolve(outSidecar)) {
    return { ok: false, reason: 'validate', detail: '临时路径不得与目标路径相同' };
  }

  // 3. 成对身份校验：不通过 → 不发布，旧产物原样保留
  if (typeof validate === 'function') {
    let r;
    try { r = validate(tmpPdf, tmpSidecar); } catch (e) {
      return { ok: false, reason: 'validate', detail: `validate 抛错: ${e.message}` };
    }
    const ok = typeof r === 'boolean' ? r : !!(r && r.ok);
    if (!ok) {
      const detail = (r && typeof r === 'object' && r.detail) || '成对身份校验未通过';
      return { ok: false, reason: 'validate', detail };
    }
  }

  const stagePdf = outPdf + NEW + stamp;
  const stageSide = outSidecar + NEW + stamp;
  const bakPdf = outPdf + BAK + stamp;
  const bakSide = outSidecar + BAK + stamp;
  let replacedPdf = false, replacedSide = false;
  const rbErrors = [];

  try {
    fs.mkdirSync(path.dirname(outPdf), { recursive: true });
    fs.mkdirSync(path.dirname(outSidecar), { recursive: true });

    // 暂存：与目标同目录（copy 可跨设备），随后 rename 不跨文件系统
    fs.copyFileSync(tmpPdf, stagePdf);
    fs.copyFileSync(tmpSidecar, stageSide);

    // 备份旧产物（复制，旧件原地保留 → 替换失败时目标仍在）
    if (fs.existsSync(outPdf) && fs.statSync(outPdf).isFile()) fs.copyFileSync(outPdf, bakPdf);
    if (fs.existsSync(outSidecar) && fs.statSync(outSidecar).isFile()) fs.copyFileSync(outSidecar, bakSide);

    // 发布：先旁车后 PDF → 不会出现「新 PDF + 旧旁车」
    fs.renameSync(stageSide, outSidecar); replacedSide = true;
    fs.renameSync(stagePdf, outPdf); replacedPdf = true;
  } catch (e) {
    // 回滚：把被替换掉的目标换回备份（未替换的目标原样不动）
    // 有备份 → 换回旧件；原来没有该文件 → 删掉新件（还原成「本来不存在」）
    if (replacedSide) {
      if (fs.existsSync(bakSide)) {
        const r = restoreBackup(bakSide, outSidecar);
        if (!r.ok) rbErrors.push(r.detail);
      } else {
        try { fs.rmSync(outSidecar, { force: true }); } catch (e2) { rbErrors.push(`无法撤回新旁车: ${e2.message}`); }
      }
    }
    if (replacedPdf) {
      if (fs.existsSync(bakPdf)) {
        const r = restoreBackup(bakPdf, outPdf);
        if (!r.ok) rbErrors.push(r.detail);
      } else {
        try { fs.rmSync(outPdf, { force: true }); } catch (e2) { rbErrors.push(`无法撤回新 PDF: ${e2.message}`); }
      }
    }
    // 回滚不完整 → 备份是**唯一的恢复源**，必须留着（此前无条件删 → 旧旁车与恢复备份双双丢失）。
    const rollbackComplete = rbErrors.length === 0;
    const retained = [];
    if (!rollbackComplete) {
      for (const p of [bakPdf, bakSide]) { if (fs.existsSync(p)) retained.push(p); }
    }
    // 暂存件永远清掉（新件，不是恢复源）；备份只在回滚完整时清掉
    for (const p of [stagePdf, stageSide, ...(rollbackComplete ? [bakPdf, bakSide] : [])]) {
      try { fs.rmSync(p, { force: true }); } catch (e2) { rbErrors.push(`无法清理 ${p}: ${e2.message}`); }
    }
    if (!rollbackComplete) {
      return {
        ok: false, reason: 'rollback', recoverable: true, retained,
        detail: `发布失败(${e.message})且回滚不完整: ${rbErrors.join('; ')}` + (retained.length ? `（恢复源已保留：${retained.join('、')}）` : '')
      };
    }
    return { ok: false, reason: 'rename', detail: `发布失败已回滚: ${e.message}` };
  }

  // 成功：清理备份与已消费的临时文件
  for (const p of [bakPdf, bakSide, tmpPdf, tmpSidecar]) {
    try { fs.rmSync(p, { force: true }); } catch { /* 尽力清理 */ }
  }
  let pdfBytes = 0, sidecarBytes = 0;
  try { pdfBytes = fs.statSync(outPdf).size; } catch { /* 读不到就报 0 */ }
  try { sidecarBytes = fs.statSync(outSidecar).size; } catch { /* 读不到就报 0 */ }
  return { ok: true, bytes: pdfBytes, pdfBytes, sidecarBytes, publishedAt: new Date().toISOString() };
}
