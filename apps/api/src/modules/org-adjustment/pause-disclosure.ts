/**
 * 暂停类 409 的调整单编号披露（F-342 / F-355，DEC-406）：只有能打开该调整单、且“编码”字段可见的人才拿到 adjustmentCode，
 * 其余只给通用原因。判定沿用读接口的同一入口（`orgAdjustmentDisclosure`：对象查看权 + 主体组织范围，或审批参与人 +
 * 节点披露集），所以与详情页看到的编号口径一致；不能判定时（出错）按不可见处理。
 * 暂停是跨模块拦截（组织、任职、职务都会触发），写入口没有查看人的授权器，因此挂在租户路由器的错误处理上统一补。
 */
import { withTenant } from '@italent/db';
import type { ErrorHandler } from 'hono';
import { errorResponse, handleError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { type TenantContext, type TenantEnv, tenantOf } from '../../tenant-context.js';
import { canSee, orgAdjustmentDisclosure } from './disclosure.js';
import { OrgAdjustmentPausedError } from './pause.js';

async function visibleCode(deps: TenantRouteDeps, ctx: TenantContext, error: OrgAdjustmentPausedError) {
  if (!error.adjustmentCode) return undefined;
  try {
    const disclosure = await withTenant(deps.db, ctx.tenantId, (tx) =>
      orgAdjustmentDisclosure(tx, deps, ctx, error.adjustmentId),
    );
    return canSee(disclosure.fields, 'code') ? error.adjustmentCode : undefined;
  } catch {
    return undefined;
  }
}

export function pauseDisclosureHandler(deps: TenantRouteDeps): ErrorHandler<TenantEnv> {
  return async (error, c) => {
    if (!(error instanceof OrgAdjustmentPausedError)) return handleError(error, c);
    const adjustmentCode = await visibleCode(deps, tenantOf(c), error);
    return errorResponse(c, error.code, error.message, {
      ...(error.details as object),
      ...(adjustmentCode ? { adjustmentCode } : {}),
    });
  };
}
