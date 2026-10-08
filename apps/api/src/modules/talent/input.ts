/**
 * 人才标准各接口的请求结构（只做结构校验，不读库）。严格对象：未登记的键（含建后不可改的 指标库类型、指标所属指标库、
 * 指标编码、所属管理单元，DEC-281⑤⑥；所属人由系统填写，DEC-294③）一律 400。明细数组设上限（AGENTS §10「批量」）。
 * 新建时的 ownerOrgId 只表示“从创建人的多个授权管理单元里选的那一个”（DEC-294 补充），可省略，由服务端填写与校验。
 */
import { TALENT_DIMENSION_TYPES } from '@italent/domain';
import { z } from 'zod';

// DEC-194：与 F-017 同一口径，UUID 一律按小写规范化（路径参数由 uuidParam 规范化）。
export const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(200);
const note = z.string().trim().max(4000).nullable();
const shortText = z.string().trim().max(200).nullable();
const order = z.int().min(0).max(1_000_000);
/** DEC-281①②：数值、1 位小数、可空、可为负、没有业务范围（存储上限 numeric(10,1)）。 */
const oneDecimal = z.number().min(-999_999_999.9).max(999_999_999.9).multipleOf(0.1).nullable().optional();

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
/**
 * 发展建议（DEC-281④）：类型取自类型数据源（必填）、描述必填、呈现顺序必填。id 是已有建议行的行身份（读取时返回），
 * 编辑时带回表示“保留这一行”；不带 id 的是新增行（第 5 轮清单 1）。
 */
const suggestion = z.strictObject({
  id: uuid.optional(),
  typeId: uuid,
  description: z.string().trim().min(1).max(4000),
  displayOrder: order,
});
const question = z.strictObject({
  question: z.string().trim().min(1).max(4000),
  keyPoints: note.optional(),
  displayOrder: order.optional(),
});

/** DEC-294③：所属管理单元由系统填写，只在创建人有多个授权管理单元时由新建请求选一个；建后不能改。 */
const ownerOrgId = uuid.optional();

export const libraryCreate = z.strictObject({
  name,
  type: z.enum(TALENT_DIMENSION_TYPES),
  enabled: z.boolean().optional(),
  displayOrder: order.optional(),
  ownerOrgId,
});
export const libraryPatch = libraryCreate.omit({ type: true, ownerOrgId: true }).partial();

/** 指标库内分类（DEC-281③）：类别名称必填 ≤50、类别顺序必填整数；无编码、无层级，所属指标库建后不可改。 */
export const dimensionCategoryCreate = z.strictObject({
  libraryId: uuid,
  name: z.string().trim().min(1).max(50),
  displayOrder: z.int().min(-1_000_000).max(1_000_000),
  // 库内分类同样跟创建人的授权管理单元，不随所属指标库（DEC-294 补充二）
  ownerOrgId,
});
export const dimensionCategoryPatch = dimensionCategoryCreate.omit({ libraryId: true, ownerOrgId: true }).partial();

export const descriptionTypeCreate = z.strictObject({
  name: z.string().trim().min(1).max(50),
  enabled: z.boolean().optional(),
  displayOrder: order.optional(),
});
export const descriptionTypePatch = descriptionTypeCreate.partial();

/** DEC-281⑤：编码必填、≤50、首字符为字母且只含字母数字下划线；编辑时只读。 */
const code = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,49}$/, '编码首字符必须是字母，且只能包含字母数字下划线');
const dimensionFields = {
  name,
  definition: note.optional(),
  categoryId: uuid.nullable().optional(),
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
export const dimensionCreate = z.strictObject({ libraryId: uuid, code, ...dimensionFields, ownerOrgId });
export const dimensionPatch = z.strictObject(dimensionFields).partial();

export const categoryCreate = z.strictObject({ name, displayOrder: order.optional(), ownerOrgId });
export const categoryPatch = categoryCreate.omit({ ownerOrgId: true }).partial();

/** DEC-294⑤：关联记录上的“指标类别”文本（与库内分类名称同长度上限）。 */
const dimensionCategory = z.string().trim().max(50).nullable();
/**
 * 引用行以指标为键（没有可写的行标识，编辑时不能换指标，DEC-281⑥）。指标类别不传时：新增行复制库内分类，
 * 已有行保持原值；传了（含 null）就按传入的写。
 */
const criterionDimension = z.strictObject({
  dimensionId: uuid,
  weight: oneDecimal,
  target: oneDecimal,
  displayOrder: order.optional(),
  dimensionCategory: dimensionCategory.optional(),
});
const criterionFields = {
  categoryId: uuid,
  name,
  enabled: z.boolean().optional(),
  abilityNote: note.optional(),
  potentialNote: note.optional(),
  experienceNote: note.optional(),
  achievementNote: note.optional(),
  dimensions: z.array(criterionDimension).max(MAX_CRITERION_DIMENSIONS).optional(),
};
export const criterionCreate = z.strictObject({ ...criterionFields, ownerOrgId });
/**
 * 编辑时新加的关联记录跟添加人（DEC-294 补充二）：添加人有多个授权管理单元时用 relationOwnerOrgId 选一个；
 * 新建标准时关联记录与标准由同一人在同一请求里加入，用同一个所选的 ownerOrgId。
 */
export const criterionPatch = z.strictObject({ ...criterionFields, relationOwnerOrgId: ownerOrgId }).partial();

/** 「设置指标类别」（DEC-294⑤）：给标准里勾选的指标统一填一个类别（null 清空）。 */
export const dimensionCategoryBatch = z.strictObject({
  dimensionIds: z
    .array(uuid)
    .min(1)
    .max(MAX_CRITERION_DIMENSIONS)
    .refine((ids) => new Set(ids).size === ids.length, '指标不能重复'),
  dimensionCategory,
});

export type LibraryCreate = z.output<typeof libraryCreate>;
export type LibraryPatch = z.output<typeof libraryPatch>;
export type DimensionCategoryCreate = z.output<typeof dimensionCategoryCreate>;
export type DimensionCategoryPatch = z.output<typeof dimensionCategoryPatch>;
export type DescriptionTypeCreate = z.output<typeof descriptionTypeCreate>;
export type DescriptionTypePatch = z.output<typeof descriptionTypePatch>;
export type DimensionCreate = z.output<typeof dimensionCreate>;
export type DimensionPatch = z.output<typeof dimensionPatch>;
export type SuggestionInput = z.output<typeof suggestion>;
export type CategoryCreate = z.output<typeof categoryCreate>;
export type CategoryPatch = z.output<typeof categoryPatch>;
export type CriterionCreate = z.output<typeof criterionCreate>;
export type CriterionPatch = z.output<typeof criterionPatch>;
export type CriterionDimensionInput = z.output<typeof criterionDimension>;
export type DimensionCategoryBatch = z.output<typeof dimensionCategoryBatch>;
