/** F-038 路由：权限随人才标准对象，不新增独立图片权限；每次请求及重放按当前父对象重新验权。 */
import { withTenant, type Tx } from '@italent/db';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand, type CommandResult } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { talentContext, talentScope, talentWriteContext, type TalentContext } from './access.js';
import { parseBody, revision, TALENT_BASE, uuidParam } from './http.js';
import * as service from './model-image-service.js';
import type { WriteContext } from './write-support.js';

const metadata = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.string().max(100),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const upload = z.object({ base64: z.string() }).strict();
const BASE = `${TALENT_BASE}/criteria/:id/model-image`;

export function registerModelImageRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(BASE, async (c) => {
    const ctx = await talentContext(c, deps, 'criterion');
    return c.json(await present(c, deps, ctx, uuidParam(c)));
  });
  router.get(`${BASE}/attachments/:attachmentId/content`, async (c) => {
    const ctx = await talentContext(c, deps, 'criterion');
    const id = uuidParam(c);
    const attachmentId = uuidParam(c, 'attachmentId');
    const scope = await talentScope(c, deps, ctx, 'criterion');
    const image = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      await service.imageOwner(tx, ctx.tenantId, id, scope);
      return service.imageContent(tx, ctx.tenantId, id, attachmentId);
    });
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Type', image.contentType);
    return c.body(new Uint8Array(image.bytes));
  });
  router.post(`${BASE}/attachments`, async (c) => {
    sameOrigin(c);
    const ctx = await imageWriteContext(c, deps);
    const id = uuidParam(c);
    const body = await parseBody(c, metadata);
    const result = await write(c, deps, ctx, id, body, (tx, w) => service.registerModelImage(tx, w, id, body), 201);
    // 当前父对象验权后只返回登记元数据；台账从不包含图片内容。
    const view = await present(c, deps, ctx, id);
    const attachmentId = (result.body as { attachment: { id: string } }).attachment.id;
    const attachment = await withTenant(deps.db, ctx.tenantId, (tx) =>
      service.registeredImage(tx, ctx.tenantId, id, attachmentId),
    );
    return c.json({ revision: view.revision, attachment }, 201);
  });
  router.post(`${BASE}/attachments/:attachmentId/upload`, async (c) => {
    sameOrigin(c);
    const ctx = await imageWriteContext(c, deps);
    const id = uuidParam(c);
    const attachmentId = uuidParam(c, 'attachmentId');
    const body = await parseBody(c, upload);
    await write(c, deps, ctx, id, body, (tx, w) => service.uploadModelImage(tx, w, id, attachmentId, body.base64));
    return c.json(await present(c, deps, ctx, id));
  });
  router.delete(BASE, async (c) => {
    sameOrigin(c);
    const ctx = await imageWriteContext(c, deps);
    const id = uuidParam(c);
    await write(c, deps, ctx, id, {}, (tx, w) => service.deleteModelImage(tx, w, id));
    return c.json(await present(c, deps, ctx, id));
  });
}

async function write(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: TalentContext,
  id: string,
  body: object,
  execute: (tx: Tx, ctx: WriteContext) => Promise<object>,
  status: 200 | 201 = 200,
): Promise<CommandResult> {
  const scope = await talentScope(c, deps, ctx, 'criterion');
  // 先验当前父对象，使重放也不能绕过范围或通过旧命令访问已删除标准。
  await withTenant(deps.db, ctx.tenantId, (tx) => service.imageOwner(tx, ctx.tenantId, id, scope));
  return runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input: body },
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, { ...ctx, commandId, scope, references: {}, referenceFields: {} }),
    }),
  });
}

async function imageWriteContext(c: Context<TenantEnv>, deps: TenantRouteDeps) {
  const ctx = await talentWriteContext(c, deps, 'criterion', 'update', revision(c));
  // 图片固定投影随标准详情：写响应及旧命令重放也不能绕过当前查看权。
  await talentContext(c, deps, 'criterion');
  return ctx;
}

async function present(c: Context<TenantEnv>, deps: TenantRouteDeps, ctx: TalentContext, id: string) {
  const scope = await talentScope(c, deps, ctx, 'criterion');
  const state = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const owner = await service.imageOwner(tx, ctx.tenantId, id, scope);
    return { revision: owner.revision, modelImage: await service.currentImage(tx, ctx.tenantId, id) };
  });
  let canEdit = false;
  try {
    await talentWriteContext(c, deps, 'criterion', 'update', state.revision);
    canEdit = true;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'FORBIDDEN') throw error;
  }
  c.header('ETag', `"${state.revision}"`);
  c.header('Cache-Control', 'private, no-store');
  return { ...state, canEdit };
}

function sameOrigin(c: Context): void {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) throw new AppError('FORBIDDEN', '只接受同源写请求');
  if (c.req.header('sec-fetch-site') === 'cross-site') throw new AppError('FORBIDDEN', '只接受同源写请求');
}
