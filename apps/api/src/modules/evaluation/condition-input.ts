/** B6：来源与字段存标识，明细形状与组合式由 B2 校验；不在保存时取员工值（设计 §3.2 / §7.1）。 */
import { z } from 'zod';
const uuid = z.uuid().transform((value) => value.toLowerCase());
const value = z.union([z.string(), z.number()]).nullable().optional();
const detail = z.strictObject({
  seq: z.number().min(-2_147_483_648).max(2_147_483_647),
  source: z.string().trim().min(1),
  field: z.string().trim().min(1),
  operator: z.string(),
  value1: value,
  value2: value,
});
const condition = z.strictObject({
  kind: z.enum(['common', 'extra']),
  applicantKind: z.enum(['self', 'others']),
  categoryIds: z.array(uuid).optional(),
  levelIds: z.array(uuid).optional(),
  expression: z.string().nullable().optional(),
  details: z.array(detail),
});
export const activityConditions = z.array(condition);
export type ConditionInput = z.infer<typeof condition>;
