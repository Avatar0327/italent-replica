/**
 * R3-T01 人才标准与指标库（docs/02_业务建模/23 §2.1；REQ-TC-001）。
 * - 指标库按 能力 / 潜力 / 经历 三类（TC-R1）；指标的等级 / 行为 / 发展建议 / 面试问题各一张明细表，随指标整组替换；
 * - 人才标准里的指标只存引用（TC-R2）：关系表只有指标 ID、权重、目标与顺序，不复制指标内容；
 * - 被引用的指标、还有指标的指标库、还有标准的分类不能删除（TC-R5）：外键 RESTRICT 兜底，服务层先给出明确错误；
 * - 都没有组织字段：数据范围只认“看全部”或“使用用户（创建人）”（DEC-121 口径），created_by 即创建人。
 */
import { sql } from 'drizzle-orm';
import {
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
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenancy.js';

type DimensionType = 'ability' | 'potential' | 'experience';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
/** 可编辑对象的公共列：revision 乐观锁、创建人（“使用用户”范围）、UTC 事件时间。 */
const tracked = () => ({
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
const displayOrder = () => integer('display_order').notNull().default(0);

export const talentDimensionLibraries = pgTable(
  'talent_dimension_libraries',
  {
    id: id(),
    tenantId: tenantId(),
    type: text('type').$type<DimensionType>().notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    displayOrder: displayOrder(),
    ...tracked(),
  },
  (t) => [
    unique('talent_dimension_libraries_tenant_id').on(t.tenantId, t.id),
    check('talent_dimension_libraries_type', sql`${t.type} IN ('ability', 'potential', 'experience')`),
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
    category: text('category'),
    displayOrder: displayOrder(),
    enabled: boolean('enabled').notNull().default(true),
    ...tracked(),
  },
  (t) => [
    unique('talent_dimensions_tenant_id').on(t.tenantId, t.id),
    unique('talent_dimensions_code').on(t.tenantId, t.code),
    index('talent_dimensions_library').on(t.tenantId, t.libraryId),
    foreignKey({
      columns: [t.tenantId, t.libraryId],
      foreignColumns: [talentDimensionLibraries.tenantId, talentDimensionLibraries.id],
      name: 'talent_dimensions_library_fk',
    }).onDelete('restrict'),
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

export const talentDimensionSuggestions = dimensionDetail('talent_dimension_suggestions', {
  suggestionType: text('suggestion_type'),
  description: text('description').notNull(),
  displayOrder: displayOrder(),
});

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
    ...tracked(),
  },
  (t) => [unique('talent_criterion_categories_tenant_id').on(t.tenantId, t.id)],
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
    // TC-R3：只有能力指标可设权重与目标（服务层校验，指标类型取自所属指标库，不在此冗余）
    weight: numeric('weight', { precision: 5, scale: 2 }),
    target: numeric('target', { precision: 8, scale: 2 }),
    displayOrder: displayOrder(),
  },
  (t) => [
    unique('talent_criterion_dimensions_once').on(t.tenantId, t.criterionId, t.dimensionId),
    index('talent_criterion_dimensions_dimension').on(t.tenantId, t.dimensionId),
    check('talent_criterion_dimensions_weight', sql`${t.weight} BETWEEN 0 AND 100`),
    check('talent_criterion_dimensions_target', sql`${t.target} >= 0`),
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
