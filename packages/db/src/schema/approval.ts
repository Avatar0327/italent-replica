/**
 * 审批中心（R1-T07；docs/02_业务建模/14、REQ-APV-001~004）。
 * 流程是稳定对象 + 版本；已发布版本及其节点、条件、消息规则只读（迁移 0026 触发器），实例绑定版本 ID 即冻结快照（`14` §4）。
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
    approverExpression: text('approver_expression').notNull(),
    noAssigneePolicy: text('no_assignee_policy').notNull().default('exception_admin'),
    sameAssigneeSkip: boolean('same_assignee_skip').notNull().default(false),
    historySameAssigneeSkip: boolean('history_same_assignee_skip').notNull().default(false),
    formFields: textArray('form_fields'),
    editableFields: textArray('editable_fields'),
    editMode: text('edit_mode').notNull().default('none'),
    allowTransfer: boolean('allow_transfer').notNull().default(false),
    allowAddSign: boolean('allow_add_sign').notNull().default(false),
    allowUrge: boolean('allow_urge').notNull().default(true),
    rejectCommentRequired: boolean('reject_comment_required').notNull().default(false),
    rejectResubmitMode: text('reject_resubmit_mode').notNull().default('restart'),
    // DEC-035：时效首版不做，只保留 `14` §9.1 的字段结构，不参与计算。
    timeSpan: integer('time_span'),
    timeEffectBefore: jsonb('time_effect_before'),
    timeEffect: jsonb('time_effect'),
    period: jsonb('period'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.nodeKey] }),
    unique('approval_nodes_seq').on(t.tenantId, t.versionId, t.seq),
    foreignKey({
      name: 'approval_nodes_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [approvalProcessVersions.tenantId, approvalProcessVersions.id],
    }),
    check(
      'approval_nodes_approver',
      sql`${t.approverExpression} IN ('owner','latest_record_department_head','record_department_head',
        'record_department_hrbp','record_first_level_org_head')`,
    ),
    check('approval_nodes_no_assignee', sql`${t.noAssigneePolicy} IN ('exception_admin','skip','approve')`),
    check('approval_nodes_edit_mode', sql`${t.editMode} IN ('none','separate','with_approve')`),
    check('approval_nodes_resubmit', sql`${t.rejectResubmitMode} IN ('restart','rejecting_node')`),
    check('approval_nodes_seq_positive', sql`${t.seq} > 0`),
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
    check('approval_message_rules_trigger', sql`${t.trigger} IN ('arrive','approve','reject','transfer')`),
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
    status: text('status').notNull().default('running'),
    currentNodeKey: text('current_node_key'),
    returnedFromNodeKey: text('returned_from_node_key'),
    round: integer('round').notNull().default(1),
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
    check('approval_instances_status', sql`${t.status} IN ('running','returned','approved','withdrawn','cancelled')`),
    check('approval_instances_business_type', sql`${t.businessType} IN ('employment','personnel_change')`),
    check('approval_instances_revision', sql`${t.revision} > 0 AND ${t.round} > 0`),
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
    /** 审批人为空而自动跳过 / 同意的节点没有审批人。 */
    assigneeUserId: uuid('assignee_user_id'),
    origin: text('origin').notNull(),
    status: text('status').notNull().default('pending'),
    isExceptionAdmin: boolean('is_exception_admin').notNull().default(false),
    /** DEC-070：管理员转交给自己后审批，醒目标注并可筛选。 */
    adminSelfTransfer: boolean('admin_self_transfer').notNull().default(false),
    parentTaskId: uuid('parent_task_id'),
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
      sql`${t.status} IN ('pending','approved','rejected','transferred','skipped','cancelled')`,
    ),
    check(
      'approval_tasks_origin',
      sql`${t.origin} IN ('resolved','self_skip','self_skip_manager','exception_admin','same_skip',
        'history_skip','no_assignee_skip','no_assignee_approve','transfer','add_sign','admin_transfer',
        'admin_intervene','blind_review')`,
    ),
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
    check('approval_notifications_kind', sql`${t.kind} IN ('todo','urge','message')`),
    check('approval_notifications_channel', sql`${t.channel} IN ('inbox','email','sms')`),
    check('approval_notifications_status', sql`${t.status} IN ('pending','sent','failed','unknown')`),
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
