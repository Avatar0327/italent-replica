import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { loadFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { forwardFixture } from './AC-FWD-support.js';
import { resultRows } from './AC-ORG-people-support.js';

const database = useTestDb();

it('AC-EMP-26/28 DEC-977：整版重提的同值工作地仍继承，改期取新前驱', async () => {
  const { db } = database();
  const { session, employee, org, hired } = await forwardFixture(db, 'f036s3-form-same-place');
  const draft = await session.business(
    employee.id,
    { kind: 'transfer', mode: 'application', effectiveDate: '2026-11-01', fields: { departmentId: org.id } },
    hired.employeeRevision,
  );
  const patch = async (revision: number, body: object) => {
    const response = await session.request('PATCH', `/businesses/${draft.id}`, { ifMatch: revision, body });
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as { revision: number; fields: { place: string } };
  };
  const saved = await patch(draft.revision, { fields: { place: '原地点', remarks: '实际改备注' } });
  expect(saved.fields.place).toBe('原地点');
  const tenantId = session.tenant.id;
  const read = (version: number) =>
    withTenant(db, tenantId, async (tx) => {
      const rows = resultRows<{ explicit: string[]; deferred: string[]; place: string }>(
        await tx.execute(sql`SELECT explicit_field_codes AS explicit, deferred_field_codes AS deferred, place
          FROM employment_payload_versions WHERE tenant_id=${tenantId} AND business_id=${draft.id}
            AND version_no=${version}`),
      );
      const states = await loadFieldOrigins(tx, { tenantId }, draft.id, ['preset:place']);
      expect(states.get('preset:place')).toMatchObject({ override: null, lastWriter: { originKind: 'inherit' } });
      return rows[0];
    });
  const expected = { explicit: ['preset:departmentId', 'preset:remarks'], deferred: [], place: '原地点' };
  expect.soft(await read(2), '草稿同值工作地不进入 explicit').toEqual(expected);

  const currentHire = await session.request('GET', `/businesses/${hired.id}`);
  expect(currentHire.status).toBe(200);
  const batch = await session.request('POST', '/records/batch-edit', {
    body: {
      items: [{ id: hired.id, revision: ((await currentHire.json()) as { revision: number }).revision }],
      patch: { fields: { place: '新前驱地点' } },
    },
  });
  expect(batch.status, await batch.clone().text()).toBe(200);
  expect(await batch.json()).toMatchObject({ succeeded: 1, failed: 0 });
  const current = await session.request('GET', `/businesses/${draft.id}`);
  expect(current.status).toBe(200);
  const moved = await patch(((await current.json()) as { revision: number }).revision, { effectiveDate: '2026-11-03' });
  expect.soft(moved.fields.place, '只改生效日重新继承工作地').toBe('新前驱地点');
  expect.soft(await read(3)).toEqual({ ...expected, place: '新前驱地点' });
});
