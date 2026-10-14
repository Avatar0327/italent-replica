/** C2-1a 终止唯一内核（设计 §3.5；P2-05）：调用方负责活动/员工级准入，本内核不按操作者范围跳过人员。 */
import { sql, type Tx } from '@italent/db';
import { EVALUATION_FLOW_AUDIT_ACTIONS, EVALUATION_FLOW_OBJECTS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';
import { type EvaluationContext, rowsOf } from './access.js';
import { view } from './read-model.js';
export { isInProgress } from '@italent/domain';

/** SQL 与纯函数表达同一终态补集；nullable 的后续阶段必须用 DISTINCT FROM。 */
export function inProgressSql(alias = 'e') {
  const column = (name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  return sql`${column('terminated_at')} IS NULL AND ${column('apply_status')} <> 'failed'
    AND ${column('result_status')} IS DISTINCT FROM 'published'`;
}
export type TerminationReason = 'leave' | 'activity_completed' | 'revoked';

export async function registerNotification(
  tx: Tx,
  ctx: EvaluationContext,
  notice: {
    activityId: string;
    evaluationId?: string;
    employeeId?: string;
    kind: string;
    templateCode?: string | null;
    dedupeKey: string;
  },
): Promise<void> {
  await tx.execute(sql`INSERT INTO ev_notifications
    (tenant_id, activity_id, staff_evaluation_id, recipient_employee_id, kind, template_code, dedupe_key, created_at)
    VALUES (${ctx.tenantId}::uuid, ${notice.activityId}::uuid, ${notice.evaluationId ?? null}::uuid,
      ${notice.employeeId ?? null}::uuid, ${notice.kind}, ${notice.templateCode ?? null}, ${notice.dedupeKey},
      ${ctx.now.toISOString()}::timestamptz) ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`);
}

/** 上层按员工 → 活动 → 评定取锁；本内核按 ID 锁评定，锁后重新判断，终态与重复调用不写审计。 */
export async function terminateEvaluations(
  tx: Tx,
  ctx: EvaluationContext,
  ids: readonly string[],
  reason: TerminationReason,
  terminatedAt: Date = ctx.now,
): Promise<string[]> {
  if (!ids.length) return [];
  const selected = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`SELECT e.* FROM ev_staff_evaluations e
    WHERE e.tenant_id=${ctx.tenantId}::uuid AND e.id=ANY(${`{${[...new Set(ids)].join(',')}}`}::uuid[])
      AND ${inProgressSql('e')} ORDER BY e.id FOR UPDATE`),
  );
  for (const row of selected) {
    // C2-3 在此补入在途审批 cancel；C2-1a 尚无审批创建入口。
    const after = rowsOf<Record<string, unknown>>(
      await tx.execute(sql`UPDATE ev_staff_evaluations
      SET terminated_at=${terminatedAt.toISOString()}::timestamptz, terminated_reason=${reason},
        revision=revision+1, updated_at=${ctx.now.toISOString()}::timestamptz
      WHERE tenant_id=${ctx.tenantId}::uuid AND id=${row.id}::uuid RETURNING *`),
    )[0]!;
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorUserId: auditActor(ctx.userId),
      action: `${EVALUATION_FLOW_AUDIT_ACTIONS.staffEvaluation}.terminate`,
      objectType: EVALUATION_FLOW_OBJECTS.staffEvaluation.code,
      objectId: row.id as string,
      before: view(row),
      after: view(after),
      commandId: ctx.commandId,
      occurredAt: ctx.now,
      scope: { employeeId: row.employee_id as string },
    });
    await registerNotification(tx, ctx, {
      activityId: row.activity_id as string,
      evaluationId: row.id as string,
      employeeId: row.employee_id as string,
      kind: 'terminated',
      dedupeKey: `terminated:${row.id}`,
    });
  }
  return selected.map((row) => row.id as string);
}
