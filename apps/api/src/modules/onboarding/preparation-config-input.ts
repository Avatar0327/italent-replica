import { preparationCategories } from '@italent/db';
import { conditionViolations, type ConditionField } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { ruleBody } from './collection-config-input.js';

const name = z.string().trim().min(1).max(120);
const code = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,79}$/i);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const formField = z.strictObject({
  code,
  label: name,
  required: z.boolean(),
  writeback: z.enum(['employee.code', 'employee.workEmail']).optional(),
});

export const preparationItemBody = z.strictObject({
  category: z.enum(preparationCategories),
  code,
  name,
  enabled: z.boolean(),
  fields: z.array(formField).max(40),
});
const selector = z.union([
  z.strictObject({ kind: z.enum(['member', 'position', 'post', 'identity']), id: uuid }),
  z.strictObject({ kind: z.enum(['direct_manager', 'department_head', 'hrbp']) }),
]);
const days = z.int().min(1).max(365).nullable();
export const preparationRuleBody = z.strictObject({
  name,
  enabled: z.boolean(),
  itemId: uuid,
  orgIds: z.array(uuid).min(1).max(100),
  priority: z.int().min(0).max(999_999),
  conditions: ruleBody.shape.conditions.unwrap(),
  startDaysBefore: days,
  remindDaysBefore: days,
  assignees: z.array(selector).min(1).max(50),
});
export const preparationItemCreate = preparationItemBody.extend({ enabled: z.boolean().default(true) });
export const preparationRuleCreate = preparationRuleBody.extend({
  enabled: z.boolean().default(true),
  conditions: preparationRuleBody.shape.conditions.default({ items: [], expression: '' }),
  startDaysBefore: days.default(null),
  remindDaysBefore: days.default(null),
});

export type ItemInput = z.infer<typeof preparationItemBody>;
export type RuleInput = z.infer<typeof preparationRuleBody>;

const conditionFields: readonly ConditionField[] = [
  { path: 'employee.gender', label: '性别', kind: 'text' },
  { path: 'employee.idType', label: '证件类型', kind: 'text' },
  { path: 'record.employType', label: '雇佣关系', kind: 'text' },
  { path: 'record.changeType', label: '变动类型', kind: 'text' },
  { path: 'contract.companyId', label: '合同公司', kind: 'reference' },
];

export function validatePreparationItem(input: ItemInput) {
  const mappings = input.fields.flatMap(({ writeback }) => (writeback ? [writeback] : []));
  const allowed = { employee_code: 'employee.code', work_email: 'employee.workEmail', other: undefined };
  if (
    new Set(input.fields.map(({ code }) => code)).size !== input.fields.length ||
    mappings.length > 1 ||
    mappings.some((mapping) => mapping !== allowed[input.category])
  )
    throw new AppError('VALIDATION_FAILED', '准备表单字段重复或回写超出对应类别白名单');
}

export function validatePreparationRule(input: RuleInput): RuleInput {
  const orgs = new Set(input.orgIds);
  const selectors = new Set(input.assignees.map((row) => `${row.kind}:${'id' in row ? row.id : ''}`));
  const violations = conditionViolations(input.conditions, conditionFields);
  const items = input.conditions.items.map((item) => {
    if (item.field !== 'contract.companyId' || item.value === null) return item;
    const parsed = Array.isArray(item.value) ? z.array(uuid).safeParse(item.value) : uuid.safeParse(item.value);
    if (!parsed.success) violations.push('合同公司条件须使用 UUID');
    return parsed.success ? { ...item, value: parsed.data } : item;
  });
  if (orgs.size !== input.orgIds.length || selectors.size !== input.assignees.length || violations.length)
    throw new AppError('VALIDATION_FAILED', '准备规则范围、办理人或条件不合法', { reasons: violations });
  return { ...input, conditions: { ...input.conditions, items } };
}
