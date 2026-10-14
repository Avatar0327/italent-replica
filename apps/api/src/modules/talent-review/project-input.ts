/** 项目定义（设计 §2.4）：业务日期直接保存 YYYY-MM-DD，不经浏览器时区换算；状态与计算派生列不接收输入。 */
import { z } from 'zod';

const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(50);
// PostgreSQL date 无零年；年度用 int32，与落库列一致，避免合法 JSON 落成数据库 500。
const date = z.iso.date().refine((value) => !value.startsWith('0000-'), '业务日期不支持零年');
const uniqueIds = z
  .array(uuid)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, '不能重复选择');
const matrix = z.strictObject({
  matrixId: uuid,
  ratioGroupId: uuid.nullable().optional(),
  sortNo: z.int().min(0).max(1_000_000).optional(),
});
const calibration = z.strictObject({ fieldId: uuid, required: z.boolean().default(false) });
export const projectCreate = z.strictObject({
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/),
  name,
  categoryId: uuid.nullable().optional(),
  ownerOrgId: uuid,
  downwardPublic: z.boolean().optional(),
  year: z.int32(),
  period: name,
  periodStartDate: date,
  periodEndDate: date,
  businessDate: date.nullable().optional(),
  criterionId: uuid.nullable().optional(),
  calcRuleId: uuid.nullable().optional(),
  carryLastResult: z.boolean().optional(),
  sharedOrgIds: uniqueIds.optional(),
  excludedCategoryIds: uniqueIds.optional(),
  matrices: z
    .array(matrix)
    .max(500)
    .refine((xs) => new Set(xs.map((x) => x.matrixId)).size === xs.length, '九宫格重复')
    .optional(),
  calibrationFields: z
    .array(calibration)
    .max(500)
    .refine((xs) => new Set(xs.map((x) => x.fieldId)).size === xs.length, '校准字段重复')
    .optional(),
});
export const projectPatch = projectCreate.omit({ code: true }).partial();
export const projectActionBody = z.strictObject({});
export type ProjectInput = z.output<typeof projectCreate>;
export type ProjectPatch = z.output<typeof projectPatch>;
