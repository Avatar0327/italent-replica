/**
 * 兼职申请的读形状（docs/08_设计/R2-T05_兼职设计.md §6.3 / §7.3A，PT-4b）：写回执与详情共用一个 DTO，形状沿用任职记录
 * （开始日期用 effectiveDate 编码、预置字段放 fields、自定义字段放 customFields），所以统一结果复核（permission/employment-replay.ts
 * responseSnapshots：id + employeeId + fields.departmentId）和 trimEmploymentResponse 的逐字段裁剪都直接适用。
 * 详情另带两个分组（R2d：主职信息 / 员工信息分组读员工当前主职，不存快照）：主职分组只在操作人看得到该主职记录时给出。
 */
import { sql, type Tx } from '@italent/db';
import { tenantLocalDate, type PartTimeRequestState, type PartTimeRequestType } from '@italent/domain';
import { rowsOf } from '../record-store.js';
import { employeeHeader } from '../../approval/adapter-support.js';
import { findCurrentRecord } from '../read-model.js';
import type { CustomFields, EmploymentContext, PresetFields } from '../types.js';
import { isEmploymentRecordVisible } from '../visibility.js';
import { loadPartTimeRequest, type PartTimeRequestRow } from './request-store.js';

export interface PartTimeRequestDto {
  readonly id: string;
  readonly employeeId: string;
  /** 申请头 revision（If-Match）。 */
  readonly revision: number;
  /** 申请类型（沿用任职记录的 kind 编码）。 */
  readonly kind: PartTimeRequestType;
  /** 申请状态（沿用 status 编码）。 */
  readonly status: PartTimeRequestState;
  readonly initiator: string;
  readonly processCode: string | null;
  readonly versionNo: number;
  readonly serviceType: string;
  /** 兼职开始日期（沿用任职记录的 effectiveDate 编码，字段权限同任职记录对象）。 */
  readonly effectiveDate: string;
  /** 新增：结束日期；延长：新结束日期；结束：结束日期。 */
  readonly endDate: string | null;
  /** 延长 / 结束：申请创建时目标兼职的原定结束日期（申请版本字段，不被落地后的实际失效日覆盖，R2f1）；新增为 null。 */
  readonly originalEndDate: string | null;
  readonly requestRemark: string | null;
  /** 延长 / 结束：目标兼职记录；新增：审批通过并落地后的兼职记录（落地前为空）。 */
  readonly recordId: string | null;
  readonly institutionId: string | null;
  readonly fields: Partial<PresetFields>;
  readonly customFields: CustomFields;
  readonly warnings: readonly { readonly reason: string }[];
}

export interface PartTimeRequestDetail extends PartTimeRequestDto {
  readonly primary: { readonly id: string; readonly fields: PresetFields } | null;
  readonly employee: { readonly code: string; readonly name: string };
}

/** 申请 → DTO；warnings 是写入时 B-4 等只提示不拦的信息（读取时为空）。 */
export function requestDto(
  request: PartTimeRequestRow,
  extra: { readonly recordId?: string | null; readonly warnings?: readonly string[] } = {},
): PartTimeRequestDto {
  const { version } = request;
  return {
    id: request.id,
    employeeId: request.employeeId,
    revision: request.revision,
    kind: request.requestType,
    status: request.state,
    initiator: request.initiator,
    processCode: request.processCode,
    institutionId: version.institutionId,
    versionNo: version.versionNo,
    serviceType: version.serviceType,
    effectiveDate: version.startDate,
    endDate: version.endDate,
    originalEndDate: version.originalEndDate,
    requestRemark: version.remark,
    recordId: extra.recordId ?? request.recordId,
    fields: {
      departmentId: version.departmentId,
      positionId: version.positionId,
      postId: version.postId,
      levelId: version.levelId,
      sequenceId: version.sequenceId,
      directManagerId: version.directManagerId,
      dottedManagerId: version.dottedManagerId,
      employmentType: version.employmentType,
      employmentForm: version.employmentForm,
      // 联动字段（§4.8，PT-7）：只新增申请有值；落地前只是申请上的意图，不代表组织上已经是负责人 / 下属已改
      ...(version.isDepartmentHead !== null ? { isDepartmentHead: version.isDepartmentHead } : {}),
      ...(version.addedSubordinateIds ? { addedSubordinateIds: version.addedSubordinateIds } : {}),
    } as Partial<PresetFields>,
    customFields: version.customFields,
    warnings: (extra.warnings ?? []).map((reason) => ({ reason })),
  };
}

/** 写入后读回执：写入后读不到只可能是存储异常（调用方判空）。 */
export async function loadRequestReceipt(
  tx: Tx,
  ctx: Pick<EmploymentContext, 'tenantId'>,
  id: string,
  warnings: readonly string[] = [],
): Promise<PartTimeRequestDto | null> {
  const request = await loadPartTimeRequest(tx, ctx.tenantId, id);
  return request ? requestDto(request, { warnings }) : null;
}

/** 落地成功的兼职记录 ID：申请最新的 effective 事件上的 record_id。 */
async function landedRecordId(tx: Tx, tenantId: string, requestId: string): Promise<string | null> {
  const [row] = rowsOf<{ recordId: string | null }>(
    await tx.execute(sql`SELECT record_id::text AS "recordId" FROM part_time_request_events
      WHERE tenant_id=${tenantId} AND request_id=${requestId}::uuid AND state='effective'
      ORDER BY event_no DESC LIMIT 1`),
  );
  return row?.recordId ?? null;
}

/**
 * 申请详情。可见 = DEC-177 两项并集（申请部门 ∪ 员工当前主职部门，“使用用户”维度取发起人）；不存在与不可见同为 null，
 * 由路由统一 404。主职分组：员工当前主职记录，操作人看不到它（员工主职部门不在范围内，如只管兼职部门的 HR）时为 null。
 */
export async function loadPartTimeRequestDetail(
  tx: Tx,
  ctx: EmploymentContext,
  id: string,
): Promise<PartTimeRequestDetail | null> {
  const request = await loadPartTimeRequest(tx, ctx.tenantId, id);
  if (!request) return null;
  const visible = await isEmploymentRecordVisible(tx, ctx.tenantId, ctx.scope, {
    employeeId: request.employeeId,
    departmentId: request.version.departmentId,
    creatorId: request.initiatorUserId,
  });
  if (!visible) return null;
  const primary = await findCurrentRecord(tx, ctx.tenantId, request.employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  const primaryVisible =
    primary &&
    (await isEmploymentRecordVisible(tx, ctx.tenantId, ctx.scope, {
      employeeId: request.employeeId,
      departmentId: primary.fields.departmentId,
    }));
  return {
    ...requestDto(request, { recordId: await landedRecordId(tx, ctx.tenantId, id) }),
    primary: primaryVisible ? { id: primary.id, fields: primary.fields } : null,
    employee: await employeeHeader(tx, ctx.tenantId, request.employeeId),
  };
}
