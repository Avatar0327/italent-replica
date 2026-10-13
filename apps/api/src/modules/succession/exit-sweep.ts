/** A3 / DEC-429：生产者冻结员工集合；worker 重读当前时间轴与权限，逐员工保存点执行。 */
import { randomUUID } from 'node:crypto';
import { and, eq, isUuid, sql, successionExitApplications as applications, type Tx } from '@italent/db';
import { inArray } from 'drizzle-orm';
import { decide, EMPLOYEE_STATUS, SUCCESSION_APP, tenantLocalDate } from '@italent/domain';
import { objectCatalog } from '../permission/catalog.js';
import { loadSubject } from '../permission/subject.js';
import { resolveDataScope } from '../permission/scope-resolver.js';
import { readEffectiveSetting } from '../tenant-settings/service.js';
import { lockEmploymentEmployee } from '../employment/record-store.js';
import { recheckRecordEvent } from '../employment/record-events.js';
import { applyExit, lockExitTargets } from './exit-store.js';
import { rowsOf } from './read-sql.js';
import { CalcBlocked, type CalcContext, type CalcObject, type CalcHandler, type CalcInput } from './calc-contract.js';
import type { CalcProducer } from './calc-jobs.js';
import { calcScheduleSlot } from './calc-time.js';
import { enqueueCalcRun } from './calc-worker.js';

async function principal(tx: Tx, tenantId: string, today: string) {
  const setting = await readEffectiveSetting(tx, tenantId, 'succession.system_principal_user_id');
  if (typeof setting.value !== 'string' || !isUuid(setting.value)) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const userId = setting.value.toLowerCase();
  const valid = rowsOf<{ active: boolean }>(
    await tx.execute(sql`
    SELECT succession_calc_user_active(${tenantId}::uuid,${userId}::uuid) AND EXISTS (
      SELECT 1 FROM permission_grants g JOIN permission_profiles p ON p.tenant_id=g.tenant_id AND p.id=g.profile_id
      WHERE g.tenant_id=${tenantId}::uuid AND g.user_id=${userId}::uuid AND g.status='active'
        AND p.code='standard_succession_runner' AND p.source='standard') AS active`),
  );
  const code = 'Succession.Record';
  const subject = await loadSubject(tx, userId, code, { tenantId, userId, asOf: today });
  if (
    !valid[0]?.active ||
    !decide(subject, { action: 'object.update', resource: code, fields: ['endDate', 'endReason'] }, objectCatalog) ||
    !decide(subject, { action: 'object.button', resource: `${code}#update@detail` }, objectCatalog)
  )
    throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  const scope = await resolveDataScope(tx, {
    tenantId,
    userId,
    appCode: SUCCESSION_APP,
    objectCode: code,
    asOf: today,
  });
  if (!scope.hasDataPermission) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
  return { userId, scope };
}
async function timezone(tx: Tx) {
  // 复用平台受控时区函数，不直接读取 tenants 表。
  const [row] = rowsOf<{ timezone: string }>(await tx.execute(sql`SELECT current_tenant_timezone() AS timezone`));
  return row!.timezone;
}

/** #266 P2-1：保存点成功会把锁留在整页事务；必须在处理任何员工前准备全页锁集合。 */
async function prepareExitPage({ tx, run, now }: CalcContext, objects: readonly CalcObject[]) {
  const employeeIds = [...new Set(objects.map((object) => object.objectId))].sort();
  if (!employeeIds.length) return;
  const ctx = {
    tenantId: run.tenantId,
    timezone: await timezone(tx),
    now,
    commandId: run.commandId,
    userId: run.principalUserId!,
    expectedRevision: 0,
  };
  // 冻结对象不能 SKIP LOCKED 后当作成功；全体员工锁之后用独立语句重读台账（DEC-343）。
  for (const employeeId of employeeIds) await lockEmploymentEmployee(tx, ctx, employeeId);
  const pending = await tx
    .select()
    .from(applications)
    .where(and(eq(applications.tenantId, run.tenantId), inArray(applications.employeeId, employeeIds)));
  await lockExitTargets(
    tx,
    ctx,
    pending.filter((a) => a.source !== 'delete_revert').flatMap((a) => a.candidateRecordIds),
  );
}

export const EXIT_SWEEP_PRODUCER: CalcProducer = {
  kind: 'exit_sweep',
  async runTenant(tx, tenant, now) {
    const input: CalcInput = {
      tenantId: tenant.id,
      timezone: tenant.timezone,
      now,
      businessDate: tenantLocalDate(now, tenant.timezone),
      kind: 'exit_sweep',
      trigger: 'schedule',
      requestedBy: null,
      commandId: randomUUID(),
      objects: [],
    };
    const { businessDate } = calcScheduleSlot(input);
    const employees = rowsOf<{ employee_id: string }>(
      await tx.execute(sql`
      SELECT DISTINCT a.employee_id FROM succession_exit_applications a
      JOIN employment_timeline t ON t.tenant_id=a.tenant_id AND t.record_id=a.employment_record_id
      JOIN LATERAL employment_record_status(t.tenant_id,t.record_id) s ON true
      WHERE a.tenant_id=${tenant.id}::uuid AND a.source<>'delete_revert' AND a.candidate_record_ids<>'[]'::jsonb
        AND t.start_date<=${businessDate}::date AND s.employee_status=8 ORDER BY a.employee_id`),
    );
    await enqueueCalcRun(
      tx,
      { ...input, objects: employees.map((e) => ({ objectType: 'employee', objectId: e.employee_id })) },
      now,
    );
  },
};

export const EXIT_SWEEP_HANDLER: CalcHandler = {
  kind: 'exit_sweep',
  objectType: 'employee',
  async authorizePage({ tx, run, now }) {
    const zone = await timezone(tx);
    return (await principal(tx, run.tenantId, tenantLocalDate(now, zone))).userId;
  },
  preparePage: prepareExitPage,
  async execute({ tx, run, now }, object) {
    const zone = await timezone(tx);
    const today = tenantLocalDate(now, zone);
    const ctx = {
      tenantId: run.tenantId,
      timezone: zone,
      now,
      commandId: run.commandId,
      userId: run.principalUserId!,
      expectedRevision: 0,
    };
    const pending = await tx
      .select()
      .from(applications)
      .where(and(eq(applications.tenantId, run.tenantId), eq(applications.employeeId, object.objectId)))
      .orderBy(applications.employmentRecordId);
    const active = pending.filter((a) => a.source !== 'delete_revert' && a.candidateRecordIds.length);
    const current = await principal(tx, run.tenantId, today);
    if (current.userId !== run.principalUserId) throw new CalcBlocked('PRINCIPAL_UNAVAILABLE');
    let changed = 0;
    for (const application of active) {
      const event = await recheckRecordEvent(tx, ctx, application.employmentRecordId, today);
      if (event.kind !== 'effective' || event.record.employeeStatus !== EMPLOYEE_STATUS.left) continue;
      changed += await applyExit(
        tx,
        { ...ctx, userId: current.userId },
        application,
        ['org', 'position'],
        event.record.effectiveDate,
        current.scope,
      );
    }
    return changed ? 'written' : 'unchanged';
  },
};
