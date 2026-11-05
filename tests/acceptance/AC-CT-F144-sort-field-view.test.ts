/** F-144：合同列表排序按字段查看权裁剪——合同编号不可查看的身份，不能按 sort=number 取得编号次序（泄露不可见字段的相对大小）。 */
import { bootstrapTenantAdmin } from '@italent/api';
import { MODULE_OBJECTS } from '@italent/domain';
import { useTestDb } from '@italent/testkit';
import { describe, expect, it } from 'vitest';
import { contractWorld } from './AC-CT-support.js';
import { addMember, createProfile, grant, makeGrantable, setObjectPermission } from './AC-PRM-support.js';
import { cmd, tenantApi } from './support/tenant-api.js';

const database = useTestDb();
const object = MODULE_OBJECTS.contract;
const clock = () => new Date('2026-10-01T01:00:00Z');

/** 真实授权器下的合同 HR：对象查看权齐全，只有 hiddenFields 里的字段不可查看；范围 = 合同部门（管理单元）。 */
async function viewer(label: string, hiddenFields: readonly string[]) {
  const w = await contractWorld(database().db, `f144-${label}`);
  const api = tenantApi(w.db, { authorize: undefined, clock });
  const adminRecord = await bootstrapTenantAdmin(
    w.db,
    { tenantId: w.session.tenant.id, userId: w.session.user.id },
    cmd(),
  );
  const seed = {
    db: w.db,
    tenant: w.session.tenant,
    admin: w.session.user,
    adminRecord,
    api,
    asAdmin: { tenant: w.session.tenant.id, user: w.session.user.id },
  };
  const user = await addMember(seed, '合同HR');
  const profile = await createProfile(seed, `contract-${label}`);
  const permission = await setObjectPermission(
    seed,
    profile,
    {
      dataOperations: { create: true, update: true, delete: true },
      fields: object.fields.map((f) => ({ fieldCode: f.code, view: !hiddenFields.includes(f.code), edit: !f.system })),
      buttons: object.buttons.map((b) => ({ buttonCode: b.code, level: b.level })),
    },
    object.code,
  );
  expect(permission.status).toBe(200);
  await makeGrantable(seed, [profile.id]);
  expect((await grant(seed, user.id, profile.id)).status).toBe(201);
  const scoped = await api.request('PUT', `/api/tenant/permission/scopes/${user.id}/TenantBase`, {
    ...seed.asAdmin,
    ifMatch: 0,
    body: { kind: 'org_range', orgRanges: [{ orgId: w.org.id, includeDescendants: false }] },
  });
  expect(scoped.status, await scoped.clone().text()).toBe(200);
  const list = (qs: string) =>
    api.request('GET', `/api/tenant/contracts?${qs}`, { tenant: seed.tenant.id, user: user.id });
  return { w, list };
}

describe('AC-CT F-144 合同列表排序按字段查看权', () => {
  it('编号不可查看：sort=number 返回 400（排序键不可见），其余排序与默认顺序不受影响，响应不含编号', async () => {
    const { w, list } = await viewer('hidden-number', ['number']);
    await w.create({ number: 'A-001' });
    const rejected = await list('view=all&sort=number&order=desc');
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    for (const qs of ['view=all&sort=endDate', 'view=all&sort=effectiveDate&order=desc', 'view=all']) {
      const ok = await list(qs);
      expect(ok.status, `${qs} ${await ok.clone().text()}`).toBe(200);
      const body = (await ok.json()) as { items: Record<string, unknown>[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).not.toHaveProperty('number');
    }
  });

  it('编号可查看：sort=number 照常排序', async () => {
    const { w, list } = await viewer('visible-number', []);
    await w.create({ number: 'A-001' });
    const ok = await list('view=all&sort=number&order=desc');
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ items: [{ number: 'A-001' }] });
  });

  it('入职缺失视图本就不认 sort=number（被忽略），编号不可查看时不因此被拒', async () => {
    const { list } = await viewer('missing-view', ['number']);
    const ok = await list('view=missing&sort=number');
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});
