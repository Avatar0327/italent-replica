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
  OFFER_REVIEW_FIELDS_KEY,
  OFFER_SEND_APPROVAL_KEY,
  OFFER_SYNC_TIMING_KEY,
  validOfferReviewFieldsSetting,
  validOfferSendApprovalSetting,
  validOfferSyncSetting,
  type OfferRowAction,
} from '@italent/domain';
import type { Context, Hono } from 'hono';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { jsonBody } from '../employment/context.js';
import { registerEntryOfferHooks } from '../employment/entry-offer-hooks.js';
import { uuidParam } from '../job/context.js';
import { registerSettingValidator } from '../tenant-settings/service.js';
import { offerOperationCheck, offerReadContext, offerTransferCheck, runOfferWrite, trimOffer } from './context.js';
import type { OfferContext } from './context.js';
import { parseOfferInvalidate, parseOfferLink, parseOfferSync, parseOfferTransfer } from './input.js';
import { linkEmployee, offerEntryHooks, syncOfferNow, syncOfferWhenDue } from './sync.js';
import {
  invalidateOffer,
  offerDto,
  offerStillVisible,
  offerSendCheck,
  offerTransferForm,
  transferOffer,
  type OfferActionFilter,
} from './service.js';

registerSettingValidator(OFFER_SEND_APPROVAL_KEY, validOfferSendApprovalSetting);
registerSettingValidator(OFFER_SYNC_TIMING_KEY, validOfferSyncSetting);
// F-201①：待入职取消 / 改期恢复的联动端口由 Offer 在模块加载时登记实现（employment 不 import Offer；测试可再登记桩覆盖）
registerEntryOfferHooks(offerEntryHooks);
registerSettingValidator(OFFER_REVIEW_FIELDS_KEY, validOfferReviewFieldsSetting);

/**
 * 行操作的权限裁剪：转移状态按行级按钮，编辑 / 失效按编辑开关，删除按删除开关，复制按新增开关；查看已由读权限保证。
 * 顶部工具栏的转移状态按列表级按钮另给（toolbarActions）。
 */
export async function offerActionAccess(deps: TenantRouteDeps, ctx: OfferContext) {
  // 只判开关：显式带空字段集合（真实授权器对新增 / 编辑不带字段一律拒绝，#398 P2-1）；实际写入字段由命令自身校验
  const can = (action: string, resource: string) => deps.authorize({ ...ctx, action, resource, fields: [] });
  const { lineStatusTransfer: row, statusTransfer: list } = OFFER_BUTTONS;
  const [transfer, toolbar, update, remove, create] = await Promise.all([
    can('object.button', buttonResource(OFFER_OBJECT, row.code, row.level)),
    can('object.button', buttonResource(OFFER_OBJECT, list.code, list.level)),
    can('object.update', OFFER_OBJECT),
    can('object.delete', OFFER_OBJECT),
    can('object.create', OFFER_OBJECT),
  ]);
  const gated: Partial<Record<OfferRowAction, boolean>> = {
    // BE-14a3：发起审批与发起入口同口径（Offer 编辑开关；行本身已按范围裁剪）
    submitApproval: update,
    transfer,
    edit: update,
    send: update,
    resend: update,
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
    async (tx, ctx) => {
      const moved = await transferOffer(tx, ctx, id, input);
      if (input.target !== 'accepted') return { status: 200, body: moved };
      // 接受后按同步时机当场同步（AC-OF-10）；同步失败记在 Offer 上，不回滚接受（AC-OF-06）
      const synced = await syncOfferWhenDue(tx, ctx, id);
      return { status: 200, body: synced.attempted ? offerDto(synced.row!) : moved };
    },
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
  // OF-R8 立即同步 / 关联在职实习生：按对象编辑开关（与失效同口径），Offer 自己的数据范围裁剪
  module.post('/:id/sync', async (c) => {
    const id = uuidParam(c);
    const input = parseOfferSync(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      { id, input },
      'update',
      offerOperationCheck('update'),
      async (tx, ctx) => ({ status: 200, body: await syncOfferNow(tx, ctx, id) }),
      { replayed: offerStillVisible },
    );
  });
  module.post('/:id/link-employee', async (c) => {
    const id = uuidParam(c);
    const input = parseOfferLink(await jsonBody(c));
    return runOfferWrite(
      c,
      deps,
      { id, input },
      'update',
      offerOperationCheck('update'),
      async (tx, ctx) => ({ status: 200, body: await linkEmployee(tx, ctx, id, input.employeeId) }),
      { replayed: offerStillVisible },
    );
  });
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
