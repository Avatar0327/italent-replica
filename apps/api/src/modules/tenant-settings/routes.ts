/**
 * 租户配置接口（R1-T00；REQ-TEN-001 R3）：
 *   GET    /api/tenant/settings/:key            有效值及来源（system / tenant），ETag = revision
 *   PUT    /api/tenant/settings/:key            覆盖；必须带 If-Match（revision），可带 Idempotency-Key
 *   DELETE /api/tenant/settings/:key/override   恢复系统值；必须带 If-Match，可带 Idempotency-Key
 */
import { withTenant } from '@italent/db';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePermission } from '../../authorization.js';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantEnv, tenantOf } from '../../tenant-context.js';
import { type EffectiveSetting, overrideSetting, readEffectiveSetting, restoreSetting } from './service.js';

const SETTING_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const IF_MATCH = /^(?:W\/)?"?(\d{1,9})"?$/;
const overrideBody = z.object({ value: z.json().refine((v) => v !== null, 'value 不能为 null') });

export function registerTenantSettingRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get('/api/tenant/settings/:key', async (c) => {
    const { tenantId, userId } = tenantOf(c);
    const key = settingKey(c);
    await requirePermission(deps.authorize, { tenantId, userId, action: 'tenant.settings.read', resource: key });
    const setting = await withTenant(deps.db, tenantId, (tx) => readEffectiveSetting(tx, tenantId, key));
    return respond(c, setting);
  });

  router.put('/api/tenant/settings/:key', async (c) => {
    const ctx = tenantOf(c);
    const key = settingKey(c);
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.settings.write', resource: key });
    const expectedRevision = ifMatch(c);
    const { value } = await parseBody(c);
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { op: 'override', key, expectedRevision, value },
      execute: async (tx, commandId) => {
        const write = { ...ctx, key, expectedRevision, now: deps.clock(), commandId };
        return { status: 200, body: await overrideSetting(tx, write, value) };
      },
    });
    return respond(c, result.body as EffectiveSetting);
  });

  router.delete('/api/tenant/settings/:key/override', async (c) => {
    const ctx = tenantOf(c);
    const key = settingKey(c);
    await requirePermission(deps.authorize, { ...ctx, action: 'tenant.settings.write', resource: key });
    const expectedRevision = ifMatch(c);
    const result = await runCommand(deps.db, ctx, {
      id: c.req.header('idempotency-key'),
      fingerprint: { op: 'restore', key, expectedRevision },
      execute: async (tx, commandId) => {
        const write = { ...ctx, key, expectedRevision, now: deps.clock(), commandId };
        return { status: 200, body: await restoreSetting(tx, write) };
      },
    });
    return respond(c, result.body as EffectiveSetting);
  });
}

function respond(c: Context, setting: EffectiveSetting): Response {
  c.header('ETag', `"${setting.revision}"`);
  return c.json(setting);
}

function settingKey(c: Context): string {
  const key = c.req.param('key') ?? '';
  if (!SETTING_KEY.test(key) || key.length > 100) throw new AppError('VALIDATION_FAILED', '配置键不合法');
  return key;
}

/** 写请求必须携带对象 revision（AGENTS.md §10「并发」）；无覆盖时当前 revision 为 0。 */
function ifMatch(c: Context): number {
  const match = IF_MATCH.exec(c.req.header('if-match')?.trim() ?? '');
  if (!match) throw new AppError('REVISION_REQUIRED', '写请求必须在 If-Match 中携带 revision');
  return Number(match[1]);
}

async function parseBody(c: Context): Promise<z.infer<typeof overrideBody>> {
  const raw: unknown = await c.req.json().catch(() => undefined);
  const parsed = overrideBody.safeParse(raw);
  if (!parsed.success) throw new AppError('VALIDATION_FAILED', '请求体应为 { value: <JSON> }', parsed.error.issues);
  return parsed.data;
}
