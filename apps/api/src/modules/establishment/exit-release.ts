/**
 * 离职 / 退休“批准即预减”的记账层（R2-T03 设计 §6-2，DEC-266①）：在 confirmed 阶段（审批通过 / 直接离职保存）
 * 按 R 记一条 exit_effects(establishment_pre_released)。只记账：不追加编制版本、不改调编分配、不取编制锁；
 * 预减投影（pendingExits，§6-1）随 B3-3 上线，这里的台账行是投影与撤销清单的输入。
 */
import { randomUUID } from 'node:crypto';
import { and, eq, exitEffects, sql, type Tx } from '@italent/db';
import type { EmploymentContext } from '../employment/types.js';
import { rowsOf } from './store.js';

export interface PreReleaseTarget {
  readonly businessId: string;
  readonly employeeId: string;
  readonly departmentId: string | null;
  readonly positionId: string | null;
  /** R：审批通过 / 直接离职确认的租户日（迟到顺延不改它）。 */
  readonly releasedFrom: string;
  /** E：计划生效日（最后工作日 + 1）。 */
  readonly plannedEffectiveDate: string;
}

/** 部门在 R 当天所在的编制周期（每个编制方案一条）；没有维护编制时返回空。 */
async function capacitiesOn(tx: Tx, tenantId: string, departmentId: string | null, date: string) {
  if (!departmentId) return [];
  return rowsOf<{ id: string }>(
    await tx.execute(sql`SELECT id FROM establishment_objects WHERE tenant_id=${tenantId}
      AND org_id=${departmentId}::uuid AND period_start <= ${date}::date AND period_end >= ${date}::date
      ORDER BY scheme_id, id`),
  );
}

/**
 * 每个编制周期一行（target = 该周期）；部门没有编制时也记一行（capacityId 为空），R 总有台账可查。
 * 幂等：同业务 + phase + kind 已有台账则不再写（重放、重试不重复记，设计 §2.1 exit_effects 用途①）。
 */
export async function registerEstablishmentPreRelease(tx: Tx, ctx: EmploymentContext, target: PreReleaseTarget) {
  const existing = await tx
    .select({ id: exitEffects.id })
    .from(exitEffects)
    .where(
      and(
        eq(exitEffects.tenantId, ctx.tenantId),
        eq(exitEffects.businessId, target.businessId),
        eq(exitEffects.phase, 'confirmed'),
        eq(exitEffects.kind, 'establishment_pre_released'),
      ),
    )
    .limit(1);
  if (existing.length) return [];
  const { businessId, employeeId, departmentId, positionId, releasedFrom, plannedEffectiveDate } = target;
  const capacities = await capacitiesOn(tx, ctx.tenantId, departmentId, releasedFrom);
  const rows = (capacities.length ? capacities.map((row) => row.id) : [null]).map((capacityId) => ({
    id: randomUUID(),
    tenantId: ctx.tenantId,
    businessId,
    employeeId,
    phase: 'confirmed',
    kind: 'establishment_pre_released',
    targetType: 'establishment-capacity',
    targetId: capacityId,
    detail: { departmentId, positionId, capacityId, releasedFrom, plannedEffectiveDate },
    commandId: ctx.commandId,
    createdAt: ctx.now,
  }));
  await tx.insert(exitEffects).values(rows);
  return rows.map((row) => row.detail);
}
