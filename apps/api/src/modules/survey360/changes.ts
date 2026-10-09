/**
 * 计分组成的变化（PR-B）：作答数据（清除作答、屏蔽 / 取消屏蔽）与计分组成（评价关系 / 评价对象增删、对象套卷调整、
 * 已使用套卷的权重与计分方式修改）一变，旧报告即失效，到下一次停用计分前不能生成新报告——保证报告里的关系、答卷
 * 与分数来自同一个计分批次（第 2 轮 P2-7）。报告是否有效另按报告的计分批次核对（reports.ts），重算不让旧报告复活。
 */
import { eq, sql, survey360Activities, type Tx } from '@italent/db';
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

/** 用到某套卷的全部活动（未移除的评价对象）都标记变化：已使用套卷改权重 / 计分方式会改变计分结果。 */
export async function markQuestionnaireChanged(tx: Tx, questionnaireId: string, now: Date): Promise<void> {
  const found = rows<{ activity_id: string; object_id: string }>(
    await tx.execute(sql`SELECT o.activity_id, o.id AS object_id FROM survey360_object_questionnaires oq
      JOIN survey360_objects o ON o.tenant_id = oq.tenant_id AND o.id = oq.object_id AND NOT o.removed
      WHERE oq.questionnaire_id = ${questionnaireId}::uuid ORDER BY o.activity_id, o.id`),
  );
  const byActivity = new Map<string, string[]>();
  for (const r of found) byActivity.set(r.activity_id, [...(byActivity.get(r.activity_id) ?? []), r.object_id]);
  for (const [activityId, objectIds] of byActivity) await markDataChanged(tx, activityId, now, objectIds);
}

/** 最近一次计分之后计分组成有变化：生成被拦、已生成的报告失效。计分时清空。 */
export function dataChanged(activity: { data_changed_at: Date | string | null }): boolean {
  return activity.data_changed_at !== null;
}
