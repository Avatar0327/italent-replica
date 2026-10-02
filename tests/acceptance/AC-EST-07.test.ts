import { withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { transferFixture } from './AC-EST-support.js';

const testDb = useTestDb();

describe('AC-EST-07 DEC-015 批量超编逐行警告但不拦截', () => {
  it('严格控制部门实有等于编制，批量两行仍均提交并逐行标注超编', async () => {
    const { db } = testDb();
    const fixture = await transferFixture(db, 'est07', { strictControl: true });
    const service = await import('../../apps/api/src/modules/establishment/transfer-service.js');
    const businessIds = [fixture.businessId, fixture.addTransfer()];
    const result = await withTenant(db, fixture.tenant.id, (tx) =>
      service.applyBatchTransfers(tx, fixture.context(), { businessIds, stage: 'submitted' }, fixture.port),
    );

    expect(result.items).toHaveLength(2);
    for (const [index, row] of result.items.entries()) {
      expect(row).toMatchObject({ businessId: businessIds[index], status: 'submitted', reserveIn: true });
      expect(row.warnings).toContainEqual(
        expect.objectContaining({ orgId: fixture.target.id, reason: 'ESTABLISHMENT_EXCEEDED' }),
      );
    }
    expect(await fixture.stats()).toMatchObject({ inclusive: { actual: 10, preIncrease: 2, vacancy: -2 } });
    expect(await fixture.stats(fixture.source.id)).toMatchObject({ inclusive: { preDecrease: 2 } });
    expect(fixture.port.applyTransfer).not.toHaveBeenCalled();
  });
});
