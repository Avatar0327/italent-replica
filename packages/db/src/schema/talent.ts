/**
 * R3-T01 人才标准与指标库（docs/02_业务建模/23 §2.1、§7；REQ-TC-001；DEC-281）。
 * - 指标库按 能力 / 潜力 / 经历 三类（TC-R1）；库内分类是独立对象（DEC-281③），指标以查找字段引用同库的分类；
 * - 指标的等级 / 行为 / 发展建议 / 面试问题各一张明细表，随指标整组替换；发展建议的类型取自类型数据源（DEC-281④）；
 * - 人才标准里的指标只存引用（TC-R2）：关系表只有指标 ID、权重、目标、顺序与关联记录自己的“指标类别”文本
 *   （DEC-294⑤：选入时复制库内分类名称作缺省，之后各自独立），不复制指标内容；
 * - 被引用的指标、还有指标或分类的指标库、被引用的分类与类型、还有标准的标准分类不能删除（TC-R5）：
 *   外键 RESTRICT 兜底，服务层先给出明确错误；
 * - 指标库、库内分类、指标、标准分类、人才标准带所属人与所属管理单元（DEC-281⑨），所属管理单元以组织表达
 *   （DEC-026 同思路），数据范围按查看人的管理单元裁剪；发展建议类型是没有组织字段的字典。所属人 / 所属管理单元
 *   由系统按创建人与其授权管理单元填写（DEC-294③），标准内的指标关联记录同样带这两项。
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
  type PgColumnBuilderBase,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgObjects } from './org.js';
import { tenants } from './tenancy.js';

type DimensionType = 'ability' | 'potential' | 'experience';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
/** 可编辑对象的公共列：revision 乐观锁、创建人、UTC 事件时间。 */
const tracked = () => ({
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
/** DEC-281⑨：所属人（建时为创建人）与所属管理单元（组织）。 */
const owned = () => ({
  ownerId: uuid('owner_id').notNull(),
  ownerOrgId: uuid('owner_org_id').notNull(),
});
const displayOrder = () => integer('display_order').notNull().default(0);

/** 所属管理单元引用组织（RESTRICT）并建范围过滤索引。 */
function ownerOrg(name: string, t: { tenantId: AnyPgColumn; ownerOrgId: AnyPgColumn }) {
  return [
    index(`${name}_owner_org`).on(t.tenantId, t.ownerOrgId),
    foreignKey({
      columns: [t.tenantId, t.ownerOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
      name: `${name}_owner_org_fk`,
    }).onDelete('restrict'),
  ];
}

export const talentDimensionLibraries = pgTable(
  'talent_dimension_libraries',
  {
    id: id(),
    tenantId: tenantId(),
    type: text('type').$type<DimensionType>().notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    displayOrder: displayOrder(),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('talent_dimension_libraries_tenant_id').on(t.tenantId, t.id),
    check('talent_dimension_libraries_type', sql`${t.type} IN ('ability', 'potential', 'experience')`),
    ...ownerOrg('talent_dimension_libraries', t),
  ],
);

/** 指标库内分类 TalentCenter.Category（DEC-281③）：类别名称 + 类别顺序，挂在库下，无编码、无层级。 */
export const talentDimensionCategories = pgTable(
  'talent_dimension_categories',
  {
    id: id(),
    tenantId: tenantId(),
    libraryId: uuid('library_id').notNull(),
    name: text('name').notNull(),
    displayOrder: integer('display_order').notNull(),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('talent_dimension_categories_tenant_id').on(t.tenantId, t.id),
    // 指标引用分类时连同指标库一起作外键，保证只能引用同库的分类
    unique('talent_dimension_categories_library_id').on(t.tenantId, t.libraryId, t.id),
    foreignKey({
      columns: [t.tenantId, t.libraryId],
      foreignColumns: [talentDimensionLibraries.tenantId, talentDimensionLibraries.id],
      name: 'talent_dimension_categories_library_fk',
    }).onDelete('restrict'),
    ...ownerOrg('talent_dimension_categories', t),
  ],
);

/** 发展建议类型 TalentCenter.DescriptionType（DEC-281④）：租户可配置的下拉数据源，开通时预置样本“行动建议”。 */
export const talentDescriptionTypes = pgTable(
  'talent_description_types',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    displayOrder: displayOrder(),
    revision: integer('revision').notNull().default(1),
    // 开通预置的类型可能没有操作人（系统写入）
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('talent_description_types_tenant_id').on(t.tenantId, t.id),
    unique('talent_description_types_name').on(t.tenantId, t.name),
  ],
);

export const talentDimensions = pgTable(
  'talent_dimensions',
  {
    id: id(),
    tenantId: tenantId(),
    libraryId: uuid('library_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    definition: text('definition'),
    categoryId: uuid('category_id'),
    displayOrder: displayOrder(),
    enabled: boolean('enabled').notNull().default(true),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('talent_dimensions_tenant_id').on(t.tenantId, t.id),
    // DEC-281⑤：编码、名称都在库内唯一（跨库可重复）
    unique('talent_dimensions_code').on(t.tenantId, t.libraryId, t.code),
    unique('talent_dimensions_name').on(t.tenantId, t.libraryId, t.name),
    check('talent_dimensions_code_format', sql`${t.code} ~ '^[A-Za-z][A-Za-z0-9_]{0,49}$'`),
    index('talent_dimensions_category').on(t.tenantId, t.categoryId),
    foreignKey({
      columns: [t.tenantId, t.libraryId],
      foreignColumns: [talentDimensionLibraries.tenantId, talentDimensionLibraries.id],
      name: 'talent_dimensions_library_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenantId, t.libraryId, t.categoryId],
      foreignColumns: [
        talentDimensionCategories.tenantId,
        talentDimensionCategories.libraryId,
        talentDimensionCategories.id,
      ],
      name: 'talent_dimensions_category_fk',
    }).onDelete('restrict'),
    ...ownerOrg('talent_dimensions', t),
  ],
);

/** 指标明细表：随指标删除级联删除（删除前整组写入审计快照，DEC-019）。 */
function dimensionDetail<T extends Record<string, PgColumnBuilderBase>>(name: string, columns: T) {
  return pgTable(
    name,
    { id: id(), tenantId: tenantId(), dimensionId: uuid('dimension_id').notNull(), ...columns },
    (t) => [
      index(`${name}_dimension`).on(t.tenantId, t.dimensionId),
      foreignKey({
        columns: [t.tenantId, t.dimensionId],
        foreignColumns: [talentDimensions.tenantId, talentDimensions.id],
        name: `${name}_dimension_fk`,
      }).onDelete('cascade'),
    ],
  );
}

export const talentDimensionGrades = pgTable(
  'talent_dimension_grades',
  {
    id: id(),
    tenantId: tenantId(),
    dimensionId: uuid('dimension_id').notNull(),
    gradeOrder: integer('grade_order').notNull(),
    alias: text('alias'),
    description: text('description'),
  },
  (t) => [
    unique('talent_dimension_grades_order').on(t.tenantId, t.dimensionId, t.gradeOrder),
    check('talent_dimension_grades_order_range', sql`${t.gradeOrder} BETWEEN 1 AND 99`),
    foreignKey({
      columns: [t.tenantId, t.dimensionId],
      foreignColumns: [talentDimensions.tenantId, talentDimensions.id],
      name: 'talent_dimension_grades_dimension_fk',
    }).onDelete('cascade'),
  ],
);

export const talentDimensionBehaviors = dimensionDetail('talent_dimension_behaviors', {
  description: text('description').notNull(),
  keyPoints: text('key_points'),
  displayOrder: displayOrder(),
});

/** 发展建议 TalentCenter.Description（DEC-281④）：呈现顺序、类型（必填，取自类型数据源）、描述（必填）。 */
export const talentDimensionSuggestions = pgTable(
  'talent_dimension_suggestions',
  {
    id: id(),
    tenantId: tenantId(),
    dimensionId: uuid('dimension_id').notNull(),
    typeId: uuid('type_id').notNull(),
    description: text('description').notNull(),
    displayOrder: integer('display_order').notNull(),
  },
  (t) => [
    index('talent_dimension_suggestions_dimension').on(t.tenantId, t.dimensionId),
    index('talent_dimension_suggestions_type').on(t.tenantId, t.typeId),
    foreignKey({
      columns: [t.tenantId, t.dimensionId],
      foreignColumns: [talentDimensions.tenantId, talentDimensions.id],
      name: 'talent_dimension_suggestions_dimension_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.typeId],
      foreignColumns: [talentDescriptionTypes.tenantId, talentDescriptionTypes.id],
      name: 'talent_dimension_suggestions_type_fk',
    }).onDelete('restrict'),
  ],
);

export const talentDimensionQuestions = dimensionDetail('talent_dimension_questions', {
  question: text('question').notNull(),
  keyPoints: text('key_points'),
  displayOrder: displayOrder(),
});

export const talentCriterionCategories = pgTable(
  'talent_criterion_categories',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    displayOrder: displayOrder(),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('talent_criterion_categories_tenant_id').on(t.tenantId, t.id),
    ...ownerOrg('talent_criterion_categories', t),
  ],
);

export const talentCriteria = pgTable(
  'talent_criteria',
  {
    id: id(),
    tenantId: tenantId(),
    categoryId: uuid('category_id').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // 人才标准说明 TalentCriterionDescription：能力 / 潜力 / 经历 / 成就 四段
    abilityNote: text('ability_note'),
    potentialNote: text('potential_note'),
    experienceNote: text('experience_note'),
    achievementNote: text('achievement_note'),
    ...owned(),
    ...tracked(),
  },
  (t) => [
    unique('talent_criteria_tenant_id').on(t.tenantId, t.id),
    index('talent_criteria_category').on(t.tenantId, t.categoryId),
    foreignKey({
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [talentCriterionCategories.tenantId, talentCriterionCategories.id],
      name: 'talent_criteria_category_fk',
    }).onDelete('restrict'),
    ...ownerOrg('talent_criteria', t),
  ],
);

/** F-038：沿用现有附件的登记 / 上传 / 待清理生命周期；内容随租户数据库一致快照保存。 */
export const talentModelImageAttachments = pgTable(
  'talent_model_image_attachments',
  {
    id: id(),
    tenantId: tenantId(),
    // 不级联删附件：标准删除时同事务标记待清理，保留文件元数据与删除快照。
    criterionId: uuid('criterion_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('registered'),
    contentBase64: text('content_base64'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('talent_model_image_attachments_tenant_id').on(t.tenantId, t.id),
    index('talent_model_image_attachments_criterion').on(t.tenantId, t.criterionId),
    index('talent_model_image_attachments_cleanup').on(t.tenantId, t.status),
    uniqueIndex('talent_model_image_attachments_current')
      .on(t.tenantId, t.criterionId)
      .where(sql`${t.status} = 'uploaded'`),
    check('talent_model_image_attachments_status', sql`${t.status} IN ('registered','uploaded','pending_cleanup')`),
    check('talent_model_image_attachments_size', sql`${t.byteSize} > 0 AND ${t.byteSize} <= 5242880`),
    check('talent_model_image_attachments_sha256', sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
    check(
      'talent_model_image_attachments_content_type',
      sql`${t.contentType} IN ('image/jpeg','image/gif','image/png','image/bmp')`,
    ),
    check('talent_model_image_attachments_uploaded', sql`${t.status} <> 'uploaded' OR ${t.contentBase64} IS NOT NULL`),
  ],
);

/** 人才标准里的指标（RelationTalentCriterionDimension）：只存引用，指标内容读取时取指标库当前值（TC-R2）。 */
export const talentCriterionDimensions = pgTable(
  'talent_criterion_dimensions',
  {
    id: id(),
    tenantId: tenantId(),
    criterionId: uuid('criterion_id').notNull(),
    dimensionId: uuid('dimension_id').notNull(),
    // TC-R3：只有能力指标可设权重与目标（服务层校验，指标类型取自所属指标库，不在此冗余）；
    // DEC-281①②：数值、1 位小数、可空、可为负，没有范围与合计约束
    weight: numeric('weight', { precision: 10, scale: 1 }),
    target: numeric('target', { precision: 10, scale: 1 }),
    displayOrder: displayOrder(),
    /** DEC-294⑤：关联记录自己的“指标类别”文本（原站 DimensionCategory）。 */
    dimensionCategory: text('dimension_category'),
    ...owned(),
  },
  (t) => [
    unique('talent_criterion_dimensions_once').on(t.tenantId, t.criterionId, t.dimensionId),
    check('talent_criterion_dimensions_category', sql`char_length(${t.dimensionCategory}) <= 50`),
    ...ownerOrg('talent_criterion_dimensions', t),
    index('talent_criterion_dimensions_dimension').on(t.tenantId, t.dimensionId),
    foreignKey({
      columns: [t.tenantId, t.criterionId],
      foreignColumns: [talentCriteria.tenantId, talentCriteria.id],
      name: 'talent_criterion_dimensions_criterion_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.dimensionId],
      foreignColumns: [talentDimensions.tenantId, talentDimensions.id],
      name: 'talent_criterion_dimensions_dimension_fk',
    }).onDelete('restrict'),
  ],
);
