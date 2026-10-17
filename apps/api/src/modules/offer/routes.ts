/**
 * Offer 管理路由（R2 BE-14a C1，DEC-581），子应用挂在 /api/tenant/offers，策略登记在 offer/policy.ts（F-039）。
 * 读：Offer 对象查看权 + 当前数据范围；写：对象数据操作 + 实际写入字段的编辑权（新建 / 复制含继承来的字段，删除只判开关）。
 * 转移状态、失效、行操作与 OF-R3 的入口随 C2（BE-14a2）接入，本段不注册。
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
import { offerCopyCheck, offerCreateCheck } from './checks.js';
import { parseOfferCreate, parseOfferUpdate } from './input.js';
import { OFFER_POLICIES } from './policy.js';
import { copyOffer, createOffer, deleteOffer, listOffers, loadOffer, offerDetail, updateOffer } from './service.js';

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

/** 写命令的结果对象：重放时复核仍在当前范围（撤范围后同键重放 404）。 */
const stillVisible = async (tx: Parameters<typeof loadOffer>[0], ctx: OfferContext, body: unknown) => {
  const id = (body as { id?: string } | null)?.id;
  if (id) await loadOffer(tx, ctx, id);
};

function registerCommands(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/', async (c) => {
    const input = parseOfferCreate(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      input,
      'create',
      offerCreateCheck(input),
      async (tx, ctx) => ({ status: 201, body: await createOffer(tx, ctx, input) }),
      { isNew: true, replayed: stillVisible },
    );
  });
  module.put('/:id', async (c) => {
    const id = uuidParam(c);
    const input = parseOfferUpdate(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      { id, input },
      'update',
      offerFieldsCheck('update', input),
      async (tx, ctx) => ({ status: 200, body: await updateOffer(tx, ctx, id, input) }),
      { replayed: stillVisible },
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
    return runOfferWrite(
      c,
      deps,
      { id },
      'create',
      offerCopyCheck(id),
      async (tx, ctx) => ({ status: 201, body: await copyOffer(tx, ctx, id) }),
      { replayed: stillVisible },
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
    const result = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listOffers(tx, ctx, { view, filters, limit: page.limit, offset: page.offset }),
    );
    const body = {
      ...result,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope.hasDataPermission,
    };
    return c.json(await trimOffer(deps, ctx, body));
  });
  module.get('/:id', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const id = uuidParam(c);
    const body = await withTenant(deps.db, ctx.tenantId, (tx) => offerDetail(tx, ctx, id));
    return c.json(await trimOffer(deps, ctx, body));
  });
  registerCommands(module, deps);
  router.route('/api/tenant/offers', module);
};
