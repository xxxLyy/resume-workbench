/**
 * 备份包展开尺寸护栏（S4B-10）。
 *
 * 为什么需要：`/restore` 原有的六道防线（上传 ≤300MB、条目数 ≤20000、
 * 路径白名单、禁 `..`、禁绝对路径、禁 symlink）**全都挡不住压缩炸弹**——
 * 二轮安全审查实测：0.32MB 的包展开 314.9MB，放大 98 万倍；
 * 上限 300MB × 百万倍放大足以写满用户数据盘（真实简历无云端备份）。
 *
 * 做法：`tar tzvf` 的每行第 5 列是未压缩 size，求和即展开后总字节数。
 * **任一行解析不出 size 就 fail closed** —— 真实备份不会有这种行，
 * 而"解析失败就放行"等于给攻击者留后门。
 *
 * 独立成文件而非放 server.mjs：server.mjs 顶层 tryListen(0)，import 即起服务，
 * 放进去就没法被任何断言覆盖（与 fpTodo / safeUrl 同款理由）。
 */

/**
 * 展开绝对上限 256 MB。校准依据（2026-10-18 全部实测）：
 *   真实备份（docs+snapshots+pdfs+3 json）  2.75 MB → 展开   4.19 MB   ✅ 余量 61×
 *   多版本快照场景（60 份高度相似快照）    5.1  KB → 展开 207.8 KB   ✅ 余量 1200×
 *   构造炸弹 A（重复 HTML）                1.30 MB → 展开 442.5 MB   ❌ 被拦
 *   构造炸弹 B（二轮审查实测）              0.32 MB → 展开 314.9 MB   ❌ 被拦
 *
 * 为什么**不用压缩倍率限**（原设 50×，已撤）：多版本快照是本项目的正常状态
 * （每次 /save 一份快照），实测该场景压缩比达 **40.5×**——倍率限会误拒自己的合法备份。
 * 绝对上限没有这个误拒面：真实备份比阈值小两个数量级，炸弹比阈值大一个数量级。
 */
export const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;   // 展开绝对上限 256 MB

/**
 * 解析 `tar tzvf` 的输出行，累加未压缩大小。
 * 行格式（bsdtar / GNU tar 通用）：`-rw-r--r-- 0 user group  491 2026-10-18 17:00 name`
 *   第 1 列权限、第 2 列链接数/uid、第 3 列 user、第 4 列 group、第 5 列 size
 *
 * @param {string} list `tar tzvf` 的完整 stdout
 * @returns {{bytes: number, parsed: number, total: number}} 展开字节数 / 成功解析行数 / 总行数
 * @throws {Error} 任一行解析不出 size（fail closed），message 带该行前缀便于定位
 */
export function sumExpandedBytes(list) {
  const lines = String(list).split('\n').filter(Boolean);
  let bytes = 0;
  let parsed = 0;
  for (const line of lines) {
    // 两种 tar 输出的列布局不同，必须都兼容（否则 fail-closed 会误拒另一平台打的合法备份）：
    //   bsdtar/macOS:  -rw-r--r--  0 user group    491 ...   ← 权限 链接数 user group size
    //   GNU tar/Linux: -rw-r--r-- user/group     491 ...   ← 权限 user/group size（无链接数列）
    const m = /^\S+\s+(?:\d+\s+)?(?:\S+\s+){1,2}(\d+)\s/.exec(line);
    if (!m) {
      throw new Error('备份包条目信息无法解析（已拒绝，fail closed）：' + line.slice(0, 80));
    }
    bytes += Number(m[1]);
    parsed++;
  }
  return { bytes, parsed, total: lines.length };
}
