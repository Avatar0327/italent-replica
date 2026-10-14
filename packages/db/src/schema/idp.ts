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
import { employmentEmployees } from './employment.js';
import { jobPositionObjects, jobPostObjects } from './job.js';
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
    endNoticeTemplate: text('end_notice_template'),
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
    /** 关键信息各区块选定的展示字段（“区块.字段”，DEC-318 K-35 补充）；某区块没有即取缺省展示字段。 */
    keyInfoFields: text('key_info_fields').array(),
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

// ───────────── PR-B：发展计划执行（docs/02_业务建模/28 §1 / §2.3 / §2.4；Q-M0-115①）─────────────

/** 员工引用（任职员工，RESTRICT）。 */
const employeeFk = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    columns: [t.tenantId, column],
    foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    name,
  }).onDelete('restrict');

const planDates = () => ({
  startDate: date('start_date', { mode: 'string' }).notNull(),
  endDate: date('end_date', { mode: 'string' }).notNull(),
});

/**
 * 发展计划 Idp：员工、模板（及其流程）、起止、指导人（创建时按角色解析为具体人员，K-20）、状态（Q-M0-115① IdpStatus）。
 * 阶段、目标等是计划的组成部分，并发控制用计划的 revision。数据范围按计划员工的当前任职（K-50）。
 */
export const idpPlans = pgTable(
  'idp_plans',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    employeeId: uuid('employee_id').notNull(),
    templateId: uuid('template_id').notNull(),
    processId: uuid('process_id').notNull(),
    ...planDates(),
    tutorRole: text('tutor_role').notNull(),
    tutorEmployeeId: uuid('tutor_employee_id').notNull(),
    status: text('status').notNull().default('not_started'),
    ...tracked(),
  },
  (t) => [
    unique('idp_plans_tenant_id').on(t.tenantId, t.id),
    index('idp_plans_employee').on(t.tenantId, t.employeeId),
    index('idp_plans_tutor').on(t.tenantId, t.tutorEmployeeId),
    index('idp_plans_template').on(t.tenantId, t.templateId),
    employeeFk('idp_plans_employee_fk', t, t.employeeId),
    employeeFk('idp_plans_tutor_fk', t, t.tutorEmployeeId),
    foreignKey({
      columns: [t.tenantId, t.templateId],
      foreignColumns: [idpTemplates.tenantId, idpTemplates.id],
      name: 'idp_plans_template_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenantId, t.processId],
      foreignColumns: [idpProcesses.tenantId, idpProcesses.id],
      name: 'idp_plans_process_fk',
    }).onDelete('restrict'),
    check('idp_plans_status', inList(t.status, ['not_started', 'running', 'ended', 'terminated'])),
    check(
      'idp_plans_tutor_role',
      inList(t.tutorRole, [
        'direct_manager',
        'indirect_manager',
        'level3_head',
        'level4_head',
        'level5_head',
        'mentor',
        'department_hrbp',
        'department_head',
        'other',
      ]),
    ),
    check('idp_plans_dates', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

/**
 * 阶段 = 计划内的一个子流程实例（IDP-R1）：建计划时按流程的子流程逐段生成；开启后挂一条审批实例（K-41）。
 * 开启失败记原因与次数（DEC-052），last_attempt_on 是调度的幂等键（阶段 + 业务日，K-33）。
 */
export const idpPlanStages = pgTable(
  'idp_plan_stages',
  {
    id: id(),
    tenantId: tenantId(),
    planId: uuid('plan_id').notNull(),
    subProcessId: uuid('sub_process_id').notNull(),
    seq: integer('seq').notNull(),
    status: text('status').notNull().default('pending'),
    approvalInstanceId: uuid('approval_instance_id'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    endedOn: date('ended_on', { mode: 'string' }),
    failureReason: text('failure_reason'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastAttemptOn: date('last_attempt_on', { mode: 'string' }),
  },
  (t) => [
    unique('idp_plan_stages_tenant_id').on(t.tenantId, t.id),
    unique('idp_plan_stages_seq').on(t.tenantId, t.planId, t.seq),
    index('idp_plan_stages_pending').on(t.tenantId, t.status),
    index('idp_plan_stages_instance').on(t.tenantId, t.approvalInstanceId),
    foreignKey({
      columns: [t.tenantId, t.planId],
      foreignColumns: [idpPlans.tenantId, idpPlans.id],
      name: 'idp_plan_stages_plan_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.subProcessId],
      foreignColumns: [idpSubProcesses.tenantId, idpSubProcesses.id],
      name: 'idp_plan_stages_sub_process_fk',
    }).onDelete('restrict'),
    check('idp_plan_stages_status', inList(t.status, ['pending', 'running', 'ended', 'failed'])),
    check('idp_plan_stages_attempts', sql`${t.attemptCount} >= 0`),
  ],
);

const planChild = (name: string, t: { tenantId: AnyPgColumn; planId: AnyPgColumn }) =>
  foreignKey({
    columns: [t.tenantId, t.planId],
    foreignColumns: [idpPlans.tenantId, idpPlans.id],
    name,
  }).onDelete('cascade');

/** 发展目标 IdpGoal（IDP-R8）：自定义 / 胜任力库（指标快照，DEC-307）/ 模板通用目标（建计划时带入，IDP-R9）。 */
export const idpGoals = pgTable(
  'idp_goals',
  {
    id: id(),
    tenantId: tenantId(),
    planId: uuid('plan_id').notNull(),
    moduleId: uuid('module_id').notNull(),
    name: text('name').notNull(),
    measure: text('measure'),
    suggestion: text('suggestion'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    sourceType: text('source_type').notNull(),
    // 通用目标可能随后被删除，只留来源编号（不建外键）
    commonGoalId: uuid('common_goal_id'),
    indicatorId: uuid('indicator_id'),
    indicatorName: text('indicator_name'),
    indicatorDefinition: text('indicator_definition'),
    indicatorCategory: text('indicator_category'),
    displayOrder: integer('display_order').notNull().default(0),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('idp_goals_tenant_id').on(t.tenantId, t.id),
    index('idp_goals_plan').on(t.tenantId, t.planId),
    planChild('idp_goals_plan_fk', t),
    foreignKey({
      columns: [t.tenantId, t.moduleId],
      foreignColumns: [idpTemplateModules.tenantId, idpTemplateModules.id],
      name: 'idp_goals_module_fk',
    }).onDelete('restrict'),
    check('idp_goals_source', inList(t.sourceType, ['custom', 'library', 'common'])),
  ],
);

/** 目标任务 Task（IDP-R15 统一下发；执行人按节点按钮维护）。 */
export const idpGoalTasks = pgTable(
  'idp_goal_tasks',
  {
    id: id(),
    tenantId: tenantId(),
    planId: uuid('plan_id').notNull(),
    goalId: uuid('goal_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    ownerEmployeeId: uuid('owner_employee_id'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('idp_goal_tasks_tenant_id').on(t.tenantId, t.id),
    index('idp_goal_tasks_goal').on(t.tenantId, t.goalId),
    planChild('idp_goal_tasks_plan_fk', t),
    foreignKey({
      columns: [t.tenantId, t.goalId],
      foreignColumns: [idpGoals.tenantId, idpGoals.id],
      name: 'idp_goal_tasks_goal_fk',
    }).onDelete('cascade'),
    employeeFk('idp_goal_tasks_owner_fk', t, t.ownerEmployeeId),
  ],
);

/** 目标回顾 GoalReview：每个目标在每个阶段一份（目标进度、工作成果）。 */
export const idpGoalReviews = pgTable(
  'idp_goal_reviews',
  {
    tenantId: tenantId(),
    planId: uuid('plan_id').notNull(),
    goalId: uuid('goal_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    progress: integer('progress'),
    outcome: text('outcome'),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.goalId, t.stageId] }),
    planChild('idp_goal_reviews_plan_fk', t),
    foreignKey({
      columns: [t.tenantId, t.goalId],
      foreignColumns: [idpGoals.tenantId, idpGoals.id],
      name: 'idp_goal_reviews_goal_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.stageId],
      foreignColumns: [idpPlanStages.tenantId, idpPlanStages.id],
      name: 'idp_goal_reviews_stage_fk',
    }).onDelete('cascade'),
    check('idp_goal_reviews_progress', sql`${t.progress} IS NULL OR ${t.progress} BETWEEN 0 AND 100`),
  ],
);

/** 综述 Analysis：每个综述模块一份（现状分析、待发展项）。 */
export const idpPlanAnalyses = pgTable(
  'idp_plan_analyses',
  {
    tenantId: tenantId(),
    planId: uuid('plan_id').notNull(),
    moduleId: uuid('module_id').notNull(),
    currentAnalysis: text('current_analysis'),
    developmentItems: text('development_items'),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.planId, t.moduleId] }), planChild('idp_plan_analyses_plan_fk', t)],
);

/** 回顾 / 总结 Review：每个回顾 / 总结模块在每个阶段一份（总结、改进方法）。 */
export const idpPlanReviews = pgTable(
  'idp_plan_reviews',
  {
    tenantId: tenantId(),
    planId: uuid('plan_id').notNull(),
    moduleId: uuid('module_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    summary: text('summary'),
    improvement: text('improvement'),
    updatedBy: uuid('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.planId, t.moduleId, t.stageId] }),
    planChild('idp_plan_reviews_plan_fk', t),
    foreignKey({
      columns: [t.tenantId, t.stageId],
      foreignColumns: [idpPlanStages.tenantId, idpPlanStages.id],
      name: 'idp_plan_reviews_stage_fk',
    }).onDelete('cascade'),
  ],
);

/** 带教信息 TutorShip（IDP-R19）：判重键 = 带教人 + 被带教人 + 起止。 */
export const idpTutorships = pgTable(
  'idp_tutorships',
  {
    id: id(),
    tenantId: tenantId(),
    tutorEmployeeId: uuid('tutor_employee_id').notNull(),
    tuteeEmployeeId: uuid('tutee_employee_id').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    remark: text('remark'),
    ...tracked(),
  },
  (t) => [
    unique('idp_tutorships_tenant_id').on(t.tenantId, t.id),
    unique('idp_tutorships_key')
      .on(t.tenantId, t.tutorEmployeeId, t.tuteeEmployeeId, t.startDate, t.endDate)
      .nullsNotDistinct(),
    index('idp_tutorships_tutee').on(t.tenantId, t.tuteeEmployeeId),
    employeeFk('idp_tutorships_tutor_fk', t, t.tutorEmployeeId),
    employeeFk('idp_tutorships_tutee_fk', t, t.tuteeEmployeeId),
    check('idp_tutorships_dates', sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
    check('idp_tutorships_distinct', sql`${t.tutorEmployeeId} <> ${t.tuteeEmployeeId}`),
  ],
);

/** 职业发展信息 Career（IDP-R20）：判重键 = 员工 + 起止。 */
export const idpCareers = pgTable(
  'idp_careers',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    targetPositionId: uuid('target_position_id'),
    strengths: text('strengths'),
    developmentItems: text('development_items'),
    intendedCity: text('intended_city'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    ...tracked(),
  },
  (t) => [
    unique('idp_careers_tenant_id').on(t.tenantId, t.id),
    unique('idp_careers_key').on(t.tenantId, t.employeeId, t.startDate, t.endDate).nullsNotDistinct(),
    employeeFk('idp_careers_employee_fk', t, t.employeeId),
    foreignKey({
      columns: [t.tenantId, t.targetPositionId],
      foreignColumns: [jobPositionObjects.tenantId, jobPositionObjects.id],
      name: 'idp_careers_position_fk',
    }).onDelete('restrict'),
    check('idp_careers_dates', sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  ],
);

/** 轮岗信息 WorkShift（IDP-R21）：判重键 = 员工 + 部门 + 职位 + 职务 + 起止（DEC-318 K-35 / D-063，🟡 加员工）。 */
export const idpWorkShifts = pgTable(
  'idp_work_shifts',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    orgId: uuid('org_id').notNull(),
    positionId: uuid('position_id'),
    /** 职务（DEC-318 K-35 补回，参与判重）。 */
    postId: uuid('post_id'),
    mentorEmployeeId: uuid('mentor_employee_id'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    ...tracked(),
  },
  (t) => [
    unique('idp_work_shifts_tenant_id').on(t.tenantId, t.id),
    unique('idp_work_shifts_key')
      .on(t.tenantId, t.employeeId, t.orgId, t.positionId, t.postId, t.startDate, t.endDate)
      .nullsNotDistinct(),
    employeeFk('idp_work_shifts_employee_fk', t, t.employeeId),
    employeeFk('idp_work_shifts_mentor_fk', t, t.mentorEmployeeId),
    foreignKey({
      columns: [t.tenantId, t.positionId],
      foreignColumns: [jobPositionObjects.tenantId, jobPositionObjects.id],
      name: 'idp_work_shifts_position_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenantId, t.postId],
      foreignColumns: [jobPostObjects.tenantId, jobPostObjects.id],
      name: 'idp_work_shifts_post_fk',
    }).onDelete('restrict'),
    ...ownerOrg('idp_work_shifts', t),
    check('idp_work_shifts_dates', sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`),
  ],
);
