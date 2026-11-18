/** F-363 对齐 F-323a：已保存并审批的用工形式到期落地仍是沿用，不重新选用。 */
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';

const database = useTestDb();

it('AC-EMP-F321-10：提前审批 → 停用 → 到期沿用已保存引用生效，重复调度不再写入', async () => {
  const w = await activationWorld(database().db, 'f321-activation');
  const { employee, hire } = await w.hired();
  const approved = await w.approve(
    await w.apply(employee.id, '2026-10-05', { departmentId: w.to.id, employmentForm: 'regular' }),
    '2026-10-02T02:00:00Z',
  );
  expect(approved).toMatchObject({ status: 'approved', record: null, activation: { status: 'pending' } });
  const dictionary = await w.session.request('GET', '/employment-forms');
  expect(dictionary.status).toBe(200);
  const { items } = (await dictionary.json()) as { items: { id: string; code: string; revision: number }[] };
  const form = items.find((item) => item.code === 'regular')!;
  const disabled = await w.session.request('PUT', `/employment-forms/${form.id}`, {
    ifMatch: form.revision,
    body: { enabled: false },
  });
  expect(disabled.status, await disabled.clone().text()).toBe(200);
  const run = await w.runScheduler('2026-10-05T01:00:00Z');
  expect(run).toMatchObject({ activated: [approved.id], failed: [], errors: [] });
  expect(await w.business(approved.id)).toMatchObject({
    status: 'effective',
    record: { fields: { employmentForm: 'regular' } },
    activation: { status: 'effective', failureCount: 0, failureReason: null },
  });
  expect((await w.session.records(employee.id, '2026-10-05')).map((record) => record.id)).toEqual([
    hire.id,
    approved.id,
  ]);
  expect(await w.todos()).toEqual([]);
  expect(await w.runScheduler('2026-10-05T02:00:00Z')).toMatchObject({ activated: [], failed: [], errors: [] });
});
