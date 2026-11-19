// 智联招聘适配器：通用引擎 + config/zhaopin.json（§7 适配层）。
// §11 允许按站分批交付：本文件是同构骨架 + 已知选择器初值。
// TODO（真实站点联调时核对）：搜索列表为 .joblist-box__item 系，
// 聊天在 im/rd5 域下，URL 模式与输入框选择器未逐页实测。
import cfg from "../config/zhaopin.json";
import { initSite } from "../content/common";
import type { SiteConfig } from "../types/site";

initSite("zhaopin", cfg as SiteConfig);
