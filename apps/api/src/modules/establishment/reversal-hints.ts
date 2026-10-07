/**
 * DEC-273：服务端间接触发的回退（撤权 / 停用 / 移出成员、异常管理员交接合席）造成原部门超编时不阻断，
 * 响应附一条不阻断的提示。提示从本命令写下的超编警告审计派生，并按操作人的可见范围裁剪：
 * 看不到该任职业务的只给概括提示（businessId 为空），编制范围不覆盖的部门不列出。
 */
import { sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { visibleEmploymentRecords } from '../employment/visibility.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction } from '../permission/module-access.js';
import { ESTABLISHMENT_REVERSAL_AUDIT } from './restored-occupancy.js';
import { rowsOf } from './store.js';

export interface ReversalWarningHint {
  readonly reason: 'ESTABLISHMENT_EXCEEDED';
  /** 操作人看不到该任职业务时为空。 */
  readonly businessId: string | null;
  /** 被判超编的部门，只列操作人编制范围内的。 */
  readonly departmentIds: readonly string[];
}

interface AuditRow {
  readonly businessId: string;
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly segments: { departmentId?: string | null }[] | null;
}

export async function reversalWarningHints(
  tx: Tx,
  deps: Pick<TenantRouteDeps, 'authorize' | 'clock'>,
  ctx: TenantContext,
  commandId: string,
): Promise<ReversalWarningHint[]> {
  const rows = rowsOf<AuditRow>(
    await tx.execute(sql`
    SELECT b.id AS "businessId", b.employee_id AS "employeeId", e.after->'segments' AS segments,
      (SELECT p.department_id FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY p.version_no DESC LIMIT 1) AS "departmentId"
    FROM audit_events e JOIN employment_business_objects b ON b.tenant_id=e.tenant_id AND b.id=e.object_id::uuid
    WHERE e.tenant_id=${ctx.tenantId} AND e.command_id=${commandId} AND e.action=${ESTABLISHMENT_REVERSAL_AUDIT}
    ORDER BY e.occurred_at, e.id`),
  );
  if (!rows.length) return [];
  const authorize = authorizeInTransaction(deps.authorize, tx);
  const canView = (resource: string) => authorize({ ...ctx, action: 'object.view', resource, fields: [] });
  const employment = MODULE_OBJECTS.employmentRecord.code;
  const businessVisible = (await canView(employment))
    ? await visibleEmploymentRecords(
        tx,
        ctx.tenantId,
        await resolveModuleScopeInTransaction(deps, ctx, tx, employment),
        rows.map((row) => ({ employeeId: row.employeeId, departmentId: row.departmentId })),
      )
    : rows.map(() => false);
  const establishment = MODULE_OBJECTS.establishment.code;
  const scope = (await canView(establishment))
    ? await resolveModuleScopeInTransaction(deps, ctx, tx, establishment)
    : null;
  const orgVisible = (id: string) =>
    scope !== null && scope.hasDataPermission && (scope.all || scope.orgIds.includes(id));
  return rows.map((row, index) => ({
    reason: 'ESTABLISHMENT_EXCEEDED',
    businessId: businessVisible[index] ? row.businessId : null,
    departmentIds: [
      ...new Set(
        (row.segments ?? [])
          .map((segment) => segment.departmentId)
          .filter((id): id is string => typeof id === 'string' && orgVisible(id)),
      ),
    ],
  }));
}
