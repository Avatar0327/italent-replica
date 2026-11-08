/**
 * 职级「所属资源集合」（R1a §2.8、§3.6；DEC-778④ 沿用 DEC-339①）：新建时按创建人在职务体系应用里的授权管理单元定，
 * 一个自动填，多个由请求选一个（不选 400），选了不属于自己的单元一律同一个 404；之后只读，随版本链沿用。
 * 与人才标准不同：创建人没有任何授权管理单元时留空而不拒绝——职务体系的管理员常按“全部范围”授权，不挂管理单元，
 * 拒绝会让他们无法新建职级（是否改为拒绝待 03 定）。
 */
import { ORG_EMPLOYEE_APP, tenantLocalDate } from '@italent/domain';
import type { Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { authorizedUnits, UNIT_NOT_FOUND } from '../permission/owner-units.js';
import type { JobWriteContext } from './types.js';

export async function resolveResourceSet(
  tx: Tx,
  ctx: JobWriteContext,
  requested: string | null | undefined,
): Promise<string | null> {
  const asOf = tenantLocalDate(ctx.now, ctx.timezone);
  const units = await authorizedUnits(tx, ctx.tenantId, ctx.userId, ORG_EMPLOYEE_APP, asOf);
  if (requested) {
    // 范围外与不存在同一个拒绝分支，不泄露组织是否存在（含没有任何授权单元的情况）
    if (!units.some((unit) => unit.id === requested)) throw new AppError('NOT_FOUND', UNIT_NOT_FOUND);
    return requested;
  }
  if (units.length <= 1) return units[0]?.id ?? null;
  throw new AppError('VALIDATION_FAILED', '请选择所属管理单元', { reason: 'MANAGEMENT_UNIT_REQUIRED' });
}
