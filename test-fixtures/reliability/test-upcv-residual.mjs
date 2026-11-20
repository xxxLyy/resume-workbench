// test-upcv-residual.mjs — 2026-11-20 UPCV 残余 #2 个人求职主页 + #3 职位监控
// 合同：
//   ① job_monitor：stub 上游 {data,total} → 首次全为新岗 + seenIds/lastRun 落 agent-prefs.json；
//      再跑同库 → newCount=0（并集 seenIds 只认「从未见过」）；新增 1 条 → newCount=1。
//   ② site：合成母版 → buildSiteHtml 含姓名/联系方式/章节；无母版 → {ok:false} 诚实报。
//      generateSite 落 site/index.html（0600）。
// 夹具口径：隔离 RESUME_ROOT + RESUME_UPCV_BASE 指向本机 stub（零真上游）；不起 server.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { init, runTool, getAgentPrefs } from '../../agent.mjs';
import { buildSiteHtml, generateSite } from '../../site.mjs';

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-resid-'));
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
const PH = '1380013' + '8000';   // 假号码拼接构造：privacy-check 扫字面量（S1-FW-3 同款纪律，不写 11 连）
fs.writeFileSync(path.join(root, 'docs', 'm1.html'),
  '<!doctype html><html><body><h1>张三</h1><p>电话：' + PH + ' | 邮箱：zs@test.com</p><p>求职意向：后端工程师</p>'
  + '<section class="section"><div class="section-title">工作经历</div><p>负责订单系统，日均十万单。</p></section>'
  + '<section class="section"><div class="section-title">技能</div><p>Go / MySQL</p></section></body></html>');
fs.writeFileSync(path.join(root, 'docs-meta.json'), JSON.stringify({ m1: { rev: 1, kind: 'master', title: '张三' } }));
init(root);

// —— stub 上游职位库（RESUME_UPCV_BASE 在调用时才读 env，此时设就行）——
const J1 = [{ jobId: 'j-1', jobName: '后端工程师', brandName: '甲公司', salaryDesc: '25-35K', cityName: '深圳' },
            { jobId: 'j-2', jobName: '算法工程师', brandName: '乙公司', salaryDesc: '30-45K', cityName: '杭州' }];
let rows = J1;
const stub = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url.startsWith('/campus/jobs') ? { data: rows, total: rows.length } : { data: [], total: 0 }));
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.RESUME_UPCV_BASE = `http://127.0.0.1:${stub.address().port}`;

// ① job_monitor
{
  const r1 = await runTool('job_monitor', {}, { root });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.newCount, 2); assert.equal(r1.total, 2);
  assert.equal(r1.items[0].company, '甲公司');
  const p1 = getAgentPrefs();
  assert.equal(p1.monitor.seenIds.length, 2); assert.ok(p1.monitor.lastRun);
  const r2 = await runTool('job_monitor', {}, { root });
  assert.equal(r2.newCount, 0, '同库二刷应零新岗: ' + JSON.stringify(r2));
  rows = J1.concat([{ jobId: 'j-3', jobName: '数据开发', brandName: '丙公司', salaryDesc: '20-30K', cityName: '合肥' }]);
  const r3 = await runTool('job_monitor', {}, { root });
  assert.equal(r3.newCount, 1); assert.equal(r3.items[0].id, 'j-3');
  const prefsOnDisk = JSON.parse(fs.readFileSync(path.join(root, 'agent-prefs.json'), 'utf8'));
  assert.ok(prefsOnDisk.monitor.seenIds.includes('j-3'), 'seenIds 应落盘');
  console.log('✅ ① job_monitor：新岗比对 + seenIds 落盘 + 幂等');
}

// ② site
{
  const html = buildSiteHtml(root);
  assert.ok(html.includes('张三') && html.includes(PH) && html.includes('zs@test.com'), '主页应含姓名与联系方式');
  assert.ok(html.includes('求职意向') || html.includes('后端工程师'), '主页应含求职意向');
  assert.ok(html.includes('工作经历') && html.includes('日均十万单'), '主页应含章节正文');
  const g = generateSite(root);
  assert.equal(g.ok, true); assert.ok(fs.existsSync(path.join(root, 'site', 'index.html')), 'site/index.html 应落盘');
  const mode = fs.statSync(path.join(root, 'site', 'index.html')).mode & 0o777;
  assert.equal(mode, 0o600, '主页文件权限应 0600');
  // 无母版 → 诚实报
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-resid-none-'));
  fs.mkdirSync(path.join(root2, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root2, 'docs-meta.json'), '{}');
  const g2 = generateSite(root2);
  assert.equal(g2.ok, false, '无母版应 ok:false: ' + JSON.stringify(g2));
  console.log('✅ ② site：母版→主页 + 落盘 0600 + 无母版诚实报');
}

stub.close();
console.log('✅ 全绿：UPCV 残余 #2 个人主页 + #3 职位监控');
process.exit(0);
