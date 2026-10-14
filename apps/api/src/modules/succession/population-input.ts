/** #13 输入白名单；field 元信息仍由 B1 对照服务端目录复核。 */
import { RULE_OPERATORS, renderRuleFailureText, type RuleCompileError } from '@italent/domain';
import { z } from 'zod';
import { AppError } from '../../errors.js';

export const populationRules = z.strictObject({
  expression: z.string(),
  rows: z.array(
    z.strictObject({
      // 未引用行仍会落库，须与 PostgreSQL integer 同界，避免绕过表达式解析后返回 500。
      rowNo: z.number().int().max(2147483647),
      kind: z.literal('field'),
      field: z.strictObject({
        object: z.enum(['employee', 'employment', 'successor', 'review_object', 'org']),
        code: z.string(),
        path: z.string(),
        kind: z.enum(['text', 'number', 'option', 'multi_option', 'date', 'boolean']),
      }),
      operator: z.enum(RULE_OPERATORS),
      values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
  ),
});
export const populationBody = z.strictObject({
  code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  rules: populationRules,
});
export const populationPatch = populationBody.partial().refine((value) => Object.keys(value).length > 0);
export type PopulationBody = z.infer<typeof populationBody>;
export const colorBody = z.strictObject({ defaultColor: z.string().regex(/^#[0-9a-f]{6}$/i) });
export const ruleKind = z.enum(['position_risk', 'org_health']);

export function ruleErrors(errors: readonly RuleCompileError[]) {
  return errors.map((error) => ({
    code: error.code,
    ...(error.rowNo === undefined ? {} : { rowNo: error.rowNo }),
    ...(error.reason === undefined ? {} : { reason: error.reason }),
    ...(error.offset === undefined ? {} : { offset: error.offset }),
    text: renderRuleFailureText(
      error.reason === 'VALUE_TYPE' || error.reason === 'OPERATOR_INVALID' ? 'ARGUMENT_TYPE' : 'SYNTAX_ERROR',
      error.rowNo,
    ),
  }));
}
export function invalidRule(errors: readonly RuleCompileError[]): never {
  throw new AppError('VALIDATION_FAILED', '条件表达式出错', { reason: errors[0]?.code, errors: ruleErrors(errors) });
}
