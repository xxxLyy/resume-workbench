// sidepanel 面板（底座照搬 efc apps/extension；接线改指本仓简历工作台）。
// 原生 DOM（不用框架——面板够轻）：登录区/模式三档/阈值/批次控制/
// 待投清单（生成招呼→编辑→复制/填入）/候选清单（采集+匹配徽标+加入待投）/
// 确认卡（模式 A 逐岗、模式 B 批次首岗）/缺项黄条/打开工作台链接。
// 与工作台的一切通信都经 background（REST helper 单一入口，token 不出 SW）。
import type {
  Settings, Candidate, BatchState, BatchItem, PanelRequest, EngineEvent,
} from "./types/site";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = (tag: string, cls = "", text = ""): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

interface ApiResp { error?: string; [k: string]: unknown }
const req = <T = ApiResp>(m: PanelRequest): Promise<T> =>
  chrome.runtime.sendMessage(m) as Promise<T>;

// ---------- 本地状态 ----------
let settings: Settings = {
  workbenchUrl: "http://127.0.0.1:7766", token: "", docId: "",
  mode: "A", threshold: 60, autoDraft: true,
};
let shortlist: { jobId: string; title: string; companyName: string; salaryDisplay: string | null; detailUrl: string | null; dueDate: string | null }[] = [];
let candidates: Candidate[] = [];
let lastDraftJobId = "";
let batchState: BatchState = { status: "IDLE", total: 0, index: 0, done: 0, skipped: 0, failed: 0 };

// ---------- 通知条 ----------
const notice = (level: "info" | "warn" | "error", text: string): void => {
  const n = $("notice");
  n.className = `notice ${level === "error" ? "error" : level === "info" ? "info" : ""}`;
  n.textContent = text;
};
const clearNotice = (): void => { $("notice").className = "notice hidden"; };

// ---------- 渲染：批次状态 ----------
function renderBatch(): void {
  const b = batchState;
  const bar = $("batchBar");
  const run = b.status === "RUNNING", paused = b.status === "PAUSED";
  ($("btnBatchStart") as HTMLButtonElement).disabled = run;
  ($("btnBatchPause") as HTMLButtonElement).disabled = !run;
  ($("btnBatchResume") as HTMLButtonElement).disabled = !paused;
  ($("btnBatchStop") as HTMLButtonElement).disabled = !(run || paused);
  bar.className = `batch-bar ${run ? "running" : paused ? "paused" : ""}`;
  if (b.status === "IDLE" && !b.total) { bar.textContent = "空闲"; return; }
  const cur = b.current ? `｜当前：${b.current.title}@${b.current.companyName}` : "";
  bar.textContent =
    `${b.status === "RUNNING" ? "运行中" : b.status === "PAUSED" ? "已暂停" : b.status === "STOPPED" ? "已停止" : "完成"} ` +
    `${Math.min(b.index + (run ? 1 : 0), b.total)}/${b.total}${cur}` +
    `｜发 ${b.done} 跳 ${b.skipped} 败 ${b.failed}` +
    (b.pauseReason ? `｜${b.pauseReason}` : "");
}

// ---------- 渲染：候选清单 ----------
const LEVEL_CN: Record<string, string> = { weak: "弱", medium: "中", strong: "强", excellent: "极佳" };
function renderCandidates(): void {
  const box = $("candList");
  box.innerHTML = "";
  $("candCount").textContent = candidates.length ? `${candidates.length} 岗` : "";
  if (!candidates.length) {
    box.append(el("div", "empty muted", "在岗位列表页点「采集本页岗位」"));
    return;
  }
  for (const c of candidates) {
    const row = el("div", "job");
    const head = el("div");
    head.append(el("span", "t", c.title));
    if (c.matchScore !== null) {
      head.append(el("span", `badge score${c.matchScore < settings.threshold ? " weak" : ""}`,
        `${c.matchScore}${c.matchLevel ? LEVEL_CN[c.matchLevel] ?? c.matchLevel : ""}`));
    }
    if (c.contacted) head.append(el("span", "badge contacted", "已沟通过"));
    row.append(head);
    row.append(el("div", "c",
      [c.companyName, c.salaryDisplay, c.city].filter(Boolean).join(" · ")));
    const acts = el("div", "acts");
    const btnAdd = el("button", "btn mini", c.contacted ? "仍要加入待投" : "加入待投") as HTMLButtonElement;
    btnAdd.onclick = () => void addToApply(c);
    acts.append(btnAdd);
    if (c.link) {
      const open = el("a", "btn mini", "打开岗位") as HTMLAnchorElement;
      open.href = c.link; open.target = "_blank";
      acts.append(open);
    }
    row.append(acts);
    box.append(row);
  }
}

/** 加入待投：apply-record 幂等（已 applied/replied → 行原样返回并提示「已沟通过」） */
async function addToApply(c: Candidate): Promise<void> {
  const r = await req<{ status?: string; error?: string }>({
    kind: "apply:record",
    jobId: c.jobId, status: "to_apply",
    company: c.companyName, role: c.title, link: c.link,
  });
  if (r.error) { notice("warn", `加入待投失败：${r.error}`); return; }
  if (r.status && r.status !== "to_apply") {
    notice("info", `「${c.title}」已沟通过（${r.status}），未回退`);
  } else {
    notice("info", `已加入待投：${c.title}`);
  }
  void loadShortlist();
}

// ---------- 渲染：待投清单 ----------
function renderShortlist(): void {
  const box = $("shortList");
  box.innerHTML = "";
  if (!shortlist.length) {
    box.append(el("div", "empty muted", "暂无待投岗位"));
    return;
  }
  for (const j of shortlist) {
    const row = el("div", "job");
    const head = el("div");
    head.append(el("span", "t", j.title));
    row.append(head);
    row.append(el("div", "c",
      [j.companyName, j.salaryDisplay, j.dueDate ? `截止 ${j.dueDate}` : ""].filter(Boolean).join(" · ")));
    const acts = el("div", "acts");
    const btnGreet = el("button", "btn mini", "生成招呼") as HTMLButtonElement;
    btnGreet.onclick = () => void genGreeting(j, row, btnGreet);
    acts.append(btnGreet);
    if (j.detailUrl) {
      const open = el("a", "btn mini", "打开岗位") as HTMLAnchorElement;
      open.href = j.detailUrl; open.target = "_blank";
      acts.append(open);
    }
    row.append(acts);
    box.append(row);
  }
}

async function genGreeting(
  j: { jobId: string; title: string; companyName: string },
  row: HTMLElement,
  btn: HTMLButtonElement,
): Promise<void> {
  btn.disabled = true; btn.textContent = "生成中…";
  const r = await req<{ greeting?: string; error?: string }>({ kind: "greeting", jobId: j.jobId });
  btn.disabled = false; btn.textContent = "生成招呼";
  if (r.error || !r.greeting) { notice("warn", `「${j.title}」${r.error ?? "生成失败"}`); return; }
  clearNotice();
  const old = row.querySelector("textarea");
  old?.remove();
  const oldActs = row.querySelector(".greet-acts");
  oldActs?.remove();
  const ta = document.createElement("textarea");
  ta.rows = 3; ta.value = r.greeting; ta.maxLength = 200;
  row.append(ta);
  const acts = el("div", "acts greet-acts");
  const btnCopy = el("button", "btn mini", "复制") as HTMLButtonElement;
  btnCopy.onclick = () => {
    void navigator.clipboard.writeText(ta.value);
    notice("info", "已复制招呼语");
  };
  const btnFill = el("button", "btn mini", "填入页面") as HTMLButtonElement;
  btnFill.onclick = async () => {
    const fr = await req<{ ok?: boolean; error?: string }>({ kind: "fill:input", text: ta.value });
    notice(fr.error ? "warn" : "info", fr.error ?? "已填入当前页聊天输入框（未发送）");
  };
  acts.append(btnCopy, btnFill);
  row.append(acts);
}

// ---------- 加载 ----------
async function loadResumes(): Promise<void> {
  const sel = $("resumeSel") as HTMLSelectElement;
  const r = await req<{ error?: string } | { code?: number; data?: { id: string; title: string }[] } | { id: string; title: string }[]>({ kind: "resumes:list" });
  sel.innerHTML = "";
  // 本仓 GET /api/resume 包壳 {code:0,data:[…]}；efc 老底座直收数组——两种形状都认
  const list = Array.isArray(r) ? r : (Array.isArray((r as { data?: unknown }).data) ? (r as { data: { id: string; title: string }[] }).data : null);
  if (!list) {
    sel.append(new Option(`（加载失败：${(r as ApiResp).error ?? "?"}）`, ""));
    return;
  }
  if (!list.length) {
    sel.append(new Option("（工作台暂无简历，请先创建）", ""));
    notice("warn", "工作台没有简历——打分/招呼/网申都不可用，请先去工作台创建");
    return;
  }
  for (const it of list) sel.append(new Option(it.title, it.id));
  if (settings.docId) sel.value = settings.docId;
  if (!sel.value) sel.value = list[0].id;
}

async function loadShortlist(): Promise<void> {
  const r = await req<{ items?: typeof shortlist; error?: string }>({ kind: "shortlist" });
  if (r.error) { notice("warn", `待投清单：${r.error}`); return; }
  shortlist = r.items ?? [];
  renderShortlist();
}

// ---------- 事件绑定 ----------
function bind(): void {
  $("btnPing").onclick = async () => {
    await saveForm();
    const dot = $("connDot");
    const r = await req<{ ok?: boolean; error?: string }>({ kind: "wb:ping" });
    dot.className = `dot ${r.ok ? "ok" : "bad"}`;
    $("pingResult").textContent = r.ok ? "已连通" : `失败：${r.error ?? "?"}`;
    if (r.ok) { void loadResumes(); void loadShortlist(); }
  };
  $("btnSaveLogin").onclick = async () => {
    await saveForm();
    notice("info", "设置已保存");
    void loadResumes();
  };
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>("input[name=mode]"))) {
    radio.onchange = () => { if (radio.checked) void save({ mode: radio.value as Settings["mode"] }); };
  }
  ($("threshold") as HTMLInputElement).oninput = (e) => {
    $("thresholdVal").textContent = (e.target as HTMLInputElement).value;
  };
  ($("threshold") as HTMLInputElement).onchange = (e) => {
    void save({ threshold: Number((e.target as HTMLInputElement).value) });
  };
  ($("autoDraft") as HTMLInputElement).onchange = (e) => {
    void save({ autoDraft: (e.target as HTMLInputElement).checked });
  };
  ($("autoCollect") as HTMLInputElement).onchange = (e) => {
    void save({ autoCollect: (e.target as HTMLInputElement).checked });
  };
  ($("resumeSel") as HTMLSelectElement).onchange = (e) => {
    void save({ docId: (e.target as HTMLSelectElement).value });
  };
  $("btnCollect").onclick = async () => {
    const r = await req<{ ok?: boolean; error?: string }>({ kind: "collect:start" });
    if (r.error) notice("warn", r.error);
    else notice("info", "采集中（滚动翻页，最多 100 岗）…");
  };
  $("btnDraft").onclick = () => void genDraft();
  $("btnDraftRegen").onclick = () => void genDraft();
  $("btnDraftFill").onclick = async () => {
    const ta = $("draftText") as HTMLTextAreaElement;
    const r = await req<{ ok?: boolean; error?: string }>({ kind: "fill:input", text: ta.value });
    notice(r.error ? "warn" : "info", r.error ?? "已填入（未发送）");
  };
  $("btnApplyFill").onclick = async () => {
    const r = await req<{ ok?: boolean; error?: string }>({ kind: "apply:fill" });
    if (r.error) notice("warn", r.error);
    else notice("info", "已尝试代填本页表单（附件与未识别项需人工）");
  };
  $("btnShortlistRefresh").onclick = () => void loadShortlist();
  $("btnBatchStart").onclick = async () => {
    if (!shortlist.length) { notice("warn", "待投清单为空——先采集并加入待投"); return; }
    const items: BatchItem[] = shortlist.map((j) => ({
      jobId: j.jobId, title: j.title, companyName: j.companyName, detailUrl: j.detailUrl,
    }));
    await req({ kind: "batch:start", items });
  };
  $("btnBatchPause").onclick = () => void req({ kind: "batch:pause" });
  $("btnBatchResume").onclick = () => void req({ kind: "batch:resume" });
  $("btnBatchStop").onclick = () => void req({ kind: "batch:stop" });
  $("btnConfirmSend").onclick = () => resolveConfirm("send");
  $("btnConfirmSkip").onclick = () => resolveConfirm("skip");
  $("btnConfirmStop").onclick = () => resolveConfirm("stop");
}

function resolveConfirm(action: "send" | "skip" | "stop"): void {
  $("confirmCard").classList.add("hidden");
  void req({ kind: "confirm:resolve", action });
}

async function genDraft(): Promise<void> {
  const r = await req<{ draft?: string; error?: string }>({ kind: "chat:draft", jobId: lastDraftJobId });
  if (r.error || !r.draft) { notice("warn", r.error ?? "草稿生成失败"); return; }
  clearNotice();
  ($("draftText") as HTMLTextAreaElement).value = r.draft;
  $("draftCard").classList.remove("hidden");
}

// ---------- 设置读写 ----------
async function save(patch: Partial<Settings>): Promise<void> {
  const r = await req<{ settings?: Settings; error?: string }>({ kind: "settings:set", patch });
  if (r.settings) settings = r.settings;
}
async function saveForm(): Promise<void> {
  await save({
    workbenchUrl: ($("wbUrl") as HTMLInputElement).value.trim() || "http://127.0.0.1:7766",
    token: ($("wbToken") as HTMLInputElement).value.trim(),
    docId: ($("resumeSel") as HTMLSelectElement).value,
  });
  $("openWb").setAttribute("href", settings.workbenchUrl);
}

// ---------- background → panel 事件 ----------
chrome.runtime.onMessage.addListener((message) => {
  const evt = message as EngineEvent;
  switch (evt.kind) {
    case "evt:candidates": {
      const incoming = evt.items;
      if (evt.append) {
        const seen = new Set(candidates.map((c) => c.jobId));
        candidates = [...candidates, ...incoming.filter((c) => !seen.has(c.jobId))];
      } else candidates = incoming;
      renderCandidates();
      break;
    }
    case "evt:collect-done":
      notice("info", `采集完成：${evt.count} 岗过阈值`);
      break;
    case "evt:collect-error": notice("warn", evt.error); break;
    case "evt:batch": batchState = evt.state; renderBatch(); break;
    case "evt:confirm": {
      const c = $("confirmCard");
      $("confirmText").textContent = evt.batch
        ? `确认批量发送招呼（首个：${evt.job.title} @ ${evt.job.companyName}）？`
        : `确认发送这份招呼给「${evt.job.title} @ ${evt.job.companyName}」？`;
      c.classList.remove("hidden");
      break;
    }
    case "evt:draft":
      ($("draftText") as HTMLTextAreaElement).value = evt.draft;
      lastDraftJobId = evt.jobId;
      $("draftCard").classList.remove("hidden");
      break;
    case "evt:missing":
      notice("warn", `以下字段未能自动填写：${evt.fields.join("、")}（请人工补齐）`);
      break;
    case "evt:notice": notice(evt.level, evt.text); break;
  }
});

// ---------- 启动 ----------
async function init(): Promise<void> {
  bind();
  const r = await req<{ settings?: Settings }>({ kind: "settings:get" });
  if (r.settings) settings = r.settings;
  ($("wbUrl") as HTMLInputElement).value = settings.workbenchUrl;
  ($("wbToken") as HTMLInputElement).value = settings.token;
  for (const radio of Array.from(document.querySelectorAll<HTMLInputElement>("input[name=mode]"))) {
    radio.checked = radio.value === settings.mode;
  }
  ($("threshold") as HTMLInputElement).value = String(settings.threshold);
  $("thresholdVal").textContent = String(settings.threshold);
  ($("autoDraft") as HTMLInputElement).checked = settings.autoDraft;
  ($("autoCollect") as HTMLInputElement).checked = settings.autoCollect;
  $("openWb").setAttribute("href", settings.workbenchUrl);
  const st = await req<{ state?: BatchState }>({ kind: "batch:state" });
  if (st.state) { batchState = st.state; renderBatch(); }
  if (settings.token) { void loadResumes(); void loadShortlist(); }
  else notice("warn", "先填简历工作台地址与 Token，点「连通检测」");
}
void init();
