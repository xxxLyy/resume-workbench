# 简历平台

本地简历编辑平台：浏览器编辑 → 保存即快照+自动出 PDF。

## 使用

- 编辑：http://localhost:7766/（开机自动启动）（端口被占时自动顺延 7767/7768，以 /tmp/resume-server.log 为准）
- 首页（文档列表/上传 PDF 导入）：http://localhost:7766/
- 上传导入：有 config.json（参考 config.example.json）时 LLM 结构化灌模板；无配置时降级为纯文本导入
- 历史版本：页面右上角"🕘 历史版本"，可回滚到任意快照
- 大模型设置：http://localhost:7766/settings（OpenAI 兼容；火山方舟 baseURL 见 config.example.json）
- AI 辅助：编辑器里选中文字点"✨ AI 改写"（预览后应用）；右下角 🤖 打开对话整篇调整
- config.json 含 API key，属于本地私密文件，不要分享/提交
- 演示/试用：RESUME_ROOT=<空目录> node server.mjs（配合 test.sh 夹具生成虚拟数据；演示模式 UI 见 M2/M3）；环境自检 node doctor.mjs（--probe 才做 Chromium 探针）

## 运维

- 日志：`/tmp/resume-server.log`
- 重启服务：`launchctl bootout gui/$(id -u)/com.lhx.resume-server && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lhx.resume-server.plist`
- 临时停服：`launchctl bootout gui/$(id -u)/com.lhx.resume-server`（注意 KeepAlive，直接 kill 进程会被自动拉起）
- 手动冒烟测试：`bash ~/resume/test.sh`
- 卸载：`launchctl bootout gui/$(id -u)/com.lhx.resume-server && rm ~/Library/LaunchAgents/com.lhx.resume-server.plist`
- 隐私门槛：bash privacy-check.sh（建仓/开源前必跑）；日志在 ~/resume/logs/（轮转 50MB/尾 2MB）

## 结构

**项目约定（2026-09-10 起，所有项目统一）：一切项目相关物都收在单个项目根目录下，不四处分散。**

```
~/resume/                        ← 项目根目录（代码+文档+数据 全在这）
├── server.mjs                   服务（Node 零框架，全部路由）
├── render.mjs                   渲染（playwright-core + 系统缓存 Chromium）
├── llm.mjs / ai.mjs             LLM 客户端 / AI prompt 与解析
├── importer.mjs / structure.mjs PDF 导入 / 结构化组装
├── ai-panel.js                  编辑器 AI 面板
├── template.html                文档骨架（8 占位符）
├── test.sh / test-structure.sh / test-render.sh   测试三套件
├── package.json                 唯一依赖 playwright-core@1.60.0（pin）
├── dev-docs/                    ★ 项目文档（设计/计划/交接）
│   ├── 2026-08-17-resume-platform-design.md      设计 spec
│   ├── 2026-08-17-resume-platform-phase1.md      三期实施计划 ×3
│   ├── 2026-09-08-resume-platform-phase2.md
│   ├── 2026-09-08-resume-platform-phase3.md
│   ├── handoff.md                                交接文档
│   └── com.lhx.resume-server.plist.example       launchd 配置参考（生效的在 ~/Library/LaunchAgents/）
├── docs/                        简历文档（数据）
├── snapshots/                   快照（每文档留最近 50 份）
├── pdfs/                        最新 PDF
└── config.json                  LLM 配置（私密，勿分享）
```

- 升级 playwright-core 时必须同步 render.mjs 里的 chromium_headless_shell 修订号（见其 browsers.json）
- 7890-7892 禁用（Clash 系代理默认端口段，本机 Clash Verge 用 7897）
