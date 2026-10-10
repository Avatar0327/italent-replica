/**
 * R3-T04 人才盘点（docs/08_设计/R3-T04_人才盘点_设计.md §2；REQ-TR-001）。各 PR 在本文件追加表：
 * PR-A 建准备度共享字典（DEC-301①）；PR-B1 建租户设置、分类、角色、字段目录与选项（设计 §2.2）；
 * PR-B4 建九宫格、轴分段、格子、位置字段占用与比例规则；PR-B5 建计算规则与计算项目。
 * 表前缀 talent_review_，准备度字典例外：它是 T04 / T05 / T06 共用的字典。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
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

/**
 * 九宫格（设计 §2.2；TR-R31～R35）。x / y 轴是字段目录里的单选等级字段（DEC-389① / DEC-403，不再有数值轴），z 是可选的第三维度；编码租户唯一、建后不可改。
 * 预置两个（业绩-能力、绩效-潜力）由种子补装登记表安装（created_by 为空 = 系统）。引用的字段不能删除（restrict）。
 * 子数据（位置字段占用、轴分段、格子、比例规则组）随九宫格整体增删，写入共用九宫格的 revision。
 */
export const talentReviewMatrices = pgTable(
  'talent_review_matrices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    xFieldId: uuid('x_field_id').notNull(),
    yFieldId: uuid('y_field_id').notNull(),
    zFieldId: uuid('z_field_id'),
    xDraggable: boolean('x_draggable').notNull().default(false),
    yDraggable: boolean('y_draggable').notNull().default(false),
    placementSource: text('placement_source').notNull().default('after_else_before'),
    greenRateReference: boolean('green_rate_reference').notNull().default(false),
    preset: boolean('preset').notNull().default(false),
    sortNo: integer('sort_no').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('talent_review_matrices_tenant_id').on(t.tenantId, t.id),
    unique('talent_review_matrices_code').on(t.tenantId, t.code),
    unique('talent_review_matrices_name').on(t.tenantId, t.name),
    ...([t.xFieldId, t.yFieldId, t.zFieldId] as const).map((column, index) =>
      foreignKey({
        columns: [t.tenantId, column],
        foreignColumns: [talentReviewFields.tenantId, talentReviewFields.id],
        name: `talent_review_matrices_${'xyz'[index]}_field_fk`,
      }).onDelete('restrict'),
    ),
    check('talent_review_matrices_code_format', sql`${t.code} ~ '^[A-Za-z][A-Za-z0-9_]{0,49}$'`),
    check('talent_review_matrices_axes', sql`${t.xFieldId} <> ${t.yFieldId}`),
    check('talent_review_matrices_source', sql`${t.placementSource} IN ('before','after','after_else_before')`),
    revisionCheck('talent_review_matrices_rev', t.revision),
  ],
);

const matrixRef = (name: string, table: { tenantId: AnyPgColumn; matrixId: AnyPgColumn }) =>
  foreignKey({
    columns: [table.tenantId, table.matrixId],
    foreignColumns: [talentReviewMatrices.tenantId, talentReviewMatrices.id],
    name,
  }).onDelete('cascade');

/**
 * 位置字段占用（D-20）：字段租户内唯一——覆盖 before-before、after-after、两向 before-after 与同一九宫格 before = after；
 * (matrix, role) 唯一保证最多两行；“恰好两行”由保存命令在同一事务内校验（MATRIX_POSITION_FIELDS_INCOMPLETE）。
 */
export const talentReviewMatrixPositionFields = pgTable(
  'talent_review_matrix_position_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    matrixId: uuid('matrix_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    role: text('role').notNull(),
  },
  (t) => [
    unique('talent_review_matrix_position_fields_field').on(t.tenantId, t.fieldId),
    unique('talent_review_matrix_position_fields_role').on(t.tenantId, t.matrixId, t.role),
    matrixRef('talent_review_matrix_position_fields_matrix_fk', t),
    foreignKey({
      columns: [t.tenantId, t.fieldId],
      foreignColumns: [talentReviewFields.tenantId, talentReviewFields.id],
      name: 'talent_review_matrix_position_fields_field_fk',
    }).onDelete('restrict'),
    check('talent_review_matrix_position_fields_role_check', sql`${t.role} IN ('before','after')`),
  ],
);

/**
 * 轴分段：每轴从低到高 level_no = 1..n，用 option_values（该字段的选项 value，分段间不重复）。轴只允许单选等级字段
 * （DEC-389①），没有数值下界（F-085 删除 lower_bound 列；DEC-403：不做数据迁移，不保留存量兼容）。
 */
export const talentReviewMatrixAxisLevels = pgTable(
  'talent_review_matrix_axis_levels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    matrixId: uuid('matrix_id').notNull(),
    axis: text('axis').notNull(),
    levelNo: smallint('level_no').notNull(),
    name: text('name').notNull(),
    optionValues: text('option_values')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    unique('talent_review_matrix_axis_levels_no').on(t.tenantId, t.matrixId, t.axis, t.levelNo),
    matrixRef('talent_review_matrix_axis_levels_matrix_fk', t),
    check('talent_review_matrix_axis_levels_axis', sql`${t.axis} IN ('x','y')`),
    check('talent_review_matrix_axis_levels_no_range', sql`${t.levelNo} BETWEEN 1 AND 9`),
  ],
);

/** 格子：cell_no 是位置字段里存的格子号；(x_level_no, y_level_no) 由保存命令校验为完整网格。 */
export const talentReviewMatrixCells = pgTable(
  'talent_review_matrix_cells',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    matrixId: uuid('matrix_id').notNull(),
    cellNo: smallint('cell_no').notNull(),
    xLevelNo: smallint('x_level_no').notNull(),
    yLevelNo: smallint('y_level_no').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    /** 格子文字颜色（原站预置为黑色，Q-M0-157）。 */
    textColor: text('text_color').notNull().default('#000000'),
    /** 导出设置里的格子顺序（1..n，整组给出或整组为空；预置“绩效-潜力”为 9-7-8-5-4-6-2-3-1，Q-M0-157）。 */
    exportOrder: smallint('export_order'),
    countsGreen: boolean('counts_green').notNull().default(false),
  },
  (t) => [
    unique('talent_review_matrix_cells_no').on(t.tenantId, t.matrixId, t.cellNo),
    unique('talent_review_matrix_cells_export_order').on(t.tenantId, t.matrixId, t.exportOrder),
    check('talent_review_matrix_cells_text_color', sql`${t.textColor} ~ '^#[0-9a-fA-F]{6}$'`),
    check(
      'talent_review_matrix_cells_export_range',
      sql`${t.exportOrder} IS NULL OR ${t.exportOrder} BETWEEN 1 AND 99`,
    ),
    matrixRef('talent_review_matrix_cells_matrix_fk', t),
    check('talent_review_matrix_cells_color', sql`${t.color} ~ '^#[0-9a-fA-F]{6}$'`),
    check('talent_review_matrix_cells_no_range', sql`${t.cellNo} BETWEEN 1 AND 99`),
  ],
);

/** 比例规则组（TR-R33）：一个九宫格可有多组，最多一组默认；组 id 稳定（项目按它引用）。 */
export const talentReviewRatioRuleGroups = pgTable(
  'talent_review_ratio_rule_groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    matrixId: uuid('matrix_id').notNull(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    controlScope: text('control_scope').notNull(),
    controlMode: text('control_mode').notNull(),
    minPopulation: integer('min_population').notNull().default(0),
    sortNo: integer('sort_no').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('talent_review_ratio_rule_groups_tenant_id').on(t.tenantId, t.id),
    unique('talent_review_ratio_rule_groups_name').on(t.tenantId, t.matrixId, t.name),
    uniqueIndex('talent_review_ratio_rule_groups_default')
      .on(t.tenantId, t.matrixId)
      .where(sql`${t.isDefault}`),
    matrixRef('talent_review_ratio_rule_groups_matrix_fk', t),
    check('talent_review_ratio_rule_groups_scope', sql`${t.controlScope} IN ('project_meeting','flow')`),
    check('talent_review_ratio_rule_groups_mode', sql`${t.controlMode} IN ('warn','block')`),
    check('talent_review_ratio_rule_groups_population', sql`${t.minPopulation} >= 0`),
  ],
);

/** 比例规则：运算符 + 百分比（范围运算含两端）；组内规则为“且”。 */
export const talentReviewRatioRules = pgTable(
  'talent_review_ratio_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    groupId: uuid('group_id').notNull(),
    operator: text('operator').notNull(),
    pctLow: numeric('pct_low', { precision: 5, scale: 2 }).notNull(),
    pctHigh: numeric('pct_high', { precision: 5, scale: 2 }),
    sortNo: integer('sort_no').notNull().default(0),
  },
  (t) => [
    unique('talent_review_ratio_rules_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      columns: [t.tenantId, t.groupId],
      foreignColumns: [talentReviewRatioRuleGroups.tenantId, talentReviewRatioRuleGroups.id],
      name: 'talent_review_ratio_rules_group_fk',
    }).onDelete('cascade'),
    check('talent_review_ratio_rules_operator', sql`${t.operator} IN ('gt','lt','gte','lte','between')`),
    check('talent_review_ratio_rules_pct', sql`${t.pctLow} BETWEEN 0 AND 100`),
    check(
      'talent_review_ratio_rules_between',
      sql`(${t.operator} = 'between') = (${t.pctHigh} IS NOT NULL)
        AND (${t.pctHigh} IS NULL OR ${t.pctHigh} BETWEEN ${t.pctLow} AND 100)`,
    ),
  ],
);

/**
 * 规则的格子集合。按 (matrix, cell_no) 引用格子，被规则引用的格子不能删（NO ACTION：随九宫格整体删除时，
 * 级联删完同一语句里的格子与规则后才检查，所以不会误拦）。
 */
export const talentReviewRatioRuleCells = pgTable(
  'talent_review_ratio_rule_cells',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ruleId: uuid('rule_id').notNull(),
    matrixId: uuid('matrix_id').notNull(),
    cellNo: smallint('cell_no').notNull(),
  },
  (t) => [
    unique('talent_review_ratio_rule_cells_cell').on(t.tenantId, t.ruleId, t.cellNo),
    foreignKey({
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [talentReviewRatioRules.tenantId, talentReviewRatioRules.id],
      name: 'talent_review_ratio_rule_cells_rule_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.matrixId, t.cellNo],
      foreignColumns: [
        talentReviewMatrixCells.tenantId,
        talentReviewMatrixCells.matrixId,
        talentReviewMatrixCells.cellNo,
      ],
      name: 'talent_review_ratio_rule_cells_cell_fk',
    }).onDelete('no action'),
  ],
);

/**
 * 盘点计算规则（设计 §2.2 calc_rules；TR-R27～R30）：一组按优先级与引用依赖执行的计算项目。revision 随规则或其项目的任何
 * 保存递增——calc run 冻结时记录它，发布前核对“规则已改”（设计 §4.5(e)）。名称租户唯一。
 * 没有组织字段：数据范围只认看全部或创建人（DEC-121）。
 */
export const talentReviewCalcRules = pgTable(
  'talent_review_calc_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    assessmentLatestWindow: text('assessment_latest_window').notNull().default('before_project_end'),
    description: text('description'),
    sortNo: integer('sort_no').notNull().default(0),
    ...audit(),
  },
  (t) => [
    unique('talent_review_calc_rules_tenant_id').on(t.tenantId, t.id),
    unique('talent_review_calc_rules_name').on(t.tenantId, t.name),
    check(
      'talent_review_calc_rules_window',
      sql`${t.assessmentLatestWindow} IN ('before_project_end','before_project_start')`,
    ),
    revisionCheck('talent_review_calc_rules_rev', t.revision),
  ],
);

/**
 * 计算项目：一个目标盘点字段 + 公式 + 优先级。目标字段在规则内唯一，保存后只读（改目标 = 删除再新增）；
 * uses_ranking 由公式派生（含排名函数，待办触发时不计算，DEC-260）。
 * F-082：formula_binding 区分公式存储形态——bound 存规范文本（字段引用为句柄 `@{tr-field:<uuid>}`），
 * legacy / unresolved 存原来的名称文本（unresolved 的原因码在 binding_issue）；存量行迁移后为 legacy，
 * 平台改绑命令把它们变成 bound（F082-5）。优先级 0～1000000（DEC-374⑥）。
 */
export const talentReviewCalcRuleItems = pgTable(
  'talent_review_calc_rule_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    ruleId: uuid('rule_id').notNull(),
    targetFieldId: uuid('target_field_id').notNull(),
    priority: integer('priority').notNull().default(0),
    description: text('description'),
    formula: text('formula').notNull(),
    sortNo: integer('sort_no').notNull().default(0),
    usesRanking: boolean('uses_ranking').notNull().default(false),
    formulaBinding: text('formula_binding').notNull().default('legacy'),
    bindingIssue: text('binding_issue'),
  },
  (t) => [
    unique('talent_review_calc_rule_items_tenant_id').on(t.tenantId, t.id),
    unique('talent_review_calc_rule_items_target').on(t.tenantId, t.ruleId, t.targetFieldId),
    foreignKey({
      columns: [t.tenantId, t.ruleId],
      foreignColumns: [talentReviewCalcRules.tenantId, talentReviewCalcRules.id],
      name: 'talent_review_calc_rule_items_rule_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.targetFieldId],
      foreignColumns: [talentReviewFields.tenantId, talentReviewFields.id],
      name: 'talent_review_calc_rule_items_field_fk',
    }).onDelete('restrict'),
    check('talent_review_calc_rule_items_priority', sql`${t.priority} BETWEEN 0 AND 1000000`),
    check('talent_review_calc_rule_items_binding', sql`${t.formulaBinding} IN ('bound','legacy','unresolved')`),
  ],
);

/**
 * 计算项目引用的盘点字段（F-082 契约 §1.3），由规范文本或改绑派生。bound 行的引用全部是 kind = 'bound'，
 * 等于规范文本中句柄 ID 的集合；非 bound 行（legacy / unresolved）只有 kind = 'candidate'：改绑失败时的认定与
 * 字段改名时对文本兜底的固化，只增不减，项目变为 bound 或被删除时才清除。目标字段不进本表（已有 target_field_id 外键）。
 * 字段外键 restrict：被引用的字段库层不可删，守卫是正常路径、外键是最后一道防线。
 */
export const talentReviewCalcItemRefs = pgTable(
  'talent_review_calc_item_refs',
  {
    tenantId: tenantId(),
    itemId: uuid('item_id').notNull(),
    fieldId: uuid('field_id').notNull(),
    kind: text('kind').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.itemId, t.fieldId] }),
    foreignKey({
      columns: [t.tenantId, t.itemId],
      foreignColumns: [talentReviewCalcRuleItems.tenantId, talentReviewCalcRuleItems.id],
      name: 'talent_review_calc_item_refs_item_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.fieldId],
      foreignColumns: [talentReviewFields.tenantId, talentReviewFields.id],
      name: 'talent_review_calc_item_refs_field_fk',
    }).onDelete('restrict'),
    index('talent_review_calc_item_refs_field').on(t.tenantId, t.fieldId),
    check('talent_review_calc_item_refs_kind', sql`${t.kind} IN ('bound','candidate')`),
  ],
);

/**
 * 字段目录版本（F-082 契约 §1.3、§3.4）：字段“名称 → ID”映射的版本，每租户一行。新建 / 删除字段或改名时在同一事务里
 * 推进（新值 = greatest(version + 1, 当前毫秒时间戳)，租户恢复后也不会回到客户端已有的旧值）；
 * 改名在这一行上串行（锁次序里的 V）。
 */
export const talentReviewFieldCatalogVersions = pgTable('talent_review_field_catalog_versions', {
  tenantId: tenantId().primaryKey(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
});
