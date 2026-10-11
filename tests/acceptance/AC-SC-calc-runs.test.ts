/** R3-T05 B3：设计 §2.2 #10 的入口红测；完整 run 验收待体量拆分确认后补齐。 */
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const testDb = useTestDb();

describe('AC-SC-calc-runs 计算任务读取（设计 §2.2 #10）', () => {
  it('持查看权限的成员读取无任务的租户，返回空列表', async () => {
    const db = testDb().db;
    const { tenant, user } = await seedTenantWithMember(db, 'sc-calc-runs');
    const api = tenantApi(db);
    const response = await api.request('GET', '/api/tenant/succession/calc-runs', {
      tenant: tenant.id,
      user: user.id,
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({ items: [] });
  });
});
