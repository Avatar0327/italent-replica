/**
 * Offer 状态转移、失效、转移表单与 OF-R3 发送判定的路由（R2 BE-14a2，DEC-581 C2；34 §2.1、OF-R3 / R7）。
 * 转移有两个入口：行主按钮（OfferLineOpStatusTransfer@list_row）与顶部工具栏（Offer.StatusTransfer@list），各查各的按钮，
 * 规则相同（DEC-533④ / 537③）。失效按对象编辑开关。需要联动待入职的分支给机读拒绝 OFFER_SYNC_NOT_READY（BE-14b 接线）。
 */
import { withTenant } from '@italent/db';
import {
  buttonResource,
  OFFER_BUTTONS,
  OFFER_OBJECT,
  OFFER_SEND_APPROVAL_KEY,
  validOfferSendApprovalSetting,
  type OfferRowAction,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody } from '../employment/context.js';
import { uuidParam } from '../job/context.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import { offerOperationCheck, offerReadContext, offerTransferCheck, runOfferWrite, trimOffer } from './context.js';
import type { OfferContext } from './context.js';
import { parseOfferInvalidate, parseOfferTransfer } from './input.js';
import {
  invalidateOffer,
  offerStillVisible,
  offerSendCheck,
  offerTransferForm,
  transferOffer,
  type OfferActionFilter,
} from './service.js';

registerSettingValidator(OFFER_SEND_APPROVAL_KEY, validOfferSendApprovalSetting);

/**
 * 行操作的权限裁剪：转移状态按行级按钮，编辑 / 失效按编辑开关，删除按删除开关，复制按新增开关；查看已由读权限保证。
 * 顶部工具栏的转移状态按列表级按钮另给（toolbarActions）。
 */
export async function offerActionAccess(deps: TenantRouteDeps, ctx: OfferContext) {
  const can = (action: string, resource: string) => deps.authorize({ ...ctx, action, resource });
  const { lineStatusTransfer: row, statusTransfer: list } = OFFER_BUTTONS;
  const [transfer, toolbar, update, remove, create] = await Promise.all([
    can('object.button', buttonResource(OFFER_OBJECT, row.code, row.level)),
    can('object.button', buttonResource(OFFER_OBJECT, list.code, list.level)),
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
  const allowed: OfferActionFilter = (action) => gated[action] ?? true;
  return { allowed, toolbarActions: toolbar ? ['transfer'] : [] };
}

type TransferButton = (typeof OFFER_BUTTONS)[keyof typeof OFFER_BUTTONS];

/** 两个转移入口共用的处理：只有入口按钮不同，状态守卫与表单校验同一套。 */
async function transferCommand(c: Context<TenantEnv>, deps: TenantRouteDeps, ref: TransferButton) {
  const id = uuidParam(c);
  const input = parseOfferTransfer(await jsonBody(c));
  return runOfferWrite(
    c,
    deps,
    { id, input },
    'update',
    offerTransferCheck(ref),
    async (tx, ctx) => ({ status: 200, body: await transferOffer(tx, ctx, id, input) }),
    { replayed: offerStillVisible },
  );
}

export function registerOfferTransitions(module: Hono<TenantEnv>, deps: TenantRouteDeps) {
  module.get('/:id/transfer-form', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const id = uuidParam(c);
    const body = await withTenant(deps.db, ctx.tenantId, (tx) => offerTransferForm(tx, ctx, id));
    return c.json(await trimOffer(deps, ctx, body));
  });
  module.get('/:id/send-check', async (c) => {
    const ctx = await offerReadContext(c, deps);
    const id = uuidParam(c);
    const body = await withTenant(deps.db, ctx.tenantId, (tx) => offerSendCheck(tx, ctx, id));
    return c.json(await trimOffer(deps, ctx, body));
  });
  module.post('/:id/transfer', (c) => transferCommand(c, deps, OFFER_BUTTONS.lineStatusTransfer));
  module.post('/:id/toolbar-transfer', (c) => transferCommand(c, deps, OFFER_BUTTONS.statusTransfer));
  module.post('/:id/invalidate', async (c) => {
    const id = uuidParam(c);
    const input = parseOfferInvalidate(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      { id, input },
      'update',
      offerOperationCheck('update'),
      async (tx, ctx) => ({ status: 200, body: await invalidateOffer(tx, ctx, id, input) }),
      { replayed: offerStillVisible },
    );
  });
}
