/**
 * 待入职状态动作路由（R2 BE-2a；34 EN-R8 / R9 / R10 / R14）：办理入职、取消、改期、删除。
 * 策略登记在 employment/policy.ts；写权限沿用任职记录的“编辑 / 删除”对象操作与按钮（原站是否另有独立权限项未验证）。
 */
import { type Tx } from '@italent/db';
import { ENTRY_CANCEL_REASON_CODES, ENTRY_REMARK_MAX } from '@italent/domain';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody, readContext, requireEmploymentWrite, revision, runWrite, uuidParam } from './context.js';
import { completePendingEntry } from './employee-status.js';
import { cancelPendingEntry, deletePendingEntry, postponePendingEntry } from './entry-actions.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';
import { requireSavedBusiness } from './write-service.js';

const remark = z.string().trim().min(1).max(ENTRY_REMARK_MAX).optional();
const completeInput = z.strictObject({ probation: z.boolean() });
const cancelInput = z.strictObject({ reason: z.enum(ENTRY_CANCEL_REASON_CODES).optional(), remark });
const postponeInput = z.strictObject({ effectiveDate: z.string().min(1), remark });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', result.error.issues);
  return result.data;
}

/** 与任职路由里 authorizeBusinessWrite 同一入口（写入口径范围 + 看全部别名），由 routes.ts 传入以免循环引用。 */
export type BusinessWriteGuard = (
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
) => Promise<{ readonly employeeId: string }>;

export function registerEntryRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps, authorize: BusinessWriteGuard) {
  const action = <T>(
    name: string,
    schema: z.ZodType<T>,
    run: (tx: Tx, ctx: EmploymentContext, id: string, input: T) => Promise<EmploymentBusiness>,
  ) =>
    router.post(`/pending-entries/:id/${name}`, async (c) => {
      const id = uuidParam(c);
      const ctx = await readContext(c, deps, 'object.update', revision(c));
      const input = parse(schema, await jsonBody(c));
      await requireEmploymentWrite(ctx, 'update', {}, 'Employment.Edit', undefined, { commandOnly: true });
      await authorize(deps, ctx, id);
      return runWrite(c, deps, ctx, { id, action: name, input }, async (tx, context) => ({
        status: 200,
        body: await run(tx, context, id, input),
      }));
    });
  action('complete', completeInput, async (tx, ctx, id, input) => {
    await completePendingEntry(tx, ctx, id, input);
    return requireSavedBusiness(tx, ctx, id);
  });
  action('cancel', cancelInput, cancelPendingEntry);
  action('postpone', postponeInput, postponePendingEntry);
  router.delete('/pending-entries/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.delete', revision(c));
    await requireEmploymentWrite(ctx, 'delete', {}, 'Employment.Delete');
    await authorize(deps, ctx, id);
    return runWrite(c, deps, ctx, { id, action: 'delete-pending' }, async (tx, context) => ({
      status: 200,
      body: await deletePendingEntry(tx, context, id),
    }));
  });
}
