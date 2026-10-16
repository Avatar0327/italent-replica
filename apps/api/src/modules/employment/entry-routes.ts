/**
 * 待入职状态动作路由（R2 BE-2a；34 EN-R8 / R9 / R10 / R14）：办理入职、取消、改期、删除。
 * 策略登记在 employment/policy.ts；写权限沿用任职记录的“编辑 / 删除”对象操作与按钮（原站是否另有独立权限项未验证）。
 */
import { withTenant } from '@italent/db';
import { ENTRY_CANCEL_REASON_CODES, ENTRY_REMARK_MAX, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import {
  EMPLOYEE_OBJECT,
  jsonBody,
  pageQuery,
  readContext,
  readPageContext,
  requireEmploymentWrite,
  revision,
  runWrite,
  trimEmploymentResponse,
  uuidParam,
} from './context.js';
import { completePendingEntry } from './employee-status.js';
import type { CommandGuard } from '../../commands.js';
import {
  entryContractSchema,
  type EntryContract,
  generateEntryContract,
  requireEntryContractAccess,
} from './entry-contract.js';
import { cancelPendingEntry, deletePendingEntry, postponePendingEntry } from './entry-actions.js';
import { ENTRY_VIEWS, listEntryView } from './entry-views.js';
import type { EmploymentContext } from './types.js';
import { requireSavedBusiness } from './write-service.js';

const remark = z.string().trim().min(1).max(ENTRY_REMARK_MAX).optional();
const completeInput = z.strictObject({ probation: z.boolean(), contract: entryContractSchema.optional() });
const cancelInput = z.strictObject({ reason: z.enum(ENTRY_CANCEL_REASON_CODES).optional(), remark });
const postponeInput = z.strictObject({ effectiveDate: z.string().min(1), remark });

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
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
export async function prepareEntryAction<T>(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
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
  await authorizeBusinessWrite(deps, ctx, id);
  return { id, ctx, input };
}

/**
 * 办理入职带合同信息时的合同权限命令内复核：接 CommandGuard.before，runCommand 的三个出口（首次执行、直接重放、失败后回查）
 * 都经 ledgerExit 先过它，所以撤销合同权限后重放拿不到原 200。没带合同信息时不挂（行为同 BE-2a）。
 * 工厂放在路由文件、检查函数留在 entry-contract.ts，与本人调动按钮的复核同一做法。
 */
function entryContractGuard(
  deps: TenantRouteDeps,
  ctx: EmploymentContext,
  id: string,
  contract: EntryContract | undefined,
): CommandGuard | undefined {
  return contract ? { before: (tx) => requireEntryContractAccess(tx, deps, ctx, id, contract) } : undefined;
}

export function registerEntryRoutes(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  registerEntryViews(router, deps);
  router.post('/pending-entries/:id/complete', async (c) => {
    const { id, ctx, input } = await prepareEntryAction(c, deps, authorizeBusinessWrite, completeInput);
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'complete', input },
      async (tx, context) => {
        const record = await completePendingEntry(tx, context, id, { probation: input.probation });
        if (input.contract) await generateEntryContract(tx, deps, context, record, input.contract);
        return { status: 200, body: await requireSavedBusiness(tx, context, id) };
      },
      { guard: entryContractGuard(deps, ctx, id, input.contract) },
    );
  });
  router.post('/pending-entries/:id/cancel', async (c) => {
    const { id, ctx, input } = await prepareEntryAction(c, deps, authorizeBusinessWrite, cancelInput);
    return runWrite(c, deps, ctx, { id, action: 'cancel', input }, async (tx, context) => ({
      status: 200,
      body: await cancelPendingEntry(tx, context, id, input),
    }));
  });
  router.post('/pending-entries/:id/postpone', async (c) => {
    const { id, ctx, input } = await prepareEntryAction(
      c,
      deps,
      authorizeBusinessWrite,
      postponeInput,
      ({ effectiveDate }) => ({
        effectiveDate,
      }),
    );
    return runWrite(c, deps, ctx, { id, action: 'postpone', input }, async (tx, context) => ({
      status: 200,
      body: await postponePendingEntry(tx, context, id, input),
    }));
  });
  router.delete('/pending-entries/:id', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.delete', revision(c));
    await requireEmploymentWrite(ctx, 'delete', {}, 'Employment.Delete');
    await authorizeBusinessWrite(deps, ctx, id);
    return runWrite(c, deps, ctx, { id, action: 'delete-pending' }, async (tx, context) => ({
      status: 200,
      body: await deletePendingEntry(tx, context, id),
    }));
  });
}

/**
 * 入职四视图（EN-R1）：列表按任职记录的数据范围裁剪，字段按任职记录可见字段裁剪；
 * 员工姓名 / 工号属于人员对象，按人员对象的可见字段另行裁剪（无权看就不出现，不整体拒绝）。
 */
function registerEntryViews(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/pending-entries', async (c) => {
    const ctx = await readPageContext(c, deps, 'list');
    const view = parse(z.enum(ENTRY_VIEWS), c.req.query('view'));
    const page = pageQuery(c);
    const items = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listEntryView(tx, ctx.tenantId, { view, today: tenantLocalDate(ctx.now, ctx.timezone), page }, ctx.scope),
    );
    const identity = await getModuleViewableFields(deps, ctx, EMPLOYEE_OBJECT);
    const shown = (field: string) => identity === undefined || identity.has(field);
    const trimmed = (await trimEmploymentResponse(
      deps,
      ctx,
      items.map(({ name: _name, code: _code, ...record }) => record),
    )) as object[];
    return c.json({
      items: trimmed.map((record, index) => ({
        ...record,
        ...(shown('code') ? { code: items[index]!.code } : {}),
        ...(shown('name') ? { name: items[index]!.name } : {}),
      })),
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope?.hasDataPermission ?? true,
    });
  });
}
