// llm.mjs — OpenAI 兼容 LLM 客户端；无配置=降级（hasLLM false）
import fs from 'node:fs';
import path from 'node:path';

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

// withRetry — 仅网络错误/5xx/超时重试；4xx 是凭证/参数问题，重试无意义且烧 token
// sleep 可注入：测试传假 sleep 实现零等待 + 断言延迟参数
export async function withRetry(fn, { retries = 2, delayMs = 1500,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= retries || !(e.status === undefined || e.status >= 500)) throw e;
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
  const r = await withRetry(() => fetch(`${baseURL.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000)
  }).then(okOrThrow('连接失败')));
  const data = await r.json();
  return (data.data || []).map((m) => m.id).filter(Boolean).sort();
}

// chatMsgs — 多消息形态；chat 是它的两消息特例
export async function chatMsgs(root, messages) {
  const c = loadConfig(root);
  if (!c) throw new Error('LLM 未配置');
  const r = await withRetry(() => fetch(`${c.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.model, messages }),
    // 不带 temperature：Kimi coding 等端点只允许默认值，硬编码会被 400
    signal: AbortSignal.timeout(60000)
  }).then(okOrThrow('LLM 请求失败')));
  // r.json() 与结构校验刻意放在 withRetry 外：body 解析/格式错误天然不重试
  const data = await r.json();
  if (!data.choices?.[0]?.message?.content) throw new Error('LLM 返回格式异常');
  return data.choices[0].message.content;
}

export async function chat(root, system, user) {
  return chatMsgs(root, [{ role: 'system', content: system }, { role: 'user', content: user }]);
}
