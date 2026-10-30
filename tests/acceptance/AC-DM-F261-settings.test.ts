/** F-261：配置默认值、租户隔离、并发版本与命令重放授权。 */
import './support/exit-gate-enforced.js';
import { randomUUID } from 'node:crypto';
import { useTestDb } from '@italent/testkit';
import { expect, it } from 'vitest';
import { downstreamWorld } from './AC-EXIT-downstream-support.js';
import { tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const path = '/exit-account/settings';
const enabled = { earlyEnabled: true, basis: 'last_work_date', time: '19:00', inReview: true };
it('默认关闭；只写当前租户；已提交回执丢失后以同键找回；撤权后同键也拒绝', async () => {
  const db = database().db;
  const x = await downstreamWorld(db, 'f261-settings');
  const other = await downstreamWorld(db, 'f261-settings-other');
  const before = await (await x.session.request('GET', path)).json();
  expect(before).toMatchObject({ revision: 0, earlyEnabled: false, inReview: false });
  const key = randomUUID();
  const send = (body = enabled) =>
    x.session.request('PUT', path, {
      ifMatch: before.revision,
      idempotencyKey: key,
      body,
    });
  // 模拟客户端丢失已提交写请求的回执，读取当前状态再按原命令 ID 回查，不换 ID 重提。
  expect((await send()).status).toBe(200);
  const saved = await (await x.session.request('GET', path)).json();
  expect(saved).toMatchObject({ ...enabled, revision: 1 });
  const replay = await send();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(saved);
  expect((await send({ ...enabled, time: '18:00' })).status).toBe(409);
  expect((await x.session.request('PUT', path, { ifMatch: 0, body: enabled })).status).toBe(409);
  expect(await (await other.session.request('GET', path)).json()).toEqual(before);
  const denied = tenantApi(db, { authorize: (request) => request.action !== 'tenant.employment.configuration.write' });
  expect(
    (
      await denied.request('PUT', `/api/tenant/employment${path}`, {
        tenant: x.session.tenant.id,
        user: x.session.user.id,
        ifMatch: 0,
        idempotencyKey: key,
        body: enabled,
      })
    ).status,
  ).toBe(403);
});
it.each([{ time: '24:00' }, { time: '19:60' }, { basis: 'unknown' }, { earlyEnabled: 'true' }])(
  '非法配置拒绝且不写台账：%j',
  async (invalid) => {
    const x = await downstreamWorld(database().db, 'f261-invalid');
    const response = await x.session.request('PUT', path, { ifMatch: 0, body: { ...enabled, ...invalid } });
    expect(response.status, await response.clone().text()).toBe(400);
    expect(await (await x.session.request('GET', path)).json()).toMatchObject({ revision: 0, earlyEnabled: false });
  },
);
