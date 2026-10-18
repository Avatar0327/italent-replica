/**
 * Offer 管理路由（R2 BE-14a C1，DEC-581），子应用挂在 /api/tenant/offers，策略登记在 offer/policy.ts（F-039）。
 * 读：Offer 对象查看权 + 当前数据范围；写：对象数据操作 + 实际写入字段的编辑权（新建 / 复制含继承来的字段，删除只判开关）。
 * 转移状态、失效、转移表单与 OF-R3 发送判定（C2，BE-14a2）在 transitions.ts；单个 / 批量发起审批随 BE-14a3（registerApprovals）；
 * 列表 / 详情按权限带出可用的行操作。
 */
import { withTenant } from '@italent/db';
import { OFFER_OBJECT, OFFER_VIEWS, offerView } from '@italent/domain';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { policedSub } from '../../route-policy/index.js';
import { jsonBody } from '../employment/context.js';
import { pageQuery, uuidParam } from '../job/context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { objectContext } from '../permission/module-route-access.js';
import {
  offerFieldsCheck,
  offerOperationCheck,
  offerReadContext,
  runDictionaryWrite,
  runOfferWrite,
  trimOffer,
  type OfferContext,
} from './context.js';
import {
  listOfferDictionary,
  offerDictionaryKind,
  parseOfferDictionaryInput,
  saveOfferDictionaryEntry,
} from './dictionaries.js';
import { withRehireHint } from './identity.js';
import { frozenPerTransaction, offerCopyCheck, offerCreateCheck } from './checks.js';
import { offerApprovalFields, submitOfferApproval, submitOfferBatch } from './approval.js';
import { parseOfferBatch, parseOfferCreate, parseOfferSubmit, parseOfferUpdate } from './input.js';
import { OFFER_POLICIES } from './policy.js';
import { registerOfferSend } from './send.js';
import {
  copyOffer,
  createOffer,
  deleteOffer,
  listOffers,
  loadOffer,
  lockOffer,
  offerCreateWrites,
  offerDetail,
  offerStillVisible,
  updateOffer,
} from './service.js';
import { offerActionAccess, registerOfferTransitions } from './transitions.js';

type C = Context<TenantEnv>;
const enabledQuery = z.enum(['true', 'false']).optional();
const LIST_CONTROLS = new Set(['view', 'page', 'pageSize']);

/** 筛选条件只能用本视图登记的字段，且须有该字段查看权（不让看不见的字段经筛选泄露）。 */
async function listFilters(c: C, deps: TenantRouteDeps, ctx: OfferContext, key: string | undefined) {
  const view = offerView(key ?? 'pending');
  if (!view) throw new AppError('VALIDATION_FAILED', 'Offer 视图不存在', { reason: 'OFFER_VIEW_UNKNOWN' });
  const allowed = new Set(view.filters.flatMap((filter) => (filter.field ? [filter.field as string] : [])));
  const filters: Record<string, string> = {};
  for (const [name, value] of Object.entries(c.req.query())) {
    if (LIST_CONTROLS.has(name)) continue;
    if (!allowed.has(name) || !value.trim())
      throw new AppError('VALIDATION_FAILED', '筛选条件不属于本视图', { reason: 'OFFER_FILTER_UNKNOWN', field: name });
    filters[name] = value.trim();
  }
  const viewable = await getModuleViewableFields(deps, ctx, OFFER_OBJECT);
  const hidden = Object.keys(filters).filter((field) => viewable && !viewable.has(field));
  if (hidden.length)
    throw new AppError('FORBIDDEN', '无权按该字段筛选', { reason: 'FILTER_FIELD_HIDDEN', fields: hidden });
  return { view, filters };
}

function registerDictionaries(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  // 下拉读取：持 Offer 查看权即可读；字典无组织字段，不按范围裁剪
  module.get('/dictionaries/:kind', async (c) => {
    const ctx = await objectContext(c, deps, OFFER_OBJECT, 'view');
    const kind = offerDictionaryKind(c.req.param('kind'));
    const enabled = enabledQuery.safeParse(c.req.query('enabled'));
    if (!enabled.success) throw new AppError('VALIDATION_FAILED', 'enabled 只能为 true 或 false');
    const filter = enabled.data === undefined ? undefined : enabled.data === 'true';
    const items = await withTenant(deps.db, ctx.tenantId, (tx) => listOfferDictionary(tx, ctx.tenantId, kind, filter));
    return c.json({ items });
  });
  module.post('/dictionaries/:kind', async (c) => {
    const kind = offerDictionaryKind(c.req.param('kind'));
    const input = parseOfferDictionaryInput(await jsonBody(c), 'create');
    return runDictionaryWrite(c, deps, { kind, input }, 'create', input, async (tx, ctx) => ({
      status: 201,
      body: await saveOfferDictionaryEntry(tx, ctx, kind, input),
    }));
  });
  module.put('/dictionaries/:kind/:id', async (c) => {
    const kind = offerDictionaryKind(c.req.param('kind'));
    const id = uuidParam(c);
    const input = parseOfferDictionaryInput(await jsonBody(c), 'update');
    return runDictionaryWrite(c, deps, { kind, id, input }, 'update', input, async (tx, ctx) => ({
      status: 200,
      body: await saveOfferDictionaryEntry(tx, ctx, kind, input, id),
    }));
  });
}

/** 批量发起的结果是一组 Offer：重放时逐个复核仍在当前范围。 */
const batchVisible = async (tx: Parameters<typeof loadOffer>[0], ctx: OfferContext, body: unknown) => {
  for (const item of (body as { items?: { id: string }[] } | null)?.items ?? []) await loadOffer(tx, ctx, item.id);
};

/** 发起审批（BE-14a3）：按 Offer 对象编辑开关 + 当前范围判定；审批流转交给审批中心（同事务）。 */
function registerApprovals(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/batch-approvals', async (c) => {
    const input = parseOfferBatch(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      input,
      'update',
      offerOperationCheck('update'),
      async (tx, ctx) => ({
        status: 201,
        body: await submitOfferBatch(tx, ctx, input, offerApprovalFields(deps, ctx)),
      }),
      { isNew: true, replayed: batchVisible },
    );
  });
  module.post('/:id/approval', async (c) => {
    const id = uuidParam(c);
    parseOfferSubmit(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      { id },
      'update',
      offerOperationCheck('update'),
      async (tx, ctx) => ({
        status: 200,
        body: await submitOfferApproval(tx, ctx, id, offerApprovalFields(deps, ctx)),
      }),
      { replayed: offerStillVisible },
    );
  });
}

function registerCommands(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/', async (c) => {
    const input = parseOfferCreate(await jsonBody(c));
    const writes = frozenPerTransaction((tx, ctx) => offerCreateWrites(tx, ctx, input));
    return runOfferWrite(
      c,
      deps,
      input,
      'create',
      offerCreateCheck(input, writes),
      async (tx, ctx) => ({ status: 201, body: await createOffer(tx, ctx, await writes(tx, ctx)) }),
      {
        isNew: true,
        replayed: offerStillVisible,
        respond: (ctx, body) => withRehireHint(deps, ctx, body),
      },
    );
  });
  module.put('/:id', async (c) => {
    const id = uuidParam(c);
    const { syncPendingEntry, ...input } = parseOfferUpdate(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      { id, input, syncPendingEntry: syncPendingEntry ?? false },
      'update',
      offerFieldsCheck('update', input),
      async (tx, ctx) => ({
        status: 200,
        body: await updateOffer(tx, ctx, id, input, {
          syncPendingEntry: syncPendingEntry === true,
          approvalFields: offerApprovalFields(deps, ctx),
        }),
      }),
      { replayed: offerStillVisible },
    );
  });
  module.delete('/:id', async (c) => {
    const id = uuidParam(c);
    return runOfferWrite(c, deps, { id }, 'delete', offerOperationCheck('delete'), async (tx, ctx) => ({
      status: 200,
      body: await deleteOffer(tx, ctx, id),
    }));
  });
  module.post('/:id/copy', async (c) => {
    const id = uuidParam(c);
    const source = frozenPerTransaction((tx, ctx) => lockOffer(tx, ctx, id));
    return runOfferWrite(
      c,
      deps,
      { id },
      'create',
      offerCopyCheck(source),
      async (tx, ctx) => ({ status: 201, body: await copyOffer(tx, ctx, await source(tx, ctx)) }),
      { replayed: offerStillVisible },
    );
  });
}

export const registerOfferRoutes: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, OFFER_POLICIES, () => new Hono<TenantEnv>());
  module.get('/views', async (c) => {
    await objectContext(c, deps, OFFER_OBJECT, 'view');
    return c.json({ items: OFFER_VIEWS });
  });
  registerDictionaries(module, deps);
  module.get('/', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const { view, filters } = await listFilters(c, deps, ctx, c.req.query('view'));
    const page = pageQuery(c);
    const { allowed, toolbarActions } = await offerActionAccess(deps, ctx);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listOffers(tx, ctx, { view, filters, limit: page.limit, offset: page.offset }, allowed),
    );
    const body = {
      ...result,
      toolbarActions,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope.hasDataPermission,
    };
    return c.json(await trimOffer(deps, ctx, body));
  });
  module.get('/:id', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const id = uuidParam(c);
    const { allowed } = await offerActionAccess(deps, ctx);
    const body = await withTenant(deps.db, ctx.tenantId, (tx) => offerDetail(tx, ctx, id, allowed));
    return c.json(await trimOffer(deps, ctx, body));
  });
  registerCommands(module, deps);
  registerOfferTransitions(module, deps);
  registerOfferSend(module, deps);
  registerApprovals(module, deps);
  router.route('/api/tenant/offers', module);
};
