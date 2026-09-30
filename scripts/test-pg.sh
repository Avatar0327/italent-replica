#!/usr/bin/env bash
# pnpm test:pg：在真 PostgreSQL 上跑全部测试。
# 已设置 TEST_DATABASE_URL（如 CI 的 postgres service）则直接用；否则调用 dev-db.sh 启动容器内 PG。
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  if ! command -v pg_isready >/dev/null 2>&1; then
    echo "未设置 TEST_DATABASE_URL，且本机没有 PostgreSQL（可先运行 bash scripts/cloud-setup.sh）" >&2
    exit 1
  fi
  TEST_DATABASE_URL="$(bash scripts/dev-db.sh | sed -n 's/^TEST_DATABASE_URL=//p')"
fi
export TEST_DATABASE_URL
exec pnpm exec vitest run "$@"
