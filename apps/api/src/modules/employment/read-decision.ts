/**
 * 任职业务的读取可见性决定（F-036-S5 第 3 轮，DEC-431①）：详情、来源接口，以及来源接口里“来源业务 ID 能不能给”，
 * 全部走这一个入口——选内容来源（现值 / 已办冻结份）→ 同单调动团队门禁与同单例外 → 数据范围 → 取业务 → 对象权限。
 * 入口只接收“入口授权上下文”（不带调动例外）：每个业务各自重新算一遍，不借别的业务算出的例外上下文。
 */
import { withTenant, type Tx } from '@italent/db';
import { requirePermission } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { TenantRouteDeps } from '../../routes.js';
import { transferBusinessContext } from '../transfer/service.js';
import { selectEmploymentRead, type EmploymentRead } from './approval-content.js';
import { loadEmploymentBusiness } from './read-model.js';
import type { EmploymentBusiness, EmploymentContext } from './types.js';

export interface ReadDecision<T> {
  readonly value: EmploymentBusiness;
  /** 过了调动门禁的上下文（可能带同单例外 transferTarget），只用于字段裁剪，不得传给别的业务的决定。 */
  readonly ctx: EmploymentContext;
  readonly read: EmploymentRead;
  /** `inSnapshot` 在值所在的同一个只读快照里取到的附带数据。 */
  readonly extra: T;
}

/**
 * 业务读取决定。不可读抛 NOT_FOUND（取不到）/ FORBIDDEN（对象权限）；调动团队门禁等其它错误码原样抛出。
 * `asOf` 惰性求值：在调动门禁之后才解析，错误顺序与历史详情路由一致。
 * 值与 `inSnapshot` 的附带读取在同一个 repeatable read 只读快照里；授权器可能自己开事务（PGlite 单连接会死锁），
 * 对象权限在快照事务之外判。
 */
export async function decideEmploymentRead<T = undefined>(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  id: string,
  asOf: () => string,
  read: EmploymentRead,
  inSnapshot?: (tx: Tx, ctx: EmploymentContext, value: EmploymentBusiness) => Promise<T>,
): Promise<ReadDecision<T>> {
  const snapshot = await withTenant(
    deps.db,
    entry.tenantId,
    async (tx) => {
      // 已办冻结份是本人办理时那份，不套当前数据范围（DEC-834④）；现值读取先过同单调动团队门禁。
      const ctx = read.frozen ? entry : await transferBusinessContext(tx, entry, id);
      const scope = read.frozen || ctx.transferTarget ? undefined : ctx.scope;
      const value = await loadEmploymentBusiness(tx, ctx.tenantId, id, asOf(), scope);
      if (!value) throw new AppError('NOT_FOUND', '任职业务不存在');
      return { value, ctx, extra: (inSnapshot ? await inSnapshot(tx, ctx, value) : undefined) as T };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  await requirePermission(deps.authorize, {
    ...snapshot.ctx,
    action: 'tenant.employment.read',
    resource: snapshot.value.employeeId,
  });
  return { ...snapshot, read };
}

const isDenied = (error: unknown) =>
  error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN');

/**
 * 来源业务对操作人是否可读：与“直接读这张来源单的详情”完全同一个决定——从入口上下文起，
 * 以来源业务自己为目标重新选内容来源、过它自己的同单调动门禁（含它自己的同单例外）和对象权限。
 */
export async function sourceReadable(
  deps: TenantRouteDeps,
  entry: EmploymentContext,
  sourceId: string,
  asOf: string,
): Promise<boolean> {
  try {
    await decideEmploymentRead(deps, entry, sourceId, () => asOf, await selectEmploymentRead(deps, entry, sourceId));
    return true;
  } catch (error) {
    if (isDenied(error)) return false;
    throw error;
  }
}
