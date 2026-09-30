/**
 * 两条数据库访问路径（硬规则 7；docs/08_设计/R1-T00_多租户底座设计.md §3）：
 * - 租户路径 withTenant：一个事务内 SET LOCAL ROLE app_user + app.tenant_id，所有带 tenant_id 的表由 RLS 过滤；
 * - 平台路径 withPlatform：一个事务内 SET LOCAL ROLE app_platform，只能访问平台级表（租户、用户、系统预置）。
 * 两者都用事务级设置（SET LOCAL / set_config(..., true)），事务结束即还原，连接池复用安全。
 * 业务代码不得直接用连接角色（可能是表属主或超级用户）读写业务表。
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export const APP_ROLE = { tenant: 'app_user', platform: 'app_platform' } as const;

/** 事务句柄；与 Db 同样的查询接口。 */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** 在指定租户上下文中执行 fn。租户 ID 不合法直接抛错（fail-closed），不会退化成“不过滤”。 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(tenantId)) throw new TypeError('withTenant：租户 ID 必须是 UUID');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.tenant}`));
    return fn(tx);
  });
}

/**
 * 平台路径：开租户、读用户与租户状态、维护系统预置。显式清空 app.tenant_id，
 * 且 app_platform 对租户数据表无任何权限——平台方要写租户数据时，必须显式走 withTenant。
 */
export async function withPlatform<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', '', true)`);
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE.platform}`));
    return fn(tx);
  });
}
