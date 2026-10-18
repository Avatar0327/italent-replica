/**
 * 内部服务 createPartTime（docs/08_设计/R2-T05_兼职设计.md §2.3 / §4.2 / §4.3，PT-3a 写入底座）：直接新增兼职，保存即落地
 * （兼职不改写任何当前值，不排队，§2.4）。公开路由、权限逐入口映射与幂等重放由 PT-3b 的 routes / replay-guard 接在它前面；
 * 本函数只在调用方给的事务内做：员工行锁 → 周期边界 → 外派 / 借调唯一 → 部门可用性与引用 → 写底座 → 审计。
 */
import { randomUUID } from 'node:crypto';
import type { Tx } from '@italent/db';
import {
  PART_TIME_AUDIT_OBJECTS,
  addDays,
  partTimeViews,
  partTimeServiceStatus,
  tenantLocalDate,
  type PartTimeRecordView,
  type PartTimeServiceStatus,
  type PartTimeServiceType,
} from '@italent/domain';
import { recordOperationLog } from '../../../audit/record.js';
import { AppError } from '../../../errors.js';
import { auditActor } from '../../../system-actor.js';
import { auditEmployment, requireEmployeeInScope, requireScopedEmploymentObject } from '../context.js';
import { sequenceForNewPost } from '../field-derivations.js';
import type { ForwardFieldChange } from '../forward-rules.js';
import { appendForwardPayload } from '../forward-store.js';
import { lockEmploymentBusiness, lockEmploymentEmployee, readEmploymentEmployee } from '../record-store.js';
import { assertEmploymentDepartmentAvailableWithin } from '../references.js';
import { loadOrgSnapshot } from '../../org/read-model.js';
import type { CustomFields, EmploymentContext, PresetFields } from '../types.js';
import { assertPartTimeWithinCycle } from './boundary.js';
import { partTimeNotFound } from './read.js';
import {
  appendPartTimeTerm,
  bumpPartTimeRevision,
  insertPartTimeRecord,
  lockPartTimeRecords,
  lockPartTimeRecordsById,
  readPartTimeRecords,
} from './store.js';
import {
  assertExclusiveTypeFree,
  batchEndViolation,
  normalizeNewPartTime,
  openDateRequestRecords,
  partTimePresetFields,
  planPartTimeEdit,
  requestInProgress,
  requirePartTimeRecordScope,
  validatePartTimeCustomFields,
  validatePartTimeReferences,
  type BatchEndInput,
  type EditPartTimeInput,
  type NewPartTimeInput,
} from './validation.js';

export type CreatePartTimeInput = NewPartTimeInput;

export interface CreatedPartTime {
  readonly id: string;
  readonly employeeId: string;
  readonly staffId: string;
  readonly serviceType: PartTimeServiceType;
  readonly departmentId: string;
  readonly startDate: string;
  readonly endDate: string | null;
  /** 底层业务头 revision（并发版本号，If-Match）。 */
  readonly revision: number;
  /** 保存当时按租户今天派生的任职状态与视图归属（§1.2 / §6.1），不入库。 */
  readonly serviceStatus: PartTimeServiceStatus;
  readonly views: readonly PartTimeRecordView[];
  /** B-4 等只提示不拦的信息。 */
  readonly warnings: readonly string[];
}

export async function createPartTime(
  tx: Tx,
  ctx: EmploymentContext,
  input: CreatePartTimeInput,
): Promise<CreatedPartTime> {
  const normalized = normalizeNewPartTime(input);
  const employee = await lockEmploymentEmployee(tx, ctx, normalized.employeeId);
  // PT-R2 / PT-R3：员工按主职在范围，且兼职部门在范围（默认开，A-6）；可信端口（无 scope）不设限
  await requireEmployeeInScope(tx, ctx, employee.id);
  await requireScopedEmploymentObject(tx, ctx, employee.id, normalized.departmentId);
  const { cycle, warnings } = await assertPartTimeWithinCycle(tx, ctx, {
    employeeId: employee.id,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
  });
  await assertExclusiveTypeFree(tx, ctx, normalized);
  const fields = partTimePresetFields(normalized, {
    jobNumber: employee.code,
    employType: cycle.employType as never,
  });
  await validatePartTimeReferences(tx, ctx, normalized, fields);
  const custom = await validatePartTimeCustomFields(tx, ctx, normalized.customFields);
  const { id, payloadVersionId } = await insertPartTimeRecord(tx, ctx, {
    employeeId: employee.id,
    staffId: cycle.staffId,
    entryDate: cycle.entryDate,
    serviceType: normalized.serviceType,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
    fields,
    customFields: custom.customFields,
    explicitFieldCodes: [...normalized.explicitFieldCodes, ...custom.codes],
  });
  // 审计 + outbox 与业务同事务；归属 = 员工 + 兼职部门（0058 推不出这类对象的部门，§7.4）。不写 employment.record.create（P-04）
  await auditEmployment(
    tx,
    ctx,
    'employment.part_time.create',
    PART_TIME_AUDIT_OBJECTS.record,
    id,
    null,
    {
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)),
      // DEC-019：自定义字段展开成 custom:<id> 进审计快照与 outbox（同主职落地审计约定）
      ...Object.fromEntries(Object.entries(custom.customFields).map(([id, value]) => [`custom:${id}`, value])),
      serviceType: normalized.serviceType,
      startDate: normalized.startDate,
      endDate: normalized.endDate,
      staffId: cycle.staffId,
    },
    payloadVersionId,
    undefined,
    { employeeId: employee.id, orgId: normalized.departmentId },
  );
  const span = { startDate: normalized.startDate, endDate: normalized.endDate };
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  return {
    id,
    employeeId: employee.id,
    staffId: cycle.staffId,
    serviceType: normalized.serviceType,
    departmentId: normalized.departmentId,
    ...span,
    revision: 1,
    serviceStatus: partTimeServiceStatus(span, today),
    views: partTimeViews(span, today),
    warnings,
  };
}

export interface PartTimePreview {
  readonly partTimeType: PartTimeServiceType;
  readonly effectiveDate: string;
  readonly endDate: string | null;
  /** 带出默认值后的预置字段整组（含系统派生的 jobNumber / employType）。 */
  readonly fields: PresetFields;
  readonly warnings: readonly string[];
}

/** 兼职部门在开始日的负责人（Q-M0-121④“自动带出直线经理（该部门负责人）”）：只取该部门自己的，不沿行政上级找。 */
async function departmentHeadOn(tx: Tx, tenantId: string, departmentId: string, date: string) {
  const [org] = await loadOrgSnapshot(tx, tenantId, date, undefined, { id: departmentId, includeDisabled: false });
  return org?.personInChargeId ?? null;
}

/**
 * 新增兼职预览（§4.1 / §4.2，PT-3b）：与 createPartTime 同一套范围与校验，通过后带出默认值；不写库、不取员工行锁。
 * 带出：直线经理 = 兼职部门在开始日的负责人；职务序列按 DEC-107；**不带出职位**（取值规则未验证，B-6 / U-7）。
 * 请求里显式给出的字段（含显式 null）优先。默认值只作建议，保存时仍走 createPartTime 的引用校验。
 */
export async function previewPartTime(
  tx: Tx,
  ctx: EmploymentContext,
  input: CreatePartTimeInput,
): Promise<PartTimePreview> {
  const normalized = normalizeNewPartTime(input);
  const employee = await readEmploymentEmployee(tx, ctx, normalized.employeeId);
  await requireEmployeeInScope(tx, ctx, employee.id);
  await requireScopedEmploymentObject(tx, ctx, employee.id, normalized.departmentId);
  const { cycle, warnings } = await assertPartTimeWithinCycle(tx, ctx, {
    employeeId: employee.id,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
  });
  await assertExclusiveTypeFree(tx, ctx, normalized);
  const derived = { jobNumber: employee.code, employType: cycle.employType as never };
  await validatePartTimeReferences(tx, ctx, normalized, partTimePresetFields(normalized, derived));
  await validatePartTimeCustomFields(tx, ctx, normalized.customFields);
  const given = (key: 'directManagerId' | 'sequenceId') => Object.hasOwn(input, key);
  const defaults = {
    ...(given('directManagerId')
      ? {}
      : { directManagerId: await departmentHeadOn(tx, ctx.tenantId, normalized.departmentId, normalized.startDate) }),
    ...(given('sequenceId') || !normalized.fields.postId
      ? {}
      : {
          sequenceId: await sequenceForNewPost(
            tx,
            ctx.tenantId,
            { postId: normalized.fields.postId },
            normalized.startDate,
          ),
        }),
  };
  return {
    partTimeType: normalized.serviceType,
    effectiveDate: normalized.startDate,
    endDate: normalized.endDate,
    fields: partTimePresetFields({ ...normalized, fields: { ...normalized.fields, ...defaults } }, derived),
    warnings,
  };
}

export interface EditedPartTime {
  readonly id: string;
  readonly employeeId: string;
  /** 编辑后底层业务头 revision；无任何改动时即当前值。 */
  readonly revision: number;
  readonly changed: boolean;
  /** B-4 等只提示不拦的信息。 */
  readonly warnings: readonly string[];
}

/** 自定义字段合并后的逐字段变化（审计与载荷显式字段编码用 custom:<id>）。 */
function customChanges(current: CustomFields, given: CustomFields): ForwardFieldChange[] {
  return Object.entries(given)
    .filter(([id, value]) => (current[id] ?? null) !== value)
    .map(([id, value]) => ({ field: `custom:${id}`, before: current[id] ?? null, after: value }));
}

/**
 * 编辑兼职（§5.1 非日期字段 + §4.4 直接修改结束日期，PT-3c）：员工行锁 → 兼职底层业务头锁（If-Match 比对）→ 范围 → 规划 →
 * 周期边界 / E-4 / 部门可用性与引用 → 写入。结束日期变化追加期限（source = edit）；其余字段追加 is_record_snapshot 载荷版本；
 * 一次命令只让业务头 revision +1。**不触发向后更新、不同步人员、不排调动联动**（AC-FWD-11，兼职不是向后更新的来源）。
 * 没有任何实际变化时是无操作（不写、不 +1）。开始日期 / 任职类型不可改，结束日期不能置空（A-9）。
 */
export async function editPartTime(
  tx: Tx,
  ctx: EmploymentContext,
  recordId: string,
  input: EditPartTimeInput,
): Promise<EditedPartTime> {
  const business = await lockEmploymentBusiness(tx, ctx, recordId, { partTime: true });
  const [row] = await lockPartTimeRecords(tx, ctx, business.employeeId, { ids: [recordId] });
  if (!row) throw partTimeNotFound();
  await requirePartTimeRecordScope(tx, ctx, row, row.departmentId);
  const derived = await sequenceForNewPost(tx, ctx.tenantId, input as Partial<PresetFields>, row.startDate);
  const plan = planPartTimeEdit(row, business.payload.fields, derived ? { ...input, sequenceId: derived } : input);
  // 兼职部门必填：新增时必给，规划阶段拒绝清空，所以编辑后一定有值
  const departmentId = plan.fields.departmentId!;
  if (departmentId !== row.departmentId) await requirePartTimeRecordScope(tx, ctx, row, departmentId);
  const custom = await validatePartTimeCustomFields(tx, ctx, input.customFields ?? {});
  const changes = [...plan.changes, ...customChanges(business.payload.customFields, custom.customFields)];
  const unchanged: EditedPartTime = {
    id: row.id,
    employeeId: row.employeeId,
    revision: row.revision,
    changed: false,
    warnings: [],
  };
  if (!plan.endChanged && !changes.length) return unchanged;
  let warnings: readonly string[] = [];
  if (plan.endChanged) {
    if ((await openDateRequestRecords(tx, ctx, [row.id])).size) throw requestInProgress();
    warnings = (
      await assertPartTimeWithinCycle(tx, ctx, {
        employeeId: row.employeeId,
        startDate: row.startDate,
        endDate: plan.endDate,
        recordStaffId: row.staffId,
      })
    ).warnings;
  }
  const { endDate } = plan;
  const target = { employeeId: row.employeeId, startDate: row.startDate, endDate, departmentId };
  if (plan.changes.length) await validatePartTimeReferences(tx, ctx, target, plan.fields);
  else if (row.endDate !== null && endDate !== null && endDate > row.endDate)
    await assertEmploymentDepartmentAvailableWithin(
      tx,
      ctx,
      departmentId,
      addDays(row.endDate, 1),
      addDays(endDate, 1),
    );
  const scope = { employeeId: row.employeeId, orgId: departmentId };
  let revision = row.revision;
  if (plan.endChanged) {
    const next = await appendPartTimeTerm(tx, ctx, row, { endDate, source: 'edit' });
    revision = next.revision;
    // 直接改结束日期的审计动作是 end（§7.4）；before 取上一期，不建“变更前”列（硬规则 3）
    await auditEmployment(
      tx,
      ctx,
      'employment.part_time.end',
      PART_TIME_AUDIT_OBJECTS.record,
      row.id,
      { endDate: row.endDate },
      { endDate, termNo: next.termNo },
      undefined,
      undefined,
      scope,
    );
  }
  if (changes.length) {
    const customFields = { ...business.payload.customFields, ...custom.customFields };
    const next = await appendForwardPayload(
      tx,
      ctx,
      business.payload,
      { fields: plan.fields, customFields },
      row.id,
      true,
      changes,
    );
    if (!plan.endChanged) revision = await bumpPartTimeRevision(tx, ctx, row);
    await auditEmployment(
      tx,
      ctx,
      'employment.part_time.edit',
      PART_TIME_AUDIT_OBJECTS.record,
      row.id,
      Object.fromEntries(changes.map((change) => [change.field, change.before])),
      Object.fromEntries(changes.map((change) => [change.field, change.after])),
      next.id,
      undefined,
      scope,
    );
  }
  return { ...unchanged, revision, changed: true, warnings };
}

export interface BatchEnded {
  readonly batchId: string;
  readonly total: number;
  readonly endDate: string;
  /** 请求顺序的记录 ID。 */
  readonly recordIds: readonly string[];
}

/** 失败的逐条回执：整批失败时 details.items 只列出未通过的条目（成功条目在整批回滚下没有意义）。 */
function batchRejected(
  failures: readonly { recordId: string; violation: NonNullable<ReturnType<typeof batchEndViolation>> }[],
) {
  const [first] = failures;
  return new AppError(first!.violation.code, first!.violation.message, {
    reason: first!.violation.reason,
    items: failures.map(({ recordId, violation }) => ({ recordId, reason: violation.reason })),
  });
}

/**
 * 批量结束兼职（§4.4 / §7.5 ⑥，R2d）：只有结束日期、直接生效，整批成功或整批失败。取锁：先读各记录的员工（不存在 / 不是兼职 →
 * 整批 404），按员工 UUID 升序锁员工行，再按记录 ID 升序锁业务头；**锁内**先复核范围，再逐条比对 revision（任一不等 →
 * 409 REVISION_CONFLICT，detail.items 逐条 { recordId, expected, actual }），再逐条 T-1 / T-2 / E-5 / E-4（任一失败整批回滚、
 * 逐条回执原因）。成功：每条追加期限 source = batch_end（同一批次 ID），逐条审计，一条对象操作日志。
 */
export async function batchEndPartTimes(tx: Tx, ctx: EmploymentContext, input: BatchEndInput): Promise<BatchEnded> {
  const ids = input.items.map((item) => item.recordId);
  const owners = await readPartTimeRecords(tx, ctx, ids);
  if (owners.length !== ids.length) throw partTimeNotFound();
  for (const employeeId of [...new Set(owners.map((owner) => owner.employeeId))].sort())
    await lockEmploymentEmployee(tx, ctx, employeeId);
  const locked = await lockPartTimeRecordsById(tx, ctx, ids);
  if (locked.length !== ids.length) throw partTimeNotFound();
  for (const row of locked) await requirePartTimeRecordScope(tx, ctx, row, row.departmentId);
  const byId = new Map(locked.map((row) => [row.id, row]));
  const stale = input.items.filter((item) => byId.get(item.recordId)!.revision !== item.revision);
  if (stale.length)
    throw new AppError('REVISION_CONFLICT', '兼职记录已变更，请刷新后显式重提', {
      items: stale.map((item) => ({
        recordId: item.recordId,
        expected: item.revision,
        actual: byId.get(item.recordId)!.revision,
      })),
    });
  const open = await openDateRequestRecords(tx, ctx, ids);
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const failures = input.items.flatMap(({ recordId }) => {
    const violation = batchEndViolation(byId.get(recordId)!, input.endDate, today, open.has(recordId));
    return violation ? [{ recordId, violation }] : [];
  });
  if (failures.length) throw batchRejected(failures);
  const batchId = randomUUID();
  for (const row of locked) {
    const next = await appendPartTimeTerm(tx, ctx, row, {
      endDate: input.endDate,
      source: 'batch_end',
      sourceId: batchId,
    });
    await auditEmployment(
      tx,
      ctx,
      'employment.part_time.batch_end',
      PART_TIME_AUDIT_OBJECTS.record,
      row.id,
      { endDate: row.endDate },
      { endDate: input.endDate, termNo: next.termNo },
      undefined,
      { batchId },
      { employeeId: row.employeeId, orgId: row.departmentId },
    );
  }
  await recordOperationLog(tx, {
    tenantId: ctx.tenantId,
    actorUserId: auditActor(ctx.userId),
    behavior: 'batch_update',
    objectType: PART_TIME_AUDIT_OBJECTS.record,
    successCount: ids.length,
    failureCount: 0,
    // 逐行归属：所属员工与兼职部门，查询端按 DEC-177 逐行裁剪（同 batch-edit.ts）
    items: ids.map((id, rowIndex) => ({
      rowIndex,
      outcome: 'succeeded' as const,
      objectId: id,
      employeeId: byId.get(id)!.employeeId,
      orgId: byId.get(id)!.departmentId,
    })),
    commandId: ctx.commandId,
    occurredAt: ctx.now,
  });
  return { batchId, total: ids.length, endDate: input.endDate, recordIds: ids };
}
