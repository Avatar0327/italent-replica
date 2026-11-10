/**
 * 职级「所属资源集合」（R1a §2.8、§3.6；DEC-778④ 沿用 DEC-339①）：新建时按创建人在职务体系应用里的授权管理单元定，
 * 一个自动填，多个由请求选一个（不选 400），选了不属于自己的单元一律同一个 404；之后只读，随版本链沿用。
 * 创建人没有任何授权管理单元时拒绝新建（403 NO_MANAGEMENT_UNIT，与人才标准 / 任职资格同口径，DEC-339①“新建必填”），
 * 不产生无归属的对象。UUID 先转小写再比较与保存：schema 接受大写，库里是小写，大小写不是两个单元。
 */
import { ORG_EMPLOYEE_APP, tenantLocalDate } from '@italent/domain';
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { authorizedUnits, NO_UNIT_MESSAGE, UNIT_NOT_FOUND } from '../permission/owner-units.js';
import type { JobWriteContext } from './types.js';

export async function resolveResourceSet(
  tx: Tx,
  ctx: JobWriteContext,
  requested: string | null | undefined,
): Promise<string> {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const units = await authorizedUnits(tx, ctx.tenantId, ctx.userId, ORG_EMPLOYEE_APP, asOf);
  if (requested) {
    // 范围外与不存在同一个拒绝分支，不泄露组织是否存在（含没有任何授权单元的情况）
    const chosen = units.find((unit) => unit.id === requested.toLowerCase());
    if (!chosen) throw new AppError('NOT_FOUND', UNIT_NOT_FOUND);
    return chosen.id;
  }
  if (!units.length) throw new AppError('FORBIDDEN', NO_UNIT_MESSAGE, { reason: 'NO_MANAGEMENT_UNIT' });
  if (units.length === 1) return units[0]!.id;
  throw new AppError('VALIDATION_FAILED', '请选择所属管理单元', { reason: 'MANAGEMENT_UNIT_REQUIRED' });
}
