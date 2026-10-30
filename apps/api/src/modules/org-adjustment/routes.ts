/**
 * 组织调整申请路由（R2-T08 §9.3 路由 1～9；BE-10b1 头字段与调整范围，BE-10b2 组织明细与基线）。
 * 提交 / 撤回（10～）不在本片注册：本片的单据不可提交、不可执行（§14.1）。
 * 路由在命令外按当前权限判数据操作、字段、按钮；命令守卫在事务内经 `authorizeHead` 判主体组织与调整范围
 * （首次与幂等重放都经过，§6.3“五处共用”），改头 / 作废另对锁住的现值判一次，新旧两侧都要在范围内。
 * 明细（4～6、8～9）的字段按 OrganizationApproval 的 `orgItems.*` 判；守卫经 `authorizeItem` 判按钮、主体组织与行涉及的
 * 组织（请求里的与库里现有行的），重放再按结果行复核组织范围；响应按 `orgItems.*` 查看权裁剪，校验信封随之隐去组织 ID。
 */
import { withTenant, type Tx } from '@italent/db';
import {
  ORG_ADJUSTMENT_DETAIL_OBJECT_CODE,
  ORG_ADJUSTMENT_OBJECT_CODE,
  ORG_ITEM_ENTRY_BUTTONS,
  type ButtonLevel,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { runCommand } from '../../commands.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { parseBody, requireNew, revision, uuidParam } from '../job/context.js';
import {
  authorizeInTransaction,
  getModuleViewableFields,
  resolveModuleScopeInTransaction,
  scopeAllows,
} from '../permission/module-access.js';
import { objectContext, button, trimModuleResponse, writeFields } from '../permission/module-route-access.js';
import type { ScopeBusinessContext } from '../permission/module-contracts.js';
import {
  authorizeHead,
  authorizeHeadAction,
  authorizeItem,
  HEAD_BUTTONS,
  orgScopeAuthorizer,
  type ItemAuthorization,
} from './access.js';
import { rebaseAll, rebaseItem } from './baseline.js';
import { addItemSchema, assertEntryType, itemFieldCodes, patchItemSchema, toContent } from './item-validation.js';
import { loadItems, type ItemsResult, type OrgItem } from './items-store.js';
import { addOrgItem, deleteOrgItem, patchOrgItem, type ItemWrite } from './org-items.js';
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
const DETAIL = ORG_ADJUSTMENT_DETAIL_OBJECT_CODE;
const ITEMS = `${BASE}/:id/org-items`;
const ROW_EDIT = [DETAIL, 'EditOrgApprovalDetail', 'list_row'] as const;

export function registerOrgAdjustmentRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  registerHeadRoutes(router, deps);
  registerItemRoutes(router, deps);
}

function registerHeadRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
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

  // 整单只读校验：不进台账、不写数据，结果为校验信封（不是对象字段；看不到目标组织字段时隐去问题里的组织 ID）
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
    return c.json(await trimCheck(deps, ctx, result), 200);
  });
}

function registerItemRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 路由 4：入口决定调整类型与按钮（编辑器入口挂主对象、明细列表入口挂明细对象）；入口与类型不符先 400
  router.post(ITEMS, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, addItemSchema);
    assertEntryType(input);
    const entry = ORG_ITEM_ENTRY_BUTTONS[input.entry];
    await button(deps, ctx, entry.objectCode, entry.code, entry.level);
    await writeFields(deps, ctx, OBJECT, 'update', itemFieldCodes(Object.keys(input)));
    return itemCommand(c, deps, ctx, id, input, {
      button: [entry.objectCode, entry.code, entry.level],
      orgIds: async () => [input.targetOrgId, ...inputOrgs(input)],
      execute: (tx, commandCtx) => addOrgItem(tx, commandCtx, id, input, orgScopeAuthorizer(deps, ctx)),
    });
  });

  router.patch(`${ITEMS}/:itemId`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const itemId = uuidParam(c, 'itemId');
    const input = await parseBody(c, patchItemSchema);
    await button(deps, ctx, ...ROW_EDIT);
    await writeFields(deps, ctx, OBJECT, 'update', itemFieldCodes(Object.keys(input)));
    return itemCommand(c, deps, ctx, id, input, {
      button: ROW_EDIT,
      orgIds: async (tx) => [...(await storedRowOrgs(tx, ctx, id, itemId)), ...inputOrgs(input)],
      execute: async (tx, commandCtx) => ({
        status: 200,
        result: await patchOrgItem(tx, commandCtx, id, itemId, input),
      }),
    });
  });

  router.delete(`${ITEMS}/:itemId`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const itemId = uuidParam(c, 'itemId');
    const rowDelete = [DETAIL, 'DelteOrgApprovalDetail', 'list_row'] as const;
    await button(deps, ctx, ...rowDelete);
    return itemCommand(
      c,
      deps,
      ctx,
      id,
      {},
      {
        button: rowDelete,
        orgIds: (tx) => storedRowOrgs(tx, ctx, id, itemId),
        execute: async (tx, commandCtx) => ({ status: 200, result: await deleteOrgItem(tx, commandCtx, id, itemId) }),
      },
    );
  });

  // 路由 8：单行刷新基线；本片只有组织明细，其它 section 一律 404
  router.post(`${BASE}/:id/items/:section/:itemId/rebase`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    if (c.req.param('section') !== 'org') throw new AppError('NOT_FOUND', '组织调整明细不存在');
    const itemId = uuidParam(c, 'itemId');
    const input = await parseBody(c, z.strictObject({}));
    await button(deps, ctx, ...ROW_EDIT);
    return itemCommand(c, deps, ctx, id, input, {
      button: ROW_EDIT,
      orgIds: (tx) => storedRowOrgs(tx, ctx, id, itemId),
      execute: async (tx, commandCtx) => ({ status: 200, result: await rebaseItem(tx, commandCtx, id, itemId) }),
    });
  });

  // 路由 9：整单刷新基线；每一行涉及的组织都要在组织范围
  router.post(`${BASE}/:id/rebase`, async (c) => {
    const ctx = await objectContext(c, deps, OBJECT, 'update', revision(c));
    const id = uuidParam(c);
    const input = await parseBody(c, z.strictObject({}));
    const [code, level] = HEAD_BUTTONS.update;
    await button(deps, ctx, OBJECT, code, level);
    return itemCommand(c, deps, ctx, id, input, {
      button: [OBJECT, code, level],
      orgIds: async (tx) => rowOrgs(await loadItems(tx, ctx.tenantId, id)),
      execute: async (tx, commandCtx) => ({ status: 200, result: await rebaseAll(tx, commandCtx, id) }),
    });
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

type OrgIds = readonly (string | null | undefined)[];
const rowOrgs = (rows: readonly OrgItem[]): OrgIds =>
  rows.flatMap((row) => [row.targetOrgId, row.parentOrgId, row.transferToOrgId]);
const inputOrgs = (input: Parameters<typeof toContent>[0]): OrgIds => {
  const content = toContent(input);
  return [content.parentOrgId, content.transferToOrgId];
};

/** 库里现有行（含其连带行）涉及的组织；行不存在时为空，由写服务报 404。 */
async function storedRowOrgs(tx: Tx, ctx: ScopeBusinessContext, id: string, itemId: string): Promise<OrgIds> {
  const items = await loadItems(tx, ctx.tenantId, id);
  return rowOrgs(items.filter((item) => item.id === itemId || item.cascadedFromItemId === itemId));
}

interface ItemCommand {
  readonly button: readonly [objectCode: string, code: string, level: ButtonLevel];
  /** 行涉及的已有组织：请求里的，与（改 / 删 / 刷新时）库里现有行的。 */
  orgIds(tx: Tx): Promise<OrgIds>;
  execute(tx: Tx, ctx: ScopeBusinessContext): Promise<ItemWrite>;
}

/**
 * 明细写入命令：守卫 before（首次与重放都经过）锁行读申请单（不存在 → 404），按当前权限判按钮、主体组织与行组织；
 * replayed 再按当前组织范围复核结果行涉及的组织（删除时为被删的行）。ETag 取申请单新 revision。
 */
async function itemCommand(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  id: string,
  body: unknown,
  command: ItemCommand,
) {
  const result = await runCommand(deps.db, ctx, {
    id: c.req.header('idempotency-key'),
    fingerprint: { method: c.req.method, path: c.req.path, expectedRevision: ctx.expectedRevision, body },
    guard: {
      before: async (tx) => {
        const stored = await loadAdjustment(tx, ctx.tenantId, id, true);
        if (!stored) throw new AppError('NOT_FOUND', '组织调整申请不存在');
        const input: ItemAuthorization = {
          button: command.button,
          subjectOrgId: stored.approvalSubjectOrgId,
          orgIds: await command.orgIds(tx),
        };
        await authorizeItem(tx, deps, ctx, input);
      },
      replayed: async (tx, stored) => {
        const orgIds = rowOrgs((stored.body as ItemsResult).items).filter((orgId): orgId is string => Boolean(orgId));
        await orgScopeAuthorizer(deps, ctx)(tx, [...new Set(orgIds)]);
      },
    },
    execute: async (tx, commandId) => {
      const written = await command.execute(tx, { ...ctx, commandId });
      return { status: written.status, body: written.result };
    },
  });
  const written = result.body as ItemsResult;
  c.header('ETag', `"${written.revision}"`);
  return c.json(await trimItems(deps, ctx, written), result.status as 200 | 201);
}

/** 行的身份与基线列总是返回；内容列按 `orgItems.<字段>` 查看权，引用本单行的列随对应的组织列。 */
const ITEM_IDENTITY = new Set(['id', 'seq', 'cascadedFromItemId', 'baseVersionId', 'baseOrgRevision']);
const ITEM_FOLLOWS: Readonly<Record<string, string>> = {
  parentItemId: 'parentOrgId',
  transferToItemId: 'transferToOrgId',
};

async function trimItems(deps: TenantRouteDeps, ctx: ScopeBusinessContext, result: ItemsResult) {
  const fields = await getModuleViewableFields(deps, ctx, OBJECT);
  if (!fields) return result;
  const keep = (key: string) => ITEM_IDENTITY.has(key) || fields.has(`orgItems.${ITEM_FOLLOWS[key] ?? key}`);
  return {
    ...result,
    items: result.items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => keep(key)))),
  };
}

/** 校验信封：看不到 `orgItems.targetOrgId` 时，明细问题不带组织 ID（行 ID 与原因照常返回）。 */
async function trimCheck<T extends { readonly errors: readonly object[] }>(
  deps: TenantRouteDeps,
  ctx: ScopeBusinessContext,
  result: T,
): Promise<T> {
  const fields = await getModuleViewableFields(deps, ctx, OBJECT);
  if (!fields || fields.has('orgItems.targetOrgId')) return result;
  const errors = result.errors.map((error) => {
    if (!('section' in error) || !('orgId' in error)) return error;
    const { orgId: _hidden, ...rest } = error;
    return rest;
  });
  return { ...result, errors };
}
