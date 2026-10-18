# 护栏补漏 + 面试指南 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上 `factGuard` 的「原文丢数字」漏洞、修 WCAG 2.4.11 焦点遮挡、并交付 S4b③ 面试追问（挂在证据表底部的折叠区）。

**Architecture:** 三处改动，全部在注入层或服务端纯函数，**不动冻结件**。护栏补漏改 `job.mjs` 的纯函数 `factGuard`（2 处调用点自动生效）；面试追问复用 S4a 已有的生成任务通道——`/job/gen-start?kind=interview` 不需要新路由，只需把 `'interview'` 加进 `GEN_KINDS`。

**Tech Stack:** Node ESM（`.mjs`）、原生 `fetch`、bash 测试（heredoc + `node --input-type=module`）、零新依赖。

**设计依据：** `dev-docs/2026-10-14-guard-interview-design.md`

---

## 执行前必读

### 跑测试的纪律（踩过事故，务必遵守）

```bash
bash test-structure.sh > /tmp/s4b-structure.log 2>&1   # 重定向到文件
tail -30 /tmp/s4b-structure.log                        # 跑完再 tail
```

**绝不管道接 grep。绝不并发跑。绝不让执行器超时强杀**——给足 timeout。

原因见记忆 `test-sh-execution-discipline`：2026-09-10 管道模式两次假性挂起被 SIGTERM 强杀，打断了 `test.sh` 的 trap stash/restore 中段，是 `config.json` 永久丢失的直接诱因。

### 断言的写法（照抄现有格式）

`test-structure.sh` 里的断言长这样：

```bash
node --input-type=module << 'EOF'
import { parseZoneRewrites } from './zone.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S3-B2 ' + m); process.exit(1); } };
assert(rwBad[0].level === 'conflict', '改写引入新数字 → factGuard conflict（复用 job.mjs）');
console.log('✅ S3-B 区域纯函数（含 S3-B2 区域级 AI 解析）');
EOF
```

### 当前可复用的既有设施（不要重造）

| 设施 | 位置 | 用途 |
|---|---|---|
| `locateZid(zid)` | `job-panel.js:707` | 滚动 + `CSS.highlights` 闪烁，面试追问的「回跳」直接调它 |
| `api(url, body)` | `job-panel.js:89` | 前端请求封装 |
| `schedulePoll()` | `job-panel.js:668` | 2.5s 轮询 |
| `mkGenTask()` | `server.mjs:128` | `{taskId, status, startedAt, baseHash, error, scope}` |
| `finishGenTask(id, kind, taskId, apply, errMsg)` | `server.mjs:155` | 事务式落账 + taskId 校验 + 超时拒绝 |
| `stripFence(raw)` | `evidence.mjs` 内 | 清洗 ```json 围栏 |
| `parasOf(html)` / `contentHash(html)` | `server.mjs` | 段落快照 / 正文哈希 |

---

## 文件改动清单

```
新增  （无）

修改  job.mjs          +12 行    normNum 导出 + factGuard 内 lostNums
修改  server.mjs       +4 行     html{scroll-padding-top}
修改  server.mjs       +6 行     GEN_KINDS 加 'interview' + 两处错误文案改动态
修改  server.mjs       +22 行    runGenTask 加 interview 分支
修改  server.mjs       +4 行     jobView 加 interview/interviewGen/interviewStale/genTasks.interview（签名加 id 参数）
修改  evidence.mjs     +1 行     import 补 factGuard（`job.mjs` 是零 import 叶子，无循环风险）
修改  evidence.mjs     +70 行    buildInterviewPrompt + parseInterview（双护栏）
修改  job-panel.js     +95 行    renderInterview 折叠区（复用 DOC_ID / locateZid / jp-item / jp-refbtn）
修改  test-structure.sh +20 行   三个新断言块
```

**冻结基线验收**：`git diff bbbad60 -- template.html themes/ render.mjs` 必须为空。

---

## Task 1 · lostNums 事实护栏

**Files:**
- Modify: `job.mjs:66-87`（`NUM_RE` 之后加 `normNum`，`factGuard` 内加 `lostNums`）
- Modify: `test-structure.sh`（S3-B2 段之后新增 S4B-1 断言块）

- [ ] **Step 1: 写失败断言**

在 `test-structure.sh` 末尾追加独立 heredoc。**不要内嵌进 S3-B2 段**——那一段的 `import`（`test-structure.sh:2155`）来自 `./zone.mjs`，拿不到 `job.mjs` 的 `factGuard`。

```bash
# —— S4B-1：lostNums 事实护栏（原文丢数字 → conflict）——
node --input-type=module << 'EOF'
import { factGuard, normNum } from './job.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-1 ' + m); process.exit(1); } };
const t1 = factGuard({ kind: 'replace', before: '将 QPS 从 300 提升到 5000，延迟从 80ms 降到 15ms，覆盖 3 个业务线', after: '负责后端优化' });
assert(t1.level === 'conflict', '删光数字 → conflict');
assert(/300/.test(t1.reason) && /5000/.test(t1.reason), 'reason 点名丢失的数字');
const t2 = factGuard({ kind: 'replace', before: '服务 12 万日活用户', after: '服务 120000 日活用户' });
assert(t2.level !== 'conflict', '12万 → 120000 不算丢数字');
const t3 = factGuard({ kind: 'replace', before: 'QPS 从 300 提升到 5000', after: '把 QPS 从 300 提升到 5000' });
assert(t3.level !== 'conflict', '数字原样保留不拦');
const t4 = factGuard({ kind: 'replace', before: '效率提升 30%', after: '效率提升 45%' });
assert(t4.level === 'conflict', '百分比丢失也算丢数字');
assert(normNum('12') === '12', 'normNum 无单位原样');
assert(normNum('12万') === '120000', 'normNum 12万 → 120000');
assert(normNum('30%') === '30%', 'normNum 百分比保留');
assert(normNum('1.5亿') === '150000000', 'normNum 1.5亿 → 150000000');
console.log('✅ S4B-1 lostNums 事实护栏');
EOF
```

- [ ] **Step 2: 跑测试确认失败**

```bash
bash test-structure.sh > /tmp/s4b-t1-fail.log 2>&1; tail -12 /tmp/s4b-t1-fail.log
```

Expected: FAIL。因为 `normNum` 还没导出（`SyntaxError: The requested module does not provide an export named 'normNum'`）。

- [ ] **Step 3: 实现 normNum**

`job.mjs` 中 `export const DATE_TOKEN_RE = ...` 这一行**之后**插入：

```javascript
// 数字归一化：展开中文数量单位，使 12万 与 120000 判为同一个数字（S4B-1，2026-10-14）
export function normNum(n) {
  const m = /^(\d+(?:\.\d+)?)(千|万|亿)?(%)?$/.exec(String(n));
  if (!m) return String(n);
  const scale = { 千: 1e3, 万: 1e4, 亿: 1e8 }[m[2]] || 1;
  return String(Math.round(parseFloat(m[1]) * scale)) + (m[3] || '');
}
```

- [ ] **Step 4: 在 factGuard 里加 lostNums**

把 `factGuard` 的 `replace` 分支改成：

```javascript
  if (c.kind === 'replace') {
    const beforeNums = new Set((c.before.match(NUM_RE) || []).map(normNum));
    const added = [...new Set((c.after.match(NUM_RE) || []).map(normNum))].filter((n) => !beforeNums.has(n));
    if (added.length) notes.push('改写引入原文没有的数字：' + added.join('、') + '（请核对来源）');
    const norm = (s) => String(s).replace(/\s+/g, '');
    const lostDates = [...new Set(c.before.match(DATE_TOKEN_RE) || [])].filter((d) => !norm(c.after).includes(norm(d)));
    if (lostDates.length) notes.push('原文日期未原值保留：' + lostDates.join('、'));
    // S4B-1：原文数字未在改写后原值保留（含中文数量单位归一化，避免 12万/120000 误报）
    const afterSet = new Set((c.after.match(NUM_RE) || []).map(normNum));
    const lostNums = [...new Set((c.before.match(NUM_RE) || []).map(normNum))].filter((n) => !afterSet.has(n));
    if (lostNums.length) notes.push('原文数字未原值保留：' + lostNums.join('、'));
  }
```

**注意**：`added` 现在也走 `normNum`，这是**收紧**（`12万 → 120000` 不再被误报为「引入新数字」）。Step 5 的全量回归必须覆盖这一点。

- [ ] **Step 5: 跑测试确认通过**

```bash
bash test-structure.sh > /tmp/s4b-t1.log 2>&1; tail -20 /tmp/s4b-t1.log
```

Expected: PASS。输出含 `✅ S4B-1 lostNums 事实护栏`，且**全部既有断言段仍是 ✅**（尤其 `✅ S3-B 区域纯函数`，它经 `parseZoneRewrites` 间接覆盖 `added` 行为）。

- [ ] **Step 6: 提交**

```bash
git add job.mjs test-structure.sh
git commit -m "fix(job): lostNums 事实护栏——原文丢数字不再静默通过；normNum 归一化中文数量单位"
```

---

## Task 2 · scroll-padding-top（WCAG 2.4.11）

**Files:**
- Modify: `server.mjs`（`.topnav` 定义之后的样式块）
- Modify: `test-structure.sh`（新增 S4B-2 断言块）

- [ ] **Step 1: 写失败断言**

在 `test-structure.sh` 末尾（最后一个 heredoc 之后）追加：

```bash
# —— S4B-2：键盘焦点不被 sticky 头遮挡（WCAG 2.4.11）——
node --input-type=module << 'EOF'
import fs from 'fs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-2 ' + m); process.exit(1); } };
const src = fs.readFileSync('./server.mjs', 'utf8');
assert(/html\s*\{[^}]*scroll-padding-top\s*:/.test(src), 'html 设了 scroll-padding-top');
assert(!/line-height\s*:\s*[\d.]+(px|em)/.test(src.match(/body\s*\{[^}]*\}/)?.[0] || ''), 'body 行高不用 px/em 写死（WCAG 1.4.12）');
console.log('✅ S4B-2 焦点不被 sticky 头遮挡');
EOF
```

- [ ] **Step 2: 跑测试确认失败**

```bash
bash test-structure.sh > /tmp/s4b-t2-fail.log 2>&1; tail -8 /tmp/s4b-t2-fail.log
```

Expected: FAIL with `❌ S4B-2 html 设了 scroll-padding-top`。

- [ ] **Step 3: 加 CSS**

在 `server.mjs` 中 `.topnav{...}` 那一行**之前**插入：

```javascript
// S4B-2：键盘 Tab 焦点不被 sticky 顶栏遮挡（WCAG 2.4.11 Focus Not Obscured, AA 级）
// 64 = topnav 的 top:12px + 单行实测高约 40px + 12px 余量；窄屏两行与快照横幅叠加场景另行用媒体查询/:has() 加档，不改此默认值
```

紧接其后（同一行内或下一行）：

```css
html{scroll-padding-top:64px}
```

> 若 `server.mjs` 的样式块不是纯 CSS 字符串而是模板拼接，把上述规则放进该块内同一位置即可，**不要新建 `<style>` 标签**（服务端的 `/save` 剥离清单对注入层有标记约定）。

- [ ] **Step 4: 跑测试确认通过**

```bash
bash test-structure.sh > /tmp/s4b-t2.log 2>&1; tail -10 /tmp/s4b-t2.log
```

Expected: PASS，含 `✅ S4B-2 焦点不被 sticky 头遮挡`。

- [ ] **Step 5: 浏览器实测（不是可选项）**

```bash
launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server"
```

然后浏览器打开首页，**连按 Tab 20 次**，逐个确认焦点元素完整可见、不被顶栏或快照横幅遮住。

Expected: 无任何一次焦点被遮住。若横幅场景遮挡，加一档 `:has()` 规则，**不要改 64px 默认值**。

- [ ] **Step 6: 提交**

```bash
git add server.mjs test-structure.sh
git commit -m "fix(server): html scroll-padding-top 修 WCAG 2.4.11 焦点被 sticky 头遮挡"
```

---

## Task 3 · parseInterview 纯函数

**Files:**
- Modify: `evidence.mjs`（文件末尾追加）
- Modify: `test-structure.sh`（新增 S4B-3 断言块）

- [ ] **Step 1: 写失败断言**

在 `test-structure.sh` 末尾追加：

```bash
# —— S4B-3：面试追问解析 + 双护栏（子串验证 + factGuard）——
node --input-type=module << 'EOF'
import { parseInterview } from './evidence.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ S4B-3 ' + m); process.exit(1); } };
const paras = [{ zid: 'za1111111', text: '负责存储层改造，QPS 从 300 提升到 5000' }];

const ok = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: '你负责哪一块？', followUp: 'QPS 再翻十倍瓶颈在哪？',
             answerPoints: [{ text: '我负责存储层', quote: '负责存储层改造' }] }],
  generic: [{ question: '自我介绍', answerPoints: [{ text: '三段经历', quote: '' }] }]
}), { paras });
assert(ok && ok.chains.length === 1, '正常链路解析');
assert(ok.chains[0].zid === 'za1111111', 'evIndex → zid 回填');
assert(ok.chains[0].answerPoints.length === 1 && ok.chains[0].answerPoints[0].anchored === true, '锚定要点保留');
assert(ok.generic.length === 1 && ok.generic[0].answerPoints[0].anchored === false, '通用问题允许无锚定');
assert(ok.dropped === 0, '无丢弃');

const bad = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f',
             answerPoints: [{ text: '编的', quote: '这段原文里根本没有的话' }] }]
}), { paras });
assert(bad.chains[0].answerPoints.length === 0, 'quote 编造 → 要点被丢弃');
assert(bad.chains[0].empty === true, '要点全空 → 标 empty');
assert(bad.dropped === 1, '丢弃计数');

const gone = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f', answerPoints: [{ text: 'x', quote: 'y' }] }]
}), { paras: [] });
assert(gone.chains[0].empty === true, '锚定段落已删 → 整链 empty');

// ② 第二道护栏：要点对锚定段落跑 factGuard（丢掉原句里的数字 → 标 guard=conflict）
const guard = parseInterview(JSON.stringify({
  chains: [{ evIndex: 0, question: 'q', followUp: 'f',
             answerPoints: [{ text: '我负责存储层', quote: '负责存储层改造，QPS 从 300 提升到 5000' }] }]
}), { paras });
assert(guard.chains[0].answerPoints[0].guard === 'conflict', '要点丢掉原文数字 → guard=conflict');

assert(parseInterview('不是json') === null, '坏输出返回 null');
assert(parseInterview('{"chains":"不是数组"}').chains.length === 0, '类型错不崩');
console.log('✅ S4B-3 面试追问解析 + 双护栏');
EOF
```

- [ ] **Step 2: 跑测试确认失败**

```bash
bash test-structure.sh > /tmp/s4b-t3-fail.log 2>&1; tail -8 /tmp/s4b-t3-fail.log
```

Expected: FAIL with `does not provide an export named 'parseInterview'`。

- [ ] **Step 3: 实现 parseInterview**

先在 `evidence.mjs:5` 的 import 里加上 `factGuard`（**依赖链是单向的，`job.mjs` 是零 import 的叶子模块，无循环风险；`zone.mjs:6` 已经这么做过**）：

```javascript
import { DATE_TOKEN_RE, pageSuggestions, FACT_LABELS, factGuard } from './job.mjs';
```

再在 `evidence.mjs` 末尾追加：

```javascript
// ===== S4B-3 面试追问（S4b③）：证据表 → 追问链 + 答法要点 =====
// 双护栏：① quote 子串验证（不在锚定段落里 → 丢弃并计数）② 要点文本对锚定段落跑 factGuard（标 guard，不丢弃）
// 不生成成稿答案——只给要点，避免制造「这不是我的风格」的距离感（小红书 2026-10-14 实测）
const normSpace = (s) => String(s == null ? '' : s).replace(/\s+/g, '');

export function parseInterview(raw, ctx = {}) {
  let d;
  try { d = JSON.parse(stripFence(raw)); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const byZid = new Map((ctx.paras || []).filter((p) => p && p.zid).map((p) => [p.zid, p]));
  const evList = Array.isArray(ctx.evidence) ? ctx.evidence : [];
  let dropped = 0;

  const mkChain = (c, anchoredZid) => {
    if (!c || typeof c !== 'object') return null;
    const question = typeof c.question === 'string' ? c.question.trim() : '';
    if (!question) return null;
    const anchorText = anchoredZid && byZid.get(anchoredZid) ? byZid.get(anchoredZid).text : '';

    // ① 子串验证：quote 对不上锚定段落就丢弃（空锚点时通用问题不做此检查）
    const points = [];
    for (const p of Array.isArray(c.answerPoints) ? c.answerPoints : []) {
      if (!p || typeof p !== 'object') continue;
      const text = typeof p.text === 'string' ? p.text.trim() : '';
      if (!text) continue;
      const quote = typeof p.quote === 'string' ? p.quote.trim() : '';
      if (anchorText) {
        if (!quote || !normSpace(anchorText).includes(normSpace(quote))) { dropped++; continue; }
      }
      points.push({ text, quote, anchored: !!(anchorText && quote), guard: 'normal' });
    }

    // ② factGuard：要点拼接对锚定段落做双向数字/日期检查；只标级不丢弃（答法要点本就应当精简）
    if (anchorText && points.length) {
      const joined = points.map((p) => p.text).join('；');
      const g = factGuard({ kind: 'replace', before: anchorText, after: joined });
      if (g.level === 'conflict') for (const p of points) p.guard = 'conflict';
    }

    return {
      evIndex: Number.isInteger(c.evIndex) ? c.evIndex : -1,
      zid: anchoredZid || '',
      question,
      followUp: typeof c.followUp === 'string' ? c.followUp.trim() : '',
      answerPoints: points,
      empty: points.length === 0
    };
  };

  const chains = [];
  for (const c of Array.isArray(d.chains) ? d.chains : []) {
    const ev = Number.isInteger(c && c.evIndex) ? evList[c.evIndex] : null;
    const chain = mkChain(c, ev && ev.zid);
    if (chain) chains.push(chain);
  }
  const generic = [];
  for (const g of Array.isArray(d.generic) ? d.generic : []) {
    const item = mkChain({ ...g, evIndex: -1 }, '');
    if (item) generic.push(item);
  }
  return { chains, generic, dropped };
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
bash test-structure.sh > /tmp/s4b-t3.log 2>&1; tail -10 /tmp/s4b-t3.log
```

Expected: PASS，含 `✅ S4B-3 面试追问解析 + 双护栏`。

- [ ] **Step 5: 加 buildInterviewPrompt**

`evidence.mjs` 末尾追加：

```javascript
export function buildInterviewPrompt({ jd = '', company = '', role = '', evidence = [], paras = [] }) {
  const evLines = evidence.map((e, i) => {
    const zid = e && e.zid ? e.zid : '';
    const para = zid ? paras.find((p) => p && p.zid === zid) : null;
    const body = para ? para.text : (e && e.current) || '';
    return `【要求 ${i + 1}】${(e && e.req) || ''}\n【简历原文${zid ? '（zid=' + zid + '）' : ''}】${String(body).slice(0, 600)}`;
  }).join('\n\n');
  const sys = '你是资深技术面试官，正在为一轮真实面试预判追问。\n'
    + '严格规则：\n'
    + '1. 只基于给出的简历原文与岗位要求提问，不得虚构简历里不存在的经历、项目、职级或数字。\n'
    + '2. 每条 answerPoint 必须回填支撑它的原文子串（quote），我会逐字校验；对不上就整条作废。\n'
    + '3. followUp 是这个点上再往下一层的追问，不是换个说法重问。\n'
    + '4. answerPoint 只写「要说的要点」，不要写成可直接背诵的成稿答案——用户要用自己的话讲。\n'
    + '5. 只输出 JSON，不要任何解释文字。';
  const user = `【目标公司】${company}\n【目标岗位】${role}\n【JD】\n${jd || '（未提供 JD）'}\n\n`
    + `【岗位要求与简历证据（索引即 evIndex）】\n${evLines || '（证据表为空）'}\n\n`
    + '输出格式：{"chains":[{"evIndex":0,"question":"…","followUp":"…","answerPoints":[{"text":"…","quote":"原文子串"}]}],'
    + '"generic":[{"question":"自我介绍","answerPoints":[{"text":"…","quote":""}]}]}\n'
    + `chains 最多 ${Math.max(1, evidence.length)} 条（对应证据表行），generic 最多 4 条。`;
  return { sys, user };
}
```

- [ ] **Step 6: 提交**

```bash
git add evidence.mjs test-structure.sh
git commit -m "feat(evidence): parseInterview + buildInterviewPrompt——子串验证丢弃编造要点，不生成成稿答案"
```

---

## Task 4 · 服务端 interview 通道

**Files:**
- Modify: `server.mjs:129`（`GEN_KINDS`）、`server.mjs:1627` 与 `server.mjs:1646`（错误文案）、`server.mjs:255` 前（`runGenTask` 加分支）、`server.mjs:363`（`jobView`）

- [ ] **Step 1: GEN_KINDS 加 interview**

`server.mjs:129`：

```javascript
const GEN_KINDS = ['evidence', 'changes', 'interview'];
```

- [ ] **Step 2: 两处错误文案改动态**

`server.mjs:1627`（gen-start）：

```javascript
      if (!GEN_KINDS.includes(kind)) return sendJson(400, { ok: false, error: 'kind 必须是 ' + GEN_KINDS.join('|') });
```

`server.mjs:1646`（gen-cancel）：

```javascript
      if (!GEN_KINDS.includes(kind) || !taskId) return sendJson(400, { ok: false, error: 'kind（' + GEN_KINDS.join('|') + '）与 taskId 必填' });
```

- [ ] **Step 3: runGenTask 加 interview 分支**

在 `async function runGenTask(id, kind, taskId, scope = 'all') {` 的函数体**最开头**、`if (kind === 'evidence') {` **之前**插入：

```javascript
  if (kind === 'interview') {
    try {
      const m0 = loadMeta()[id];
      if (!m0 || !m0.job) return finishGenTask(id, kind, taskId, null, '文档已不是岗位草稿');
      const ev = Array.isArray(m0.job.evidence) ? m0.job.evidence : [];
      if (!ev.length) return finishGenTask(id, kind, taskId, null, '请先生成「要求与证据」——面试追问依赖证据表');
      const html = fs.readFileSync(docPath(id), 'utf8');
      const paras = parasOf(html);
      const p = buildInterviewPrompt({ jd: m0.jd || '', company: m0.company || '', role: m0.role || '', evidence: ev, paras });
      const raw = await chat(root, p.sys, p.user);
      const gen = (Number(m0.job.interviewGen) || 0) + 1;
      const iv = parseInterview(raw, { paras, evidence: ev });
      if (!iv) return finishGenTask(id, kind, taskId, null, '模型输出无法解析为面试追问，未替换任何内容');
      if (!iv.chains.length && !iv.generic.length) return finishGenTask(id, kind, taskId, null, '模型输出的追问无有效内容，未替换任何内容');
      return finishGenTask(id, kind, taskId, (cur) => {
        cur.job.interview = iv;
        cur.job.interviewGen = gen;
        cur.job.interviewBaseHash = contentHash(html);   // S4B-3 stale 判定基线
        return { interview: iv.chains.length + iv.generic.length, interviewGen: gen, dropped: iv.dropped };
      });
    } catch (e) {
      return finishGenTask(id, kind, taskId, null, '模型调用失败：' + (e.message || e));
    }
  }
```

同时把 `evidence.mjs` 的导入补上（`server.mjs:19` 那行）：

```javascript
import { applyOps, reviewConsistency, refFresh, buildEvidencePrompt, parseEvidence, buildInterviewPrompt, parseInterview, guardOps, exportChecks, layoutDiagnose } from './evidence.mjs';
```

- [ ] **Step 4: jobView 补字段与 stale**

`jobView(m)` 签名改为 `jobView(m, id)`，并在 `genTasks` 一行**之前**插入：

```javascript
    interview: (j.interview && typeof j.interview === 'object') ? j.interview : { chains: [], generic: [], dropped: 0 },
    interviewGen: Number(j.interviewGen) || 0,
    // stale：生成时的正文哈希 vs 现在的正文哈希（S4B-3；不匹配 = 来源已变，需重新核对）
    interviewStale: (() => {
      if (!j.interview || !j.interviewBaseHash) return false;
      try { return contentHash(fs.readFileSync(docPath(id), 'utf8')) !== j.interviewBaseHash; }
      catch { return false; }
    })(),
```

`genTasks` 一行改为：

```javascript
    genTasks: j.genTasks
      ? {
          evidence: { ...mkGenTask(), ...(j.genTasks.evidence || {}) },
          changes: { ...mkGenTask(), ...(j.genTasks.changes || {}) },
          interview: { ...mkGenTask(), ...(j.genTasks.interview || {}) }
        }
      : { evidence: mkGenTask(), changes: mkGenTask(), interview: mkGenTask() },
```

再把 `/job/changes` GET 里的 `jobView(m)` 调用改为 `jobView(m, id)`（该路由已有 `id` 变量）。

- [ ] **Step 5: 跑全量回归**

```bash
bash test-structure.sh > /tmp/s4b-t4-structure.log 2>&1; tail -20 /tmp/s4b-t4-structure.log
bash test-render.sh > /tmp/s4b-t4-render.log 2>&1; tail -10 /tmp/s4b-t4-render.log
bash privacy-check.sh > /tmp/s4b-t4-privacy.log 2>&1; tail -10 /tmp/s4b-t4-privacy.log
```

Expected: 三个全绿。**不并发跑**（test.sh 里有锁，绕过会污染）。

- [ ] **Step 6: 起服务验证端点**

先取一个岗位草稿的文档 id（浏览器打开草稿看 URL 也行）：

```bash
python3 -c "import json; d=json.load(open('docs-meta.json')); ids=[k for k,v in d.items() if (v or {}).get('job')]; print(ids[0] if ids else 'NO_JOB_DRAFT')"
```

若输出 `NO_JOB_DRAFT`，说明本地没有岗位草稿 → 浏览器新建一个「空白文档 + 关联岗位」草稿，保存后从 URL 取 id 再继续。**记下这个 id，下两步要用。**

```bash
launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server"
sleep 2
DOC=$(python3 -c "import json; d=json.load(open('docs-meta.json')); print([k for k,v in d.items() if (v or {}).get('job')][0])")
curl -s "http://127.0.0.1:7766/job/changes?id=$DOC" | python3 -c "import sys,json; d=json.load(sys.stdin); print('interview:', d.get('interview')); print('genTasks.interview:', d.get('genTasks',{}).get('interview')); print('stale:', d.get('interviewStale'))"
```

Expected: `interview` 为 `{'chains': [], 'generic': [], 'dropped': 0}`，`genTasks.interview` 含 `'status': 'idle'`，`stale: False`。

再验 kind 校验与并发额度：

```bash
curl -s -X POST "http://127.0.0.1:7766/job/gen-start?id=$DOC&kind=bogus"
curl -s -X POST "http://127.0.0.1:7766/job/gen-start?id=$DOC&kind=interview"
curl -s "http://127.0.0.1:7766/job/changes?id=$DOC" | python3 -c "import sys,json; print(json.load(sys.stdin)['genTasks']['interview']['status'])"
```

Expected: 第一条 `{"ok":false,"error":"kind 必须是 evidence|changes|interview"}`；第二条 `{"ok":true,...,"status":"running"}` 或 409（若证据表为空，这是**预期**——`runGenTask` 会立刻以「请先生成要求与证据」收尾，轮询时看到 `status: 'error'` + 该原因即可）；第三条打印 `running` 或 `error`。

- [ ] **Step 7: 提交**

```bash
git add server.mjs
git commit -m "feat(server): interview 生成通道接入 gen-start 通用端点；jobView 补 interview/interviewStale"
```

---

## Task 5 · 前端折叠区

**Files:**
- Modify: `job-panel.js`（`renderEvidence()` 结尾之后新增 `renderInterview`；`render()` 的 evidence 分支调用它）

- [ ] **Step 1: 新增 renderInterview**

在 `job-panel.js` 的 `renderEvidence` 函数**结束之后**插入（沿用既有模式：`createElement` 构造、`DOC_ID` 取文档 id、`locateZid` 做回跳）：

```javascript
  // ===== S4B-3 面试追问折叠区（挂在证据表底部；不参与任务完成判定，导出永不依赖）=====
  function renderInterview() {
    var box = document.createElement('div');
    box.className = 'jp-group';
    if (!job.evidence || !job.evidence.length) return null;   // 无证据表 → 折叠区不出现

    var gt = (job.genTasks || {}).interview || {};
    var iv = job.interview || { chains: [], generic: [], dropped: 0 };
    var done = gt.status === 'done' && (iv.chains.length || iv.generic.length);

    var det = document.createElement('details');
    det.className = 'jp-iv';
    if (done && !job.interviewStale) det.open = true;
    var sum = document.createElement('summary');
    sum.textContent = '面试追问（按需生成，不影响导出）';
    det.appendChild(sum);

    var act = document.createElement('button');
    act.type = 'button';
    act.className = 'jp-ev-cancel';
    var start = function () {
      api('/job/gen-start?id=' + DOC_ID + '&kind=interview', {}).then(function (d) {
        note(d.ok ? '' : '⚠️ ' + (d.error || '启动失败'));
        schedulePoll();
      });
    };

    if (gt.status === 'running') {
      var spin = document.createElement('div');
      spin.className = 'jp-reason';
      spin.textContent = '⟳ 正在生成追问…';
      det.appendChild(spin);
    } else if (done) {
      if (job.interviewStale) {
        var w = document.createElement('div');
        w.className = 'jp-reason';
        w.textContent = '⚠️ 来源已变化，需重新核对。';
        det.appendChild(w);
      }
      if (iv.dropped) {
        var dr = document.createElement('div');
        dr.className = 'jp-reason';
        dr.textContent = '已丢弃 ' + iv.dropped + ' 条对不上原文的要点';
        det.appendChild(dr);
      }
      var card = function (c, label) {
        var it = document.createElement('div');
        it.className = 'jp-item';
        if (label) { var m = document.createElement('div'); m.className = 'jp-meta'; m.textContent = label; it.appendChild(m); }
        var q = document.createElement('b'); q.textContent = c.question; it.appendChild(q);
        if (c.followUp) { var f = document.createElement('div'); f.className = 'jp-meta'; f.textContent = '再问：' + c.followUp; it.appendChild(f); }
        if (!c.answerPoints || !c.answerPoints.length) {
          var e = document.createElement('div'); e.className = 'jp-meta'; e.textContent = '无可用要点'; it.appendChild(e);
        } else {
          var ul = document.createElement('ul');
          c.answerPoints.forEach(function (p) {
            var li = document.createElement('li');
            li.textContent = p.text;
            if (p.guard === 'conflict') {
              var w2 = document.createElement('span');
              w2.className = 'jp-reason';
              w2.textContent = ' ⚠️与原文数字/日期不一致';
              li.appendChild(w2);
            }
            if (p.anchored && c.zid) {
              var zb = document.createElement('button');
              zb.type = 'button'; zb.className = 'jp-refbtn'; zb.textContent = '回跳';
              zb.addEventListener('click', (function (z) { return function () { locateZid(z); }; })(c.zid));
              li.appendChild(zb);
            }
            ul.appendChild(li);
          });
          it.appendChild(ul);
        }
        return it;
      };
      iv.chains.forEach(function (c, i) { det.appendChild(card(c, '证据表第 ' + (i + 1) + ' 行')); });
      iv.generic.forEach(function (c) { det.appendChild(card(c, '通用问题')); });
      act.textContent = '重新生成';
      act.addEventListener('click', start);
      det.appendChild(act);
    } else {
      var hint = document.createElement('div');
      hint.className = 'jp-meta';
      hint.textContent = gt.status === 'error'
        ? '生成失败：' + (gt.error || '未知原因')
        : (gt.status === 'cancelled' ? '已取消。' : '按你的证据表预判面试官会追问什么，附答法要点。生成失败不影响导出。');
      det.appendChild(hint);
      act.textContent = gt.status === 'error' ? '重试' : (gt.status === 'cancelled' ? '继续生成' : '生成面试追问');
      act.addEventListener('click', start);
      det.appendChild(act);
    }

    box.appendChild(det);
    return box;
  }
```

- [ ] **Step 2: 挂进证据段末尾**

`renderEvidence()` 里最后一条 `root.appendChild(...)` **之后**追加：

```javascript
    var ivBox = renderInterview();
    if (ivBox) root.appendChild(ivBox);
```

> `renderEvidence()` 在 `render()`（`job-panel.js:680`）里以 `if (curSec === 'evidence') renderEvidence();` 调用，**不要改这一行**——证据段已有内容在同一个 `render()` 里继续渲染到 `root`。

- [ ] **Step 3: 接轮询**

`job-panel.js:665` 附近的轮询触发条件（`gt.evidence.status === 'running' || gt.changes.status === 'running'`）改为：

```javascript
      if ((gt.evidence && gt.evidence.status === 'running') || (gt.changes && gt.changes.status === 'running') || (gt.interview && gt.interview.status === 'running')) schedulePoll();
```

- [ ] **Step 4: 浏览器冒烟**

重启服务后，浏览器打开一个**已有证据表**的岗位草稿：

```
1. 审阅面板 →「要求与证据」段 → 底部出现折叠区「面试追问」
2. 点「生成面试追问」→ 显示「⟳ 正在生成追问…」→ 约 10-30s 后出卡片
3. 每条链有：问题 / 再问 / 要点列表 / 锚定要点的「回跳」按钮
4. 点「回跳」→ 正文滚动到该 zid 并闪烁
5. 改一下简历正文保存 → 回到面板 → 折叠区顶部显示「⚠️ 来源已变化」
6. 导出 PDF → 流程不受影响，面板无阻塞
```

Expected: 6 步全部符合。

- [ ] **Step 5: 跑回归**

```bash
bash test-structure.sh > /tmp/s4b-t5-structure.log 2>&1; tail -15 /tmp/s4b-t5-structure.log
bash privacy-check.sh > /tmp/s4b-t5-privacy.log 2>&1; tail -8 /tmp/s4b-t5-privacy.log
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add job-panel.js
git commit -m "feat(job-panel): 证据段底部面试追问折叠区（回跳复用 locateZid，不参与任务完成判定）"
```

---

## Task 6 · 全量回归与冻结基线核对

- [ ] **Step 1: 四件套全跑**

```bash
bash test-structure.sh > /tmp/s4b-final-structure.log 2>&1; tail -15 /tmp/s4b-final-structure.log
bash test-render.sh > /tmp/s4b-final-render.log 2>&1; tail -10 /tmp/s4b-final-render.log
bash privacy-check.sh > /tmp/s4b-final-privacy.log 2>&1; tail -10 /tmp/s4b-final-privacy.log
bash test.sh > /tmp/s4b-final-test.log 2>&1; tail -25 /tmp/s4b-final-test.log
```

Expected: 全绿。`test.sh` 断言数 **≥ 338**（基线来自 `0d09e7b`）。**必须给足 timeout，不要让执行器强杀。**

- [ ] **Step 2: 冻结基线核对**

```bash
git diff bbbad60 -- template.html themes/ render.mjs | head -5
```

Expected: **输出为空**。非空即说明误碰冻结件，必须回退。

- [ ] **Step 3: 确认服务跑的是新代码**

```bash
ps -o lstart= -p "$(pgrep -f 'node.*server.mjs' | head -1)"
git log -1 --format=%ci
```

Expected: 进程启动时间**晚于**最新提交时间。

- [ ] **Step 4: 提交（若有文档改动）**

```bash
git add dev-docs/handoff.md
git commit -m "docs: 回写 S4B-1/S4B-2/S4B-3 上线状态与遗留（空口径数字、非退化下限仍登记为缺口）"
```

---

## 遗留（本轮明确不做，登记在 `dev-docs/handoff.md`）

```
✗ 空口径数字规则化（误报率高，会养出「狼来了」）
✗ 非退化下限阈值（等 lostNums 真实误报率出来再定）
✗ S4b① 五阶段可见进度
✗ S4b② 分批并行与失败重试
✗ AI 生成成稿答案（只给要点）
✗ Type 3 字体是否破坏 ATS 提取（调研挂账中，结论出来前不动 themes/）
✗ 窄屏两行 topnav / 快照横幅叠加时的 scroll-padding 加档（实测遮挡再加）
```