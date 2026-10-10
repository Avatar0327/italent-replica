/**
 * 字段改名错误的披露权限（F-082 契约 §3.1，DEC-376①）：FIELD_NAME_BREAKS_FORMULA 的定位信息（规则、目标字段、原因）
 * 只给“有计算规则查看权（规则在其范围内）+ items 列查看权”的改名操作人，其余只计入匿名计数。
 * 这里只解析操作人对计算规则的当前权限，**只决定错误载荷里披露什么，不参与准入**（没有权限也不拒绝改名）。
 */
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import { getModuleViewableFields } from '../permission/module-access.js';
import { codeOf, reviewContext, reviewScope } from './access.js';
import type { CalcDisclosure } from './field-rename-guard.js';

export async function resolveCalcDisclosure(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
): Promise<CalcDisclosure | undefined> {
  try {
    const ctx = await reviewContext(c, deps, 'calcRule');
    const scope = await reviewScope(c, deps, ctx, 'calcRule');
    const viewable = await getModuleViewableFields(deps, ctx, codeOf('calcRule'));
    return { scope, itemsViewable: viewable === undefined || viewable.has('items') };
  } catch (error) {
    // 没有计算规则的查看权：披露为空，不是改名的拒绝理由
    if (error instanceof AppError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) return undefined;
    throw error;
  }
}
