import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferFixture } from './AC-EST-support.js';

const testDb = useTestDb();

describe('AC-EST-02 非严格超编须先提示后确认继续', () => {
  it('实有10/编制10，未确认不落占编，确认后警告且缺编数可为负', async () => {
    const fixture = await transferFixture(testDb().db, 'est02', { strictControl: false });
    await expect(fixture.apply('submitted')).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'CONFIRMATION_REQUIRED' },
    });
    expect(await fixture.stats()).toMatchObject({ inclusive: { actual: 10, preIncrease: 0, vacancy: 0 } });

    const result = await fixture.apply('submitted', 0, true);
    expect(result).toMatchObject({ businessId: fixture.businessId, status: 'submitted', reserveIn: true });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ orgId: fixture.target.id, reason: 'ESTABLISHMENT_EXCEEDED' }),
    );
    expect(await fixture.stats()).toMatchObject({ inclusive: { actual: 10, preIncrease: 1, vacancy: -1 } });
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();
  });
});
