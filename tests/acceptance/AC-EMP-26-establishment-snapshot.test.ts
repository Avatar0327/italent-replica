import './support/exit-gate-enforced.js';
import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import {
  pendingTransfers,
  resolveProjectedTransfer,
} from '../../apps/api/src/modules/establishment/employment-check.js';
import { loadEmploymentRecord } from '../../apps/api/src/modules/employment/read-model.js';
import {
  camelRow,
  snapshotFields,
  type EmploymentPayloadRow,
} from '../../apps/api/src/modules/employment/record-store.js';
import { transferDeferredExcept } from './AC-EMP-26-projection-support.js';
import { retirementCancelWorld } from './AC-RT-cancel-support.js';
import { retireBody } from './AC-RT-support.js';
import { uniqueSuffix } from './support/unique.js';

const database = useTestDb();

it('AC-EMP-26 DEC-973：编制投影对已摘下的记录快照应保留原工作地', async () => {
  const { db } = database();
  const x = await retirementCancelWorld(db, 'f036s3-establishment-snapshot');
  const { tenant, user } = x.session;
  const configured = await x.session.request('PUT', '/transfers/settings', {
    ifMatch: 0,
    body: { unrestrictTargetDepartment: false, autoPopulate: false },
  });
  expect(configured.status, await configured.clone().text()).toBe(200);
  const employee = await x.session.getEmployee(x.employee.id);
  const transfer = await x.session.business(
    employee.id,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-10-25', fields: { departmentId: x.to.id } },
    employee.revision,
  );
  expect(transfer).toMatchObject({ status: 'effective', record: { fields: { place: '原地点' } } });
  const edited = await x.session.request('PATCH', `/records/${transfer.id}`, {
    ifMatch: transfer.revision,
    body: { fields: { remarks: '保存实际任职快照' } },
  });
  expect(edited.status, await edited.clone().text()).toBe(200);
  const hire = (await x.session.records(employee.id, '2026-10-06')).find(({ kind }) => kind === 'hire')!;
  const { revision: hireRevision } = await x.business(hire.id);
  const batch = await x.session.request('POST', '/records/batch-edit', {
    body: {
      items: [{ id: hire.id, revision: hireRevision }],
      patch: { fields: { place: '退休前新地点' } },
    },
  });
  expect(batch.status, await batch.clone().text()).toBe(200);
  expect(await batch.json()).toMatchObject({ succeeded: 1, failed: 0 });
  expect((await x.session.record(transfer.id, '2026-10-25')).fields.place).toBe('原地点');
  const retirement = await x.createdRetire(employee.id, retireBody('2026-10-05', 'direct'));
  expect(retirement.status).toBe('effective');
  expect((await x.session.record(retirement.id, '2026-10-06')).fields.place).toBe('退休前新地点');
  expect(await x.stateOfBusiness(transfer.id)).toBe('effective');
  expect(await x.tombstoned(transfer.id)).toBe(false);

  const day = '2026-10-25';
  const ctx = {
    tenantId: tenant.id,
    userId: user.id,
    timezone: tenant.timezone,
    now: new Date(`${day}T01:00:00Z`),
    commandId: uniqueSuffix(),
    expectedRevision: 0,
  };
  await withTenant(db, tenant.id, async (tx) => {
    expect(await loadEmploymentRecord(tx, tenant.id, transfer.id, day)).toBeNull();
    const pending = await pendingTransfers(tx, ctx, {}, day, day);
    const row = pending.find(({ fields }) => fields.business_id === transfer.id);
    expect(row).toMatchObject({ state: 'effective' });
    const raw = camelRow(row!.fields);
    const payload = { ...raw, fields: snapshotFields(raw) } as unknown as EmploymentPayloadRow;
    expect(payload).toMatchObject({
      isRecordSnapshot: true,
      fields: { place: '原地点' },
    });
    // §4.5：快照里每个延迟字段都已有落地解析值，不再列入 deferred_field_codes；DEC-972 的工作地沿用由下面的断言保证。
    expect([...payload.deferredFieldCodes]).toEqual([]);
    expect(payload.explicitFieldCodes).toEqual(['preset:departmentId', 'preset:remarks']);
    const read = (input: EmploymentPayloadRow) =>
      resolveProjectedTransfer(tx, ctx, input, row!.state, new Map(), new Map());
    const baseline = await read({ ...payload, deferredFieldCodes: [] });
    expect(baseline.predecessor).toMatchObject({ kind: 'retirement', fields: { place: '退休前新地点' } });
    expect(baseline.fields.place).toBe('原地点');
    // DEC-972 的守卫仍要有效：即使载荷带着延迟标记（旧快照），已物化的快照也不再按前驱重新解析。
    const withDec972 = await read({ ...payload, deferredFieldCodes: transferDeferredExcept('preset:remarks') });
    expect(withDec972.fields.place, 'DEC-972：编制投影应沿用已物化快照的工作地').toBe('原地点');
  });
});
