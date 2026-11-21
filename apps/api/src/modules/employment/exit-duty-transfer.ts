/**
 * 离职职责转交（R2-T03 设计 §5.7，DEC-213；原 BE-9 并入 B3-2）：执行复用 transfer/linkage 的 applyDutyTransfer
 * （只建职责子项，每个子项自己的保存点，失败只记 duty_failed、可重试），这里按时机配置决定在哪个阶段调用并写离职台账：
 * business_effective → 离职落地（activateExit 步骤 6，生效日 = 最终生效日 E′）；
 * approval_passed → confirmed 阶段（审批通过 / 直接离职保存，生效日 = 当天；确认阶段已过去的由落地阶段兜底）。
 * 同一离职至多执行一次（联动执行行幂等）。
 */
import { exitEffects, sql, type Tx } from '@italent/db';
import { MODULE_OBJECTS } from '@italent/domain';
import { AppError } from '../../errors.js';
import { linkedObjectScope, scopeSql } from '../permission/module-access.js';
import { authorizeLinkageWrite } from '../transfer/linkage/access.js';
import type { LinkageOptions } from '../transfer/linkage/input.js';
import { appendLinkageVersion, latestLinkage } from '../transfer/linkage/store.js';
import { validateLinkage } from '../transfer/linkage/validation.js';
import { dutyTransferExecuted } from './exit-duty-timing.js';
import { applyDutyTransfer } from '../transfer/linkage/execute.js';
import { auditEmployment, employmentCreator, requireEmploymentWrite } from './context.js';
import { rowsOf } from './record-store.js';
import { employmentVisibilitySql } from './visibility.js';
import type { EmploymentContext } from './types.js';

type PlanOwner = { readonly id: string; readonly employeeId: string };

export async function authorizeRetirementDutyPlan(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  options: LinkageOptions,
) {
  // 清空同样需要计划字段编辑权；非空时还须校验目标字段和组织范围。
  if (!options.dutyTransfer) await requireEmploymentWrite(ctx, 'update', { dutyTransfer: null });
  await authorizeLinkageWrite(tx, ctx, {}, { employeeId, operation: 'update', options });
}

/** R2-T04 §3.2：编辑只替换尚未执行的本单计划。调用方已锁定参与员工与单据。 */
export async function requirePendingRetirementDutyPlan(tx: Tx, ctx: EmploymentContext, businessId: string) {
  if (await dutyTransferExecuted(tx, ctx, businessId))
    throw new AppError('CONFLICT', '职责已转交，不能再修改转交计划', { reason: 'EXIT_DUTY_TRANSFER_LOCKED' });
}

export async function writeDutyTransferPlan(tx: Tx, ctx: EmploymentContext, owner: PlanOwner, options: LinkageOptions) {
  await validateLinkage(tx, ctx, owner.employeeId, options);
  // 空计划同样追加版本，覆盖上一个待执行计划，并由联动存储记录审计前后值。
  await appendLinkageVersion(tx, ctx, { businessId: owner.id, employeeId: owner.employeeId }, options);
}

export async function readExitDutyTransferPlan(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const plan = (await latestLinkage(tx, ctx.tenantId, businessId))?.options.dutyTransfer ?? null;
  // 计划可整体替换；有引用不可见时省略整个块，不能用裁剪后的半份计划覆盖原计划。
  if (plan && !(await canReadPlanReferences(tx, ctx, plan))) return {};
  return {
    dutyTransferPlan: plan,
    dutyTransferPlanLocked: await dutyTransferExecuted(tx, ctx, businessId),
  };
}

async function canReadPlanReferences(
  tx: Tx,
  ctx: EmploymentContext,
  plan: NonNullable<LinkageOptions['dutyTransfer']>,
) {
  const employeeIds = new Set([
    ...plan.subordinates.flatMap(({ employeeId, receiverId }) => [employeeId, receiverId]),
    ...plan.orgRoles.map(({ receiverId }) => receiverId),
  ]);
  const person = sql`e.id`;
  const personScope = employmentVisibilitySql(ctx.scope, {
    employee: person,
    department: sql`NULL::uuid`,
    creator: employmentCreator(ctx.tenantId, person),
  });
  const [people] = rowsOf<{ count: number }>(
    await tx.execute(sql`
    SELECT count(*)::int AS count FROM employment_employees e
    WHERE e.tenant_id=${ctx.tenantId} AND e.id=ANY(${`{${[...employeeIds].join(',')}}`}::uuid[]) AND ${personScope}
  `),
  );
  if (people?.count !== employeeIds.size) return false;

  const orgIds = new Set(plan.orgRoles.map(({ orgId }) => orgId));
  if (!orgIds.size) return true;
  const scope = await linkedObjectScope(tx, ctx, MODULE_OBJECTS.organization.code);
  const orgScope = scope ? scopeSql(scope, { org: sql`o.id` }) : sql`TRUE`;
  const [orgs] = rowsOf<{ count: number }>(
    await tx.execute(sql`
    SELECT count(*)::int AS count FROM org_objects o
    WHERE o.tenant_id=${ctx.tenantId} AND o.id=ANY(${`{${[...orgIds].join(',')}}`}::uuid[]) AND ${orgScope}
  `),
  );
  return orgs?.count === orgIds.size;
}

export interface ExitTimingRow {
  readonly businessId: string;
  readonly employeeId: string;
  readonly dutyTransferTiming: string;
  readonly dutyTransferDate?: string | null;
}

type Phase = 'confirmed' | 'effective';

/**
 * 本阶段是否执行转交，以及转交的业务生效日（R2-T09b DT-R3 / DT-R7）。执行时间与业务生效日是两件事：
 * - approval_passed：confirmed 阶段，生效日 = 当天；若确认阶段已过去（已确认的单据后来改成此时机），落地阶段兜底，
 *   生效日 = 落地日，不会永远不执行（联动执行行保证至多一次）；business_effective：effective 阶段，生效日 = 最终生效日；
 * - specified_date：指定日期 ≤ 当天的，节点通过当场（confirmed 阶段）执行，但生效日仍是指定日期（DT-R7 允许过去日期，
 *   不改成确认日）；晚于当天的由到期扫描（exit-duty-due.ts）在指定日期执行；effective 阶段作兜底，生效日同样取指定日期。
 * confirmed 阶段的 effectiveDate 参数是当天（租户本地日），effective 阶段是落地日。
 */
function plan(exit: ExitTimingRow, phase: Phase, effectiveDate: string): { at: string } | null {
  if (exit.dutyTransferTiming === 'approval_passed') return { at: effectiveDate };
  if (exit.dutyTransferTiming === 'business_effective') return phase === 'effective' ? { at: effectiveDate } : null;
  const date = exit.dutyTransferDate;
  if (exit.dutyTransferTiming !== 'specified_date' || !date) return null;
  if (phase === 'effective') return { at: date };
  return date <= effectiveDate ? { at: date } : null;
}

export async function runExitDutyTransfer(
  tx: Tx,
  ctx: EmploymentContext,
  exit: ExitTimingRow,
  phase: Phase,
  effectiveDate: string,
) {
  const planned = plan(exit, phase, effectiveDate);
  if (!planned) return;
  await executeExitDutyTransfer(tx, ctx, exit, phase, planned.at);
}

/** 指定日期到期扫描（exit-duty-due.ts）直接调用：生效日 = 指定日期，台账阶段记 confirmed（离职仍是已确认未落地）。 */
export async function executeExitDutyTransfer(
  tx: Tx,
  ctx: EmploymentContext,
  exit: ExitTimingRow,
  phase: Phase,
  effectiveDate: string,
) {
  const items = await applyDutyTransfer(tx, ctx, {
    businessId: exit.businessId,
    employeeId: exit.employeeId,
    effectiveDate,
  });
  if (!items.length) return items;
  await tx.insert(exitEffects).values(
    items.map((item) => ({
      tenantId: ctx.tenantId,
      businessId: exit.businessId,
      employeeId: exit.employeeId,
      phase,
      kind: item.status === 'succeeded' ? 'duty_transferred' : 'duty_failed',
      targetType: 'transfer-linkage-item',
      targetId: item.id,
      detail: {
        itemType: item.itemType,
        subordinateId: item.subordinateId,
        orgId: item.orgId,
        orgRole: item.orgRole,
        receiverId: item.receiverId,
        effectiveDate,
        failureCode: item.failureCode,
        failureRule: item.failureRule,
      },
      commandId: ctx.commandId,
      createdAt: ctx.now,
    })),
  );
  await auditEmployment(
    tx,
    ctx,
    'employment.exit.duty_transfer',
    'exit-request',
    exit.businessId,
    null,
    {
      phase,
      effectiveDate,
      transferred: items.filter((item) => item.status === 'succeeded').length,
      failed: items.filter((item) => item.status === 'failed').length,
    },
    undefined,
    undefined,
    { employeeId: exit.employeeId },
  );
  return items;
}
