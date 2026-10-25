/** §5.4 / DEC-343：任职已持员工锁；目标锁 → 记录行。台账与继任变更均复用上游事务。 */
import { and, eq, sql, successionExitApplications as applications, type Tx } from '@italent/db';
import { isTerminatingRecord, TERMINATING_KIND_LABELS, tenantLocalDate, SUCCESSION_OBJECTS } from '@italent/domain';
import { recordAudit } from '../../audit/record.js';
import { auditActor } from '../../system-actor.js';
import {
  scopeAllows,
  resolveModuleScopeInTransaction,
  getModuleViewableFieldsInTransaction,
  type ModuleScope,
} from '../permission/module-access.js';
import {
  registerEmployeeStatusHooks,
  type EmployeeStatusHooks,
  type EmployeeStatusHookContext,
} from '../employment/status-hooks.js';
import { listRecordRows } from './record-read.js';
import { registerDownstreamVisibility, type DownstreamItem } from '../employment/exit-downstream.js';
import { lockTargets } from './record-write.js';
import { rowsOf } from './read-sql.js';
import { CalcObjectFailure } from './calc-contract.js';

export type ExitApplication = typeof applications.$inferSelect;
type ExitContext = EmployeeStatusHookContext;
interface ExitRow {
  id: string;
  successor_employee_id: string;
  succession_type: 'org' | 'position';
  target_org_id: string | null;
  target_position_id: string | null;
  anchor_org: string | null;
  start_date: string;
  end_date: string;
  end_source: string | null;
  end_reason: string | null;
  exit_record_id: string | null;
  created_by: string;
  revision: number;
  deleted_at: unknown;
}
const key = (tenant: string, record: string) =>
  and(eq(applications.tenantId, tenant), eq(applications.employmentRecordId, record));
const idsSql = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

async function records(tx: Tx, tenant: string, ids: readonly string[], today: string, lock = false) {
  if (!ids.length) return [];
  return rowsOf<ExitRow>(
    await tx.execute(sql`
    SELECT r.*, r.start_date::text, r.end_date::text, COALESCE(r.target_org_id, p.org_id) AS anchor_org
    FROM succession_records r LEFT JOIN LATERAL (
      SELECT v.org_id FROM job_position_versions v
      WHERE v.tenant_id=r.tenant_id AND v.object_id=r.target_position_id AND v.start_date<=${today}::date
      ORDER BY v.start_date DESC,v.version_no DESC LIMIT 1
    ) p ON true WHERE r.tenant_id=${tenant}::uuid AND r.id=ANY(${idsSql(ids)})
    ORDER BY r.id ${lock ? sql`FOR UPDATE OF r` : sql``}`),
  );
}
/** 调用方先准备本事务全部员工锁，再一次性传入全部候选；复用 A2 的 kind:id 目标排序。 */
export async function lockExitTargets(tx: Tx, ctx: ExitContext, ids: readonly string[]) {
  const rows = await records(tx, ctx.tenantId, ids, tenantLocalDate(ctx.now, ctx.timezone));
  await lockTargets(
    tx,
    ctx.tenantId,
    rows.map((r) => ({ kind: r.succession_type, id: (r.target_org_id ?? r.target_position_id)! })),
  );
}

/** 冻结候选只来自离职事件当时；消费本类型，不能扩展到后来新增的记录。
 * 调用方必须已持本事务全部员工与目标锁；此处只取记录锁，避免逐台账重新扩展锁集合。 */
export async function applyExit(
  tx: Tx,
  ctx: ExitContext,
  application: ExitApplication,
  types: readonly ('org' | 'position')[],
  leaveDate = application.leaveDate,
  scope?: ModuleScope,
): Promise<number> {
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  if (application.source === 'delete_revert' || leaveDate > today) return 0;
  const selected = (await records(tx, ctx.tenantId, application.candidateRecordIds, today, true)).filter((r) =>
    types.includes(r.succession_type),
  );
  const active = selected.filter((r) => !r.deleted_at && r.end_date > today);
  if (scope && active.some((r) => !scopeAllows(scope, { orgId: r.anchor_org, creatorId: r.created_by })))
    throw new CalcObjectFailure('PRINCIPAL_SCOPE_MISSING', true);
  const ended: string[] = [];
  // 结束原因按终止业务取名（离职 / 退休）；终止判定与名称都来自 domain 的同一份登记
  const [exitRecord] = rowsOf<{ kind: string }>(
    await tx.execute(sql`SELECT kind FROM employment_records WHERE tenant_id=${ctx.tenantId}::uuid
      AND id=${application.employmentRecordId}::uuid`),
  );
  const endReason =
    TERMINATING_KIND_LABELS[exitRecord?.kind as keyof typeof TERMINATING_KIND_LABELS] ?? TERMINATING_KIND_LABELS.leave;
  for (const row of active) {
    const endDate = exitEndDate(leaveDate, row.start_date);
    const before = {
      endDate: row.end_date,
      endSource: row.end_source,
      endReason: row.end_reason,
      exitRecordId: row.exit_record_id,
      revision: row.revision,
    };
    const after = {
      endDate,
      endSource: 'exit',
      endReason,
      exitRecordId: application.employmentRecordId,
      revision: row.revision + 1,
    };
    await tx.execute(sql`UPDATE succession_records SET end_date=${endDate}::date, end_source='exit',
      end_reason=${endReason}, exit_record_id=${application.employmentRecordId}::uuid,
      ended_at=${ctx.now.toISOString()}::timestamptz, ended_by=${ctx.userId}::uuid,
      revision=revision+1, updated_at=${ctx.now.toISOString()}::timestamptz, updated_by=${ctx.userId}::uuid
      WHERE tenant_id=${ctx.tenantId}::uuid AND id=${row.id}::uuid`);
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorUserId: auditActor(ctx.userId),
      objectType: 'Succession.Record',
      objectId: row.id,
      action: 'succession.record.update',
      commandId: ctx.commandId,
      occurredAt: ctx.now,
      before,
      after,
      scope: { orgId: row.anchor_org },
    });
    ended.push(row.id);
  }
  const consumed = new Set(selected.map((r) => r.id));
  // 无业务值变化的候选也已经判定；保留原 ended_record_ids，删除离职不自动恢复。
  await tx
    .update(applications)
    .set({
      leaveDate,
      candidateRecordIds: application.candidateRecordIds.filter((id) => !consumed.has(id)),
      endedRecordIds: [...new Set([...application.endedRecordIds, ...ended])],
      source: types.includes('org') ? 'sweep' : 'record_write',
    })
    .where(key(ctx.tenantId, application.employmentRecordId));
  return ended.length;
}

/** 半开区间：使用任职生效日 E，不另算一次最后工作日；开始日晚于 E 时结束为空区间。 */
export const exitEndDate = (leaveDate: string, startDate: string) => (leaveDate < startDate ? startDate : leaveDate);

async function followRescheduledExit(tx: Tx, ctx: ExitContext, recordId: string, leaveDate: string) {
  const [application] = await tx.select().from(applications).where(key(ctx.tenantId, recordId));
  if (!application || application.source === 'delete_revert') return [];
  const today = tenantLocalDate(ctx.now, ctx.timezone);
  const ids = application.endedRecordIds;
  await lockExitTargets(tx, ctx, ids);
  const hints: DownstreamItem[] = [];
  for (const row of await records(tx, ctx.tenantId, ids, today, true)) {
    if (row.deleted_at) continue;
    const expected = exitEndDate(leaveDate, row.start_date);
    // DEC-690：目标锁覆盖普通新增 / 编辑 / 同步；查邻接行后再锁行，不用日期猜自动结束来源。
    const [next] = rowsOf<{ id: string; start: string }>(
      await tx.execute(sql`
      SELECT id, start_date::text AS start FROM succession_records
      WHERE tenant_id=${ctx.tenantId}::uuid AND succession_type=${row.succession_type}
        AND COALESCE(target_org_id,target_position_id)=${row.target_org_id ?? row.target_position_id}::uuid
        AND successor_employee_id=${row.successor_employee_id}::uuid AND id<>${row.id}::uuid
        AND deleted_at IS NULL AND start_date>=${row.start_date}::date
        AND (start_date<end_date OR id=ANY(${idsSql(ids)}))
      ORDER BY start_date,id LIMIT 1 FOR UPDATE`),
    );
    const endDate = next && next.start < expected ? next.start : expected;
    await tx.execute(sql`UPDATE succession_records SET end_date=${endDate}::date,
      revision=revision+1, updated_at=${ctx.now.toISOString()}::timestamptz, updated_by=${ctx.userId}::uuid
      WHERE tenant_id=${ctx.tenantId}::uuid AND id=${row.id}::uuid`);
    await recordAudit(tx, {
      tenantId: ctx.tenantId,
      actorUserId: auditActor(ctx.userId),
      objectType: 'Succession.Record',
      objectId: row.id,
      action: 'succession.record.update',
      commandId: ctx.commandId,
      occurredAt: ctx.now,
      before: { endDate: row.end_date, revision: row.revision },
      after: { endDate, revision: row.revision + 1, exitRecordId: recordId },
      scope: { orgId: row.anchor_org },
    });
    if (endDate !== expected)
      hints.push({
        kind: 'succession',
        status: 'found',
        hiddenCount: 0,
        targets: [
          {
            type: 'succession-record',
            id: row.id,
            detail: {
              successionType: row.succession_type,
              targetId: row.target_org_id ?? row.target_position_id,
              expectedEndDate: expected,
              actualEndDate: endDate,
              adjacentRecordId: next!.id,
              message: '未能完全跟随、已截至下一条开始前，请人工核对',
            },
          },
        ],
      });
  }
  await tx.update(applications).set({ leaveDate }).where(key(ctx.tenantId, recordId));
  return hints;
}

export const successionExitHooks: EmployeeStatusHooks = {
  async onRecordMaterialized(tx, ctx, event) {
    if (!isTerminatingRecord(event.kind, event.employeeStatus)) return;
    const [existing] = await tx.select().from(applications).where(key(ctx.tenantId, event.recordId));
    if (existing) return;
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const ids = rowsOf<{ id: string }>(
      await tx.execute(sql`SELECT id FROM succession_records
      WHERE tenant_id=${ctx.tenantId}::uuid AND successor_employee_id=${event.employeeId}::uuid
        AND deleted_at IS NULL AND end_date>${today}::date ORDER BY id`),
    ).map((r) => r.id);
    await lockExitTargets(tx, ctx, ids);
    const frozen = (await records(tx, ctx.tenantId, ids, today, true))
      .filter((r) => !r.deleted_at && r.end_date > today)
      .map((r) => r.id);
    const [application] = await tx
      .insert(applications)
      .values({
        tenantId: ctx.tenantId,
        employeeId: event.employeeId,
        employmentRecordId: event.recordId,
        leaveDate: event.effectiveDate,
        appliedAt: ctx.now,
        source: 'record_write',
        candidateRecordIds: frozen,
        commandId: ctx.commandId,
      })
      .returning();
    await applyExit(tx, ctx, application!, ['position']);
  },
  async onRecordDeleted(tx, ctx, event) {
    await tx
      .update(applications)
      .set({ source: 'delete_revert', candidateRecordIds: [] })
      .where(key(ctx.tenantId, event.recordId));
  },
  async onRecordRescheduled(tx, ctx, { before, after }) {
    if (before.kind !== 'leave' || after.recordId !== before.recordId) return;
    return followRescheduledExit(tx, ctx, before.recordId, after.effectiveDate);
  },
};
export function installSuccessionExitHooks() {
  registerEmployeeStatusHooks('succession', successionExitHooks);
  registerDownstreamVisibility('succession-record', async (tx, ctx, target) => {
    if (!ctx.authorize) return true;
    const code = SUCCESSION_OBJECTS.record.code;
    if (!(await ctx.authorize({ ...ctx, action: 'object.view', resource: code }))) return false;
    const deps = { authorize: ctx.authorize, clock: () => ctx.now };
    const fields = await getModuleViewableFieldsInTransaction(deps, ctx, code, tx);
    if (fields && ['startDate', 'endDate', 'targetOrgId', 'targetPositionId'].some((field) => !fields.has(field)))
      return false;
    const scope = await resolveModuleScopeInTransaction(deps, ctx, tx, code);
    const today = tenantLocalDate(ctx.now, ctx.timezone);
    const ids = [target.id, String(target.detail?.adjacentRecordId)];
    const visible = await listRecordRows(
      tx,
      { ...ctx, today, asOf: today, scope },
      { status: 'all', ids },
      { limit: 2, offset: 0 },
    );
    return visible.rows.length === 2;
  });
}
