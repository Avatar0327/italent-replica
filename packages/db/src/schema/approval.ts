/**
 * 审批中心（R1-T07；docs/02_业务建模/14、REQ-APV-001~004）。
 * 流程是稳定对象 + 版本；已发布版本及其节点、条件、消息规则只读（迁移 0029 触发器），实例绑定版本 ID 即冻结快照（`14` §4）。
 * 所有表带 tenant_id 并强制 RLS；人员引用一律指向租户成员（账号）或任职员工主档。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
import { tenantMemberships, tenants } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = (name: string) => timestamp(name, { withTimezone: true });
const memberFk = (name: string, tenant: AnyPgColumn, user: AnyPgColumn) =>
  foreignKey({ name, columns: [tenant, user], foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId] });
const textArray = (name: string) =>
  text(name)
    .array()
    .notNull()
    .default(sql`'{}'::text[]`);

export const approvalProcesses = pgTable(
  'approval_processes',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    approvalType: text('approval_type').notNull(),
    objectCode: text('object_code').notNull(),
    status: text('status').notNull().default('active'),
    /** 当前生效（已发布）版本；最新版本可能是草稿（REQ-APV-001 R6）。 */
    currentVersionId: uuid('current_version_id'),
    latestVersionNo: integer('latest_version_no').notNull().default(1),
    presetKey: text('preset_key'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('approval_processes_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('approval_processes_code').on(t.tenantId, t.code),
    uniqueIndex('approval_processes_preset')
      .on(t.tenantId, t.presetKey)
      .where(sql`${t.presetKey} IS NOT NULL`),
    index('approval_processes_type').on(t.tenantId, t.approvalType, t.status),
    memberFk('approval_processes_creator', t.tenantId, t.createdBy),
    check('approval_processes_status', sql`${t.status} IN ('active','discarded')`),
    check('approval_processes_revision', sql`${t.revision} > 0 AND ${t.latestVersionNo} > 0`),
  ],
);

export const approvalProcessVersions = pgTable(
  'approval_process_versions',
  {
    id: id(),
    tenantId: tenantId(),
    processId: uuid('process_id').notNull(),
    versionNo: integer('version_no').notNull(),
    status: text('status').notNull().default('draft'),
    name: text('name').notNull(),
    groupName: text('group_name'),
    description: text('description'),
    priority: integer('priority').notNull().default(0),
    isFallback: boolean('is_fallback').notNull().default(false),
    exceptionAdminUserId: uuid('exception_admin_user_id'),
    urgeEnabled: boolean('urge_enabled').notNull().default(true),
    /** DEC-104：开始节点的「审批记录查看权限」，勾选后发起人看不到审批记录与沟通。 */
    hideRecordsFromInitiator: boolean('hide_records_from_initiator').notNull().default(false),
    conditionExpression: text('condition_expression').notNull().default(''),
    createdBy: uuid('created_by').notNull(),
    createdAt: utc('created_at').notNull().defaultNow(),
    publishedBy: uuid('published_by'),
    publishedAt: utc('published_at'),
  },
  (t) => [
    unique('approval_versions_tenant_id').on(t.tenantId, t.id),
    unique('approval_versions_number').on(t.tenantId, t.processId, t.versionNo),
    foreignKey({
      name: 'approval_versions_process_fk',
      columns: [t.tenantId, t.processId],
      foreignColumns: [approvalProcesses.tenantId, approvalProcesses.id],
    }),
    memberFk('approval_versions_exception_admin', t.tenantId, t.exceptionAdminUserId),
    memberFk('approval_versions_creator', t.tenantId, t.createdBy),
    check('approval_versions_status', sql`${t.status} IN ('draft','published')`),
    check('approval_versions_number_positive', sql`${t.versionNo} > 0`),
    check('approval_versions_priority', sql`${t.priority} BETWEEN -100000 AND 100000`),
    check(
      'approval_versions_published',
      sql`(${t.status} = 'draft') = (${t.publishedAt} IS NULL)
        AND (${t.status} = 'draft' OR ${t.exceptionAdminUserId} IS NOT NULL)`,
    ),
  ],
);

/** 发起条件条目：字段路径白名单 + 运算符 + 单值或值列表（`14` §1.1）。 */
export const approvalProcessConditions = pgTable(
  'approval_process_conditions',
  {
    tenantId: tenantId(),
    versionId: uuid('version_id').notNull(),
    itemNo: integer('item_no').notNull(),
    fieldPath: text('field_path').notNull(),
    operator: text('operator').notNull(),
    valueText: text('value_text'),
    valueList: text('value_list').array(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.itemNo] }),
    foreignKey({
      name: 'approval_conditions_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [approvalProcessVersions.tenantId, approvalProcessVersions.id],
    }),
    check(
      'approval_conditions_operator',
      sql`${t.operator} IN ('eq','ne','in','not_in','is_empty','not_empty','in_org_tree')`,
    ),
  ],
);

export const approvalProcessNodes = pgTable(
  'approval_process_nodes',
  {
    tenantId: tenantId(),
    versionId: uuid('version_id').notNull(),
    nodeKey: text('node_key').notNull(),
    seq: integer('seq').notNull(),
    name: text('name').notNull(),
    /** F-003：节点类型——单人审批 / 会签审批（`14` §11.4、§12）。 */
    nodeType: text('node_type').notNull().default('single'),
    /** 单人审批节点的审批人表达式；会签节点为空。 */
    approverExpression: text('approver_expression'),
    /** F-003：会签节点的审批人表达式（按配置顺序逐人解析）；单人节点为空数组。 */
    approverExpressions: textArray('approver_expressions'),
    /** F-003：出口动作（同意 / 不同意，DEC-144）；驳回是节点动作，不在其中。缺省只有同意。 */
    exits: text('exits')
      .array()
      .notNull()
      .default(sql`'{approve}'::text[]`),
    /**
     * DEC-144：会签流转规则 任一人同意即可 / 需所有人同意 / 自定义审批方式。只有自定义审批方式按出口动作逐个保存条件
     * （整数 = 人数，百分比 = 向上取整），两种预设按出口动作生成，不落库。
     */
    transitionRuleType: text('transition_rule_type'),
    approveRuleKind: text('approve_rule_kind'),
    approveRuleValue: numeric('approve_rule_value', { precision: 5, scale: 2 }),
    disagreeRuleKind: text('disagree_rule_kind'),
    disagreeRuleValue: numeric('disagree_rule_value', { precision: 5, scale: 2 }),
    noAssigneePolicy: text('no_assignee_policy').notNull().default('exception_admin'),
    sameAssigneeSkip: boolean('same_assignee_skip').notNull().default(false),
    historySameAssigneeSkip: boolean('history_same_assignee_skip').notNull().default(false),
    /** DEC-106：相同 / 历史相同审批人自动处理的结果「同意」/「跳过」。 */
    sameAssigneeResult: text('same_assignee_result').notNull().default('approve'),
    historySameAssigneeResult: text('history_same_assignee_result').notNull().default('approve'),
    formFields: textArray('form_fields'),
    editableFields: textArray('editable_fields'),
    editMode: text('edit_mode').notNull().default('none'),
    allowTransfer: boolean('allow_transfer').notNull().default(false),
    allowAddSign: boolean('allow_add_sign').notNull().default(false),
    /** DEC-097：抄送、审批人撤回随版本冻结。 */
    allowCopySend: boolean('allow_copy_send').notNull().default(false),
    allowRetrieve: boolean('allow_retrieve').notNull().default(false),
    /**
     * F-003 第二轮：驳回（驳回到发起人）是节点开关（`14` §12.2 `isRejectToStart`），单人与会签节点共用，加签人沿用；
     * 缺省开启（R1-T07 起的节点一直可以驳回）。
     */
    allowReject: boolean('allow_reject').notNull().default(true),
    /** X-15：节点催办 继承 / 开启 / 关闭。 */
    urgeMode: text('urge_mode').notNull().default('inherit'),
    rejectCommentRequired: boolean('reject_comment_required').notNull().default(false),
    /** DEC-104「审批记录查看权限」：勾选后本节点审批人看不到审批记录与沟通（出厂关 = 默认公开）。 */
    hideRecords: boolean('hide_records').notNull().default(false),
    rejectResubmitMode: text('reject_resubmit_mode').notNull().default('restart'),
    /**
     * DEC-318 K-37 / DEC-329④：自审回避是节点开关。新建节点缺省关闭（F-048 迁移只改列缺省值，存量行保持原值）；
     * 预置流程显式写值（DEC-332①，F-048 设计 §3.3）。
     */
    avoidSelf: boolean('avoid_self').notNull().default(false),
    /** F-048 / DEC-329①：多主体回避节点开关，缺省关闭（照原站 isSameExpressionSkip）。 */
    avoidSubjects: boolean('avoid_subjects').notNull().default(false),
    /** DEC-331⑤：命中动作，契约预留跳过 / 同意 / 不同意 / 自定义出口；取证（Q-M0-138）前只启用「跳过」。 */
    avoidSubjectsResult: text('avoid_subjects_result').notNull().default('skip'),
    /** DEC-318 K-39：发起人撤回（isRevoke，缺省开启）、驳回到上一步、审批人跳转（缺省关闭），IDP 预置流程按原站。 */
    allowRevoke: boolean('allow_revoke').notNull().default(true),
    allowRejectPrevious: boolean('allow_reject_previous').notNull().default(false),
    allowJump: boolean('allow_jump').notNull().default(false),
    // DEC-035：时效首版不做，只保留 `14` §9.1 的字段结构，不参与计算。
    timeSpan: integer('time_span'),
    timeEffectBefore: jsonb('time_effect_before'),
    timeEffect: jsonb('time_effect'),
    period: jsonb('period'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.nodeKey] }),
    unique('approval_nodes_seq').on(t.tenantId, t.versionId, t.seq),
    check('approval_nodes_avoid_subjects_result', sql`${t.avoidSubjectsResult} IN ('skip')`),
    foreignKey({
      name: 'approval_nodes_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [approvalProcessVersions.tenantId, approvalProcessVersions.id],
    }),
    check(
      'approval_nodes_approver',
      sql`${t.approverExpression} IN ('owner','direct_manager','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head','idp_employee','idp_tutor')`,
    ),
    // DEC-054：中间节点审批人为空一律转异常管理员（PR #35 第二轮清单 6）。
    check('approval_nodes_no_assignee', sql`${t.noAssigneePolicy} IN ('exception_admin','none')`),
    check('approval_nodes_edit_mode', sql`${t.editMode} IN ('none','separate','with_approve')`),
    check('approval_nodes_resubmit', sql`${t.rejectResubmitMode} IN ('restart','rejecting_node')`),
    check('approval_nodes_seq_positive', sql`${t.seq} > 0`),
    check('approval_nodes_urge_mode', sql`${t.urgeMode} IN ('inherit','enabled','disabled')`),
    check(
      'approval_nodes_auto_result',
      sql`${t.sameAssigneeResult} IN ('approve','skip') AND ${t.historySameAssigneeResult} IN ('approve','skip')`,
    ),
    check('approval_nodes_type', sql`${t.nodeType} IN ('single','countersign')`),
    check(
      'approval_nodes_approvers',
      sql`CASE WHEN ${t.nodeType} = 'countersign'
        THEN ${t.approverExpression} IS NULL AND cardinality(${t.approverExpressions}) BETWEEN 1 AND 8
          AND ${t.approverExpressions} <@ ARRAY['owner','direct_manager','latest_record_department_head',
            'record_department_head','record_department_hrbp','record_first_level_org_head',
            'idp_employee','idp_tutor']::text[]
        ELSE ${t.approverExpression} IS NOT NULL AND cardinality(${t.approverExpressions}) = 0 END`,
    ),
    check(
      'approval_nodes_exits',
      sql`cardinality(${t.exits}) BETWEEN 1 AND 2 AND ${t.exits} <@ ARRAY['approve','disagree']::text[]`,
    ),
    // DEC-106：自动处理的「跳过」仅单人审批节点可选。
    check(
      'approval_nodes_countersign_auto',
      sql`${t.nodeType} = 'single'
        OR (${t.sameAssigneeResult} = 'approve' AND ${t.historySameAssigneeResult} = 'approve')`,
    ),
    check(
      'approval_nodes_transition_rule',
      sql`(${t.nodeType} = 'countersign') = (${t.transitionRuleType} IS NOT NULL)
        AND (${t.transitionRuleType} IS NULL OR ${t.transitionRuleType} IN ('any','all','custom'))
        AND CASE WHEN ${t.transitionRuleType} = 'custom'
          THEN (${t.approveRuleKind} IS NOT NULL) = ('approve' = ANY(${t.exits}))
            AND (${t.disagreeRuleKind} IS NOT NULL) = ('disagree' = ANY(${t.exits}))
          ELSE ${t.approveRuleKind} IS NULL AND ${t.disagreeRuleKind} IS NULL END`,
    ),
    check(
      'approval_nodes_exit_rules',
      sql`(${t.approveRuleKind} IS NULL) = (${t.approveRuleValue} IS NULL)
        AND (${t.disagreeRuleKind} IS NULL) = (${t.disagreeRuleValue} IS NULL)
        AND (${t.approveRuleKind} IS NULL OR ${t.approveRuleKind} = 'count'
          AND ${t.approveRuleValue} >= 1 AND ${t.approveRuleValue} = trunc(${t.approveRuleValue})
          OR ${t.approveRuleKind} = 'percent' AND ${t.approveRuleValue} > 0 AND ${t.approveRuleValue} <= 100)
        AND (${t.disagreeRuleKind} IS NULL OR ${t.disagreeRuleKind} = 'count'
          AND ${t.disagreeRuleValue} >= 1 AND ${t.disagreeRuleValue} = trunc(${t.disagreeRuleValue})
          OR ${t.disagreeRuleKind} = 'percent' AND ${t.disagreeRuleValue} > 0 AND ${t.disagreeRuleValue} <= 100)`,
    ),
  ],
);

/** 节点消息规则：触发动作 → 渠道 → 模板 → 接收人表达式（`14` §8.2）。 */
export const approvalNodeMessageRules = pgTable(
  'approval_node_message_rules',
  {
    tenantId: tenantId(),
    versionId: uuid('version_id').notNull(),
    nodeKey: text('node_key').notNull(),
    ruleNo: integer('rule_no').notNull(),
    trigger: text('trigger').notNull(),
    channels: textArray('channels'),
    templateCode: text('template_code').notNull(),
    recipient: text('recipient').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.nodeKey, t.ruleNo] }),
    foreignKey({
      name: 'approval_message_rules_node_fk',
      columns: [t.tenantId, t.versionId, t.nodeKey],
      foreignColumns: [approvalProcessNodes.tenantId, approvalProcessNodes.versionId, approvalProcessNodes.nodeKey],
    }),
    check('approval_message_rules_trigger', sql`${t.trigger} IN ('arrive','approve','disagree','reject','transfer')`),
    check('approval_message_rules_recipient', sql`${t.recipient} IN ('owner','subject_employee','assignee')`),
    check(
      'approval_message_rules_channels',
      sql`cardinality(${t.channels}) > 0 AND ${t.channels} <@ ARRAY['inbox','email','sms']::text[]`,
    ),
  ],
);

export const approvalInstances = pgTable(
  'approval_instances',
  {
    id: id(),
    tenantId: tenantId(),
    processId: uuid('process_id').notNull(),
    /** 发起时的版本（冻结快照，REQ-APV-001 R3）。 */
    versionId: uuid('version_id').notNull(),
    approvalType: text('approval_type').notNull(),
    objectCode: text('object_code').notNull(),
    businessType: text('business_type').notNull(),
    businessId: uuid('business_id').notNull(),
    subjectEmployeeId: uuid('subject_employee_id'),
    initiatorUserId: uuid('initiator_user_id').notNull(),
    processCode: text('process_code'),
    title: text('title').notNull(),
    /** 审批人所读的业务载荷版本：业务单绕过审批被改动后，旧审批一律 409（AGENTS §10「并发」）。 */
    businessVersion: text('business_version').notNull().default(''),
    status: text('status').notNull().default('running'),
    currentNodeKey: text('current_node_key'),
    returnedFromNodeKey: text('returned_from_node_key'),
    round: integer('round').notNull().default(1),
    /**
     * 有效历史边界（F7）：管理员干预 / 跳转后，序号小于它的任务不再算相同 / 历史审批人（`14` §11.6，手册 120981507）；
     * 失效的同意仍保留在任务与审计中。
     */
    historyFromSeq: integer('history_from_seq').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
    completedAt: utc('completed_at'),
  },
  (t) => [
    unique('approval_instances_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('approval_instances_active_business')
      .on(t.tenantId, t.businessType, t.businessId)
      .where(sql`${t.status} IN ('running','returned')`),
    index('approval_instances_initiator').on(t.tenantId, t.initiatorUserId, t.createdAt),
    index('approval_instances_business').on(t.tenantId, t.businessType, t.businessId, t.createdAt),
    foreignKey({
      name: 'approval_instances_process_fk',
      columns: [t.tenantId, t.processId],
      foreignColumns: [approvalProcesses.tenantId, approvalProcesses.id],
    }),
    foreignKey({
      name: 'approval_instances_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [approvalProcessVersions.tenantId, approvalProcessVersions.id],
    }),
    foreignKey({
      name: 'approval_instances_subject_fk',
      columns: [t.tenantId, t.subjectEmployeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    memberFk('approval_instances_initiator_fk', t.tenantId, t.initiatorUserId),
    // disapproved：沿「不同意」连线流转到结束（DEC-144，`14` §12.2），流程结束、业务不生效，不能重提（F-003 第二轮）。
    check(
      'approval_instances_status',
      sql`${t.status} IN ('running','returned','approved','disapproved','withdrawn','cancelled')`,
    ),
    check(
      'approval_instances_business_type',
      sql`${t.businessType} IN ('employment','personnel_change','contract','idp','talent_review')`,
    ),
    check('approval_instances_revision', sql`${t.revision} > 0 AND ${t.round} > 0 AND ${t.historyFromSeq} >= 0`),
  ],
);

export const approvalTasks = pgTable(
  'approval_tasks',
  {
    id: id(),
    tenantId: tenantId(),
    instanceId: uuid('instance_id').notNull(),
    seq: integer('seq').notNull(),
    round: integer('round').notNull(),
    nodeKey: text('node_key').notNull(),
    /** 自动「跳过」的节点处理人记为系统，没有审批人（DEC-106）。 */
    assigneeUserId: uuid('assignee_user_id'),
    /** 节点按表达式解析出的候选人（DEC-114：“与上一节点相同”的比较对象）；改派、加签产生的任务为空。 */
    candidateUserId: uuid('candidate_user_id'),
    /**
     * F-003 第二轮（P2-4）：会签节点两个表达式落到同一接手人、合并为一席时，被合并的其他候选人，与 candidate_user_id
     * 一起作为下一节点“与上一节点相同”的比较对象（DEC-114）。
     */
    mergedCandidateUserIds: uuid('merged_candidate_user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    origin: text('origin').notNull(),
    status: text('status').notNull().default('pending'),
    isExceptionAdmin: boolean('is_exception_admin').notNull().default(false),
    /** DEC-070：管理员转交给自己后审批，醒目标注并可筛选。 */
    adminSelfTransfer: boolean('admin_self_transfer').notNull().default(false),
    parentTaskId: uuid('parent_task_id'),
    /**
     * F-003：节点的本次激活。同一次进入节点产生的任务，以及它们的转交、加签、撤回与恢复，共用一个编号；会签按它结算
     * （DEC-144），管理员跳转或重提再次进入节点时换新编号。R1-T07 时期的任务为空。
     */
    activationId: uuid('activation_id'),
    comment: text('comment'),
    actedAt: utc('acted_at'),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('approval_tasks_tenant_id').on(t.tenantId, t.id),
    unique('approval_tasks_seq').on(t.tenantId, t.instanceId, t.seq),
    index('approval_tasks_assignee').on(t.tenantId, t.assigneeUserId, t.status, t.createdAt),
    foreignKey({
      name: 'approval_tasks_instance_fk',
      columns: [t.tenantId, t.instanceId],
      foreignColumns: [approvalInstances.tenantId, approvalInstances.id],
    }),
    memberFk('approval_tasks_assignee_fk', t.tenantId, t.assigneeUserId),
    check('approval_tasks_pending_assignee', sql`${t.status} <> 'pending' OR ${t.assigneeUserId} IS NOT NULL`),
    check(
      'approval_tasks_status',
      sql`${t.status} IN ('pending','approved','disagreed','rejected','transferred','skipped','cancelled','add_signed',
        'queued','ended','merged')`,
    ),
    check(
      'approval_tasks_origin',
      sql`${t.origin} IN ('resolved','self_skip','self_skip_manager','exception_admin','same_skip',
        'history_skip','no_assignee_skip','no_assignee_approve','transfer','add_sign','admin_transfer',
        'admin_intervene','blind_review','handover','add_sign_before','add_sign_after','add_sign_return','retrieve',
        'add_sign_parallel','countersign_reopen','subject_skip')`,
    ),
  ],
);

/**
 * F-048：实例的主体冻结集合（设计 §5.1）。发起写第 1 轮，每次重提写新一轮完整集合（只增不减，DEC-329⑤）；行不可改
 * （迁移触发器）。employee_id / user_id 不建外键：外键检查会对员工行、成员行取 KEY SHARE，与 lockPerson / lockEmployee
 * 的员工行 FOR UPDATE、首次绑定的成员行 FOR UPDATE 互等（设计 §5.4）；存在性在写入前校验，员工没有删除路径。
 */
export const approvalInstanceSubjects = pgTable(
  'approval_instance_subjects',
  {
    tenantId: tenantId(),
    instanceId: uuid('instance_id').notNull(),
    round: integer('round').notNull(),
    employeeId: uuid('employee_id').notNull(),
    /** 冻结时该员工绑定的账号（不看账号 / 成员状态，fail-closed）；无绑定为空。 */
    userId: uuid('user_id'),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.instanceId, t.round, t.employeeId] }),
    index('approval_instance_subjects_user').on(t.tenantId, t.instanceId, t.userId),
    foreignKey({
      name: 'approval_instance_subjects_instance_fk',
      columns: [t.tenantId, t.instanceId],
      foreignColumns: [approvalInstances.tenantId, approvalInstances.id],
    }),
    check('approval_instance_subjects_round', sql`${t.round} > 0`),
  ],
);

/** 实例日志（节点日志 / 审批记录），只追加。 */
export const approvalInstanceLogs = pgTable(
  'approval_instance_logs',
  {
    id: id(),
    tenantId: tenantId(),
    instanceId: uuid('instance_id').notNull(),
    seq: integer('seq').notNull(),
    round: integer('round').notNull(),
    nodeKey: text('node_key'),
    taskId: uuid('task_id'),
    event: text('event').notNull(),
    actorUserId: uuid('actor_user_id'),
    adminSelfTransfer: boolean('admin_self_transfer').notNull().default(false),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('approval_logs_seq').on(t.tenantId, t.instanceId, t.seq),
    index('approval_logs_admin_self').on(t.tenantId, t.adminSelfTransfer, t.createdAt),
    foreignKey({
      name: 'approval_logs_instance_fk',
      columns: [t.tenantId, t.instanceId],
      foreignColumns: [approvalInstances.tenantId, approvalInstances.id],
    }),
  ],
);

/** 通知 / 待办消息：按接收人过滤；外发状态 pending / sent / failed / unknown（AGENTS §10）。 */
export const approvalNotifications = pgTable(
  'approval_notifications',
  {
    id: id(),
    tenantId: tenantId(),
    instanceId: uuid('instance_id').notNull(),
    taskId: uuid('task_id'),
    recipientUserId: uuid('recipient_user_id').notNull(),
    kind: text('kind').notNull(),
    channel: text('channel').notNull(),
    templateCode: text('template_code'),
    status: text('status').notNull().default('pending'),
    commandId: text('command_id').notNull(),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('approval_notifications_recipient').on(t.tenantId, t.recipientUserId, t.createdAt),
    foreignKey({
      name: 'approval_notifications_instance_fk',
      columns: [t.tenantId, t.instanceId],
      foreignColumns: [approvalInstances.tenantId, approvalInstances.id],
    }),
    memberFk('approval_notifications_recipient_fk', t.tenantId, t.recipientUserId),
    check('approval_notifications_kind', sql`${t.kind} IN ('todo','urge','message','cc')`),
    check('approval_notifications_channel', sql`${t.channel} IN ('inbox','email','sms')`),
    check('approval_notifications_status', sql`${t.status} IN ('pending','sent','failed','unknown')`),
  ],
);

/** 抄送记录（DEC-097）：被抄送人凭此成为参与人，只看抄送节点的表单字段（DEC-057）。 */
export const approvalInstanceCcs = pgTable(
  'approval_instance_ccs',
  {
    id: id(),
    tenantId: tenantId(),
    instanceId: uuid('instance_id').notNull(),
    nodeKey: text('node_key').notNull(),
    taskId: uuid('task_id').notNull(),
    userId: uuid('user_id').notNull(),
    comment: text('comment'),
    createdBy: uuid('created_by').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('approval_ccs_user').on(t.tenantId, t.userId, t.createdAt),
    index('approval_ccs_instance').on(t.tenantId, t.instanceId),
    foreignKey({
      name: 'approval_ccs_instance_fk',
      columns: [t.tenantId, t.instanceId],
      foreignColumns: [approvalInstances.tenantId, approvalInstances.id],
    }),
    memberFk('approval_ccs_user_fk', t.tenantId, t.userId),
  ],
);

/**
 * DEC-098 / DEC-123：异常管理员交接时指定的替代人（每个租户每人一行，再次交接即改写）。该成员停用时，
 * 其剩余在途异常待办自动转给替代人；替代人数据范围或本人回避不允许接手的部分转给租户管理员。
 */
export const approvalExceptionAdminSuccessors = pgTable(
  'approval_exception_admin_successors',
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid('user_id').notNull(),
    successorUserId: uuid('successor_user_id').notNull(),
    designatedBy: uuid('designated_by').notNull(),
    commandId: text('command_id').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('approval_exception_admin_successors_user').on(t.tenantId, t.userId),
    memberFk('approval_exception_admin_successors_user_fk', t.tenantId, t.userId),
    memberFk('approval_exception_admin_successors_successor_fk', t.tenantId, t.successorUserId),
    check('approval_exception_admin_successors_not_self', sql`${t.userId} <> ${t.successorUserId}`),
    check('approval_exception_admin_successors_revision', sql`${t.revision} > 0`),
  ],
);

export const approvalOutbox = pgTable(
  'approval_outbox',
  {
    id: id(),
    tenantId: tenantId(),
    objectType: text('object_type').notNull(),
    objectId: uuid('object_id').notNull(),
    eventType: text('event_type').notNull(),
    revision: integer('revision').notNull(),
    commandId: text('command_id').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: utc('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('approval_outbox_event').on(t.tenantId, t.commandId, t.objectId, t.eventType),
    index('approval_outbox_cursor').on(t.tenantId, t.createdAt, t.id),
    check('approval_outbox_state', sql`${t.state} IN ('pending','sent','failed','unknown')`),
  ],
);
