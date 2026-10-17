/**
 * 转正 / 转正申请，单个与批量（R2 BE-3；docs/02_业务建模/29 PB-R8，差距表 B7 / B8）。
 * - 必填试用结果（租户字典启用项，probation-results.ts）；转正日期可统一填写，不填则每人取预计试用结束日次日（F-205）；
 * - 每人在自己的保存点里办理：单人失败（revision 过期、无预计结束日、互斥、范围外等）只记在他的回执里，不影响其他人；
 * - 批量申请 = 每人一张申请、各自提交并发起一条审批流程（与 POST /businesses/:id/submit 同一入口）；
 * - 直接办理复用任职业务 kind=regularization（生效即把试用改正式并向后传播，employee-status.ts），互斥在
 *   createEmploymentBusiness / transitions 的提交处统一判（probation-guard.ts）。
 * 单一入口 createRegularizationBusiness：通用入口 POST /employees/:id/businesses（kind=regularization）与
 * POST /regularizations 都经它校验试用结果、取默认转正日期、写试用结果（第 1 轮审查 P2-3）；
 * 实习转正（intern_regularization，F-215 / BE-6a）的资格检查由 #386 在同一入口按业务类型接入。
 */
import { isUuid, sql, type Tx } from '@italent/db';
import { defaultRegularizationDate, tenantLocalDate } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { employmentApprovalHooks } from './approval-hooks.js';
import { auditEmployment, requireEmployeeInScope } from './context.js';
import { loadProbationCycle } from './probation.js';
import { requireEnabledProbationResult } from './probation-results.js';
import { transitionEmployment } from './transitions.js';
import type { CustomFields, EmploymentBusiness, EmploymentContext, PresetFields } from './types.js';
import { createEmploymentBusiness } from './write-service.js';

/** 经本入口办理的业务类型；BE-6a 加入 intern_regularization。 */
export const REGULARIZATION_ENTRY_KINDS = ['regularization'] as const;
export type RegularizationEntryKind = (typeof REGULARIZATION_ENTRY_KINDS)[number];

export function isRegularizationEntryKind(kind: unknown): kind is RegularizationEntryKind {
  return REGULARIZATION_ENTRY_KINDS.some((item) => item === kind);
}

export interface RegularizationRequest {
  readonly kind: RegularizationEntryKind;
  readonly mode: 'direct' | 'application';
  /** 不填取预计试用结束日次日（F-205）。 */
  readonly effectiveDate?: string;
  readonly probationResult?: string;
  readonly formId?: string;
  readonly fields?: Partial<PresetFields>;
  readonly customFields?: CustomFields;
}

/** 试用结果必填且须为字典启用项（B7）；返回库里的编码写法。 */
export async function requireRegularizationResult(tx: Tx, tenantId: string, code: string | undefined) {
  if (!code) throw new AppError('VALIDATION_FAILED', '转正须填写试用结果', { reason: 'PROBATION_RESULT_REQUIRED' });
  return requireEnabledProbationResult(tx, tenantId, code);
}

/**
 * 转正业务的唯一创建入口：试用结果、默认转正日期、试用结果落库与审计，随后交 createEmploymentBusiness
 * （直接转正的 PB-R9 互斥、状态向后传播都在那里）。申请只建草稿，提交走 transitions（提交时互斥）。
 */
export async function createRegularizationBusiness(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  request: RegularizationRequest,
): Promise<EmploymentBusiness> {
  const resultCode = await requireRegularizationResult(tx, ctx.tenantId, request.probationResult);
  const effectiveDate = await regularizationDate(tx, ctx, employeeId, request.effectiveDate);
  const created = await createEmploymentBusiness(tx, ctx, employeeId, {
    kind: request.kind,
    mode: request.mode,
    effectiveDate,
    ...(request.formId ? { formId: request.formId } : {}),
    ...(request.fields ? { fields: request.fields } : {}),
    ...(request.customFields ? { customFields: request.customFields } : {}),
  });
  await tx.execute(sql`INSERT INTO employment_regularization_results(tenant_id, employee_id, business_id, result_code,
      command_id, created_at)
    VALUES (${ctx.tenantId}, ${employeeId}::uuid, ${created.id}::uuid, ${resultCode}, ${ctx.commandId},
      ${ctx.now.toISOString()}::timestamptz)`);
  await auditEmployment(tx, ctx, 'employment.regularization.result', 'employment-business', created.id, null, {
    probationResult: resultCode,
  });
  return created;
}

export const MAX_BATCH_REGULARIZATION = 100;

const schema = z.strictObject({
  mode: z.enum(['direct', 'application']),
  effectiveDate: z.iso.date().optional(),
  probationResult: z.string().trim().min(1).max(100).optional(),
  items: z
    .array(z.strictObject({ employeeId: z.string().refine(isUuid), revision: z.int().min(0) }))
    .min(1)
    .max(MAX_BATCH_REGULARIZATION),
});
export type RegularizationInput = z.infer<typeof schema>;

export function parseRegularizationInput(raw: unknown): RegularizationInput {
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      'VALIDATION_FAILED',
      `转正须填写方式、试用结果与 1～${MAX_BATCH_REGULARIZATION} 名员工`,
      parsed.error.issues,
    );
  const ids = parsed.data.items.map((item) => item.employeeId.toLowerCase());
  if (new Set(ids).size !== ids.length)
    throw new AppError('VALIDATION_FAILED', '同一员工不能在一次转正中重复出现', { reason: 'DUPLICATE_EMPLOYEE' });
  return {
    ...parsed.data,
    items: parsed.data.items.map((item) => ({ ...item, employeeId: item.employeeId.toLowerCase() })),
  };
}

export interface RegularizationReceiptItem {
  readonly employeeId: string;
  readonly status: 'succeeded' | 'failed';
  readonly businessId: string | null;
  readonly effectiveDate: string | null;
  readonly businessStatus: string | null;
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown } | null;
}

/** 转正日期：统一填写的优先；否则按本人预计试用结束日取次日（F-205），没有预计结束日则这一人失败。 */
async function regularizationDate(tx: Tx, ctx: EmploymentContext, employeeId: string, unified?: string) {
  if (unified) return unified;
  const cycle = await loadProbationCycle(tx, ctx.tenantId, employeeId, tenantLocalDate(ctx.now, ctx.timezone));
  if (!cycle?.info.expectedEndDate)
    throw new AppError('VALIDATION_FAILED', '没有预计试用结束日期，请填写转正日期', {
      reason: 'PROBATION_END_DATE_MISSING',
    });
  return defaultRegularizationDate(cycle.info.expectedEndDate);
}

async function regularizeOne(
  tx: Tx,
  ctx: EmploymentContext,
  input: RegularizationInput,
  item: RegularizationInput['items'][number],
) {
  // 范围外与不存在同一个 404（DEC-177 写入口径），在本人保存点内判定，只记在他的回执里
  await requireEmployeeInScope(tx, ctx, item.employeeId);
  return launchRegularization(tx, { ...ctx, expectedRevision: item.revision }, item.employeeId, {
    kind: 'regularization',
    mode: input.mode,
    probationResult: input.probationResult,
    ...(input.effectiveDate ? { effectiveDate: input.effectiveDate } : {}),
  });
}

/**
 * 办理一张转正：直接转正建单即办理；申请建单后经单张提交同一入口提交并发起审批（含 PB-R9 提交时互斥）。
 * 批量转正（每人一条独立流程，PB-R8）与 BE-15a 自动转正共用。ctx.expectedRevision = 员工 revision。
 */
export async function launchRegularization(
  tx: Tx,
  ctx: EmploymentContext,
  employeeId: string,
  request: RegularizationRequest,
): Promise<EmploymentBusiness> {
  const created = await createRegularizationBusiness(tx, ctx, employeeId, request);
  if (request.mode === 'direct') return created;
  const submitted = await transitionEmployment(
    tx,
    { ...ctx, expectedRevision: created.revision },
    { id: created.id, action: 'submit' },
  );
  await employmentApprovalHooks.submitted(tx, ctx, created.id);
  return submitted;
}

export async function regularizeEmployees(tx: Tx, ctx: EmploymentContext, input: RegularizationInput) {
  // 试用结果整单先校验（400，不逐人失败）；每人办理时同一入口再取一次
  await requireRegularizationResult(tx, ctx.tenantId, input.probationResult);
  const receipts = new Map<string, RegularizationReceiptItem>();
  // 按员工 ID 顺序逐人取锁（同 batch-edit 的锁序），并发的两单不会交叉等待；回执仍按请求顺序
  for (const item of [...input.items].sort((a, b) => a.employeeId.localeCompare(b.employeeId))) {
    try {
      const business = await tx.transaction((savepoint) => regularizeOne(savepoint, ctx, input, item));
      receipts.set(item.employeeId, {
        employeeId: item.employeeId,
        status: 'succeeded',
        businessId: business.id,
        effectiveDate: business.effectiveDate,
        businessStatus: business.status,
        error: null,
      });
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      receipts.set(item.employeeId, {
        employeeId: item.employeeId,
        status: 'failed',
        businessId: null,
        effectiveDate: null,
        businessStatus: null,
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
    }
  }
  const items = input.items.map((item) => receipts.get(item.employeeId)!);
  const succeeded = items.filter((item) => item.status === 'succeeded').length;
  return { total: items.length, succeeded, failed: items.length - succeeded, items };
}
