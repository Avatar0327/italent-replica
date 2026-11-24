import {
  RETIREMENT_CONDITION_FIELDS,
  STATUTORY_FUNCTIONS,
  type RetirementCondition,
  type RetirementRulePurpose,
  type RetirementRuleType,
} from '@italent/domain';
import { fieldAccess, type ObjectPermission } from '../../foundation/permission-model.js';
import { projectFields, type Values } from '../../foundation/forms/values.js';
import { s } from './messages.js';

const employment = '/api/tenant/employment';
export const rulesPath = `${employment}/retirement-rules`;
export const listPath = (purpose: RetirementRulePurpose) => `${rulesPath}?purpose=${purpose}`;
export const settingsObject = 'TenantBase.EmploymentSettings';
export const conditionPaths = {
  identityType: { path: `${employment}/retirement-identity-types`, key: 'code' },
  employmentForm: { path: `${employment}/employment-forms`, key: 'code' },
  employmentType: { path: `${employment}/employment-types/options`, key: 'id' },
} as const;

const commonFields = ['name', 'priority', 'orgIds', 'includeSubordinates', 'enabled'] as const;
const ageFields = ['retirementAgeYears', 'retirementAgeMonths'] as const;
export const functionFields = ['expectedFunction', 'earliestFunction', 'latestFunction'] as const;

// parseRetirementRule 为两类规则补齐函数与年龄键，授权器按解析后的整份载荷验权（F-536）。
const saveFields = ['purpose', 'ruleType', ...commonFields, ...ageFields, ...functionFields, 'conditions'] as const;

export type Rule = {
  id: string;
  purpose: RetirementRulePurpose;
  ruleType: RetirementRuleType;
  name: string;
  priority: number;
  orgIds: string[];
  allOrgs: boolean;
  preset: boolean;
  includeSubordinates: boolean;
  retirementAgeYears: number | null;
  retirementAgeMonths: number | null;
  expectedFunction: string | null;
  earliestFunction: string | null;
  latestFunction: string | null;
  conditions: RetirementCondition[];
  enabled: boolean;
  revision: number;
};

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((part) => typeof part === 'string');
function isCondition(condition: unknown): condition is RetirementCondition {
  const item = condition as Partial<RetirementCondition> | null;
  return (
    !!item &&
    item.operator === 'in' &&
    RETIREMENT_CONDITION_FIELDS.some((field) => field === item.fieldCode) &&
    strings(item.values)
  );
}
type RuleReceipt = Omit<Rule, 'allOrgs' | 'preset'> & Partial<Pick<Rule, 'allOrgs' | 'preset'>>;
// 写回执经过任职字段裁剪，allOrgs / preset 只由规则列表提供。
function isRuleReceipt(raw: unknown, purpose: RetirementRulePurpose): raw is RuleReceipt {
  const row = raw as Partial<Rule> | null;
  return (
    !!row &&
    typeof row.id === 'string' &&
    row.id !== '' &&
    Number.isSafeInteger(row.revision) &&
    (row.revision ?? -1) >= 0 &&
    row.purpose === purpose &&
    typeof row.name === 'string' &&
    Number.isInteger(row.priority) &&
    strings(row.orgIds) &&
    typeof row.includeSubordinates === 'boolean' &&
    typeof row.enabled === 'boolean' &&
    Array.isArray(row.conditions) &&
    row.conditions.every(isCondition) &&
    (row.ruleType === 'fixed_age'
      ? purpose === 'expected_date' &&
        Number.isInteger(row.retirementAgeYears) &&
        Number.isInteger(row.retirementAgeMonths)
      : row.ruleType === 'builtin' && functionsFor(purpose).every((key) => typeof row[key] === 'string'))
  );
}
export function parseRules(raw: unknown, purpose: RetirementRulePurpose): Rule[] {
  const items = (raw as { items?: unknown } | null)?.items;
  const isListRow = (row: unknown): row is Rule =>
    isRuleReceipt(row, purpose) && typeof row.allOrgs === 'boolean' && typeof row.preset === 'boolean';
  if (!Array.isArray(items) || !items.every(isListRow)) throw new Error(s.invalidList);
  return items;
}
export function saveReceipt(
  raw: unknown,
  purpose: RetirementRulePurpose,
  sent: number | undefined,
  expected: { id?: string; copiedFrom?: string; enabled?: boolean } = {},
) {
  if (
    !isRuleReceipt(raw, purpose) ||
    sent === undefined ||
    raw.revision !== sent + 1 ||
    (expected.id && raw.id !== expected.id) ||
    (expected.copiedFrom && (raw.id === expected.copiedFrom || raw.preset)) ||
    (expected.enabled !== undefined && raw.enabled !== expected.enabled)
  )
    throw new Error(s.invalidReceipt);
  return { id: raw.id };
}

export const functionsFor = (purpose: RetirementRulePurpose) =>
  purpose === 'expected_date' ? (['expectedFunction'] as const) : (['earliestFunction', 'latestFunction'] as const);
export const typeFor = (purpose: RetirementRulePurpose, row?: Rule): RetirementRuleType =>
  row?.ruleType ?? (purpose === 'expected_date' ? 'fixed_age' : 'builtin');

export function formValues(purpose: RetirementRulePurpose, row?: Rule): Values {
  if (!row)
    return {
      includeSubordinates: true,
      enabled: true,
      ...(purpose === 'expected_date'
        ? { retirementAgeMonths: 0 }
        : { earliestFunction: STATUTORY_FUNCTIONS.earliest, latestFunction: STATUTORY_FUNCTIONS.latest }),
    };
  return {
    ...projectFields(row, [...commonFields, ...ageFields, ...functionFields]),
    ...Object.fromEntries(row.conditions.map(({ fieldCode, values }) => [fieldCode, values])),
  };
}

/** PUT 整份替换。内核的 edited 只覆盖用户改过的字段，其余取重读得到的最新值。 */
export function ruleBody(purpose: RetirementRulePurpose, ruleType: RetirementRuleType, values: Values): Values {
  const fields = ruleType === 'fixed_age' ? ageFields : functionsFor(purpose);
  const conditions = RETIREMENT_CONDITION_FIELDS.flatMap((fieldCode) => {
    const selected = values[fieldCode];
    return strings(selected) && selected.length ? [{ fieldCode, operator: 'in', values: selected }] : [];
  });
  return {
    ...projectFields(values, commonFields),
    ...projectFields(values, fields),
    name: typeof values.name === 'string' ? values.name.trim() : values.name,
    purpose,
    ruleType,
    conditions,
  };
}

export function ruleAccess(permission: ObjectPermission | undefined, admin: boolean) {
  const detail = admin && !permission?.summary ? permission : undefined;
  const all = saveFields.every((field) => fieldAccess(detail, field).editable);
  const create = detail?.dataOperations.create === true;
  const update = detail?.dataOperations.update === true;
  return {
    create: create && all,
    edit: update && all,
    copy: create,
    toggle: update && fieldAccess(detail, 'enabled').editable,
    // 配置对象没有删除操作，规则 DELETE 复用 update 入口。
    remove: update,
  };
}
export type RuleAccess = ReturnType<typeof ruleAccess>;
