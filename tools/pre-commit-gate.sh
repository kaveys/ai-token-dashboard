#!/bin/bash
# 提交前强制关卡：对「即将进入 git 的所有内容」做最终隐私扫描。
# 未通过则阻止提交。用法：bash tools/pre-commit-gate.sh

cd "$(dirname "$0")/.." || exit 1

echo "============================================"
echo "  提交前隐私关卡"
echo "============================================"

FAIL=0

# 1) 用 git 自己的视图：只扫已暂存内容
echo "[1/4] 扫描暂存区（git 视角）..."
git diff --cached --name-only > /tmp/staged_files.txt 2>/dev/null
COUNT=$(wc -l < /tmp/staged_files.txt | tr -d ' ')
echo "      暂存文件数: $COUNT"

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    tools/audit-privacy.js|tools/pre-commit-gate.sh|tools/sanitize.js) continue ;;
    *.png|*.jpg|*.jpeg|*.webp|*.ico|*.gif) continue ;;
  esac
  content=$(git show ":$f" 2>/dev/null)
  for kw in kavey "C:\\Users" 微信 xwechat 思政 红米 Magisk 正大杯 高数 无人航空器 极限 键鼠 自用脚本 学习文件 "access_token" "refresh_token" "ghp_"; do
    if echo "$content" | grep -qF "$kw"; then
      echo "  [X] $f 含敏感串: $kw"
      FAIL=1
    fi
  done
done < /tmp/staged_files.txt

# 2) 确认不该提交的文件确实没进暂存区
echo "[2/4] 确认排除清单..."
for bad in "data.json" "data.js" "out/" "bin/" ".session-cache.json" "extra-agents/"; do
  if grep -qxF "data.json" /tmp/staged_files.txt 2>/dev/null && [ "$bad" = "data.json" ]; then
    echo "  [X] 根目录 data.json 进了暂存区"; FAIL=1
  fi
  if grep -qxF "data.js" /tmp/staged_files.txt 2>/dev/null && [ "$bad" = "data.js" ]; then
    echo "  [X] 根目录 data.js 进了暂存区"; FAIL=1
  fi
done
if grep -q "^out/" /tmp/staged_files.txt; then echo "  [X] out/ 进了暂存区"; FAIL=1; fi
if grep -q "^bin/" /tmp/staged_files.txt; then echo "  [X] bin/ 进了暂存区"; FAIL=1; fi
[ "$FAIL" -eq 0 ] && echo "      OK 排除清单生效"

# 3) 大文件检查（GitHub 单文件建议 <50MB）
echo "[3/4] 检查大文件..."
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ ! -f "$f" ] && continue
  sz=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null || echo 0)
  if [ "$sz" -gt 20971520 ]; then
    echo "  [X] $f 超过 20MB ($(( sz/1048576 ))MB)"; FAIL=1
  fi
done < /tmp/staged_files.txt
[ "$FAIL" -eq 0 ] && echo "      OK 无超大文件"

# 4) 运行 JS 审计器
echo "[4/4] 运行 audit-privacy.js ..."
if [ -f bin/node.exe ]; then NODE=./bin/node.exe; else NODE=node; fi
if "$NODE" tools/audit-privacy.js > /tmp/audit_out.txt 2>&1; then
  echo "      OK 审计通过"
else
  echo "  [X] 审计未通过:"
  sed 's/^/      /' /tmp/audit_out.txt | head -15
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "=== 关卡通过，可以提交 ==="
  exit 0
else
  echo "=== 关卡未通过，已阻止 ==="
  exit 1
fi
