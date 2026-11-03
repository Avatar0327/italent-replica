import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { REHIRE_SETTING } from './AC-EMP-F432-rehire-support.js';

const db = useTestDb();
it('AC-EMP-F432-07：重聘累计默认关闭；沿用设置权限、布尔校验、revision 与租户覆盖隔离', async () => {
  const s = await employmentSession(db().db, 'f432-setting');
  const api = tenantApi(db().db);
  const who = { user: s.user.id, tenant: s.tenant.id };
  const path = `/api/tenant/settings/${REHIRE_SETTING}`;
  const initial = await api.request('GET', path, who);
  expect(initial.status, await initial.clone().text()).toBe(200);
  expect(await initial.json()).toMatchObject({ value: false, revision: 0, source: 'system' });
  const denied = tenantApi(db().db, {
    authorize: (q) => !['tenant.settings.read', 'tenant.settings.write'].includes(q.action),
  });
  expect((await denied.request('GET', path, who)).status).toBe(403);
  expect((await denied.request('PUT', path, { ...who, ifMatch: 0, body: { value: true } })).status).toBe(403);
  for (const value of ['true', 1, {}, null]) {
    expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value } })).status).toBe(400);
  }
  expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value: true } })).status).toBe(200);
  expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value: false } })).status).toBe(409);
  const read = await api.request('GET', path, who);
  expect(await read.json()).toMatchObject({ value: true, revision: 1, source: 'tenant' });
  const other = await employmentSession(db().db, 'f432-setting-other');
  const isolated = await api.request('GET', path, { user: other.user.id, tenant: other.tenant.id });
  expect(await isolated.json()).toMatchObject({ value: false, revision: 0 });
  expect((await api.request('DELETE', `${path}/override`, { ...who, ifMatch: 1 })).status).toBe(200);
  expect(await (await api.request('GET', path, who)).json()).toMatchObject({ value: false, revision: 2 });
});
