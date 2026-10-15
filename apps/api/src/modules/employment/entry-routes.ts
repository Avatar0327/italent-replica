/**
 * 待入职状态动作路由（R2 BE-2a；34 EN-R8 / R9 / R10 / R14）：办理入职、取消、改期、删除。
 * 策略登记在 employment/policy.ts；写权限沿用任职记录的“编辑 / 删除”对象操作与按钮（原站是否另有独立权限项未验证）。
 */
import { ENTRY_CANCEL_REASON_CODES, ENTRY_REMARK_MAX } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody, readContext, requireEmploymentWrite, revision, runWrite, uuidParam } from './context.js';
import { completePendingEntry } from './employee-status.js';
import { cancelPendingEntry, deletePendingEntry, postponePendingEntry } from './entry-actions.js';
import type { EmploymentContext } from './types.js';
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

/** 三个动作共用的入口：读上下文（object.update）→ 解析请求体 → 编辑按钮（命令式，空字段集合）→ 写入口径范围。 */
async function prepareEntryAction<T>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  authorize: BusinessWriteGuard,
  schema: z.ZodType<T>,
  writePayload: (input: T) => object = () => ({}),
) {
  const id = uuidParam(c);
  const ctx = await readContext(c, deps, 'object.update', revision(c));
  const input = parse(schema, await jsonBody(c));
  // 改期要改入职日期：按 { effectiveDate } 校验字段写权限；办理入职 / 取消不改任职字段，空载荷只校验按钮
  const payload = writePayload(input);
  await requireEmploymentWrite(ctx, 'update', payload, 'Employment.Edit', undefined, {
    commandOnly: Object.keys(payload).length === 0,
  });
  await authorize(deps, ctx, id);
  return { id, ctx, input };
}

export function registerEntryRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps, authorize: BusinessWriteGuard) {
  router.post('/pending-entries/:id/complete', async (c) => {
    const { id, ctx, input } = await prepareEntryAction(c, deps, authorize, completeInput);
    return runWrite(c, deps, ctx, { id, action: 'complete', input }, async (tx, context) => {
      await completePendingEntry(tx, context, id, input);
      return { status: 200, body: await requireSavedBusiness(tx, context, id) };
    });
  });
  router.post('/pending-entries/:id/cancel', async (c) => {
    const { id, ctx, input } = await prepareEntryAction(c, deps, authorize, cancelInput);
    return runWrite(c, deps, ctx, { id, action: 'cancel', input }, async (tx, context) => ({
      status: 200,
      body: await cancelPendingEntry(tx, context, id, input),
    }));
  });
  router.post('/pending-entries/:id/postpone', async (c) => {
    const { id, ctx, input } = await prepareEntryAction(c, deps, authorize, postponeInput, ({ effectiveDate }) => ({
      effectiveDate,
    }));
    return runWrite(c, deps, ctx, { id, action: 'postpone', input }, async (tx, context) => ({
      status: 200,
      body: await postponePendingEntry(tx, context, id, input),
    }));
  });
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
