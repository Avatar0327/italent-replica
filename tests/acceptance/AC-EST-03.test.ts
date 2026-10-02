import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferFixture } from './AC-EST-support.js';

const testDb = useTestDb();

describe('AC-EST-03 提交与审批占用时机以及驳回撤销回退', () => {
  it('DEC-075 未配置租户使用提交即占用、提交即释放的出厂值', async () => {
    const fixture = await transferFixture(testDb().db, 'est03-default', {
      targetCount: 5,
      configureTimings: false,
    });
    const settings = await fixture.request('GET', '/settings');
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ transferIn: 'submitted', transferOut: 'submitted', revision: 0 });

    const submitted = await fixture.apply('submitted');
    expect(submitted).toMatchObject({ reserveIn: true, reserveOut: true });
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 1 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 1 } });
  });

  it.each(['rejected', 'withdrawn'] as const)('提交即增加双方预增/预减，%s后各回退1', async (stage) => {
    const fixture = await transferFixture(testDb().db, `est03-${stage}`, { targetCount: 5 });
    const submitted = await fixture.apply('submitted');
    expect(submitted).toMatchObject({ reserveIn: true, reserveOut: true });
    expect(await fixture.stats()).toMatchObject({ inclusive: { actual: 5, preIncrease: 1, vacancy: 4 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({
      inclusive: { actual: 10, preDecrease: 1, vacancy: 11 },
    });

    const rolledBack = await fixture.apply(stage, submitted.revision);
    expect(rolledBack).toMatchObject({ status: stage, reserveIn: false, reserveOut: false });
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 0, vacancy: 5 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 0, vacancy: 10 } });
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();
  });

  it('占编/释放均选审批通过，提交不预占，审批后各加1，再撤销完整回退', async () => {
    const fixture = await transferFixture(testDb().db, 'est03-approved', {
      targetCount: 5,
      transferIn: 'approved',
      transferOut: 'approved',
    });
    const submitted = await fixture.apply('submitted');
    expect(submitted).toMatchObject({ reserveIn: false, reserveOut: false });
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 0 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 0 } });

    const approved = await fixture.apply('approved', submitted.revision);
    expect(approved).toMatchObject({ status: 'approved', reserveIn: true, reserveOut: true });
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 1 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 1 } });
    await fixture.apply('withdrawn', approved.revision);
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 0 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 0 } });
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();
  });

  it('两笔调入并发争最后一个严格编制时只能成功一笔', async () => {
    const fixture = await transferFixture(testDb().db, 'est03-concurrent', {
      strictControl: true,
      targetCount: 9,
      targetCapacity: 10,
    });
    const another = fixture.addTransfer();
    const results = await Promise.allSettled([
      fixture.apply('submitted'),
      fixture.apply('submitted', 0, false, another),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await fixture.stats()).toMatchObject({ inclusive: { actual: 9, preIncrease: 1, vacancy: 0 } });
  });
});
