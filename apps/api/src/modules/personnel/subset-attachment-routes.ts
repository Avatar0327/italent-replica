/**
 * F-479 §10 人员子集附件的 HR 入口（4 个路由，挂在人员子集路径下）：登记 / 上传 / 删除未绑定文件、下载已绑定文件。
 * 守卫：PersonnelObject 与子集对象的 update + 附件字段可编辑 + 员工数据范围（requirePerson）+ 文件归属（上传人 + 目标员工）；
 * 写命令在事务内、查台账前复核（CommandGuard.before），撤权后同键重放得 403。
 * 不复用人员模块的 write()：它会按子集字段查看权裁剪回执，而这里的回执是文件元数据。
 */
import { attachmentFiles as F, and, eq, withTenant, type Tx } from '@italent/db';
import { PERSONNEL_OBJECT, subsetAttachmentFields, SUBSETS, type SubsetKind } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { parseBody, revision, uuidParam } from '../job/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import { access, authorize, preflight, requirePerson, type AccessContext } from './access.js';
import { loadSubset } from './subsets.js';
import { subsetKind } from './validation.js';
import { safe } from './http.js';
import { attachmentNotFound, sameOrigin } from '../attachments/access.js';
import { respondAttachment, readCarrierAttachment } from '../attachments/carrier-read.js';
import * as service from '../attachments/service.js';
import {
  parseSubsetTargetTag,
  SUBSET_BUSINESS_TYPE,
  SUBSET_PURPOSE,
  subsetTargetTag,
} from '../attachments/subset-read.js';

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

/** 写入口的检查目标：登记时由请求给出字段；上传 / 删除时由服务端按文件登记的标记确认，不信请求。 */
type Target = { kind: SubsetKind; employeeId: string } & ({ field: string } | { fileId: string });

/** 已登记文件的“子集:字段”标记；文件不存在、不是本人本员工名下或标记与路径子集不符一律 404，不暴露存在性。 */
async function registeredField(tx: Tx, ctx: AccessContext, kind: SubsetKind, employeeId: string, fileId: string) {
  const [row] = await tx
    .select({ tag: F.businessType })
    .from(F)
    .where(
      and(
        eq(F.tenantId, ctx.tenantId),
        eq(F.id, fileId),
        eq(F.purpose, SUBSET_PURPOSE),
        eq(F.ownerUserId, ctx.userId),
        eq(F.ownerEmployeeId, employeeId),
      ),
    );
  const target = parseSubsetTargetTag(row?.tag ?? null);
  if (!target || target.kind !== kind) throw attachmentNotFound();
  return target.field;
}

/**
 * 子集附件写入口的唯一守卫（DEC-431①）：登记 / 上传 / 删除、首次执行与同键重放都走它，在命令事务内、查台账前复核——
 * 1. 在本事务内重算员工数据范围（resolveModuleScopeInTransaction），再校验员工在范围内，入口之后撤范围即时生效；
 * 2. 人员主对象 update；
 * 3. 登记字段（登记时取请求字段，其后取文件上的标记）的编辑权，只撤一个字段就拒绝。
 */
function subsetAttachmentGuard(deps: TenantRouteDeps, ctx: AccessContext, target: Target) {
  return async (tx: Tx) => {
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, ctx.objectCode);
    const fresh = { ...ctx, scope };
    await requirePerson(tx, fresh, target.employeeId);
    // 没有附件字段的子集（如 training）没有附件入口：员工存在性之后返回客户端错误 400，不能落到 503
    if (!subsetAttachmentFields(target.kind).length) throw new AppError('VALIDATION_FAILED', '该子集不支持附件');
    const authorizer = authorizeInTransaction(deps.authorize, tx);
    await authorize(authorizer, { ...fresh, objectCode: PERSONNEL_OBJECT }, 'update', {});
    const field =
      'field' in target
        ? target.field
        : await registeredField(tx, fresh, target.kind, target.employeeId, target.fileId);
    await authorize(authorizer, fresh, 'update', { [field]: null });
  };
}

async function attachmentWrite(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: AccessContext,
  target: Target,
  input: object,
  status: 201 | 200,
  execute: (tx: Tx, owner: service.OwnerAccess, attachment: service.AttachmentContext) => Promise<object>,
) {
  const check = subsetAttachmentGuard(deps, ctx, target);
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

/** 解析路径并做对象 update 判定（子集对象 object.update + 范围）；字段级与人员主对象判定在 subsetAttachmentGuard() 里。 */
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
        { kind, employeeId, field },
        { field, ...rest },
        201,
        (tx, owner, attachment) =>
          service.registerFile(tx, owner, attachment, input, SUBSET_PURPOSE, subsetTargetTag(kind, field)),
      );
    }),
  );
  router.post(`${BASE}/attachments/:fileId/upload`, (c) =>
    safe(async () => {
      const expected = revision(c);
      const { kind, employeeId, ctx } = await entry(c, deps, expected);
      const id = uuidParam(c, 'fileId');
      const input = await parseBody(c, z.object({ base64: z.string() }).strict());
      const target = { kind, employeeId, fileId: id };
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
      const target = { kind, employeeId, fileId: id };
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
