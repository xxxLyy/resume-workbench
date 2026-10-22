/**
 * URL 协议白名单（S4B-9）。
 *
 * 为什么需要：server.mjs 的 `escAttr` 只做 HTML 属性转义（& < > "），
 * **不校验协议**。投递记录的 link 字段是用户手填的，粘进
 * `javascript:window.__L=1` 后渲染成 `<a href="javascript:...">`
 * 会在本站 origin 下执行脚本 —— 二轮安全审查实测确认
 * （`未转义标签命中: ['javascript:window.__L=1']`）。
 * 影响：可读整份简历并 POST 到外部。触发需用户自粘该 URL，概率低但后果是简历外泄。
 *
 * 白名单而非黑名单：黑名单（排 javascript:/data:/vbscript:）永远漏下一个新协议。
 *
 * 放行：http / https / mailto / 站内绝对路径（单斜杠）/ 相对路径 / 锚点。
 * 拒  ：javascript: · data: · vbscript: · 协议相对 `//evil.com`（会跳外站且伪装成本站路径）。
 *
 * 独立成文件而非放 server.mjs：server.mjs 顶层 `tryListen(0)`，import 即起服务，
 * 放进去就没法被任何断言覆盖（与 fpTodo 同款理由）。
 */
export function safeUrl(s) {
  const v = String(s ?? '').trim();
  if (!v) return '';
  // 单斜杠开头但排除「协议相对」：`//` 以及浏览器会当成 `/` 的等价写法
  // （authority 位的 \t \n \r \ 都按 / 处理 → "/\evil.com" 实测会跳到 http://evil.com/）。
  // 判定前先把控制字符与反斜杠剥掉再判，避免绕过。
  const norm = v.replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
  if (/^\/(?!\/)/.test(norm)) return v;
  return /^(?:https?:\/\/|mailto:|\.{1,2}\/|#)/i.test(norm) ? v : '';
}
