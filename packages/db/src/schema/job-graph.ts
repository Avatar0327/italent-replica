/**
 * 职务职级图谱的派生缓存（F-474-7b；docs/08_设计/F-474-7a_职务职级图谱_设计.md §3）。
 * 两张表都不是业务事实，不走版本链；每租户一份当前快照，重新生成时整体替换。RLS / 授权在迁移里手写。
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { tenants, users } from './tenancy.js';

export const jobGraphSnapshots = pgTable(
  'job_graph_snapshots',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    revision: integer('revision').notNull().default(1),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    generatedBy: uuid('generated_by')
      .notNull()
      .references(() => users.id),
    /** 生成时点（租户本地日期）。 */
    asOfDate: date('as_of_date', { mode: 'string' }).notNull(),
    containsError: boolean('contains_error').notNull(),
    empty: boolean('empty').notNull(),
    issueCount: integer('issue_count').notNull(),
    /** 已布局的矩阵（设计 §3.1），页面与导出都不再二次计算。 */
    layout: jsonb('layout').notNull(),
  },
  (t) => [
    check('job_graph_snapshots_revision_positive', sql`${t.revision} > 0`),
    check('job_graph_snapshots_issue_count', sql`${t.issueCount} >= 0`),
    check('job_graph_layout_object', sql`jsonb_typeof(${t.layout}) = 'object'`),
  ],
);

export const jobGraphIssues = pgTable(
  'job_graph_issues',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    id: uuid('id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    kind: text('kind').notNull(),
    objectId: uuid('object_id').notNull(),
    /** 生成时的名称快照，列表不再联表。 */
    objectName: text('object_name').notNull(),
    /** [{ code, params }]：编码 + 参数，文案走资源文件（DEC-045）。 */
    reasons: jsonb('reasons').notNull(),
    sortKey: integer('sort_key').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index('job_graph_issues_tenant_kind').on(t.tenantId, t.kind, t.sortKey),
    check('job_graph_issues_kind', sql`${t.kind} IN ('level','post')`),
    check(
      'job_graph_issues_reasons_array',
      sql`jsonb_typeof(${t.reasons}) = 'array' AND jsonb_array_length(${t.reasons}) > 0`,
    ),
  ],
);
