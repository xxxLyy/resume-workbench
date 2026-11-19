// 通用采集/填入引擎（docs/upcv-apply-extension-implementation.md §3/§5/§7）。
// 三站适配器共用：读站点 config json（选择器全在 json 里），本站只做两件事——
// ① 静态 import 站点 config 作内置默认；② initSite(siteName, cfg) 挂好一切。
// 运行时会再 fetch dist/config/<site>.json 覆盖内置默认——站点改版改 json
// 重载页面即生效，不必重新 build（§7「只改 json，不改代码」）。
import type {
  SiteConfig, RawJob, ContentCommand, ContentReport, EngineEvent,
} from "../types/site";

const COLLECT_MAX = 100;          // §3：采集上限 100 岗/次
const SCROLL_IDLE_STRIKES = 2;    // 连续 2 页无新卡 → 采集结束
const SCROLL_WAIT_MS = 1500;
const GREET_OPEN_TIMEOUT_MS = 15_000;
const HISTORY_MAX = 12_000;       // 服务端再截 8000；这边多送点冗余

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const report = (msg: ContentReport | EngineEvent): void => {
  try { void chrome.runtime.sendMessage(msg); } catch { /* SW 未醒时静默 */ }
};

// ---------- config 加载（内置默认 + dist json 覆盖） ----------
async function loadConfig(site: string, bundled: SiteConfig): Promise<SiteConfig> {
  try {
    const res = await fetch(chrome.runtime.getURL(`config/${site}.json`));
    if (res.ok) return { ...bundled, ...(await res.json() as SiteConfig) };
  } catch { /* 覆盖文件缺失就用内置默认 */ }
  return bundled;
}

// ---------- 页面识别 ----------
const pageKind = (cfg: SiteConfig, url: string): "list" | "chat" | "apply" | "other" => {
  if (cfg.chatPage?.urlPattern && new RegExp(cfg.chatPage.urlPattern).test(url)) return "chat";
  if (cfg.applyPage?.urlPattern && new RegExp(cfg.applyPage.urlPattern).test(url)) return "apply";
  if (cfg.listPage?.urlPattern && new RegExp(cfg.listPage.urlPattern).test(url)) return "list";
  return "other";
};

// ---------- 风控识别（§6：操作频繁|验证码|RISK|登录 → 三分类） ----------
type RiskKind = "captcha" | "rateLimit" | "auth";
const BUILTIN_RISK: Record<RiskKind, RegExp[]> = {
  captcha: [/验证码/, /安全验证/, /滑块/, /拖动下方滑块/, /人机验证/, /captcha/i],
  rateLimit: [/操作频繁/, /访问频繁/, /请求过于频繁/, /稍后再试/, /RISK_CONTROL/i, /code\s*[=:]\s*37/i],
  auth: [/登录后查看/, /请先登录/, /扫码登录/, /登录已?失效/, /重新登录/, /Cookie.*过期/i],
};

function detectRisk(cfg: SiteConfig): { risk: RiskKind; detail: string } | null {
  const text = (document.body?.innerText ?? "") + " " + location.href;
  const siteExtra = cfg.riskText ?? {};
  const pick = (kind: RiskKind): { risk: RiskKind; detail: string } | null => {
    const pats = [
      ...BUILTIN_RISK[kind],
      ...(siteExtra[kind === "rateLimit" ? "rateLimit" : kind] ?? []).map((s) => new RegExp(s)),
    ];
    for (const p of pats) {
      const m = text.match(p);
      if (m) return { risk: kind, detail: m[0] };
    }
    return null;
  };
  // 验证码最优先（必须先人工），其次频繁，最后登录态
  return pick("captcha") ?? pick("rateLimit") ?? pick("auth");
}

// ---------- 元素取数 ----------
const textOf = (root: ParentNode, sel: string | undefined): string => {
  if (!sel) return "";
  const el = root.querySelector(sel);
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
};

/** 链接 → jobId。BOSS 的 /job_detail/<securityId>.html 之类：
 *  取路径末段去扩展名；拿不到 → 用链接全文做稳定散列。
 *  服务端幂等键白名单 [A-Za-z0-9_-]{1,90}（本仓 /extension/apply-record 契约）——
 *  站点/查询串里的冒号、点等一律清洗掉，总长截 90。 */
const safeJobKey = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
function jobIdFromLink(link: string): string {
  try {
    const u = new URL(link);
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const id = seg.replace(/\.(html?|shtml|aspx?|jsp)$/i, "");
    if (id && id !== "job_detail") return `site-${safeJobKey(u.hostname)}-${safeJobKey(id)}`.slice(0, 90);
    const q = u.searchParams.get("securityId") ?? u.searchParams.get("jobId") ?? u.searchParams.get("id");
    if (q) return `site-${safeJobKey(u.hostname)}-${safeJobKey(q)}`.slice(0, 90);
    // 稳定散列兜底（djb2）——同一链接永远同一个 id，幂等键够用了
    let h = 5381;
    for (const c of link) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
    return `site-${safeJobKey(u.hostname)}-h${h.toString(36)}`;
  } catch {
    return `site-unknown-${safeJobKey(link)}`.slice(0, 90);
  }
}

function cardToJob(card: Element, cfg: SiteConfig): RawJob | null {
  const f = cfg.listPage.fields;
  const title = textOf(card, f.title);
  const company = textOf(card, f.company);
  if (!title) return null;
  const a = (f.link ? card.querySelector(f.link) : card.querySelector("a")) as
    | HTMLAnchorElement | null;
  const link = a?.href ?? "";
  return {
    jobId: jobIdFromLink(link || `${title}@${company}`),
    title,
    companyName: company || "（未读公司名）",
    salaryDisplay: textOf(card, f.salary),
    city: textOf(card, f.city) || undefined,
    link,
    site: cfg.site,
  };
}

// ---------- 功能①采集：滚动翻页 + 卡片取数 ----------
async function collectJobs(cfg: SiteConfig): Promise<RawJob[]> {
  const sel = cfg.listPage.itemSelector;
  if (!sel) return [];
  const seen = new Map<string, RawJob>();
  let idleStrikes = 0;
  for (let round = 0; round < 40 && seen.size < COLLECT_MAX; round++) {
    for (const card of Array.from(document.querySelectorAll(sel))) {
      const job = cardToJob(card, cfg);
      if (job && !seen.has(job.jobId)) {
        seen.set(job.jobId, job);
        if (seen.size >= COLLECT_MAX) break;
      }
    }
    if (seen.size >= COLLECT_MAX) break;
    const before = seen.size;
    // 懒加载翻页：滚到底 → 等新卡；连续 SCROLL_IDLE_STRIKES 轮无新增即停
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" as ScrollBehavior });
    await sleep(SCROLL_WAIT_MS);
    if (seen.size === before) idleStrikes++; else idleStrikes = 0;
    if (idleStrikes >= SCROLL_IDLE_STRIKES) break;
  }
  return [...seen.values()];
}

// ---------- 聊天页：历史抓取 + 填入 + 发送 ----------
function grabChatHistory(cfg: SiteConfig): string {
  const els = document.querySelectorAll(cfg.chatPage.messageSelector);
  const lines: string[] = [];
  for (const el of Array.from(els)) {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
  }
  return lines.join("\n").slice(-HISTORY_MAX);
}

/** React/Vue 受控输入必须走原生 setter + input 事件，否则框架状态不认账。 */
function setNativeValue(el: HTMLElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc?.set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  // contenteditable
  el.focus();
  el.textContent = value;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
}

function findChatInput(cfg: SiteConfig): HTMLElement | null {
  const sels = cfg.chatPage.inputSelector.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of sels) {
    const el = document.querySelector(s) as HTMLElement | null;
    if (el && (el.offsetParent !== null || el.getAttribute("contenteditable") === "true")) return el;
  }
  // 兜底：页面里唯一的 textarea / contenteditable
  const ta = document.querySelector("textarea") as HTMLElement | null;
  if (ta) return ta;
  return document.querySelector("[contenteditable='true']") as HTMLElement | null;
}

function fillChatInput(cfg: SiteConfig, text: string): boolean {
  const el = findChatInput(cfg);
  if (!el) return false;
  setNativeValue(el, text);
  el.focus();
  return true;
}

function clickSend(cfg: SiteConfig): boolean {
  const sels = (cfg.chatPage.sendSelector ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of sels) {
    const el = document.querySelector(s) as HTMLElement | null;
    if (el) { el.click(); return true; }
  }
  // 文本兜底：找「发送」按钮
  for (const b of Array.from(document.querySelectorAll("button,[role=button],a"))) {
    if ((b.textContent ?? "").trim() === "发送") { (b as HTMLElement).click(); return true; }
  }
  return false;
}

// ---------- 打开沟通（批次逐岗：详情页点「立即沟通」→ 等聊天输入出现） ----------
async function greetOpen(
  cfg: SiteConfig,
  job: { jobId: string; title: string; detailUrl?: string | null },
): Promise<{ ok: boolean; detail?: string }> {
  const risk = detectRisk(cfg);
  if (risk) return { ok: false, detail: `风控:${risk.risk}:${risk.detail}` };
  if (pageKind(cfg, location.href) === "chat" && findChatInput(cfg)) return { ok: true };
  const sels = (cfg.greet.openChatSelector ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let btn: HTMLElement | null = null;
  for (const s of sels) {
    btn = document.querySelector(s) as HTMLElement | null;
    if (btn) break;
  }
  if (!btn) {
    // 文本兜底：「立即沟通」「聊一聊」「继续沟通」
    for (const b of Array.from(document.querySelectorAll("a,button,[role=button]"))) {
      const t = (b.textContent ?? "").trim();
      if (/立即沟通|聊一聊|继续沟通|立即投递/.test(t)) { btn = b as HTMLElement; break; }
    }
  }
  if (!btn) return { ok: false, detail: "当前页找不到沟通按钮（可能不在岗位详情页或已沟通）" };
  btn.click();
  // 等聊天页出现（同页 SPA 或弹层）：轮询输入框
  const deadline = Date.now() + GREET_OPEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = detectRisk(cfg);
    if (r) return { ok: false, detail: `风控:${r.risk}:${r.detail}` };
    if (findChatInput(cfg)) return { ok: true };
    await sleep(800);
  }
  return { ok: false, detail: "点了沟通但聊天输入框未出现（可能新开了窗口——见手验）" };
  void job;
}

// ---------- 功能④网申代填（§5 启发式字段映射） ----------
interface FieldMap { [labelPattern: string]: string } // 「姓名|name」→ canonical key

async function loadFieldMap(): Promise<FieldMap> {
  try {
    const res = await fetch(chrome.runtime.getURL("config/field-map.json"));
    if (res.ok) return (await res.json()) as FieldMap;
  } catch { /* 缺失就内置默认 */ }
  return {
    "姓名|name": "name",
    "手机|电话|phone|mobile": "phone",
    "邮箱|email|mail": "email",
    "学校|院校|school|university|college": "school",
    "专业|major": "major",
    "自我评价|个人介绍|自我介绍|summary|about": "summary",
    "期望薪资|薪资期望|salary": "expectSalary",
    "城市|所在地|location|city|工作地": "city",
    "工作年限|经验|years|experience": "years",
  };
}

/** 控件的可判读标签：label[for] / aria-label / placeholder / name / 近邻文本。 */
function controlLabel(el: HTMLElement): string {
  const id = el.getAttribute("id");
  if (id) {
    const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (lab?.textContent?.trim()) return lab.textContent.trim();
  }
  for (const attr of ["aria-label", "placeholder", "name", "title"]) {
    const v = el.getAttribute(attr)?.trim();
    if (v) return v;
  }
  const wrap = el.closest("label, .form-item, .field, .el-form-item, li, div");
  const t = wrap?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return t.slice(0, 60);
}

function canonicalFor(label: string, map: FieldMap): string | null {
  const l = label.toLowerCase();
  for (const [pattern, key] of Object.entries(map)) {
    for (const alt of pattern.split("|")) {
      if (alt && l.includes(alt.toLowerCase())) return key;
    }
  }
  return null;
}

async function fillApplyForm(
  cfg: SiteConfig,
  profile: Record<string, string>,
): Promise<{ ok: boolean; missing: string[] }> {
  const map = await loadFieldMap();
  const scope: ParentNode = cfg.applyPage.formSelector
    ? (document.querySelector(cfg.applyPage.formSelector) as ParentNode | null) ?? document
    : document;
  const missing: string[] = [];
  const filledKeys = new Set<string>();

  const controls = Array.from(
    scope.querySelectorAll("input, textarea, select"),
  ) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];

  for (const el of controls) {
    const tag = el.tagName.toLowerCase();
    const type = (el as HTMLInputElement).type ?? "";
    if (["hidden", "submit", "button", "password", "checkbox"].includes(type)) continue;
    if (type === "file") {
      // §5-5：附件上传控件一律不碰，提示人工上传
      missing.push("附件上传（需人工处理）");
      continue;
    }
    if (type === "radio") {
      // radio：按简历字段值匹配选项标签
      const name = (el as HTMLInputElement).name;
      const group = name
        ? Array.from(scope.querySelectorAll(`input[type=radio][name="${CSS.escape(name)}"]`))
        : [el];
      const head = group[0] as HTMLElement;
      const key = canonicalFor(controlLabel(head.closest(".form-item,.field,div") ?? head), map);
      const want = key ? profile[key] : "";
      if (want) {
        for (const r of group) {
          const lab = controlLabel(r as HTMLElement);
          if (lab.includes(want) || want.includes(lab)) {
            (r as HTMLInputElement).click();
            filledKeys.add(key!);
            break;
          }
        }
      }
      continue;
    }
    const label = controlLabel(el as HTMLElement);
    const key = canonicalFor(label, map);
    if (!key || !profile[key]) continue;
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const want = profile[key].toLowerCase();
      const opt = Array.from(sel.options).find(
        (o) => o.text.toLowerCase().includes(want) || want.includes(o.text.toLowerCase()),
      );
      if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); filledKeys.add(key); }
      continue;
    }
    setNativeValue(el as HTMLElement, profile[key]);
    filledKeys.add(key);
  }

  // 有画像值但页面没找到控件的键 → 缺项黄条
  const LABEL_CN: Record<string, string> = {
    name: "姓名", phone: "手机", email: "邮箱", school: "学校", major: "专业",
    summary: "自我评价", expectSalary: "期望薪资", city: "城市", years: "工作年限",
  };
  for (const [k, v] of Object.entries(profile)) {
    if (v && !filledKeys.has(k)) missing.push(LABEL_CN[k] ?? k);
  }
  return { ok: true, missing: [...new Set(missing)] };
}

// ---------- 入口：各适配器只调这一个 ----------
export function initSite(site: string, bundled: SiteConfig): void {
  let cfg = bundled;
  void loadConfig(site, bundled).then((c) => { cfg = c; });

  // 页面识别上报（含 SPA 路由变化轮询）：background 据此驱动自动草稿等
  let lastUrl = "";
  const announce = (): void => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const kind = pageKind(cfg, location.href);
    report({ kind: "rep:page", page: kind, url: location.href });
    const risk = detectRisk(cfg);
    if (risk) report({ kind: "rep:risk", risk: risk.risk, detail: risk.detail });
  };
  announce();
  setInterval(announce, 1000);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const cmd = message as ContentCommand;
    if (!cmd || typeof cmd !== "object" || !("kind" in cmd)) return false;
    switch (cmd.kind) {
      case "cmd:collect": {
        void (async () => {
          const risk = detectRisk(cfg);
          if (risk) { report({ kind: "rep:risk", ...risk }); return; }
          const jobs = await collectJobs(cfg);
          report({ kind: "rep:collected", jobs });
        })();
        sendResponse({ ack: true });
        return true;
      }
      case "cmd:chat-grab": {
        const text = grabChatHistory(cfg);
        report({ kind: "rep:chat-history", text });
        sendResponse({ ack: true });
        return true;
      }
      case "cmd:input-fill": {
        const ok = fillChatInput(cfg, cmd.text);
        report({ kind: "rep:filled", ok });
        sendResponse({ ack: true, ok });
        return true;
      }
      case "cmd:send-click": {
        // 只有确认链（模式 A/B）授权后 background 才会发这条
        const ok = clickSend(cfg);
        report({ kind: "rep:sent", ok });
        sendResponse({ ack: true, ok });
        return true;
      }
      case "cmd:apply-fill": {
        void fillApplyForm(cfg, cmd.profile).then((r) => {
          report({ kind: "rep:filled", ok: r.ok, missing: r.missing });
          if (r.missing.length) report({ kind: "evt:missing", fields: r.missing });
        });
        sendResponse({ ack: true });
        return true;
      }
      case "cmd:greet-open": {
        void greetOpen(cfg, cmd.job).then((r) =>
          report({ kind: "rep:greet-ready", ok: r.ok, detail: r.detail }),
        );
        sendResponse({ ack: true });
        return true;
      }
      case "cmd:risk-check": {
        const risk = detectRisk(cfg);
        if (risk) report({ kind: "rep:risk", ...risk });
        sendResponse({ ack: true, risk: risk?.risk ?? null });
        return true;
      }
    }
    return false;
  });
}
