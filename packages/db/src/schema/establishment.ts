/**
 * R1-T04 编制管理（docs/02_业务建模/18 §2–§5/§10）。
 * 对象头只更新 revision；业务版本、子项、任务结果和消息投递记录全部追加，RLS 由模块迁移统一开启。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { jobPositionObjects } from './job.js';
import { orgObjects } from './org.js';
import { tenantMemberships, tenants } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const businessDate = (name: string) => date(name, { mode: 'string' });
const revision = () => integer('revision').notNull().default(1);
const versionNo = () => integer('version_no').notNull();

function tenantReference(
  name: string,
  columns: [AnyPgColumn, AnyPgColumn],
  foreignColumns: [AnyPgColumn, AnyPgColumn],
) {
  return foreignKey({ name, columns, foreignColumns });
}

export const ESTABLISHMENT_CYCLES = ['annual', 'quarterly', 'monthly'] as const;
export const ESTABLISHMENT_MAINTENANCE_MODES = ['local', 'inclusive', 'both'] as const;
export const ESTABLISHMENT_SUBDIVISIONS = ['none', 'position'] as const;
export const ESTABLISHMENT_UNMATCHED_POLICIES = ['organization', 'reject'] as const;
export type EstablishmentCycle = (typeof ESTABLISHMENT_CYCLES)[number];
export type EstablishmentMaintenanceMode = (typeof ESTABLISHMENT_MAINTENANCE_MODES)[number];
export type EstablishmentSubdivision = (typeof ESTABLISHMENT_SUBDIVISIONS)[number];
export type EstablishmentUnmatchedPolicy = (typeof ESTABLISHMENT_UNMATCHED_POLICIES)[number];

export const establishmentSchemeObjects = pgTable(
  'establishment_scheme_objects',
  { id: id(), tenantId: tenantId(), revision: revision(), createdAt: utc() },
  (t) => [
    unique('est_scheme_objects_tenant_id').on(t.tenantId, t.id),
    check('est_scheme_objects_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** 方案的周期、维护方式和维度在已被编制引用后不能变更；引用限制由同租户事务服务校验。 */
export const establishmentSchemeVersions = pgTable(
  'establishment_scheme_versions',
  {
    id: id(),
    tenantId: tenantId(),
    schemeId: uuid('scheme_id').notNull(),
    versionNo: versionNo(),
    previousVersionId: uuid('previous_version_id'),
    code: text('code').notNull(),
    name: text('name').notNull(),
    cycle: text('cycle').$type<EstablishmentCycle>().notNull(),
    maintenanceMode: text('maintenance_mode').$type<EstablishmentMaintenanceMode>().notNull(),
    startMonth: integer('start_month').notNull().default(1),
    subdivision: text('subdivision').$type<EstablishmentSubdivision>().notNull().default('none'),
    unmatchedPolicy: text('unmatched_policy').$type<EstablishmentUnmatchedPolicy>().notNull().default('organization'),
    enabled: boolean('enabled').notNull().default(true),
    startDate: businessDate('start_date').notNull(),
    stopDate: businessDate('stop_date').notNull().default('9999-12-31'),
    createdAt: utc(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('est_scheme_versions_tenant_id').on(t.tenantId, t.id),
    unique('est_scheme_versions_tenant_object_id').on(t.tenantId, t.schemeId, t.id),
    unique('est_scheme_versions_tenant_number').on(t.tenantId, t.schemeId, t.versionNo),
    tenantReference(
      'est_scheme_versions_object_fk',
      [t.tenantId, t.schemeId],
      [establishmentSchemeObjects.tenantId, establishmentSchemeObjects.id],
    ),
    foreignKey({
      name: 'est_scheme_versions_previous_fk',
      columns: [t.tenantId, t.schemeId, t.previousVersionId],
      foreignColumns: [
        establishmentSchemeVersions.tenantId,
        establishmentSchemeVersions.schemeId,
        establishmentSchemeVersions.id,
      ],
    }),
    index('est_scheme_versions_as_of').on(t.tenantId, t.schemeId, t.startDate, t.versionNo),
    check('est_scheme_versions_number_positive', sql`${t.versionNo} > 0`),
    check('est_scheme_versions_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('est_scheme_versions_name_nonempty', sql`btrim(${t.name}) <> ''`),
    check('est_scheme_versions_cycle_valid', sql`${t.cycle} IN ('annual', 'quarterly', 'monthly')`),
    check('est_scheme_versions_mode_valid', sql`${t.maintenanceMode} IN ('local', 'inclusive', 'both')`),
    check('est_scheme_versions_start_month_valid', sql`${t.startMonth} BETWEEN 1 AND 12`),
    check('est_scheme_versions_subdivision_valid', sql`${t.subdivision} IN ('none', 'position')`),
    check('est_scheme_versions_policy_valid', sql`${t.unmatchedPolicy} IN ('organization', 'reject')`),
    check('est_scheme_versions_dates_valid', sql`${t.stopDate} >= ${t.startDate}`),
  ],
);

/** 不占编组织属于某一方案版本，不能在修改方案时覆盖旧版本的排除范围。 */
export const establishmentSchemeExclusions = pgTable(
  'establishment_scheme_exclusions',
  { tenantId: tenantId(), versionId: uuid('version_id').notNull(), orgId: uuid('org_id').notNull() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.orgId] }),
    tenantReference(
      'est_scheme_exclusions_version_fk',
      [t.tenantId, t.versionId],
      [establishmentSchemeVersions.tenantId, establishmentSchemeVersions.id],
    ),
    tenantReference('est_scheme_exclusions_org_fk', [t.tenantId, t.orgId], [orgObjects.tenantId, orgObjects.id]),
  ],
);

/** docs/18 §2：最多五条占编人员范围取并集，由可信人事适配器解释雇佣关系条件。 */
export const establishmentSchemeRanges = pgTable(
  'establishment_scheme_ranges',
  {
    tenantId: tenantId(),
    versionId: uuid('version_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    employmentType: text('employment_type').notNull(),
    conditions: jsonb('conditions').$type<Record<string, string[]>>().notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.ordinal] }),
    tenantReference(
      'est_scheme_ranges_version_fk',
      [t.tenantId, t.versionId],
      [establishmentSchemeVersions.tenantId, establishmentSchemeVersions.id],
    ),
    check('est_scheme_ranges_ordinal_valid', sql`${t.ordinal} BETWEEN 0 AND 4`),
    check('est_scheme_ranges_type_nonempty', sql`btrim(${t.employmentType}) <> ''`),
  ],
);

/** 编制容量的稳定标识是组织 × 方案 × 周期，实际人数不接受客户端提供。 */
export const establishmentObjects = pgTable(
  'establishment_objects',
  {
    id: id(),
    tenantId: tenantId(),
    orgId: uuid('org_id').notNull(),
    schemeId: uuid('scheme_id').notNull(),
    periodStart: businessDate('period_start').notNull(),
    periodEnd: businessDate('period_end').notNull(),
    revision: revision(),
    createdAt: utc(),
  },
  (t) => [
    unique('est_objects_tenant_id').on(t.tenantId, t.id),
    unique('est_objects_tenant_period').on(t.tenantId, t.orgId, t.schemeId, t.periodStart),
    tenantReference('est_objects_org_fk', [t.tenantId, t.orgId], [orgObjects.tenantId, orgObjects.id]),
    tenantReference(
      'est_objects_scheme_fk',
      [t.tenantId, t.schemeId],
      [establishmentSchemeObjects.tenantId, establishmentSchemeObjects.id],
    ),
    check('est_objects_period_valid', sql`${t.periodEnd} >= ${t.periodStart}`),
    check('est_objects_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** docs/18 §4/§10：调整产生新版本，选定范围内按差值联动，不覆盖旧编制。 */
export const establishmentVersions = pgTable(
  'establishment_versions',
  {
    id: id(),
    tenantId: tenantId(),
    objectId: uuid('object_id').notNull(),
    versionNo: versionNo(),
    previousVersionId: uuid('previous_version_id'),
    startDate: businessDate('start_date').notNull(),
    localCapacity: integer('local_capacity'),
    inclusiveCapacity: integer('inclusive_capacity'),
    reservedLocal: integer('reserved_local').notNull().default(0),
    reservedInclusive: integer('reserved_inclusive').notNull().default(0),
    strictControl: boolean('strict_control').notNull().default(false),
    createdAt: utc(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('est_versions_tenant_id').on(t.tenantId, t.id),
    unique('est_versions_tenant_object_id').on(t.tenantId, t.objectId, t.id),
    unique('est_versions_tenant_number').on(t.tenantId, t.objectId, t.versionNo),
    tenantReference(
      'est_versions_object_fk',
      [t.tenantId, t.objectId],
      [establishmentObjects.tenantId, establishmentObjects.id],
    ),
    foreignKey({
      name: 'est_versions_previous_fk',
      columns: [t.tenantId, t.objectId, t.previousVersionId],
      foreignColumns: [establishmentVersions.tenantId, establishmentVersions.objectId, establishmentVersions.id],
    }),
    index('est_versions_as_of').on(t.tenantId, t.objectId, t.startDate, t.versionNo),
    check('est_versions_number_positive', sql`${t.versionNo} > 0`),
    check('est_versions_local_nonnegative', sql`${t.localCapacity} IS NULL OR ${t.localCapacity} >= 0`),
    check('est_versions_inclusive_nonnegative', sql`${t.inclusiveCapacity} IS NULL OR ${t.inclusiveCapacity} >= 0`),
    check('est_versions_reserved_nonnegative', sql`${t.reservedLocal} >= 0 AND ${t.reservedInclusive} >= 0`),
    check('est_versions_capacity_present', sql`${t.localCapacity} IS NOT NULL OR ${t.inclusiveCapacity} IS NOT NULL`),
    check(
      'est_versions_inclusive_ge_local',
      sql`${t.inclusiveCapacity} IS NULL OR ${t.localCapacity} IS NULL
      OR ${t.inclusiveCapacity} >= ${t.localCapacity}`,
    ),
  ],
);

/** 首版只支持职位细分；主表容量由细分之和加预留计算，而非把核心细分对象存入 JSON。 */
export const establishmentSubdivisions = pgTable(
  'establishment_subdivisions',
  {
    tenantId: tenantId(),
    versionId: uuid('version_id').notNull(),
    positionId: uuid('position_id').notNull(),
    localCapacity: integer('local_capacity'),
    inclusiveCapacity: integer('inclusive_capacity'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.positionId] }),
    tenantReference(
      'est_subdivisions_version_fk',
      [t.tenantId, t.versionId],
      [establishmentVersions.tenantId, establishmentVersions.id],
    ),
    tenantReference(
      'est_subdivisions_position_fk',
      [t.tenantId, t.positionId],
      [jobPositionObjects.tenantId, jobPositionObjects.id],
    ),
    check('est_subdivisions_local_nonnegative', sql`${t.localCapacity} IS NULL OR ${t.localCapacity} >= 0`),
    check('est_subdivisions_inclusive_nonnegative', sql`${t.inclusiveCapacity} IS NULL OR ${t.inclusiveCapacity} >= 0`),
    check(
      'est_subdivisions_capacity_present',
      sql`${t.localCapacity} IS NOT NULL OR ${t.inclusiveCapacity} IS NOT NULL`,
    ),
    check(
      'est_subdivisions_inclusive_ge_local',
      sql`${t.inclusiveCapacity} IS NULL OR ${t.localCapacity} IS NULL
      OR ${t.inclusiveCapacity} >= ${t.localCapacity}`,
    ),
  ],
);

/** 所有编制写事务先锁此行；首次时机必须显式配置，避免猜测占用与释放默认值。 */
export const establishmentSettings = pgTable(
  'establishment_settings',
  { tenantId: tenantId().primaryKey(), revision: integer('revision').notNull().default(0) },
  (t) => [check('est_settings_revision_nonnegative', sql`${t.revision} >= 0`)],
);

export type EstablishmentTiming = 'submitted' | 'approved';
export const establishmentTimingVersions = pgTable(
  'establishment_timing_versions',
  {
    id: id(),
    tenantId: tenantId(),
    versionNo: versionNo(),
    previousVersionId: uuid('previous_version_id'),
    startDate: businessDate('start_date').notNull(),
    transferIn: text('transfer_in').$type<EstablishmentTiming>().notNull(),
    transferOut: text('transfer_out').$type<EstablishmentTiming>().notNull(),
    createdAt: utc(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('est_timing_versions_tenant_id').on(t.tenantId, t.id),
    unique('est_timing_versions_tenant_number').on(t.tenantId, t.versionNo),
    foreignKey({
      name: 'est_timing_versions_settings_fk',
      columns: [t.tenantId],
      foreignColumns: [establishmentSettings.tenantId],
    }),
    tenantReference(
      'est_timing_versions_previous_fk',
      [t.tenantId, t.previousVersionId],
      [establishmentTimingVersions.tenantId, establishmentTimingVersions.id],
    ),
    check('est_timing_versions_number_positive', sql`${t.versionNo} > 0`),
    check('est_timing_versions_in_valid', sql`${t.transferIn} IN ('submitted', 'approved')`),
    check('est_timing_versions_out_valid', sql`${t.transferOut} IN ('submitted', 'approved')`),
  ],
);

export const ESTABLISHMENT_MOVEMENT_STATUSES = [
  'submitted',
  'approved',
  'rejected',
  'withdrawn',
  'effective',
  'failed',
] as const;
export type EstablishmentMovementStatus = (typeof ESTABLISHMENT_MOVEMENT_STATUSES)[number];

/** businessId 是调动业务的稳定编号；重复事件不能重复占用或释放编制。 */
export const establishmentMovementObjects = pgTable(
  'establishment_movement_objects',
  { id: id(), tenantId: tenantId(), businessId: text('business_id').notNull(), revision: revision(), createdAt: utc() },
  (t) => [
    unique('est_movement_objects_tenant_id').on(t.tenantId, t.id),
    unique('est_movement_objects_business_id').on(t.tenantId, t.businessId),
    check('est_movement_objects_business_nonempty', sql`btrim(${t.businessId}) <> ''`),
    check('est_movement_objects_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** 预增、预减从最新事件版本派生；员工存在性与统计由可信人事桥接验证（需取证 Q-M0-15）。 */
export const establishmentMovementVersions = pgTable(
  'establishment_movement_versions',
  {
    id: id(),
    tenantId: tenantId(),
    movementId: uuid('movement_id').notNull(),
    versionNo: versionNo(),
    previousVersionId: uuid('previous_version_id'),
    status: text('status').$type<EstablishmentMovementStatus>().notNull(),
    sourceOrgId: uuid('source_org_id').notNull(),
    targetOrgId: uuid('target_org_id').notNull(),
    sourcePositionId: uuid('source_position_id'),
    targetPositionId: uuid('target_position_id'),
    employeeId: uuid('employee_id').notNull(),
    effectiveDate: businessDate('effective_date').notNull(),
    reserveIn: boolean('reserve_in').notNull().default(false),
    reserveOut: boolean('reserve_out').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    failureReason: text('failure_reason'),
    createdAt: utc(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('est_movement_versions_tenant_id').on(t.tenantId, t.id),
    unique('est_movement_versions_tenant_object_id').on(t.tenantId, t.movementId, t.id),
    unique('est_movement_versions_tenant_number').on(t.tenantId, t.movementId, t.versionNo),
    tenantReference(
      'est_movement_versions_object_fk',
      [t.tenantId, t.movementId],
      [establishmentMovementObjects.tenantId, establishmentMovementObjects.id],
    ),
    foreignKey({
      name: 'est_movement_versions_previous_fk',
      columns: [t.tenantId, t.movementId, t.previousVersionId],
      foreignColumns: [
        establishmentMovementVersions.tenantId,
        establishmentMovementVersions.movementId,
        establishmentMovementVersions.id,
      ],
    }),
    tenantReference(
      'est_movement_versions_source_org_fk',
      [t.tenantId, t.sourceOrgId],
      [orgObjects.tenantId, orgObjects.id],
    ),
    tenantReference(
      'est_movement_versions_target_org_fk',
      [t.tenantId, t.targetOrgId],
      [orgObjects.tenantId, orgObjects.id],
    ),
    tenantReference(
      'est_movement_versions_source_position_fk',
      [t.tenantId, t.sourcePositionId],
      [jobPositionObjects.tenantId, jobPositionObjects.id],
    ),
    tenantReference(
      'est_movement_versions_target_position_fk',
      [t.tenantId, t.targetPositionId],
      [jobPositionObjects.tenantId, jobPositionObjects.id],
    ),
    index('est_movement_versions_period').on(t.tenantId, t.effectiveDate),
    check('est_movement_versions_number_positive', sql`${t.versionNo} > 0`),
    check(
      'est_movement_versions_status_valid',
      sql`${t.status} IN
      ('submitted', 'approved', 'rejected', 'withdrawn', 'effective', 'failed')`,
    ),
    check('est_movement_versions_attempts_nonnegative', sql`${t.attempts} >= 0`),
  ],
);

/** 异步复制保存不可变请求；工人只能更新 revision，运行结果另外追加版本。 */
export const establishmentCopyJobs = pgTable(
  'establishment_copy_jobs',
  { id: id(), tenantId: tenantId(), revision: revision(), createdBy: uuid('created_by'), createdAt: utc() },
  (t) => [
    unique('est_copy_jobs_tenant_id').on(t.tenantId, t.id),
    tenantReference(
      'est_copy_jobs_creator_fk',
      [t.tenantId, t.createdBy],
      [tenantMemberships.tenantId, tenantMemberships.userId],
    ),
    check('est_copy_jobs_revision_positive', sql`${t.revision} > 0`),
  ],
);

export const ESTABLISHMENT_COPY_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type EstablishmentCopyStatus = (typeof ESTABLISHMENT_COPY_STATUSES)[number];
export const establishmentCopyJobVersions = pgTable(
  'establishment_copy_job_versions',
  {
    id: id(),
    tenantId: tenantId(),
    jobId: uuid('job_id').notNull(),
    versionNo: versionNo(),
    previousVersionId: uuid('previous_version_id'),
    status: text('status').$type<EstablishmentCopyStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    failureReason: text('failure_reason'),
    createdAt: utc(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('est_copy_versions_tenant_id').on(t.tenantId, t.id),
    unique('est_copy_versions_tenant_object_id').on(t.tenantId, t.jobId, t.id),
    unique('est_copy_versions_tenant_number').on(t.tenantId, t.jobId, t.versionNo),
    tenantReference(
      'est_copy_versions_job_fk',
      [t.tenantId, t.jobId],
      [establishmentCopyJobs.tenantId, establishmentCopyJobs.id],
    ),
    foreignKey({
      name: 'est_copy_versions_previous_fk',
      columns: [t.tenantId, t.jobId, t.previousVersionId],
      foreignColumns: [
        establishmentCopyJobVersions.tenantId,
        establishmentCopyJobVersions.jobId,
        establishmentCopyJobVersions.id,
      ],
    }),
    check('est_copy_versions_number_positive', sql`${t.versionNo} > 0`),
    check('est_copy_versions_status_valid', sql`${t.status} IN ('pending', 'succeeded', 'failed')`),
    check('est_copy_versions_attempts_nonnegative', sql`${t.attempts} >= 0`),
  ],
);

export const establishmentCopyJobItems = pgTable(
  'establishment_copy_job_items',
  { tenantId: tenantId(), jobId: uuid('job_id').notNull(), capacityId: uuid('capacity_id').notNull() },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.jobId, t.capacityId] }),
    tenantReference(
      'est_copy_items_job_fk',
      [t.tenantId, t.jobId],
      [establishmentCopyJobs.tenantId, establishmentCopyJobs.id],
    ),
    tenantReference(
      'est_copy_items_capacity_fk',
      [t.tenantId, t.capacityId],
      [establishmentObjects.tenantId, establishmentObjects.id],
    ),
  ],
);

export const ESTABLISHMENT_DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'unknown'] as const;
export type EstablishmentDeliveryStatus = (typeof ESTABLISHMENT_DELIVERY_STATUSES)[number];

/** 通知保留不可变业务结果，外部投递状态由独立追加记录表示；不能提前伪造 sent。 */
export const establishmentNotifications = pgTable(
  'establishment_notifications',
  {
    id: id(),
    tenantId: tenantId(),
    jobId: uuid('job_id'),
    movementId: uuid('movement_id'),
    recipientUserId: uuid('recipient_user_id'),
    status: text('status').$type<EstablishmentDeliveryStatus>().notNull().default('pending'),
    reason: text('reason').notNull(),
    attempt: integer('attempt').notNull().default(0),
    createdAt: utc(),
  },
  (t) => [
    unique('est_notifications_tenant_id').on(t.tenantId, t.id),
    tenantReference(
      'est_notifications_job_fk',
      [t.tenantId, t.jobId],
      [establishmentCopyJobs.tenantId, establishmentCopyJobs.id],
    ),
    tenantReference(
      'est_notifications_movement_fk',
      [t.tenantId, t.movementId],
      [establishmentMovementObjects.tenantId, establishmentMovementObjects.id],
    ),
    tenantReference(
      'est_notifications_recipient_fk',
      [t.tenantId, t.recipientUserId],
      [tenantMemberships.tenantId, tenantMemberships.userId],
    ),
    check('est_notifications_status_valid', sql`${t.status} IN ('pending', 'sent', 'failed', 'unknown')`),
    check('est_notifications_attempt_nonnegative', sql`${t.attempt} >= 0`),
  ],
);

export const establishmentNotificationDeliveryAttempts = pgTable(
  'establishment_notification_delivery_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    notificationId: uuid('notification_id').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').$type<EstablishmentDeliveryStatus>().notNull(),
    failureReason: text('failure_reason'),
    createdAt: utc(),
  },
  (t) => [
    unique('est_notice_delivery_tenant_attempt').on(t.tenantId, t.notificationId, t.attempt),
    tenantReference(
      'est_notice_delivery_notice_fk',
      [t.tenantId, t.notificationId],
      [establishmentNotifications.tenantId, establishmentNotifications.id],
    ),
    check('est_notice_delivery_attempt_positive', sql`${t.attempt} > 0`),
    check('est_notice_delivery_status_valid', sql`${t.status} IN ('pending', 'sent', 'failed', 'unknown')`),
  ],
);

/** 领域事件 payload 是消息元数据；核心方案、容量、层级、调动均使用上面的明确列与关联表。 */
export const establishmentOutbox = pgTable(
  'establishment_outbox',
  {
    id: id(),
    tenantId: tenantId(),
    eventType: text('event_type').notNull(),
    objectId: text('object_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    state: text('state').$type<EstablishmentDeliveryStatus>().notNull().default('pending'),
    createdAt: utc(),
  },
  (t) => [
    unique('est_outbox_tenant_id').on(t.tenantId, t.id),
    index('est_outbox_tenant_created').on(t.tenantId, t.createdAt, t.id),
    check('est_outbox_event_nonempty', sql`btrim(${t.eventType}) <> ''`),
    check('est_outbox_object_nonempty', sql`btrim(${t.objectId}) <> ''`),
    check('est_outbox_state_valid', sql`${t.state} IN ('pending', 'sent', 'failed', 'unknown')`),
  ],
);

export const establishmentOutboxDeliveryAttempts = pgTable(
  'establishment_outbox_delivery_attempts',
  {
    id: id(),
    tenantId: tenantId(),
    outboxId: uuid('outbox_id').notNull(),
    attempt: integer('attempt').notNull(),
    state: text('state').$type<EstablishmentDeliveryStatus>().notNull(),
    failureReason: text('failure_reason'),
    createdAt: utc(),
  },
  (t) => [
    unique('est_outbox_delivery_tenant_attempt').on(t.tenantId, t.outboxId, t.attempt),
    tenantReference(
      'est_outbox_delivery_event_fk',
      [t.tenantId, t.outboxId],
      [establishmentOutbox.tenantId, establishmentOutbox.id],
    ),
    check('est_outbox_delivery_attempt_positive', sql`${t.attempt} > 0`),
    check('est_outbox_delivery_state_valid', sql`${t.state} IN ('pending', 'sent', 'failed', 'unknown')`),
  ],
);

export type EstablishmentSchemeObject = typeof establishmentSchemeObjects.$inferSelect;
export type EstablishmentSchemeVersion = typeof establishmentSchemeVersions.$inferSelect;
export type EstablishmentObject = typeof establishmentObjects.$inferSelect;
export type EstablishmentVersion = typeof establishmentVersions.$inferSelect;
export type EstablishmentSubdivisionRow = typeof establishmentSubdivisions.$inferSelect;
export type EstablishmentMovementObject = typeof establishmentMovementObjects.$inferSelect;
export type EstablishmentMovementVersion = typeof establishmentMovementVersions.$inferSelect;
export type EstablishmentCopyJob = typeof establishmentCopyJobs.$inferSelect;
export type EstablishmentCopyJobVersion = typeof establishmentCopyJobVersions.$inferSelect;
export type EstablishmentNotification = typeof establishmentNotifications.$inferSelect;
