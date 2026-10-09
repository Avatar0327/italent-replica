/**
 * 计分组成的变化（PR-B）：作答数据（清除作答、屏蔽 / 取消屏蔽）与计分组成（评价关系 / 评价对象增删、对象套卷调整、
 * 已使用套卷的权重与计分方式修改）一变，旧报告即失效，到下一次停用计分前不能生成新报告——保证报告里的关系、答卷
 * 与分数来自同一个计分批次（第 2 轮 P2-7）。报告是否有效另按报告的计分批次核对（reports.ts），重算不让旧报告复活。
 */
import { eq, sql, survey360Activities, type Tx } from '@italent/db';
import { rows } from './context.js';

/** 记下变化时间并把评价对象的报告生成时间置空（Lastest360Cent 不再计入，DEC-262②）。 */
export async function markDataChanged(tx: Tx, activityId: string, now: Date): Promise<void> {
  await tx.update(survey360Activities).set({ dataChangedAt: now }).where(eq(survey360Activities.id, activityId));
  await tx.execute(
    sql`UPDATE survey360_objects SET report_generated_at = NULL WHERE activity_id = ${activityId}::uuid`,
  );
}

/** 用到某套卷的全部活动（未移除的评价对象）都标记变化：已使用套卷改权重 / 计分方式会改变计分结果。 */
export async function markQuestionnaireChanged(tx: Tx, questionnaireId: string, now: Date): Promise<void> {
  const ids = rows<{ activity_id: string }>(
    await tx.execute(sql`SELECT DISTINCT o.activity_id FROM survey360_object_questionnaires oq
      JOIN survey360_objects o ON o.tenant_id = oq.tenant_id AND o.id = oq.object_id AND NOT o.removed
      WHERE oq.questionnaire_id = ${questionnaireId}::uuid`),
  );
  for (const { activity_id } of ids) await markDataChanged(tx, activity_id, now);
}

/** 最近一次计分之后计分组成有变化：生成被拦、已生成的报告失效。计分时清空。 */
export function dataChanged(activity: { data_changed_at: Date | string | null }): boolean {
  return activity.data_changed_at !== null;
}
