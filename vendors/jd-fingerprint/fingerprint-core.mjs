// 来源: career-ops-hq/career-ops @ 090f787e fingerprint-core.mjs（MIT）
// 本地改动（仅 normalizeJdText）：连续汉字段 bigram 切分。上游按空格切 token，
// 纯中文归一化为单一巨 token → tokens<3 → 空指纹 → 永不匹配（上游自认的 CJK 缺口）。
// 其余函数逐字移植：fingerprintText / similarity / popcount 表 / splitFingerprint。
import { createHash } from 'node:crypto';

export const FINGERPRINT_MIN_TEXT = 200;
export const CROSSLIST_THRESHOLD = 0.92;   // 上游英文阈值，留作参考；工作台阈值在 repost-check.mjs
export const CROSSLIST_WINDOW_DAYS = 90;

/** 汉字区（含扩展A + 兼容表意） */
const CJK_RUN = /[\u3400-\u9FFF\uF900-\uFAFF]{2,}/gu;

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
