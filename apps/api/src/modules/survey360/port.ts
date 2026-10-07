/**
 * Lastest360Cent 的真实数据源（R3-T00 端口 Survey360Port；`26` §3.5 TR-R28、§8.1）。
 * 使用方（盘点、继任等）按批次预读：传入本次计算的员工与查看人对员工的数据范围，返回同步读取器。
 * - 员工 → 挂接的 360 人员（DEC-030：换挂邮箱不换人员，历史结果仍归属该人，AC-360-12）；
 * - “最近一次”按 DEC-262：只取**已结束（停用）且该对象的报告已生成**的活动（报告生成时间不早于本次结束时间），
 *   进行中或重新启用的活动不计；按结束时间倒序，结束时间相同按报告生成时间倒序。引擎按记录的 startAt 取最近，
 *   故 startAt 填活动结束时间，同一结束时间的记录按报告生成时间倒序排在前面（引擎取同值中第一个有分的）；
 *   R3-T00 的“盘点项目结束时间前”边界同样作用于结束时间。PR-A 尚无报告生成能力，端口按资格条件返回空；
 * - 用最新计分批次；已删除活动、已移除的评价对象不返回；
 * - 只有聚合分（问卷 / 维度 / 题目 × 自评 / 他评 / 角色），没有任何评价者标识与逐人分数；
 * - 查看人范围外、或未预读的员工返回 forbidden（不回落为“无数据”）。空值语义以 semantics.ts 为准（本任务不改）。
 */
import { sql, type Tx } from '@italent/db';
import { type Survey360Port, type Survey360Record, survey360 } from '@italent/domain';
import { type ModuleScope, scopeSql } from '../permission/module-access.js';
import { rows } from './context.js';

const F = survey360.SURVEY360_FIELDS;
/** 每条记录都带齐全部字段（不适用的为空）：过滤表达式引用到记录里没有的键会报“找不到字段”。 */
const EMPTY_RECORD: Readonly<Record<string, null>> = Object.fromEntries(Object.values(F).map((k) => [k, null]));

interface ScoreRow {
  employee_id: string;
  activity_id: string;
  activity_name: string;
  ended_at: Date | string;
  questionnaire_id: string;
  questionnaire_name: string;
  level: 'questionnaire' | 'dimension' | 'question';
  item_id: string | null;
  item_name: string | null;
  scope: 'self' | 'other' | 'role';
  role_name: string | null;
  score: number | null;
}

export interface Survey360PortInput {
  readonly tenantId: string;
  readonly employeeIds: readonly string[];
  /** 查看人对员工的数据范围（使用方按自己的对象解析，如盘点对象）。 */
  readonly scope: ModuleScope;
}

/** 一个员工的 360 记录：每个活动 × 套卷先给问卷级（总分、各角色分），再给维度级、题目级。 */
function recordsOf(scores: readonly ScoreRow[]): Survey360Record[] {
  const groups = new Map<string, ScoreRow[]>();
  for (const s of scores) {
    const key = `${s.activity_id}|${s.questionnaire_id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const records: Survey360Record[] = [];
  for (const group of groups.values()) {
    const first = group[0]!;
    const startAt = first.ended_at instanceof Date ? first.ended_at : new Date(first.ended_at);
    const base = {
      ...EMPTY_RECORD,
      [F.activityName]: first.activity_name,
      [F.questionnaireName]: first.questionnaire_name,
    };
    const pick = (level: string, scope: string, itemId: string | null = null) =>
      group.find((s) => s.level === level && s.scope === scope && s.item_id === itemId)?.score ?? null;
    const totals = { [F.selfTotal]: pick('questionnaire', 'self'), [F.otherTotal]: pick('questionnaire', 'other') };
    records.push({ fields: { ...base, ...totals }, startAt });
    for (const role of group.filter((s) => s.level === 'questionnaire' && s.scope === 'role'))
      records.push({
        fields: { ...base, ...totals, [F.roleName]: role.role_name, [F.roleScore]: role.score },
        startAt,
      });
    for (const level of ['dimension', 'question'] as const) {
      const [nameKey, selfKey, otherKey] =
        level === 'dimension'
          ? [F.dimensionName, F.dimensionSelf, F.dimensionOther]
          : [F.questionName, F.questionSelf, F.questionOther];
      const items = new Map(group.filter((s) => s.level === level).map((s) => [s.item_id!, s.item_name]));
      for (const [itemId, name] of items) {
        const item = {
          ...base,
          [nameKey]: name,
          [selfKey]: pick(level, 'self', itemId),
          [otherKey]: pick(level, 'other', itemId),
        };
        records.push({ fields: item, startAt });
        for (const role of group.filter((s) => s.level === level && s.scope === 'role' && s.item_id === itemId))
          records.push({ fields: { ...item, [F.roleName]: role.role_name, [F.roleScore]: role.score }, startAt });
      }
    }
  }
  return records;
}

export async function loadSurvey360Port(tx: Tx, input: Survey360PortInput): Promise<Survey360Port> {
  const ids = [...new Set(input.employeeIds.map((id) => id.toLowerCase()))];
  const allowed = new Set(
    ids.length
      ? rows<{ id: string }>(
          await tx.execute(sql`SELECT e.id FROM employment_employees e
            WHERE e.id = ANY(${`{${ids.join(',')}}`}::uuid[]) AND ${scopeSql(input.scope, { person: sql`e.id` })}`),
        ).map((r) => r.id)
      : [],
  );
  const visible = [...allowed];
  const scores = visible.length
    ? rows<ScoreRow>(
        await tx.execute(sql`SELECT p.employee_id, a.id AS activity_id, a.name AS activity_name, a.ended_at,
            q.id AS questionnaire_id, q.name AS questionnaire_name, sc.level, sc.item_id,
            COALESCE(d.name, qu.text) AS item_name, sc.scope, ro.name AS role_name, sc.score
          FROM survey360_people p
          JOIN survey360_objects o ON o.tenant_id = p.tenant_id AND o.person_id = p.id AND NOT o.removed
          JOIN survey360_activities a ON a.tenant_id = o.tenant_id AND a.id = o.activity_id AND NOT a.deleted
            AND a.status = 'disabled' AND a.ended_at IS NOT NULL AND a.score_batch_id IS NOT NULL
            AND o.report_generated_at IS NOT NULL AND o.report_generated_at >= a.ended_at
          JOIN survey360_scores sc ON sc.tenant_id = a.tenant_id AND sc.batch_id = a.score_batch_id
            AND sc.object_id = o.id
          JOIN survey360_questionnaires q ON q.tenant_id = sc.tenant_id AND q.id = sc.questionnaire_id
          LEFT JOIN survey360_dimensions d ON sc.level = 'dimension' AND d.tenant_id = sc.tenant_id
            AND d.id = sc.item_id
          LEFT JOIN survey360_questions qu ON sc.level = 'question' AND qu.tenant_id = sc.tenant_id
            AND qu.id = sc.item_id
          LEFT JOIN survey360_roles ro ON ro.tenant_id = sc.tenant_id AND ro.id = sc.role_id
          WHERE p.employee_id = ANY(${`{${visible.join(',')}}`}::uuid[])
          ORDER BY a.ended_at DESC, o.report_generated_at DESC, a.id, q.id, ro.sort NULLS FIRST`),
      )
    : [];
  const byEmployee = new Map<string, ScoreRow[]>();
  for (const s of scores) byEmployee.set(s.employee_id, [...(byEmployee.get(s.employee_id) ?? []), s]);
  const records = new Map(visible.map((id) => [id, recordsOf(byEmployee.get(id) ?? [])]));
  return {
    records(subjectId) {
      const data = records.get(subjectId.toLowerCase());
      return data ? { ok: true, data } : { ok: false, reason: 'forbidden' };
    },
  };
}
