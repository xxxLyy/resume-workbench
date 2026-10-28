# 简历平台

本地简历编辑平台：浏览器编辑 → 保存即快照；**正文与 PDF 分离** —— 保存只写正文，PDF 在导出页/「重新生成」时显式渲染（正文改了 PDF 不会自动跟着变，导出页会标「PDF 较旧」）。

## 使用

- 编辑：http://localhost:7766/（开机自动启动）（端口被占时自动顺延 7767/7768，以 ~/resume/logs/resume-server.log 为准）
- 首页（文档列表/上传 PDF 导入）：http://localhost:7766/
- 上传导入：有 config.json（参考 config.example.json）时 LLM 结构化灌模板；无配置时降级为纯文本导入
- 历史版本：页面右上角"🕘 历史版本"，可回滚到任意快照
- 导出/PDF：首页文档卡「导出」进导出页 —— 排版诊断可「应用本轮建议并重渲染」；「确认可投递」只有在**整体审阅完成 + PDF 与当前内容一致**时才出现，点击后状态落到 reviewed（可投递是派生量，不是存储字段）
- 大模型设置：http://localhost:7766/settings（OpenAI 兼容；火山方舟 baseURL 见 config.example.json）
- AI 辅助：编辑器里选中文字点"✨ AI 改写"（预览后应用）；右下角 🤖 打开对话整篇调整
- config.json 含 API key，属于本地私密文件，不要分享/提交
- 演示/试用：RESUME_ROOT=<空目录> node server.mjs（空根起步手动建文档即可试用；演示数据夹具的生成随 M2/M3 提供，演示模式 UI 同见 M2/M3）；环境自检 node doctor.mjs（--probe 才做 Chromium 探针）

## 运维

- 日志：`~/resume/logs/resume-server.log`（轮转 50MB/尾 2MB）
- 重启服务：先确保日志目录存在 `mkdir -p ~/resume/logs`（launchd 在启动 node 前就打开日志文件，首次 `launchctl bootstrap` 前该目录必须已存在），再 `launchctl bootout gui/$(id -u)/com.lhx.resume-server && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lhx.resume-server.plist`
- 临时停服：`launchctl bootout gui/$(id -u)/com.lhx.resume-server`（注意 KeepAlive，直接 kill 进程会被自动拉起）
- 手动冒烟测试：`bash ~/resume/test.sh`
- 完整验收（含浏览器、渲染、隐私四套件）：`RESUME_TEST_STRICT=1 npm run test:all`
  —— 严格模式下缺浏览器即视为未完成，不会降级放过
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
├── ai-panel.js / job-panel.js / zone-panel.js   编辑器 AI / 岗位 / 区域面板
├── resource-slots.mjs            共享容量池（AI 与渲染各 2 个并发）
├── render-safe.mjs               受信渲染输入（未知脚本与外联在渲染前被剥离）
├── render-publish.mjs            PDF 与旁车成对发布（失败不留混合产物）
├── template.html                文档骨架（8 占位符）
├── test.sh / test-structure.sh / test-render.sh   测试三套件
├── test-fixtures/reliability/     可靠性回归夹具（每项一个，可单独跑）
├── test-fixtures/history/         脱敏历史编辑器主脚本夹具（逐字，勿改）
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

- 升级 playwright-core 时修订号由 chromium.mjs 的 expectedRevision() 从 node_modules/playwright-core/browsers.json 自动读取，无需手改；test-structure.sh 段 X 的 '1223' 断言是故意的升级 tripwire
- 7890-7892 禁用（Clash 系代理默认端口段，本机 Clash Verge 用 7897）
