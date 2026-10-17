/**
 * 新增兼职的校验（docs/08_设计/R2-T05_兼职设计.md §4.2 / §4.3 D-1～D-10、§4.8）。结构与日期顺序校验是纯判断（normalizeNewPartTime），
 * 需要读库的校验（外派 / 借调唯一、部门可用性与设立日、引用）都在员工行锁内由 validatePartTimeReferences 做。
 * 主职周期边界（D-2～D-4）在 boundary.ts 的 assertPartTimeWithinCycle，与本文件分开，因为编辑 / 延长也要调。
 */
import { sql, type Tx } from '@italent/db';
import {
  PART_TIME_ERRORS,
  PART_TIME_SERVICE_TYPES,
  addDays,
  exclusivePartTimeConflict,
  tenantLocalDate,
  type PartTimeServiceType,
} from '@italent/domain';
import { AppError } from '../../../errors.js';
import { invalid } from '../../job/validation.js';
import { partTimeCurrentEndSql } from './span-sql.js';
import { getCustomFieldsForInheritance } from '../configuration.js';
import { businessDate, validateCustomValue } from '../fields.js';
import { rowsOf } from '../record-store.js';
import { assertEmploymentDepartmentAvailableWithin, validateEmploymentReferences } from '../references.js';
import { emptyPresetFields } from '../types.js';
import type { EmploymentContext, PresetFields } from '../types.js';

/** 兼职表单可填的预置字段（§4.2：职位、职务、职级、序列、直线 / 虚线经理、用工形式、人员类别）；部门单列、必填。 */
export const PART_TIME_FIELD_KEYS = [
  'positionId',
  'postId',
  'levelId',
  'sequenceId',
  'directManagerId',
  'dottedManagerId',
  'employmentForm',
  'employmentType',
] as const;
export type PartTimeFieldKey = (typeof PART_TIME_FIELD_KEYS)[number];

export interface NewPartTimeInput extends Partial<Pick<PresetFields, PartTimeFieldKey>> {
  readonly employeeId: string;
  readonly serviceType: PartTimeServiceType;
  readonly startDate: string;
  readonly endDate?: string | null;
  readonly departmentId: string;
  readonly customFields?: Readonly<Record<string, unknown>>;
  /** PT-7 前不接受（§4.8）：给 true / 非空数组一律拒绝，不留“记录说是负责人、组织上不是”的半套状态。 */
  readonly isDepartmentHead?: boolean | null;
  readonly addedSubordinateIds?: readonly string[] | null;
}

export interface NormalizedPartTime {
  readonly employeeId: string;
  readonly serviceType: PartTimeServiceType;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly departmentId: string;
  readonly fields: Pick<PresetFields, PartTimeFieldKey | 'departmentId'>;
  readonly customFields: Readonly<Record<string, unknown>>;
  readonly explicitFieldCodes: readonly string[];
}

/** D-1 与结构校验：全部是纯判断，无 IO；失败时尚未取任何锁、也没有任何写入。 */
export function normalizeNewPartTime(input: NewPartTimeInput): NormalizedPartTime {
  if (!(PART_TIME_SERVICE_TYPES as readonly string[]).includes(input.serviceType))
    throw invalid('partTimeType', '兼职类型必须是兼职、借调或外派');
  const startDate = businessDate(input.startDate);
  const endDate = input.endDate == null ? null : businessDate(input.endDate);
  if (endDate !== null && endDate < startDate)
    throw new AppError('VALIDATION_FAILED', '结束日期不能早于开始日期', {
      reason: PART_TIME_ERRORS.endBeforeStart,
      field: 'endDate',
    });
  if (input.isDepartmentHead === true || input.addedSubordinateIds?.length)
    throw new AppError('VALIDATION_FAILED', '兼职暂不支持设置部门负责人或新增下属', {
      reason: PART_TIME_ERRORS.linkageNotAvailable,
    });
  const fields = Object.fromEntries(PART_TIME_FIELD_KEYS.map((key) => [key, input[key] ?? null])) as Pick<
    PresetFields,
    PartTimeFieldKey
  >;
  const given = PART_TIME_FIELD_KEYS.filter((key) => input[key] != null);
  return {
    employeeId: input.employeeId,
    serviceType: input.serviceType,
    startDate,
    endDate,
    departmentId: input.departmentId,
    fields: { ...fields, departmentId: input.departmentId },
    customFields: input.customFields ?? {},
    explicitFieldCodes: ['departmentId', ...given].map((key) => `preset:${key}`),
  };
}

/** 兼职记录的完整预置字段组：表单字段 + 系统派生的 job_number（员工工号）与 employ_type（所属周期雇佣关系）。 */
export function partTimePresetFields(
  normalized: NormalizedPartTime,
  derived: { readonly jobNumber: string; readonly employType: PresetFields['employType'] },
): PresetFields {
  return { ...emptyPresetFields(), ...normalized.fields, ...derived };
}

/** D-5：外派 / 借调同时只能有一条未结束（含草稿 / 审批中 / 驳回的新增申请，A-7）。 */
export async function assertExclusiveTypeFree(
  tx: Tx,
  ctx: EmploymentContext,
  normalized: Pick<NormalizedPartTime, 'employeeId' | 'serviceType'>,
): Promise<void> {
  const { employeeId, serviceType } = normalized;
  const records = rowsOf<{ serviceType: string; startDate: string; endDate: string | null }>(
    await tx.execute(sql`
      SELECT r.service_type AS "serviceType", r.start_date::text AS "startDate", ${partTimeCurrentEndSql(
        ctx.tenantId,
        sql`r.id`,
      )}::text AS "endDate"
      FROM employment_records r
      WHERE r.tenant_id=${ctx.tenantId} AND r.employee_id=${employeeId}::uuid
        AND r.service_type IN ('secondment', 'expatriate')
    `),
  );
  const pending = rowsOf<{ serviceType: string }>(
    await tx.execute(sql`
      SELECT v.service_type AS "serviceType" FROM part_time_requests q
      JOIN LATERAL (SELECT state FROM part_time_request_events
        WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY event_no DESC LIMIT 1) s ON true
      JOIN LATERAL (SELECT service_type FROM part_time_request_versions
        WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY version_no DESC LIMIT 1) v ON true
      WHERE q.tenant_id=${ctx.tenantId} AND q.employee_id=${employeeId}::uuid AND q.request_type='add'
        AND s.state IN ('draft', 'in_review', 'rejected')
    `),
  ).map((row) => row.serviceType);
  if (
    exclusivePartTimeConflict({
      serviceType,
      records,
      pending,
      today: tenantLocalDate(ctx.now, ctx.timezone),
    })
  )
    throw new AppError('CONFLICT', '该人员还有未结束的借调/外派/返聘记录，不能再新增', {
      reason: PART_TIME_ERRORS.exclusiveTypeExists,
    });
}

/** D-9：兼职开始日不得早于部门设立日（首版生效日，DEC-130）。 */
async function assertNotBeforeFounded(tx: Tx, ctx: EmploymentContext, departmentId: string, startDate: string) {
  const [first] = rowsOf<{ name: string; founded: string }>(
    await tx.execute(sql`SELECT name, start_date::text AS founded FROM org_versions
      WHERE tenant_id=${ctx.tenantId} AND org_id=${departmentId}::uuid ORDER BY start_date, version_no LIMIT 1`),
  );
  if (first && startDate < first.founded)
    throw new AppError(
      'VALIDATION_FAILED',
      `兼职开始日期（${startDate}）不能早于兼职部门【${first.name}】的最早生效日期（${first.founded}）`,
      { reason: 'ENTRY_BEFORE_DEPARTMENT_FOUNDED', founded: first.founded },
    );
}

/**
 * D-7 / D-8 / D-9：兼职部门在 [startDate, endDate] 内每天可用（与主职入职 / 调动同一口径，持组织锁），
 * 引用按开始日解析；经理须在开始日在职且不是本人。兼职不进汇报关系图，不传 reporting（不做循环校验，P-34）。
 */
export async function validatePartTimeReferences(
  tx: Tx,
  ctx: EmploymentContext,
  normalized: NormalizedPartTime,
  fields: PresetFields,
): Promise<void> {
  const { departmentId, startDate, endDate, employeeId } = normalized;
  await assertNotBeforeFounded(tx, ctx, departmentId, startDate);
  await assertEmploymentDepartmentAvailableWithin(tx, ctx, departmentId, startDate, endDate && addDays(endDate, 1));
  for (const [field, id] of [
    ['directManagerId', fields.directManagerId],
    ['dottedManagerId', fields.dottedManagerId],
  ] as const)
    if (id === employeeId) throw invalid(field, '经理不能是本人');
  await validateEmploymentReferences(tx, ctx, fields, startDate);
}

/**
 * 自定义字段（§1.1 custom_fields：任职对象自定义字段按定义校验，不继承）：字段必须是本租户任职对象的定义（合同对象的、
 * 未知的一律拒绝），数量不超过处理上限，值按字段类型校验；返回通过校验的值与对应的 custom:<id> 显式字段编码。
 * 与主职入职 / 编辑同一个读取与校验入口（getCustomFieldsForInheritance + validateCustomValue）。
 */
export async function validatePartTimeCustomFields(
  tx: Tx,
  ctx: EmploymentContext,
  given: Readonly<Record<string, unknown>>,
): Promise<{
  readonly customFields: Record<string, ReturnType<typeof validateCustomValue>>;
  readonly codes: string[];
}> {
  const entries = Object.entries(given);
  if (!entries.length) return { customFields: {}, codes: [] };
  if (entries.length > 200) throw new AppError('VALIDATION_FAILED', '单次自定义字段超过处理上限');
  const definitions = await getCustomFieldsForInheritance(tx, ctx.tenantId);
  const customFields: Record<string, ReturnType<typeof validateCustomValue>> = {};
  for (const [id, value] of entries) {
    const definition = definitions.find((field) => field.id === id);
    if (!definition)
      throw new AppError('VALIDATION_FAILED', '自定义字段不属于本租户任职对象', { field: `custom:${id}` });
    customFields[id] = validateCustomValue(value, definition.valueType);
  }
  return { customFields, codes: Object.keys(customFields).map((id) => `custom:${id}`) };
}
