/** F-034，25 §3.1 E3-R2：替换套卷清空该对象全部作答；删除快照按 Answer 当前查看权限裁剪。 */
import { and, eq, inArray, survey360Answers, survey360Relations, survey360Sheets, type Tx } from '@italent/db';
import { deletedSheetSnapshot } from './anonymous.js';
import { actor, audit360, type Writer } from './context.js';

type Sheet = typeof survey360Sheets.$inferSelect;

/** 与作答共用活动 → 对象 → 答卷锁顺序；包括已移除关系遗留的答卷，避免旧作答恢复。 */
export async function objectSheets(tx: Tx, activityId: string, objectId: string): Promise<Sheet[]> {
  const found = await tx
    .select({ sheet: survey360Sheets })
    .from(survey360Sheets)
    .innerJoin(
      survey360Relations,
      and(
        eq(survey360Relations.tenantId, survey360Sheets.tenantId),
        eq(survey360Relations.id, survey360Sheets.relationId),
      ),
    )
    .where(and(eq(survey360Sheets.activityId, activityId), eq(survey360Relations.objectId, objectId)))
    .orderBy(survey360Sheets.id)
    .for('update', { of: survey360Sheets });
  return found.map(({ sheet }) => sheet);
}

/** 每张答卷单独留完整删除前快照，不把答案塞进 Relation 日志（DEC-019 / 216）。 */
export async function clearObjectAnswers(tx: Tx, ctx: Writer, sheets: readonly Sheet[]): Promise<void> {
  if (!sheets.length) return;
  for (const sheet of sheets) {
    await audit360(tx, actor(ctx), {
      action: 'survey360.sheet.delete',
      objectType: 'survey360-sheet',
      objectId: sheet.id,
      before: await deletedSheetSnapshot(tx, sheet),
      after: {
        id: sheet.id,
        activityId: sheet.activityId,
        relationId: sheet.relationId,
        questionnaireId: sheet.questionnaireId,
        deleted: true,
      },
    });
  }
  const ids = sheets.map((sheet) => sheet.id);
  await tx.delete(survey360Answers).where(inArray(survey360Answers.sheetId, ids));
  await tx.delete(survey360Sheets).where(inArray(survey360Sheets.id, ids));
}
