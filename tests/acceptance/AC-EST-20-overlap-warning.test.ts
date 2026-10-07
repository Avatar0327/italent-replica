import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { carriedWorld } from './AC-TRF-47-EST-08-support.js';
import { configure, warning } from './AC-EST-20-support.js';

const database = useTestDb();
describe('AC-EST-20 OBS-03 保存顺序不影响区间超编提示', () => {
  for (const mode of ['direct', 'application'] as const)
    for (const strict of [false, true])
      for (const dates of [
        ['2026-10-20', '2026-10-05'],
        ['2026-10-05', '2026-10-20'],
      ])
        it(`mode=${mode}, strict=${strict}, 保存顺序=${dates.join('→')}`, async () => {
          const w = await carriedWorld(database().db, 'overlap-order');
          await configure(w, strict);
          const first = await w.hired('甲');
          const second = await w.hired('乙');
          expect(
            (
              await w.save(first, {
                withEstablishment: false,
                effectiveDate: dates[0],
                mode,
                submit: mode === 'application',
              })
            ).status,
          ).toBe(201);
          const input = { withEstablishment: false, effectiveDate: dates[1], mode, submit: mode === 'application' };
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
  const exit = await w.session.org('独立后续部门', { establishedOn: '2026-01-01' });
  expect(
    (
      await w.save(early, {
        withEstablishment: false,
        effectiveDate: '2026-10-15',
        fields: { departmentId: exit.id, positionId: null },
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

it('AC-EST-21 已提交未生效调入跨周期持续占编，不能在周期起点丢失', async () => {
  const w = await carriedWorld(database().db, 'overlap-period');
  await configure(w, false);
  const next = await w.write('establishment/capacities', {
    orgId: w.to.id,
    schemeId: w.scheme.id,
    periodStart: '2027-01-01',
    effectiveDate: '2026-10-01',
    strictControl: false,
    subdivisions: [{ positionId: w.targetPosition, localCapacity: 1, inclusiveCapacity: null }],
  });
  expect(next.status, await next.clone().text()).toBe(201);
  const first = await w.hired('跨年甲');
  expect(
    (
      await w.save(first, {
        withEstablishment: false,
        mode: 'application',
        submit: true,
        effectiveDate: '2026-12-20',
      })
    ).status,
  ).toBe(201);
  await warning(
    await w.save(await w.hired('次年乙'), {
      withEstablishment: false,
      effectiveDate: '2027-01-05',
    }),
  );
});

it.each(['delete', 'revoke'] as const)('AC-EST-21 %s 后调入不再占编', async (action) => {
  const w = await carriedWorld(database().db, `overlap-${action}`);
  await configure(w, false);
  const first = await w.hired('甲');
  const response = await w.save(first, {
    withEstablishment: false,
    effectiveDate: '2026-10-20',
    ...(action === 'revoke' ? { mode: 'application', submit: true } : {}),
  });
  expect(response.status).toBe(201);
  const saved = (await response.json()) as { id: string; revision: number };
  const removed = await w.session.request(
    action === 'delete' ? 'DELETE' : 'POST',
    `/businesses/${saved.id}${action === 'delete' ? '' : '/revoke'}`,
    { ifMatch: saved.revision, body: {} },
  );
  expect(removed.status, await removed.clone().text()).toBe(200);
  const second = await w.save(await w.hired('乙'), { withEstablishment: false, effectiveDate: '2026-10-05' });
  expect(second.status, await second.clone().text()).toBe(201);
});

it('AC-EST-23 两笔已确认的未来直接调动迟到执行仍按实际日落地，不重复提示', async () => {
  const w = await carriedWorld(database().db, 'overlap-late-direct');
  await configure(w, false);
  const ids: string[] = [];
  for (const effectiveDate of ['2026-10-20', '2026-10-05']) {
    const response = await w.save(await w.hired(effectiveDate), {
      withEstablishment: false,
      effectiveDate,
      confirmed: true,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    ids.push(((await response.json()) as { id: string }).id);
  }
  expect(await w.runScheduler('2026-10-21T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  for (const id of ids) expect(await w.business(id)).toMatchObject({ effectiveDate: '2026-10-21' });
  expect(await w.runScheduler('2026-10-22T01:00:00Z')).toMatchObject({ activated: [], failed: [], errors: [] });
  for (const id of ids) expect(await w.business(id)).toMatchObject({ effectiveDate: '2026-10-21' });
});

it.each([false, true])('AC-EST-21 初期容量足够但区间内未来容量不足，strict=%s', async (strict) => {
  const w = await carriedWorld(database().db, 'overlap-capacity-version');
  await configure(w, strict, 2);
  await configure(w, strict, 1, '2026-10-20');
  const first = await w.save(await w.hired('甲'), { withEstablishment: false, effectiveDate: '2026-10-05' });
  expect(first.status, await first.clone().text()).toBe(201);
  await warning(
    await w.save(await w.hired('乙'), {
      withEstablishment: false,
      effectiveDate: '2026-10-05',
    }),
    strict,
  );
});
