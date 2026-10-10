/** 凭据维护任务与运维命令遍历租户：平台路径只读租户表，数据操作逐租户走 withTenant（RLS）。 */
import { type Db, sql, withPlatform } from '@italent/db';

const PAGE = 100;

/** 启用与停用中的租户（恢复中的不动）；tenantId 给定时只取该租户。 */
export async function* tenantIds(db: Db, only?: string): AsyncGenerator<string> {
  let after: string | null = null;
  for (;;) {
    const page: string[] = await withPlatform(db, async (tx) => {
      const result = await tx.execute(sql`SELECT id::text AS id FROM tenants
        WHERE status IN ('active', 'suspended') AND (${only ?? null}::uuid IS NULL OR id = ${only ?? null}::uuid)
          AND (${after}::uuid IS NULL OR id > ${after}::uuid) ORDER BY id LIMIT ${PAGE}`);
      return ((Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as { id: string }[]).map(
        (row) => row.id,
      );
    });
    yield* page;
    if (page.length < PAGE) return;
    after = page.at(-1) ?? null;
  }
}
