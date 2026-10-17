#!/usr/bin/env bash
# 启动容器内本地 PostgreSQL 16，幂等创建测试角色与测试库，并清理残留测试库（docs/07_M0/02_技术栈评估.md §7）。
# 口令仅用于容器内一次性测试库；生产口令走平台 Secret。
# 最后一行输出 TEST_DATABASE_URL=...，供 scripts/test-pg.sh 读取。
set -euo pipefail
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
# 以 postgres 身份执行：非 root 用 sudo -u，root（云端容器）用 runuser -u
if [ -n "$SUDO" ]; then AS_PG=(sudo -u postgres); else AS_PG=(runuser -u postgres --); fi
PSQL=("${AS_PG[@]}" psql -v ON_ERROR_STOP=1 -qtA)

if ! pg_isready -q -h localhost; then
  # 后台数据库进程不得继承本脚本的 stdout/stderr，否则云端 setup 会一直等待输出关闭直到超时
  $SUDO service postgresql start >/dev/null 2>&1 </dev/null \
    || $SUDO pg_ctlcluster 16 main start >/dev/null 2>&1 </dev/null
fi
until pg_isready -q -h localhost; do sleep 0.5; done

# 角色与授权（app / app_owner / app_user / app_platform、内建角色授权、模板库扩展）的唯一定义在 scripts/pg-roles.sql，
# CI 的普通角色分片也用同一份（F-212）；经 stdin 传入，postgres 系统用户不必能读仓库目录
"${AS_PG[@]}" psql -v ON_ERROR_STOP=1 -qtA <"$(dirname "$0")/pg-roles.sql"
"${PSQL[@]}" -c "SELECT 1 FROM pg_database WHERE datname='italent_test'" | grep -q 1 \
  || "${AS_PG[@]}" createdb -O app_owner italent_test
"${PSQL[@]}" -d italent_test -c "CREATE EXTENSION IF NOT EXISTS btree_gist"

# 清理残留测试库（只删 testkit 命名的 italent_t_<32 位十六进制>）：测试进程被中断时 afterAll 不执行，
# 残留库越多 autovacuum 越忙。有 app_owner 会话或测试库有客户端连接（另一轮测试正在跑）时整体跳过；
# 库清单与会话检查在同一条语句里，清单里在用的库，其建库连接必然还在。不加 FORCE，删不掉就留到下次。
"${PSQL[@]}" -v ON_ERROR_STOP=0 <<'SQL'
SELECT format('DROP DATABASE IF EXISTS %I', d.datname) FROM pg_database d
WHERE d.datname ~ '^italent_t_[0-9a-f]{32}$'
  AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.backend_type = 'client backend'
                  AND (a.usename = 'app_owner' OR a.datname ~ '^italent_t_'))
\gexec
SQL

echo "DATABASE_URL=postgres://app:app@localhost:5432/italent_test"
echo "TEST_DATABASE_URL=postgres://app_owner:app_owner@localhost:5432/italent_test"
