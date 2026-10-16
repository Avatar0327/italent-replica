/**
 * 离职申请服务（R2-T03 §4B，DEC-283）：被 exits/employees/:id、exits/batch（B2b）、通用 POST employees/:id/businesses
 * kind=leave 与 F-020 的自助 / 经理代发入口共同调用。按发起方式（hr / self / manager）选字段子集、复核身份关系，
 * 再过 §4A 门禁，最后在同一事务里写任职业务（申请 → draft，直接离职 → approved）、离职扩展行与审计。
 * 发起人（initiator_user_id）、被离职人（employee_id）、发起方式（initiator）分开记录。
 */
import { and, eq, exitRequests, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { auditEmployment } from './context.js';
import { EXIT_GATE_PASS, requireExitGate } from './exit-gate.js';
import { assertExitDictionaryEnabled } from './exit-dictionaries.js';
import {
  applyInitiationSubset,
  assertInitiatorRelation,
  exitOptionsSchema,
  type ExitInitiation,
  type ExitOptions,
} from './exit-initiation.js';
import { normalizeEmploymentInput } from './fields.js';
import { bumpEmploymentBusiness, lockEmploymentBusiness, lockEmploymentEmployee, rowsOf } from './record-store.js';
import type { CustomFields, EmploymentBusiness, EmploymentContext, PresetFields } from './types.js';
import { createEmploymentBusiness, requireSavedBusiness } from './write-service.js';

export type { ExitInitiation } from './exit-initiation.js';

export interface ExitApplicationInput {
  /** 被离职人。 */
  readonly employeeId: string;
  readonly initiation: ExitInitiation;
  /** self / manager 只允许 application。 */
  readonly mode: 'application' | 'direct';
  readonly lastWorkDate: string;
  readonly effectiveDate?: string;
  readonly formId?: string;
  readonly fields?: Partial<PresetFields>;
  readonly customFields?: CustomFields;
  readonly exit?: ExitOptions;
}

/** exit_requests 的可写列（扩展行 ← exit 区块）；金额以字符串入库。 */
function columnValues(exit: ExitOptions) {
  const { dutyTransfer: _duty, pendingTransferAck: _ack, compensationAmount, nonCompeteAmount, ...rest } = exit;
  return {
    ...rest,
    ...(compensationAmount === undefined ? {} : { compensationAmount: compensationAmount.toFixed(2) }),
    ...(nonCompeteAmount === undefined ? {} : { nonCompeteAmount: nonCompeteAmount.toFixed(2) }),
  };
}

async function dutyTransferTiming(tx: Tx, tenantId: string) {
  return (await readEffectiveSetting(tx, tenantId, 'exit.duty_transfer_timing')).value as string;
}

export async function createExitApplication(
  tx: Tx,
  ctx: EmploymentContext,
  input: ExitApplicationInput,
): Promise<EmploymentBusiness> {
  const employeeId = input.employeeId.toLowerCase();
  const exit = applyInitiationSubset(input.initiation, input.mode, input.exit ?? {});
  const normalized = normalizeEmploymentInput(ctx, {
    kind: 'leave',
    mode: input.mode,
    lastWorkDate: input.lastWorkDate,
    ...(input.effectiveDate ? { effectiveDate: input.effectiveDate } : {}),
    ...(input.formId ? { formId: input.formId } : {}),
    fields: input.fields ?? {},
    customFields: input.customFields ?? {},
  });
  // 先持员工行锁（不比 revision）：并发的两笔申请在锁后重读未办结离职，败者得到 EXIT_IN_PROGRESS 而不是 revision 冲突
  await lockEmploymentEmployee(tx, ctx, employeeId);
  await assertInitiatorRelation(tx, ctx, input.initiation, employeeId);
  const { ack } = await requireExitGate(tx, ctx, 'create', {
    employeeId,
    initiation: input.initiation,
    mode: input.mode,
    lastWorkDate: normalized.lastWorkDate!,
    exit,
    payload: { fields: normalized.fields, customFields: normalized.customFields },
  });
  const business = await createEmploymentBusiness(tx, ctx, employeeId, normalized, { exitPass: EXIT_GATE_PASS });
  const [version] = rowsOf<{ staffId: string }>(
    await tx.execute(sql`SELECT selected_staff_id AS "staffId" FROM employment_payload_versions
      WHERE tenant_id=${ctx.tenantId} AND business_id=${business.id}::uuid ORDER BY version_no DESC LIMIT 1`),
  );
  await tx.insert(exitRequests).values({
    ...columnValues(exit),
    tenantId: ctx.tenantId,
    businessId: business.id,
    employeeId,
    staffId: version!.staffId,
    mode: input.mode,
    initiator: input.initiation,
    initiatorUserId: ctx.userId,
    pendingTransferAck: ack,
    dutyTransferTiming: await dutyTransferTiming(tx, ctx.tenantId),
  });
  await auditEmployment(
    tx,
    ctx,
    'exit.request.create',
    'exit-request',
    business.id,
    null,
    { initiation: input.initiation, initiatorUserId: ctx.userId, employeeId, mode: input.mode, ...columnValues(exit) },
    undefined,
    undefined,
    { employeeId },
  );
  return business;
}

const SETTLED = ['voided', 'disapproved', 'deleted'];

/**
 * 编辑离职的非日期字段（B14，设计 §7.2；PATCH exits/:id 在 B2b 接线）：字典须为启用项；只改请求里出现的字段；
 * 日期键一律不收（exitOptionsSchema 没有日期字段，通用 PATCH 的日期判定在 requireExitGate update）。
 */
export async function updateExitFields(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  raw: unknown,
): Promise<EmploymentBusiness> {
  const parsed = exitOptionsSchema.omit({ dutyTransfer: true, pendingTransferAck: true }).safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '离职字段不合法', parsed.error.issues);
  const business = await lockEmploymentBusiness(tx, ctx, businessId);
  const [row] = await tx
    .select()
    .from(exitRequests)
    .where(and(eq(exitRequests.tenantId, ctx.tenantId), eq(exitRequests.businessId, businessId)));
  if (!row || business.payload.kind !== 'leave') throw new AppError('NOT_FOUND', '离职单不存在');
  if (SETTLED.includes(business.state))
    throw new AppError('CONFLICT', '已办结的离职不能再编辑', { reason: 'EXIT_NOT_EDITABLE' });
  await requireExitGate(tx, ctx, 'update', { employeeId: business.employeeId, business, payload: parsed.data });
  for (const [key, kind] of [
    ['reasonCode', 'reasons'],
    ['whereaboutsCode', 'whereabouts'],
    ['exitTypeCode', 'types'],
  ] as const) {
    const value = parsed.data[key];
    if (value && value !== row[key]) await assertExitDictionaryEnabled(tx, ctx.tenantId, kind, value);
  }
  const values = columnValues(parsed.data);
  if (!Object.keys(values).length) throw new AppError('VALIDATION_FAILED', '必须提供要修改的离职字段');
  await tx
    .update(exitRequests)
    .set(values)
    .where(and(eq(exitRequests.tenantId, ctx.tenantId), eq(exitRequests.businessId, businessId)));
  await bumpEmploymentBusiness(tx, ctx, business);
  const picked = Object.fromEntries(Object.keys(values).map((key) => [key, row[key as keyof typeof row]]));
  await auditEmployment(
    tx,
    ctx,
    'exit.request.update',
    'exit-request',
    businessId,
    picked,
    values,
    undefined,
    undefined,
    {
      employeeId: business.employeeId,
    },
  );
  return requireSavedBusiness(tx, ctx, businessId);
}
