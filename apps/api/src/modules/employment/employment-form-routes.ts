/** F-321：字典维护沿用任职设置配置对象；不另造授权编码或字典框架。 */
import { withTenant } from '@italent/db';
import { EMPLOYMENT_FORM_CATEGORIES } from '@italent/domain';
import type { Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { requirePermission } from '../../authorization.js';
import { jsonBody, requireEmploymentWrite, runWrite, uuidParam } from './context.js';
import { ruleGuard, writeContext } from './auto-regularization-routes.js';
import { listEmploymentForms, parseEmploymentForm, saveEmploymentForm } from './employment-forms.js';

export function registerEmploymentFormRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get('/employment-forms', async (c) => {
    // 字典没有人员范围：直接校验任职查看权，避免构造无用的人员范围上下文。
    const ctx = tenantOf(c);
    await requirePermission(deps.authorize, {
      ...ctx,
      action: 'object.view',
      resource: 'TenantBase.EmploymentRecord',
    });
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listEmploymentForms(tx, ctx.tenantId));
    return c.json({ items, categories: EMPLOYMENT_FORM_CATEGORIES });
  });
  router.post('/employment-forms', async (c) => {
    const ctx = await writeContext(c, deps);
    const input = parseEmploymentForm(await jsonBody(c));
    await requireEmploymentWrite(ctx, 'create', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      input,
      async (tx, context) => ({
        status: 201,
        body: await saveEmploymentForm(tx, context, input),
      }),
      { guard: ruleGuard(deps, ctx, input, 'create') },
    );
  });
  router.put('/employment-forms/:id', async (c) => {
    const ctx = await writeContext(c, deps);
    const id = uuidParam(c);
    const input = parseEmploymentForm(await jsonBody(c), true);
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(
      c,
      deps,
      ctx,
      { id, input },
      async (tx, context) => ({
        status: 200,
        body: await saveEmploymentForm(tx, context, input, id),
      }),
      { guard: ruleGuard(deps, ctx, input) },
    );
  });
}
