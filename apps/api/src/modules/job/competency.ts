/**
 * 职务「胜任力模型」= 人才标准引用（Q-M0-17，docs/02_业务建模/19 §职务引用的胜任力模型）。
 * - 保存时校验：存在、同租户、启用；只校验新增或更改的引用，标准事后停用时已有引用保留（展示时标注已停用）。
 * - 引用方守卫：被职务（任一版本）引用的人才标准不能删除，与盘点项目等其他引用方同口径（TC-R5）。
 * 人才标准没有指向它的外键，所以保存时对标准行加共享锁：与删除互斥，删除方后一步询问引用时能看到本事务的写入。
 */
import { sql, type Tx } from '@italent/db';
import { AppError } from '../../errors.js';
import { isTalentCriterionReferenceable, registerTalentCriterionReferenceGuard } from '../talent/port.js';
import { rowsOf } from './store.js';
import type { JobFields } from './types.js';

export const JOB_COMPETENCY_REFERRER = 'JOB_COMPETENCY_MODEL';

export async function validateCompetencyModel(
  tx: Tx,
  tenantId: string,
  fields: JobFields,
  previousId: string | null | undefined,
): Promise<void> {
  const id = fields.competencyModelId;
  if (typeof id !== 'string' || id.toLowerCase() === previousId?.toLowerCase()) return;
  await tx.execute(
    sql`SELECT 1 FROM talent_criteria WHERE tenant_id = ${tenantId} AND id = ${id.toLowerCase()}::uuid FOR SHARE`,
  );
  if (!(await isTalentCriterionReferenceable(tx, tenantId, id))) {
    throw new AppError('VALIDATION_FAILED', '胜任力模型必须是本租户已启用的人才标准', {
      field: 'competencyModelId',
    });
  }
}

registerTalentCriterionReferenceGuard(async (tx, tenantId, criterionId) => {
  const rows = rowsOf(
    await tx.execute(sql`SELECT 1 FROM job_post_versions
      WHERE tenant_id = ${tenantId} AND competency_model_id = ${criterionId}::uuid LIMIT 1`),
  );
  return rows.length > 0 ? JOB_COMPETENCY_REFERRER : null;
});
