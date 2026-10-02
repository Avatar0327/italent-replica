#!/usr/bin/env bash
# 云端开发容器初始化（Ubuntu 24.04；Claude Code 云端 / Codex universal 通用）
# 依据：docs/07_M0/02_技术栈评估.md §7。环境设置里只写一行：bash scripts/cloud-setup.sh
# 原则：只在 setup 阶段联网；之后测试全部离线。脚本可重复执行（幂等）。
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

# 1) Node：要求 >=22.12；Codex 在环境设置「Preinstalled packages」里选 Node 22（CODEX_ENV_ 前缀是保留变量，不能手填），Claude 默认 22
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || { echo "Node 版本过低：$(node -v)，需要 >=22.12"; exit 1; }

# 2) pnpm：按 package.json 的 packageManager 字段锁定版本
PNPM_VERSION="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
corepack enable >/dev/null 2>&1 || true
if [ "$(pnpm --version 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 || npm i -g "pnpm@${PNPM_VERSION}"
fi
echo "node $(node -v) / pnpm $(pnpm --version)"

# 3) PostgreSQL 16：Claude 已预装；未装则安装（Ubuntu 24.04 官方源即 16，含 btree_gist 所在的 contrib）
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq postgresql postgresql-contrib
fi

# 4) 依赖（PGlite 的 WASM 随 npm 包下载，之后离线可用）
# 网络偶发卡住（Codex 曾停在 downloaded 0 超过 50 分钟）：限时 + 重试，失败就报错而不是无限等待
for attempt in 1 2 3; do
  if timeout 600 pnpm install --frozen-lockfile --fetch-timeout=60000 --fetch-retries=5 --network-concurrency=8; then
    break
  fi
  echo "pnpm install 第 ${attempt} 次失败或超时，重试…"
  [ "$attempt" -eq 3 ] && { echo "pnpm install 连续 3 次失败"; exit 1; }
done

# 5) 启动 PG 并创建测试库与角色（幂等）；缓存快照不保留进程，test:pg 会再次调用
bash scripts/dev-db.sh

# 6) 预热：编译检查一次，让 tsc/vite 缓存进入快照
pnpm typecheck

echo "setup 完成。离线测试：pnpm test；真 PG 测试：pnpm test:pg；全部：bash scripts/test-all.sh"
