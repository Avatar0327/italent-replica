/**
 * 审批变量与审批矩阵（F-326 S1；设计 §2.1）。五张表都带 tenant_id 并强制 RLS（迁移里调 enable_tenant_isolation）。
 * 变量与矩阵头只启停不删除（设计 §2.5，应用角色无 DELETE 权限）；矩阵的列 / 行 / 单元格整体重写（PUT structure），可删。
 * 编码前缀、适用范围与描述的互斥由 CHECK 兜底，领域规则的单一来源是 packages/domain/src/approval/variables.ts。
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
  uuid,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { approvalProcessVersions, approvalProcesses } from './approval.js';
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

/** 创建人 / 最近修改人与时间：服务端在同一事务内写，不接受客户端传值（设计 §2.6）。 */
const auditColumns = () => ({
  revision: integer('revision').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: utc('created_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: utc('updated_at').notNull().defaultNow(),
});

const STATUSES = sql`('draft','enabled','disabled')`;

export const approvalVariables = pgTable(
  'approval_variables',
  {
    id: id(),
    tenantId: tenantId(),
    /** public 公共变量 / application 应用变量，创建后不可改。 */
    scope: text('scope').notNull(),
    /** 应用变量所属应用（须在 APP_IDS 内，由领域层校验，新增应用不必改迁移）；公共变量为空。 */
    appId: text('app_id'),
    /** 完整编码含前缀，创建后不可改。 */
    code: text('code').notNull(),
    name: text('name').notNull(),
    dataType: text('data_type').notNull(),
    defaultValue: jsonb('default_value'),
    /** 只用于公共变量：process / business_rule / message_template 的非空子集；应用变量为空数组。 */
    usageScopes: text('usage_scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    description: text('description'),
    status: text('status').notNull().default('draft'),
    /** manual 人工创建 / auto 由流程设计器的“指定人员”自动生成（DEC-858，设计 §5.5 ⑤）；创建后不可改。 */
    origin: text('origin').notNull().default('manual'),
    /** 以下 4 列仅自动变量有值；版本属于该流程的一致性由 S7a 写入时保证，不加触发器。 */
    originProcessId: uuid('origin_process_id'),
    originVersionId: uuid('origin_version_id'),
    originNodeKey: text('origin_node_key'),
    /** approver 审批人位置 / empty_approver 审批人为空时的指定人员。 */
    originSlot: text('origin_slot'),
    ...auditColumns(),
  },
  (t) => [
    unique('approval_variables_tenant_id').on(t.tenantId, t.id),
    unique('approval_variables_code').on(t.tenantId, t.code),
    index('approval_variables_list').on(t.tenantId, t.scope, t.status),
    // 一个版本的一个位置最多归属一条未停用（草稿 / 启用）的自动变量，也兜住并发重复生成（DEC-858）；
    // 停用的旧变量保留作历史，不占位，否则节点改回“指定人员”或停用后重存都无法生成新变量
    uniqueIndex('approval_variables_origin_slot')
      .on(t.tenantId, t.originVersionId, t.originNodeKey, t.originSlot)
      .where(sql`${t.origin} = 'auto' AND ${t.status} <> 'disabled'`),
    // 供模拟与候选过滤按来源流程取自动变量集合
    index('approval_variables_origin_process')
      .on(t.tenantId, t.originProcessId)
      .where(sql`${t.origin} = 'auto'`),
    foreignKey({
      name: 'approval_variables_origin_process_fk',
      columns: [t.tenantId, t.originProcessId],
      foreignColumns: [approvalProcesses.tenantId, approvalProcesses.id],
    }),
    foreignKey({
      name: 'approval_variables_origin_version_fk',
      columns: [t.tenantId, t.originVersionId],
      foreignColumns: [approvalProcessVersions.tenantId, approvalProcessVersions.id],
    }),
    memberFk('approval_variables_creator', t.tenantId, t.createdBy),
    memberFk('approval_variables_updater', t.tenantId, t.updatedBy),
    check('approval_variables_scope', sql`${t.scope} IN ('public','application')`),
    check(
      'approval_variables_data_type',
      sql`${t.dataType} IN ('string','integer','decimal','datetime','boolean','person','persons')`,
    ),
    check('approval_variables_status', sql`${t.status} IN ${STATUSES}`),
    check('approval_variables_revision', sql`${t.revision} > 0`),
    check('approval_variables_name', sql`char_length(btrim(${t.name})) > 0`),
    // 编码前缀系统固定，两类规则分开（设计 §2.2）
    check(
      'approval_variables_code_format',
      sql`(${t.scope} = 'public' AND ${t.code} ~ '^Global\\.B\\.[A-Za-z][A-Za-z0-9_]{0,63}$')
        OR (${t.scope} = 'application' AND ${t.code} ~ '^B\\.[A-Za-z0-9_]{1,64}$')`,
    ),
    // 公共变量：无应用、适用范围为三项的非空子集；应用变量：必有应用，无适用范围与描述
    check(
      'approval_variables_scope_columns',
      sql`(${t.scope} = 'public' AND ${t.appId} IS NULL
          AND cardinality(${t.usageScopes}) >= 1
          AND ${t.usageScopes} <@ ARRAY['process','business_rule','message_template']::text[])
        OR (${t.scope} = 'application' AND ${t.appId} IS NOT NULL
          AND cardinality(${t.usageScopes}) = 0 AND ${t.description} IS NULL)`,
    ),
    check('approval_variables_origin', sql`${t.origin} IN ('manual','auto')`),
    check('approval_variables_origin_slot_value', sql`${t.originSlot} IN ('approver','empty_approver')`),
    // 人工变量没有来源；自动变量 4 列全非空，且只能是适用范围恰为流程的公共人员类变量
    check(
      'approval_variables_origin_columns',
      sql`(${t.origin} = 'manual' AND ${t.originProcessId} IS NULL AND ${t.originVersionId} IS NULL
          AND ${t.originNodeKey} IS NULL AND ${t.originSlot} IS NULL)
        OR (${t.origin} = 'auto' AND ${t.originProcessId} IS NOT NULL AND ${t.originVersionId} IS NOT NULL
          AND ${t.originNodeKey} IS NOT NULL AND ${t.originSlot} IS NOT NULL
          AND ${t.scope} = 'public' AND ${t.dataType} IN ('person','persons')
          AND ${t.usageScopes} = ARRAY['process']::text[])`,
    ),
  ],
);

export const approvalMatrices = pgTable(
  'approval_matrices',
  {
    id: id(),
    tenantId: tenantId(),
    /** 创建后只读；规格只写“编码必填，编辑时只读”，不加前缀。 */
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('draft'),
    ...auditColumns(),
  },
  (t) => [
    unique('approval_matrices_tenant_id').on(t.tenantId, t.id),
    unique('approval_matrices_code').on(t.tenantId, t.code),
    index('approval_matrices_list').on(t.tenantId, t.status),
    memberFk('approval_matrices_creator', t.tenantId, t.createdBy),
    memberFk('approval_matrices_updater', t.tenantId, t.updatedBy),
    check('approval_matrices_status', sql`${t.status} IN ${STATUSES}`),
    check('approval_matrices_revision', sql`${t.revision} > 0`),
    check('approval_matrices_name', sql`char_length(btrim(${t.name})) > 0`),
    check('approval_matrices_code_format', sql`${t.code} ~ '^[A-Za-z0-9_]{1,64}$'`),
  ],
);

export const approvalMatrixColumns = pgTable(
  'approval_matrix_columns',
  {
    id: id(),
    tenantId: tenantId(),
    matrixId: uuid('matrix_id').notNull(),
    /** condition 条件列 / role 角色列。 */
    kind: text('kind').notNull(),
    /** 只用于条件列：department / position / job（设计 §3.3）；角色列为空。 */
    dimension: text('dimension'),
    /** 只用于 department 条件列：是否包含下级。 */
    includeChildren: boolean('include_children').notNull().default(false),
    name: text('name').notNull(),
    seq: integer('seq').notNull(),
    /** 只用于角色列：本列单元格是否允许多人。 */
    allowMultiple: boolean('allow_multiple').notNull().default(false),
  },
  (t) => [
    unique('approval_matrix_columns_tenant_id').on(t.tenantId, t.id),
    unique('approval_matrix_columns_name').on(t.tenantId, t.matrixId, t.name),
    foreignKey({
      name: 'approval_matrix_columns_matrix',
      columns: [t.tenantId, t.matrixId],
      foreignColumns: [approvalMatrices.tenantId, approvalMatrices.id],
    }),
    check('approval_matrix_columns_name_nonempty', sql`char_length(btrim(${t.name})) > 0`),
    check(
      'approval_matrix_columns_kind',
      sql`(${t.kind} = 'condition' AND ${t.dimension} IS NOT NULL AND ${t.dimension} IN ('department','position','job'))
        OR (${t.kind} = 'role' AND ${t.dimension} IS NULL)`,
    ),
    check(
      'approval_matrix_columns_include_children',
      sql`NOT ${t.includeChildren} OR ${t.dimension} IS NOT DISTINCT FROM 'department'`,
    ),
    check('approval_matrix_columns_allow_multiple', sql`NOT ${t.allowMultiple} OR ${t.kind} = 'role'`),
  ],
);

export const approvalMatrixRows = pgTable(
  'approval_matrix_rows',
  {
    id: id(),
    tenantId: tenantId(),
    matrixId: uuid('matrix_id').notNull(),
    /** 页面“顺序”：同矩阵内唯一，取第一条命中行；调序整体重写（设计 §3.3）。 */
    seq: integer('seq').notNull(),
  },
  (t) => [
    unique('approval_matrix_rows_tenant_id').on(t.tenantId, t.id),
    unique('approval_matrix_rows_seq').on(t.tenantId, t.matrixId, t.seq),
    foreignKey({
      name: 'approval_matrix_rows_matrix',
      columns: [t.tenantId, t.matrixId],
      foreignColumns: [approvalMatrices.tenantId, approvalMatrices.id],
    }),
    check('approval_matrix_rows_seq_positive', sql`${t.seq} > 0`),
  ],
);

export const approvalMatrixCells = pgTable(
  'approval_matrix_cells',
  {
    tenantId: tenantId(),
    rowId: uuid('row_id').notNull(),
    columnId: uuid('column_id').notNull(),
    /** 条件列存组织 / 职位 / 职务 id（可多值，表示“任一”）；角色列存用户 id；空数组即“空格”。 */
    refIds: uuidArray('ref_ids'),
  },
  (t) => [
    primaryKey({ name: 'approval_matrix_cells_pk', columns: [t.tenantId, t.rowId, t.columnId] }),
    // 行 / 列删除时单元格随之清掉；删除前的内容由结构审计与行删除快照保留（设计 §4.5）
    foreignKey({
      name: 'approval_matrix_cells_row',
      columns: [t.tenantId, t.rowId],
      foreignColumns: [approvalMatrixRows.tenantId, approvalMatrixRows.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'approval_matrix_cells_column',
      columns: [t.tenantId, t.columnId],
      foreignColumns: [approvalMatrixColumns.tenantId, approvalMatrixColumns.id],
    }).onDelete('cascade'),
    // 角色格上限 100 人是最大值；条件格 ≤50 与整表 ≤20000 个 id 依赖列类型和矩阵汇总，由保存校验把关（设计 §2.1）
    check('approval_matrix_cells_size', sql`cardinality(${t.refIds}) <= 100`),
  ],
);

function uuidArray(name: string) {
  return uuid(name)
    .array()
    .notNull()
    .default(sql`'{}'::uuid[]`);
}
