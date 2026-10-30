/**
 * 审批主体组织与调整范围所选组织的“生效日存在且启用”判定（R2-T08 §2.1A）。
 * 取每个组织在生效日的现行版本（开始日不晚于生效日的最新版本），须启用且结束日不早于生效日；不存在 / 未成立 / 停用都算不可用。
 * 范围包含判定 `assertInAdjustmentRange`（§5.6）随明细写入落在 10b2，本片不涉及。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { rowsOf } from '../org/read-model.js';

export const ORG_INACTIVE = 'ORG_ADJUSTMENT_ORG_INACTIVE';

/** 返回不可用的组织（按入参顺序、去重）。 */
export async function inactiveOrgs(
  tx: Tx,
  tenantId: string,
  orgIds: readonly string[],
  asOf: string,
): Promise<string[]> {
  const ids = [...new Set(orgIds)];
  if (ids.length === 0) return [];
  const rows = rowsOf<{ org_id: string; enabled: boolean; stop_date: string }>(
    await tx.execute(sql`
      SELECT DISTINCT ON (org_id) org_id, enabled, stop_date::text AS stop_date FROM org_versions
      WHERE tenant_id = ${tenantId} AND org_id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND start_date <= ${asOf}::date
      ORDER BY org_id, start_date DESC, version_no DESC`),
  );
  const active = new Set(rows.filter((row) => row.enabled && row.stop_date >= asOf).map((row) => row.org_id));
  return ids.filter((id) => !active.has(id));
}

export async function assertOrgsActive(tx: Tx, tenantId: string, orgIds: readonly string[], asOf: string) {
  const inactive = await inactiveOrgs(tx, tenantId, orgIds, asOf);
  if (inactive.length > 0) {
    throw new AppError('VALIDATION_FAILED', '审批主体组织或调整范围在生效日不存在或已停用', {
      reason: ORG_INACTIVE,
      orgIds: inactive,
    });
  }
}
