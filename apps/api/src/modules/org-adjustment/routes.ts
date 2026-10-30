/**
 * 组织调整申请路由（R2-T08 §9.3 路由 1～3、7；BE-10b1 头字段与调整范围）。
 * 组织明细（4～6、8～9）与提交 / 撤回（10～）不在本片注册：本片的单据不可提交、不可执行（§14.1）。
 * 路由在命令外按当前权限判数据操作、字段、按钮；命令守卫在事务内经 `authorizeHead` 判主体组织与调整范围
 * （首次与幂等重放都经过，§6.3“五处共用”），改头 / 作废另对锁住的现值判一次，新旧两侧都要在范围内。
 */
import { withTenant, type Tx } from '@italent/db';
import { ORG_ADJUSTMENT_OBJECT_CODE } from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { parseBody, requireNew, revision, uuidParam } from '../job/context.js';
import { authorizeInTransaction, resolveModuleScopeInTransaction, scopeAllows } from '../permission/module-access.js';
import { objectContext, button, trimModuleResponse, writeFields } from '../permission/module-route-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import { authorizeHead, authorizeHeadAction, HEAD_BUTTONS } from './access.js';
import {
  checkAdjustment,
  createAdjustment,
  loadAdjustment,
  updateAdjustmentHead,
  voidAdjustment,
  type AdjustmentView,
} from './service.js';
import { createSchema, normalizeHead, patchSchema } from './validation.js';

const BASE = '/api/tenant/org-adjustment/adjustments';
const OBJECT = ORG_ADJUSTMENT_OBJECT_CODE;

export function registerOrgAdjustmentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  router.post(BASE, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'create', revision(c));
    requireNew(ctx);
    const input = normalizeHead(await parseBody(c, createSchema));
    await writeFields(deps, ctx, OBJECT, 'create', input);
    await button(deps, ctx, OBJECT, 'AddAdjustOrgApprovalBtn', 'list');
    const head = {
      actor: 'applicant',
      operation: 'create',
      fields: Object.keys(input),
      subjectOrgId: input.approvalSubjectOrgId,
      rangeOrgIds: input.adjustmentRange,
    } as const;
    return headCommand(c, deps, ctx, input, 201, {
      before: (tx) => authorizeHead(tx, deps, ctx, head),
      execute: (tx, commandCtx) => createAdjustment(tx, commandCtx, input),
    });
  });

  router.patch(`${BASE}/:id`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const input = normalizeHead(await parseBody(c, patchSchema));
    await writeFields(deps, ctx, OBJECT, 'update', input);
    await button(deps, ctx, OBJECT, 'EditAdjustOrgDetailBtn', 'detail');
    return headCommand(c, deps, ctx, input, 200, {
      before: (tx) =>
        authorizeStored(
          tx,
          ctx,
          id,
          (subjectOrgId, rangeOrgIds) =>
            authorizeHead(tx, deps, ctx, {
              actor: 'applicant',
              operation: 'update',
              fields: Object.keys(input),
              subjectOrgId,
              rangeOrgIds,
            }),
          (stored) => [
            input.approvalSubjectOrgId ?? stored.approvalSubjectOrgId,
            input.adjustmentRange ?? stored.adjustmentRange,
          ],
        ),
      execute: (tx, commandCtx) => updateAdjustmentHead(tx, commandCtx, id, input),
    });
  });

  router.post(`${BASE}/:id/void`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, z.strictObject({}));
    await button(deps, ctx, OBJECT, 'OrganizationApprovalDelete', 'list_row');
    return headCommand(c, deps, ctx, input, 200, {
      before: (tx) =>
        authorizeStored(tx, ctx, id, (subjectOrgId, rangeOrgIds) =>
          authorizeHeadAction(tx, deps, ctx, {
            actor: 'applicant',
            operation: 'update',
            button: HEAD_BUTTONS.void,
            subjectOrgId,
            rangeOrgIds,
          }),
        ),
      execute: (tx, commandCtx) => voidAdjustment(tx, commandCtx, id),
    });
  });

  // 整单只读校验：不进台账、不写数据，结果为校验信封（不是对象字段，不裁剪）
  router.post(`${BASE}/:id/check`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update');
    const id = uuidParam(c);
    await parseBody(c, z.strictObject({}));
    await button(deps, ctx, OBJECT, 'EditAdjustOrgDetailBtn', 'detail');
    const result = await withTenant(deps.db, ctx.tenantId, async (tx) => {
      const stored = await authorizeStored(tx, ctx, id, (subjectOrgId, rangeOrgIds) =>
        authorizeHeadAction(tx, deps, ctx, { actor: 'applicant', operation: 'update', subjectOrgId, rangeOrgIds }),
      );
      return checkAdjustment(tx, ctx.tenantId, stored);
    });
    return c.json(result, 200);
  });
}

/**
 * 对已存在申请单的授权：锁行读现值（不存在 → 404），现值的主体组织与调整范围交 `judge` 按当前权限判；`next` 给出时再判改后的值。
 * 状态、申请人与 revision 留给写服务（锁内同一行）。
 */
async function authorizeStored(
  tx: Tx,
  ctx: ScopeBusinessContext,
  id: string,
  judge: (subjectOrgId: string, rangeOrgIds: readonly string[]) => Promise<void>,
  next?: (stored: AdjustmentView) => readonly [string, readonly string[]],
): Promise<AdjustmentView> {
  const stored = await loadAdjustment(tx, ctx.tenantId, id, true);
  if (!stored) throw new AppError('NOT_FOUND', '组织调整申请不存在');
  await judge(stored.approvalSubjectOrgId, stored.adjustmentRange);
  if (next) await judge(...next(stored));
  return stored;
}

interface HeadCommand {
  before(tx: Tx): Promise<unknown>;
  execute(tx: Tx, ctx: ScopeBusinessContext): Promise<AdjustmentView>;
}

/** 头写入命令：台账幂等（同键同内容重放）；重放时结果的主体组织仍须在当前范围；ETag 取裁剪前的 revision。 */
async function headCommand(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  body: unknown,
  status: 200 | 201,
  command: HeadCommand,
) {
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, body },
    guard: {
      before: async (tx) => {
        await command.before(tx);
      },
      replayed: async (tx, stored) => {
        const bound = { ...deps, authorize: authorizeInTransaction(deps.authorize, tx) };
        const scope = await resolveModuleScopeInTransaction(bound, ctx, tx, OBJECT);
        const view = stored.body as AdjustmentView;
        if (!scopeAllows(scope, { orgId: view.approvalSubjectOrgId })) {
          throw new AppError('NOT_FOUND', '组织调整申请不存在');
        }
      },
    },
    execute: async (tx, commandId) => ({ status, body: await command.execute(tx, { ...ctx, commandId }) }),
  });
  const view = result.body as AdjustmentView;
  c.header('ETag', `"${view.revision}"`);
  return c.json(await trimModuleResponse(deps, ctx, OBJECT, view), result.status as 200 | 201);
}
