import {
  CONDITION_OPERATORS,
  conditionViolations,
  type ConditionField,
  PERSONNEL_OBJECT,
  SUBSETS,
  type SubsetKind,
  subsetAttachmentFields,
} from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(120);
const field = z.strictObject({
  objectCode: z.string().min(1).max(120),
  fieldCode: z.string().min(1).max(120),
  group: z.string().trim().max(120).default(''),
  required: z.boolean().default(false),
  editable: z.boolean().default(true),
});

const profileFields = new Set(['name', 'email', 'idType', 'idNumber', 'mobilePhone', 'gender', 'birthday']);
const subsets = ['education', 'certificate'] as const satisfies readonly SubsetKind[];
const mappedSubsets = new Map<string, SubsetKind>(subsets.map((code) => [SUBSETS[code].objectCode, code]));

function templateFieldAllowed({ objectCode, fieldCode }: z.infer<typeof field>) {
  if (objectCode === PERSONNEL_OBJECT) return profileFields.has(fieldCode);
  const subset = mappedSubsets.get(objectCode);
  return (
    subset !== undefined &&
    !subsetAttachmentFields(subset).includes(fieldCode) &&
    SUBSETS[subset].fields.some((candidate) => candidate.code === fieldCode)
  );
}

export const templateBody = z.strictObject({
  name,
  enabled: z.boolean().default(true),
  noticeTitle: z.string().trim().min(1).max(200),
  noticeBody: z.string().trim().min(1).max(4000),
  fields: z.array(field).min(1).max(80),
});
export const settingsBody = z.strictObject({ enabled: z.boolean() });
export const ruleBody = z.strictObject({
  name,
  enabled: z.boolean().default(true),
  priority: z.int().min(0).max(999_999),
  templateId: uuid,
  orgIds: z.array(uuid).min(1).max(100),
  conditions: z
    .strictObject({
      items: z
        .array(
          z.strictObject({
            no: z.int().min(1).max(50),
            field: z.string().max(120),
            operator: z.enum(CONDITION_OPERATORS),
            value: z.union([z.string().max(200), z.array(z.string().max(200)).max(50), z.null()]),
          }),
        )
        .max(50),
      expression: z.string().max(300),
    })
    .default({ items: [], expression: '' }),
  verificationMode: z.enum(['independent_channel', 'phone_otp']).default('independent_channel'),
  requiredSubsets: z.array(z.enum(subsets)).max(subsets.length).default([]),
  requiresApproval: z.boolean().default(false),
  remindDaysBefore: z.int().min(1).max(365).nullable().default(null),
});

export const templatePatch = templateBody.extend({ enabled: templateBody.shape.enabled.unwrap() }).partial();
export const rulePatch = ruleBody
  .extend({
    enabled: ruleBody.shape.enabled.unwrap(),
    conditions: ruleBody.shape.conditions.unwrap(),
    verificationMode: ruleBody.shape.verificationMode.unwrap(),
    requiredSubsets: ruleBody.shape.requiredSubsets.unwrap(),
    requiresApproval: ruleBody.shape.requiresApproval.unwrap(),
    remindDaysBefore: ruleBody.shape.remindDaysBefore.unwrap(),
  })
  .partial();

export type TemplateInput = z.infer<typeof templateBody>;
export type RuleInput = z.infer<typeof ruleBody>;

/** R2-T01 §4.1 的匹配输入只取服务端已有列。配置项不接受表达式引擎调用或任意字段路径。 */
const CONDITION_FIELDS: readonly ConditionField[] = [
  { path: 'employee.gender', label: '性别', kind: 'text' },
  { path: 'employee.idType', label: '证件类型', kind: 'text' },
  { path: 'record.employType', label: '雇佣关系', kind: 'text' },
  { path: 'record.changeType', label: '变动类型', kind: 'text' },
  { path: 'contract.companyId', label: '合同公司', kind: 'reference' },
];

export function validateTemplate(input: TemplateInput) {
  const keys = input.fields.map(({ objectCode, fieldCode }) => `${objectCode}:${fieldCode}`);
  if (new Set(keys).size !== keys.length || !input.fields.every(templateFieldAllowed))
    throw new AppError('VALIDATION_FAILED', '采集模板字段重复或超出白名单');
}

function normalizeCompanyCondition(item: RuleInput['conditions']['items'][number], violations: string[]) {
  if (item.field !== 'contract.companyId' || item.value === null) return item;
  const parsed = Array.isArray(item.value) ? z.array(uuid).safeParse(item.value) : uuid.safeParse(item.value);
  if (parsed.success) return { ...item, value: parsed.data };
  violations.push('合同公司条件须使用 UUID');
  return item;
}

export function validateAndNormalizeRule(input: RuleInput): RuleInput {
  const violations = conditionViolations(input.conditions, CONDITION_FIELDS);
  const items = input.conditions.items.map((item) => normalizeCompanyCondition(item, violations));
  if (violations.length) throw new AppError('VALIDATION_FAILED', '采集规则条件不合法', { reasons: violations });
  if (
    new Set(input.orgIds).size !== input.orgIds.length ||
    new Set(input.requiredSubsets).size !== input.requiredSubsets.length
  )
    throw new AppError('VALIDATION_FAILED', '采集规则的组织或必填子集重复');
  return { ...input, conditions: { ...input.conditions, items } };
}

export function validateRequiredSubsets(
  input: { requiredSubsets: readonly string[] },
  fields: ReadonlyArray<{ objectCode: string; editable: boolean }>,
) {
  if (
    input.requiredSubsets.some(
      (code) => !fields.some((f) => f.editable && f.objectCode === SUBSETS[code as SubsetKind]?.objectCode),
    )
  )
    throw new AppError('VALIDATION_FAILED', '必填子集须包含至少一个可编辑的模板字段');
}
