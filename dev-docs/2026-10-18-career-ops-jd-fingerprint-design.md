# career-ops 集成 · JD 指纹去重 + 岗位快速评估 · 设计文档

> 日期：2026-10-18（同日增补评估批次） · 状态：**已与用户对齐，待评审后出 plan** · 前置：S4b①② 完成后实施
> 上游溯源：career-ops-hq/career-ops @ `090f787e2499f4fd29b615272946c99dfcab1c28`（2026-10-17，MIT 许可）
> 本设计含两个批次：**批次 1 = JD 指纹去重**（确定性，零模型依赖）；**批次 2 = 岗位快速评估**（AI，依赖可用模型）

---

## 1. 背景与决策

### 1.1 career-ops 是什么

开源 AI 求职 agent（github.com/career-ops-hq/career-ops）：扫职位板、评估打分、定制简历、追踪申请。纯 Node 脚本 + Markdown 提示词，为 AI 编码 CLI 设计。MIT 许可。

### 1.2 集成评估结论（2026-10-18 brainstorming）

用户求职市场**基本只投国内**（Boss直聘等）。career-ops 的 124 个职位扫描适配器全部是欧美公开 ATS 板（Greenhouse/Ashby/Lever/Workday…），对国内平台不可用且不可行（登录制、反爬、ToS 风险）。

| career-ops 能力 | 对国内市场 | 本设计取用 |
|---|---|---|
| 职位扫描（providers/） | ❌ 无公开数据源 | 不取 |
| liveness 存活检查 | ❌ 登录墙后 | 不取 |
| **JD 文本指纹（fingerprint-core）** | ✅ 平台无关 | **批次 1（本设计核心）** |
| **岗位评估打分（A–H 报告 + 1–5 分）** | ✅ 平台无关（AI 层） | **批次 2：精简为前置快速筛** |
| 求职信/面试准备 prompt | 面试已有 S4b③；求职信弱需求 | 不取 |
| ATS 三元组身份（listing-fingerprint） | ❌ 国内平台无此模型 | 不取 |

**与路线图 v4「非单一匹配分」的关系**：不冲突。对应表管「怎么改简历」（S4a 既有），分数管「要不要投入」（本批次 2 新增）。对应表仍是适配流程的唯一驱动；分数只出现在评估报告中，作为先筛后投的决策辅助，可覆盖、可忽略。

**路线图决策 4（不做职位发现）维持原判**，新增理由：目标市场无公开数据源。本设计不引入职位流、不翻案。

### 1.3 核心价值

国内求职的真实痛点：同一职位由 HR 反复刷新、多个人事代理重复发同一岗位、用户在不同时间遇到同一职位不记得。JD 内容指纹在**创建岗位草稿时**自动比对历史，提醒重复。

### 1.4 远期约束

简历工作台后续将并入个人工作台 Mac 桌面版。故集成走「能力吸收」路线：代码进本仓库 `vendors/` 目录，零外部进程依赖，将来纯目录搬运。

---

## 2. 关键发现：SimHash 对纯中文静默失效（必须改造）

上游 `fingerprint-core.mjs` 的 `normalizeJdText` 按空格切 token。中文无空格 → 整段中文归一化为一个巨大 token → `tokens.length < 3` → 返回空指纹 → **永不匹配且无提示**。上游源码注释自认此点（"an unspaced CJK body normalizes to one giant token … treat it as unfingerprintable"）。

直接复制不改的真实后果（2026-10-18 实测修正，早期描述「完全不生效」过重）：

| 中文 JD 形态 | 上游原版 | bigram 改造的价值 |
|---|---|---|
| **无标点**（标点被平台吞、或纯段落） | 归一化成单一巨 token → `tokens<3` → **空指纹，永不匹配且无提示** | **防静默失效**——不可替代的价值 |
| **带标点**（几乎所有真实 JD） | 标点被 `[^\p{L}\p{N}]+→空格` 折成空格，已切出多 token → 照常出指纹 | 提升粒度（词级 bigram vs 句子片段） |

即：改造在真实带标点 JD 上是**优化**，在无标点 JD 上是**必需**。测试哨兵必须用无标点 fixture 才能测到后者（用带标点 fixture 测是假绿——上游本来就能过那条路径）。

**改造：CJK bigram 切分。** 归一化后对连续汉字段做两字滑窗：

```
"负责后端服务的开发与维护" → 负责 责后 后端 端服 服务 务的 的开 开发 发与 与维 维护
拉丁段保持整词；中英混合 JD 天然混合 token 流
```

改动约 15 行（一个正则 + 切分循环）。

---

## 3. 移植包

```
vendors/jd-fingerprint/
├── fingerprint-core.mjs   移植自上游同名文件（~262 行），改：normalizeJdText 加 CJK bigram
├── normalize-text-key.mjs 提取自上游 tracker-parse.mjs 的 normalizeTextKey（~30 行，公司名归一化：NFKC+小写+保留字母数字）
└── repost-check.mjs       自写薄壳（~80 行）：同公司 + 90 天窗口 + 相似度 → 重发提醒
```

- 零 npm 依赖（仅 `node:crypto`）。
- **不移植**：`listing-fingerprint.mjs`（ATS 三元组强身份，国内无源）、`detect-reposts.mjs`（800 行，耦合上游 scan-history 文件格式）、`findCrossListings` 的跨公司逻辑（国内场景改为「同公司重发 + 跨记录重复」两路，见 §4）。
- 文件头标注来源 repo + commit hash + 本地改动说明（CJK bigram）。

---

## 4. 数据流与存储

### 4.1 挂靠点（已核实真实结构）

| 实体 | 位置 | 用的字段 |
|---|---|---|
| 岗位草稿 | `docs-meta.json`，`kind:'job'` 文档 | `jd`（≤4000 字）、`company`、`role`、`createdAt`、`job.todos` |
| 投递记录 | `applications.json`（list） | `jd`、`link`、`company`、`role`、`appliedAt`、`status` |

**不新建数据文件，不动 `applications.json` 结构。**

### 4.2 流程（挂在现有 `POST /job/create`）

```
1. 现有精确去重：同 parent+company+role → 409（语义不变，模糊匹配不接管阻断）
2. 指纹护栏（新增）：
   jdFp = fingerprintText(jd)
     空指纹（<200 归一化字符 / <3 token）→ 静默跳过
     模块抛错 → try/catch 降级跳过 + 日志，绝不挡创建
   比对四路（窗口 90 天，阈值默认 0.95，校准后固化）：
     a. 历史岗位草稿（读 meta.job.jdFp，缺则对该条现算、不回写）
     b. 投递记录 link 精确相等（不受窗口限制）
     c. 投递记录指纹相似（jd 现算；窗口按 appliedAt，缺省 fallback createdAt）
     d. 评估库指纹相似（批次 2，见 §5：命中 →「评估过，X 分，结论：放弃」）
     同公司 + 窗口内 + 相似 → 追加「疑似重发」标记
3. 结果落地（零新 UI）：
   · job.todos 加一条「疑似重复」待办（复用 S4a 待办机制；同 jdLink 失败记 todo 的既有模式）
   · JSON 响应加 dupHints 数组（可选消费）
4. meta.job 子树新增字段 jdFp（16 hex，经 updateMeta 写入，遵守 meta 唯一写入者纪律）
```

### 4.3 三个原则

1. **存自己的，现算别人的**：创建时写自己的 `jdFp`；比对读历史 `jdFp`，老记录无则现算不回写。零迁移、零批量任务。
2. **模糊不阻断**：指纹是提醒护栏不是门禁（模板化 JD 会误伤）。落地形态 = 待办，用户自决。
3. **失败降级**：护栏任何异常不影响 `/job/create` 主流程。

### 4.4 改动面（批次 1；批次 2 见 §5.3）

| 文件 | 改动 |
|---|---|
| `vendors/jd-fingerprint/`（新增） | 3 文件 ~370 行 |
| `server.mjs` `/job/create` | +~30 行 |
| 生成页表单（可选） | +5 行显示 dupHints |
| UI 新页面/新路由 | 0 |

---

## 5. 批次 2：岗位快速评估（前置快速筛）

### 5.1 定位与流程

career-ops 的「先筛后投」落在工作台 =「先评估后适配」。评估只读 JD + 简历母版，产出建议；适配才建草稿改简历（S4a 语义不变）。

```
粘贴 JD 文本（Boss直聘复制）+ 公司/职位名（可由评估顺手提取候选）
  → POST /eval/create（AI 一次调用，复用 llm.mjs 通道）
  → 评估报告：精简 A–E 块 + 1–5 总分 + 结论（建议投/不建议/存疑）
  → 高分/用户认可 → 一键转 S4a 完整适配（复用 /job/create，字段预填）
  → 低分 → 不建草稿；评估记录 + jdFp 存档
  → 指纹闭环：日后 /job/create 碰到相似 JD → 比对路 d 提醒历史分数与结论
```

### 5.2 报告块（career-ops A–H 的国内精简）

| career-ops 块 | 取舍 | 理由 |
|---|---|---|
| A 角色摘要 | ✅ 取 | |
| B CV 匹配（逐条要求 + 权重与来源标注） | ✅ 取（核心） | |
| C 级别策略（够格/恰好/超配） | ✅ 取 | |
| D 薪资研究 | ⚠️ 降级为「薪资范围提取」 | 国内 JD 自带范围；无外部研究数据源，模型只引用 JD 内数字并标注「无外部数据」 |
| E 个性化角度 | ✅ 取 | |
| F 面试准备 | ❌ 砍 | S4b③ 已有更严谨的面试追问（建草稿后的深环节） |
| G 职位合法性（liveness/重发） | ❌ 砍 | liveness 国内不可用；重发检测已由批次 1 指纹承担 |
| H 工作授权 | ❌ 砍 | 国内场景默认不适用 |
| 1–5 总分 + 结论 | ✅ 取 | 可覆盖（学 career-ops：建议 ≠ 强制） |

### 5.3 组件与存储

| 件 | 内容 |
|---|---|
| `eval.mjs`（新文件 ~150 行） | `buildEvalPrompt`（输入 = JD + 简历母版文本，同 buildJobPrompt 数据源）、`parseEvalReport`（块标记解析，学 parseJobOps 风格） |
| 解析护栏 | ① score 必须是 1–5 数字（允许 .5），越界/非数字**整份作废**（score 是本功能全部结论，错分代价远大于白评估一次）；② verdict/level 枚举外则**由 score 无损推导回落**（apply/caution/skip、'right'），不丢弃；③ matches 逐条丢弃计数；④ **evidence 子串验证**：status='covered' 声称「简历原文里有」，若 evidence 不是母版逐字子串 → 清空 evidence + 降级为 partial。sourced/partial/missing 不参与（它们不声称原文命中）。**不跑 factGuard**——报告不改正文 |
| `evaluations.json`（新轻量库） | 每条：`id, jd, jdFp, company, role, score, verdict, blocks, model, createdAt, promotedTo(转草稿后 docId，可 null)`。与 applications.json 同风格，独立读写 |
| `server.mjs` 路由 | `POST /eval/create`（评估）、`POST /eval/promote`（转适配 = 复用 /job/create 逻辑，字段预填）；报告卡片展示 |
| UI | 生成页表单旁加「先评估」入口 + 报告卡片（分数、结论、A–E 块、[转入适配] 按钮）。不新建独立页 |

### 5.4 模型依赖与验证边界（知情决策）

评估是 **AI 功能**。当前工作台无可用模型（config 仅剩未启动的本地 minicpm）。因此：

1. 批次 2 完成标准 = **stub 验证通过**（纪律 §4：AI 测试一律本地 stub + 标注「模拟验证」）。
2. 真实 LLM 链路（模型是否遵守输出格式、分数是否合理）**未验证**，登记为遗留——与 S4b③ 同款困境，同款登记。
3. 批次 2 的实施时点可排在指纹之后任意时间；结构就绪后模型到位即插即用（llm.mjs 通道不变）。

---

### 设计实现偏差（2026-10-19 实施期发现并修正）

**原设计写「不跑 factGuard——报告不改正文，无事实污染面」。前半句成立，后半句对 `evidence` 不成立。**

`evidence` 是要**贴进 UI 给用户看的简历原文片段**。模型编一段像简历的话，用户在界面上无从分辨——而这份报告的全部意义就是帮他判断「我到底有没有这段经历」。编造的 evidence 会让用户误以为自己拥有它，与本项目事实护栏的核心承诺**直接相反**。

修正：`parseEvalReport(raw, { docText })` 增第二道护栏（只验证 `status==='covered'` 的条目，sourced 声称来自素材、partial/missing 本就不声称原文命中）。与 S4a 的「before 必须逐字出现在文档中，找不到就不要输出」同口径。测试见 EV-4。

**另一个偏差**：原设计说「公司/职位名可由评估顺手提取候选」，实现**未做**（YAGNI）——表单让用户填，`/eval/promote` 才能干净复用 `/job/create` 的字段。若日后发现手填太烦再加提取。

**`gaps` 元素丢弃不计入 `dropped`**：`dropped` 的语义是「匹配条目被丢弃」，把 gaps 混进去会让这个数字在两个任务间含义漂移。

---

## 6. 测试策略（FP 组 + EV 组，进 test-structure.sh）

### 6.1 FP 组（批次 1：指纹，纯函数）

| 组 | 断言 | 防什么 |
|---|---|---|
| FP-1 | 真实中文 JD → bigram 切分 → token 数 > 3 | 切分失效 |
| FP-2 | 同文本两次计算 → 指纹相同 | 非确定性 |
| FP-3 | 真实 JD 改 <5% 字 → 相似度 ≥ 阈值 | 漏报 |
| FP-4 | 两个真实不同职位 JD → 相似度 < 阈值 | 误报（核心） |
| FP-5 | <200 字短文本 → 空指纹不抛错 | 崩溃/误报 |
| FP-6 | 带 emoji/链接/HTML 残渣 → 清洗后指纹稳定 | 复制噪声 |
| FP-7 | **纯中文 JD 指纹非空** | CJK 缺口回归（上游同步覆盖 bigram 时立即红） |

- **夹具来自真实产出**：docs-meta 已有岗位草稿 JD + 一条真实 Boss直聘 JD（硬规矩，handoff §3.2）。
- 纯函数、无 AI 依赖：不需要 stub，全链路可真实验证，不受当前无可用模型影响。
- 端到端验收：同一真实 JD 粘两次 → 第二次创建 → `job.todos` 出现「疑似重复」。

### 6.2 EV 组（批次 2：评估，stub 模拟验证）

| 组 | 断言 | 防什么 | 状态 |
|---|---|---|---|
| EV-1 | buildEvalPrompt：母版原文 + JD 原文 + 枚举契约 + 反编造约束进 prompt | prompt 拼装错误 | ✅ |
| EV-2 | 合规保真 + score 越界（6/0/-1/"4.0"）整份作废 + verdict/level 非法回落 | **错分比不给更危险** | ✅ |
| EV-3 | matches 丢弃计数 + 围栏剥离 + 7 种坏输入不抛 + salary/gaps 归一 | 崩溃/脏数据 | ✅ |
| EV-4 | **evidence 子串验证**：编造的 evidence 清空并把 covered 降级为 partial；真实逐字子串保留；sourced/partial/missing 不参与 | **模型编造简历片段**（见下） | ✅ |
| EV-5 | 路由集成：stub LLM 返回固定报告 → evaluations.json 落盘字段完整 | 存储缺陷 | ⏳ 待做 |
| EV-6 | promote：评估 → 转适配 → 岗位草稿建立且 jd 预填、promotedTo 回写 | 链路断裂 | ⏳ 待做 |
| EV-7 | 指纹五路：评估库命中 → 创建草稿时提醒历史分数与结论 | 闭环断裂 | ⏳ 待做 |

> 编号修正（2026-10-19）：原表把 EV-1 定为「解析」、EV-3 定为「prompt 构建」，与实现顺序错位一格。实现按「先 prompt 后解析」组织，**以实现为准，本表已对齐**。

- 真实 LLM 链路 **未验证**，登记遗留（同 S4b③ 模式，见 §5.4）。
- 四件套全绿，基线 338+83 只增不减；冻结件不动。

---

## 7. 阈值校准（实施期一次性）

真实历史 JD 全对比对矩阵（一次性脚本，分布进本文档附录）：同公司同岗位对（分布 A）vs 不同岗位对（分布 B），阈值取分离点。分不开时降级：0.85–0.95 灰区仅当公司相同才提醒。阈值固化为一处常量。

---

## 8. 实施顺序与同步纪律

```
批次 1（指纹，~450–550 行，确定性）：
  0. 前置：574 行提交、S4b①②（主线优先）
  1. FP-1/2/5 断言先行（红）→ 移植 + CJK bigram（绿）
  2. repost-check 薄壳 + /job/create 集成 + FP-3/4/6/7
  3. 校准脚本 → 定阈值 → 附录归档
  4. 上游登记：本文档 §头部 commit hash

批次 2（评估，~450–500 行，AI/stub）：
  5. eval.mjs + EV-1/2/3（纯函数先行）
  6. /eval/create + /eval/promote 路由 + evaluations.json + EV-4/5
  7. 生成页评估入口 + 报告卡片
  8. 指纹比对路 d 接通评估库 + EV-6
  ※ 可整体排在批次 1 后任意时点；模型就绪即插即用
```

- 上游同步：只 diff `fingerprint-core.mjs`（每季度或遇 bug），diff 后必跑 FP-7。评估 prompt 为本地自研（借鉴 oferta.md 结构），无同步负担。
- 后续候选（另立设计，不属本文档）：面试增强、求职信——等模型与需求确认。

---

## 9. 开放项（实施前需确认）

| 项 | 状态 |
|---|---|
| 校准用真实 JD 样本 | 实施时从本机 docs-meta/applications 取 |
| dupHints 是否进生成页 UI | 实施时 5 行可选项，默认只进 todos |
| 阈值初值 0.95 | 待校准数据确认 |
| 评估报告块的最终标记语法 | 出 plan 时定（对齐 parseJobOps 既有风格） |
| 公司/职位名：手填 vs JD 提取候选 | 出 plan 时定（倾向：评估顺带提取候选，用户可改） |
