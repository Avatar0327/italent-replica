// F-478 S7 AC-EMP-F478-27：设置页与夹具用的“退休返聘累计司龄”信封，按真实租户设置接口核对（普通 app_owner 下亦运行）。
import { bootstrapTenantAdmin } from '@italent/api';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { retireSeniorityConflict, retireSeniorityDefault } from '../../apps/web/smoke/retire-seniority-fixtures.js';
import { cmd, seedTenantWithMember, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const PATH = `/api/tenant/settings/${retireSeniorityDefault.key}`;

describe('AC-EMP-F478-27 退休返聘累计司龄设置接口契约', () => {
  it('管理员读取系统默认（关闭）、打开后回执版本 +1 且来源为租户；旧版本 409；普通成员读写均 403', async () => {
    const db = database().db;
    const owner = await seedTenantWithMember(db, 'f478-s7-admin');
    await bootstrapTenantAdmin(db, { tenantId: owner.tenant.id, userId: owner.user.id }, cmd());
    const api = tenantApi(db, { authorize: undefined });
    const session = { tenant: owner.tenant.id, user: owner.user.id };
    const initial = await api.request('GET', PATH, session);
    expect(initial.status, await initial.clone().text()).toBe(200);
    expect(await initial.json()).toEqual(retireSeniorityDefault);
    const saved = await api.request('PUT', PATH, { ...session, ifMatch: 0, body: { value: true } });
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect(await saved.json()).toEqual({ ...retireSeniorityDefault, value: true, source: 'tenant', revision: 1 });
    const conflict = await api.request('PUT', PATH, { ...session, ifMatch: 0, body: { value: false } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject(retireSeniorityConflict);
    expect(await (await api.request('GET', PATH, session)).json()).toEqual({
      ...retireSeniorityDefault,
      value: true,
      source: 'tenant',
      revision: 1,
    });

    const member = await seedTenantWithMember(db, 'f478-s7-member');
    const ordinary = { tenant: member.tenant.id, user: member.user.id };
    expect((await api.request('GET', PATH, ordinary)).status).toBe(403);
    expect((await api.request('PUT', PATH, { ...ordinary, ifMatch: 0, body: { value: true } })).status).toBe(403);
  });
});
