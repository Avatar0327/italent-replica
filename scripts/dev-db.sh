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

# app：运行时角色（非超级用户、不绕过 RLS）；app_owner：迁移与测试建库角色
"${PSQL[@]}" -c "SELECT 1 FROM pg_roles WHERE rolname='app'" | grep -q 1 \
  || "${PSQL[@]}" -c "CREATE ROLE app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS"
"${PSQL[@]}" -c "SELECT 1 FROM pg_roles WHERE rolname='app_owner'" | grep -q 1 \
  || "${PSQL[@]}" -c "CREATE ROLE app_owner LOGIN PASSWORD 'app_owner' CREATEDB"
# 租户路径 / 平台路径角色（R1-T00，迁移 0003）：集群级对象，由超级用户预建；
# 迁移角色 app_owner 与运行时角色 app 都须是其成员，才能在事务内 SET LOCAL ROLE
for role in app_user app_platform; do
  "${PSQL[@]}" -c "SELECT 1 FROM pg_roles WHERE rolname='$role'" | grep -q 1 \
    || "${PSQL[@]}" -c "CREATE ROLE $role NOLOGIN NOSUPERUSER NOBYPASSRLS"
done
"${PSQL[@]}" -c "GRANT app_user, app_platform TO app_owner, app"
# 测试库在 afterAll 用 DROP DATABASE … WITH (FORCE) 删除（packages/testkit/src/test-db.ts），FORCE 要终止库内
# 所有进程；碰上 autovacuum worker 时，非超级用户须有 pg_signal_backend，否则报“permission denied to
# terminate process”，测试文件失败并残留库。只授这一个内建角色，不把 app_owner 提升为超级用户。
"${PSQL[@]}" -c "GRANT pg_signal_backend TO app_owner"
# F-082 部署检查脚本（scripts/check-deploy-target.mjs）要求检查账号能看全其他会话（超级用户或 pg_read_all_stats），
# 看不全就判失败。CI 的测试账号是超级用户；本地测试账号同样授予这一个内建只读角色，让真 PG 用例与 CI 等价。
"${PSQL[@]}" -c "GRANT pg_read_all_stats TO app_owner"
"${PSQL[@]}" -c "SELECT 1 FROM pg_database WHERE datname='italent_test'" | grep -q 1 \
  || "${AS_PG[@]}" createdb -O app_owner italent_test
# 在模板库装好扩展，测试时新建的库自动带上（btree_gist 是可信扩展，库属主也可自行创建）
"${PSQL[@]}" -d template1 -c "CREATE EXTENSION IF NOT EXISTS btree_gist"
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
