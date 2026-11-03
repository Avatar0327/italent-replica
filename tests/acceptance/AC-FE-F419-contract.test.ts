// F-419：页面 / 冒烟夹具用真实租户设置 HTTP 接口校验（普通 app_owner 下亦运行）。
import { bootstrapTenantAdmin } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { terminationDefault, terminationRejected } from '../../apps/web/smoke/exit-termination-fixtures.js';
import { seedTenantWithMember, tenantApi, cmd } from './support/tenant-api.js';

import { parseTermination, parseTerminationReceipt } from '../../apps/web/src/exit/termination-model.js';

const database = useTestDb();
const PATH = `/api/tenant/settings/${terminationDefault.key}`;

describe('AC-FE-F419 两层配置接口契约', () => {
  it('管理员读取预置、保存三个独立开关；拒绝固定项 false 保持原值；普通成员读写均 403', async () => {
    const db = database().db;
    const owner = await seedTenantWithMember(db, 'f419-admin');
    await bootstrapTenantAdmin(db, { tenantId: owner.tenant.id, userId: owner.user.id }, cmd());
    const api = tenantApi(db, { authorize: undefined });
    const session = { tenant: owner.tenant.id, user: owner.user.id };
    const initial = await api.request('GET', PATH, session);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json();
    expect(initialBody).toEqual(terminationDefault);
    expect(parseTermination(initialBody).value).toEqual(terminationDefault.value);
    const value = { ...terminationDefault.value, inter_org_transfer: false, batch_transfer: false };
    const saved = await api.request('PUT', PATH, { ...session, ifMatch: 0, body: { value } });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody).toEqual({ ...terminationDefault, value, source: 'tenant', revision: 1 });
    expect(parseTerminationReceipt(savedBody, 0)).toEqual({ id: terminationDefault.key });
    expect(() => parseTerminationReceipt(savedBody, 1)).toThrow();
    const denied = await api.request('PUT', PATH, {
      ...session,
      ifMatch: 1,
      body: { value: { ...value, part_time_add: false } },
    });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject(terminationRejected);
    const unchanged = await api.request('GET', PATH, session);
    expect(await unchanged.json()).toEqual({ ...terminationDefault, value, source: 'tenant', revision: 1 });
    const conflict = await api.request('PUT', PATH, { ...session, ifMatch: 0, body: { value } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'REVISION_CONFLICT' } });

    const member = await seedTenantWithMember(db, 'f419-member');
    const ordinary = { tenant: member.tenant.id, user: member.user.id };
    expect((await api.request('GET', PATH, ordinary)).status).toBe(403);
    expect((await api.request('PUT', PATH, { ...ordinary, ifMatch: 0, body: { value } })).status).toBe(403);
  });
});
