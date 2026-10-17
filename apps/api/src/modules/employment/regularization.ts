/**
 * 转正 / 转正申请，单个与批量（R2 BE-3；docs/02_业务建模/29 PB-R8，差距表 B7 / B8）。
 * - 必填试用结果（租户字典启用项，probation-results.ts）；转正日期可统一填写，不填则每人取预计试用结束日次日（F-205）；
 * - 每人在自己的保存点里办理：单人失败（revision 过期、无预计结束日、互斥、范围外等）只记在他的回执里，不影响其他人；
 * - 批量申请 = 每人一张申请、各自提交并发起一条审批流程（与 POST /businesses/:id/submit 同一入口）；
 * - 直接办理复用任职业务 kind=regularization（生效即把试用改正式并向后传播，employee-status.ts），互斥在
 *   createEmploymentBusiness / transitions 的提交处统一判（probation-guard.ts）。
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
import type { EmploymentContext } from './types.js';
import { createEmploymentBusiness } from './write-service.js';

export const MAX_BATCH_REGULARIZATION = 100;

const schema = z.strictObject({
  mode: z.enum(['direct', 'application']),
  effectiveDate: z.iso.date().optional(),
  probationResult: z.string().trim().min(1).max(100),
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
  resultCode: string,
  item: RegularizationInput['items'][number],
) {
  // 范围外与不存在同一个 404（DEC-177 写入口径），在本人保存点内判定，只记在他的回执里
  await requireEmployeeInScope(tx, ctx, item.employeeId);
  const effectiveDate = await regularizationDate(tx, ctx, item.employeeId, input.effectiveDate);
  const created = await createEmploymentBusiness(tx, { ...ctx, expectedRevision: item.revision }, item.employeeId, {
    kind: 'regularization',
    mode: input.mode,
    effectiveDate,
  });
  await tx.execute(sql`INSERT INTO employment_regularization_results(tenant_id, employee_id, business_id, result_code,
      command_id, created_at)
    VALUES (${ctx.tenantId}, ${item.employeeId}::uuid, ${created.id}::uuid, ${resultCode}, ${ctx.commandId},
      ${ctx.now.toISOString()}::timestamptz)`);
  await auditEmployment(tx, ctx, 'employment.regularization.result', 'employment-business', created.id, null, {
    probationResult: resultCode,
  });
  if (input.mode === 'direct') return created;
  // 批量申请每人一条独立流程：与单张提交同一入口（含 PB-R9 提交时互斥）
  const submitted = await transitionEmployment(
    tx,
    { ...ctx, expectedRevision: created.revision },
    { id: created.id, action: 'submit' },
  );
  await employmentApprovalHooks.submitted(tx, ctx, created.id);
  return submitted;
}

export async function regularizeEmployees(tx: Tx, ctx: EmploymentContext, input: RegularizationInput) {
  const resultCode = await requireEnabledProbationResult(tx, ctx.tenantId, input.probationResult);
  const receipts = new Map<string, RegularizationReceiptItem>();
  // 按员工 ID 顺序逐人取锁（同 batch-edit 的锁序），并发的两单不会交叉等待；回执仍按请求顺序
  for (const item of [...input.items].sort((a, b) => a.employeeId.localeCompare(b.employeeId))) {
    try {
      const business = await tx.transaction((savepoint) => regularizeOne(savepoint, ctx, input, resultCode, item));
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
