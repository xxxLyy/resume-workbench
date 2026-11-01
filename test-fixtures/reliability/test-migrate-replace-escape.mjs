// test-migrate-replace-escape.mjs — 迁移注入模板片段必须用函数替换（BL-P6-04，low 潜伏隐患）
// 背景：migrate-editor.mjs 把模板派生的 toolbar[0]/newScript 以「字符串」喂给 String.replace，
// 模板里一旦出现 $& / $` / $' / $$（今天没有 → 潜伏），会被当替换模式解释，把模板片段拼坏
// 旧文档。同文件上一行的 replaceAll('{{DOC_ID}}', () => jsId) 早已是正确姿势。
// 断言形态：静态钉住「函数替换」形态（模板是冻结件，无法用含 $ 的真实模板造反例）+
// 端到端冒烟（真实模板迁移一轮成功，防函数化改错形）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const APP_ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

// ① 静态钉住：替换源是模板片段的 replace 一律函数形态，不得出现裸字符串形态
const src = fs.readFileSync(path.join(APP_ROOT, 'migrate-editor.mjs'), 'utf8');
assert.ok(src.includes('() => toolbar[0]'), 'toolbar 替换必须是函数形态（() => toolbar[0]）');
assert.ok(src.includes('() => newScript'), 'script 替换必须是函数形态（() => newScript）');
assert.ok(!/\.replace\([^)]*,\s*toolbar\[0\]\)/.test(src), '存在裸字符串形态的 toolbar 替换（$&/$`/$\'/$$ 会被解释）');
assert.ok(!/\.replace\([^)]*,\s*newScript\)/.test(src), '存在裸字符串形态的 script 替换');

// ② 端到端冒烟：一份旧形状文档真实迁移成功（工具栏升级到当前模板、{{DOC_ID}} 注入正确）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-mer-'));
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
fs.mkdirSync(path.join(root, 'backups'), { recursive: true });
fs.writeFileSync(path.join(root, 'docs', 'd1.html'),
  '<!doctype html><html><head><title>x</title></head><body>' +
  '<div class="edit-toolbar" data-editor="v3"><button id="pdfBtn">PDF</button></div>' +
  '<script>(function () { var DOC_ID = \'d1\'; })();</script>' +
  '<p data-zid="z11111111">正文</p></body></html>');
const r = spawnSync(process.execPath, [path.join(APP_ROOT, 'migrate-editor.mjs')], {
  env: { ...process.env, RESUME_ROOT: root }, encoding: 'utf8', timeout: 60000
});
assert.equal(r.status, 0, 'migrate-editor 应退出 0，stderr=' + (r.stderr || '').slice(-400));
const out = fs.readFileSync(path.join(root, 'docs', 'd1.html'), 'utf8');
assert.ok(out.includes('data-editor="v5"'), '迁移后工具栏应为当前模板版本');
assert.ok(out.includes("var DOC_ID = 'd1'"), '迁移后主脚本应注入真实 docId');
fs.rmSync(root, { recursive: true, force: true });

console.log('✅ 迁移替换函数化：静态钉住函数形态 + 真实模板端到端迁移冒烟通过');
