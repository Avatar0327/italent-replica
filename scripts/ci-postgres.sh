#!/usr/bin/env bash
# CI 专用：启动 PostgreSQL 16 测试容器（DEC-431④），供 .github/workflows/ci.yml 的 PG job 调用。
# 不用 services：services 拉取失败无法换源，Docker Hub / AWS 公共镜像源限流（toomanyrequests）时整片 17 秒即红。
# 这里按顺序尝试：本仓库 ghcr 镜像（pg-image-mirror.yml 每周刷新）→ AWS 公共镜像源 → Docker Hub，
# 每轮全部失败后退避重试。ghcr 镜像尚未建立（首次运行）或拉取失败时自动落到后两个源。
# max_locks_per_transaction=256 沿用 #250：整库迁移 / 恢复单事务锁的表超过默认 64（53200 out of shared memory）。
# 口令仅用于 CI 一次性容器，非机密；连接串与原 services 一致：
#   postgres://postgres:postgres@localhost:5432/italent_test
set -euo pipefail

NAME="${PG_CONTAINER_NAME:-postgres}"
# 与 .github/workflows/pg-image-mirror.yml 的 UPSTREAM / MIRROR 保持一致
MIRROR="${PG_IMAGE_MIRROR:-ghcr.io/avatar0327/italent-replica/postgres:16}"
UPSTREAM="public.ecr.aws/docker/library/postgres:16"
DOCKER_HUB="docker.io/library/postgres:16"

image=""
for attempt in 1 2 3; do
  for candidate in "$MIRROR" "$UPSTREAM" "$DOCKER_HUB"; do
    if timeout 180 docker pull --quiet "$candidate"; then
      image="$candidate"
      break 2
    fi
    echo "::warning::拉取 $candidate 失败（第 $attempt 轮）"
  done
  sleep $((attempt * 10))
done
if [ -z "$image" ]; then
  echo "::error::三个镜像源均拉取失败" >&2
  exit 1
fi
echo "使用镜像：$image（$(docker image inspect --format '{{index .RepoDigests 0}}' "$image" 2>/dev/null || true)）"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "PostgreSQL 镜像：\`$image\`" >>"$GITHUB_STEP_SUMMARY"
fi

# 健康检查走 TCP（-h 127.0.0.1）：初始化期间的临时实例只听 unix socket，避免“初始化未完成就判健康”
docker run -d --name "$NAME" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=italent_test \
  -p 5432:5432 \
  --health-cmd "pg_isready -h 127.0.0.1 -U postgres" \
  --health-interval 5s \
  --health-timeout 5s \
  --health-retries 10 \
  "$image" -c max_locks_per_transaction=256 >/dev/null

for _ in $(seq 1 90); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$NAME")"
  [ "$status" = healthy ] && break
  if [ "$status" = unhealthy ]; then break; fi
  sleep 1
done
if [ "$status" != healthy ]; then
  echo "::error::PostgreSQL 容器未通过健康检查（$status）" >&2
  docker logs "$NAME" >&2 || true
  exit 1
fi

locks="$(docker exec "$NAME" psql -U postgres -tAc "SHOW max_locks_per_transaction")"
echo "max_locks_per_transaction=$locks"
test "$locks" = 256

# F-212（DEC-568）：普通角色分片设 PG_APP_ROLE=1，建出与本地 dev-db.sh 同一份的 app_owner 等角色（scripts/pg-roles.sql）。
# 测试连接串改用 app_owner（非超级用户、NOBYPASSRLS）：租户表 FORCE RLS，漏设租户上下文的用例在这里才会红。
# 口令仅用于 CI 一次性容器，非机密；连接串：postgres://app_owner:app_owner@localhost:5432/italent_test
if [ "${PG_APP_ROLE:-}" = 1 ]; then
  docker exec -i "$NAME" psql -U postgres -d italent_test -v ON_ERROR_STOP=1 -q <"$(dirname "$0")/pg-roles.sql"
  # 连接串真的落在普通角色上才放行，避免配置漂移后悄悄退回超级用户（与 tests/acceptance/AC-CI-F212-app-role.test.ts 双重把关）
  bypass="$(docker exec -e PGPASSWORD=app_owner "$NAME" psql -h 127.0.0.1 -U app_owner -d italent_test -tAc \
    "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")"
  test "$bypass" = f
  echo "普通角色 app_owner 就绪（非超级用户、不绕过 RLS）"
fi
