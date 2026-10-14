/** B6：条件与明细随活动整份替换（同一命令事务），保存 / 回读保留文本和数字类型；设计 §3.2、EV-R10 / R11。 */
import { sql, type Tx } from '@italent/db';
import { validateActivityConditionDetails, validateActivityConditionExpression } from '@italent/domain';
import { AppError } from '../../errors.js';
import type { ConditionInput } from './condition-input.js';
import { rowsOf } from './store.js';

type Value = string | number | null;
export interface ConditionRecord {
  readonly kind: 'common' | 'extra';
  readonly applicantKind: 'self' | 'others';
  readonly categoryIds: string[];
  readonly levelIds: string[];
  readonly expression: string | null;
  readonly details: {
    readonly seq: number;
    readonly source: string;
    readonly field: string;
    readonly operator: string;
    readonly value1: Value;
    readonly value2: Value;
  }[];
}
const ids = (list: readonly string[]) => `{${list.join(',')}}`;
const unique = (list: readonly string[] | undefined) => [...new Set(list ?? [])];
const normalizeValue = (value: Value | undefined): Value =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '') ? null : value;
const valueType = (value: Value) => (value === null ? null : typeof value);

/** 错误定位只含提交的条件组下标 / 明细序号，不回显已有条件的字段和值。 */
export function prepareConditions(input: readonly ConditionInput[]): ConditionRecord[] {
  return input.map((condition, conditionIndex) => {
    const checked = validateActivityConditionDetails(condition.details);
    if (!checked.ok) {
      const inverted = checked.issues.some((issue) => issue.code === 'RANGE_INVERTED');
      throw new AppError(
        'VALIDATION_FAILED',
        inverted ? '条件范围开始不能晚于结束' : '请填写有效的参评条件值和运算符',
        {
          reason: 'CONDITION_DETAILS_INVALID',
          conditionIndex,
          issues: checked.issues,
        },
      );
    }
    if (condition.expression !== undefined && condition.expression !== null) {
      const expression = validateActivityConditionExpression(
        condition.expression,
        condition.details.map((d) => d.seq),
      );
      if (!expression.ok) {
        throw new AppError('VALIDATION_FAILED', '参评条件组合表达式无效，请检查语法和条件序号', {
          reason: 'CONDITION_EXPRESSION_INVALID',
          conditionIndex,
          errors: expression.errors,
        });
      }
    }
    return {
      kind: condition.kind,
      applicantKind: condition.applicantKind,
      categoryIds: unique(condition.categoryIds),
      levelIds: unique(condition.levelIds),
      expression: condition.expression ?? null,
      details: condition.details.map((detail) => ({
        ...detail,
        value1: normalizeValue(detail.value1),
        value2: normalizeValue(detail.value2),
      })),
    };
  });
}

interface ConditionRow {
  id: string;
  activity_id: string;
  kind: ConditionRecord['kind'];
  applicant_kind: ConditionRecord['applicantKind'];
  category_ids: string[];
  level_ids: string[];
  expression: string | null;
}
interface DetailRow {
  condition_id: string;
  seq: number;
  source: string;
  field: string;
  operator: string;
  value1: string | null;
  value2: string | null;
  value1_type: string | null;
  value2_type: string | null;
}
function decode(value: string | null, type: string | null): Value {
  if (value === null) return null;
  return type === 'number' ? Number(value) : value;
}

export async function loadConditions(tx: Tx, tenantId: string, activityIds: readonly string[]) {
  const result = new Map<string, ConditionRecord[]>();
  if (!activityIds.length) return result;
  const conditions = rowsOf<ConditionRow>(
    await tx.execute(sql`SELECT id, activity_id, kind, applicant_kind,
      category_ids, level_ids, expression FROM ev_conditions
    WHERE tenant_id = ${tenantId}::uuid AND activity_id = ANY(${ids(activityIds)}::uuid[])
    ORDER BY activity_id, seq`),
  );
  if (!conditions.length) return result;
  const details = rowsOf<DetailRow>(
    await tx.execute(sql`SELECT condition_id, seq, source, field, operator,
      value1, value2, value1_type, value2_type FROM ev_condition_details
    WHERE tenant_id = ${tenantId}::uuid AND condition_id = ANY(${ids(conditions.map((c) => c.id))}::uuid[])
    ORDER BY condition_id, position`),
  );
  for (const condition of conditions) {
    const group = result.get(condition.activity_id) ?? [];
    group.push({
      kind: condition.kind,
      applicantKind: condition.applicant_kind,
      categoryIds: condition.category_ids,
      levelIds: condition.level_ids,
      expression: condition.expression,
      details: details
        .filter((d) => d.condition_id === condition.id)
        .map((d) => ({
          seq: d.seq,
          source: d.source,
          field: d.field,
          operator: d.operator,
          value1: decode(d.value1, d.value1_type),
          value2: decode(d.value2, d.value2_type),
        })),
    });
    result.set(condition.activity_id, group);
  }
  return result;
}

export async function replaceConditions(
  tx: Tx,
  tenantId: string,
  activityId: string,
  conditions: readonly ConditionRecord[],
): Promise<void> {
  await tx.execute(
    sql`DELETE FROM ev_conditions WHERE tenant_id = ${tenantId}::uuid AND activity_id = ${activityId}::uuid`,
  );
  for (const [seq, condition] of conditions.entries()) {
    const result = await tx.execute(sql`INSERT INTO ev_conditions
        (tenant_id, activity_id, seq, kind, applicant_kind, category_ids, level_ids, expression)
      VALUES (${tenantId}, ${activityId}, ${seq}, ${condition.kind}, ${condition.applicantKind},
        ${ids(condition.categoryIds)}::uuid[], ${ids(condition.levelIds)}::uuid[],
        ${condition.expression}) RETURNING id`);
    const conditionId = rowsOf<{ id: string }>(result)[0]!.id;
    for (const [position, detail] of condition.details.entries()) {
      await tx.execute(sql`INSERT INTO ev_condition_details
          (tenant_id, condition_id, position, seq, source, field, operator, value1, value2, value1_type, value2_type)
        VALUES (${tenantId}, ${conditionId}, ${position}, ${detail.seq}, ${detail.source}, ${detail.field},
          ${detail.operator}, ${detail.value1 === null ? null : String(detail.value1)},
          ${detail.value2 === null ? null : String(detail.value2)},
          ${valueType(detail.value1)}, ${valueType(detail.value2)})`);
    }
  }
}
