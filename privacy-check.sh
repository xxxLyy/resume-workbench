#!/bin/bash
# privacy-check.sh — 建仓/开源前隐私门槛：忽略清单生效 + 已跟踪文件无敏感模式。
set -e
cd "$(dirname "$0")"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '❌ 还不是 git 仓库'; exit 1; }
for p in docs/ snapshots/ pdfs/ backups/ logs/ photos/ audio/ config.json applications.json materials.json docs-meta.json apply-profiles.json .chromium-choice.json; do
  if [ -e "$p" ] && ! git check-ignore -q "$p"; then echo "❌ 未忽略: $p"; exit 1; fi
done
# 运行时敏感状态（S1 收尾 F-3）：.tx/ = 中断事务载荷（真实 html+meta 整份副本）、.migrate.lock/.meta.lock = 跨进程锁、
# .apply-profiles.lock = 网申包账本跨进程锁、.docs-meta.json.*.tmp / .apply-profiles.json.*.tmp = atomicWrite 残留。
# 模式有效性与文件存在无关 → check-ignore 直接探针（.gitignore 模式缺失即红，防误删后泄漏）。
for p in .tx/probe .migrate.lock .meta.lock .apply-profiles.lock .apply-profiles.json.probe.tmp .docs-meta.json.probe.tmp; do
  git check-ignore -q "$p" || { echo "❌ 未忽略: $p（.gitignore 缺模式）"; exit 1; }
done
HITS=$(git grep --untracked -nE '1[3-9][0-9]{9}|[A-Za-z0-9._%+-]+@(qq|gmail|163|outlook)\.com|sk-[A-Za-z0-9]{16,}|"apiKey"[[:space:]]*:[[:space:]]*"[^"]{8,}' -- . ':!test.sh' ':!test-render.sh' ':!test-structure.sh' ':!test-editor.mjs' ':!config.example.json' 2>/dev/null || true)
if [ -n "$HITS" ]; then echo '❌ 已跟踪文件含疑似敏感内容（文档命中请红改后重跑）:'; echo "$HITS"; exit 1; fi
echo '✅ 隐私检查通过'
