/**
 * 内部服务 createPartTime（docs/08_设计/R2-T05_兼职设计.md §2.3 / §4.2 / §4.3，PT-3a 写入底座）：直接新增兼职，保存即落地
 * （兼职不改写任何当前值，不排队，§2.4）。公开路由、权限逐入口映射与幂等重放由 PT-3b 的 routes / replay-guard 接在它前面；
 * 本函数只在调用方给的事务内做：员工行锁 → 周期边界 → 外派 / 借调唯一 → 部门可用性与引用 → 写底座 → 审计。
 */
import type { Tx } from '@italent/db';
import {
  PART_TIME_AUDIT_OBJECTS,
  partTimeViews,
  partTimeServiceStatus,
  tenantLocalDate,
  type PartTimeRecordView,
  type PartTimeServiceStatus,
  type PartTimeServiceType,
} from '@italent/domain';
import { auditEmployment, requireEmployeeInScope, requireScopedEmploymentObject } from '../context.js';
import { sequenceForNewPost } from '../field-derivations.js';
import { lockEmploymentEmployee, readEmploymentEmployee } from '../record-store.js';
import { loadOrgSnapshot } from '../../org/read-model.js';
import type { EmploymentContext, PresetFields } from '../types.js';
import { assertPartTimeWithinCycle } from './boundary.js';
import { insertPartTimeRecord } from './store.js';
import {
  assertExclusiveTypeFree,
  normalizeNewPartTime,
  partTimePresetFields,
  validatePartTimeCustomFields,
  validatePartTimeReferences,
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
 * 新增兼职预览（§4.1 / §4.2，PT-3b）：与 createPartTime 同一套范围与校验（外派唯一、周期边界、引用、自定义字段），
 * 通过后带出默认值，不写库、不取员工行锁（预览只读，一致性由事务快照保证）。
 * 带出规则：直线经理 = 兼职部门在开始日的负责人；职务序列按 DEC-107（sequenceForNewPost）；**不带出职位**
 * （“自动带出职位”的取值规则未验证，B-6 / U-7，取最保守做法）。请求里显式给出的字段（含显式 null）优先，不被覆盖。
 * 默认值只作建议：保存时 HR 提交的值仍走 createPartTime 的引用校验。
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
