// test-import-page.mjs — JD 网址导入轨 A 共享轨 T2：POST /import/page 端点 + extractJd 三层级
// （spec dev-docs/2026-11-12-jd-import-bookmarklet-design.md §2.2/§2.3/§4，DESIGN.md §10.20）
// 断言（任务卡）：
//   ① zhipin fixture POST → via=site-selectors + company=中软国际 + role 含「数据标注」+ jd≥200 字符；
//   ② jsonld fixture → via=json-ld；
//   ③ plain fixture → via=body + jd 非空；
//   ④ OPTIONS /import/page → 204 + ACAO/Allow-Methods/Allow-Headers/Allow-Private-Network 四头；
//   ⑤ POST 响应【不】含 Access-Control-Allow-Origin（保护钉：表单导航不依赖 CORS，
//      带 ACAO 反而让跨站 fetch 读得到预览——母版简历标题清单不跨站暴露；T2 复核返工）；
//   ⑥ 9MB html → 不炸、截断提取（200 + 截断提示）；
//   ⑦ XSS：<img src=x onerror=alert(1)> 递交后预览页不出现 onerror 原文（剥离后文本，非回显原文）；
//   ⑧ 表单含 name=jd/company/role/jdLink/from（带去定制的契约字段）；
//   ⑨ 端到端带入 /job/new 预填；⑩ extractJd 薪资（zhipin job_salary / JSON-LD baseSalary 对象与字符串）；
//   ⑪ 书签 href 带导入口令 k（32hex，.import-token 0600，两次 GET 稳定）。
// 手法：隔离 RESUME_ROOT + 一份母版文档（from select 非空断言）+ 随机端口真实 server + fetch 递交。
// 不读真实数据、不碰 7766、不调真实模型、零写盘断言（端点本身零写盘）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { assembleTemplate } from '../../template.mjs';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const FIX = path.join(APP_ROOT, 'test-fixtures', 'jd-pages');
const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// —— 隔离根 + 一份母版（infos 非空 → from select 必须渲染）——
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-imppage-'));
for (const d of ['docs', 'snapshots', 'pdfs', 'logs', 'backups']) fs.mkdirSync(path.join(root, d), { recursive: true });
let d1 = assembleTemplate('classic');
for (const [k, v] of [['{{NAME}}', '合成'], ['{{CONTACT}}', ''], ['{{INTENT}}', ''], ['{{SUMMARY}}', '摘要'],
  ['{{SKILLS}}', ''], ['{{WORK}}', ''], ['{{PROJECTS}}', ''], ['{{EDU}}', ''], ['{{DOC_ID}}', 'd1']]) d1 = d1.replaceAll(k, () => v);
fs.writeFileSync(path.join(root, 'docs', 'd1.html'), d1);
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ d1: { rev: 1, flow: 'draft' } }));

const port = await new Promise((res) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const server = spawn(process.execPath, [path.join(APP_ROOT, 'server.mjs')], {
  cwd: APP_ROOT, env: { ...process.env, RESUME_ROOT: root, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let exited = null;
server.on('exit', (c, s) => { exited = { c, s }; });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });   // fail() 走 process.exit 也不留孤儿
const base = `http://127.0.0.1:${port}`;
const cleanup = () => {
  try { server.kill('SIGKILL'); } catch {}
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
};

const post = (fields) => fetch(base + '/import/page', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});
const cell = (body, k) => { const m = body.match(new RegExp(k + '</td><td[^>]*>([\\s\\S]{0,200}?)</td>')); return m ? m[1] : ''; };

try {
  for (let i = 0; i < 150; i++) {
    if (exited) fail('服务在就绪前退出：' + JSON.stringify(exited) + '\n' + serverLog.slice(-800));
    try { const r = await fetch(base + '/'); if (r.ok) { await r.text(); break; } } catch {}
    await new Promise((r) => setTimeout(r, 100));
    if (i === 149) fail('服务 15s 未就绪\n' + serverLog.slice(-800));
  }

  // ===== ① zhipin fixture → site-selectors 三字段 =====
  const zh = fs.readFileSync(path.join(FIX, 'zhipin-job.html'), 'utf8');
  const r1 = await post({ html: zh, url: 'https://www.zhipin.com/job_detail/7ad5d5939a74640b1XN63dy-E1RS.html', title: '「数据标注项目管理 双休远程面试招聘」_中软国际招聘-BOSS直聘' });
  if (r1.status !== 200) fail('zhipin POST 非 200：' + r1.status);
  const b1 = await r1.text();
  if (!cell(b1, '提取通道').includes('site-selectors')) fail('zhipin via 非 site-selectors：' + cell(b1, '提取通道'));
  if (!cell(b1, '公司').includes('中软国际')) fail('zhipin 公司未提取：' + cell(b1, '公司'));
  if (!cell(b1, '岗位').includes('数据标注')) fail('zhipin 岗位未含「数据标注」：' + cell(b1, '岗位'));
  const jdLen = Number((cell(b1, 'JD 长度').match(/(\d+)\s*字符/) || [])[1] || 0);
  if (!(jdLen >= 200)) fail('zhipin jd <200 字符：' + jdLen);
  if (!b1.includes('必须有带团队经验')) fail('zhipin JD 预览缺正文');

  // ===== ② JSON-LD JobPosting → json-ld =====
  const jl = fs.readFileSync(path.join(FIX, 'jsonld-job.html'), 'utf8');
  const r2 = await post({ html: jl, url: 'https://example.com/careers/123', title: '高级前端工程师 - 示例科技招聘' });
  const b2 = await r2.text();
  if (!cell(b2, '提取通道').includes('json-ld')) fail('jsonld via 非 json-ld：' + cell(b2, '提取通道'));
  if (!cell(b2, '公司').includes('示例科技')) fail('jsonld 公司未提取：' + cell(b2, '公司'));
  if (!cell(b2, '岗位').includes('高级前端工程师')) fail('jsonld 岗位未提取：' + cell(b2, '岗位'));

  // ===== ③ 无结构正文页 → body 兜底非空 =====
  const pl = fs.readFileSync(path.join(FIX, 'plain.html'), 'utf8');
  const r3 = await post({ html: pl, url: 'https://example.org/job', title: '某招聘页面' });
  const b3 = await r3.text();
  if (!cell(b3, '提取通道').includes('body')) fail('plain via 非 body：' + cell(b3, '提取通道'));
  if (!b3.includes('运维工程师')) fail('plain body 兜底 jd 为空或不含正文');

  // ===== ④-0 GET → 200 使用说明（用户把地址当网址直接打开，不回裸 404）=====
  const rg = await fetch(base + '/import/page');
  const bg = await rg.text();
  if (rg.status !== 200) fail('GET /import/page 非 200：' + rg.status);
  if (!bg.includes('只接收书签发来的页面')) fail('GET /import/page 缺使用说明');
  if (!bg.includes('href="javascript:') || !bg.includes('/import/page')) fail('GET /import/page 说明页缺可拖书签');

  // ===== ④ OPTIONS → 204 + 四头 =====
  const r4 = await fetch(base + '/import/page', { method: 'OPTIONS' });
  if (r4.status !== 204) fail('OPTIONS 非 204：' + r4.status);
  await r4.text();
  const h = r4.headers;
  if (h.get('access-control-allow-origin') !== '*') fail('OPTIONS 缺 ACAO:*：' + h.get('access-control-allow-origin'));
  if (h.get('access-control-allow-methods') !== 'POST, OPTIONS') fail('OPTIONS Allow-Methods 错：' + h.get('access-control-allow-methods'));
  if (h.get('access-control-allow-headers') !== 'Content-Type') fail('OPTIONS Allow-Headers 错：' + h.get('access-control-allow-headers'));
  if (h.get('access-control-allow-private-network') !== 'true') fail('OPTIONS Allow-Private-Network 错：' + h.get('access-control-allow-private-network'));

  // ===== ⑤ POST 响应不带 ACAO（保护钉）=====
  if (r1.headers.get('access-control-allow-origin') !== null) fail('POST 响应不应带 ACAO（跨站 fetch 会读到母版清单）：' + r1.headers.get('access-control-allow-origin'));

  // ===== ⑥ 9MB html → 不炸、截断提取（urlencoded 主体 <10MB 共享上限 → 解析后 html 切 8MB）=====
  const big = '<html><body><p>' + 'a'.repeat(9 * 1024 * 1024) + '</p></body></html>';
  const r6 = await post({ html: big, url: 'https://x.org/j', title: 'big' });
  if (r6.status !== 200) fail('9MB html 非 200（应截断不炸）：' + r6.status);
  const b6 = await r6.text();
  if (!b6.includes('已截断')) fail('9MB html 预览缺截断提示');
  const bigLen = Number((cell(b6, 'JD 长度').match(/(\d+)\s*字符/) || [])[1] || 0);
  if (bigLen !== 8000) fail('9MB 截断后 jd 非 8000 兜底上限：' + bigLen);

  // ===== ⑦ XSS：onerror 事件属性进不了预览页（剥标签后回显的是文本不是原文）=====
  const r7 = await post({ html: '<html><body><img src=x onerror=alert(1)><div>岗位职责：写代码，改 bug，写测试。</div></body></html>', url: 'https://x.org/j', title: 'x' });
  const b7 = await r7.text();
  if (b7.includes('onerror')) fail('预览页残留 onerror 原文');
  if (b7.includes('alert(1)')) fail('预览页残留 alert(1) 原文');

  // ===== ⑧ 带去定制表单契约字段 =====
  for (const f of ['name="jd"', 'name="company"', 'name="role"', 'name="jdLink"', 'name="from"', 'action="/job/new"', 'method="post"', '带去定制']) {
    if (!b1.includes(f)) fail('表单缺契约字段：' + f);
  }

  // ===== ⑨ 端到端轨 A 收口：预览表单字段 → POST /job/new → 预填表单 =====
  // 复刻浏览器「带去定制」提交：抽隐藏字段 value（escAttr 解码）+ from 下拉首项 → POST /job/new，
  // 断言 /job/new 预填：JD 进 textarea 体、公司/岗位进 value、jdLinkRow 展开、母版 selected（spec §2.5）。
  const dec = (s) => s == null ? '' : s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const field = (body, name) => { const m = body.match(new RegExp('name="' + name + '" value="([\\s\\S]*?)"')); return m ? dec(m[1]) : ''; };
  const fromSel = (b1.match(/name="from"[\s\S]*?<option value="([^"]+)"/) || [])[1] || '';
  const bring = await fetch(base + '/job/new', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ jd: field(b1, 'jd'), company: field(b1, 'company'), role: field(b1, 'role'),
      jdLink: field(b1, 'jdLink'), from: fromSel }).toString() });
  if (bring.status !== 200) fail('端到端 POST /job/new 非 200：' + bring.status);
  const bp = await bring.text();
  if (!/id="jobJd"[^>]*>[\s\S]*必须有带团队经验/.test(bp)) fail('端到端：jobJd 未预填提取出的 JD');
  if (!/id="jobCompany"[^>]*value="[^"]*中软国际/.test(bp)) fail('端到端：jobCompany 未预填提取出的公司');
  const e2eRow = (bp.match(/<div id="jdLinkRow"[^>]*>/) || [])[0] || '';
  if (e2eRow.includes('display:none')) fail('端到端：jdLinkRow 应展开（预填了来源链接）');
  if (!bp.includes('job_detail/7ad5d5939a74640b1XN63dy-E1RS.html')) fail('端到端：jobLink 未预填来源 URL');
  if (!bp.includes(`<option value="${fromSel}" selected>`)) fail('端到端：jobFrom 未预选预览表单选中的母版');

  // ===== ⑩ extractJd 薪资（2026-11-13 收件箱 spec §2.4）：zhipin job_salary / JSON-LD baseSalary =====
  if (!cell(b1, '薪资').includes('6-7K')) fail('zhipin 薪资未提取：' + cell(b1, '薪资'));
  const jlNum = jl.replace('"minValue": 25000', '"minValue": 20000').replace('"maxValue": 40000', '"maxValue": 30000');
  const b2n = await (await post({ html: jlNum, url: 'https://example.com/careers/124', title: 'x' })).text();
  if (!cell(b2n, '薪资').includes('20000-30000 MONTH')) fail('JSON-LD 对象薪资未拼出：' + cell(b2n, '薪资'));
  const jlTalk = jl.replace(/"baseSalary":\s*\{[\s\S]*?\}\s*\}/, '"baseSalary": "面议"');
  const b2t = await (await post({ html: jlTalk, url: 'https://example.com/careers/125', title: 'x' })).text();
  if (!cell(b2t, '薪资').includes('面议')) fail('JSON-LD 字符串薪资未原样落：' + cell(b2t, '薪资'));

  // ===== ⑪ 书签带本机导入口令 k（2026-11-13 收件箱 spec §2.1/§2.2）=====
  const jn = await (await fetch(base + '/job/new')).text();
  if (!jn.includes("k.name='k'")) fail('书签缺口令字段 k.name');
  const tok = (jn.match(/k\.value='([0-9a-f]{32})'/) || [])[1] || '';
  if (!/^[0-9a-f]{32}$/.test(tok)) fail('书签口令非 32 位 hex：' + tok);
  const tf = path.join(root, '.import-token');
  if (!fs.existsSync(tf)) fail('隔离根未生成 .import-token');
  if ((fs.statSync(tf).mode & 0o777) !== 0o600) fail('.import-token 权限非 0600：' + (fs.statSync(tf).mode & 0o777).toString(8));
  const jn2 = await (await fetch(base + '/job/new')).text();
  const tok2 = (jn2.match(/k\.value='([0-9a-f]{32})'/) || [])[1] || '';
  if (tok2 !== tok) fail('两次 GET /job/new 口令不一致');

  console.log('✅ import-page：zhipin site-selectors(公司/岗位/JD 260+) / json-ld / body 三层级命中；OPTIONS 四头；POST 无 ACAO；9MB 截断；XSS 剥离；表单五字段；端到端带入 /job/new 预填；薪资三通道；书签口令 32hex+0600+稳定');
} finally {
  cleanup();
}
process.exit(0);
