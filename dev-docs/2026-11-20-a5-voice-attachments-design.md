# A5 设计：语音输入 + 附件上传（UPCV Agent 二期移植）

> 2026-11-20 产出。用户拍板：A5 做，语音面试（ASR）不做。契约源：efc `docs/upcv-agent-implementation-phase2.md`（§1 附件、§2 语音）；UPCV 证据：`agent/zhipu/files/upload`、输入区附件+麦克风按钮。
> 载体差异声明：efc 用 multipart+SQLite+pdf-parse/mammoth（新依赖）；本仓走 raw body+文件系统+零新依赖。用户可感知行为一比一。

## 0. 范围裁决（对 efc 二期逐项）

| efc 项 | 本仓裁决 | 依据 |
|---|---|---|
| 附件上传（pdf/docx/图/txt/md） | **做**，契约形状照搬 | A5 拍板范围 |
| 语音输入 | **做，但只走浏览器 Web Speech 主路径** | 见 §2 裁决：本仓无可用转写上游 |
| 会话重命名 | 不做（本仓已有：侧栏「改名」prompt + PATCH） | 已在产 |
| Token 用量显示 | 不做 | A5 范围外小增量，不捎带 |
| welcome 文案对齐 | 不做 | 本仓 welcome 是自有设计，非 UPCV 逐字 |

## 1. 附件上传

### 1.1 端点

`POST /agent/files?sid=<sessionId>&name=<文件名>`（**raw body，非 multipart**——照 /upload 既有惯例：body=文件字节、name 走 query）。

- 体积 ≤10MB（readBody buffer）。
- 类型白名单（**魔数/扩展名校验，不信声明 mime**）：pdf（%PDF 魔数，同 /upload 口径）/ docx（PK zip 魔数）/ png / jpg / webp（各魔数）/ txt / md（扩展名 + UTF-8 可解码）。
- sid 必传且命中既有会话 → 404 会话不存在；id 闸门 `ID_RE` 同口径。

返回 `{ok:true, fileId, name, mime, size, textChars, warning?}`。

### 1.2 存储（零新账本）

```
agent-files/<sessionId>__<fileId>.bin      二进制原文件（统一 .bin：txt 原档会与提取 .txt 撞名）
agent-files/<sessionId>__<fileId>.json     元数据 sidecar（name/mime/size/createdAt）
agent-files/<sessionId>__<fileId>.txt      提取文本 sidecar（提取成功才有）
```

- **所有权编码进文件名前缀**：归属校验 = 前缀匹配，不建索引表。
- fileId = `af-<rand>`（newId 同款）；ext 按魔数定，不信 name。
- 会话删除（agentDeleteSession 内）→ 扫 `agent-files/<sid>__*` 全删。
- 目录懒建（首个上传时 mkdir -p）。

### 1.3 文本提取（零新依赖）

| 类型 | 提取 |
|---|---|
| txt/md | UTF-8 直读，截 50,000 字 |
| pdf | `pdftotext -layout <file> -`（importer.mjs:67 同口径，execFileSync 30s 超时） |
| docx | 零依赖迷你 unzip：EOCD→中央目录→`word/document.xml`→zlib inflate→去 XML 标签/实体解码。提取失败 → warning 降级（下） |
| 图（png/jpg/webp） | 不提取（走多模态，§1.5） |

提取失败或不适用 → `.txt` sidecar 不写，返回带 `warning:"文本提取失败，将按文件名引用"`（efc 契约文案照搬）。

### 1.4 chat 扩展

`POST /agent/chat` body 追加可选 `fileIds: string[]`：

1. 逐 id 校验 `agent-files/<sid>__<fileId>.*` 存在；不属于该会话/不存在 → 400 带明细。
2. 用户消息 parts：每个附件追加 `{type:"file", filename, url:fileId, mediaType}`（**UPCV 逐字形状**）。
3. **模型可见文本** = `[context:file:<filename>]\n<extracted_text>`（每文件截 8,000 字 + `(截断)`）拼在用户文本之前；**持久化 text part 只存用户原文**——展示与模型输入分离（同「回灌与交付分离」纪律，气泡里不糊 8k 附件文）。
4. 提取为空的文本类附件 → 只注 `[context:file:<filename>]\n(无可提取文本)`。

### 1.5 图片多模态 + 降级

- 有图附件时，最后一轮 user content 变数组 `[{type:"text",...},{type:"image_url",image_url:{url:"data:<mime>;base64,<...>"}}]`（图片读盘编码在发送时，≤10MB→~13MB base64）。
- 模型不支持 vision（调用抛错）→ **本轮零 delta 产出才允许降级重试一次**：content 改回字符串，注入 `[context:file:<name>] (图片内容未能读取，请用户描述)`。已流出 delta 后报错不重试（防文本重影）。

### 1.6 前端（agent-panel.js 接缝）

```
回形针按钮（textarea 左侧，内联 SVG）→ <input type=file accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,.txt,.md" multiple>
选中 → ensureSession() → 逐文件 POST /agent/files?sid&name（raw body）
成功 → 输入框上方 chip：📄 name + ✕；失败 → chip 红字原因，不阻塞纯文本
发送 → body 带 fileIds；成功才清 chips；气泡 file part → 📄 name 徽章（用户气泡与历史渲染都补）
```

## 2. 语音输入（裁决：仅浏览器路径）

**不建 `POST /agent/voice`**：efc 主路径转发 `{baseURL}/audio/transcriptions`，但本仓 active profile（MiniMax-M3.1-Flash）无该端点保证——建一个注定 404 的端点违反 YAGNI 与诚实原则。Web Speech API 是同源降级链的自然终点，可感知行为一比一（语音→文本进输入框）。用户日后配置 OpenAI 兼容 whisper 时再补服务端端点（登记：等需求出现）。

前端状态机（agent-panel.js，~60 行）：

```
麦克风按钮（发送键左侧，内联 SVG）：
  SpeechRecognition 不存在 → 按钮隐藏（efc「两者都不可用→隐藏」同口径）
  idle --点--> recording（按钮实心红+呼吸；placeholder「正在聆听…」；interimResults 实时写 textarea）
  recording --点/结束--> idle（final 文本定稿追加）
  发送时录音中 → 先 stop 再发送
  lang=zh-CN；denied → 状态条如实提示
```

## 3. 登记清单（账本四连变体：目录非 JSON 账本）

1. `agent-files/` → `.gitignore`
2. backup tar 清单 + `RESTORE_MANAGED_DIRS` + 恢复 `ALLOWED` 正则（三处同表扩 `agent-files`）
3. test.sh 隔离根 seed：无需（目录懒建）
4. 新外部字段 `fileIds`/`filename`/`mediaType` → XSS-4 启发式名单核对（file part 只走 textContent/DOM，不进 innerHTML——落实为准）
5. test-structure.sh：ROUTES_FROZEN 登记 `POST /agent/files`；断言同提交

## 4. 边界

- 附件上限 10MB/文件，单消息 fileIds ≤ 8 个（防一刷几十个注入）。
- 不做：服务端转写端点、会话内文件列表 UI、附件下载/预览、录音文件落盘。
- 真实数据禁写：验收全走隔离根。

## 5. 验收（同 A 路线流程）

夹具 `test-fixtures/reliability/test-agent-files.mjs`（隔离根+stub LLM）：上传三类（txt/docx 自建 zip/pdf 夹具）→ textChars/sidecar/跨会话 400/chat fileIds 进 parts 与模型文本/坏类型 400/会话删除清目录。`bash test-structure.sh` → kickstart → 浏览器实点 /agent（上传+语音按钮）。真模型抽验：带附件问一句（可复用本流程授权）。
