import { transferDeferredExcept } from './AC-EMP-26-projection-support.js';
import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { loadFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();

it('AC-EMP-25/26 #11：已落地的迟到调动以 carry-only 投影重排快照', async () => {
  const { db } = database();
  const w = await activationWorld(db, 'f036s3-snapshot-probe');
  const { tenant } = w.session;
  const configured = await w.session.request('PUT', '/transfers/settings', {
    ifMatch: 0,
    body: { unrestrictTargetDepartment: false, autoPopulate: false },
  });
  expect(configured.status, await configured.clone().text()).toBe(200);
  const person = await w.hired();
  const transfer = await w.session.business(
    person.employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: w.to.id } },
    person.hire.employeeRevision,
  );
  expect(transfer.record).toMatchObject({ fields: { departmentId: w.to.id, place: '原地点' } });
  const read = () =>
    withTenant(db, tenant.id, async (tx) => {
      const versions = resultRows<{
        version: number;
        date: string;
        explicit: string[];
        deferred: string[];
        snapshot: boolean;
        origins: number;
      }>(
        await tx.execute(sql`
        SELECT p.version_no AS version, p.effective_date::text AS date,
          p.explicit_field_codes AS explicit, p.deferred_field_codes AS deferred, p.is_record_snapshot AS snapshot,
          (SELECT count(*)::int FROM employment_field_origins o
           WHERE o.tenant_id = p.tenant_id AND o.payload_version_id = p.id) AS origins
        FROM employment_payload_versions p
        WHERE p.tenant_id = ${tenant.id} AND p.business_id = ${transfer.id}
        ORDER BY p.version_no`),
      );
      const states = await loadFieldOrigins(tx, { tenantId: tenant.id }, transfer.id);
      return {
        versions: versions.map((row) => ({ ...row, deferred: row.deferred.sort() })),
        state: states.get('preset:place'),
      };
    });
  const deferred = transferDeferredExcept();
  const before = await read();
  expect(before.versions).toHaveLength(1);
  expect(before.versions[0]).toMatchObject({
    version: 1,
    date: '2026-10-05',
    explicit: ['preset:departmentId'],
    deferred,
    snapshot: false,
  });
  // F-036-S6 写点 #16：落地把延迟字段的解析结果记成 resolved 行（取自前驱的“原地点”）；策略行与载荷版本不变
  expect(before.state).toMatchObject({
    policy: 'deferred',
    resolved: { originKind: 'resolved', value: '原地点' },
    lastWriter: { originKind: 'resolved', value: '原地点' },
  });

  const run = await w.runScheduler('2026-10-06T01:00:00Z');
  expect(run).toMatchObject({ failed: [], errors: [] });
  expect(await w.auditEvents(transfer.id)).toContainEqual(
    expect.objectContaining({ action: 'employment.transfer.rescheduled' }),
  );
  expect(await w.session.record(transfer.id, '2026-10-06')).toMatchObject({
    effectiveDate: '2026-10-06',
    fields: { departmentId: w.to.id, place: '原地点' },
  });
  const after = await read();
  expect(after.versions).toHaveLength(2);
  expect(after.versions[1]).toEqual({
    version: 2,
    date: '2026-10-06',
    explicit: ['preset:departmentId'],
    // §4.5：已落地解析（有效 resolved）的字段不再出现在载荷的“延迟”标记里；策略行仍是 deferred（上面的 state）
    deferred: [],
    snapshot: true,
    origins: 0,
  });
  expect(after.state).toEqual(before.state);
});
