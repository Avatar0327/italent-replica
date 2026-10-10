/**
 * R3-T02 人才评定配置（应用 TEvaluation；docs/02_业务建模/24；设计 docs/08_设计/R3-T02_任职资格与人才评定_设计.md §3.2）。
 * - B1a：活动类型 `ev_activity_types`。活动类型没有组织字段（字典，DEC-121 口径：看全部 ∪ 创建人），无“同步任职记录”
 *   （DEC-025）；`sync_qualification` 缺省 false（不自动写任职资格子集，C2-8 发布时按它判定）。
 * - 后续子 PR（B1b、B3～B6、C1-4、C2）在本文件追加各自的表，迁移各带一个（拆分方案第 2 节）。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
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
const displayOrder = () => integer('display_order').notNull().default(0);
const enabled = () => boolean('enabled').notNull().default(true);

/** 活动类型 ActivityType：名称、启用、顺序号、是否同步任职资格子集（设计 §3.2）。名称租户内唯一，顺序号不要求唯一（Q-M0-152 / #171，照原站）。 */
export const evActivityTypes = pgTable(
  'ev_activity_types',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    displayOrder: displayOrder(),
    enabled: enabled(),
    syncQualification: boolean('sync_qualification').notNull().default(false),
    ...tracked(),
  },
  (t) => [
    unique('ev_activity_types_tenant_id').on(t.tenantId, t.id),
    unique('ev_activity_types_name').on(t.tenantId, t.name),
    index('ev_activity_types_order').on(t.tenantId, t.displayOrder),
  ],
);

/**
 * 活动周期 ActivityCycle：评定窗口期，用于统计（规格 24 §3）。名称租户内唯一（DEC-380①，Q-M0-170）；表单只有名称、没有描述；
 * 没有组织字段（字典，DEC-121 口径）。
 */
export const evCycles = pgTable(
  'ev_cycles',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    enabled: enabled(),
    ...tracked(),
  },
  (t) => [unique('ev_cycles_tenant_id').on(t.tenantId, t.id), unique('ev_cycles_name').on(t.tenantId, t.name)],
);

/**
 * 通用评分项 GeneralScoreItem：任职资格标准之外的评分项（现场表现、业绩等），首版只做评分（设计 §3.2）。
 * 名称租户内唯一（DEC-380②，Q-M0-171）；描述（评价标准）可空、≤500 字。
 */
export const evGeneralItems = pgTable(
  'ev_general_items',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    description: text('description'),
    enabled: enabled(),
    ...tracked(),
  },
  (t) => [
    unique('ev_general_items_tenant_id').on(t.tenantId, t.id),
    unique('ev_general_items_name').on(t.tenantId, t.name),
  ],
);

/**
 * 评审组 ReviewGroup（B3）：评委分组。所属组织 `owner_org_id` 必填、由创建人手选（Q-M0-132 🟢，DEC-324②），范围外与不存在同一
 * 404；所属人 `owner_id` 系统填创建人。照原站（DEC-393，Q-M0-172）没有编码字段，名称不要求唯一（不同所属组织同名可保存），
 * 没有删除入口。原站没有资源集合和向下公开。
 */
export const evReviewGroups = pgTable(
  'ev_review_groups',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id').notNull(),
    ownerOrgId: uuid('owner_org_id').notNull(),
    enabled: enabled(),
    ...tracked(),
  },
  (t) => [
    unique('ev_review_groups_tenant_id').on(t.tenantId, t.id),
    index('ev_review_groups_owner_org').on(t.tenantId, t.ownerOrgId),
    foreignKey({
      columns: [t.tenantId, t.ownerOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
      name: 'ev_review_groups_owner_org_fk',
    }).onDelete('restrict'),
  ],
);

/** 评审组成员：整组编辑；组长 0 或 1 个（DEC-400②，库内唯一索引保证至多 1 个），允许零成员；`seq` 记提交顺序。 */
export const evReviewMembers = pgTable(
  'ev_review_members',
  {
    id: id(),
    tenantId: tenantId(),
    groupId: uuid('group_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    isLeader: boolean('is_leader').notNull().default(false),
    seq: integer('seq').notNull(),
  },
  (t) => [
    unique('ev_review_members_employee').on(t.tenantId, t.groupId, t.employeeId),
    uniqueIndex('ev_review_members_leader')
      .on(t.tenantId, t.groupId)
      .where(sql`${t.isLeader}`),
    index('ev_review_members_employee_idx').on(t.tenantId, t.employeeId),
    foreignKey({
      columns: [t.tenantId, t.groupId],
      foreignColumns: [evReviewGroups.tenantId, evReviewGroups.id],
      name: 'ev_review_members_group_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
      name: 'ev_review_members_employee_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * 评价表 EvaluationForm（B4，标准模式；设计 §3.2）：所属组织 `owner_org_id` 必填手选（DEC-324②，同评审组）；评分方式
 * `score_mode`（按指标 / 评总分）、满分、通过分数、总分计算规则 `total_rule`（评总分时为空）。没有编码字段、名称不要求唯一
 * （照评审组 DEC-393 的经验，原站未证实，需取证 #216）。评分项见 `ev_form_items`，随表整组编辑。
 */
export const evForms = pgTable(
  'ev_forms',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id').notNull(),
    ownerOrgId: uuid('owner_org_id').notNull(),
    enabled: enabled(),
    scoreMode: text('score_mode').notNull(),
    fullScore: numeric('full_score', { precision: 8, scale: 2 }).notNull(),
    passScore: numeric('pass_score', { precision: 8, scale: 2 }).notNull(),
    totalRule: text('total_rule'),
    ...tracked(),
  },
  (t) => [
    unique('ev_forms_tenant_id').on(t.tenantId, t.id),
    index('ev_forms_owner_org').on(t.tenantId, t.ownerOrgId),
    check('ev_forms_score_mode', sql`${t.scoreMode} IN ('by_indicator', 'by_total')`),
    check('ev_forms_total_rule', sql`${t.totalRule} IN ('average', 'weighted', 'sum')`),
    check('ev_forms_total_rule_by_mode', sql`(${t.scoreMode} = 'by_indicator') = (${t.totalRule} IS NOT NULL)`),
    check('ev_forms_scores', sql`${t.fullScore} > 0 AND ${t.passScore} >= 0 AND ${t.passScore} <= ${t.fullScore}`),
    foreignKey({
      columns: [t.tenantId, t.ownerOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
      name: 'ev_forms_owner_org_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * 评价表评分项：`standard`（任职资格标准，一张表至多 1 个）或 `general`（引用通用评分项，任意条）。`weight` 是百分数（0～100，
 * 空 = 未设置）；`hidden_target_ids` 是标准项里设置为不显示的指标 ID（只存引用，指标已被删时读取只给 ID）；`seq` 记提交顺序。
 */
export const evFormItems = pgTable(
  'ev_form_items',
  {
    id: id(),
    tenantId: tenantId(),
    formId: uuid('form_id').notNull(),
    kind: text('kind').notNull(),
    generalItemId: uuid('general_item_id'),
    weight: numeric('weight', { precision: 5, scale: 2 }),
    hiddenTargetIds: uuid('hidden_target_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    seq: integer('seq').notNull(),
  },
  (t) => [
    unique('ev_form_items_seq').on(t.tenantId, t.formId, t.seq),
    uniqueIndex('ev_form_items_standard')
      .on(t.tenantId, t.formId)
      .where(sql`${t.kind} = 'standard'`),
    index('ev_form_items_general').on(t.tenantId, t.generalItemId),
    check('ev_form_items_kind', sql`${t.kind} IN ('standard', 'general')`),
    check(
      'ev_form_items_shape',
      sql`(${t.kind} = 'general') = (${t.generalItemId} IS NOT NULL)
        AND (${t.kind} = 'standard' OR cardinality(${t.hiddenTargetIds}) = 0)`,
    ),
    check('ev_form_items_weight', sql`${t.weight} IS NULL OR (${t.weight} >= 0 AND ${t.weight} <= 100)`),
    foreignKey({
      columns: [t.tenantId, t.formId],
      foreignColumns: [evForms.tenantId, evForms.id],
      name: 'ev_form_items_form_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.generalItemId],
      foreignColumns: [evGeneralItems.tenantId, evGeneralItems.id],
      name: 'ev_form_items_general_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * 评定活动 EvaluationActivity（B5；设计 §3.2）：所属组织 `owner_org_id` 必填手选（DEC-324②，同评审组 / 评价表）；活动编码租户内唯一
 * （AGENTS §10 标识）。适用组织范围、通知范围、申请类别 / 级别范围是 ID 列表（不含下级，需取证 #225）。跨级限制
 * `max_level_jump` 必填 1～5、默认 1，没有“不限”（DEC-372②）。`status` 本 PR 只写 draft，`apply_count` 只读（C2 在活动行锁内维护）。
 * 参评条件见 B6 的 `ev_conditions`，环节见 `ev_chains`。
 */
export const evActivities = pgTable(
  'ev_activities',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    typeId: uuid('type_id').notNull(),
    cycleId: uuid('cycle_id').notNull(),
    year: integer('year').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    ownerId: uuid('owner_id').notNull(),
    ownerOrgId: uuid('owner_org_id').notNull(),
    orgRange: uuid('org_range')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    managerEmployeeId: uuid('manager_employee_id'),
    applicantMode: text('applicant_mode').notNull(),
    categoryIds: uuid('category_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    levelIds: uuid('level_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    maxLevelJump: smallint('max_level_jump').notNull().default(1),
    effectiveDate: date('effective_date'),
    noticeOrgRange: uuid('notice_org_range')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text('status').notNull().default('draft'),
    applyCount: integer('apply_count').notNull().default(0),
    ...tracked(),
  },
  (t) => [
    unique('ev_activities_tenant_id').on(t.tenantId, t.id),
    unique('ev_activities_code').on(t.tenantId, t.code),
    index('ev_activities_owner_org').on(t.tenantId, t.ownerOrgId),
    index('ev_activities_status').on(t.tenantId, t.status),
    check('ev_activities_dates', sql`${t.startDate} <= ${t.endDate}`),
    check('ev_activities_max_level_jump', sql`${t.maxLevelJump} BETWEEN 1 AND 5`),
    check('ev_activities_applicant_mode', sql`${t.applicantMode} IN ('self', 'others', 'both')`),
    check('ev_activities_status', sql`${t.status} IN ('draft', 'published', 'completed')`),
    check('ev_activities_apply_count', sql`${t.applyCount} >= 0`),
    foreignKey({
      columns: [t.tenantId, t.ownerOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
      name: 'ev_activities_owner_org_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenantId, t.typeId],
      foreignColumns: [evActivityTypes.tenantId, evActivityTypes.id],
      name: 'ev_activities_type_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenantId, t.cycleId],
      foreignColumns: [evCycles.tenantId, evCycles.id],
      name: 'ev_activities_cycle_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.tenantId, t.managerEmployeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
      name: 'ev_activities_manager_fk',
    }).onDelete('restrict'),
  ],
);

/**
 * 活动环节（B5）：类型 apply / material / defense / result，每类至多 1 个（唯一索引）；`seq` 记提交顺序（apply 在首、result 在末）。
 * 环节按类型就地更新、保留稳定 ID（C2 的指标明细按环节 ID 引用）。评价表（material / defense）被引用时拒删（外键 restrict 兜底并发）。
 */
export const evChains = pgTable(
  'ev_chains',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    type: text('type').notNull(),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    formId: uuid('form_id'),
    approvalProcessCode: text('approval_process_code'),
    materialTemplate: text('material_template'),
    hardDeadline: boolean('hard_deadline').notNull().default(false),
    allowException: boolean('allow_exception').notNull().default(false),
    exceptionRoles: text('exception_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    transferMode: text('transfer_mode').notNull().default('manual'),
    noticeTemplateCode: text('notice_template_code'),
  },
  (t) => [
    unique('ev_chains_type').on(t.tenantId, t.activityId, t.type),
    index('ev_chains_form').on(t.tenantId, t.formId),
    check('ev_chains_type_check', sql`${t.type} IN ('apply', 'material', 'defense', 'result')`),
    check('ev_chains_dates', sql`${t.startDate} <= ${t.endDate}`),
    check('ev_chains_transfer_mode', sql`${t.transferMode} IN ('auto', 'manual')`),
    foreignKey({
      columns: [t.tenantId, t.activityId],
      foreignColumns: [evActivities.tenantId, evActivities.id],
      name: 'ev_chains_activity_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.tenantId, t.formId],
      foreignColumns: [evForms.tenantId, evForms.id],
      name: 'ev_chains_form_fk',
    }).onDelete('restrict'),
  ],
);
