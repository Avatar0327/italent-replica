/**
 * 360 度评估（R3-T03，docs/02_业务建模/25）。360 是独立的人员与评价关系体系（DEC-027）：
 * 自有人员表（内外部同表、邮箱为键）与活动授权；与组织员工只经“同步”衔接（DEC-030）。
 * 360 身份照 DEC-280 走平台“身份 × 应用”（应用 Survey360），由企业管理员在“用户授权”里授予。
 * 匿名口径按 DEC-149：不设最少评价人数阈值，只有活动级“作答页评价者姓名 / 评价角色”两个开关。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
import { tenants, users } from './tenancy.js';

const id = () => uuid('id').primaryKey().defaultRandom();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const at = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => at('created_at').notNull().defaultNow();
const revision = () => integer('revision').notNull().default(1);
const uuids = (name: string) =>
  uuid(name)
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`);

/**
 * 360 租户级设置（DEC-280⑤）：“精细化权限”开启后，没有“全部活动”按钮的 360 身份只看到数据权限范围内的人员。
 * 360 身份本身走平台“身份 × 应用”（应用 Survey360）与用户授权，360 侧不另存管理员。
 */
export const survey360Settings = pgTable('survey360_settings', {
  tenantId: tenantId().primaryKey(),
  finePermission: boolean('fine_permission').notNull().default(false),
  revision: revision(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** 360 人员（`I360Cloud.Personnel`）：邮箱为键；组织信息是同步时写入的文本快照，不实时引用组织对象。 */
export const survey360People = pgTable(
  'survey360_people',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    mobile: text('mobile'),
    staffCode: text('staff_code'),
    department: text('department'),
    position: text('position'),
    superiorPersonId: uuid('superior_person_id'),
    /** 当前挂接的组织员工（DEC-030 ①）；未同步的外部人员为空。 */
    employeeId: uuid('employee_id'),
    /** 换挂前的员工 ID（原站 OldUserId）；变化明细见关联日志。 */
    previousEmployeeId: uuid('previous_employee_id'),
    /** 同步后邮箱锁定，360 端不可改（DEC-030 ③）。 */
    emailLocked: boolean('email_locked').notNull().default(false),
    source: text('source').notNull(),
    revision: revision(),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('survey360_people_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('survey360_people_email').on(t.tenantId, sql`lower(${t.email})`),
    uniqueIndex('survey360_people_employee')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.employeeId} IS NOT NULL`),
    foreignKey({
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
      name: 'survey360_people_employee_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.superiorPersonId],
      foreignColumns: [t.tenantId, t.id],
      name: 'survey360_people_superior_fk',
    }),
    check('survey360_people_source', sql`${t.source} IN ('manual', 'import', 'org_sync')`),
    check('survey360_people_name_nonempty', sql`btrim(${t.name}) <> ''`),
    check('survey360_people_email_nonempty', sql`btrim(${t.email}) <> ''`),
  ],
);

/** 人员 ↔ 组织员工的关联变更日志（DEC-030 ①，借鉴测评中心关联记录日志）；只追加。 */
export const survey360PersonLinkLogs = pgTable(
  'survey360_person_link_logs',
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid('person_id').notNull(),
    employeeId: uuid('employee_id').notNull(),
    previousEmployeeId: uuid('previous_employee_id'),
    /** 匹配原因：new 新建 / employee 已挂接 / admin_confirm 管理员确认冲突。 */
    reason: text('reason').notNull(),
    matchedBy: text('matched_by')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    actorUserId: uuid('actor_user_id'),
    commandId: text('command_id'),
    occurredAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.tenantId, t.personId],
      foreignColumns: [survey360People.tenantId, survey360People.id],
      name: 'survey360_person_link_logs_person_fk',
    }),
    check('survey360_person_link_logs_reason', sql`${t.reason} IN ('new', 'employee', 'admin_confirm')`),
  ],
);

/** 首次同步的查重冲突（邮箱 / 手机 / 工号命中已有未挂接人员），由管理员确认（DEC-030 ②，AC-360-15）。 */
export const survey360SyncConflicts = pgTable(
  'survey360_sync_conflicts',
  {
    id: id(),
    tenantId: tenantId(),
    employeeId: uuid('employee_id').notNull(),
    candidatePersonIds: uuids('candidate_person_ids'),
    matchedBy: text('matched_by')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: text('status').notNull().default('pending'),
    resolution: text('resolution'),
    resolvedPersonId: uuid('resolved_person_id'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: at('resolved_at'),
    revision: revision(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('survey360_sync_conflicts_pending')
      .on(t.tenantId, t.employeeId)
      .where(sql`${t.status} = 'pending'`),
    foreignKey({
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
      name: 'survey360_sync_conflicts_employee_fk',
    }),
    check('survey360_sync_conflicts_status', sql`${t.status} IN ('pending', 'resolved', 'ignored')`),
  ],
);

/** 租户评价角色（`UserRoles`）：内置 6 个 + 自定义，租户最多 90 个（DEC-033）。 */
export const survey360Roles = pgTable(
  'survey360_roles',
  {
    id: id(),
    tenantId: tenantId(),
    /** 内置角色编码（self / superior / peer / subordinate / customer / other）；自定义为空。 */
    code: text('code'),
    name: text('name').notNull(),
    /** 作答页“显示固定文字”时展示的内容。 */
    displayText: text('display_text'),
    sort: integer('sort').notNull().default(0),
    revision: revision(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_roles_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('survey360_roles_code')
      .on(t.tenantId, t.code)
      .where(sql`${t.code} IS NOT NULL`),
    uniqueIndex('survey360_roles_name').on(t.tenantId, t.name),
  ],
);

/** 套卷（`QuestionnaireInfo`）：草稿 / 已启用 / 已使用（E3-R2）。 */
export const survey360Questionnaires = pgTable(
  'survey360_questionnaires',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('draft'),
    scoreMethod: text('score_method').notNull().default('weighted_average'),
    guide: text('guide'),
    /** 优秀线（满分的百分比）与优秀率上限（E3-R9，仅一次评价多人）。 */
    excellentLinePercent: numeric('excellent_line_percent'),
    excellentMaxRate: numeric('excellent_max_rate'),
    /** 题库里的套卷模板（PR-B，E3-R10）：与套卷同表同结构，引用即复制；套卷入口与模板入口互不可见。 */
    template: boolean('template').notNull().default(false),
    /**
     * 已使用套卷的计分口径（内容 / 权重 / 计分方式）版本（PR-B 第 2 / 3 轮 P2-7、P2-3）：每改一次在套卷行锁内 +1，
     * 高于计分批次记下的版本时，用到它的活动报告失效。只记在套卷上，不在套卷编辑里写活动 / 对象行（锁顺序
     * 活动 → 套卷，F-053）；用锁内递增的版本号而不是请求时间，等锁期间的计分不会被误判为“口径未变”。
     */
    scoringRevision: integer('scoring_revision').notNull().default(0),
    deleted: boolean('deleted').notNull().default(false),
    revision: revision(),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_questionnaires_tenant_id').on(t.tenantId, t.id),
    check('survey360_questionnaires_type', sql`${t.type} IN ('key_behavior', 'rating')`),
    check('survey360_questionnaires_status', sql`${t.status} IN ('draft', 'enabled', 'used')`),
    check('survey360_questionnaires_method', sql`${t.scoreMethod} IN ('weighted_average', 'weighted_sum')`),
  ],
);

const inQuestionnaire = () => ({
  id: id(),
  tenantId: tenantId(),
  questionnaireId: uuid('questionnaire_id').notNull(),
  /** 客户端给出的稳定键：已使用的套卷只能按键原位修改文字与权重（E3-R2）。 */
  key: text('key').notNull(),
  sort: integer('sort').notNull().default(0),
});
const questionnaireFk = (name: string, tenant: PgColumn, questionnaire: PgColumn) =>
  foreignKey({
    columns: [tenant, questionnaire],
    foreignColumns: [survey360Questionnaires.tenantId, survey360Questionnaires.id],
    name,
  });

/** 套卷的评价角色与权重（E3-R4、E3-R5）。 */
export const survey360QuestionnaireRoles = pgTable(
  'survey360_questionnaire_roles',
  {
    ...inQuestionnaire(),
    roleId: uuid('role_id').notNull(),
    weight: integer('weight').notNull(),
  },
  (t) => [
    unique('survey360_questionnaire_roles_role').on(t.questionnaireId, t.roleId),
    unique('survey360_questionnaire_roles_key').on(t.questionnaireId, t.key),
    questionnaireFk('survey360_questionnaire_roles_questionnaire_fk', t.tenantId, t.questionnaireId),
    foreignKey({
      columns: [t.tenantId, t.roleId],
      foreignColumns: [survey360Roles.tenantId, survey360Roles.id],
      name: 'survey360_questionnaire_roles_role_fk',
    }),
    check('survey360_questionnaire_roles_weight', sql`${t.weight} >= 0`),
  ],
);

/** 选项组（关键行为题目的选项 / 等级评定的评定等级）。 */
export const survey360Scales = pgTable(
  'survey360_scales',
  { ...inQuestionnaire(), name: text('name').notNull() },
  (t) => [
    unique('survey360_scales_tenant_id').on(t.tenantId, t.id),
    unique('survey360_scales_key').on(t.questionnaireId, t.key),
    questionnaireFk('survey360_scales_questionnaire_fk', t.tenantId, t.questionnaireId),
  ],
);

/** 选项（E3-R6）：不计分选项（不做评价）不计入统计，不按 0 分算。 */
export const survey360ScaleOptions = pgTable(
  'survey360_scale_options',
  {
    ...inQuestionnaire(),
    scaleId: uuid('scale_id').notNull(),
    label: text('label').notNull(),
    value: doublePrecision('value'),
    notScored: boolean('not_scored').notNull().default(false),
    remarkRequired: boolean('remark_required').notNull().default(false),
  },
  (t) => [
    unique('survey360_scale_options_tenant_id').on(t.tenantId, t.id),
    unique('survey360_scale_options_key').on(t.questionnaireId, t.key),
    questionnaireFk('survey360_scale_options_questionnaire_fk', t.tenantId, t.questionnaireId),
    foreignKey({
      columns: [t.tenantId, t.scaleId],
      foreignColumns: [survey360Scales.tenantId, survey360Scales.id],
      name: 'survey360_scale_options_scale_fk',
    }),
    check('survey360_scale_options_value', sql`${t.notScored} OR ${t.value} IS NOT NULL`),
  ],
);

/** 指标（复合 / 基础）：parent 为空的是顶层指标；roleIds 为空表示全部角色评价（E3-R8）。 */
export const survey360Dimensions = pgTable(
  'survey360_dimensions',
  {
    ...inQuestionnaire(),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    definition: text('definition'),
    weight: doublePrecision('weight').notNull(),
    /** 等级评定的基础指标所用评定等级。 */
    scaleId: uuid('scale_id'),
    roleIds: uuids('role_ids'),
  },
  (t) => [
    unique('survey360_dimensions_tenant_id').on(t.tenantId, t.id),
    unique('survey360_dimensions_key').on(t.questionnaireId, t.key),
    questionnaireFk('survey360_dimensions_questionnaire_fk', t.tenantId, t.questionnaireId),
    foreignKey({
      columns: [t.tenantId, t.parentId],
      foreignColumns: [t.tenantId, t.id],
      name: 'survey360_dimensions_parent_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.scaleId],
      foreignColumns: [survey360Scales.tenantId, survey360Scales.id],
      name: 'survey360_dimensions_scale_fk',
    }),
    check('survey360_dimensions_weight', sql`${t.weight} >= 0`),
  ],
);

/** 题目（关键行为套卷）。 */
export const survey360Questions = pgTable(
  'survey360_questions',
  {
    ...inQuestionnaire(),
    dimensionId: uuid('dimension_id').notNull(),
    text: text('text').notNull(),
    weight: doublePrecision('weight').notNull(),
    scaleId: uuid('scale_id').notNull(),
    allowRemark: boolean('allow_remark').notNull().default(false),
    roleIds: uuids('role_ids'),
  },
  (t) => [
    unique('survey360_questions_tenant_id').on(t.tenantId, t.id),
    unique('survey360_questions_key').on(t.questionnaireId, t.key),
    questionnaireFk('survey360_questions_questionnaire_fk', t.tenantId, t.questionnaireId),
    foreignKey({
      columns: [t.tenantId, t.dimensionId],
      foreignColumns: [survey360Dimensions.tenantId, survey360Dimensions.id],
      name: 'survey360_questions_dimension_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.scaleId],
      foreignColumns: [survey360Scales.tenantId, survey360Scales.id],
      name: 'survey360_questions_scale_fk',
    }),
    check('survey360_questions_weight', sql`${t.weight} >= 0`),
  ],
);

/** 活动（`ActivityCloud`）：草稿 / 已启用 / 已停用。 */
export const survey360Activities = pgTable(
  'survey360_activities',
  {
    id: id(),
    tenantId: tenantId(),
    name: text('name').notNull(),
    scene: text('scene'),
    status: text('status').notNull().default('draft'),
    /** 评价形式：一次评价一人 / 一次评价多人。 */
    form: text('form').notNull(),
    welcome: text('welcome'),
    /** 匿名开关一（DEC-149）：作答页是否显示评价者姓名。 */
    showAppraiserName: boolean('show_appraiser_name').notNull(),
    /** 匿名开关一（DEC-149）：作答页评价角色显示方式——角色名称 / 固定文字 / 不显示。 */
    roleDisplay: text('role_display').notNull(),
    ownerUserId: uuid('owner_user_id').notNull(),
    /** 首次启用时间。 */
    startedAt: at('started_at'),
    /** 最近一次停用（结束）时间：DEC-262 的“最近一次”按此倒序。 */
    endedAt: at('ended_at'),
    scoreBatchId: uuid('score_batch_id'),
    scoredAt: at('scored_at'),
    /** 计分后的作答数据变化（清除作答、屏蔽 / 取消屏蔽）：非空即报告失效，须启用 → 停用重算（`25` §10.3 ⑫）。 */
    dataChangedAt: at('data_changed_at'),
    /** 最近一次“屏蔽疑似无效数据”：2 小时内只允许一次（§10.1）。 */
    suspectBlockedAt: at('suspect_blocked_at'),
    /** 最近一次“生成 / 更新报告”：2 小时内只允许一次（§10.3 ⑭）。 */
    reportsRequestedAt: at('reports_requested_at'),
    deleted: boolean('deleted').notNull().default(false),
    revision: revision(),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_activities_tenant_id').on(t.tenantId, t.id),
    check('survey360_activities_status', sql`${t.status} IN ('draft', 'enabled', 'disabled')`),
    check('survey360_activities_form', sql`${t.form} IN ('single', 'multiple')`),
    check('survey360_activities_role_display', sql`${t.roleDisplay} IN ('name', 'fixed_text', 'hidden')`),
  ],
);

const activityFk = (name: string, tenant: PgColumn, activity: PgColumn) =>
  foreignKey({
    columns: [tenant, activity],
    foreignColumns: [survey360Activities.tenantId, survey360Activities.id],
    name,
  });

/** 活动授权：一般管理员只能看到自己持有或被授权的活动（AC-360-13）。 */
export const survey360ActivityGrants = pgTable(
  'survey360_activity_grants',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_activity_grants_user').on(t.activityId, t.userId),
    activityFk('survey360_activity_grants_activity_fk', t.tenantId, t.activityId),
  ],
);

/** 评价对象（`ObjectRelation`）：活动 × 人员。移除只做标记，保留快照。 */
export const survey360Objects = pgTable(
  'survey360_objects',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    personId: uuid('person_id').notNull(),
    sort: integer('sort').notNull().default(0),
    removed: boolean('removed').notNull().default(false),
    /** 个人报告生成时间（PR-B 报告生成时写入）；DEC-262 只取报告晚于本次结束时间的活动。 */
    reportGeneratedAt: at('report_generated_at'),
    revision: revision(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_objects_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('survey360_objects_person')
      .on(t.activityId, t.personId)
      .where(sql`NOT ${t.removed}`),
    activityFk('survey360_objects_activity_fk', t.tenantId, t.activityId),
    foreignKey({
      columns: [t.tenantId, t.personId],
      foreignColumns: [survey360People.tenantId, survey360People.id],
      name: 'survey360_objects_person_fk',
    }),
  ],
);

/** 评价对象 × 套卷（1–3 个，E3-R3）。 */
export const survey360ObjectQuestionnaires = pgTable(
  'survey360_object_questionnaires',
  {
    id: id(),
    tenantId: tenantId(),
    objectId: uuid('object_id').notNull(),
    questionnaireId: uuid('questionnaire_id').notNull(),
  },
  (t) => [
    unique('survey360_object_questionnaires_pair').on(t.objectId, t.questionnaireId),
    foreignKey({
      columns: [t.tenantId, t.objectId],
      foreignColumns: [survey360Objects.tenantId, survey360Objects.id],
      name: 'survey360_object_questionnaires_object_fk',
    }),
    questionnaireFk('survey360_object_questionnaires_questionnaire_fk', t.tenantId, t.questionnaireId),
  ],
);

/** 评价关系（`AppraiserRelation`）：评价对象 × 评价者 × 角色。 */
export const survey360Relations = pgTable(
  'survey360_relations',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    objectId: uuid('object_id').notNull(),
    appraiserPersonId: uuid('appraiser_person_id').notNull(),
    roleId: uuid('role_id').notNull(),
    source: text('source').notNull(),
    removed: boolean('removed').notNull().default(false),
    revision: revision(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_relations_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('survey360_relations_pair')
      .on(t.objectId, t.appraiserPersonId)
      .where(sql`NOT ${t.removed}`),
    index('survey360_relations_appraiser').on(t.tenantId, t.activityId, t.appraiserPersonId),
    activityFk('survey360_relations_activity_fk', t.tenantId, t.activityId),
    foreignKey({
      columns: [t.tenantId, t.objectId],
      foreignColumns: [survey360Objects.tenantId, survey360Objects.id],
      name: 'survey360_relations_object_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.appraiserPersonId],
      foreignColumns: [survey360People.tenantId, survey360People.id],
      name: 'survey360_relations_appraiser_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.roleId],
      foreignColumns: [survey360Roles.tenantId, survey360Roles.id],
      name: 'survey360_relations_role_fk',
    }),
    check('survey360_relations_source', sql`${t.source} IN ('manual', 'import', 'org', 'confirm')`),
  ],
);

/** 请上级确认评价关系（E3-R19）：确认后前台不可再改，只能管理员后台调整（AC-360-07）。 */
export const survey360Confirmations = pgTable(
  'survey360_confirmations',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    objectId: uuid('object_id').notNull(),
    confirmerPersonId: uuid('confirmer_person_id').notNull(),
    status: text('status').notNull().default('pending'),
    confirmedAt: at('confirmed_at'),
    revision: revision(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_confirmations_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('survey360_confirmations_object')
      .on(t.objectId)
      .where(sql`${t.status} <> 'cancelled'`),
    activityFk('survey360_confirmations_activity_fk', t.tenantId, t.activityId),
    foreignKey({
      columns: [t.tenantId, t.objectId],
      foreignColumns: [survey360Objects.tenantId, survey360Objects.id],
      name: 'survey360_confirmations_object_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.confirmerPersonId],
      foreignColumns: [survey360People.tenantId, survey360People.id],
      name: 'survey360_confirmations_confirmer_fk',
    }),
    check('survey360_confirmations_status', sql`${t.status} IN ('pending', 'confirmed', 'cancelled')`),
  ],
);

/**
 * 作答 / 确认链接（E3-R20：一个评价者在一个活动内只有一个作答链接）。只存令牌摘要；令牌经请求头传递，
 * 不出现在路径与日志里。
 */
export const survey360Links = pgTable(
  'survey360_links',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    kind: text('kind').notNull(),
    personId: uuid('person_id').notNull(),
    confirmationId: uuid('confirmation_id'),
    tokenHash: text('token_hash').notNull(),
    revoked: boolean('revoked').notNull().default(false),
    /** 最后发送时间：邮件邀请与站内待办都计入（`25` §10.2 更正）；重发邮件轮换链接时沿用到新链接。 */
    lastSentAt: at('last_sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('survey360_links_token').on(t.tenantId, t.tokenHash),
    uniqueIndex('survey360_links_answer')
      .on(t.activityId, t.personId)
      .where(sql`${t.kind} = 'answer' AND NOT ${t.revoked}`),
    uniqueIndex('survey360_links_confirm')
      .on(t.confirmationId)
      .where(sql`${t.kind} = 'confirm' AND NOT ${t.revoked}`),
    activityFk('survey360_links_activity_fk', t.tenantId, t.activityId),
    foreignKey({
      columns: [t.tenantId, t.personId],
      foreignColumns: [survey360People.tenantId, survey360People.id],
      name: 'survey360_links_person_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.confirmationId],
      foreignColumns: [survey360Confirmations.tenantId, survey360Confirmations.id],
      name: 'survey360_links_confirmation_fk',
    }),
    check('survey360_links_kind', sql`${t.kind} IN ('answer', 'confirm')`),
  ],
);

/** 领域事件 outbox（AGENTS.md §10「事件」）：邀请邮件等，消费者按游标拉取；不接真实发送。 */
export const survey360Outbox = pgTable('survey360_outbox', {
  id: id(),
  tenantId: tenantId(),
  eventType: text('event_type').notNull(),
  objectId: uuid('object_id').notNull(),
  commandId: text('command_id').notNull(),
  payload: jsonb('payload').notNull(),
  state: text('state').notNull().default('pending'),
  createdAt: createdAt(),
});

/** 答卷：评价关系 × 套卷；草稿可反复保存（断点续答，E3-R22），提交后不可改。 */
export const survey360Sheets = pgTable(
  'survey360_sheets',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    relationId: uuid('relation_id').notNull(),
    questionnaireId: uuid('questionnaire_id').notNull(),
    status: text('status').notNull().default('draft'),
    suggestion: text('suggestion'),
    revision: revision(),
    savedAt: at('saved_at').notNull().defaultNow(),
    submittedAt: at('submitted_at'),
    /** 屏蔽（`25` §10.1 ⑥⑦⑧）：粒度为评价者 × 套卷；被屏蔽的答卷不参与计分，可取消屏蔽，重算须启用 → 停用。 */
    blocked: boolean('blocked').notNull().default(false),
    blockedSource: text('blocked_source'),
    blockedAt: at('blocked_at'),
    blockedBy: uuid('blocked_by'),
  },
  (t) => [
    unique('survey360_sheets_tenant_id').on(t.tenantId, t.id),
    unique('survey360_sheets_pair').on(t.relationId, t.questionnaireId),
    activityFk('survey360_sheets_activity_fk', t.tenantId, t.activityId),
    foreignKey({
      columns: [t.tenantId, t.relationId],
      foreignColumns: [survey360Relations.tenantId, survey360Relations.id],
      name: 'survey360_sheets_relation_fk',
    }),
    questionnaireFk('survey360_sheets_questionnaire_fk', t.tenantId, t.questionnaireId),
    check('survey360_sheets_status', sql`${t.status} IN ('draft', 'submitted')`),
    check(
      'survey360_sheets_blocked',
      sql`(NOT ${t.blocked} AND ${t.blockedSource} IS NULL) OR (${t.blocked} AND ${t.status} = 'submitted'
        AND ${t.blockedSource} IN ('manual', 'suspected'))`,
    ),
  ],
);

/**
 * 答卷计时（F-060 收尾，DEC-392）：评价者 × 评价对象 × 套卷首次打开作答页的时刻（opened_at），与“本页”起算时刻
 * （page_started_at：打开时等于 opened_at，之后每次点“下一页”挪到那一刻）。与答卷分开存：打开时答卷行还不存在（首次保存才
 * 建）。耗时与逐份答案同级敏感（DEC-371⑤）：只存库，不进任何响应与审计，对外只回“是否提醒 / 是否疑似”的布尔。
 * 本功能上线前已提交的答卷没有这一行，不判耗时、也不算疑似（DEC-371③）。
 */
export const survey360SheetTimings = pgTable(
  'survey360_sheet_timings',
  {
    id: id(),
    tenantId: tenantId(),
    relationId: uuid('relation_id').notNull(),
    questionnaireId: uuid('questionnaire_id').notNull(),
    openedAt: at('opened_at').notNull(),
    pageStartedAt: at('page_started_at').notNull(),
  },
  (t) => [
    unique('survey360_sheet_timings_tenant_id').on(t.tenantId, t.id),
    unique('survey360_sheet_timings_pair').on(t.relationId, t.questionnaireId),
    foreignKey({
      columns: [t.tenantId, t.relationId],
      foreignColumns: [survey360Relations.tenantId, survey360Relations.id],
      name: 'survey360_sheet_timings_relation_fk',
    }),
    questionnaireFk('survey360_sheet_timings_questionnaire_fk', t.tenantId, t.questionnaireId),
  ],
);

/** 答卷明细：题目（关键行为）或基础指标（等级评定）× 选项。 */
export const survey360Answers = pgTable(
  'survey360_answers',
  {
    id: id(),
    tenantId: tenantId(),
    sheetId: uuid('sheet_id').notNull(),
    itemId: uuid('item_id').notNull(),
    optionId: uuid('option_id').notNull(),
    remark: text('remark'),
  },
  (t) => [
    unique('survey360_answers_item').on(t.sheetId, t.itemId),
    foreignKey({
      columns: [t.tenantId, t.sheetId],
      foreignColumns: [survey360Sheets.tenantId, survey360Sheets.id],
      name: 'survey360_answers_sheet_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.optionId],
      foreignColumns: [survey360ScaleOptions.tenantId, survey360ScaleOptions.id],
      name: 'survey360_answers_option_fk',
    }),
  ],
);

/** 计分批次：停用活动时计算（E3-R15）；活动指向最新批次，旧批次保留。 */
export const survey360ScoreBatches = pgTable(
  'survey360_score_batches',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    commandId: text('command_id').notNull(),
    computedAt: createdAt(),
    /** 本次计分用到的各套卷计分口径版本（套卷 ID → scoring_revision，PR-B 第 3 轮 P2-3）。 */
    questionnaireRevisions: jsonb('questionnaire_revisions').$type<Record<string, number>>().notNull().default({}),
  },
  (t) => [
    unique('survey360_score_batches_tenant_id').on(t.tenantId, t.id),
    activityFk('survey360_score_batches_activity_fk', t.tenantId, t.activityId),
  ],
);

/** 得分：问卷 / 指标 / 题目 × 自评 / 他评 / 角色（E3-R11）；只存聚合分，不存逐个评价者的分数。 */
export const survey360Scores = pgTable(
  'survey360_scores',
  {
    id: id(),
    tenantId: tenantId(),
    batchId: uuid('batch_id').notNull(),
    activityId: uuid('activity_id').notNull(),
    objectId: uuid('object_id').notNull(),
    questionnaireId: uuid('questionnaire_id').notNull(),
    level: text('level').notNull(),
    itemId: uuid('item_id'),
    scope: text('scope').notNull(),
    roleId: uuid('role_id'),
    score: doublePrecision('score'),
    raterCount: integer('rater_count').notNull(),
  },
  (t) => [
    index('survey360_scores_object').on(t.tenantId, t.batchId, t.objectId),
    foreignKey({
      columns: [t.tenantId, t.batchId],
      foreignColumns: [survey360ScoreBatches.tenantId, survey360ScoreBatches.id],
      name: 'survey360_scores_batch_fk',
    }),
    check('survey360_scores_level', sql`${t.level} IN ('questionnaire', 'dimension', 'question')`),
    check('survey360_scores_scope', sql`${t.scope} IN ('self', 'other', 'role')`),
  ],
);

/**
 * 站内待办（`25` §10.3 ①②③；开工通知：站内只用“待办”）：评价者 × 活动一条，重发覆盖原条、刷新发送时间；
 * 接收人是 360 人员挂接员工的租户账号（DEC-128）；评价者提交全部对象后自动“已处理”，取消待办也移入“已处理”。
 */
export const survey360Todos = pgTable(
  'survey360_todos',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    personId: uuid('person_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull().default('open'),
    doneReason: text('done_reason'),
    sentAt: at('sent_at').notNull(),
    doneAt: at('done_at'),
    revision: revision(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_todos_tenant_id').on(t.tenantId, t.id),
    unique('survey360_todos_appraiser').on(t.activityId, t.personId),
    index('survey360_todos_user').on(t.tenantId, t.userId),
    activityFk('survey360_todos_activity_fk', t.tenantId, t.activityId),
    foreignKey({
      columns: [t.tenantId, t.personId],
      foreignColumns: [survey360People.tenantId, survey360People.id],
      name: 'survey360_todos_person_fk',
    }),
    check('survey360_todos_status', sql`${t.status} IN ('open', 'done')`),
    check(
      'survey360_todos_done',
      sql`(${t.status} = 'open' AND ${t.doneReason} IS NULL AND ${t.doneAt} IS NULL)
        OR (${t.status} = 'done' AND ${t.doneReason} IN ('completed', 'cancelled') AND ${t.doneAt} IS NOT NULL)`,
    ),
  ],
);

/** 报告模板（首版只有标准版一个，多版本 ⏸）：DEC-149 第二个匿名开关“文本答案中是否呈现评价角色”。 */
export const survey360ReportTemplates = pgTable(
  'survey360_report_templates',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    showTextRole: boolean('show_text_role').notNull().default(true),
    revision: revision(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('survey360_report_templates_tenant_id').on(t.tenantId, t.id),
    unique('survey360_report_templates_code').on(t.tenantId, t.code),
  ],
);

/**
 * 个人报告（`25` §10.3 ⑬⑭）：评价对象 × 报告模板一行；内容是生成时的快照（不含任何评价者标识），活动作答数据
 * 变化后失效（查看被拦），须启用 → 停用后重新生成。
 */
export const survey360Reports = pgTable(
  'survey360_reports',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    objectId: uuid('object_id').notNull(),
    templateId: uuid('template_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    content: jsonb('content').notNull(),
    generatedAt: at('generated_at').notNull(),
    revision: revision(),
  },
  (t) => [
    unique('survey360_reports_tenant_id').on(t.tenantId, t.id),
    unique('survey360_reports_object_template').on(t.objectId, t.templateId),
    activityFk('survey360_reports_activity_fk', t.tenantId, t.activityId),
    foreignKey({
      columns: [t.tenantId, t.objectId],
      foreignColumns: [survey360Objects.tenantId, survey360Objects.id],
      name: 'survey360_reports_object_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.templateId],
      foreignColumns: [survey360ReportTemplates.tenantId, survey360ReportTemplates.id],
      name: 'survey360_reports_template_fk',
    }),
    foreignKey({
      columns: [t.tenantId, t.batchId],
      foreignColumns: [survey360ScoreBatches.tenantId, survey360ScoreBatches.id],
      name: 'survey360_reports_batch_fk',
    }),
  ],
);

/** 报告转发的收件人链接（§10.3 ⑮：每位收件人一封邮件，发链接不发附件）：只存令牌摘要。 */
export const survey360ReportLinks = pgTable(
  'survey360_report_links',
  {
    id: id(),
    tenantId: tenantId(),
    activityId: uuid('activity_id').notNull(),
    recipientName: text('recipient_name').notNull(),
    recipientEmail: text('recipient_email').notNull(),
    reportIds: uuids('report_ids'),
    tokenHash: text('token_hash').notNull(),
    commandId: text('command_id').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('survey360_report_links_token').on(t.tenantId, t.tokenHash),
    activityFk('survey360_report_links_activity_fk', t.tenantId, t.activityId),
  ],
);
