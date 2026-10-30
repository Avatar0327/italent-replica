/**
 * 组织调整申请（R2-T08 设计 §2.1 / §2.2；docs/02_业务建模/33）。
 * 申请单是独立业务对象（DEC-526②）：审批状态与执行状态各一列，各自 CHECK，不加跨列组合约束（BE-10c～11b 之间合法存在
 * “审批通过 + 未执行”，组合由服务端状态机保证）。“变更前”值不建列：明细只存目标稳定 ID + 基线版本，原上级 / 原名称 /
 * 原负责人一律从基线版本读（硬规则 3 同口径）。所有表带 tenant_id、FORCE RLS（迁移里 enable_tenant_isolation）。
 * 其余明细与执行表（§2.3）随各自批次的迁移追加。
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
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { employmentEmployees } from './employment.js';
import { orgObjects, orgVersions } from './org.js';
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

/** 申请单头（§2.1）；组织多选调整范围在 §2.1A 子表。 */
export const orgAdjustments = pgTable(
  'org_adjustments',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    subject: text('subject').notNull(),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    content: text('content'),
    approvalSubjectOrgId: uuid('approval_subject_org_id').notNull(),
    /** 0 已暂存（列表另有“草稿”同筛 0）/ 1 审批中 / 2 审批通过 / 3 审批未通过 / 4 生效（复刻不写入）/ 5 作废 / 6 已驳回。 */
    approvalStatus: smallint('approval_status').notNull().default(0),
    /** 1 未执行 / 2 已执行 / 3 执行中。 */
    executionStatus: smallint('execution_status').notNull().default(1),
    executionNote: text('execution_note'),
    dataVolume: integer('data_volume').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    failureCount: integer('failure_count').notNull().default(0),
    approvedAt: utc('approved_at'),
    executedAt: utc('executed_at'),
    createdBy: uuid('created_by').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at').notNull().defaultNow(),
    updatedAt: utc('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('org_adjustments_tenant_id').on(t.tenantId, t.id),
    unique('org_adjustments_tenant_code').on(t.tenantId, t.code),
    foreignKey({
      name: 'org_adjustments_subject_org_fk',
      columns: [t.tenantId, t.approvalSubjectOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    foreignKey({
      name: 'org_adjustments_creator_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.userId],
    }),
    index('org_adjustments_subject_org').on(t.tenantId, t.approvalSubjectOrgId, t.effectiveDate),
    index('org_adjustments_status').on(t.tenantId, t.approvalStatus, t.createdAt),
    check('org_adjustments_approval_status', sql`${t.approvalStatus} IN (0, 1, 2, 3, 4, 5, 6)`),
    check('org_adjustments_execution_status', sql`${t.executionStatus} IN (1, 2, 3)`),
    check('org_adjustments_subject', sql`btrim(${t.subject}) <> '' AND char_length(${t.subject}) <= 100`),
    check('org_adjustments_content', sql`char_length(COALESCE(${t.content}, '')) <= 2000`),
    check('org_adjustments_counts', sql`${t.dataVolume} >= 0 AND ${t.successCount} >= 0 AND ${t.failureCount} >= 0`),
    check('org_adjustments_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** R2-T08 §2.1A：选择顺序独立保存，同租户外键；数量/生效日启用校验随 10b1 写入口落地。 */
export const orgAdjustmentRangeOrgs = pgTable(
  'org_adjustment_range_orgs',
  {
    tenantId: tenantId(),
    adjustmentId: uuid('adjustment_id').notNull(),
    orgId: uuid('org_id').notNull(),
    seq: integer('seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.adjustmentId, t.orgId] }),
    foreignKey({
      name: 'org_adjustment_range_adjustment_fk',
      columns: [t.tenantId, t.adjustmentId],
      foreignColumns: [orgAdjustments.tenantId, orgAdjustments.id],
    }),
    foreignKey({
      name: 'org_adjustment_range_org_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    index('org_adjustment_range_org').on(t.tenantId, t.orgId),
  ],
);

/** 组织明细的列（拆出来是为了让约束回调保持短小）。 */
const itemColumns = {
  id: id(),
  tenantId: tenantId(),
  adjustmentId: uuid('adjustment_id').notNull(),
  seq: integer('seq').notNull(),
  adjustType: smallint('adjust_type').notNull(),
  targetOrgId: uuid('target_org_id'),
  baseVersionId: uuid('base_version_id'),
  baseOrgRevision: integer('base_org_revision'),
  /** 被连带停用的下级行指向发起停用的行（OA-R5）。 */
  cascadedFromItemId: uuid('cascaded_from_item_id'),
  name: text('name'),
  code: text('code'),
  shortName: text('short_name'),
  /** 新上级（行政维度）二选一：既有组织用 ID，同单新增组织用明细 ID（§2.6）。 */
  parentOrgId: uuid('parent_org_id'),
  parentItemId: uuid('parent_item_id'),
  displayOrder: integer('display_order'),
  level: smallint('level'),
  /** 1 高半级显示 / 2 低半级显示。 */
  halfLevel: smallint('half_level'),
  updateDescendantLevels: boolean('update_descendant_levels'),
  personInChargeId: uuid('person_in_charge_id'),
  hrbpId: uuid('hrbp_id'),
  addEmployment: boolean('add_employment'),
  transferOldHeadSubordinates: boolean('transfer_old_head_subordinates'),
  adjustNewHeadManager: boolean('adjust_new_head_manager'),
  newHeadManagerId: uuid('new_head_manager_id'),
  /** 同步调整编制与停用方式 1 在 A-4 拍板前关闭（BE-10b 拦截）。 */
  syncEstablishment: boolean('sync_establishment'),
  /** 1 各上级编制同步减少 / 2 编制转移至目标组织。 */
  deactivationEstablishmentMode: smallint('deactivation_establishment_mode'),
  establishmentTransferAmount: integer('establishment_transfer_amount'),
  batchTransfer: boolean('batch_transfer'),
  transferToOrgId: uuid('transfer_to_org_id'),
  transferToItemId: uuid('transfer_to_item_id'),
  /** 原站明细字段“是否暂存”：A-8b 拍板前含暂存行的单据不能提交。 */
  isStaged: boolean('is_staged').notNull().default(false),
  /** OA-R6 组织自定义字段成对调整（规格要求的自定义字段例外，AGENTS §7）。 */
  oldCustomFields: jsonb('old_custom_fields'),
  newCustomFields: jsonb('new_custom_fields'),
  /** 执行结果（§2.6 / §7.5）：新增落下的正式组织 ID、本行落下的组织版本、1 成功 / 2 失败、恢复阶段与任职联动进度。 */
  createdOrgId: uuid('created_org_id'),
  executedVersionId: uuid('executed_version_id'),
  executionResult: smallint('execution_result'),
  executionReason: text('execution_reason'),
  executionMessage: text('execution_message'),
  execPhase: smallint('exec_phase').notNull().default(0),
  employmentCursor: uuid('employment_cursor'),
  employmentDone: integer('employment_done').notNull().default(0),
  employmentFailed: integer('employment_failed').notNull().default(0),
};
type ItemColumns = Record<keyof typeof itemColumns, AnyPgColumn>;

/** 同单明细之间的引用复合键含 adjustment_id，引用别的单的明细会被外键拒绝；其余指向组织 / 版本 / 员工。 */
const itemReferences = (t: ItemColumns) => [
  foreignKey({
    name: 'org_adjustment_org_items_adjustment_fk',
    columns: [t.tenantId, t.adjustmentId],
    foreignColumns: [orgAdjustments.tenantId, orgAdjustments.id],
  }),
  // 同单明细之间的引用：复合键含 adjustment_id，引用别的单的明细会被外键拒绝
  foreignKey({
    name: 'org_adjustment_org_items_cascade_fk',
    columns: [t.tenantId, t.adjustmentId, t.cascadedFromItemId],
    foreignColumns: [t.tenantId, t.adjustmentId, t.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_parent_item_fk',
    columns: [t.tenantId, t.adjustmentId, t.parentItemId],
    foreignColumns: [t.tenantId, t.adjustmentId, t.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_transfer_item_fk',
    columns: [t.tenantId, t.adjustmentId, t.transferToItemId],
    foreignColumns: [t.tenantId, t.adjustmentId, t.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_target_fk',
    columns: [t.tenantId, t.targetOrgId],
    foreignColumns: [orgObjects.tenantId, orgObjects.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_parent_org_fk',
    columns: [t.tenantId, t.parentOrgId],
    foreignColumns: [orgObjects.tenantId, orgObjects.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_transfer_org_fk',
    columns: [t.tenantId, t.transferToOrgId],
    foreignColumns: [orgObjects.tenantId, orgObjects.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_created_org_fk',
    columns: [t.tenantId, t.createdOrgId],
    foreignColumns: [orgObjects.tenantId, orgObjects.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_base_version_fk',
    columns: [t.tenantId, t.baseVersionId],
    foreignColumns: [orgVersions.tenantId, orgVersions.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_executed_version_fk',
    columns: [t.tenantId, t.executedVersionId],
    foreignColumns: [orgVersions.tenantId, orgVersions.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_head_fk',
    columns: [t.tenantId, t.personInChargeId],
    foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_hrbp_fk',
    columns: [t.tenantId, t.hrbpId],
    foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
  }),
  foreignKey({
    name: 'org_adjustment_org_items_new_manager_fk',
    columns: [t.tenantId, t.newHeadManagerId],
    foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
  }),
];

const itemChecks = (t: ItemColumns) => [
  check('org_adjustment_org_items_type', sql`${t.adjustType} IN (1, 2, 3)`),
  // 新增没有目标组织；变更 / 停用必须有目标
  check('org_adjustment_org_items_target_shape', sql`(${t.adjustType} = 1) = (${t.targetOrgId} IS NULL)`),
  check('org_adjustment_org_items_seq_positive', sql`${t.seq} > 0`),
  check('org_adjustment_org_items_level', sql`${t.level} IS NULL OR ${t.level} BETWEEN 1 AND 10`),
  check('org_adjustment_org_items_half_level', sql`${t.halfLevel} IS NULL OR ${t.halfLevel} IN (1, 2)`),
  check(
    'org_adjustment_org_items_deactivation_mode',
    sql`${t.deactivationEstablishmentMode} IS NULL OR ${t.deactivationEstablishmentMode} IN (1, 2)`,
  ),
  check('org_adjustment_org_items_parent_exclusive', sql`${t.parentOrgId} IS NULL OR ${t.parentItemId} IS NULL`),
  check(
    'org_adjustment_org_items_transfer_exclusive',
    sql`${t.transferToOrgId} IS NULL OR ${t.transferToItemId} IS NULL`,
  ),
  check(
    'org_adjustment_org_items_amount',
    sql`${t.establishmentTransferAmount} IS NULL OR ${t.establishmentTransferAmount} >= 0`,
  ),
  check('org_adjustment_org_items_result', sql`${t.executionResult} IS NULL OR ${t.executionResult} IN (1, 2)`),
  check('org_adjustment_org_items_phase', sql`${t.execPhase} IN (0, 1, 2)`),
  check('org_adjustment_org_items_progress', sql`${t.employmentDone} >= 0 AND ${t.employmentFailed} >= 0`),
];

/** 组织明细（§2.2）：新增 1 / 变更 2 / 停用 3，目标是稳定 ID，基线是生效日的现行版本（§2.5）。 */
export const orgAdjustmentOrgItems = pgTable('org_adjustment_org_items', itemColumns, (t) => [
  unique('org_adjustment_org_items_tenant_item').on(t.tenantId, t.adjustmentId, t.id),
  unique('org_adjustment_org_items_seq').on(t.tenantId, t.adjustmentId, t.seq),
  // 既有组织在一张单里只出现一次（新增行目标为空，NULL 不互斥）
  unique('org_adjustment_org_items_target').on(t.tenantId, t.adjustmentId, t.targetOrgId),
  uniqueIndex('org_adjustment_org_items_created_org')
    .on(t.tenantId, t.createdOrgId)
    .where(sql`${t.createdOrgId} IS NOT NULL`),
  ...itemReferences(t),
  ...itemChecks(t),
]);
