/**
 * R3-T02 任职资格配置（docs/02_业务建模/23 §3、§9、§11、§12；设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §3.1）。
 * - 带资源集合的对象（分类、类别、级别、指标类型、指标、标准）有所属人 / 所属管理单元（系统填写，Q-M0-132、DEC-324②）；
 *   除标准外另有复刻扩展“向下公开”，缺省不公开；标准的资源集合随类别，可见性锚在类别上（设计 §5.1）。
 * - 层级、等级方案、编码规则没有组织字段（字典，DEC-121 口径）；等级明细、指标等级描述、标准明细、能力标准、
 *   级别描述、发展通道随各自的主对象。
 * - 同一类型下一个岗职务只能被一个类别 / 级别关联（DEC-331④，Q-M0-134 🟢）：唯一约束兜底并发保存。
 * - 标准原地修改，没有版本（QL-R18、DEC-055）；级别范围建后不可改。
 * - 通用指标的指标说明“覆盖写入”各标准的能力标准（DEC-334①，Q-T02-14 🟢）：能力标准行带来源标记，读取时按源字段查看权
 *   判断（DEC-309）。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgObjects } from './org.js';
import { tenants } from './tenancy.js';

export type QualificationCategoryLink = 'position' | 'post' | 'sequence' | 'level_type';
export type QualificationLevelLink = 'level' | 'grade';
export type QualificationEvalMode = 'score' | 'grade';
export type QualificationCodingItem = 'category' | 'level' | 'target_type' | 'target';
/** 能力标准的来源：手工录入、新建标准时从非通用指标复制、通用指标覆盖写入（DEC-334①）。 */
export type QualificationAbilitySource = 'manual' | 'copied' | 'common_overwrite';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const tracked = () => ({
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
/** 资源集合：所属人 / 所属管理单元（系统填写）与向下公开（复刻扩展，缺省 false）。 */
const owned = () => ({
  ownerId: uuid('owner_id').notNull(),
  ownerOrgId: uuid('owner_org_id').notNull(),
  publicDown: boolean('public_down').notNull().default(false),
});
const displayOrder = () => integer('display_order').notNull().default(0);
const enabled = () => boolean('enabled').notNull().default(true);
const code = () => text('code').notNull();

type Columns = { tenantId: AnyPgColumn } & Record<string, AnyPgColumn>;

/** 同租户外键（tenant_id, <列>）→（tenant_id, id）。 */
function fk(
  name: string,
  t: Columns,
  column: AnyPgColumn,
  target: { tenantId: AnyPgColumn; id: AnyPgColumn },
  onDelete: 'restrict' | 'cascade',
) {
  return foreignKey({ columns: [t.tenantId, column], foreignColumns: [target.tenantId, target.id], name }).onDelete(
    onDelete,
  );
}

function ownerOrg(name: string, t: Columns & { ownerOrgId: AnyPgColumn }) {
  return [
    index(`${name}_owner_org`).on(t.tenantId, t.ownerOrgId),
    fk(`${name}_owner_org_fk`, t, t.ownerOrgId, orgObjects, 'restrict'),
  ];
}

/** 编码：租户内唯一；格式同人才标准（字母开头，字母数字下划线，≤50）。 */
function coded(name: string, t: Columns & { code: AnyPgColumn }) {
  return [
    unique(`${name}_code`).on(t.tenantId, t.code),
    check(`${name}_code_format`, sql`${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$'`),
  ];
}

/** 任职类别分类 EmploymentCategoryClassify：最多 5 级（level 由上级推出）。 */
export const qlCategoryClasses = pgTable(
  'ql_category_classes',
  {
    id: id(),
    tenantId: tenantId(),
    code: code(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    level: integer('level').notNull(),
    displayOrder: displayOrder(),
    enabled: enabled(),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('ql_category_classes_tenant_id').on(t.tenantId, t.id),
    ...coded('ql_category_classes', t),
    check('ql_category_classes_level', sql`${t.level} BETWEEN 1 AND 5`),
    index('ql_category_classes_parent').on(t.tenantId, t.parentId),
    fk('ql_category_classes_parent_fk', t, t.parentId, { tenantId: t.tenantId, id: t.id }, 'restrict'),
    ...ownerOrg('ql_category_classes', t),
  ],
);

/** 任职类别 EmploymentCategory：引入（自动关联）或新建后手工关联岗职务（QL-R1）。 */
export const qlCategories = pgTable(
  'ql_categories',
  {
    id: id(),
    tenantId: tenantId(),
    code: code(),
    name: text('name').notNull(),
    classId: uuid('class_id').notNull(),
    jobLinkType: text('job_link_type').$type<QualificationCategoryLink>(),
    enabled: enabled(),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('ql_categories_tenant_id').on(t.tenantId, t.id),
    ...coded('ql_categories', t),
    check(
      'ql_categories_job_link_type',
      sql`${t.jobLinkType} IS NULL OR ${t.jobLinkType} IN ('position', 'post', 'sequence', 'level_type')`,
    ),
    index('ql_categories_class').on(t.tenantId, t.classId),
    fk('ql_categories_class_fk', t, t.classId, qlCategoryClasses, 'restrict'),
    ...ownerOrg('ql_categories', t),
  ],
);

/** 类别 ↔ 岗职务关联：同一类型下一个岗职务只关联一个类别（DEC-331④）。 */
export const qlCategoryJobLinks = pgTable(
  'ql_category_job_links',
  {
    id: id(),
    tenantId: tenantId(),
    categoryId: uuid('category_id').notNull(),
    jobLinkType: text('job_link_type').$type<QualificationCategoryLink>().notNull(),
    jobObjectId: uuid('job_object_id').notNull(),
  },
  (t) => [
    unique('ql_category_job_links_object').on(t.tenantId, t.jobLinkType, t.jobObjectId),
    index('ql_category_job_links_category').on(t.tenantId, t.categoryId),
    check('ql_category_job_links_type', sql`${t.jobLinkType} IN ('position', 'post', 'sequence', 'level_type')`),
    fk('ql_category_job_links_category_fk', t, t.categoryId, qlCategories, 'cascade'),
  ],
);

/** 层级 Level：字典（无资源集合，Q-M0-132）。 */
export const qlLayers = pgTable(
  'ql_layers',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    displayOrder: displayOrder(),
    enabled: enabled(),
    ...tracked(),
  },
  (t) => [unique('ql_layers_tenant_id').on(t.tenantId, t.id), unique('ql_layers_name').on(t.tenantId, t.name)],
);

/** 任职级别 EmploymentLevel：顺序号从低到高、租户内唯一（QL-R2）。 */
export const qlLevels = pgTable(
  'ql_levels',
  {
    id: id(),
    tenantId: tenantId(),
    code: code(),
    name: text('name').notNull(),
    displayOrder: integer('display_order').notNull(),
    layerId: uuid('layer_id'),
    jobLinkType: text('job_link_type').$type<QualificationLevelLink>(),
    enabled: enabled(),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('ql_levels_tenant_id').on(t.tenantId, t.id),
    ...coded('ql_levels', t),
    unique('ql_levels_display_order').on(t.tenantId, t.displayOrder),
    check('ql_levels_job_link_type', sql`${t.jobLinkType} IS NULL OR ${t.jobLinkType} IN ('level', 'grade')`),
    index('ql_levels_layer').on(t.tenantId, t.layerId),
    fk('ql_levels_layer_fk', t, t.layerId, qlLayers, 'restrict'),
    ...ownerOrg('ql_levels', t),
  ],
);

export const qlLevelJobLinks = pgTable(
  'ql_level_job_links',
  {
    id: id(),
    tenantId: tenantId(),
    levelId: uuid('level_id').notNull(),
    jobLinkType: text('job_link_type').$type<QualificationLevelLink>().notNull(),
    jobObjectId: uuid('job_object_id').notNull(),
  },
  (t) => [
    unique('ql_level_job_links_object').on(t.tenantId, t.jobLinkType, t.jobObjectId),
    index('ql_level_job_links_level').on(t.tenantId, t.levelId),
    check('ql_level_job_links_type', sql`${t.jobLinkType} IN ('level', 'grade')`),
    fk('ql_level_job_links_level_fk', t, t.levelId, qlLevels, 'cascade'),
  ],
);

/** 指标类型 TargetType：多层级树（QL-R4）；原站有资源集合（Q-M0-132）。 */
export const qlTargetTypes = pgTable(
  'ql_target_types',
  {
    id: id(),
    tenantId: tenantId(),
    code: code(),
    name: text('name').notNull(),
    parentId: uuid('parent_id'),
    displayOrder: displayOrder(),
    enabled: enabled(),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('ql_target_types_tenant_id').on(t.tenantId, t.id),
    ...coded('ql_target_types', t),
    index('ql_target_types_parent').on(t.tenantId, t.parentId),
    fk('ql_target_types_parent_fk', t, t.parentId, { tenantId: t.tenantId, id: t.id }, 'restrict'),
    ...ownerOrg('ql_target_types', t),
  ],
);

/** 等级方案 GradeScheme：名称唯一（QL-R7），字典。 */
export const qlGradeSchemes = pgTable(
  'ql_grade_schemes',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    enabled: enabled(),
    ...tracked(),
  },
  (t) => [
    unique('ql_grade_schemes_tenant_id').on(t.tenantId, t.id),
    unique('ql_grade_schemes_name').on(t.tenantId, t.name),
  ],
);

/** 等级明细：级别数字越大越高；删除为软删（指标等级描述里手改过的行保留不显示，设计 §3.1）。 */
export const qlGradeDetails = pgTable(
  'ql_grade_details',
  {
    id: id(),
    tenantId: tenantId(),
    schemeId: uuid('scheme_id').notNull(),
    name: text('name').notNull(),
    grade: integer('grade').notNull(),
    score: numeric('score', { precision: 9, scale: 2 }),
    description: text('description'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    unique('ql_grade_details_tenant_id').on(t.tenantId, t.id),
    index('ql_grade_details_scheme').on(t.tenantId, t.schemeId),
    fk('ql_grade_details_scheme_fk', t, t.schemeId, qlGradeSchemes, 'cascade'),
  ],
);

/** 指标 Target：评分不选等级方案、评级必须选（QL-R6）；通用指标覆盖写入各标准（DEC-334①）。 */
export const qlTargets = pgTable(
  'ql_targets',
  {
    id: id(),
    tenantId: tenantId(),
    code: code(),
    name: text('name').notNull(),
    typeId: uuid('type_id').notNull(),
    description: text('description'),
    isCommon: boolean('is_common').notNull().default(false),
    evalMode: text('eval_mode').$type<QualificationEvalMode>().notNull(),
    gradeSchemeId: uuid('grade_scheme_id'),
    displayOrder: displayOrder(),
    enabled: enabled(),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('ql_targets_tenant_id').on(t.tenantId, t.id),
    ...coded('ql_targets', t),
    check(
      'ql_targets_eval_mode',
      sql`(${t.evalMode} = 'score' AND ${t.gradeSchemeId} IS NULL)
        OR (${t.evalMode} = 'grade' AND ${t.gradeSchemeId} IS NOT NULL)`,
    ),
    index('ql_targets_type').on(t.tenantId, t.typeId),
    index('ql_targets_grade_scheme').on(t.tenantId, t.gradeSchemeId),
    fk('ql_targets_type_fk', t, t.typeId, qlTargetTypes, 'restrict'),
    fk('ql_targets_grade_scheme_fk', t, t.gradeSchemeId, qlGradeSchemes, 'restrict'),
    ...ownerOrg('ql_targets', t),
  ],
);

/** 指标等级描述：只存手工改过的（未改的 = 等级明细描述的投影，设计 §3.1）。 */
export const qlTargetGradeDescriptions = pgTable(
  'ql_target_grade_descriptions',
  {
    id: id(),
    tenantId: tenantId(),
    targetId: uuid('target_id').notNull(),
    gradeDetailId: uuid('grade_detail_id').notNull(),
    description: text('description').notNull(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('ql_target_grade_descriptions_pair').on(t.tenantId, t.targetId, t.gradeDetailId),
    fk('ql_target_grade_descriptions_target_fk', t, t.targetId, qlTargets, 'cascade'),
    fk('ql_target_grade_descriptions_detail_fk', t, t.gradeDetailId, qlGradeDetails, 'cascade'),
  ],
);

/** 编码规则：每个租户四项（类别 / 级别 / 指标类型 / 指标），只能编辑（QL-R3）；未改过的项按缺省值呈现。 */
export const qlCodingRules = pgTable(
  'ql_coding_rules',
  {
    id: id(),
    tenantId: tenantId(),
    item: text('item').$type<QualificationCodingItem>().notNull(),
    enabled: boolean('enabled').notNull().default(false),
    prefix: text('prefix').notNull().default(''),
    nextSeq: integer('next_seq').notNull().default(1),
    ...tracked(),
  },
  (t) => [
    unique('ql_coding_rules_item').on(t.tenantId, t.item),
    check('ql_coding_rules_item_check', sql`${t.item} IN ('category', 'level', 'target_type', 'target')`),
    check('ql_coding_rules_next_seq', sql`${t.nextSeq} >= 1`),
  ],
);

/** 任职资格标准：一个类别只对应一条（QL-R8）；资源集合随类别（系统复制，不可改）；级别范围建后不可改（QL-R18）。 */
export const qlStandards = pgTable(
  'ql_standards',
  {
    id: id(),
    tenantId: tenantId(),
    categoryId: uuid('category_id').notNull(),
    name: text('name').notNull(),
    enabled: enabled(),
    levelIds: uuid('level_ids').array().notNull(),
    ownerId: uuid('owner_id').notNull(),
    ownerOrgId: uuid('owner_org_id').notNull(),
    ...tracked(),
  },
  (t) => [
    unique('ql_standards_tenant_id').on(t.tenantId, t.id),
    unique('ql_standards_category').on(t.tenantId, t.categoryId),
    check('ql_standards_level_ids', sql`cardinality(${t.levelIds}) BETWEEN 1 AND 100`),
    fk('ql_standards_category_fk', t, t.categoryId, qlCategories, 'restrict'),
    ...ownerOrg('ql_standards', t),
  ],
);

/** 标准明细：级别 × 指标一格（QL-R9），目标值、权重%。 */
export const qlStandardDetails = pgTable(
  'ql_standard_details',
  {
    id: id(),
    tenantId: tenantId(),
    standardId: uuid('standard_id').notNull(),
    levelId: uuid('level_id').notNull(),
    targetId: uuid('target_id').notNull(),
    targetValue: text('target_value'),
    weight: numeric('weight', { precision: 7, scale: 2 }),
  },
  (t) => [
    unique('ql_standard_details_tenant_id').on(t.tenantId, t.id),
    unique('ql_standard_details_cell').on(t.tenantId, t.standardId, t.levelId, t.targetId),
    index('ql_standard_details_target').on(t.tenantId, t.targetId),
    check('ql_standard_details_weight', sql`${t.weight} IS NULL OR ${t.weight} BETWEEN 0 AND 100`),
    fk('ql_standard_details_standard_fk', t, t.standardId, qlStandards, 'cascade'),
    fk('ql_standard_details_level_fk', t, t.levelId, qlLevels, 'restrict'),
    fk('ql_standard_details_target_fk', t, t.targetId, qlTargets, 'restrict'),
  ],
);

/** 能力标准明细：每格 1–10 条（QL-R10，服务层校验条数）；来源标记见 DEC-334①。 */
export const qlAbilityDetails = pgTable(
  'ql_ability_details',
  {
    id: id(),
    tenantId: tenantId(),
    detailId: uuid('detail_id').notNull(),
    content: text('content').notNull().default(''),
    targetValue: text('target_value'),
    targetGradeId: uuid('target_grade_id'),
    weight: numeric('weight', { precision: 7, scale: 2 }),
    displayOrder: displayOrder(),
    source: text('source').$type<QualificationAbilitySource>().notNull().default('manual'),
    sourceTargetId: uuid('source_target_id'),
  },
  (t) => [
    index('ql_ability_details_detail').on(t.tenantId, t.detailId),
    check('ql_ability_details_source', sql`${t.source} IN ('manual', 'copied', 'common_overwrite')`),
    check('ql_ability_details_source_target', sql`(${t.source} = 'manual') = (${t.sourceTargetId} IS NULL)`),
    check('ql_ability_details_weight', sql`${t.weight} IS NULL OR ${t.weight} BETWEEN 0 AND 100`),
    fk('ql_ability_details_detail_fk', t, t.detailId, qlStandardDetails, 'cascade'),
    fk('ql_ability_details_grade_fk', t, t.targetGradeId, qlGradeDetails, 'restrict'),
  ],
);

export const qlLevelDescriptions = pgTable(
  'ql_level_descriptions',
  {
    id: id(),
    tenantId: tenantId(),
    standardId: uuid('standard_id').notNull(),
    levelId: uuid('level_id').notNull(),
    description: text('description').notNull(),
  },
  (t) => [
    unique('ql_level_descriptions_pair').on(t.tenantId, t.standardId, t.levelId),
    fk('ql_level_descriptions_standard_fk', t, t.standardId, qlStandards, 'cascade'),
    fk('ql_level_descriptions_level_fk', t, t.levelId, qlLevels, 'restrict'),
  ],
);

/** 发展通道（横向，QL-R13）：纵向由级别顺序生成，不落行。 */
export const qlDevelopmentChannels = pgTable(
  'ql_development_channels',
  {
    id: id(),
    tenantId: tenantId(),
    standardId: uuid('standard_id').notNull(),
    levelId: uuid('level_id').notNull(),
    targetCategoryId: uuid('target_category_id').notNull(),
    targetLevelId: uuid('target_level_id').notNull(),
  },
  (t) => [
    unique('ql_development_channels_path').on(t.tenantId, t.standardId, t.levelId, t.targetCategoryId, t.targetLevelId),
    fk('ql_development_channels_standard_fk', t, t.standardId, qlStandards, 'cascade'),
    fk('ql_development_channels_level_fk', t, t.levelId, qlLevels, 'restrict'),
    fk('ql_development_channels_category_fk', t, t.targetCategoryId, qlCategories, 'restrict'),
    fk('ql_development_channels_target_level_fk', t, t.targetLevelId, qlLevels, 'restrict'),
  ],
);
