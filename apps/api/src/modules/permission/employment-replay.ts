/** DEC-080：统一命令台账返回后重验，涵盖首次成功、直接重放和失败回查重放。 */
import { MODULE_OBJECTS } from '@italent/domain';
import { authorizeEstablishmentReplay } from './establishment-replay.js';
import { sql, type Tx } from '@italent/db';
import type { Authorizer } from '../../authorization.js';
import { AppError } from '../../errors.js';
import type { EmploymentContext } from '../employment/types.js';
import { isEmploymentRecordVisible } from '../employment/visibility.js';
import { authorizeInTransaction, scopeAllowsInTransaction, resolveModuleScopeInTransaction } from './module-access.js';
import { requireObjectWrite } from './object-write.js';

const OBJECT = 'TenantBase.EmploymentRecord';
// 每批最多 100 条源、每源最多 1000 个 forward 目标，并留出状态/生效审计的空间。
const MAX_EVENTS = 202_000;
type Json = Record<string, unknown>;
interface Footprint {
  id: string;
  action: string;
  after: Json | null;
  snapshotDepartment: string | null;
  hasSnapshot: boolean;
}
interface Target {
  id: string;
  employeeId: string;
  departmentId: string | null;
  creatorId: string | null;
}
interface Snapshot {
  id: string;
  employeeId: string;
  departmentId: string | null;
}
const rows = <T>(result: unknown) => (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];

export async function authorizeEmploymentResult(
  tx: Tx,
  ctx: EmploymentContext,
  authorize: Authorizer,
  commandId: string,
  body: unknown,
): Promise<void> {
  if (ctx.objectCode !== OBJECT) return;
  const capacityScope = await resolveModuleScopeInTransaction(
    { authorize, clock: () => ctx.now },
    ctx,
    tx,
    MODULE_OBJECTS.establishment.code,
  );
  await authorizeEstablishmentReplay(tx, { authorize }, ctx, capacityScope, commandId, false);
  const events = await footprints(tx, ctx.tenantId, commandId);
  const snapshots = responseSnapshots(body);
  const ids = [...new Set([...events.map((event) => event.id), ...snapshots.map((snapshot) => snapshot.id)])];
  if (!ids.length) return;
  const transferId = await transferException(tx, ctx, commandId);
  const targets = await currentTargets(tx, ctx.tenantId, ids);
  const byId = new Map(targets.map((target) => [target.id, target]));
  const linked = linkedOnly(events, snapshots);
  for (const id of ids) {
    const target = byId.get(id);
    if (!target) throw new AppError('NOT_FOUND', '任职数据不存在');
    await assertScope(tx, ctx, target, target.departmentId, transferId, linked.has(id));
  }
  for (const event of events) {
    const target = byId.get(event.id)!;
    const isLinked = linked.has(event.id);
    if (event.after && Object.hasOwn(event.after, 'departmentId'))
      await assertScope(tx, ctx, target, event.after.departmentId as string | null, transferId, isLinked);
    if (event.hasSnapshot) await assertScope(tx, ctx, target, event.snapshotDepartment, transferId, isLinked);
  }
  for (const snapshot of snapshots) {
    const target = byId.get(snapshot.id)!;
    if (target.employeeId !== snapshot.employeeId) throw new AppError('NOT_FOUND', '任职数据不存在');
    await assertScope(tx, ctx, target, snapshot.departmentId, transferId);
  }
  const fields = [
    ...new Set(
      events
        .filter((event) => event.action === 'employment.forward-update')
        .flatMap((event) => Object.keys(event.after ?? {})),
    ),
  ];
  if (fields.length)
    await requireObjectWrite(authorizeInTransaction(authorize, tx), ctx, {
      objectCode: OBJECT,
      operation: 'update',
      payload: Object.fromEntries(fields.map((field) => [field, null])),
    });
}

/** 联动改写事件：向后更新、负责人标志补写，以及删除中间任职时恢复前一条的有效区间（R1-T11）。 */
const LINKED_ACTIONS = new Set(['employment.forward-update', 'employment.record.restore']);

/**
 * 本命令只经联动改写的记录：DEC-178 按 DEC-177 可见口径复查；
 * 命令直接写入或在响应中返回的记录仍按写入口径（记录部门与员工当前任职同时在范围内）。
 */
function linkedOnly(events: Footprint[], snapshots: Snapshot[]): Set<string> {
  const direct = new Set([
    ...events.filter((event) => !LINKED_ACTIONS.has(event.action) && event.action !== 'snapshot').map((e) => e.id),
    ...snapshots.map((snapshot) => snapshot.id),
  ]);
  return new Set(events.filter((event) => LINKED_ACTIONS.has(event.action) && !direct.has(event.id)).map((e) => e.id));
}

async function assertScope(
  tx: Tx,
  ctx: EmploymentContext,
  target: Target,
  departmentId: string | null,
  transferId: string | undefined,
  linked = false,
) {
  if (
    transferId === target.id &&
    ctx.transferTarget?.employeeId === target.employeeId &&
    ctx.transferTarget.departmentId === departmentId
  )
    return;
  if (!ctx.scope) return;
  const subject = { employeeId: target.employeeId, departmentId, creatorId: target.creatorId };
  const allowed = linked
    ? await isEmploymentRecordVisible(tx, ctx.tenantId, ctx.scope, subject)
    : await scopeAllowsInTransaction(tx, ctx.scope, {
        personId: target.employeeId,
        orgId: departmentId,
        creatorId: target.creatorId,
      });
  if (!allowed) throw new AppError('NOT_FOUND', '任职数据不存在');
}

async function transferException(tx: Tx, ctx: EmploymentContext, commandId: string): Promise<string | undefined> {
  if (!ctx.transferTarget) return undefined;
  if (ctx.transferTarget.businessId) return ctx.transferTarget.businessId;
  // 新建例外只能绑定本命令新建且有可信调动元数据的业务，不能覆盖本命令联动的后续记录。
  const [created] = rows<{ id: string }>(
    await tx.execute(sql`
    SELECT r.business_id AS id FROM transfer_requests r JOIN audit_events a
      ON a.tenant_id=r.tenant_id AND a.object_id=r.business_id::text
    WHERE r.tenant_id=${ctx.tenantId} AND r.employee_id=${ctx.transferTarget.employeeId}::uuid
      AND a.command_id=${commandId} AND a.action='employment.business.create' LIMIT 1
  `),
  );
  return created?.id;
}

async function footprints(tx: Tx, tenantId: string, commandId: string) {
  const result = rows<Footprint>(
    await tx.execute(sql`
    SELECT a.object_id AS id,a.action,a.after,NULL::uuid AS "snapshotDepartment",false AS "hasSnapshot"
    FROM audit_events a
    WHERE a.tenant_id=${tenantId} AND a.command_id=${commandId}
      AND a.object_type IN ('employment-record','employment-business')
    UNION ALL
    SELECT o.object_id::text AS id,'snapshot' AS action,NULL::jsonb AS after,p.department_id,true
    FROM employment_outbox o JOIN employment_payload_versions p
      ON p.tenant_id=o.tenant_id AND p.id=o.payload_version_id
    WHERE o.tenant_id=${tenantId} AND o.command_id=${commandId}
      AND o.object_type IN ('employment-record','employment-business')
    LIMIT ${MAX_EVENTS + 1}
  `),
  );
  if (result.length > MAX_EVENTS) throw new AppError('PAYLOAD_TOO_LARGE', '任职命令审计超过单次校验上限');
  return result;
}

async function currentTargets(tx: Tx, tenantId: string, ids: string[]) {
  // 删除是不可变状态事件；对象和 payload 仍保留，因此合法删除响应也能通过范围复查。
  return rows<Target>(
    await tx.execute(sql`
    SELECT b.id,b.employee_id AS "employeeId",
      CASE WHEN p.is_record_snapshot OR r.id IS NULL THEN p.department_id ELSE r.department_id END AS "departmentId",
      (SELECT a.actor_user_id FROM audit_events a WHERE a.tenant_id=b.tenant_id AND a.object_id=b.id::text
        AND a.action='employment.business.create' ORDER BY a.occurred_at,a.id LIMIT 1) AS "creatorId"
    FROM employment_business_objects b
    JOIN LATERAL (SELECT department_id,is_record_snapshot FROM employment_payload_versions p
      WHERE p.tenant_id=b.tenant_id AND p.business_id=b.id ORDER BY version_no DESC LIMIT 1) p ON true
    LEFT JOIN employment_records r ON r.tenant_id=b.tenant_id AND r.id=b.id
    WHERE b.tenant_id=${tenantId} AND b.id::text IN
      (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))
  `),
  );
}

function responseSnapshots(value: unknown): Snapshot[] {
  if (Array.isArray(value)) return value.flatMap(responseSnapshots);
  if (!value || typeof value !== 'object') return [];
  const record = value as Json;
  const fields = record.fields as Json | undefined;
  const own =
    typeof record.id === 'string' &&
    typeof record.employeeId === 'string' &&
    fields &&
    Object.hasOwn(fields, 'departmentId')
      ? [{ id: record.id, employeeId: record.employeeId, departmentId: fields.departmentId as string | null }]
      : [];
  // before 按响应裁剪器独立隐藏；它不是本命令实际变更的目标。
  return [...own, ...responseSnapshots(record.items), ...responseSnapshots(record.record)];
}
