import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';
import { tenantApi } from './support/tenant-api.js';
import { runEmploymentTransition } from '../../apps/api/src/modules/employment/transitions.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof carriedWorld>>;
async function snapshot(w: World, id: string, employeeId: string) {
  return {
    business: await w.business(id),
    capacities: await w.capacities(),
    history: await w.history(),
    employee: await w.session.getEmployee(employeeId),
    records: await w.session.records(employeeId),
  };
}
async function draftWorld(strict: boolean, submitted: boolean) {
  const w = await carriedWorld(database().db, 'carried-release-confirmation');
  await configure(w, strict, 0);
  if (submitted) {
    const response = await tenantApi(w.db).request('PUT', '/api/tenant/establishment/settings', {
      user: w.session.user.id,
      tenant: w.session.tenant.id,
      ifMatch: 0,
      body: { transferIn: 'approved', transferOut: 'submitted', effectiveDate: '2026-10-01' },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const a = await w.hired('携编甲');
  const b = await w.hired('普通乙');
  const saved = await w.save(a, { mode: 'application', submit: submitted, effectiveDate: '2026-10-20' });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const { id, revision } = (await saved.json()) as { id: string; revision: number };
  expect((await w.save(b, { withEstablishment: false })).status).toBe(201);
  return { ...w, a, b, id, revision };
}

for (const strict of [false, true])
  for (const action of ['delete', 'withdraw', 'revoke'] as const)
    it(`AC-EST-30 携编额度已占用 ${action} strict=${strict}`, async () => {
      const w = await draftWorld(strict, action !== 'delete');
      const before = await snapshot(w, w.id, w.a.employee.id);
      const occupant = await w.session.records(w.b.employee.id);
      const request = (confirmed?: boolean, key = randomUUID()) =>
        w.session.request(
          action === 'delete' ? 'DELETE' : 'POST',
          `/businesses/${w.id}${action === 'delete' ? '' : `/${action}`}`,
          { ifMatch: w.revision, idempotencyKey: key, body: confirmed === undefined ? {} : { confirmed } },
        );
      await warning(await request(), strict);
      expect(await snapshot(w, w.id, w.a.employee.id)).toEqual(before);
      const key = randomUUID();
      const confirmed = await request(true, key);
      if (strict) {
        await warning(confirmed, true);
        expect(await snapshot(w, w.id, w.a.employee.id)).toEqual(before);
      } else {
        expect(confirmed.status, await confirmed.clone().text()).toBe(200);
        expect((await w.business(w.id)).status).toBe(
          action === 'withdraw' ? 'draft' : action === 'delete' ? 'deleted' : 'voided',
        );
        expect((await w.capacities())[1]?.localCapacity).toBe(0);
        expect(await w.history()).toHaveLength(4);
        const after = await snapshot(w, w.id, w.a.employee.id);
        expect((await request(true, key)).status).toBe(200);
        expect(await snapshot(w, w.id, w.a.employee.id)).toEqual(after);
      }
      expect(await w.session.records(w.b.employee.id)).toEqual(occupant);
    });

it.each([false, true])('AC-EST-30 携编草稿改配释放旧额度 strict=%s', async (strict) => {
  const w = await draftWorld(strict, false);
  const before = await snapshot(w, w.id, w.a.employee.id);
  const request = (confirmed?: boolean) =>
    w.session.request('PATCH', `/businesses/${w.id}`, {
      ifMatch: w.revision,
      body: { fields: { departmentId: w.from.id, positionId: w.sourcePosition }, ...(confirmed ? { confirmed } : {}) },
    });
  await warning(await request(), strict);
  expect(await snapshot(w, w.id, w.a.employee.id)).toEqual(before);
  const confirmed = await request(true);
  if (strict) {
    await warning(confirmed, true);
    expect(await snapshot(w, w.id, w.a.employee.id)).toEqual(before);
  } else {
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    expect((await w.business(w.id)).fields.departmentId).toBe(w.from.id);
    expect((await w.capacities())[1]?.localCapacity).toBe(0);
  }
});

for (const strict of [false, true])
  for (const action of ['reject', 'disapprove'] as const)
    it(`AC-EST-30 审批 ${action} 透传确认：非严格需确认、严格仍拒绝、未确认整体回滚 strict=${strict}`, async () => {
      const w = await draftWorld(strict, true);
      const before = await snapshot(w, w.id, w.a.employee.id);
      const run = (confirmed?: boolean) =>
        runEmploymentTransition(
          w.db,
          {
            tenantId: w.session.tenant.id,
            userId: w.session.user.id,
            timezone: w.session.tenant.timezone,
            now: new Date('2026-10-01T01:00:00Z'),
            commandId: randomUUID(),
            expectedRevision: w.revision,
          },
          { id: w.id, action, ...(confirmed === undefined ? {} : { confirmed }) },
        );
      // DEC-258：驳回 / 不同意不再服务端豁免非严格确认，改由审批中心透传 confirmed；携编严格回退照旧拒绝。
      await expect(run()).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: strict ? 'ESTABLISHMENT_EXCEEDED' : 'CONFIRMATION_REQUIRED' },
      });
      expect(await snapshot(w, w.id, w.a.employee.id)).toEqual(before);
      if (strict) {
        await expect(run(true)).rejects.toMatchObject({
          code: 'CONFLICT',
          details: { reason: 'ESTABLISHMENT_EXCEEDED' },
        });
        expect(await snapshot(w, w.id, w.a.employee.id)).toEqual(before);
      } else {
        expect((await run(true)).status).toBe(200);
        expect((await w.business(w.id)).status).toBe(action === 'reject' ? 'rejected' : 'disapproved');
        expect((await w.capacities())[1]?.localCapacity).toBe(0);
        expect(await w.history()).toHaveLength(4);
      }
    });
