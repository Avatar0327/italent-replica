/**
 * Offer 新建 / 编辑时的 OF-R2 校验（34 OF-R2，AC-OF-05，DEC-600）：
 * - 姓名 + 手机 / 邮箱 / 证件号命中有效黑名单 → 409 OFFER_BLACKLISTED（阻断）；
 * - 证件号命中已离职 / 退休人员 → 只提示重聘（rehireHint），不阻断；提示只给结束类型与最后工作日，不带人员信息，
 *   重聘合并的人员匹配交 BE-14b2 同步待入职时重新判定。原站手机 / 邮箱匹配未验证，沿用 BE-6a 的证件号口径。
 */
import type { Tx } from '@italent/db';
import { blacklistBlockedMessage, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { findEffectiveBlacklistByIdentity } from '../employment/blacklist.js';
import { matchRehire } from '../employment/rehire-match.js';
import type { OfferContext } from './context.js';

export interface OfferIdentity {
  readonly name?: string | null;
  readonly mobile?: string | null;
  readonly personalEmail?: string | null;
  readonly idType?: string | null;
  readonly idNumber?: string | null;
}

export type RehireHint =
  | { readonly endKind: 'leave' | 'retirement'; readonly lastWorkDate: string | null }
  | {
      readonly ambiguous: true;
    };

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

export async function rehireHintFor(tx: Tx, ctx: OfferContext, person: OfferIdentity): Promise<RehireHint | null> {
  const idType = person.idType?.trim();
  const idNumber = person.idNumber?.trim();
  if (!idType || !idNumber) return null;
  try {
    const hit = await matchRehire(tx, ctx.tenantId, { idType, idNumber }, tenantLocalDate(ctx.now, ctx.timezone));
    return hit ? { endKind: hit.endKind, lastWorkDate: hit.lastWorkDate } : null;
  } catch (error) {
    if (
      error instanceof AppError &&
      error.details &&
      (error.details as { reason?: string }).reason === 'REHIRE_MATCH_AMBIGUOUS'
    )
      return { ambiguous: true };
    throw error;
  }
}
