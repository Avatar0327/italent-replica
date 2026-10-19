/**
 * R2-T03 B4 验收夹具：撤销离职（设计 §7.1）。在编制夹具（capacityWorld：调出 / 调入部门各严格编制 1）之上加：
 * 撤销入口（POST exits/:id/cancel、通用 DELETE / revoke 映射、PATCH exits/cancellations/:id）、撤销记录读取、
 * 离职占用投影读取，以及撤销前后的状态快照比较。
 */
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { loadExitStates } from '../../apps/api/src/modules/employment/exit-occupancy-store.js';
import { capacityWorld } from './AC-EXIT-capacity-support.js';
import { tenantApi } from './support/tenant-api.js';

export interface CancelBody {
  readonly reason?: unknown;
  readonly confirmed?: boolean;
}

export interface Cancelled {
  readonly id: string;
  readonly employeeId: string;
  readonly revision: number;
  readonly status: string;
  readonly cancellation: { id: string; case: string; stateBefore: string; reason: string; revision: number };
  readonly downstream: {
    items: { kind: string; status: string; targets: { type: string; id: string }[]; hiddenCount: number }[];
    additional: { kind: string; action: string; targets: { type: string; id: string }[]; hiddenCount: number }[];
  };
}

export async function cancelWorld(db: Db, label: string, today = '2026-10-06') {
  const x = await capacityWorld(db, label, today);
  const tenantId = x.session.tenant.id;

  /** 撤销（If-Match 缺省取业务当前 revision）；返回原始响应。 */
  async function cancel(
    id: string,
    body: CancelBody = { reason: '录入有误' },
    init: { ifMatch?: number; idempotencyKey?: string } = {},
  ) {
    return x.session.request('POST', `/exits/${id}/cancel`, {
      ifMatch: init.ifMatch ?? (await x.business(id)).revision,
      body,
      ...(init.idempotencyKey ? { idempotencyKey: init.idempotencyKey } : {}),
    });
  }
  /** 撤销成功（200）并返回回执。 */
  async function cancelled(id: string, body: CancelBody = { reason: '录入有误' }) {
    const response = await cancel(id, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Cancelled;
  }

  const cancellationOf = async (businessId: string) =>
    (
      await x.sqlRows<{
        id: string;
        stateBefore: string;
        case: string;
        reason: string;
        revision: number;
        downstream: Cancelled['downstream'];
        actor: string;
      }>(sql`SELECT id, state_before AS "stateBefore", cancel_case AS "case", reason, revision, downstream,
          actor_user_id::text AS actor
        FROM exit_cancellations WHERE tenant_id=${tenantId} AND business_id=${businessId}::uuid`)
    )[0];
  const tombstoned = async (recordId: string) =>
    (
      await x.sqlRows(sql`SELECT 1 FROM employment_record_tombstones WHERE tenant_id=${tenantId}
        AND record_id=${recordId}::uuid`)
    ).length > 0;
  /** 离职占用投影读到的 approved / effective 离职（已撤销 / 作废 / 删除的不在其中）。 */
  const exitStates = () =>
    withTenant(db, tenantId, (tx) => loadExitStates(tx, tenantId, [x.employee.id])).then((rows) =>
      rows.map((row) => [row.businessId, row.state] as const),
    );
  /** 组织自 effectiveDate 起停用（org.revision 取创建时的值，每个组织在一个用例里至多停用一次）。 */
  const orgApi = tenantApi(db, { clock: () => new Date(`${today}T01:00:00Z`) });
  const disable = (org: { id: string; revision: number }, effectiveDate: string) =>
    orgApi.request('PATCH', `/api/tenant/org/organizations/${org.id}`, {
      tenant: tenantId,
      user: x.session.user.id,
      ifMatch: org.revision,
      body: { enabled: false, effectiveDate },
    });
  /** 员工自 effectiveDate 起的直接调动（未来日期即“已落地、待执行”的未来直接调动）。 */
  async function directTransfer(department: { id: string }, effectiveDate: string, employeeId = x.employee.id) {
    const employee = await x.session.getEmployee(employeeId);
    const business = await x.session.business(
      employeeId,
      { kind: 'transfer', mode: 'direct', effectiveDate, fields: { departmentId: department.id } },
      employee.revision,
    );
    expect(business.status).toBe('effective');
    return business;
  }
  const sqlOne = async <T>(statement: ReturnType<typeof sql>) => (await x.sqlRows<T>(statement))[0];
  /** 撤销的扩展审计动作（按业务 ID）。 */
  const auditActions = async (businessId: string) =>
    (
      await x.sqlRows<{ action: string }>(sql`SELECT action FROM audit_events WHERE tenant_id=${tenantId}
        AND object_id=${businessId} ORDER BY occurred_at, id`)
    ).map((row) => row.action);

  return {
    ...x,
    db,
    cancel,
    cancelled,
    cancellationOf,
    tombstoned,
    exitStates,
    sqlOne,
    auditActions,
    disable,
    directTransfer,
  };
}

export type CancelWorld = Awaited<ReturnType<typeof cancelWorld>>;
