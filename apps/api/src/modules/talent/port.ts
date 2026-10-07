/**
 * 人才标准对外只读端口（R3-T01 预留）：供 R3-T02 任职资格（指标来源）、R3-T04 人才盘点（TR-R14 指标评估的指标来源：
 * 按人才标准、可选 能力 / 潜力 / 经历 维度）、职务「胜任力模型」引用校验（Q-M0-17）、人才池出入池标准与 IDP 胜任力目标读取。
 *
 * 可信端口：在调用方的租户事务内执行（RLS 保证只读到当前租户），**不做权限判断与字段裁剪**——
 * 调用方按自己的业务权限决定能否读取、展示哪些字段（例如盘点评估人不需要人才标准管理权限）。
 * 返回的指标内容总是指标库的当前内容（TC-R2）；需要留存当时内容的业务（如评定提名，DEC-055）由调用方自行快照。
 */
import { and, eq, sql, type Tx, talentCriteria } from '@italent/db';
import type { TalentDimensionType } from '@italent/domain';
import { listDimensions, loadCriterion, loadDimensions, type CriterionView, type DimensionView } from './read-model.js';

export { registerTalentCriterionReferenceGuard, type CriterionReferenceGuard } from './references.js';
export type { CriterionView as TalentCriterionSnapshot, DimensionView as TalentDimensionSnapshot };

/** 端口单次最多读取的指标数（AGENTS §10 有界查询）。 */
export const TALENT_PORT_LIMIT = 500;

/** 人才标准及其引用的指标（按顺序）；types 只保留指定类型的指标。不存在或不在当前租户时返回 null。 */
export async function loadTalentCriterion(
  tx: Tx,
  tenantId: string,
  criterionId: string,
  options: { readonly types?: readonly TalentDimensionType[] } = {},
): Promise<CriterionView | null> {
  const criterion = await loadCriterion(tx, tenantId, criterionId.toLowerCase());
  if (!criterion) return null;
  if (!options.types) return criterion;
  const types = new Set(options.types);
  return { ...criterion, dimensions: criterion.dimensions.filter((item) => types.has(item.type)) };
}

/** 按 ID 批量取指标（含已停用，调用方按 enabled / libraryEnabled 自行判断），按 ID 排序。 */
export async function loadTalentDimensions(tx: Tx, tenantId: string, ids: readonly string[]): Promise<DimensionView[]> {
  const unique = [...new Set(ids.map((id) => id.toLowerCase()))];
  if (unique.length > TALENT_PORT_LIMIT) throw new RangeError(`一次最多读取 ${TALENT_PORT_LIMIT} 个指标`);
  return loadDimensions(tx, tenantId, unique);
}

/** 可被新引用的指标（指标与指标库都已启用，TC-R4），按指标库顺序、指标顺序、编码。 */
export async function listReferenceableDimensions(
  tx: Tx,
  tenantId: string,
  query: { readonly type?: TalentDimensionType; readonly limit: number; readonly offset: number },
): Promise<DimensionView[]> {
  if (query.limit > TALENT_PORT_LIMIT) throw new RangeError(`一次最多读取 ${TALENT_PORT_LIMIT} 个指标`);
  return listDimensions(tx, tenantId, { ...query, referenceable: true, visible: sql`true` });
}

/** 人才标准能否被新引用：存在、在当前租户、已启用（职务「胜任力模型」候选只列启用标准，Q-M0-17）。 */
export async function isTalentCriterionReferenceable(tx: Tx, tenantId: string, criterionId: string): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: talentCriteria.enabled })
    .from(talentCriteria)
    .where(and(eq(talentCriteria.tenantId, tenantId), eq(talentCriteria.id, criterionId.toLowerCase())));
  return row?.enabled === true;
}
