/**
 * 答卷计时（F-060 收尾，DEC-392 / DEC-405 / DEC-402）：每个（评价关系 × 套卷）一行，记“首次打开”与“本页起点”。
 * - 首次打开 = 评价者第一次取到该套卷的作答页（GET）；保存时补建作兜底，所以不取页面直接保存 / 提交的新答卷也纳入判定；
 * - 耗时只存库，对外只回“是否提醒 / 是否疑似”的布尔（DEC-371⑤）；
 * - 计时的每一次写入都写字段级审计（DEC-019，DEC-405①）：建立、翻页更新、清除（保留快照），与业务同事务；
 *   只留存、不披露（DEC-409①）；
 * - 计时跟着它所属的评价关系 / 评价对象清除：重新作答清该评价关系的全部计时，替换套卷清该评价对象所有评价关系的
 *   全部计时——不论答卷是否已保存（只打开过、部分保存的也清）。
 */
import { and, eq, inArray, survey360Relations, survey360SheetTimings, type Tx } from '@italent/db';
import { actor, audit360, type Writer } from './context.js';

/**
 * 审计对象类型与动作。**不登记审计查看规则**（audit/visibility.ts fail-closed）：计时事件只留存在库，产品审计接口一律不披露
 * （DEC-409①，修订 DEC-405①）——事件的存在、次数、时间、排序 / 游标与命令编号都是反推耗时的旁路（DEC-371⑤）。
 */
export const TIMING_AUDIT_TYPE = 'survey360-sheet-timing';
export const TIMING_ACTIONS = {
  open: 'survey360.sheet-timing.open',
  page: 'survey360.sheet-timing.page',
  clear: 'survey360.sheet-timing.clear',
} as const;

export type Timing = typeof survey360SheetTimings.$inferSelect;

/** 审计快照：库内完整值（审计存证，不披露）。 */
function snapshot(activityId: string, t: Timing) {
  return {
    activityId,
    relationId: t.relationId,
    questionnaireId: t.questionnaireId,
    openedAt: new Date(t.openedAt).toISOString(),
    pageStartedAt: new Date(t.pageStartedAt).toISOString(),
  };
}

export async function findTiming(tx: Tx, relationId: string, questionnaireId: string, lock = false) {
  const query = tx
    .select()
    .from(survey360SheetTimings)
    .where(
      and(eq(survey360SheetTimings.relationId, relationId), eq(survey360SheetTimings.questionnaireId, questionnaireId)),
    );
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/**
 * 首次打开：没有就建（打开与翻页起点同为现在），已有不动。调用方须已取得 openSheet 的锁（同一评价者串行、活动启用、
 * 关系与对象行锁），所以不会与替换套卷 / 重新作答的清除交错出残留。返回 created 供调用方区分“刚建”。
 */
export async function ensureTiming(
  tx: Tx,
  ctx: Writer,
  activityId: string,
  relationId: string,
  questionnaireId: string,
): Promise<{ timing: Timing; created: boolean }> {
  const [created] = await tx
    .insert(survey360SheetTimings)
    .values({ tenantId: ctx.tenantId, relationId, questionnaireId, openedAt: ctx.now, pageStartedAt: ctx.now })
    .onConflictDoNothing()
    .returning();
  if (!created) return { timing: (await findTiming(tx, relationId, questionnaireId, true))!, created: false };
  await audit360(tx, actor(ctx), {
    action: TIMING_ACTIONS.open,
    objectType: TIMING_AUDIT_TYPE,
    objectId: created.id,
    before: null,
    after: snapshot(activityId, created),
  });
  return { timing: created, created: true };
}

/** 翻页：本页起点挪到现在（打开时刻不动），并留审计。 */
export async function advancePage(tx: Tx, ctx: Writer, activityId: string, timing: Timing): Promise<void> {
  const [updated] = await tx
    .update(survey360SheetTimings)
    .set({ pageStartedAt: ctx.now })
    .where(eq(survey360SheetTimings.id, timing.id))
    .returning();
  await audit360(tx, actor(ctx), {
    action: TIMING_ACTIONS.page,
    objectType: TIMING_AUDIT_TYPE,
    objectId: timing.id,
    before: snapshot(activityId, timing),
    after: snapshot(activityId, updated!),
  });
}

async function clearRows(tx: Tx, ctx: Writer, activityId: string, found: readonly Timing[]): Promise<void> {
  for (const timing of found)
    await audit360(tx, actor(ctx), {
      action: TIMING_ACTIONS.clear,
      objectType: TIMING_AUDIT_TYPE,
      objectId: timing.id,
      before: snapshot(activityId, timing),
      after: {
        activityId,
        relationId: timing.relationId,
        questionnaireId: timing.questionnaireId,
        deleted: true,
      },
    });
  if (found.length)
    await tx.delete(survey360SheetTimings).where(
      inArray(
        survey360SheetTimings.id,
        found.map((t) => t.id),
      ),
    );
}

/** 重新作答：清掉该评价关系的全部计时（含只打开过、没有答卷的套卷）。 */
export async function clearRelationTimings(tx: Tx, ctx: Writer, activityId: string, relationId: string) {
  const found = await tx
    .select()
    .from(survey360SheetTimings)
    .where(eq(survey360SheetTimings.relationId, relationId))
    .orderBy(survey360SheetTimings.id)
    .for('update');
  await clearRows(tx, ctx, activityId, found);
}

/** 替换套卷：清掉该评价对象所有评价关系（含已移除关系遗留）的全部计时。 */
export async function clearObjectTimings(tx: Tx, ctx: Writer, activityId: string, objectId: string) {
  const found = await tx
    .select({ timing: survey360SheetTimings })
    .from(survey360SheetTimings)
    .innerJoin(
      survey360Relations,
      and(
        eq(survey360Relations.tenantId, survey360SheetTimings.tenantId),
        eq(survey360Relations.id, survey360SheetTimings.relationId),
      ),
    )
    .where(and(eq(survey360Relations.activityId, activityId), eq(survey360Relations.objectId, objectId)))
    .orderBy(survey360SheetTimings.id)
    .for('update', { of: survey360SheetTimings });
  await clearRows(
    tx,
    ctx,
    activityId,
    found.map((row) => row.timing),
  );
}
