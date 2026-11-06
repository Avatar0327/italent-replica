import { withTenant, type Tx } from '@italent/db';
import { ATTACHMENT_PURPOSES, attachmentDisposition } from '@italent/domain';
import type { Context } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { selfAccess } from '../employee-self-service/access.js';
import type { SelfAccess } from '../employee-self-service/access.js';
import { parseBody, revision, uuidParam } from '../job/context.js';
import { requireAttachmentRead, requireAttachmentWrite } from './access.js';
import * as service from './service.js';

export const ATTACHMENTS_BASE = '/api/tenant/attachments';
/** 上传体是 JSON 里的 base64：最大用途上限的 4/3 加余量；只对上传路由放宽（app.ts limitBody）。 */
export const ATTACHMENT_BODY_LIMIT =
  4 * Math.ceil(Math.max(...Object.values(ATTACHMENT_PURPOSES).map((p) => p.maxBytes)) / 3) + 1024;

const registration = z
  .object({
    purpose: z.string().max(100),
    filename: z.string().min(1).max(1024),
    contentType: z.string().max(100),
    byteSize: z.number().int(),
    sha256: z.string().max(100),
  })
  .strict();

export const registerAttachmentRoutes: TenantRouteModule = (router, deps) => {
  router.post(ATTACHMENTS_BASE, async (c) => {
    sameOrigin(c);
    const input = await parseBody(c, registration);
    return write(c, deps, 0, input, 201, (tx, self, ctx) => service.registerFile(tx, self, ctx, input));
  });
  router.post(`${ATTACHMENTS_BASE}/:id/upload`, async (c) => {
    sameOrigin(c);
    const id = uuidParam(c, 'id');
    const expected = revision(c);
    const input = await parseBody(c, z.object({ base64: z.string() }).strict());
    return write(c, deps, expected, { id, ...input }, 200, (tx, self, ctx) =>
      service.uploadFile(tx, self, ctx, id, expected, input.base64),
    );
  });
  router.delete(`${ATTACHMENTS_BASE}/:id`, async (c) => {
    sameOrigin(c);
    const id = uuidParam(c, 'id');
    const expected = revision(c);
    if (c.req.raw.body !== null) await parseBody(c, z.object({}).strict());
    return write(c, deps, expected, { id }, 200, (tx, self, ctx) => service.deleteFile(tx, self, ctx, id, expected));
  });
  router.get(`${ATTACHMENTS_BASE}/:id`, async (c) => {
    const id = uuidParam(c, 'id');
    const self = await selfAccess(c, deps, 0, 'exit');
    const body = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
      await requireAttachmentRead(tx, self);
      return service.readTemporaryMeta(tx, self, id);
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json(body);
  });
  router.get(`${ATTACHMENTS_BASE}/:id/content`, async (c) => {
    const id = uuidParam(c, 'id');
    const self = await selfAccess(c, deps, 0, 'exit');
    const { row, bytes } = await withTenant(deps.db, self.ctx.tenantId, async (tx) => {
      await requireAttachmentRead(tx, self);
      return service.readTemporaryContent(tx, self, id);
    });
    // 防内联执行：附件下载、禁嗅探、沙箱 CSP、同源资源策略、不缓存
    c.header('Content-Type', row.contentType!);
    c.header('Content-Disposition', attachmentDisposition(row.filename));
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; sandbox");
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Cache-Control', 'private, no-store');
    c.header('Content-Length', String(bytes.length));
    c.header('ETag', `"${row.sha256}"`);
    return c.body(new Uint8Array(bytes));
  });
};

/**
 * 写命令：selfAccess（未绑定 → 403）后进命令台账；写权限在事务内、查台账前复核（CommandGuard.before），
 * 首次、重放与失败后回查都经过，撤权后同键重放得 403。
 */
async function write(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  expectedRevision: number,
  input: object,
  status: 201 | 200,
  execute: (tx: Tx, self: SelfAccess, ctx: service.AttachmentContext) => Promise<object>,
) {
  const self = await selfAccess(c, deps, expectedRevision, 'exit');
  const ctx = { ...self.ctx, commandId: '' };
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision, input },
    guard: { before: (tx) => requireAttachmentWrite(tx, self) },
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, self, { ...self.ctx, commandId, now: ctx.now }),
    }),
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json(result.body as object, result.status as 200 | 201);
}

function sameOrigin(c: Context) {
  const origin = c.req.header('origin');
  if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('sec-fetch-site') === 'cross-site')
    throw new AppError('FORBIDDEN', '只接受同源写请求');
}
