/**
 * R3-T07 个人发展计划 IDP · 配置部分（docs/02_业务建模/28 §1、§2.1、§2.2；Q-M0-115 ②④；DEC-296④⑤）。
 * - 发展计划流程 = 多个子流程串联（IDP-R1）；子流程引用审批中心一条 IDP 类型的流程（口径 K-08），开启方式与开启规则按
 *   Q-M0-115② 的枚举存英文代码；顺序 seq 在流程内连续；
 * - 发展计划模板挂一条流程，带模块（IDP-R7 基本信息固定）、模块配置（Q-M0-115④）、按流程节点的可用按钮（DEC-296④）
 *   与模板通用目标（IDP-R9）；模块、节点配置、通用目标都是模板的组成部分，并发控制用模板的 revision；
 * - 流程与模板带所属组织与“是否向下公开”，数据范围按（用户 × IDP 应用）裁剪（DEC-043）。
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { approvalProcesses } from './approval.js';
import { orgObjects } from './org.js';
import { tenants } from './tenancy.js';

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

/** 所属组织引用组织（RESTRICT）并建范围过滤索引。 */
function ownerOrg(name: string, t: { tenantId: AnyPgColumn; orgId: AnyPgColumn }) {
  return [
    index(`${name}_org`).on(t.tenantId, t.orgId),
    foreignKey({
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
      name: `${name}_org_fk`,
    }).onDelete('restrict'),
  ];
}

const inList = (column: AnyPgColumn, values: readonly string[]) =>
  sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

export const idpProcesses = pgTable(
  'idp_processes',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    orgId: uuid('org_id').notNull(),
    publicDown: boolean('public_down').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    ...tracked(),
  },
  (t) => [unique('idp_processes_tenant_id').on(t.tenantId, t.id), ...ownerOrg('idp_processes', t)],
);

export const idpSubProcesses = pgTable(
  'idp_sub_processes',
  {
    id: id(),
    tenantId: tenantId(),
    processId: uuid('process_id').notNull(),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),
    approvalType: text('approval_type').notNull(),
    approvalProcessId: uuid('approval_process_id').notNull(),
    startMode: text('start_mode').notNull(),
    startTimeType: text('start_time_type'),
    fixedDate: date('fixed_date', { mode: 'string' }),
    referencePoint: text('reference_point'),
    startFrom: text('start_from'),
    days: integer('days'),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('idp_sub_processes_tenant_id').on(t.tenantId, t.id),
    // 调整顺序时先整体挪到 1000 以上再落位，避免逐行更新撞唯一约束
    unique('idp_sub_processes_seq').on(t.tenantId, t.processId, t.seq),
    index('idp_sub_processes_approval').on(t.tenantId, t.approvalProcessId),
    foreignKey({
      columns: [t.tenantId, t.processId],
      foreignColumns: [idpProcesses.tenantId, idpProcesses.id],
      name: 'idp_sub_processes_process_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.approvalProcessId],
      foreignColumns: [approvalProcesses.tenantId, approvalProcesses.id],
      name: 'idp_sub_processes_approval_fk',
    }).onDelete('restrict'),
    check('idp_sub_processes_seq_positive', sql`${t.seq} > 0`),
    check('idp_sub_processes_category', inList(t.category, ['plan', 'review', 'evaluation'])),
    check(
      'idp_sub_processes_approval_type',
      inList(t.approvalType, ['idp_plan', 'idp_mid_review', 'idp_final_review']),
    ),
    check('idp_sub_processes_start_mode', inList(t.startMode, ['auto', 'manual'])),
    check(
      'idp_sub_processes_start_time_type',
      sql`${t.startTimeType} IS NULL OR ${inList(t.startTimeType, ['fixed', 'relative'])}`,
    ),
    check(
      'idp_sub_processes_reference_point',
      sql`${t.referencePoint} IS NULL OR ${inList(t.referencePoint, [
        'plan_start',
        'plan_end',
        'previous_end',
        'employment_effective',
      ])}`,
    ),
    check(
      'idp_sub_processes_start_from',
      sql`${t.startFrom} IS NULL OR ${inList(t.startFrom, ['same_day', 'before', 'after'])}`,
    ),
    check('idp_sub_processes_days', sql`${t.days} IS NULL OR ${t.days} BETWEEN 1 AND 3650`),
    // 手动开启不带规则（IDP-R2）
    check(
      'idp_sub_processes_manual_rule',
      sql`${t.startMode} = 'auto' OR (${t.startTimeType} IS NULL AND ${t.fixedDate} IS NULL
        AND ${t.referencePoint} IS NULL AND ${t.startFrom} IS NULL AND ${t.days} IS NULL)`,
    ),
  ],
);

export const idpTemplates = pgTable(
  'idp_templates',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    orgId: uuid('org_id').notNull(),
    publicDown: boolean('public_down').notNull().default(true),
    processId: uuid('process_id').notNull(),
    status: text('status').notNull().default('draft'),
    ...tracked(),
  },
  (t) => [
    unique('idp_templates_tenant_id').on(t.tenantId, t.id),
    // IDP-R6：模板名称不能重复
    uniqueIndex('idp_templates_name').on(t.tenantId, t.name),
    index('idp_templates_process').on(t.tenantId, t.processId),
    foreignKey({
      columns: [t.tenantId, t.processId],
      foreignColumns: [idpProcesses.tenantId, idpProcesses.id],
      name: 'idp_templates_process_fk',
    }).onDelete('restrict'),
    check('idp_templates_status', inList(t.status, ['draft', 'published'])),
    ...ownerOrg('idp_templates', t),
  ],
);

export const idpTemplateModules = pgTable(
  'idp_template_modules',
  {
    id: id(),
    tenantId: tenantId(),
    templateId: uuid('template_id').notNull(),
    moduleType: text('module_type').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    displayOrder: integer('display_order').notNull().default(0),
    // 发展目标模块（Q-M0-115④ goalSourceSettings）；其他模块为空
    allowCustomGoal: boolean('allow_custom_goal'),
    allowLibraryGoal: boolean('allow_library_goal'),
    competencySource: text('competency_source'),
    goalReviewEnabled: boolean('goal_review_enabled'),
    taskEnabled: boolean('task_enabled'),
    checkNoneGoal: boolean('check_none_goal'),
    // 关键信息模块（IDP-R7）
    keyInfoSources: text('key_info_sources').array(),
    // 盘点结果模块（IDP-R11）
    reviewTimeBasis: text('review_time_basis'),
    planTimeBasis: text('plan_time_basis'),
    reviewCategoryIds: uuid('review_category_ids').array(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('idp_template_modules_tenant_id').on(t.tenantId, t.id),
    index('idp_template_modules_template').on(t.tenantId, t.templateId),
    // 基本信息、关键信息每个模板只能有一个（IDP-R7）
    uniqueIndex('idp_template_modules_singleton')
      .on(t.tenantId, t.templateId, t.moduleType)
      .where(sql`${t.moduleType} IN ('basic', 'key_info')`),
    foreignKey({
      columns: [t.tenantId, t.templateId],
      foreignColumns: [idpTemplates.tenantId, idpTemplates.id],
      name: 'idp_template_modules_template_fk',
    }).onDelete('cascade'),
    check(
      'idp_template_modules_type',
      inList(t.moduleType, ['basic', 'key_info', 'goal', 'review', 'summary', 'talent_review', 'analysis']),
    ),
    check(
      'idp_template_modules_competency_source',
      sql`${t.competencySource} IS NULL OR ${inList(t.competencySource, [
        'current_position',
        'succession_position',
        'rotation_position',
        'promotion_position',
        'talent_pool',
      ])}`,
    ),
    check(
      'idp_template_modules_review_basis',
      sql`(${t.reviewTimeBasis} IS NULL OR ${inList(t.reviewTimeBasis, ['project_start', 'project_end'])})
        AND (${t.planTimeBasis} IS NULL OR ${inList(t.planTimeBasis, ['plan_start', 'plan_end'])})`,
    ),
  ],
);

/** 按流程节点配置的可用按钮（DEC-296④）：每个（模块 × 子流程 × 审批节点）一行。 */
export const idpTemplateNodeSettings = pgTable(
  'idp_template_node_settings',
  {
    tenantId: tenantId(),
    moduleId: uuid('module_id').notNull(),
    subProcessId: uuid('sub_process_id').notNull(),
    nodeKey: text('node_key').notNull(),
    seq: integer('seq').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    buttons: text('buttons')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.moduleId, t.subProcessId, t.nodeKey] }),
    index('idp_template_node_settings_sub_process').on(t.tenantId, t.subProcessId),
    foreignKey({
      columns: [t.tenantId, t.moduleId],
      foreignColumns: [idpTemplateModules.tenantId, idpTemplateModules.id],
      name: 'idp_template_node_settings_module_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.subProcessId],
      foreignColumns: [idpSubProcesses.tenantId, idpSubProcesses.id],
      name: 'idp_template_node_settings_sub_process_fk',
    }).onDelete('restrict'),
    check(
      'idp_template_node_settings_buttons',
      sql`${t.buttons} <@ ARRAY['RowAddIdpGoal','RowEditIdpGoal','RowDeleteIdpGoal','EditModuleContent']::text[]`,
    ),
  ],
);

export const idpTemplateCommonGoals = pgTable(
  'idp_template_common_goals',
  {
    id: id(),
    tenantId: tenantId(),
    templateId: uuid('template_id').notNull(),
    moduleId: uuid('module_id').notNull(),
    name: text('name').notNull(),
    measure: text('measure'),
    suggestion: text('suggestion'),
    displayOrder: integer('display_order').notNull().default(0),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('idp_template_common_goals_tenant_id').on(t.tenantId, t.id),
    index('idp_template_common_goals_template').on(t.tenantId, t.templateId),
    foreignKey({
      columns: [t.tenantId, t.templateId],
      foreignColumns: [idpTemplates.tenantId, idpTemplates.id],
      name: 'idp_template_common_goals_template_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.moduleId],
      foreignColumns: [idpTemplateModules.tenantId, idpTemplateModules.id],
      name: 'idp_template_common_goals_module_fk',
    }).onDelete('cascade'),
  ],
);
