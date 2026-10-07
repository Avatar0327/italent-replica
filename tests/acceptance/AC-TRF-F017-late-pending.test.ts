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
  // DEC-278（第 2 轮，不豁免未落地申请）：前序的区间 [10-05, 10-09) 含后序（原计划 10-06）→ 前序记需重建，后序先落地；
  // HR 重试前序后仍按原计划日排在前。
  expect(await w.runScheduler('2026-10-09T01:00:00Z')).toMatchObject({
    failed: [earlier.id],
    activated: [later.id],
    errors: [],
  });
  expect((await w.retry(earlier, '2026-10-09T02:00:00Z')).status).toBe(200);
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

it.each(['2026-10-01', '2026-10-08'])('DEC-195 三笔迟到申请按原计划传播字段（A 于 %s 批准）', async (approvalDate) => {
  const w = await activationWorld(database().db, `f017-r3-${approvalDate}`);
  const person = await w.hired();
  const c = await w.approve(await w.apply(person.employee.id, '2026-10-04', {}), '2026-10-01T02:00:00Z');
  const b = await w.approve(
    await w.apply(person.employee.id, '2026-10-06', { place: '原地点' }),
    '2026-10-01T03:00:00Z',
  );
  const a = await w.approve(
    await w.apply(person.employee.id, '2026-10-05', { place: 'A' }),
    `${approvalDate}T04:00:00Z`,
  );
  // DEC-278（第 2 轮，不豁免未落地申请）：C 的区间含 A、B，A 的区间含 B → 调度时 C 记需重建（A 于 10-08 批准时已在
  // 审批落地记过需重建），B 先落地；HR 依次重试 A、C 后三者仍按原计划日排序并照常向后传播。
  expect(await w.runScheduler('2026-10-09T01:00:00Z')).toMatchObject({
    failed: approvalDate === '2026-10-01' ? [c.id, a.id] : [c.id],
    activated: [b.id],
    errors: [],
  });
  expect((await w.retry(a, '2026-10-09T02:00:00Z')).status).toBe(200);
  expect((await w.retry(c, '2026-10-09T03:00:00Z')).status).toBe(200);
  expect((await w.session.records(person.employee.id, '2026-10-09')).map((r) => r.id)).toEqual([
    person.hire.id,
    c.id,
    a.id,
    b.id,
  ]);
  for (const [target, place] of [
    [c, '原地点'],
    [a, 'A'],
    [b, 'A'],
  ] as const) {
    expect(await w.business(target.id)).toMatchObject({
      status: 'effective',
      effectiveDate: '2026-10-09',
      fields: { place },
    });
  }
  expect((await w.auditEvents(b.id)).filter((e) => e.action === 'employment.forward-update')).toEqual([
    expect.objectContaining({ after: { place: 'A' } }),
  ]);
});
