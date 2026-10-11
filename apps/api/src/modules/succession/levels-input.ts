import { RULE_OPERATORS, type SuccessionLevelKind } from '@italent/domain';
import { z } from 'zod';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const commonRow = {
  rowNo: z.int().min(1).max(2147483647),
  fieldCode: z.string().nullable().default(null),
  filterOperator: z.enum(['is_empty', 'not_empty', 'eq', 'ne']).nullable().default(null),
  filterValues: z.array(z.union([z.string(), z.number(), z.boolean()])).default([]),
  comparator: z.enum(RULE_OPERATORS),
  threshold: z.number().nullable().default(null),
  thresholdHigh: z.number().nullable().default(null),
  isPercent: z.boolean().default(false),
};
const riskRow = z.strictObject({
  ...commonRow,
  subject: z.enum(['incumbent', 'successor']),
  measure: z.enum(['count', 'count_over_incumbents', 'count_over_successors']),
});
const healthRow = z
  .strictObject({
    ...commonRow,
    population: z.enum(['all', 'successors', 'incumbents', 'custom']),
    populationId: uuid.nullable().default(null),
    fieldSource: z.enum(['review', 'org', 'succession']),
    measure: z.enum([
      'green_rate',
      'review_result_ratio',
      'successor_count',
      'average',
      'ratio',
      'count',
      'count_over_successors',
      'count_over_incumbents',
    ]),
  })
  .refine((row) => (row.population === 'custom') === (row.populationId !== null));
export function levelSchemas(kind: SuccessionLevelKind) {
  const base = z.strictObject({
    code: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .transform((value) => value.toUpperCase()),
    description: z.string().max(2000).nullable(),
    enabled: z.boolean(),
    rules: z.strictObject({ expression: z.string(), rows: z.array(kind === 'risk' ? riskRow : healthRow) }).nullable(),
  });
  return {
    create: base.extend({
      description: base.shape.description.default(null),
      enabled: base.shape.enabled.default(true),
      rules: base.shape.rules.default(null),
    }),
    patch: base
      .omit({ code: true })
      .partial()
      .refine((value) => Object.keys(value).length > 0),
  };
}
export const levelOrder = z.strictObject({ ids: z.array(uuid).max(200) });
