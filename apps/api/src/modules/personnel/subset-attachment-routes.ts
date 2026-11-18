/**
 * F-479 §10 人员子集附件的 HR 入口（4 个路由，挂在人员子集路径下）：登记 / 上传 / 删除未绑定文件、下载已绑定文件。
 * 守卫：PersonnelObject 与子集对象的 update + 附件字段可编辑 + 员工数据范围（requirePerson）+ 文件归属（上传人 + 目标员工）；
 * 写命令在事务内、查台账前复核（CommandGuard.before），撤权后同键重放得 403。
 * 不复用人员模块的 write()：它会按子集字段查看权裁剪回执，而这里的回执是文件元数据。
 */
import { withTenant, type Tx } from '@italent/db';
import { PERSONNEL_OBJECT, subsetAttachmentFields, SUBSETS, type SubsetKind } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { parseBody, revision, uuidParam } from '../job/context.js';
import { authorizeInTransaction, getModuleViewableFields } from '../permission/module-access.js';
import { access, authorize, preflight, requirePerson, type AccessContext } from './access.js';
import { loadSubset } from './subsets.js';
import { subsetKind } from './validation.js';
import { safe } from './http.js';
import { sameOrigin } from '../attachments/access.js';
import { respondAttachment, readCarrierAttachment } from '../attachments/carrier-read.js';
import * as service from '../attachments/service.js';
import { SUBSET_BUSINESS_TYPE, SUBSET_PURPOSE } from '../attachments/subset-read.js';

const BASE = '/api/tenant/personnel/employees/:employeeId/subsets/:kind';
const registration = z
  .object({
    field: z.string().max(100),
    filename: z.string().min(1).max(1024),
    contentType: z.string().max(100),
    byteSize: z.number().int(),
    sha256: z.string().max(100),
  })
  .strict();

/** 人员主对象 update + 子集附件字段至少一个可编辑（登记按声明的字段，上传 / 删除按任一附件字段）。 */
async function authorizeEdit(
  authorizer: TenantRouteDeps['authorize'],
  ctx: AccessContext,
  kind: SubsetKind,
  fields: readonly string[],
) {
  await authorize(authorizer, { ...ctx, objectCode: PERSONNEL_OBJECT }, 'update', {});
  let denied: AppError | undefined;
  for (const field of fields) {
    try {
      return await authorize(authorizer, ctx, 'update', { [field]: null });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'FORBIDDEN') throw error;
      denied = error;
    }
  }
  throw denied!;
}

async function attachmentWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: AccessContext,
  target: { kind: SubsetKind; employeeId: string; fields: readonly string[] },
  input: object,
  status: 201 | 200,
  execute: (tx: Tx, owner: service.OwnerAccess, attachment: service.AttachmentContext) => Promise<object>,
) {
  const check = async (tx: Tx) => {
    await requirePerson(tx, ctx, target.employeeId);
    await authorizeEdit(authorizeInTransaction(deps.authorize, tx), ctx, target.kind, target.fields);
  };
  await withTenant(deps.db, ctx.tenantId, check);
  const owner = { ctx, employee: { id: target.employeeId } };
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, input },
    guard: { before: check },
    execute: async (tx, commandId) => ({
      status,
      body: await execute(tx, owner, { ...ctx, commandId }),
    }),
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json(result.body as object, result.status as 200 | 201);
}

/** 解析路径并做对象 update 判定（子集对象 object.update + 范围）；字段级与人员主对象判定在 attachmentWrite() 里。 */
async function entry(c: Context<TenantEnv>, deps: TenantRouteDeps, expectedRevision: number) {
  sameOrigin(c);
  const kind = subsetKind(c.req.param('kind') ?? '');
  const employeeId = uuidParam(c, 'employeeId');
  const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'update', {}, undefined, expectedRevision);
  return { kind, employeeId, ctx };
}

export function registerSubsetAttachmentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(`${BASE}/attachments`, (c) =>
    safe(async () => {
      const { kind, employeeId, ctx } = await entry(c, deps, 0);
      const { field, ...rest } = await parseBody(c, registration);
      if (!subsetAttachmentFields(kind).includes(field)) throw new AppError('VALIDATION_FAILED', '该字段不是附件字段');
      const input = { ...rest, purpose: SUBSET_PURPOSE };
      return attachmentWrite(
        c,
        deps,
        ctx,
        { kind, employeeId, fields: [field] },
        { field, ...rest },
        201,
        (tx, owner, attachment) => service.registerFile(tx, owner, attachment, input, SUBSET_PURPOSE),
      );
    }),
  );
  router.post(`${BASE}/attachments/:fileId/upload`, (c) =>
    safe(async () => {
      const expected = revision(c);
      const { kind, employeeId, ctx } = await entry(c, deps, expected);
      const id = uuidParam(c, 'fileId');
      const input = await parseBody(c, z.object({ base64: z.string() }).strict());
      const target = { kind, employeeId, fields: subsetAttachmentFields(kind) };
      return attachmentWrite(c, deps, ctx, target, { id, ...input }, 200, (tx, owner, attachment) =>
        service.uploadFile(tx, owner, attachment, id, expected, input.base64, SUBSET_PURPOSE),
      );
    }),
  );
  router.delete(`${BASE}/attachments/:fileId`, (c) =>
    safe(async () => {
      const expected = revision(c);
      const { kind, employeeId, ctx } = await entry(c, deps, expected);
      const id = uuidParam(c, 'fileId');
      if (c.req.raw.body !== null) await parseBody(c, z.object({}).strict());
      const target = { kind, employeeId, fields: subsetAttachmentFields(kind) };
      return attachmentWrite(c, deps, ctx, target, { id }, 200, (tx, owner, attachment) =>
        service.deleteFile(tx, owner, attachment, id, expected, SUBSET_PURPOSE),
      );
    }),
  );
  router.get(`${BASE}/:id/attachments/:fileId/content`, (c) =>
    safe(async () => {
      const kind = subsetKind(c.req.param('kind') ?? '');
      const ctx = await access(c, deps, SUBSETS[kind].objectCode, 'view');
      const employeeId = uuidParam(c, 'employeeId');
      await preflight(deps, ctx, employeeId);
      // 字段无查看权 → 取不到引用 → 404“附件不存在”，不暴露存在性（§10.6）
      const viewable = await getModuleViewableFields(deps, ctx, ctx.objectCode);
      const { row, bytes } = await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const record = await loadSubset(tx, ctx, employeeId, kind, uuidParam(c));
        const refs = subsetAttachmentFields(kind)
          .filter((field) => viewable === undefined || viewable.has(field))
          .flatMap((field) => (typeof record[field] === 'string' ? [record[field] as string] : []));
        const live = { mode: 'live' } as const;
        return readCarrierAttachment(
          tx,
          ctx.tenantId,
          String(record.id),
          refs,
          uuidParam(c, 'fileId'),
          live,
          SUBSET_BUSINESS_TYPE,
        );
      });
      return respondAttachment(c, row, bytes);
    }),
  );
}
