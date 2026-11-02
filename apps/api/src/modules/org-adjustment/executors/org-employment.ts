/**
 * R2-T08 §7.5 组织变更“新增任职”的 T2 / T3：T1 已在独立事务写好组织版本（exec_phase = 1）。
 * T2：按员工 ID 键集分页（每页 500），游标、计数与本页追加同一事务提交，接管时按游标续跑、不重复；
 *     逐员工失败（主职已变化、申请人任职范围外、任职已变化）进失败表，不拖垮整组。
 * T3：空页即收尾；有逐员工失败时本行记 EMPLOYMENT_PARTIAL，运行器把各行置 exec_phase = 2。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../../errors.js';
import { SYSTEM_USER_ID } from '../../../system-actor.js';
import { auditEmployment } from '../../employment/context.js';
import { appendOrgAdjustment } from '../../employment/org-adjustment.js';
import type { EmploymentContext } from '../../employment/types.js';
import {
  lockOrgEmploymentEmployees,
  orgEmploymentTargetsPage,
  primaryMovedAfter,
} from '../../org/employment-linkage.js';
import type { ExecutionOutcome, GroupInput } from '../execution-groups.js';
import { applicantScopes, type ApplicantScopeOf } from './applicant-scope.js';
import { liveOrg, type ExecItem } from './context.js';

export const EMPLOYMENT_PAGE_SIZE = 500;

interface EmployeeFailure {
  readonly employeeId: string;
  readonly reason: string;
  readonly message: string;
}

export async function linkEmploymentPage(
  tx: Tx,
  scopeOf: ApplicantScopeOf,
  input: GroupInput,
  item: ExecItem,
): Promise<ExecutionOutcome> {
  const orgId = item.targetOrgId!;
  const date = input.adjustment.effectiveDate;
  // 接管不再写组织、不做基线；但 T1 写下的版本须仍是生效日现行版本，否则组织已被外部改动，不在其上续追加。
  if ((await liveOrg(tx, input, orgId))?.versionId !== item.executedVersionId)
    throw new AppError('CONFLICT', '组织在本单执行期间已被改动', { reason: 'EXECUTION_STATE_DIVERGED' });
  const ids = await orgEmploymentTargetsPage(
    tx,
    input.tenantId,
    orgId,
    date,
    item.employmentCursor,
    EMPLOYMENT_PAGE_SIZE,
  );
  const ctx = await employmentContext(tx, scopeOf, input);
  if (!ids.length) return finish(tx, ctx, input, item);
  await lockOrgEmploymentEmployees(tx, ctx, ids);
  const moved = await primaryMovedAfter(tx, input.tenantId, ids, date);
  const failures: EmployeeFailure[] = [];
  for (const employeeId of ids) {
    const failure = moved.has(employeeId)
      ? { reason: 'EMPLOYMENT_CHANGED', message: '员工主职在生效日之后已变化' }
      : await appendOne(tx, ctx, employeeId, date, orgId);
    if (failure) failures.push({ employeeId, ...failure });
  }
  await recordFailures(tx, input, item, failures);
  await tx.execute(sql`UPDATE org_adjustment_org_items SET employment_cursor=${ids.at(-1)!}::uuid,
      employment_done=employment_done+${ids.length - failures.length},
      employment_failed=employment_failed+${failures.length}
    WHERE tenant_id=${input.tenantId} AND id=${item.id}::uuid`);
  return 'pending';
}

async function employmentContext(tx: Tx, scopeOf: ApplicantScopeOf, input: GroupInput): Promise<EmploymentContext> {
  const scope = await applicantScopes(tx, scopeOf, input, input.adjustment).employment();
  const { tenantId, timezone, now, commandId } = input;
  return { tenantId, userId: SYSTEM_USER_ID, timezone, now, commandId, expectedRevision: 0, scope };
}

/** 单人追加在保存点内：业务拒绝只回滚此人，其余照常；非业务错误整页重试（§7.7）。 */
async function appendOne(tx: Tx, ctx: EmploymentContext, employeeId: string, date: string, orgId: string) {
  try {
    await tx.transaction((sp) => appendOrgAdjustment(sp, ctx, employeeId, date, orgId, 'org_adjustment'));
    return null;
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    return { reason: employeeReason(error), message: error.message.slice(0, 500) };
  }
}

function employeeReason(error: AppError) {
  if (error.code === 'LINKED_RECORD_OUT_OF_SCOPE') return 'APPLICANT_OUT_OF_SCOPE';
  if (error.code === 'CONFLICT') return 'EMPLOYMENT_CHANGED';
  return (error.details as { reason?: string } | undefined)?.reason ?? error.code;
}

async function recordFailures(tx: Tx, input: GroupInput, item: ExecItem, failures: readonly EmployeeFailure[]) {
  if (!failures.length) return;
  await tx.execute(sql`INSERT INTO org_adjustment_employment_failures
      (tenant_id, adjustment_id, item_id, employee_id, reason, message, created_at)
    SELECT ${input.tenantId}, ${input.adjustment.id}::uuid, ${item.id}::uuid, f.employee_id, f.reason, f.message,
      ${input.now.toISOString()}
    FROM jsonb_to_recordset(${JSON.stringify(failures.map(snake))}::jsonb)
      AS f(employee_id uuid, reason text, message text)
    ON CONFLICT DO NOTHING`);
}

const snake = (f: EmployeeFailure) => ({ employee_id: f.employeeId, reason: f.reason, message: f.message });

async function finish(tx: Tx, ctx: EmploymentContext, input: GroupInput, item: ExecItem): Promise<ExecutionOutcome> {
  if (item.employmentFailed > 0)
    await tx.execute(sql`UPDATE org_adjustment_org_items SET execution_result=2, execution_reason='EMPLOYMENT_PARTIAL',
        execution_message=${`组织已调整，${item.employmentFailed} 名员工任职追加失败`}
      WHERE tenant_id=${input.tenantId} AND id=${item.id}::uuid`);
  await auditEmployment(tx, ctx, 'org.employment.adjusted', 'org-adjustment-run', item.targetOrgId!, null, {
    effectiveDate: input.adjustment.effectiveDate,
    employeeCount: item.employmentDone,
    failedCount: item.employmentFailed,
    orgAdjustmentId: input.adjustment.id,
  });
  return 'done';
}
