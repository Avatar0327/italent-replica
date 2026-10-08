/**
 * 新建对象的所属管理单元（DEC-294③ 及补充，`23` §8 ①）：所属人 = 创建人，所属管理单元 = 创建人在人才标准应用里的
 * 授权管理单元，由系统填写，建后不能修改或转移。复刻以组织表达管理单元（DEC-281⑨），用户 × TalentCenter 只有一份
 * 范围（DEC-043），因此“授权管理单元”取该范围所选管理单元里的组织范围（当天有效且启用）：
 * - 没有：拒绝新建（403，提示原文）；
 * - 一个：自动填写；
 * - 多个：须由请求选一个（新建表单此时才显示下拉），不选 400；
 * 请求选了不属于创建人的单元时，不论该组织是否存在都返回同一个 404（第 5 轮清单 2）。最后仍按新建授权复核
 * （DEC-082：只看管理范围，不因“使用用户”规则放行）。
 */
import { sql, type Tx } from '@italent/db';
import { TALENT_APP, tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';
import { requireCreatable, type TalentObject } from './access.js';
import type { WriteContext } from './write-support.js';

export interface OwnerUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export const NO_UNIT_MESSAGE = '无可用的管理单元，请联系管理员授权';
const UNIT_NOT_FOUND = '所属管理单元不存在';
/** 一个管理单元最多选 200 个组织范围（data-scope-admin），这里同样有界。 */
const MAX_UNITS = 200;

/** 用户在人才标准应用里的授权管理单元（按组织编码排序）。 */
export async function authorizedUnits(tx: Tx, tenantId: string, userId: string, asOf: string): Promise<OwnerUnit[]> {
  const result = await tx.execute(sql`SELECT v.org_id AS id, v.code, v.name FROM (
      SELECT DISTINCT ON (org_id) org_id, code, name, enabled FROM org_versions
      WHERE tenant_id = ${tenantId} AND start_date <= ${asOf}::date
      ORDER BY org_id, start_date DESC, version_no DESC) v
    WHERE v.enabled AND v.org_id IN (
      SELECT r.org_id FROM permission_user_app_scopes s
      JOIN permission_mous m ON m.tenant_id = s.tenant_id AND m.id = s.mou_id AND m.status = 'active'
      JOIN permission_mou_org_refs r ON r.tenant_id = m.tenant_id AND r.mou_id = m.id
      WHERE s.tenant_id = ${tenantId} AND s.user_id = ${userId} AND s.app_code = ${TALENT_APP} AND s.kind <> 'default')
    ORDER BY v.code, v.org_id LIMIT ${MAX_UNITS}`);
  return (Array.isArray(result) ? result : (result as { rows: OwnerUnit[] }).rows) as OwnerUnit[];
}

const unitsOf = (tx: Tx, ctx: WriteContext) =>
  authorizedUnits(tx, ctx.tenantId, ctx.userId, tenantLocalDate(ctx.now, ctx.timezone));

function noUnit(): AppError {
  return new AppError('FORBIDDEN', NO_UNIT_MESSAGE, { reason: 'NO_MANAGEMENT_UNIT' });
}

/** 新建指标库 / 指标 / 标准分类 / 人才标准时填写的所属管理单元。 */
export async function ownerUnit(
  tx: Tx,
  ctx: WriteContext,
  object: TalentObject,
  requested: string | undefined,
): Promise<string> {
  const units = await unitsOf(tx, ctx);
  if (!units.length) throw noUnit();
  let orgId: string;
  if (requested !== undefined) {
    // 先判是否属于创建人的授权管理单元，不另查组织是否存在：范围外与不存在同一个拒绝分支
    if (!units.some((unit) => unit.id === requested)) throw new AppError('NOT_FOUND', UNIT_NOT_FOUND);
    orgId = requested;
  } else if (units.length === 1) {
    orgId = units[0]!.id;
  } else {
    throw new AppError('VALIDATION_FAILED', '请选择所属管理单元', { reason: 'MANAGEMENT_UNIT_REQUIRED' });
  }
  requireCreatable(ctx.scope, object, orgId, UNIT_NOT_FOUND);
  return orgId;
}

/**
 * 标准内新加的指标关联记录（DEC-294③）：所属人 = 加入它的人；所属管理单元取其授权管理单元——只有一个就用它，
 * 多个时取所在标准的所属管理单元（属于其中之一时），否则取排序第一个。
 * TODO(需取证 #109): 原站多个授权管理单元时关联记录取哪一个未取证，暂按上述规则。
 */
export async function referenceUnit(tx: Tx, ctx: WriteContext, criterionOrgId: string): Promise<string> {
  const units = await unitsOf(tx, ctx);
  if (!units.length) throw noUnit();
  return (units.find((unit) => unit.id === criterionOrgId) ?? units[0]!).id;
}
