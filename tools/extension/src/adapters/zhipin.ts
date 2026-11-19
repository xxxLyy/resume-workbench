// BOSS 直聘适配器：通用引擎 + config/zhipin.json（§7 适配层）。
// 站点改版 → 改 src/config/zhipin.json 后 `npm run build`；
// 或只改 dist/config/zhipin.json 重载页面即生效（不 build 也行）。
// 当前选择器按 2026-11 主流结构写：列表 .job-card-wrapper/.job-name，
// 聊天 .chat-input 系、详情页 .btn-startchat 系。失效表现：采集数 0
// 或填入失败 → sidepanel 会提示「页面结构可能已改版」。
import cfg from "../config/zhipin.json";
import { initSite } from "../content/common";
import type { SiteConfig } from "../types/site";

initSite("zhipin", cfg as SiteConfig);
