import {
  MATRIX_DIMENSIONS,
  MATRIX_LIMITS,
  matrixCodeViolation,
  textViolation,
  VARIABLE_TEXT_FIELDS,
} from '@italent/domain';
import { z } from 'zod';
import { approvalError, canonicalId } from './context.js';

export function matrixInvalid(reason: string, message: string): never {
  throw approvalError('VALIDATION_FAILED', reason, message);
}

const uuid = z.uuid().transform(canonicalId);
const revision = z.number().int().min(1).max(2147483646);
const text = (rule: keyof typeof VARIABLE_TEXT_FIELDS, required = false) =>
  z.string().transform((input) => {
    const value = required ? input.trim() : input;
    const violation = textViolation(input, VARIABLE_TEXT_FIELDS[rule]);
    if (violation) matrixInvalid(violation, '矩阵文本字段不合法');
    if (required && !value) matrixInvalid('TEXT_REQUIRED', '名称不能为空');
    return value;
  });
const head = {
  name: text('matrixName', true),
  description: text('matrixDescription').nullable().optional(),
};
export const matrixCreateSchema = z.strictObject({
  ...head,
  code: z.string().transform((code) => {
    const violation = matrixCodeViolation(code);
    if (violation) matrixInvalid(violation, '矩阵编码须为 1 至 64 位字母、数字或下划线');
    return code;
  }),
  enable: z.boolean().default(false),
});
export const matrixUpdateSchema = z.strictObject({ ...head, name: head.name.optional(), revision });
export const matrixStatusSchema = z.strictObject({
  revision,
  acknowledgedReferenceCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
export const matrixListSchema = z.object({
  status: z.enum(['active', 'disabled']).default('active'),
  q: z.string().trim().max(100).default(''),
  offset: z.coerce.number().int().min(0).max(2147483647).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const columnSchema = z.strictObject({
  id: uuid.optional(),
  key: z.string().regex(/^[a-z][a-z0-9]{0,3}$/),
  kind: z.enum(['condition', 'role']),
  dimension: z.enum(MATRIX_DIMENSIONS).nullable().optional(),
  includeChildren: z.boolean().default(false),
  name: text('matrixColumnName', true),
  allowMultiple: z.boolean().default(false),
});
export const matrixStructureSchema = z.strictObject({
  revision,
  columns: z.array(columnSchema),
  rows: z.array(z.strictObject({ id: uuid.optional(), cells: z.record(z.string(), z.array(uuid)) })),
});
export type MatrixStructureInput = z.infer<typeof matrixStructureSchema>;

function unique(values: readonly string[], reason: string) {
  if (new Set(values).size !== values.length) matrixInvalid(reason, '矩阵列名、短键与行列标识不能重复');
}
function maximum(actual: number, max: number, reason: string) {
  if (actual > max) matrixInvalid(reason, '矩阵结构超过上限');
}

/** 设计 §2.1 / §4.2：统一校验改后完整结构，空矩阵和空格合法。 */
export function validateMatrixStructure(input: MatrixStructureInput) {
  const { columns, rows } = input;
  maximum(
    columns.filter((c) => c.kind === 'condition').length,
    MATRIX_LIMITS.conditionColumns,
    'CONDITION_COLUMNS_LIMIT',
  );
  maximum(columns.filter((c) => c.kind === 'role').length, MATRIX_LIMITS.roleColumns, 'ROLE_COLUMNS_LIMIT');
  maximum(rows.length, MATRIX_LIMITS.rows, 'ROWS_LIMIT');
  unique(
    columns.map((c) => c.name),
    'COLUMN_NAME_DUPLICATE',
  );
  unique(
    columns.map((c) => c.key),
    'COLUMN_KEY_DUPLICATE',
  );
  unique(
    columns.flatMap((c) => (c.id ? [c.id] : [])),
    'COLUMN_ID_DUPLICATE',
  );
  unique(
    rows.flatMap((r) => (r.id ? [r.id] : [])),
    'ROW_ID_DUPLICATE',
  );
  for (const column of columns) {
    if ((column.kind === 'condition' && !column.dimension) || (column.kind === 'role' && column.dimension))
      matrixInvalid('COLUMN_DIMENSION_INVALID', '条件列必须指定维度，角色列不含维度');
    if (column.includeChildren && column.dimension !== 'department')
      matrixInvalid('COLUMN_CHILDREN_INVALID', '只有部门条件列可以包含下级');
    if (column.allowMultiple && column.kind !== 'role')
      matrixInvalid('COLUMN_MULTIPLE_INVALID', '只有角色列可以允许多人');
  }
  const byKey = new Map(columns.map((c) => [c.key, c]));
  let total = 0;
  for (const row of rows) {
    for (const [key, ids] of Object.entries(row.cells)) {
      const column = byKey.get(key);
      if (!column) matrixInvalid('CELL_COLUMN_UNKNOWN', '单元格引用了本次结构中不存在的列');
      const max = column.kind === 'condition' ? MATRIX_LIMITS.conditionCellIds : MATRIX_LIMITS.roleCellIds;
      maximum(ids.length, max, column.kind === 'condition' ? 'CONDITION_CELL_LIMIT' : 'ROLE_CELL_LIMIT');
      if (column.kind === 'role' && !column.allowMultiple && new Set(ids).size > 1)
        matrixInvalid('ROLE_SINGLE_PERSON', '单人角色列不能配置多人');
      total += ids.length;
    }
  }
  maximum(total, MATRIX_LIMITS.totalCellIds, 'TOTAL_CELL_IDS_LIMIT');
}
