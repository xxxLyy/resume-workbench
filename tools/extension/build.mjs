// 构建：esbuild 打包 src → dist/（MV3 手写 TS，无运行时依赖）。
//   · 5 个入口：background（service worker）/ sidepanel / 三站 content adapter
//   · format=iife：bundle 后无 import/export，module 与 classic 两种装载都兼容
//     （manifest background.type=module 装载 iife 产物是合法的）
//   · 静态拷贝：manifest.json / sidepanel.html / sidepanel.css / config/*.json
//     config 留在 dist 纯 json——站点改版改 dist json 重载页面即生效（§7）
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(root, "src");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "adapters"), { recursive: true });
fs.mkdirSync(path.join(dist, "config"), { recursive: true });

await build({
  entryPoints: {
    background: path.join(src, "background.ts"),
    sidepanel: path.join(src, "sidepanel.ts"),
    "adapters/zhipin": path.join(src, "adapters/zhipin.ts"),
    "adapters/liepin": path.join(src, "adapters/liepin.ts"),
    "adapters/zhaopin": path.join(src, "adapters/zhaopin.ts"),
  },
  bundle: true,
  format: "iife",
  target: "chrome110",
  outdir: dist,
  logLevel: "info",
});

for (const f of ["manifest.json"]) {
  fs.copyFileSync(path.join(root, f), path.join(dist, f));
}
for (const f of ["sidepanel.html", "sidepanel.css"]) {
  fs.copyFileSync(path.join(src, f), path.join(dist, f));
}
for (const f of fs.readdirSync(path.join(src, "config"))) {
  if (f.endsWith(".json")) {
    fs.copyFileSync(path.join(src, "config", f), path.join(dist, "config", f));
  }
}
console.log("dist/ 就绪：chrome://extensions → 开发者模式 → 加载已解压 dist/");
