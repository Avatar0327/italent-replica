/**
 * 保存 / 提交时校验联动选项（调用方已持员工锁）。人员按当日在职判定；职责转交改写的下属任职按操作人范围判定。
 * 汇报线循环（`30` DT-R6）随执行时的任职编辑统一校验：保存后到生效前汇报线仍可能变化，失败按子项记录并可重试。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { requireLinkedEmploymentRecord } from '../../employment/context.js';
import { ineligibleOrgPeople } from '../../employment/org-people.js';
import { findCurrentRecord } from '../../employment/read-model.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext } from '../../employment/types.js';
import { validateContractChange } from './contract.js';
import type { DutyRelation, LinkageOptions, OrgRole } from './input.js';
import { transferPartTimePort } from './part-time.js';

const ROLE_COLUMNS: Record<OrgRole, string> = {
  person_in_charge: 'person_in_charge_id',
  shop_owner: 'shop_owner_id',
  hrbp: 'hrbp_id',
};
export const ROLE_FIELDS = {
  person_in_charge: 'personInChargeId',
  shop_owner: 'shopOwnerId',
  hrbp: 'hrbpId',
} as const satisfies Record<OrgRole, string>;
export const RELATION_FIELDS = {
  direct: 'directManagerId',
  dotted: 'dottedManagerId',
} as const satisfies Record<DutyRelation, string>;

export async function validateLinkage(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  options: LinkageOptions,
): Promise<void> {
  if (options.contract) await validateContractChange(tx, ctx, employeeId, options.contract);
  for (const { recordId } of options.partTimes) {
    if (!(await transferPartTimePort().exists(tx, ctx, { employeeId, recordId })))
      throw new AppError('VALIDATION_FAILED', '兼职记录不存在', { reason: 'PART_TIME_RECORD_NOT_FOUND' });
  }
  const people = [
    ...(options.handover?.handoverPersonId ? [options.handover.handoverPersonId] : []),
    ...(options.dutyTransfer?.subordinates.flatMap((item) => [item.employeeId, item.receiverId]) ?? []),
    ...(options.dutyTransfer?.orgRoles.map((item) => item.receiverId) ?? []),
  ];
  await requireEligiblePeople(tx, ctx, employeeId, people);
  for (const item of options.dutyTransfer?.subordinates ?? []) {
    if (item.receiverId === item.employeeId) throw notEligible();
    await requireReportingSubordinate(tx, ctx, employeeId, item.employeeId, item.relation);
  }
  // TODO(F-017)：组织角色转交改写组织版本，F-017 合并后接入其组织联动范围授权；目前只校验调动人担任该角色。
  for (const item of options.dutyTransfer?.orgRoles ?? [])
    await requireRoleHolder(tx, ctx, employeeId, item.orgId, item.role);
}

const notEligible = () =>
  new AppError('VALIDATION_FAILED', '联动人员须为本租户在职员工且不能为调动人本人', {
    reason: 'TRANSFER_PERSON_NOT_ELIGIBLE',
  });

/** 跨租户、离职与不存在的人员一律同一错误，不按 UUID 探测原因（与新增下属同口径）。 */
async function requireEligiblePeople(tx: Tx, ctx: EmploymentContext, employeeId: string, ids: readonly string[]) {
  if (ids.includes(employeeId)) throw notEligible();
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  if ((await ineligibleOrgPeople(tx, ctx.tenantId, ids, today)).length) throw notEligible();
}

/** 下属当前须汇报给调动人；其当前任职将被改写，按 DEC-178 / DEC-084 判定操作人能否改写。 */
export async function requireReportingSubordinate(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  subordinateId: string,
  relation: DutyRelation,
) {
  const record = await findCurrentRecord(tx, ctx.tenantId, subordinateId, tenantLocalDate(ctx.now, ctx.timezone));
  if (!record) throw notEligible();
  // DEC-178：下属当前任职按 F-015 的 DEC-177 可见判定，可见即可改写，不可见整单拒绝（DEC-084 拒绝码）。
  await requireLinkedEmploymentRecord(tx, ctx, subordinateId, record.fields.departmentId, record.id);
  if (record.fields[RELATION_FIELDS[relation]] !== employeeId)
    throw new AppError('VALIDATION_FAILED', '该员工当前不汇报给调动人', {
      reason: 'TRANSFER_SUBORDINATE_NOT_REPORTING',
    });
  return record;
}

/** 组织角色转交：调动人当前须担任该组织的该角色（`30` DT-R1）。 */
export async function requireRoleHolder(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  orgId: string,
  role: OrgRole,
  asOf = tenantLocalDate(ctx.now, ctx.timezone),
) {
  const [version] = rowsOf<{ holder: string | null }>(
    await tx.execute(sql`
    SELECT ${sql.raw(ROLE_COLUMNS[role])} AS holder FROM org_versions
    WHERE tenant_id=${ctx.tenantId} AND org_id=${orgId}::uuid
      AND start_date<=${asOf}::date AND stop_date>=${asOf}::date
    ORDER BY version_no DESC LIMIT 1`),
  );
  if (version?.holder !== employeeId)
    throw new AppError('VALIDATION_FAILED', '调动人当前未担任该组织角色', { reason: 'TRANSFER_ORG_ROLE_NOT_HELD' });
}
