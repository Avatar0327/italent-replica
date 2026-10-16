/**
 * 入职生成邮箱规则路由（R2 BE-2b；34 EN-R12）：规则配置（挂在任职设置对象上）与待入职的“生成邮箱”。
 * 策略登记在 employment/policy.ts。
 */
import { withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  jsonBody,
  readContext,
  requireEmploymentWrite,
  revision,
  runWrite,
  trimEmploymentResponse,
} from './context.js';
import {
  emailReceipt,
  emailRulesBody,
  generateEntryEmailFor,
  readEmailRules,
  replaceEmailRules,
} from './entry-email.js';
import { parse, prepareEntryAction, type BusinessWriteGuard } from './entry-routes.js';

export function registerEntryEmailRoutes(
  router: Hono<TenantEnv>,
  deps: TenantRouteDeps,
  authorizeBusinessWrite: BusinessWriteGuard,
) {
  router.get('/entry-email-rules', async (c) => {
    const ctx = await readContext(c, deps, 'object.view', 0, undefined, 'TenantBase.EmploymentSettings');
    const rules = await withTenant(deps.db, ctx.tenantId, (tx) => readEmailRules(tx, ctx.tenantId));
    return c.json(await trimEmploymentResponse(deps, ctx, rules));
  });
  router.put('/entry-email-rules', async (c) => {
    const ctx = await readContext(
      c,
      deps,
      'tenant.employment.configuration.write',
      revision(c),
      undefined,
      'TenantBase.EmploymentSettings',
    );
    const input = parse(emailRulesBody, await jsonBody(c));
    await requireEmploymentWrite(ctx, 'update', input, undefined, 'TenantBase.EmploymentSettings');
    return runWrite(c, deps, ctx, input, async (tx, context) => ({
      status: 200,
      body: await replaceEmailRules(tx, context, input),
    }));
  });
  router.post('/pending-entries/:id/generate-email', async (c) => {
    const { id, ctx, input } = await prepareEntryAction(c, deps, authorizeBusinessWrite, z.strictObject({}));
    return runWrite(
      c,
      deps,
      ctx,
      { id, action: 'generate-email', input },
      async (tx, context) => ({ status: 200, body: await generateEntryEmailFor(tx, context, id) }),
      { project: emailReceipt },
    );
  });
}
