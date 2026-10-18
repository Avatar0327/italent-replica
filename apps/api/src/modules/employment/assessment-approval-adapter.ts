/**
 * 审批中心的试用期考核适配器（R2 BE-15b1；docs/02_业务建模/29 PB-R3～R6）：业务单 = 考核记录，两个审批类型
 * （试用中考核 / 转正考核）共用，类型取考核记录上的 assessment_type。审批中心以可信身份回调，不带数据范围（DEC-057）。
 * - 快照：流程主体 = 考核对象本人（员工自评节点取 assessment_employee，经理评价节点取其直接上级 direct_manager），
 *   路由部门 = 创建时的主职部门；标题不含个人数据；表单即考核字段，审批中编辑按节点可编辑字段放行；
 * - 结果回写考核状态：通过 → 审批通过（并按审批时的转正意见生成转正任职记录，PB-R4 / R5）、不同意 → 不通过、
 *   驳回 → 已驳回、撤回 → 已作废；审批侧同单重提不开放（驳回后请重新发起，PR 假设）；
 * - PB-R6：生成只发生在 approved 回调里，且只读该时刻考核记录上的意见；之后改意见不补生成（updateAssessment）。
 * 取锁顺序：员工 → 考核记录（与发起入口“员工 → 新考核”一致）→ 审批实例。
 */
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  assessmentRegularization,
  ASSESSMENT_FORM_FIELDS,
  PROBATION_ASSESSMENT_OBJECT,
  tenantLocalDate,
  type ApprovalTypeCode,
} from '@italent/domain';
import { AppError } from '../../errors.js';
import type { BusinessAdapter, BusinessSnapshot } from '../approval/adapters.js';
import { rowsOf, type ApprovalContext } from '../approval/context.js';
import { applyApprovalEdit } from './assessment.js';
import { loadAssessment, saveAssessment, type AssessmentRow } from './assessment-store.js';
import { createRegularizationBusiness } from './regularization.js';
import { findCurrentRecord } from './read-model.js';
import { lockEmploymentEmployee } from './record-store.js';
import type { EmploymentContext } from './types.js';

const RESUBMIT = () => {
  throw new AppError('CONFLICT', '考核被驳回后请重新发起', { reason: 'APPROVAL_RESUBMIT_VIA_BUSINESS' });
};

const approvalTypeOf = (row: AssessmentRow): ApprovalTypeCode =>
  row.assessmentType === 'probation' ? 'probation_assessment' : 'regularization_assessment';

/** 员工锁在先、考核行锁在后（发起入口同序）；考核不存在时直接 404。 */
async function lockBoth(tx: Tx, ctx: ApprovalContext, id: string): Promise<AssessmentRow> {
  const [owner] = rowsOf<{ employee_id: string }>(
    await tx.execute(sql`SELECT employee_id FROM employment_probation_assessments
      WHERE tenant_id=${ctx.tenantId} AND id=${id}::uuid`),
  );
  if (!owner) throw new AppError('NOT_FOUND', '考核记录不存在');
  await lockEmploymentEmployee(tx, ctx, owner.employee_id);
  return loadAssessment(tx, ctx.tenantId, id, true);
}

async function employeeHeader(tx: Tx, tenantId: string, employeeId: string) {
  const [row] = rowsOf<{ code: string; name: string }>(
    await tx.execute(sql`SELECT code, name FROM employment_employees
      WHERE tenant_id=${tenantId} AND id=${employeeId}::uuid`),
  );
  if (!row) throw new AppError('NOT_FOUND', '人员不存在');
  return row;
}

async function snapshot(tx: Tx, ctx: ApprovalContext, id: string): Promise<BusinessSnapshot> {
  const row = await loadAssessment(tx, ctx.tenantId, id);
  const approvalType = approvalTypeOf(row);
  const type = APPROVAL_TYPES[approvalType];
  const employee = await employeeHeader(tx, ctx.tenantId, row.employeeId);
  const current = await findCurrentRecord(tx, ctx.tenantId, row.employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  const values = Object.fromEntries(ASSESSMENT_FORM_FIELDS.map((field) => [field, row[field]]));
  return {
    approvalType,
    businessType: 'probation_assessment',
    businessId: id,
    fieldObjectCode: PROBATION_ASSESSMENT_OBJECT,
    profileFields: [],
    subjectEmployeeId: row.employeeId,
    // 标题不含个人数据（DEC-057），待办与列表原样展示也不泄露被隐藏的姓名
    title: `${type.name}申请`,
    values,
    originals: null,
    // 新单据没有原值：有值的字段都是本单内容，审批人看不到即盲审（DEC-058）
    changedFields: ASSESSMENT_FORM_FIELDS.filter((field) => row[field] !== null),
    conditionValues: {
      processCode: type.defaultProcessCode,
      'employee.code': employee.code,
      'employee.name': employee.name,
      'employee.departmentId': current?.fields.departmentId ?? row.departmentId,
    },
    latestDepartmentId: current?.fields.departmentId ?? row.departmentId,
    recordDepartmentId: row.departmentId,
    version: `revision:${row.revision}`,
    processCode: type.defaultProcessCode,
  };
}

/**
 * PB-R4 / PB-R5：审批通过时按审批人选择的意见生成转正任职记录（直接办理，生效日 = 提前 / 延期转正日期或默认转正日期，
 * 未到生效日即“审批通过待生效”，到期自动生效）。业务拒绝（已转正、周期冲突、试用结果字典项被停用等）让整次审批回滚，
 * 审批人看到明确原因，HR 处理冲突后重新审批。
 */
async function generateRegularization(tx: Tx, ctx: ApprovalContext, row: AssessmentRow): Promise<string | null> {
  const plan = assessmentRegularization({
    type: row.assessmentType,
    opinion: row.regularizationOpinion,
    regularizationDate: row.regularizationDate,
  });
  if (!plan.generate) return null;
  const employee = await lockEmploymentEmployee(tx, ctx, row.employeeId);
  const created = await createRegularizationBusiness(
    tx,
    { ...ctx, expectedRevision: employee.revision } as EmploymentContext,
    row.employeeId,
    {
      kind: 'regularization',
      mode: 'direct',
      probationResult: plan.probationResult!,
      generatedByAssessment: true,
      ...(plan.effectiveDate ? { effectiveDate: plan.effectiveDate } : {}),
    },
  );
  return created.id;
}

async function approved(tx: Tx, ctx: ApprovalContext, id: string) {
  const row = await lockBoth(tx, ctx, id);
  // 只处理仍在审批中的考核（重复回调不重复生成）
  if (row.status !== 'in_review') return;
  const regularizationBusinessId = await generateRegularization(tx, ctx, row);
  await saveAssessment(
    tx,
    ctx as EmploymentContext,
    row,
    { status: 'approved', ...(regularizationBusinessId ? { regularizationBusinessId } : {}) },
    'approve',
  );
}

const settle = (status: 'rejected' | 'disapproved' | 'cancelled') => async (tx: Tx, ctx: ApprovalContext, id: string) => {
  const row = await lockBoth(tx, ctx, id);
  if (row.status === 'in_review') await saveAssessment(tx, ctx as EmploymentContext, row, { status }, status);
};

export const assessmentAdapter: BusinessAdapter = {
  async lock(tx, ctx, id) {
    await lockBoth(tx, ctx, id);
  },
  snapshot,
  approved,
  rejected: settle('rejected'),
  disapproved: settle('disapproved'),
  withdrawn: settle('cancelled'),
  resubmit: RESUBMIT,
  async edit(tx, ctx, id, fields) {
    await applyApprovalEdit(tx, ctx as EmploymentContext, id, fields);
  },
};
