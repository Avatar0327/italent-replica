/**
 * 新建对象的所属管理单元（DEC-294③ 及补充，`23` §8 ①；R3-T02 设计 §1.3 由人才标准抽为公共）：所属人 = 创建人，
 * 所属管理单元 = 创建人在**对象所属应用**里的授权管理单元，由系统填写。复刻以组织表达管理单元（DEC-281⑨），
 * 用户 × 应用只有一份范围（DEC-043），因此“授权管理单元”取该应用范围所选管理单元里的组织范围（当天有效且启用；
 * 一份范围内的多个组织按多个授权管理单元算，DEC-294 补充三 / DEC-309 推定 🟡）：
 * - 没有：拒绝新建（403，提示原文）；
 * - 一个：自动填写；
 * - 多个：须由请求选一个，不选 400；
 * 请求选了不属于创建人的单元时，不论该组织是否存在都返回同一个 404。之后的新建授权复核（DEC-082）由各应用自己做。
 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { tenantLocalDate } from '@italent/domain';
import { AppError } from '../../errors.js';

export interface OwnerUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  /** 查看人能否看到这个组织本身（`nameable` 谓词的结果，缺省 false）。 */
  readonly named: boolean;
}

/** 取授权管理单元所需的请求上下文（各模块的写上下文都满足）。 */
export interface UnitContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly now: Date;
  readonly timezone: string;
}

export const NO_UNIT_MESSAGE = '无可用的管理单元，请联系管理员授权';
export const UNIT_NOT_FOUND = '所属管理单元不存在';
/** 一个管理单元最多选 200 个组织范围（data-scope-admin），这里同样有界。 */
const MAX_UNITS = 200;

/**
 * 用户在某个应用里的授权管理单元（按组织编码排序）。`nameable` 是作用在 `v.org_id` 上的谓词，结果放在 `named`：
 * 候选接口用它按查看人组织员工应用的当前数据范围判定能否带出组织名称 / 编码（DEC-316②），不影响候选本身。
 */
export async function authorizedUnits(
  tx: Tx,
  tenantId: string,
  userId: string,
  appCode: string,
  asOf: string,
  nameable: SQL = sql`false`,
): Promise<OwnerUnit[]> {
  const result = await tx.execute(sql`SELECT v.org_id AS id, v.code, v.name, (${nameable}) AS named FROM (
      SELECT DISTINCT ON (org_id) org_id, code, name, enabled FROM org_versions
      WHERE tenant_id = ${tenantId} AND start_date <= ${asOf}::date
      ORDER BY org_id, start_date DESC, version_no DESC) v
    WHERE v.enabled AND v.org_id IN (
      SELECT r.org_id FROM permission_user_app_scopes s
      JOIN permission_mous m ON m.tenant_id = s.tenant_id AND m.id = s.mou_id AND m.status = 'active'
      JOIN permission_mou_org_refs r ON r.tenant_id = m.tenant_id AND r.mou_id = m.id
      WHERE s.tenant_id = ${tenantId} AND s.user_id = ${userId} AND s.app_code = ${appCode} AND s.kind <> 'default')
    ORDER BY v.code, v.org_id LIMIT ${MAX_UNITS}`);
  return (Array.isArray(result) ? result : (result as { rows: OwnerUnit[] }).rows) as OwnerUnit[];
}

function noUnit(): AppError {
  return new AppError('FORBIDDEN', NO_UNIT_MESSAGE, { reason: 'NO_MANAGEMENT_UNIT' });
}

/**
 * 在创建人 / 添加人自己在该应用的授权管理单元里定一个（一律不继承主对象，DEC-294 补充二，原站样本 🟡）：
 * 没有拒绝；请求选了就须属于其中（不属于时存在与否同一个 404）；只有一个自动填写；多个而没选 400。
 */
export async function chooseUnit(
  tx: Tx,
  ctx: UnitContext,
  appCode: string,
  requested: string | undefined,
): Promise<string> {
  const units = await authorizedUnits(tx, ctx.tenantId, ctx.userId, appCode, tenantLocalDate(ctx.now, ctx.timezone));
  if (!units.length) throw noUnit();
  if (requested !== undefined) {
    // 先判是否属于本人的授权管理单元，不另查组织是否存在：范围外与不存在同一个拒绝分支
    if (!units.some((unit) => unit.id === requested)) throw new AppError('NOT_FOUND', UNIT_NOT_FOUND);
    return requested;
  }
  if (units.length === 1) return units[0]!.id;
  throw new AppError('VALIDATION_FAILED', '请选择所属管理单元', { reason: 'MANAGEMENT_UNIT_REQUIRED' });
}
