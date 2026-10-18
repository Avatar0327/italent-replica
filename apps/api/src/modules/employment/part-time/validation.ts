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
  partTimeServiceStatus,
  tenantLocalDate,
  type PartTimeServiceType,
} from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../../errors.js';
import { invalid } from '../../job/validation.js';
import { partTimeRecordCreator } from './creator-sql.js';
import { partTimeNotFound } from './read.js';
import { partTimeCurrentEndSql } from './span-sql.js';
import { uuidArray, type PartTimeRecordRow } from './store.js';
import { getCustomFieldsForInheritance } from '../configuration.js';
import { requireScopedEmploymentObject } from '../context.js';
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

/** D-1 / T-1：结束日期不能早于开始日期（原站原文，R2d）。 */
const endBeforeStart = () =>
  new AppError('VALIDATION_FAILED', '结束日期不能早于开始日期', {
    reason: PART_TIME_ERRORS.endBeforeStart,
    field: 'endDate',
  });

/** PT-7 前不接受负责人 / 新增下属（§4.8）：新增与编辑共用，给 true / 非空数组一律拒绝，不静默丢弃。 */
function assertNoLinkage(input: Pick<NewPartTimeInput, 'isDepartmentHead' | 'addedSubordinateIds'>): void {
  if (input.isDepartmentHead === true || input.addedSubordinateIds?.length)
    throw new AppError('VALIDATION_FAILED', '兼职暂不支持设置部门负责人或新增下属', {
      reason: PART_TIME_ERRORS.linkageNotAvailable,
    });
}

/** D-1 与结构校验：全部是纯判断，无 IO；失败时尚未取任何锁、也没有任何写入。 */
export function normalizeNewPartTime(input: NewPartTimeInput): NormalizedPartTime {
  if (!(PART_TIME_SERVICE_TYPES as readonly string[]).includes(input.serviceType))
    throw invalid('partTimeType', '兼职类型必须是兼职、借调或外派');
  const startDate = businessDate(input.startDate);
  const endDate = input.endDate == null ? null : businessDate(input.endDate);
  if (endDate !== null && endDate < startDate) throw endBeforeStart();
  assertNoLinkage(input);
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
  normalized: Pick<NormalizedPartTime, 'employeeId' | 'startDate' | 'endDate' | 'departmentId'>,
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

// ---- PT-3c 编辑与批量结束（§4.4 / §5.1）-------------------------------------------------------------------------------

/** PATCH 入参（服务层，扁平）：缺省键 = 不改，显式 null 表示清空该预置字段；startDate / serviceType 只用于拒绝改动。 */
export interface EditPartTimeInput extends Partial<Pick<PresetFields, PartTimeFieldKey | 'departmentId'>> {
  readonly endDate?: string | null;
  readonly startDate?: string;
  readonly serviceType?: PartTimeServiceType;
  readonly customFields?: Readonly<Record<string, unknown>>;
  readonly isDepartmentHead?: boolean | null;
  readonly addedSubordinateIds?: readonly string[] | null;
}

export type EditableFieldKey = PartTimeFieldKey | 'departmentId';
export const EDITABLE_FIELD_KEYS: readonly EditableFieldKey[] = [...PART_TIME_FIELD_KEYS, 'departmentId'];

export interface PartTimeEditPlan {
  /** 编辑后的结束日期（无变化时即当前值）。 */
  readonly endDate: string | null;
  readonly endChanged: boolean;
  /** 合入改动后的预置字段整组。 */
  readonly fields: PresetFields;
  readonly changes: readonly { field: EditableFieldKey; before: string | null; after: string | null }[];
}

/**
 * 编辑的纯规划（无 IO）：开始日期 / 任职类型改成别的值 → 400（A-9，同值是无操作）；结束日期不能置空（仅当已有结束日）、
 * 不能早于开始日期（T-1）；联动字段 PT-7 前拒绝。调用方在员工行锁与记录头锁内传入锁内读到的当前值。
 */
export function planPartTimeEdit(
  row: Pick<PartTimeRecordRow, 'startDate' | 'serviceType' | 'endDate'>,
  current: PresetFields,
  input: EditPartTimeInput,
): PartTimeEditPlan {
  const immutable = (reason: string, message: string, field: string) =>
    new AppError('VALIDATION_FAILED', message, { reason, field });
  if (input.startDate !== undefined && input.startDate !== row.startDate)
    throw immutable(PART_TIME_ERRORS.dateImmutable, '兼职开始日期创建后不可修改', 'startDate');
  if (input.serviceType !== undefined && input.serviceType !== row.serviceType)
    throw immutable(PART_TIME_ERRORS.typeImmutable, '兼职类型创建后不可修改', 'partTimeType');
  assertNoLinkage(input);
  let endDate = row.endDate;
  if (input.endDate === null && row.endDate !== null)
    throw new AppError('VALIDATION_FAILED', '结束日期不能置空', {
      reason: PART_TIME_ERRORS.endDateRequired,
      field: 'endDate',
    });
  if (input.endDate != null) {
    endDate = businessDate(input.endDate);
    if (endDate < row.startDate) throw endBeforeStart();
  }
  if (Object.hasOwn(input, 'departmentId') && !input.departmentId) throw invalid('departmentId', '兼职部门不能为空');
  const changes = EDITABLE_FIELD_KEYS.filter((key) => Object.hasOwn(input, key) && input[key] !== current[key]).map(
    (key) => ({ field: key, before: current[key] as string | null, after: (input[key] ?? null) as string | null }),
  );
  return {
    endDate,
    endChanged: endDate !== row.endDate,
    fields: { ...current, ...Object.fromEntries(changes.map((change) => [change.field, change.after])) },
    changes,
  };
}

/** 查不到创建人时的占位：不属于任何用户，“使用用户”维度因此不命中（fail-closed）。 */
const NO_CREATOR = '00000000-0000-0000-0000-000000000000';

/**
 * 写入口径范围（§7.2 编辑行，DEC-193）：员工、兼职部门坐标 + 记录创建人（“使用用户”维度，兼职口径 creator-sql）判数据范围，
 * 与直接操作共用 requireScopedEmploymentObject；范围外与不存在同一个 404（PART_TIME_RECORD_NOT_FOUND）。
 * requireScopedEmploymentObject 对未给业务 ID 的对象把操作人当作创建人（新建），已有兼职要按真实创建人判，所以替换 userId。
 * 看全部 / 可信端口（无 scope）不设限。入口、命令内复核与服务共用。
 */
export async function requirePartTimeRecordScope(
  tx: Tx,
  ctx: EmploymentContext,
  record: Pick<PartTimeRecordRow, 'id' | 'employeeId'>,
  departmentId: string | null,
): Promise<void> {
  if (!ctx.scope || ctx.scope.all) return;
  let userId = ctx.userId;
  if (ctx.scope.terms?.some((term) => term.dimension === 'using_user')) {
    const [row] = rowsOf<{ creator: string | null }>(
      await tx.execute(sql`SELECT ${partTimeRecordCreator(ctx.tenantId, sql`${record.id}::uuid`)} AS creator`),
    );
    userId = row?.creator ?? NO_CREATOR;
  }
  try {
    await requireScopedEmploymentObject(tx, { ...ctx, userId }, record.employeeId, departmentId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') throw partTimeNotFound();
    throw error;
  }
}

/** E-4：有未办结（草稿 / 审批中 / 驳回）的延长或结束申请的兼职记录 ID。 */
export async function openDateRequestRecords(
  tx: Tx,
  ctx: EmploymentContext,
  recordIds: readonly string[],
): Promise<Set<string>> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT DISTINCT q.record_id::text AS id FROM part_time_requests q
      JOIN LATERAL (SELECT state FROM part_time_request_events
        WHERE tenant_id=q.tenant_id AND request_id=q.id ORDER BY event_no DESC LIMIT 1) s ON true
      WHERE q.tenant_id=${ctx.tenantId} AND q.request_type IN ('extend', 'end')
        AND q.record_id = ANY(${uuidArray(recordIds)}) AND s.state IN ('draft', 'in_review', 'rejected')
    `),
  );
  return new Set(rows.map((row) => row.id));
}

export const requestInProgress = () =>
  new AppError('CONFLICT', '该兼职有未办结的延长或结束申请，不能直接修改结束日期', {
    reason: PART_TIME_ERRORS.requestInProgress,
  });

export const MAX_BATCH_END = 200;

const batchEndSchema = z.strictObject({
  items: z
    .array(z.strictObject({ recordId: z.uuid(), revision: z.int().min(1) }))
    .min(1)
    .max(MAX_BATCH_END),
  endDate: z.string(),
});

export interface BatchEndInput {
  readonly items: readonly { readonly recordId: string; readonly revision: number }[];
  readonly endDate: string;
}

/** 批量结束入参（§4.4）：1～200 条，recordId 统一小写，重复（不分大小写）整批 400 DUPLICATE_RECORD。 */
export function normalizeBatchEnd(value: unknown): BatchEndInput {
  const parsed = batchEndSchema.safeParse(value);
  if (!parsed.success)
    throw new AppError('VALIDATION_FAILED', `批量结束须为 1～${MAX_BATCH_END} 条兼职记录`, parsed.error.issues);
  const items = parsed.data.items.map((item) => ({ ...item, recordId: item.recordId.toLowerCase() }));
  if (new Set(items.map((item) => item.recordId)).size !== items.length)
    throw new AppError('VALIDATION_FAILED', '同一条兼职记录不能在一次批量结束中重复出现', {
      reason: PART_TIME_ERRORS.duplicateRecord,
    });
  return { items, endDate: businessDate(parsed.data.endDate) };
}

export interface BatchEndViolation {
  readonly code: 'VALIDATION_FAILED' | 'CONFLICT';
  readonly reason: string;
  readonly message: string;
}

/** 批量结束逐条规则（revision 已一致之后）：T-1 → T-2 → E-5 → E-4；通过返回 null。纯判断，today 为租户今天。 */
export function batchEndViolation(
  row: Pick<PartTimeRecordRow, 'startDate' | 'endDate'>,
  endDate: string,
  today: string,
  openRequest: boolean,
): BatchEndViolation | null {
  const conflict = (reason: string, message: string): BatchEndViolation => ({ code: 'CONFLICT', reason, message });
  if (endDate < row.startDate)
    return { code: 'VALIDATION_FAILED', reason: PART_TIME_ERRORS.endBeforeStart, message: '结束日期不能早于开始日期' };
  if (row.endDate !== null && endDate > row.endDate)
    return conflict(PART_TIME_ERRORS.endAfterCurrent, '结束日期不能晚于当前结束日期，要推后请用延长');
  if (partTimeServiceStatus(row, today) === 'ended')
    return conflict(PART_TIME_ERRORS.alreadyEnded, '该兼职已结束，不能再结束');
  if (openRequest) return conflict(PART_TIME_ERRORS.requestInProgress, '该兼职有未办结的延长或结束申请');
  return null;
}
