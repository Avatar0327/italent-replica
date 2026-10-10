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
  foreignKey,
  index,
  integer,
  pgTable,
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
 * 评审组 ReviewGroup（B3）：评委分组。所属组织 `owner_org_id` 必填、由创建人手选（Q-M0-132 🟢，DEC-324②），范围外与不存在同一
 * 404；所属人 `owner_id` 系统填创建人。编码租户内唯一（AGENTS §10 标识，格式同其他配置对象）。原站没有资源集合和向下公开。
 */
export const evReviewGroups = pgTable(
  'ev_review_groups',
  {
    id: id(),
    tenantId: tenantId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id').notNull(),
    ownerOrgId: uuid('owner_org_id').notNull(),
    enabled: enabled(),
    ...tracked(),
  },
  (t) => [
    unique('ev_review_groups_tenant_id').on(t.tenantId, t.id),
    unique('ev_review_groups_code').on(t.tenantId, t.code),
    check('ev_review_groups_code_format', sql`${t.code} ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$'`),
    index('ev_review_groups_owner_org').on(t.tenantId, t.ownerOrgId),
    foreignKey({
      columns: [t.tenantId, t.ownerOrgId],
      foreignColumns: [orgObjects.tenantId, orgObjects.id],
      name: 'ev_review_groups_owner_org_fk',
    }).onDelete('restrict'),
  ],
);

/** 评审组成员：整组编辑，组长恰好 1 个（库内至多 1 个，恰好 1 个由写入口保证）；`seq` 记提交顺序。 */
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
