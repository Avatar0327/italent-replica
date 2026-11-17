/**
 * F-326 S7a 夹具（合成数据）：指定人员落成自动公共变量。所有流程操作走真实 HTTP，租户数据读取一律放进 withTenant，
 * 因此在 app_owner（NOBYPASSRLS）下同样通过。读回的变量 / 审计 / 节点列都是服务端真实写出的行，不手写形状。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import type { ApproverSource } from '@italent/domain';
import { expect } from 'vitest';
import { rowsOf } from '../../apps/api/src/modules/approval/context.js';
import { APPROVAL, counter, s4World, saveNodes, type S4World } from './AC-APV-F326-S4-support.js';
import type { NodeInput, ProcessView } from './AC-APV-support.js';

export { APPROVAL, counter, s4World, saveNodes };
export type { S4World };

/** 读库函数只需要库句柄与租户，审批世界与离职交接世界（tenantId）都可适配。 */
export interface TenantDb {
  db: Db;
  tenant: { id: string };
}

/** 设计器的“已选指定人员、尚未选人”输入占位（设计 §5.5 ②）。 */
export const placeholder = { type: 'specified', value: null } as unknown as ApproverSource;
export const specified = (userId: string): ApproverSource => ({ type: 'specified', value: userId });
export const publicVar = (id: string): ApproverSource => ({ type: 'public_variable', value: id });
export const manager: ApproverSource = { type: 'object_field', value: 'direct_manager' };

export interface AutoRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  data_type: 'person' | 'persons';
  default_value: string | string[] | null;
  usage_scopes: string[];
  status: 'draft' | 'enabled' | 'disabled';
  revision: number;
  created_by: string;
  updated_by: string;
  origin: string;
  origin_process_id: string;
  origin_version_id: string;
  origin_node_key: string;
  origin_slot: 'approver' | 'empty_approver';
}

const COLUMNS = sql`id::text, code, name, description, data_type, default_value, usage_scopes, status, revision,
  created_by::text, updated_by::text, origin, origin_process_id::text, origin_version_id::text, origin_node_key,
  origin_slot`;

/** 某流程的全部自动变量，按编码（= 生成时间戳）排序。 */
/** 取第一条自动变量；没有时让断言失败，而不是在后续读属性时抛 TypeError。 */
export async function firstAuto(w: TenantDb, processId: string): Promise<AutoRow> {
  const rows = await autoRows(w, processId);
  expect(rows.length, '应已生成自动变量').toBeGreaterThan(0);
  return rows[0]!;
}

/** 取指定节点的自动变量；没有时让断言失败。 */
export async function autoAt(w: TenantDb, processId: string, nodeKey: string): Promise<AutoRow> {
  const row = (await autoRows(w, processId)).find((item) => item.origin_node_key === nodeKey);
  expect(row, `节点 ${nodeKey} 应已生成自动变量`).toBeDefined();
  return row!;
}

export async function autoRows(w: TenantDb, processId: string): Promise<AutoRow[]> {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<AutoRow>(
      await tx.execute(sql`SELECT ${COLUMNS} FROM approval_variables
        WHERE tenant_id=${w.tenant.id} AND origin='auto' AND origin_process_id=${processId}::uuid ORDER BY code`),
    ),
  );
}

export async function varRow(w: TenantDb, id: string): Promise<AutoRow> {
  const rows = await withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<AutoRow>(
      await tx.execute(sql`SELECT ${COLUMNS} FROM approval_variables
        WHERE tenant_id=${w.tenant.id} AND id=${id}::uuid`),
    ),
  );
  return rows[0]!;
}

export async function variableCount(w: TenantDb): Promise<number> {
  const rows = await withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<{ n: number }>(
      await tx.execute(sql`SELECT count(*)::int AS n FROM approval_variables WHERE tenant_id=${w.tenant.id}`),
    ),
  );
  return rows[0]!.n;
}

export interface AuditRow {
  revision: number;
  action: string;
  actor: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** 固定时钟与 ctid 都不能表示变更顺序；按同事务 outbox 的命令关联到对象 revision，不过滤缺失的事件。 */
export async function audits(w: TenantDb, objectId: string, like = 'approval.public_variable.%'): Promise<AuditRow[]> {
  const rows = await withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<Omit<AuditRow, 'revision'> & { revision: number | null }>(
      await tx.execute(sql`SELECT a.action, a.actor_user_id::text AS actor, a.before, a.after, o.revision
        FROM audit_events a LEFT JOIN approval_outbox o
          ON o.tenant_id=a.tenant_id AND o.object_id::text=a.object_id AND o.object_type=a.object_type
          AND o.command_id=a.command_id AND o.event_type=a.action
        WHERE a.tenant_id=${w.tenant.id} AND a.object_id=${objectId} AND a.action LIKE ${like}
        ORDER BY o.revision, a.id`),
    ),
  );
  for (const row of rows) expect(row.revision, `${row.action} 应有同命令、同对象的 outbox`).not.toBeNull();
  expect(new Set(rows.map((row) => row.revision)).size, '每次对象变更应恰有一条匹配的审计').toBe(rows.length);
  return rows.map((row) => ({ ...row, revision: row.revision! }));
}

/** 按目标操作产生的 revision 精确取一条；缺失或重复都失败，不能误用更早的同类动作。 */
export async function auditAtRevision(
  w: TenantDb,
  objectId: string,
  revision: number,
  like = 'approval.public_variable.%',
): Promise<AuditRow> {
  const rows = (await audits(w, objectId, like)).filter((row) => row.revision === revision);
  expect(rows, `revision=${revision} 应恰有一条审计`).toHaveLength(1);
  return rows[0]!;
}

export const actionsOf = (rows: AuditRow[]) => rows.map((row) => row.action.replace('approval.public_variable.', ''));

export interface StoredNode {
  node_key: string;
  approver_expression: unknown;
  approver_expressions: unknown;
  empty_approver_sources: unknown;
}

/** 节点三列 jsonb 的库内真实内容。 */
export async function storedNodes(w: TenantDb, versionId: string): Promise<StoredNode[]> {
  return withTenant(w.db, w.tenant.id, async (tx) =>
    rowsOf<StoredNode>(
      await tx.execute(sql`SELECT node_key, approver_expression, approver_expressions, empty_approver_sources
        FROM approval_process_nodes WHERE tenant_id=${w.tenant.id} AND version_id=${versionId}::uuid ORDER BY seq`),
    ),
  );
}

/** 库内节点三列里没有 specified、也没有 null 值（落库模型只存 public_variable）。 */
export function expectNoSpecified(nodes: StoredNode[]) {
  const text = JSON.stringify(nodes);
  expect(text).not.toContain('"specified"');
  expect(text).not.toContain('"value":null');
}

/** 流程创建（不发布）。 */
export async function create(
  w: S4World,
  nodes: NodeInput[],
  over: Record<string, unknown> = {},
  actor: string = w.hr.id,
): Promise<ProcessView> {
  return w.json<ProcessView>(
    await w.request(actor, 'POST', `${APPROVAL}/processes`, {
      ifMatch: 0,
      body: {
        code: `P_${randomUUID().replaceAll('-', '')}`.slice(0, 40),
        name: '合成指定人员流程',
        approvalType: 'transfer',
        isFallback: true,
        exceptionAdminUserId: w.exceptionAdmin,
        conditions: { items: [] },
        nodes: nodes.map((node) => ({ ...node, actions: { avoidSelf: true, ...node.actions } })),
        ...over,
      },
    }),
    201,
  );
}

/** 保存草稿：用该流程最新版本的头部字段 + 给定节点。 */
export function saveDraft(w: S4World, process: ProcessView, nodes: NodeInput[], actor: string = w.hr.id) {
  const version = process.latestVersion;
  return w.request(actor, 'PUT', `${APPROVAL}/processes/${process.id}/draft`, {
    ifMatch: process.revision,
    body: {
      name: version.name,
      priority: version.priority,
      isFallback: version.isFallback,
      exceptionAdminUserId: version.exceptionAdminUserId,
      conditions: version.conditions,
      nodes: nodes.map((node) => ({ ...node, actions: { avoidSelf: true, ...node.actions } })),
    },
  });
}

export async function readProcess(w: S4World, id: string): Promise<ProcessView> {
  return w.json<ProcessView>(await w.request(w.hr.id, 'GET', `${APPROVAL}/processes/${id}`));
}

export async function draftOk(w: S4World, process: ProcessView, nodes: NodeInput[], actor?: string) {
  return w.json<ProcessView>(await saveDraft(w, process, nodes, actor));
}

/** 编辑最新版本（POST /versions）→ 新草稿。 */
export async function newVersion(w: S4World, process: ProcessView): Promise<ProcessView> {
  const current = await readProcess(w, process.id);
  return w.json<ProcessView>(
    await w.request(w.hr.id, 'POST', `${APPROVAL}/processes/${process.id}/versions`, {
      ifMatch: current.revision,
      body: {},
    }),
    201,
  );
}

export function publishWith(w: S4World, process: ProcessView, body: Record<string, unknown> = {}) {
  return w.request(w.hr.id, 'POST', `${APPROVAL}/processes/${process.id}/publish`, {
    ifMatch: process.revision,
    body,
  });
}

/** 节点来源（视图）里本位置自动变量的回显。 */
export interface AutoView {
  id: string;
  code: string;
  status: string;
  userIds: string[] | null;
  pendingUserIds?: string[];
  revision?: number;
  pendingConflict?: true;
}
export const autoViewOf = (source: unknown): AutoView | undefined =>
  (source as { autoVariable?: AutoView }).autoVariable;

/** 变量人员默认值 → 集合（person 为单个 id，persons 为数组，空为 null）。 */
export const peopleOf = (row: Pick<AutoRow, 'default_value'>): string[] | null =>
  row.default_value === null ? null : Array.isArray(row.default_value) ? row.default_value : [row.default_value];

/** 管理员在变量页改默认值。 */
export function editVariable(w: S4World, v: { id: string; revision: number }, body: Record<string, unknown>) {
  return w.request(w.hr.id, 'PATCH', `${APPROVAL}/variables/${v.id}`, { ifMatch: v.revision, body });
}

/** 调动申请 → 实例；返回当前待办的节点 / 办理人（可换一名申请对象，同一对象不能有两张在途单）。 */
export async function dispatch(w: S4World, employeeId: string = w.subject.employeeId) {
  const business = await w.application(employeeId, { departmentId: w.staff });
  const instance = await w.submit(business);
  return { instance, tasks: w.pending(instance).map((task) => [task.nodeKey, task.assigneeUserId] as const) };
}
