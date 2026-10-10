/**
 * 匿名投影 / 裁剪层（DEC-364①）：读答卷内容（逐题选项、文本答案 / 备注、发展建议）的唯一入口；其他文件对答案表只
 * 写入 / 删除，不从答卷行读建议与备注（结构测试 AC-360-B-15 强制）。两个判断分开：
 * - 身份是否脱敏（DEC-340③ / DEC-355②）：只管审计里的评价关系、答卷编号、命令 ID 与来源——access.ts answerFull
 *   判定，audit/visibility.ts 执行；
 * - 逐份答案能不能看（DEC-358②）：cardViewer 一处定义——持“全部活动”或该活动的创建者，且本人不兼任该活动的被评价人
 *   / 评价者。卡片（sheetCards）与审计出口（access.ts answerCards → audit/visibility.ts）共用这一谓词。
 * 各出口取哪种投影：
 * - 逐份：sheetCards 先过 requireCardViewer 再读，不能绕过资格单独取答案；
 * - 汇总：scoringAnswers（计分只落聚合分）、isSuspected（疑似无效只回布尔）、reportTexts（报告附录按内容排序、
 *   不带评价者标识，report-content.ts）；
 * - 本人：ownSheet / ownAnswers / ownSheetTotal——作答页、待办作答与优秀率控制读评价者自己的答卷；
 * - 审计快照：sheetSnapshot / deletedSheetSnapshot 写进数据库的完整快照，出口按上面两个判断裁剪。
 */
import { and, eq, sql, survey360Answers, survey360SheetTimings, type survey360Sheets, type Tx } from '@italent/db';
import { survey360 } from '@italent/domain';
import type { SQL } from 'drizzle-orm';
import { type Admin, fail, rows } from './context.js';
import type { LoadedQuestionnaire } from './questionnaires.js';

type SheetRecord = typeof survey360Sheets.$inferSelect;
type Pick = { itemId: string; optionId: string };

/** 查看人账号挂接的员工是活动 a 的被评价人或评价者（含已移除的对象 / 评价关系：日志里留有当时的作答）。 */
export function participates(userId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM permission_user_person_links l
    JOIN survey360_people p ON p.tenant_id = l.tenant_id AND p.employee_id = l.employee_id
    WHERE l.tenant_id = a.tenant_id AND l.user_id = ${userId}::uuid
      AND (EXISTS (SELECT 1 FROM survey360_objects o WHERE o.activity_id = a.id AND o.person_id = p.id)
        OR EXISTS (SELECT 1 FROM survey360_relations r WHERE r.activity_id = a.id AND r.appraiser_person_id = p.id)))`;
}

/** DEC-358② 逐份答案的查看人（对活动别名 a）：持“全部活动”或该活动的创建者，且不兼任该活动的被评价人 / 评价者。 */
export function cardViewer(viewer: { userId: string; allActivities: boolean }): SQL {
  const eligible = viewer.allActivities ? sql`true` : sql`a.created_by = ${viewer.userId}::uuid`;
  return sql`(${eligible} AND NOT ${participates(viewer.userId)})`;
}

/** 其他活动管理员与兼任者只看各题汇总（结果报表、报告），逐份卡片 403。 */
export async function requireCardViewer(tx: Tx, admin: Admin, activity: { id: string }): Promise<void> {
  const [row] = rows<{ allowed: boolean }>(
    await tx.execute(sql`SELECT ${cardViewer(admin)} AS allowed FROM survey360_activities a
      WHERE a.id = ${activity.id}::uuid`),
  );
  if (!row?.allowed)
    fail('FORBIDDEN', '只有持“全部活动”权限的管理员或活动创建者可以查看逐份答卷', 'SHEET_CARDS_RESTRICTED');
}

async function picks(tx: Tx, sheetId: string): Promise<Pick[]> {
  return tx
    .select({ itemId: survey360Answers.itemId, optionId: survey360Answers.optionId })
    .from(survey360Answers)
    .where(eq(survey360Answers.sheetId, sheetId));
}

/** 卡片需要的答卷行（sheets.ts 的范围查询结果）。 */
export interface CardSheet {
  id: string;
  object_id: string;
  object_name: string;
  questionnaire_id: string;
  role_id: string;
  role_name: string;
  blocked: boolean;
  blocked_source: string | null;
  revision: number;
}

/** 逐份卡片（套卷、角色、是否屏蔽、总分、逐题得分），不带评价者标识；资格在读答案之前校验。 */
export async function sheetCards(
  tx: Tx,
  admin: Admin,
  activity: { id: string },
  sheets: readonly CardSheet[],
  load: (questionnaireId: string) => Promise<LoadedQuestionnaire>,
) {
  await requireCardViewer(tx, admin, activity);
  const result = [];
  for (const sheet of sheets) result.push(card(sheet, await load(sheet.questionnaire_id), await picks(tx, sheet.id)));
  return result;
}

function card(sheet: CardSheet, q: LoadedQuestionnaire, answers: Pick[]) {
  const picked = new Map(answers.map((a) => [a.itemId, a.optionId]));
  const option = (id: string | undefined) => q.options.find((o) => o.id === id);
  return {
    id: sheet.id,
    objectId: sheet.object_id,
    objectName: sheet.object_name,
    questionnaireId: q.row.id,
    questionnaireName: q.row.name,
    role: { id: sheet.role_id, name: sheet.role_name },
    blocked: sheet.blocked,
    blockSource: sheet.blocked_source,
    total: survey360.scoreSheet(q.model, sheet.role_id, picked).total,
    items: survey360.answerableItems(q.model, sheet.role_id).map((itemId) => {
      const chosen = option(picked.get(itemId));
      return {
        itemId,
        optionLabel: chosen?.label ?? null,
        score: chosen && !chosen.notScored ? chosen.value : null,
      };
    }),
    revision: sheet.revision,
  };
}

/** 关键行为套卷里所有已选题目选择同一选项（至少两题）——“连续选择同一选项”，答卷整份与翻页本页共用。 */
export function sameChoice(q: LoadedQuestionnaire, optionIds: readonly string[]): boolean {
  if (q.model.type !== 'key_behavior' || optionIds.length < 2) return false;
  return new Set(optionIds).size === 1;
}

/**
 * 耗时过快（DEC-392）：“首次打开 → 提交”的整段时间（离开与空闲都计入）除以全部可答题数 < 1.5 秒。本功能上线前已提交、没有
 * 计时记录的答卷不判耗时、也不算疑似（DEC-371③）。耗时与逐份答案同级敏感（DEC-371⑤）：只在库里比较，不出这一层，对外只回布尔。
 */
async function submittedTooFast(tx: Tx, sheetId: string, itemCount: number): Promise<boolean> {
  const [row] = rows<{ opened_at: Date | string; submitted_at: Date | string | null }>(
    await tx.execute(sql`SELECT t.opened_at, s.submitted_at FROM survey360_sheets s
      JOIN survey360_sheet_timings t ON t.tenant_id = s.tenant_id AND t.relation_id = s.relation_id
        AND t.questionnaire_id = s.questionnaire_id
      WHERE s.id = ${sheetId}::uuid`),
  );
  if (!row?.submitted_at) return false;
  return survey360.isTooFast(new Date(row.submitted_at).getTime() - new Date(row.opened_at).getTime(), itemCount);
}

/**
 * 疑似无效（汇总投影，只回布尔）：放弃作答（不计分选项）题量过半；关键行为套卷所有题目选择同一选项（至少两题）；
 * 平均单题耗时 < 1.5 秒（DEC-392：首次打开 → 提交，空闲计入；分母为全部可答题；按份判断）。
 */
export async function isSuspected(tx: Tx, q: LoadedQuestionnaire, roleId: string, sheetId: string) {
  const answers = await picks(tx, sheetId);
  const items = survey360.answerableItems(q.model, roleId);
  const notScored = new Set(q.options.filter((o) => o.notScored).map((o) => o.id));
  const abandoned = answers.filter((a) => notScored.has(a.optionId)).length;
  if (items.length && abandoned / items.length > 0.5) return true;
  if (await submittedTooFast(tx, sheetId, items.length)) return true;
  return sameChoice(
    q,
    answers.map((a) => a.optionId),
  );
}

/** 重新作答 / 移除评价对象清掉答卷时，一并清掉计时：再次作答要重新打开，旧起点不能沿用（DEC-392①）。 */
export async function clearTimings(tx: Tx, sheets: readonly { relationId: string; questionnaireId: string }[]) {
  for (const sheet of sheets)
    await tx
      .delete(survey360SheetTimings)
      .where(
        and(
          eq(survey360SheetTimings.relationId, sheet.relationId),
          eq(survey360SheetTimings.questionnaireId, sheet.questionnaireId),
        ),
      );
}

/** 计分（汇总投影）：活动内已提交、未屏蔽答卷的逐题选项，只交给计分引擎聚合，不出接口（scoring.ts）。 */
export async function scoringAnswers(tx: Tx, activityId: string): Promise<Map<string, Map<string, string>>> {
  const answers = rows<{ sheet_id: string; item_id: string; option_id: string }>(
    await tx.execute(sql`SELECT a.sheet_id, a.item_id, a.option_id FROM survey360_answers a
      JOIN survey360_sheets s ON s.tenant_id = a.tenant_id AND s.id = a.sheet_id
      WHERE s.activity_id = ${activityId}::uuid AND s.status = 'submitted' AND NOT s.blocked`),
  );
  const bySheet = new Map<string, Map<string, string>>();
  for (const a of answers) bySheet.set(a.sheet_id, (bySheet.get(a.sheet_id) ?? new Map()).set(a.item_id, a.option_id));
  return bySheet;
}

/**
 * 报告附录的文本答案（汇总投影，`25` §10.3 ⑬ 开放性反馈 / 补充反馈）：只回文本与角色（角色是否呈现由报告模板
 * 决定），没有答卷编号与评价者标识；排序由报告按内容排，不按作答先后。
 */
export async function reportTexts(tx: Tx, sheetIds: readonly string[]) {
  if (!sheetIds.length) return { suggestions: [], remarks: [] };
  const ids = `{${sheetIds.join(',')}}`;
  const suggestions = rows<{ role_id: string; text: string }>(
    await tx.execute(sql`SELECT r.role_id, s.suggestion AS text FROM survey360_sheets s
      JOIN survey360_relations r ON r.tenant_id = s.tenant_id AND r.id = s.relation_id
      WHERE s.id = ANY(${ids}::uuid[]) AND s.suggestion IS NOT NULL AND btrim(s.suggestion) <> ''`),
  );
  const remarks = rows<{ item_id: string; role_id: string; text: string }>(
    await tx.execute(sql`SELECT a.item_id, r.role_id, a.remark AS text FROM survey360_answers a
      JOIN survey360_sheets s ON s.tenant_id = a.tenant_id AND s.id = a.sheet_id
      JOIN survey360_relations r ON r.tenant_id = s.tenant_id AND r.id = s.relation_id
      WHERE a.sheet_id = ANY(${ids}::uuid[]) AND a.remark IS NOT NULL AND btrim(a.remark) <> ''`),
  );
  return { suggestions, remarks };
}

/** 本人投影：评价者自己这份答卷的逐题选项与备注（作答页、提交校验）。 */
export async function ownAnswers(tx: Tx, sheetId: string) {
  return tx
    .select({ itemId: survey360Answers.itemId, optionId: survey360Answers.optionId, remark: survey360Answers.remark })
    .from(survey360Answers)
    .where(eq(survey360Answers.sheetId, sheetId))
    .orderBy(survey360Answers.itemId);
}

/** 本人投影：作答页 / 待办作答展示的答卷（也是保存、提交审计的前后快照，出口另行裁剪）。 */
export async function ownSheet(tx: Tx, sheet: SheetRecord | undefined) {
  if (!sheet) return { status: 'pending', revision: 0, answers: [], suggestion: null };
  return {
    status: sheet.status,
    revision: sheet.revision,
    answers: await ownAnswers(tx, sheet.id),
    suggestion: sheet.suggestion,
  };
}

/** 本人投影：同一评价者另一份答卷的总分（优秀率控制只看本人答卷）。 */
export async function ownSheetTotal(tx: Tx, model: survey360.QuestionnaireModel, roleId: string, sheetId: string) {
  const picked = new Map((await picks(tx, sheetId)).map((a) => [a.itemId, a.optionId]));
  return survey360.scoreSheet(model, roleId, picked).total;
}

/** 审计快照：清除作答前的答卷内容（写入数据库；审计出口按身份脱敏与逐份答案资格分别裁剪）。 */
export async function sheetSnapshot(tx: Tx, sheet: SheetRecord) {
  const answers = await ownAnswers(tx, sheet.id);
  return { status: sheet.status, answers, suggestion: sheet.suggestion };
}

/** 审计快照：替换套卷删除答卷前的完整行（DEC-019 / 216 删除留快照）。 */
export async function deletedSheetSnapshot(tx: Tx, sheet: SheetRecord) {
  const answers = await tx
    .select()
    .from(survey360Answers)
    .where(eq(survey360Answers.sheetId, sheet.id))
    .orderBy(survey360Answers.id);
  return { ...sheet, answers };
}
