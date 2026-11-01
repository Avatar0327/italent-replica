/**
 * 职责转交的单一执行入口（DEC-431①）：离职 / 调动内转交（联动子项）与职责转交菜单（R2-T09a）共用，不另写第二套。
 * 只做“改一条职责”这一件事：DT-R6 接收人在职校验、持有校验、组织角色写组织新版本 / 下属改写上级（循环在此报错）。
 * 记录状态、审计与锁由各调用方负责；业务拒绝原样抛出，由调用方用 dutyItemFailure 判定是否记为该条失败。
 */
import type { Tx } from '@italent/db';
import { AppError } from '../../../errors.js';
import { ruleRejection } from '../../employment/activation-checks.js';
import { ineligibleOrgPeople } from '../../employment/org-people.js';
import { editEmploymentRecord } from '../../employment/record-edit.js';
import type { EmploymentContext } from '../../employment/types.js';
import { assignTransferOrganizationPeople } from '../../org/write-service.js';
import type { DutyRelation, OrgRole } from './input.js';
import { RELATION_FIELDS, ROLE_FIELDS, requireReportingSubordinate, requireRoleHolder } from './validation.js';

export type DutyItem =
  | {
      readonly kind: 'org_role';
      readonly employeeId: string;
      readonly orgId: string;
      readonly orgRole: OrgRole;
      readonly receiverId: string;
      readonly effectiveDate: string;
    }
  | {
      readonly kind: 'subordinate';
      readonly employeeId: string;
      readonly subordinateId: string;
      readonly relation: DutyRelation;
      readonly receiverId: string;
      readonly effectiveDate: string;
    };

export interface DutyItemFailure {
  readonly code: string;
  readonly message: string;
  readonly rule: string | null;
}

/** 业务拒绝 → 该条失败；范围外记录按 DEC-178 整单拒绝、存储 / 依赖错误整体回滚，都返回 null 由调用方上抛。 */
export function dutyItemFailure(error: unknown): DutyItemFailure | null {
  if (error instanceof AppError && error.code === 'LINKED_RECORD_OUT_OF_SCOPE') return null;
  const rejected = ruleRejection(error);
  if (!rejected) return null;
  const detail = rejected.detail as { code: string; message: string; rule?: unknown };
  return { code: detail.code, message: detail.message, rule: typeof detail.rule === 'string' ? detail.rule : null };
}

export async function executeDutyItem(tx: Tx, ctx: EmploymentContext, item: DutyItem) {
  // `30` DT-R6：接收人已离职等不再在职时报错。
  if ((await ineligibleOrgPeople(tx, ctx.tenantId, [item.receiverId], item.effectiveDate)).length)
    throw new AppError('VALIDATION_FAILED', '接收人不是在职员工', { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
  if (item.kind === 'org_role') {
    await requireRoleHolder(tx, ctx, item.employeeId, item.orgId, item.orgRole, item.effectiveDate);
    // DT-R7：组织变更记录取转交生效日（业务内 = 业务生效日；菜单 = 当天或指定日期，W-607 / F-408）。
    const people: Partial<Record<(typeof ROLE_FIELDS)[OrgRole], string>> = {
      [ROLE_FIELDS[item.orgRole]]: item.receiverId,
    };
    await assignTransferOrganizationPeople(tx, ctx, item.orgId, item.effectiveDate, people);
    return;
  }
  const record = await requireReportingSubordinate(tx, ctx, item.employeeId, item.subordinateId, item.relation);
  // 与新增下属同一口径（`08` 附表 W-013）：原地改写下属当前任职的上级，不新增任职记录；汇报线循环在此报错。
  await editEmploymentRecord(
    tx,
    { ...ctx, expectedRevision: record.revision },
    record.id,
    { fields: { [RELATION_FIELDS[item.relation]]: item.receiverId } },
    'api',
    // P2-1：新经理按转交生效日判定在职，循环汇报从该日起校验（不按下属记录的开始日）。
    { forwardUpdate: false, linkageDate: item.effectiveDate },
  );
}
