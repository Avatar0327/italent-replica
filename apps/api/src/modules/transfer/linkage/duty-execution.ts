/**
 * 职责转交的单一执行入口（DEC-431①）：离职 / 调动内转交（联动子项）与职责转交菜单（R2-T09a）共用，不另写第二套。
 * 只做“改一条职责”这一件事：DT-R6 接收人在职校验、持有校验、组织角色写组织新版本 / 下属改上级（循环在此报错）。
 * 记录状态、审计与锁由各调用方负责；业务拒绝原样抛出，由调用方用 dutyItemFailure 判定是否记为该条失败。
 * 两种口径由调用方显式传入（DutyExecutionMode，DEC-385③），不按调用栈猜：
 * - menu（菜单立即 / 到期）：下属自转交日起新增“数据调整”任职记录（`30` DT-R7 / AC-DT-04），转交日前保留原经理；
 *   组织角色先在执行锁内复核组织当日仍启用；接收人资格另按执行当日复核（eligibleOn）。
 * - linkage（离职 / 调动内转交）：保持现行为——原地改写下属当前任职的上级（W-013），不复核组织启用。
 */
import { employmentEmployees, sql, type Tx } from '@italent/db';
import type { OrgId } from '@italent/domain';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../../../errors.js';
import { ruleRejection } from '../../employment/activation-checks.js';
import { ineligibleOrgPeople } from '../../employment/org-people.js';
import { editEmploymentRecord } from '../../employment/record-edit.js';
import type { EmploymentContext } from '../../employment/types.js';
import { createEmploymentBusiness } from '../../employment/write-service.js';
import { createTxOrgHierarchyReader } from '../../establishment/org-reader.js';
import { assignTransferOrganizationPeople } from '../../org/write-service.js';
import type { DutyRelation, OrgRole } from './input.js';
import { RELATION_FIELDS, ROLE_FIELDS, requireReportingSubordinate, requireRoleHolder } from './validation.js';

export type DutyItem =
  | {
      readonly kind: 'org_role';
      readonly employeeId: string;
      readonly orgId: string;
      readonly orgRole: OrgRole;
      /** 空 = 清空该职责（R2-T09b DT-R5：离职 / 退休落地时仍无接收人的职责，只在 linkage 口径使用）。 */
      readonly receiverId: string | null;
      readonly effectiveDate: string;
    }
  | {
      readonly kind: 'subordinate';
      readonly employeeId: string;
      readonly subordinateId: string;
      readonly relation: DutyRelation;
      readonly receiverId: string | null;
      readonly effectiveDate: string;
    };

/** 共享入口的口径（DEC-385③）：见文件头。 */
export interface DutyExecutionMode {
  readonly caller: 'menu' | 'linkage';
  /** 接收人在职资格的另一判定日（菜单到期执行 = 执行当日，P2-4）；生效日始终要判。 */
  readonly eligibleOn?: string;
}

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

export async function executeDutyItem(tx: Tx, ctx: EmploymentContext, item: DutyItem, mode: DutyExecutionMode) {
  // `30` DT-R6：接收人已离职等不再在职时报错；迟到执行再按执行当日判一次（离职 / 退休可能发生在转交日期之后）。
  const days = [...new Set([item.effectiveDate, mode.eligibleOn ?? item.effectiveDate])];
  const receiverId = item.receiverId;
  if (receiverId === null && mode.caller !== 'linkage') throw new Error('清空职责只能经离职 / 调动联动口径执行');
  for (const day of receiverId === null ? [] : days)
    if ((await ineligibleOrgPeople(tx, ctx.tenantId, [receiverId!], day)).length)
      throw new AppError('VALIDATION_FAILED', '接收人不是在职员工', { reason: 'TRANSFER_PERSON_NOT_ELIGIBLE' });
  if (item.kind === 'org_role') {
    if (mode.caller === 'menu') await requireEnabledOrg(tx, ctx.tenantId, item.orgId, days);
    await requireRoleHolder(tx, ctx, item.employeeId, item.orgId, item.orgRole, item.effectiveDate);
    // DT-R7：组织变更记录取转交生效日（业务内 = 业务生效日；菜单 = 当天或指定日期，W-607 / F-408）。
    const people: Partial<Record<(typeof ROLE_FIELDS)[OrgRole], string | null>> = {
      [ROLE_FIELDS[item.orgRole]]: receiverId,
    };
    await assignTransferOrganizationPeople(tx, ctx, item.orgId, item.effectiveDate, people);
    return;
  }
  const record = await requireReportingSubordinate(tx, ctx, item.employeeId, item.subordinateId, item.relation);
  const fields = { [RELATION_FIELDS[item.relation]]: receiverId };
  if (mode.caller === 'menu') {
    await appendDataAdjustment(tx, ctx, item.subordinateId, item.effectiveDate, fields);
    return;
  }
  // 离职 / 调动内转交：与新增下属同一口径（`08` 附表 W-013），原地改写下属当前任职的上级；汇报线循环在此报错。
  await editEmploymentRecord(
    tx,
    { ...ctx, expectedRevision: record.revision },
    record.id,
    { fields },
    'api',
    // P2-1：新经理按转交生效日判定在职，循环汇报从该日起校验（不按下属记录的开始日）。
    { forwardUpdate: false, linkageDate: item.effectiveDate },
  );
}

/**
 * 菜单转交下属（`30` DT-R7 / AC-DT-04）：自转交日起在下属时间轴插入一条异动类型“数据调整”的任职记录，转交日前不变。
 * 业务类型取“组织调整”（W-416 系统联动同口径，见 job/employment-port.ts），不走调动审批门禁、不触发调动联动；
 * 其后已有未来记录时按 `07` A7 向后更新、当天已有记录时排在当日最后（DEC-108），循环汇报整单拒绝——都是新增业务的同一路径。
 * 下属已由调用方加参与人锁（lockTransferParticipants），这里按锁内的当前 revision 写。
 */
async function appendDataAdjustment(
  tx: Tx,
  ctx: EmploymentContext,
  subordinateId: string,
  effectiveDate: string,
  fields: Record<string, string | null>,
) {
  const [employee] = await tx
    .select({ revision: employmentEmployees.revision })
    .from(employmentEmployees)
    .where(and(eq(employmentEmployees.tenantId, ctx.tenantId), eq(employmentEmployees.id, subordinateId)));
  if (!employee) throw new AppError('NOT_FOUND', '下属不存在');
  await createEmploymentBusiness(
    tx,
    { ...ctx, expectedRevision: employee.revision },
    subordinateId,
    { kind: 'org_adjustment', mode: 'direct', effectiveDate, fields },
    { changeType: 'data_adjustment' },
  );
}

/**
 * P2-3：到期前组织已停用（或已失效）则该条失败，不写组织新版本；在组织对象锁内判，防与停用并发交错。
 * 当日是否启用复用组织层级读取器（F-448 / 第 2 轮交叉审 P3-3），不另写版本选法。
 */
async function requireEnabledOrg(tx: Tx, tenantId: string, orgId: string, days: readonly string[]) {
  await tx.execute(sql`SELECT 1 FROM org_objects WHERE tenant_id=${tenantId} AND id=${orgId}::uuid FOR NO KEY UPDATE`);
  const reader = createTxOrgHierarchyReader(tx);
  for (const asOf of days) {
    if (!(await reader.isEnabled({ tenantId, orgId: orgId as OrgId, asOf })))
      throw new AppError('VALIDATION_FAILED', '组织已停用，不能转交', { reason: 'TRANSFER_ORG_DISABLED' });
  }
}
