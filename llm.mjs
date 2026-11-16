// llm.mjs — OpenAI 兼容 LLM 客户端；无配置=降级（hasLLM false）
import fs from 'node:fs';
import path from 'node:path';
import { aiPool } from './resource-slots.mjs';

// loadProfiles — 读取全部配置：新格式 {active, profiles:[{name,baseURL,apiKey,model}]}；
// 旧单配置 {baseURL,apiKey,model} 自动归一为名为"默认"的单 profile（无感过渡）
export function loadProfiles(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    if (raw && Array.isArray(raw.profiles)) return { active: raw.active | 0, profiles: raw.profiles };
    if (raw && raw.baseURL) return { active: 0, profiles: [{ name: '默认', ...raw }] };
    return { active: 0, profiles: [] };
  } catch { return { active: 0, profiles: [] }; }
}

// loadConfig — 返回当前生效（active）的那份配置；chatMsgs/hasLLM 等消费方零改动
export function loadConfig(root) {
  const { active, profiles } = loadProfiles(root);
  return profiles[active] || null;
}

export function hasLLM(root) {
  const c = loadConfig(root);
  return !!(c && c.apiKey && c.baseURL && c.model);
}

// assertSafeBaseURL — /ai/test 的 baseURL 来自用户输入，而该端点不校验 Content-Type：
// text/plain + JSON body 属 CORS 简单请求（免预检），任意网页可让本机去请求它指定的地址，
// 且 Bearer apiKey 会随之发往该地址。此处挡掉无合法用途的高危端点（云元数据）与非 http(s) 协议。
// 注意：不拦 127.0.0.1/局域网——本地模型（Ollama/LM Studio）是本项目的正当用法。
export function assertSafeBaseURL(u) {   // 导出：/ai/jd-text 的 SSRF 防线复用（2026-10-19 安全审查 🟡-5）
  let url;
  try { url = new URL(String(u)); } catch { throw new Error('LLM 地址非法'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('LLM 地址协议不支持');
  // hostname 对 IPv6 保留方括号（new URL('http://[fd00::1]/').hostname === '[fd00::1]'），
  // 故黑名单两写：带括号与不带括号都要挡（2026-10-19 实测漏了带括号那条）。
  // 刻意【不挡 loopback / 私网段】：本函数服务于两个不同用途——
  //   /ai/test      连 LLM 端点，本机模型（如 ollama）就跑在 127.0.0.1，挡了就没法用
  //   /ai/jd-text   抓 JD 页面，企业内网招聘系统是真实场景（JD 常只在内网可见），挡了会破功能
  // 云元数据段（169.254 / metadata. / fd00: / fe80:）没有任何正当用途，一律挡死。
  const _host = String(url.hostname || '').replace(/^\[|\]$/g, '');
  if (/^(169\.254\.|metadata\.|fd00:|fe80:)/i.test(_host)) throw new Error('禁止访问云元数据端点或内网保留地址');
  return url;
}

// withRetry — 仅幂等请求重试；非幂等请求（POST）一次发送，不重试。
// idempotent=false（POST）：请求可能已到达并被计费，重发就是重复扣费（重复计费比失败更糟）。
//   5xx 不重试（服务端可能已计费）；超时不重试；连接层失败也不重试 ——
//   Node 的 fetch 分不清「连接被拒（没送达）」与「发送后断连（可能已送达）」，
//   统一按「结果未知」处理：只发一次，把不确定性如实交给调用方。
//   （2026-10-28 可靠性审查 RES-08：POST 单次语义；旧实现按 name=TypeError 猜「没送达」是猜。）
// idempotent=true（GET）：网络错误（status undefined）与 5xx 可重试；4xx 是凭证/参数问题，重试无意义且烧 token。
// sleep 可注入：测试传假 sleep 实现零等待 + 断言延迟参数
export async function withRetry(fn, { retries = 2, delayMs = 1500, idempotent = true,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      // 可重试判定：幂等请求重试网络错与 5xx；非幂等请求一律不重试（一次发送）。
      const netErr = e.status === undefined;
      const retryable = idempotent ? (netErr || e.status >= 500) : false;
      if (i >= retries || !retryable) throw e;
      console.warn(`[retry] 第${i + 1}次失败，${delayMs}ms 后重试：${e.message || e}`);
      await sleep(delayMs);
    }
  }
}

// HTTP 错误挂 status：withRetry 据此区分 4xx（不重试）与 5xx（重试）
function okOrThrow(prefix) {
  return (r) => {
    if (!r.ok) { const e = new Error(`${prefix}: HTTP ${r.status}`); e.status = r.status; throw e; }
    return r;
  };
}

// listModels — 连接测试 + 拉取可调用模型列表（OpenAI 兼容 GET /models）
export async function listModels(baseURL, apiKey) {
  const base = assertSafeBaseURL(baseURL).toString().replace(/\/$/, '');
  const r = await withRetry(() => fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
    redirect: 'error'   // 跟随重定向会把 Bearer 带到别处，也绕过端点校验
  }).then(okOrThrow('连接失败')));
  const data = await r.json();
  return (data.data || []).map((m) => m.id).filter(Boolean).sort();
}

// chatMsgs — 多消息形态；chat 是它的两消息特例
export async function chatMsgs(root, messages, { lease, meta, profile } = {}) {
  // profile（可选）：按索引指定档案（多模型对比）；null/undefined → 生效档（active），行为不变
  const c = profile == null ? loadConfig(root) : ((loadProfiles(root).profiles || [])[profile] || null);
  if (!c) throw new Error('LLM 未配置');
  // baseURL 来自本地 config（设置页可改）→ 同样过 assertSafeBaseURL：否则把 Bearer 发到
  // 云元数据端点（169.254.169.254）这类地址。listModels 已经这么做了（口径一致）。
  const base = assertSafeBaseURL(c.baseURL).toString().replace(/\/$/, '');
  // 资源占用（RES-02）：入口层拿到 lease 就透传；没拿到就在底层兜底占一个 AI 槽。
  // 释放时机 = 这次调用真正结束（请求 + 解析），逻辑取消/断连不等于释放。
  // 凭证校验（内部接口合同）：透传的 lease 必须真实、同池、未释放、未被其他执行器占用；
  //   校验不通过 → 抛错，且**不发出任何模型请求**（此前只判 truthy，伪造的 {} 也能真发请求）。
  const own = lease ? null : await aiPool.acquire();
  const held = lease ? aiPool.claim(lease) : null;   // 校验失败即抛：请求还没发出去
  try {
    const r = await withRetry(() => fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
      // 禁止透明重定向：默认 follow 会把 messages 原文 POST 到重定向指向的 origin
      // （307 桩实测第二端点收到完整请求体）。同 origin 也不跟随 —— 重定向一律显式失败。
      redirect: 'error',
      // reasoning_effort：profile 级可选（设置页「思考程度」）。MiniMax 官方支持
      // low/medium/high/xhigh/max 且默认 max；填 'max' 即固定为最强思考。
      // 【必须「有值才带」】——不是所有厂商都认这个字段，盲目塞进去会 400；
      // 本文件已经因硬编码 temperature 让 Kimi coding 端点报过 400，同一个坑不踩第二次。
      body: JSON.stringify({ model: c.model, messages, ...(c.reasoningEffort ? { reasoning_effort: c.reasoningEffort } : {}) }),
      // 不带 temperature：Kimi coding 等端点只允许默认值，硬编码会被 400
      // 请求级超时（S4a 设计 §6）：默认 120s，profile 的 timeoutMs 可覆盖
      signal: AbortSignal.timeout(Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) : 120000)
    }).then(okOrThrow('LLM 请求失败')), { idempotent: false });   // POST 一次发送：不重试未知结果
    // r.json() 与结构校验刻意放在 withRetry 外：body 解析/格式错误天然不重试
    const data = await r.json();
    if (!data.choices?.[0]?.message?.content) throw new Error('LLM 返回格式异常');
    // 可选出参（S4b-B 诚实最小进度）：把响应里的 usage 交给调用方采集，返回值与签名兼容不变；
    // 重试成功时以最后一次响应为准（meta 在成功分支覆盖写）。字段在此归一为 {prompt,completion,total}，
    // 厂商 token 名不出 llm.mjs 边界；缺字段记 null（诚实：没有就明说，不编 0）。
    if (meta && typeof meta === 'object') {
      const u = data.usage || null;
      meta.usage = u ? {
        prompt: (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : (typeof u.prompt === 'number' ? u.prompt : null)),
        completion: (typeof u.completion_tokens === 'number' ? u.completion_tokens : (typeof u.completion === 'number' ? u.completion : null)),
        total: (typeof u.total_tokens === 'number' ? u.total_tokens : (typeof u.total === 'number' ? u.total : null))
      } : null;
    }
    return data.choices[0].message.content;
  } finally {
    if (held) { try { aiPool.unclaim(held); } catch {} }
    if (own) { try { own.release(); } catch {} }
  }
}

export async function chat(root, system, user, { lease, meta, profile } = {}) {
  return chatMsgs(root, [{ role: 'system', content: system }, { role: 'user', content: user }], { lease, meta, profile });
}
