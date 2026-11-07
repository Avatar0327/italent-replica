import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { uniqueSuffix } from './support/unique.js';
import { INTERN_SETTING } from './AC-EMP-F480-support.js';

const db = useTestDb();
it('AC-EMP-F480-08：【实习转正】累计司龄默认开启；沿用设置权限、布尔校验、revision 与租户覆盖隔离', async () => {
  const s = await employmentSession(db().db, `f480-setting-${uniqueSuffix()}`);
  const api = tenantApi(db().db);
  const who = { user: s.user.id, tenant: s.tenant.id };
  const path = `/api/tenant/settings/${INTERN_SETTING}`;
  const initial = await api.request('GET', path, who);
  expect(initial.status, await initial.clone().text()).toBe(200);
  expect(await initial.json()).toMatchObject({ value: true, revision: 0, source: 'system' });
  const denied = tenantApi(db().db, {
    authorize: (q) => !['tenant.settings.read', 'tenant.settings.write'].includes(q.action),
  });
  expect((await denied.request('GET', path, who)).status).toBe(403);
  expect((await denied.request('PUT', path, { ...who, ifMatch: 0, body: { value: false } })).status).toBe(403);
  for (const value of ['true', 1, {}, null]) {
    expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value } })).status).toBe(400);
  }
  expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value: false } })).status).toBe(200);
  expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value: true } })).status).toBe(409);
  expect(await (await api.request('GET', path, who)).json()).toMatchObject({
    value: false,
    revision: 1,
    source: 'tenant',
  });
  const other = await employmentSession(db().db, `f480-setting-other-${uniqueSuffix()}`);
  const isolated = await api.request('GET', path, { user: other.user.id, tenant: other.tenant.id });
  expect(await isolated.json()).toMatchObject({ value: true, revision: 0 });
  expect((await api.request('DELETE', `${path}/override`, { ...who, ifMatch: 1 })).status).toBe(200);
  expect(await (await api.request('GET', path, who)).json()).toMatchObject({ value: true, revision: 2 });
});

it('AC-EMP-F480-09：重聘开关与本开关互不影响（独立键）', async () => {
  const s = await employmentSession(db().db, `f480-keys-${uniqueSuffix()}`);
  const api = tenantApi(db().db);
  const who = { user: s.user.id, tenant: s.tenant.id };
  const rehire = await api.request('GET', '/api/tenant/settings/employment.rehire_accumulate_seniority', who);
  expect(await rehire.json()).toMatchObject({ value: false });
  const intern = await api.request('GET', `/api/tenant/settings/${INTERN_SETTING}`, who);
  expect(await intern.json()).toMatchObject({ value: true });
});
