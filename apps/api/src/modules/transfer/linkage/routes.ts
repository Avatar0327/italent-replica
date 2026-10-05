/** 联动接口：查看联动、修改联动选项、重试失败子项（挂在 /api/tenant/employment/transfers 下）。 */
import { withTenant } from '@italent/db';
import { buttonResource, CONTRACT_OBJECT, contractAction, tenantLocalDate } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../../authorization.js';
import { AppError } from '../../../errors.js';
import type { TenantRouteDeps } from '../../../routes.js';
import type { TenantEnv } from '../../../tenant-context.js';
import { checkFields, checkScope } from '../../contracts/context.js';
import { routeContext } from '../../contracts/routes.js';
import {
  jsonBody,
  readContext,
  requireEmploymentWrite,
  revision,
  runWrite,
  uuidParam,
} from '../../employment/context.js';
import { loadEmploymentBusiness } from '../../employment/read-model.js';
import { normalizeLinkage, type LinkageOptions } from './input.js';
import { loadLinkageItem, retryLinkageItem } from './items.js';
import { readTransferLinkage, updateTransferLinkage } from './service.js';

/**
 * 变更合同的权限按合同模块判定（R2-T06 的字段权限、“变更”按钮与人员范围），保存时校验一次；
 * 到期生效时合同端口只执行这张已授权的单据（与审批 / 定时端口同口径）。
 */
export async function authorizeLinkageContract(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  employeeId: string,
  options: LinkageOptions | null,
) {
  if (!options?.contract) return;
  const ctx = await routeContext(c, deps, CONTRACT_OBJECT, false);
  await checkFields(ctx, 'update', options.contract.fields);
  await requirePermission(deps.authorize, {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    action: 'object.button',
    resource: buttonResource(CONTRACT_OBJECT, contractAction('change', 'direct'), 'detail'),
  });
  await withTenant(deps.db, ctx.tenantId, (tx) => checkScope(tx, ctx, employeeId));
}

export function registerTransferLinkageRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/transfers/:id/linkage', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.view');
    const view = await withTenant(deps.db, ctx.tenantId, (tx) => readTransferLinkage(tx, ctx, id));
    return c.json(view);
  });
  router.put('/transfers/:id/linkage', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    const raw = await jsonBody(c);
    const options = normalizeLinkage(raw);
    const business = await withTenant(deps.db, ctx.tenantId, (tx) =>
      loadEmploymentBusiness(tx, ctx.tenantId, id, tenantLocalDate(ctx.now, ctx.timezone), ctx.scope),
    );
    if (!business || business.kind !== 'transfer') throw new AppError('NOT_FOUND', '调动不存在');
    // 编辑数据操作已由 readContext 校验；联动选项不是任职对象上登记的字段，合同部分另按合同模块权限校验。
    await authorizeLinkageContract(c, deps, business.employeeId, options);
    return runWrite(c, deps, ctx, raw, async (tx, context) => ({
      status: 200,
      body: await updateTransferLinkage(tx, context, id, options),
    }));
  });
  router.post('/transfers/linkage-items/:id/retry', async (c) => {
    const id = uuidParam(c);
    const ctx = await readContext(c, deps, 'object.update', revision(c));
    if (c.req.header('content-type')) parse(z.strictObject({}), await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', {}, 'Employment.RetryActivation');
    // 子项所属调动须对当前操作人可见（每次请求重验，幂等重放同样经此）。
    await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const item = await loadLinkageItem(tx, ctx.tenantId, id);
      const today = tenantLocalDate(ctx.now, ctx.timezone);
      if (!(await loadEmploymentBusiness(tx, ctx.tenantId, item.businessId, today, ctx.scope)))
        throw new AppError('NOT_FOUND', '联动子项不存在');
    });
    return runWrite(c, deps, ctx, { id, action: 'retry-linkage-item' }, async (tx, context) => ({
      status: 200,
      body: await retryLinkageItem(tx, context, id),
    }));
  });
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求字段不合法', parsed.error.issues);
  return parsed.data;
}
