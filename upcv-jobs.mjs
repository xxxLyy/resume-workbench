// upcv-jobs.mjs — UPCV 社招职位上游代理（A2 · #10/#11；规范 dev-docs/2026-11-19-upcv-port-jobs-match-design.md §1）
// 纪律照 efc platform/upcv.ts 逐字翻译（vanilla mjs 零依赖）：固定 base + RESUME_UPCV_BASE 覆盖
// （测试指向进程内假上游，同 test.sh 假渲染器思路）+ 20s 超时 + 参数白名单。
// SSRF 面为零：base 不来自请求输入，上游路径是模块常量，params 只收白名单键（其余丢弃）。
// 上游失败如实抛中文（调用方落 502）；不缓存上游响应、不重试（POST 语义同款单次）。
const UPSTREAM_TIMEOUT_MS = 20000;
/** 搜索参数白名单：只透传这些，其余丢弃（上游是严格校验，传错参数名会 400） */
export const UPCV_SEARCH_PARAMS = new Set(['jobType', 'search', 'cityIds', 'functionIds', 'jobIds', 'page', 'limit']);

const base = () => process.env.RESUME_UPCV_BASE || 'https://www.upcv.tech/api';

export async function upstream(pathname, params) {
  const qs = params && params.size > 0 ? '?' + params.toString() : '';
  let res;
  try {
    res = await fetch(base() + pathname + qs, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    const why = e && e.name === 'TimeoutError' ? '超时' : ((e && e.cause && e.cause.code) || (e && e.code) || '网络失败');
    throw new Error('上游不可达：' + why);
  }
  if (!res.ok) throw new Error('上游 ' + res.status);
  return res.json();
}

/** query（URLSearchParams）→ 白名单过滤后的新 URLSearchParams；空值丢弃 */
export function searchParamsOf(query) {
  const out = new URLSearchParams();
  if (query && typeof query.forEach === 'function') {
    query.forEach((v, k) => { if (v && UPCV_SEARCH_PARAMS.has(k)) out.set(k, v); });
  }
  return out;
}

export async function fetchUpcvJobs(params) { return upstream('/campus/jobs', params); }
export async function fetchUpcvJob(jobId) { return upstream('/campus/jobs/' + encodeURIComponent(String(jobId))); }

// 字典缓存：10 分钟进程内（设计 §6：不落盘）。字典基本不变，没必要每次搜索都打上游。
const DICT_TTL_MS = 10 * 60 * 1000;
let dictCache = null;
export async function fetchUpcvDictionaries() {
  if (dictCache && Date.now() - dictCache.at < DICT_TTL_MS) return dictCache.data;
  const [cities, functions, industries] = await Promise.all([
    upstream('/campus/cities/grouped'),
    upstream('/campus/functions/grouped'),
    upstream('/campus/concepts/industry'),
  ]);
  const data = { cities, functions, industries, fetchedAt: new Date().toISOString() };
  dictCache = { at: Date.now(), data };
  return data;
}
