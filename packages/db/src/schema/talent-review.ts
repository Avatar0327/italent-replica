/**
 * R3-T04 人才盘点（docs/08_设计/R3-T04_人才盘点_设计.md §2；REQ-TR-001）。各 PR 在本文件追加表：
 * PR-A 建准备度共享字典（DEC-301①）；PR-B1 建租户设置、分类、角色、字段目录与选项（设计 §2.2）。表前缀 talent_review_，准备度字典例外：它是 T04 / T05 / T06 共用的字典。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, users } from './tenancy.js';

/**
 * 准备度（`27` §1 Readiness：阶段、描述、颜色、排序）。R3-T05 继任记录、R3-T06 人才池引用 id，端口同时给出 id 与 code；
 * 编码租户唯一、建后不可改；名称（阶段）租户唯一。被引用不可删（引用方登记守卫，409 READINESS_IN_USE），
 * 停用后不可新选用、已有引用保留。没有组织字段：数据范围只认看全部或创建人（DEC-121）。
 */
export const talentReadinessLevels = pgTable(
  'talent_readiness_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color').notNull(),
    sortNo: integer('sort_no').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('talent_readiness_levels_tenant_id').on(t.tenantId, t.id),
    unique('talent_readiness_levels_code').on(t.tenantId, t.code),
    unique('talent_readiness_levels_name').on(t.tenantId, t.name),
    check('talent_readiness_levels_color', sql`${t.color} ~ '^#[0-9a-fA-F]{6}$'`),
    check('talent_readiness_levels_revision', sql`${t.revision} > 0`),
  ],
);

/** 配置对象共用的审计列与租户列（设计 §2 通用约定）：没有组织字段，数据范围只认看全部或创建人（DEC-121）。 */
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const audit = () => ({
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
const revisionCheck = (name: string, revision: AnyPgColumn) => check(name, sql`${revision} > 0`);

/** 盘点租户设置：每租户一行（首次保存时建立，未建立等于全部默认值）。系统主体见设计 §4.1。 */
export const talentReviewSettings = pgTable(
  'talent_review_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    allowSecondaryKeyPositionNomination: boolean('allow_secondary_key_position_nomination').notNull().default(false),
    selfResultVisible: boolean('self_result_visible').notNull().default(false),
    doneHideSuccession: boolean('done_hide_succession').notNull().default(false),
    systemPrincipalUserId: uuid('system_principal_user_id').references(() => users.id),
    ...audit(),
  },
  (t) => [
    unique('talent_review_settings_tenant').on(t.tenantId),
    revisionCheck('talent_review_settings_rev', t.revision),
  ],
);

/** 盘点分类（TR-R9）：名称租户唯一。 */
export const talentReviewCategories = pgTable(
  'talent_review_categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    sortNo: integer('sort_no').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    ...audit(),
  },
  (t) => [
    unique('talent_review_categories_tenant_id').on(t.tenantId, t.id),
    unique('talent_review_categories_name').on(t.tenantId, t.name),
    revisionCheck('talent_review_categories_rev', t.revision),
  ],
);

/** 盘点角色（设计 §3.4）：编码租户唯一、建后不可改；resolver 决定启动采集时如何解析执行人。 */
export const talentReviewRoles = pgTable(
  'talent_review_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    resolver: text('resolver').notNull(),
    sortNo: integer('sort_no').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    ...audit(),
  },
  (t) => [
    unique('talent_review_roles_tenant_id').on(t.tenantId, t.id),
    unique('talent_review_roles_code').on(t.tenantId, t.code),
    unique('talent_review_roles_name').on(t.tenantId, t.name),
    check(
      'talent_review_roles_resolver',
      sql`${t.resolver} IN ('direct_manager','indirect_manager','self','designated')`,
    ),
    revisionCheck('talent_review_roles_rev', t.revision),
  ],
);

/**
 * 盘点字段目录（设计 §2.2）。预置字段由开通租户时安装（created_by 为空 = 系统）；成对字段（校准前 / 后）互相引用，
 * 一对一；number 才有小数位。类型与编码建后不可改（公式、映射、对象值都按它们引用）。
 */
export const talentReviewFields = pgTable(
  'talent_review_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    group: text('field_group').notNull(),
    preset: boolean('preset').notNull().default(false),
    systemWritten: boolean('system_written').notNull().default(false),
    pairRole: text('pair_role'),
    pairFieldId: uuid('pair_field_id'),
    precision: smallint('precision'),
    sortNo: integer('sort_no').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('talent_review_fields_tenant_id').on(t.tenantId, t.id),
    unique('talent_review_fields_code').on(t.tenantId, t.code),
    unique('talent_review_fields_pair').on(t.tenantId, t.pairFieldId),
    foreignKey({
      columns: [t.tenantId, t.pairFieldId],
      foreignColumns: [t.tenantId, t.id],
      name: 'talent_review_fields_pair_fk',
    }).onDelete('restrict'),
    check('talent_review_fields_code_format', sql`${t.code} ~ '^[A-Za-z][A-Za-z0-9_]{0,49}$'`),
    check('talent_review_fields_kind', sql`${t.kind} IN ('number','text','option','multi_option','date','boolean')`),
    check('talent_review_fields_group', sql`${t.group} IN ('result','position','basic','evaluation','calibration')`),
    check('talent_review_fields_pair_role', sql`${t.pairRole} IS NULL OR ${t.pairRole} IN ('before','after')`),
    check('talent_review_fields_pair_target', sql`${t.pairFieldId} IS NULL OR ${t.pairRole} IS NOT NULL`),
    check('talent_review_fields_precision_kind', sql`(${t.kind} = 'number') = (${t.precision} IS NOT NULL)`),
    check('talent_review_fields_precision_range', sql`${t.precision} BETWEEN 0 AND 4`),
    revisionCheck('talent_review_fields_rev', t.revision),
  ],
);

/** 字段选项：公式与端口按稳定的 value 比较（DEC-257）；value 建后不可改、不可删，只能停用。 */
export const talentReviewFieldOptions = pgTable(
  'talent_review_field_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    fieldId: uuid('field_id').notNull(),
    value: text('value').notNull(),
    label: text('label').notNull(),
    sortNo: integer('sort_no').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [
    unique('talent_review_field_options_value').on(t.tenantId, t.fieldId, t.value),
    foreignKey({
      columns: [t.tenantId, t.fieldId],
      foreignColumns: [talentReviewFields.tenantId, talentReviewFields.id],
      name: 'talent_review_field_options_field_fk',
    }).onDelete('cascade'),
  ],
);
