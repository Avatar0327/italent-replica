-- 测试用 PostgreSQL 的角色与授权，唯一定义处（F-212，DEC-568）。
-- 两个入口共用，不得各自复制：本地 scripts/dev-db.sh；CI 的普通角色分片（scripts/ci-postgres.sh，PG_APP_ROLE=1）。
-- 须以超级用户执行，可重复执行。口令仅用于容器内一次性测试库；生产口令走平台 Secret。
--
-- app：运行时角色（非超级用户、不绕过 RLS）；app_owner：迁移与测试建库角色，非超级用户、NOBYPASSRLS，
-- 租户表都是 FORCE ROW LEVEL SECURITY，故没设租户上下文的读写在该角色下一律看不到行 / 被拒。
-- 超级用户连接会绕过 RLS，把“测试里漏了 withTenant”这类问题掩盖掉（DEC-568）。
\set ON_ERROR_STOP on

SELECT 'CREATE ROLE app LOGIN PASSWORD ''app'' NOSUPERUSER NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')
\gexec
SELECT 'CREATE ROLE app_owner LOGIN PASSWORD ''app_owner'' NOSUPERUSER NOBYPASSRLS CREATEDB'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_owner')
\gexec

-- 租户路径 / 平台路径角色（R1-T00，迁移 0003）：集群级对象，由超级用户预建；
-- 迁移角色 app_owner 与运行时角色 app 都须是其成员，才能在事务内 SET LOCAL ROLE
SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS', r)
FROM (VALUES ('app_user'), ('app_platform')) AS v(r)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v.r)
\gexec
GRANT app_user, app_platform TO app_owner, app;

-- 测试库在 afterAll 用 DROP DATABASE … WITH (FORCE) 删除（packages/testkit/src/test-db.ts），FORCE 要终止库内
-- 所有进程；碰上 autovacuum worker 时，非超级用户须有 pg_signal_backend，否则报“permission denied to
-- terminate process”，测试文件失败并残留库。只授这一个内建角色，不把 app_owner 提升为超级用户。
GRANT pg_signal_backend TO app_owner;
-- F-082 部署检查脚本（scripts/check-deploy-target.mjs）要求检查账号能看全其他会话（超级用户或 pg_read_all_stats），
-- 看不全就判失败。本脚本的测试账号不是超级用户，授予这一个内建只读角色，让真 PG 用例与超级用户连接等价。
GRANT pg_read_all_stats TO app_owner;

-- 测试管理库（建库命令所连的库）归 app_owner，已存在时（CI 容器由 POSTGRES_DB 建出，属主是 postgres）也改过来
SELECT 'ALTER DATABASE italent_test OWNER TO app_owner'
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = 'italent_test')
\gexec

-- 在模板库装好扩展，测试时新建的库自动带上（btree_gist 是可信扩展，库属主也可自行创建）
\connect template1
CREATE EXTENSION IF NOT EXISTS btree_gist;
