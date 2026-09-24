#!/bin/bash
# test-render.sh — 真实渲染冒烟（playwright + 本机 Chromium）
# 隔离：独立数据根（mktemp），夹具经 template.mjs 装配生成，不接触真实文档与 PDF。
set -e
cd "$(dirname "$0")"
command -v pdftotext >/dev/null || { echo '需要 poppler: brew install poppler'; exit 1; }
TEST_DIR=$(mktemp -d /tmp/resume-render-test.XXXXXX)
export RESUME_ROOT="$TEST_DIR/data"
mkdir -p "$RESUME_ROOT/docs" "$RESUME_ROOT/pdfs"
trap 'rm -rf "$TEST_DIR"' EXIT

node --input-type=module << 'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { assembleTemplate } from './template.mjs';
const tpl = assembleTemplate('classic');   // 夹具经装配生成（themes 唯一源），不直读 template.html
const out = tpl
  .replaceAll('{{NAME}}', () => '测试候选人')
  .replaceAll('{{CONTACT}}', () => '电话：13800000000')
  .replaceAll('{{INTENT}}', () => '后端工程师')
  .replaceAll('{{SUMMARY}}', () => '这是渲染冒烟测试摘要。')
  .replaceAll('{{SKILLS}}', () => '<p><strong>技能一：</strong>内容一</p>')
  .replaceAll('{{WORK}}', () => '<div class="entry-head"><div class="entry-title">某公司</div><div class="entry-role">工程师</div><div class="entry-date">2020-2024</div></div><ul><li>做了一件事</li></ul>')
  .replaceAll('{{PROJECTS}}', () => '')
  .replaceAll('{{EDU}}', () => '')
  .replaceAll('{{DOC_ID}}', () => 'renderfixture');
fs.writeFileSync(path.join(process.env.RESUME_ROOT, 'docs', 'renderfixture.html'), out);
EOF

node render.mjs renderfixture
test -s "$RESUME_ROOT/pdfs/renderfixture.pdf" || { echo '❌ PDF 未生成'; exit 1; }
pdftotext "$RESUME_ROOT/pdfs/renderfixture.pdf" - | grep -q '测试候选人' && echo '✅ 渲染冒烟通过' || { echo '❌ PDF 无中文文本层'; exit 1; }
CHARS=$(pdftotext "$RESUME_ROOT/pdfs/renderfixture.pdf" - | wc -m | tr -d ' ')
[ "$CHARS" -ge 20 ] && echo "✅ ATS 文本层字符量 $CHARS" || { echo "❌ ATS 文本层过短 ($CHARS)"; exit 1; }
