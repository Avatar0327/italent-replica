/**
 * Offer（R2 BE-14a；docs/02_业务建模/34 §2、OF-R1，字段见 01_证据/导出/R2_对象字段_配置证据.md）。
 * Offer 不是任职记录：头行原地更新、带 revision，字段级前后快照写统一审计（DEC-019），删除保留快照。
 * 引用列都用（租户, ID）复合外键，跨租户或不存在的引用由数据库拒绝。待入职关联（pending_entry_business_id）
 * 由 BE-14b2 写入；发送人 / 发送时间与发送记录（offer_send_records）由 BE-14b1 写入。
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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { contractCompanies } from './contracts.js';
import { employmentBusinessObjects, employmentEmployees } from './employment.js';
import { jobLevelObjects, jobPositionObjects, jobPostObjects } from './job.js';
import { orgObjects } from './org.js';
import { tenants } from './tenancy.js';

const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const day = (name: string) => date(name, { mode: 'string' });
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

export const offers = pgTable(
  'offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    entry: text('entry').notNull(),
    offerType: text('offer_type'),
    source: text('source').notNull().default('new_hire'),
    status: text('status').notNull().default('pending'),
    approvalStatus: text('approval_status').notNull().default('unsubmitted'),
    // 基本信息
    name: text('name'),
    personalEmail: text('personal_email'),
    mobile: text('mobile'),
    gender: text('gender'),
    idType: text('id_type'),
    idNumber: text('id_number'),
    birthDate: day('birth_date'),
    workStartDate: day('work_start_date'),
    // 招聘信息（不做招聘系统，只保存字段）
    channelName: text('channel_name'),
    appliedPosition: text('applied_position'),
    recruitmentDemand: text('recruitment_demand'),
    // 任职信息
    departmentId: uuid('department_id'),
    plannedEntryDate: day('planned_entry_date'),
    positionId: uuid('position_id'),
    postId: uuid('post_id'),
    levelId: uuid('level_id'),
    workPlace: text('work_place'),
    hasProbation: boolean('has_probation'),
    probationMonths: integer('probation_months'),
    directManagerId: uuid('direct_manager_id'),
    dottedManagerId: uuid('dotted_manager_id'),
    hrbpId: uuid('hrbp_id'),
    costCenter: text('cost_center'),
    // 合同
    contractCompanyId: uuid('contract_company_id'),
    contractTermType: text('contract_term_type'),
    contractMonths: integer('contract_months'),
    contractEndDate: day('contract_end_date'),
    // 薪资、社保（只保存，不写档案）
    salaryBeforeRegular: money('salary_before_regular'),
    salaryAfterRegular: money('salary_after_regular'),
    socialInsuranceBase: money('social_insurance_base'),
    housingFundBase: money('housing_fund_base'),
    // 转移 / 失效表单
    acceptTime: day('accept_time'),
    refusalTime: day('refusal_time'),
    refusalReasonCode: text('refusal_reason_code'),
    refusalRemark: text('refusal_remark'),
    invalidReasonCode: text('invalid_reason_code'),
    invalidRemark: text('invalid_remark'),
    invalidAt: timestamp('invalid_at', { withTimezone: true }),
    sentBy: uuid('sent_by'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    campusOfferId: uuid('campus_offer_id'),
    copiedFromOfferId: uuid('copied_from_offer_id'),
    pendingEntryBusinessId: uuid('pending_entry_business_id'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('offers_tenant_id').on(t.tenantId, t.id),
    index('offers_status').on(t.tenantId, t.status, t.approvalStatus, t.createdAt),
    foreignKey({
      name: 'offers_department_fk',
      columns: [t.tenantId, t.departmentId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    foreignKey({
      name: 'offers_position_fk',
      columns: [t.tenantId, t.positionId],
      foreignColumns: [jobPositionObjects.tenantId, jobPositionObjects.id],
    }),
    foreignKey({
      name: 'offers_post_fk',
      columns: [t.tenantId, t.postId],
      foreignColumns: [jobPostObjects.tenantId, jobPostObjects.id],
    }),
    foreignKey({
      name: 'offers_level_fk',
      columns: [t.tenantId, t.levelId],
      foreignColumns: [jobLevelObjects.tenantId, jobLevelObjects.id],
    }),
    ...(['directManagerId', 'dottedManagerId', 'hrbpId'] as const).map((column) =>
      foreignKey({
        name: `offers_${column}_fk`,
        columns: [t.tenantId, t[column]],
        foreignColumns: [employmentEmployees.tenantId, employmentEmployees.id],
      }),
    ),
    foreignKey({
      name: 'offers_contract_company_fk',
      columns: [t.tenantId, t.contractCompanyId],
      foreignColumns: [contractCompanies.tenantId, contractCompanies.id],
    }),
    foreignKey({
      name: 'offers_campus_offer_fk',
      columns: [t.tenantId, t.campusOfferId],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: 'offers_copied_from_fk',
      columns: [t.tenantId, t.copiedFromOfferId],
      foreignColumns: [t.tenantId, t.id],
    }),
    foreignKey({
      name: 'offers_pending_entry_fk',
      columns: [t.tenantId, t.pendingEntryBusinessId],
      foreignColumns: [employmentBusinessObjects.tenantId, employmentBusinessObjects.id],
    }),
    check('offers_entry', sql`${t.entry} IN ('offer', 'intern', 'campus_early_intern')`),
    check('offers_type', sql`${t.offerType} IS NULL OR ${t.offerType} IN ('social', 'campus', 'intern')`),
    check('offers_source', sql`${t.source} IN ('new_hire', 'intern_conversion')`),
    check(
      'offers_status_value',
      sql`${t.status} IN ('pending', 'sent', 'accepted', 'rejected', 'onboarded', 'invalid')`,
    ),
    check(
      'offers_approval_status',
      sql`${t.approvalStatus} IN ('unsubmitted', 'approving', 'approved', 'disapproved')`,
    ),
    check('offers_accepted_time', sql`${t.status} <> 'accepted' OR ${t.acceptTime} IS NOT NULL`),
    check(
      'offers_rejected_form',
      sql`${t.status} <> 'rejected' OR (${t.refusalTime} IS NOT NULL AND ${t.refusalReasonCode} IS NOT NULL)`,
    ),
    check(
      'offers_invalid_form',
      sql`${t.status} <> 'invalid' OR (${t.invalidReasonCode} IS NOT NULL AND ${t.invalidAt} IS NOT NULL)`,
    ),
    check('offers_probation_months', sql`${t.probationMonths} IS NULL OR ${t.probationMonths} BETWEEN 0 AND 120`),
    check('offers_contract_months', sql`${t.contractMonths} IS NULL OR ${t.contractMonths} BETWEEN 0 AND 1200`),
    check('offers_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** Offer 拒绝原因 / 失效原因两个字典（A37）：编码租户内唯一（不分大小写）、保存后不可改，可改名、停用、调顺序。 */
export const offerDictionaryItems = pgTable(
  'offer_dictionary_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: text('kind').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(0),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('offer_dictionary_items_tenant_id').on(t.tenantId, t.id),
    uniqueIndex('offer_dictionary_items_code_unique').on(t.tenantId, t.kind, sql`lower(${t.code})`),
    check('offer_dictionary_items_kind', sql`${t.kind} IN ('refusal-reasons', 'invalid-reasons')`),
    check('offer_dictionary_items_code', sql`btrim(${t.code}) <> ''`),
    check('offer_dictionary_items_name', sql`btrim(${t.name}) <> ''`),
    check('offer_dictionary_items_order', sql`${t.displayOrder} >= 0`),
    check('offer_dictionary_items_revision', sql`${t.revision} > 0`),
  ],
);

/**
 * Offer 发送记录（BE-14b1，OF-R5）：每次发送 / 重发写一行，兼作邮件 outbox（状态 pending / sent / failed / unknown，
 * AGENTS §10 事件）。随 Offer 删除（只有待发可删）一并删除，删除前的发送历史写进删除审计的快照（AGENTS §5）。
 * 首版没有投递通道，只记 pending，界面不显示投递状态；答复链接令牌归候选人答复页（F-183），不在这里存。
 */
export const offerSendRecords = pgTable(
  'offer_send_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    offerId: uuid('offer_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('pending'),
    recipient: text('recipient').notNull(),
    cc: text('cc')
      .array()
      .notNull()
      .default(sql`'{}'`),
    bcc: text('bcc')
      .array()
      .notNull()
      .default(sql`'{}'`),
    sentBy: uuid('sent_by').notNull(),
    commandId: text('command_id').notNull(),
    createdAt: utc('created_at'),
  },
  (t) => [
    unique('offer_send_records_tenant_id').on(t.tenantId, t.id),
    index('offer_send_records_offer').on(t.tenantId, t.offerId, t.createdAt),
    foreignKey({
      name: 'offer_send_records_offer_fk',
      columns: [t.tenantId, t.offerId],
      foreignColumns: [offers.tenantId, offers.id],
    }).onDelete('cascade'),
    check('offer_send_records_kind', sql`${t.kind} IN ('send', 'resend')`),
    check('offer_send_records_status', sql`${t.status} IN ('pending', 'sent', 'failed', 'unknown')`),
  ],
);

/**
 * Offer 批量审批单（R2 BE-14a3，OF-R15）：审批主体组织 + 备注，子表见 offerBatchApprovalItems。状态跟随审批实例：
 * approving → approved / disapproved；驳回、撤回后单据作废（returned / withdrawn），子表 Offer 回到“未发起审批”。
 */
export const offerBatchApprovals = pgTable(
  'offer_batch_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    approvalSubjectOrgId: uuid('approval_subject_org_id').notNull(),
    remark: text('remark'),
    status: text('status').notNull().default('approving'),
    revision: integer('revision').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: utc('created_at'),
    updatedAt: utc('updated_at'),
  },
  (t) => [
    unique('offer_batch_approvals_tenant_id').on(t.tenantId, t.id),
    foreignKey({
      name: 'offer_batch_approvals_subject_org_fk',
      columns: [t.tenantId, t.approvalSubjectOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    check(
      'offer_batch_approvals_status',
      sql`${t.status} IN ('approving', 'approved', 'disapproved', 'returned', 'withdrawn', 'cancelled')`,
    ),
    check('offer_batch_approvals_revision', sql`${t.revision} > 0`),
  ],
);

/** 批量审批单的 Offer 子表：按提交顺序；被批量单引用的 Offer 不能删除（复合外键）。 */
export const offerBatchApprovalItems = pgTable(
  'offer_batch_approval_items',
  {
    tenantId: tenantId(),
    batchId: uuid('batch_id').notNull(),
    offerId: uuid('offer_id').notNull(),
    seq: integer('seq').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.batchId, t.offerId] }),
    unique('offer_batch_approval_items_seq').on(t.tenantId, t.batchId, t.seq),
    index('offer_batch_approval_items_offer').on(t.tenantId, t.offerId),
    foreignKey({
      name: 'offer_batch_approval_items_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [offerBatchApprovals.tenantId, offerBatchApprovals.id],
    }),
    foreignKey({
      name: 'offer_batch_approval_items_offer_fk',
      columns: [t.tenantId, t.offerId],
      foreignColumns: [offers.tenantId, offers.id],
    }),
    check('offer_batch_approval_items_seq_positive', sql`${t.seq} > 0`),
  ],
);
