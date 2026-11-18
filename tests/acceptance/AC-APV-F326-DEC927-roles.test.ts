/** DEC-927：标准管理员沿真实授权链读取两类候选，不依赖流程对象编辑权。 */
import { permissionAdmins, withTenant } from '@italent/db';
import { APPROVAL_PROCESS_OBJECT } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { createPermissionAuthorizer } from '../../apps/api/src/modules/permission/authorizer.js';
import { s4World } from './AC-APV-F326-S7a-support.js';
import { tenantApi } from './support/tenant-api.js';
const database = useTestDb();
it.each(['tenant_admin', 'system_admin', 'matrix_admin'] as const)(
  'DEC-927：真实 %s 在设计器、矩阵两场景的两端点均 200',
  async (role) => {
    const w = await s4World(database().db, 's7d-dec927-role');
    const userId = await w.member(`合成${role}`);
    await withTenant(w.db, w.tenant.id, (tx) =>
      tx.insert(permissionAdmins).values({ tenantId: w.tenant.id, userId, role }),
    );
    const authorize = createPermissionAuthorizer(w.db, undefined, w.clock);
    const api = tenantApi(w.db, { authorize, clock: w.clock });
    const base = { tenantId: w.tenant.id, userId };
    expect(await authorize({ ...base, action: 'admin.process_matrix' })).toBe(true);
    expect(
      await authorize({ ...base, action: 'object.update', resource: APPROVAL_PROCESS_OBJECT, fields: [] }),
    ).toBe(false);
    for (const path of [
      '/api/tenant/approval/designer/person-candidates',
      '/api/tenant/approval/designer/source-candidates?type=department&asOf=2026-10-01',
    ]) {
      for (const context of [undefined, 'designer', 'matrix']) {
        const url = context ? `${path}${path.includes('?') ? '&' : '?'}context=${context}` : path;
        const response = await api.request('GET', url, w.as(userId));
        expect(response.status, `${role} ${url}: ${await response.clone().text()}`).toBe(200);
      }
    }
  },
);
