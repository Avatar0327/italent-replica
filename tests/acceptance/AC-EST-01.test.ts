import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferFixture } from './AC-EST-support.js';

const testDb = useTestDb();

describe('AC-EST-01 真实编制与服务端实有人数计算严格超编', () => {
  it('编制10、可信接口实有10，严格控制即使确认也拒绝调入且不占编', async () => {
    const fixture = await transferFixture(testDb().db, 'est01', { strictControl: true });
    expect(await fixture.stats()).toMatchObject({
      strictControl: true,
      inclusive: { capacity: 10, actual: 10, preIncrease: 0, preDecrease: 0, vacancy: 0 },
    });

    await expect(fixture.apply('submitted', 0, true)).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'ESTABLISHMENT_EXCEEDED' },
    });
    expect(await fixture.stats()).toMatchObject({ inclusive: { preIncrease: 0, vacancy: 0 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 0 } });
    expect(fixture.port.headcount).toHaveBeenCalled();
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();
  });
});
