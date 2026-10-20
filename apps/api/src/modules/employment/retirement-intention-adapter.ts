/**
 * 审批中心的意向退休日期申请适配器（R2-T04 5d2，设计 §11.2）：业务单 = 意向申请（retirement_intentions），审批类型
 * retirement_intention。审批中心以可信身份回调，不带数据范围（DEC-057）；审批中心撤回 / 重提的写范围与按钮在命令事务内
 * 由 approval/access.ts 的 withdrawGuard / resubmitGuard 经 requireIntentionApprovalRight 再判一次，两道都过才执行。
 * - 快照：流程主体 = 申请员工，路由部门 = 申请时主职部门快照；标题不含个人数据；表单只含本单字段（DEC-057）：意向日期、原因与申请时冻结的快照三项；
 * - 结果回写：通过 → approved（只记录，不写人事字段，A-6）、不同意 → disapproved、驳回 → rejected、撤回 → withdrawn；
 *   被驳回的申请可沿原审批实例同单重提（DEC-103）；
 * - 审批中编辑首版不开（类型 approvalEdit = false，同员工子集变更 DEC-105），要改内容时驳回，发起人修改后重提。
 * 取锁顺序：员工 → 申请行（与 HR 入口同序）→ 审批实例。
 */
import { sql, type Tx } from '@italent/db';
import { APPROVAL_TYPES, RETIREMENT_INTENTION_FORM_FIELDS, tenantLocalDate } from '@italent/domain';
import type { BusinessAdapter, BusinessSnapshot } from '../approval/adapters.js';
import { approvalError, rowsOf, type ApprovalContext } from '../approval/context.js';
import { findCurrentRecord } from './read-model.js';
import { lockEmploymentEmployee } from './record-store.js';
import { lockIntention, resubmitIntentionFromApproval, settleIntentionFromApproval } from './retirement-intention.js';
import { loadIntention } from './retirement-intention-store.js';
import type { EmploymentContext } from './types.js';

const TYPE = APPROVAL_TYPES.retirement_intention;
const asEmployment = (ctx: ApprovalContext) => ctx as unknown as EmploymentContext;

async function snapshot(tx: Tx, ctx: ApprovalContext, id: string): Promise<BusinessSnapshot> {
  const row = await loadIntention(tx, ctx.tenantId, id);
  const [employee] = rowsOf<{ code: string; name: string }>(
    await tx.execute(sql`SELECT code, name FROM employment_employees
      WHERE tenant_id=${ctx.tenantId} AND id=${row.employeeId}::uuid`),
  );
  const current = await findCurrentRecord(tx, ctx.tenantId, row.employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  const values = Object.fromEntries(
    RETIREMENT_INTENTION_FORM_FIELDS.map((field) => [field, row[field as keyof typeof row] ?? null]),
  );
  return {
    approvalType: 'retirement_intention',
    businessType: 'retirement_intention',
    businessId: id,
    fieldObjectCode: TYPE.objectCode,
    profileFields: [],
    subjectEmployeeId: row.employeeId,
    // 标题不含个人数据（DEC-057），待办与列表原样展示也不泄露被隐藏的姓名
    title: TYPE.name,
    values,
    originals: null,
    // 新单据没有原值：有值的字段都是本单内容，审批人看不到即盲审（DEC-058）
    changedFields: RETIREMENT_INTENTION_FORM_FIELDS.filter((field) => values[field] !== null),
    conditionValues: {
      processCode: TYPE.defaultProcessCode,
      'business.kind': 'retirement_intention',
      'employee.code': employee?.code ?? null,
      'employee.name': employee?.name ?? null,
      'record.departmentId': row.departmentId,
      'record.effectiveDate': row.intendedDate,
    },
    latestDepartmentId: current?.fields.departmentId ?? row.departmentId,
    recordDepartmentId: row.departmentId,
    version: `revision:${row.revision}`,
    processCode: TYPE.defaultProcessCode,
  };
}

const settle =
  (outcome: 'approved' | 'rejected' | 'disapproved' | 'withdrawn') => (tx: Tx, ctx: ApprovalContext, id: string) =>
    settleIntentionFromApproval(tx, asEmployment(ctx), id, outcome);

export const retirementIntentionAdapter: BusinessAdapter = {
  async lock(tx, ctx, id) {
    await lockIntention(tx, asEmployment(ctx), id);
  },
  /** 批量干预：先按员工 ID 升序锁员工，再按申请 ID 升序锁申请行（与单条 lock 同为 员工 → 申请行）。 */
  async lockMany(tx, ctx, ids) {
    const sorted = [...ids].sort();
    const rows = rowsOf<{ employee_id: string }>(
      await tx.execute(sql`SELECT DISTINCT employee_id::text AS employee_id FROM retirement_intentions
        WHERE tenant_id=${ctx.tenantId} AND id = ANY(${`{${sorted.join(',')}}`}::uuid[]) ORDER BY 1`),
    );
    for (const row of rows) await lockEmploymentEmployee(tx, asEmployment(ctx), row.employee_id);
    for (const id of sorted) await loadIntention(tx, ctx.tenantId, id, true);
  },
  snapshot,
  approved: settle('approved'),
  rejected: settle('rejected'),
  disapproved: settle('disapproved'),
  withdrawn: settle('withdrawn'),
  resubmit: (tx, ctx, id, corrections) => resubmitIntentionFromApproval(tx, asEmployment(ctx), id, corrections),
  edit: () => {
    throw approvalError(
      'CONFLICT',
      'APPROVAL_EDIT_UNSUPPORTED',
      '意向退休申请不支持审批中编辑，请驳回后由发起人修改重提',
    );
  },
};
