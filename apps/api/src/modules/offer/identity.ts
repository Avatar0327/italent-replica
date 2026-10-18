/**
 * Offer 新建 / 编辑时的 OF-R2 校验（34 OF-R2，AC-OF-05，DEC-600）：
 * - 姓名 + 手机 / 邮箱 / 证件号命中有效黑名单 → 409 OFFER_BLACKLISTED（阻断）；
 * - 证件号、手机号、邮箱任一命中已离职 / 退休人员 → 只提示重聘（rehireHint），不阻断。
 *
 * 重聘提示是离职人员的任职信息（结束类型、最后工作日），不能借 Offer 新建权探测：提示在响应阶段（首次执行与同键重放
 * 同一出口）按操作人**当前**的任职记录查看权、数据范围、字段查看权裁剪后才附上，不进命令台账；没有权限、人员在范围外、
 * 字段不可见都当作没有命中（审查 #406 P2-01）。多人命中只数操作人看得见的人。
 */
import { withTenant, type Tx } from '@italent/db';
import { blacklistBlockedMessage, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { requirePermission } from '../../authorization.js';
import type { TenantRouteDeps } from '../../routes.js';
import type { TenantContext } from '../../tenant-context.js';
import { findEffectiveBlacklistByIdentity } from '../employment/blacklist.js';
import { EMPLOYMENT_OBJECT } from '../employment/context.js';
import { findRehireCandidates } from '../employment/rehire-match.js';
import { getModuleViewableFields, resolveModuleScope } from '../permission/module-access.js';
import type { OfferContext } from './context.js';

export interface OfferIdentity {
  readonly name?: string | null;
  readonly mobile?: string | null;
  readonly personalEmail?: string | null;
  readonly idType?: string | null;
  readonly idNumber?: string | null;
}

export type RehireHint =
  { readonly endKind?: 'leave' | 'retirement'; readonly lastWorkDate?: string | null } | { readonly ambiguous: true };

export async function requireNotBlacklisted(tx: Tx, ctx: OfferContext, person: OfferIdentity) {
  const hit = await findEffectiveBlacklistByIdentity(
    tx,
    ctx.tenantId,
    { name: person.name, idNumber: person.idNumber, mobilePhone: person.mobile, email: person.personalEmail },
    tenantLocalDate(ctx.now, ctx.timezone),
  );
  if (hit)
    throw new AppError('CONFLICT', blacklistBlockedMessage(hit.name, hit.reason), { reason: 'OFFER_BLACKLISTED' });
}

/** 任职记录里这两项分别对应结束类型（业务类型 kind）与最后工作日。 */
const ENDED_FIELDS = { endKind: 'kind', lastWorkDate: 'lastWorkDate' } as const;

async function visibleRehireHint(
  deps: TenantRouteDeps,
  ctx: TenantContext,
  person: OfferIdentity,
): Promise<RehireHint | null> {
  try {
    await requirePermission(deps.authorize, { ...ctx, action: 'object.view', resource: EMPLOYMENT_OBJECT, fields: [] });
  } catch (error) {
    if (error instanceof AppError && error.code === 'FORBIDDEN') return null;
    throw error;
  }
  const [scope, viewable] = await Promise.all([
    resolveModuleScope(deps, ctx, undefined, EMPLOYMENT_OBJECT),
    getModuleViewableFields(deps, ctx, EMPLOYMENT_OBJECT),
  ]);
  const shown = (field: string) => viewable === undefined || viewable.has(field);
  // 两个提示字段都不可见：什么都不提示（含多人命中），与不命中不可区分；先判，免得歧义分支泄露匹配结果
  if (!shown(ENDED_FIELDS.endKind) && !shown(ENDED_FIELDS.lastWorkDate)) return null;
  const today = tenantLocalDate(deps.clock(), ctx.timezone);
  // 范围（含“使用用户”按创建人）在候选 SQL 里先过滤再限量：范围外的人不占名额，也不影响单人 / 多人的判断
  const people = await withTenant(deps.db, ctx.tenantId, (tx) =>
    findRehireCandidates(
      tx,
      ctx.tenantId,
      { idType: person.idType, idNumber: person.idNumber, mobilePhone: person.mobile, email: person.personalEmail },
      today,
      scope,
    ),
  );
  const [only, ...others] = people;
  if (!only) return null;
  if (others.length) return { ambiguous: true };
  const hint: { endKind?: 'leave' | 'retirement'; lastWorkDate?: string | null } = {};
  if (shown(ENDED_FIELDS.endKind)) hint.endKind = only.endKind;
  if (shown(ENDED_FIELDS.lastWorkDate)) hint.lastWorkDate = only.lastWorkDate;
  return Object.keys(hint).length ? hint : null;
}

/**
 * 新建响应的出口：Offer 返回体里的证件 / 手机 / 邮箱 + 操作人当前权限 → 附上 rehireHint（没有则原样返回）。
 * 命令台账里只存 Offer 本身，同键重放也走这里重新授权。
 */
export async function withRehireHint(deps: TenantRouteDeps, ctx: TenantContext, body: unknown) {
  const offer = body as OfferIdentity | null;
  if (!offer || typeof offer !== 'object') return body;
  const hint = await visibleRehireHint(deps, ctx, offer);
  return hint ? { ...offer, rehireHint: hint } : body;
}
