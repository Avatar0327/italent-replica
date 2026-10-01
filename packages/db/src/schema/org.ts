/**
 * 组织主数据（R1-T03；docs/02_业务建模/10 §8、REQ-ORG-001/002）。
 * 稳定对象保存编码与并发版本；业务字段及每维层级只能追加版本，RLS 与不可变触发器见组织迁移。
 */
import type { OrgDimension } from '@italent/domain';
import { sql } from 'drizzle-orm';
import {
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
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';
import { tenants, users } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);
const utc = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();

/** DEC-060：内部主键不随业务编码改变，编码只在租户内唯一。 */
export const orgObjects = pgTable(
  'org_objects',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    revision: integer('revision').notNull().default(1),
    createdAt: utc('created_at'),
  },
  (t) => [
    unique('org_objects_tenant_id').on(t.tenantId, t.id),
    unique('org_objects_tenant_code').on(t.tenantId, t.code),
    check('org_objects_code_nonempty', sql`btrim(${t.code}) <> ''`),
    check('org_objects_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** 组织按生效日期保存历史；负责人、HRBP、成本中心保留结构化 ID，待各自模块提供引用校验。 */
export const orgVersions = pgTable(
  'org_versions',
  {
    id: id(),
    tenantId: tenantId(),
    orgId: uuid('org_id').notNull(),
    versionNo: integer('version_no').notNull(),
    previousVersionId: uuid('previous_version_id'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    stopDate: date('stop_date', { mode: 'string' }).notNull().default('9999-12-31'),
    enabled: boolean('enabled').notNull().default(true),
    name: text('name').notNull(),
    shortName: text('short_name'),
    broadType: text('broad_type').notNull().default('部门'),
    establishedOn: date('established_on', { mode: 'string' }),
    personInChargeId: uuid('person_in_charge_id'),
    hrbpId: uuid('hrbp_id'),
    costCenterId: uuid('cost_center_id'),
    location: text('location'),
    remarks: text('remarks'),
    fullName: text('full_name').notNull(),
    displayOrder: integer('display_order'),
    isVirtual: boolean('is_virtual').notNull().default(false),
    level: integer('level').notNull().default(0),
    createdAt: utc('created_at'),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('org_versions_tenant_id').on(t.tenantId, t.id),
    unique('org_versions_tenant_org_id').on(t.tenantId, t.orgId, t.id),
    unique('org_versions_tenant_org_version').on(t.tenantId, t.orgId, t.versionNo),
    foreignKey({
      name: 'org_versions_object_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    foreignKey({
      name: 'org_versions_previous_fk',
      columns: [t.tenantId, t.orgId, t.previousVersionId],
      foreignColumns: [orgVersions.tenantId, orgVersions.orgId, orgVersions.id],
    }),
    index('org_versions_tenant_as_of').on(t.tenantId, t.orgId, t.startDate, t.versionNo),
    check('org_versions_name_nonempty', sql`btrim(${t.name}) <> ''`),
    check('org_versions_version_positive', sql`${t.versionNo} > 0`),
    check('org_versions_dates_valid', sql`${t.stopDate} >= ${t.startDate}`),
    check('org_versions_level_nonnegative', sql`${t.level} >= 0`),
  ],
);

/** 每条业务版本分别保存五个维度的上级与顺序；扩展维度非必填，成本中心不是组织维度。 */
export const orgHierarchyLinks = pgTable(
  'org_hierarchy_links',
  {
    tenantId: tenantId(),
    versionId: uuid('version_id').notNull(),
    dimension: text('dimension').$type<OrgDimension>().notNull(),
    parentOrgId: uuid('parent_org_id'),
    sequence: integer('sequence'),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.versionId, t.dimension] }),
    foreignKey({
      name: 'org_hierarchy_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [orgVersions.tenantId, orgVersions.id],
    }),
    foreignKey({
      name: 'org_hierarchy_parent_fk',
      columns: [t.tenantId, t.parentOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    index('org_hierarchy_tenant_parent').on(t.tenantId, t.dimension, t.parentOrgId),
    check(
      'org_hierarchy_dimension_valid',
      sql`${t.dimension} IN ('admin', 'business', 'product', 'reserve4', 'reserve5')`,
    ),
  ],
);

/** 行政恒开；扩展维度默认关闭（fail-closed）。本行亦为租户内预占与导入改码共用的事务锁。 */
export const orgSettings = pgTable(
  'org_settings',
  {
    tenantId: tenantId().primaryKey(),
    revision: integer('revision').notNull().default(0),
    businessEnabled: boolean('business_enabled').notNull().default(false),
    productEnabled: boolean('product_enabled').notNull().default(false),
    reserve4Enabled: boolean('reserve4_enabled').notNull().default(false),
    reserve5Enabled: boolean('reserve5_enabled').notNull().default(false),
    fullNameStartLevel: integer('full_name_start_level').notNull().default(0),
    nextCodeNumber: integer('next_code_number').notNull().default(1),
  },
  (t) => [
    check('org_settings_revision_nonnegative', sql`${t.revision} >= 0`),
    check('org_settings_full_name_level_nonnegative', sql`${t.fullNameStartLevel} >= 0`),
    check('org_settings_next_code_positive', sql`${t.nextCodeNumber} > 0`),
  ],
);

export const ORG_CODE_RESERVATION_STATES = ['held', 'released', 'consumed'] as const;
export type OrgCodeReservationState = (typeof ORG_CODE_RESERVATION_STATES)[number];

/** 释放后的编码可再预占；已使用编码仍受 org_objects 的租户唯一约束保护。 */
export const orgCodeReservations = pgTable(
  'org_code_reservations',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    state: text('state').$type<OrgCodeReservationState>().notNull().default('held'),
    revision: integer('revision').notNull().default(1),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    reservedAt: utc('reserved_at'),
  },
  (t) => [
    uniqueIndex('org_code_reservations_held_code')
      .on(t.tenantId, t.code)
      .where(sql`${t.state} = 'held'`),
    index('org_code_reservations_tenant_state').on(t.tenantId, t.state),
    check('org_code_reservations_state_valid', sql`${t.state} IN ('held', 'released', 'consumed')`),
    check('org_code_reservations_revision_positive', sql`${t.revision} > 0`),
  ],
);

/** 导入原站编码只映射稳定组织 ID，业务编码修改不会改变映射或其他模块的引用。 */
export const orgImportMappings = pgTable(
  'org_import_mappings',
  {
    tenantId: tenantId(),
    sourceCode: text('source_code').notNull(),
    orgId: uuid('org_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.sourceCode] }),
    foreignKey({
      name: 'org_import_mappings_object_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
  ],
);

export const ORG_IMPORT_STATUSES = ['created', 'updated', 'conflict'] as const;
export type OrgImportStatus = (typeof ORG_IMPORT_STATUSES)[number];

/** 批量导入逐条回执，不覆盖冲突对象；回执随命令永久保留。 */
export const orgImportResults = pgTable(
  'org_import_results',
  {
    tenantId: tenantId(),
    commandId: text('command_id').notNull(),
    rowIndex: integer('row_index').notNull(),
    sourceCode: text('source_code').notNull(),
    status: text('status').$type<OrgImportStatus>().notNull(),
    orgId: uuid('org_id'),
    reason: text('reason'),
    code: text('code').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.commandId, t.rowIndex] }),
    foreignKey({
      name: 'org_import_results_object_fk',
      columns: [t.tenantId, t.orgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
    }),
    check('org_import_results_status_valid', sql`${t.status} IN ('created', 'updated', 'conflict')`),
    check('org_import_results_row_index_nonnegative', sql`${t.rowIndex} >= 0`),
  ],
);

export type OrgObject = typeof orgObjects.$inferSelect;
export type OrgVersion = typeof orgVersions.$inferSelect;
export type OrgHierarchyLink = typeof orgHierarchyLinks.$inferSelect;
export type OrgSettings = typeof orgSettings.$inferSelect;
export type OrgCodeReservation = typeof orgCodeReservations.$inferSelect;
export type OrgImportMapping = typeof orgImportMappings.$inferSelect;
export type OrgImportResult = typeof orgImportResults.$inferSelect;
