#!/usr/bin/env bash
# 先跑离线测试（PGlite），再在有真 PG 的环境里跑 test:pg。
set -euo pipefail
cd "$(dirname "$0")/.."
env -u TEST_DATABASE_URL pnpm test
if [ -n "${TEST_DATABASE_URL:-}" ] || command -v pg_ctlcluster >/dev/null 2>&1; then
  pnpm test:pg
else
  echo "未检测到真 PostgreSQL（无 TEST_DATABASE_URL、无 pg_ctlcluster），跳过 test:pg"
fi
