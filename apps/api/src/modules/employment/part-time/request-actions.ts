/**
 * 兼职申请逐单可用动作（F-268，DEC-654 批 3；设计 §2.2 状态机 ∩ §7.2 按钮权）：写入口（request-routes.ts）与读口
 * （GET part-time-requests/:id 的 availableActions）共用这一张表和这一个判定入口（DEC-431①），保证“读口给出的动作 = 写口
 * 会接受的动作”：状态机（nextPartTimeRequestState，与 request-service 同一函数）→ 提交 / 撤回只给原发起人 → 写入口同一个
 * requirePartTimeRequestAccess（对象操作权 + 申请类型按钮 + 员工主职与申请部门的写入口径范围）。
 * 动作码：edit = PATCH、submit / withdraw / revoke = POST :id/{动作}、delete = DELETE。
 * 只判权限与状态；修改 / 提交时的 D-1～D-10 等业务校验、revision 比对仍由写入口锁内判。
 */
import { withTenant } from '@italent/db';
import { nextPartTimeRequestState, PART_TIME_BUTTONS, type PartTimeRequestAction } from '@italent/domain';
import type { Context } from 'hono';
import type { TenantRouteDeps } from '../../../routes.js';
import type { TenantEnv } from '../../../tenant-context.js';
import { permits, tryWriteContext } from '../context.js';
import { requirePartTimeRequestAccess, type PartTimeRequestTarget } from './replay-guard.js';
import { isRequestInitiator } from './request-service.js';
import { loadPartTimeRequest } from './request-store.js';

/** 下发顺序固定：改 → 提交 → 删除 → 撤回 → 撤销。 */
export const REQUEST_ACTIONS = ['edit', 'submit', 'delete', 'withdraw', 'revoke'] as const;
export type RequestActionCode = (typeof REQUEST_ACTIONS)[number];

/**
 * 动作 → 写入口的对象操作与按钮：与创建同一按钮 + Employment.Submit / Withdraw / Delete 的组合，HR 撤销只要 Employment.Revoke
 * （§7.2）；申请类型对应的按钮在路由里统一写 PART_TIME_BUTTONS.application，入口读到申请后按申请类型换成该类按钮。
 */
export const REQUEST_ACTION_ACCESS: Readonly<
  Record<RequestActionCode, { readonly operation: 'update' | 'delete'; readonly buttons: readonly string[] }>
> = {
  edit: { operation: 'update', buttons: [PART_TIME_BUTTONS.application] },
  submit: { operation: 'update', buttons: [PART_TIME_BUTTONS.application, 'Employment.Submit'] },
  withdraw: { operation: 'update', buttons: [PART_TIME_BUTTONS.application, 'Employment.Withdraw'] },
  revoke: { operation: 'update', buttons: ['Employment.Revoke'] },
  delete: { operation: 'delete', buttons: [PART_TIME_BUTTONS.application, 'Employment.Delete'] },
};

/** 动作在状态机里的迁移：修改草稿 / 驳回中的申请与重新提交同属“可提交”的状态（request-service updateRequest）。 */
const MACHINE_ACTION: Readonly<Record<RequestActionCode, PartTimeRequestAction>> = {
  edit: 'submit',
  submit: 'submit',
  delete: 'delete',
  withdraw: 'withdraw',
  revoke: 'revoke',
};

/** 写入口锁内判“只允许原发起人”的动作（DEC-113）。 */
const INITIATOR_ONLY: ReadonlySet<RequestActionCode> = new Set(['submit', 'withdraw']);

export function requestActionTarget(requestId: string, action: RequestActionCode): PartTimeRequestTarget {
  const { operation, buttons } = REQUEST_ACTION_ACCESS[action];
  return { requestId, operation, business: {}, buttons };
}

/** 当前操作人对这张申请可用的动作（按固定顺序）；没有对应对象操作权、范围外、状态不符、非原发起人一律不下发。 */
export async function availableRequestActions(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tenantId: string,
  requestId: string,
): Promise<RequestActionCode[]> {
  const contexts = {
    update: await tryWriteContext(c, deps, 'object.update'),
    delete: await tryWriteContext(c, deps, 'object.delete'),
  };
  return withTenant(deps.db, tenantId, async (tx) => {
    const request = await loadPartTimeRequest(tx, tenantId, requestId);
    if (!request) return [];
    const offered: RequestActionCode[] = [];
    for (const action of REQUEST_ACTIONS) {
      const scoped = contexts[REQUEST_ACTION_ACCESS[action].operation];
      if (!scoped || !nextPartTimeRequestState(request.state, MACHINE_ACTION[action])) continue;
      if (INITIATOR_ONLY.has(action) && !isRequestInitiator(request, scoped)) continue;
      if (await permits(() => requirePartTimeRequestAccess(tx, scoped, requestActionTarget(requestId, action))))
        offered.push(action);
    }
    return offered;
  });
}
