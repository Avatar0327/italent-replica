/**
 * 标准版个人报告的内容快照（`25` §10.3 ⑬：封面 / 前言〔评价关系表 + 选项分值表〕/ 概况 / 优势与待发展 / 认知偏差 /
 * 发展建议 / 附录：开放性反馈 / 附录：评估详情 / 附录：补充反馈 / 声明）。
 * 身份保护（派发单 §37）：快照里没有任何评价者标识——没有姓名、人员 ID、评价关系 ID、答卷 ID；文本答案按内容排序，
 * 不按作答先后；报告模板“文本答案中是否呈现评价角色”（DEC-149 第二个匿名开关）关闭时角色键缺席。
 * 分数按角色列出、评价关系表列各角色完成 / 邀请人数，不按人数隐藏（DEC-149）；评价关系表把被屏蔽的答卷算作未完成
 * （§10.3 ⑨）。缺少他评数据的模块显示原站文案。参照标准取同活动同套卷他评分的 80 分位（⑯ 插值口径后补，先按
 * Excel PERCENTILE.INC 线性插值，🟡）。
 */
import { sql, type Tx } from '@italent/db';
import { reportTexts } from './anonymous.js';
import { rows } from './context.js';
import { type LoadedQuestionnaire, loadQuestionnaire } from './questionnaires.js';
import { objectScores, type ScoreView } from './scoring.js';

export const MISSING_SECTION = '因缺少有效数据，该部分报告内容缺失。';
const STATEMENT = '本报告基于评价者的匿名反馈生成，仅供个人发展参考；报告不呈现任何评价者的身份信息。';

export interface ReportSubject {
  readonly activityId: string;
  readonly activityName: string;
  readonly objectId: string;
  readonly objectName: string;
  readonly department: string | null;
  readonly position: string | null;
}

export interface ReportTemplate {
  readonly name: string;
  readonly showTextRole: boolean;
}

interface Role {
  id: string;
  name: string;
  sort: number;
}

interface ValidSheet {
  id: string;
  role_id: string;
}

/** Excel PERCENTILE.INC：排序后在 (n-1)·p 处线性插值。 */
export function percentileInc(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

const round4 = (value: number | null) => (value === null ? null : Math.round(value * 10_000) / 10_000);
const byText = <T extends { text: string }>(a: T, b: T) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0);

async function rolesOf(tx: Tx): Promise<Map<string, Role>> {
  const found = rows<Role>(await tx.execute(sql`SELECT id, name, sort FROM survey360_roles`));
  return new Map(found.map((r) => [r.id, r]));
}

async function referenceOf(tx: Tx, batchId: string, questionnaireId: string) {
  const values = rows<{ score: number }>(
    await tx.execute(sql`SELECT score FROM survey360_scores WHERE batch_id = ${batchId}::uuid
      AND questionnaire_id = ${questionnaireId}::uuid AND level = 'questionnaire' AND scope = 'other'
      AND score IS NOT NULL`),
  ).map((r) => Number(r.score));
  return { method: 'percentile80', value: round4(percentileInc(values, 0.8)) };
}

function relationTable(q: LoadedQuestionnaire, roles: Map<string, Role>, invited: string[], valid: ValidSheet[]) {
  const ordered = q.roles.map((r) => roles.get(r.roleId)!).sort((a, b) => a.sort - b.sort);
  const table = ordered
    .map((role) => {
      const total = invited.filter((id) => id === role.id).length;
      const done = valid.filter((s) => s.role_id === role.id).length;
      return { roleId: role.id, roleName: role.name, completed: done, invited: total };
    })
    .filter((row) => row.invited > 0)
    .map((row) => ({ ...row, rate: Math.round((row.completed / row.invited) * 1000) / 10 }));
  const completed = table.reduce((n, r) => n + r.completed, 0);
  const all = table.reduce((n, r) => n + r.invited, 0);
  return { table, total: { completed, invited: all, rate: all ? Math.round((completed / all) * 1000) / 10 : 0 } };
}

function scorer(scores: readonly ScoreView[]) {
  return (level: string, itemId: string | null, scope: string, roleId: string | null = null) =>
    scores.find((s) => s.level === level && s.itemId === itemId && s.scope === scope && s.roleId === roleId)?.score ??
    null;
}

async function textAnswers(tx: Tx, q: LoadedQuestionnaire, valid: ValidSheet[], label: (roleId: string) => object) {
  // 文本答案只经匿名投影层取（DEC-364①）：没有答卷编号与评价者标识
  const { suggestions, remarks } = await reportTexts(
    tx,
    valid.map((v) => v.id),
  );
  const openFeedback = suggestions.map((s) => ({ text: s.text, ...label(s.role_id) })).sort(byText);
  const items =
    q.model.type === 'rating'
      ? q.dimensions.map((d) => ({ id: d.id, text: d.name }))
      : q.questions.map((x) => ({ id: x.id, text: x.text }));
  const supplementary = items
    .map((item) => ({
      question: item.text,
      answers: remarks
        .filter((r) => r.item_id === item.id)
        .map((r) => ({ text: r.text, ...label(r.role_id) }))
        .sort(byText),
    }))
    .filter((entry) => entry.answers.length > 0);
  return { openFeedback, supplementary };
}

type Score = ReturnType<typeof scorer>;
interface DimensionScore {
  dimensionId: string;
  name: string;
  definition: string | null;
  self: number | null;
  other: number | null;
}
type RoleScores = (
  level: string,
  itemId: string | null,
) => { roleId: string; roleName: string; score: number | null }[];

/** 优势与待发展、认知偏差、发展建议：缺少他评（或自评）数据时显示原站文案。 */
function analysis(
  other: number | null,
  self: number | null,
  dims: DimensionScore[],
  rated: DimensionScore[],
  roleScores: RoleScores,
  basic: readonly { id: string; name: string }[],
  score: Score,
) {
  const entry = (d: DimensionScore) => ({ dimensionId: d.dimensionId, name: d.name, score: d.other });
  return {
    strengths:
      other === null
        ? MISSING_SECTION
        : {
            strengths: rated.slice(0, 3).map(entry),
            weaknesses: [...rated].reverse().slice(0, 3).map(entry),
            byRole: roleScores('questionnaire', null).map((role) => {
              const ranked = basic
                .map((d) => ({ name: d.name, score: score('dimension', d.id, 'role', role.roleId) }))
                .filter((d) => d.score !== null)
                .sort((a, b) => b.score! - a.score!);
              return { roleName: role.roleName, highest: ranked[0]?.name ?? null, lowest: ranked.at(-1)?.name ?? null };
            }),
          },
    bias:
      other === null || self === null
        ? MISSING_SECTION
        : {
            self: dims.map((d) => ({
              dimensionId: d.dimensionId,
              name: d.name,
              self: d.self,
              other: d.other,
              gap: d.self === null || d.other === null ? null : round4(d.self - d.other),
            })),
            roles: dims.map((d) => ({
              dimensionId: d.dimensionId,
              name: d.name,
              scores: roleScores('dimension', d.dimensionId).map((r) => ({ roleName: r.roleName, score: r.score })),
            })),
          },
    developmentAdvice:
      other === null
        ? MISSING_SECTION
        : [...rated]
            .reverse()
            .slice(0, 3)
            .map((d) => ({ name: d.name, definition: d.definition, score: d.other })),
  };
}

async function questionnairePart(
  tx: Tx,
  subject: ReportSubject,
  template: ReportTemplate,
  batchId: string,
  questionnaireId: string,
  roles: Map<string, Role>,
) {
  const q = await loadQuestionnaire(tx, questionnaireId);
  const invited = rows<{ role_id: string }>(
    await tx.execute(sql`SELECT r.role_id FROM survey360_relations r WHERE r.object_id = ${subject.objectId}::uuid
      AND NOT r.removed`),
  )
    .map((r) => r.role_id)
    .filter((id) => q.roles.some((r) => r.roleId === id));
  const valid = rows<ValidSheet>(
    await tx.execute(sql`SELECT s.id, r.role_id FROM survey360_sheets s
      JOIN survey360_relations r ON r.tenant_id = s.tenant_id AND r.id = s.relation_id AND NOT r.removed
      WHERE r.object_id = ${subject.objectId}::uuid AND s.questionnaire_id = ${questionnaireId}::uuid
        AND s.status = 'submitted' AND NOT s.blocked`),
  );
  const score = scorer(
    (await objectScores(tx, batchId, subject.objectId)).filter((s) => s.questionnaireId === q.row.id),
  );
  const roleOrder = q.roles.map((r) => roles.get(r.roleId)!).sort((a, b) => a.sort - b.sort);
  const roleScores = (level: string, itemId: string | null) =>
    roleOrder
      .map((role) => ({ roleId: role.id, roleName: role.name, score: score(level, itemId, 'role', role.id) }))
      .filter((r) => r.score !== null);
  const self = score('questionnaire', null, 'self');
  const other = score('questionnaire', null, 'other');
  const parents = new Set(q.dimensions.map((d) => d.parentId).filter(Boolean));
  const basic = q.dimensions.filter((d) => !parents.has(d.id));
  const dims = basic.map((d) => ({
    dimensionId: d.id,
    name: d.name,
    definition: d.definition,
    self: score('dimension', d.id, 'self'),
    other: score('dimension', d.id, 'other'),
  }));
  const rated = dims.filter((d) => d.other !== null).sort((a, b) => b.other! - a.other!);
  const label = (roleId: string) => (template.showTextRole ? { roleName: roles.get(roleId)?.name ?? '' } : {});
  const { table, total } = relationTable(q, roles, invited, valid);
  return {
    questionnaireId: q.row.id,
    name: q.row.name,
    preface: {
      relationTable: table,
      total,
      scaleTable: q.options.map((o) => ({ label: o.label, value: o.notScored ? null : o.value })),
    },
    overview: {
      self,
      other,
      roles: roleScores('questionnaire', null),
      reference: await referenceOf(tx, batchId, q.row.id),
    },
    ...analysis(other, self, dims, rated, roleScores, basic, score),
    ...(await textAnswers(tx, q, valid, label)),
    details: [
      ...q.dimensions.map((d) => ({ itemId: d.id, name: d.name, level: 'dimension' })),
      ...q.questions.map((x) => ({ itemId: x.id, name: x.text, level: 'question' })),
    ].map((item) => ({
      ...item,
      self: score(item.level, item.itemId, 'self'),
      other: score(item.level, item.itemId, 'other'),
      roles: roleScores(item.level, item.itemId).map((r) => ({ roleName: r.roleName, score: r.score })),
    })),
  };
}

/** 生成一份评价对象的标准版报告内容（快照）。 */
export async function buildReport(
  tx: Tx,
  subject: ReportSubject,
  template: ReportTemplate,
  batchId: string,
  generatedAt: Date,
) {
  const roles = await rolesOf(tx);
  const ids = rows<{ questionnaire_id: string }>(
    await tx.execute(sql`SELECT questionnaire_id FROM survey360_object_questionnaires
      WHERE object_id = ${subject.objectId}::uuid ORDER BY id`),
  ).map((r) => r.questionnaire_id);
  const questionnaires = [];
  for (const id of ids) questionnaires.push(await questionnairePart(tx, subject, template, batchId, id, roles));
  return {
    cover: {
      activityName: subject.activityName,
      objectName: subject.objectName,
      department: subject.department,
      position: subject.position,
      templateName: template.name,
      generatedAt: generatedAt.toISOString(),
    },
    questionnaires,
    statement: STATEMENT,
  };
}
