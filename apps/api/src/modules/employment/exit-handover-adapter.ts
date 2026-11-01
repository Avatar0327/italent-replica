/**
 * 审批中心的离职交接申请适配器（R2 BE-8b2，B64）：业务单 = 交接申请（exit_handover_requests），审批类型 exit_handover。
 * 审批中心以可信身份回调，不带数据范围（DEC-057）；回调只改交接申请的状态，不碰离职状态（交接未完成不阻止离职生效）。
 * - 快照：流程主体 = 离职员工，路由部门 = 发起时主职部门快照；标题不含个人数据；表单不带字段（审批人只办事项，事项在交接申请详情里读写），
 *   所以没有盲审字段；工作交接人取离职申请上的交接人（handoverEmployeeId，空则解析器取直线经理）；
 * - 结果回写：通过 → 已完成；不同意 → 已终止；驳回 / 撤回 → 已终止（预置流程没有驳回 / 撤回入口，保底防止流程卡住）；
 * - 审批中心不开放“同单重提”和“审批中编辑”：重新提交由 HR 的专用入口发起新实例（F-305 / DEC-674）。
 * 取锁顺序：员工 → 交接申请行 → 审批实例。
 */
import { sql, type Tx } from '@italent/db';
import { APPROVAL_TYPES, tenantLocalDate } from '@italent/domain';
import type { BusinessAdapter, BusinessSnapshot } from '../approval/adapters.js';
import { approvalError, rowsOf, type ApprovalContext } from '../approval/context.js';
import { lockHandoverRequest, settleHandoverFromApproval } from './exit-handover.js';
import { loadHandoverRequest } from './exit-handover-store.js';
import { findCurrentRecord, loadEmploymentBusiness } from './read-model.js';
import { loadExitRequest } from './exit-gate.js';
import type { EmploymentContext } from './types.js';

const TYPE = APPROVAL_TYPES.exit_handover;
/** 字段权限沿用任职记录对象；单独起名，让 F-039 基准能把本适配器的字段对象与意向退休申请区分开。 */
const HANDOVER_OBJECT = TYPE.objectCode;
const asEmployment = (ctx: ApprovalContext) => ctx as unknown as EmploymentContext;

async function snapshot(tx: Tx, ctx: ApprovalContext, id: string): Promise<BusinessSnapshot> {
  const row = await loadHandoverRequest(tx, ctx.tenantId, id);
  const exit = await loadExitRequest(tx, ctx.tenantId, row.exitRequestId);
  const [employee] = rowsOf<{ code: string; name: string }>(
    await tx.execute(sql`SELECT code, name FROM employment_employees
      WHERE tenant_id=${ctx.tenantId} AND id=${row.employeeId}::uuid`),
  );
  const business = await loadEmploymentBusiness(
    tx,
    ctx.tenantId,
    row.exitRequestId,
    tenantLocalDate(ctx.now, ctx.timezone),
  );
  const current = await findCurrentRecord(tx, ctx.tenantId, row.employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  return {
    approvalType: 'exit_handover',
    businessType: 'exit_handover',
    businessId: id,
    businessDate: business?.effectiveDate,
    fieldObjectCode: HANDOVER_OBJECT,
    profileFields: [],
    subjectEmployeeId: row.employeeId,
    title: TYPE.name,
    values: {},
    originals: null,
    changedFields: [],
    handoverEmployeeId: exit?.handoverEmployeeId ?? null,
    conditionValues: {
      processCode: TYPE.defaultProcessCode,
      'business.kind': 'exit_handover',
      'employee.code': employee?.code ?? null,
      'employee.name': employee?.name ?? null,
      'record.departmentId': row.departmentId,
    },
    latestDepartmentId: current?.fields.departmentId ?? row.departmentId,
    recordDepartmentId: row.departmentId,
    version: `revision:${row.revision}`,
    processCode: TYPE.defaultProcessCode,
  };
}

const settle =
  (outcome: 'approved' | 'rejected' | 'disapproved' | 'withdrawn') => (tx: Tx, ctx: ApprovalContext, id: string) =>
    settleHandoverFromApproval(tx, asEmployment(ctx), id, outcome);

const unsupported = (message: string) => () => {
  throw approvalError('CONFLICT', 'APPROVAL_EDIT_UNSUPPORTED', message);
};

export const exitHandoverAdapter: BusinessAdapter = {
  async lock(tx, ctx, id) {
    await lockHandoverRequest(tx, asEmployment(ctx), id);
  },
  snapshot,
  approved: settle('approved'),
  rejected: settle('rejected'),
  disapproved: settle('disapproved'),
  withdrawn: settle('withdrawn'),
  resubmit: unsupported('离职交接申请不支持同单重提'),
  edit: unsupported('离职交接申请不支持审批中编辑，事项在交接详情里勾选办理'),
};
