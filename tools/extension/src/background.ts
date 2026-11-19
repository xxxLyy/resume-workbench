// 扩展大脑（MV3 service worker；底座照搬 efc apps/extension，接线改指本仓简历工作台）。
// 服务端契约：docs/dev-docs/2026-11-19-upcv-port-extension-design.md §1 六端点。
// 职责：
//   · chrome.storage 读写 {workbenchUrl,token,docId,mode,threshold,autoDraft}
//   · 工作台 REST helper（X-Resume-Token；GET 服务端不校验也照发，口径统一）
//   · 批次调度状态机：IDLE/RUNNING/PAUSED/STOPPED；20 岗/批上限；动作间隔
//     3-8s 随机（防频控）；风控识别{操作频繁|验证码|RISK|登录}→PAUSED；
//     Cookie 失效类 → 提示人工重登；请求受限类 → 自动刷新一次再 PAUSED
//   · 消息路由：sidepanel(PanelRequest) ↔ background ↔ content(ContentCommand/Report)
// 纪律：发送类动作标 irreversible —— A/B 模式必须走确认链才发 cmd:send-click；
//       C 模式永不点发送（填入不发送）。
import type {
  Settings, BatchItem, BatchState, Candidate, RawJob,
  PanelRequest, ContentCommand, ContentReport, EngineEvent,
} from "./types/site";
import { DEFAULT_SETTINGS } from "./types/site";

// ---------- 设置 ----------
let settings: Settings = { ...DEFAULT_SETTINGS };
const SETTINGS_KEY = "settings";

async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  settings = { ...DEFAULT_SETTINGS, ...((got?.[SETTINGS_KEY] ?? {}) as Partial<Settings>) };
  return settings;
}
async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

// ---------- 工作台 REST ----------
interface WbError extends Error { status?: number }
async function wb<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const url = `${settings.workbenchUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-resume-token": settings.token,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const e: WbError = new Error(
      typeof data.error === "string" ? data.error : `HTTP ${res.status}`,
    );
    e.status = res.status;
    throw e;
  }
  return data as T;
}

// ---------- 面板事件广播（sidepanel 关闭时丢弃，无副作用） ----------
const toPanel = (evt: EngineEvent): void => {
  try { void chrome.runtime.sendMessage(evt); } catch { /* 面板未开 */ }
};
const notice = (level: "info" | "warn" | "error", text: string): void =>
  toPanel({ kind: "evt:notice", level, text });

// ---------- 标签页工具 ----------
async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t?.id ? t : null;
}

function sendCmd(tabId: number, cmd: ContentCommand): Promise<unknown> {
  return chrome.tabs.sendMessage(tabId, cmd).catch(() => {
    // 内容脚本未注入（非目标站点页/页面未就绪）
    return null;
  });
}

// ---------- 报告等待器（content → background 的异步回报） ----------
interface Waiter { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }
const waiters = new Map<string, Waiter[]>();
function waitReport<T>(kind: string, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const list = waiters.get(kind) ?? [];
    const timer = setTimeout(() => {
      const cur = waiters.get(kind) ?? [];
      waiters.set(kind, cur.filter((w) => w.resolve !== resolve));
      resolve(null);
    }, timeoutMs);
    list.push({ resolve: resolve as (v: unknown) => void, timer });
    waiters.set(kind, list);
  });
}
function fireReport(kind: string, value: unknown): void {
  const list = waiters.get(kind) ?? [];
  waiters.set(kind, []);
  for (const w of list) { clearTimeout(w.timer); w.resolve(value); }
}

// ---------- 幂等：投递状态图（服务端 /extension/shortlist 的 statuses 投影） ----------
const STATUS_RANK: Record<string, number> = {
  to_apply: 0, preparing: 1, applied: 2, replied: 3,
  interviewing: 4, offer: 5, closed: 6,
};
let statusMap = new Map<string, string>();
async function refreshStatusMap(): Promise<void> {
  try {
    // shortlist 顺带全表 jobId→状态投影（items 只回 to_apply；statuses 供幂等跳过）
    const r = await wb<{ statuses: { jobId: string; status: string }[] }>("/extension/shortlist");
    statusMap = new Map(r.statuses.map((i) => [i.jobId, i.status]));
  } catch { /* 拿不到就空图，apply-record 的前向保护兜底 */ }
}
/** 已沟通过 = 状态已到 applied 及之后（closed 也算——不再外发） */
const contacted = (jobId: string): boolean =>
  (STATUS_RANK[statusMap.get(jobId) ?? ""] ?? -1) >= STATUS_RANK.applied;

// ---------- 批次状态机（§6） ----------
const BATCH_MAX = 20;
const ACTION_MIN_MS = 3000;
const ACTION_SPAN_MS = 5000;

const batch = {
  state: { status: "IDLE", total: 0, index: 0, done: 0, skipped: 0, failed: 0 } as BatchState,
  queue: [] as BatchItem[],
  confirmResolve: null as null | ((a: "send" | "skip" | "stop") => void),
  confirmedAll: false,
};

function pushState(): void { toPanel({ kind: "evt:batch", state: { ...batch.state } }); }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const actionDelay = (): Promise<void> =>
  sleep(ACTION_MIN_MS + Math.floor(Math.random() * ACTION_SPAN_MS));

function pause(reason: string): void {
  batch.state.status = "PAUSED";
  batch.state.pauseReason = reason;
  notice("error", `已暂停：${reason}`);
  pushState();
}

/** 等 sidepanel 确认卡结果；5 分钟没人点 → 当 PAUSED 处理（不留无人值守外发）。 */
function askConfirm(job: { jobId: string; title: string; companyName: string }, greeting: string, isBatch = false): Promise<"send" | "skip" | "stop"> {
  return new Promise((resolve) => {
    batch.confirmResolve = resolve;
    toPanel({ kind: "evt:confirm", job, greeting, batch: isBatch });
    setTimeout(() => {
      if (batch.confirmResolve === resolve) {
        batch.confirmResolve = null;
        resolve("skip");
        pause("确认卡超时未操作");
      }
    }, 300_000);
  });
}

/** 请求受限类风控：刷新标签页一次重试当前步；再失败 → PAUSED（§6-3）。 */
async function riskRateLimit(tabId: number): Promise<boolean> {
  if (batch.state.retried) return false; // 已自动重试过 → 不再刷，直接 PAUSED
  batch.state.retried = true;
  notice("warn", "请求受限，自动刷新页面重试一次…");
  await chrome.tabs.reload(tabId).catch(() => undefined);
  await sleep(2500);
  return true;
}

async function ensureChatTab(item: BatchItem): Promise<number | null> {
  const tab = await activeTab();
  if (!tab?.id) { notice("error", "没有活动标签页"); return null; }
  // 已在此岗详情页就直接点沟通；否则导航过去（detailUrl 没有 → 本岗放弃）
  if (item.detailUrl && !(tab.url ?? "").includes(item.detailUrl)) {
    await chrome.tabs.update(tab.id, { url: item.detailUrl }).catch(() => undefined);
    await sleep(3000);
  }
  await sendCmd(tab.id, { kind: "cmd:greet-open", job: item });
  const ready = await waitReport<{ ok: boolean; detail?: string }>("rep:greet-ready", 20_000);
  if (ready?.ok) return tab.id;
  // 点了沟通但输入框没在本页出现：BOSS 常开新聊天窗口 → 找最近的聊天标签页
  const chatTabs = await chrome.tabs.query({ url: ["https://www.zhipin.com/web/geek/*"] });
  const chatTab = chatTabs.find((t) => t.id !== tab.id && /chat/.test(t.url ?? ""));
  if (chatTab?.id) return chatTab.id;
  const detail = ready?.detail ?? "沟通页未就绪";
  if (detail.startsWith("风控:")) {
    const [, kind] = detail.split(":");
    if (kind === "rateLimit" && (await riskRateLimit(tab.id))) return ensureChatTab(item);
    pause(`风控/登录态受限（${detail}）`);
    return null;
  }
  notice("warn", `「${item.title}」${detail}`);
  return null;
}

/** 单岗执行：招呼 → 打开聊天 → 填入 → 按模式决定发送/仅填入。 */
async function runItem(item: BatchItem): Promise<void> {
  if (contacted(item.jobId)) {
    batch.state.skipped++;
    notice("info", `「${item.title}」已沟通过，跳过`);
    return;
  }
  // 1 招呼语
  let greeting = "";
  try {
    const r = await wb<{ greeting: string }>("/extension/greeting", {
      method: "POST",
      body: { jobId: item.jobId, docId: settings.docId || undefined },
    });
    greeting = r.greeting;
  } catch (e) {
    const status = (e as WbError).status;
    if (status === 400) { pause(`生成招呼失败：${(e as Error).message}`); return; }
    batch.state.failed++;
    notice("warn", `「${item.title}」招呼生成失败：${(e as Error).message}`);
    return;
  }
  // 2 打开聊天页并填入
  const chatTabId = await ensureChatTab(item);
  if (chatTabId === null || batch.state.status !== "RUNNING") return;
  if (batch.state.retried === undefined) batch.state.retried = false;
  const fillAck = await sendCmd(chatTabId, { kind: "cmd:input-fill", text: greeting });
  if (!fillAck) {
    batch.state.failed++;
    notice("warn", `「${item.title}」填入失败（页面结构可能已改版）`);
    return;
  }
  // 3 发送决策（§6 模式三档 + 不可逆保护）
  const send = async (): Promise<void> => {
    await sendCmd(chatTabId, { kind: "cmd:send-click" });
    const sent = await waitReport<{ ok: boolean }>("rep:sent", 5000);
    if (sent?.ok !== false) {
      try {
        await wb("/extension/apply-record", {
          method: "POST",
          body: {
            jobId: item.jobId, status: "applied",
            company: item.companyName, role: item.title,
            docId: settings.docId || undefined,
          },
        });
        statusMap.set(item.jobId, "applied");
      } catch { /* 记录失败不中断批次 */ }
      batch.state.done++;
      notice("info", `已发送招呼 →「${item.title}」（标记 applied）`);
    } else {
      batch.state.failed++;
      notice("warn", `「${item.title}」发送按钮未生效`);
    }
  };
  if (settings.mode === "A") {
    const a = await askConfirm(item, greeting);
    if (a === "send") await send();
    else if (a === "stop") { batch.state.status = "STOPPED"; return; }
    else batch.state.skipped++;
  } else if (settings.mode === "B") {
    if (!batch.confirmedAll) {
      const a = await askConfirm(item, greeting, true);
      if (a === "send") batch.confirmedAll = true;
      else if (a === "stop") { batch.state.status = "STOPPED"; return; }
      else { batch.state.skipped++; return; }
    }
    if (batch.confirmedAll) await send();
  } else {
    // C：只填入不发送（默认即此）；投递事实不推进，保持 to_apply
    batch.state.done++;
    notice("info", `「${item.title}」招呼已填入，待人工发送`);
  }
}

async function runBatch(): Promise<void> {
  while (batch.state.status === "RUNNING" && batch.state.index < batch.queue.length) {
    const item = batch.queue[batch.state.index];
    batch.state.current = { jobId: item.jobId, title: item.title, companyName: item.companyName };
    batch.state.retried = false;
    pushState();
    await runItem(item);
    if (batch.state.status !== "RUNNING") break;
    batch.state.index++;
    pushState();
    if (batch.state.index < batch.queue.length) await actionDelay();
  }
  if (batch.state.status === "RUNNING") {
    batch.state.status = "IDLE";
    batch.state.current = null;
    notice("info", `批次完成：发${batch.state.done} 跳${batch.state.skipped} 败${batch.state.failed}`);
    pushState();
  }
}

async function startBatch(items: BatchItem[]): Promise<void> {
  if (batch.state.status === "RUNNING") { notice("warn", "批次已在运行"); return; }
  const queue = items.slice(0, BATCH_MAX);
  if (items.length > BATCH_MAX) notice("warn", `批次上限 ${BATCH_MAX} 岗，已截断 ${items.length - BATCH_MAX} 条`);
  await refreshStatusMap();
  batch.queue = queue;
  batch.confirmedAll = false;
  batch.state = {
    status: "RUNNING", total: queue.length, index: 0,
    done: 0, skipped: 0, failed: 0, current: null,
  };
  pushState();
  void runBatch();
}

// ---------- 采集（功能①：content 取卡 → 逐岗打分 → 候选清单） ----------
async function handleCollected(jobs: RawJob[]): Promise<void> {
  if (!jobs.length) {
    toPanel({ kind: "evt:collect-error", error: "本页未采集到岗位卡（页面结构可能已改版）" });
    return;
  }
  await refreshStatusMap();
  const kept: Candidate[] = [];
  for (const j of jobs) {
    let score: number | null = null;
    let level: string | null = null;
    if (settings.docId) {
      try {
        // 站点 jobId（site-…）不是上游 id：打分上下文用采集卡字段拼 jdText（服务端 match-score 透传给 computeMatch）
        const jdText = `职位：${j.title}（${j.companyName}）`
          + [j.salaryDisplay, j.city].filter(Boolean).join(" · ");
        const m = await wb<{ matchScore: number; matchLevel: string }>("/extension/match-score", {
          method: "POST", body: { docId: settings.docId, jobId: j.jobId, jdText },
        });
        score = m.matchScore; level = m.matchLevel;
      } catch { /* 打分失败当 null 处理，仍进清单 */ }
    }
    if (score !== null && score < settings.threshold) continue; // 低分丢弃
    kept.push({ ...j, matchScore: score, matchLevel: level, contacted: contacted(j.jobId) });
  }
  toPanel({ kind: "evt:candidates", items: kept, append: true });
  toPanel({ kind: "evt:collect-done", count: kept.length });
}

// ---------- 自动草稿（聊天页打开 → 抓历史 → LLM 草稿 → 填入不发送） ----------
// 聊天页的会话键：服务端 jobId 白名单 [A-Za-z0-9_-]{1,90}——URL 清洗成安全字符做稳定键
// （只作草稿上下文键，不落任何幂等账本）。
const chatJobIdOf = (url: string): string =>
  `site-chat-${url.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60)}`;
let autoDraftBusy = false;
async function autoDraft(tabId: number): Promise<void> {
  if (!settings.autoDraft || autoDraftBusy) return;
  autoDraftBusy = true;
  try {
    await sendCmd(tabId, { kind: "cmd:chat-grab" });
    const hist = await waitReport<{ text: string }>("rep:chat-history", 5000);
    if (!hist?.text) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const jobId = chatJobIdOf(tab?.url ?? "");
    const r = await wb<{ draft: string }>("/extension/chat-reply", {
      method: "POST",
      body: { jobId, historyText: hist.text },
    });
    if (r.draft) await sendCmd(tabId, { kind: "cmd:input-fill", text: r.draft });
    toPanel({ kind: "evt:draft", jobId, draft: r.draft });
  } catch { /* 自动草稿失败静默（未配 AI 等） */ } finally {
    autoDraftBusy = false;
  }
}

// ---------- 网申代填：简历 data + 偏好 → 画像键值 ----------
function profileFromResume(data: unknown, pref: unknown): Record<string, string> {
  const d = data as {
    basics?: { name?: string; email?: string; phone?: string; location?: string; headline?: string };
    sections?: Record<string, { content?: string; items?: Record<string, unknown>[] }>;
  };
  const strip = (s: string): string => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const edu = d?.sections?.education?.items?.[0] ?? {};
  const p: Record<string, string> = {
    name: d?.basics?.name ?? "",
    phone: d?.basics?.phone ?? "",
    email: d?.basics?.email ?? "",
    city: d?.basics?.location ?? "",
    school: String(edu.institution ?? edu.school ?? ""),
    major: String(edu.area ?? edu.major ?? ""),
    degree: String(edu.studyType ?? edu.degree ?? ""),
    summary: strip(d?.sections?.summary?.content ?? ""),
    intention: d?.basics?.headline ?? "",
    years: "",
    expectSalary: "",
  };
  const s = (pref as { salary?: { min?: number; max?: number; unit?: string } } | null)?.salary;
  if (s && (s.min || s.max)) p.expectSalary = `${s.min ?? ""}-${s.max ?? ""}${s.unit ?? "K"}`;
  return p;
}

// ---------- 消息路由 ----------
async function handlePanelRequest(
  req: PanelRequest,
  sendResponse: (v: unknown) => void,
): Promise<void> {
  try {
    switch (req.kind) {
      case "settings:get": sendResponse({ settings }); return;
      case "settings:set": sendResponse({ settings: await saveSettings(req.patch) }); return;
      case "wb:ping": {
        // 本仓无独立 ping 端点：打 shortlist（GET 免口令、零副作用）即视为连通
        const r = await wb<{ ok: boolean }>("/extension/shortlist");
        sendResponse({ ok: r.ok === true });
        return;
      }
      case "resumes:list": sendResponse(await wb("/api/resume")); return;
      case "shortlist": sendResponse(await wb("/extension/shortlist")); return;
      case "preference": sendResponse(await wb("/preference/state")); return;
      case "resume:detail": {
        const id = req.docId || settings.docId;
        if (!id) { sendResponse({ error: "未选择简历" }); return; }
        sendResponse(await wb(`/api/resume/${encodeURIComponent(id)}`));
        return;
      }
      case "greeting": {
        sendResponse(await wb("/extension/greeting", {
          method: "POST",
          body: { jobId: req.jobId, docId: settings.docId || undefined },
        }));
        return;
      }
      case "apply:record": {
        // 服务端建行需要 docId（幂等状态推进不需要，但统一要求——面板加入待投前先选好默认简历）
        if (!settings.docId) { sendResponse({ error: "先在上方选择默认简历" }); return; }
        sendResponse(await wb("/extension/apply-record", {
          method: "POST",
          body: {
            jobId: req.jobId, status: req.status,
            company: req.company, role: req.role, link: req.link,
            docId: settings.docId,
          },
        }));
        return;
      }
      case "chat:draft": {
        const tab = await activeTab();
        if (!tab?.id) { sendResponse({ error: "没有活动标签页" }); return; }
        await sendCmd(tab.id, { kind: "cmd:chat-grab" });
        const hist = await waitReport<{ text: string }>("rep:chat-history", 5000);
        if (!hist?.text) { sendResponse({ error: "未抓到聊天历史（不在聊天页或结构已改版）" }); return; }
        sendResponse(await wb("/extension/chat-reply", {
          method: "POST",
          body: { jobId: req.jobId || chatJobIdOf(tab.url ?? ""), historyText: hist.text },
        }));
        return;
      }
      case "collect:start": {
        const tab = await activeTab();
        if (!tab?.id) { sendResponse({ error: "没有活动标签页" }); return; }
        const ack = await sendCmd(tab.id, { kind: "cmd:collect" });
        sendResponse(ack ? { ok: true } : { error: "当前页不是受支持的站点页面（或未注入脚本）" });
        return;
      }
      case "fill:input": {
        const tab = await activeTab();
        if (!tab?.id) { sendResponse({ error: "没有活动标签页" }); return; }
        const ack = await sendCmd(tab.id, { kind: "cmd:input-fill", text: req.text });
        sendResponse(ack ? { ok: true } : { error: "当前页不支持填入" });
        return;
      }
      case "apply:fill": {
        const tab = await activeTab();
        if (!tab?.id) { sendResponse({ error: "没有活动标签页" }); return; }
        if (!settings.docId) { sendResponse({ error: "先在上方选择默认简历" }); return; }
        const [resume, pref] = await Promise.all([
          wb<{ data: unknown }>(`/api/resume/${encodeURIComponent(settings.docId)}`),
          wb<{ preference: unknown }>("/preference/state").catch(() => ({ preference: null })),
        ]);
        const profile = profileFromResume(resume.data, pref.preference);
        const ack = await sendCmd(tab.id, { kind: "cmd:apply-fill", profile });
        sendResponse(ack ? { ok: true } : { error: "当前页不支持表单填入" });
        return;
      }
      case "batch:start": await startBatch(req.items); sendResponse({ ok: true }); return;
      case "batch:pause":
        if (batch.state.status === "RUNNING") { batch.state.status = "PAUSED"; batch.state.pauseReason = "手动暂停"; pushState(); }
        sendResponse({ ok: true }); return;
      case "batch:resume":
        if (batch.state.status === "PAUSED") { batch.state.status = "RUNNING"; batch.state.pauseReason = undefined; pushState(); void runBatch(); }
        sendResponse({ ok: true }); return;
      case "batch:stop":
        batch.state.status = "STOPPED";
        if (batch.confirmResolve) { batch.confirmResolve("stop"); batch.confirmResolve = null; }
        pushState();
        sendResponse({ ok: true }); return;
      case "batch:state": sendResponse({ state: batch.state }); return;
      case "confirm:resolve":
        if (batch.confirmResolve) { batch.confirmResolve(req.action); batch.confirmResolve = null; }
        sendResponse({ ok: true }); return;
    }
  } catch (e) {
    sendResponse({ error: e instanceof Error ? e.message : String(e) });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const m = message as { kind?: string };
  if (!m?.kind) return false;

  // content 回报（sender.tab 存在）
  if (m.kind.startsWith("rep:") || m.kind === "evt:missing") {
    const rep = m as ContentReport;
    if (m.kind === "rep:collected") void handleCollected((rep as { jobs: RawJob[] }).jobs);
    else if (m.kind === "rep:risk") {
      const r = rep as { risk: string; detail: string };
      if (batch.state.status === "RUNNING") pause(`风控/登录态受限（${r.risk}：${r.detail}）`);
      else notice("warn", `站点风控提示：${r.detail}`);
    } else if (m.kind === "rep:page") {
      const p = rep as { page: string; url: string };
      if (p.page === "chat" && sender.tab?.id) void autoDraft(sender.tab.id);
    } else if (m.kind === "evt:missing") {
      toPanel(rep as unknown as EngineEvent);
    }
    fireReport(m.kind, rep);
    return false;
  }

  // sidepanel 请求
  void handlePanelRequest(m as PanelRequest, sendResponse);
  return true; // sendResponse 异步使用
});

// ---------- 启动 ----------
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
void loadSettings();
