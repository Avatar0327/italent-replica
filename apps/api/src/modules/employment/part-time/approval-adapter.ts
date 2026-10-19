/**
 * 审批中心的兼职申请适配器（docs/08_设计/R2-T05_兼职设计.md §4.5 / §4.5A，BE-7 PT-4a）：业务单 = 兼职申请（part_time_requests），
 * 三个审批类型（兼职 / 延长兼职 / 结束兼职）共用，类型取申请头的 request_type；PT-4a 只接 add，延长 / 结束的回调 409
 * PART_TIME_REQUEST_TYPE_NOT_AVAILABLE（随 PT-4c）。审批中心以可信身份回调，不带数据范围（DEC-057）。
 * - 快照：流程主体 = 兼职人员，路由部门：主职部门 = 员工当前主职、兼职部门 = 申请的部门；标题不含个人数据；
 * - 同意 → 落地（request-service landApprovedRequest），驳回 / 不同意 / 撤回 → 对应状态事件；resubmit 拒绝（请在申请单上修改重提）；
 * - 审批编辑：合入改动后整体重校验，通过才追加版本（edit）；
 * - 资源锁计划（§4.5A，全局锁序 员工 → 业务头 → 组织 → 实例）：lock / lockMany 先取组织锁再锁实例，与批量交接的
 *   “入职绑定账号：组织锁 → 成员行”同序（F-065），落地内的组织锁只重入。
 */
import { sql, type Tx } from '@italent/db';
import {
  APPROVAL_TYPES,
  MODULE_OBJECTS,
  PROFILE_FORM_FIELDS,
  PART_TIME_ERRORS,
  partTimeBusinessField,
  partTimePermissionFields,
  tenantLocalDate,
} from '@italent/domain';
import type { ApprovalTypeCode } from '@italent/domain';
import { AppError } from '../../../errors.js';
import { employeeHeader, mayAdvanceBusiness, profileValues } from '../../approval/adapter-support.js';
import type { BusinessAdapter, BusinessSnapshot } from '../../approval/adapters.js';
import { approvalError, rowsOf, type ApprovalContext, type Row } from '../../approval/context.js';
import { lockOrganizationSettings } from '../../org/locks.js';
import { findCurrentRecord } from '../read-model.js';
import { lockEmploymentEmployee } from '../record-store.js';
import type { EmploymentContext } from '../types.js';
import { loadPartTimeRequest, partTimeRequestOwner, type PartTimeRequestRow } from './request-store.js';
import {
  editRequestInApproval,
  landApprovedRequest,
  settleRequestFromApproval,
  type AddRequestPatch,
} from './request-service.js';

const asEmployment = (ctx: ApprovalContext): EmploymentContext =>
  ({ ...ctx, expectedRevision: 0 }) as EmploymentContext;
const idArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

const typeNotAvailable = () =>
  new AppError('CONFLICT', '该类兼职申请暂未开放', { reason: PART_TIME_ERRORS.requestTypeNotAvailable });

/** 单实例命令（同意 / 驳回 / 不同意 / 撤回 / 审批编辑 / 加签激活）：员工 → 申请头 → 目标兼职记录头 →（add / extend）组织锁。 */
async function lock(tx: Tx, ctx: ApprovalContext, requestId: string): Promise<void> {
  const owner = await partTimeRequestOwner(tx, ctx.tenantId, requestId);
  if (!owner) throw new AppError('NOT_FOUND', '兼职申请不存在');
  await lockEmploymentEmployee(tx, asEmployment(ctx), owner.employeeId);
  await tx.execute(sql`SELECT 1 FROM part_time_requests
    WHERE tenant_id=${ctx.tenantId} AND id=${requestId}::uuid FOR UPDATE`);
  if (owner.recordId)
    await tx.execute(sql`SELECT 1 FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${owner.recordId}::uuid FOR UPDATE`);
  // 落地要查部门可用性（D-7 / E-3）持组织锁；结束只缩短区间，不查，不取（§4.5A）
  if (owner.requestType !== 'end') await lockOrganizationSettings(tx, ctx.tenantId);
}

/**
 * 批量交接 / 全局停用接管：员工闭包已由 lockHandoverParticipants 取得；这里申请头按 ID 升序 → 目标兼职记录头按 ID 升序，
 * 再按与 employment 适配器 lockMany 相同的判定取组织锁：organization 且批内有 add / extend，且（没有 reassignFrom，
 * 或本批可能因会签合席推进业务）。撤销成员关系的接管（organization = false）不预取，落地时由 lock 按既有顺序取得。
 */
async function lockMany(
  tx: Tx,
  ctx: ApprovalContext,
  requestIds: readonly string[],
  options: { readonly organization: boolean; readonly reassignFrom?: string },
): Promise<void> {
  if (!requestIds.length) return;
  const heads = rowsOf<{ requestType: string; recordId: string | null }>(
    await tx.execute(sql`SELECT request_type AS "requestType", record_id AS "recordId" FROM part_time_requests
      WHERE tenant_id=${ctx.tenantId} AND id = ANY(${idArray(requestIds)}) ORDER BY id FOR UPDATE`),
  );
  const records = heads.flatMap((head) => (head.recordId ? [head.recordId] : [])).sort();
  if (records.length)
    await tx.execute(sql`SELECT 1 FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id = ANY(${idArray(records)}) ORDER BY id FOR UPDATE`);
  if (!options.organization || !heads.some((head) => head.requestType !== 'end')) return;
  if (await mayAdvanceBusiness(tx, ctx, requestIds, options.reassignFrom))
    await lockOrganizationSettings(tx, ctx.tenantId);
}

async function loadAdd(tx: Tx, ctx: ApprovalContext, requestId: string): Promise<PartTimeRequestRow> {
  const request = await loadPartTimeRequest(tx, ctx.tenantId, requestId);
  if (!request) throw new AppError('NOT_FOUND', '兼职申请不存在');
  if (request.requestType !== 'add') throw typeNotAvailable();
  return request;
}

const approvalTypeOf = (): ApprovalTypeCode => 'part_time_add';

/** 本单有值的字段都是本单内容（新单据没有原值）：审批人看不到即盲审（DEC-058）。 */
function filledFields(values: Row, codes: readonly string[]): string[] {
  return codes.filter((code) => values[code] !== null && values[code] !== undefined);
}

async function snapshot(tx: Tx, ctx: ApprovalContext, requestId: string): Promise<BusinessSnapshot> {
  const request = await loadAdd(tx, ctx, requestId);
  const { version } = request;
  const approvalType = approvalTypeOf();
  const type = APPROVAL_TYPES[approvalType];
  const employee = await employeeHeader(tx, ctx.tenantId, request.employeeId);
  const primary = await findCurrentRecord(tx, ctx.tenantId, request.employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  const custom = Object.fromEntries(Object.entries(version.customFields).map(([id, value]) => [`custom:${id}`, value]));
  const content: Row = {
    partTimeType: version.serviceType,
    departmentId: version.departmentId,
    positionId: version.positionId,
    postId: version.postId,
    levelId: version.levelId,
    sequenceId: version.sequenceId,
    directManagerId: version.directManagerId,
    dottedManagerId: version.dottedManagerId,
    employmentType: version.employmentType,
    employmentForm: version.employmentForm,
    startDate: version.startDate,
    endDate: version.endDate,
    originalEndDate: version.originalEndDate,
    requestRemark: version.remark,
    ...custom,
  };
  // 快照的表单值与变化字段都用任职记录权限目录里的编码（startDate → effectiveDate），否则盲审永远判不过
  const permissionFields = partTimePermissionFields(content);
  const processCode = request.processCode ?? type.defaultProcessCode;
  return {
    approvalType,
    businessType: 'part_time',
    businessId: requestId,
    fieldObjectCode: MODULE_OBJECTS.employmentRecord.code,
    profileFields: PROFILE_FORM_FIELDS,
    subjectEmployeeId: request.employeeId,
    // 标题不含个人数据（DEC-057，适配器清单 8），待办与列表原样展示也不泄露被隐藏的姓名
    title: `${type.name}申请`,
    values: {
      ...permissionFields,
      kind: request.requestType,
      // 主职信息分组：读员工当前主职，不存快照（R2d）
      primaryDepartmentId: primary?.fields.departmentId ?? null,
      primaryPostId: primary?.fields.postId ?? null,
      primaryLevelId: primary?.fields.levelId ?? null,
      ...(await profileValues(tx, ctx, request.employeeId)),
    },
    originals: null,
    changedFields: filledFields(permissionFields, Object.keys(permissionFields)),
    conditionValues: {
      processCode,
      'business.kind': request.requestType,
      'employee.code': employee.code,
      'employee.name': employee.name,
      'record.departmentId': version.departmentId,
      'employee.departmentId': primary?.fields.departmentId ?? null,
    },
    // 路由部门：主职部门 = 员工当前主职；兼职部门 = 申请的部门（§4.5）
    latestDepartmentId: primary?.fields.departmentId ?? null,
    recordDepartmentId: version.departmentId,
    version: `version:${version.id}`,
    processCode,
  };
}

/** 审批表单的字段编码 → 申请载荷（可编辑集合由节点配置，这里是适配器接得住的全集）。 */
const PRESET_EDITS = [
  'departmentId',
  'positionId',
  'postId',
  'levelId',
  'sequenceId',
  'directManagerId',
  'dottedManagerId',
  'employmentForm',
  'employmentType',
  'endDate',
] as const;

function patchOf(request: PartTimeRequestRow, fields: Readonly<Row>): AddRequestPatch {
  const patch: Record<string, unknown> = {};
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if ((PRESET_EDITS as readonly string[]).includes(key)) patch[key] = value;
    else if (key === 'partTimeType') patch.serviceType = value;
    else if (key === 'requestRemark') patch.remark = value;
    else if (key.startsWith('custom:')) customFields[key.slice('custom:'.length)] = value;
    // 审批表单用权限编码（effectiveDate），业务字段名 startDate 本身不是表单字段
    else if (key !== 'startDate' && partTimeBusinessField(key) === 'startDate') {
      if (value === request.version.startDate) continue;
      throw new AppError('VALIDATION_FAILED', '兼职开始日期不能在审批中修改', {
        reason: PART_TIME_ERRORS.dateImmutable,
        field: key,
      });
    } else
      throw new AppError('VALIDATION_FAILED', '该字段不能在兼职审批中编辑', {
        reason: PART_TIME_ERRORS.fieldNotEditable,
        field: key,
      });
  }
  return Object.keys(customFields).length ? { ...patch, customFields } : patch;
}

export const partTimeAdapter: BusinessAdapter = {
  lock,
  lockMany,
  snapshot,
  async approved(tx, ctx, id) {
    await loadAdd(tx, ctx, id);
    await landApprovedRequest(tx, asEmployment(ctx), id);
  },
  rejected: (tx, ctx, id) => settleRequestFromApproval(tx, asEmployment(ctx), id, 'reject'),
  disapproved: (tx, ctx, id) => settleRequestFromApproval(tx, asEmployment(ctx), id, 'disapprove'),
  withdrawn: (tx, ctx, id) => settleRequestFromApproval(tx, asEmployment(ctx), id, 'withdraw'),
  resubmit: () => {
    throw approvalError('CONFLICT', 'APPROVAL_RESUBMIT_VIA_BUSINESS', '兼职申请请在申请单上修改后重新提交');
  },
  async edit(tx, ctx, id, fields) {
    const request = await loadAdd(tx, ctx, id);
    await editRequestInApproval(tx, asEmployment(ctx), id, patchOf(request, fields));
  },
};
