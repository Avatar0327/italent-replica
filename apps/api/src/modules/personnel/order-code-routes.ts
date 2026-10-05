import { withTenant } from '@italent/db';
import type { Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';
import type { TenantRouteDeps } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { revision } from '../job/context.js';
import { authorizeInTransaction } from '../permission/module-access.js';
import { body, safe } from './http.js';
import { parse } from './validation.js';
import { recomputeOrderCodes } from './order-code.js';
import { orderSettingsInput, readOrderSettings, saveOrderSettings } from './order-code-settings.js';

const base = '/api/tenant/personnel/order-code';
const resource = 'personnel.order_code';
/** 租户设置权限：全租户派生投影由系统处理，响应只返回计数，不泄露范围外人员。 */
export function registerOrderCodeRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.get(`${base}/settings`, (c) =>
    safe(async () => {
      const ctx = tenantOf(c);
      await requirePermission(deps.authorize, { ...ctx, action: 'tenant.settings.read', resource });
      const config = await withTenant(deps.db, ctx.tenantId, (tx) => readOrderSettings(tx, ctx.tenantId));
      c.header('ETag', `"${config.revision}"`);
      return c.json(config);
    }),
  );
  for (const operation of ['settings', 'recompute'] as const) {
    router.on(operation === 'settings' ? 'PUT' : 'POST', `${base}/${operation}`, (c) =>
      safe(async () => {
        const ctx = { ...tenantOf(c), expectedRevision: revision(c), now: deps.clock(), commandId: '' };
        const permission = { ...ctx, action: 'tenant.settings.write', resource };
        await requirePermission(deps.authorize, permission);
        const input =
          operation === 'settings'
            ? parse(orderSettingsInput, await body(c))
            : parse(z.object({}).strict(), await body(c));
        const result = await runCommand(deps.db, ctx, {
          id: c.req.header('idempotency-key'),
          fingerprint: { operation: `personnel.order.${operation}`, revision: ctx.expectedRevision, input },
          execute: async (tx, commandId) => {
            await requirePermission(authorizeInTransaction(deps.authorize, tx), permission);
            const command = { ...ctx, commandId };
            return {
              status: 200,
              body:
                operation === 'settings'
                  ? await saveOrderSettings(tx, command, orderSettingsInput.parse(input))
                  : await recomputeOrderCodes(tx, command),
            };
          },
        });
        // 幂等重放仍以本次请求的权限为准。
        await requirePermission(deps.authorize, permission);
        return c.json(result.body, result.status);
      }),
    );
  }
}
