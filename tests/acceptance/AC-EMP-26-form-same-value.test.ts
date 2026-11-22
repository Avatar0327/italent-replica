import { sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { loadFieldOrigins } from '../../apps/api/src/modules/employment/field-origin-store.js';
import type { EmploymentSession } from './AC-EMP-support.js';
import { forwardFixture } from './AC-FWD-support.js';
import { resultRows } from './AC-ORG-people-support.js';
import { activationWorld, type ActivationBusiness } from './AC-TRF-activation-support.js';

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

  await changePredecessorPlace(session, hired.id);
  const current = await session.request('GET', `/businesses/${draft.id}`);
  expect(current.status).toBe(200);
  const moved = await patch(((await current.json()) as { revision: number }).revision, { effectiveDate: '2026-11-03' });
  expect.soft(moved.fields.place, '只改生效日重新继承工作地').toBe('新前驱地点');
  expect.soft(await read(3)).toEqual({ ...expected, place: '新前驱地点' });
});

async function changePredecessorPlace(session: EmploymentSession, hireId: string) {
  const currentHire = await session.request('GET', `/businesses/${hireId}`);
  expect(currentHire.status).toBe(200);
  const { revision } = (await currentHire.json()) as { revision: number };
  const batch = await session.request('POST', '/records/batch-edit', {
    body: { items: [{ id: hireId, revision }], patch: { fields: { place: '新前驱地点' } } },
  });
  expect(batch.status, await batch.clone().text()).toBe(200);
  expect(await batch.json()).toMatchObject({ succeeded: 1, failed: 0 });
}

it('AC-EMP-26/28 DEC-977/041：同次改期并原样提交工作地，保存与落地都取新前驱', async () => {
  const { db } = database();
  const w = await activationWorld(db, 'f036s3-reschedule-same-place');
  const { session, to } = w;
  const { employee, hire } = await w.hired();
  const draft = await session.business(
    employee.id,
    { kind: 'transfer', mode: 'application', effectiveDate: '2026-11-01', fields: { departmentId: to.id } },
    hire.employeeRevision,
  );
  await changePredecessorPlace(session, hire.id);
  const before = await w.business(draft.id);
  expect(before.fields.place, '前驱编辑未向草稿传播').toBe('原地点');
  const patched = await session.request('PATCH', `/businesses/${draft.id}`, {
    ifMatch: before.revision,
    body: { effectiveDate: '2026-11-03', fields: { place: '原地点', remarks: '修改日期' } },
  });
  expect(patched.status, await patched.clone().text()).toBe(200);
  const saved = (await patched.json()) as ActivationBusiness;
  const fields = { departmentId: to.id, place: '新前驱地点', remarks: '修改日期' };
  expect.soft(saved.fields.place, '同次改期并原样提交工作地，响应应取新前驱').toBe(fields.place);
  expect(saved.fields).toMatchObject({ departmentId: fields.departmentId, remarks: fields.remarks });
  await withTenant(db, session.tenant.id, async (tx) => {
    const tenantId = session.tenant.id;
    const rows = resultRows(
      await tx.execute(sql`SELECT explicit_field_codes AS explicit, deferred_field_codes AS deferred, place, remarks
        FROM employment_payload_versions WHERE tenant_id=${tenantId} AND business_id=${draft.id} AND version_no=2`),
    );
    expect.soft(rows, '第 2 版载荷应与来源及标记一致').toEqual([
      {
        explicit: ['preset:departmentId', 'preset:remarks'],
        deferred: [],
        place: fields.place,
        remarks: fields.remarks,
      },
    ]);
    const states = await loadFieldOrigins(tx, { tenantId }, draft.id, ['preset:place', 'preset:remarks']);
    expect(states.get('preset:place')).toMatchObject({
      override: null,
      lastWriter: { originKind: 'inherit', value: fields.place },
    });
    expect(states.get('preset:remarks')?.lastWriter).toMatchObject({ originKind: 'hr-input', value: fields.remarks });
  });

  const submitted = await session.request('POST', `/businesses/${draft.id}/submit`, {
    ifMatch: saved.revision,
    body: {},
  });
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  await w.approve(draft, '2026-10-02T01:00:00Z');
  expect(await w.runScheduler('2026-11-03T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  expect.soft(await session.record(draft.id, '2026-11-03'), '到期记录应使用重新继承的工作地').toMatchObject({
    effectiveDate: '2026-11-03',
    fields,
  });
});
