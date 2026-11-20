/**
 * AC-FWD-09（F-532）：经真实 HTTP 入口 POST /records/batch-edit 批量改当前主职，只改所选记录，不向后传播到未来任职
 * （REQ-EMP-003 / 07 A7：批量编辑只保存自身）。AC-FWD-09 原用例直接调内核并显式传 'batch_edit'，绕过了批量服务的接线。
 */
import { withTenant, sql } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { forwardFixture } from './AC-FWD-support.js';
import { resultRows } from './AC-ORG-support.js';

const testDb = useTestDb();

describe('AC-FWD-09 批量编辑 HTTP 入口不传播到未来记录', () => {
  it('批量改当前主职工作地：未来任职（工作地等于旧值）不变，无新版本、无传播审计', async () => {
    const { db } = testDb();
    const { session, employee, hired } = await forwardFixture(db, 'fwd09-batch-http');
    const future = await session.business(
      employee.id,
      { kind: 'transfer', mode: 'direct', effectiveDate: '2026-11-01' },
      hired.employeeRevision,
    );
    expect((await session.record(future.id)).fields.place).toBe('原地点');

    const payloads = (businessId: string) =>
      withTenant(db, session.tenant.id, async (tx) =>
        resultRows<{ version_no: number; trigger_business_id: string | null }>(
          await tx.execute(sql`SELECT version_no, trigger_business_id FROM employment_payload_versions
            WHERE tenant_id=${session.tenant.id} AND business_id=${businessId} ORDER BY version_no`),
        ),
      );
    const futureBefore = await payloads(future.id);
    const revisionOf = (businessId: string) =>
      withTenant(db, session.tenant.id, async (tx) =>
        resultRows<{ revision: number }>(
          await tx.execute(sql`SELECT revision FROM employment_business_objects
            WHERE tenant_id=${session.tenant.id} AND id=${businessId}`),
        ),
      );
    const futureRevision = await revisionOf(future.id);

    const response = await session.request('POST', '/records/batch-edit', {
      body: { items: [{ id: hired.id, revision: hired.revision }], patch: { fields: { place: '批量新地点' } } },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ total: 1, succeeded: 1, failed: 0 });

    expect((await session.record(hired.id)).fields.place).toBe('批量新地点');
    expect((await session.record(future.id)).fields.place).toBe('原地点');
    expect(await revisionOf(future.id)).toEqual(futureRevision);
    expect(await payloads(future.id)).toEqual(futureBefore);
    const propagated = await withTenant(db, session.tenant.id, async (tx) =>
      resultRows<{ object_id: string }>(
        await tx.execute(sql`SELECT object_id FROM audit_events
          WHERE tenant_id=${session.tenant.id} AND action='employment.forward-update'`),
      ),
    );
    expect(propagated).toEqual([]);
  });
});
