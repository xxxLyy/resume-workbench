#!/bin/bash
# privacy-check.sh — 建仓/开源前隐私门槛：忽略清单生效 + 已跟踪文件无敏感模式。
set -e
cd "$(dirname "$0")"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '❌ 还不是 git 仓库'; exit 1; }
for p in docs/ snapshots/ pdfs/ backups/ logs/ photos/ audio/ config.json applications.json materials.json docs-meta.json .chromium-choice.json; do
  if [ -e "$p" ] && ! git check-ignore -q "$p"; then echo "❌ 未忽略: $p"; exit 1; fi
done
HITS=$(git grep -nE '1[3-9][0-9]{9}|[A-Za-z0-9._%+-]+@(qq|gmail|163|outlook)\.com|sk-[A-Za-z0-9]{16,}|"apiKey"[[:space:]]*:[[:space:]]*"[^"]{8,}' -- . ':!test.sh' ':!test-render.sh' ':!config.example.json' 2>/dev/null || true)
if [ -n "$HITS" ]; then echo '❌ 已跟踪文件含疑似敏感内容（文档命中请红改后重跑）:'; echo "$HITS"; exit 1; fi
echo '✅ 隐私检查通过'
