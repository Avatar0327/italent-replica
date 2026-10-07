import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof carriedWorld>>;
async function timing(w: World, direction: 'transferIn' | 'transferOut') {
  const api = tenantApi(w.db);
  const auth = { user: w.session.user.id, tenant: w.session.tenant.id };
  for (const [effectiveDate, value] of [
    ['2026-10-01', direction === 'transferIn' ? 'approved' : 'submitted'],
    ['2026-10-15', direction === 'transferIn' ? 'submitted' : 'approved'],
  ]) {
    const current = await api.request('GET', '/api/tenant/establishment/settings', auth);
    const { revision } = (await current.json()) as { revision: number };
    const response = await api.request('PUT', '/api/tenant/establishment/settings', {
      ...auth,
      ifMatch: revision,
      body: { transferIn: 'submitted', transferOut: 'submitted', [direction]: value, effectiveDate },
    });
    expect(response.status, await response.clone().text()).toBe(200);
  }
}

for (const strict of [false, true])
  for (const applicationFirst of [true, false])
    it(`AC-EST-27 调入时机版本边界 strict=${strict}, applicationFirst=${applicationFirst}`, async () => {
      const w = await carriedWorld(database().db, 'timing-in');
      await configure(w, strict);
      await timing(w, 'transferIn');
      const a = await w.hired('甲');
      const b = await w.hired('乙');
      const application = () =>
        w.save(a, {
          withEstablishment: false,
          effectiveDate: '2026-10-20',
          mode: 'application',
          submit: true,
        });
      const direct = () => w.save(b, { withEstablishment: false, effectiveDate: '2026-10-05' });
      const first = await (applicationFirst ? application() : direct());
      expect(first.status, await first.clone().text()).toBe(201);
      const employee = applicationFirst ? b.employee.id : a.employee.id;
      const before = await w.session.records(employee);
      const revision = (await w.session.getEmployee(employee)).revision;
      await warning(await (applicationFirst ? direct() : application()), strict);
      expect(await w.session.records(employee)).toEqual(before);
      expect((await w.session.getEmployee(employee)).revision).toBe(revision);
    });

for (const strict of [false, true])
  for (const outgoingFirst of [true, false])
    it(`AC-EST-27 调出时机版本边界 strict=${strict}, outgoingFirst=${outgoingFirst}`, async () => {
      const w = await carriedWorld(database().db, 'timing-out');
      await configure(w, strict);
      await timing(w, 'transferOut');
      const a = await w.hired('原占编甲');
      const b = await w.hired('调入乙');
      expect((await w.save(a, { withEstablishment: false, effectiveDate: '2026-10-01' })).status).toBe(201);
      const incoming = () => w.save(b, { withEstablishment: false, effectiveDate: '2026-10-05' });
      if (!outgoingFirst) await warning(await incoming(), strict);
      const outgoing = await w.save(a, {
        withEstablishment: false,
        effectiveDate: '2026-10-05',
        mode: 'application',
        submit: true,
        fields: { departmentId: w.from.id, positionId: w.sourcePosition },
      });
      expect(outgoing.status, await outgoing.clone().text()).toBe(201);
      const before = await w.session.records(b.employee.id);
      await warning(await incoming(), strict);
      expect(await w.session.records(b.employee.id)).toEqual(before);
      expect((await w.session.getEmployee(b.employee.id)).revision).toBe(b.hire.employeeRevision);
    });

it.each([false, true])('AC-EST-27 本人后续调出不能用旧时机提前截断全部区间 strict=%s', async (strict) => {
  const w = await carriedWorld(database().db, 'timing-own-out');
  await configure(w, strict);
  await timing(w, 'transferOut');
  const a = await w.hired('甲');
  const b = await w.hired('乙');
  const existing = await w.save(b, {
    withEstablishment: false,
    fields: { departmentId: w.from.id, positionId: w.sourcePosition },
  });
  expect(existing.status).toBe(201);
  const { id } = (await existing.json()) as { id: string };
  const exit = await w.session.org('后续调出部门', { establishedOn: '2026-01-01' });
  expect(
    (
      await w.save(b, {
        withEstablishment: false,
        mode: 'application',
        submit: true,
        effectiveDate: '2026-10-20',
        fields: { departmentId: exit.id, positionId: null },
      })
    ).status,
  ).toBe(201);
  expect((await w.save(a, { withEstablishment: false, effectiveDate: '2026-10-20' })).status).toBe(201);
  const before = await w.session.records(b.employee.id);
  const current = await w.business(id);
  await warning(
    await w.session.request('PATCH', `/records/${id}`, {
      ifMatch: current.revision,
      body: { fields: { departmentId: w.to.id, positionId: w.targetPosition } },
    }),
    strict,
  );
  expect(await w.session.records(b.employee.id)).toEqual(before);
});
