import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { employmentSession } from './AC-EMP-support.js';
import { tenantApi } from './support/tenant-api.js';
import { RETIRE_REHIRE_SETTING } from './AC-EMP-F478-seniority-support.js';

const db = useTestDb();
// 不预置任何配置种子：设置键必须由迁移登记（设计 §7.2），旧实现 GET 即 404。
it('AC-EMP-F478-21：退休返聘累计默认关闭；沿用设置权限、布尔校验、revision、覆盖与删除覆盖及租户隔离', async () => {
  const s = await employmentSession(db().db, 'f478-s6-setting');
  const api = tenantApi(db().db);
  const who = { user: s.user.id, tenant: s.tenant.id };
  const path = `/api/tenant/settings/${RETIRE_REHIRE_SETTING}`;
  const initial = await api.request('GET', path, who);
  expect(initial.status, await initial.clone().text()).toBe(200);
  expect(await initial.json()).toMatchObject({ value: false, revision: 0, source: 'system' });
  const denied = tenantApi(db().db, {
    authorize: (q) => !['tenant.settings.read', 'tenant.settings.write'].includes(q.action),
  });
  expect((await denied.request('GET', path, who)).status).toBe(403);
  expect((await denied.request('PUT', path, { ...who, ifMatch: 0, body: { value: true } })).status).toBe(403);
  expect((await denied.request('DELETE', `${path}/override`, { ...who, ifMatch: 0 })).status).toBe(403);
  for (const value of ['true', 1, {}, null, [true]]) {
    expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value } })).status).toBe(400);
  }
  expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value: true } })).status).toBe(200);
  expect((await api.request('PUT', path, { ...who, ifMatch: 0, body: { value: false } })).status).toBe(409);
  expect(await (await api.request('GET', path, who)).json()).toMatchObject({
    value: true,
    revision: 1,
    source: 'tenant',
  });
  const other = await employmentSession(db().db, 'f478-s6-setting-other');
  const isolated = await api.request('GET', path, { user: other.user.id, tenant: other.tenant.id });
  expect(await isolated.json()).toMatchObject({ value: false, revision: 0, source: 'system' });
  // 他租户的用户不能改本租户的覆盖
  const cross = await api.request('PUT', path, {
    user: other.user.id,
    tenant: s.tenant.id,
    ifMatch: 1,
    body: { value: false },
  });
  expect([403, 404]).toContain(cross.status);
  expect((await api.request('DELETE', `${path}/override`, { ...who, ifMatch: 0 })).status).toBe(409);
  expect((await api.request('DELETE', `${path}/override`, { ...who, ifMatch: 1 })).status).toBe(200);
  expect(await (await api.request('GET', path, who)).json()).toMatchObject({
    value: false,
    revision: 2,
    source: 'system',
  });
});
