/**
 * 审计日志（R1-T16；DEC-019；docs/02_业务建模/20；REQ-AUD-001）的另外两类记录，均为租户级（RLS）、只追加：
 * - 对象操作日志：批量编辑 / 导入 / 导出 / 下载 / 打印等任务级日志（原站 TenantBase.SystemMetaObjOperateLog）；
 * - 失败命令审计：业务失败 / 存储不可写 / 结果未知三类（AGENTS.md §10「审计」），业务回滚后在独立事务里写入。
 * 字段级数据变更日志仍是 tenancy.ts 的 audit_events。
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auditSourceColumns, tenants, users } from './tenancy.js';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const utc = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .references(() => tenants.id);

export const auditOperationLogs = pgTable(
  'audit_operation_logs',
  {
    id: id(),
    tenantId: tenantId(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    behavior: text('behavior').notNull(),
    objectType: text('object_type').notNull(),
    // 批量 / 导入针对一类对象时为空；单个对象的下载、打印记对象编号
    objectId: text('object_id'),
    summary: text('summary').notNull(),
    totalCount: integer('total_count').notNull(),
    successCount: integer('success_count').notNull(),
    failureCount: integer('failure_count').notNull(),
    result: text('result').notNull(),
    // 错误报告（逐条失败原因）与导出附件 / 下载文件的登记信息；不存文件内容
    errorReport: jsonb('error_report'),
    attachment: jsonb('attachment'),
    commandId: text('command_id'),
    occurredAt: utc('occurred_at'),
    ...auditSourceColumns(),
    // DEC-197：可见性依据（同 audit_events，由迁移 0055 的触发器推导）
    scopeObject: text('scope_object'),
    scopeEmployeeId: uuid('scope_employee_id'),
  },
  (t) => [
    index('audit_operation_logs_tenant_occurred').on(t.tenantId, t.occurredAt),
    check(
      'audit_operation_logs_behavior_valid',
      sql`${t.behavior} IN ('batch_update', 'import', 'export', 'download', 'print', 'purge')`,
    ),
    check('audit_operation_logs_result_valid', sql`${t.result} IN ('succeeded', 'partial', 'failed')`),
    check(
      'audit_operation_logs_counts_valid',
      sql`${t.successCount} >= 0 AND ${t.failureCount} >= 0
        AND ${t.totalCount} = ${t.successCount} + ${t.failureCount}`,
    ),
  ],
);

export const auditCommandFailures = pgTable(
  'audit_command_failures',
  {
    id: id(),
    tenantId: tenantId(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    commandId: text('command_id').notNull(),
    outcome: text('outcome').notNull(),
    // 业务失败为统一错误码（AGENTS.md §10「错误」），存储不可写 / 结果未知为 SQLSTATE 或连接错误码
    errorCode: text('error_code').notNull(),
    reason: text('reason'),
    method: text('method'),
    path: text('path'),
    occurredAt: utc('occurred_at'),
    ...auditSourceColumns(),
  },
  (t) => [
    index('audit_command_failures_tenant_occurred').on(t.tenantId, t.occurredAt),
    index('audit_command_failures_tenant_command').on(t.tenantId, t.commandId),
    check(
      'audit_command_failures_outcome_valid',
      sql`${t.outcome} IN ('business_failed', 'storage_unwritable', 'unknown')`,
    ),
  ],
);

/**
 * DEC-198：数据范围「创建人」判定所需的最小元数据（对象、创建人、创建时间），由 audit_events 的新增事件触发写入，
 * 每个对象只留首个；不含任何字段值。审计保留期清理不碰这张表，审计本身因此可以严格按期整条清理。
 */
export const auditObjectCreators = pgTable(
  'audit_object_creators',
  {
    tenantId: tenantId(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    action: text('action').notNull(),
    creatorUserId: uuid('creator_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.objectId, t.action, t.objectType] })],
);

/**
 * DEC-199：平台运营命令（runPlatformCommand）的失败审计。平台层受限通道：不带 tenant_id、只授予平台角色，
 * 只有平台运营经 /api/platform/command-failures 可读，不进租户审计查询；只追加。
 */
export const platformCommandFailures = pgTable(
  'platform_command_failures',
  {
    id: id(),
    commandId: text('command_id').notNull(),
    operation: text('operation').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id),
    subjectTenantId: uuid('subject_tenant_id').references(() => tenants.id),
    outcome: text('outcome').notNull(),
    errorCode: text('error_code').notNull(),
    reason: text('reason'),
    occurredAt: utc('occurred_at'),
  },
  (t) => [
    index('platform_command_failures_occurred').on(t.occurredAt),
    check(
      'platform_command_failures_outcome_valid',
      sql`${t.outcome} IN ('business_failed', 'storage_unwritable', 'unknown')`,
    ),
  ],
);

export type AuditOperationLog = typeof auditOperationLogs.$inferSelect;
export type AuditCommandFailure = typeof auditCommandFailures.$inferSelect;
