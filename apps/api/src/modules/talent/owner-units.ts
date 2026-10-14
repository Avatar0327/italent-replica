/**
 * 人才标准新建对象的所属管理单元（DEC-294③ 及补充，`23` §8 ①）：取创建人在人才标准应用里的授权管理单元，
 * 规则见公共实现 permission/owner-units.ts（R3-T02 设计 §1.3 抽出，行为不变）；这里只叠加人才标准的新建授权复核
 * （DEC-082：只看管理范围，不因“使用用户”规则放行）。
 */
import type { Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { TALENT_APP } from '@italent/domain';
import {
  authorizedUnits as authorizedAppUnits,
  chooseUnit,
  type OwnerUnit,
  UNIT_NOT_FOUND,
} from '../permission/owner-units.js';
import { requireCreatable, type TalentObject } from './access.js';
import type { WriteContext } from './write-support.js';

export { NO_UNIT_MESSAGE, type OwnerUnit } from '../permission/owner-units.js';

/** 用户在人才标准应用里的授权管理单元（`nameable` 只决定 `named`，DEC-316②）。 */
export const authorizedUnits = (
  tx: Tx,
  tenantId: string,
  userId: string,
  asOf: string,
  nameable?: SQL,
): Promise<OwnerUnit[]> => authorizedAppUnits(tx, tenantId, userId, TALENT_APP, asOf, nameable);

/** 新建指标库 / 库内分类 / 指标 / 标准分类 / 人才标准：选定后再按新建授权复核（DEC-082）。 */
export async function ownerUnit(
  tx: Tx,
  ctx: WriteContext,
  object: TalentObject,
  requested: string | undefined,
): Promise<string> {
  const orgId = await chooseUnit(tx, ctx, TALENT_APP, requested);
  requireCreatable(ctx.scope, object, orgId, UNIT_NOT_FOUND);
  return orgId;
}

/**
 * 编辑人才标准时新加的指标关联记录：所属管理单元按添加人的授权管理单元定（DEC-294 补充二）。关联记录随标准的
 * dimensions 字段整组编辑，授权就是标准的编辑授权（行锁后已按标准的范围判定），不另按新建授权复核。
 */
export const relationUnit = (tx: Tx, ctx: WriteContext, requested: string | undefined) =>
  chooseUnit(tx, ctx, TALENT_APP, requested);
