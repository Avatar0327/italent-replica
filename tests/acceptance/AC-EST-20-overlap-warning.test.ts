import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
type World = Awaited<ReturnType<typeof carriedWorld>>;
async function configure(w: World, strictControl: boolean, count = 1) {
  const target = (await w.capacities())[1]!;
  const response = await tenantApi(w.db).request('PATCH', `/api/tenant/establishment/capacities/${target.id}`, {
    user: w.session.user.id,
    tenant: w.session.tenant.id,
    ifMatch: target.revision,
    body: {
      effectiveDate: '2026-10-01',
      strictControl,
      subdivisions: [{ positionId: w.targetPosition, localCapacity: count, inclusiveCapacity: null }],
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
}
async function warning(response: Response, strict = false) {
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { details: { reason: strict ? 'ESTABLISHMENT_EXCEEDED' : 'CONFIRMATION_REQUIRED' } },
  });
}

describe('AC-EST-20 OBS-03 保存顺序不影响区间超编提示', () => {
  for (const strict of [false, true])
    for (const dates of [
      ['2026-10-20', '2026-10-05'],
      ['2026-10-05', '2026-10-20'],
    ])
      it(`strict=${strict}, 保存顺序=${dates.join('→')}`, async () => {
        const w = await carriedWorld(database().db, 'overlap-order');
        await configure(w, strict);
        const first = await w.hired('甲');
        const second = await w.hired('乙');
        expect((await w.save(first, { withEstablishment: false, effectiveDate: dates[0] })).status).toBe(201);
        const input = { withEstablishment: false, effectiveDate: dates[1] };
        const before = await w.session.getEmployee(second.employee.id);
        await warning(await w.save(second, input), strict);
        expect((await w.session.getEmployee(second.employee.id)).revision).toBe(before.revision);
        const confirmed = await w.save(second, { ...input, confirmed: true });
        if (strict) await warning(confirmed, true);
        else expect(confirmed.status, await confirmed.clone().text()).toBe(201);
      });
});

it('AC-EST-21 未来调出在调入当天释放，互不重叠不提示', async () => {
  const w = await carriedWorld(database().db, 'overlap-release');
  await configure(w, false);
  const first = await w.hired('甲');
  expect((await w.save(first, { withEstablishment: false, effectiveDate: '2026-10-05' })).status).toBe(201);
  expect(
    (
      await w.save(first, {
        withEstablishment: false,
        effectiveDate: '2026-10-20',
        fields: { departmentId: w.from.id, positionId: w.sourcePosition },
      })
    ).status,
  ).toBe(201);
  const response = await w.save(await w.hired('乙'), { withEstablishment: false, effectiveDate: '2026-10-20' });
  expect(response.status, await response.clone().text()).toBe(201);
});

it('AC-EST-21 新单结束后的超编不应阻止这段不重叠的调入', async () => {
  const w = await carriedWorld(database().db, 'overlap-bounded');
  await configure(w, false);
  const early = await w.hired('短期调入');
  expect(
    (
      await w.save(early, {
        withEstablishment: false,
        effectiveDate: '2026-10-15',
        fields: { departmentId: w.from.id, positionId: w.sourcePosition },
      })
    ).status,
  ).toBe(201);
  for (const name of ['后续甲', '后续乙']) {
    const response = await w.save(await w.hired(name), {
      withEstablishment: false,
      effectiveDate: '2026-10-20',
      confirmed: true,
    });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  const response = await w.save(early, { withEstablishment: false, effectiveDate: '2026-10-05' });
  expect(response.status, await response.clone().text()).toBe(201);
});

it('AC-EST-22 带编增量只算一次；非严格提示回滚调编，确认后原子保存', async () => {
  const w = await carriedWorld(database().db, 'overlap-carried');
  await configure(w, false, 0);
  const first = await w.hired('带编甲');
  expect((await w.save(first, { effectiveDate: '2026-10-20' })).status).toBe(201);
  const second = await w.hired('普通乙');
  await warning(await w.save(second, { withEstablishment: false }));
  expect((await w.save(second, { withEstablishment: false, confirmed: true })).status).toBe(201);
  const third = await w.hired('带编丙');
  const before = await w.capacities();
  const history = await w.history();
  await warning(await w.save(third));
  expect(await w.capacities()).toEqual(before);
  expect(await w.history()).toEqual(history);
  const confirmed = await w.save(third, { confirmed: true });
  expect(confirmed.status, await confirmed.clone().text()).toBe(201);
  expect((await w.capacities())[1]?.localCapacity).toBe(2);
  expect(await w.history()).toHaveLength(4);
});

it('AC-EST-23 迟到申请按实际执行日投影，审批与定时生效不再次要求交互确认', async () => {
  const w = await carriedWorld(database().db, 'overlap-late');
  await configure(w, false);
  const first = await w.hired('迟到甲');
  const saved = await w.save(first, {
    withEstablishment: false,
    mode: 'application',
    submit: true,
    effectiveDate: '2026-10-05',
  });
  expect(saved.status, await saved.clone().text()).toBe(201);
  const business = (await saved.json()) as { id: string };
  w.session.setNow('2026-10-20T01:00:00Z');
  const second = await w.hired('乙');
  await warning(await w.save(second, { withEstablishment: false, effectiveDate: '2026-10-20' }));
  expect(
    (
      await w.save(second, {
        withEstablishment: false,
        effectiveDate: '2026-10-20',
        confirmed: true,
      })
    ).status,
  ).toBe(201);
  await w.approve(business, '2026-10-20T01:00:00Z');
  expect(await w.business(business.id)).toMatchObject({ effectiveDate: '2026-10-20', status: 'effective' });
  expect(await w.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
});
