# 简历平台（Resume Platform）设计文档

- 日期：2026-08-17
- 状态：待用户审阅
- 前置工作：单简历 HTML→PDF 流水线（career-ops，已上线使用中）
- 代码风格约束：全部实现遵循 ponytail 原则（最简可用、零多余抽象、优先标准库）

## 1. 目标（用户已确认的痛点）

1. **保存不再出错**：保存 = 直接写文件，无弹窗、无目录选择、无存错可能
2. **版本历史可回滚**：每次保存自动快照，可随时回滚到任意历史版本
3. **重启后零操作**：launchd 开机自启，不依赖打开终端
4. **多文档平台化**：可管理多份简历，支持上传其它 PDF 导入为可编辑文档
5. **大模型辅助修改**：本地配置 API key，支持区块级改写 + 对话式整篇调整

非目标（YAGNI 明确排除）：多设备/局域网访问、用户账号体系、云端同步、保留原 PDF 排版编辑。

## 2. 关键约束（已实测）

- macOS TCC 禁止 launchd 进程访问 `~/Documents`（2026-08-16 实测：bash 可执行，`ls ~/Documents` 返回 EPERM）→ **平台文件必须放在 `~/Documents` 之外**，选址 `~/resume/`
- 渲染依赖 Playwright + Chromium：Chromium 已缓存在 `~/Library/Caches/ms-playwright`（非保护目录），平台用 `playwright-core` 复用该缓存，不重复下载浏览器
- 端口 7890/7891/7892 当前均空闲（2026-08-17 lsof 实测）
- launchd 环境无用户 PATH：`com.lhx.resume-server.plist` 必须显式配置 `EnvironmentVariables.PATH = /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`（node、pdftotext 所在）

## 3. 架构

```
浏览器 → http://localhost:7890（首选端口，占用时顺延 7891/7892，实际端口写入日志）
            │
            ├─ GET  /                 → 文档列表首页（所有简历卡片）
            ├─ GET  /edit?id=         → 编辑器页面
            ├─ POST /save?id=         → 原子写 docs/<id>.html + 快照 + 触发渲染
            ├─ GET  /pdf?id=          → 下载该文档最新 PDF
            ├─ POST /upload           → 上传 PDF → 提取文本 → LLM 结构化 → 生成新文档
            ├─ GET|POST /settings     ←→ 大模型配置页（baseURL/key/model）
            ├─ POST /ai/rewrite       → 区块级改写（选中文字+指令→对比预览→应用）
            ├─ POST /ai/chat          → 对话式整篇调整（逐条 before/after 建议→应用）
            ├─ GET  /snapshots?id=    → 快照列表
            └─ POST /rollback?id=&ts= → 回滚（先快照当前版再恢复）

launchd: ~/Library/LaunchAgents/com.lhx.resume-server.plist（RunAtLoad + KeepAlive）
```

## 4. 文件布局

```
~/resume/
├── server.mjs          # 唯一服务进程；Node 内置 http/fs/child_process，零 npm 框架
├── render.mjs          # HTML→PDF；playwright-core + 系统缓存 Chromium
├── package.json        # 仅声明 playwright-core 一个依赖
├── config.json         # 大模型配置（本地，不进任何 git）
├── docs/<id>.html      # 每份简历一个文档；标题取文档内 <h1>
├── snapshots/<id>/<ts>.html   # 保存历史，每文档保留最近 50 份
└── pdfs/<id>.pdf       # 每文档最新 PDF
```

## 5. 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 保存机制 | POST /save 直写文件（临时文件 + rename 原子替换） | 根除"存错位置"整类事故 |
| 快照 | 每次保存带时间戳存一份；回滚前先快照当前版 | 回滚也可回滚，无数据损失路径 |
| PDF 导入 | pdftotext 提取 → LLM 结构化（姓名/经历/项目）→ 灌入现有模板 | 用户已确认：不保留原 PDF 排版 |
| 无 API key 时的导入 | 降级为纯文本提取展示，人工整理 | 不阻塞主流程 |
| AI 双模式 | 区块改写与对话整篇**共享同一"预览→应用"通道** | 只写一套应用逻辑 |
| LLM 接入 | OpenAI 兼容格式（baseURL+key+model），火山方舟可直接用 | 一套代码兼容多家 |
| 文档元数据 | 扫 docs/ 目录 + 读 `<h1>` 当标题，不建数据库/索引文件 | 少一层就少一层 |
| 端口 | 7890 优先，EADDRINUSE 顺延 7891/7892，实际端口写 `/tmp/resume-server.log` | 书签稳定 + 冲突自愈 |
| 端口占用 | 启动时检测并顺延，不报错退出 | 避免 KeepAlive 死循环 |

## 6. 编辑器改造点（相对现有可编辑 HTML）

- 保存按钮：`showSaveFilePicker` 逻辑删除 → `fetch POST /save`
- 新增"下载 PDF"按钮 → `GET /pdf?id=`
- 新增"历史版本"入口 → 快照列表 + 回滚
- 新增选中文字浮窗"AI 改写"、侧边栏 AI 对话（Phase 3）
- 保留：contenteditable、分页参考线、localStorage 兜底（服务未响应时提示"服务未运行"）
- 旧 file:// 流程的 IndexedDB 句柄/localStorage 自动失效（域名变更），无需清理

## 7. 错误处理

- 保存：临时文件 + rename（原子）；磁盘错误返回 500 + 页面提示，localStorage 兜底仍在
- 渲染失败：保留旧 PDF、记日志、不阻塞保存
- 上传：非 PDF / 提取为空 → 明确错误页；LLM 结构化失败 → 降级纯文本
- AI 请求：超时 30s、失败只影响当次改写、所有 AI 修改先过预览再应用
- 快照写入失败：不阻塞保存，记日志

## 8. 测试

每期一个冒烟脚本（bash + curl + python3 断言，不引入测试框架）：

- **Phase 1**：启动 → POST 假修改 → 断言 docs 落盘、快照 +1、PDF 更新且含标记 → 回滚断言 → 清理
- **Phase 2**：上传构造 PDF → 断言新文档出现且可编辑可出 PDF
- **Phase 3**：mock key 测降级路径（不烧真实 token）；AI 端点错误路径断言

launchd 验证：bootstrap → curl 通 → unload/load 模拟重启 → curl 再通。

## 9. 迁移与旧系统处置

1. 现有简历 HTML 内容原样迁移为 `docs/linghaoxiang.html`
2. `.zshrc` 移除旧 watcher 启动块；`pkill -f resume-pdf-watch.sh`
3. career-ops 内旧文件保留不动（成为档案），不删除
4. 迁移后验证：编辑→保存→PDF 自动更新→回滚可用

## 10. 分期交付

| 期 | 内容 | 验收 |
|---|---|---|
| Phase 1 | ~/resume 落地 + server.mjs 保存/快照/渲染 + launchd 常驻 + 迁移现有简历 | 浏览器改→保存→8 秒内 PDF 更新；重启模拟后服务自愈 |
| Phase 2 | 文档列表首页 + 多文档 + PDF 上传导入 | 上传 linghaoxiang.pdf 能生成可编辑新文档 |
| Phase 3 | /settings 配置页 + /ai/rewrite + /ai/chat | 配好 Ark key 后两种模式都能出改写预览 |
