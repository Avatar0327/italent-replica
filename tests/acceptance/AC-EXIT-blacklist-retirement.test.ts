/**
 * R2 BE-8b1 × BE-5a：自动加黑规则是“离职”自动加黑（DM-R3），只对离职生效，退休不自动加黑。
 * F-351（DEC-716）：退休的手动加黑勾选已下线（原 BE-8b1 接线的两条用例随之删除；
 * 退休带加黑字段一律 400，见 AC-RT-F351-blacklist）。
 */
import './support/exit-gate-enforced.js';
import { sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retireBody, retirementWorld } from './AC-RT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
const DUE = '2026-10-05';

async function world(label: string) {
  const x = await retirementWorld(database().db, `bl-rt-${label}`, TODAY);
  const tenantId = x.session.tenant.id;
  const rowsOf = (employeeId: string) =>
    x.sqlRows<{
      source: string;
      reason: string;
      blacklistDate: string;
      exitRequestId: string | null;
      status: string;
    }>(sql`
      SELECT source, reason, blacklist_date::text AS "blacklistDate", exit_request_id::text AS "exitRequestId", status
      FROM employment_blacklist WHERE tenant_id=${tenantId} AND employee_id=${employeeId}::uuid ORDER BY created_at`);
  async function autoOn() {
    const as = { tenant: tenantId, user: x.session.user.id };
    const put = await x.api.request('PUT', '/api/tenant/settings/exit.auto_blacklist_enabled', {
      ...as,
      ifMatch: 0,
      body: { value: true },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const rule = await x.session.request('POST', '/blacklist-rules', {
      ifMatch: 0,
      body: {
        name: '退休不适用',
        priority: 1,
        orgIds: [x.from.id],
        conditions: [{ field: 'exitCount', operator: 'gte', value: 1 }],
        term: 'permanent',
        reason: 'instability',
      },
    });
    expect(rule.status, await rule.clone().text()).toBe(201);
  }
  return { ...x, tenantId, rowsOf, autoOn };
}

describe('退休接入 BE-8b1 加黑', () => {
  it('自动加黑只对离职：总开关开启、规则命中，退休生效也不自动加黑', async () => {
    const x = await world('auto-leave-only');
    await x.autoOn();
    await x.setExpectedRetirement(DUE);
    const created = await x.createdRetire(x.employee.id, retireBody(DUE, 'direct'));
    expect(created.status).toBe('effective');
    expect(await x.rowsOf(x.employee.id)).toEqual([]);
  });
});
