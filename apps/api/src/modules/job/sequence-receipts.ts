/** DEC-177 / 178：历史回执也必须按读取时的任职范围及字段权限裁剪。 */
import { sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { employmentCreator } from '../employment/context.js';
import { employmentVisibilitySql } from '../employment/visibility.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { rowsOf } from './store.js';

export interface SequenceReceipt {
  recipientUserId: string;
  channel: string;
  taskId: string;
  count: number;
  skipped: { recordId: string; reason: string }[];
  warnings?: { recordId: string; reason: 'ESTABLISHMENT_EXCEEDED' }[];
}

export async function visibleSequenceReceipts(
  tx: Tx,
  deps: TenantRouteDeps,
  ctx: TenantContext,
  receipts: readonly SequenceReceipt[],
): Promise<SequenceReceipt[]> {
  if (!receipts.length) return [];
  const code = MODULE_OBJECTS.employmentRecord.code;
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, code, tx);
  const canView = await authorizeInTransaction(
    deps.authorize,
    tx,
  )({
    ...ctx,
    action: 'object.view',
    resource: code,
    fields: [],
  });
  const visible = new Map<string, Set<string>>();
  // UNCHANGED 同样揭示序列关系，recordId 也须任职 id 查看权；不完整可见的回执行整体裁剪。
  if (canView && (!fields || (fields.has('sequenceId') && fields.has('id')))) {
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, code);
    const taskIds = [...new Set(receipts.map((receipt) => receipt.taskId))];
    const rows = rowsOf<{ taskId: string; recordId: string }>(
      await tx.execute(sql`
      SELECT o.id AS "taskId", b.id AS "recordId"
      FROM employment_outbox o
      CROSS JOIN LATERAL jsonb_array_elements_text(o.payload->'after'->'targetIds') target(id)
      JOIN employment_business_objects b ON b.tenant_id=o.tenant_id AND b.id=target.id::uuid
      LEFT JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.id=b.id
      LEFT JOIN LATERAL (
        SELECT p.id,p.department_id FROM employment_payload_versions p
        WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id
          AND (r.id IS NULL OR p.is_record_snapshot)
        ORDER BY p.version_no DESC LIMIT 1
      ) current_payload ON true
      WHERE o.tenant_id=${ctx.tenantId} AND o.id=ANY(${`{${taskIds.join(',')}}`}::uuid[])
        AND o.event_type='job.sequence-sync.requested'
        AND o.payload->'after'->>'recipientUserId'=${ctx.userId}
        AND ${employmentVisibilitySql(scope, {
          employee: sql`b.employee_id`,
          // 与任职详情一致：生效记录用最新完整快照，审批业务用最新载荷；显式清空部门不能回退原值。
          department: sql`CASE WHEN current_payload.id IS NOT NULL
            THEN current_payload.department_id ELSE r.department_id END`,
          creator: employmentCreator(ctx.tenantId, sql`b.id`, true),
        })}
    `),
    );
    for (const row of rows) {
      const ids = visible.get(row.taskId) ?? new Set<string>();
      ids.add(row.recordId);
      visible.set(row.taskId, ids);
    }
  }
  return receipts.map((receipt) => {
    const ids = visible.get(receipt.taskId) ?? new Set<string>();
    const skipped = receipt.skipped.filter((row) => ids.has(row.recordId));
    const skippedIds = new Set(skipped.map((row) => row.recordId));
    // 冻结引用集合中每条都有执行结果；不在 skipped 中的才实际追加过版本。
    // 从请求目标推导，兼容修复前已完成的任务；不依赖审计保留期，也不重新判断历史执行结果。
    return {
      recipientUserId: ctx.userId,
      channel: receipt.channel,
      taskId: receipt.taskId,
      count: [...ids].filter((id) => !skippedIds.has(id)).length,
      skipped,
      ...(receipt.warnings ? { warnings: receipt.warnings.filter((row) => ids.has(row.recordId)) } : {}),
    };
  });
}
