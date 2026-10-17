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
import { lockEmploymentEmployee } from '../record-store.js';
import type { EmploymentContext } from '../types.js';
import { assertPartTimeWithinCycle } from './boundary.js';
import { insertPartTimeRecord } from './store.js';
import {
  assertExclusiveTypeFree,
  normalizeNewPartTime,
  partTimePresetFields,
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
  const { id, payloadVersionId } = await insertPartTimeRecord(tx, ctx, {
    employeeId: employee.id,
    staffId: cycle.staffId,
    entryDate: cycle.entryDate,
    serviceType: normalized.serviceType,
    startDate: normalized.startDate,
    endDate: normalized.endDate,
    fields,
    customFields: normalized.customFields,
    explicitFieldCodes: normalized.explicitFieldCodes,
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
