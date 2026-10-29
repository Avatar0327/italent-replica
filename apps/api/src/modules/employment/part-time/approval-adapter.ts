/**
 * 审批中心的兼职申请适配器（docs/08_设计/R2-T05_兼职设计.md §4.5 / §4.5A，BE-7 PT-4a）：业务单 = 兼职申请（part_time_requests），
 * 三个审批类型（兼职 / 延长兼职 / 结束兼职）共用，类型取申请头的 request_type（PT-4a 新增，PT-4c 延长 / 结束）。审批中心以可信身份回调，不带数据范围（DEC-057）。
 * - 快照：流程主体 = 兼职人员，路由部门：主职部门 = 员工当前主职、兼职部门 = 申请的部门；标题不含个人数据；
 * - 延长 / 结束的快照：表单值沿用目标兼职记录的字段，原结束日期放 originals，变化字段只有结束日期与备注（盲审只看它们）；
 * - 同意 → 落地（request-service landApprovedRequest），驳回 / 不同意 / 撤回 → 对应状态事件；resubmit 拒绝（请在申请单上修改重提）；
 * - 审批编辑：合入改动后整体重校验，通过才追加版本（edit）；延长 / 结束只接结束日期与备注（A-14）；
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
import { linkageOf, lockLinkageParticipants } from './linkage.js';
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

/**
 * 单实例命令（同意 / 驳回 / 不同意 / 撤回 / 审批编辑 / 加签激活 / 手动交接与成员撤销 / 停用接管逐单）：员工 → 申请头 → 目标兼职记录头 →
 * （add / extend）组织锁。结束只缩短区间，不查部门可用性，不取（§4.5A）。
 * 改派类入口（reassignFrom = 原持有人）只在 mayAdvanceBusiness 为真（可能会签合席推进业务、落地时取组织锁）时取组织锁，
 * 与 lockMany 共用这一个判定（F-070）：否则交接已登记替代人（成员行 KEY SHARE）再回头等组织锁，与入职绑定的
 * “组织锁 → 成员行 FOR UPDATE”成环（#433 第 1 轮 P2-1）。
 */
async function lock(tx: Tx, ctx: ApprovalContext, requestId: string, reassignFrom?: string): Promise<void> {
  const owner = await partTimeRequestOwner(tx, ctx.tenantId, requestId);
  if (!owner) throw new AppError('NOT_FOUND', '兼职申请不存在');
  // 新增申请的同意 / 接管 / 审批编辑都可能当场落地并办联动（审批编辑当次才打开负责人也算）：一律先经联动单一规划入口收齐闭包
  // （本人 + 申请下属 + 规划里原有待执行 / 审批中的下属，UUID 升序，§7.1），之后落地只重入、复核；其余类型只锁本人
  if (owner.requestType === 'add') {
    const subordinates = await requestSubordinates(tx, ctx.tenantId, requestId);
    await lockLinkageParticipants(
      tx,
      asEmployment(ctx),
      owner.employeeId,
      linkageOf({ addedSubordinateIds: subordinates }),
      {
        mayLand: true,
      },
    );
  } else await lockEmploymentEmployee(tx, asEmployment(ctx), owner.employeeId);
  await tx.execute(sql`SELECT 1 FROM part_time_requests
    WHERE tenant_id=${ctx.tenantId} AND id=${requestId}::uuid FOR UPDATE`);
  if (owner.recordId)
    await tx.execute(sql`SELECT 1 FROM employment_business_objects
      WHERE tenant_id=${ctx.tenantId} AND id=${owner.recordId}::uuid FOR UPDATE`);
  if (owner.requestType !== 'end' && (await mayAdvanceBusiness(tx, ctx, [requestId], reassignFrom)))
    await lockOrganizationSettings(tx, ctx.tenantId);
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

/** 申请最新版本上的新增下属（不加锁读；审批中不可再改它，草稿期的改动在申请头锁内由落地重读）。 */
async function requestSubordinates(tx: Tx, tenantId: string, requestId: string): Promise<string[]> {
  const [row] = rowsOf<{ ids: string[] | null }>(
    await tx.execute(sql`SELECT added_subordinate_ids AS ids FROM part_time_request_versions
      WHERE tenant_id=${tenantId} AND request_id=${requestId}::uuid ORDER BY version_no DESC LIMIT 1`),
  );
  return row?.ids ?? [];
}

async function loadRequest(tx: Tx, ctx: ApprovalContext, requestId: string): Promise<PartTimeRequestRow> {
  const request = await loadPartTimeRequest(tx, ctx.tenantId, requestId);
  if (!request) throw new AppError('NOT_FOUND', '兼职申请不存在');
  return request;
}

const approvalTypeOf = (request: PartTimeRequestRow): ApprovalTypeCode => `part_time_${request.requestType}`;

/** 本单有值的字段都是本单内容（新单据没有原值）：审批人看不到即盲审（DEC-058）。 */
function filledFields(values: Row, codes: readonly string[]): string[] {
  return codes.filter((code) => values[code] !== null && values[code] !== undefined);
}

/**
 * 变更前与变化字段：新增申请没有原值，有值的字段都是本单内容；延长 / 结束只改结束日期（原值 = 原定结束日期）与备注，
 * 其余字段是目标兼职记录的现状，不算本单改动（审批人看不到它们不构成盲审）。
 */
function changes(request: PartTimeRequestRow, values: Row): Pick<BusinessSnapshot, 'originals' | 'changedFields'> {
  if (request.requestType === 'add')
    return { originals: null, changedFields: filledFields(values, Object.keys(values)) };
  const { version } = request;
  return {
    originals: { endDate: version.originalEndDate },
    changedFields: [
      ...(version.endDate === version.originalEndDate ? [] : ['endDate']),
      ...filledFields(values, ['requestRemark']),
    ],
  };
}

async function snapshot(tx: Tx, ctx: ApprovalContext, requestId: string): Promise<BusinessSnapshot> {
  const request = await loadRequest(tx, ctx, requestId);
  const { version } = request;
  const approvalType = approvalTypeOf(request);
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
    // 联动意图如实保留（F-280）：明确填“否”就是 false，只有没填才是 null；新增下属存员工 ID 列表，展示名由审批中心按人员字段解析。
    // 两项都是本单内容，无查看权的审批人走现有盲审口径（DEC-058），不另写一套裁剪
    isDepartmentHead: version.isDepartmentHead,
    addedSubordinateIds: version.addedSubordinateIds,
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
    ...changes(request, permissionFields),
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
  // DEC-634：新增节点开放“是否部门负责人”；新增下属不在审批编辑集合（F234A C9），节点没开放时被审批引擎先拦
  'isDepartmentHead',
] as const;

/** 延长 / 结束申请的审批编辑只接结束日期与备注（A-14）；新增申请接整张表单。 */
const DATE_REQUEST_EDITS: readonly string[] = ['endDate', 'requestRemark'];

function patchOf(request: PartTimeRequestRow, fields: Readonly<Row>): AddRequestPatch {
  const patch: Record<string, unknown> = {};
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    // 开始日期（effectiveDate）不论类型都走下面的“同值放行 / 异值拒绝”
    const outsideDateEdits = !DATE_REQUEST_EDITS.includes(key) && partTimeBusinessField(key) !== 'startDate';
    if (request.requestType !== 'add' && outsideDateEdits)
      throw new AppError('VALIDATION_FAILED', '延长 / 结束兼职审批只能编辑结束日期与备注', {
        reason: PART_TIME_ERRORS.fieldNotEditable,
        field: key,
      });
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
    await loadRequest(tx, ctx, id);
    await landApprovedRequest(tx, asEmployment(ctx), id);
  },
  rejected: (tx, ctx, id) => settleRequestFromApproval(tx, asEmployment(ctx), id, 'reject'),
  disapproved: (tx, ctx, id) => settleRequestFromApproval(tx, asEmployment(ctx), id, 'disapprove'),
  withdrawn: (tx, ctx, id) => settleRequestFromApproval(tx, asEmployment(ctx), id, 'withdraw'),
  resubmit: () => {
    throw approvalError('CONFLICT', 'APPROVAL_RESUBMIT_VIA_BUSINESS', '兼职申请请在申请单上修改后重新提交');
  },
  async edit(tx, ctx, id, fields) {
    const request = await loadRequest(tx, ctx, id);
    await editRequestInApproval(tx, asEmployment(ctx), id, patchOf(request, fields));
  },
};
