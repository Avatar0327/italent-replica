/** R2-T08 §7.4 / §8.3：跨日调动沿用任职、编制和调动联动的事务内端口。 */
import { and, eq, inArray, orgAdjustmentTransferItems, sql, type Tx } from '@italent/db';
import { AppError } from '../../../errors.js';
import { SYSTEM_USER_ID } from '../../../system-actor.js';
import { findCurrentRecord } from '../../employment/read-model.js';
import { lockEmploymentEmployee, rowsOf } from '../../employment/record-store.js';
import { assertTransferPlanHeld, lockTransferParticipants } from '../../employment/transfer-locks.js';
import type { EmploymentContext, EmploymentRecord } from '../../employment/types.js';
import { lockOrganizationSettings } from '../../org/locks.js';
import { resolveTransferForm } from '../../transfer/configuration.js';
import { dutySubordinateIds, type LinkageOptions } from '../../transfer/linkage/input.js';
import { createTransferCore, normalizeTransferInput } from '../../transfer/service.js';
import type { GroupExecutor, GroupInput } from '../execution-groups.js';
import { applicantScopes, type ApplicantScopeOf } from './applicant-scope.js';

const table = orgAdjustmentTransferItems;
type TransferRow = Omit<typeof table.$inferSelect, 'linkage'> & { readonly linkage: LinkageOptions | null };

const baselineChanged = () => new AppError('CONFLICT', '员工任职基线已变化', { reason: 'BASELINE_CHANGED' });
const missingDependency = () => new AppError('CONFLICT', '所依赖的同单明细未执行成功', { reason: 'DEPENDENCY_FAILED' });

async function groupRows(tx: Tx, input: GroupInput): Promise<TransferRow[]> {
  const ids = input.group.items.map((item) => item.id);
  const rows = await tx
    .select()
    .from(table)
    .where(and(eq(table.tenantId, input.tenantId), eq(table.adjustmentId, input.adjustment.id), inArray(table.id, ids)))
    .orderBy(table.seq);
  if (rows.length !== ids.length) throw baselineChanged();
  // 表内值由调动明细的写服务规范化。本片由内部夹具写入同一 LinkageOptions 形状。
  return rows.map((row) => ({ ...row, linkage: row.linkage as LinkageOptions | null }));
}

const participantsOf = (rows: readonly TransferRow[]) =>
  [...new Set(rows.flatMap((row) => [row.employeeId, ...dutySubordinateIds(row.linkage)]))].sort();

export function transferExecutor(scopeOf: ApplicantScopeOf): GroupExecutor {
  return async (tx, input) => {
    const { tenantId, timezone, now, commandId, adjustment } = input;
    const ctx: EmploymentContext = {
      tenantId,
      timezone,
      now,
      commandId,
      userId: SYSTEM_USER_ID,
      expectedRevision: 0,
      orgAdjustmentId: adjustment.id,
    };
    const planned = participantsOf(await groupRows(tx, input));
    const first = planned[0]!;
    await lockTransferParticipants(tx, ctx, first, planned.slice(1), { lockBusinessHeads: true });
    // §9.1：fencing 已由运行器取得。先完成①②，再取单据③与组织设置④；核心的员工锁只能重入。
    await tx.execute(sql`SELECT id FROM org_adjustments
      WHERE tenant_id=${tenantId} AND id=${adjustment.id}::uuid FOR UPDATE`);
    await lockOrganizationSettings(tx, tenantId);
    const rows = await groupRows(tx, input);
    const actual = participantsOf(rows);
    if (actual.join() !== planned.join()) {
      throw new AppError('CONFLICT', '联动参与人员已变化，请刷新后重试', { reason: 'ORG_EMPLOYMENT_PLAN_CHANGED' });
    }
    await assertTransferPlanHeld(tx, ctx, first, planned.slice(1));

    const scope = applicantScopes(tx, scopeOf, input, adjustment);
    const plans: { row: TransferRow; source: EmploymentRecord | null; departmentId: string }[] = [];
    for (const row of rows) {
      if (row.createdBusinessId) continue;
      const departmentId = await targetDepartment(tx, input, row);
      const source = await findCurrentRecord(tx, tenantId, row.employeeId, adjustment.effectiveDate);
      await scope.orgs([
        source?.fields.departmentId,
        departmentId,
        ...(row.linkage?.dutyTransfer?.orgRoles.map((role) => role.orgId) ?? []),
      ]);
      await scope.employee(row.employeeId, source);
      for (const id of dutySubordinateIds(row.linkage)) {
        await scope.employee(id, await findCurrentRecord(tx, tenantId, id, adjustment.effectiveDate));
      }
      if (row.linkage?.contract) await scope.contract(row.employeeId, row.linkage.contract.targetId);
      plans.push({ row, source, departmentId });
    }
    // 先复核全组基线，再写任一任职；上一行联动可能已推进下一行的员工 revision。
    for (const { row, source } of plans) {
      const employee = await lockEmploymentEmployee(tx, ctx, row.employeeId);
      if (source?.id !== row.baseRecordId || employee.revision !== row.baseEmployeeRevision) throw baselineChanged();
      if (
        source.effectiveDate === adjustment.effectiveDate &&
        ['hire', 'rehire', 'retire_rehire'].includes(source.kind)
      )
        throw new AppError('CONFLICT', '同日入职的组织调整调动暂不可用', {
          reason: 'ORG_ADJUSTMENT_SAME_DAY_ENTRY_NOT_AVAILABLE',
        });
    }
    for (const { row, departmentId } of plans) {
      const revision = (await lockEmploymentEmployee(tx, ctx, row.employeeId)).revision;
      await applyTransfer(tx, { ...ctx, expectedRevision: revision }, input, row, departmentId);
    }
    return 'done';
  };
}

async function targetDepartment(tx: Tx, input: GroupInput, row: TransferRow) {
  if (row.positionItemId) throw missingDependency(); // 同单职位引用由 11d 接通。
  if (row.departmentId) return row.departmentId;
  const [target] = rowsOf<{ created_org_id: string | null }>(
    await tx.execute(sql`
    SELECT created_org_id FROM org_adjustment_org_items
    WHERE tenant_id=${input.tenantId} AND adjustment_id=${input.adjustment.id}::uuid
      AND id=${row.departmentItemId}::uuid AND adjust_type=1 AND execution_result=1
  `),
  );
  if (!target?.created_org_id) throw missingDependency();
  return target.created_org_id;
}

async function applyTransfer(
  tx: Tx,
  ctx: EmploymentContext,
  input: GroupInput,
  row: TransferRow,
  departmentId: string,
) {
  // 类型与表单由调用方显式提供；任职 change_type 只标识组织调整来源。
  const normalized = await normalizeTransferInput(tx, ctx, {
    initiator: 'hr',
    transferTypeCode: row.transferTypeCode,
    ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
    mode: 'direct',
    effectiveDate: input.adjustment.effectiveDate,
    formId: row.formId,
    fields: {
      departmentId,
      positionId: row.positionId,
      postId: row.postId,
      levelId: row.levelId,
      directManagerId: row.directManagerId,
      ...(row.dottedManagerId ? { dottedManagerId: row.dottedManagerId } : {}),
    },
  });
  const form = await resolveTransferForm(tx, ctx.tenantId, normalized.employment.formId);
  const { business } = await createTransferCore(
    tx,
    ctx,
    row.employeeId,
    { ...normalized, linkage: row.linkage, withEstablishment: row.withEstablishment },
    { processCode: form.processCode, orgAdjustment: true },
  );
  // §5.8：本片不传组收集器；编制即时校验失败由运行器回滚本组。
  await tx
    .update(table)
    .set({ createdBusinessId: business.id })
    .where(and(eq(table.tenantId, ctx.tenantId), eq(table.adjustmentId, input.adjustment.id), eq(table.id, row.id)));
}
