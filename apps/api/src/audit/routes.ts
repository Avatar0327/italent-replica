/**
 * 审计日志查询接口（R1-T16；docs/02_业务建模/20；REQ-AUD-001）。只读，挂在企业设置「日志审计/业务操作日志」下：
 *   GET /api/tenant/audit/data-changes        数据变更日志（字段级）；筛选：对象、数据 ID、操作类型、操作人、字段、来源动作
 *   GET /api/tenant/audit/data-changes/:id    单条详情：前后值；删除时带被删记录的完整快照
 *   GET /api/tenant/audit/operation-logs      对象操作日志（批量编辑 / 导入 / 导出 / 下载 / 日志清理）
 *   GET /api/tenant/audit/command-failures    失败命令审计（业务失败 / 存储不可写 / 结果未知）
 * 入口按 8 类管理员矩阵：只有租户管理员、审计管理员（能力 audit_log，06 §7.1；AC-AUD-06），每次请求重验。
 * 入口之内按 DEC-197 裁剪（visibility.ts）：每条日志按查看人当前的数据范围与字段权限决定是否返回、返回哪些字段，
 * 在分页之前完成；配置类对象（DEC-203）持日志审计即可见。失败命令审计不含业务字段值，路径里的对象编号打码。
 * 时间条件为租户时区的业务日期，受租户保留期约束（一次最多查 queryMonths 个月，最远 retainMonths 个月）。
 */
import { auditCommandFailures, auditEvents, auditOperationLogs, and, desc, eq, sql, withTenant } from '@italent/db';
import {
  AUDIT_BEHAVIOR_LABELS,
  AUDIT_BEHAVIORS,
  AUDIT_OPERATION_LABELS,
  AUDIT_OPERATIONS,
  type AuditBehavior,
  auditContent,
  type AuditFieldChange,
  auditObjectMeta,
  type AuditOperation,
  auditOperationOf,
  auditTaskSummary,
  COMMAND_FAILURE_LABELS,
  COMMAND_FAILURE_OUTCOMES,
  type CommandFailureOutcome,
  diffAuditFields,
  renderAuditChanges,
} from '@italent/domain';
import { getTableColumns, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { requirePermission } from '../authorization.js';
import { AppError } from '../errors.js';
import type { TenantRouteDeps } from '../routes.js';
import { type TenantContext, type TenantEnv, tenantOf } from '../tenant-context.js';
import {
  afterCursor,
  type AuditWindowBounds,
  cursorOf,
  notBefore,
  occurredWithin,
  operatorNames,
  optionalQuery,
  optionalUuid,
  pageLimit,
  paginate,
  queryWindow,
  tenantRetention,
} from './query.js';
import { auditViewer, visibleChanges, visibleErrorReport, visibleValue } from './visibility.js';

const BASE = '/api/tenant/audit';
const CODE = /^[A-Za-z0-9_.:#-]{1,200}$/;
const FIELD = /^[A-Za-z0-9_.:-]{1,100}$/;

type AuditEventRow = typeof auditEvents.$inferSelect;

export function registerAuditRoutes(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  registerDataChanges(router, deps);
  registerTaskLogs(router, deps);
}

function registerDataChanges(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/data-changes`, async (c) => {
    const ctx = await auditContext(c, deps);
    const filters = dataChangeFilters(c);
    const viewer = await auditViewer(deps, ctx, c.req.query('field') || undefined);
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const window = queryWindow(c, deps.clock(), ctx.timezone, await tenantRetention(tx, ctx.tenantId));
        const limit = pageLimit(c);
        const rows = await tx
          .select()
          .from(auditEvents)
          .where(and(...filters, viewer.dataChanges, ...pageConditions(c, auditEvents, window, ctx)))
          .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
          .limit(limit + 1);
        const page = paginate(rows, limit);
        const operator = await operatorNames(tx, page.items);
        return {
          items: page.items.map((row) =>
            dataChangeView(row, operator(row), viewer.fieldsOf(row.objectType, row.action)),
          ),
          nextCursor: page.nextCursor,
          window,
        };
      }),
    );
  });

  router.get(`${BASE}/data-changes/:id`, async (c) => {
    const ctx = await auditContext(c, deps);
    const id = c.req.param('id');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('VALIDATION_FAILED', '日志编号必须是 UUID');
    const viewer = await auditViewer(deps, ctx);
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const earliest = queryWindow(c, deps.clock(), ctx.timezone, await tenantRetention(tx, ctx.tenantId)).earliest;
        const [row] = await tx
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.id, id),
              viewer.dataChanges,
              notBefore(sql`${auditEvents.occurredAt}`, earliest, ctx.timezone),
            ),
          );
        // 超出保留期、范围外或只涉及隐藏字段的日志与不存在同样处理（原站“最远只能查 6 个月内”；DEC-197）
        if (!row) throw new AppError('NOT_FOUND', '日志不存在或已超出保留期');
        const fields = viewer.fieldsOf(row.objectType, row.action);
        const view = dataChangeView(row, (await operatorNames(tx, [row]))(row), fields);
        return {
          ...view,
          before: visibleValue(row.before, fields),
          after: visibleValue(row.after, fields),
          snapshot: view.operation === 'delete' ? visibleValue(row.before, fields) : null,
        };
      }),
    );
  });
}

function registerTaskLogs(router: Hono<TenantEnv>, deps: TenantRouteDeps): void {
  router.get(`${BASE}/operation-logs`, async (c) => {
    const ctx = await auditContext(c, deps);
    const filters = operationFilters(c);
    const viewer = await auditViewer(deps, ctx);
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const window = queryWindow(c, deps.clock(), ctx.timezone, await tenantRetention(tx, ctx.tenantId));
        const limit = pageLimit(c);
        const t = auditOperationLogs;
        const rows = await tx
          .select({ ...getTableColumns(t), visibleRows: sql<number[] | null>`${viewer.visibleRows}` })
          .from(t)
          .where(and(...filters, viewer.operationLogs, ...pageConditions(c, t, window, ctx)))
          .orderBy(desc(t.occurredAt), desc(t.id))
          .limit(limit + 1);
        const page = paginate(rows, limit);
        const operator = await operatorNames(tx, page.items);
        return {
          items: page.items.map((row) => operationView(row, operator(row), viewer.fieldsOf(row.objectType))),
          nextCursor: page.nextCursor,
          window,
        };
      }),
    );
  });

  router.get(`${BASE}/command-failures`, async (c) => {
    const ctx = await auditContext(c, deps);
    const filters = failureFilters(c);
    return c.json(
      await withTenant(deps.db, ctx.tenantId, async (tx) => {
        const window = queryWindow(c, deps.clock(), ctx.timezone, await tenantRetention(tx, ctx.tenantId));
        const limit = pageLimit(c);
        const t = auditCommandFailures;
        const rows = await tx
          .select()
          .from(t)
          .where(and(...filters, ...pageConditions(c, t, window, ctx)))
          .orderBy(desc(t.occurredAt), desc(t.id))
          .limit(limit + 1);
        const page = paginate(rows, limit);
        const operator = await operatorNames(tx, page.items);
        return { items: page.items.map((row) => failureView(row, operator(row))), nextCursor: page.nextCursor, window };
      }),
    );
  });
}

async function auditContext(c: Context<TenantEnv>, deps: TenantRouteDeps): Promise<TenantContext> {
  const ctx = tenantOf(c);
  await requirePermission(deps.authorize, { tenantId: ctx.tenantId, userId: ctx.userId, action: 'admin.audit_log' });
  return ctx;
}

function pageConditions(c: Context, table: AuditTable, window: AuditWindowBounds, ctx: TenantContext): SQL[] {
  const occurredAt = sql`${table.occurredAt}`;
  const cursor = afterCursor(sql`${table}`, occurredAt, sql`${table.id}`, cursorOf(c));
  return [occurredWithin(occurredAt, window, ctx.timezone), cursor];
}

type AuditTable = typeof auditEvents | typeof auditOperationLogs | typeof auditCommandFailures;

function dataChangeFilters(c: Context): SQL[] {
  const t = auditEvents;
  const conditions: SQL[] = [];
  const objectType = optionalQuery(c, 'objectType', CODE);
  const objectId = optionalQuery(c, 'objectId', CODE);
  const action = optionalQuery(c, 'action', CODE);
  const operation = optionalQuery(c, 'operation', new RegExp(`^(${AUDIT_OPERATIONS.join('|')})$`));
  const actor = optionalUuid(c, 'actorUserId');
  const field = optionalQuery(c, 'field', FIELD);
  const sourceAction = c.req.query('sourceAction');
  const commandId = optionalQuery(c, 'commandId', CODE);
  if (objectType) conditions.push(sql`${t.objectType} = ${objectType}`);
  if (objectId) conditions.push(sql`${t.objectId} = ${normalizeObjectId(objectId)}`);
  if (action) conditions.push(sql`${t.action} = ${action}`);
  if (actor) conditions.push(sql`${t.actorUserId} = ${actor}::uuid`);
  if (commandId) conditions.push(sql`${t.commandId} = ${commandId}`);
  if (sourceAction) conditions.push(sql`${t.sourceAction} = ${sourceAction.slice(0, 100)}`);
  // 升级前的历史行已在迁移 0055 回填 operation / changes（P2-3），筛选与展示口径一致
  if (operation) conditions.push(sql`${t.operation} = ${operation}`);
  // 字段可以是展开后的 a.b 形式，按末段匹配
  if (field) {
    conditions.push(sql`EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(${t.changes}, '[]'::jsonb)) change
      WHERE change->>'field' = ${field} OR right(change->>'field', ${field.length + 1}) = ${`.${field}`})`);
  }
  return conditions;
}

function operationFilters(c: Context): SQL[] {
  const t = auditOperationLogs;
  const conditions: SQL[] = [];
  const behavior = optionalQuery(c, 'behavior', new RegExp(`^(${AUDIT_BEHAVIORS.join('|')})$`));
  const objectType = optionalQuery(c, 'objectType', CODE);
  const objectId = optionalQuery(c, 'objectId', CODE);
  const actor = optionalUuid(c, 'actorUserId');
  const commandId = optionalQuery(c, 'commandId', CODE);
  if (behavior) conditions.push(sql`${t.behavior} = ${behavior}`);
  if (objectType) conditions.push(sql`${t.objectType} = ${objectType}`);
  if (objectId) conditions.push(sql`${t.objectId} = ${normalizeObjectId(objectId)}`);
  if (actor) conditions.push(sql`${t.actorUserId} = ${actor}::uuid`);
  if (commandId) conditions.push(sql`${t.commandId} = ${commandId}`);
  return conditions;
}

/** UUID 对象编号写入时统一小写（迁移 0055 触发器），查询端同样规范化；非 UUID 的复合编号原样比较（P2-4）。 */
function normalizeObjectId(value: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value.toLowerCase() : value;
}

function failureFilters(c: Context): SQL[] {
  const t = auditCommandFailures;
  const conditions: SQL[] = [];
  const outcome = optionalQuery(c, 'outcome', new RegExp(`^(${COMMAND_FAILURE_OUTCOMES.join('|')})$`));
  const actor = optionalUuid(c, 'actorUserId');
  const commandId = optionalQuery(c, 'commandId', CODE);
  if (outcome) conditions.push(sql`${t.outcome} = ${outcome}`);
  if (actor) conditions.push(sql`${t.actorUserId} = ${actor}::uuid`);
  if (commandId) conditions.push(sql`${t.commandId} = ${commandId}`);
  return conditions;
}

function sourceView(row: {
  sourceAction: string | null;
  sourcePage: string | null;
  sourcePageType: string | null;
  terminal: string | null;
  clientVersion: string | null;
  ip: string | null;
  traceId: string | null;
}) {
  return {
    sourceAction: row.sourceAction,
    sourcePage: row.sourcePage,
    sourcePageType: row.sourcePageType,
    terminal: row.terminal,
    clientVersion: row.clientVersion,
    ip: row.ip,
    traceId: row.traceId,
  };
}

function dataChangeView(
  row: AuditEventRow,
  operator: { userId: string | null; name: string },
  fields: ReadonlySet<string> | undefined,
) {
  const operation = (row.operation ?? auditOperationOf(row.action, row.before, row.after)) as AuditOperation;
  const stored = (row.changes as AuditFieldChange[] | null) ?? diffAuditFields(row.before, row.after);
  const changes = renderAuditChanges(visibleChanges(stored, fields));
  const meta = auditObjectMeta(row.objectType);
  return {
    id: row.id,
    occurredAt: new Date(row.occurredAt).toISOString(),
    operator,
    operation,
    operationLabel: AUDIT_OPERATION_LABELS[operation],
    app: meta.app,
    objectType: row.objectType,
    objectLabel: meta.label,
    objectId: row.objectId,
    action: row.action,
    content: auditContent(changes),
    changes,
    ...sourceView(row),
    commandId: row.commandId,
  };
}

function operationView(
  row: typeof auditOperationLogs.$inferSelect & { visibleRows: number[] | null },
  operator: { userId: string | null; name: string },
  fields: ReadonlySet<string> | undefined,
) {
  const task = visibleTask(row);
  return {
    id: row.id,
    occurredAt: new Date(row.occurredAt).toISOString(),
    operator,
    behavior: row.behavior,
    behaviorLabel: AUDIT_BEHAVIOR_LABELS[row.behavior as AuditBehavior],
    objectType: row.objectType,
    objectLabel: auditObjectMeta(row.objectType).label,
    objectId: row.objectId,
    ...task.counts,
    errorReport: visibleErrorReport(row.errorReport, fields, task.rows),
    attachment: row.attachment,
    ...sourceView(row),
    commandId: row.commandId,
  };
}

/**
 * 逐行归属的任务（PR #75 第三轮 P1-2）：只按查看人可见的行汇总——条数、结果与文案都不暴露范围外的行；
 * 全部可见时保留原汇总（含原文案）。
 */
function visibleTask(row: typeof auditOperationLogs.$inferSelect & { visibleRows: number[] | null }) {
  const original = {
    summary: row.summary,
    totalCount: row.totalCount,
    successCount: row.successCount,
    failureCount: row.failureCount,
    result: row.result,
  };
  const items = Array.isArray(row.items) ? (row.items as { rowIndex: number; outcome: string }[]) : [];
  if (!items.length || row.visibleRows === null) return { counts: original, rows: undefined };
  const rows = new Set(row.visibleRows);
  if (rows.size >= items.length) return { counts: original, rows: undefined };
  const visible = items.filter((item) => rows.has(item.rowIndex));
  const counts = {
    success: visible.filter((item) => item.outcome === 'succeeded').length,
    failure: visible.filter((item) => item.outcome !== 'succeeded').length,
  };
  const summary = auditTaskSummary(row.behavior as AuditBehavior, counts);
  return {
    counts: {
      summary: summary.summary,
      totalCount: counts.success + counts.failure,
      successCount: counts.success,
      failureCount: counts.failure,
      result: summary.result,
    },
    rows,
  };
}

function failureView(row: typeof auditCommandFailures.$inferSelect, operator: { userId: string | null; name: string }) {
  return {
    id: row.id,
    occurredAt: new Date(row.occurredAt).toISOString(),
    operator,
    outcome: row.outcome,
    outcomeLabel: COMMAND_FAILURE_LABELS[row.outcome as CommandFailureOutcome],
    errorCode: row.errorCode,
    reason: row.reason,
    method: row.method,
    // 路径里的对象编号打码：失败命令审计不按数据范围筛选，不能借此探测范围外对象的编号（DEC-197）
    path: row.path?.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id') ?? null,
    commandId: row.commandId,
    ...sourceView(row),
  };
}
