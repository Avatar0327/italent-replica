import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { personnelSession } from './AC-SUB-support.js';
import { loginEmailOf } from './AC-EMP-support.js';
const database = useTestDb();
it('AC-SUB-04 职级来自当前任职及职级版本的关联查询，变更后排序不陈旧', async () => {
  const s = await personnelSession(database().db);
  const create = async (path: string, body: object, ifMatch = 0) => {
    const response = await s.api.request('POST', `/api/tenant/${path}`, { ...s.as, body, ifMatch });
    expect(response.status, await response.clone().text()).toBe(201);
    return (await response.json()) as { id: string; revision: number; employeeRevision: number };
  };
  const type = await create('job/level-types', { name: '合成体系', code: 'TYPE', startDate: '2020-01-01' });
  const level = (number: number) =>
    create('job/levels', {
      name: `合成职级${number}`,
      code: `L${number}`,
      level: number,
      levelTypeId: type.id,
      startDate: '2020-01-01',
    });
  const low = await level(1);
  const high = await level(9);
  const make = async (levelId: string, label: string) => {
    const e = await create('employment/employees', { code: randomUUID(), name: label });
    const hire = await create(
      `employment/employees/${e.id}/businesses`,
      {
        kind: 'hire',
        mode: 'direct',
        effectiveDate: '2020-01-01',
        fields: { levelId },
        loginEmail: loginEmailOf(e.id),
      },
      1,
    );
    const subset = await create(`personnel/employees/${e.id}/subsets/education`, { school: label });
    return { e, hire, subset };
  };
  const a = await make(high.id, '先高');
  const b = await make(low.id, '后低');
  const list = async () => {
    const r = await s.request('GET', '/subsets/education?sortBy=levelSortNumber');
    expect(r.status).toBe(200);
    return (await r.json()) as { items: { school: string; levelSortNumber: number }[] };
  };
  expect((await list()).items.map((r) => r.school)).toEqual(['后低', '先高']);
  const mid = await level(5);
  await create(
    `employment/employees/${a.e.id}/businesses`,
    { kind: 'transfer', mode: 'direct', effectiveDate: '2026-09-01', fields: { levelId: mid.id } },
    a.hire.employeeRevision,
  );
  const result = await list();
  expect(result.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ school: '先高', levelSortNumber: 5 }),
      expect.objectContaining({ school: '后低', levelSortNumber: 1 }),
    ]),
  );
  const filter = await s.request('GET', '/subsets/education?levelSortNumber=5');
  expect(await filter.json()).toMatchObject({ items: [{ employeeId: a.e.id }] });
  expect(b.e.id).not.toBe(a.e.id);
});
