/**
 * 人才标准各接口的请求结构（只做结构校验，不读库）。严格对象：未登记的键（含不可修改的 指标库类型、
 * 指标所属指标库）一律 400。明细数组设上限（AGENTS §10「批量」）。
 */
import { TALENT_DIMENSION_TYPES } from '@italent/domain';
import { z } from 'zod';

// DEC-194：与 F-017 同一口径，UUID 一律按小写规范化（路径参数由 uuidParam 规范化）。
export const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(200);
const note = z.string().trim().max(4000).nullable();
const shortText = z.string().trim().max(200).nullable();
const order = z.int().min(0).max(1_000_000);

export const MAX_DETAILS = 50;
export const MAX_CRITERION_DIMENSIONS = 200;

const grade = z.strictObject({
  gradeOrder: z.int().min(1).max(99),
  alias: shortText.optional(),
  description: note.optional(),
});
const behavior = z.strictObject({
  description: z.string().trim().min(1).max(4000),
  keyPoints: note.optional(),
  displayOrder: order.optional(),
});
// TODO(需取证 #103): 发展建议“类型”的可选值未取证，暂按自由文本。
const suggestion = z.strictObject({
  suggestionType: shortText.optional(),
  description: z.string().trim().min(1).max(4000),
  displayOrder: order.optional(),
});
const question = z.strictObject({
  question: z.string().trim().min(1).max(4000),
  keyPoints: note.optional(),
  displayOrder: order.optional(),
});

export const libraryCreate = z.strictObject({
  name,
  type: z.enum(TALENT_DIMENSION_TYPES),
  enabled: z.boolean().optional(),
  displayOrder: order.optional(),
});
export const libraryPatch = libraryCreate.omit({ type: true }).partial();

// TODO(需取证 #103): 指标库内分类的形态、编码唯一范围未取证，暂按指标上的文本分类、租户内唯一编码。
const dimensionFields = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_.-]+$/),
  name,
  definition: note.optional(),
  category: shortText.optional(),
  displayOrder: order.optional(),
  enabled: z.boolean().optional(),
  grades: z
    .array(grade)
    .max(MAX_DETAILS)
    .refine((items) => new Set(items.map((item) => item.gradeOrder)).size === items.length, '等级顺序不能重复')
    .optional(),
  behaviors: z.array(behavior).max(MAX_DETAILS).optional(),
  suggestions: z.array(suggestion).max(MAX_DETAILS).optional(),
  questions: z.array(question).max(MAX_DETAILS).optional(),
};
export const dimensionCreate = z.strictObject({ libraryId: uuid, ...dimensionFields });
export const dimensionPatch = z.strictObject(dimensionFields).partial();

export const categoryCreate = z.strictObject({ name, displayOrder: order.optional() });
export const categoryPatch = categoryCreate.partial();

// TODO(需取证 #103): 目标的取值形式（分值 / 等级 / 文本）与权重合计约束未取证，暂按非负两位小数、不要求合计 100。
const criterionDimension = z.strictObject({
  dimensionId: uuid,
  weight: z.number().min(0).max(100).multipleOf(0.01).nullable().optional(),
  target: z.number().min(0).max(999_999.99).multipleOf(0.01).nullable().optional(),
  displayOrder: order.optional(),
});
const criterionFields = {
  name,
  enabled: z.boolean().optional(),
  abilityNote: note.optional(),
  potentialNote: note.optional(),
  experienceNote: note.optional(),
  achievementNote: note.optional(),
  dimensions: z.array(criterionDimension).max(MAX_CRITERION_DIMENSIONS).optional(),
};
export const criterionCreate = z.strictObject({ categoryId: uuid, ...criterionFields });
export const criterionPatch = z.strictObject({ categoryId: uuid, ...criterionFields }).partial();

export type LibraryCreate = z.output<typeof libraryCreate>;
export type LibraryPatch = z.output<typeof libraryPatch>;
export type DimensionCreate = z.output<typeof dimensionCreate>;
export type DimensionPatch = z.output<typeof dimensionPatch>;
export type CategoryCreate = z.output<typeof categoryCreate>;
export type CategoryPatch = z.output<typeof categoryPatch>;
export type CriterionCreate = z.output<typeof criterionCreate>;
export type CriterionPatch = z.output<typeof criterionPatch>;
export type CriterionDimensionInput = z.output<typeof criterionDimension>;
