import { withTenant, type Tx } from '@italent/db';
import type { Context } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { pageQuery, uuidParam, type BusinessContext } from '../job/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import {
  MATERIAL_STATUSES,
  MATERIAL,
  materialReadScope,
  materialStatusScope,
  readMaterialList,
} from './material-list.js';

export async function readEntryMaterials(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const businessId = uuidParam(c, 'businessId');
  const ctx = tenantOf(c);
  const page = pageQuery(c);
  return c.json(
    await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const authorize = authorizeInTransaction(deps.authorize, tx);
      await requirePermission(authorize, { ...ctx, action: 'object.view', resource: EMPLOYMENT_OBJECT });
      await requirePermission(authorize, { ...ctx, action: 'object.view', resource: MATERIAL });
      const access = await materialReadScope(tx, deps, ctx, `${MATERIAL}.detail`);
      const scope = await resolveModuleScopeInTransaction(
        deps,
        ctx,
        tx,
        EMPLOYMENT_OBJECT,
        `${EMPLOYMENT_OBJECT}.detail`,
      );
      return readMaterialList(tx, ctx, businessId, scope, access, page);
    }),
  );
}

export async function entryMaterialProjection(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx: Tx,
  ctx: BusinessContext,
) {
  const filter = c.req.query('materialStatus');
  const sort = c.req.query('sortBy') === 'materialStatus';
  const fields = await getModuleViewableFieldsInTransaction(deps, ctx, EMPLOYMENT_OBJECT, tx);
  const scope = !fields || fields.has('materialStatus') ? await materialStatusScope(tx, deps, ctx) : undefined;
  if ((filter !== undefined || sort) && !scope) throw new AppError('FORBIDDEN', '筛选或排序字段不可查看');
  if (!scope) return;
  const query = z
    .object({
      filter: z.enum(MATERIAL_STATUSES).optional(),
      order: z.enum(['asc', 'desc']).optional(),
    })
    .safeParse({ filter, order: sort ? (c.req.query('direction') ?? 'asc') : undefined });
  if (!query.success) throw new AppError('VALIDATION_FAILED', '材料状态筛选或排序不合法');
  return { scope, ...query.data };
}
