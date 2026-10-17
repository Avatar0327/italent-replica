/**
 * Offer 管理路由（R2 BE-14a），子应用挂在 /api/tenant/offers，策略登记在 offer/policy.ts（F-039）。
 * 读：Offer 对象查看权 + 当前数据范围；写：对象数据操作 + 实际写入字段的编辑权，转移状态另按入口校验两项按钮之一。
 * 行操作只回显当前用户能执行的本段动作（转移 / 编辑 / 删除 / 复制 / 失效），其余矩阵动作原样给出（入口在 BE-14b）。
 */
import { withTenant } from '@italent/db';
import {
  OFFER_BUTTONS,
  OFFER_OBJECT,
  OFFER_SEND_APPROVAL_KEY,
  OFFER_VIEWS,
  buttonResource,
  offerView,
  validOfferSendApprovalSetting,
  type OfferRowAction,
} from '@italent/domain';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps, TenantRouteModule } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { policedSub } from '../../route-policy/index.js';
import { jsonBody } from '../employment/context.js';
import { pageQuery, uuidParam } from '../job/context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import { OFFER_DICTIONARY_OBJECT, offerReadContext, runOfferWrite, trimOffer, type OfferContext } from './context.js';
import {
  listOfferDictionary,
  offerDictionaryKind,
  parseOfferDictionaryInput,
  saveOfferDictionaryEntry,
} from './dictionaries.js';
import { parseOfferCreate, parseOfferInvalidate, parseOfferTransfer, parseOfferUpdate } from './input.js';
import { OFFER_POLICIES } from './policy.js';
import {
  copyOffer,
  createOffer,
  deleteOffer,
  invalidateOffer,
  listOffers,
  loadOffer,
  offerDetail,
  offerSendCheck,
  offerTransferForm,
  transferOffer,
  updateOffer,
} from './service.js';

registerSettingValidator(OFFER_SEND_APPROVAL_KEY, validOfferSendApprovalSetting);

type C = Context<TenantEnv>;
const enabledQuery = z.enum(['true', 'false']).optional();
const LIST_CONTROLS = new Set(['view', 'page', 'pageSize']);

/** 行操作里本段已实现、受权限控制的动作：没有对应权限就不显示（转移状态按行级按钮，DEC-533④）。 */
async function actionFilter(deps: TenantRouteDeps, ctx: OfferContext) {
  const can = (action: string, resource: string) => deps.authorize({ ...ctx, action, resource });
  const row = OFFER_BUTTONS.lineStatusTransfer;
  const [transfer, update, remove, create] = await Promise.all([
    can('object.button', buttonResource(OFFER_OBJECT, row.code, row.level)),
    can('object.update', OFFER_OBJECT),
    can('object.delete', OFFER_OBJECT),
    can('object.create', OFFER_OBJECT),
  ]);
  const gated: Partial<Record<OfferRowAction, boolean>> = {
    transfer,
    edit: update,
    invalidate: update,
    delete: remove,
    copy: create,
  };
  return (action: OfferRowAction) => gated[action] ?? true;
}

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
  module.get('/dictionaries/:kind', async (c) => {
    const ctx = await offerReadContext(c, deps);
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
    return runOfferWrite(
      c,
      deps,
      { kind, input },
      { operation: 'create', fields: input },
      async (tx, ctx) => ({ status: 201, body: await saveOfferDictionaryEntry(tx, ctx, kind, input) }),
      { objectCode: OFFER_DICTIONARY_OBJECT, isNew: true },
    );
  });
  module.put('/dictionaries/:kind/:id', async (c) => {
    const kind = offerDictionaryKind(c.req.param('kind'));
    const id = uuidParam(c);
    const input = parseOfferDictionaryInput(await jsonBody(c), 'update');
    return runOfferWrite(
      c,
      deps,
      { kind, id, input },
      { operation: 'update', fields: input },
      async (tx, ctx) => ({ status: 200, body: await saveOfferDictionaryEntry(tx, ctx, kind, input, id) }),
      { objectCode: OFFER_DICTIONARY_OBJECT },
    );
  });
}

/** 写命令的结果对象：重放时复核仍在当前范围（撤范围后同键重放 404）。 */
const stillVisible = async (tx: Parameters<typeof loadOffer>[0], ctx: OfferContext, body: unknown) => {
  const id = (body as { id?: string; deleted?: boolean } | null)?.id;
  if (id && !(body as { deleted?: boolean }).deleted) await loadOffer(tx, ctx, id);
};

function registerCommands(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.post('/', async (c) => {
    const input = parseOfferCreate(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      input,
      { operation: 'create', fields: input },
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
      { operation: 'update', fields: input },
      async (tx, ctx) => ({ status: 200, body: await updateOffer(tx, ctx, id, input) }),
      { replayed: stillVisible },
    );
  });
  module.delete('/:id', async (c) => {
    const id = uuidParam(c);
    return runOfferWrite(c, deps, { id }, { operation: 'delete' }, async (tx, ctx) => ({
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
      { operation: 'create' },
      async (tx, ctx) => ({ status: 201, body: await copyOffer(tx, ctx, id) }),
      { replayed: stillVisible },
    );
  });
  module.post('/:id/transfer', async (c) => {
    const id = uuidParam(c);
    const input = parseOfferTransfer(await jsonBody(c));
    const ref = input.entry === 'toolbar' ? OFFER_BUTTONS.statusTransfer : OFFER_BUTTONS.lineStatusTransfer;
    return runOfferWrite(
      c,
      deps,
      { id, input },
      { operation: 'update', button: ref },
      async (tx, ctx) => ({ status: 200, body: await transferOffer(tx, ctx, id, input) }),
      { replayed: stillVisible },
    );
  });
  module.post('/:id/invalidate', async (c) => {
    const id = uuidParam(c);
    const input = parseOfferInvalidate(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      { id, input },
      { operation: 'update' },
      async (tx, ctx) => ({ status: 200, body: await invalidateOffer(tx, ctx, id, input) }),
      { replayed: stillVisible },
    );
  });
}

export const registerOfferRoutes: TenantRouteModule = (router, deps) => {
  const module = policedSub(router, OFFER_POLICIES, () => new Hono<TenantEnv>());
  module.get('/views', async (c) => {
    await offerReadContext(c, deps);
    return c.json({ items: OFFER_VIEWS });
  });
  registerDictionaries(module, deps);
  module.get('/', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const { view, filters } = await listFilters(c, deps, ctx, c.req.query('view'));
    const page = pageQuery(c);
    const allowed = await actionFilter(deps, ctx);
    const result = await withTenant(deps.db, ctx.tenantId, (tx) =>
      listOffers(tx, ctx, { view, filters, limit: page.limit, offset: page.offset }, allowed),
    );
    const body = {
      ...result,
      page: page.page,
      pageSize: page.pageSize,
      hasDataPermission: ctx.scope.hasDataPermission,
    };
    return c.json(await trimOffer(deps, ctx, OFFER_OBJECT, body));
  });
  module.get('/:id', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const id = uuidParam(c);
    const allowed = await actionFilter(deps, ctx);
    const body = await withTenant(deps.db, ctx.tenantId, (tx) => offerDetail(tx, ctx, id, allowed));
    return c.json(await trimOffer(deps, ctx, OFFER_OBJECT, body));
  });
  module.get('/:id/transfer-form', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const id = uuidParam(c);
    const body = await withTenant(deps.db, ctx.tenantId, (tx) => offerTransferForm(tx, ctx, id));
    return c.json(await trimOffer(deps, ctx, OFFER_OBJECT, body));
  });
  module.get('/:id/send-check', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const id = uuidParam(c);
    return c.json(await withTenant(deps.db, ctx.tenantId, (tx) => offerSendCheck(tx, ctx, id)));
  });
  registerCommands(module, deps);
  router.route('/api/tenant/offers', module);
};
