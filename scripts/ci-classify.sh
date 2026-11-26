#!/usr/bin/env bash
# CI 模式判定（DEC-344 纯文档、DEC-454① 轻量 / 完整），供 .github/workflows/ci.yml 的 changes job 调用，
# 回归测试见 tests/ci-classify.test.ts。
# 输入（环境变量）：EVENT_NAME（github.event_name）、BASE_REF（PR 目标分支）、QUEUE_HEAD（PR 是否带 queue-head 标签，true/false）。
# 另接收 EVENT_ACTION / EVENT_LABEL（github.event.action / github.event.label.name），用于忽略无关 labeled。
# pull_request 时在 GitHub 测试合并提交上运行：HEAD^1 是 base，diff HEAD^1 HEAD 即 PR 相对 base 的完整改动。
# 输出：stdout 先一行 evidence_check=true|false，最后一行 mode=docs|light|full（ci.yml 追加到 GITHUB_OUTPUT）；
#   改动文件清单打到 stderr。
#   docs  纯文档：必需检查以必需名称快速通过；只有目标分支是 main 才可能（见下）
#   light 在途 PR：只跑轻量检查，必需检查改名报告（保持等待）
#   full  完整测试
# evidence_check（F-573）：light 模式下改动了 apps/api/src 或 tests/acceptance/support/route-policy 时为 true，
#   light job 据此加跑“F090b 证据快检”（登记 / 锚点差异在 PR 上就暴露，不等队首完整 CI）。
#   docs / full 一律 false：full 的 PGlite 分片本来就跑 F090b 全套，不重复；git diff 失败 / 改动为空按 true 处理，宁可多跑。
set -euo pipefail

EVENT_NAME="${EVENT_NAME:-}"
EVENT_ACTION="${EVENT_ACTION:-}"
EVENT_LABEL="${EVENT_LABEL:-}"
BASE_REF="${BASE_REF:-}"
QUEUE_HEAD="${QUEUE_HEAD:-false}"

if [ "$EVENT_NAME" != pull_request ]; then
  echo "evidence_check=false"
  echo "mode=full"
  exit 0
fi

# DEC-694②：workflow 已隔离并跳过无关 labeled；脚本也保守返回 light，不能借已有标签或纯文档放行。
if [ "$EVENT_ACTION" = labeled ] && [ "$EVENT_LABEL" != queue-head ]; then
  echo "无关 labeled 事件：不报告完整或纯文档检查" >&2
  echo "evidence_check=false"
  echo "mode=light"
  exit 0
fi

# 目标分支不是 main 的 PR 永远 light（DEC-454① 第 2 轮 P2-1）：必需名称上的成功挂在 PR 头提交上，
# 改 base 不会使其失效（分支保护 strict=false）。若相对功能分支判 docs 并以必需名称报告成功，
# 把 base 改成 main 后，同一提交上的“纯文档”绿灯会被拿来放行功能分支上未经完整测试的代码。
# 完整运行也只对 main 有意义，所以 queue-head 标签在非 main 目标上同样不生效。
# 非 main 目标仍按改动判 evidence_check：快检只看本 PR 相对 base 的改动，不影响 mode。
non_main=false
if [ "$BASE_REF" != main ]; then
  echo "目标分支为 ${BASE_REF:-（空）}，不是 main：按轻量模式报告" >&2
  non_main=true
fi

docs_only=false
evidence_hit=false
changed="$(mktemp)"
trap 'rm -f "$changed"' EXIT
# -z 避免中文路径被转义；--no-renames 让“代码改名为文档”时旧路径也算改动
if git diff -z --name-only --no-renames 'HEAD^1' HEAD >"$changed"; then
  tr '\0' '\n' <"$changed" >&2
  # 改动列表为空按非纯文档处理，宁可多跑
  if [ -s "$changed" ]; then
    docs_only=true
    while IFS= read -r -d '' f; do
      case "$f" in
        # F-573：后端源码或路由策略证据支撑代码有改动，F090b 登记 / 锚点可能失配（#783 / #790 / #794 / #796）
        apps/api/src/* | tests/acceptance/support/route-policy/*) evidence_hit=true ;;
      esac
      case "$f" in
        .github/*) docs_only=false ;;
        *.md) ;;
        # docs/ reference/ .claude/ 下只有图片和纯文本资料算文档；
        # 脚本、json、html、yml 等（如 docs/10_进度/watch.py）不算
        docs/* | reference/* | .claude/*)
          case "$f" in
            *.png | *.jpg | *.jpeg | *.gif | *.svg | *.webp | *.txt | *.tsv) ;;
            *) docs_only=false ;;
          esac
          ;;
        *) docs_only=false ;;
      esac
    done <"$changed"
  else
    evidence_hit=true
  fi
else
  # git 本身出错（如缺父提交）时按非纯文档处理，宁可多跑
  echo "::warning::git diff 失败，按非纯文档处理" >&2
  evidence_hit=true
fi

# 判定 mode；纯文档（只会出现在 main 目标）与 full 不需要快检
if [ "$non_main" = true ]; then
  mode=light
elif [ "$docs_only" = true ]; then
  mode=docs
elif [ "$QUEUE_HEAD" = true ]; then
  mode=full
else
  mode=light
fi

if [ "$mode" = light ] && [ "$evidence_hit" = true ]; then
  echo "evidence_check=true"
else
  echo "evidence_check=false"
fi
echo "mode=$mode"
