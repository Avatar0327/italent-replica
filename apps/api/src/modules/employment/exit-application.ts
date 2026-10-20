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
import { activateIfDue } from './exit-activation.js';
import { confirmExit } from './exit-confirmation.js';
import {
  assertRetirementFields,
  writeRetirementExtension,
  type RetirementCreateInput,
} from './retirement-application.js';
import { validateRehirePlan } from './retirement-rehire.js';
import { assertHandoverEmployee, EXIT_GATE_PASS, requireExitGate, withAckWarnings } from './exit-gate.js';
import { assertExitDictionaryEnabled } from './exit-dictionaries.js';
import {
  applyInitiationSubset,
  assertBusinessInputSubset,
  assertInitiatorRelation,
  exitOptionsSchema,
  NO_BLACKLIST,
  resolveBlacklistFields,
  touchesBlacklist,
  type BlacklistFields,
  type ExitInitiation,
  type ExitOptions,
} from './exit-initiation.js';
import { normalizeEmploymentInput } from './fields.js';
import { loadPlannedEffectiveDate } from './timeline.js';
import { bumpEmploymentBusiness, lockEmploymentBusiness, lockEmploymentEmployee, rowsOf } from './record-store.js';
import type { ChangeType, CustomFields, EmploymentBusiness, EmploymentContext, PresetFields } from './types.js';
import { lockExitParticipants } from './exit-lock-plan.js';
import { createEmploymentBusiness, requireSavedBusiness } from './write-service.js';
import { authorizeLinkageWrite } from '../transfer/linkage/access.js';
import { normalizeLinkage, type LinkageOptions } from '../transfer/linkage/input.js';
import { appendLinkageVersion } from '../transfer/linkage/store.js';
import { validateLinkage } from '../transfer/linkage/validation.js';

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
  /** 变动类型：只由可信的系统联动传入（结束实习记“实习结束”，BE-6b），不开放给请求体；该类离职免审批直接生效（DEC-593①）。 */
  readonly changeType?: ChangeType;
  /** 业务类型：离职（缺省）或退休（R2-T04 §3.2，同一服务、同一门禁、同一事务时序）。 */
  readonly kind?: 'leave' | 'retirement';
  /** 退休专有入参（kind = retirement）：同时返聘计划（5b）。 */
  readonly retirement?: RetirementCreateInput;
}

/** 请求里出现加黑键时，用合并后的整组替换（false 时三项清空）；没出现则原样返回。 */
function withBlacklist<T extends Partial<BlacklistFields>>(
  exit: T,
  current: BlacklistFields,
  effectiveDate: string,
): T {
  return touchesBlacklist(exit) ? { ...exit, ...resolveBlacklistFields(current, exit, effectiveDate) } : exit;
}

/** exit_requests 的可写列（扩展行 ← exit 区块）；金额以字符串入库。 */
function columnValues(exit: ExitOptions) {
  const { dutyTransfer: _duty, pendingTransferAck: _ack, compensationAmount, nonCompeteAmount, ...rest } = exit;
  return {
    ...rest,
    ...(rest.blacklistNote === undefined ? {} : { blacklistNote: rest.blacklistNote || null }),
    ...(compensationAmount === undefined ? {} : { compensationAmount: compensationAmount.toFixed(2) }),
    ...(nonCompeteAmount === undefined ? {} : { nonCompeteAmount: nonCompeteAmount.toFixed(2) }),
  };
}

async function dutyTransferTiming(tx: Tx, tenantId: string) {
  return (await readEffectiveSetting(tx, tenantId, 'exit.duty_transfer_timing')).value as string;
}

/** 离职单所在任职周期（最新载荷版本的 selected_staff_id）。 */
async function selectedStaffOf(tx: Tx, ctx: EmploymentContext, businessId: string) {
  const [version] = rowsOf<{ staffId: string }>(
    await tx.execute(sql`SELECT selected_staff_id AS "staffId" FROM employment_payload_versions
      WHERE tenant_id=${ctx.tenantId} AND business_id=${businessId}::uuid ORDER BY version_no DESC LIMIT 1`),
  );
  return version!.staffId;
}

/** 创建离职（专用 / 通用 / 批量入口共用）；确认清单超限时（DEC-626）响应带 warnings，其余形态不变。 */
export async function createExitApplication(
  tx: Tx,
  ctx: EmploymentContext,
  input: ExitApplicationInput,
): Promise<EmploymentBusiness> {
  const employeeId = input.employeeId.toLowerCase();
  const kind = input.kind ?? 'leave';
  const subset = applyInitiationSubset(input.initiation, input.mode, input.exit ?? {});
  const typed = input.changeType ? { changeType: input.changeType } : {};
  if (kind === 'retirement') assertRetirementFields(subset);
  assertBusinessInputSubset(input.initiation, input);
  const normalized = normalizeEmploymentInput(ctx, {
    kind,
    mode: input.mode,
    lastWorkDate: input.lastWorkDate,
    ...(input.effectiveDate ? { effectiveDate: input.effectiveDate } : {}),
    ...(input.formId ? { formId: input.formId } : {}),
    fields: input.fields ?? {},
    customFields: input.customFields ?? {},
  });
  // 加黑三项在锁之前校验（400 不占锁）；只在勾选时把合并后的整组写进扩展行，未勾选的离职扩展行与审计保持原样
  const exit = withBlacklist(subset, NO_BLACKLIST, normalized.effectiveDate);
  // 职责转交计划（DEC-213）：结构校验在锁之前；参与员工闭包（离职人 + 转交下属）先于任何其他锁取齐（§5.2 ①，与批量共用）
  const duty = exit.dutyTransfer === undefined ? null : normalizeLinkage({ dutyTransfer: exit.dutyTransfer });
  await lockExitParticipants(tx, ctx, [{ employeeId, dutyTransfer: exit.dutyTransfer }]);
  // 先持员工行锁（不比 revision）：并发的两笔申请在锁后重读未办结离职，败者得到 EXIT_IN_PROGRESS 而不是 revision 冲突
  await lockEmploymentEmployee(tx, ctx, employeeId);
  await assertInitiatorRelation(tx, ctx, input.initiation, employeeId);
  const { ack } = await requireExitGate(tx, ctx, 'create', {
    employeeId,
    kind,
    initiation: input.initiation,
    mode: input.mode,
    lastWorkDate: normalized.lastWorkDate!,
    exit,
    payload: { fields: normalized.fields, customFields: normalized.customFields },
    ...typed,
  });
  const business = await createEmploymentBusiness(tx, ctx, employeeId, normalized, {
    exitPass: EXIT_GATE_PASS,
    ...typed,
  });
  await tx.insert(exitRequests).values({
    ...columnValues(exit),
    tenantId: ctx.tenantId,
    businessId: business.id,
    employeeId,
    staffId: await selectedStaffOf(tx, ctx, business.id),
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
    kind === 'retirement' ? 'retirement.request.create' : 'exit.request.create',
    'exit-request',
    business.id,
    null,
    { initiation: input.initiation, initiatorUserId: ctx.userId, employeeId, mode: input.mode, ...columnValues(exit) },
    undefined,
    undefined,
    { employeeId },
  );
  // 退休薄扩展行（R2-T04 §3.2 第 6 步）：在 exit_requests 之后、生效链之前冻结 P 并派生类型，失败整单回滚
  if (kind === 'retirement')
    await writeRetirement(tx, ctx, { id: business.id, employeeId, lastWorkDate: normalized.lastWorkDate! }, input);
  // 转交计划须先写联动版本，再进 confirmed：approval_passed 时机的转交读的就是这个版本（§5.7）
  if (duty?.dutyTransfer) await saveDutyTransfer(tx, ctx, business, duty);
  // 直接离职保存即进入 confirmed 阶段（§3.1：编制预减 R；不自动发起交接 DM-R14），最后工作日已过则同事务生效（§5.3）
  if (input.mode !== 'direct') return withAckWarnings(tx, ctx, business);
  await confirmExit(tx, ctx, { ...business, mode: 'direct', kind });
  const activation = await activateIfDue(tx, ctx, business.id);
  if (!activation || activation.outcome === 'pending') return withAckWarnings(tx, ctx, business);
  // 落地 / 失败 / 挂起都推进业务 revision（trigger = approval 由调用命令统一递增一次）
  const locked = await lockEmploymentBusiness(tx, { ...ctx, expectedRevision: business.revision }, business.id);
  await bumpEmploymentBusiness(tx, ctx, locked);
  return withAckWarnings(tx, ctx, await requireSavedBusiness(tx, ctx, business.id));
}

/**
 * 退休专有的创建写入（§3.2 第 6 步）：同时返聘的业务干跑（返聘部门 / 职位在返聘日可用、不在黑名单，§8.2）与薄扩展行；
 * 任一失败与扩展行写入失败一样整单回滚。
 */
async function writeRetirement(
  tx: Tx,
  ctx: EmploymentContext,
  business: { readonly id: string; readonly employeeId: string; readonly lastWorkDate: string },
  input: ExitApplicationInput,
) {
  const retirement = input.retirement ?? {};
  if (retirement.rehire)
    await validateRehirePlan(tx, ctx, business.employeeId, retirement.rehire, business.lastWorkDate);
  await writeRetirementExtension(tx, ctx, business, retirement);
}

/** 职责转交计划的授权（逐下属 / 组织角色字段权，§9.1）、校验与保存；任一不通过整单回滚。 */
async function saveDutyTransfer(tx: Tx, ctx: EmploymentContext, business: EmploymentBusiness, options: LinkageOptions) {
  const target = { businessId: business.id, employeeId: business.employeeId };
  await authorizeLinkageWrite(tx, ctx, {}, { employeeId: business.employeeId, operation: 'create', options });
  await validateLinkage(tx, ctx, business.employeeId, options);
  await appendLinkageVersion(tx, ctx, target, options);
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
  options: { readonly approvalEdit?: boolean; readonly kind?: 'leave' | 'retirement' } = {},
): Promise<EmploymentBusiness> {
  const kind = options.kind ?? 'leave';
  const business = await lockEmploymentBusiness(tx, ctx, businessId);
  const [row] = await tx
    .select()
    .from(exitRequests)
    .where(and(eq(exitRequests.tenantId, ctx.tenantId), eq(exitRequests.businessId, businessId)));
  if (!row || business.payload.kind !== kind)
    throw new AppError('NOT_FOUND', kind === 'retirement' ? '退休单不存在' : '离职单不存在');
  if (SETTLED.includes(business.state))
    throw new AppError('CONFLICT', '已办结的离职不能再编辑', { reason: 'EXIT_NOT_EDITABLE' });
  await requireExitGate(tx, ctx, 'update', {
    employeeId: business.employeeId,
    kind,
    business,
    patch: patch.dates,
    payload: patch.fields,
    ...(options.approvalEdit ? { approvalEdit: true } : {}),
  });
  for (const [key, dictionary] of [
    ['reasonCode', 'reasons'],
    ['whereaboutsCode', 'whereabouts'],
    ['exitTypeCode', 'types'],
  ] as const) {
    const value = patch.fields[key];
    if (value && value !== row[key]) await assertExitDictionaryEnabled(tx, ctx.tenantId, dictionary, value);
  }
  await assertHandoverEmployee(tx, ctx, patch.fields.handoverEmployeeId);
  // 加黑三项与 addToBlacklist 合并校验（创建同一入口）：生效日取计划生效日，“是”改“否”清掉旧值
  const planned = await loadPlannedEffectiveDate(tx, ctx.tenantId, businessId, business.payload.effectiveDate);
  const values = columnValues(withBlacklist(patch.fields, row, planned));
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
    kind === 'retirement' ? 'retirement.request.update' : 'exit.request.update',
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
