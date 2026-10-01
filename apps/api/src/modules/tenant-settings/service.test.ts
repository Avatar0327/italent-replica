import { createTenant, sql, withTenant } from '@italent/db';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { readEffectiveSetting } from './service.js';

const testDb = useTestDb();

describe('读取有效配置', () => {
  it('不加行锁：在只读事务中也能读取（SELECT ... FOR UPDATE 在只读事务中会被拒绝）', async () => {
    const { db } = testDb();
    const tenant = await createTenant(
      db,
      { code: 'read-t', name: '只读租户' },
      { actorUserId: null, commandId: 'seed' },
    );
    const setting = await withTenant(db, tenant.id, async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      return readEffectiveSetting(tx, tenant.id, 'audit.retention');
    });
    expect(setting).toMatchObject({ source: 'system', revision: 0 });
  });
});
