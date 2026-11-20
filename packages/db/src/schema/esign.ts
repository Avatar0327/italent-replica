/**
 * 调动电子签署（F-481 设计 §3.2、§4.1，S1 契约片）：签署模板库、场景设置、签署任务与任务文件。
 * 全部带 tenant_id，迁移里 enable_tenant_isolation 开启并强制行级安全。本片只建表，没有入口写任务表（S2 起写）。
 * F-505 S1（设计 §4）：场景扩为 transfer / offer / entry，任务来源在 business_id 与 offer_id 之间二选一，
 * Offer 来源经不可物理删除的锚点表 esign_offer_sources 追溯（有意不对会被物理删除的 offers 建永久外键）。
 * 任务状态机见 domain `esign/events.ts`；“变更前”等信息不另存列，生成文件时从任职版本链取（硬规则）。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
import { employmentBusinessObjects, employmentEmployees } from './employment.js';
import { orgObjects } from './org.js';
import { tenants, users } from './tenancy.js';

const tenant = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = (name: string) => timestamp(name, { withTimezone: true });
const created = () => utc('created_at').notNull().defaultNow();
const updated = () => utc('updated_at').notNull().defaultNow();

/** 签署模板（租户级，不按场景过滤，设计 §3.2）。没有删除，停用即从下拉消失；不预置模板（DEC-402）。 */
export const esignTemplates = pgTable(
  'esign_templates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: tenant(),
    /** 业务编码，租户内唯一，创建后不可改（DEC-060）。 */
    code: text('code').notNull(),
    name: text('name').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('enabled'),
    sortOrder: integer('sort_order').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    createdAt: created(),
    updatedAt: updated(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (t) => [
    unique('esign_templates_tenant_id').on(t.tenantId, t.id),
    unique('esign_templates_code').on(t.tenantId, t.code),
    unique('esign_templates_name').on(t.tenantId, t.name),
    index('esign_templates_options').on(t.tenantId, t.status, t.sortOrder, t.name),
    check('esign_templates_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('esign_templates_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 100 AND btrim(${t.name}) <> ''`),
    check('esign_templates_body_length', sql`char_length(${t.body}) <= 20000`),
    check('esign_templates_status', sql`${t.status} IN ('enabled', 'disabled')`),
    check('esign_templates_revision', sql`${t.revision} > 0`),
  ],
);

/** 签署场景设置：每租户每场景一行；没有行时按默认值（有效期 2 天、不提醒、revision 0）。 */
export const esignSceneSettings = pgTable(
  'esign_scene_settings',
  {
    tenantId: tenant(),
    /** transfer / offer / entry 三种场景共用设置表（无记录读默认值，不预插行，F-505 设计 §4.2）。 */
    scene: text('scene').notNull(),
    validityDays: integer('validity_days').notNull().default(2),
    remindBeforeExpiry: boolean('remind_before_expiry').notNull().default(false),
    revision: integer('revision').notNull().default(1),
    updatedAt: updated(),
    updatedBy: uuid('updated_by').references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.scene] }),
    check('esign_scene_settings_scene', sql`${t.scene} IN ('transfer', 'offer', 'entry')`),
    check('esign_scene_settings_validity', sql`${t.validityDays} BETWEEN 2 AND 30`),
    check('esign_scene_settings_revision', sql`${t.revision} > 0`),
  ],
);

/**
 * Offer 签署来源锚点（F-505 设计 §4.1）：保留身份的历史来源，只由服务插入与标记删除，禁止物理删除。
 * Offer 删除内核在原事务里标记 deleted_at、撤销在途任务，再删 Offer；触发器兜底拒绝漏标记的裸删除。
 */
export const esignOfferSources = pgTable(
  'esign_offer_sources',
  {
    tenantId: tenant(),
    offerId: uuid('offer_id').notNull(),
    createdAt: created(),
    /** 来源 Offer 已物理删除的标记；标记后不允许重新发起。 */
    deletedAt: utc('deleted_at'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.offerId] })],
);

/**
 * 签署任务（设计 §4.1；F-505 设计 §4.2）。同一来源同时最多一条 signing；终态一律没有当前节点；failed 一定带原因。
 * 来源三选一：transfer / entry 指向任职业务（business_id），offer 指向锚点（offer_id）。
 */
export const esignTasks = pgTable(
  'esign_tasks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: tenant(),
    scene: text('scene').notNull(),
    /** 任职业务 ID（employment_business_objects）：transfer 为调动，entry 为待入职记录；offer 场景为空。 */
    businessId: uuid('business_id'),
    /** Offer ID（经锚点表）：仅 offer 场景。 */
    offerId: uuid('offer_id'),
    /** 业务所有者（被调动员工）。 */
    employeeId: uuid('employee_id').notNull(),
    /** 所有者部门快照：发起时员工生效任职的部门（即调入部门）。 */
    ownerDepartmentId: uuid('owner_department_id'),
    initiatorUserId: uuid('initiator_user_id')
      .notNull()
      .references(() => users.id),
    /** activation 生效联动 / manual 补发。 */
    origin: text('origin').notNull(),
    status: text('status').notNull(),
    /** employee / enterprise / null（终态为 null）。 */
    currentNode: text('current_node'),
    employeeSignerUserId: uuid('employee_signer_user_id').references(() => users.id),
    employeeSignedAt: utc('employee_signed_at'),
    enterpriseSignedAt: utc('enterprise_signed_at'),
    validityDays: integer('validity_days').notNull(),
    expiresAt: utc('expires_at').notNull(),
    remindBeforeExpiry: boolean('remind_before_expiry').notNull().default(false),
    expiryRemindedAt: utc('expiry_reminded_at'),
    initiatedAt: utc('initiated_at').notNull(),
    completedAt: utc('completed_at'),
    revokedAt: utc('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => users.id),
    /** manual / business_deleted / source_cancelled / source_changed。 */
    revokeCause: text('revoke_cause'),
    /** 发起时锁内来源 revision：offer / entry 必填，transfer 为空（F-505 设计 §4.2）。 */
    sourceRevision: integer('source_revision'),
    /** 本次模板实际用到的人员字段（只许 name / code，服务端从模板推导）。 */
    variableReadFields: text('variable_read_fields')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    expiredAt: utc('expired_at'),
    failureReason: text('failure_reason'),
    /** 只存不可用的模板 ID 等机器信息，不存姓名、证件号。 */
    failureDetail: text('failure_detail'),
    /** 本单固定 'simulated'（设计 §5.3）。 */
    provider: text('provider').notNull().default('simulated'),
    providerRef: text('provider_ref'),
    revision: integer('revision').notNull().default(1),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    unique('esign_tasks_tenant_id').on(t.tenantId, t.id),
    index('esign_tasks_business').on(t.tenantId, t.businessId),
    // 同一任职业务（调动 / 入职）一条在途；场景入键，同人的入职与调动互不阻塞
    uniqueIndex('esign_tasks_one_signing_business')
      .on(t.tenantId, t.scene, t.businessId)
      .where(sql`${t.status} = 'signing' AND ${t.businessId} IS NOT NULL`),
    uniqueIndex('esign_tasks_one_signing_offer')
      .on(t.tenantId, t.offerId)
      .where(sql`${t.status} = 'signing' AND ${t.scene} = 'offer'`),
    index('esign_tasks_offer').on(t.tenantId, t.offerId),
    foreignKey({
      name: 'esign_tasks_business_fk',
      columns: [t.tenantId, t.employeeId, t.businessId],
      foreignColumns: [
        employmentBusinessObjects.tenantId,
        employmentBusinessObjects.employeeId,
        employmentBusinessObjects.id,
      ],
    }),
    foreignKey({
      name: 'esign_tasks_offer_fk',
      columns: [t.tenantId, t.offerId],
      foreignColumns: [esignOfferSources.tenantId, esignOfferSources.offerId],
    }),
    foreignKey({
      name: 'esign_tasks_employee_fk',
      columns: [t.tenantId, t.employeeId],
      foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
    }),
    foreignKey({
      name: 'esign_tasks_department_fk',
      columns: [t.tenantId, t.ownerDepartmentId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    check('esign_tasks_scene', sql`${t.scene} IN ('transfer', 'offer', 'entry')`),
    // 来源三种组合穷举：不靠前端保证两列二选一
    check(
      'esign_tasks_source',
      sql`(${t.scene} IN ('transfer', 'entry') AND ${t.businessId} IS NOT NULL AND ${t.offerId} IS NULL)
        OR (${t.scene} = 'offer' AND ${t.businessId} IS NULL AND ${t.offerId} IS NOT NULL)`,
    ),
    check(
      'esign_tasks_source_revision',
      sql`(${t.scene} = 'transfer' AND (${t.sourceRevision} IS NULL OR ${t.sourceRevision} > 0))
        OR (${t.scene} <> 'transfer' AND ${t.sourceRevision} IS NOT NULL AND ${t.sourceRevision} > 0)`,
    ),
    check(
      'esign_tasks_variable_fields',
      sql`${t.variableReadFields} IN (ARRAY[]::text[], ARRAY['name']::text[], ARRAY['code']::text[],
        ARRAY['name', 'code']::text[])`,
    ),
    check(
      'esign_tasks_origin',
      sql`${t.origin} IN ('activation', 'manual') AND (${t.scene} = 'transfer' OR ${t.origin} = 'manual')`,
    ),
    check('esign_tasks_status', sql`${t.status} IN ('signing', 'completed', 'revoked', 'expired', 'failed')`),
    check('esign_tasks_node', sql`${t.currentNode} IS NULL OR ${t.currentNode} IN ('employee', 'enterprise')`),
    // 终态 ⇔ 没有当前节点；签署中必须有当前节点
    check('esign_tasks_terminal_node', sql`(${t.status} = 'signing') = (${t.currentNode} IS NOT NULL)`),
    // failed ⇔ failure_reason 非空
    check('esign_tasks_failure', sql`(${t.status} = 'failed') = (${t.failureReason} IS NOT NULL)`),
    check(
      'esign_tasks_revoke_cause',
      sql`${t.revokeCause} IS NULL OR ${t.revokeCause} IN
        ('manual', 'business_deleted', 'source_cancelled', 'source_changed')`,
    ),
    check('esign_tasks_validity', sql`${t.validityDays} BETWEEN 2 AND 30`),
    check('esign_tasks_revision', sql`${t.revision} > 0`),
  ],
);

/** 任务下的签署文件：每个所选模板一份，快照发起时的名称与替换后正文（设计 §4.1、§4.5）。 */
export const esignTaskFiles = pgTable(
  'esign_task_files',
  {
    tenantId: tenant(),
    taskId: uuid('task_id').notNull(),
    /** 所选顺序，从 1 起。 */
    seq: integer('seq').notNull(),
    templateId: uuid('template_id').notNull(),
    templateName: text('template_name').notNull(),
    content: text('content').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.taskId, t.seq] }),
    foreignKey({
      name: 'esign_task_files_task_fk',
      columns: [t.tenantId, t.taskId],
      foreignColumns: [esignTasks.tenantId, esignTasks.id],
    }),
    foreignKey({
      name: 'esign_task_files_template_fk',
      columns: [t.tenantId, t.templateId],
      foreignColumns: [esignTemplates.tenantId, esignTemplates.id],
    }),
    check('esign_task_files_seq', sql`${t.seq} > 0`),
  ],
);
