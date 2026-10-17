/**
 * 离职申请服务（R2-T03 §4B，DEC-283）：被 exits/employees/:id、exits/batch（B2b）、通用 POST employees/:id/businesses
 * kind=leave 与 F-020 的自助 / 经理代发入口共同调用。按发起方式（hr / self / manager）选字段子集、复核身份关系，
 * 再过 §4A 门禁，最后在同一事务里写任职业务（申请 → draft，直接离职 → approved）、离职扩展行与审计。
 * 发起人（initiator_user_id）、被离职人（employee_id）、发起方式（initiator）分开记录。
 */
import { and, eq, exitRequests, sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { z } from 'zod';
import { auditEmployment } from './context.js';
import { confirmExit } from './exit-confirmation.js';
import { assertHandoverEmployee, EXIT_GATE_PASS, requireExitGate } from './exit-gate.js';
import { assertExitDictionaryEnabled } from './exit-dictionaries.js';
import {
  applyInitiationSubset,
  assertBusinessInputSubset,
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
  /** 批量申请的批次号（exits/batch，设计 §2.1 batch_id）。 */
  readonly batchId?: string;
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
  assertBusinessInputSubset(input.initiation, input);
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
    batchId: input.batchId ?? null,
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
  // 直接离职保存即进入 confirmed 阶段（§3.1：编制预减 R；不自动发起交接 DM-R14）；仍只存 approved，不落地（§18.1 ③）
  if (input.mode === 'direct') await confirmExit(tx, ctx, { ...business, mode: 'direct' });
  return business;
}

const SETTLED = ['voided', 'disapproved', 'deleted'];

/** 编辑离职请求：扩展字段 + 可选的最后工作日 / 生效日（只能与当前值相同，§7.2）。 */
export interface ExitPatch {
  readonly fields: Omit<ExitOptions, 'dutyTransfer' | 'pendingTransferAck'>;
  readonly dates: { readonly lastWorkDate?: string; readonly effectiveDate?: string };
}

const exitPatchSchema = exitOptionsSchema.omit({ dutyTransfer: true, pendingTransferAck: true }).extend({
  lastWorkDate: z.string().optional(),
  effectiveDate: z.string().optional(),
});

/** PATCH exits/:id 与审批编辑共用的解析：日期键单独拿出来交给门禁比较，其余按离职扩展字段校验。 */
export function parseExitPatch(raw: unknown): ExitPatch {
  const parsed = exitPatchSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '离职字段不合法', parsed.error.issues);
  const { lastWorkDate, effectiveDate, ...fields } = parsed.data;
  return {
    fields,
    dates: {
      ...(lastWorkDate === undefined ? {} : { lastWorkDate }),
      ...(effectiveDate === undefined ? {} : { effectiveDate }),
    },
  };
}

/**
 * 编辑离职的非日期字段（B14，设计 §7.2；PATCH exits/:id 与审批编辑）：字典须为启用项；只改请求里出现的字段。
 * 日期与当前值不同由门禁 update 判定（400 EXIT_DATE_IMMUTABLE，先于任何写入；无权者先得 403）。
 * approvalEdit：审批编辑的权限由审批中心按节点规则负责，门禁只判日期。
 */
export async function updateExitFields(
  tx: Tx,
  ctx: EmploymentContext,
  businessId: string,
  patch: ExitPatch,
  options: { readonly approvalEdit?: boolean } = {},
): Promise<EmploymentBusiness> {
  const business = await lockEmploymentBusiness(tx, ctx, businessId);
  const [row] = await tx
    .select()
    .from(exitRequests)
    .where(and(eq(exitRequests.tenantId, ctx.tenantId), eq(exitRequests.businessId, businessId)));
  if (!row || business.payload.kind !== 'leave') throw new AppError('NOT_FOUND', '离职单不存在');
  if (SETTLED.includes(business.state))
    throw new AppError('CONFLICT', '已办结的离职不能再编辑', { reason: 'EXIT_NOT_EDITABLE' });
  await requireExitGate(tx, ctx, 'update', {
    employeeId: business.employeeId,
    business,
    patch: patch.dates,
    payload: patch.fields,
    ...(options.approvalEdit ? { approvalEdit: true } : {}),
  });
  for (const [key, kind] of [
    ['reasonCode', 'reasons'],
    ['whereaboutsCode', 'whereabouts'],
    ['exitTypeCode', 'types'],
  ] as const) {
    const value = patch.fields[key];
    if (value && value !== row[key]) await assertExitDictionaryEnabled(tx, ctx.tenantId, kind, value);
  }
  await assertHandoverEmployee(tx, ctx, patch.fields.handoverEmployeeId);
  const values = columnValues(patch.fields);
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
    { employeeId: business.employeeId },
  );
  // HR 编辑审批中的单（#388 P2-1）：离职字段进了审批版本，同事务让在途实例记下新版本并推进 revision，旧审批页面随即 409；
  // 审批编辑自己会在审批命令里刷新版本，这里不重复推进
  if (business.state === 'in_review' && !options.approvalEdit) {
    const { refreshBusinessVersion } = await import('../approval/engine.js');
    await refreshBusinessVersion(tx, ctx, 'employment', businessId);
  }
  return requireSavedBusiness(tx, ctx, businessId);
}
