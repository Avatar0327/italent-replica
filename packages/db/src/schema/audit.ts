/**
 * 审计日志（R1-T16；DEC-019；docs/02_业务建模/20；REQ-AUD-001）的另外两类记录，均为租户级（RLS）、只追加：
 * - 对象操作日志：批量编辑 / 导入 / 导出 / 下载 / 打印等任务级日志（原站 TenantBase.SystemMetaObjOperateLog）；
 * - 失败命令审计：业务失败 / 存储不可写 / 结果未知三类（AGENTS.md §10「审计」），业务回滚后在独立事务里写入。
 * 字段级数据变更日志仍是 tenancy.ts 的 audit_events。
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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

export type AuditOperationLog = typeof auditOperationLogs.$inferSelect;
export type AuditCommandFailure = typeof auditCommandFailures.$inferSelect;
