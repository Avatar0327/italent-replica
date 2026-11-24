import { sql, withTenant, type Db } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { loadFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import { forwardJobApi } from './AC-FWD-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();
const confirmedAt = '2026-10-02T03:45:00.000Z';

async function fixture(db: Db, label: string) {
  const world = await activationWorld(db, label);
  const { employee, hire } = await world.hired();
  const transfer = await world.session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-05', fields: { departmentId: world.to.id } },
    hire.employeeRevision,
  );
  expect(transfer).toMatchObject({ status: 'effective', record: { fields: { place: '原地点' } } });
  const { tenant, user } = world.session;
  const read = () =>
    withTenant(db, tenant.id, async (tx) => {
      const versions = resultRows<{
        id: string;
        version: number;
        date: string;
        explicit: string[];
        place: string | null;
        originCount: number;
      }>(
        await tx.execute(sql`
          SELECT p.id, p.version_no AS version, p.effective_date::text AS date,
            p.explicit_field_codes AS explicit, p.place,
            (SELECT count(*)::int FROM employment_field_origins o
             WHERE o.tenant_id = p.tenant_id AND o.payload_version_id = p.id) AS "originCount"
          FROM employment_payload_versions p
          WHERE p.tenant_id = ${tenant.id} AND p.business_id = ${transfer.id} ORDER BY p.version_no`),
      );
      const states = await loadFieldOrigins(tx, { tenantId: tenant.id }, transfer.id, [
        'preset:place',
        'preset:positionId',
      ]);
      return {
        versions,
        place: states.get('preset:place')?.lastWriter,
        position: states.get('preset:positionId')?.lastWriter,
      };
    });
  const confirm = async (fields: { place: string; positionId?: string }) => {
    world.session.setNow(confirmedAt);
    const response = await world.session.request('PATCH', `/records/${transfer.id}`, {
      ifMatch: transfer.revision,
      body: { fields },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  const reschedule = async () => {
    expect(await world.runScheduler('2026-10-06T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
    expect(await world.auditEvents(transfer.id)).toContainEqual(
      expect.objectContaining({ action: 'employment.transfer.rescheduled' }),
    );
    const record = await world.session.record(transfer.id, '2026-10-06');
    expect(record.effectiveDate).toBe('2026-10-06');
    return record;
  };
  return { world, user, hire, transfer, read, confirm, reschedule };
}

it('AC-EMP-26 DEC-974：同值确认只写来源，#11 carry-only 第 2 版不新增 explicit', async () => {
  const x = await fixture(database().db, 'f036s3-confirmed-place');
  expect(await x.confirm({ place: '原地点' })).toMatchObject({ revision: x.transfer.revision });
  const confirmed = await x.read();
  expect(confirmed.versions.map(({ version, explicit }) => ({ version, explicit }))).toEqual([
    { version: 1, explicit: ['preset:departmentId'] },
  ]);
  expect(confirmed.place).toMatchObject({
    originKind: 'hr-record',
    value: '原地点',
    actorUserId: x.user.id,
    createdAt: new Date(confirmedAt),
    payloadVersionId: confirmed.versions[0]!.id,
  });

  expect((await x.reschedule()).fields.place).toBe('原地点');
  const after = await x.read();
  expect(after.versions).toEqual([
    confirmed.versions[0],
    {
      id: expect.any(String),
      version: 2,
      date: '2026-10-06',
      explicit: ['preset:departmentId'],
      place: '原地点',
      originCount: 0,
    },
  ]);
  expect(after.place).toEqual(confirmed.place);
});

it('AC-EMP-26 DEC-974：混合 PATCH 同值确认工作地、实际改职位，只把职位加入 explicit', async () => {
  const { db } = database();
  const x = await fixture(db, 'f036s3-confirmed-place-position');
  const jobs = forwardJobApi(db, x.world.session);
  const post = await jobs.create('posts');
  const position = await jobs.create('positions', { orgId: x.world.to.id, postId: post.id });
  await x.confirm({ place: '原地点', positionId: position.id });

  const after = await x.read();
  expect(after.versions.map(({ version, explicit }) => ({ version, explicit }))).toEqual([
    { version: 1, explicit: ['preset:departmentId'] },
    { version: 2, explicit: ['preset:departmentId', 'preset:positionId'] },
  ]);
  expect(after.place).toMatchObject({
    originKind: 'hr-record',
    value: '原地点',
    actorUserId: x.user.id,
    createdAt: new Date(confirmedAt),
    payloadVersionId: after.versions[1]!.id,
  });
  expect(after.position).toMatchObject({ originKind: 'hr-record', value: position.id });
});

it('AC-EMP-26 DEC-975：前驱改值后 #11 仍沿用已物化工作地', async () => {
  const x = await fixture(database().db, 'f036s3-confirmed-place-inheritance');
  await x.confirm({ place: '原地点' });
  const predecessor = await x.world.business(x.hire.id);
  const edited = await x.world.session.request('POST', '/records/batch-edit', {
    body: {
      items: [{ id: predecessor.id, revision: predecessor.revision }],
      patch: { fields: { place: '前驱新地点' } },
    },
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  expect(await edited.json()).toMatchObject({ succeeded: 1, failed: 0 });
  expect((await x.world.session.record(x.hire.id, '2026-10-06')).fields.place).toBe('前驱新地点');
  expect((await x.read()).versions).toHaveLength(1);
  const record = await x.reschedule();
  const after = await x.read();
  expect(record.previousRecordId).toBe(x.hire.id);
  expect(after.versions).toHaveLength(2);
  expect(after.versions[1]).toMatchObject({ explicit: ['preset:departmentId'], originCount: 0 });
  expect(after.place).toMatchObject({ originKind: 'hr-record', value: '原地点', actorUserId: x.user.id });
  expect(record.fields.place).toBe('原地点');
});
