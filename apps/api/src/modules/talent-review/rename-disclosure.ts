/**
 * 字段改名错误的披露权限（F-082 契约 §3.1，DEC-376①）：FIELD_NAME_BREAKS_FORMULA 的定位信息（规则、目标字段、原因）
 * 只给“有计算规则查看权（规则在其范围内）+ items 列查看权”的改名操作人，其余只计入匿名计数。
 * 这里只解析操作人对计算规则的当前权限，**只决定错误载荷里披露什么，不参与准入**（没有权限也不拒绝改名）。
 */
import type { Context } from 'hono';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantEnv } from '../../tenant-context.js';
import {
  getModuleViewableFields,
  getModuleViewableFieldsInTransaction,
  resolveModuleScopeInTransaction,
} from '../permission/module-access.js';
import type { Tx } from '@italent/db';
import { codeOf, reviewContext, reviewScope } from './access.js';
import type { CalcDisclosure } from './field-rename-guard.js';

/** 引用盘点字段需要查看人对字段目录这四列的查看权（名称、类型、启用状态、系统写入）。 */
const REFERENCE_COLUMNS = ['name', 'kind', 'enabled', 'systemWritten'];

/** 改名操作人对字段目录四列的查看权：错误载荷里的目标字段与审计裁剪、计算规则接口同一口径（R1-P2-3）。 */
export async function resolveFieldColumnsViewable(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx?: Tx,
): Promise<boolean> {
  const ctx = await reviewContext(c, deps, 'field');
  const viewable = tx
    ? await getModuleViewableFieldsInTransaction(deps, ctx, codeOf('field'), tx)
    : await getModuleViewableFields(deps, ctx, codeOf('field'));
  return viewable === undefined || REFERENCE_COLUMNS.every((column) => viewable.has(column));
}

export async function resolveCalcDisclosure(
  c: Context<TenantEnv>,
  deps: TenantRouteDeps,
  tx?: Tx,
): Promise<CalcDisclosure | undefined> {
  try {
    const ctx = await reviewContext(c, deps, 'calcRule');
    // 写命令里传入事务：披露权限与准入一样在命令事务内按当前授权解析（不用带请求缓存的范围）
    const scope = tx
      ? await resolveModuleScopeInTransaction(deps, ctx, tx, codeOf('calcRule'))
      : await reviewScope(c, deps, ctx, 'calcRule');
    const viewable = tx
      ? await getModuleViewableFieldsInTransaction(deps, ctx, codeOf('calcRule'), tx)
      : await getModuleViewableFields(deps, ctx, codeOf('calcRule'));
    return { scope, itemsViewable: viewable === undefined || viewable.has('items') };
  } catch (error) {
    // 没有计算规则的查看权：披露为空，不是改名的拒绝理由
    if (error instanceof AppError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')) return undefined;
    throw error;
  }
}
