/**
 * F-429 ① 离职生效结束兼职 / 作废兼职申请：与任职 / 合同同结构写 exit_effects 台账（phase=effective、业务 = 离职单），
 * 与状态钩子同事务。兼职类目在撤销清单里仍走 part-time 探针（kind 不进 ADDITIONAL，不重复列出）。
 */
import './support/exit-gate-enforced.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { cancelWorld } from './AC-EXIT-cancel-support.js';
import { insertPartTimeRequest } from './AC-PT-support.js';

const database = useTestDb();
const TODAY = '2026-10-06';
/** 最后工作日 L = 10-10，离职生效日 E = 10-11，兼职结束于 L′ = 10-10。 */
const LAST_DAY = '2026-10-10';

async function world(label: string) {
  const x = await cancelWorld(database().db, label, TODAY);
  const tenantId = x.session.tenant.id;
  const org = await x.session.org('兼职部门', { establishedOn: '2025-01-01' });
  async function makePartTime(endDate: string | null, startDate = '2026-09-01') {
    const response = await x.session.request('POST', `/employees/${x.employee.id}/part-times`, {
      body: {
        partTimeType: 'part_time',
        startDate,
        ...(endDate ? { endDate } : {}),
        fields: { departmentId: org.id },
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string };
  }
  const draftRequest = () =>
    withTenant(x.db, tenantId, (tx) =>
      insertPartTimeRequest(tx, {
        tenantId,
        employeeId: x.employee.id,
        initiatorUserId: x.session.user.id,
        departmentId: org.id,
        requestType: 'add',
        state: 'draft',
      }),
    );
  const ledger = (leaveId: string) =>
    x.sqlRows<{
      phase: string;
      kind: string;
      target_type: string;
      target_id: string;
      detail: Record<string, unknown>;
    }>(sql`
      SELECT phase, kind, target_type, target_id::text, detail FROM exit_effects
      WHERE tenant_id=${tenantId} AND business_id=${leaveId}::uuid AND kind LIKE 'part_time_%'
      ORDER BY kind, target_id`);
  return { ...x, makePartTime, draftRequest, ledger };
}

describe('F-429 ① 离职生效兼职台账', () => {
  it('结束的兼职每条一行 part_time_ended（原结束日 → L′）、作废的申请一行 part_time_request_voided；已更早结束的兼职不写', async () => {
    const x = await world('f429-pt-ledger');
    const open = await x.makePartTime(null);
    const later = await x.makePartTime('2026-12-31');
    const early = await x.makePartTime('2026-09-05');
    const requestId = await x.draftRequest();
    const leave = await x.directLeave(LAST_DAY);

    await x.activate(leave.id, '2026-10-11');

    const rows = await x.ledger(leave.id);
    expect(rows.map((row) => [row.kind, row.target_type, row.target_id, row.phase])).toEqual(
      [
        ['part_time_ended', 'part-time-record', open.id, 'effective'],
        ['part_time_ended', 'part-time-record', later.id, 'effective'],
        ['part_time_request_voided', 'part-time-request', requestId, 'effective'],
      ].sort((a, b) => `${a[0]}${a[2]}`.localeCompare(`${b[0]}${b[2]}`)),
    );
    expect(rows.find((row) => row.target_id === later.id)!.detail).toMatchObject({
      originalEndDate: '2026-12-31',
      endDate: LAST_DAY,
    });
    expect(rows.find((row) => row.target_id === open.id)!.detail).toMatchObject({
      originalEndDate: null,
      endDate: LAST_DAY,
    });
    expect(rows.map((row) => row.target_id)).not.toContain(early.id);
    expect(rows.find((row) => row.target_id === requestId)!.detail).toMatchObject({ requestType: 'add' });
  });

  it('没有兼职时不写台账', async () => {
    const x = await world('f429-pt-ledger-none');
    const leave = await x.directLeave(LAST_DAY);
    await x.activate(leave.id, '2026-10-11');
    expect(await x.ledger(leave.id)).toEqual([]);
  });
});
