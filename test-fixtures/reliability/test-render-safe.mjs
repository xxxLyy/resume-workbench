// test-fixtures/reliability/test-render-safe.mjs — 渲染信任边界 + 产物成对发布（审计 AUD-05 / AUD-07）
// 约束：零网络、零服务启动；只用临时目录，不碰任何真实数据。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { trustedRenderHtml, normalizeScriptForHash, scriptHash, RENDER_REMOVED_KINDS } from '../../render-safe.mjs';
import { publishPair, readSidecarIdentity, makeIdentityValidator, recoverPair } from '../../render-publish.mjs';

// 脚本开头切到项目根：可从任意目录直接运行。
process.chdir(fileURLToPath(new URL('../../', import.meta.url)));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-render-safe-'));
const cleanup = () => {
  try { fs.chmodSync(tmpRoot, 0o755); } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);

// server.mjs 的 sha256b64(normEditorScript(code)) —— 这里独立复算，钉住模块与 server 同口径。
const serverStyleHash = (code) =>
  createHash('sha256')
    .update(String(code).replace(/var DOC_ID = '[^']*';/, "var DOC_ID = '{{DOC_ID}}';"), 'utf8')
    .digest('base64');

const kinds = (r) => r.removed.map((x) => x.kind);

// ===== A. 脚本指纹口径 =====
{
  const code = "var DOC_ID = 'linghaoxiang';\nconsole.log(DOC_ID);";
  assert.equal(normalizeScriptForHash(code), "var DOC_ID = '{{DOC_ID}}';\nconsole.log(DOC_ID);", 'DOC_ID 归一化成占位符');
  assert.equal(scriptHash(code), serverStyleHash(code), '指纹口径与 server.mjs 的 sha256b64(normEditorScript) 一致');
  assert.equal(scriptHash(code), scriptHash("var DOC_ID = 'other';\nconsole.log(DOC_ID);"), '不同 DOC_ID 同一指纹');
}

// ===== B. 未知脚本被剥离 =====
{
  const html = '<html><body><p>正文</p><script>fetch("http://127.0.0.1:9/x")</script></body></html>';
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(!r.html.includes('fetch('), '未知脚本内容不得残留');
  assert.ok(kinds(r).includes(RENDER_REMOVED_KINDS.UNKNOWN_SCRIPT), 'removed 必须报告 unknown-script');
  assert.equal(r.hasUnknownScript, true, 'hasUnknownScript 必须为 true');
  assert.ok(r.html.includes('<p>正文</p>'), '正文不受影响');
}

// ===== C. 已知脚本字节级保留 =====
{
  const code = "var DOC_ID = 'linghaoxiang';\nwindow.__PAGE__=1;";
  const known = new Set([serverStyleHash(code)]);
  const html = `<html><body><p>正文</p><script>${code}</script></body></html>`;
  const r = trustedRenderHtml(html, { knownScriptHashes: known });
  assert.ok(r.html.includes(`<script>${code}</script>`), '已知脚本必须字节级保留');
  assert.ok(!kinds(r).includes(RENDER_REMOVED_KINDS.UNKNOWN_SCRIPT), '已知脚本不得报 unknown-script');
  assert.equal(r.hasUnknownScript, false, '已知脚本不算未知脚本');
  assert.equal(r.html.includes('正文'), true);
}

// ===== D. 外链脚本被剥离 =====
{
  const html = '<script src="https://evil.test/x.js"></script><script type="module" src="/a.js"></script><p>正文</p>';
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(!r.html.includes('evil.test'), '外链脚本地址不得残留');
  assert.ok(!r.html.includes('/a.js'), 'module 外链脚本不得残留');
  assert.equal(kinds(r).filter((k) => k === RENDER_REMOVED_KINDS.EXTERNAL_SCRIPT).length, 2, '两个外链脚本都要报');
  assert.ok(r.html.includes('<p>正文</p>'));
}

// ===== E. 事件属性全部消失 =====
{
  const html = '<div onclick="a()" onerror="b()" onload="c()">x</div><button ONCLICK="d()">y</button>';
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(!/on\w+=/i.test(r.html), '输出里不得残留 on* 事件属性');
  assert.ok(!r.html.includes('a()') && !r.html.includes('b()') && !r.html.includes('c()'), '事件处理代码不得残留');
  assert.ok(r.html.includes('>x</div>'), '元素本身保留');
  assert.equal(kinds(r).filter((k) => k === RENDER_REMOVED_KINDS.EVENT_ATTRIBUTE).length, 4, '四个事件属性都要报');
}

// ===== F. javascript:/vbscript: 协议清除 =====
{
  const html = [
    '<a href="javascript:alert(1)">a</a>',
    '<a href="JaVaScRiPt:alert(2)">b</a>',
    '<a href="java\tscript:alert(3)">c</a>',
    '<a href="  javascript:alert(4)">d</a>',
    '<a href="&#106;avascript:alert(5)">e</a>',
    '<form action="javascript:alert(6)"><button formaction="javascript:alert(7)">f</button></form>',
    '<img src="vbscript:msgbox(8)">'
  ].join('');
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(!/javascript\s*:/i.test(r.html), '输出里不得残留 javascript: 协议');
  assert.ok(!/vbscript\s*:/i.test(r.html), '输出里不得残留 vbscript: 协议');
  assert.ok(kinds(r).includes(RENDER_REMOVED_KINDS.JAVASCRIPT_URL), 'removed 必须报告 javascript-url');
  assert.ok(r.html.includes('>a</a>'), '链接文本保留');
}

// ===== G. 外联载体被剥离 =====
{
  const html = '<iframe src="http://evil.test/"></iframe><object data="x.swf"></object><embed src="y"><p>正文</p>';
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(!r.html.includes('<iframe'), 'iframe 必须移除');
  assert.ok(!r.html.includes('<object'), 'object 必须移除');
  assert.ok(!r.html.includes('<embed'), 'embed 必须移除');
  assert.ok(kinds(r).includes(RENDER_REMOVED_KINDS.EMBED_ELEMENT), 'removed 必须报告 embed-element');
  assert.ok(r.html.includes('<p>正文</p>'), '正文不受影响');
}

// ===== H. meta refresh 被剥离 =====
{
  const html = '<meta http-equiv="refresh" content="0;url=http://evil.test/"><p>正文</p>';
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(!/http-equiv/i.test(r.html), 'meta refresh 必须移除');
  assert.ok(kinds(r).includes(RENDER_REMOVED_KINDS.META_REFRESH), 'removed 必须报告 meta-refresh');
}

// ===== I. HTML 注释被移除 =====
{
  const html = '<!-- 普通注释 --><!--[if IE]><script>bad()</script><![endif]--><p>正文</p>';
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(!r.html.includes('<!--'), '注释必须移除');
  assert.ok(!r.html.includes('bad()'), '注释里的脚本不得残留');
  assert.ok(kinds(r).includes(RENDER_REMOVED_KINDS.COMMENT), 'removed 必须报告 comment');
  assert.ok(r.html.includes('<p>正文</p>'));
}

// ===== J. 合法内容不受损 =====
{
  const html = [
    '<!DOCTYPE html>',
    '<html><head>',
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="/t.css">',
    '<style>@page{size:A4;margin:12mm} .x{color:#111}</style>',
    '</head><body>',
    '<p>第一段文字</p>',
    '<img src="/a.png" alt="图">',
    '</body></html>'
  ].join('');
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(r.html.includes('<meta charset="utf-8">'), 'meta charset 保留');
  assert.ok(r.html.includes('<link rel="stylesheet" href="/t.css">'), 'stylesheet 保留');
  assert.ok(r.html.includes('@page{size:A4;margin:12mm}'), '分页样式保留');
  assert.ok(r.html.includes('<img src="/a.png" alt="图">'), 'img 保留');
  assert.ok(r.html.includes('<p>第一段文字</p>'), '段落文本一字不变');
  assert.equal(r.removed.length, 0, '合法文档不应报告任何剥离');
}

// ===== K. </script> 字符串不得误伤后续边界 =====
{
  const html = '<script>const a="</script>";</script><p>after</p>';
  const r = trustedRenderHtml(html, { knownScriptHashes: new Set() });
  assert.ok(r.html.includes('<p>after</p>'), '</script> 字符串之后的正文必须仍被当作正文');
  assert.ok(!r.html.includes('const a='), '脚本内容不得残留');
  // 已知脚本时整段字节级不变
  const code = 'const a="';
  const known = new Set([serverStyleHash(code)]);
  const r2 = trustedRenderHtml(html, { knownScriptHashes: known });
  assert.equal(r2.html, html, '已知脚本场景下整段 HTML 字节不变');
}

// ===== L. 超限抛错（不静默截断） =====
{
  let err = null;
  try { trustedRenderHtml('<p>x</p>', { maxHtmlBytes: 4 }); } catch (e) { err = e; }
  assert.ok(err, '超限必须抛错');
  assert.equal(err.code, 'RENDER_INPUT_TOO_LARGE');
  assert.ok(err.removed.some((x) => x.kind === RENDER_REMOVED_KINDS.TOO_LARGE), 'err.removed 必须含 too-large');
}

// ===== M. 旁车身份读取 =====
{
  const bad = path.join(tmpRoot, 'bad.env.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(readSidecarIdentity(bad), null, '坏 JSON 返回 null');
  assert.equal(readSidecarIdentity(path.join(tmpRoot, 'missing.env.json')), null, '文件缺失返回 null');
  const good = path.join(tmpRoot, 'good.env.json');
  fs.writeFileSync(good, JSON.stringify({ renderInputId: 'abc123', at: '2026-10-28T00:00:00.000Z', dpi: 150 }));
  const id = readSidecarIdentity(good);
  assert.equal(id.renderInputId, 'abc123', '正常 JSON 返回 renderInputId');
  assert.equal(id.at, '2026-10-28T00:00:00.000Z');
}

// ===== N. publishPair 正常路径 =====
{
  const dir = path.join(tmpRoot, 'n');
  fs.mkdirSync(dir, { recursive: true });
  const outPdf = path.join(dir, 'a.pdf');
  const outSide = path.join(dir, 'a.pdf.env.json');
  fs.writeFileSync(outPdf, 'OLD-PDF');
  fs.writeFileSync(outSide, 'OLD-SIDE');
  const tmpPdf = path.join(tmpRoot, 'n.tmp.pdf');
  const tmpSide = path.join(tmpRoot, 'n.tmp.pdf.env.json');
  fs.writeFileSync(tmpPdf, 'NEW-PDF');
  fs.writeFileSync(tmpSide, JSON.stringify({ renderInputId: 'rid-1' }));

  const r = publishPair({ tmpPdf, tmpSidecar: tmpSide, outPdf, outSidecar: outSide });
  assert.equal(r.ok, true, '正常发布必须成功');
  assert.equal(fs.readFileSync(outPdf, 'utf8'), 'NEW-PDF', 'PDF 必须换新');
  assert.equal(fs.readFileSync(outSide, 'utf8'), JSON.stringify({ renderInputId: 'rid-1' }), '旁车必须换新');
  assert.ok(r.bytes > 0, 'bytes 必须回报');
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.bak-') || n.includes('.new-'));
  assert.deepEqual(leftovers, [], '备份与暂存必须清理干净');
  assert.equal(fs.existsSync(tmpPdf), false, '已消费的临时文件应被删除');
}

// ===== O. publishPair 校验失败：目标产物保持旧内容 =====
{
  const dir = path.join(tmpRoot, 'o');
  fs.mkdirSync(dir, { recursive: true });
  const outPdf = path.join(dir, 'a.pdf');
  const outSide = path.join(dir, 'a.pdf.env.json');
  fs.writeFileSync(outPdf, 'OLD-PDF');
  fs.writeFileSync(outSide, 'OLD-SIDE');
  const tmpPdf = path.join(tmpRoot, 'o.tmp.pdf');
  const tmpSide = path.join(tmpRoot, 'o.tmp.pdf.env.json');
  fs.writeFileSync(tmpPdf, 'NEW-PDF');
  fs.writeFileSync(tmpSide, 'NEW-SIDE');

  const r = publishPair({
    tmpPdf, tmpSidecar: tmpSide, outPdf, outSidecar: outSide,
    validate: () => ({ ok: false, detail: '身份不匹配' })
  });
  assert.equal(r.ok, false, '校验失败必须不发布');
  assert.equal(r.reason, 'validate', 'reason 必须是 validate');
  assert.equal(fs.readFileSync(outPdf, 'utf8'), 'OLD-PDF', '旧 PDF 必须原样保留');
  assert.equal(fs.readFileSync(outSide, 'utf8'), 'OLD-SIDE', '旧旁车必须原样保留');
  assert.equal(fs.existsSync(tmpPdf), true, '校验失败不得消费临时文件');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.bak-') || n.includes('.new-')), [], '校验失败不得留下暂存/备份');
}

// ===== P. publishPair 发布阶段失败：旧 PDF 与旧旁车都还在 =====
{
  const dir = path.join(tmpRoot, 'p');
  fs.mkdirSync(dir, { recursive: true });
  const outPdf = path.join(dir, 'a.pdf');
  const outSide = path.join(dir, 'a.pdf.env.json');
  fs.writeFileSync(outPdf, 'OLD-PDF');
  fs.writeFileSync(outSide, 'OLD-SIDE');
  const tmpPdf = path.join(tmpRoot, 'p.tmp.pdf');
  const tmpSide = path.join(tmpRoot, 'p.tmp.pdf.env.json');
  fs.writeFileSync(tmpPdf, 'NEW-PDF');
  fs.writeFileSync(tmpSide, 'NEW-SIDE');

  // 注入故障：目标目录不可写 → 暂存/替换阶段失败（非 root 环境下确定生效）
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  fs.chmodSync(dir, 0o555);
  let r;
  try {
    r = publishPair({ tmpPdf, tmpSidecar: tmpSide, outPdf, outSidecar: outSide });
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  if (!isRoot) {
    assert.equal(r.ok, false, '发布阶段失败必须报失败');
    assert.equal(r.reason, 'rename', 'reason 必须是 rename');
    assert.equal(fs.readFileSync(outPdf, 'utf8'), 'OLD-PDF', '旧 PDF 必须仍在且字节未变');
    assert.equal(fs.readFileSync(outSide, 'utf8'), 'OLD-SIDE', '旧旁车必须仍在且字节未变');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.bak-') || n.includes('.new-')), [], '失败后不得留下暂存/备份');
  } else {
    console.log('[skip] 以 root 运行：不可写目录注入无效，改由 Q 用例覆盖失败路径');
  }
}

// ===== Q. 发布中途失败 → 回滚（旁车先发布，PDF 失败后旁车必须被还原） =====
{
  const dir = path.join(tmpRoot, 'q');
  fs.mkdirSync(dir, { recursive: true });
  const outPdf = path.join(dir, 'a.pdf');        // 目标是一个目录 → 替换时 EISDIR（确定失败）
  const outSide = path.join(dir, 'a.pdf.env.json');
  fs.mkdirSync(outPdf);
  fs.writeFileSync(outSide, 'OLD-SIDE');
  const tmpPdf = path.join(tmpRoot, 'q.tmp.pdf');
  const tmpSide = path.join(tmpRoot, 'q.tmp.pdf.env.json');
  fs.writeFileSync(tmpPdf, 'NEW-PDF');
  fs.writeFileSync(tmpSide, 'NEW-SIDE');

  const r = publishPair({ tmpPdf, tmpSidecar: tmpSide, outPdf, outSidecar: outSide });
  assert.equal(r.ok, false, '发布失败必须报失败');
  assert.ok(r.reason === 'rename' || r.reason === 'rollback', 'reason 必须是 rename 或 rollback，实际: ' + r.reason);
  assert.equal(fs.readFileSync(outSide, 'utf8'), 'OLD-SIDE', '已发布的新旁车必须回滚成旧旁车');
  assert.ok(fs.statSync(outPdf).isDirectory(), '失败的 PDF 目标不得被替换成新文件');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.bak-') || n.includes('.new-')), [], '失败后不得留下暂存/备份');
}

// ===== R. 缺失临时文件 =====
{
  const dir = path.join(tmpRoot, 'r');
  fs.mkdirSync(dir, { recursive: true });
  const outPdf = path.join(dir, 'a.pdf');
  const outSide = path.join(dir, 'a.pdf.env.json');
  fs.writeFileSync(outPdf, 'OLD-PDF');
  fs.writeFileSync(outSide, 'OLD-SIDE');
  const tmpSide = path.join(tmpRoot, 'r.tmp.pdf.env.json');
  fs.writeFileSync(tmpSide, 'NEW-SIDE');
  const r = publishPair({ tmpPdf: path.join(tmpRoot, 'r-missing.pdf'), tmpSidecar: tmpSide, outPdf, outSidecar: outSide });
  assert.equal(r.ok, false, '缺临时文件必须报失败');
  assert.equal(r.reason, 'missing-tmp', 'reason 必须是 missing-tmp');
  assert.equal(fs.readFileSync(outPdf, 'utf8'), 'OLD-PDF', '目标产物不得被改动');
  assert.equal(fs.readFileSync(outSide, 'utf8'), 'OLD-SIDE', '目标产物不得被改动');
}

// ===== S. 成对身份校验器 =====
{
  const dir = path.join(tmpRoot, 's');
  fs.mkdirSync(dir, { recursive: true });
  const pdf = path.join(dir, 'x.pdf');
  const side = path.join(dir, 'x.pdf.env.json');
  fs.writeFileSync(pdf, 'PDF');
  fs.writeFileSync(side, JSON.stringify({ renderInputId: 'rid-9' }));
  const ok = makeIdentityValidator({ expectedRenderInputId: 'rid-9' })(pdf, side);
  assert.equal(ok.ok, true, '标识一致必须通过');
  const bad = makeIdentityValidator({ expectedRenderInputId: 'other' })(pdf, side);
  assert.equal(bad.ok, false, '标识不一致必须拒绝');
}

// ===== T. 发布中断残留的恢复：退回上一次成对产物 + 清掉残留 =====
{
  const dir = path.join(tmpRoot, 't');
  fs.mkdirSync(dir, { recursive: true });
  const outPdf = path.join(dir, 'a.pdf');
  const outSide = path.join(dir, 'a.pdf.env.json');
  fs.writeFileSync(outPdf, 'OLD-PDF');
  fs.writeFileSync(outSide, 'OLD-SIDE');
  // 模拟「上次发布中途被杀」：备份件 + 暂存件残留
  const bak = outPdf + '.bak-1-2';
  fs.writeFileSync(bak, 'BACKUP-PDF');
  const stale = outPdf + '.new-1-2';
  fs.writeFileSync(stale, 'STALE-NEW');
  const tmpPdf = path.join(tmpRoot, 't.tmp.pdf');
  const tmpSide = path.join(tmpRoot, 't.tmp.pdf.env.json');
  fs.writeFileSync(tmpPdf, 'NEW-PDF');
  fs.writeFileSync(tmpSide, 'NEW-SIDE');
  const r = publishPair({ tmpPdf, tmpSidecar: tmpSide, outPdf, outSidecar: outSide });
  assert.equal(r.ok, true, '恢复后发布应成功：' + JSON.stringify(r));
  assert.equal(fs.readFileSync(outPdf, 'utf8'), 'NEW-PDF', '本次发布应生效');
  assert.equal(fs.readFileSync(outSide, 'utf8'), 'NEW-SIDE', '本次发布应生效');
  assert.ok(!fs.existsSync(stale), '暂存残留必须被删除');
  // 恢复失败时不得静默：recoverPair 的失败项必须被报出
  const rec = recoverPair(path.join(dir, 'missing.pdf'), path.join(dir, 'missing.pdf.env.json'));
  assert.ok(rec && Array.isArray(rec.restored) && Array.isArray(rec.failed), 'recoverPair 必须返回 restored/failed');
}

console.log('test-render-safe.mjs: 全部断言通过');
