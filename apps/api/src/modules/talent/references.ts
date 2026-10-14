/**
 * 人才标准的外部引用守卫（TC-R5 同口径）：后续模块（职务「胜任力模型」、盘点项目、人才池出入池标准、IDP 胜任力目标）
 * 在加载时登记“该人才标准是否被我引用”，删除人才标准时在同一事务内逐个询问，任一返回引用方编码即拒绝删除。
 */
import type { Tx } from '@italent/db';

/** 返回引用方编码（如 'JOB_COMPETENCY_MODEL'）表示被引用；返回 null 表示未引用。 */
export type CriterionReferenceGuard = (tx: Tx, tenantId: string, criterionId: string) => Promise<string | null>;

const guards: CriterionReferenceGuard[] = [];

export function registerTalentCriterionReferenceGuard(guard: CriterionReferenceGuard): void {
  if (!guards.includes(guard)) guards.push(guard);
}

export async function criterionReferrer(tx: Tx, tenantId: string, criterionId: string): Promise<string | null> {
  for (const guard of guards) {
    const referrer = await guard(tx, tenantId, criterionId);
    if (referrer) return referrer;
  }
  return null;
}
