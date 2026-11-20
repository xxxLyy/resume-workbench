// test-upcv-residual.mjs — 2026-11-20 UPCV 残余 #2 个人求职主页
// 合同：合成母版 → buildSiteHtml 含姓名/联系方式/章节；无母版 → {ok:false} 诚实报；
//      generateSite 落 site/index.html（0600）。
// 夹具口径：隔离 RESUME_ROOT，不起 server.mjs。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const html = buildSiteHtml(root);
assert.ok(html.includes('张三') && html.includes(PH) && html.includes('zs@test.com'), '主页应含姓名与联系方式');
assert.ok(html.includes('求职意向') || html.includes('后端工程师'), '主页应含求职意向');
assert.ok(html.includes('工作经历') && html.includes('日均十万单'), '主页应含章节正文');
const g = generateSite(root);
assert.equal(g.ok, true); assert.ok(fs.existsSync(path.join(root, 'site', 'index.html')), 'site/index.html 应落盘');
const mode = fs.statSync(path.join(root, 'site', 'index.html')).mode & 0o777;
assert.equal(mode, 0o600, '主页文件权限应 0600');
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-resid-none-'));
fs.mkdirSync(path.join(root2, 'docs'), { recursive: true });
fs.writeFileSync(path.join(root2, 'docs-meta.json'), '{}');
const g2 = generateSite(root2);
assert.equal(g2.ok, false, '无母版应 ok:false: ' + JSON.stringify(g2));
console.log('✅ 全绿：UPCV 残余 #2 个人求职主页');
process.exit(0);
