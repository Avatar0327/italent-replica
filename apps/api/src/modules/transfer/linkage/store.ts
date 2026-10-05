/** 联动选项版本的读写：只追加，最新版本即当前选项（同任职载荷版本链的做法）。 */
import { randomUUID } from 'node:crypto';
import { sql, transferLinkageDuties, transferLinkageVersions, type Tx } from '@italent/db';
import type { ContractFields } from '../../contracts/input.js';
import { auditEmployment } from '../../employment/context.js';
import { rowsOf } from '../../employment/record-store.js';
import type { EmploymentContext } from '../../employment/types.js';
import type { DutyOrgRole, DutySubordinate, LinkageOptions, OrgRole } from './input.js';

export interface StoredLinkage {
  readonly versionId: string;
  readonly versionNo: number;
  readonly options: LinkageOptions;
}

interface VersionRow {
  id: string;
  versionNo: number;
  contractTargetId: string | null;
  contractFields: ContractFields | null;
  adjustSalary: boolean;
  onTrialStartDate: string | null;
  onTrialMonths: number | null;
  handover: boolean;
  handoverPersonId: string | null;
  partTimeRecordIds: string[];
}

interface DutyRow {
  itemType: 'duty_subordinate' | 'duty_org_role';
  subordinateId: string | null;
  relation: 'direct' | 'dotted' | null;
  orgId: string | null;
  orgRole: OrgRole | null;
  receiverId: string;
}

export async function latestLinkage(tx: Tx, tenantId: string, businessId: string): Promise<StoredLinkage | null> {
  const [row] = rowsOf<VersionRow>(
    await tx.execute(sql`
    SELECT id, version_no AS "versionNo", contract_target_id AS "contractTargetId",
      contract_fields AS "contractFields", adjust_salary AS "adjustSalary",
      on_trial_start_date::text AS "onTrialStartDate", on_trial_months AS "onTrialMonths", handover,
      handover_person_id AS "handoverPersonId", part_time_record_ids AS "partTimeRecordIds"
    FROM transfer_linkage_versions WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid
    ORDER BY version_no DESC LIMIT 1`),
  );
  if (!row) return null;
  const duties = rowsOf<DutyRow>(
    await tx.execute(sql`
    SELECT item_type AS "itemType", subordinate_id AS "subordinateId", relation, org_id AS "orgId",
      org_role AS "orgRole", receiver_id AS "receiverId"
    FROM transfer_linkage_duties WHERE tenant_id=${tenantId} AND version_id=${row.id}::uuid ORDER BY line_no`),
  );
  return { versionId: row.id, versionNo: Number(row.versionNo), options: optionsOf(row, duties) };
}

function optionsOf(row: VersionRow, duties: readonly DutyRow[]): LinkageOptions {
  const subordinates: DutySubordinate[] = duties
    .filter((duty) => duty.itemType === 'duty_subordinate')
    .map((duty) => ({ employeeId: duty.subordinateId!, receiverId: duty.receiverId, relation: duty.relation! }));
  const orgRoles: DutyOrgRole[] = duties
    .filter((duty) => duty.itemType === 'duty_org_role')
    .map((duty) => ({ orgId: duty.orgId!, role: duty.orgRole!, receiverId: duty.receiverId }));
  return {
    contract: row.contractTargetId ? { targetId: row.contractTargetId, fields: row.contractFields ?? {} } : null,
    adjustSalary: row.adjustSalary,
    onTrial: row.onTrialMonths ? { startDate: row.onTrialStartDate, months: Number(row.onTrialMonths) } : null,
    handover: row.handover ? { handoverPersonId: row.handoverPersonId } : null,
    partTimes: (row.partTimeRecordIds ?? []).map((recordId) => ({ recordId })),
    dutyTransfer: duties.length ? { subordinates, orgRoles } : null,
  };
}

/** 调用方已持员工锁并完成校验；审计与 outbox 同事务（AGENTS.md §10）。 */
export async function appendLinkageVersion(
  tx: Tx,
  ctx: EmploymentContext,
  target: { readonly businessId: string; readonly employeeId: string },
  options: LinkageOptions,
): Promise<StoredLinkage> {
  const previous = await latestLinkage(tx, ctx.tenantId, target.businessId);
  const id = randomUUID();
  const versionNo = (previous?.versionNo ?? 0) + 1;
  await tx.insert(transferLinkageVersions).values({
    id,
    tenantId: ctx.tenantId,
    employeeId: target.employeeId,
    businessId: target.businessId,
    versionNo,
    changeContract: !!options.contract,
    contractTargetId: options.contract?.targetId ?? null,
    contractFields: options.contract ? { ...options.contract.fields } : null,
    adjustSalary: options.adjustSalary,
    onTrialStartDate: options.onTrial?.startDate ?? null,
    onTrialMonths: options.onTrial?.months ?? null,
    handover: !!options.handover,
    handoverPersonId: options.handover?.handoverPersonId ?? null,
    partTimeRecordIds: options.partTimes.map((item) => item.recordId),
    commandId: ctx.commandId,
    createdAt: ctx.now,
  });
  const duties = dutyLines(options);
  if (duties.length)
    await tx
      .insert(transferLinkageDuties)
      .values(duties.map((duty, index) => ({ ...duty, tenantId: ctx.tenantId, versionId: id, lineNo: index + 1 })));
  await auditEmployment(
    tx,
    ctx,
    'transfer.linkage.save',
    'transfer-linkage',
    target.businessId,
    previous?.options ?? null,
    options,
  );
  return { versionId: id, versionNo, options };
}

/** 组织角色在前、下属在后：先把负责人等角色交出，再改下属汇报线（执行顺序同此）。 */
export function dutyLines(options: LinkageOptions) {
  const duty = options.dutyTransfer;
  return [
    ...(duty?.orgRoles ?? []).map((item) => ({
      itemType: 'duty_org_role' as const,
      subordinateId: null,
      relation: null,
      orgId: item.orgId,
      orgRole: item.role,
      receiverId: item.receiverId,
    })),
    ...(duty?.subordinates ?? []).map((item) => ({
      itemType: 'duty_subordinate' as const,
      subordinateId: item.employeeId,
      relation: item.relation,
      orgId: null,
      orgRole: null,
      receiverId: item.receiverId,
    })),
  ];
}

export function hasLinkage(options: LinkageOptions | null | undefined): boolean {
  return !!(
    options &&
    (options.contract ||
      options.adjustSalary ||
      options.onTrial ||
      options.handover ||
      options.partTimes.length ||
      options.dutyTransfer)
  );
}

/** 有待执行的跨对象联动（定时生效据此判断直接调动是否“仅提醒”，DEC-173）。 */
export async function hasPendingCrossLinkage(tx: Tx, tenantId: string, businessId: string): Promise<boolean> {
  return hasLinkage((await latestLinkage(tx, tenantId, businessId))?.options);
}
