/**
 * F-493 S3b：导入执行期复核提交者的权限（设计 §6.3、§16 A9）。
 * 提交时判过的权限，执行时（可能是几分钟后、也可能是租约接管后的几小时）按当前授权再判一遍，口径与提交完全相同：
 * 租户成员资格仍有效，且 exitImportGuard（导入按钮、人员新增权、任职 / 档案 / 教育字段写权、显式“看全部”范围）通过。
 * 不降级成“只看成员资格”：撤销写权也算撤权。
 */
import { exitImportRows, sql, withTenant, type Db } from '@italent/db';
import { and, asc, eq } from 'drizzle-orm';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import { contextOf } from './context.js';
import type { TenantRow } from './active-tenants.js';
import { rowsOf } from './record-store.js';
import type { ImportRowInput } from './exit-import-shape.js';
import { exitImportGuard } from './replay-guard.js';

/**
 * 提交者仍被允许继续执行本批返回 true；明确被拒（403，含成员资格失效）返回 false；
 * 其余失败（库不可用等）照常抛出，按系统故障重试，不把一次抖动当成撤权。
 */
export async function submitterStillAllowed(
  db: Db,
  tenant: TenantRow,
  batchId: string,
  submittedBy: string,
  authorize: Authorizer,
  clock: () => Date,
): Promise<boolean> {
  const member = await withTenant(db, tenant.id, async (tx) =>
    rowsOf(
      await tx.execute(sql`SELECT 1 FROM tenant_memberships WHERE tenant_id=${tenant.id}
        AND user_id=${submittedBy}::uuid AND status='active'`),
    ),
  );
  if (!member.length) return false;
  const deps = { db, authorize, clock };
  try {
    const ctx = await contextOf(
      { tenantId: tenant.id, userId: submittedBy, timezone: tenant.timezone },
      deps,
      'object.create',
    );
    const rows = await withTenant(
      db,
      tenant.id,
      (tx) =>
        tx
          .select()
          .from(exitImportRows)
          .where(and(eq(exitImportRows.tenantId, tenant.id), eq(exitImportRows.batchId, batchId)))
          .orderBy(asc(exitImportRows.rowNo)) as unknown as Promise<ImportRowInput[]>,
    );
    await withTenant(db, tenant.id, (tx) => exitImportGuard(deps, ctx, rows).before(tx));
    return true;
  } catch (error) {
    if (error instanceof AppError && error.status === 403) return false;
    throw error;
  }
}
