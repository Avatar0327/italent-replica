/**
 * R2-T03 B3-1 验收夹具：离职生效主链只经内部编排器入口（activateExit，设计 §5.1）验证；§18.1 五个关口保持关闭，
 * 公开入口（审批通过、调度、HR 重试）仍不落地，所以这里的“生效”都是直接调用编排器。
 * 复用 gateWorld（受限授权、合成申请、前后读取快照），再加：编排器调用、时间轴 / 台账读取。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { activateExit, type ExitActivationOptions } from '../../apps/api/src/modules/employment/exit-activation.js';
import { rowsOf } from '../../apps/api/src/modules/employment/record-store.js';
import type { EmploymentContext } from '../../apps/api/src/modules/employment/types.js';
import { randomUUID } from 'node:crypto';
import { gateWorld, leaveBody } from './AC-EXIT-gate-support.js';

export const dayAt = (date: string) => new Date(`${date}T02:00:00Z`);

/** 经内部编排器入口在租户日 at 落地（头版本取当前值）；抛错即整个事务回滚。 */
export function exitActivator(db: Db, session: { tenant: { id: string; timezone: string }; user: { id: string } }) {
  return (businessId: string, at: string, options: ExitActivationOptions = { trigger: 'scheduler' }) =>
    withTenant(db, session.tenant.id, async (tx) => {
      const tenantId = session.tenant.id;
      const [head] = rowsOf<{ revision: number }>(
        await tx.execute(
          sql`SELECT revision FROM employment_business_objects WHERE tenant_id=${tenantId} AND id=${businessId}::uuid`,
        ),
      );
      const ctx: EmploymentContext = {
        tenantId,
        userId: session.user.id,
        timezone: session.tenant.timezone,
        now: dayAt(at),
        commandId: randomUUID(),
        expectedRevision: Number(head!.revision),
      };
      return activateExit(tx, ctx, businessId, options);
    });
}

export async function exitActivationWorld(db: Db, label: string, today = '2026-10-06') {
  const w = await gateWorld(db, label, { today });
  const { employee } = await w.hired();
  const tenantId = w.session.tenant.id;

  const rows = <T>(statement: ReturnType<typeof sql>) => w.sqlRows<T>(statement);

  /** 直接离职（最后工作日 L，保存即 approved + confirmed 阶段预减，不落地）。 */
  async function directLeave(lastWorkDate: string, exit?: object, employeeId = employee.id) {
    return w.createdLeave(employeeId, leaveBody(lastWorkDate, 'direct', exit));
  }

  /** 申请离职：提交并在 at 审批通过（关口 ② 只停在 approved）。 */
  async function approvedLeave(lastWorkDate: string, at: string, employeeId = employee.id) {
    const draft = await w.createdLeave(
      employeeId,
      leaveBody(lastWorkDate, 'application', { exitTypeCode: 'voluntary' }),
    );
    const sent = await w.session.request('POST', `/businesses/${draft.id}/submit`, {
      ifMatch: draft.revision,
      body: {},
    });
    if (sent.status !== 200) throw new Error(`提交失败 ${await sent.text()}`);
    return w.approve(draft, `${at}T02:00:00Z`);
  }

  const activate = exitActivator(db, w.session);

  const timeline = (employeeId = employee.id) =>
    rows<{ record_id: string; kind: string; start_date: string; valid: string }>(sql`
      SELECT t.record_id, r.kind, t.start_date::text, t.valid_during::text AS valid
      FROM employment_timeline t JOIN employment_records r ON r.tenant_id=t.tenant_id AND r.id=t.record_id
      WHERE t.tenant_id=${tenantId} AND t.employee_id=${employeeId}::uuid ORDER BY t.start_date, t.sort_order`);
  const effects = (businessId: string) =>
    rows<{ phase: string; kind: string; target_id: string | null; detail: Record<string, unknown> }>(sql`
      SELECT phase, kind, target_id, detail FROM exit_effects WHERE tenant_id=${tenantId}
        AND business_id=${businessId}::uuid ORDER BY phase, kind, id`);
  const attempts = (businessId: string) =>
    rows<{
      outcome: string;
      reason: string | null;
      detail: Record<string, unknown>;
      blocked_by_business_id: string | null;
    }>(sql`
      SELECT outcome, reason, detail, blocked_by_business_id FROM employment_activation_attempts
      WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid ORDER BY attempt_no`);
  const audits = (businessId: string, action: string) =>
    rows<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(sql`
      SELECT before, after FROM audit_events WHERE tenant_id=${tenantId} AND object_id=${businessId}
        AND action=${action} ORDER BY occurred_at, id`);
  const versions = (businessId: string) =>
    rows<{ version_no: number; effective_date: string; last_work_date: string | null; planned: string }>(sql`
      SELECT version_no, effective_date::text, last_work_date::text, planned_effective_date::text AS planned
      FROM employment_payload_versions WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid
      ORDER BY version_no`);
  const stateOfBusiness = async (businessId: string) => (await w.business(businessId)).status;

  return {
    ...w,
    employee,
    directLeave,
    approvedLeave,
    activate,
    timeline,
    effects,
    attempts,
    audits,
    versions,
    stateOfBusiness,
  };
}

export type ExitActivationWorld = Awaited<ReturnType<typeof exitActivationWorld>>;
