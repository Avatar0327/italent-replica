import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { activationWorld } from './AC-TRF-activation-support.js';
const database = useTestDb();
it('DEC-195 迟到批准尚待前序时也改为批准日，调度保持原计划顺序', async () => {
  const w = await activationWorld(database().db, 'f017-r2-pending');
  const person = await w.hired();
  const earlier = await w.approve(
    await w.apply(person.employee.id, '2026-10-05', { place: '前序' }),
    '2026-10-01T02:00:00Z',
  );
  const later = await w.approve(
    await w.apply(person.employee.id, '2026-10-06', { place: '后序' }),
    '2026-10-08T01:00:00Z',
  );
  expect(later).toMatchObject({ status: 'approved', effectiveDate: '2026-10-08' });
  expect(await w.runScheduler('2026-10-09T01:00:00Z')).toMatchObject({ failed: [], errors: [] });
  expect((await w.session.records(person.employee.id, '2026-10-09')).map((r) => r.id)).toEqual([
    person.hire.id,
    earlier.id,
    later.id,
  ]);
  expect(
    (await w.auditEvents(later.id))
      .filter((e) => e.action === 'employment.transfer.rescheduled')
      .map((e) => e.after?.originalEffectiveDate),
  ).toContain('2026-10-06');
});
