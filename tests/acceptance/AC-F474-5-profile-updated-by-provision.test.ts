/**
 * F-474-5 #25 返工（审查第 1 轮 P2-2）：新租户开通时安装的标准身份，「最近修改人」= 开通操作人。
 * 安装器已把操作人写进 createdBy；updatedBy 漏写会让身份列表对全部新建标准身份显示空修改人。
 * 系统操作（操作人为空，如夹具 / 平台后台回补）保持 null，不伪造人（DEC-402：旧行不回填）。
 */
import { permissionProfiles, withTenant } from '@italent/db';
import { STANDARD_PROFILES } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { beforeAll, describe, expect, it } from 'vitest';
import { legacyWorld } from './support/f061.js';
import { newUser, provisioned, type ProvisionResult, seedOperator } from './support/platform-api.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
type Json = Record<string, unknown>;

describe('F-474-5 #25 返工：标准身份安装写最近修改人', () => {
  let operatorId: string;
  let result: ProvisionResult;
  let asAdmin: { user: string; tenant: string };

  beforeAll(async () => {
    const { db } = database();
    const api = tenantApi(db, { authorize: undefined });
    const operator = await seedOperator(db, 'prov-updated-by');
    operatorId = operator.id;
    const admin = await newUser(db, 'first-admin');
    const exception = await newUser(db, 'exception-admin');
    result = await provisioned(api, operator, { firstAdminUserId: admin.id, exceptionAdminUserId: exception.id });
    asAdmin = { user: admin.id, tenant: result.tenant.id };
  });

  it('带明确操作人开通：列表里每一条新建标准身份的 updatedBy.userId = 操作人，createdBy 口径一致', async () => {
    const api = tenantApi(database().db, { authorize: undefined });
    const response = await api.request('GET', '/api/tenant/permission/profiles?limit=500', asAdmin);
    expect(response.status).toBe(200);
    const { items, total } = (await response.json()) as { items: Json[]; total: number };
    expect(total).toBe(STANDARD_PROFILES.length);
    expect(items).toHaveLength(STANDARD_PROFILES.length);
    for (const item of items) {
      expect(item.updatedBy, `${String(item.code)} 的最近修改人`).toMatchObject({ userId: operatorId });
    }
    const rows = await withTenant(database().db, result.tenant.id, (tx) => tx.select().from(permissionProfiles));
    expect(rows.every((row) => row.createdBy === operatorId && row.updatedBy === operatorId)).toBe(true);
  });

  it('操作人为空的系统安装：updatedBy 保持 null（与 createdBy 一致），不伪造', async () => {
    const world = await legacyWorld(database().db, 'prov-null-actor');
    const rows = await withTenant(database().db, world.tenantId, (tx) => tx.select().from(permissionProfiles));
    expect(rows.length).toBe(STANDARD_PROFILES.length);
    expect(rows.every((row) => row.createdBy === null && row.updatedBy === null)).toBe(true);
  });
});
