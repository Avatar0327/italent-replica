/** F-326 §2：HTTP 形态与候选态校验。类型、文本、编码和状态规则复用 S1。 */
import { isDeepStrictEqual } from 'node:util';
import {
  APP_IDS,
  defaultValueViolation,
  textViolation,
  usageScopesViolation,
  variableCodeViolation,
  VARIABLE_DATA_TYPES,
  VARIABLE_SCOPES,
  VARIABLE_TEXT_FIELDS,
  VARIABLE_USAGE_SCOPES,
  type VariableDataType,
  type VariableScope,
} from '@italent/domain';
import { z } from 'zod';
import { approvalError, canonicalId } from './context.js';

const editable = {
  name: z.string(),
  defaultValue: z.unknown(),
  usageScopes: z.array(z.enum(VARIABLE_USAGE_SCOPES)),
  description: z.string().nullable(),
};
export const createVariableSchema = z.strictObject({
  scope: z.enum(VARIABLE_SCOPES),
  appId: z.enum(APP_IDS).nullable().optional(),
  codeSuffix: z.string(),
  dataType: z.enum(VARIABLE_DATA_TYPES),
  name: editable.name,
  defaultValue: editable.defaultValue.optional(),
  usageScopes: editable.usageScopes.optional(),
  description: editable.description.optional(),
  enable: z.boolean().default(false),
});
export const updateVariableSchema = z
  .strictObject({
    ...editable,
    code: z.string(),
    scope: z.enum(VARIABLE_SCOPES),
    appId: z.enum(APP_IDS).nullable(),
    dataType: z.enum(VARIABLE_DATA_TYPES),
  })
  .partial();
export const variableCommandSchema = z.strictObject({});
export const variableQuerySchema = z
  .object({
    scope: z.enum(VARIABLE_SCOPES),
    appId: z.enum(APP_IDS).optional(),
    status: z.enum(['active', 'disabled']).default('active'),
    q: z.string().default(''),
    offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((query) => query.scope !== 'application' || query.appId !== undefined);
export type CreateVariableInput = z.infer<typeof createVariableSchema>;
export type UpdateVariableInput = z.infer<typeof updateVariableSchema>;
export type VariableQuery = z.infer<typeof variableQuerySchema>;

export interface VariableValues {
  scope: VariableScope;
  appId: string | null;
  code: string;
  name: string;
  dataType: VariableDataType;
  defaultValue: unknown;
  usageScopes: string[];
  description: string | null;
}

function invalid(reason: string): never {
  throw approvalError('VALIDATION_FAILED', reason, '变量字段不合法');
}

export function checkVariableCode(input: CreateVariableInput): void {
  const reason = variableCodeViolation(input.scope, input.codeSuffix);
  if (reason) invalid(reason);
}

/** 人员 UUID 先规范化再检查重复，使大小写不同的同一账号不能占两个位置。 */
function normalizedDefault(dataType: VariableDataType, value: unknown): unknown {
  if (dataType === 'person' && typeof value === 'string') return canonicalId(value);
  if (dataType === 'persons' && Array.isArray(value))
    return value.map((id: unknown) => (typeof id === 'string' ? canonicalId(id) : id));
  return value ?? null;
}

export function validateVariableValues(value: VariableValues, previous?: VariableValues): VariableValues {
  const nameError = textViolation(value.name, VARIABLE_TEXT_FIELDS.variableName);
  if (nameError) invalid(nameError);
  const name = value.name.trim();
  if (!name) invalid('VARIABLE_NAME_REQUIRED');
  let defaultValue = normalizedDefault(value.dataType, value.defaultValue);
  // F-326 §2.3 / §2.5：UTC 转换可能产生扩展年份，原样回传的已验证值仍须允许编辑。
  if (!previous || !isDeepStrictEqual(defaultValue, previous.defaultValue)) {
    const defaultError = defaultValueViolation(value.dataType, defaultValue);
    if (defaultError) invalid(defaultError);
    if (value.dataType === 'datetime' && typeof defaultValue === 'string')
      defaultValue = new Date(defaultValue).toISOString();
  }
  if (value.description !== null) {
    const reason = textViolation(value.description, VARIABLE_TEXT_FIELDS.variableDescription);
    if (reason) invalid(reason);
  }
  if (value.scope === 'public') {
    if (value.appId !== null) invalid('VARIABLE_APP_INVALID');
    const reason = usageScopesViolation(value.usageScopes);
    if (reason) invalid(reason);
  } else if (!value.appId || value.usageScopes.length || value.description !== null) {
    invalid('VARIABLE_APPLICATION_FIELDS_INVALID');
  }
  return { ...value, name, defaultValue };
}

export function variablePersonIds(value: Pick<VariableValues, 'dataType' | 'defaultValue'>): string[] {
  if (value.defaultValue === null) return [];
  if (value.dataType === 'person') return [value.defaultValue as string];
  return value.dataType === 'persons' ? (value.defaultValue as string[]) : [];
}
