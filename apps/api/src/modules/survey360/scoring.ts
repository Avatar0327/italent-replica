/**
 * 计分（E3-R11、E3-R13、E3-R15）：停用活动时按已提交的答卷重算，得分写入新的计分批次，活动指向最新批次；
 * 已移除的评价对象与评价关系、未提交的答卷、被屏蔽的答卷（PR-B，AC-360-08）不参与计分。只存聚合分，不落逐个
 * 评价者的分数。
 */
import { sql, survey360Activities, survey360ScoreBatches, survey360Scores, type Tx, eq } from '@italent/db';
import { survey360 } from '@italent/domain';
import { scoringAnswers } from './anonymous.js';
import { rows } from './context.js';
import { type LoadedQuestionnaire, loadQuestionnaire } from './questionnaires.js';

interface SheetRow {
  sheet_id: string;
  object_id: string;
  questionnaire_id: string;
  role_id: string;
  is_self: boolean;
}

/**
 * 计分用到的套卷按 ID 升序加共享锁（调用方已持有活动行锁，顺序 活动 → 套卷，与 F-053 一致），并记下各自的计分口径
 * 版本：正在修改的套卷（持行锁）先提交、再计分；计分期间的修改要等计分提交，之后版本必然高于本批次（第 3 轮 P2-3）。
 */
async function lockedRevisions(tx: Tx, activityId: string): Promise<Record<string, number>> {
  const found = rows<{ id: string; scoring_revision: number }>(
    await tx.execute(sql`SELECT q.id, q.scoring_revision FROM survey360_questionnaires q
      WHERE q.id IN (SELECT oq.questionnaire_id FROM survey360_object_questionnaires oq
        JOIN survey360_objects o ON o.tenant_id = oq.tenant_id AND o.id = oq.object_id AND NOT o.removed
        WHERE o.activity_id = ${activityId}::uuid)
      ORDER BY q.id FOR SHARE`),
  );
  return Object.fromEntries(found.map((q) => [q.id, Number(q.scoring_revision)]));
}

export async function computeScores(
  tx: Tx,
  ctx: { tenantId: string; commandId: string; now: Date },
  activityId: string,
) {
  const questionnaireRevisions = await lockedRevisions(tx, activityId);
  const sheets = rows<SheetRow>(
    await tx.execute(sql`SELECT s.id AS sheet_id, r.object_id, s.questionnaire_id, r.role_id,
        (ro.code = 'self') AS is_self
      FROM survey360_sheets s
      JOIN survey360_relations r ON r.tenant_id = s.tenant_id AND r.id = s.relation_id AND NOT r.removed
      JOIN survey360_objects o ON o.tenant_id = r.tenant_id AND o.id = r.object_id AND NOT o.removed
      JOIN survey360_object_questionnaires oq ON oq.tenant_id = o.tenant_id AND oq.object_id = o.id
        AND oq.questionnaire_id = s.questionnaire_id
      JOIN survey360_roles ro ON ro.tenant_id = r.tenant_id AND ro.id = r.role_id
      WHERE s.activity_id = ${activityId}::uuid AND s.status = 'submitted' AND NOT s.blocked`),
  );
  const bySheet = await scoringAnswers(tx, activityId);
  const models = new Map<string, LoadedQuestionnaire>();
  const groups = new Map<string, SheetRow[]>();
  for (const s of sheets) {
    const k = `${s.object_id}|${s.questionnaire_id}`;
    groups.set(k, [...(groups.get(k) ?? []), s]);
    if (!models.has(s.questionnaire_id))
      models.set(s.questionnaire_id, await loadQuestionnaire(tx, s.questionnaire_id));
  }
  const [batch] = await tx
    .insert(survey360ScoreBatches)
    .values({ tenantId: ctx.tenantId, activityId, commandId: ctx.commandId, questionnaireRevisions })
    .returning();
  const values = [];
  for (const [k, group] of groups) {
    const [objectId, questionnaireId] = k.split('|') as [string, string];
    const model = models.get(questionnaireId)!.model;
    const raters = group.map((s) => ({
      roleId: s.role_id,
      isSelf: s.is_self,
      scores: survey360.scoreSheet(model, s.role_id, bySheet.get(s.sheet_id) ?? new Map()),
    }));
    for (const score of survey360.aggregateScores(model, raters))
      values.push({ tenantId: ctx.tenantId, batchId: batch!.id, activityId, objectId, questionnaireId, ...score });
  }
  for (let i = 0; i < values.length; i += 500) await tx.insert(survey360Scores).values(values.slice(i, i + 500));
  await tx
    .update(survey360Activities)
    // 重算即纳入此前的作答数据变化（清除作答、屏蔽），报告恢复可查看、可重新生成
    .set({ scoreBatchId: batch!.id, scoredAt: ctx.now, dataChangedAt: null })
    .where(eq(survey360Activities.id, activityId));
  return batch!.id;
}

export interface ScoreView {
  questionnaireId: string;
  level: string;
  itemId: string | null;
  scope: string;
  roleId: string | null;
  roleName: string | null;
  score: number | null;
  raterCount: number;
}

/** 评价对象在最新计分批次中的得分（管理员视图；只有聚合分与参与人数，DEC-149 不按人数隐藏）。 */
export async function objectScores(tx: Tx, batchId: string | null, objectId: string): Promise<ScoreView[]> {
  if (!batchId) return [];
  return rows<{
    questionnaire_id: string;
    level: string;
    item_id: string | null;
    scope: string;
    role_id: string | null;
    role_name: string | null;
    score: number | null;
    rater_count: number;
  }>(
    await tx.execute(sql`SELECT sc.questionnaire_id, sc.level, sc.item_id, sc.scope, sc.role_id, ro.name AS role_name,
        sc.score, sc.rater_count
      FROM survey360_scores sc
      LEFT JOIN survey360_roles ro ON ro.tenant_id = sc.tenant_id AND ro.id = sc.role_id
      WHERE sc.batch_id = ${batchId}::uuid AND sc.object_id = ${objectId}::uuid
      ORDER BY sc.questionnaire_id, sc.level, sc.item_id NULLS FIRST, sc.scope, ro.sort NULLS FIRST`),
  ).map((r) => ({
    questionnaireId: r.questionnaire_id,
    level: r.level,
    itemId: r.item_id,
    scope: r.scope,
    roleId: r.role_id,
    roleName: r.role_name,
    score: r.score === null ? null : Number(r.score),
    raterCount: Number(r.rater_count),
  }));
}
