// 猎聘适配器：通用引擎 + config/liepin.json（§7 适配层）。
// §11 允许按站分批交付：本文件是同构骨架 + 已知选择器初值。
// TODO（真实站点联调时核对）：列表卡片容器、聊天页 URL 模式、
// 「聊一聊」按钮选择器均按猎聘 2024+ 结构估写，未做逐页实测。
import cfg from "../config/liepin.json";
import { initSite } from "../content/common";
import type { SiteConfig } from "../types/site";

initSite("liepin", cfg as SiteConfig);
