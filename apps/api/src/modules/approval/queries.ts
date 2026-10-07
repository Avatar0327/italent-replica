/** “我的”列表：待办、通知、我发起 / 参与的实例，按接收人过滤；管理员留痕日志按数据范围过滤。均为有界分页。 */
import { sql, type Tx } from '@italent/db';
import type { SQL } from 'drizzle-orm';
import { rowsOf } from './context.js';

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

export async function listTodos(tx: Tx, tenantId: string, userId: string, page: Page) {
  const rows = rowsOf(
    await tx.execute(sql`SELECT t.id AS task_id,t.instance_id,t.node_key,t.is_exception_admin,t.origin,t.created_at,
        i.title,i.approval_type,n.name AS node_name
      FROM approval_tasks t
      JOIN approval_instances i ON i.tenant_id=t.tenant_id AND i.id=t.instance_id
      JOIN approval_process_nodes n ON n.tenant_id=i.tenant_id AND n.version_id=i.version_id AND n.node_key=t.node_key
      WHERE t.tenant_id=${tenantId} AND t.assignee_user_id=${userId}::uuid AND t.status='pending'
      ORDER BY t.created_at DESC,t.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return rows.map((row) => ({
    taskId: String(row.task_id),
    instanceId: String(row.instance_id),
    title: String(row.title),
    approvalType: String(row.approval_type),
    nodeKey: String(row.node_key),
    // `14` §8.7：异常管理员的待办醒目标注。
    nodeName: row.is_exception_admin ? `${String(row.node_name)}（异常管理员）` : String(row.node_name),
    isExceptionAdmin: Boolean(row.is_exception_admin),
    origin: String(row.origin),
    createdAt: iso(row.created_at),
  }));
}

export async function listNotifications(tx: Tx, tenantId: string, userId: string, page: Page) {
  const rows = rowsOf(
    await tx.execute(sql`SELECT * FROM approval_notifications
      WHERE tenant_id=${tenantId} AND recipient_user_id=${userId}::uuid
      ORDER BY created_at DESC,id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return rows.map((row) => ({
    id: String(row.id),
    instanceId: String(row.instance_id),
    taskId: (row.task_id as string | null) ?? null,
    kind: String(row.kind),
    channel: String(row.channel),
    template: (row.template_code as string | null) ?? null,
    status: String(row.status),
    createdAt: iso(row.created_at),
  }));
}

export async function listInstances(
  tx: Tx,
  tenantId: string,
  userId: string,
  filter: { role: 'initiated' | 'participated'; businessId?: string },
  page: Page,
) {
  const mine =
    filter.role === 'initiated'
      ? sql`i.initiator_user_id=${userId}::uuid`
      : sql`(EXISTS (SELECT 1 FROM approval_tasks t WHERE t.tenant_id=i.tenant_id AND t.instance_id=i.id
          AND t.assignee_user_id=${userId}::uuid AND t.origin<>'self_skip')
        OR EXISTS (SELECT 1 FROM approval_instance_ccs c WHERE c.tenant_id=i.tenant_id AND c.instance_id=i.id
          AND c.user_id=${userId}::uuid))`;
  const rows = rowsOf(
    await tx.execute(sql`SELECT i.* FROM approval_instances i WHERE i.tenant_id=${tenantId} AND ${mine}
      ${filter.businessId ? sql`AND i.business_id=${filter.businessId}::uuid` : sql``}
      ORDER BY i.created_at DESC,i.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    status: String(row.status),
    approvalType: String(row.approval_type),
    businessId: String(row.business_id),
    currentNodeKey: (row.current_node_key as string | null) ?? null,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
  }));
}

/** DEC-242：本人处理事件即收录；与经理已处理同口径，不用当前业务范围过滤本人历史。 */
export async function listProcessedInstances(
  tx: Tx,
  tenantId: string,
  userId: string,
  businessId: string | undefined,
  page: Page,
) {
  const rows = rowsOf(
    await tx.execute(sql`SELECT i.id,i.title,i.status,i.approval_type,i.business_id,
      i.current_node_key,i.revision,i.created_at
    FROM approval_instances i WHERE i.tenant_id=${tenantId}
      AND EXISTS (SELECT 1 FROM approval_instance_logs l
        WHERE l.tenant_id=i.tenant_id AND l.instance_id=i.id AND l.actor_user_id=${userId}::uuid
          AND l.event IN ('approve','reject','disagree','transfer'))
      ${businessId ? sql`AND i.business_id=${businessId}::uuid` : sql``}
    ORDER BY i.created_at DESC,i.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    status: String(row.status),
    approvalType: String(row.approval_type),
    businessId: String(row.business_id),
    currentNodeKey: (row.current_node_key as string | null) ?? null,
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
  }));
}

/** DEC-070：按“管理员转交自审”筛选实例日志；只看管理员数据范围内员工的实例。 */
export async function listAdminLogs(
  tx: Tx,
  tenantId: string,
  scope: SQL,
  filter: { adminSelfTransfer?: boolean },
  page: Page,
) {
  const rows = rowsOf(
    await tx.execute(sql`SELECT l.* FROM approval_instance_logs l
      JOIN approval_instances i ON i.tenant_id=l.tenant_id AND i.id=l.instance_id
      WHERE l.tenant_id=${tenantId} AND ${scope}
        AND l.event IN ('admin_transfer','admin_intervene','approve','disagree','reject')
        ${filter.adminSelfTransfer === undefined ? sql`` : sql`AND l.admin_self_transfer=${filter.adminSelfTransfer}`}
      ORDER BY l.created_at DESC,l.id LIMIT ${page.limit} OFFSET ${page.offset}`),
  );
  return rows.map((row) => ({
    instanceId: String(row.instance_id),
    event: String(row.event),
    nodeKey: (row.node_key as string | null) ?? null,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    adminSelfTransfer: Boolean(row.admin_self_transfer),
    detail: row.detail as Record<string, unknown>,
    createdAt: iso(row.created_at),
  }));
}
