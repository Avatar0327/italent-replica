/**
 * 计分组成的变化（PR-B）：作答数据（清除作答、屏蔽 / 取消屏蔽）与计分组成（评价关系 / 评价对象增删、对象套卷调整、
 * 已使用套卷的权重与计分方式修改）一变，旧报告即失效，到下一次停用计分前不能生成新报告——保证报告里的关系、答卷
 * 与分数来自同一个计分批次（第 2 轮 P2-7）。报告是否有效另按报告的计分批次核对（reports.ts），重算不让旧报告复活。
 * 活动内的变化记在活动上（markDataChanged）；套卷的变化记在套卷上（markQuestionnaireChanged），两者由
 * scoringChanged 合并判断。
 */
import { eq, sql, survey360Activities, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { rows } from './context.js';

/**
 * 记下活动的变化时间（活动内报告一律不可查看、不可生成，原站提示是活动级的），并把**受影响**评价对象的报告生成时间
 * 置空（Lastest360Cent 不再计入，DEC-262②）；其他对象当前批次的分数没变，生成标记保留（与 F-034 替换套卷同一口径）。
 */
export async function markDataChanged(
  tx: Tx,
  activityId: string,
  now: Date,
  objectIds: readonly string[],
): Promise<void> {
  await tx.update(survey360Activities).set({ dataChangedAt: now }).where(eq(survey360Activities.id, activityId));
  if (!objectIds.length) return;
  await tx.execute(sql`UPDATE survey360_objects SET report_generated_at = NULL
    WHERE activity_id = ${activityId}::uuid AND id = ANY(${`{${[...new Set(objectIds)].join(',')}}`}::uuid[])`);
}

/**
 * 已使用套卷改了计分口径（内容 / 权重 / 计分方式）：只在套卷上把版本号 +1，不写活动 / 评价对象行——套卷编辑持有
 * 套卷锁，再去锁活动会与启用、替换套卷的 活动 → 套卷 顺序反向等待（F-053）。版本号在套卷行锁内递增，不取请求时间：
 * 编辑等锁期间完成的计分记下的是旧版本，编辑提交后必然判为“已变化”（第 3 轮 P2-3）。
 */
export async function markQuestionnaireChanged(tx: Tx, questionnaireId: string): Promise<void> {
  await tx.execute(sql`UPDATE survey360_questionnaires SET scoring_revision = scoring_revision + 1
    WHERE id = ${questionnaireId}::uuid`);
}

/** 最近一次计分之后计分组成有变化：生成被拦、已生成的报告失效。计分时清空。 */
export function dataChanged(activity: { data_changed_at: Date | string | null }): boolean {
  return activity.data_changed_at !== null;
}

/**
 * 某套卷当前的计分口径版本高于计分批次记下的版本。批次没记版本的套卷一律视为已变化：PR-A 留下的历史批次升级后
 * 版本映射为空，而 PR-A 允许停用后修改已使用套卷，又没有记修改时间，无法证明计分后没改过（第 4 轮 P2-2）；新批次
 * 记下计分时活动内全部套卷，之后新挂的套卷本身已标记数据变化。activity / object 是 SQL 别名所在的列：活动的当前批次
 * 与评价对象。报告查看 / 生成 / 转发与 Lastest360Cent 共用这一判定。
 */
export function questionnaireChangedSince(batchId: SQL, objectId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM survey360_object_questionnaires coq
    JOIN survey360_questionnaires cq ON cq.tenant_id = coq.tenant_id AND cq.id = coq.questionnaire_id
    JOIN survey360_score_batches cb ON cb.tenant_id = coq.tenant_id AND cb.id = ${batchId}
    WHERE coq.object_id = ${objectId}
      AND cq.scoring_revision > COALESCE((cb.questionnaire_revisions ->> cq.id::text)::int, -1))`;
}

/**
 * 活动的报告是否失效：计分组成在计分后有变化（dataChanged），或活动内（未移除的评价对象）用到的套卷在最近一次
 * 计分之后改过计分口径。
 */
export async function scoringChanged(
  tx: Tx,
  activity: { id: string; data_changed_at: Date | string | null; score_batch_id: string | null },
): Promise<boolean> {
  if (dataChanged(activity)) return true;
  if (activity.score_batch_id === null) return false;
  const [row] = rows<{ changed: boolean }>(
    await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM survey360_objects o
      WHERE o.activity_id = ${activity.id}::uuid AND NOT o.removed
        AND ${questionnaireChangedSince(sql`${activity.score_batch_id}::uuid`, sql`o.id`)}) AS changed`),
  );
  return row!.changed;
}
