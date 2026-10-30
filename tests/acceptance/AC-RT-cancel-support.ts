/**
 * R2-T04 BE-5a′ 验收夹具：撤销退休（docs/08_设计/R2-T04_退休设计.md §6）。
 * 在撤销离职夹具（cancelWorld：编制 / 撤销入口 / 占用投影）之上叠加退休办理辅助（withRetirement），
 * 再加退休撤销入口（POST retirements/:id/cancel）与人事“实际退休日期”的写入 / 读取。
 */
import { randomUUID } from 'node:crypto';
import { sql, withTenant, type Db } from '@italent/db';
import { expect } from 'vitest';
import { appendEmployee } from '../../apps/api/src/modules/personnel/employee-write.js';
import { cancelWorld, type Cancelled, type CancelBody } from './AC-EXIT-cancel-support.js';
import { dayAt } from './AC-EXIT-activation-support.js';
import { withRetirement } from './AC-RT-support.js';

export async function retirementCancelWorld(
  db: Db,
  label: string,
  today = '2026-10-06',
  options: { capacity?: boolean } = {},
) {
  const x = withRetirement(db, await cancelWorld(db, label, today, options), today);
  const tenantId = x.session.tenant.id;

  /** 专用撤销入口（If-Match 缺省取业务当前 revision）；返回原始响应。 */
  async function cancelRetire(
    id: string,
    body: CancelBody = { reason: '录入有误' },
    init: { ifMatch?: number; idempotencyKey?: string } = {},
  ) {
    return x.session.request('POST', `/retirements/${id}/cancel`, {
      ifMatch: init.ifMatch ?? (await x.business(id)).revision,
      body,
      ...(init.idempotencyKey ? { idempotencyKey: init.idempotencyKey } : {}),
    });
  }
  async function retireCancelled(id: string, body: CancelBody = { reason: '录入有误' }) {
    const response = await cancelRetire(id, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Cancelled;
  }

  /** 写入人事“实际退休日期”（走人事写端口，模拟上一次退休留下的值）。 */
  async function setActualRetirement(date: string | null, employeeId = x.employee.id) {
    await withTenant(db, tenantId, (tx) =>
      appendEmployee(
        tx,
        {
          tenantId,
          userId: x.session.user.id,
          timezone: x.session.tenant.timezone,
          now: dayAt(today),
          commandId: randomUUID(),
          expectedRevision: 0,
        } as never,
        employeeId,
        { actualRetirementDate: date },
        false,
      ),
    );
  }
  /** 人事版本数（approved 撤销 / 未办结撤销不应追加）。 */
  const personnelVersionCount = async (employeeId = x.employee.id) =>
    Number(
      (
        await x.sqlRows<{ n: string }>(sql`SELECT count(*) AS n FROM personnel_employee_versions
          WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid`)
      )[0]!.n,
    );
  return { ...x, cancelRetire, retireCancelled, setActualRetirement, personnelVersionCount };
}

export type RetirementCancelWorld = Awaited<ReturnType<typeof retirementCancelWorld>>;
