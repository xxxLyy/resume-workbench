// 站点配置（adapters/config/<site>.json）的形状约定 + 三端共享的消息协议类型。
// §7 DOM 适配层：每站一个纯配置，适配器 JS 只读配置 + 通用取数函数；
// 站点改版 → 只改 json，不改代码。

export interface FieldSelectors {
  /** 卡片内取岗位标题 */
  title: string;
  /** 公司名 */
  company: string;
  /** 薪资文案 */
  salary?: string;
  /** 城市/区域 */
  city?: string;
  /** 详情链接（<a> 或带 href 的元素；空则取卡片内第一个 a） */
  link?: string;
  /** 公司附加信息（规模/行业，可选） */
  extra?: string;
}

export interface SiteConfig {
  /** 站名（日志/提示用） */
  site: string;
  listPage: {
    /** location.href 命中的正则（字符串形式，引擎 new RegExp） */
    urlPattern: string;
    /** 岗位卡片选择器 */
    itemSelector: string;
    fields: FieldSelectors;
    /** 翻页模式：scroll=滚动到底懒加载（BOSS 型） */
    paginate?: "scroll";
  };
  chatPage: {
    urlPattern: string;
    /** 会话消息条目选择器（逐条文本化后 \n 拼接） */
    messageSelector: string;
    /** 聊天输入框（textarea / input / contenteditable） */
    inputSelector: string;
    /** 发送按钮（只有确认链授权后才点） */
    sendSelector?: string;
  };
  applyPage: {
    urlPattern: string;
    /** 表单容器（启发式字段映射的作用域） */
    formSelector?: string;
  };
  greet: {
    /** 详情页「立即沟通/聊一聊」按钮 */
    openChatSelector?: string;
    /** 详情页岗位名（校验打开的是不是目标岗位） */
    detailTitleSelector?: string;
  };
  /** 风控文案探测：页面出现即视为对应类别（正则字符串数组） */
  riskText?: { captcha?: string[]; rateLimit?: string[]; auth?: string[] };
}

/** 采集到的岗位卡（content → background） */
export interface RawJob {
  jobId: string;
  title: string;
  companyName: string;
  salaryDisplay: string;
  city?: string;
  link: string;
  site: string;
}

/** 候选清单条目（打分后 → sidepanel） */
export interface Candidate extends RawJob {
  matchScore: number | null;
  matchLevel: string | null;
  /** 已沟通过：job_tracking 已有 applied/replied 等更前状态 */
  contacted?: boolean;
  /** 低于阈值被丢弃的不进清单；采集失败原因记录 */
  dropped?: string;
}

/** 批次队列项（sidepanel → background） */
export interface BatchItem {
  jobId: string;
  title: string;
  companyName: string;
  detailUrl?: string | null;
  status?: string;
}

export type BatchStatus = "IDLE" | "RUNNING" | "PAUSED" | "STOPPED";

export interface BatchState {
  status: BatchStatus;
  total: number;
  index: number;
  current?: { jobId: string; title: string; companyName: string } | null;
  /** PAUSED 的原因（风控/登录态/确认超时） */
  pauseReason?: string;
  /** 当前岗已自动刷新重试过一次（请求受限只自动重试一次） */
  retried?: boolean;
  done: number;
  skipped: number;
  failed: number;
}

export interface Settings {
  workbenchUrl: string;
  token: string;
  /** 默认简历（服务端契约字段名 = docId；母版下拉与打分/招呼/代填都用它） */
  docId: string;
  /** A 逐岗确认 / B 全自动 / C 无需确认（只控填入类，默认） */
  mode: "A" | "B" | "C";
  /** 匹配阈值（默认 60），低于阈值不进候选清单 */
  threshold: number;
  /** 新会话聊天页自动生成草稿（填入不发送） */
  autoDraft: boolean;
  /** 打开职位列表页自动采集（逐卡打分走 LLM，默认关：用户主动开） */
  autoCollect: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  workbenchUrl: "http://127.0.0.1:7766",
  token: "",
  docId: "",
  mode: "A", // §6：sidepanel 单选默认「逐岗确认」
  threshold: 60,
  autoDraft: true,
  autoCollect: false,
};

// ---------- 消息协议 ----------
// sidepanel → background（请求-响应；kind 前缀 req/）
export type PanelRequest =
  | { kind: "settings:get" }
  | { kind: "settings:set"; patch: Partial<Settings> }
  | { kind: "wb:ping" }
  | { kind: "resumes:list" }
  | { kind: "shortlist" }
  | { kind: "preference" }
  | { kind: "resume:detail"; docId?: string }
  | { kind: "greeting"; jobId: string }
  | { kind: "chat:draft"; jobId: string }
  | {
      kind: "apply:record"; jobId: string; status: string;
      company?: string; role?: string; link?: string;
    }
  | { kind: "collect:start" }
  | { kind: "fill:input"; text: string }
  | { kind: "apply:fill" }
  | { kind: "batch:start"; items: BatchItem[] }
  | { kind: "batch:pause" }
  | { kind: "batch:resume" }
  | { kind: "batch:stop" }
  | { kind: "batch:state" }
  | { kind: "confirm:resolve"; action: "send" | "skip" | "stop" };

// content → background / background → sidepanel（单向事件；kind 前缀 evt/）
export type EngineEvent =
  | { kind: "evt:candidates"; items: Candidate[]; append: boolean }
  | { kind: "evt:collect-done"; count: number }
  | { kind: "evt:collect-error"; error: string }
  | { kind: "evt:batch"; state: BatchState }
  | { kind: "evt:confirm"; job: { jobId: string; title: string; companyName: string }; greeting: string; batch?: boolean }
  | { kind: "evt:draft"; jobId: string; draft: string }
  | { kind: "evt:missing"; fields: string[] }
  | { kind: "evt:notice"; level: "info" | "warn" | "error"; text: string };

// background → content（指令）
export type ContentCommand =
  | { kind: "cmd:collect" }
  | { kind: "cmd:chat-grab" }
  | { kind: "cmd:input-fill"; text: string }
  | { kind: "cmd:send-click" }
  | { kind: "cmd:apply-fill"; profile: Record<string, string> }
  | { kind: "cmd:greet-open"; job: { jobId: string; title: string; detailUrl?: string | null } }
  | { kind: "cmd:risk-check" };

// content → background（回报）
export type ContentReport =
  | { kind: "rep:collected"; jobs: RawJob[] }
  | { kind: "rep:chat-history"; text: string }
  | { kind: "rep:filled"; ok: boolean; missing?: string[] }
  | { kind: "rep:sent"; ok: boolean }
  | { kind: "rep:greet-ready"; ok: boolean; detail?: string }
  | { kind: "rep:risk"; risk: "captcha" | "rateLimit" | "auth"; detail: string }
  | { kind: "rep:page"; page: "chat" | "list" | "apply" | "other"; url: string };
