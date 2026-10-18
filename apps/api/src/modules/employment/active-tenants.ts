import { sql, withPlatform, type Db } from '@italent/db';
import { rowsOf } from './record-store.js';

const TENANT_PAGE = 100;

export interface TenantRow {
  readonly id: string;
  readonly timezone: string;
}

/**
 * 定时任务遍历的租户（定时生效、BE-15a 自动转正共用）：只运行启用中的租户，停用、恢复隔离中的租户（DEC-061）
 * 不落地任何业务。只读平台表，业务查询由调用方切到租户路径（withTenant + RLS）。
 */
export async function* activeTenants(db: Db, tenantId: string | null): AsyncGenerator<TenantRow> {
  let after: string | null = null;
  for (;;) {
    const page: TenantRow[] = await withPlatform(db, async (tx) =>
      rowsOf<TenantRow>(
        await tx.execute(sql`SELECT id::text, timezone FROM tenants WHERE status='active'
          AND (${tenantId}::uuid IS NULL OR id=${tenantId}::uuid)
          AND (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${TENANT_PAGE}`),
      ),
    );
    yield* page;
    if (page.length < TENANT_PAGE) return;
    after = page.at(-1)!.id;
  }
}
