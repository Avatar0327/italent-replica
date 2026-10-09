import { withTenant, type Tx } from '@italent/db';
import type { Context } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import { tenantOf, type TenantEnv } from '../../tenant-context.js';
import { parseBody, revision, uuidParam } from '../job/context.js';
import * as service from './service.js';

const BASE = '/api/tenant/account/avatar';
const metadata = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.string().max(100),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const registerAvatarRoutes: TenantRouteModule = (router, deps) => {
  router.get(BASE, (c) => present(c, deps));
  router.post(`${BASE}/attachments`, async (c) => {
    sameOrigin(c);
    const input = await parseBody(c, metadata);
    const result = await write(c, deps, input, (tx, ctx) => service.registerAvatar(tx, ctx, input));
    const state = await withTenant(deps.db, tenantOf(c).tenantId, (tx) => service.presentAvatar(tx, tenantOf(c)));
    const id = (result.body as { attachment: { id: string } }).attachment.id;
    const attachment = await withTenant(deps.db, tenantOf(c).tenantId, async (tx) => {
      await service.ownMember(tx, tenantOf(c));
      return service.registeredAvatar(tx, tenantOf(c), id);
    });
    headers(c, state.revision);
    return c.json({ revision: state.revision, attachment }, 201);
  });
  router.post(`${BASE}/attachments/:attachmentId/upload`, async (c) => {
    sameOrigin(c);
    const id = uuidParam(c, 'attachmentId');
    const input = await parseBody(c, z.object({ base64: z.string() }).strict());
    await write(c, deps, input, (tx, ctx) => service.uploadAvatar(tx, ctx, id, input.base64));
    return present(c, deps);
  });
  router.delete(BASE, async (c) => {
    sameOrigin(c);
    if (c.req.raw.body !== null) await parseBody(c, z.object({}).strict());
    await write(c, deps, {}, (tx, ctx) => service.deleteAvatar(tx, ctx));
    return present(c, deps);
  });
  router.get('/api/tenant/avatars/:attachmentId/content', async (c) => {
    const ctx = tenantOf(c);
    const id = uuidParam(c, 'attachmentId');
    const content = await withTenant(deps.db, ctx.tenantId, (tx) => service.avatarContent(tx, ctx, id));
    headers(c);
    c.header('Content-Disposition', 'inline');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', content.contentType);
    return c.body(new Uint8Array(content.bytes));
  });
};

async function write(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  input: object,
  execute: (tx: Tx, ctx: service.AvatarContext) => Promise<object>,
) {
  const ctx = { ...tenantOf(c), expectedRevision: revision(c), now: deps.clock(), commandId: '' };
  // 在台账查询前和结果投影前都复核当前本人授权，不把旧命令视为权限凭证。
  await withTenant(deps.db, ctx.tenantId, (tx) => service.ownMember(tx, ctx));
  return runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input },
    execute: async (tx, commandId) => ({ status: 200, body: await execute(tx, { ...ctx, commandId }) }),
  });
}

async function present(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const ctx = tenantOf(c);
  const state = await withTenant(deps.db, ctx.tenantId, (tx) => service.presentAvatar(tx, ctx));
  headers(c, state.revision);
  return c.json(state);
}
function headers(c: Context, revision?: number) {
  c.header('Cache-Control', 'private, no-store');
  if (revision !== undefined) c.header('ETag', `"${revision}"`);
}
function sameOrigin(c: Context) {
  const origin = c.req.header('origin');
  if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('sec-fetch-site') === 'cross-site')
    throw new AppError('FORBIDDEN', '只接受同源写请求');
}
