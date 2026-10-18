# career-ops 集成 · 批次 1（JD 指纹去重）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 设计文档：`dev-docs/2026-10-18-career-ops-jd-fingerprint-design.md`（批次 1 部分）
> 上游溯源：career-ops-hq/career-ops @ `090f787e2499f4fd29b615272946c99dfcab1c28`（MIT）

**Goal:** 在 `/job/create` 挂 JD 内容指纹护栏——创建岗位草稿时自动提醒「同职位建过草稿 / 已投递过 / 疑似重发」，零新依赖、零新 UI、模糊不阻断。

**Architecture:** 移植 career-ops 的 SimHash 指纹核心（改造支持中文 bigram 切分）到 `vendors/jd-fingerprint/`，自写 `repost-check.mjs` 比对薄壳，集成进 `server.mjs` 现有 `/job/create` 路由（精确 409 去重之后），结果落 `job.todos` + JSON `dupHints`。

**Tech Stack:** 纯 Node（`node:crypto`）。无新 npm 依赖。测试进 `test-structure.sh`（FP 组，heredoc 断言风格）。

---

## ⚠️ 项目纪律（执行前必读，违反会出事）

1. **不自动 git 提交**。每个 Task 末尾的「检查点」= 跑四件套相关件 + 报告状态。是否 commit 由用户单独授权（574 行也在等授权）。
2. **跑 test.sh 必须重定向到文件**，禁止管道接 grep、绝不并发、绝不让执行器超时强杀。
3. **冻结件不可动**：`template.html` / `themes/` / `render.mjs`。
4. **夹具必须来自真实产出**：FP 组夹具用 `test-fixtures/jd/` 里的真实 JD 文本（见 Task 0 前置），不手编假 JD。
5. `docs-meta.json` 只经 `updateMeta(root, docId, patchFn)` 写（tx.mjs 唯一写入者纪律）。
6. 面板/注入层 DOM 本计划不触碰；UI 零改动。

## 前置条件（Task 0）

- [ ] **用户提供 2–3 条真实 JD 文本**（Boss直聘或任意国内平台复制的完整 JD，各 ≥300 字）。当前 `docs-meta.json` 含 JD 的岗位草稿数为 0，本机无历史数据可用。
- [ ] 用户已在工作台配置过至少一个模型 profile（本批次不依赖模型，仅确认环境）——**非必须**，可跳过。
- [ ] 服务在跑：`launchctl kickstart -k "gui/$(id -u)/com.lhx.resume-server"`（Task 5 手动验收用）。

---

### Task 1: `normalize-text-key.mjs` + FP-8 断言

**Files:**
- Create: `vendors/jd-fingerprint/normalize-text-key.mjs`
- Modify: `test-structure.sh`（文件末尾追加 FP-8 组）

- [ ] **Step 1.1: 写失败断言**（追加到 `test-structure.sh` 末尾，风格对齐 S4B 组）

```bash
# —— FP-8：公司名归一化（career-ops normalizeTextKey 移植）——
node --input-type=module << 'EOF'
import { normalizeTextKey } from './vendors/jd-fingerprint/normalize-text-key.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-8 ' + m); process.exit(1); } };
assert(normalizeTextKey('字节跳动（北京）') === normalizeTextKey('字节跳动 北京'), '中文公司名去标点归一');
assert(normalizeTextKey('ByteDance!') === normalizeTextKey('bytedance'), '拉丁大小写+标点归一');
assert(normalizeTextKey(null) === '', 'null → 空串（不产生 "null" 字面量）');
assert(normalizeTextKey(undefined) === '', 'undefined → 空串');
assert(normalizeTextKey('İstanbul') === normalizeTextKey('Istanbul'), '土耳其 İ 剥组合点');
assert(normalizeTextKey('Żubr') !== normalizeTextKey('Zubr'), 'Ż 与 Z 保持区分（NFKC 安全属性）');
console.log('✅ FP-8 公司名归一化');
EOF
```

- [ ] **Step 1.2: 跑确认红**

Run: `bash test-structure.sh > /tmp/s.log 2>&1; tail -5 /tmp/s.log`
Expected: `❌ FP-8 ...`（模块不存在，import 失败）

- [ ] **Step 1.3: 写实现**（`vendors/jd-fingerprint/normalize-text-key.mjs`，逐字移植上游 tracker-parse.mjs）

```js
// 来源: career-ops-hq/career-ops @ 090f787e tracker-parse.mjs normalizeTextKey（MIT）
// 逐字移植，零改动。公司名归一化键：NFKC + 小写 + 剥组合点 U+0307 + 仅保字母/记号/数字。
// 注意下面 replace 的正则含一个 U+0307 组合点字符（与上游逐字一致），不是空白。
export function normalizeTextKey(value, separator = '') {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    // 剥组合点 U+0307：'İ'.toLowerCase() 产生 i+U+0307，不剥则 İstanbul/Istanbul 键不同。
    // 不做 NFD：NFKC 下 ż/ė/ġ 是单一预组码位，此 replace 够不到它们的点（保护性结构）。
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, separator)
    .trim();
}
```

（上面正则 `[̀-ͯ]` 是 U+0300–U+036F 组合记号区，比上游单个 U+0307 稍宽；若执行时 FP-8 的 Żubr 区分断言意外失败，改回上游逐字版 `.replace(/̇/gu, '')`——该正则中间是 U+0307 字符本身。）

- [ ] **Step 1.4: 跑绿**

Run: `bash test-structure.sh > /tmp/s.log 2>&1; tail -5 /tmp/s.log`
Expected: `✅ FP-8 公司名归一化` 且既有 83 组 + S4B 组全绿

- [ ] **Step 1.5: 检查点**——报告四件套中 test-structure 状态。不提交。

---

### Task 2: `fingerprint-core.mjs` 移植 + CJK bigram + FP-1/2/5/7

**Files:**
- Create: `vendors/jd-fingerprint/fingerprint-core.mjs`
- Modify: `test-structure.sh`（追加 FP-1/2/5/7 组）

- [ ] **Step 2.1: 写失败断言**

```bash
# —— FP-1/2/5/7：指纹核心（SimHash + CJK bigram 改造）——
node --input-type=module << 'EOF'
import { normalizeJdText, fingerprintText, similarity, FINGERPRINT_MIN_TEXT } from './vendors/jd-fingerprint/fingerprint-core.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-1 ' + m); process.exit(1); } };

// FP-1: 中文 bigram 切分
const zh = '负责后端服务的开发与维护，参与系统架构设计，优化高并发场景下的性能瓶颈，配合产品团队完成需求评审。';
const tokens = normalizeJdText(zh).split(' ').filter(Boolean);
assert(tokens.length > 3, `纯中文切出多个 token（实际 ${tokens.length}）`);
assert(tokens.includes('后端') && tokens.includes('服务'), 'bigram 覆盖（后端/服务）');
const mixed = normalizeJdText('熟悉 Node.js 与 MySQL 优化');
assert(mixed.split(' ').includes('node') && mixed.split(' ').includes('熟悉'), '中英混合 token 流');
console.log('✅ FP-1 中文 bigram 切分');

// FP-2: 确定性
const fpA = fingerprintText(zh);
assert(fpA === fingerprintText(zh), '同文本两次计算指纹相同');
assert(/^[0-9a-f]{16}$/.test(fpA), '指纹为 16 位小写 hex');
console.log('✅ FP-2 指纹确定性');

// FP-5: 短文本静默跳过
assert(fingerprintText('太短') === '', '过短文本返回空指纹');
assert(fingerprintText('') === '', '空串返回空指纹');
assert(similarity('', fpA) === 0 && similarity(fpA, 'zz') === 0, '空/畸形指纹相似度为 0');
console.log('✅ FP-5 短文本静默跳过');

// FP-7: CJK 缺口回归哨兵——上游版本对此返回 ''，bigram 改造后必须非空
// 注意长度：归一化后须 ≥ FINGERPRINT_MIN_TEXT(200)，repeat(4) 保证 ≈245 字
const pureZh = '岗位要求：' + '负责核心系统的设计与开发，保障系统稳定性与高可用，持续优化服务性能，参与技术方案评审与团队协作，输出高质量技术文档。'.repeat(4);
const fpZh = fingerprintText(pureZh);
assert(fpZh !== '', '纯中文 JD 指纹非空（上游 SimHash 对无空格 CJK 静默失效，bigram 已修复）');
console.log('✅ FP-7 纯中文指纹非空（CJK 回归哨兵）');
EOF
```

- [ ] **Step 2.2: 跑确认红**

Run: `bash test-structure.sh > /tmp/s.log 2>&1; tail -8 /tmp/s.log`
Expected: `❌ FP-1 ...`（模块不存在）

- [ ] **Step 2.3: 写实现**（`vendors/jd-fingerprint/fingerprint-core.mjs`）

```js
// 来源: career-ops-hq/career-ops @ 090f787e fingerprint-core.mjs（MIT）
// 本地改动（仅 normalizeJdText）：连续汉字段 bigram 切分。上游按空格切 token，
// 纯中文归一化为单一巨 token → tokens<3 → 空指纹 → 永不匹配（上游自认的 CJK 缺口）。
// 其余函数逐字移植：fingerprintText / similarity / popcount 表 / splitFingerprint。
import { createHash } from 'node:crypto';

export const FINGERPRINT_MIN_TEXT = 200;
export const CROSSLIST_THRESHOLD = 0.92;   // 上游英文阈值，留作参考；工作台阈值在 repost-check.mjs
export const CROSSLIST_WINDOW_DAYS = 90;

/** 汉字区（含扩展A + 兼容表意） */
const CJK_RUN = /[㐀-鿿豈-﫿]{2,}/gu;

/** 连续汉字段 → 两字滑窗，空格分隔 */
const bigramize = (s) => {
  const chars = Array.from(s);
  const out = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out.join(' ');
};

/**
 * JD 文本归一化为 token 流（空格分隔）：小写、去标签/实体/URL、
 * 非字母数字折叠为单空格，然后对连续汉字段做 bigram 切分（本地改造点）。
 */
export function normalizeJdText(text) {
  const cleaned = String(text ?? '')
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return cleaned.replace(CJK_RUN, bigramize);
}

/**
 * 64 位 SimHash（3-token shingle × SHA-1 前 8 字节），16 位小写 hex。
 * 归一化后 <200 字符或 <3 token → ''（不可指纹，调用方静默跳过）。
 */
export function fingerprintText(text) {
  const normalized = normalizeJdText(text);
  if (normalized.length < FINGERPRINT_MIN_TEXT) return '';
  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length < 3) return '';
  const weights = new Array(64).fill(0);
  for (let i = 0; i <= tokens.length - 3; i++) {
    const shingle = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
    const digest = createHash('sha1').update(shingle).digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = digest[bit >> 3];
      weights[bit] += (byte >> (7 - (bit & 7))) & 1 ? 1 : -1;
    }
  }
  let hash = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (weights[bit] > 0) hash |= 1n << BigInt(63 - bit);
  }
  return hash.toString(16).padStart(16, '0');
}

const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

const POPCOUNT16 = (() => {
  const table = new Uint8Array(1 << 16);
  for (let i = 1; i < table.length; i++) table[i] = table[i >> 1] + (i & 1);
  return table;
})();

function popcount32(x) {
  return POPCOUNT16[x & 0xffff] + POPCOUNT16[(x >>> 16) & 0xffff];
}

function splitFingerprint(fp) {
  const s = String(fp);
  return { hi: parseInt(s.slice(0, 8), 16) | 0, lo: parseInt(s.slice(8, 16), 16) | 0 };
}

/** 两指纹相似度：1 − hamming/64。空/畸形 → 0。 */
export function similarity(a, b) {
  if (!FINGERPRINT_RE.test(a || '') || !FINGERPRINT_RE.test(b || '')) return 0;
  const x = splitFingerprint(a);
  const y = splitFingerprint(b);
  return 1 - (popcount32(x.hi ^ y.hi) + popcount32(x.lo ^ y.lo)) / 64;
}
```

（上游另有 `findCrossListings`/`companyKey`/`maxDistanceFor`——本批次不移植：跨公司交叉逻辑被 `repost-check.mjs` 的国内场景两路取代，见设计 §3。）

- [ ] **Step 2.4: 跑绿**

Run: `bash test-structure.sh > /tmp/s.log 2>&1; tail -8 /tmp/s.log`
Expected: `✅ FP-1` / `✅ FP-2` / `✅ FP-5` / `✅ FP-7` 全绿

- [ ] **Step 2.5: 检查点**——不提交。

---

### Task 3: `repost-check.mjs` 比对薄壳 + FP-9

**Files:**
- Create: `vendors/jd-fingerprint/repost-check.mjs`
- Modify: `test-structure.sh`（追加 FP-9 组）

- [ ] **Step 3.1: 写失败断言**

```bash
# —— FP-9：重复提醒判定（repost-check 纯函数）——
node --input-type=module << 'EOF'
import { findDupHints } from './vendors/jd-fingerprint/repost-check.mjs';
import { fingerprintText, similarity } from './vendors/jd-fingerprint/fingerprint-core.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-9 ' + m); process.exit(1); } };
// 注意长度：两段 JD 归一化后各须 ≥200 字（FINGERPRINT_MIN_TEXT），基句 repeat 保证
const jdA = '岗位要求：负责核心系统的设计与开发，保障系统稳定性与高可用，持续优化服务性能，参与技术方案评审与团队协作，输出高质量技术文档。三年以上后端开发经验，熟悉分布式架构与高并发场景，' .repeat(2) + '具备良好的沟通能力与责任心，能够独立完成模块设计与编码实现，熟悉常用中间件原理与调优。';
const jdA2 = jdA.replace(/三年/g, '3 年').replace(/良好/g, '优秀');   // 少量扰动（<5% 字符）
const jdB = '岗位职责：负责前端页面开发与交互实现，配合设计师还原视觉稿，优化页面加载性能，维护组件库，编写单元测试。熟悉 React 与 TypeScript，了解常见工程化工具链，有开源项目经验者优先，' .repeat(2) + '良好的代码风格与文档习惯，两年以上前端开发经验，能独立负责复杂交互模块。';
const today = '2026-10-18T00:00:00Z';
const mk = (over) => Object.assign({ jd: '', jdFp: '', company: '', role: '', dateStr: '', kind: 'draft', label: '' }, over);

// —— 产品主场景：原样重发（HR 原样再发 / 同 JD 换公司名）必须命中 ——
// 0.95 阈值 ≈ 汉明距离 ≤3 位 = 近逐字（上游自证 near-verbatim）。抓的就是原样重发，
// 不是「大幅改写」——后者漏报优于误报（设计 §7）。
let h = findDupHints(jdA, [mk({ jd: jdA, company: '某公司', dateStr: '2026-10-10T00:00:00Z', label: '某公司·后端' })], { today });
assert(h.length === 1 && h[0].score === 1, '原样重复 → score=1 必命中');
assert(h[0].repost === true, '同公司原样重复 → repost 标记');
h = findDupHints(jdA, [mk({ jd: jdA, company: '别家猎头', dateStr: '2026-10-15T00:00:00Z' })], { today });
assert(h.length === 1 && h[0].score === 1 && !h[0].repost, '换公司名原样重发 → 命中但跨公司不标 repost');

// —— 轻微改写（3% 扰动）：只防算法崩坏的下限，不断言命中 ——
// 实测值抄录进 Task 6 校准附录；若实测 ≥0.95 说明容错超预期，可另行收紧断言。
h = findDupHints(jdA, [mk({ jd: jdA2, company: '某公司', dateStr: '2026-10-10T00:00:00Z' })], { today });
const sPerturbed = h.length ? h[0].score : similarity(fingerprintText(jdA), fingerprintText(jdA2));
assert(sPerturbed >= 0.5, '3% 扰动相似度 ≥0.5（防崩坏下限，实测 ' + sPerturbed.toFixed(3) + '，抄录进校准附录）');

// 不同职位不误报（注：合成文本含 repeat 结构，权威的不误报验证在 FP-4 真实夹具）
h = findDupHints(jdA, [mk({ jd: jdB, company: '另一公司', dateStr: '2026-10-10T00:00:00Z' })], { today });
assert(h.length === 0, '不同 JD 不误报（实测 ' + h.length + ' 条）');

// 窗口外跳过
h = findDupHints(jdA, [mk({ jd: jdA2, dateStr: '2025-01-01T00:00:00Z' })], { today });
assert(h.length === 0, '窗口外（>90 天）不提醒');

// 窗口内跨公司 → 命中但无 repost 标记
h = findDupHints(jdA, [mk({ jd: jdA2, company: '别家', dateStr: '2026-10-15T00:00:00Z' })], { today });
assert(h.length === 1 && !h[0].repost, '跨公司相似命中但不标 repost');

// link 精确相等不受窗口限制
h = findDupHints(jdA, [mk({ jd: '', link: 'https://x.zhipin.com/abc', dateStr: '2025-01-01T00:00:00Z', kind: 'app', status: '已约面' })], { today, newLink: 'https://x.zhipin.com/abc' });
assert(h.length === 1 && h[0].kind === 'link' && h[0].status === '已约面', 'link 精确命中带状态');

// 工作台日期格式 '2026-09-11-164709-312' 可解析
h = findDupHints(jdA, [mk({ jd: jdA2, dateStr: '2026-09-11-164709-312' })], { today });
assert(h.length === 1, 'apps 时间戳格式（YYYY-MM-DD-hhmmss-ms）可解析入窗');

// 空指纹静默
assert(findDupHints('太短', [mk({ jd: jdA })], { today }).length === 0, '新 JD 过短 → 零提醒');
console.log('✅ FP-9 重复提醒判定');
EOF
```

- [ ] **Step 3.2: 跑确认红** → Expected: `❌ FP-9`（模块不存在）

- [ ] **Step 3.3: 写实现**（`vendors/jd-fingerprint/repost-check.mjs`）

```js
// 自写薄壳（设计 §3）：career-ops detect-reposts 的国内场景两路化——
// 同公司窗口内相似 = 疑似重发；任意来源相似 = 重复提醒。纯函数，无 IO。
import { fingerprintText, similarity } from './fingerprint-core.mjs';
import { normalizeTextKey } from './normalize-text-key.mjs';

export const FP_THRESHOLD = 0.95;   // 初值；Task 6 校准后固化，分不开则保持并登记
export const FP_WINDOW_DAYS = 90;

/** 宽松日期解析：ISO 或工作台 'YYYY-MM-DD-hhmmss-ms' 格式 */
function parseAnyDate(s) {
  if (!s) return NaN;
  let t = Date.parse(s);
  if (Number.isNaN(t) && s.length >= 10) t = Date.parse(s.slice(0, 10));
  return t;
}

/**
 * 新 JD 与历史记录比对，产出提醒（纯函数）。
 * records: [{ jd?, jdFp?, company?, dateStr?, kind: 'draft'|'app', label?, link?, status? }]
 * opts: { newCompany?, newLink?, threshold?, windowDays?, today? }
 * 返回 [{ kind: 'draft'|'app'|'link', label, dateStr, score, sameCompany, repost, status? }]
 */
export function findDupHints(jdText, records, opts = {}) {
  const threshold = opts.threshold ?? FP_THRESHOLD;
  const windowDays = opts.windowDays ?? FP_WINDOW_DAYS;
  const today = opts.today ? new Date(opts.today) : new Date();
  const cutoff = today.getTime() - windowDays * 86400000;
  const fp = fingerprintText(jdText);
  if (!fp) return [];                       // 新 JD 不可指纹 → 静默零提醒
  const newCompany = normalizeTextKey(opts.newCompany || '');
  const hints = [];
  for (const r of records) {
    // 路 b：link 精确相等，不受窗口限制
    if (r.link && opts.newLink && r.link === opts.newLink) {
      hints.push({ kind: 'link', label: r.label || '', dateStr: r.dateStr || '', score: 1, sameCompany: normalizeTextKey(r.company || '') === newCompany, repost: false, status: r.status });
      continue;
    }
    const t = parseAnyDate(r.dateStr);
    if (Number.isNaN(t) || t < cutoff) continue;
    const rfp = r.jdFp || fingerprintText(r.jd || '');
    if (!rfp) continue;                     // 历史条目不可指纹 → 跳过
    const score = similarity(fp, rfp);
    if (score < threshold) continue;
    const sameCompany = !!newCompany && normalizeTextKey(r.company || '') === newCompany;
    hints.push({ kind: r.kind, label: r.label || '', dateStr: r.dateStr || '', score, sameCompany, repost: sameCompany, status: r.status });
  }
  return hints;
}
```

- [ ] **Step 3.4: 跑绿** → Expected: `✅ FP-9 重复提醒判定`

注意：FP-9 的断言设计经过审查修正——**原样重复（score=1）是产品主场景、必须硬断言**；3% 扰动的相似度**只设 ≥0.5 防崩坏下限**并抄录实测值（0.95 阈值 ≈ 汉明距离 ≤3 位 = 近逐字级别，轻微改写低于阈值属预期行为，不是 bug）。若实测扰动相似度意外 ≥0.95，可把扰动断言升级为命中断言；**禁止**为了让扰动命中而下调 FP_THRESHOLD——那是调数字凑测试（handoff §3.2 假绿的变种）。

- [ ] **Step 3.5: 检查点**——不提交。

---

### Task 4: 真实 JD 夹具 + FP-3/4/6

**Files:**
- Create: `test-fixtures/jd/sample-1.txt`、`test-fixtures/jd/sample-2.txt`（用户提供，Task 0 前置）
- Modify: `test-structure.sh`（追加 FP-3/4/6 组）

- [ ] **Step 4.1: 落夹具**——把用户提供的 2 条真实 JD 分别存入上述两个文件（各 ≥300 字，来源平台写进文件首行注释 `# 来源: Boss直聘 2026-10-18`）。

- [ ] **Step 4.2: 写断言**

```bash
# —— FP-3/4/6：真实 JD 夹具（来源 test-fixtures/jd/，硬规矩：不手编假 JD）——
node --input-type=module << 'EOF'
import { readFileSync } from 'fs';
import { fingerprintText, similarity, normalizeJdText } from './vendors/jd-fingerprint/fingerprint-core.mjs';
const assert = (c, m) => { if (!c) { console.error('❌ FP-3 ' + m); process.exit(1); } };
const raw1 = readFileSync('test-fixtures/jd/sample-1.txt', 'utf8').replace(/^#.*$/m, '').trim();
const raw2 = readFileSync('test-fixtures/jd/sample-2.txt', 'utf8').replace(/^#.*$/m, '').trim();
assert(raw1.length >= 300 && raw2.length >= 300, '夹具为真实长 JD（≥300 字）');

// FP-3: <5% 扰动 → 高相似（阈值断言用实测下限，见 Task 3 Step 3.4 注）
const chars = Array.from(raw1);
const n = Math.max(1, Math.floor(chars.length * 0.04));
const perturbed = chars.map((c, i) => i % Math.floor(chars.length / n) === 0 && i > 10 ? '。' : c).join('');
const s3 = similarity(fingerprintText(raw1), fingerprintText(perturbed));
assert(s3 >= 0.9, `4% 扰动相似度 ≥0.9（实测 ${s3}）`);

// FP-4: 两个不同真实职位 → 不误报
const s4 = similarity(fingerprintText(raw1), fingerprintText(raw2));
assert(s4 < 0.95, `不同职位相似度 <0.95（实测 ${s4}）——若 ≥0.95 说明中文 JD 模板化超过阈值，触发 Task 6 校准降级策略`);

// FP-6: 复制噪声（emoji/链接/空白/标签）清洗稳定
// 注意用相似度而非全等：normalizeJdText 删标签但保留标签内文字（<b>加粗</b> 的「加粗」留下成为新 token），
// 新增 token 会微移指纹——这是正确的清洗行为（真实浏览器复制就这样），全等断言是错的。
const noisy = raw1.replace(/。/, '。😎') + '\nhttps://www.zhipin.com/job_detail/x.htm\n<b>加粗</b>    ';
const s6 = similarity(fingerprintText(noisy), fingerprintText(raw1));
assert(s6 >= 0.95, '噪声清洗后相似度 ≥0.95（实测 ' + s6.toFixed(3) + '；emoji/URL/空白被清掉，标签内文字保留属预期）');
console.log('✅ FP-3/4/6 真实 JD 夹具');
EOF
```

- [ ] **Step 4.3: 跑并记录实测值**——FP-3/4 的实测相似度抄录进设计文档附录（Task 6 一起归档）。若 FP-4 实测 ≥0.95：**不放宽断言**，走设计 §7 降级策略（0.85–0.95 灰区仅同公司提醒），把 FP_THRESHOLD 拆为 `FP_HIT=0.95` 与 `FP_GRAY=0.85` 两档并改 repost-check，同步更新 FP-9。
- [ ] **Step 4.4: 跑绿** → Expected: `✅ FP-3/4/6 真实 JD 夹具`
- [ ] **Step 4.5: 检查点**——不提交。

---

### Task 5: `server.mjs` 双入口集成（`/job/create` + `/version/create`）

**Files:**
- Modify: `server.mjs`（`/job/create` 路由 1425–1500 区域 + `/version/create` 兼容旧入口 1490+ 区域，两者都创建岗位草稿、都必须挂护栏）

> 审查修正：`/version/create` 是「编辑器旧按钮」的兼容入口，同样写 `jd` 建草稿。只挂 `/job/create` 会让旧入口创建的草稿无提醒、无 `jdFp` 存档——两个入口行为分叉。故护栏抽成函数，两处调用。
>
> 性能预估：最坏 ~500 条历史记录 × ~0.5ms/条现算指纹 ≈ 250ms 一次性开销（仅创建草稿时）；历史草稿落盘 `jdFp` 后热路径显著变快。可接受。

- [ ] **Step 5.1: 定义护栏辅助函数**——放在 `server.mjs` 路由定义之前（如 `loadMeta` 定义之后），供两个入口共用：

```js
// —— JD 指纹护栏（career-ops 移植，设计: dev-docs/2026-10-18-career-ops-jd-fingerprint-design.md）——
// 用动态 import 而非顶部静态 import：vendors 模块损坏（如上游同步引入语法错误）时
// 降级跳过护栏，不拖垮 server 启动。模糊匹配不阻断创建；任何异常只记日志。
async function computeFpGuard(jd, jdLink, company, metaAll) {
  try {
    const { fingerprintText } = await import('./vendors/jd-fingerprint/fingerprint-core.mjs');
    const { findDupHints } = await import('./vendors/jd-fingerprint/repost-check.mjs');
    const jdFp = fingerprintText(jd || '');
    if (!jdFp) return { jdFp: '', dupHints: [] };   // 新 JD 不可指纹 → 静默零提醒
    const records = [];
    for (const [k, m] of Object.entries(metaAll)) {
      if (!m || m.kind !== 'job') continue;
      if (!m.jd && !(m.job && m.job.jdFp)) continue;
      records.push({ jd: m.jd || '', jdFp: (m.job && m.job.jdFp) || '', company: m.company, dateStr: m.createdAt, kind: 'draft', label: `${m.company}·${m.role}`, link: (m.jdSource || '').startsWith('http') ? m.jdSource : '' });
    }
    const apps = readJson('apps', []);
    for (const a of Array.isArray(apps) ? apps : []) {
      if (!a || (!a.jd && !a.link)) continue;
      records.push({ jd: a.jd || '', company: a.company, dateStr: a.appliedAt || a.createdAt || '', kind: 'app', label: `${a.company || ''}·${a.role || ''}`, link: a.link || '', status: a.status });
    }
    return { jdFp, dupHints: findDupHints(jd, records, { newCompany: company, newLink: jdLink || '' }) };
  } catch (e) { console.error('[fp-guard] 降级跳过:', e && e.message); return { jdFp: '', dupHints: [] }; }
}

// 指纹提醒 → todo 条目（模式同 jdError todo）
function fpTodo(dupHints) {
  if (!dupHints || !dupHints.length) return [];
  const top = dupHints.slice(0, 3).map((h) =>
    `${h.label}（${String(h.dateStr).slice(0, 10)} ${h.kind === 'app' || h.kind === 'link' ? '已投递' + (h.status ? '·' + h.status : '') : '建过草稿'}${h.repost ? '，疑似重发' : ''}）`
  ).join('；');
  return [{ section: '岗位信息', question: '疑似重复职位：' + top, why: 'JD 内容指纹命中历史记录（最高相似度 ' + Math.round(dupHints[0].score * 100) + '%），请确认是否仍要适配', resolved: false }];
}
```

- [ ] **Step 5.2: `/job/create` 调用**——位置：JD/JDLink 处理完成之后（`jdError` 计算后）、`const nowIso = ...` 之前：

```js
      const { jdFp, dupHints } = await computeFpGuard(jd, jdLink, company, metaAll);
```

  然后 `updateMeta(root, to, () => ({...}))` 的 `job:` 子树两处改动。`todos:` 行**完整替换**（原为 `todos: jdError ? [{...jdError 条目...}] : []` 三元）：

```js
            todos: [...(jdError ? [{ section: '岗位信息', question: 'JD 链接读取失败（' + jdError + '），请粘贴 JD 文本', why: '岗位匹配分析需要 JD', resolved: false }] : []), ...fpTodo(dupHints)],
```

  `job:` 子树加 `jdFp,` 字段（与 `brief` 同级）。

- [ ] **Step 5.3: `/version/create` 同样处理**——旧入口的 `updateMeta(root, to, () => ({...}))`（1490+ 行，`job: { sourceSnap: ..., materials: [], changes: [], todos: [], ... }`）：
  - JD 处理后同样调 `const { jdFp, dupHints } = await computeFpGuard(body.jd, '', body.company.trim(), metaAll);`（注意旧入口的 jd 是 `typeof body.jd === 'string' ? body.jd : ''`，jdLink 无此概念传 `''`）
  - `todos: []` → `todos: fpTodo(dupHints)`
  - `job:` 子树加 `jdFp,`

- [ ] **Step 5.4: JSON 响应**——`/job/create` 的 `sendJson(200, { ok: true, id: to, jdError: jdError || null })` 追加 `dupHints`（JSON 调用方可选消费；HTML 路径行为不变；`/version/create` 保持原响应不加，避免动旧前端契约）。

- [ ] **Step 5.5: 语法与回归**

Run: `node --check server.mjs && bash test-structure.sh > /tmp/s.log 2>&1; tail -5 /tmp/s.log`
Expected: 全绿（FP 组全部通过）

- [ ] **Step 5.6: 手动端到端验收**（服务已 kickstart）。

先找母版 id（非 job 文档）：

```bash
node -e "const m=require('fs').readFileSync('docs-meta.json','utf8');const t=JSON.parse(m);console.log(Object.entries(t).filter(([k,v])=>!v||v.kind!=='job').map(([k,v])=>k+' ('+(v&&v.tag||'母版')+')').join('\n'))"
```

用 `jq` 构造请求体（避免 shell 引号问题，JD 从夹具文件读）：

```bash
jq -n --rawfile jd test-fixtures/jd/sample-1.txt '{from:"<母版id>",company:"指纹测试A",role:"后端",jd:$jd}' > /tmp/req1.json
curl -s -X POST http://localhost:7766/job/create -H 'content-type: application/json' -d @/tmp/req1.json
# 第二次：同 JD、换公司名 → 期待响应含 "dupHints":[{...,"repost":false,...}]
jq -n --rawfile jd test-fixtures/jd/sample-1.txt '{from:"<母版id>",company:"指纹测试B",role:"后端2",jd:$jd}' > /tmp/req2.json
curl -s -X POST http://localhost:7766/job/create -H 'content-type: application/json' -d @/tmp/req2.json
```

Expected: 第二次响应含 `"dupHints"` 非空数组；打开第二个草稿的审阅面板可见「疑似重复职位」待办。验收后用正常删除流程清理这两个测试草稿，并确认 `docs-meta.json` 无残留。

- [ ] **Step 5.7: 检查点**——`bash test.sh > /tmp/t.log 2>&1; tail -25 /tmp/t.log`（基线 338 只增不减）。不提交。

---
### Task 6: 校准脚本 + 阈值固化 + 文档附录

**Files:**
- Create: `scripts/calibrate-fp.mjs`（一次性工具）
- Modify: `dev-docs/2026-10-18-career-ops-jd-fingerprint-design.md`（附录：实测分布）
- Modify（若触发降级）: `vendors/jd-fingerprint/repost-check.mjs`、`test-structure.sh`

- [ ] **Step 6.1: 写校准脚本**

```js
// scripts/calibrate-fp.mjs — 一次性：对全部可用 JD 两两比对，输出相似度分布（设计 §7）
// 用法: node scripts/calibrate-fp.mjs [额外JD文件目录]   （无参数则只读本机存量）
import { readFileSync, existsSync, readdirSync } from 'fs';
import { fingerprintText, similarity } from '../vendors/jd-fingerprint/fingerprint-core.mjs';
const pool = [];
const meta = JSON.parse(readFileSync('docs-meta.json', 'utf8'));
for (const [k, m] of Object.entries(meta)) {
  if (m && m.kind === 'job' && m.jd && m.jd.length >= 200) pool.push({ src: `draft:${k}`, company: m.company, fp: fingerprintText(m.jd) });
}
const apps = existsSync('applications.json') ? JSON.parse(readFileSync('applications.json', 'utf8')) : [];
for (const a of Array.isArray(apps) ? apps : []) {
  if (a && a.jd && a.jd.length >= 200) pool.push({ src: `app:${a.id}`, company: a.company, fp: fingerprintText(a.jd) });
}
const dir = process.argv[2];
if (dir && existsSync(dir)) for (const f of readdirSync(dir)) {
  if (f.endsWith('.txt')) pool.push({ src: `file:${f}`, company: '', fp: fingerprintText(readFileSync(`${dir}/${f}`, 'utf8')) });
}
const pairs = [];
for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
  if (!pool[i].fp || !pool[j].fp) continue;
  const same = pool[i].company && pool[i].company === pool[j].company;
  pairs.push({ a: pool[i].src, b: pool[j].src, same, s: similarity(pool[i].fp, pool[j].fp) });
}
pairs.sort((x, y) => y.s - x.s);
console.log('样本:', pool.length, '对数:', pairs.length);
for (const p of pairs.slice(0, 20)) console.log(p.s.toFixed(3), p.same ? '[同公司]' : '[跨]', p.a, '×', p.b);
```

- [ ] **Step 6.2: 跑校准**——`node scripts/calibrate-fp.mjs test-fixtures/jd`。当前本机存量 JD 为 0，实际样本 = 夹具 2 条 + 用户临时提供的更多 JD（建议合计 ≥6 条）。**样本 <6 条时：FP_THRESHOLD 保持 0.95，设计文档登记「待样本充足后复校」，不阻塞交付**。
- [ ] **Step 6.3: 归档**——实测分布（含 FP-3/4 的相似度值）写进设计文档附录「阈值校准记录」。

---

### Task 7: 四件套回归 + 收尾

- [ ] **Step 7.1: 四件套**（逐个跑，重定向到文件，看尾部）

```bash
bash test-structure.sh > /tmp/s.log 2>&1; tail -5 /tmp/s.log   # 83+5(S4B)+9(FP) 组
bash test-render.sh    > /tmp/r.log 2>&1; tail -5 /tmp/r.log
bash privacy-check.sh  > /tmp/p.log 2>&1; tail -5 /tmp/p.log
bash test.sh           > /tmp/t.log 2>&1; tail -25 /tmp/t.log   # 基线 338 只增不减
```
Expected: 全绿。

- [ ] **Step 7.2: 冻结件验证**

Run: `git diff --stat -- template.html themes/ render.mjs`
Expected: 空输出（本计划未触碰）。

- [ ] **Step 7.3: 遗留登记**——`dev-docs/handoff.md` 登记两行：批次 1 落地状态；批次 2（评估）计划待写。上游同步纪律（每季度 diff fingerprint-core.mjs，跑 FP-7）写进 handoff §5。
- [ ] **Step 7.4: 报告**——汇总改动行数、测试增量、实测阈值数据，等用户决定是否提交。

---

## 真实 JD 校准数据（2026-10-18 实测，来自 Boss直聘真实 JD 5 条）

夹具：`test-fixtures/jd/sample-1..5.txt`（截图转录，含来源注释行）。长度 286–770 字，**5 条全部产出非空指纹**。

两两相似度矩阵：

|          | sample-1 | sample-2 | sample-3 | sample-4 | sample-5 |
|---|---|---|---|---|---|
| sample-1 | 1.0000 | 0.4531 | 0.5313 | 0.4531 | **0.6406** |
| sample-2 | 0.4531 | 1.0000 | 0.5469 | 0.5000 | 0.4375 |
| sample-3 | 0.5313 | 0.5469 | 1.0000 | 0.4844 | 0.5156 |
| sample-4 | 0.4531 | 0.5000 | 0.4844 | 1.0000 | 0.5938 |
| sample-5 | **0.6406** | 0.4375 | 0.5156 | 0.5938 | 1.0000 |

**结论：FP_THRESHOLD = 0.95 在真实 JD 上安全，余量 0.31。**

最高一对（sample-1 × sample-5 = 0.6406）恰好是**语义高度重叠的两条数据标注方向 JD**（一条管标注团队、一条做标注执行），是真实数据里最难区分的一对——连它都只有 0.64，说明 0.95 不会误报普通相似职位。

样本说明（不影响测试有效性，仅记录）：
- 5 条均为机器视觉 / 数据标注 / 算法方向，与本项目 Node.js 后端方向不同——作为「不同岗位不误报」的夹具是理想选择。
- **不含「同公司同岗位的两个版本」**（重发检测最真实的场景），校准该场景仍依赖 FP-9 的合成文本。后续若补一条该类样本，可进一步验证 0.95 在「轻度改写」下的表现。

## 实施期发现（Task 1–2 实测，补入计划供后续任务参考）

### 1. 计划自身的缺陷：FP-2 的 fixture 长度不足（已修）

计划原给 FP-2 的 `zh` 仅 49 字 → bigram 展开后 122 字符 < `FINGERPRINT_MIN_TEXT`(200) → `fingerprintText` 返回 `''` → hex 正则断言**必然失败**。FP-7 的注释里已提醒长度检查，FP-2 漏了同一道。

修法：FP-2 输入改 `zh.repeat(5)`（245 字 → 614 展开字符），**断言条件逐字保留**，加注释说明长度原因。附带收益：FP-5 的 `similarity('', fpA)` 从「拿空串空转」变为真正的畸形输入拒配检查。

### 2. FP-7 哨兵曾是假绿（已修）：必须用无标点 fixture

计划原给的 FP-7 fixture 混了中文逗号句号。归一化 `[^\p{L}\p{N}]+→空格` 把标点折成空格，整段被切成 21 个 token，**上游的 `<3 token` 护栏根本不触发** → 关掉 bigramize 该断言照样绿。它只验证了「带标点中文能出指纹」，而那恰好是上游本来就能做到的路径。

修法：fixture 换成无标点纯中文（`.repeat(6)`，318 字）。实测对照：

| | 归一化长度 | token 数 | 指纹 |
|---|---|---|---|
| 本实现（有 bigram） | 950 | 317 | `ed7376a8a0cda07a` |
| 上游等价格式 | 318 | **1** | **空** ← 静默失效 |

已用「破坏实现看断言是否转红」验证过：关掉 `bigramize` → 指纹空 → FP-7 红 ✅（真哨兵）。

**教训**：哨兵断言的 fixture 必须落在**只有修复后才通过的路径**上；落在上游本来就能过的路径上 = 假绿。

### 2. 写入工具会对汉字区码位做 NFKC 归一化（必须用 \u 转义）

`CJK_RUN = /[㐀-鿿豈-﫿]{2,}/gu` 里的四个汉字区边界字符**用 Write 和 Edit 工具都写不对**——U+F900（兼容表意「豈」）被归一化成 U+8C48（繁体「豈」）。

这个 bug 有欺骗性：落盘的 `[㐀-鿿豈-﫿]` 展开成 `U+8C48-U+FAFF`，是目标范围的**超集**，中文照样能正常切分、测试照样绿——但匹配区间下界被静默扩大。

**唯一可靠写法**：用 python3 做字节级替换，落盘为纯 ASCII 转义 `const CJK_RUN = /[\u3400-\u9FFF\uF900-\uFAFF]{2,}/gu;`

> 同类陷阱：计划 FP-6 的测试字符串里藏过一个 U+00A0（不间断空格），肉眼不可见。

### 3. 长度门槛对中文实际宽松约 3 倍

`FINGERPRINT_MIN_TEXT` 作用在 **bigram 展开之后**的字符串上。200 展开字符 ≈ 67 个真实汉字，所以中文 JD 的实际下限比英文低约 3 倍。

方向正确（护栏能工作而非静默失效），但 Task 6 校准时若发现中文指纹过松，记得这个系数。

## Self-Review 记录

- **Spec 覆盖**：设计 §2（CJK 改造）→ Task 2；§3（移植包三件）→ Task 1/2/3；§4.2 四路中 a/b/c → Task 5（d 路属批次 2，计划不含，符合拆分）；§6.1 FP-1..7 → Task 2/4（另扩 FP-8/9 覆盖 normalizeTextKey 与 repost-check，设计未列但必要）；§7 校准 → Task 6；§8 同步纪律 → Task 7.3。✅ 无缺口。
- **Placeholder 扫描**：所有代码块完整可执行；唯一外部依赖（真实 JD 夹具）在 Task 0 显式前置。✅
- **类型一致性**：`findDupHints(jdText, records, opts)` 在 Task 3 定义、Task 5 调用签名一致；`jdFp` 字段名在 Task 5.2（meta）与 Task 5.1（读取 `m.job.jdFp`）一致；`normalizeTextKey` 导出名 Task 1/3 一致。✅
- **已知不确定点**（执行时按实测调整，非 placeholder）：FP-3/9 的断言数字依赖实测相似度（Task 3 Step 3.4、Task 4 Step 4.3 已写明调整规则）；FP-4 误报触发降级策略路径已写明。

## 深度审查记录（2026-10-18 第二轮，已全部修正进上文）

| # | 级别 | 发现 | 修正 |
|---|---|---|---|
| A | 🔴 | FP-9 断言 3% 扰动 ≥0.9 高估 SimHash 容错（0.95≈汉明 ≤3 位=近逐字；扰动预期 0.7–0.85），会诱发「调数字凑测试」假绿 | 断言拆两层：原样重复/换公司名 → score=1 硬断言（产品主场景）；扰动仅 ≥0.5 防崩坏下限 + 抄录实测 |
| B | 🔴 | FP-6 全等断言必失败：`<b>加粗</b>` 清洗后标签内文字留下成新 token，指纹必变 | 改相似度 ≥0.95 断言；顺带清除测试字符串里隐藏的 U+00A0 |
| C | 🔴 | `/version/create` 旧入口（编辑器旧按钮）同样建草稿但无护栏无 jdFp，两入口行为分叉 | 护栏抽 `computeFpGuard()`+`fpTodo()`，双入口调用（Task 5 重写） |
| D | 🟡 | Step 1.3 出现两个冲突的正则版本 | 收敛为单一版本 + 注明与上游逐字版的差异与回退路径 |
| E | 🟡 | todos 三元表达式未给合并后完整行 | Task 5.2 给出完整替换行 |
| F | 🟡 | `k === to` 死代码 | 已删（新 id 不可能在 metaAll 快照中） |
| G | 🟢 | curl `$(cat)` 内嵌 JD 有 shell 引号风险；母版 id 无查找方法 | 改 `jq --rawfile` 构造 + 给母版查找命令 |
| H | 🟢 | 动态 import 无理由说明，易被「优化」成静态 import 拖垮启动 | Task 5.1 补理由注释 |
| I | 🟢 | 缺性能预估 | Task 5 头部补 ~250ms 最坏一次性开销说明 |
| J | 🟢 | FP-9 合成 JD 的 repeat 结构非真实特征，不误报权威在 FP-4 | FP-9 注明分工 |

**已知接受（不修）**：并发双建（两请求同读旧 metaAll 快照 → 都不提醒、都建草稿）——概率低、后果轻（多一个草稿可删）、防御需引锁违背最简原则。
