/**
 * 任职资格各接口的请求结构（只做结构校验，不读库）。严格对象：未登记的键（资源集合、所属人由系统填写，DEC-324②；
 * 标准的类别与级别范围建后不可改，QL-R8 / QL-R18）一律 400。数组设上限（AGENTS §10「批量」）。
 * 新建时的 ownerOrgId 只表示“从创建人的多个授权管理单元里选的那一个”（DEC-339，同 #106 DEC-294 补充）：只有一个时
 * 可省略，由服务端填写与校验；建后不可改。
 */
import { z } from 'zod';

// DEC-194：UUID 一律按小写规范化
export const uuid = z.uuid().transform((value) => value.toLowerCase());
const code = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/, '编码只能包含字母、数字、下划线与连字符，最长 50 位');
const name = z.string().trim().min(1).max(100);
const text = z.string().trim().max(4000).nullable();
const order = z.int().min(0).max(1_000_000);
const percent = z.number().min(0).max(100).multipleOf(0.01).nullable();

export const MAX_JOB_LINKS = 200;
export const MAX_IMPORT_ITEMS = 200;
export const MAX_LEVELS = 100;
export const MAX_CELLS = 2000;
export const MAX_ABILITIES = 10;
export const MAX_IMPORT_ROWS = 2000;
export const MAX_GRADE_DETAILS = 50;

export const CATEGORY_LINKS = ['position', 'post', 'sequence', 'level_type'] as const;
export const LEVEL_LINKS = ['level', 'grade'] as const;

const common = { enabled: z.boolean().optional(), publicDown: z.boolean().optional() };
const ownerOrgId = uuid.optional();

export const categoryClassCreate = z.strictObject({
  code,
  name,
  parentId: uuid.nullable().optional(),
  displayOrder: order.optional(),
  ...common,
  ownerOrgId,
});
export const categoryClassPatch = categoryClassCreate.omit({ parentId: true, ownerOrgId: true }).partial();

const jobLinks = z.array(uuid).max(MAX_JOB_LINKS);
export const categoryCreate = z.strictObject({
  code: code.optional(),
  name,
  classId: uuid,
  jobLinkType: z.enum(CATEGORY_LINKS).nullable().optional(),
  jobLinks: jobLinks.optional(),
  ...common,
  ownerOrgId,
});
export const categoryPatch = categoryCreate.omit({ classId: true, ownerOrgId: true }).partial();

/** 引入（QL-R1 / QL-R2）：每个岗职务生成一个对象；编码 / 名称缺省取自岗职务（须看得到，DEC-309 #4）。 */
const importItem = z.strictObject({ jobObjectId: uuid, code: code.optional(), name: name.optional() });
export const categoryImport = z.strictObject({
  classId: uuid,
  jobLinkType: z.enum(CATEGORY_LINKS),
  items: z.array(importItem).min(1).max(MAX_IMPORT_ITEMS),
  ownerOrgId,
});
export const levelImport = z.strictObject({
  jobLinkType: z.enum(LEVEL_LINKS),
  layerId: uuid.nullable().optional(),
  items: z.array(importItem).min(1).max(MAX_IMPORT_ITEMS),
  ownerOrgId,
});

export const layerCreate = z.strictObject({ name, displayOrder: order.optional(), enabled: z.boolean().optional() });
export const layerPatch = layerCreate.partial();

export const levelCreate = z.strictObject({
  code: code.optional(),
  name,
  displayOrder: order.optional(),
  layerId: uuid.nullable().optional(),
  jobLinkType: z.enum(LEVEL_LINKS).nullable().optional(),
  jobLinks: jobLinks.optional(),
  ...common,
  ownerOrgId,
});
export const levelPatch = levelCreate.omit({ ownerOrgId: true }).partial();

export const targetTypeCreate = z.strictObject({
  code: code.optional(),
  name,
  parentId: uuid.nullable().optional(),
  displayOrder: order.optional(),
  ...common,
  ownerOrgId,
});
export const targetTypePatch = targetTypeCreate.omit({ parentId: true, ownerOrgId: true }).partial();

export const targetCreate = z.strictObject({
  code: code.optional(),
  name,
  typeId: uuid,
  description: text.optional(),
  isCommon: z.boolean().optional(),
  evalMode: z.enum(['score', 'grade']),
  gradeSchemeId: uuid.nullable().optional(),
  displayOrder: order.optional(),
  /** 确认框（DEC-334①）：会覆盖写入各标准的能力标准时必须带 true。 */
  confirmOverwrite: z.boolean().optional(),
  ...common,
  ownerOrgId,
});
export const targetPatch = targetCreate.omit({ typeId: true, ownerOrgId: true }).partial();

const gradeDetail = z.strictObject({
  id: uuid.optional(),
  name,
  grade: z.int().min(0).max(1000),
  score: z.number().min(-9_999_999).max(9_999_999).multipleOf(0.01).nullable().optional(),
  description: text.optional(),
});
export const gradeSchemeCreate = z.strictObject({
  name,
  description: text.optional(),
  enabled: z.boolean().optional(),
  details: z.array(gradeDetail).max(MAX_GRADE_DETAILS),
});
export const gradeSchemePatch = gradeSchemeCreate.partial();

export const gradeDescriptionPut = z.strictObject({ description: z.string().trim().min(1).max(4000) });

export const codingRulePatch = z.strictObject({
  enabled: z.boolean().optional(),
  // 前缀 + 序号要能拼出合法编码（字母或数字开头，第 2 轮 P2-08）：空前缀或以字母 / 数字开头
  prefix: z
    .string()
    .trim()
    .regex(
      /^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,19})?$/,
      '前缀须以字母或数字开头，只能包含字母、数字、下划线与连字符，最长 20 位',
    )
    .optional(),
  nextSeq: z.int().min(1).max(999_999_999).optional(),
});

const ability = z.strictObject({
  content: z.string().trim().max(4000).optional(),
  targetValue: z.string().trim().max(200).nullable().optional(),
  targetGradeId: uuid.nullable().optional(),
  weight: percent.optional(),
});
export const cell = z.strictObject({
  levelId: uuid,
  targetId: uuid,
  targetValue: z.string().trim().max(200).nullable().optional(),
  weight: percent.optional(),
  /** 省略：已有格保留原有能力标准；新格按指标带入（QL-R5）。 */
  abilities: z.array(ability).min(1).max(MAX_ABILITIES).optional(),
});
const levelDescription = z.strictObject({ levelId: uuid, description: z.string().trim().min(1).max(4000) });

export const standardCreate = z.strictObject({
  categoryId: uuid,
  name,
  enabled: z.boolean().optional(),
  levelIds: z.array(uuid).min(1).max(MAX_LEVELS),
  /** 整组：请求里的格即标准的全部格（未列出的格删除）。 */
  details: z.array(cell).max(MAX_CELLS),
  levelDescriptions: z.array(levelDescription).max(MAX_LEVELS).optional(),
});
export const standardPatch = standardCreate.omit({ categoryId: true, levelIds: true }).partial();

/** 编辑导入（QL-R11）：一行 = 类别编码 × 级别编码 × 指标编码 × 一条能力标准。 */
const importRow = z.strictObject({
  categoryCode: z.string().trim().min(1).max(50),
  levelCode: z.string().trim().min(1).max(50),
  targetCode: z.string().trim().min(1).max(50),
  content: z.string().trim().max(4000),
  targetValue: z.string().trim().max(200).nullable().optional(),
  weight: percent.optional(),
});
/**
 * 导入涉及的每条标准都带预期 revision（按类别编码对应，DEC-067）：锁住后逐条核对，任一不符整体 409，
 * 不让导入拿旧内容覆盖别人刚做的修改（第 2 轮 P2-06）。
 */
const expectedStandard = z.strictObject({ categoryCode: z.string().trim().min(1).max(50), revision: z.int().min(0) });
export const standardImport = z.strictObject({
  standards: z.array(expectedStandard).max(MAX_IMPORT_ROWS),
  rows: z.array(importRow).min(1).max(MAX_IMPORT_ROWS),
});

const channel = z.strictObject({ levelId: uuid, targetCategoryId: uuid, targetLevelId: uuid });
export const channelsPut = z.strictObject({ channels: z.array(channel).max(500) });

export type CategoryClassCreate = z.infer<typeof categoryClassCreate>;
export type CategoryClassPatch = z.infer<typeof categoryClassPatch>;
export type CategoryCreate = z.infer<typeof categoryCreate>;
export type CategoryPatch = z.infer<typeof categoryPatch>;
export type CategoryImport = z.infer<typeof categoryImport>;
export type LevelImport = z.infer<typeof levelImport>;
export type LayerCreate = z.infer<typeof layerCreate>;
export type LayerPatch = z.infer<typeof layerPatch>;
export type LevelCreate = z.infer<typeof levelCreate>;
export type LevelPatch = z.infer<typeof levelPatch>;
export type TargetTypeCreate = z.infer<typeof targetTypeCreate>;
export type TargetTypePatch = z.infer<typeof targetTypePatch>;
export type TargetCreate = z.infer<typeof targetCreate>;
export type TargetPatch = z.infer<typeof targetPatch>;
export type GradeSchemeCreate = z.infer<typeof gradeSchemeCreate>;
export type GradeSchemePatch = z.infer<typeof gradeSchemePatch>;
export type CodingRulePatch = z.infer<typeof codingRulePatch>;
export type Cell = z.infer<typeof cell>;
export type StandardCreate = z.infer<typeof standardCreate>;
export type StandardPatch = z.infer<typeof standardPatch>;
export type StandardImport = z.infer<typeof standardImport>;
export type ChannelsPut = z.infer<typeof channelsPut>;
